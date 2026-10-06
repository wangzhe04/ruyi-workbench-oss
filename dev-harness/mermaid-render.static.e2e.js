#!/usr/bin/env node
'use strict';
// 静态锁 + DOM 桩行为件(第109波 109a):Mermaid 渲染链路与降级契约。
//
// 断言四个方向:
//   ① 懒加载契约:js/mermaid-runtime.js 导出那几个名字、只从本源 /vendor/mermaid.min.js 取库、
//      securityLevel 恒为 'strict'、模块内零 CDN/外链字符串、从不调用 bindFunctions(click 指令不接线)。
//   ② 分流契约:chat-render-primitives.js 在 highlightIn() 同一趟里把 code.language-mermaid 交给运行时,
//      并把它排除在 hljs 之外;组合根 app.js 注入真实实现。
//   ③ 载荷/合规:index.html 无静态 mermaid script 标签、CSP script-src 仍只有 'self' 'unsafe-inline';
//      THIRD-PARTY-NOTICES.md 有 mermaid 行。
//   ④ 行为(纯 DOM 桩,不需要浏览器/服务/vendor 文件):
//      缺库 -> 代码块原样保留 + 一行提示;有库 -> SVG 就位、源码收起、工具条四个按钮;
//      同源码重复调用命中哈希缓存,mermaid.render 只跑一次。
//   ⑤ 色板(2026-10-03 用户反馈「暗色下 mermaid 不好看」):两套都走 base 主题 + 显式 themeVariables,
//      锚点色与 css/themes/color-schemes.css 的 token 一致、全是十六进制(mermaid 只认这个)、
//      分类色压白字够对比;initialize 收到的就是这一套。真浏览器里的成色由 mermaid-viewer.browser.e2e.js 钉。
//
// 判定行:`MERMAID RENDER STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { bracedBlock } = require('./lib/source-slice.js');

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
for (const name of ['ensureMermaid', 'renderMermaidBlocks', 'mermaidSourceHash', 'mermaidThemeFor', 'mermaidThemeVariables', 'mermaidThemeCss']) {
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
ok(appJs.includes('renderMermaidBlocks: (container, opts) => renderMermaidBlocks(container, { ...opts, withLayoutChange: keepPinnedAcross }),'),
  'B5 组合根把真实实现注入 chat-render-primitives,并让每次换图都经聊天区的贴底守卫(keepPinnedAcross)');

// ═══════════ ③ 载荷 / 合规 ═══════════
const html = read('ruyi-workbench/app/public/index.html');
ok(!/<script[^>]*mermaid/i.test(html), 'C1 index.html 无静态 mermaid script 标签(只走懒注入)');
const csp = (html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1] || '';
const scriptSrc = ((csp.match(/script-src ([^;]+)/) || [])[1] || '').trim();
// 安全走查 S12(安全收紧,本条因此改判据):script-src 去掉了 'unsafe-inline',首屏预绘那段内联脚本改用 CSP 哈希放行(锁见
// inline-script-csp-hash.static.e2e.js)。原断言钉的是「恰好等于 'self' 'unsafe-inline'」;「未放宽」的意图不变,现在是:
// 只有 'self' 与 sha256 哈希,没有 unsafe-inline / unsafe-eval / 外域。
ok(/^'self'( 'sha256-[A-Za-z0-9+/=]+')+$/.test(scriptSrc), `C2 CSP script-src 未放宽(只有 'self' 与内联预绘的 sha256 哈希;实际: ${scriptSrc || '(缺失)'})`);
ok(/img-src [^;]*blob:/.test(csp), 'C3 CSP img-src 含 blob:(PNG 导出的 SVG->canvas 链路可用)');
const notices = read('THIRD-PARTY-NOTICES.md');
ok(/\|\s*mermaid\s*\|/.test(notices) && notices.includes('mermaid-js/mermaid') && /\|\s*MIT\s*\|/.test(notices),
  'C4 THIRD-PARTY-NOTICES 有 mermaid 行(MIT + 上游地址)');
ok(notices.includes('mermaid.min.js'), 'C5 通知条目点名 mermaid.min.js 文件');
// 架构还债批 3·D:载荷登记读打包器运行时的那两张表(require 零副作用),不再在源码里找字面量。
const overlayTables = require(path.join(ROOT, 'ruyi-workbench', 'tools', 'build-overlay.js'));
ok(overlayTables.PAYLOAD_FILES.includes('app/public/js/mermaid-runtime.js'), 'C6 运行时模块进入 overlay 载荷');
ok(['mermaid-source.js', 'mermaid-postprocess.js'].every(name => overlayTables.PAYLOAD_FILES.includes(`app/public/js/${name}`)),
  'C6b 109c 的源码预处理 / 画完收尾两个模块也进入 overlay 载荷(运行时静态 import 它们,缺一个整个图表运行时加载失败)');
ok(overlayTables.OPTIONAL_PAYLOAD_FILES.includes('app/public/vendor/mermaid.min.js'), 'C7 可选 vendor 登记在 OPTIONAL_PAYLOAD_FILES');
const narrativeCss = fs.readFileSync(path.join(PUBLIC, 'css', 'views', 'chat-narrative.css'), 'utf8');
for (const selector of ['.mermaid-block', '.mermaid-view', '.mermaid-tools', '.mermaid-hint']) {
  ok(narrativeCss.includes(selector), `C8 chat-narrative.css 含 ${selector} 样式`);
}
const zh = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'zh-CN.json'), 'utf8'));
const en = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', 'en-US.json'), 'utf8'));
for (const key of ['mermaid.fallbackHint', 'mermaid.renderFailed', 'mermaid.toggleSource',
  'mermaid.exportSvg', 'mermaid.exportPng', 'mermaid.exportFailed', 'mermaid.diagramAria',
  'mermaid.viewerOpen', 'mermaid.viewerHint', 'mermaid.viewerIn',
  'mermaid.viewerOut', 'mermaid.viewerFit', 'mermaid.viewerClose']) {
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
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    const doc = this.ownerDocument;
    return Boolean(doc) && (node === doc.body || node === doc.documentElement);
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
  constructor({ observable = false } = {}) {
    this.documentElement = new FakeElement('html', this);
    this.documentElement.setAttribute('data-theme', 'dark');
    this.head = new FakeElement('head', this);
    this.body = new FakeElement('body', this);
    // observable:带一个记下回调的 MutationObserver 桩,测试里改 data-theme 后手动 flip() 触发。
    this.observers = [];
    if (observable) {
      const doc = this;
      this.defaultView = {
        MutationObserver: class {
          constructor(callback) { this.callback = callback; }
          observe(target, options) { doc.observers.push({ target, options, callback: this.callback }); }
          disconnect() {}
        },
      };
    }
  }
  createElement(tag) { return new FakeElement(tag, this); }
  querySelectorAll(selector) { return this.body.querySelectorAll(selector); }
  flip(theme) {
    this.documentElement.setAttribute('data-theme', theme);
    for (const entry of this.observers) entry.callback([{ type: 'attributes', attributeName: 'data-theme' }]);
  }
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
  'mermaid.viewerOpen': zh['mermaid.viewerOpen'],
  'mermaid.viewerHint': zh['mermaid.viewerHint'],
  'mermaid.viewerIn': zh['mermaid.viewerIn'],
  'mermaid.viewerOut': zh['mermaid.viewerOut'],
  'mermaid.viewerFit': zh['mermaid.viewerFit'],
  'mermaid.viewerClose': zh['mermaid.viewerClose'],
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
  const mod = await import(require('url').pathToFileURL(runtimePath).href);

  // 纯函数
  ok(mod.mermaidThemeFor(true) === 'dark' && mod.mermaidThemeFor(false) === 'light',
    'D1 mermaidThemeFor 亮暗映射到本模块的色板键(dark/light)');

  // ⑤ 色板:锚点色对齐 token,全是十六进制,分类色压白字够对比。
  const schemes = read('ruyi-workbench/app/public/css/themes/color-schemes.css');
  const tokensOf = theme => {
    const block = bracedBlock(schemes, `:root[data-theme="${theme}"]`);
    const tokens = {};
    for (const match of block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\b/gi)) tokens[match[1]] = match[2].toLowerCase();
    return tokens;
  };
  const luminance = hex => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  for (const theme of ['dark', 'light']) {
    const tokens = tokensOf(theme);
    const vars = mod.mermaidThemeVariables(theme, 'X Font');
    ok(Object.keys(tokens).length > 10, `D1a ${theme}: 从 color-schemes.css 切到 token 块(${Object.keys(tokens).length} 个色值)`);
    const anchors = { background: 'panel-2', primaryTextColor: 'ink', textColor: 'ink-2', lineColor: 'muted', tertiaryBorderColor: 'line-2' };
    const drift = Object.entries(anchors).filter(([key, token]) => vars[key] !== tokens[token]);
    ok(drift.length === 0, `D1b ${theme}: 色板锚点与 token 一致(底=--panel-2、字=--ink/--ink-2、线=--muted)` + (drift.length ? ' → 漂移: ' + drift.map(([k, tk]) => `${k}=${vars[k]} vs --${tk}=${tokens[tk]}`).join(', ') : ''));
    ok(vars.darkMode === (theme === 'dark') && vars.fontFamily === 'X Font', `D1c ${theme}: darkMode 与字体随主题/参数走`);
    const nonHex = Object.entries(vars).filter(([key, value]) => typeof value === 'string' && !['fontFamily', 'pieOpacity', 'dropShadow'].includes(key) && !/^#[0-9a-f]{6}$/i.test(value));
    ok(nonHex.length === 0, `D1d ${theme}: 色值全是六位十六进制(mermaid 用 khroma 推导,不认 CSS 变量)` + (nonHex.length ? ' → ' + nonHex.map(([k, v]) => `${k}=${v}`).join(', ') : ''));
    ok(contrast(vars.primaryTextColor, vars.primaryColor) >= 7 && contrast(vars.textColor, vars.background) >= 4.5
      && contrast(vars.lineColor, vars.background) >= 3,
      `D1e ${theme}: 节点字/标签字/连线对底色的对比度够(${contrast(vars.primaryTextColor, vars.primaryColor).toFixed(1)} / ${contrast(vars.textColor, vars.background).toFixed(1)} / ${contrast(vars.lineColor, vars.background).toFixed(1)})`);
    ok(contrast(vars.taskTextColor, vars.taskBkgColor) >= 4.5 && contrast(vars.taskTextDarkColor, vars.doneTaskBkgColor) >= 4.5
      && contrast(vars.taskTextDarkColor, vars.activeTaskBkgColor) >= 4.5 && contrast(vars.taskTextDarkColor, vars.background) >= 4.5,
      `D1f ${theme}: 甘特图任务条上/条外的字都读得清(修前暗色下「已完成」是浅灰条配浅字)`);
    ok(vars.pie1 === mod.MERMAID_CATEGORICAL[0] && vars.cScale0 === mod.MERMAID_CATEGORICAL[0] && vars.git0 === mod.MERMAID_CATEGORICAL[0]
      && vars.xyChart && vars.xyChart.plotColorPalette === mod.MERMAID_CATEGORICAL.join(','),
      `D1g ${theme}: 饼图 / 分支 / gitGraph / xychart 共用同一组分类色(暗色下不再被 base 主题压成黑块)`);
    // 109c(2026-10-04 五路走查):base 主题不推导、默认给白底准备的那些图种变量也要给。
    ok(vars.gitInv0 && vars.gitInv0 !== vars.git0 && contrast(vars.gitInv0, vars.background) >= 3,
      `D1j ${theme}: gitGraph 的 HIGHLIGHT 提交标记显式给色,对图底 ≥ 3:1(修前 1.5~1.6:1;实得 ${vars.gitInv0 && contrast(vars.gitInv0, vars.background).toFixed(1)})`);
    ok(vars.venn1 === mod.MERMAID_CATEGORICAL[0] && vars.venn8 === mod.MERMAID_CATEGORICAL[7],
      `D1k ${theme}: 维恩图走分类色(修前 base 主题推导成主色压暗 30%,深底上近黑)`);
    ok(vars.packet && contrast(vars.packet.labelColor, vars.packet.blockFillColor) >= 4.5 && contrast(vars.packet.startByteColor, vars.background) >= 4.5
      && vars.treeView && contrast(vars.treeView.labelColor, vars.background) >= 4.5,
      `D1l ${theme}: 报文图 / 树状图的字色对各自底色 ≥ 4.5:1(修前暗色下是黑字)`);
    ok(vars.xyChart.legendTextColor === vars.textColor && vars.xyChart.dataLabelColor === vars.textColor,
      `D1m ${theme}: xychart 图例与数据标签用色板字色(修前回落成默认主题的 #131300)`);
    ok(/^#[0-9a-f]{6}$/i.test(vars.secondBkg || '') && /^#[0-9a-f]{6}$/i.test(vars.archGroupBorderColor || ''),
      `D1n ${theme}: 铁路图终结符底与架构图分组框显式给色`);
    const css = mod.mermaidThemeCss(theme);
    ok(css.includes(`.grid .tick line { stroke: ${vars.gridColor}; }`) && css.includes(`.lineWrapper line { stroke: ${vars.lineColor}; }`),
      `D1h ${theme}: themeCSS 把甘特网格线与时间线主轴改回色板线色`);
    ok(css.includes('.eventWrapper { filter: none; }') && css.includes(`.marker.zeroOrOne circle, .marker.zeroOrMore circle { fill: ${vars.background}; }`)
      && (theme === 'light') !== css.includes('text[fill="#444444"]'),
      `D1o ${theme}: themeCSS 补时间线事件框、ER 空心端点圈${theme === 'dark' ? '、C4 写死的 #444444' : ''}`);
  }
  const weak = mod.MERMAID_CATEGORICAL.filter(color => contrast('#ffffff', color) < 4);
  ok(mod.MERMAID_CATEGORICAL.length === 12 && weak.length === 0, `D1i 12 个分类色压白字对比度都 ≥ 4:1` + (weak.length ? ' → ' + weak.join(',') : ''));
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
  let initConfig = null;
  let hostWidth = '';
  const stub = {
    initialize(config) { initCalls += 1; initConfig = config; },
    render: async (id, text, host) => { renderCalls += 1; hostWidth = host && host.style ? host.style.width : ''; return { svg: '<svg data-stub="1"></svg>' }; },
  };
  const renderedB = await mod.renderMermaidBlocks(b.container, { t, ensure: async () => stub });
  const wrapperB = b.pre.parentElement;
  ok(renderedB === 1 && renderCalls === 1 && initCalls === 1, 'D9 有库时渲染一次并初始化一次');
  ok(Boolean(initConfig) && initConfig.theme === 'base' && initConfig.securityLevel === 'strict'
    && initConfig.themeVariables && initConfig.themeVariables.background === mod.mermaidThemeVariables('dark').background
    && initConfig.themeCSS === mod.mermaidThemeCss('dark'),
    'D9b initialize 收到 base 主题 + 暗色色板 + themeCSS(securityLevel 仍是 strict)');
  const secure = Array.isArray(initConfig && initConfig.secure) ? initConfig.secure : [];
  ok(['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges', 'theme', 'themeVariables', 'themeCSS']
    .every(key => secure.includes(key)),
    `D9d 图里的 %%{init}%% / frontmatter 改不动主题(secure 含 mermaid 默认六项 + theme/themeVariables/themeCSS;实得 ${secure.join(',')})`);
  ok(/^\d+px$/.test(hostWidth), `D9c 离屏渲染宿主有确定宽度(甘特图按它排版;修前不定宽,被排成一小条;实得 ${hostWidth || '(空)'})`);
  const views = wrapperB.querySelectorAll('.mermaid-view');
  ok(views.length === 1 && views[0].innerHTML.includes('data-stub="1"'), 'D10 SVG 落入 .mermaid-view');
  ok(views[0].getAttribute('aria-label') === zh['mermaid.diagramAria'], 'D11 图表视图带无障碍标签');
  ok(b.pre.hidden === true && b.pre.classList.contains('mermaid-source-hidden'), 'D12 成功渲染后源码块收起');
  ok(wrapperB.querySelectorAll('.mermaid-hint').length === 0, 'D13 成功渲染后不显示降级提示');
  const bars = wrapperB.querySelectorAll('.mermaid-tools');
  ok(bars.length === 1, 'D14 工具条唯一');
  const buttons = bars[0].children;
  ok(buttons.length === 5, `D15 工具条五个按钮(实际 ${buttons.length})`);
  ok(buttons.map(node => node.textContent).join('|')
    === [zh['mermaid.toggleSource'], zh['common.copy'], zh['mermaid.viewerOpen'], zh['mermaid.exportSvg'], zh['mermaid.exportPng']].join('|'),
    'D16 按钮依次为 源码 / 复制 / 放大 / 导出 SVG / 导出 PNG');
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

  // (b2) 放大查看(2026-09-22 用户反馈:大图在消息栏里看不全):灯箱开/关/单实例。
  ok(!docB.body.querySelector('.mermaid-lightbox'), 'D25a 未点放大前无灯箱');
  buttons[2].onclick();
  const lightbox = docB.body.querySelector('.mermaid-lightbox');
  ok(lightbox && lightbox.getAttribute('role') === 'dialog', 'D25b 「放大」按钮开出全屏灯箱(role=dialog)');
  const stage = lightbox.querySelector('.mermaid-lightbox-stage');
  ok(stage && stage.innerHTML.includes('data-stub="1"'), 'D25c 灯箱里是【同一份】已渲染 SVG');
  ok(/scale\(/.test(stage.style.transform || ''), 'D25d 开箱即按「适应窗口」落位(transform 含 scale)');
  const lightboxButtons = lightbox.querySelectorAll('.mermaid-lightbox-btn');
  ok(lightboxButtons.length === 4
    && lightboxButtons.map(node => node.textContent).join('|')
      === [zh['mermaid.viewerIn'], zh['mermaid.viewerOut'], zh['mermaid.viewerFit'], zh['mermaid.viewerClose']].join('|'),
    'D25e 灯箱控制条:放大 / 缩小 / 适应窗口 / 关闭');
  // 单实例:开着的时候再点一次「放大」= 重开,不是叠第二个。
  buttons[2].onclick();
  ok(docB.body.querySelectorAll('.mermaid-lightbox').length === 1, 'D25f 灯箱单实例(重开不叠)');
  // 「关闭」按钮退出。
  docB.body.querySelector('.mermaid-lightbox').querySelectorAll('.mermaid-lightbox-btn')[3].onclick();
  ok(!docB.body.querySelector('.mermaid-lightbox'), 'D25g 「关闭」按钮退出灯箱');
  // 点图本身与 Esc 是同一入口的另外两只手。
  views[0].onclick();
  ok(docB.body.querySelector('.mermaid-lightbox'), 'D26a 点图本身也能开出灯箱');
  const escHandlers = docB.body.querySelector('.mermaid-lightbox').listeners.keydown || [];
  ok(escHandlers.length > 0, 'D26b 灯箱挂了键盘监听');
  for (const handler of escHandlers) handler({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  ok(!docB.body.querySelector('.mermaid-lightbox'), 'D26c Esc 退出灯箱');

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

  // (e) 切亮暗(2026-10-03):桩 render 像真 mermaid 一样在异步几步之后才读全局配置,把读到的主题写进 SVG;
  //     看每张图的内容与标记是否最终都是当前主题。
  const settle = async doc => {
    for (let i = 0; i < 50; i++) {
      const chain = doc.__ruyiMermaidRetheme;
      await chain;
      await new Promise(resolve => setTimeout(resolve, 5));
      if (doc.__ruyiMermaidRetheme === chain) return;
    }
  };
  const themedStub = ({ failWhen } = {}) => {
    // 模块级 initialize 签名是全页一份:同签名不会再调 initialize,所以桩的「当前全局主题」从
    // 模块上一次初始化的主题起步(前面 (b) 是暗色)—— 与真 mermaid 的全局配置一致。
    let current = 'dark';
    const calls = [];
    return {
      calls,
      lib: {
        initialize(config) { current = config.themeVariables && config.themeVariables.darkMode ? 'dark' : 'light'; },
        render: async (id, text) => {
          calls.push(current);
          await new Promise(resolve => setTimeout(resolve, 15));
          const at = current;
          if (failWhen && failWhen(at)) throw new Error('boom');
          return { svg: `<svg data-drawn="${at}">${text}</svg>` };
        },
      },
    };
  };
  const drawnOf = block => (/data-drawn="(\w+)"/.exec((block.querySelectorAll('.mermaid-view')[0] || { innerHTML: '' }).innerHTML) || [])[1];
  const allMatch = (blocks, theme) => blocks.every(block => block.dataset.mermaidState === 'ok'
    && block.dataset.mermaidTheme === theme && drawnOf(block) === theme);
  const describe = blocks => blocks.map(block => `${block.dataset.mermaidTheme}/${drawnOf(block)}`).join(',');
  const midRender = async ({ early }) => {
    const doc = new FakeDocument({ observable: true });
    const stub = themedStub();
    if (early) {
      const first = buildContainer(doc, 'graph TD; G0-->H');
      doc.body.appendChild(first.container);
      await mod.renderMermaidBlocks(first.container, { t, ensure: async () => stub.lib });
    }
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    for (let i = 0; i < 3; i++) host.appendChild(buildContainer(doc, `graph TD; E${i}-->F`).container);
    const before = stub.calls.length;
    const run = mod.renderMermaidBlocks(host, { t, ensure: async () => stub.lib });
    while (stub.calls.length === before) await new Promise(resolve => setTimeout(resolve, 1));
    doc.flip('light');
    await run;
    await settle(doc);
    return { doc, blocks: doc.body.querySelectorAll('.mermaid-block') };
  };
  // ① 三张图还在画时切到浅色:切换那一刻它们还是 pending,重画队列看不见 —— 修前画完就停在暗色。
  const e1 = await midRender({ early: false });
  ok(e1.doc.observers.length === 1 && e1.doc.observers[0].options.attributeFilter.join() === 'data-theme',
    'D27a 首次渲染后挂上 <html data-theme> 的监听(只听这一个属性)');
  ok(e1.blocks.length === 3 && allMatch(e1.blocks, 'light'),
    'D27b 画到一半切主题:这一轮画完后按当前主题补画,标记与内容一致 → ' + describe(e1.blocks));
  // ② 另有一张早已画好的图在切换那一刻被重画队列接走,与那三张的渲染交错:两路 initialize 互相改全局配色,
  //    没有全页渲染队列时会出现「标着浅色、画成暗色」且再也不会被补画的块。
  const e2 = await midRender({ early: true });
  ok(e2.blocks.length === 4 && allMatch(e2.blocks, 'light'),
    'D27c 两路渲染交错(整页重绘 + 切主题重画):全页一条渲染队列,每块按自己的主题画 → ' + describe(e2.blocks));

  // (f) 换色重画:「源码」开着的仍开着;重画失败留着旧图,不降级成源码 + 报错。
  const docF = new FakeDocument({ observable: true });
  const f = buildContainer(docF, 'graph TD; P-->Q');
  docF.body.appendChild(f.container);
  let stubFFail = false;
  const stubF = themedStub({ failWhen: at => at === 'dark' && stubFFail });
  await mod.renderMermaidBlocks(f.container, { t, ensure: async () => stubF.lib });
  const wrapperF = f.pre.parentElement;
  wrapperF.querySelectorAll('.mermaid-tools')[0].children[0].onclick();
  ok(f.pre.hidden === false, 'D28a 前置:「源码」已打开');
  docF.flip('light');
  await settle(docF);
  const toggleF = wrapperF.querySelectorAll('.mermaid-tools')[0].children[0];
  ok(wrapperF.dataset.mermaidTheme === 'light' && wrapperF.querySelectorAll('.mermaid-view')[0].innerHTML.includes('data-drawn="light"')
    && f.pre.hidden === false && toggleF.getAttribute('aria-expanded') === 'true',
    'D28b 换色重画后「源码」仍开着(aria-expanded 同步),图已是新主题');
  stubFFail = true;
  docF.flip('dark');
  await settle(docF);
  const viewsF = wrapperF.querySelectorAll('.mermaid-view');
  ok(viewsF.length === 1 && viewsF[0].innerHTML.includes('data-drawn="light"') && wrapperF.dataset.mermaidState === 'ok'
    && wrapperF.querySelectorAll('.mermaid-hint').length === 0,
    'D28c 换色重画失败:留着旧图、状态仍是 ok、不出降级提示');

  // (g) 2026-10-04:每次把图 / 回落换上去都经宿主的 withLayoutChange(聊天区借它在块高变化前后保持贴底)。
  //     修前一条回复 8 张图画完,内容从 5.8k 涨到 10.2k px,没人重新贴底,视图停在半途。
  const docG = new FakeDocument({ observable: true });
  const g = doc => {
    const host = doc.createElement('div');
    for (const src of ['graph TD; G1-->H', 'graph TD; BAD', 'graph TD; G2-->H']) host.appendChild(buildContainer(doc, src).container);
    doc.body.appendChild(host);
    return host;
  };
  const hostG = g(docG);
  const seen = [];
  const stubG = { initialize() {}, render: async (id, text) => { if (/BAD/.test(text)) throw new Error('Parse error on line 1'); return { svg: '<svg></svg>' }; } };
  await mod.renderMermaidBlocks(hostG, {
    t, ensure: async () => stubG,
    withLayoutChange: mutate => {
      const states = () => hostG.querySelectorAll('.mermaid-block').map(block => block.dataset.mermaidState).join(',');
      const before = states();
      mutate();
      seen.push(`${before}→${states()}`);
    },
  });
  ok(seen.join(' | ') === 'pending,pending,pending→ok,pending,pending | ok,pending,pending→ok,fallback,pending | ok,fallback,pending→ok,fallback,ok',
    'D29a 三块(成 / 败 / 成)各经宿主包一次,DOM 改动发生在包裹之内 → ' + seen.join(' | '));
  docG.flip('light');
  await settle(docG);
  ok(seen.length === 5, `D29b 切主题重画的两块同样经宿主包裹(重画沿用首画时的宿主选项;共 ${seen.length} 次)`);
  const docH = new FakeDocument();
  const hostH = g(docH);
  let wraps = 0;
  const renderedH = await mod.renderMermaidBlocks(hostH, { t, ensure: async () => null, withLayoutChange: mutate => { wraps += 1; mutate(); } });
  ok(renderedH === 0 && wraps === 1 && hostH.querySelectorAll('.mermaid-block').every(block => block.dataset.mermaidState === 'fallback'),
    'D29c 缺库:三块一起回落,宿主只包一次');
  const docI = new FakeDocument();
  const hostI = g(docI);
  const renderedI = await mod.renderMermaidBlocks(hostI, { t, ensure: async () => stubG, withLayoutChange: () => { throw new Error('host broke'); } });
  const docJ = new FakeDocument();
  const hostJ = g(docJ);
  const renderedJ = await mod.renderMermaidBlocks(hostJ, { t, ensure: async () => stubG, withLayoutChange: () => {} });
  const statesOf = host => host.querySelectorAll('.mermaid-block').map(block => block.dataset.mermaidState).join(',');
  ok(renderedI === 2 && statesOf(hostI) === 'ok,fallback,ok' && renderedJ === 2 && statesOf(hostJ) === 'ok,fallback,ok'
    && hostJ.querySelectorAll('.mermaid-view').length === 2,
    'D29d 宿主回调抛错或忘了调 mutate:图照样换上去,每块恰好一次');

  console.log('\nMERMAID RENDER STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error('MERMAID RENDER STATIC E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
