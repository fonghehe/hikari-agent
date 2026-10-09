/** Keywords plus CJK bigrams support search without requiring whitespace in Chinese/Japanese. */
export function searchTerms(query: string): string[] {
  const normalized = query.normalize('NFKC').toLowerCase();
  const terms = new Set(normalized.match(/[\p{L}\p{N}_]+/gu) ?? []);
  for (const segment of normalized.match(
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}ー]+/gu,
  ) ?? []) {
    const characters = [...segment];
    for (let index = 0; index < characters.length - 1; index++)
      terms.add(characters[index]! + characters[index + 1]!);
  }
  return [...terms].slice(0, 256);
}
