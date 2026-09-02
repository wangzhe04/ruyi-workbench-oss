#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// summary-parallel-cap.e2e.js — 105i map-reduce 有界并发 + fail-fast 取消
//
// 背景:无上限 Promise.all 在 800K 历史(36 chunk)下把 provider 打进排队/限流,整体失败。
// 105i 给 map/reduce 轮内加并发上限(summaryMaxConcurrentV1,默认 8,钳 [1,8])与
// 失败取消(任一块失败 → 共享 AbortController 取消在飞请求、停止派发新块)。
//
// 覆盖:
//   [U] summaryMaxConcurrent 解析(默认/显式/钳位/坏值)与 mapSummaryWithLimit 直测
//       (保序、并发峰值 = 上限、fail-fast 取消信号与停止派发)。
//   [A] fake-openai 集成(FAKE_SUMMARY_DELAY_MS + FAKE_INFLIGHT_LOG + FAKE_SUMMARY_FAIL_SEQ):
//       ≥8 chunk 历史下默认 8 路的在飞峰值;失败注入时快速上浮且未派发块不再发出;
//       summaryMaxConcurrentV1:1 退化为串行。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离纪律(同 context-compact-v2):require server.js 之前把数据根指向临时目录。
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105i-unit-'));

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
// 用真实估算器反推文本长度,避免把字符/token 比假定写死(同 summary-single-shot)。
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
function maxInFlightFromLog(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
      .reduce((m, l) => Math.max(m, Number(JSON.parse(l).inFlight) || 0), 0);
  } catch { return -1; }
}

(async () => {
  // ═══ [U] 上限解析与有界并发助手直测 ═══
  console.log('── [U] 105i 上限解析与 mapSummaryWithLimit ──');
  ok(srv.summaryMaxConcurrent({}) === 8, 'U1 未知模型全局默认并发上限 8');
  ok(srv.summaryMaxConcurrent({}, { model: 'deepseek-v4-flash' }, 'deepseek-v4-flash') === 8, 'U1b DeepSeek V4 全局默认并发上限 8');
  ok(srv.summaryMaxConcurrent({ summaryMaxConcurrentV1: 6 }, { model: 'deepseek-v4-flash' }, 'deepseek-v4-flash') === 6, 'U2 显式 6 生效');
  ok(srv.summaryMaxConcurrent({ summaryMaxConcurrentV1: 0 }) === 1, 'U3a 下限钳位 1');
  ok(srv.summaryMaxConcurrent({ summaryMaxConcurrentV1: 99 }) === 8, 'U3b 上限钳位 8');
  ok(srv.summaryMaxConcurrent({ summaryMaxConcurrentV1: 'x' }) === 8, 'U4 非数字落回默认 8');
  {
    // 有界并发:9 项上限 4,峰值必须恰好 4(延迟保证第一波充分重叠),结果按下标保序。
    let inFlight = 0, peak = 0, dispatched = 0;
    const results = await srv.mapSummaryWithLimit(Array.from({ length: 9 }), 4, async (i) => {
      dispatched++; inFlight++; peak = Math.max(peak, inFlight);
      await sleep(30);
      inFlight--;
      return { ok: true, summary: 's' + i };
    }, null);
    ok(peak === 4 && dispatched === 9 && results.every((r, i) => r && r.summary === 's' + i),
      'U5 峰值=上限且全部派发、结果按输入下标保序(peak=' + peak + ')');
  }
  {
    // fail-fast:第 2 项(下标 1)立即失败,其余延迟 200ms —— 取消信号触发、第一波之后不再派发。
    let dispatched = 0;
    const ctrl = new AbortController();
    const results = await srv.mapSummaryWithLimit(Array.from({ length: 9 }), 4, async (i) => {
      dispatched++;
      if (i === 1) return { ok: false, error: 'injected' };
      await sleep(200);
      return { ok: true, summary: 's' + i };
    }, ctrl);
    ok(ctrl.signal.aborted === true, 'U6a 任一失败即触发共享取消信号');
    ok(dispatched <= 4 && results[1] && results[1].ok === false && results[8] === undefined,
      'U6b 停止派发新任务(dispatched=' + dispatched + '/9),失败结果保序落位,未派发为空位');
  }

  // ═══ [A] fake-openai 集成 ═══
  // 窗口 128K(预算 ≈122K 可容纳 52K 历史)→ needsMapReduce false;单发档 8192 强制分块,
  // 块预算 max(4000, 8192×0.75)=6144 → 9 个 user 块各成一段,chunks=9。
  const BASE_CONFIG = { runtimeSummarySingleShotV1: true, summarySingleShotMaxTokensV1: 8192 };
  {
    console.log('── [A] 默认 8 路有界并发 ──');
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105i-sum-'));
    const INFLIGHT = path.join(SUMDIR, 'inflight.ndjson');
    const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR, FAKE_SUMMARY_DELAY_MS: '200', FAKE_INFLIGHT_LOG: INFLIGHT });
    try {
      await sleep(400);
      const provider = { id: 'p105i', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'm105i', contextWindow: 128000 };
      const h = historyNearTokens(52000, 9);
      const r = await srv.providerSummaryCall(provider, h, { config: { ...BASE_CONFIG } });
      ok(r.ok && r.mapReduce && r.mapReduce.chunks >= 8, 'A1 多段 map-reduce 成功(chunks=' + (r.mapReduce && r.mapReduce.chunks) + ')');
      ok(r.mapReduce && r.mapReduce.concurrency === 8, 'A2 mapReduce 元数据落生效并发上限 8');
      const peak = maxInFlightFromLog(INFLIGHT);
      ok(peak >= 2 && peak <= 8, 'A3 fake 侧在飞峰值 ∈ [2,8](确实并行且不越上限, peak=' + peak + ')');
      const files = fs.readdirSync(SUMDIR).filter(f => f.startsWith('sum-')).length;
      ok(files === r.mapReduce.chunks + 1, 'A4 请求总数 = chunks + 1 次总汇(' + files + '),无多发漏发');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }
  {
    console.log('── [A] 失败注入 → fail-fast 取消 ──');
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105i-fail-'));
    const fake = fakeUp(FAKE, {
      FAKE_RECORD_SUMMARY_DIR: SUMDIR, FAKE_SUMMARY_DELAY_MS: '800', FAKE_SUMMARY_FAIL_SEQ: '1',
    });
    try {
      await sleep(400);
      const provider = { id: 'p105i', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'm105i', contextWindow: 128000 };
      const h = historyNearTokens(52000, 9);
      const t0 = Date.now();
      const r = await srv.providerSummaryCall(provider, h, { config: { ...BASE_CONFIG } });
      const elapsed = Date.now() - t0;
      ok(!r.ok && /HTTP 500/.test(String(r.error)), 'B1 首个失败(注入 500)原样上浮: ' + String(r.error).slice(0, 60));
      const files = fs.readdirSync(SUMDIR).filter(f => f.startsWith('sum-')).length;
      ok(files >= 1 && files <= 8, 'B2 失败后未派发的块不再发出(到达 fake 的请求=' + files + '/9,仅第一波)');
      ok(elapsed < 5000, 'B3 快速止损(取消在飞请求,不等待 800ms×N,' + elapsed + 'ms)');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }
  {
    console.log('── [A] summaryMaxConcurrentV1:1 退化串行 ──');
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105i-ser-'));
    const INFLIGHT = path.join(SUMDIR, 'inflight.ndjson');
    const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR, FAKE_SUMMARY_DELAY_MS: '50', FAKE_INFLIGHT_LOG: INFLIGHT });
    try {
      await sleep(400);
      const provider = { id: 'p105i', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'm105i', contextWindow: 128000 };
      const h = historyNearTokens(52000, 9);
      const r = await srv.providerSummaryCall(provider, h, { config: { ...BASE_CONFIG, summaryMaxConcurrentV1: 1 } });
      const peak = maxInFlightFromLog(INFLIGHT);
      ok(r.ok && r.mapReduce && r.mapReduce.concurrency === 1 && peak === 1,
        'C1 上限 1 退化为串行(峰值=1)且仍成功(concurrency=' + (r.mapReduce && r.mapReduce.concurrency) + ', peak=' + peak + ')');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }

  console.log(failures ? `\nSUMMARY-PARALLEL-CAP E2E: FAIL (${failures})` : '\nSUMMARY-PARALLEL-CAP E2E: ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('SUMMARY-PARALLEL-CAP E2E: ERROR', e); process.exit(1); });
