'use strict';
/*
 * Repro: a transient provider error (503) on a DAG sub-agent node fails the whole workflow,
 * because runSubAgentCore has NO failover / NO transient retry (unlike the parent turn's
 * streamWithFailover + toolsRejected retry). With the default failurePolicy 'block', one blip
 * kills the node and blocks downstream. This is the "时不时运行失败" root cause.
 *
 * Run: node dev-harness/agent-workflow-transient-repro.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-transient-repro');
const FP = 9137, WP = 9138;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

// Inline fake provider: 503 on the FIRST sub-agent request, then a clean quality-JSON success.
// A sub-agent request is identified by its system prompt carrying the 子任务执行体 identity marker.
const GOOD = JSON.stringify({ verdict: 'pass', confidence: 0.9, summary: 'verified', findings: [] });
let subHits = 0, parentHits = 0;
const fake = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const sys = JSON.stringify(parsed.messages || []).toLowerCase();
      const isSub = sys.includes('子任务执行体');
      if (isSub) {
        subHits += 1;
        if (subHits === 1) {
          // transient gateway blip - the parent turn would failover/retry; the sub-agent path does not.
          res.writeHead(503, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'transient 503 (gateway)', type: 'server_error' } }));
        }
      } else {
        parentHits += 1;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const content = isSub ? GOOD : 'workflow launched';
      const sse = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      sse({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.end();
    });
    return;
  }
  res.writeHead(404); res.end();
});

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
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
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const qualitySchema = { type: 'object', required: ['verdict', 'confidence', 'summary', 'findings'], properties: { verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxPerTurn: 12, subagentMaxConcurrent: 4, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake' }));

  await new Promise(r => fake.listen(FP, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'transient', cwd: HOME }, hdr);
    const sid = created.session.id;

    // Single-node DAG, DEFAULT failurePolicy (block). The sub-agent's first provider call 503s,
    // second would succeed. A resilient runtime retries the transient 503 and the node succeeds.
    subHits = 0;
    const result = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid,
      nodes: [{ id: 'worker', task: 'DO_WORK', outputSchema: qualitySchema }],
    }, hdr);

    console.log('  node status:', result && result.results && result.results[0] && result.results[0].status, '| subHits:', subHits, '| error:', result && result.results && result.results[0] && result.results[0].error);
    ok(result.ok === true && result.results[0].status === 'succeeded',
      'transient 503 on a sub-agent node is retried and the node succeeds (parent-turn parity)');
    ok(subHits >= 2, 'the sub-agent actually retried the transient request (not just died on first 503)');
    const runsAfter = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
    const persisted = runsAfter && Array.isArray(runsAfter.runs) && runsAfter.runs.find(r => r.id === result.runId);
    const pnode = persisted && Array.isArray(persisted.nodes) && persisted.nodes.find(n => n.id === 'worker');
    ok(pnode && pnode.iters === 1,
      'a no-tool conclusion still records the successful provider iteration (iters=1)');
  } finally {
    kill(wb); fake.close(); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT WORKFLOW TRANSIENT REPRO: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
