#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// summary-single-shot.e2e.js — 105f 摘要单发优先(runtimeSummarySingleShotV1,历史派生模拟门后默认开)
//
// 覆盖:
//   [U] 开关三态与上限解析(require 直测):
//       默认开 / 显式 false 回退 / 字符串 "true" 洗回 false(严格布尔);summarySingleShotCap 的
//       全局档位、provider/model 覆盖优先级与 [8192,131072] 钳位;reserve 预算分量确定性。
//   [A] 摘要内核行为(fake-openai + RECORD_SUMMARY_DIR + FAKE_SUMMARY_400_CHARS):
//       开关关 = 45a/22-S0 现状逐字节不变(32K 强制分块、窗口 × 50% 预算、400 不降级);
//       开关开 = 窗口 − reserve 预算让 40K 估算可单发;估算超上限仍分块;单发遇可识别
//       上下文超窗 400 自动降级 map-reduce(degradedFromSingle 标记);非超窗失败不降级。
//   [H-sim] 从项目真实 history-24 的消息内容派生 22K/26K/28K 高密度模拟历史：22K 保持单发，
//       26K/28K 在 48K 窗口、默认 32K 单发档下由旧 map-reduce 收敛为一次单发。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// 隔离纪律(同 context-compact-v2):require server.js 之前把数据根指向临时目录。
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105f-unit-'));

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
// 用真实估算器反推文本长度,避免把字符/token 比假定写死(同 context-compact-v2 的 historyNearTokens)。
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
// 用真实 checkpoint 的原始文本派生目标密度的模拟历史。它保留真实代码/JSON/自然语言的字符分布，
// 但为可控分块把文本均分为 user blocks；因此是「历史派生模拟」，不是声称原会话本身处于该长度。
function historyNearTokensFromFixture(file, target, blocks) {
  const history = JSON.parse(zlib.gunzipSync(fs.readFileSync(file), 'utf8'));
  const corpus = history.map(m => {
    if (!m || typeof m !== 'object') return '';
    const fields = [m.content, m.reasoning_content, m.arguments, m.output];
    if (Array.isArray(m.tool_calls)) for (const call of m.tool_calls) {
      const fn = call && call.function;
      if (fn && typeof fn.arguments === 'string') fields.push(fn.arguments);
    }
    return fields.filter(v => typeof v === 'string' && v).join('\n');
  }).filter(Boolean).join('\n\n');
  const build = chars => {
    const text = corpus.slice(0, chars);
    const size = Math.ceil(text.length / blocks);
    return Array.from({ length: blocks }, (_, i) => user(`【历史派生块 ${i + 1}/${blocks}】\n` + text.slice(i * size, (i + 1) * size)));
  };
  let lo = 1, hi = corpus.length, best = build(1);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = build(mid);
    if (srv.estimateHistoryTokens(candidate) <= target) { best = candidate; lo = mid + 1; }
    else hi = mid - 1;
  }
  return { history: best, estimate: srv.estimateHistoryTokens(best), sourceChars: corpus.length };
}

(async () => {
  // ═══ [U] 开关三态与上限解析 ═══
  console.log('── [U] 105f 开关与上限解析 ──');
  ok(srv.summarySingleShotEnabled(srv.defaultConfig()) === true, 'U1 默认配置开启(历史派生模拟门通过)');
  ok(srv.summarySingleShotEnabled({ runtimeSummarySingleShotV1: false }) === false, 'U2 显式 false 回退旧 map-reduce');
  ok(srv.summarySingleShotEnabled({ runtimeSummarySingleShotV1: true }) === true, 'U3 显式 true 生效');
  ok(srv.summarySingleShotEnabled({ runtimeSummarySingleShotV1: 'true' }) === false, 'U4 字符串 "true" 洗回 false(严格布尔)');
  const prov = { id: 'f-prov', baseUrl: 'http://x', model: 'f-m1' };
  ok(srv.summarySingleShotCap({}, prov, 'f-m1') === 32768, 'U4 上限缺省 32768(三档中档)');
  ok(srv.summarySingleShotCap({ summarySingleShotMaxTokensV1: 65536 }, prov, 'f-m1') === 65536, 'U5 全局档位 64K 生效');
  ok(srv.summarySingleShotCap({ summarySingleShotMaxTokensV1: 100 }, prov, 'f-m1') === 8192, 'U6a 下限钳位 8192(不提供无限档、也不允许过小)');
  ok(srv.summarySingleShotCap({ summarySingleShotMaxTokensV1: 999999 }, prov, 'f-m1') === 131072, 'U6b 上限钳位 131072');
  ok(srv.summarySingleShotCap({ summarySingleShotMaxTokensV1: '64K' }, prov, 'f-m1') === 32768, 'U6c 非数字落回默认 32768');
  const ov = { summarySingleShotMaxOverridesV1: { 'f-prov/f-m1': 16384, 'f-prov': 65536, 'style:chat': 16384 } };
  ok(srv.summarySingleShotCap(ov, prov, 'f-m1') === 16384, 'U7a provider/model 精确覆盖优先');
  ok(srv.summarySingleShotCap(ov, prov, 'other-m') === 65536, 'U7b 无精确覆盖时 provider 级生效');
  ok(srv.summarySingleShotCap(ov, { id: 'other', baseUrl: 'http://x' }, 'm') === 16384, 'U7c 仅引擎(style)覆盖兜底');
  ok(srv.summarySingleShotCap({ summarySingleShotMaxOverridesV1: { 'style:responses': 65536 } }, { id: 'r', baseUrl: 'http://x', apiStyle: 'responses' }, 'm') === 65536, 'U7d responses 引擎覆盖独立于 chat');
  ok(srv.summarySingleShotCap({ summarySingleShotMaxOverridesV1: { 'f-prov': 1 } }, prov, 'other-m') === 8192, 'U7e 覆盖值同样过钳位(坏覆盖不放宽)');
  const r1 = srv.summarySingleShotReserveTokens();
  ok(r1 === srv.summarySingleShotReserveTokens() && r1 >= 5000 && r1 <= 11000,
    'U8 reserve = system+prompt+输出+校准余量,确定且有界(' + r1 + ')');

  // ═══ [A] 摘要内核行为(fake-openai) ═══
  console.log('── [A] 105f 单发优先内核行为 ──');
  {
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105f-sum-'));
    const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR });
    try {
      await sleep(400);
      const provider = { id: 'a-prov', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'a-m1', contextWindow: 60000 };
      const summaryFiles = () => fs.readdirSync(SUMDIR).filter(f => f.startsWith('sum-')).sort();
      // A1: 估算 ≈40K、窗口 60K。开关开 + 64K 档 → 窗口 − reserve(≈54.5K)预算可容纳,单发成功;
      // 旧行为(窗口 × 50% = 30K 预算)必须 fit 截断或分块 —— 证明 reserve 预算真实生效。
      const h40 = historyNearTokens(40000, 5);
      const on64 = await srv.providerSummaryCall(provider, h40, { config: { runtimeSummarySingleShotV1: true, summarySingleShotMaxTokensV1: 65536 } });
      ok(on64.ok && !on64.mapReduce, 'A1 开关开+64K 档:≈40K 估算在「窗口−reserve」预算内单发成功');
      const off40 = await srv.providerSummaryCall(provider, h40, { config: { runtimeSummarySingleShotV1: false } });
      ok(off40.ok && !!off40.mapReduce, 'A2 同历史开关关:旧「窗口×50%」预算(30K)容不下 → 分块(现状逐字节不变)');
      // A3: 开关开但默认 32K 档:≈40K 估算超上限仍强制分块(上限把门语义不变)。
      const onDefault = await srv.providerSummaryCall(provider, h40, { config: { runtimeSummarySingleShotV1: true } });
      ok(onDefault.ok && !!onDefault.mapReduce && onDefault.mapReduce.degradedFromSingle !== true,
        'A3 开关开默认 32K 档:估算超上限仍分块(非 400 降级,无降级标记)');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }
  {
    // H-sim: 当前实录没有 20–28K 的完整 checkpoint，故从 history-24 原始消息内容派生同密度、
    // 受控长度的 4-user-block 模拟历史。开启 105e 的运行镜像，匹配产品默认估算口径。
    console.log('── [H-sim] 真实历史派生的 20–28K 单发配对 ──');
    const source = path.join(HERE, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354', 'history-24.json.gz');
    if (!fs.existsSync(source)) {
      console.log('SKIP H-sim history-24 fixture 缺失');
    } else {
      srv.setEstimateBucketsV1(true);
      const fixtures = [22000, 26000, 28000].map(target => historyNearTokensFromFixture(source, target, 4));
      // 26K 附近会跨 text/json 分类边界，估算可离散跳变；断言它处在能区分旧 24K 预算与新 32K cap 的 25–27K 区间。
      ok(fixtures[0].sourceChars > 0 && Math.abs(fixtures[0].estimate - 22000) <= 220 && fixtures[1].estimate >= 25000 && fixtures[1].estimate <= 27000 && Math.abs(fixtures[2].estimate - 28000) <= 280,
        'H1 从真实 history-24 派生 22K/≈26K/28K 高密度模拟历史(估算: ' + fixtures.map(f => f.estimate).join('/') + ')');
      const FAKE = await getFreePort();
      const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105f-hsim-'));
      const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR });
      try {
        await sleep(400);
        // 48K 窗口：旧预算 24K；105f 预算约 42.5K、默认单发 cap 32K。
        const provider = { id: 'hsim-prov', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'hsim-m1', contextWindow: 48000 };
        const count = () => fs.readdirSync(SUMDIR).filter(f => f.startsWith('sum-')).length;
        const call = async (fixture, config) => { const before = count(); const result = await srv.providerSummaryCall(provider, fixture.history, { config }); return { result, calls: count() - before }; };
        const h22On = await call(fixtures[0], { runtimeSummarySingleShotV1: true });
        const h22Off = await call(fixtures[0], {});
        ok(h22On.result.ok && !h22On.result.mapReduce && h22On.calls === 1 && h22Off.result.ok && !h22Off.result.mapReduce && h22Off.calls === 1,
          'H2 22K：新旧策略均单发一次(小历史不虚造收益)');
        const h26On = await call(fixtures[1], { runtimeSummarySingleShotV1: true });
        const h26Off = await call(fixtures[1], {});
        ok(h26On.result.ok && !h26On.result.mapReduce && h26On.calls === 1,
          'H3 26K：105f 默认 32K 档单发一次成功');
        ok(h26Off.result.ok && !!h26Off.result.mapReduce && h26Off.calls >= 3,
          'H4 26K：旧 50% 预算仍 map-reduce(≥3 次摘要调用)');
        const h28On = await call(fixtures[2], { runtimeSummarySingleShotV1: true });
        const h28Off = await call(fixtures[2], {});
        ok(h28On.result.ok && !h28On.result.mapReduce && h28On.calls === 1,
          'H5 28K：105f 默认 32K 档单发一次成功');
        ok(h28Off.result.ok && !!h28Off.result.mapReduce && h28Off.calls >= 3,
          'H6 28K：旧 50% 预算仍 map-reduce(≥3 次摘要调用)');
      } finally { srv.setEstimateBucketsV1(false); kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
    }
  }
  {
    // A4: 单发估算允许(≈28K ≤ 32K 档)但真实提供方越窗 400 → 自动降级 map-reduce。
    // 夹具:摘要请求体 >90KB 回 context 400;单发 ≈103KB 触发,分块(≤24K tokens ≈ ≤88KB)通过。
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105f-400-'));
    const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR, FAKE_SUMMARY_400_CHARS: '90000' });
    try {
      await sleep(400);
      const provider = { id: 'b-prov', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'b-m1', contextWindow: 100000 };
      const h28 = historyNearTokens(28000, 4);
      const before = fs.readdirSync(SUMDIR).length;
      const deg = await srv.providerSummaryCall(provider, h28, { config: { runtimeSummarySingleShotV1: true } });
      ok(deg.ok && !!deg.mapReduce && deg.mapReduce.chunks >= 2 && deg.mapReduce.degradedFromSingle === true,
        'A4 单发 400(可识别超窗)→ 自动降级 map-reduce ≥2 段并带降级标记');
      ok(fs.readdirSync(SUMDIR).length >= before + 3, 'A4a 降级实际发出分段+总汇请求(额外失败调用已发生并计账)');
      // A5: 开关关时同一历史同一 400 —— 现状是单发失败原样上浮,绝不自动降级。
      const off = await srv.providerSummaryCall(provider, h28, { config: { runtimeSummarySingleShotV1: false } });
      ok(!off.ok && !off.mapReduce && /context length/i.test(String(off.error || '')),
        'A5 开关关:单发 400 原样上浮不降级(现状逐字节不变)');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }
  {
    // A6: 非超窗失败(空摘要)即使在开关开时也绝不触发降级 —— 只有可识别的上下文超窗 400 才降级。
    const FAKE = await getFreePort();
    const fake = fakeUp(FAKE, { FAKE_SUMMARY_SEQUENCE: JSON.stringify(['']) });
    try {
      await sleep(400);
      const provider = { id: 'c-prov', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'c-m1', contextWindow: 100000 };
      const r = await srv.providerSummaryCall(provider, [user('目标'), { role: 'assistant', content: '答复' }], { config: { runtimeSummarySingleShotV1: true } });
      ok(!r.ok && !r.mapReduce && /empty summary/.test(String(r.error || '')), 'A6 非超窗失败(空摘要)原样上浮,不误降级');
    } finally { kill(fake); await sleep(200); }
  }

  if (failures) { console.log('\nSUMMARY-SINGLE-SHOT E2E: FAIL (' + failures + ')'); process.exitCode = 1; }
  else console.log('\nSUMMARY-SINGLE-SHOT E2E: ALL PASS');
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
