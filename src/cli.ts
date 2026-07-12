#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createLogger } from './log.js';
import { DownstreamManager } from './downstream/manager.js';
import { createGateway } from './server/gateway.js';

const log = createLogger('context-firewall');

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
    process.stderr.write('0.1.0\n');
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

  // Connect the upstream transport first so the MCP client handshake completes promptly -
  // downstream connections can be slow and must not block it.
  const gateway = createGateway(manager, log);
  const transport = new StdioServerTransport();
  await gateway.connect(transport);
  log.info('gateway connected on stdio');

  const shutdown = async (signal: string): Promise<void> => {
    log.info(`received ${signal}, shutting down`);
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

  await manager.connectAll();

  const states = manager.getServerStates();
  const connected = states.filter((s) => s.status === 'connected');
  const totalTools = connected.reduce((sum, s) => sum + s.toolCount, 0);
  log.info(`connected ${connected.length}/${states.length} downstreams, ${totalTools} tools total`);
}

main().catch((err) => {
  log.error(`fatal error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
