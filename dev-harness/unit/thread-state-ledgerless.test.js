// Unit: 117p-S2(30 号文 §8.3 / 27 号文 §11.11)—— 五态判据的「无账本线程」分支。
//
// 根因:06i deriveStewardThreadState 与前端 mission-state.js deriveMissionState 两份抄写件的
// fromCard 适配器都把 turnSeq 硬编码成 0。这个假设对有 mission 账本的 2.0 任务单成立,对
// steward_thread_new 开出来的线程(头上有 kind:'mission' 但没有 mission 容器)不成立 ——
// runCount===0 && turnSeq===0 && milestonesDone===0 恒真,于是一条 11 分钟前就跑完的线程
// 永远显示「交办中」(真机证据:sess_e97b29759a586485, turnSeq:1 + stewardLastTurn{seq:1,ok:true})。
//
// 修法:13d buildMissionCard 给卡片补 turnSeq / lastTurn(会话头已有字段的投影);两份抄写件
// 同步加一条「无账本线程」分支(ledgerless && turnSeq > 0 -> done,lastTurnFailed -> stopped),
// 钉在 dispatching 之后、stopped 兜底之前。
//
// 这件测试的纪律:【同一组入参同时喂两份实现,断言结果逐字相等】—— 抄写件的价值就在于逐字相同,
// 只测一边等于没测。外加三条静态锁(两份抄写件不再有硬编码 turnSeq: 0、都出现 ledgerless、
// 13d buildMissionCard 真的产出 turnSeq 与 lastTurn)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-state-ledgerless-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
const MissionState = require(path.join(repo, 'ruyi-workbench', 'app', 'public', 'js', 'mission-state.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const deriveServer = srv.deriveStewardThreadState;
const deriveFront = MissionState.deriveMissionState;
ok(typeof deriveServer === 'function', '① 产物导出 deriveStewardThreadState');
ok(typeof deriveFront === 'function' && typeof MissionState.fromCard === 'function', '① mission-state.js 双导出可 require');

/* ═══════════ ② 同一组入参,两份抄写件结果逐字相等 ═══════════ */

// 归一化入参层面的逐字对账:state / label / sources 证据全等(sources 里必须看得见新证据键)。
// 例外:quick_ask 的人话标签两边【故意】不同(116-3 P1-5:服务端「速查中」、前端「速问」,
// §8.1 第 7 条的措辞决定),这个取值只比对 state 与 sources。
const both = (input, expected, label) => {
  const a = deriveServer(input);
  const b = deriveFront(input);
  ok(a.state === expected, `② ${label} -> ${expected}(服务端 got ${a.state})`);
  const same = a.state === b.state && JSON.stringify(a.sources) === JSON.stringify(b.sources)
    && (a.state === 'quick_ask' || a.label === b.label);
  ok(same, `② ${label}:两份抄写件结果逐字相等(quick_ask 标签有意不同,除外)`);
  ok(a.sources.ledgerless === (input.ledgerless === true) && a.sources.lastTurnFailed === (input.lastTurnFailed === true),
    `② ${label}:sources 证据里看得见 ledgerless / lastTurnFailed`);
};

// §8.3 覆盖清单(逐条):
both({ kind: 'mission', turnSeq: 1, ledgerless: true }, 'done',
  '无账本 + turnSeq 1 + 账缺席(lastTurn 为 null 按成功算,与 13i @sessionTurn 同口径)');
both({ kind: 'mission', turnSeq: 1, ledgerless: true, lastTurnFailed: true }, 'stopped',
  '无账本 + turnSeq 1 + lastTurnFailed -> stopped');
both({ kind: 'mission', turnSeq: 0, ledgerless: true }, 'dispatching',
  '无账本 + turnSeq 0(刚交办、一回合都没跑)-> 仍是 dispatching');
both({ kind: 'mission', turnSeq: 1, ledgerless: true, pending: { questions: 1 } }, 'needs_you',
  '无账本 + 有待决 -> needs_you(新分支不许抢第 1 条判据的优先级)');
both({ kind: 'mission', turnSeq: 1, ledgerless: true, activeTurn: true }, 'running',
  '无账本 + 活回合 -> running(新分支不许抢活证据)');
// 最重要的那条:有账本 + turnSeq 5 + 无结果章 + runCount 0 -> 仍然是 stopped。
// 2.0 任务单的语义一个字没变:跑了回合但没收尾章的任务单就是「已停工」,不是「已收工」。
both({ kind: 'mission', turnSeq: 5, ledgerless: false, runCount: 0, milestonesTotal: 2, milestonesDone: 1 }, 'stopped',
  '有账本 + turnSeq 5 + 无结果章 + runCount 0 -> 仍是 stopped(2.0 任务单语义不变)');
both({ kind: 'mission', turnSeq: 5, runCount: 0, milestonesTotal: 2, milestonesDone: 1 }, 'stopped',
  '有账本(ledgerless 键缺席等价 false)+ turnSeq 5 -> 仍是 stopped');
// 逃生舱不被无账本分支影响。
// 117r-D5 重钉(逐对交代):这一行原来断言 `{kind:'quick_ask', turnSeq:3, ledgerless:true}` -> 'quick_ask'。
// D5 把第 0 条守卫从「kind 是不是 quick_ask」换成「调用方有没有事实」之后,这组入参【手上有事实】
// (ledgerless + turnSeq 3 = 一条跑完的无账本线程),所以它如实落 done —— 这正是本刀要修的症状本身
// (一条三小时前就跑完的速查线程修前永远只说「速查中」),不是回归。
// 原断言的【意图】是「第 0 条逃生舱还在,无账本分支抢不走它」,这个意图一个字没变,所以下面两行
// 用【同一组入参】把它钉得比原来更紧:同一组事实,不带标志时走完整五态(done),明说没事实时
// 仍然短路(quick_ask)。原来只钉了后者的一半,现在两个方向都钉住了。
both({ kind: 'quick_ask', turnSeq: 3, ledgerless: true }, 'done',
  '速问 kind + 无账本 + 跑过回合 -> done(117r-D5:kind 不再短路,事实说了算)');
both({ kind: 'quick_ask', turnSeq: 3, ledgerless: true, factsUnknown: true }, 'quick_ask',
  '同一组入参 + 明说没事实 -> 仍是 quick_ask(第 0 条逃生舱还在,无账本分支抢不走它)');

/* ═══════════ ③ fromCard / stewardThreadStateFromCard 适配器层面的逐字对账 ═══════════ */

const fromCardServer = srv.stewardThreadStateFromCard;
ok(typeof fromCardServer === 'function', '③ 产物导出 stewardThreadStateFromCard');
const cardBoth = (card, expected, label) => {
  const a = fromCardServer(card);
  const b = MissionState.fromCard(card);
  ok(a.state === expected, `③ ${label} -> ${expected}(got ${a.state})`);
  ok(JSON.stringify(a) === JSON.stringify(b), `③ ${label}:两份 fromCard 结果逐字相等`);
};

// 管家线程的真实卡片形状(13d buildMissionCard 的投影):kind=mission、status 'none'(无账本)、
// turnSeq 1、lastTurn 落账 ok:true —— 修前这条永远 dispatching,修后是 done。
cardBoth({ kind: 'mission', status: 'none', turnSeq: 1, lastTurn: { seq: 1, ok: true, aborted: false }, runCount: 0 }, 'done',
  '无账本卡片(status none)+ turnSeq 1 + lastTurn ok -> done');
cardBoth({ kind: 'mission', status: 'none', turnSeq: 1, lastTurn: { seq: 1, ok: false, aborted: false }, runCount: 0 }, 'stopped',
  '无账本卡片 + 末回合 ok:false -> stopped');
cardBoth({ kind: 'mission', status: 'none', turnSeq: 1, lastTurn: { seq: 1, ok: true, aborted: true }, runCount: 0 }, 'stopped',
  '无账本卡片 + 末回合 aborted:true -> stopped(用户主动停掉)');
cardBoth({ kind: 'mission', status: 'none', turnSeq: 1, lastTurn: null, runCount: 0 }, 'done',
  '无账本卡片 + 账缺席(lastTurn null)-> done(账缺席按成功算)');
cardBoth({ kind: 'mission', status: 'none', turnSeq: 0, lastTurn: null, runCount: 0 }, 'dispatching',
  '无账本卡片 + turnSeq 0 -> dispatching(刚交办)');
cardBoth({ kind: 'mission', status: 'idle', turnSeq: 5, lastTurn: null, runCount: 0,
  mission: { autoMode: 'off', milestonesTotal: 2, done: 1 } }, 'stopped',
  '有账本卡片(status idle)+ turnSeq 5 + 无结果章 -> 仍是 stopped(ledgerless 只看 status none,不看里程碑数)');
// 旧索引里的存量卡片(schema 4 之前建的,没有 turnSeq / lastTurn 键)行为退回修前,不炸:
cardBoth({ kind: 'mission', status: 'none', runCount: 0 }, 'dispatching',
  '存量旧卡片(缺 turnSeq/lastTurn 键)-> 退回修前行为 dispatching(升号重建后才会刷新)');

/* ═══════════ ④ 静态锁(只加不改)═══════════ */

const src06i = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '06i-steward-core.js'), 'utf8');
const srcFront = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'public', 'js', 'mission-state.js'), 'utf8');
const src13d = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '13d-core-domain-routes.js'), 'utf8');
ok(!/turnSeq:\s*0\s*,/.test(src06i) && !/turnSeq:\s*0\s*(,|\/\/)/.test(srcFront),
  '④ 两份抄写件里都不再出现硬编码 turnSeq: 0');
ok(src06i.includes('ledgerless') && srcFront.includes('ledgerless'), '④ 两份抄写件都出现 ledgerless 判据');
ok(src06i.includes("src.ledgerless && src.turnSeq > 0") && srcFront.includes("src.ledgerless && src.turnSeq > 0"),
  '④ 两份抄写件都带无账本线程分支(逐字同一行)');
// buildMissionCard 真的产出 turnSeq 与 lastTurn(函数体区间内断言,不数全文件):
const cardFn = src13d.slice(src13d.indexOf('async function buildMissionCard'));
const cardFnBody = cardFn.slice(0, cardFn.indexOf('\n}'));
ok(/\bturnSeq:\s*Math\.max\(0, Number\(head\.turnSeq\)/.test(cardFnBody), '④ buildMissionCard 产出 turnSeq(会话头投影)');
ok(/\blastTurn:\s*head\.stewardLastTurn/.test(cardFnBody), '④ buildMissionCard 产出 lastTurn(会话头投影)');

console.log(fail ? `THREAD STATE LEDGERLESS UNIT: ${fail} FAILURE(S)` : 'THREAD STATE LEDGERLESS UNIT: ALL PASS');
process.exit(fail ? 1 : 0);
