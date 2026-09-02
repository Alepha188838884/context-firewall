import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DownstreamManager } from '../../src/downstream/manager.js';
import { createGateway } from '../../src/server/gateway.js';
import { ArtifactStore } from '../../src/artifacts.js';
import { createLogger } from '../../src/log.js';
import type { Config } from '../../src/types.js';

// P1-2 chaos / robustness suite (TEST_PLAN.md). Every scenario drives the gateway against a
// deliberately misbehaving downstream (test/integration/fixtures/misbehaving-server.mjs, a
// hand-rolled MCP stdio server with no dependencies) and asserts the gateway never crashes and
// never hangs. Downstreams here are spawned directly via `node <fixture>` (no npx), so unlike
// e2e.test.ts this suite has no cold-start cost and stays fast.

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const fixturePath = join(__dirname, 'fixtures', 'misbehaving-server.mjs');
const tsxBin = join(projectRoot, 'node_modules/.bin/tsx');

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

function writeConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'cf-chaos-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(config));
  return path;
}

async function connectGateway(configPath: string): Promise<Client> {
  const client = new Client({ name: 'chaos-test-client', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [join(projectRoot, 'src/cli.ts'), '--config', configPath],
    cwd: projectRoot,
  });
  await client.connect(transport);
  return client;
}

async function waitForDownstreams(client: Client, names: string[], timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    const result = (await client.callTool({ name: 'list_tool_categories', arguments: {} })) as CallToolResult;
    const parsed = JSON.parse(firstText(result)) as { servers: { name: string; status: string }[] };
    if (names.every((name) => parsed.servers.find((s) => s.name === name)?.status === 'connected')) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`downstreams not connected within ${timeoutMs}ms: ${JSON.stringify(parsed.servers)}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
}

// Scan the full process table with `ps` and filter in JS instead of `pgrep -f <tag>`: the
// pgrep form runs through execSync's `/bin/sh -c` wrapper whose own command line contains the
// tag, and on Linux that wrapper can survive long enough to match itself (macOS's sh execs the
// simple command, replacing the wrapper, so it never shows there). `ps` never receives the tag
// as an argument, so nothing here can self-match. Returning args too means an assertion
// failure prints the full command line of any unexpected extra process.
function procsForTag(tag: string): { pid: number; args: string }[] {
  const out = execSync('ps -eo pid=,args=').toString();
  return out
    .split('\n')
    .filter((line) => line.includes(tag))
    .map((line) => {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      return { pid: Number(m![1]), args: m![2] };
    });
}

describe('P1-2 #1: kill -9 downstream mid-invoke', () => {
  let client: Client;
  let victimTag: string;

  beforeAll(async () => {
    victimTag = `chaos-victim-${randomUUID()}`;
    const configPath = writeConfig({
      downstreams: {
        victim: { command: 'node', args: [fixturePath, 'hang', victimTag] },
        control: { command: 'node', args: [fixturePath, 'echo'] },
      },
      report: { enabled: false },
    });
    client = await connectGateway(configPath);
    await waitForDownstreams(client, ['victim', 'control'], 15_000);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it(
    'returns isError for the in-flight call, gateway survives, other servers unaffected',
    async () => {
      const procs = procsForTag(victimTag);
      expect(procs).toHaveLength(1);

      const callPromise = client.callTool({
        name: 'invoke_tool',
        arguments: { server: 'victim', tool: 'misbehave', args: { message: 'will be killed' } },
      }) as Promise<CallToolResult>;

      // Give the call time to actually reach the downstream (and the downstream time to
      // register the tools/call frame) before pulling the rug out.
      await new Promise((r) => setTimeout(r, 300));
      process.kill(procs[0].pid, 'SIGKILL');

      const result = await callPromise;
      expect(result.isError).toBe(true);

      // Follow-up call to the now-dead server errors immediately instead of hanging.
      const followUp = (await client.callTool({
        name: 'invoke_tool',
        arguments: { server: 'victim', tool: 'misbehave', args: { message: 'after kill' } },
      })) as CallToolResult;
      expect(followUp.isError).toBe(true);

      // A different downstream is completely unaffected.
      const other = (await client.callTool({
        name: 'invoke_tool',
        arguments: { server: 'control', tool: 'misbehave', args: { message: 'still alive' } },
      })) as CallToolResult;
      expect(other.isError).not.toBe(true);
      expect(firstText(other)).toBe('still alive');

      // The gateway process itself is still up and answering.
      const categories = (await client.callTool({ name: 'list_tool_categories', arguments: {} })) as CallToolResult;
      expect(categories.isError).not.toBe(true);
    },
    20_000
  );
});

describe('P1-2 #2-#5: hang timeout, huge output, malformed content, concurrency', () => {
  let client: Client;
  const CALL_TOOL_TIMEOUT_MS = 3000;

  beforeAll(async () => {
    const configPath = writeConfig({
      downstreams: {
        hang: { command: 'node', args: [fixturePath, 'hang'] },
        huge: { command: 'node', args: [fixturePath, 'huge'] },
        malformedArray: { command: 'node', args: [fixturePath, 'malformed', 'array'] },
        malformedText: { command: 'node', args: [fixturePath, 'malformed', 'text'] },
        echo: { command: 'node', args: [fixturePath, 'echo'] },
      },
      callToolTimeoutMs: CALL_TOOL_TIMEOUT_MS,
      report: { enabled: false },
    });
    client = await connectGateway(configPath);
    await waitForDownstreams(client, ['hang', 'huge', 'malformedArray', 'malformedText', 'echo'], 15_000);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
  });

  it(
    '#2 a downstream that never replies to tools/call times out via callToolTimeoutMs instead of hanging',
    async () => {
      const start = Date.now();
      const result = (await client.callTool({
        name: 'invoke_tool',
        arguments: { server: 'hang', tool: 'misbehave', args: { message: 'x' } },
      })) as CallToolResult;
      const elapsed = Date.now() - start;

      expect(result.isError).toBe(true);
      expect(firstText(result).toLowerCase()).toContain('time');
      // Generous window around the configured 3s timeout to absorb process/CI scheduling jitter
      // without weakening the assertion that we did NOT wait anywhere near the SDK's 60s default.
      expect(elapsed).toBeGreaterThanOrEqual(CALL_TOOL_TIMEOUT_MS - 300);
      expect(elapsed).toBeLessThan(CALL_TOOL_TIMEOUT_MS + 5000);
    },
    15_000
  );

  it(
    '#3 a 10MB single-block response does not OOM or stall: completes well under 5s, truncates with a working handle',
    async () => {
      const start = Date.now();
      const result = (await client.callTool({
        name: 'invoke_tool',
        arguments: { server: 'huge', tool: 'misbehave', args: {} },
      })) as CallToolResult;
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(5000);
      expect(result.isError).not.toBe(true);

      const text = firstText(result);
      expect(text).toContain('[Output truncated');
      expect(text.length).toBeLessThan(20_000); // bounded, nowhere near the 10MB original

      const match = text.match(/read_more\("([^"]+)"/);
      expect(match).not.toBeNull();
      const handle = match?.[1] as string;

      const page = (await client.callTool({
        name: 'read_more',
        arguments: { handle, offset: 0, length: 50_000 },
      })) as CallToolResult;
      const pageText = firstText(page);
      expect(pageText.startsWith('A'.repeat(100))).toBe(true);
      expect(pageText).toContain(`of ${10 * 1024 * 1024} chars`);
    },
    15_000
  );

  it('#4a malformed content (content is not an array) is caught as isError, not a crash', async () => {
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: { server: 'malformedArray', tool: 'misbehave', args: { message: 'x' } },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
  });

  it('#4b malformed content (a text block whose "text" is a number) is caught as isError, not a crash', async () => {
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: { server: 'malformedText', tool: 'misbehave', args: { message: 'x' } },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
  });

  it('#4c the gateway is still healthy after both malformed responses', async () => {
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: { server: 'echo', tool: 'misbehave', args: { message: 'still fine' } },
    })) as CallToolResult;
    expect(result.isError).not.toBe(true);
    expect(firstText(result)).toBe('still fine');
  });

  it(
    '#5 10 concurrent invoke_tool calls to the same downstream do not cross-contaminate handles',
    async () => {
      const N = 10;
      const calls = Array.from({ length: N }, (_, i) => {
        const filler = String.fromCharCode(65 + i).repeat(20_000); // 'A'*20000, 'B'*20000, ...
        const message = `call-${i}:${filler}`;
        return client.callTool({
          name: 'invoke_tool',
          arguments: { server: 'echo', tool: 'misbehave', args: { message } },
        }) as Promise<CallToolResult>;
      });

      const results = await Promise.all(calls);
      expect(results).toHaveLength(N);

      // Each truncated response carries only its own call's prefix, never a neighbor's.
      for (let i = 0; i < N; i++) {
        expect(results[i].isError).not.toBe(true);
        const text = firstText(results[i]);
        expect(text).toContain(`call-${i}:`);
        for (let j = 0; j < N; j++) {
          if (j !== i) {
            expect(text).not.toContain(`call-${j}:`);
          }
        }
      }

      // Each handle, followed independently via read_more, resolves back to that call's own
      // filler character - proving the artifact store isn't mixing up concurrent puts.
      for (let i = 0; i < N; i++) {
        const text = firstText(results[i]);
        const match = text.match(/read_more\("([^"]+)"/);
        expect(match).not.toBeNull();
        const handle = match?.[1] as string;
        const expectedChar = String.fromCharCode(65 + i);

        const tail = (await client.callTool({
          name: 'read_more',
          arguments: { handle, offset: 10_000, length: 100 },
        })) as CallToolResult;
        expect(firstText(tail).startsWith(expectedChar.repeat(50))).toBe(true);
      }
    },
    30_000
  );
});

describe('P1-2 #6: artifact store eviction under load (30-call spot check)', () => {
  // Full end-to-end wiring (real DownstreamManager + real gateway) but over an in-process
  // InMemoryTransport instead of a spawned CLI, so we can hand the gateway a deliberately tiny
  // ArtifactStore (maxCount isn't exposed via the JSON config - the 250-call sweep of the
  // default-capacity store lives in test/unit/artifacts.test.ts instead).
  let client: Client;
  let manager: DownstreamManager;

  beforeAll(async () => {
    const config: Config = {
      downstreams: { echo: { command: 'node', args: [fixturePath, 'echo'] } },
    };
    const logger = createLogger('chaos-artifact-test');
    manager = new DownstreamManager(config, logger);
    await manager.connectAll();

    const store = new ArtifactStore({ maxCount: 5 });
    const gateway = createGateway({ manager, logger, config, store });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'chaos-artifact-test-client', version: '0.0.1' });
    await Promise.all([gateway.server.connect(serverTransport), client.connect(clientTransport)]);
  }, 15_000);

  afterAll(async () => {
    await client?.close();
    await manager?.close();
  });

  it(
    'old handles evict FIFO with a readable error; the newest handle stays retrievable after 30 calls',
    async () => {
      const handles: string[] = [];
      for (let i = 0; i < 30; i++) {
        const filler = 'x'.repeat(20_000);
        const result = (await client.callTool({
          name: 'invoke_tool',
          arguments: { server: 'echo', tool: 'misbehave', args: { message: `spot-${i}:${filler}` } },
        })) as CallToolResult;
        const match = firstText(result).match(/read_more\("([^"]+)"/);
        expect(match).not.toBeNull();
        handles.push(match?.[1] as string);
      }

      const oldest = (await client.callTool({
        name: 'read_more',
        arguments: { handle: handles[0], offset: 0, length: 100 },
      })) as CallToolResult;
      expect(oldest.isError).toBe(true);
      expect(firstText(oldest)).toContain('not found or expired');

      const newest = (await client.callTool({
        name: 'read_more',
        arguments: { handle: handles[handles.length - 1], offset: 0, length: 20 },
      })) as CallToolResult;
      expect(newest.isError).not.toBe(true);
      expect(firstText(newest)).toContain('spot-29:');
    },
    20_000
  );
});

describe('P1-2 #7: upstream disconnect reclaims the downstream subprocess (no orphans)', () => {
  it(
    'closing the upstream connection shuts the gateway down and leaves no orphaned downstream process',
    async () => {
      const tag = `chaos-orphan-${randomUUID()}`;
      const configPath = writeConfig({
        downstreams: { echo: { command: 'node', args: [fixturePath, 'echo', tag] } },
        report: { enabled: false },
      });

      const client = await connectGateway(configPath);
      await waitForDownstreams(client, ['echo'], 15_000);

      expect(procsForTag(tag)).toHaveLength(1);

      // Simulate the upstream host disconnecting: the client just ends the pipe. This exercises
      // a different path than shutdown.test.ts's SIGINT test - see the stdin 'end' handler in
      // cli.ts (P1-2 #7 fix), since StdioServerTransport does not itself treat stdin EOF as a
      // close.
      await client.close();

      await new Promise((r) => setTimeout(r, 4000));

      expect(procsForTag(tag)).toEqual([]);
    },
    20_000
  );
});
