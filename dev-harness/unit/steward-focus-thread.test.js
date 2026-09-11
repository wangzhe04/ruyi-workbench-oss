#!/usr/bin/env node
'use strict';

// 第117波 117h（27 号文 §5 117h 行 /「宽屏右侧常驻『现在这一件』= 焦点线程」）：焦点线程的优先级真值表。
// 与 dev-harness/unit/steward-quick-replies.test.js 同款约定：ESM 模块直接 import 磁盘文件到 node:test，
// 零磁盘写、零 DOM、每条用例只构造字面量。
//
// 断的是这条优先级，一格都不许错位：
//   等你（needs_you） ＞ 在跑（running） ＞ 失败（五态里的 stopped，mission-state.js 没有 failed 态）
//     ＞ 最近更新
// 同一档里【更晚更新的赢】；空数组 → null；纯函数（不改入参，不读 DOM，不认识卡片形状 ——
// 五态由调用方经 mission-state.js 算好后喂进来，所以这里长不出第二套五态判据）。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'steward-board.js');
let modulePromise;
function loadModule() {
  // steward-board.js 顶层 import 了 mission-state / net / thread-facts / steward-chips /
  // steward-drawer。它们在 Node 下都可直接 import；这条链上的 state.js 会在模块顶层写一次
  // `window.state` 的兼容层 —— 给它一个 window 别名即可，不引入任何 DOM。测出来的仍然是纯函数本身。
  // （121-K1：dockToneForMissionState / elapsedLabel 随交办台退役搬进叶子 thread-facts.js。）
  if (!globalThis.window) globalThis.window = globalThis;
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE_PATH).href);
  return modulePromise;
}

const row = (sessionId, state, updatedAt) => ({ sessionId, state, updatedAt });

describe('focusThreadFor —— 焦点线程优先级', () => {
  it('空清单没有焦点（不编一个出来）', async () => {
    const { focusThreadFor } = await loadModule();
    assert.equal(focusThreadFor([]), null);
    assert.equal(focusThreadFor(null), null);
    assert.equal(focusThreadFor(undefined), null);
    assert.equal(focusThreadFor('not-an-array'), null);
  });

  it('没有 sessionId 的行不算数', async () => {
    const { focusThreadFor } = await loadModule();
    assert.equal(focusThreadFor([{ state: 'needs_you', updatedAt: '2026-09-06T10:00:00.000Z' }]), null);
  });

  it('等你压过在跑、失败与最近更新', async () => {
    const { focusThreadFor } = await loadModule();
    const picked = focusThreadFor([
      row('a', 'running', '2026-09-06T12:00:00.000Z'),
      row('b', 'needs_you', '2026-09-06T08:00:00.000Z'),
      row('c', 'stopped', '2026-09-06T13:00:00.000Z'),
      row('d', 'done', '2026-09-06T14:00:00.000Z'),
    ]);
    assert.equal(picked.sessionId, 'b');
  });

  it('没有等你时在跑赢', async () => {
    const { focusThreadFor } = await loadModule();
    const picked = focusThreadFor([
      row('a', 'stopped', '2026-09-06T13:00:00.000Z'),
      row('b', 'running', '2026-09-06T09:00:00.000Z'),
      row('c', 'dispatching', '2026-09-06T14:00:00.000Z'),
    ]);
    assert.equal(picked.sessionId, 'b');
  });

  it('没有等你、没有在跑时「失败」（stopped）赢', async () => {
    const { focusThreadFor } = await loadModule();
    const picked = focusThreadFor([
      row('a', 'done', '2026-09-06T14:00:00.000Z'),
      row('b', 'stopped', '2026-09-06T09:00:00.000Z'),
      row('c', 'dispatching', '2026-09-06T13:00:00.000Z'),
    ]);
    assert.equal(picked.sessionId, 'b');
  });

  it('三档都没有时退到最近更新', async () => {
    const { focusThreadFor } = await loadModule();
    const picked = focusThreadFor([
      row('a', 'done', '2026-09-06T10:00:00.000Z'),
      row('b', 'dispatching', '2026-09-06T15:00:00.000Z'),
      row('c', 'quick_ask', '2026-09-06T12:00:00.000Z'),
    ]);
    assert.equal(picked.sessionId, 'b');
  });

  it('同一档里更晚更新的赢', async () => {
    const { focusThreadFor } = await loadModule();
    const picked = focusThreadFor([
      row('a', 'needs_you', '2026-09-06T09:00:00.000Z'),
      row('b', 'needs_you', '2026-09-06T11:00:00.000Z'),
      row('c', 'needs_you', '2026-09-06T10:00:00.000Z'),
    ]);
    assert.equal(picked.sessionId, 'b');
  });

  it('没有 updatedAt 也不会崩，只是排在带时间的后面', async () => {
    const { focusThreadFor } = await loadModule();
    const picked = focusThreadFor([
      { sessionId: 'a', state: 'done' },
      row('b', 'done', '2026-09-06T09:00:00.000Z'),
    ]);
    assert.equal(picked.sessionId, 'b');
    assert.equal(focusThreadFor([{ sessionId: 'only' }]).sessionId, 'only');
  });

  it('纯函数：不改入参（顺序与元素都不动）', async () => {
    const { focusThreadFor } = await loadModule();
    const input = [
      row('a', 'done', '2026-09-06T10:00:00.000Z'),
      row('b', 'needs_you', '2026-09-06T09:00:00.000Z'),
    ];
    const before = JSON.stringify(input);
    focusThreadFor(input);
    assert.equal(JSON.stringify(input), before);
  });

  it('返回的就是原来那一行对象（调用方拿得到 sessionId 之外的字段）', async () => {
    const { focusThreadFor } = await loadModule();
    const wanted = row('b', 'running', '2026-09-06T09:00:00.000Z');
    assert.equal(focusThreadFor([row('a', 'done', '2026-09-06T10:00:00.000Z'), wanted]), wanted);
  });
});
