#!/usr/bin/env node
'use strict';

// 135（用户 2026-09-23「多个提问/权限弹窗依次排序、最小化到右下角、显示等待时长」）：
// js/prompt-queue.js 的排队语义。纯函数部分直接断真值表；队列本体用假 openItem + 管家视角
// （shellMode 返回 'steward' 时小窗不渲染，零 DOM），只看「弹了谁、没弹谁、谁出了队」。
//
// 钉住的六件事（每一条都对应修前的一处真毛病或一条拍板）：
//   ① 同时来两条：只弹一个，第二条排队 —— 修前第二条提问会把第一条 __cancel 掉；
//   ② 同一个 id 再来一次（事件重放 / 对账）不重弹；已决过的 id 永远不复活；
//   ③ 答完 / 决定完一条（done）自动轮到下一条；
//   ④ 「稍后处理」（minimize）之后不再自动弹，直到队列清空；
//   ⑤ 排序：先来先答，剩余 <30 s 的按截止时刻置顶，已过期的不插队；
//   ⑥ 「都允许」只给只读/编辑档、同一工具 ≥2 条；执行档永远逐条按。

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'prompt-queue.js');
let modulePromise;
const load = () => (modulePromise ||= import(pathToFileURL(MODULE_PATH).href));

function fakeDoc() {
  return {
    hidden: false,
    addEventListener() {},
    querySelectorAll() { return []; },
    body: { classList: { add() {}, remove() {} }, style: { getPropertyValue() { return ''; }, setProperty() {}, removeProperty() {} } },
  };
}

// 每条用例结束把队列清空:队列有条目时 1 s 的计时器常驻,不清空 node --test 就退不出去。
const liveQueues = [];
afterEach(() => { for (const q of liveQueues.splice(0)) for (const item of q.list()) q.settle(item.id); });

function makeQueue(mod, clock) {
  const opened = [];
  const handles = new Map();
  const queue = mod.createPromptQueue({
    api: null,                       // 不对账
    t: key => key,
    el: () => { throw new Error('管家视角下不该渲染小窗'); },
    shellMode: () => 'steward',
    now: () => clock.now,
    doc: fakeDoc,
    openItem: (item, ctx) => {
      opened.push(item.id);
      const handle = { closed: false, ctx, close() { this.closed = true; } };
      handles.set(item.id, handle);
      return handle;
    },
    allowToolForThread: async () => {},
  });
  liveQueues.push(queue);
  return { queue, opened, handles };
}

const perm = (id, sessionId, extra = {}) => ({ id, type: 'permission', sessionId, payload: { requestId: id, toolName: 'file_write', tier: 'edit' }, ...extra });

describe('prompt-queue 纯函数', () => {
  it('formatDuration: m:ss 与 h:mm:ss', async () => {
    const { formatDuration } = await load();
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(65_000), '1:05');
    assert.equal(formatDuration(3_725_000), '1:02:05');
    assert.equal(formatDuration(-5), '0:00');
  });

  it('⑤ orderQueue: 先来先答;剩 <30 s 的按截止时刻置顶;已过期不插队', async () => {
    const { orderQueue } = await load();
    const now = 1_000_000;
    const items = [
      { id: 'old', requestedAt: 1, deadlineAt: now + 100_000 },
      { id: 'urgentLate', requestedAt: 5, deadlineAt: now + 20_000 },
      { id: 'urgentSoon', requestedAt: 9, deadlineAt: now + 5_000 },
      { id: 'expired', requestedAt: 2, deadlineAt: now - 1 },
      { id: 'noDeadline', requestedAt: 3, deadlineAt: 0 },
    ];
    assert.deepEqual(orderQueue(items, now).map(i => i.id), ['urgentSoon', 'urgentLate', 'old', 'expired', 'noDeadline']);
  });

  it('groupQueue: 组的次序跟着组内最靠前那一条', async () => {
    const { groupQueue } = await load();
    const groups = groupQueue([{ id: 1, sessionId: 'b' }, { id: 2, sessionId: 'a' }, { id: 3, sessionId: 'b' }]);
    assert.deepEqual(groups.map(g => [g.sessionId, g.rows.map(r => r.id)]), [['b', [1, 3]], ['a', [2]]]);
  });

  it('⑥ bulkAllowCandidates: 只读/编辑档、同一工具 ≥2 条;执行档与提问不算', async () => {
    const { bulkAllowCandidates } = await load();
    const rows = [
      perm('p1', 's'), perm('p2', 's'),
      { id: 'x1', type: 'permission', payload: { toolName: 'powershell_run', tier: 'exec' } },
      { id: 'x2', type: 'permission', payload: { toolName: 'powershell_run', tier: 'exec' } },
      { id: 'r1', type: 'permission', payload: { toolName: 'file_read', tier: 'read' } },
      { id: 'q1', type: 'question', payload: {} },
    ];
    const got = bulkAllowCandidates(rows);
    assert.deepEqual(got.map(c => [c.tool, c.items.map(i => i.id)]), [['file_write', ['p1', 'p2']]]);
  });
});

describe('prompt-queue 队列本体', () => {
  it('① 两条同时来:只弹第一条,第二条排队', async () => {
    const mod = await load();
    const clock = { now: 10_000 };
    const { queue, opened } = makeQueue(mod, clock);
    queue.offer(perm('a', 's1', { requestedAt: 1 }));
    queue.offer({ id: 'q', type: 'question', sessionId: 's2', requestedAt: 2, payload: { questions: [] } });
    assert.deepEqual(opened, ['a']);
    assert.equal(queue.size(), 2);
    assert.equal(queue.activeId(), 'a');
  });

  // 反向验证抓到的缺口:上一条里第二条恰好排在后面,「正开着就不换」那道闸删掉也照样绿。
  // 真正要钉的是:排在前面的新来者(对账补进来的更早申请、快超时的)也不许把你正在看的那个抢走。
  it('①b 正在看的弹窗不被「排在前面」的新来者抢走(更早的 / 快超时的都一样)', async () => {
    const mod = await load();
    const clock = { now: 100_000 };
    const { queue, opened, handles } = makeQueue(mod, clock);
    queue.offer(perm('current', 's1', { requestedAt: 90_000 }));
    queue.offer(perm('older', 's2', { requestedAt: 1 }));
    queue.offer(perm('urgent', 's3', { requestedAt: 95_000, deadlineAt: clock.now + 5_000 }));
    assert.deepEqual(opened, ['current']);
    assert.equal(handles.get('current').closed, false);
    handles.get('current').ctx.done();
    assert.deepEqual(opened, ['current', 'urgent'], '轮到下一条时快超时的先来');
  });

  it('② 同一 id 再来不重弹;已决过的不复活;管家会话不入队', async () => {
    const mod = await load();
    const clock = { now: 10_000 };
    const { queue, opened } = makeQueue(mod, clock);
    queue.offer(perm('a', 's1'));
    queue.offer(perm('a', 's1'));
    assert.deepEqual(opened, ['a']);
    queue.settle('a');
    assert.equal(queue.offer(perm('a', 's1')), false);
    assert.equal(queue.isSettled('a'), true);
    assert.equal(queue.offer(perm('z', 'steward')), false);
    assert.equal(queue.size(), 0);
  });

  it('③ 决定完一条自动轮到下一条,且关掉的是那一条自己的弹窗', async () => {
    const mod = await load();
    const clock = { now: 10_000 };
    const { queue, opened, handles } = makeQueue(mod, clock);
    queue.offer(perm('a', 's1', { requestedAt: 1 }));
    queue.offer(perm('b', 's2', { requestedAt: 2 }));
    handles.get('a').ctx.done();
    assert.equal(handles.get('a').closed, true);
    assert.deepEqual(opened, ['a', 'b']);
    assert.equal(queue.size(), 1);
  });

  it('④ 稍后处理:不替用户决定、不再自动弹;队列清空后恢复自动弹', async () => {
    const mod = await load();
    const clock = { now: 10_000 };
    const { queue, opened, handles } = makeQueue(mod, clock);
    queue.offer(perm('a', 's1', { requestedAt: 1 }));
    handles.get('a').ctx.minimize();
    queue.offer(perm('b', 's2', { requestedAt: 2 }));
    assert.deepEqual(opened, ['a'], '最小化之后新来的只进角标');
    assert.equal(queue.size(), 2, '最小化的那条仍在队里(没被拒绝)');
    queue.openById('b');
    assert.deepEqual(opened, ['a', 'b'], '从小窗点开指定的那一条');
    queue.settle('a'); queue.settle('b');
    queue.offer(perm('c', 's3'));
    assert.deepEqual(opened, ['a', 'b', 'c'], '清空之后恢复「空闲就弹」');
  });

  it('决定在别处做了(settle 一条正开着的):关掉它并轮到下一条', async () => {
    const mod = await load();
    const clock = { now: 10_000 };
    const { queue, opened, handles } = makeQueue(mod, clock);
    queue.offer(perm('a', 's1', { requestedAt: 1 }));
    queue.offer(perm('b', 's1', { requestedAt: 2 }));
    queue.settle('a');
    assert.equal(handles.get('a').closed, true);
    assert.deepEqual(opened, ['a', 'b']);
  });
});
