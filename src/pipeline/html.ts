import TurndownService from 'turndown';
import type { PipelineStage } from '../types.js';
import { looksLikeHtml } from './html-detect.js';
import { looksLikeJson } from './json-detect.js';

// Constructing TurndownService has real cost, so share a single instance across calls.
let turndownInstance: TurndownService | undefined;

function getTurndown(): TurndownService {
  if (!turndownInstance) {
    turndownInstance = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  }
  return turndownInstance;
}

// Turndown is slow on (and gets no value from) huge script/style/svg blobs, so strip them
// before conversion.
const SCRIPT_STYLE_SVG_PATTERN = /<(script|style|svg)[^>]*>[\s\S]*?<\/\1>/gi;

export const htmlToMarkdownStage: PipelineStage = {
  name: 'htmlToMarkdown',

  apply(input, policy) {
    if (!policy.htmlToMarkdown) {
      return { text: input.text, applied: false };
    }

    // JSON API responses (e.g. GitHub issues) often embed raw HTML fragments
    // (<details>/<img>/<table>) inside string fields, which can trip the tag-density
    // heuristic below. Running turndown on the whole document would corrupt the JSON before
    // jsonSummaryStage ever sees it, so valid JSON takes precedence and is left for that stage.
    if (looksLikeJson(input.text)) {
      return { text: input.text, applied: false };
    }

    if (!looksLikeHtml(input.text)) {
      return { text: input.text, applied: false };
    }

    try {
      const cleaned = input.text.replace(SCRIPT_STYLE_SVG_PATTERN, '');
      const markdown = getTurndown().turndown(cleaned);

      if (markdown.length >= input.text.length) {
        return { text: input.text, applied: false };
      }

      return { text: markdown, applied: true };
    } catch {
      return { text: input.text, applied: false };
    }
  },
};
