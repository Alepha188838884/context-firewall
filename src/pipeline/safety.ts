// 安全红线,勿删:压缩绝不静默丢弃安全相关输出(设计文档 §3.2/§5)

const SAFETY_KEYWORDS_EN =
  /\b(error|failed|failure|denied|unauthorized|forbidden|permission|not allowed|warning|caution|deprecat|confirm|are you sure|invalid|expired|rate.?limit)\b/i;
const SAFETY_KEYWORDS_ZH = /权限|拒绝|警告|错误|失败|确认|过期/;

const PREFIX_SCAN_LENGTH = 500;

/**
 * Sniff test for "don't compress this" content. Deliberately over-inclusive: a false
 * positive just skips compression once, a false negative can hide a security-relevant
 * message from the caller.
 */
export function isSecuritySensitive(result: { isError?: boolean }, text: string): boolean {
  if (result.isError === true) {
    return true;
  }

  const prefix = text.slice(0, PREFIX_SCAN_LENGTH);
  return SAFETY_KEYWORDS_EN.test(prefix) || SAFETY_KEYWORDS_ZH.test(prefix);
}
