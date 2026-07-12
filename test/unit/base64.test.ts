import { describe, it, expect } from 'vitest';
import { stripBase64Stage } from '../../src/pipeline/base64.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { DEFAULT_POLICY } from '../../src/config.js';

const ctx = { server: 'srv', tool: 'tool', fullHandle: 'cf-full-0000' };

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
    const blob = 'A'.repeat(2048);
    const text = `prefix ${blob} suffix`;

    const { text: out, applied } = stripBase64Stage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out).not.toContain(blob);
    expect(out).toContain('[binary data removed:');
    expect(out).toContain('2KB base64');
    expect(out).toContain('prefix');
    expect(out).toContain('suffix');

    const match = out.match(/read_more\("([^"]+)"\)/);
    expect(match).not.toBeNull();
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
});
