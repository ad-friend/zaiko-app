/**
 * 本消込エンジン: sales_transactions と在庫（inbound_items）を紐付ける
 * POST: stock_id が未設定の通常売上を、amazon_order_id 単位でまとめて処理する。
 * - 同一注文の複数明細（FBA 分割発送・Principal 複数行等）は事前にグループ化し、金額を合算したサマリーをログに出す。
 * - inbound_items が複数ある場合は seller SKU → sku_mappings → JAN で在庫行と突き合わせ、行ごとに stock_id / unit_cost を設定。
 * - 在庫側は注文に紐づく全行に一度に settled_at（posted_date 最早）をセットする。
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { earliestPostedDateIso } from "@/lib/settlement-posted-date";

type ReconcileSalesRequestBody = {
  /** 1回の実行で処理する注文数（amazon_order_id）上限 */
  batchSizeOrders?: number;
};

type TxRow = {
  id: number;
  amazon_order_id: string;
  posted_date: string | null;
  amount: unknown;
  sku: string | null;
  amount_type: string | null;
  amount_description: string | null;
  transaction_type: string | null;
};

type StockRow = {
  id: number;
  effective_unit_price: unknown;
  settled_at: string | null;
  jan_code: string | null;
  created_at: string | null;
  order_id?: string | null;
};

/** sku_mappings から JAN が一意に定まるときだけ返す（セット品は null） */
function uniqueJanFromSkuMappings(mapList: Array<{ jan_code: unknown }>): string | null {
  const jans = new Set<string>();
  for (const m of mapList) {
    const j = String(m.jan_code ?? "").trim();
    if (j) jans.add(j);
  }
  if (jans.size !== 1) return null;
  const [only] = [...jans];
  return only ?? null;
}

function normalizeJan(j: string | null | undefined): string {
  return String(j ?? "").trim();
}

function toNumber(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isExpenseSkipTx(row: Pick<TxRow, "amount_type" | "transaction_type" | "amount_description">): boolean {
  // このAPIでは transaction_type は常に "Order" を取得している想定だが、
  // 要件通り amount_type / transaction_type の両方に文字列が含まれる場合に除外する。
  const amountType = String(row.amount_type ?? "");
  const txType = String(row.transaction_type ?? "");
  const desc = String(row.amount_description ?? "");

  return (
    amountType.includes("PostageBilling") ||
    txType.includes("PostageBilling") ||
    desc.includes("PostageBilling") ||
    amountType.includes("adj_") ||
    txType.includes("adj_") ||
    desc.includes("adj_") ||
    amountType.includes("ServiceFee") ||
    txType.includes("ServiceFee") ||
    desc.includes("ServiceFee")
  );
}

async function markSalesTxReconciled(ids: number[]): Promise<void> {
  if (!ids.length) return;

  // 経費データは在庫と紐づけ不要のため、stock_id にダミー値を入れない（FK等で弾かれる可能性がある）。
  // status カラムが存在する場合のみ「reconciled」で除外マークする。
  const { error: err1 } = await supabase
    .from("sales_transactions")
    .update({ status: "reconciled" } as any)
    .in("id", ids);
  if (!err1) return;

  const code = (err1 as any)?.code;
  const msg = (err1 as any)?.message ?? "";
  // status カラムが無いDBでは何も更新しない（表示側で amount_type 等による除外を行う）
  if (code === "42703" || msg.includes("status")) return;
  throw err1;
}

async function updateSalesTxWithOptionalStatus(ids: number[], patch: Record<string, unknown>): Promise<void> {
  if (!ids.length) return;

  const withStatus: Record<string, unknown> = { ...patch, status: "reconciled" };
  const { error: err1 } = await supabase.from("sales_transactions").update(withStatus as any).in("id", ids);
  if (!err1) return;

  const code = (err1 as any)?.code;
  const msg = (err1 as any)?.message ?? "";
  if (code === "42703" || msg.includes("status")) {
    const { error: err2 } = await supabase.from("sales_transactions").update(patch as any).in("id", ids);
    if (err2) throw err2;
    return;
  }
  throw err1;
}

function isRefundTxType(raw: string | null | undefined): boolean {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return false;
  return t === "refund" || t.includes("refund") || t.includes("返金");
}

function isOrderTxType(raw: string | null | undefined): boolean {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return false;
  return t === "order" || t.includes("order") || t.includes("注文");
}

function isRefundLikeRow(r: Pick<TxRow, "transaction_type" | "amount_type" | "amount_description" | "amount">): boolean {
  const tt = String(r.transaction_type ?? "");
  const at = String(r.amount_type ?? "");
  const ad = String(r.amount_description ?? "");
  // 表記揺れ対策: transaction_type / amount_type / description のどれで来ても拾う
  return isRefundTxType(tt) || isRefundTxType(at) || isRefundTxType(ad) || (toNumber(r.amount) < 0 && isRefundTxType(ad));
}

/** 相殺判定用: プラス売上（Charge/Principal 等）。経費ラベルは除外。 */
function isPositiveSaleLikeRow(r: Pick<TxRow, "transaction_type" | "amount_type" | "amount_description" | "amount">): boolean {
  if (toNumber(r.amount) <= 0) return false;
  if (isRefundLikeRow(r)) return false;
  if (
    isExpenseSkipTx({
      amount_type: r.amount_type,
      transaction_type: r.transaction_type,
      amount_description: r.amount_description,
    })
  ) {
    return false;
  }
  return true;
}

/**
 * 返品・返金運用: 親売上も stock_id が取れないが、同一注文に「プラス売上」と「返金」が揃ったら相殺済み扱い。
 * stock_id は触らず status のみ reconciled（未消込リストから除外）。
 */
async function applyOffsetReconciliation(rows: TxRow[]): Promise<number> {
  if (!rows.length) return 0;
  const byOrder = new Map<string, TxRow[]>();
  for (const r of rows) {
    const oid = String(r.amazon_order_id ?? "").trim();
    if (!oid) continue;
    if (!byOrder.has(oid)) byOrder.set(oid, []);
    byOrder.get(oid)!.push(r);
  }

  let offsetOrderCount = 0;
  for (const [, group] of byOrder) {
    const hasRefund = group.some((r) => isRefundLikeRow(r));
    const hasPositiveSale = group.some((r) => isPositiveSaleLikeRow(r));
    // 返金が無いグループ（Charge+Feeだけ浮いている等）は触らない（将来 Refund 取り込み後に相殺）
    if (!hasRefund || !hasPositiveSale) continue;

    const ids = group.map((r) => r.id);
    await markSalesTxReconciled(ids);
    offsetOrderCount += 1;
  }
  return offsetOrderCount;
}

async function fetchUnlinkedSalesTxRows(): Promise<TxRow[]> {
  // status カラムが存在する場合は reconciled を除外する（存在しないDBでも動くようにする）
  {
    const res = await supabase
      .from("sales_transactions")
      .select("id, amazon_order_id, posted_date, amount, sku, amount_type, amount_description, transaction_type, status")
      .not("amazon_order_id", "is", null)
      .is("stock_id", null)
      .or("status.is.null,status.neq.reconciled")
      .order("posted_date", { ascending: true });
    if (!res.error) return (res.data ?? []) as TxRow[];
    const code = (res.error as any)?.code;
    const msg = (res.error as any)?.message ?? "";
    if (code !== "42703" && !msg.includes("status")) throw res.error;
  }

  const { data, error } = await supabase
    .from("sales_transactions")
    .select("id, amazon_order_id, posted_date, amount, sku, amount_type, amount_description, transaction_type")
    .not("amazon_order_id", "is", null)
    .is("stock_id", null)
    .order("posted_date", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TxRow[];
}

async function findParentLinkedSaleForOrderId(
  amazonOrderId: string
): Promise<{ stock_id: number; unit_cost: number } | null> {
  // 親: 同一注文で、既に stock_id が付いていて、amount>0 の行（Charge/Principal等）
  const { data, error } = await supabase
    .from("sales_transactions")
    .select("stock_id, unit_cost, amount, posted_date")
    .eq("amazon_order_id", amazonOrderId)
    .not("stock_id", "is", null)
    .gt("amount", 0)
    .order("posted_date", { ascending: true })
    .limit(1);
  if (error) throw error;
  const first = (data ?? [])[0] as { stock_id?: unknown; unit_cost?: unknown } | undefined;
  const stockId = first?.stock_id != null ? Number(first.stock_id) : NaN;
  if (!Number.isFinite(stockId) || stockId < 1) return null;
  const unitCost = first?.unit_cost != null ? Number(first.unit_cost) : 0;
  return { stock_id: stockId, unit_cost: Number.isFinite(unitCost) ? unitCost : 0 };
}

async function buildSkuToJanMap(sellerSkus: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const uniq = [...new Set(sellerSkus.map((s) => s.trim()).filter(Boolean))];
  for (const s of uniq) out.set(s, null);
  if (uniq.length === 0) return out;

  const { data, error } = await supabase
    .from("sku_mappings")
    .select("sku, jan_code, quantity")
    .in("sku", uniq)
    .eq("platform", "Amazon");

  if (error) throw error;

  const bySku = new Map<string, Array<{ jan_code: unknown }>>();
  for (const row of data ?? []) {
    const sku = String((row as { sku?: unknown }).sku ?? "").trim();
    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku)!.push(row as { jan_code: unknown });
  }
  for (const sku of uniq) {
    const list = bySku.get(sku) ?? [];
    out.set(sku, uniqueJanFromSkuMappings(list));
  }
  return out;
}

/** JAN ごとの在庫プール（先頭から割り当て） */
function buildJanPools(stocks: StockRow[]): Map<string, StockRow[]> {
  const pools = new Map<string, StockRow[]>();
  const sorted = [...stocks].sort((a, b) => {
    const ta = a.created_at ? Date.parse(a.created_at) : 0;
    const tb = b.created_at ? Date.parse(b.created_at) : 0;
    return ta - tb;
  });
  for (const s of sorted) {
    const j = normalizeJan(s.jan_code) || "__EMPTY__";
    if (!pools.has(j)) pools.set(j, []);
    pools.get(j)!.push(s);
  }
  return pools;
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function fetchTargetOrderIdsForBatch(batchSizeOrders: number): Promise<string[]> {
  // Supabase で distinct + order を安定的にやりにくいため、
  // 「未紐付け行を先頭から少しだけスキャン」→「注文IDをユニーク化」→「最大N件」を採用する。
  // これにより1回のAPI実行時間を短く保つ（Vercel timeout 回避）。
  const SCAN_LIMIT = Math.max(200, batchSizeOrders * 60);

  // status カラムが存在する場合は reconciled を除外する（存在しないDBでも動くようにする）
  {
    const res = await supabase
      .from("sales_transactions")
      .select("amazon_order_id, posted_date, id, status")
      .not("amazon_order_id", "is", null)
      .is("stock_id", null)
      .or("status.is.null,status.neq.reconciled")
      .order("posted_date", { ascending: true })
      .order("id", { ascending: true })
      .limit(SCAN_LIMIT);
    if (!res.error) {
      const rows = (res.data ?? []) as Array<{ amazon_order_id?: unknown }>;
      const out: string[] = [];
      const seen = new Set<string>();
      for (const r of rows) {
        const oid = String((r as any).amazon_order_id ?? "").trim();
        if (!oid || seen.has(oid)) continue;
        seen.add(oid);
        out.push(oid);
        if (out.length >= batchSizeOrders) break;
      }
      return out;
    }
    const code = (res.error as any)?.code;
    const msg = (res.error as any)?.message ?? "";
    if (code !== "42703" && !msg.includes("status")) throw res.error;
  }

  const { data, error } = await supabase
    .from("sales_transactions")
    .select("amazon_order_id, posted_date, id")
    .not("amazon_order_id", "is", null)
    .is("stock_id", null)
    .order("posted_date", { ascending: true })
    .order("id", { ascending: true })
    .limit(SCAN_LIMIT);
  if (error) throw error;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of (data ?? []) as Array<{ amazon_order_id?: unknown }>) {
    const oid = String((r as any).amazon_order_id ?? "").trim();
    if (!oid || seen.has(oid)) continue;
    seen.add(oid);
    out.push(oid);
    if (out.length >= batchSizeOrders) break;
  }
  return out;
}

async function filterOrderIdsHavingInboundItems(orderIds: string[]): Promise<string[]> {
  const ids = orderIds.map((s) => String(s).trim()).filter(Boolean);
  if (!ids.length) return [];
  const { data, error } = await supabase.from("inbound_items").select("order_id").in("order_id", ids);
  if (error) throw error;
  const has = new Set<string>();
  for (const r of (data ?? []) as Array<{ order_id?: unknown }>) {
    const oid = String((r as any).order_id ?? "").trim();
    if (oid) has.add(oid);
  }
  return ids.filter((oid) => has.has(oid));
}

async function fetchUnlinkedSalesTxRowsForOrderIds(orderIds: string[]): Promise<TxRow[]> {
  const ids = orderIds.map((s) => String(s).trim()).filter(Boolean);
  if (!ids.length) return [];

  // status カラムが存在する場合は reconciled を除外する（存在しないDBでも動くようにする）
  {
    const res = await supabase
      .from("sales_transactions")
      .select("id, amazon_order_id, posted_date, amount, sku, amount_type, amount_description, transaction_type, status")
      .in("amazon_order_id", ids)
      .is("stock_id", null)
      .or("status.is.null,status.neq.reconciled")
      .order("posted_date", { ascending: true })
      .order("id", { ascending: true });
    if (!res.error) return (res.data ?? []) as TxRow[];
    const code = (res.error as any)?.code;
    const msg = (res.error as any)?.message ?? "";
    if (code !== "42703" && !msg.includes("status")) throw res.error;
  }

  const { data, error } = await supabase
    .from("sales_transactions")
    .select("id, amazon_order_id, posted_date, amount, sku, amount_type, amount_description, transaction_type")
    .in("amazon_order_id", ids)
    .is("stock_id", null)
    .order("posted_date", { ascending: true })
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []) as TxRow[];
}

function createPromisePool(opts: { concurrency: number }) {
  const concurrency = clampInt(opts.concurrency, 5, 1, 10);
  let active = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    active -= 1;
    const fn = queue.shift();
    if (fn) fn();
  };

  const run = async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      next();
    }
  };

  return { run };
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as ReconcileSalesRequestBody;
    const batchSizeOrders = clampInt(body?.batchSizeOrders, 20, 1, 50);

    const orderIdsRaw = await fetchTargetOrderIdsForBatch(batchSizeOrders);
    const orderIds = await filterOrderIdsHavingInboundItems(orderIdsRaw);
    if (!orderIds.length) {
      return NextResponse.json({
        ok: true,
        processedOrders: 0,
        reconciledCount: 0,
        skippedCount: 0,
        message:
          orderIdsRaw.length === 0
            ? "本消込対象の売上明細がありません。"
            : "在庫（inbound_items）が紐づいている注文が無いため、本消込を行いません（先にSTEP2の自動消込で在庫引当を完了してください）。",
      });
    }

    const unlinkedRows = await fetchUnlinkedSalesTxRowsForOrderIds(orderIds);
    const typed = unlinkedRows as TxRow[];

    const parentCache = new Map<string, { stock_id: number; unit_cost: number } | null>();
    const getParent = async (amazonOrderId: string): Promise<{ stock_id: number; unit_cost: number } | null> => {
      const key = String(amazonOrderId ?? "").trim();
      if (!key) return null;
      if (parentCache.has(key)) return parentCache.get(key) ?? null;
      const parent = await findParentLinkedSaleForOrderId(key);
      parentCache.set(key, parent);
      return parent;
    };

    // === 自己修復 1) Order手数料（マイナス）を親売上にぶら下げる ===
    // 条件: transaction_type が Order 系 かつ amount < 0（Commission/FBA Per Unit Fulfillment Fee 等）
    let healedFeeCount = 0;
    const feeRows = typed.filter((r) => isOrderTxType(r.transaction_type) && toNumber(r.amount) < 0);
    for (const r of feeRows) {
      const orderId = String(r.amazon_order_id ?? "").trim();
      if (!orderId) continue;
      // 経費/調整（在庫紐づけ不要）は既存ルールで処理済みにする
      if (
        isExpenseSkipTx({
          amount_type: r.amount_type,
          transaction_type: r.transaction_type,
          amount_description: r.amount_description,
        })
      ) {
        await markSalesTxReconciled([r.id]);
        continue;
      }
      const parent = await getParent(orderId);
      if (!parent) continue;
      await updateSalesTxWithOptionalStatus([r.id], { stock_id: parent.stock_id, unit_cost: parent.unit_cost });
      healedFeeCount += 1;
    }

    // === 自己修復 2) Refund系を親売上にぶら下げる ===
    // 条件: transaction_type / amount_type / description が Refund/返金 を示す（表記揺れ対応）
    let healedRefundCount = 0;
    const refundRows = typed.filter((r) => isRefundLikeRow(r));
    for (const r of refundRows) {
      const orderId = String(r.amazon_order_id ?? "").trim();
      if (!orderId) continue;
      if (
        isExpenseSkipTx({
          amount_type: r.amount_type,
          transaction_type: r.transaction_type,
          amount_description: r.amount_description,
        })
      ) {
        await markSalesTxReconciled([r.id]);
        continue;
      }
      const parent = await getParent(orderId);
      if (!parent) continue;
      await updateSalesTxWithOptionalStatus([r.id], { stock_id: parent.stock_id, unit_cost: parent.unit_cost });
      healedRefundCount += 1;
    }

    // === 相殺（Offset）: 同一注文にプラス売上と返金が揃い、在庫に紐づけられない行を status のみ完結 ===
    let typedForMain = await fetchUnlinkedSalesTxRowsForOrderIds(orderIds);
    const offsetOrderCount = await applyOffsetReconciliation(typedForMain);
    typedForMain = await fetchUnlinkedSalesTxRowsForOrderIds(orderIds);

    /** order_id ごとにグループ化 */
    const byOrder = new Map<string, TxRow[]>();
    for (const r of typedForMain) {
      // Refund は上の自己修復で処理済み（またはスキップ）なので、通常の在庫紐づけ対象には含めない
      if (isRefundLikeRow(r)) continue;
      const oid = String(r.amazon_order_id ?? "").trim();
      if (!oid) continue;
      if (!byOrder.has(oid)) byOrder.set(oid, []);
      byOrder.get(oid)!.push(r);
    }

    let reconciledCount = 0;
    let skippedCount = 0;

    const inboundByOrderId = new Map<string, StockRow[]>();
    {
      const wantOrderIds = [...byOrder.keys()].map((s) => String(s).trim()).filter(Boolean);
      if (wantOrderIds.length > 0) {
        const { data, error } = await supabase
          .from("inbound_items")
          .select("id, effective_unit_price, settled_at, jan_code, created_at, order_id")
          .in("order_id", wantOrderIds)
          .order("created_at", { ascending: true });
        if (error) throw error;
        for (const row of (data ?? []) as StockRow[]) {
          const oid = String((row as any).order_id ?? "").trim();
          if (!oid) continue;
          if (!inboundByOrderId.has(oid)) inboundByOrderId.set(oid, []);
          inboundByOrderId.get(oid)!.push(row);
        }
      }
    }

    for (const [amazonOrderId, txGroup] of byOrder) {
      // 経費/調整（在庫紐づけ不要）を先にスキップして処理済みにする
      const expenseTx = txGroup.filter((r) =>
        isExpenseSkipTx({ amount_type: r.amount_type, transaction_type: r.transaction_type, amount_description: r.amount_description })
      );
      if (expenseTx.length) await markSalesTxReconciled(expenseTx.map((r) => r.id));

      // 通常の在庫紐づけ対象のみで以降のロジックを回す
      const normalTx = txGroup.filter((r) => !expenseTx.some((e) => e.id === r.id));
      if (!normalTx.length) {
        // この注文内は経費のみ → inbound_items 更新は行わない
        continue;
      }

      const settledAt = earliestPostedDateIso(normalTx);
      if (!settledAt) {
        skippedCount += 1;
        continue;
      }

      /** 注文単位のサマリー（ログ用） */
      const totalAmount = normalTx.reduce((s, r) => s + toNumber(r.amount), 0);
      const principalSum = normalTx
        .filter((r) => String(r.amount_type ?? "") === "Charge" && String(r.amount_description ?? "").includes("Principal"))
        .reduce((s, r) => s + toNumber(r.amount), 0);
      console.log(
        `[reconcile-sales] order=${amazonOrderId} tx_rows=${normalTx.length} sum_amount=${totalAmount.toFixed(2)} principal_like=${principalSum.toFixed(2)}`
      );

      const stocks = (inboundByOrderId.get(amazonOrderId) ?? []) as StockRow[];
      if (stocks.length === 0) {
        skippedCount += 1;
        continue;
      }

      const txSorted = [...normalTx].sort((a, b) => a.id - b.id);

      /** 単一的在庫: 従来どおり全明細に同一 stock */
      if (stocks.length === 1) {
        const stock = stocks[0];
        const stockId = stock.id;
        const unitCost = toNumber(stock.effective_unit_price);

        const ids = txSorted.map((t) => t.id);
        const { error: updateTxError } = await supabase
          .from("sales_transactions")
          .update({ stock_id: stockId, unit_cost: unitCost })
          .in("id", ids);

        if (updateTxError) throw updateTxError;

        const { error: updateStockError } = await supabase
          .from("inbound_items")
          .update({ settled_at: settledAt })
          .eq("order_id", amazonOrderId);

        if (updateStockError) throw updateStockError;

        reconciledCount += 1;
        continue;
      }

      /** 複数在庫: SKU → JAN でプールから割り当て */
      const sellerSkus = txSorted.map((t) => String(t.sku ?? "").trim()).filter(Boolean);
      const skuToJan = await buildSkuToJanMap(sellerSkus);

      const pools = buildJanPools(stocks);
      const usedStockIds = new Set<number>();

      const takeFromJan = (jan: string | null): StockRow | null => {
        const key = normalizeJan(jan) || "__EMPTY__";
        const arr = pools.get(key);
        if (!arr?.length) return null;
        const idx = arr.findIndex((s) => !usedStockIds.has(s.id));
        if (idx < 0) return null;
        const [s] = arr.splice(idx, 1);
        usedStockIds.add(s.id);
        return s;
      };

      const takeAnyUnused = (): StockRow | null => {
        for (const s of stocks) {
          if (!usedStockIds.has(s.id)) {
            usedStockIds.add(s.id);
            return s;
          }
        }
        return null;
      };

      const plannedUpdates: Array<{ tx_id: number; stock_id: number; unit_cost: number }> = [];
      for (const tx of txSorted) {
        const sellerSku = String(tx.sku ?? "").trim();
        let stock: StockRow | null = null;

        if (sellerSku) {
          const jan = skuToJan.get(sellerSku) ?? null;
          if (jan) {
            stock = takeFromJan(jan);
          }
        }

        if (!stock) {
          stock = takeFromJan(null);
        }
        if (!stock) {
          stock = takeAnyUnused();
        }
        if (!stock) {
          stock = stocks[0]!;
        }

        plannedUpdates.push({
          tx_id: tx.id,
          stock_id: stock.id,
          unit_cost: toNumber(stock.effective_unit_price),
        });
      }

      const pool = createPromisePool({ concurrency: 5 });
      await Promise.all(
        plannedUpdates.map((u) =>
          pool.run(async () => {
            const { error: uErr } = await supabase
              .from("sales_transactions")
              .update({ stock_id: u.stock_id, unit_cost: u.unit_cost })
              .eq("id", u.tx_id);
            if (uErr) throw uErr;
          })
        )
      );

      const { error: bulkSettleErr } = await supabase
        .from("inbound_items")
        .update({ settled_at: settledAt })
        .eq("order_id", amazonOrderId);

      if (bulkSettleErr) throw bulkSettleErr;

      reconciledCount += 1;
    }

    return NextResponse.json({
      ok: true,
      processedOrders: byOrder.size,
      reconciledCount,
      skippedCount,
      message: `本消込: ${reconciledCount}注文を処理しました (保留: ${skippedCount}件) / 自己修復: 手数料 ${healedFeeCount}件, 返金 ${healedRefundCount}件 / 相殺: ${offsetOrderCount}注文`,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "本消込処理に失敗しました。";
    console.error("[reconcile-sales]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
