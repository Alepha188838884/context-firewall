import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../src/downstream/registry.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';

function tool(name: string, description: string): Tool {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
  };
}

const GITHUB_TOOLS: Tool[] = [
  tool('create_issue', 'Create a new issue in a GitHub repository'),
  tool('list_issues', 'List issues in a GitHub repository'),
  tool('get_issue', 'Get details of a specific issue'),
  tool('create_pull_request', 'Create a new pull request'),
  tool('list_pull_requests', 'List pull requests in a repository'),
  tool('merge_pull_request', 'Merge a pull request'),
  tool('get_file_contents', 'Get the contents of a file from a repository'),
  tool('push_files', 'Push one or more files to a repository branch'),
  tool('search_repositories', 'Search for GitHub repositories'),
  tool('search_code', 'Search for code across GitHub repositories'),
];

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registry.setTools('github', GITHUB_TOOLS);
  });

  describe('getTool / getAllTools', () => {
    it('retrieves a tool by exact server + name', () => {
      const entry = registry.getTool('github', 'get_issue');
      expect(entry).toEqual({
        server: 'github',
        name: 'get_issue',
        description: 'Get details of a specific issue',
        inputSchema: { type: 'object', properties: {} },
      });
    });

    it('returns undefined for an unknown tool or server', () => {
      expect(registry.getTool('github', 'does_not_exist')).toBeUndefined();
      expect(registry.getTool('unknown-server', 'get_issue')).toBeUndefined();
    });

    it('getAllTools returns every tool across every server', () => {
      registry.setTools('filesystem', [tool('read_file', 'Read a file from disk')]);
      const all = registry.getAllTools();
      expect(all).toHaveLength(GITHUB_TOOLS.length + 1);
      expect(all.some((t) => t.server === 'filesystem' && t.name === 'read_file')).toBe(true);
    });
  });

  describe('categorize', () => {
    it('produces reasonable category words for real-world tool names', () => {
      const categories = registry.categorize('github');
      expect(categories.length).toBeGreaterThan(0);
      expect(categories.length).toBeLessThanOrEqual(6);
      expect(categories).toContain('issue');
      expect(categories).toContain('pull');
      expect(categories).toContain('file');
      // All returned words should be lowercase.
      for (const word of categories) {
        expect(word).toBe(word.toLowerCase());
      }
    });

    it('ranks category words by frequency, most common first', () => {
      const categories = registry.categorize('github');
      // "issue" (create_issue, get_issue) and "pull" (create_pull_request,
      // list_pull_requests) each occur twice - more than any other category.
      expect(categories.slice(0, 2).sort()).toEqual(['issue', 'pull']);
    });

    it('returns an empty array for an unknown server', () => {
      expect(registry.categorize('unknown-server')).toEqual([]);
    });
  });

  describe('searchTools', () => {
    it('ranks a name hit above a description-only hit', () => {
      const local = new ToolRegistry();
      local.setTools('svc', [
        tool('get_issue', 'Fetch a single record'),
        tool('track_ticket', 'Look up an issue in the tracker'),
      ]);

      const results = local.searchTools('issue');
      expect(results.map((r) => r.name)).toEqual(['get_issue', 'track_ticket']);
    });

    it('scores multi-word queries by summing per-word hits', () => {
      const results = registry.searchTools('pull request merge');
      expect(results[0]?.name).toBe('merge_pull_request');
    });

    it('falls back to substring containment when no word-level hits exist', () => {
      const results = registry.searchTools('repositor', 10);
      const names = results.map((r) => r.name);
      expect(names).toContain('search_repositories');
    });

    it('returns full ToolEntry objects including inputSchema', () => {
      const results = registry.searchTools('issue', 1);
      expect(results[0]).toHaveProperty('inputSchema');
      expect(results[0]).toHaveProperty('server', 'github');
    });

    it('respects the limit parameter', () => {
      const results = registry.searchTools('repository', 2);
      expect(results.length).toBeLessThanOrEqual(2);
    });

    it('returns an empty array when nothing matches at all', () => {
      const results = registry.searchTools('zzz_totally_unrelated_xyz');
      expect(results).toEqual([]);
    });
  });
});
