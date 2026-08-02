#!/usr/bin/env node
'use strict';

// Wave 81 real-browser acceptance: global Needs-you decisions, second confirmation, question
// no-default selection, classic prompt retirement, and the stopped-task hand-off card.
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
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
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
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (raw) req.write(raw);
    req.end();
  });
}

async function waitForHttp(port, pathname, predicate, attempts = 140, token = '') {
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
  } catch { /* already exited */ }
}

async function startProvider(port) {
  const server = http.createServer(async (req, res) => {
    if ((req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = [...messages].reverse().find(message => message && message.role === 'user');
    const hasQuestionAnswer = messages.some(message => message && message.role === 'tool' && /Vue/.test(String(message.content || '')));
    const hasPermissionResult = messages.some(message => message && message.role === 'tool' && message.tool_call_id === 'call_wave81_permission');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const sse = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
    if (/\bask\b/i.test(String(lastUser && lastUser.content || '')) && !hasQuestionAnswer) {
      const args = JSON.stringify({ questions: [{
        id: 'framework', header: 'Framework', question: 'Which framework should continue?', answerMode: 'single',
        options: [{ id: 'react', label: 'React', description: 'Use React' }, { id: 'vue', label: 'Vue', description: 'Use Vue' }],
      }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'React has the larger ecosystem; Vue is the lighter progressive choice. ' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_wave81_question', type: 'function', function: { name: 'request_user_input', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else if (hasQuestionAnswer) {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Got Vue; continuing with the selected framework.' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    } else if (/\bhold\b/i.test(String(lastUser && lastUser.content || '')) && !hasPermissionResult) {
      const args = JSON.stringify({ command: 'Write-Output wave81-permission-scope' });
      sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_wave81_permission', type: 'function', function: { name: 'powershell_run', arguments: '' } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      sse({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Permission phase complete.' }, finish_reason: null }] });
      sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server;
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message; try { message = JSON.parse(String(event.data)); } catch { return; }
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
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
    return result.result && result.result.value;
  }
  close() { try { this.socket?.close(); } catch { /* ignore */ } }
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
    try { const value = await cdp.evaluate(expression); if (value) return value; } catch { /* context swap */ }
    await sleep(30);
  }
  return null;
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wave81-'));
const home = path.join(root, 'home');
const profile = path.join(root, 'profile');
fs.mkdirSync(home);
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 9, version: '2.4.0', permissionMode: 'default', permissionTimeoutMs: 30000,
  theme: 'light', uiMode: 'simple', defaultWorkspace: ROOT, includeWorkbenchMcp: true,
  activeProvider: 'fake', engineMode: 'interactive',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}), 'utf8');

let provider = null, server = null, browser = null, cdp = null;
let serverOutput = '';
try {
  provider = await startProvider(providerPort);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { serverOutput += String(chunk); });
  server.stderr.on('data', chunk => { serverOutput += String(chunk); });
  ok(Boolean(await waitForHttp(appPort, '/health', result => result.status === 200)), 'A1 workbench and fake provider started');
  const token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token;
  const sessionResponse = await request(appPort, '/api/sessions', { title: 'Wave 81 decision journey', cwd: ROOT }, token);
  const sessionId = sessionResponse.json?.session?.id || '';
  ok(Boolean(sessionId), 'A2 authoritative session created');
  const missionStart = await request(appPort, '/api/mission', {
    action: 'start', sessionId,
    mission: { goal: 'Verify the global decision drawer and stopped-task hand-off', autoMode: 'off', milestones: [
      { id: 'm1', desc: 'Handle permission safely', status: 'pending' },
      { id: 'm2', desc: 'Answer without a default', status: 'pending' },
    ] },
  }, token);
  ok(missionStart.status === 200 && missionStart.json?.ok === true, 'A3 Mission started');

  const executable = browserPath();
  ok(Boolean(executable), 'A4 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');
  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--disable-background-networking', '--force-device-scale-factor=1', '--window-size=1440,1000',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A5 browser target available');
  if (!target) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, `window.state?.currentSession?.id === '${sessionId}' && typeof document.getElementById('cfgShellMode')?.onchange === 'function'`)),
    'A6 classic layout opened the Mission session');

  await cdp.evaluate(`(() => { const input = document.getElementById('promptInput'); input.value = 'hold permission'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('sendBtn').click(); return true; })()`);
  ok(Boolean(await waitForEval(cdp, 'window.state?.streaming === true')), 'B1 live turn started');
  const classicPermission = await waitForEval(cdp, `!!document.querySelector('.permission-modal[data-session-id="${sessionId}"]')`);
  ok(Boolean(classicPermission),
    'B2 classic permission prompt opened with a live consumer');
  if (!classicPermission) {
    const debugPage = await cdp.evaluate(`({ streaming: window.state?.streaming, text: document.getElementById('messages')?.textContent.slice(-1200), modals: [...document.querySelectorAll('.modal-backdrop')].map(node => ({ cls: node.className, sid: node.dataset.sessionId, id: node.dataset.interventionId })) })`);
    const debugInterventions = await request(appPort, '/api/interventions/' + encodeURIComponent(sessionId) + '?limit=100', null, token);
    console.log('DEBUG B2 page=' + JSON.stringify(debugPage) + ' interventions=' + JSON.stringify(debugInterventions.json) + ' server=' + serverOutput.slice(-2000));
    throw new Error('classic permission prompt did not open');
  }
  await cdp.evaluate(`(() => { const select = document.getElementById('cfgShellMode'); select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const permissionCard = await waitForEval(cdp, `(() => {
    if (document.documentElement.getAttribute('data-shell-mode') !== 'preview') return null;
    const fact = document.getElementById('previewNeedsFact');
    if (!fact || Number(document.getElementById('previewNeedsValue')?.textContent || 0) < 1) return null;
    fact.click();
    const card = document.querySelector('.preview-intervention-card[data-intervention-type="permission"]');
    if (!card) return null;
    return { scope: card.querySelector('.preview-permission-scope')?.textContent || '', confirm: !!card.querySelector('.preview-decision-confirm') };
  })()`);
  ok(permissionCard && permissionCard.scope.includes('wave81-permission-scope') && permissionCard.confirm === false,
    'B3 global drawer preserves the concrete permission scope and never starts approved');
  await cdp.evaluate(`document.querySelector('.preview-intervention-card[data-intervention-type="permission"] .preview-intervention-actions button.primary').click()`);
  ok(Boolean(await waitForEval(cdp, `!!document.querySelector('.preview-intervention-card[data-intervention-type="permission"] .preview-decision-confirm')`)),
    'B4 Allow opens an explicit second confirmation');
  const pendingAfterFirstClick = await request(appPort, '/api/interventions/' + encodeURIComponent(sessionId) + '?limit=100', null, token);
  ok((pendingAfterFirstClick.json?.interventions || []).some(item => item.type === 'permission' && item.status === 'pending'),
    'B5 first approval click does not deliver the decision');
  await cdp.evaluate(`document.querySelector('.preview-intervention-card[data-intervention-type="permission"] .preview-decision-confirm button.primary').click()`);
  const permissionTerminal = await waitForHttp(appPort, '/api/interventions/' + encodeURIComponent(sessionId) + '?limit=100', result =>
    (result.json?.interventions || []).some(item => item.type === 'permission' && item.status === 'allowed'), 140, token);
  ok(Boolean(permissionTerminal), 'B6 confirmed approval reaches the unified command core');
  ok(Boolean(await waitForEval(cdp, `document.getElementById('previewNeedsValue')?.textContent === '0' && !document.querySelector('.permission-modal')`)),
    'B7 Preview count and hidden classic prompt retire after the cross-shell decision');
  await cdp.evaluate(`document.getElementById('previewClassicBtn').click()`);
  ok(Boolean(await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'classic' && !document.querySelector('.permission-modal')`)),
    'B8 returning to classic shows no stale permission prompt');
  await cdp.evaluate(`document.getElementById('openPreviewBtn').click()`);
  ok(Boolean(await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'preview' && !!document.getElementById('previewNewMissionBtn')`)),
    'B8b classic sidebar returns directly to the task desk');
  await cdp.evaluate(`(() => { document.getElementById('previewNewMissionBtn').click(); const input = document.getElementById('previewDispatchInput'); return !!input && input.value === '' && document.activeElement === input; })()`);
  ok(Boolean(await waitForEval(cdp, `document.getElementById('previewMain')?.dataset.view === 'home' && document.activeElement?.id === 'previewDispatchInput'`)),
    'B8c dock plus opens a clean, focused task draft');
  await cdp.evaluate(`document.getElementById('previewClassicBtn').click()`);
  ok(Boolean(await waitForEval(cdp, 'window.state?.streaming === false', 220)), 'B9 permission turn completed');

  await cdp.evaluate(`(() => { const input = document.getElementById('promptInput'); input.value = 'ask framework'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('sendBtn').click(); return true; })()`);
  ok(Boolean(await waitForEval(cdp, `!!document.querySelector('.ask-modal[data-session-id="${sessionId}"]')`)), 'C1 classic question prompt opened');
  await cdp.evaluate(`(() => { const select = document.getElementById('cfgShellMode'); select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  const questionCard = await waitForEval(cdp, `(() => {
    const fact = document.getElementById('previewNeedsFact');
    if (document.getElementById('previewNeedsValue')?.textContent !== '1') return null;
    if (fact.getAttribute('aria-expanded') !== 'true') fact.click();
    const card = document.querySelector('.preview-intervention-card[data-intervention-type="question"]');
    if (!card) return null;
    const checked = card.querySelectorAll('[data-option-id]:checked').length;
    const option = card.querySelector('.preview-question-option');
    const indicator = option?.querySelector('.preview-question-indicator')?.getBoundingClientRect();
    const copy = option?.querySelector('.preview-question-option-copy')?.getBoundingClientRect();
    return new Promise(resolve => setTimeout(() => {
      const drawer = document.getElementById('previewNeedsDrawer').getBoundingClientRect();
      resolve({ checked, within: drawer.left >= -1 && drawer.right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth + 1,
        context: card.querySelector('.preview-question-context')?.textContent || '', other: !!card.querySelector('[data-other-choice]'),
        aligned: !!indicator && !!copy && Math.abs((indicator.top + indicator.height / 2) - (copy.top + copy.height / 2)) < 4,
        left: drawer.left, right: drawer.right, width: innerWidth, scrollWidth: document.documentElement.scrollWidth });
    }, 240));
  })()`);
  ok(questionCard && questionCard.checked === 0, 'C2 question choices are all empty by default');
  ok(questionCard && questionCard.context.includes('larger ecosystem') && questionCard.other, 'C2b Preview shows preceding context and keeps Other as a fallback');
  ok(questionCard && questionCard.aligned, 'C2c option indicator and copy are vertically aligned');
  await cdp.evaluate(`(() => {
    const card = document.querySelector('.preview-intervention-card[data-intervention-type="question"]');
    const choice = card.querySelector('[data-other-choice]'); choice.click();
    const input = card.querySelector('[data-other-text]'); input.value = '需要补充一点背景';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); input.setSelectionRange(3, 6);
    window.__wave85OtherText = input; document.dispatchEvent(new Event('visibilitychange')); return true;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 800));
  const uninterruptedAnswer = await cdp.evaluate(`(() => {
    const input = document.querySelector('.preview-intervention-card[data-intervention-type="question"] [data-other-text]');
    return { sameNode: input === window.__wave85OtherText, focused: document.activeElement === input,
      value: input?.value || '', selectionStart: input?.selectionStart, selectionEnd: input?.selectionEnd };
  })()`);
  ok(uninterruptedAnswer && uninterruptedAnswer.sameNode && uninterruptedAnswer.focused
    && uninterruptedAnswer.value === '需要补充一点背景'
    && uninterruptedAnswer.selectionStart === 3 && uninterruptedAnswer.selectionEnd === 6,
  'C2d quiet refresh preserves an in-progress fallback answer and caret range');
  ok(questionCard && questionCard.within, 'C3 decision drawer stays inside the 390px viewport');
  if (!(questionCard && questionCard.within)) console.log('INFO C3 drawer=' + JSON.stringify(questionCard));
  await cdp.evaluate(`(() => { const card = document.querySelector('.preview-intervention-card[data-intervention-type="question"]'); card.querySelector('[data-option-id="vue"]').click(); card.querySelector('.preview-intervention-actions button.primary').click(); return true; })()`);
  ok(Boolean(await waitForEval(cdp, `document.getElementById('previewNeedsValue')?.textContent === '0' && !document.querySelector('.ask-modal')`)),
    'C4 typed question answer resolves globally and retires the classic ask modal');
  await cdp.evaluate(`document.getElementById('previewClassicBtn').click()`);
  ok(Boolean(await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'classic' && document.getElementById('messages')?.textContent.includes('Got Vue')`, 260)),
    'C5 classic transcript continues with the selected answer');
  await waitForEval(cdp, 'window.state?.streaming === false', 220);

  const stopped = await request(appPort, '/api/mission', { action: 'stop', sessionId }, token);
  ok(stopped.status === 200 && stopped.json?.mission?.result?.status === 'stopped', 'D1 Mission stopped with an authoritative result record');
  await cdp.evaluate(`(() => { const select = document.getElementById('cfgShellMode'); select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  const stopCard = await waitForEval(cdp, `(() => {
    const seal = document.querySelector('.preview-seal[data-mission-id="${sessionId}"]');
    if (document.getElementById('previewMain')?.dataset.view === 'home' && seal) seal.click();
    const card = document.querySelector('.preview-stop-card:not([hidden])');
    if (!card) return null;
    return { buttons: card.querySelectorAll('.preview-stop-actions button').length, unfinished: card.querySelectorAll('.preview-stop-unfinished li').length };
  })()`);
  ok(stopCard && stopCard.buttons === 3 && stopCard.unfinished === 2, 'D2 stop card explains unfinished work and offers three honest next steps');
  await cdp.evaluate(`document.querySelectorAll('.preview-stop-actions button')[1].click()`);
  ok(Boolean(await waitForEval(cdp, `document.documentElement.getAttribute('data-shell-mode') === 'classic' && document.getElementById('promptInput')?.value.includes('Verify the global decision drawer')`)),
    'D3 Change approach opens classic with an unsent context-rich draft');

  const interventions = await request(appPort, '/api/interventions/' + encodeURIComponent(sessionId) + '?limit=100', null, token);
  const terminals = (interventions.json?.interventions || []).filter(item => item && item.status !== 'pending');
  ok(terminals.some(item => item.type === 'permission' && item.status === 'allowed')
    && terminals.some(item => item.type === 'question' && item.status === 'answered'),
    'E1 authoritative ledger records both terminal decisions');
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp) cdp.close();
  killTree(browser); killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(150);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nPRETENDER NEEDS DRAWER E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
