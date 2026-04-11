/**
 * Cron 分割用: listFinancialEvents / Reports API の続きを跨リクエストで保持
 */
import { supabase } from "@/lib/supabase";

export async function getCronState(stateKey: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await supabase
    .from("cron_continuation_state")
    .select("payload")
    .eq("state_key", stateKey)
    .maybeSingle();
  if (error) throw new Error(`cron_continuation_state 読取: ${error.message}`);
  const p = data?.payload;
  if (p && typeof p === "object" && !Array.isArray(p)) return p as Record<string, unknown>;
  return null;
}

export async function setCronState(stateKey: string, payload: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from("cron_continuation_state").upsert(
    {
      state_key: stateKey,
      payload,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "state_key" }
  );
  if (error) throw new Error(`cron_continuation_state 保存: ${error.message}`);
}

export async function deleteCronState(stateKey: string): Promise<void> {
  const { error } = await supabase.from("cron_continuation_state").delete().eq("state_key", stateKey);
  if (error) throw new Error(`cron_continuation_state 削除: ${error.message}`);
}
