#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// summary-fact-table.e2e.js — 105g(4.3 首项) map-reduce 全局事实表
//   (runtimeSummaryFactTableV1,真实 history-24 配对 A/B 门通过后默认开)
//
// 覆盖:
//   [U] 开关三态与事实表构建(require 直测):
//       默认开 / 显式 false 回退 / 字符串 "true" 洗回 false(严格布尔);
//       buildSummaryFactTableMessages 的实体抽取、条数上限、空历史/纯填充历史的 null 降级。
//   [A] 摘要内核行为(fake-openai + FAKE_RECORD_SUMMARY_DIR):
//       开关关 = 分段/汇总请求体零注入(逐字节不变);开关开 = 每个分段与汇总请求都带
//       【全局事实表】,且块 0 独有实体出现在不含块 0 的末段请求里(跨块可见性实证);
//       单发路径(未分块)即使开关开也不注入;零实体历史即使分块也不注入。
//   [H] 项目真实 history-24 回放：完整历史的有界实体表进入每个真实 map 分段与汇总请求，
//       且 mapReduce 元数据的实体数与构建结果一致；夹具缺失时显式 SKIP。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// 隔离纪律(同 summary-single-shot):require server.js 之前把数据根指向临时目录。
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105g-unit-'));

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function fakeUp(port, env) { const p = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(port)], { env: { ...process.env, FAKE_OPENAI_PORT: String(port), ...env }, windowsHide: true }); p.stdout.on('data', () => {}); p.stderr.on('data', () => {}); return p; }
const user = content => ({ role: 'user', content });
// 纯填充历史(零实体):用真实估算器反推每块长度,避免字符/token 比假定写死。
function historyNearTokens(target, blocks) {
  const per = Math.floor(target / blocks);
  let lo = 1, hi = per * 5, best = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = [user('边界块 ' + 'x'.repeat(mid))];
    if (srv.estimateHistoryTokens(candidate) <= per) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const out = [];
  for (let i = 0; i < blocks; i++) out.push(user('块' + i + ' ' + 'x'.repeat(best)));
  return out;
}
// 实体历史:块 0 携带全部独特实体(代号/版本/路径/日期),其余块纯填充 —— 用来实证
// 「末段请求里出现块 0 独有实体」的跨块可见性,而不是仅从代码形状推断。
function entityHistory(target, blocks) {
  const base = historyNearTokens(target, blocks);
  base[0] = user('块0 决定:代号「飞星计划」锁定版本 v3.1.4,配置在 C:\\proj\\feixing\\plan.yaml,里程碑 2026-09-01。' + base[0].content.slice('块0 '.length));
  return base;
}
function readSumPayloads(dir) {
  return fs.readdirSync(dir).filter(f => f.startsWith('sum-')).sort()
    .map(f => String(fs.readFileSync(path.join(dir, f), 'utf8')));
}

(async () => {
  // ═══ [U] 开关三态与事实表构建 ═══
  console.log('── [U] 105g 开关与事实表构建 ──');
  ok(srv.summaryFactTableEnabled(srv.defaultConfig()) === true, 'U1 默认配置开启(真实 history-24 A/B 门通过:实体保留 18.8%→75.0%,调用数零增加)');
  ok(srv.summaryFactTableEnabled({ runtimeSummaryFactTableV1: true }) === true, 'U2 显式 true 生效');
  ok(srv.summaryFactTableEnabled({ runtimeSummaryFactTableV1: false }) === false, 'U3 显式 false 回退');
  ok(srv.summaryFactTableEnabled({ runtimeSummaryFactTableV1: 'true' }) === false, 'U4 字符串 "true" 洗回 false(严格布尔)');
  const rich = srv.buildSummaryFactTableMessages(entityHistory(11000, 6));
  ok(rich.entities >= 4 && rich.chunk && rich.reduce, 'U5 实体历史构建出 chunk/reduce 两条注入消息(实体 ' + rich.entities + ' 条)');
  ok(rich.entities <= 16, 'U6 实体条数有界(rules factTable.maxSamples=16)');
  ok(rich.chunk.content.includes('【全局事实表') && rich.chunk.content.includes('飞星计划')
    && rich.chunk.content.includes('v3.1.4') && rich.chunk.content.includes('C:\\proj\\feixing\\plan.yaml'),
    'U7 事实表逐字携带代号/版本/路径实体');
  ok(rich.chunk.content.includes('本段摘要') && rich.reduce.content.includes('有效约束') && rich.chunk.content !== rich.reduce.content,
    'U8 分段与汇总指令分流(分段防臆造/汇总声明推翻不并列)');
  ok(rich.chunk.content.length < 2600, 'U9 注入消息总量有界(' + rich.chunk.content.length + ' 字符)');
  const empty = srv.buildSummaryFactTableMessages([]);
  ok(empty.entities === 0 && empty.chunk === null && empty.reduce === null, 'U10 空历史 → 双 null 降级(零注入)');
  const filler = srv.buildSummaryFactTableMessages(historyNearTokens(11000, 6));
  ok(filler.entities === 0 && filler.chunk === null && filler.reduce === null, 'U11 纯填充历史零实体 → 双 null 降级');

  // ═══ [A] 摘要内核行为(fake-openai) ═══
  console.log('── [A] 105g 事实表注入内核行为 ──');
  {
    // 窗口 8000 + 显式回退单发优先 → 旧「窗口 × 50%」预算 4000;≈11K 实体历史 → 3 段 + 1 汇总 = 4 请求。
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105g-sum-'));
    const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR });
    try {
      await sleep(400);
      const provider = { id: 'g-prov', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'g-m1', contextWindow: 8000 };
      const hist = entityHistory(11000, 6);
      // A1: 开关关 —— 请求体零注入(现状逐字节不变),无 factTable 元数据。
      let r = await srv.providerSummaryCall(provider, hist, { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false } });
      let payloads = readSumPayloads(SUMDIR);
      ok(r.ok && !!r.mapReduce && r.mapReduce.chunks >= 2, 'A1 开关关:map-reduce 正常分块(' + (r.mapReduce || {}).chunks + ' 段)');
      ok(payloads.length >= 3 && payloads.every(p => !p.includes('全局事实表')), 'A1a 开关关:全部 ' + payloads.length + ' 个摘要请求零注入(逐字节不变)');
      ok(!(r.mapReduce || {}).factTable, 'A1b 开关关:无 factTable 元数据');
      // A2: 开关开 —— 每个分段与汇总请求都带事实表;块 0 独有实体出现在末段(不含块 0 文本)请求里。
      for (const f of fs.readdirSync(SUMDIR)) fs.rmSync(path.join(SUMDIR, f));
      r = await srv.providerSummaryCall(provider, hist, { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: true } });
      payloads = readSumPayloads(SUMDIR);
      ok(r.ok && !!r.mapReduce && r.mapReduce.chunks >= 2, 'A2 开关开:map-reduce 正常分块');
      ok(payloads.length >= 3 && payloads.every(p => p.includes('全局事实表')), 'A2a 开关开:全部 ' + payloads.length + ' 个摘要请求均注入事实表');
      const chunks = payloads.filter(p => !p.includes('【分段摘要'));
      const reduces = payloads.filter(p => p.includes('【分段摘要'));
      ok(chunks.length >= 2 && reduces.length >= 1, 'A2b 分段/汇总请求可分流(分段 ' + chunks.length + ',汇总 ' + reduces.length + ')');
      const lastChunk = chunks.find(p => p.includes('块5') && !p.includes('块0'));
      ok(!!lastChunk && lastChunk.includes('飞星计划') && lastChunk.includes('v3.1.4'),
        'A2c 末段(不含块 0 文本)请求携带块 0 独有实体 —— 跨块可见性实证');
      ok(chunks.every(p => p.includes('本段摘要')) && reduces.every(p => p.includes('有效约束')),
        'A2d 分段/汇总各带对应指令(防臆造 / 推翻不并列)');
      ok(r.mapReduce.factTable && r.mapReduce.factTable.entities >= 4, 'A2e factTable 元数据落账(entities=' + ((r.mapReduce.factTable || {}).entities) + ')');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }
  {
    // H: 用项目真实 checkpoint 验证跨块可见性，不回显任何历史正文或实体值。
    console.log('── [H] 真实 history-24 事实表回放 ──');
    const fixture = path.join(HERE, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354', 'history-24.json.gz');
    if (!fs.existsSync(fixture)) {
      console.log('SKIP H history-24 fixture 缺失');
    } else {
      const history = JSON.parse(zlib.gunzipSync(fs.readFileSync(fixture), 'utf8'));
      const table = srv.buildSummaryFactTableMessages(history);
      ok(history.length > 1 && table.entities > 0 && table.entities <= 16 && table.chunk && table.reduce,
        'H1 history-24 抽出有界全局事实表(不回显实体)');
      const FAKE = await getFreePort();
      const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105g-history-'));
      const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR });
      try {
        await sleep(400);
        // 显式关闭 105f，固定走 map-reduce；32K 窗口令该真实约 63K 历史产生多块。
        const provider = { id: 'g-history', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'g-history-m1', contextWindow: 32000 };
        const r = await srv.providerSummaryCall(provider, history, { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: true } });
        const payloads = readSumPayloads(SUMDIR);
        const factLines = table.chunk.content.split('\n').filter(line => line.startsWith('- '));
        const fingerprint = factLines[0] || '';
        ok(r.ok && !!r.mapReduce && r.mapReduce.chunks >= 2 && payloads.length >= 3,
          'H2 history-24 真实回放走多块 map-reduce');
        ok(!!fingerprint && payloads.every(p => p.includes('【全局事实表') && p.includes(fingerprint)),
          'H3 每个真实分段与汇总请求均携带同一全局事实表');
        ok(r.mapReduce.factTable && r.mapReduce.factTable.entities === table.entities,
          'H4 mapReduce 元数据实体计数与真实事实表一致');
      } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
    }
  }
  {
    // A3: 单发路径(历史小、不分块)即使开关开也不注入 —— 事实表只在真实 map-reduce 分支生效。
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105g-single-'));
    const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR });
    try {
      await sleep(400);
      const provider = { id: 'g2-prov', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'g2-m1', contextWindow: 65536 };
      const small = [user('目标:推进「飞星计划」'), { role: 'assistant', content: '好的,按计划执行 v3.1.4。' }];
      const r = await srv.providerSummaryCall(provider, small, { config: { runtimeSummaryFactTableV1: true } });
      const payloads = readSumPayloads(SUMDIR);
      ok(r.ok && !r.mapReduce, 'A3 小历史单发成功(未分块)');
      ok(payloads.length === 1 && !payloads[0].includes('全局事实表'), 'A3a 单发路径零注入(历史含可抽取实体也不注入)');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }
  {
    // A4: 零实体历史即使真实分块也不注入(双 null 降级不污染请求体)。
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105g-zero-'));
    const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR });
    try {
      await sleep(400);
      const provider = { id: 'g3-prov', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'g3-m1', contextWindow: 8000 };
      const r = await srv.providerSummaryCall(provider, historyNearTokens(11000, 6), { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: true } });
      const payloads = readSumPayloads(SUMDIR);
      ok(r.ok && !!r.mapReduce && r.mapReduce.chunks >= 2, 'A4 零实体历史仍正常分块(' + (r.mapReduce || {}).chunks + ' 段)');
      ok(payloads.length >= 3 && payloads.every(p => !p.includes('全局事实表')), 'A4a 零实体 → 全部请求零注入');
      ok(!(r.mapReduce || {}).factTable, 'A4b 零实体 → 无 factTable 元数据');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }

  if (failures) { console.log('\nSUMMARY-FACT-TABLE E2E: FAIL (' + failures + ')'); process.exitCode = 1; }
  else console.log('\nSUMMARY-FACT-TABLE E2E: ALL PASS');
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
