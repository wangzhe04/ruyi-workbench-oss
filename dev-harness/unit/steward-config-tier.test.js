// Unit: 第 116 波 116-2e(27 号文 §3.5「如意设置」行)—— `steward_config_get` / `steward_config_set`
// 的三级分级矩阵。
//
// 这份单测的核心不是「几个键分对了」,而是【一个都没漏】:拿 01-config 默认表的每一个键
// (Object.keys(normalizeConfig({}).config))逐个过 stewardConfigTierFor,要求每个键都落到
// free / confirm / forbidden 三级之一,并与本文件里的一张【显式期望表】逐字对上。
// 于是任何人往 defaultConfig() 里加一个新键,这份单测就会红 —— 他必须回来做一次分级判断,
// 而不是让新键悄悄继承某个默认值。fail-closed 保证「忘了判断」的后果是 forbidden(最保守),
// 但「忘了判断」本身仍然要响铃。
//
// 覆盖:
//   ① 判据本身:free / confirm 两张表逐条、forbidden 的 fail-closed、密钥正则兜底压过两张表
//   ② 全键矩阵:默认表 138 个键逐个断言 tier,与显式期望表零差集
//   ③ 边界:空串/null/非字符串/带空格的键名 -> forbidden
//   ④ 常量表形状:STEWARD_CONFIG_TIERS 冻结、free 与 confirm 两张表零交集
//
// 与既有 dev-harness/unit 件同款约定:require server.js 前先把 WIN_CLAUDE_WORKBENCH_HOME 覆盖到
// 临时目录(它是系统级环境变量,曾污染真实数据);PASS/FAIL 逐条打印,process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-cfgtier-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const { stewardConfigTierFor, STEWARD_CONFIG_TIERS, normalizeConfig } = srv;

/* ═══════════ ④ 常量表形状 ═══════════ */
ok(Object.isFrozen(STEWARD_CONFIG_TIERS), '④ STEWARD_CONFIG_TIERS 冻结');
ok(Array.isArray(STEWARD_CONFIG_TIERS.free) && Array.isArray(STEWARD_CONFIG_TIERS.confirm),
  '④ free / confirm 两张表都是数组');
{
  const overlap = STEWARD_CONFIG_TIERS.free.filter(k => STEWARD_CONFIG_TIERS.confirm.includes(k));
  ok(overlap.length === 0, '④ free 与 confirm 零交集' + (overlap.length ? ' → ' + overlap.join(',') : ''));
  ok(new Set(STEWARD_CONFIG_TIERS.free).size === STEWARD_CONFIG_TIERS.free.length, '④ free 表内零重复');
  ok(new Set(STEWARD_CONFIG_TIERS.confirm).size === STEWARD_CONFIG_TIERS.confirm.length, '④ confirm 表内零重复');
}

/* ═══════════ ③ 边界:非法键名一律 forbidden ═══════════ */
for (const bad of ['', '   ', null, undefined, 0, 42, {}, [], true]) {
  ok(stewardConfigTierFor(bad) === 'forbidden', `③ 非法键名 ${JSON.stringify(bad)} -> forbidden`);
}
ok(stewardConfigTierFor(' locale ') === 'free', "③ 键名两侧空白被 trim(' locale ' -> free)");

/* ═══════════ ① 密钥正则兜底压过两张表 ═══════════ */
// 兜底正则在第一道判 —— 哪怕将来有人把含 apiKey/token/secret/password 的键错列进 free/confirm,
// 它仍然是 forbidden。这里用几个【不在默认表里】的假键名直接验判据本身。
for (const key of ['someApiKey', 'myToken', 'clientSecret', 'dbPassword', 'APIKEY_x', 'TOKEN']) {
  ok(stewardConfigTierFor(key) === 'forbidden', `① 含密钥字样的键 ${key} -> forbidden(正则兜底)`);
}
ok(!STEWARD_CONFIG_TIERS.free.some(k => new RegExp(STEWARD_CONFIG_TIERS.secretPattern, 'i').test(k))
  && !STEWARD_CONFIG_TIERS.confirm.some(k => new RegExp(STEWARD_CONFIG_TIERS.secretPattern, 'i').test(k)),
  '① free / confirm 两张表里本来就没有任何命中密钥正则的键(表与兜底不矛盾)');

/* ═══════════ ② 全键矩阵 ═══════════ */

// 显式期望表:默认表里【每一个】键的分级判断,一条不漏。
// free      = 改错了用户一眼看得见、一键改回,不花钱、不改权限、不扩大能动世界的范围;
// confirm   = 花钱 / 换执行主体 / 改「谁能不问就做什么」的边界,须用户亲手按下按钮;
// forbidden = 任何权限都不经管家(密钥、数据根与围栏、命令与桌面放行、提示词注入、授权书面)。
const EXPECTED = {
  // ── free ────────────────────────────────────────────────────────────────
  locale: 'free', outputStyle: 'free', theme: 'free', uiMode: 'free',
  stewardProviderId: 'free', stewardModel: 'free', stewardPollMs: 'free',
  stewardMaxTurnsPerHour: 'free', stewardMaxCostPerDay: 'free',
  // stewardContextBudgetTokens 按设计本该 free,但键名含 "Tokens" 被密钥兜底正则命中 -> forbidden。
  // 见 06i 该处的原注释:不给兜底正则开例外口子,代价是管家改不了自己的上下文预算(用户仍能改)。
  stewardContextBudgetTokens: 'forbidden',
  stewardReadBudgetChars: 'free',
  stewardVisitIdleMinutes: 'free', stewardConversationRetention: 'free',
  stewardMaxParallelThreads: 'free', stewardGlobalMaxTurnsPerHour: 'free', stewardGlobalMaxCostPerDay: 'free',

  // ── confirm ─────────────────────────────────────────────────────────────
  agentCliType: 'confirm', engineMode: 'confirm', activeProvider: 'confirm', model: 'confirm',
  compactProviderId: 'confirm', compactModel: 'confirm', modelsApiBase: 'confirm',
  subagentPreferredProvider: 'confirm', subagentPreferredModel: 'confirm',
  externalMcpServers: 'confirm', enableMcpDropIn: 'confirm', includeWorkbenchMcp: 'confirm',
  browserAutomation: 'confirm',
  permissionMode: 'confirm', stewardEnabledV1: 'confirm', stewardAutoActions: 'confirm',
  // 116-5a:开着就在每一条新线程上花一次钱,且记的是 aux 不进 stewardMaxCostPerDay ——
  // 管家自己把它打开 = 给自己开一条不受管家日预算约束的花钱通道,故 confirm 而不是 free。
  stewardThreadBriefV1: 'confirm',

  // ── forbidden(fail-closed:以下每一个都【不】在两张表里,逐条写明是为了留一份可读的账)──
  configSchema: 'forbidden', version: 'forbidden',
  claudePath: 'forbidden', kimiPath: 'forbidden', extraClaudeArgs: 'forbidden',
  defaultWorkspace: 'forbidden', workspaces: 'forbidden', recentWorkspaces: 'forbidden',
  additionalDirectories: 'forbidden', allowOutsideWorkspace: 'forbidden',
  autoResumeClaudeSessions: 'forbidden', contextWindowOverrides: 'forbidden', maxTurns: 'forbidden',
  allowCommandTools: 'forbidden', allowDesktopTools: 'forbidden',
  includePartialMessages: 'forbidden', thinkingBudget: 'forbidden', claudeThinkingEffort: 'forbidden',
  betaInterleavedThinking: 'forbidden', mcpCommandMode: 'forbidden',
  killOnDisconnect: 'forbidden', killPortOnStart: 'forbidden',
  permissionBridge: 'forbidden', permissionTimeoutMs: 'forbidden', questionTimeoutMs: 'forbidden',
  autonomyPauseOnTimeout: 'forbidden', autonomyPauseTtlMs: 'forbidden', monitorIncremental: 'forbidden',
  autonomyAutoResume: 'forbidden', agentAutoModelTiering: 'forbidden', storagePolicy: 'forbidden',
  turnIdleTimeoutMs: 'forbidden', knownModels: 'forbidden', extraModels: 'forbidden',
  discoverModelsFromProxy: 'forbidden', modelsApiKey: 'forbidden',
  claudeAuthMode: 'forbidden', providers: 'forbidden',
  openaiMaxToolIterations: 'forbidden', desktopMcp: 'forbidden',
  autoImportClaudeCodeMcp: 'forbidden', dismissedMcpIds: 'forbidden',
  bridgeExternalToolsToProvider: 'forbidden', toolLoadingMode: 'forbidden', toolCatalogCacheTtlMs: 'forbidden',
  runtimeOptimizationShadowV1: 'forbidden', runtimeToolRetrievalV1: 'forbidden',
  runtimeObservationReducerV1: 'forbidden', runtimeObservationRecallV1: 'forbidden',
  runtimeSessionNotesV1: 'forbidden', runtimeSessionNotesInjectV1: 'forbidden',
  runtimeSessionNotesMergeV1: 'forbidden', runtimeSummaryEntityCheckV1: 'forbidden',
  runtimeEstimateBucketsV1: 'forbidden', runtimeSummarySingleShotV1: 'forbidden',
  summarySingleShotMaxTokensV1: 'forbidden', summarySingleShotMaxOverridesV1: 'forbidden',
  runtimeSummaryFactTableV1: 'forbidden', summaryFactTableMaxSamplesV1: 'forbidden',
  runtimeSummaryRefineV1: 'forbidden', runtimeBudgetGuardV1: 'forbidden',
  budgetGuardTurnTokensV1: 'forbidden', budgetGuardWarnRatioV1: 'forbidden',
  runtimeToolTimeBudgetShadowV1: 'forbidden', runtimeToolTimeBudgetV1: 'forbidden',
  toolTimeBudgetWarnMsV1: 'forbidden', toolTimeBudgetHardMsV1: 'forbidden',
  toolByteBudgetShadowBytesV1: 'forbidden', runtimeVolatileTailLayoutV1: 'forbidden',
  runtimeAppendOnlyToolSchemasV1: 'forbidden', runtimeExecResultCacheV1: 'forbidden',
  execResultCacheMaxEntriesV1: 'forbidden', runtimeFailureTelemetryV1: 'forbidden',
  runtimeMemoryVectorRecallV1: 'forbidden', coreMemoryMaxItemsV1: 'forbidden',
  coreMemoryCharBudgetV1: 'forbidden', memoryRelevanceMaxV1: 'forbidden',
  memoryFixedSelectionMaxV1: 'forbidden', memoryIndexCharCapV1: 'forbidden',
  sessionSearchIndexV1: 'forbidden', toolEconomicsShadowV1: 'forbidden',
  boundedReadSchedulerV1: 'forbidden', boundedReadConcurrencyV1: 'forbidden',
  metaToolHintsV1: 'forbidden', actionArgumentModelViewV1: 'forbidden',
  bridgedToolTiers: 'forbidden', shellSessionMax: 'forbidden', toolAllowRules: 'forbidden',
  autoCompactThreshold: 'forbidden', capabilityProbeUrl: 'forbidden', enableToolRequiresProbe: 'forbidden',
  residentSkills: 'forbidden', onboarding: 'forbidden',
  subagentMaxConcurrent: 'forbidden', subagentMaxPerTurn: 'forbidden',
  agentWorkflowMaxNodes: 'forbidden', agentNodeWrapUpMs: 'forbidden',
  agentTaskPoolPolicy: 'forbidden', agentTaskPoolAutoCap: 'forbidden', agentRoleOverrides: 'forbidden',
  searchBackend: 'forbidden', appendSystemPrompt: 'forbidden',
  usageBudget: 'forbidden', claudePricing: 'forbidden',
  subagentBudgetMigrated: 'forbidden', searchBackendMigrated: 'forbidden',
};

const defaults = normalizeConfig({}).config;
const defaultKeys = Object.keys(defaults);
ok(defaultKeys.length >= 100, `② 默认表抽到 ${defaultKeys.length} 个键(下界 100,防遍历悄悄失灵)`);

{
  // 默认表里有、期望表里没有 = 有人加了新配置键却没做分级判断。
  const undecided = defaultKeys.filter(k => !Object.prototype.hasOwnProperty.call(EXPECTED, k));
  ok(undecided.length === 0,
    '② 01-config 默认表的每一个键都在本文件的显式期望表里(新增键必须回来做一次分级判断)'
    + (undecided.length ? ' → 未判定: ' + undecided.join(', ') : ''));
  // 期望表里有、默认表里没有 = 僵尸条目(键被删了,期望表没跟着删)。
  const zombies = Object.keys(EXPECTED).filter(k => !defaultKeys.includes(k));
  ok(zombies.length === 0, '② 期望表零僵尸条目' + (zombies.length ? ' → ' + zombies.join(', ') : ''));
}

{
  const mismatched = [];
  for (const key of defaultKeys) {
    const got = stewardConfigTierFor(key);
    if (!['free', 'confirm', 'forbidden'].includes(got)) { mismatched.push(`${key}: 非三级之一(${got})`); continue; }
    const want = EXPECTED[key];
    if (want && got !== want) mismatched.push(`${key}: want ${want}, got ${got}`);
  }
  ok(mismatched.length === 0, `② 默认表 ${defaultKeys.length} 个键逐个分级与期望表一致`
    + (mismatched.length ? ' → ' + mismatched.join('; ') : ''));
}

{
  const counts = { free: 0, confirm: 0, forbidden: 0 };
  for (const key of defaultKeys) counts[stewardConfigTierFor(key)] += 1;
  ok(counts.free + counts.confirm + counts.forbidden === defaultKeys.length,
    `② 三级分档覆盖全部默认键(free ${counts.free} / confirm ${counts.confirm} / forbidden ${counts.forbidden})`);
  ok(counts.forbidden > counts.free + counts.confirm,
    '② forbidden 是绝大多数 —— 白名单语义的直接体现(可写的是少数、经过挑选的那几个)');
}

/* ═══════════ ① 两张表逐条自洽 ═══════════ */
for (const key of STEWARD_CONFIG_TIERS.free) ok(stewardConfigTierFor(key) === 'free', `① free 表条目 ${key} -> free`);
for (const key of STEWARD_CONFIG_TIERS.confirm) ok(stewardConfigTierFor(key) === 'confirm', `① confirm 表条目 ${key} -> confirm`);
ok(stewardConfigTierFor('someKeyNobodyEverDeclared') === 'forbidden', '① 未登记的键 -> forbidden(fail-closed)');

console.log('');
if (fail) { console.log(`STEWARD CONFIG TIER UNIT: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD CONFIG TIER UNIT: ALL PASS');
process.exit(0);
