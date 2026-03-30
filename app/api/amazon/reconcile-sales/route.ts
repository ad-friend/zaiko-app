/**
 * 本消込エンジン: sales_transactions と在庫（inbound_items）を紐付ける
 * POST: stock_id が未設定の通常売上を、amazon_order_id 単位でまとめて処理する。
 * - 同一注文の複数明細（FBA 分割発送・Principal 複数行等）は事前にグループ化し、金額を合算したサマリーをログに出す。
 * - inbound_items が複数ある場合は seller SKU → sku_mappings → JAN で在庫行と突き合わせ、行ごとに stock_id / unit_cost を設定。
 * - 在庫側は注文に紐づく全行に一度に settled_at（posted_date 最早）をセットする。
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { earliestPostedDateIso } from "@/lib/settlement-posted-date";

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

function isExpenseSkipTx(row: Pick<TxRow, "amount_type" | "transaction_type">): boolean {
  // このAPIでは transaction_type は常に "Order" を取得している想定だが、
  // 要件通り amount_type / transaction_type の両方に文字列が含まれる場合に除外する。
  const amountType = String(row.amount_type ?? "");
  const txType = String(row.transaction_type ?? "");

  return (
    amountType.includes("PostageBilling") ||
    txType.includes("PostageBilling") ||
    amountType.includes("adj_") ||
    txType.includes("adj_") ||
    amountType.includes("ServiceFee") ||
    txType.includes("ServiceFee")
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

export async function POST() {
  try {
    const { data: unlinkedRows, error: fetchError } = await supabase
      .from("sales_transactions")
      .select("id, amazon_order_id, posted_date, amount, sku, amount_type, amount_description, transaction_type")
      .not("amazon_order_id", "is", null)
      .is("stock_id", null)
      .in("transaction_type", ["Order", "Refund"]);

    if (fetchError) throw fetchError;
    if (!unlinkedRows?.length) {
      return NextResponse.json({
        ok: true,
        reconciledCount: 0,
        skippedCount: 0,
        message: "本消込対象の売上明細がありません。",
      });
    }

    const typed = unlinkedRows as TxRow[];

    // 返金（Refund）は、在庫ではなく「紐づけ済みの元売上（Order）」から stock_id をコピーして自動紐づけする
    const refundRows = typed.filter((r) => isRefundTxType(r.transaction_type));
    if (refundRows.length) {
      for (const r of refundRows) {
        const orderId = String(r.amazon_order_id ?? "").trim();
        const sku = String(r.sku ?? "").trim();
        if (!orderId || !sku) continue;
        // 経費扱いは Refund 側では想定しないが、要件の「競合しない分岐」のため最上流で除外
        if (isExpenseSkipTx({ amount_type: r.amount_type, transaction_type: r.transaction_type })) {
          await markSalesTxReconciled([r.id]);
          continue;
        }

        const { data: orig, error: origErr } = await supabase
          .from("sales_transactions")
          .select("stock_id, unit_cost, posted_date")
          .eq("amazon_order_id", orderId)
          .eq("sku", sku)
          .eq("transaction_type", "Order")
          .not("stock_id", "is", null)
          .order("posted_date", { ascending: true })
          .limit(1);

        if (origErr) throw origErr;
        const first = (orig ?? [])[0] as { stock_id?: unknown; unit_cost?: unknown } | undefined;
        const stockId = first?.stock_id != null ? Number(first.stock_id) : NaN;
        if (!Number.isFinite(stockId) || stockId < 1) {
          // 元売上が無い（まだ紐づいていない）→ 今回は何もしないでスキップ
          continue;
        }
        const unitCost = first?.unit_cost != null ? Number(first.unit_cost) : 0;
        await updateSalesTxWithOptionalStatus([r.id], { stock_id: stockId, unit_cost: Number.isFinite(unitCost) ? unitCost : 0 });
      }
    }

    /** order_id ごとにグループ化 */
    const byOrder = new Map<string, TxRow[]>();
    for (const r of typed) {
      // Refund は上で処理済み（またはスキップ）なので、通常の在庫紐づけ対象には含めない
      if (isRefundTxType(r.transaction_type)) continue;
      const oid = String(r.amazon_order_id ?? "").trim();
      if (!oid) continue;
      if (!byOrder.has(oid)) byOrder.set(oid, []);
      byOrder.get(oid)!.push(r);
    }

    let reconciledCount = 0;
    let skippedCount = 0;

    for (const [amazonOrderId, txGroup] of byOrder) {
      // 経費/調整（在庫紐づけ不要）を先にスキップして処理済みにする
      const expenseTx = txGroup.filter((r) => isExpenseSkipTx({ amount_type: r.amount_type, transaction_type: r.transaction_type }));
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

      const { data: stocksRaw, error: stocksError } = await supabase
        .from("inbound_items")
        .select("id, effective_unit_price, settled_at, jan_code, created_at")
        .eq("order_id", amazonOrderId)
        .order("created_at", { ascending: true });

      if (stocksError) throw stocksError;
      const stocks = (stocksRaw ?? []) as StockRow[];
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

        const unitCost = toNumber(stock.effective_unit_price);
        const { error: uErr } = await supabase
          .from("sales_transactions")
          .update({ stock_id: stock.id, unit_cost: unitCost })
          .eq("id", tx.id);

        if (uErr) throw uErr;
      }

      const { error: bulkSettleErr } = await supabase
        .from("inbound_items")
        .update({ settled_at: settledAt })
        .eq("order_id", amazonOrderId);

      if (bulkSettleErr) throw bulkSettleErr;

      reconciledCount += 1;
    }

    return NextResponse.json({
      ok: true,
      reconciledCount,
      skippedCount,
      message: `本消込: ${reconciledCount}注文を処理しました (保留: ${skippedCount}件)`,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "本消込処理に失敗しました。";
    console.error("[reconcile-sales]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
