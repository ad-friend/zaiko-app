/**
 * 仕入先サジェストの部分一致用に、比較用文字列を正規化する。
 * 「株式会社」「(株)」「（株）」および半角・全角スペースを除去する。
 */
export function normalizeSupplierForMatch(value: string): string {
  return (value ?? "")
    .replace(/株式会社/g, "")
    .replace(/\(株\)/g, "")
    .replace(/（株）/g, "")
    .replace(/\s/g, "")
    .trim();
}
