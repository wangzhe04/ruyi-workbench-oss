'use strict';

// UI-only regression for the Kimi ACP native plan snapshot contract. This deliberately runs the two
// frontend renderers with a tiny DOM shim, so it does not need a browser, a server, credentials, or Kimi.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const toolSource = read('ruyi-workbench/app/public/js/tool-runtime.js');
const streamSource = read('ruyi-workbench/app/public/js/chat-stream-runtime.js');
const staticSource = read('ruyi-workbench/app/public/js/chat-static-renderer.js');
const navigationSource = read('ruyi-workbench/app/public/js/navigation-controls.js');
const zh = JSON.parse(read('ruyi-workbench/app/public/locales/zh-CN.json'));
const en = JSON.parse(read('ruyi-workbench/app/public/locales/en-US.json'));

class FakeClassList {
  constructor(owner) { this.owner = owner; this.values = new Set(); }
  add(...names) { for (const name of names) if (name) this.values.add(String(name)); this.sync(); }
  remove(...names) { for (const name of names) this.values.delete(String(name)); this.sync(); }
  contains(name) { return this.values.has(String(name)); }
  toggle(name, force) {
    const value = force === undefined ? !this.values.has(String(name)) : Boolean(force);
    if (value) this.values.add(String(name)); else this.values.delete(String(name));
    this.sync();
    return value;
  }
  setFrom(value) { this.values = new Set(String(value || '').split(/\s+/).filter(Boolean)); this.sync(); }
  sync() { this.owner._className = [...this.values].join(' '); }
  toString() { return this.owner._className; }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this._className = '';
    this.classList = new FakeClassList(this);
    this._textContent = '';
    this._innerHTML = '';
    this.disabled = false;
  }
  get className() { return this._className; }
  set className(value) { this.classList.setFrom(value); }
  append(...nodes) { for (const node of nodes) this.appendChild(node); }
  appendChild(node) {
    if (!node) return node;
    if (node.parentNode) node.remove();
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  replaceWith(node) {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index < 0) return;
    if (node.parentNode) node.remove();
    node.parentNode = this.parentNode;
    siblings[index] = node;
    this.parentNode = null;
  }
  before(node) {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    const index = siblings.indexOf(this);
    if (index < 0) return;
    if (node.parentNode) node.remove();
    node.parentNode = this.parentNode;
    siblings.splice(index, 0, node);
  }
  set textContent(value) { this._textContent = String(value ?? ''); this._innerHTML = ''; this.children = []; }
  get textContent() {
    if (this._textContent) return this._textContent;
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return this._innerHTML.replace(/<[^>]*>/g, '');
  }
  set innerHTML(value) { this._innerHTML = String(value ?? ''); this._textContent = ''; this.children = []; }
  get innerHTML() { return this._innerHTML; }
  setAttribute(name, value) { this.attributes[String(name)] = String(value); }
  addEventListener() {}
  focus() {}
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const wanted = String(selector || '');
    const classNames = [...wanted.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    const rawDataName = (wanted.match(/\[data-([\w-]+)\]/) || [])[1];
    const dataName = rawDataName && rawDataName.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const tag = wanted.match(/^([a-z][\w-]*)/i)?.[1]?.toUpperCase() || '';
    const matches = node => (!tag || node.tagName === tag)
      && classNames.every(name => node.classList.contains(name))
      && (!dataName || Object.prototype.hasOwnProperty.call(node.dataset, dataName));
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (matches(child)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

class FakeDocument {
  createElement(tag) { return new FakeElement(tag); }
  getElementById() { return null; }
  querySelectorAll() { return []; }
}

function makeContext(extra = {}) {
  const document = new FakeDocument();
  return {
    document,
    localStorage: { getItem() { return null; }, setItem() {} },
    console,
    state: { rawEvents: [] },
    ...extra,
  };
}

function loadNamedFunction(source, name, extra = {}) {
  const context = makeContext(extra);
  const stripped = source
    .replace(/^import[^\r\n]*[\r\n]?/gm, '')
    .replace(/export function /g, 'function ');
  vm.runInNewContext(`${stripped}\nthis.__loaded = ${name};`, context, { filename: name + '.js' });
  return { fn: context.__loaded, context };
}

function t(key, params = {}) {
  const values = {
    'plan.awaitingApproval': 'WAITING_APPROVAL',
    'plan.card.heading': `${params.engine || 'engine'} proposed plan`,
    'plan.card.notePlaceholder': 'feedback',
    'plan.card.approveWithNote': 'approve with note',
    'plan.card.approve': 'approve',
    'plan.card.amend': 'amend',
    'plan.card.reject': 'reject',
    'plan.kimiSnapshot.heading': 'Kimi plan snapshot (read-only)',
    'plan.kimiSnapshot.path': `Source: ${params.path || ''}`,
    'narrative.status.snapshot': 'Read-only snapshot',
    'narrative.status.removed': 'Removed',
    'narrative.status.updated': 'Updated',
    'chat.planSegment': 'Execution plan',
    'status.running': 'Running',
    'status.done': 'Done',
    'status.error': 'Error',
  };
  return values[key] || key;
}

function loadToolRuntime() {
  const hints = [];
  let apiCalls = 0;
  let decideCalls = 0;
  let markdownCalls = 0;
  const loaded = loadNamedFunction(toolSource, 'createToolRuntimeDomain', {
    api: async () => { apiCalls += 1; return { ok: true }; },
    $: () => null,
    el: (tag, cls, text) => {
      const node = new FakeElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    },
    escapeHtml: value => String(value),
    toast() {},
    t,
  });
  const runtime = loaded.fn({
    decidePlan: async () => { decideCalls += 1; return { ok: true }; },
    setComposerHint: value => hints.push(value),
    engineLabel: () => 'Kimi Code',
    renderMarkdown: value => {
      markdownCalls += 1;
      const escaped = String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
      return `<p>${escaped}</p>`;
    },
    highlightIn() {},
    sealLiveTextSegment() {},
    maybeScrollToBottom() {},
  });
  return { runtime, hints, get apiCalls() { return apiCalls; }, get decideCalls() { return decideCalls; }, get markdownCalls() { return markdownCalls; } };
}

function staticRenderer() {
  let markdownCalls = 0;
  const loaded = loadNamedFunction(staticSource, 'createChatStaticRenderer', {
    el: (tag, cls, text) => {
      const node = new FakeElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    },
    highlightIn() {},
    messageShell: () => {
      const row = new FakeElement('div');
      const main = new FakeElement('div');
      row.append(main);
      return { row, main };
    },
    metaFromMessage: () => null,
    msgActions: () => new FakeElement('div'),
    normalizeTurnSegments: message => message.segments || [],
    renderMarkdown: value => {
      markdownCalls += 1;
      const escaped = String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
      return `<p>${escaped}</p>`;
    },
    t,
    tCount: (key, count) => `${key}:${count}`,
    buildNarrativeSteerSegment: text => new FakeElement('div'),
    buildStaticToolGroup: () => null,
    icon: () => new FakeElement('span'),
    thinkingPanel: () => ({ d: new FakeElement('details') }),
    toolCard: () => ({ d: new FakeElement('details') }),
    turnArtifactChips: () => null,
    turnSummaryCard: () => new FakeElement('div'),
    turnToolAnchorId: () => 'turn-tool-test',
    usageLine: () => new FakeElement('div'),
    wrapPreWithCopy: node => node,
  });
  return { renderer: loaded.fn(loaded.context), get markdownCalls() { return markdownCalls; } };
}

function planCard(host) { return host.querySelector('.kimi-plan-snapshot'); }

// Source-level contract gates: the new event is routed separately, while the classic waiter remains present.
assert.match(streamSource, /case 'kimi_plan_snapshot'/);
assert.match(toolSource, /evt && evt\.type === 'kimi_plan_snapshot'/);
assert.match(toolSource, /setComposerHint\(t\('plan\.awaitingApproval'\)\)/);
assert.match(navigationSource, /state\.config\?\.agentCliType === 'kimi' \? \['', 'low', 'medium', 'high', 'max'\]/);
assert.doesNotMatch(navigationSource, /agentCliType === 'kimi'[^\n]*off/);
for (const key of ['plan.kimiSnapshot.heading', 'plan.kimiSnapshot.path', 'narrative.status.snapshot', 'narrative.status.removed']) {
  assert.ok(zh[key] && en[key], `locale key ${key}`);
}

// Live Kimi ACP snapshots are read-only, update in place, and never touch the plan decision endpoint/hint.
const liveTest = loadToolRuntime();
const liveHost = new FakeElement('div');
const live = { bubble: null, bufferText: '' };
liveTest.runtime.handlePlanEvent({
  type: 'kimi_plan_snapshot', planId: 'kimi-plan-1', markdown: '**draft**', path: 'C:\\workspace\\plan.md', status: 'active', source: 'kimi-acp',
}, liveHost, live);
const firstLiveCard = planCard(liveHost);
assert.ok(firstLiveCard, 'live snapshot card renders');
assert.strictEqual(firstLiveCard.querySelectorAll('button').length, 0, 'live snapshot has no approval buttons');
assert.strictEqual(liveTest.hints.length, 0, 'live snapshot does not set composer approval hint');
assert.strictEqual(liveTest.apiCalls, 0, 'live snapshot does not call an API');
assert.strictEqual(liveTest.decideCalls, 0, 'live snapshot does not call decidePlan');

liveTest.runtime.handlePlanEvent({
  type: 'kimi_plan_snapshot', planId: 'kimi-plan-1', markdown: 'updated plan', path: 'C:\\workspace\\plan-v2.md', status: 'active', source: 'kimi-acp',
}, liveHost, live);
assert.strictEqual(liveHost.querySelectorAll('.kimi-plan-snapshot').length, 1, 'same live planId does not stack');
assert.strictEqual(planCard(liveHost), firstLiveCard, 'same live planId updates the existing card');
assert.match(firstLiveCard.querySelector('.plan-card-body').innerHTML, /updated plan/);

liveTest.runtime.handlePlanEvent({
  type: 'kimi_plan_snapshot', planId: 'kimi-plan-1', status: 'removed', source: 'kimi-acp',
}, liveHost, live);
assert.strictEqual(firstLiveCard.dataset.status, 'removed', 'live removal updates status in place');
assert.match(firstLiveCard.querySelector('.kimi-plan-snapshot-status').className, /state-removed/);
assert.strictEqual(firstLiveCard.querySelectorAll('button').length, 0, 'removed live snapshot remains non-interactive');
assert.match(firstLiveCard.querySelector('.plan-card-body').innerHTML, /updated plan/, 'removed event without markdown preserves live snapshot');
assert.match(firstLiveCard.querySelector('.kimi-plan-snapshot-path').textContent, /plan-v2\.md/, 'removed event without path preserves live path');

const malicious = '<script>alert(1)</script><img src=x onerror=alert(2)>';
liveTest.runtime.handlePlanEvent({
  type: 'kimi_plan_snapshot', planId: 'kimi-plan-malicious', markdown: malicious, status: 'active', source: 'kimi-acp',
}, liveHost, live);
const maliciousLiveCard = liveHost.querySelectorAll('.kimi-plan-snapshot')[1];
assert.doesNotMatch(maliciousLiveCard.querySelector('.plan-card-body').innerHTML, /<script|<img/i, 'live snapshot uses safe Markdown renderer for HTML input');

const huge = 'x'.repeat(48_001);
liveTest.runtime.handlePlanEvent({
  type: 'kimi_plan_snapshot', planId: 'kimi-plan-large', markdown: huge, status: 'active', source: 'kimi-acp',
}, liveHost, live);
const largeLiveCard = liveHost.querySelectorAll('.kimi-plan-snapshot')[2];
assert.ok(largeLiveCard.querySelector('.plan-card-body').classList.contains('plain'), 'live large snapshot uses plain-text fallback');
assert.strictEqual(largeLiveCard.querySelector('.plan-card-body').textContent.length, huge.length, 'live large snapshot is bounded away from markdown parser');

// The classic provider/Claude plan remains an approval card with its existing waiter hint.
const classicHost = new FakeElement('div');
liveTest.runtime.handlePlanEvent({ type: 'plan', planId: 'classic-1', markdown: 'PLAN: approve me' }, classicHost, null);
assert.strictEqual(classicHost.querySelectorAll('.plan-card-foot').length, 1, 'classic plan keeps approval controls');
assert.ok(liveTest.hints.includes('WAITING_APPROVAL'), 'classic plan keeps approval hint');

const sameIdApprovalHost = new FakeElement('div');
liveTest.runtime.handlePlanEvent({ type: 'plan', planId: 'kimi-plan-1', markdown: 'ExitPlanMode approval' }, sameIdApprovalHost, null);
assert.strictEqual(sameIdApprovalHost.querySelectorAll('.plan-card-foot').length, 1, 'snapshot does not use renderedPlanIds to block true approval');

// Static replay accepts persisted readOnly Kimi segments, replaces duplicate snapshots, and never marks them pending.
const staticTest = staticRenderer();
const message = {
  role: 'assistant',
  content: '',
  segments: [
    { type: 'text', text: 'before' },
    { type: 'plan', planId: 'kimi-plan-static', markdown: 'v1', status: 'snapshot', readOnly: true, source: 'kimi-acp', path: 'plan.md' },
    { type: 'plan', planId: 'kimi-plan-static', markdown: 'v2', status: 'snapshot', readOnly: true, source: 'kimi-acp', path: 'plan-v2.md' },
    { type: 'plan', planId: 'kimi-plan-static', status: 'removed', readOnly: true, source: 'kimi-acp' },
  ],
};
const row = staticTest.renderer.renderStaticMessage(message, 'message-1', 'sig-1');
const staticCard = planCard(row);
assert.ok(staticCard, 'static replay renders Kimi snapshot card');
assert.strictEqual(row.querySelectorAll('.kimi-plan-snapshot').length, 1, 'static duplicate planId does not stack');
assert.strictEqual(staticCard.dataset.status, 'removed', 'static replay applies removed state');
assert.match(staticCard.querySelector('.narrative-state-pill').className, /state-removed/);
assert.strictEqual(staticCard.querySelectorAll('button').length, 0, 'static snapshot has no approval buttons');
assert.doesNotMatch(staticCard.querySelector('.narrative-state-pill').textContent, /pending|await/i);
assert.match(staticCard.querySelector('.plan-card-body').innerHTML, /v2/, 'static removal without markdown preserves snapshot');
assert.match(staticCard.querySelector('.kimi-plan-snapshot-path').textContent, /plan-v2\.md/, 'static removal without path preserves path');

const staticLargeRow = staticTest.renderer.renderStaticMessage({
  role: 'assistant',
  segments: [{ type: 'plan', planId: 'kimi-plan-large-static', markdown: huge, status: 'snapshot', readOnly: true, source: 'kimi-acp' }],
}, 'message-2', 'sig-2');
const staticLargeBody = planCard(staticLargeRow).querySelector('.plan-card-body');
assert.ok(staticLargeBody.classList.contains('plain'), 'static large snapshot uses plain-text fallback');
assert.strictEqual(staticLargeBody.textContent.length, huge.length, 'static large snapshot preserves bounded raw text');

console.log('KIMI PLAN UI STATIC E2E: ALL PASS');
