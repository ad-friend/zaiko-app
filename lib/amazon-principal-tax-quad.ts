/**
 * Principal / Tax の4行相殺パターン（±が注文内で打ち消し、在庫紐付け不要）の検出。
 * reconcile-sales の相殺ロジックとは独立（表示・手動処理のための判定のみ）。
 */

export type PrincipalTaxQuadRowLike = {
  amount: number;
  transaction_type?: string | null;
  amount_type?: string | null;
  amount_description?: string | null;
};

const TOL = 0.01;

function norm(s: string | null | undefined): string {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase();
}

function rowText(r: PrincipalTaxQuadRowLike): string {
  return [r.transaction_type, r.amount_type, r.amount_description].map(norm).join("\n");
}

function isPrincipalRow(r: PrincipalTaxQuadRowLike): boolean {
  const t = rowText(r);
  return t.includes("principal") || t.includes("商品代金") || t.includes("itemprice");
}

function isTaxRow(r: PrincipalTaxQuadRowLike): boolean {
  const t = rowText(r);
  return (
    (t.includes("tax") && !t.includes("principal")) ||
    t.includes("消費税") ||
    t.includes("itemwithholding") ||
    (t.includes("税") && !t.includes("免税"))
  );
}

export function isPrincipalTaxOffsetQuad(rows: PrincipalTaxQuadRowLike[]): boolean {
  if (rows.length !== 4) return false;
  const principals = rows.filter(isPrincipalRow);
  const taxes = rows.filter(isTaxRow);
  if (principals.length !== 2 || taxes.length !== 2) return false;

  const sum = (arr: PrincipalTaxQuadRowLike[]) =>
    arr.reduce((s, r) => s + Number(r.amount ?? 0), 0);

  return Math.abs(sum(principals)) <= TOL && Math.abs(sum(taxes)) <= TOL;
}
