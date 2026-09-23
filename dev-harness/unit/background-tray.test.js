#!/usr/bin/env node
'use strict';

// 135c（用户 2026-09-23「会话内的后台任务进度」）：js/background-tray.js 的三个纯函数。
// 拍板（与「等你处理」刻意不同）：只在对应线程显示、跑完即消失、别的线程只在左栏打「⟳N」。
// 这里钉的是那几条规则里能脱离 DOM 断言的部分：
//   ① 已跑时长的格式（m:ss / h:mm:ss，负数与垃圾值归零）；
//   ② 一行进度文字：命令只给最近一行输出；子代理/班组多于 1 步才给「N/M 步」；暂停/正在停要说出来；
//   ③ 左栏标记：只画【别的】线程、只画件数 >0 的 —— 自己这条已经有输入框上沿那一枚了。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'background-tray.js');
let modulePromise;
const load = () => (modulePromise ||= import(pathToFileURL(MODULE_PATH).href));
const t = (key, p = {}) => key + (Object.keys(p).length ? JSON.stringify(p) : '');

describe('background-tray 纯函数', () => {
  it('① formatElapsed', async () => {
    const { formatElapsed } = await load();
    assert.equal(formatElapsed(0), '0:00');
    assert.equal(formatElapsed(59_999), '0:59');
    assert.equal(formatElapsed(3_600_000 + 61_000), '1:01:01');
    assert.equal(formatElapsed(-10), '0:00');
    assert.equal(formatElapsed('x'), '0:00');
  });

  it('② rowProgressText: 命令只给最近一行输出', async () => {
    const { rowProgressText } = await load();
    assert.equal(rowProgressText({ kind: 'shell', tail: 'test 33/60 passed', progress: { done: 0, total: 0 } }, t), 'test 33/60 passed');
    assert.equal(rowProgressText({ kind: 'shell', tail: '' }, t), '');
  });

  it('② rowProgressText: 子代理/班组多于 1 步才给步数;暂停与正在停要说出来', async () => {
    const { rowProgressText } = await load();
    assert.equal(rowProgressText({ kind: 'run', progress: { done: 2, total: 5 }, tail: '在读 README' }, t),
      'bgTray.row.steps{"done":2,"total":5} · 在读 README');
    assert.equal(rowProgressText({ kind: 'agent', progress: { done: 0, total: 1 }, tail: '查竞品' }, t), '查竞品', '单节点子代理不报「0/1 步」');
    assert.equal(rowProgressText({ kind: 'run', status: 'paused', progress: { done: 1, total: 3 } }, t),
      'bgTray.row.steps{"done":1,"total":3} · bgTray.row.paused');
    assert.equal(rowProgressText({ kind: 'agent', status: 'stopping', progress: { total: 1 } }, t), 'bgTray.row.stopping');
  });

  it('③ railMarks: 只画别的线程、只画件数 >0 的', async () => {
    const { railMarks } = await load();
    const marks = railMarks({ sess_a: 2, sess_b: 0, sess_cur: 3, sess_c: '1' }, 'sess_cur');
    assert.deepEqual([...marks.entries()].sort(), [['sess_a', 2], ['sess_c', 1]]);
    assert.equal(railMarks(null, 'x').size, 0);
  });
});
