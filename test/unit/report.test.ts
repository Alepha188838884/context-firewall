import { describe, it, expect } from 'vitest';
import { SessionReport } from '../../src/report.js';
import type { CallStats } from '../../src/types.js';

function call(overrides: Partial<CallStats>): CallStats {
  return {
    server: 'srv',
    tool: 'tool',
    charsBefore: 0,
    charsAfter: 0,
    stagesApplied: [],
    bypassed: null,
    ...overrides,
  };
}

describe('SessionReport', () => {
  it('accumulates definition and call stats correctly', () => {
    const report = new SessionReport();
    // rawChars=3500 -> 1000 tokens, exposedChars=350 -> 100 tokens => def savings 900
    report.setDefinitions(3500, 350, 2);
    // compressed call: 7000 chars (2000 tok) -> 350 chars (100 tok) => 1900 tok saved
    report.recordCall(call({ charsBefore: 7000, charsAfter: 350, bypassed: null, stagesApplied: ['truncate'] }));
    // passthrough calls: no char reduction, no savings
    report.recordCall(call({ charsBefore: 100, charsAfter: 100, bypassed: 'small' }));
    report.recordCall(call({ charsBefore: 200, charsAfter: 200, bypassed: 'security' }));

    const rendered = report.render();
    expect(rendered).toContain('Tools exposed: 2 -> 4');
    expect(rendered).toContain('Definition savings: ~900 tokens');
    expect(rendered).toContain('Calls: 3 (1 compressed, 2 passthrough)');
    expect(rendered).toContain('Output savings: ~1,900 tokens');
    expect(rendered).toContain('Total savings: ~2,800 tokens ~= 1.4% of 200K');
  });

  it('render() includes the expected key lines and box border (no calls recorded -> card is the whole output)', () => {
    const report = new SessionReport();
    report.setDefinitions(3500, 350, 2);

    const rendered = report.render();
    expect(rendered).toContain('Context Firewall Session Report (estimated)');
    expect(rendered).toMatch(/^┌─+┐/);
    expect(rendered).toMatch(/└─+┘$/);
    expect(rendered).toContain('Tools exposed:');
    expect(rendered).toContain('Definition savings:');
    expect(rendered).toContain('Output savings:');
    expect(rendered).toContain('Total savings:');
  });

  it('regression (A2): always labels the report "(estimated)" - there is no exact-count code path', () => {
    const report = new SessionReport();
    report.setDefinitions(3500, 350, 2);

    expect(report.render()).toContain('│ Context Firewall Session Report (estimated) ');
    expect(report.renderMarkdown()).toContain('# Context Firewall Session Report (estimated)');
  });

  it('regression (A7): render() uses ASCII "~=" instead of the wide "≈" glyph, so the box border cannot misalign', () => {
    const report = new SessionReport();
    report.setDefinitions(3500, 350, 2);
    report.recordCall(call({ charsBefore: 7000, charsAfter: 350 }));

    const rendered = report.render();
    expect(rendered).not.toContain('≈');
    expect(rendered).toContain('~=');
  });

  it('renderMarkdown() produces the expected table when no calls saved anything (no Top tools section)', () => {
    const report = new SessionReport();
    report.setDefinitions(3500, 350, 2);
    report.recordCall(call({ charsBefore: 100, charsAfter: 100, bypassed: 'small' }));
    report.recordCall(call({ charsBefore: 200, charsAfter: 200, bypassed: 'security' }));

    expect(report.renderMarkdown()).toBe(
      '# Context Firewall Session Report (estimated)\n' +
        '\n' +
        '| Metric | Value |\n' +
        '| --- | --- |\n' +
        '| Tools exposed | 2 → 4 |\n' +
        '| Definition savings | ~900 tokens |\n' +
        '| Calls | 2 (0 compressed, 2 passthrough) |\n' +
        '| Output savings | ~0 tokens |\n' +
        '| Total savings | ~900 tokens (≈ 0.4% of 200K) |\n'
    );
  });

  it('renders without crashing when there have been no calls', () => {
    const report = new SessionReport();
    report.setDefinitions(3500, 350, 2);

    expect(() => report.render()).not.toThrow();
    expect(() => report.renderMarkdown()).not.toThrow();
    expect(report.render()).toContain('Calls: 0 (0 compressed, 0 passthrough)');
    expect(report.render()).toContain('Definition savings: ~900 tokens');
  });

  it('renders without crashing when setDefinitions was never called', () => {
    const report = new SessionReport();

    expect(() => report.render()).not.toThrow();
    expect(report.render()).toContain('Tools exposed: 0 -> 4');
    expect(report.render()).toContain('Definition savings: ~0 tokens');
  });

  it('never leaks fake output/argument content passed via a CallStats object', () => {
    const report = new SessionReport();
    report.setDefinitions(0, 0, 1);

    const secret = 'TOP_SECRET_ARGUMENT_VALUE_password123';
    // Simulate a caller accidentally attaching extra fields to a CallStats-shaped object -
    // recordCall must only ever pull out the known metadata fields.
    const poisoned = {
      server: 'srv',
      tool: 'tool',
      charsBefore: 500,
      charsAfter: 100,
      stagesApplied: ['truncate'],
      bypassed: null,
      output: secret,
      args: { password: secret },
    } as unknown as CallStats;

    report.recordCall(poisoned);

    expect(report.render()).not.toContain(secret);
    expect(report.renderMarkdown()).not.toContain(secret);
  });

  describe('Top tools by savings (design doc §8 report polish)', () => {
    it('render() lists up to 3 tools below the card, sorted by savings descending, excluding tools with zero savings', () => {
      const report = new SessionReport();
      report.setDefinitions(0, 0, 5);
      report.recordCall(call({ server: 'srv', tool: 'toolA', charsBefore: 7000, charsAfter: 0 })); // 2000 tok saved
      report.recordCall(call({ server: 'srv', tool: 'toolB', charsBefore: 3500, charsAfter: 0 })); // 1000 tok saved
      report.recordCall(call({ server: 'srv', tool: 'toolC', charsBefore: 1750, charsAfter: 0 })); // 500 tok saved
      report.recordCall(call({ server: 'srv', tool: 'toolD', charsBefore: 700, charsAfter: 700, bypassed: 'small' })); // 0 saved
      report.recordCall(call({ server: 'srv', tool: 'toolE', charsBefore: 350, charsAfter: 0 })); // 100 tok saved

      const rendered = report.render();
      expect(rendered).toContain('Top tools by savings:');
      expect(rendered).toContain('  srv/toolA  ~2,000 tokens saved (1 calls)');
      expect(rendered).toContain('  srv/toolB  ~1,000 tokens saved (1 calls)');
      expect(rendered).toContain('  srv/toolC  ~500 tokens saved (1 calls)');
      // Capped at 3 and only tools that actually saved something are listed.
      expect(rendered).not.toContain('toolD');
      expect(rendered).not.toContain('toolE');
    });

    it('aggregates savings and call count across multiple calls to the same tool', () => {
      const report = new SessionReport();
      report.setDefinitions(0, 0, 1);
      report.recordCall(call({ server: 'srv', tool: 'toolA', charsBefore: 7000, charsAfter: 0 })); // 2000 tok
      report.recordCall(call({ server: 'srv', tool: 'toolA', charsBefore: 3500, charsAfter: 0 })); // 1000 tok
      report.recordCall(call({ server: 'srv', tool: 'toolA', charsBefore: 700, charsAfter: 700, bypassed: 'small' })); // 0 tok, still a call

      expect(report.render()).toContain('  srv/toolA  ~3,000 tokens saved (3 calls)');
    });

    it('omits the "Top tools by savings" section entirely when no call produced any savings', () => {
      const report = new SessionReport();
      report.setDefinitions(0, 0, 1);
      report.recordCall(call({ charsBefore: 100, charsAfter: 100, bypassed: 'small' }));

      const rendered = report.render();
      expect(rendered).not.toContain('Top tools by savings');
      expect(rendered).toMatch(/└─+┘$/); // card remains the entire (trailing) output
    });

    it('renderMarkdown() adds a matching "Top tools by savings" table when savings exist', () => {
      const report = new SessionReport();
      report.setDefinitions(0, 0, 1);
      report.recordCall(call({ server: 'srv', tool: 'toolA', charsBefore: 7000, charsAfter: 0 })); // 2000 tok

      const markdown = report.renderMarkdown();
      expect(markdown).toContain('## Top tools by savings');
      expect(markdown).toContain('| Tool | Tokens saved | Calls |');
      expect(markdown).toContain('| srv/toolA | ~2,000 | 1 |');
    });

    it('renderMarkdown() omits the table when no call produced any savings', () => {
      const report = new SessionReport();
      report.setDefinitions(0, 0, 1);
      report.recordCall(call({ charsBefore: 100, charsAfter: 100, bypassed: 'small' }));

      expect(report.renderMarkdown()).not.toContain('Top tools by savings');
    });
  });
});
