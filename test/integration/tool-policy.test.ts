import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DownstreamManager } from '../../src/downstream/manager.js';
import {
  createGateway,
  UNTRUSTED_TOOL_DESCRIPTIONS_PREFIX,
  UNTRUSTED_TOOL_DESCRIPTIONS_SUFFIX,
} from '../../src/server/gateway.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { createLogger } from '../../src/log.js';
import type { Config } from '../../src/types.js';

function parseSearchToolsResult(text: string): { server: string; name: string }[] {
  expect(text.startsWith(UNTRUSTED_TOOL_DESCRIPTIONS_PREFIX)).toBe(true);
  expect(text.endsWith(UNTRUSTED_TOOL_DESCRIPTIONS_SUFFIX)).toBe(true);
  const json = text.slice(
    UNTRUSTED_TOOL_DESCRIPTIONS_PREFIX.length,
    text.length - UNTRUSTED_TOOL_DESCRIPTIONS_SUFFIX.length
  );
  return JSON.parse(json) as { server: string; name: string }[];
}

// Gateway-level integration coverage for the tool allow/deny policy (GitHub issue #1). Reuses
// the in-process InMemoryTransport harness from chaos.test.ts's "P1-2 #6" block (real
// DownstreamManager + real gateway wired over InMemoryTransport, no spawned CLI) against the
// same no-dependency fixture used there, instead of building a new harness from scratch.

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(__dirname, 'fixtures', 'misbehaving-server.mjs');

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

describe('tool allow/deny policy wired into the gateway', () => {
  let client: Client;
  let manager: DownstreamManager;
  let onCallStats: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const config: Config = {
      downstreams: {
        // Both servers are the same fixture exposing one tool ("misbehave") - denying it only
        // on "denied" is what proves the policy is enforced per-server, not globally.
        denied: { command: 'node', args: [fixturePath, 'echo'], denyTools: ['misbehave'] },
        open: { command: 'node', args: [fixturePath, 'echo'] },
      },
    };
    const logger = createLogger('tool-policy-test');
    manager = new DownstreamManager(config, logger);
    await manager.connectAll();

    onCallStats = vi.fn();
    const store = new ArtifactStore();
    const gateway = createGateway({ manager, logger, config, store, onCallStats });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'tool-policy-test-client', version: '0.0.1' });
    await Promise.all([gateway.server.connect(serverTransport), client.connect(clientTransport)]);
  }, 15_000);

  afterAll(async () => {
    await client?.close();
    await manager?.close();
  });

  it('invoke_tool rejects a denyTools match with isError, the rule name, and never records call stats', async () => {
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: { server: 'denied', tool: 'misbehave', args: { message: 'should-not-run' } },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain('blocked by config policy');
    expect(firstText(result)).toContain('denyTools: "misbehave"');
    expect(onCallStats).not.toHaveBeenCalled();
  });

  it('invoke_tool still dispatches and records call stats for a server with no policy', async () => {
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: { server: 'open', tool: 'misbehave', args: { message: 'hello' } },
    })) as CallToolResult;

    expect(result.isError).not.toBe(true);
    expect(firstText(result)).toBe('hello');
    expect(onCallStats).toHaveBeenCalledTimes(1);
  });

  it('search_tools excludes the denyTools-blocked tool from "denied" but still surfaces it from "open"', async () => {
    const result = (await client.callTool({
      name: 'search_tools',
      arguments: { query: 'misbehave' },
    })) as CallToolResult;

    const parsed = parseSearchToolsResult(firstText(result));
    expect(parsed.some((r) => r.server === 'denied')).toBe(false);
    expect(parsed.some((r) => r.server === 'open')).toBe(true);
  });
});
