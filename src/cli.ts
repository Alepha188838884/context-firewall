#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { DownstreamManager } from './downstream/manager.js';
import { createGateway } from './server/gateway.js';
import { ArtifactStore } from './artifacts.js';
import { SessionReport } from './report.js';
import { LIST_TOOL_CATEGORIES, SEARCH_TOOLS, INVOKE_TOOL, READ_MORE } from './server/meta-tools.js';

const log = createLogger('context-firewall');

// Read the version from package.json instead of hardcoding it here, so `--version` can't drift
// out of sync with the actual published version on the next bump. createRequire is the
// standard way to load JSON under NodeNext ESM without needing --resolve-json-module wired
// through the build; '../package.json' resolves the same way from both src/cli.ts (tsx/dev)
// and dist/cli.js (built), since dist mirrors src one level under the project root.
const require = createRequire(import.meta.url);
const { version: PACKAGE_VERSION } = require('../package.json') as { version: string };

const HELP_TEXT = `context-firewall --config <path>

Options:
  --config <path>  Path to the JSON config file (required)
  --help            Show this help message
  --version         Show version number
`;

function parseArgs(argv: string[]): { config?: string; help: boolean; version: boolean } {
  const result: { config?: string; help: boolean; version: boolean } = {
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') {
      result.help = true;
    } else if (arg === '--version') {
      result.version = true;
    } else if (arg === '--config') {
      result.config = argv[i + 1];
      i++;
    }
  }

  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stderr.write(HELP_TEXT);
    process.exit(0);
  }

  if (args.version) {
    process.stderr.write(`${PACKAGE_VERSION}\n`);
    process.exit(0);
  }

  if (!args.config) {
    log.error('missing required argument --config <path>');
    process.exit(1);
    return;
  }

  const config = loadConfig(args.config);
  log.info(`config loaded, ${Object.keys(config.downstreams).length} downstreams`);

  const manager = new DownstreamManager(config, log);
  const store = new ArtifactStore();
  const report = new SessionReport();

  // Connect the upstream transport first so the MCP client handshake completes promptly -
  // downstream connections can be slow and must not block it.
  const gateway = createGateway({
    manager,
    logger: log,
    config,
    store,
    onCallStats: (stats) => report.recordCall(stats),
  });
  const transport = new StdioServerTransport();
  await gateway.server.connect(transport);
  log.info('gateway connected on stdio');

  const writeReport = (): void => {
    if (config.report?.enabled === false) {
      return;
    }
    process.stderr.write(`${report.render()}\n`);
    if (config.report?.markdownPath) {
      try {
        writeFileSync(config.report.markdownPath, report.renderMarkdown());
      } catch (err) {
        log.warn(`failed to write markdown report: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };

  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    log.info(`received ${signal}, shutting down`);
    writeReport();
    await manager.close();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  transport.onclose = () => {
    void shutdown('transport close');
  };
  // StdioServerTransport only reacts to 'data'/'error' on stdin - it never calls onclose when
  // the upstream simply ends the pipe (no more bytes, no signal), which is how some MCP hosts
  // disconnect. Without this, that disconnect mode never runs shutdown() and every downstream
  // child process spawned by manager stays behind as an orphan.
  process.stdin.on('end', () => {
    void shutdown('stdin closed');
  });

  await manager.connectAll();
  gateway.refreshToolDescriptions();

  const states = manager.getServerStates();
  const connected = states.filter((s) => s.status === 'connected');
  const totalTools = connected.reduce((sum, s) => sum + s.toolCount, 0);
  log.info(`connected ${connected.length}/${states.length} downstreams, ${totalTools} tools total`);

  // Human-readable startup digest, distinct from the summary line above: lets an operator see
  // at a glance what actually got connected (per-server tool counts + top categories) without
  // having to call list_tool_categories themselves.
  const registry = manager.getRegistry();
  log.info(`context-firewall: ${connected.length} downstream server(s) connected`);
  for (const state of states) {
    if (state.status === 'connected') {
      const categories = registry.categorize(state.name).slice(0, 5).join(', ');
      log.info(`  ${state.name}: ${state.toolCount} tools [${categories}]`);
    } else {
      log.info(`  ${state.name}: FAILED — ${state.error}`);
    }
  }

  const allTools = manager.getRegistry().getAllTools();
  const rawChars = JSON.stringify(allTools).length;
  const exposedChars = [LIST_TOOL_CATEGORIES, SEARCH_TOOLS, INVOKE_TOOL, READ_MORE].reduce(
    (sum, t) => sum + JSON.stringify({ name: t.name, description: t.description, inputSchema: t.inputSchema }).length,
    0
  );
  report.setDefinitions(rawChars, exposedChars, allTools.length);
}

main().catch((err) => {
  log.error(`fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
