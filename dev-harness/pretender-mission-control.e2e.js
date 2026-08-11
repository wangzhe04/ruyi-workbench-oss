#!/usr/bin/env node
'use strict';

// Wave 84: Mission control + checkpoint-ledger contract.
// Real Workbench + fake OpenAI SSE verifies authoritative pause/continue/stop/retry/takeover scopes,
// entry rollback, whole-Mission rewind, ledger truthfulness, and the Preview wiring/static responsive lock.
(async () => {
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-pretender-wave84-e2e');
const WORKSPACE = path.join(HOME, 'workspace');
const providerPort = await getFreePort();
const wbPort = await getFreePort();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.log('FAIL ' + label); }
};

function killTree(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
}
function request(pathname, body = null, token = '') {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: wbPort, path: pathname, method: body == null ? 'GET' : 'POST', headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    const result = await request('/health').catch(() => null);
    if (result && result.status === 200) return true;
    await sleep(80);
  }
  return false;
}
function sse(res, value) { res.write('data: ' + JSON.stringify(value) + '\n\n'); }
function emitText(res, value) {
  sse(res, { id: 'chatcmpl-wave84', choices: [{ index: 0, delta: { role: 'assistant', content: value }, finish_reason: null }] });
  sse(res, { id: 'chatcmpl-wave84', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function emitTool(res, callId, name, args) {
  sse(res, { id: 'chatcmpl-wave84', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
  sse(res, { id: 'chatcmpl-wave84', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
  sse(res, { id: 'chatcmpl-wave84', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
async function startProvider() {
  const server = http.createServer((req, res) => {
    if ((req.url || '').includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fake-model"}]}'); }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = ''; req.on('data', chunk => { raw += chunk; }); req.on('end', async () => {
      let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const latestUser = [...messages].reverse().find(message => message && message.role === 'user');
      const toolCount = messages.filter(message => message && message.role === 'tool').length;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (/HOLD-WAVE84/.test(String(latestUser && latestUser.content || ''))) {
        await sleep(4000); if (!res.destroyed) emitText(res, 'late response'); return;
      }
      if (toolCount === 0) return emitTool(res, 'call_wave84_a', 'file_write', { path: path.join(WORKSPACE, 'wave84-a.txt'), content: 'alpha' });
      if (toolCount === 1) return emitTool(res, 'call_wave84_b', 'file_write', { path: path.join(WORKSPACE, 'wave84-b.txt'), content: 'beta' });
      return emitText(res, 'checkpoint ledger ready');
    });
  });
  await new Promise(resolve => server.listen(providerPort, '127.0.0.1', resolve));
  return server;
}
function streamChat(sessionId, message, token) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify({ sessionId, message });
    const req = http.request({ host: '127.0.0.1', port: wbPort, path: '/api/chat/stream', method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token,
    } }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', error => { if (error.code === 'ECONNRESET') resolve(); else reject(error); });
    req.write(raw); req.end();
  });
}

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(WORKSPACE, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 8, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'bypass', toolLoadingMode: 'full', defaultWorkspace: WORKSPACE,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}), 'utf8');
const provider = await startProvider();
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true });
wb.stderr.on('data', chunk => String(chunk).trim() && console.error('[wb] ' + String(chunk).trim()));

try {
  ok(await waitHealth(), 'workbench up');
  const token = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token;
  ok(Boolean(token), 'runtime token available');
  const created = await request('/api/sessions', { title: 'wave84 control', cwd: WORKSPACE }, token);
  const sessionId = created.json?.session?.id;
  ok(Boolean(sessionId), 'Mission session created');
  const started = await request('/api/mission', { sessionId, action: 'start', mission: {
    goal: 'exercise mission control', autoMode: 'off', budget: { maxAutoTurns: 8, maxTokens: 50000 },
    milestones: [{ id: 'm1', desc: 'first', status: 'pending' }, { id: 'm2', desc: 'second', status: 'blocked', evidence: 'old blocker' }],
  } }, token);
  ok(started.status === 200 && started.json?.mission?.startedTurnSeq === 1, 'Mission start persists rollback cursor T1');

  await streamChat(sessionId, 'create two checkpointed files', token);
  const detail1 = await request('/api/missions/' + sessionId, null, token);
  const snap1 = detail1.json?.snapshot;
  ok(snap1?.ledger?.entries?.length === 2 && snap1.ledger.entries.every(entry => entry.revertible), 'snapshot ledger exposes two real reversible checkpoint rows');
  ok(snap1?.ledger?.recoverability === 'full' && snap1.ledger.rollbackTargetTurnSeq === 1, 'ledger computes full recoverability and whole-Mission target');
  ok(snap1?.controls?.actions?.continue?.enabled === true && snap1.controls.actions.continue.scope === 'turn_driver', 'Continue capability names turn+driver scope');
  ok(snap1?.controls?.actions?.rollback?.enabled === true && snap1.controls.actions.rollback.scope === 'mission', 'whole rollback capability names Mission scope');

  const continued = await request('/api/missions/' + sessionId + '/control', { action: 'continue' }, token);
  ok(continued.status === 200 && continued.json?.requiresTurn === true && continued.json?.mission?.autoMode === 'until-done', 'Continue re-arms driver and explicitly requires a new turn');
  const pausedDriver = await request('/api/missions/' + sessionId + '/control', { action: 'pause' }, token);
  ok(pausedDriver.status === 200 && pausedDriver.json?.mission?.autoMode === 'supervised' && !pausedDriver.json.mission.result, 'Pause leaves Mission non-terminal in supervised mode');

  const hold = streamChat(sessionId, 'HOLD-WAVE84', token);
  let active = false;
  for (let i = 0; i < 60; i++) {
    const detail = await request('/api/missions/' + sessionId, null, token);
    if (detail.json?.snapshot?.activeTurn) { active = true; break; }
    await sleep(50);
  }
  ok(active, 'fake provider creates a live main turn');
  const pausedTurn = await request('/api/missions/' + sessionId + '/control', { action: 'pause' }, token);
  ok(pausedTurn.status === 200 && pausedTurn.json?.controls?.activeTurn === false && !pausedTurn.json?.mission?.result,
    'Pause stops the live turn without stamping a terminal result' + (pausedTurn.status === 200 && pausedTurn.json?.controls?.activeTurn === false && !pausedTurn.json?.mission?.result ? '' : ' (' + JSON.stringify(pausedTurn.json) + ')'));
  await Promise.race([hold, sleep(5000)]);

  await request('/api/missions/' + sessionId + '/control', { action: 'continue' }, token);
  const takeover = await request('/api/missions/' + sessionId + '/control', { action: 'takeover' }, token);
  ok(takeover.status === 200 && takeover.json?.mission?.autoMode === 'off' && !takeover.json?.mission?.result, 'Human takeover disables autonomous driver without ending Mission');

  const stopped = await request('/api/missions/' + sessionId + '/control', { action: 'stop' }, token);
  ok(stopped.status === 200 && stopped.json?.mission?.result?.status === 'stopped' && stopped.json?.controls?.actions?.retry?.enabled, 'Stop stamps whole Mission and exposes Retry');
  const retried = await request('/api/missions/' + sessionId + '/control', { action: 'retry' }, token);
  const retriedM2 = retried.json?.mission?.milestones?.find(item => item.id === 'm2');
  ok(retried.status === 200 && retried.json?.requiresTurn === true && retried.json?.mission?.result == null && retriedM2?.status === 'pending' && retriedM2?.evidence === '', 'Retry clears stamp and resets blocked milestone evidence');
  await request('/api/missions/' + sessionId + '/control', { action: 'pause' }, token);

  const beforeEntry = (await request('/api/missions/' + sessionId, null, token)).json.snapshot;
  const entryB = beforeEntry.ledger.entries.find(entry => /wave84-b\.txt$/.test(entry.path));
  const entryRollback = await request('/api/checkpoints/rollback', { sessionId, turnSeq: entryB.turnSeq, entrySeq: entryB.entrySeq }, token);
  ok(entryRollback.status === 200 && entryRollback.json?.ok === true && !fs.existsSync(path.join(WORKSPACE, 'wave84-b.txt')), 'row rollback invokes real checkpoint and removes only file B');
  ok(fs.existsSync(path.join(WORKSPACE, 'wave84-a.txt')), 'row rollback preserves the other checkpoint');
  const afterEntry = (await request('/api/missions/' + sessionId, null, token)).json.snapshot;
  ok(afterEntry.ledger.entries.length === 1 && afterEntry.mission.changeSeq > beforeEntry.mission.changeSeq, 'row rollback disappears from ledger and advances Mission change sequence');

  const whole = await request('/api/missions/' + sessionId + '/control', { action: 'rollback' }, token);
  ok(whole.status === 200 && whole.json?.rollback?.ok === true && !fs.existsSync(path.join(WORKSPACE, 'wave84-a.txt')), 'whole-Mission rollback restores all remaining checkpointed files');
  ok(whole.json?.mission?.milestones?.every(item => item.status === 'pending' && item.evidence === '') && whole.json?.mission?.autoMode === 'off', 'whole rollback resets milestones and returns to human control');
  const finalSnap = (await request('/api/missions/' + sessionId, null, token)).json.snapshot;
  ok(finalSnap.ledger.entries.length === 0 && finalSnap.controls.actions.rollback.enabled === false, 'archive snapshot keeps ledger but disables exhausted rollback handle truthfully');

  const missingFollowup = await request('/api/missions/' + sessionId + '/control', { action: 'next_turn' }, token);
  ok(missingFollowup.status === 400 && missingFollowup.json?.reason === 'prompt_required', 'next_turn rejects an empty follow-up instead of starting a context-free turn');

  const completedCreated = await request('/api/sessions', { title: 'wave95 completed follow-up', cwd: WORKSPACE }, token);
  const completedId = completedCreated.json?.session?.id;
  await request('/api/mission', { sessionId: completedId, action: 'start', mission: {
    goal: 'completed task', autoMode: 'until-done', budget: { maxAutoTurns: 8, maxTokens: 50000 },
    milestones: [{ id: 'done', desc: 'original delivery', status: 'pending' }],
  } }, token);
  const finalized = await request('/api/mission', { sessionId: completedId, action: 'update', patch: {
    milestones: [{ id: 'done', status: 'done', evidence: 'accepted' }],
  } }, token);
  ok(finalized.status === 200 && finalized.json?.mission?.result?.status === 'complete' && finalized.json?.mission?.autoMode === 'until-done',
    'automatic completion keeps its historical driver mode and stamps a result');
  const beforeFollowup = (await request('/api/sessions/' + completedId, null, token)).json?.session;
  const followup = await request('/api/missions/' + completedId + '/control', { action: 'next_turn', prompt: 'add a second delivery' }, token);
  const afterFollowup = (await request('/api/sessions/' + completedId, null, token)).json?.session;
  const pendingFollowup = afterFollowup?.mission?.milestones?.find(item => item.status === 'pending' && String(item.id || '').startsWith('accept_followup'));
  ok(followup.status === 200 && followup.json?.requiresTurn === true && followup.json?.mission?.result == null && Boolean(pendingFollowup),
    'next_turn reopens a completed Mission with a new pending acceptance item');
  ok(afterFollowup?.turnSeq === beforeFollowup?.turnSeq && afterFollowup?.messages?.length === beforeFollowup?.messages?.length,
    'next_turn control does not prewrite the user prompt or consume a turn before the single chat stream');

  const invalid = await request('/api/missions/' + sessionId + '/control', { action: 'teleport' }, token);
  const unauth = await request('/api/missions/' + sessionId + '/control', { action: 'pause' });
  ok(invalid.status === 400 && invalid.json?.reason === 'action_invalid', 'unknown Mission action is rejected deterministically');
  ok(unauth.status === 403, 'Mission control is token-gated');

  const preview = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'preview-shell.js'), 'utf8');
  const css = fs.readFileSync(path.join(WB, 'app', 'public', 'css', 'views', 'preview-shell.css'), 'utf8');
  ok(preview.includes("runMissionControlTurn") && preview.includes("/api/checkpoints/rollback") && preview.includes("controlScope"), 'Preview reuses classic stream and real rollback endpoints with visible scopes');
  ok(preview.includes("/api/agent-runs/") && preview.includes("action: 'stop'") && preview.includes('previewMissionLedger'), 'Run controls and permanent archive ledger are wired');
  ok(css.includes('.preview-control-board') && css.includes('.preview-ledger-tape::before') && /@media \(max-width: 620px\)/.test(css), 'telegraph/tape aesthetic and 390px flow are locked');
} finally {
  killTree(wb);
  await new Promise(resolve => provider.close(resolve));
  await sleep(150);
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log('\nPRETENDER MISSION CONTROL E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
