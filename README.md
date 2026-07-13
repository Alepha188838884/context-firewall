# Context Firewall

[中文文档](./README.zh.md)

**Turn 50+ MCP tools into 3, and shrink tool outputs by up to 90% — for any MCP client, any model.**

Context Firewall is a local MCP proxy that sits between your AI agent (Claude Code, Claude Desktop, Cursor, Cline, ...) and every downstream MCP server you've configured. It exposes exactly 4 tools to the client, no matter how many tools the downstream servers actually have, and compresses large tool outputs (raw HTML, base64 blobs, giant JSON) before they ever reach the model's context window.

## What it does

- **Progressive tool disclosure** — instead of loading every downstream tool's full schema at startup, the client sees 4 meta-tools (`list_tool_categories`, `search_tools`, `invoke_tool`, `read_more`) and only pays the token cost of a tool's full schema when it actually searches for it.
- **Output compression pipeline** — large tool results are run through base64 stripping, HTML→Markdown conversion, JSON structure-aware summarization, and finally character-budget truncation, in that order, before being returned.
- **Full output retrievable via `read_more`** — nothing is silently thrown away. Every compressed output is stored in full (in memory, opaque handle) and can be paged back with `read_more(handle, offset, length)`.
- **Session savings report** — on shutdown, prints a shareable terminal card (and optional Markdown file) showing tool-definition and output-token savings for the session, plus a breakdown of which tools saved the most.

## Quickstart

```bash
npx context-firewall --config context-firewall.json
```

Minimal `context-firewall.json` (the `downstreams` block mirrors the `mcpServers` format you already know):

```json
{
  "downstreams": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

### Claude Code / Claude Desktop

Point your existing `mcpServers` config at Context Firewall as the *only* MCP server, and let it own every downstream connection:

```json
{
  "mcpServers": {
    "context-firewall": {
      "command": "npx",
      "args": ["-y", "context-firewall", "--config", "/absolute/path/to/context-firewall.json"]
    }
  }
}
```

Your agent now sees 4 tools instead of the sum of every downstream server's tool count.

## Configuration

### `downstreams`

Each entry is either a **stdio** server (same shape as `mcpServers`) or a **Streamable HTTP** server:

```json
{
  "downstreams": {
    "local-tool": { "command": "npx", "args": ["-y", "some-mcp-server"], "env": { "TOKEN": "${TOKEN}" } },
    "remote-tool": { "url": "https://mcp.example.com/mcp", "transport": "streamable-http" }
  }
}
```

`${VAR_NAME}` in any string value is expanded from the environment; a missing variable fails config load with a readable error.

### `compression`

Policy resolution order is `default` < `perServer` < `perTool` (later overrides earlier, field by field):

```json
{
  "compression": {
    "default": {
      "maxOutputTokens": 2000,
      "htmlToMarkdown": true,
      "stripBase64": true,
      "jsonSummary": true,
      "bypass": false
    },
    "perServer": { "github": { "maxOutputTokens": 4000 } },
    "perTool": { "filesystem/read_file": { "maxOutputTokens": 8000 } }
  }
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `maxOutputTokens` | number | `2000` | Soft budget (chars ≈ tokens × 3.5) a compressed output is truncated to as a last resort. |
| `htmlToMarkdown` | boolean | `true` | Convert detected HTML markup to Markdown. |
| `stripBase64` | boolean | `true` | Replace base64 blobs (data URIs and bare blocks) with a `read_more` handle. |
| `jsonSummary` | boolean | `true` | Collapse homogeneous JSON arrays and trim long string fields, keeping valid JSON. |
| `bypass` | boolean | `false` | Skip the whole pipeline for this server/tool - output passes through untouched. |

### `report`

```json
{
  "report": {
    "enabled": true,
    "markdownPath": "./context-firewall-report.md"
  }
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Print the session report to stderr on shutdown. |
| `markdownPath` | string | *(none)* | If set, also write the report as a Markdown file at this path. |

### `callToolTimeoutMs`

Top-level (not nested under `compression`). Per-`invoke_tool` timeout in milliseconds passed to the downstream MCP SDK client; a downstream that hangs without responding causes `invoke_tool` to return an `isError` result once this elapses, instead of blocking. Defaults to the SDK's own default (60,000ms) when unset.

```json
{ "callToolTimeoutMs": 30000 }
```

## How it works

The client calls `list_tool_categories()` to see what's connected and what it's roughly capable of, `search_tools(query)` to pull the full input schema for candidate tools, `invoke_tool(server, tool, args)` to actually run one (compressed on the way back), and `read_more(handle, offset, length)` to page through anything that got compressed. Compression, when it runs, always applies in the same order: strip base64 → HTML to Markdown → JSON structure summary → truncate to budget. Security-relevant outputs (errors, permission/warning/confirmation messages) are never silently compressed - they pass straight through, only hard-capped at 50,000 characters to prevent a single runaway error dump from blowing out the caller's context.

## Positioning

Context Firewall **complements** Anthropic's Tool Search Tool, it doesn't compete with it. Tool Search solves tool *definition* bloat at startup (the schemas loaded into context before any tool is even called), and is Claude-specific. Context Firewall compresses tool *outputs* at call time - the half of the problem Tool Search doesn't touch - and works with any MCP client and any model, not just Claude.

## A note on token counts

Every token count in this project (truncation budgets, the session report) is estimated as `chars / 3.5`, never an exact model-specific count. There is no code path that sends your tool output content to an external API to get an exact count - that would conflict with the safety posture below. The session report is always labeled "(estimated)" for this reason.

## Safety

- Tool arguments and output content are never written to logs or the session report - only server/tool names and character/token counts.
- Security-relevant outputs (errors, permission denials, warnings, confirmations) are never silently compressed.
- Downstream tool descriptions are treated as untrusted input and only ever displayed, never executed.

## License

MIT
