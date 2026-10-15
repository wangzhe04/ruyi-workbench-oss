"use strict";
require('./lib/self-isolate-home');
// Offline model-tool integration: live discovery, explicit followup and manual-pool admission.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const { loadServerInternals } = require('./lib/server-internals');
const { ok, done } = createRunner('AGENT COORDINATION');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-coordination-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
let sequence = [], seqId = 0, releaseKeeper;
const held = new Promise(r => { releaseKeeper = r; });
function toolResult(messages, id) { const m = messages.find(m => m.tool_call_id === id); return m ? JSON.parse(m.content) : null; }
async function handler(req) {
  const sys = String((req.messages.find(m => m.role === 'system') || {}).content || '');
  const user = req.messages.find(m => m.role === 'user');
  if (sys.includes('子任务执行体')) {
    const task = String(user && user.content || '');
    if (task.includes('KEEP_COORDINATION')) { await held; return textFrames('keeper complete'); }
    if (task.includes('PROPOSE_COORDINATION')) {
      const steps = [
        ['send_to_agent', { action: 'list' }, 'child_list'],
        ['send_to_agent', { action: 'list', targetSessionId: 'external' }, 'child_scope'],
        ['propose_task', { task: 'HELPER_ONE' }, 'proposal_one'],
        ['propose_task', { task: 'HELPER_TWO' }, 'proposal_two'],
      ];
      for (const [name, args, id] of steps) if (!toolResult(req.messages, id)) return toolCallFrames(name, args, id);
      return textFrames('OLD_RESULT_REFERENCE');
    }
    return textFrames('new task done');
  }
  for (const [name, args, id] of sequence) if (!toolResult(req.messages, id)) return toolCallFrames(name, args, id);
  return textFrames('parent completed');
}
async function main() {
  let proc, fake;
  try {
    fake = await startFakeProvider({ handler });
    const port = await getFreePort();
    const config = { configSchema: 8, permissionMode: 'bypass', defaultWorkspace: home, agentAutoWake: false,
      subagentMaxPerTurn: 3, subagentMaxConcurrent: 3, agentWorkflowMaxNodes: 16, agentTaskPoolPolicy: 'auto-capped',
      providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }], activeProvider: 'fake',
    };
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
    proc = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
      cwd: path.resolve(__dirname, '../ruyi-workbench'), windowsHide: true,
      env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, WCW_POOL_GRACE_MS: '2000' },
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 150; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch {} await wait(100); }
    const token = ((await (await fetch(base)).text()).match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const headers = { 'content-type': 'application/json', 'x-wcw-token': token };
    const post = async (url, body) => (await fetch(base + url, { method: 'POST', headers, body: JSON.stringify(body) })).json();
    const sid = (await post('/api/sessions', { title: 'coordination', cwd: home })).session.id;
    const other = (await post('/api/sessions', { title: 'other', cwd: home })).session.id;
    const chat = async (sessionId, calls) => {
      sequence = calls.map(([name, args]) => [name, args, 'coord_' + (++seqId)]);
      const ids = sequence.map(c => c[2]);
      const response = await fetch(base + '/api/chat/stream', { method: 'POST', headers, body: JSON.stringify({ sessionId, cwd: home, message: 'COORDINATION_' + seqId }) });
      const raw = await response.text();
      if (!response.ok) throw new Error(raw);
      const events = raw.trim().split('\n').filter(Boolean).map(JSON.parse);
      return ids.map(id => { const event = events.find(e => e.type === 'tool_result' && e.id === id); if (!event) throw new Error('missing ' + id + ' ' + raw.slice(-1000)); return event.content; });
    };
    const read = async runId => (await (await fetch(base + `/api/agent-runs/${runId}?sessionId=${sid}`, { headers })).json()).run;
    const poll = async (runId, predicate) => { for (let i = 0; i < 150; i++) { const run = await read(runId); if (run && predicate(run)) return run; await wait(40); } throw new Error('run predicate timeout'); };
    const [preflight, syncOne, syncTwo, overCap] = await chat(sid, [
      ['orchestrate_agents', { nodes: [{ id: 'bad1', task: 'bad', role: 'missing-coord-role' }, { id: 'bad2', task: 'bad' }, { id: 'bad3', task: 'bad' }] }],
      ['orchestrate_agents', { task: 'SYNC_COORD_ONE' }],
      ['orchestrate_agents', { nodes: [{ id: 'one', task: 'SYNC_COORD_TWO' }, { id: 'two', task: 'SYNC_COORD_THREE' }] }],
      ['orchestrate_agents', { task: 'OVER_CAP' }],
    ]);
    ok(!preflight.ok && syncOne.ok && syncTwo.ok && !overCap.ok && overCap.startedCount === 0, 'pre-registration rejection refunds admission; synchronous calls share one node budget');
    const [launch] = await chat(sid, [['orchestrate_agents', { background: true, poolPolicy: 'manual', nodes: [
      { id: 'proposer', task: 'PROPOSE_COORDINATION', role: 'explorer', engine: 'openai', toolTier: 'read', model: 'fake-model', resources: ['read:coord-probe'], maxIters: 9 },
      { id: 'keeper', task: 'KEEP_COORDINATION', engine: 'openai', toolTier: 'read' },
    ] }]]);
    ok(launch.accepted && launch.capabilities.poolPolicy === 'manual', 'background manual launch reports actual selected policy');
    const runId = launch.runId;
    let run = await poll(runId, r => r.taskPool.length === 2 && r.nodes.find(n => n.id === 'proposer').status === 'succeeded');
    ok(run.nodes.length === 2 && run.taskPool.every(i => i.status === 'proposed'), 'manual proposals never auto-expand despite configured auto-capped policy');
    ok(run.originTurnAgentCap === 3 && run.messages.length === 0, 'manual run persists originating cap; discovery consumes no mail quota');
    const childRequest = fake.requests.find(r => toolResult(r.messages || [], 'child_scope'));
    const childRoster = toolResult(childRequest.messages, 'child_list');
    ok(childRoster.ok && childRoster.runs[0].nodes.some(n => n.nodeId === 'parent') && !JSON.stringify(childRoster).includes(sid), 'child discovers own group and opaque parent without external session ids');
    ok(toolResult(childRequest.messages, 'child_scope').reason === 'target_scope', 'child cannot enumerate other sessions');
    const [list] = await chat(sid, [['send_to_agent', { action: 'list' }]]);
    const group = list.runs.find(r => r.runId === runId);
    ok(group.live && group.nodes.find(n => n.nodeId === 'keeper').canReceive && !group.nodes.find(n => n.nodeId === 'proposer').canReceive, 'main live roster distinguishes active and terminal peers');
    ok(group.capabilities.nodes.find(n => n.nodeId === 'keeper').sendToolAvailable, 'live capability is derived from registered child tools');
    const [foreign] = await chat(other, [['send_to_agent', { action: 'list', runId }]]);
    ok(!foreign.ok && foreign.reason === 'run_not_found', 'roster ownership rejects foreign runs');
    const [empty] = await chat(other, [['send_to_agent', { action: 'list' }]]);
    ok(empty.runs.length === 0, 'default roster only lists current session active groups');
    await post('/api/config', { permissionMode: 'default' });
    ok(run.permissionModeAtLaunch === 'bypass', 'source run used a broader old permission mode');
    const [follow] = await chat(sid, [['orchestrate_agents', { followup: { previousRunId: runId, previousNodeId: 'proposer', task: 'FOLLOW_COORDINATION' } }]]);
    ok(follow.ok && follow.runId !== runId && follow.followup.previousNodeId === 'proposer', 'explicit followup creates a new run while the old group remains active');
    const newRun = await read(follow.runId), oldNode = run.nodes.find(n => n.id === 'proposer'), newNode = newRun.nodes[0];
    ok(newNode.roleId === oldNode.roleId && newNode.engine === oldNode.engine && newNode.model === oldNode.model && newNode.toolTier === oldNode.toolTier && newNode.maxIters === oldNode.maxIters && JSON.stringify(newNode.resources) === JSON.stringify(oldNode.resources), 'followup preserves execution settings and resource locking');
    ok(newNode.dependsOn.length === 0 && newRun.messages.length === 0 && newRun.permissionModeAtLaunch === 'default' && newRun.poolPolicy === 'off', 'followup uses current permission, independent DAG/mail and default-off pool');
    ok(newNode.context.includes('OLD_RESULT_REFERENCE') && newRun.nodes.length === 1, 'followup includes bounded reference output');
    const followRequest = fake.requests.find(r => String((r.messages.find(m => m.role === 'user') || {}).content || '').includes('FOLLOW_COORDINATION'));
    ok(followRequest && JSON.stringify(followRequest.messages).includes('OLD_RESULT_REFERENCE') && JSON.stringify(followRequest.messages).includes('FOLLOW_COORDINATION'), 'real followup child provider receives new task and old bounded reference');
    await post(`/api/agent-runs/${runId}`, { sessionId: sid, action: 'pause' });
    const [pausedList, pausedSend] = await chat(sid, [['send_to_agent', { action: 'list', runId }], ['send_to_agent', { runId, targetNodeKey: 'keeper', message: 'paused reference' }]]);
    ok(pausedList.runs[0].paused && pausedList.runs[0].nodes.find(n => n.nodeId === 'keeper').canReceive && pausedSend.status === 'queued', 'paused group roster and actual send both allow queued reference mail');
    await post(`/api/agent-runs/${runId}`, { sessionId: sid, action: 'resume' });

    const approve = async poolId => post(`/api/agent-runs/${runId}`, { sessionId: sid, action: 'pool_approve', poolId });
    const first = await approve(run.taskPool[0].id);
    ok(first.ok, 'approval after later parent turns consumes remaining originating-turn budget');
    const second = await approve(run.taskPool[1].id);
    ok(!second.ok && JSON.stringify(second).includes('turn_budget_exhausted'), 'second approval cannot borrow budget from a later turn');
    const duplicate = await approve(run.taskPool[0].id);
    ok(!duplicate.ok || duplicate.poolId === run.taskPool[0].id, 'duplicate approval never creates another agent');
    run = await read(runId);
    ok(run.nodes.length === 3 && run.taskPool[1].status === 'proposed', 'dry checks/failed approvals preserve pending proposal and admitted-node count');
    const [after] = await chat(sid, [['send_to_agent', { action: 'list', runId }]]);
    ok(!after.runs[0].capabilities.canMaterialize && after.runs[0].capabilities.materializeReason === 'turn_budget_exhausted', 'capability separates proposal tool from materialization budget');
    const [badPool, mixed, self, invalid, missing, emptyText] = await chat(sid, [
      ['orchestrate_agents', { task: 'bad', poolPolicy: 'auto-capped' }],
      ['send_to_agent', { targetSessionId: other, runId, message: 'x' }],
      ['send_to_agent', { targetSessionId: sid, message: 'x' }],
      ['send_to_agent', { targetSessionId: '../bad', message: 'x' }],
      ['send_to_agent', { targetSessionId: 'session_missing', message: 'x' }],
      ['send_to_agent', { targetSessionId: other, message: '' }],
    ]);
    ok(!badPool.ok && [mixed, self, invalid, missing, emptyText].map(r => r.reason).join(',') === 'mixed_targets,self_target,invalid_session_id,session_not_found,empty_message', 'model auto policy rejects; cross-session mail returns precise failures');
    releaseKeeper();
    // Reject the remaining proposal so this scenario has no approval grace race.
    await post(`/api/agent-runs/${runId}`, { sessionId: sid, action: 'pool_reject', poolId: run.taskPool[1].id });
    await poll(runId, r => r.status === 'succeeded');
    const [historic, deadSend] = await chat(sid, [['send_to_agent', { action: 'list', runId }], ['send_to_agent', { runId, targetNodeKey: 'keeper', message: 'do more' }]]);
    ok(!historic.runs[0].live && historic.runs[0].nodes.every(n => !n.canReceive) && !deadSend.ok, 'historical roster and final send check cannot resurrect terminal peers');
    process.env.RUYI_HOME = home;
    const api = loadServerInternals(['activeAgentRuns', 'materializePoolItem', 'agentRunCapabilities', 'agentRunRoster', 'nodeDeliveryEligibility', 'defaultConfig', 'resolveOrchestrateFollowup']);
    const restored = { id: 'run_abc123', sessionId: sid, cwd: home, poolPolicy: 'manual', originTurnAgentCap: 3, nodes: [{ id: 'old', engine: 'openai', toolTier: 'read', status: 'succeeded' }] };
    api.activeAgentRuns.set(restored.id, { run: restored });
    const item = { id: 'pool-restored', task: 'new', proposedBy: 'old' };
    const bounded = api.materializePoolItem(restored, item, { config: api.defaultConfig() });
    ok(!bounded.ok && bounded.reason === 'turn_budget_unavailable' && restored.nodes.length === 1, 'cold restored bounded run preserves old nodes and rejects unaccounted expansion');
    restored.originTurnAgentCap = 0;
    ok(api.materializePoolItem(restored, item, { config: api.defaultConfig() }).ok, 'HTTP-origin run without an originating-turn cap needs no lost closure');
    const deterministic = { id: 'run_def456', sessionId: sid, poolPolicy: 'off', nodes: [{ id: 'claude', engine: 'claude', status: 'running' }, { id: 'gate', engine: 'openai', status: 'running', gate: { mode: 'vote' } }] };
    api.activeAgentRuns.set(deterministic.id, { run: deterministic, registeredAgentTools: new Map() });
    const caps = api.agentRunCapabilities(deterministic);
    ok(caps.nodes.every(n => !n.sendToolAvailable && !n.proposalToolAvailable && !n.canReceive), 'Claude and deterministic nodes never advertise unsupported mailbox tools');
    const closing = { id: 'run_123abc', sessionId: sid, poolPolicy: 'manual', nodes: [{ id: 'closing', status: 'running', engine: 'openai' }] };
    api.activeAgentRuns.set(closing.id, { run: closing, closing: true });
    const closingRow = api.agentRunRoster(closing).nodes[0], closingSend = api.nodeDeliveryEligibility(closing, 'closing', { mail: true });
    ok(!closingRow.canReceive && !closingSend.ok && closingRow.reason === closingSend.reason && closingRow.reason === 'run_closing', 'closing roster and send share the same runtime eligibility rejection');
    const changed = await api.resolveOrchestrateFollowup({ followup: { previousRunId: runId, previousNodeId: 'proposer', task: 'new' } }, { id: sid }, path.join(home, 'different'));
    ok(String(changed.error).includes('workspace_changed'), 'followup rejects a changed workspace');
    const settling = { id: 'run_abcd1234', sessionId: sid, cwd: home, poolPolicy: 'off', nodes: [{ id: 'settling', engine: 'openai', toolTier: 'read', status: 'succeeded', result: 'finalizing reference' }] };
    api.activeAgentRuns.set(settling.id, { run: settling });
    const settlingArgs = { followup: { previousRunId: settling.id, previousNodeId: 'settling', task: 'new task' } };
    const unsettled = await api.resolveOrchestrateFollowup(settlingArgs, { id: sid }, home);
    settling.nodes[0].completedAt = new Date().toISOString();
    const settled = await api.resolveOrchestrateFollowup(settlingArgs, { id: sid }, home);
    ok(String(unsettled.error).includes('node_finalizing') && !settled.error, 'live succeeded node must finish finalization before its result can seed a followup');
    const runList = async () => (await (await fetch(base + `/api/agent-runs?sessionId=${sid}`, { headers })).json()).runs;
    const beforeDisabled = (await runList()).length;
    await post('/api/config', { subagentMaxPerTurn: 0 });
    const [disabled] = await chat(sid, [['orchestrate_agents', { task: 'HIDDEN_DISABLED_CALL', background: true }]]);
    ok(!disabled.ok && disabled.reason === 'agent_delegation_disabled' && disabled.startedCount === 0 && (await runList()).length === beforeDisabled, 'zero configured agent budget rejects hidden provider launch without creating a run');
    api.activeAgentRuns.clear();
  } finally {
    releaseKeeper();
    if (proc) await killOwnTree(proc);
    if (fake) await fake.close();
  }
}
main().catch(e => { ok(false, e.stack || String(e)); }).finally(done);
