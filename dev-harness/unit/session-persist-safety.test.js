'use strict';
// hunt2(persist):会话存储的三条数据安全缺陷。真源码、临时 HOME、真读盘真写盘。
//
//   [D1] 删除 vs 进程内「僵尸」写者:删除之前就攥着会话对象的人(被停回合的收尾存、旁路写者)在 unlink
//        之后再 saveSession ⇒ 修前头与正文整份写回,会话复活(列表里又出现)。现在写链内查删除墓碑,整次丢弃。
//   [D2] 删除 vs 活回合:provider 挂住不回,回合在飞时删除 ⇒ 修前被 abort 的回合收尾存把会话写回来
//        (GET 200、列表里还在)。现在删除先立墓碑、等回合 settle,再 unlink。
//   [D3] 墓碑不误伤同 id 重建:删除之后【新建】的对象(createdAt 晚于删除时刻,管家会话就是同 id 重建)照常落盘。
//   [R1] 正文读撞上一次瞬时 EBUSY ⇒ 修前 loadSession 当「正文丢了」,整条会话改名 .corrupt(会话消失)。
//        现在有界重试后照常读回。
//   [R2] 正文一直读不出来(持续 EACCES)⇒ 这一趟回 null,但盘上一个字节都不动(没有 .corrupt),之后照常读回。
//   [N1] 删除会话同时删掉会话笔记旁车与每会话 MCP 配置(内含 loopback token)。
//   [N2] 起引擎生成 MCP 配置时顺手扫掉 7 天没被重写过的 workbench.mcp.<id>.json(共享的那份不动)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { startFakeProvider } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-persist-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const {
  createSession, loadSession, saveSession, deleteSession, listSessions, flushSessionIndex,
  runSessionTurn, writeSessionNotes, sessionNotesPath, generateSessionMcpConfig,
} = srv;
const sessionsDir = path.join(root, 'sessions');
const generatedDir = path.join(root, 'generated');
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 竞速用的兜底超时不能钉住进程(否则赢了之后测试进程还要白等到它到点才退)。
const deadline = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

async function sessionWithMessages(n = 2) {
  const s = await createSession({ title: 't', cwd: root });
  for (let i = 0; i < n; i++) {
    s.messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
    s.providerHistory.push({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i });
  }
  await saveSession(s);
  return s;
}
const filesOf = id => fs.readdirSync(sessionsDir).filter(f => f.startsWith(id));
async function listedIds() { await flushSessionIndex(); return (await listSessions()).map(x => x.id); }

test('[D1] 删除之后,删除之前就攥着会话对象的写者不能把它写回来', async () => {
  const zombie = await sessionWithMessages(2);
  const id = zombie.id;
  zombie.messages.push({ role: 'assistant', content: 'partial' });
  const pending = saveSession(zombie);          // 入链在删除之前(被停回合收尾存的时序)
  await deleteSession(id);
  await pending.catch(() => {});
  zombie.messages.push({ role: 'assistant', content: 'later' });
  await saveSession(zombie);                     // 删除之后又一发(旁路写者)
  assert.deepEqual(filesOf(id), [], '盘上不剩这条会话的任何文件');
  assert.equal(await loadSession(id), null);
  assert.ok(!(await listedIds()).includes(id), '列表里没有它');
});

test('[D2] 活回合在飞时删除:被 abort 的回合收尾存不让会话复活', async () => {
  let arrived = null;
  const reached = new Promise(r => { arrived = r; });
  // provider 挂住:只写 SSE 头、隔一会儿吐一个点,永不结束(直到连接被 abort 关掉)。
  const fake = await startFakeProvider({
    handler(rq) {
      rq.open();
      arrived();
      const t = setInterval(() => rq.sse({ id: 'x', choices: [{ index: 0, delta: { content: '.' }, finish_reason: null }] }), 50);
      rq.res.on('close', () => clearInterval(t));
      return undefined;
    },
  });
  try {
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      configSchema: 9, permissionMode: 'bypass', defaultWorkspace: root, desktopMcp: { enabled: false },
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
      activeProvider: 'fake',
    }), 'utf8');
    const s = await createSession({ title: 'live', cwd: root });
    const id = s.id;
    const turn = runSessionTurn({ sessionId: id, message: 'hello', cwd: root, source: 'http', onEvent: () => {} });
    turn.catch(() => {});
    await Promise.race([reached, deadline(15000)]);
    await sleep(300);                            // 让回合真的在流里
    await deleteSession(id);
    await Promise.race([turn.catch(() => {}), deadline(10000)]);
    await sleep(300);
    assert.deepEqual(filesOf(id), [], '删完、回合收尾之后,盘上不剩这条会话的任何文件');
    assert.equal(await loadSession(id), null, '读不回来');
    assert.ok(!(await listedIds()).includes(id), '列表里没有它');
  } finally {
    await fake.close();
    try { fs.unlinkSync(path.join(root, 'config.json')); } catch { /* ignore */ }
  }
});

test('[D3] 墓碑不误伤:同 id、删除之后新建的对象照常落盘', async () => {
  const old = await sessionWithMessages(2);
  const id = old.id;
  await deleteSession(id);
  await sleep(5);
  const reborn = { ...old, messages: [{ role: 'user', content: 'new' }], providerHistory: [], createdAt: new Date().toISOString() };
  await saveSession(reborn);
  const back = await loadSession(id);
  assert.ok(back, '新对象落盘了');
  assert.equal(back.messages.length, 1);
  await deleteSession(id);
});

test('[R1] 正文读撞上一次瞬时 EBUSY:照常读回,不隔离', async () => {
  const s = await sessionWithMessages(2);
  const orig = fsp.readFile;
  let hits = 0;
  fsp.readFile = async function (p, ...rest) {
    if (String(p).endsWith(s.id + '.messages.ndjson') && hits++ < 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    return orig.call(this, p, ...rest);
  };
  let loaded;
  try { loaded = await loadSession(s.id); } finally { fsp.readFile = orig; }
  assert.ok(loaded, '读回来了');
  assert.equal(loaded.messages.length, 2);
  assert.ok(!filesOf(s.id).some(f => f.endsWith('.corrupt')), '没有任何 .corrupt');
});

test('[R2] 正文一直读不出来:这一趟回 null,但盘上什么都不动,之后照常读回', async () => {
  const s = await sessionWithMessages(2);
  const before = filesOf(s.id).sort();
  const orig = fsp.readFile;
  fsp.readFile = async function (p, ...rest) {
    if (String(p).endsWith(s.id + '.provider.ndjson')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
    return orig.call(this, p, ...rest);
  };
  let loaded;
  try { loaded = await loadSession(s.id); } finally { fsp.readFile = orig; }
  assert.equal(loaded, null);
  assert.deepEqual(filesOf(s.id).sort(), before, '文件原样,没有被改名 .corrupt');
  const again = await loadSession(s.id);
  assert.ok(again && again.messages.length === 2, '锁放开后照常读回');
});

test('[N2] 过期的每会话 MCP 配置被按年龄清掉,新的与共享那份不动', async () => {
  // 扫描每进程一次、在第一次生成每会话 MCP 配置时起跑 —— 所以本条必须排在本文件任何 generateSessionMcpConfig 之前。
  fs.mkdirSync(generatedDir, { recursive: true });
  const stale = path.join(generatedDir, 'workbench.mcp.sess_stale0000000001.json');
  const recent = path.join(generatedDir, 'workbench.mcp.sess_recent000000001.json');
  const shared = path.join(generatedDir, 'workbench.mcp.json');
  for (const f of [stale, recent, shared]) fs.writeFileSync(f, '{}');
  const old = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(shared, old, old);
  const fresh = await generateSessionMcpConfig('sess_fresh000000001', 'auto', []);
  for (let i = 0; i < 50 && fs.existsSync(stale); i++) await sleep(20);
  assert.ok(!fs.existsSync(stale), '8 天没被重写的每会话配置删了');
  assert.ok(fs.existsSync(recent), '最近写过的不动');
  assert.ok(fs.existsSync(shared), '共享的 workbench.mcp.json 不动');
  assert.ok(fs.existsSync(fresh), '刚生成的不动');
});

test('[N1] 删除会话也删会话笔记与每会话 MCP 配置', async () => {
  const s = await sessionWithMessages(2);
  await writeSessionNotes(s.id, '# notes');
  const mcp = await generateSessionMcpConfig(s.id, 'auto', []);
  assert.ok(fs.existsSync(sessionNotesPath(s.id)) && fs.existsSync(mcp));
  await deleteSession(s.id);
  assert.ok(!fs.existsSync(sessionNotesPath(s.id)), 'session-notes.md 删了');
  assert.ok(!fs.existsSync(mcp), 'workbench.mcp.<id>.json 删了');
});
