const DOCTYPE_OR_HTML_TAG_PATTERN = /<html|<!doctype html/i;
const TAG_PATTERN = /<[a-z][a-z0-9-]*[\s>]/gi;
const STRUCTURAL_TAG_PATTERN = /<div|<p|<table|<body|<span|<a[\s>]/i;
const MIN_TAG_DENSITY = 10;

// Deliberately conservative: sooner miss real HTML than mangle plain text that happens to
// contain a handful of angle brackets. Shared by htmlToMarkdownStage (decides whether to
// convert markup to markdown) and isSecuritySensitive (decides whether a document is an HTML
// page, which exempts it from the keyword scan - see safety.ts).
export function looksLikeHtml(text: string): boolean {
  if (DOCTYPE_OR_HTML_TAG_PATTERN.test(text)) {
    return true;
  }
  const tagMatches = text.match(TAG_PATTERN);
  return Boolean(tagMatches && tagMatches.length >= MIN_TAG_DENSITY && STRUCTURAL_TAG_PATTERN.test(text));
}
