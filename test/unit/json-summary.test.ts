import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonSummaryStage } from '../../src/pipeline/json-summary.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { DEFAULT_POLICY } from '../../src/config.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

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

  // Regression (Finding 2, 2026-07-13 benchmark): a large *object* whose values are all
  // same-shaped records (e.g. npm registry's "versions" map keyed by version string) was
  // never collapsed, because isHomogeneousObjectArray only looks at array elements.
  describe('regression: homogeneous large-object (map) folding', () => {
    it('collapses a 100-key homogeneous map to the first 5 keys plus a "95 more" note, staying valid JSON', () => {
      const store = new ArtifactStore();
      const versions: Record<string, unknown> = {};
      for (let i = 0; i < 100; i++) {
        versions[`1.0.${i}`] = { name: 'react', version: `1.0.${i}`, main: 'index.js', license: 'MIT' };
      }
      const text = JSON.stringify({ name: 'react', versions });

      const { text: out, applied } = jsonSummaryStage.apply({ text }, DEFAULT_POLICY, store, ctx);

      expect(applied).toBe(true);
      expect(out.length).toBeLessThan(text.length);

      const parsed = JSON.parse(out) as { versions: Record<string, unknown> };
      const versionKeys = Object.keys(parsed.versions);
      expect(versionKeys).toHaveLength(6); // 5 kept keys + 1 collapse note key
      expect(parsed.versions['1.0.0']).toEqual({ name: 'react', version: '1.0.0', main: 'index.js', license: 'MIT' });
      expect(parsed.versions['1.0.4']).toEqual({ name: 'react', version: '1.0.4', main: 'index.js', license: 'MIT' });
      expect(String(parsed.versions['…'])).toContain('95 more keys with same value shape');
      expect(String(parsed.versions['…'])).toContain(`read_more("${ctx.fullHandle}")`);
    });

    it('does not collapse a large object whose values have heterogeneous shapes', () => {
      const store = new ArtifactStore();
      const map: Record<string, unknown> = {};
      for (let i = 0; i < 30; i++) {
        map[`key-${i}`] =
          i % 3 === 0 ? { a: i } : i % 3 === 1 ? { b: i, c: i, d: i } : { totally: 'different', shape: true, i };
      }
      const text = JSON.stringify({ map });

      const { text: out } = jsonSummaryStage.apply({ text }, DEFAULT_POLICY, store, ctx);

      const parsed = JSON.parse(out) as { map: Record<string, unknown> };
      expect(Object.keys(parsed.map)).toHaveLength(30);
      expect(out).not.toContain('more keys with same value shape');
    });

    it('does not collapse an object with 20 or fewer keys, even if homogeneous', () => {
      const store = new ArtifactStore();
      const map: Record<string, unknown> = {};
      for (let i = 0; i < 20; i++) {
        map[`key-${i}`] = { a: i, b: i };
      }
      const text = JSON.stringify({ map });

      const { text: out } = jsonSummaryStage.apply({ text }, DEFAULT_POLICY, store, ctx);

      const parsed = JSON.parse(out) as { map: Record<string, unknown> };
      expect(Object.keys(parsed.map)).toHaveLength(20);
      expect(out).not.toContain('more keys with same value shape');
    });

    it('achieves >90% reduction on a real npm-registry-shaped fixture (versions map)', () => {
      const store = new ArtifactStore();
      const text = readFileSync(join(__dirname, '../integration/fixtures/npm-react-shape.json'), 'utf-8');

      const { text: out, applied } = jsonSummaryStage.apply({ text }, DEFAULT_POLICY, store, ctx);

      expect(applied).toBe(true);
      // still valid JSON
      expect(() => JSON.parse(out)).not.toThrow();
      const ratio = 1 - out.length / text.length;
      expect(ratio).toBeGreaterThan(0.9);
    });
  });
});
