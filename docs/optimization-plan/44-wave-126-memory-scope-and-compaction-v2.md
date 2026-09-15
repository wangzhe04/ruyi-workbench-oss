# 44 · 第 126 波 · 记忆时效与作用域 ∥ 压缩策略 v2

> **用户触发（2026-09-15）**：「按计划自主推进，一直推进」「继续自主推进下一波」。排期依据 [43 号文 §2](43-merge-114-111-107-into-product-line.md)（111 并入本波 B 道）。
>
> **本文的性质**：派单稿。**不重写 [25 号文 §1](25-waves-111-113-compaction-visibility-memory.md) 的 111 设计** —— 开关名、切片边界、回退口径、A／B／C 三类门全部原样有效；本文只补三样它没有的东西：**落在今天这棵树上的哪一行**、**按什么顺序出门**、**每一刀的反向怎么做**。A 道同理回指 [31 号文 §2.2／§2.6](31-steward-empowerment.md) 与 41 号方案 M01–M03。
>
> **前一波**：[42 号文](42-wave-125-truthfulness-and-recovery.md)（125 波，已收；含 flaky 治理两批）。

## 0. 一句话

两道并行：**A 道让管家记住的东西会过期、分得清管得着谁**；**B 道让压缩切在该切的地方**。两道**文件零重叠**，A 道绝不碰压缩，B 道绝不碰记忆库与管家。

## 1. 取证（2026-09-15 主树实读）

### 1.1 A 道：同一个产品里两套记忆库，一套有时效与作用域，一套没有

| | **工作台库**（`06d-memory-domain.js`） | **管家库**（`13j`／`13l`／`13g`） |
|---|---|---|
| 条目字段 | frontmatter 含 `expiresAt`／`reviewAfter` | `id｜kind｜text｜confidence｜sourceSessionId｜sourceSeq｜createdAt｜updatedAt｜lastUsedAt｜useCount｜state｜mergedFrom`（`13j:293-320`）—— **没有 `expiresAt`，没有 `scope`** |
| 过期判据 | `memoryIsExpired(entry, nowMs)`（`06d:54`）、`memoryReviewDue`（`:58`） | **不存在** |
| 作用域 | global／project 两级目录（`memoryGlobalDir`／`memoryProjectDir`，`06d:30-38`） | **不存在**：写进去就是全局一条 |
| 读取口 | `readMemoryDir` → `loadMemoryRegistry`（`06d:135/194`） | `stewardReadMemoryStore`（`13j:321`）→ **零过滤**；搜索口 `stewardImplMemorySearch`（`13l:448`）只过滤 `vetoed` 与 `kind` |
| 注入口 | 相关记忆索引段 | `stewardMemoryBlock`（`13o:33`）→ `memorySearch({limit:50})`，按 kind 分组贴进易变层 |

**结论一句话**：**今天管家记住的每一条都永远有效、到处有效。**「这两周在赶 A 项目」这种必然过期的事实，会一直贴在每一回合的提示词里；而工作台库早就有过期与作用域两套机制 —— 两库职责没划分，是历史，不是设计。

### 1.2 「要不要加字段」的裁决

124 波留下的纪律（35 号文 §2 退出门）：**不新增持久字段，除非报告证明现有数据答不了那个用户问题**。逐条过：

- **`expiresAt` —— 必须加。** 现有字段一条都答不了「这条什么时候不该再用」：`createdAt` 只说它什么时候被写下，`lastUsedAt` 只说它什么时候被用过，`confidence` 是写入时的自评。三者都推不出「它还成不成立」。
- **`scope` —— 必须加，但理由不同。** 它**技术上推得出来**（`sourceSessionId` → 会话头 `cwd` → `projectKeyForCwd()`），但推出来的是**它在哪儿被说的**，不是**它管得着谁**：用户在 A 项目里说「我要结论先行」，那是全局偏好，不是 A 项目的偏好。31 号文 §2.6 的红线写得很清楚 —— 判据是**用户自己说的**稳定事实，**不是模型推断**；拿来源目录冒充作用域，正是那条红线禁止的推断。
- **不加的**：`reviewAfter`（工作台库那一套复核节律是为长文正文设计的，管家条目只有 300 字，先不搬）；任何「自动续期」字段（续期是行为不是状态，要续就重写 `expiresAt`）。

### 1.3 B 道：111 五个切片今天在树上的确切位置

**grep 实测：五个开关全仓零实现**（`runtimeEvaporateBudgetBoundaryV1`／`runtimeHistoryReadDedupV1`／`runtimeReseedTailUnitsV1`／`runtimeReseedReattachFilesV1`／`runtimeSummaryPromptI18nV1` 零命中）。111 是整波未开工，不是做了一半。

| 切片 | 今天是怎样的 | 落点 |
|---|---|---|
| **111a** L1 边界改 token 预算 | `evaporateHistory` 从尾部数 assistant，**数到第 2 条就是边界**（`10:599-603`），完全不看 token。四个调用点：`10:2007`（主回合，`budget` 在作用域里）、`10:1884`（子代理，同上）、`09:2225`（forced-400，**无预算**）、`08:781`（子代理 forced-400，**无预算**） | `10-context-governance.js` ＋ `context-governance-rules.json`（新增 `l1ProtectMinTokens`／`l1ProtectMaxTokens`，`schema` 1→2） |
| **111e** 历史内重复读取去重 | `execCacheLookup`（`12:490`）命中缓存后**仍把全文展开写进历史**；同一文件读三次，历史里就躺三份全文 | 只在 L1 遍历内做（不额外改写历史、不破 append-only） |
| **111b** L2 尾部单元边界＋桥接 | `recentTurnsBoundary`（`10:1794`）只在 `userBlockStarts` 上切；**最新一整回合放不下就 `kept=[]`**（`10:1838` 的 `boundary <= 0 ? [] : slice`；没有一个 user 起点装得下时 `boundary` 停在 `history.length`，切出来就是空） | `recentTurnsBoundary` ＋ `CompactionPlan.create/reseed`（`10:1810-1860`） |
| **111d** 摘要 prompt 双语与标题容错 | `rules.summary.prompt` **中文硬编码**；而别名表 `summary.sections` **早就接受英文标题**（`## Goal`／`Decisions:`／`## Files` …）、`stateLabels` 也双语 —— **读的那一头双语了，写的那一头没有** | `context-governance-rules.json` 新增 `summary.promptEn`；`validateStructuredSummary`（`10:870`）前做标题归一 |
| **111c** 重播种后重附最近读过的文件 | 全仓无 reattach 机制 | L2 出口构造有界 `<recent-files>` 块，内容取自 105a 快照，**不做新的磁盘读取** |

### 1.4 一个现成的洞（111d 的动机不是「顺手」）

`config.locale` 支持 `auto｜zh-CN｜en-US`（`01:36`／`01:617`）。今天把界面切到 `en-US`，**摘要 prompt 仍然是中文的** —— 英文界面的用户拿到的压缩摘要是中文。这不是「双语没做全」，是**一条现成的产品缺陷**，而且修它的读那一半早就写好了。

## 2. 切片与出门序

**出门序（按 43 号文 §4 决策 1 的推荐「全做但分档」）**：

| 序 | 刀 | 道 | 为什么排这儿 |
|---|---|---|---|
| ① | **B-111a** L1 边界改 token 预算 | B | 五刀里唯一动「哪些观测被蒸发」的核心判据，先立住 |
| ② | **B-111e** 历史内重复读取去重 | B | 与 111a 同在 L1 那一趟遍历里，紧跟着做，只走一遍代码 |
| ③ | **A-M02** `expiresAt` ＋ 读取过滤 ＋ 判据单一锁 | A | A 道的地基：先有「什么叫过期」这一个判据口，M01 才有地方挂 |
| ④ | **A-M01** `scope` ＋ 读取过滤 | A | 与 ③ 同一个规范化口、同一个读取口，连着做 |
| ⑤ | **B-111d** 摘要 prompt 双语与标题容错 | B | 独立、最小、补一个现成的洞 |
| ⑥ | **B-111b** L2 尾部单元边界＋桥接 | B | 要动 `CompactionPlan` 的形状，配对铁律在这儿最容易出事，放在 L1 两刀之后 |
| ⑦ | **B-111c** 重播种后重附文件 | B | 最容易与 105a 快照的既有行为打架，放最后（43 号文 §4 已写明） |
| ⑧ | **A-M03** 代答试点 | A | **前置未过不开工**：31 号文「眼睛」准入门（污染回合在 handler 权威判断里降级）先做完并出门，才谈代答 |

**五个开关一律默认关、显式 `false` 完整回退**（25 号文 §1.2 原话）。A 道两个新字段**不带开关**：老条目读成空值即「不过期、全局」，与今天逐字节同义 —— **存量零迁移**，这是 `mergedFrom` 当年用过的同一个模具（`13j:314-320`）。

## 3. 独占文件与「绝不碰」

| | A 道吃 | B 道吃 |
|---|---|---|
| **独占** | `06i-steward-core.js`（判据常量与纯函数）、`13j-steward-tool-base.js`（规范化与读写）、`13l-steward-ops.js`（写入／搜索）、`13g-steward.js`（面板路由）、管家记忆面前端与 locale | `10-context-governance.js`、`context-governance-rules.json`、`01-config.js`、`01c-runtime-flags.js`、`09-workflow.js`／`08-agent-runs.js` 的 evaporate 调用点 |
| **绝不碰** | 压缩、`CompactionPlan`、rules.json | 记忆库、管家族任何文件、提示词注册表 |

两道唯一的理论交集是 `01-config.js`（B 道要加五个开关）。**判给 B 道**：A 道两个字段不走 config。

## 4. 可证伪判据与反向（每一刀至少一条真反向）

- **111a**：① 单 user 回合 60 次工具调用夹具 —— 开关开时 L1 释放 ≥50% 观测 token 且不触发 L2；② 边界只落在 user 起点或「assistant(tool_calls)＋其全部 tool 回复」单元起点（配对铁律：`tool_call_id` 零孤儿）；③ **开关关时对同一夹具逐字节等价今天**（快照断言）。
  **反向**：把边界函数改回 `assistantsSeen===2` → ① 红且读数说得出差多少。
- **111e**：三次读同一文件的夹具 —— 开关开时只有最新一次保留全文，较早两次替换为带 `rawRef` 的指针；**反向**：去掉「同资源版本」这一半判据（只比 path）→ 夹具里故意放一次「改过之后再读」，红。
- **A-M02／M01**：过期条目不进提示词块、不进搜索结果、**但仍在面板里可见并标注**（时效是过滤，不是删除）；作用域不匹配的条目不进提示词块。**反向**：把过滤从读取口摘掉 → 夹具里那条 `expiresAt` 在昨天的条目重新出现在提示词块里，红。
  **外加一把机械锁**（125 波三次教训的延续）：**「什么叫过期」只有一个判据口** —— `06i` 里那个纯函数；静态锁扫 `13j`／`13l`／`13g` 不许自己 `Date.parse(expiresAt)`。
- **111d**：`locale=en-US` 的夹具 —— 摘要 prompt 为英文且 `validateStructuredSummary` 通过；`locale=zh-CN` 逐字节等价今天。**反向**：把标题归一摘掉 → 英文模型返回 `## Goal:`（带冒号）时校验红。
- **111b**：最新一整回合放不下时，尾部保留 ≥1 个完整「assistant(tool_calls)＋tool 回复」单元且配对零孤儿；保留段首条为 assistant 时插入桥接 user 消息。**反向**：摘掉桥接 → 保留段 assistant 打头，`repairProviderHistoryPairing` 断言红。
- **111c**：reseed 后 `<recent-files>` 块存在、按 path 去重、不超预算、**不做新的磁盘读取**。**反向**：允许它回落到真读盘 → 静态锁红。

**五刀统一的默认翻开规则**沿用 25 号文 §1.3：A 类全绿 ＋ B 类非劣且至少一项主指标改善。**没达标就保持默认关，并在 107 的 Release Brief 里标实验** —— 22 号文 §8 自己写着「全部默认关闭不能冒充已经交付的用户收益」。

## 5. 每一刀出门的固定动作

沿 35 号文 §2 末段与 32 号文 §4：`build --check` ／ 依赖图 `--check` ／ `--fast` ／ 控制字符扫描；**`src/` 有改动就整条生成器链重跑**（`module-dependency-graph.js --write` → `build.js` → 文件数变了才 `facts-generate.js` → `route-inventory.js`）；**B 道改 `context-governance-rules.json` 还要多跑一条** —— `architecture-contract-snapshots.js`（它把 rules 的哈希钉进 `docs/architecture/`，`dev-harness/architecture-contract-snapshots.js:9`）。一机一回归（纪律 14）、新 e2e 首行 `self-isolate-home`（纪律 15）、补丁不走 heredoc（纪律 7）。

## 6. 三件要拍板的（**推荐已写在括号里，不回也按推荐走**）

1. **`scope` 的取值形状** —— 推荐 **`'' | 'project:<key>'` 两态**（空＝全局），`<key>` 复用 `projectKeyForCwd()` 那一套，与工作台库同一口径。备选是照搬工作台库的 `global`／`project` 两级目录，但管家库是**单文件 JSON store**（`13j:290`），拆目录等于换存储形状，代价远大于收益。
2. **过期条目怎么处置** —— 推荐 **只过滤、不删**：读取口过滤，面板照常列出并标「已过期」，用户可续期或删除。理由是 116 波那条纪律——「否决条目不换说法复活」靠的就是**留着**那条 `vetoed` 记录；过期若直接删，同一条会被原样重写一遍。
3. **111 五刀哪几刀允许先默认关就出门** —— 推荐 **全部先默认关出门**，B 类真模型读数留到 107 前统一跑一轮（那时 111 全部落地，一次评测能把五个开关的可释放 token／质量对照一起量出来，比逐刀各跑一次省钱也更可比）。代价是 126 波交付时**五刀对用户零可见变化** —— 这一点 43 号文 §2 已经写明并接受。

## 7. 交付记录

### ① B-111a · L1 蒸发边界改 token 预算（2026-09-15）

**改了什么**（`runtimeEvaporateBudgetBoundaryV1`，默认关）：

- 判据口一处：`01c-runtime-flags.js` 的 `evaporateBudgetBoundaryEnabled(config)`。
- 两个新原语落 `10-context-governance.js`：`historyUnitStarts()`（单元起点＝`role !== 'tool'` 的那些下标；tool 消息按配对铁律永远紧跟发起它的 assistant，所以「不是 tool 的那一条」就是单元头，这样切出来的边界**永远不会把 assistant 与它的 tool 回复劈开**）与 `evaporateBudgetBoundary()`。
- 保护区三个数全部落 `context-governance-rules.json` 的 `compactionPlan`：`l1ProtectRatio: 0.25`、`l1ProtectMinTokens: 4000`、`l1ProtectMaxTokens: 32000`（**值域唯一**，代码里不写死）。
- 调用点两处：主回合自动压缩（`maybeAutoCompact`）与子代理自动压缩（`maybeCompactSubHistory`）。

**三处与 25 号文 §1.2 派单稿不同的地方，逐条给理由**（改派单稿要说出为什么）：

1. **没有 bump `rules.schema`。** 派单稿写「版本号 +1」，但这份文件自己的先例（105e `estimation`／105g `factTable`／105h `refine`）全是 additive 不 bump；`schema !== 1` 那道闸拦的是**结构不兼容**，新增可选键不是。
2. **开关不在 `evaporateHistory` 里读，在调用点读。** 第一版写在函数体里，`runtime-optimization.static` 当场炸 —— 那件会把这段源码**原样切出来 `new Function` 跑**，函数体里一旦出现跨模块符号就是 `ReferenceError`。改成调用点传**已经过门的** `boundaryBudget`，函数体保持无开关、可切片。**并补一把机械锁**（F1）：src 里每一处 `boundaryBudget:` 赋值都必须与 `evaporateBudgetBoundaryEnabled(` 同行，否则有人写个裸预算就把开关架空了。
3. **forced-400 两条路（`09-workflow`／`08-agent-runs`）保持老边界。** 那里没有现成的 `budget`，而派单稿的 111a 只要求主回合与子代理两条自动压缩路径，forced-400 属 111b 的范围。这是**有意留的边界，不是漏**。
4. **没有扩 `measureObservationReductionShadow`（C 类影子）。** 派单稿要它「同时输出两种边界的可释放 token」，但那条影子路的门是 `runtimeOptimizationShadowV1===true && runtimeObservationReducerV1!==true`，而 reducer **默认是 true** —— 这条路在生产里等于不跑，扩了也量不到东西。两种边界的对照改由 A 类夹具直接给（见下面 B2 读数）。

**判据读数**（新件 `dev-harness/unit/evaporate-budget-boundary.test.js`，28 条）：

| 组 | 读数 |
|---|---|
| A 开关关 | 缺省／显式 `false`／字符串 `"true"` 一律不生效；**开关关的结果与今天不带 opts 的调法逐字节相同**；老边界确实只护住最后一条观测（蒸发 5/6） |
| B 开关开 | 夹具按生产真实前置搭（历史 34511 tokens > 预算 24157）。单 user 回合连 60 次工具调用：**老边界蒸发 59/60（只护住 1 条观测），新边界蒸发 50/60（护住 10 条）**。预算单调性：2000／20000／120000 三档实得蒸发 25 ≥ 23 ≥ 0 |
| C 铁律 | 单元起点上没有一条是 tool；五档预算下边界全部落在非 tool 上；蒸发后 `tool_call` 配对零孤儿；不删消息不改长度；第二遍零蒸发（幂等） |

**反向三处，每一处都点名了被动过的那一处**：① 拔掉「最近一次观测无条件护住」→ C3c 红；② 单元起点把 tool 也算进去 → C1／C1b 红；③ 子代理那处不经开关把门直接给裸预算 → 静态锁 F1 红并把那一行原样打出来。三处还原后 sha256 逐字节相同。

**一次真正的反向收获（写下来，因为它证伪的是我自己）**：第一版反向「拔掉最后一个单元的保护」**没红** —— 夹具里每个单元只有 ~2000 token，而保护区被 `l1ProtectMinTokens=4000` 托底，那条保护**从来没被触发过**。改成「单个工具结果就 13503 tokens」的夹具后，新加的 C3c 在**实现没动**的情况下**直接红了**：我护住的是「最后一个**单元**」，而当最后一个单元是一条纯文本 assistant（回合刚收尾）时，它前面那条刚拿到的 tool 结果照样落进蒸发区 —— **注释里声称的不变量，代码当时并没有兑现**。于是补了第二条无条件保护（最近一次观测），并把这段经过写进函数头注。这正是 [42 号文 §5-quinquies](42-wave-125-truthfulness-and-recovery.md) 那条纪律的又一次兑现：**反向如果没被实现拦住，屏上会有什么不同？**

**两处沙箱要注真函数**（不是另写假的 —— 判据只有一处这条纪律在沙箱里也得成立）：`unit/compact-marker-merge.test.js` 与 `context-governance.e2e.js` 都用 `new Function`／`vm` 切源码实跑，缺了 `evaporateBudgetBoundaryEnabled` 会 `ReferenceError` 被被测函数自己的 `try/catch` 吞成「没压缩」，表现为「该触发却没触发」（实测分别红了 2 条与 10 条）。两处都注入 `require(SERVER)` 导出的**那一个**函数。

**生成器链与门**：`module-dependency-graph --write`（53 模块／419 边／1 SCC，与改前同）→ `build.js`（53805 行）→ `facts-generate.js` → `route-inventory.js`（135 判定点，告警 0）→ **`architecture-contract-snapshots.js --write`**（rules 改了就必须重跑这一条）→ `--fast` 72/72 → 压缩族六件串行 6/6。计数锁重钉一处：unit suite 47→48（英文 README 那处原本写着 46，一并对齐）。控制字符扫描干净（server.js 里那 5 个 U+FEFF 在 HEAD 里也是 5 个，是给 PowerShell 临时脚本**故意**加的 BOM）。

**全量回归（①）**：第一轮 348 pass / 1 fail / 3 flaky —— 唯一的红是 `dom-smoke`，红在 `B1 dump-dom 完成 (0B, status=4294967295)`，是 **Edge 启动退 -1**，与我这一刀（引擎侧、默认关）无关；两件单跑各两次全绿。就地把那一族治了（42 号文 §5-decies：一次性启动浏览器的两件补进独占桶＋加锁），收口重跑：**349 pass / 0 fail / 349 ran，真回归 0**，唯一 flaky 是 `steward-board`（没留下断言红，属已登记 300 s 豁免的超时族）。

### ② B-111e · 历史内重复读取去重（2026-09-15）

**问题是真的**：`execCacheLookup`（`12:490`）命中缓存之后**仍然把全文展开写进历史** —— 同一个文件在一条线程里读三次，历史里就躺着三份一模一样的正文。

**一处与派单稿不同（这是本刀唯一的设计判断，值得单独说）**：派单稿写「仅在 L1 缩减遍历内执行」。但 L1 那一趟只动 `boundary` **之前**（冷区），而冷区的观测**本来就已经被缩过了** —— 在那儿去重等于把已经缩成占位符的东西再缩一次，零收益。重复读取真正还在占位置的地方是**受保护的尾部**。所以去重作用在 `[boundary, history.length)` 上。这不是绕开派单稿，是把它那句话落到今天这棵树上的正确位置。

**去重键是本刀的核心，它决定了会不会说谎**：键 = `路径` ＋ **文件正文的 sha256**，不是派单稿设想的「路径＋mtime＋size」那种版本推断。

- 正文逐字节相同 → 必然是同一份内容的同一个窗口，换成指针**零信息损失**；
- 读的窗口不同（第 1–100 行 vs 第 100–200 行）→ 正文不同 → 各留各的；
- **文件改过之后再读 → 正文不同 → 两份都留着**，「我的改动生效了吗」这种对照**不会被吃掉**。

也就是说这把键**零误报**。不拿整条 `content` 做哈希是因为：缓存命中那一发会多带 `cacheHit:{cachedAt,ageMs}`，`ageMs` 每次都不一样 —— 拿整条比就永远比不上（判据 D 组专门钉这一点）。

**换掉的是重复，不是信息**：指针里带后文那一条的 `tool_call_id`（模型在历史里看得见它）与 `rawRef`（有快照前缀时），`observation_recall` 这条路一直通着。

**判据读数**（新件 `dev-harness/unit/history-read-dedup.test.js`，31 条）：A 组开关关零改写且与不带 opts 逐字节相同；B 组键零误报八条；C 组最新一次留全文、较早换指针、只认 `file_read`、只在 `from` 之后动、幂等；D 组缓存噪声不搅乱键；E 组走 `evaporateHistory` 端到端，配对零孤儿、长度不变。

**反向三处**：① 键退化成「只比路径」（＝派单稿那类版本推断的近亲）→ **恰好红在 B3／B4 两条「零误报」保证上**；② 改成「留最早那一次」→ C3／C4／C5 红（模型手上就只剩过时的那一份）；③ 子代理那处不经开关把门 → 静态锁 F2 红并把那一行原样打出来。三处还原后 sha256 逐字节相同。

**一次测试自身的错误**（记下来，因为它差点被当成实现的错）：第一版 `fullTexts()` 拿 `BODY.slice(0,40)` 去 `includes` —— 而 `content` 是 `JSON.stringify` 过的，正文里的换行在里面是**两个字符的 `\n`**，所以永远匹配不上，五条断言全红而实现其实是对的（同一轮里 C1「换掉两次」与 C6「幂等」是绿的，这是分辨「谁错了」的抓手）。改成解析回来比正文。

**顺手收紧了一把松锁**（本会话第四次同一族）：`facts.static` 的三条 README 计数锁原本写成 `readmeNums.has(n)` —— 只问「这个数字在 README 里**某处**出现过没有」。README 里到处都是别的数字，于是它几乎永远是绿的：**实测 README 写着「48 组 unit suite」而 facts 已经是 49，那三条照样全过**。收紧成「数字必须贴着它声称在数的那个词，且每一处都要对上」。反向在**同一份 README** 上做了直接对照：把 `plus 49 unit suites` 改成 51 → 新锁红并点名它，而旧判据 `readmeNums.has(49)` 仍然返回 `true`（绿，抓不到）。

**生成器链与门**：整条重跑（`module-dependency-graph --write` 53 模块／419 边／1 SCC → `build.js` → `facts-generate.js` → `route-inventory.js` 告警 0 → `architecture-contract-snapshots --write`）；`--fast` 72/72；压缩族七件串行 7/7。计数锁重钉：unit suite 48→49（三处）。两处沙箱第二次要注真函数（`compact-marker-merge` 与 `context-governance`）—— 与 ① 同一个模具，现在知道了：**往 `maybeAutoCompact`／`maybeCompactSubHistory` 里加任何跨模块调用，都要回来补这两处沙箱**。

**控制字符扫描逮到一处真问题**（记下来，因为它差点混过去）：`10-context-governance.js` 里躺着一个**裸 NUL 字节**（U+0000）—— 去重键那行 `filePath + \u0000-转义 + …`，Edit 把**转义序列写成了真的 NUL 字符**。代码照常跑（NUL 在 JS 字符串里是合法字符），但它会破坏 grep、diff 与编辑器 —— 是记忆里「补丁脚本静默损坏文件」那条老坑的又一次，而且这次是被**出门固定动作里的控制字符扫描**抓住的，不是被测试抓住的。改成两个字符的转义序列；HEAD 里本来就有 2 处同样写法（这文件自己的「键拼接」惯用法，见 `:178` 与 `:873`），我这处是第 3 处，与仓内写法一致。`src/` 与 `server.js` 58 个文件复扫零裸 NUL。**这处改完按「一刀一回归」重跑了收口全量。**

**全量回归（②）**：NUL 修正前 **349 pass / 0 fail / 0 flaky / 349 ran** —— 一件 flaky 都没有的干净全量（flaky 三批治理生效）；修正后按「一刀一回归」重跑 **349 pass / 0 fail / 1 flaky**，那一件是 `steward-guardrails.e2e.js`，病历也留下了：`F4 四条最终都拿到过并发位(排队不丢条目)` —— 并发位排队的时序判据，与本刀（引擎侧压缩、默认关）无关。**不治**：这是它的第一份病历，按 42 号文 §5-decies 的规矩，下次再红有两份病历可对时再定机制。

### ③ A-M02 · 管家记忆的时效（`expiresAt`）（2026-09-15 深夜～09-16）

**问题**：今天管家记住的每一条都**永远有效**。「这两周在赶 A 项目」这种必然过期的事实，会一直贴在每一回合的提示词里。

**这一刀比派单稿小，因为取证推翻了它的一个前提。** 44 号文 §4 原本写「外加一把机械锁：**「什么叫过期」只有一个判据口** —— `06i` 里那个纯函数」。开工时实读发现：**工作台库（`06d`）早就有 `memoryIsExpired(entry, nowMs)` 与 `cleanMemoryDate(value)`，而且它们只读 `.expiresAt`、与条目形状无关**；`06d` 排在 `06i`／`13j`／`13l`／`13g` 之前，是后向边。于是**一个新判据都没造** —— 直接复用。这本身就是本波要的「两库职责划分」：**两套存储，一套「什么叫过期」的判据**。锁也随之换了形状：不是「06i 里那一个」，而是「**管家族不许自己解析 `expiresAt`**」。

**改了什么**（新字段一个：`expiresAt`，不带开关）：

| 面 | 改动 |
|---|---|
| 规范化（`13j`） | `stewardNormalizeMemoryEntry` 补 `expiresAt: cleanMemoryDate(raw.expiresAt)`。**老条目没有这个字段 → 读成空串 → 永不过期**，与今天逐字节同义（存量零迁移，与 `mergedFrom` 当年同一个模具） |
| 写入（`13l`） | `steward_memory_write` 接受可选 `expiresAt`，清洗同上 |
| 读取（`13l`） | `stewardImplMemorySearch` 过滤掉过期条目（`includeExpired: true` 可显式要）。**提示词块（`13o`）走的就是这一口**，所以「过期就不再被用上」在这一处就够了，不必散到调用方 |
| 面板（`13g` ＋ 前端 ＋ 四份 locale ＋ CSS） | 面板**照常列出**过期条目，只带一枚中性色「已过期」标，悬停说出到期时刻。**时效是过滤，不是删除**（§6 ② 的拍板：与 116 波「否决条目不换说法复活」同一条理由 —— 删掉的话同一条会被原样重写一遍） |
| 工具 schema（`13f`） | 描述里写明**只给必然会过期的事实**写到期日，稳定偏好不要写，不确定就留空 |

**合并时那个陷阱（本刀最容易写错的一处）**：同义写入会合并进旧条目。如果旧的**已经过期**而这次没给新到期日，继承旧到期日的结果是——**合并成功了，却仍然不进提示词块，写了等于没写**。所以：给了新到期日就用新的；没给而旧的已过期，就**把到期日清掉**（用户又说了一遍，这条事实就是当下有效的）。

**判据读数**：`steward-memory.e2e.js` 新增 (G) 组 15 条（放在 (C) 之后、(F) 之前 —— 那时库刚被 clear 清空，本段自成一体，而 (F) 只判六条路由的状态码，不会被扰动）；`rail-pocket.browser.e2e.js` 新增 (K) 组 5 条**真浏览器**（纪律 13：前端 JS 改了就要有真浏览器件，量的是「用户到底看不看得见它过期了」）；`steward-tools.static` 新增 ⑫ 组 3 条机械锁。

**反向四处**：① 摘掉读取口的过滤 → G3 红（过期条目重新出现在检索结果里）；② 合并时不清掉过去的到期日 → G7b／G7c 红（「写了等于没写」）；③ 在管家族里自己 `Date.parse(expiresAt)` → 静态锁 ⑫ 红并把那一行原样打出来；④ 服务端不再算 `expired` → 真浏览器 K3／K5 红，而 **K2「两条都还在面板上」照旧绿** —— 说明「删没删」与「标不标」是分开判的。四处还原后 sha256 逐字节相同。

**一次自己造成的证据污染**（记下来）：前端那一半是在**全量回归已经跑到一半**时动的手 —— 那一轮的读数因此作废、当场停掉重跑。「回归跑到一半改源码会污染证据」这条纪律，这次是我自己撞的。

**两把锁按设计拦住了我**：① `steward-memory.e2e.js` 的 export 字段集锁 —— 加了字段必须回来登记（`C7e` 红并点名 `expiresAt`）；② `frontend-domains.static` 的 CSS 字节等价锁 —— 新增一条 `.steward-memory-expired` 规则就要按仓内惯例记明理由并重钉哈希（注释里那串 ①–⑤ 之后补了 ⑥）。

**一次夹具自身的错**：(G8) 第一版用「只差末字」的两句话验合并，而双字组 Jaccard 实得 **0.778 < 0.8 阈值**，本来就不该合并 —— **是夹具错了，不是实现错了**（实测两句的 terms 分别是 `…|项目|目呢` 与 `…|项目|目啊`，九个双字组差了两个）。

**生成器链与门**：整条重跑（依赖图 419→**420** 边 —— 新增的是管家族 → `06d` 的**后向**边，SCC 仍是 1）；`--fast` 72/72；管家族五件串行 5/5；四份 locale 两两逐字节相同。

**一件红的追查（值得写下来，因为我差点从 1 个样本得出错结论）**：收口全量唯一的红是 `walkthrough-round1.browser.e2e.js`（`C2 管家视角：点行里那块空白 → 焦点真的换了`）。第一反应是「与本刀无关」，但要拿证据说话：

- 把改动 `git stash` 掉、在 HEAD 上跑同一条命令 —— **1 pass**。到这里看起来像是我干的。
- **但 1 个样本不是证据**。补齐分布：我的树 3 跑 = FAIL／flaky／FAIL；**HEAD 3 跑 = FAIL／FAIL／FAIL**。HEAD 比我的树还差 —— **本刀不背这口锅**，第一次 HEAD 跑绿是运气。
- 两次失败红在**完全不同的断言组**（一次 C2 命中测试，一次 F 组八条「切模型」），这是时序的签名，不是确定性破坏的签名。
- 机器状态排查过：残留 msedge 7 个**全是用户自己的后台进程**，空闲内存 12 GB，node 残留全是上午留下的老进程 —— 不是资源耗尽，也不是我中途 kill 掉那轮回归留下的孤儿。

**留下的疑问（记着，不猜着追）**：这件**单跑红、整轮全量里反而绿** —— 与常见的「单跑绿、并行红」正好相反。今天三轮全量它都过了，而此刻连着单跑 HEAD 三发全红。机制未知，属第四批 flaky 的范围。

这一段本身也是「形状阶梯」那条纪律的两面（121-K1 的老账：串行跑 4 次全绿就撤种子，随后并行全量真红）：**「跑 N 次没复现」不算证据；反过来，「跑一次绿了」也不算健康。**

**收口全量**：**348 pass / 1 fail / 3 flaky / 349 ran**。红的那一件与三件 flaky 逐条核过：
唯一的红是上面那件 `walkthrough-round1`（HEAD 对照 3/3 全红，本刀不背）；三件 flaky 每轮换名字
（`steward-conversation`「browser target available」、`live-full-text` 四条段序、`kimi-agent-cli` 没留下断言红），
**全是浏览器/子进程起不来那一族**，且病历都已留下。**机器此刻明显变噪** —— 同一棵树结构今天早些时候
连着两轮全量是 349/0/0。这不构成放行的理由，所以本刀的把握不建立在这一轮上，而建立在：管家族五件串行 5/5、
记忆件 (G) 组 15 条全绿、真浏览器 (K) 组 5 条全绿、三条静态锁、四处反向各自点名。
