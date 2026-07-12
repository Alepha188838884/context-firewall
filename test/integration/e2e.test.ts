import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// End-to-end test: spawns the real context-firewall CLI (via `npx tsx src/cli.ts`) over
// stdio, wired to two real downstream MCP servers (@modelcontextprotocol/server-everything
// and @modelcontextprotocol/server-filesystem), and drives it exactly as an AI agent would
// through the MCP SDK client. First run is slow (npx cold-starts three separate node
// processes); subsequent runs hit npx's local cache.

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '../..');
const fixturesDir = join(__dirname, 'fixtures');
const dataDir = join(fixturesDir, 'data');
const bigJsonPath = join(dataDir, 'big.json');

const MAX_OUTPUT_TOKENS = 200;
const BUDGET_CHARS = MAX_OUTPUT_TOKENS * 3.5; // mirrors budgetChars() in src/pipeline/truncate.ts

function firstText(result: CallToolResult): string {
  const block = result.content.find((b) => b.type === 'text');
  return block && block.type === 'text' ? block.text : '';
}

function makeBigJson(targetBytes: number): string {
  const sample = { id: 0, name: 'item-0', value: 0, tags: ['alpha', 'beta', 'gamma'], active: true };
  const perItem = JSON.stringify(sample).length + 1; // +1 for the array separator comma
  const count = Math.ceil(targetBytes / perItem) + 100; // buffer to guarantee we clear the target
  const items = Array.from({ length: count }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    value: i * 3.14159,
    tags: ['alpha', 'beta', 'gamma'],
    active: i % 2 === 0,
  }));
  return JSON.stringify(items);
}

let client: Client;
let configPath: string;

// The gateway's own MCP handshake completes immediately (by design - see cli.ts), but the
// two real downstream servers are spawned via `npx` and connected asynchronously afterwards.
// Poll list_tool_categories until both report "connected" before any test relies on them.
async function waitForDownstreams(names: string[], timeoutMs: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    const result = (await client.callTool({ name: 'list_tool_categories', arguments: {} })) as CallToolResult;
    const parsed = JSON.parse(firstText(result)) as { servers: { name: string; status: string }[] };
    const allConnected = names.every(
      (name) => parsed.servers.find((s) => s.name === name)?.status === 'connected'
    );
    if (allConnected) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `downstream servers did not all connect within ${timeoutMs}ms: ${JSON.stringify(parsed.servers)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

beforeAll(async () => {
  mkdirSync(dataDir, { recursive: true });

  const bigJson = makeBigJson(200_000);
  writeFileSync(bigJsonPath, bigJson);
  expect(bigJson.length).toBeGreaterThanOrEqual(200_000);

  const config = {
    downstreams: {
      everything: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
      },
      filesystem: {
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', dataDir],
      },
    },
    compression: {
      default: {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        htmlToMarkdown: true,
        stripBase64: true,
        jsonSummary: true,
        bypass: false,
      },
    },
  };

  configPath = join(tmpdir(), `cf-e2e-config-${process.pid}-${Date.now()}.json`);
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  client = new Client({ name: 'e2e-test-client', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', join(projectRoot, 'src/cli.ts'), '--config', configPath],
    cwd: projectRoot,
  });

  await client.connect(transport);
  await waitForDownstreams(['everything', 'filesystem'], 45_000);
}, 60_000);

afterAll(async () => {
  await client?.close();
});

describe('context-firewall e2e', () => {
  it('exposes exactly the 4 meta-tools, regardless of how many downstream tools exist', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(4);
    expect(new Set(tools.map((t) => t.name))).toEqual(
      new Set(['list_tool_categories', 'search_tools', 'invoke_tool', 'read_more'])
    );
  });

  it('list_tool_categories reports both downstreams connected with their real tool counts', async () => {
    const result = await client.callTool({ name: 'list_tool_categories', arguments: {} });
    const parsed = JSON.parse(firstText(result as CallToolResult)) as {
      servers: { name: string; status: string; tools: number }[];
    };

    const everything = parsed.servers.find((s) => s.name === 'everything');
    expect(everything?.status).toBe('connected');
    expect(everything?.tools).toBe(13);

    const filesystem = parsed.servers.find((s) => s.name === 'filesystem');
    expect(filesystem?.status).toBe('connected');
    expect(filesystem?.tools).toBeGreaterThan(5);
  });

  it('search_tools("read file") surfaces filesystem read tools', async () => {
    const result = await client.callTool({
      name: 'search_tools',
      arguments: { query: 'read file' },
    });
    const parsed = JSON.parse(firstText(result as CallToolResult)) as { server: string; name: string }[];

    expect(parsed.some((r) => r.server === 'filesystem' && /read/i.test(r.name))).toBe(true);
  });

  it('invoke_tool compresses a large filesystem read: bounded size, truncation marker, working handle', async () => {
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: { server: 'filesystem', tool: 'read_text_file', args: { path: bigJsonPath } },
    })) as CallToolResult;

    const text = firstText(result);
    expect(result.isError).not.toBe(true);
    expect(text.length).toBeLessThanOrEqual(BUDGET_CHARS + 300);
    expect(text).toContain('[Output truncated');

    const match = text.match(/read_more\("([^"]+)"/);
    expect(match).not.toBeNull();
    const handle = match?.[1] as string;

    // Page through read_more until the store reports there's nothing left, confirming the
    // handle actually resolves back to the full original (pre-truncation) content.
    let offset = 0;
    let lastText = '';
    for (let i = 0; i < 20; i++) {
      const page = (await client.callTool({
        name: 'read_more',
        arguments: { handle, offset, length: 50_000 },
      })) as CallToolResult;
      lastText = firstText(page);
      const next = lastText.match(/next: read_more\("[^"]+", (\d+)\)/);
      if (!next) {
        break;
      }
      offset = Number(next[1]);
    }

    expect(lastText).toContain('end of output');
  });

  it('invoke_tool passes through a read of a nonexistent file as an untruncated error (safety bypass)', async () => {
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: {
        server: 'filesystem',
        tool: 'read_text_file',
        args: { path: join(dataDir, 'does-not-exist.json') },
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    const text = firstText(result);
    expect(text).not.toContain('[Output truncated');
  });

  it('invoke_tool round-trips a short everything/echo message unchanged', async () => {
    const message = 'hello from context-firewall e2e test';
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: { server: 'everything', tool: 'echo', args: { message } },
    })) as CallToolResult;

    expect(firstText(result)).toContain(message);
  });
});
