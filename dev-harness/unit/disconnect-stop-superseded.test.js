'use strict';
// killOnDisconnect:true(可选开)时,【被顶替的】旧回合的流断线不许杀掉同会话的新回合(10 runSessionTurn 的
// handleDisconnect)。真源码、临时 HOME、进程内假 provider,断线用 runSessionTurn 的 signal 模拟。
//   [K1] 回合 1(流 A)在跑 → 同会话同来源发回合 2(流 B,顶替回合 1)→ 回合 1 收尾期间流 A 断线。修前断线处理按
//        【会话】stopSession,停的是活回合登记表里此刻那一个 = 回合 2(结果 aborted、回复丢了)。现在只在
//        turnSettlers 条目仍是本次调用的那一个时才停;回合 2 正常跑完。
//   [K2] 对照:没有更新回合时,流断线照旧停掉本回合(killOnDisconnect 的原语义不变)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeProvider, textFrames, usageFrame } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-disconnect-superseded-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { createSession, runSessionTurn } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const deadline = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

let fake;
const arrived = {};
function hold(req, tag) {
  // 流式挂住:写头、隔一会儿吐一个点,直到连接被 abort 关掉;tag 记下「这一发到了」。
  req.open();
  if (arrived[tag]) arrived[tag]();
  const t = setInterval(() => req.sse({ id: 'x', choices: [{ index: 0, delta: { content: '.' }, finish_reason: null }] }), 50);
  req.res.on('close', () => clearInterval(t));
}

test('setup', async () => {
  fake = await startFakeProvider({
    async handler(req) {
      const all = JSON.stringify(req.messages);
      if (!req.stream || /起名字/.test(all)) return textFrames('{"title":"t","gist":"g"}');
      const last = JSON.stringify(req.messages[req.messages.length - 1].content);
      if (/TURN-ONE/.test(last)) { hold(req, 'one'); return undefined; }
      if (/TURN-SOLO/.test(last)) { hold(req, 'solo'); return undefined; }
      if (/TURN-TWO/.test(last)) { if (arrived.two) arrived.two(); await sleep(1500); return [...textFrames('two done'), usageFrame(8, 4)]; }
      return textFrames('ok');
    },
  });
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    configSchema: 13, permissionMode: 'bypass', defaultWorkspace: root, desktopMcp: { enabled: false }, killOnDisconnect: true,
    configExplicitKeysV1: ['killOnDisconnect'],
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }), 'utf8');
});

test('[K1] 被顶替回合的流断线不杀新回合', async () => {
  const s = await createSession({ title: 'dc', cwd: root });
  const one = new Promise(r => { arrived.one = r; });
  const two = new Promise(r => { arrived.two = r; });
  const discA = new AbortController();
  // 回合 1 收尾(runSessionTurn 的 finally 第一行 onFlush)这一刻流 A 断线 —— 此刻回合 1 已被顶替、还没收完工,
  // 回合 2 在活回合登记表里。
  const turn1 = runSessionTurn({ sessionId: s.id, message: 'TURN-ONE', cwd: root, source: 'http', signal: discA.signal, onEvent: () => {}, onFlush: () => discA.abort() });
  turn1.catch(() => {});
  await Promise.race([one, deadline(15000)]);
  let result2 = null;
  const turn2 = runSessionTurn({ sessionId: s.id, message: 'TURN-TWO', cwd: root, source: 'http', onEvent: e => { if (e && e.type === 'result') result2 = e; } });
  await Promise.race([two, deadline(15000)]);
  await Promise.race([turn1.catch(() => {}), deadline(15000)]);
  await Promise.race([turn2.catch(() => {}), deadline(15000)]);
  assert.ok(result2, '回合 2 有结果事件');
  assert.equal(result2.aborted, false, '回合 2 被旧流的断线停掉了:' + JSON.stringify(result2));
  assert.equal(result2.ok, true);
});

test('[K2] 对照:没有更新回合时,断线照旧停掉本回合', async () => {
  const s = await createSession({ title: 'dc2', cwd: root });
  const solo = new Promise(r => { arrived.solo = r; });
  const disc = new AbortController();
  let result = null;
  const turn = runSessionTurn({ sessionId: s.id, message: 'TURN-SOLO', cwd: root, source: 'http', signal: disc.signal, onEvent: e => { if (e && e.type === 'result') result = e; } });
  turn.catch(() => {});
  await Promise.race([solo, deadline(15000)]);
  await sleep(200);
  disc.abort();
  await Promise.race([turn.catch(() => {}), deadline(15000)]);
  assert.ok(result && result.aborted === true, '断线没有停掉回合:' + JSON.stringify(result));
});

test('teardown', async () => { await fake.close(); });

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
