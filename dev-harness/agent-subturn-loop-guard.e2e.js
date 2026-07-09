'use strict';
/*
 * E2E (B3): sub-turn loop guard. The PARENT turn (runOpenAiTurn) has long had a consecutive-identical-tool
 * signature guard (loop-guard.e2e.js); the SUB-turn (runSubAgentCore) had NONE, so a wedged sub-agent that
 * repeats one tool would burn its whole iteration budget (raised to 100) making 100 provider calls before
 * failing. This repro drives a DAG OpenAI node whose fake provider emits the SAME file_read call every round.
 *
 * Scenario 1 asserts the sub-turn aborts at the parent-parity threshold (5 consecutive) instead of running to
 * budget:
 *   - the fake serves exactly 5 tool-bearing requests (NOT ~100);
 *   - the node fails with the「连续 5 次相同工具调用」abort reason;
 *   - node.iters / node.toolCalls stay far below the 100 budget.
 *
 * Scenario 2 (B3-fix) asserts the same-batch pairing: one batch of 6 identical calls trips the guard at the
 * 5th; the calls already executed (1..4) must NOT be re-emitted / re-paired as "未执行". Every tool_call is
 * paired EXACTLY once (checked via the per-tool_result progressLog milestones, one per distinct call id).
 *
 * Run: node dev-harness/agent-subturn-loop-guard.e2e.js   (ports 9095 fake / 9096 workbench)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-subturn-loop-guard');
const FP = 9095;
const WP = 9096;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function countToolMsgs(msgs) { return (msgs || []).filter(m => m && m.role === 'tool').length; }
function userTextOf(msgs) { return (msgs || []).filter(m => m && m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n'); }
function isSubRequest(msgs) {
  const sys = String(((msgs || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体') || sys.includes('瀛愪换鍔℃墽琛屼綋');
}
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

// One assistant message carrying N tool_calls (distinct ids, streamed by index) — mirrors fake-openai's
// FAKE_PARALLEL_TOOLS shape so the workbench accumulates them into a single parallel batch.
function emitParallel(res, id, calls) {
  calls.forEach((c, index) => {
    const argsFull = JSON.stringify(c.args || {});
    sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index, id: c.callId, type: 'function', function: { name: c.name, arguments: '' } }] }, finish_reason: null }] });
    sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: argsFull } }] }, finish_reason: null }] });
  });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}

let subToolRequests = 0;
let parallelBatchRequests = 0;
const EVIDENCE = () => path.join(HOME, 'evidence.txt');
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
      const id = 'chatcmpl-subloop';
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      // Every sub-turn round: emit the EXACT SAME file_read call (a succeeding-but-repeating tool, the hardest
      // case — the guard must fire even when the call keeps succeeding). Without the guard this repeats until
      // the 100-iteration budget. call id is stable so the signature stays identical round to round.
      // B3-fix pairing scenario: a SINGLE batch of 6 identical-signature file_read calls with DISTINCT ids.
      // The sub-turn executes 1..4, aborts at the 5th (SUB_LOOP_ABORT_AT), then must PAIR the remaining ones
      // without re-reporting the already-executed 1..4. One request only — the sub-turn aborts within it.
      if (isSubRequest(msgs) && hasTools && userTextOf(msgs).includes('PARALLEL_BATCH')) {
        parallelBatchRequests += 1;
        return emitParallel(res, id, Array.from({ length: 6 }, (_, i) => ({ callId: 'call_' + (i + 1), name: 'file_read', args: { path: EVIDENCE() } })));
      }
      if (isSubRequest(msgs) && hasTools) {
        subToolRequests += 1;
        return emitToolCall(res, id, 'call_loop', 'file_read', { path: EVIDENCE() });
      }
      // Only reached if the guard did NOT stop the loop and the budget finalizer kicked in (no-tool request).
      return emitText(res, id, 'unexpected non-tool sub response');
    });
    return;
  }
  res.writeHead(404); res.end();
});

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1000, headers }, res => {
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

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(EVIDENCE(), 'loop guard evidence content');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));

  await new Promise(r => fake.listen(FP, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'subturn-loop-guard', cwd: HOME }, hdr);
    const sid = created.session.id;

    // Single node, NO maxIters override → budget defaults to 100. Without the sub-turn guard the fake would
    // serve ~100 identical tool requests; with it, the run aborts the sub at the 5th consecutive signature.
    const result = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid,
      nodes: [{ id: 'loop', task: 'REPEAT_SAME_TOOL', toolTier: 'read' }],
    }, hdr);
    const node = result && result.results && result.results[0];
    console.log('  status:', node && node.status, '| subToolRequests:', subToolRequests, '| iters:', node && node.iters, '| toolCalls:', node && node.toolCalls, '| error:', node && node.error);

    ok(result && result.ok === false && result.status === 'failed', 'run terminates (failed) — did not hang');
    ok(!!node && node.status === 'failed', 'the looping node fails');
    ok(!!node && /连续 5 次相同工具调用/.test(node.error || ''), 'node fails with the sub-turn loop-guard abort reason (got: ' + (node && node.error) + ')');
    ok(subToolRequests === 5, 'fake served exactly 5 tool requests — guard aborted at the 5th, NOT the 100 budget (got ' + subToolRequests + ')');
    // The 5-request count IS the anti-budget proof (without the guard the fake would serve ~100). node.iters /
    // node.toolCalls are not exposed on the sync results array; read the persisted run to confirm them too.
    const runsAfter = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
    const persisted = runsAfter && Array.isArray(runsAfter.runs) && runsAfter.runs.find(r => r.id === result.runId);
    const pnode = persisted && Array.isArray(persisted.nodes) && persisted.nodes.find(n => n.id === 'loop');
    ok(!!pnode && Number(pnode.iters) <= 6, 'persisted node.iters stays far below the 100 budget (got ' + (pnode && pnode.iters) + ')');
    ok(!!pnode && Number(pnode.toolCalls) <= 5, 'persisted node.toolCalls stays far below the 100 budget (got ' + (pnode && pnode.toolCalls) + ')');

    // -------- Scenario 2 (B3-fix): same-batch abort must NOT re-report already-executed calls --------
    // A single assistant message with 6 identical-signature file_read calls (distinct ids call_1..call_6). The
    // sub-turn executes call_1..4, aborts at call_5, then pairs the remainder. Before the fix, the abort seeded
    // the dedup set with ONLY the current tc, so call_1..4 (already executed + already paired) were re-emitted
    // as tool_use/tool_result labeled "该调用未执行" and re-pushed — double-pairing + false "not executed".
    // After the fix every tool_call is paired EXACTLY ONCE. We read the node's progressLog (which records a
    // "工具返回 … · <id>" milestone per tool_result) and assert each id appears at most once.
    const batch = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid,
      nodes: [{ id: 'pbatch', task: 'PARALLEL_BATCH: emit one batch of identical calls', toolTier: 'read' }],
    }, hdr);
    const bnode = batch && batch.results && batch.results[0];
    console.log('  [batch] status:', bnode && bnode.status, '| parallelBatchRequests:', parallelBatchRequests, '| error:', bnode && bnode.error);
    ok(!!bnode && bnode.status === 'failed', 'the parallel-batch node fails (loop-guard tripped within the batch)');
    ok(!!bnode && /连续 5 次相同工具调用/.test(bnode.error || ''), 'parallel-batch node aborts with the sub-turn loop-guard reason');
    ok(parallelBatchRequests === 1, 'fake served the parallel batch exactly once — the sub-turn aborted within the first batch (got ' + parallelBatchRequests + ')');

    const runsB = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
    const persistedB = runsB && Array.isArray(runsB.runs) && runsB.runs.find(r => r.id === batch.runId);
    const pbatch = persistedB && Array.isArray(persistedB.nodes) && persistedB.nodes.find(n => n.id === 'pbatch');
    const toolResultMilestones = ((pbatch && pbatch.progressLog) || []).map(e => e.text || '').filter(t => /工具返回/.test(t));
    const idCounts = {};
    for (const t of toolResultMilestones) { const m = t.match(/·\s*(call_\d+)/); if (m) idCounts[m[1]] = (idCounts[m[1]] || 0) + 1; }
    const uniqueIds = Object.keys(idCounts);
    const anyDouble = uniqueIds.some(k => idCounts[k] > 1);
    console.log('  [batch] tool_result milestones:', toolResultMilestones.length, '| id counts:', JSON.stringify(idCounts));
    ok(!anyDouble, 'no tool_call id is reported twice — already-executed calls are NOT re-reported as "未执行" (got ' + JSON.stringify(idCounts) + ')');
    ok(uniqueIds.length === 6 && toolResultMilestones.length === 6, 'all 6 tool_calls are paired EXACTLY once (配对铁律), no duplicate/orphan pairing (got ' + toolResultMilestones.length + ' milestones over ' + uniqueIds.length + ' ids)');
  } catch (e) { console.error('ERROR ' + (e && e.stack || e)); failures++; }
  finally {
    kill(wb);
    fake.close();
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT SUBTURN LOOP GUARD E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
