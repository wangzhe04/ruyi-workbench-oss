'use strict';
// 架构还债批 2·A:瞬时错误重试骨架只有一份(04h withTransientRetry),08 的 OpenAI 子回合与 07 的 Claude CLI 子代理共用。
//   [R1] 瞬时判据 providerCallIsTransient:首字节前连接/TLS 失败、502/503/504(failoverStatus)、429 算;其余 4xx/500 与成功不算。
//   [R2] 非瞬时失败不重试、不睡。
//   [R3] 次数上限与退避序列(08:至多 3 次重试,250/500/750;07:总共 3 次 = 2 次重试,300/600;封顶 2000)。
//   [R4] 'again'(工具被拒 → 去掉工具再打一次)立即重来、不计数、不睡。
//   [R5] 每次发出前查中止;onRetry 先于退避睡眠。
//   [R6] 首字节之后的失败不重试:attempt 抛出(openAiStreamOnce 流式中途断开就是抛出)原样上抛,只发了一次。
//        用真 openAiStreamOnce 对假 provider 打:首字节前 503 被重试,流式开始后断连只发一次就抛。
//   [R7] abortableDelay:中止截断睡眠;signal 已中止时照睡满(与修前两份手写同形,调用方自己在睡前后查中止)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-transient-retry-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { providerCallIsTransient, withTransientRetry, abortableDelay, openAiStreamOnce, providerRequestHeaders, providerCompletionUrl } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { startFakeProvider, textFrames } = require('../lib/fake-openai-provider');

// 08 子回合与 07 CLI 子代理的两套参数(与源码里写的一致)。
const SUB_TURN = { maxRetries: 3, backoffMs: n => Math.min(2000, 250 * n) };
const CLI_SUB = { maxRetries: 2, backoffMs: n => Math.min(2000, 300 * n) };

// 按剧本逐次交回结果的 attempt;delay 注入成只记账不真睡。
function scripted(outcomes) {
  const log = [];
  let i = 0;
  return {
    log,
    attempt: async ({ retries }) => { log.push('attempt:' + retries); const o = outcomes[Math.min(i, outcomes.length - 1)]; i += 1; if (o instanceof Error) throw o; return o; },
    delay: async ms => { log.push('sleep:' + ms); },
  };
}
const classifyOpenAi = c => (providerCallIsTransient(c) ? 'retry' : 'done');

test('[R1] providerCallIsTransient 判据', () => {
  assert.equal(providerCallIsTransient({ transportError: 'connect ECONNREFUSED', transportReason: 'connect' }), true);
  assert.equal(providerCallIsTransient({ httpError: 'HTTP 503: busy', failoverStatus: 503 }), true);
  assert.equal(providerCallIsTransient({ httpError: 'HTTP 502', failoverStatus: 502 }), true);
  assert.equal(providerCallIsTransient({ httpError: 'HTTP 429: slow down' }), true);
  assert.equal(providerCallIsTransient({ httpError: 'HTTP 400: bad' }), false);
  assert.equal(providerCallIsTransient({ httpError: 'HTTP 401' }), false);
  assert.equal(providerCallIsTransient({ httpError: 'HTTP 500: oops' }), false);   // 500 不带 failoverStatus → 不算
  assert.equal(providerCallIsTransient({ httpError: 'HTTP 404: no such model' }), false);
  assert.equal(providerCallIsTransient({ text: 'ok', toolCalls: [] }), false);
  assert.equal(providerCallIsTransient(null), false);
});

test('[R2] 非瞬时失败只打一次、不睡', async () => {
  const s = scripted([{ httpError: 'HTTP 401: bad key' }]);
  const out = await withTransientRetry({ ...SUB_TURN, attempt: s.attempt, classify: classifyOpenAi, delay: s.delay });
  assert.deepEqual(out, { aborted: false, result: { httpError: 'HTTP 401: bad key' }, retries: 0 });
  assert.deepEqual(s.log, ['attempt:0']);
});

test('[R3] 子回合:瞬时失败至多重试 3 次,退避 250/500/750,交回最后一次', async () => {
  const s = scripted([{ httpError: 'HTTP 429', n: 1 }, { transportError: 'x', n: 2 }, { httpError: 'HTTP 503', failoverStatus: 503, n: 3 }, { httpError: 'HTTP 429', n: 4 }, { n: 5 }]);
  const out = await withTransientRetry({ ...SUB_TURN, attempt: s.attempt, classify: classifyOpenAi, delay: s.delay });
  assert.equal(out.aborted, false);
  assert.equal(out.retries, 3);
  assert.equal(out.result.n, 4);
  assert.deepEqual(s.log, ['attempt:0', 'sleep:250', 'attempt:1', 'sleep:500', 'attempt:2', 'sleep:750', 'attempt:3']);
});

test('[R3] 子回合:中途恢复即停,只睡过的那几次', async () => {
  const s = scripted([{ httpError: 'HTTP 429' }, { httpError: 'HTTP 502', failoverStatus: 502 }, { text: 'done' }]);
  const out = await withTransientRetry({ ...SUB_TURN, attempt: s.attempt, classify: classifyOpenAi, delay: s.delay });
  assert.deepEqual(out, { aborted: false, result: { text: 'done' }, retries: 2 });
  assert.deepEqual(s.log, ['attempt:0', 'sleep:250', 'attempt:1', 'sleep:500', 'attempt:2']);
});

test('[R3] CLI 子代理:总共 3 次(2 次重试),退避 300/600;退避封顶 2000', async () => {
  const s = scripted([{ fail: true }]);
  const out = await withTransientRetry({ ...CLI_SUB, attempt: s.attempt, classify: () => 'retry', delay: s.delay });
  assert.equal(out.retries, 2);
  assert.deepEqual(s.log, ['attempt:0', 'sleep:300', 'attempt:1', 'sleep:600', 'attempt:2']);
  const capped = scripted([{ fail: true }]);
  await withTransientRetry({ maxRetries: 10, backoffMs: SUB_TURN.backoffMs, attempt: capped.attempt, classify: () => 'retry', delay: capped.delay });
  assert.deepEqual(capped.log.filter(x => x.startsWith('sleep:')), [250, 500, 750, 1000, 1250, 1500, 1750, 2000, 2000, 2000].map(ms => 'sleep:' + ms));
});

test('[R4] again:立即重来、不计数、不睡(工具被拒只给一次)', async () => {
  let toolsRetried = false, useTools = true;
  const bodies = [];
  const outcomes = [{ httpError: 'HTTP 400: tools not supported', toolsRejected: true }, { httpError: 'HTTP 429' }, { text: 'ok' }];
  let i = 0;
  const log = [];
  const out = await withTransientRetry({
    ...SUB_TURN,
    attempt: async () => { bodies.push(useTools ? 'with-tools' : 'no-tools'); log.push('attempt'); return outcomes[i++]; },
    classify: c => {
      if (c.toolsRejected && useTools && !toolsRetried) { toolsRetried = true; useTools = false; return 'again'; }
      return providerCallIsTransient(c) ? 'retry' : 'done';
    },
    delay: async ms => { log.push('sleep:' + ms); },
  });
  assert.deepEqual(out, { aborted: false, result: { text: 'ok' }, retries: 1 });
  assert.deepEqual(bodies, ['with-tools', 'no-tools', 'no-tools']);
  assert.deepEqual(log, ['attempt', 'attempt', 'sleep:250', 'attempt']);   // 退避序号从 1 起:again 没占重试名额
});

test('[R5] 每次发出前查中止;onRetry 先于睡眠,拿到 (result, 第几次重试)', async () => {
  const pre = scripted([{ text: 'never' }]);
  const none = await withTransientRetry({ ...SUB_TURN, isAborted: () => true, attempt: pre.attempt, classify: classifyOpenAi, delay: pre.delay });
  assert.deepEqual(none, { aborted: true, result: undefined, retries: 0 });
  assert.deepEqual(pre.log, []);

  let aborted = false;
  const s = scripted([{ httpError: 'HTTP 429', k: 1 }, { httpError: 'HTTP 429', k: 2 }]);
  const out = await withTransientRetry({
    ...SUB_TURN,
    isAborted: () => aborted,
    attempt: s.attempt,
    classify: classifyOpenAi,
    onRetry: (res, n) => { s.log.push('retry:' + n + ':' + res.k); if (n === 2) aborted = true; },
    delay: s.delay,
  });
  assert.deepEqual(out, { aborted: true, result: { httpError: 'HTTP 429', k: 2 }, retries: 2 });
  assert.deepEqual(s.log, ['attempt:0', 'retry:1:1', 'sleep:250', 'attempt:1', 'retry:2:2', 'sleep:500']);
});

test('[R6] attempt 抛出(首字节之后的失败)原样上抛,不重试', async () => {
  const s = scripted([new Error('terminated')]);
  await assert.rejects(withTransientRetry({ ...SUB_TURN, attempt: s.attempt, classify: classifyOpenAi, delay: s.delay }), /terminated/);
  assert.deepEqual(s.log, ['attempt:0']);
});

test('[R6] 真 openAiStreamOnce:首字节前 503 被重试;流式开始后断连只发一次就抛', async () => {
  let mode = 'gateway';
  const fake = await startFakeProvider({
    handler(req) {
      if (mode === 'gateway' && req.index === 0) return { status: 503, json: { error: 'upstream busy' } };
      if (mode === 'gateway') return textFrames('recovered');
      req.open();
      req.sse(textFrames('partial')[0]);
      setTimeout(() => { try { req.res.destroy(); } catch { /* ignore */ } }, 30);
      return undefined;
    },
  });
  try {
    const provider = { id: 'fake', baseUrl: fake.url, apiKey: 'k', model: 'm' };
    const run = () => {
      const ctrl = new AbortController();
      const sleeps = [];
      return {
        sleeps,
        promise: withTransientRetry({
          ...SUB_TURN,
          attempt: () => openAiStreamOnce({ chatUrl: providerCompletionUrl(provider.baseUrl, false), headers: providerRequestHeaders(provider), body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true }, ctrl, onEvent: () => {}, markUsage: () => {}, rawSeqRef: { n: 0 }, touch: () => {} }),
          classify: classifyOpenAi,
          delay: async ms => { sleeps.push(ms); },
        }),
      };
    };
    const a = run();
    const out = await a.promise;
    assert.equal(out.retries, 1);
    assert.equal(out.result.text, 'recovered');
    assert.deepEqual(a.sleeps, [250]);
    assert.equal(fake.requests.length, 2);

    mode = 'midstream';
    const before = fake.requests.length;
    const b = run();
    await assert.rejects(b.promise);
    assert.equal(fake.requests.length - before, 1, '流式开始后的失败不重放');
    assert.deepEqual(b.sleeps, []);
  } finally {
    await fake.close();
  }
});

test('[R7] abortableDelay:中止截断;已中止的 signal 照睡满', async () => {
  const ctrl = new AbortController();
  const t0 = Date.now();
  setTimeout(() => ctrl.abort(), 20);
  await abortableDelay(5000, ctrl.signal);
  assert.ok(Date.now() - t0 < 2000, 'abort 截断了 5 s 的退避');

  const done = new AbortController(); done.abort();
  const t1 = Date.now();
  await abortableDelay(60, done.signal);
  assert.ok(Date.now() - t1 >= 50, '已中止的 signal 不提前返回(与修前手写同形)');

  const t2 = Date.now();
  await abortableDelay(30, undefined);
  assert.ok(Date.now() - t2 >= 25);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
