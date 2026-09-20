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
export const fileBasename = pathValue => {
  const value = String(pathValue || '');
  return value.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || value;
};

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

// 33 号文 §4:标题/任务名截短的【唯一口径】。按码点数([...text])而不是 UTF-16 码元数 —— 直接
// `s.length > N ? s.slice(0, N) + '…'` 会把代理对(emoji)从中间切开,上屏是一个孤立半字。
// 两个壳共用同一份:线程 chip(2.0 顶栏/3.0 抽屉/看板)与 2.0 的工具卡/子代理卡/工作流节点卡。
// STEWARD_TITLE_MAX=24 是线程 chip 的历史宽度,故默认值留在这里;名字带 steward 前缀是历史,不改。
export const STEWARD_TITLE_MAX = 24;
export function stewardShortTitle(title, max = STEWARD_TITLE_MAX) {
  const text = String(title == null ? '' : title).trim();
  const limit = Number(max) > 0 ? Number(max) : STEWARD_TITLE_MAX;
  return [...text].length > limit ? [...text].slice(0, limit).join('') + '…' : text;
}

// toast 通知(依赖同文件 el/$;宿主 #toastTray 在 index.html)。
export function toast(msg, kind = '') {
  const t = el('div', `toast ${kind}`, msg);
  $('toastTray').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, 3200);
}
// 连接状态行（121-K5，34 号文 §13.7 登记⑦）。
// 121-K4 把 #statusLine 从侧栏底部搬进外框顶栏之后只剩一个 sr-only 的藏身处 —— 理由是「§2.2 末条
// 明令顶栏不印模型名，而往这里写的正是『服务商 · 模型』」。K5 把两件事拆开，节点搬进线程头第二行
// 右端那个【真看得见】的位置：
//   · setStatus(text) —— 给人看的那一句【连接状态】。签名一字未改（app.js 两处调用不动）；
//     可选的 tone 只影响那颗点的颜色，不传就是中性。
//   · setStatusDetail(detail) —— 「服务商 · 模型」「引擎: 可执行文件路径」这类【配置事实】
//     只进 title：悬停与读屏问得到，扫一眼线程头看不到（§2.2 不印模型名、§8.1 第 4 条不印路径）。
export function setStatus(text, tone = '') {
  const node = $('statusLine');
  if (!node) return text;
  node.textContent = text;
  node.dataset.tone = String(tone || '');
  return text;
}
export function setStatusDetail(detail) {
  const node = $('statusLine');
  if (node) node.title = String(detail == null ? '' : detail);
  return detail;
}

// composer 文本域自适应高度(≤260px)。
export function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 260) + 'px'; }

// 只做语音的服务商不进【对话】候选（用户 2026-09-21 拍板）。ruyi-toolbox 的本地语音识别组件会被自动接成一个服务商
// （toolbox-<id>），它只有转写接口、没有对话接口：出现在引擎菜单／命令面板／压缩模型／子代理与管家的端点选择里，
// 选中只会换来一个 404；更糟的是新手向导与「取第一个服务商」的兜底会把它当成「已经有对话引擎了」。
// 判据不看 id 前缀（用户自己加一个只放 whisper 的服务商同理）：模型清单非空、且【每一个】模型都带语音识别标记。
// 混用的服务商（百炼那种既有对话模型又标了一个语音模型）不受影响；语音识别自己的选择器另有一套判据，也不受影响。
// 纯函数。住在 util.js 而不是 state.js:管家那几个模块会被静态件在 Node 里直接 import,而 state.js 顶层要 window。
export function isSpeechOnlyProvider(provider) {
  const models = provider && Array.isArray(provider.models) ? provider.models : [];
  return models.length > 0 && models.every(m => m && typeof m === 'object' && Array.isArray(m.caps) && m.caps.includes('asr'));
}
export function chatProviders(config) {
  const providers = config && Array.isArray(config.providers) ? config.providers : [];
  return providers.filter(p => p && !isSpeechOnlyProvider(p));
}
