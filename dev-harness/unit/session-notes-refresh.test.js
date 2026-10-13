'use strict';
// 真主回合/工具循环/notes 读写,仅把 L2 摘要结果生产器换成确定性返回。
// 同回合第二次压缩省略了第一次的教学时,合并旁车仍须刷新回下一发请求;
// 笔记写入在飞时,下一发请求不能先读旧快照再继续。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { loadServerInternals } = require('../lib/server-internals');
const { startFakeProvider, textFrames, toolCallFrames } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-notes-refresh-'));
for (const key of ['RUYI_HOME', 'WIN_CLAUDE_WORKBENCH_HOME', 'HOME', 'USERPROFILE']) process.env[key] = root;
const s = loadServerInternals([
  'createSession', 'saveSession', 'runSessionTurn', 'readSessionNotes', 'sessionNotesPath',
  'sessionNotesWriteChains', 'flushSessionIndex', 'runAutoCompaction',
], { withEval: true });
const originalAutoCompaction = s.runAutoCompaction;
const stateKey = '__ruyiNotesRefreshScenario';
let scenario = null;
let fake;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const SUMMARY_TOKEN = 'LEARNED_MATCHING_WORKFLOW_8675309';
function summary(decisions) {
  return '【目标】按已教流程配表\n【已确认的决定】\n' + decisions
    + '\n【未完成事项】\n无\n【当前执行状态】\n已完成:配表;正在进行:无;阻塞:无;下一步:等待新请求'
    + '\n【关键文件与上下文】\n目标表.xlsx';
}
function armScenario(summaries, toolRounds) {
  scenario = { summaries, toolRounds, compactCalls: 0, requests: [], nextRequest: null };
  globalThis[stateKey] = scenario;
}
async function runTurn(title) {
  const session = await s.createSession({ title, cwd: root });
  await s.saveSession(session);
  return { session, finished: s.runSessionTurn({ sessionId: session.id, message: '按我教过的配表步骤再做一次', onEvent: () => {} }) };
}

before(async () => {
  fake = await startFakeProvider({ handler(req) {
    scenario.requests.push(req.body);
    if (scenario.nextRequest) scenario.nextRequest();
    const index = scenario.requests.length;
    return index <= scenario.toolRounds
      ? toolCallFrames('todo_write', { items: [{ text: '配表步骤 ' + index, status: 'in_progress' }] }, 'notes_' + index)
      : textFrames('完成');
  } });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', defaultWorkspace: root,
    desktopMcp: { enabled: false }, includeWorkbenchMcp: false,
    runtimeSessionNotesV1: true, runtimeSessionNotesMergeV1: true, runtimeSessionNotesInjectV1: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }), 'utf8');
  s.__eval(`runAutoCompaction = async function(ctx) {
    const state = globalThis.${stateKey};
    const index = state.compactCalls++;
    if (index === 0 || index > state.summaries.length) return { compacted: false };
    const value = state.summaries[index - 1];
    const user = ctx.history.findLast(message => message && message.role === 'user');
    return {
      level: 2, compacted: true, sc: { ok: true, summary: value }, summaryProvider: ctx.provider,
      reseeded: [{ role: 'user', content: '【压缩摘要】\\n' + value }, { role: 'assistant', content: '收到，继续。' }, user],
      before2: 400, after2: 120, watermark: 120,
    };
  }`);
});

after(async () => {
  globalThis[stateKey] = originalAutoCompaction;
  s.__eval(`runAutoCompaction = globalThis.${stateKey}`);
  delete globalThis[stateKey];
  if (fake) await fake.close();
  await Promise.all([...s.sessionNotesWriteChains.values()].map(chain => chain.catch(() => {})));
  await s.flushSessionIndex();
  fs.rmSync(root, { recursive: true, force: true });
});

test('同回合两次 L2:第二次摘要省略旧教学时,下一发请求回注合并笔记', async () => {
  armScenario([summary(SUMMARY_TOKEN + ':先保留源表,再按账号匹配写目标列,最后核对总数'), summary('沿用最新配表决定')], 2);
  const { session, finished } = await runTurn('two compactions');
  await finished;
  // 修前旁车是 fire-and-forget,先排空它再确认教学并没有在磁盘上丢失。
  await Promise.all([...s.sessionNotesWriteChains.values()].map(chain => chain.catch(() => {})));
  assert.equal(scenario.requests.length, 3, '工具循环确实走了三次模型调用');
  assert.match(await s.readSessionNotes(session.id), new RegExp(SUMMARY_TOKEN), '旧教学仍在合并笔记里');
  assert.ok(JSON.stringify(scenario.requests[1].messages).includes(SUMMARY_TOKEN), '第一次摘要已经带着刚学到的流程');
  assert.ok(JSON.stringify(scenario.requests[2].messages).includes(SUMMARY_TOKEN), '第二次压缩后刷新旁车,旧教学仍进入同回合下一发请求');
});

test('L2 笔记写入尚在飞时,下一发请求等写完再继续', async () => {
  armScenario([summary(SUMMARY_TOKEN)], 1);
  let writeReached, releaseWrite, nextRequest;
  const reached = new Promise(resolve => { writeReached = resolve; });
  const blocked = new Promise(resolve => { releaseWrite = resolve; });
  const requested = new Promise(resolve => { nextRequest = resolve; });
  const originalWriteFile = fsp.writeFile;
  let notesPath = '';
  let notesWritePending = false;
  let requestedBeforeNotesCommitted = false;
  fsp.writeFile = async function(file, ...args) {
    if (notesPath && String(file).startsWith(notesPath + '.') && String(file).endsWith('.tmp')) {
      notesWritePending = true;
      writeReached();
      await blocked;
      const value = await originalWriteFile.call(this, file, ...args);
      notesWritePending = false;
      return value;
    }
    return originalWriteFile.call(this, file, ...args);
  };
  let finished;
  try {
    const session = await s.createSession({ title: 'notes write pending', cwd: root });
    await s.saveSession(session);
    notesPath = s.sessionNotesPath(session.id);
    scenario.nextRequest = () => {
      if (scenario.requests.length > 1) {
        if (notesWritePending) requestedBeforeNotesCommitted = true;
        nextRequest();
      }
    };
    finished = s.runSessionTurn({ sessionId: session.id, message: '继续配表', onEvent: () => {} });
    await reached;
    // 写入已确定被扣住。观察窗口只是给错误的提前请求机会,不测产品性能。
    const first = await Promise.race([requested.then(() => 'requested'), delay(1000).then(() => 'waiting')]);
    releaseWrite();
    await finished;
    await Promise.all([...s.sessionNotesWriteChains.values()].map(chain => chain.catch(() => {})));
    assert.equal(first, 'waiting', '旁车写还没完成时不发下一次模型请求');
    assert.equal(requestedBeforeNotesCommitted, false, '请求没有越过在飞的笔记写入');
    assert.match(await s.readSessionNotes(session.id), new RegExp(SUMMARY_TOKEN));
  } finally {
    releaseWrite();
    if (finished) await finished.catch(() => {});
    fsp.writeFile = originalWriteFile;
  }
});
