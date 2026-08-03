import { describe, it, expect } from 'vitest';
import { matchesToolPattern, checkToolPolicy } from '../../src/tool-policy.js';

describe('matchesToolPattern', () => {
  it('matches exact names', () => {
    expect(matchesToolPattern('delete_file', 'delete_file')).toBe(true);
    expect(matchesToolPattern('delete_file', 'create_file')).toBe(false);
  });

  it('matches glob patterns with *', () => {
    expect(matchesToolPattern('delete_file', 'delete_*')).toBe(true);
    expect(matchesToolPattern('delete_repo', 'delete_*')).toBe(true);
    expect(matchesToolPattern('create_file', 'delete_*')).toBe(false);
  });

  it('treats non-* characters as literal (no regex-special-char handling needed since there is no regex)', () => {
    expect(matchesToolPattern('a.b', 'a.b')).toBe(true);
    expect(matchesToolPattern('aXb', 'a.b')).toBe(false);
  });

  it('regression: adjacent *s (e.g. "a**b") resolve quickly instead of catastrophically backtracking', () => {
    const longName = `${'a'.repeat(1000)}b`;
    const start = Date.now();
    expect(matchesToolPattern(longName, 'a**b')).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('regression: * matches a newline in the tool name (a regex "." would not)', () => {
    expect(matchesToolPattern('delete_evil\ninject', 'delete_*')).toBe(true);
  });

  it('does not blow up on long patterns against long names', () => {
    const longName = 'x'.repeat(2000);
    const longPattern = `${'x*'.repeat(50)}y`;
    const start = Date.now();
    expect(matchesToolPattern(longName, longPattern)).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('checkToolPolicy', () => {
  it('allows everything when downstream is undefined (backward compatible)', () => {
    expect(checkToolPolicy(undefined, 'anything')).toEqual({ allowed: true });
  });

  it('allows everything when neither allowTools nor denyTools is set', () => {
    expect(checkToolPolicy({}, 'anything')).toEqual({ allowed: true });
  });

  it('denies an exact match in denyTools', () => {
    const result = checkToolPolicy({ denyTools: ['delete_repo'] }, 'delete_repo');
    expect(result).toEqual({ allowed: false, rule: 'denyTools: "delete_repo"' });
  });

  it('denies a glob match in denyTools', () => {
    const result = checkToolPolicy({ denyTools: ['delete_*'] }, 'delete_file');
    expect(result).toEqual({ allowed: false, rule: 'denyTools: "delete_*"' });
  });

  it('deny wins over allow when both match the same tool', () => {
    const result = checkToolPolicy(
      { allowTools: ['delete_file'], denyTools: ['delete_file'] },
      'delete_file'
    );
    expect(result).toEqual({ allowed: false, rule: 'denyTools: "delete_file"' });
  });

  it('rejects a tool not matched by allowTools when allowTools is set', () => {
    const result = checkToolPolicy({ allowTools: ['read_file'] }, 'delete_file');
    expect(result).toEqual({ allowed: false, rule: 'not matched by allowTools' });
  });

  it('allows a tool matched by an allowTools glob', () => {
    const result = checkToolPolicy({ allowTools: ['read_*'] }, 'read_file');
    expect(result).toEqual({ allowed: true });
  });
});
