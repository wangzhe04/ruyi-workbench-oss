'use strict';

// 32 号文 §4（M1-b）：浮层原语从 navigation-controls.js 搬成【叶子模块】。它原来住在本域的组合根里
// （那里还拖着 help-menu / help-viewer / onboarding-wizard），3.0 想复用它就得把整条组合根一起 import，
// 那是不能接受的依赖方向。搬出来之后两壳取到的是同一份「开合」。
//
// 2.0 那一条路径【逐字未动】：.popover 容器、锚点下方定位 + 底部溢出翻转 + 横向夹取、Esc、点外
// mousedown、滚动/缩放重定位、焦点归还锚点、同一时刻只允许一个浮层。
//
// 3.0 的内联下拉（.steward-chip-menu：CSS 按 .steward-chip-wrap 定位、靠节点自己的 [hidden] 开合）也
// 复用它这一层开合。做法是三个【可选】钩子 —— 都不传时上面那条路径一字未变：
//   opts.layer { mount, node } —— 不新建 .popover、不外挂 body：节点与挂载点由调用方给，位置由那套
//       已定的 CSS 决定（`place()` 因此不跑，滚动/缩放也不重定位）。
//   opts.onOpen(node) —— 真挂上去之后回调一次（3.0 用它把焦点交给搜索框：游离的节点 focus() 不动，
//       必须等它进了文档）。
//   opts.onClose()  —— 任何关闭路径（Esc／点外／自己 close／被下一个浮层顶掉）都回调一次（3.0 用它
//       把自己从 Esc 栈里摘掉）。
import { el } from './util.js';

let activePopover = null;
export function closePopover() {
  if (!activePopover) return;
  const { node, anchor, onKey, onDown, onScroll, onClose, keep } = activePopover;
  activePopover = null;
  document.removeEventListener('keydown', onKey, true);
  document.removeEventListener('mousedown', onDown, true);
  window.removeEventListener('resize', onScroll, true);
  window.removeEventListener('scroll', onScroll, true);
  if (keep) node.hidden = true; else node.remove();
  if (anchor && typeof anchor.focus === 'function') { try { anchor.focus(); } catch { /* ignore */ } }
  if (typeof onClose === 'function') { try { onClose(); } catch { /* ignore */ } }
}
export function popoverAnchor() { return activePopover ? activePopover.anchor : null; }
export function popover(anchorEl, buildContent, opts = {}) {
  if (activePopover && activePopover.anchor === anchorEl) { closePopover(); return null; }
  closePopover();
  const layer = opts.layer || null;
  const node = (layer && layer.node) || el('div', 'popover');
  const keep = Boolean(layer && layer.node);
  const close = () => closePopover();
  if (keep) { while (node.firstChild) node.removeChild(node.firstChild); }
  // 2.0：buildContent 返回浮层内容节点，由本函数挂进去（返回 null 就是调用方 bug，照旧抛）。
  // layer 模式：节点本身由调用方给，buildContent 自己往 node 里填 —— 返回值可有可无（3.0 的菜单
  // 就是菜单本体，把返回值再 append 回它自己会 HierarchyRequestError）。
  if (!layer) node.appendChild(buildContent(close));
  else { const built = buildContent(close); if (built) node.appendChild(built); }
  // layer 模式：节点本来就住在调用方给的挂载点里（就地浮层），已经在那个父节点下就【不搬家】——
  // appendChild 会把它挪到末尾，而就地浮层的 DOM 次序是它自己那套 CSS 与兄弟节点的一部分
  // （比如 .steward-target-picker 排在输入框行【之前】）。2.0 那条路径不进这个分支，一字未变。
  if (layer && layer.mount) { if (node.parentNode !== layer.mount) layer.mount.appendChild(node); } else document.body.appendChild(node);
  if (keep) node.hidden = false;
  const place = () => {
    const r = anchorEl.getBoundingClientRect();
    const pw = node.offsetWidth, ph = node.offsetHeight;
    const gap = 6, margin = 8;
    // Vertical: below by default; flip above if it would overflow the bottom and there's more room up.
    let top = r.bottom + gap;
    if (top + ph > window.innerHeight - margin && r.top - gap - ph > margin) top = r.top - gap - ph;
    top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));
    // Horizontal: right-aligned to the anchor's right edge; clamp into the viewport.
    let left = (opts.placement === 'bottom-start') ? r.left : (r.right - pw);
    left = Math.max(margin, Math.min(left, window.innerWidth - pw - margin));
    node.style.top = top + 'px';
    node.style.left = left + 'px';
  };
  if (!layer) place();
  const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  const onDown = e => { if (!node.contains(e.target) && e.target !== anchorEl && !anchorEl.contains(e.target)) close(); };
  const onScroll = layer ? () => {} : () => place();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('resize', onScroll, true);
  window.addEventListener('scroll', onScroll, true);
  activePopover = { node, anchor: anchorEl, onKey, onDown, onScroll, onClose: opts.onClose, keep };
  if (typeof opts.onOpen === 'function') { try { opts.onOpen(node); } catch { /* ignore */ } }
  return { node, close };
}
