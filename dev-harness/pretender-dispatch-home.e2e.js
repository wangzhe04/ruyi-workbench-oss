#!/usr/bin/env node
'use strict';

// 第78波真实浏览器 E2E：原位首跑态、首页四区、确认卡→Mission→瓷章、turn-local 安全档，
// 以及 ? / 速问不进入 /api/missions。使用真 Workbench + 假 OpenAI SSE，不触外网。
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

function request(port, pathname, { method = 'GET', body = null, token = '' } = {}) {
  return new Promise(resolve => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, timeout: 5000, headers: {
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
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (raw) req.write(raw); req.end();
  });
}

async function waitFor(check, attempts = 300, delay = 30) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await sleep(delay);
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

function sse(response, value) { response.write('data: ' + JSON.stringify(value) + '\n\n'); }
function emitText(response, text) {
  const id = 'chatcmpl-wave78';
  sse(response, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  for (const piece of String(text).match(/[\s\S]{1,24}/g) || []) sse(response, { id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  sse(response, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse(response, { id, choices: [], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 } });
  response.write('data: [DONE]\n\n'); response.end();
}
function emitMissionDone(response) {
  const id = 'chatcmpl-wave78', args = JSON.stringify({ milestones: [{ id: 'delivery', status: 'done', evidence: 'Wave 78 fake provider verified completion' }] });
  sse(response, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_mission_done', type: 'function', function: { name: 'mission_update', arguments: '' } }] }, finish_reason: null }] });
  sse(response, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
  sse(response, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  response.write('data: [DONE]\n\n'); response.end();
}

function startProvider(port, captures) {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    }
    if (!(req.method === 'POST' && (req.url || '').includes('/chat/completions'))) { res.writeHead(404); return res.end('not found'); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    let parsed = {}; try { parsed = JSON.parse(raw); } catch { /* malformed request is asserted downstream */ }
    captures.push(parsed);
    const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
    // Turn-volatile capability/mission context is intentionally attached to the first user message so
    // provider prompt caching can keep the stable system prefix intact.
    const mission = messages.some(message => message && /<mission-ledger>/.test(String(message.content || '')));
    const toolRows = messages.filter(message => message && message.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (mission && toolRows.length === 0) return emitMissionDone(res);
    if (mission) return emitText(res, 'Wave 78 task completed from the dispatch desk.');
    return emitText(res, 'Quick Ask answer: four.');
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve(server)));
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
      this.socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed');
    return result.result && result.result.value;
  }
  close() { try { this.socket?.close(); } catch { /* ignore */ } }
}

async function waitForTarget(port, appUrl) {
  return waitFor(async () => {
    const result = await request(port, '/json/list');
    return result?.json?.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl)) || null;
  }, 180, 50);
}
async function waitForEval(cdp, expression, attempts = 400) {
  return waitFor(async () => {
    try { return await cdp.evaluate(expression); } catch { return null; }
  }, attempts, 30);
}

async function createMission(port, token, goal, mode, completed = false) {
  const created = await request(port, '/api/sessions', { method: 'POST', token, body: { title: goal, cwd: ROOT } });
  const sessionId = created?.json?.session?.id;
  if (!sessionId) return '';
  await request(port, '/api/mission', { method: 'POST', token, body: {
    sessionId, action: 'start', mission: { goal, autoMode: mode, milestones: [{ id: 'm1', desc: goal, status: completed ? 'done' : 'pending' }] },
  } });
  if (completed) await request(port, '/api/mission', { method: 'POST', token, body: { sessionId, action: 'update', patch: { milestones: [{ id: 'm1', status: 'done', evidence: 'seeded' }] } } });
  return sessionId;
}

const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wave78-'));
const dataDir = path.join(root, 'data');
const profile = path.join(root, 'profile');
fs.mkdirSync(dataDir);
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  configSchema: 9, version: '2.4.0', permissionMode: 'default', theme: 'dark', uiMode: 'simple',
  defaultWorkspace: ROOT, recentWorkspaces: [], includeWorkbenchMcp: false,
  activeProvider: 'fake', engineMode: 'interactive',
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}), 'utf8');

const captures = [];
let provider = null, server = null, browser = null, cdp = null;
try {
  provider = await startProvider(providerPort, captures);
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: dataDir, WIN_CLAUDE_WORKBENCH_HOME: dataDir, HOME: dataDir, USERPROFILE: dataDir },
    windowsHide: true, stdio: 'ignore',
  });
  ok(Boolean(await waitFor(async () => (await request(appPort, '/health'))?.status === 200, 120, 60)), 'A1 workbench + fake provider started');
  const token = await waitFor(async () => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; }
  }, 80, 50);
  ok(Boolean(token), 'A2 runtime token available');
  const executable = browserPath();
  ok(Boolean(executable), 'A3 Edge/Chrome found');
  if (!token || !executable) throw new Error('browser prerequisites unavailable');

  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--disable-sync', '--disable-background-networking', '--force-device-scale-factor=1', '--window-size=1600,1100',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target?.webSocketDebuggerUrl), 'A4 browser target available');
  if (!target?.webSocketDebuggerUrl) throw new Error('CDP target unavailable');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect(); await cdp.send('Page.enable'); await cdp.send('Runtime.enable');

  const enabled = await waitForEval(cdp, `(() => {
    const select = document.getElementById('cfgShellMode');
    if (!window.state?.status || typeof select?.onchange !== 'function') return null;
    select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  ok(Boolean(enabled), 'B1 Preview enabled through the shared shell control');
  const firstRun = await waitForEval(cdp, `(() => {
    const main = document.getElementById('previewMain');
    const guide = document.querySelector('.preview-first-run');
    const shelf = document.querySelectorAll('.preview-playbook-card');
    if (main?.dataset.view !== 'home' || !guide || !document.getElementById('previewDispatchInput') || !shelf.length) return null;
    return { steps: guide.querySelectorAll('.preview-first-run-step').length, shelf: shelf.length, seals: document.querySelectorAll('.preview-seal').length };
  })()`);
  ok(firstRun && firstRun.steps === 3 && firstRun.shelf > 0 && firstRun.seals === 0, 'B2 empty dataset renders the original three-step first-run state inside the normal home');

  const runningId = await createMission(appPort, token, 'Wave 78 running seed', 'until-done', false);
  const doneId = await createMission(appPort, token, 'Wave 78 completed seed', 'off', true);
  ok(Boolean(runningId && doneId), 'B3 seeded authoritative running/done Missions through existing APIs');
  await cdp.evaluate("document.getElementById('previewRefreshBtn').click()");
  const home = await waitForEval(cdp, `(() => {
    const seals = [...document.querySelectorAll('.preview-seal')];
    if (document.getElementById('previewMain')?.dataset.view !== 'home' || seals.length !== 2) return null;
    return {
      firstRun: !!document.querySelector('.preview-first-run'),
      continueIds: [...document.querySelectorAll('.preview-continue-rail .preview-home-task')].map(node => node.dataset.missionId),
      recentIds: [...document.querySelectorAll('.preview-recent-grid .preview-home-task')].map(node => node.dataset.missionId),
      sections: ['preview-dispatch-box','preview-continue-section','preview-playbook-section','preview-recent-section'].every(name => !!document.querySelector('.' + name)),
    };
  })()`);
  ok(home && !home.firstRun && home.sections && home.continueIds.includes(runningId) && home.recentIds.includes(doneId), 'B4 normal home shows dispatch box, continue rail, familiar work, and recently finished from five-state facts');

  const familiar = await cdp.evaluate(`(() => {
    const card = [...document.querySelectorAll('.preview-playbook-card')].find(node => !node.disabled);
    if (!card) return null; card.click();
    return document.getElementById('previewDispatchInput').value;
  })()`);
  ok(typeof familiar === 'string' && familiar.trim().length > 0, 'B5 familiar-work card fills the dispatch box without starting work');

  await cdp.evaluate(`(() => {
    const input = document.getElementById('previewDispatchInput');
    input.value = '持续输入时保留焦点与光标'; input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus(); input.setSelectionRange(4, 8); window.__wave85DispatchInput = input;
    document.dispatchEvent(new Event('visibilitychange'));
    return true;
  })()`);
  await new Promise(resolve => setTimeout(resolve, 800));
  const uninterruptedDraft = await cdp.evaluate(`(() => {
    const input = document.getElementById('previewDispatchInput');
    return {
      sameNode: input === window.__wave85DispatchInput,
      focused: document.activeElement === input,
      value: input?.value || '',
      selectionStart: input?.selectionStart,
      selectionEnd: input?.selectionEnd,
    };
  })()`);
  ok(uninterruptedDraft && uninterruptedDraft.sameNode && uninterruptedDraft.focused
    && uninterruptedDraft.value === '持续输入时保留焦点与光标'
    && uninterruptedDraft.selectionStart === 4 && uninterruptedDraft.selectionEnd === 8,
  'B6 quiet task-desk refresh preserves the active draft node, focus, and caret range');

  const missionPrompt = 'Wave 78 browser dispatch: finish the task and record evidence.';
  await cdp.evaluate(`(() => {
    const input = document.getElementById('previewDispatchInput');
    input.value = ${JSON.stringify(missionPrompt)}; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('previewDispatchReviewBtn').click(); return true;
  })()`);
  const confirmation = await waitForEval(cdp, `(() => {
    const card = document.querySelector('.preview-dispatch-confirm');
    const select = document.getElementById('previewDispatchSafety');
    if (!card || !select || !document.getElementById('previewDispatchStartBtn')) return null;
    return { copy: card.textContent, estimate: card.dataset.estimateVisible, mode: select.value, workspace: card.querySelectorAll('.preview-confirm-fact strong')[1]?.textContent || '' };
  })()`);
  ok(confirmation && confirmation.copy.includes(missionPrompt) && confirmation.workspace.includes('ruyi-workbench-oss'), 'C1 confirmation restates the task and shows its real workspace');
  ok(confirmation && confirmation.mode === 'default' && confirmation.estimate === 'false' && /不显示|No duration/.test(confirmation.copy), 'C2 confirmation defaults to global safety and suppresses unsupported estimates');

  await cdp.evaluate(`(() => {
    const select = document.getElementById('previewDispatchSafety'); select.value = 'bypass'; select.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('previewDispatchStartBtn').click(); return true;
  })()`);
  const dispatched = await waitForEval(cdp, `(() => {
    const main = document.getElementById('previewMain');
    if (main?.dataset.view !== 'task-sheet' || ['${runningId}','${doneId}'].includes(main.dataset.missionId)) return null;
    return { id: main.dataset.missionId, seals: document.querySelectorAll('.preview-seal').length };
  })()`, 600);
  ok(dispatched && dispatched.seals === 3, 'C3 Start creates a Mission, opens its task sheet, and drops a third porcelain seal');

  const rawLensOpened = await waitForEval(cdp, `(() => {
    const tab = document.querySelector('.preview-lens-tab.lens-raw');
    if (!tab || tab.disabled) return null;
    if (tab.getAttribute('aria-selected') !== 'true') tab.click();
    return tab.getAttribute('aria-selected') === 'true';
  })()`);
  ok(Boolean(rawLensOpened), 'C4 expert raw lens is selected explicitly for provider reconciliation evidence');

  const completed = await waitForEval(cdp, `(() => {
    if (window.state?.streaming) return null;
    const main = document.getElementById('previewMain');
    const raw = document.getElementById('previewRawMessages');
    const pill = main?.querySelector('.preview-state-pill');
    const state = pill?.dataset.missionState || '';
    if (!raw?.textContent.includes('Wave 78 task completed') || state !== 'done') return null;
    return { id: main.dataset.missionId, state, rows: raw.querySelectorAll('[data-message-key]').length };
  })()`, 900);
  if (!completed) await cdp.evaluate("document.getElementById('previewRefreshBtn').click()");
  const completedAfterRefresh = completed || await waitForEval(cdp, `(() => {
    const main = document.getElementById('previewMain'); const raw = document.getElementById('previewRawMessages'); const pill = main?.querySelector('.preview-state-pill');
    const state = pill?.dataset.missionState || '';
    if (window.state?.streaming || !raw?.textContent.includes('Wave 78 task completed') || state !== 'done') return null;
    return { id: main.dataset.missionId, state, rows: raw.querySelectorAll('[data-message-key]').length };
  })()`, 300);
  ok(completedAfterRefresh && completedAfterRefresh.id === dispatched.id && completedAfterRefresh.state === 'done' && completedAfterRefresh.rows >= 2, 'C5 provider stream completes the authoritative Mission and reconciles the raw task sheet');

  const missionList = await request(appPort, '/api/missions?limit=20', { token });
  const dispatchedCard = missionList?.json?.missions?.find(card => card.sessionId === dispatched.id);
  if (!completedAfterRefresh || !dispatchedCard?.mission?.result) {
    console.error('Wave 78 dispatch diagnostics:', JSON.stringify({
      dispatched,
      completedAfterRefresh,
      mission: dispatchedCard?.mission || null,
      providerTurns: captures.map(body => ({
        roles: (body.messages || []).map(message => message.role),
        hasMissionLedger: (body.messages || []).some(message => /<mission-ledger>/.test(String(message?.content || ''))),
        toolCalls: (body.messages || []).map(message => message.tool_calls?.[0]?.function?.name).filter(Boolean),
      })),
    }, null, 2));
  }
  ok(dispatchedCard && dispatchedCard.mission?.goal === missionPrompt && dispatchedCard.mission?.result?.status === 'complete', 'C6 Mission list persists the exact goal and completion record');
  const persistedConfig = JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'));
  const usedMissionTool = captures.some(body => Array.isArray(body.tools) && body.tools.some(tool => tool?.function?.name === 'mission_update'));
  ok(persistedConfig.permissionMode === 'default' && usedMissionTool, 'C7 selected bypass reaches the turn/tool chain but does not widen persisted global safety');

  if (process.env.RUYI_PREVIEW_SCREENSHOT_DIR) {
    const taskShotDir = path.resolve(process.env.RUYI_PREVIEW_SCREENSHOT_DIR); fs.mkdirSync(taskShotDir, { recursive: true });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });
    for (const theme of ['dark', 'light']) {
      await cdp.evaluate(`new Promise(resolve => { document.documentElement.setAttribute('data-theme', '${theme}'); setTimeout(resolve, 320); })`);
      const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
      fs.writeFileSync(path.join(taskShotDir, `preview-task-sheet-${theme}.png`), Buffer.from(capture.data, 'base64'));
    }
  }

  const beforeQuickCount = missionList?.json?.missions?.length || 0;
  await cdp.evaluate(`(() => {
    document.getElementById('previewHomeBtn').click();
    const input = document.getElementById('previewDispatchInput'); input.value = '? What is two plus two?'; input.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('previewDispatchReviewBtn').click(); return true;
  })()`);
  const quick = await waitForEval(cdp, `(() => {
    if (document.documentElement.getAttribute('data-shell-mode') !== 'classic' || window.state?.streaming) return null;
    const current = window.state?.currentSession;
    if (!current || current.id === '${dispatched.id}' || !document.getElementById('messages').textContent.includes('Quick Ask answer')) return null;
    return { id: current.id, kind: current.kind, text: document.getElementById('messages').textContent };
  })()`, 700);
  ok(quick && quick.kind === 'quick_ask' && quick.text.includes('four'), 'D1 ? prefix bypasses confirmation, opens classic chat, and receives a direct answer');
  const afterQuick = await request(appPort, '/api/missions?limit=20', { token });
  const afterIds = (afterQuick?.json?.missions || []).map(card => card.sessionId);
  ok(afterIds.length === beforeQuickCount && quick && !afterIds.includes(quick.id), 'D2 Quick Ask session is explicitly excluded from the Mission list and task dock');

  if (process.env.RUYI_PREVIEW_SCREENSHOT_DIR) {
    await cdp.evaluate(`(() => { const select = document.getElementById('cfgShellMode'); select.value = 'preview'; select.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitForEval(cdp, `(() => {
      const main = document.getElementById('previewMain'); const review = document.getElementById('previewDispatchReviewBtn');
      if (main?.dataset.view !== 'home' || !review || review.disabled) return null;
      main.scrollTop = 0; return true;
    })()`);
    const shotDir = path.resolve(process.env.RUYI_PREVIEW_SCREENSHOT_DIR); fs.mkdirSync(shotDir, { recursive: true });
    const viewports = [
      { name: '', width: 1600, height: 1100 },
      { name: 'tablet-', width: 768, height: 1024 },
      { name: 'mobile-', width: 390, height: 844 },
    ];
    for (const viewport of viewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.width <= 390 });
      for (const theme of ['dark', 'light']) {
        await cdp.evaluate(`new Promise(resolve => { document.documentElement.setAttribute('data-theme', '${theme}'); document.getElementById('previewMain').scrollTop = 0; setTimeout(resolve, 320); })`);
        const capture = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
        fs.writeFileSync(path.join(shotDir, `preview-dispatch-home-${viewport.name}${theme}.png`), Buffer.from(capture.data, 'base64'));
      }
    }
  }
} catch (error) {
  console.log('ERROR ' + (error && error.stack || error));
  fail += 1;
} finally {
  if (cdp) cdp.close();
  killTree(browser); killTree(server);
  if (provider) await new Promise(resolve => provider.close(resolve));
  await sleep(300);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* browser profile lock */ }
  console.log(`\nPRETENDER DISPATCH HOME E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
}
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
