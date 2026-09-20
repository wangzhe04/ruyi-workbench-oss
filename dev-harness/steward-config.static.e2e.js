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

// 121 波 K0 重钉(34 号文 §8.4 拍板③):默认关 → 默认开,管家视角成为默认入口。
// 归一口径【不动】(=== true,见下面 ④ 的 'yes' -> false),这里钉的只是默认表那一个值。
ok(/stewardEnabledV1:\s*true,/.test(configSrc), '默认值: stewardEnabledV1=true(121 波 K0 从 false 翻转)');
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
// 129g 加了第五格 answer(代答),**默认关** —— 它独立于 relay:勾「事项内自动交接」不该顺带
// 把「替我回答线程的提问」也给出去(一格两权,用户按的时候看不见第二个)。
ok(/stewardAutoActions:\s*\{\s*retry:\s*true,\s*resume:\s*null,\s*relay:\s*false,\s*newThread:\s*true,\s*answer:\s*false\s*\},/.test(configSrc),
  "默认值: stewardAutoActions={retry:true,resume:null,relay:false,newThread:true,answer:false}");
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
ok(/typeof raw0\.answer === 'boolean' \? raw0\.answer : DEF_AA\.answer/.test(configSrc),
  'sanitize: stewardAutoActions.answer 严格布尔回该键默认');

// ── 129g 机械锁:自理清单的每一格都必须出现在设置界面的 autoPatch() 名单里 ─────────────────
// 漏一格不是「界面少一个勾选框」那么轻:steward-settings.js 的 autoPatch() **整份覆写**
// stewardAutoActions,名单里没有的键会被 01-config 补成默认值 —— 用户明明开着的那一格,
// 随手勾一下旁边任何一个框就被【静默重置】,而界面上什么都看不出来。
// 判据从后端 DEF_AA 推,不抄第二份名单:名单是手维护的,手维护的名单一定会漏(本仓已四次)。
{
  const m = configSrc.match(/const DEF_AA = \{([^}]*)\}/);
  ok(Boolean(m), '129g-lock0 扫得到 DEF_AA(扫不到 = 本条静默失效)');
  const keys = m ? [...m[1].matchAll(/(\w+):/g)].map(x => x[1]) : [];
  ok(keys.length === 5, `129g-lock1 自理清单当前 5 格(实得 ${keys.length}: ${keys.join('/')})`);
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'js', 'steward-settings.js'), 'utf8');
  const patchAt = settingsSrc.indexOf('const autoPatch = ()');
  const patch = patchAt < 0 ? '' : settingsSrc.slice(patchAt, patchAt + 1400);
  ok(patch.length > 100 && /newThread:/.test(patch),
    '129g-lock2 扫得到 autoPatch() 的整个函数体(扫不全 = 本条静默失效,会把没截到的那几格误报成「漏了」)');
  // 判据里【一个反斜杠都不写】:这条断言的第一版写成 new RegExp('\\b' + k + ':'),经补丁脚本落盘时
  // 反斜杠被吃掉,JS 里变成一个真的退格符,于是五格全部「找不到」—— 一条本该看住别人的锁自己先坏了。
  const missing = keys.filter(k => !new RegExp('(^|[^A-Za-z0-9_])' + k + ':').test(patch));
  ok(missing.length === 0,
    `129g-lock3 每一格都在 autoPatch() 里(漏的那格会被界面静默重置;缺: ${JSON.stringify(missing)})`);
}

// CONFIG_SCHEMA:116a 自己不 bump(纪律未变),但常量全仓共用 —— 107-T1 为 126-111b/d/e 的一次性
// 迁移把它 11 → 12(46 号文 §5)。本条继续钉【当前值】,好让「谁又动了它」还是红的;116a 真正要守的
// 「管家那批键没有任何 schema 迁移分支」由下一条钉住。
// 128a 又把它 12 → 13(稀疏落盘,48 号文 §2;13 本身不挂迁移)。
ok(/const CONFIG_SCHEMA = 13;/.test(fs.readFileSync(path.join(SRC, '00-boot.js'), 'utf8')),
  'CONFIG_SCHEMA 当前为 13(116a 自己不 bump;11→12 是 107-T1 为 126-111b/d/e 迁移抬的;12→13 是 128a 稀疏落盘)');
{
  const branches = configSrc.split(/\r?\n/).filter(l => /incomingConfigSchema\s*</.test(l));
  ok(branches.length >= 1, `扫得到 incomingConfigSchema 迁移分支（实得 ${branches.length} 处；扫不到 = 本条静默失效）`);
  ok(!branches.some(l => /steward/i.test(l)), `116a 的管家键仍然没有任何 schema 迁移分支${branches.filter(l => /steward/i.test(l)).map(s => s.trim()).join(' ⏐ ')}`);
}

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
// 121-K3(34 号文 §4.4「交接」):五类 -> 六类,表尾加 adopted(用户把线程交给管家盯)。
// 前五类的字面量与顺序仍然逐字钉住 —— 到访摘要(13q stewardVisitDigest)按本表顺序归纳,
// 插在中间或改顺序会改既有摘要的行序,所以「表尾追加」这件事本身也要钉。
// 123-M2(37 号文 §3.5):六类 -> 七类,表尾再加 reminder(定时任务的三件事:到点提醒 / 错过跳过 /
// 连败熔断)。同样只许追加在表尾,理由与 121-K3 逐字相同。
ok(/const STEWARD_EVENT_KINDS = Object\.freeze\(\['needs_you', 'failed', 'done', 'stalled', 'budget', 'adopted', 'reminder'\]\);/.test(stewardSrc),
  '06i 声明 STEWARD_EVENT_KINDS 七类白名单并冻结(121-K3 表尾加 adopted、123-M2 表尾加 reminder)');
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
// 116h:仲裁只在开关开时生效。121 波 K0 把总开关默认翻成开 —— 于是【新装】默认就带仲裁,
// 存量用户(config.json 里已显式落 false)不变。并发上限仍是 5,这一条没跟着动。
ok(srv.defaultConfig().stewardEnabledV1 === true && srv.defaultConfig().stewardMaxParallelThreads === 5,
  '121-K0:默认配置是「管家开 + 并发上限 5」(仲裁随默认开一起生效)');

// 128a(48 号文 §2):changed 的判据改成「落盘投影与传进来的 raw 是否不同」(= 该不该写盘)。整份内存视图
// 再跑一次,投影必然与它不同(投影是稀疏的),所以幂等要钉的是【盘上那份】:投影再归一化一遍不再触发写盘,
// 两次投影逐字相同,且内存视图里 14 个管家键的值不变。
const second = srv.normalizeConfig(JSON.parse(JSON.stringify(first.persisted)));
ok(second.changed === false && JSON.stringify(second.persisted) === JSON.stringify(first.persisted)
  && ['stewardReadBudgetChars', 'stewardConversationRetention', 'stewardMaxParallelThreads', 'stewardGlobalMaxCostPerDay'].every(k => second.config[k] === c1[k]),
  '同一份落盘投影再跑一次 normalizeConfig -> changed===false、投影逐字不变(幂等)');
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
