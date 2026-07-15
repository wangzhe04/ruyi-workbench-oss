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
