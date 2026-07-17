(async () => {
'use strict';
/*
 * Repro (Claude engine): a transient error (503/overloaded) surfacing from the Claude CLI on a DAG
 * sub-agent node previously failed the whole workflow, because runClaudeSubAgentOnce had NO inline
 * transient retry (unlike the OpenAI path's runSubAgentCore, fixed in v1.4.5). With the default
 * failurePolicy 'block', one blip killed the node and blocked downstream. This is the Claude-engine
 * half of the "分发出去的子agent经常性失败" root cause - the sibling of agent-workflow-transient-repro.e2e.js
 * (which covers the OpenAI-provider path).
 *
 * Run: node dev-harness/agent-workflow-claude-transient-repro.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-claude-transient-repro');
const WP = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

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
  const counterFile = path.join(HOME, 'counter.txt');
  const fakeClaude = path.join(__dirname, 'fake-claude-transient.js');
  const qualitySchema = { type: 'object', required: ['verdict', 'confidence', 'summary', 'findings'], properties: { verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } };
  // No Provider configured - the Claude-CLI engine runs the node standalone (claudeCliUsable via WCW_FAKE_CLAUDE),
  // proving the dual-engine DAG no longer needs an OpenAI-compatible Provider just to retry a transient blip.
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxConcurrent: 4, agentWorkflowMaxNodes: 32 }));

  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: fakeClaude, WCW_FAKE_TRANSIENT_COUNTER: counterFile }, windowsHide: true });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'claude-transient', cwd: HOME }, hdr);
    const sid = created.session.id;

    // Single Claude-engine DAG node, DEFAULT failurePolicy (block). The CLI's first spawn 503s (overloaded),
    // second would succeed. A resilient runtime retries the transient exit and the node succeeds.
    fs.writeFileSync(counterFile, '0');
    const result = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid,
      nodes: [{ id: 'worker', task: 'DO_WORK', engine: 'claude', outputSchema: qualitySchema }],
    }, hdr);

    const counter = (() => { try { return Number(fs.readFileSync(counterFile, 'utf8')) || 0; } catch { return 0; } })();
    console.log('  node status:', result && result.results && result.results[0] && result.results[0].status, '| fake spawns:', counter, '| error:', result && result.results && result.results[0] && result.results[0].error);
    ok(result && result.ok === true && result.results && result.results[0] && result.results[0].status === 'succeeded',
      'transient 503 from the Claude CLI on a sub-agent node is retried and the node succeeds (OpenAI-path parity)');
    ok(counter >= 2, 'the Claude CLI was actually re-spawned after the transient exit (not just died on first 503)');
  } finally {
    kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nAGENT WORKFLOW CLAUDE TRANSIENT REPRO: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
