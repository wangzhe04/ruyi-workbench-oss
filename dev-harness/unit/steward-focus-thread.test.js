#!/usr/bin/env node
'use strict';

// 第117波 117h（27 号文 §5 117h 行 /「宽屏右侧常驻『现在这一件』= 焦点线程」）：焦点线程的优先级真值表。
// 与 dev-harness/unit/steward-quick-replies.test.js 同款约定：ESM 模块直接 import 磁盘文件到 node:test，
// 零磁盘写、零 DOM、每条用例只构造字面量。
//
// 断的是这条优先级，一格都不许错位：
//   等你（needs_you） ＞ 在跑（running） ＞ 最近发生的那一件（不分 done / stopped）
//
// 124 走查（用户 2026-09-15 真机拍板）：第三档原来是「失败（stopped）」，**没有时效尺** ——
// 一条昨天停工的线程会永远赢过今天刚做完的那条，于是每有一条线程跑完，右栏就被拽回那条旧的。
// 现在第三档就是「最近发生的」；失败的可见性由左栏五态药丸与收工卡承担，不靠把一条旧的失败
// 永久钉在右栏来实现。下面第三条用例因此从「stopped 赢」翻面成「更晚更新的赢」。
// 同一档里【更晚更新的赢】；空数组 → null；纯函数（不改入参，不读 DOM，不认识卡片形状 ——
// 五态由调用方经 mission-state.js 算好后喂进来，所以这里长不出第二套五态判据）。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'steward-board.js');
// 124 还债④：判据本体搬到了叶子里；看板仍按原名 re-export，所以上面那一行一个字没改。
const LEAF_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'thread-facts.js');
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

  it('等你压过在跑、已停工与最近更新', async () => {
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

  // 124 走查的正身：同一组数据，修前挑 b（那条更早的 stopped），修后挑 a（刚做完的那条）。
  // 「昨天停工的那条永远赢过今天刚做完的」在这条用例里就是 b 与 a 的关系。
  it('没有等你、没有在跑时，最近发生的赢 —— 已停工不再压过刚做完的', async () => {
    const { focusThreadFor } = await loadModule();
    const picked = focusThreadFor([
      row('a', 'done', '2026-09-06T14:00:00.000Z'),
      row('b', 'stopped', '2026-09-06T09:00:00.000Z'),
      row('c', 'dispatching', '2026-09-06T13:00:00.000Z'),
    ]);
    assert.equal(picked.sessionId, 'a');
  });

  // 反过来也要成立：停工【就是】最近发生的那一件时，它照样该被看见（第三档不是「排除 stopped」，
  // 是「不再给它加塞」）。
  it('停工就是最近发生的那一件时，它仍然拿焦点', async () => {
    const { focusThreadFor } = await loadModule();
    const picked = focusThreadFor([
      row('a', 'done', '2026-09-06T09:00:00.000Z'),
      row('b', 'stopped', '2026-09-06T14:00:00.000Z'),
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
  // ── 124 还债④（40 号文 §8.5 ④）：判据搬家之后的身份锁 ──────────────────────────
  // 服务端 13q 修前自己也挑一条焦点（`rows.find(needs_you) || rows.find(running) || rows[0]`）回在
  // visit.focus 里，与这一份的第三档不一样 —— 同一个问题两处判。收法是服务端只投影 threads，
  // 管家对话（steward-conversation.js）与看板都读这一份纯函数；它因此从 steward-board.js 搬进了
  // 两边都够得着的叶子 thread-facts.js。
  //
  // 这条用例钉的不是「两处都有这个名字」，而是**两处是同一个函数对象** —— 哪天有人在看板里
  // 抄一份回去（而不是 re-export），上面那整张真值表仍然全绿，只有这一条会红。
  it('124 还债④：判据住在叶子 thread-facts.js，看板导出的是【同一个函数对象】而不是抄的第二份', async () => {
    const board = await loadModule();
    const leaf = await import(pathToFileURL(LEAF_PATH).href);
    assert.equal(typeof leaf.focusThreadFor, 'function', 'thread-facts.js 必须导出 focusThreadFor');
    assert.equal(board.focusThreadFor, leaf.focusThreadFor, '看板导出的必须就是叶子那一个（re-export，不是副本）');
  });
});
