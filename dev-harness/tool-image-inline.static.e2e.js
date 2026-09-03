#!/usr/bin/env node
'use strict';
// 静态锁 + DOM 桩行为件(第109波 109b):工具结果图片内联缩略图(零后端改动)。
//
// 断言五个方向:
//   ① 纯检测函数 detectToolImagePath():白名单工具/扩展名/失败结果/桥接前缀。
//   ② 端点契约:取图只经既有 /api/file/preview(与 file-browser.js 同一端点、零新增端点),
//      渲染函数本体不自行拼接任何 data: URI(只信任服务端返回的 preview.dataUri)。
//   ③ DOM 桩行为(不需要浏览器/服务):最终结果 -> 一张 <img>(重复渲染同一个 host 也只有一张,
//      guard 不重复取图);image-toobig -> 一个跳侧栏按钮、无 <img>;fetch 失败 -> 都没有;
//      未完成(pending)/isError 的卡片不取图。
//   ④ CSS:owning 层(css/states/chat-live.css)含 .tool-image / .tool-image img / .tool-image.expanded。
//   ⑤ i18n:三个新键在 zh-CN/en-US 与 docs/i18n 对应文件里都存在且逐字一致。
//
// 判定行:`TOOL IMAGE INLINE STATIC E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const primitivesPath = path.join(PUBLIC, 'js', 'chat-render-primitives.js');
const primitivesSrc = fs.readFileSync(primitivesPath, 'utf8');

/* ═══════════ ① 纯检测函数 detectToolImagePath()(源码级导出锁) ═══════════ */
ok(/export function detectToolImagePath\(toolName, result\)/.test(primitivesSrc),
  'A1 chat-render-primitives.js 导出 detectToolImagePath(toolName, result)');

/* ═══════════ ② 端点契约(源码级) ═══════════ */
ok(primitivesSrc.includes("api('/api/file/preview' + query)"),
  'B1 默认取图实现只用既有 /api/file/preview 端点(与 file-browser.js 同源,零新增端点)');
const fnMatch = primitivesSrc.match(/async function renderToolImageInto\(host, name, result\) \{[\s\S]*?\n  \}\n/);
ok(!!fnMatch, 'B2 renderToolImageInto() 函数体可提取');
const fnBody = fnMatch ? fnMatch[0] : '';
ok(!/\/api\//.test(fnBody),
  'B3 renderToolImageInto() 函数体内不直接拼接任何 /api/ 端点(取图统一走注入的 fetchFilePreview)');
ok(!/data:[a-zA-Z]/.test(fnBody),
  'B4 renderToolImageInto() 函数体不自行构造 data: URI(只信任服务端返回的 preview.dataUri)');
ok(fnBody.includes('fetchFilePreview(filePath)'),
  'B5 图片取数据统一走注入的 fetchFilePreview()');

/* ═══════════ ③④⑤ 动态加载 + DOM 桩行为 / CSS / i18n ═══════════ */
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
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  set textContent(value) { this._textContent = String(value ?? ''); this.children = []; }
  get textContent() {
    if (this._textContent) return this._textContent;
    if (this.children.length) return this.children.map(child => child.textContent).join('');
    return '';
  }
  setAttribute(name, value) { this.attributes[String(name)] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  addEventListener(type, handler) { (this.listeners[type] = this.listeners[type] || []).push(handler); }
}
const fakeEl = (tag, cls, text) => {
  const e = new FakeElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
// 递归按 tagName 收集后代节点(img/button 都嵌在 wrap div 里,不是 imageHost 的直接子节点)。
function findAllByTag(node, tagName) {
  const found = [];
  const visit = n => { for (const child of n.children) { if (child.tagName === tagName) found.push(child); visit(child); } };
  visit(node);
  return found;
}
function isDescendantOf(node, ancestor) {
  let cur = node;
  while (cur) { if (cur === ancestor) return true; cur = cur.parentNode; }
  return false;
}
const flush = () => new Promise(resolve => setImmediate(resolve));

(async () => {
  const source = fs.readFileSync(primitivesPath, 'utf8');
  const mod = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

  // ① detectToolImagePath 纯函数覆盖
  ok(mod.detectToolImagePath('chart_image', { path: 'C:/out/chart.png', success: true }) === 'C:/out/chart.png',
    'A2 白名单工具 + .png 路径 -> 返回路径');
  ok(mod.detectToolImagePath('window_screenshot', { output_path: 'C:/out/shot.JPG' }) === 'C:/out/shot.JPG',
    'A3 output_path 字段 + 大写扩展名不区分大小写 -> 返回路径');
  ok(mod.detectToolImagePath('get_clipboard_image', { savePath: 'C:/out/clip.webp' }) === 'C:/out/clip.webp',
    'A4 savePath 字段命中');
  ok(mod.detectToolImagePath('unknown_tool', { path: 'C:/out/chart.png' }) === null,
    'A5 非白名单工具 -> null');
  ok(mod.detectToolImagePath('chart_image', { path: 'C:/out/notes.txt' }) === null,
    'A6 非图片扩展名(.txt) -> null');
  ok(mod.detectToolImagePath('chart_image', { path: 'C:/out/chart.png', success: false }) === null,
    'A7 success:false -> null');
  ok(mod.detectToolImagePath('image_resize', { path: 'C:/out/r.png', ok: false }) === null,
    'A8 ok:false -> null');
  ok(mod.detectToolImagePath('acc__chart_image', { path: 'C:/out/chart.png' }) === 'C:/out/chart.png',
    'A9 桥接 serverId__ 前缀(acc__chart_image) -> 剥离后命中白名单');
  ok(mod.detectToolImagePath('chart_image', null) === null && mod.detectToolImagePath('chart_image', 'plain-string') === null,
    'A10 结果非对象(null/字符串) -> null');
  ok(mod.detectToolImagePath('chart_image', {}) === null,
    'A11 结果对象没有任何路径字段 -> null');

  // ③ DOM 桩行为:最终 chart_image 结果 -> 恰好一张 <img>,guard 防重复取图/重复渲染
  let fetchCallsA = 0;
  const primitivesA = mod.createChatRenderPrimitives({
    el: fakeEl,
    icon: () => null,
    humanizeToolName: n => n,
    t: k => k,
    fetchFilePreview: async () => { fetchCallsA += 1; return { ok: true, kind: 'image', dataUri: 'data:image/png;base64,AAAA' }; },
    openFilePreview: () => {},
  });
  const tcA = { name: 'chart_image', input: {}, result: { path: 'C:/out/chart.png' } };
  const cardA = primitivesA.toolCard(tcA);
  ok(isDescendantOf(cardA.imageHost, cardA.d) && cardA.imageHost.classList.contains('tc-image-host'),
    'C1 toolCard() 返回的 imageHost(.tc-image-host)挂在卡片 DOM 树内');
  // 「渲染两次」:toolCard() 内部已发起一次(fire-and-forget);这里在同一个 host 上再显式调用一次,
  // 命中防重放闸门应立即同步返回(不会再次调用 fetchFilePreview)。
  primitivesA.renderToolImageInto(cardA.imageHost, tcA.name, tcA.result);
  await flush();
  const imgsA = findAllByTag(cardA.imageHost, 'IMG');
  ok(imgsA.length === 1 && imgsA[0].src === 'data:image/png;base64,AAAA',
    'C2 最终 chart_image 结果渲染出恰好一张 <img>,src 为预览返回的 dataUri');
  ok(fetchCallsA === 1,
    'C3 同一个 host 被渲染两次也只取图一次(guard 防重复 fetch)');
  const togglesA = findAllByTag(cardA.imageHost, 'BUTTON');
  ok(togglesA.length === 1, 'C4 图片旁有且仅有一个 展开/收起 切换按钮');

  // image-toobig:一个跳侧栏按钮、没有 <img>,点按钮回调携带路径
  let openedPath = null;
  const primitivesB = mod.createChatRenderPrimitives({
    el: fakeEl,
    icon: () => null,
    humanizeToolName: n => n,
    t: k => k,
    fetchFilePreview: async () => ({ ok: true, kind: 'image-toobig', size: 9999999 }),
    openFilePreview: p => { openedPath = p; },
  });
  const tcB = { name: 'desktop_screenshot', input: {}, result: { output_path: 'C:/out/shot.png', success: true } };
  const cardB = primitivesB.toolCard(tcB);
  await flush();
  ok(findAllByTag(cardB.imageHost, 'IMG').length === 0,
    'D1 image-toobig 时不渲染 <img>');
  const btnsB = findAllByTag(cardB.imageHost, 'BUTTON');
  ok(btnsB.length === 1,
    'D2 image-toobig 时渲染恰好一个「在侧栏预览」按钮');
  if (btnsB[0] && typeof btnsB[0].onclick === 'function') btnsB[0].onclick({ preventDefault() {}, stopPropagation() {} });
  ok(openedPath === 'C:/out/shot.png',
    'D3 点击按钮调用注入的 openFilePreview(path),path 为检测到的图片路径');

  // fetch 失败(拒绝):既没有 <img> 也没有按钮,且不向上抛错
  const primitivesC = mod.createChatRenderPrimitives({
    el: fakeEl,
    icon: () => null,
    humanizeToolName: n => n,
    t: k => k,
    fetchFilePreview: async () => { throw new Error('network boom'); },
    openFilePreview: () => {},
  });
  const tcC = { name: 'chart_image', input: {}, result: { path: 'C:/out/x.png' } };
  let threw = false;
  let cardC;
  try { cardC = primitivesC.toolCard(tcC); } catch { threw = true; }
  await flush();
  ok(!threw, 'E1 fetchFilePreview 拒绝(reject)时 toolCard() 本身不抛错');
  ok(findAllByTag(cardC.imageHost, 'IMG').length === 0 && findAllByTag(cardC.imageHost, 'BUTTON').length === 0,
    'E2 fetch 失败时既不渲染 <img> 也不渲染按钮(静默降级)');

  // 未完成(pending)/isError 的卡片不取图
  let fetchCallsD = 0;
  const primitivesD = mod.createChatRenderPrimitives({
    el: fakeEl,
    icon: () => null,
    humanizeToolName: n => n,
    t: k => k,
    fetchFilePreview: async () => { fetchCallsD += 1; return { ok: true, kind: 'image', dataUri: 'data:image/png;base64,BBBB' }; },
    openFilePreview: () => {},
  });
  const pendingCard = primitivesD.toolCard({ name: 'chart_image', input: {} }); // 无 result -> done=false
  const errCard = primitivesD.toolCard({ name: 'chart_image', input: {}, result: { path: 'C:/out/e.png' }, isError: true });
  await flush();
  ok(fetchCallsD === 0,
    'F1 未完成(pending)或 isError 的工具卡从不触发取图请求');
  ok(findAllByTag(pendingCard.imageHost, 'IMG').length === 0 && findAllByTag(errCard.imageHost, 'IMG').length === 0,
    'F2 pending/isError 卡片的 imageHost 保持为空');

  // ④ CSS:owning 层含 .tool-image 规则
  const cssPath = path.join(PUBLIC, 'css', 'states', 'chat-live.css');
  const cssSrc = fs.readFileSync(cssPath, 'utf8');
  ok(cssSrc.includes('.tool-card .tc-image-host:empty'), 'G1 chat-live.css 含 .tc-image-host:empty(空宿主不占位)');
  ok(/\.tool-image\s*\{/.test(cssSrc), 'G2 chat-live.css 含 .tool-image 规则');
  ok(/\.tool-image img\s*\{/.test(cssSrc), 'G3 chat-live.css 含 .tool-image img 规则');
  ok(/\.tool-image\.expanded/.test(cssSrc), 'G4 chat-live.css 含 .tool-image.expanded 规则');

  // ⑤ i18n:三个新键在四个文件里都存在且逐字一致
  const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
  const zh = readJson(path.join(PUBLIC, 'locales', 'zh-CN.json'));
  const en = readJson(path.join(PUBLIC, 'locales', 'en-US.json'));
  const docsZh = readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'zh-CN.json'));
  const docsEn = readJson(path.join(ROOT, 'docs', 'i18n', 'locales', 'en-US.json'));
  for (const key of ['chat.toolImage.expand', 'chat.toolImage.collapse', 'chat.toolImage.openInSidebar']) {
    ok(typeof zh[key] === 'string' && zh[key].length > 0, `H ${key} 在 public zh-CN 存在`);
    ok(typeof en[key] === 'string' && en[key].length > 0, `H ${key} 在 public en-US 存在`);
    ok(docsZh[key] === zh[key], `H ${key} docs/i18n zh-CN 与 public 逐字一致`);
    ok(docsEn[key] === en[key], `H ${key} docs/i18n en-US 与 public 逐字一致`);
  }

  console.log('\nTOOL IMAGE INLINE STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error('TOOL IMAGE INLINE STATIC E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
