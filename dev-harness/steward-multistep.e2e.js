'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), os = require('os'), path = require('path');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { startFakeProvider, toolCallFrames } = require('./lib/fake-openai-provider');
const t = createRunner('STEWARD MULTISTEP'); const { ok } = t;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-multistep-'));
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let fake, s, holdReached = false;
let releaseTighten;
const calls = [];
async function until(test, label) { for (let i = 0; i < 800; i++) { if (await test()) return; await sleep(25); } throw new Error('timeout: ' + label); }
(async () => {
  try {
    fake = await startFakeProvider({ handler: req => {
      const text = String(req.messages.findLast(m => m.role === 'user')?.content || '');
      const hasTool = req.messages.slice(req.messages.findLastIndex(m => m.role === 'user') + 1).some(m => m.role === 'tool');
      if (text.includes('NODE_TIGHTEN_FIRST')) return new Promise(resolve => { releaseTighten = () => resolve('EVIDENCE_42 前序完成。'); });
      if (text.includes('NODE_DISABLED')) return hasTool ? '不会继续执行。' : toolCallFrames('powershell_run', { command: 'Write-Output fixture-disabled' });
      if (text.includes('NODE_BRIDGE_WRITE')) return hasTool ? '检查点后不可执行。' : toolCallFrames('mcp__fixture__write', { path: 'late.txt' });
      if (text.includes('NODE_DENY_BATCH')) return toolCallFrames([{ name: 'file_write', args: { path: 'denied-first.txt', content: 'not allowed' }, id: 'batch_first' }, { name: 'file_write', args: { path: 'denied-second.txt', content: 'not allowed' }, id: 'batch_second' }]);
      if (text.includes('NODE_WRITE')) return hasTool ? '已写入 organized.txt。' : toolCallFrames('file_write', { path: 'organized.txt', content: 'EVIDENCE_42\n' });
      if (text.includes('NODE_READ')) return hasTool ? '已回读 organized.txt 并核对 EVIDENCE_42。' : toolCallFrames('file_read', { path: 'organized.txt' });
      if (text.includes('NODE_HOLD')) { holdReached = true; calls.push('hold'); req.open(); return undefined; }
      if (text.includes('NODE_FAIL')) { calls.push('fail'); return { status: 400, json: { error: { message: 'fixture failure' } } }; }
      if (text.includes('NODE_AFTER')) { calls.push('after'); return 'SHOULD_NOT_RUN'; }
      if (text.includes('NODE_SECOND')) { calls.push('second'); return '核对已完成；收到上游 EVIDENCE_42。'; }
      if (text.includes('NODE_FIRST')) { calls.push('first'); return 'EVIDENCE_42：已完成第一步。'; }
      return '协调汇总：按实际步骤状态交付。';
    } });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ stewardEnabledV1: true, stewardPollMs: 120000, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
      permissionMode: 'auto', toolLoadingMode: 'full', defaultWorkspace: home, workspaces: [{ path: home }], subagentMaxPerTurn: 8, subagentMaxConcurrent: 2,
      providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'fixture', model: 'fake-model' }], activeProvider: 'fake' }));
    s = loadServerInternals(['StewardHooks', 'readConfig', 'loadSession', 'listSessions', 'listAgentRuns', 'stewardLaunchingTurns', 'activeAgentRuns', 'runSessionTurn', 'classifyRunResumeTier', 'saveAgentRun', 'autoResumeInterruptedRuns', 'mutateConfig', 'markInterruptedAgentRuns', 'deliverAgentRunEnvelope', 'readInterventions', 'decideIntervention', 'updateSessionMeta', 'createSession', 'runSubAgent', 'paths', 'EventStreamHooks'], { withEval: true });
    const ctx = { sessionId: 'steward', trigger: 'user', session: { id: 'steward', kind: 'steward', providerHistory: [] } };
    const make = (title, tasks) => s.StewardHooks.threadNew({ title, cwd: home, brief: { userText: title + '，按前后顺序办理并统一交付。' }, steps: tasks.map(task => ({ task })) }, ctx);
    const settle = async id => { await until(() => !s.stewardLaunchingTurns.has(id), 'settle ' + id); return s.loadSession(id); };
    const countBefore = (await s.listSessions()).length;
    for (const args of [{ steps: [{ task: 'only one' }] }, { steps: [{ task: 'A' }, { task: '' }] }, { missionId: 'sess_existing', steps: [{ task: 'A' }, { task: 'B' }] }, { relatedSessionId: 'sess_existing', steps: [{ task: 'A' }, { task: 'B' }] }, { steps: [{ task: 'A', toolTier: 'superuser' }, { task: 'B' }] }]) {
      const result = await s.StewardHooks.threadNew({ brief: { userText: 'test' }, ...args }, ctx);
      ok(!result.ok, '无效或越界计划拒绝：' + JSON.stringify(args));
    }
    ok((await s.listSessions()).length === countBefore, '拒绝计划不新建线程或幽灵事项');
    await s.mutateConfig(c => { c.subagentMaxPerTurn = 0; });
    ok(!(await make('缺代理能力', ['NODE_FIRST', 'NODE_SECOND'])).ok, '代理能力关闭时明确拒绝，不降级假成功');
    await s.mutateConfig(c => { c.subagentMaxPerTurn = 1; });
    ok(!(await make('预算不足', ['NODE_FIRST', 'NODE_SECOND'])).ok, '步骤数超预算不开线程');
    await s.mutateConfig(c => { c.subagentMaxPerTurn = 8; });
    await s.mutateConfig(c => { c.agentWorkflowMaxNodes = 0; });
    ok(!(await make('DAG关闭', ['NODE_FIRST', 'NODE_SECOND'])).ok, 'DAG能力关闭时创建前拒绝');
    await s.mutateConfig(c => { c.agentWorkflowMaxNodes = 48; });
    for (const title of ['资料汇总', '对比报告', '文件整理']) {
      const startAt = calls.length;
      const receipt = await make(title, ['NODE_FIRST: 收集并核对材料', 'NODE_SECOND: 依据第一步结论输出']);
      ok(receipt.ok && receipt.missionId === receipt.sessionId && receipt.delegation.coordinatorSessionId === receipt.sessionId, title + '只有一个新事项和协调线程，回执只报 accepted');
      const session = await settle(receipt.sessionId), runs = await s.listAgentRuns(receipt.sessionId), run = runs[0];
      ok(runs.length === 1 && run.kind === 'steward_delegation' && run.status === 'succeeded' && run.nodes.length === 2, title + '确定性提交一张真实 DAG');
      ok(JSON.stringify(calls.slice(startAt)) === JSON.stringify(['first', 'second']) && run.nodes[1].dependsOn[0] === 'step-1', title + '前序成功后才启动后序');
      const secondRequest = fake.requests.findLast(req => String(req.messages.findLast(m => m.role === 'user')?.content || '').includes('NODE_SECOND'));
      ok(JSON.stringify(secondRequest.messages).includes('EVIDENCE_42'), title + '后序实际收到前序结果');
      const envelopes = session.messages.flatMap(m => m.toolCalls || []).filter(c => c.name === 'orchestrate_agents' && c.result?.kind === 'agent_envelope');
      ok(envelopes.length === 1 && envelopes[0].result.status === 'succeeded' && session.brief.steps.length === 2, title + '保存步骤和唯一真实交付信封');
      await s.runSessionTurn({ sessionId: session.id, message: '仅核对刚才交付，不重新执行', source: 'steward' });
      ok((await s.listAgentRuns(session.id)).length === 1 && calls.length === startAt + 2, '普通追问不从持久委托书重放步骤');
      await s.deliverAgentRunEnvelope(session.id, run); await s.deliverAgentRunEnvelope(session.id, run);
      const reloaded = await s.loadSession(session.id);
      ok(reloaded.backgroundJobSeen.includes('agent:' + run.id), '重复完成事件仍保留同一个交付身份');
      await s.runSessionTurn({ sessionId: session.id, message: '再次核对状态', source: 'steward' });
      const afterDuplicate = await s.loadSession(session.id);
      ok(!afterDuplicate.providerHistory.some(m => m.role === 'user' && String(m.content || '').includes('[代理完成通知') && String(m.content).includes(run.id)) && afterDuplicate.messages.flatMap(m => m.toolCalls || []).filter(c => c.result?.runId === run.id && c.result?.kind === 'agent_envelope').length === 1, '重复完成后的下一回合没有第二份信封注入模型（日志原件可保留）');
    }
    const written = await s.StewardHooks.threadNew({ title: '真实文件整理', cwd: home, brief: { userText: '先写整理清单，再回读核对。' }, steps: [{ task: 'NODE_WRITE 写整理清单', toolTier: 'edit' }, { task: 'NODE_READ 回读核验', toolTier: 'read' }] }, ctx);
    await settle(written.sessionId);
    const fileRun = (await s.listAgentRuns(written.sessionId))[0];
    ok(fileRun.status === 'succeeded' && fs.readFileSync(path.join(home, 'organized.txt'), 'utf8').includes('EVIDENCE_42') && fileRun.nodes.every(n => n.toolCalls > 0), '文件整理实际写盘再回读，两个节点均有真实工具证据');
    ok(fileRun.nodes[0].resources.includes('workspace:' + home) && fileRun.nodes[1].resources.includes('read:workspace:' + home), '写步骤用独占工作区租约、读步骤用共享租约');
    const stepsStatus = await s.StewardHooks.runsStatus({ sessionId: written.sessionId }, ctx);
    ok(stepsStatus.runs[0].steps.every(n => n.status === 'succeeded') && stepsStatus.runs[0].steps[1].dependsOn[0] === 'step-1', '管家可查逐步骤真实状态与依赖');
    fs.unlinkSync(path.join(home, 'organized.txt'));
    await s.mutateConfig(c => { c.permissionMode = 'default'; });
    const pending = await s.StewardHooks.threadNew({ title: '权限待决', cwd: home, brief: { userText: '写文件前请让我确认。' }, steps: [{ task: 'NODE_WRITE 等确认再写', toolTier: 'edit' }, { task: 'NODE_AFTER' }] }, ctx);
    await until(async () => (await s.readInterventions(pending.sessionId)).some(iv => iv.status === 'pending' && iv.type === 'permission'), 'permission');
    ok(!fs.existsSync(path.join(home, 'organized.txt')) && (await s.listAgentRuns(pending.sessionId))[0].nodes[1].attempts === 0, '步骤内权限照常待决，确认前零写盘且后序未启动');
    const pendingIv = (await s.readInterventions(pending.sessionId)).find(iv => iv.status === 'pending');
    const denied = await s.decideIntervention({ missionId: pending.sessionId, interventionId: pendingIv.id, expectedVersion: pendingIv.interventionVersion || 0, idempotencyKey: 'deny-' + pendingIv.id, payload: { action: 'deny' } });
    ok(denied.status === 200, '逐项决定入口拒绝真实步骤权限');
    await settle(pending.sessionId);
    const deniedRun = (await s.listAgentRuns(pending.sessionId))[0];
    ok(deniedRun.nodes[0].status === 'failed' && deniedRun.nodes[1].attempts === 0 && !fs.existsSync(path.join(home, 'organized.txt')), '拒绝必须是失败终态，不能靠模型文字假成功启动后序');
    const batched = await s.StewardHooks.threadNew({ title: '同批拒绝', cwd: home, brief: { userText: '确认后才能写。' }, steps: [{ task: 'NODE_DENY_BATCH', toolTier: 'edit' }, { task: 'NODE_AFTER' }] }, ctx);
    await until(async () => (await s.readInterventions(batched.sessionId)).some(iv => iv.status === 'pending'), 'batch permission');
    const batchIv = (await s.readInterventions(batched.sessionId)).find(iv => iv.status === 'pending');
    await s.decideIntervention({ missionId: batched.sessionId, interventionId: batchIv.id, expectedVersion: batchIv.interventionVersion || 0, idempotencyKey: 'deny-' + batchIv.id, payload: { action: 'deny' } });
    await settle(batched.sessionId);
    ok((await s.readInterventions(batched.sessionId)).length === 1 && !fs.existsSync(path.join(home, 'denied-first.txt')) && !fs.existsSync(path.join(home, 'denied-second.txt')), '同一响应首工具被拒后，不执行或弹出后续工具');
    process.env.WCW_AGENT_WORKFLOW_IDLE_MS = '1000'; process.env.WCW_AGENT_NODE_IDLE_MS = '1000'; process.env.WCW_AGENT_NODE_WRAPUP_MS = '1000';
    const waiting = await s.StewardHooks.threadNew({ title: '等人不算卡死', cwd: home, brief: { userText: '等我确认后再写清单和回读。' }, steps: [{ task: 'NODE_WRITE', toolTier: 'edit' }, { task: 'NODE_READ', toolTier: 'read' }] }, ctx);
    await until(async () => (await s.readInterventions(waiting.sessionId)).some(iv => iv.status === 'pending'), 'watchdog permission');
    await sleep(6100); // must cross the real 5s workflow watchdog tick, not only the node tick
    const awaitingRun = (await s.listAgentRuns(waiting.sessionId))[0];
    ok(s.activeAgentRuns.has(awaitingRun.id) && !awaitingRun.idleAborted && !awaitingRun.nodes[0].idleAborted && !awaitingRun.nodes[0].wrapUpRequestedAt, '权限等待跨越工作流/节点空闲及收尾时限，不被误杀或催收尾');
    const waitingIv = (await s.readInterventions(waiting.sessionId)).find(iv => iv.status === 'pending');
    const allowed = await s.decideIntervention({ missionId: waiting.sessionId, interventionId: waitingIv.id, expectedVersion: waitingIv.interventionVersion || 0, idempotencyKey: 'allow-' + waitingIv.id, payload: { action: 'allow' } });
    ok(allowed.status === 200, '原逐项审批入口允许真实步骤权限');
    await settle(waiting.sessionId);
    ok((await s.listAgentRuns(waiting.sessionId))[0].status === 'succeeded' && fs.existsSync(path.join(home, 'organized.txt')), '批准后计时恢复，真实写盘及后序回读成功');
    delete process.env.WCW_AGENT_WORKFLOW_IDLE_MS; delete process.env.WCW_AGENT_NODE_IDLE_MS; delete process.env.WCW_AGENT_NODE_WRAPUP_MS;
    await s.mutateConfig(c => { c.permissionMode = 'auto'; });
    await s.mutateConfig(c => { c.allowCommandTools = false; });
    const disabled = await s.StewardHooks.threadNew({ title: '命令能力关闭', cwd: home, brief: { userText: '命令不可用时说明原因。' }, steps: [{ task: 'NODE_DISABLED', toolTier: 'exec' }, { task: 'NODE_AFTER' }] }, ctx);
    await settle(disabled.sessionId);
    const disabledRun = (await s.listAgentRuns(disabled.sessionId))[0];
    ok(disabledRun.nodes[0].status === 'failed' && disabledRun.nodes[1].attempts === 0, '原生命令能力关闭不能靠文字假成功，后序不启动');
    await s.mutateConfig(c => { c.allowCommandTools = true; });
    fs.unlinkSync(path.join(home, 'organized.txt'));
    const tightened = await s.StewardHooks.threadNew({ title: '中途收紧', cwd: home, brief: { userText: '按序执行并遵守我中途收紧的权限。' }, steps: [{ task: 'NODE_TIGHTEN_FIRST' }, { task: 'NODE_WRITE', toolTier: 'edit' }] }, ctx);
    await until(() => !!releaseTighten, 'tighten first');
    await s.updateSessionMeta(tightened.sessionId, { permissionMode: 'plan' });
    releaseTighten(); releaseTighten = null;
    await settle(tightened.sessionId);
    ok((await s.listAgentRuns(tightened.sessionId))[0].nodes[1].status === 'failed' && !fs.existsSync(path.join(home, 'organized.txt')), '前序运行时收紧为只做计划，后序不能沿启动时auto写盘');
    await s.mutateConfig(c => { c.permissionMode = 'default'; });
    const oldPermit = await s.StewardHooks.threadNew({ title: '旧审批不能越过收紧', cwd: home, brief: { userText: '先确认再写。' }, steps: [{ task: 'NODE_WRITE', toolTier: 'edit' }, { task: 'NODE_AFTER' }] }, ctx);
    await until(async () => (await s.readInterventions(oldPermit.sessionId)).some(iv => iv.status === 'pending'), 'old permission');
    const oldIv = (await s.readInterventions(oldPermit.sessionId)).find(iv => iv.status === 'pending');
    await s.updateSessionMeta(oldPermit.sessionId, { permissionMode: 'plan' });
    await s.decideIntervention({ missionId: oldPermit.sessionId, interventionId: oldIv.id, expectedVersion: oldIv.interventionVersion || 0, idempotencyKey: 'allow-old-' + oldIv.id, payload: { action: 'allow' } });
    await settle(oldPermit.sessionId);
    ok((await s.listAgentRuns(oldPermit.sessionId))[0].nodes[0].status === 'failed' && !fs.existsSync(path.join(home, 'organized.txt')), '待决后收紧为plan，旧审批allow仍不能越过当前权限');
    const explicit = await s.createSession({ title: '请求级权限反例', cwd: home });
    await s.updateSessionMeta(explicit.id, { permissionMode: 'plan' });
    const explicitCfg = { ...await s.readConfig(), permissionMode: 'acceptEdits', permissionModeFromRequest: true };
    const explicitResult = await s.runSubAgent({ parentSession: explicit, provider: explicitCfg.providers[0], config: explicitCfg, task: 'NODE_WRITE', toolTier: 'edit', interactivePermissions: true, permModeOverride: 'acceptEdits', depth: 1, ctrl: new AbortController(), onEvent: () => {} });
    ok(explicitResult.ok && fs.existsSync(path.join(home, 'organized.txt')), '显式请求级权限仍优先于会话快切，普通权限边界不被本片改写');
    s.__eval('globalThis.multistepBridgeOriginals = { collectBridgedTools, getBridgedClient, journalBridgedWrite }; globalThis.multistepBridgeCalls = 0; collectBridgedTools = async () => ({ tools: [{ type: "function", function: { name: "mcp__fixture__write", description: "fixture write", parameters: { type: "object", properties: { path: { type: "string" } } } } }], route: { mcp__fixture__write: { serverId: "fixture", toolName: "write" } } }); getBridgedClient = async () => ({ callTool: async () => { globalThis.multistepBridgeCalls++; return { ok: true }; } }); journalBridgedWrite = async (name, args, parent) => { await updateSessionMeta(parent.id, { permissionMode: "plan" }); };');
    const bridgeParent = await s.createSession({ title: '检查点窗口收紧', cwd: home });
    const bridgeCfg = { ...await s.readConfig(), permissionMode: 'bypass' };
    const bridgeResult = await s.runSubAgent({ parentSession: bridgeParent, provider: bridgeCfg.providers[0], config: bridgeCfg, task: 'NODE_BRIDGE_WRITE', toolTier: 'exec', interactivePermissions: true, permModeOverride: 'bypass', depth: 1, ctrl: new AbortController(), onEvent: () => {} });
    ok(!bridgeResult.ok && s.__eval('globalThis.multistepBridgeCalls') === 0, '桥接检查点异步写入期间收紧plan，真正派发前再次拒绝，外部调用为零');
    s.__eval('collectBridgedTools = globalThis.multistepBridgeOriginals.collectBridgedTools; getBridgedClient = globalThis.multistepBridgeOriginals.getBridgedClient; journalBridgedWrite = globalThis.multistepBridgeOriginals.journalBridgedWrite;');
    await s.mutateConfig(c => { c.permissionMode = 'auto'; });
    const beforeFailure = calls.length;
    const failed = await make('前序失败', ['NODE_FAIL', 'NODE_AFTER']);
    await settle(failed.sessionId);
    const failedRun = (await s.listAgentRuns(failed.sessionId))[0];
    ok(failedRun.status !== 'succeeded' && failedRun.nodes[0].status === 'failed' && !calls.slice(beforeFailure).includes('after') && failedRun.nodes[1].attempts === 0, '前序真实 HTTP 失败，后序零次执行，不能冒充全部完成');
    const partial = await make('部分完成', ['NODE_FIRST', 'NODE_FAIL']);
    const partialSession = await settle(partial.sessionId), partialRun = (await s.listAgentRuns(partial.sessionId))[0];
    const partialEnvelope = partialSession.messages.flatMap(m => m.toolCalls || []).find(c => c.result?.runId === partialRun.id)?.result;
    ok(partialRun.status === 'partial' && partialEnvelope.status === 'partial' && partialEnvelope.nodes[0].status === 'succeeded' && partialEnvelope.nodes[1].status === 'failed', '部分完成保留前序成果及后序失败，真实信封明确partial');
    await s.mutateConfig(c => { c.permissionMode = 'default'; });
    const runStop = await s.StewardHooks.threadNew({ title: '班组停止权限等待', cwd: home, brief: { userText: '写之前确认。' }, steps: [{ task: 'NODE_WRITE', toolTier: 'edit' }, { task: 'NODE_AFTER' }] }, ctx);
    await until(async () => (await s.readInterventions(runStop.sessionId)).some(iv => iv.status === 'pending'), 'run stop permission');
    const waitingStopRun = (await s.listAgentRuns(runStop.sessionId))[0];
    const runStopResult = await s.StewardHooks.runAction({ sessionId: runStop.sessionId, runId: waitingStopRun.id, action: 'stop' }, ctx);
    await settle(runStop.sessionId);
    ok(runStopResult.ok && (await s.listAgentRuns(runStop.sessionId))[0].status === 'stopped' && !(await s.readInterventions(runStop.sessionId)).some(iv => iv.status === 'pending'), '单独停止班组时也取消本节点权限待决，无挂起或残余批准入口');
    await s.mutateConfig(c => { c.permissionMode = 'auto'; });
    const held = await make('停止传播', ['NODE_HOLD', 'NODE_AFTER']);
    await until(() => holdReached, 'held step');
    const status = await s.StewardHooks.threadStatus({ sessionId: held.sessionId }, ctx);
    const stopped = await s.StewardHooks.threadStop({ sessionId: held.sessionId, expectedExecution: status.execution }, ctx);
    ok(stopped.ok, '原协调线程的带身份停止入口接受停止 ' + JSON.stringify(stopped));
    await settle(held.sessionId);
    const stoppedRun = (await s.listAgentRuns(held.sessionId))[0];
    ok(stoppedRun.status === 'stopped' && stoppedRun.nodes[1].attempts === 0 && !s.activeAgentRuns.has(stoppedRun.id), '停止传播到正在运行的子步骤，后序不启动，无残余运行');
    s.__eval('globalThis.multistepOriginalWorkflow = runAgentWorkflow; globalThis.multistepLateReached = false; runAgentWorkflow = async options => { const result = await globalThis.multistepOriginalWorkflow(options); if (options.runKind === "steward_delegation" && options.contextText.includes("LATE_COORDINATOR")) { globalThis.multistepLateReached = true; await new Promise(resolve => { globalThis.multistepReleaseLate = resolve; }); } return result; };');
    const late = await make('LATE_COORDINATOR', ['NODE_FIRST', 'NODE_SECOND']);
    await until(() => s.__eval('globalThis.multistepLateReached'), 'late result');
    const oldStatus = await s.StewardHooks.threadStatus({ sessionId: late.sessionId }, ctx);
    await s.StewardHooks.threadStop({ sessionId: late.sessionId, expectedExecution: oldStatus.execution }, ctx);
    await s.runSessionTurn({ sessionId: late.sessionId, message: 'NEW_TURN_PRESERVED', source: 'steward' });
    s.__eval('globalThis.multistepReleaseLate(); runAgentWorkflow = globalThis.multistepOriginalWorkflow;');
    await settle(late.sessionId);
    const afterLate = await s.loadSession(late.sessionId);
    ok(afterLate.turnSeq === 2 && afterLate.messages.some(m => m.role === 'user' && m.content === 'NEW_TURN_PRESERVED') && afterLate.messages.some(m => m.role === 'assistant' && m.turnSeq === 2), '旧 DAG 迟到收尾不能覆盖新回合消息、交付和序号');
    const crash = { ...failedRun, id: 'run_deadbeef1234', status: 'running', permissionModeAtLaunch: 'auto', nodes: failedRun.nodes.map((n, i) => ({ ...n, status: i ? 'queued' : 'running', toolTier: 'read', attempts: i ? 0 : 1 })) };
    await s.saveAgentRun(crash);
    await s.mutateConfig(c => { c.autonomyAutoResume = true; });
    await s.markInterruptedAgentRuns(); await s.autoResumeInterruptedRuns();
    const recovered = (await s.listAgentRuns(crash.sessionId)).find(r => r.id === crash.id);
    ok(recovered.status === 'paused' && recovered.resumeTierReasons.some(r => r.reason === 'delegation_result_unknown') && !s.activeAgentRuns.has(crash.id), '重启且开启自动恢复，未知步骤仍暂停核对，不重放纯读步骤');
    ok(s.classifyRunResumeTier({ kind: 'orchestrate_agents', permissionModeAtLaunch: 'auto', nodes: [{ status: 'queued', toolTier: 'read' }] }, 'auto').tier === 'auto_resumable', '普通工作流原有恢复分级保持可用');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { if (fake) await fake.close(); t.done({ exit: true }); }
})();
