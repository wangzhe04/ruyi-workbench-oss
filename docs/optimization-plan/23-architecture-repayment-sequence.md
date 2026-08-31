# 23 · 架构偿还与上下文演进序列（第 103–107 波）

> **状态（2026-08-31）**：由《第 103 波 · 架构偿还波（提案 v0.7）》经当前主树复核后以 **revise-major** 结论纳入路线图；本文是实施依据，原提案保留为输入材料，不作为已批准范围。**第 103 波（103a／103b／103c）已交付**；当前下一实施入口为第 104 波零行为内聚与上下文结构。
> **性质**：第 103、104 波为零用户可见行为的结构偿还；第 105、106 波包含默认关闭、逐项取证的行为实验；第 107 波只做发布准入与批准决策，不自动恢复旧壳层 P4。
> **关联**：[全局路线图](../OPTIMIZATION-ROADMAP.md)、[22 号 Agent SoC 方案](22-agent-soc-microarchitecture.md)、[旧 Pretender 规划](../PRETENDER-PLAN.md)、[20 号运行时优化](20-runtime-optimization-cost-benefit.md)。

---

## 0. 评估结论与基线校准

提案指出的方向性问题成立：路由声明与 handler 分离、拼接模块共享顶层作用域、`04/07/10` 的职责错位，以及持久化能力分散，都会提高后续引擎优化的改动成本。但提案的若干“当前事实”已经被历史交付覆盖，不能据此重复建设。

| 提案判断 | 2026-08-30 主树事实 | 裁决 |
|---|---|---|
| 四类决策没有唯一 command core | `13d-core-domain-routes.js` 已有 `decideIntervention()`；contract 与 question／permission／plan／pool 四类经典入口均为适配器；`interventions-persist.e2e.js` 已锁 CAS、重放、混合路径与四类 source | **已交付，不重做**；103a 只补响应快照与路由声明治理 |
| 17 个模块、1391 个共享顶层符号 | manifest 当前为 **24 个**拼接模块；共享作用域与隐式依赖仍存在，但旧符号数字已失效 | 问题成立、数字作废；以 103b 机器图为准 |
| 88 处 `pathname ===` 路由链 | `13*` 已做部分域拆分，但全树仍有 **100+ 路径判定点**；`ROUTE_AUTH` 已声明式且 deny-by-default，handler 映射仍是 if 链 | 收敛“鉴权 + 匹配 + handler”为可校验的单一事实源，但不得削弱既有鉴权纵深 |
| 至少 7 个 JSON 私役都在重造原子写 | 公共 `atomicWriteJson()` 已存在且多数写路径已复用；`context-calibration.json` 等读校验／隔离／缓存策略仍有私役 | 不按“7 处”硬凑迁移数；先清册，再补公共读写生命周期能力 |
| 默认回归 227、unit 6 组 | 目录重算为 **237 个 E2E、14 组 unit suite**；`facts.json` 仍写 13，已有新鲜度漂移 | 旧数字作废；103a 先恢复 facts 新鲜度并让出门门以目录重算交叉校验 |

因此，本线采纳“先偿还结构债、再做上下文行为优化、最后汇入 3.0 证据与发布门”的主张，同时作四项修订：

1. 不把已交付的 T1／T2／S2 改记为未完成，也不重复实现 command core。
2. 不在一次机械提交中强制全体模块整体 IIFE 化；先建立 `provides/requires` 契约与 CI，再按强连通分量、叶子模块和高变更域分批隔离。
3. durableStore 复用 `atomicWriteJson()`，只新增缺失的读取、校验、隔离、版本、容量与缓存组合能力。
4. 103 是后续高触碰结构工作的前置；104／105 只约束上下文相关方向，不把所有 22 号无关实验无限期阻塞在整线之后。

## 1. 范围冻结与统一纪律

- 第 103、104 波不得改变用户可见响应、提示词、默认配置、API 语义或模型输入；发现必须改变语义的事项，停止该切片并另立行为项。
- 不引入运行时 npm 依赖，不改 ESM／bundler，不手改生成的 `app/server.js`；所有源码修改仍发生在 `app/src/`，由 `build.js` 生成并校验。
- 不重写 session store v2、Intervention journal、权限门、checkpoint／恢复协议；新原语只能环绕、复用或迁移明确清册中的私役。
- 每个切片先锁现状再改实现；旧端点、错误信封、鉴权、配对、审计、回滚和构建新鲜度不得漂移。
- 波次为唯一序号。此前 Roadmap 的“第 103 波起 MicroAgent”只是候选占位且相关 A／B／C／F 已用独立提交交付，不占用第 103 波编号。

## 2. 第 103 波 · 架构基座偿还

### 103a · 路由与 command surface 收敛

**范围**：

- 重新生成当前路由清册：method、精确／模式路径、auth、handler、所属域、测试覆盖；将 `ROUTE_AUTH` 与 handler 匹配逐步收敛为可生成／可校验的 descriptor（目标形状 `{ method, pattern, auth, handler }`）。同时恢复 `facts.json` 与 E2E／unit 目录重算的一致性，防止规划和门面数字继续漂移。
- 保留现有 `decideIntervention()` 为唯一决策核心；为 contract 与四类经典适配器补逐端点响应快照，覆盖成功、版本冲突、重放、过期、不可送达、缺失与越权。
- 路由迁移按域分批，不要求一次替换所有 if 链；每批必须证明未知路由仍 deny-by-default，`token-browser`／`token`／`open` 等等级不降级。

**出门判据**：路由清册 100% 覆盖现有 API；descriptor 与实际 handler／鉴权无漂移；Intervention 旧、新入口快照除已有历史差异外零变化；全量回归、`node --check`、构建新鲜度全绿。

#### 103a Release Brief（2026-08-30 实施记录）

- **问题**：路由清册只存在于 if 链源码里，`ROUTE_AUTH` 与 handler 匹配各自演进、无机器校验；`facts.json` 的 unit 计数已漂移（写 13、实为 14）；contract 与四类经典决策适配器缺逐端点响应快照，后续 descriptor 化迁移没有字节级对照基线。
- **非目标**：不改任何运行时路由／鉴权／handler 行为（零 `app/src/` 改动）；不一次性把 if 链替换为表驱动 descriptor——按本波范围第 3 条，运行时迁移按域分批，属后续批次；不「修正」已锁定的历史形状（如 plan 无挂起返回 HTTP 200 携带错误体）。
- **交付物**：
  - `dev-harness/route-inventory.js`（可 `require` 的生成器 + CLI `--check`）→ `docs/architecture/route-inventory.json`（schema 1，机器可读）与 `.md`（人读表）：**101 个判定点**（exact 88／prefix 12／regex 1）+ `ROUTE_AUTH` 92 条，handler↔鉴权双向交叉校验 0 漂移、0 告警；9 个判定点无 e2e 覆盖，仅作信息列、不阻塞。
  - `dev-harness/route-inventory.static.e2e.js`：逐字节一致性门 + deny-by-default 合成未知路由断言 + 关键端点鉴权等级不降级断言（bootstrap 保持 open、contract 决策保持 token 等）。
  - `dev-harness/interventions-snapshot.e2e.js`：contract 决策端点七场景（越权 403／缺失 404／版本冲突 409／不可送达 409／过期 410／终态 409／成功 200）+ 幂等重放（同 key 同 payload 逐字节一致、异 payload 409）+ 四类经典适配器成功与错误快照，全信封键序归一逐字节比对。
  - `facts.json` 新鲜度修复：`facts-generate.js` 重算（unitSuites 14、e2eCount 239），`facts.static.e2e.js` 以目录重算交叉校验防再漂移。
- **探得并锁定的新事实**（迁移时必须保持）：
  1. 路径穿越样式的裸 `..` 段在到达 handler 前已被 Node URL 规范化吞掉（404 `api.route_not_found`）；`%2F` 解码后的非法 id 由 id 白名单挡下（400 `intervention.invalid_request`）——两层防御均在快照中锁定。
  2. handler 返回字符串 `error` 时由 `json()` 统一包成 `{ok:false, error:{code:'api.request_failed', params:{}, message:<原文>}}` 信封；permission 未知 requestId 404、pool 缺参 400／死 run 409、plan 无挂起 **200** 均走此信封（plan 的 200 是历史 quirk，显式锁定、不在本波修正）。
- **证据**：`route-inventory.static.e2e.js`、`interventions-snapshot.e2e.js`、`facts.static.e2e.js` 全绿；定向回归（interventions-persist／cas／pool／changeseq／plan-mode + 三件静态）8/8 通过；全量 239 件回归、unit 14 组与构建新鲜度经 `run-all.js` 内置校验通过。`node --check` 由构建新鲜度校验间接覆盖（本切片零 src 改动，产物无需重建）。
- **回退**：全部为新增 harness 件与生成文档，回退 = 删除三件新 e2e／生成器与 `docs/architecture/route-inventory.*`，并将 `facts.json` 还原；无运行时行为可回退。
- **发布判断**：零用户可见行为、零产物改动，不随任何版本发布，不占 Escapade 补丁。
- **遗留**：if 链 → 表驱动 descriptor 的运行时迁移（含按域分批、每批复跑本切片两道门）未做，属 103a 范围第 3 条的后续批次；完成后本页补记。


#### 103a 补记（2026-08-31 · 109b905 回归缺口修复）

- 上一轮全量回归（239 件）暴露 **12 件失败**，逐件定位修复后全部单跑转绿（`agent-loop`、`subagent`、`usage-ledger`、`skills-registry`、`workbench-memory`、`claude-resume-recovery`、`e3-engine-switch-continuity`、`interactive-question`、`ec-d-closure.static`、`frontend-domains.static`、`i18n.static`、`pretender-dispatch-home`）。
- 归因分三类：
  1. **109b905 漏钉门面锁**（3 件静态）：CSS 载荷 SHA 未重钉（`frontend-domains` D51）、docs 目录漏同步 5 个新 locale 键（`i18n.static`）、组合根行数净增约 30 行超护栏（`ec-d-closure` E9 / D45）。修法：重钉载荷锁、补齐 docs 键、护栏对齐 1240（物理瘦身留给 103b/104）。
  2. **109b905 引入的会话引擎路由钉定未适配测试**（6 件 e2e）：`engineRoute` 使全局 config 切换不再重定向既有会话，e2e 改用 `PATCH /api/sessions/:id {engineRoute}` 显式钉路由后通过（e3 / interactive-question / skills-registry / claude-resume-recovery / workbench-memory / usage-ledger）。
  3. **真源码缺陷与断言脆弱**：`agent-loop` 的 `context_estimate` 事件走 `downstreamEvent` 直发漏带 traceId（已在 `09-workflow.js` 补 `traceId: activeTraceId` 并重建）；`subagent` 的 a3 并行判定在 fake 高速响应下流事件顺序退化为串行假象，改用持久化 run 记录判定。
- 变更摘要：`09-workflow.js` 一处 traceId 修复（唯一 src 改动）+ 6 件 e2e 补路由钉定 + 3 件静态门修锁 + subagent 断言加固；全部 12 件单跑复绿。全量 239 件回归因耗时暂停，留待后续跑通后复核出门。

### 103b · 模块依赖契约显式化

**范围**：

- 对 manifest 中当前全部模块扫描顶层声明、读取与调用，生成 `docs/architecture/module-dependency-graph.md` 和机器可读边清单。
- manifest 增加或伴生 `provides/requires` 契约；CI 拒绝未声明的新跨模块引用、重复导出名、循环依赖增量与越层调用。
- 按依赖图先处理叶子与高变更域，再处理强连通分量。IIFE／命名空间化是可选实施手段，不是脱离依赖图的一次性目标；每个隔离批次独立构建、独立回退。

**出门判据**：依赖图可重复生成且与源码一致；没有新增隐式边；至少完成一个代表性模块簇的隔离试点并形成迁移模板；行为、产物执行语义与全量测试不变。若全树隔离成本高于收益，剩余簇以成文清单进入 104，不假装完成。

#### 103b Release Brief（2026-08-31）

- **问题**：24 个构建期拼接模块共享同一顶层作用域，跨模块读取／调用没有机器契约；新增隐式边、重复顶层名、循环边和依赖声明顺序倒退只能靠人肉发现。旧提案的 1391 符号基线已失效，也没有可复用的物理隔离模板。
- **非目标**：不更改拼接顺序、运行时加载器、API／提示词／配置语义或 `module.exports` 公共形状；不在一个提交里把全树 IIFE 化；不假装已经拆开存量单一强连通分量；不增加 npm 运行时依赖。
- **交付物**：
  - `dev-harness/module-dependency-graph.js` 零依赖扫描 manifest 全部模块，识别顶层声明与跨模块 read／call（含 template interpolation，排除注释／字符串），生成 `app/src/module-contracts.json`、机器图 `docs/architecture/module-dependency-graph.json` 与人读图 `.md`；`--check` 对三者做逐字节新鲜度校验。
  - 独立 `app/src/module-dependency-policy.json` 锁定存量循环／前向边债务上限；常规 `--write` 永不自动放宽。新隐式引用先触发契约漂移，重复顶层名始终拒绝，新循环边或依赖较晚模块的前向边另行拒绝。
  - 当前可重复基线：**24 模块／1386 个顶层 provides／1502 个跨模块 requires／197 条模块边／59 条前向边／0 重复导出／1 个强连通分量**。这组数只描述当前拼接架构，不冒称 59 条前向边或单一 SCC 已偿还。
  - `module-dependency-graph.static.e2e.js` 锁生成物、manifest 覆盖、重复名、债务上限、扫描器对抗夹具和隔离试点消费者；新增后 `facts.json` 为 240 E2E（233 默认 + 7 live），README 同步恢复 24 模块／14 unit 等门面事实。
  - **隔离试点模板**：`06c-agent-loop-hooks.js` 以依赖注入 IIFE 收口，顶层 provides 从 15 个降为唯一 `AgentLoopHooks`；内部只注入 `makeId/logEvent/redact`，Claude、Kimi、provider loop 与 `14-main` 统一经命名空间消费；七个既有导出键及语义保持不变。迁移模板为“先画边 → 收内部符号 → 显式注入 requires → 消费方改命名空间 → 保持公共适配器 → 重建／全量门”。
  - 契约／policy 随 overlay 源码审计面发布；源码行号变化后同步重生成 103a 路由清册，101 判定点／92 鉴权行保持零漂移。
- **证据**：`module-dependency-graph.static.e2e.js` 与 `agent-loop.e2e.js` 定向全绿；静态快通道 **42/42**；最终 `run-all.js --parallel 2` 为 **233 pass／0 fail／0 flaky**，另 7 个真实外部依赖 live probe 按既有规则跳过；unit 14 组、build freshness、`node --check`、`git diff --check` 全绿。一次四路压力跑曾出现 5 fail／3 flaky，8 件全部串行复跑通过，降至两路后的完整同批复核零红，判定为本机子进程／端口资源饱和而非产品回归。
- **回退**：删除扫描器、静态门、契约／policy／图文档及 overlay 两个载荷项；将 `AgentLoopHooks` 消费点与 `06c` 恢复为原共享顶层符号；重建 `server.js`、manifest 行区间、路由清册和 facts。无持久化数据迁移需要回退。
- **发布判断**：零用户可见行为，不单独触发版本升级；可随后续 Escapade 补丁或结构批次发布。103b 出门，不要求先消灭全树 SCC；后续 104 物理拆分必须沿用本契约门，不能扩大债务上限来换取通过。
- **遗留／下一步**：单一 SCC 与 59 条前向边是后续隔离候选清单，不在本切片机械清零。第 103 波当前转入 **103c durable data surface**：先盘点所有 JSON／NDJSON／sidecar 状态 owner 与生命周期，再逐 store 迁移或登记豁免。

### 103c · durable data surface

**范围**：

- 先列出全部 JSON／NDJSON／sidecar 状态文件及其 owner、schema、写入原语、损坏处理、容量、缓存、恢复与豁免原因。
- 基于既有 `atomicWriteJson()` 组合公共能力：schema 版本／sanitize、读取校验、`.corrupt` 隔离、容量淘汰、进程内缓存与显式失效；NDJSON append、session v2 与退出期同步写保持原有专用协议。
- 优先迁移 `context-calibration.json` 等确有重复生命周期逻辑的状态；每个 store 独立提交、独立故障注入、独立回退。迁移数量由清册决定，不以“凑够 7 个”为完成标准。

**出门判据**：清册 100% 覆盖；每个私役完成迁移或登记可审计豁免；已迁移项通过撕裂、非法 schema、容量、并发写、缓存失效与恢复测试；存量文件无需无理由重写。

#### 103c Release Brief（2026-08-31）

- **问题**：小型 JSON 状态虽已大多复用 `atomicWriteJson()`，读取校验、schema、损坏隔离、容量和进程缓存仍由各域自行拼装；`context-calibration.json` 还保留固定 `.tmp`、私有写链、私有 `.corrupt` 复制和双 bucket 淘汰逻辑，专用 append／session／外部权属协议也没有统一清册说明为何不迁。
- **非目标**：不把 NDJSON append、session v2、退出期同步 flush、gzip 快照或外部引擎文件强塞进通用 JSON 抽象；不改 API、默认配置、模型输入、校准算法和存量文件的可读形状；不因读取旧文件而无理由重写。
- **交付**：
  - `durable-state-inventory.js` 生成机器／人读清册 `docs/architecture/durable-state-inventory.{json,md}`，覆盖 **39 个 surface**：14 个共享生命周期、12 个专用协议、8 个外部权属、5 个可重建缓存；每项均列 owner、schema、写原语、损坏、容量、缓存、恢复和迁移／豁免裁决，并以源码 anchor 阻止清册静默失真。
  - 在基础模块 `01-config.js` 内新增隔离命名空间 `DurableJsonStore`：组合 schema admission、sanitize、`.corrupt` 字节级隔离、object／array 容量淘汰、串行原子写、进程缓存与显式失效；缺文件只返回默认值，不主动落盘。最初拆成新拼接模块的方案被 103b 门识别为新增 SCC 边后撤回，未放宽依赖 policy。
  - `context-calibration.json` 作为完整生命周期试点迁移：legacy 无 schema 文件继续可读，后续真实写入升级为 schema 1；两个 bucket 各保留 200 条，算法与 45d 原行为一致。生成 MCP 配置、`runtime.json` 和 `storage-trend.json` 的普通 JSON 写同步收编至 `atomicWriteJson()`。
  - 新增两件门：`durable-json-store.e2e.js` 注入撕裂、非法 schema、容量、并发写、缓存失效与恢复；`durable-state-inventory.static.e2e.js` 锁清册新鲜度、字段完整性、试点接线和固定 tmp 债务。manifest 保持 **24 模块**，依赖图 policy 不为本切片放宽。
- **证据**：两件 103c 新门、`context-compact-v2.e2e.js` 与 `autonomy-durability.e2e.js` 定向全绿；静态快通道 **43/43**；最终 `run-all.js --parallel 2` 为 **235 pass／0 fail／4 flaky**，另 7 个 live probe 按既有规则跳过，unit 14 组与 build freshness 全绿。4 件 flaky（`mission-result`／`autonomy-durability`／`interventions-c4`／`interventions-pool`）全部串行复跑通过，均非 103c 新门失败；依赖图 check、清册 check、路由／facts 新鲜度与 `git diff --check` 另行复核。
- **回退**：删除清册生成器／两份清册／两件新门与 `DurableJsonStore` 命名空间；把 context calibration 恢复为原私有缓存／写链／隔离／淘汰逻辑，普通 JSON 写点恢复原调用后重建 `server.js`、manifest、依赖图、路由清册和 facts。新 schema 字段为附加字段，旧实现会忽略；无需数据降级。
- **发布判断**：零用户可见行为，可随后续 Escapade 补丁或结构批次发布；103c 与第 103 波出门。下一入口为 **104**，沿用清册和依赖契约做职责搬迁，不在 104 混入上下文行为优化。

### 第 103 波总门与估时

- 串行顺序：103a → 103b → 103c；源码主树不并行改同一拼接链。
- 每切片一页 Release Brief，说明问题、非目标、证据、回退和是否可随 Escapade 补丁发布。
- 规划估时 **6–11 个工作日**。103b 全树物理隔离若超出此区间，按依赖图拆入 104，不通过压缩测试或扩大一次提交来追工期。

## 3. 第 104 波 · 内聚与上下文结构波（零行为）

依赖 103b 的依赖图与迁移模板、103c 的持久化清册。范围按独立切片推进：

1. 视觉管线移出 `04-permission-runtime.js`，桌面 shell／选择器／reveal 能力移出 `10-context-governance.js`。
2. `07-autonomy.js` 按记忆、使命驱动、资源租约／授权等职责拆分；只搬家与显式接线，不改 gate 语义。
3. 上下文压缩形成单一职责簇：预算判定、计划对象、摘要执行、重播种、校准／规则分别有明确 owner；forced-400、主路径、子代理共用同一 `CompactionPlan` 语义。
4. 模型窗口、超窗识别、摘要校验等规则外置为版本化数据文件；规则移动前后做逐项快照。
5. 压缩、持久化、权限与路由补单元级契约快照，纠正仅靠 E2E 锁行为的倒置。

**出门判据**：依赖图无新增隐式边；规则与提示词快照零漂移；主路径／forced-400／子代理输出等价；全量回归与构建门全绿。任何行为优化自动移出本波。

## 4. 第 105 波 · 上下文缓存与摘要保真行为波

本波的每个项目都是独立实验：默认关闭或受控 canary，逐项取得 22 号方案 A／B／C 类证据，未通过即保持现状。一次波次不要求全部项目默认启用。

### 4.1 按需回载与状态外置

- 提供有权限、大小上限、每回合配额和稳定失败语义的 `observation_recall(rawRef)`，作为 #7 预取前的真实生产消费者；rawRef 必须跨 compact／重启可解析并受 GC／授权约束。
- 试验 `session-notes.md` 状态外置，只保存决定、关键文件与进行中事项；摘要保留叙事职责，不取代权威任务状态。
- 摘要实体校验对路径、版本、数字与显式约束做确定性抽检；失败时给出缺失清单，最多触发一次定向修补，不进入无界重试。
- 估算因子按 CJK／JSON／代码分桶；样本不足回退保守默认，估算与真实 usage 分列。

### 4.2 小窗口单发优先

- 摘要预算改为 `window - reserve`；reserve 由 system、summary prompt、预期输出和校准误差上界组成。估算允许时先单发，只有可识别的上下文超窗 400 才自动降级到现有 map-reduce。
- 最近原文尾部使用“完整 user 回合 + token 上限”双约束；配对与 user 边界不变。
- 单发估算上限提供 16K／32K／64K 三档，默认 32K；可按引擎／provider／模型覆盖并钳位 `[8192, 131072]`。不提供无限档，不自动改远程超时。
- UI 必须说明 32K 的现有延迟证据与 64K 的超时风险；配置、sanitize、提示词快照和 E2E 同步锁定。

### 4.3 map-reduce 跨块保真

按性价比依次验证：确定性全局事实表（优先）→ ≤4 块顺序 refine（任一步失败整条回退并行 map）→ >4 块全局 user 大纲 → 实体缺口定向修补 → 可选块间重叠。核心指标为跨块约束覆盖正确率，已被后文推翻的决定不得并列保留为有效约束。

**第 105 波总门**：固定“32K 窗口 × 20–28K 高密度约束历史”夹具，配对比较当前并行 map、单发优先、refine、refine+事实表；报告实体保留率、跨块覆盖正确率、调用次数、总费用、墙钟和降级成功率。额外失败调用计入成本；没有相对当前实现的净收益就不启用。

## 5. 第 106 波 · Agent SoC 证据收敛

在 103 的结构地基与 104／105 的上下文证据上，按 [22 号方案](22-agent-soc-microarchitecture.md) 继续推进：

- #13a／13a-t 预算保护与长命令时间轴；
- #1 Ruyi 自身稳定前缀／schema 布局；
- #2a 受限执行结果缓存；
- #3 或 #9 的一个限定场景；
- #7 只有在 105 的按需回载成为可用消费者并出现耗时证据后才启动。

各项仍独立开关、先单轴后组合；第 105 波通过不等于上述项目自动准入。若 #13a 的风险与热点要求提前，可在 103 出门后单独申请插入，但必须保持波次唯一并成文重排，不能静默并行抢号。

## 6. 第 107 波 · Pretender 出门准备与批准点

- 演练 Escapade 通用六类发布门与 22 号方案 Release Brief；冻结实际默认启用项、适用任务族、收益阈值、未知场景回退与配置迁移。
- 版本归属由实际行为决定：103／104 可随 `2.6.x` 补丁或后续 Escapade 版本交付；105／106 只要改变默认行为或 UI，就走功能版本评估。不得在规划阶段预写未发布版本号。
- Pretender 3.0 发布批准与旧壳层 P4 恢复是两个决定。恢复默认切壳仍需正式人因与切换前置，不能用结构重构或引擎基准替代。

## 7. 独立候选：音频转文字与本地 ASR

ASR 是功能线，不并入第 103–107 波的已冻结范围，也不是 Pretender 发布前置。若单独立项，建议只要求 **103a 路由 descriptor 出门**，避免新增第二套路由／鉴权事实源。

冻结候选边界：

- 复用现有 providers 注册表，以模型 `caps: ['asr']` 标能力；`asrProviderId`／`asrModel` 独立选择，主模型与 ASR 选择器不共享状态。可选 `audioBaseUrl`，本地 provider 可选 `localCommand`；没有该字段只探活、绝不拉起。
- 如意侧新增 token 级 `POST /api/audio/transcribe`，入站 raw body、出站 OpenAI-compatible `/v1/audio/transcriptions`；附件、原生工具、composer 三入口读同一选择事实源。
- 本地 Windows 候选为 Qwen3-ASR-0.6B + OpenAI-compatible shim：只绑 `127.0.0.1`，环境变量传端口／模型目录，按需拉起、随主进程回收、模型懒加载与空闲卸载；模型与 Python 依赖不打入离线包。
- 转写文本标注不可信来源；调用计入 `kind:'aux', note:'asr'`，本地缺 usage 时标 `estimated:true`；不做实时流式、说话人分离或内置 2GB 权重分发。

立项时必须另写功能 Release Brief、协议威胁模型、云端／离线双路径实机验收与 UI／a11y 范围；本文只保存候选接口与依赖关系，不构成排期承诺。

## 8. 风险、停止条件与恢复

| 风险 | 控制与停止条件 |
|---|---|
| 路由表化改变匹配优先级 | 旧路由逐端点快照；精确／前缀／正则优先级显式；未知路由 deny-by-default；任一 auth 降级立即回退该域 |
| 依赖显式化触发循环或初始化顺序漂移 | 先画图、后改边；按强连通分量分批；启动副作用与声明顺序单独测试；不能证明等价的簇留在清单中 |
| durableStore 抽象吞掉各 store 的真实差异 | 公共层只提供可组合原语；append-only、同步退出写、session v2 保留专用协议；迁移前后故障注入 |
| 默认关项目被误称为收益 | 报告分清“代码存在／实验通过／限定启用／默认启用”；总费用计失败、摘要、重试与后台工作 |
| 103–107 膨胀为版本大重写 | 每波范围冻结；未过门不进入下一波；不为凑编号、迁移数或 15 项清单扩大范围 |

任一切片失败只回退该切片；已独立出门的前序切片不连带回滚。所有恢复步骤必须在 Release Brief 中可执行，而不是只写“可回退”。
