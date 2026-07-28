// 安全红线,勿删:压缩绝不静默丢弃安全相关输出(设计文档 §3.2/§5)

import { looksLikeHtml } from './html-detect.js';
import { looksLikeJson } from './json-detect.js';

const SAFETY_KEYWORDS_EN =
  /\b(error|failed|failure|denied|unauthorized|forbidden|permission|not allowed|warning|caution|deprecat\w*|confirm|are you sure|invalid|expired|rate.?limit)\b/i;
const SAFETY_KEYWORDS_ZH = /权限|拒绝|警告|错误|失败|确认|过期/;

const PREFIX_SCAN_LENGTH = 500;

/**
 * Sniff test for "don't compress this" content. Deliberately over-inclusive: a false
 * positive just skips compression once, a false negative can hide a security-relevant
 * message from the caller.
 */
export function isSecuritySensitive(result: { isError?: boolean }, text: string): boolean {
  // isError is a structured signal from the downstream, not a heuristic - it always bypasses,
  // regardless of content shape. Never remove this line.
  if (result.isError === true) {
    return true;
  }

  // A whole HTML document is not an error message: real pages routinely contain keyword hits
  // inside the first 500 chars that have nothing to do with the page's own status (e.g. an
  // inline <script>'s `catch (error) {`), which previously bypassed compression for the
  // entire page and returned raw <head>/<script> boilerplate instead of readable content. The
  // keyword scan below is only a useful "don't compress this" heuristic for plain, unstructured
  // text, where a keyword hit plausibly *is* the message; HTML markup and valid JSON (see below)
  // get no such exemption from compression, since their respective compression stages convert
  // them without discarding text.
  if (looksLikeHtml(text)) {
    return false;
  }

  // Same class of false positive as the HTML case above, for JSON: a real API response (issue
  // trackers, changelogs, support tickets, ...) routinely contains ordinary words like
  // "failure"/"error"/"warning" inside its data - e.g. an issue titled "...it can never record a
  // failure..." - within the first 500 raw chars, unrelated to the tool call's own
  // success/failure. That previously bypassed compression for the *entire* payload (232KB in a
  // real github/list_issues response), which then hit the hard truncation fallback instead of
  // jsonSummary and came back strictly worse than the normal compressed path would have. This is
  // safe to exempt because: (1) a JSON-*shaped* error response (e.g.
  // `{"message":"Bad credentials"}`) is almost always small enough to hit the small-output
  // bypass before ever reaching this scan, so it's returned raw regardless of this check; (2)
  // the structured `isError` signal above is untouched and always still bypasses; (3) any
  // error-relevant content buried inside a large JSON payload is still real data, not silently
  // dropped - jsonSummaryStage preserves structure (folding only same-shaped array/object runs)
  // and the full original is always retrievable via read_more. Invalid JSON (fails to parse)
  // gets no exemption and falls through to the keyword scan below, same as plain text.
  if (looksLikeJson(text)) {
    return false;
  }

  const prefix = text.slice(0, PREFIX_SCAN_LENGTH);
  return SAFETY_KEYWORDS_EN.test(prefix) || SAFETY_KEYWORDS_ZH.test(prefix);
}
