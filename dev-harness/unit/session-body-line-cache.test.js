'use strict';
// 会话正文 perf:逐行 sha1 去重 + 增量取不读 provider 正文(02 sessionBodyState / readSessionBodyFile /
// SESSION_LOAD_OMIT_PROVIDER / sessionMessagesDelta 的字节戳)。真源码、临时 HOME、真读盘真写盘。
// 修前(--cpu-prof 实测 12 MB / 2000 条会话的一个回合):装载时对两个正文逐行 sha1、保存时把两个数组逐条序列化后
// 再逐行 sha1 与记录比对;增量取照样整份装载(连 provider 正文一起)再逐条序列化算前缀戳。
// 这里钉的是「活没了」(确定性计数器 / sha1 调用次数,不计时)与「结果一个字节都没变」:
//   [H1] 装载 + 存一个新回合:零次单行 sha1(修前:两个正文总行数 + 两个数组总条数,几千次)。
//   [H2] 同一对象连续存(回合中途的节流存):零次单行 sha1;中间条目被就地改写(蒸发的形状,条数不变)仍然被
//        发现 → 全量重写,重读是改写后的内容 —— 检测机制不靠调用方打标记这一条没动。
//   [H3] 行原文超出进程内预算:最旧的会话退成每行 hash(算一次),之后照样走快路径 append、内容逐条对;
//        单条就超预算的会话直接用 hash(与修前同样的活)。
//   [T1] 崩溃残留:撕裂尾行 / 未提交尾巴照旧物理截断,之后的存接在好行边界上(不焊行)。
//   [E1] 外部改盘:同尺寸改中间行(连 mtime 和 inode 都复原)、截短、别的进程追加 —— 完整装载与增量取的装载
//        看到的都是盘上的真内容,处置与修前相同(截断 / 隔离 / 回退)。
//   [D1] 增量取的装载:不读 provider 正文;messages / resumable 与完整装载逐字节相同;前缀戳按字节算,
//        与逐条序列化在整张形状表上逐格相同。
//   [D2] 增量取的装载在前提拿不准时让位给完整装载:写链在跑、上次写失败、要补字段回写、要惰性清理、
//        provider 正文被外部改过;saveSession 拒绝落盘这个视图给出的对象。
//   [D3] 盘上的行不是 JSON.stringify 的原样输出(外部重写成带空格的 JSON)⇒ 字节戳路径不用,逐条序列化,结果同修前。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-body-cache-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { createSession, loadSession, saveSession, sessionBodyPaths, sessionMessagesDelta, detectDanglingTurn, perfCounters } = srv;
const OMIT = 'omitProviderHistory';
const stats = () => ({ ...perfCounters.sessionBody });
const sessionsDir = path.join(root, 'sessions');
const headFile = id => path.join(sessionsDir, id + '.json');
const bodyLines = file => fs.readFileSync(file, 'utf8').split('\n').slice(0, -1);
process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

// sha1 调用计数:包住 crypto.createHash(server.js 与这里是同一个模块对象,调用时才取属性)。
// 与内部计数器无关 —— 修前的代码上同样能数,所以它就是「修前红、修后绿」的那条证据。
async function countSha1(fn) {
  const orig = crypto.createHash;
  let n = 0;
  crypto.createHash = function (alg, ...rest) { if (String(alg).toLowerCase() === 'sha1') n++; return orig.call(this, alg, ...rest); };
  try { await fn(); } finally { crypto.createHash = orig; }
  return n;
}

const zh = '中文内容与标点，';
async function seeded(n = 300, extra = {}) {
  const s = await createSession({ title: 'body-cache', cwd: root });
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) {
      s.messages.push({ role: 'user', content: `u${i} ${zh}`, createdAt: new Date(1700000000000 + i).toISOString() });
      s.providerHistory.push({ role: 'user', content: `u${i}` });
    } else {
      s.messages.push({ role: 'assistant', content: `a${i} ${zh}`.repeat(3), segments: [{ type: 'text', text: 't' + i }, { type: 'tool', id: 't' + i, status: 'done', result: 'r'.repeat(50) }] });
      s.providerHistory.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read', arguments: '{}' } }] });
      s.providerHistory.push({ role: 'tool', tool_call_id: 'c' + i, content: 'ok' });
      s.providerHistory.push({ role: 'assistant', content: `done ${i}` });
    }
  }
  Object.assign(s, extra);
  await saveSession(s);
  // 新会话第一次装载会补默认字段并回写一次(既有行为,与本件无关):先让它发生,后面比的都是「稳态」的装载。
  await loadSession(s.id);
  return s;
}
// 修前 13d 的增量判定算法(逐条序列化),作为对照。
function stampOf(list, n) {
  const h = crypto.createHash('sha1');
  for (let i = 0; i < n; i++) { const line = JSON.stringify(list[i]); h.update((line === undefined ? 'null' : line) + '\n'); }
  return `m1.${n}.${h.digest('hex')}`;
}

test('[H1] 装载 + 存一个新回合:零次单行 sha1(修前几千次)', async () => {
  const s = await seeded(300);
  const bp = sessionBodyPaths(s.id);
  const before = fs.readFileSync(bp.messages);
  const lines = s.messages.length + s.providerHistory.length;
  const c0 = stats();
  let loaded;
  const sha1Calls = await countSha1(async () => {
    loaded = await loadSession(s.id);
    loaded.messages.push({ role: 'user', content: 'next' }, { role: 'assistant', content: 'reply' });
    loaded.providerHistory.push({ role: 'user', content: 'next' }, { role: 'assistant', content: 'reply' });
    await saveSession(loaded);
  });
  assert.ok(sha1Calls < 10, `装载 + 存一回合做了 ${sha1Calls} 次 sha1(两个正文共 ${lines} 行;修前每行至少两次)`);
  assert.equal(perfCounters.sessionBody.lineHashes - c0.lineHashes, 0, '不该再有单行 sha1');
  const after = fs.readFileSync(bp.messages);
  assert.ok(after.subarray(0, before.length).equals(before), '快路径:旧前缀一个字节都没动(只 append)');
  const again = await loadSession(s.id);
  assert.deepEqual(again.messages, loaded.messages);
  assert.deepEqual(again.providerHistory, loaded.providerHistory);
});

test('[H2] 同一对象连续存零次 sha1;中间条目就地改写(条数不变)仍被发现 → 全量重写', async () => {
  const s = await seeded(200);
  const bp = sessionBodyPaths(s.id);
  const c0 = stats();
  for (let i = 0; i < 5; i++) { s.messages.push({ role: 'assistant', content: 'flush' + i }); await saveSession(s); }
  assert.equal(perfCounters.sessionBody.lineHashes - c0.lineHashes, 0);
  const inoBefore = fs.statSync(bp.messages).ino;
  // 蒸发的形状:原地改中间一条的 content,数组长度不变,对象身份不变 —— 没有任何标记。
  s.messages[37].content = 'evaporated';
  s.providerHistory[11].content = 'evaporated-prov';
  await saveSession(s);
  assert.notEqual(fs.statSync(bp.messages).ino, inoBefore, '前缀变了必须全量重写(tmp + rename 换 inode)');
  const again = await loadSession(s.id);
  assert.equal(again.messages[37].content, 'evaporated');
  assert.equal(again.providerHistory[11].content, 'evaporated-prov');
  assert.deepEqual(again.messages, s.messages);
  assert.deepEqual(bodyLines(bp.messages), s.messages.map(m => JSON.stringify(m)), '盘上逐行就是当前数组逐条序列化');
});

test('[H3] 行原文超出预算:最旧的退成 hash,仍走快路径、内容逐条对;单条超预算直接用 hash', async () => {
  const big = n => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i % 10).repeat(1024 * 1024) }));
  const a = await createSession({ title: 'big-a', cwd: root });
  a.messages = big(18); a.providerHistory = [{ role: 'user', content: 'x' }];
  await saveSession(a);
  const c0 = stats();
  const b = await createSession({ title: 'big-b', cwd: root });
  b.messages = big(18); b.providerHistory = [{ role: 'user', content: 'y' }];
  await saveSession(b);                     // 两条合计 ≈ 36M 字符 > 32M 预算 → a 被挤出去、退成 hash
  // 按最近写/读序淘汰:前面几件留下的小会话更旧、先被挤出,所以这里是「至少」a 的行数。
  const demoted = perfCounters.sessionBody.lineHashes - c0.lineHashes;
  assert.ok(demoted >= a.messages.length + a.providerHistory.length, `被挤出的会话每行算一次 hash(退成 hash 形态),实算 ${demoted}`);
  const bp = sessionBodyPaths(a.id);
  const before = fs.readFileSync(bp.messages);
  a.messages.push({ role: 'user', content: 'after-demote' });
  await saveSession(a);                     // 对着 hash 形态比对:照样快路径
  assert.ok(fs.readFileSync(bp.messages).subarray(0, before.length).equals(before), '退成 hash 之后照样只 append');
  a.messages[3].content = 'changed';        // 对着 hash 形态也能发现中间改写
  await saveSession(a);
  const reA = await loadSession(a.id);
  assert.deepEqual(reA.messages.map(m => m.content.slice(0, 12)), a.messages.map(m => m.content.slice(0, 12)));
  const huge = await createSession({ title: 'huge', cwd: root });
  huge.messages = big(34); huge.providerHistory = [];
  const c1 = stats();
  await saveSession(huge);                  // 单条就超预算:不占缓存,直接 hash(与修前同样的活)
  assert.equal(perfCounters.sessionBody.lineHashes - c1.lineHashes, 34);
  huge.messages.push({ role: 'user', content: 'tail' });
  await saveSession(huge);
  const reHuge = await loadSession(huge.id);
  assert.equal(reHuge.messages.length, 35);
  assert.equal(reHuge.messages[34].content, 'tail');
});

test('[T1] 撕裂尾行 / 未提交尾巴照旧物理截断,之后的存接在好行边界上', async () => {
  const s = await seeded(20);
  const bp = sessionBodyPaths(s.id);
  fs.appendFileSync(bp.messages, '{"role":"user","content":"半行', 'utf8');                 // 撕裂(无 \n 结尾)
  fs.appendFileSync(bp.provider, JSON.stringify({ role: 'user', content: 'uncommitted' }) + '\n'); // 未提交尾巴(头没声明)
  const loaded = await loadSession(s.id);
  assert.equal(loaded.messages.length, 20);
  assert.equal(loaded.providerHistory.length, s.providerHistory.length);
  assert.ok(fs.readFileSync(bp.messages, 'utf8').endsWith('\n'), '半行被截掉');
  assert.equal(bodyLines(bp.provider).length, s.providerHistory.length, '未提交尾巴被截掉');
  loaded.messages.push({ role: 'user', content: 'next' });
  loaded.providerHistory.push({ role: 'user', content: 'next' });
  await saveSession(loaded);
  const again = await loadSession(s.id);
  assert.deepEqual(again.messages, loaded.messages, '新行没有焊进残留字节');
  assert.deepEqual(again.providerHistory, loaded.providerHistory, '未提交尾巴没有复活');
});

test('[E1] 外部改盘:同尺寸改中间行(mtime/inode 都复原)、截短、追加 —— 两种装载看到的都是盘上真内容', async () => {
  // (a) 同尺寸、同 inode、mtime 复原:只有读内容才看得出来。
  const s = await seeded(40);
  const bp = sessionBodyPaths(s.id);
  const stamp0 = stampOf(s.messages, 30);
  const st = fs.statSync(bp.messages, { bigint: true });
  const text = fs.readFileSync(bp.messages, 'utf8');
  const target = JSON.stringify(s.messages[4]);
  const edited = target.replace('u4 ', 'U4 ');
  assert.notEqual(edited, target);
  assert.equal(Buffer.byteLength(edited), Buffer.byteLength(target));
  const at = Buffer.byteLength(text.slice(0, text.indexOf(target)));
  const fd = fs.openSync(bp.messages, 'r+');
  try { fs.writeSync(fd, Buffer.from(edited), 0, Buffer.byteLength(edited), at); } finally { fs.closeSync(fd); }
  fs.utimesSync(bp.messages, st.atime, st.mtime);
  const lite = await loadSession(s.id, 0, 0, OMIT);
  assert.equal(lite.messages[4].content.slice(0, 3), 'U4 ', '增量取的装载读的是盘上真内容');
  const omitted = lite.__providerHistoryOmitted;
  assert.ok(omitted && omitted.body === null, '改过的行与记录对不上 → 不给字节视图(不信戳)');
  assert.equal(sessionMessagesDelta(lite.messages, '30', stamp0, omitted.body), null, '客户端手上的旧前缀戳对不上 → 回全量');
  const full = await loadSession(s.id);
  assert.equal(full.messages[4].content.slice(0, 3), 'U4 ');
  full.messages.push({ role: 'user', content: 'next' });
  await saveSession(full);
  assert.equal((await loadSession(s.id)).messages[4].content.slice(0, 3), 'U4 ', '外部改动之后的存保留了盘上内容');
  // (b) 截短到头声明以下(无快照、无 v1bak)→ 两种装载一样:隔离成 .corrupt、回 null。
  for (const view of [null, OMIT]) {
    const t = await seeded(10);
    const tbp = sessionBodyPaths(t.id);
    fs.writeFileSync(tbp.messages, bodyLines(tbp.messages).slice(0, 4).join('\n') + '\n');
    assert.equal(await loadSession(t.id, 0, 0, view), null, `截短 → null(view=${view})`);
    assert.ok(fs.existsSync(headFile(t.id) + '.corrupt') && fs.existsSync(tbp.messages + '.corrupt'), `截短 → 隔离(view=${view})`);
  }
  // (c) 别的进程往两个正文各追加一行完整的行(头没变)→ 未提交尾巴,两种装载都截掉。
  for (const view of [null, OMIT]) {
    const u = await seeded(10);
    const ubp = sessionBodyPaths(u.id);
    fs.appendFileSync(ubp.messages, JSON.stringify({ role: 'user', content: 'foreign' }) + '\n');
    fs.appendFileSync(ubp.provider, JSON.stringify({ role: 'user', content: 'foreign' }) + '\n');
    const got = await loadSession(u.id, 0, 0, view);
    assert.equal(got.messages.length, 10, `追加 → 按头计数截断(view=${view})`);
    assert.equal(bodyLines(ubp.messages).length, 10);
    assert.equal(bodyLines(ubp.provider).length, u.providerHistory.length);
  }
});

test('[D1] 增量取的装载:不读 provider 正文;messages/resumable 与完整装载相同;字节戳与逐条序列化逐格相同', async () => {
  const s = await seeded(120, { turnSeq: 7 });
  // 装载会往 messages 末尾合并后台任务账本的回执(不在正文里):盘上 count 条之后的那一截逐条序列化。
  const jobs = path.join(sessionsDir, 'background-jobs');
  fs.mkdirSync(jobs, { recursive: true });
  fs.writeFileSync(path.join(jobs, s.id + '.json'), JSON.stringify([{ id: 'job1', shellId: 'sh1', name: 'build', sessionId: s.id, status: 'succeeded', exitCode: 0, output: 'done', completedAt: '2026-01-01T00:00:00.000Z' }]));
  const full = await loadSession(s.id);
  assert.equal(full.messages.length, 121, '账本回执合并进来了(只在内存里,盘上仍是 120 行)');
  assert.equal(bodyLines(sessionBodyPaths(s.id).messages).length, 120);
  const c0 = stats();
  const lite = await loadSession(s.id, 0, 0, OMIT);
  const c1 = stats();
  assert.equal(c1.providerBodySkips - c0.providerBodySkips, 1, '走了不读 provider 的视图');
  assert.equal(c1.bodyReads - c0.bodyReads, 1, '只读了 messages 正文');
  assert.equal(c1.lineHashes - c0.lineHashes, 0);
  const { providerHistory: _p1, ...liteHead } = lite;
  const { providerHistory: _p2, ...fullHead } = full;
  const differing = [...new Set([...Object.keys(liteHead), ...Object.keys(fullHead)])].filter(k => JSON.stringify(liteHead[k]) !== JSON.stringify(fullHead[k]));
  assert.deepEqual(differing, [], '去掉 providerHistory 后每个键都相同');
  assert.equal(JSON.stringify(liteHead), JSON.stringify(fullHead), '去掉 providerHistory 后逐字节相同(键序也相同)');
  assert.equal(JSON.stringify(detectDanglingTurn(lite)), JSON.stringify(detectDanglingTurn(full)), 'resumable 逐字节相同');
  assert.ok(!Object.keys(lite).includes('__providerHistoryOmitted'), '视图标记不可枚举,不进 JSON');
  const body = lite.__providerHistoryOmitted.body;
  assert.ok(body && body.count === 120, '行都是本进程序列化写下的 → 给字节视图');
  const n = full.messages.length;
  const cases = [];
  for (const from of [0, 1, 50, 119, 120, 121]) {
    cases.push([String(from), stampOf(full.messages, from)]);
    cases.push([String(from), stampOf(full.messages, from).replace(/.$/, c => (c === '0' ? '1' : '0'))]);
  }
  cases.push(['122', stampOf(full.messages, n)], ['x', 'm1.0.'], ['5', 'm2.5.abc'], [null, null]);
  const d0 = stats();
  for (const [from, stamp] of cases) {
    const viaBytes = sessionMessagesDelta(lite.messages, from, stamp, body);
    const viaSerialize = sessionMessagesDelta(full.messages, from, stamp);
    assert.equal(JSON.stringify(viaBytes), JSON.stringify(viaSerialize), `from=${from} 两条路结果不同`);
  }
  assert.ok(perfCounters.sessionBody.deltaStampFromBytes - d0.deltaStampFromBytes >= 12, '字节路径确实被用上了');
  const ok = sessionMessagesDelta(lite.messages, '50', stampOf(full.messages, 50), body);
  assert.ok(ok && ok.tail.length === 71 && ok.stamp === stampOf(full.messages, n));
  // 悬挂形状也要对:provider 尾巴是 user(被停止的回合)。
  const hang = await loadSession(s.id);
  hang.providerHistory.push({ role: 'user', content: 'dangling' });
  await saveSession(hang);
  const hangLite = await loadSession(s.id, 0, 0, OMIT);
  assert.ok(hangLite.__providerHistoryOmitted, '仍是视图');
  assert.deepEqual(detectDanglingTurn(hangLite), detectDanglingTurn(await loadSession(s.id)));
  assert.equal(detectDanglingTurn(hangLite).dangling, true);
});

test('[D2] 前提拿不准就让位给完整装载;saveSession 拒绝这个视图给出的对象', async () => {
  const isFull = x => x && !x.__providerHistoryOmitted && Array.isArray(x.providerHistory) && x.providerHistory.length > 0;
  // 进程重启后(这里用「从没在本进程写过/读过」的会话模拟):没有记录 → 完整装载。
  const cold = await seeded(6);
  const coldHead = JSON.parse(fs.readFileSync(headFile(cold.id), 'utf8'));
  const coldBp = sessionBodyPaths(cold.id);
  const copyId = 'sess_cold_copy_' + Date.now();
  fs.writeFileSync(headFile(copyId), JSON.stringify({ ...coldHead, id: copyId }, null, 2));
  fs.copyFileSync(coldBp.messages, path.join(sessionsDir, copyId + '.messages.ndjson'));
  fs.copyFileSync(coldBp.provider, path.join(sessionsDir, copyId + '.provider.ndjson'));
  assert.ok(isFull(await loadSession(copyId, 0, 0, OMIT)), '没有本进程记录 → 完整装载');
  assert.ok((await loadSession(copyId, 0, 0, OMIT)).__providerHistoryOmitted, '完整装载之后记录有了 → 视图');
  // provider 正文被外部改过(尺寸变了)→ 戳对不上 → 完整装载(并照旧截掉未提交尾巴)。
  const p = await seeded(6);
  fs.appendFileSync(sessionBodyPaths(p.id).provider, JSON.stringify({ role: 'user', content: 'foreign' }) + '\n');
  const pLoaded = await loadSession(p.id, 0, 0, OMIT);
  assert.ok(isFull(pLoaded));
  assert.equal(pLoaded.providerHistory.length, p.providerHistory.length);
  // provider 正文被外部同尺寸改写、mtime 变了(正常的外部编辑)→ 完整装载,resumable 反映新内容。
  const q = await seeded(6);
  const qbp = sessionBodyPaths(q.id);
  const qText = fs.readFileSync(qbp.provider, 'utf8');
  const lastLine = JSON.stringify(q.providerHistory[q.providerHistory.length - 1]);
  const swapped = lastLine.replace('"role":"assistant"', '"role":"user"     ');
  assert.equal(Buffer.byteLength(swapped), Buffer.byteLength(lastLine));
  fs.writeFileSync(qbp.provider, qText.slice(0, qText.lastIndexOf(lastLine)) + swapped + '\n');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(qbp.provider, future, future);
  const qLoaded = await loadSession(q.id, 0, 0, OMIT);
  assert.ok(isFull(qLoaded), 'provider 戳变了 → 读真内容');
  assert.equal(detectDanglingTurn(qLoaded).dangling, true);
  // 写链在跑 → 完整装载(它知道怎么等)。
  const w = await seeded(6);
  w.messages.push({ role: 'user', content: 'racing' });
  const saving = saveSession(w);
  const wLoaded = await loadSession(w.id, 0, 0, OMIT);
  await saving;
  assert.ok(isFull(wLoaded));
  // 上次写失败(bodiesOk=false)→ 完整装载。
  const f = await seeded(6);
  f.messages.push({ role: 'user', toJSON() { throw new Error('unserializable'); } });   // 链内序列化失败 → 这次写被拒绝、标 bodiesOk=false
  await assert.rejects(saveSession(f));
  assert.ok(isFull(await loadSession(f.id, 0, 0, OMIT)), '写失败之后不信记录');
  // 要补字段回写(normalize changed)→ 完整装载,由它回写。
  const n = await seeded(6);
  const nHead = JSON.parse(fs.readFileSync(headFile(n.id), 'utf8'));
  delete nHead.todos;
  fs.writeFileSync(headFile(n.id), JSON.stringify(nHead, null, 2));
  const nLoaded = await loadSession(n.id, 0, 0, OMIT);
  assert.ok(isFull(nLoaded) && Array.isArray(nLoaded.todos));
  assert.ok(Array.isArray(JSON.parse(fs.readFileSync(headFile(n.id), 'utf8')).todos), '回写落盘了');
  // 残留 pending 叙事段要惰性清理 → 完整装载,由它清理并落盘。
  const h = await seeded(6);
  h.messages.push({ role: 'assistant', content: 'q', segments: [{ type: 'question', status: 'pending', questionId: 'q-gone' }] });
  await saveSession(h);
  const hLoaded = await loadSession(h.id, 0, 0, OMIT);
  assert.ok(isFull(hLoaded));
  assert.equal(hLoaded.messages[hLoaded.messages.length - 1].segments[0].status, 'cancelled');
  // 视图对象不许落盘。
  const v = await seeded(6);
  const view = await loadSession(v.id, 0, 0, OMIT);
  assert.ok(view.__providerHistoryOmitted);
  await assert.rejects(saveSession(view), /without its provider history/);
  assert.equal((await loadSession(v.id)).providerHistory.length, v.providerHistory.length, 'provider 历史一条没少');
});

test('[D3] 盘上的行不是 JSON.stringify 的原样输出 ⇒ 不用字节戳,结果同修前', async () => {
  const s = await seeded(20);
  const bp = sessionBodyPaths(s.id);
  // 外部把 messages 正文重写成带空格的 JSON(内容相同、字节不同、条数不变)。
  fs.writeFileSync(bp.messages, s.messages.map(m => JSON.stringify(m, null, 0).replace(/^\{"role":/, '{ "role" :')).join('\n') + '\n');
  const lite = await loadSession(s.id, 0, 0, OMIT);
  assert.ok(lite.__providerHistoryOmitted, '仍可以不读 provider');
  assert.equal(lite.__providerHistoryOmitted.body, null, '行不是 canonical → 不给字节视图');
  assert.deepEqual(lite.messages, s.messages);
  const good = stampOf(s.messages, 10);
  const d = sessionMessagesDelta(lite.messages, '10', good, lite.__providerHistoryOmitted.body);
  assert.ok(d && d.tail.length === 10 && d.stamp === stampOf(s.messages, 20), '按内容算的戳照样对得上');
});
