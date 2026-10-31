// Vocabulary is provider data, never a transcription instruction or a rewrite
// rule. Drop malformed labels instead of changing their spelling to fit the API.
export function transcriptionKeywords(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  let length = 0;
  for (const value of values) {
    if (/[<>\p{Cc}\u2028\u2029]/u.test(value)) continue;
    const keyword = value.trim();
    const identity = keyword.toLowerCase();
    if (!keyword || keyword.length > 96 || seen.has(identity) || length + keyword.length > 2048) continue;
    result.push(keyword); seen.add(identity); length += keyword.length;
    if (result.length === 32) break;
  }
  return result;
}
