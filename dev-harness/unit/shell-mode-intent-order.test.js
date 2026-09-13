#!/usr/bin/env node
'use strict';

// 第 122 波 L1a（36 号文 §2.1；J05 的真根）：视角切换的**意图序号**真值表。
//
// 钉的是一句话：**最后一次意图赢**。修前 `applyShellMode` 真换视角时把写属性那一下交给
// `document.startViewTransition(write)`——它是【异步】调用的；而同值再写（属性已经是这个值）
// 走同步 `write()`。开机那两秒里两条路会交叉：
//   ① boot 末尾 steward-shell.js 的 `syncStewardShellAvailability()` 调 applyShellMode('steward')
//      → write_steward 排进过渡队列，还没落；
//   ② 用户此刻点分段钮选 classic → 属性【还是】classic（①没落）→ 走同步支，立刻写 classic；
//   ③ 排队的 write_steward 这才落 → 属性翻成 steward，把用户刚点好的工作台视角吃掉。
// 于是判据就是本文件的第一条：**倒序**执行收集到的写回调，属性必须仍是最后一次意图的那个值。
//
// 与 unit/steward-focus-thread.test.js 同款约定：`pathToFileURL` + `import()` 直接从磁盘加载
// ESM，零磁盘写、零真 DOM。shell-mode.js 是叶子（零 import），`documentRef` / `storage` /
// `canEnterSteward` 全是工厂参数——所以这里能拿一份手搓的假 document 把整条时序摊在桌上看。
//
// 反向验证（32 号文 §4 纪律 5）：注掉 shell-mode.js 里 `if (seq !== intentSeq) return;` 这一行
// → 本文件第一、二、四条必红（实测原文贴在交付报告里）；还原后全绿。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'shell-mode.js');
let modulePromise;
function loadModule() {
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE_PATH).href);
  return modulePromise;
}

// 手搓的最小 document：只认 documentElement 的属性表、getElementById 与
// startViewTransition。startViewTransition 【只收集不执行】——把「什么时候落」这件事交给测试，
// 这正是要量的东西。
function fakeDoc({ viewTransitions = true } = {}) {
  const attrs = new Map();
  const pending = [];
  const focused = [];
  const root = {
    getAttribute: name => (attrs.has(name) ? attrs.get(name) : null),
    setAttribute: (name, value) => { attrs.set(String(name), String(value)); },
    dataset: {},
  };
  const doc = {
    documentElement: root,
    getElementById: id => ({ id, focus() { focused.push(id); } }),
    pending,
    focused,
    modeNow: () => root.getAttribute('data-shell-mode'),
    // 倒序落地：把「排队的旧意图比新意图晚落」这件事复现出来。
    flushReversed: () => { const queue = pending.splice(0, pending.length); for (let i = queue.length - 1; i >= 0; i--) queue[i](); },
    flushInOrder: () => { const queue = pending.splice(0, pending.length); for (const write of queue) write(); },
  };
  if (viewTransitions) {
    doc.startViewTransition = write => { pending.push(write); return { finished: Promise.resolve() }; };
  }
  return doc;
}

function fakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(String(key), String(value)); },
  };
}

async function makeController(overrides = {}) {
  const { createShellModeController } = await loadModule();
  const documentRef = overrides.documentRef || fakeDoc();
  const storage = overrides.storage || fakeStorage();
  const controller = createShellModeController({
    canEnterSteward: () => true,
    documentRef,
    storage,
    ...overrides,
  });
  return { controller, documentRef, storage };
}

describe('applyShellMode —— 意图序号（最后一次意图赢）', () => {
  it('J05 真根的纯净复现：排队的 steward 后落，也翻不掉后点的 classic', async () => {
    const { controller, documentRef } = await makeController();
    // 起点＝预绘那一拍写下的属性。
    documentRef.documentElement.setAttribute('data-shell-mode', 'classic');
    controller.applyShellMode('steward', { persist: false });   // ① boot 的补判：真换视角 → 排队
    assert.equal(documentRef.pending.length, 1, '① 是真换视角，写回调排进了过渡队列');
    assert.equal(documentRef.modeNow(), 'classic', '① 的写还没落 —— 这正是竞态窗口');
    controller.applyShellMode('classic');                        // ② 用户点分段钮：同值 → 同步写
    assert.equal(documentRef.pending.length, 1, '② 走的是同步支（属性此刻还是 classic）');
    assert.equal(documentRef.modeNow(), 'classic');
    documentRef.flushInOrder();                                  // ③ 排队的 ① 这才落地
    assert.equal(documentRef.modeNow(), 'classic', '修前这里会翻成 steward');
  });

  it('两个排队的写回调【倒序】执行，属性仍是最后一次意图', async () => {
    const { controller, documentRef } = await makeController();
    documentRef.documentElement.setAttribute('data-shell-mode', 'classic');
    controller.applyShellMode('steward', { persist: false });   // 排队 #0（steward）
    controller.applyShellMode('classic');                        // 同步（属性仍 classic）
    controller.applyShellMode('steward');                        // 排队 #1（steward）
    controller.applyShellMode('classic');                        // 同步 —— 最后一次意图
    assert.equal(documentRef.pending.length, 2);
    documentRef.flushReversed();
    assert.equal(documentRef.modeNow(), 'classic');
  });

  it('本机偏好也只记最后一次显式意图（persist:false 那一拍不许写偏好）', async () => {
    const { controller, documentRef, storage } = await makeController();
    const { SHELL_MODE_STORAGE_KEY } = await loadModule();
    documentRef.documentElement.setAttribute('data-shell-mode', 'classic');
    controller.applyShellMode('steward', { persist: false });
    controller.applyShellMode('classic');
    documentRef.flushInOrder();
    assert.equal(storage.getItem(SHELL_MODE_STORAGE_KEY), 'classic');
  });

  it('作废的意图是【彻底】空操作：不落焦、不对控件', async () => {
    const cfg = { id: 'cfgShellMode', value: '', focus() { /* 控件不参与落焦断言 */ } };
    const documentRef = fakeDoc();
    const focused = documentRef.focused;
    documentRef.getElementById = id => {
      if (id === 'cfgShellMode') return cfg;
      return { id, focus() { focused.push(id); } };
    };
    const { controller } = await makeController({ documentRef });
    documentRef.documentElement.setAttribute('data-shell-mode', 'classic');
    controller.applyShellMode('steward', { persist: false });   // 锚点 stewardShell（排队）
    controller.applyShellMode('classic');                        // 锚点 sessionTitle（同步）
    documentRef.flushInOrder();
    assert.deepEqual(focused, ['sessionTitle'], '只有最后一次意图的锚点该被落焦');
    assert.equal(cfg.value, 'classic', '设置里的下拉也只对到最后一次意图');
  });

  it('同步支（不支持 View Transitions）本来就没有乱序，行为不变', async () => {
    const documentRef = fakeDoc({ viewTransitions: false });
    const { controller } = await makeController({ documentRef });
    documentRef.documentElement.setAttribute('data-shell-mode', 'classic');
    controller.applyShellMode('steward', { persist: false });
    assert.equal(documentRef.modeNow(), 'steward');
    controller.applyShellMode('classic');
    assert.equal(documentRef.modeNow(), 'classic');
    assert.equal(documentRef.pending.length, 0);
  });

  it('四次连点只认最后那次（steward → classic → steward → classic ＝ J05 那件点的序列）', async () => {
    const { controller, documentRef, storage } = await makeController();
    const { SHELL_MODE_STORAGE_KEY } = await loadModule();
    documentRef.documentElement.setAttribute('data-shell-mode', 'classic');
    for (const mode of ['steward', 'classic', 'steward', 'classic']) controller.applyShellMode(mode);
    documentRef.flushReversed();
    assert.equal(documentRef.modeNow(), 'classic');
    assert.equal(storage.getItem(SHELL_MODE_STORAGE_KEY), 'classic');
    documentRef.flushInOrder();   // 队列已空；再落一次也不该有第二种结果
    assert.equal(documentRef.modeNow(), 'classic');
  });

  it('准入不过的那一支不领号：它没有写回调，不该把在飞的意图作废', async () => {
    const documentRef = fakeDoc();
    const { controller } = await makeController({
      documentRef,
      // 管家进不去 → applyShellMode('steward') 直接把控制权交给 recoverStewardShell。
      canEnterSteward: () => false,
      recoverStewardShell: () => 'classic',
    });
    documentRef.documentElement.setAttribute('data-shell-mode', 'steward');
    controller.applyShellMode('classic');                        // 排队中的真意图
    assert.equal(controller.applyShellMode('steward'), 'classic', '准入不过 → 交给 recover');
    assert.equal(documentRef.pending.length, 1);
    documentRef.flushReversed();
    assert.equal(documentRef.modeNow(), 'classic');
  });
});
