// 01c-runtime-flags.js - 110-2b: 从 01-config.js 搬出的运行时开关判定函数(纯搬家,零行为变更)。
// 105a: observation_recall 生效条件 —— recall 与 reducer 开关成对(rawRef 只由 reducer 产生,
// 单开 recall 无可解析引用)。目录可见性、offer 门与 handler fail-closed 共用本判定。
function observationRecallEnabled(config) {
  return !!(config && config.runtimeObservationRecallV1 === true && config.runtimeObservationReducerV1 === true);
}

// 105b: session-notes.md 状态外置生效条件 —— 单开关,不依赖 reducer/recall。
// 挂钩点与 e2e 共用本判定；显式 false 保证可完整回退为零文件读写。
function sessionNotesEnabled(config) {
  return !!(config && config.runtimeSessionNotesV1 === true);
}

// 105d-A: session notes 回注生效条件 —— 单开关,不依赖 105b 写侧开关(读失败即 null,
// 旁车副本缺文件不是错误)。注入点与 e2e 共用本判定；显式 false / 缺省保证零注入、
// 零文件读取(零行为变化)。
function sessionNotesInjectEnabled(config) {
  return !!(config && config.runtimeSessionNotesInjectV1 === true);
}

// 105d-B: session notes 增量合并生效条件 —— 挂在 105b 写链内,单开 merge 而无 105b
// 不产生任何文件读写。挂钩点与 e2e 共用本判定；显式 false / 缺省保证 105b 整体重写
// 语义逐字节不变。
function sessionNotesMergeEnabled(config) {
  return !!(config && config.runtimeSessionNotesMergeV1 === true);
}

// 105c: 摘要实体确定性抽检生效条件 —— 单开关。挂钩点(wrapper)与 e2e 共用本判定；
// 显式 false / 缺省保证零检查、零修补、零事件(零行为变化)。
function summaryEntityCheckEnabled(config) {
  return !!(config && config.runtimeSummaryEntityCheckV1 === true);
}

// 105e: 估算因子分桶生效条件 —— 单开关。入口(runOpenAiTurn / runSubAgentCore;maybeAutoCompact
// 唯一调用点在回合内,已被入口覆盖)把判定结果镜像进同步估算热路径(setEstimateBucketsV1),
// e2e 共用本判定;默认开启,显式 false 保证两桶行为逐字节不变(零行为变化回退)。
function estimateBucketsEnabled(config) {
  return !!(config && config.runtimeEstimateBucketsV1 === true);
}

// 105f: 摘要单发优先生效条件 —— 单开关。摘要内核(providerSummaryCallCore)与 e2e 共用本判定;
// 显式 false / 缺省保证 45a/22-S0 现状(窗口 × 50% 预算 + 32K 强制分块、无 400 降级)逐字节不变。
function summarySingleShotEnabled(config) {
  return !!(config && config.runtimeSummarySingleShotV1 === true);
}

// 105g(4.3 首项): map-reduce 全局事实表生效条件 —— 单开关。摘要内核(providerSummaryCallCore
// 分块分支)与 e2e 共用本判定;显式 false / 缺省保证分段与汇总请求体逐字节不变(零注入)。
function summaryFactTableEnabled(config) {
  return !!(config && config.runtimeSummaryFactTableV1 === true);
}

// 105g sweet-spot gate: resolve the deterministic fact-table sample cap. Keep this separate from
// summaryFactTableEnabled so experiments can compare caps without weakening the boolean rollback gate.
function summaryFactTableCap(config) {
  const n = Number(config && config.summaryFactTableMaxSamplesV1);
  return Number.isFinite(n) ? Math.min(64, Math.max(4, Math.round(n))) : 64;
}

// 105h(4.3 第二项): <=4 块顺序 refine 生效条件 —— 单开关。105 总门否决默认开启;显式 false / 缺省
// 保证 105g 现有 map-reduce 调用顺序、请求体与失败语义逐字节不变。
function summaryRefineEnabled(config) {
  return !!(config && config.runtimeSummaryRefineV1 === true);
}

// 106 #13a: 预算保护基础层生效条件 —— 单开关且回合预算 >0 才真正把门(开关开但预算 0 = 空转零
// 判定)。回合主循环(runOpenAiTurn 迭代边界)与 e2e 共用本判定;显式 false / 缺省 / 预算 0
// 保证零判定、零事件(零行为变化回退)。
function budgetGuardEnabled(config) {
  return !!(config && config.runtimeBudgetGuardV1 === true) && budgetGuardTurnTokens(config) > 0;
}
function budgetGuardTurnTokens(config) {
  const n = Number(config && config.budgetGuardTurnTokensV1);
  return Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(10000000, Math.round(n))) : 0;
}
function budgetGuardWarnRatio(config) {
  const r = Number(config && config.budgetGuardWarnRatioV1);
  return Number.isFinite(r) ? Math.min(0.99, Math.max(0.1, r)) : 0.8;
}
// #13a 决策纯函数(回合主循环与 e2e 共用):spent = 本回合实报 usage 累计,reserveEstimate = 即将
// 发出调用的估算输入。'trip' 优先于 'warn'(触顶事件本身即最强预警);预算 ≤0 恒 'ok'(不开门)。
function budgetGuardDecision(spent, reserveEstimate, budget, warnRatio) {
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return 'ok';
  const s = Number(spent) || 0;
  if (s + (Number(reserveEstimate) || 0) > b) return 'trip';
  const r = Number(warnRatio);
  const wr = Number.isFinite(r) ? Math.min(0.99, Math.max(0.1, r)) : 0.8;
  if (s >= Math.floor(b * wr)) return 'warn';
  return 'ok';
}

// 106 #13a-t: 长命令时间预算生效条件 —— shadow(只统计)与主动(软警告+硬终态)各自独立开关,
// 主动优先于 shadow。awaitProviderTool 挂钩点与 e2e 共用本判定;双双缺省/false 保证零定时器、
// 零事件,现状逐字节不变。
function toolTimeBudgetEnabled(config) {
  return !!(config && config.runtimeToolTimeBudgetV1 === true);
}
function toolTimeBudgetShadowEnabled(config) {
  return !!(config && config.runtimeToolTimeBudgetShadowV1 === true);
}
function toolTimeBudgetWarnMs(config) {
  const n = Number(config && config.toolTimeBudgetWarnMsV1);
  return Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(3600000, Math.max(1000, Math.round(n)))) : 0;
}
function toolTimeBudgetHardMs(config) {
  const n = Number(config && config.toolTimeBudgetHardMsV1);
  return Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(7200000, Math.max(5000, Math.round(n)))) : 0;
}
function toolByteBudgetShadowBytes(config) {
  const n = Number(config && config.toolByteBudgetShadowBytesV1);
  return Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(104857600, Math.round(n))) : 0;
}

// 106 #1 G1/G2: 前缀缓存布局两个实验开关的唯一判定。buildBody(09-workflow)与
// createToolLoadingState(07-autonomy)共用;显式 false / 缺省 = 现状逐字节不变
// (G1 前插首条 user、G2 catalog 序过滤不冻结)。
function volatileTailLayoutEnabled(config) {
  return !!(config && config.runtimeVolatileTailLayoutV1 === true);
}
function appendOnlyToolSchemasEnabled(config) {
  return !!(config && config.runtimeAppendOnlyToolSchemasV1 === true);
}

// 106 #2a: 受限执行结果缓存的唯一判定(12-tool-dispatch 的 file_read 缓存层共用)。
// 双门:开关严格 true 且条数上限 > 0;显式 false / 缺省 / 上限 0 = 零缓存路径。
function execResultCacheMaxEntries(config) {
  const n = Number(config && config.execResultCacheMaxEntriesV1);
  return Number.isFinite(n) ? (n <= 0 ? 0 : Math.min(2000, Math.round(n))) : 200;
}
function execResultCacheEnabled(config) {
  return !!(config && config.runtimeExecResultCacheV1 === true) && execResultCacheMaxEntries(config) > 0;
}

// 113a: 记忆召回的离线向量层唯一判定（resolveMemoryPreflight 共用）。
// 关时 rankRelevantMemories 原样走，开时才做词法×向量的 RRF 融合。
function memoryVectorRecallEnabled(config) {
  return !!(config && config.runtimeMemoryVectorRecallV1 === true);
}

// 113b: 会话内容搜索的唯一判定。默认开；显式 false 时端点直接给回“已关闭”，
// 前端回退到旧的子串过滤（不报错，只是搜不到正文）。
function sessionSearchIndexEnabled(config) {
  return config ? config.sessionSearchIndexV1 !== false : true;
}

// 113a-后续(2026-09-04 用户拍板): 记忆容量五旋钮的唯一判定。
// 旧常量（core 24 条 / 4200 字、每轮 3 条、固定选择 12 条、索引段 2600 字）全部变成可配；
// 调用方不传 config 时回落新默认值，不回落旧常量——否则同一库在不同入口会给出不同的席位数。
function memoryLimit(config, key, lo, hi, fallback) {
  // 先取原值再转数字。写成 Number(config && config[key]) 会在 config 为 null 时得到 Number(null)=0,
  // 而 0 是合法钳位值 —— 于是「没传配置」被静默解读成「上限为 0」,整个胶囊消失。夹具当场抓到过。
  const raw = config ? config[key] : undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}
function coreMemoryMaxItems(config) { return memoryLimit(config, 'coreMemoryMaxItemsV1', 0, 2000, 200); }
function coreMemoryCharBudget(config) { return memoryLimit(config, 'coreMemoryCharBudgetV1', 0, 200000, 16000); }
function memoryRelevanceMax(config) { return memoryLimit(config, 'memoryRelevanceMaxV1', 0, 64, 8); }
function memoryFixedSelectionMax(config) { return memoryLimit(config, 'memoryFixedSelectionMaxV1', 1, 1024, 64); }
function memoryIndexCharCap(config) { return memoryLimit(config, 'memoryIndexCharCapV1', 500, 100000, 6000); }

