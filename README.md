<div align="center">

<img src="assets/logo.svg" alt="agy-fast logo" width="76" />

# agy-fast

**Latency and Tool-Call Accelerator Plugin for Google Antigravity**

Zero runtime dependencies · Single-file ESM bundles · Policy-compliant · Works on Antigravity CLI (`agy`), Desktop 2.0, and IDE

English · [简体中文](README.zh-CN.md) · [Changelog](CHANGELOG.md) · [Latency Analysis Report](docs/ANALYSIS_REPORT.md) · [性能分析报告（中文脱敏版）](docs/ANALYSIS_REPORT.zh-CN.md)

</div>

> [!NOTE]
> **Non-invasive — zero impact on Antigravity's native UI or behavior:** `agy-fast` runs strictly as a standard local MCP plugin and never alters, disables, or interferes with Antigravity's built-in features — including the **diff viewer/window**, **modified-files list**, checkpoints, native tools, or safety checks.

---

## Why `agy-fast` Exists

Analysis of **55 real Antigravity sessions (8,446 LLM turns, 17,302 tool calls, 55.25 hours of single-agent active time)** showed that slow tasks are rarely caused by slow token generation:

1. **Per-turn Time to First Token (TTFT) floor (~6.1 s median)**: 68.1% of turns emit fewer than 700 tokens, so roughly 79% of a median turn is spent waiting for the first byte. Every unnecessary round-trip turn costs ~6–8 seconds.
2. **Serial tool execution and fragmented edits**: 52.5% of `edit_file` calls are extra same-file splits in the same turn, and 46.3% of `run_command` calls are read-only searches (`rg`/`grep`/`find`/`git status`) that pay shell and remote-check overhead (~2.0 s median vs. 2.1 ms for local `rg`).
3. **Cold-start exploration**: The first 3 turns of a session average **49.2 seconds** inspecting directory layout, git state, and project scripts.
4. **Context growth and cache misses**: `read_file` accounts for **81.9%** of all tool-returned bytes; gaps over 60 seconds raise prompt cache miss rates from **1.4%** to **15.9%–93.8%**.

Read the full sanitized data breakdown in **[docs/ANALYSIS_REPORT.md](docs/ANALYSIS_REPORT.md)**.

`agy-fast` addresses these bottlenecks strictly within Antigravity's official plugin specification: it reduces round-trip turns, merges repeated tool calls inside a persistent local Stdio MCP server, keeps context compact, and injects a tiny startup snapshot once per session.

---

## Real-World Impact (Sanitized Telemetry)

Across **10 days of real coding transcripts** (**14 baseline main sessions / 5,771 turns** vs. **7 `agy-fast` main sessions / 901 turns**, plus **104 baseline vs. 4 `agy-fast` subagent sessions**; all repository names, paths, and session identifiers stripped), each `agy-fast` call batched an average of **4.89 logical operations** (`5.95×` in subagents) and delivered measurable savings across **latency, quota/token cost, and upload bandwidth**:

| Metric (normalized per logical action) | Main Sessions (Baseline) | Main Sessions (`agy-fast`) | Delta | `>=150k` Long Context | Subagents |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **LLM turns / 10 actions** | 5.23 | **3.47** | **-33.7%** | **-38.2%** | **-58.8%** |
| **Upstream requests / 10 actions** *(LLM + remote checks)* | 9.82 | **6.05** | **-38.4%** | **-42.6%** | **-62.0%** |
| **Prompt Cache hit rate** *(miss spikes)* | 89.6% *(7.5%)* | **94.0%** *(4.8%)* | **+4.4 pp** | **95.0%** *(3.3%)* | 92.4% *(2.8%)* |
| **Uncached fresh input / action** | 10,413 tok | **4,822 tok** | **-53.7%** | **-61.5%** | **-51.3%** |
| **Est. billable quota / action** *(1 : 0.1 : 5)* | 22,458 eq | **15,387 eq** | **-31.5%** | **-36.5%** | **-54.0%** |
| **Tool-return upload / action** *(actual local bytes)* | 5.06 KB | **3.05 KB** | **-39.7%** | **-42.6%** | **-13.3%** |
| **Incremental text upload / action** *(fresh input est.)* | 35.6 KB | **16.5 KB** | **-53.7%** | **-61.6%** | **-51.3%** |
| **Full-context text upload / action** *(stateless resend est.)* | 342.2 KB | **276.2 KB** | **-19.3%** | **-21.9%** | **-58.9%** |

**Production hardening highlights (`v0.2.x`):**
- **0 disk spills** across 134 consecutive `v0.2.x` MCP calls (strict `<= 8.8 KB` UTF-8 inline cap prevents Antigravity's `output.txt` spill-to-disk extra turns).
- **+75% effective throughput (`35.1 → 61.5 tok/s`)** and **>60s stall turns cut from `31.2% → 7.4%`** in a same-session before/after `v0.2.1` comparison (99 vs. 374 turns) once multimodal screenshots were isolated out of `>180k`-token main sessions (`0` screenshots loaded in main coding sessions post-upgrade).
- **0 lazy-load schema-read turns** (`rules/AGENTS.md` inlines compact tool schemas directly).

<details>
<summary>Methodology &amp; overhead transparency</summary>

- **Logical actions**: A single `batch_search` with 5 queries counts as 5 actions, an `apply_edits` touching 6 hunks + `verify` counts as 7 actions, and a built-in `read_file`/`edit_file`/`run_command` counts as 1 action—ensuring an apples-to-apples comparison per unit of work rather than raw tool call counts.
- **Quota sensitivity check**: Standard weighting (`1.0×` uncached input, `0.1×` cache read, `5.0×` output) yields **-31.5%** on main sessions (`-36.5%` on `>=150k` sessions). Results remain consistent under conservative cache discounts (`1 : 0.25 : 4` → **-25.8%**) and high-output weighting (`1 : 0.1 : 8` → **-29.4%**).
- **Fixed prompt overhead**: `rules/AGENTS.md` + `SessionStart` snapshot add **~1.7k tokens** once per session (cached from turn 2 onward, ~170 eq tokens/turn). Saving a single redundant turn (~44k eq tokens) or blind full-file read pays back this overhead **>20×**.
- **Reproduce locally**: Run `node dist/benchmark.mjs analyze --local --split-usage` on your own transcripts.

</details>

---

## Quick Installation

Requires **Node.js >= 20**. **No `npm install` is needed** — pre-built zero-dependency bundles (`dist/*.mjs`) are included. Optional: install [`ripgrep` (`rg`)](https://github.com/BurntSushi/ripgrep) for faster code search (falls back to pure Node.js automatically if `rg` is absent).

### Option 1: One-Command Install (Recommended)

Run directly without cloning manually (automatically installs runtime files to `~/.gemini/config/plugins/agy-fast`, runs `agy plugin validate --strict` and `agy plugin enable agy-fast` if `agy` is installed, and runs a live MCP + hook health check):

**macOS / Linux:**
```bash
curl -fsSL https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.sh | sh
```

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.ps1 | iex
```

**Or from a local clone on any OS:**
```bash
git clone https://github.com/INK-Q/agy-fast.git
cd agy-fast
node scripts/install.mjs install
```

### Option 2: Direct Clone into Antigravity Plugins Folder

No installer script required — Antigravity automatically discovers plugins in `~/.gemini/config/plugins/`:

```bash
# macOS / Linux
git clone https://github.com/INK-Q/agy-fast.git ~/.gemini/config/plugins/agy-fast
```

```powershell
# Windows (PowerShell)
git clone https://github.com/INK-Q/agy-fast.git "$env:USERPROFILE\.gemini\config\plugins\agy-fast"
```

### Option 3: Native Antigravity CLI (`agy`)

```bash
agy plugin install /path/to/agy-fast
agy plugin enable agy-fast
```

### Option 4: Per-Repository Installation (Team Sharing)

Install only for a single project (writes to `<repo>/.agents/plugins/agy-fast`):

```bash
node scripts/install.mjs install --project /path/to/your-repo
```

### Option 5: Ask Antigravity Directly

Paste this prompt into Antigravity:

```text
Clone https://github.com/INK-Q/agy-fast.git to ~/.gemini/config/plugins/agy-fast, run `node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs doctor`, and enable the agy-fast plugin.
```

### Auto-Update & Manual Update

`agy-fast` includes a built-in **zero-latency background auto-updater** (requires no `npm install` because pre-built `dist/*.mjs` bundles are shipped in every release):

- **How it works**:
  - Once every **12 hours**, `SessionStart` spawns a detached background check (`dist/updater.mjs`) after emitting the workspace snapshot, adding **0 ms** to session startup.
  - Checks GitHub release tags (`git ls-remote --tags` with GitHub Releases API fallback), clones the newer release into an isolated staging directory, runs a **live MCP 4-tool smoke test** before touching your installation, and atomically replaces runtime files.
  - **Safe by design**: Standard copied installs and clean direct `git clone` installs auto-update safely; `--link` dev symlinks and dirty git repos are **never overwritten** (notify-only). Broken releases failing the staged MCP smoke check are automatically rejected.
  - On the next new session, `SessionStart` shows a one-time notice when an update is applied (or available).

- **Manual update & configuration**:
  ```bash
  # Check for updates without modifying files
  node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs update --check

  # Update immediately (also works via ./install.sh update or .\install.ps1 update)
  node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs update

  # Configure mode: auto (default) | notify (check only) | off (disable background checks)
  node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs config --auto-update notify --interval 24
  ```

- **Environment variable overrides**:
  - `AGY_FAST_AUTO_UPDATE=auto|notify|off` — override auto-update mode (takes precedence over saved config).
  - `AGY_FAST_UPDATE_INTERVAL_HOURS=12` — background check interval in hours.
  - `AGY_FAST_UPDATE_CHANNEL=release|main` — track stable semver tags (`release`, default) or `main`.
  - `AGY_FAST_REPO=<git-url>` — custom mirror or fork URL.

- **Re-install fallback (one-command)**:
  ```bash
  # macOS / Linux
  curl -fsSL https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.sh | sh
  ```
  ```powershell
  # Windows (PowerShell)
  irm https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.ps1 | iex
  ```

> **Applying updates**: `rules/AGENTS.md` and `dist/session-start.mjs` take effect automatically on the next new session. In Antigravity Desktop / IDE, reload/restart the window once to refresh the resident MCP server process.

### Verify / Uninstall

```bash
# Run live MCP handshake, SessionStart latency, and strict manifest checks
./install.sh doctor        # macOS / Linux (or .\install.ps1 doctor on Windows)
# or: node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs doctor

# Remove global installation
./install.sh uninstall     # macOS / Linux (or .\install.ps1 uninstall on Windows)
# or: node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs uninstall
```

> **Activating in Desktop / IDE**: Open **Customizations → Installed** in Antigravity and make sure `agy-fast` is enabled. Start a new session to apply the `SessionStart` hook and MCP tools.

---

## What Is Included

| Component | Path | Purpose |
| :--- | :--- | :--- |
| **Native Plugin Manifest** | [`plugin.json`](plugin.json) | Standard Antigravity plugin metadata; passes `agy plugin validate --strict` |
| **Local Stdio MCP Server (`fast`)** | [`mcp_config.json`](mcp_config.json) → [`dist/mcp-server.mjs`](dist/mcp-server.mjs) | Persistent local process exposing **4 composite tools** (`agy-fast_fast`) to consolidate multi-step operations |
| **Startup Snapshot Hook** | [`hooks.json`](hooks.json) → [`dist/session-start.mjs`](dist/session-start.mjs) | Runs once on `SessionStart` (~35–50 ms), injecting a <=1.5 KB snapshot (git branch/status/commits, 2-level tree, detected scripts) |
| **Tool Routing Rules** | [`rules/AGENTS.md`](rules/AGENTS.md) | Compact (~2.2 KB) routing table with inline parameter signatures so the agent can invoke `call_mcp_tool` directly without extra schema-read turns |
| **Offline Benchmark CLI** | [`dist/benchmark.mjs`](dist/benchmark.mjs) | Local `transcript.jsonl` analyzer and A/B comparator |

### The 4 MCP Tools

1. **`batch_search`**: Run up to 20 concurrent `text`, `regex`, `glob`, and read-only `git` (`status`, `diff`, `log`, `show`, `branch`, `rev-parse`, `ls-files`, `blame`, `shortlog`, `describe`, `tag --list`, `remote -v`) queries in one call (including cross-repo queries via per-query `path`). Uses `rg` when installed and automatically falls back to Node.js; defaults to an inline-safe UTF-8 byte cap (`<= 8.8 KB`) so responses are never spilled to disk. For text and regex, use `fileType` (e.g. `typescript`) and `outputMode: "files_with_matches"` or `"count"` to return paths or per-file matching-line counts. Use `type: "fuzzy"` for case-insensitive path lookup, or `sortBy: "mtime"` with a glob to list recently modified files first. Set `multiline: true` to match across lines. In multiline mode, `count` returns occurrences per file.
2. **`apply_edits`**: Apply multiple non-contiguous edits across one or more files atomically (validates every file and edit in memory first; modifies 0 files if any edit fails or overlaps), or pass `bestEffort: true` on large multi-file batches so valid files commit immediately while failed files return automatic closest-line snippets for targeted retry. Preserves CRLF line endings, file permissions, and symlinks; supports `startLine`/`endLine`, `create`/`overwrite`, `dryRun`, and an optional inline `verify` command.
3. **`read_slices`**: Extract multi-language symbol outlines (TypeScript/JavaScript, Python, GDScript, Go, Rust, Java/Kotlin/C#/C/C++/Swift, Shell, Markdown, JSON/YAML) with start/end line numbers, and batch-read exact `[startLine, endLine]` ranges across multiple files under an inline-safe UTF-8 byte budget.
4. **`run_checks`**: Run multiple build, typecheck, lint, or test commands concurrently with bounded concurrency, per-command timeouts, ANSI stripping, 1-line pass summaries in `compact` mode, and focused error extraction on failure.

---

## Measuring Before vs. After

Measure your own Antigravity transcripts locally (nothing leaves your machine):

```bash
# Summarize all local Antigravity transcripts
node dist/benchmark.mjs analyze --local

# Analyze only the 10 most recently modified local transcripts
node dist/benchmark.mjs analyze --local --recent 10

# Slice resumed & new sessions since plugin install and compare With vs. Without agy-fast
node dist/benchmark.mjs analyze --local --since 2026-11-19T12:51:00+08:00 --split-usage

# Compare two task runs (without vs. with agy-fast)
node dist/benchmark.mjs compare --before ./run-before/transcript.jsonl --after ./run-after/transcript.jsonl
```

---

## Policy Compliance and Safety

- Uses only documented Antigravity extension interfaces (`plugin.json`, `mcp_config.json`, `hooks.json`, `rules/AGENTS.md`).
- **Non-invasive by design**: does **not** alter Antigravity's native behavior, UI, **diff viewer/window**, **modified-files list**, checkpoints, or built-in tools.
- Does **not** bypass, disable, or tamper with Antigravity's safety checks, client binaries, or authentication.
- Registers **zero** per-step hooks (`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`).
- Fails open on `SessionStart`: if a workspace is unreadable or stdin is malformed, the hook outputs `{}` and never blocks session startup.
- Unminified ESM bundles so every line executed locally is straightforward to audit.

---

## FAQ

**Does `agy-fast` affect Antigravity's native UI, diff window, or modified-files list?**
No. `agy-fast` operates strictly through Antigravity's official local MCP and `SessionStart` plugin APIs. It does not patch the client or interfere with Antigravity's diff viewer, modified-files list, checkpoints, native tools, or safety checks.

**Does `agy-fast` save token quota and upload traffic in addition to making tasks faster?**
Yes. Across 10 days of sanitized real coding sessions, batching ~4.9 operations per MCP call reduced LLM turns by **33.7%**, estimated billable token quota by **31.5%** (**36.5%** in `>=150k`-token sessions; **54.0%** in subagents), tool-return upload bytes by **39.7%**, and >60s stall turns from **31.2% → 7.4%**.

**Which Antigravity editions and operating systems are supported?**
Antigravity CLI (`agy`), Antigravity Desktop 2.0, and Antigravity IDE on **macOS, Linux, and Windows** (requires Node.js >= 20, zero runtime dependencies; optional `ripgrep`/`rg` with automatic Node.js fallback).

**How do I verify the speedup or uninstall cleanly?**
Run `node dist/benchmark.mjs analyze --local --split-usage` to benchmark your own transcripts 100% offline. To remove `agy-fast` completely at any time, run `node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs uninstall`.

---

## Development

```bash
npm install
npm run typecheck   # Strict TypeScript check
npm run build       # Bundle src/*.ts -> dist/*.mjs with esbuild
npm test            # Run all unit, protocol, hook, benchmark, and installer tests
npm run validate    # Run `agy plugin validate --strict .`
```

---

## License

[MIT](LICENSE)
