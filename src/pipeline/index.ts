import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CompressionPolicy, CallStats, PipelineStage } from '../types.js';
import type { ArtifactStore } from '../artifacts.js';
import type { Logger } from '../log.js';
import { isSecuritySensitive } from './safety.js';
import { truncateStage, budgetChars } from './truncate.js';
import { stripBase64Stage } from './base64.js';
import { htmlToMarkdownStage } from './html.js';
import { jsonSummaryStage } from './json-summary.js';

// Stage order for the normal compression path: strip binary blobs first, then convert HTML
// markup, then collapse repetitive JSON structure, then truncate whatever's left over budget.
export const DEFAULT_STAGES: PipelineStage[] = [
  stripBase64Stage,
  htmlToMarkdownStage,
  jsonSummaryStage,
  truncateStage,
];

// Even bypassed-for-safety content gets truncated past this size, so a single runaway
// error dump can't blow out the caller's context.
const SECURITY_HARD_LIMIT_CHARS = 50_000;

type ContentBlock = CallToolResult['content'][number];

function extractText(content: ContentBlock[]): { text: string; firstTextIndex: number } {
  const parts: string[] = [];
  let firstTextIndex = -1;
  content.forEach((block, i) => {
    if (block.type === 'text') {
      parts.push(block.text);
      if (firstTextIndex === -1) {
        firstTextIndex = i;
      }
    }
  });
  return { text: parts.join('\n'), firstTextIndex };
}

// Replaces the first text block with the (possibly rewritten) merged text, drops any
// subsequent text blocks (already folded into the merge), and leaves every non-text block
// in its original relative position.
function rebuildContent(content: ContentBlock[], firstTextIndex: number, newText: string): ContentBlock[] {
  const rebuilt: ContentBlock[] = [];
  let replaced = false;
  content.forEach((block, i) => {
    if (block.type === 'text') {
      if (i === firstTextIndex) {
        rebuilt.push({ ...block, text: newText });
        replaced = true;
      }
      // subsequent text blocks are dropped - already merged into newText
      return;
    }
    rebuilt.push(block);
  });
  if (!replaced) {
    rebuilt.unshift({ type: 'text', text: newText });
  }
  return rebuilt;
}

export async function runPipeline(
  result: CallToolResult,
  policy: CompressionPolicy,
  store: ArtifactStore,
  ctx: { server: string; tool: string },
  logger: Logger,
  stages: PipelineStage[] = DEFAULT_STAGES
): Promise<{ result: CallToolResult; stats: CallStats }> {
  const content = (result.content ?? []) as ContentBlock[];
  const { text: originalText, firstTextIndex } = extractText(content);
  const charsBefore = originalText.length;

  const baseStats = { server: ctx.server, tool: ctx.tool, charsBefore };

  if (policy.bypass) {
    return {
      result,
      stats: { ...baseStats, charsAfter: charsBefore, stagesApplied: [], bypassed: 'policy' },
    };
  }

  if (isSecuritySensitive(result, originalText)) {
    if (charsBefore <= SECURITY_HARD_LIMIT_CHARS) {
      return {
        result,
        stats: { ...baseStats, charsAfter: charsBefore, stagesApplied: [], bypassed: 'security' },
      };
    }

    // Security-relevant but huge: still truncate, with an explicit marker saying why.
    const fullHandle = store.put(originalText, { server: ctx.server, tool: ctx.tool });
    const budget = budgetChars(policy.maxOutputTokens);
    const kept = Math.max(0, Math.floor(budget - 200));
    const keptText = originalText.slice(0, kept);
    const annotation = `\n\n[security-relevant output truncated for length — full text: read_more("${fullHandle}", ${kept})]`;
    const newText = keptText + annotation;

    return {
      result: { ...result, content: rebuildContent(content, firstTextIndex, newText) },
      stats: { ...baseStats, charsAfter: newText.length, stagesApplied: [], bypassed: 'security', fullHandle },
    };
  }

  if (charsBefore <= budgetChars(policy.maxOutputTokens)) {
    return {
      result,
      stats: { ...baseStats, charsAfter: charsBefore, stagesApplied: [], bypassed: 'small' },
    };
  }

  const fullHandle = store.put(originalText, { server: ctx.server, tool: ctx.tool });
  let current: { text: string; mimeHint?: 'json' | 'html' | 'text' } = { text: originalText };
  let stagesApplied: string[] = [];

  try {
    for (const stage of stages) {
      const out = await stage.apply(current, policy, store, { server: ctx.server, tool: ctx.tool, fullHandle });
      if (out.applied) {
        stagesApplied.push(stage.name);
      }
      current = { text: out.text, mimeHint: current.mimeHint };
    }
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error(`pipeline stage threw, falling back to truncate-only: ${message}`);
    const fallback = await truncateStage.apply(
      { text: originalText },
      policy,
      store,
      { server: ctx.server, tool: ctx.tool, fullHandle }
    );
    current = { text: fallback.text };
    stagesApplied = fallback.applied ? [truncateStage.name] : [];
  }

  // Every stage that writes a fullHandle reference into the text does so from its own
  // annotation (truncateStage's marker, jsonSummary's array-collapse note). When compression
  // instead comes entirely from stages that don't embed that reference (htmlToMarkdown,
  // jsonSummary's object/string trimming, stripBase64 without a subsequent truncate), the
  // caller is left with no way to retrieve the full original text. Append a fallback pointer
  // whenever that's the case.
  if (stagesApplied.length > 0 && !current.text.includes(fullHandle)) {
    const charsAfter = current.text.length;
    current = {
      text: `${current.text}\n\n[Compressed ${charsBefore} → ${charsAfter} chars. Full output: read_more("${fullHandle}")]`,
      mimeHint: current.mimeHint,
    };
  }

  return {
    result: { ...result, content: rebuildContent(content, firstTextIndex, current.text) },
    stats: { ...baseStats, charsAfter: current.text.length, stagesApplied, bypassed: null, fullHandle },
  };
}
