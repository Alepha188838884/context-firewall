import { randomBytes } from 'node:crypto';

export interface ArtifactMeta {
  server: string;
  tool: string;
  mime?: string;
  totalLength: number;
}

export interface Artifact {
  handle: string;
  data: string;
  createdAt: number;
  meta: ArtifactMeta;
}

export interface ArtifactSlice {
  text: string;
  offset: number;
  length: number;
  totalLength: number;
  hasMore: boolean;
  nextOffset?: number;
}

const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_COUNT = 200;
const DEFAULT_TTL_MS = 30 * 60 * 1000;

export interface ArtifactStoreOptions {
  maxBytes?: number;
  maxCount?: number;
  ttlMs?: number;
}

/**
 * Pure in-memory store for full (pre-truncation) tool outputs, addressed by opaque handles.
 * No IO. Evicts FIFO (insertion order) once over capacity, and lazily reaps expired entries
 * on get()/put().
 */
export class ArtifactStore {
  private readonly store = new Map<string, Artifact>();
  private readonly maxBytes: number;
  private readonly maxCount: number;
  private readonly ttlMs: number;
  private seq = 0;
  private totalBytes = 0;

  constructor(options: ArtifactStoreOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxCount = options.maxCount ?? DEFAULT_MAX_COUNT;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  put(data: string, meta: { server: string; tool: string; mime?: string }): string {
    this.evictExpired();

    const handle = `cf-${this.seq}-${randomBytes(2).toString('hex')}`;
    this.seq++;

    const artifact: Artifact = {
      handle,
      data,
      createdAt: Date.now(),
      meta: { ...meta, totalLength: data.length },
    };

    this.store.set(handle, artifact);
    this.totalBytes += Buffer.byteLength(data, 'utf-8');
    this.evictOverCapacity();

    return handle;
  }

  get(handle: string): Artifact | undefined {
    this.evictExpired();
    return this.store.get(handle);
  }

  slice(handle: string, offset = 0, length = 8000): ArtifactSlice | null {
    const artifact = this.get(handle);
    if (!artifact) {
      return null;
    }

    const totalLength = artifact.data.length;
    if (offset < 0 || offset > totalLength) {
      return null;
    }

    const end = Math.min(offset + length, totalLength);
    const text = artifact.data.slice(offset, end);
    const hasMore = end < totalLength;

    return {
      text,
      offset,
      length: text.length,
      totalLength,
      hasMore,
      ...(hasMore ? { nextOffset: end } : {}),
    };
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [handle, artifact] of this.store) {
      if (now - artifact.createdAt > this.ttlMs) {
        this.remove(handle);
      }
    }
  }

  private evictOverCapacity(): void {
    while (this.store.size > this.maxCount || this.totalBytes > this.maxBytes) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.remove(oldest);
    }
  }

  private remove(handle: string): void {
    const artifact = this.store.get(handle);
    if (!artifact) {
      return;
    }
    this.totalBytes -= Buffer.byteLength(artifact.data, 'utf-8');
    this.store.delete(handle);
  }
}
