# Changelog

All notable changes to `agy-fast` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.2.3] - 2026-11-20

### Added

- **Godot GDScript (`.gd`) symbol outlining in `read_slices` (#2, thanks `@star-dino`)**
  - Extracts `class_name`, nested inner `class` (with accurate `depth`), `func` / `static func`, single- and multiline `signal`, and named/anonymous single- and multiline `enum` blocks.
  - Handles Godot 4 annotations (`@tool`, `@rpc(...)`, `@abstract`, etc.), multiline typed signatures, `#`/`##` comments, `"""`/`'''` triple-quoted strings, Tab/space indentation, and UTF-8 BOM / CRLF line endings.
- **Extended `batch_search` modes, language filtering, multiline matching, fuzzy path lookup & mtime sorting (#3, thanks `@onezero-harmony`)**
  - Added `outputMode` (`"content"` | `"files_with_matches"` | `"count"`) to return only matching file paths or per-file match counts within the 8.8 KB inline budget.
  - Added `fileType` language/extension filtering (e.g., `typescript`, `ts`, `python`, `gdscript`) across `text`, `regex`, and `fuzzy` queries.
  - Added `multiline: true` cross-line `text`/`regex` matching across both `rg` and Node.js fallback (with automatic retry without strict `u` mode for ripgrep-valid identity escapes like `\:` / `\#`).
  - Added `type: "fuzzy"` case-insensitive multi-token path lookup (`src/utils/fuzzy-match.ts`) with Windows backslash normalization and contiguous-substring-first ranking.
  - Added `sortBy: "mtime"` for `glob` queries to list recently modified files first.

### Documentation

- Added sanitized 10-day real-world latency, token-quota, and upload-bandwidth benchmarks, an explicit non-invasive UI/diff guarantee, and a concise FAQ to [README.md](README.md) and [README.zh-CN.md](README.zh-CN.md).

### 简体中文摘要（v0.2.3）

- **`read_slices` 新增 Godot GDScript（`.gd`）大纲提取（#2，感谢 `@star-dino`）**：完整支持 `class_name`、嵌套内部 `class`、`func`/`static func`、单行/多行 `signal` 与具名/匿名 `enum`，兼容 Godot 4 行内注解、三引号字符串、Tab/空格缩进及 BOM/CRLF。
- **`batch_search` 新增多模式检索、语言过滤、跨行匹配、模糊路径与按修改时间排序（#3，感谢 `@onezero-harmony`）**：支持 `outputMode`（`content`/`files_with_matches`/`count`）、`fileType`、`multiline: true`（`rg` 与 Node 双路径一致，且兼容 `\:`/`\#` 等转义）、`type: "fuzzy"`（兼容 Windows 反斜杠与连续子串优先排序）以及 `glob` 的 `sortBy: "mtime"` 最新优先排序。
- **文档增强**：中英文 README 新增 10 天脱敏实测数据（耗时、额度、上传流量）、无侵入声明（不影响原生 Diff 窗口与文件修改列表）及常见问题 FAQ。

---

## [0.2.2] - 2026-11-20

### Improved

- **Smart fallback & hints for `batch_search` `glob` queries (`src/tools/batch-search.ts`)**
  - Preserves exact glob matching first; only when exact matching returns 0 files, automatically recovers two common LLM mistakes observed in live transcripts:
    - Regex alternation passed to `glob` (e.g., `test|smoke|live`) is auto-expanded with a concise inline note (or returns a syntax hint when still empty).
    - Bare keywords without wildcards, slashes, or extension dots (e.g., `proxy`) fall back to case-insensitive path substring matching (`*proxy*`) while keeping missing explicit filenames (e.g., `missing.ts`) cleanly as `(no files matched)`.
- **Higher-density large outline batches (`src/tools/read-slices.ts`)**
  - Tuned `perFileSymbolLimit` for larger batches (`11–20` files: `16` symbols; `>20` files: `10` depth-0-prioritized symbols) and shortened per-file omission footers (`... (+N more symbols)`) so 30–40 file calls spend less of the 8.8 KB cap on truncation boilerplate.
  - Appends a 1-line batching tip when outlining `>20` files exceeds the 8.8 KB inline budget, steering callers toward 10–20 files per batch.
- **Swarm worker & schema guidance (`rules/AGENTS.md`, `src/mcp-server.ts`)**
  - Added concise guidance in Rule 6 to remind swarm workers in their brief to batch searches/edits via `agy-fast_fast` (if available) or parallel ranged `read_file` instead of serial `ls`/`grep` shell calls, since swarm workers do not receive the `SessionStart` snapshot.
  - Clarified `batch_search` glob syntax (`*`/`{a,b}`, not regex `|`) and recommended `read_slices` outline batch sizes (`10–20` files, max 40) in both `AGENTS.md` and MCP tool schemas.

### 简体中文摘要（v0.2.2）

- **`batch_search` 的 `glob` 智能容错与提示**：精确匹配优先不变；仅在精确命中为 0 时，自动恢复实测对话中常见的两类误传——正则交替符 `|`（如 `test|smoke|live`）与无通配符/扩展名的裸关键词（如 `proxy`），并在输出头部附带简短语法提示，同时保持明确缺失文件名（如 `missing.ts`）的原样空结果。
- **`read_slices` 大批量大纲预算优化**：收紧 `11–20` 文件（16 符号）与 `>20` 文件（10 顶层优先符号）的单文件上限并精简省略提示，减少 8.8 KB 上限内被截断尾注吃掉的字节；一次请求 `>20` 文件超预算时尾部提示改用 10–20 文件分批。
- **Swarm Worker 路由与 Schema 补充**：在 `rules/AGENTS.md` 补充协调者拉起 swarm worker 时在 `brief` 中提示使用 `agy-fast_fast` 或并行带行号 `read_file`（避免因缺少 `SessionStart` 快照而退化为串行 `ls`/`grep`），并在规则与 MCP Schema 同步注明 `glob` 语法及大纲推荐批量。

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
