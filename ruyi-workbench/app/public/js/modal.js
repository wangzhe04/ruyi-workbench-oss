'use strict';

// 32 号文 §4（M2-a）：动态模态原语（背影 / Tab 焦点陷阱 / 焦点归还 / 点背影取消 / 供全局快捷键调用的
// __cancel）从 js/interaction-prompts.js 的领域闭包里搬出来，住成叶子 js/modal.js。
//
// 为什么要搬：这层原语本来只服务 2.0 的动态模态，而 3.0 管家壳的危险操作确认（看板「停掉占用者」、
// 抽屉「整单回退」）修前还在用原生 window.confirm —— 浏览器原生的那一个不跟主题、不跟语言、
// 焦点管理也不归壳管。确认要收成一套，就得先把「模态怎么做」这一层共用起来（js/confirm-panel.js
// 建在它上面）。2.0 那三条路径（AskUser / 权限请求 / 计划决策）的行为逐字未动：本文件就是那段代码
// 本身，只是换了住址与调用形状。
//
// 契约（2.0 与 3.0 都按这一份）：
//   · backdrop 带 __cancel / __close（app.js 的全局 Esc 与静态模态的关闭链走这两个口）；
//   · 点背影取消、Tab 在模态内循环、关掉后焦点还给打开它的那枚元素；
//   · 返回 { backdrop, foot, close, cancel } —— close/cancel 都是幂等的。

import { el } from './util.js';
import { icon } from './icons.js';
import { t } from './i18n.js';

export function buildModal({ title = '', body = null, foot = null, onCancel = null, size = 'small', extraClass = 'dynamic' } = {}) {
  const backdrop = el('div', `modal-backdrop ${extraClass}`.trim());
  const trigger = document.activeElement; // §4.9: return focus here on close
  let done = false;
  const finish = (cancelled) => {
    if (done) return; done = true;
    if (cancelled && onCancel) { try { onCancel(); } catch { /* ignore */ } }
    backdrop.remove();
    if (trigger && typeof trigger.focus === 'function') { try { trigger.focus(); } catch { /* ignore */ } }
  };
  backdrop.__cancel = () => finish(true);
  backdrop.__close = () => finish(false);
  const modal = el('div', `modal ${size}`.trim());
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', title);
  const head = el('div', 'modal-head');
  head.append(el('h3', '', title));
  const x = el('button', 'icon-btn'); x.appendChild(icon('close', 16)); x.setAttribute('aria-label', t('common.close')); x.onclick = () => finish(true);
  head.append(x);
  const bodyWrap = el('div', 'modal-body'); if (body) bodyWrap.appendChild(body);
  const footWrap = el('div', 'modal-foot'); if (foot) footWrap.appendChild(foot);
  modal.append(head, bodyWrap, footWrap);
  backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish(true); });
  backdrop.appendChild(modal);
  installFocusTrap(backdrop); // 第50波 a11y P0:Tab 焦点陷阱
  document.body.appendChild(backdrop);
  // §4.9: focus the first interactive element inside the modal (input/button), falling back to ✕.
  setTimeout(() => { (focusFirstInteractive(modal) || x)?.focus?.(); }, 0);
  return { backdrop, foot: footWrap, close: () => finish(false), cancel: () => finish(true) };
}

// §4.9 helper: find the first focusable control inside a container (visible input/select/textarea/
// button/[tabindex]≥0), preferring a real form field over a button. Returns the element or null.
export function focusFirstInteractive(container) {
  if (!container) return null;
  const sel = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const nodes = [...container.querySelectorAll(sel)].filter(n => n.offsetParent !== null || n === document.activeElement);
  // Prefer a field the user is expected to type into over the leading ✕/close button.
  const field = nodes.find(n => /^(INPUT|SELECT|TEXTAREA)$/.test(n.tagName));
  return field || nodes[0] || null;
}

// 第50波(a11y P0):模态焦点陷阱 —— Tab/Shift+Tab 在模态内循环,焦点不外泄到背景(ESC 与焦点归还
// 已由全局快捷键/buildModal 承担)。动态(buildModal)与静态(index.html)模态共用。
export function installFocusTrap(backdrop) {
  if (!backdrop || backdrop.__trapInstalled) return;
  backdrop.__trapInstalled = true;
  backdrop.addEventListener('keydown', e => {
    if (e.key !== 'Tab') return;
    const modal = backdrop.querySelector('.modal') || backdrop;
    const sel = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const nodes = [...modal.querySelectorAll(sel)].filter(n => n.offsetParent !== null);
    if (!nodes.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    const active = (backdrop.ownerDocument || document).activeElement;
    if (e.shiftKey && (active === first || active === modal || !modal.contains(active))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (active === last || active === modal || !modal.contains(active))) { e.preventDefault(); first.focus(); }
  });
}
