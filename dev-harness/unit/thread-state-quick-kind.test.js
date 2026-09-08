// Unit: 117r-D5(用户第八轮走查③的三条子症状)—— **速查是一个 kind,不是一个 state**。
//
// 根因:五态判据的第 0 条守卫是 `src.kind === 'quick_ask'` —— 一条速查线程无论在跑、在等你、
// 还是三小时前就跑完了,整台五态机器都被短路,永远只会说「速查中」。117r-D1 让这些线程第一次
// 进了 GET /api/missions 之后,这条逃生舱当年的前提(速查线程根本不显示、五态对它没有消费者)
// 就没了,于是同一屏上冒出三条互相打脸的症状:
//   ① 状态行数 view.state === 'running' 数出 0,看板头数仲裁器数出 1;
//   ② 组标题「已停工」(aggregateMissionState(['quick_ask']) -> stopped),组内那行「速查中」;
//   ③ 一条正在问你的速查线程既不进 focusThreadFor 的 needs_you,也不进「N 条等你」。
//
// 修法:守卫从「是不是速查」换成「调用方手上有没有这条线程的事实」(factsUnknown,默认【有事实】)。
// 'quick_ask' 于是退回它唯一诚实的语义:事实未知。速查这个身份改由 kind 承载(看板行上的徽标)。
//
// 这件测试的纪律与 thread-state-ledgerless.test.js 同款:【同一张真值表同时喂两份抄写件,
// 断言结果逐字相等】—— 抄写件的价值就在于逐字相同,只测一边等于没测。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-state-quick-kind-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
const MissionState = require(path.join(repo, 'ruyi-workbench', 'app', 'public', 'js', 'mission-state.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const deriveServer = srv.deriveStewardThreadState;
const deriveFront = MissionState.deriveMissionState;
const fromCardServer = srv.stewardThreadStateFromCard;
const fromCardFront = MissionState.fromCard;
const aggregate = srv.aggregateMissionState;

/* ═══════════ ① 归一化入参层的真值表:kind 是 quick_ask 也照走五态 ═══════════ */

// 两份抄写件跑同一张表:state 必须相等;label 也必须相等 ——
// 【注意】117p-S2 那件测试对 quick_ask 取值放行了 label 差异(服务端「速查中」/ 前端「速问」),
// 这里【不】放行:本表里期望值是 quick_ask 的那两行会单独比对,其余各行两边人话必须逐字相同。
const both = (input, expected, label) => {
  const a = deriveServer(input);
  const b = deriveFront(input);
  ok(a.state === expected, `① ${label} -> ${expected}(服务端 got ${a.state})`);
  ok(a.state === b.state && JSON.stringify(a.sources) === JSON.stringify(b.sources)
    && (a.state === 'quick_ask' || a.label === b.label),
    `① ${label}:两份抄写件逐字相等(state/sources/label;quick_ask 的人话两边有意不同,除外)`);
  ok(a.sources.factsUnknown === (input.factsUnknown === true),
    `① ${label}:sources 里看得见新证据键 factsUnknown`);
};

// 派单稿点名的四条(kind 一律是 quick_ask —— 就是这个 kind 修前把整台机器短路掉的):
both({ kind: 'quick_ask', activeTurn: true, ledgerless: true, turnSeq: 1 }, 'running',
  '在跑的速查线程(活回合)');
both({ kind: 'quick_ask', pending: { questions: 1 }, ledgerless: true, turnSeq: 1 }, 'needs_you',
  '有待决的速查线程(它正在问你)');
both({ kind: 'quick_ask', ledgerless: true, turnSeq: 1 }, 'done',
  '跑完的速查线程(无账本 + turnSeq 1 + 账缺席按成功算)');
both({ kind: 'quick_ask', factsUnknown: true }, 'quick_ask',
  '没事实的调用方(13d 那条不读会话头的 else 支)-> 仍是 quick_ask');

// 边角:速查线程的其余两态,以及「事实未知」压过一切真事实(它是【第 0 条】,优先级最高)。
both({ kind: 'quick_ask', ledgerless: true, turnSeq: 1, lastTurnFailed: true }, 'stopped',
  '末回合失败的速查线程 -> stopped');
both({ kind: 'quick_ask' }, 'dispatching',
  '刚开、一回合都没跑的速查线程 -> dispatching(不是 quick_ask:有事实,只是还没动)');
both({ kind: 'quick_ask', factsUnknown: true, activeTurn: true, pending: { questions: 3 }, turnSeq: 9 }, 'quick_ask',
  '明说没事实时,喂进来的「事实」一概不算数(第 0 条守卫优先级最高)');
// 反向:kind 是 mission 但调用方明说没事实,同样落 quick_ask —— 判据认的是事实,不是 kind。
both({ kind: 'mission', factsUnknown: true, turnSeq: 4, ledgerless: true }, 'quick_ask',
  'kind=mission + 明说没事实 -> 也落 quick_ask(守卫认事实不认 kind)');
// 2.0 任务单一个字不变(有账本 + 跑过回合 + 无结果章 = 已停工),防止本刀顺手改了别人的语义。
both({ kind: 'mission', turnSeq: 5, runCount: 0, milestonesTotal: 2, milestonesDone: 1 }, 'stopped',
  '有账本的 2.0 任务单语义逐字不变(回归哨兵)');

/* ═══════════ ② 卡片层的同一张表:真实的速查线程就是从这里来的 ═══════════ */

// D1 之后管家开的速查线程有卡片了(13e stewardWatchedThread),13d 的三支里它走第 ① 支
// stewardThreadStateFromCard —— 也就是说这一层才是线上真正跑的那条路。
const cardBoth = (card, expected, label) => {
  const a = fromCardServer(card);
  const b = fromCardFront(card);
  ok(a.state === expected, `② ${label} -> ${expected}(got ${a.state})`);
  ok(JSON.stringify(a) === JSON.stringify(b), `② ${label}:两份 fromCard 结果逐字相等`);
  ok(a.sources.kind === 'quick_ask' || card.kind !== 'quick_ask',
    `② ${label}:kind 仍如实留在 sources 里当证据(身份没丢,只是不再判定 state)`);
};

const quickCard = extra => Object.assign({ kind: 'quick_ask', status: 'none', runCount: 0 }, extra);
cardBoth(quickCard({ activeTurn: true, turnSeq: 1 }), 'running', '在跑的速查卡片');
cardBoth(quickCard({ lastRun: { live: true, paused: false }, turnSeq: 1 }), 'running', '有未暂停活 run 的速查卡片');
cardBoth(quickCard({ pending: { permissions: 1 }, turnSeq: 1 }), 'needs_you', '有待决的速查卡片');
cardBoth(quickCard({ turnSeq: 1, lastTurn: { seq: 1, ok: true, aborted: false } }), 'done', '跑完的速查卡片');
cardBoth(quickCard({ turnSeq: 1, lastTurn: { seq: 1, ok: false, aborted: false } }), 'stopped', '末回合失败的速查卡片');
cardBoth(quickCard({ turnSeq: 0 }), 'dispatching', '刚开的速查卡片(一回合都没跑)');
// 卡片这条路【永远】有事实,所以它一次都不会产出 quick_ask:
ok(['running', 'needs_you', 'done', 'stopped', 'dispatching']
  .includes(fromCardServer(quickCard({ turnSeq: 1, lastTurn: { seq: 1, ok: true, aborted: false } })).state),
  '② 卡片路径产出的一定是真五态之一,不再是 quick_ask(卡片在手 = 有事实)');

/* ═══════════ ③ 聚合:一条在跑的速查线程,它的事项也在跑 ═══════════ */

// 这一条钉的正是症状②(组标题「已停工」/ 组内那行「速查中」)。aggregateMissionState 本身
// 一个字没改 —— 变的是喂给它的五态不再是 quick_ask。
const runningQuick = fromCardServer(quickCard({ activeTurn: true, turnSeq: 1 })).state;
ok(runningQuick === 'running' && aggregate([runningQuick]) === 'running',
  `③ 在跑的速查线程 -> 事项聚合态 running(修前 aggregateMissionState(['quick_ask']) === 'stopped';got ${aggregate([runningQuick])})`);
const needsYouQuick = fromCardServer(quickCard({ pending: { questions: 1 }, turnSeq: 1 })).state;
ok(needsYouQuick === 'needs_you' && aggregate([needsYouQuick]) === 'needs_you',
  `③ 在问你的速查线程 -> 事项聚合态 needs_you(症状③:它这才进得了 focusThreadFor 与「N 条等你」;got ${aggregate([needsYouQuick])})`);
const doneQuick = fromCardServer(quickCard({ turnSeq: 1, lastTurn: { seq: 1, ok: true, aborted: false } })).state;
ok(doneQuick === 'done' && aggregate([doneQuick]) === 'done',
  `③ 跑完的速查线程 -> 事项聚合态 done(got ${aggregate([doneQuick])})`);
// 'quick_ask' 这个字符串本身在聚合里的语义一个字不变(它现在只代表「事实未知」):
ok(aggregate(['quick_ask']) === 'stopped', "③ aggregateMissionState(['quick_ask']) 仍是 stopped(事实未知不构成推进,§3.1 注)");

/* ═══════════ ④ 静态锁:逃生舱真的换了判据,而且两份抄写件逐字同一行 ═══════════ */

const src06i = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '06i-steward-core.js'), 'utf8');
const srcFront = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'public', 'js', 'mission-state.js'), 'utf8');
const src13d = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '13d-core-domain-routes.js'), 'utf8');

ok(src06i.includes("if (src.factsUnknown) state = 'quick_ask';") && srcFront.includes("if (src.factsUnknown) state = 'quick_ask';"),
  '④ 两份抄写件的第 0 条守卫逐字同一行(读 factsUnknown)');
ok(!/src\.kind === 'quick_ask'/.test(src06i) && !/src\.kind === 'quick_ask'/.test(srcFront),
  '④ 「kind 是 quick_ask 就短路」那条逃生舱在两份抄写件里一处都不剩(反向钉:不许有人把它加回来)');
ok(/factsUnknown: input\.factsUnknown === true/.test(src06i) && /factsUnknown: n\.factsUnknown === true/.test(srcFront),
  '④ 两份抄写件都把 factsUnknown 收进 sources 当证据(默认 false = 有事实)');
// 全仓唯一一个「明说没事实」的调用面:13d 那条刻意不读会话头的 else 支。多一处就说明有人又在
// 拿 kind 当 state 用了 —— 这条锁比钉住那一行本身更强。
// 只数【代码】不数注释:两份源码的注释里都写着这个键名(那是解释,不是调用面)。
const codeOnly = text => text.split(/\r?\n/).map(line => line.replace(/\/\/.*$/, '')).join('\n');
const producers = (codeOnly(src13d).match(/factsUnknown:\s*true/g) || []).length;
ok(producers === 1 && /else derived = deriveStewardThreadState\(\{ kind: 'quick_ask', factsUnknown: true \}\);/.test(src13d),
  `④ factsUnknown:true 在 13d 里恰好一处,就是那条不读会话头的 else 支(got ${producers} 处)`);
// 117r 收尾重钉(主会话)：原来这里钉的是【只有 13d 一处】。它钉的是「今天的代码长什么样」,
// 不是「什么必须成立」—— 13g 的 steward_threads_search 有一条同形的兜底支(没有卡片、一个事实都不喂),
// D5 之后它掉进「无 run、无回合」那条分支说出「交办中」,那是假话;主会话补了 factsUnknown: true,
// 这条计数锁就把一次【正确的】修改判成了违规。改成白名单 + 一条更强的伴随断言(下一条):
// 真正的危险不是「有几处」,而是「有人一边说没事实、一边把真事实喂进来」——那才是拿 kind 当 state 用。
const srcDir = path.join(repo, 'ruyi-workbench', 'app', 'src');
const ALLOWED_NO_FACTS = new Set(['13d-core-domain-routes.js', '13g-steward.js']);
const strayed = fs.readdirSync(srcDir).filter(f => f.endsWith('.js') && !ALLOWED_NO_FACTS.has(f)
  && /factsUnknown:\s*true/.test(codeOnly(fs.readFileSync(path.join(srcDir, f), 'utf8'))));
ok(strayed.length === 0, '④ 「明说没事实」的调用面只许出现在白名单里的两个文件(13d 的 else 支 / 13g 的 threads_search 兜底支)' + (strayed.length ? ' -> ' + strayed.join(',') : ''));
ok(/factsUnknown: true \}\)\s*$|deriveStewardThreadState\(\{ kind: 'quick_ask', factsUnknown: true \}\)/.test(codeOnly(fs.readFileSync(path.join(srcDir, '13g-steward.js'), 'utf8'))),
  '④ 13g 那条兜底支确实是「速查那一侧才说没事实」(mission 那一侧仍落 dispatching,逐字节不变)');
// 伴随(比原条更强):每一个「明说没事实」的调用,对象字面量里【不许】同时出现任何一个真事实键。
// 一边说没事实一边喂事实 = 用一个字段把真相盖掉,这正是本刀要根除的那种用法。
const FACT_KEYS = /\b(activeTurn|turnSeq|pending|runCount|liveRuns|resultStatus|autoMode|milestonesDone|ledgerless|lastTurnFailed)\b/;
const maskers = [];
for (const file of fs.readdirSync(srcDir).filter(f => f.endsWith('.js'))) {
  const code = codeOnly(fs.readFileSync(path.join(srcDir, file), 'utf8'));
  let at = code.indexOf('factsUnknown: true');
  while (at >= 0) {
    const open = code.lastIndexOf('{', at);
    let depth = 0; let close = open;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') depth += 1;
      else if (code[i] === '}') { depth -= 1; if (depth === 0) { close = i; break; } }
    }
    const literal = code.slice(open, close + 1);
    if (FACT_KEYS.test(literal)) maskers.push(file + ': ' + literal.replace(/\s+/g, ' ').slice(0, 90));
    at = code.indexOf('factsUnknown: true', at + 1);
  }
}
ok(maskers.length === 0, '④ 没有任何一处一边说「没事实」一边把真事实喂进来(那是拿一个字段盖住真相)' + (maskers.length ? ' -> ' + maskers.join(' | ') : ''));

/* ═══════════ ⑤ 看板行上的速查徽标:身份没消失,只是搬了家 ═══════════ */

const board = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'public', 'js', 'steward-board.js'), 'utf8');
ok(/String\(row\.kind \|\| ''\) === 'quick_ask'/.test(board),
  "⑤ 看板行按【kind】给徽标(不是按 state)");
ok(/t\('mission\.state\.quick_ask'\)/.test(board),
  '⑤ 徽标文案复用既有键 mission.state.quick_ask(不新开 locale 键)');
// 徽标是【并列】的兄弟节点,不许替换那颗五态点:paintDot 那一处必须还在同一个 head 里。
ok(/head\.appendChild\(paintDot\(el\('span', 'steward-board-dot'\), threadState\)\)/.test(board),
  '⑤ 五态那颗点仍在(徽标是并列的兄弟,不替换它)');

console.log(fail ? `THREAD STATE QUICK KIND UNIT: ${fail} FAILURE(S)` : 'THREAD STATE QUICK KIND UNIT: ALL PASS');
process.exit(fail ? 1 : 0);
