import { describe, it, expect, vi, afterEach } from 'vitest';
import { SessionReport } from '../../src/report.js';
import { TokenCounter } from '../../src/tokens.js';
import type { CallStats } from '../../src/types.js';
import type { Logger } from '../../src/log.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ANTHROPIC_API_KEY;
  } else {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  }
});

function estimatedCounter(): TokenCounter {
  delete process.env.ANTHROPIC_API_KEY;
  return new TokenCounter(mockLogger());
}

function exactCounter(): TokenCounter {
  process.env.ANTHROPIC_API_KEY = 'sk-test-key';
  return new TokenCounter(mockLogger());
}

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
    const report = new SessionReport(exactCounter());
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
    expect(rendered).toContain('Total savings: ~2,800 tokens ≈ 1.4% of 200K');
  });

  it('render() includes the expected key lines and box border', () => {
    const report = new SessionReport(estimatedCounter());
    report.setDefinitions(3500, 350, 2);
    report.recordCall(call({ charsBefore: 7000, charsAfter: 350, bypassed: null }));

    const rendered = report.render();
    expect(rendered).toContain('Context Firewall Session Report (estimated)');
    expect(rendered).toMatch(/^┌─+┐/);
    expect(rendered).toMatch(/└─+┘$/);
    expect(rendered).toContain('Tools exposed:');
    expect(rendered).toContain('Definition savings:');
    expect(rendered).toContain('Output savings:');
    expect(rendered).toContain('Total savings:');
  });

  it('render() omits the "(estimated)" suffix when the token counter is exact', () => {
    const report = new SessionReport(exactCounter());
    report.setDefinitions(3500, 350, 2);

    expect(report.render()).toContain('│ Context Firewall Session Report ');
    expect(report.render()).not.toContain('(estimated)');
  });

  it('renderMarkdown() produces the expected table', () => {
    const report = new SessionReport(exactCounter());
    report.setDefinitions(3500, 350, 2);
    report.recordCall(call({ charsBefore: 7000, charsAfter: 350, bypassed: null }));
    report.recordCall(call({ charsBefore: 100, charsAfter: 100, bypassed: 'small' }));
    report.recordCall(call({ charsBefore: 200, charsAfter: 200, bypassed: 'security' }));

    expect(report.renderMarkdown()).toBe(
      '# Context Firewall Session Report\n' +
        '\n' +
        '| Metric | Value |\n' +
        '| --- | --- |\n' +
        '| Tools exposed | 2 → 4 |\n' +
        '| Definition savings | ~900 tokens |\n' +
        '| Calls | 3 (1 compressed, 2 passthrough) |\n' +
        '| Output savings | ~1,900 tokens |\n' +
        '| Total savings | ~2,800 tokens (≈ 1.4% of 200K) |\n'
    );
  });

  it('renders without crashing when there have been no calls', () => {
    const report = new SessionReport(estimatedCounter());
    report.setDefinitions(3500, 350, 2);

    expect(() => report.render()).not.toThrow();
    expect(() => report.renderMarkdown()).not.toThrow();
    expect(report.render()).toContain('Calls: 0 (0 compressed, 0 passthrough)');
    expect(report.render()).toContain('Definition savings: ~900 tokens');
  });

  it('renders without crashing when setDefinitions was never called', () => {
    const report = new SessionReport(estimatedCounter());

    expect(() => report.render()).not.toThrow();
    expect(report.render()).toContain('Tools exposed: 0 -> 4');
    expect(report.render()).toContain('Definition savings: ~0 tokens');
  });

  it('never leaks fake output/argument content passed via a CallStats object', () => {
    const report = new SessionReport(estimatedCounter());
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
});
