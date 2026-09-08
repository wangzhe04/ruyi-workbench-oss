#!/usr/bin/env node
'use strict';
// E2E(第 117 波 117l-A1 · 27 号文 §11.9 D2/D3/D7 + liveTail/asksYou):
// 「递话按目标状态选通道」的四条路 + 用户撞用户真串行 + 新线程模型分档 + liveTail/asksYou。
//
// 用户第四轮走查的 ①⑥ 是同一起事故:线程挂在 request_user_input 上等用户回答,管家把一句新话
// 递过去 —— 修前要么当场 `steward.busy`(文案还说成「我正忙着上一件」= 管家忙,其实是线程忙),
// 要么直接起一个新回合 supersede 掉那个等回答的回合,把用户还没答的问题杀成 failed。
//
// 覆盖:
//   (A) answer 通道:线程挂着正式待决 question → 递话 = 回答。待决消失、该线程【没有】turn_kill、
//       request_user_input 的工具结果 ok、回合正常收尾。
//   (B) permission 通道:线程挂着 permission 待决 → 不代答,propose_required(reason:'pending_permission')。
//   (C) steer 通道:线程在跑且无待决 → 插话入队(不新起回合、不 supersede)。
//   (D) turn 通道:线程空闲 → 起新回合。
//   (E) HTTP 面 POST /api/steward/relay 与工具面同一条核心(四通道一致)。
//   (F) 用户撞用户真串行:两次并发 POST /api/steward/message,第二次严格等第一次收尾后才开跑,
//       两条 assistant 消息各自完整、顺序正确、零并跑。
//   (G) 新线程模型分档:strong/fast 各建一条线程后 engineRoute 对得上;provider 不存在时回落 + 审计;
//       速查线程恒 fast。
//   (H) liveTail:活回合时 GET /api/sessions/:id 的信封里有尾巴,回合结束后消失。
//   (I) asksYou 三态(question / soft / null)。
//   (K) 117o-A7:一条线程 = 一个 2.0 会话。用户原话「我希望 3.0 的每一条线程,都能对应 2.0 的一个会话」——
//       架构上一直成立(steward_thread_new 走的就是 createSession),但从来没有断言看着它。
//       这一条把它钉死:管家开出来的线程 ① 出现在 GET /api/sessions 的列表里(经典壳侧栏读的就是这一份)、
//       ② GET /api/sessions/:id 打得开(「看全文」走的就是这条路)、③ 它的 kind='mission' 不是把它从
//       2.0 会话面赶出去的理由。以后谁给列表加 kind 过滤,这条当场红。
//
// 判定行:`STEWARD RELAY CHANNELS E2E: ALL PASS`。
(async () => {
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-relay-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } }

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();
const sessionsDir = path.join(HOME, 'sessions');
const logsDir = path.join(HOME, 'logs');
const configFile = path.join(HOME, 'config.json');

// ── fake provider ──────────────────────────────────────────────────────────────────────────
// 按最后一条 user 消息里的暗号分流:
//   'ASK'   → 一条 request_user_input 工具调用(挂成正式待决 question);答完之后收尾。
//   'SLOW'  → 先流两段文本(给 liveTail 看)再停 —— 单次回合持续 ~2.5s。
//   其余    → 一段普通文本。
// 管家会话(system 里有「我是如意」)恒回结构化契约 JSON,say 里带一个可辨认的序号。
let stewardReplies = [];   // 依次弹出;空了就用默认
let stewardDelayMs = 0;
let slowDelayMs = 2500;
const providerHits = [];
const providerServer = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if ((req.url || '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"data":[{"id":"fake-model"},{"id":"fast-model"},{"id":"strong-model"}]}');
  }
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sys = messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
  const isSteward = /我是如意/.test(sys);
  const users = messages.filter(m => m && m.role === 'user').map(m => String(m.content || ''));
  const lastUser = users.length ? users[users.length - 1] : '';
  const answered = messages.some(m => m && m.role === 'tool' && /workbench_user_answer|走 A|"ok":true/.test(String(m.content || '')));
  providerHits.push({ isSteward, model: String(body.model || ''), lastUser: lastUser.slice(-60) });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* client gone */ } };
  const done = () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* client gone */ } };

  if (isSteward) {
    if (stewardDelayMs) await sleep(stewardDelayMs);
    const text = stewardReplies.length ? stewardReplies.shift() : JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] });
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    return done();
  }
  if (/ASK/.test(lastUser) && !answered) {
    const args = JSON.stringify({ questions: [{
      id: 'plan', header: '走哪条', question: '走 A 还是走 B?', answerMode: 'single',
      options: [{ id: 'a', label: '走 A' }, { id: 'b', label: '走 B' }], allowOther: true,
    }] });
    sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_relay_q', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    return done();
  }
  if (/PERM/.test(lastUser) && !messages.some(m => m && m.role === 'tool')) {
    const args = JSON.stringify({ path: 'relay-perm.txt', content: 'hi' });
    sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_relay_perm', type: 'function', function: { name: 'file_write', arguments: '' } }] }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    return done();
  }
  if (/SLOW/.test(lastUser)) {
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '我正在一步一步地看这件事' }, finish_reason: null }] });
    await sleep(Math.max(200, slowDelayMs - 200));
    sse({ choices: [{ index: 0, delta: { content: ',马上就好。' }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
    return done();
  }
  sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '好的,记下了。' }, finish_reason: null }] });
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
  return done();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

fs.mkdirSync(HOME, { recursive: true });
function writeConfig(patch) {
  const base = `http://127.0.0.1:${PROVIDER_PORT}`;
  const config = {
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'default', permissionTimeoutMs: 120000, questionTimeoutMs: 120000,
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 0, killOnDisconnect: false, locale: 'zh-CN',
    stewardEnabledV1: true, stewardPollMs: 120000, stewardReadBudgetChars: 4000,
    stewardMaxTurnsPerHour: 500, stewardMaxCostPerDay: 0,
    stewardGlobalMaxTurnsPerHour: 2000, stewardGlobalMaxCostPerDay: 0,
    stewardProviderId: 'fake', stewardModel: 'fake-model',
    stewardThreadBriefV1: false,
    providers: [
      { id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: base, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] },
      { id: 'fast-ep', label: 'Fast', type: 'openai-compat', baseUrl: base, apiKey: 'k', model: 'fast-model', models: [{ id: 'fast-model', label: 'Fast' }] },
      { id: 'strong-ep', label: 'Strong', type: 'openai-compat', baseUrl: base, apiKey: 'k', model: 'strong-model', models: [{ id: 'strong-model', label: 'Strong' }] },
    ],
    ...patch,
  };
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8');
}
writeConfig({});

function request(method, p, body, headers) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: p, method, timeout: 60000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(headers || {}) },
    }, res => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { json = null; } resolve({ status: res.statusCode, json, raw: b }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}
async function waitUp() {
  for (let i = 0; i < 150; i++) { const h = await request('GET', '/health'); if (h.status === 200) return true; await sleep(120); }
  return false;
}
async function tokenOf() {
  const html = await new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); });
    r.on('error', () => resolve(''));
  });
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}
function auditRows() {
  const out = [];
  for (const f of (fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [])) {
    if (!f.endsWith('.ndjson')) continue;
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return out;
}
const sessionHead = id => { try { return JSON.parse(fs.readFileSync(path.join(sessionsDir, id + '.json'), 'utf8')); } catch { return null; } };
const sessionMessages = id => {
  try {
    return fs.readFileSync(path.join(sessionsDir, id + '.messages.ndjson'), 'utf8').split('\n')
      .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

let hdr = {};
let wb = null;
let wsTopSeq = 0;
const mkwsTop = () => { const c = path.join(HOME, 'ws', 'top' + (++wsTopSeq)); fs.mkdirSync(c, { recursive: true }); return c; };
try {
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stdout.on('data', () => {});
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  ok(await waitUp(), '工作台启动');
  hdr = { 'x-wcw-token': await tokenOf() };

  // 建管家会话(唯一合法方式)。
  await request('POST', '/api/steward/message', { message: '现在什么情况' }, hdr);

  // 每条线程一个【独立】工作文件夹:116h 的仲裁器对同 cwd 的写者是互斥的(cwd-write 锁),
  // 一条挂在提问上的线程会把同目录的后来者永远挡在队列里 —— 那不是本件要测的东西。
  let wsSeq = 0;
  const newThread = async title => {
    const cwd = path.join(HOME, 'ws', 'w' + (++wsSeq));
    fs.mkdirSync(cwd, { recursive: true });
    const created = await request('POST', '/api/sessions', { title, cwd }, hdr);
    return created.json && created.json.session && created.json.session.id;
  };
  const cwdOf = sid => String((sessionHead(sid) || {}).cwd || HOME);
  const mkws = () => { const c = path.join(HOME, 'ws', 'w' + (++wsSeq)); fs.mkdirSync(c, { recursive: true }); return c; };
  // 不等回合结束地起一个线程回合(它会挂在提问上/慢跑)。
  const fireTurn = (sessionId, message) => {
    const body = JSON.stringify({ sessionId, message, cwd: cwdOf(sessionId) });
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', timeout: 120000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...hdr },
    }, res => { res.on('data', () => {}); res.on('end', () => {}); });
    r.on('error', () => {});
    r.write(body); r.end();
    return r;
  };
  // 待决直接读旁路账(投影索引是懒重建的,测试不该等它)。同一条 id 多行时最后一行为准。
  const pendingOf = async sessionId => {
    let raw = '';
    try { raw = fs.readFileSync(path.join(sessionsDir, sessionId + '.interventions.ndjson'), 'utf8'); } catch { return []; }
    const byId = new Map();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let row = null; try { row = JSON.parse(line); } catch { continue; }
      if (!row || !row.id) continue;
      byId.set(String(row.id), { ...(byId.get(String(row.id)) || {}), ...row });
    }
    return [...byId.values()].filter(iv => iv && iv.status === 'pending');
  };
  const waitPending = async (sessionId, type) => {
    for (let i = 0; i < 200; i++) {
      const rows = await pendingOf(sessionId);
      const hit = rows.find(iv => !type || iv.type === type);
      if (hit) return hit;
      await sleep(100);
    }
    return null;
  };
  const relayViaTool = (sessionId, message) => request('POST', '/api/steward/act',
    { act: { kind: 'tool', tool: 'steward_thread_continue', args: { sessionId, message } } }, hdr);

  /* ═════════ (A) answer 通道 ═════════ */
  console.log('── (A) answer 通道:线程在等回答时,递话 = 回答 ──');
  let sidA = '';
  {
    sidA = await newThread('美股预判');
    fireTurn(sidA, 'ASK 帮我预判一下美股今晚走势');
    const q = await waitPending(sidA, 'question');
    ok(!!q, `A0 线程挂上了正式待决 question(got ${q && q.id})`);
    const before = auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sidA).length;

    const relayed = await relayViaTool(sidA, '走 A');
    const result = relayed.json && relayed.json.result;
    ok(!!(result && result.ok === true && result.channel === 'answer'),
      `A1 递话走 answer 通道(got channel=${result && result.channel} ok=${result && result.ok} err=${result && result.error})`);
    ok(!!(q && result && result.questionId === q.id), `A2 回执带上被回答的 questionId(got ${result && result.questionId})`);

    // 待决消失 + 回合正常收尾。
    let gone = false;
    for (let i = 0; i < 200; i++) { if (!q || !(await pendingOf(sidA)).some(iv => iv.id === q.id)) { gone = true; break; } await sleep(100); }
    ok(gone, 'A3 answer 之后 pendingQuestions 里那条待决消失');
    const kills = auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sidA).length;
    ok(kills === before, `A4 该线程【没有】turn_kill(superseded)(before=${before} after=${kills})`);
    let settled = null;
    for (let i = 0; i < 200; i++) {
      const rows = auditRows().filter(r => r && r.kind === 'turn_end' && r.sessionId === sidA);
      if (rows.length) { settled = rows[rows.length - 1]; break; }
      await sleep(100);
    }
    ok(!!settled && settled.aborted !== true, `A5 该回合正常收尾(不是 aborted;got ${settled && JSON.stringify(settled.aborted)})`);
    const msgs = sessionMessages(sidA);
    const toolMsg = msgs.find(m => m && /workbench_user_answer/.test(JSON.stringify(m.content || '')));
    ok(!!toolMsg || msgs.some(m => m && m.role === 'assistant' && /记下了/.test(String(m.content || ''))),
      'A6 request_user_input 的结果被线程收下并继续跑完(会话正文里有它之后的助手消息)');
  }

  /* ═════════ (B) permission 通道:不代答 ═════════ */
  console.log('── (B) permission 通道:有 permission 待决时不代答 ──');
  {
    const sid = await newThread('要批准的线程');
    // 真实路径:线程调 file_write(edit 档)→ permissionMode 'default' 下挂成一条【活】permission 待决。
    // 合成一条旁路账 pending 是不够的:递话通道只认内存里真有人在等的那种(见 stewardRelayChannelFor 头注)。
    fireTurn(sid, 'PERM 写个文件');
    const perm = await waitPending(sid, 'permission');
    ok(!!perm, `B0 线程挂上了活的 permission 待决(got ${perm && perm.id})`);
    const seqBefore = Number((sessionHead(sid) || {}).turnSeq || 0);
    const relayed = await relayViaTool(sid, '继续吧');
    const result = relayed.json && relayed.json.result;
    ok(!!(result && result.ok === false && result.error === 'propose_required' && result.reason === 'pending_permission'),
      `B1 有 permission 待决 → propose_required(pending_permission)(got ${result && (result.error || 'ok')}/${result && result.reason})`);
    const killsB = auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sid).length;
    ok(killsB === 0, `B2 没有 supersede 掉那个等批准的回合(turn_kill=${killsB})`);
    ok(Number((sessionHead(sid) || {}).turnSeq || 0) === seqBefore, 'B3 会话头的 turnSeq 一字不动');
  }

  /* ═════════ (C) steer 通道:在跑且无待决 ═════════ */
  console.log('── (C) steer 通道:线程在跑时插话,不新起回合 ──');
  {
    const sid = await newThread('慢线程');
    fireTurn(sid, 'SLOW 慢慢做');
    // 等它真的进 activeChildren(会话头 turnSeq 已经+1 且回合还没收尾)。
    let live = false;
    for (let i = 0; i < 200; i++) {
      const s = await request('GET', `/api/sessions/${sid}`, undefined, hdr);
      if (s.json && s.json.resumable && Number((s.json.session || {}).turnSeq || 0) >= 1) { live = true; break; }
      await sleep(60);
    }
    ok(live, 'C0 线程已经开跑');
    const relayed = await relayViaTool(sid, '顺便也看看华南');
    const result = relayed.json && relayed.json.result;
    ok(!!(result && result.ok === true && result.channel === 'steer'),
      `C1 在跑的线程 → steer 通道(got channel=${result && result.channel} err=${result && result.error})`);
    ok(Number(result && result.queued) >= 1, `C2 插话真的入队(queued=${result && result.queued})`);
    const kills = auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sid).length;
    ok(kills === 0, `C3 没有 supersede 掉在跑的回合(turn_kill=${kills})`);
    await sleep(3000);
  }

  /* ═════════ (D) turn 通道:空闲线程 ═════════ */
  console.log('── (D) turn 通道:空闲线程起新回合 ──');
  {
    const sid = await newThread('空闲线程');
    const relayed = await relayViaTool(sid, '帮我看一下这件事');
    const result = relayed.json && relayed.json.result;
    ok(!!(result && result.ok === true && result.channel === 'turn'),
      `D1 空闲线程 → turn 通道(got channel=${result && result.channel} err=${result && result.error})`);
    let ran = false;
    for (let i = 0; i < 200; i++) { if (Number((sessionHead(sid) || {}).turnSeq || 0) >= 1) { ran = true; break; } await sleep(100); }
    ok(ran, 'D2 真的起了一个回合');
  }

  /* ═════════ (E) HTTP 面 POST /api/steward/relay ═════════ */
  console.log('── (E) POST /api/steward/relay 与工具面同核心 ──');
  {
    const sid = await newThread('抽屉直说');
    const idle = await request('POST', '/api/steward/relay', { sessionId: sid, message: '直接对这条线程说' }, hdr);
    ok(idle.status === 200 && idle.json && idle.json.ok === true && idle.json.channel === 'turn',
      `E1 空闲线程 → 200 channel=turn(got ${idle.status}/${idle.json && idle.json.channel})`);
    const noToken = await request('POST', '/api/steward/relay', { sessionId: sid, message: 'x' });
    ok(noToken.status === 403, `E2 无 token → 403(got ${noToken.status})`);
    const bad = await request('POST', '/api/steward/relay', { sessionId: 'not a session', message: 'x' }, hdr);
    ok(bad.status >= 400, `E3 非法 sessionId → 4xx(got ${bad.status})`);

    // answer 通道也走同一条 HTTP 面。
    const sid2 = await newThread('抽屉答问');
    fireTurn(sid2, 'ASK 走哪条');
    const q = await waitPending(sid2, 'question');
    ok(!!q, 'E4 第二条线程挂上了待决');
    const answered = await request('POST', '/api/steward/relay', { sessionId: sid2, message: '走 B' }, hdr);
    ok(answered.status === 200 && answered.json && answered.json.channel === 'answer' && answered.json.questionId === (q || {}).id,
      `E5 HTTP 面同样走 answer 通道(got ${answered.json && answered.json.channel})`);
    const kills = auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sid2).length;
    ok(kills === 0, `E6 HTTP 面同样不 supersede(turn_kill=${kills})`);
    await sleep(1200);
  }

  /* ═════════ (F) 用户撞用户真串行 ═════════ */
  console.log('── (F) 用户连发两句:服务端严格串行 ──');
  {
    stewardDelayMs = 2000;
    stewardReplies = [
      JSON.stringify({ say: '第一句的回答。', why: '用户第一句', acts: [], actions: [] }),
      JSON.stringify({ say: '第二句的回答。', why: '用户第二句', acts: [], actions: [] }),
    ];
    const before = sessionMessages('steward').filter(m => m && m.role === 'assistant').length;
    const t0 = Date.now();
    const p1 = request('POST', '/api/steward/message', { message: '第一句' }, hdr);
    await sleep(150);
    const p2 = request('POST', '/api/steward/message', { message: '第二句' }, hdr);
    const [r1, r2] = await Promise.all([p1, p2]);
    const elapsed = Date.now() - t0;
    ok(r1.status === 200 && r2.status === 200, `F1 两次请求都 200(got ${r1.status}/${r2.status})`);
    ok(/第一句的回答/.test(r1.raw), 'F2 第一句拿到自己的回答');
    ok(/第二句的回答/.test(r2.raw), `F3 第二句拿到自己的回答(不是 steward.busy;raw 尾: ${String(r2.raw).slice(-160)})`);
    ok(elapsed >= 3500, `F4 第二句严格排在第一句之后(两回合各 ~2s,合计 ${elapsed}ms ≥ 3500ms = 没有并跑)`);
    const after = sessionMessages('steward').filter(m => m && m.role === 'assistant');
    ok(after.length >= before + 2, `F5 管家会话里两条 assistant 消息都完整落盘(${before} → ${after.length})`);
    const tail = after.slice(-2).map(m => String(m.content || ''));
    ok(/第一句的回答/.test(tail[0]) && /第二句的回答/.test(tail[1]), `F6 顺序正确(got ${JSON.stringify(tail.map(t => t.slice(0, 20)))})`);
    ok(auditRows().some(r => r && r.kind === 'steward_user_turn_queued' && Number(r.waitedMs) > 0),
      'F7 真等过的那一次记了 steward_user_turn_queued{waitedMs}');
    stewardDelayMs = 0;
    stewardReplies = [];
  }

  /* ═════════ (G) 新线程模型分档 ═════════ */
  console.log('── (G) 新线程按 tier 选端点/模型 ──');
  {
    const patch = await request('POST', '/api/config', {
      stewardThreadModels: { strong: { providerId: 'strong-ep', model: 'strong-model' }, fast: { providerId: 'fast-ep', model: '' } },
    }, hdr);
    ok(patch.status === 200, `G0 POST /api/config 收下 stewardThreadModels(got ${patch.status})`);
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    ok(cfg.stewardThreadModels && cfg.stewardThreadModels.strong.providerId === 'strong-ep' && cfg.stewardThreadModels.fast.providerId === 'fast-ep',
      'G1 整对象落盘并被归一');

    const mk = (args) => request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_thread_new', args } }, hdr);
    const strong = await mk({ title: '复杂任务', brief: { userText: '帮我把这个重构了' }, tier: 'strong', cwd: mkws() });
    const strongId = strong.json && strong.json.result && strong.json.result.sessionId;
    ok(!!strongId, `G2 strong 线程建起来了(got ${strongId})`);
    const strongHead = await request('GET', `/api/sessions/${strongId}`, undefined, hdr);
    const sr = strongHead.json && strongHead.json.session && strongHead.json.session.engineRoute;
    ok(!!(sr && sr.providerId === 'strong-ep' && sr.model === 'strong-model'), `G3 strong 线程 engineRoute 对得上(got ${JSON.stringify(sr)})`);

    const fast = await mk({ title: '简单任务', brief: { userText: '改一行就行' }, tier: 'fast', cwd: mkws() });
    const fastId = fast.json && fast.json.result && fast.json.result.sessionId;
    const fastHead = await request('GET', `/api/sessions/${fastId}`, undefined, hdr);
    const fr = fastHead.json && fastHead.json.session && fastHead.json.session.engineRoute;
    ok(!!(fr && fr.providerId === 'fast-ep' && fr.model === 'fast-model'), `G4 fast 档 model 为空 → 用该 provider 自己的模型(got ${JSON.stringify(fr)})`);

    // provider 不存在 → 回落全局 + 审计。
    await request('POST', '/api/config', { stewardThreadModels: { strong: { providerId: 'ghost-ep', model: 'x' }, fast: { providerId: 'fast-ep', model: '' } } }, hdr);
    const ghost = await mk({ title: '回落', brief: { userText: '随便看看' }, cwd: mkws() });   // 缺省 tier = strong
    const ghostId = ghost.json && ghost.json.result && ghost.json.result.sessionId;
    const ghostHead = await request('GET', `/api/sessions/${ghostId}`, undefined, hdr);
    const gr = ghostHead.json && ghostHead.json.session && ghostHead.json.session.engineRoute;
    ok(!!(gr && gr.providerId === 'fake'), `G5 provider 不存在 → 回落全局主端点(got ${JSON.stringify(gr)})`);
    ok(auditRows().some(r => r && r.kind === 'steward_thread_model_fallback' && r.providerId === 'ghost-ep'),
      'G6 回落记了审计 steward_thread_model_fallback');

    // steward_config_set 不能改这两个键。
    const forbidden = await request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_config_set', args: { patch: { stewardThreadModels: { strong: { providerId: 'fake', model: 'fake-model' }, fast: { providerId: '', model: '' } } } } } }, hdr);
    const fres = forbidden.json && forbidden.json.result;
    ok(!!(fres && fres.ok === false), `G8 steward_config_set 白名单不含 stewardThreadModels(got ${fres && (fres.error || 'ok')})`);
    await request('POST', '/api/config', { stewardThreadModels: { strong: { providerId: '', model: '' }, fast: { providerId: '', model: '' } } }, hdr);
  }

  /* ═════════ (H) liveTail ═════════ */
  console.log('── (H) liveTail:活回合的尾巴 ──');
  {
    const sid = await newThread('看尾巴');
    fireTurn(sid, 'SLOW 看尾巴');
    let tail = null;
    let liveResumable = null;
    for (let i = 0; i < 200; i++) {
      const s = await request('GET', `/api/sessions/${sid}`, undefined, hdr);
      if (s.json && s.json.liveTail && String(s.json.liveTail.text || '')) { tail = s.json.liveTail; liveResumable = s.json.resumable; break; }
      await sleep(60);
    }
    ok(!!tail, `H1 活回合时 GET /api/sessions/:id 带 liveTail(got ${JSON.stringify(tail)})`);
    ok(!!(tail && /一步一步/.test(String(tail.text || ''))), `H2 liveTail.text 是活回合真正流出来的文本(got ${tail && String(tail.text).slice(0, 40)})`);
    // 117l-A1-fix2(§11.9;B1 实现抽屉时发现,主会话核对源码):抽屉 isLive() 第一判据是
    // `resumable && resumable.live === true`,而【活回合】分支修前只回
    // { dangling:false, kind:null, turnSeq, historyLength } —— 没有 live 键,这条判据从没走通过,
    // 一直静默回落到「事项行五态 === 'running'」;挂在 request_user_input 上等答案时五态是
    // needs_you,于是恒判成不在跑。钉住活回合期间这个键必须是 true。
    ok(!!(liveResumable && liveResumable.live === true), `H1b 活回合时 resumable.live === true(got ${JSON.stringify(liveResumable)})`);
    let idleResumable = null;
    for (let i = 0; i < 300; i++) {
      const s = await request('GET', `/api/sessions/${sid}`, undefined, hdr);
      if (!s.json || !s.json.liveTail) { tail = null; idleResumable = s.json && s.json.resumable; break; }
      await sleep(100);
    }
    ok(tail === null, 'H3 回合结束后 liveTail 不再下发(不落盘)');
    // companion:回合结束后不是活回合,resumable.live 不该是 true —— detectDanglingTurn 那一支的
    // 形状一个字不动(悬挂与否是另一条判据的事,不在本条范围内)。
    ok(!(idleResumable && idleResumable.live === true), `H3b 回合结束后 resumable.live 不是 true(got ${JSON.stringify(idleResumable)})`);
  }

  /* ═════ (I2) 看板行的 asksYou ═════ */
  console.log('── (I2) GET /api/missions 的线程行带 asksYou ──');
  {
    // 看板行只对【任务线程】(kind:'mission')建卡,所以用 steward_thread_new 开一条。
    const made = await request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_thread_new', args: { title: '在问你的任务', brief: { userText: '帮我看一下' }, cwd: mkws() } } }, hdr);
    const mid = made.json && made.json.result && made.json.result.sessionId;
    ok(!!mid, `I2a 任务线程建起来了(got ${mid})`);
    // 待决行直接写旁路账:看板行的 asksYou 读的就是投影里的待决(与五态同一份事实源)。
    fs.appendFileSync(path.join(sessionsDir, mid + '.interventions.ndjson'), JSON.stringify({
      id: 'question_board_1', type: 'question', sessionId: mid, status: 'pending',
      requestedAt: new Date().toISOString(), interventionVersion: 1,
      questions: [{ id: 'q1', question: '这两个方案你选哪个？', answerMode: 'single', options: [] }],
      questionSummary: '这两个方案你选哪个？',
    }) + '\n', 'utf8');
    let row = null;
    for (let i = 0; i < 100; i++) {
      const missions = await request('GET', '/api/missions', undefined, hdr);
      row = ((missions.json && missions.json.missions) || []).find(m => m && m.sessionId === mid) || null;
      if (row && row.asksYou) break;
      await sleep(120);
    }
    ok(!!(row && row.asksYou && row.asksYou.kind === 'question' && /选哪个/.test(String(row.asksYou.text || ''))),
      `I2 看板行带 asksYou(question)(got ${JSON.stringify(row && row.asksYou)})`);
    ok(!!(row && Object.prototype.hasOwnProperty.call(row, 'pending') && Object.prototype.hasOwnProperty.call(row, 'activeTurn')),
      'I2b 看板行的既有字段一个不少(只加不改)');

    /* 117m-A2:挂着 permission 的线程,看板行也要有 asksYou —— 修前这里恒 null,
       于是那一行标着「需要你」却连一枚 pill 都没有(用户第六轮走查⑥的截图)。 */
    const made2 = await request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_thread_new', args: { title: '等你放行的任务', brief: { userText: '帮我跑一下' }, cwd: mkws() } } }, hdr);
    const pid = made2.json && made2.json.result && made2.json.result.sessionId;
    fs.appendFileSync(path.join(sessionsDir, pid + '.interventions.ndjson'), JSON.stringify({
      id: 'perm_board_1', type: 'permission', sessionId: pid, status: 'pending',
      requestedAt: new Date().toISOString(), interventionVersion: 1,
      toolName: 'script_run', tier: 'exec', revertible: false, input: {},
    }) + '\n', 'utf8');
    let permRow = null;
    for (let i = 0; i < 100; i++) {
      const missions = await request('GET', '/api/missions', undefined, hdr);
      permRow = ((missions.json && missions.json.missions) || []).find(m => m && m.sessionId === pid) || null;
      if (permRow && permRow.asksYou) break;
      await sleep(120);
    }
    ok(!!(permRow && permRow.asksYou && permRow.asksYou.kind === 'permission'
      && permRow.asksYou.text === '工具 script_run(exec 级)等待放行'
      && permRow.asksYou.toolName === 'script_run' && permRow.asksYou.tier === 'exec' && permRow.asksYou.revertible === false),
      `I2c 挂着 permission 的看板行也带 asksYou(kind='permission' + 人话 + toolName/tier/revertible)(got ${JSON.stringify(permRow && permRow.asksYou)})`);
  }

  /* ═════════ (J) queued 通道:线程还在仲裁器队列里时递话 ═════════ */
  // 117l-A1-fix ①(§11.9;主会话在真夹具上复核 A1 时撞出来的边界,是真丢数据)。
  // A1 的四条通道少了一种目标状态:线程【已经排在仲裁器队列里、还没开跑】。它不在 activeChildren 里
  // (09 的 activeChildren.set 在回合本体里,而回合本体要等 10 拿到并发位之后才开始跑),也没有任何
  // 待决 —— 于是修前判成 turn,stewardLaunchTurn 又排一个回合;锁一放两个回合前后脚被放行,后一个在
  // 09 的 `activeChildren.has -> stopSession('superseded')` 里把前一个就地杀掉。修前的实测:
  //   turn_start x2;turn_kill reason:'superseded';turn_end {ok:false,aborted:true} 再 {ok:true}
  //   正文只剩第二句 —— 排队中那句话连同它的回合一起没了。
  console.log('-- (J) queued 通道:线程还在排队时递话,不新开回合、不丢那句话 --');
  {
    // 同一个工作文件夹的两条线程:116h 的 cwd 写互斥会把后到的那条挡在队列里。
    const sharedCwd = mkws();
    const c1 = await request('POST', '/api/sessions', { title: '占着文件夹的', cwd: sharedCwd }, hdr);
    const c2 = await request('POST', '/api/sessions', { title: '排队的', cwd: sharedCwd }, hdr);
    const sidHold = c1.json && c1.json.session && c1.json.session.id;
    const sidQ = c2.json && c2.json.session && c2.json.session.id;
    const prevSlow = slowDelayMs;
    slowDelayMs = 6000;   // 长回合,但别超过 10 秒(用例分钟级就太慢)
    fireTurn(sidHold, 'SLOW 占住这个文件夹');
    let holding = false;
    for (let i = 0; i < 300; i++) {
      const st = await request('GET', '/api/steward/arbiter', undefined, hdr);
      if (((st.json && st.json.running) || []).some(r => r && r.sessionId === sidHold)) { holding = true; break; }
      await sleep(60);
    }
    ok(holding, `J0 第一条线程占住了这个工作文件夹的写锁(sid=${sidHold})`);

    const FIRST = '我是第一句,排队中';
    fireTurn(sidQ, FIRST);
    let queuedRow = null;
    for (let i = 0; i < 300; i++) {
      const st = await request('GET', '/api/steward/arbiter', undefined, hdr);
      queuedRow = ((st.json && st.json.queue) || []).find(r => r && r.sessionId === sidQ) || null;
      if (queuedRow) break;
      await sleep(50);
    }
    ok(!!queuedRow, `J1 第二条线程排在仲裁器队列里(既不在 activeChildren、也没有待决;got ${JSON.stringify(queuedRow)})`);

    const relayed = await request('POST', '/api/steward/relay', { sessionId: sidQ, message: '我是第二句,插队' }, hdr);
    const err = (relayed.json && relayed.json.error) || null;
    ok(relayed.status === 409 && !!err && err.code === 'steward.queued',
      `J2 排队中递话 -> 409 steward.queued(got ${relayed.status}/${err && err.code})`);
    ok(!!(err && /排队/.test(String(err.message || ''))),
      `J3 人话说清了它还在排队、这句没递进去(got ${err && JSON.stringify(err.message)})`);

    // 工具面走的是同一个判定/执行单点(与 A-E 段同一条纪律):此刻它还在排队,再递一次仍是 queued。
    const viaTool = await relayViaTool(sidQ, '我是第三句,从工具面递');
    const tr = viaTool.json && viaTool.json.result;
    ok(!!(tr && tr.ok === false && tr.error === 'steward.queued' && tr.channel === 'queued' && tr.wait && tr.wait.reason === 'lock'),
      `J3b 工具面同一条核心(got ${tr && (tr.error || 'ok')}/channel=${tr && tr.channel}/wait=${tr && JSON.stringify(tr.wait && tr.wait.reason)})`);

    // 等排队那条真的跑完,再对账「排队中那句话还在不在」。
    for (let i = 0; i < 400; i++) {
      if (auditRows().some(r => r && r.kind === 'turn_end' && r.sessionId === sidQ)) break;
      await sleep(100);
    }
    await sleep(600);
    const starts = auditRows().filter(r => r && r.kind === 'turn_start' && r.sessionId === sidQ).length;
    ok(starts === 1, `J4 排队的那条线程只开了 1 个回合(turn_start=${starts};修前是 2)`);
    const kills = auditRows().filter(r => r && r.kind === 'turn_kill' && r.sessionId === sidQ).length;
    ok(kills === 0, `J5 没有 turn_kill(superseded)(got ${kills})`);
    const userRows = sessionMessages(sidQ).filter(m => m && m.role === 'user').map(m => String(m.content || ''));
    ok(userRows[0] === FIRST, `J6 排队中的第一句话还在正文里(got ${JSON.stringify(userRows)})`);
    const ends = auditRows().filter(r => r && r.kind === 'turn_end' && r.sessionId === sidQ);
    ok(ends.length === 1 && ends[0].aborted !== true,
      `J7 那一个回合正常收尾(不是 aborted;got ${JSON.stringify(ends.map(e => ({ ok: e.ok, aborted: e.aborted })))})`);
    slowDelayMs = prevSlow;
  }

  /* ═════ (K) 117o-A7:一条线程 = 一个 2.0 会话 ═════ */
  console.log('── (K) 线程 ↔ 2.0 会话 1:1 ──');
  {
    const made = await request('POST', '/api/steward/act',
      { act: { kind: 'tool', tool: 'steward_thread_new', args: { title: '看全文这条', brief: { userText: '帮我看一眼这件事' }, cwd: mkws() } } }, hdr);
    const tid = made.json && made.json.result && made.json.result.sessionId;
    ok(!!tid, `K1 steward_thread_new 开出一条线程(got ${tid})`);
    const list = await request('GET', '/api/sessions', undefined, hdr);
    const rows = (list.json && Array.isArray(list.json.sessions)) ? list.json.sessions : [];
    ok(rows.some(r => r && r.id === tid),
      `K2 它出现在 GET /api/sessions 的列表里 —— 经典壳侧栏读的就是这一份(列表 ${rows.length} 条)`);
    const opened = await request('GET', `/api/sessions/${tid}`, undefined, hdr);
    ok(!!(opened.json && opened.json.ok === true && opened.json.session && opened.json.session.id === tid),
      `K3 GET /api/sessions/:id 打得开 —— 「看全文」走的就是这条路(HTTP ${opened.status})`);
    const kind = String((opened.json && opened.json.session && opened.json.session.kind) || '');
    ok(kind === 'mission',
      `K4 它确实是 kind:'mission' 的线程(got ${JSON.stringify(kind)})—— 但 K2/K3 照样成立,kind 不是把它赶出 2.0 会话面的理由`);
    const row = rows.find(r => r && r.id === tid);
    ok(!!(row && String(row.kind || '') === 'mission'),
      `K5 列表条目上也如实带着 kind(前端渲染无 kind 过滤,由 live-full-text.static 的 I1/I2 从另一头钉着;got ${JSON.stringify(row && row.kind)})`);
    ok(rows.filter(r => r && r.id === tid).length === 1, 'K6 列表里恰好一条(不重复、不分身)');
  }
} finally {
  kill(wb);
  wb = null;
}
await sleep(500);

/* ═════ 进程内阶段(工具面直调)═════ */
// 与 steward-guardrails.e2e.js 同款。读类工具(steward_thread_status)与 steward_quick_ask 不在
// POST /api/steward/act 的白名单里(那张表只收写类动作),所以这两段在进程内直调。
console.log('── 进程内阶段(工具面直调)──');
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(path.join(WB, 'app', 'server.js'));
const stewardCtx = () => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] } });
const call = (name, args) => srv.toolCall(name, args || {}, stewardCtx());
function craftThread(id, patch, messages) {
  const now = new Date().toISOString();
  const rows = Array.isArray(messages) ? messages : [];
  fs.writeFileSync(path.join(sessionsDir, id + '.json'), JSON.stringify({
    id, schemaVersion: 3, storageVersion: 2, turnSeq: rows.length ? 1 : 0, title: '线程 ' + id,
    summary: rows.length ? String(rows[rows.length - 1].content || '') : '',
    pinned: false, cwd: HOME, createdAt: now, updatedAt: now, claudeSessionId: null, attachments: [],
    messageCount: rows.length, providerHistoryCount: 0, mission: null, missionId: id, kind: 'mission', ...(patch || {}),
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(sessionsDir, id + '.messages.ndjson'),
    rows.map(r => JSON.stringify({ createdAt: now, turnSeq: 1, ...r })).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(sessionsDir, id + '.provider.ndjson'), '', 'utf8');
}

try {
  /* ═════ (I) asksYou 三态 ═════ */
  console.log('── (I) asksYou 三态 ──');
  {
    const SID_Q = 'sess_asksyou_question';
    const SID_S = 'sess_asksyou_softask0';
    const SID_N = 'sess_asksyou_nothing0';
    craftThread(SID_Q, {}, [{ role: 'assistant', content: '我先看一眼。' }]);
    craftThread(SID_S, {}, [{ role: 'assistant', content: '我看了一遍。要不要我把汇总也做了？' }]);
    craftThread(SID_N, {}, [{ role: 'assistant', content: '已经做完了。' }]);
    fs.appendFileSync(path.join(sessionsDir, SID_Q + '.interventions.ndjson'), JSON.stringify({
      id: 'question_inproc_1', type: 'question', sessionId: SID_Q, status: 'pending',
      requestedAt: new Date().toISOString(), interventionVersion: 1,
      questions: [{ id: 'q1', question: '走 A 还是走 B？', answerMode: 'single', options: [] }],
      questionSummary: '走 A 还是走 B？',
    }) + '\n', 'utf8');

    const st1 = await call('steward_thread_status', { sessionId: SID_Q });
    ok(!!(st1 && st1.asksYou && st1.asksYou.kind === 'question' && st1.asksYou.questionId === 'question_inproc_1' && /走 A 还是走 B/.test(String(st1.asksYou.text || ''))),
      `I1 正式待决 → asksYou.kind='question' + 问题原文(got ${JSON.stringify(st1 && st1.asksYou)})`);
    const st2 = await call('steward_thread_status', { sessionId: SID_S });
    ok(!!(st2 && st2.asksYou && st2.asksYou.kind === 'soft' && /汇总/.test(String(st2.asksYou.text || ''))),
      `I3 末句问号 → asksYou.kind='soft'(got ${JSON.stringify(st2 && st2.asksYou)})`);
    const st3 = await call('steward_thread_status', { sessionId: SID_N });
    ok(!!(st3 && st3.asksYou === null), `I4 既无待决也不是问句 → asksYou === null(got ${JSON.stringify(st3 && st3.asksYou)})`);
    ok(!!(st3 && Object.prototype.hasOwnProperty.call(st3, 'wait') && st3.state && st3.stateLabel),
      'I5 wait 与五态字段照旧在(只加不改)');
  }

  /* ═════ (I6) 117m-A2:asksYou 覆盖【四类】待决 ═════ */
  // 用户第六轮走查⑤⑥:真机 sess_8bb0dd55d35045b0 的 14 条待决全是 permission,而修前
  // stewardAsksYouForThread 只认 type==='question' —— 于是看板行没有 pill、抽屉没有问答卡,
  // 右上说「需要你 1」却点不开任何东西。这一组按四类各喂一次,再钉一次优先级。
  console.log('── (I6) asksYou 四类待决 + 固定优先级 ──');
  {
    const write = (sid, rows) => {
      craftThread(sid, {}, [{ role: 'assistant', content: '我先看一眼。' }]);
      fs.writeFileSync(path.join(sessionsDir, sid + '.interventions.ndjson'),
        rows.map(row => JSON.stringify({ sessionId: sid, status: 'pending', requestedAt: new Date().toISOString(), interventionVersion: 1, ...row })).join('\n') + '\n', 'utf8');
    };
    const SID_PERM = 'sess_asksyou_permis00';
    const SID_PLAN = 'sess_asksyou_plan0000';
    const SID_POOL = 'sess_asksyou_pool0000';
    const SID_BOTH = 'sess_asksyou_both0000';
    write(SID_PERM, [{ id: 'perm_a1', type: 'permission', toolName: 'script_run', tier: 'exec', revertible: false }]);
    write(SID_PLAN, [{ id: 'plan_a1', type: 'plan', planSummary: '先清库存再补货' }]);
    write(SID_POOL, [{ id: 'pool_a1', type: 'pool', task: '再加一条子任务' }]);
    // 同一条线程同时挂 permission(先来)与 question(后到):优先级固定,question 压过 permission。
    write(SID_BOTH, [
      { id: 'perm_b1', type: 'permission', toolName: 'Bash', tier: 'exec', revertible: false },
      { id: 'question_b1', type: 'question', questions: [{ id: 'q1', question: '走 A 还是走 B?' }], questionSummary: '走 A 还是走 B?' },
    ]);
    const perm = await call('steward_thread_status', { sessionId: SID_PERM });
    ok(!!(perm && perm.asksYou && perm.asksYou.kind === 'permission' && perm.asksYou.interventionId === 'perm_a1'
      && /script_run/.test(String(perm.asksYou.text || '')) && /exec/.test(String(perm.asksYou.text || ''))
      && perm.asksYou.toolName === 'script_run' && perm.asksYou.tier === 'exec' && perm.asksYou.revertible === false),
      `I6a permission 待决 → asksYou.kind='permission' + stewardPendingOneLine 的原话 + toolName/tier/revertible(got ${JSON.stringify(perm && perm.asksYou)})`);
    const plan = await call('steward_thread_status', { sessionId: SID_PLAN });
    ok(!!(plan && plan.asksYou && plan.asksYou.kind === 'plan' && plan.asksYou.interventionId === 'plan_a1'
      && /先清库存再补货/.test(String(plan.asksYou.text || ''))),
      `I6b plan 待决 → asksYou.kind='plan' + 计划摘要(got ${JSON.stringify(plan && plan.asksYou)})`);
    const pool = await call('steward_thread_status', { sessionId: SID_POOL });
    ok(!!(pool && pool.asksYou && pool.asksYou.kind === 'pool' && pool.asksYou.interventionId === 'pool_a1'
      && /再加一条子任务/.test(String(pool.asksYou.text || ''))),
      `I6c pool 待决 → asksYou.kind='pool' + 任务原话(got ${JSON.stringify(pool && pool.asksYou)})`);
    const both = await call('steward_thread_status', { sessionId: SID_BOTH });
    ok(!!(both && both.asksYou && both.asksYou.kind === 'question' && both.asksYou.questionId === 'question_b1'
      && both.asksYou.interventionId === 'question_b1' && /走 A 还是走 B/.test(String(both.asksYou.text || ''))),
      `I6d 优先级固定:question 压过 permission,且 question 一支照旧带 questionId(got ${JSON.stringify(both && both.asksYou)})`);
    // 「人话只有一个来源」的正面证据:permission 那一句逐字等于 06i 的 stewardPendingOneLine。
    ok(!!(perm && perm.asksYou && perm.asksYou.text === '工具 script_run(exec 级)等待放行'),
      `I6e permission 的人话逐字来自 stewardPendingOneLine 单点(got ${JSON.stringify(perm && perm.asksYou && perm.asksYou.text)})`);
    // pending 数组与五态字段照旧(只加不改)。
    ok(!!(perm && Array.isArray(perm.pending) && perm.pending.length === 1 && perm.pending[0].summary === '工具 script_run(exec 级)等待放行'
      && perm.state && perm.stateLabel),
      'I6f pending 摘要与五态字段照旧在(只加不改)');
  }

  /* ═════ (G7) 速查线程恒 fast 档 ═════ */
  console.log('── (G7) 速查线程恒 fast 档 ──');
  {
    writeConfig({ stewardThreadModels: { strong: { providerId: 'strong-ep', model: 'strong-model' }, fast: { providerId: 'fast-ep', model: '' } } });
    const quick = await call('steward_quick_ask', { question: '几个分支', cwd: mkwsTop() });
    ok(!!(quick && quick.ok === true), `G7a 速查线程建起来了(got ${quick && (quick.error || 'ok')})`);
    ok(quick && quick.tier === 'fast', `G7b 返回值带 tier='fast'(got ${quick && quick.tier})`);
    const head = sessionHead(quick && quick.sessionId);
    ok(!!(head && head.engineRoute && head.engineRoute.providerId === 'fast-ep' && head.engineRoute.model === 'fast-model'),
      `G7 速查线程的 engineRoute 走 fast 档(got ${JSON.stringify(head && head.engineRoute)})`);
  }
} finally {
  try { providerServer.close(); } catch { /* ignore */ }
}

console.log(`\nSTEWARD RELAY CHANNELS E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
})();
