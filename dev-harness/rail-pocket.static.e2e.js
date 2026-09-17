#!/usr/bin/env node
'use strict';
// 静态锁（第 121 波 K7 · 34 号文 §2.3 末段／§7.2／§7.3）：左栏栏底那只【口袋】的边界。
//
// 真页面上的行为由 dev-harness/rail-pocket.browser.e2e.js 钉（四项、deep link、「新」角标、
// 「接下来」、≤980 图标栏、右栏页签行数、向导那一步）。这一件只钉【源码层面拿得住的那几条】——
// 它们在真浏览器里要么量不到（比如「有没有写 setInterval」），要么代价太高（每次都起服务）：
//   A 零计时器：setInterval／setTimeout 字面量在 js/rail-pocket.js 零命中（§2.3「数据靠推送
//     ＋ 动作刷新，不加第二条计时器」；K2b／K4 的纪律）。这是本件最主要的那一条 —— 一条计时器
//     加进去，真浏览器件的 H 组要等 12 秒才看得出来，而这里一眼就红。
//   B 零 innerHTML／insertAdjacentHTML／document.write（与其余管家叶子同一条纪律）。
//   C import 全是本域内相对路径（零第三方），且字形只从 icons.js 的 ICONS 表取 —— 本文件里
//     一条 SVG 路径字面量都没有（§2.10.1「一套词汇表，不留孤本」）。
//   D 四项的表就在这一份里，section 名与 steward-settings.js 的 PANEL_SECTIONS 对得上
//     （deep link 不是死链；这一条与 steward-settings.static 的 E5b2 互为两半，各自独立可红）。
//   E 「记得的关于你」的 24 小时窗口【不在客户端】：本文件读的是服务端算好的 counts.isNew，
//     所以源码里不许出现那类窗口常量（判据只有 13g 一处）。
//   F 定时任务的读口只有一处：js/rail-pocket.js 导出它，steward-drawer.js 与 steward-settings.js
//     都 import 它，三处不许各拼一遍那条路由。
//   G 两个纯函数的真值表（normalizeScheduleTasks／upcomingSchedules／scheduleWhenParts）。
//
// **两处扫描都先剥掉行注释**（与 copy-path-guard.static 同一条口径：注释不算代码）。K7 实测过：
// 头注里那句「零 innerHTML」自己就会命中裸正则，路由名同理 —— 不剥注释的锁是钉不住事的。
//
// 判定行：`RAIL POCKET STATIC E2E: ALL PASS`
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');
const stripLineComments = text => text.split(/\r?\n/).filter(line => !/^\s*\/\//.test(line)).join('\n');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {
  const source = read('js/rail-pocket.js');
  const drawer = read('js/steward-drawer.js');
  const settings = read('js/steward-settings.js');
  const app = read('app.js');
  const mod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'rail-pocket.js')).href);
  const code = stripLineComments(source);

  /* ─── A 零计时器 ─────────────────────────────────────────────────────────────── */
  const timerHits = source.split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line }))
    .filter(item => /\bsetInterval\b|\bsetTimeout\b/.test(item.text) && !/^\s*\/\//.test(item.text));
  ok(timerHits.length === 0,
    `A1 js/rail-pocket.js 零 setInterval／setTimeout（§2.3「不加第二条计时器」；实测 ${timerHits.map(h => 'L' + h.line).join(',') || '零命中'}）`);
  ok(/let inflight = null;/.test(code) && /if \(inflight\) return inflight;/.test(code),
    'A2 一发在飞时不开第二发（串行合并，替代计时器的那半条纪律）');
  // 127-F6：合并不许把那一帧丢掉 —— 在飞那一发的读发生在帧之前，返回的是旧事实；本模块零计时器、
  // 除了推送没有第二条通道，丢掉就是永远不纠正（scheduler-ui.browser B1 的真因：角标停在旧值）。
  // 判据钉行为：在飞期间来过帧要记一笔，并且在那一发落地之后补刷一次。
  ok(/if \(inflight\) missedWhileInflight = true;/.test(code)
    && /if \(missedWhileInflight\) \{ missedWhileInflight = false; void refresh\(\); \}/.test(code),
    'A2b 在飞期间到达的帧不丢：记一笔，等这一发落地之后补刷一次（收敛，仍然零计时器）');
  // 123-M2（37 号文 §3.6）：第三类帧 schedule.changed —— 建一条定时任务既不写收件箱也不改线程
  // 状态，口袋上那个计数修前要等下一次打开左栏才对得上。它仍然【不是第二条通道】：与另外两类
  // 走同一条事件流、同一处订阅、同一个串行合并的 refresh()，零计时器那条纪律一个字没动。
  ok(/for \(const name of \['inbox\.appended', 'thread\.state', 'schedule\.changed'\]\)/.test(code),
    'A3 推送只订 inbox.appended／thread.state／schedule.changed 三类帧（同一条流、同一处订阅）');

  /* ─── B 零 innerHTML ─────────────────────────────────────────────────────────── */
  ok(!/innerHTML|insertAdjacentHTML|document\.write/.test(code),
    'B1 零 innerHTML／insertAdjacentHTML／document.write（注释不算代码）');

  /* ─── C import 与字形 ────────────────────────────────────────────────────────── */
  const imports = [...source.matchAll(/^import .*from '([^']+)';$/gm)].map(match => match[1]);
  ok(imports.length > 0 && imports.every(spec => spec.startsWith('./')),
    `C1 import 全是本域内相对路径（实测 ${JSON.stringify(imports)}）`);
  ok(imports.includes('./icons.js') && !/\bd:\s*'M/.test(code) && !/<svg/.test(code),
    'C2 字形只从 icons.js 的 ICONS 表取，本文件零 SVG 路径字面量（§2.10.1）');
  ok(imports.includes('./health-i18n.js') && /healthSummaryText\(items, translate\)/.test(code),
    'C3 体检那一枚读的是 health-i18n.js 的同一份判据（与设置按钮上那枚红点同源，零新增请求）');

  /* ─── D 四项与 deep link 落点 ────────────────────────────────────────────────── */
  const items = mod.RAIL_POCKET_ITEMS;
  ok(Array.isArray(items) && items.length === 4
    && items.map(item => item.id).join(',') === 'schedule,decisions,memory,doctor',
    `D1 口袋恰四项、顺序固定（§2.3 原文顺序；实测 ${JSON.stringify(items.map(i => i.id))}）`);
  ok(items.every(item => typeof item.icon === 'string' && item.icon
    && typeof item.labelKey === 'string' && item.labelKey.startsWith('rail.pocket.')),
    'D2 每项都有字形名与 rail.pocket.* 文案键');
  const sections = items.filter(item => item.panel).map(item => item.panel);
  ok(sections.length === 3 && sections.every(name => settings.includes(`    ${name}: 'cfgStewardGroup`)),
    `D3 三个 section 名在 steward-settings.js 的 PANEL_SECTIONS 表里各有落点（deep link 不是死链；实测 ${JSON.stringify(sections)}）`);
  ok(items[3].panel === '' && /openUsage/.test(code) && /openDoctor/.test(code),
    'D4 「体检 · 用量」不走管家设置页那条路：两视角两条路各一个注入（§7.2）');
  ok(/bindRailPocket\(\{ api, state, t, eventStream, openStewardPanel/.test(app)
    && (app.match(/bindRailPocket\(/g) || []).length === 1,
    'D5 组合根只有一处 bindRailPocket（import ＋ 一行 bind）');

  /* ─── E 24 小时窗口不在客户端 ────────────────────────────────────────────────── */
  ok(/counts && counts\.isNew/.test(code) && !/86400000|NEW_WINDOW/.test(code),
    'E1 「新」的 24 小时窗口只由服务端 13g 算（客户端零窗口常量）');

  /* ─── F 定时任务读口只有一处 ─────────────────────────────────────────────────── */
  const literalHits = text => (stripLineComments(text).match(/'\/api\/scheduler\/tasks'/g) || []).length;
  const routeHits = [source, drawer, settings].map(literalHits);
  // 123-M2（37 号文 §3.6）：设置页那一块从只读改成【可建可改】，于是它自己也有了一处常量 ——
  // 那一面要的是全量任务行（describeKey / state / policy）与另一套排序（暂停的、算不出下一次的
  // 也要在表里），而 normalizeScheduleTasks 按设计只留 K7 要的四个字段、upcomingSchedules 按设计
  // 会把那两类滤掉。所以这条从「只许一处」改成「只许这两处、且各自都是具名常量」；抽屉仍是 0
  // （它就是「接下来」，读口与排序判据仍在 K7 那一份）。
  ok(routeHits[0] === 1 && routeHits[1] === 0 && routeHits[2] === 1
    && /SCHEDULE_TASKS_PATH = '\/api\/scheduler\/tasks'/.test(code)
    && /SCHEDULE_TASKS_PATH = '\/api\/scheduler\/tasks'/.test(stripLineComments(settings)),
    `F1 那条路由的字面量只在两处具名常量里（口袋的读口 ＋ 设置页的写面；抽屉仍 import 口袋那一份；实测 ${JSON.stringify(routeHits)}）`);
  ok(/import \{ readScheduleTasks, upcomingSchedules, scheduleWhenLabel, UP_NEXT_LIMIT \} from '\.\/rail-pocket\.js';/.test(drawer),
    'F2 焦点栏「接下来」import 那一份读口与排序判据（不自己拼请求、不写第二份「哪两条」）');
  // 123-M2：设置页只再复用「多久之后」那句人话（口袋、「接下来」与它说同一句，不各写一个
  // Intl.RelativeTimeFormat）；取数与排序换成它自己那两支，理由见 F1 的注释。
  ok(/import \{ scheduleWhenLabel \} from '\.\/rail-pocket\.js';/.test(settings),
    'F3 设置页仍然复用同一句「多久之后」（不写第二个相对时间格式化器）');

  /* ─── G 纯函数真值表（可 Node 直跑，不起浏览器）──────────────────────────────── */
  const now = Date.UTC(2026, 8, 12, 12, 0, 0);
  const tasks = mod.normalizeScheduleTasks({ tasks: [
    { id: 'a', name: '甲', nextRunAt: new Date(now + 7200000).toISOString() },
    { id: 'b', name: '乙', nextRunAt: new Date(now + 1800000).toISOString() },
    { id: 'c', name: '丙', nextRunAt: new Date(now + 5400000).toISOString() },
    { id: 'd', name: '丁', nextRunAt: new Date(now - 3600000).toISOString() },
    { id: 'e', name: '戊', enabled: false, nextRunAt: new Date(now + 600000).toISOString() },
    { id: 'f', name: '', nextRunAt: new Date(now + 600000).toISOString() },
    { id: 'g', name: '庚', nextRunAt: 'not-a-date' },
  ] });
  ok(tasks.length === 5 && tasks.map(t => t.id).join(',') === 'a,b,c,d,e',
    `G1 normalizeScheduleTasks 丢掉「没名字」与「时间认不出来」的条目（实测 ${JSON.stringify(tasks.map(t => t.id))}）`);
  const upcoming = mod.upcomingSchedules(tasks, mod.UP_NEXT_LIMIT, now);
  ok(upcoming.length === 2 && upcoming.map(t => t.id).join(',') === 'b,c',
    `G2 upcomingSchedules：按下次触发升序、只取未来且开着的、上限两条（实测 ${JSON.stringify(upcoming.map(t => t.id))}）`);
  ok(mod.UP_NEXT_LIMIT === 2, `G3 「接下来」的上限是 2（§2.6「定时任务最近两条」；实测 ${mod.UP_NEXT_LIMIT}）`);
  ok(mod.scheduleWhenParts(now + 1800000, now).unit === 'minute'
    && mod.scheduleWhenParts(now + 1800000, now).value === 30
    && mod.scheduleWhenParts(now - 3600000, now) === null,
    'G4 scheduleWhenParts 只说未来（过去一律 null——它是 stewardAgoParts 够不着的那一半）');
  ok(mod.memoryIsNewCount({ counts: { isNew: 3 } }) === 3
    && mod.memoryIsNewCount({ counts: { isNew: 0 } }) === 0
    && mod.memoryIsNewCount(null) === 0,
    'G5 memoryIsNewCount 只转述服务端那个数（读不到就当 0）');

  console.log(fail === 0 ? 'RAIL POCKET STATIC E2E: ALL PASS' : `RAIL POCKET STATIC E2E: FAIL (${fail})`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(error => {
  console.error('RAIL POCKET STATIC E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
