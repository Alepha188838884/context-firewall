import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLlmSummaryStage } from '../../src/pipeline/llm-summary.js';
import { runPipeline } from '../../src/pipeline/index.js';
import { truncateStage } from '../../src/pipeline/truncate.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { DEFAULT_POLICY } from '../../src/config.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CompressionPolicy, LlmConfig } from '../../src/types.js';
import type { Logger } from '../../src/log.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

function policyWithBudget(maxOutputTokens: number, overrides: Partial<CompressionPolicy> = {}): CompressionPolicy {
  return { ...DEFAULT_POLICY, maxOutputTokens, llmSummary: true, ...overrides };
}

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return { baseUrl: 'https://api.example.com/v1/', apiKey: 'test-key', model: 'test-model', ...overrides };
}

function okFetchResponse(content: string) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

const ctx = { server: 'srv', tool: 'tool', fullHandle: 'handle-123' };
const store = new ArtifactStore();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLlmSummaryStage', () => {
  it('does not call fetch and returns applied:false when policy.llmSummary is off', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const stage = createLlmSummaryStage(llmConfig());
    const policy = policyWithBudget(100, { llmSummary: false });

    const out = await stage.apply({ text: 'a'.repeat(500) }, policy, store, ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toEqual({ text: 'a'.repeat(500), applied: false });
  });

  it('does not call fetch and no-ops when text is under budget', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const stage = createLlmSummaryStage(llmConfig());
    const policy = policyWithBudget(2000); // budget = 7000 chars

    const out = await stage.apply({ text: 'short text' }, policy, store, ctx);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toEqual({ text: 'short text', applied: false });
  });

  it('happy path: returns summary + annotation, and sends the expected request', async () => {
    let capturedUrl: string | undefined;
    let capturedOpts: RequestInit | undefined;
    const fetchSpy = vi.fn(async (url: string, opts: RequestInit) => {
      capturedUrl = url;
      capturedOpts = opts;
      return okFetchResponse('This is the compressed summary.');
    });
    vi.stubGlobal('fetch', fetchSpy);

    const stage = createLlmSummaryStage(llmConfig());
    const policy = policyWithBudget(100); // budget = 350 chars
    const input = { text: 'a'.repeat(500) };

    const out = await stage.apply(input, policy, store, ctx);

    expect(out.applied).toBe(true);
    expect(out.text).toContain('This is the compressed summary.');
    expect(out.text).toContain('test-model');
    expect(out.text).toContain(`${input.text.length}`);
    expect(out.text).toContain(`read_more("${ctx.fullHandle}")`);

    expect(capturedUrl).toBe('https://api.example.com/v1/chat/completions');
    expect(capturedOpts?.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer test-key',
    });
    const body = JSON.parse(capturedOpts?.body as string);
    expect(body.model).toBe('test-model');
    expect(body.max_tokens).toBe(policy.maxOutputTokens);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    expect(body.messages[1].content).toContain(input.text);
  });

  it('non-2xx response leaves input unchanged, applied false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    const stage = createLlmSummaryStage(llmConfig());
    const policy = policyWithBudget(100);
    const input = { text: 'b'.repeat(500) };

    const out = await stage.apply(input, policy, store, ctx);

    expect(out).toEqual({ text: input.text, applied: false });
  });

  it('abort/timeout leaves input unchanged, applied false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, opts: RequestInit) =>
          new Promise((_resolve, reject) => {
            opts.signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError'))
            );
          })
      )
    );
    const stage = createLlmSummaryStage(llmConfig({ timeoutMs: 20 }));
    const policy = policyWithBudget(100);
    const input = { text: 'c'.repeat(500) };

    const out = await stage.apply(input, policy, store, ctx);

    expect(out).toEqual({ text: input.text, applied: false });
  });

  it('res.json() rejecting (malformed JSON) leaves input unchanged, applied false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => {
          throw new Error('malformed JSON');
        },
      }))
    );
    const stage = createLlmSummaryStage(llmConfig());
    const policy = policyWithBudget(100);
    const input = { text: 'd'.repeat(500) };

    const out = await stage.apply(input, policy, store, ctx);

    expect(out).toEqual({ text: input.text, applied: false });
  });

  it('empty/whitespace content leaves input unchanged, applied false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okFetchResponse('   ')));
    const stage = createLlmSummaryStage(llmConfig());
    const policy = policyWithBudget(100);
    const input = { text: 'e'.repeat(500) };

    const out = await stage.apply(input, policy, store, ctx);

    expect(out).toEqual({ text: input.text, applied: false });
  });

  it('maxInputChars clamps the sent text and the annotation notes head-truncation', async () => {
    let capturedBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return okFetchResponse('summary');
      })
    );
    const stage = createLlmSummaryStage(llmConfig({ maxInputChars: 1000 }));
    const policy = policyWithBudget(100); // budget = 350 chars
    const input = { text: 'x'.repeat(1000) + 'SHOULD_NOT_APPEAR' + 'y'.repeat(4000) };

    const out = await stage.apply(input, policy, store, ctx);

    expect(capturedBody).toBeDefined();
    expect(capturedBody as string).not.toContain('SHOULD_NOT_APPEAR');
    const body = JSON.parse(capturedBody as string);
    expect(body.messages[1].content).toContain('x'.repeat(1000));
    expect(out.applied).toBe(true);
    expect(out.text).toContain('head-truncated to 1000 chars');
  });

  it('hard cap: maxInputChars far above 400,000 still clamps sent text to 400,000 chars', async () => {
    let capturedBody: string | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: RequestInit) => {
        capturedBody = opts.body as string;
        return okFetchResponse('summary');
      })
    );
    const stage = createLlmSummaryStage(llmConfig({ maxInputChars: 999_999_999 }));
    const policy = policyWithBudget(100);
    const input = { text: 'p'.repeat(400_000) + 'SHOULD_NOT_APPEAR' + 'q'.repeat(10_000) };

    const out = await stage.apply(input, policy, store, ctx);

    expect(capturedBody).toBeDefined();
    expect(capturedBody as string).not.toContain('SHOULD_NOT_APPEAR');
    expect(out.applied).toBe(true);
    expect(out.text).toContain('head-truncated to 400000 chars');
  });
});

describe('runPipeline + llm summary stage: security bypass never calls fetch', () => {
  it('does not call fetch for a security-sensitive isError result even with llmSummary enabled', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const logger = mockLogger();
    const llmStage = createLlmSummaryStage(llmConfig());
    const result = textResult('Permission denied for this operation.', true);
    const policy = policyWithBudget(2000);

    const { stats } = await runPipeline(result, policy, new ArtifactStore(), { server: 'srv', tool: 'tool' }, logger, [
      llmStage,
      truncateStage,
    ]);

    expect(stats.bypassed).toBe('security');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not call fetch for a large security-sensitive isError result over the hard limit either (still truncate-only)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const logger = mockLogger();
    const llmStage = createLlmSummaryStage(llmConfig());
    const text = `Error: request failed. ${'x'.repeat(60000)}`;
    const result = textResult(text);
    const policy = policyWithBudget(100);

    const { stats } = await runPipeline(result, policy, new ArtifactStore(), { server: 'srv', tool: 'tool' }, logger, [
      llmStage,
      truncateStage,
    ]);

    expect(stats.bypassed).toBe('security');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
