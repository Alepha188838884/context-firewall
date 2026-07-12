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
});
