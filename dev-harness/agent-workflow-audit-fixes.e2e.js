'use strict';
// Regression coverage for a post-ship audit of the v1.4.4 Agent 工作流 changes. Each part below pins one
// specific finding so it can't silently come back:
//  (A) BUG1 — normalizeAgentWorkflow dropped `engine` on save; a node's explicit engine choice reverted to
//      "auto" the next time the workflow was loaded/launched.
//  (B) BUG7 — a fresh /api/agent-workflow/launch reused subagentMaxPerTurn (a per-CHAT-TURN ad hoc fan-out
//      budget, default 4) as the DAG's node-count ceiling, rejecting any real pipeline with 5+ nodes under
//      default config even though RESUMING the same run used a hardcoded 32.
//  (C) BUG6 — the live `node_loop` event omitted noProgressCount (present in the final result, but not the
//      real-time progress event the UI renders during the run).
//  (D) orchestrate_agents' `workflowId`+`context` — documented in the tool schema but never resolved by
//      either in-turn dispatch path, so a model-issued `{workflowId, context}` call (no inline `nodes`)
//      always failed with "nodes 必须是非空数组". Also proves `context` actually reaches the node's prompt.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-agent-workflow-audit');
const FP = await getFreePort(), WP = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function get(port, p, headers = {}) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1000, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function post(port, p, body, headers = {}) { return new Promise((resolve, reject) => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.write(raw); r.end(); }); }
function stream(port, body, headers = {}) { return new Promise((resolve, reject) => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = '', events = []; res.on('data', c => { b += c; let i; while ((i = b.indexOf('\n')) >= 0) { const line = b.slice(0, i); b = b.slice(i + 1); try { if (line.trim()) events.push(JSON.parse(line)); } catch { /* ignore */ } } }); res.on('end', () => resolve(events)); }); r.on('error', reject); r.write(raw); r.end(); }); }
async function up(port, p = '/health') { for (let i = 0; i < 50; i++) { if (await get(port, p)) return true; await sleep(120); } return false; }

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const qualitySchema = { type: 'object', required: ['verdict', 'confidence', 'summary', 'findings'], properties: { verdict: { type: 'string', enum: ['pass', 'fail', 'uncertain'] }, confidence: { type: 'number', minimum: 0, maximum: 1 }, summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object' } } } };
  const good = JSON.stringify({ verdict: 'pass', confidence: 0.9, summary: 'ok', findings: [] });
  const script = { parent: [], parentText: '父回合完成。', subText: good };
  // Default config: NO subagentMaxPerTurn/agentWorkflowMaxNodes override — relies entirely on
  // defaultConfig()'s own generous v1.4.4 defaults (this is the exact regression BUG7 describes).
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake' }));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_SUBAGENT_SCRIPT: JSON.stringify(script) }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(FP, '/v1/models') && await up(WP), 'fake provider and workbench start');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1]; const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'audit', cwd: HOME }, hdr); const sid = created.session.id;

    // ---- (A) BUG1: engine survives normalizeAgentWorkflow's save/reload round-trip ----
    const draft = {
      id: 'audit-engine-wf', title: '审计-引擎持久化', description: '', source: 'personal',
      nodes: [{ id: 'n1', task: '占位任务', engine: 'claude', dependsOn: [], failurePolicy: 'block', position: { x: 0, y: 0 } }],
    };
    const saved = await post(WP, '/api/agent-workflows', { scope: 'personal', cwd: HOME, workflow: draft }, hdr);
    ok(saved.ok === true && saved.workflow.nodes[0].engine === 'claude', 'save response itself carries engine=claude');
    const listed0 = await get(WP, '/api/agent-workflows?cwd=' + encodeURIComponent(HOME), hdr);
    const reloaded = listed0.workflows.find(w => w.id === 'audit-engine-wf');
    ok(!!reloaded && reloaded.nodes[0].engine === 'claude', 'engine survives a save -> reload round-trip (was silently dropped to "")');

    // ---- (B) BUG7: a 6-node fresh launch is NOT rejected under default config (was capped at 4) ----
    const sixNodes = Array.from({ length: 6 }, (_, i) => ({ id: `bug7_n${i}`, task: `独立任务_${i}` }));
    const wide = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: sixNodes });
    ok(wide.ok === true && wide.results.length === 6 && wide.results.every(r => r.status === 'succeeded'), '6-node DAG launches under default config (previously rejected: node count > subagentMaxPerTurn default of 4)');

    // ---- (C) BUG6: the live node_loop event carries noProgressCount ----
    // Drive the loop through the same chat-turn tool-call path so live events are actually emitted (a
    // direct /api/agent-workflow/launch has no attached onEvent stream to observe). Fresh session: the fake
    // provider's script steps by countToolMsgs(msgs), which counts role:'tool' messages across the WHOLE
    // session history, not per-turn — reusing `sid` here would already have prior tool messages from (B).
    const sidC = (await post(WP, '/api/sessions', { title: 'audit-loop', cwd: HOME }, hdr)).session.id;
    const loopNodes = [{ id: 'loopy', task: 'VALID_LOOP_CONSTANT', outputSchema: qualitySchema, loop: { maxIterations: 4, noProgressLimit: 2, onNoProgress: 'continue' } }];
    const loopScript = { parent: [{ name: 'orchestrate_agents', args: { nodes: loopNodes } }], parentText: '循环工作流已提交。', subText: good };
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake' }));
    kill(fake); await sleep(200);
    const fake2 = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_SUBAGENT_SCRIPT: JSON.stringify(loopScript) }, windowsHide: true });
    ok(await up(FP, '/v1/models'), 'fake provider restarted for loop scenario');
    const events = await stream(WP, { sessionId: sidC, message: 'run loop workflow', cwd: HOME }, hdr);
    const loopEvts = events.filter(e => e.type === 'agent_workflow' && e.state === 'node_loop');
    ok(loopEvts.length > 0, 'at least one node_loop event was observed');
    ok(loopEvts.every(e => Number.isFinite(e.noProgressCount)), 'every node_loop event carries a finite noProgressCount (was undefined)');
    kill(fake2);

    // ---- (D) orchestrate_agents workflowId+context, resolved via the IN-TURN dispatch (not the HTTP loopback) ----
    const sidD = (await post(WP, '/api/sessions', { title: 'audit-context', cwd: HOME }, hdr)).session.id;
    const CONTEXT_MARKER = 'AUDIT_CONTEXT_MARKER_9931';
    const ctxDraft = {
      id: 'audit-context-wf', title: '审计-上下文注入', description: '', source: 'personal',
      nodes: [{ id: 'ctxnode', task: '通用占位任务，本身不带主题', dependsOn: [], failurePolicy: 'block', position: { x: 0, y: 0 } }],
    };
    await post(WP, '/api/agent-workflows', { scope: 'personal', cwd: HOME, workflow: ctxDraft }, hdr);
    const ctxScript = {
      parent: [{ name: 'orchestrate_agents', args: { workflowId: 'audit-context-wf', context: CONTEXT_MARKER } }],
      parentText: '上下文工作流已提交。',
      subText: '未命中上下文标记的默认回复。',
      subTextByTask: { [CONTEXT_MARKER]: good },
    };
    const fake3 = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_SUBAGENT_SCRIPT: JSON.stringify(ctxScript) }, windowsHide: true });
    ok(await up(FP, '/v1/models'), 'fake provider restarted for workflowId+context scenario');
    const ctxEvents = await stream(WP, { sessionId: sidD, message: 'run context workflow', cwd: HOME }, hdr);
    const toolResult = ctxEvents.find(e => e.type === 'tool_result' && e.content && Array.isArray(e.content.results));
    ok(!!toolResult && toolResult.content.ok === true, 'orchestrate_agents({workflowId, context}) resolves and runs (was: "nodes 必须是非空数组")');
    ok(!!toolResult && toolResult.content.results[0].status === 'succeeded' && JSON.parse(toolResult.content.results[0].result).summary === 'ok', 'the node only matched subTextByGood because CONTEXT_MARKER reached its prompt — context is actually injected');
    kill(fake3);
  } finally { kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true }); }
  console.log('\nAGENT WORKFLOW AUDIT FIXES E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
