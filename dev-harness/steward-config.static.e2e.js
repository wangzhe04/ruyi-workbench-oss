#!/usr/bin/env node
'use strict';
// 静态锁 + 一处真实回环:第 116 波 116a(27 号文 §11.3)——管家(Steward)11 个新配置键(116h 追加
// 3 个仲裁键,共 14)与
// 06i-steward-core.js 的落点契约。
//
// 断言四个方向:
//   ① 01-config.js 源码正则锁:11 个键的默认值字面量、stewardEnabledV1 严格布尔归一、
//      stewardConversationRetention 枚举、各数字键的 clamp 上下限字面量。不写绝对行号,
//      走「read(path.join(SRC,'01-config.js')) + 正则」的既有静态锁写法(ENGINEERING-SPEC §6)。
//   ② manifest.json:06i-steward-core.js 紧跟在 06h-retrieval-index.js 之后。
//   ③ 06i-steward-core.js 源码:StewardHooks / STEWARD_EVENT_KINDS 五类 / stewardMayAct /
//      buildStewardDigestLine 存在,且模块零 require(引擎层纯函数不得反向拉传输/工具层)。
//   ④ 一处真实回环(非静态):临时 HOME 下 require server.js,对含全部非法值的 config 跑一次
//      normalizeConfig 得到 11 个键的默认值,再跑一次确认 changed===false(幂等)。
//
// 判定行:`STEWARD CONFIG STATIC E2E: ALL PASS`。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'ruyi-workbench', 'app');
const SRC = path.join(APP, 'src');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

/* ═══════════════════════ ① 01-config.js 源码正则锁 ═══════════════════════ */

const configSrc = fs.readFileSync(path.join(SRC, '01-config.js'), 'utf8');

ok(/stewardEnabledV1:\s*false,/.test(configSrc), '默认值: stewardEnabledV1=false');
ok(/stewardProviderId:\s*'',/.test(configSrc), "默认值: stewardProviderId=''");
ok(/stewardModel:\s*'',/.test(configSrc), "默认值: stewardModel=''(在 stewardProviderId 之后,与 subagent 写法对齐)");
ok(/stewardPollMs:\s*15000,/.test(configSrc), '默认值: stewardPollMs=15000');
// 117m-A1 重钉(用户第六轮走查⑦):默认值 12 → 30。12 是 116a 拍脑袋的保守值,真机上被「代批风暴」
// 15 分钟吃光(11 条 steward_decision),于是用户那两句「还在正常运转吗」撞上熔断。重钉的同时补两条
// 【更强】的伴随断言:默认表与 sanitize 兜底必须是同一个数(B10b),且 clamp 区间一字未动(下面 clampChecks)。
ok(/stewardMaxTurnsPerHour:\s*30,/.test(configSrc), '默认值: stewardMaxTurnsPerHour=30(117m-A1 从 12 抬到 30)');
{
  const declared = (configSrc.match(/stewardMaxTurnsPerHour:\s*(\d+),/) || [])[1];
  const fallback = (configSrc.match(/Math\.min\(120, Math\.max\(1, Math\.round\(n\)\)\) : (\d+);/) || [])[1];
  ok(declared === '30' && fallback === '30',
    `默认值: stewardMaxTurnsPerHour 的默认表与 sanitize 兜底是同一个数(默认表 ${declared} / 兜底 ${fallback})—— 两处漂移会让「缺省」和「填了垃圾」落到不同上限`);
}
// 存量配置【不迁移】:normalizeConfig 只在值缺失/非法时才写默认值,合法的旧值(含 12)原样保留 ——
// 静默抬高别人的花钱上限不合适。下面 c1 那一段的 clamp 断言就是这条纪律的机器证据。
ok(/if \(clamped !== config\.stewardMaxTurnsPerHour\) \{ config\.stewardMaxTurnsPerHour = clamped; changed = true; \}/.test(configSrc),
  'sanitize: 合法的存量值原样保留(只有 clamp 后不同才回写 —— 抬高默认值不会动老用户已有的上限)');
ok(/stewardMaxCostPerDay:\s*1,/.test(configSrc), '默认值: stewardMaxCostPerDay=1');
ok(/stewardAutoActions:\s*\{\s*retry:\s*true,\s*resume:\s*null,\s*relay:\s*false,\s*newThread:\s*true\s*\},/.test(configSrc),
  "默认值: stewardAutoActions={retry:true,resume:null,relay:false,newThread:true}");
ok(/stewardContextBudgetTokens:\s*200000,/.test(configSrc), '默认值: stewardContextBudgetTokens=200000');
ok(/stewardReadBudgetChars:\s*48000,/.test(configSrc), '默认值: stewardReadBudgetChars=48000');
ok(/stewardVisitIdleMinutes:\s*60,/.test(configSrc), '默认值: stewardVisitIdleMinutes=60');
ok(/stewardConversationRetention:\s*'visit',/.test(configSrc), "默认值: stewardConversationRetention='visit'");
// 116h(27 号文 §3.1 116h 行;用户 2026-09-03 拍板「默认 5、设置可调」):线程间仲裁三个全局闸。
ok(/stewardMaxParallelThreads:\s*5,/.test(configSrc), '默认值: stewardMaxParallelThreads=5(116h 用户拍板)');
ok(/stewardGlobalMaxTurnsPerHour:\s*120,/.test(configSrc), '默认值: stewardGlobalMaxTurnsPerHour=120');
ok(/stewardGlobalMaxCostPerDay:\s*20,/.test(configSrc), '默认值: stewardGlobalMaxCostPerDay=20');

// stewardEnabledV1 严格布尔归一(=== true),不是宽松真值判断。
ok(/const b = config\.stewardEnabledV1 === true;/.test(configSrc),
  'sanitize: stewardEnabledV1 严格布尔(=== true)归一');

// stewardConversationRetention 枚举 visit/24h/forever。
ok(/\['visit', '24h', 'forever'\]\.includes\(config\.stewardConversationRetention\)/.test(configSrc),
  "sanitize: stewardConversationRetention 枚举 ['visit','24h','forever']");

// 数字键 clamp 上下限字面量(逐个断言,防止有意/无意漂移;含 Math.round(n) 嵌套括号,按实际写法逐字匹配)。
const clampChecks = [
  { label: 'stewardPollMs clamp [5000,120000]', re: /Math\.min\(120000, Math\.max\(5000, Math\.round\(n\)\)\) : 15000;/ },
  { label: 'stewardMaxTurnsPerHour clamp [1,120]', re: /Math\.min\(120, Math\.max\(1, Math\.round\(n\)\)\) : 30;/ }, // 117m-A1:区间 [1,120] 一字未动,只有兜底默认 12→30
  { label: 'stewardMaxCostPerDay clamp [0,1000]', re: /Math\.min\(1000, Math\.max\(0, n\)\) : 1;/ },
  { label: 'stewardContextBudgetTokens clamp [16000,2000000]', re: /Math\.min\(2000000, Math\.max\(16000, Math\.round\(n\)\)\) : 200000;/ },
  { label: 'stewardReadBudgetChars clamp [4000,400000]', re: /Math\.min\(400000, Math\.max\(4000, Math\.round\(n\)\)\) : 48000;/ },
  { label: 'stewardVisitIdleMinutes clamp [5,1440]', re: /Math\.min\(1440, Math\.max\(5, Math\.round\(n\)\)\) : 60;/ },
  { label: 'stewardMaxParallelThreads clamp [1,32]', re: /Math\.min\(32, Math\.max\(1, Math\.round\(n\)\)\) : 5;/ },
  { label: 'stewardGlobalMaxTurnsPerHour clamp [1,2000]', re: /Math\.min\(2000, Math\.max\(1, Math\.round\(n\)\)\) : 120;/ },
  { label: 'stewardGlobalMaxCostPerDay clamp [0,10000]', re: /Math\.min\(10000, Math\.max\(0, n\)\) : 20;/ },
];
for (const c of clampChecks) ok(c.re.test(configSrc), `sanitize: ${c.label}`);

// stewardAutoActions:resume 三态(true/false/null),retry/relay/newThread 严格布尔各自回默认。
ok(/raw0\.resume\s*===\s*true\s*\|\|\s*raw0\.resume\s*===\s*false\s*\|\|\s*raw0\.resume\s*===\s*null/.test(configSrc),
  'sanitize: stewardAutoActions.resume 三态 true/false/null');
ok(/typeof raw0\.retry === 'boolean' \? raw0\.retry : DEF_AA\.retry/.test(configSrc),
  'sanitize: stewardAutoActions.retry 严格布尔回该键默认');
ok(/typeof raw0\.relay === 'boolean' \? raw0\.relay : DEF_AA\.relay/.test(configSrc),
  'sanitize: stewardAutoActions.relay 严格布尔回该键默认');
ok(/typeof raw0\.newThread === 'boolean' \? raw0\.newThread : DEF_AA\.newThread/.test(configSrc),
  'sanitize: stewardAutoActions.newThread 严格布尔回该键默认');

// CONFIG_SCHEMA 未被本波改动(116a 纪律:不 bump)。
ok(/const CONFIG_SCHEMA = 11;/.test(fs.readFileSync(path.join(SRC, '00-boot.js'), 'utf8')),
  'CONFIG_SCHEMA 仍为 11(116a 不 bump)');

/* ═══════════════════════ ② manifest.json 落点 ═══════════════════════ */

const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const files = manifest.modules.map(m => (typeof m === 'string' ? m : m.file));
const idxH = files.indexOf('06h-retrieval-index.js');
const idxI = files.indexOf('06i-steward-core.js');
const idxD = files.indexOf('06d-memory-domain.js');
ok(idxH >= 0 && idxI === idxH + 1, '06i-steward-core.js 紧跟在 06h-retrieval-index.js 之后');
ok(idxD >= 0 && idxD === idxI + 1, '06d-memory-domain.js 紧跟在 06i-steward-core.js 之后(06i 插在两者之间)');

/* ═══════════════════════ ③ 06i-steward-core.js 源码契约 ═══════════════════════ */

const stewardSrc = fs.readFileSync(path.join(SRC, '06i-steward-core.js'), 'utf8');
ok(/const StewardHooks = \{\};/.test(stewardSrc), '06i 声明空的延迟绑定命名空间 StewardHooks = {}');
ok(/const STEWARD_EVENT_KINDS = Object\.freeze\(\['needs_you', 'failed', 'done', 'stalled', 'budget'\]\);/.test(stewardSrc),
  '06i 声明 STEWARD_EVENT_KINDS 五类白名单并冻结');
ok(/function stewardMayAct\(permissionMode, eventKind, toolTier\)/.test(stewardSrc), '06i 声明 stewardMayAct(permissionMode, eventKind, toolTier)');
ok(/function buildStewardDigestLine\(thread\)/.test(stewardSrc), '06i 声明 buildStewardDigestLine(thread)');
ok(!/require\(/.test(stewardSrc), '06i 零 require(纯函数层,不反向拉传输/工具层模块)');

/* ═══════════════════════ ④ 一处真实回环:normalizeConfig 幂等 ═══════════════════════ */

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-config-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = tmpHome;
const srv = require(path.join(APP, 'server.js'));

const dirty = {
  ...srv.defaultConfig(),
  stewardEnabledV1: 'yes',            // 非严格布尔 -> false
  stewardProviderId: 42,              // 非字符串,但 String(42)='42' 是合法结果(与 subagentPreferredProvider 同口径,非类型白名单)
  stewardModel: 'm'.repeat(300),      // 超长(无空白,避免 trim+slice 边界巧合截出尾随空格的伪失败) -> 截断到 160
  stewardPollMs: 1,                   // 越界低 -> clamp 到 5000(注:1 非法? 是有限数,故 clamp 而非回默认)
  stewardMaxTurnsPerHour: -5,         // 越界低 -> clamp 到 1
  stewardMaxCostPerDay: 'free',       // 非数字 -> 回默认 1
  stewardAutoActions: { retry: 'yes', resume: 'sometimes', relay: 1, newThread: false, extraJunkKey: 'drop-me' },
  stewardContextBudgetTokens: 999999999, // 越界高 -> clamp 到 2000000
  stewardReadBudgetChars: -100,        // 越界低 -> clamp 到 4000
  stewardVisitIdleMinutes: 99999,      // 越界高 -> clamp 到 1440
  stewardConversationRetention: 'never', // 非法枚举 -> 回默认 'visit'
  stewardMaxParallelThreads: 999,      // 越界高 -> clamp 到 32
  stewardGlobalMaxTurnsPerHour: 0,     // 越界低 -> clamp 到 1
  stewardGlobalMaxCostPerDay: 'lots',  // 非数字 -> 回默认 20
};

const first = srv.normalizeConfig(dirty);
const c1 = first.config;
ok(c1.stewardEnabledV1 === false, "非法 stewardEnabledV1='yes' 归一为 false");
ok(c1.stewardProviderId === '42', 'stewardProviderId=42 经 String() 归一为字符串(与 subagentPreferredProvider 同口径)');
ok(c1.stewardModel.length === 160, 'stewardModel 超长截断到 160 字符');
ok(c1.stewardPollMs === 5000, 'stewardPollMs=1 clamp 到下限 5000');
ok(c1.stewardMaxTurnsPerHour === 1, 'stewardMaxTurnsPerHour=-5 clamp 到下限 1');
ok(c1.stewardMaxCostPerDay === 1, "非法 stewardMaxCostPerDay='free' 回默认 1");
ok(c1.stewardAutoActions.retry === true && c1.stewardAutoActions.resume === null && c1.stewardAutoActions.relay === false
  && c1.stewardAutoActions.newThread === false && !('extraJunkKey' in c1.stewardAutoActions),
  'stewardAutoActions:非布尔回默认、resume 非三态回 null、未知键丢弃、合法布尔 false 被尊重');
ok(c1.stewardContextBudgetTokens === 2000000, 'stewardContextBudgetTokens 越界高 clamp 到 2000000');
ok(c1.stewardReadBudgetChars === 4000, 'stewardReadBudgetChars 越界低 clamp 到 4000');
ok(c1.stewardVisitIdleMinutes === 1440, 'stewardVisitIdleMinutes 越界高 clamp 到 1440');
ok(c1.stewardConversationRetention === 'visit', "非法枚举 'never' 回默认 'visit'");
ok(c1.stewardMaxParallelThreads === 32, 'stewardMaxParallelThreads 越界高 clamp 到 32');
ok(c1.stewardGlobalMaxTurnsPerHour === 1, 'stewardGlobalMaxTurnsPerHour=0 clamp 到下限 1');
ok(c1.stewardGlobalMaxCostPerDay === 20, "非法 stewardGlobalMaxCostPerDay='lots' 回默认 20");
// 116h:仲裁只在开关开时生效 —— 默认配置里开关仍是关的,所以这三个键对存量用户是纯形状扩张。
ok(srv.defaultConfig().stewardEnabledV1 === false && srv.defaultConfig().stewardMaxParallelThreads === 5,
  '116h:默认配置仍是「管家关 + 并发上限 5」(关时仲裁根本不参与回合)');

const second = srv.normalizeConfig(c1);
ok(second.changed === false, '同一个已归一 config 再跑一次 normalizeConfig -> changed===false(幂等)');
const c2 = second.config;
ok(JSON.stringify(c2.stewardAutoActions) === JSON.stringify(c1.stewardAutoActions), 'stewardAutoActions 二次归一内容不变');
for (const key of ['stewardEnabledV1', 'stewardProviderId', 'stewardModel', 'stewardPollMs', 'stewardMaxTurnsPerHour',
  'stewardMaxCostPerDay', 'stewardContextBudgetTokens', 'stewardReadBudgetChars', 'stewardVisitIdleMinutes', 'stewardConversationRetention',
  'stewardMaxParallelThreads', 'stewardGlobalMaxTurnsPerHour', 'stewardGlobalMaxCostPerDay']) {
  ok(c2[key] === c1[key], `${key} 二次归一后值不变(幂等)`);
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort tmpdir cleanup */ }

console.log('\nSTEWARD CONFIG STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);
