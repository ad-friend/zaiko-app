/**
 * Amazon 決済トランザクション CSV/TSV の先頭説明行をスキップし、実ヘッダー行から始まる本文を返す。
 * フロント（売上 CSV パース前）と同じ判定で先頭説明行をスキップする。
 */
export function lineLooksLikeTransactionHeader(line: string): boolean {
  const t = line.replace(/^\uFEFF/, "").trim();
  if (t.length < 8) return false;
  const n = t.normalize("NFKC");
  const hasOrder =
    /オーダー番号|注文番号|order[\s_-]*id|amazon[\s_-]*order[\s_-]*id|amazon-order-id/i.test(n) ||
    /"order\s*id"/i.test(n);
  const hasDate =
    /日付[\/／]時刻|(?<![\w])日付(?![\w])|posted\s*date|posting\s*date|transaction\s*date|date[\/／]time/i.test(
      n
    );
  return hasOrder && hasDate;
}

export function sliceFromTransactionHeader(csvText: string): { body: string; skippedPrefixLines: number } {
  const bomStripped = csvText.replace(/^\uFEFF/, "");
  const lines = bomStripped.split(/\r?\n/);
  for (let start = 0; start < lines.length; start++) {
    const line = lines[start];
    if (!line || !line.trim()) continue;
    if (lineLooksLikeTransactionHeader(line)) {
      return { body: lines.slice(start).join("\n"), skippedPrefixLines: start };
    }
  }
  return { body: bomStripped.trim(), skippedPrefixLines: 0 };
}
