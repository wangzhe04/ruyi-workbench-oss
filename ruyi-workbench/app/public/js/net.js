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
// 2026-10（用户：「提问回答有时候会显示 Failed to fetch」）：网络层失败（fetch 抛 TypeError，不是 HTTP 状态码）时，
// 只读请求（GET/HEAD）隔 300ms 重发一次 —— 后台进程重启、本机代理抖一下这一类瞬断，用户不该看见。
// 写请求不盲重发：/api/chat/answer 之类第一发可能已经送达，重发会撞 409（question.not_pending），交给调用方按人话报。
export const NETWORK_RETRY_DELAY_MS = 300;
export function isNetworkError(e) {
  if (!e || e.name === 'AbortError') return false;
  const text = String((e && e.message) || e || '');
  return (e instanceof TypeError || e.name === 'TypeError') && /failed to fetch|networkerror|network error|load failed|err_connection/i.test(text);
}
function retryableMethod(options) {
  const method = String((options && options.method) || 'GET').toUpperCase();
  return method === 'GET' || method === 'HEAD';
}
export async function apiRaw(path, options = {}) {
  const once = () => fetch(path, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } });
  const request = async () => {
    try { return await once(); }
    catch (e) {
      if (!isNetworkError(e) || !retryableMethod(options) || (options.signal && options.signal.aborted)) throw e;
      await new Promise(resolve => setTimeout(resolve, NETWORK_RETRY_DELAY_MS));
      return once();
    }
  };
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

// 条件 GET(perf):api.conditional(path[, options]) —— 给轮询用。GET /api/sessions/:id 每 3 s(直播回合)/ 5–30 s(管家抽屉)
// 被轮询,而服务端装载整份会话(18 MB 的会话 250–350 ms)且 providerHistory 前端从不读。服务端在响应上给 ETag、
// 带 If-None-Match 来且没变就回 304(不装载会话、无正文);这里按 path 记下最近一次的 ETag + 已解析的响应,304 时
// 直接回那份记下的响应 —— 连 JSON.parse 也省了。返回的是【顶层浅拷贝 + notModified:true】:调用方可以据此跳过重画,
// 也不会把标记写脏缓存里那份;里面的 session 仍是同一个引用(304 = 与上次拿到的内容逐字相同)。
// 只记最近 CONDITIONAL_CACHE_MAX 个 path(一份大会话的解析结果动辄几十 MB,不能随浏览过的会话无界增长);
// 服务端没给 ETag(旧服务/读不到盘戳的会话)就不记,行为与无条件 api() 完全一致。非 2xx 抛错的形状与 api() 相同。
const CONDITIONAL_CACHE_MAX = 2;
const conditionalCache = new Map();   // path -> { etag, payload };Map 插入序 = 最近使用序(命中时重新插入)
async function apiConditional(path, options = {}) {
  const fetchOptions = { ...options };
  const hit = conditionalCache.get(path);
  if (hit) fetchOptions.headers = { ...(fetchOptions.headers || {}), 'if-none-match': hit.etag };
  const res = await apiRaw(path, fetchOptions);
  if (res.status === 304 && hit) {
    conditionalCache.delete(path); conditionalCache.set(path, hit);
    return { ...hit.payload, notModified: true };
  }
  if (!res.ok) {
    conditionalCache.delete(path);
    const err = new Error((await res.text()) || `HTTP ${res.status}`);
    err.status = res.status;
    err.path = path;
    throw err;
  }
  const payload = await res.json();
  const etag = res.headers.get('etag') || '';
  conditionalCache.delete(path);
  if (etag) {
    conditionalCache.set(path, { etag, payload });
    while (conditionalCache.size > CONDITIONAL_CACHE_MAX) conditionalCache.delete(conditionalCache.keys().next().value);
  }
  return payload;
}
// 挂成 api 的属性而不是新导出/新参数:调用方本来就拿着(或被注入了)api,`typeof api.conditional === 'function'` 就是能力探测 ——
// 注入的是测试里的假 api(没有这个属性)时调用方回落到普通 api(),不用再往组合根一路多传一个函数。
// api() 自己的函数体一个字没动(static 锁钉着「403 换 token 重放只有 apiRaw 一份,api() 复用它」;条件 GET 同样只经 apiRaw)。
api.conditional = apiConditional;
// 测试口:清掉条件 GET 的记忆(单测在同一进程里换服务/换会话时用)。
export function resetConditionalApiCache() { conditionalCache.clear(); }

// v1.0.2 (G2/G5c): api() throws with the response body text on an HTTP error (400/403/404). Handlers that
// return {ok:false,error} at those statuses want the human `error` — pull it out of the (usually JSON) text.
// The server P2 error contract is additive during migration:
// { ok:false, error:{ code, params, message? } }. Older routes still send error as a string.
// Normalize both shapes so callers can localize stable codes while retaining an actionable fallback.
// 网络层失败的人话。net.js 不 import i18n（本模块零依赖），组合根启动时用 setNetworkErrorMessage 注入翻译过的那句；
// 没注入（单测、早期启动故障）时用下面的中文兜底，总之不再把浏览器原生的英文「Failed to fetch」端给用户。
export const NETWORK_ERROR_CODE = 'net.disconnected';
let networkErrorMessage = () => '与后台服务的连接断了（服务可能刚退出或正在重启），请稍候再试；一直这样就重启如意。';
export function setNetworkErrorMessage(fn) { if (typeof fn === 'function') networkErrorMessage = fn; }
export function apiErrorInfo(e) {
  if (isNetworkError(e)) return { code: NETWORK_ERROR_CODE, params: {}, message: String(networkErrorMessage() || '') };
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
