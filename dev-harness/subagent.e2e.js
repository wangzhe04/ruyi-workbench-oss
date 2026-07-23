(async () => {
// E2E (v0.9-S6): 子代理 spawn_agent — 主回合内派子回合执行子任务,provider 引擎,离线 via fake-openai.
// Ports 9009 (fake-openai) + 9010 (workbench). §0.9-S6 / 总纲 §4 A5 · §8 D4.
//
// fake 契约:FAKE_SUBAGENT_SCRIPT={parent:[…],sub:[…],subText?,parentText?} — 按请求 system 是否含子代理身份
// 标记「子任务执行体」分流:父请求走 parent 剧本(含 spawn_agent tool_call)、子请求走 sub 剧本(含 file_write
// 等,最后吐结论文本)。
//
// Scenarios:
//  (a) 基本派生:父 spawn_agent{task,toolTier:'edit'} → 子回合 file_write x.txt → 断言 subagent start/end 事件对、
//      子 tool_use/result 带 subagentId、x.txt 被创建、journal 有条目(同父 turnSeq)、父收到 spawn_agent 的
//      tool_result 含子结论文本、turn ok。
//  (b) 禁嵌套:子剧本尝试 spawn_agent → tool_result error「不可再派生」;x2.txt 仍写成(子回合继续)。
//  (c) 单批次扇出上限:一条 assistant 消息 3 个 spawn_agent → 第 3 个 tool_result error「上限」。
//  (d) toolTier=read 的子回合尝试 file_write → 工具不在子工具集(模型看不到)→ 子回合没能写文件(r.txt 不存在)。
//  (e) subagentMaxPerTurn:0 → spawn_agent 工具不在 buildOpenAiTools 产物里(meta.tools 计数少一 + 直接调
//      /api/tools/spawn_agent 得 context-free 拒绝)。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-subagent-e2e');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 8000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let parsed = null; try { parsed = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, body: parsed }); }); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('post timeout')); }); req.write(data); req.end();
  });
}
// Full-buffer stream: spawn_agent turns do NOT pause (unlike plan mode), so a plain buffered read suffices.
function streamChat(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
// v0.9 F4: LIVE stream so the test can fire /api/plan/decision the moment a `plan` event arrives (plan mode
// pauses the turn — a buffered read would deadlock). onEvent(evt) fires per parsed line.
function streamChatLive(port, payload, onEvent) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { let evt = null; try { evt = JSON.parse(line); } catch { /* ignore */ } if (evt) { events.push(evt); try { onEvent(evt); } catch { /* ignore */ } } } } });
      res.on('end', () => { if (buf.trim()) { try { const evt = JSON.parse(buf); events.push(evt); onEvent(evt); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function writeConfig(fakePort, subagentMaxPerTurn, permissionMode, subagentMaxConcurrent) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 8, version: '1.0.0', permissionMode: permissionMode || 'bypass', toolLoadingMode: 'full',
    defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: subagentMaxPerTurn == null ? 4 : subagentMaxPerTurn,
    subagentMaxConcurrent: subagentMaxConcurrent == null ? 2 : subagentMaxConcurrent,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function spawnFake(env) { const p = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), ...env }, windowsHide: true }); p.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim())); return p; }
function fakeUp(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: 800 }, resp => { resp.resume(); res(true); }); r.on('error', () => res(false)); r.on('timeout', () => { r.destroy(); res(false); }); }); }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  writeConfig(FAKE_PORT, 4);

  // Scenario (a): parent spawns ONE sub-agent (toolTier:'edit') that writes x.txt then concludes.
  const xTxt = path.join(HOME, 'x.txt');
  const scriptA = JSON.stringify({
    parent: [{ name: 'spawn_agent', args: { task: '写个文件 x.txt', toolTier: 'edit' } }],
    sub: [{ name: 'file_write', args: { path: xTxt, content: 'from-subagent' } }],
    subText: '子任务完成:已写入 x.txt。',
    parentText: '父回合:子任务已交办完成。',
  });
  let fake = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptA });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(fake, wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const PKG_VERSION = require(require('path').join(__dirname, '..', 'ruyi-workbench', 'package.json')).version;   // 动态读版本,防每次升版过期
    ok(h && h.version === PKG_VERSION, `version ${PKG_VERSION} (got ${h && h.version})`);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // ── (a) basic spawn → sub file_write executed ────────────────────────────────────────────────────────
    const c1 = await postJson(WB_PORT, '/api/sessions', { title: 'subagent basic', cwd: HOME }, hdr);
    const sid1 = c1.body && c1.body.session && c1.body.session.id;
    ok(!!sid1, '(a) session created');
    const ev1 = await streamChat(WB_PORT, { sessionId: sid1, message: '帮我派个子任务', cwd: HOME });

    const subStart = ev1.find(e => e.type === 'subagent' && e.state === 'start');
    const subEnd = ev1.find(e => e.type === 'subagent' && e.state === 'end');
    ok(!!subStart, '(a) `subagent` start event streamed');
    ok(subStart && typeof subStart.id === 'string' && subStart.id && /x\.txt/.test(subStart.task || ''), '(a) start event carries id + task');
    ok(subStart && subStart.toolTier === 'edit', '(a) start event carries toolTier=edit');
    ok(!!subEnd, '(a) `subagent` end event streamed');
    ok(subEnd && subEnd.id === (subStart && subStart.id), '(a) start/end share the same subagentId');
    ok(subEnd && subEnd.ok === true && subEnd.resultChars > 0, '(a) end event ok:true + resultChars>0');

    // sub tool_use / tool_result carry subagentId; the parent spawn_agent tool_use does NOT.
    const subToolUse = ev1.find(e => e.type === 'tool_use' && e.subagentId && e.name === 'file_write');
    ok(!!subToolUse, '(a) sub-turn file_write tool_use tagged with subagentId');
    ok(subToolUse && subToolUse.subagentId === (subStart && subStart.id), '(a) sub tool_use subagentId matches start id');
    const subToolRes = ev1.find(e => e.type === 'tool_result' && e.subagentId);
    ok(subToolRes && subToolRes.isError !== true, '(a) sub-turn tool_result tagged + not an error');
    const parentSpawnUse = ev1.find(e => e.type === 'tool_use' && e.name === 'spawn_agent' && !e.subagentId);
    ok(!!parentSpawnUse, '(a) parent spawn_agent tool_use is NOT tagged with subagentId');

    // x.txt written by the sub-turn on disk.
    ok(fs.existsSync(xTxt), '(a) sub-turn file_write EXECUTED (x.txt exists)');

    // journal has an entry under the parent turnSeq for x.txt.
    const cp1 = await getJson(WB_PORT, '/api/checkpoints?sessionId=' + sid1, hdr);
    ok(cp1 && cp1.ok && Array.isArray(cp1.entries) && cp1.entries.some(e => (e.path || '').replace(/\\/g, '/').endsWith('x.txt')), '(a) journal has an x.txt entry (parent turnSeq)');

    // parent received the spawn_agent tool_result containing the sub's conclusion text.
    const parentSpawnRes = ev1.find(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.result != null);
    ok(parentSpawnRes && parentSpawnRes.content && parentSpawnRes.content.ok === true && /x\.txt/.test(String(parentSpawnRes.content.result || '')), '(a) parent got spawn_agent tool_result with sub conclusion');
    const res1 = ev1.find(e => e.type === 'result');
    ok(res1 && res1.ok === true, '(a) turn result ok');

    // ── (a2) staged orchestration: first agent completes, then dependent summary starts with prior context ──
    killp(fake); await sleep(300);
    const capO = path.join(HOME, 'cap-orchestration');
    const scriptO = JSON.stringify({
      parent: [
        { name: 'spawn_agent', args: { task: '先给出正方观点', agentKey: 'pro', toolTier: 'read' } },
        { name: 'spawn_agent', args: { task: '总结前序观点', agentKey: 'summary', dependsOn: ['pro'], toolTier: 'read' } },
      ],
      sub: [], subText: '前序观点结论。', parentText: '分阶段编排完成。',
    });
    fake = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptO, FAKE_CAPTURE_DIR: capO });
    procs.push(fake);
    let up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(a2) orchestration fake respawned');
    const co = await postJson(WB_PORT, '/api/sessions', { title: 'subagent orchestration', cwd: HOME }, hdr);
    const sido = co.body && co.body.session && co.body.session.id;
    const evo = await streamChat(WB_PORT, { sessionId: sido, message: '先分析再总结', cwd: HOME });
    const proEndAt = evo.findIndex(e => e.type === 'subagent' && e.state === 'end' && e.agentKey === 'pro');
    const summaryStartAt = evo.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'summary');
    ok(proEndAt >= 0 && summaryStartAt > proEndAt, '(a2) dependent summary starts only after the prior agent ends');
    const summaryStart = evo[summaryStartAt];
    ok(summaryStart && Array.isArray(summaryStart.dependsOn) && summaryStart.dependsOn[0] === 'pro', '(a2) summary event exposes dependsOn=[pro]');
    let priorContextInjected = false, orchestrationPromptPresent = false;
    try {
      for (const file of fs.readdirSync(capO).filter(f => /req-\d+\.json$/.test(f))) {
        const body = JSON.parse(fs.readFileSync(path.join(capO, file), 'utf8'));
        const system = { content: (body.messages || []).filter(m => m && (m.role === 'system' || m.role === 'user')).map(m => typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map(p => p && p.text || '').join('\n') : '')).join('\n') };
        if (system && String(system.content || '').includes('子代理编排') && String(system.content || '').includes('dependsOn')) orchestrationPromptPresent = true;
        const users = (body.messages || []).filter(m => m && m.role === 'user').map(m => String(m.content || '')).join('\n');
        if (users.includes('以下是已完成的前序子代理结果') && users.includes('前序观点结论')) priorContextInjected = true;
      }
    } catch { /* assertion below reports failure */ }
    ok(priorContextInjected, '(a2) completed dependency conclusion is injected into the summary agent context');
    ok(orchestrationPromptPresent, '(a2) parent prompt explains parallel stages and dependsOn orchestration');

    // ── (a3) one-call persistent DAG: pro/con parallel, summary auto-unlocks without another parent decision ──
    killp(fake); await sleep(300);
    const scriptW = JSON.stringify({
      parent: [{ name: 'orchestrate_agents', args: { nodes: [
        { id: 'pro', task: '正方分析', toolTier: 'read' },
        { id: 'con', task: '反方分析', toolTier: 'read' },
        { id: 'summary', task: '综合裁决', dependsOn: ['pro', 'con'], toolTier: 'read' },
      ] } }],
      sub: [], subText: '节点结论。', parentText: 'DAG 完成。',
    });
    fake = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptW }); procs.push(fake);
    up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(a3) DAG fake respawned');
    const cw = await postJson(WB_PORT, '/api/sessions', { title: 'persistent agent DAG', cwd: HOME }, hdr);
    const sidw = cw.body && cw.body.session && cw.body.session.id;
    const evw = await streamChat(WB_PORT, { sessionId: sidw, message: '运行完整编排图', cwd: HOME });
    const wfStart = evw.find(e => e.type === 'agent_workflow' && e.state === 'start');
    const wfEnd = evw.find(e => e.type === 'agent_workflow' && e.state === 'end');
    ok(wfStart && wfStart.nodeCount === 3, '(a3) workflow start event exposes three nodes');
    ok(wfEnd && wfEnd.status === 'succeeded' && wfEnd.succeeded === 3, '(a3) workflow completes all DAG nodes');
    const proStartW = evw.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'pro');
    const conStartW = evw.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'con');
    const firstEndW = evw.findIndex(e => e.type === 'subagent' && e.state === 'end');
    const summaryStartW = evw.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'summary');
    const proEndW = evw.findIndex(e => e.type === 'subagent' && e.state === 'end' && e.agentKey === 'pro');
    const conEndW = evw.findIndex(e => e.type === 'subagent' && e.state === 'end' && e.agentKey === 'con');
    ok(proStartW >= 0 && conStartW >= 0 && firstEndW > Math.max(proStartW, conStartW), '(a3) independent pro/con nodes really overlap');
    ok(summaryStartW > Math.max(proEndW, conEndW), '(a3) summary auto-starts only after both dependencies finish');
    const persistedRuns = await getJson(WB_PORT, '/api/agent-runs?sessionId=' + sidw, hdr);
    const persisted = persistedRuns && persistedRuns.runs && persistedRuns.runs.find(r => r.id === (wfStart && wfStart.id));
    ok(persisted && persisted.status === 'succeeded' && persisted.nodes.length === 3, '(a3) completed DAG is persisted and inspectable through API');
    const noTokenRuns = await getJson(WB_PORT, '/api/agent-runs?sessionId=' + sidw).catch(() => null);
    ok(noTokenRuns && noTokenRuns.ok === false, '(a3) agent-run records are token protected');

    const retrySummary = await postJson(WB_PORT, '/api/agent-runs/' + wfStart.id, { sessionId: sidw, action: 'retry_node', nodeId: 'summary', cascade: false }, hdr);
    ok(retrySummary.body && retrySummary.body.accepted === true, '(a4) single-node retry accepted');
    let retried = null;
    for (let i = 0; i < 60; i++) { await sleep(100); const x = await getJson(WB_PORT, '/api/agent-runs?sessionId=' + sidw, hdr); retried = x.runs && x.runs.find(r => r.id === wfStart.id); if (retried && !retried.live && retried.status === 'succeeded') break; }
    const summaryAfterRetry = retried && retried.nodes.find(n => n.id === 'summary');
    ok(summaryAfterRetry && summaryAfterRetry.attempts === 2, '(a4) only summary node reran (attempts=2)');

    // Pause waits for the current node boundary, then resume continues the queued downstream node.
    killp(fake); await sleep(300);
    fake = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptW, FAKE_STREAM_DELAY_MS: '350' }); procs.push(fake);
    up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    const retryCascade = await postJson(WB_PORT, '/api/agent-runs/' + wfStart.id, { sessionId: sidw, action: 'retry_node', nodeId: 'pro', cascade: true }, hdr);
    const pauseRun = await postJson(WB_PORT, '/api/agent-runs/' + wfStart.id, { sessionId: sidw, action: 'pause' }, hdr);
    ok(retryCascade.body && retryCascade.body.accepted && pauseRun.body && pauseRun.body.ok, '(a4) cascade retry + pause accepted');
    let pausedRun = null;
    for (let i = 0; i < 80; i++) { await sleep(100); const x = await getJson(WB_PORT, '/api/agent-runs?sessionId=' + sidw, hdr); pausedRun = x.runs && x.runs.find(r => r.id === wfStart.id); if (pausedRun && pausedRun.status === 'paused') break; }
    ok(pausedRun && pausedRun.status === 'paused', '(a4) workflow pauses safely at a node boundary');
    const resumeRun = await postJson(WB_PORT, '/api/agent-runs/' + wfStart.id, { sessionId: sidw, action: 'resume' }, hdr);
    ok(resumeRun.body && resumeRun.body.ok, '(a4) paused workflow resumes');
    let resumedRun = null;
    for (let i = 0; i < 100; i++) { await sleep(100); const x = await getJson(WB_PORT, '/api/agent-runs?sessionId=' + sidw, hdr); resumedRun = x.runs && x.runs.find(r => r.id === wfStart.id); if (resumedRun && !resumedRun.live && resumedRun.status === 'succeeded') break; }
    ok(resumedRun && resumedRun.status === 'succeeded', '(a4) resumed workflow finishes queued downstream nodes');
    const stopRetry = await postJson(WB_PORT, '/api/agent-runs/' + wfStart.id, { sessionId: sidw, action: 'retry_node', nodeId: 'pro', cascade: true }, hdr);
    const stopRun = await postJson(WB_PORT, '/api/agent-runs/' + wfStart.id, { sessionId: sidw, action: 'stop' }, hdr);
    ok(stopRetry.body && stopRetry.body.accepted && stopRun.body && stopRun.body.ok, '(a4) stop request accepted for an active workflow');
    let stoppedRun = null;
    for (let i = 0; i < 80; i++) { await sleep(100); const x = await getJson(WB_PORT, '/api/agent-runs?sessionId=' + sidw, hdr); stoppedRun = x.runs && x.runs.find(r => r.id === wfStart.id); if (stoppedRun && !stoppedRun.live && stoppedRun.status === 'stopped') break; }
    ok(stoppedRun && stoppedRun.status === 'stopped', '(a4) stop aborts the workflow and persists stopped state');

    // ── (a5) resource-aware DAG: independent nodes sharing desktop must serialize ─────────────────────
    killp(fake); await sleep(300);
    const scriptR = JSON.stringify({
      parent: [{ name: 'orchestrate_agents', args: { nodes: [
        { id: 'desktop-a', task: '桌面任务 A', toolTier: 'read', resources: ['desktop'] },
        { id: 'desktop-b', task: '桌面任务 B', toolTier: 'read', resources: ['desktop'] },
      ] } }],
      sub: [], subText: '桌面节点完成。', parentText: '资源调度完成。',
    });
    fake = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptR, FAKE_STREAM_DELAY_MS: '180' }); procs.push(fake);
    up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(a5) resource-aware DAG fake respawned');
    const cr = await postJson(WB_PORT, '/api/sessions', { title: 'resource-aware DAG', cwd: HOME }, hdr);
    const sidr = cr.body && cr.body.session && cr.body.session.id;
    const evr = await streamChat(WB_PORT, { sessionId: sidr, message: '运行两个桌面任务', cwd: HOME });
    const aStartR = evr.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'desktop-a');
    const aEndR = evr.findIndex(e => e.type === 'subagent' && e.state === 'end' && e.agentKey === 'desktop-a');
    const bStartR = evr.findIndex(e => e.type === 'subagent' && e.state === 'start' && e.agentKey === 'desktop-b');
    ok(aStartR >= 0 && aEndR >= 0 && bStartR > aEndR, '(a5) same desktop resource serializes otherwise-independent nodes');
    ok(evr.some(e => e.type === 'agent_resource' && e.state === 'waiting' && e.agentKey === 'desktop-b'), '(a5) waiting resource event is observable');
    const rr = await getJson(WB_PORT, '/api/agent-runs?sessionId=' + sidr, hdr);
    const persistedR = rr.runs && rr.runs.find(run => run.nodes && run.nodes.some(n => n.id === 'desktop-a'));
    ok(persistedR && persistedR.schemaVersion === 4 && persistedR.nodes.every(n => Array.isArray(n.resources) && n.resources[0] === 'desktop'), '(a5) normalized resources persist in schema v4 run record');

    // ── (b) nesting forbidden: sub tries spawn_agent → refused, but its file_write still runs ─────────────
    killp(fake); await sleep(300);
    const x2 = path.join(HOME, 'x2.txt');
    const scriptB = JSON.stringify({
      parent: [{ name: 'spawn_agent', args: { task: '子任务再派生', toolTier: 'exec' } }],
      // sub tries to spawn_agent first (refused since not offered / defensive guard), then writes x2.txt, then concludes.
      sub: [{ name: 'spawn_agent', args: { task: '孙任务', toolTier: 'read' } }, { name: 'file_write', args: { path: x2, content: 'nested-guard' } }],
      subText: '子任务完成(嵌套被拒)。',
    });
    fake = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptB });
    procs.push(fake);
    up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(b) fake respawned');
    const c2 = await postJson(WB_PORT, '/api/sessions', { title: 'subagent nesting', cwd: HOME }, hdr);
    const sid2 = c2.body && c2.body.session && c2.body.session.id;
    const ev2 = await streamChat(WB_PORT, { sessionId: sid2, message: '派个会尝试嵌套的子任务', cwd: HOME });
    // The sub-turn's spawn_agent tool_result must be a refusal («不可再派生»).
    const nestRes = ev2.find(e => e.type === 'tool_result' && e.subagentId && e.content && e.content.ok === false && /不可再派生/.test(String(e.content.error || '')));
    ok(!!nestRes, '(b) sub-turn spawn_agent refused with «不可再派生»');
    ok(fs.existsSync(x2), '(b) sub-turn continued and wrote x2.txt after the refusal');
    const subEnd2 = ev2.find(e => e.type === 'subagent' && e.state === 'end');
    ok(subEnd2 && subEnd2.ok === true, '(b) sub-turn still concluded ok');

    // ── (c) single-batch fan-out cap: one assistant message with 3 spawn_agent → 3rd refused ─────────────
    killp(fake); await sleep(300);
    const scriptC = JSON.stringify({
      // The parent's parallel batch of 3 spawn_agent is driven by FAKE_SUBAGENT_PARALLEL (below); the parent
      // script here only supplies the final text. Each surviving sub-turn runs the `sub` script.
      sub: [{ name: 'file_write', args: { path: path.join(HOME, 'c.txt'), content: 'c' } }],
      subText: '子任务 c 完成。',
    });
    // For the parallel batch we use a dedicated env FAKE_SUBAGENT_PARALLEL (emit N spawn_agent in ONE message).
    const parallel = JSON.stringify([
      { name: 'spawn_agent', args: { task: '任务1', toolTier: 'read' } },
      { name: 'spawn_agent', args: { task: '任务2', toolTier: 'read' } },
      { name: 'spawn_agent', args: { task: '任务3', toolTier: 'read' } },
    ]);
    fake = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptC, FAKE_SUBAGENT_PARALLEL: parallel });
    procs.push(fake);
    up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(c) fake respawned');
    const c3 = await postJson(WB_PORT, '/api/sessions', { title: 'subagent fanout', cwd: HOME }, hdr);
    const sid3 = c3.body && c3.body.session && c3.body.session.id;
    const ev3 = await streamChat(WB_PORT, { sessionId: sid3, message: '一次派三个子任务', cwd: HOME });
    const capRefused = ev3.find(e => e.type === 'tool_result' && !e.subagentId && e.content && e.content.ok === false && /上限/.test(String(e.content.error || '')));
    ok(!!capRefused, '(c) the 3rd spawn_agent in one batch refused with «上限»');
    const startsC = ev3.filter(e => e.type === 'subagent' && e.state === 'start');
    ok(startsC.length === 2, '(c) exactly 2 sub-turns actually started (3rd never ran) — got ' + startsC.length);
    const firstEndC = ev3.findIndex(e => e.type === 'subagent' && e.state === 'end');
    const secondStartC = ev3.findIndex((e, i) => i > ev3.findIndex(x => x.type === 'subagent' && x.state === 'start') && e.type === 'subagent' && e.state === 'start');
    ok(secondStartC >= 0 && firstEndC > secondStartC,
       '(c) both accepted sub-agents start before either ends (real overlap, not serial fan-out)');

    const savedLimits = await postJson(WB_PORT, '/api/config', { subagentMaxConcurrent: 3, subagentMaxPerTurn: 6 }, hdr);
    ok(savedLimits.body && savedLimits.body.config && savedLimits.body.config.subagentMaxConcurrent === 3 && savedLimits.body.config.subagentMaxPerTurn === 6,
       '(c2) configurable sub-agent concurrency/turn limits persist through /api/config');
    const c3b = await postJson(WB_PORT, '/api/sessions', { title: 'subagent fanout configured', cwd: HOME }, hdr);
    const sid3b = c3b.body && c3b.body.session && c3b.body.session.id;
    const ev3b = await streamChat(WB_PORT, { sessionId: sid3b, message: '按设置一次并行三个子任务', cwd: HOME });
    const startsC3 = ev3b.filter(e => e.type === 'subagent' && e.state === 'start');
    ok(startsC3.length === 3, '(c2) configured concurrency=3 launches all three agents (got ' + startsC3.length + ')');

    // ── (d) toolTier=read → sub cannot see file_write → r.txt not written ─────────────────────────────────
    killp(fake); await sleep(300);
    const rTxt = path.join(HOME, 'r.txt');
    const scriptD = JSON.stringify({
      parent: [{ name: 'spawn_agent', args: { task: '只读子任务', toolTier: 'read' } }],
      sub: [{ name: 'file_write', args: { path: rTxt, content: 'should-not-write' } }],
      subText: '只读子任务结束。',
    });
    fake = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptD });
    procs.push(fake);
    up = false; for (let i = 0; i < 30 && !up; i++) { await sleep(150); up = await fakeUp(FAKE_PORT); }
    ok(up, '(d) fake respawned');
    const c4 = await postJson(WB_PORT, '/api/sessions', { title: 'subagent read-tier', cwd: HOME }, hdr);
    const sid4 = c4.body && c4.body.session && c4.body.session.id;
    const ev4 = await streamChat(WB_PORT, { sessionId: sid4, message: '派一个只读子任务', cwd: HOME });
    ok(!fs.existsSync(rTxt), '(d) read-tier sub-turn did NOT write r.txt (file_write not in its tool set)');
    // The sub tried file_write; since it isn't offered, toolCall would error «Unknown tool» — assert an error result.
    const dToolRes = ev4.find(e => e.type === 'tool_result' && e.subagentId);
    ok(dToolRes && dToolRes.content && dToolRes.content.ok === false, '(d) sub-turn file_write attempt errored (tool absent)');

    // ── (f) v0.9 F4: plan mode + APPROVE → parent spawns an exec sub-agent → its file_write EXECUTES ───────
    // Plan mode would normally hard-block edit/exec at the sub-agent gate; F4 propagates the turn's approval
    // (permModeOverride='default') into runSubAgent so the approved sub can actually do the work.
    killp(fake); await sleep(300);
    writeConfig(FAKE_PORT, 4, 'plan'); // plan mode; readConfig re-reads per turn so no restart needed
    const fTxt = path.join(HOME, 'f-approved.txt');
    const scriptF = JSON.stringify({
      parent: [{ name: 'spawn_agent', args: { task: '写 f-approved.txt', toolTier: 'exec' } }],
      sub: [{ name: 'file_write', args: { path: fTxt, content: 'approved-exec-subagent' } }],
      subText: '子任务完成:已写入 f-approved.txt。',
      parentText: '父回合:已交办执行。',
    });
    // FAKE_PLAN_FIRST=1 → the FIRST parent request yields a PLAN: text (pause); after approval the follow-up
    // parent request falls through to FAKE_SUBAGENT_SCRIPT and emits the spawn_agent tool_call.
    fake = spawnFake({ FAKE_PLAN_FIRST: '1', FAKE_SUBAGENT_SCRIPT: scriptF });
    procs.push(fake);
    let upF = false; for (let i = 0; i < 30 && !upF; i++) { await sleep(150); upF = await fakeUp(FAKE_PORT); }
    ok(upF, '(f) plan-mode fake respawned');
    const cF = await postJson(WB_PORT, '/api/sessions', { title: 'subagent plan-approve', cwd: HOME }, hdr);
    const sidF = cF.body && cF.body.session && cF.body.session.id;
    let planEvtF = null, decideF = null;
    const evF = await streamChatLive(WB_PORT, { sessionId: sidF, message: '计划后派个执行子代理', cwd: HOME }, evt => {
      if (evt.type === 'plan' && !planEvtF) { planEvtF = evt; postJson(WB_PORT, '/api/plan/decision', { sessionId: sidF, planId: evt.planId, decision: 'approve' }, hdr).then(r => { decideF = r; }).catch(() => {}); }
    });
    ok(!!planEvtF, '(f) a `plan` event was streamed (plan-mode pause)');
    for (let i = 0; i < 20 && !decideF; i++) await sleep(50);
    ok(decideF && decideF.body && decideF.body.ok === true, '(f) approve decision {ok:true}');
    const subStartF = evF.find(e => e.type === 'subagent' && e.state === 'start');
    ok(!!subStartF, '(f) sub-agent started after plan approval');
    const subUseF = evF.find(e => e.type === 'tool_use' && e.subagentId && e.name === 'file_write');
    ok(!!subUseF, '(f) sub-agent attempted file_write');
    const subToolResF = evF.find(e => e.type === 'tool_result' && e.subagentId && e.content);
    ok(subToolResF && subToolResF.content.ok === true && subToolResF.isError !== true, '(f) F4: sub-agent file_write ALLOWED (approved plan → sub gate lifted), not a permission refusal');
    ok(fs.existsSync(fTxt), '(f) F4: exec-tier sub-agent file_write EXECUTED under approved plan (f-approved.txt exists)');
    const resF = evF.find(e => e.type === 'result');
    ok(resF && resF.ok === true, '(f) turn ok after approved sub-agent execution');

    // ── (g) v0.9 F4: plan mode + REJECT → the exec sub-agent is NOT launched, its file is NOT written ───────
    // planApproved stays false → permModeOverride === 'plan' → the sub's edit/exec stays hard-blocked. Here the
    // rejection ends the turn before the parent even requests the spawn, so no sub file appears (未批准→被拒).
    killp(fake); await sleep(300);
    const gTxt = path.join(HOME, 'g-unapproved.txt');
    const scriptG = JSON.stringify({
      parent: [{ name: 'spawn_agent', args: { task: '写 g-unapproved.txt', toolTier: 'exec' } }],
      sub: [{ name: 'file_write', args: { path: gTxt, content: 'should-not-exist' } }],
      subText: '子任务完成。',
    });
    fake = spawnFake({ FAKE_PLAN_FIRST: '1', FAKE_SUBAGENT_SCRIPT: scriptG });
    procs.push(fake);
    let upG = false; for (let i = 0; i < 30 && !upG; i++) { await sleep(150); upG = await fakeUp(FAKE_PORT); }
    ok(upG, '(g) plan-mode fake respawned');
    const cG = await postJson(WB_PORT, '/api/sessions', { title: 'subagent plan-reject', cwd: HOME }, hdr);
    const sidG = cG.body && cG.body.session && cG.body.session.id;
    let planEvtG = null, rejG = null;
    const evG = await streamChatLive(WB_PORT, { sessionId: sidG, message: '计划后派执行子代理但会被拒', cwd: HOME }, evt => {
      if (evt.type === 'plan' && !planEvtG) { planEvtG = evt; postJson(WB_PORT, '/api/plan/decision', { sessionId: sidG, planId: evt.planId, decision: 'reject', note: '先别执行' }, hdr).then(r => { rejG = r; }).catch(() => {}); }
    });
    ok(!!planEvtG, '(g) a `plan` event was streamed');
    for (let i = 0; i < 20 && !rejG; i++) await sleep(50);
    ok(rejG && rejG.body && rejG.body.ok === true, '(g) reject decision {ok:true}');
    ok(!fs.existsSync(gTxt), '(g) F4: un-approved plan → exec sub-agent file NOT written (g-unapproved.txt absent)');
    ok(!evG.find(e => e.type === 'subagent' && e.state === 'start'), '(g) no sub-agent launched under a rejected plan');
    const resG = evG.find(e => e.type === 'result');
    ok(resG && resG.errorClass === 'plan_rejected', '(g) turn ended plan_rejected');

    // Restore bypass config for scenario (e).
    killp(fake); await sleep(300);

    // ── (e) subagentMaxPerTurn:0 → spawn_agent not in buildOpenAiTools; direct /api/tools call refused ────
    killp(wb); await sleep(400);
    writeConfig(FAKE_PORT, 0); // disable the feature
    const scriptE = JSON.stringify({ parent: [{ text: '无子代理可用。' }], sub: [], subText: 'n/a' });
    const fakeE = spawnFake({ FAKE_SUBAGENT_SCRIPT: scriptE, FAKE_CAPTURE_DIR: path.join(HOME, 'cap-e') });
    const wbE = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    wbE.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    procs.push(fakeE, wbE);
    let hE = null; for (let i = 0; i < 40 && !hE; i++) { await sleep(150); hE = await health(WB_PORT); }
    ok(!!hE, '(e) workbench restarted with subagentMaxPerTurn:0');
    const tokenE = await getToken(WB_PORT);
    const hdrE = { 'x-wcw-token': tokenE };
    const c5 = await postJson(WB_PORT, '/api/sessions', { title: 'subagent disabled', cwd: HOME }, hdrE);
    const sid5 = c5.body && c5.body.session && c5.body.session.id;
    const ev5 = await streamChat(WB_PORT, { sessionId: sid5, message: '看看有没有子代理工具', cwd: HOME });
    const metaE = ev5.find(e => e.type === 'meta');
    ok(!!metaE, '(e) meta event present');
    // Inspect the captured request body: tools array must NOT contain spawn_agent.
    const capDir = path.join(HOME, 'cap-e');
    let sawSpawnInTools = true;
    try {
      const files = fs.readdirSync(capDir).filter(f => /req-\d+\.json$/.test(f)).sort();
      if (files.length) {
        const body = JSON.parse(fs.readFileSync(path.join(capDir, files[0]), 'utf8'));
        const names = Array.isArray(body.tools) ? body.tools.map(t => t.function && t.function.name) : [];
        sawSpawnInTools = names.includes('spawn_agent') || names.includes('orchestrate_agents');
      } else { sawSpawnInTools = false; }
    } catch { sawSpawnInTools = false; }
    ok(sawSpawnInTools === false, '(e) agent delegation tools NOT in buildOpenAiTools when subagentMaxPerTurn:0');
    // Direct /api/tools/spawn_agent → context-free refusal.
    const direct = await postJson(WB_PORT, '/api/tools/spawn_agent', { task: 'x' }, hdrE);
    ok(direct.body && direct.body.result && direct.body.result.ok === false && /仅在 provider 引擎/.test(direct.body.result.error || ''), '(e) direct /api/tools/spawn_agent → context-free refusal');
    const directDag = await postJson(WB_PORT, '/api/tools/orchestrate_agents', { nodes: [] }, hdrE);
    ok(directDag.body && directDag.body.result && directDag.body.result.ok === false && /OpenAI 对话回合|Claude CLI 工作台会话/.test(directDag.body.result.error || ''), '(e) direct /api/tools/orchestrate_agents → context-free refusal');

    // ── (h) process restart marks an in-flight persisted DAG interrupted/blocked instead of ghost-running ──
    killp(wbE); await sleep(400);
    const recoveryFile = path.join(HOME, 'agent-runs', sidw, wfStart.id + '.json');
    const recoveryRun = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
    recoveryRun.status = 'running';
    recoveryRun.nodes[0].status = 'running'; recoveryRun.nodes[0].completedAt = null;
    recoveryRun.nodes[2].status = 'queued'; recoveryRun.nodes[2].completedAt = null;
    fs.writeFileSync(recoveryFile, JSON.stringify(recoveryRun, null, 2));
    const wbR = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    procs.push(wbR);
    let hR = null; for (let i = 0; i < 40 && !hR; i++) { await sleep(150); hR = await health(WB_PORT); }
    const tokenR = await getToken(WB_PORT); const hdrR = { 'x-wcw-token': tokenR };
    const recovered = await getJson(WB_PORT, '/api/agent-runs?sessionId=' + sidw, hdrR);
    const recoveredRun = recovered.runs && recovered.runs.find(r => r.id === wfStart.id);
    ok(recoveredRun && recoveredRun.status === 'interrupted', '(h) restart marks running workflow interrupted');
    ok(recoveredRun && recoveredRun.nodes.some(n => n.status === 'interrupted') && recoveredRun.nodes.some(n => n.status === 'blocked'), '(h) running node→interrupted and queued node→blocked');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSUBAGENT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
