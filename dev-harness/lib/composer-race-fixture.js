'use strict';
// 直跑完整 chat runtime 的轻量 DOM 桩。发送请求由测试控制，不启动 provider 或后台服务。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The attachment tray re-exports this production image state function.
function imageBindings(state, api = async () => { throw Error('unexpected image API'); }) {
  const file = path.resolve(__dirname, '../../ruyi-workbench/app/public/js/protected-image-state.js');
  const source = fs.readFileSync(file, 'utf8');
  const imports = source.match(/^import .*;$/gm) || [];
  const expected = ["import { state } from './state.js';", "import { api, apiRaw } from './net.js';", "import { t } from './i18n.js';"];
  if (JSON.stringify(imports.map(line => line.trim())) !== JSON.stringify(expected)) throw Error('image state imports changed');
  const tray = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/attachment-tray.js'), 'utf8');
  if (!tray.includes("export { prepareProtectedImages } from './protected-image-state.js';")) throw Error('image re-export changed');
  const context = vm.createContext({ state, api, apiRaw: api, t: key => key, AbortController, URL, TextEncoder, crypto: require('node:crypto').webcrypto });
  const script = source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  return vm.runInContext(script + '\n({ prepareProtectedImages, invalidateImageOperations })', context);
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ imageApi } = {}) {
  class Element {
    constructor() { this.value = ''; this.children = []; this.dataset = {}; this.style = {}; this.events = []; this.isConnected = true; this.classList = { add() {}, remove() {}, toggle() {} }; }
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.append(item); return item; }
    replaceChildren(...items) { this.children = items; }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    addEventListener() {}
    setAttribute() {}
    dispatchEvent(event) { this.events.push({ type: event.type, text: event.detail.text, before: this.value, bubbles: event.bubbles }); }
    focus() {}
  }
  const nodes = { promptInput: new Element(), messages: new Element(), sendBtn: new Element(), steerDeliveryMode: new Element(), composerHint: new Element() };
  const state = { currentSession: { id: 'A', messages: [] }, config: {}, attachments: [], streaming: false, sessionRelay: { sessionId: 'A', channel: 'steer', live: true } };
  const calls = [], streams = [], toasts = [], rows = [], store = new Map();
  const win = {};
  const context = {
    document: { activeElement: null, querySelector: () => null, createTextNode: () => new Element() }, window: win,
    CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    localStorage: { removeItem: key => store.delete(key) },
    AbortController, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: (url, options) => { streams.push({ url, body: JSON.parse(options.body) }); return new Promise(() => {}); },
    prepareProtectedImages: imageBindings(state, imageApi).prepareProtectedImages,
  };
  const source = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/chat-stream-runtime.js'), 'utf8');
  const importLine = "import { prepareProtectedImages } from './attachment-tray.js';";
  if (!source.includes(importLine)) throw Error('image preparation import changed');
  const create = vm.runInNewContext(source.replace(importLine, '').replace(/^export /gm, '') + '\ncreateChatStreamRuntime', context);
  const fx = { state, nodes, calls, streams, toasts, rows, store, seq: 0, response: deferred(), preflight: null, creation: null, win };
  fx.choose = id => { fx.seq += 1; state.currentSession = id ? { id, messages: [] } : null; state.sessionRelay = null; fx.runtime.steerPendingList.length = 0; fx.runtime.steeredSeen.length = 0; };
  fx.runtime = create({
    state, $: id => nodes[id] || null, sessionSelectionSeq: () => fx.seq,
    t: key => key, toast: (...args) => toasts.push(args), apiErrText: error => String(error?.message || error),
    api: (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return fx.response.promise; },
    syncContextWindowManual: () => fx.preflight ? fx.preflight.promise : Promise.resolve(),
    newSession: () => fx.creation.promise,
    el: () => new Element(), autoGrow() {}, isProviderMode: () => true,
    agentCliMeta: () => ({ id: 'claude' }), currentEngineMeta: () => ({}), currentWorkspace: () => '',
    iconTextBtn() {}, authHeaders: () => ({}), updateJumpLatest() {}, renderSessions() {}, renderAttachments() {}, scrollMessagesToBottom() {}, maybeScrollToBottom() {}, compactNarrativeProcessRuns() {},
    messageShell: () => ({ row: new Element(), main: new Element() }),
    renderStaticMessage: message => { rows.push(message); return new Element(); },
  });
  fx.send = text => { nodes.promptInput.value = text; store.set('wcw.draft', text); return fx.runtime.sendPrompt(); };
  return fx;
}

module.exports = { fixture, deferred, imageBindings };
