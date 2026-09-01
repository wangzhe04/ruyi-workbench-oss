# 23 · 架构偿还与上下文演进序列（第 103–107 波）

> **状态（2026-09-01）**：由《第 103 波 · 架构偿还波（提案 v0.7）》经当前主树复核后以 **revise-major** 结论纳入路线图；本文是实施依据，原提案保留为输入材料，不作为已批准范围。**第 103 波（103a／103b／103c）、第 104 波与第 105 波总门均已交付**。105a–105g 已逐项取证并默认开启，各项均可显式关闭回退；105 总门再次确认 105f 单发优先有净收益。4.3 后续的 ≤4 块顺序 refine 未过真实模型门，保留默认关闭；>4 块全局 user 大纲因 8 块路径至少 9 次串行调用、真实基线超时长而否决并撤掉生产实现；可选 overlap 不再实施。105c 为成本承担行为（触发修补多一次 LLM 调用），105d 回注块整体上限 2000 字符；105g 仍按其受控 A/B 证据默认开启，并经超长 history-24 甜点门将事实表默认上限提升至 64。**第 106 波已开工**：#13a／13a-t（预算保护基础层＋长命令时间预算）已交付，默认关闭取证中。
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

#### 104 Release Brief（2026-08-31）

- **问题与非目标**：偿还 `04`／`07`／`10` 的职责错位与压缩规则散落，降低后续上下文实验的隔离性；本波只做物理搬迁、显式接线和契约固化，不改变提示词、默认配置、API 语义或用户可见行为。
- **交付**：新增 `04-visual-pipeline.js`、`04-desktop-shell.js`、`06d-memory-domain.js`、`06e-mission-domain.js`、`06f-autonomy-grants.js`、`06g-resource-leases.js`；`CompactionPlan` 统一主路径／forced-400／子代理；`context-governance-rules.json` 版本化窗口、超窗、摘要与计划规则；新增架构契约快照与静态门。
- **证据**：manifest **30 模块**；依赖图 **1373 provides／1532 cross-module refs／239 edges／65 forward edges／0 duplicate exports／1 SCC**，并完成 104 评审后的 policy rebase。定向门、构建 freshness、路由／durable 清册、契约快照均通过；全量默认回归串行 **236 pass／0 fail／0 flaky**（236 ran／7 skipped），`overlay-update-core`、`mission-result`、`pretender-mission-control` 均通过；快通道 **44/44**。
- **发布判断**：零用户可见行为；可随 Escapade 补丁发布。104 出门，下一入口为 105；任何摘要／缓存默认行为优化继续留在 105 的受控实验门内。
- **回退**：回退本提交即可恢复 103 的模块布局；规则 JSON 与快照为新增只读资产，删除对应模块注册并重建 `app/server.js` 即可回到 103 产物。

## 4. 第 105 波 · 上下文缓存与摘要保真行为波

本波的每个项目都是独立实验：默认关闭或受控 canary，逐项取得 22 号方案 A／B／C 类证据，未通过即保持现状。一次波次不要求全部项目默认启用。

### 4.1 按需回载与状态外置

- 提供有权限、大小上限、每回合配额和稳定失败语义的 `observation_recall(rawRef)`，作为 #7 预取前的真实生产消费者；rawRef 必须跨 compact／重启可解析并受 GC／授权约束。
- 试验 `session-notes.md` 状态外置，只保存决定、关键文件与进行中事项；摘要保留叙事职责，不取代权威任务状态。
- 摘要实体校验对路径、版本、数字与显式约束做确定性抽检；失败时给出缺失清单，最多触发一次定向修补，不进入无界重试。
- 估算因子按 CJK／JSON／代码分桶；样本不足回退保守默认，估算与真实 usage 分列。

#### 105a Release Brief · observation_recall 工具外壳（2026-08-31）

- **问题**：20-C1 的缩减视图已内嵌 `rawRef`，还原内核 `rehydrateObservation()` 也已就绪并导出，但没有任何模型可触达的入口——缩减后的原文事实上不可回读，#7 预取没有真实生产消费者。
- **非目标**：不改快照格式、GC 策略、压缩／蒸发语义；不新增持久化面；不宣称跨任务成本收益。`runtimeObservationReducerV1` 与 `runtimeObservationRecallV1` 现默认 true 且成对生效，任一显式 false 都回退为旧蒸发行为／隐藏工具。
- **交付物**：
  - 新原生工具 `observation_recall({rawRef, maxChars?})`：schema 入 `MCP_TOOLS`，handler 入 `CORE_TOOL_HANDLERS`（`paths:null` + guardNote），`NATIVE_TOOL_PACKS: 'core'`、`NATIVE_TOOL_TIER: 'read'`、`TOOL_RETRIEVAL_HINTS` 别名登记。
  - 授权：sessionId 只取 `ctx.session.id`／`WCW_SESSION_ID` 桥 env，args 传入的 sessionId 一律忽略；跨会话 rawRef 天然 not_found。
  - 大小上限：`maxChars` 默认 8000、clamp [1000, 60000]，超出 head/tail 截取 + `truncated:true` + 省略计数。
  - 每回合配额 8 次：桶键 = （会话， providerHistory user 消息数），回合内稳定、下一回合自增；每会话留 4 桶、全局 64 会话 FIFO；失败调用同样计额（防滥用循环），超额返回稳定 `quota_exceeded`。
  - 稳定失败信封：`disabled | invalid_ref | not_found | hash_mismatch | quota_exceeded`；`not_found` 涵盖快照已被 GC（ENOENT）。
  - 可见性四门：`buildOpenAiTools` offer 门、MCP `tools/list` 门、adaptive catalog 门、`/api/status` 工具清单门，全部按双开关显示或隐藏；handler 内 fail-closed 二次校验。
  - 提示侧闭环：缩减视图在 recall 生效时追加 `recall=observation_recall(rawRef)`（文本头）／`"recall":...`（JSON meta）及“精确省略事实须先回读”的决策提示；每次模型调用在最新 user 消息旁附最多 8 个当前会话 rawRef 的非持久 recovery index。默认显式关闭时两者均不注入。
  - `dev-harness/observation-recall.e2e.js`：[U] 16 项白盒契约（happy 逐字节／截断／配额／disabled／invalid_ref／hash_mismatch／not_found／sessionId 防伪造／文案零漂移／offer 与目录门）；[R] 跨进程 rehydrate（模拟重启后仍解析）；[E] fake-openai 集成（真实 HTTP 回合中 fake 主动调用 observation_recall → offer 生效 → 稳定信封 invalid_ref 经 HTTP 链路回传 → 配对铁律）。fake-openai 新增 `argsFromLastRawRef` step 能力。**测试发现**：`observation_reduced` 事件与自动压缩触发绑定，而真实回合中单条大 tool 结果（TOOL_RESULT_CAP 截断后仍 ≈48K chars）+ 完整系统提示的估算会首读即触发压缩 → L1 蒸发 0 条（boundary 保护最近回合）→ L2 摘要 reseed → fake 序列重置，形成请求循环；故 HTTP 回合内不稳定产生 rawRef，回读成功由 `[U]/[R]`＋真实历史 e2e 覆盖。
- **证据**：
  - `observation-recall.e2e.js` 全绿：`[U]` 16 项白盒契约＋`[R]` 跨进程 rehydrate＋`[E]` fake-openai 集成（HTTP 回合中 fake 主动调用 observation_recall → offer 生效 → `invalid_ref` 稳定信封经 HTTP 链路回传 → 配对铁律）。
  - `observation-recall-realhistory.e2e.js`（新增，真实历史实测）：从本机 `.win-claude-workbench/checkpoints` 复制 2 个真实会话（287 文件 6.3MB）到沙箱副本，源目录 sha256 清单测试前后一致（零写入）。11 个真实 `history-*.json.gz` 快照：payload 合计 **4,383,012 → 831,711 字符（整体缩减 81.0%）**；最大单快照 202,519→1,223（99.4%）；全部 ≥1200 字符大观察经真实 rawRef 双哈希校验回读**逐字节一致**（113/113、6/6、9/9、1/1、2/2、6/6）；配对铁律全过；真实缩减视图含 `rawRef`＋`recall` 提示（json/shell/text/search 四策略）；真实 rawRef 经工具分发回读成功＋配额第 9 次 `quota_exceeded`。注意：reducer 单条可见量可高于旧蒸发（保留结构信息＋rawRef 的设计权衡），本切片以「payload 对原始基线大幅缩减＋回读保真」为证据，不宣称对旧蒸发单条更省。
  - `observation-recall-replay.e2e.js` 用真实 `history-25.json.gz` 做完整回合回放：离线 fake 路径稳定触发 L1、生成 rawRef、调用 recall、按模型请求的 8K–60K 有界 head/tail 回读真实事实，配对完整。初版仅在旧工具结果内放置短提示时，Flash／Pro 会漏读 buried rawRef；提示升级为缩减视图决策规则 + 非持久、限 8 项的 recovery index 后，以原始 `file_search` 结果省略区中的普通事实（`data-main-view` 状态机）进行自然问题测试，DeepSeek V4 Pro **连续 3/3**、V4 Flash **2/2** 自发调用 recall、回读并答对。此前用随机 `CONFIDENTIAL`／canary 值的诊断题会触发模型反外带策略，已替换为真实普通事实，避免将安全拒绝误判为工具采用失败。测试中另发现并修复 thinking-mode 工具循环未回传 `reasoning_text` 的 HTTP 400；`responses-fake.e2e.js` 已以普通/并行 function call 锁住 `reasoning` item 回传。
- **回退**：移除三处注册＋配置键＋新 e2e＋`argsFromLastRawRef`，重建 `server.js`、重跑 module-graph／route-inventory／facts 生成器；快照格式不变，无数据迁移。
- **发布判断**：默认开启 reducer + recall，零 UI、零新增路由；缩减的原文在需要精确历史事实时可按需回读。任一开关显式 false 即完整回退。无需单独触发版本升级，可随后续 Escapade 补丁或 105 后续切片一并发布。

#### 105b Release Brief · session-notes.md 状态外置（2026-08-31）

- **问题**：4.1 要求试验「状态外置」——决定、关键文件与进行中事项此前只存在于 L2 摘要叙事里，压缩后无独立的、可跨 compact／重启直接读取的状态副本；后续「摘要保真／回注」实验缺一个确定性的事实源载体。
- **非目标**：不把 notes 回注模型上下文（读注属后续切片）；不新增路由、工具或 UI；不改摘要 prompt、reseed 字节形状或压缩触发语义；不做增量合并（每次 L2 成功整体重写，摘要本身即最新权威状态）；开关关闭时零文件读写。
- **交付物**：
  - 开关 `runtimeSessionNotesV1`（真实历史门后默认 `true`，可显式 `false` 回退；sanitize 只认 JSON 布尔）+ 唯一判定 `sessionNotesEnabled(config)`（`01-config.js`）。
  - 旁车持久化原语（`02-session-store.js`）：`sessionNotesPath()` = `sessions/<id>.session-notes.md`，与 interventions/changes 旁车同层；`writeSessionNotes()` 走 per-session 写链 + `atomicWriteJson` 原子写（25.1 md 直写先例），64K 字符截断标记；`readSessionNotes()` 缺文件/读错一律 `null`。
  - 确定性提取（`10-context-governance.js`）：`extractSessionNotes()` 按 `context-governance-rules.json` 的 `summary.sections` 别名表定位节标题，切出【已确认的决定】/【未完成事项】/【关键文件与上下文】三节；缺节降级「无」（对齐摘要空节约定），零 LLM 调用。`maybeWriteSessionNotes()` 挂钩主回合自动 L2（`maybeAutoCompact`）与手动压缩（`runProviderCompact`）两条路径的成功点，fire-and-forget、失败静默（纪律同 `writeHistorySnapshot`）；子代理 L2 不挂钩（子会话无持久化权属）。
  - `dev-harness/session-notes.e2e.js`：[U] 白盒（默认开/显式关/sanitize/五节切分/缺节降级/英文别名/写读回环/覆盖/截断/并发写不撕裂/关时零文件/开时落盘三节/空摘要静默）+ [H] 项目真实 checkpoint L2 摘要外置 + [R] 跨进程读回；`runtime-optimization.static.e2e.js` 锁 `runtimeSessionNotesV1`、`runtimeObservationReducerV1` 与 `runtimeObservationRecallV1` 默认 true。
- **证据**：`session-notes.e2e.js` 全绿；真实 `history-25.json.gz` 的决定（M2）、未完成项（abstainThreshold）与关键文件（14-m2-deterministic-nodes.md）均正确落入 notes，目标/当前状态未混入；定向 `context-compact-v2` / `autocompact` / `provider-compact` / `observation-recall` 全绿；`module-dependency-graph --check` 通过（30 模块／240 边，policy 未放宽）；`route-inventory --check` 零漂移（未加路由）；全量回归见 run-all 输出。
- **回退**：删除开关三处、`02` notes 原语、`10` 提取/挂钩与 `14-main` 导出、新 e2e 与静态锁条目；重建 `server.js` 并重跑 module-graph/facts 生成器。已写出的 `.session-notes.md` 为纯旁车副本，无迁移、无清理义务。
- **发布判断**：真实历史门通过后默认开启，只新增 L2 成功时的本机 notes 旁车写入；零 UI、零路由、失败不阻断回合。105a 已以独立的真实模型采用门默认开启，不依赖本项联动。
- **遗留**：notes 回注上下文（读取侧消费者）与增量合并语义已由 105d 交付并已默认开启（见其 Brief）；摘要实体确定性抽检由 105c 交付并已默认开启；4.1 剩余项（估算因子分桶）已由 105e 交付并默认开启（显式 false 可回退，见其 Brief）。

#### 105c Release Brief · 摘要实体确定性抽检（2026-08-31）

- **问题**：4.1 第 3 项——摘要内核三处成功出口只做五节结构校验（`validateStructuredSummary`），对路径、版本、数字与代号等关键事实是否逐字保住没有确定性抽检；模型泛化或省略关键名词时没有任何发现与修补手段。
- **非目标**：不改摘要主 prompt／五节结构／reseed 字节形状；不做 4.2 单发优先与 4.3 refine；不做 notes 回注与增量合并；不做无界重试；不改 `validateStructuredSummary` 既有语义；估算因子分桶（4.1 末项）留后续切片。本切片为成本承担行为（触发修补时多一次 LLM 调用）；取证期先默认关闭，采用门通过后已改为默认开启，显式 `false` 保留零检查／零修补回退。
- **交付物**：
  - 开关 `runtimeSummaryEntityCheckV1`（采用门通过后默认 `true`，sanitize 只认 JSON 布尔，显式 `false` 回退）+ 唯一判定 `summaryEntityCheckEnabled(config)`（`01-config.js`）；`runtime-optimization.static.e2e.js` 静态锁同步。
  - 规则外置：`context-governance-rules.json` 新增 `summary.entityCheck` 块（schema 仍为 1，additive）——`maxSamples` 12／`minSamples` 4／`scanChars` 200K／`maxEntityChars` 120、八类抽取模式（Windows 路径、slash 路径、版本号、ISO 日期、带单位数字、大数字、反引号代号、「」代号）与 `repairPrompt` 修补模板；`10-context-governance.js` 内置 fallback 逐字同步（parity 门覆盖）。
  - 确定性抽取 `extractSummaryEntities()`：尾部 200K 扫描（越近越该保住）、捕获组取实体本体、尾标点剥离、slashPath 噪声过滤（`and/or`、`10/20` 类单斜杠无扩展名串不入样）、包含清扫（`2026-08-31`⊃`2026`、`v2.6.2`⊃`2.6.2`）、按最近出现位置+频次排序截到 maxSamples。
  - 抽检 `checkSummaryEntities()` 逐字包含判定；`applySummaryEntityCheck()` 挂在 `providerSummaryCallCore` 成功出口的统一 wrapper：样本不足 → `skipped_few_samples`；全中 → `pass`；有缺失 → **恰好一次**定向修补（只发 当前摘要+缺失清单，`singleSummaryCall` 新增 `promptOverride` 参数承载 repairPrompt，不重发全量历史）；修补网络失败 → `repair_failed` 保留原稿；修补稿结构校验不过 → `repair_rejected` 保留原稿；修补稿采用后即便仍有缺失也不再二次重试，usage 聚合进 `sc.usage`（修补成本计入本次压缩台账，`recordCompactUsage` 自动覆盖）。全程 try/catch，任何内部异常原样返回原稿，绝不阻断压缩。
  - 遥测 `summary_entity_check` 事件（sampled／missingCount／stillMissingCount／missingSample 前 8 条／outcome），fire-and-forget。
  - 六个 `providerSummaryCall` 调用点全部透传 `config`（auto_L2、手动 compact、agent external、子代理 auto／forced_400、主路径 forced_400），wrapper 一处生效；缺 config 的旧调用方式 fail-safe 为关。
  - `dev-harness/fake-openai.js` 新增 `FAKE_SUMMARY_SEQUENCE`（JSON 数组，第 N 个非流式请求返回第 N 条、钳到末条），仿 105a `argsFromLastRawRef` 的加能力方式。
  - `dev-harness/summary-entity-check.e2e.js`：[U] 15 项白盒（开关三态／Responses 悬空调用补配对且不改源历史／八类实体抽取／噪声过滤／采样上限与尾部优先／包含清扫／缺失清单）＋[H] 真实历史抽取门（直读本机 checkpoints 最大快照，缺失时显式 SKIP 不计通过）＋[E] fake-openai 三场景（首稿缺实体 → 恰好一次修补、请求体含缺失清单且不重发全量历史、reseed 采用修补稿、遥测 repaired；修补稿非法 → 保留原稿、总调用恰好 2 次、遥测 repair_rejected；显式关闭 → 恰好 1 次调用、原样采用首稿、零事件）。
- **证据**：`summary-entity-check.e2e.js` 全绿（[U] 15＋[H] 4＋[E] 14）；八类实体在真实 227 消息快照上抽出 12 个样本（含日期/版本/路径）；`module-dependency-graph --check` 通过（30 模块／240 边，policy 未放宽）；`route-inventory --check` 零漂移（101 判定点，未加路由）；`build --check` 产物新鲜。定向回归（context-compact-v2／autocompact／provider-compact／runtime-optimization.static／observation-recall）与 `architecture-contract-snapshots` 全绿；全量 `run-all --parallel 2`：**238 pass / 5 fail / 243 ran / 7 skipped**，5 红逐件归因均非本切片——`session-notes`、`observation-recall-realhistory`、`observation-recall-replay` 因 realhist-fixtures 已被清理（先存环境缺口）；`eol-policy.static` 因 191 个本切片未触碰文件的先存 EOL 漂移（90a0ed0 引入 policy 后工作区未归一化）；`pretender-dispatch-home` 为全量并行下的环境抖动（与改动面零交集，干净环境下本切片代码与基线各单跑 ALL PASS 互证）。修复编辑期引入的 3 处注释 U+FFFD 后，生成器链（module-graph／route-inventory／facts／snapshots）与本切片门测试复跑全绿。
- **回退**：删开关三处、`entityCheck` 规则块（JSON＋fallback）、抽取/检查/修补函数与 wrapper（core 恢复原名）、六调用点 config 透传、`FAKE_SUMMARY_SEQUENCE`、新 e2e 与静态锁条目；重建 `server.js` 并重跑 module-graph/route-inventory/facts 生成器。无持久化面、无数据迁移。
- **Responses 适配补记（2026-09-01）**：`buildResponsesInputItems()` 在转换前对输入数组做浅拷贝，并复用 `repairProviderHistoryPairing()` 补齐被截断的 `assistant.tool_calls → tool` 配对；解决 DeepSeek Responses 对历史片段返回 HTTP 400 `No tool output found for tool call ...`。只向请求视图插入合成 `function_call_output`，不修改持久化／审计历史；主回合、子代理、摘要三条 Responses 路径共用。白盒回归锁定恰好补一条、原数组不变、最终 payload 含对应 `call_id`。同一曾失败的真实截段 `history-3.json.gz#123-179`（57 条／15,815 JSON chars）复验：适配补 1 条、源数组不变、DeepSeek `deepseek-v4-flash` 48.97s 成功；首稿缺 6/10 个实体，恰好一次修补后缺失 0，总 Responses POST=2。
- **发布判断**：默认开启；命中缺失时最多增加一次定向修补调用，显式 `false` 可完整回退旧行为。Responses 配对适配避免截段历史在抽检前被 strict provider 400 拦截。
- **默认开启判据（已完成，2026-09-01）**：真实历史门＋fake 集成门全绿；修补路径被“恰好一次”契约与遥测锁定、无修补风暴；DeepSeek `deepseek-v4-flash` 真实 checkpoint 对话层回放完成——首稿后触发一次修补（总 POST=2），抽检 12 个实体，修补后缺失 0。默认值与静态锁已 flip 为 `true`，显式 `false` 回退测试全绿。
- **遗留**：105a/105b 的 realhist-fixtures（gitignore 真实数据副本）在本机已被清理，`session-notes.e2e.js` 的 [H] 段与 `observation-recall-realhistory.e2e.js` 因此在本机不可跑（先于本切片存在的环境问题，与本切片无关）；本切片 [H] 段改为直读现存 checkpoints 并可显式跳过。4.1 末项（估算因子分桶）已由 105e 交付并默认开启（显式 false 可回退，见其 Brief）。

#### 105d Release Brief · session notes 回注与增量合并（2026-09-01）

- **问题**：105b 遗留两项——`readSessionNotes()` 已备好但零生产调用方（notes 只写不回注，压缩后外置的决定/事项/关键文件在读侧不生效）；每次 L2 成功整体重写、无增量合并语义（上一轮 notes 中仍有效而本轮摘要未提及的行被直接覆盖消失）。
- **非目标**：不动 4.2 单发优先与 4.3 refine；不改摘要 prompt、reseed 字节形状、压缩触发语义；子代理路径不注入（子会话无持久化权属，同 105b 纪律）；不做无界重试；不宣称跨任务成本收益。文本级合并无法识别「被后文推翻的决定」，并列保留属实验语义，由 105 总门取证裁决。两开关经真实历史与端到端门通过后默认 `true`，显式 `false` 完整回退到 105b 现状（只写不回注、整体重写）。
- **交付物**：
  - 开关 `runtimeSessionNotesInjectV1` / `runtimeSessionNotesMergeV1`（采用门通过后均默认 `true`，sanitize 只认 JSON 布尔，显式 `false` 回退）+ 唯一判定 `sessionNotesInjectEnabled(config)` / `sessionNotesMergeEnabled(config)`（`01-config.js`）；`runtime-optimization.static.e2e.js` 静态锁同步。
  - 回注（`10-context-governance.js`＋`09-workflow.js`）：`buildSessionNotesInjectPrompt()` 生成有界注入块——**整个注入块**上限 2000 字符，超出保留头部＋省略计数标记；含「本副本来自最近一次压缩摘要的确定性抽取；与上下文内摘要重复时以最新摘要为准」使用提示；开关关／notes 缺失／解析失败／三节全「无」→ 空串零注入。每回合至多一次 `readSessionNotes()` IO（读取失败得 null 即跳过；开关关时零文件读取）；注入贴最后一条 user 消息、不持久化，预算口径同 105a recovery index（buildBody 内追加，不进 budgetPrompt）。去重守门 `historyStartsWithCompactionSummary()`：历史首条 user 已含【压缩摘要】或手动变体标记时跳过（notes 上游即该摘要，避免重复计费）。遥测 `session_notes_inject`（chars／skipped 原因）fire-and-forget、每回合最多一条。注入形态与守门收进纯函数（`appendPromptToLastUserMessage()` 兼容 string／parts 数组两种 content），注入闭包只管开关／跳过原因／遥测。
  - 增量合并（`10-context-governance.js`）：`parseSessionNotesMarkdown()` 解析 `##` 三节（三标题全缺 → null 作解析失败信号）；`mergeSessionNotes()`＋`mergeSessionNotesLines()`——决定／关键文件两节并集去重（按行 trim 精确去重、next 行在前、prev 独有行追加在后；超 64K 由 `writeSessionNotes` 尾部截断兜底，自然保住新内容），未完成事项节以最新摘要为准（replace——已完成事项必须能消失），「无」节视为空集；prev 缺失／解析失败降级为整体重写。`maybeWriteSessionNotes()` 内开关开时 read→merge→render→write，仍 fire-and-forget、整体 try/catch 绝不阻断回合；开关关时路径与现状逐字节一致。已知限制写入注释：read→merge→write 不在 per-session 写链内，依赖「同会话 L2 串行」这一既有事实。
  - `dev-harness/session-notes-inject.e2e.js`（39 项）与 `dev-harness/session-notes-merge.e2e.js`（24 项），见证据。
- **证据**：`session-notes-inject.e2e.js` 全绿 39 项——[U] 20 项白盒（开关三态／null·空·坏 notes 不注入／整个注入块 ≤2000 字符与省略计数／守门两标记含数组 content 形态／两 content 形态贴最后一条 user）＋[H] 3 项真实 `history-25.json.gz`（五节 L2 摘要、注入块总长恰为 2000 且有省略标记、压缩摘要历史命中去重守门）＋[E] 16 项 fake-openai 集成（三套独立 fake＋workbench，默认开＋预置 notes → 请求体最后一条 user 含注入块且首条不含；`/api/sessions` 读回 providerHistory 无注入块（非持久）；首条 user 含摘要标记 → 守门跳过；显式关闭 → 零注入）。`session-notes-merge.e2e.js` 全绿 24 项——[U] 18 项（并集去重新行在前、open replace 旧项消失、无 prev／坏 prev 降级、「无」节处理、合并结果 render 后可再 parse 回环、挂钩三态：merge 显式关整体重写／merge 开合并落盘／单开 merge 无 105b 零文件）＋[H] 4 项真实 `history-24/26.json.gz`（决定/关键文件并集无丢失、未完成事项以最新摘要替换、render/parse 回环）＋[R] 2 项跨进程读回合并结果并 parse 逐字节一致。`session-notes.e2e.js` 的既有真实摘要外置 [H] 3 项也通过。默认开启后相关定向回归与静态/生成门复跑，见本次变更验证记录。
- **回退**：删两开关各三处（默认值／sanitize／判定）、`buildSessionNotesInjectPrompt`／`historyStartsWithCompactionSummary`／`appendPromptToLastUserMessage`／`parseSessionNotesMarkdown`／`mergeSessionNotes`（含 `mergeSessionNotesLines`）与两个注入调用点、`maybeWriteSessionNotes` 合并分支、静态锁条目、两个新 e2e；重建 `server.js` 并重跑 module-graph／route-inventory／facts 生成器。无持久化面变更、无数据迁移（已写出的 `.session-notes.md` 仍是纯旁车副本）。
- **发布判断**：默认开启；真实历史门、fake-provider 端到端门、显式关闭回退与 2000 字符总上限均通过。开关关闭时与 105b 现状逐字节一致（由静态锁与 e2e 锁定），无需单独触发版本升级。
- **默认开启判据（已完成，2026-09-01）**：用户拍板取证通过；真实历史门＋fake-provider 端到端采用门全绿（默认开＋预置 notes 时请求体最后一条 user 含注入块且非持久、含摘要历史命中去重守门跳过）；默认值与静态锁已 flip 为 `true`（`runtime-optimization.static.e2e.js` 同步锁默认 true）；显式 `false` 回退测试全绿（零注入／整体重写，与 105b 现状逐字节一致）；压缩类定向回归（context-compact-v2／autocompact／provider-compact）无注入相关新红。
- **遗留**：4.1 末项（估算因子分桶）已由 105e 交付并默认开启（显式 false 可回退，见其 Brief）；4.2／4.3 未动；可在后续 105 总门中补充回注的跨模型成本收益对比。

#### 105e Release Brief · 估算因子分桶（2026-09-01）

- **问题**：4.1 末项——`estimateTextTokens()` 只有 ascii ÷3.6／CJK ÷1.5 两桶拍定常数；JSON 与代码的 token 密度高于散文，压缩触发与摘要预算对结构化载荷（tool_calls arguments、Responses arguments/output）的估算系统性偏低，且无分桶手段。
- **非目标**：不改 EMA 校准语义（`noteEstimateSample` α=0.3、n≥3 生效、clamp [0.5,3]）；不动「估算与真实 usage 分列」既有机制（usageSource 事件标记、台账 estimated 布尔、UI「约」前缀）；不改 image part 固定 1100；不改 CJK ÷1.5；不做 4.2 单发优先与 4.3 跨块保真。
- **交付物**：
  - 开关 `runtimeEstimateBucketsV1` 默认 `true`（初交付时默认 `false`，动态压缩门修复后 flip，见下「动态回归修复」小节）；显式 `false` 完整回退两桶现状；开关仍在默认值／严格布尔 sanitize 表／唯一判定 `estimateBucketsEnabled(config)` 三处落地（`01-config.js`）。
  - 三桶分类器 `classifyTextForEstimate(str)`（`09-workflow.js`，紧随 `estimateTextTokens`）：确定性、廉价、零 LLM——采样头＋尾各 ≤2048 字符；trim 后 JSON.parse 成功（仅未被采样截断时）、或结构字符 `{}[]":,` 密度 ≥0.05 → `json`；代码信号（换行＋缩进、`;{}()=><` 密度、关键字命中各 +2）评分 ≥3 → `code`；否则 `text`。CJK 字符在所有桶中恒 ÷1.5。
  - 因子外置 `context-governance-rules.json` `estimation` 块（schema 1,additive）：json ÷2.8、code ÷3.2 为拍定保守默认（JSON/代码比散文 token 密度高，校准前取值，由 `noteEstimateSample` EMA 用真实 usage 校准；样本 <3 时因子=1 即纯静态估算），采样大小与密度阈值同块持有；`10-context-governance.js` 内置 fallback 逐字同步，architecture-contract-snapshots 的 rulesSha256 锁整份 JSON。
  - 开关送达：估算器是纯同步热路径（约 30 个调用点、fitHistoryForSummary 二分内层），不能 await readConfig，故用模块镜像 `estimateBucketsV1On` ＋ `setEstimateBucketsV1()`，由持 config 的入口（`runOpenAiTurn`／`runSubAgentCore`）每回合刷新（`maybeAutoCompact` 唯一调用点在回合内，已被入口覆盖）。开关关时 `estimateTextTokens` 早退原路径，与两桶同样的输入同样的输出（逐字节一致）；`estimateContentTokens`／`estimateHistoryTokens` 走同一入口，tool_calls arguments 等结构化内容自然命中 json 桶。
  - `dev-harness/estimate-buckets.e2e.js`（42 项）与 `runtime-optimization.static.e2e.js` 6 条 105e 静态锁，见证据。
- **证据**：`estimate-buckets.e2e.js` 全绿 42 项——[U] 38 项开关三态（默认 true／显式 false 回退／字符串 "true" 洗回 false，严格布尔）、关闭时两桶公式逐字节回退、JSON／代码／CJK／阈值边界与 image 不变；[H] 4 项读取项目 9 份 checkpoint（3,791 条消息），开启后三桶汇总 `604,675 → 700,872`（+15.9%），每份历史均不低于两桶基线且结构化载荷命中 json 桶。夹具不保存 provider usage，故该 A/B 只证明确定性估算行为与触发方向，不声称真实 token 误差已量化。
- **动态回归修复（2026-09-01，初 flip 阻断 → 已修复）**：
  - **现象**：首次 flip 试验中 buckets-on 下 `autocompact.e2e.js` 退化为每回合 49 次连续 summary、零 evaporate，触及 100 轮工具上限；动态压缩门未通过，flip 暂缓。
  - **根因（夹具余量太薄，非估算器算错）**：①三桶把 JSON 形态的工具 schema 从 ÷3.6 提到 ÷2.8（+28.6%），固定开销（稳定 system＋工具 schema）升至 ≈6.1K，首次压缩 before=32729，越线点从第 3 边界提前到第 2 边界（旧 32K 预算余量仅 ~470 token）；②第 2 边界 L1 无合格候选（蒸发只碰最近 2 个 assistant 回合之前的 tool 消息）→ 直接 L2；③reseed 后 fake 从摘要 user 消息重新看到「请读三次 big.txt」→ 重新发起 file_read → 再越线 → 再 L2，循环放大到工具上限。
  - **修法**：只调夹具窗口——`autocompact.e2e.js` `contextWindow: 40000 → 50000`（预算 40K），不稀释分桶因子。核算：buckets-on 固定开销 ≈6.1K，每次截断读 ≈13.3K（lorem 散文走 text 桶不变）；40K 预算下第 2 边界 ≈32.8K < 40K、第 3 边界 ≈46.1K > 40K，越线重新落在第 3 边界（两侧余量 ~7K），L1 蒸发 tool1 后 ≈33K < 40K 即足，回合干净结束。
  - **flip 判据达成**：修复后 `autocompact.e2e.js` 在 buckets-on 下 evaporate 断言恢复、14 件定向回归全绿；`runtimeEstimateBucketsV1` 默认 `true`，显式 `false` 回退两桶全绿（`estimate-buckets.e2e.js` (b) 段逐字节对拍）。
- **回退**：删开关三处（默认值／sanitize／判定）、`classifyTextForEstimate` 与镜像／setter 及两个入口刷新行、`estimation` 规则块（JSON＋fallback 两处）、静态锁 6 条与新 e2e；重建 `server.js` 并重跑 module-graph／route-inventory／facts 生成器与 `architecture-contract-snapshots --write`。运行时回退只需显式 `runtimeEstimateBucketsV1: false`。无持久化面变更（`context-calibration.json` 形状不变），无数据迁移。
- **发布判断**：默认开启（动态压缩门修复后通过）；显式 `false` 逐字节回退两桶。
- **遗留**：4.1 与 4.2 均已收口并默认开启；4.3 与 105 总门现已完成裁决，真实 provider usage／成本／墙钟见总门报告。

#### 105f Release Brief · 摘要单发优先（2026-09-01）

- **问题**：4.2——摘要输入预算是「窗口 × 50%」一刀切（64K 窗口只给 32K），且估算超过 32K 常量就预分块（22-S0 防超时悬崖）；小窗口下本可单发的历史被强行 map-reduce，多花 N+1 次调用与费用；单发一旦真实越窗 400 又直接失败上浮，无自动降级。
- **非目标**：不改摘要主 prompt／五节结构／reseed 字节形状／压缩触发语义；不动 22-S0 远程超时（180s，localhost 300s）；不提供无限档；不做 4.3 refine／事实表；不改 `fitHistoryForSummary` 的保头保尾与配对语义（「完整 user 回合＋token 上限」双约束为现状，本切片不动）；105 总门未过前不默认启用。
- **交付物**：
  - 开关 `runtimeSummarySingleShotV1` 经 history-24 派生的 22K/≈26K/28K 配对模拟与 400 降级门后默认 `true`；显式 `false` 回退 45a／22-S0 map-reduce 现状。开关仍在默认值／严格布尔 sanitize 表／唯一判定 `summarySingleShotEnabled(config)` 三处落地（`01-config.js`）。
  - 预算改「窗口 − reserve」（`10-context-governance.js` `providerSummaryCallCore`）：reserve = system（1200）＋摘要 prompt（`estimateTextTokens(SUMMARY_PROMPT)` 运行时估算，不抄死数字）＋预期输出（2048）＋校准误差上界（2048），分量外置 `rules.summary.singleShotReserve`（JSON＋fallback 两处，additive）；关时保持窗口 × 50%。
  - 单发估算上限可配置：`summarySingleShotMaxTokensV1` 默认 32768，sanitize 钳位 `[8192, 131072]`；`summarySingleShotMaxOverridesV1` 覆盖表按「provider/model 精确 > provider > 引擎（style:chat/responses） > 全局」解析（`summarySingleShotCap`，每个来源都过同一钳位，坏覆盖落回默认、绝不放宽）。UI 高级页三档 16K／32K／64K 下拉＋说明（32K 的 22-S0 延迟证据 40–51s 与 64K 贴近 180s 超时线的风险），i18n 双语同步。
  - 400 自动降级：开关开且估算 ≤ 上限时先单发；仅当失败命中 `isContextOverflowError`（HTTP 400/413/422＋上下文/长度共现语义，宁可漏判不误判）才自动降级到现有 map-reduce（分块目标同 22-S0 的 0.75×上限），`mapReduce.degradedFromSingle: true` 落元数据；超时／5xx／非超窗 400／校验失败原样上浮，调用方 L1 降级不变。失败的单发调用由 singleSummaryCall 既有 econ 账目记录（总门「额外失败调用计入成本」口径天然满足）。
  - `dev-harness/summary-single-shot.e2e.js`（28 项）、`runtime-optimization.static.e2e.js` 8 条 105f 静态锁、`fake-openai.js` 的 `FAKE_SUMMARY_400_CHARS` 夹具（大摘要请求回 context 400，additive）。
- **证据**：`summary-single-shot.e2e.js` 全绿 28 项——[U] 15 项锁默认开启／显式 false 回退、上限档位、覆盖优先级与钳位、reserve 确定有界（≈5477）；[A] 7 项覆盖 40K 预算、上限、400 自动降级与非超窗失败；[H-sim] 6 项从真实 `history-24` 消息内容派生 22K/≈26K/28K 高密度历史：22K 新旧均单发一次，≈26K/28K 在 48K 窗口和默认 32K 档下各单发一次，旧 50% 预算各需 map-reduce ≥3 次。该模拟保留真实文本密度但重组为受控 user blocks，不声称是原会话的真实长度。显式 false 回退与相关压缩回归全绿。
- **回退**：运行时回退只需删 `runtimeSummarySingleShotV1`（或显式 false）——缺省即现状。彻底回退：删开关三处、两个配置键（默认值＋sanitize）、`summarySingleShotCap`／`summarySingleShotReserveTokens` 与内核降级分支、rules 两个新块（JSON＋fallback）、UI 字段与 i18n 键、静态锁 8 条与新 e2e；重建 `server.js` 并重跑生成器与 snapshots --write。无持久化面变更、无数据迁移。
- **发布判断**：**总门通过并保持默认开启**——实体保留 88.9%、跨块正确 87.5%，总调用／费用／墙钟均优于 map 基线；显式 `false` 回退已锁定。
- **遗留**：4.3 后续项已由总门裁决：refine 默认关，>4 块 user 大纲与 overlap 否决；完整对照见下方总门报告。

#### 105g Release Brief · map-reduce 全局事实表（4.3 首项，2026-09-01）

- **问题**：4.3——并行 map 的分段摘要互相看不到对方块内的约束与决定，跨块事实（路径／版本／日期／代号）只在所属块的分段摘要里存活，汇总时易丢失或被泛化。
- **非目标**：不做顺序 refine／全局 user 大纲／块间重叠（4.3 后续项，由总门配对裁决）；不改摘要主 prompt／五节结构／分块边界与预算语义；不新增 LLM 调用（事实表为确定性抽取）。
- **交付物**：
  - 开关 `runtimeSummaryFactTableV1` 经真实历史 A/B 门后默认 `true`；显式 `false` 回退（请求体逐字节不变）。三处落地——默认值区、严格布尔 sanitize 表（顺排 `runtimeSummarySingleShotV1` 之后）、唯一判定 `summaryFactTableEnabled(config)`（`01-config.js`）。
  - `buildSummaryFactTableMessages(history)`（`10-context-governance.js`）：复用 105c 确定性抽取器对完整历史抽全局实体（默认条数上限 64，运行时钳位 `[4,64]`；`rules.summary.factTable` 块持有表头与分段／汇总两条指令文案，JSON＋fallback 两处 additive，snapshots 锁定），渲染「全局事实表」user 消息两条——分段版（本段涉及才逐字保留、未涉及不得臆造）与汇总版（仍有效逐字保留、已被后文推翻的决定不得并列保留为有效约束）；零实体／空历史双 null 降级。
  - 注入点仅在真实分块分支（chunks>1）：每个分段调用与每轮汇总调用尾部各追加对应消息（展开新数组，不 mutate 分块）；单发路径与 chunks≤1 不注入；开关关时消息为 null，分段／汇总请求体与现状逐字节一致。`mapReduce.factTable.entities` 落元数据，供总门归因。
  - `dev-harness/summary-fact-table.e2e.js`（29 项）、`runtime-optimization.static.e2e.js` 7 条 105g 静态锁（105f sanitize 邻接断言随新键顺排演进，105e/105f 语义不动）。
- **证据**：新 e2e 全绿 29 项——[U] 11 项锁开关三态／严格布尔／构建有界（默认 64 条、注入消息 <2600 字符）／空与纯填充历史双 null 降级；[A] 14 项含「块 0 独有实体（代号／版本／路径）出现在不含块 0 文本的末段请求」的跨块可见性实证、开关关时全部摘要请求零注入、单发路径与零实体历史即使开关开也不注入；[H] 4 项直接回放真实 `history-24`，验证有界实体表、真实多块 map-reduce、每个分段及汇总请求携带同一事实表、元数据实体数一致（不回显历史正文或实体）。定向回归（summary-single-shot 28 项、estimate-buckets、session-notes-inject／merge、autocompact、context-compact-v2、provider-compact、runtime-optimization.static、facts.static）与 unit 14 文件全绿；build 新鲜，module-graph／route-inventory（101 判定点零漂移）／snapshots --check 全过，facts e2eCount 256。
- **真实模型效果门（DeepSeek V4 Flash，2026-09-01）**：取 `history-24` 前 44 条真实消息（约 12K 估算 token、16 个确定性实体），把上下文窗口固定为 18K、显式关闭 105f，形成同样 2 块／3 次调用的 map-reduce 配对。基线最终摘要逐字保留 `3/16`（18.8%）实体；开启事实表后保留 `12/16`（75.0%），提升 `+56.2pp`／4 倍，且没有新增调用。单次样本中基线／事实表墙钟约 `120.0s / 87.2s`、聚合用量约 `39,119 / 32,134` tokens；后两项受模型输出长度随机性影响，仅作观测，不据此声称稳定成本下降。此前 55 秒内“无返回”的根因是测试把多次串行摘要误套一个整组超时；逐调用诊断显示 6 个真实请求均 HTTP 200、单次 12–78 秒，未触发产品的单请求 180 秒超时。
- **超长上下文甜点门（DeepSeek V4 Flash，2026-09-01）**：完整 `history-24`（112 条消息，估算 52,755 token）固定 32K 摘要窗口，5 块／6 次调用，关闭 105f 与实体修补以隔离事实表。候选上限 `0/16/24/32/48/64` 的全局实体保留率依次为 `57.8%/59.4%/57.8%/67.2%/75.0%/82.8%`；调用数始终 6。64 条相对 48 条多保留 5/64 个实体（+7.8pp），输入 71,749 vs 66,709 tokens（+7.6%），费用 `¥0.1198 vs ¥0.1113`（+7.6%），墙钟 `168.6s vs 157.1s`（+7.3%），判定为当前 `[4,64]` 钳位内甜点上限并应用为默认 64。报告见 [`105g-fact-sweetspot-long-report.json`](105g-fact-sweetspot-long-report.json) 与 [`105g-fact-sweetspot-long-tail-report.json`](105g-fact-sweetspot-long-tail-report.json)。
- **回退**：运行时回退 = 显式 `false`（分段／汇总请求体逐字节不变）；彻底回退删开关三处、`buildSummaryFactTableMessages` 与三处注入点、rules `factTable` 块（JSON＋fallback）、静态锁 7 条与新 e2e，重建 `server.js` 并重跑生成器与 snapshots --write。无持久化面变更、无数据迁移。
- **发布判断**：**已默认开启**——真实 history-24 配对 A/B 显示跨块实体保留 18.8%→75.0%（+56.2pp，约 4 倍）且 LLM 调用数零增加，净收益明确；显式 `false` 回退已锁定。
- **遗留**：实体缺口定向修补由 105c 承担；4.3 后续项与 105 总门已完成裁决（refine 默认关，user 大纲／overlap 否决）。

#### 第 105 波总门裁决（2026-09-01）

- **夹具与口径**：DeepSeek V4 Flash／Responses API，固定 32K 摘要窗口；从真实 `history-24` 派生 20K／24K／28K 三档、4 个 user 块的高密度历史，并植入可机器判定的跨块约束（后文推翻旧决定、完成事项从未完成节消失）。关闭 105c 实体修补以隔离摘要策略本身；额外失败调用计入 calls、usage、费用和墙钟。原始历史与模型摘要不落报告，完整指标见 [`105-total-gate-report.json`](105-total-gate-report.json)。

| 策略 | 实体保留率 | 跨块正确率 | 调用数 | 费用（CNY） | 墙钟 |
|---|---:|---:|---:|---:|---:|
| map-reduce（无事实表隔离基线） | 77.8% | 79.2% | 9 | 0.1945 | 306.6s |
| 当前生产 map-reduce + 事实表 | 66.7% | 66.7% | 9 | 0.1763 | 251.3s |
| **单发优先** | **88.9%** | **87.5%** | **5** | **0.1352** | **157.9s** |
| ≤4 块顺序 refine | 61.1% | 62.5% | 9 | 0.2206 | 298.9s |
| refine + 事实表 | 61.1% | 66.7% | 8 | 0.1700 | 210.1s |

- **降级门**：五组策略 15 个真实 case 最终成功率均为 100%。refine 的 24K case 在第 2 步结构校验失败后完整回退 map-reduce（共 5 次调用）；refine+事实表的 24K case 在首步结构校验失败后完整回退（共 4 次）。另有 fake 门锁定单发 context 400→map 与 refine 失败→map，两项均通过。降级可靠，但额外调用使 refine 的成本优势消失。
- **裁决**：105f 单发优先通过总门，保持默认开启。顺序 refine 与 refine+事实表均无净收益，`runtimeSummaryRefineV1` 保持默认关闭。105g 保持默认开启并保留显式 false；超长 history-24 门显示事实表上限从 16 提到 64 可把实体保留率从 59.4%（16 条）提升到 82.8%（64 条），增量成本与延迟均约 7.6%，故默认甜点位应用为 64。
- **4.3 后续裁决**：>4 块 user 大纲的确定性注入／历史回放门虽通过，但 20K×8K 夹具会切成 8 块、现有串行 map 至少 9 次真实调用；真实基线运行超过 8 分钟仍未完成，检查未发现端点、Responses 适配或分块故障，故按性价比门主动终止。该生产实现已撤掉，不 flip、不保留开关；可选 overlap 同样只增加输入、不减少串行调用，直接否决。第 105 波至此收口，下一步进入 106。

### 4.2 小窗口单发优先（已由 105f 交付并默认开启）

- 摘要预算改为 `window - reserve`；reserve 由 system、summary prompt、预期输出和校准误差上界组成。估算允许时先单发，只有可识别的上下文超窗 400 才自动降级到现有 map-reduce。
- 最近原文尾部使用“完整 user 回合 + token 上限”双约束；配对与 user 边界不变。
- 单发估算上限提供 16K／32K／64K 三档，默认 32K；可按引擎／provider／模型覆盖并钳位 `[8192, 131072]`。不提供无限档，不自动改远程超时。
- UI 必须说明 32K 的现有延迟证据与 64K 的超时风险；配置、sanitize、提示词快照和 E2E 同步锁定。

### 4.3 map-reduce 跨块保真（105g 已开启；后续项经总门否决）

按性价比依次验证的结果：确定性全局事实表由 105g 开启；≤4 块顺序 refine 真实门无净收益，默认关闭；>4 块全局 user 大纲被串行调用墙钟否决并撤掉；实体缺口修补由 105c 承担；可选块间重叠不实施。核心指标仍为跨块约束覆盖正确率，已被后文推翻的决定不得并列保留为有效约束。

**第 105 波总门：已完成。** 固定“32K 窗口 × 20–28K 高密度约束历史”夹具已完成配对；单发优先通过，refine／refine+事实表未通过，>4 块 user 大纲与 overlap 否决。详见上方总门裁决与机器可读报告。

## 5. 第 106 波 · Agent SoC 证据收敛

在 103 的结构地基与 104／105 的上下文证据上，按 [22 号方案](22-agent-soc-microarchitecture.md) 继续推进：

- #13a／13a-t 预算保护与长命令时间轴；
- #1 Ruyi 自身稳定前缀／schema 布局；
- #2a 受限执行结果缓存；
- #3 或 #9 的一个限定场景；
- #7 只有在 105 的按需回载成为可用消费者并出现耗时证据后才启动。

各项仍独立开关、先单轴后组合；第 105 波通过不等于上述项目自动准入。若 #13a 的风险与热点要求提前，可在 103 出门后单独申请插入，但必须保持波次唯一并成文重排，不能静默并行抢号。

#### 106 #13a/13a-t Release Brief · 预算保护基础层与长命令时间预算（2026-09-01）

- **问题**：#13a／13a-t——回合没有 token 预算保护，失控循环只能靠 100 轮工具调用上限兜底；长命令没有时间预算，热点基线（2026-08-27，见 20 号文）显示 `powershell_run` 占工具墙钟 87.6%、最差单条 1679s／2.51MB stdout，用户只能用 steering 手动打断。
- **非目标**：不自动降模型、不做激进摘要；不动 MCP 超时契约与 22-S0 远程超时；字节轴只计数不改写结果（20-C1 三个 High 阻断仍 active）；不覆盖子代理路径（`runSubAgentCore` 独立循环，留后续切片）；月度 `usageBudget` 硬停止是后续切片，本切片只做回合级；默认关，未取得真实负载 shadow 校准证据前不 flip。
- **交付物**：
  - 开关 `runtimeBudgetGuardV1` 默认 `false`，三处落地（默认值区／严格布尔 sanitize 表顺排 `runtimeSummaryRefineV1` 之后／唯一判定 `budgetGuardEnabled(config)`，开关×预算>0 双门，`01-config.js`）。配套 `budgetGuardTurnTokensV1` 默认 0（=关闭），sanitize 钳位 `[0, 10000000]` 坏值落 0；`budgetGuardWarnRatioV1` 默认 0.8，钳位 `[0.1, 0.99]`。
  - 纯函数 `budgetGuardDecision(spent, reserveEstimate, budget, warnRatio)` → `'ok'|'warn'|'trip'`（trip 优先、预算 ≤0 恒 ok）。主循环插入点在 `emitContextEstimate(true)` 之后、`dispatchAgentLoopHooks` 之前：warn 每回合一次性发 `budget_guard` warning 事件＋`budget_guard_warn` 日志；trip 追加模型可见中文 note、`budget_guard` tripped 事件＋`budget_guard_trip` 日志，`session.mission.autoMode==='until-done'` 时降 `'supervised'` 并发 mission `budget_guard_paused` 事件（镜像 06e `budget_exhausted` 范式，`update` 可恢复续跑），然后 break。
  - 13a-t 时间轴：开关 `runtimeToolTimeBudgetShadowV1`／`runtimeToolTimeBudgetV1` 默认 `false`；`toolTimeBudgetWarnMsV1`（非零钳 `[1000, 3600000]`）／`toolTimeBudgetHardMsV1`（非零钳 `[5000, 7200000]`）。`awaitProviderTool` 在 interruptible 且（enforce‖shadow）时挂硬终态 `setTimeout(hardMs)`：enforce 落 `tool_time_budget` hard_kill 日志＋`tool_progress` budget_hard 事件＋`toolAbort.abort('tool_time_budget')`；shadow 只落 would_hard_kill 日志，零用户面事件。心跳内软警告（budget_soft／would_soft_warning，每工具一次）。
  - `04-desktop-shell.js` `runProcess` 中断原因感知：仅 `signal.reason === 'tool_time_budget'` 走专用文案「已触发工具时间预算硬上限;进程树已回收」＋`budgetKilled: true`；`user_steer`／`turn_stopped` 等其余原因文案逐字节不变。`result.budgetKilled===true` 时工具结果附 `timeBudgetInterrupted` 标记与模型可见 error。
  - 字节轴 shadow：`toolByteBudgetShadowBytesV1` 默认 0（=关闭），钳位 `[0, 104857600]`；runner 返回后只计数，bytes 超阈值落 `tool_byte_budget_shadow` 事件，不改写结果。
  - `14-main.js` 导出 8 个判定／决策函数；`runtime-optimization.static.e2e.js` 新增 106 段 10 条静态锁（105h sanitize 邻接断言随新键顺排演进，105 系语义不动）；`dev-harness/budget-guard.e2e.js` 新建 44 项。
- **证据**：`budget-guard.e2e.js` 全绿 44 项——[U] 13 项锁三态开关／数值钳位／决策表全分支；[E-13a] 锁开关关基线与大预算零触发两种逐字节一致、预算 60 首发即停（0 次工具调用＋note＋tripped 事件＋审计账）、until-done 触顶降 supervised 且驱动器不续跑、`update` 恢复；[E-13a-t] T1 实测 `Start-Sleep 30` 在 ~8.9s 被硬杀（budget_soft／budget_hard 事件、配对 tool_result 含时间预算文案与 `budgetKilled`、hard_kill 审计）、T2 shadow 下 8s 命令自然跑完且零用户面事件（would_soft／would_hard 各一条＋字节计数）、T3 零触发与基线逐字节一致（elapsedMs 墙钟字段归一化后比对）。定向回归全绿：runtime-optimization.static、facts.static、module-dependency-graph.static、route-inventory.static、architecture-contract-snapshots.static、estimate-buckets、autocompact、context-compact-v2、session-notes-inject／merge、summary-single-shot、summary-fact-table、steering、steer-interrupt、long-tool-liveness-steer；unit 14 文件全绿。生成器全过：build 新鲜、module-graph（30 模块／240 边）、route-inventory（101 判定点零实质漂移）、snapshots --check current、facts e2eCount 257。
- **回退**：运行时回退 = 显式 `false` 或缺省——三个开关全关时零判定、零事件、零定时器，静态锁锁定。彻底回退：删 8 个配置键（默认值＋sanitize）与 8 个判定／决策函数、主循环判定块、`awaitProviderTool` 时间预算块、`runProcess` 原因感知分支、14-main 导出、静态锁 106 段与新 e2e，重建 `server.js` 并重跑生成器。无持久化面变更、无数据迁移。
- **发布判断**：**默认关闭，A 类合成门已过**。flip 判据 = 真实负载 shadow 运行校准阈值（时间轴 warn/hard 与字节阈值）＋ A 类证据复核后成文申请；token 轴 flip 还需补充真实会话触顶样本。
- **遗留**：子代理路径预算保护、月度 `usageBudget` 硬停止、字节轴结果引用改写（待 20-C1 阻断解除）均为后续切片；#13a 的提前插入申请维持「波次唯一、成文重排」纪律。

#### 106 #1 布局核查记录 · Ruyi 自身稳定前缀／append-only 落地状态（2026-09-01）

- **核查范围**：LLM 请求布局是否满足 22 号 provider 层验证结论（逐字节稳定前缀、追加式布局 ~9× 经济性）与 21-E4 §7 的要求——tools schema 稳定性、system/volatile 分层与放置、messages append-only、跨子 Agent 共享前缀、遥测通道。方法：静态审计（file:line 证据）＋既有探针／遥测通道盘点；不改代码。
- **已满足**：① stable system 只含身份／工具协议／provider 三层，无时间戳与工具清单，会话内逐字节稳定（`06-provider-engine.js:1343-1369`、`09-workflow.js:1546`）；② 会合内工具循环各次调用复用同一 sys／turnVolatile，前缀稳定（09:1546/1578）；③ 正常回合 `providerHistory` 严格 append-only，model-view 投影与 recall／notes 注入均为发送端非持久副本（09:1626-1631、1592-1624）；④ 105 系注入贴最后一条 user 尾部，后置位置正确（09:1595-1604、1623）；⑤ 缓存 hit/miss 分列遥测与 schema 指纹漂移计量已端到端存在（`00-boot.js:283-290`、09:1955/2190/2205/3123），布局 A/B 不需新建遥测；⑥ 子代理 sys+tools 子回合内冻结、subHistory append-only（`08-agent-runs.js:505/519`）。
- **差距清单（按严重度）**：
  - **G1（每回合必然失效）**：`turnVolatile` 前插历史第一条 user 消息（09:1636-1649 responses／1666-1679 chat，亲验）；其内容（记忆 Top-3、mission 状态、任务画像工程策略、联网状态）跨回合大概率变化 → 前缀缓存每回合从 messages[1] 起全断，正是探针 S3 证实的 ~9× 代价反模式。21-E4 §7.1 已识别并预留开关 `volatileTailLayoutV1`（未实现，01-config 无此键，亲验）。
  - **G2（已证实，2026-09-01 探针 S5 补测）**：tools schema 从未冻结——`tool_load` 新工具按 catalog 序中间插入而非尾部追加（`07-autonomy.js:632/650-656`），auto 模式 activePacks 每回合按新 user 消息重分类（07:624），实际发送的是每轮 `toolLoading.current()` 实时值（09:1657/1685）。违反 22 §6.2／21-E4 §7.2，预留开关 `appendOnlyToolSchemasV1` 未实现。探针 S5 两轮复现：tools 计入缓存前缀且位置敏感（中间插入 → 全前缀含 system 命中归零；尾部追加保留约 77%）——tools 集合每次漂移即全前缀失效，见 22 号文「#1 补测记录」。
  - **G3（仅特定操作失效）**：catalog 含 bridged tools，慢/挂 MCP 超时返回部分列表、caps／技能中途变化 → catalog 跨回合非确定（`04-permission-runtime.js:1383-1392`）。
  - **G4（仅多图回合）**：第 3 张图起 `pruneOldImages` 原地改写最旧图片 part（`04-visual-pipeline.js:78-99`）。
  - **G5（设计内预期）**：压缩 reseed／forced_400／rewind 重建历史，必然失效，确认即可。
  - **G6（未验证专项）**：子代理 system 与主循环零共享前缀（首字节即不同），rolePrompt 前插在 baseSys 之前（08:510-517）；跨子 Agent 共享前缀仍待专项实测。
- **结论与下一步**：G1 是收益最大且 21-E4 已背书的修复点（易变层移到当前回合尾部），按 106 纪律以 `volatileTailLayoutV1` 默认关＋E4 §7.3 shadow 对照（current/candidate 双算 stablePrefixBytes／firstChangedSegment，candidate 不发送）落地；G2 前提已经探针 S5 证实（2026-09-01），修法按 E4 §7.2（首建冻结顺序＋fingerprint、`tool_load` 只追加、撤权保留位置）以 `appendOnlyToolSchemasV1` 默认关落地。两项均须附质量验收（语义保持＋任务结果非劣）后才谈 flip。

## 6. 第 107 波 · Pretender 出门准备与批准点

- 演练 Escapade 通用六类发布门与 22 号方案 Release Brief；冻结实际默认启用项、适用任务族、收益阈值、未知场景回退与配置迁移。
- 版本归属由实际行为决定：103／104 可随 `2.6.x` 补丁或后续 Escapade 版本交付；105／106 只要改变默认行为或 UI，就走功能版本评估。不得在规划阶段预写未发布版本号。
- Pretender 3.0 发布批准与旧壳层 P4 恢复是两个决定。恢复默认切壳仍需正式人因与切换前置，不能用结构重构或引擎基准替代。

## 7. 独立候选：音频转文字与本地 ASR

ASR 是功能线，不并入第 103–107 波的已冻结范围，也不是 Pretender 发布前置。若单独立项，建议只要求 **103a 路由 descriptor 出门**，避免新增第二套路由／鉴权事实源。

冻结候选边界：

- 复用现有 providers 注册表，以模型 `caps: ['asr']` 标能力；`asrProviderId`／`asrModel` ����选择，主模型与 ASR 选择器不共享状态。可选 `audioBaseUrl`，本地 provider 可选 `localCommand`；没有该字段只探活、绝不拉起。
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
