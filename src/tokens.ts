/**
 * Fast synchronous token estimate, chars/3.5. Used wherever an async API round-trip isn't
 * worth it (e.g. truncation budget annotations), and by the session report - see report.ts
 * for why the report never uses an exact count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
