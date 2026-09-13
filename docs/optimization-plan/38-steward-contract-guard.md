# 38 · 管家输出契约兜底与回放按钮（123-P1；用户 2026-09-14 真机 bug）

> **性质**：用户真机 bug 的响应，不是排期里的波次。范围小、证据链完整，独立编号是因为源码里十处注释指向它。做完接 35 号文 §2 的 124 波。
>
> **纪律**：沿 32 号文 §4 纪律 1–16 全部。

## 1. 用户报的现象

用户对管家说「下周一整周大A该怎么操作」。管家回：「我把你这句话原样递给『下周A股走势分析』那条线程了」「按钮就在这条消息下面，点『打开线程』」。**界面上没有任何按钮，线程也从没收到那句话。** 用户连问两轮，管家两轮都说「已经再递一次了、按钮我也重新挂了一次」。

## 2. 取证（主会话，用户真机数据根 `C:/Users/87179/.win-claude-workbench/`）

| 证据 | 实得 |
|---|---|
| `sessions/steward.messages.ndjson` 最近 7 条 assistant | 全部 `acts=0 actions=0 parsed=true` |
| `sessions/steward.provider.ndjson` 模型原始输出 | **只有 `say` 一个键**，七轮无一例外，从没有 `why`／`acts`／`actions` |
| `config.json` | `stewardProviderId=deepseek`、`stewardModel=deepseek-v4-flash`（快档） |

**定性**：模型不遵守四字段输出契约，又在 `say` 里把动作描述成已完成——违反 stable 纪律 6「不编造进度、不把没做的事说成做了」。工具一次都没调，按钮从来就没生成过。**而系统这一侧零兜底**：没有任何一处校验契约是否完整，也没有任何一处核对「它说做了」与「它真做了」。

**排查手法值得复用**：真机 `provider.ndjson` 存着模型原始输出，一眼能分清「模型没写」还是「系统丢了」。

## 3. 三件修法（P1 刀，Opus 主树，`21d2e88`／`e488822`／`5617add`）

### 3.1 契约完整性兜底（服务端）

判据用**契约完整性这个硬事实**，不去猜 `say` 的文本：`parsed === true` 且缺 `why`（契约必填的「依据一句话」）即判 `contractIncomplete`。**不许**拿 `acts`／`actions` 为空当判据——纯答问回合本来就不需要它们。命中三件事：审计一条 `steward_contract_incomplete`（带 trigger、模型给了哪些键、sayChars）；落盘章带 `contractIncomplete: true`（缺省不写，老回合读不到即 false）；前端在那条回复下挂一条灰字系统回执，明说这一轮没有执行任何动作。

**为什么不做关键词匹配**：「已经递了／按钮在下面」这类完成时陈述要维护中英词表，脆且永远漏。契约完整性是机器可判的。

**为什么不改提示词**：`06b` 的 stable 已 2453/2500、rules 已 2444/2480，两边都没余量；靠系统兜底，不靠再加一句话。

**同回合纠正重试：没做**（P1 评估后放弃，理由采纳）。同回合重跑必然动到四处回合语义：第二发 `runSessionTurn` 会往管家会话真写一条纠正提示的 user 消息与第二条 assistant 消息，回放时当用户气泡上屏；`stewardRunnerRuntime.turns` 与用量台账要么漏记一次模型调用要么多记；抢占窗口拉长一倍，`controller` 的 abort 落点要重新定义；`stewardLastAssistantCreatedAt`／`turnSeq` 会指向第二发。要做得先给重试一条**不写会话正文**的旁路通道，那是 `09-workflow` 的地界。登记后续。

### 3.2 回放只画导航类按钮（前端）

**派单稿的现象写反了，执行者证伪**（纪律 1）：`steward-conversation.js` 自 117c `76d7999` 起就有 `if (stamp) renderActs(row, stamp.acts)`，`git log -L` 佐证。主会话读码时截断了行范围看漏了。真相不是「回放从不画 acts、按钮消失」，而是**整份重画**：点过的 `dismiss`／`tool` 刷新后复活。修法方向不变——回放只画 `isNavigationAct`（`kind === 'open_thread'`），依据是 117v-V1 ② 的既有裁决「导航不是表态」：表态点过之后已经落了灰字回执，而落盘 stamp 里没有「这枚点过没有」的记录。

### 3.3 向导第四步提示

`onboarding-wizard.js` 的 steward 步补一句：管家要调工具、还要按固定格式回话，快档小模型常常守不住，只回一句话、动作一个都不做，看着像办了其实没办；拿不准就选强的那一档。新键 `onboarding.wizard.steward.contractHint` 中英各一，四份 locale 逐字节同步。`onboarding.static` 加 D11b-bis 钉住两条 hint。

## 4. 主会话收尾补的一刀（`373f8b9`）

P1 登记项①，**123-N1 ① 的主路径从未生效**：N1 给 13q 的回执加了 `createdAt`（前端 `finishReply` 拿它推 `lastRenderedAt` 水位），但 `steward_reply` 那一帧是**白名单**，13h 没带这个键，前端读到恒空，一直靠 `alignWatermark()` 兜底活着，每回合多发一次 `?since=`。N1 的 AB 段测得绿是因为它 stub 了 fetch、直接喂带 `createdAt` 的回执，够不着这一帧。修法：白名单补上，缺省不写。**钉点**：`steward-runner.static` 新增七条「13q 塞进 reply 的每个可选键，白名单里都有」（say／why／acts／actions／parsed／contractIncomplete／createdAt）——钉的是这条不变量本身，将来再加字段照样挡得住。反向拿掉那一行 → `createdAt` 那条红。

**顺带记一次自己踩的坑**：拔探针时用了 `git checkout -- <file>`，把同一文件里未提交的正式改动一起还原了。这正是记忆里早记过的那条（32 号文纪律与 `ops-new-machine-wave121` 都有），本次复犯。探针只能用带标记的行加删。

## 5. 判据与反向

- 新件 `steward-contract-guard.e2e.js`（16 条）：fake provider 只回 `{"say":"我已经把你的话递给「某某」了，按钮就在下面"}`（照真机那一份的形状）→ 帧与落盘章都带 `contractIncomplete=true`、acts/actions 都 0、审计恰一条、`keys=["say"]`、`sayChars=45`；对照两轮（四字段齐全／`why:''`）都不打旗。
- `steward-conversation.e2e.js` AC 段（7 条）：回放只剩导航那一枚，`dismiss` 不重画；契约完整那行零回执；回执文本与 `data-receipt="contract"`。
- 五处反向全部真做：判据恒 false → 8 红；回放改回全量 `renderActs` → 3 红（`实测 ["打开线程","知道了"]`）；删回放 `renderActs` → 2 红；删回执 → 2 红；删向导 hint → 1 红。主会话另做第六处：白名单去掉 `createdAt` → 静态锁 1 红。
- **全量**：P1 交付时 340/4/3（真回归 0；4 红＝realhist ×3 环境＋`walkthrough-round1.browser` 串行绿的新抖动件）；主会话补刀后复跑见 §6。

## 6. 收尾

- **主会话补刀后 8 路全量（`373f8b9`）：344 ran，341 pass／3 fail／2 flaky——真回归 0。** 3 红全是 realhist（`observation-recall-realhistory`／`-replay`／`session-notes`，本机无夹具目录，ENOENT，用户另机测）；2 件 flaky（`workspace-resolve`／`walkthrough-round1.browser`）重跑即绿。比 P1 交付那轮更干净：那时 `walkthrough-round1.browser` 是红的，这轮退回抖动。
- `--fast` 71/71；`build --check`／依赖图 `--check`（53 模块／418 边／1 SCC）绿；改动文件控制字符零命中；`steward-conversation`／`steward-contract-guard` 串行各绿。
- facts `e2eCount 350→351`（默认 344）、`RUYI_HOME_SPAWN_SITES 139→140`；`LEGACY_STYLES_SHA256` 不动（零 CSS 改动）。
- **用户侧还要做一件**：把管家模型从 `deepseek-v4-flash` 换成强档。系统兜底只保证「不再骗你」，让它真去调工具还得靠模型有那个能力。

## 7. 登记

1. 同回合纠正重试（§3.1），前置是给重试一条不写会话正文的通道。
2. `walkthrough-round1.browser` 新抖动件：8 路 exclusive 阶段 F2–F8 全红（模型菜单里第二个模型还没就绪就点了），串行绿。进抖动治理批。
3. `stewardLastAssistantContent`（13p）与 `stewardLastAssistantCreatedAt`（13q）每回合各读一次同一份会话，可合并成一次读（123-N1 自己登记过的小债，仍在）。
4. 判据目前只看 `why` 在不在。若将来发现模型给了 `why` 却仍在 say 里编造进度，下一档不该是关键词表，而是让模型把「我做了什么」结构化到 actions 里再判。
5. 37 号文 §6 那四条（`detectDesktopMcp` async 化、M2 九条登记里够得着的、127 波的 playbook／workflow 载荷与开机自启、124 波）仍在队列里。
