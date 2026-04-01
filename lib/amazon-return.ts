/**
 * Amazon 返品レポート取り込み: 在庫解放 + amazon_orders を returned に更新（終端状態以外の行のみ）。
 *
 * TODO(disposition): Amazon の disposition（例: Sellable / Customer Damaged / Defective 等）に応じて分岐する。
 * - Sellable: 在庫は order から外し、stock_status=return_inspection（検品待ち）へ。人手で New/Used 確定後に available。
 * - Defective / 不良系: 専用ステータス・別 inbound 行生成など会計ポリシーに合わせて拡張する。
 */
import { supabase } from "@/lib/supabase";
import { AMAZON_ORDER_STATUS_RETURNED } from "@/lib/amazon-order-reconciliation-status";
import { releaseInboundItemsForAmazonOrder } from "@/lib/amazon-order-inventory-release";

function isTerminalReturnOrCancelStatus(s: string | null | undefined): boolean {
  const x = String(s ?? "").trim().toLowerCase();
  return x === "canceled" || x === "cancelled" || x === AMAZON_ORDER_STATUS_RETURNED;
}

function normalizeDispositionForFuture(_raw: string): void {
  // TODO(disposition): Sellable と Defective 等で在庫処理・ステータスを分岐する。
  void _raw;
}

export type HandleOrderReturnResult =
  | { ok: true; outcome: "processed"; updated_row_count: number }
  | { ok: true; outcome: "no_db_rows" }
  | { ok: true; outcome: "all_terminal_skipped" }
  | { ok: false; message: string };

/**
 * @param amazon_order_id マーケットプレイス注文番号
 * @param dispositionRaw レポートの disposition（現状は将来分岐用。未指定可）
 */
export async function handleOrderReturn(
  amazon_order_id: string,
  dispositionRaw?: string,
  returnReceivedAt?: string | null
): Promise<HandleOrderReturnResult> {
  const oid = String(amazon_order_id ?? "").trim();
  if (!oid) {
    return { ok: false, message: "amazon_order_id が空です。" };
  }

  if (dispositionRaw != null && String(dispositionRaw).trim()) {
    normalizeDispositionForFuture(String(dispositionRaw).trim());
  }

  const { data: orderRows, error: selErr } = await supabase
    .from("amazon_orders")
    .select("id, reconciliation_status")
    .eq("amazon_order_id", oid);

  if (selErr) {
    return { ok: false, message: selErr.message };
  }

  if (!orderRows?.length) {
    return { ok: true, outcome: "no_db_rows" };
  }

  const updatable = orderRows.filter((r) => !isTerminalReturnOrCancelStatus(r.reconciliation_status));
  if (updatable.length === 0) {
    return { ok: true, outcome: "all_terminal_skipped" };
  }

  const rel = await releaseInboundItemsForAmazonOrder(oid, "return", {
    returnReceivedAt: returnReceivedAt ?? null,
  });
  if (!rel.ok) {
    return { ok: false, message: rel.message };
  }

  const nowIso = new Date().toISOString();
  const ids = updatable.map((r) => r.id);

  const { data: updated, error: ordErr } = await supabase
    .from("amazon_orders")
    .update({ reconciliation_status: AMAZON_ORDER_STATUS_RETURNED, updated_at: nowIso })
    .in("id", ids)
    .select("id");

  if (ordErr) {
    return { ok: false, message: ordErr.message };
  }

  return {
    ok: true,
    outcome: "processed",
    updated_row_count: Array.isArray(updated) ? updated.length : 0,
  };
}
