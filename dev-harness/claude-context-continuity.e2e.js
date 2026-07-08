'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-claude-context-continuity');
const FAKE = path.join(WB, 'tools', 'fake-claude.js');
const PORT = 9075;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

function kill(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}
async function stop(child) {
  if (!child) return;
  kill(child);
  if (child.exitCode == null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
  await sleep(150);
}
function health() {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/health', timeout: 800 }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function waitHealth() { for (let i = 0; i < 50; i++) { const h = await health(); if (h) return h; await sleep(120); } return null; }
function stream(body) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { if (line.trim()) events.push(JSON.parse(line)); } catch {} } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
function getSession(id) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/sessions/' + encodeURIComponent(id), timeout: 3000 }, res => {
      let body = ''; res.on('data', c => body += c); res.on('end', () => { try { resolve(JSON.parse(body).session); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
  });
}
function start(capture) {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE, WCW_FAKE_STDIN_CAPTURE: capture },
    windowsHide: true,
  });
  child.stderr.on('data', d => String(d).split(/\r?\n/).forEach(line => line.trim() && console.error('[workbench] ' + line.trim())));
  return child;
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, activeProvider: '', permissionMode: 'bypass', engineMode: 'interactive', includePartialMessages: false }), 'utf8');
  const cap1 = path.join(HOME, 'stdin-1.txt');
  let wb = start(cap1);
  try {
    ok(!!(await waitHealth()), 'first Claude workbench process starts');
    const first = await stream({ message: 'remember continuity-marker-731' });
    const sid = (first.find(e => e.type === 'session') || {}).session?.id;
    ok(!!sid, 'workbench session created');
    const firstSession = await getSession(sid);
    const firstClaudeId = firstSession && firstSession.claudeSessionId;
    ok(!!firstClaudeId, 'first CLI session id persisted');

    await stop(wb);
    const cap2 = path.join(HOME, 'stdin-2.txt');
    wb = start(cap2);
    ok(!!(await waitHealth()), 'restarted Claude workbench process starts');
    const second = await stream({ sessionId: sid, message: 'which marker should you remember?' });
    const meta = second.find(e => e.type === 'meta');
    ok(meta && meta.historyRecoveryInjected === true, 'restart turn reports bounded history recovery');
    const envelope = JSON.parse(fs.readFileSync(cap2, 'utf8'));
    const sentText = envelope.message.content[0].text;
    ok(sentText.includes('continuity-marker-731') && sentText.includes('<workbench_history_recovery>'), 'prior chat is included in the restart recovery prompt');
    ok(sentText.includes('<current_user_message>') && sentText.includes('which marker'), 'current user message remains separately delimited');
    const secondSession = await getSession(sid);
    ok(secondSession.claudeSessionId && secondSession.claudeSessionId !== firstClaudeId, 'silent CLI session-id change replaces the stale binding');
    const lastUsage = [...secondSession.messages].reverse().find(m => m && m.usage);
    ok(lastUsage && lastUsage.usage.contextTokens > 0, 'Claude context occupancy remains persisted for the frontend meter');
  } finally {
    await stop(wb); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nCLAUDE CONTEXT CONTINUITY E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
