'use strict';
// 性能批 P1:用量账缓存(00-boot forEachUsageRow)与修前整读路径(readUsageRows,RUYI_USAGE_CACHE=0 时的回退)逐条一致。
//   [U1] 差分:随机账本 + 一串随机变更(追加 / 没写完的半行 / 补全 / 截短 / 同尺寸改写 / 删月份 / 加月份 / 坏行 / CRLF /
//        非规范 ts / 类型奇怪的字段),每一步后两条路径在若干下界、会话筛选下吐出的行【次序与消费方可见语义】完全相同
//   [U2] 看板 buildUsageSummary('all' / 'month')在两条路径下逐字节相同(浮点累加次序没变)
//   [U3] 增量:整月解析一次之后,追加一行只解析那一行(fullParses 不涨、bytesParsed 只涨那一行的字节数);
//        没写完的半行不入列、补全之后才入列且不重复
//   [U4] 旧末尾被改写(同尺寸、换内容)→ 那个月整份重读,不拿旧列充数
//   [U5] 会话筛选(每轮对话后只刷那几条会话的用量)与「全量遍历再筛」逐条相同
//   [U6] 同尺寸原地改写(只换了 mtime)→ 整月重读(修前的缓存会一直拿旧列,审查轮复现过)
//   [U7] 对象值字段按内容去重:一千行各带一个同内容对象,字典只多一格
//   [U8] 午夜跳 DST 的时区(开罗):看板 byDay 与逐行本地日期一致(日键缓存的次日边界曾错成次日 01:00)
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-usage-cache-'));
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const usageDir = path.join(root, 'usage');
after(() => { delete process.env.RUYI_USAGE_CACHE; fs.rmSync(root, { recursive: true, force: true }); });

// 可复现的伪随机(mulberry32)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const MONTHS = ['2026-05', '2026-06', '2026-07', '2026-08'];
function makeRow(r, month) {
  const day = 1 + Math.floor(r() * 27), sec = Math.floor(r() * 86000);
  const t = Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, day, 0, 0, sec, Math.floor(r() * 1000));
  const iso = new Date(t).toISOString();
  const pick = arr => arr[Math.floor(r() * arr.length)];
  const row = {
    // 规范串为主,混进非规范写法、数字,以及 V8 会悄悄进位的越界值(2 月 30 日、24 点、4 月 31 日)
    ts: pick([iso, iso, iso, iso.replace('Z', '+00:00'), iso.slice(0, 19) + 'Z', t, month + '-30T01:02:03.000Z'.replace('-30', month.endsWith('06') ? '-31' : '-30'), month + '-02T24:00:00.000Z', '2026-02-30T08:00:00.000Z']),
    sessionId: pick(['sess_a', 'sess_b', 'sess_c', 'sess_d', 'sess_é', 7]),
    engine: pick(['openai', 'claude', 'other', undefined]),
    provider: pick(['p1', 'p2', '', undefined, 3]),
    model: pick(['m1', 'm2', 'm3', '', undefined]),
    inTok: pick([1200, 0, '350', null, undefined, 12.5]),
    outTok: pick([300, 0, '7', undefined]),
    cachedInTok: pick([0, 100, 5000, null]),
    cost: pick([0.0012345, 0.000001, 1.5e-6, null, 'x', undefined, 0.1 + 0.2]),
    currency: pick(['USD', 'CNY', '', null, 1]),
    costTrusted: pick([true, true, false, undefined, 'false']),
    estimated: pick([false, true, undefined, 'true']),
    kind: pick(['turn', 'subagent', 'aux', undefined]),
    note: pick(['steward', 'compact', undefined]),
  };
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k];
  return JSON.stringify(row);
}
function junkLine(r) {
  const pick = arr => arr[Math.floor(r() * arr.length)];
  return pick(['', '   ', '{"broken', 'null', '[]', '"str"', '{"ts":"not a date","inTok":5}', '{"ts":"2026-06-01T00:00:00.000Z"}\r', '﻿{"ts":"2026-06-02T00:00:00.000Z","inTok":1}']);
}
const monthFile = m => path.join(usageDir, m + '.jsonl');

// 消费方可见语义:数值一律 Number(),costTrusted 看 !== false,estimated 看 === true,其余原值(类型保真)
function snapshot(lowerMs, opts) {
  const out = [];
  return srv.forEachUsageRow(lowerMs, r => {
    out.push({
      tsMs: r.tsMs, ts: r.ts, inTok: Number(r.inTok), outTok: Number(r.outTok), cachedInTok: Number(r.cachedInTok), cost: Number(r.cost),
      costTrusted: r.costTrusted !== false, estimated: r.estimated === true,
      sessionId: r.sessionId, engine: r.engine, provider: r.provider, model: r.model, currency: r.currency, kind: r.kind, note: r.note,
    });
  }, opts).then(() => out);
}
async function both(fn) {
  delete process.env.RUYI_USAGE_CACHE;
  const cached = await fn();
  process.env.RUYI_USAGE_CACHE = '0';
  const oracle = await fn();
  delete process.env.RUYI_USAGE_CACHE;
  return { cached, oracle };
}
async function assertSame(label) {
  const lowers = [0, Date.UTC(2026, 5, 15), Date.UTC(2026, 7, 20), Date.UTC(2030, 0, 1)];
  for (const lower of lowers) {
    const { cached, oracle } = await both(() => snapshot(lower));
    assert.deepEqual(cached, oracle, `${label}:下界 ${lower} 的行序列`);
  }
  for (const ids of [['sess_a'], ['sess_b', 'sess_é'], ['nope']]) {
    const { cached, oracle } = await both(() => snapshot(0, { sessionIds: new Set(ids) }));
    assert.deepEqual(cached, oracle, `${label}:会话筛选 ${ids}`);
    const full = (await both(() => snapshot(0))).cached.filter(row => ids.includes(row.sessionId));
    assert.deepEqual(cached, full, `${label}:[U5] 筛选 = 全量再筛(${ids})`);
  }
}
function appendText(month, text) { fs.appendFileSync(monthFile(month), text); }

test('[U1][U5] 随机账本 + 随机变更:两条路径逐条一致', async () => {
  fs.mkdirSync(usageDir, { recursive: true });
  const r = rng(20260929);
  for (const m of MONTHS.slice(0, 3)) {
    const lines = [];
    for (let i = 0; i < 400; i++) lines.push(r() < 0.08 ? junkLine(r) : makeRow(r, m));
    fs.writeFileSync(monthFile(m), lines.join(r() < 0.5 ? '\n' : '\r\n') + '\n');
  }
  await assertSame('初始');
  for (let step = 0; step < 40; step++) {
    const m = MONTHS[Math.floor(r() * MONTHS.length)];
    const op = Math.floor(r() * 8);
    if (op <= 2) appendText(m, Array.from({ length: 1 + Math.floor(r() * 5) }, () => makeRow(r, m)).join('\n') + '\n');
    else if (op === 3) appendText(m, makeRow(r, m).slice(0, 20));   // 没写完的半行
    else if (op === 4) appendText(m, '"x":1}\n' + makeRow(r, m) + '\n');   // 把半行「补全」成坏行,再追加一行
    else if (op === 5 && fs.existsSync(monthFile(m))) {                   // 截短到某个位置(可能落在行中间)
      const size = fs.statSync(monthFile(m)).size;
      fs.truncateSync(monthFile(m), Math.floor(size * (0.3 + r() * 0.6)));
    } else if (op === 6 && fs.existsSync(monthFile(m))) {                 // 同尺寸改写:换掉最后几个字节
      const buf = fs.readFileSync(monthFile(m));
      if (buf.length > 40) { buf.write('9', buf.length - 30, 'utf8'); fs.writeFileSync(monthFile(m), buf); fs.utimesSync(monthFile(m), new Date(), new Date(Date.now() + 5000 + step)); }
    } else if (op === 7) {
      if (r() < 0.3) fs.rmSync(monthFile(m), { force: true });
      else appendText(m, junkLine(r) + '\n');
    }
    await assertSame(`第 ${step} 步(op ${op} @ ${m})`);
  }
});

test('[U2] 看板在两条路径下逐字节相同', async () => {
  for (const range of ['all', 'month']) {
    const { cached, oracle } = await both(() => srv.buildUsageSummary(range));
    assert.equal(JSON.stringify(cached), JSON.stringify(oracle), `buildUsageSummary('${range}')`);
  }
});

test('[U3][U4] 增量:追加一行只解析那一行;半行不入列;旧末尾被改写就整月重读', async () => {
  fs.rmSync(usageDir, { recursive: true, force: true });
  fs.mkdirSync(usageDir, { recursive: true });
  const r = rng(7);
  const m = '2026-06';
  fs.writeFileSync(monthFile(m), Array.from({ length: 2000 }, () => makeRow(r, m)).join('\n') + '\n');
  await snapshot(0);   // 整月首次解析
  const base = srv.usageLedgerCacheStats();
  const line = makeRow(r, m) + '\n';
  appendText(m, line);
  const rows = await snapshot(0);
  const afterOne = srv.usageLedgerCacheStats();
  assert.equal(afterOne.fullParses, base.fullParses, '追加一行不触发整月重读');
  assert.equal(afterOne.incrementalParses, base.incrementalParses + 1);
  assert.equal(afterOne.bytesParsed - base.bytesParsed, Buffer.byteLength(line), '只解析了新增那一行的字节');
  assert.equal(rows.length, base.rows + 1);

  // 半行:每次现解析、不入列;补全之后入列一次、不重复
  const half = makeRow(r, m);
  appendText(m, half.slice(0, 15));
  const withHalf = await snapshot(0);
  assert.equal(withHalf.length, rows.length, '半行解析不出来,不算一行');
  assert.equal(srv.usageLedgerCacheStats().rows, afterOne.rows, '半行不入列');
  appendText(m, half.slice(15) + '\n');
  const completed = await snapshot(0);
  assert.equal(completed.length, rows.length + 1, '补全之后算一行');
  const again = await snapshot(0);
  assert.equal(again.length, completed.length, '不重复计入');
  assert.deepEqual((await both(() => snapshot(0))).oracle, completed);

  // 同尺寸改写旧末尾(核对窗口内的一个字节),再追加一行:核对字节对不上 → 整月重读,不拿旧列充数
  const beforeRewrite = srv.usageLedgerCacheStats();
  const buf = fs.readFileSync(monthFile(m));
  const at = buf.length - 3;   // 最后一行的 '}' 之前(核对窗口是已解析部分的末尾 32 字节)
  buf[at] = buf[at] === 0x20 ? 0x21 : 0x20;
  fs.writeFileSync(monthFile(m), buf);
  fs.utimesSync(monthFile(m), new Date(), new Date(Date.now() + 60000));
  appendText(m, makeRow(r, m) + '\n');
  const rewritten = await snapshot(0);
  assert.equal(srv.usageLedgerCacheStats().fullParses, beforeRewrite.fullParses + 1, '旧末尾被改写 → 整月重读');
  assert.deepEqual(rewritten, (await both(() => snapshot(0))).oracle);
});

test('[U6][U7] 同尺寸原地改写整月重读;对象值按内容去重', async () => {
  fs.rmSync(usageDir, { recursive: true, force: true });
  fs.mkdirSync(usageDir, { recursive: true });
  const m = '2026-07';
  const row = cost => JSON.stringify({ ts: '2026-07-02T03:04:05.000Z', sessionId: 'sess_x', inTok: 1, outTok: 1, cost, currency: 'USD' });
  // 改动落在第一行,后面垫 20 行 —— 离文件末尾远超核对窗口(256 字节),只能靠「同尺寸 = 原地改写」这条判据发现
  fs.writeFileSync(monthFile(m), [row(0.5), ...Array.from({ length: 20 }, () => row(0))].join('\n') + '\n');
  const sum = async () => { let c = 0; await srv.forEachUsageRow(0, r => { c += Number(r.cost); }); return Math.round(c * 1e6) / 1e6; };
  assert.equal(await sum(), 0.5);
  const edited = fs.readFileSync(monthFile(m), 'utf8').replace('"cost":0.5', '"cost":0.9');   // 同尺寸、改在第一行
  fs.writeFileSync(monthFile(m), edited);
  fs.utimesSync(monthFile(m), new Date(), new Date(Date.now() + 120000));
  assert.equal(await sum(), 0.9, '同尺寸原地改写 → 整月重读,不拿旧列充数');

  const before = srv.usageLedgerCacheStats().dictSize;
  fs.appendFileSync(monthFile(m), Array.from({ length: 1000 }, () => JSON.stringify({ ts: '2026-07-03T00:00:00.000Z', sessionId: 'sess_x', model: { odd: true }, inTok: 1 })).join('\n') + '\n');
  const models = new Set();
  await srv.forEachUsageRow(0, r => { if (r.model && typeof r.model === 'object') models.add(JSON.stringify(r.model)); });
  assert.deepEqual([...models], ['{"odd":true}'], '消费方看到的仍是对象(typeof / String 不变)');
  assert.ok(srv.usageLedgerCacheStats().dictSize - before <= 2, `字典只多一两格(实 ${srv.usageLedgerCacheStats().dictSize - before})`);
});

test('[U8] 午夜跳 DST 的时区:byDay 与逐行本地日期一致', () => {
  const { execFileSync } = require('child_process');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-usage-dst-'));
  try {
    const script = `
      process.env.RUYI_HOME = ${JSON.stringify(home)};
      const fs = require('fs'), path = require('path');
      fs.mkdirSync(path.join(process.env.RUYI_HOME, 'usage'), { recursive: true });
      // 开罗 2025-04-25 零点跳到 01:00:两行分别是本地 4 月 25 日与 4 月 26 日
      const rows = ['2025-04-24T22:30:00.000Z', '2025-04-25T21:30:00.000Z', '2025-04-25T22:30:00.000Z'].map(ts => JSON.stringify({ ts, sessionId: 's', inTok: 10, outTok: 0 }));
      fs.writeFileSync(path.join(process.env.RUYI_HOME, 'usage', '2025-04.jsonl'), rows.join('\\n') + '\\n');
      const srv = require(${JSON.stringify(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'))});
      const local = ms => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
      srv.buildUsageSummary('all').then(sum => {
        const got = sum.byDay.map(d => [d.date, d.inTok]);
        const want = {}; for (const r of rows) { const k = local(Date.parse(JSON.parse(r).ts)); want[k] = (want[k] || 0) + 10; }
        process.stdout.write(JSON.stringify({ got, want: Object.entries(want).sort() }));
        process.exit(0);
      });`;
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ: 'Africa/Cairo', RUYI_HOME: home }, encoding: 'utf8' }).trim().split('\n').pop());
    assert.deepEqual(out.got, out.want, `开罗时区 byDay(got ${JSON.stringify(out.got)})`);
    assert.equal(out.want.length, 2, '夹具确实跨了那个不存在的零点');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
