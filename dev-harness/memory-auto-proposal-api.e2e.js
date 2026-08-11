'use strict';
// R4-S3 real HTTP path: successful provider turn -> quiet model judge -> user decision, with cooldown.
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');

(async () => {
  const fakePort = await getFreePort();
  const workbenchPort = await getFreePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-proposal-'));
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const proposalJson = JSON.stringify({
    decision: 'propose', confidence: 0.94, durability: 'durable',
    name: '外链使用系统默认浏览器', description: '桌面工作台展示回答中的外部链接时适用',
    type: 'convention', scope: 'project', body: '外部链接交给系统默认浏览器，工作台保留返回入口。',
    reason: '这是用户明确确认的长期桌面交互约定',
  });
  const reply = '已完成桌面链接行为修复，并验证外部链接会交给系统默认浏览器，工作台保持原界面不被覆盖。'.repeat(5);
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    configSchema: 9, version: '1.0.0', permissionMode: 'bypass', engineMode: 'interactive',
    defaultWorkspace: workspace, activeProvider: 'fake',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'test', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }, null, 2));

  const env = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: root, USERPROFILE: root, HOME: root };
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(fakePort)], {
    windowsHide: true, env: { ...env, FAKE_OPENAI_PORT: String(fakePort), FAKE_DRAFT_JSON: proposalJson, FAKE_REPLY_TEXT: reply },
  });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(workbenchPort)], {
    cwd: path.resolve(__dirname, '..', 'ruyi-workbench'), windowsHide: true, env,
  });
  let failures = 0;
  const ok = (condition, label) => {
    if (condition) console.log('PASS ' + label);
    else { failures++; console.log('FAIL ' + label); }
  };
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const requestJson = (method, route, payload) => new Promise((resolve, reject) => {
    const data = payload == null ? '' : JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: workbenchPort, path: route, method, timeout: 15000, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data); req.end();
  });
  const streamTurn = payload => new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port: workbenchPort, path: '/api/chat/stream', method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => resolve(body));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(new Error('timeout')); }); req.write(data); req.end();
  });
  const stop = child => {
    if (!child || !child.pid) return;
    try {
      if (process.platform === 'win32') cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGKILL');
    } catch { /* already exited */ }
  };
  try {
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      await sleep(100);
      try { const r = await requestJson('GET', '/health'); healthy = r.status === 200; } catch { /* retry */ }
    }
    ok(healthy, 'workbench and fake provider started');
    const created = await requestJson('POST', '/api/sessions', { cwd: workspace });
    const sessionId = created.body && created.body.session && created.body.session.id;
    ok(Boolean(sessionId), 'created session');
    const stream = await streamTurn({ sessionId, cwd: workspace, message: '把这条作为项目规范：以后桌面端回答里的外部链接默认用系统浏览器打开，不要覆盖工作台。' });
    ok(/"type":"result","ok":true/.test(stream), 'durable-preference turn completed successfully');

    const proposed = await requestJson('POST', '/api/memory/proposal', { sessionId });
    ok(proposed.status === 200 && proposed.body && proposed.body.proposal && proposed.body.proposalId, 'strict judge returned one review-only candidate');
    ok(proposed.body && proposed.body.proposal && proposed.body.proposal.scope === 'project' && proposed.body.proposal.sourceSessionId === sessionId, 'candidate is project-scoped and source-pinned');
    const stateFile = path.join(root, 'memory', 'proposals', sessionId + '.json');
    ok(fs.existsSync(stateFile), 'proposal state is stored outside the chat session file');

    const otherWorkspace = path.join(root, 'other-workspace'); fs.mkdirSync(otherWorkspace, { recursive: true });
    const wrongProjectSave = await requestJson('POST', '/api/memory', {
      memory: { ...proposed.body.proposal, scope: 'project' }, cwd: otherWorkspace,
      proposalId: proposed.body.proposalId, sourceSessionId: sessionId,
    });
    ok(wrongProjectSave.status === 409 && wrongProjectSave.body && wrongProjectSave.body.conflict === true, 'candidate cannot be saved into a different project after workspace drift');

    const dismissed = await requestJson('POST', '/api/memory/proposal/decision', { sessionId, proposalId: proposed.body.proposalId, decision: 'dismissed' });
    ok(dismissed.status === 200 && dismissed.body && dismissed.body.status === 'dismissed', 'user dismissal is persisted');
    const replay = await requestJson('POST', '/api/memory/proposal', { sessionId });
    ok(replay.body && replay.body.proposal == null && replay.body.replayed === true, 'same turn does not re-open a dismissed card');

    await streamTurn({ sessionId, cwd: workspace, message: '后续也继续遵循这条项目规范和默认规则。' });
    const cooled = await requestJson('POST', '/api/memory/proposal', { sessionId });
    ok(cooled.body && cooled.body.proposal == null && cooled.body.reason === 'judge_cooldown', 'adjacent qualifying turn is suppressed before another model call');
    const ledgerDir = path.join(root, 'usage');
    const ledger = fs.existsSync(ledgerDir) ? fs.readdirSync(ledgerDir).filter(name => name.endsWith('.jsonl')).flatMap(name => fs.readFileSync(path.join(ledgerDir, name), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))) : [];
    ok(ledger.filter(row => row.note === 'memory-proposal-check').length === 1, 'only one auxiliary judge call was billed across adjacent qualifying turns');

    const created2 = await requestJson('POST', '/api/sessions', { cwd: workspace });
    const sessionId2 = created2.body && created2.body.session && created2.body.session.id;
    await streamTurn({ sessionId: sessionId2, cwd: workspace, message: '把这条作为项目规范：以后桌面端回答里的外部链接默认用系统浏览器打开，不要覆盖工作台。' });
    const proposed2 = await requestJson('POST', '/api/memory/proposal', { sessionId: sessionId2 });
    const saved = await requestJson('POST', '/api/memory', {
      memory: { ...proposed2.body.proposal, id: 'auto-proposal-saved', scope: 'project' }, cwd: workspace,
      proposalId: proposed2.body.proposalId, sourceSessionId: sessionId2,
    });
    ok(saved.status === 200 && saved.body && saved.body.ok && fs.existsSync(saved.body.memory.file), 'reviewed candidate saves through the normal memory API');
    const savedState = JSON.parse(fs.readFileSync(path.join(root, 'memory', 'proposals', sessionId2 + '.json'), 'utf8'));
    ok(savedState.current && savedState.current.status === 'saved', 'the successful memory save request also records the candidate as user-confirmed');
    await requestJson('DELETE', '/api/sessions/' + encodeURIComponent(sessionId2));

    await requestJson('DELETE', '/api/sessions/' + encodeURIComponent(sessionId));
    ok(!fs.existsSync(stateFile), 'deleting a session removes its proposal state');
  } catch (error) {
    failures++; console.log('FAIL integration threw: ' + (error && error.stack || error));
  } finally {
    stop(wb); stop(fake);
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  console.log('\nMEMORY AUTO PROPOSAL API E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exit(failures ? 1 : 0);
})();
