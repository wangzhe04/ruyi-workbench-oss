'use strict';
// 子代理的迭代边界自动压缩(10 maybeCompactSubHistory)接子回合的中止信号 —— 与主回合 maybeAutoCompact 同一条线
// (见 summary-call-stop.test.js 那一层的单测)。修前 08 只把 ctrl.signal 接进了强压(forced-400)那条路,
// 迭代边界那条 L2 摘要调用不认 Stop:父回合停了,子代理还要在边界上干等摘要调用返回(几十秒到几分钟),
// 回来之后照样把摘要重播种进 subHistory。真源码、临时 HOME、进程内假 provider(摘要慢回)、真 runSubAgentCore。
//   [K0] 对照:不停止 —— 同一份设置真的走到 L2 摘要并重播种(证明下面那条不是空转)。
//   [K1] 摘要在飞时 abort:子代理当场收住(不等摘要慢回);「压缩中」收成 failed + aborted;没有 completed
//        (历史没被重播种);停止之后不再发任何模型请求;日志走的是 aborted 那一支(ok:false, aborted:true,
//        不带 error)—— 摘要失败那一支才写 10 分钟冷却(compactionSummaryFailures),aborted 这支不写。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-sub-compact-stop-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { runSubAgentCore } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); if (t.unref) t.unref(); });

const SUMMARY = '【目标】x\n【已确认的决定】无\n【未完成事项】无\n【当前执行状态】已完成:a;正在进行:b;阻塞:无;下一步:c\n【关键文件与上下文】无';
const SUMMARY_MARK = '请把以上对话压缩为结构化摘要';
const isSummary = rq => JSON.stringify(rq.messages).includes(SUMMARY_MARK);
// 一个要读的大文件:工具结果进 subHistory 后,下一个迭代边界必然越过小窗口的预算。
const BIG = path.join(root, 'big.txt');
fs.writeFileSync(BIG, Array.from({ length: 400 }, (_, i) => `第${i}行 ` + 'x'.repeat(60)).join('\n'), 'utf8');

let summaryDelayMs = 0;
let summaryStartedAt = 0;
let fake;
test('setup', async () => {
  fake = await startFakeProvider({
    async handler(rq) {
      if (isSummary(rq)) {
        summaryStartedAt = Date.now();
        if (summaryDelayMs) await sleep(summaryDelayMs);
        return [...textFrames(SUMMARY), usageFrame(10, 10)];
      }
      if (!rq.messages.some(m => m.role === 'tool')) return toolCallFrames('file_read', { path: BIG }, 'call_big');
      return [...textFrames('done'), usageFrame(8, 4)];
    },
  });
});

// 每次一个新的服务商 id:冷却表按「服务商|模型」记,各用例互不串味。
const providerFor = id => ({ id, label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', contextWindow: 4000 });
function runSub(tag, ctrl, events) {
  return runSubAgentCore({
    parentSession: { id: 'sess_subcompact_' + tag, cwd: root, turnSeq: 1 }, provider: providerFor('fake-' + tag),
    config: { permissionMode: 'bypass', defaultWorkspace: root },
    task: '读一下 big.txt 然后总结', toolTier: 'read', maxIters: 6, onEvent: e => events.push(e),
    subagentId: 'sa_' + tag, depth: 1, ctrl, runId: 'run_' + tag,
  });
}
const compactEvents = (events, phase) => events.filter(e => e && e.type === 'compact' && e.mode === 'summary' && (!phase || e.phase === phase));
function logRows(kind) {
  const dir = path.join(root, 'logs');
  let rows = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^workbench-.*\.ndjson$/.test(f)) continue;
      rows = rows.concat(fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
    }
  } catch { /* 日志目录还没建 */ }
  return rows.filter(r => r.kind === kind);
}

test('[K0] 对照:不停止时同一份设置走到 L2 摘要并重播种', async () => {
  summaryDelayMs = 0;
  const events = [];
  const r = await runSub('k0', new AbortController(), events);
  assert.ok(compactEvents(events, 'started').length >= 1, '前提:子代理在迭代边界上发起了 L2 摘要:' + JSON.stringify(events.filter(e => e && e.type === 'compact')));
  assert.ok(compactEvents(events, 'completed').length >= 1, '不停止时摘要成功、重播种');
  assert.ok(r && r.ok !== false, '子代理正常收尾:' + JSON.stringify(r).slice(0, 300));
});

test('[K1] L2 摘要在飞时停止:当场收住、不重播种、不算摘要失败', async () => {
  summaryDelayMs = 10000;
  summaryStartedAt = 0;
  const ctrl = new AbortController();
  const events = [];
  const run = runSub('k1', ctrl, events);
  for (let i = 0; i < 300 && !summaryStartedAt; i++) await sleep(20);
  assert.ok(summaryStartedAt > 0, '前提:摘要请求已经发出(在飞)');
  await sleep(150);
  const requestsAtStop = fake.requests.length;
  const stopAt = Date.now();
  ctrl.abort();
  const r = await Promise.race([run, sleep(8000).then(() => 'timeout')]);
  const took = Date.now() - stopAt;
  // 墙钟上界豁免:判的是「停止当场取消在飞的摘要调用」;失败形态是等满摘要慢回的 10 s(这里 8 s 即判红)。
  assert.notEqual(r, 'timeout', `停止之后子代理还在等摘要调用(>${took} ms)`);
  assert.ok(took < 3000, `停止之后还等了 ${took} ms`);
  assert.ok(r && r.ok === false, '子代理结果是失败/中止:' + JSON.stringify(r).slice(0, 300));
  const failed = compactEvents(events, 'failed');
  assert.ok(failed.length === 1 && failed[0].aborted === true && failed[0].subagentId === 'sa_k1',
    '「压缩中」收成 failed + aborted(带 subagentId):' + JSON.stringify(failed));
  assert.equal(compactEvents(events, 'completed').length, 0, '被取消的摘要没有重播种进子代理历史');
  assert.equal(fake.requests.length, requestsAtStop, '停止之后没有再发任何模型请求');
  let rows = [];
  for (let i = 0; i < 50; i++) {
    rows = logRows('auto_compact').filter(x => x.subagentId === 'sa_k1' && x.mode === 'summary');
    if (rows.length) break;
    await sleep(40);
  }
  assert.ok(rows.length === 1 && rows[0].ok === false && rows[0].aborted === true && rows[0].error === undefined,
    '走的是 aborted 那一支(不进 10 分钟摘要失败冷却):' + JSON.stringify(rows));
});

test('teardown', async () => { await fake.close(); });

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
