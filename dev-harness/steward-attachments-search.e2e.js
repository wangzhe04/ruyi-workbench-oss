'use strict';
require('./lib/self-isolate-home');
// 真会话/上传记录/模型回合与递话账本,仅模型端点是假件。无外部平台或真实用户数据。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('STEWARD ATTACHMENTS SEARCH');
const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-attachments-'));
process.env.RUYI_HOME = root;
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const s = loadServerInternals(['readConfig', 'writeConfig', 'createSession', 'loadSession', 'saveSession', 'makeAttachmentRecord', 'stewardRunAct', 'stewardImplThreadContinue', 'stewardRelayChannelFor', 'runSessionTurn', 'searchSessionsByContent', 'stewardImplThreadsSearch', 'stewardLaunchingTurns', 'stewardContinueAttachments', 'ensureStewardSession', 'SessionFullTextHooks']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const act = (sid, message, attachments) => ({ kind: 'tool', tool: 'steward_thread_continue', args: { sessionId: sid, message, attachments } });
async function idle(sid) {
  for (let n = 0; n < 200; n++) {
    if (!s.stewardLaunchingTurns.has(sid) && s.stewardRelayChannelFor(sid).channel === 'turn') return;
    await sleep(25);
  }
  throw new Error('turn did not settle: ' + sid);
}
(async () => {
  let fake;
  try {
    fake = await startFakeProvider({ handler: req => {
      const last = req.messages.filter(m => m.role === 'user').at(-1);
      return { frames: textFrames(['附件已读取。', '处理完成。']), delayMs: String(last && last.content).includes('SLOW_KEEP') ? 200 : 1 };
    } });
    const cfg = { ...(await s.readConfig()), activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
      defaultWorkspace: root, workspaces: [{ path: root, name: '隔离工作区' }], autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false,
      stewardEnabledV1: true, providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }] };
    await s.writeConfig(cfg);
    const target = await s.createSession({ title: '报告', cwd: root });
    const other = await s.createSession({ title: '报告', cwd: root });
    const file = await s.makeAttachmentRecord({ name: '补充.csv', data: Buffer.from('月份,金额\n十月,123').toString('base64') });
    const forwarded = { ...file, path: path.join(root, 'forged.txt'), textPreview: 'FORGED_PREVIEW' };
    const picture = await s.makeAttachmentRecord({ name: '图表.png', data: Buffer.from('media-fixture').toString('base64') });
    const audio = await s.makeAttachmentRecord({ name: '说明.wav', data: Buffer.from('media-fixture').toString('base64') });
    const media = await s.stewardContinueAttachments([{ ...picture, textPreview: '图表 OCR' }, { ...audio, textPreview: '音频转写' }]);
    ok(media.ok && media.attachments[0].kind === 'image' && media.attachments[1].kind === 'audio' && media.attachments[0].textPreview === '图表 OCR' && media.attachments[1].textPreview === '音频转写', '图像与音频保留类型和上传端提供的派生预览');
    const input = act(target.id, '按新表修改报告', [forwarded]);
    const [first, duplicate] = await Promise.all([
      s.stewardRunAct(input, cfg, { attemptId: 'attachment-attempt-01' }),
      s.stewardRunAct(input, cfg, { attemptId: 'attachment-attempt-01' }),
    ]);
    ok(first.ok && first.executed && first.result.channel === 'turn' && duplicate.replayed, '手选已有任务带附件起回合,并发重试只执行一次');
    await idle(target.id);
    const loaded = await s.loadSession(target.id);
    const users = loaded.messages.filter(m => m.role === 'user');
    ok(users.length === 1 && users[0].content === '按新表修改报告', '原话逐字保存且没有重复用户消息');
    ok(users[0].attachments.length === 1 && users[0].attachments[0].path === await fs.promises.realpath(file.path) && users[0].attachments[0].size === fs.statSync(file.path).size && users[0].attachments[0].textPreview.includes('123') && !JSON.stringify(users[0]).includes('FORGED_PREVIEW'), '附件按 id/name 重新核对路径、正文与大小');
    ok((await s.loadSession(other.id)).messages.length === 0, '同名的另一条任务没有收到消息或附件');
    ok(fake.requests.some(r => JSON.stringify(r.body).includes('补充.csv') && JSON.stringify(r.body).includes('123')), '上传内容经现有附件管线送达模型');
    const check = await s.stewardRunAct(null, cfg, { attemptId: 'attachment-attempt-01', check: true });
    ok(check.applied, '成功递送可只读核对回执');
    const gone = await s.makeAttachmentRecord({ name: '已过期.txt', data: Buffer.from('old').toString('base64') });
    fs.unlinkSync(gone.path);
    const failedInput = act(target.id, '附件过期后重试', [gone]);
    const failed = await s.stewardRunAct(failedInput, cfg, { attemptId: 'attachment-attempt-02' });
    ok(failed.result.error === 'attachment_missing' && failed.executed === false, '附件已删除时整次拒绝,不只递文字');
    ok(!(await s.stewardRunAct(null, cfg, { attemptId: 'attachment-attempt-02', check: true })).applied, '被拒绝的工具结果不记成已执行');
    fs.writeFileSync(gone.path, 'new');
    const retry = await s.stewardRunAct(failedInput, cfg, { attemptId: 'attachment-attempt-02' });
    ok(retry.executed && !retry.replayed, '同一 attempt 修复附件后可以真实重试');
    await idle(target.id);
    const ensured = await s.ensureStewardSession(await s.readConfig());
    if (!ensured.ok || !ensured.session || ensured.session.kind !== 'steward') throw new Error('persisted steward session unavailable');
    const ctx = { session: ensured.session, turnSeq: ensured.session.turnSeq, trigger: 'user' };
    const traversal = await s.stewardImplThreadContinue({ sessionId: target.id, message: '不要递送', attachments: [{ id: file.id, name: '../config.json' }] }, ctx, cfg);
    ok(!traversal.ok && traversal.error === 'invalid_request', '越目录附件名被拒绝');
    const missingTarget = await s.stewardImplThreadContinue({ sessionId: 'missing-thread', message: '不要另开一件', attachments: [file] }, ctx, cfg);
    ok(!missingTarget.ok && missingTarget.error === 'not_found', '目标已删除时不创建新任务');
    await s.stewardImplThreadContinue({ sessionId: target.id, message: 'SLOW_KEEP' }, ctx, cfg);
    for (let i = 0; i < 100 && s.stewardRelayChannelFor(target.id).channel !== 'steer'; i++) await sleep(10);
    const busy = await s.stewardRunAct(act(target.id, '等空闲再递附件', [file]), cfg, { attemptId: 'attachment-attempt-03' });
    ok(!busy.executed && busy.result.error === 'attachment_channel_unsupported', '在跑任务拒绝整次附件递送,不偷换成纯文字插话');
    await idle(target.id);
    const retryBusy = await s.stewardRunAct(act(target.id, '等空闲再递附件', [file]), cfg, { attemptId: 'attachment-attempt-03' });
    ok(retryBusy.executed && !retryBusy.replayed, '空闲后同一次重试可以递到');
    await idle(target.id);
    for (const body of [{ sessionId: 'deleted-target', expectedCwd: root }, { sessionId: target.id, expectedCwd: root + '-changed' }]) {
      let code = '';
      try { await s.runSessionTurn({ ...body, source: 'steward', message: '不能错发', attachments: [file] }); } catch (error) { code = error.code; }
      ok(code === 'SESSION_NOT_FOUND' || code === 'SESSION_WORKSPACE_CHANGED', '启动时再次拒绝目标消失或工作区变化');
    }
    const long = await s.createSession({ title: '历史报告', cwd: root });
    const needle = 'UNINDEXED_FINAL_NEEDLE';
    long.messages = Array.from({ length: 25 }, (_, i) => ({ id: 'long_tail_' + i, role: i === 24 ? 'assistant' : 'user', content: (i === 24 ? needle + ' ' : 'earlier material ' + i + ' ') + 'a'.repeat(500), turnSeq: i + 1, createdAt: new Date().toISOString() }));
    await s.saveSession(long);
    let bareCode = '';
    try { await s.searchSessionsByContent(needle, 10); } catch (error) { bareCode = error.code; }
    ok(bareCode === 'session_search.scope_required', '无真实调用域的正文搜索严格拒绝');
    const scoped = work => s.SessionFullTextHooks.withModel(ctx, 'steward_threads_search', null, work);
    // M3 retired the 8192-character bounded adapter: 13d delegates to 13as's
    // admitted message-shard consumer. A miss can no longer be its oracle.
    const found = await scoped(() => s.searchSessionsByContent(needle, 10));
    const hit = found.results.find(row => row.id === long.id);
    ok(hit && hit.snippet.includes(needle) && hit.reference.sessionId === long.id && hit.reference.messageId === 'long_tail_24'
      && hit.reference.turnSeq === 25 && hit.reference.source === 'content' && hit.reference.coordinate === 'utf16'
      && hit.reference.matchStart === 0 && hit.reference.matchEnd === needle.length
      && long.messages.slice(0, 24).reduce((sum, row) => sum + row.content.length, 0) > 8192,
    '授权搜索真实命中旧8192范围之后的消息并返回原文来源坐标');
    ok(found.scope.mode === 'message_shards' && found.scope.messageText === true && found.scope.sampling === false
      && found.scope.maxQueryChars === 256 && found.scope.coverageUnit === 'committed-display-message-sources'
      && found.coverage.fullTextSampling === false && Number.isInteger(found.coverage.attachments.unverifiedFullText)
      && found.scope.fullText === found.coverage.complete
      && (found.coverage.attachments.unverifiedFullText === 0 || found.scope.fullText === false),
    '消息分片不采样且如实声明附件未验证时的覆盖缺口');
    const stewardFound = await scoped(() => s.stewardImplThreadsSearch({ q: needle }, ctx, cfg));
    ok(stewardFound.ok && stewardFound.results.some(row => row.sessionId === long.id)
      && stewardFound.scope.mode === 'message_shards' && stewardFound.scope.sampling === false,
    '管家搜索在同一真实调用域内也能找到长会话末段');
    await s.writeConfig({ ...(await s.readConfig()), sessionSearchIndexV1: false });
    const disabledCfg = await s.readConfig();
    const metadata = await scoped(() => s.stewardImplThreadsSearch({ q: needle }, ctx, disabledCfg));
    ok(metadata.ok && metadata.results.length === 0 && metadata.degraded === 'index_disabled'
      && metadata.scope.mode === 'metadata_only' && metadata.scope.messageText === false && metadata.scope.fullText === false
      && metadata.scope.note === '正文搜索已关闭，仅搜索会话元数据。',
    '关闭正文搜索后正文独有词不命中并明确仅检索元数据');
  } catch (error) { t.fail(error.stack); }
  finally { if (fake) await fake.close(); }
  t.done({ exit: true });
})();
