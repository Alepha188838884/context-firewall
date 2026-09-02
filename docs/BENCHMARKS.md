# Benchmarks

All numbers below were measured against **real downstream MCP servers and real web/API payloads**, using the unmodified production code path (`DownstreamManager` → gateway → compression pipeline) wired to an in-memory MCP client/server pair, with per-call stats captured exactly the way the session report captures them. Nothing here is synthetic-data marketing.

Token counts are always estimated as `chars ÷ 3.5` — this project never sends content to a tokenizer API (see [README — A note on token counts](../README.md#a-note-on-token-counts)).

Measurement dates: 2026-07-13 and 2026-07-28.

---

## 1. Tool-definition savings

**Setup**: 5 real downstream servers — `@modelcontextprotocol/server-filesystem`, `server-everything`, `server-memory`, `mcp-server-fetch` (Python, via `uvx`), and the actively-maintained official [`github/github-mcp-server`](https://github.com/github/github-mcp-server) with `GITHUB_TOOLSETS=all`.

| Server | Status | Tools |
| --- | --- | ---: |
| filesystem | connected | 14 |
| everything | connected | 13 |
| memory | connected | 9 |
| fetch | connected | 1 |
| github | connected | 85 |
| **Total** | **5/5 connected** | **122 → 4 exposed meta-tools** |

| Metric | Value |
| --- | --- |
| Raw downstream tool definitions | 102,158 chars (~29,188 tokens) — github alone is ~81% of this |
| Exposed meta-tool definitions | 2,146 chars (~614 tokens) — constant, independent of downstream count |
| **Definition savings** | **~28,600 tokens** |
| `list_tool_categories` response size | 579 chars (~166 tokens) |

**Savings scale with your setup** — they are a function of how many downstream tools you have and how big their schemas are:

| Configuration | Total tools | Definition savings |
| --- | ---: | ---: |
| 5 servers, github `GITHUB_TOOLSETS=all` | 122 | ~28,600 tokens |
| 5 servers, github default toolset | 81 | ~17,100 tokens |
| 4 servers, no github | 37 | ~4,800 tokens |

These savings are paid back on **every single request**, since tool definitions are re-sent with the full context each turn.

## 2. Output compression

Two numbers matter, and they answer different questions:

- **Stage-only** — what the *smart* compression stages (HTML→Markdown, JSON structural summarization) achieve by themselves. This is the honest "compression" number.
- **End-to-end** — what the agent actually receives with the default `maxOutputTokens: 2000` budget. Here the final character-budget truncation acts as a hard backstop, so totals land at 96–99% regardless of content. That's a cap, not compression — and the full original always stays retrievable via `read_more`.

### HTML → Markdown (stage-only, 5 real pages)

| Page | Original chars | After stage | Reduction |
| --- | ---: | ---: | ---: |
| bbc.com/news | 402,276 | 28,818 | 92.8% |
| github.com (repo page) | 362,849 | 24,194 | 93.3% |
| react.dev | 272,428 | 16,773 | 93.8% |
| en.wikipedia.org (article) | 232,224 | 70,385 | 69.7% |
| developer.mozilla.org (article) | 201,370 | 60,291 | 70.1% |

### JSON structural summarization (stage-only, real API payloads)

| Payload | Shape | Original chars | After stage | Reduction |
| --- | --- | ---: | ---: | ---: |
| `api.github.com` issues, 100 items | homogeneous array | 581,389 | 16,241 | 97.2% |
| `registry.npmjs.org/react` full doc | huge keyed map (~2,000 versions) | 6,787,766 | 212,087 | 96.9% |
| `github/list_issues` via `invoke_tool` (real MCP call) | homogeneous array | 186,810 | 3,480 | 98.1% |

Output stays **valid JSON** after summarization (verified by re-parsing): homogeneous arrays/maps are folded to representative items plus a `(N more…)` marker carrying the `read_more` handle.

### End-to-end (default policy, what the agent receives)

Every sample above, plus live fetches through the real `mcp-server-fetch` tool, lands at ≤ ~6,910 chars (the 2,000-token budget) with the full original stored and pageable via `read_more(handle, offset, length)`. Example: a live Wikipedia page fetched through `fetch/fetch` — 232,391 → 6,907 chars (97.0%).

### Main-content extraction (v0.4.0)

Compression ratio isn't the whole story — *what survives the truncation window* matters as much as how small it gets. Before v0.4.0, a chrome-heavy page like `bbc.com/news` compressed well but the ~7,000-char window filled up with nav links (`[Home](/)`, `[Sport](/sport)`, ...) before the first headline appeared. v0.4.0 adds deterministic main-content extraction before HTML→Markdown conversion: when a page has a recognizable content region (`<article>`/`<main>`), page chrome (nav, site headers/footers, hidden elements) is stripped first. Measured on the same real pages (2026-09-02):

| Page | Window content before | Window content after |
| --- | --- | --- |
| bbc.com/news (386 KB) | site nav links only, zero headlines | ~15 real headline + teaser blocks, zero nav |
| en.wikipedia.org (MCP article, 249 KB) | title + sidebar/nav chrome | infobox + article prose through the "Background"/"Features" sections |

Extraction is conservative: an over-stripping guard skips chrome removal whenever it would delete most of the page's actual text, and any extraction failure falls back to whole-page conversion — output is never worse than the pre-extraction behavior, and the full original stays retrievable via `read_more`.

## 3. Pipeline latency

In-process benchmark of `runPipeline()` (median of 5 runs, default policy, all stages enabled):

| Content | 100 KB | 1 MB | 10 MB |
| --- | ---: | ---: | ---: |
| HTML | 3.4 ms | 63.2 ms | 578.2 ms |
| JSON | 2.7 ms | 27.6 ms | 32.3 ms |
| Plain text | 1.4 ms | 13.8 ms | 11.4 ms |

Worst case — 10 MB of real HTML markup through turndown — stays under 600 ms. At realistic tool-output sizes the pipeline adds single-digit milliseconds.

## 4. Real agent session (Claude Code)

Headless Claude Code session with Context Firewall as the only MCP server (downstreams: everything + filesystem + fetch), tasks phrased by goal, never naming the meta-tools. Observed autonomous workflow from the transcript:

1. `list_tool_categories` → sees connected servers
2. `search_tools("echo2")` → no match → self-corrects to `search_tools("echo")` → `invoke_tool(everything/echo)` ✓
3. `invoke_tool(fetch/fetch)` on a real Wikipedia page → compressed (~3,561 tokens saved per the session report) → agent **autonomously** called `read_more("cf-0-d9f9", 6800, 15000)` to page through the remainder ✓

Session report: 28 → 4 tools, ~3,570 tokens definition savings, top-tools table populated.

## 5. Stability

- **30-minute soak** (2 downstreams, ~1 large-output call every 10 s + `read_more` + periodic `list_tool_categories`): 180 rounds, **0 errors**, RSS flat (84.5 → 57.7 MB), fd count constant at 22, **0 orphaned downstream processes** after exit.
- **Chaos suite** (automated, in CI): hanging downstreams, 10 MB outputs, malformed responses, broken-command downstreams, upstream pipe closed without signal — all handled without crashing the gateway or leaking child processes.
- 224 automated tests (unit + integration incl. real stdio round-trips against real downstream servers) run on every push.

## Methodology notes

- Harness: real `DownstreamManager` + gateway + pipeline code, unmodified, connected over `InMemoryTransport`; per-call `charsBefore`/`charsAfter`/`stagesApplied` captured via the same `CallStats` hook the session report uses.
- The 96–99% end-to-end figures are dominated by budget truncation, not smart compression — cite the stage-only numbers (70–94% HTML, ~97% structured JSON) when talking about the compression pipeline itself. We keep both because both are what a real agent experiences.
- Definition-savings claims always name the server count and toolset they were measured at (see the scaling table in §1) — a bare "saves tens of thousands of tokens" is only true at the 122-tool scale.
