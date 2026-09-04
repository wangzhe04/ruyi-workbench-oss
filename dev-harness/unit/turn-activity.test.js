#!/usr/bin/env node
'use strict';

// 112c: 回合活动状态机的纯函数门。状态机是两壳状态条/速报的唯一真身,它错了两处一起错,
// 所以判定放在这里逐条钉死(阶段优先级、步数、等待原因、通知队列、切会话清零)。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'turn-activity.js');
const moduleSource = fs.readFileSync(MODULE_PATH, 'utf8');
let modulePromise;
function loadModule() {
  if (!modulePromise) {
    const dataUrl = 'data:text/javascript;base64,' + Buffer.from(moduleSource, 'utf8').toString('base64');
    modulePromise = import(dataUrl);
  }
  return modulePromise;
}

// 固定时钟:状态机的每个时间量都必须来自注入的 now(),不能偷偷读 Date.now()。
function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: ms => { value += ms; return value; } };
}

describe('turn-activity: 阶段判定', () => {
  it('回合未开始 = idle,状态条不出现', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    const snapshot = activity.snapshot();
    assert.equal(snapshot.phase, 'idle');
    assert.equal(snapshot.turnActive, false);
    assert.equal(snapshot.turnElapsedMs, 0);
  });

  it('meta/assistant_delta 开回合 -> thinking,并记住已运行时长', async () => {
    const { createTurnActivity } = await loadModule();
    const c = clock();
    const activity = createTurnActivity({ now: c.now });
    activity.consume({ type: 'meta', command: 'claude' });
    c.advance(3500);
    const snapshot = activity.snapshot();
    assert.equal(snapshot.phase, 'thinking');
    assert.equal(snapshot.turnElapsedMs, 3500);
  });

  it('tool_use -> calling_tool,tool_result 回到 thinking,步数只增不减', async () => {
    const { createTurnActivity } = await loadModule();
    const c = clock();
    const activity = createTurnActivity({ now: c.now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_use', id: 'a', name: 'file_read' });
    assert.equal(activity.snapshot().phase, 'calling_tool');
    assert.equal(activity.snapshot().tool.name, 'file_read');
    activity.consume({ type: 'tool_result', id: 'a', content: 'x' });
    assert.equal(activity.snapshot().phase, 'thinking');
    assert.equal(activity.snapshot().toolCalls, 1);
    activity.consume({ type: 'tool_use', id: 'b', name: 'powershell_run' });
    assert.equal(activity.snapshot().toolCalls, 2);
  });

  it('子代理自己的 tool_use 不计主线步数', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_use', id: 'a', name: 'file_read', subagentId: 's1' });
    assert.equal(activity.snapshot().toolCalls, 0);
    assert.equal(activity.snapshot().phase, 'thinking');
  });

  it('优先级:等你拍板 > 压缩 > 等资源 > 编排 > 工具 > 思考', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_use', id: 'a', name: 'file_read' });
    assert.equal(activity.snapshot().phase, 'calling_tool');
    activity.consume({ type: 'agent_workflow', state: 'start', id: 'r1', nodeCount: 3, concurrency: 2 });
    assert.equal(activity.snapshot().phase, 'orchestrating');
    activity.consume({ type: 'agent_resource', state: 'waiting', resources: ['workspace'], blockers: ['node-2'] });
    assert.equal(activity.snapshot().phase, 'waiting_resource');
    activity.consume({ type: 'compact', phase: 'started', mode: 'external' });
    assert.equal(activity.snapshot().phase, 'compacting');
    activity.consume({ type: 'permission_request', requestId: 'p1', toolName: 'file_write' });
    assert.equal(activity.snapshot().phase, 'waiting_you');
  });

  it('等资源解除后回落,并保留阻塞者说明直到解除', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'agent_resource', state: 'waiting', resources: ['workspace:/a'], blockers: ['turn:s1:3'] });
    const waiting = activity.snapshot();
    assert.equal(waiting.phase, 'waiting_resource');
    assert.deepEqual(waiting.resourceWait.blockers, ['turn:s1:3']);
    activity.consume({ type: 'agent_resource', state: 'acquired', resources: ['workspace:/a'] });
    assert.equal(activity.snapshot().phase, 'thinking');
    assert.equal(activity.snapshot().resourceWait, null);
  });

  it('压缩 completed/failed 都解除 compacting(否则会永远挂在压缩态)', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'compact', phase: 'started' });
    assert.equal(activity.snapshot().phase, 'compacting');
    activity.consume({ type: 'compact', phase: 'completed', beforeTokens: 100, afterTokens: 40 });
    assert.equal(activity.snapshot().phase, 'thinking');
    activity.consume({ type: 'compact', phase: 'started' });
    activity.consume({ type: 'compact', phase: 'failed', error: 'boom' });
    assert.equal(activity.snapshot().phase, 'thinking');
  });

  it('待决被答复后解除;回合结束不清待决(停在等你拍板是有效终态)', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'ask_user', questionId: 'q1', questions: [] });
    assert.equal(activity.snapshot().phase, 'waiting_you');
    activity.consume({ type: 'question_answer', questionId: 'q1' });
    assert.equal(activity.snapshot().phase, 'thinking');
    activity.consume({ type: 'plan', planId: 'p1', markdown: '# plan' });
    activity.consume({ type: 'result', ok: true });
    assert.equal(activity.snapshot().phase, 'waiting_you');
    assert.equal(activity.snapshot().turnActive, false);
  });

  it('result/error 收回合,活动工具与编排一并清空', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_use', id: 'a', name: 'file_read' });
    activity.consume({ type: 'agent_workflow', state: 'start', id: 'r1', nodeCount: 2 });
    activity.consume({ type: 'error', error: 'network down' });
    const snapshot = activity.snapshot();
    assert.equal(snapshot.phase, 'idle');
    assert.equal(snapshot.tool, null);
    assert.equal(snapshot.workflow, null);
    assert.equal(snapshot.ended.ok, false);
  });

  it('reset 清零(切会话/切任务时两壳都调它)', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_use', id: 'a', name: 'file_read' });
    activity.consume({ type: 'ask_user', questionId: 'q1' });
    activity.reset();
    assert.equal(activity.snapshot().phase, 'idle');
    assert.equal(activity.snapshot().toolCalls, 0);
    assert.equal(activity.snapshot().waiting, null);
  });
});

describe('turn-activity: 112b 补齐的六族事件', () => {
  it('tool_progress 用服务端计时纠正本地秒表,并带出软/硬预算档', async () => {
    const { createTurnActivity } = await loadModule();
    const c = clock();
    const activity = createTurnActivity({ now: c.now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_use', id: 'a', name: 'powershell_run' });
    activity.consume({ type: 'tool_progress', id: 'a', name: 'powershell_run', state: 'waiting', elapsedMs: 45_000 });
    assert.equal(activity.snapshot().tool.elapsedMs, 45_000);
    activity.consume({ type: 'tool_progress', id: 'a', state: 'budget_soft', elapsedMs: 60_000, warnMs: 60_000 });
    assert.equal(activity.snapshot().tool.budget, 'soft');
    activity.consume({ type: 'tool_progress', id: 'a', state: 'budget_hard', elapsedMs: 120_000, deadlineMs: 120_000 });
    assert.equal(activity.snapshot().tool.budget, 'hard');
  });

  it('tool_use 缺 id 时只计步数,不登记活动工具(否则阶段会卡死到回合结束)', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_use', name: 'file_read' }); // 无 id
    const snapshot = activity.snapshot();
    assert.equal(snapshot.toolCalls, 1);
    assert.equal(snapshot.tool, null);
    assert.equal(snapshot.phase, 'thinking');
  });

  it('tool_progress 认不出的 id 不会凭空造出一个工具卡', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_progress', id: 'ghost', state: 'waiting', elapsedMs: 1000 });
    assert.equal(activity.snapshot().phase, 'thinking');
    assert.equal(activity.snapshot().tool, null);
  });

  it('budget_guard / loop_recovery / tool_budget 进有界通知队列,同族只留最新一条', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'budget_guard', state: 'warning', axis: 'turn_tokens', spent: 8000, budget: 10000 });
    activity.consume({ type: 'budget_guard', state: 'tripped', axis: 'turn_tokens', spent: 10200, budget: 10000 });
    activity.consume({ type: 'loop_recovery', state: 'injected', tool: 'file_read', attempt: 2, max: 3, remaining: 1 });
    activity.consume({ type: 'tool_budget', state: 'extended', from: 40, to: 60, hardLimit: 80 });
    const notices = activity.snapshot().notices;
    assert.equal(notices.filter(n => n.key === 'budget_guard').length, 1);
    assert.equal(notices.find(n => n.key === 'budget_guard').data.state, 'tripped');
    assert.equal(notices.find(n => n.key === 'budget_guard').severity, 'attention');
    assert.equal(notices.find(n => n.key === 'loop_recovery').data.attempt, 2);
    assert.equal(notices.find(n => n.key === 'tool_budget').data.to, 60);
  });

  it('通知队列有上限,老的先出局(状态条不会被刷成日志)', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    for (let i = 0; i < 8; i++) activity.consume({ type: 'subagent_no_progress', subagentId: `s${i}`, count: i + 1 });
    assert.ok(activity.snapshot().notices.length <= 4, 'notices bounded');
  });

  it('subagent_no_progress / adaptive_tool_budget 落在对应成员上', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'subagent', id: 's1', state: 'start', task: '查资料' });
    activity.consume({ type: 'subagent_no_progress', subagentId: 's1', count: 3 });
    activity.consume({ type: 'adaptive_tool_budget', subagentId: 's1', previousLimit: 20, nextLimit: 35, hardLimit: 60 });
    const member = activity.snapshot().subagents.find(s => s.id === 's1');
    assert.equal(member.stalledCount, 3);
    assert.equal(member.budget.nextLimit, 35);
    activity.consume({ type: 'subagent_progress', subagentId: 's1', note: '生成中 · 800 字' });
    assert.equal(activity.snapshot().subagents.find(s => s.id === 's1').stalledCount, 0, '有进展即清零');
  });

  it('usage / context_estimate 供两壳共用的上下文电量', async () => {
    const { createTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'context_estimate', contextTokens: 12_000, contextWindow: 64_000, estimated: true });
    assert.deepEqual(activity.snapshot().context, { tokens: 12_000, window: 64_000, estimated: true });
    activity.consume({ type: 'usage', contextTokens: 20_000, contextWindow: 64_000 });
    assert.equal(activity.snapshot().context.tokens, 20_000);
    assert.equal(activity.snapshot().context.estimated, false);
  });
});

describe('turn-activity: 事件登记表与服务端枚举同构的前置条件', () => {
  it('CONSUMED 与 IGNORED 无交集,且 CONSUMED 每一项在 consume 里真有分支', async () => {
    const { TURN_ACTIVITY_CONSUMED, TURN_ACTIVITY_IGNORED } = await loadModule();
    const consumed = new Set(TURN_ACTIVITY_CONSUMED);
    const overlap = TURN_ACTIVITY_IGNORED.filter(type => consumed.has(type));
    assert.deepEqual(overlap, [], 'a type cannot be both consumed and ignored');
    const missing = TURN_ACTIVITY_CONSUMED.filter(type => !moduleSource.includes(`case '${type}':`));
    assert.deepEqual(missing, [], 'every declared consumed type needs a switch branch');
  });

  it('阶段表与实际可产出的阶段一致', async () => {
    const { TURN_ACTIVITY_PHASES, createTurnActivity } = await loadModule();
    assert.ok(TURN_ACTIVITY_PHASES.includes('idle'));
    const activity = createTurnActivity({ now: clock().now });
    assert.ok(TURN_ACTIVITY_PHASES.includes(activity.snapshot().phase));
  });
});

describe('turn-activity: 渲染层', () => {
  const t = (key, params = {}) => `${key}(${Object.values(params).join(',')})`;

  it('describeTurnActivity 拼出「阶段 · 动作 · 已运行 · 第几次工具调用」', async () => {
    const { createTurnActivity, describeTurnActivity } = await loadModule();
    const c = clock();
    const activity = createTurnActivity({ now: c.now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'tool_use', id: 'a', name: 'file_read' });
    c.advance(12_000);
    const view = describeTurnActivity(activity.snapshot(), t);
    assert.match(view.text, /turnActivity\.phase\.calling_tool/);
    assert.match(view.text, /turnActivity\.action\.tool\(file_read\)/);
    assert.match(view.text, /turnActivity\.part\.turnElapsed\(12s\)/);
    assert.match(view.text, /turnActivity\.part\.step\(1\)/);
  });

  it('沉默不足 10 秒不报「上次输出多久前」(每秒都说等于没说)', async () => {
    const { createTurnActivity, describeTurnActivity } = await loadModule();
    const c = clock();
    const activity = createTurnActivity({ now: c.now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'assistant_delta', text: 'hi' });
    c.advance(5_000);
    assert.ok(!describeTurnActivity(activity.snapshot(), t).text.includes('part.silence'));
    c.advance(6_000);
    assert.ok(describeTurnActivity(activity.snapshot(), t).text.includes('part.silence'));
  });

  it('等资源带出阻塞者;硬预算把严重度抬到 attention', async () => {
    const { createTurnActivity, describeTurnActivity } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'agent_resource', state: 'waiting', resources: ['workspace'], blockers: ['node-2'] });
    const blocked = describeTurnActivity(activity.snapshot(), t);
    assert.match(blocked.text, /waiting\.resourceBlocked\(workspace,node-2\)/);
    assert.equal(blocked.severity, 'warn');

    const other = createTurnActivity({ now: clock().now });
    other.consume({ type: 'meta' });
    other.consume({ type: 'tool_use', id: 'a', name: 'powershell_run' });
    other.consume({ type: 'tool_progress', id: 'a', state: 'budget_hard', elapsedMs: 1000, deadlineMs: 1000 });
    assert.equal(describeTurnActivity(other.snapshot(), t).severity, 'attention');
  });

  it('通知渲染成人话;未知通知不渲染空壳', async () => {
    const { createTurnActivity, describeTurnActivity, describeTurnNotice } = await loadModule();
    const activity = createTurnActivity({ now: clock().now });
    activity.consume({ type: 'meta' });
    activity.consume({ type: 'loop_recovery', state: 'injected', tool: 'file_read', attempt: 1, max: 3 });
    const view = describeTurnActivity(activity.snapshot(), t);
    assert.equal(view.notices.length, 1);
    assert.match(view.notices[0].text, /notice\.loopRecovery\(file_read,1,3\)/);
    assert.equal(describeTurnNotice({ key: 'not_a_notice', data: {} }, t), '');
  });

  it('formatElapsedMs 与 Preview 任务单同一显示形状', async () => {
    const { formatElapsedMs } = await loadModule();
    assert.equal(formatElapsedMs(0), '0s');
    assert.equal(formatElapsedMs(59_000), '59s');
    assert.equal(formatElapsedMs(80_000), '1m 20s');
    assert.equal(formatElapsedMs(3_900_000), '1h 05m');
    assert.equal(formatElapsedMs(-1), '');
    assert.equal(formatElapsedMs('nope'), '');
  });

  it('空快照不炸(壳层在回合外也会调它)', async () => {
    const { describeTurnActivity } = await loadModule();
    const view = describeTurnActivity(null, t);
    assert.equal(view.text, '');
    assert.deepEqual(view.notices, []);
  });
});
