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
// 启动期握手:取 token 进内存 + sessionStorage。幂等。force=true 用于后台进程重启后刷新
// 失效 token；/api/bootstrap 仍受服务端 loopback Host 门保护。
export async function initToken(force = false) {
  if (force) {
    _token = '';
    try { sessionStorage.removeItem('wcw.token'); } catch { /* no sessionStorage */ }
  }
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

function invalidTokenResponse(status, body) {
  if (status !== 403) return false;
  try {
    const payload = JSON.parse(body);
    const error = payload && payload.error;
    if (error && typeof error === 'object' && error.code === 'auth.token_invalid') return true;
    if (typeof error === 'string' && error === 'missing or invalid workbench token') return true;
  } catch { /* legacy/plain-text response */ }
  return /missing or invalid workbench token/i.test(String(body || ''));
}

// 117q-B3a(P1-6，见 30 号文 §4.6):带鉴权头的原始 fetch。后台进程在同一端口重启时，旧页面的
// sessionStorage token 会失效；服务端在路由执行前以 403/auth.token_invalid 拒绝，因此刷新
// bootstrap token 后原请求重放一次是安全的。与 api() 的区别:本函数返回原始 Response(不做
// res.json()、不对非 2xx 抛错)，供需要读状态码/响应头的调用方自己判断(例如 steward-board.js
// 靠 304 + etag 省一次重画)。非 ok 且不满足重放条件时，返回的 Response 的 body 仍可安全读取一次
// (内部用 clone() 探测 token 失效，不会消费掉原始 body 流)。
export async function apiRaw(path, options = {}) {
  const request = () => fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  let res = await request();
  if (!res.ok) {
    const body = await res.clone().text();
    if (invalidTokenResponse(res.status, body) && await initToken(true)) {
      res = await request();
    }
  }
  return res;
}

// 带鉴权头的 JSON fetch。403/auth.token_invalid 换 token 重放一次的行为见 apiRaw() 注释——
// 本函数只是在其上加「非 2xx 抛错(供 apiErrText 提取人话) + 成功解析 JSON」这一层，不再自己
// 重复一份 authHeaders/403 判定逻辑。
export async function api(path, options = {}) {
  const res = await apiRaw(path, options);
  if (!res.ok) {
    // 128f-①:抛出的错误带上状态码与路径(message 仍是响应正文,apiErrorInfo 的解析不变)——
    // 启动故障卡的诊断要能说「哪一发、回了几」(修前只剩一句正文)。
    const err = new Error((await res.text()) || `HTTP ${res.status}`);
    err.status = res.status;
    err.path = path;
    throw err;
  }
  return res.json();
}

// v1.0.2 (G2/G5c): api() throws with the response body text on an HTTP error (400/403/404). Handlers that
// return {ok:false,error} at those statuses want the human `error` — pull it out of the (usually JSON) text.
// The server P2 error contract is additive during migration:
// { ok:false, error:{ code, params, message? } }. Older routes still send error as a string.
// Normalize both shapes so callers can localize stable codes while retaining an actionable fallback.
export function apiErrorInfo(e) {
  // Business-level failures often arrive as an already-parsed JSON response ({ok:false,error:{...}})
  // instead of an Error thrown for a non-2xx response. Accept that direct structured shape too; otherwise
  // callers interpolating apiErrText(result.error) would see "[object Object]".
  if (e && typeof e === 'object' && !(e instanceof Error)) {
    const detail = e.error && typeof e.error === 'object' && e.error !== null ? e.error : e;
    if (detail.code || detail.message || detail.params) {
      const params = detail.params && typeof detail.params === 'object' && !Array.isArray(detail.params) ? detail.params : {};
      return { code: String(detail.code || ''), params, message: String(detail.message || detail.code || '') };
    }
  }
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

// 33 号文 §4「NDJSON 读流两份逐字 → 抽共享读器」：/api/chat/stream 与 /api/steward/message 回的都是
// NDJSON（一行一个 JSON 事件），消费方原先各自写了一遍「getReader + TextDecoder + 按 /\r?\n/ 切 + 留下
// 不完整的尾行」这套骨架，逐字同形（steward-conversation.js 自己那句注释就写着「照抄」）。
// 骨架只留这里一份：onLine 收【完整的】一行（不含行尾符，可能就是空串——由消费方自己决定忽略）；
// 流结束时残留的不完整尾行，只有非空白才补发（两个消费方原来的写法都是「空白尾行不发」：
// chat-stream-runtime 写的是 if (buf.trim())，steward-conversation 的 takeLine 对空白行直接 return）。
// 消费方若要对尾行另作处理（比如 2.0 那边尾行走的分支与循环里略有不同），传 onTail 即可。
export async function readNdjsonStream(body, onLine, onTail) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const line of lines) onLine(line);
  }
  if (buf.trim()) (onTail || onLine)(buf);
}
