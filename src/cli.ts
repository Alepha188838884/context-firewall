#!/usr/bin/env node
import { loadConfig } from './config.js';
import { createLogger } from './log.js';

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

function main(): void {
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
  }

  const config = loadConfig(args.config);
  log.info(`config loaded, ${Object.keys(config.downstreams).length} downstreams`);
}

main();
