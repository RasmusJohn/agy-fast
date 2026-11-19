# agy-fast Tool Routing Rules

Use `agy-fast_fast` MCP tools where batching amortizes the fixed per-call remote check (~1.8s) and prevents context bloat, and keep built-in `read_file` for allowlisted fast narrow reads (~7ms):

| Task | Preferred Tool | Reason |
| :--- | :--- | :--- |
| Read 1-4 small files (<300 lines) OR 1-4 **narrow** known line ranges (<=150 lines) | Built-in `read_file` (parallel in one turn) | Locally allowlisted (~7ms, skips remote check) |
| Inspect ANY large unknown file (>300 lines, especially >=2 large files), OR read >=5 scattered ranges | `read_slices` (`outlines` first, then narrow ranges) | **Do NOT blind-read `1-800` on large files**—prevents 300k+ context bloat & slow TTFT |
| Run >=2 text/regex/glob/read-only `git` queries (even across multiple directories/repos) | `batch_search` (pack ALL queries into **one** call via per-query `path`) | 1 remote check + concurrent local execution (<70ms), auto-capped <=8.8 KB inline |
| Edit >=2 blocks in one file, edit/create/overwrite >=2 files in one turn, OR any edit + verify | `apply_edits` (`bestEffort: true` for >=4 files; optional `verify`) | Replaces N serial checks + verify turn; `bestEffort` commits valid files & returns closest-line hints on mismatch |
| Run >=2 standalone build, typecheck, lint, or test commands (not already chained in `apply_edits.verify`) | `run_checks` (`outputMode: "compact"`) | Concurrent execution with 1-line pass summaries |

## Rules

1. **Direct invocation (no schema read turn)**: When `agy-fast_fast` tools are lazily loaded, call `call_mcp_tool` directly with `ServerName: "agy-fast_fast"` using the exact schemas below. Do **not** spend a turn reading `mcp/agy-fast_fast/*.json` first.
2. **Keep context lean (no blind `1-800` dumps)**: On files >300 lines whose layout you don't know, call `read_slices({ outlines: [...] })` first to get exact symbol line numbers, then fetch only the needed <=150-line sections.
3. **Apply across all directories and file types**: Use `apply_edits` and `batch_search` consistently for code, HTML/CSS, docs, scripts, and non-repo scratch folders—do not fall back to multi-call `edit_file`/`write_file` in long conversations.
4. **Use `bestEffort: true` on large multi-file edits**: When editing >=4 files in one `apply_edits` call, pass `bestEffort: true` (and keep batches <=6-8 files) so a typo in 1 file never forces regenerating all files.
5. **Pack into ONE MCP call per turn**: Each `call_mcp_tool` pays ~1.8s of remote evaluation. Combine cross-repo searches into one `batch_search` (via `queries[].path`), combine edits + verify into one `apply_edits`, and avoid wrapping a single trivial `git status` alone.
6. **Pass `cwd`, use the startup snapshot, avoid duplicate reads**: Always pass the active workspace root in `cwd`, read the `SessionStart` snapshot before running `ls`/`git status`, and delegate wide codebase surveys to subagents.

## Quick Schemas (`ServerName: "agy-fast_fast"`)

- **`batch_search`**: `{ cwd?, queries: [{ type: "text"|"regex"|"glob"|"git", pattern, path?, glob?, caseSensitive?, contextLines?: 0..5, maxResults?: 1..200 }], maxChars? }` (1-20 queries; `path` may be relative or absolute; read-only git only).
- **`apply_edits`**: `{ cwd?, edits: [{ path, hunks?: [{ target, replacement, startLine?, endLine?, replaceAll? }], create?: string, overwrite?: boolean }], dryRun?, bestEffort?, verify?: string, verifyTimeoutSec?, maxVerifyChars? }` (1-50 files; `create` is full file text and mutually exclusive with `hunks`).
- **`read_slices`**: `{ cwd?, outlines?: string[], slices?: [{ path, ranges: [[startLine, endLine], ...] }], maxChars? }` (1-based inclusive line ranges).
- **`run_checks`**: `{ cwd?, commands: [{ name?, command, cwd?, timeoutSec? }], concurrency?: 1..8, timeoutSec?, outputMode?: "compact"|"full", maxChars? }`.
