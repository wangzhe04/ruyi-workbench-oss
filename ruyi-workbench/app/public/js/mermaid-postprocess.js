'use strict';
// 109c(2026-10-04 五路走查):mermaid 画完之后、写进视图之前,在离屏宿主里对 SVG 做的收尾。
// 宿主已挂进文档、有确定宽度,所以这里量得到字宽与计算样式;只动本模块刚拿到的那份 SVG,
// 灯箱与导出拿到的也是收尾后的这一份。每一步都包在 try 里:收尾失败就保留 mermaid 的原样输出。
//
// 导出:polishMermaidSvg(svg, { palette, source, labels })。

// ── 颜色小工具 ────────────────────────────────────────────────────────────────────
function parseColor(value) {
  const text = String(value || '').trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (m) {
    const hex = m[1].length === 3 ? m[1].replace(/./g, c => c + c) : m[1];
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(text);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some(n => !Number.isFinite(n))) return null;
  return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 && Number.isFinite(parts[3]) ? parts[3] : 1 };
}
function luminance({ r, g, b }) {
  const f = v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
const over = (top, bottom) => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});
const toCss = c => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

function computed(el) {
  try {
    const view = el.ownerDocument && el.ownerDocument.defaultView;
    return view && typeof view.getComputedStyle === 'function' ? view.getComputedStyle(el) : null;
  } catch { return null; }
}

// ── ① 链接一律失效 ───────────────────────────────────────────────────────────────
// securityLevel:'strict' 只拦 call 回调与 javascript: 链接;click X href "https://…"、标签里的 <a href>、
// kanban 的 ticketBaseUrl 仍会画成 <a xlink:href>,点一下整个工作台页面就被导走(桌面壳只接新窗口请求)。
// 图里的链接没有用处、只有风险:去掉 href / target,点图仍是打开放大查看。
function inertLinks(svg) {
  for (const anchor of Array.from(svg.querySelectorAll('a'))) {
    anchor.removeAttribute('href');
    anchor.removeAttribute('target');
    anchor.removeAttribute('xlink:href');
    try { anchor.removeAttributeNS('http://www.w3.org/1999/xlink', 'href'); } catch { /* 不支持命名空间的宿主 */ }
  }
}

// ── ② 桑基图:把 ASCII 代号换回中文节点名(见 mermaid-source.js 的 aliasSankey)──────────
function restoreSankeyLabels(svg, labels) {
  if (!labels) return;
  for (const text of Array.from(svg.querySelectorAll('text'))) {
    const content = String(text.textContent || '');
    const m = /^(N\d+x)(?=\s|$)/.exec(content);   // 只认整段代号(真实节点名 N1xa 不被当成 N1x)
    if (m && Object.prototype.hasOwnProperty.call(labels, m[1])) text.textContent = labels[m[1]] + content.slice(m[1].length);
  }
}

// ── ③ 甘特图 ──────────────────────────────────────────────────────────────────────
//   · 刻度按 d3 默认约 10 格取:6 天的跨度会落到 12 小时一格,axisFormat 只到「日」时同一日期连标两遍
//     (用户截图里的 10-05 10-05 10-06 …)。与前一格同字的整格去掉(连同那条网格线,剩下的线正好落在日界上);
//     源码自己写了 tickInterval 时刻度是作者要的,只摘重复的字不摘线。剩下的字若仍互相压住,按实测字宽隔开、
//     只摘字不摘线(量不到字宽的环境只做去重)。上下两条坐标轴(gantt.topAxis)是两个 g.grid,各算各的。
//   · 「今天」那条线无条件画:今天落在排期范围外时,它压在左侧区段标题上。超出任务范围就去掉。
//   · click 指令在 strict 下不接线,但 mermaid 照样给任务条加 .clickable(粗体 + 链接色):
//     浅色下 #2050c8 的字压在 #3f63d0 的条上 1.2:1。既然点不动,就不装成能点。
//   · 落在最后一天的短里程碑名:mermaid 算位置与算对齐用了两个宽度,字压在菱形上。挪回菱形左侧。
function translateXOf(node) {
  const transform = node && typeof node.getAttribute === 'function' ? node.getAttribute('transform') : '';
  const match = /translate\(\s*(-?[\d.]+)/.exec(String(transform || ''));
  return match ? Number(match[1]) : NaN;
}
function tidyGanttAxis(grid, explicitTicks) {
  let previous = null;
  let lastRight = -Infinity;
  for (const tick of Array.from(grid.querySelectorAll('.tick'))) {
    const text = tick.querySelector('text');
    if (!text) continue;
    const label = String(text.textContent || '');
    if (label && label === previous) { (explicitTicks ? text : tick).remove(); continue; }
    previous = label;
    let width = 0;
    try { width = text.getBBox().width; } catch { width = 0; }
    const x = translateXOf(tick);
    if (!(width > 0) || !Number.isFinite(x)) continue;
    if (x - width / 2 < lastRight + 6) { text.remove(); continue; }
    lastRight = x + width / 2;
  }
}
export function tidyGanttSvg(svg, { explicitTicks = false } = {}) {
  if (!svg || typeof svg.querySelectorAll !== 'function') return;
  if (svg.getAttribute('aria-roledescription') !== 'gantt') return;
  for (const grid of Array.from(svg.querySelectorAll('g.grid'))) tidyGanttAxis(grid, explicitTicks);
  const today = svg.querySelector('line.today');
  if (today) {
    const x = Number(today.getAttribute('x1'));
    let min = Infinity;
    let max = -Infinity;
    for (const bar of Array.from(svg.querySelectorAll('rect.task'))) {
      const left = Number(bar.getAttribute('x'));
      const right = left + Number(bar.getAttribute('width'));
      if (Number.isFinite(left)) min = Math.min(min, left);
      if (Number.isFinite(right)) max = Math.max(max, right);
    }
    if (Number.isFinite(x) && Number.isFinite(min) && Number.isFinite(max) && (x < min - 1 || x > max + 1)) {
      const group = today.parentNode;
      if (group && group.classList && group.classList.contains('today')) group.remove();
      else today.remove();
    }
  }
  for (const node of Array.from(svg.querySelectorAll('.clickable'))) node.classList.remove('clickable');
  for (const text of Array.from(svg.querySelectorAll('text.milestoneText.taskTextOutsideLeft'))) {
    const id = String(text.getAttribute('id') || '');
    if (!id.endsWith('-text')) continue;
    const diamond = svg.querySelector(`[id="${id.slice(0, -5).replace(/"/g, '\\"')}"]`);
    const textX = Number(text.getAttribute('x'));
    const diamondX = diamond ? Number(diamond.getAttribute('x')) : NaN;
    if (Number.isFinite(textX) && Number.isFinite(diamondX) && textX > diamondX) text.setAttribute('x', String(diamondX - 5));
  }
}

// ── ④ 象限图:viewBox 写死 500 宽,贴边的点名被裁掉。左右各放 70px ──────────────────────
function widenQuadrant(svg) {
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (!vb || !vb.width || !vb.height) return;
  const pad = 70;
  svg.setAttribute('viewBox', `${vb.x - pad} ${vb.y} ${vb.width + pad * 2} ${vb.height}`);
  const maxWidth = parseFloat(svg.style && svg.style.maxWidth);
  if (Number.isFinite(maxWidth)) svg.style.maxWidth = `${maxWidth + pad * 2}px`;
}

// ── ⑤ xychart:类别多、名字长时横轴标签挤成一团。按实测字宽隔开 ──────────────────────────
// 每个标签各带一层 transform,getBBox 量的是各自的局部坐标 —— 用屏幕坐标比。
function thinXyAxisLabels(svg) {
  let lastRight = -Infinity;
  const labels = Array.from(svg.querySelectorAll('.bottom-axis .label text'))
    .map(text => ({ text, box: text.getBoundingClientRect() }))
    .filter(item => item.box.width > 0)
    .sort((a, b) => a.box.left - b.box.left);
  for (const { text, box } of labels) {
    if (box.left < lastRight + 4) { text.remove(); continue; }
    lastRight = box.right;
  }
}

// ── ⑥ 对比度兜底 ─────────────────────────────────────────────────────────────────
// 模型常写 style A fill:#f9f / classDef ok fill:#d4edda / 时序图 rect rgb(191,223,255) / linkStyle stroke:#333:
// 这些颜色是给白底准备的。我们的色板钉住了字色与线色,暗色下浅字压浅底(1.05:1),浅色下深字压深底。
// mermaid 从不自动配字色,这里补:
//   a. 时序图的 rect / box 高亮块:降低填充不透明度,直到主题字色在上面 ≥ 4.5:1(箭头与字一起读得清);
//   b. 每一段文字:找它身后最上层的填充形状(含 HTML 标签自己的底色),对比不足 3.5:1 就换成深墨或白;
//   c. 连线:与图底对比不足 2:1 的描边改回主题线色(连同它引用的箭头标记)。
const INK_DARK = { r: 27, g: 36, b: 54, a: 1 };       // --ink(浅色主题)
const INK_LIGHT = { r: 255, g: 255, b: 255, a: 1 };
function fadeSequenceRegions(svg, background, ink) {
  for (const rect of Array.from(svg.querySelectorAll('rect.rect'))) {
    const style = computed(rect);
    const fill = style && parseColor(style.fill);
    if (!fill) continue;
    let opacity = Number.parseFloat(style.fillOpacity || '1');
    if (!Number.isFinite(opacity)) opacity = 1;
    const start = opacity;
    while (opacity > 0.12 && contrast(ink, over({ ...fill, a: fill.a * opacity }, background)) < 4.5) opacity -= 0.08;
    if (opacity < start) rect.style.setProperty('fill-opacity', String(Math.max(0.12, Number(opacity.toFixed(2)))));
  }
}
// 要判对比度的文字:SVG 里有 tspan 的按 tspan 判(它们常有自己的 fill 规则,在 <text> 上改色盖不住),
// 没有的按 <text> 判;foreignObject 里取自己带文字节点的那一层。
// 时序图 autonumber 的序号画在箭头标记(<marker>)那颗圆上,标记形状不计入「身后的底」,
// 按图底判会把本来对的字色翻掉 —— 跳过。
function textElements(svg) {
  const found = [];
  for (const text of Array.from(svg.querySelectorAll('text'))) {
    if (text.closest('.sequenceNumber, marker, defs') || text.classList.contains('sequenceNumber')) continue;
    const spans = Array.from(text.querySelectorAll('tspan')).filter(span => !span.querySelector('tspan'));
    for (const el of spans.length ? spans : [text]) {
      if (String(el.textContent || '').trim()) found.push({ el, html: false });
    }
  }
  for (const fo of Array.from(svg.querySelectorAll('foreignObject'))) {
    for (const el of Array.from(fo.querySelectorAll('*'))) {
      const own = Array.from(el.childNodes || []).some(n => n.nodeType === 3 && String(n.textContent || '').trim());
      if (own) found.push({ el, html: true });
    }
  }
  return found;
}
function htmlBackdrop(el, stop) {
  for (let node = el; node && node !== stop; node = node.parentElement) {
    const style = computed(node);
    const bg = style && parseColor(style.backgroundColor);
    if (bg && bg.a > 0.05) return bg;
  }
  return null;
}
function fixTextContrast(svg, background) {
  const shapes = [];
  for (const shape of Array.from(svg.querySelectorAll('rect, path, polygon, circle, ellipse'))) {
    if (shape.closest('marker, defs, clipPath, mask, pattern')) continue;
    const style = computed(shape);
    if (!style || style.fill === 'none' || style.visibility === 'hidden' || style.display === 'none') continue;
    const fill = parseColor(style.fill);
    if (!fill) continue;
    const alpha = fill.a * (Number.parseFloat(style.fillOpacity || '1') || 0) * (Number.parseFloat(style.opacity || '1') || 0);
    if (alpha < 0.05) continue;
    const box = shape.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) continue;
    shapes.push({ shape, box, color: { ...fill, a: Math.min(1, alpha) } });
  }
  for (const { el, html } of textElements(svg)) {
    const style = computed(el);
    const ink = style && parseColor(html ? style.color : style.fill);
    if (!ink) continue;
    const box = el.getBoundingClientRect();
    if (!box.width && !box.height) continue;
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    let behind = background;
    for (const { shape, box: r, color } of shapes) {
      if (!(shape.compareDocumentPosition(el) & 4)) continue;   // 只算画在这段字之前(底下)的形状
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
      behind = over(color, behind);
    }
    if (html) {
      const own = htmlBackdrop(el, el.closest('foreignObject'));
      if (own) behind = over(own, behind);
    }
    const current = contrast(over(ink, behind), behind);
    if (current >= 3.5) continue;
    const best = contrast(INK_DARK, behind) >= contrast(INK_LIGHT, behind) ? INK_DARK : INK_LIGHT;
    if (contrast(best, behind) < current * 1.5) continue;
    el.style.setProperty(html ? 'color' : 'fill', toCss(best), 'important');
  }
}
function fixEdgeContrast(svg, background, lineColor) {
  const line = parseColor(lineColor);
  if (!line) return;
  const edges = svg.querySelectorAll('path.flowchart-link, path.transition, path.relation, .edgePaths path, path.messageLine0, path.messageLine1, line.messageLine0, line.messageLine1');
  for (const edge of Array.from(edges)) {
    const style = computed(edge);
    const stroke = style && style.stroke !== 'none' ? parseColor(style.stroke) : null;
    if (!stroke || contrast(stroke, background) >= 2) continue;
    edge.style.setProperty('stroke', lineColor, 'important');
    for (const attr of ['marker-end', 'marker-start']) {
      const ref = /url\(#([^)]+)\)/.exec(edge.getAttribute(attr) || '');
      const marker = ref && svg.querySelector(`[id="${ref[1].replace(/"/g, '\\"')}"]`);
      if (!marker) continue;
      for (const part of Array.from(marker.querySelectorAll('path, polygon, circle'))) {
        part.style.setProperty('stroke', lineColor, 'important');
        const partStyle = computed(part);
        if (partStyle && partStyle.fill !== 'none') part.style.setProperty('fill', lineColor, 'important');
      }
    }
  }
}

// palette: { background, textColor, lineColor }(取自 mermaid-runtime.js 的主题色板)。
// source: 渲染用的源码(判断 tickInterval);labels: 桑基图的代号表(repair 时才有)。
export function polishMermaidSvg(svg, { palette, source = '', labels = null } = {}) {
  if (!svg || typeof svg.querySelectorAll !== 'function') return;
  const kind = svg.getAttribute('aria-roledescription') || '';
  const step = fn => { try { fn(); } catch { /* 这一步收尾失败,保留 mermaid 原样 */ } };
  step(() => inertLinks(svg));
  if (labels) step(() => restoreSankeyLabels(svg, labels));
  if (kind === 'gantt') step(() => tidyGanttSvg(svg, { explicitTicks: /\btickInterval\b/.test(source) }));
  if (kind === 'quadrantChart') step(() => widenQuadrant(svg));
  if (kind === 'xychart') step(() => thinXyAxisLabels(svg));
  const background = palette && parseColor(palette.background);
  if (!background) return;
  if (kind === 'sequence') step(() => fadeSequenceRegions(svg, background, parseColor(palette.textColor) || INK_LIGHT));
  step(() => fixTextContrast(svg, background));
  step(() => fixEdgeContrast(svg, background, palette.lineColor));
}
