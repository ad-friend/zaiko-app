/** STEP5 未処理グループ向け: internal_note の一覧表示・編集初期値 */

export type RowWithOptionalInternalNote = { internal_note?: string | null };

/** カード1行サマリ（複数内容は短く示す） */
export function internalNoteSummaryForGroup(rows: RowWithOptionalInternalNote[]): string | null {
  const trimmed = rows.map((r) => String(r.internal_note ?? "").trim()).filter(Boolean);
  if (trimmed.length === 0) return null;
  const uniq = [...new Set(trimmed)];
  if (uniq.length === 1) {
    const s = uniq[0];
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  }
  const first = uniq[0];
  const clip = first.length > 60 ? `${first.slice(0, 57)}...` : first;
  return `${clip}（他${uniq.length - 1}種のメモあり）`;
}

/** テキストエリア初期値（全行に同じ内容が無い場合はユニークを区切りで連結） */
export function consolidatedInternalNoteForEdit(rows: RowWithOptionalInternalNote[]): string {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const r of rows) {
    const t = String(r.internal_note ?? "").trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    ordered.push(t);
  }
  return ordered.join("\n---\n");
}
