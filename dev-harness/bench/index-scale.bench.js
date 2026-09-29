#!/usr/bin/env node
'use strict';
// 性能批基准(不进回归门,只打印):投影索引与用量账在几条日常路径上的耗时 —— 冷建、每轮对话后(usage 脏)、
// 会话落盘后(目录 mtime 变)、用量看板。改前改后各跑一次,数字贴进 PR。
// 用法: node dev-harness/bench/index-scale.bench.js [会话数=300] [用量行数=100000]
// 例:   node dev-harness/bench/index-scale.bench.js 2000 300000
const fs = require('fs'), os = require('os'), path = require('path');
const N = Number(process.argv[2] || 300), R = Number(process.argv[3] || 100000);
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-bench-'));
process.env.RUYI_HOME = HOME;
const sid = i => 'sess_bench_' + String(i).padStart(5, '0');
const iso = i => new Date(Date.UTC(2026, 0, 1, 0, 0, i % 86400)).toISOString();
fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
for (let i = 0; i < N; i++) {
  const head = { schemaVersion: 4, storageVersion: 2, id: sid(i), title: 'bench ' + i, cwd: HOME, createdAt: iso(i), updatedAt: iso(i), turnSeq: 3, messageCount: 0 };
  fs.writeFileSync(path.join(HOME, 'sessions', sid(i) + '.json'), JSON.stringify(head));
  fs.writeFileSync(path.join(HOME, 'sessions', sid(i) + '.messages.ndjson'), '');
  const rows = []; for (let j = 0; j < 4; j++) rows.push(JSON.stringify({ id: `iv_${i}_${j}`, type: 'permission', sessionId: sid(i), requestedAt: iso(i + j), status: j ? 'approved' : 'pending', toolName: 'Bash', tier: 'exec' }));
  fs.writeFileSync(path.join(HOME, 'sessions', sid(i) + '.interventions.ndjson'), rows.join('\n') + '\n');
}
fs.mkdirSync(path.join(HOME, 'usage'), { recursive: true });
// 用量账摊到 6 个月(真实机器上是逐月累积的)
const perMonth = Math.ceil(R / 6);
for (let m = 0; m < 6; m++) {
  const out = [];
  for (let k = 0; k < perMonth && m * perMonth + k < R; k++) {
    const i = m * perMonth + k;
    out.push(JSON.stringify({ ts: new Date(Date.UTC(2026, 3 + m, 1, 0, 0, i % 86400)).toISOString(), sessionId: sid(i % N), engine: 'openai', provider: 'p', model: 'm', inTok: 1200, outTok: 300, cachedInTok: 0, cost: 0.001, currency: 'USD', costTrusted: true, estimated: false, turnSeq: 1, kind: 'turn' }));
  }
  fs.writeFileSync(path.join(HOME, 'usage', `2026-${String(4 + m).padStart(2, '0')}.jsonl`), out.join('\n') + '\n');
}
const ledgerBytes = fs.readdirSync(path.join(HOME, 'usage')).reduce((a, f) => a + fs.statSync(path.join(HOME, 'usage', f)).size, 0);
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 事件循环最长卡顿:每 5 ms 一拍,记下两拍之间超出的最大间隔(SSE 流顿不顿看的就是它)
function stallMonitor() {
  let last = performance.now(), max = 0;
  const timer = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last - 5); last = now; }, 5);
  return () => { clearInterval(timer); return max; };
}
const t = async (label, fn) => {
  const stop = stallMonitor(); const s = performance.now(); await fn(); const ms = performance.now() - s;
  await new Promise(r => setTimeout(r, 8));   // 让监视器补记最后一段同步执行
  const stall = stop();
  console.log(label.padEnd(44), ms.toFixed(0).padStart(6), 'ms   最长卡顿', stall.toFixed(0).padStart(5), 'ms'); return ms;
};
(async () => {
  console.log(`sessions=${N} usageRows=${R} ledger=${(ledgerBytes / 1048576).toFixed(1)}MB`);
  await t('冷建(无索引文件)', () => srv.getPretenderProjectionIndex());
  await sleep(1200);
  await t('热读(什么都没变)', () => srv.getPretenderProjectionIndex());
  // 一轮对话落一行用量 → usage 脏
  srv.appendUsageLedger({ sessionId: sid(1), engine: 'openai', provider: 'p', model: 'm', inTok: 10, outTok: 5, cost: 0.001, currency: 'USD', turnSeq: 9, kind: 'turn' });
  await sleep(300);
  await t('一轮对话后的下一次读(usage 脏)', () => srv.getPretenderProjectionIndex());
  await sleep(1200);
  // 会话落盘(tmp+rename)→ 目录 mtime 变
  const f = path.join(HOME, 'sessions', sid(2) + '.json'); const tmp = f + '.tmp-bench';
  fs.writeFileSync(tmp, fs.readFileSync(f)); fs.renameSync(tmp, f);
  await t('会话落盘后的下一次读(目录 mtime 变)', () => srv.getPretenderProjectionIndex());
  await t('紧接着再读(1s 沉降窗口内)', () => srv.getPretenderProjectionIndex());
  await t('用量看板 本月', () => srv.buildUsageSummary('month'));
  await t('用量看板 全部', () => srv.buildUsageSummary('all'));
  if (srv.usageLedgerCacheStats) console.log('用量账缓存', JSON.stringify(srv.usageLedgerCacheStats()));
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(0);
})();
