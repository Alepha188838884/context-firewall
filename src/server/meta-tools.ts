import { z } from 'zod';

/**
 * Pure data: name / description / inputSchema (zod raw shape) for the 4 meta-tools exposed
 * by the gateway. Descriptions are kept compact but explain the intended workflow, since
 * they themselves consume tokens in the calling agent's context.
 */

export const LIST_TOOL_CATEGORIES = {
  name: 'list_tool_categories',
  description:
    'List all downstream MCP servers with status, tool counts, and capability categories. Call this first to discover what is available.',
  inputSchema: {},
};

export const SEARCH_TOOLS = {
  name: 'search_tools',
  description:
    'Search downstream tools by keyword; returns full input schemas for matches. Use before invoke_tool.',
  inputSchema: {
    query: z.string().describe('keywords to match against tool names and descriptions'),
    limit: z.number().optional(),
  },
};

export const INVOKE_TOOL = {
  name: 'invoke_tool',
  description:
    'Invoke a downstream tool. Large outputs are compressed; full output retrievable via read_more with the returned handle.',
  inputSchema: {
    server: z.string(),
    tool: z.string(),
    args: z.record(z.unknown()).optional(),
  },
};

export const READ_MORE = {
  name: 'read_more',
  description: 'Retrieve a slice of a stored full output by handle (character offsets).',
  inputSchema: {
    handle: z.string(),
    offset: z.number().optional(),
    length: z.number().optional(),
  },
};
