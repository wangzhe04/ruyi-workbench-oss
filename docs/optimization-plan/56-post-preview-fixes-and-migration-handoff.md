# 56 号文 · 3.0 预览版后第一批修复 + 老版本迁移交接（2026-09-24）

> 换机器从这里进。本文件记三件事：本批已做了什么（§1）、验证到哪一步（§2，**全量回归没跑完就提交了**）、
> 还没做的（§3 老版本迁移设计与待拍板项，§4 其他尾巴）。

## 1. 本批已做（commit 见 git log，本文件同一提交）

| # | 用户原话（摘） | 改了什么 | 位置 |
|---|---|---|---|
| ① | 最大化时点开别的程序，边缘渲染碎片 | 无边框壳处理 `WM_NCACTIVATE`：`lParam=-1` 交给 DefWindowProc，失焦不再重画旧式非客户区框架。**未在真机屏上目视验证**，需 `npm run build:desktop` 后最大化→切走→看边缘 | `desktop/RuyiDesktop.cs`（提交 `9ed299d3`，已在 origin） |
| ② | 子 agent 上下文上限与主会话不一致 | 一度改成跟随电量表按模型覆盖，**用户否决并撤回**：子 agent 原本就按模型窗口算（provider 手填→探测→名称表→1M 兜底）。唯一不一致：工作流里 Claude 引擎节点名称表不认识的模型按 200K 兜底（主会话 1M）——未改，待用户说要不要统一 | `09-workflow.js` runNode `dsWindow` |
| ③ | 切「智能自动」的二级菜单会打开设置，不直观 | 管家头部盾牌菜单：选「智能自动」就地在菜单里二次确认（与线程 chip 菜单同一模具、同一份五条文案），不再跳设置页 | `public/js/steward-settings.js` `showShieldConfirm` |
| ④ | 线程没跑完，管家就一直同步进度，每次带「它交付的原文 / 这一次没取到原文」 | (a) 收件箱：看管线程回合收了但**后台命令 / 活着的子代理或班组 run** 还在跑 → 不报这一回合、不推基线；后台落地后那一轮报**一次**。(b) 同线程的班组 `done` 在回合报告已入箱或被按住时不再单独叫醒管家（failed/budget 照报）。(c) 交付卡只挂「某回合跑完了」这类带回合号的事件；信封取到但这回合没有交付正文 → 整块撤掉，不再垫「没取到原文」（取不到信封的兜底仍在，U10 不变） | `src/13i-steward-inbox.js`（`stewardThreadBackgroundBusy` / `stewardHeldTurnSessions`）、`public/js/steward-conversation.js` |
| ⑤ | 权限/提问收起来的小窗，希望管家界面也能看到 | 「等你处理」小窗在管家视角也显示（JS 的 `DOCK_SHELL_MODES` + 删 CSS 那条 `steward` 隐藏规则）；位置避让管家输入框与右侧线程抽屉底栏 | `public/js/prompt-queue.js`、`css/views/prompt-dock.css` |
| ⑥ | 后台任务完成后会话里多出很多内容，不用让用户看到 | `backgroundJobId` 那条回执行只留在数据里（模型下一回合照读），对话流不画；完成 toast 与后台任务条照旧 | `public/js/turn-narrative.js`、`session-experience.js` |
| ⑦ | 默认提问/权限时长改成无限久，超时（管家也没批）自动最小化 | 配置 `permissionTimeoutMs` / `questionTimeoutMs` 默认 **0 = 不限时**（>0 仍是老语义：权限到时拒、提问到时取消）。落到定时器上是 `PROMPT_WAIT_UNLIMITED_MS = 2147000000`（≈24.8 天，给 CLI 侧 +10 s 留余量，不越 `setTimeout` 2³¹−1 上限——越界会**当场触发 = 立刻拒**）。界面：截止时刻超过一周一律不显示倒计时；弹出的那一条 **2 分钟**没人碰（弹窗里点按/键入会重新计时，停在未发草稿上不收）→ 自动收进小窗。定时任务的无人值守回合仍走自己的等待表（07 `schedulerAskWaitOverrideMs`） | `src/01-config.js`、`src/04-permission-runtime.js`（`promptWaitMs` / `promptDeadlineIsReal`）、`src/07-autonomy.js`、`src/13q`、`public/js/prompt-queue.js`（`promptDeadline` / `autoMinimize`） |

**用户本机注意**：`~/.win-claude-workbench/config.json` 里 `permissionTimeoutMs` 被显式设成 300000（5 分钟，在 `configExplicitKeysV1` 里），新默认对它**不生效**。要不限时：对管家说「权限等待改成不限」，或把该键设 0。

## 2. 验证到哪一步（诚实账）

- 生成器链全过：`build.js` → `module-dependency-graph --write/--check`（54 模块 / 434 边，新增一条后向边）→ `route-inventory` → `architecture-contract-snapshots --write` → `durable-state-inventory --write` → `build.js --check`；`facts-generate`（e2e 397→398，README 四处同步）。
- 快通道 `run-all --fast`：77/77。
- 新增/改动的测试：
  - 新 `dev-harness/steward-background-hold.e2e.js`（H1–H6 + S1–S4 + P1），**反向验证**过：把 server.js 里那道闸改成 `if (false)` → H2/H3/H2b 当场红，重建后回绿。
  - `unit/prompt-queue.test.js` 加 ⑦⑧⑨（不限时归一、2 分钟自动收起、弹窗内活动重新计时）；夹具的「不渲染视角」从 `'steward'` 换成 `'no-dock'`（管家视角现在要露小窗），断言一条没动。
  - `unit/permission-wait.test.js` [W1]：**改了两条断言**（缺省 120 s → 不限时），是用户拍板改语义，不是放宽；同处补了 0 = 不限时、+10 s 不越界两条。
  - `autonomy-pause.e2e.js`：源抽取注入表补 `promptWaitMs`（抽源里的真函数，不是桩）。修前 ReferenceError。
  - `read-frontend-css.js` `LEGACY_STYLES_SHA256` 重钉（前值 abe014de…，把 prompt-dock.css 换回 HEAD 重算 = 前值，自证过）。
- 隔离预览实例（fake provider，端口 9750）目视/探针验过：盾牌菜单就地确认并切成功；权限弹窗只显示「已等」不显示倒计时；「稍后处理」后管家视角小窗出现且在抽屉底栏之上；点小窗行在管家视角能打开弹窗；**放着不动约 2 分钟自动收起，请求仍挂着没被拒**。
- **全量回归 `run-all --parallel 4` 提交时跑到 355/391，未跑完**。其间唯一红是 `autonomy-pause.e2e.js`（上面已修，单跑 ALL PASS）。**注意**：跑到一半时改过 `prompt-queue.js`（抽屉避让那一处），与小窗相关的浏览器件（`ui-polish.browser.e2e.js`、`interactive-question.e2e.js`、`walkthrough-round1.browser.e2e.js`、`steward-settings.e2e.js`、`steward-conversation.e2e.js`）**换机器后要重跑一遍全量**再算数。

## 3. 未做：新版本首启自动接管老版本（用户 2026-09-24 提出，待拍板后再动手）

用户原话：新版本首次启动时自动检测本机老版本，把 MCP / skill / 设置等个性化内容都同步进新包，无痛切换，且可删老包。

### 3.1 取证结论（本机只读核过）

- **所有发布包共用同一个数据根** `~/.win-claude-workbench`（`00-boot.js dataRoot()`；只有 `tools/dev-serve.cmd` 用包内 `.wcwtest`）。配置、会话、skills、记忆、定时任务、playbooks 都在这里 —— 新包一启动就已经是同一份，**这部分无需复制**。
- 真正的风险是**别处存着指向某个老包目录的绝对路径**，删老包后静默失效。本机实例：
  - `~/.claude.json` `mcpServers.ai-computer-control` → `…\ruyi-workbench\dist\Ruyi-v1.6.7-full\mcp\ai-computer-control\python_embed\python.exe`（老包；新版同步写的是 `win-claude-workbench` 那一条，不碰旧名条目）。
  - `~/.claude.json` `mcpServers.win-claude-workbench` → 当前在跑的那份 `app\server.js`（每次启动 `syncMcpServersToClaude` 会改写成当前包，这条自愈）。
  - 如意配置 `externalMcpServers[acc].env.PYTHONPATH` → 源码树 `mcp\ai-computer-control\src`。
  - 磁盘上老包很多：`ruyi-workbench/dist/` 下 v1.6.0–v2.5.2、`~/Downloads/Ruyi-v2.0.1-full` 等。
- 其他可能落包路径的地方（未逐一核）：ruyi-toolbox 组件登记、asr-shim 登记、定时任务里的命令、桌面/开始菜单快捷方式、Kimi CLI 的 MCP 同步（`kimi-mcp-sync.json`）、`generated/workbench.mcp*.json`。

### 3.2 建议方案（草案）

1. 启动时在数据根记一条 `install-registry`：`{ packageRoot, version, lastLaunchedAt }`（每个启动过的包一行）。
2. 首启（本包路径不在登记里）时扫描：登记里的其他包 + 上面各处配置里的绝对路径，找出「指向另一个如意包目录、而本包里有同名对应文件」的条目。
3. 给用户一张一次性卡片：「检测到老版本 vX（路径）。以下 N 项还指着它：…」→「全部改到新版」（先备份原文件，逐项改写，结果可撤销）。
4. 改完后提供「删除老包」：**移到回收站**，不做永久删除；删前再扫一遍确认没有任何引用。
5. 老包里若有用户手放的东西（包内 `config/` 被改过、包内 toolbox 组件等），列出来让用户选「搬过来 / 不要」。

### 3.3 待用户拍板

- 自动改写外部配置（`~/.claude.json`、Kimi）是否需要逐项确认，还是一键全改？
- 「删除老包」是否只做回收站？多个老包是否一次列全？
- 旧名 MCP 条目（如 `ai-computer-control`）是改路径还是直接删掉让新名条目接管？

## 4. 其他尾巴

- ② 里 Claude 引擎节点 200K 兜底要不要改成与主会话一致的 1M（用户未表态）。
- Claude CLI 自己的 MCP 工具调用时限是否允许挂数天（不限时权限走 CLI 桥时）——没法在本仓内核实，真机长挂一次看。
- 本批没有做 CHANGELOG 条目。
