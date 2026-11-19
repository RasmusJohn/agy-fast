# Changelog

All notable changes to `agy-fast` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.2.1] - 2026-11-19

### Added

- **Zero-latency background auto-update (`dist/updater.mjs` + `SessionStart`)**
  - Checks for newer stable release tags every **12 hours** via a detached, unref'd background process after `SessionStart` emits its workspace snapshot (**0 ms** added to session startup).
  - Uses `git ls-remote --tags --refs` (avoiding GitHub REST API rate limits and respecting native git/system proxy settings) with automatic fallback to the GitHub Releases API.
  - Stages downloads in an isolated temp directory, validates all runtime files and runs a **live MCP 4-tool handshake smoke test** before atomically replacing live files (`tmp -> rename`); broken staged releases are rejected without touching the existing install.
  - Protects `--link` dev symlinks, local source directories, and dirty git clones from overwriting (notify-only), while auto-updating standard copied installs and clean direct `git clone` installs safely.
  - Concurrency lock (`~/.gemini/cache/agy-fast/update.lock` with 10-minute stale recovery) prevents duplicate parallel updates across subagents; surfaces a one-time notice in the next `SessionStart` snapshot.
- **Manual `update` & `config` CLI subcommands (`scripts/install.mjs`, `install.sh`, `install.ps1`)**
  - Added `update [--check] [--force] [--channel release|main] [--repo <url>]` and `config --auto-update auto|notify|off --interval <hours> --channel release|main --repo <url>`.
  - Added environment variable overrides (`AGY_FAST_AUTO_UPDATE`, `AGY_FAST_UPDATE_INTERVAL_HOURS`, `AGY_FAST_UPDATE_CHANNEL`, `AGY_FAST_REPO`) and `npm run update:plugin`.
  - Updated `doctor` to display installed version, auto-update mode/interval/channel, and last check status (with background checks disabled during `doctor` smoke tests).

### 简体中文摘要（v0.2.1）

- **零启动延迟的后台自动更新（`dist/updater.mjs` + `SessionStart`）**：每 12 小时在 `SessionStart` 输出快照后异步拉起完全分离的后台更新进程，**0 ms 启动阻塞**；支持并发锁防重入，并在下一次新会话展示一次性更新提示。
- **先暂存冒烟校验、再原子替换**：优先走 `git ls-remote --tags`（规避 GitHub API 限流并原生走系统/git 代理），暂存目录先做全运行文件与实时 MCP 4 工具握手校验，通过后再按文件原子替换；损坏版本自动拦截。
- **安全保护与可控配置**：常规复制安装与干净 `git clone` 自动更新，`--link` 软链接与脏仓库仅提示不覆盖；新增 `update [--check]` 与 `config --auto-update auto|notify|off` 子命令（兼容 `install.sh` / `install.ps1`）及环境变量覆盖，`doctor` 同步展示版本号与自动更新状态。

---

## [0.2.0] - 2026-11-19

Production-hardening release driven by real-world Antigravity CLI & Desktop 2.0 transcript telemetry.

### Added

- **Vue/Svelte SFC, CSS/SCSS, Fastify/Express route & test-suite outlining (`read_slices`)**
  - Extracts `<script>`, `<template>` (handling nested `<template #slot>` + semantic/Modal landmarks), and `<style>` block boundaries for `.vue`/`.svelte` files.
  - Extracts `:root`, `[data-theme]`, `@layer`/`@media`/`@keyframes`/`@container`/`@supports`, section comments, and top-level rule groups for `.css`/`.scss`/`.less` files.
  - Detects `app/router/server/fastify.(get|post|put|patch|delete|all|route)` handlers inside large setup functions and `describe`/`it`/`test` blocks in test suites.
  - Raised `outlines` batch cap from `20` to `40` files with depth-0-first multi-file fairness so a single large class never crowds out other files in the batch.
- **`apply_edits` partial-commit mode (`bestEffort`), fuzzy recovery & line-drift hints**
  - Added `bestEffort: true` so valid files in a multi-file batch commit atomically per file even when another file fails validation, preventing redundant full-batch regeneration.
  - Added closest-region snippet hints (`findClosestRegionSnippet`), bounded wide-range failure snippets (`<= 26` lines), and whole-file exact-match detection when `startLine`/`endLine` has drifted.
- **`batch_search` glob truncation directory summary**
  - Deterministic sorted glob results with an `omitted dirs:` per-directory breakdown when matches exceed `maxResults`.
- **Inlined MCP tool schemas & multimodal/long-context TTFT hygiene in `rules/AGENTS.md`**
  - Inlined compact tool schemas directly in `AGENTS.md` to eliminate the lazy-load schema-read turn (`mcp/agy-fast_fast/*.json`).
  - Added empirical routing & TTFT hygiene rules: outline via `read_slices({ outlines })` then read known ranges via parallel built-in `read_file(StartLine, EndLine)` (~7 ms, 46 KB/call inline, 0 remote check); keep screenshots/images in dedicated subagents returning text-only findings to avoid the 3–7× multimodal TTFT cliff (>180k context); pack `>=2` independent non-interactive shell commands into `run_checks` (`compact` for build/test, `full` for diagnostic scripts).
- **Enhanced `benchmark` CLI & health diagnostics**
  - Added `--since <ISO>`, `--until <ISO>`, and `--split-usage` flags plus tracking for lazy-loaded `call_mcp_tool` invocations and async idle waits.
  - Added health & multimodal metrics: `mcpSpillCalls` (`output.txt` spills), `agyTruncatedCalls`, `agyErrorCalls`, `multiMcpTurns`, `multiRunCommandTurns`, `mediaLoadedCount`, and `multimodalHighCtxTurns` (>=180k context with media loaded).
- **Multi-module `SessionStart` snapshots & update guide**
  - Auto-detects multi-module subproject manifests (`pom.xml`, `web/package.json`, `desktop/package.json`, monorepo subpackages) alongside root manifests.
  - Added dedicated update instructions in [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md).

### Changed

- **Hard `<= 8,800 B` UTF-8 inline cap across all 4 MCP tools**
  - Enforced strict UTF-8 byte-budgeted water-filling (`<= 8,800 B`) unconditionally in `read_slices`, `batch_search`, `run_checks`, and `apply_edits` (even when callers explicitly pass a larger `maxChars`/`maxVerifyChars`), eliminating Antigravity's ~10 KB MCP `output.txt` spill-to-disk extra turns.
  - Appends a concise 1-line hint when `read_slices` slices are truncated to steer bulk range reads back to parallel built-in `read_file`.
- **Smarter `verify` / `run_checks` failure filtering**
  - Strips Pino/Bunyan info/debug JSON request logs (`level: 10/20/30`), Maven `[Help 1]` boilerplate footers, and Node `ExperimentalWarning` noise before budgeting failure output.
  - Expands context windows around Spring Boot `Description:` / `Action:`, Java `Caused by:`, compilation errors, and Vitest failure summaries so root causes are preserved.
- **Budgeted `SessionStart` snapshots**
  - Allocates fixed per-section budgets (`Project` → `Git` → `Layout`) so dirty repos with 100+ modified files never truncate scripts or directory layout.
  - Collapses noisy directories (`tmp/`, `output/`, `artifacts/`, `SSL/`, `logs/`) and prioritizes source/test directories (`src/`, `tests/`, `scripts/`) while filtering build/report artifacts (`dist-*`, `playwright-report/`) in 2nd-level trees.

### Fixed

- **TS/JS outliner (`findBraceBlockEnd`)**: Fixed no-semicolon (`semi: false`) single-line `type` aliases swallowing the following `interface` block, fixed inline object types inside parameter parentheses prematurely closing function end lines, and raised multiline signature lookahead from 15 to 40 lines.
- **Windows PowerShell 5.1 installer (`install.ps1`)**: Avoided single-string splatting and unexpected terminal exit when executed via `irm ... | iex`.

### 简体中文摘要（v0.2.0）

- **全工具硬封顶 `<= 8.8 KB` UTF-8 内联输出**：彻底杜绝显式大 `maxChars` 触发 Antigravity MCP 10 KB 落盘 `output.txt` 导致的额外轮次损耗，并在 `read_slices` 切片截断时提示改用并行内置 `read_file`。
- **大纲提取器全面升级**：新增 `.vue`/`.svelte`（`<script>`/`<template>`/`<style>`）、`.css`/`.scss`（`:root`/`[data-theme]`/`@media`/`@keyframes`/分区注释）、Fastify/Express 路由与 `describe`/`it` 测试提取；修复无分号 TS `type` 吞并、参数对象类型提前截断与长多行函数签名 Bug；`outlines` 上限提至 40 文件并按顶层结构公平分配。
- **`apply_edits` 容错与 `verify` 过滤增强**：支持 `bestEffort` 部分落盘、行号漂移精确命中提示、有界宽窗口提示；`verify` 失败过滤剔除 Pino info JSON 与 Maven 尾注，保留 Spring Boot `Description:` 与 Java `Caused by:` 根因。
- **路由规则与 TTFT 卫生规范**：内联 MCP Schema 免去懒加载读 Schema 轮次；明确 `read_slices` 探大纲 + 并行 `read_file` 读正文；扩展 `run_checks` 至多条诊断命令（`outputMode: "full"`）；明确多模态截图隔离给子 Agent、长会话分阶段 `/compact` 以避免 40–97s TTFT 悬崖。
- **快照、搜索与基准完善**：多模块子项目快照与二级目录源码置顶；`glob` 截断按目录汇总；`benchmark` 支持 `--since`/`--until`/`--split-usage` 及落盘/截断/报错/并发泄漏/多模态高危轮次指标；修复 Windows PowerShell 5.1 `install.ps1` 兼容性。

---

## [0.1.0] - 2026-11-19

### Added

- Initial release of `agy-fast`: zero-dependency single-file ESM local Stdio MCP server (`batch_search`, `apply_edits`, `read_slices`, `run_checks`), `SessionStart` workspace snapshot hook, `AGENTS.md` routing rules, cross-platform installers (`install.sh`, `install.ps1`, `scripts/install.mjs`), transcript benchmark CLI, and sanitized latency analysis reports (EN / ZH-CN).
