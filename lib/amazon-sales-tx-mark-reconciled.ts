import { supabase } from "@/lib/supabase";

/** sales_transactions を status=reconciled に（status 列が無いDBでは何もしない） */
export async function markSalesTransactionsReconciled(ids: number[]): Promise<void> {
  if (!ids.length) return;

  const { error: err1 } = await supabase
    .from("sales_transactions")
    .update({ status: "reconciled" } as Record<string, unknown>)
    .in("id", ids);
  if (!err1) return;

  const code = (err1 as { code?: string })?.code;
  const msg = (err1 as { message?: string })?.message ?? "";
  if (code === "42703" || msg.includes("status")) return;
  throw err1;
}
