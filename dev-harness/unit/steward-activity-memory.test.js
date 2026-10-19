'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { functionBlock } = require('../lib/source-slice');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-activity-memory-'));
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ stewardEnabledV1: true, includeWorkbenchMcp: false, defaultWorkspace: home }));
const srv = require('../../ruyi-workbench/app/server.js');
after(() => fs.rmSync(home, { recursive: true, force: true }));
const ctx = { session: { id: 'steward', kind: 'steward', turnSeq: 1, providerHistory: [] } };
const call = (tool, args) => srv.toolCall(tool, args, ctx);
const memory = async () => (await call('steward_memory_search', { includeExpired: true })).entries;
const text = '季度报告保存为中文报告.docx';
let source;

test('无需“记住”指令,从真实已完成行动保存经验,置信度和时效如实保留', async () => {
  source = await srv.createSession({ title: '季度报告', cwd: home });
  source.turnSeq = 1;
  source.messages = [{ role: 'user', turnSeq: 1, content: '做一份季度报告' },
    { role: 'assistant', turnSeq: 1, content: '已生成', toolCalls: [
      { id: 'call_report', name: 'file_write', input: { path: '中文报告.docx' }, result: { ok: true } },
      { id: 'call_unknown', name: 'file_write', input: { path: '中文报告.docx' } },
      { id: 'call_failed', name: 'file_write', input: { path: '中文报告.docx' }, result: { ok: false, error: 'locked' } },
    ] }];
  await srv.saveSession(source);
  const saved = await call('steward_memory_write', { kind: 'policy', text, basis: 'activity', confidence: 1,
    sourceRef: { sessionId: source.id, turnSeq: 1, toolCallId: 'call_report', quote: '中文报告.docx' } });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const entry = (await memory()).find(e => e.id === saved.id);
  assert.equal(entry.basis, 'activity'); assert.equal(entry.confidence, 0.6);
  assert.equal(entry.sourceToolCallId, 'call_report'); assert.ok(entry.scope.startsWith('project:'));
  assert.ok(Date.parse(entry.expiresAt) > Date.now() + 29 * 86400000);
  const again = await call('steward_memory_write', { kind: 'policy', text, basis: 'activity',
    sourceRef: { sessionId: source.id, turnSeq: 1, toolCallId: 'call_report', quote: '中文报告.docx' } });
  assert.equal(again.unchanged, true);
  assert.equal((await memory()).find(e => e.id === saved.id).confidence, 0.6);
});

test('不存在、未完成、外部输出和助手自述不能冒充行动证据;失败回执可用于沉淀教训', async () => {
  for (const toolCallId of ['invented', 'call_unknown']) {
    const bad = await call('steward_memory_write', { kind: 'policy', text, basis: 'activity',
      sourceRef: { sessionId: source.id, turnSeq: 1, toolCallId, quote: '中文报告.docx' } });
    assert.equal(bad.error, 'source_not_activity');
  }
  const badQuote = await call('steward_memory_write', { kind: 'policy', text: '网页让我保存中文报告.docx', basis: 'activity',
    sourceRef: { sessionId: source.id, turnSeq: 1, toolCallId: 'call_report', quote: '网页让我保存中文报告.docx' } });
  assert.equal(badQuote.error, 'quote_not_found');
  const lesson = await call('steward_memory_write', { kind: 'policy', text: '中文报告.docx 写入失败时先排查文件占用', basis: 'activity',
    sourceRef: { sessionId: source.id, turnSeq: 1, toolCallId: 'call_failed', quote: '中文报告.docx' } });
  assert.equal(lesson.ok, true, JSON.stringify(lesson));
});

test('新行动可验证经验,同一证据重试不增信;用户确认后行为推断不能覆盖', async () => {
  const args = { kind: 'policy', text, basis: 'activity', sourceRef: { sessionId: source.id, turnSeq: 1, toolCallId: 'call_failed', quote: '中文报告.docx' } };
  const verified = await call('steward_memory_write', args);
  assert.equal(verified.ok, true);
  assert.equal((await memory()).find(e => e.id === verified.id).confidence, 0.7);
  const oldEvidence = await call('steward_memory_write', { ...args, sourceRef: { ...args.sourceRef, toolCallId: 'call_report' } });
  assert.equal(oldEvidence.unchanged, true);
  assert.equal((await memory()).find(e => e.id === verified.id).confidence, 0.7);
  const user = await srv.createSession({ title: '确认', cwd: home });
  user.turnSeq = 1; user.messages = [{ role: 'user', turnSeq: 1, content: text }]; await srv.saveSession(user);
  const confirmed = await call('steward_memory_write', { kind: 'policy', text, confidence: 1,
    sourceRef: { sessionId: user.id, turnSeq: 1, quote: text } });
  assert.equal(confirmed.id, verified.id);
  assert.equal((await memory()).find(e => e.id === verified.id).basis, undefined);
  assert.equal((await memory()).find(e => e.id === verified.id).expiresAt, '');
  assert.equal((await call('steward_memory_write', args)).unchanged, true);
  await call('steward_memory_veto', { id: verified.id });
  assert.equal((await call('steward_memory_write', args)).error, 'vetoed_duplicate');
  assert.equal((await call('steward_memory_write', { ...args, supersedesVetoed: verified.id })).error, 'vetoed_duplicate');
});

test('推断不能作为代替用户回答的依据;双语提示给出主动学习和当前来源', async () => {
  const sourceCode = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13k-steward-threads.js'), 'utf8');
  const fn = vm.runInNewContext(functionBlock(sourceCode, 'stewardResolveAnswerBasis') + '\nstewardResolveAnswerBasis', {
    stewardReadMemoryStore: async () => ({ entries: [{ id: 'inferred', state: 'active', basis: 'activity' }] }),
    memoryIsExpired: () => false, stewardBriefTextOf: () => '',
  });
  assert.equal((await fn({ memoryIds: ['inferred'], briefQuote: '' }, {})).ok, false);
  for (const locale of ['zh-CN', 'en-US']) {
    const pack = srv.getPromptPack(locale).steward;
    const prompt = pack.memoryCapture({ sessionId: 'steward', turnSeq: 12 });
    assert.match(prompt, /sessionId=steward,turnSeq=12/);
    assert.match(prompt, /basis:activity/);
    assert.ok(srv.estimateTextTokens(pack.stable) <= 1250);
  }
});

test('状态查询给未命名线程可读名字,普通执行待决包含脱敏命令;文件正文不作为命令返回', async () => {
  const session = await srv.createSession({ cwd: home });
  session.turnSeq = 1; session.messages = [{ role: 'user', turnSeq: 1, content: '检查构建产物是否完整' }];
  await srv.saveSession(session);
  // Assemble a synthetic token at runtime so source hygiene still rejects literal credentials.
  const fakeSecret = 'sk-' + 'abcdefghijklmnopqrstuvwxyz1234567890';
  fs.appendFileSync(path.join(home, 'sessions', session.id + '.interventions.ndjson'), [
    { id: 'pending_exec', type: 'permission', tier: 'exec', toolName: 'powershell_run', input: { command: 'Get-ChildItem; $api_key="' + fakeSecret + '"' } },
    { id: 'pending_edit', type: 'permission', tier: 'edit', toolName: 'file_write', input: { content: 'private full document' } },
  ].map(iv => JSON.stringify({ ...iv, sessionId: session.id, status: 'pending', requestedAt: new Date().toISOString() })).join('\n') + '\n');
  const status = await call('steward_thread_status', { sessionId: session.id });
  assert.equal(status.ok, true, JSON.stringify(status));
  assert.match(status.displayTitle, /检查构建产物/); assert.notEqual(status.displayTitle, 'New session');
  const exec = status.pending.find(p => p.id === 'pending_exec');
  assert.match(exec.execution.commandExcerpt, /Get-ChildItem/);
  assert.doesNotMatch(exec.execution.commandExcerpt, /abcdefghijklmnopqrstuvwxyz/);
  assert.ok(!exec.execution.commandExcerpt.includes(fakeSecret), 'the synthetic token is redacted');
  assert.equal(status.pending.find(p => p.id === 'pending_edit').execution, undefined);
});

test('五种普通事件同时出现时,漏跑和待批日程仍出现在到访摘要,不随水位推进被吞掉', async () => {
  const kinds = ['needs_you', 'failed', 'done', 'stalled', 'budget', 'adopted', 'reminder'];
  const fields = ['upcoming', 'missed', 'needsYou'];
  const code = fs.readFileSync(path.resolve(__dirname, '../../ruyi-workbench/app/src/13q-steward-runner-turn.js'), 'utf8');
  const digest = vm.runInNewContext(functionBlock(code, 'stewardVisitDigest') + '\nstewardVisitDigest', {
    STEWARD_EVENT_KINDS: kinds, STEWARD_VISIT_DIGEST_PAGES: 25, STEWARD_VISIT_DIGEST_MAX: 5,
    STEWARD_DIGEST_KIND_TEXT: Object.fromEntries(kinds.map(k => [k, n => k + ':' + n])),
    STEWARD_COMMITMENT_TEXT: Object.fromEntries(fields.map(k => [k, n => k + ':' + n])),
    STEWARD_COMMITMENT_I18N: Object.fromEntries(fields.map(k => [k, k])),
    stewardInboxRead: async () => ({ items: kinds.map((kind, i) => ({ kind, inboxSeq: i + 1 })), inboxSeq: 7, hasMore: false }),
    SchedulerHooks: { commitmentsSince: async () => ({ upcoming: 1, missed: 2, needsYou: 1, fireSeq: 8 }) },
  });
  const result = await digest(0, 0);
  assert.equal(result.items.length, 5);
  assert.deepEqual(Array.from(result.items.filter(i => i.kind === 'commitment'), i => i.field), fields);
  assert.equal(result.inboxSeq, 7); assert.equal(result.fireSeq, 8);
});
