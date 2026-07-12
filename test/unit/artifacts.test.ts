import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ArtifactStore } from '../../src/artifacts.js';

function meta(overrides: Partial<{ server: string; tool: string; mime?: string }> = {}) {
  return { server: 'srv', tool: 'tool', ...overrides };
}

describe('ArtifactStore', () => {
  describe('put / get', () => {
    it('put returns a cf-<seq>-<hex> handle and get retrieves the artifact', () => {
      const store = new ArtifactStore();
      const handle = store.put('hello world', meta());

      expect(handle).toMatch(/^cf-\d+-[0-9a-f]{4}$/);

      const artifact = store.get(handle);
      expect(artifact).toBeDefined();
      expect(artifact?.data).toBe('hello world');
      expect(artifact?.meta).toEqual({ server: 'srv', tool: 'tool', totalLength: 11 });
      expect(typeof artifact?.createdAt).toBe('number');
    });

    it('assigns monotonically increasing sequence numbers across handles', () => {
      const store = new ArtifactStore();
      const h1 = store.put('a', meta());
      const h2 = store.put('b', meta());
      const seq1 = Number(h1.split('-')[1]);
      const seq2 = Number(h2.split('-')[1]);
      expect(seq2).toBeGreaterThan(seq1);
    });

    it('get returns undefined for an unknown handle', () => {
      const store = new ArtifactStore();
      expect(store.get('cf-999-dead')).toBeUndefined();
    });

    it('preserves an optional mime in meta', () => {
      const store = new ArtifactStore();
      const handle = store.put('<p>hi</p>', meta({ mime: 'html' }));
      expect(store.get(handle)?.meta.mime).toBe('html');
    });
  });

  describe('slice', () => {
    it('returns a page with correct offset/length/totalLength and hasMore=true when more remains', () => {
      const store = new ArtifactStore();
      const data = 'x'.repeat(20000);
      const handle = store.put(data, meta());

      const page = store.slice(handle, 0, 8000);
      expect(page).not.toBeNull();
      expect(page?.text.length).toBe(8000);
      expect(page?.offset).toBe(0);
      expect(page?.length).toBe(8000);
      expect(page?.totalLength).toBe(20000);
      expect(page?.hasMore).toBe(true);
      expect(page?.nextOffset).toBe(8000);
    });

    it('the final page has hasMore=false and no nextOffset', () => {
      const store = new ArtifactStore();
      const data = 'x'.repeat(20000);
      const handle = store.put(data, meta());

      const page = store.slice(handle, 16000, 8000);
      expect(page?.text.length).toBe(4000);
      expect(page?.offset).toBe(16000);
      expect(page?.length).toBe(4000);
      expect(page?.hasMore).toBe(false);
      expect(page?.nextOffset).toBeUndefined();
    });

    it('applies a default offset of 0 and length of 8000', () => {
      const store = new ArtifactStore();
      const data = 'y'.repeat(9000);
      const handle = store.put(data, meta());

      const page = store.slice(handle);
      expect(page?.offset).toBe(0);
      expect(page?.length).toBe(8000);
    });

    it('returns null when the handle does not exist', () => {
      const store = new ArtifactStore();
      expect(store.slice('cf-0-0000')).toBeNull();
    });

    it('returns null when offset is negative or beyond totalLength', () => {
      const store = new ArtifactStore();
      const handle = store.put('short', meta());

      expect(store.slice(handle, -1)).toBeNull();
      expect(store.slice(handle, 100)).toBeNull();
    });

    it('allows an offset exactly at totalLength, returning an empty final page', () => {
      const store = new ArtifactStore();
      const handle = store.put('short', meta());

      const page = store.slice(handle, 5);
      expect(page).not.toBeNull();
      expect(page?.text).toBe('');
      expect(page?.hasMore).toBe(false);
    });
  });

  describe('FIFO eviction', () => {
    it('evicts the oldest entry once maxCount is exceeded', () => {
      const store = new ArtifactStore({ maxCount: 2 });
      const h1 = store.put('a', meta());
      const h2 = store.put('b', meta());
      const h3 = store.put('c', meta());

      expect(store.get(h1)).toBeUndefined();
      expect(store.get(h2)).toBeDefined();
      expect(store.get(h3)).toBeDefined();
    });

    it('evicts the oldest entries once maxBytes is exceeded', () => {
      const store = new ArtifactStore({ maxBytes: 15 });
      const h1 = store.put('x'.repeat(10), meta());
      const h2 = store.put('y'.repeat(10), meta());

      // Adding h2 pushes total bytes to 20 > 15, so h1 (oldest) is evicted.
      expect(store.get(h1)).toBeUndefined();
      expect(store.get(h2)).toBeDefined();
    });
  });

  describe('TTL', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('lazily expires entries older than ttlMs on get()', () => {
      const store = new ArtifactStore({ ttlMs: 1000 });
      const handle = store.put('data', meta());

      vi.advanceTimersByTime(1001);

      expect(store.get(handle)).toBeUndefined();
    });

    it('lazily expires entries older than ttlMs on put()', () => {
      const store = new ArtifactStore({ ttlMs: 1000 });
      const handle = store.put('data', meta());

      vi.advanceTimersByTime(1001);
      store.put('more data', meta());

      expect(store.get(handle)).toBeUndefined();
    });

    it('does not expire entries within ttlMs', () => {
      const store = new ArtifactStore({ ttlMs: 1000 });
      const handle = store.put('data', meta());

      vi.advanceTimersByTime(500);

      expect(store.get(handle)).toBeDefined();
    });
  });
});
