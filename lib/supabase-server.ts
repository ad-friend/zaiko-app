import { createClient } from "@supabase/supabase-js";

// 遅延生成。クライアントコンポーネントから import しない。
export function createSalesAnalysisWriter() {
  if (typeof window !== "undefined") throw new Error("サーバー専用です");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("売上分析のサーバー設定が不足しています");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(3000) }) } });
}
