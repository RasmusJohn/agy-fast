<div align="center">

<img src="assets/logo.svg" alt="agy-fast logo" width="76" />

# agy-fast

**面向 Google Antigravity 的合规延迟与工具调用加速插件**

零运行期依赖 · 单文件 ESM 产物 · 遵守官方规范 · 支持 Antigravity CLI（`agy`）、Desktop 2.0 与 IDE

[English](README.md) · 简体中文 · [性能分析报告（中文脱敏版）](docs/ANALYSIS_REPORT.zh-CN.md) · [Latency Analysis Report (EN)](docs/ANALYSIS_REPORT.md)

</div>

---

## 为什么开发 `agy-fast`

基于 **55 个真实 Antigravity 会话（8,446 轮模型调用、17,302 次工具调用、55.25 小时纯单 Agent 活跃时间）** 的脱敏定量分析，任务慢的主要原因并非模型生成速度慢，而是以下 4 个结构性开销：

1. **每轮固定首字等待约 6.1 秒**：68.1% 的轮次输出不足 700 tokens，中位数轮次中约 79% 的时间在等待首字节响应。每多一轮往返，就会额外增加约 6~8 秒。
2. **工具串行执行与细粒度拆分**：52.5% 的 `edit_file` 是同一轮内对同一文件的重复拆分调用；46.3% 的 `run_command` 只是 `rg`/`grep`/`find`/`git status` 等毫秒级只读搜索，但每次通过 Shell 调用平均消耗 2.0~2.6 秒。
3. **会话启动探索耗时**：前 3 轮平均花费 **49.2 秒**检查目录结构、git 状态和构建脚本。
4. **上下文膨胀与缓存失效**：`read_file` 占全部工具返回体积的 **81.9%**；相邻两轮间隔超过 60 秒后，提示词缓存失效率从 **1.4%** 升至 **15.9%~93.8%**。

完整统计数据与方法论见脱敏报告：**[docs/ANALYSIS_REPORT.zh-CN.md](docs/ANALYSIS_REPORT.zh-CN.md)**。

`agy-fast` 完全基于 Antigravity 官方插件机制，通过合并高频读写与检索操作、压缩上下文体积和一次性注入启动快照来减少轮次数和串行等待时间。

---

## 快速安装

环境要求：**Node.js >= 20**。**无需执行 `npm install`**，仓库已附带零依赖单文件产物（`dist/*.mjs`）。可选安装 [`ripgrep` (`rg`)](https://github.com/BurntSushi/ripgrep) 进一步加速代码搜索（未安装时自动回退到 Node.js 并发遍历）。

### 方式一：一行命令安装（推荐）

无需手动克隆仓库，直接执行一条命令即可完成安装（自动复制运行文件到 `~/.gemini/config/plugins/agy-fast`，若本机有 `agy` CLI 则自动执行严格校验和启用，并运行 MCP 与 Hook 实时自检）：

**macOS / Linux：**
```bash
curl -fsSL https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.sh | sh
```

**Windows（PowerShell）：**
```powershell
irm https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.ps1 | iex
```

**或在本地克隆后使用 Node.js 安装（全平台通用）：**
```bash
git clone https://github.com/INK-Q/agy-fast.git
cd agy-fast
node scripts/install.mjs install
```

### 方式二：直接克隆到 Antigravity 插件目录

无需运行任何安装脚本，Antigravity 会自动发现 `~/.gemini/config/plugins/` 下的插件：

```bash
# macOS / Linux
git clone https://github.com/INK-Q/agy-fast.git ~/.gemini/config/plugins/agy-fast
```

```powershell
# Windows (PowerShell)
git clone https://github.com/INK-Q/agy-fast.git "$env:USERPROFILE\.gemini\config\plugins\agy-fast"
```

### 方式三：使用 `agy` 官方 CLI 安装

```bash
agy plugin install /path/to/agy-fast
agy plugin enable agy-fast
```

### 方式四：按项目安装（适合团队仓库共享）

仅安装到指定代码仓库的 `.agents/plugins/agy-fast`：

```bash
node scripts/install.mjs install --project /path/to/your-repo
```

### 方式五：直接让 Antigravity 自动安装

将以下指令直接发送给 Antigravity：

```text
请将 https://github.com/INK-Q/agy-fast.git 克隆到 ~/.gemini/config/plugins/agy-fast，运行 `node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs doctor` 验证可用性，并启用 agy-fast 插件。
```

### 更新到最新版本

更新操作幂等安全，且**无需执行 `npm install`**（仓库已附带最新 `dist/*.mjs` 产物）：

- **通过「方式一：一行命令」安装（推荐）**——直接重新执行安装命令即可覆盖更新运行文件并自动自检：
  ```bash
  # macOS / Linux
  curl -fsSL https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.sh | sh
  ```
  ```powershell
  # Windows (PowerShell)
  irm https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.ps1 | iex
  ```
- **通过「方式二：直接克隆到插件目录」安装**：
  ```bash
  # macOS / Linux
  git -C ~/.gemini/config/plugins/agy-fast pull --ff-only && node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs doctor
  ```
  ```powershell
  # Windows (PowerShell)
  git -C "$env:USERPROFILE\.gemini\config\plugins\agy-fast" pull --ff-only; node "$env:USERPROFILE\.gemini\config\plugins\agy-fast\scripts\install.mjs" doctor
  ```
- **通过本地克隆仓库或「方式四：按项目安装（`--project`）」安装**：
  ```bash
  cd agy-fast && git pull --ff-only
  node scripts/install.mjs install                     # 更新全局安装
  # 或更新指定仓库：node scripts/install.mjs install --project /path/to/your-repo
  ```

> **更新生效提示**：更新完成后，在 Antigravity CLI（`agy`）中开启新会话，或在桌面端 / IDE 中重启（或重载窗口），以重启常驻 MCP 服务并加载新版 `dist/*.mjs` 与 `rules/AGENTS.md`。

### 健康检查与卸载

```bash
# 检查 Node 版本、rg 可用性、MCP 实时握手与 4 个工具、SessionStart 延迟以及严格规范校验
./install.sh doctor        # macOS / Linux（Windows 使用 .\install.ps1 doctor）
# 或直接运行：node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs doctor

# 卸载全局插件
./install.sh uninstall     # macOS / Linux（Windows 使用 .\install.ps1 uninstall）
# 或直接运行：node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs uninstall
```

> **桌面端 / IDE 启用提示**：打开 Antigravity 侧边栏的 **Customizations → Installed**，确认 `agy-fast` 已处于开启状态，然后开启新会话即可生效。

---

## 插件组成

| 模块 | 文件路径 | 作用 |
| :--- | :--- | :--- |
| **原生插件清单** | [`plugin.json`](plugin.json) | 符合官方规范的元数据，通过 `agy plugin validate --strict` 零警告校验 |
| **本地常驻 MCP 服务（`fast`）** | [`mcp_config.json`](mcp_config.json) → [`dist/mcp-server.mjs`](dist/mcp-server.mjs) | 本地常驻进程，仅注册 **4 个合并操作工具**（`agy-fast_fast`），将多次细粒度操作合并为单次调用 |
| **会话启动快照钩子** | [`hooks.json`](hooks.json) → [`dist/session-start.mjs`](dist/session-start.mjs) | 仅在 `SessionStart` 运行一次（实测约 35~50 ms），注入 ≤1.5 KB 的 git 状态、2 层目录与脚本清单 |
| **工具路由规则** | [`rules/AGENTS.md`](rules/AGENTS.md) | 约 2.2 KB 精简规则，内置 `agy-fast_fast` 4 个工具的参数签名，支持直接发起 `call_mcp_tool` 调用而无需额外先读 schema JSON 文件 |
| **离线基准测试工具** | [`dist/benchmark.mjs`](dist/benchmark.mjs) | 本地解析 `transcript.jsonl` 并输出单次统计或 A/B 对比表 |

### 4 个核心 MCP 工具

1. **`batch_search`**：单次并发执行最多 20 条混合查询（`text`、`regex`、`glob` 与只读 `git` 子命令 `status`/`diff`/`log`/`show`/`branch`/`rev-parse`/`ls-files` 等，支持按条传 `path` 跨目录/跨仓查询）。优先调用 `rg`，无 `rg` 自动回退 Node.js；默认按 UTF-8 字节预算封顶（`≤ 8.8 KB`），避免结果落盘成临时文件而多出额外轮次。
2. **`apply_edits`**：单次原子执行单文件多处或跨文件修改（先在内存中校验匹配与重叠，失配时自动返回最相近代码行片段；超大批量可传 `bestEffort: true` 保留成功文件并仅重试失败文件）。保留 CRLF 换行符、文件权限与软链接，支持 `startLine`/`endLine`、新建/覆写（`create`/`overwrite`）、`dryRun` 与可选内联 `verify` 校验命令。
3. **`read_slices`**：单次请求同时支持提取多语言符号大纲（TS/JS、Python、Go、Rust、Java/Kotlin/C#/C/C++/Swift、Shell、Markdown、JSON/YAML 的精确起止行号）与多文件精确行段批量读取，避免盲读大文件导致上下文膨胀。
4. **`run_checks`**：在受控并发池中同时运行多项构建、类型检查、代码规范检查或单元测试；支持超时强杀、ANSI 转义符清理；默认 `compact` 模式通过时仅返回 1 行摘要，失败时提取关键报错与尾部日志。

---

## 离线测量前后对比

所有分析均在本地完成，不上传任何轨迹数据：

```bash
# 统计本机全部 Antigravity 历史轨迹的基线指标
node dist/benchmark.mjs analyze --local

# 仅分析最近修改的 10 个本地会话（便于安装前后快速对比）
node dist/benchmark.mjs analyze --local --recent 10

# 按插件安装时间切分（兼容旧对话续聊），并对比“已用 vs 未用 agy-fast”的会话指标
node dist/benchmark.mjs analyze --local --since 2026-11-19T12:51:00+08:00 --split-usage

# 对比同一任务在启用插件前后的指标变化
node dist/benchmark.mjs compare --before ./before/transcript.jsonl --after ./after/transcript.jsonl
```

---

## 合规与安全说明

- 仅使用 Antigravity 官方文档定义的插件扩展接口（`plugin.json`、`mcp_config.json`、`hooks.json`、`rules/AGENTS.md`）。
- **不绕过、不禁用、不修改**任何内置安全评估机制、客户端程序文件或认证流程。
- **不注册** `PreToolUse`、`PostToolUse`、`PreInvocation` 等每步同步阻塞钩子。
- `SessionStart` 采用失败放行策略：遇到异常输入或不可读目录时返回 `{}` 并正常退出，绝不阻断会话启动。
- 打包产物不混淆，全部源码与产物均可直接审计。

---

## 本地开发与测试

```bash
npm install
npm run typecheck   # TypeScript 严格类型检查
npm run build       # 使用 esbuild 打包 src/*.ts -> dist/*.mjs
npm test            # 运行全部单元测试、MCP 协议测试、Hook 测试、基准测试与安装器测试
npm run validate    # 运行 `agy plugin validate --strict .`
```

---

## 开源协议

[MIT](LICENSE)
