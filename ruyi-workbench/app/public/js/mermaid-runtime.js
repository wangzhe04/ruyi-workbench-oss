'use strict';
import { installFocusTrap } from './modal.js';
import { prepareMermaidSource, repairMermaidSource } from './mermaid-source.js';
import { polishMermaidSvg } from './mermaid-postprocess.js';
// 109a: Mermaid 图表渲染运行时(纯离线、懒加载、失败即降级)。
//
// 设计约束(与 CONTRIBUTING 五条红线对齐):
//   1. 纯离线:只从本源 /vendor/mermaid.min.js 取库,永不访问外部站点;CSP script-src 'self' 天然拒绝外域。
//   2. 可缺失:vendor 文件由维护者放入。文件不存在时注入的 <script> 会 404 -> 本模块解析为 null,
//      调用方保留原始代码块并补一行提示。缺库是正式路径之一,不是错误,不刷控制台、不重试风暴
//      (首次失败的结果被永久缓存,后续调用直接拿到 null)。
//   3. 安全:securityLevel: 'strict' 由 mermaid 自身消毒输出;我们不调用 bindFunctions,
//      因此 click 回调永远不会接线;click href / 标签里的 <a href> 画出来的链接由 mermaid-postprocess.js 摘掉 href。SVG 注入点在 sanitizeNode() 跑完之后,不经过 Markdown 白名单。
//   4. 流式:聊天流式期间正文是纯文本节点,只有封段(sealLiveTextSegment)与整会话重绘才走 Markdown。
//      重绘会重建 DOM,所以按「源码哈希 + 主题」在包裹节点上做缓存键,源码未变则跳过重渲染。
//
//   5. 主题:两套色板(MERMAID_PALETTES)对齐工作台 token;亮暗切换时已画好的图按新主题重画
//      (watchThemeChanges),不会把亮色图留在暗底上。
//
// 导出:ensureMermaid / renderMermaidBlocks / mermaidSourceHash / mermaidThemeFor / mermaidThemeVariables /
//      mermaidThemeCss / MERMAID_CATEGORICAL。

export const MERMAID_SCRIPT_SRC = '/vendor/mermaid.min.js';
export const MERMAID_LOAD_TIMEOUT_MS = 8000;

// 单飞:整页只注入一次脚本;结果(库对象或 null)被永久复用。
let loadPromise = null;
// 已初始化的 (theme, fontFamily) 签名。主题切换后需要重新 initialize。
let initSignature = '';
let renderSeq = 0;
// 全页一条渲染队列:mermaid 的主题是全局配置(initialize),两路渲染交错时(整会话重绘 + 切主题重画),
// 后一路的 initialize 会改掉前一路还没画的块的配色。每块在队里先按【自己的】主题 initialize 再 render。
let renderQueue = Promise.resolve();
function enqueueRender(task) {
  const run = renderQueue.then(task, task);
  renderQueue = run.then(() => {}, () => {});
  return run;
}

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
// 返回值是本模块的色板键(也是包裹节点上的缓存键),不是 mermaid 的主题名 —— 两套都走 mermaid 的 base 主题。
export function mermaidThemeFor(isDark) {
  return isDark ? 'dark' : 'light';
}

// ── 色板(2026-10-03 用户反馈「暗色下 mermaid 不好看」)──────────────────────────────
// 修前直接用 mermaid 自带的 dark / default:暗色下节点是近黑块、连线与标签糊进深蓝面板,甘特图的
// 已完成任务是浅灰条配浅色字。现在两套都走 base 主题 + 显式 themeVariables,取值对齐
// css/themes/color-schemes.css 的 token(行尾注释标出对应项);没给的变量由 base 主题自行推导。
// mermaid 只认十六进制色值(内部用 khroma 推导明暗),所以这里写死色值而不是读 CSS 变量。
// 分类色(饼图扇区 / 思维导图与时间线分支 / gitGraph 分支 / xychart 系列)两套主题共用:中等明度,
// 白字压在上面对比度 ≥ 4:1,先走 accent / accent-2 再铺开色相。
export const MERMAID_CATEGORICAL = Object.freeze([
  '#4467d6', '#8159dc', '#23866a', '#a86c14', '#c04566', '#21809f',
  '#518c2f', '#b45431', '#56688c', '#9a48b0', '#3672c4', '#7d7822',
]);

const MERMAID_PALETTES = Object.freeze({
  dark: Object.freeze({
    darkMode: true,
    background: '#1a2436',              // --panel-2(.mermaid-view 的底)
    primaryColor: '#22335a',            // 节点:accent 压暗
    primaryBorderColor: '#5b7de3',
    primaryTextColor: '#e9edf5',        // --ink
    secondaryColor: '#2c2752',
    secondaryBorderColor: '#9a72f0',    // --accent-2
    secondaryTextColor: '#e9edf5',
    tertiaryColor: '#1f2a40',
    tertiaryBorderColor: '#33425e',     // --line-2
    tertiaryTextColor: '#c4cee0',       // --ink-2
    lineColor: '#8fa0b8',               // --muted
    arrowheadColor: '#8fa0b8',
    textColor: '#c4cee0',
    titleColor: '#e9edf5',
    edgeLabelBackground: '#1a2436',
    clusterBkg: '#202c47',              // 子图底:修前 #1e2840 与面板只差 1.05:1,子图框几乎看不出
    clusterBorder: '#3d4e6e',
    noteBkgColor: '#3a3324',
    noteBorderColor: '#b8913f',
    noteTextColor: '#f2e7cc',
    actorBkg: '#22335a',
    actorBorder: '#5b7de3',
    actorTextColor: '#e9edf5',
    actorLineColor: '#4f6080',
    signalColor: '#aab7cc',
    signalTextColor: '#e9edf5',
    labelBoxBkgColor: '#22335a',
    labelBoxBorderColor: '#5b7de3',
    labelTextColor: '#e9edf5',
    loopTextColor: '#c4cee0',
    activationBkgColor: '#2b3d68',
    activationBorderColor: '#5b7de3',
    sequenceNumberColor: '#0f1520',     // --bg:序号圈是 signalColor 的浅底
    sectionBkgColor: '#4a6cd9',         // --accent(甘特区段带,mermaid 再叠 0.2 不透明度)
    altSectionBkgColor: '#8fa0b8',
    sectionBkgColor2: '#4a6cd9',
    taskBkgColor: '#3f5fc7',
    taskBorderColor: '#6f8cf0',
    taskTextColor: '#ffffff',
    taskTextLightColor: '#ffffff',
    taskTextDarkColor: '#e9edf5',
    taskTextOutsideColor: '#e9edf5',
    taskTextClickableColor: '#8fb0ff',
    activeTaskBkgColor: '#2b4384',
    activeTaskBorderColor: '#8aa4f2',
    doneTaskBkgColor: '#2e3a52',
    doneTaskBorderColor: '#62728f',
    critBkgColor: '#9e3a44',
    critBorderColor: '#e56060',         // --danger
    gridColor: '#33425e',
    todayLineColor: '#e56060',
    vertLineColor: '#9a72f0',
    excludeBkgColor: '#2d3a54',         // 甘特 excludes(周末)条纹:修前与面板同色,看不见
    attributeBackgroundColorOdd: '#1f2b45',
    attributeBackgroundColorEven: '#1a2436',
    rowOdd: '#1f2b45',
    rowEven: '#1a2436',
    relationLabelBackground: '#1a2436',
    commitLabelColor: '#e9edf5',
    commitLabelBackground: '#2c3a58',
    tagLabelColor: '#e9edf5',
    tagLabelBackground: '#22335a',
    tagLabelBorder: '#5b7de3',
    pieStrokeColor: '#1a2436',
    pieOuterStrokeColor: '#1a2436',
    pieOpacity: '1',
    pieSectionTextColor: '#ffffff',
    pieTitleTextColor: '#e9edf5',
    pieLegendTextColor: '#c4cee0',
    errorBkgColor: '#3a2228',
    errorTextColor: '#f2b8b8',
    secondBkg: '#2c2752',               // 铁路图终结符底:base 主题默认 #ffffde 配浅字
    dropShadow: 'none',                 // 时序图 box/rect 外的浅灰光晕(深底上像一圈毛边)
    archGroupBorderColor: '#5f7090',    // 架构图分组框与无图标占位框:默认近黑
    archEdgeColor: '#8fa0b8',
    archEdgeArrowColor: '#8fa0b8',
  }),
  light: Object.freeze({
    darkMode: false,
    background: '#f7f9fc',              // --panel-2
    primaryColor: '#e7edfa',            // --accent-soft
    primaryBorderColor: '#7d97dc',
    primaryTextColor: '#1b2436',        // --ink
    secondaryColor: '#efe9fb',
    secondaryBorderColor: '#a08be0',
    secondaryTextColor: '#1b2436',
    tertiaryColor: '#eef2f8',           // --panel-3
    tertiaryBorderColor: '#c6d1e3',     // --line-2
    tertiaryTextColor: '#33405a',       // --ink-2
    lineColor: '#5f6c85',               // --muted
    arrowheadColor: '#5f6c85',
    textColor: '#33405a',
    titleColor: '#1b2436',
    edgeLabelBackground: '#f7f9fc',
    clusterBkg: '#f0f4fa',
    clusterBorder: '#c6d1e3',
    noteBkgColor: '#fdf3d8',
    noteBorderColor: '#d8b25a',
    noteTextColor: '#4a3a12',
    actorBkg: '#e7edfa',
    actorBorder: '#7d97dc',
    actorTextColor: '#1b2436',
    actorLineColor: '#a3b0c6',
    signalColor: '#4a5670',
    signalTextColor: '#1b2436',
    labelBoxBkgColor: '#e7edfa',
    labelBoxBorderColor: '#7d97dc',
    labelTextColor: '#1b2436',
    loopTextColor: '#33405a',
    activationBkgColor: '#d5dff6',
    activationBorderColor: '#7d97dc',
    sequenceNumberColor: '#ffffff',
    sectionBkgColor: '#4a6cd9',
    altSectionBkgColor: '#9aa8c0',
    sectionBkgColor2: '#4a6cd9',
    taskBkgColor: '#3f63d0',
    taskBorderColor: '#2050c8',         // --accent
    taskTextColor: '#ffffff',
    taskTextLightColor: '#ffffff',
    taskTextDarkColor: '#1b2436',
    taskTextOutsideColor: '#1b2436',
    taskTextClickableColor: '#2050c8',
    activeTaskBkgColor: '#cfdcf8',
    activeTaskBorderColor: '#2050c8',
    doneTaskBkgColor: '#e1e6ee',
    doneTaskBorderColor: '#9aa8c0',
    critBkgColor: '#c8463c',
    critBorderColor: '#b42318',         // --danger
    gridColor: '#dbe2ee',               // --line
    todayLineColor: '#b42318',
    vertLineColor: '#7a5fd0',           // --accent-2
    excludeBkgColor: '#d9e0ec',
    attributeBackgroundColorOdd: '#ffffff',
    attributeBackgroundColorEven: '#f2f5fa',
    rowOdd: '#ffffff',
    rowEven: '#f2f5fa',
    relationLabelBackground: '#f7f9fc',
    commitLabelColor: '#1b2436',
    commitLabelBackground: '#e7edfa',
    tagLabelColor: '#1b2436',
    tagLabelBackground: '#e7edfa',
    tagLabelBorder: '#7d97dc',
    pieStrokeColor: '#f7f9fc',
    pieOuterStrokeColor: '#f7f9fc',
    pieOpacity: '1',
    pieSectionTextColor: '#ffffff',
    pieTitleTextColor: '#1b2436',
    pieLegendTextColor: '#33405a',
    errorBkgColor: '#fbe4e1',
    errorTextColor: '#8a1c12',
    secondBkg: '#efe9fb',
    archGroupBorderColor: '#9aa8c0',
    archEdgeColor: '#5f6c85',
    archEdgeArrowColor: '#5f6c85',
  }),
});

// 各图种自己的一组主题变量(base 主题不推导它们,默认值是给白底准备的:暗色下成了黑字黑线)。
// 2026-10-04 五路走查逐个对过 vendor 包里的键名;只给暗色需要的那一半时,浅色沿用 mermaid 默认。
const MERMAID_TYPE_THEMES = Object.freeze({
  dark: Object.freeze({
    packet: { startByteColor: '#aab7cc', endByteColor: '#aab7cc', labelColor: '#e9edf5', titleColor: '#e9edf5', blockStrokeColor: '#5b7de3', blockFillColor: '#22335a' },
    treeView: { labelColor: '#e9edf5', lineColor: '#8fa0b8', iconColor: '#8fa0b8' },
    cynefin: { complexBg: '#1f3a33', complicatedBg: '#1f2f4f', chaoticBg: '#4a2a2f', clearBg: '#4a3f24', confusionBg: '#3a2a4f' },
    radar: { axisColor: '#8fa0b8', graticuleColor: '#8fa0b8', graticuleOpacity: 0.15 },
  }),
  light: Object.freeze({
    packet: { startByteColor: '#5f6c85', endByteColor: '#5f6c85', labelColor: '#1b2436', titleColor: '#1b2436', blockStrokeColor: '#7d97dc', blockFillColor: '#e7edfa' },
    treeView: { labelColor: '#1b2436', lineColor: '#5f6c85', iconColor: '#5f6c85' },
  }),
});
// gitGraph 的 HIGHLIGHT 提交标记(gitInv*):mermaid 由压暗/提亮后的分支色反推,深底上 1.6:1、浅底上 1.5:1。
const MERMAID_GIT_HIGHLIGHT = Object.freeze({ dark: '#ffd166', light: '#b7791f' });

// mermaid.initialize 的 themeVariables:主题色板 + 分类色展开。
// base 主题在暗色下会把 cScale 再压暗 75%(分支几乎成黑块)、git 色再提亮,显式给值才稳得住;
// cScalePeer / cScaleInv 由压暗后的值推导,也一并给。
export function mermaidThemeVariables(theme, fontFamily) {
  const palette = MERMAID_PALETTES[theme === 'light' ? 'light' : 'dark'];
  const vars = { ...palette };
  MERMAID_CATEGORICAL.forEach((color, i) => {
    vars[`pie${i + 1}`] = color;
    vars[`cScale${i}`] = color;
    vars[`cScalePeer${i}`] = color;
    vars[`cScaleInv${i}`] = '#ffffff';
    vars[`cScaleLabel${i}`] = '#ffffff';
    if (i < 8) {
      vars[`git${i}`] = color;
      vars[`gitBranchLabel${i}`] = '#ffffff';
      vars[`gitInv${i}`] = MERMAID_GIT_HIGHLIGHT[theme === 'light' ? 'light' : 'dark'];
      vars[`venn${i + 1}`] = color;   // 维恩图:base 主题推导成主色压暗 30%,深底上近黑
    }
  });
  for (const [key, value] of Object.entries(MERMAID_TYPE_THEMES[theme === 'light' ? 'light' : 'dark'])) vars[key] = { ...value };
  vars.xyChart = {
    backgroundColor: palette.background,
    titleColor: palette.titleColor,
    xAxisLabelColor: palette.textColor,
    xAxisTitleColor: palette.textColor,
    xAxisTickColor: palette.lineColor,
    xAxisLineColor: palette.lineColor,
    yAxisLabelColor: palette.textColor,
    yAxisTitleColor: palette.textColor,
    yAxisTickColor: palette.lineColor,
    yAxisLineColor: palette.lineColor,
    plotColorPalette: MERMAID_CATEGORICAL.join(','),
    legendTextColor: palette.textColor,   // 修前回落到默认主题的 #131300:暗色下图例是黑字
    dataLabelColor: palette.textColor,
  };
  if (fontFamily) vars.fontFamily = fontFamily;
  return vars;
}

// 色板管不到的两处线色,用 mermaid 的 themeCSS 补(它会被 mermaid 按图 id 作用域化,只影响这张图):
//   · 甘特图网格线:d3 坐标轴把刻度线写成 stroke="currentColor",继承的是页面正文色 ——
//     暗色下成了一排亮白竖线,亮色下是一排深色竖线;改回 gridColor。
//   · 时间线 / 思维导图的主轴与事件虚线:mermaid 拿分支标签色(cScaleLabel,我们给的白)描线,
//     亮色下整条轴看不见;改回 lineColor。
//   · 暗色下桑基图的流带:mermaid 在元素上内联写死 mix-blend-mode:multiply,深底上正片叠底成一片近黑,
//     只能 !important 盖回 normal(浅色下叠底本来就对,不动);节点名压在流带上,给一圈底色描边。
//   · 时间线事件框:mermaid 自带 filter:brightness(120%),把分支色提亮到白字只剩 2.9:1。
//   · ER 的「零或一 / 零或多」端点圆:标记里写死 fill="white",暗色下是一颗实心白点(浅色下是空心圈)。
//   · 暗色下的 C4:关系线、关系文字、边界框写死 #444444(没有主题变量),深底上几乎看不见。
//   · 暗色下的事件建模图:泳道写死近白底,泳道名与浅色卡片上的浅字都读不出。
//   · 浅色下的树图:父级标题是白字压在 60% 透明的浅蓝上。
export function mermaidThemeCss(theme) {
  const dark = theme !== 'light';
  const palette = MERMAID_PALETTES[dark ? 'dark' : 'light'];
  const rules = [
    `.grid .tick line { stroke: ${palette.gridColor}; }`,
    `.lineWrapper line { stroke: ${palette.lineColor}; }`,
    '.eventWrapper { filter: none; }',
    `.marker.zeroOrOne circle, .marker.zeroOrMore circle { fill: ${palette.background}; }`,
  ];
  if (dark) {
    rules.push(
      'g.links > g.link { mix-blend-mode: normal !important; }',
      `.node-labels text { paint-order: stroke; stroke: ${palette.background}; stroke-width: 3px; }`,
      'text[fill="#444444"] { fill: #aab7cc; }',
      'line[stroke="#444444"], path[stroke="#444444"] { stroke: #8fa0b8; }',
      'rect[stroke="#444444"] { stroke: #5f7090; }',
      '.em-swimlane rect { fill: #1f2a40; stroke: #33425e; }',
      '.em-swimlane text { fill: #c4cee0; }',
      '.em-box foreignObject { color: #1b2436; }',
    );
  } else {
    rules.push('.treemapSectionLabel, .treemapSectionValue { fill: #1b2436 !important; }');
  }
  return rules.join('\n');
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

// mermaid 11.17.2 默认的 secure 名单(指令改不动的键);在它之上再锁主题三件。
// 运行时还会并上库自己报的那份(升级 vendor 后新增的键不会被这份写死的清单漏掉)。
const MERMAID_SECURE_DEFAULTS = Object.freeze(['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'suppressErrorRendering', 'maxEdges']);
function secureKeys(lib) {
  let fromLib = [];
  try {
    const api = lib && lib.mermaidAPI;
    const site = api && typeof api.getSiteConfig === 'function' ? api.getSiteConfig() : null;
    if (site && Array.isArray(site.secure)) fromLib = site.secure;
  } catch { fromLib = []; }
  return [...new Set([...MERMAID_SECURE_DEFAULTS, ...fromLib, 'theme', 'themeVariables', 'themeCSS'])];
}

// initialize 只在签名变化时重跑(首次 + 主题切换)。startOnLoad:false 阻止 mermaid 自行扫描全页。
function initializeOnce(lib, theme, fontFamily) {
  const signature = `${theme}|${fontFamily}`;
  if (initSignature === signature) return;
  try {
    lib.initialize({
      startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true,
      theme: 'base', themeVariables: mermaidThemeVariables(theme, fontFamily), themeCSS: mermaidThemeCss(theme), fontFamily,
      // 图里的 %%{init}%% / frontmatter config 不许改主题:作者写 theme:forest 时,forest 写死的节点底色与我们
      // 钉住的字色混在一起(暗色下浅字压浅绿,1.14:1)。布局类配置(curve、htmlLabels、gantt 边距 ……)照常生效。
      secure: secureKeys(lib),
    });
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

// 导出的 SVG 写上自然宽高:视图里的 <svg width="100%" style="max-width:…"> 拿到看图软件或 <img> 里
// 没有固有尺寸(实测宽图被量成 300×5)。
function exportableSvgMarkup(svg, markup) {
  if (!svg || typeof svg.cloneNode !== 'function') return markup;
  try {
    const { width, height } = svgNaturalSize(svg);
    const copy = svg.cloneNode(true);
    copy.setAttribute('width', String(Math.round(width)));
    copy.setAttribute('height', String(Math.round(height)));
    copy.style.maxWidth = 'none';
    copy.style.minWidth = '';
    return new globalThis.XMLSerializer().serializeToString(copy);
  } catch { return markup; }
}

function exportSvg(doc, view, notify) {
  const { svg, markup: raw } = svgMarkupOf(view);
  const markup = exportableSvgMarkup(svg, raw);
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
        // 先铺图的底色(paintSvgBackground 写在 SVG 上的那个):暗色图是浅字,透明 PNG 在白底看图器里看不见。
        const background = svg.style && svg.style.backgroundColor;
        if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, canvas.width, canvas.height); }
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
// 图落在一张实底卡片上(2026-10-03 用户反馈「浅色下点开图片后鼠标很容易看不到」:修前遮罩是半透明
// 毛玻璃、SVG 透明底,光标压在一片发白的糊底与图形混在一起)。卡片内边距写在这里而不是 CSS,
// 「适应窗口」的算式要用同一个数。
const VIEWER_STAGE_PAD = 20;

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
  stage.style.padding = `${VIEWER_STAGE_PAD}px`;
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
    const natural = svgNaturalSize(stage.querySelector('svg'));
    const svgW = natural.width + VIEWER_STAGE_PAD * 2;
    const svgH = natural.height + VIEWER_STAGE_PAD * 2;
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
  // 在遮罩空白处拖一下再松手,浏览器照样补发一次 click —— 修前这一下把灯箱关了(走查 2026-10-04)。
  // 记下「这一按动过」,随后那一次 click 不算点遮罩。
  let dragged = false;
  overlay.addEventListener('pointerdown', event => {
    const target = event && event.target;
    if (inside(target, controls)) return;
    if (target !== overlay && !inside(target, stage)) return;
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    dragged = false;
    const origin = { px: event.clientX || 0, py: event.clientY || 0, x: state.x, y: state.y };
    const move = e => {
      const dx = (e.clientX || 0) - origin.px;
      const dy = (e.clientY || 0) - origin.py;
      if (Math.abs(dx) + Math.abs(dy) > 4) dragged = true;
      state.x = origin.x + dx;
      state.y = origin.y + dy;
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
  // 滚轮缩放,以指针位置为锚(不缩放页面本身)。倍率随滚动量走:修前每个 wheel 事件一律 ×1.25,
  // 触控板一次轻扫发十几个小事件,一下就撞到 8 倍上限。单个事件仍封顶 ×1.25。
  overlay.addEventListener('wheel', event => {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    const rect = typeof overlay.getBoundingClientRect === 'function' ? overlay.getBoundingClientRect() : { left: 0, top: 0 };
    const cx = (event.clientX || 0) - (rect.left || 0);
    const cy = (event.clientY || 0) - (rect.top || 0);
    const delta = (Number(event.deltaY) || 0) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
    const factor = Math.min(VIEWER_ZOOM_STEP, Math.max(1 / VIEWER_ZOOM_STEP, Math.exp(-delta * 0.002)));
    zoomAt(cx, cy, state.scale * factor);
  }, { passive: false });
  overlay.addEventListener('keydown', event => {
    const key = event && event.key;
    // Ctrl/Alt/Meta 组合键留给浏览器(Ctrl± 页面缩放、Alt+← 后退),不抢。
    if (event && (event.ctrlKey || event.altKey || event.metaKey) && key !== 'Escape') return;
    if (key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMermaidViewer(doc);
      return;
    }
    // 键盘也能缩放 / 复位 / 平移(焦点在控制条按钮上时,方向键不抢)。
    const onButton = event.target && event.target.tagName === 'BUTTON';
    const pan = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[key];
    if (key === '+' || key === '=') zoomAtCenter(state.scale * VIEWER_ZOOM_STEP);
    else if (key === '-' || key === '_') zoomAtCenter(state.scale / VIEWER_ZOOM_STEP);
    else if (key === '0') fit();
    else if (pan && !onButton) { state.x += pan[0]; state.y += pan[1]; apply(); }
    else return;
    event.preventDefault();
  });
  // 点遮罩空白处退出;点在图或控制条上不退出;拖拽平移松手补发的那一次 click 也不算。
  overlay.onclick = event => {
    if (dragged) { dragged = false; return; }
    if (event && event.target === overlay) closeMermaidViewer(doc);
  };

  host.appendChild(overlay);
  doc.__ruyiMermaidViewer = overlay;
  fit();
  try {
    if (typeof overlay.focus === 'function') overlay.focus();
    else if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
  } catch { /* 测试桩无 focus 不致命 */ }
  return overlay;
}

// 复制图源(工具条与回落提示共用一份):复制的是模型写的原文,不是预处理后的那份。
function copySource(source, t, toast, notify) {
  try {
    const clipboard = globalThis.navigator && globalThis.navigator.clipboard;
    if (!clipboard) return;
    clipboard.writeText(source).then(
      () => { if (typeof toast === 'function') toast(t('toast.copyCode'), 'ok'); },
      () => notify.fail(),
    );
  } catch { notify.fail(); }
}

function buildToolbar(doc, ctx) {
  const bar = doc.createElement('div');
  bar.className = 'mermaid-tools';
  const { pre, view, source, t, toast, sourceOpen } = ctx;
  const notify = { fail: () => { if (typeof toast === 'function') toast(t('mermaid.exportFailed'), 'err'); } };
  const toggle = makeButton(doc, t('mermaid.toggleSource'), () => {
    const hidden = !pre.hidden;
    pre.hidden = hidden;
    if (pre.classList) pre.classList.toggle('mermaid-source-hidden', hidden);
    toggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
  });
  toggle.setAttribute('aria-expanded', sourceOpen ? 'true' : 'false');
  const copy = makeButton(doc, t('common.copy'), () => copySource(source, t, toast, notify));
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

// ── 渲染宽度 ──────────────────────────────────────────────────────────────────────
// mermaid 在私有离屏宿主里量版面;甘特图拿宿主的 offsetWidth 当画布宽。修前宿主是不定宽的
// fixed 块(收缩到内容宽),甘特图被排成三四百像素一条:任务条挤成小方块、刻度字互相压住。
// 现在宿主取图将落位的那一栏宽(减去 .mermaid-view 的内边距与边框);量不到(容器还没进文档 /
// 被折叠)时退到一个常见栏宽。
const MERMAID_VIEW_CHROME_PX = 26;
const MERMAID_FALLBACK_WIDTH = 760;
function renderWidthFor(wrapper) {
  let width = 0;
  try {
    width = Number(wrapper && wrapper.clientWidth) || 0;
    if (!width && wrapper && typeof wrapper.getBoundingClientRect === 'function') {
      width = Number(wrapper.getBoundingClientRect().width) || 0;
    }
  } catch { width = 0; }
  if (!(width > 0)) return MERMAID_FALLBACK_WIDTH;
  return Math.max(320, Math.floor(width - MERMAID_VIEW_CHROME_PX));
}

// SVG 自带底色:视图里与 .mermaid-view 的底同色(看不出差别),要紧的是灯箱与导出 ——
// 暗色图是浅字,透明底的 SVG/PNG 拿到看图软件的白底上就看不见了。
function paintSvgBackground(svg, theme) {
  if (!svg || !svg.style) return;
  const palette = MERMAID_PALETTES[theme === 'light' ? 'light' : 'dark'];
  try { svg.style.backgroundColor = palette.background; } catch { /* 测试桩无 style 写入不致命 */ }
}

// 在离屏宿主里收尾(它已挂进文档、有确定宽度):甘特图要量字宽,而调用方的容器可能还没进文档
// (逐条画好再一次性挂上的那些路径)。写入的仍是 mermaid 在 strict 下消毒过的那段 SVG,与写进视图同级。
function finishSvgInHost(host, markup, theme, source, labels) {
  try {
    host.innerHTML = markup;
    const svg = typeof host.querySelector === 'function' ? host.querySelector('svg') : null;
    if (!svg) return markup;
    paintSvgBackground(svg, theme);
    polishMermaidSvg(svg, { palette: MERMAID_PALETTES[theme === 'light' ? 'light' : 'dark'], source, labels });
    return host.innerHTML || markup;
  } catch { return markup; }
}

// 解析器原话的第一行(「Parse error on line 3:」之类),回落提示里给出来,好让用户把它连同源码贴回给模型。
function firstErrorLine(error) {
  const text = String((error && (error.message || error.str)) || error || '').trim();
  const line = text.split(/\r?\n/).find(part => part.trim()) || '';
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

// 一块图:先过 prepareMermaidSource(只改 mermaid 会静默画错的写法)再画;抛错就过一遍
// repairMermaidSource(只认今天必然解析失败的写法)再画一次。返回 { markup, error, repaired }。
async function renderOneSvg(doc, lib, item, theme, fontFamily) {
  initializeOnce(lib, theme, fontFamily);
  let prepared = item.source;
  try { prepared = prepareMermaidSource(item.source); } catch { prepared = item.source; }
  const attempts = [{ source: prepared, labels: null }];
  let markup = '';
  let error = null;
  let repaired = false;
  for (let i = 0; i < attempts.length && !markup; i += 1) {
    const attempt = attempts[i];
    try {
      markup = await renderAttempt(doc, lib, item, attempt.source, theme, attempt.labels);
      repaired = i > 0;
    } catch (failure) {
      if (!error) error = failure;
      if (i === 0) {
        let fix = null;
        try { fix = repairMermaidSource(prepared); } catch { fix = null; }
        if (fix && fix.source) attempts.push(fix);
      }
    }
  }
  return { markup, error: markup ? null : error, repaired };
}

async function renderAttempt(doc, lib, item, source, theme, labels) {
  renderSeq += 1;
  // Mermaid measures in the live DOM. Keep its temporary SVGs in a private,
  // offscreen host and always remove that host, including on parser failures.
  const renderHost = doc.createElement('div');
  renderHost.className = 'mermaid-render-host';
  renderHost.setAttribute('aria-hidden', 'true');
  renderHost.style.position = 'fixed';
  renderHost.style.left = '-100000px';
  renderHost.style.width = `${renderWidthFor(item.wrapper)}px`;
  (doc.body || doc.documentElement).appendChild(renderHost);
  try {
    const result = await lib.render(`ruyi-mermaid-${Date.now().toString(36)}-${renderSeq}`, source, renderHost);
    const markup = result && typeof result === 'object' ? String(result.svg || '') : String(result || '');
    if (!markup) throw new Error('empty render');
    return finishSvgInHost(renderHost, markup, theme, source, labels);
  } finally { renderHost.remove(); }
}

// ── 跟随亮暗切换 ──────────────────────────────────────────────────────────────────
// 修前图只在画的那一刻取主题:在亮色下画好、再切到暗色,旧图原样留着(浅紫节点压在深蓝底上,
// 时序图的消息字几乎看不见 —— 用户 2026-10-03 截图的就是这种)。现在监听 <html data-theme>,
// 把已画好、主题不符的块按新主题重画;源码哈希不变,所以只是换色,不改内容。
// 重画串行排队:连点切换时后一轮等前一轮画完再按【当时】的主题比对,最终一定收敛到当前主题。
const blockRenderOptions = new WeakMap();

function rethemeRenderedBlocks(doc) {
  const previous = doc.__ruyiMermaidRetheme || Promise.resolve();
  const next = previous.then(async () => {
    const theme = mermaidThemeFor(isDarkTheme(doc));
    let wrappers = [];
    try { wrappers = Array.from(doc.querySelectorAll('.mermaid-block[data-mermaid-state="ok"]')); } catch { wrappers = []; }
    for (const wrapper of wrappers) {
      const data = wrapper.dataset || {};
      if (!wrapper.isConnected || data.mermaidState !== 'ok' || data.mermaidTheme === theme) continue;
      const opts = blockRenderOptions.get(wrapper) || {};
      try { await renderMermaidBlocks(wrapper, { ...opts, document: doc }); } catch { /* 单块失败不挡后面的块 */ }
    }
  }).catch(() => {});
  doc.__ruyiMermaidRetheme = next;
  return next;
}

function watchThemeChanges(doc) {
  if (!doc || doc.__ruyiMermaidThemeWatch) return;
  const view = doc.defaultView || globalThis;
  const Observer = view && view.MutationObserver;
  if (typeof Observer !== 'function' || !doc.documentElement) return;
  try {
    const observer = new Observer(() => { rethemeRenderedBlocks(doc); });
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    doc.__ruyiMermaidThemeWatch = observer;
  } catch { /* 没有 MutationObserver 的宿主:不跟随切换,刷新页面后按新主题画 */ }
}

// 让一拍:优先 MessageChannel(后台标签页里 setTimeout 被节流到 1 s 一拍,8 张图要等 8 s),没有再退 setTimeout。
function yieldToEventLoop() {
  return new Promise(resolve => {
    const Channel = globalThis.MessageChannel;
    if (typeof Channel !== 'function') { setTimeout(resolve, 0); return; }
    const channel = new Channel();
    channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
    channel.port2.postMessage(0);
  });
}

// 宽图别缩成一条:.mermaid-view svg 的 max-width:100% 会把 30 个节点的横向流程图压到 0.2 倍(字 3px)。
// 给 SVG 一个最小宽度 = 自然宽度的 0.6 倍,再宽就让 .mermaid-view(overflow-x:auto)横向滚;
// 想看全貌点开放大。灯箱与导出各自写死宽高,不受它影响。
const MERMAID_MIN_SCALE = 0.6;
function applyScaleFloor(view) {
  const svg = view && typeof view.querySelector === 'function' ? view.querySelector('svg') : null;
  if (!svg || !svg.style) return;
  try {
    const { width } = svgNaturalSize(svg);
    if (width > 0) svg.style.minWidth = `${Math.round(width * MERMAID_MIN_SCALE)}px`;
  } catch { /* 量不到就不设 */ }
}

// 回落成源码:源码照常显示,下面一行提示;画失败时再补一行解析器原话(第几行出的错),
// 再给一枚「复制」—— 普通代码块有复制钮,图的回落修前没有(走查 2026-10-04)。
function degrade(doc, wrapper, pre, hash, theme, message, extra = {}) {
  resetWrapper(wrapper, pre);
  pre.hidden = false;
  if (pre.classList) pre.classList.remove('mermaid-source-hidden');
  const hint = doc.createElement('div');
  hint.className = 'mermaid-hint';
  hint.textContent = message;
  wrapper.appendChild(hint);
  const { detail, source, t, toast } = extra;
  if (detail && typeof t === 'function') {
    const line = doc.createElement('div');
    line.className = 'mermaid-hint mermaid-hint-detail';
    line.textContent = t('mermaid.renderFailedDetail', { detail });
    wrapper.appendChild(line);
  }
  if (typeof source === 'string' && typeof t === 'function') {
    const bar = doc.createElement('div');
    bar.className = 'mermaid-tools';
    const notify = { fail: () => { if (typeof toast === 'function') toast(t('mermaid.exportFailed'), 'err'); } };
    bar.appendChild(makeButton(doc, t('common.copy'), () => copySource(source, t, toast, notify)));
    wrapper.appendChild(bar);
  }
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
    // 同一份源码换主题重画(切亮暗)时记下旧状态:画失败就留着旧图,「源码」开着的就还开着。
    const recolor = data.mermaidState === 'ok' && data.mermaidHash === hash;
    const previous = recolor ? { theme: data.mermaidTheme, sourceOpen: pre.hidden === false } : null;
    wrapper.dataset.mermaidHash = hash;
    wrapper.dataset.mermaidTheme = theme;
    wrapper.dataset.mermaidState = 'pending';
    pending.push({ code, pre, wrapper, source, hash, previous });
  }
  if (!pending.length) return 0;

  let lib = null;
  try { lib = await ensure({ document: doc }); } catch { lib = null; }
  if (!lib || typeof lib.render !== 'function') {
    for (const item of pending) degrade(doc, item.wrapper, item.pre, item.hash, theme, t('mermaid.fallbackHint'), { source: item.source, t, toast });
    return 0;
  }
  watchThemeChanges(doc);
  const fontFamily = appFontFamily(doc);

  let rendered = 0;
  for (const [index, item] of pending.entries()) {
    // 一条回复里有好几张图时,块与块之间让一拍主线程(修前 8 张图连着画,一个长任务卡 0.9 s)。
    if (index > 0) await yieldToEventLoop();
    blockRenderOptions.set(item.wrapper, { t: opts.t, toast: opts.toast, ensure: opts.ensure });
    let outcome = { markup: '', error: null, repaired: false };
    try { outcome = await enqueueRender(() => renderOneSvg(doc, lib, item, theme, fontFamily)); } catch { outcome = { markup: '', error: null, repaired: false }; }
    const svgMarkup = outcome.markup;
    if (!svgMarkup) {
      const oldView = item.previous && typeof item.wrapper.querySelector === 'function' ? item.wrapper.querySelector('.mermaid-view') : null;
      if (oldView) {
        // 换色重画失败:旧图还是对的内容,留着它,只把状态还原(不降级成源码 + 报错)。
        item.wrapper.dataset.mermaidTheme = item.previous.theme;
        item.wrapper.dataset.mermaidState = 'ok';
        continue;
      }
      degrade(doc, item.wrapper, item.pre, item.hash, theme, t('mermaid.renderFailed'),
        { detail: firstErrorLine(outcome.error), source: item.source, t, toast });
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
    const sourceOpen = Boolean(item.previous && item.previous.sourceOpen);
    const toolbar = buildToolbar(doc, { pre: item.pre, view, source: item.source, t, toast, sourceOpen });
    if (typeof item.pre.before === 'function') {
      item.pre.before(view);
      item.pre.before(toolbar);
    } else {
      item.wrapper.appendChild(view);
      item.wrapper.appendChild(toolbar);
    }
    item.pre.hidden = !sourceOpen;
    if (item.pre.classList) item.pre.classList.toggle('mermaid-source-hidden', !sourceOpen);
    applyScaleFloor(view);
    if (outcome.repaired) item.wrapper.dataset.mermaidRepaired = '1';
    else if (item.wrapper.dataset) delete item.wrapper.dataset.mermaidRepaired;
    item.wrapper.dataset.mermaidState = 'ok';
    rendered += 1;
  }
  // 画的过程中主题变了(长回复里几张图还在画、用户点了切换):这一轮按开始时的主题画完,再交给重画队列
  // 按当前主题补一遍 —— 切换那一刻这些块还是 pending,rethemeRenderedBlocks 看不见它们。
  if (opts.isDark === undefined && doc.__ruyiMermaidThemeWatch && mermaidThemeFor(isDarkTheme(doc)) !== theme) {
    rethemeRenderedBlocks(doc);
  }
  return rendered;
}
