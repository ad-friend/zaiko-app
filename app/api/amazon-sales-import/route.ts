/**
 * Amazon 日付範囲別レポートのトランザクション CSV/TSV を sales_transactions に取り込む。
 * - フロントで PapaParse 済みの行オブジェクトを最大50件ずつ JSON POST する（タイムアウト回避）
 * - 1 CSV 行を金額列ごとに縦持ち（Finances API 相当: transaction_type=Order, amount_type=Charge/Fee）
 * - 同一 order_id × 内訳種別で分割発送行をマージ
 * - 変換ロジックは [lib/amazon-sales-import-engine.ts]。プレビューは /api/amazon-sales-import/preview
 */
import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import {
  buildAmazonSalesCsvImportFromBody,
  MAX_ROWS_PER_REQUEST,
  type AmazonSalesCsvUpsertRow,
} from "@/lib/amazon-sales-import-engine";
import {
  attachSalesTransactionIdempotency,
  dedupeUpsertChunkByIdempotencyKey,
} from "@/lib/sales-transaction-idempotency";

/** Vercel Hobby の上限。Pro では 300 などに変更可能 */
export const maxDuration = 60;

export { MAX_ROWS_PER_REQUEST };

const UPSERT_CHUNK = 200;

/**
 * 分割送信（batchMode）の 2 本目以降: 同一 amazon_event_hash が既に DB にある場合は金額を加算（分割発送がチャンクをまたぐ場合）。
 * chunkIndex 0（または batchMode でない通常送信）は upsert のみ＝衝突時は上書き（全件1回の再インポート向け）。
 */
async function mergeUpsertChunkWithExisting(
  chunk: AmazonSalesCsvUpsertRow[],
  batchMode: boolean,
  chunkIndex: number | null
): Promise<AmazonSalesCsvUpsertRow[]> {
  if (!batchMode || chunk.length === 0) return chunk;
  if (chunkIndex == null || chunkIndex === 0) return chunk;
  const hashes = [...new Set(chunk.map((r) => r.amazon_event_hash).filter(Boolean))];
  if (hashes.length === 0) return chunk;

  const { data: existingRows, error } = await supabase
    .from("sales_transactions")
    .select("amazon_event_hash, amount, posted_date, sku")
    .in("amazon_event_hash", hashes);

  if (error) throw error;

  const byHash = new Map((existingRows ?? []).map((e) => [e.amazon_event_hash as string, e]));

  return chunk.map((row) => {
    const h = row.amazon_event_hash;
    const ex = h ? byHash.get(h) : undefined;
    if (!ex) return row;
    const exAmt = Number(ex.amount);
    const newAmt = Number(row.amount);
    const exMs = Date.parse(String(ex.posted_date));
    const rowMs = Date.parse(String(row.posted_date));
    const usePosted = Number.isFinite(exMs) && Number.isFinite(rowMs) && exMs <= rowMs ? ex.posted_date : row.posted_date;
    return {
      ...row,
      amount: Math.round((exAmt + newAmt) * 100) / 100,
      posted_date: usePosted as string,
      sku: row.sku ?? (ex.sku as string | null),
    };
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Parameters<typeof buildAmazonSalesCsvImportFromBody>[0];

    const built = buildAmazonSalesCsvImportFromBody(body);
    if (!built.ok) {
      return NextResponse.json({ error: built.error }, { status: built.status });
    }

    const {
      skipped_prefix_lines,
      chunk_index: chunkIndex,
      total_chunks: totalChunks,
      batch_mode: batchMode,
      rows_read,
      rows_expanded,
      rows_after_merge,
      merged_split_payment_orders,
      merged_split_payment_extra_rows,
      merge_message,
      row_errors,
      skipped_rows,
      insert_payload: insertPayload,
    } = built;

    const chunkIdxSafe = chunkIndex ?? 0;

    if (!insertPayload.length) {
      return NextResponse.json({
        ok: true,
        skipped_prefix_lines,
        rows_read,
        rows_expanded: 0,
        rows_after_merge: 0,
        merged_split_payment_orders: 0,
        merged_split_payment_extra_rows: 0,
        message: merge_message,
        upserted: 0,
        row_errors,
        skipped_rows,
        batch_mode: batchMode,
        batch_chunk_index: chunkIndex,
        batch_total_chunks: totalChunks,
      });
    }

    console.log(
      `[amazon-sales-import] chunk=${chunkIdxSafe}/${totalChunks ?? 1} skipped_prefix=${skipped_prefix_lines} csv_rows=${rows_read} expanded=${rows_expanded} merged_out=${insertPayload.length} merged_orders=${merged_split_payment_orders} merged_extra=${merged_split_payment_extra_rows}`
    );

    let upserted = 0;
    for (let i = 0; i < insertPayload.length; i += UPSERT_CHUNK) {
      const chunk = insertPayload.slice(i, i + UPSERT_CHUNK);
      const merged = await mergeUpsertChunkWithExisting(chunk, batchMode, chunkIndex);
      const toUpsert = dedupeUpsertChunkByIdempotencyKey(merged.map((r) => attachSalesTransactionIdempotency(r)));
      const { data: upData, error: upErr } = await supabase
        .from("sales_transactions")
        .upsert(toUpsert, {
          onConflict: "idempotency_key",
          ignoreDuplicates: false,
        })
        .select("id");

      if (upErr) {
        if (upErr.code === "42P01") {
          return NextResponse.json(
            {
              error:
                "sales_transactions テーブルが存在しません。docs/sales_transactions_table.sql を実行してください。",
            },
            { status: 500 }
          );
        }
        throw upErr;
      }
      upserted += Array.isArray(upData) ? upData.length : 0;
    }

    return NextResponse.json({
      ok: true,
      skipped_prefix_lines,
      rows_read,
      rows_expanded,
      rows_after_merge,
      merged_split_payment_orders,
      merged_split_payment_extra_rows,
      message: merge_message,
      upserted,
      row_errors,
      skipped_rows,
      batch_mode: batchMode,
      batch_chunk_index: chunkIndex,
      batch_total_chunks: totalChunks,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "売上データのインポートに失敗しました。";
    console.error("[amazon-sales-import]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
