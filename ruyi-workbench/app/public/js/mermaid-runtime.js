'use strict';
import { installFocusTrap } from './modal.js';
// 109a: Mermaid 图表渲染运行时(纯离线、懒加载、失败即降级)。
//
// 设计约束(与 CONTRIBUTING 五条红线对齐):
//   1. 纯离线:只从本源 /vendor/mermaid.min.js 取库,永不访问外部站点;CSP script-src 'self' 天然拒绝外域。
//   2. 可缺失:vendor 文件由维护者放入。文件不存在时注入的 <script> 会 404 -> 本模块解析为 null,
//      调用方保留原始代码块并补一行提示。缺库是正式路径之一,不是错误,不刷控制台、不重试风暴
//      (首次失败的结果被永久缓存,后续调用直接拿到 null)。
//   3. 安全:securityLevel: 'strict' 由 mermaid 自身消毒输出;我们不调用 bindFunctions,
//      因此 click 指令永远不会接线。SVG 注入点在 sanitizeNode() 跑完之后,不经过 Markdown 白名单。
//   4. 流式:聊天流式期间正文是纯文本节点,只有封段(sealLiveTextSegment)与整会话重绘才走 Markdown。
//      重绘会重建 DOM,所以按「源码哈希 + 主题」在包裹节点上做缓存键,源码未变则跳过重渲染。
//
// 导出:ensureMermaid / renderMermaidBlocks / mermaidSourceHash / mermaidThemeFor。

export const MERMAID_SCRIPT_SRC = '/vendor/mermaid.min.js';
export const MERMAID_LOAD_TIMEOUT_MS = 8000;

// 单飞:整页只注入一次脚本;结果(库对象或 null)被永久复用。
let loadPromise = null;
// 已初始化的 (theme, fontFamily) 签名。主题切换后需要重新 initialize。
let initSignature = '';
let renderSeq = 0;

// 稳定的源码指纹(FNV-1a 变体 + 位置加权 + 长度),仅用于缓存命中判定,不作安全用途。
export function mermaidSourceHash(text) {
  const source = String(text == null ? '' : text);
  let hash = 0x811c9dc5;
  let mix = 0;
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    hash = ((hash ^ code) * 16777619) >>> 0;
    mix = (mix + code * (i + 1)) >>> 0;
  }
  return `${hash.toString(36)}-${mix.toString(36)}-${source.length.toString(36)}`;
}

// 主题映射:工作台只有 dark / light 两个有效值(data-theme 已把 system 解析掉)。
export function mermaidThemeFor(isDark) {
  return isDark ? 'dark' : 'default';
}

function docOf(node, opts) {
  if (opts && opts.document) return opts.document;
  if (node && node.ownerDocument) return node.ownerDocument;
  return typeof globalThis !== 'undefined' ? globalThis.document : null;
}

function isDarkTheme(doc) {
  try {
    const root = doc && doc.documentElement;
    const value = root && typeof root.getAttribute === 'function' ? root.getAttribute('data-theme') : null;
    return value !== 'light';
  } catch { return true; }
}

function appFontFamily(doc) {
  try {
    const view = doc && doc.defaultView;
    if (view && typeof view.getComputedStyle === 'function' && doc.documentElement) {
      const font = view.getComputedStyle(doc.documentElement).getPropertyValue('--font');
      if (font && font.trim()) return font.trim();
    }
  } catch { /* 计算样式不可用(测试 shim / 早期启动)时退到 token 默认值 */ }
  return '"Segoe UI", "Microsoft YaHei", system-ui, Arial, sans-serif';
}

// 注入 vendor 脚本。任何失败路径(404、超时、内容不是脚本)一律解析为 null,不抛异常。
function injectVendorScript(doc) {
  return new Promise(resolve => {
    let settled = false;
    let timer = 0;
    const finish = value => {
      if (settled) return;
      settled = true;
      if (timer) { try { clearTimeout(timer); } catch { /* noop */ } }
      resolve(value || null);
    };
    let node;
    try { node = doc.createElement('script'); } catch { finish(null); return; }
    const host = doc.head || doc.body || doc.documentElement;
    if (!host || typeof host.appendChild !== 'function') { finish(null); return; }
    try { timer = setTimeout(() => finish(null), MERMAID_LOAD_TIMEOUT_MS); } catch { timer = 0; }
    node.async = true;
    // 脚本 404 时浏览器只派发 error 事件;若服务端回了 HTML 兜底页,load 会触发但全局对象仍不存在,
    // 两条路径都收敛到「拿不到库 -> null」。
    node.addEventListener('error', () => finish(null));
    node.addEventListener('load', () => finish(globalThis.mermaid || null));
    node.src = MERMAID_SCRIPT_SRC;
    try { host.appendChild(node); } catch { finish(null); }
  });
}

// 取得已初始化的 mermaid 库;拿不到(未放入 vendor 文件 / 加载失败)时解析 null。
export function ensureMermaid(opts = {}) {
  const doc = docOf(null, opts);
  if (globalThis.mermaid) return Promise.resolve(globalThis.mermaid);
  if (loadPromise) return loadPromise;
  if (!doc || typeof doc.createElement !== 'function') {
    loadPromise = Promise.resolve(null);
    return loadPromise;
  }
  loadPromise = injectVendorScript(doc).then(lib => lib || null, () => null);
  return loadPromise;
}

// initialize 只在签名变化时重跑(首次 + 主题切换)。startOnLoad:false 阻止 mermaid 自行扫描全页。
function initializeOnce(lib, theme, fontFamily) {
  const signature = `${theme}|${fontFamily}`;
  if (initSignature === signature) return;
  try {
    lib.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme, fontFamily });
    initSignature = signature;
  } catch { /* 初始化失败按未初始化处理,render 会随之失败并降级 */ }
}

function collectMermaidBlocks(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const found = [];
  let nodes;
  try { nodes = root.querySelectorAll('code.language-mermaid'); } catch { return found; }
  for (const code of Array.from(nodes || [])) {
    const pre = code.parentElement || code.parentNode;
    if (!pre || String(pre.tagName || '').toUpperCase() !== 'PRE') continue;
    found.push({ code, pre });
  }
  return found;
}

function ensureWrapper(doc, pre) {
  const parent = pre.parentElement || pre.parentNode;
  if (parent && parent.classList && parent.classList.contains('mermaid-block')) return parent;
  const wrapper = doc.createElement('div');
  wrapper.className = 'mermaid-block';
  if (parent && typeof pre.replaceWith === 'function') {
    pre.replaceWith(wrapper);
    wrapper.appendChild(pre);
  } else if (parent && typeof parent.insertBefore === 'function') {
    parent.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
  } else {
    wrapper.appendChild(pre);
  }
  return wrapper;
}

// 清掉上一轮生成的视图/提示/工具条,只保留原始 <pre>(降级与成功态共用)。
function resetWrapper(wrapper, pre) {
  for (const child of Array.from(wrapper.children || [])) {
    if (child !== pre && typeof child.remove === 'function') child.remove();
  }
}

function makeButton(doc, label, onClick) {
  const button = doc.createElement('button');
  button.className = 'copy-code mermaid-btn';
  button.type = 'button';
  button.textContent = label;
  // 与既有 .copy-code 复制按钮同款,只挂一处 onclick。
  // (真机走查抓到的回归:同时挂 addEventListener('click') 会让一次点击触发两遍,「源码」开关原地弹回。)
  button.onclick = onClick;
  return button;
}

function triggerDownload(doc, blobUrl, filename) {
  try {
    const link = doc.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    const host = doc.body || doc.documentElement;
    if (host && typeof host.appendChild === 'function') host.appendChild(link);
    if (typeof link.click === 'function') link.click();
    if (typeof link.remove === 'function') link.remove();
  } catch { /* 调用方已在 try 内兜底 */ }
}

function svgMarkupOf(view) {
  const svg = view && typeof view.querySelector === 'function' ? view.querySelector('svg') : null;
  if (!svg) {
    // 视图里掏不出 <svg> 元素时(宿主 DOM 不解析 innerHTML 的场景),只要视图内容确实是
    // mermaid 写进去的那段 SVG 标记,就原样用 —— 灯箱与导出不该因此静默失能。
    const inner = view && typeof view.innerHTML === 'string' ? view.innerHTML : '';
    return { svg: null, markup: inner.includes('<svg') ? inner : '' };
  }
  let markup = '';
  try { markup = new globalThis.XMLSerializer().serializeToString(svg); }
  catch { markup = svg.outerHTML || ''; }
  return { svg, markup };
}

function svgPixelSize(svg) {
  let width = 0;
  let height = 0;
  try {
    const box = typeof svg.getBoundingClientRect === 'function' ? svg.getBoundingClientRect() : null;
    if (box) { width = Math.round(box.width); height = Math.round(box.height); }
  } catch { /* 继续尝试 viewBox */ }
  if (!width || !height) {
    try {
      const vb = svg.viewBox && svg.viewBox.baseVal;
      if (vb && vb.width && vb.height) { width = Math.round(vb.width); height = Math.round(vb.height); }
    } catch { /* 用默认尺寸 */ }
  }
  return { width: Math.max(1, width || 960), height: Math.max(1, height || 540) };
}

// SVG 的自然尺寸:灯箱里 stage 带着 transform,getBoundingClientRect 量到的是【缩放后】的
// 像素,拿它做「适应窗口」的底数会把 fit 越算越小(真机 B4b 擒获:fit 完 scale 从 5.09 掉到 0.8)。
// 自然尺寸优先 viewBox(mermaid 输出恒有),没有才退回 svgPixelSize 的量法。
function svgNaturalSize(svg) {
  try {
    const vb = svg && svg.viewBox && svg.viewBox.baseVal;
    if (vb && vb.width && vb.height) return { width: vb.width, height: vb.height };
  } catch { /* 退回下面的量法 */ }
  return svgPixelSize(svg);
}

function exportSvg(doc, view, notify) {
  const { markup } = svgMarkupOf(view);
  if (!markup) { notify.fail(); return; }
  let url = '';
  try {
    const blob = new globalThis.Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
    url = globalThis.URL.createObjectURL(blob);
    triggerDownload(doc, url, `mermaid-${Date.now()}.svg`);
  } catch { notify.fail(); }
  if (url) setTimeout(() => { try { globalThis.URL.revokeObjectURL(url); } catch { /* noop */ } }, 4000);
}

// PNG uses a self-contained data URL: Chromium taints canvas when an SVG
// containing Mermaid's foreignObject labels is loaded through a blob URL.
function exportPng(doc, view, notify) {
  const { svg, markup } = svgMarkupOf(view);
  if (!svg || !markup) { notify.fail(); return; }
  let sourceUrl = '';
  try {
    const { width, height } = svgNaturalSize(svg);
    const copy = svg.cloneNode(true);
    copy.setAttribute('width', String(width));
    copy.setAttribute('height', String(height));
    copy.style.maxWidth = 'none';
    sourceUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new globalThis.XMLSerializer().serializeToString(copy));
    const scale = Math.min(2, 8192 / Math.max(width, height), Math.sqrt(16777216 / (width * height)));
    const image = new globalThis.Image();
    const cleanup = () => { try { globalThis.URL.revokeObjectURL(sourceUrl); } catch { /* noop */ } };
    image.onload = () => {
      try {
        const canvas = doc.createElement('canvas');
        canvas.width = width * scale;
        canvas.height = height * scale;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(pngBlob => {
          cleanup();
          if (!pngBlob) { notify.fail(); return; }
          let pngUrl = '';
          try {
            pngUrl = globalThis.URL.createObjectURL(pngBlob);
            triggerDownload(doc, pngUrl, `mermaid-${Date.now()}.png`);
          } catch { notify.fail(); }
          if (pngUrl) setTimeout(() => { try { globalThis.URL.revokeObjectURL(pngUrl); } catch { /* noop */ } }, 4000);
        }, 'image/png');
      } catch { cleanup(); notify.fail(); }
    };
    image.onerror = () => { cleanup(); notify.fail(); };
    image.src = sourceUrl;
  } catch {
    if (sourceUrl) { try { globalThis.URL.revokeObjectURL(sourceUrl); } catch { /* noop */ } }
    notify.fail();
  }
}

// ── 放大查看(用户 2026-09-22 反馈:大图在消息栏里缩成一团,看不全)──────────────
// 全屏灯箱:把同一份已消毒 SVG 克隆进独立覆盖层,滚轮缩放(以指针为锚)/拖拽平移/
// 「适应窗口」一键复位,Esc、点遮罩或「关闭」退出。只操作本模块自建 DOM —— 不开窗、
// 不触网、不新增脚本,CSP 与 sanitize 边界不变;SVG 来源仍是 securityLevel:'strict'
// 跑过的那段 markup。
const VIEWER_MIN_SCALE = 0.1;
const VIEWER_MAX_SCALE = 8;
const VIEWER_ZOOM_STEP = 1.25;

function closeMermaidViewer(doc) {
  const open = doc && doc.__ruyiMermaidViewer;
  const trigger = open && open.__focusTrigger;
  if (open && typeof open.remove === 'function') open.remove();
  if (doc) doc.__ruyiMermaidViewer = null;
  if (trigger?.isConnected) trigger.focus?.({ preventScroll: true });
}

function openMermaidViewer(doc, markup, t) {
  if (!markup) return;
  const host = doc.body || doc.documentElement;
  if (!host || typeof host.appendChild !== 'function') return;
  closeMermaidViewer(doc);

  const overlay = doc.createElement('div');
  overlay.__focusTrigger = doc.activeElement;
  overlay.className = 'mermaid-lightbox';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('mermaid.diagramAria'));
  overlay.tabIndex = -1;
  installFocusTrap(overlay);

  const stage = doc.createElement('div');
  stage.className = 'mermaid-lightbox-stage';
  // 与 .mermaid-view 同源的一段:strict 消毒之后、受控写入,不再过第二道解析器。
  stage.innerHTML = markup;
  const diagram = stage.querySelector('svg');
  if (diagram) {
    const size = svgNaturalSize(diagram);
    diagram.style.maxWidth = 'none';
    diagram.setAttribute('width', String(size.width));
    diagram.setAttribute('height', String(size.height));
  }
  overlay.appendChild(stage);

  const state = { scale: 1, x: 0, y: 0 };
  const apply = () => {
    stage.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.scale})`;
  };
  const overlaySize = () => ({
    width: overlay.clientWidth || (globalThis.innerWidth || 960),
    height: overlay.clientHeight || (globalThis.innerHeight || 540),
  });
  const fit = () => {
    const { width: svgW, height: svgH } = svgNaturalSize(stage.querySelector('svg'));
    const { width, height } = overlaySize();
    const pad = 48;
    state.scale = Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE,
      Math.min((width - pad) / svgW, (height - pad) / svgH)));
    state.x = (width - svgW * state.scale) / 2;
    state.y = (height - svgH * state.scale) / 2;
    apply();
  };
  const zoomAt = (cx, cy, next) => {
    const scale = Math.min(VIEWER_MAX_SCALE, Math.max(VIEWER_MIN_SCALE, next));
    state.x = cx - (cx - state.x) * (scale / state.scale);
    state.y = cy - (cy - state.y) * (scale / state.scale);
    state.scale = scale;
    apply();
  };
  const zoomAtCenter = next => {
    const { width, height } = overlaySize();
    zoomAt(width / 2, height / 2, next);
  };

  const controls = doc.createElement('div');
  controls.className = 'mermaid-lightbox-controls';
  const control = (label, onClick) => {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'mermaid-lightbox-btn';
    button.textContent = label;
    button.onclick = onClick;
    controls.appendChild(button);
    return button;
  };
  control(t('mermaid.viewerIn'), () => zoomAtCenter(state.scale * VIEWER_ZOOM_STEP));
  control(t('mermaid.viewerOut'), () => zoomAtCenter(state.scale / VIEWER_ZOOM_STEP));
  control(t('mermaid.viewerFit'), fit);
  const closeBtn = control(t('mermaid.viewerClose'), () => closeMermaidViewer(doc));
  overlay.appendChild(controls);

  const inside = (node, ancestor) => {
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parentElement || current.parentNode;
    }
    return false;
  };
  // 拖拽平移:在图或遮罩空白处按下都生效,控制条上的按下不算。
  overlay.addEventListener('pointerdown', event => {
    const target = event && event.target;
    if (inside(target, controls)) return;
    if (target !== overlay && !inside(target, stage)) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const origin = { px: event.clientX || 0, py: event.clientY || 0, x: state.x, y: state.y };
    const move = e => {
      state.x = origin.x + (e.clientX || 0) - origin.px;
      state.y = origin.y + (e.clientY || 0) - origin.py;
      apply();
    };
    const up = () => {
      overlay.removeEventListener('pointermove', move);
      overlay.removeEventListener('pointerup', up);
      overlay.removeEventListener('pointercancel', up);
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerup', up);
    overlay.addEventListener('pointercancel', up);
  });
  // 滚轮缩放,以指针位置为锚(不缩放页面本身)。
  overlay.addEventListener('wheel', event => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const rect = typeof overlay.getBoundingClientRect === 'function' ? overlay.getBoundingClientRect() : { left: 0, top: 0 };
    const cx = (event.clientX || 0) - (rect.left || 0);
    const cy = (event.clientY || 0) - (rect.top || 0);
    zoomAt(cx, cy, state.scale * (event.deltaY < 0 ? VIEWER_ZOOM_STEP : 1 / VIEWER_ZOOM_STEP));
  }, { passive: false });
  overlay.addEventListener('keydown', event => {
    if (event && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMermaidViewer(doc);
    }
  });
  // 点遮罩空白处退出;点在图或控制条上不退出。
  overlay.onclick = event => { if (event && event.target === overlay) closeMermaidViewer(doc); };

  host.appendChild(overlay);
  doc.__ruyiMermaidViewer = overlay;
  fit();
  try {
    if (typeof overlay.focus === 'function') overlay.focus();
    else if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  } catch { /* 测试桩无 focus 不致命 */ }
  return overlay;
}

function buildToolbar(doc, ctx) {
  const bar = doc.createElement('div');
  bar.className = 'mermaid-tools';
  const { pre, view, source, t, toast } = ctx;
  const notify = { fail: () => { if (typeof toast === 'function') toast(t('mermaid.exportFailed'), 'err'); } };
  const toggle = makeButton(doc, t('mermaid.toggleSource'), () => {
    const hidden = !pre.hidden;
    pre.hidden = hidden;
    if (pre.classList) pre.classList.toggle('mermaid-source-hidden', hidden);
    toggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });
  toggle.setAttribute('aria-expanded', 'false');
  const copy = makeButton(doc, t('common.copy'), () => {
    try {
      const clipboard = globalThis.navigator && globalThis.navigator.clipboard;
      if (!clipboard) return;
      clipboard.writeText(source).then(
        () => { if (typeof toast === 'function') toast(t('toast.copyCode'), 'ok'); },
        () => notify.fail(),
      );
    } catch { notify.fail(); }
  });
  const openViewer = () => openMermaidViewer(doc, svgMarkupOf(view).markup, t);
  const zoomBtn = makeButton(doc, t('mermaid.viewerOpen'), openViewer);
  // 整图本身也可点开灯箱(光标由 CSS 给 zoom-in);工具条按钮走同一入口,行为只有一份。
  view.onclick = openViewer;
  view.setAttribute('title', t('mermaid.viewerHint'));
  const svgBtn = makeButton(doc, t('mermaid.exportSvg'), () => exportSvg(doc, view, notify));
  const pngBtn = makeButton(doc, t('mermaid.exportPng'), () => exportPng(doc, view, notify));
  for (const node of [toggle, copy, zoomBtn, svgBtn, pngBtn]) bar.appendChild(node);
  return bar;
}

function degrade(doc, wrapper, pre, hash, theme, message) {
  resetWrapper(wrapper, pre);
  pre.hidden = false;
  if (pre.classList) pre.classList.remove('mermaid-source-hidden');
  const hint = doc.createElement('div');
  hint.className = 'mermaid-hint';
  hint.textContent = message;
  wrapper.appendChild(hint);
  wrapper.dataset.mermaidHash = hash;
  wrapper.dataset.mermaidTheme = theme;
  wrapper.dataset.mermaidState = 'fallback';
}

// 把 container 内的 mermaid 围栏渲染成 SVG,返回本次成功渲染的块数。
// opts: { t, toast, isDark, document, ensure }(ensure 仅供测试注入替身)。
export async function renderMermaidBlocks(container, opts = {}) {
  const blocks = collectMermaidBlocks(container);
  if (!blocks.length) return 0;
  const doc = docOf(container, opts);
  if (!doc || typeof doc.createElement !== 'function') return 0;
  const t = typeof opts.t === 'function' ? opts.t : (key => key);
  const toast = typeof opts.toast === 'function' ? opts.toast : null;
  const dark = opts.isDark === undefined ? isDarkTheme(doc) : Boolean(opts.isDark);
  const theme = mermaidThemeFor(dark);
  const ensure = typeof opts.ensure === 'function' ? opts.ensure : ensureMermaid;

  // 先把待处理块框好并打上 pending,避免加载期间同一容器被重复排队。
  const pending = [];
  for (const { code, pre } of blocks) {
    const source = String(code.textContent || '');
    const hash = mermaidSourceHash(source);
    const wrapper = ensureWrapper(doc, pre);
    const data = wrapper.dataset || {};
    // 缓存键 = 源码哈希 + 主题。流式封段/整会话重绘会重建 DOM(缓存随之失效);
    // 同一 DOM 上重复调用则命中缓存,不再重跑 mermaid。
    if (data.mermaidHash === hash && data.mermaidTheme === theme && data.mermaidState) continue;
    wrapper.dataset.mermaidHash = hash;
    wrapper.dataset.mermaidTheme = theme;
    wrapper.dataset.mermaidState = 'pending';
    pending.push({ code, pre, wrapper, source, hash });
  }
  if (!pending.length) return 0;

  let lib = null;
  try { lib = await ensure({ document: doc }); } catch { lib = null; }
  if (!lib || typeof lib.render !== 'function') {
    for (const item of pending) degrade(doc, item.wrapper, item.pre, item.hash, theme, t('mermaid.fallbackHint'));
    return 0;
  }
  initializeOnce(lib, theme, appFontFamily(doc));

  let rendered = 0;
  for (const item of pending) {
    renderSeq += 1;
    let svgMarkup = '';
    // Mermaid measures in the live DOM. Keep its temporary SVGs in a private,
    // offscreen host and always remove that host, including on parser failures.
    const renderHost = doc.createElement('div');
    renderHost.className = 'mermaid-render-host';
    renderHost.setAttribute('aria-hidden', 'true');
    renderHost.style.position = 'fixed';
    renderHost.style.left = '-100000px';
    (doc.body || doc.documentElement).appendChild(renderHost);
    try {
      const result = await lib.render(`ruyi-mermaid-${Date.now().toString(36)}-${renderSeq}`, item.source, renderHost);
      svgMarkup = result && typeof result === 'object' ? String(result.svg || '') : String(result || '');
    } catch { svgMarkup = ''; }
    finally { renderHost.remove(); }
    if (!svgMarkup) {
      degrade(doc, item.wrapper, item.pre, item.hash, theme, t('mermaid.renderFailed'));
      continue;
    }
    resetWrapper(item.wrapper, item.pre);
    const view = doc.createElement('div');
    view.className = 'mermaid-view';
    view.setAttribute('role', 'img');
    view.setAttribute('aria-label', t('mermaid.diagramAria'));
    // securityLevel: 'strict' 下 mermaid 自行消毒输出,且我们从不调用 bindFunctions,
    // 所以 click 指令不会接线。此处赋值发生在 sanitizeNode() 之后,是有意的受控写入。
    view.innerHTML = svgMarkup;
    const toolbar = buildToolbar(doc, { pre: item.pre, view, source: item.source, t, toast });
    if (typeof item.pre.before === 'function') {
      item.pre.before(view);
      item.pre.before(toolbar);
    } else {
      item.wrapper.appendChild(view);
      item.wrapper.appendChild(toolbar);
    }
    item.pre.hidden = true;
    if (item.pre.classList) item.pre.classList.add('mermaid-source-hidden');
    item.wrapper.dataset.mermaidState = 'ok';
    rendered += 1;
  }
  return rendered;
}
