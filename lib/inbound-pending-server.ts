/**
 * 相談-13：入庫待ちのサーバー専用処理。クライアントコンポーネントから import しない。
 * - 取込（PC・AI）は専用の合い言葉 INBOUND_IMPORT_SECRET で入口を絞る（lib/trends-import-auth.ts と同じ形）。
 * - 入庫待ちの表は service role だけが読み書きする（lib/supabase-server.ts と同じ形）。
 */
import { createClient } from "@supabase/supabase-js";

export function requireInboundImportAuth(authorization: string | null): 200 | 401 | 500 {
  const secret = process.env.INBOUND_IMPORT_SECRET;
  if (!secret) return 500;
  return authorization === `Bearer ${secret}` ? 200 : 401;
}

export function createInboundPendingClient() {
  if (typeof window !== "undefined") throw new Error("サーバー専用です");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("入庫待ちのサーバー設定が不足しています");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(10000) }) },
  });
}

export const PENDING_COLUMNS =
  "id,status,supplier_key,document_number,order_number,purchase_date,blockers,review_required,source_refs,payload,registered_header_id,created_at";
