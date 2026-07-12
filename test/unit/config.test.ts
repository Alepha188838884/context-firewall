import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolvePolicy, DEFAULT_POLICY } from '../../src/config.js';
import type { Config } from '../../src/types.js';

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

  it('throws a readable error on invalid JSON', () => {
    const path = writeTempConfig('{ not valid json');
    expect(() => loadConfig(path)).toThrow(/JSON/);
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
