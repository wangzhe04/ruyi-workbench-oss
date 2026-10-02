#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)

// E2E(2026-10 智能自动体验):管家的应答速度与「用户正看着就不插手」。
//
//   W  待决一产生就叫醒收件箱(13i stewardScheduleWake):轮询间隔拉到上限 120 s,新线程挂上待决之后
//      几秒内就进收件箱 —— 只能是被叫醒的,轮询那一拍要两分钟后才来。
//   V  用户正看着(在场信号 `?viewing=<线程>`,任一视角):
//      V1 这条线程的待决【不进箱】(不叫醒管家去插手);
//      V2 管家的 steward_decide 对它返回结构化拒绝 seated_by_user;
//      V3 人一走(断连),扣住的那条【不丢】—— 下一拍原样进箱(游标早已越过它,丢了就再也回不来);
//      V4 只扣被看着的那一条:同时挂着待决的别的线程照常进箱。
//
// 夹具:temp HOME + 进程内假 OpenAI 兼容 provider,不开浏览器。判定行:`STEWARD VIEWING GATE E2E: ALL PASS`。
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const t = createRunner('STEWARD VIEWING GATE');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const POLL_MS = 120000;          // 轮询拉到 13i 允许的上限:本件里收件箱的每一拍都只能是「被叫醒的」
const QUESTION_DELAY_MS = 2500;  // 线程第一发晚这么久才提问 —— 留出时间先把「正看着它」的在场建起来

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
async function waitFor(fn, timeoutMs, stepMs = 100) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await fn();
    if (value) return value;
    await sleep(stepMs);
  }
  return null;
}

// 在场连接:连上即在场,close() 即离开(13r 按连接生死记)。
function openPresence(port, token, query) {
  const state = { frames: [], req: null };
  let buffer = '';
  state.ready = new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/events/stream?' + query, method: 'GET', headers: { 'x-wcw-token': token } }, response => {
      response.setEncoding('utf8');
      response.on('data', chunk => {
        buffer += chunk;
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const frame = { event: '', data: null };
          for (const line of block.split('\n')) {
            if (line.startsWith('event: ')) frame.event = line.slice(7);
            else if (line.startsWith('data: ')) { try { frame.data = JSON.parse(line.slice(6)); } catch { frame.data = null; } }
          }
          state.frames.push(frame);
        }
      });
      resolve(state);
    });
    req.on('error', () => resolve(state));
    state.req = req;
    req.end();
  });
  state.close = () => { try { state.req.destroy(); } catch { /* gone */ } };
  return state;
}
async function waitAck(stream) {
  await stream.ready;
  return Boolean(await waitFor(() => stream.frames.find(f => f.event === 'presence.ack') || null, 5000, 25));
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-viewing-gate-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const WS = ['w', 'y', 'z'];
  for (const name of WS) fs.mkdirSync(path.join(home, 'ws-' + name), { recursive: true });
  let fake = null, server = null, seat = null;
  try {
    fake = await startFakeProvider({
      async handler(req) {
        const sys = req.messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
        if (/我是如意/.test(sys)) return textFrames(JSON.stringify({ say: '看过了。', why: '总览', acts: [], actions: [] }));
        if (!req.messages.some(m => m && m.role === 'tool')) {
          await sleep(QUESTION_DELAY_MS);
          return toolCallFrames('request_user_input', { questions: [{ header: '框架', question: '用哪个框架?', options: [{ label: 'React' }, { label: 'Vue' }], multiSelect: false }] }, 'call_q1');
        }
        return textFrames('收工了。');
      },
    });
    const appPort = await getFreePort();
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      configSchema: 9, version: '2.4.0', activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
      theme: 'dark', uiMode: 'pro', locale: 'zh-CN', defaultWorkspace: home,
      workspaces: [{ path: home, read: true, write: true, execute: true },
        ...WS.map(name => ({ path: path.join(home, 'ws-' + name), read: true, write: true, execute: true }))],
      includeWorkbenchMcp: false, killOnDisconnect: false, subagentMaxPerTurn: 0,
      stewardEnabledV1: true, stewardPollMs: POLL_MS, stewardVisitIdleMinutes: 60,
      stewardProviderId: 'fake', stewardModel: 'fake-model', stewardThreadBriefV1: false,
      stewardMaxTurnsPerHour: 500, stewardGlobalMaxTurnsPerHour: 2000, stewardMaxParallelThreads: 8,
      autoImportClaudeCodeMcp: false,
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    }), 'utf8');
    server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
      cwd: WB, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
      windowsHide: true, stdio: 'ignore',
    });
    ok(Boolean(await waitFor(async () => { const r = await request(appPort, 'GET', '/health'); return r && r.status === 200; }, 30000)), 'A0 workbench started');
    const token = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }, 8000);
    ok(Boolean(token), 'A0b runtime token 可读');
    // 管家收件箱起跑那一拍(冷启动只建基线)先过去,之后的每一拍都只能来自叫醒。
    await sleep(1500);

    const newThread = async (title, name) => {
      const res = await request(appPort, 'POST', '/api/steward/act', {
        act: { kind: 'tool', tool: 'steward_thread_new', args: { title, cwd: path.join(home, 'ws-' + name), brief: { userText: '把这件事推进到底', goal: '给一句结论' } } },
      }, token);
      return (res && res.json && res.json.result && res.json.result.sessionId) || '';
    };
    const pendingOf = async sid => {
      const res = await request(appPort, 'GET', `/api/interventions/${sid}?limit=50`, null, token);
      return ((res && res.json && res.json.interventions) || []).filter(iv => iv && iv.status === 'pending');
    };
    const inboxHas = async sid => {
      const res = await request(appPort, 'GET', '/api/steward/inbox?limit=200', null, token);
      const items = (res && res.json && Array.isArray(res.json.items)) ? res.json.items : [];
      return items.some(r => r && r.sessionId === sid && r.kind === 'needs_you');
    };

    /* ═════════ W 待决一产生就叫醒 ═════════ */
    const W = await newThread('叫醒速度那条', 'w');
    ok(Boolean(W), `W0 开出线程 W(${W || '失败'})`);
    ok(Boolean(await waitFor(async () => (await pendingOf(W)).length > 0, 20000, 100)), 'W1 线程 W 挂上了一条待决(question)');
    const pendingAt = Date.now();
    const woke = await waitFor(() => inboxHas(W), 10000, 100);
    const wokeMs = Date.now() - pendingAt;
    // 墙钟上界豁免：判的就是「被叫醒」还是「等轮询」—— 修后实得几百 ms,没叫醒就要等满 120 s 的轮询间隔,界 8 s 与调度噪声隔着两个数量级。
    ok(Boolean(woke) && wokeMs < 8000,
      `W2 轮询间隔 120 s 的情况下,W 的 needs_you 在 ${wokeMs} ms 内进了收件箱(只能是待决产生时叫醒的;修前要等到下一拍轮询)`);

    /* ═════════ V 用户正看着这一条 → 管家不插手 ═════════ */
    const Y = await newThread('我正看着它的提问', 'y');
    ok(Boolean(Y), `V0 开出线程 Y(${Y || '失败'})`);
    // 提问要晚 2.5 s 才来:趁这段把「正看着 Y」的在场建好(管家视角、没坐在任何线程上 —— 只靠 viewing 这一路)。
    seat = openPresence(appPort, token, 'lens=steward&sessionId=&viewing=' + encodeURIComponent(Y));
    ok(await waitAck(seat), 'V0b 在场连接建好(lens=steward,viewing=Y)');
    const ack = seat.frames.find(f => f.event === 'presence.ack');
    ok(Boolean(ack && ack.data && Array.isArray(ack.data.viewing) && ack.data.viewing[0] === Y),
      `V0c presence.ack 回显 viewing(实得 ${JSON.stringify(ack && ack.data && ack.data.viewing)})`);
    ok(Boolean(await waitFor(async () => (await pendingOf(Y)).length > 0, 20000, 100)), 'V0d 线程 Y 挂上了一条待决');
    await sleep(4000);   // 叫醒的两拍(0.4 s / 2.5 s)都过去了
    ok(!(await inboxHas(Y)), 'V1 用户正看着 Y 的提问:Y 的 needs_you 没进收件箱(没去叫管家插手)');
    const iv = (await pendingOf(Y))[0] || null;
    const decided = await request(appPort, 'POST', '/api/steward/act', {
      act: { kind: 'tool', tool: 'steward_decide', args: { missionId: Y, interventionId: iv && iv.id, action: 'answer', answer: 'React' } },
    }, token);
    const decidedResult = decided && decided.json && decided.json.result;
    ok(Boolean(decidedResult && decidedResult.error === 'seated_by_user'),
      `V2 管家此刻替用户答 Y 的提问 → seated_by_user(实得 ${JSON.stringify(decidedResult && decidedResult.error)})`);
    ok((await pendingOf(Y)).length === 1, 'V2b 那条待决原样还挂着(没被替用户答掉)');

    seat.close();
    seat = null;
    await sleep(800);   // 13r 收到断连、把这条连接从在场表里摘掉
    // 下一拍由另一条线程的新待决叫醒 —— 顺带验 V4:别的线程照常进箱。
    const Z = await newThread('另一条线程', 'z');
    ok(Boolean(Z), `V3a 开出线程 Z(${Z || '失败'})`);
    ok(Boolean(await waitFor(() => inboxHas(Z), 20000, 200)), 'V4 别的线程(Z)的待决照常进箱');
    ok(await inboxHas(Y), 'V3 人走了之后,先前扣住的 Y 那条待决进了收件箱(扣住不是丢掉)');
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    try { if (seat) seat.close(); } catch { /* ignore */ }
    try { if (server) killOwnTree(server); } catch { /* ignore */ }
    try { if (fake) await fake.close(); } catch { /* ignore */ }
    await sleep(300);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  t.done();
})();

// REVERSE VERIFICATION
//   1. W2:把 13i 的 `RUYI_EVENTS.subscribe` 里 thread.needs_you 那一段删掉 -> W2 必须 FAIL(只能等 120 s 轮询)。
//   2. V1:把 stewardApplyPresenceGate 里「⑤ 扣住」那几行删掉 -> V1 必须 FAIL。
//   3. V2:把 13k stewardSeatedByUser 里 viewing 那一支删掉 -> V2 必须 FAIL。
//   4. V3:把 stewardTickOnce 里 `stewardTakeViewHeld().concat(events)` 改回 `events` -> V3 必须 FAIL(扣住变成丢掉)。
// 每改一次都要 `node ruyi-workbench/app/build.js` 再单跑本件;跑完照原样改回来。
