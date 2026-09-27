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
function providerCallIsTransient(call) {
  const he0 = String((call && call.httpError) || '');
  const status0 = Number((/HTTP (\d{3})/.exec(he0) || [])[1]);
  return Boolean(call && (call.transportError || call.failoverStatus || status0 === 429));
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
// retries 从 0 计;backoffMs 收到的是本次重试的序号(1 起),所以 08 的 min(2000, 250·n) 与 07 的 min(2000, 300·attempt)
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
    await pause(backoffMs(retries), signal);
  }
}
