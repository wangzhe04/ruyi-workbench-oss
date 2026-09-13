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

  // ── forbidden(117l D7 新键,只加不改)────────────────────────────────────
  // stewardThreadModels = 管家新开线程默认用哪个端点/哪个模型。**故意不进 free 也不进 confirm**:
  // 让模型能改「下一条线程用哪个模型」等于让它自己换自己的执行主体(而且是绕过 activeProvider 那
  // 一条 confirm 门的第二条路)。这一档只能由用户在设置页里改(POST /api/config 那条路仍然通)。
  // 与 §11.9 D7 的拍板一字对应:「模型不能经 steward_config_set 改这两个键」。
  stewardThreadModels: 'forbidden',
  // 121-K3(34 号文 §4.1/§4.2):任务索引「最近 N 条」窗口。**故意留在 forbidden**(= 不登记,
  // 由 stewardConfigTierFor 的 fail-closed 兜底):它决定管家自己在总览里【看得见几条线程】,
  // 让模型能改它 = 让它自己调大自己的注意力面 —— 那是一个会连锁影响每一次到访成本的旋钮,
  // 而用户在设置页改它随时一眼看得见、一键改回。与 stewardThreadModels 同一条理由。
  threadIndexRecent: 'forbidden',
  // 123-M1(37 号文 §3.2/§3.4):定时任务调度器的两个键。**都故意留在 forbidden**
  // (= 不登记,由 fail-closed 兜底,与 threadIndexRecent 同一条理由):
  //   · schedulerEnabledV1 —— 它是「管家有没有一个能守时的身体」这件事本身的总开关;
  //     让模型能关掉它 = 让它把用户已经答应下来的每一条承诺一起静默作废。
  //   · schedulerAskWaitMinutes —— 它是无人值守遇 ask 时【等多久再拒】的窗口。窗口本身不放行
  //     (到时永远是拒),但让模型能把它拉到 240 分钟,等于让它自己决定「用户还有多久会看见这件事」。
  // 两个键用户都能在设置页里改;管家要改就得说服用户去点。M2 若要把其中之一放进 free/confirm,
  // 得在 06i 的 STEWARD_CONFIG_TIERS 里显式登记,并回来改这张表 —— 那就是一次显式的权限扩张。
  schedulerEnabledV1: 'forbidden',
  schedulerAskWaitMinutes: 'forbidden',

  // ── forbidden(fail-closed:以下每一个都【不】在两张表里,逐条写明是为了留一份可读的账)──
  configSchema: 'forbidden', version: 'forbidden',
  claudePath: 'forbidden', kimiPath: 'forbidden', extraClaudeArgs: 'forbidden',
  defaultWorkspace: 'forbidden', workspaces: 'forbidden', recentWorkspaces: 'forbidden',
  // 117w-W1 提交②(27 号文 §11.19.2):Ruyi 默认工作区【根】。围栏类键 —— 它决定「管家省略 cwd 时
  // 线程被派生到哪」,能改它就等于能把新线程指到任意目录去。没有额外登记,靠 fail-closed 落 forbidden;
  // 下面另有一条【显式】断言把这个事实钉死(新增键忘了判断时,那条也会红)。
  stewardWorkspaceRoot: 'forbidden',
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

console.log('');
if (fail) { console.log(`STEWARD CONFIG TIER UNIT: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD CONFIG TIER UNIT: ALL PASS');
process.exit(0);
