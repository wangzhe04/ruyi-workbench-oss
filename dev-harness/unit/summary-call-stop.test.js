'use strict';
// 摘要调用(10 providerSummaryCall)接回合的停止信号(opts.signal)—— 审计 t12:L2 摘要压缩期间按停止,修前
// 回合要在迭代边界上干等摘要调用返回(几十秒到几分钟)。真源码、临时 HOME、进程内假 provider(摘要慢回)。
//   [M1] 单发路径:在飞时 abort → 当场返回 { ok:false, aborted:true },不等服务商回包。
//   [M2] 已经停了再调:一次请求都不发,直接 aborted。
//   [M3] map-reduce 路径(单发关、历史大到要分块):abort 同样当场收住,结果标 aborted。
//   [M4] 不传 signal:行为不变(慢回也等到、成功返回摘要)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeProvider, textFrames, usageFrame } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-summary-stop-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { providerSummaryCall } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SUMMARY = '【目标】x\n【已确认的决定】无\n【未完成事项】无\n【当前执行状态】已完成:a;正在进行:b;阻塞:无;下一步:c\n【关键文件与上下文】无';
let delayMs = 0;
let responseGate = null;
let requestStarted = null;
let fake;
const provider = () => ({ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', contextWindow: 16000 });
const small = [{ role: 'user', content: '目标:做一件事' }, { role: 'assistant', content: '好的,开始' }];
// 远超单发上限的历史(单发关时按预算分块走 map-reduce)
const big = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `第${i}段 ` + '内容'.repeat(900) }));

test('setup', async () => {
  fake = await startFakeProvider({
    async handler() {
      if (responseGate) { requestStarted(); await responseGate; }
      else if (delayMs) await sleep(delayMs);
      return [...textFrames(SUMMARY), usageFrame(10, 10)];
    },
  });
});

async function abortInFlight(history, config) {
  let releaseResponse;
  responseGate = new Promise(resolve => { releaseResponse = resolve; });
  const started = new Promise(resolve => { requestStarted = resolve; });
  const ctrl = new AbortController();
  const call = providerSummaryCall(provider(), history, { config, signal: ctrl.signal });
  let requestTimer;
  let abortTimer;
  try {
    // Start measuring once the provider has received the request. Cold config
    // and CLI discovery must not count as cancellation latency.
    assert.ok(await Promise.race([started.then(() => true), new Promise(resolve => { requestTimer = setTimeout(() => resolve(false), 10000); })]), '摘要请求已经在飞');
    ctrl.abort();
    const r = await Promise.race([call, new Promise((_, reject) => { abortTimer = setTimeout(() => reject(new Error('停止后仍在等服务商回包')), 2000); })]);
    assert.equal(r.ok, false);
    assert.equal(r.aborted, true, '停止取消的失败要标 aborted(调用方据此不进冷却):' + JSON.stringify(r));
  } finally {
    clearTimeout(requestTimer);
    clearTimeout(abortTimer);
    ctrl.abort();
    releaseResponse();
    responseGate = null;
    await call;
  }
}

test('[M1] 单发:在飞时 abort → 当场 aborted', async () => {
  await abortInFlight(small, {});
});

test('[M2] 已停止:一次请求都不发', async () => {
  delayMs = 0;
  const before = fake.requests.length;
  const ctrl = new AbortController(); ctrl.abort();
  const r = await providerSummaryCall(provider(), small, { config: {}, signal: ctrl.signal });
  assert.equal(r.aborted, true);
  assert.equal(fake.requests.length, before, '已停止还发了摘要请求');
});

test('[M3] map-reduce:abort 当场收住', async () => {
  await abortInFlight(big, { runtimeSummarySingleShotV1: false });
});

test('[M4] 不传 signal:慢回也等到、正常成功', async () => {
  delayMs = 600;
  const r = await providerSummaryCall(provider(), small, { config: {} });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!r.aborted);
});

test('teardown', async () => { await fake.close(); });

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
