import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isRefundLikeRow } from "@/lib/amazon-refund-offset-like";
import { markSalesTransactionsReconciled } from "@/lib/amazon-sales-tx-mark-reconciled";
import {
  EXIT_TYPE_JUNK_RETURN,
  STOCK_STATUS_DISPOSED,
  STOCK_STATUS_RETURN_INSPECTION,
} from "@/lib/inbound-stock-status";

type TxRow = {
  id: number;
  amazon_order_id: string | null;
  transaction_type: string | null;
  amount_type: string | null;
  amount_description: string | null;
  amount: unknown;
  stock_id: unknown;
  item_quantity?: unknown;
};

type InboundRow = {
  id: number;
  order_id: string | null;
  settled_at: string | null;
  created_at: string | null;
  stock_status: string | null;
  return_amazon_order_id: string | null;
  exit_type: string | null;
};

function norm(v: unknown): string {
  return String(v ?? "").normalize("NFKC").trim();
}

function normLower(v: unknown): string {
  return norm(v).toLowerCase();
}

function isFreeOrderId(v: unknown): boolean {
  // NULLIF(BTRIM(order_id), '') IS NULL 相当
  return norm(v).length === 0;
}

function parseIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1);
  return [...new Set(ids)];
}

function isReturnBlockedInbound(r: InboundRow): boolean {
  // free判定（空文字含む）
  if (isFreeOrderId(r.order_id)) return true;

  // 返品メタ（return import）
  if (norm(r.return_amazon_order_id).length > 0) return true;

  // 返品/廃棄ステータス（固定）
  const st = normLower(r.stock_status);
  if (st === STOCK_STATUS_RETURN_INSPECTION || st === STOCK_STATUS_DISPOSED) return true;

  // ジャンク扱い（exit_type 固定）
  const ex = normLower(r.exit_type);
  if (ex === EXIT_TYPE_JUNK_RETURN) return true;

  return false;
}

function sortCreatedAtDescIdDesc(a: InboundRow, b: InboundRow): number {
  const ta = a.created_at ? Date.parse(a.created_at) : 0;
  const tb = b.created_at ? Date.parse(b.created_at) : 0;
  if (ta !== tb) return tb - ta;
  return b.id - a.id;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as {
      salesTransactionIds?: unknown;
      amazon_order_id?: unknown;
    };

    const salesTransactionIds = parseIds(body.salesTransactionIds);
    const amazonOrderIdHint = norm(body.amazon_order_id);

    if (salesTransactionIds.length === 0) {
      return NextResponse.json({ error: "salesTransactionIds を1件以上指定してください。" }, { status: 400 });
    }

    // sales_transactions 取得（item_quantity 列が無い環境もあるため variants）
    const selectVariants = [
      "id, amazon_order_id, transaction_type, amount_type, amount_description, amount, stock_id, item_quantity",
      "id, amazon_order_id, transaction_type, amount_type, amount_description, amount, stock_id",
    ] as const;

    let txRows: TxRow[] = [];
    for (let i = 0; i < selectVariants.length; i++) {
      const sel = selectVariants[i];
      const res = await supabase.from("sales_transactions").select(sel).in("id", salesTransactionIds);
      if (!res.error) {
        txRows = (res.data ?? []) as unknown as TxRow[];
        break;
      }
      const code = (res.error as any)?.code;
      const msg = String((res.error as any)?.message ?? "").toLowerCase();
      const last = i === selectVariants.length - 1;
      if (last) throw res.error;
      if (code === "42703" || msg.includes("item_quantity")) continue;
      throw res.error;
    }

    if (txRows.length !== salesTransactionIds.length) {
      return NextResponse.json({ error: "指定した売上明細の一部が見つかりません。" }, { status: 400 });
    }

    // Refund行抽出
    const refundRows = txRows.filter((r) =>
      isRefundLikeRow({
        amount: r.amount,
        transaction_type: r.transaction_type,
        amount_type: r.amount_type,
        amount_description: r.amount_description,
      })
    );

    // refundQty 優先順位（仕様固定）
    const sumQty = refundRows.reduce((sum, r) => {
      const q = Number(r.item_quantity);
      if (!Number.isFinite(q)) return sum;
      const n = Math.trunc(q);
      return n >= 1 ? sum + n : sum;
    }, 0);
    const refundQty = sumQty > 0 ? sumQty : refundRows.length > 0 ? refundRows.length : 0;

    // 注文番号（order_id逆引きに使う。ヒント優先、無ければ raw_details からユニーク推定）
    const distinctOrderIds = [
      ...new Set(
        txRows
          .map((r) => norm(r.amazon_order_id))
          .filter((s) => s.length > 0)
      ),
    ];
    const amazonOrderId =
      amazonOrderIdHint.length > 0 ? amazonOrderIdHint : distinctOrderIds.length === 1 ? distinctOrderIds[0]! : "";

    // inbound候補ID: stock_id 経路 + order_id逆引き経路（UnionしてSet）
    const inboundIdSet = new Set<number>();

    // stock_id 経路（主）
    for (const r of txRows) {
      const sid = Number(r.stock_id);
      if (Number.isFinite(sid) && sid >= 1) inboundIdSet.add(sid);
    }

    // order_id 逆引き（従）: 抽出時は「正しく order_id が入っている行」だけ対象
    if (amazonOrderId) {
      const res = await supabase
        .from("inbound_items")
        .select("id")
        .eq("order_id", amazonOrderId);
      if (res.error) throw res.error;
      for (const row of (res.data ?? []) as Array<{ id: unknown }>) {
        const id = Number((row as any).id);
        if (Number.isFinite(id) && id >= 1) inboundIdSet.add(id);
      }
    }

    const inboundIds = [...inboundIdSet].filter((n) => Number.isFinite(n) && n >= 1);

    let inboundRows: InboundRow[] = [];
    if (inboundIds.length > 0) {
      const res = await supabase
        .from("inbound_items")
        .select("id, order_id, settled_at, created_at, stock_status, return_amazon_order_id, exit_type")
        .in("id", inboundIds);
      if (res.error) throw res.error;
      inboundRows = (res.data ?? []) as InboundRow[];
    }

    // ブロック判定・集計
    const blocked = inboundRows.filter(isReturnBlockedInbound);
    const blockedIdSet = new Set(blocked.map((r) => r.id));

    const skipped_already_free = inboundRows.filter((r) => isFreeOrderId(r.order_id)).length;
    const skipped_return_flagged = blocked.length - skipped_already_free;

    // 解除対象抽出: ブロック除外 + 「正しく order_id が入っている行」限定（空文字/NULLは除外）
    const releasable = inboundRows
      .filter((r) => !blockedIdSet.has(r.id))
      .filter((r) => !isFreeOrderId(r.order_id));

    // 仕様固定: Union→一意→ created_at DESC, id DESC → slice(N)
    const sorted = [...releasable].sort(sortCreatedAtDescIdDesc);
    const toRelease = refundQty > 0 ? sorted.slice(0, refundQty) : [];

    // inbound update（部分解除）
    let updated_inbound_count = 0;
    if (toRelease.length > 0) {
      const idsToRelease = toRelease.map((r) => r.id);
      const { data: updated, error } = await supabase
        .from("inbound_items")
        .update({ settled_at: null, order_id: null })
        .in("id", idsToRelease)
        .not("order_id", "is", null)
        .select("id");
      if (error) throw error;
      updated_inbound_count = (updated ?? []).length;
    }

    // sales_transactions: 指定idはMixedでも全件reconciled（status列が無いDBでは no-op）
    await markSalesTransactionsReconciled(salesTransactionIds);

    return NextResponse.json({
      ok: true,
      updated_sales_tx_count: salesTransactionIds.length,
      updated_inbound_count,
      skipped_already_free,
      skipped_return_flagged,
      refund_qty: refundQty,
      order_id_used: amazonOrderId || null,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "処理に失敗しました。";
    console.error("[manual-finance-refund-release]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

