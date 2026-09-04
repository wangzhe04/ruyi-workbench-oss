# 工程规范 · 后端/前端模块结构与提交纪律（ENGINEERING SPEC）

> 状态（2026-09-03）：第 110 波「结构化重构与代码精简」阶段①「SPEC 先行」交付物，来源为
> [`docs/optimization-plan/24-waves-108-110-implementation.md`](optimization-plan/24-waves-108-110-implementation.md) §3.2 大纲。
> 本文只回答「怎么切、切到哪、什么算过门」，不新增或修改任何运行时行为。
> 起草基线：HEAD `b80e36b` 加第 108 波在途工作树改动（行数表里 `09-workflow.js` 等数字含在途增量）；第 110 波开工时按 §4 步骤 1 重新实测后再冻结本表。

---

## 0. 文档定位与适用范围

本规范约束以下目录的**结构与提交纪律**：`ruyi-workbench/app/src`（后端构建期拼接源）、
`ruyi-workbench/app/public`（前端静态资源）、`dev-harness`（离线 e2e 与生成器）、
`mcp/ai-computer-control`（桌面控制 MCP，Python 独立打包）。

本文**不复述**贡献红线，只引用：五条硬约束见 `CONTRIBUTING.md:5-11`；范围冻结与统一纪律见
[`23-architecture-repayment-sequence.md` §1](optimization-plan/23-architecture-repayment-sequence.md)（`docs/optimization-plan/23-architecture-repayment-sequence.md:28-34`）。
两者与本文冲突时以两者为准，本文只是二者在「模块怎么拆、命名怎么起、锁怎么改」这一具体问题上的操作细则。

**规范与现状不符时的处理原则**：本文第 2 节列出的规模上限在起草时已有 10 个文件超限（见该节清单表）。
超限文件**先登记待办**，不自动构成违规、不阻塞其他改动、不需要立即整改。只有*新建*文件违反硬上限，
或者一次提交让某文件的超限程度继续恶化，才算违规。存量超限的收敛节奏由第 110 波
[§3.3 拆分顺序表](optimization-plan/24-waves-108-110-implementation.md)（本文第 10 节复制）安排。

---

## 1. 后端模块分层与命名

`app/src/` 下每个源文件按 `NN[x]-domain.js` 命名：两位数字前缀决定**拼接顺序**（`build.js:29`
`for (const m of manifest.modules)` 按 `manifest.json` 的数组顺序逐个 `readFileSync` 后 `join('\n')`），
拼接顺序等价于**层级**——层级判定完全由 `dev-harness/module-dependency-graph.js:38-47` 的
`moduleLayer()` 正则表决定：

| 前缀正则 | 层级 | 现有代表模块 |
|---|---|---|
| `^00-` | bootstrap | `00-boot.js` |
| `^0[1-4]-` | foundation | `01-config.js`、`02-session-store.js`、`03-bridge-guard.js`、`04-permission-runtime.js` |
| `^0[56][a-z]?-` | engine | `05-claude-engine.js`、`05b-kimi-bridge.js`、`06-provider-engine.js`、`06c-agent-loop-hooks.js` |
| `^(07\|08\|09\|10)-` | orchestration | `07-autonomy.js`、`08-agent-runs.js`、`09-workflow.js`、`10-context-governance.js` |
| `^(11\|12)-` | tools | `11-native-tools.js`、`12-tool-dispatch.js` |
| `^13[a-z]?-` | transport | `13-http-router.js`、`13e-pretender-index.js` |
| `^14-` | entrypoint | `14-main.js` |
| 都不匹配 | `unclassified` | — |

**现状缺口**：只有 engine（`05/06`）与 transport（`13`）两层的正则允许单字母后缀（`[a-z]?`），
`01-04`（foundation）、`07-10`（orchestration）、`11-12`（tools）三层目前**不允许**后缀字母
（`module-dependency-graph.js:40,42,43` 均为裸 `^0[1-4]-` / `^(07|08|09|10)-` / `^(11|12)-`，无 `[a-z]?`）。

**本波裁决**：把 `moduleLayer()` 正则扩为**所有层统一允许单字母后缀**。这是 **dev-harness 侧改动**
（只改 `dev-harness/module-dependency-graph.js` 的分类函数），不改任何运行时文件，不影响 `server.js`
产物。在这一改动落地前，foundation/orchestration/tools 三层拆出的新文件若用字母后缀命名，会被
`--check` 判为 `unclassified` 而非直接判违规；执行拆分顺序表第 2/3/4 项前必须先完成本条 dev-harness 改动。

**新模块命名示例**（对应第 10 节顺序表）：

| 示例文件名 | 目标层 | 当前正则是否已允许 |
|---|---|---|
| `13f-native-tool-schemas.js` | transport | 已允许（`13[a-z]?-`） |
| `01b-route-auth.js` | foundation | 需先扩正则 |
| `02c-turn-segments.js` | foundation | 需先扩正则 |
| `09b-turn-prompt-assembly.js` | orchestration | 需先扩正则 |

**同层内顺序以 manifest 为准，字母后缀不隐含先后**：`NN[x]-` 的字母只标识「从 `NN-` 拆出的第几个同层模块」，不承诺拼接在 `NN-` 之后；为让新增边成为后向边，拆出模块常放在其消费者之前（先例：110-1 把 `13f-` 放在 `13-` 之前，110-2 把 `01b-`／`01c-` 放在 `01-` 之前）。

**manifest 位置决定边方向**：`manifest.json` 中模块条目的先后顺序即拼接顺序；若模块 A 在 B 之前拼接
却引用 B 的顶层符号，判定为**前向边**（consumer 声明早于 provider），若 A 在 B 之后拼接引用 B，
判定为**后向边**。新拆出的模块应尽量安插在其唯一消费者之后、其依赖的模块之前，使新增边为后向边
（呼应第 4 节 SOP 步骤 3）。当前基线：**30 模块／240 条边／65 条前向边／0 个重复导出／1 个强连通分量**
（`docs/architecture/module-dependency-graph.json` 现算 `summary` 字段，与
`module-dependency-policy.json:3` 记录的 104 波复核基线一致）。

---

## 2. 规模上限

| 范围 | 目标上限 | 硬上限（仅约束新文件） |
|---|---|---|
| `app/src` 单模块 | ≤ 2000 行 | 2500 行 |
| 前端单个 `.js` | ≤ 1500 行 | — |
| 前端单个 `.css` | ≤ 1200 行 | — |

超过目标上限的**存量**文件不算违规，登记进下表即可；新建文件超过硬上限才算违规，应在同一提交内拆分。

### 现存超限清单表（实测，2026-09-03，HEAD `b80e36b`）

后端 `app/src` 逐文件 `wc -l`：

| 文件 | 行数 |
|---|---:|
| `09-workflow.js` | 3075（110-4a/4b 后；起草时 3375） |
| `02-session-store.js` | 2943（110-3b 后；起草时 3176） |
| `05b-kimi-bridge.js` | 2752 |
| `10-context-governance.js` | 2249 |
| `08-agent-runs.js` | 2219 |
| `01-config.js` | 2175（110-2a/2b 后；起草时 2423） |
| `11-native-tools.js` | 2057 |
| `13-http-router.js` | 1861（110-1 后已低于目标上限；起草时 2603） |

> 说明：`24-waves-108-110-implementation.md` §3.1「摸底修正」记为 7 件超限，未列 `11-native-tools.js`。
> 本文起草时对同一 HEAD 重新逐文件计数，`11-native-tools.js` 实测 2057 行，已越过 2000 行目标上限，
> 故本表登记为第 8 件。未在第 10 节顺序表中安排具体拆法，留待后续切片核实并补充顺序表条目，
> 不因此推翻已有的 1–7 项排期。

前端 `app/public`：

| 文件 | 行数 | 上限 |
|---|---:|---:|
| `js/preview-shell.js` | 3557 | 1500 |
| `css/views/preview-shell.css` | 1982 | 1200 |

其余前端 `.js`（`chat-stream-runtime.js` 1354、`app.js` 1228、`skills-memory.js` 1152、
`provider-settings.js` 1075、`session-experience.js` 1073、`navigation-controls.js` 1025、
`chat-render-primitives.js` 934）与其余 `.css`（`workspace.css` 456、`tool-pane.css` 397、
`workbench.css` 363、`chat-shell.css` 320）均在上限内，不登记。

---

## 3. 模块边界

- `provides`/`requires` 契约由 `dev-harness/module-dependency-graph.js` 机器化扫描生成，产物为
  `ruyi-workbench/app/src/module-contracts.json` 与 `docs/architecture/module-dependency-graph.{json,md}`；
  `--check` 对三者做逐字节新鲜度校验，任何手改跨模块引用而未重跑生成器都会被拦下。
- **新增前向边或环边必须经架构评审**，评审通过后才允许写入
  `ruyi-workbench/app/src/module-dependency-policy.json`，且**该文件的修改必须单独成一个 commit**，
  不得与拆分本身混在同一次提交（`24-waves-108-110-implementation.md` §3.4 步骤 4：
  「若不可避免，停下评审，不在同一 commit 内改 policy」）。`module-dependency-policy.json:3` 的头部
  `note` 字段明确写着「Future additions still require explicit architecture review」——本波沿用此约束，
  不放宽债务上限。
- **边端点重归属（搬家特例）**：纯搬家把某符号的 provider 从模块 A 移到新模块 A′ 时，policy 中已登记的 `X -> A`（同符号、同消费者）边会被 `--check` 报为「新前向边 `X -> A′`」。这不是新依赖，只是端点改名：允许在**同一个搬家 commit** 内把 policy 中对应条目的 provider 改为 A′，并在 commit 信息与 policy 条目 `note` 里写明「110-N 搬家重归属」。**对称地，consumer 侧也适用**：引用某符号的代码块逐字节搬到新模块 X′ 时，policy 中的 `X -> P`（同符号、同 provider）变为 `X′ -> P`，同样是端点改名而非新依赖，允许同 commit 改写并注明（110-4b 先例：`09-workflow.js -> 10-context-governance.js` 的 `ESTIMATION_RULES` 随 token 估算簇迁至 `09d-token-estimation.js`）。只有消费者与 provider 都未搬家、却出现了此前不存在的符号引用，才算真正的新边，仍须单独评审提交。若生成器在搬家后首次「发现」一条代码里早已存在但此前未被扫描到的边（扫描器缺口），按新边评审，但可在评审记录中注明属于既有依赖。
- **新建独立模块优先采用 `06c` 式 IIFE 命名空间 + 注入依赖 + 冻结导出**范式：
  `06c-agent-loop-hooks.js:16` `const AgentLoopHooks = ((makeIdFn, logEventFn, redactFn) => { ... })(makeId, logEvent, redact);`，
  内部所有 helper 与状态收进闭包，只在文件末尾 `return Object.freeze({...})`（`06c-agent-loop-hooks.js:410-417`）
  暴露七个稳定入口；三个外部依赖（`makeId`/`logEvent`/`redact`）以 IIFE 参数显式注入，不做隐式全局读取。
  该范式被 `dev-harness/module-dependency-graph.static.e2e.js:52-61` 锁定：`06c` 只 `provides` 一个符号
  `['AgentLoopHooks']`，且必须显式声明对 `makeId`/`logEvent`/`redact` 三个符号的 `requires`。
- **明令不做全树 IIFE 化**：`23-architecture-repayment-sequence.md:24`（§0 第 2 条）已裁决「不在一次机械
  提交中强制全体模块整体 IIFE 化；先建立 provides/requires 契约与 CI，再按强连通分量、叶子模块和高变更
  域分批隔离」。第 110 波延续该裁决——`06c` 范式只作为**新建/拆出**模块的推荐写法，不回填存量模块。
- **命名冲突规则**：`module-dependency-graph.static.e2e.js` 对重复顶层导出名（`duplicateProvides`）零容忍，
  当前基线为 0（`docs/architecture/module-dependency-graph.json` `summary.duplicateProvides`）。拆分产生
  的新模块提供的任何顶层符号（函数名、`const` 名等）不得与仓库内任何既有模块的顶层符号重名，即使两者
  从不互相引用——共享顶层作用域下重名会直接覆盖。

---

## 4. 纯搬家拆分 SOP（每个 commit 必走）

以下 8 步照抄 `24-waves-108-110-implementation.md` §3.4，不删减步骤：

1. 记录 `wc -l <源文件>` 与 `node ruyi-workbench/app/build.js --check` 新鲜，作为本次拆分的前置基线。**同时对待搬块做自由标识符扫描**（剥掉注释、字符串与属性访问后的标识符全集，减去块内自身声明、形参、局部变量与全局内建）：剩余标识符若有定义在**源模块内部**的符号，该块不是纯搬家候选（搬出会把文件内调用变成跨模块边，多半扩大强连通分量），须先另立行为中性切片处理 helper 归属；只引用更早模块或不引用外部符号的块才继续。110-3a 的教训见 24 号 §3.3 交付记录。
2. 新建目标模块（首行顶格、全 LF），把要搬的代码块**逐字节**剪切搬入，不改任何标识符、注释与内部顺序；
   源文件原位置留一行注释指向新模块。
3. 在 `manifest.json` 插入新模块条目（插入位置决定该模块与既有模块的前向/后向边方向，见第 1 节）；
   跑 `node ruyi-workbench/app/build.js` 重建产物并回填行区间。
4. 跑 `node dev-harness/module-dependency-graph.js --write` 再 `--check`：确认零新增前向边／环边；
   若无法避免，停下来做架构评审，且不在本 commit 内改 `module-dependency-policy.json`（见第 3 节）。
5. 按第 8 节的固定顺序跑完剩余生成器；`git diff docs/architecture/` 只允许出现「符号归属的文件名变化」，
   不允许出现符号本身的增减。
6. 改静态锁：把 `read('<源文件>')` 改成「源文件 + 目标文件拼接读取」，只改读取来源，不改任何断言内容或
   期望值（先例：`dev-harness/pretender-task-sheet.static.e2e.js:13-16` 把单文件读取换成
   `const taskSheetDomain = shell + taskSheetModule + lensesModule + finishModule;` 四文件拼接，断言文本原样保留）。
7. 跑 `node dev-harness/run-all.js --fast` 再 `--parallel 4` 全绿；`git diff --stat` 确认只有：
   源文件、目标文件、`manifest.json`、生成物（`docs/architecture/*`、必要时 `facts.json`）、被改的锁文件。
8. 提交，信息格式：`refactor(structure): 110-<序> split <源> -> <目标> (pure move, zero behavior)`。

### commit 信息格式

延续 `24-waves-108-110-implementation.md` §0 第 8 条统一格式 `feat|refactor|docs(scope): <切片编号> <一句话>`；
第 110 波固定用上面步骤 8 的模板。**commit 由用户拍板执行**，实施方只负责把工作树推进到「门全绿、边界清晰」
的状态（同一文档 §0 第 8/9 条）。

### 每步 diff 允许 / 不允许出现的内容

| 允许 | 不允许 |
|---|---|
| 源文件删除代码块、目标文件新增同一代码块（逐字节相同） | 标识符改名、逻辑改写、缩进或引号风格的顺手格式化 |
| `manifest.json` 新增一行模块条目 | `manifest.json` 既有条目顺序被打乱 |
| `docs/architecture/*.{json,md}` 中符号的文件归属字段变化 | `docs/architecture/*.json` 的 provides/requires 符号总集合发生增减 |
| 静态锁文件里 `read(...)` 调用改成多文件拼接读取 | 静态锁文件里的正则表达式或断言期望值发生变化 |
| `facts.json` 中确有变化的门面数字（如模块数、e2e 数） | `facts.json` 里与本次拆分无关字段的漂移 |

---

## 5. 注释与编码

- **UTF-8 无 BOM、全 LF**：`.gitattributes:17-19` 钉死 `*.js`/`*.json`/`*.md` 为 `text eol=lf`；
  `build.js:32-33`（铁律⑤）在拼接时对模块内容做 `if (body.includes('\r')) throw ...`，含 CR 的模块直接
  拒绝拼接，不静默转换。
- **`server.js` 侧注释**（即所有会被拼接进 `app/src/*.js` 的源文件里的注释）应避免使用 U+2014 em dash
  等易被编辑工具在多行编辑时静默改写为其他字符的标点；改用 ASCII `-`/`--` 或中文全角破折号「——」，
  且同一段落内不要混用两种写法。
- 中文注释允许，鼓励在拆分/波次改动处写清楚背景与理由（现状仓库内大量先例，如
  `06c-agent-loop-hooks.js:1-15` 的波次说明块）。
- **波次标注写法**：新注释统一用 `// <波次编号>[子项字母]: <一句话>`，例如 `// 110-3: 从 02-session-store.js
  搬出 turn segment builder`；段落级说明可保留「第 N 波」全称开头的写法（现状两种写法并存，不强制回填存量注释）。
- **禁止在注释里出现密钥、用户名、内网路径等敏感信息**——这是 repo-hygiene 门的职责范围
  （`CONTRIBUTING.md:17` 列出的两个跑测试套件示例之一即 `node dev-harness\repo-hygiene.e2e.js`）。

---

## 6. 测试断言纪律

- **只加不改语义**：`CONTRIBUTING.md:11`「断言只加不改语义——可以断言新字段，不要删旧断言」。
- **静态锁用正则与「多文件拼接读取」，不写绝对行号**：`24-waves-108-110-implementation.md` §3.1 摸底确认
  46 件 static e2e 的锁均为 `read(path.join(SRC,'<file>'))` + 正则／字面量断言，无一处写绝对行号；
  拼接读取先例见第 4 节步骤 6 引用的 `pretender-task-sheet.static.e2e.js:13-16`。
- **门面数字（`facts.json`、工具数、e2e 数）只经生成器改动**，不手改：`facts.json` 由
  `dev-harness/facts-generate.js` 重算覆写（第 8 节）；`facts.static.e2e.js` 用目录重算交叉校验防再漂移
  （历史教训见 `23-architecture-repayment-sequence.md` §0 表格「默认回归 227、unit 6 组」一行——facts.json
  曾长期与真实目录数字脱节）。
- **「重钉」的定义**：把某个锁定值（SHA256、字符阈值、行数护栏等）随**一次有意的、已审查的改动**同步更新
  为新实测值。只允许在导致该值变化的实际改动**同一 commit**内进行，且必须在断言文案里注明来源
  （波次编号或 commit），不得只改数字不写来源（先例见 `dev-harness/read-frontend-css.js:17-33` 附近逐条
  波次注释，每次重钉 `LEGACY_STYLES_SHA256` 都写明第几波、改了哪个所有权层）。
  - **允许重钉的场景**：CSS 载荷分组结构变化（新增/拆分/合并 CSS 文件）、模块搬家后静态锁的 `vm` 片段来源
    随之改变、组合根行数护栏因搬家产生的净行数变化。
  - **不允许**：为了让某个门通过而放宽断言容差或删除断言本身——这属于「改语义」，需要另立行为项说明理由。
- **新 e2e 自查清单**（照抄 `CONTRIBUTING.md:24`）：临时 `HOME`（tmpdir）；健康轮询起服务，不裸 `sleep`；
  `finally` 里 `taskkill /T /F` 清理 fake 与 workbench 子进程；逐条打印 `PASS/FAIL <label>`；
  `process.exit(fail?1:0)`；跑两遍确认无端口或临时目录残留导致的偶发失败。
- **live 件 SKIP 约定**：文件名以 `-live.e2e.js` 结尾的件需要真实密钥或真实外部子进程，在
  `dev-harness/run-all.js` 的 `SKIP` 名单中显式登记（`run-all.js:39-52`），常规离线回归中跳过；
  每件文件头部注释须写明它断言的边界与所需的外部条件（`CONTRIBUTING.md:22`）。

---

## 7. 前端

- **产品 UX 红线（2026-09-03 用户拍板）**：**不得实现「给用户一个路径或命令，让他自己去别处打开」的交互**。用户不应为完成一件事而离开如意——手册在应用内阅读、文件夹与日志由应用内的动作打开、设置在应用内改。只能给出路径的地方，先补一个真正可点的动作再谈文案。（canonical 表述见 `docs/optimization-plan/28-wave-118-onboarding.md` §2，管家侧展开见 27 号 §8.1。）
- **原生 ES Modules，无 bundler**：`app/public/js/*.js` 直接以脚本模块方式被 `index.html` 引用，构建期
  不经过任何打包器；这是既有前端交付方式，本波不引入 bundler。
- **CSS 载荷分组变更必须同 commit 重钉 `LEGACY_STYLES_SHA256`**（`dev-harness/read-frontend-css.js:90`），步骤：
  1. 改 `dev-harness/read-frontend-css.js:14` 起的 `CSS_PAYLOAD_GROUPS` 数组（新增/拆分/重排文件条目）。
  2. 跑 `frontend-domains.static` 对应的静态门（`dev-harness/frontend-domains.static.e2e.js`），
     该门依据 `read-frontend-css.js` 的 `readLayerPayload()` 逐层拼接内容重算 SHA256，失败时输出实测新值。
  3. 把重算出的新值回填到 `read-frontend-css.js:90` 的 `LEGACY_STYLES_SHA256` 常量。
  4. 在常量正上方的注释区（`read-frontend-css.js:17` 起已有连续多波次注释）追加本次改动说明，写明
     「哪个所有权层的有意变更」，格式对齐现有先例（如 `read-frontend-css.js:33` 起 109b905 一条）。
- **vendor 库入库范式**（现有先例，供后续如 mermaid 等库引入时遵循）：
  1. 库的预编译产物放入 `app/public/vendor/`。
  2. `index.html` 用 `<script src="/vendor/xxx.min.js">` 自托管引用，不接 CDN 地址。
  3. 在 `THIRD-PARTY-NOTICES.md` 逐条登记名称、版本、许可证。
  4. CSP `script-src 'self'` 天然要求自托管——引入任何新脚本资源前先确认它能满足这一条，不得取用来源不明
     的、他人产品打包 chunk 形式的库文件。

---

## 8. 生成器链与门

任何触碰 `app/src/` 的切片收尾必须**按以下固定顺序**手跑，没有一键脚本
（`24-waves-108-110-implementation.md` §0 第 4 条）。各生成器的 `--write`/`--check` 语义**不统一**，逐个列出：

| 序 | 命令 | 语义 |
|---|---|---|
| 1 | `node ruyi-workbench/app/build.js` | 无参 = 写：拼接 `src/` 生成 `server.js`（tmp+rename 原子写，产物先过 `node --check` 才落盘）。 |
| 2 | `node dev-harness/module-dependency-graph.js --write` | `--write` = 写：重新扫描并覆盖 `module-contracts.json`、`docs/architecture/module-dependency-graph.{json,md}`。 |
| 2′ | `node dev-harness/module-dependency-graph.js --check` | `--check` = 只读：三份产物逐字节新鲜度校验，不写文件；出现新前向边/环边即退出 1，需人工评审后才能改 `module-dependency-policy.json`。 |
| 3 | `node dev-harness/route-inventory.js` | **无参 = 写**：重新生成 `docs/architecture/route-inventory.{json,md}`；该生成器另支持独立 `--check`（只读比对，不写文件，见 `route-inventory.js:408-422`），本步链路里用的是写模式。 |
| 4 | `node dev-harness/architecture-contract-snapshots.js --write` | **`--write` = 写**；**不传 `--write` 则默认是只读校验**（`architecture-contract-snapshots.js:98-108`：无参时比对现有产物与重算结果，漂移则退出 1 并提示「run with --write」）——与 `module-dependency-graph.js` 的显式 `--check` 命名习惯相反，注意不要漏传 `--write`。 |
| 5 | `node dev-harness/durable-state-inventory.js --write` | **`--write` = 写**；同样不传 `--write` 时默认走只读 `check()` 分支（`durable-state-inventory.js:118`），命名习惯与上一步一致。 |
| 6 | `node dev-harness/facts-generate.js` | **仅门面数字变化时才需要跑**；该生成器**没有 `--check`/`--write` 区分**，运行即直接重算并覆写 `facts.json`（`facts-generate.js` 头部用法注释：「重算并覆写」），无只读模式。 |
| 7 | `node ruyi-workbench/app/build.js --check` | `--check` = 只读：收尾复核 `server.js` 产物新鲜度，不一致退出 1。 |
| 8 | `node dev-harness/run-all.js --fast` | 快通道：只跑 `*.static.e2e.js`（秒级，无端口/无子进程）。 |
| 9 | `node dev-harness/run-all.js --parallel 4` | 全量并行回归。 |

必须按序手跑；第 4、5 两步的「无参 = 只读，`--write` = 写」与第 2 步「`--write` = 写，`--check` = 只读」
两套命名习惯并存，不要凭直觉假设某个生成器不传参数就是安全的只读校验。

---

## 9. 明确不做

- 任何行为改动、任何新开关——第 110 波是纯结构切片，不引入运行时语义变化。
- `dev-harness` 瘦身——若确要做，须先单列「断言只加不改」的破例评审，本波不夹带。
- `realhist-fixtures` 环境缺口修复——不在本波范围内。
- 不动 session store v2、Intervention journal、权限门、checkpoint／恢复协议
  （`23-architecture-repayment-sequence.md:32`，§1 第 3 条）。
- 不做全树 IIFE 化（第 3 节已述）。
- 不设默认行为开关；纯搬家切片回退方式就是还原该切片改动的文件（`24-waves-108-110-implementation.md` §0 第 2 条）。

---

## 10. 附录

### 10.1 拆分顺序表（复制自 `24-waves-108-110-implementation.md` §3.3）

| 序 | 源文件 | 搬出内容 → 目标模块（拼接位置） | 需同步的锁 |
|---|---|---|---|
| 1 | `13-http-router.js` | `MCP_TOOLS` schema 数组（约 `:1685-2470`）→ `13f-native-tool-schemas.js`，manifest 放在 `13-http-router.js` **之前**（使 13→13f 为后向边；`04-permission-runtime.js:1604`、`11-native-tools.js:2050` 的引用须核实为运行时读取） | route-inventory（判定点数不变）、`memory-toolbox.static`、`pretender-*.static` 4 件改拼接读取、architecture-contract-snapshots |
| 2 | `01-config.js` | `ROUTE_AUTH` 表（约 `:2290-2380`）→ `01b-route-auth.js`；运行时开关默认值＋sanitize 表 → `01c-runtime-flags.js` | `route-inventory.js` 读 `ROUTE_AUTH` 的路径、`acc-offline-installer.static`、`runtime-optimization.static` 的 sanitize 邻接断言（改拼接读取）、`moduleLayer` 正则扩展 |
| 3 | `02-session-store.js` | `BRIDGED_WRITE_PATH_ARGS` 表 → `02b-bridged-write-args.js`；turn segment builder（`createTurnSegmentBuilder`）→ `02c-turn-segments.js` | `finalize-segments.static`（vm 片段来源）、`ec-d-closure`／`turn-narrative`／`resume-banner-dismiss`／`pretender-return-archive` 改拼接读取、fake-mcp-contract（导出名不变） |
| 4 | `09-workflow.js` | 回合提示词装配（`volatileExtras`、`buildBodyWithLayout`、`appendPromptToLastUserMessage`）→ `09b-turn-prompt-assembly.js`；模型调用与流事件 → `09c-model-call.js`（视依赖图结果决定是否合并为一个） | 6 件 static 改拼接读取；`prompt-snapshot.static` D8–D10 的 `src` 来源；`software-engineering-prompt.static`；meta-guard 引用计数 |
| 5 | `05b-kimi-bridge.js` | 流解析／事件归一 → `05e-kimi-stream.js` | `module-dependency-graph.static:57` 文件名列表 |
| 6 | `10-context-governance.js`、`08-agent-runs.js` | 候选：压缩执行体／子代理运行记录持久化 | 按第 4 项的同法处理 |
| 7 | `preview-shell.js` | 把第 100 波五域骨架填实：任务单／镜头／收工／交办台首页各自搬出主体 | 7 件 `pretender-*.static` 全部改拼接读取（task-sheet 已是） |
| 8 | `preview-shell.css` | 按视图区块拆 3–4 文件，同 commit 更新 `CSS_PAYLOAD_GROUPS` 并重钉 SHA | `frontend-domains.static` D51 |

顺序理由：1／2 触碰最少的 static 锁且收益立竿见影；4 排在 108 波之后（108 波改动 `06`/`09` 的提示词装配，
先完成行为切片再搬家，避免搬家与行为改动交叉）；7／8 独立于后端，可与后端拆分交替进行但不并行提交。

### 10.2 每次拆分检查清单

- [ ] 已记录拆分前 `wc -l` 与 `build.js --check` 新鲜。
- [ ] 目标模块首行顶格、全 LF，内容与源代码块逐字节一致。
- [ ] `manifest.json` 插入位置已按第 1 节规则选择（新边尽量为后向边）。
- [ ] `module-dependency-graph.js --write` 后 `--check` 零新增前向边／环边，或已完成架构评审并单独提交
      policy 改动。
- [ ] 第 8 节全部生成器已按序跑完，`docs/architecture/*` diff 只含文件归属变化。
- [ ] 静态锁已改为拼接读取，断言文案与期望值未改。
- [ ] `run-all.js --fast` 与 `--parallel 4` 全绿。
- [ ] `git diff --stat` 只含第 4 节允许的文件集合。
- [ ] commit 信息符合 `refactor(structure): 110-<序> split <源> -> <目标> (pure move, zero behavior)` 格式。
