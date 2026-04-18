/**
 * Amazon 売上 CSV チャンクのプレビュー（DB に書き込まない）。
 * POST ボディは /api/amazon-sales-import と同じ。
 */
import { NextRequest, NextResponse } from "next/server";
import {
  buildAmazonSalesCsvImportFromBody,
  findSuspiciousBusinessKeyCollisions,
} from "@/lib/amazon-sales-import-engine";

export const maxDuration = 60;

const PREVIEW_ROW_CAP = 30;

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as Parameters<typeof buildAmazonSalesCsvImportFromBody>[0];
    const built = buildAmazonSalesCsvImportFromBody(body);
    if (!built.ok) {
      return NextResponse.json({ error: built.error }, { status: built.status });
    }

    const suspicious = findSuspiciousBusinessKeyCollisions(built.insert_payload);
    const upsert_preview = built.insert_payload.slice(0, PREVIEW_ROW_CAP);

    return NextResponse.json({
      ok: true,
      preview: true,
      skipped_prefix_lines: built.skipped_prefix_lines,
      row_offset_base: built.row_offset_base,
      rows_read: built.rows_read,
      rows_expanded: built.rows_expanded,
      rows_after_merge: built.rows_after_merge,
      merged_split_payment_orders: built.merged_split_payment_orders,
      merged_split_payment_extra_rows: built.merged_split_payment_extra_rows,
      message: built.merge_message,
      row_errors: built.row_errors,
      skipped_rows: built.skipped_rows,
      suspicious_business_key_collisions: suspicious,
      upsert_preview,
      upsert_preview_truncated: built.insert_payload.length > PREVIEW_ROW_CAP,
      batch_mode: built.batch_mode,
      batch_chunk_index: built.chunk_index,
      batch_total_chunks: built.total_chunks,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "プレビューに失敗しました。";
    console.error("[amazon-sales-import/preview]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
