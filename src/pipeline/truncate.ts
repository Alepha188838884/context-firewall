import type { PipelineStage } from '../types.js';
import { estimateTokens } from '../tokens.js';

// Chars annotation text reserves so the appended "[Output truncated...]" marker itself
// doesn't blow the budget it's reporting on.
const ANNOTATION_RESERVE_CHARS = 200;

export function budgetChars(maxOutputTokens: number): number {
  return maxOutputTokens * 3.5;
}

export const truncateStage: PipelineStage = {
  name: 'truncate',

  apply(input, policy, _store, ctx) {
    const budget = budgetChars(policy.maxOutputTokens);

    if (input.text.length <= budget) {
      return { text: input.text, applied: false };
    }

    const total = input.text.length;
    const kept = Math.max(0, Math.floor(budget - ANNOTATION_RESERVE_CHARS));
    const keptText = input.text.slice(0, kept);
    const estTokens = estimateTokens(keptText);

    const annotation = `\n\n[Output truncated: showing ${kept} of ${total} chars (~${estTokens} tokens). Full output: read_more("${ctx.fullHandle}", ${kept})]`;

    return { text: keptText + annotation, applied: true };
  },
};
