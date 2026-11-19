# agy-fast Tool Routing Rules

Use the `fast` MCP tools to reduce turn count, repeated tool checks, and context growth:

| Task | Preferred Tool | Reason |
| :--- | :--- | :--- |
| Read 1-4 small files (<300 lines) | Built-in `read_file` (parallel in one turn) | Locally allowlisted, ~7ms per file |
| Inspect large files (>300 lines) or read line ranges across files | `read_slices` (`outlines` and/or `slices`) | Keeps full file contents out of context |
| Text/regex search, file globbing, or read-only `git` (`status`, `diff`, `log`, `show`, `branch`) | `batch_search` (combine queries in one call) | Replaces multiple shell calls with one concurrent call |
| Edit >=2 blocks in one file, edit multiple files, or edit + verify | `apply_edits` (with optional `verify`) | Atomic multi-hunk write in one call |
| Run >=2 build, typecheck, lint, or test commands | `run_checks` (`outputMode: "compact"`) | Concurrent execution with compact pass logs |

## Rules

1. **Pass `cwd`**: Always pass the active workspace root in `cwd` when calling `fast` tools.
2. **Batch known work**: Combine independent searches, slices, edits, or checks into a single call instead of chaining single-tool turns.
3. **Use the startup snapshot**: Check the `SessionStart` snapshot before running directory listing or `git status` commands.
4. **Avoid duplicate reads**: Do not re-read files already in recent context unless modified.
5. **Isolate wide surveys**: Delegate broad codebase surveys to built-in subagents.
