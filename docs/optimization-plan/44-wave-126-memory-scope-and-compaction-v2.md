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

**全量回归**：第一轮 348 pass / 1 fail / 3 flaky —— 唯一的红是 `dom-smoke`，红在 `B1 dump-dom 完成 (0B, status=4294967295)`，是 **Edge 启动退 -1**，与我这一刀（引擎侧、默认关）无关；两件单跑各两次全绿。就地把那一族治了（42 号文 §5-decies：一次性启动浏览器的两件补进独占桶＋加锁），收口重跑：**349 pass / 0 fail / 349 ran，真回归 0**，唯一 flaky 是 `steward-board`（没留下断言红，属已登记 300 s 豁免的超时族）。
