// Agent 团队 composer mode: UI one-shot contract + live dual-driver prompt injection.
// Fully offline: fake OpenAI captures request bodies; fake Claude captures argv.
'use strict';
const { readServerSource } = require('./src-reader');
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const PUB = path.join(WB, 'app', 'public');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-team-mode-e2e');
const CAPTURE_DIR = path.join(HOME, 'captures');
const ARGV_CAPTURE = path.join(HOME, 'claude-argv.json');
const FAKE_PORT = 9194;
const WB_PORT = 9195;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (value, label) => { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };

function killTree(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* exited */ }
}
function get(port, pathname, headers = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 1500, headers }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}
function postJson(port, pathname, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (err) { reject(err); } });
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
function stream(payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => resolve(body));
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
async function waitHealth(port) {
  for (let i = 0; i < 50; i++) { const r = await get(port, '/health'); if (r.status === 200) return true; await sleep(120); }
  return false;
}
async function waitListening(port) {
  for (let i = 0; i < 50; i++) { const r = await get(port, '/health'); if (r.status > 0) return true; await sleep(120); }
  return false;
}
async function browserToken() {
  const r = await get(WB_PORT, '/');
  return (r.body.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}
function clearCaptures() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  for (const file of fs.readdirSync(CAPTURE_DIR)) if (/^req-\d+\.json$/.test(file)) fs.rmSync(path.join(CAPTURE_DIR, file), { force: true });
}
function capturedBodies() {
  if (!fs.existsSync(CAPTURE_DIR)) return [];
  return fs.readdirSync(CAPTURE_DIR).filter(file => /^req-\d+\.json$/.test(file)).sort()
    .map(file => JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, file), 'utf8')));
}
function capturedSystem() {
  return capturedBodies().flatMap(body => body.messages || []).filter(message => message.role === 'system').map(message => String(message.content || '')).join('\n');
}
function capturedUser() {
  return capturedBodies().flatMap(body => body.messages || []).filter(message => message.role === 'user').map(message => String(message.content || '')).join('\n');
}

(async () => {
  // Static UI contract: explicit toggle, one-shot request field, responsive state, and localizations.
  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
  ok(/id="agentTeamBtn"[^>]*aria-pressed="false"/.test(html), 'composer exposes an accessible Agent team toggle');
  ok((app.match(/let agentTeamTurnEnabled = false/g) || []).length === 1 && /if \(agentTeam\) \{ agentTeamTurnEnabled = false/.test(app), 'toggle is declared once, remains turn-local, and resets when sent');
  ok(/attachments: sentAttachments, agentTeam/.test(app), 'composer sends a structured agentTeam field without changing user text');
  ok(/agent-team-btn\[aria-pressed="true"\]/.test(css), 'active Agent team state has a visible pressed style');
  const serverModule = require(path.join(WB, 'app', 'server.js'));
  const capped = serverModule.appendResponseLanguagePolicy('x'.repeat(16000), { locale: 'en-US' }, 8000);
  ok(capped.length <= 8000 && capped.includes('<response-language-policy>'), 'language-policy compatibility wrapper keeps sub-agent prompts within the 8K cap');

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    subagentMaxConcurrent: 2,
    subagentMaxPerTurn: 4,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));

  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(FAKE_PORT)], {
    windowsHide: true, env: { ...process.env, FAKE_CAPTURE_DIR: CAPTURE_DIR },
  });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: path.join(WB, 'tools', 'fake-claude.js'), WCW_FAKE_ARGV_CAPTURE: ARGV_CAPTURE },
  });
  try {
    ok(await waitListening(FAKE_PORT), 'fake OpenAI provider starts');
    ok(await waitHealth(WB_PORT), 'workbench starts');
    const token = await browserToken();
    const headers = { 'x-wcw-token': token };
    ok(!!token, 'browser token available');

    const providerSession = (await postJson(WB_PORT, '/api/sessions', { title: 'provider-team', cwd: HOME }, headers)).session;
    clearCaptures();
    await stream({ sessionId: providerSession.id, message: 'research this topic', cwd: HOME, agentTeam: true }, headers);
    ok(!capturedSystem().includes('<agent-team-mode>') && capturedUser().includes('<agent-team-mode>'), 'OpenAI-compatible driver receives Agent team policy in the volatile user prefix');
    const providerMessages = capturedBodies().flatMap(body => body.messages || []);
    const providerUserMessages = providerMessages.filter(message => message.role === 'user').map(message => String(message.content || ''));
    ok(providerUserMessages.some(content => content.includes('research this topic')) &&
      providerUserMessages.some(content => content.includes('<agent-team-mode>') && content.includes('research this topic')),
      'Agent team policy prefixes the business user message without dropping its content');

    clearCaptures();
    await stream({ sessionId: providerSession.id, message: 'plain follow-up', cwd: HOME, agentTeam: false }, headers);
    ok(!capturedSystem().includes('<agent-team-mode>') && !capturedUser().includes('<agent-team-mode>'), 'OpenAI-compatible driver omits the policy on a normal turn');

    await postJson(WB_PORT, '/api/config', { activeProvider: '' }, headers);
    const claudeSession = (await postJson(WB_PORT, '/api/sessions', { title: 'claude-team', cwd: HOME }, headers)).session;
    await stream({ sessionId: claudeSession.id, message: 'audit this project', cwd: HOME, agentTeam: true }, headers);
    let argv = JSON.parse(fs.readFileSync(ARGV_CAPTURE, 'utf8'));
    let index = argv.indexOf('--append-system-prompt');
    ok(index >= 0 && String(argv[index + 1] || '').includes('<agent-team-mode>'), 'Claude CLI driver receives Agent team through --append-system-prompt');
    ok(index >= 0 && String(argv[index + 1] || '').includes('<response-language-policy>'), 'Claude CLI keeps the response-language policy alongside Agent team mode');

    await stream({ sessionId: claudeSession.id, message: 'plain follow-up', cwd: HOME, agentTeam: false }, headers);
    argv = JSON.parse(fs.readFileSync(ARGV_CAPTURE, 'utf8'));
    index = argv.indexOf('--append-system-prompt');
    ok(index >= 0 && !String(argv[index + 1] || '').includes('<agent-team-mode>'), 'Claude CLI driver omits the policy on a normal turn');

    // Server-side gating protects non-UI clients from requesting a mode whose tools were disabled.
    await postJson(WB_PORT, '/api/config', { activeProvider: 'fake', subagentMaxPerTurn: 0 }, headers);
    clearCaptures();
    await stream({ sessionId: providerSession.id, message: 'try disabled team mode', cwd: HOME, agentTeam: true }, headers);
    ok(!capturedSystem().includes('<agent-team-mode>') && !capturedUser().includes('<agent-team-mode>'), 'server ignores agentTeam when sub-agents are disabled');

    // Static guard: driverAuto MUST bypass agentTeam (verified via source-code pattern check).
    const serverSrc = readServerSource();
    ok(/const turnAgentTeam = !driverAuto && body\.agentTeam === true/.test(serverSrc),
      'server.js guards agentTeam behind !driverAuto to protect autonomous turns');
  } finally {
    killTree(wb); killTree(fake);
    await sleep(250);
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log('\nAGENT TEAM MODE E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
