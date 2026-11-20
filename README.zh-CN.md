<div align="center">

<img src="assets/logo.svg" alt="agy-fast logo" width="76" />

# agy-fast

**面向 Google Antigravity 的合规延迟与工具调用加速插件**

零运行期依赖 · 单文件 ESM 产物 · 遵守官方规范 · 支持 Antigravity CLI（`agy`）、Desktop 2.0 与 IDE

[English](README.md) · 简体中文 · [更新日志](CHANGELOG.md) · [性能分析报告（中文脱敏版）](docs/ANALYSIS_REPORT.zh-CN.md) · [Latency Analysis Report (EN)](docs/ANALYSIS_REPORT.md)

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

## 实测效果（脱敏生产日志统计）

基于连续 **10 天真实编码轨迹** 的脱敏统计（**14 场未使用插件的主会话 / 5,771 轮** vs. **7 场启用 `agy-fast` 的主会话 / 901 轮**，以及 **104 场基线 vs. 4 场插件子代理会话**；已剥离全部仓库名、路径与会话标识），`agy-fast` 单次调用平均打包 **4.89 个逻辑操作**（子代理达 **5.95×**），在**耗时、额度消耗与上传流量**三个维度均取得显著优化：

| 核心指标（按“单位有效操作”归一化） | 主会话 · 基线 | 主会话 · `agy-fast` | 变化 | `>=150k` 长上下文主会话 | 子代理 |
| :--- | ---: | ---: | ---: | ---: | ---: |
| **每 10 操作所需模型轮次** | 5.23 轮 | **3.47 轮** | **-33.7%** | **-38.2%** | **-58.8%** |
| **每 10 操作上行请求数** *（LLM + 远端校验）* | 9.82 次 | **6.05 次** | **-38.4%** | **-42.6%** | **-62.0%** |
| **Prompt Cache 命中率** *（失效尖峰占比）* | 89.6% *(7.5%)* | **94.0%** *(4.8%)* | **+4.4 pp** | **95.0%** *(3.3%)* | 92.4% *(2.8%)* |
| **每操作全价新增输入（未命中缓存）** | 10,413 tok | **4,822 tok** | **-53.7%** | **-61.5%** | **-51.3%** |
| **每操作综合折算额度** *（权重 1 : 0.1 : 5）* | 22,458 eq | **15,387 eq** | **-31.5%** | **-36.5%** | **-54.0%** |
| **每操作工具返回上传字节** *（本地实测）* | 5.06 KB | **3.05 KB** | **-39.7%** | **-42.6%** | **-13.3%** |
| **每操作增量新增文本上传** *（增量同步口径）* | 35.6 KB | **16.5 KB** | **-53.7%** | **-61.6%** | **-51.3%** |
| **每操作全量历史文本上传** *（无状态重传估算）* | 342.2 KB | **276.2 KB** | **-19.3%** | **-21.9%** | **-58.9%** |

**`v0.2.x` 生产实测亮点：**
- **连续 134 次 MCP 调用 `0` 次溢盘**：全工具死守 `<= 8.8 KB` UTF-8 内联硬上限，彻底消除 Antigravity 将长输出落盘 `output.txt` 带来的二次读取损耗。
- **有效吞吐 `+75%`（`35.1 → 61.5 tok/s`），>60s 严重卡顿从 `31.2%` 降至 `7.4%`**：在同一场跨版本长会话的前后对照（99 轮 vs. 374 轮）中，启用多模态隔离规则后主编码会话加载截图数降至 `0`，彻底避开 `>180k` 上下文多模态 TTFT 悬崖。
- **`0` 次懒加载 Schema 盲读**：在 `rules/AGENTS.md` 中内联紧凑 Schema，跳过读取 `mcp/agy-fast_fast/*.json` 的额外轮次。

<details>
<summary>统计口径与固定开销说明</summary>

- **逻辑操作口径**：1 次含 5 个查询的 `batch_search` 计 5 个操作，1 次含 6 处 hunk + `verify` 的 `apply_edits` 计 7 个操作，内置 `read_file`/`edit_file`/`run_command` 计 1 个操作，确保按“同等实际工作量”公平对比。
- **多权重敏感性校验**：标准计费权重（未缓存输入 `1.0` : 缓存读 `0.1` : 输出 `5.0`）下主会话省 **31.5%**（`>=150k` 长上下文省 **36.5%**）；换用保守缓存折扣（`1 : 0.25 : 4` → **-25.8%**）或高输出权重（`1 : 0.1 : 8` → **-29.4%**）结论一致。
- **固定 Prompt 开销**：`rules/AGENTS.md` + `SessionStart` 快照每会话合计仅增加 **~1.7k tokens**（第 2 轮起命中缓存，每轮约 170 eq tokens）；只要省掉 **1 次多余轮次**（~44k eq tokens）或 1 次大文件盲读即回本 **20 倍以上**。
- **本地复现**：可在自己机器上运行 `node dist/benchmark.mjs analyze --local --split-usage` 直接验证。

</details>

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

### 自动更新与手动更新

`agy-fast` 内置了**零启动延迟的后台自动更新机制**（无需执行 `npm install`，每次发版均附带预构建 `dist/*.mjs` 产物）：

- **工作原理**：
  - 每 **12 小时**在 `SessionStart` 吐出快照后，异步拉起完全分离的后台更新进程（`dist/updater.mjs`），**不增加任何会话启动延迟**。
  - 通过 `git ls-remote --tags`（无 `git` 时回退 GitHub Releases API）检测最新正式版本标签，克隆到临时暂存目录后**先执行实时 MCP 4 工具冒烟校验**，校验通过后再按文件原子替换运行产物。
  - **安全保护**：常规复制安装与干净的直接 `git clone` 安装会自动更新；`--link` 开发软链接与有未提交改动的仓库**绝不覆盖**（仅提示有新版本）；校验失败的损坏版本会被自动拦截、原安装完全不受影响。
  - 更新完成后，下一次开启新会话会在启动快照末尾弹出一次性提示。

- **手动触发更新与配置**：
  ```bash
  # 仅检查是否有新版本，不修改文件
  node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs update --check

  # 立即更新并自动自检（也可直接用 ./install.sh update 或 .\install.ps1 update）
  node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs update

  # 切换模式：auto（默认自动更新）| notify（仅后台检查提醒）| off（关闭后台检查）
  node ~/.gemini/config/plugins/agy-fast/scripts/install.mjs config --auto-update notify --interval 24
  ```

- **环境变量覆盖**：
  - `AGY_FAST_AUTO_UPDATE=auto|notify|off` — 覆盖自动更新模式（优先级高于配置文件）。
  - `AGY_FAST_UPDATE_INTERVAL_HOURS=12` — 后台检查间隔（小时）。
  - `AGY_FAST_UPDATE_CHANNEL=release|main` — 跟踪稳定发版标签（`release`，默认）或 `main` 分支。
  - `AGY_FAST_REPO=<git-url>` — 自定义镜像或 Fork 仓库地址。

- **一行命令覆盖更新（兜底方式）**：
  ```bash
  # macOS / Linux
  curl -fsSL https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.sh | sh
  ```
  ```powershell
  # Windows (PowerShell)
  irm https://raw.githubusercontent.com/INK-Q/agy-fast/main/install.ps1 | iex
  ```

> **更新生效提示**：新版 `rules/AGENTS.md` 与 `dist/session-start.mjs` 在下一次开启新会话时自动生效；Antigravity 桌面端 / IDE 若需立即刷新常驻 MCP 服务，重载窗口或重启一次即可。

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
