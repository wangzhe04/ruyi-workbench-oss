'use strict';
/*
 * Repro: DAG sub-agent nodes used to fail when the model spent its whole maxIters
 * budget calling tools and never got a final no-tool turn to summarize. Real
 * Reviewer/Verifier runs hit this on medium-sized repos: "子代理已达迭代上限 N 轮".
 *
 * Run: node dev-harness/agent-workflow-budget-finalizer.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-budget-finalizer');
const FP = 9091;
const WP = 9092;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function countToolMsgs(msgs) { return (msgs || []).filter(m => m && m.role === 'tool').length; }
function isSubRequest(msgs) {
  const sys = String(((msgs || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体') || sys.includes('瀛愪换鍔℃墽琛屼綋');
}
function emitToolCall(res, id, callId, filePath) {
  const args = JSON.stringify({ path: filePath });
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'file_read', arguments: args } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}
function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

let subToolRequests = 0;
let subFinalizerRequests = 0;
const GOOD = JSON.stringify({ verdict: 'pass', confidence: 0.91, summary: 'budget finalizer produced a valid conclusion', findings: [] });
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
      const id = 'chatcmpl-budget-finalizer';
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      const isSub = isSubRequest(msgs);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (isSub && hasTools) {
        subToolRequests += 1;
        return emitToolCall(res, id, 'call_' + subToolRequests, path.join(HOME, 'evidence.txt'));
      }
      if (isSub && !hasTools && countToolMsgs(msgs) >= 2) {
        subFinalizerRequests += 1;
        return emitText(res, id, GOOD);
      }
      emitText(res, id, isSub ? 'unexpected sub response' : 'workflow launched');
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
  fs.writeFileSync(path.join(HOME, 'evidence.txt'), 'evidence for the verifier node');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    subagentMaxPerTurn: 12,
    subagentMaxConcurrent: 4,
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
    const created = await post(WP, '/api/sessions', { title: 'budget-finalizer', cwd: HOME }, hdr);
    const sid = created.session.id;
    const qualitySchema = { type: 'object', required: ['verdict', 'confidence', 'summary', 'findings'], properties: { verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } };

    const result = await post(WP, '/api/agent-workflow/launch', {
      token,
      sessionId: sid,
      nodes: [{ id: 'verify', task: 'VERIFY_WITH_TOOLS_THEN_SUMMARIZE', role: 'verifier', maxIters: 2, outputSchema: qualitySchema }],
    }, hdr);

    const node = result && result.results && result.results[0];
    console.log('  status:', node && node.status, '| subToolRequests:', subToolRequests, '| subFinalizerRequests:', subFinalizerRequests, '| error:', node && node.error);
    ok(subToolRequests === 2, 'fake sub-agent consumed the entire 2-iteration tool budget');
    ok(subFinalizerRequests === 1, 'runtime made one no-tool finalizer request after budget exhaustion');
    ok(result.ok === true && node.status === 'succeeded' && node.structuredResult && node.structuredResult.verdict === 'pass',
      'DAG node succeeds with structured output instead of failing at the iteration limit');
  } finally {
    kill(wb);
    fake.close();
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT WORKFLOW BUDGET FINALIZER: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
