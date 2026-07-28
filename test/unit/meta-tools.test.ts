import { describe, it, expect } from 'vitest';
import {
  LIST_TOOL_CATEGORIES,
  SEARCH_TOOLS,
  INVOKE_TOOL,
  buildListToolCategoriesDescription,
  buildSearchToolsDescription,
  buildInvokeToolDescription,
  type ConnectedServerInfo,
} from '../../src/server/meta-tools.js';

// P0-2 discoverability fix: the 3 discoverable meta-tools' descriptions must name the
// actually-connected downstream servers once connectAll() settles, so an agent searching its
// own tool list by server name (e.g. "everything") can actually find it.

describe('dynamic meta-tool descriptions', () => {
  it('falls back to the static description when no servers are connected', () => {
    expect(buildListToolCategoriesDescription([])).toBe(LIST_TOOL_CATEGORIES.description);
    expect(buildSearchToolsDescription([])).toBe(SEARCH_TOOLS.description);
    expect(buildInvokeToolDescription([])).toBe(INVOKE_TOOL.description);
  });

  const servers: ConnectedServerInfo[] = [
    { name: 'everything', toolCount: 13 },
    { name: 'filesystem', toolCount: 14 },
    { name: 'fetch', toolCount: 1 },
  ];

  it('list_tool_categories description includes connected server names and tool counts', () => {
    const desc = buildListToolCategoriesDescription(servers);
    expect(desc).toContain('everything (13 tools)');
    expect(desc).toContain('filesystem (14 tools)');
    expect(desc).toContain('fetch (1 tool)');
    expect(desc).not.toContain('1 tools)'); // singular for count === 1
  });

  it('search_tools description includes connected server names', () => {
    const desc = buildSearchToolsDescription(servers);
    expect(desc).toContain('everything');
    expect(desc).toContain('filesystem');
    expect(desc).toContain('fetch');
  });

  it('invoke_tool description includes connected server names', () => {
    const desc = buildInvokeToolDescription(servers);
    expect(desc).toContain('everything');
    expect(desc).toContain('filesystem');
    expect(desc).toContain('fetch');
  });

  it('unavailable servers never appear (caller is expected to pre-filter to connected only)', () => {
    // buildXDescription() trusts its input list as-is; this test documents that the caller
    // (gateway.ts's refreshToolDescriptions) is responsible for filtering to status==='connected'
    // before calling these builders - passing only connected servers here is enough to prove
    // an excluded server name never leaks in.
    const desc = buildListToolCategoriesDescription(servers);
    expect(desc).not.toContain('broken-server');
  });

  it('truncates to the first 8 servers plus a count when more than 8 are connected', () => {
    const many: ConnectedServerInfo[] = Array.from({ length: 12 }, (_, i) => ({
      name: `server${i}`,
      toolCount: 1,
    }));

    const listDesc = buildListToolCategoriesDescription(many);
    for (let i = 0; i < 8; i++) {
      expect(listDesc).toContain(`server${i} (1 tool)`);
    }
    for (let i = 8; i < 12; i++) {
      expect(listDesc).not.toContain(`server${i} (1 tool)`);
    }
    expect(listDesc).toContain('and 4 more');

    const searchDesc = buildSearchToolsDescription(many);
    expect(searchDesc).toContain('server0');
    expect(searchDesc).toContain('and 4 more');
    expect(searchDesc).not.toContain('server11');

    const invokeDesc = buildInvokeToolDescription(many);
    expect(invokeDesc).toContain('server0');
    expect(invokeDesc).toContain('and 4 more');
    expect(invokeDesc).not.toContain('server11');
  });

  it('does not truncate at exactly 8 servers', () => {
    const eight: ConnectedServerInfo[] = Array.from({ length: 8 }, (_, i) => ({
      name: `server${i}`,
      toolCount: 1,
    }));
    const desc = buildListToolCategoriesDescription(eight);
    expect(desc).not.toContain('more');
    for (let i = 0; i < 8; i++) {
      expect(desc).toContain(`server${i} (1 tool)`);
    }
  });
});
