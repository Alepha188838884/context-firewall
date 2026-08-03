import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
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

// The gateway under test here runs in a separate child process (spawned below via npx/tsx), so
// its UNTRUSTED_CONTENT_NONCE (generated once per process at module load, see gateway.ts) is
// not the same value this test file's own process would get from importing the constant - it
// can only be recovered from the actual response text. Match the wrapper structurally instead,
// requiring the same nonce on both the opening and closing tag via a backreference.
const WRAPPED_SEARCH_RESULT_RE =
  /^<untrusted-tool-descriptions nonce="([0-9a-f]+)" note="[^"]*">\n([\s\S]*)\n<\/untrusted-tool-descriptions nonce="\1">$/;

function parseSearchToolsResult(text: string): { server: string; name: string }[] {
  const match = text.match(WRAPPED_SEARCH_RESULT_RE);
  expect(match).not.toBeNull();
  return JSON.parse(match![2]) as { server: string; name: string }[];
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

  // P0-2 discoverability fix: an agent that searches its own tool list by downstream server
  // name (e.g. "everything") must actually find it - static descriptions with no server names
  // in them never match. gateway.ts calls refreshToolDescriptions() right after
  // manager.connectAll() settles, which rewrites descriptions and fires
  // notifications/tools/list_changed; the SDK client does not auto-refetch on that
  // notification, so the test re-calls listTools() itself (same as a real client would once it
  // observes the notification and decides to refresh).
  it('meta-tool descriptions are refreshed with connected downstream server names', async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.description ?? '']));

    expect(byName.get('list_tool_categories')).toContain('everything');
    expect(byName.get('list_tool_categories')).toContain('filesystem');
    expect(byName.get('search_tools')).toContain('everything');
    expect(byName.get('search_tools')).toContain('filesystem');
    expect(byName.get('invoke_tool')).toContain('everything');
    expect(byName.get('invoke_tool')).toContain('filesystem');
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
    const parsed = parseSearchToolsResult(firstText(result as CallToolResult));

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

  // P1-3 #3 (TEST_PLAN.md): security-relevant passthrough must be byte-for-byte, not just
  // "not truncated" - a permission-denied error is exactly the kind of output the safety bypass
  // (src/pipeline/safety.ts) exists for. Skipped when running as root: root bypasses Unix file
  // permission checks entirely, so chmod 000 wouldn't actually produce a permission error.
  const isRoot = process.getuid?.() === 0;
  (isRoot ? it.skip : it)(
    'invoke_tool passes through a permission-denied read (chmod 000) as an untruncated error (safety bypass)',
    async () => {
      const deniedPath = join(dataDir, 'no-permission.json');
      writeFileSync(deniedPath, '{"secret": "should never be reachable"}');
      chmodSync(deniedPath, 0o000);

      try {
        const result = (await client.callTool({
          name: 'invoke_tool',
          arguments: { server: 'filesystem', tool: 'read_text_file', args: { path: deniedPath } },
        })) as CallToolResult;

        expect(result.isError).toBe(true);
        const text = firstText(result);
        expect(text).not.toContain('[Output truncated');
        expect(text.toLowerCase()).toMatch(/permission|denied|eacces/);
      } finally {
        // Restore permissions so the temp dir can be cleaned up normally.
        chmodSync(deniedPath, 0o644);
      }
    }
  );

  it('invoke_tool round-trips a short everything/echo message unchanged', async () => {
    const message = 'hello from context-firewall e2e test';
    const result = (await client.callTool({
      name: 'invoke_tool',
      arguments: { server: 'everything', tool: 'echo', args: { message } },
    })) as CallToolResult;

    expect(firstText(result)).toContain(message);
  });
});
