// 如意 Ruyi — client net module (v1.3-FE1 前端模块化 Phase 1)。
//
// 纯搬家:token 读取 + 带鉴权头的 fetch 封装,从原 app.js 原样搬来(函数体一字未改)。app.js 通过
// `import { api, apiErrText, ... } from './js/net.js'` 取回同名绑定,全文件 45×api() 调用点无需改动。
//
// 依赖:仅浏览器原生 fetch/DOM。本模块内部自洽(api→authHeaders→wcwToken 同文件),不 import 其他模块。

// 47c(S1):token 不再从 <meta> 明文读(HTML 不下发 token,view-source/缓存/抓包均不可得)。改 bootstrap 握手
// -- app.js boot 调 initToken():POST /api/bootstrap(open 级,host 门已挡 rebinding)换 token,存 sessionStorage +
// 模块变量。wcwToken() 同步读模块变量(boot 后必有)。无 sessionStorage 时回退 meta 兼容旧 e2e/非浏览器。
let _token = '';
function loadStoredToken() {
  if (_token) return _token;
  try { _token = sessionStorage.getItem('wcw.token') || ''; } catch { /* no sessionStorage */ }
  return _token;
}
// 启动期握手:取 token 进内存 + sessionStorage。幂等。app.js boot 第一件事 await 它。
export async function initToken() {
  if (_token) return _token;
  loadStoredToken();
  if (_token) return _token;
  try {
    const res = await fetch('/api/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' } });
    const j = await res.json();
    if (j && j.ok && j.token) { _token = j.token; try { sessionStorage.setItem('wcw.token', _token); } catch { /* ignore */ } }
  } catch { /* boot 故障卡兜住后续 api 失败 */ }
  return _token;
}
// 同步读 token(boot 后必有)。无 sessionStorage 时回退 <meta>(非浏览器/旧路径兼容)。
export function wcwToken() {
  if (_token) return _token;
  loadStoredToken();
  if (_token) return _token;
  try { return document.querySelector('meta[name="wcw-token"]')?.content || ''; } catch { return ''; }
}
// 标准鉴权头(JSON + x-wcw-token),可合并 extra。
export function authHeaders(extra = {}) { return { 'content-type': 'application/json', 'x-wcw-token': wcwToken(), ...extra }; }
// 带鉴权头的 JSON fetch。非 2xx 抛错(错误信息为响应体文本,供 apiErrText 提取人话)。
export async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
  return res.json();
}

// v1.0.2 (G2/G5c): api() throws with the response body text on an HTTP error (400/403/404). Handlers that
// return {ok:false,error} at those statuses want the human `error` — pull it out of the (usually JSON) text.
// The server P2 error contract is additive during migration:
// { ok:false, error:{ code, params, message? } }. Older routes still send error as a string.
// Normalize both shapes so callers can localize stable codes while retaining an actionable fallback.
export function apiErrorInfo(e) {
  const raw = (e && e.message) || String(e || '');
  try {
    const j = JSON.parse(raw);
    const detail = j && typeof j.error === 'object' && j.error !== null ? j.error
      : (j && typeof j.errorInfo === 'object' && j.errorInfo !== null ? j.errorInfo : null);
    if (detail) {
      const params = detail.params && typeof detail.params === 'object' && !Array.isArray(detail.params) ? detail.params : {};
      const message = detail.message || j.errorText || j.message || raw;
      return { code: String(detail.code || ''), params, message: String(message) };
    }
    if (j && j.error) return { code: String(j.errorCode || ''), params: j.errorParams || {}, message: String(j.error) };
  } catch { /* not json */ }
  return { code: '', params: {}, message: raw };
}

export function apiErrText(e) {
  return apiErrorInfo(e).message;
}
