// Unit(perf · 会话索引内存镜像):flushSessionIndex 每个 200 ms 去抖窗口都读 + 解析 + 整份重写 index.json(3000 条 ≈ 25 ms)。
// 镜像的设计在 02-session-store.js 的 sessionIndexMemo 头注:自己刚写下的那份 map 连同「写完立刻取的文件戳」留在内存里,
// 下一窗口文件戳没变就直接在镜像上合并、跳过读盘与解析;戳变了(外部改写 / invalidate / 重建覆盖)一律作废走原路。
// 用读盘计数(fsp.readFile 对 index.json 的调用次数)断言,确定性:
//   [M1] 承重:第一次 flush 读一次(建镜像),之后的 flush 一次都不读 —— 而落盘内容与 listSessions 读到的仍是全部改动的合并;
//   [M2] 外部改写:有人换掉了 index.json → 下一次 flush 重读(不信镜像),外部改写与新批次都在落盘结果里;
//   [M3] invalidateSessionIndex 之后镜像作废:没有有效索引时丢批次不崩,listSessions 走扫盘重建且内容对;
//   [M4] 删除(墓碑)也走镜像:删掉一条会话,索引里那条消失,且没有多读盘。
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');   // 与 server.js 里的 fsp 是同一个对象 —— 计数钩子装在它的属性上
const os = require('os');
const path = require('path');
const { describe, it, before, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-index-memo-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));
const indexFile = path.join(root, 'sessions', 'index.json');

let indexReads = 0;
const realReadFile = fsp.readFile;
before(() => {
  fsp.readFile = function patched(p, ...rest) {
    if (String(p) === indexFile) indexReads += 1;
    return realReadFile.call(this, p, ...rest);
  };
});
after(() => { fsp.readFile = realReadFile; });

const diskIndex = () => JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const titleOnDisk = id => { const row = diskIndex().find(e => e.id === id); return row && row.title; };
async function rename(session, title) {
  session.title = title;
  await srv.saveSession(session);
  await srv.flushSessionIndex();
}

describe('会话索引内存镜像', () => {
  const made = [];
  it('[M1] 第一次 flush 读一次建镜像,之后的 flush 不读盘,落盘内容仍是全部改动的合并', async () => {
    for (let i = 0; i < 5; i++) made.push(await srv.createSession({ title: 'memo-' + i, cwd: root }));
    await srv.flushSessionIndex();
    await srv.listSessions();                 // 索引不在 → 扫盘重建(重建写回不产生镜像)
    assert.ok(fs.existsSync(indexFile), '前提:索引已存在');
    const base = indexReads;
    await rename(made[0], 'memo-A');          // 第一次 flush:没有镜像 → 读一次
    assert.strictEqual(indexReads - base, 1, '没有镜像时 flush 读一次盘');
    await rename(made[1], 'memo-B');
    await rename(made[2], 'memo-C');
    await rename(made[0], 'memo-A2');
    assert.strictEqual(indexReads - base, 1, '之后的 flush 命中镜像,不再读 index.json');
    assert.strictEqual(titleOnDisk(made[0].id), 'memo-A2');
    assert.strictEqual(titleOnDisk(made[1].id), 'memo-B');
    assert.strictEqual(titleOnDisk(made[2].id), 'memo-C');
    assert.strictEqual(titleOnDisk(made[3].id), 'memo-3', '没动过的条目原样在');
    assert.strictEqual(diskIndex().length, 5, '条数不变');
    // 读者视角(listSessions 读盘 + 叠加未落盘改动)与镜像写下的内容一致
    const listed = await srv.listSessions();
    const titles = Object.fromEntries(listed.map(m => [m.id, m.title]));
    assert.strictEqual(titles[made[0].id], 'memo-A2');
    assert.strictEqual(titles[made[1].id], 'memo-B');
    assert.strictEqual(titles[made[4].id], 'memo-4');
  });

  it('[M2] 外部换掉了 index.json:下一次 flush 重读,外部改写与新批次都在结果里', async () => {
    await rename(made[3], 'memo-D');          // 先确保处于镜像命中态
    const rows = diskIndex();
    const external = rows.map(e => (e.id === made[4].id ? { ...e, title: 'edited-externally-with-a-longer-title' } : e));
    fs.writeFileSync(indexFile, JSON.stringify(external, null, 2), 'utf8');   // 大小、mtime 都变了
    const before1 = indexReads;
    await rename(made[1], 'memo-B2');
    assert.strictEqual(indexReads - before1, 1, '文件戳变了:镜像作废,重读一次');
    assert.strictEqual(titleOnDisk(made[4].id), 'edited-externally-with-a-longer-title', '外部改写没有被镜像里的旧值盖回去');
    assert.strictEqual(titleOnDisk(made[1].id), 'memo-B2');
    assert.strictEqual(titleOnDisk(made[3].id), 'memo-D');
    const again = indexReads;
    await rename(made[2], 'memo-C2');         // 重读之后镜像重新建立
    assert.strictEqual(indexReads, again, '重读那一发写完之后又回到镜像命中态');
  });

  it('[M3] invalidateSessionIndex 之后镜像作废:丢批次不崩,listSessions 走扫盘重建且内容对', async () => {
    await srv.invalidateSessionIndex();
    assert.ok(!fs.existsSync(indexFile));
    made[0].title = 'memo-after-invalidate';
    await srv.saveSession(made[0]);
    await srv.flushSessionIndex();            // 没有有效索引 → 丢批次(listSessions 会重建),不许拿旧镜像凭空写出一份索引
    assert.ok(!fs.existsSync(indexFile), '不许用作废前的镜像写出一份索引');
    const listed = await srv.listSessions();  // 扫盘重建
    assert.strictEqual(listed.length, 5);
    assert.strictEqual(listed.find(m => m.id === made[0].id).title, 'memo-after-invalidate');
    assert.strictEqual(titleOnDisk(made[0].id), 'memo-after-invalidate', '重建写回的索引是权威内容');
  });

  it('[M4] 删除(墓碑)也走镜像:索引里那条消失,没有多读盘', async () => {
    await rename(made[1], 'memo-warm');       // 建镜像(重建之后的第一次 flush 读一次)
    const base = indexReads;
    await srv.deleteSession(made[4].id);
    await srv.flushSessionIndex();
    assert.strictEqual(indexReads, base, '删除批次命中镜像,不读盘');
    assert.ok(!diskIndex().some(e => e.id === made[4].id));
    assert.strictEqual(diskIndex().length, 4);
    const listed = await srv.listSessions();
    assert.strictEqual(listed.length, 4);
  });
});
