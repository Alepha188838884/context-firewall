import { describe, it, expect } from 'vitest';
import { isSecuritySensitive } from '../../src/pipeline/safety.js';

describe('isSecuritySensitive', () => {
  it('is true whenever result.isError is true, regardless of text', () => {
    expect(isSecuritySensitive({ isError: true }, 'totally normal text')).toBe(true);
  });

  it('does not flag ordinary text with no keywords', () => {
    expect(isSecuritySensitive({}, 'The quick brown fox jumps over the lazy dog.')).toBe(false);
  });

  const englishKeywords = [
    'error',
    'failed',
    'failure',
    'denied',
    'unauthorized',
    'forbidden',
    'permission',
    'not allowed',
    'warning',
    'caution',
    'deprecat',
    'confirm',
    'are you sure',
    'invalid',
    'expired',
    'rate limit',
    'rate-limit',
  ];

  for (const kw of englishKeywords) {
    it(`flags English keyword "${kw}"`, () => {
      expect(isSecuritySensitive({}, `Something happened: ${kw} occurred.`)).toBe(true);
    });

    it(`flags English keyword "${kw}" case-insensitively`, () => {
      expect(isSecuritySensitive({}, `SOMETHING: ${kw.toUpperCase()}!`)).toBe(true);
    });
  }

  it('flags "deprecated" (regression test: trailing \\b previously blocked deprecat+suffix matches)', () => {
    expect(isSecuritySensitive({}, 'This API is deprecated, please migrate.')).toBe(true);
  });

  it('flags "deprecation" (regression test: trailing \\b previously blocked deprecat+suffix matches)', () => {
    expect(isSecuritySensitive({}, 'Scheduled for deprecation next quarter.')).toBe(true);
  });

  const chineseKeywords = ['权限', '拒绝', '警告', '错误', '失败', '确认', '过期'];

  for (const kw of chineseKeywords) {
    it(`flags Chinese keyword "${kw}"`, () => {
      expect(isSecuritySensitive({}, `操作结果:${kw},请检查。`)).toBe(true);
    });
  }

  it('does not trigger on a keyword appearing only after the first 500 characters', () => {
    const padding = 'a'.repeat(500);
    const text = `${padding}error`;
    expect(isSecuritySensitive({}, text)).toBe(false);
  });

  it('does trigger when the keyword is within the first 500 characters', () => {
    const padding = 'a'.repeat(490);
    const text = `${padding} error`;
    expect(isSecuritySensitive({}, text)).toBe(true);
  });

  // Regression (Finding 1, 2026-07-13 benchmark): a real HTML page with an inline <script>
  // containing `catch (error) {` within the first 500 chars used to bypass compression for the
  // entire page. HTML documents should be exempt from the keyword scan (but not from the
  // isError structured signal).
  describe('regression: HTML documents are exempt from the keyword scan', () => {
    function htmlPageWithScriptError(): string {
      const nav = Array.from(
        { length: 12 },
        (_, i) => `<div class="nav"><a href="/p${i}">Page ${i}</a></div>`
      ).join('');
      return `<!DOCTYPE html>\n<html><head><title>Test</title>\n<script>\ntry { doThing(); } catch (error) { console.log(error); }\n</script>\n</head>\n<body>${nav}<p>Real content down here.</p></body></html>`;
    }

    it('does not bypass a real HTML page whose inline <script> contains "catch (error)"', () => {
      const html = htmlPageWithScriptError();
      // sanity: the keyword really is within the scanned prefix
      expect(html.slice(0, 500)).toMatch(/error/);
      expect(isSecuritySensitive({}, html)).toBe(false);
    });

    it('still bypasses when isError is true, even for an HTML document', () => {
      const html = htmlPageWithScriptError();
      expect(isSecuritySensitive({ isError: true }, html)).toBe(true);
    });

    it('plain-text (non-HTML) error messages still bypass as before', () => {
      expect(isSecuritySensitive({}, 'Error: permission denied')).toBe(true);
    });
  });
});
