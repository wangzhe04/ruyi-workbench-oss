#!/usr/bin/env node
'use strict';

// 2026-09-14（用户走查「管家切工作台时线程名过渡缺失／重影」）：共享元素挂名判据的真值表。
// 与 unit/shell-mode-intent-order.test.js 同款约定：`pathToFileURL` + `import()` 直接从磁盘加载
// ESM，零磁盘写、零真 DOM。shell-mode.js 与 app-frame.js 都是叶子（零 import），依赖全走工厂参数。
//
// 钉的是两条新契约：
//   ① 「在工作台打开」（openInWorkbench）＝【先切视角、后 openSession】——拍旧帧那一刻
//      state.currentSession 还不是焦点线程，于是挂名判据必须能问到「将要打开的那一条」：
//      控制器的 pendingOpenThreadId() 只在 applyShellMode 那一拍里非空，问完即清。
//   ② markSharedThread 的兜底：两边标题印的不是同一串字（管家侧 displayTitle、工作台侧
//      session.title 原话）时【不挂名】——两串不同的字按「同一个东西」变形叠化，中途换人比不飞更糟。
//
// 反向验证：把 shell-mode.js 里 `pendingOpenThreadId = id;` 注掉 → 用例一必红；
// 把 app-frame.js 里的文字逐字判据注掉 → 用例四必红。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SHELL_MODE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'shell-mode.js');
const APP_FRAME_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'app-frame.js');
function loadModule(file) {
  return import(pathToFileURL(file).href);
}

// 最小 document：认 documentElement 的属性表、getElementById 与【只收集不执行】的
// startViewTransition（与 shell-mode-intent-order.test.js 同一份手法）。
function fakeDoc() {
  const attrs = new Map();
  const pending = [];
  const root = {
    getAttribute: name => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => { attrs.set(String(name), String(value)); },
    dataset: {},
  };
  return {
    documentElement: root,
    getElementById: () => null,
    pending,
    startViewTransition: write => { pending.push(write); return { finished: Promise.resolve() }; },
    flushInOrder: () => { for (const write of pending.splice(0, pending.length)) write(); },
  };
}

function fakeStorage() {
  const map = new Map();
  return { getItem: key => (map.has(key) ? map.get(key) : null), setItem: (key, value) => { map.set(String(key), String(value)); } };
}

describe('openInWorkbench —— pendingOpenThreadId 只在拍旧帧那一拍里非空', () => {
  it('markSharedThread 被问的那一刻能读到将要打开的线程 id，applyShellMode 返回后即清', async () => {
    const { createShellModeController } = await loadModule(SHELL_MODE_PATH);
    const documentRef = fakeDoc();
    documentRef.documentElement.setAttribute('data-shell-mode', 'steward');
    const seen = [];
    const controller = createShellModeController({
      canEnterSteward: () => true,
      documentRef,
      storage: fakeStorage(),
      // 组合根那一侧的挂名钩子：它被调的瞬间去读 pendingOpenThreadId —— 正是 app.js 的
      // sharedThreadId 判据在拍旧帧那一拍做的事。
      markSharedThread: () => { seen.push(controller.pendingOpenThreadId()); return () => {}; },
      openSession: async () => {},
    });
    assert.equal(controller.pendingOpenThreadId(), '', '没走「在工作台打开」时恒为空串');
    await controller.openInWorkbench('sess_A');
    assert.deepEqual(seen, ['sess_A'], '拍旧帧那一拍里必须能问到「将要打开的那一条」');
    assert.equal(controller.pendingOpenThreadId(), '', 'applyShellMode 返回后即清，不留死值');
    documentRef.flushInOrder();
    assert.equal(documentRef.documentElement.getAttribute('data-shell-mode'), 'classic');
  });

  it('普通切视角（分段钮那一路）不产生 pendingOpenThreadId', async () => {
    const { createShellModeController } = await loadModule(SHELL_MODE_PATH);
    const documentRef = fakeDoc();
    documentRef.documentElement.setAttribute('data-shell-mode', 'steward');
    const seen = [];
    const controller = createShellModeController({
      canEnterSteward: () => true,
      documentRef,
      storage: fakeStorage(),
      markSharedThread: () => { seen.push(controller.pendingOpenThreadId()); return () => {}; },
    });
    controller.applyShellMode('classic');
    assert.deepEqual(seen, [''], '分段钮那一路的判据仍只有「焦点＝当前会话」那一半');
    documentRef.flushInOrder();
  });

  it('openSession 抛错也不留死值（视角已切，判据已清）', async () => {
    const { createShellModeController } = await loadModule(SHELL_MODE_PATH);
    const documentRef = fakeDoc();
    documentRef.documentElement.setAttribute('data-shell-mode', 'steward');
    const controller = createShellModeController({
      canEnterSteward: () => true,
      documentRef,
      storage: fakeStorage(),
      openSession: async () => { throw new Error('boom'); },
    });
    const opened = await controller.openInWorkbench('sess_B');
    assert.equal(opened, 'sess_B');
    assert.equal(controller.pendingOpenThreadId(), '');
    documentRef.flushInOrder();
    assert.equal(documentRef.documentElement.getAttribute('data-shell-mode'), 'classic');
  });
});

describe('markSharedThread —— 文字逐字判据（不同源不挂名）', () => {
  function fakeFrameDoc(titles) {
    const nodes = {};
    for (const [id, text] of Object.entries(titles)) {
      nodes[id] = { id, textContent: text, style: {}, focus() {} };
    }
    return {
      nodes,
      documentElement: { getAttribute: () => 'steward', setAttribute() {}, dataset: {} },
      getElementById: id => nodes[id] || null,
    };
  }
  async function makeFrame(titles, shared) {
    const { createAppFrame } = await loadModule(APP_FRAME_PATH);
    const documentRef = fakeFrameDoc(titles);
    const frame = createAppFrame({ documentRef, sharedThreadId: () => shared });
    return { frame, documentRef };
  }

  it('两侧标题逐字相同 → 两个节点都挂上 thread-title，清理函数摘干净', async () => {
    const { frame, documentRef } = await makeFrame(
      { stewardDrawerTitle: '整理三季度报表', sessionTitle: '整理三季度报表' }, 'sess_A');
    const cleanup = frame.markSharedThread();
    assert.equal(documentRef.nodes.stewardDrawerTitle.style.viewTransitionName, 'thread-title');
    assert.equal(documentRef.nodes.sessionTitle.style.viewTransitionName, 'thread-title');
    cleanup();
    assert.equal(documentRef.nodes.stewardDrawerTitle.style.viewTransitionName, '');
    assert.equal(documentRef.nodes.sessionTitle.style.viewTransitionName, '');
  });

  it('两侧标题不同源（displayTitle ≠ title 原话）→ 不挂名，退回整体淡入淡出', async () => {
    const { frame, documentRef } = await makeFrame(
      { stewardDrawerTitle: '报表：三季度数据汇总好了', sessionTitle: '帮我整理三季度报表' }, 'sess_A');
    frame.markSharedThread();
    assert.equal(documentRef.nodes.stewardDrawerTitle.style.viewTransitionName, undefined);
    assert.equal(documentRef.nodes.sessionTitle.style.viewTransitionName, undefined);
  });

  it('同一条线程但两侧空白差异 → 视为同一串字（trim 后相等仍挂名）', async () => {
    const { frame, documentRef } = await makeFrame(
      { stewardDrawerTitle: ' 整理三季度报表 ', sessionTitle: '整理三季度报表' }, 'sess_A');
    frame.markSharedThread();
    assert.equal(documentRef.nodes.stewardDrawerTitle.style.viewTransitionName, 'thread-title');
  });

  it('判据为空（两个视角指的不是同一条线程）→ 不挂名', async () => {
    const { frame, documentRef } = await makeFrame(
      { stewardDrawerTitle: '甲', sessionTitle: '甲' }, '');
    frame.markSharedThread();
    assert.equal(documentRef.nodes.stewardDrawerTitle.style.viewTransitionName, undefined);
    assert.equal(documentRef.nodes.sessionTitle.style.viewTransitionName, undefined);
  });

  it('只有一侧节点在 DOM 里 → 不挂名', async () => {
    const { frame, documentRef } = await makeFrame({ stewardDrawerTitle: '甲' }, 'sess_A');
    frame.markSharedThread();
    assert.equal(documentRef.nodes.stewardDrawerTitle.style.viewTransitionName, undefined);
  });
});
