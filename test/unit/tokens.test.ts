import { describe, it, expect, vi, afterEach } from 'vitest';
import { estimateTokens, TokenCounter } from '../../src/tokens.js';
import type { Logger } from '../../src/log.js';

function mockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

describe('estimateTokens', () => {
  it('estimates ceil(chars / 3.5)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abc')).toBe(1); // 3/3.5 -> ceil 0.86 -> 1
    expect(estimateTokens('a'.repeat(7))).toBe(2); // 7/3.5 = 2
    expect(estimateTokens('a'.repeat(35))).toBe(10); // 35/3.5 = 10
  });
});

describe('TokenCounter', () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
    }
    vi.unstubAllGlobals();
  });

  it('uses estimation when no API key is set', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const logger = mockLogger();
    const counter = new TokenCounter(logger);

    expect(counter.isExact()).toBe(false);
    await expect(counter.count('hello world')).resolves.toBe(estimateTokens('hello world'));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('calls the count_tokens API when a key is set, and returns its input_tokens', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ input_tokens: 42 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const logger = mockLogger();
    const counter = new TokenCounter(logger);

    expect(counter.isExact()).toBe(true);
    await expect(counter.count('hello world')).resolves.toBe(42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('sk-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body as string) as { model: string; messages: unknown[] };
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.messages).toEqual([{ role: 'user', content: 'hello world' }]);
  });

  it('falls back to estimation and warns once when the API call fails, then stays degraded', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const logger = mockLogger();
    const counter = new TokenCounter(logger);

    const first = await counter.count('hello world');
    expect(first).toBe(estimateTokens('hello world'));
    expect(counter.isExact()).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // Second call should not hit fetch again - permanently degraded.
    const second = await counter.count('another string');
    expect(second).toBe(estimateTokens('another string'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to estimation when the API responds with a non-ok status', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test-key';
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);

    const logger = mockLogger();
    const counter = new TokenCounter(logger);

    await expect(counter.count('hello world')).resolves.toBe(estimateTokens('hello world'));
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
