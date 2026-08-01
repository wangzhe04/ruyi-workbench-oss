#!/usr/bin/env node
'use strict';

// Wave 82 real-browser acceptance: a live multi-Agent Run appears as a crew/stage graph in Preview,
// Pass a note reaches the selected node through steer_node, and a pool proposal opens the Wave 81 drawer.
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.log('FAIL ' + label); }
};
function browserPath() {
  return [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].find(file => fs.existsSync(file)) || '';
}
function request(port, pathname, body = null, token = '') {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body == null ? 'GET' : 'POST', timeout: 20000, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: response.statusCode, text, json }); });
    });
    req.on('error', reject); req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (raw) req.write(raw); req.end();
  });
}
async function waitForHttp(port, pathname, predicate, attempts = 180, token = '') {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, pathname, null, token).catch(() => null);
    if (result && predicate(result)) return result;
    await sleep(60);
  }
  return null;
}
function killTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch {}
}
function sse(res, value) { res.write('data: ' + JSON.stringify(value) + '\n\n'); }
function ownTask(messages) {
  const user = (messages || []).find(message => message && message.role === 'user');
  return String(user && user.content || '').split('以下是前序节点结果')[0];
}
function isSubRequest(messages) {
  const system = String(((messages || []).find(message => message && message.role === 'system') || {}).content || '');
  return system.includes('子任务执行体') || system.includes('瀛愪换鍔℃墽琛屼綋');
}
function toolResults(messages) { return (messages || []).filter(message => message && message.role === 'tool').length; }
function emitText(res, id, value) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: value }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
async function emitTool(res, id, callId, name, args, delay = 0) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
  if (delay) await sleep(delay);
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
async function startProvider(port, capturedBodies) {
  const server = http.createServer((req, res) => {
    if ((req.url || '').includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fake-model"}]}'); }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = ''; req.on('data', chunk => { raw += chunk; });
    req.on('end', async () => {
      capturedBodies.push(raw);
      let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const task = ownTask(messages); const done = toolResults(messages); const id = 'chatcmpl-wave82';
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (!isSubRequest(messages)) return emitText(res, id, 'accepted');
      if (/PROPOSER/.test(task)) {
        if (done === 0) return emitTool(res, id, 'call_proposal', 'propose_task', {
          task: '检查最终交付中的无障碍细节', roleId: 'reviewer', reason: '交付前需要额外核对', dependsOn: ['proposer'],
        });
        return emitText(res, id, '提案已交给工头审阅。');
      }
      if (/KEEPER/.test(task)) {
        if (done < 12) return emitTool(res, id, 'call_keep_' + done, 'file_read', { path: `wave82-probe-${done}.txt` }, 180);
        return emitText(res, id, '长跑队员已完成。');
      }
      return emitText(res, id, '后续队员完成。');
    });
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; this.exceptions = []; }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message; try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.method === 'Runtime.exceptionThrown') this.exceptions.push(message.params?.exceptionDetails?.text || 'runtime exception');
        if (!message.id || !this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id); this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, 5000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
    return result.result && result.result.value;
  }
  close() { try { this.socket?.close(); } catch {} }
}
async function waitForTarget(port, appUrl) {
  for (let i = 0; i < 180; i++) {
    const result = await request(port, '/json/list').catch(() => null);
    const target = result?.json?.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target?.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}
async function waitForEval(cdp, expression, attempts = 420) {
  for (let i = 0; i < attempts; i++) {
    try { const value = await cdp.evaluate(expression); if (value) return value; } catch {}
    await sleep(30);
  }
  return null;
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wave82-'));
const home = path.join(tempRoot, 'home'); const profile = path.join(tempRoot, 'profile');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9, permissionMode: 'bypass', theme: 'light', uiMode: 'simple',
  defaultWorkspace: home, activeProvider: 'fake', subagentMaxConcurrent: 2,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model' }],
}), 'utf8');
let provider = null, workbench = null, browser = null, cdp = null;
const capturedBodies = [];
try {
  provider = await startProvider(providerPort, capturedBodies);
  workbench = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, RUYI_HOME: home, WCW_POOL_GRACE_MS: '30000' },
  });
  ok(Boolean(await waitForHttp(appPort, '/health', result => result.status === 200)), 'A1 workbench and fake provider started');
  const token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token;
  // The crew contract does not depend on repository discovery. Keep the fixture workspace tiny so role/skill
  // discovery cannot consume the narrow overlap between a running keeper and a freshly proposed task.
  const created = await request(appPort, '/api/sessions', { title: 'Wave 82 crew journey', cwd: home }, token);
  const sessionId = created.json?.session?.id || '';
  const mission = await request(appPort, '/api/mission', { action: 'start', sessionId, mission: {
    goal: 'Supervise a live crew graph and review proposed work', autoMode: 'off', milestones: [{ id: 'crew', desc: 'Supervise the crew', status: 'pending' }],
  } }, token);
  ok(Boolean(sessionId) && mission.status === 200, 'A2 authoritative Mission created');

  const executable = browserPath(); ok(Boolean(executable), 'A3 Edge/Chrome found'); if (!executable) throw new Error('browser unavailable');
  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync', '--disable-background-networking', '--force-device-scale-factor=1', '--window-size=1440,1000', '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl); ok(Boolean(target), 'A4 browser target available'); if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl); await cdp.connect(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, `window.state?.currentSession?.id === '${sessionId}' && typeof document.getElementById('cfgShellMode')?.onchange === 'function'`)), 'A5 classic shell hydrated the Mission session');

  const launched = await request(appPort, '/api/agent-workflow/launch', { token, sessionId, async: true, poolPolicy: 'manual', nodes: [
    { id: 'keeper', task: 'KEEPER 长跑队员，持续核对资料', toolTier: 'read' },
    { id: 'proposer', task: 'PROPOSER 提出额外验收工序', toolTier: 'read' },
    { id: 'handoff', task: '在资料核对后整理交付', toolTier: 'read', dependsOn: ['keeper'] },
  ] }, token);
  const runId = launched.json?.runId || '';
  ok(launched.status === 200 && /^run_/.test(runId), 'A6 live multi-Agent Run launched');
  const live = await waitForHttp(appPort, `/api/agent-runs?sessionId=${encodeURIComponent(sessionId)}`, result => {
    const run = result.json?.runs?.find(item => item.id === runId);
    return run?.live && run.nodes?.some(node => node.id === 'keeper' && node.status === 'running')
      && run.taskPool?.some(item => item.status === 'proposed');
  }, 240, token);
  if (!live) {
    ok(false, 'A7 keeper is running while a pool proposal waits');
    const diagnostic = await request(appPort, `/api/agent-runs?sessionId=${encodeURIComponent(sessionId)}`, null, token).catch(() => null);
    console.log('INFO A7 run=' + JSON.stringify(diagnostic?.json?.runs?.find(item => item.id === runId) || diagnostic?.json || null));
    const error = new Error('Wave 82 fixture never reached the expected running/proposed overlap');
    error.acceptanceReported = true;
    throw error;
  }
  ok(true, 'A7 keeper is running while a pool proposal waits');

  const snapshotResult = await request(appPort, '/api/missions/' + encodeURIComponent(sessionId), null, token);
  const graphRun = snapshotResult.json?.snapshot?.runs?.find(item => item.id === runId);
  ok(graphRun?.nodes?.length === 3 && graphRun.nodes.some(node => node.id === 'keeper' && node.steerable)
    && graphRun.proposals?.length === 1 && !('result' in graphRun.nodes[0]) && !('progressLog' in graphRun.nodes[0]),
    'B1 Mission snapshot exposes compact live graph facts without large node payloads');

  await cdp.evaluate(`(() => { const select = document.getElementById('cfgShellMode'); select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const graph = await waitForEval(cdp, `(() => {
    const seal = document.querySelector('.preview-seal[data-mission-id="${sessionId}"]');
    if (document.getElementById('previewMain')?.dataset.view === 'home' && seal) seal.click();
    const tab = document.querySelector('.preview-lens-tab.lens-crew');
    if (tab && !tab.disabled && tab.getAttribute('aria-selected') !== 'true') { tab.click(); return null; }
    const lens = document.querySelector('.preview-crew-lens:not([hidden])');
    if (!lens) return null;
    return { members: lens.querySelectorAll('.preview-crew-member:not(.is-proposal)').length,
      proposals: lens.querySelectorAll('.preview-crew-member.is-proposal').length,
      stages: lens.querySelectorAll('.preview-crew-lane').length,
      foreman: lens.querySelector('.preview-crew-foreman')?.textContent || '' };
  })()`, 520);
  ok(graph && graph.members === 3 && graph.proposals === 1 && graph.stages >= 2 && /工头/.test(graph.foreman),
    'B2 Preview renders three crew members, dependency stages, one proposed stage, and the foreman sentence');

  const noteSent = await cdp.evaluate(`(() => {
    const member = document.querySelector('.preview-crew-member[data-crew-node-id="keeper"]'); if (!member) return false; member.click();
    const input = document.querySelector('.preview-crew-handoff textarea'); const send = document.querySelector('.preview-crew-steer-actions button.primary');
    if (!input || !send || input.disabled) return false; input.value = 'WAVE82_STEER 请优先核对边界'; input.dispatchEvent(new Event('input', { bubbles: true })); send.click(); return true;
  })()`);
  ok(noteSent === true, 'C1 a running crew member exposes an inline Pass-a-note composer');
  ok(Boolean(await waitForEval(cdp, `/已送达|已排队/.test(document.querySelector('.preview-crew-steer-state')?.textContent || '')`, 300)),
    'C2 the graph reports authoritative delivery semantics');
  let capturedSteer = false;
  for (let i = 0; i < 160 && !capturedSteer; i++) { capturedSteer = capturedBodies.some(body => body.includes('[编排者插话] WAVE82_STEER')); if (!capturedSteer) await sleep(50); }
  ok(capturedSteer, 'C3 the note reaches a later provider request for exactly the selected node');

  const proposalOpened = await cdp.evaluate(`(() => { const node = document.querySelector('.preview-crew-member.is-proposal'); if (!node) return false; node.click(); return true; })()`);
  ok(proposalOpened === true && Boolean(await waitForEval(cdp, `(() => { const drawer = document.getElementById('previewNeedsDrawer'); const card = drawer?.querySelector('.preview-intervention-card[data-intervention-type="pool"]'); return !drawer?.hidden && !!card && card.dataset.interventionId === document.querySelector('.preview-crew-member.is-proposal')?.dataset.interventionId; })()`)),
    'D1 the dotted proposed stage opens its exact pool Intervention in the global drawer');
  await cdp.evaluate(`document.getElementById('previewNeedsCloseBtn')?.click()`);

  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const narrow = await waitForEval(cdp, `new Promise(resolve => requestAnimationFrame(() => { const stage = document.querySelector('.preview-crew-stage'); const lanes = [...stage.querySelectorAll('.preview-crew-lane')]; resolve({ page: document.documentElement.scrollWidth <= innerWidth + 1, stage: stage.scrollWidth <= stage.clientWidth + 1, vertical: lanes.length < 2 || lanes[1].getBoundingClientRect().top > lanes[0].getBoundingClientRect().bottom }); }))`);
  ok(narrow && narrow.page && narrow.stage && narrow.vertical, 'D2 the crew graph becomes a bounded vertical flow at 390px');
  ok(cdp.exceptions.length === 0, 'E1 browser recorded no uncaught runtime exception');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error)); if (!error?.acceptanceReported) failures += 1;
} finally {
  if (cdp) cdp.close(); killTree(browser); killTree(workbench);
  if (provider) {
    provider.close();
    if (typeof provider.closeAllConnections === 'function') provider.closeAllConnections();
  }
  await sleep(150); fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log(`\nPRETENDER CREW LENS E2E: ${failures ? `FAIL (${failures})` : 'ALL PASS'}`);
process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
