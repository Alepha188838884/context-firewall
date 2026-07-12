import type { Logger } from './log.js';

const ANTHROPIC_COUNT_TOKENS_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const ANTHROPIC_VERSION = '2023-06-01';
const MODEL = 'claude-sonnet-5';

/**
 * Fast synchronous token estimate, chars/3.5. Used wherever an async API round-trip isn't
 * worth it (e.g. truncation budget annotations).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/**
 * Exact token counts via the Anthropic count_tokens API when ANTHROPIC_API_KEY is set;
 * falls back to estimateTokens() otherwise. If the API call ever fails, logs a warning once
 * and permanently degrades to estimation for the lifetime of this instance.
 */
export class TokenCounter {
  private readonly apiKey: string | undefined;
  private readonly logger: Logger;
  private degraded = false;

  constructor(logger: Logger) {
    this.apiKey = process.env.ANTHROPIC_API_KEY;
    this.logger = logger;
  }

  isExact(): boolean {
    return Boolean(this.apiKey) && !this.degraded;
  }

  async count(text: string): Promise<number> {
    if (!this.apiKey || this.degraded) {
      return estimateTokens(text);
    }

    try {
      const res = await fetch(ANTHROPIC_COUNT_TOKENS_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: [{ role: 'user', content: text }],
        }),
      });

      if (!res.ok) {
        throw new Error(`count_tokens API returned HTTP ${res.status}`);
      }

      const data = (await res.json()) as { input_tokens: number };
      return data.input_tokens;
    } catch (err) {
      this.degraded = true;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`token count API failed, permanently falling back to estimation: ${message}`);
      return estimateTokens(text);
    }
  }
}
