import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Config, DownstreamConfig } from '../types.js';
import type { Logger } from '../log.js';
import { ToolRegistry } from './registry.js';

const CONNECT_TIMEOUT_MS = 30_000;
const LIST_TOOLS_TIMEOUT_MS = 30_000;

export interface ServerState {
  name: string;
  status: 'connected' | 'unavailable';
  toolCount: number;
  error?: string;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Owns the pool of downstream MCP client connections. Connecting to one downstream never
 * fails connectAll() as a whole - failures are recorded per-server and surfaced via
 * getServerStates().
 */
export class DownstreamManager {
  private readonly config: Config;
  private readonly log: Logger;
  private readonly registry = new ToolRegistry();
  private readonly clients = new Map<string, Client>();
  private readonly states = new Map<string, ServerState>();

  constructor(config: Config, logger: Logger) {
    this.config = config;
    this.log = logger;
  }

  getRegistry(): ToolRegistry {
    return this.registry;
  }

  async connectAll(): Promise<void> {
    await Promise.all(
      Object.entries(this.config.downstreams).map(([name, cfg]) => this.connectOne(name, cfg))
    );
  }

  private async connectOne(name: string, cfg: DownstreamConfig): Promise<void> {
    try {
      const transport = this.createTransport(name, cfg);
      const client = new Client({ name: `context-firewall-${name}`, version: '0.1.0' });

      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        `connecting to downstream "${name}" timed out after ${CONNECT_TIMEOUT_MS / 1000}s`
      );

      const tools = await withTimeout(
        this.listAllTools(client),
        LIST_TOOLS_TIMEOUT_MS,
        `listTools on downstream "${name}" timed out after ${LIST_TOOLS_TIMEOUT_MS / 1000}s`
      );

      this.clients.set(name, client);
      this.registry.setTools(name, tools);
      this.states.set(name, { name, status: 'connected', toolCount: tools.length });
      this.log.info(`connected to downstream "${name}", ${tools.length} tools`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.states.set(name, { name, status: 'unavailable', toolCount: 0, error: message });
      this.log.warn(`downstream "${name}" unavailable: ${message}`);
    }
  }

  private createTransport(name: string, cfg: DownstreamConfig): Transport {
    if ('url' in cfg) {
      return new StreamableHTTPClientTransport(new URL(cfg.url));
    }

    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: { ...getDefaultEnvironment(), ...cfg.env },
      stderr: 'pipe',
    });

    const stderrStream = transport.stderr;
    if (stderrStream) {
      let buffer = '';
      stderrStream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf-8');
        let idx: number;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          if (line.length > 0) {
            this.log.debug(`[downstream:${name}] ${line}`);
          }
        }
      });
    }

    return transport;
  }

  private async listAllTools(client: Client): Promise<Tool[]> {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : {});
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const client = this.clients.get(server);
    const state = this.states.get(server);

    if (!client || !state || state.status !== 'connected') {
      const available = [...this.states.values()]
        .filter((s) => s.status === 'connected')
        .map((s) => s.name);
      return {
        content: [
          {
            type: 'text',
            text: `Downstream server "${server}" is not available. Available servers: ${
              available.length > 0 ? available.join(', ') : '(none)'
            }`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await client.callTool({ name: tool, arguments: args });
      return result as CallToolResult;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error calling tool "${tool}" on server "${server}": ${message}` }],
        isError: true,
      };
    }
  }

  getServerStates(): ServerState[] {
    return [...this.states.values()];
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.clients.entries()].map(async ([name, client]) => {
        try {
          await client.close();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.log.warn(`error closing downstream "${name}": ${message}`);
        }
      })
    );
  }
}
