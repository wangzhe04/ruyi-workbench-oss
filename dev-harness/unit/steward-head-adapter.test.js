'use strict';
// 架构还债批 1 #1:会话头 → 五态证据只走 06i 的 stewardThreadStateFromHead 一处。
//   [H1] 适配器与修前四处手写的喂法逐键等价(穷举 head 形状:无头 / 无账本 / 有账本 / 收工 / 末回合失败 / 中断)。
//   [H2] 06i 之外不再手写会话头证据键(13d / 13k / 13o / 13r 修前各一份)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-head-adapter-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { deriveStewardThreadState, stewardThreadStateFromHead } = srv;

// 修前 13d ②支的原样喂法(最宽的那一份:head 可为 null)。
function handWritten(head, extra) {
  return deriveStewardThreadState({
    ...extra,
    autoMode: head && head.mission && head.mission.autoMode,
    resultStatus: (head && head.mission && head.mission.result && head.mission.result.status) || '',
    turnSeq: head && head.turnSeq,
    ledgerless: !(head && head.mission),
    lastTurnFailed: !!(head && head.stewardLastTurn && (head.stewardLastTurn.ok === false || head.stewardLastTurn.aborted === true)),
  });
}

test('[H1] 适配器与修前手写喂法逐键等价', () => {
  const heads = [
    null,
    { id: 's1' },
    { id: 's2', turnSeq: 3 },
    { id: 's3', turnSeq: 2, stewardLastTurn: { ok: false } },
    { id: 's4', turnSeq: 2, stewardLastTurn: { ok: true, aborted: true } },
    { id: 's5', mission: {} },
    { id: 's6', turnSeq: 1, mission: { autoMode: 'until-done' } },
    { id: 's7', turnSeq: 4, mission: { result: { status: 'complete' } } },
    { id: 's8', turnSeq: 4, mission: { result: { status: 'stopped' } }, stewardLastTurn: { ok: false } },
  ];
  const extras = [
    { kind: 'mission' },
    { kind: 'mission', pending: { permissions: 1 }, activeTurn: false, runCount: 0 },
    { kind: 'quick_ask', activeTurn: true },
    { kind: 'mission', pending: null, activeTurn: false, runCount: 0 },
  ];
  for (const head of heads) for (const extra of extras) {
    assert.deepEqual(stewardThreadStateFromHead(head, extra), handWritten(head, extra), JSON.stringify({ head, extra }));
  }
});

test('[H2] 06i 之外不再手写会话头证据键', () => {
  const offenders = [];
  for (const f of fs.readdirSync(SRC).filter(n => n.endsWith('.js') && n !== '06i-steward-core.js')) {
    const text = fs.readFileSync(path.join(SRC, f), 'utf8');
    if (/head\.stewardLastTurn\.ok === false/.test(text) || /ledgerless:\s*!\(?head/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, [], '会话头证据键请经 stewardThreadStateFromHead(06i)读,不要在调用面手写');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
