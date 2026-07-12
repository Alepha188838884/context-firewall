import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../src/tokens.js';

describe('estimateTokens', () => {
  it('estimates ceil(chars / 3.5)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1); // 3/3.5 -> ceil 0.86 -> 1
    expect(estimateTokens('a'.repeat(7))).toBe(2); // 7/3.5 = 2
    expect(estimateTokens('a'.repeat(35))).toBe(10); // 35/3.5 = 10
  });
});
