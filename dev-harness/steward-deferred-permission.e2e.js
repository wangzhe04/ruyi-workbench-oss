require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(128f-⑪;Brief §4.2 第 7 条前半;用户 2026-09-19 拍板 A「立刻通知你,请求挂 600 秒等你处理」)。
//
// 修前的真机形状(45 号文 §9.6.5 (b)):用户交给管家盯的线程停在一条权限请求上,管家看过、说「这条我不代批,留在那儿
// 等你过目」,可那条请求 120.015 s 后就按超时拒掉了;线程改用提问又等满 600 s。用户在管家视角里得不到任何系统通知。
//
// 一个真服务实例、进程内 fake provider;两条线程【同时】停在一条 exec 权限请求上(permissionMode default):
//   W:交给管家盯(stewardWatch:true);U:用户自己开、没交给管家(对照)。
// 缺省窗口压到 20 s、管家经手的窗口由测试口压到 45 s,回合 idle 看门狗压到 8 s(WCW_TURN_IDLE_MS)。
//   [P1] W 过了缺省窗口(22 s)仍挂着 —— 窗口真的拉长了;也没被 8 s 的 idle 看门狗当成空闲杀掉。
//   [P2] 管家收件箱回合(假管家只说一句、不调 steward_decide)结束后,事件流上来一帧 steward.deferred:
//        W 的那条请求、截止时刻 ≈ 请求时刻 + 45 s、摘要里是工具名 —— 而且早于缺省窗口(「立刻」)。
//   [P3] 同一条请求只报一次。
//   [P4] W 到 45 s 按【超时拒】落定(不是看门狗中止回合),回合正常收尾、流里没有 [watchdog]。
//   [C1] U 没交给管家:缺省 20 s 就按超时拒;管家看过它(还挂着的时候)也【不】报 steward.deferred。
//   [C2] U 同样没被 8 s 的看门狗杀掉(看门狗豁免与管家无关:定时线程的 30 分钟窗口修前就被它截断过)。
// 判定行:`STEWARD DEFERRED PERMISSION E2E: ALL PASS`。
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
async function waitFor(pred, ms, step = 100) { const end = Date.now() + ms; for (;;) { const v = await pred(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const BASE_MS = 20000, MEDIATED_MS = 45000, IDLE_MS = 8000;

// ── fake provider:线程第一发要一次 powershell_run,之后一句话;管家(工具表里有 steward_decide)永远只说一句 ──
const PROVIDER_PORT = await getFreePort();
const toolNamesOf = body => (Array.isArray(body && body.tools) ? body.tools : []).map(t => String((t && t.function && t.function.name) || t.name || ''));
let stewardTurns = 0;
const providerServer = http.createServer(async (req, res) => {
  let raw = ''; req.on('data', c => { raw += c; }); await new Promise(r => req.on('end', r));
  if (req.url.includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] })); }
  let body = null; try { body = JSON.parse(raw); } catch { body = null; }
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const last = msgs.length ? msgs[msgs.length - 1] : null;
  const names = toolNamesOf(body);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  const say = text => { frame({ choices: [{ index: 0, delta: { content: text } }] }); frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }); };
  if (names.includes('steward_decide')) {
    stewardTurns += 1;
    say(JSON.stringify({ say: '这条我不代批,留在那儿等你过目。', why: '128f-⑪ 夹具', acts: [], actions: [] }));
  } else if (names.includes('powershell_run') && last && last.role === 'user') {
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), type: 'function', function: { name: 'powershell_run', arguments: '' } }] } }] });
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ command: 'Write-Output deferred-probe', timeoutMs: 10000 }) } }] } }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    say('好的。');
  }
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  res.write('data: [DONE]\n\n'); res.end();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-deferred-'));
const WORK = path.join(HOME, 'work'); fs.mkdirSync(WORK, { recursive: true });
const PORT = await getFreePort();
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', permissionTimeoutMs: BASE_MS,
  includeWorkbenchMcp: false, defaultWorkspace: WORK, recentWorkspaces: [],
  subagentMaxPerTurn: 0, killOnDisconnect: false, shellSessionMax: 3,
  stewardEnabledV1: true, stewardThreadBriefV1: false, stewardPollMs: 5000,
  stewardMaxTurnsPerHour: 500, stewardGlobalMaxTurnsPerHour: 500,
  stewardWorkspaceRoot: path.join(HOME, 'Ruyi'),
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');
const proc = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
  cwd: WB, windowsHide: true,
  env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME, WCW_TEST_STEWARD_PERMISSION_WAIT_MS: String(MEDIATED_MS), WCW_TURN_IDLE_MS: String(IDLE_MS) },
});
proc.stdout.on('data', () => {});
proc.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
let TOKEN = '';
function reqJson(method, p, payload, timeoutMs = 60000) {
  return new Promise(resolve => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const headers = { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(TOKEN ? { 'x-wcw-token': TOKEN } : {}) };
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers, timeout: timeoutMs }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { j = null; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', () => resolve({ status: 0, json: null })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null }); });
    if (data) r.write(data); r.end();
  });
}
const liveEvents = {};
function runStream(payload) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload); const events = []; liveEvents[payload.sessionId] = events;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': TOKEN }, timeout: 300000 }, res => {
      let buf = '';
      const take = line => { if (!line.trim()) return; try { events.push(JSON.parse(line)); } catch { /* 半行 */ } };
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { take(buf.slice(0, nl)); buf = buf.slice(nl + 1); } });
      res.on('end', () => { take(buf); resolve({ status: res.statusCode, events }); });
    });
    r.on('error', () => resolve({ status: 0, events })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, events }); });
    r.write(data); r.end();
  });
}
function openStream(query) {
  const frames = []; let buffer = '';
  const r = http.request({ host: '127.0.0.1', port: PORT, path: '/api/events/stream' + query, method: 'GET', headers: { 'x-wcw-token': TOKEN } }, res => {
    res.setEncoding('utf8');
    res.on('data', chunk => {
      buffer += chunk; let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        if (!block.trim() || block.startsWith(':')) continue;
        const f = { event: '', data: null, at: Date.now() };
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) f.event = line.slice(7);
          else if (line.startsWith('data: ')) { try { f.data = JSON.parse(line.slice(6)); } catch { f.data = null; } }
        }
        frames.push(f);
      }
    });
  });
  r.on('error', () => {}); r.end();
  return { frames, close: () => { try { r.destroy(); } catch { /* gone */ } } };
}
function ivRows(sid) {
  let lines = []; try { lines = fs.readFileSync(path.join(HOME, 'sessions', sid + '.interventions.ndjson'), 'utf8').split(/\r?\n/).filter(l => l.trim()); } catch { lines = []; }
  const byId = new Map();
  for (const l of lines) { let row = null; try { row = JSON.parse(l); } catch { row = null; } if (row && row.id) byId.set(row.id, { ...(byId.get(row.id) || {}), ...row }); }
  return [...byId.values()];
}
const TERMINAL = ['allowed', 'denied', 'answered', 'cancelled', 'approved', 'rejected', 'cancelled_restart', 'indeterminate', 'expired'];

let stream = null;
try {
  let up = false; for (let i = 0; i < 200 && !up; i++) { await sleep(150); up = (await reqJson('GET', '/health')).status === 200; }
  ok(up, 'P0 服务起来了');
  TOKEN = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }, 15000) || '';
  ok(Boolean(TOKEN), 'P0b token 可读');
  stream = openStream('?lens=steward');                      // 用户在管家视角(在场门③:照常进收件箱)
  // 两条线程各用各的工作文件夹:同一个 cwd 的回合被写锁串行(管家夹具的老坑),U 会一直排在 W 后面。
  const WORK_W = path.join(WORK, 'w'), WORK_U = path.join(WORK, 'u');
  fs.mkdirSync(WORK_W, { recursive: true }); fs.mkdirSync(WORK_U, { recursive: true });
  const W = (await reqJson('POST', '/api/sessions', { title: '交给管家盯的那条', cwd: WORK_W })).json.session.id;
  const U = (await reqJson('POST', '/api/sessions', { title: '用户自己的那条', cwd: WORK_U })).json.session.id;
  const watch = await reqJson('PATCH', '/api/sessions/' + W, { stewardWatch: true });
  ok(W && U && watch.status === 200, `P0c 两条线程已建,W 交给管家盯(${W} / ${U})`);

  const turnW = runStream({ sessionId: W, message: 'W-run 跑一下', cwd: WORK_W });
  const turnU = runStream({ sessionId: U, message: 'U-run 跑一下', cwd: WORK_U });
  const pendW = await waitFor(() => ivRows(W).find(r => r.type === 'permission' && r.status === 'pending'), 20000);
  const pendU = await waitFor(() => ivRows(U).find(r => r.type === 'permission' && r.status === 'pending'), 20000);
  ok(Boolean(pendW && pendU), 'P0d 两条线程都停在一条 exec 权限请求上');
  if (!pendW || !pendU) {
    for (const [sid, evs] of Object.entries(liveEvents)) console.log('DEFER-DIAG ' + sid + ' ' + JSON.stringify(evs.slice(0, 14).map(e => e && (e.type + (e.name ? ':' + e.name : '') + (e.text ? ':' + String(e.text).slice(0, 80) : '') + (e.message ? ':' + String(e.message).slice(0, 80) : '')))));
    throw new Error('no pending permission');
  }
  const t0W = Date.parse(pendW.requestedAt), t0U = Date.parse(pendU.requestedAt);

  // [P2] 事件流:W 那条请求的 steward.deferred
  const deferredFor = sid => stream.frames.filter(f => f.event === 'steward.deferred' && f.data && f.data.sessionId === sid);
  const dW = await waitFor(() => deferredFor(W)[0] || null, BASE_MS);
  ok(Boolean(dW) && dW.data.interventionId === pendW.id,
    `P2 管家看过、没替你批 → 事件流上来 steward.deferred(W 的那条请求;实测 ${JSON.stringify(dW && dW.data)})`);
  if (dW) {
    const dl = Date.parse(dW.data.deadlineAt);
    ok(Math.abs(dl - (t0W + MEDIATED_MS)) <= 4000, `P2b 截止时刻 ≈ 请求时刻 + ${MEDIATED_MS / 1000} s(差 ${dl - (t0W + MEDIATED_MS)} ms)`);
    ok(/powershell_run/.test(String(dW.data.ask || '')), `P2c 摘要里是工具名(「${dW.data.ask}」),不带命令原文`);
    ok(dW.at - t0W < BASE_MS, `P2d 早于缺省窗口就报了(请求后 ${Math.round((dW.at - t0W) / 1000)} s;「立刻」)`);
  }
  ok(stewardTurns >= 1, `P2e 管家确实跑过收件箱回合(${stewardTurns} 次)`);

  // [P1] 过了缺省窗口仍挂着
  await waitFor(() => Date.now() >= t0W + BASE_MS + 2000, BASE_MS + 5000, 200);
  const wAtBase = ivRows(W).find(r => r.id === pendW.id);
  ok(wAtBase && wAtBase.status === 'pending', `P1 W 过了缺省窗口(${BASE_MS / 1000} s + 2 s)仍挂着(实测 ${wAtBase && wAtBase.status})`);

  // [C1] U:缺省窗口就按超时拒;管家看过它也不报
  const uSettled = await waitFor(() => { const r = ivRows(U).find(x => x.id === pendU.id); return r && TERMINAL.includes(r.status) ? r : null; }, 15000);
  // 墙钟上界豁免：判的就是超时窗口本身（缺省 20 s 对管家经手 45 s，差 25 s）；窗口来自服务端 setTimeout，与并行负载无关，5 s 余量只吸收落盘与轮询。
  ok(uSettled && uSettled.status === 'denied' && uSettled.decidedBy === 'timeout' && (Date.parse(uSettled.decidedAt) - t0U) < BASE_MS + 5000,
    `C1 U 没交给管家:缺省 ${BASE_MS / 1000} s 就按超时拒(实测 ${uSettled && uSettled.status}/${uSettled && uSettled.decidedBy},${uSettled ? Math.round((Date.parse(uSettled.decidedAt) - t0U) / 1000) : '?'} s)`);
  ok(deferredFor(U).length === 0, `C1b 管家看过 U 也不报「留给你」(它不经手;实测 ${deferredFor(U).length} 帧)`);

  // [P4] W 到管家经手的窗口按超时拒;[P3] 只报一次
  const wSettled = await waitFor(() => { const r = ivRows(W).find(x => x.id === pendW.id); return r && TERMINAL.includes(r.status) ? r : null; }, MEDIATED_MS + 10000);
  const wAge = wSettled ? Date.parse(wSettled.decidedAt) - t0W : -1;
  // 墙钟上界豁免：同上 —— 这一条要分清「按 45 s 窗口超时」与「被 idle 看门狗或别的路提前收掉」，上界是窗口本身加 6 s 落盘余量。
  ok(wSettled && wSettled.status === 'denied' && wSettled.decidedBy === 'timeout' && wAge >= MEDIATED_MS - 2000 && wAge <= MEDIATED_MS + 6000,
    `P4 W 到 ${MEDIATED_MS / 1000} s 按超时拒(实测 ${wSettled && wSettled.status}/${wSettled && wSettled.decidedBy},${Math.round(wAge / 1000)} s)`);
  ok(deferredFor(W).length === 1, `P3 同一条请求只报一次(实测 ${deferredFor(W).length} 帧)`);
  const [rW, rU] = await Promise.all([turnW, turnU]);
  const watchdogHit = r => (r.events || []).some(e => e && e.type === 'stderr' && /\[watchdog\]/.test(String(e.text || '')));
  ok(!watchdogHit(rW), 'P4b W 的回合没被 idle 看门狗中止(权限挂着豁免)');
  ok(!watchdogHit(rU), 'C2 U 的回合同样没被看门狗中止(豁免与管家无关)');
} catch (e) {
  fail++; console.log('FAIL 未捕获异常: ' + ((e && e.stack) || e));
} finally {
  if (stream) stream.close();
  if (proc && proc.pid) { try { killOwnTree(proc); } catch { /* gone */ } }
  try { providerServer.close(); } catch { /* gone */ }
  await sleep(300);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
console.log(fail === 0 ? 'STEWARD DEFERRED PERMISSION E2E: ALL PASS' : `STEWARD DEFERRED PERMISSION E2E: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
})();
