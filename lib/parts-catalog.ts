/** パーツマスタ（固定コード＋正式名称） */
export const ITEM_KIND_PRODUCT = "product";
export const ITEM_KIND_PART = "part";

export type PartCatalogRow = {
  code: string;
  name: string;
  brand: string | null;
  note: string | null;
  created_at?: string;
  updated_at?: string;
};

/** コード正規化: 前後空白除去、英字は大文字、空白はハイフン */
export function normalizePartCode(raw: string): string {
  return String(raw ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9_\-./]/g, "");
}

export function isValidPartCode(code: string): boolean {
  const c = normalizePartCode(code);
  return c.length >= 2 && c.length <= 64;
}
