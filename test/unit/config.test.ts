import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolvePolicy, DEFAULT_POLICY } from '../../src/config.js';
import type { Config } from '../../src/types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const examplesDir = join(__dirname, '../../examples');

function writeTempConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-config-test-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, content, 'utf-8');
  return path;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadConfig', () => {
  it('parses a valid config', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: {
          filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
        },
      })
    );

    const config = loadConfig(path);
    expect(config.downstreams.filesystem).toEqual({
      command: 'npx',
      args: ['-y', 'server-filesystem'],
    });
  });

  it('throws when downstreams is missing', () => {
    const path = writeTempConfig(JSON.stringify({}));
    expect(() => loadConfig(path)).toThrow();
  });

  it('throws when downstreams is empty', () => {
    const path = writeTempConfig(JSON.stringify({ downstreams: {} }));
    expect(() => loadConfig(path)).toThrow(/at least 1 entry/);
  });

  it('expands ${ENV_VAR} references in string values', () => {
    vi.stubEnv('MY_TOKEN', 'secret-value');
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: {
          filesystem: {
            command: 'npx',
            env: { TOKEN: '${MY_TOKEN}' },
          },
        },
      })
    );

    const config = loadConfig(path);
    const downstream = config.downstreams.filesystem as { env?: Record<string, string> };
    expect(downstream.env?.TOKEN).toBe('secret-value');
  });

  it('throws a readable error when an env var is missing, naming the variable', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: {
          filesystem: {
            command: 'npx',
            env: { TOKEN: '${DOES_NOT_EXIST}' },
          },
        },
      })
    );

    expect(() => loadConfig(path)).toThrow(/DOES_NOT_EXIST/);
  });

  it('regression (P1-3 #1): a schema validation error does not echo secret env values into the error message', () => {
    const secret = 'sk-test-1234567890abcdef';
    // Missing the required `command`/`url` field so the union fails validation - the env value
    // (which could be a secret) is present in the parsed config but must not leak into the
    // zod error's `.message` output.
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: {
          filesystem: { args: ['x'], env: { TOKEN: secret } },
        },
      })
    );

    let message = '';
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(secret);
  });

  it('throws a readable error on invalid JSON', () => {
    const path = writeTempConfig('{ not valid json');
    expect(() => loadConfig(path)).toThrow(/JSON/);
  });

  it('parses an optional top-level callToolTimeoutMs', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        callToolTimeoutMs: 5000,
      })
    );

    const config = loadConfig(path);
    expect(config.callToolTimeoutMs).toBe(5000);
  });

  it('regression (P1-3 #5): an env value containing a double quote, newline, and backslash expands literally without breaking JSON structure', () => {
    const tricky = 'a"b\\c\nd';
    vi.stubEnv('TRICKY_SECRET', tricky);
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: {
          filesystem: {
            command: 'npx',
            env: { TOKEN: '${TRICKY_SECRET}', PLAIN: 'before-${TRICKY_SECRET}-after' },
          },
        },
      })
    );

    const config = loadConfig(path);
    const downstream = config.downstreams.filesystem as { env?: Record<string, string> };
    expect(downstream.env?.TOKEN).toBe(tricky);
    expect(downstream.env?.PLAIN).toBe(`before-${tricky}-after`);
  });

  it('leaves callToolTimeoutMs undefined when omitted', () => {
    const path = writeTempConfig(
      JSON.stringify({ downstreams: { filesystem: { command: 'npx' } } })
    );

    const config = loadConfig(path);
    expect(config.callToolTimeoutMs).toBeUndefined();
  });

  it('rejects a non-positive callToolTimeoutMs', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        callToolTimeoutMs: 0,
      })
    );

    expect(() => loadConfig(path)).toThrow();
  });

  it('throws when compression.default.llmSummary is true but no top-level llm block is configured', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        compression: { default: { llmSummary: true } },
      })
    );

    expect(() => loadConfig(path)).toThrow(/llmSummary is enabled but no top-level "llm" block/);
  });

  it('throws when a perServer policy has llmSummary true but no top-level llm block is configured', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        compression: { perServer: { filesystem: { llmSummary: true } } },
      })
    );

    expect(() => loadConfig(path)).toThrow(/llmSummary is enabled but no top-level "llm" block/);
  });

  it('throws when a perTool policy has llmSummary true but no top-level llm block is configured', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        compression: { perTool: { 'filesystem/read_file': { llmSummary: true } } },
      })
    );

    expect(() => loadConfig(path)).toThrow(/llmSummary is enabled but no top-level "llm" block/);
  });

  it('loads fine when llmSummary is true and a top-level llm block is configured, and resolvePolicy reflects it', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        compression: { default: { llmSummary: true } },
        llm: { baseUrl: 'https://api.example.com', apiKey: 'test-key', model: 'test-model' },
      })
    );

    const config = loadConfig(path);
    expect(config.llm).toEqual({
      baseUrl: 'https://api.example.com',
      apiKey: 'test-key',
      model: 'test-model',
    });
    const policy = resolvePolicy(config, 'filesystem', 'read_file');
    expect(policy.llmSummary).toBe(true);
  });

  it('expands ${ENV_VAR} references in llm.apiKey', () => {
    vi.stubEnv('MY_LLM_KEY', 'secret-llm-key');
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { baseUrl: 'https://api.example.com', apiKey: '${MY_LLM_KEY}', model: 'test-model' },
      })
    );

    const config = loadConfig(path);
    expect(config.llm?.apiKey).toBe('secret-llm-key');
  });

  it('resolves llm.baseUrl and apiKey from the "orcarouter" provider preset', () => {
    vi.stubEnv('ORCAROUTER_API_KEY', 'orca-secret');
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { provider: 'orcarouter', model: 'orcarouter/free' },
      })
    );

    const config = loadConfig(path);
    expect(config.llm?.baseUrl).toBe('https://api.orcarouter.ai/v1');
    expect(config.llm?.apiKey).toBe('orca-secret');
  });

  it('resolves llm.baseUrl and apiKey from the "deepseek" provider preset (non-exclusivity)', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'deepseek-secret');
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { provider: 'deepseek', model: 'deepseek-chat' },
      })
    );

    const config = loadConfig(path);
    expect(config.llm?.baseUrl).toBe('https://api.deepseek.com/v1');
    expect(config.llm?.apiKey).toBe('deepseek-secret');
  });

  it('prefers an explicit apiKey over the provider preset env var', () => {
    vi.stubEnv('ORCAROUTER_API_KEY', 'from-env');
    vi.stubEnv('MY_EXPLICIT_KEY', 'from-explicit');
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { provider: 'orcarouter', model: 'orcarouter/free', apiKey: '${MY_EXPLICIT_KEY}' },
      })
    );

    const config = loadConfig(path);
    expect(config.llm?.apiKey).toBe('from-explicit');
  });

  it('prefers explicit baseUrl over provider when both are set, and warns exactly once', () => {
    vi.stubEnv('ORCAROUTER_API_KEY', 'orca-secret');
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: {
          provider: 'orcarouter',
          baseUrl: 'https://custom.example.com/v1',
          apiKey: 'explicit-key',
          model: 'some-model',
        },
      })
    );

    const onWarn = vi.fn();
    const config = loadConfig(path, onWarn);
    expect(config.llm?.baseUrl).toBe('https://custom.example.com/v1');
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/"provider"/);
    expect(onWarn.mock.calls[0][0]).toMatch(/"baseUrl"/);
  });

  it('throws listing the valid preset names when neither provider nor baseUrl is set', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { model: 'some-model', apiKey: 'x' },
      })
    );

    expect(() => loadConfig(path)).toThrow(
      /openai, openrouter, orcarouter, deepseek/
    );
  });

  it('throws listing the valid preset names when an unknown provider is given', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { provider: 'nonexistent', model: 'some-model' },
      })
    );

    let message = '';
    try {
      loadConfig(path);
      throw new Error('expected loadConfig to throw');
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('openai');
    expect(message).toContain('openrouter');
    expect(message).toContain('orcarouter');
    expect(message).toContain('deepseek');
  });

  it('throws naming the env var when a provider preset apiKeyEnv is unset and no apiKey is given', () => {
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { provider: 'orcarouter', model: 'orcarouter/free' },
      })
    );

    expect(() => loadConfig(path)).toThrow(/ORCAROUTER_API_KEY/);
  });

  it('treats an explicit empty-string apiKey as absent, falling back to the preset env var', () => {
    vi.stubEnv('ORCAROUTER_API_KEY', 'orca-secret');
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { provider: 'orcarouter', model: 'orcarouter/free', apiKey: '' },
      })
    );

    const config = loadConfig(path);
    expect(config.llm?.apiKey).toBe('orca-secret');
  });

  it('treats a preset env var set to an empty string as unset, throwing naming the env var', () => {
    vi.stubEnv('ORCAROUTER_API_KEY', '');
    const path = writeTempConfig(
      JSON.stringify({
        downstreams: { filesystem: { command: 'npx' } },
        llm: { provider: 'orcarouter', model: 'orcarouter/free' },
      })
    );

    expect(() => loadConfig(path)).toThrow(/ORCAROUTER_API_KEY/);
  });

  it('loads examples/config.llm-orcarouter.json via provider preset', () => {
    vi.stubEnv('ORCAROUTER_API_KEY', 'orca-secret');
    const config = loadConfig(join(examplesDir, 'config.llm-orcarouter.json'));

    expect(config.llm?.baseUrl).toBe('https://api.orcarouter.ai/v1');
    expect(config.llm?.apiKey).toBe('orca-secret');
    expect(config.compression?.default?.llmSummary).toBe(true);
  });

  it('loads examples/config.llm-generic.json via explicit baseUrl', () => {
    vi.stubEnv('LLM_API_KEY', 'generic-secret');
    const config = loadConfig(join(examplesDir, 'config.llm-generic.json'));

    expect(config.llm?.baseUrl).toBe('https://api.your-provider.example/v1');
    expect(config.llm?.apiKey).toBe('generic-secret');
    expect(config.compression?.default?.llmSummary).toBe(true);
  });
});

describe('DEFAULT_POLICY', () => {
  it('has llmSummary: false', () => {
    expect(DEFAULT_POLICY.llmSummary).toBe(false);
  });
});

describe('resolvePolicy', () => {
  it('merges default < perServer < perTool over the built-in defaults', () => {
    const config: Config = {
      downstreams: { filesystem: { command: 'npx' } },
      compression: {
        default: { maxOutputTokens: 1000 },
        perServer: {
          filesystem: { maxOutputTokens: 3000, htmlToMarkdown: false },
        },
        perTool: {
          'filesystem/read_file': { maxOutputTokens: 9000 },
        },
      },
    };

    // No perServer/perTool match: falls back to compression.default over DEFAULT_POLICY.
    const defaultPolicy = resolvePolicy(config, 'other-server', 'other-tool');
    expect(defaultPolicy.maxOutputTokens).toBe(1000);
    expect(defaultPolicy.htmlToMarkdown).toBe(DEFAULT_POLICY.htmlToMarkdown);

    // perServer overrides default.
    const serverPolicy = resolvePolicy(config, 'filesystem', 'write_file');
    expect(serverPolicy.maxOutputTokens).toBe(3000);
    expect(serverPolicy.htmlToMarkdown).toBe(false);
    expect(serverPolicy.stripBase64).toBe(DEFAULT_POLICY.stripBase64);

    // perTool overrides perServer.
    const toolPolicy = resolvePolicy(config, 'filesystem', 'read_file');
    expect(toolPolicy.maxOutputTokens).toBe(9000);
    expect(toolPolicy.htmlToMarkdown).toBe(false);
  });
});
