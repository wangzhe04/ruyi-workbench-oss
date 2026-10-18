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
const s = loadServerInternals(['readConfig', 'writeConfig', 'createSession', 'loadSession', 'saveSession', 'makeAttachmentRecord', 'stewardRunAct', 'stewardImplThreadContinue', 'stewardRelayChannelFor', 'runSessionTurn', 'searchSessionsByContent', 'stewardImplThreadsSearch', 'stewardLaunchingTurns', 'stewardContinueAttachments']);
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
    ok(users[0].attachments.length === 1 && users[0].attachments[0].path === file.path && users[0].attachments[0].textPreview.includes('123') && !JSON.stringify(users[0]).includes('FORGED_PREVIEW'), '附件按 id/name 重新核对路径、正文与大小');
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
    const ctx = { session: { id: 'steward', kind: 'steward' }, trigger: 'user' };
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
    long.messages = Array.from({ length: 25 }, (_, i) => ({ role: 'user', content: (i === 24 ? 'UNINDEXED_FINAL_NEEDLE ' : 'earlier material ' + i + ' ') + 'a'.repeat(500), turnSeq: i + 1, createdAt: new Date().toISOString() }));
    await s.saveSession(long);
    const found = await s.searchSessionsByContent('UNINDEXED_FINAL_NEEDLE', 10);
    ok(found.scope.fullText === false && found.scope.maxCharsPerSession === 8192 && !found.results.some(row => row.id === long.id), '长会话末段未命中时如实返回有界索引范围');
    const metadata = await s.stewardImplThreadsSearch({ q: 'no-such-task' }, ctx, { ...cfg, sessionSearchIndexV1: false });
    ok(metadata.scope && metadata.scope.mode === 'metadata_only' && metadata.scope.fullText === false && metadata.scope.note.includes('未命中'), '管家未命中也携带范围说明,不宣称从未做过');
  } catch (error) { t.fail(error.stack); }
  finally { if (fake) await fake.close(); }
  t.done({ exit: true });
})();
