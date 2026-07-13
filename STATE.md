# STATE.md — Context Firewall

Last updated: 2026-07-13. This file is the handoff document between sessions — read it before
doing anything, update it before ending a session.

## Project status (v0.1)

Pre-publish, feature-complete for v0.1 scope (design doc §6 MVP + most of v1.0). Build is clean
(`npm run build`, zero errors), test suite is green: **146 tests passing** (130 unit + 16
integration) across 14 test files. Includes a full P1-2 chaos/robustness suite (see below).

Modules implemented:

- `src/cli.ts` — entrypoint: arg parsing, config load, gateway wiring, idempotent shutdown
  (SIGINT/SIGTERM/transport.onclose), session report printing.
- `src/config.ts` — JSON config load + zod validation, `${ENV_VAR}` expansion, policy resolution
  (`default` < `perServer` < `perTool`).
- `src/downstream/manager.ts` — connection pool for N downstream MCP servers (stdio +
  Streamable HTTP), per-server connect failures isolated (never fail `connectAll()` as a whole),
  paginated `listTools()` via the exported `paginateListTools()` helper.
- `src/downstream/registry.ts` — in-memory tool index: category heuristic, keyword search.
- `src/server/gateway.ts` + `src/server/meta-tools.ts` — the 4 exposed meta-tools
  (`list_tool_categories`, `search_tools`, `invoke_tool`, `read_more`).
- `src/pipeline/` — compression pipeline: `base64.ts`, `html.ts`, `json-summary.ts`,
  `truncate.ts`, `safety.ts` (security-sensitive bypass), `index.ts` (`runPipeline` orchestrator).
- `src/artifacts.ts` — in-memory full-output store (FIFO eviction by count/bytes, lazy TTL reap).
- `src/report.ts` — session savings report (terminal card + Markdown), always labeled
  "(estimated)"; includes a "Top tools by savings" breakdown.
- `src/tokens.ts` — `estimateTokens()` only (chars/3.5). No API-backed exact counting - see
  "Explicitly cut" below.

Publish-blocking gaps: none known. Remaining items are post-publish distribution work (see
Follow-ups below).

## Verified SDK facts

- `McpServer.registerTool(name, { description, inputSchema }, handler)` accepts a **zod raw
  shape** (plain object of zod schemas) for `inputSchema`, not a compiled `z.object(...)` —
  confirmed working in `src/server/gateway.ts` / `src/server/meta-tools.ts`.
- `StdioClientTransport`'s `env` option does **not** fully inherit the parent process
  environment — you must explicitly merge `getDefaultEnvironment()` with your own `env`
  overrides (`{ ...getDefaultEnvironment(), ...cfg.env }` in `manager.ts`), or downstream
  servers spawned via stdio can fail to find `PATH`/etc.
- `client.listTools({ cursor })` follows the standard MCP cursor-pagination contract
  (`result.nextCursor` present ⇒ more pages). There is no SDK-enforced upper bound on pages —
  a malformed/malicious downstream returning a constant cursor will loop forever unless the
  caller caps it itself (this is exactly what A6 below fixes).
- **stdout purity is load-bearing**: the upstream transport is `StdioServerTransport`, so stdout
  must carry only MCP protocol frames. All logging goes to stderr (`src/log.ts`). This is also
  why `console.log` is banned project-wide — a stray `console.log` would corrupt the stdio
  channel for whatever MCP client is talking to this process.

## Review findings and fixes (this session)

All of the following were found by an independent review pass; each has a regression test.

- **A1 (HIGH)** — `runPipeline` could compress via htmlToMarkdown/jsonSummary/stripBase64 alone
  (getting under budget without truncateStage ever firing), leaving the caller with no
  `read_more(fullHandle)` reference anywhere in the returned text — the full original output
  became unrecoverable. Fixed in `src/pipeline/index.ts`: after the stage loop, if the
  compression path ran and the final text doesn't already contain `fullHandle`, append a
  `[Compressed N → M chars. Full output: read_more("...")]` marker. Tests:
  `test/unit/pipeline.test.ts` → describe block "regression (A1): fullHandle fallback..." (3
  cases: htmlToMarkdown-only, jsonSummary-only, stripBase64-only) plus a no-double-reference
  assertion added to the existing truncate test.
- **A2 (MEDIUM)** — `TokenCounter`'s `count()` (real Anthropic `count_tokens` API path) was
  dead code, never called from any production path, yet `report.ts` used `isExact()` to drop
  the "(estimated)" label whenever `ANTHROPIC_API_KEY` was merely *set* — the report would then
  claim exact numbers it never computed. Worse, if that path were ever wired up, it would send
  tool output content to an external API, conflicting with the project's own "report never
  contains output content" safety line. Fixed: deleted the `TokenCounter` class and the API
  path entirely from `src/tokens.ts` (kept `estimateTokens()`); `SessionReport` no longer takes
  a token counter and always labels itself "(estimated)". Tests: `test/unit/tokens.test.ts`
  trimmed to `estimateTokens` only; `test/unit/report.test.ts` updated throughout.
- **A3 (MEDIUM)** — the bare base64 block regex (`[A-Za-z0-9+/]{1024,}`) matched any run of
  1024+ chars drawn from the base64 alphabet, so `'x'.repeat(2000)`, long hashes, and minified
  JS could be misclassified as binary data and stripped. Fixed in `src/pipeline/base64.ts`:
  added `looksLikeBase64()` — requires the block to mix uppercase, lowercase, and digits, and
  either contain `+`/`/`/`=` or not contain a 128+ run of a single repeated character. Data URIs
  (which carry their own `data:...;base64,` signal) skip this extra check. Tests:
  `test/unit/base64.test.ts` — `'x'.repeat(2000)` no longer stripped; a real
  `Buffer.from(randomBytes(2048)).toString('base64')` blob still is.
- **A4 (MEDIUM)** — `cli.ts`'s shutdown path (SIGINT/SIGTERM/`transport.onclose`) had no
  reentrancy guard; a rapid double signal could run `writeReport()`/`manager.close()` twice
  concurrently. Fixed with a `let closing = false` guard. Test:
  `test/integration/shutdown.test.ts` — spawns the real CLI, sends two SIGINTs 50ms apart,
  asserts exactly one "shutting down" log line and a clean exit. (Note: sending the two signals
  with **zero** delay is flaky in this environment — an OS/libuv signal-coalescing artifact
  unrelated to the fix, reproduced identically with and without the fix present via a
  standalone script; a real double-Ctrl-C always has non-zero human reaction time, so the 50ms
  gap is a faithful reproduction, not a weakened test.)
- **A5 (LOW)** — `ArtifactStore.slice(handle, offset, length)` with `length <= 0` produced an
  empty page with `hasMore: true` and `nextOffset === offset`, so a caller that mechanically
  follows `nextOffset` would loop forever. Fixed in `src/artifacts.ts`: `length <= 0` now falls
  back to the 8000 default. Tests: `test/unit/artifacts.test.ts`, two new cases (`length: 0` and
  a negative length).
- **A6 (LOW)** — `DownstreamManager`'s `listTools()` pagination loop had no round cap; a
  malicious/buggy downstream returning a constant `nextCursor` would hang `connectOne()`
  forever. Fixed by extracting the loop into an exported, independently-testable
  `paginateListTools(client, logger, serverName)` in `src/downstream/manager.ts`, capped at 100
  pages with a `logger.warn` on overflow. Test: `test/unit/manager.test.ts` (new file).
- **A7 (LOW)** — the terminal report card computes border width from `.length` (UTF-16 code
  units), which misaligns for characters that don't render as exactly one terminal column
  (flagged specifically for `≈`, and would also apply to CJK content). Fixed the narrowest way
  possible per the review guidance: replaced `≈` with ASCII `~=` in `SessionReport.render()`'s
  card lines only (no width-computation library added; `renderMarkdown()`'s table is unaffected
  since it isn't rendered as a fixed-width box). Test: `test/unit/report.test.ts` — asserts the
  card never contains `≈` and does contain `~=`.

## P1-2 chaos / robustness testing (this session)

Ran the 7 scenarios from `TEST_PLAN.md` P1-2 against `test/integration/fixtures/misbehaving-server.mjs`
(a dependency-free, hand-rolled stdio MCP server whose `tools/call` behavior is picked by argv:
`echo | hang | huge | malformed`). All 7 became fast, deterministic automated tests in the new
`test/integration/chaos.test.ts` (no scenario needed a scratchpad-only one-off) plus one unit-level
addition in `test/unit/artifacts.test.ts`. `callToolTimeoutMs` (top-level config, per-`invoke_tool`
timeout passed to the downstream SDK client) had already been implemented in a prior session
(`src/config.ts`, `src/downstream/manager.ts`, `src/types.ts`, README/README.zh, `test/unit/config.test.ts`)
— this session only added the chaos coverage that exercises it end-to-end.

- **Verified SDK fact**: `Client.callTool()`'s own default request timeout is exactly **60,000ms**
  (`DEFAULT_REQUEST_TIMEOUT_MSEC` in the SDK's `shared/protocol.js`), confirmed both by reading the
  source and empirically (a hung downstream with no `callToolTimeoutMs` configured rejects with
  `McpError -32001 "Request timed out"`, `data: { timeout: 60000 }`).
- **Verified SDK fact**: `Client.callTool()` validates the downstream's response against
  `CallToolResultSchema` (zod) before it ever reaches our pipeline code — a downstream returning
  `content` as something other than an array, or a text block whose `text` isn't a string, fails
  that validation and rejects, which `DownstreamManager.callTool()`'s existing try/catch turns into
  an `isError` result. `runPipeline`'s `extractText()` (`src/pipeline/index.ts`) technically assumes
  `content` is always an array and would throw if it weren't, but that path is unreachable through
  the real SDK client. Belt-and-suspenders: even if it did throw, the MCP SDK server wraps every
  tool handler in its own try/catch (`McpServer`'s `CallToolRequestSchema` handler) and converts any
  thrown error into an `isError` `CallToolResult` — so there is no code path today where a
  malformed/hostile downstream response can crash the gateway process. No code change made; this is
  a confirmed-safe finding, not a gap.
- **B1 (fixed) — orphaned downstream processes when the upstream just closes the pipe.**
  `StdioServerTransport` (the SDK class `cli.ts` uses for the upstream connection) only reacts to
  `'data'`/`'error'` on `process.stdin` — it never treats stdin EOF as a close, so `transport.onclose`
  (already wired to `shutdown()`) does not fire when a host disconnects by simply ending the pipe
  without also sending SIGTERM/SIGINT. Reproduced directly: spawning the CLI and calling only
  `child.stdin.end()` (no signal) left both the CLI process and every downstream child it had spawned
  running indefinitely. Fixed in `src/cli.ts` by adding `process.stdin.on('end', () => shutdown('stdin
  closed'))`, reusing the existing idempotent `shutdown()` path. Test: `test/integration/chaos.test.ts`
  → "P1-2 #7" (spawns the CLI with a tagged downstream, calls `client.close()` which ends the pipe,
  confirms via `pgrep -f <tag>` that the downstream process is gone within 4s).
  - Side effect: this made `test/integration/shutdown.test.ts`'s SIGINT test spawn the CLI with
    `stdio: ['ignore', ...]` for stdin, which is `/dev/null` and therefore EOFs immediately — that
    now triggered the new stdin-closed shutdown path within milliseconds, long before the test's
    signals, causing `child.on('exit', ...)` (subscribed after a 5s delay) to miss an already-fired
    `exit` event and hang until the 30s test timeout. Fixed by giving that test a real, never-closed
    `'pipe'` stdin instead of `'ignore'` (a test-harness fix, not a product behavior change — real MCP
    hosts always keep stdin open as a live pipe).
- **Recorded, not fixed (experience-level, caller decides)** — `stripBase64Stage`'s global regex
  (`src/pipeline/base64.ts`) throws `RangeError: Maximum call stack size exceeded` when run via
  `.replace()` against a single ~10MB contiguous block of base64-alphabet characters (a known V8
  regex-engine limitation on huge repeated matches, not specific to this codebase). It's already
  caught by `runPipeline`'s existing try/catch and falls back to truncate-only, so the gateway never
  crashes, `invoke_tool` still returns correctly, and the P1-2 #3 test's assertions (`isError` false,
  <5s, truncation marker present, `read_more` works) all pass on the fallback path. The only real cost
  is that `stripBase64`/`htmlToMarkdown`/`jsonSummary` are all skipped for that call (truncate-only
  compression instead of the full pipeline) whenever a single block is large enough to trip this. Not
  fixed this session — if it's worth addressing, the likely fix is skipping `stripBase64Stage` above
  some input-size threshold (e.g. >1–2MB) rather than trying to make the regex itself safe at 10MB
  scale.

## Report polish (design doc §8 leftover)

Added a "Top tools by savings" section to both `render()` (plain-text lines under the card) and
`renderMarkdown()` (a second Markdown table), listing up to 3 `{server}/{tool}` entries ranked
by cumulative tokens saved, aggregated across every call to that tool, excluding tools that
never actually saved anything. Verified end-to-end in `test/integration/e2e.test.ts`'s real run
(visible in its stderr output: `filesystem/read_text_file  ~71,323 tokens saved (2 calls)`).

## Explicitly cut

- **`count_tokens` API path (`TokenCounter.count()`)** — removed in A2. It was unused dead code,
  its presence made the "(estimated)" label lie whenever an API key happened to be set, and
  wiring it up for real would mean sending tool output content to an external API, which
  conflicts with this project's own safety red line ("the report never contains output
  content" — and by extension, nothing in this codebase should ship output content off-box for
  metering purposes either). `estimateTokens()` (chars/3.5) is the only counting method now,
  everywhere, always labeled as an estimate.
- **PNG report format** — the design doc (§3.3/§8) mentions a PNG-rendered report card as a
  "screenshot-friendly" distribution format. Not implemented. Terminal (Unicode box card) and
  Markdown are the only two output formats. Revisit only if user feedback specifically asks for
  it — the terminal card is already screenshot-friendly as-is.

## Follow-ups (not done this session)

- `npm publish` (package.json now has real `description`/`keywords`/`license: MIT`; `repository`
  is a **placeholder** URL — `github.com/REPLACE_ME/context-firewall` — swap in the real repo
  before publishing).
- Demo GIF per design doc §8 storyboard (52 tools → 3 → compressed call → savings card).
- Submission to mcp.so, the official MCP Registry, and the various awesome-mcp-servers lists
  (punkpeye / wong2 / appcypher / TensorBlock), glama.ai, smithery.ai, PulseMCP.
- Response caching (design doc v1.0 scope item, §6) — same call hitting cache directly. Not
  started.
- LICENSE file added this session (MIT, copyright Eric) — no action needed, listed here only so
  it isn't mistaken for a gap.
