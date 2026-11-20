'use strict';
// 151 阶段 4A:前端搜索面跟上「后台建索引」。
//   [B1] 后台还在建(coverage.background.state=building)时,两发之间计数没涨也接着拉(修前停下、露出「继续搜索」);
//   [B2] 只剩被跳过的会话(超出预算、稍后自动重试)时不空转,说明里讲清跳过了几个;
//   [B3] 命中方式小标的三个键在中英两份 locale(public 与 docs 各一份)里都有;左栏按 matchMode 取键。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
const loadState = () => import(pathToFileURL(path.join(root, 'ruyi-workbench/app/public/js/session-search-state.js')).href);
const coverage = (indexed, total, background) => ({ phase: 'building', complete: false, sessions: total, indexedSessions: indexed, pendingSessions: total - indexed, background });

test('[B1] keeps polling while the background builder is busy even if the count did not move', async () => {
  const { sessionSearchFollowUp } = await loadState();
  const previous = { coverage: coverage(40, 100) };
  const busy = sessionSearchFollowUp({ response: { ok: true, results: [], coverage: coverage(40, 100, { state: 'building', skippedSessions: 0 }) }, previous, refreshAttempt: 2 });
  assert.equal(busy.next, true);
  // 4A v2:后台在首屏静默期/回合在跑时报 waiting,同样接着拉(修前 v1 报 idle,前端在 0 条进度时就停了)。
  const waiting = sessionSearchFollowUp({ response: { ok: true, results: [], coverage: coverage(0, 100, { state: 'waiting', skippedSessions: 0 }) }, previous: { coverage: coverage(0, 100) }, refreshAttempt: 1 });
  assert.equal(waiting.next, true);
  // 4A v3:在等时放慢到 2.5 s 一发;在建时照旧 0.5 s。
  assert.equal(waiting.delayMs, 2500);
  assert.equal(busy.delayMs, 500);
  const legacy = sessionSearchFollowUp({ response: { ok: true, results: [], coverage: coverage(40, 100) }, previous, refreshAttempt: 2 });
  assert.equal(legacy.next, false, 'without background state the old rule (count must advance) still applies');
});

test('[B2] pending sessions that are only skipped do not spin; the notice says how many were skipped', async () => {
  const { sessionSearchFollowUp, sessionSearchNotices } = await loadState();
  const response = { ok: true, results: [{ id: 'a', snippet: 'x' }], coverage: { ...coverage(99, 100, { state: 'building', skippedSessions: 1 }), phase: 'idle' } };
  const step = sessionSearchFollowUp({ response, previous: { coverage: response.coverage }, refreshAttempt: 1 });
  assert.equal(step.next, false);
  const notices = sessionSearchNotices({ query: 'ab', results: response.results, coverage: response.coverage, canResume: true });
  assert.deepEqual(notices, [{ key: 'session.searchSkippedSessions', params: { indexed: 99, total: 100, count: 1 } }]);
});

test('[B3] match-mode labels exist in every locale and the rail maps all three modes', () => {
  const keys = ['session.searchMatchLexical', 'session.searchMatchSemantic', 'session.searchMatchBoth', 'session.searchSkippedSessions'];
  for (const file of ['ruyi-workbench/app/public/locales/zh-CN.json', 'ruyi-workbench/app/public/locales/en-US.json', 'docs/i18n/locales/zh-CN.json', 'docs/i18n/locales/en-US.json']) {
    const catalog = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    for (const key of keys) assert.ok(typeof catalog[key] === 'string' && catalog[key].length, `${file} has ${key}`);
  }
  const board = fs.readFileSync(path.join(root, 'ruyi-workbench/app/public/js/steward-board.js'), 'utf8');
  const table = /const RAIL_MATCH_KEYS = (\{[^}]*\});/.exec(board);
  assert.ok(table, 'rail match-mode table present');
  assert.deepEqual(Object.keys(eval('(' + table[1] + ')')).sort(), ['both', 'lexical', 'semantic']);
});
