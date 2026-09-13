#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
// 静态锁（第 123 波 M2 §3.6；37 号文判据第四条）：定时任务界面的三条纪律与两处「值域必须对齐」。
//
// ① 零 innerHTML —— 设置页的定时任务块、安静卡、口袋三个文件里一处 innerHTML／
//    insertAdjacentHTML／document.write 都不许有（表单是 index.html 里的静态 DOM，列表行
//    全部 createElement + textContent）。
// ② i18n 四文件齐全 —— 本波新加的每一个键在 public/ 与 docs/ 的中英四份里都在，占位符逐字相同；
//    并且**前端真的用到的每一个 t(...) 键**都在目录里（漏一个 = 界面上印出一个 key 字符串）。
// ③ 无「路径 ＋ 复制」反模式（28 号 §2 / 27 号 §8.1）—— 定时任务这一面不出现 clipboard／
//    「复制路径」一类东西；产出线程只有一枚「打开这条线程」，它在如意里打开。
// ④ describe 键对账 —— 06j 的 SCHEDULER_DESCRIBE_KEYS / SCHEDULER_DOW_KEYS 与四份 locale
//    【逐字】对上。纯函数那边加一个键而 locale 漏一个，界面上就会印出键名本身。
// ⑤ 徽标值域对账（J10／J11 的静态半边）—— 前端那两张表必须盖住 06j 的 SCHEDULER_FIRE_MODES
//    与 SCHEDULER_OUTCOMES 【全集】：少一个值，那一次触发就会印成 undefined 或退成别的字。
// ⑥ 零计时器 —— 口袋与焦点栏「接下来」不许新增 setInterval／setTimeout；schedule.changed
//    的订阅各恰好一处（K2b／K4 的纪律：数据靠推送与动作刷新，不加第二条轮询）。
//
// 反向验证（已本机独立跑一遍）：把 zh-CN.json 里的 scheduler.mode.late 删掉 → ② 与 ④ 双红；
// 把 SCHEDULE_OUTCOME_KEYS 里的 unknown 一行删掉 → ⑤ 红（实得缺 unknown）。
// 判定行：`SCHEDULER UI STATIC E2E: ALL PASS`。
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const APP = path.join(ROOT, 'ruyi-workbench', 'app');
const PUBLIC = path.join(APP, 'public');
const DOCS = path.join(ROOT, 'docs', 'i18n', 'locales');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const readJs = name => fs.readFileSync(path.join(PUBLIC, 'js', name), 'utf8');
const settingsSrc = readJs('steward-settings.js');
const quietSrc = readJs('quiet-card.js');
const pocketSrc = readJs('rail-pocket.js');
const drawerSrc = readJs('steward-drawer.js');
const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
const catalogs = {
  'public zh-CN': JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'zh-CN.json'), 'utf8')),
  'public en-US': JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'en-US.json'), 'utf8')),
  'docs zh-CN': JSON.parse(fs.readFileSync(path.join(DOCS, 'zh-CN.json'), 'utf8')),
  'docs en-US': JSON.parse(fs.readFileSync(path.join(DOCS, 'en-US.json'), 'utf8')),
};
const placeholders = value => [...String(value).matchAll(/{{\s*([\w.-]+)\s*}}/g)].map(m => m[1]).sort();
// 扫「代码里有没有 X」一律先把注释去掉 —— 本文件第一版就栽在这上面：三处命中全是注释里写着
// 「零 innerHTML」「不给复制」的那几句话，锁于是在骂自己的说明书。
const stripComments = source => String(source)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^[ \t]*\/\/.*$/gm, ' ');

/* ═════════ ① 零 innerHTML ═════════ */
for (const [name, source] of [['steward-settings.js', settingsSrc], ['quiet-card.js', quietSrc], ['rail-pocket.js', pocketSrc]]) {
  const hits = [...stripComments(source).matchAll(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/g)].map(m => m[1]);
  ok(hits.length === 0, `① ${name} 零 innerHTML/insertAdjacentHTML/document.write（实得 ${JSON.stringify(hits)}）`);
}
// 表单是静态 DOM：新建表单的每一个控件都必须在 index.html 里（JS 只改 hidden 与 value）。
const FORM_IDS = [
  'cfgStewardScheduleForm', 'cfgStewardScheduleNewBtn', 'cfgStewardScheduleTitle', 'cfgStewardScheduleKind',
  'cfgStewardScheduleAtBlock', 'cfgStewardScheduleAt', 'cfgStewardScheduleDateBlock', 'cfgStewardScheduleDate',
  'cfgStewardScheduleDaysBlock', 'cfgStewardScheduleDomBlock', 'cfgStewardScheduleDom',
  'cfgStewardScheduleCronBlock', 'cfgStewardScheduleCron', 'cfgStewardSchedulePayloadKind',
  'cfgStewardScheduleTargetBlock', 'cfgStewardScheduleTarget', 'cfgStewardScheduleText',
  'cfgStewardScheduleSessionBlock', 'cfgStewardScheduleSessionId',
  'cfgStewardSchedulePermissionBlock', 'cfgStewardSchedulePermission',
  'cfgStewardScheduleFormError', 'cfgStewardScheduleSubmitBtn', 'cfgStewardScheduleCancelBtn',
];
const missingIds = FORM_IDS.filter(id => !html.includes(`id="${id}"`));
ok(missingIds.length === 0, `①b 新建表单的 ${FORM_IDS.length} 个控件全部是 index.html 里的静态 DOM（缺 ${JSON.stringify(missingIds)}）`);
// 七枚星期复选框（weekly 那一档）——data-dow 0..6 各一个。
const dowBoxes = [...html.matchAll(/data-dow="([0-6])"/g)].map(m => m[1]).sort();
ok(JSON.stringify(dowBoxes) === JSON.stringify(['0', '1', '2', '3', '4', '5', '6']),
  `①c 星期复选框 data-dow 恰好 0..6 各一个（实得 ${JSON.stringify(dowBoxes)}）`);

/* ═════════ ② i18n 四文件齐全 ═════════ */
// 界面上真正会被印出来的每一个键：JS 里 t(...) 到的、两张常量表里的、以及 index.html 那一块
// data-i18n / data-i18n-attr 挂的。三处并起来才是「这一面会印什么」的全集。
const scheduleHtmlStart = html.indexOf('id="cfgStewardGroupSchedule"');
const scheduleHtmlEnd = html.indexOf('id="cfgStewardGroupMemory"');
const scheduleHtmlBlock = (scheduleHtmlStart > 0 && scheduleHtmlEnd > scheduleHtmlStart)
  ? html.slice(scheduleHtmlStart, scheduleHtmlEnd) : '';
const usedKeys = [...new Set([
  ...[...settingsSrc.matchAll(/t\('([\w.]+)'/g)].map(m => m[1]),
  ...[...settingsSrc.matchAll(/'(scheduler\.[\w.]+)'/g)].map(m => m[1]),
  ...[...settingsSrc.matchAll(/'(settings\.steward\.schedule[\w.]*)'/g)].map(m => m[1]),
  ...[...quietSrc.matchAll(/t\('([\w.]+)'/g)].map(m => m[1]),
  ...[...scheduleHtmlBlock.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
  ...[...scheduleHtmlBlock.matchAll(/data-i18n-attr="[a-z-]+:([\w.]+)"/g)].map(m => m[1]),
])].filter(key => /^(scheduler\.|settings\.steward\.schedule|quietCard\.)/.test(key)).sort();
ok(usedKeys.length >= 55, `② 定时任务界面真正用到 ${usedKeys.length} 个本波前缀的键（少于 55 说明抓漏了）`);
for (const [label, catalog] of Object.entries(catalogs)) {
  const missing = usedKeys.filter(key => typeof catalog[key] !== 'string');
  ok(missing.length === 0, `② ${label} 四文件齐全（缺 ${JSON.stringify(missing.slice(0, 6))}）`);
}
{
  const mismatched = usedKeys.filter(key => JSON.stringify(placeholders(catalogs['public zh-CN'][key]))
    !== JSON.stringify(placeholders(catalogs['public en-US'][key])));
  ok(mismatched.length === 0, `②b 中英占位符逐字相同（不同 ${JSON.stringify(mismatched)}）`);
}
// index.html 那一块里的每一个 data-i18n 也要在目录里（静态文案漏键 = 界面上印键名）。
{
  const start = html.indexOf('id="cfgStewardGroupSchedule"');
  const end = html.indexOf('id="cfgStewardGroupMemory"');
  const block = html.slice(start, end);
  ok(start > 0 && end > start, '②c 取到 index.html 的定时任务块');
  const htmlKeys = [...new Set([
    ...[...block.matchAll(/data-i18n="([\w.]+)"/g)].map(m => m[1]),
    ...[...block.matchAll(/data-i18n-attr="[a-z-]+:([\w.]+)"/g)].map(m => m[1]),
  ])];
  const missing = htmlKeys.filter(key => typeof catalogs['public zh-CN'][key] !== 'string' || typeof catalogs['public en-US'][key] !== 'string');
  ok(htmlKeys.length >= 20 && missing.length === 0,
    `②d 块里 ${htmlKeys.length} 个 data-i18n 键全部在中英目录里（缺 ${JSON.stringify(missing)}）`);
  // 硬性：这一块里不许留没走目录的中文（与 i18n.static 对整个设置弹窗那条同款判据）。
  const bare = block.split(/\r?\n/).filter(line => /[一-鿿]/.test(line) && !line.includes('data-i18n') && !line.includes('<!--'));
  ok(bare.length === 0, `②e 块里零「写死的中文」（实得 ${JSON.stringify(bare.map(s => s.trim()).slice(0, 3))}）`);
}

/* ═════════ ③ 无「路径 ＋ 复制」反模式 ═════════ */
{
  const start = settingsSrc.indexOf('④d 定时任务');
  const end = settingsSrc.indexOf('填充与接线');
  const block = start > 0 && end > start ? stripComments(settingsSrc.slice(start, end)) : '';
  ok(Boolean(block.trim()), '③ 取到 steward-settings.js 的定时任务块（去注释后的代码）');
  for (const needle of ['clipboard', 'execCommand', '复制', 'cwd', 'download']) {
    ok(!block.includes(needle), `③ 定时任务块里零「${needle}」（UX 红线：不让用户离开如意自己操作）`);
  }
  ok(block.includes("t('settings.steward.schedule.openThread')"),
    '③b 产出线程的唯一落点是「打开这条线程」（在如意里打开，不给路径）');
  const htmlBlock = html.slice(html.indexOf('id="cfgStewardGroupSchedule"'), html.indexOf('id="cfgStewardGroupMemory"'));
  ok(!/复制|clipboard|download/i.test(htmlBlock), '③c index.html 的定时任务块里也没有复制/下载入口');
}

/* ═════════ ④/⑤ 与 06j 的值域逐字对账（真产物内省，不靠 grep 形状）═════════ */
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-scheduler-ui-static-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = tmpHome;
process.env.RUYI_HOME = tmpHome;
const srv = require(path.join(APP, 'server.js'));
{
  const describeKeys = [...srv.SCHEDULER_DESCRIBE_KEYS].sort();
  const dowKeys = [...srv.SCHEDULER_DOW_KEYS].sort();
  for (const [label, catalog] of Object.entries(catalogs)) {
    const missing = [...describeKeys, ...dowKeys].filter(key => typeof catalog[key] !== 'string');
    ok(missing.length === 0, `④ ${label} 覆盖 06j 的 ${describeKeys.length} 个 describe 键 + ${dowKeys.length} 个星期键（缺 ${JSON.stringify(missing)}）`);
  }
  ok(typeof catalogs['public zh-CN']['scheduler.dowJoin'] === 'string' && typeof catalogs['public en-US']['scheduler.dowJoin'] === 'string',
    '④b 星期之间的连接符也走目录（中文顿号／英文逗号不是同一个字）');
  // weekly 通用那一支的参数名：纯函数给 dayKeys（键的数组），文案要的是拼好的 days。
  const described = srv.describeSchedule({ kind: 'weekly', at: '18:00', days: [1, 3] }, 'zh');
  ok(described.key === 'scheduler.describe.weekly' && Array.isArray(described.params.dayKeys),
    `④c weekly 通用支回 dayKeys 数组（实得 ${JSON.stringify(described.params)}）`);
  ok(placeholders(catalogs['public zh-CN']['scheduler.describe.weekly']).includes('days'),
    '④d 文案用 {{days}} 接那一串拼好的星期（前端逐个翻完再拼，纯函数不认识语言）');
}
{
  const modeTable = (settingsSrc.split('const SCHEDULE_MODE_KEYS = Object.freeze({')[1] || '').split('});')[0];
  const outcomeTable = (settingsSrc.split('const SCHEDULE_OUTCOME_KEYS = Object.freeze({')[1] || '').split('});')[0];
  const missModes = [...srv.SCHEDULER_FIRE_MODES].filter(mode => !new RegExp('\\b' + mode + ':').test(modeTable));
  const missOutcomes = [...srv.SCHEDULER_OUTCOMES].filter(outcome => !new RegExp('\\b' + outcome + ':').test(outcomeTable));
  ok(missModes.length === 0, `⑤ 触发模式三值全部有人话（J10 的静态半边；缺 ${JSON.stringify(missModes)}）`);
  ok(missOutcomes.length === 0, `⑤b 结果五值全部有人话（J11 的静态半边；缺 ${JSON.stringify(missOutcomes)}）`);
  // J11 的措辞：unknown 那一句必须【明说要人核对】，不能只写「未知」两个字更不能退成「成功」。
  ok(/核对/.test(String(catalogs['public zh-CN']['scheduler.outcome.unknown'])),
    `⑤c unknown 的中文明说要核对（实得「${catalogs['public zh-CN']['scheduler.outcome.unknown']}」）`);
  ok(String(catalogs['public zh-CN']['scheduler.outcome.unknown']) !== String(catalogs['public zh-CN']['scheduler.outcome.succeeded']),
    '⑤d unknown 与 succeeded 不是同一句话（J11：不判成功）');
}

/* ═════════ ⑥ 零计时器 + 订阅各一处 ═════════ */
for (const [name, source] of [['rail-pocket.js', pocketSrc]]) {
  const timers = [...source.matchAll(/\b(setInterval|setTimeout)\s*\(/g)].map(m => m[1]);
  ok(timers.length === 0, `⑥ ${name} 零计时器（实得 ${JSON.stringify(timers)}）`);
}
{
  const pocketHits = (pocketSrc.match(/'schedule\.changed'/g) || []).length;
  const drawerHits = (drawerSrc.match(/'schedule\.changed'/g) || []).length;
  ok(pocketHits === 1, `⑥b 口袋订阅 schedule.changed 恰好一处（实得 ${pocketHits}）`);
  ok(drawerHits === 1, `⑥c 焦点栏「接下来」订阅 schedule.changed 恰好一处（实得 ${drawerHits}）`);
  ok(/stream\.on\('schedule\.changed'/.test(drawerSrc), '⑥d 焦点栏那一处走的是既有那一条事件流（不新开第二条连接）');
}
{
  // 设置页仍然零计时器（117e 起就有的纪律，本波加了一整块可写面，最容易在这里破功）。
  const timers = [...settingsSrc.matchAll(/\b(setInterval|setTimeout)\s*\(/g)].map(m => m[1]);
  ok(timers.length === 0, `⑥e steward-settings.js 仍然零计时器（实得 ${JSON.stringify(timers)}）`);
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
console.log(fail === 0 ? '\nSCHEDULER UI STATIC E2E: ALL PASS' : `\nSCHEDULER UI STATIC E2E: ${fail} FAILURE(S)`);
process.exit(fail === 0 ? 0 : 1);
