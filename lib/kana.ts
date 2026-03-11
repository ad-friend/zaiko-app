/**
 * ひらがな・半角カナを全角カタカナに正規化（表記ゆれ防止）
 */
export function normalizeToFullWidthKatakana(input: string): string {
  if (!input) return "";
  let s = input;
  // ひらがな → カタカナ（U+3041-3096 → U+30A1-30F6）
  s = s.replace(/[\u3041-\u3096]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) + 0x60)
  );
  // 半角カナ → 全角カナ（主要な対応）
  const halfToFull: Record<string, string> = {
    "\uff66": "\u30f2", "\uff67": "\u30a1", "\uff68": "\u30a3", "\uff69": "\u30a5",
    "\uff6a": "\u30a7", "\uff6b": "\u30a9", "\uff6c": "\u30e3", "\uff6d": "\u30e5",
    "\uff6e": "\u30e7", "\uff6f": "\u30c3", "\uff70": "\u30fc", "\uff71": "\u30a2",
    "\uff72": "\u30a4", "\uff73": "\u30a6", "\uff74": "\u30a8", "\uff75": "\u30aa",
    "\uff76": "\u30ab", "\uff77": "\u30ad", "\uff78": "\u30af", "\uff79": "\u30b1",
    "\uff7a": "\u30b3", "\uff7b": "\u30b5", "\uff7c": "\u30b7", "\uff7d": "\u30b9",
    "\uff7e": "\u30bb", "\uff7f": "\u30bd", "\uff80": "\u30bf", "\uff81": "\u30c1",
    "\uff82": "\u30c4", "\uff83": "\u30c6", "\uff84": "\u30c8", "\uff85": "\u30ca",
    "\uff86": "\u30cb", "\uff87": "\u30cc", "\uff88": "\u30cd", "\uff89": "\u30ce",
    "\uff8a": "\u30cf", "\uff8b": "\u30d2", "\uff8c": "\u30d5", "\uff8d": "\u30d8",
    "\uff8e": "\u30db", "\uff8f": "\u30de", "\uff90": "\u30df", "\uff91": "\u30e0",
    "\uff92": "\u30e1", "\uff93": "\u30e2", "\uff94": "\u30e4", "\uff95": "\u30e6",
    "\uff96": "\u30e8", "\uff97": "\u30e9", "\uff98": "\u30ea", "\uff99": "\u30eb",
    "\uff9a": "\u30ec", "\uff9b": "\u30ed", "\uff9c": "\u30ef", "\uff9d": "\u30f3",
  };
  let out = "";
  for (const ch of s) {
    out += halfToFull[ch] ?? ch;
  }
  return out;
}
