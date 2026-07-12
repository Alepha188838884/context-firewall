import { describe, it, expect, vi } from 'vitest';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { paginateListTools, type ListToolsClient } from '../../src/downstream/manager.js';
import type { Logger } from '../../src/log.js';

function mockLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function tool(name: string): Tool {
  return { name, description: '', inputSchema: { type: 'object', properties: {} } };
}

describe('paginateListTools', () => {
  it('follows nextCursor across pages and stops when it is undefined', async () => {
    const pages: Record<string, { tools: Tool[]; nextCursor?: string }> = {
      start: { tools: [tool('a'), tool('b')], nextCursor: 'page2' },
      page2: { tools: [tool('c')], nextCursor: undefined },
    };
    const client: ListToolsClient = {
      listTools: vi.fn(async ({ cursor }) => pages[cursor ?? 'start']),
    };
    const logger = mockLogger();

    const tools = await paginateListTools(client, logger, 'srv');

    expect(tools.map((t) => t.name)).toEqual(['a', 'b', 'c']);
    expect(client.listTools).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns an empty array when the first page has no tools and no cursor', async () => {
    const client: ListToolsClient = {
      listTools: vi.fn(async () => ({ tools: [] })),
    };
    const tools = await paginateListTools(client, mockLogger(), 'srv');
    expect(tools).toEqual([]);
  });

  it('regression (A6): stops after 100 pages and warns, instead of looping forever on a downstream that echoes a constant cursor', async () => {
    const client: ListToolsClient = {
      listTools: vi.fn(async () => ({ tools: [tool('x')], nextCursor: 'same-cursor-forever' })),
    };
    const logger = mockLogger();

    const tools = await paginateListTools(client, logger, 'malicious-server');

    expect(client.listTools).toHaveBeenCalledTimes(100);
    expect(tools).toHaveLength(100); // one tool per page, 100 pages
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('malicious-server'));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('100 pages'));
  });
});
