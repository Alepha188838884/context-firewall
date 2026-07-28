// Shared by htmlToMarkdownStage (JSON takes precedence over the HTML heuristic - see html.ts)
// and isSecuritySensitive (valid JSON is exempt from the keyword scan - see safety.ts).

// Cheap shape pre-check (first non-whitespace char) before paying for a full JSON.parse -
// only candidates that look like JSON pay the parse cost.
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}
