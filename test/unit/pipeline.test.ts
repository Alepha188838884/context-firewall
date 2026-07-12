import { describe, it, expect, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { runPipeline } from '../../src/pipeline/index.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { DEFAULT_POLICY } from '../../src/config.js';
import type { CompressionPolicy, PipelineStage } from '../../src/types.js';
import type { Logger } from '../../src/log.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

function policyWithBudget(maxOutputTokens: number, overrides: Partial<CompressionPolicy> = {}): CompressionPolicy {
  return { ...DEFAULT_POLICY, maxOutputTokens, ...overrides };
}

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

const ctx = { server: 'srv', tool: 'tool' };

describe('runPipeline', () => {
  it('bypasses small outputs unchanged, marking bypassed: small', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const result = textResult('short output');
    const policy = policyWithBudget(2000); // budget = 7000 chars, way over 13 chars

    const { result: out, stats } = runPipeline(result, policy, store, ctx, logger);

    expect(out).toBe(result); // returned unchanged
    expect(stats.bypassed).toBe('small');
    expect(stats.charsBefore).toBe('short output'.length);
    expect(stats.charsAfter).toBe('short output'.length);
    expect(stats.stagesApplied).toEqual([]);
  });

  it('truncates output over budget, appending a read_more annotation with a valid handle and offset', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const longText = 'x'.repeat(10000);
    const result = textResult(longText);
    const policy = policyWithBudget(100); // budget = 350 chars

    const { result: out, stats } = runPipeline(result, policy, store, ctx, logger);

    expect(stats.bypassed).toBeNull();
    expect(stats.stagesApplied).toEqual(['truncate']);
    expect(stats.charsBefore).toBe(10000);
    expect(stats.fullHandle).toBeDefined();

    const text = firstText(out);
    expect(text).toContain('[Output truncated: showing');
    expect(text).toContain(`read_more("${stats.fullHandle}"`);
    expect(text.length).toBeLessThan(10000);

    // The handle must resolve to the full original text via the artifact store.
    const artifact = store.get(stats.fullHandle as string);
    expect(artifact?.data).toBe(longText);
    expect(artifact?.data.length).toBe(10000);
  });

  it('does not compress isError results (safety bypass), even if short enough to otherwise pass through', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const result = textResult('Permission denied for this operation.', true);
    const policy = policyWithBudget(2000);

    const { result: out, stats } = runPipeline(result, policy, store, ctx, logger);

    expect(out).toBe(result);
    expect(stats.bypassed).toBe('security');
    expect(stats.fullHandle).toBeUndefined();
  });

  it('does not compress security-relevant text under 50k chars, even over the token budget', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const text = `Warning: something failed. ${'x'.repeat(5000)}`;
    const result = textResult(text);
    const policy = policyWithBudget(10); // budget = 35 chars, far under text length

    const { result: out, stats } = runPipeline(result, policy, store, ctx, logger);

    expect(out).toBe(result);
    expect(firstText(out)).toBe(text);
    expect(stats.bypassed).toBe('security');
  });

  it('still explicitly truncates security-relevant text over 50k chars, with a distinct annotation and a working handle', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const text = `Error: request failed. ${'x'.repeat(60000)}`;
    const result = textResult(text);
    const policy = policyWithBudget(100); // budget = 350 chars

    const { result: out, stats } = runPipeline(result, policy, store, ctx, logger);

    expect(stats.bypassed).toBe('security');
    expect(stats.fullHandle).toBeDefined();
    expect(stats.charsBefore).toBe(text.length);
    expect(stats.charsAfter).toBeLessThan(text.length);

    const compressedText = firstText(out);
    expect(compressedText).toContain('security-relevant output truncated for length');
    expect(compressedText).toContain(`read_more("${stats.fullHandle}"`);

    const artifact = store.get(stats.fullHandle as string);
    expect(artifact?.data).toBe(text);
  });

  it('passes policy.bypass straight through unchanged, regardless of size', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const longText = 'y'.repeat(100000);
    const result = textResult(longText);
    const policy = policyWithBudget(50, { bypass: true });

    const { result: out, stats } = runPipeline(result, policy, store, ctx, logger);

    expect(out).toBe(result);
    expect(firstText(out)).toBe(longText);
    expect(stats.bypassed).toBe('policy');
    expect(stats.charsAfter).toBe(100000);
  });

  it('falls back to truncate-only and does not lose data when a stage throws', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const longText = 'z'.repeat(10000);
    const result = textResult(longText);
    const policy = policyWithBudget(100); // budget = 350 chars

    const throwingStage: PipelineStage = {
      name: 'boom',
      apply: () => {
        throw new Error('stage exploded');
      },
    };

    const { result: out, stats } = runPipeline(result, policy, store, ctx, logger, [throwingStage]);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const text = firstText(out);
    // Fallback still ran truncate, so we get a bounded, non-empty, annotated result -
    // the bug in "boom" must not swallow the output entirely.
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('[Output truncated: showing');
    expect(stats.stagesApplied).toEqual(['truncate']);
    expect(stats.fullHandle).toBeDefined();
    expect(store.get(stats.fullHandle as string)?.data).toBe(longText);
  });

  it('leaves non-text content blocks untouched and in their original relative position', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const longText = 'w'.repeat(10000);
    const result: CallToolResult = {
      content: [
        { type: 'image', data: 'base64data', mimeType: 'image/png' },
        { type: 'text', text: longText },
      ],
    };
    const policy = policyWithBudget(100);

    const { result: out } = runPipeline(result, policy, store, ctx, logger);

    expect(out.content[0]?.type).toBe('image');
    expect(out.content[1]?.type).toBe('text');
  });
});
