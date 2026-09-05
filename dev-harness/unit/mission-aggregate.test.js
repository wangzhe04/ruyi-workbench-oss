// Unit: 第 116 波 116g(27 号文 §3.1「事项跨会话升格」)—— 事项级聚合状态纯函数 aggregateMissionState。
//
// 为什么单列一件:聚合态是【全仓唯一】的事项状态定义(06i-steward-core.js,与五态判据
// deriveStewardThreadState 同住一屋)。它决定看板事项行的颜色、管家总览的排序、steward_missions 的
// 输出;一旦有人在 13d/13g 里另写一份等价判断,两处就会在边界上分叉。这件测试穷举它的真值表 ——
// 期望值直接抄 §3.1 的规则文字,不是对生产实现分支顺序的镜像重写。
//
// 规则(§3.1,用户 2026-09-03 拍板):
//   任一 needs_you -> needs_you;否则全部 done -> done;否则任一 running -> running;
//   否则任一 dispatching -> dispatching;否则 stopped;空数组 -> dispatching。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mission-aggregate-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const { aggregateMissionState, deriveStewardThreadState } = srv;

ok(typeof aggregateMissionState === 'function', '① aggregateMissionState 由产物导出(单点纯函数)');

/* ═══════════ ① 五条规则的定点断言(逐条抄 §3.1) ═══════════ */

const FIVE = ['dispatching', 'running', 'needs_you', 'done', 'stopped'];

ok(aggregateMissionState([]) === 'dispatching', '① 空数组 -> dispatching(事项刚建、还没线程)');
ok(aggregateMissionState(['needs_you']) === 'needs_you', '① 单条 needs_you -> needs_you');
ok(aggregateMissionState(['done']) === 'done', '① 单条 done -> done');
ok(aggregateMissionState(['done', 'done', 'done']) === 'done', '① 全部 done -> done');
ok(aggregateMissionState(['done', 'stopped']) === 'stopped', '① 差一条没收工 -> 不算 done');
ok(aggregateMissionState(['running', 'done']) === 'running', '① 有人在跑 -> running');
ok(aggregateMissionState(['dispatching', 'stopped']) === 'dispatching', '① 有人在交办、没人在跑 -> dispatching');
ok(aggregateMissionState(['stopped', 'stopped']) === 'stopped', '① 全停工 -> stopped');

// needs_you 的优先级压过其它一切(包括同时有 running / 全部其余 done)。
for (const other of FIVE) {
  ok(aggregateMissionState(['needs_you', other]) === 'needs_you', `① needs_you 压过 ${other}`);
  ok(aggregateMissionState([other, 'needs_you']) === 'needs_you', `① 顺序无关:${other} + needs_you -> needs_you`);
}

// running 压过 dispatching / stopped / done(但压不过 needs_you,上面已断言)。
ok(aggregateMissionState(['stopped', 'running']) === 'running', '① running 压过 stopped');
ok(aggregateMissionState(['dispatching', 'running']) === 'running', '① running 压过 dispatching');
ok(aggregateMissionState(['done', 'running', 'stopped']) === 'running', '① running 压过 done+stopped 混合');
// dispatching 压过 stopped/done(在没有 needs_you / running 时)。
ok(aggregateMissionState(['done', 'dispatching']) === 'dispatching', '① dispatching 压过 done(没全 done 就不是 done)');
ok(aggregateMissionState(['stopped', 'dispatching', 'done']) === 'dispatching', '① dispatching 压过 stopped+done');

/* ═══════════ ② 五态全组合穷举(1..3 条线程)与规则文字逐格对账 ═══════════ */

// 期望值由规则【文字】重新实现一遍(刻意换一种写法:先算集合再判定,与生产实现的 if 链不同形),
// 两份实现在 155 个组合上必须逐格相同 —— 这才是「抄写件对账」而不是「镜像自己」。
function expected(states) {
  if (!states.length) return 'dispatching';
  const set = new Set(states);
  if (set.has('needs_you')) return 'needs_you';
  if (set.size === 1 && set.has('done')) return 'done';
  if (set.has('running')) return 'running';
  if (set.has('dispatching')) return 'dispatching';
  return 'stopped';
}
let combos = 0, mismatches = [];
for (const a of FIVE) {
  const one = [a];
  if (aggregateMissionState(one) !== expected(one)) mismatches.push(one.join('+'));
  combos++;
  for (const b of FIVE) {
    const two = [a, b];
    if (aggregateMissionState(two) !== expected(two)) mismatches.push(two.join('+'));
    combos++;
    for (const c of FIVE) {
      const three = [a, b, c];
      if (aggregateMissionState(three) !== expected(three)) mismatches.push(three.join('+'));
      combos++;
    }
  }
}
ok(combos === 155, `② 穷举 1..3 条线程的全部五态组合(got ${combos})`);
ok(mismatches.length === 0, '② 155 个组合逐格与规则文字一致' + (mismatches.length ? ' -> ' + mismatches.slice(0, 6).join(', ') : ''));

/* ═══════════ ③ 入参鲁棒性:非数组、空洞、未知取值 ═══════════ */

ok(aggregateMissionState(null) === 'dispatching', '③ null -> dispatching(与空数组同)');
ok(aggregateMissionState(undefined) === 'dispatching', '③ undefined -> dispatching');
ok(aggregateMissionState('needs_you') === 'dispatching', '③ 非数组入参不当成单元素,退化成空');
ok(aggregateMissionState([null, undefined]) === 'stopped', '③ 空洞归一成空串,既非 done 也非 running -> stopped');
// 'quick_ask' 是 mission-state.js 的第六个取值(五态之外的逃生舱)。它按规则落到 stopped ——
// 这是刻意的语义,不是漏判:速问线程不构成事项的推进。
ok(aggregateMissionState(['quick_ask']) === 'stopped', '③ 纯速问事项 -> stopped(§3.1 注)');
ok(aggregateMissionState(['quick_ask', 'needs_you']) === 'needs_you', '③ 速问 + 等你 -> 等你');
ok(aggregateMissionState(['quick_ask', 'done']) === 'stopped', '③ 速问 + 收工 -> 不算全收工');

/* ═══════════ ④ 与五态判据同源:deriveStewardThreadState 的输出直接喂得进去 ═══════════ */

const single = deriveStewardThreadState({ kind: 'mission', pending: { permissions: 1 } });
ok(single.state === 'needs_you' && aggregateMissionState([single.state]) === 'needs_you',
  '④ 单线程事项的聚合态 === 该线程自己的五态(未归类事项的定义性质)');
const runningThread = deriveStewardThreadState({ kind: 'mission', activeTurn: true });
ok(runningThread.state === 'running' && aggregateMissionState([runningThread.state]) === 'running',
  '④ 进行中线程 -> 事项进行中');

console.log(fail ? `MISSION AGGREGATE UNIT: ${fail} FAILURE(S)` : 'MISSION AGGREGATE UNIT: ALL PASS');
process.exit(fail ? 1 : 0);
