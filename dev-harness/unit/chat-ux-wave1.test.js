#!/usr/bin/env node
'use strict';

// 前端走查第一波·聊天区(W1-chat)里能在 node 里直测的几处纯逻辑(浏览器侧的整套回归见 chat-ux-wave1.browser.e2e.js):
//   ① turn-activity.settle({ dropPlan }):停止 / 失败收尾清掉计划待决,正常收尾仍保留(「等你拍板」是有效状态);
//   ② prompt-queue「都允许」只对成功(已了结)的几条出队,失败的留在队里、按钮恢复;onSettled 钩子在条目了结时触发;
//   ③ 新增文案键在 zh-CN / en-US / docs/i18n 镜像四处都在,且两份镜像逐字节相同。

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const importFile = rel => import(pathToFileURL(path.join(PUBLIC, rel)).href);

describe('turn-activity settle({ dropPlan })', () => {
  async function pendingPlanActivity() {
    const { createTurnActivity } = await importFile('js/turn-activity.js');
    let at = 1_000_000;
    const activity = createTurnActivity({ now: () => at });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'plan', planId: 'plan_1', markdown: 'PLAN: x' });
    assert.equal(activity.snapshot().phase, 'waiting_you');
    return activity;
  }

  it('默认收尾仍保留计划待决(正常回合结束停在「等你拍板」)', async () => {
    const activity = await pendingPlanActivity();
    activity.settle();
    assert.equal(activity.snapshot().phase, 'waiting_you');
    assert.equal(activity.snapshot().waiting.kind, 'plan');
  });

  it('dropPlan:停止 / 失败收尾清掉计划待决,状态条回到空闲', async () => {
    const activity = await pendingPlanActivity();
    activity.settle({ dropPlan: true });
    assert.equal(activity.snapshot().phase, 'idle');
    assert.equal(activity.snapshot().waiting, null);
  });

  it('dropPlan 只清计划:权限 / 提问本来就随回合收掉,别的待决不受影响的口径不变', async () => {
    const { createTurnActivity } = await importFile('js/turn-activity.js');
    const activity = createTurnActivity({ now: () => 5 });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'permission_request', requestId: 'r1', toolName: 'file_write' });
    activity.consume({ type: 'plan', planId: 'p1' });
    activity.settle({ dropPlan: true });
    assert.equal(activity.snapshot().phase, 'idle', '权限申请随回合收尾清掉,计划被 dropPlan 清掉');
  });
});

describe('prompt-queue 批量允许只对成功的出队 + onSettled', () => {
  const live = [];
  afterEach(() => { for (const q of live.splice(0)) for (const item of q.list()) q.settle(item.id); });

  // 够 render / buildStructure 用的最小「元素」:记下建过的每一个,按 className 找按钮。
  function makeDom() {
    const made = [];
    class FakeEl {
      constructor(tag, cls, text) { this.tag = tag; this.className = cls || ''; this.children = []; this.dataset = {}; this.attrs = {}; this._text = text || ''; this.hidden = false; this.disabled = false; made.push(this); }
      get classList() { const self = this; return { add() {}, remove() {}, toggle() {}, contains: c => String(self.className).split(/\s+/).includes(c) }; }
      append(...n) { this.children.push(...n); }
      appendChild(n) { this.children.push(n); return n; }
      setAttribute(k, v) { this.attrs[k] = v; }
      set textContent(v) { this._text = String(v); if (v === '') this.children = []; }
      get textContent() { return this._text; }
      contains() { return false; }
      querySelectorAll() { return []; }
      focus() {}
      get offsetWidth() { return 0; }
    }
    const doc = () => ({
      hidden: false,
      activeElement: null,
      addEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      body: { appendChild() {}, classList: { add() {}, remove() {} }, style: { getPropertyValue() { return ''; }, setProperty() {}, removeProperty() {} } },
    });
    return { made, el: (tag, cls, text) => new FakeEl(tag, cls, text), doc };
  }

  async function setup(allowImpl) {
    const mod = await importFile('js/prompt-queue.js');
    const dom = makeDom();
    const settledIds = [];
    const queue = mod.createPromptQueue({
      api: null, t: key => key, el: dom.el, doc: dom.doc, shellMode: () => 'classic', now: () => 1000,
      openItem: () => ({ close() {} }),
      allowToolForThread: allowImpl,
      onSettled: id => settledIds.push(id),
    });
    live.push(queue);
    const perm = id => ({ id, type: 'permission', sessionId: 's1', payload: { requestId: id, toolName: 'file_read', tier: 'read' } });
    for (const id of ['a', 'b', 'c']) queue.offer(perm(id));
    queue.minimizeActive(true);                       // 弹出来的那条收进小窗,小窗里才有「都允许」
    const pill = dom.made.find(n => String(n.className).includes('prompt-dock-pill'));
    pill.onclick();                                   // 展开小窗 → buildStructure 画出「都允许」
    const bulk = dom.made.find(n => String(n.className).includes('pd-bulk'));
    assert.ok(bulk, '同一线程同一只读工具 3 条 → 有「都允许」');
    return { queue, bulk, settledIds };
  }

  it('回调只返回成功的 id:失败的那条留在队里,按钮恢复', async () => {
    const { queue, bulk, settledIds } = await setup(async () => ['a', 'b']);
    await bulk.onclick();
    assert.deepEqual(queue.list().map(i => i.id), ['c'], '只有成功的两条出队');
    assert.equal(bulk.disabled, false, '还有没成功的:按钮恢复,可以再点');
    assert.deepEqual(settledIds.sort(), ['a', 'b'], 'onSettled 只为出队的两条触发');
  });

  it('回调抛错:一条都不出队,按钮恢复', async () => {
    const { queue, bulk } = await setup(async () => { throw new Error('boom'); });
    await bulk.onclick();
    assert.equal(queue.size(), 3);
    assert.equal(bulk.disabled, false);
  });

  it('回调没返回清单(老形状):按全部成功算,与修前一致', async () => {
    const { queue, bulk } = await setup(async () => {});
    await bulk.onclick();
    assert.equal(queue.size(), 0);
  });
});

describe('新增文案键与镜像', () => {
  const KEYS = [
    'changes.op.unknown', 'changes.tool.edit_file', 'changes.tool.write_docx', 'changes.tool.window_screenshot', 'changes.tool.get_clipboard_image',
    'chat.attachmentUploading', 'chat.editResendKeepDraft', 'chat.retryWaitTurn', 'plan.result.expired',
    'toast.answerNotDelivered', 'toast.uploadInProgress',
  ];
  const read = rel => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

  it('zh-CN / en-US 以及 docs/i18n 镜像四份都有这些键、且非空', () => {
    for (const rel of ['ruyi-workbench/app/public/locales/zh-CN.json', 'ruyi-workbench/app/public/locales/en-US.json', 'docs/i18n/locales/zh-CN.json', 'docs/i18n/locales/en-US.json']) {
      const catalog = read(rel);
      for (const key of KEYS) assert.ok(typeof catalog[key] === 'string' && catalog[key].trim(), `${rel} 缺 ${key}`);
    }
  });

  it('docs/i18n 镜像与应用内目录逐字节相同', () => {
    for (const name of ['zh-CN.json', 'en-US.json']) {
      const a = fs.readFileSync(path.join(PUBLIC, 'locales', name));
      const b = fs.readFileSync(path.join(ROOT, 'docs', 'i18n', 'locales', name));
      assert.ok(a.equals(b), `${name} 镜像不一致`);
    }
  });

  it('两种语言的占位符集合一致(这些键都不带占位符)', () => {
    for (const key of KEYS) {
      const zh = read('ruyi-workbench/app/public/locales/zh-CN.json')[key];
      const en = read('ruyi-workbench/app/public/locales/en-US.json')[key];
      assert.deepEqual(zh.match(/\{\{\s*\w+\s*\}\}/g) || [], en.match(/\{\{\s*\w+\s*\}\}/g) || [], key);
    }
  });
});
