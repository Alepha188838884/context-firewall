import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DownstreamManager } from '../downstream/manager.js';
import type { Logger } from '../log.js';
import { LIST_TOOL_CATEGORIES, SEARCH_TOOLS, INVOKE_TOOL, READ_MORE } from './meta-tools.js';

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Builds the upstream MCP server exposing the 4 meta-tools (list_tool_categories,
 * search_tools, invoke_tool, read_more) backed by the given DownstreamManager.
 */
export function createGateway(manager: DownstreamManager, logger: Logger): McpServer {
  const server = new McpServer({ name: 'context-firewall', version: '0.1.0' });
  const registry = manager.getRegistry();

  server.registerTool(
    LIST_TOOL_CATEGORIES.name,
    { description: LIST_TOOL_CATEGORIES.description, inputSchema: LIST_TOOL_CATEGORIES.inputSchema },
    (): CallToolResult => {
      logger.debug('list_tool_categories called');
      const servers = manager.getServerStates().map((state) => {
        if (state.status !== 'connected') {
          return { name: state.name, status: state.status, tools: 0, error: state.error };
        }
        return {
          name: state.name,
          status: state.status,
          tools: state.toolCount,
          categories: registry.categorize(state.name),
        };
      });
      return textResult(JSON.stringify({ servers }));
    }
  );

  server.registerTool(
    SEARCH_TOOLS.name,
    { description: SEARCH_TOOLS.description, inputSchema: SEARCH_TOOLS.inputSchema },
    ({ query, limit }): CallToolResult => {
      logger.debug(`search_tools called: query="${query}" limit=${limit ?? ''}`);
      const results = registry.searchTools(query, limit ?? 5);
      if (results.length === 0) {
        return textResult('no tools matched; try broader keywords or list_tool_categories');
      }
      return textResult(
        JSON.stringify(
          results.map((r) => ({
            server: r.server,
            name: r.name,
            description: r.description,
            inputSchema: r.inputSchema,
          }))
        )
      );
    }
  );

  server.registerTool(
    INVOKE_TOOL.name,
    { description: INVOKE_TOOL.description, inputSchema: INVOKE_TOOL.inputSchema },
    async ({ server: serverName, tool, args }): Promise<CallToolResult> => {
      logger.debug(`invoke_tool called: server="${serverName}" tool="${tool}"`);
      try {
        return await manager.callTool(serverName, tool, args ?? {});
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return textResult(`Error invoking tool "${tool}" on server "${serverName}": ${message}`, true);
      }
    }
  );

  server.registerTool(
    READ_MORE.name,
    { description: READ_MORE.description, inputSchema: READ_MORE.inputSchema },
    (): CallToolResult => {
      logger.debug('read_more called');
      return textResult('artifact store not yet wired', true);
    }
  );

  return server;
}
