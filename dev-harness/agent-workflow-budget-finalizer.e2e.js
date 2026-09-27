'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
/*
 * Repro: DAG sub-agent nodes used to fail when the model spent its whole maxIters
 * budget calling tools and never got a final no-tool turn to summarize. Real
 * Reviewer/Verifier runs hit this on medium-sized repos: "子代理已达迭代上限 N 轮".
 *
 * Run: node dev-harness/agent-workflow-budget-finalizer.e2e.js
 */
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-budget-finalizer');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = createRunner('AGENT WORKFLOW BUDGET FINALIZER');
const { ok } = t;
function kill(p) { if (p && p.pid) try { killOwnTree(p); } catch {} }
function countToolMsgs(msgs) { return (msgs || []).filter(m => m && m.role === 'tool').length; }
function isSubRequest(msgs) {
  const sys = String(((msgs || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体') || sys.includes('瀛愪换鍔℃墽琛屼綋');
}

let subToolRequests = 0;
let subFinalizerRequests = 0;
const GOOD = JSON.stringify({ verdict: 'pass', confidence: 0.91, summary: 'budget finalizer produced a valid conclusion', findings: [] });
const FRAME_ID = { id: 'chatcmpl-budget-finalizer' };
// 脚本化假 provider(lib/fake-openai-provider):子代理带工具时一直要工具,工具预算耗尽后的无工具收尾请求回结论 JSON。
function handleChat(req) {
  const msgs = req.messages;
  const hasTools = req.tools.length > 0;
  const isSub = isSubRequest(msgs);
  if (isSub && hasTools) {
    subToolRequests += 1;
    return toolCallFrames('file_read', { path: path.join(HOME, 'evidence.txt') }, 'call_' + subToolRequests, FRAME_ID);
  }
  if (isSub && !hasTools && countToolMsgs(msgs) >= 2) {
    subFinalizerRequests += 1;
    return textFrames(GOOD, FRAME_ID);
  }
  return textFrames(isSub ? 'unexpected sub response' : 'workflow launched', FRAME_ID);
}

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
async function up(port) { // 117q:预算 50×120ms=6s 小于本机冷启动实测 4.6-6.3s,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }

(async () => {
  const WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'evidence.txt'), 'evidence for the verifier node');
  const fake = await startFakeProvider({ handler: handleChat });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    subagentMaxPerTurn: 12,
    subagentMaxConcurrent: 4,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));

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
    await fake.close();
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  t.done();
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
