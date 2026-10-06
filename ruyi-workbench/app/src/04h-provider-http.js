// ── 架构还债批 2 · A:OpenAI 兼容服务商 HTTP 路径的原语只有这一个住处 ─────────────────────────────────────
// 修前这套东西散在五个模块:端点 URL 归一化住在 CLI 引擎文件(05),请求头(content-type + Bearer + 自定义头)
// 在 05/06/07/08/09/10 各手写一份,非流式补全的「fetch + 超时 AbortController + 读回体」在 05 与 06 各一份,
// 子代理的瞬时错误重试(08)与 Claude CLI 子代理的重试(07)各写一个 while/for 循环、各带一份可被中止的退避睡眠。
// 这里只收【原语】,纯搬家、逐字节同形:同样的 URL、同样的头(键序也同)、同样的请求体、同样的错误文本。
// 拼提示词/解析业务回体的外壳仍留在各自的模块里(它们依赖 05/06/07 的提示词与协议翻译,挪到这里会造前向边)。
//
// 为什么排在 04f 之后、05 之前:所有消费者(05/06/06d/07/08/09/10)都在它后面,全是后向边;而它自己
// 【零出边】—— 不引用任何其他模块的顶层符号(连 redact/logEvent 都不引用:脱敏留给调用方,回体原样交回),
// 所以进不了任何环,也不扩大既有唯一 SCC。往这里加东西时守住这一条:需要别的模块的符号,就留在调用方做。

// Normalize a provider base URL to the OpenAI "/v1" level so we can append /chat/completions or /models.
// Keeps an existing /vN (or /compatible-mode/v1) segment; otherwise appends /v1.
function providerBaseWithV1(baseUrl) {
  const b = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!b) return '';
  if (/\/v\d+$/i.test(b)) return b;
  return b + '/v1';
}
// v1.7-对抗轮(open-risk):Responses API 端点 URL —— 官方 OpenAI SDK 示例 base_url 就是
// `https://api.deepseek.com`(无 /v1),SDK 直接拼 `/responses`。为与官方逐字节一致(且不依赖
// "/v1/responses 是否被接受"这一无官方明文的事实),responses 走【原样 baseUrl + /responses】,
// 只有 chat 走 providerBaseWithV1。若用户 baseUrl 自带 /vN 段则原样保留(拼出 /vN/responses,
// 与 chat 的保留策略对称)。
function providerResponsesBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}
// 按协议取端点 base:responses → 原样 base;chat → 归一到 /vN。修前五处各写一遍这个三元式。
function providerApiBase(baseUrl, responses) {
  return responses ? providerResponsesBase(baseUrl) : providerBaseWithV1(baseUrl);
}
// 补全端点的完整 URL:base 为空 → ''(调用方据此报「provider base URL is not set」)。
function providerCompletionUrl(baseUrl, responses) {
  const base = providerApiBase(baseUrl, responses);
  return base ? base + (responses ? '/responses' : '/chat/completions') : '';
}
// 出站请求头:content-type、再 Bearer(apiKey 去空白;空 key = keyOptional 端点,不带 authorization)、
// 最后自定义头(providers[].extraHeaders)整份覆盖 —— 自定义头里写了 authorization 就以它为准。键序即插入序。
// (语音转写 05 transcribeAudioViaProvider 是 multipart、头序与 key 口径都不同,不走这里。)
function providerRequestHeaders(provider) {
  const headers = { 'content-type': 'application/json' };
  const key = String((provider && provider.apiKey) || '').trim();
  if (key) headers['authorization'] = 'Bearer ' + key;
  if (provider && provider.extraHeaders) Object.assign(headers, provider.extraHeaders);
  return headers;
}
// 有的端点／代理不理 stream:false 照样回 SSE:把 data: 行里的 delta 拼起来当一份非流式回体,别白白当成空。
function providerSseAsCompletion(raw) {
  let content = '', usage = null;
  for (const line of String(raw || '').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let ev = null; try { ev = JSON.parse(payload); } catch { ev = null; }
    if (!ev) continue;
    const d = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (d && typeof d.content === 'string') content += d.content;
    if (ev.usage && typeof ev.usage === 'object') usage = ev.usage;
  }
  return { choices: [{ message: { content } }], usage };
}
// 非流式一次性 POST:超时由 AbortController 管(计时覆盖读回体),回体整段读成文本再试 JSON。
// 不抛:fetch/读体之外的异常以 { threw:true, error } 交回,由调用方按自己的口径出错误文本
// (05 的改字是 'timeout (20s)',06 的起草是 'draft request timed out (60s)',两者都不许在这里被统一掉)。
// sseFallback:回体不是 JSON 但像 SSE 时拼成 chat 形回体(只有 05 的改字开这个口,06 修前就不认 SSE)。
async function providerPostJsonOnce({ url, headers, body, timeoutMs, sseFallback }) {
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs) : null;
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ctrl ? ctrl.signal : undefined });
    let raw = ''; if (res) { try { raw = await res.text(); } catch { raw = ''; } }
    let parsed = null; try { parsed = JSON.parse(raw); } catch { parsed = null; }
    if (sseFallback && !parsed && /(^|\n)data:/.test(raw)) parsed = providerSseAsCompletion(raw);
    return { res, status: res ? res.status : undefined, ok: Boolean(res && res.ok), raw, parsed };
  } catch (e) {
    return { threw: true, error: e };
  } finally { if (timer) clearTimeout(timer); }
}

// ── 瞬时错误重试策略(一份) ─────────────────────────────────────────────────────────────────────────────
// OpenAI 路径的「瞬时」口径(修前写在 08 子代理循环里):首字节前的连接/TLS 失败(openAiStreamOnce 结构化交回的
// transportError)、网关不可用 502/503/504(failoverStatus)、限流 429。流式已开始后的错误 openAiStreamOnce 直接抛出,
// 根本到不了这里 —— 防重放是结构性的,不靠这个判据。
// 529 是 Anthropic 的「服务过载」(58 号批 2;流内 overloaded_error 在还没吐内容时也报成 HTTP 529),对别的协议无害。
// 状态码只认【开头】的 `HTTP <nnn>`:openAiStreamOnce / 04i 解码器报的 httpError 恒以它起头;流内错误(已吐过内容)写成
// 'Provider stream error: …' / 'Anthropic stream error: …',错误正文里完全可能引用别处的 "HTTP 429" —— 不锚定就把这种
// 「已显示内容的流内失败」误判成瞬时失败重放一遍。
function providerCallIsTransient(call) {
  const he0 = String((call && call.httpError) || '');
  const status0 = Number((/^\s*HTTP (\d{3})\b/.exec(he0) || [])[1]);
  return Boolean(call && (call.transportError || call.failoverStatus || status0 === 429 || status0 === 529));
}
// 服务商 Retry-After(429/503 常带):`retry-after-ms`(OpenAI 系,毫秒)优先,其次 `retry-after`(整数/小数秒,或 HTTP 日期)。
// 封顶 maxMs(缺省 30 s):退避睡眠要可被停止截断、且不能让一回合被一个离谱的头挂住。认不出 / 非正 → 0(调用方回落自己的退避)。
// getHeader(name) 是 res.headers.get 的形状(调用方包一层,本函数不碰 Response)。
function providerRetryAfterMs(getHeader, nowMs, maxMs) {
  const cap = Number.isFinite(Number(maxMs)) && Number(maxMs) > 0 ? Number(maxMs) : 30000;
  const read = name => { try { return String(getHeader(name) == null ? '' : getHeader(name)).trim(); } catch { return ''; } };
  const ms = read('retry-after-ms');
  if (/^\d+(?:\.\d+)?$/.test(ms) && Number(ms) > 0) return Math.min(cap, Math.round(Number(ms)));
  const ra = read('retry-after');
  if (!ra) return 0;
  if (/^\d+(?:\.\d+)?$/.test(ra)) { const n = Number(ra) * 1000; return n > 0 ? Math.min(cap, Math.round(n)) : 0; }
  const at = Date.parse(ra);
  if (!Number.isFinite(at)) return 0;
  const wait = at - (Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now());
  return wait > 0 ? Math.min(cap, Math.round(wait)) : 0;
}
// 抛出的错误的人话文本:message 之外带上 cause 里的真因。undici 在响应流中途断线时对 reader.read() 抛 TypeError('terminated'),
// 真正的原因(SocketError 'other side closed' / UND_ERR_SOCKET / ECONNRESET)只挂在 e.cause —— 只取 e.message 用户看到的就是
// 一个孤零零的 "terminated",errorClass 也认不出是掉线。message 里已经包含 cause 文字的不重复追加。
function providerThrownErrorText(e) {
  const msg = e && e.message ? String(e.message) : String(e == null ? '' : e);
  const cause = e && typeof e === 'object' ? e.cause : null;
  if (!cause) return msg;
  const causeMsg = typeof cause === 'string' ? cause : (cause && cause.message ? String(cause.message) : '');
  const causeCode = cause && typeof cause === 'object' && cause.code ? String(cause.code) : '';
  const extra = [causeCode, causeMsg].filter(part => part && !msg.includes(part)).join(' ');
  return extra ? `${msg} (${extra})` : msg;
}
// 服务商地址是不是本机 / 局域网:回环、RFC1918、链路本地、CGNAT、*.local 等内网后缀、单标签主机名(`ollama`、`nas`)。
// 这类端点能应答只说明「本机/内网通」,证明不了公网可达 —— 联网探测不能拿它当锚点(06 networkAnchors)。解析不了 → false(按公网处理,保持原行为)。
const PROVIDER_LAN_HOST_SUFFIXES = ['.localhost', '.local', '.lan', '.internal', '.localdomain', '.home.arpa'];
function providerBaseIsLocalOrLan(baseUrl) {
  // 手工取主机名,不用全局 URL:本模块零出边(URL 在 00-boot 里是个顶层符号,一引用就多一条 04h → 00-boot 的边、把本模块拖进依赖环)。
  // 形状:[协议://][userinfo@]主机[:端口][/路径];主机可以是 [IPv6];没写协议的 `localhost:11434/v1` 也认。
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/i.exec(String(baseUrl || '').trim());
  const host = String(m ? m[1] : '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) return false;
  if (host === 'localhost' || PROVIDER_LAN_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) return true;   // fc00::/7 唯一本地、fe80::/10 链路本地
    // IPv4 映射地址:WHATWG URL 会把 ::ffff:127.0.0.1 规范成十六进制的 ::ffff:7f00:1,两种写法都认。
    const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
    if (dotted) return providerBaseIsLocalOrLan('http://' + dotted[1]);
    const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
    if (hex) { const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16); return providerBaseIsLocalOrLan(`http://${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return false;
  }
  return !host.includes('.');   // 单标签主机名:只有本机 / 内网 DNS 或 hosts 解析得了
}
// 可被中止截断的退避睡眠。与修前两份手写逐字同形:signal 已经 aborted 时监听器永不触发,睡满整段
// (两处调用方都在睡前/睡后自己查中止,这个细节不能在这里「顺手修好」,否则事件时序会变)。
function abortableDelay(ms, signal) {
  return new Promise(r => {
    const t = setTimeout(r, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });
}
// 有界重试骨架。每一轮:先查 isAborted(真 → 立即交回 { aborted:true });再 attempt;再 classify 裁决:
//   'retry' —— 可重试的瞬时失败:未超 maxRetries 就 retries+1、onRetry(result, retries)、睡 backoffMs(retries) 后重来;
//              超了就按终局交回;
//   'again' —— 立即、不计数、不睡地重来一次(08 的「工具被拒 → 去掉工具再打一次」,由 classify 自己保证只给一次);
//   其他   —— 终局,原样交回。
// retries 从 0 计;backoffMs 收到的是本次重试的序号(1 起;第二个实参是触发重试的那次结果),所以 08 的 min(2000, 250·n) 与 07 的 min(2000, 300·attempt)
// 都能原样表达。classify 收到 { retries }(本次 attempt 之前已用掉的重试数),07 据此还原它的 attempt 序号。
// 不吞异常:attempt 抛出(流式中途失败)原样上抛,不重试。
async function withTransientRetry({ attempt, classify, maxRetries, backoffMs, signal, isAborted, onRetry, delay }) {
  const pause = typeof delay === 'function' ? delay : abortableDelay;
  let retries = 0, result;
  for (;;) {
    if (typeof isAborted === 'function' && isAborted()) return { aborted: true, result, retries };
    result = await attempt({ retries });
    const verdict = classify(result, { retries });
    if (verdict === 'again') continue;
    if (verdict !== 'retry' || retries >= maxRetries) return { aborted: false, result, retries };
    retries += 1;
    if (typeof onRetry === 'function') onRetry(result, retries);
    // backoffMs 的第二个参数是触发这次重试的结果:服务商回了 Retry-After(result.retryAfterMs)时,调用方据此取 max(自己的退避, 它)。
    // 只收序号的老调用方(08 / 07 CLI 子代理)忽略多出来的实参,行为不变。
    await pause(backoffMs(retries, result), signal);
  }
}
