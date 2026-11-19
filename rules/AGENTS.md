# agy-fast Tool Routing Rules

Use the `agy-fast_fast` MCP tools to reduce turn count, repeated tool checks, and context growth:

| Task | Preferred Tool | Reason |
| :--- | :--- | :--- |
| Read 1-4 small files (<300 lines) | Built-in `read_file` (parallel in one turn) | Locally allowlisted, ~7ms per file |
| Inspect large files (>300 lines) or read line ranges across files | `read_slices` (`outlines` and/or `slices`) | Keeps full file contents out of context |
| Text/regex search, file globbing, or read-only `git` (`status`, `diff`, `log`, `show`, `branch`) | `batch_search` (combine queries in one call) | Replaces multiple shell calls with one concurrent call |
| Edit >=2 blocks in one file, edit multiple files, or edit + verify | `apply_edits` (with optional `verify`) | Atomic multi-hunk write in one call |
| Run >=2 build, typecheck, lint, or test commands | `run_checks` (`outputMode: "compact"`) | Concurrent execution with compact pass logs |

## Rules

1. **Direct invocation (no schema read turn)**: When `agy-fast_fast` tools are lazily loaded, call `call_mcp_tool` directly with `ServerName: "agy-fast_fast"` using the exact schemas below. Do **not** spend a turn reading `mcp/agy-fast_fast/*.json` first.
2. **Pass `cwd`**: Always pass the active workspace root in `cwd` when calling `agy-fast_fast` tools.
3. **Batch known work**: Combine independent searches, slices, edits, or checks into a single call instead of chaining single-tool turns.
4. **Use the startup snapshot**: Check the `SessionStart` snapshot before running directory listing or `git status` commands.
5. **Avoid duplicate reads**: Do not re-read files already in recent context unless modified.
6. **Isolate wide surveys**: Delegate broad codebase surveys to built-in subagents.

## Quick Schemas (`ServerName: "agy-fast_fast"`)

- **`batch_search`**: `{ cwd?, queries: [{ type: "text"|"regex"|"glob"|"git", pattern, path?, glob?, caseSensitive?, contextLines?: 0..5, maxResults?: 1..200 }], maxChars? }` (1-20 queries; read-only git only).
- **`apply_edits`**: `{ cwd?, edits: [{ path, hunks?: [{ target, replacement, startLine?, endLine?, replaceAll? }], create?, overwrite? }], dryRun?, verify?, verifyTimeoutSec?, maxVerifyChars? }` (1-50 files; atomic all-or-nothing; `verify` is an optional shell command string).
- **`read_slices`**: `{ cwd?, outlines?: string[], slices?: [{ path, ranges: [[startLine, endLine], ...] }], maxChars? }` (1-based inclusive line ranges).
- **`run_checks`**: `{ cwd?, commands: [{ name?, command, cwd?, timeoutSec? }], concurrency?: 1..8, timeoutSec?, outputMode?: "compact"|"full", maxChars? }`.
