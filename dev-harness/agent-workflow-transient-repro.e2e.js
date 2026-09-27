require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
/*
 * Repro: a transient provider error (503) on a DAG sub-agent node fails the whole workflow,
 * because runSubAgentCore has NO failover / NO transient retry (unlike the parent turn's
 * streamWithFailover + toolsRejected retry). With the default failurePolicy 'block', one blip
 * kills the node and blocks downstream. This is the "时不时运行失败" root cause.
 *
 * Run: node dev-harness/agent-workflow-transient-repro.e2e.js
 */
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-transient-repro');
const WP = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('AGENT WORKFLOW TRANSIENT REPRO');
const { ok } = t;
function kill(p) { if (p && p.pid) try { killOwnTree(p); } catch {} }

// Scripted fake provider (lib/fake-openai-provider): 503 on the FIRST sub-agent request, then a clean quality-JSON success.
// A sub-agent request is identified by its system prompt carrying the 子任务执行体 identity marker.
const GOOD = JSON.stringify({ verdict: 'pass', confidence: 0.9, summary: 'verified', findings: [] });
let subHits = 0, parentHits = 0;
const fake = await startFakeProvider({
  handler(req) {
    const sys = JSON.stringify(req.messages).toLowerCase();
    const isSub = sys.includes('子任务执行体');
    if (isSub) {
      subHits += 1;
      if (subHits === 1) {
        // transient gateway blip - the parent turn would failover/retry; the sub-agent path does not.
        return { status: 503, json: { error: { message: 'transient 503 (gateway)', type: 'server_error' } } };
      }
    } else {
      parentHits += 1;
    }
    // done:false —— 与修前的内联假件同形:流末不发 [DONE],直接 end。
    return { frames: textFrames(isSub ? GOOD : 'workflow launched'), done: false };
  },
});
const FP = fake.port;

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
async function up(port) { // 117q:预算 50×120ms=6s 小于本机冷启动实测 4.6-6.3s,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const qualitySchema = { type: 'object', required: ['verdict', 'confidence', 'summary', 'findings'], properties: { verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxPerTurn: 12, subagentMaxConcurrent: 4, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake' }));

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
    kill(wb); await fake.close(); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  t.done();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
