# Context Firewall

[中文文档](./README.zh.md)

**Turn 50+ MCP tools into 4, and shrink large tool outputs by 60–95% (real HTML/JSON, measured — see [benchmark](./STATE.md)) — for any MCP client, any model.** Any output still over your configured token budget after compression is hard-truncated to that budget, with the full original retrievable via `read_more`.

Context Firewall is a local MCP proxy that sits between your AI agent (Claude Code, Claude Desktop, Cursor, Cline, ...) and every downstream MCP server you've configured. It exposes exactly 4 tools to the client, no matter how many tools the downstream servers actually have, and compresses large tool outputs (raw HTML, base64 blobs, giant JSON) before they ever reach the model's context window.

## Measured results

| Metric | Result |
| --- | --- |
| Tool collapse | **122 → 4** exposed meta-tools (5 real downstream servers incl. official GitHub `github-mcp-server`, 85 tools) |
| Tool-definition savings | **~28,600 tokens** *(estimated, chars ÷ 3.5)* — 102,158 raw definition chars vs. 2,146 exposed |
| Output compression | **60–95%+** on real-world HTML/JSON, e.g. a live Wikipedia page via the `fetch` tool: 232,391 → 6,907 chars (**97.0%**, measured); a GitHub issues JSON payload via the `jsonSummary` stage: 186,810 → 3,480 chars (**98.1%**, measured) |

All figures measured against real downstream MCP servers, not synthetic data — see [STATE.md](./STATE.md) ("P1-1 — github server portion" section) for full methodology.

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
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
    }
  }
}
```

(`${GITHUB_TOKEN}` above is just this example's environment variable *name* — pick whatever's already set in your shell; it gets expanded into `GITHUB_PERSONAL_ACCESS_TOKEN`, the env var name the downstream server itself actually reads.)

**Which GitHub server?** Two options, different tool counts:

- **`@modelcontextprotocol/server-github`** (used above) — the original npm package, 26 tools, one `npx -y` line, zero extra setup. Archived/no longer maintained upstream, but still functional.
- **[`github/github-mcp-server`](https://github.com/github/github-mcp-server)** — the actively-maintained official server, 44 tools (default toolset) to 85 (`GITHUB_TOOLSETS=all`). Ships as a Go binary or Docker image, not an npm package:

  ```json
  "github": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}" }
  }
  ```

  or, running a locally-built/downloaded binary directly: `"command": "/path/to/github-mcp-server", "args": ["stdio"]` (same `env` block; add `GITHUB_TOOLSETS` to scope which of the 85 tools are exposed).

**Per-tool allow/deny policy.** Add `allowTools`/`denyTools` (array of exact names or `*` globs) to any downstream entry to restrict which of its tools can be invoked:

```json
"github": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "denyTools": ["delete_*"]
}
```

Deny always wins over allow. When `allowTools` is set, only matching tools are permitted; everything else on that server is blocked. An empty `allowTools: []` is treated the same as omitting it (allow everything), not "deny everything". Blocked tools are hidden from `search_tools` results, and `invoke_tool` rejects them before dispatching to the downstream server. Tool counts in `list_tool_categories` and in the meta-tool descriptions are unfiltered totals — the policy is only enforced at `search_tools`/`invoke_tool` time.

## Client setup

**Set Context Firewall as your only MCP server** — move every downstream server you currently configure directly (filesystem, github, everything, ...) into `context-firewall.json`'s `downstreams` block instead. Your agent then sees 4 tools instead of the sum of every downstream server's tool count; pointing the client at Context Firewall *alongside* your existing servers doesn't give you the tool-collapse or compression benefit.

Each client below takes the same server entry:

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

### Claude Code

Project-scoped `.mcp.json` in your repo root (shown above), or via the CLI:

```bash
claude mcp add --transport stdio context-firewall -- npx -y context-firewall --config /absolute/path/to/context-firewall.json
```

### Claude Desktop

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`) — same `mcpServers` block as above.

### Cursor

`.cursor/mcp.json` (project-scoped) or `~/.cursor/mcp.json` (global) — same `mcpServers` block as above.

### Cline

`cline_mcp_settings.json` (VS Code extension storage; macOS: `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json`) — same `mcpServers` block as above.

### Compatibility status

| Client | Status |
| --- | --- |
| Claude Code | **tested in real agent sessions** — autonomous list → search → invoke → read_more workflow verified end-to-end |
| Claude Desktop | protocol-verified* |
| Cursor | config format documented, community testing welcome |
| Cline | config format documented, community testing welcome |

\* Verified via MCP protocol integration tests (176 automated tests, including full stdio protocol round-trips against real downstream servers). Real-client reports welcome.

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
      "llmSummary": false,
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
| `llmSummary` | boolean | `false` | Semantically summarize over-budget outputs with an LLM of your choice. Requires the top-level `llm` block - see [LLM summarization (opt-in)](#llm-summarization-opt-in). |
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

The client calls `list_tool_categories()` to see what's connected and what it's roughly capable of, `search_tools(query)` to pull the full input schema for candidate tools, `invoke_tool(server, tool, args)` to actually run one (compressed on the way back), and `read_more(handle, offset, length)` to page through anything that got compressed. Compression, when it runs, always applies in the same order: strip base64 → HTML to Markdown → JSON structure summary → truncate to budget (if the opt-in LLM summarization stage below is enabled, it runs right before truncation). Security-relevant outputs (errors, permission/warning/confirmation messages) are never silently compressed - they pass straight through, only hard-capped at 50,000 characters to prevent a single runaway error dump from blowing out the caller's context.

## LLM summarization (opt-in)

The deterministic pipeline can strip markup, collapse repetitive structure, and truncate - but it cannot *semantically* compress a long natural-language output (a log file, an article, a report): once the deterministic stages are done, anything still over budget just gets cut off. This optional stage fills that gap: it sends the over-budget text to a model of your choice for a factual summary (preserving IDs, paths, URLs, numbers, and error messages), appends a `read_more` pointer to the untouched full original, and leaves truncation in place as the final backstop. It is **off by default** and requires explicit opt-in at two separate layers: a top-level `llm` block *and* `llmSummary: true` in a compression policy. Any OpenAI-compatible `/chat/completions` endpoint works.

```json
{
  "llm": {
    "baseUrl": "https://api.your-provider.example/v1",
    "apiKey": "${LLM_API_KEY}",
    "model": "your-model-name"
  },
  "compression": {
    "default": { "llmSummary": true }
  }
}
```

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `baseUrl` | string | *(required)* | Base URL of any OpenAI-compatible endpoint; the stage POSTs to `<baseUrl>/chat/completions`. |
| `apiKey` | string | *(required)* | Sent as `Authorization: Bearer ...`. Use `${ENV_VAR}` expansion - never put a literal key in the config file. |
| `model` | string | *(required)* | Model name passed through to the endpoint verbatim. |
| `timeoutMs` | number | `20000` | Abort the request after this long; on timeout the stage no-ops. |
| `maxInputChars` | number | `120000` | Head-truncate the text sent to the API to this many chars (hard absolute cap: 400,000, regardless of config - cost protection). |

Example with [OrcaRouter](https://orcarouter.ai) - works well with free models:

```json
{
  "llm": {
    "baseUrl": "https://api.orcarouter.ai/v1",
    "apiKey": "${ORCA_KEY}",
    "model": "meta-llama/llama-3.3-70b-instruct:free"
  },
  "compression": {
    "default": { "llmSummary": true }
  }
}
```

**Failure mode**: if the endpoint is down, unreachable, times out, or returns anything malformed, the stage silently no-ops and the output falls back to deterministic truncation - an unavailable endpoint never breaks your tools.

**Privacy**: enabling this sends over-budget, non-security-sensitive tool outputs to the endpoint you configure - and nothing else, nowhere else. Security-sensitive outputs (errors, permission denials, warnings, confirmations) bypass the compression pipeline before this stage exists and are never sent. Don't enable this if sending tool output content to that endpoint is not acceptable for your data.

### Disclosure

Context Firewall participates in the OrcaRouter Open Source Program: if you choose OrcaRouter as your endpoint, this project receives 5% of the resulting usage revenue. This does not change your pricing, is entirely optional, and any OpenAI-compatible provider works identically.

## Positioning

Context Firewall **complements** Anthropic's Tool Search Tool, it doesn't compete with it. Tool Search solves tool *definition* bloat at startup (the schemas loaded into context before any tool is even called), and is Claude-specific. Context Firewall compresses tool *outputs* at call time - the half of the problem Tool Search doesn't touch - and works with any MCP client and any model, not just Claude.

## A note on token counts

Every token count in this project (truncation budgets, the session report) is estimated as `chars / 3.5`, never an exact model-specific count. By default, there is no code path that sends your tool output content to an external API - not for token counting, not for anything else. If you explicitly enable the optional [LLM summarization stage](#llm-summarization-opt-in), over-budget outputs are sent to the endpoint **you** configure - and nothing else, nowhere else; token counting stays local either way. The session report is always labeled "(estimated)" for this reason.

## Safety

- Tool arguments and output content are never written to logs or the session report - only server/tool names and character/token counts.
- Security-relevant outputs (errors, permission denials, warnings, confirmations) are never silently compressed.
- By default, tool output content never leaves your machine (beyond the downstream servers you configured). The opt-in [LLM summarization stage](#llm-summarization-opt-in) is the only code path that can send it anywhere else, it is off by default, and security-sensitive outputs never reach it.
- Downstream tool descriptions are treated as untrusted input and only ever displayed, never executed.
- Downstream tool descriptions are passed through verbatim, unsanitized - `search_tools` does not strip or filter prompt-injection text a malicious downstream might put there. The trust boundary is which downstream servers you choose to configure, not this gateway.
- Progressive disclosure has a real tradeoff: tool descriptions arrive on demand, mid-session, right when the calling model actively asks for them via `search_tools` - which is also when a model is least likely to scrutinize an embedded instruction, compared to tools all being presented up front at session start. As of v0.3.0 this is mitigated two ways: `search_tools` results are wrapped in `<untrusted-tool-descriptions nonce="...">...</untrusted-tool-descriptions nonce="...">` delimiters carrying a random nonce generated once per process at startup (`crypto.randomBytes(8).toString('hex')`, fixed for the process's whole lifetime), with a note telling the model that only a closing tag carrying the matching nonce ends the block; and the CLI prints a human-readable digest to stderr on startup (server names, tool counts, top categories) so an operator can see at a glance what actually got connected. The nonce specifically defeats the literal bypass where a downstream embeds its own `</untrusted-tool-descriptions>` string followed by forged "trusted system" instructions in its description - it can't predict the nonce, so it can't forge a matching closing tag. **Residual risk**: this is still a text-level convention, not a sandbox - it depends on the calling model actually reading the note and honoring the nonce match; nothing stops a model from ignoring the framing altogether. Neither mitigation sanitizes the description content itself - see the point above. The delimiter framing now costs about 80-85 tokens per `search_tools` call (~289 characters, at this project's chars/3.5 estimate).
- The categories shown by `list_tool_categories` are also derived from downstream-supplied data (tool names, via a crude verb-prefix heuristic in `registry.ts`) - but a tool name is a far lower-bandwidth channel for smuggling instructions than a free-text description, and this output isn't wrapped in the delimiters above. Treat it as lower-risk than `search_tools` output, not risk-free.

## License

MIT
