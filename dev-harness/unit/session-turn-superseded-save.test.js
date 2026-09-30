'use strict';
// 回合代数闸(审计 t4):过期回合的存盘不许盖掉同会话更新的回合。真源码、临时 HOME、真读盘真写盘。
//   [S1] 回合 1 手里的旧对象(turnSeq 1),盘上已是回合 2(turnSeq 2)的正文:带 throwIfTurnSuperseded 的收尾存
//        抛 SESSION_TURN_SUPERSEDED、盘上一个字节都不动。修前这个旗子不存在,旧对象整份写回,回合 2 的消息全没了。
//   [S2] 同样的场景,回合中途存带 dropIfTurnSuperseded:静默丢弃(不抛),盘上仍是回合 2。
//   [S3] 一次普通的停止(没有更新的回合,turnSeq 相等):带旗子的存照常落盘。
//   [S4] 引擎层:回合 1 卡在慢工具里,同会话发回合 2 并跑完,回合 1 稍后收尾 —— 回合 2 的 messages 与
//        providerHistory 都还在(三个引擎共用 02 saveTurnFinalSession,这里走 provider 引擎 09)。
//   [S5] 结构锁:09/05/05b 三个引擎的收尾存都走 saveTurnFinalSession,被顶替时不派 thread.done、不记任务进度;
//        09 工具循环里的存盘都带 dropIfTurnSuperseded。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-turn-superseded-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { createSession, loadSession, saveSession, runSessionTurn } = srv;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const texts = s => (s.messages || []).map(m => m.role + ':' + String(m.content || ''));

async function twoCopies() {
  const s = await createSession({ title: 't', cwd: root });
  s.turnSeq = 1;
  s.messages.push({ role: 'user', content: 'FIRST', turnSeq: 1 });
  s.providerHistory.push({ role: 'user', content: 'FIRST' });
  await saveSession(s);
  const stale = await loadSession(s.id);          // 回合 1 起跑时手里那份
  const fresh = await loadSession(s.id);          // 回合 2 装载的那份
  assert.notEqual(stale, fresh, '前提:两份是不同的对象');
  fresh.turnSeq = 2;
  fresh.messages.push({ role: 'user', content: 'SECOND', turnSeq: 2 }, { role: 'assistant', content: 'second reply', turnSeq: 2 });
  fresh.providerHistory.push({ role: 'user', content: 'SECOND' }, { role: 'assistant', content: 'second reply' });
  await saveSession(fresh);
  stale.messages.push({ role: 'assistant', content: 'first (late)', turnSeq: 1, source: 'aborted' });
  return { id: s.id, stale };
}

test('[S1] 收尾存:盘上已是更新的回合 → 抛 SESSION_TURN_SUPERSEDED,盘上不动', async () => {
  const { id, stale } = await twoCopies();
  await assert.rejects(saveSession(stale, { throwIfTurnSuperseded: true }), e => e && e.code === 'SESSION_TURN_SUPERSEDED');
  const disk = await loadSession(id);
  assert.equal(disk.turnSeq, 2);
  assert.deepEqual(texts(disk), ['user:FIRST', 'user:SECOND', 'assistant:second reply']);
  assert.deepEqual(disk.providerHistory.map(m => m.content), ['FIRST', 'SECOND', 'second reply']);
});

test('[S2] 回合中途存:dropIfTurnSuperseded 静默丢弃', async () => {
  const { id, stale } = await twoCopies();
  await saveSession(stale, { dropIfTurnSuperseded: true });
  const disk = await loadSession(id);
  assert.deepEqual(texts(disk), ['user:FIRST', 'user:SECOND', 'assistant:second reply']);
});

test('[S3] 普通停止(turnSeq 相等):带旗子照常落盘', async () => {
  const s = await createSession({ title: 't', cwd: root });
  s.turnSeq = 1;
  s.messages.push({ role: 'user', content: 'ONLY', turnSeq: 1 });
  await saveSession(s);
  const same = await loadSession(s.id);
  same.messages.push({ role: 'assistant', content: 'stopped', turnSeq: 1, source: 'aborted' });
  await saveSession(same, { throwIfTurnSuperseded: true });
  assert.deepEqual(texts(await loadSession(s.id)), ['user:ONLY', 'assistant:stopped']);
});

test('[S4] 引擎层:过期回合收尾之后,更新回合的消息与 providerHistory 都还在', async () => {
  const pending = new Set();
  const hang = http.createServer((req, res) => { pending.add(res); setTimeout(() => { try { res.end('late'); } catch { /* gone */ } }, 2500); });
  await new Promise(r => hang.listen(0, '127.0.0.1', r));
  const fake = await startFakeProvider({
    handler(req) {
      const all = JSON.stringify(req.messages);
      if (!req.stream || /起名字/.test(all)) return textFrames('{"title":"t","gist":"g"}');
      const last = req.messages[req.messages.length - 1];
      if (/SECOND/.test(JSON.stringify(last.content))) return [...textFrames('second reply'), usageFrame(8, 4)];
      if (last.role === 'tool') return [...textFrames('first done'), usageFrame(8, 4)];
      return toolCallFrames('http_request', { url: 'http://127.0.0.1:' + hang.address().port + '/x', timeoutMs: 30000 }, 'call_a');
    },
  });
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      configSchema: 9, permissionMode: 'bypass', defaultWorkspace: root, desktopMcp: { enabled: false },
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
      activeProvider: 'fake',
    }), 'utf8');
    const s = await createSession({ title: 'live', cwd: root });
    let toolStarted = null;
    const started = new Promise(r => { toolStarted = r; });
    const turn1 = runSessionTurn({ sessionId: s.id, message: 'FIRST', cwd: root, source: 'http', onEvent: e => { if (e && e.type === 'tool_use') toolStarted(); } });
    turn1.catch(() => {});
    await Promise.race([started, sleep(15000)]);
    await sleep(300);
    await runSessionTurn({ sessionId: s.id, message: 'SECOND', cwd: root, source: 'http', onEvent: () => {} });
    await Promise.race([turn1.catch(() => {}), sleep(15000)]);
    await sleep(3000);                               // 慢工具(若还在跑)这时也回来了
    const disk = await loadSession(s.id);
    const t = texts(disk);
    assert.ok(t.includes('user:SECOND') && t.includes('assistant:second reply'), '回合 2 的消息还在:' + JSON.stringify(t));
    assert.ok(disk.providerHistory.some(m => m.role === 'assistant' && m.content === 'second reply'), '回合 2 的 providerHistory 还在');
    assert.equal(disk.turnSeq, 2);
  } finally {
    for (const res of pending) { try { res.destroy(); } catch { /* ignore */ } }
    try { hang.closeAllConnections && hang.closeAllConnections(); hang.close(); } catch { /* ignore */ }
    await fake.close();
    try { fs.unlinkSync(path.join(root, 'config.json')); } catch { /* ignore */ }
  }
});

test('[S5] 结构锁:三个引擎的收尾存都走回合代数闸,被顶替时不派 thread.done', () => {
  // [S4] 在停止即时生效之后,过期回合多半抢在更新回合收尾之前写完(更新回合的收尾存再把正文写对),引擎层行为
  // 测不出「收尾存有没有过闸」;这里钉结构:收尾那一存是 saveTurnFinalSession(运行时语义由 [S1]–[S3] 钉),
  // thread.done 与任务进度都看它的结果。
  const { functionBlock } = require('../lib/source-slice');
  const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
  const engines = [
    ['09-workflow.js', 'runOpenAiTurn'],
    ['05-claude-engine.js', 'runClaudeTurn'],
    ['05b-kimi-bridge.js', 'runKimiAcpTurnPrepared'],
  ];
  for (const [file, fn] of engines) {
    const body = functionBlock(fs.readFileSync(path.join(SRC, file), 'utf8'), fn);
    assert.ok(body.length > 2000, `切到了 ${file} ${fn}`);
    assert.match(body, /const turnSuperseded = !\(await saveTurnFinalSession\(session, '[a-z-]+'\)\);/, `${fn} 收尾存走 saveTurnFinalSession`);
    assert.match(body, /if \(!turnSuperseded\) RUYI_EVENTS\.emit\('thread\.done'/, `${fn} 被顶替时不派 thread.done`);
    assert.match(body, /if \(session\.mission && !turnSuperseded\) await bumpMissionChangeSeq\(/, `${fn} 被顶替时不记任务进度`);
  }
  // 09 回合中途的存盘(工具轨迹、计划、强压重试)都带 dropIfTurnSuperseded。
  const run = functionBlock(fs.readFileSync(path.join(SRC, '09-workflow.js'), 'utf8'), 'runOpenAiTurn');
  const afterStart = run.slice(run.indexOf('const turnSaveOpts'));
  const loop = afterStart.slice(afterStart.indexOf('for (let iter = 0; ; iter++)'));
  assert.ok(loop.length > 10000, '切到了工具循环');
  assert.equal((loop.match(/saveSession\(session\)/g) || []).length, 0, '工具循环里还有不过闸的 saveSession(session)');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
