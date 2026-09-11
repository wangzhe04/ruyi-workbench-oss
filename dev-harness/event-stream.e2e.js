#!/usr/bin/env node
'use strict';

// E2E(第 121 波 K2a · 34 号文 §6.1 / §6.3):服务端事件流 `GET /api/events/stream`(SSE)。
//
// 本刀之前全仓没有任何服务端推送 —— 两条 NDJSON 写流都是「谁起的回合谁收」,管家派出去的回合
// 没有任何客户端挂在它的流上,于是左栏/焦点卡只能靠 5–15 s 的轮询看世界(§1.4 那张延迟表:
// 中途工具调用一栏写的是「永远看不到」)。本件用【真端点、真回合、真 provider 夹具】证伪五条:
//
//   A 连接与在场:presence.ack 回显 `?lens=&sessionId=` 两个参数(§4.3 的最小在场信号)。
//   B 五类事件各至少一条,且【服务端写下这一帧】到【客户端收到】≤ 1 s(§6.3 的 a–e):
//       a thread.state(回合起跑 → 「在跑」)   b thread.done(收工 + summary 即时)
//       c thread.needs_you(提问 → 「等你」)    d thread.live(中途工具调用,今天永远看不到)
//       e thread.created(管家新开线程 → 左栏出现)
//     另加两条非线程事件:steward.say(管家说完一句)与 thread.adopted(线程归到某个任务)。
//   C thread.live 每会话 ≥500 ms 一条(§6.1 节流列)—— 相邻两条的服务端时刻差必须够。
//   D 断线补发:掐掉连接 → 期间发生的事 → 带 `Last-Event-ID` 重连,漏掉的那些补齐且 id 单调。
//   E 红线:事件流不承载工具输出正文 —— 全程收到的帧里不许出现工具结果那段魔术串。
//
// 夹具:temp HOME + 假 OpenAI 兼容 provider(同 classic-window-live-steer.e2e.js 那一套),
// 不开浏览器 —— SSE 客户端用 Node 原生 http 自己解析帧(前端 K2b 也走 fetch 流式读,不用
// EventSource:这条路由是 token-browser 档,EventSource 设不了请求头)。
// 判定行:`EVENT STREAM E2E: ALL PASS`。
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_TITLE = '事件流要看的那条线程';
// 工具结果里塞一段魔术串:它绝不许出现在任何一帧事件里(§6.1 红线①)。
const TOOL_SECRET = 'TOOLOUTPUT-NEVER-ON-THE-WIRE-8f21';
// 第一发模型调用流多长时间的 delta —— 要够 thread.live 攒出至少两条(节流 500 ms)。
const STREAM_MS = 1800;

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 60000,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (raw) req.write(raw);
    req.end();
  });
}

async function waitForHttp(port, method, pathname, predicate, token, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, method, pathname, null, token);
    if (result && predicate(result)) return result;
    await sleep(100);
  }
  return null;
}

function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* already exited */ }
}

// ── SSE 客户端(Node 原生 http;不用 EventSource)────────────────────────────────
// 帧格式按 SSE 规范:`id:` / `event:` / `data:` 三行 + 空行分隔;`: ping` 是注释行(心跳)。
// 每帧记一个【客户端收到的时刻】,与载荷里的服务端 `at` 相减就是这条推送的真实延迟。
function openStream(port, token, query, lastEventId) {
  const frames = [];
  const comments = [];
  const state = { frames, comments, closed: false, status: 0, headers: null, req: null };
  let buffer = '';
  state.ready = new Promise(resolve => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/events/stream' + (query || ''), method: 'GET',
      headers: {
        ...(token ? { 'x-wcw-token': token } : {}),
        ...(lastEventId ? { 'last-event-id': String(lastEventId) } : {}),
      },
    }, response => {
      state.status = response.statusCode;
      state.headers = response.headers;
      response.setEncoding('utf8');
      response.on('data', chunk => {
        const at = Date.now();
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (!block.trim()) continue;
          if (block.startsWith(':')) { comments.push({ text: block, at }); continue; }
          const frame = { id: 0, event: '', data: null, at };
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) frame.id = Number(line.slice(4));
            else if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) { try { frame.data = JSON.parse(line.slice(6)); } catch { frame.data = null; } }
          }
          frames.push(frame);
        }
      });
      response.on('end', () => { state.closed = true; });
      resolve(state);
    });
    req.on('error', () => { state.closed = true; resolve(state); });
    state.req = req;
    req.end();
  });
  state.close = () => { try { state.req.destroy(); } catch { /* already gone */ } state.closed = true; };
  return state;
}

async function waitForFrame(stream, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = stream.frames.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return null;
    await sleep(25);
  }
}

// 服务端写这一帧的时刻 → 客户端收到的时刻。§6.3 的「≤1 s」就是这个数。
function latencyMs(frame) {
  const serverAt = Date.parse((frame && frame.data && frame.data.at) || '');
  if (!Number.isFinite(serverAt)) return Infinity;
  return frame.at - serverAt;
}

// ── fake provider ────────────────────────────────────────────────────────────
//   管家会话      → 结构化契约 JSON 一句收。
//   线程第 1 发   → 流 STREAM_MS 的 delta(攒 thread.live),再要一次 file_read(工具名进尾巴)。
//   线程第 2 发   → request_user_input(注册 pending question = 「等你」)。
//   线程第 3 发   → 一句话收工。
async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const sys = messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
    const isSteward = /我是如意/.test(sys);
    const toolMsgs = messages.filter(m => m && m.role === 'tool').map(m => String(m.content || ''));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
    const done = () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };

    if (isSteward) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] }) }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      return done();
    }
    if (!toolMsgs.length) {
      // 慢慢说,让活回合的尾巴反复更新 —— thread.live 的节流要在这段里被真的触发两次以上。
      const ticks = Math.max(4, Math.round(STREAM_MS / 300));
      for (let i = 0; i < ticks; i++) {
        sse({ choices: [{ index: 0, delta: { role: 'assistant', content: `第${i + 1}段:我在看这件事。` }, finish_reason: null }] });
        await sleep(300);
      }
      const args = JSON.stringify({ path: 'probe.txt' });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_probe', type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return done();
    }
    if (!toolMsgs.some(t => /Vue|React/.test(t))) {
      const args = JSON.stringify({ questions: [{ header: '框架', question: '用哪个框架?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_q1', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
      return done();
    }
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '收工了,结论在这儿。' }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    return done();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-event-stream-'));
const home = path.join(root, 'home');
fs.mkdirSync(home);
// 工具真的会读到这段魔术串;它进得了工具结果,但一个字都不许进事件流(§6.1 红线①)。
fs.writeFileSync(path.join(home, 'probe.txt'), TOOL_SECRET + '\n', 'utf8');
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9,
  version: '2.4.0',
  activeProvider: 'fake',
  engineMode: 'interactive',
  permissionMode: 'default',
  theme: 'dark',
  uiMode: 'pro',
  locale: 'zh-CN',
  defaultWorkspace: home,
  includeWorkbenchMcp: false,
  killOnDisconnect: false,
  subagentMaxPerTurn: 0,
  stewardEnabledV1: true,
  stewardPollMs: 5000,
  stewardVisitIdleMinutes: 60,
  stewardConversationRetention: 'visit',
  stewardProviderId: 'fake',
  stewardModel: 'fake-model',
  stewardThreadBriefV1: false,
  stewardMaxTurnsPerHour: 500,
  stewardGlobalMaxTurnsPerHour: 2000,
  providers: [{
    id: 'fake', label: 'Fake', type: 'openai-compat',
    baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
    models: [{ id: 'fake-model', label: 'Fake' }],
  }],
}), 'utf8');

let provider = null;
let server = null;
let stream = null;
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', result => result.status === 200, undefined, 300)), 'A1 workbench started');

  let token = '';
  for (let i = 0; i < 80 && !token; i++) {
    try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    if (!token) await sleep(100);
  }
  ok(Boolean(token), 'A2 runtime token 可读');

  /* ═════════ A 鉴权与在场 ═════════ */
  const denied = await new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: appPort, path: '/api/events/stream', method: 'GET', headers: { origin: `http://127.0.0.1:${appPort}` } },
      response => { let t = ''; response.on('data', c => { t += c; }); response.on('end', () => resolve({ status: response.statusCode, text: t })); });
    req.on('error', () => resolve(null));
    req.end();
  });
  ok(Boolean(denied && denied.status === 403), `A3 浏览器无 token -> 403(ROUTE_AUTH token-browser 档;实得 ${denied && denied.status})`);

  stream = openStream(appPort, token, '?lens=steward&sessionId=sess_presencecheck');
  await stream.ready;
  ok(stream.status === 200, `A4 SSE 连上(实得 ${stream.status})`);
  ok(String((stream.headers || {})['content-type'] || '').startsWith('text/event-stream'), 'A5 content-type 是 text/event-stream');
  ok(String((stream.headers || {})['cache-control'] || '') === 'no-cache'
    && String((stream.headers || {})['x-accel-buffering'] || '') === 'no', 'A5b 响应头带 no-cache 与 x-accel-buffering:no');
  const ack = await waitForFrame(stream, f => f.event === 'presence.ack', 5000);
  ok(Boolean(ack && ack.data && ack.data.lens === 'steward' && ack.data.sessionId === 'sess_presencecheck'),
    `A6 presence.ack 回显在场参数(实得 ${JSON.stringify(ack && ack.data)})`);
  ok(Boolean(ack && !ack.id), 'A7 presence.ack 是连接私有帧(不带 id,不推 Last-Event-ID)');

  /* ═════════ 管家回合(steward.say)═════════ */
  const sayPromise = waitForFrame(stream, f => f.event === 'steward.say', 60000);
  await request(appPort, 'POST', '/api/steward/message', { message: '现在什么情况' }, token);
  const say = await sayPromise;
  ok(Boolean(say && say.data && say.data.trigger), `B0a steward.say 到达(trigger=${say && say.data && say.data.trigger})`);
  ok(Boolean(say && latencyMs(say) <= 1000), `B0b steward.say 延迟 ${say ? latencyMs(say) : '∞'} ms ≤ 1000`);
  ok(!stream.frames.some(f => f.data && String(f.data.sessionId || '') === 'steward'),
    'B0c 管家自己的会话不进 thread.*(它的动静只走 steward.say)');

  /* ═════════ e 管家新开线程 -> thread.created ═════════ */
  const createdPromise = waitForFrame(stream, f => f.event === 'thread.created', 60000);
  const created = await request(appPort, 'POST', '/api/steward/act', {
    act: { kind: 'tool', tool: 'steward_thread_new', args: { title: THREAD_TITLE, cwd: home, brief: { userText: '把这件事推进到底', goal: '给一句结论' } } },
  }, token);
  const sessionId = created && created.json && created.json.result && created.json.result.sessionId;
  ok(Boolean(sessionId), `B-e1 管家 steward_thread_new 开出线程(${sessionId || '失败'})`);
  if (!sessionId) throw new Error('steward thread fixture unavailable');
  const createdFrame = await createdPromise;
  ok(Boolean(createdFrame && createdFrame.data && createdFrame.data.sessionId === sessionId),
    `B-e2 thread.created 带这条线程(§6.3 指标 e;实得 ${JSON.stringify(createdFrame && createdFrame.data)})`);
  ok(Boolean(createdFrame && latencyMs(createdFrame) <= 1000), `B-e3 thread.created 延迟 ${createdFrame ? latencyMs(createdFrame) : '∞'} ms ≤ 1000`);

  /* ═════════ a 回合起跑 -> thread.state running ═════════ */
  const running = await waitForFrame(stream, f => f.event === 'thread.state' && f.data && f.data.sessionId === sessionId && f.data.state === 'running', 60000);
  ok(Boolean(running), 'B-a1 thread.state state=running(§6.3 指标 a)');
  ok(Boolean(running && latencyMs(running) <= 1000), `B-a2 thread.state 延迟 ${running ? latencyMs(running) : '∞'} ms ≤ 1000`);

  /* ═════════ d 中途工具调用 -> thread.live ═════════ */
  const live = await waitForFrame(stream, f => f.event === 'thread.live' && f.data && f.data.sessionId === sessionId, 60000);
  ok(Boolean(live), 'B-d1 thread.live 到达(§6.3 指标 d:今天永远看不到的那一条)');
  ok(Boolean(live && latencyMs(live) <= 1000), `B-d2 thread.live 传输延迟 ${live ? latencyMs(live) : '∞'} ms ≤ 1000`);
  // 更严的一条:从【尾巴真的变了】(liveTail.updatedAt,服务端写入时刻)到客户端收到。
  const liveWriteLag = live ? (live.at - Date.parse(String(live.data.updatedAt || ''))) : Infinity;
  ok(liveWriteLag <= 1000, `B-d3 从 liveTail 写入到客户端收到 ${Number.isFinite(liveWriteLag) ? liveWriteLag : '∞'} ms ≤ 1000`);
  const toolLive = await waitForFrame(stream, f => f.event === 'thread.live' && f.data && f.data.sessionId === sessionId && f.data.tool === 'file_read', 60000);
  ok(Boolean(toolLive), `B-d4 thread.live 带得出当前工具名(tool=${toolLive && toolLive.data.tool})`);

  /* ═════════ c 提问 -> thread.needs_you ═════════ */
  const needs = await waitForFrame(stream, f => f.event === 'thread.needs_you' && f.data && f.data.sessionId === sessionId, 60000);
  ok(Boolean(needs && needs.data.kind === 'question' && needs.data.interventionId),
    `B-c1 thread.needs_you(§6.3 指标 c;实得 kind=${needs && needs.data.kind})`);
  ok(Boolean(needs && latencyMs(needs) <= 1000), `B-c2 thread.needs_you 延迟 ${needs ? latencyMs(needs) : '∞'} ms ≤ 1000`);
  const waiting = await waitForFrame(stream, f => f.event === 'thread.state' && f.data && f.data.sessionId === sessionId && f.data.state === 'needs_you', 30000);
  ok(Boolean(waiting && waiting.data.wait >= 1), `B-c3 同时来一条 thread.state needs_you(wait=${waiting && waiting.data.wait})`);

  /* ═════════ b 收工 -> thread.done(连接【不断】,延迟才测得准)═════════ */
  const answered = await request(appPort, 'POST', '/api/chat/answer', {
    sessionId, questionId: needs.data.interventionId,
    answers: [{ question: '用哪个框架?', answer: ['Vue'] }], content: '用哪个框架?: Vue',
  }, token);
  ok(Boolean(answered && answered.status === 200), `B-b0 回答提问(status ${answered && answered.status})`);
  const doneFrame = await waitForFrame(stream, f => f.event === 'thread.done' && f.data && f.data.sessionId === sessionId, 60000);
  ok(Boolean(doneFrame), 'B-b1 thread.done(§6.3 指标 b)');
  ok(Boolean(doneFrame && String(doneFrame.data.summary || '').includes('收工')),
    `B-b2 thread.done 当场带 summary(实得 ${JSON.stringify(doneFrame && doneFrame.data.summary)})`);
  ok(Boolean(doneFrame && latencyMs(doneFrame) <= 1000), `B-b3 thread.done 延迟 ${doneFrame ? latencyMs(doneFrame) : '∞'} ms ≤ 1000`);
  const settled = await waitForFrame(stream, f => f.event === 'thread.state' && f.data && f.data.sessionId === sessionId && f.data.state !== 'running' && f.data.state !== 'needs_you', 30000);
  ok(Boolean(settled), `B-b4 收工后五态跟着变(实得 ${settled && settled.data.state})`);
  ok(Boolean(settled && latencyMs(settled) <= 1000), `B-b5 收工后的 thread.state 延迟 ${settled ? latencyMs(settled) : '∞'} ms ≤ 1000`);

  /* ═════════ C thread.live 节流 ≥500 ms ═════════ */
  const liveSoFar = stream.frames.filter(f => f.event === 'thread.live' && f.data && f.data.sessionId === sessionId);
  ok(liveSoFar.length >= 2, `C1 同一条线程收到 ≥2 条 thread.live(实得 ${liveSoFar.length} 条,节流才有得测)`);
  let minGap = Infinity;
  for (let i = 1; i < liveSoFar.length; i++) {
    const gap = Date.parse(liveSoFar[i].data.at) - Date.parse(liveSoFar[i - 1].data.at);
    if (gap < minGap) minGap = gap;
  }
  ok(liveSoFar.length < 2 || minGap >= 500, `C2 相邻两条 thread.live 服务端间隔 ≥500 ms(最小实得 ${minGap} ms)`);

  /* ═════════ D 断线补发 ═════════ */
  // 掐掉连接 -> 在断开期间把这条线程归到一个任务(thread.adopted + thread.state 两帧)
  // -> 带 Last-Event-ID 重连,漏掉的那些必须补齐。
  const lastIdBeforeDrop = stream.frames.filter(f => f.id).map(f => f.id).pop() || 0;
  const framesBeforeDrop = stream.frames.slice();
  stream.close();
  await sleep(300);
  const mission = await request(appPort, 'POST', '/api/missions', { title: '一个容器' }, token);
  const missionId = mission && mission.json && mission.json.mission && mission.json.mission.missionId;
  ok(Boolean(missionId), `D0a 建出任务容器(${missionId || '失败'})`);
  const attached = await request(appPort, 'POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId }, token);
  ok(Boolean(attached && attached.json && attached.json.ok === true && attached.json.changed === true),
    `D0b 断线期间把线程归到那个任务(changed=${attached && attached.json && attached.json.changed})`);
  await sleep(800);
  const reconnected = openStream(appPort, token, '?lens=classic&sessionId=' + encodeURIComponent(sessionId), lastIdBeforeDrop);
  await reconnected.ready;
  ok(reconnected.status === 200, 'D2 带 Last-Event-ID 重连成功');
  const ack2 = await waitForFrame(reconnected, f => f.event === 'presence.ack', 5000);
  ok(Boolean(ack2 && ack2.data.lens === 'classic' && ack2.data.sessionId === sessionId),
    'D3 第二条连接的 presence.ack 回显它自己的在场参数');
  const replayed = reconnected.frames.filter(f => f.id > 0);
  ok(replayed.length > 0 && replayed.every(f => f.id > lastIdBeforeDrop),
    `D4 补发的帧全部 id > ${lastIdBeforeDrop}(补 ${replayed.length} 条,无重复旧帧)`);
  const ids = replayed.map(f => f.id);
  ok(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'D5 补发的 id 单调递增');
  const adopted = replayed.find(f => f.event === 'thread.adopted');
  ok(Boolean(adopted && adopted.data.sessionId === sessionId && adopted.data.missionId === missionId),
    `D6 断线期间发生的 thread.adopted 真的补到了(实得 ${JSON.stringify(adopted && adopted.data)};补发事件名:${[...new Set(replayed.map(f => f.event))].join(',') || '(空)'})`);

  /* ═════════ inbox.appended ═════════ */
  const inbox = (await waitForFrame(reconnected, f => f.event === 'inbox.appended', 60000))
    || framesBeforeDrop.find(f => f.event === 'inbox.appended');
  ok(Boolean(inbox && inbox.data && inbox.data.kind), `B-g1 inbox.appended(kind=${inbox && inbox.data && inbox.data.kind})`);

  /* ═════════ E 红线:不承载工具输出正文 ═════════ */
  const everything = JSON.stringify(framesBeforeDrop.concat(reconnected.frames).map(f => f.data));
  ok(!everything.includes(TOOL_SECRET), 'E1 全程没有任何一帧带出工具结果正文(§6.1 红线①)');
  ok(everything.length > 0 && !/"input"|"arguments"/.test(everything), 'E2 也不带工具入参');

  /* ═════════ G 引擎订阅者仍是第一个 ═════════ */
  // 34 号文 §9 K2a 行的验收项:「引擎单订阅者行为逐字节不变(05:493 的那一个仍第一个收到)」。
  // 两条证据,一条行为一条静态:
  //   G1 行为:thread.live 的 textTail 取自 reg.liveTail.text,而旁路订阅者是在 appendLiveTail
  //      【更新完尾巴之后】才被调的 —— 收到的帧里尾巴非空、且就是模型这一回合说的话,
  //      说明旁路看见的是引擎那一步的结果,不是它之前的空壳。旁路要是排在前面,textTail 恒为空。
  //   G2 静态:04 的 installActiveChildEventFanout 里,engineSubscriber( 必须出现在
  //      notifyActiveChildTaps( 之前(顺序即「谁先收到」)。
  const liveWithText = liveSoFar.find(f => String(f.data.textTail || '').length > 0);
  ok(Boolean(liveWithText && liveWithText.data.textTail.includes('我在看这件事')),
    `G1 thread.live 的 textTail 是引擎这一步刚写进 liveTail 的话(实得 ${JSON.stringify(liveWithText && liveWithText.data.textTail.slice(-24))})`);
  const src04 = fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', '04-permission-runtime.js'), 'utf8');
  const fanout = src04.slice(src04.indexOf('function installActiveChildEventFanout('));
  const iEngine = fanout.indexOf('engineSubscriber(evt)');
  const iTaps = fanout.indexOf('notifyActiveChildTaps(reg, evt)');
  ok(iEngine > 0 && iTaps > iEngine, `G2 04 的扇出里引擎订阅者排在旁路【之前】(engineSubscriber@${iEngine} < taps@${iTaps})`);

  /* ═════════ 心跳存在性(不等 25 s,只钉「连接还活着且没乱写」)═════════ */
  ok(reconnected.comments.every(c => c.text.startsWith(':')), 'F1 心跳行是 SSE 注释形态(`: ping`),不污染事件解析');

  reconnected.close();
} catch (error) {
  fail += 1;
  console.log('FAIL 夹具异常: ' + ((error && error.stack) || error));
} finally {
  try { if (stream) stream.close(); } catch { /* ignore */ }
  killTree(server);
  try { if (provider) provider.close(); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp dir */ }
}

console.log('\nEVENT STREAM E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
})();
