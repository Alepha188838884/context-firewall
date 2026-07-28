import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
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
    // A single-case run of one repeated char - since the A3 fix to stripBase64Stage requires
    // upper+lower+digit before it will treat a run as base64, this is left untouched by that
    // stage and exercises the truncate stage specifically.
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
    // truncateStage's own annotation already references the handle - A1's fallback must not
    // append a second, redundant reference on top of it.
    expect((text.match(/read_more\(/g) ?? []).length).toBe(1);

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

  describe('regression (A1): fullHandle fallback when no stage embeds a read_more() reference', () => {
    function navItem(i: number): string {
      return `<div class="nav-item" data-id="nav-${i}"><li><a href="/page${i}" title="Navigate to page ${i}">Page Number ${i} Link Text Here</a></li></div>`;
    }
    function paragraph(i: number): string {
      return `<div class="content-block" data-block-id="block-${i}"><p style="margin:0;">This is paragraph number ${i} with some reasonably long placeholder text to pad out the content of the page for testing purposes.</p></div>`;
    }
    function bigHtmlFixture(): string {
      const navItems = Array.from({ length: 40 }, (_, i) => navItem(i)).join('\n');
      const paragraphs = Array.from({ length: 40 }, (_, i) => paragraph(i)).join('\n');
      return `<!DOCTYPE html>\n<html>\n<body>\n<nav class="main-nav"><ul>${navItems}</ul></nav>\n<div class="content"><h1>Main Heading</h1>${paragraphs}</div>\n</body>\n</html>`;
    }

    it('appends a fallback annotation when htmlToMarkdown alone brings text under budget (truncate never runs)', () => {
      const store = new ArtifactStore();
      const logger = mockLogger();
      const html = bigHtmlFixture();
      const policy = policyWithBudget(2500); // budget = 8750 chars

      const { result: out, stats } = runPipeline(textResult(html), policy, store, ctx, logger);

      expect(stats.bypassed).toBeNull();
      expect(stats.stagesApplied).toContain('htmlToMarkdown');
      expect(stats.stagesApplied).not.toContain('truncate');
      expect(stats.fullHandle).toBeDefined();

      const outText = firstText(out);
      expect(outText).toContain(`read_more("${stats.fullHandle}")`);
      expect(outText).toContain('[Compressed');
      expect(store.get(stats.fullHandle as string)?.data).toBe(html);
    });

    it('appends a fallback annotation when jsonSummary alone (long-string truncation, not array collapse) brings text under budget', () => {
      const store = new ArtifactStore();
      const logger = mockLogger();
      const original = { description: 'a'.repeat(3000), notes: 'b'.repeat(3000), details: 'c'.repeat(3000) };
      const text = JSON.stringify(original);
      const policy = policyWithBudget(1000); // budget = 3500 chars

      const { result: out, stats } = runPipeline(textResult(text), policy, store, ctx, logger);

      expect(stats.bypassed).toBeNull();
      expect(stats.stagesApplied).toContain('jsonSummary');
      expect(stats.stagesApplied).not.toContain('truncate');
      expect(stats.fullHandle).toBeDefined();

      const outText = firstText(out);
      expect(outText).toContain(`read_more("${stats.fullHandle}")`);
      expect(outText).toContain('[Compressed');
      expect(store.get(stats.fullHandle as string)?.data).toBe(text);
    });

    it('appends a fallback annotation when stripBase64 alone brings text under budget, so the full original (not just the stripped blob) stays retrievable', () => {
      const store = new ArtifactStore();
      const logger = mockLogger();
      const blob = Buffer.from(randomBytes(4000)).toString('base64');
      const text = `Result payload:\n${blob}\nEnd of payload.`;
      const policy = policyWithBudget(100); // budget = 350 chars

      const { result: out, stats } = runPipeline(textResult(text), policy, store, ctx, logger);

      expect(stats.bypassed).toBeNull();
      expect(stats.stagesApplied).toEqual(['stripBase64']);
      expect(stats.fullHandle).toBeDefined();

      const outText = firstText(out);
      // The blob's own (different) handle is still there, for retrieving just the blob...
      expect(outText).toContain('[binary data removed:');
      // ...but the fallback must additionally point at fullHandle, which resolves to the
      // complete original text (prefix + blob + suffix), not just the stripped binary chunk.
      expect(outText).toContain(`read_more("${stats.fullHandle}")`);
      expect(store.get(stats.fullHandle as string)?.data).toBe(text);
    });
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

  // Regression (Finding 4, 2026-07-28 P1-1 github benchmark, real-world shape): a large JSON
  // array (github/list_issues-shaped) whose first item's title contains an ordinary word like
  // "failure" used to trip isSecuritySensitive's keyword scan and bypass compression entirely,
  // sending the caller a hard-truncated raw-JSON blob instead of a jsonSummary-compressed one.
  it('regression (Finding 4): large JSON containing "failure" in the first 500 chars still runs full compression, not security bypass', () => {
    const store = new ArtifactStore();
    const logger = mockLogger();
    const issues = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      title: i === 0 ? 'Test assertion that it can never record a failure in CI' : `Issue number ${i}`,
      body: 'Some ordinary issue body text that repeats a bit to add bulk. '.repeat(30),
      state: 'open',
    }));
    const text = JSON.stringify(issues);
    // sanity: the keyword really is within the scanned prefix
    expect(text.slice(0, 500)).toMatch(/failure/);
    const policy = policyWithBudget(2000); // budget = 7000 chars, well under the full payload

    const { result: out, stats } = runPipeline(textResult(text), policy, store, ctx, logger);

    expect(stats.bypassed).toBeNull();
    expect(stats.stagesApplied).toContain('jsonSummary');

    const outText = firstText(out);
    // still valid, retrievable JSON-ish output (jsonSummary keeps the structure parseable)
    expect(() => JSON.parse(outText.split('\n\n[Compressed')[0] ?? outText)).not.toThrow();
  });
});
