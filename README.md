<div align="center">

<img src="assets/logo.svg" alt="agy-fast logo" width="76" />

# agy-fast

**Latency and Tool-Call Accelerator Plugin for Google Antigravity**

Zero runtime dependencies · Single-file ESM bundles · Policy-compliant · Works on Antigravity CLI (`agy`), Desktop 2.0, and IDE

English · [简体中文](README.zh-CN.md) · [Latency Analysis Report](docs/ANALYSIS_REPORT.md) · [性能分析报告（中文脱敏版）](docs/ANALYSIS_REPORT.zh-CN.md)

</div>

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

### Update to Latest Version

Updating is idempotent and does **not** require `npm install` (pre-built `dist/*.mjs` bundles are included):

- **Installed via One-Command Installer (recommended)** — re-run the same one-liner to pull the latest `main`, overwrite runtime files, and run `doctor`:
  ```bash
  # macOS / Linux
  curl -fsSL https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.sh | sh
  ```
  ```powershell
  # Windows (PowerShell)
  irm https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.ps1 | iex
  ```
- **Installed via Direct `git clone` into `~/.gemini/config/plugins/agy-fast`**:
  ```bash
  # macOS / Linux
  git -C ~/.gemini/config/plugins/agy-fast pull --ff-only && node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs doctor
  ```
  ```powershell
  # Windows (PowerShell)
  git -C "$env:USERPROFILE\.gemini\config\plugins\agy-fast" pull --ff-only; node "$env:USERPROFILE\.gemini\config\plugins\agy-fast\scripts\install.mjs" doctor
  ```
- **Installed from a Local Clone or Per-Project (`--project`)**:
  ```bash
  cd agy-fast && git pull --ff-only
  node scripts/install.mjs install                     # global install
  # or: node scripts/install.mjs install --project /path/to/your-repo
  ```

> **Applying updates**: Start a new session in Antigravity CLI (`agy`), or reload/restart Antigravity Desktop / IDE so the persistent MCP server reloads the updated `dist/*.mjs` bundles and `rules/AGENTS.md`.

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

1. **`batch_search`**: Run up to 20 concurrent `text`, `regex`, `glob`, and read-only `git` (`status`, `diff`, `log`, `show`, `branch`, `rev-parse`, `ls-files`, `blame`, `shortlog`, `describe`, `tag --list`, `remote -v`) queries in one call. Uses `rg` when installed and automatically falls back to Node.js. Rejects mutating git commands and unsafe flags.
2. **`apply_edits`**: Apply multiple non-contiguous edits across one or more files atomically (validates every file and edit in memory first; modifies 0 files if any edit fails or overlaps). Preserves CRLF line endings, file permissions, and symlinks; supports line-range narrowing (`startLine`/`endLine`), file creation (`create`), `dryRun`, and an optional inline `verify` command.
3. **`read_slices`**: Extract multi-language symbol outlines (TypeScript/JavaScript, Python, Go, Rust, Java/Kotlin/C#/C/C++/Swift, Shell, Markdown, JSON/YAML) with start/end line numbers, and batch-read exact `[startLine, endLine]` ranges across multiple files under a configurable character budget.
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
- Does **not** bypass, disable, or tamper with Antigravity's safety checks, client binaries, or authentication.
- Registers **zero** per-step hooks (`PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`).
- Fails open on `SessionStart`: if a workspace is unreadable or stdin is malformed, the hook outputs `{}` and never blocks session startup.
- Unminified ESM bundles so every line executed locally is straightforward to audit.

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
