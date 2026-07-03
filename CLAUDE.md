# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 沟通语言 / Communication language

**永远用中文回复用户。** 无论用户用什么语言提问,所有面向用户的回复一律用中文(代码、命令、标识符、引用的英文术语保持原文)。同样适用于 `AGENTS.md`(Codex 入口),两份文档保持一致。

## 项目本质 / What this is

「额度守卫」:让 Claude Code 和 Codex 在跑长任务时实时感知订阅额度,接近上限时在**轮末干净暂停 + 写 checkpoint**,而非执行中途被硬切。不读日志、不估算,直接查官方 usage 端点。

不能绕过限额(API 耗尽就是耗尽)。它只能提前停在干净点 + 帮你续接。改任何逻辑前先读 `README.md` 的「支持范围与诚实边界」和「配置项」两节。

**这是一个正经的 Node 包**:git 仓库(`origin` = `raysonmeng/agent-quota-guard`,已有多次 PR 合并历史)、`package.json` v0.2.0(**已发布到 npm**,`npx agent-quota-guard …` 可直接跑)、GitHub Actions CI(`.github/workflows/ci.yml`,macOS + Linux 双矩阵)、245 个自动化测试(`node --test`)。**核心实现是 Node ESM(`lib/` + `bin/`),零运行期依赖**;Claude 与 Codex 的 hook、探针**都走 Node**。`claude-budget-guard/`、`codex-budget-guard/` 现在只剩安装器(`install.sh`)、共享的 `watchdog.sh`(逐字节相同的两份拷贝)、以及 Codex 专属的 MCP server —— 早期的 Bash guard/probe/config 已删除。运行期依赖 `jq` `curl`(macOS 还用 `security` 读 Keychain);Codex 安装期额外需要 `python3`(仅用于安全合并 TOML/JSON)。

## 架构关键(读多个文件才能拼出的全貌)

```
agent-quota-guard/
├── lib/                    ← Node 核心(真正被安装/调用的实现)
│   ├── guard/
│   │   ├── hook.mjs        五 phase hook 核心;每个 phase 都有 claude / codex 分支
│   │   ├── checkpoint.mjs  硬线下 PreToolUse 的精确路径放行(含 codex apply_patch 解析)
│   │   ├── config.mjs      全局 + 项目 .conf 加载(与 Bash budget-config.sh 行为一致)
│   │   └── fingerprint.mjs  一次性提醒去重(T1/T3 只提醒一次)
│   ├── probe/
│   │   ├── index.mjs       取数编排:cache / 429 gate / fixture / live,输出 probe_schema 2
│   │   ├── claude.mjs / codex.mjs  各 provider 的取数 + 解析
│   │   ├── burn-rate.mjs   EWMA 双半衰期 burn-rate + runway(318 行,纯函数)
│   │   └── http.mjs
│   └── installer/claude.mjs  Claude 侧安装器(部署 payload、合并 settings.json hook、写 CLAUDE.md 协议)
├── bin/                    ← CLI 入口(薄壳,逻辑都在 lib/)
│   ├── cli.mjs             npx 统一入口:claude → Node 安装器;codex → bash 安装器
│   ├── install-claude.mjs  Claude 安装器 CLI shim(→ lib/installer/claude.mjs)
│   ├── guard.mjs           hook 运行入口(→ lib/guard/hook.mjs);**这是被写进用户 hook 的东西**
│   └── probe.mjs           探针 CLI(→ lib/probe/index.mjs);**agent-bridge 跨仓依赖此文件**
├── claude-budget-guard/    ← install.sh(DEPRECATED 薄转发器,exec bin/install-claude.mjs)+ watchdog.sh
├── codex-budget-guard/     ← install.sh(bash,写 config.toml + 部署 Node payload)、watchdog.sh、
│                             mcp-server.mjs / mcp-tools.mjs(wait_until_budget_refresh MCP 工具)
└── tests/                  ← node --test 套件(208 case);codex-budget-guard/test/ 另有 37 case
```

**谁是真正被调用的 hook?** —— **Claude 与 Codex 的真实 hook 都是 Node 的 `bin/guard.mjs`**。
`lib/installer/claude.mjs` 把 `"<binDir>/guard.mjs" claude <phase>` 写进 `~/.claude/settings.json`
(见 `HOOK_MARKER = 'guard.mjs'` 与 `buildHookEntry`,约 `lib/installer/claude.mjs:268`);
`codex-budget-guard/install.sh` 对称地把 `"<binDir>/guard.mjs" codex <phase>` 写进 `~/.codex/config.toml`
的 `[[hooks.*]]`,并把 Node payload(`bin/guard.mjs`、`bin/probe.mjs`、`lib/guard`、`lib/probe`)部署到
`~/.budget-guard/`。`lib/guard/hook.mjs` 的每个 phase 都有 `agent === 'codex'` 分支,`lib/guard/checkpoint.mjs`
完整解析 Codex 的 apply_patch 语法——两端共用同一套 Node 逻辑,`$1`(agent)区分行为。

**phase 调度模型** —— guard 挂在五个生命周期事件上,`lib/guard/hook.mjs` 的 `run()` 按 phase 分派:

| phase | 挂载事件 | 行为(`lib/guard/hook.mjs`) |
|---|---|---|
| `prompt` | UserPromptSubmit | 检测 `/goal /loop /batch /background`,给规划预估(额度充足时出声的主要情形);另外检测**显式跳过短语**(`/budget-skip`/`force-continue`/`跳过硬线`/`强制继续`),命中则写限时 skip marker(不查用量) |
| `pre` | PreToolUse | checkpoint 提醒线/硬线/可信 runway 收尾保护线只发减速提醒,不 deny;checkpoint 写入与 **skip marker 有效** 时静默放行 |
| `post` | PostToolUse | T1(≥warnOnce,一次)/ T2(≥warnRepeat,每轮)/ checkpoint 提醒线 / T3(≥hard,硬线临近)分级软提醒;skip 有效时 T3 改「不强停」措辞且不消耗真实 T3 fingerprint |
| `stop` | Stop/SubagentStop | 循环轮末重估;**util 硬线** `continue:false` 强停 + 写 `pending/<agent>_<scope>.json` 给 watchdog;**skip marker 有效则不强停、不写 pending**。provider 429/rate-limit **只限流探针刷新(改用 stale 缓存 util 判阈值),绝不单独强停/写 pending** —— 它不是额度耗尽 |
| `resume` | SessionStart | 有上次 checkpoint 就注入上下文续接(同项目作用域,git worktree 感知) |

**CC 软提示走 `additionalContext`(给 agent 读);Codex 走 `systemMessage`(给用户看)** —— 因 Codex PreToolUse 不支持 `additionalContext`。

**核心不变量(改代码别破坏):**
- **fail-open**:查不到用量(网络/token/字段对不上)一律 `exit 0` 静默放行;任一内部错误在 `run()` 里被吞掉返回 null。绝不因守卫自身问题卡死 agent。
- **统一走 `exit 0 + JSON`**,从不混用 `exit 2`。`guard.mjs` 恒 exit 0;`doctor` 才用 0–4 退出码。
- **静默优先**:`warn_util < warnOnce` 时除长任务预估和可信 runway 收尾保护线外一个字不冒。
- **硬线只在轮末停**(`stop` phase),`pre` 只提醒不拦工具——避免执行中途切。默认硬线 `BUDGET_HARD=99`,作为外层超限保险丝;默认 checkpoint 提醒线约 95%(`BUDGET_CHECKPOINT_LEAD`,自动压在 hard 以下),给 agent 留足写 checkpoint 的 lead。
- **手动跳过(override)只能延后干净停止,绝不绕过限额**:仅显式短语在 `prompt` phase 触发,写限时(`BUDGET_SKIP_TTL`,默认 1800s)、按项目作用域的 marker;`pre`/`stop` 在硬线时若 marker 有效则放行/不强停,到期自动恢复。所有错误路径 fail-safe 朝「无 skip → 继续提醒并在轮末干净停」(坏 marker = 当作过期)。`BUDGET_SKIP_TTL` 是 env-only(**不**在配置文件 ALLOWLIST 内),防止仓库内 `.budget-guard.conf` 偷偷拉长跳过时长。
- **`watchdog.sh` 两份拷贝逐字节一致**:`claude-budget-guard/watchdog.sh` 与 `codex-budget-guard/watchdog.sh` 是复制而非软链(两个安装器各部署本目录一份),改一处**必须同步另一处**;`tests/override.test.mjs` 有字节相等断言把关。两个 `install.sh` 各自分叉(Claude 转发 Node 安装器,Codex 写 config.toml)。

**数据流 / 状态目录**(默认 `~/.budget-guard/`,`BUDGET_STATE_DIR` 可覆盖):
- `usage_<agent>.json` —— 用量缓存(`BUDGET_CACHE_TTL` 秒,默认 45;PreToolUse 每次工具调用都跑,必须缓存)。写入用 lockfile + 原子 rename + CAS(同秒不让低 util 盖高 util)。
- `ratelimit_<agent>.json` —— provider 429 闸(Retry-After 或默认 5min,longest-wins)。
- `burn_<agent>.json` —— burn-rate EWMA 状态(`lib/probe/index.mjs` 写,`lib/probe/burn-rate.mjs` 折算)。
- `pending/<agent>_<scope>.json` —— **util 硬线**暂停时写的待续队列(provider 429/rate-limit 不写),`scope = sha256(realpath(cwd)+sessionId)`;watchdog/agent-bridge 逐个读它续跑;旧 `pending_<agent>.json` 扁平文件同时写一份供旧 watchdog 兼容读取。
- `skip/<agent>_<scope>.json` —— 手动跳过硬线的限时授权 marker(`{"expires":<epoch>}`);`pre`/`stop` 读它判断是否放行,过期自动清理。
- `notified/*.json` —— fingerprint(T1/T3 一次性提醒去重),SessionStart 时顺带清理过期项。

**burn-rate 算法(`lib/probe/burn-rate.mjs`,318 行,纯 Node)**:EWMA 双半衰期(短 2h / 长 24h),按样本对判定 non-monotonic / cross-reset / regression / ok,产出 `burn_rate_pct_per_hour` `burn_confident` `runway_seconds` `depleted_at_epoch`,作为 **probe_schema 2** 的 per-bucket 字段附加输出(纯 additive)。字段契约与 agent-bridge 共享,**改动前对齐 `burn-rate.mjs` 顶部注释**。Node hook 用这些字段做「可信 runway 收尾保护线」。(旧 Bash `budget-probe` 的两点法 `seconds_to_hard()` 已随 Bash 包删除。)

**CC vs Codex 的真实差异**(改 Codex 分支前必读):
- Codex 现版 PreToolUse 覆盖 Bash、apply_patch、MCP 和扩展工具;硬线放行 checkpoint 必须**精确路径匹配**,不能 basename/近似匹配(`lib/guard/checkpoint.mjs` 专门解析 codex apply_patch 的 `*** Update/Add/Delete File:` / `*** Move to:` 语法,并拦 symlink 绕过)。
- Codex usage 端点已实证为 `https://chatgpt.com/backend-api/wham/usage`;需要 `ChatGPT-Account-Id` header,字段是 `rate_limit.primary_window/secondary_window` 和 `additional_rate_limits[]` 的 `used_percent/reset_at/reset_after_seconds`。
- Codex headless(`codex exec`)不触发 lifecycle hook,会话内守卫只在交互 TUI 生效;headless 靠 watchdog 兜底(见 README)。
- Codex 的原地 park 由 MCP server 提供:`wait_until_budget_refresh` 工具(`codex-budget-guard/mcp-server.mjs` + `mcp-tools.mjs`)轮询探针直到 util 回落。

## 常用命令

```bash
# 测试(发布门禁,两套都必须全绿)
node --test tests/*.test.mjs                        # 主包 208 case(零依赖)
cd codex-budget-guard && npm ci && npm test         # codex 子包 37 case(依赖 MCP SDK / zod)
# 跑单个测试:node --test tests/guard.test.mjs   或   node --test --test-name-pattern='shouldFire' tests/guard.test.mjs

# 安装 / 卸载
npx agent-quota-guard claude                        # 装到 ~/.claude(Node 安装器)
npx agent-quota-guard codex                         # 装到 ~/.codex(bash 安装器 + MCP)
npx agent-quota-guard claude --uninstall
./install.sh [claude|codex] [--uninstall]           # clone 后的本地入口(薄包装)

# 手动查探针 / 触发 hook(stdin 喂 hook JSON)
node bin/probe.mjs claude probe                      # 一行 JSON(util / warn_util / buckets / burn 字段 …)
node bin/probe.mjs claude doctor                     # 人类可读诊断(阈值 / 429 闸 / schema),退出码 0-4
BUDGET_USAGE_FIXTURE=<path> node bin/probe.mjs claude probe   # 纯本地解析,不走网络
echo '{"prompt":"/goal 重构模块"}' | node bin/guard.mjs claude prompt

# 语法检查 + watchdog 两份拷贝一致性(shellcheck 可选)
bash -n codex-budget-guard/install.sh codex-budget-guard/watchdog.sh
diff claude-budget-guard/watchdog.sh codex-budget-guard/watchdog.sh   # 应无差异
```

## 测试状态

`node --test` 共 245 个自动化 case:`tests/*.test.mjs` 208 个(hook 五 phase、probe 取数/缓存/429、burn-rate EWMA、checkpoint 放行、override skip、resume 项目隔离、Claude 安装器幂等/卸载/转发、watchdog),`codex-budget-guard/test/budget-mcp.test.mjs` 37 个(Codex 探针 normalize、MCP wait loop、Codex 安装器 TOML 合并/幂等/卸载)。CI 在 macOS + Linux 双跑,任一失败即挂红,是发布门禁。

`tests/e2e/` 下另有 tmux 真机脚本(hook 触发、checkpoint 放行、stop 强停、C4 park),**非自动化**,涉及真实 usage 端点 / hook 触发 / watchdog headless 续跑的改动仍需真机带真 token 验证,不能只靠逻辑推断声称完成。

## 编码风格与命名

- **Node(核心)**:纯 ESM、零外部依赖、Node >=18。lib/ 是纯逻辑 + IO 分层(`parseUsage` 等纯函数不碰 `Date.now`/IO,`now` 作参传入);bin/ 只做 argv 分发 + stdin/stdout,不重复实现语义。
- **Bash(遗留)**:一律 `#!/usr/bin/env bash`;安装器 `set -euo pipefail`(快速失败),运行期 guard `set -uo pipefail`(去 `-e`,因大量 `|| true` 兜底实现 fail-open)。
- 配置变量全大写、统一 `BUDGET_` 前缀,全部可被环境变量覆盖、带默认值(`BUDGET_WARN_ONCE` `BUDGET_WARN_REPEAT` `BUDGET_CHECKPOINT_LEAD` `BUDGET_HARD` `BUDGET_STATE_DIR` …);`BUDGET_SOFT` 仅作 `WARN_REPEAT` 的 deprecated alias。
- 面向用户的文案是**中文**——除非有意改产品语言,否则保持中文,别擅自英化。

## 提交约定

Conventional Commits + scope,标题可中英混排,正文/PR 描述行为变化、点名对用户配置路径(`~/.claude` `~/.codex` `~/.budget-guard`)的改动。历史风格见 `git log`,例如
`fix(guard): scope resume fallback to the same project / 续接 fallback 限定同项目 (#11)`、
`feat(budget): v3.2 — hard 92→99 + checkpoint lead + rate-limit pending`。走 feature 分支 + PR 合并。

> 落库前遵守全局 cross code review 硬规则(见 `~/.claude/CLAUDE.md`):任何新代码须过两轮独立 subagent 交叉审,连续两个新 reviewer 报 0 真实 issue 才能 commit。纯文档/单行 typo 除外。

## 安全与配置

- **绝不**提交凭据、usage 接口返回、或来自 `~/.claude` `~/.codex` `~/.budget-guard` 的文件。
- 配置分两层可选文件 + 环境变量(优先级:env > 项目 `.budget-guard.conf` > 全局 `~/.budget-guard/config` > 内置默认)。配置文件只接受**明确安全的调参 key**(`BUDGET_WARN_ONCE`/`WARN_REPEAT`/`SOFT`/`CHECKPOINT_LEAD`/`HARD`/`CACHE_TTL`/`HIST_WINDOW`/`CLAUDE_UA`);命令、凭据、端点、路径、自动化类 key(`BUDGET_PROBE`、token、`BUDGET_CODEX_URL`、`BUDGET_STATE_DIR`、`BUDGET_WATCHDOG_ARM`、`BUDGET_SKIP_TTL` …)必须显式 env,防仓库内 `.conf` 提权。Node 侧 `lib/guard/config.mjs` 与 Bash 侧 `budget-config.sh` 的 ALLOWLIST 必须一致。
- 安装器会写入 `~/.budget-guard`、`~/.claude`/`~/.codex`;改安装/卸载流程时在一次性 `HOME` 下验证幂等(现实现对已有 hook 幂等过滤 + 改前 `.bak`,保持这条),别对用户已有配置做破坏性假设。
- `watchdog.sh` 是无人值守跑 agent,默认 `BUDGET_WATCHDOG_ARM=0`(dry-run)。改续跑逻辑或权限白名单时,保持默认不武装、限权(`--allowedTools`/`--sandbox workspace-write`/`--max-turns`)、限定项目目录这几条底线。

## 文档关系

`CLAUDE.md`(本文件)是本仓库**唯一权威**的 agent 上手文档。同目录的 `AGENTS.md`(Codex 入口)已收成指向本文件的指针,不再单独维护——所有更新只改本文件。面向终端用户的安装/使用说明在 `README.md`(中英双语)。

<!-- AgentBridge:start -->
## AgentBridge — Multi-Agent Collaboration

You are working in a **multi-agent environment** powered by AgentBridge.
Another AI agent (Codex, by OpenAI) is available in a parallel session on this machine.

### Communication mechanism
- **Claude → Codex**: Use the AgentBridge MCP tools (`reply` / `get_messages`) — these are yours only.
- **Codex → Claude**: Codex has no symmetric tool. The bridge transparently intercepts Codex's normal output and forwards it to you. Messages arrive as push notifications (or via `get_messages` in pull mode).
- If Codex ever complains it can't find a "send-to-Claude" API, remind it that its side is transparent — it just writes a reply and you'll see it.

### When to collaborate vs. work solo
- **Collaborate** when the task benefits from a second perspective, parallel execution, or capabilities you lack (e.g., sandboxed code execution, independent verification).
- **Work solo** for simple, self-contained tasks where the coordination overhead isn't worth it.
- When in doubt, **propose a task split** to Codex rather than doing everything yourself.

### Capability comparison
| Capability | Claude (you) | Codex |
|---|---|---|
| Architecture & planning | Strong | Moderate |
| Code review & analysis | Strong | Strong |
| Sandboxed code execution | No | Yes |
| File editing & refactoring | Yes (via tools) | Yes (via sandbox) |
| Web search & docs | Yes | Limited |
| Independent verification | Cross-review | Reproduce & test |

### How to start collaborating
1. When you receive a complex task, **proactively propose a division of labor** to Codex via the reply tool.
2. State what you'll handle and what you'd like Codex to take on.
3. Ask for Codex's agreement or counter-proposal before proceeding.
4. After task completion, **cross-review** each other's work.
<!-- AgentBridge:end -->
