// 如意 Ruyi — client util module (v1.3-FE1 前端模块化 Phase 1)。
//
// 纯搬家:无状态的 DOM / 格式化小工具,从原 app.js 原样搬来。app.js 通过
// `import { $, el, ... } from './js/util.js'` 取回同名绑定,全文件 233×$()/482×el()/95×toast() 等
// 调用点无需改动 —— import 绑定在模块作用域全文件可见,调用时点解析,行为与经典脚本一致。
//
// 依赖:仅浏览器原生 DOM API + 全局 marked/hljs(经典 vendor 脚本先于 module 加载,仍是全局)。
// i18n 为单向依赖：本模块只读取当前 locale，i18n 本身不依赖 util，故无循环。
import { getLocale } from './i18n.js';

// 按 id 取元素 / 造元素(全站两大高频 helper)。
export const $ = id => document.getElementById(id);
export const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// HTML 转义(XSS 安全渲染兜底)。
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[ch]));
}
// 字节数人类可读。
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  const units = ['MB', 'GB', 'TB', 'PB'];
  let value = n / 1048576;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  return `${value.toFixed(1)} ${units[unit]}`;
}
// ISO 时间 → 当前语言的短格式。
export function fmtTime(iso) {
  try { const d = new Date(iso); return d.toLocaleString(getLocale(), { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }); } catch { return ''; }
}
// token 数人类可读(K/M,尾零裁剪)。ctx-meter 与各处读数共用。
export function fmtTokens(n) {
  if (!Number.isFinite(n)) return '?';
  // toFixed then trim trailing zeros ONLY after a decimal point (so 150000 -> "150K", not "15K").
  const f = (x, d) => { let s = x.toFixed(d); if (s.indexOf('.') >= 0) s = s.replace(/\.?0+$/, ''); return s; };
  if (n >= 1e6) return f(n / 1e6, n >= 1e7 ? 0 : 2) + 'M';
  if (n >= 1e3) return f(n / 1e3, n >= 1e5 ? 0 : 1) + 'K';
  return String(n);
}

// toast 通知(依赖同文件 el/$;宿主 #toastTray 在 index.html)。
export function toast(msg, kind = '') {
  const t = el('div', `toast ${kind}`, msg);
  $('toastTray').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3200);
}
// 侧栏底部状态行。
export function setStatus(text) { $('statusLine').textContent = text; }

// composer 文本域自适应高度(≤260px)。
export function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; }
