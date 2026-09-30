'use strict';
// 架构还债批 4:线程五态的两份抄写件(服务端 06i deriveStewardThreadState / stewardThreadStateFromCard 与
// 前端 public/js/mission-state.js deriveMissionState / fromCard)改成【同 id、同顺序】的判定表之后,
// 由本件在整张证据网格上逐格比对,替掉 steward-tools.static.e2e.js ⑥ 那把按源码字面量对账的锁。
//   [D1] 两边规则 id 与顺序相同(前端运行时导出 RULE_IDS;服务端表未导出,结构性读 06i 源码的表)。
//   [D2] 证据网格(每个判据键取遍它在判定里能区分的边界值,笛卡尔积)上两边 state/sources/label 逐格相同。
//   [D3] 同一网格上,判定表与改表前那串 if/else(下面 legacyDecide 原样抄存)逐格同态 —— 本刀零语义变化。
//   [D4] 卡片适配器:由网格派生的卡片形状上 fromCard 两边逐格相同。
//   [D5] hunt2-steward ④:末回合成败账只在盖得住当前回合(lastTurn.seq >= turnSeq)时才算数,两边同判。
//   [D6] hunt3:queued(回合排在管家仲裁器里,还没进 activeChildren)与 activeTurn 同进 live 规则 —— 网格多一根轴,
//        对照神谕同刀补上这一格(修前排队中的线程被报成「已收工」)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { constBlock } = require('../lib/source-slice');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-state-diff-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const APP = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(APP, 'server.js'));
const MissionState = require(path.join(APP, 'public', 'js', 'mission-state.js'));

// 改表前(批 3 及以前)两份抄写件里逐字相同的那串分支,原样留作判定表的对照神谕。
// hunt3 唯一的改动:running 那一支补上 queued(与判定表 live 规则同刀),其余逐字未动。
function legacyDecide(src) {
  let state;
  if (src.factsUnknown) state = 'quick_ask';
  else if (src.pendingTotal > 0) state = 'needs_you';
  else if (src.resultStatus === 'complete') state = 'done';
  else if (src.activeTurn || src.queued || src.autoMode === 'until-done' || src.liveRuns > 0) state = 'running';
  else if (src.runCount === 0 && src.turnSeq === 0 && src.milestonesDone === 0 && src.resultStatus !== 'stopped') state = 'dispatching';
  else if (src.ledgerless && src.turnSeq > 0) state = src.lastTurnFailed ? 'stopped' : 'done';
  else state = 'stopped';
  return state;
}

// 每个键取遍判定里能区分的值;kind/budgetExhausted/milestonesTotal 不参与判定,但进 sources,也一并过网格。
const AXES = {
  factsUnknown: [false, true],
  pending: [undefined, {}, { questions: 1 }, { permissions: 0, plans: 2 }],
  resultStatus: ['', 'complete', 'stopped'],
  activeTurn: [false, true],
  queued: [false, true],
  autoMode: [undefined, 'off', 'until-done', 'supervised'],
  liveRuns: [0, 1],
  runCount: [0, 1, 2],
  turnSeq: [0, 1, 3],
  milestonesDone: [0, 1],
  ledgerless: [false, true],
  lastTurnFailed: [false, true],
  kind: [undefined, 'mission', 'quick_ask'],
};

function* grid() {
  const keys = Object.keys(AXES);
  const idx = keys.map(() => 0);
  while (true) {
    const input = {};
    keys.forEach((k, i) => { const v = AXES[k][idx[i]]; if (v !== undefined) input[k] = v; });
    yield input;
    let i = keys.length - 1;
    while (i >= 0 && ++idx[i] === AXES[keys[i]].length) { idx[i] = 0; i--; }
    if (i < 0) return;
  }
}

test('[D1] 两边判定表的规则 id 与顺序相同', () => {
  const front = MissionState.RULE_IDS;
  assert.ok(Array.isArray(front) && front.length >= 7, '前端导出 RULE_IDS');
  const block = constBlock(fs.readFileSync(path.join(APP, 'src', '06i-steward-core.js'), 'utf8'), 'STEWARD_THREAD_STATE_RULES');
  assert.ok(block.length > 200, '切到了服务端 STEWARD_THREAD_STATE_RULES');
  const server = [...block.matchAll(/\bid: '([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual(server, front);
  assert.equal(front[front.length - 1], 'fallback', '兜底规则排在最后');
});

test('[D2][D3] 证据网格上两份抄写件逐格相同,且与改表前的分支链同态', () => {
  let cells = 0;
  const seen = new Set();
  for (const input of grid()) {
    const a = srv.deriveStewardThreadState(input);
    const b = MissionState.deriveMissionState(input);
    cells++;
    seen.add(a.state);
    const where = JSON.stringify(input);
    assert.equal(a.state, b.state, `state 不同 @ ${where}`);
    assert.deepEqual(a.sources, b.sources, `sources 不同 @ ${where}`);
    // 人话两边只在 quick_ask 上有意不同(服务端「速查中」/ 前端「速问」,见 thread-state-quick-kind.test.js)。
    if (a.state !== 'quick_ask') assert.equal(a.label, b.label, `label 不同 @ ${where}`);
    assert.equal(a.state, legacyDecide(a.sources), `判定表与改表前的分支链不同态 @ ${where}`);
  }
  assert.ok(cells > 10000, `网格够大(${cells} 格)`);
  assert.deepEqual([...seen].sort(), [...MissionState.STATES].sort(), '网格覆盖到了每一个状态');
});

test('[D4] 卡片适配器两边逐格相同', () => {
  let cells = 0;
  for (const input of grid()) {
    if (input.factsUnknown || input.kind !== undefined) continue;   // 卡片没有 factsUnknown 这一格;kind 由 quick 决定
    for (const quick of [false, true]) {
      for (const lastRun of [null, { live: true, paused: false }, { live: true, paused: true }]) {
        // hunt2-steward ④:带 seq 的两格 —— seq 0 在 turnSeq>0 的格上是过期账(不算数),seq 9 恒盖得住。
        for (const lastTurn of [null, { ok: true }, { ok: false }, { ok: true, aborted: true }, { seq: 0, ok: false }, { seq: 9, ok: false }, { seq: 9, ok: true, aborted: true }]) {
          const card = {
            quick,
            status: input.ledgerless ? 'none' : 'active',
            pending: input.pending,
            activeTurn: input.activeTurn,
            queued: input.queued,
            runCount: input.runCount,
            turnSeq: input.turnSeq,
            lastRun,
            lastTurn,
            mission: {
              autoMode: input.autoMode,
              budgetExhausted: input.kind === 'mission',
              result: input.resultStatus ? { status: input.resultStatus } : null,
              milestonesTotal: input.milestonesDone ? 2 : 0,
              done: input.milestonesDone,
            },
          };
          const a = srv.stewardThreadStateFromCard(card);
          const b = MissionState.fromCard(card);
          cells++;
          assert.equal(a.state, b.state, `fromCard state 不同 @ ${JSON.stringify(card)}`);
          assert.deepEqual(a.sources, b.sources, `fromCard sources 不同 @ ${JSON.stringify(card)}`);
        }
      }
    }
  }
  assert.ok(cells > 10000, `卡片网格够大(${cells} 格)`);
  assert.equal(srv.stewardThreadStateFromCard(null).state, MissionState.fromCard(null).state, 'null 卡片两边同态');
});

test('[D6] 排队中的回合算进行中(两边同判,且不压过待决与结果章)', () => {
  const idle = { status: 'none', turnSeq: 2, runCount: 0, lastTurn: null, mission: {} };
  assert.equal(srv.stewardThreadStateFromCard(idle).state, 'done', '前提:空闲的无账本线程 -> done');
  assert.equal(MissionState.fromCard(idle).state, 'done');
  const queued = { ...idle, queued: true };
  assert.equal(srv.stewardThreadStateFromCard(queued).state, 'running', '服务端卡片:排队中 -> running');
  assert.equal(MissionState.fromCard(queued).state, 'running', '前端卡片:排队中 -> running');
  assert.equal(MissionState.fromSnapshot({ queued: true, mission: {}, cursor: { turnSeq: 2 } }).state, 'running', '前端详情快照同判');
  assert.equal(srv.stewardThreadStateFromHead({ id: 'sess_bbbbbbbbbbbbbbbb', turnSeq: 2 }, { kind: 'mission', queued: true }).state, 'running', '会话头适配器同判');
  for (const input of [{ queued: true, pending: { questions: 1 } }, { queued: true, resultStatus: 'complete' }]) {
    assert.equal(srv.deriveStewardThreadState(input).state, MissionState.deriveMissionState(input).state);
    assert.notEqual(srv.deriveStewardThreadState(input).state, 'running', `优先级不变 @ ${JSON.stringify(input)}`);
  }
});

test('[D5] 过期的末回合成败账不算数(卡片 / 会话头两个适配器,两边同判)', () => {
  // 管家第 1 回合失败留下 ok:false;之后用户在 2.0 里自己跑成功了第 2、3 回合(用户回合不写这份账)。
  const stale = { quick: false, status: 'none', turnSeq: 3, runCount: 0, lastTurn: { seq: 1, ok: false, aborted: false }, mission: {} };
  assert.equal(srv.stewardThreadStateFromCard(stale).state, 'done', '服务端卡片:过期账 -> done');
  assert.equal(MissionState.fromCard(stale).state, 'done', '前端卡片:过期账 -> done');
  const covering = { ...stale, lastTurn: { seq: 3, ok: false, aborted: false } };
  assert.equal(srv.stewardThreadStateFromCard(covering).state, 'stopped', '服务端卡片:盖得住的失败账 -> stopped');
  assert.equal(MissionState.fromCard(covering).state, 'stopped', '前端卡片:盖得住的失败账 -> stopped');
  const head = { id: 'sess_aaaaaaaaaaaaaaaa', turnSeq: 3, stewardLastTurn: { seq: 1, ok: false, aborted: false, errorClass: 'idle_timeout' } };
  assert.equal(srv.stewardThreadStateFromHead(head, { kind: 'mission' }).state, 'done', '会话头:过期账 -> done');
  assert.equal(srv.stewardThreadStateFromHead({ ...head, stewardLastTurn: { seq: 3, ok: false } }, { kind: 'mission' }).state, 'stopped', '会话头:盖得住的失败账 -> stopped');
});
