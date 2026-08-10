'use strict';
// 如意 Ruyi — SVG 线性图标集(UI v3 §2.15)。零依赖原生 ES module,无构建步。
//
// icon(name, size=16) → SVGElement,用 createElementNS + setAttribute 构建(不碰 innerHTML → XSS 安全)。
// 风格基准:24×24 viewBox,stroke=currentColor(随文字色/引擎色继承),stroke-width 1.5,圆角线帽/连接,
// 与如意云头曲线的圆角线条呼应;青花蓝单色由使用处 color 决定,hover 由外层类切换。
// 少数图标(sparkles / more / stop / theme)用 fill:currentColor 的实心形以求辨识度。
const NS = 'http://www.w3.org/2000/svg';
const F = { fill: 'currentColor', stroke: 'none' }; // 实心形复用

// 每个键 = 一枚图标,值 = 形状列表 [tag, attrs]。KEY 行以「  name: [」起头(供静态测试正则计数)。
const ICONS = {
  folder: [['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }]],
  shield: [['path', { d: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' }]],
  toolbox: [
    ['rect', { x: '2.5', y: '8.5', width: '19', height: '11', rx: '1.8' }],
    ['path', { d: 'M8 8.5V6.5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ['path', { d: 'M2.5 13h19' }],
    ['path', { d: 'M10 13v2.5h4V13' }],
  ],
  paperclip: [['path', { d: 'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48' }]],
  sparkles: [
    ['path', { d: 'M11 3.5C11 7 14 10 17.5 10 14 10 11 13 11 16.5 11 13 8 10 4.5 10 8 10 11 7 11 3.5Z', ...F }],
    ['path', { d: 'M18.7 3.2c0 1.3 1 2.3 2.3 2.3-1.3 0-2.3 1-2.3 2.3 0-1.3-1-2.3-2.3-2.3 1.3 0 2.3-1 2.3-2.3Z', ...F }],
  ],
  trace: [['path', { d: 'M3 12h4l2.2-4.2 4.1 8.4 2.3-4.2H21' }]],
  agents: [
    ['circle', { cx: '9', cy: '8', r: '3' }],
    ['path', { d: 'M3.5 20v-1.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.5 4.5V20' }],
    ['circle', { cx: '17.5', cy: '9.5', r: '2.5' }],
    ['path', { d: 'M15.5 15.2h1.7a3.8 3.8 0 0 1 3.8 3.8v1' }],
  ],
  send: [
    ['path', { d: 'M22 2 11 13' }],
    ['path', { d: 'M22 2 15 22 11 13 2 9 22 2Z' }],
  ],
  stop: [['rect', { x: '6', y: '6', width: '12', height: '12', rx: '2.5', ...F }]],
  settings: [
    ['circle', { cx: '12', cy: '12', r: '3' }],
    ['path', { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' }],
  ],
  stethoscope: [
    ['path', { d: 'M4 4v5a5 5 0 0 0 10 0V4' }],
    ['circle', { cx: '4', cy: '3', r: '1' }],
    ['circle', { cx: '14', cy: '3', r: '1' }],
    ['path', { d: 'M9 14v2.5a4.5 4.5 0 0 0 9 0V15' }],
    ['circle', { cx: '18', cy: '13', r: '2' }],
  ],
  help: [
    ['circle', { cx: '12', cy: '12', r: '9.5' }],
    ['path', { d: 'M9.2 9.2a3 3 0 0 1 5.6 1c0 2-3 2.5-3 4' }],
    ['path', { d: 'M12 17.5h.01' }],
  ],
  menu: [['path', { d: 'M3.5 6h17M3.5 12h17M3.5 18h17' }]],
  more: [
    ['circle', { cx: '5.5', cy: '12', r: '1.4', ...F }],
    ['circle', { cx: '12', cy: '12', r: '1.4', ...F }],
    ['circle', { cx: '18.5', cy: '12', r: '1.4', ...F }],
  ],
  collapse: [['path', { d: 'M11 18l-6-6 6-6M19 18l-6-6 6-6' }]],
  compress: [['path', { d: 'M8 3v5H3M21 8h-5V3M3 16h5v5M16 21v-5h5' }]],
  theme: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['path', { d: 'M12 3a9 9 0 0 0 0 18Z', ...F }],
  ],
  wrench: [['path', { d: 'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z' }]],
  plus: [['path', { d: 'M12 5v14M5 12h14' }]],
  search: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['path', { d: 'M21 21l-4.35-4.35' }],
  ],
  refresh: [
    ['path', { d: 'M23 4v6h-6' }],
    ['path', { d: 'M1 20v-6h6' }],
    ['path', { d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10' }],
    ['path', { d: 'M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }],
  ],
  trash: [
    ['path', { d: 'M3 6h18' }],
    ['path', { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }],
    ['path', { d: 'M10 11v6M14 11v6' }],
  ],
  pin: [['path', { d: 'M9 3.5h6M10.5 3.5l-.5 6-2 2v1.5h8V11l-2-2-.5-6M12 15v5.5' }]],
  edit: [['path', { d: 'M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' }]],
  close: [['path', { d: 'M18 6 6 18M6 6l12 12' }]],
  monitor: [
    ['rect', { x: '2.5', y: '4', width: '19', height: '12', rx: '1.5' }],
    ['path', { d: 'M8.5 20h7M12 16v4' }],
  ],
  // 第89波(Pretender/Escapade 图标统一):全部对齐 trace 思考标识的线条语言 —— 24×24、1.5 描边、
  // currentColor、圆角线帽、单线无填充(仅 target 中心点用实心求辨识度)。文本字形/emoji 一律退场。
  dispatch: [
    ['circle', { cx: '4.5', cy: '12', r: '1.5' }],
    ['path', { d: 'M6.4 12H13' }],
    ['path', { d: 'M13 12c0-2.1 1.3-3.9 3.6-4.6M13 12c0 2.1 1.3 3.9 3.6 4.6' }],
    ['circle', { cx: '19', cy: '7', r: '1.6' }],
    ['circle', { cx: '19', cy: '17', r: '1.6' }],
  ],
  sheet: [
    ['rect', { x: '4', y: '5', width: '16', height: '15.5', rx: '2' }],
    ['path', { d: 'M9.5 5V3.5h5V5' }],
    ['path', { d: 'M8 10.5h8M8 14h8M8 17.5h5' }],
  ],
  resume: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M10.2 8.8 15.4 12l-5.2 3.2z' }],
  ],
  pause: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M10 9.5v5M14 9.5v5' }],
  ],
  takeover: [
    ['circle', { cx: '12', cy: '7', r: '3.5' }],
    ['path', { d: 'M5.5 20v-1.5A6.5 6.5 0 0 1 12 12a6.5 6.5 0 0 1 6.5 6.5V20' }],
  ],
  playbook: [
    ['path', { d: 'M12 6.4C10.4 5 8 4.4 5.4 4.4v13.6c2.6 0 5 .6 6.6 2 1.6-1.4 4-2 6.6-2V4.4C16 4.4 13.6 5 12 6.4z' }],
    ['path', { d: 'M12 6.4V20' }],
  ],
  archive: [
    ['path', { d: 'M4 7.5h16l-1 11.4a2 2 0 0 1-2 1.8H7a2 2 0 0 1-2-1.8z' }],
    ['path', { d: 'M4 7.5V5.2A1.7 1.7 0 0 1 5.7 3.5h12.6A1.7 1.7 0 0 1 20 5.2v2.3' }],
    ['path', { d: 'M9.8 11.5h4.4' }],
  ],
  dockArchive: [
    ['path', { d: 'M5 10.5h14v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2z' }],
    ['path', { d: 'M3.8 6.5h16.4v4H3.8z' }],
    ['path', { d: 'M12 3.5v8M9.5 9l2.5 2.5L14.5 9' }],
  ],
  dockPin: [
    ['path', { d: 'M8.5 4h7l-1 5 2.5 2.5V13H7v-1.5L9.5 9z' }],
    ['path', { d: 'M12 13v7' }],
  ],
  needs: [
    ['circle', { cx: '9', cy: '8', r: '3' }],
    ['path', { d: 'M3.5 20v-1.5A4.5 4.5 0 0 1 8 14h2a4.5 4.5 0 0 1 4.5 4.5V20' }],
    ['path', { d: 'M17.8 10v5.2M17.8 18.9h.01' }],
  ],
  narrative: [
    ['path', { d: 'M6 3.5h8.5L19 8v11.2a1.8 1.8 0 0 1-1.8 1.8H6.8A1.8 1.8 0 0 1 5 19.2V5.3A1.8 1.8 0 0 1 6 3.5z' }],
    ['path', { d: 'M14.5 3.5V8H19' }],
    ['path', { d: 'M8 14c1.2-1.4 2.4 1.4 3.6 0s2.4 1.4 3.6 0' }],
  ],
  ledger: [
    ['path', { d: 'M5 4.8A1.8 1.8 0 0 1 6.8 3h11a1.7 1.7 0 0 1 1.7 1.7v14.6a1.7 1.7 0 0 1-1.7 1.7h-11A1.8 1.8 0 0 1 5 19.2z' }],
    ['path', { d: 'M8.5 8h7M8.5 11.5h7M8.5 15h4.5' }],
  ],
  raw: [
    ['rect', { x: '3.5', y: '4.5', width: '17', height: '15', rx: '2' }],
    ['path', { d: 'M7 9l3 3-3 3' }],
    ['path', { d: 'M12.5 15h4.5' }],
  ],
  done: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['path', { d: 'M8.2 12.2l2.6 2.6 5-5.4' }],
  ],
  back: [
    ['path', { d: 'M19 12H5.5' }],
    ['path', { d: 'M10.5 6.5 5 12l5.5 5.5' }],
  ],
  go: [
    ['path', { d: 'M5 12h13.5' }],
    ['path', { d: 'M13.5 6.5 19 12l-5.5 5.5' }],
  ],
  open: [
    ['path', { d: 'M7 17 17 7' }],
    ['path', { d: 'M9.5 7H17v7.5' }],
  ],
  bell: [
    ['path', { d: 'M18 9a6 6 0 0 0-12 0c0 4.3-1.2 6.2-2.4 7.2h16.8C19.2 15.2 18 13.3 18 9z' }],
    ['path', { d: 'M10.2 19.4a2 2 0 0 0 3.6 0' }],
  ],
  quickask: [['path', { d: 'M13 3 5.8 13h4.7L9 21l7.2-10h-4.7z' }]],
  mail: [
    ['rect', { x: '3', y: '5.5', width: '18', height: '13', rx: '2' }],
    ['path', { d: 'M4 7.5l8 5.8 8-5.8' }],
  ],
  cloud: [['path', { d: 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z' }]],
  target: [
    ['circle', { cx: '12', cy: '12', r: '8.5' }],
    ['circle', { cx: '12', cy: '12', r: '4.8' }],
    ['circle', { cx: '12', cy: '12', r: '1.4', ...F }],
  ],
  ticket: [
    ['path', { d: 'M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.5a2.5 2.5 0 0 0 0 5V16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-1.5a2.5 2.5 0 0 0 0-5z' }],
    ['path', { d: 'M13.5 8.5v2M13.5 13.4v2' }],
  ],
  down: [
    ['path', { d: 'M12 4.5V19' }],
    ['path', { d: 'M6 13l6 6 6-6' }],
  ],
  minus: [['path', { d: 'M5 12h14' }]],
};

// name → SVGElement(未知名返回 null + warn)。
export function icon(name, size = 16) {
  const shapes = ICONS[name];
  if (!shapes) { console.warn('[icons] unknown icon:', name); return null; }
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.classList.add('ic');
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    svg.appendChild(node);
  }
  return svg;
}

export function iconNames() { return Object.keys(ICONS); }

// 启动时把带 [data-icon] 的静态元素填充为 SVG(prepend 到首子节点前;幂等,已填充跳过)。
// 可选 data-icon-size 覆盖尺寸。用于 index.html 里不随 JS 改文案的静态 chrome 按钮/徽标。
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(elm => {
    if (elm.dataset.iconized === '1') return;
    const svg = icon(elm.getAttribute('data-icon'), parseInt(elm.getAttribute('data-icon-size') || '16', 10));
    if (!svg) return;
    elm.insertBefore(svg, elm.firstChild);
    elm.dataset.iconized = '1';
  });
}
