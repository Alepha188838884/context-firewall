import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export interface ToolEntry {
  server: string;
  name: string;
  description: string;
  inputSchema: unknown;
}

const VERB_PREFIXES = new Set(['get', 'list', 'create', 'update', 'delete', 'search', 'read', 'write']);

function splitWords(name: string): string[] {
  const withBoundaries = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  return withBoundaries
    .split(/[_\-\s]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 0);
}

function categoryWord(name: string): string | undefined {
  const words = splitWords(name);
  if (words.length === 0) {
    return undefined;
  }
  const [first, second] = words;
  if (VERB_PREFIXES.has(first) && second) {
    return second;
  }
  return first;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Pure in-memory index of downstream tools. No IO - tools are pushed in via setTools()
 * by whoever owns the actual MCP connections.
 */
export class ToolRegistry {
  private serverTools = new Map<string, Map<string, ToolEntry>>();

  setTools(server: string, tools: Tool[]): void {
    const map = new Map<string, ToolEntry>();
    for (const tool of tools) {
      map.set(tool.name, {
        server,
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
      });
    }
    this.serverTools.set(server, map);
  }

  getTool(server: string, name: string): ToolEntry | undefined {
    return this.serverTools.get(server)?.get(name);
  }

  getAllTools(): ToolEntry[] {
    const result: ToolEntry[] = [];
    for (const map of this.serverTools.values()) {
      result.push(...map.values());
    }
    return result;
  }

  /**
   * Heuristic grouping of a server's tool names into up to 6 category words, most frequent first.
   * Strips a known verb prefix (get/list/create/update/delete/search/read/write) and uses the
   * following word as the category noun; falls back to the first word when there's no prefix
   * to strip or no word follows it.
   */
  categorize(server: string): string[] {
    const tools = this.serverTools.get(server);
    if (!tools) {
      return [];
    }

    const counts = new Map<string, number>();
    for (const tool of tools.values()) {
      const category = categoryWord(tool.name);
      if (!category) {
        continue;
      }
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([word]) => word);
  }

  /**
   * Keyword search across all indexed tools. Query words matching a tool's name (or its
   * split sub-words) score +3 each, matching the description scores +1 each. Tools with no
   * word-level hits fall back to a plain substring check on the whole query (+0.5) so
   * near-misses still surface below real matches.
   */
  searchTools(query: string, limit = 5): ToolEntry[] {
    const queryWords = tokenize(query);
    const rawQuery = query.toLowerCase().trim();

    const scored: { entry: ToolEntry; score: number }[] = [];
    for (const entry of this.getAllTools()) {
      const nameTokens = new Set([entry.name.toLowerCase(), ...splitWords(entry.name)]);
      const descTokens = new Set(tokenize(entry.description));

      let score = 0;
      for (const word of queryWords) {
        if (nameTokens.has(word)) {
          score += 3;
        }
        if (descTokens.has(word)) {
          score += 1;
        }
      }

      if (score === 0 && rawQuery.length > 0) {
        if (entry.name.toLowerCase().includes(rawQuery) || entry.description.toLowerCase().includes(rawQuery)) {
          score = 0.5;
        }
      }

      if (score > 0) {
        scored.push({ entry, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.entry);
  }
}
