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
//   ② 全键矩阵:默认表 141 个键逐个断言 tier,与显式期望表零差集
//   ③ 边界:空串/null/非字符串/带空格的键名 -> forbidden
//   ④ 常量表形状:STEWARD_CONFIG_TIERS 冻结、free 与 confirm 两张表零交集
//   ⑤ 117w-W1 提交②:围栏三兄弟(stewardWorkspaceRoot / workspaces / defaultWorkspace)被【点名】
//      钉成 forbidden;新键 stewardWorkspaceRoot 的出厂值与清洗;workspaces[].note 的清洗
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
// 132b(53 号文 §2):三张表逐键重判 —— free 31 / confirm 93 / forbidden 39(默认表 163 键)。判据只有三条:
//   free      改错了一眼看得见、一键改回,不花钱、不改权限、不扩大能动世界的范围;
//   confirm   会花钱、换执行主体、改「谁能不问就做什么」的边界,或影响用户多久看得见一件事 —— 用户按一下按钮;
//   forbidden 密钥、数据根与围栏、命令／桌面／工具放行、提示词注入面、自我扩权开关、簿记与用户行为记录。
// 117l D7 / 121-K3 / 123-M1 / 123-N2 原本【明确】留在 forbidden 的 stewardThreadModels / threadIndexRecent / scheduler* /
// quietCardSnoozeMinutes / newThreadEngine 按用户 2026-09-21 拍板改成 confirm:管家仍不能自己动,只能递按钮。
// 含 Tokens 的三个键(stewardContextBudgetTokens / summarySingleShotMaxTokensV1 / budgetGuardTurnTokensV1)撞密钥兜底正则 → forbidden,不开例外。
const EXPECTED = {
  // ── free (31) 改错了一眼看得见、一键改回;不花钱、不改权限、不扩大能动世界的范围 ─────────────────────────────
  theme: 'free', locale: 'free', includePartialMessages: 'free', killOnDisconnect: 'free',
  killPortOnStart: 'free', permissionTimeoutMs: 'free', questionTimeoutMs: 'free', autonomyPauseOnTimeout: 'free',
  autonomyPauseTtlMs: 'free', monitorIncremental: 'free', storagePolicy: 'free', turnIdleTimeoutMs: 'free',
  dismissedMcpIds: 'free', toolCatalogCacheTtlMs: 'free', runtimeFailureTelemetryV1: 'free', sessionSearchIndexV1: 'free',
  enableToolRequiresProbe: 'free', uiMode: 'free', outputStyle: 'free', stewardProviderId: 'free',
  stewardModel: 'free', stewardPollMs: 'free', stewardMaxTurnsPerHour: 'free', stewardMaxCostPerDay: 'free',
  stewardReadBudgetChars: 'free', stewardNotifyPerHour: 'free', stewardVisitIdleMinutes: 'free', stewardConversationRetention: 'free',
  stewardMaxParallelThreads: 'free', stewardGlobalMaxTurnsPerHour: 'free', stewardGlobalMaxCostPerDay: 'free',
  // ── confirm (93) 花钱／换执行主体／改「谁能不问就做什么」的边界／决定用户多久看见 —— 用户按一下按钮 ─────────────────────────────
  agentCliType: 'confirm', newThreadEngine: 'confirm', permissionMode: 'confirm', includeWorkbenchMcp: 'confirm',
  autoResumeClaudeSessions: 'confirm', model: 'confirm', compactProviderId: 'confirm', compactModel: 'confirm',
  contextWindowOverrides: 'confirm', maxTurns: 'confirm', thinkingBudget: 'confirm', claudeThinkingEffort: 'confirm',
  betaInterleavedThinking: 'confirm', engineMode: 'confirm', agentAutoModelTiering: 'confirm', knownModels: 'confirm',
  extraModels: 'confirm', discoverModelsFromProxy: 'confirm', modelsApiBase: 'confirm', activeProvider: 'confirm',
  asrProviderId: 'confirm', asrModel: 'confirm', asrStreamProviderId: 'confirm', asrStreamModel: 'confirm',
  asrFixMode: 'confirm', asrFixProviderId: 'confirm', asrFixModel: 'confirm', openaiMaxToolIterations: 'confirm',
  browserAutomation: 'confirm', externalMcpServers: 'confirm', toolLoadingMode: 'confirm', runtimeOptimizationShadowV1: 'confirm',
  runtimeToolRetrievalV1: 'confirm', runtimeObservationReducerV1: 'confirm', runtimeEvaporateBudgetBoundaryV1: 'confirm', runtimeHistoryReadDedupV1: 'confirm',
  runtimeSummaryPromptI18nV1: 'confirm', runtimeReseedTailUnitsV1: 'confirm', runtimeReseedReattachFilesV1: 'confirm', runtimeObservationRecallV1: 'confirm',
  runtimeSessionNotesV1: 'confirm', runtimeSessionNotesInjectV1: 'confirm', runtimeSessionNotesMergeV1: 'confirm', runtimeSummaryEntityCheckV1: 'confirm',
  runtimeEstimateBucketsV1: 'confirm', runtimeSummarySingleShotV1: 'confirm', summarySingleShotMaxOverridesV1: 'confirm', runtimeSummaryFactTableV1: 'confirm',
  summaryFactTableMaxSamplesV1: 'confirm', runtimeSummaryRefineV1: 'confirm', runtimeBudgetGuardV1: 'confirm', budgetGuardWarnRatioV1: 'confirm',
  runtimeToolTimeBudgetShadowV1: 'confirm', runtimeToolTimeBudgetV1: 'confirm', toolTimeBudgetWarnMsV1: 'confirm', toolTimeBudgetHardMsV1: 'confirm',
  toolByteBudgetShadowBytesV1: 'confirm', runtimeVolatileTailLayoutV1: 'confirm', runtimeAppendOnlyToolSchemasV1: 'confirm', runtimeExecResultCacheV1: 'confirm',
  execResultCacheMaxEntriesV1: 'confirm', runtimeMemoryVectorRecallV1: 'confirm', coreMemoryMaxItemsV1: 'confirm', coreMemoryCharBudgetV1: 'confirm',
  memoryRelevanceMaxV1: 'confirm', memoryFixedSelectionMaxV1: 'confirm', memoryIndexCharCapV1: 'confirm', toolEconomicsShadowV1: 'confirm',
  boundedReadSchedulerV1: 'confirm', boundedReadConcurrencyV1: 'confirm', metaToolHintsV1: 'confirm', actionArgumentModelViewV1: 'confirm',
  enableMcpDropIn: 'confirm', shellSessionMax: 'confirm', autoCompactThreshold: 'confirm', subagentMaxConcurrent: 'confirm',
  subagentMaxPerTurn: 'confirm', subagentPreferredProvider: 'confirm', subagentPreferredModel: 'confirm', stewardEnabledV1: 'confirm',
  stewardThreadBriefV1: 'confirm', stewardThreadModels: 'confirm', threadIndexRecent: 'confirm', stewardAutoActions: 'confirm',
  quietCardSnoozeMinutes: 'confirm', schedulerEnabledV1: 'confirm', schedulerAskWaitMinutes: 'confirm', agentWorkflowMaxNodes: 'confirm',
  agentNodeWrapUpMs: 'confirm', agentTaskPoolPolicy: 'confirm', agentTaskPoolAutoCap: 'confirm', usageBudget: 'confirm',
  claudePricing: 'confirm',
  // ── forbidden (39) 密钥、数据根与围栏、放行面、注入面、自我扩权、簿记与行为记录;含 Tokens 的三个键撞密钥正则 ─────────────────────────────
  configSchema: 'forbidden', configExplicitKeysV1: 'forbidden', version: 'forbidden', lastUsedEngineRoute: 'forbidden',
  claudePath: 'forbidden', kimiPath: 'forbidden', defaultWorkspace: 'forbidden', extraClaudeArgs: 'forbidden',
  allowCommandTools: 'forbidden', allowDesktopTools: 'forbidden', mcpCommandMode: 'forbidden', permissionBridge: 'forbidden',
  autonomyAutoResume: 'forbidden', modelsApiKey: 'forbidden', claudeAuthMode: 'forbidden', providers: 'forbidden',
  desktopMcp: 'forbidden', autoImportClaudeCodeMcp: 'forbidden', bridgeExternalToolsToProvider: 'forbidden', summarySingleShotMaxTokensV1: 'forbidden',
  budgetGuardTurnTokensV1: 'forbidden', toolbox: 'forbidden', bridgedToolTiers: 'forbidden', toolAllowRules: 'forbidden',
  capabilityProbeUrl: 'forbidden', residentSkills: 'forbidden', recentWorkspaces: 'forbidden', onboarding: 'forbidden',
  workspaces: 'forbidden', allowOutsideWorkspace: 'forbidden', stewardExemptDelegationV1: 'forbidden', stewardWorkspaceRoot: 'forbidden',
  stewardContextBudgetTokens: 'forbidden', agentRoleOverrides: 'forbidden', searchBackend: 'forbidden', appendSystemPrompt: 'forbidden',
  additionalDirectories: 'forbidden', subagentBudgetMigrated: 'forbidden', searchBackendMigrated: 'forbidden',
};

/* ═══════════ ⑤ 132b:free ∪ confirm 的每个键都有中英两句 help(模型改之前得知道它是什么) ═══════════ */
{
  const help = STEWARD_CONFIG_TIERS.help || {};
  const missing = [...STEWARD_CONFIG_TIERS.free, ...STEWARD_CONFIG_TIERS.confirm].filter(k => !Array.isArray(help[k]) || help[k].length !== 2 || !help[k][0] || !help[k][1]);
  ok(missing.length === 0, '⑤ free/confirm 每个键都有 [zh, en] 两句 help' + (missing.length ? ' → 缺 ' + missing.join(',') : ''));
  const stray = Object.keys(help).filter(k => !STEWARD_CONFIG_TIERS.free.includes(k) && !STEWARD_CONFIG_TIERS.confirm.includes(k));
  ok(stray.length === 0, '⑤b help 里没有不在两张表里的键(forbidden 键连一句话都不给)' + (stray.length ? ' → ' + stray.join(',') : ''));
}

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
  // 132b(53 号文 §2):白名单语义没变(判据仍是 fail-closed 的「不在两张表里」),但可写的不再是少数 ——
  // 用户拍板「尽量改更多」。钉住的是【结构】:forbidden 仍必须非空且盖住六类里点名的那些键(下面 ⑤ 逐个点名)。
  ok(counts.forbidden >= 30 && counts.free + counts.confirm >= 100,
    `② 132b 起可写是多数(free+confirm=${counts.free + counts.confirm})、forbidden 仍是一张实打实的表(${counts.forbidden})`);
  for (const key of ['providers', 'modelsApiKey', 'searchBackend', 'claudeAuthMode', 'defaultWorkspace', 'workspaces', 'stewardWorkspaceRoot',
    'allowOutsideWorkspace', 'additionalDirectories', 'claudePath', 'extraClaudeArgs', 'appendSystemPrompt', 'agentRoleOverrides', 'residentSkills',
    'allowCommandTools', 'allowDesktopTools', 'desktopMcp', 'toolAllowRules', 'bridgedToolTiers', 'mcpCommandMode', 'permissionBridge',
    'autonomyAutoResume', 'bridgeExternalToolsToProvider', 'toolbox', 'autoImportClaudeCodeMcp', 'capabilityProbeUrl', 'stewardExemptDelegationV1',
    'configSchema', 'configExplicitKeysV1', 'lastUsedEngineRoute']) {
    ok(stewardConfigTierFor(key) === 'forbidden', `② 点名 forbidden:${key}`);
  }
}

/* ═══════════ ① 两张表逐条自洽 ═══════════ */
for (const key of STEWARD_CONFIG_TIERS.free) ok(stewardConfigTierFor(key) === 'free', `① free 表条目 ${key} -> free`);
for (const key of STEWARD_CONFIG_TIERS.confirm) ok(stewardConfigTierFor(key) === 'confirm', `① confirm 表条目 ${key} -> confirm`);
ok(stewardConfigTierFor('someKeyNobodyEverDeclared') === 'forbidden', '① 未登记的键 -> forbidden(fail-closed)');

/* ═══════════ ⑤ 117w-W1 提交②:围栏三兄弟(§11.19.2)═══════════ */
// 「看得见 ≠ 改得了」是这一刀的整条脊梁:提交③ 会把 workspaces 的【只读投影】喂进管家上下文,
// 而 workspaces / stewardWorkspaceRoot / defaultWorkspace 三个键本身仍然一个都改不了。
// 单独钉是因为上面那张 EXPECTED 表是「有人加新键就红」的普查,普查绿了不等于这三个键被【点名】看住;
// 而且新键 stewardWorkspaceRoot 靠 fail-closed 落档 —— 哪天有人手滑把它写进 free 表,只有这一条会红。
for (const key of ['stewardWorkspaceRoot', 'workspaces', 'defaultWorkspace']) {
  ok(stewardConfigTierFor(key) === 'forbidden', `⑤ 围栏键 ${key} -> forbidden(steward_config_set 改不了)`);
  ok(!STEWARD_CONFIG_TIERS.free.includes(key) && !STEWARD_CONFIG_TIERS.confirm.includes(key),
    `⑤ ${key} 不在 free / confirm 任何一张白名单里`);
}
// 反向保护:出厂默认值真的是 ~/Ruyi(主目录的【子目录】,不是主目录本身 —— 03 的 cwdWarning
// 把主目录根判成最高风险目标,§11.19.5 选 A 的理由就在这)。
{
  const root = normalizeConfig({}).config.stewardWorkspaceRoot;
  ok(root === path.join(os.homedir(), 'Ruyi'), `⑤ 出厂 stewardWorkspaceRoot === ~/Ruyi(got ${root})`);
  ok(root !== os.homedir(), '⑤ 根不等于主目录本身(反向保护)');
  // 清洗:非绝对/空/非字符串一律回落出厂默认,绝不留一个相对路径进配置。
  for (const bad of ['', '   ', 'Ruyi', null, 42, { x: 1 }]) {
    ok(normalizeConfig({ stewardWorkspaceRoot: bad }).config.stewardWorkspaceRoot === path.join(os.homedir(), 'Ruyi'),
      `⑤ 非法根 ${JSON.stringify(bad)} -> 回落 ~/Ruyi`);
  }
  const custom = process.platform === 'win32' ? 'D:\\Work\\Ruyi' : '/srv/ruyi';
  ok(normalizeConfig({ stewardWorkspaceRoot: `"${custom}"` }).config.stewardWorkspaceRoot === custom,
    '⑤ 绝对路径原样留下,且「复制为路径」带的引号被剥掉(与 defaultWorkspace 同一口径)');
}
// workspaces[].note:新可选字段,trim + 截 80,缺省【不写字段】。
{
  const ws = p => normalizeConfig({ workspaces: [p] }).config.workspaces[0];
  const home = os.homedir();
  ok(ws({ path: home, note: '  股票资料  ' }).note === '股票资料', '⑤ note 被 trim');
  ok(ws({ path: home, note: 'x'.repeat(200) }).note.length === 80, '⑤ note 截到 80 字');
  ok(!('note' in ws({ path: home })), '⑤ 没给 note 就不写这个字段(老配置逐字节不变)');
  ok(!('note' in ws({ path: home, note: '   ' })), '⑤ 全空白的 note 不写字段');
  ok(!('note' in ws({ path: home, note: 42 })), '⑤ 非字符串 note 不写字段');
  ok(ws({ path: home, note: 'n' }).read === true && ws({ path: home, note: 'n' }).write === true,
    '⑤ 加了 note 不影响 rwx 三个标志(反向保护)');
}

/* ═══════ ⑥ 107-S1 ④（46 号文 §5 ⑦b H1）：confirm 族的 act 不许由模型命名 ═══════ */
// 判据【从这张分档表派生】，不是另一张手攒的工具名单 —— 所以它住在这份单测里：
// 上面那一段刚刚证过「默认表的每个键都落到三级之一、新增键默认 forbidden」，
// 下面这一段证「confirm 那一档一旦被 patch 命中，按钮就归服务端命名、并带确认清单」。
// 真浏览器那一半（面板弹出、不按不发请求、取消也不发）在 dev-harness/steward-conversation.e2e.js (S1) 段。
{
  const { stewardActConfirmSpec, stewardActLabel, stewardNormalizeAct } = srv;
  const brief = v => JSON.stringify(v === undefined ? null : v).slice(0, 240);
  const MODEL_LABEL = '好，我知道了';

  // ① 判据与 13l:701 同源：patch 里有 confirm 档的键才进本族。
  const confirmKey = STEWARD_CONFIG_TIERS.confirm[0];
  const freeKey = STEWARD_CONFIG_TIERS.free[0];
  ok(stewardConfigTierFor(confirmKey) === 'confirm' && stewardConfigTierFor(freeKey) === 'free', '⑥ 前提：两个样本键的档位如预期');
  const specConfirm = stewardActConfirmSpec('steward_config_set', { patch: { [confirmKey]: 'x' } });
  const specFree = stewardActConfirmSpec('steward_config_set', { patch: { [freeKey]: 'x' } });
  ok(specConfirm && JSON.stringify(specConfirm.keys) === JSON.stringify([confirmKey]) && specFree === null,
    `⑥ confirm 档的键进本族、free 档的不进（实得 ${brief([specConfirm, specFree])}）`);
  // 整份原子：confirm 键触发之后，清单给【整份 patch】，free 与 forbidden 的键也在里面（用户按下去时看到的是整份）。
  const mixed = stewardActConfirmSpec('steward_config_set', { patch: { [confirmKey]: 'x', [freeKey]: 'y', modelsApiKey: 'sk-' + 'a'.repeat(40) } });
  ok(mixed && mixed.items.length === 3 && mixed.keys.length === 1 && mixed.items.some(i => i.tier === 'forbidden'),
    `⑥ 清单给整份 patch（含 free / forbidden 的键），但只有 confirm 那些算触发键（实得 ${brief(mixed)}）`);

  // ② 标签：丢掉模型写的那句，改用服务端按 args 派生的说明（键＋新值）。
  const act = stewardNormalizeAct({ kind: 'tool', tool: 'steward_config_set', label: MODEL_LABEL, args: { patch: { permissionMode: 'auto' } } });
  ok(act && act.label === '改设置:permissionMode=auto' && act.label !== MODEL_LABEL,
    `⑥ 模型标签被丢掉，按钮上写的是「改设置:键=值」（实得 ${brief(act && act.label)}）`);
  ok(act && Array.isArray(act.confirmItems) && JSON.stringify(act.confirmItems) === JSON.stringify(['permissionMode = auto']),
    `⑥ act 带确认清单（纯文本「键 = 值」，前端只 textContent）（实得 ${brief(act && act.confirmItems)}）`);

  // ③ 密钥永不进标签与清单：forbidden 档的值只出 ••••（04 redact 另有一道，这是第一道）。
  const secret = 'sk-' + 'b'.repeat(40);
  // 【口径】只看给人看的那两处(标签与清单):act.args 里仍是模型原样给的 patch —— 它是执行用的载荷,
  // 掩了就写不进去了,而且那份 args 修前修后逐字节相同(S1 没有新增这一面)。
  const keyAct = stewardNormalizeAct({ kind: 'tool', tool: 'steward_config_set', label: MODEL_LABEL, args: { patch: { permissionMode: 'auto', modelsApiKey: secret } } });
  const keyShown = JSON.stringify([keyAct && keyAct.label, keyAct && keyAct.confirmItems]);
  ok(keyAct && !keyShown.includes(secret) && keyAct.confirmItems.some(line => line === 'modelsApiKey = ••••'),
    `⑥ forbidden 档的值在标签与清单里都只剩 ••••（实得 ${brief(keyAct && keyAct.confirmItems)}）`);
  // 值也过一遍 04 的 redact：confirm 档的键带着密钥形态的值时同样不许原样打出来。
  const embedded = stewardNormalizeAct({ kind: 'tool', tool: 'steward_config_set', label: MODEL_LABEL, args: { patch: { modelsApiBase: 'https://u:' + 'p'.repeat(12) + '@h/v1', permissionMode: 'auto' } } });
  const embeddedShown = JSON.stringify([embedded && embedded.label, embedded && embedded.confirmItems]);
  ok(embedded && !embeddedShown.includes('p'.repeat(12)) && embeddedShown.includes('«redacted»'),
    `⑥ confirm 档键的值也过 redact（URL 里的 user:pass 没了）（实得 ${brief(embedded && embedded.confirmItems)}）`);

  // ④ 另外两支：技能开关恒进本族；线程权限只在放宽桌面那一支进，且标签一个字没动（guardrails Q2c 钉着它）。
  const skillAct = stewardNormalizeAct({ kind: 'tool', tool: 'steward_skill_toggle', label: MODEL_LABEL, args: { sessionId: 'sess_a', skills: [{ id: 'web' }] } });
  ok(skillAct && skillAct.label !== MODEL_LABEL && skillAct.label.startsWith('改技能:') && JSON.stringify(skillAct.confirmItems) === JSON.stringify(['skills = ["web"]']),
    `⑥ 改技能:模型标签被丢掉、清单列出技能（实得 ${brief(skillAct)}）`);
  const deskAct = stewardNormalizeAct({ kind: 'tool', tool: 'steward_thread_permission', label: MODEL_LABEL, args: { sessionId: 'sess_a', capabilities: { desktop: true } } });
  ok(deskAct && deskAct.label === '给它开桌面' && JSON.stringify(deskAct.confirmItems) === JSON.stringify(['capabilities.desktop = true']),
    `⑥ 给它开桌面:标签逐字未改、另带确认清单（实得 ${brief(deskAct)}）`);
  const tightenAct = stewardNormalizeAct({ kind: 'tool', tool: 'steward_thread_permission', label: MODEL_LABEL, args: { sessionId: 'sess_a', permissionMode: 'default' } });
  ok(tightenAct && tightenAct.label === MODEL_LABEL && !('confirmItems' in tightenAct),
    `⑥ 收紧档位那一支不在本族（不出按钮，也不改既有行为）（实得 ${brief(tightenAct)}）`);

  // ⑤ 其余 act 逐字节不变：模型标签仍然优先，零 confirmItems。
  const others = [
    ['tool', { kind: 'tool', tool: 'steward_decide', label: '允许', args: { action: 'allow' } }, '允许'],
    ['open_thread', { kind: 'open_thread', label: '打开「A」', sessionId: 'sess_abc' }, '打开「A」'],
    ['dismiss', { kind: 'dismiss', label: MODEL_LABEL }, MODEL_LABEL],
    ['thread_new', { kind: 'tool', tool: 'steward_thread_new', label: '我去办', args: { text: 'x' } }, '我去办'],
  ];
  const drifted = others.filter(([, raw, want]) => { const a = stewardNormalizeAct(raw); return !a || a.label !== want || ('confirmItems' in a); });
  ok(drifted.length === 0, `⑥ 其余 ${others.length} 种 act 的标签仍由模型说了算、零 confirmItems`
    + (drifted.length ? ' → 漂移: ' + drifted.map(([n, raw]) => n + '=' + brief(stewardNormalizeAct(raw))).join(' | ') : ''));
  // 模型自己在 args 外塞 confirmItems 不作数(与 userPressed 同一条纪律:归一化只从零重建)。
  const forged = stewardNormalizeAct({ kind: 'tool', tool: 'steward_decide', label: '允许', args: { action: 'allow' }, confirmItems: ['随便'] });
  ok(forged && !('confirmItems' in forged), `⑥ 模型伪造的 confirmItems 进不来（实得 ${brief(forged)}）`);
  ok(stewardActLabel('steward_config_set', {}) === '改设置' && stewardActLabel('steward_config_set', { patch: {} }) === '改设置',
    '⑥ 没有 patch / 空 patch 时标签回落到既有总称「改设置」');
}

// ⑦ 133d(用户 2026-09-21 拍板:管家开的线程只走 OpenAI 兼容端点,两个 CLI 只作工作台里的兼容):回落顺序的纯函数直测。
{
  const { stewardOpenAiFallback } = srv;
  ok(typeof stewardOpenAiFallback === 'function', '⑦ stewardOpenAiFallback 已导出');
  const providers = [
    { id: 'toolbox-asr-shim', label: 'shim', baseUrl: 'http://127.0.0.1:1', model: 'qwen3-asr-auto', models: [{ id: 'qwen3-asr-auto', caps: ['asr'] }] },
    { id: 'voice-only', label: 'V', baseUrl: 'http://127.0.0.1:2', model: 'whisper-1', models: [{ id: 'whisper-1', caps: ['asr'] }] },
    { id: 'ds', label: 'DS', baseUrl: 'http://127.0.0.1:3', model: 'ds-flash', models: [{ id: 'ds-flash' }, { id: 'ds-pro' }] },
    { id: 'mimo', label: 'MiMo', baseUrl: 'http://127.0.0.1:4', model: 'mimo-1', models: [{ id: 'mimo-1' }, { id: 'mimo-asr', caps: ['asr'] }] },
  ];
  const r1 = stewardOpenAiFallback({ providers, activeProvider: '', agentCliType: 'kimi' });
  ok(r1 && r1.providerId === 'ds' && r1.model === 'ds-flash' && r1.source === 'first', `⑦ 全局是 CLI、别的都没配 → 第一个能对话的端点(跳过 toolbox- 与只做语音的)(实得 ${JSON.stringify(r1)})`);
  const r2 = stewardOpenAiFallback({ providers, activeProvider: 'claude-cli', stewardProviderId: 'mimo', stewardModel: '' });
  ok(r2 && r2.providerId === 'mimo' && r2.model === 'mimo-1' && r2.source === 'steward', `⑦ 管家自己的端点优先,模型空则用该端点缺省(实得 ${JSON.stringify(r2)})`);
  const r3 = stewardOpenAiFallback({ providers, activeProvider: 'ds', stewardProviderId: 'gone' });
  ok(r3 && r3.providerId === 'ds' && r3.source === 'global', `⑦ 管家端点已删 → 全局主端点(是 OpenAI 时)(实得 ${JSON.stringify(r3)})`);
  const r4 = stewardOpenAiFallback({ providers, activeProvider: '', lastUsedEngineRoute: { engine: 'openai', providerId: 'mimo', model: 'mimo-1' } });
  ok(r4 && r4.providerId === 'mimo' && r4.source === 'last', `⑦ 全局是 CLI → 用户上次用的 OpenAI 路由(实得 ${JSON.stringify(r4)})`);
  const r5 = stewardOpenAiFallback({ providers, activeProvider: '', lastUsedEngineRoute: { engine: 'agent', agentCliType: 'claude', model: '' } });
  ok(r5 && r5.providerId === 'ds' && r5.source === 'first', '⑦ 上次用的是 CLI 路由 → 不算,继续往下挑');
  ok(stewardOpenAiFallback({ providers: providers.slice(0, 2), activeProvider: '' }) === null, '⑦ 只有 toolbox-／只做语音的端点 → null(调用方留全局并记审计)');
  ok(stewardOpenAiFallback({ providers, activeProvider: 'voice-only' }).providerId === 'ds', '⑦ 全局主端点只做语音 → 不算');
  ok(stewardOpenAiFallback({}) === null && stewardOpenAiFallback(null) === null, '⑦ 空配置不抛');
  // 机械锁:三个开线程的口都经 13q 的 ensureOpenAiRoute,13t 没指定档位也兜。
  const fs2 = require('fs');
  const src13q = fs2.readFileSync(path.join(app, 'src', '13q-steward-runner-turn.js'), 'utf8');
  const src13t = fs2.readFileSync(path.join(app, 'src', '13t-steward-schedule.js'), 'utf8');
  ok(src13q.includes("route = stewardEnsureOpenAiRoute(session, config, decided.tier);") && src13q.includes("if (current && current.engine === 'openai') return current;"),
    '⑦ 13q:档位没配 → ensureOpenAiRoute;已是 OpenAI 路由一字不动');
  ok(src13t.includes("stewardEnsureOpenAiRoute(session, config, '')") && !src13t.includes('StewardHooks.ensureOpenAiRoute'), '⑦ 13t 没指定档位也经同一个函数(直接调,不进 StewardHooks 表)');
}

console.log('');
if (fail) { console.log(`STEWARD CONFIG TIER UNIT: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD CONFIG TIER UNIT: ALL PASS');
process.exit(0);
