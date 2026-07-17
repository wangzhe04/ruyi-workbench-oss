'use strict';
/*
 * E2E (B1): resource-lease deadlock backstop + agent-workflow idle watchdog.
 *
 * Root cause fixed: runSubAgent takes a NODE-level lease over a whole sub-task, then runSubAgentCore takes a
 * per-tool lease for each tool call. Two concurrent nodes that each hold their node lease and then cross-access
 * the other's resource form a wait cycle drainResourceWaiters can never satisfy → Promise.all (and the whole
 * run) hangs forever. The async/resume launch paths also had no idle watchdog, so a wedged run never recovered.
 *
 * Sections:
 *  1)  IN-PROCESS unit: acquireResourceLease abandons a blocked wait with RESOURCE_TIMEOUT (explicit timeout)
 *      instead of hanging; a non-conflicting lease still acquires; no waiter leak after release.
 *  1b) IN-PROCESS cycle detection (the PRIMARY deadlock signal): a real cross-hold wait cycle is rejected FAST
 *      with RESOURCE_DEADLOCK (not after a timeout) and, once the victim releases, the parked waiter acquires;
 *      a legitimate LONG hold (no cycle) does NOT false-fail and the waiter succeeds on release.
 *  2)  INTEGRATION deadlock: two concurrent DAG nodes each declare one exclusive resource and, mid-run, write
 *      the OTHER node's resource. Asserts the run REACHES A TERMINAL STATE (does not hang) and the persisted
 *      node progress shows the resource wait + the failed tool (now broken by cycle detection, not the timeout).
 *  3)  INTEGRATION watchdog: a node whose provider hangs forever is aborted by the run-level idle watchdog on
 *      the async launch path (run.idleAborted === true) rather than hanging with no recovery.
 *  4)  INTEGRATION pause: a run PAUSED longer than the idle limit is NOT idle-killed (watchdog skips while
 *      paused + resets the idle clock on resume); after resume the remaining node runs to success.
 *
 * Run: node dev-harness/agent-deadlock-watchdog.e2e.js   (ports 9097 fake / 9098 workbench)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-deadlock-watchdog');
const LEASE_TIMEOUT_MS = 1500; // WB deadlock backstop for this run (fast enough for a test)
const IDLE_MS = 3000;          // WB idle-watchdog limit for this run (< the 5s watchdog tick → fires at 1st tick)
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function countToolMsgs(msgs) { return (msgs || []).filter(m => m && m.role === 'tool').length; }
function userTextOf(msgs) { return (msgs || []).filter(m => m && m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n'); }
function emitToolCall(res, id, callId, name, args) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}

const fileA = () => path.join(HOME, 'resA.txt');
const fileB = () => path.join(HOME, 'resB.txt');
const sockets = new Set();
const fake = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const id = 'chatcmpl-deadlock';
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const utext = userTextOf(msgs);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      // Watchdog node: write the SSE header then hang forever (never send data/[DONE]). The run-level idle
      // watchdog must abort it.
      if (utext.includes('HANG_NODE')) { /* intentionally leave the stream open */ return; }
      // Pause-fix nodes: PAUSE_SLOW keeps its node status=running ~1.5s (long enough to land a pause while it
      // runs); PAUSE_FAST concludes at once. Neither uses tools — they just prove a node survives a long pause.
      if (utext.includes('PAUSE_SLOW')) { setTimeout(() => emitText(res, id, 'slow node done'), 1500); return; }
      if (utext.includes('PAUSE_FAST')) { return emitText(res, id, 'fast node done'); }
      const done = countToolMsgs(msgs);
      // Deadlock nodes: first round writes the OTHER node's declared resource → tool-level lease conflicts and
      // blocks (the other node holds it as its node-level lease). After the tool result (the timeout failure)
      // arrives, conclude so the node recovers rather than looping.
      if (done === 0 && (utext.includes('ALPHA_NODE') || utext.includes('BETA_NODE'))) {
        const target = utext.includes('ALPHA_NODE') ? fileB() : fileA();
        return emitToolCall(res, id, 'call_x', 'file_write', { path: target, content: 'deadlock probe' });
      }
      return emitText(res, id, 'node concluded after resource wait');
    });
    return;
  }
  res.writeHead(404); res.end();
});
fake.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    r.on('error', reject); r.write(raw); r.end();
  });
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
async function waitFor(label, fn, tries = 140, gap = 150) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  ok(false, label + ' (timed out)');
  return null;
}
const runOf = (r, runId) => r && Array.isArray(r.runs) && r.runs.find(x => x.id === runId);
const isTerminal = s => s === 'succeeded' || s === 'failed' || s === 'partial' || s === 'stopped' || s === 'cancelled';

(async () => {
  const FP = await getFreePort(), WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  // Start the fake listener FIRST so its HTTP handle keeps the event loop alive during Section 1. The
  // lease-timeout timer is .unref()'d (correct for production — a pending lease must never keep the process
  // up), so without a ref'd handle the in-process await below would let node exit before the timer fires.
  await new Promise(r => fake.listen(FP, '127.0.0.1', r));

  // -------- Section 1: in-process lease-timeout primitive (deterministic, no server) --------
  // Requiring server.js does not start a server (require.main !== module). Set RUYI_HOME first so any
  // incidental module-load I/O is sandboxed. This process does NOT set WCW_RESOURCE_LEASE_TIMEOUT_MS, so the
  // default is the long (30min) backstop — we pass an explicit short timeoutMs to prove the timeout backstop
  // directly, and Section 1b proves cycle detection (the primary signal) rejects a real deadlock instantly.
  process.env.RUYI_HOME = HOME;
  const server = require(path.join(WB, 'app', 'server.js'));
  const rX = server.normalizeAgentResources(['file:' + path.join(HOME, 'X.txt')], HOME);
  const rY = server.normalizeAgentResources(['file:' + path.join(HOME, 'Y.txt')], HOME);
  const held = await server.acquireResourceLease('holder', rX);
  let timedOut = false, code = '';
  const t0 = Date.now();
  try { await server.acquireResourceLease('waiter', rX, null, null, 300); }
  catch (e) { timedOut = true; code = e && e.code; }
  const waited = Date.now() - t0;
  ok(timedOut && code === 'RESOURCE_TIMEOUT', 'blocked lease rejects with RESOURCE_TIMEOUT instead of hanging forever');
  ok(waited >= 250 && waited < 3000, 'timeout fires near the configured window (got ' + waited + 'ms)');
  const otherTok = await server.acquireResourceLease('other', rY, null, null, 300);
  ok(!!otherTok, 'a non-conflicting lease still acquires immediately (timeout does not affect the happy path)');
  server.releaseResourceLease(otherTok);
  server.releaseResourceLease(held);
  const freeNow = await server.acquireResourceLease('after-release', rX, null, null, 300);
  ok(!!freeNow, 'after the holder releases, the resource is acquirable again (no waiter leak)');
  server.releaseResourceLease(freeNow);

  // -------- Section 1b: wait-for-graph cycle detection is the PRIMARY deadlock signal (replaces the timeout) --------
  // Real cycle: A holds rX and (blocked) waits for rY; B holds rY and then wants rX -> B->A->B. B must be
  // rejected FAST with RESOURCE_DEADLOCK, not after the long backstop timeout. Then, once B releases, A's parked
  // wait drains and acquires — the deadlock is genuinely broken, not merely reported.
  const cA = await server.acquireResourceLease('cyc-A', rX);   // A holds rX
  const cB = await server.acquireResourceLease('cyc-B', rY);   // B holds rY
  let aGotY = false;
  const aWaitsY = server.acquireResourceLease('cyc-A', rY, null, null, 0).then(t => { aGotY = true; return t; }); // A blocks on rY (held by B); timeout 0 = wait forever; no cycle YET (B is not waiting)
  await sleep(30);
  ok(!aGotY, 'the first cross-waiter parks (no cycle yet: the holder B is not itself waiting)');
  let dlCode = ''; const tDl = Date.now();
  try { await server.acquireResourceLease('cyc-B', rX, null, null, 0); } // B wants rX (held by A, who now waits for rY held by B) -> cycle
  catch (e) { dlCode = e && e.code; }
  const dlWaited = Date.now() - tDl;
  ok(dlCode === 'RESOURCE_DEADLOCK', 'a real wait-for cycle is rejected with RESOURCE_DEADLOCK (not RESOURCE_TIMEOUT)');
  ok(dlWaited < 300, 'the cycle is rejected IMMEDIATELY, not after the backstop timeout (got ' + dlWaited + 'ms)');
  server.releaseResourceLease(cB);            // B releases rY -> A's parked wait can now drain
  const aTokY = await aWaitsY;
  ok(aGotY && !!aTokY, 'after the cycle victim releases, the parked waiter finally acquires (deadlock broken)');
  server.releaseResourceLease(aTokY); server.releaseResourceLease(cA);

  // Legit long hold (NO cycle): a single holder keeps rX; a waiter must NOT false-fail as a deadlock and must
  // acquire once the holder releases. This proves cycle detection does not punish a legitimately long-held
  // resource, and the demoted timeout no longer trips at the old 60s. This process leaves the default (30min)
  // timeout, so the 300ms hold below never times out; the waiter succeeds purely on the release.
  const longHold = await server.acquireResourceLease('long-holder', rX);
  let waiterGot = false;
  const longWaiter = server.acquireResourceLease('long-waiter', rX).then(t => { waiterGot = true; return t; }); // default (long) timeout, no cycle
  await sleep(300);
  ok(!waiterGot, 'a legitimate long hold does NOT false-timeout / false-deadlock; the waiter stays parked');
  server.releaseResourceLease(longHold);
  const longTok = await longWaiter;
  ok(waiterGot && !!longTok, 'once the long holder releases, the waiter acquires and completes (no false deadlock)');
  server.releaseResourceLease(longTok);

  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    subagentMaxConcurrent: 2, // both deadlock nodes must run in ONE batch
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));

  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, RUYI_HOME: HOME, WCW_RESOURCE_LEASE_TIMEOUT_MS: String(LEASE_TIMEOUT_MS), WCW_AGENT_WORKFLOW_IDLE_MS: String(IDLE_MS) },
  });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'deadlock-watchdog', cwd: HOME }, hdr);
    const sid = created.session.id;

    // -------- Section 2: cross-resource deadlock is broken by the tool-level lease timeout --------
    const dl = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'alpha', task: 'ALPHA_NODE: write the peer resource', toolTier: 'edit', resources: ['file:' + fileA()] },
        { id: 'beta', task: 'BETA_NODE: write the peer resource', toolTier: 'edit', resources: ['file:' + fileB()] },
      ],
    }, hdr);
    ok(dl && dl.ok === true && /^run_/.test(dl.runId || ''), 'deadlock workflow launches async with a run id');

    // THE key regression guard: the run must reach a terminal state. Without the backstop this never resolves.
    const dlRun = await waitFor('deadlock run reaches a terminal state (does not hang)', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, dl.runId);
      return run && isTerminal(run.status) && run;
    });
    ok(!!dlRun, 'deadlock run terminated instead of hanging forever');
    if (dlRun) {
      const nodes = dlRun.nodes || [];
      ok(nodes.length === 2 && nodes.every(n => isTerminal(n.status)), 'both deadlock nodes reached a terminal state');
      const allProg = nodes.flatMap(n => (n.progressLog || []).map(e => e.text || ''));
      ok(allProg.some(t => /等待资源/.test(t)), 'a node recorded a resource wait (the cross-access actually contended)');
      ok(allProg.some(t => /工具返回 错误/.test(t)), 'a node recorded a failed tool result (the deadlock victim was rejected by cycle detection)');
      console.log('  deadlock run status:', dlRun.status, '| node statuses:', nodes.map(n => n.id + '=' + n.status).join(','));
    }

    // -------- Section 3: idle watchdog aborts a wedged (never-responding) node on the async path --------
    const wd = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [{ id: 'wedged', task: 'HANG_NODE: the provider never responds', toolTier: 'read' }],
    }, hdr);
    ok(wd && wd.ok === true && /^run_/.test(wd.runId || ''), 'watchdog workflow launches async with a run id');

    const wdRun = await waitFor('wedged run is aborted by the idle watchdog', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, wd.runId);
      return run && run.idleAborted === true && run;
    });
    ok(!!wdRun && wdRun.idleAborted === true, 'run.idleAborted is set — the idle watchdog fired on the async path');
    if (wdRun) {
      ok(isTerminal(wdRun.status), 'wedged run reaches a terminal state after the watchdog abort');
      console.log('  watchdog run status:', wdRun.status, '| idleAborted:', wdRun.idleAborted);
    }

    // -------- Section 4: a run PAUSED longer than the idle limit must NOT be idle-killed --------
    // The watchdog must (a) accrue no idle time while paused and (b) reset the idle clock on resume. Without
    // these, a pause held past the idle limit trips the watchdog, aborts localCtrl, and the resume then cancels
    // every remaining node ("空闲超时") — a zombie/false-kill. pa is slow (its node stays running long enough to
    // land the pause); pb (dependsOn pa) must still run to success after a long pause.
    const pz = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'pa', task: 'PAUSE_SLOW: slow first node (stays running long enough to land a pause)', toolTier: 'read' },
        { id: 'pb', task: 'PAUSE_FAST: second node must still run after a long pause', toolTier: 'read', dependsOn: ['pa'] },
      ],
    }, hdr);
    ok(pz && pz.ok === true && /^run_/.test(pz.runId || ''), 'pause workflow launches async with a run id');
    // Catch pa while its (slow) provider call keeps it running, then pause.
    const paRunning = await waitFor('first node reaches running (before pausing)', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, pz.runId);
      const pa = run && (run.nodes || []).find(n => n.id === 'pa');
      return pa && pa.status === 'running' && run;
    });
    ok(!!paRunning, 'first node is running when we issue pause');
    await post(WP, `/api/agent-runs/${pz.runId}`, { token, sessionId: sid, action: 'pause' }, hdr);
    // Confirm the run actually parked in the paused state (pa finished; pb is queued behind the pause gate).
    const paused = await waitFor('run enters the paused state', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, pz.runId);
      return run && run.status === 'paused' && run;
    });
    ok(!!paused, 'run reached status=paused with the second node still pending');
    // Stay paused well past a watchdog tick that would see elapsed > IDLE_MS (3s). Without fix (a) the ~5s
    // run-relative tick fires and aborts the paused run; with it, the watchdog skips accounting while paused.
    await sleep(IDLE_MS + 6000);
    const stillPaused = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr).then(r => runOf(r, pz.runId));
    ok(stillPaused && stillPaused.idleAborted !== true, 'the watchdog did NOT abort the run while it was paused (idleAborted stays false)');
    ok(stillPaused && stillPaused.status === 'paused', 'the run is STILL paused after idling longer than the idle limit (not idle-killed)');
    // Resume: pb must run and the whole run must succeed. The resume also resets the idle clock so the next
    // watchdog tick does not immediately false-fire on the freshly-resumed node.
    await post(WP, `/api/agent-runs/${pz.runId}`, { token, sessionId: sid, action: 'resume' }, hdr);
    const pzDone = await waitFor('resumed run reaches a terminal state', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, pz.runId);
      return run && isTerminal(run.status) && run;
    });
    ok(!!pzDone && pzDone.status === 'succeeded', 'the resumed run completed successfully (not cancelled by the watchdog)');
    if (pzDone) {
      const pb = (pzDone.nodes || []).find(n => n.id === 'pb');
      ok(pb && pb.status === 'succeeded', 'the second node ran to success after the long pause (not idle-cancelled)');
      ok(pzDone.idleAborted !== true, 'the run was never idle-aborted across the whole pause/resume cycle');
      console.log('  pause run status:', pzDone.status, '| node statuses:', (pzDone.nodes || []).map(n => n.id + '=' + n.status).join(','));
    }
  } catch (e) { console.error('ERROR ' + (e && e.stack || e)); failures++; }
  finally {
    kill(wb);
    for (const s of sockets) { try { s.destroy(); } catch {} }
    fake.close();
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT DEADLOCK/WATCHDOG E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
