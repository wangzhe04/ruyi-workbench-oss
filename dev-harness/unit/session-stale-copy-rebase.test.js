'use strict';
// saveSession 拿到一份【旧副本】时不再整份重写正文。真源码、临时 HOME、真读盘真写盘。
//
// 修前(代码走查实证):任何「loadSession → 改一个字段 → saveSession」的调用方(updateSessionMeta 的
// 非延后分支、调度器、若干管家路径……)如果在读与存之间有别的写者追加了消息,它那份更短的数组会让
// saveSession 走慢路径、用旧数组整份重写 —— 别人刚追加的消息全丢,而它自己的改动照样落上。
// 现在:消息是盘上正文的严格前缀(更短、逐行相同)= 旧副本,先把盘上多出来的尾巴补进它的数组再写。
//   [R1] 旧副本改标题 ⇒ 并发追加的消息与新标题都在。
//   [R2] 撤回(rewindBump)照样能截短。
//   [R3] 有意截短(opts.shrinkBody,管家归档)照样能截短。
//   [R4] 同一个写者只弹掉 providerHistory 的悬空 user 行(被停止的回合)⇒ 照样弹掉,不被补回。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-stale-copy-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { createSession, loadSession, saveSession } = srv;

async function seeded() {
  const s = await createSession({ title: 't', cwd: root });
  s.messages = [{ role: 'user', content: 'm1' }];
  s.providerHistory = [{ role: 'user', content: 'm1' }];
  await saveSession(s);
  return s.id;
}
const contents = arr => arr.map(m => m.content);

test('[R1] 旧副本改标题 ⇒ 并发追加的消息与新标题都在', async () => {
  const id = await seeded();
  const stale = await loadSession(id);
  const turn = await loadSession(id);
  turn.messages.push({ role: 'assistant', content: 'm2' }, { role: 'user', content: 'm3' });
  turn.providerHistory.push({ role: 'assistant', content: 'm2' }, { role: 'user', content: 'm3' });
  await saveSession(turn);
  stale.title = 'renamed';
  await saveSession(stale);
  const after = await loadSession(id);
  assert.equal(after.title, 'renamed');
  assert.deepEqual(contents(after.messages), ['m1', 'm2', 'm3'], '并发回合追加的消息被旧副本整份重写丢掉了');
  assert.deepEqual(contents(after.providerHistory), ['m1', 'm2', 'm3']);
  assert.deepEqual(contents(stale.messages), ['m1', 'm2', 'm3'], '补齐应落在调用方手里那份对象上');
});

test('[R2] 撤回(rewindBump)照样能截短', async () => {
  const id = await seeded();
  const s = await loadSession(id);
  s.messages.push({ role: 'assistant', content: 'm2' });
  await saveSession(s);
  const r = await loadSession(id);
  r.messages = r.messages.slice(0, 1);
  await saveSession(r, { rewindBump: true, throwIfStale: true, writer: 'rewind' });
  assert.deepEqual(contents((await loadSession(id)).messages), ['m1']);
});

test('[R3] opts.shrinkBody 有意截短 ⇒ 照样截短', async () => {
  const id = await seeded();
  const s = await loadSession(id);
  s.messages.push({ role: 'assistant', content: 'm2' });
  await saveSession(s);
  const a = await loadSession(id);
  a.messages = [];
  a.providerHistory = [];
  await saveSession(a, { shrinkBody: true, writer: 'steward_archive' });
  const after = await loadSession(id);
  assert.deepEqual(after.messages, []);
  assert.deepEqual(after.providerHistory, []);
});

test('[R4] 只弹掉 providerHistory 的悬空 user 行 ⇒ 不被补回', async () => {
  const id = await seeded();
  const s = await loadSession(id);
  s.messages.push({ role: 'user', content: 'm2' });
  s.providerHistory.push({ role: 'user', content: 'm2' });
  await saveSession(s);
  s.providerHistory.pop();
  await saveSession(s);
  const after = await loadSession(id);
  assert.deepEqual(contents(after.messages), ['m1', 'm2']);
  assert.deepEqual(contents(after.providerHistory), ['m1']);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
