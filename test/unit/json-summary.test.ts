import { describe, it, expect } from 'vitest';
import { jsonSummaryStage } from '../../src/pipeline/json-summary.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { DEFAULT_POLICY } from '../../src/config.js';

const ctx = { server: 'srv', tool: 'tool', fullHandle: 'cf-full-0000' };

describe('jsonSummaryStage', () => {
  it('collapses a 500-item homogeneous array to the first 5 items plus a "495 more" note, staying valid JSON', () => {
    const store = new ArtifactStore();
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}`, active: i % 2 === 0 }));
    const text = JSON.stringify(items);

    const { text: out, applied } = jsonSummaryStage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    expect(out.length).toBeLessThan(text.length);

    const parsed = JSON.parse(out) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(6); // 5 kept items + 1 collapse note
    expect(parsed[0]).toEqual({ id: 0, name: 'item-0', active: true });
    expect(parsed[4]).toEqual({ id: 4, name: 'item-4', active: true });
    expect(String(parsed[5])).toContain('495 more');
    expect(String(parsed[5])).toContain(`read_more("${ctx.fullHandle}")`);
  });

  it('does not collapse a long but heterogeneous array', () => {
    const store = new ArtifactStore();
    const items: unknown[] = [];
    for (let i = 0; i < 20; i++) {
      items.push(i % 4 === 0 ? i : i % 4 === 1 ? `str-${i}` : i % 4 === 2 ? { odd: 'shape', i } : [i, i]);
    }
    const text = JSON.stringify(items);

    const { text: out, applied } = jsonSummaryStage.apply({ text }, DEFAULT_POLICY, store, ctx);

    const parsed = JSON.parse(out) as unknown[];
    expect(parsed).toHaveLength(20);
    expect(out).not.toContain('more items with same shape');
    // applied may still be true/false depending on incidental size changes from re-serialization,
    // but the array itself must be untouched in shape.
    void applied;
  });

  it('leaves non-JSON text alone (applied: false)', () => {
    const store = new ArtifactStore();
    const text = 'This is definitely not JSON, just plain prose output from a tool.';

    const { text: out, applied } = jsonSummaryStage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(false);
    expect(out).toBe(text);
  });

  it('truncates long string values to 200 chars plus a total-length marker', () => {
    const store = new ArtifactStore();
    const longString = 'x'.repeat(1000);
    const text = JSON.stringify({ description: longString });

    const { text: out, applied } = jsonSummaryStage.apply({ text }, DEFAULT_POLICY, store, ctx);

    expect(applied).toBe(true);
    const parsed = JSON.parse(out) as { description: string };
    expect(parsed.description.startsWith('x'.repeat(200))).toBe(true);
    expect(parsed.description).toContain('1000 chars total');
    expect(parsed.description.length).toBeLessThan(longString.length);
  });

  it('skips summarization entirely when policy.jsonSummary is false', () => {
    const store = new ArtifactStore();
    const items = Array.from({ length: 500 }, (_, i) => ({ id: i, name: `item-${i}` }));
    const text = JSON.stringify(items);
    const policy = { ...DEFAULT_POLICY, jsonSummary: false };

    const { text: out, applied } = jsonSummaryStage.apply({ text }, policy, store, ctx);

    expect(applied).toBe(false);
    expect(out).toBe(text);
  });
});
