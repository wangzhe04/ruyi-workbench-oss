'use strict';
// E2E: a quiet bridged tool stays visible/alive without model polling, then a provider steer interrupts it,
// closes the tool-call pair, and reaches the next model iteration without waiting for the original 30s sleep.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'ruyi-long-tool-liveness-steer');
const NOTIFY_CAPTURE = path.join(HOME, 'notify.jsonl');
const PID_CAPTURE = path.join(HOME, 'fake-mcp.pid');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const ok = (value, label) => { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
const kill = child => { if (child && child.pid) try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} };

function get(port, pathname, headers = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: 4000, headers }, res => {
      let body = ''; res.on('data', chunk => body += chunk); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(body); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function post(port, pathname, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body || {});
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let text = ''; res.on('data', chunk => text += chunk); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(text) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); }); req.write(raw); req.end();
  });
}
function stream(port, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload); const events = [];
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue;
          try { const event = JSON.parse(line); events.push(event); onEvent(event); } catch {}
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(raw); req.end();
  });
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
function pidAlive(pid) {
  try { return new RegExp('\\b' + pid + '\\b').test(cp.execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true })); }
  catch { return false; }
}

(async () => {
  const providerPort = await getFreePort(); const workbenchPort = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
    externalMcpServers: [{ id: 'fake', label: 'Fake MCP', command: process.execPath, args: [path.join(HERE, 'fake-mcp.js')], enabled: true, env: { FAKE_MCP_NOTIFY_CAPTURE: NOTIFY_CAPTURE, FAKE_MCP_PID_CAPTURE: PID_CAPTURE } }],
    bridgeExternalToolsToProvider: true,
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }));
  let fakeProvider = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { windowsHide: true, env: { ...process.env, FAKE_OPENAI_PORT: String(providerPort), FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'fake__slow_task', args: { ms: 30000 } }]) } });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(workbenchPort)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, RUYI_HOME: HOME, WCW_TOOL_HEARTBEAT_MS: '200', WCW_TURN_IDLE_MS: '1000' },
  });
  try {
    ok(await up(workbenchPort), 'workbench starts');
    const html = await get(workbenchPort, '/');
    const token = (String(html).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
    const headers = { 'x-wcw-token': token };
    const created = await post(workbenchPort, '/api/sessions', { title: 'long tool steer', cwd: HOME }, headers);
    const sid = created && created.body && created.body.session && created.body.session.id;
    ok(Boolean(sid), 'session created');

    let steerResponse = null; let steerScheduled = false;
    const startedAt = Date.now();
    const events = await stream(workbenchPort, { sessionId: sid, message: 'run the long tool and react to my steer', cwd: HOME }, event => {
      if (event.type === 'tool_use' && event.name === 'fake__slow_task' && !steerScheduled) {
        steerScheduled = true;
        setTimeout(() => { post(workbenchPort, '/api/steer', { sessionId: sid, text: 'stop waiting and continue now' }, headers).then(value => { steerResponse = value; }); }, 750);
      }
    });
    const elapsedMs = Date.now() - startedAt;
    for (let i = 0; i < 30 && !steerResponse; i++) await sleep(50);
    ok(steerResponse && steerResponse.body && steerResponse.body.ok === true, 'steer accepted while tool is running');
    ok(events.some(event => event.type === 'tool_progress' && event.name === 'fake__slow_task'), 'quiet tool emits transport-only liveness heartbeats');
    ok(!events.some(event => event.type === 'stderr' && /turn idle/.test(event.text || '')), 'heartbeats prevent the turn idle watchdog from firing');
    ok(elapsedMs < 10000, `turn continues promptly after steer (${elapsedMs}ms, not 30s)`);
    const interrupted = events.find(event => event.type === 'tool_result' && event.content && event.content.steerInterrupted === true);
    ok(Boolean(interrupted), 'tool_result records the steer interruption');
    ok(events.some(event => event.type === 'steered' && event.text === 'stop waiting and continue now'), 'queued steer reaches the next model iteration');
    ok(events.some(event => event.type === 'result'), 'turn completes with normal result event');

    const notifications = fs.existsSync(NOTIFY_CAPTURE) ? fs.readFileSync(NOTIFY_CAPTURE, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
    ok(notifications.some(row => row.method === 'notifications/cancelled' && row.params && row.params.reason === 'user_steer'), 'MCP receives notifications/cancelled reason=user_steer');
    const firstPid = fs.existsSync(PID_CAPTURE) ? Number(fs.readFileSync(PID_CAPTURE, 'utf8').split(/\r?\n/).filter(Boolean)[0]) : 0;
    for (let i = 0; i < 20 && pidAlive(firstPid); i++) await sleep(150);
    ok(firstPid > 0 && !pidAlive(firstPid), 'interrupted MCP process tree is reaped');

    // Repeat the same contract through the native PowerShell runner: its AbortSignal must kill the command
    // tree and settle promptly, not merely make the provider stop awaiting a still-running process.
    kill(fakeProvider); await sleep(250);
    fakeProvider = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], {
      windowsHide: true,
      env: { ...process.env, FAKE_OPENAI_PORT: String(providerPort), FAKE_TOOL_NAME: 'powershell_run', FAKE_TOOL_ARGS: JSON.stringify({ command: 'Start-Sleep -Seconds 30; Write-Output late', timeoutMs: 60000 }) },
    });
    for (let i = 0; i < 30 && !(await get(providerPort, '/v1/models')); i++) await sleep(100);
    const nativeSession = await post(workbenchPort, '/api/sessions', { title: 'native long tool steer', cwd: HOME }, headers);
    const nativeSid = nativeSession && nativeSession.body && nativeSession.body.session && nativeSession.body.session.id;
    let nativeSteer = null; let nativeSteerScheduled = false;
    const nativeStartedAt = Date.now();
    const nativeEvents = await stream(workbenchPort, { sessionId: nativeSid, message: 'run the long PowerShell command', cwd: HOME }, event => {
      if (event.type === 'tool_use' && event.name === 'powershell_run' && !nativeSteerScheduled) {
        nativeSteerScheduled = true;
        setTimeout(() => { post(workbenchPort, '/api/steer', { sessionId: nativeSid, text: 'interrupt the command and continue' }, headers).then(value => { nativeSteer = value; }); }, 750);
      }
    });
    for (let i = 0; i < 30 && !nativeSteer; i++) await sleep(50);
    const nativeElapsedMs = Date.now() - nativeStartedAt;
    ok(nativeSteer && nativeSteer.body && nativeSteer.body.ok === true, 'steer accepted during native PowerShell tool');
    ok(nativeElapsedMs < 10000, `native command is interrupted promptly (${nativeElapsedMs}ms, not 30s)`);
    ok(nativeEvents.some(event => event.type === 'tool_result' && event.content && event.content.steerInterrupted === true && event.content.interrupted === true), 'native tool_result confirms process interruption');
    ok(nativeEvents.some(event => event.type === 'steered' && event.text === 'interrupt the command and continue'), 'native-tool steer reaches the next model iteration');
  } catch (error) { failures++; console.error(error && error.stack || error); }
  finally { kill(wb); kill(fakeProvider); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  console.log('\nLONG TOOL LIVENESS/STEER E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
