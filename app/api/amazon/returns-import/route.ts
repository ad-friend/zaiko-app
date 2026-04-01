/**
 * FBA 返品レポート等の CSV/TSV を取り込み、注文単位で在庫巻き戻し + amazon_orders を returned に更新する。
 * 同一ファイル・過去データの再取り込みでも冪等（終端状態・DB 未登録はスキップ）。
 */
import { NextRequest, NextResponse } from "next/server";
import { parseAmazonReturnsDelimitedText, parseAmazonReturnDateToIso, pickEarlierIso } from "@/lib/amazon-returns-import-parse";
import { handleOrderReturn } from "@/lib/amazon-return";
import iconv from "iconv-lite";

function decodeUtf8(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
}

function decodeMaybeShiftJis(bytes: ArrayBuffer): string {
  // Node/Next の TextDecoder は Shift-JIS を安定サポートしないため iconv-lite で対応
  const buf = Buffer.from(bytes);
  // Amazon日本語レポートは CP932(=Windows-31J) が多い
  return iconv.decode(buf, "cp932");
}

function looksLikeMissingHeaderError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return msg.includes("必須ヘッダーが見つかりません");
}

export async function POST(request: NextRequest) {
  try {
    let text: string;
    let fileName = "returns.csv";
    let uploadBytes: ArrayBuffer | null = null;

    const ct = request.headers.get("content-type") ?? "";
    if (ct.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "file フィールドに CSV/TSV を添付してください。" }, { status: 400 });
      }
      // file.text() は UTF-8 前提になりやすく、Shift-JIS だとヘッダーが文字化けして失敗するため、
      // まずUTF-8でデコード→ヘッダー検出に失敗したら CP932(Shift-JIS系) で再デコードして再試行する。
      uploadBytes = await file.arrayBuffer();
      text = decodeUtf8(uploadBytes);
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
      // ヘッダー未検出は「文字コード違い」や「ヘッダー行が先頭でない」が多い。
      // multipart の場合のみ、Shift-JIS再デコードで自動復旧を試す。
      if (uploadBytes && looksLikeMissingHeaderError(e)) {
        try {
          const sjisText = decodeMaybeShiftJis(uploadBytes);
          parsed = parseAmazonReturnsDelimitedText(sjisText, fileName);
        } catch (e2: unknown) {
          const msg = e2 instanceof Error ? e2.message : "CSV/TSV のパースに失敗しました。";
          return NextResponse.json({ error: msg }, { status: 400 });
        }
      } else {
        const msg = e instanceof Error ? e.message : "CSV/TSV のパースに失敗しました。";
        return NextResponse.json({ error: msg }, { status: 400 });
      }
    }

    /** 注文ID単位で1回だけ処理（重複行は冪等にまとめる）。返品日は同一注文で最も早い日時を採用 */
    const uniqueByOrder = new Map<string, { disposition: string; returnReceivedAt: string | null }>();
    for (const r of parsed.rows) {
      const iso = parseAmazonReturnDateToIso(r.return_date_raw);
      const prev = uniqueByOrder.get(r.amazon_order_id);
      if (!prev) {
        uniqueByOrder.set(r.amazon_order_id, { disposition: r.disposition, returnReceivedAt: iso });
      } else {
        uniqueByOrder.set(r.amazon_order_id, {
          disposition: prev.disposition,
          returnReceivedAt: pickEarlierIso(prev.returnReceivedAt, iso),
        });
      }
    }

    let processed_returns = 0;
    let skipped_unregistered = 0;
    let skipped_already_processed = 0;
    const errors: string[] = [...parsed.rowErrors];

    for (const [orderId, { disposition, returnReceivedAt }] of uniqueByOrder) {
      const res = await handleOrderReturn(orderId, disposition, returnReceivedAt);
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
