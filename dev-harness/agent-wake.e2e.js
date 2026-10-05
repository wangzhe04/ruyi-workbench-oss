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
    const delay = task.includes('WAKE_SLOW') ? 2500 : task.includes('WAKE_MID') ? 800 : 300;
    const timer = setTimeout(() => {
      for (const frame of textFrames('子代理结论:' + (task.match(/WAKE_\w+/) || ['?'])[0], FRAME_ID)) req.sse(frame);
      req.end();
    }, delay);
    req.res.on('close', () => clearTimeout(timer));
    return undefined;
  }
  const tail = tailUserText(messages);
  if (tail.includes(WAKE_MARK)) return textFrames('WAKE_REPLY 已根据代理结果继续。', FRAME_ID);
  const lastTool = [...messages].reverse().find(m => m && m.role === 'tool');
  const afterTool = messages.length && messages[messages.length - 1].role === 'tool';
  const human = tail;
  if (afterTool && lastTool && lastTool.tool_call_id === 'call_busy') {
    // W2:父的收尾回复拖 3s —— 子代理(0.8s)在这次模型调用进行中答完,信封赶不上迭代边界。
    return { frames: textFrames(['主线', '收尾。'], FRAME_ID), delayMs: 1500 };
  }
  if (afterTool) return textFrames('主线已结束,代理在后台。', FRAME_ID);
  if (human.includes('CMD_W1')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_SLOW 分析', agentKey: 'slow', toolTier: 'read', background: true }, 'call_w1', FRAME_ID);
  if (human.includes('CMD_W2')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_MID 分析', agentKey: 'mid', toolTier: 'read', background: true }, 'call_busy', FRAME_ID);
  if (human.includes('CMD_W3')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_FAST 分析', agentKey: 'fast', toolTier: 'read', background: true }, 'call_w3', FRAME_ID);
  if (human.includes('CMD_W4')) return toolCallFrames('orchestrate_agents', { task: 'WAKE_LONG 分析', agentKey: 'long', toolTier: 'read', background: true }, 'call_w4', FRAME_ID);
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

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const fake = await startFakeProvider({ handler: handleChat });
  WP = await getFreePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', toolLoadingMode: 'full', defaultWorkspace: HOME,
    subagentMaxPerTurn: 8, subagentMaxConcurrent: 2, agentWorkflowMaxNodes: 16,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }], activeProvider: 'fake',
  }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME } });
  wb.stderr.on('data', d => String(d).trim() && console.log('[wb!] ' + String(d).trim()));
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
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (releaseLong) releaseLong();
    try { killOwnTree(wb); } catch {}
    await fake.close();
  }
  t.done({ exit: true });
})().catch(e => { console.error(e); process.exit(2); });
