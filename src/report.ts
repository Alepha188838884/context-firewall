import type { CallStats } from './types.js';

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
 *
 * All counts are chars/3.5 estimates, never exact - there is no code path in this project
 * that sends tool output content to an external API to get an exact count (that would itself
 * violate the safety red line above), so the report always labels itself "(estimated)".
 */
export class SessionReport {
  private readonly stats: SessionStats;

  constructor() {
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
    };
  }

  /**
   * Per-(server, tool) savings, summed across every recorded call to that tool, sorted by
   * savings descending. Tools that never saved anything (pure passthrough) are excluded.
   */
  private topToolsBySavings(limit = 3): { server: string; tool: string; savedTokens: number; calls: number }[] {
    const agg = new Map<string, { server: string; tool: string; savedTokens: number; calls: number }>();
    for (const call of this.stats.calls) {
      const key = `${call.server}/${call.tool}`;
      const saved = Math.max(0, tokensForChars(call.charsBefore) - tokensForChars(call.charsAfter));
      const entry = agg.get(key) ?? { server: call.server, tool: call.tool, savedTokens: 0, calls: 0 };
      entry.savedTokens += saved;
      entry.calls += 1;
      agg.set(key, entry);
    }
    return [...agg.values()]
      .filter((entry) => entry.savedTokens > 0)
      .sort((a, b) => b.savedTokens - a.savedTokens)
      .slice(0, limit);
  }

  /** Unicode box card, suitable for printing to a terminal (stderr). */
  render(): string {
    const s = this.summary();

    const lines = [
      'Context Firewall Session Report (estimated)',
      '',
      `Tools exposed: ${this.stats.downstreamToolCount} -> ${this.stats.exposedToolCount}`,
      `Definition savings: ~${s.defSavings.toLocaleString()} tokens`,
      `Calls: ${s.calls} (${s.compressed} compressed, ${s.passthrough} passthrough)`,
      `Output savings: ~${s.outSavings.toLocaleString()} tokens`,
      `Total savings: ~${s.totalSavings.toLocaleString()} tokens ~= ${s.pctOfContextWindow.toFixed(1)}% of 200K`,
    ];

    const width = Math.max(...lines.map((l) => l.length)) + 2;
    const top = `┌${'─'.repeat(width)}┐`;
    const bottom = `└${'─'.repeat(width)}┘`;
    const body = lines.map((l) => `│ ${l.padEnd(width - 1)}│`).join('\n');
    const card = `${top}\n${body}\n${bottom}`;

    const topTools = this.topToolsBySavings();
    if (topTools.length === 0) {
      return card;
    }

    const toolLines = [
      'Top tools by savings:',
      ...topTools.map(
        (t) => `  ${t.server}/${t.tool}  ~${t.savedTokens.toLocaleString()} tokens saved (${t.calls} calls)`
      ),
    ];

    return `${card}\n\n${toolLines.join('\n')}`;
  }

  /** Same data as render(), formatted as a Markdown table for config.report.markdownPath. */
  renderMarkdown(): string {
    const s = this.summary();

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
    let out = `# Context Firewall Session Report (estimated)\n\n${header}\n${body}\n`;

    const topTools = this.topToolsBySavings();
    if (topTools.length > 0) {
      const toolHeader = '| Tool | Tokens saved | Calls |\n| --- | --- | --- |';
      const toolBody = topTools
        .map((t) => `| ${t.server}/${t.tool} | ~${t.savedTokens.toLocaleString()} | ${t.calls} |`)
        .join('\n');
      out += `\n## Top tools by savings\n\n${toolHeader}\n${toolBody}\n`;
    }

    return out;
  }
}
