/**
 * manual_finance_refund_release RPC と同等の候補在庫集計（プレビュー用）
 */
import { supabase } from "@/lib/supabase";
import { computeSuggestedRefundQty, type RefundQtyDetailLike } from "@/lib/refund-qty-from-details";

const PAGE = 1000;
const ID_BATCH = 80;

export type RefundReleaseInventoryPreview = {
  amazon_order_id: string;
  suggested_refund_qty: number;
  available_count: number;
  linked_inbound_count: number;
  skipped_already_free: number;
  skipped_return_flagged: number;
};

type InboundCandidateRow = {
  id: unknown;
  order_id: string | null;
  return_amazon_order_id: string | null;
  stock_status: string | null;
  exit_type: string | null;
};

function normOrderId(v: string | null | undefined): string {
  return String(v ?? "").trim();
}

function isReturnFlagged(row: InboundCandidateRow): boolean {
  if (normOrderId(row.return_amazon_order_id)) return true;
  const status = String(row.stock_status ?? "").toLowerCase();
  if (status === "return_inspection" || status === "disposed") return true;
  if (String(row.exit_type ?? "").toLowerCase() === "junk_return") return true;
  return false;
}

async function collectStockIdsFromSalesTransactions(salesTransactionIds: number[]): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < salesTransactionIds.length; i += ID_BATCH) {
    const chunk = salesTransactionIds.slice(i, i + ID_BATCH);
    const { data, error } = await supabase.from("sales_transactions").select("stock_id").in("id", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      const sid = Number(row.stock_id);
      if (Number.isFinite(sid) && sid >= 1) ids.push(sid);
    }
  }
  return ids;
}

async function collectInboundIdsByOrderId(amazonOrderId: string): Promise<number[]> {
  const ids: number[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("inbound_items")
      .select("id")
      .eq("order_id", amazonOrderId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data?.length) break;
    for (const row of data) {
      const id = Number(row.id);
      if (Number.isFinite(id)) ids.push(id);
    }
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return ids;
}

async function fetchInboundCandidates(candidateIds: number[]): Promise<InboundCandidateRow[]> {
  const unique = [...new Set(candidateIds.filter((id) => Number.isFinite(id) && id >= 1))];
  const rows: InboundCandidateRow[] = [];
  for (let i = 0; i < unique.length; i += ID_BATCH) {
    const chunk = unique.slice(i, i + ID_BATCH);
    const { data, error } = await supabase
      .from("inbound_items")
      .select("id, order_id, return_amazon_order_id, stock_status, exit_type")
      .in("id", chunk);
    if (error) throw error;
    rows.push(...((data ?? []) as InboundCandidateRow[]));
  }
  return rows;
}

function classifyCandidates(rows: InboundCandidateRow[]): Omit<
  RefundReleaseInventoryPreview,
  "amazon_order_id" | "suggested_refund_qty"
> {
  let skipped_already_free = 0;
  let skipped_return_flagged = 0;
  let available_count = 0;
  let linked_inbound_count = 0;

  for (const row of rows) {
    const orderIdNorm = normOrderId(row.order_id);
    if (!orderIdNorm) {
      skipped_already_free += 1;
      continue;
    }
    linked_inbound_count += 1;
    if (isReturnFlagged(row)) {
      skipped_return_flagged += 1;
      continue;
    }
    available_count += 1;
  }

  return {
    available_count,
    linked_inbound_count,
    skipped_already_free,
    skipped_return_flagged,
  };
}

async function fetchFinanceDetailsForIds(salesTransactionIds: number[]): Promise<RefundQtyDetailLike[]> {
  const rows: RefundQtyDetailLike[] = [];
  for (let i = 0; i < salesTransactionIds.length; i += ID_BATCH) {
    const chunk = salesTransactionIds.slice(i, i + ID_BATCH);
    const { data, error } = await supabase
      .from("sales_transactions")
      .select("amount, transaction_type, amount_type, amount_description, item_quantity")
      .in("id", chunk);
    if (error) throw error;
    rows.push(...((data ?? []) as RefundQtyDetailLike[]));
  }
  return rows;
}

export async function previewRefundReleaseInventory(params: {
  amazonOrderId: string;
  salesTransactionIds: number[];
  financeDetails?: RefundQtyDetailLike[];
}): Promise<RefundReleaseInventoryPreview> {
  const amazonOrderId = normOrderId(params.amazonOrderId);
  if (!amazonOrderId) {
    throw new Error("amazon_order_id が必要です。");
  }

  const [stockIds, orderInboundIds, financeDetails] = await Promise.all([
    collectStockIdsFromSalesTransactions(params.salesTransactionIds),
    collectInboundIdsByOrderId(amazonOrderId),
    params.financeDetails != null
      ? Promise.resolve(params.financeDetails)
      : fetchFinanceDetailsForIds(params.salesTransactionIds),
  ]);
  const candidateIds = [...new Set([...stockIds, ...orderInboundIds])];
  const inboundRows = await fetchInboundCandidates(candidateIds);
  const counts = classifyCandidates(inboundRows);
  const suggested_refund_qty = computeSuggestedRefundQty(financeDetails);

  return {
    amazon_order_id: amazonOrderId,
    suggested_refund_qty,
    ...counts,
  };
}
