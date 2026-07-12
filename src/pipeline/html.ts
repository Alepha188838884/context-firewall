import TurndownService from 'turndown';
import type { PipelineStage } from '../types.js';

// Constructing TurndownService has real cost, so share a single instance across calls.
let turndownInstance: TurndownService | undefined;

function getTurndown(): TurndownService {
  if (!turndownInstance) {
    turndownInstance = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' });
  }
  return turndownInstance;
}

const DOCTYPE_OR_HTML_TAG_PATTERN = /<html|<!doctype html/i;
const TAG_PATTERN = /<[a-z][a-z0-9-]*[\s>]/gi;
const STRUCTURAL_TAG_PATTERN = /<div|<p|<table|<body|<span|<a[\s>]/i;
const MIN_TAG_DENSITY = 10;

// Deliberately conservative: sooner miss real HTML than mangle plain text that happens to
// contain a handful of angle brackets.
function looksLikeHtml(text: string): boolean {
  if (DOCTYPE_OR_HTML_TAG_PATTERN.test(text)) {
    return true;
  }
  const tagMatches = text.match(TAG_PATTERN);
  return Boolean(tagMatches && tagMatches.length >= MIN_TAG_DENSITY && STRUCTURAL_TAG_PATTERN.test(text));
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
