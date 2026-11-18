'use strict';
// 151 阶段 1 · U4：每轮记忆检查摘要从隐藏的 #toolOutput 挪到助手消息尾部的可见尾标。
// 这里钉纯模块（模型、文案、只放一次的挂法）；可见性（offsetParent 非空）由 frontend-wave2.browser.e2e 的 M 段在真浏览器里断言。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const load = () => import('data:text/javascript;base64,' + fs.readFileSync(path.join(root, 'ruyi-workbench/app/public/js/memory-check-badge.js')).toString('base64'));
const catalog = lang => JSON.parse(fs.readFileSync(path.join(root, 'ruyi-workbench/app/public/locales', lang + '.json'), 'utf8'));
const tFor = lang => { const c = catalog(lang); return (key, params = {}) => { assert.ok(Object.hasOwn(c, key), 'missing ' + lang + ' ' + key); return c[key].replace(/{{\s*(\w+)\s*}}/g, (m, k) => (params[k] == null ? m : String(params[k]))); }; };

class Node {
  constructor(tag) { this.tagName = tag; this.children = []; this.dataset = {}; this.className = ''; this._text = ''; this.title = ''; }
  append(...items) { for (const item of items) this.appendChild(item); }
  appendChild(item) { this.children.push(item); item.parentNode = this; return item; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
}
const doc = { createElement: tag => new Node(tag) };

test('model reads only the memoryCheck counters and classifies fallback reasons', async () => {
  const { memoryCheckBadgeModel } = await load();
  assert.equal(memoryCheckBadgeModel(null), null);
  assert.deepEqual(memoryCheckBadgeModel({ enabled: false }), { state: 'disabled' });
  assert.deepEqual(memoryCheckBadgeModel({ enabled: true, checked: false }), { state: 'unavailable' });
  const done = memoryCheckBadgeModel({ enabled: true, checked: true, candidateCount: 7, matchCount: 2, projectMatches: 1, globalMatches: 1, coreActiveCount: 3, ruleFillCount: 1 });
  assert.deepEqual(done, { state: 'done', matches: 2, core: 3, fill: 1, candidates: 7, project: 1, global: 1, fallback: '' });
  for (const reason of ['overloaded', 'timeout', 'partial', 'truncated']) assert.equal(memoryCheckBadgeModel({ enabled: true, checked: true, semantic: { fallback: { reason } } }).fallback, 'keyword', reason);
  assert.equal(memoryCheckBadgeModel({ enabled: true, checked: true, semantic: { fallback: { reason: 'loading' } } }).fallback, 'preparing');
  // 150 号文 S1/S11：运行时不可用与 stale 重算有自己的回执，不再并进「关键词回退」。
  assert.equal(memoryCheckBadgeModel({ enabled: true, checked: true, semantic: { fallback: { reason: 'unavailable' } } }).fallback, 'unavailable');
  assert.equal(memoryCheckBadgeModel({ enabled: true, checked: true, semantic: { fallback: { reason: 'stale' } } }).fallback, 'stale');
  assert.equal(memoryCheckBadgeModel({ enabled: true, checked: true, semantic: { fallback: { reason: 'toString' } } }).fallback, '', 'inherited names are not reasons');
  assert.equal(memoryCheckBadgeModel({ enabled: true, checked: true, matchCount: -4, coreActiveCount: 'x' }).matches, 0);
});

test('badge summary says matches/core/fill and the fallback in both languages; details carry the full receipt', async () => {
  const { renderMemoryCheckBadge } = await load();
  const check = { enabled: true, checked: true, candidateCount: 5, matchCount: 0, projectMatches: 0, globalMatches: 0, coreActiveCount: 2, ruleFillCount: 1, semantic: { fallback: { reason: 'timeout' } } };
  const zh = renderMemoryCheckBadge(check, { t: tFor('zh-CN'), doc });
  assert.equal(zh.tagName, 'details'); assert.equal(zh.className, 'memory-check-badge'); assert.equal(zh.dataset.fallback, 'keyword');
  assert.equal(zh.children[0].tagName, 'summary');
  assert.equal(zh.children[0].textContent, '记忆：匹配 0 · 核心 2 · 补位 1 · 关键词回退');
  assert.match(zh.children[1].textContent, /已检索 5 条候选/); assert.match(zh.children[1].textContent, /关键词召回/);
  const en = renderMemoryCheckBadge(check, { t: tFor('en-US'), doc });
  assert.equal(en.children[0].textContent, 'Memory: 0 matched · 2 core · 1 filled · keyword fallback');
  assert.ok(!/[㐀-鿿]/.test(en.textContent), 'English badge has no Chinese');
  for (const [reason, zhTag, enTag, zhDetail] of [['unavailable', '语义不可用', 'semantic unavailable', /语义服务暂不可用/], ['stale', '基础结果', 'basic result', /记忆库有变化/]]) {
    const row = { ...check, semantic: { fallback: { reason } } };
    const zhRow = renderMemoryCheckBadge(row, { t: tFor('zh-CN'), doc });
    assert.equal(zhRow.dataset.fallback, reason);
    assert.equal(zhRow.children[0].textContent, '记忆：匹配 0 · 核心 2 · 补位 1 · ' + zhTag);
    assert.match(zhRow.children[1].textContent, zhDetail); assert.doesNotMatch(zhRow.children[1].textContent, /重排未完成/);
    assert.equal(renderMemoryCheckBadge(row, { t: tFor('en-US'), doc }).children[0].textContent, 'Memory: 0 matched · 2 core · 1 filled · ' + enTag);
  }
  assert.match(renderMemoryCheckBadge({ enabled: false }, { t: tFor('zh-CN'), doc }).children[0].textContent, /已关闭/);
});

test('attacher joins the usage line once, or adds its own tail line when the turn ends without usage', async () => {
  const { createMemoryBadgeAttacher } = await load();
  const attach = createMemoryBadgeAttacher({ t: tFor('zh-CN'), doc });
  const main = new Node('div');
  const live = { main, memoryCheck: { enabled: true, checked: true, matchCount: 1 } };
  const usage = new Node('div');
  assert.ok(attach(live, usage)); assert.equal(usage.children.length, 1);
  assert.equal(attach(live, null), null, 'finalize does not add a second badge'); assert.equal(main.children.length, 0);
  const bare = { main: new Node('div'), memoryCheck: { enabled: true, checked: true } };
  assert.ok(attach(bare, null)); assert.equal(bare.main.children.length, 1); assert.equal(bare.main.children[0].className, 'usage-line memory-check-line');
  assert.equal(attach({ main: new Node('div') }, null), null, 'no memoryCheck, no badge');
});

