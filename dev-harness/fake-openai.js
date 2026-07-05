// Minimal OpenAI-compatible server for OFFLINE testing of the workbench's native engine + tool loop.
// - GET .../models -> JSON list
// - POST .../chat/completions (SSE): plain chat, OR — when the request carries `tools` and no prior
//   tool result yet — a streamed tool_call to file_read {path: FAKE_TOOL_PATH}; on the follow-up
//   request (which now contains a role:'tool' message) it echoes that tool result's content.
const http = require('http');
const PORT = Number(process.env.FAKE_OPENAI_PORT || process.argv[2] || 8911);
const TOOL_PATH = process.env.FAKE_TOOL_PATH || '';
// v0.7d bridge test: when set, the first tools-available turn calls this (possibly prefixed) tool name
// with args parsed from FAKE_TOOL_ARGS; the follow-up turn echoes the tool result's content.
const TOOL_NAME = process.env.FAKE_TOOL_NAME || '';
let TOOL_ARGS = {};
try { TOOL_ARGS = JSON.parse(process.env.FAKE_TOOL_ARGS || '{}'); } catch { TOOL_ARGS = {}; }

// v0.8-S1 new modes (JSON arrays of {name, args}). SEQUENCE takes priority over FAKE_TOOL_PATH/NAME.
//  FAKE_TOOL_SEQUENCE: on the Nth tools request, if history's role:'tool' count < array length, emit
//    the (toolMsgCount)-th entry as ONE tool_call (id call_1..call_N, args split into two SSE fragments,
//    finish_reason 'tool_calls'); once exhausted, fall through to the existing echo branch.
//  FAKE_PARALLEL_TOOLS: the first tools request emits ALL N entries in ONE assistant message
//    (index 0..N-1, id call_1..call_N); the follow-up request (history already holds N tool results)
//    echoes to finish.
let TOOL_SEQUENCE = null, PARALLEL_TOOLS = null;
try { const v = process.env.FAKE_TOOL_SEQUENCE; if (v) { const a = JSON.parse(v); if (Array.isArray(a) && a.length) TOOL_SEQUENCE = a; } } catch { TOOL_SEQUENCE = null; }
try { const v = process.env.FAKE_PARALLEL_TOOLS; if (v) { const a = JSON.parse(v); if (Array.isArray(a) && a.length) PARALLEL_TOOLS = a; } } catch { PARALLEL_TOOLS = null; }

// v0.8-S6 FAKE_REJECT_TOOLS: the FIRST request carrying `tools` is rejected with 400 {error:{message:
// 'tools not supported'}} (message matches the workbench's /tool|function/i tools-rejected sniff). Every
// SUBSEQUENT request WITHOUT tools streams normally. This drives runOpenAiTurn's tools-rejected retry
// branch (retry once without tools). One-shot: a module-level flag flips after the first rejection.
const REJECT_TOOLS = process.env.FAKE_REJECT_TOOLS === '1';
let rejectedOnce = false;
// v0.9-S2 FAKE_DRAFT_JSON: when set AND the request is non-streaming (stream:false), the fake plays the role
// of the「存为 playbook」drafter — it returns FAKE_DRAFT_JSON verbatim as the assistant message content
// (a JSON string). draftPlaybookFromSession issues exactly such a non-stream call, so this lets the e2e
// assert the round-trip (model output → parsePlaybookDraft → normalizePlaybook → draft) deterministically,
// offline. Precedence: this takes over the stream:false branch below (which otherwise echoes a fixed line).
const DRAFT_JSON = process.env.FAKE_DRAFT_JSON || '';
// v0.9-S0 FAKE_REJECT_TOOLS_WORDING: override the 400 error message used by FAKE_REJECT_TOOLS. This lets an
// e2e inject the OLD-misjudged shape — wording that contains BOTH tool/function semantics AND a
// "not supported" fragment (which used to trip the workbench's stream_options sniff and cause a wrong
// retry WITH tools). With the v0.9-S0 attribution fix, such a 400 must still be attributed to tools-rejected
// because the request carried tools. Default keeps the existing wording (tool/function, no "not support").
const REJECT_TOOLS_WORDING = process.env.FAKE_REJECT_TOOLS_WORDING ||
  'this model does not accept the tools / function calling parameter';

// v0.9-S0 FAKE_VISION: image-echo mode (S7 视觉回路 test scaffold). When set, if ANY request message carries
// a content ARRAY with an image_url part (OpenAI vision parts shape), the streamed reply text echoes
// `SEEN_IMAGE:<hash>` where hash is a cheap fingerprint of that image's data URI (`<len>-<first8chars>`).
// With no image part present the reply is a normal chat/tool response — vision mode is inert unless an
// image actually arrives. Applies to the plain-chat and echo (final-answer) paths.
const VISION = process.env.FAKE_VISION === '1';
// v0.9-S7 FAKE_SEQUENCE_PRIORITY: normally the image-echo branch takes priority (once an image is in history
// the model just echoes SEEN_IMAGE). For the 保图≤2 test we need to keep emitting screenshot tool_calls even
// AFTER images accumulate, so this flag makes an un-exhausted FAKE_TOOL_SEQUENCE win over the image-echo
// branch. Once the sequence is exhausted the image-echo branch resumes (final answer proves the last image
// still reached the model). Inert unless FAKE_TOOL_SEQUENCE is also set.
const SEQUENCE_PRIORITY = process.env.FAKE_SEQUENCE_PRIORITY === '1';
// v0.9-S5 FAKE_PLAN_FIRST: 真流程 plan-mode scaffold. When set, the FIRST request of a turn (history carries
// NO assistant message yet) streams a plain-text answer that OPENS WITH `PLAN:` and carries NO tool_call
// (finish_reason 'stop') — exactly what runOpenAiTurn's plan pause detects. Every SUBSEQUENT request (history
// already has ≥1 assistant message, e.g. the plan text the workbench recorded) falls through to the normal
// branches below, so it can be combined with FAKE_TOOL_SEQUENCE to drive the post-approval execution phase.
// FAKE_PLAN_TEXT overrides the default plan body.
const PLAN_FIRST = process.env.FAKE_PLAN_FIRST === '1';
const PLAN_TEXT = process.env.FAKE_PLAN_TEXT || 'PLAN:\n1. 读取文件\n2. 修改配置';
function hasAssistantMsg(msgs) { return (msgs || []).some(m => m && m.role === 'assistant'); }
// v1.0.2 (F1c 防回潮) FAKE_PLAN_WHEN_REFUSED: model "complies" AFTER the workbench refused its first tool
// batch with «计划模式:请先提交 PLAN:» — the NEXT request streams a PLAN: text (no tool_call). Emits only while
// history has the refusal tool message but NO assistant PLAN message yet (post-approval requests fall through
// to the sequence/echo branches). Models the exact real-model behavior that exposed the consumed-planPhase bug
// (refuse → model resubmits PLAN: → the pause must STILL trigger).
const PLAN_WHEN_REFUSED = process.env.FAKE_PLAN_WHEN_REFUSED === '1';
function planRefusalPending(msgs) {
  const m = msgs || [];
  return m.some(x => x && x.role === 'tool' && /请先提交 PLAN/.test(String(x.content || '')))
    && !m.some(x => x && x.role === 'assistant' && /^\s*PLAN\s*[:：]/i.test(String(x.content || '')));
}

// v0.9-S6 FAKE_SUBAGENT_SCRIPT: 子代理 (spawn_agent) test scaffold. JSON `{parent:[…], sub:[…], subText?, parentText?}`.
// Requests are ROUTED by whether the injected `system` message carries the sub-agent identity marker
// (「子任务执行体」, which runSubAgent prepends): a match → the `sub` script (the delegated sub-turn), else the
// `parent` script (the top-level turn). Each script is a list of steps stepped by the request's role:'tool'
// count (like FAKE_TOOL_SEQUENCE): a step is either {name,args} (emit ONE tool_call — for parent, typically
// spawn_agent; for sub, e.g. file_write) or {text} (emit a final plain-text answer and stop). When the list is
// exhausted the branch emits its final text (`subText`/`parentText`, default a fixed line) so the turn ends.
// Isolation makes this clean: the sub-turn's tool messages live in the sub's OWN history, so the parent's
// role:'tool' count only reflects the parent's spawn_agent results and vice-versa.
let SUBAGENT_SCRIPT = null;
try { const v = process.env.FAKE_SUBAGENT_SCRIPT; if (v) { const o = JSON.parse(v); if (o && typeof o === 'object') SUBAGENT_SCRIPT = o; } } catch { SUBAGENT_SCRIPT = null; }
// v0.9-S6 FAKE_SUBAGENT_PARALLEL: JSON array of {name,args} (typically N spawn_agent). On the FIRST PARENT
// request (no role:'tool' in history yet, non-sub) emit ALL N as ONE assistant message (a batch of parallel
// tool_calls) — drives the single-batch fan-out cap test. The follow-up parent request (now carrying the
// tool results) falls through to the parent script's final text. Sub requests never take this branch.
let SUBAGENT_PARALLEL = null;
try { const v = process.env.FAKE_SUBAGENT_PARALLEL; if (v) { const a = JSON.parse(v); if (Array.isArray(a) && a.length) SUBAGENT_PARALLEL = a; } } catch { SUBAGENT_PARALLEL = null; }
const SUB_IDENTITY_MARKER = '子任务执行体';
function systemText(msgs) { const s = (msgs || []).find(m => m && m.role === 'system'); return s && typeof s.content === 'string' ? s.content : ''; }
function isSubRequest(msgs) { return systemText(msgs).includes(SUB_IDENTITY_MARKER); }
// Return the first image_url data URI found across all messages' array-shaped content, or '' if none.
function findImagePart(msgs) {
  for (const m of (msgs || [])) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (part && part.type === 'image_url') {
        const u = part.image_url && (typeof part.image_url === 'string' ? part.image_url : part.image_url.url);
        if (u) return String(u);
      }
    }
  }
  return '';
}
// Cheap, deterministic fingerprint of a data URI: `<length>-<first 8 chars>` (no crypto needed for a test).
function imageHash(uri) { return String(uri.length) + '-' + uri.slice(0, 8); }

// v0.8-S7 FAKE_STREAM_DELAY_MS: sleep N ms between consecutive SSE data frames so a turn spans a
// controllable window (~N × frameCount) — this gives the steering e2e a real chance to POST /api/steer
// WHILE a tool_use is streaming. Applied to the tool-sequence path and the echo (final-answer) path,
// which are the branches a steering/loop test exercises. 0 (default) = instantaneous, no behavior change.
const STREAM_DELAY_MS = Math.max(0, Number(process.env.FAKE_STREAM_DELAY_MS || 0) || 0);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// v1.0-S6 (B, failover e2e) — three ADDITIVE modes. All default OFF; existing behavior is untouched when
// unset (this file is shared by many e2e — 改坏=全红). They only affect /chat/completions handling.
//  FAKE_HTTP_STATUS: when a positive integer N is set, EVERY /chat/completions request is answered with
//    HTTP N and a small JSON error body BEFORE any streaming header — no SSE. Used to stand up a "returns 401"
//    endpoint (auth error → the workbench must NOT fail over) and could equally simulate 502/503/504.
//  FAKE_DIE_MIDSTREAM: when '1', a /chat/completions request writes the SSE 200 header + ONE partial
//    assistant_delta frame, then DESTROYS the socket (no [DONE]). This models a provider that dies AFTER the
//    stream began — the workbench must NOT fail over (防重放), it takes its existing mid-stream error path.
//  GET /__count: returns {count:N} where N is how many /chat/completions requests this process has served.
//    The sticky-endpoint test reads it to prove a 2nd turn hit the SAME (backup) endpoint without a new
//    failover event. Purely observational; does not alter any streaming behavior.
const HTTP_STATUS = Number(process.env.FAKE_HTTP_STATUS || 0) || 0;
const DIE_MIDSTREAM = process.env.FAKE_DIE_MIDSTREAM === '1';
let chatRequestCount = 0; // increments on every /chat/completions request served by this process
// v0.8-S6 FAKE_CAPTURE_DIR: write each request body to <dir>/req-<n>.json (n = 1-based, zero-padded). The
// capabilities e2e reads these to assert the injected `system` message content (identity pin / project
// memory fence / 「当前不可用」) — reading the落盘 body is more reliable than reconstructing it from the stream.
const CAPTURE_DIR = process.env.FAKE_CAPTURE_DIR || '';
let captureSeq = 0;
if (CAPTURE_DIR) { try { require('fs').mkdirSync(CAPTURE_DIR, { recursive: true }); } catch { /* ignore */ } }
function capture(bodyStr) {
  if (!CAPTURE_DIR) return;
  captureSeq += 1;
  try { require('fs').writeFileSync(require('path').join(CAPTURE_DIR, `req-${String(captureSeq).padStart(3, '0')}.json`), bodyStr); } catch { /* ignore */ }
}

function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function usageFrame(res, id) { sse(res, { id, choices: [], usage: { prompt_tokens: 42, completion_tokens: 15, total_tokens: 57 } }); }
function countToolMsgs(msgs) { return msgs.filter(m => m && m.role === 'tool').length; }
// Emit a single streamed tool_call with arguments split across two SSE fragments. v0.8-S7: async so a
// FAKE_STREAM_DELAY_MS can space the three frames apart (widening the mid-tool_use steering window). With
// the delay 0 (default) it runs to completion synchronously — same three frames, same order.
async function emitOneToolCall(res, id, callId, name, args, index = 0) {
  const argsFull = JSON.stringify(args || {});
  const half = Math.ceil(argsFull.length / 2);
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index, id: callId, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
  if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS);
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: argsFull.slice(0, half) } }] }, finish_reason: null }] });
  if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS);
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: argsFull.slice(half) } }] }, finish_reason: null }] });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const url = req.url || '';
    // v1.0-S6 (B): request-count probe for the sticky-endpoint failover test. Never touches streaming state.
    if (req.method === 'GET' && url.includes('/__count')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ count: chatRequestCount }));
      return;
    }
    if (req.method === 'GET' && url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      // v1.0.2-S2 FAKE_MODELS_CONTEXT_LEN: when set to a positive integer, each /v1/models entry carries a
      // context_length field of that value (drives the context-window probe test). Default OFF → entries have
      // NO context_length (identical to the pre-S2 shape, so other e2e that read /models don't drift).
      const ctxLen = Number(process.env.FAKE_MODELS_CONTEXT_LEN || 0) || 0;
      const entry = (id) => ctxLen > 0 ? { id, object: 'model', context_length: ctxLen } : { id, object: 'model' };
      res.end(JSON.stringify({ object: 'list', data: [entry('fake-model'), entry('fake-reasoner')] }));
      return;
    }
    if (req.method === 'POST' && url.includes('/chat/completions')) {
      chatRequestCount += 1; // v1.0-S6 (B): served-request tally (read via GET /__count)
      capture(body); // v0.8-S6: persist the raw request body (system prompt inspection by e2e)
      // v1.0-S6 (B): FAKE_HTTP_STATUS — answer every chat request with a fixed status (e.g. 401) + JSON error,
      // BEFORE any streaming. Stands up an "auth error" (or 5xx) endpoint for the failover boundary tests.
      if (HTTP_STATUS) {
        res.writeHead(HTTP_STATUS, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'fake status ' + HTTP_STATUS, type: 'fake_error', code: HTTP_STATUS } }));
        return;
      }
      // v1.0-S6 (B): FAKE_DIE_MIDSTREAM — begin a real SSE stream (200 + one partial content frame) then kill
      // the socket without [DONE]. Models a death AFTER first byte → the workbench must NOT fail over (防重放).
      // We DELAY the socket destroy (~200ms) so the client's fetch() promise has resolved with the 200 response
      // AND the client has entered its body-read loop before the reset arrives. Destroying too eagerly can make
      // undici reject the INITIAL fetch() promise (a pre-first-byte ECONNRESET), which is a different case — the
      // delay makes the "died mid-stream" semantics deterministic: the first frame is genuinely delivered first.
      if (DIE_MIDSTREAM) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        sse(res, { id: 'chatcmpl-fake', choices: [{ index: 0, delta: { role: 'assistant', content: '半截' }, finish_reason: null }] });
        setTimeout(() => { try { res.destroy(); } catch { try { req.socket.destroy(); } catch { /* ignore */ } } }, 200);
        return;
      }
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const id = 'chatcmpl-fake';
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const toolMsg = [...msgs].reverse().find(m => m && m.role === 'tool');
      // v0.9-S0 FAKE_VISION: fingerprint of an image_url part if one arrived (else ''). Non-empty only when
      // vision mode is on AND a request message carried an array content with an image_url part.
      const imgUri = VISION ? findImagePart(msgs) : '';

      // v0.8-S6 FAKE_REJECT_TOOLS: reject the FIRST tools-bearing request with 400 so the workbench retries
      // once WITHOUT tools. Fires before any streaming header is written.
      if (REJECT_TOOLS && hasTools && !rejectedOnce) {
        rejectedOnce = true;
        res.writeHead(400, { 'content-type': 'application/json' });
        // Default wording matches the workbench's tools-rejected sniff (/tool|function/i) while avoiding its
        // stream_options sniff (/stream_options|unsupported|unknown|invalid|not\s*support/i). v0.9-S0 lets an
        // e2e OVERRIDE it via FAKE_REJECT_TOOLS_WORDING to inject the OLD误判 shape — wording that hits BOTH
        // regexes (e.g. "tools are not supported here") — which the v0.9-S0 attribution fix must now still
        // route to tools-rejected because the request carried tools.
        res.end(JSON.stringify({ error: { message: REJECT_TOOLS_WORDING, type: 'bad_request' } }));
        return;
      }

      if (parsed.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        // v0.9-S2 FAKE_DRAFT_JSON: return the injected JSON string as the message content (drafter role).
        const content = DRAFT_JSON || 'Hello from fake (non-stream).';
        res.end(JSON.stringify({ id, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });

      // v0.9-S5 FAKE_PLAN_FIRST: on the FIRST request of a turn (no assistant message in history yet) stream a
      // PLAN: text answer with NO tool_call (finish_reason 'stop'). This makes runOpenAiTurn emit a `plan`
      // event and pause. Once the workbench records the plan (an assistant message) and continues after
      // approval, the follow-up request has an assistant message → this branch skips and the normal branches
      // (FAKE_TOOL_SEQUENCE / echo) drive the execution phase. Takes priority so a first tools request yields
      // the plan, not a tool_call.
      // v0.9 F4: PLAN_FIRST must apply only to the PARENT turn. A spawned sub-turn's first request ALSO has no
      // assistant message yet, but it carries the sub-agent identity marker — routing it into the plan branch
      // would make the sub emit a PLAN: text instead of its delegated tool_calls. Skip PLAN_FIRST for subs.
      if (PLAN_FIRST && !hasAssistantMsg(msgs) && !(SUBAGENT_SCRIPT && isSubRequest(msgs))) {
        const out = PLAN_TEXT;
        (async () => {
          sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          for (const piece of out.match(/[\s\S]{1,8}/g) || [out]) { if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS); sse(res, { id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }); }
          sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          usageFrame(res, id);
          res.write('data: [DONE]\n\n'); res.end();
        })();
        return;
      }

      // v1.0.2 (F1c 防回潮) FAKE_PLAN_WHEN_REFUSED: the refusal is in history and no PLAN has been spoken yet
      // → stream the PLAN: text now (no tool_call). Priority over the sequence branch, which would otherwise
      // keep re-emitting tool_calls.
      if (PLAN_WHEN_REFUSED && planRefusalPending(msgs) && !(SUBAGENT_SCRIPT && isSubRequest(msgs))) {
        const out = PLAN_TEXT;
        (async () => {
          sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          for (const piece of out.match(/[\s\S]{1,8}/g) || [out]) { if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS); sse(res, { id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }); }
          sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          usageFrame(res, id);
          res.write('data: [DONE]\n\n'); res.end();
        })();
        return;
      }

      // v0.9-S6 FAKE_SUBAGENT_SCRIPT: route by the sub-agent identity marker in `system`. Takes priority over
      // the generic tool/echo branches so a parent request deterministically yields its spawn_agent tool_call
      // and a sub request its own steps. Each branch steps its list by the request's role:'tool' count.
      if (SUBAGENT_SCRIPT) {
        const sub = isSubRequest(msgs);
        const done = countToolMsgs(msgs);
        // Parent's FIRST request with a parallel batch configured → emit all N spawn_agent in one message.
        if (!sub && SUBAGENT_PARALLEL && done === 0) {
          (async () => {
            for (let i = 0; i < SUBAGENT_PARALLEL.length; i++) {
              const s = SUBAGENT_PARALLEL[i];
              await emitOneToolCall(res, id, 'call_' + (i + 1), String(s.name || ''), s.args || {}, i);
            }
            if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS);
            sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
            usageFrame(res, id);
            res.write('data: [DONE]\n\n'); res.end();
          })();
          return;
        }
        const script = Array.isArray(sub ? SUBAGENT_SCRIPT.sub : SUBAGENT_SCRIPT.parent) ? (sub ? SUBAGENT_SCRIPT.sub : SUBAGENT_SCRIPT.parent) : [];
        const fallbackText = sub
          ? (SUBAGENT_SCRIPT.subText || '子任务已完成:结论文本。')
          : (SUBAGENT_SCRIPT.parentText || '父回合完成。');
        const step = done < script.length ? script[done] : null;
        (async () => {
          if (step && step.name) {
            // Emit ONE tool_call (spawn_agent for parent; file_write etc. for sub).
            await emitOneToolCall(res, id, 'call_' + (done + 1), String(step.name), step.args || {}, 0);
            if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS);
            sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          } else {
            // Exhausted (or an explicit {text} step) → final answer text and stop.
            const out = (step && typeof step.text === 'string') ? step.text : fallbackText;
            sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
            for (const piece of out.match(/[\s\S]{1,8}/g) || [out]) { if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS); sse(res, { id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }); }
            sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          }
          usageFrame(res, id);
          res.write('data: [DONE]\n\n'); res.end();
        })();
        return;
      }

      // v0.9-S0 FAKE_VISION image-echo: once an image_url part is present in the history, stream a final
      // answer whose text echoes `SEEN_IMAGE:<hash>`. This is the S7 视觉回路 scaffold — the workbench, after
      // a screenshot tool result, appends a user image message; the very next request lands here and the
      // reply proves the image reached the model. Takes priority over the tool/echo branches (the image only
      // appears AFTER the tool round, so a first tools request with no image still emits its tool call below).
      // v0.9-S7: unless SEQUENCE_PRIORITY defers us (keep screenshotting while images pile up — 保图≤2 test),
      // an image in history short-circuits to the SEEN_IMAGE echo.
      const sequenceLeft = hasTools && TOOL_SEQUENCE && countToolMsgs(msgs) < TOOL_SEQUENCE.length;
      if (imgUri && !(SEQUENCE_PRIORITY && sequenceLeft)) {
        const out = 'SEEN_IMAGE:' + imageHash(imgUri);
        (async () => {
          sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          for (const piece of out.match(/.{1,6}/gs) || [out]) { if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS); sse(res, { id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }); }
          sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          usageFrame(res, id);
          res.write('data: [DONE]\n\n'); res.end();
        })();
        return;
      }

      // v0.8-S1 FAKE_TOOL_SEQUENCE (priority over PATH/NAME): step through the array one tool_call per
      // turn until every entry has produced a tool result, then fall through to the echo branch.
      if (hasTools && TOOL_SEQUENCE) {
        const done = countToolMsgs(msgs);
        if (done < TOOL_SEQUENCE.length) {
          const step = TOOL_SEQUENCE[done];
          // v0.8-S7: when a stream delay is configured, space the tool_call's frames out so a steering
          // POST can arrive mid-stream. emitOneToolCall writes 3 frames; insert a sleep before the
          // finish_reason frame too so the "turn is live" window is meaningfully wide.
          (async () => {
            await emitOneToolCall(res, id, 'call_' + (done + 1), String(step.name || ''), step.args || {}, 0);
            if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS);
            sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
            if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS);
            usageFrame(res, id);
            res.write('data: [DONE]\n\n'); res.end();
          })();
          return;
        }
        // exhausted → fall through to the echo branch below (echoes the last tool result).
      }

      // v0.8-S1 FAKE_PARALLEL_TOOLS: first tools request emits all N tool_calls in ONE assistant
      // message; the follow-up (history already carries N tool results) echoes to finish.
      // v0.8-S7: sequential async loop (NOT forEach) — emitOneToolCall is now async, so with a
      // FAKE_STREAM_DELAY_MS set a non-awaited forEach would write finish_reason/[DONE] before the
      // delayed arg fragments arrive. With delay 0 the loop degenerates to the old synchronous order.
      if (hasTools && PARALLEL_TOOLS && countToolMsgs(msgs) === 0) {
        (async () => {
          for (let i = 0; i < PARALLEL_TOOLS.length; i++) {
            const step = PARALLEL_TOOLS[i];
            await emitOneToolCall(res, id, 'call_' + (i + 1), String(step.name || ''), step.args || {}, i);
          }
          if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS);
          sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
          usageFrame(res, id);
          res.write('data: [DONE]\n\n'); res.end();
        })();
        return;
      }

      // Follow-up turn: a tool result is present -> echo its content as the final answer.
      if (toolMsg) {
        let echoed = '';
        try {
          const parsedResult = JSON.parse(toolMsg.content);
          // Accept file_read {content}, bridged echo {echoed}, add {sum}, generic {text}, or {error}.
          echoed = String(
            parsedResult.content != null ? parsedResult.content
            : parsedResult.echoed != null ? parsedResult.echoed
            : parsedResult.sum != null ? parsedResult.sum
            : parsedResult.text != null ? parsedResult.text
            : parsedResult.error != null ? parsedResult.error
            : ''
          );
        } catch { echoed = String(toolMsg.content || ''); }
        const out = '工具返回：' + echoed;
        // v0.8-S7: space the echo frames when a stream delay is set (widens the total turn window).
        (async () => {
          sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          for (const piece of out.match(/.{1,6}/gs) || [out]) { if (STREAM_DELAY_MS) await sleep(STREAM_DELAY_MS); sse(res, { id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] }); }
          sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          usageFrame(res, id);
          res.write('data: [DONE]\n\n'); res.end();
        })();
        return;
      }

      // v0.7d: first turn with tools -> call a named (possibly bridged) tool with FAKE_TOOL_ARGS.
      if (hasTools && TOOL_NAME) {
        const argsFull = JSON.stringify(TOOL_ARGS);
        const half = Math.ceil(argsFull.length / 2);
        sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: TOOL_NAME, arguments: '' } }] }, finish_reason: null }] });
        sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsFull.slice(0, half) } }] }, finish_reason: null }] });
        sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsFull.slice(half) } }] }, finish_reason: null }] });
        sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        usageFrame(res, id);
        res.write('data: [DONE]\n\n'); res.end();
        return;
      }

      // First turn with tools available -> ask to read a file (streamed tool_call in two arg fragments).
      if (hasTools && TOOL_PATH) {
        const argsFull = JSON.stringify({ path: TOOL_PATH });
        const half = Math.ceil(argsFull.length / 2);
        sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
        sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsFull.slice(0, half) } }] }, finish_reason: null }] });
        sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argsFull.slice(half) } }] }, finish_reason: null }] });
        sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
        usageFrame(res, id);
        res.write('data: [DONE]\n\n'); res.end();
        return;
      }

      // Plain chat (no tools): reasoning + content + usage.
      const reason = ['Let me ', 'think about ', 'this. '];
      const content = ['Hello', ', ', 'world', '! ', 'This is ', 'a fake ', 'streamed ', 'reply.'];
      let i = 0;
      sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      const timer = setInterval(() => {
        if (i < reason.length) sse(res, { id, choices: [{ index: 0, delta: { reasoning_content: reason[i] }, finish_reason: null }] });
        else if (i < reason.length + content.length) sse(res, { id, choices: [{ index: 0, delta: { content: content[i - reason.length] }, finish_reason: null }] });
        else { sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); usageFrame(res, id); res.write('data: [DONE]\n\n'); clearInterval(timer); res.end(); return; }
        i += 1;
      }, 12);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
});
server.listen(PORT, '127.0.0.1', () => console.log('[fake-openai] listening on ' + PORT + (TOOL_PATH ? ' (tool path set)' : '')));
