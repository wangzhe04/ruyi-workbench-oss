'use strict';
/*
 * Covers the right-side Agent workflow live-progress UX contract (v1.4.6): a run launched from the UI
 * button / resume / CLI has NO chat stream (onEvent is a no-op), so polling /api/agent-runs is its only
 * progress signal. runAgentWorkflow folds each node's live subagent events into node.progressLog and
 * throttle-saves them mid-execution so that signal is not stale.
 *
 * Assertions:
 * - UI launches use async:true and return immediately with a run id.
 * - Polling exposes live node progressLog entries.
 * - (A) A slow multi-step OpenAI node's progressLog intermediate entry is readable WHILE the node is
 *       still `running` (proves the throttled mid-execution persistence, not just the final save).
 * - Finished runs persist a readable summary + node result, and append a session summary message.
 * - (C) A Claude-engine node (fake-claude long-text fixture) persists a "生成中 · N 字" streamed-text
 *       milestone, and the final "子 Agent 完成" entry appends independently without overwriting it.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-workflow-ui-progress');
const SLOW_TOOL_ROUNDS = 3; // enough tool rounds (each delayed) to keep the OpenAI node `running` for ~1s
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
async function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  await sleep(60);
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
async function emitTool(res, id, callId) {
  const args = JSON.stringify({ path: path.join(HOME, 'evidence.txt') });
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'file_read', arguments: args } }] }, finish_reason: null }] });
  await sleep(180); // deliberate per-round delay so the node stays `running` across several polls
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function isSubRequest(msgs) {
  const sys = String(((msgs || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体') || sys.includes('瀛愪换鍔℃墽琛屼綋');
}
function toolResultCount(msgs) { return (msgs || []).filter(m => m && m.role === 'tool').length; }
const finalJson = JSON.stringify({ verdict: 'pass', confidence: 0.88, summary: 'UI progress workflow completed', findings: [] });
let toolRequests = 0;
const fake = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (isSubRequest(msgs)) {
        const done = toolResultCount(msgs);
        // Multi-step: emit SLOW_TOOL_ROUNDS delayed tool calls, then the schema-valid conclusion.
        if (done < SLOW_TOOL_ROUNDS) { toolRequests++; return emitTool(res, 'chatcmpl-ui-progress', 'call_' + done); }
        return emitText(res, 'chatcmpl-ui-progress', finalJson);
      }
      return emitText(res, 'chatcmpl-ui-progress', 'workflow accepted');
    });
    return;
  }
  res.writeHead(404); res.end();
});

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1200, headers }, res => {
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
async function waitFor(label, fn) {
  for (let i = 0; i < 100; i++) { const v = await fn(); if (v) return v; await sleep(100); }
  ok(false, label); return null;
}
function runOf(r, runId) { return r && Array.isArray(r.runs) && r.runs.find(x => x.id === runId); }

(async () => {
  const FP = await getFreePort(), WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'evidence.txt'), 'ui progress evidence');
  // fake-claude long-text fixture: one assistant message whose text crosses the 400-char progress step,
  // so a Claude-engine node fires at least one subagent_progress "生成中 · N 字" milestone during streaming.
  const longText = '这是一段用于验证长文本流式进度里程碑的分析内容。'.repeat(30); // ~720 chars > CLAUDE_PROGRESS_CHAR_STEP
  const claudeFixture = [
    { type: 'system', subtype: 'init', session_id: 'fake-lt', tools: [], model: 'fake-model' },
    { type: 'assistant', session_id: 'fake-lt', message: { role: 'assistant', content: [{ type: 'text', text: longText }] } },
    { type: 'result', subtype: 'success', is_error: false, result: '长文本分析完成', session_id: 'fake-lt' },
  ].map(e => JSON.stringify(e)).join('\n');
  fs.writeFileSync(path.join(HOME, 'longtext.jsonl'), claudeFixture);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));
  await new Promise(r => fake.listen(FP, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true,
    // WCW_FAKE_CLAUDE + WCW_FAKE_SCENARIO drive the Claude-engine node through fake-claude replaying the
    // long-text fixture (no real Claude CLI); OpenAI nodes ignore both and use the fake provider above.
    env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_SCENARIO: path.join(HOME, 'longtext.jsonl') },
  });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'ui-progress', cwd: HOME }, hdr);
    const sid = created.session.id;

    // ---- (A) slow multi-step OpenAI node: live progressLog readable WHILE still running ----
    const schema = { type: 'object', required: ['verdict', 'confidence', 'summary', 'findings'], properties: { verdict: { type: 'string' }, confidence: { type: 'number' }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } };
    const launched = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, async: true, nodes: [{ id: 'verify', task: 'verify with progress', role: 'verifier', outputSchema: schema }] }, hdr);
    ok(launched.ok === true && launched.accepted === true && /^run_/.test(launched.runId || ''), 'async workflow launch returns immediately with a run id');

    let sawRunning = false;
    const liveRun = await waitFor('live progress appears in agent-runs', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, launched.runId);
      const node = run && run.nodes && run.nodes[0];
      if (!node || !Array.isArray(node.progressLog)) return null;
      const hasIntermediate = node.progressLog.some(x => /调用工具|子 Agent 启动/.test(x.text || ''));
      // The strict claim: catch that intermediate entry while the node is still executing, proving the
      // throttled mid-execution flush (not merely the terminal saveAgentRun that fires on node completion).
      if (hasIntermediate && (node.status === 'running' || node.status === 'waiting_resource')) sawRunning = true;
      return hasIntermediate && run;
    });
    ok(!!liveRun, 'agent-runs exposes live node progressLog entries');
    ok(sawRunning, 'progressLog intermediate entry is readable while the node is still running (throttled mid-exec persistence)');

    const doneRun = await waitFor('workflow finishes with persisted summary', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, launched.runId);
      return run && run.status === 'succeeded' && run.summary && run.nodes && run.nodes[0] && run.nodes[0].result && run;
    });
    ok(!!doneRun && /UI progress workflow completed/.test(doneRun.summary), 'finished run persists readable summary and node result');
    // v1.9 存储 v2:头文件不再内联 messages —— v2 读 <sid>.messages.ndjson 正文,legacy 读单文件。
    const headRaw = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', `${sid}.json`), 'utf8'));
    const sessionMessages = Array.isArray(headRaw.messages) ? headRaw.messages
      : fs.readFileSync(path.join(HOME, 'sessions', `${sid}.messages.ndjson`), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    ok(sessionMessages.some(m => m && m.source === 'agent_workflow' && /UI progress workflow completed/.test(m.content || '')), 'workflow completion appends an assistant summary message to the session');
    ok(toolRequests >= 1, 'fake provider actually exercised sub-agent tool progress');

    // ---- (C) Claude-engine node: persisted "生成中 · N 字" milestone + independent done entry ----
    const claudeLaunch = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, async: true, nodes: [{ id: 'claude_analyze', task: '请就给定主题写一段较长的中文分析并给出结论', engine: 'claude' }] }, hdr);
    ok(claudeLaunch.ok === true && /^run_/.test(claudeLaunch.runId || ''), 'async Claude-engine workflow launches');
    const claudeRun = await waitFor('Claude node finishes', async () => {
      const r = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = runOf(r, claudeLaunch.runId);
      const node = run && run.nodes && run.nodes[0];
      return node && (node.status === 'succeeded' || node.status === 'failed') && run;
    });
    const claudeNode = claudeRun && claudeRun.nodes[0];
    ok(!!claudeNode && claudeNode.status === 'succeeded', 'Claude-engine node succeeds via fake-claude long-text fixture');
    const plog = claudeNode && Array.isArray(claudeNode.progressLog) ? claudeNode.progressLog : [];
    ok(plog.some(x => /生成中/.test(x.text || '') && /\d+/.test(x.text || '')), 'persisted progressLog contains a 生成中 · N 字 streamed-text milestone');
    ok(plog.some(x => /子 Agent 完成/.test(x.text || '')), 'final 子 Agent 完成 entry appended independently (did not overwrite the 生成中 milestone)');
  } finally {
    kill(wb); fake.close(); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT WORKFLOW UI PROGRESS E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
