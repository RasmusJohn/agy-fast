# agy-fast Tool Routing Rules

Use `agy-fast_fast` MCP tools where batching amortizes the fixed per-call remote check (~1.8s), and keep built-in `read_file` for allowlisted fast reads (~7ms):

| Task | Preferred Tool | Reason |
| :--- | :--- | :--- |
| Read 1-4 small files (<300 lines) OR 1-4 known line ranges (`StartLine`/`EndLine`) | Built-in `read_file` (parallel in one turn) | Locally allowlisted (~7ms, skips remote check) |
| Inspect large unknown files (>300 lines) via `outlines`, OR read >=5 scattered ranges across files | `read_slices` (`outlines` and/or `slices`) | Gets symbol line numbers without dumping whole files into context |
| Run >=2 text/regex/glob/read-only `git` queries (even across multiple directories/repos) | `batch_search` (pack ALL queries into **one** call via per-query `path`) | 1 remote check + concurrent local execution (<70ms) instead of N serial shell checks |
| Edit >=2 blocks in one file, edit/create/overwrite >=2 files in one turn, OR any edit + verify | `apply_edits` (use `create` string + `overwrite: true` for full-file writes, optional `verify`) | Replaces N serial `edit_file`/`write_file` checks + a separate verify turn with 1 atomic call |
| Run >=2 standalone build, typecheck, lint, or test commands (not already chained in `apply_edits.verify`) | `run_checks` (`outputMode: "compact"`) | Concurrent execution with 1-line pass summaries |

## Rules

1. **Direct invocation (no schema read turn)**: When `agy-fast_fast` tools are lazily loaded, call `call_mcp_tool` directly with `ServerName: "agy-fast_fast"` using the exact schemas below. Do **not** spend a turn reading `mcp/agy-fast_fast/*.json` first.
2. **Apply across all directories and file types**: Use `apply_edits` and `batch_search` consistently for code, HTML/CSS, docs, scripts, and non-repo scratch folders—do not fall back to multi-call `edit_file`/`write_file` in long conversations.
3. **Pack into ONE MCP call per turn**: Each `call_mcp_tool` pays ~1.8s of remote evaluation. Combine cross-repo searches into one `batch_search` (using absolute or relative `queries[].path`), combine multi-file edits/creates + verification into one `apply_edits`, and avoid wrapping a single trivial `read_file` range or single `git status` alone in an MCP call.
4. **Pass `cwd`**: Always pass the active workspace root in `cwd` when calling `agy-fast_fast` tools.
5. **Use the startup snapshot**: Check the `SessionStart` snapshot before running directory listing or `git status` commands.
6. **Avoid duplicate reads & isolate wide surveys**: Do not re-read unchanged files already in context; delegate broad codebase surveys to built-in subagents.

## Quick Schemas (`ServerName: "agy-fast_fast"`)

- **`batch_search`**: `{ cwd?, queries: [{ type: "text"|"regex"|"glob"|"git", pattern, path?, glob?, caseSensitive?, contextLines?: 0..5, maxResults?: 1..200 }], maxChars? }` (1-20 queries; `path` may be relative or absolute; read-only git only).
- **`apply_edits`**: `{ cwd?, edits: [{ path, hunks?: [{ target, replacement, startLine?, endLine?, replaceAll? }], create?: string, overwrite?: boolean }], dryRun?, verify?: string, verifyTimeoutSec?, maxVerifyChars? }` (1-50 files; `create` is full file text and mutually exclusive with `hunks`; atomic all-or-nothing).
- **`read_slices`**: `{ cwd?, outlines?: string[], slices?: [{ path, ranges: [[startLine, endLine], ...] }], maxChars? }` (1-based inclusive line ranges).
- **`run_checks`**: `{ cwd?, commands: [{ name?, command, cwd?, timeoutSec? }], concurrency?: 1..8, timeoutSec?, outputMode?: "compact"|"full", maxChars? }`.
