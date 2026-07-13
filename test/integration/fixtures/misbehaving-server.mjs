#!/usr/bin/env node
// Minimal hand-rolled MCP stdio server for chaos-testing context-firewall against a
// misbehaving downstream. No dependencies: reads newline-delimited JSON-RPC from stdin,
// writes newline-delimited JSON-RPC to stdout (that's the protocol channel for this process,
// so process.stdout.write is intentional here even though the rest of the repo bans
// console.log). initialize/tools/list always answer correctly so the client can connect;
// tools/call behavior is controlled by argv.
//
// Usage: node misbehaving-server.mjs <mode> [variant]
//   mode: echo | hang | huge | malformed
//   variant (malformed only): array (default) | text

import { createInterface } from 'node:readline';

const mode = process.argv[2] || 'echo';
const variant = process.argv[3] || 'array';

const rl = createInterface({ input: process.stdin, terminal: false });

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  switch (msg.method) {
    case 'initialize':
      respond(msg.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'misbehaving-server', version: '0.0.1' },
      });
      return;
    case 'notifications/initialized':
      return; // no response for notifications
    case 'tools/list':
      respond(msg.id, {
        tools: [
          {
            name: 'misbehave',
            description: 'chaos-test fixture tool',
            inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
          },
        ],
      });
      return;
    case 'tools/call':
      handleCallTool(msg);
      return;
    default:
      if (msg.id !== undefined) {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
      }
  }
});

function handleCallTool(msg) {
  if (mode === 'hang') {
    return; // never respond - simulates a downstream that received the call but is stuck
  }

  if (mode === 'huge') {
    const text = 'A'.repeat(10 * 1024 * 1024); // 10MB single text block
    respond(msg.id, { content: [{ type: 'text', text }], isError: false });
    return;
  }

  if (mode === 'malformed') {
    if (variant === 'text') {
      // content is an array, but the text field is a number instead of a string
      respond(msg.id, { content: [{ type: 'text', text: 12345 }], isError: false });
    } else {
      // content is not an array at all
      respond(msg.id, { content: 'not-an-array', isError: false });
    }
    return;
  }

  // echo mode (default): return whatever message was sent, verbatim
  const args = msg.params?.arguments ?? {};
  respond(msg.id, { content: [{ type: 'text', text: String(args.message ?? '') }], isError: false });
}
