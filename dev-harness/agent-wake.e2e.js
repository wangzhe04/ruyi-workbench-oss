'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:后台代理完成 → 唤醒主会话(2026-10-05 用户报:子代理跑完时主回合已经结束,主会话不会被重新唤醒)。
// provider 引擎,离线 via lib/fake-openai-provider(子代理的回复用 setTimeout 控时序,不依赖 PowerShell,Linux/Windows 都能跑)。
//
//  W1 空闲时完成:父回合 orchestrate_agents{background:true} 后就收尾;子代理 ~2.5s 后才答完 → 工作台自己起一个回合
//     (会话里多一条 meta.origin:'agent_wake' 的 user 消息,runIds 含本 run);那一回合的父请求里「[代理完成通知」恰好
//     一条、带 runId;模型的回复落盘;之后不再重复唤醒。
//  W2 忙时完成:子代理在父回合【最后一次模型调用】进行中答完(父的收尾回复被假端点拖住)→ 信封没赶上迭代边界;
//     父回合收尾后补唤醒一次,唤醒回合里恰好一条通知。
//  W3 开关关掉(agentAutoWake:false):后台代理跑完不起回合;用户下一句话的回合开头照旧带上那份信封(旧行为)。
//  W4 用户叫停的后台代理(POST /background/stop)→ 不唤醒。
//  W5 用户关了页面:W2 的时序,但客户端在工具结果之后就断开(回合在服务端照常跑完)→ 收尾照样补唤醒(第二波走查:修前
//     handleDisconnect 置了 disconnectHandled,这种收尾一律不补,而「用户离开了」正是这个功能要管的情形)。
//  W6 唤醒链上限:每个唤醒回合又起一个后台代理 → 恰好唤醒 AGENT_WAKE_CHAIN_MAX(6)次后停下。
//  W7 重启:(a) 信封已落账、唤醒没起成就重启 → 启动时补排唤醒;(b) 重启打断的后台 run → 补一份 interrupted 信封、
//     不唤醒,用户下一句话的回合开头送达(修前模型再也不知道这些代理已经没了)。
//  第三波复核(2026-10)补的几条 —— 都是「不该唤醒」或「唤醒不该越界」,信封一份不丢、随用户下一句话送达:
//  W8  面板 / HTTP 的 async 启动(用户点的,run.background 同样为 true)→ 不唤醒;信封照常随下一句话送达。
//  W9  用户 Stop 了起后台代理的回合:代理与回合 abort 脱钩、几秒后照常跑完 → 不唤醒;下一句话送达信封。
//  W10 撤回到起后台代理的那个回合之前:模型起的仍在跑的 run 被停掉、信封不再投递、不唤醒、线程里不冒出东西。
//  W11 撤回只撤掉后面的回合、起后台代理的那个回合还在:代理照常跑完,但不唤醒(撤回记了「叫停过」);信封下一句话送达。
//  W12 会话被删:不唤醒、也不会新冒出一条空会话。
//  W13 Stop 之后用户立刻重发:重发的回合起手清「叫停过」,之后代理跑完照常唤醒(不过度抑制)。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-wake');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('AGENT WAKE');
const { ok } = t;
const FRAME_ID = { id: 'chatcmpl-wake' };
const WAKE_MARK = '自动唤醒';

const textOf = m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
// 最后一条 assistant 之后的全部 user 文本(唤醒回合里 = 唤醒通知 + 迭代边界注入的完成通知)。
function tailUserText(messages) {
  let i = messages.length - 1;
  while (i >= 0 && messages[i].role !== 'assistant') i--;
  return messages.slice(i + 1).filter(m => m.role === 'user').map(textOf).join('\n');
}
const humanText = messages => messages.filter(m => m.role === 'user').map(textOf).join('\n');

let releaseLong = null;
function handleChat(req) {
  const messages = req.messages || [];
  const sys = String((messages.find(m => m && m.role === 'system') || {}).content || '');
  if (sys.includes('你是子任务执行体')) {
    const task = humanText(messages);
    req.open();
    if (task.includes('WAKE_LONG')) { releaseLong = () => { try { req.sse(textFrames('long-done', FRAME_ID)[0]); req.end(); } catch {} }; return undefined; }
    if (task.includes('WAKE_HANG')) return undefined;   // W7b:一直不答,等工作台重启把它打断
    const delay = task.includes('WAKE_SLOW') ? 2500 : task.includes('WAKE_MID') ? 800 : 300;
    const timer = setTimeout(() => {
      for (const frame of textFrames('子代理结论:' + (task.match(/WAKE_\w+/) || ['?'])[0], FRAME_ID)) req.sse(frame);
      req.end();
    }, delay);
    req.res.on('close', () => clearTimeout(timer));
    return undefined;
  }
  const tail = tailUserText(messages);
  // W6:这条线程的每个唤醒回合都再起一个后台代理(模型「起 → 被唤醒 → 再起」的闭环)。
  if (tail.includes(WAKE_MARK) && humanText(messages).includes('CMD_W6')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_FAST 再来', agentKey: 'again', toolTier: 'read', background: true }, 'call_w6', FRAME_ID);
  if (tail.includes(WAKE_MARK)) return textFrames('WAKE_REPLY 已根据代理结果继续。', FRAME_ID);
  const lastTool = [...messages].reverse().find(m => m && m.role === 'tool');
  const afterTool = messages.length && messages[messages.length - 1].role === 'tool';
  const human = tail;
  if (afterTool && lastTool && ['call_busy', 'call_busy5', 'call_w9', 'call_w13'].includes(lastTool.tool_call_id)) {
    // W2:父的收尾回复拖 3s —— 子代理(0.8s)在这次模型调用进行中答完,信封赶不上迭代边界。
    return { frames: textFrames(['主线', '收尾。'], FRAME_ID), delayMs: 1500 };
  }
  if (afterTool) return textFrames('主线已结束,代理在后台。', FRAME_ID);
  if (human.includes('CMD_W1')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_SLOW 分析', agentKey: 'slow', toolTier: 'read', background: true }, 'call_w1', FRAME_ID);
  if (human.includes('CMD_W2')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_MID 分析', agentKey: 'mid', toolTier: 'read', background: true }, 'call_busy', FRAME_ID);
  if (human.includes('CMD_W3')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_FAST 分析', agentKey: 'fast', toolTier: 'read', background: true }, 'call_w3', FRAME_ID);
  if (human.includes('CMD_W4')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_LONG 分析', agentKey: 'long', toolTier: 'read', background: true }, 'call_w4', FRAME_ID);
  if (human.includes('CMD_W5')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_MID 断开', agentKey: 'mid5', toolTier: 'read', background: true }, 'call_busy5', FRAME_ID);
  if (human.includes('CMD_W6')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_FAST 起头', agentKey: 'first', toolTier: 'read', background: true }, 'call_w6', FRAME_ID);
  if (human.includes('CMD_W9')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_SLOW 停回合', agentKey: 'w9', toolTier: 'read', background: true }, 'call_w9', FRAME_ID);
  if (human.includes('CMD_X10')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_SLOW 将被撤回', agentKey: 'w10', toolTier: 'read', background: true }, 'call_w10', FRAME_ID);
  if (human.includes('CMD_X11')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_SLOW 第一回合起的', agentKey: 'w11', toolTier: 'read', background: true }, 'call_w11', FRAME_ID);
  if (human.includes('CMD_X12')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_SLOW 会话将被删', agentKey: 'w12', toolTier: 'read', background: true }, 'call_w12', FRAME_ID);
  if (human.includes('CMD_X13')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_SLOW 停了又重发', agentKey: 'w13', toolTier: 'read', background: true }, 'call_w13', FRAME_ID);
  if (human.includes('CMD_W7')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_HANG 挂着', agentKey: 'hang', toolTier: 'read', background: true }, 'call_w7', FRAME_ID);
  return textFrames('普通回合完成。', FRAME_ID);
}

let WP = 0;
function request(method, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WP, path: route, method, timeout: 15000, headers: { ...headers, ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}) } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    if (raw) req.write(raw); req.end();
  });
}
function streamChat(body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = '';
    const req = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) try { events.push(JSON.parse(line)); } catch {} } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('chat timeout')); }); req.write(raw); req.end();
  });
}

// W5:读到第一份工具结果就把连接掐了(用户关页 / 刷新);回合在服务端照常跑完(killOnDisconnect 缺省关)。
function streamChatThenDrop(body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = ''; let dropped = false;
    const req = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      res.on('data', c => {
        buf += c; let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) try { events.push(JSON.parse(line)); } catch {} }
        if (!dropped && events.some(e => e.type === 'tool_result' && !e.subagentId)) { dropped = true; req.destroy(); resolve(events); }
      });
      res.on('end', () => { if (!dropped) resolve(events); });
      res.on('error', () => { if (!dropped) resolve(events); });
    });
    req.on('error', e => { if (!dropped) reject(e); }); req.on('timeout', () => { req.destroy(); if (!dropped) reject(new Error('chat timeout')); }); req.write(raw); req.end();
  });
}

// W9 / W13:读到第一份(父回合的)工具结果后 afterMs 毫秒按「停止」,读到流收尾为止;onStop 收 /api/stop 的应答。
function streamChatStopAfterToolResult(body, afterMs, onStop, authHeaders) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = ''; let stopped = false; let stopDone = Promise.resolve();
    const req = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      res.on('data', c => {
        buf += c; let i;
        while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) try { events.push(JSON.parse(line)); } catch {} }
        if (!stopped && events.some(e => e.type === 'tool_result' && !e.subagentId)) {
          stopped = true;
          stopDone = new Promise(done => setTimeout(() => { request('POST', '/api/stop', { sessionId: body.sessionId }, authHeaders).then(r => { onStop(r); done(); }, () => { onStop(null); done(); }); }, afterMs));
        }
      });
      res.on('end', () => { stopDone.then(() => resolve(events)); });   // 流先收尾、/api/stop 的应答还在路上时,等它回来再交出去
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('chat timeout')); }); req.write(raw); req.end();
  });
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const fake = await startFakeProvider({ handler: handleChat });
  WP = await getFreePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', toolLoadingMode: 'full', defaultWorkspace: HOME,
    subagentMaxPerTurn: 8, subagentMaxConcurrent: 2, agentWorkflowMaxNodes: 16,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }], activeProvider: 'fake',
  }));
  const startWorkbench = () => {
    const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME } });
    child.stderr.on('data', d => String(d).trim() && console.log('[wb!] ' + String(d).trim()));
    return child;
  };
  let wb = startWorkbench();
  try {
    let healthy = false; for (let i = 0; i < 300 && !healthy; i++) { await sleep(120); healthy = !!(await request('GET', '/health').catch(() => null)); }
    ok(healthy, 'workbench starts');
    const html = await request('GET', '/');
    const token = (String(html).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const auth = { 'x-wcw-token': token };
    const newSession = async title => { const r = await request('POST', '/api/sessions', { title, cwd: HOME }, auth); return r && r.session && r.session.id; };
    const loadMessages = async sid => { const r = await request('GET', `/api/sessions/${encodeURIComponent(sid)}`, null, auth).catch(() => null); return (r && r.session && r.session.messages) || []; };
    const wakeMessages = msgs => msgs.filter(m => m.role === 'user' && m.meta && m.meta.origin === 'agent_wake');
    const waitFor = async (pred, ms) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await pred(); if (v) return v; await sleep(250); } return null; };
    const parentRequests = () => fake.requests.filter(r => !String(((r.messages || []).find(m => m.role === 'system') || {}).content || '').includes('你是子任务执行体'));
    const runIdOf = events => { const r = events.find(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.background === true); return r && r.content.runId; };
    const runStatus = async (sid, runId) => { const r = await request('GET', `/api/agent-runs/${encodeURIComponent(runId)}?sessionId=${encodeURIComponent(sid)}`, null, auth).catch(() => null); return r && r.run && r.run.status; };

    // ── W1 空闲时完成 ──
    const s1 = await newSession('wake idle');
    const ev1 = await streamChat({ sessionId: s1, message: 'CMD_W1 后台派一个慢任务', cwd: HOME });
    const run1 = runIdOf(ev1);
    ok(/^run_/.test(run1 || ''), 'W1 background orchestrate_agents returned a runId');
    ok(ev1.some(e => e.type === 'result' && e.ok === true), 'W1 parent turn ended before the agent finished');
    ok(wakeMessages(await loadMessages(s1)).length === 0, 'W1 no wake while the agent is still running');
    const woke1 = await waitFor(async () => { const msgs = await loadMessages(s1); const w = wakeMessages(msgs); const reply = msgs.find(m => m.role === 'assistant' && String(m.content || '').includes('WAKE_REPLY')); return w.length && reply ? { msgs, w } : null; }, 20000);
    ok(!!woke1, 'W1 the workbench started a wake turn on its own and the model replied');
    if (woke1) {
      ok(Array.isArray(woke1.w[0].meta.runIds) && woke1.w[0].meta.runIds.includes(run1), 'W1 wake message carries meta.origin agent_wake + the runId');
      ok(String(woke1.w[0].content || '').includes(WAKE_MARK) && String(woke1.w[0].content || '').includes(run1), 'W1 wake message names the finished run for the model');
    }
    const wakeReq1 = parentRequests().filter(r => tailUserText(r.messages || []).includes(WAKE_MARK)).pop();
    const notices1 = wakeReq1 ? (wakeReq1.messages || []).filter(m => m.role === 'user' && textOf(m).includes('[代理完成通知')) : [];
    ok(notices1.length === 1 && textOf(notices1[0]).includes(run1), 'W1 the wake turn request carries exactly one completion notice for the run');
    await sleep(4000);
    ok(wakeMessages(await loadMessages(s1)).length === 1, 'W1 woken exactly once (no repeat wake after the wake turn)');

    // ── W2 忙时完成 → 收尾补唤醒 ──
    const s2 = await newSession('wake after busy turn');
    const ev2 = await streamChat({ sessionId: s2, message: 'CMD_W2 后台派一个中速任务', cwd: HOME });
    const run2 = runIdOf(ev2);
    ok(ev2.some(e => e.type === 'result' && e.ok === true), 'W2 parent turn ended');
    ok(await runStatus(s2, run2) === 'succeeded', 'W2 the agent finished during the parent turn\'s last model call');
    const busyReqs = parentRequests().filter(r => humanText(r.messages || []).includes('CMD_W2') && !tailUserText(r.messages || []).includes(WAKE_MARK));
    ok(!busyReqs.some(r => (r.messages || []).some(m => m.role === 'user' && textOf(m).includes('[代理完成通知'))), 'W2 precondition: the envelope missed the parent turn\'s iteration boundaries');
    const woke2 = await waitFor(async () => { const msgs = await loadMessages(s2); return wakeMessages(msgs).length && msgs.some(m => m.role === 'assistant' && String(m.content || '').includes('WAKE_REPLY')) ? msgs : null; }, 15000);
    ok(!!woke2, 'W2 the turn end re-checked the ledger and woke the session');
    const wakeReq2 = parentRequests().filter(r => humanText(r.messages || []).includes('CMD_W2') && tailUserText(r.messages || []).includes(WAKE_MARK)).pop();
    ok(!!wakeReq2 && (wakeReq2.messages || []).filter(m => m.role === 'user' && textOf(m).includes('[代理完成通知') && textOf(m).includes(run2)).length === 1, 'W2 the wake turn carries exactly one notice for the run');

    // ── W3 开关关掉 → 旧行为 ──
    const patched = await request('POST', '/api/config', { agentAutoWake: false }, auth);
    ok(patched && patched.ok !== false && patched.config && patched.config.agentAutoWake === false, 'W3 agentAutoWake can be switched off via /api/config');
    const s3 = await newSession('wake off');
    const ev3 = await streamChat({ sessionId: s3, message: 'CMD_W3 后台派一个快任务', cwd: HOME });
    const run3 = runIdOf(ev3);
    await waitFor(async () => (await runStatus(s3, run3)) === 'succeeded', 10000);
    await sleep(3500);
    ok(wakeMessages(await loadMessages(s3)).length === 0, 'W3 switched off: no wake turn after the agent finished');
    const next3 = await streamChat({ sessionId: s3, message: 'NEXT_W3 下一句', cwd: HOME });
    ok(next3.some(e => e.type === 'result' && e.ok === true), 'W3 the next user turn completes');
    const nextReq3 = parentRequests().filter(r => tailUserText(r.messages || []).includes('NEXT_W3')).pop();
    ok(!!nextReq3 && (nextReq3.messages || []).filter(m => m.role === 'user' && textOf(m).includes('[代理完成通知') && textOf(m).includes(run3)).length === 1, 'W3 the envelope still arrives with the next user turn (old path)');
    await request('POST', '/api/config', { agentAutoWake: true }, auth);

    // ── W4 用户叫停的后台代理不唤醒 ──
    const s4 = await newSession('wake stopped');
    const ev4 = await streamChat({ sessionId: s4, message: 'CMD_W4 后台派一个长任务', cwd: HOME });
    const run4 = runIdOf(ev4);
    ok(/^run_/.test(run4 || ''), 'W4 long background run started');
    const stop4 = await request('POST', `/api/sessions/${encodeURIComponent(s4)}/background/stop`, { id: 'run:' + run4 }, auth);
    ok(stop4 && stop4.ok !== false, 'W4 the user stops the background run from the tray');
    const st4 = await waitFor(async () => { const s = await runStatus(s4, run4); return s && s !== 'running' ? s : null; }, 15000);
    ok(st4 === 'stopped' || st4 === 'cancelled', 'W4 run reaches a stopped terminal state (' + st4 + ')');
    await sleep(3500);
    ok(wakeMessages(await loadMessages(s4)).length === 0, 'W4 a user-stopped run does not wake the session');

    // ── W5 用户关了页面,回合在服务端跑完 → 收尾照样补唤醒 ──
    const s5 = await newSession('wake after disconnect');
    const ev5 = await streamChatThenDrop({ sessionId: s5, message: 'CMD_W5 后台派一个中速任务然后我关页面', cwd: HOME });
    const run5 = runIdOf(ev5);
    ok(/^run_/.test(run5 || ''), 'W5 background run started, then the client dropped the connection');
    const woke5 = await waitFor(async () => { const msgs = await loadMessages(s5); return wakeMessages(msgs).length && msgs.some(m => m.role === 'assistant' && String(m.content || '').includes('WAKE_REPLY')) ? msgs : null; }, 20000);
    ok(!!woke5, 'W5 the turn finished server-side after the disconnect and still woke the session');
    ok(!!woke5 && woke5.some(m => m.role === 'assistant' && String(m.content || '').includes('收尾')), 'W5 precondition: the parent turn really ran to its final reply after the disconnect');

    // ── W6 唤醒链上限 ──
    const s6 = await newSession('wake chain cap');
    await streamChat({ sessionId: s6, message: 'CMD_W6 每次被唤醒都再派一个', cwd: HOME });
    await waitFor(async () => wakeMessages(await loadMessages(s6)).length >= 6, 45000);
    await sleep(6000);
    const wakes6 = wakeMessages(await loadMessages(s6)).length;
    ok(wakes6 === 6, `W6 a wake → launch → wake loop stops at the chain cap of 6 (got ${wakes6})`);

    // ── W7 重启:落账未唤醒的补排;被打断的后台 run 补 interrupted 信封、不唤醒 ──
    const s7 = await newSession('wake at boot');
    const s8 = await newSession('interrupted at boot');
    const ev8 = await streamChat({ sessionId: s8, message: 'CMD_W7 后台派一个永远不回的', cwd: HOME });
    const run8 = runIdOf(ev8);
    ok(/^run_/.test(run8 || ''), 'W7 a hanging background run is in flight before the restart');
    killOwnTree(wb);
    await new Promise(resolve => { if (wb.exitCode != null || wb.signalCode != null) resolve(); else { wb.once('exit', resolve); setTimeout(resolve, 8000); } });
    const bootRun = 'run_boot7';
    fs.mkdirSync(path.join(HOME, 'sessions', 'background-jobs'), { recursive: true });
    fs.writeFileSync(path.join(HOME, 'sessions', 'background-jobs', s7 + '.json'), JSON.stringify([{
      id: 'agent:' + bootRun, kind: 'agent', runId: bootRun, shellId: bootRun, name: '重启前就做完了', sessionId: s7, status: 'succeeded', exitCode: 0,
      output: JSON.stringify({ ok: true, runId: bootRun, status: 'succeeded', nodes: [] }), truncated: false, completedAt: new Date().toISOString(), background: true, wakeParent: true,
    }]));
    WP = await getFreePort();
    wb = startWorkbench();
    let healthy2 = false; for (let i = 0; i < 300 && !healthy2; i++) { await sleep(120); healthy2 = !!(await request('GET', '/health').catch(() => null)); }
    ok(healthy2, 'W7 workbench restarted');
    const html2 = await request('GET', '/');
    auth['x-wcw-token'] = (String(html2).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const woke7 = await waitFor(async () => { const msgs = await loadMessages(s7); return wakeMessages(msgs).length ? msgs : null; }, 15000);
    ok(!!woke7, 'W7a an envelope left un-woken by the restart wakes the session at boot');
    // 唤醒消息落盘(回合起手那一存)比模型请求早几毫秒:等请求真到了再取(修前这里直接取,靠的是碰巧不赶时间)。
    const wakeReq7 = await waitFor(async () => parentRequests().filter(r => tailUserText(r.messages || []).includes(WAKE_MARK) && (r.messages || []).some(m => m.role === 'user' && textOf(m).includes(bootRun))).pop(), 5000);
    ok(!!wakeReq7, 'W7a the boot wake turn carries that run\'s envelope to the model');
    ok(await runStatus(s8, run8) === 'interrupted', 'W7b the hanging background run was marked interrupted at boot');
    await sleep(3000);
    ok(wakeMessages(await loadMessages(s8)).length === 0, 'W7b an interrupted run does not wake the session');
    const next8 = await streamChat({ sessionId: s8, message: 'NEXT_W8 刚才那个代理怎么样了', cwd: HOME });
    ok(next8.some(e => e.type === 'result' && e.ok === true), 'W7b the next user turn completes');
    const nextReq8 = parentRequests().filter(r => tailUserText(r.messages || []).includes('NEXT_W8')).pop();
    ok(!!nextReq8 && (nextReq8.messages || []).some(m => m.role === 'user' && textOf(m).includes('[代理完成通知 interrupted]') && textOf(m).includes(run8)), 'W7b the next user turn tells the model the background run was interrupted');

    // ── 第三波复核补的几条(W8–W13)。W7 之后服务是重启过的,auth 已换成新 token。 ──
    const noticeCount = (messages, runId) => (messages || []).filter(m => m && m.role === 'user' && textOf(m).includes('[代理完成通知') && textOf(m).includes(runId)).length;
    const lastReqWithTail = marker => parentRequests().filter(r => tailUserText(r.messages || []).includes(marker)).pop();
    const wakeReqsMentioning = runId => parentRequests().filter(r => tailUserText(r.messages || []).includes(WAKE_MARK) && JSON.stringify(r.messages || []).includes(runId));

    // W8 面板 / HTTP 的 async 启动:run.background 为 true,但没有模型在等它 → 不唤醒,信封随下一句话送达。
    const s9 = await newSession('wake ui async');
    const launch9 = await request('POST', '/api/agent-workflow/launch', { token: auth['x-wcw-token'], sessionId: s9, nodes: [{ id: 'a', task: 'WAKE_FAST 面板里点的工作流' }], async: true });
    const run9 = launch9 && launch9.runId;
    ok(!!launch9 && launch9.ok === true && launch9.background === true && /^run_/.test(run9 || ''), 'W8 the panel / HTTP async launch is accepted as a background run');
    ok(!!(await waitFor(async () => (await runStatus(s9, run9)) === 'succeeded', 15000)), 'W8 the panel-launched run finishes');
    await sleep(3500);
    ok(wakeMessages(await loadMessages(s9)).length === 0, 'W8 a UI-launched async run does not wake the thread (no model is waiting for it)');
    ok(wakeReqsMentioning(run9).length === 0, 'W8 and no model request carried a wake notice for it');
    const next9 = await streamChat({ sessionId: s9, message: 'NEXT_W8 面板那个工作流怎么样了', cwd: HOME });
    ok(next9.some(e => e.type === 'result' && e.ok === true), 'W8 the next user turn completes');
    const nextReq9 = lastReqWithTail('NEXT_W8');
    ok(!!nextReq9 && noticeCount(nextReq9.messages, run9) === 1, 'W8 the envelope is still delivered with the next user message (exactly once)');

    // W9 用户 Stop 了起后台代理的回合:代理与回合 abort 脱钩,照常跑完,但线程不会在 Stop 之后自己又开工。
    const s10 = await newSession('wake after stop');
    let stop10 = null;
    const ev10 = await streamChatStopAfterToolResult({ sessionId: s10, message: 'CMD_W9 后台派一个慢任务然后我按停止', cwd: HOME }, 500, r => { stop10 = r; }, auth);
    const run10 = runIdOf(ev10);
    ok(/^run_/.test(run10 || ''), 'W9 background run started inside the turn');
    ok(!!stop10 && stop10.stopped === true, 'W9 /api/stop stopped the live parent turn');
    ok(ev10.some(e => e.type === 'result' && e.aborted === true), 'W9 the parent turn ended as stopped');
    ok(!!(await waitFor(async () => (await runStatus(s10, run10)) === 'succeeded', 15000)), 'W9 the decoupled background run still finishes after the stop');
    await sleep(4000);
    ok(wakeMessages(await loadMessages(s10)).length === 0, 'W9 a run that finishes after the user pressed Stop does not wake the thread');
    const next10 = await streamChat({ sessionId: s10, message: 'NEXT_W9 继续', cwd: HOME });
    ok(next10.some(e => e.type === 'result' && e.ok === true), 'W9 the next user turn completes');
    const nextReq10 = lastReqWithTail('NEXT_W9');
    ok(!!nextReq10 && noticeCount(nextReq10.messages, run10) === 1, "W9 the envelope arrives with the user's next message (exactly once)");

    // W10 撤回到起后台代理的回合之前:模型起的仍在跑的 run 被停掉、不唤醒、不投信封。
    const s11 = await newSession('wake after rewind');
    const ev11 = await streamChat({ sessionId: s11, message: 'CMD_X10 后台派一个慢任务然后我撤回', cwd: HOME });
    const run11 = runIdOf(ev11);
    ok(/^run_/.test(run11 || ''), 'W10 background run started in turn 1');
    const rw11 = await request('POST', '/api/session/rewind', { sessionId: s11, targetTurnSeq: 1, rollbackFiles: false }, auth);
    ok(!!rw11 && rw11.ok === true, 'W10 the thread is rewound to before the turn that launched the run');
    const fin11 = await waitFor(async () => { const st = await runStatus(s11, run11); return st && st !== 'running' ? st : null; }, 15000);
    ok(fin11 === 'stopped', `W10 the still-running model-launched run was cancelled by the rewind (got ${fin11})`);
    await sleep(3500);
    const msgs11 = await loadMessages(s11);
    ok(wakeMessages(msgs11).length === 0 && msgs11.length === 0, `W10 nothing woke the rewound thread and nothing reappeared in it (messages=${msgs11.length})`);
    ok(wakeReqsMentioning(run11).length === 0, 'W10 no model request carried a wake notice for the rewound run');
    const next11 = await streamChat({ sessionId: s11, message: 'NEXT_W10 重新开始', cwd: HOME });
    ok(next11.some(e => e.type === 'result' && e.ok === true), 'W10 the next user turn completes');
    const nextReq11 = lastReqWithTail('NEXT_W10');
    ok(!!nextReq11 && noticeCount(nextReq11.messages, run11) === 0, 'W10 the rewound run does not deliver an envelope into the new timeline');

    // W11 撤回只撤掉后面的回合:起后台代理的第 1 回合还在 → 代理照常跑完,但不唤醒(撤回记了叫停);信封下一句话送达。
    const s12 = await newSession('wake after partial rewind');
    const ev12 = await streamChat({ sessionId: s12, message: 'CMD_X11 后台派一个慢任务', cwd: HOME });
    const run12 = runIdOf(ev12);
    const ev12b = await streamChat({ sessionId: s12, message: 'PLAIN_W11 第二回合,马上会被撤回', cwd: HOME });
    ok(ev12b.some(e => e.type === 'result' && e.ok === true), 'W11 turn 2 completes');
    const rw12 = await request('POST', '/api/session/rewind', { sessionId: s12, targetTurnSeq: 2, rollbackFiles: false }, auth);
    ok(!!rw12 && rw12.ok === true, 'W11 only turn 2 is rewound (turn 1 launched the run and stays)');
    ok(!!(await waitFor(async () => (await runStatus(s12, run12)) === 'succeeded', 15000)), 'W11 the run launched by the surviving turn is not cancelled and finishes');
    await sleep(3500);
    ok(wakeMessages(await loadMessages(s12)).length === 0, 'W11 but it does not wake the rewritten thread');
    const next12 = await streamChat({ sessionId: s12, message: 'NEXT_W11 继续', cwd: HOME });
    ok(next12.some(e => e.type === 'result' && e.ok === true), 'W11 the next user turn completes');
    const nextReq12 = lastReqWithTail('NEXT_W11');
    ok(!!nextReq12 && noticeCount(nextReq12.messages, run12) === 1, "W11 the envelope arrives with the user's next message (exactly once)");

    // W12 会话被删:不唤醒,也不会新冒出一条会话。
    const s13 = await newSession('wake after delete');
    const ev13 = await streamChat({ sessionId: s13, message: 'CMD_X12 后台派一个慢任务然后我删会话', cwd: HOME });
    const run13 = runIdOf(ev13);
    ok(/^run_/.test(run13 || ''), 'W12 background run started');
    const del13 = await request('DELETE', `/api/sessions/${encodeURIComponent(s13)}`, null, auth);
    ok(!!del13 && del13.ok !== false, 'W12 the session is deleted while the run is in flight');
    const idsAfterDelete = ((await request('GET', '/api/sessions', null, auth)).sessions || []).map(x => x.id).sort();
    await sleep(5000);
    const idsLater = ((await request('GET', '/api/sessions', null, auth)).sessions || []).map(x => x.id).sort();
    ok(JSON.stringify(idsAfterDelete) === JSON.stringify(idsLater) && !idsLater.includes(s13), 'W12 no session appeared (or came back) after the run finished');
    ok(wakeReqsMentioning(run13).length === 0, "W12 no model request carried a wake notice for the deleted thread's run");

    // W13 Stop 之后用户立刻重发:重发的回合起手清掉「叫停过」,代理随后跑完 → 照常唤醒(抑制不过度)。
    const s14 = await newSession('wake after stop and resend');
    let stop14 = null;
    await streamChatStopAfterToolResult({ sessionId: s14, message: 'CMD_X13 后台派一个慢任务然后停了再重发', cwd: HOME }, 300, r => { stop14 = r; }, auth);
    ok(!!stop14 && stop14.stopped === true, `W13 the first turn was stopped (/api/stop -> ${JSON.stringify(stop14)})`);
    const resend14 = await streamChat({ sessionId: s14, message: 'RESEND_W13 我重新说一句', cwd: HOME });
    ok(resend14.some(e => e.type === 'result' && e.ok === true), 'W13 the resent turn completes');
    const woke14 = await waitFor(async () => { const msgs = await loadMessages(s14); return wakeMessages(msgs).length && msgs.some(m => m.role === 'assistant' && String(m.content || '').includes('WAKE_REPLY')) ? msgs : null; }, 15000);
    ok(!!woke14, 'W13 the run finishing after the user spoke again wakes the thread as usual');
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (releaseLong) releaseLong();
    try { killOwnTree(wb); } catch {}
    await fake.close();
  }
  t.done({ exit: true });
})().catch(e => { console.error(e); process.exit(2); });
