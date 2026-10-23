'use strict';
require('../lib/self-isolate-home');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeProvider, toolCallFrames, textFrames } = require('../lib/fake-openai-provider');
const { loadServerInternals } = require('../lib/server-internals');
const { functionBlock } = require('../lib/source-slice');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-supervision-'));
process.env.RUYI_HOME = root;
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
let fake, api, cfg;
const CONTINUE = '请继续完成上一个未完成的任务。';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let highestStep = 0;
before(async () => {
  fake = await startFakeProvider({ handler(req) {
    const msgs = req.messages || [];
    const all = msgs.map(m => String(m.content || '')).join('\n');
    if (!all.includes('[WATCH_LONG]')) return textFrames(JSON.stringify({ say: '已核对进度。', why: '现场', acts: [], actions: [] }));
    const step = msgs.filter(m => m.role === 'user' && String(m.content).includes(CONTINUE)).length;
    highestStep = Math.max(highestStep, step);
    const lastUser = msgs.findLastIndex(m => m.role === 'user');
    if (!msgs.slice(lastUser + 1).some(m => m.role === 'tool')) {
      return toolCallFrames('todo_write', { items: Array.from({ length: 7 }, (_, i) => ({ id: 's' + i, text: '步骤 ' + i, status: i < step ? 'done' : 'pending' })) }, 'step_' + step);
    }
    return textFrames(step >= 7 ? '全部任务已经完成。' : '这批已记录。要我继续吗？');
  }});
  cfg = {
    configSchema: 8, permissionMode: 'auto', engineMode: 'interactive', activeProvider: 'fake',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'fake', model: 'm', models: [{ id: 'm', label: 'm' }] }],
    desktopMcp: { enabled: false, autodetect: false }, autoImportClaudeCodeMcp: false,
    includeWorkbenchMcp: false, subagentMaxPerTurn: 0, defaultWorkspace: root, recentWorkspaces: [],
    stewardEnabledV1: true, stewardProviderId: 'fake', stewardModel: 'm', stewardPollMs: 120000,
    stewardMaxTurnsPerHour: 120, stewardMaxCostPerDay: 0, stewardGlobalMaxCostPerDay: 0,
    stewardGlobalMaxTurnsPerHour: 2000, stewardThreadBriefV1: false, stewardConversationRetention: 'forever',
  };
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
  api = loadServerInternals(['createSession', 'updateSessionMeta', 'loadSession', 'saveSession', 'runSessionTurn',
    'startStewardInbox', 'stopStewardInbox', 'stewardRunnerRuntime', 'EventStreamHooks', 'StewardHooks',
    'stewardContinuationOnly', 'stewardContinueUnfinishedGate', 'stewardSelfServeInbox', 'stewardApplyPresenceGate',
    'stewardCircuitCheck', 'stewardParseReply', 'buildStewardSystemPrompt', 'defaultConfig', 'normalizeConfig',
    'agentNodeContextWindow', 'providerContextWindow', 'stewardContextBudget', 'resolveToolIterationBudget',
    'shouldExtendToolIterationBudget', 'stewardImplThreadRead', 'stewardRecoveryEvents', 'claudeSubAgentTurnBudget']);
});
after(async () => {
  api?.stopStewardInbox();
  await fake?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test('空确认可以自动继续，新的操作和真正的选择不能冒充空确认', () => {
  for (const text of ['要我继续吗？', '第一步完成。要我继续做剩下的吗？', 'Shall I continue?', '你说继续，我就接着按批往下推']) assert.equal(api.stewardContinuationOnly(text), true, text);
  for (const text of ['要我继续删除整个磁盘吗？', '选 A 还是 B？', '授权支付后继续吗？', '全部完成。']) assert.equal(api.stewardContinuationOnly(text), false, text);
});

test('所有默认上下文至少 1M，明确指定的小窗口仍生效', () => {
  const defaults = api.defaultConfig();
  assert.equal(defaults.stewardContextBudgetTokens, 1000000);
  for (const model of ['new-model', 'claude-new', 'deepseek-future', 'gpt-4o']) {
    const provider = { id: 'p', model };
    assert.ok(api.providerContextWindow(provider, model) >= 1000000, model);
    assert.ok(api.agentNodeContextWindow({ engine: 'openai', model }, provider, defaults) >= 1000000, model);
    assert.ok(api.agentNodeContextWindow({ engine: 'claude', model }, null, defaults) >= 1000000, model);
  }
  assert.equal(api.providerContextWindow({ id: 'p', contextWindow: 64000 }, 'm'), 64000);
  assert.equal(api.stewardContextBudget({}, { stewardContextBudgetRatio: 0.8 }, 1000000), 800000);
  const client = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/chat-render-primitives.js'), 'utf8');
  const guess = require('node:vm').runInNewContext('(' + functionBlock(client, 'ctxWindowGuess') + ')');
  for (const model of ['claude-new', 'deepseek-chat', 'qwen', 'gpt-4o', 'unknown']) assert.ok(guess(model) >= 1000000, model);
  const updated = api.normalizeConfig({ stewardContextBudgetTokens: 200000, stewardConversationRetention: '24h', agentNodeWrapUpMs: 1800000 }).config;
  assert.equal(updated.stewardContextBudgetTokens, 1000000);
  assert.equal(updated.stewardConversationRetention, 'forever');
  assert.equal(updated.agentNodeWrapUpMs, 0);
  const explicit = api.normalizeConfig({ stewardContextBudgetTokens: 200000, stewardConversationRetention: '24h', agentNodeWrapUpMs: 1800000,
    configExplicitKeysV1: ['stewardContextBudgetTokens', 'stewardConversationRetention', 'agentNodeWrapUpMs'] }).config;
  assert.equal(explicit.stewardContextBudgetTokens, 200000);
  assert.equal(explicit.stewardConversationRetention, '24h');
  assert.equal(explicit.agentNodeWrapUpMs, 1800000);
});

test('300/1000 次之后有真实进展仍扩展；陈旧进展不扩展', () => {
  const policy = api.resolveToolIterationBudget(100, '读一下文件');
  for (const iter of [300, 1000, 5000]) assert.equal(api.shouldExtendToolIterationBudget({ currentLimit: iter, hardLimit: policy.hardLimit, iter, lastProgressIter: iter - 1, progressEvents: 30, progressAtLastExtension: 20 }), true);
  assert.equal(api.shouldExtendToolIterationBudget({ currentLimit: 5000, hardLimit: policy.hardLimit, iter: 5000, lastProgressIter: 4900, progressEvents: 30, progressAtLastExtension: 20 }), false);
  assert.equal(api.claudeSubAgentTurnBudget(undefined, { builtin: true, budgets: { claude: 100 } }), 0);
  assert.equal(api.claudeSubAgentTurnBudget(0, { budgets: { claude: 100 } }), 0);
  assert.equal(api.claudeSubAgentTurnBudget(2, { builtin: true, budgets: { claude: 100 } }), 2);
  assert.equal(api.claudeSubAgentTurnBudget(undefined, { budgets: { claude: 80 } }), 80);
  assert.equal(api.claudeSubAgentTurnBudget(undefined, { builtin: true, source: 'global', budgets: { claude: 25 } }), 25);
});

test('其他线程的在场信号不吞监工事件；无需动作的历史通知不熔断新事件', async () => {
  const original = api.EventStreamHooks.presenceSnapshot;
  api.EventStreamHooks.presenceSnapshot = () => [{ lens: 'classic', sessionId: 'sess_elsewhere' }];
  try {
    const events = Array.from({ length: 9 }, (_, i) => ({ kind: 'done', sessionId: 'sess_watch' + i, payload: { source: 'session_turn' } }));
    assert.equal(api.stewardApplyPresenceGate(events).length, 9);
    api.stewardRunnerRuntime.noProgress = 100;
    assert.equal(await api.stewardCircuitCheck(cfg, 'inbox'), null);
  } finally { api.EventStreamHooks.presenceSnapshot = original; }
});

test('一批 9 条线程全处理，结构化动作第 6 条之后不丢弃', async () => {
  const original = api.StewardHooks.threadContinue;
  const received = [];
  api.StewardHooks.threadContinue = async args => { received.push(args.sessionId); return { ok: true }; };
  try {
    const events = [];
    for (let i = 0; i < 9; i++) {
      const s = await api.createSession({ title: 'watch-' + i, cwd: root });
      await api.updateSessionMeta(s.id, { stewardWatch: true, stewardWatchNote: '继续原任务直到完成' });
      const fresh = await api.loadSession(s.id);
      fresh.turnSeq = 1;
      fresh.messages = [{ role: 'assistant', content: '要我继续吗？', turnSeq: 1, createdAt: new Date().toISOString() }];
      await api.saveSession(fresh);
      events.push({ kind: 'done', sessionId: s.id, inboxSeq: i + 1, payload: { source: 'session_turn' } });
    }
    const result = await api.stewardSelfServeInbox(events, { id: 'steward' }, cfg);
    assert.equal(result.executed.length, 9);
    assert.equal(received.length, 9);
    const actions = events.map(e => ({ tool: 'steward_thread_continue', args: { sessionId: e.sessionId, message: CONTINUE } }));
    assert.equal(api.stewardParseReply(JSON.stringify({ say: '继续盯', acts: [], actions })).actions.length, 9);
  } finally { api.StewardHooks.threadContinue = original; }
});

test('监工委托落盘后每轮重新注入；第 7 次深读仍可执行', async () => {
  const s = await api.createSession({ title: 'persistent-watch', cwd: root });
  await api.updateSessionMeta(s.id, { stewardWatch: true, stewardWatchNote: '先核验交付，再推进下一批' });
  assert.equal((await api.loadSession(s.id)).stewardWatchNote, '先核验交付，再推进下一批');
  const prompt = await api.buildStewardSystemPrompt({ id: 'steward', cwd: root }, cfg, {});
  assert.ok(prompt.volatile.includes('先核验交付，再推进下一批'));
  for (let i = 0; i < 8; i++) {
    const read = await api.stewardImplThreadRead({ sessionId: s.id, maxChars: 200 }, { session: { id: 'steward' }, turnSeq: 900 }, cfg);
    assert.equal(read.ok, true, 'read ' + (i + 1));
  }
});

test('监工恢复重新检查未完成任务，显式停止的线程不恢复；重复无进展才暂停', async () => {
  const s = await api.createSession({ title: 'recover-watch', cwd: root });
  await api.updateSessionMeta(s.id, { stewardWatch: true, stewardWatchNote: '完成原来的任务' });
  const fresh = await api.loadSession(s.id);
  fresh.turnSeq = 1;
  fresh.messages = [{ role: 'assistant', content: '要我继续吗？', turnSeq: 1 }];
  await api.saveSession(fresh);
  assert.ok((await api.stewardRecoveryEvents(cfg)).some(e => e.sessionId === s.id));
  await api.updateSessionMeta(s.id, { stewardLastTurn: { seq: 1, ok: false, aborted: true, at: new Date().toISOString() } });
  assert.equal((await api.stewardRecoveryEvents(cfg)).some(e => e.sessionId === s.id), false);
  for (let i = 1; i <= 4; i++) {
    const current = await api.loadSession(s.id);
    current.turnSeq = i + 1;
    current.stewardLastTurn = { seq: i + 1, ok: true, aborted: false };
    current.messages = [{ role: 'assistant', content: '要我继续吗？', turnSeq: i + 1 }];
    await api.saveSession(current);
    const gate = await api.stewardContinueUnfinishedGate({ sessionId: s.id }, cfg);
    if (i < 4) {
      assert.equal(gate.allowed, true, '短时未更新 todo 不应立即停工');
      api.stewardRunnerRuntime.continueUnfinished.set(s.id, { count: gate.count, turnSeq: i + 1,
        progressSig: gate.facts.progressSig, stagnant: gate.stagnant, at: Date.now() });
    } else assert.equal(gate.capped, 'no_progress');
  }
  await api.updateSessionMeta(s.id, { stewardWatch: false });
  assert.equal((await api.stewardContinueUnfinishedGate({ sessionId: s.id }, cfg)).silent, true);
});

test('真实假模型闭环：轮询 120 秒，线程结束即唤醒，跨过 5 次续跑直到 7 步完成', { timeout: 90000 }, async () => {
  const original = api.EventStreamHooks.presenceSnapshot;
  api.EventStreamHooks.presenceSnapshot = () => [{ lens: 'classic', sessionId: 'sess_elsewhere' }];
  await api.startStewardInbox(cfg);
  try {
    const s = await api.createSession({ title: 'long-supervision', cwd: root });
    await api.updateSessionMeta(s.id, { stewardWatch: true, stewardWatchNote: '持续完成七步，不需再问继续' });
    await api.runSessionTurn({ sessionId: s.id, message: '[WATCH_LONG] 执行七步任务', cwd: root, source: 'http', onEvent: () => {} });
    const deadline = Date.now() + 80000;
    let latest;
    while (Date.now() < deadline) {
      latest = await api.loadSession(s.id);
      if (highestStep >= 7 && latest.todos?.every(t => t.status === 'done')) break;
      await sleep(100);
    }
    assert.ok(highestStep >= 7, '无需用户说继续，超过旧的 5 次上限');
    assert.equal(latest.todos?.filter(t => t.status === 'done').length, 7);
  } finally { api.stopStewardInbox(); api.EventStreamHooks.presenceSnapshot = original; }
});
