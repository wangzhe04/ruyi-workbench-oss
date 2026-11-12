'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离，防 fake-mcp 夹具经 claude mcp add-json／Kimi 同步漏进真机 ~/.claude.json 与 ~/.kimi-code/mcp.json（见 lib 头注）
// E2E: a quiet bridged tool stays visible/alive without model polling, then a provider steer interrupts it,
// closes the tool-call pair, and reaches the next model iteration without waiting for the original 30s sleep.
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-long-tool-liveness-steer-'));
const NOTIFY_CAPTURE = path.join(HOME, 'notify.jsonl');
const PID_CAPTURE = path.join(HOME, 'fake-mcp.pid');
const CHILD_CAPTURE = path.join(HOME, 'original-mcp-children.jsonl');
const CHILD_PRELOAD = path.join(HOME, 'observe-original-mcp.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const ok = (value, label) => { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
const kill = child => { if (child && child.pid) try { killOwnTree(child); } catch {} };

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
async function up(port) { // 117q:预算 50×120ms=6s 小于本机冷启动实测 4.6-6.3s,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
function childObservation() {
  const rows = fs.existsSync(CHILD_CAPTURE) ? fs.readFileSync(CHILD_CAPTURE, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) : [];
  const latest = new Map();
  for (const row of rows) if (row.kind === 'child') latest.set(row.ordinal, row);
  return { rows: [...latest.values()], diagnostics: rows.filter(row => row.kind === 'observer-error') };
}
function originalConsumerClosed(row) {
  const f = row && row.facts;
  return Boolean(f && f.spawn && !f.error && f.exit && f.close
    && f.exit.code === f.close.code && f.exit.signal === f.close.signal
    && ['stdout', 'stderr'].every(name => f.streams[name]?.availability === 'original-pipe'
      && f.streams[name].end && f.streams[name].close && !f.streams[name].error));
}

(async () => {
  const providerPort = await getFreePort(); const workbenchPort = await getFreePort();
  // Observe the actual server-owned original child before spawn returns to the
  // product. The startup PID log also contains probes and cannot identify the
  // consumer of this slow tools/call. This preload never kills a process.
  fs.writeFileSync(CHILD_PRELOAD, String.raw`
'use strict';
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const expectedServer = ${JSON.stringify(path.join(WB, 'app', 'server.js'))};
if (path.resolve(process.argv[1] || '').toLowerCase() === expectedServer.toLowerCase()) {
  const { observeHeldChild } = require(${JSON.stringify(path.join(HERE, 'lib', 'external-bots-c2', 'actual-http-fixture.cjs'))});
  const output = ${JSON.stringify(CHILD_CAPTURE)}, target = ${JSON.stringify(path.join(HERE, 'fake-mcp.js'))};
  const expectedPidCapture = ${JSON.stringify(PID_CAPTURE)}, owned = new Set();
  let ordinal = 0, evidenceFailed = false;
  const diagnostic = error => {
    evidenceFailed = true;
    try { fs.appendFileSync(output, JSON.stringify({ kind: 'observer-error', code: String(error.code || ''), name: String(error.name || 'Error') }) + '\n'); } catch {}
  };
  const save = row => {
    try { fs.appendFileSync(output, JSON.stringify({ kind: 'child', ordinal: row.ordinal, facts: row.facts,
      calls: row.calls, cancellations: row.cancellations, evidenceFailed }) + '\n'); }
    catch (error) { diagnostic(error); }
  };
  const originalSpawn = cp.spawn;
  cp.spawn = function (...args) {
    const child = Reflect.apply(originalSpawn, this, args);
    try {
      const argv = args[1], options = args[2];
      if (!Array.isArray(argv) || !argv.some(arg => typeof arg === 'string' && path.resolve(arg).toLowerCase() === target.toLowerCase())
        || options?.env?.FAKE_MCP_PID_CAPTURE !== expectedPidCapture) return child;
      const row = observeHeldChild(child, 'actual-fake-mcp', { stdio: options.stdio });
      row.ordinal = ++ordinal; row.calls = []; row.cancellations = [];
      owned.add(row); // retain the original owner even if a later diagnostic write fails
      let pending = '';
      const originalWrite = child.stdin.write;
      child.stdin.write = function (...writeArgs) {
        try {
          const chunk = writeArgs[0];
          pending += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          let newline;
          while ((newline = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (message.method === 'tools/call') row.calls.push({ id: message.id, name: message.params?.name, ms: message.params?.arguments?.ms });
            if (message.method === 'notifications/cancelled') row.cancellations.push({ requestId: message.params?.requestId, reason: message.params?.reason });
            save(row);
          }
        } catch (error) { diagnostic(error); }
        // Preserve the actual receiver, arguments, return value and thrown error.
        return Reflect.apply(originalWrite, this, writeArgs);
      };
      for (const event of ['spawn', 'error', 'exit', 'close']) child.on(event, () => save(row));
      for (const name of ['stdout', 'stderr']) for (const event of ['end', 'close', 'error']) child[name]?.on(event, () => save(row));
      save(row);
    } catch (error) { diagnostic(error); }
    return child;
  };
}
`);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
    externalMcpServers: [{ id: 'fake', label: 'Fake MCP', command: process.execPath, args: [path.join(HERE, 'fake-mcp.js')], enabled: true, env: { FAKE_MCP_NOTIFY_CAPTURE: NOTIFY_CAPTURE, FAKE_MCP_PID_CAPTURE: PID_CAPTURE } }],
    bridgeExternalToolsToProvider: true,
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }));
  let fakeProvider = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { windowsHide: true, env: { ...process.env, FAKE_OPENAI_PORT: String(providerPort), FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'fake__slow_task', args: { ms: 30000 } }]) } });
  const wb = cp.spawn(process.execPath, ['--require', CHILD_PRELOAD, 'app/server.js', 'serve', '--port', String(workbenchPort)], {
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
        setTimeout(() => { post(workbenchPort, '/api/steer', { sessionId: sid, text: 'stop waiting and continue now', mode: 'interrupt' }, headers).then(value => { steerResponse = value; }); }, 750);
      }
    });
    const elapsedMs = Date.now() - startedAt;
    for (let i = 0; i < 30 && !steerResponse; i++) await sleep(50);
    ok(steerResponse && steerResponse.body && steerResponse.body.ok === true, 'steer accepted while tool is running');
    ok(events.some(event => event.type === 'tool_progress' && event.name === 'fake__slow_task'), 'quiet tool emits transport-only liveness heartbeats');
    ok(!events.some(event => event.type === 'stderr' && /turn idle/.test(event.text || '')), 'heartbeats prevent the turn idle watchdog from firing');
    // 墙钟上界豁免：防挂死宽界；插话在工具开始后 750 ms 发出，双负载实得 1197 ms，界 10000 ms（8 倍）；失败形态是等满慢工具的 30 s。
    ok(elapsedMs < 10000, `turn continues promptly after steer (${elapsedMs}ms, not 30s)`);
    const interrupted = events.find(event => event.type === 'tool_result' && event.content && event.content.steerInterrupted === true);
    ok(Boolean(interrupted), 'tool_result records the steer interruption');
    ok(events.some(event => event.type === 'steered' && event.text === 'stop waiting and continue now'), 'queued steer reaches the next model iteration');
    ok(events.some(event => event.type === 'result'), 'turn completes with normal result event');

    const notifications = fs.existsSync(NOTIFY_CAPTURE) ? fs.readFileSync(NOTIFY_CAPTURE, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
    ok(notifications.some(row => row.method === 'notifications/cancelled' && row.params && row.params.reason === 'user_steer'), 'MCP receives notifications/cancelled reason=user_steer');
    const actualConsumers = view => view.rows.filter(row => row.calls.some(call => call.name === 'slow_task' && call.ms === 30000));
    let observed = childObservation();
    for (let i = 0; i < 20 && !actualConsumers(observed).every(originalConsumerClosed); i++) { await sleep(150); observed = childObservation(); }
    const consumers = actualConsumers(observed), consumer = consumers[0];
    const request = consumer?.calls.find(call => call.name === 'slow_task' && call.ms === 30000);
    console.log('[original-MCP-consumer] ' + JSON.stringify({ home: HOME, consumers, diagnostics: observed.diagnostics }));
    ok(consumers.length === 1 && consumer.calls.filter(call => call.name === 'slow_task' && call.ms === 30000).length === 1
      && consumer.cancellations.some(cancel => cancel.requestId === request.id && cancel.reason === 'user_steer')
      && !consumer.evidenceFailed && observed.diagnostics.length === 0 && originalConsumerClosed(consumer),
      'interrupted actual MCP consumer has original exit/close and both pipe EOFs within the original 20×150ms window');

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
        setTimeout(() => { post(workbenchPort, '/api/steer', { sessionId: nativeSid, text: 'interrupt the command and continue', mode: 'interrupt' }, headers).then(value => { nativeSteer = value; }); }, 750);
      }
    });
    for (let i = 0; i < 30 && !nativeSteer; i++) await sleep(50);
    const nativeElapsedMs = Date.now() - nativeStartedAt;
    ok(nativeSteer && nativeSteer.body && nativeSteer.body.ok === true, 'steer accepted during native PowerShell tool');
    // 墙钟上界豁免：防挂死宽界；插话在命令开始后 750 ms 发出，双负载实得 1064 ms，界 10000 ms（9 倍）；失败形态是等满 Start-Sleep 30 s。
    ok(nativeElapsedMs < 10000, `native command is interrupted promptly (${nativeElapsedMs}ms, not 30s)`);
    ok(nativeEvents.some(event => event.type === 'tool_result' && event.content && event.content.steerInterrupted === true && event.content.interrupted === true), 'native tool_result confirms process interruption');
    ok(nativeEvents.some(event => event.type === 'steered' && event.text === 'interrupt the command and continue'), 'native-tool steer reaches the next model iteration');
    // Ordinary additions must preserve both native commands and MCP calls until they complete.
    for (const toolSpec of [
      { name: 'powershell_run', args: { command: 'Start-Sleep -Seconds 2; Write-Output PRESERVED_WORK', timeoutMs: 15000 } },
      { name: 'fake__slow_task', args: { ms: 2200 } },
    ]) {
      kill(fakeProvider); await sleep(250);
      fakeProvider = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], {
        windowsHide: true, env: { ...process.env, FAKE_OPENAI_PORT: String(providerPort), FAKE_TOOL_NAME: toolSpec.name, FAKE_TOOL_ARGS: JSON.stringify(toolSpec.args) },
      });
      for (let i = 0; i < 40 && !(await get(providerPort, '/v1/models')); i++) await sleep(100);
      const queuedSession = await post(workbenchPort, '/api/sessions', { title: 'preserve long work', cwd: HOME }, headers);
      const queuedSid = queuedSession.body.session.id;
      let sent = false, addition = null;
      const queuedEvents = await stream(workbenchPort, { sessionId: queuedSid, message: 'run tool', cwd: HOME }, event => {
        if (event.type !== 'tool_use' || event.name !== toolSpec.name || sent) return;
        sent = true;
        addition = post(workbenchPort, '/api/steer', { sessionId: queuedSid, text: '完成后请附上简短摘要' }, headers);
      });
      const response = addition && await addition;
      ok(response?.body?.mode === 'queue', toolSpec.name + ': default addition is queued');
      const reply = queuedEvents.find(event => event.type === 'tool_result');
      ok(reply && !reply.isError && !reply.content?.steerInterrupted, toolSpec.name + ': ordinary addition preserves successful tool completion');
      if (toolSpec.name === 'powershell_run') ok(reply?.content?.stdout?.includes('PRESERVED_WORK'), 'native work is actually completed, not merely left orphaned');
      ok(queuedEvents.some(event => event.type === 'steered' && event.text === '完成后请附上简短摘要'), 'addition reaches the model after tool completion');
    }
  } catch (error) { failures++; console.error(error && error.stack || error); }
  finally { kill(wb); kill(fakeProvider); await sleep(200); if (failures === 0) fs.rmSync(HOME, { recursive: true, force: true }); else console.log('[keep] ' + HOME); }
  console.log('\nLONG TOOL LIVENESS/STEER E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
