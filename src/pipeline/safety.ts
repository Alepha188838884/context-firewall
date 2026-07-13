// 安全红线,勿删:压缩绝不静默丢弃安全相关输出(设计文档 §3.2/§5)

import { looksLikeHtml } from './html-detect.js';

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
  // keyword scan below is only a useful "don't compress this" heuristic for plain-text/JSON
  // tool output, where a keyword hit plausibly *is* the message; HTML markup gets no such
  // exemption from compression, since htmlToMarkdown converts it without discarding text.
  if (looksLikeHtml(text)) {
    return false;
  }

  const prefix = text.slice(0, PREFIX_SCAN_LENGTH);
  return SAFETY_KEYWORDS_EN.test(prefix) || SAFETY_KEYWORDS_ZH.test(prefix);
}
