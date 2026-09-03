#!/usr/bin/env node
'use strict';
// 静态锁 + DOM 桩行为件(第109波 109a):Mermaid 渲染链路与降级契约。
//
// 断言四个方向:
//   ① 懒加载契约:js/mermaid-runtime.js 导出四个名字、只从本源 /vendor/mermaid.min.js 取库、
//      securityLevel 恒为 'strict'、模块内零 CDN/外链字符串、从不调用 bindFunctions(click 指令不接线)。
//   ② 分流契约:chat-render-primitives.js 在 highlightIn() 同一趟里把 code.language-mermaid 交给运行时,
//      并把它排除在 hljs 之外;组合根 app.js 注入真实实现。
//   ③ 载荷/合规:index.html 无静态 mermaid script 标签、CSP script-src 仍只有 'self' 'unsafe-inline';
//      THIRD-PARTY-NOTICES.md 有 mermaid 行。
//   ④ 行为(纯 DOM 桩,不需要浏览器/服务/vendor 文件):
//      缺库 -> 代码块原样保留 + 一行提示;有库 -> SVG 就位、源码收起、工具条四个按钮;
//      同源码重复调用命中哈希缓存,mermaid.render 只跑一次。
//
// 判定行:`MERMAID RENDER STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const runtimeRel = 'ruyi-workbench/app/public/js/mermaid-runtime.js';
const runtimePath = path.join(ROOT, runtimeRel);

// ═══════════ ① 懒加载契约 ═══════════
ok(fs.existsSync(runtimePath), 'A1 js/mermaid-runtime.js 存在');
const runtime = fs.readFileSync(runtimePath, 'utf8');
for (const name of ['ensureMermaid', 'renderMermaidBlocks', 'mermaidSourceHash', 'mermaidThemeFor']) {
  ok(new RegExp(`export (?:async )?function ${name}\\b`).test(runtime), `A2 运行时导出 ${name}()`);
}
ok(runtime.includes("securityLevel: 'strict'"), "A3 mermaid.initialize 恒用 securityLevel: 'strict'");
ok(runtime.includes('startOnLoad: false'), 'A4 startOnLoad:false(禁止 mermaid 自行扫描全页)');
ok(runtime.includes("MERMAID_SCRIPT_SRC = '/vendor/mermaid.min.js'"), 'A5 懒加载路径写死本源 /vendor/mermaid.min.js');
ok(/MERMAID_LOAD_TIMEOUT_MS = 8000/.test(runtime), 'A6 加载超时 8s(超时按缺库降级)');
ok(!/https?:\/\//.test(runtime) && !/cdn\./.test(runtime) && !/unpkg|jsdelivr/.test(runtime),
  'A7 运行时模块零外链字符串(无 http(s):// / cdn. / unpkg / jsdelivr)');
// 只禁调用点(`bindFunctions(` / `.bindFunctions`),模块注释里说明「从不调用」是允许的。
ok(!/bindFunctions\s*[(.]/.test(runtime) && !/\.\s*bindFunctions/.test(runtime),
  'A8 从不调用 bindFunctions(mermaid click 指令永不接线)');
ok(/loadPromise/.test(runtime) && /if \(loadPromise\) return loadPromise;/.test(runtime),
  'A9 单飞加载:失败结果同样被缓存,不产生重试风暴');
ok(runtime.includes('data.mermaidHash === hash') && runtime.includes('mermaidTheme'),
  'A10 按「源码哈希 + 主题」缓存,流式重绘不重跑 mermaid');

// ═══════════ ② 分流契约 ═══════════
const primitives = read('ruyi-workbench/app/public/js/chat-render-primitives.js');
const appJs = read('ruyi-workbench/app/public/app.js');
ok(/renderMermaidBlocks = \(\) => Promise\.resolve\(0\),/.test(primitives),
  'B1 chat-render-primitives 从 deps 取 renderMermaidBlocks(缺省安全空实现)');
ok(/renderMermaidBlocks\(container, \{ t, toast \}\)/.test(primitives),
  'B2 highlightIn() 同一趟调用 renderMermaidBlocks(container)');
ok(primitives.includes("!(block.classList && block.classList.contains('language-mermaid'))"),
  'B3 hljs 明确跳过 code.language-mermaid');
ok(appJs.includes("import { renderMermaidBlocks } from './js/mermaid-runtime.js';"),
  'B4 组合根 app.js 导入 mermaid 运行时');
ok(appJs.includes('renderMermaidBlocks: (...args) => renderMermaidBlocks(...args),'),
  'B5 组合根把真实实现注入 chat-render-primitives');

// ═══════════ ③ 载荷 / 合规 ═══════════
const html = read('ruyi-workbench/app/public/index.html');
ok(!/<script[^>]*mermaid/i.test(html), 'C1 index.html 无静态 mermaid script 标签(只走懒注入)');
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const scriptSrc = ((csp.match(/script-src ([^;]+)/) || [])[1] || '').trim();
ok(scriptSrc === "'self' 'unsafe-inline'", `C2 CSP script-src 未放宽(实际: ${scriptSrc || '(缺失)'})`);
ok(/img-src [^;]*blob:/.test(csp), 'C3 CSP img-src 含 blob:(PNG 导出的 SVG->canvas 链路可用)');
const notices = read('THIRD-PARTY-NOTICES.md');
ok(/\|\s*mermaid\s*\|/.test(notices) && notices.includes('mermaid-js/mermaid') && /\|\s*MIT\s*\|/.test(notices),
  'C4 THIRD-PARTY-NOTICES 有 mermaid 行(MIT + 上游地址)');
ok(notices.includes('mermaid.min.js'), 'C5 通知条目点名 mermaid.min.js 文件');
const overlay = read('ruyi-workbench/tools/build-overlay.js');
ok(overlay.includes("'app/public/js/mermaid-runtime.js'"), 'C6 运行时模块进入 overlay 载荷');
ok(overlay.includes("'app/public/vendor/mermaid.min.js'"), 'C7 可选 vendor 登记在 OPTIONAL_PAYLOAD_FILES');
const narrativeCss = fs.readFileSync(path.join(PUBLIC, 'css', 'views', 'chat-narrative.css'), 'utf8');
for (const selector of ['.mermaid-block', '.mermaid-view', '.mermaid-tools', '.mermaid-hint']) {
  ok(narrativeCss.includes(selector), `C8 chat-narrative.css 含 ${selector} 样式`);
}
const zh = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'en-US.json'), 'utf8'));
for (const key of ['mermaid.fallbackHint', 'mermaid.renderFailed', 'mermaid.toggleSource',
  'mermaid.exportSvg', 'mermaid.exportPng', 'mermaid.exportFailed', 'mermaid.diagramAria']) {
  ok(typeof zh[key] === 'string' && typeof en[key] === 'string', `C9 双语目录含 ${key}`);
}

// ═══════════ ④ DOM 桩行为 ═══════════
class FakeClassList {
  constructor(owner) { this.owner = owner; this.values = new Set(); }
  add(...names) { for (const name of names) if (name) this.values.add(String(name)); this.sync(); }
  remove(...names) { for (const name of names) this.values.delete(String(name)); this.sync(); }
  contains(name) { return this.values.has(String(name)); }
  toggle(name, force) {
    const next = force === undefined ? !this.values.has(String(name)) : Boolean(force);
    if (next) this.values.add(String(name)); else this.values.delete(String(name));
    this.sync();
    return next;
  }
  setFrom(value) { this.values = new Set(String(value || '').split(/\s+/).filter(Boolean)); this.sync(); }
  sync() { this.owner._className = [...this.values].join(' '); }
}

class FakeElement {
  constructor(tag, doc) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.children = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attributes = {};
    this._className = '';
    this.classList = new FakeClassList(this);
    this._textContent = '';
    this._innerHTML = '';
    this.hidden = false;
    this.listeners = {};
  }
  get parentElement() { return this.parentNode; }
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
  insertBefore(node, ref) {
    const index = ref ? this.children.indexOf(ref) : -1;
    if (node.parentNode) node.remove();
    node.parentNode = this;
    if (index < 0) this.children.push(node); else this.children.splice(index, 0, node);
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
    this.parentNode.insertBefore(node, this);
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
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const wanted = String(selector || '');
    const classNames = [...wanted.matchAll(/\.([\w-]+)/g)].map(match => match[1]);
    const tag = (wanted.match(/^([a-z][\w-]*)/i) || [])[1];
    const tagName = tag ? tag.toUpperCase() : '';
    const matches = node => (!tagName || node.tagName === tagName)
      && classNames.every(name => node.classList.contains(name));
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
  constructor() {
    this.documentElement = new FakeElement('html', this);
    this.documentElement.setAttribute('data-theme', 'dark');
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
  }
  createElement(tag) { return new FakeElement(tag, this); }
}

const SOURCE = 'graph TD; A-->B';
const COPY = {
  'mermaid.fallbackHint': zh['mermaid.fallbackHint'],
  'mermaid.renderFailed': zh['mermaid.renderFailed'],
  'mermaid.toggleSource': zh['mermaid.toggleSource'],
  'mermaid.exportSvg': zh['mermaid.exportSvg'],
  'mermaid.exportPng': zh['mermaid.exportPng'],
  'mermaid.exportFailed': zh['mermaid.exportFailed'],
  'mermaid.diagramAria': zh['mermaid.diagramAria'],
  'common.copy': zh['common.copy'],
  'toast.copyCode': zh['toast.copyCode'],
};
const t = key => COPY[key] || key;

function buildContainer(doc, source = SOURCE) {
  const container = doc.createElement('div');
  const pre = doc.createElement('pre');
  const code = doc.createElement('code');
  code.className = 'language-mermaid';
  code.textContent = source;
  pre.appendChild(code);
  container.appendChild(pre);
  return { container, pre, code };
}

(async () => {
  const source = fs.readFileSync(runtimePath, 'utf8');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

  // 纯函数
  ok(mod.mermaidThemeFor(true) === 'dark' && mod.mermaidThemeFor(false) === 'default',
    'D1 mermaidThemeFor 亮暗映射(dark/default)');
  ok(mod.mermaidSourceHash(SOURCE) === mod.mermaidSourceHash(SOURCE)
    && mod.mermaidSourceHash(SOURCE) !== mod.mermaidSourceHash(SOURCE + ' '),
    'D2 mermaidSourceHash 稳定且对源码变化敏感');

  // (a) 缺库(vendor 文件不存在):代码块原样保留 + 一行提示。
  const docA = new FakeDocument();
  const a = buildContainer(docA);
  const renderedA = await mod.renderMermaidBlocks(a.container, { t, ensure: async () => null });
  const wrapperA = a.pre.parentElement;
  ok(renderedA === 0, 'D3 缺库时渲染计数为 0');
  ok(wrapperA && wrapperA.classList.contains('mermaid-block'), 'D4 缺库时仍建立 .mermaid-block 包裹节点');
  ok(a.code.textContent === SOURCE && a.pre.hidden === false, 'D5 缺库时原代码块内容与可见性不变');
  ok(wrapperA.querySelectorAll('.mermaid-view').length === 0, 'D6 缺库时不插入任何 SVG 视图');
  const hints = wrapperA.querySelectorAll('.mermaid-hint');
  ok(hints.length === 1 && hints[0].textContent === zh['mermaid.fallbackHint'], 'D7 缺库时补一行降级提示');
  ok(wrapperA.dataset.mermaidState === 'fallback', 'D8 缺库时状态标记为 fallback');

  // (b) 有库:SVG 就位、源码收起、工具条四个按钮。
  const docB = new FakeDocument();
  const b = buildContainer(docB);
  let renderCalls = 0;
  let initCalls = 0;
  const stub = {
    initialize() { initCalls += 1; },
    render: async () => { renderCalls += 1; return { svg: '<svg data-stub="1"></svg>' }; },
  };
  const renderedB = await mod.renderMermaidBlocks(b.container, { t, ensure: async () => stub });
  const wrapperB = b.pre.parentElement;
  ok(renderedB === 1 && renderCalls === 1 && initCalls === 1, 'D9 有库时渲染一次并初始化一次');
  const views = wrapperB.querySelectorAll('.mermaid-view');
  ok(views.length === 1 && views[0].innerHTML.includes('data-stub="1"'), 'D10 SVG 落入 .mermaid-view');
  ok(views[0].getAttribute('aria-label') === zh['mermaid.diagramAria'], 'D11 图表视图带无障碍标签');
  ok(b.pre.hidden === true && b.pre.classList.contains('mermaid-source-hidden'), 'D12 成功渲染后源码块收起');
  ok(wrapperB.querySelectorAll('.mermaid-hint').length === 0, 'D13 成功渲染后不显示降级提示');
  const bars = wrapperB.querySelectorAll('.mermaid-tools');
  ok(bars.length === 1, 'D14 工具条唯一');
  const buttons = bars[0].children;
  ok(buttons.length === 4, `D15 工具条四个按钮(实际 ${buttons.length})`);
  ok(buttons.map(node => node.textContent).join('|')
    === [zh['mermaid.toggleSource'], zh['common.copy'], zh['mermaid.exportSvg'], zh['mermaid.exportPng']].join('|'),
    'D16 按钮依次为 源码 / 复制 / 导出 SVG / 导出 PNG');
  ok(buttons.every(node => node.classList.contains('copy-code') && node.classList.contains('mermaid-btn')),
    'D17 按钮复用既有 .copy-code 样式类');
  ok(wrapperB.dataset.mermaidState === 'ok' && wrapperB.dataset.mermaidHash === mod.mermaidSourceHash(SOURCE),
    'D18 成功态记录源码哈希');
  // 真机走查抓到的回归:同一按钮同时挂 onclick 与 addEventListener('click') 时,一次点击会跑两遍回调,
  // 「源码」开关按下即弹回。锁住「每个按钮只有一处点击绑定」。
  ok(buttons.every(node => typeof node.onclick === 'function' && !(node.listeners.click || []).length),
    'D19 工具条按钮只挂一处点击回调(一次点击只触发一次)');
  // 「源码」按钮把原代码块切回可见,再按一次收起。
  buttons[0].onclick();
  ok(b.pre.hidden === false && b.code.textContent === SOURCE, 'D19b 「源码」按钮切回原始代码块');
  buttons[0].onclick();
  ok(b.pre.hidden === true, 'D19c 再按一次重新收起源码');

  // (c) 同源码重复调用命中缓存,mermaid.render 不重跑。
  const renderedAgain = await mod.renderMermaidBlocks(b.container, { t, ensure: async () => stub });
  ok(renderedAgain === 0 && renderCalls === 1, 'D20 同源码重复渲染命中哈希缓存(render 仍只跑一次)');

  // (d) 源码变化则重渲染(流式封段后正文变化的路径)。
  b.code.textContent = 'graph LR; X-->Y';
  const renderedChanged = await mod.renderMermaidBlocks(b.container, { t, ensure: async () => stub });
  ok(renderedChanged === 1 && renderCalls === 2, 'D21 源码变化时重新渲染');

  // (e) 渲染抛错 -> 降级为代码块 + 失败提示,不抛出到调用方。
  const docC = new FakeDocument();
  const c = buildContainer(docC, 'graph TD; broken');
  const boom = { initialize() {}, render: async () => { throw new Error('bad syntax'); } };
  const renderedC = await mod.renderMermaidBlocks(c.container, { t, ensure: async () => boom });
  const wrapperC = c.pre.parentElement;
  ok(renderedC === 0 && wrapperC.dataset.mermaidState === 'fallback', 'D22 渲染失败时降级不抛错');
  ok(wrapperC.querySelectorAll('.mermaid-hint')[0].textContent === zh['mermaid.renderFailed'],
    'D23 渲染失败提示与缺库提示区分');

  // (f) 容器内无 mermaid 围栏时零副作用。
  const docD = new FakeDocument();
  const plain = docD.createElement('div');
  const plainPre = docD.createElement('pre');
  const plainCode = docD.createElement('code');
  plainCode.className = 'language-js';
  plainCode.textContent = 'const a = 1;';
  plainPre.appendChild(plainCode);
  plain.appendChild(plainPre);
  let touched = false;
  await mod.renderMermaidBlocks(plain, { t, ensure: async () => { touched = true; return stub; } });
  ok(!touched && plainPre.parentElement === plain, 'D24 无 mermaid 围栏时不加载库、不改 DOM');

  console.log('\nMERMAID RENDER STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error('MERMAID RENDER STATIC E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
