import type { LlmConfig, PipelineStage } from '../types.js';
import { budgetChars } from './truncate.js';

// Hard absolute cap on how much input text is ever sent to the LLM, regardless of
// `llm.maxInputChars` — cost/latency protection that config can tighten but never loosen.
const MAX_INPUT_CHARS_HARD_CAP = 400_000;

const DEFAULT_TIMEOUT_MS = 20_000;

const SYSTEM_PROMPT =
  'You compress a tool output for consumption by an AI agent. Preserve concrete facts, numbers, ' +
  'identifiers (IDs, paths, URLs, names), error messages, and structure. Drop boilerplate and ' +
  'repetition. Never invent content not present in the input. Output only the summary.';

export function createLlmSummaryStage(llm: LlmConfig): PipelineStage {
  const url = `${llm.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  return {
    name: 'llmSummary',

    async apply(input, policy, _store, ctx) {
      if (!policy.llmSummary) {
        return { text: input.text, applied: false };
      }

      const budget = budgetChars(policy.maxOutputTokens);
      if (input.text.length <= budget) {
        return { text: input.text, applied: false };
      }

      const maxInput = Math.min(llm.maxInputChars ?? 120_000, MAX_INPUT_CHARS_HARD_CAP);
      const headTruncated = input.text.length > maxInput;
      const sendText = headTruncated ? input.text.slice(0, maxInput) : input.text;

      const targetChars = Math.round(budget * 0.8);
      const userMessage =
        `Compress the following tool output to approximately ${targetChars} characters. ` +
        `Source tool: "${ctx.tool}" on server "${ctx.server}".` +
        (headTruncated ? ' The input below was head-truncated before being sent to you.' : '') +
        `\n\n${sendText}`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), llm.timeoutMs ?? DEFAULT_TIMEOUT_MS);

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${llm.apiKey}`,
          },
          body: JSON.stringify({
            model: llm.model,
            max_tokens: policy.maxOutputTokens,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMessage },
            ],
          }),
          signal: controller.signal,
        });

        if (!res.ok) {
          return { text: input.text, applied: false };
        }

        const json = (await res.json()) as {
          choices?: { message?: { content?: unknown } }[];
        };
        const content = json.choices?.[0]?.message?.content;
        if (typeof content !== 'string' || content.trim().length === 0) {
          return { text: input.text, applied: false };
        }

        const summary = content.trim();
        const annotation =
          `\n\n[LLM summary (${llm.model}) of ${input.text.length} chars` +
          (headTruncated ? `; input head-truncated to ${maxInput} chars before summarization` : '') +
          `. Full original: read_more("${ctx.fullHandle}")]`;

        return { text: summary + annotation, applied: true };
      } catch {
        return { text: input.text, applied: false };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
