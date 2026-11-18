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

// ── 151 阶段 1E：尾标随消息落盘、重载后静态重绘、切语言就地重写 ─────────────────────────────
const { functionBlock } = require('../lib/source-slice');
const storeSource = fs.readFileSync(path.join(root, 'ruyi-workbench/app/src/02-session-store.js'), 'utf8');
const vm = require('node:vm');
const store = vm.runInNewContext(functionBlock(storeSource, 'compactMemoryCheckForMessage') + '\n' + functionBlock(storeSource, 'stampTurnMemoryCheck')
  + '\n({ compactMemoryCheckForMessage, stampTurnMemoryCheck });', {});
const plain = value => JSON.parse(JSON.stringify(value));
const pendingCheck = (session, check, turnSeq) => Object.defineProperty(session, '__turnMemoryCheck', { value: { check, turnSeq }, writable: true, configurable: true, enumerable: false });

test('the persisted memoryCheck is a whitelisted counter copy: no candidate text, no extra keys', () => {
  const full = { mode: 'default', enabled: true, checked: true, candidateCount: 9, matchCount: 2, projectMatches: 1, globalMatches: 1, excludedCount: 4, coreActiveCount: 3, ruleFillCount: 1,
    entries: [{ text: 'SECRET MEMORY BODY' }], semantic: { status: 'stale', mode: 'rerank-only', fallback: { reason: 'stale', method: 'keywords-recomputed', detail: 'C:\\private' } } };
  assert.deepEqual(plain(store.compactMemoryCheckForMessage(full)), { enabled: true, checked: true, candidateCount: 9, matchCount: 2, projectMatches: 1, globalMatches: 1, coreActiveCount: 3, ruleFillCount: 1, semantic: { fallback: { reason: 'stale' } } });
  assert.deepEqual(plain(store.compactMemoryCheckForMessage({ mode: 'disabled', enabled: false, checked: false, candidateCount: 0 })), { enabled: false, checked: false });
  assert.deepEqual(plain(store.compactMemoryCheckForMessage({ enabled: true, checked: true, matchCount: -1, candidateCount: 1.5, semantic: { fallback: { reason: 'Bad Reason!' } } })),
    { enabled: true, checked: true, candidateCount: 0, matchCount: 0, projectMatches: 0, globalMatches: 0, coreActiveCount: 0, ruleFillCount: 0 });
  for (const bad of [null, 'x', [], 5]) assert.equal(store.compactMemoryCheckForMessage(bad), null);
});

test('stamp goes onto this turn\'s assistant message only, once, and the pending mark never serializes', () => {
  const check = { enabled: true, checked: true, candidateCount: 3, matchCount: 1, projectMatches: 1, globalMatches: 0, coreActiveCount: 2, ruleFillCount: 0 };
  const session = { turnSeq: 4, messages: [{ role: 'user', content: 'q', turnSeq: 4 }, { role: 'assistant', content: 'a', turnSeq: 4 }] };
  pendingCheck(session, check, 4);
  assert.equal(JSON.stringify(session).includes('__turnMemoryCheck'), false, 'the pending mark is not enumerable');
  store.stampTurnMemoryCheck(session);
  assert.deepEqual(plain(session.messages[1].memoryCheck), { ...check });
  assert.equal(Object.hasOwn(session, '__turnMemoryCheck'), false, 'consumed');
  for (const [name, mutate] of [
    ['last row is the user', s => s.messages.push({ role: 'user', content: 'x', turnSeq: 4 })],
    ['assistant of an older turn', s => { s.messages[1].turnSeq = 3; }],
    ['meta from an older turn', s => { s.__turnMemoryCheck.turnSeq = 3; }],
    ['already stamped', s => { s.messages[1].memoryCheck = { enabled: false, checked: false }; }],
  ]) {
    const row = { turnSeq: 4, messages: [{ role: 'user', content: 'q', turnSeq: 4 }, { role: 'assistant', content: 'a', turnSeq: 4 }] };
    pendingCheck(row, check, 4); mutate(row);
    const before = JSON.stringify(row.messages);
    store.stampTurnMemoryCheck(row);
    if (name === 'already stamped') assert.deepEqual(plain(row.messages[1].memoryCheck), { enabled: false, checked: false }, name);
    else assert.equal(JSON.stringify(row.messages), before, name);
    assert.equal(Object.hasOwn(row, '__turnMemoryCheck'), false, name + ': consumed either way');
  }
  const none = { turnSeq: 1, messages: [{ role: 'assistant', turnSeq: 1 }] }; store.stampTurnMemoryCheck(none); assert.equal(none.messages[0].memoryCheck, undefined);
  // 1E 复审:CLI 引擎(05 / 05b)在助手消息后追加 {role:'system', source:'stderr'} 再收尾存 —— 越过尾随 stderr 行盖到本回合助手消息。
  const cli = { turnSeq: 4, messages: [{ role: 'user', content: 'q', turnSeq: 4 }, { role: 'assistant', content: 'a', turnSeq: 4 },
    { role: 'system', content: 'warn', source: 'stderr' }, { role: 'system', content: 'more', source: 'stderr' }] };
  pendingCheck(cli, check, 4); store.stampTurnMemoryCheck(cli);
  assert.deepEqual(plain(cli.messages[1].memoryCheck), { ...check }, 'stamped across trailing stderr rows');
  assert.equal(cli.messages[2].memoryCheck, undefined); assert.equal(cli.messages[3].memoryCheck, undefined);
  // 别的系统行不越过(只认 stderr):宁可不盖,也不往别处盖。
  const other = { turnSeq: 4, messages: [{ role: 'assistant', content: 'a', turnSeq: 4 }, { role: 'system', content: 'note', source: 'compact' }] };
  pendingCheck(other, check, 4); store.stampTurnMemoryCheck(other);
  assert.equal(other.messages[0].memoryCheck, undefined, 'a non-stderr system row is not skipped');
  // 越过 stderr 行后落到更早回合的助手消息:turnSeq 闸照样拦住。
  const stale = { turnSeq: 5, messages: [{ role: 'assistant', content: 'old', turnSeq: 4 }, { role: 'system', content: 'warn', source: 'stderr' }] };
  pendingCheck(stale, check, 5); store.stampTurnMemoryCheck(stale);
  assert.equal(stale.messages[0].memoryCheck, undefined, 'turnSeq still guards the row found behind stderr');
});

class QNode extends Node {
  querySelectorAll(selector) {
    assert.equal(selector, '.memory-check-badge');
    const out = []; const walk = n => { for (const c of n.children || []) { if (c.className === 'memory-check-badge') out.push(c); walk(c); } }; walk(this); return out;
  }
}

test('history rows draw the persisted badge on the usage line (or its own line) and a language switch rewrites it in place', async () => {
  const { appendStaticMemoryBadge, repaintMemoryCheckBadges } = await load();
  const persisted = { enabled: true, checked: true, candidateCount: 5, matchCount: 0, projectMatches: 0, globalMatches: 0, coreActiveCount: 2, ruleFillCount: 1, semantic: { fallback: { reason: 'timeout' } } };
  const qdoc = { createElement: tag => new QNode(tag) };
  const root = new QNode('div'), main = root.appendChild(new QNode('div')), usage = main.appendChild(new QNode('div'));
  const badge = appendStaticMemoryBadge(main, { role: 'assistant', memoryCheck: persisted }, usage, { t: tFor('zh-CN'), doc: qdoc });
  assert.ok(badge); assert.equal(usage.children[0], badge);
  assert.equal(badge.children[0].textContent, '记忆：匹配 0 · 核心 2 · 补位 1 · 关键词回退');
  const bareMain = root.appendChild(new QNode('div'));
  const own = appendStaticMemoryBadge(bareMain, { role: 'assistant', memoryCheck: { enabled: false, checked: false } }, null, { t: tFor('zh-CN'), doc: qdoc });
  assert.equal(bareMain.children[0].className, 'usage-line memory-check-line'); assert.equal(bareMain.children[0].children[0], own);
  assert.equal(appendStaticMemoryBadge(main, { role: 'user', memoryCheck: persisted }, null, { t: tFor('zh-CN'), doc: qdoc }), null, 'never on a user row');
  assert.equal(appendStaticMemoryBadge(main, { role: 'assistant' }, null, { t: tFor('zh-CN'), doc: qdoc }), null, 'old messages without the field draw nothing');
  badge.open = true;
  assert.equal(repaintMemoryCheckBadges(root, { t: tFor('en-US'), doc: qdoc }), 2);
  assert.equal(badge.children[0].textContent, 'Memory: 0 matched · 2 core · 1 filled · keyword fallback');
  assert.equal(usage.children[0], badge, 'rewritten in place'); assert.equal(badge.open, true, 'expanded state survives');
  assert.ok(!/[㐀-鿿]/.test(root.textContent), 'no Chinese left after switching to English');
  const foreign = root.appendChild(new QNode('details')); foreign.className = 'memory-check-badge';
  assert.equal(repaintMemoryCheckBadges(root, { t: tFor('zh-CN'), doc: qdoc }), 2, 'a badge this module did not draw is left alone');
});

test('the attacher repaints live badges on i18n:change', async () => {
  const { createMemoryBadgeAttacher } = await load();
  const listeners = new Map(); const win = { addEventListener: (name, fn) => listeners.set(name, fn) };
  let lang = 'zh-CN'; const t = (key, params) => tFor(lang)(key, params);
  const qdoc = new QNode('document'); qdoc.createElement = tag => new QNode(tag);
  const main = qdoc.appendChild(new QNode('div'));
  const attach = createMemoryBadgeAttacher({ t, doc: qdoc, win });
  const badge = attach({ main, memoryCheck: { enabled: true, checked: true, matchCount: 1 } }, null);
  assert.match(badge.children[0].textContent, /记忆：匹配 1/);
  lang = 'en-US'; listeners.get('i18n:change')();
  assert.match(badge.children[0].textContent, /^Memory: 1 matched/);
});

