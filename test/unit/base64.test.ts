import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { stripBase64Stage } from '../../src/pipeline/base64.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { DEFAULT_POLICY } from '../../src/config.js';

const ctx = { server: 'srv', tool: 'tool', fullHandle: 'cf-full-0000' };

// Real binary data encoded as base64, long enough (>1024 chars) to clear the length gate and
// varied enough (mixed case, digits, padding) to clear the shape gate in looksLikeBase64().
function realBase64Blob(byteLength = 1536): string {
  return Buffer.from(randomBytes(byteLength)).toString('base64');
}

describe('stripBase64Stage', () => {
  it('leaves base64-looking runs under 1024 chars untouched', () => {
    const store = new ArtifactStore();
    const text = `here is some data: ${'A'.repeat(1000)} end`;

    const { text: out, applied } = stripBase64Stage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(false);
    expect(out).toBe(text);
  });

  it('replaces a 2KB bare base64 block with a placeholder, and read_more retrieves the original block', () => {
    const store = new ArtifactStore();
    const blob = realBase64Blob();
    expect(blob.length).toBeGreaterThanOrEqual(1024);
    const text = `prefix ${blob} suffix`;

    const { text: out, applied } = stripBase64Stage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).not.toContain(blob);
    expect(out).toContain('[binary data removed:');
    expect(out).toContain('KB base64');
    expect(out).toContain('prefix');
    expect(out).toContain('suffix');

    const match = out.match(/read_more\("([^"]+)"\)/);
    expect(match).not.toBeNull();
    const handle = match?.[1] as string;
    expect(store.get(handle)?.data).toBe(blob);
  });

  it('regression (A3): does not strip a long run of a single repeated character (e.g. "x".repeat(2000))', () => {
    const store = new ArtifactStore();
    const filler = 'x'.repeat(2000);
    const text = `prefix ${filler} suffix`;

    const { text: out, applied } = stripBase64Stage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(false);
    expect(out).toBe(text);
  });

  it('regression (A3): still strips a real 2KB base64 blob generated from random bytes', () => {
    const store = new ArtifactStore();
    const blob = realBase64Blob(2048);
    const text = `prefix ${blob} suffix`;

    const { text: out, applied } = stripBase64Stage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).not.toContain(blob);
    const match = out.match(/read_more\("([^"]+)"\)/);
    const handle = match?.[1] as string;
    expect(store.get(handle)?.data).toBe(blob);
  });

  it('extracts the mime type from a data URI and stores the raw base64 payload under it', () => {
    const store = new ArtifactStore();
    const payload = 'A'.repeat(2000);
    const text = `<img src="data:image/png;base64,${payload}">`;

    const { text: out, applied } = stripBase64Stage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).toContain('image/png');
    expect(out).not.toContain(payload);

    const match = out.match(/read_more\("([^"]+)"\)/);
    const handle = match?.[1] as string;
    const artifact = store.get(handle);
    expect(artifact?.data).toBe(payload);
    expect(artifact?.meta.mime).toBe('image/png');
  });

  it('skips stripping entirely when policy.stripBase64 is false', () => {
    const store = new ArtifactStore();
    const blob = 'A'.repeat(2048);
    const text = `prefix ${blob} suffix`;
    const policy = { ...DEFAULT_POLICY, stripBase64: false };

    const { text: out, applied } = stripBase64Stage.apply({ text }, policy, store, ctx);

    expect(applied).toBe(false);
    expect(out).toBe(text);
  });

  it('regression: a single >2MB contiguous base64-alphabet block is skipped (applied: false) instead of throwing', () => {
    const store = new ArtifactStore();
    // A real base64 blob (mixed case + digits) over the 2,000,000-char stage input threshold.
    // Previously this size tripped a V8 RangeError inside the regex .replace() pass.
    const blob = realBase64Blob(2_100_000);
    expect(blob.length).toBeGreaterThan(2_000_000);

    expect(() => stripBase64Stage.apply({ text: blob }, DEFAULT_POLICY, store, ctx)).not.toThrow();

    const { text: out, applied } = stripBase64Stage.apply({ text: blob }, DEFAULT_POLICY, store, ctx);
    expect(applied).toBe(false);
    expect(out).toBe(blob);
  });
});
