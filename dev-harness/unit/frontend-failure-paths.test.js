#!/usr/bin/env node
'use strict';

// 前端 bug 扫查第二批（frontend2）：失败路径、后发先至、「整片重建」与几处边界读数。
// 这些错误平时看不见 —— 服务端不失败、请求不乱序、数字不恰好落在 999,5xx —— 所以用一个极小的假 DOM
// 把【真的】模块工厂跑起来，按用户看得到的结果断言（弹层还在不在、输入框里是什么、列表是谁的数据），
// 不读源码。只有两三处本来就是结构性的判据（某段处理器里的一个标识符、全目录零「无语言参数的
// toLocale*String()」）才切源码，切法用 lib/source-slice.js。
//
//   ① 记忆编辑：保存失败（{ok:false} 或抛错）弹层不关、正文还在、「保存」可以再点；
//   ② 会话改名：patchSession 失败时浮层留着、报原因；置顶失败有人接（不再是未处理的 rejection）；
//   ③ 工作流监控的「调整方向」发送失败，回填的是用户敲的那句话（修前回填的是 i18n 函数 t 本身）；
//   ④ 删模型行：saveConfigPartial 返回 false（它不抛）时撤回乐观更新、不报「已删除」；
//   ⑤ 工作流编辑器「保存」「保存并运行」在飞时锁住（连点不会起两个 run）；
//   ⑥ 运行监控：数据没变不重建（焦点与按钮节点保住，只刷时长读数）；列表不在屏上时轮询这一拍跳过；
//      没有译文的状态退回原值，不上屏 `[workflow.node.status.xxx]`；
//   ⑦ 用量看板：切范围时旧响应后到不覆盖；首载失败不记成「已加载」（再打开会重拉）；
//   ⑧ MCP 运维列表：旧的那一发后到不覆盖新的；
//   ⑨ 设置 → 工作区：删掉唯一一行能真删掉（主工作区框跟着清空）；
//   ⑩ i18n：连着两次 setLocale，最新那一次说了算；hasTranslation；
//   ⑪ 大编辑器的「有没存的改动」确认（modal.js dirty 口）；
//   ⑫ 读数：fmtTokens / ctxLenBadge 不出「1000K」；等待时限的复数；时间与千分位跟界面语言走；
//   ⑬ 批量记忆候选卡（61 号文 C3）：一张卡逐条勾选，保存只送勾上的下标；失败卡片与勾选都在、按钮还给用户；成功才收卡。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { bracedBlock, functionBlock, sliceBlock } = require('../lib/source-slice');

const PUBLIC = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public');
const JS = path.join(PUBLIC, 'js');
const readJs = name => fs.readFileSync(path.join(JS, name), 'utf8');
const load = name => import(pathToFileURL(path.join(JS, name)).href);

// ── 极小假 DOM ────────────────────────────────────────────────────────────────────────────────
// 只实现被测模块真的用到的那几件事；选择器支持「标签 / #id / .类 / [属性] / [属性="值"] / :not(…)」的复合，
// 以及后代（空格）与子代（>）两种组合 —— 不认识的选择器一律「不命中」，不抛。
const SELECTOR_CACHE = new Map();
function splitTopLevel(text, sep) {
  const out = []; let depth = 0, quote = '', cur = '';
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (depth === 0 && sep(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function parseCompound(text) {
  const parts = { tag: '', id: '', classes: [], attrs: [], nots: [] };
  let rest = text.trim();
  const take = re => { const m = rest.match(re); if (m) rest = rest.slice(m[0].length); return m; };
  let m = take(/^[a-zA-Z*][\w-]*/); if (m && m[0] !== '*') parts.tag = m[0].toUpperCase();
  while (rest) {
    if ((m = take(/^#([\w-]+)/))) parts.id = m[1];
    else if ((m = take(/^\.([\w-]+)/))) parts.classes.push(m[1]);
    else if ((m = take(/^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/))) parts.attrs.push([m[1], m[2] ?? m[3] ?? m[4]]);
    else if ((m = take(/^:not\(([^()]*)\)/))) parts.nots.push(parseCompound(m[1]));
    else return null;
  }
  return parts;
}
function parseSelector(selector) {
  if (SELECTOR_CACHE.has(selector)) return SELECTOR_CACHE.get(selector);
  const list = splitTopLevel(selector, ch => ch === ',').map(one => {
    const tokens = one.trim().replace(/\s*>\s*/g, ' > ').split(/\s+/).filter(Boolean);
    const chain = [];
    let combinator = ' ';
    for (const token of tokens) {
      if (token === '>') { combinator = '>'; continue; }
      const compound = parseCompound(token);
      if (!compound) return null;
      chain.push({ compound, combinator });
      combinator = ' ';
    }
    return chain;
  });
  SELECTOR_CACHE.set(selector, list);
  return list;
}
function matchCompound(node, c) {
  if (!node || node.nodeType !== 1) return false;
  if (c.tag && node.tagName !== c.tag) return false;
  if (c.id && node.id !== c.id) return false;
  for (const cls of c.classes) if (!node.classList.contains(cls)) return false;
  for (const [name, value] of c.attrs) {
    const actual = node.getAttribute(name);
    if (actual == null) return false;
    if (value !== undefined && actual !== value) return false;
  }
  for (const not of c.nots) if (matchCompound(node, not)) return false;
  return true;
}
function matchChain(node, chain, index = chain.length - 1) {
  if (!matchCompound(node, chain[index].compound)) return false;
  if (index === 0) return true;
  if (chain[index].combinator === '>') return matchChain(node.parentNode, chain, index - 1);
  for (let up = node.parentNode; up; up = up.parentNode) if (matchChain(up, chain, index - 1)) return true;
  return false;
}
function matches(node, selector) {
  return parseSelector(selector).some(chain => chain && chain.length && matchChain(node, chain));
}

const BOOL_ATTRS = new Set(['disabled', 'hidden', 'open', 'checked', 'selected']);
function makeDocument() {
  const document = { activeElement: null, hidden: false, listeners: {} };
  class Node {
    constructor(tag, nodeType = 1) {
      this.nodeType = nodeType;
      this.tagName = String(tag).toUpperCase();
      this.childNodes = [];
      this.parentNode = null;
      this.ownerDocument = document;
      this.listeners = {};
      this.attrs = {};
      this.dataset = {};
      this.style = { setProperty: (k, v) => { this.style[k] = v; }, removeProperty: k => { delete this.style[k]; } };
      this._text = '';
      this.value = '';
      this.rects = null; // 测试可设：getClientRects() 的返回
      const self = this;
      this.classList = {
        _set: () => new Set(String(self.className || '').split(/\s+/).filter(Boolean)),
        contains(c) { return this._set().has(c); },
        add(...cs) { const s = this._set(); cs.forEach(c => s.add(c)); self.className = [...s].join(' '); },
        remove(...cs) { const s = this._set(); cs.forEach(c => s.delete(c)); self.className = [...s].join(' '); },
        toggle(c, force) { const on = force === undefined ? !this.contains(c) : !!force; if (on) this.add(c); else this.remove(c); return on; },
      };
      this.className = '';
      for (const flag of BOOL_ATTRS) this[flag] = false;
    }
    get children() { return this.childNodes.filter(n => n.nodeType === 1); }
    get firstChild() { return this.childNodes[0] || null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get parentElement() { return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null; }
    get childElementCount() { return this.children.length; }
    get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === document.documentElement; }
    get textContent() { return this.nodeType === 3 ? this._text : this.childNodes.length ? this.childNodes.map(n => n.textContent).join('') : this._text; }
    set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this._text = v == null ? '' : String(v); }
    set innerHTML(v) { this.textContent = ''; }
    get innerHTML() { return ''; }
    get offsetParent() { return this.isConnected ? this.parentNode : null; }
    get offsetWidth() { return 0; }
    get offsetHeight() { return 0; }
    get options() { return this.querySelectorAll('option'); }
    get selectedOptions() { return this.options.filter(o => o.selected); }
    getClientRects() { return this.rects || []; }
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    setAttribute(name, value) {
      const key = String(name);
      if (key === 'class') { this.className = String(value); return; }
      if (key === 'id') { this.id = String(value); return; }
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())] = String(value);
      if (BOOL_ATTRS.has(key)) this[key] = true;
      this.attrs[key] = String(value);
    }
    getAttribute(name) {
      const key = String(name);
      if (key === 'class') return this.className || null;
      if (key === 'id') return this.id || null;
      if (BOOL_ATTRS.has(key)) return this[key] ? '' : null;
      if (key === 'type' && this.type) return this.type;
      if (key.startsWith('data-')) { const d = this.dataset[key.slice(5).replace(/-([a-z])/g, (m, c) => c.toUpperCase())]; if (d !== undefined) return d; }
      return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null;
    }
    hasAttribute(name) { return this.getAttribute(name) != null; }
    removeAttribute(name) { delete this.attrs[String(name)]; if (BOOL_ATTRS.has(name)) this[name] = false; }
    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this; this.childNodes.push(child); return child;
    }
    append(...kids) { for (const k of kids) this.appendChild(typeof k === 'string' ? document.createTextNode(k) : k); }
    prepend(...kids) { for (const k of kids.reverse()) this.insertBefore(typeof k === 'string' ? document.createTextNode(k) : k, this.firstChild); }
    replaceChildren(...kids) { this.textContent = ''; this.append(...kids); }
    insertBefore(child, ref) {
      if (!ref) return this.appendChild(child);
      if (child.parentNode) child.parentNode.removeChild(child);
      const at = this.childNodes.indexOf(ref);
      child.parentNode = this; this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child); return child;
    }
    removeChild(child) { const at = this.childNodes.indexOf(child); if (at >= 0) this.childNodes.splice(at, 1); child.parentNode = null; return child; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    before(...kids) { for (const k of kids) this.parentNode.insertBefore(k, this); }
    after(...kids) { const next = this.parentNode.childNodes[this.parentNode.childNodes.indexOf(this) + 1] || null; for (const k of kids) this.parentNode.insertBefore(k, next); }
    contains(other) { for (let n = other; n; n = n.parentNode) if (n === this) return true; return false; }
    matches(selector) { return matches(this, selector); }
    closest(selector) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, selector)) return n; return null; }
    querySelectorAll(selector) {
      const out = [];
      const walk = node => { for (const c of node.childNodes) { if (c.nodeType === 1) { if (matches(c, selector)) out.push(c); walk(c); } } };
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter(f => f !== fn); }
    dispatchEvent(event) {
      if (!event.target) event.target = this;
      event.currentTarget = this;
      for (const fn of [...(this.listeners[event.type] || [])]) fn.call(this, event);
      const handler = this['on' + event.type];
      if (typeof handler === 'function') handler.call(this, event);
      if (event.bubbles && !event._stop && this.parentNode) this.parentNode.dispatchEvent(event);
      return true;
    }
    click() { return this.dispatchEvent(fakeEvent('click', { bubbles: true })); }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    select() {}
    scrollIntoView() {}
    setPointerCapture() {}
  }
  document.createElement = tag => new Node(tag);
  document.createElementNS = (ns, tag) => new Node(tag);
  document.createTextNode = text => { const n = new Node('#text', 3); n._text = String(text); return n; };
  document.createDocumentFragment = () => new Node('#fragment', 11);
  document.documentElement = new Node('html');
  document.documentElement.lang = '';
  document.body = new Node('body');
  document.documentElement.appendChild(document.body);
  document.getElementById = id => document.documentElement.querySelector('#' + id);
  document.querySelector = s => document.documentElement.querySelector(s);
  document.querySelectorAll = s => document.documentElement.querySelectorAll(s);
  document.addEventListener = (type, fn) => { (document.listeners[type] = document.listeners[type] || []).push(fn); };
  document.removeEventListener = (type, fn) => { document.listeners[type] = (document.listeners[type] || []).filter(f => f !== fn); };
  // 测试便利：按 id 挂一个元素到 body
  document.mount = (tag, id, cls = '') => { const n = new Node(tag); n.id = id; n.className = cls; document.body.appendChild(n); return n; };
  return document;
}
function fakeEvent(type, extra = {}) {
  return { type, bubbles: false, preventDefault() {}, stopPropagation() { this._stop = true; }, ...extra };
}

// ── 全局：window/document/fetch/存储，一次装好（ES 模块在本进程里只求值一次）─────────────────────
const document = makeDocument();
globalThis.document = document;
globalThis.window = globalThis;
const windowListeners = {};
globalThis.addEventListener = (type, fn) => { (windowListeners[type] = windowListeners[type] || []).push(fn); };
globalThis.removeEventListener = (type, fn) => { windowListeners[type] = (windowListeners[type] || []).filter(f => f !== fn); };
globalThis.dispatchEvent = event => { for (const fn of windowListeners[event.type] || []) fn(event); return true; };
globalThis.CustomEvent = class CustomEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } };
const memoryStore = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
globalThis.localStorage = memoryStore();
globalThis.sessionStorage = memoryStore();
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = fn => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
globalThis.CSS = { escape: s => String(s) };
globalThis.innerHeight = 800; globalThis.innerWidth = 1280;
let confirmAnswer = true;
const confirmCalls = [];
globalThis.confirm = message => { confirmCalls.push(message); return confirmAnswer; };
document.mount('div', 'toastTray');

// fetch 路由：locales/*.json 从盘上读；/api/* 交给当前测试装的 handler（可返回 promise 控制先后）。
let apiHandler = () => ({ ok: true });
const apiCalls = [];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const localeGates = new Map(); // locale -> deferred（设了就等它放行）
globalThis.fetch = async (url, options = {}) => {
  const href = String(url && url.href ? url.href : url);
  const localeMatch = href.match(/locales\/([\w-]+)\.json$/);
  if (localeMatch) {
    if (localeGates.has(localeMatch[1])) await localeGates.get(localeMatch[1]).promise;
    return new Response(fs.readFileSync(path.join(PUBLIC, 'locales', `${localeMatch[1]}.json`)), { status: 200 });
  }
  apiCalls.push({ url: href, options });
  const out = await apiHandler(href, options);
  if (out instanceof Response) return out;
  return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
};
const httpError = (status, body) => new Response(JSON.stringify(body), { status });
const toasts = () => document.getElementById('toastTray').children.map(n => ({ text: n.textContent, kind: n.className.replace(/^toast\s*/, '') }));
const clearToasts = () => { document.getElementById('toastTray').textContent = ''; };
const flush = async (n = 5) => { for (let i = 0; i < n; i += 1) await new Promise(r => setImmediate(r)); };

// ── ⑩ i18n：必须排在任何「先把 en-US 目录拉进来」的测试之前 ─────────────────────────────────────
test('⑩ setLocale：两次连着切，最新那一次说了算，被盖掉的那一次也回报最终语言', async () => {
  const i18n = await load('i18n.js');
  await i18n.setLocale('zh-CN');                      // 先把兜底目录拉进来
  const gate = deferred();
  localeGates.set('en-US', gate);
  const slow = i18n.setLocale('en-US');               // en-US 目录还在路上
  const fast = await i18n.setLocale('zh-CN');         // 用户又改回中文，这一发先落地
  assert.equal(fast, 'zh-CN');
  gate.resolve();
  localeGates.delete('en-US');
  const slowResult = await slow;
  assert.equal(i18n.getLocale(), 'zh-CN', '慢到的 en-US 不许把后选的 zh-CN 盖回去');
  assert.equal(document.documentElement.lang, 'zh-CN');
  assert.equal(slowResult, 'zh-CN', '设置页拿返回值写 config.locale：被盖掉的那一次回报的是最终语言');
});

test('⑩ hasTranslation：t() 缺键回可见的 [key]，所以「有没有译文」要单独问', async () => {
  const i18n = await load('i18n.js');
  assert.equal(i18n.hasTranslation('common.save'), true);
  assert.equal(i18n.hasTranslation('workflow.node.status.__nope__'), false);
  assert.equal(i18n.t('workflow.node.status.__nope__'), '[workflow.node.status.__nope__]', '前提：t() 缺键是非空字符串');
});

// ── ⑦ 用量看板 ───────────────────────────────────────────────────────────────────────────────
test('⑦ 用量看板：切范围时旧的那一发后到，不覆盖新范围的画面', async () => {
  const { createUsageDashboardDomain } = await load('usage-dashboard.js');
  const { t } = await load('i18n.js');
  const panel = document.mount('div', 'usagePanel');
  const weekBtn = document.mount('button', 'usageWeek', 'usage-range-btn'); weekBtn.dataset.range = 'week';
  const monthGate = deferred();
  apiHandler = url => {
    if (url.includes('/api/usage/summary?range=month')) return monthGate.promise;
    if (url.includes('/api/usage/summary?range=week')) return { ok: false };      // 新范围：画「暂不可用」
    return { ok: true };
  };
  const usage = createUsageDashboardDomain();
  usage.bindUsageDashboard();
  const first = usage.loadUsage();          // 本月：在路上
  weekBtn.click();                          // 用户切到本周，这一发先回来
  await flush();
  assert.equal(panel.textContent, t('usage.unavailable'));
  monthGate.resolve(httpError(500, { ok: false, error: 'boom' }));   // 旧的本月这时才失败
  await first; await flush();
  assert.equal(panel.textContent, t('usage.unavailable'), '旧范围的失败不许盖掉新范围的画面');
  assert.equal(panel.getAttribute('aria-busy'), null);
  panel.remove(); weekBtn.remove();
});

test('⑦ 用量看板：首载失败不记成「已加载」，再打开页签会重拉', async () => {
  const { createUsageDashboardDomain } = await load('usage-dashboard.js');
  const panel = document.mount('div', 'usagePanel');
  apiHandler = url => (url.includes('/api/usage/summary') ? httpError(500, { ok: false, error: 'down' }) : { ok: true });
  const usage = createUsageDashboardDomain();
  const before = apiCalls.filter(c => c.url.includes('/api/usage/summary')).length;
  await usage.openUsageDashboard();
  await usage.openUsageDashboard();
  const after = apiCalls.filter(c => c.url.includes('/api/usage/summary')).length;
  assert.equal(after - before, 2, '第二次打开要重拉，而不是永远停在失败卡上');
  panel.remove();
});

// ── ⑧ MCP 运维列表 ────────────────────────────────────────────────────────────────────────────
test('⑧ MCP 运维：慢的探测后到，不把新列表与计数盖回去；按钮由最新那一发解锁', async () => {
  const { createSettingsOperationsDomain } = await load('settings-operations.js');
  const { t } = await load('i18n.js');
  const hint = document.mount('div', 'mcpListHint');
  const button = document.mount('button', 'mcpRefreshBtn');
  const list = document.mount('div', 'mcpConnList');
  const probeGate = deferred();
  const listGate = deferred();
  apiHandler = url => (url.includes('probe=1') ? probeGate.promise : listGate.promise);
  const ops = createSettingsOperationsDomain();
  const probe = ops.refreshMcpOps(true);     // 先发：探测
  const fresh = ops.refreshMcpOps(false);    // 后发：普通刷新（这一发才是最新的）
  probeGate.resolve(httpError(500, { ok: false, error: 'probe timed out' }));   // 旧的先失败
  await probe; await flush();
  assert.equal(button.disabled, true, '最新那一发还在飞，旧的那一发不许把按钮解锁');
  assert.equal(hint.textContent, t('settings.mcp.loading'), '旧的那一发不许把提示改成它的错误');
  listGate.resolve({ ok: true, connectors: [] });
  await fresh; await flush();
  assert.equal(hint.textContent, t('settings.mcp.count.other', { p1: 0 }));
  assert.equal(button.disabled, false);
  assert.equal(list.textContent, t('settings.mcp.empty'));
  hint.remove(); button.remove(); list.remove();
});

// ── ① 记忆编辑 + ⑪ 大编辑器的「没存的改动」确认 ─────────────────────────────────────────────────
// 2.0 的组合根给各域注入的 buildModal 是 interaction-prompts.js 那一层（title, body, foot, onCancel, opts），
// 实现是 modal.js 的 buildModal —— 这里用同一个形状把真的 modal.js 接进去。
async function openMemoryEditor() {
  const { createSkillsMemoryDomain } = await load('skills-memory.js');
  const modal = await load('modal.js');
  const addBtn = document.getElementById('memoryToolboxAddBtn') || document.mount('button', 'memoryToolboxAddBtn');
  const domain = createSkillsMemoryDomain({
    buildModal: (title, body, foot, onCancel, opts = {}) => modal.buildModal({ title, body, foot, onCancel, dirty: opts.dirty }),
  });
  domain.bindSkillsMemory();
  const before = document.body.querySelectorAll('.modal-backdrop').length;
  addBtn.click();
  await flush();
  const all = document.body.querySelectorAll('.modal-backdrop');
  assert.equal(all.length, before + 1, '记忆编辑弹层开出来了');
  const backdrop = all[all.length - 1];
  const fields = backdrop.querySelectorAll('.pb-field-input');
  const name = fields.find(n => n.tagName === 'INPUT' && n.type === 'text');
  const bodyTa = fields.filter(n => n.tagName === 'TEXTAREA').find(n => n.rows === 8);
  const save = backdrop.querySelectorAll('button.primary')[0];
  return { backdrop, name, bodyTa, save };
}

test('① 记忆编辑：保存失败（{ok:false} 与抛错两路）弹层不关、正文还在、「保存」可以再点', async () => {
  const { t } = await load('i18n.js');
  const { backdrop, name, bodyTa, save } = await openMemoryEditor();
  name.value = '发布流程';
  bodyTa.value = '一段敲了好几分钟的正文';
  clearToasts();
  apiHandler = (url, options) => (url.endsWith('/api/memory') && options.method === 'POST' ? { ok: false, error: 'disk full' } : { ok: true });
  save.click(); await flush();
  assert.equal(backdrop.isConnected, true, '{ok:false}：弹层还在');
  assert.equal(bodyTa.value, '一段敲了好几分钟的正文');
  assert.equal(save.disabled, false, '「保存」还给用户');
  assert.equal(save.textContent, t('common.save'));
  assert.deepEqual(toasts().map(x => x.kind), ['err']);
  apiHandler = (url, options) => (url.endsWith('/api/memory') && options.method === 'POST' ? httpError(500, { ok: false, error: 'EIO' }) : { ok: true });
  save.click(); await flush();
  assert.equal(backdrop.isConnected, true, '抛错：弹层还在');
  assert.equal(save.disabled, false);
  apiHandler = () => ({ ok: true, memories: [] });
  save.click(); await flush();
  assert.equal(backdrop.isConnected, false, '成功才关');
});

test('⑪ 大编辑器：改过内容后点背影／Esc 先问一句；答「不」就留着，没改过或点「保存」不问', async () => {
  const { backdrop } = await openMemoryEditor();
  confirmCalls.length = 0;
  // 没改过：点背影直接关、不问
  backdrop.dispatchEvent(fakeEvent('mousedown', { target: backdrop }));
  assert.equal(backdrop.isConnected, false);
  assert.equal(confirmCalls.length, 0, '没改过不问');

  const second = await openMemoryEditor();
  second.bodyTa.value = '写了一半';
  confirmAnswer = false;
  second.backdrop.dispatchEvent(fakeEvent('mousedown', { target: second.backdrop }));
  assert.equal(second.backdrop.isConnected, true, '点背影手滑：答「不」就留着');
  second.backdrop.__cancel();                          // app.js 的全局 Esc 走这个口
  assert.equal(second.backdrop.isConnected, true, 'Esc 同样先问');
  assert.equal(confirmCalls.length, 2);
  confirmAnswer = true;
  second.backdrop.__cancel();
  assert.equal(second.backdrop.isConnected, false, '答「是」才关');
});

// ── ⑬ 批量记忆候选卡（61 号文 C3）────────────────────────────────────────────────────────────────
// 模型一次提议 2–3 条 → 回合后一张卡、逐条勾选。失败路径与记忆编辑同一条纪律：没存上就什么都别丢（卡片、勾选都在，
// 按钮还给用户）；成功才收卡；「全部忽略」只记一次 dismissed、不走 apply。
test('⑬ 批量记忆卡：一张卡逐条勾选；保存只送勾上的下标；失败卡片留着、勾选不丢；成功才收；「全部忽略」整张丢', async () => {
  const { t, tCount } = await load('i18n.js');
  const { state } = await load('state.js');
  const { createSkillsMemoryDomain } = await load('skills-memory.js');
  const domain = createSkillsMemoryDomain({ currentWorkspace: () => 'C:\\proj' });
  const SID = 'sess_mem_batch';
  state.currentSession = { id: SID };
  const messages = document.getElementById('messages') || document.mount('div', 'messages');
  const host = document.createElement('div');
  messages.appendChild(host);
  const items = [1, 2, 3].map(n => ({ name: `约定${n}`, description: `何时用 ${n}`, type: n === 2 ? 'lesson' : 'convention', scope: n === 3 ? 'global' : 'project',
    body: `正文 ${n}`, reason: `原因 ${n}`, status: 'pending' }));
  const proposal = { kind: 'memory_batch', items, sourceSessionId: SID, sourceTurnSeq: 1 };
  const applyBodies = [];
  const decisions = [];
  let applyAnswer = () => ({ ok: false, error: 'disk full' });
  apiHandler = (url, options = {}) => {
    if (url.endsWith('/api/memory/proposal')) return { ok: true, proposalId: 'prop_b', proposal, replayed: true, reason: 'tool_proposal' };
    if (url.endsWith('/api/memory/proposal/apply')) { applyBodies.push(JSON.parse(options.body)); return applyAnswer(); }
    if (url.endsWith('/api/memory/proposal/decision')) { decisions.push(JSON.parse(options.body)); return { ok: true, status: 'dismissed' }; }
    return { ok: true, memories: [] };
  };
  await domain.suggestMemoryFromTurn(SID, host);
  await flush();
  const cards = messages.querySelectorAll('.memory-proposal-card');
  assert.equal(cards.length, 1, '三条候选是【一张】卡');
  const card = cards[0];
  assert.ok(card.classList.contains('memory-proposal-batch'));
  assert.equal(card.querySelector('.memory-proposal-kicker').textContent, t('memory.proposal.kickerBatch', { count: 3 }));
  const rows = card.querySelectorAll('.memory-proposal-item');
  assert.equal(rows.length, 3, '每条一行');
  assert.deepEqual(rows.map(r => r.querySelector('.memory-proposal-title').textContent), ['约定1', '约定2', '约定3']);
  assert.ok(rows[2].textContent.includes(t('memory.scope.global')) && rows[1].textContent.includes('原因 2') && rows[0].querySelector('details').textContent.includes('正文 1'),
    '范围标签、提议原因、折叠里的正文都画出来了');
  const boxes = card.querySelectorAll('input');
  assert.deepEqual(boxes.map(b => [b.type, b.checked]), [['checkbox', true], ['checkbox', true], ['checkbox', true]], '默认全勾');
  const [dismiss, save] = card.querySelectorAll('.memory-proposal-actions button');
  assert.equal(save.textContent, t('memory.proposal.saveSelected', { count: 3 }));
  boxes[1].checked = false; boxes[1].dispatchEvent(fakeEvent('change'));
  assert.equal(save.textContent, t('memory.proposal.saveSelected', { count: 2 }), '按钮上的数跟着勾选走');

  // 失败：卡片留着、勾选不丢、按钮还给用户、报原因
  clearToasts();
  save.click(); save.click();                              // 连点：在飞时只发一发
  await flush();
  assert.equal(applyBodies.length, 1);
  assert.deepEqual(applyBodies[0], { sessionId: SID, proposalId: 'prop_b', cwd: 'C:\\proj', accept: [0, 2] }, '只送勾上的下标');
  assert.equal(card.isConnected, true, '失败：卡片留着');
  assert.deepEqual(boxes.map(b => b.checked), [true, false, true], '勾选不丢');
  assert.equal(save.disabled, false);
  assert.equal(dismiss.disabled, false);
  assert.ok(boxes.every(b => !b.disabled));
  assert.deepEqual(toasts().map(x => x.kind), ['err']);

  // 一条都不勾：「保存选中」不可点（要丢整张用「全部忽略」）
  for (const b of boxes) { b.checked = false; b.dispatchEvent(fakeEvent('change')); }
  assert.equal(save.disabled, true);
  for (const i of [0, 2]) { boxes[i].checked = true; boxes[i].dispatchEvent(fakeEvent('change')); }

  // 成功：报存了几条、收卡
  applyAnswer = () => ({ ok: true, kind: 'memory_batch', status: 'saved', saved: [{ index: 0 }, { index: 2 }], dismissed: [{ index: 1 }] });
  clearToasts();
  save.click();
  await flush();
  assert.deepEqual(applyBodies[1].accept, [0, 2]);
  assert.deepEqual(toasts().map(x => x.kind), ['ok']);
  assert.equal(toasts()[0].text, tCount('memory.proposal.batchSaved', 2));
  await new Promise(r => setTimeout(r, 220));
  assert.equal(card.isConnected, false, '成功才收卡');

  // 「全部忽略」：只记一次 dismissed，不走 apply
  await domain.suggestMemoryFromTurn(SID, host);
  await flush();
  const card2 = messages.querySelector('.memory-proposal-card');
  card2.querySelectorAll('.memory-proposal-actions button')[0].click();
  await flush();
  assert.deepEqual(decisions, [{ sessionId: SID, proposalId: 'prop_b', decision: 'dismissed' }]);
  assert.equal(applyBodies.length, 2, '忽略不调 apply');
  await new Promise(r => setTimeout(r, 220));
  assert.equal(messages.querySelectorAll('.memory-proposal-card').length, 0);
  host.remove();
});

// ── ② 会话改名 ／ ④ 删模型行（navigation-controls 域）────────────────────────────────────────────
test('② 会话改名：保存失败时浮层留着、名字还在、报原因；成功才关', async () => {
  const { createNavigationControlsDomain } = await load('navigation-controls.js');
  const calls = [];
  let fail = true;
  const nav = createNavigationControlsDomain({
    patchSession: async (id, patch) => { calls.push([id, patch]); await flush(1); if (fail) throw new Error('会话正被另一个窗口改写'); },
  });
  const anchor = document.mount('button', 'renameAnchor');
  nav.openRenamePopover(anchor, { id: 'sess_1', title: '旧名字' });
  const pop = document.body.querySelector('.rename-pop');
  assert.ok(pop, '改名浮层开出来了');
  const input = pop.querySelector('input.rename-input');
  const okBtn = pop.querySelector('button.primary');
  input.value = '新名字';
  clearToasts();
  okBtn.click(); okBtn.click();                          // 连点：在飞时只发一发
  await flush();
  assert.deepEqual(calls, [['sess_1', { title: '新名字' }]]);
  assert.equal(pop.isConnected, true, '失败：浮层不关');
  assert.equal(input.value, '新名字', '刚敲的名字还在');
  assert.equal(input.disabled, false);
  assert.equal(okBtn.disabled, false);
  assert.deepEqual(toasts(), [{ text: '会话正被另一个窗口改写', kind: 'err' }]);
  fail = false;
  okBtn.click(); await flush();
  assert.equal(pop.isConnected, false, '成功才关');
  anchor.remove();
});

test('④ 删模型行：saveConfigPartial 返回 false（不抛）时撤回乐观更新、不报「已删除」', async () => {
  const { createNavigationControlsDomain } = await load('navigation-controls.js');
  const { state } = await load('state.js');
  const config = {
    extraModels: ['m1|模型一', 'm2'], knownModels: ['m3'], model: 'm1',
    providers: [{ id: 'p1', model: 'x1', models: [{ id: 'x1' }, { id: 'x2' }], hiddenModels: [] }],
  };
  state.config = JSON.parse(JSON.stringify(config));
  let saves = 0;
  const nav = createNavigationControlsDomain({ saveConfigPartial: async () => { saves += 1; return false; } });
  clearToasts();
  await nav.modelMenuExtras.onDelete('m1', { engine: 'claude' });
  await nav.modelMenuExtras.onDelete('x1', { engine: 'openai', providerId: 'p1' });
  assert.equal(saves, 2);
  assert.deepEqual(state.config, config, '两组都退回原样（命令行那组的 model、provider 那组的 models/hiddenModels/model）');
  assert.deepEqual(toasts().filter(x => x.kind === 'ok'), [], '没存进去就不报成功');
});

test('② 左栏置顶：写失败有人接 —— 报原因，不是一条没人接的 rejection', async () => {
  const { createSessionExperienceDomain } = await load('session-experience.js');
  const { state } = await load('state.js');
  const rail = document.mount('div', 'railList');
  const pin = document.createElement('button');
  pin.dataset.sessionAction = 'pin'; pin.dataset.sessionId = 'sess_9';
  rail.appendChild(pin);
  state.sessions = [{ id: 'sess_9', title: 'x', pinned: false }];
  const domain = createSessionExperienceDomain({ apiErrText: e => `失败:${e.status}` });
  assert.equal(domain.bindRailSessionActions(), true);
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  apiHandler = () => httpError(409, { ok: false, error: 'busy' });
  clearToasts();
  try {
    pin.click();
    await flush(10);
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
  assert.deepEqual(toasts(), [{ text: '失败:409', kind: 'err' }]);
  rail.remove();
});

// 2026-10:playbook 弹窗的必填项 —— 标了 required 的输入留空时不发出去(修前清理下载这类卡片的文件夹留空照发),
// 报一句缺哪一项、弹窗留着;没标 required 的仍可留空。
test('⑦ playbook 弹窗：required 的输入留空不发出去，填上才发', async () => {
  const { createSessionExperienceDomain } = await load('session-experience.js');
  const { state } = await load('state.js');
  const modal = await load('modal.js');
  const sent = [];
  state.streaming = false;
  const domain = createSessionExperienceDomain({
    buildModal: (title, body, foot) => modal.buildModal({ title, body, foot }),
    sendPrompt: async prompt => { sent.push(prompt); },
  });
  const pb = { id: 'pb-demo', title: '清理', promptTemplate: '清理 {folder} 备注 {note}', inputs: [
    { key: 'folder', label: '文件夹', type: 'folder', required: true }, { key: 'note', label: '备注', type: 'text' }] };
  const before = document.body.querySelectorAll('.modal-backdrop').length;
  domain.openPlaybookModal(pb);
  await flush();
  const all = document.body.querySelectorAll('.modal-backdrop');
  const backdrop = all[all.length - 1];
  assert.equal(all.length, before + 1, '弹窗开出来了');
  const [folder] = backdrop.querySelectorAll('.pb-field-input');
  const labels = backdrop.querySelectorAll('.pb-field-label').map(n => n.textContent);
  assert.deepEqual(labels, ['文件夹 *', '备注'], '必填项标星,选填项不标');
  const go = backdrop.querySelectorAll('button.primary')[0];
  clearToasts();
  go.onclick();
  await flush();
  assert.deepEqual(sent, [], '必填项空着不发');
  assert.equal(backdrop.isConnected, true, '弹窗留着,填完还能发');
  assert.equal(toasts().length, 1);
  assert.equal(toasts()[0].kind, 'err');
  folder.value = 'D:/Downloads';
  go.onclick();
  await flush();
  assert.deepEqual(sent, ['清理 D:/Downloads 备注 '], '必填项填上就发;选填项留空照旧可以');
});

// ── ⑤⑥ 工作流：编辑器与运行监控（agent-workflows 域）────────────────────────────────────────────
const WF = { id: 'wf_demo', title: '演示', description: '', source: 'personal', nodes: [{ id: 'step_1', task: '读 README', role: 'worker', dependsOn: [], failurePolicy: 'block' }] };
async function workflowsDomain(extra = {}) {
  const { createAgentWorkflowsDomain } = await load('agent-workflows.js');
  const modal = await load('modal.js');
  return createAgentWorkflowsDomain({
    buildModal: (title, body, foot, onCancel, opts = {}) => modal.buildModal({ title, body, foot, onCancel, dirty: opts.dirty }),
    ...extra,
  });
}

test('⑤ 工作流编辑器：「保存并运行」在飞时两枚按钮锁住，连点只存一次、只起一个 run', async () => {
  const { state } = await load('state.js');
  state.currentSession = { id: 'sess_wf' };
  const saveGate = deferred();
  const posts = [];
  apiHandler = (url, options) => {
    if (url.includes('/api/agent-workflows') && options.method === 'POST') { posts.push(url); return saveGate.promise; }
    if (url.includes('/api/agent-workflow/launch')) { posts.push(url); return { ok: true, runId: 'run_1' }; }
    if (url.includes('/api/agent-workflows')) return { ok: true, workflows: [WF] };
    if (url.includes('/api/agent-roles')) return { ok: true, roles: [] };
    return { ok: true, runs: [] };
  };
  const wf = await workflowsDomain();
  await wf.openWorkflowEditor('wf_demo');
  const backdrop = document.body.querySelectorAll('.modal-backdrop').pop();
  const run = backdrop.querySelector('.workflow-editor-foot button.primary');
  const save = backdrop.querySelectorAll('.workflow-editor-foot-right button')[1];
  run.click(); await flush();
  run.click(); save.click(); await flush();
  assert.equal(run.disabled, true, '在飞时「保存并运行」锁住');
  assert.equal(save.disabled, true, '「保存」一起锁住（两路写同一份草稿）');
  saveGate.resolve({ ok: true, workflow: WF });
  await flush(20);
  assert.deepEqual(posts.map(u => u.replace(/\?.*$/, '')), ['/api/agent-workflows', '/api/agent-workflow/launch'], '只存一次、只起一个 run');
  assert.equal(backdrop.isConnected, false);
});

test('⑪ 工作流编辑器：没改过点背影直接关；改过先问', async () => {
  apiHandler = url => (url.includes('/api/agent-workflows') ? { ok: true, workflows: [WF] } : { ok: true, roles: [] });
  const wf = await workflowsDomain();
  confirmCalls.length = 0;
  await wf.openWorkflowEditor('wf_demo');
  let backdrop = document.body.querySelectorAll('.modal-backdrop').pop();
  backdrop.dispatchEvent(fakeEvent('mousedown', { target: backdrop }));
  assert.equal(backdrop.isConnected, false, '没改过：直接关');
  assert.equal(confirmCalls.length, 0);
  await wf.openWorkflowEditor('wf_demo');
  backdrop = document.body.querySelectorAll('.modal-backdrop').pop();
  const title = backdrop.querySelectorAll('.workflow-meta input')[1];
  title.value = '改过的名字';
  confirmAnswer = false;
  backdrop.dispatchEvent(fakeEvent('mousedown', { target: backdrop }));
  assert.equal(backdrop.isConnected, true, '改过：答「不」就留着');
  assert.equal(confirmCalls.length, 1);
  confirmAnswer = true;
  backdrop.__cancel();
  assert.equal(backdrop.isConnected, false);
});

test('⑥ 运行监控：数据没变不重建（按钮节点与焦点保住，只刷时长读数）；变了才重建；未知状态退回原值', async () => {
  const { state } = await load('state.js');
  const { t } = await load('i18n.js');
  state.currentSession = { id: 'sess_runs' };
  state.config = { monitorIncremental: false };
  const host = document.mount('div', 'agentRunsList');
  const startedAt = new Date(Date.now() - 65_000).toISOString();
  const runOf = (n1Status = 'running') => ({
    id: 'run_1', status: 'running', live: true, createdAt: startedAt, eventSeq: 3,
    nodes: [
      { id: 'n1', status: n1Status, task: '读 README', startedAt, progressLog: [] },
      { id: 'n2', status: 'brand_new_state', task: '后端新加的状态' },
    ],
  });
  let payload = runOf();
  apiHandler = url => (url.includes('/api/agent-runs') ? { ok: true, runs: [JSON.parse(JSON.stringify(payload))] } : { ok: true });
  const wf = await workflowsDomain();
  await wf.loadAgentRuns(true);
  const card = host.querySelector('.agent-run-card');
  assert.ok(card, '画出了 run 卡');
  const pause = card.querySelector('.agent-run-controls button');
  assert.ok(pause, '运行中的 run 有「暂停」');
  pause.focus();
  const labels = card.querySelectorAll('.wf-node-status-label').map(n => n.textContent);
  assert.deepEqual(labels, [t('workflow.node.status.running'), 'brand_new_state'], '没有译文的状态上屏原值，不是 [workflow.node.status.xxx]');
  const time = card.querySelector('.ar-agg-time');
  const before = time.textContent;

  const realNow = Date.now;
  Date.now = () => realNow() + 10_000;                  // 过了 10 秒，数据一个字没变
  try { await wf.loadAgentRuns(true); } finally { Date.now = realNow; }
  assert.equal(card.isConnected, true, '同一份数据：卡片节点没被拆掉重建');
  assert.equal(pause.isConnected, true, '「暂停」还是同一枚按钮（按下未抬起的点击不会落空）');
  assert.equal(document.activeElement, pause, '焦点还在「暂停」上');
  assert.notEqual(host.querySelector('.ar-agg-time').textContent, before, '已运行时长就地刷新了');

  payload = runOf('succeeded');                          // 数据真变了
  await wf.loadAgentRuns(true);
  assert.equal(card.isConnected, false, '数据变了照常重建');
  assert.ok(host.querySelector('.agent-run-card'));
  host.remove();
});

test('⑥ 运行监控轮询：页签还挂着 active 但列表不在屏上（视角切走／右栏收起）时，这一拍不拉', async () => {
  const { state } = await load('state.js');
  state.currentSession = { id: 'sess_poll' };
  state.config = {};
  const pane = document.mount('div', 'toolPaneForTest', 'tool-pane');
  const tabs = document.createElement('div'); tabs.className = 'tool-tabs'; pane.appendChild(tabs);
  const tab = document.createElement('button'); tab.dataset.tab = 'agent-runs'; tab.className = 'active'; tabs.appendChild(tab);
  const host = document.mount('div', 'agentRunsList');
  apiHandler = () => ({ ok: true, runs: [] });
  const wf = await workflowsDomain();
  const count = () => apiCalls.filter(c => c.url.includes('/api/agent-runs')).length;
  try {
    host.rects = [];                                     // display:none 链上：没有盒子
    let n = count();
    wf.updateAgentRunsPolling('agent-runs'); await flush();
    assert.equal(count(), n, '不在屏上：不拉');
    host.rects = [{ width: 300, height: 200 }];
    n = count();
    wf.updateAgentRunsPolling('agent-runs'); await flush();
    assert.equal(count(), n + 1, '在屏上：照常拉');
  } finally {
    tab.className = '';
    wf.updateAgentRunsPolling('files');                  // 停表，别让 2 秒心跳拖住测试进程
    pane.remove(); host.remove();
  }
});

// ── ⑨ 设置 → 工作区：删掉唯一一行 ─────────────────────────────────────────────────────────────
// 删除按钮的处理器是 renderWorkspacePerms 里的一行内联接线（splice → syncPrimaryInput → 存 workspacePatch()），
// 工厂不导出它；这里把那两个真函数原样切出来，在同一个上下文里按那一行的顺序跑。
test('⑨ 工作区清单删到空：主工作区框跟着清空，补丁里不再把旧路径塞回去', () => {
  const src = readJs('provider-settings.js');
  const rmLine = sliceBlock(src, "rm.addEventListener('click',", '\n');
  assert.match(rmLine, /splice\(i, 1\);\s*syncPrimaryInput\(\);[\s\S]*saveWorkspaces\(\)/, '删除 = splice → syncPrimaryInput → saveWorkspaces（存的是 workspacePatch()）');
  const primary = { value: 'D:\\work\\only', tagName: 'INPUT' };
  const ctx = {
    state: { config: { workspaces: [{ path: 'D:\\work\\only', read: true, write: true, execute: true }], allowOutsideWorkspace: false } },
    document: { activeElement: null },
    $: id => (id === 'workspaceInput' ? primary : null),
  };
  vm.createContext(ctx);
  vm.runInContext(`${functionBlock(src, 'syncPrimaryInput')}\n${functionBlock(src, 'workspacePatch')}\nthis.syncPrimaryInput = syncPrimaryInput; this.workspacePatch = workspacePatch;`, ctx);
  ctx.state.config.workspaces.splice(0, 1);
  ctx.syncPrimaryInput();
  const patch = ctx.workspacePatch();
  assert.equal(primary.value, '', '主工作区框清空');
  assert.deepEqual(JSON.parse(JSON.stringify(patch.workspaces)), [], '清单真的空了（修前旧路径被当成主工作区塞回来）');
  assert.equal(patch.defaultWorkspace, '');
});

// ── ⑫ 读数 ────────────────────────────────────────────────────────────────────────────────────
test('⑫ fmtTokens / ctxLenBadge：999,500 起不出「1000K」', async () => {
  const { fmtTokens } = await load('util.js');
  assert.equal(fmtTokens(999_499), '999K');
  assert.equal(fmtTokens(999_500), '1M');
  assert.equal(fmtTokens(999_999), '1M');
  assert.equal(fmtTokens(1_000_000), '1M');
  assert.equal(fmtTokens(1_250_000), '1.25M');
  assert.equal(fmtTokens(150_000), '150K');
  const ctxLenBadge = vm.runInNewContext(`(${functionBlock(readJs('navigation-controls.js'), 'ctxLenBadge')})`);
  assert.equal(ctxLenBadge(999_499), '999K');
  assert.equal(ctxLenBadge(999_600), '1M');
  assert.equal(ctxLenBadge(1_048_576), '1M');
  assert.equal(ctxLenBadge(128_000), '128K');
  assert.equal(ctxLenBadge(2_000_000), '2M');
});

test('⑫ 等待时限走复数表：英文「1 minute」「30 seconds」，中文不变', async () => {
  const i18n = await load('i18n.js');
  const waitChoiceLabel = vm.runInNewContext(`(${functionBlock(readJs('provider-settings.js'), 'waitChoiceLabel')})`, { t: i18n.t, tCount: i18n.tCount });
  try {
    await i18n.setLocale('en-US');
    assert.equal(waitChoiceLabel(60_000), '1 minute');
    assert.equal(waitChoiceLabel(300_000), '5 minutes');
    assert.equal(waitChoiceLabel(30_000), '30 seconds');
    assert.equal(waitChoiceLabel(1_000), '1 second');
    await i18n.setLocale('zh-CN');
    assert.equal(waitChoiceLabel(60_000), '1 分钟');
    assert.equal(waitChoiceLabel(30_000), '30 秒');
  } finally { await i18n.setLocale('zh-CN'); }
});

test('⑫ public/ 里没有不带语言参数的 toLocale*String()：时间与千分位跟界面语言走，不跟操作系统', () => {
  const files = ['app.js', ...fs.readdirSync(JS).filter(f => f.endsWith('.js')).map(f => 'js/' + f)];
  const offenders = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    for (const m of src.matchAll(/\.toLocale(?:Date|Time)?String\(\)/g)) offenders.push(`${file}@${src.slice(0, m.index).split('\n').length}`);
  }
  assert.deepEqual(offenders, [], '传 getLocale()（或 <html lang>）');
});

// ── ③ 工作流监控「调整方向」回填 ────────────────────────────────────────────────────────────────
// 发送失败的回填写在输入框的 submit 闭包里（组件只在画布抽屉里现建，没有导出口），按结构判：
// 回填的是这一轮取出来的文本 t2，不是 i18n 函数 t（修前上屏的是 t 的函数源码）。
test('③ steer 发送失败回填的是用户敲的那句话', () => {
  const src = readJs('workbench.js');
  const submit = bracedBlock(src, 'const submit = async () =>');
  assert.ok(submit.length > 80, '切到了 submit 闭包');
  assert.match(submit, /const t2 = \(input\.value \|\| ''\)\.trim\(\)/);
  assert.match(submit, /inp\.value = t2;/);
  assert.doesNotMatch(submit, /inp\.value = t;/);
});
