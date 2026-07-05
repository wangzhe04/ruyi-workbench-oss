// 如意 Ruyi — client net module (v1.3-FE1 前端模块化 Phase 1)。
//
// 纯搬家:token 读取 + 带鉴权头的 fetch 封装,从原 app.js 原样搬来(函数体一字未改)。app.js 通过
// `import { api, apiErrText, ... } from './js/net.js'` 取回同名绑定,全文件 45×api() 调用点无需改动。
//
// 依赖:仅浏览器原生 fetch/DOM。本模块内部自洽(api→authHeaders→wcwToken 同文件),不 import 其他模块。

// 从 index.html <meta name="wcw-token"> 读取本地服务的一次性 token。
export function wcwToken() { return document.querySelector('meta[name="wcw-token"]')?.content || ''; }
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
export function apiErrText(e) {
  const raw = (e && e.message) || String(e || '');
  try { const j = JSON.parse(raw); if (j && j.error) return String(j.error); } catch { /* not json */ }
  return raw;
}
