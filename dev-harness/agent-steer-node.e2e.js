'use strict';
/*
 * E2E (v1 定向插话 / steer to a specific running sub-agent node). A LIVE persisted DAG workflow lets the user
 * inject a one-off instruction into ONE running/queued OpenAI-engine node; runSubAgentCore drains it at its
 * next iteration boundary (before the next API call), mirroring the parent turn's /api/steer + drainSteerQueue.
 *
 * DAG: work (openai, no deps) -> { later (openai), claudenext (claude), gate (vote gate) } all depend on work,
 * so WHILE `work` runs they sit `queued` — deterministic targets for the queued-node assertions (a queued node
 * never drains its steer queue until it starts, so the cap test can never race a consumption). Assertions:
 *   (a) a steer POSTed to the RUNNING `work` node appears as `[编排者插话] STEER_MARK` in a LATER fake request body;
 *   (b) the persisted run's `work` node grows a 「插话 · STEER_MARK」 progressLog milestone (survives refresh/restart);
 *   (c) steer on the (queued) Claude-engine node -> 409「Claude 引擎节点…」 (single-shot -p process, unsupported);
 *   (d) steer on the already-succeeded `work` node while the run is STILL live -> 409「节点已结束」;
 *   (e) per-node queue cap: 3 steers on the queued `later` node succeed (queued 1/2/3), the 4th -> 409「插话队列已满」;
 *   (bonus) those 3 queued pre-steers are delivered to `later`, IN ORDER, in a single fake request body once it starts;
 *   (f) steer on the (queued) `gate` vote-gate node -> 409「确定性质量门…」 (aggregateAgentVote short-circuits it,
 *       never calling the model, so no iteration boundary would ever drain a queued steer);
 *   (g) steer with a forged sessionId but the real runId -> 404 (run-ownership guard, shared by pause/resume/
 *       stop/steer_node — a session must not be able to touch another session's live run by guessing its runId);
 *   (h) steer with empty text -> 400「插话内容不能为空」;
 *   (i) steer with a nonexistent nodeId -> 404「节点不存在」;
 *   (j) steer once the run has reached a terminal (non-live) state -> 409「工作流当前未运行」.
 *
 * A self-contained INLINE fake-openai (no shared fake-openai.js change) serves each sub-request a delayed,
 * DISTINCT-arg file_read tool_call for ROUNDS rounds (distinct args so the sub-turn loop-guard never trips),
 * then a final text — keeping each node `running` long enough to observe/steer. A tiny fake-claude fixture
 * makes the Claude node deterministic (WCW_FAKE_CLAUDE, no real Claude CLI spawn).
 *
 * Run: node dev-harness/agent-steer-node.e2e.js   (ports 9101 fake-openai / 9102 workbench)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-steer-node');
const FP = 9101; // fake-openai
const WP = 9102; // workbench
const ROUNDS = 10;   // tool rounds per node before the fake emits a final answer
const DELAY = 200;   // per-round stream delay (ms) — keeps a node `running` for ~ROUNDS*DELAY
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function isSubRequest(msgs) {
  const sys = String(((msgs || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体') || sys.includes('瀛愪换鍔℃墽琛屼綋');
}
function toolResultCount(msgs) { return (msgs || []).filter(m => m && m.role === 'tool').length; }
// Emit ONE tool_call (distinct path per round → distinct signature → the sub-turn loop-guard never fires),
// arguments split across two SSE fragments spaced by DELAY so the node stays `running` across several polls.
async function emitTool(res, id, callId, round) {
  const args = JSON.stringify({ path: 'probe-' + round + '.txt' });
  const half = Math.ceil(args.length / 2);
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'file_read', arguments: '' } }] }, finish_reason: null }] });
  await sleep(DELAY);
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] }, finish_reason: null }] });
  await sleep(DELAY);
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
async function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}

const capturedBodies = []; // raw /chat/completions request bodies — searched for injected steer markers
const fake = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      capturedBodies.push(body);
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const id = 'chatcmpl-steer';
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (isSubRequest(msgs) && hasTools) {
        const done = toolResultCount(msgs);
        if (done < ROUNDS) return emitTool(res, id, 'call_' + done, done);
        return emitText(res, id, 'STEER 节点结论文本。');
      }
      return emitText(res, id, 'accepted');
    });
    return;
  }
  res.writeHead(404); res.end();
});

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(b); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
// Returns { status, body } so the 409 assertions can check BOTH the HTTP status and the error wording.
function post(port, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); r.write(raw); r.end();
  });
}
function apiErrorMessage(body) {
  const error = body && body.error;
  return error && typeof error === 'object' ? String(error.message || '') : String(error || '');
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
async function waitFor(fn, tries = 120, gap = 100) { for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); } return null; }
function runOf(r, runId) { return r && Array.isArray(r.runs) && r.runs.find(x => x.id === runId); }
function nodeOf(run, nodeId) { return run && Array.isArray(run.nodes) && run.nodes.find(n => n.id === nodeId); }
const steer = (runId, sid, nodeId, text, hdr) => post(WP, `/api/agent-runs/${encodeURIComponent(runId)}`, { sessionId: sid, action: 'steer_node', nodeId, text }, hdr);

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  // Deterministic Claude-engine node via fake-claude (no dependence on a real Claude CLI on the host).
  const claudeFixture = [
    { type: 'system', subtype: 'init', session_id: 'fake-steer', tools: [], model: 'fake-model' },
    { type: 'assistant', session_id: 'fake-steer', message: { role: 'assistant', content: [{ type: 'text', text: 'claude 节点结论。' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'claude 节点完成', session_id: 'fake-steer' },
  ].map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(HOME, 'claude-fixture.jsonl'), claudeFixture);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    subagentMaxConcurrent: 2, // work runs alone first; later+claudenext+gate become ready together once work
    // finishes, but only 2 dispatch per loop iteration (gate — resolving instantly, deterministically — picks
    // up the slot the next iteration frees; irrelevant to the assertions below, which only need `gate` queued
    // WHILE work is still running).
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));

  await new Promise(r => fake.listen(FP, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_SCENARIO: path.join(HOME, 'claude-fixture.jsonl') },
  });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = (await post(WP, '/api/sessions', { title: 'steer-node', cwd: HOME }, hdr)).body;
    const sid = created.session.id;

    const launched = (await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'work', task: 'STEER_WORK 长跑节点', toolTier: 'read' },
        { id: 'later', task: 'STEER_LATER 队列节点', toolTier: 'read', dependsOn: ['work'] },
        { id: 'claudenext', task: 'STEER_CLAUDE 节点', engine: 'claude', dependsOn: ['work'] },
        { id: 'gate', task: 'STEER_GATE 投票质量门', gate: { mode: 'vote' }, dependsOn: ['work'] },
      ],
    }, hdr)).body;
    ok(launched && launched.ok === true && launched.accepted === true && /^run_/.test(launched.runId || ''), 'async workflow launch returns immediately with a run id');
    const runId = launched.runId;

    // ---- Phase 1: work RUNNING while later + claudenext + gate QUEUED (all depend on work) ----
    const phase1 = await waitFor(async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, runId);
      const w = run && nodeOf(run, 'work'), l = run && nodeOf(run, 'later'), c = run && nodeOf(run, 'claudenext'), g = run && nodeOf(run, 'gate');
      return (w && l && c && g && run.live && w.status === 'running' && l.status === 'queued' && c.status === 'queued' && g.status === 'queued') ? run : null;
    });
    ok(!!phase1, 'phase 1 reached: work running, later/claudenext/gate queued, run live');

    // (c) Claude-engine node steer → 第47波47a 起接受为【延迟插话】(deferred:true,节点结束后注入下游),
    // 不再 409。引擎分支先于状态分支,queued 的 Claude 节点同样走 deferred。延迟插话注入下游上下文的
    // 全路径见 steering-claude.e2e.js D 段,此处锁 action 层的接受语义与响应字段。
    const cRes = await steer(runId, sid, 'claudenext', 'CLAUDE_DEFERRED_MARK', hdr);
    ok(cRes.status === 200 && cRes.body && cRes.body.ok === true && cRes.body.deferred === true,
      '(c) steer on Claude-engine node → 200 deferred:true(47a 延迟插话语义) (got ' + cRes.status + ' / ' + JSON.stringify(cRes.body || {}) + ')');

    // (f) vote-gate node steer → 409 (aggregateAgentVote is a deterministic short-circuit in runAgentWorkflow —
    // it never calls runSubAgent, so there is no iteration boundary to ever drain a queued steer). `gate` is
    // still `queued` here (depends only on `work`), same deterministic target as the (e) cap test below.
    const fRes = await steer(runId, sid, 'gate', 'NOPE', hdr);
    ok(fRes.status === 409 && fRes.body && fRes.body.ok === false && /确定性质量门/.test(apiErrorMessage(fRes.body)),
      '(f) steer on vote-gate node → 409 with wording (got ' + fRes.status + ' / ' + apiErrorMessage(fRes.body) + ')');

    // (g) forged sessionId + the REAL runId → 404 (run-ownership guard shared by pause/resume/stop/steer_node;
    // a session must not be able to touch another session's live run just by guessing/reusing its runId).
    const gRes = await steer(runId, 'totally-forged-session-id', 'work', 'NOPE', hdr);
    ok(gRes.status === 404 && gRes.body && gRes.body.ok === false,
      '(g) steer with forged sessionId + real runId → 404 (got ' + gRes.status + ' / ' + (gRes.body && gRes.body.error) + ')');

    // (h) empty text → 400 with the specific wording (distinct from the generic 'text is required' of /api/steer).
    const hRes = await steer(runId, sid, 'work', '', hdr);
    ok(hRes.status === 400 && hRes.body && hRes.body.ok === false && /插话内容不能为空/.test(apiErrorMessage(hRes.body)),
      '(h) steer with empty text → 400「插话内容不能为空」(got ' + hRes.status + ' / ' + apiErrorMessage(hRes.body) + ')');

    // (i) nonexistent nodeId → 404.
    const iRes = await steer(runId, sid, 'no-such-node-zzz', 'NOPE', hdr);
    ok(iRes.status === 404 && iRes.body && iRes.body.ok === false && /节点不存在/.test(apiErrorMessage(iRes.body)),
      '(i) steer on nonexistent nodeId → 404「节点不存在」(got ' + iRes.status + ' / ' + apiErrorMessage(iRes.body) + ')');

    // (e) per-node queue cap on the QUEUED `later` node: no consumption while queued, so this is deterministic.
    const cap1 = await steer(runId, sid, 'later', 'CAP1', hdr);
    const cap2 = await steer(runId, sid, 'later', 'CAP2', hdr);
    const cap3 = await steer(runId, sid, 'later', 'CAP3', hdr);
    const cap4 = await steer(runId, sid, 'later', 'CAP4', hdr);
    ok(cap1.status === 200 && cap1.body && cap1.body.ok === true && cap1.body.queued === 1, '(e) 1st steer on queued node accepted (queued=1)');
    ok(cap2.body && cap2.body.queued === 2, '(e) 2nd steer accepted (queued=2)');
    ok(cap3.body && cap3.body.queued === 3, '(e) 3rd steer accepted (queued=3)');
    ok(cap4.status === 409 && cap4.body && cap4.body.ok === false && /插话队列已满/.test(apiErrorMessage(cap4.body)),
      '(e) 4th steer over cap → 409「插话队列已满」(got ' + cap4.status + ' / ' + apiErrorMessage(cap4.body) + ')');

    // (a) steer the RUNNING `work` node — must land in a LATER fake request body.
    const aRes = await steer(runId, sid, 'work', 'STEER_MARK', hdr);
    ok(aRes.status === 200 && aRes.body && aRes.body.ok === true && aRes.body.queued === 1, '(a) steer on running node accepted (queued=1)');
    const injected = await waitFor(async () => capturedBodies.some(b => b.includes('[编排者插话] STEER_MARK')) || null);
    ok(!!injected, '(a) [编排者插话] STEER_MARK appears in a subsequent fake request body (drained at next iteration boundary)');

    // (bonus) the 3 queued pre-steers get delivered to `later` when it starts (after work finishes) — getSteer()
    // splices the WHOLE queue at once at the first iteration boundary, so all three must land together, IN
    // ORDER, inside a SINGLE fake request body (not just each showing up somewhere, possibly out of order across
    // separate calls).
    const preDelivered = await waitFor(async () => capturedBodies.find(b => {
      const i1 = b.indexOf('[编排者插话] CAP1'), i2 = b.indexOf('[编排者插话] CAP2'), i3 = b.indexOf('[编排者插话] CAP3');
      return i1 >= 0 && i2 > i1 && i3 > i2;
    }) || null, 200, 100);
    ok(!!preDelivered, '(bonus) queued pre-steers CAP1→CAP2→CAP3 delivered together, in order, in one request body');

    // ---- Phase 2: work SUCCEEDED while the run is STILL live (later keeps it alive) ----
    const phase2 = await waitFor(async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, runId);
      const w = run && nodeOf(run, 'work');
      return (w && w.status === 'succeeded' && run.live) ? run : null;
    });
    ok(!!phase2, 'phase 2 reached: work succeeded while run still live');

    // (b) persisted progressLog milestone survives on the finished node.
    const wnode = phase2 && nodeOf(phase2, 'work');
    const plog = (wnode && Array.isArray(wnode.progressLog)) ? wnode.progressLog : [];
    ok(plog.some(x => /插话/.test(x.text || '') && /STEER_MARK/.test(x.text || '')),
      '(b) work progressLog has a 「插话 · STEER_MARK」 milestone (got ' + JSON.stringify(plog.map(x => x.text)) + ')');

    // (d) steer the already-succeeded node while the run is still live → 409「节点已结束」 (per-node status gate,
    // distinct from the no-live-run 409).
    const dRes = await steer(runId, sid, 'work', 'TOO_LATE', hdr);
    ok(dRes.status === 409 && dRes.body && dRes.body.ok === false && /节点已结束/.test(apiErrorMessage(dRes.body)),
      '(d) steer on finished node (run still live) → 409「节点已结束」(got ' + dRes.status + ' / ' + apiErrorMessage(dRes.body) + ')');

    // Let the run reach a terminal state so teardown is clean (later runs out ROUNDS then finishes).
    const terminalRun = await waitFor(async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, runId);
      return (run && !run.live) ? run : null;
    }, 150, 100);
    ok(!!terminalRun, 'run reaches a terminal (non-live) state');

    // (j) steer after the run has gone terminal → 409「工作流当前未运行」 (the no-live-runtime rejection, distinct
    // from the per-node 「节点已结束」 of (d) which fires while the RUN is still live but that ONE node finished).
    const jRes = await steer(runId, sid, 'work', 'TOO_LATE_TERMINAL', hdr);
    ok(jRes.status === 409 && jRes.body && jRes.body.ok === false && /工作流当前未运行/.test(apiErrorMessage(jRes.body)),
      '(j) steer after the run is terminal → 409「工作流当前未运行」(got ' + jRes.status + ' / ' + apiErrorMessage(jRes.body) + ')');
  } catch (e) { console.error('ERROR ' + (e && e.stack || e)); failures++; }
  finally {
    kill(wb);
    fake.close();
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT STEER NODE E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
