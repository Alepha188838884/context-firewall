import type { CallStats } from './types.js';
import type { TokenCounter } from './tokens.js';

const CONTEXT_WINDOW_TOKENS = 200_000;

// estimateTokens() in tokens.ts operates on text (Math.ceil(text.length / 3.5)). The report
// only ever holds character counts (never the underlying text - see safety red line below),
// so this mirrors that same formula without needing a string to measure.
const CHARS_PER_TOKEN = 3.5;

function tokensForChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface SessionStats {
  startedAt: number;
  downstreamToolCount: number;
  exposedToolCount: number;
  definitionCharsRaw: number;
  definitionCharsExposed: number;
  calls: CallStats[];
}

/**
 * Tracks token savings for one gateway session and renders a shareable summary.
 *
 * Safety red line: this report must never contain call arguments or output content - only
 * server/tool names and character/token counts (design doc §3.2/§5, mirrored from
 * pipeline/safety.ts). recordCall() only retains the metadata fields of CallStats.
 */
export class SessionReport {
  private readonly tokenCounter: TokenCounter;
  private readonly stats: SessionStats;

  constructor(tokenCounter: TokenCounter) {
    this.tokenCounter = tokenCounter;
    this.stats = {
      startedAt: Date.now(),
      downstreamToolCount: 0,
      exposedToolCount: 4,
      definitionCharsRaw: 0,
      definitionCharsExposed: 0,
      calls: [],
    };
  }

  setDefinitions(rawChars: number, exposedChars: number, downstreamToolCount: number): void {
    this.stats.definitionCharsRaw = rawChars;
    this.stats.definitionCharsExposed = exposedChars;
    this.stats.downstreamToolCount = downstreamToolCount;
  }

  recordCall(stats: CallStats): void {
    this.stats.calls.push({
      server: stats.server,
      tool: stats.tool,
      charsBefore: stats.charsBefore,
      charsAfter: stats.charsAfter,
      stagesApplied: stats.stagesApplied,
      bypassed: stats.bypassed,
      fullHandle: stats.fullHandle,
    });
  }

  private definitionSavingsTokens(): number {
    return Math.max(
      0,
      tokensForChars(this.stats.definitionCharsRaw) - tokensForChars(this.stats.definitionCharsExposed)
    );
  }

  private outputSavingsTokens(): number {
    let total = 0;
    for (const call of this.stats.calls) {
      total += Math.max(0, tokensForChars(call.charsBefore) - tokensForChars(call.charsAfter));
    }
    return total;
  }

  private compressedCallCount(): number {
    return this.stats.calls.filter((c) => c.bypassed === null).length;
  }

  private passthroughCallCount(): number {
    return this.stats.calls.filter((c) => c.bypassed !== null).length;
  }

  private summary(): {
    defSavings: number;
    outSavings: number;
    totalSavings: number;
    pctOfContextWindow: number;
    calls: number;
    compressed: number;
    passthrough: number;
    estimated: boolean;
  } {
    const defSavings = this.definitionSavingsTokens();
    const outSavings = this.outputSavingsTokens();
    const totalSavings = defSavings + outSavings;
    return {
      defSavings,
      outSavings,
      totalSavings,
      pctOfContextWindow: (totalSavings / CONTEXT_WINDOW_TOKENS) * 100,
      calls: this.stats.calls.length,
      compressed: this.compressedCallCount(),
      passthrough: this.passthroughCallCount(),
      estimated: !this.tokenCounter.isExact(),
    };
  }

  /** Unicode box card, suitable for printing to a terminal (stderr). */
  render(): string {
    const s = this.summary();
    const titleSuffix = s.estimated ? ' (estimated)' : '';

    const lines = [
      `Context Firewall Session Report${titleSuffix}`,
      '',
      `Tools exposed: ${this.stats.downstreamToolCount} -> ${this.stats.exposedToolCount}`,
      `Definition savings: ~${s.defSavings.toLocaleString()} tokens`,
      `Calls: ${s.calls} (${s.compressed} compressed, ${s.passthrough} passthrough)`,
      `Output savings: ~${s.outSavings.toLocaleString()} tokens`,
      `Total savings: ~${s.totalSavings.toLocaleString()} tokens ≈ ${s.pctOfContextWindow.toFixed(1)}% of 200K`,
    ];

    const width = Math.max(...lines.map((l) => l.length)) + 2;
    const top = `┌${'─'.repeat(width)}┐`;
    const bottom = `└${'─'.repeat(width)}┘`;
    const body = lines.map((l) => `│ ${l.padEnd(width - 1)}│`).join('\n');

    return `${top}\n${body}\n${bottom}`;
  }

  /** Same data as render(), formatted as a Markdown table for config.report.markdownPath. */
  renderMarkdown(): string {
    const s = this.summary();
    const titleSuffix = s.estimated ? ' (estimated)' : '';

    const rows: [string, string][] = [
      ['Tools exposed', `${this.stats.downstreamToolCount} → ${this.stats.exposedToolCount}`],
      ['Definition savings', `~${s.defSavings.toLocaleString()} tokens`],
      ['Calls', `${s.calls} (${s.compressed} compressed, ${s.passthrough} passthrough)`],
      ['Output savings', `~${s.outSavings.toLocaleString()} tokens`],
      [
        'Total savings',
        `~${s.totalSavings.toLocaleString()} tokens (≈ ${s.pctOfContextWindow.toFixed(1)}% of 200K)`,
      ],
    ];

    const header = '| Metric | Value |\n| --- | --- |';
    const body = rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');

    return `# Context Firewall Session Report${titleSuffix}\n\n${header}\n${body}\n`;
  }
}
