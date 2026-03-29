/**
 * FBA 返品レポート等の CSV/TSV を取り込み、注文単位で在庫巻き戻し + amazon_orders を returned に更新する。
 * 同一ファイル・過去データの再取り込みでも冪等（終端状態・DB 未登録はスキップ）。
 */
import { NextRequest, NextResponse } from "next/server";
import { parseAmazonReturnsDelimitedText } from "@/lib/amazon-returns-import-parse";
import { handleOrderReturn } from "@/lib/amazon-return";

export async function POST(request: NextRequest) {
  try {
    let text: string;
    let fileName = "returns.csv";

    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "file フィールドに CSV/TSV を添付してください。" }, { status: 400 });
      }
      text = await file.text();
      fileName = file.name || fileName;
    } else {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      if (!body || typeof body.csvText !== "string") {
        return NextResponse.json(
          { error: "multipart/form-data の file、または JSON { csvText: string, fileName?: string } を送ってください。" },
          { status: 400 }
        );
      }
      text = body.csvText;
      if (typeof body.fileName === "string" && body.fileName.trim()) {
        fileName = body.fileName.trim();
      }
    }

    let parsed: ReturnType<typeof parseAmazonReturnsDelimitedText>;
    try {
      parsed = parseAmazonReturnsDelimitedText(text, fileName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "CSV/TSV のパースに失敗しました。";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    /** 注文ID単位で1回だけ処理（重複行は冪等にまとめる） */
    const uniqueByOrder = new Map<string, string>();
    for (const r of parsed.rows) {
      if (!uniqueByOrder.has(r.amazon_order_id)) {
        uniqueByOrder.set(r.amazon_order_id, r.disposition);
      }
    }

    let processed_returns = 0;
    let skipped_unregistered = 0;
    let skipped_already_processed = 0;
    const errors: string[] = [...parsed.rowErrors];

    for (const [orderId, disposition] of uniqueByOrder) {
      const res = await handleOrderReturn(orderId, disposition);
      if (!res.ok) {
        errors.push(`${orderId}: ${res.message}`);
        continue;
      }
      if (res.outcome === "processed") {
        processed_returns += 1;
      } else if (res.outcome === "no_db_rows") {
        skipped_unregistered += 1;
      } else if (res.outcome === "all_terminal_skipped") {
        skipped_already_processed += 1;
      }
    }

    return NextResponse.json({
      ok: true,
      total_rows_read: parsed.rows.length,
      unique_orders_in_file: uniqueByOrder.size,
      processed_returns,
      skipped_unregistered,
      skipped_already_processed,
      row_parse_warnings: parsed.rowErrors.length,
      errors: errors.slice(0, 50),
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : "返品インポートに失敗しました。";
    console.error("[returns-import]", e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
