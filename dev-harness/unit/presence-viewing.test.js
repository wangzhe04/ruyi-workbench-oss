'use strict';
// 2026-10(用户:「如果用户在看提问、权限,管家被立刻唤醒也不要插手」):public/js/presence-viewing.js 判
// 「此刻摆在用户面前、而且人在跟前」的线程,经事件流在场信号 viewing 报给服务端(13r → 13i 在场门 / 13k 工具门)。
//
// 判据:
//   [N] normalizeViewing:去空、去重、排序、封顶 VIEWING_MAX。
//   [A] userAttending:页面可见 且 窗口有焦点 且 近 VIEWING_IDLE_MS 内有操作,三条缺一不报。
//   [T] tracker:人在时报候选、人走(超时无操作 / 失焦 / 页面隐藏)就报空;结果没变不重复通知。
//   [P] prompt-queue 的 viewingSessionIds:开着的弹窗那一条;小窗展开时列表里的全部;收起且没弹窗时为空。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const PUBLIC = path.resolve(__dirname, '../../ruyi-workbench/app/public');
const load = name => import(pathToFileURL(path.join(PUBLIC, 'js', name)).href);

test('[N] normalizeViewing 去空去重排序封顶', async () => {
  const { normalizeViewing, VIEWING_MAX } = await load('presence-viewing.js');
  assert.deepEqual(normalizeViewing(['b', '', 'a', 'b', null, ' c ']), ['a', 'b', 'c']);
  assert.deepEqual(normalizeViewing('x'), []);
  assert.equal(normalizeViewing(Array.from({ length: 20 }, (_, i) => 's' + String(i).padStart(2, '0'))).length, VIEWING_MAX);
});

test('[A] userAttending 三条缺一不报', async () => {
  const { userAttending, VIEWING_IDLE_MS } = await load('presence-viewing.js');
  const base = { visible: true, focused: true, lastInputAt: 1000, nowMs: 1000 + VIEWING_IDLE_MS };
  assert.equal(userAttending(base), true);
  assert.equal(userAttending({ ...base, nowMs: base.nowMs + 1 }), false, '超过一分钟没操作 = 人走开了');
  assert.equal(userAttending({ ...base, visible: false }), false);
  assert.equal(userAttending({ ...base, focused: false }), false);
});

function fakeDoc() {
  const listeners = new Map();
  return {
    visibilityState: 'visible', hidden: false, focused: true,
    hasFocus() { return this.focused; },
    addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
    fire(name) { for (const fn of listeners.get(name) || []) fn({}); },
  };
}

test('[T] tracker:人在报候选、人走报空,没变不重复通知', async () => {
  const { createViewingTracker, VIEWING_IDLE_MS } = await load('presence-viewing.js');
  let clock = 10000;
  let cands = [];
  let changes = 0;
  const doc = fakeDoc();
  const tracker = createViewingTracker({ candidates: () => cands, onChange: () => { changes += 1; }, now: () => clock, doc: () => doc, win: () => null });
  tracker.start();
  assert.deepEqual(tracker.current(), []);
  assert.equal(tracker.check(), false, '空 → 空:不通知');
  cands = ['sess_b', 'sess_a'];
  assert.equal(tracker.check(), true);
  assert.deepEqual(tracker.current(), ['sess_a', 'sess_b']);
  assert.equal(tracker.check(), false, '没变:不重复通知');
  doc.focused = false;
  assert.deepEqual(tracker.current(), [], '失焦 = 不在看');
  assert.equal(tracker.check(), true);
  doc.focused = true;
  clock += VIEWING_IDLE_MS + 1;
  assert.deepEqual(tracker.current(), [], '一分钟没操作 = 人走开了,交还管家');
  doc.fire('pointerdown');   // 人回来了:点一下就又算在看
  assert.deepEqual(tracker.current(), ['sess_a', 'sess_b']);
  assert.equal(changes, 3);
});

test('[P] prompt-queue.viewingSessionIds:弹窗那一条 / 展开的小窗全部', async () => {
  const { createPromptQueue } = await load('prompt-queue.js');
  let views = 0;
  const doc = { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null, activeElement: null, body: { classList: { add() {}, remove() {} } } };
  const q = createPromptQueue({
    api: async () => ({ interventions: [] }), t: k => k, el: () => ({}),
    openItem: () => ({ close() {} }),
    shellMode: () => 'none', doc: () => doc, onViewChange: () => { views += 1; },
  });
  q.offer({ id: 'p1', type: 'permission', sessionId: 'sess_a', payload: {} });
  assert.deepEqual(q.viewingSessionIds(), ['sess_a'], '自动弹出的那一条正摆在面前');
  q.offer({ id: 'p2', type: 'permission', sessionId: 'sess_b', payload: {} });
  assert.deepEqual(q.queuedSessionIds().sort(), ['sess_a', 'sess_b']);
  assert.deepEqual(q.viewingSessionIds(), ['sess_a'], '排在后面的那条没摆在面前');
  q.minimizeActive(true);
  assert.deepEqual(q.viewingSessionIds(), [], '收进小窗(没展开)= 不在看');
  assert.ok(views >= 2, `变化都通知了(实得 ${views} 次)`);
  q.settle('p1'); q.settle('p2');   // 队列清空 → 每秒那个计时器自己停(否则 node --test 收不了尾)
  await new Promise(resolve => setTimeout(resolve, 1100));
});
