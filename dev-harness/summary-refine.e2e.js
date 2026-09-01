#!/usr/bin/env node
'use strict';
// 105h / 4.3 第二项: <=4 块顺序 refine。总门无净收益,默认关;任一步失败整条回退现有 map-reduce。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105h-unit-'));
const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let failures = 0;
const ok = (value, label) => value ? console.log('PASS ' + label) : (failures++, console.error('FAIL ' + label));
function kill(proc) { if (proc && proc.pid) try { cp.execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function fakeUp(port, env) {
  const proc = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(port)], {
    env: { ...process.env, FAKE_OPENAI_PORT: String(port), ...env }, windowsHide: true,
  });
  proc.stdout.on('data', () => {}); proc.stderr.on('data', () => {});
  return proc;
}
const user = content => ({ role: 'user', content });
function historyNearTokens(target, blocks, withEntities) {
  const per = Math.floor(target / blocks);
  let lo = 1, hi = per * 5, best = 1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (srv.estimateHistoryTokens([user('边界块 ' + 'x'.repeat(mid))]) <= per) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  const out = [];
  for (let i = 0; i < blocks; i++) out.push(user('块' + i + ' ' + 'x'.repeat(best)));
  if (withEntities) out[0].content = '决定代号「星桥计划」,版本 v4.3.1,路径 C:\\repo\\starbridge\\plan.md,日期 2026-09-01。' + out[0].content;
  return out;
}
function payloads(dir) {
  return fs.readdirSync(dir).filter(name => name.startsWith('sum-')).sort()
    .map(name => fs.readFileSync(path.join(dir, name), 'utf8'));
}

(async () => {
  console.log('── [U] 105h 开关与消息构造 ──');
  ok(srv.summaryRefineEnabled(srv.defaultConfig()) === false, 'U1 总门无净收益,默认关闭');
  ok(srv.summaryRefineEnabled({ runtimeSummaryRefineV1: true }) === true, 'U2 显式 true 生效');
  ok(srv.summaryRefineEnabled({ runtimeSummaryRefineV1: 'true' }) === false, 'U3 字符串 true 不误开启');
  const built = srv.buildSummaryRefineMessages('旧摘要', [user('后续决定')], { role: 'user', content: '事实表' });
  ok(built.length === 4 && built[0].content.includes('当前累计摘要') && built[1].content === '后续决定'
    && built[2].content.includes('新增历史块结束') && built[3].content === '事实表', 'U4 refine 消息边界与事实表顺序确定');

  console.log('── [A] 105h 内核路径与逐字节回退 ──');
  {
    const port = await getFreePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105h-main-'));
    const fake = fakeUp(port, { FAKE_RECORD_SUMMARY_DIR: dir });
    try {
      await sleep(400);
      const provider = { id: 'refine', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'refine-m', contextWindow: 8000 };
      const history = historyNearTokens(11000, 6, true);
      let result = await srv.providerSummaryCall(provider, history, { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: false } });
      let rows = payloads(dir);
      ok(result.ok && result.mapReduce && !result.mapReduce.refine && rows.length >= 3, 'A1 开关关走现有 map-reduce');
      ok(rows.every(row => !row.includes('当前累计摘要') && !row.includes('新增历史块')), 'A1a 开关关请求体零 refine 标记');

      for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name));
      result = await srv.providerSummaryCall(provider, history, { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: true } });
      rows = payloads(dir);
      ok(result.ok && result.mapReduce && result.mapReduce.refine && result.mapReduce.chunks >= 2 && result.mapReduce.chunks <= 4,
        'A2 <=4 块走顺序 refine(' + ((result.mapReduce || {}).chunks || '?') + ' 块)');
      ok(rows.length === result.mapReduce.chunks && rows.slice(1).every(row => row.includes('当前累计摘要') && row.includes('新增历史块')),
        'A2a refine 每块一次调用,第 2 步起携带累计摘要与新增块边界');
      ok(rows.every(row => !row.includes('【分段摘要')), 'A2b refine 不再发 reduce 汇总调用');

      for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name));
      result = await srv.providerSummaryCall(provider, history, { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: true, runtimeSummaryRefineV1: true } });
      rows = payloads(dir);
      ok(result.ok && result.mapReduce && result.mapReduce.refine && result.mapReduce.factTable, 'A3 refine+事实表组合元数据齐全');
      ok(rows.length >= 2 && rows.every(row => row.includes('全局事实表') && row.includes('星桥计划')), 'A3a 全局事实表进入每一步 refine');
    } finally { kill(fake); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  {
    const port = await getFreePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105h-many-'));
    const fake = fakeUp(port, { FAKE_RECORD_SUMMARY_DIR: dir });
    try {
      await sleep(400);
      const provider = { id: 'many', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'many-m', contextWindow: 8000 };
      const result = await srv.providerSummaryCall(provider, historyNearTokens(22000, 10, false), { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: true } });
      const rows = payloads(dir);
      ok(result.ok && result.mapReduce && result.mapReduce.chunks > 4 && !result.mapReduce.refine, 'A4 >4 块不启用 refine');
      ok(rows.every(row => !row.includes('当前累计摘要')), 'A4a >4 块请求体保持现有 map-reduce');
    } finally { kill(fake); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  {
    const port = await getFreePort();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105h-fallback-'));
    const valid = '【目标】目标\n【已确认的决定】决定\n【未完成事项】事项\n【当前执行状态】已完成：无；正在进行：测试；阻塞：无；下一步：继续\n【关键文件与上下文】文件';
    const fake = fakeUp(port, { FAKE_RECORD_SUMMARY_DIR: dir, FAKE_SUMMARY_SEQUENCE: JSON.stringify([valid, '', valid]) });
    try {
      await sleep(400);
      const provider = { id: 'fallback', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'fallback-m', contextWindow: 8000 };
      const result = await srv.providerSummaryCall(provider, historyNearTokens(11000, 6, false), { config: { runtimeSummarySingleShotV1: false, runtimeSummaryFactTableV1: false, runtimeSummaryRefineV1: true } });
      const rows = payloads(dir);
      ok(result.ok && result.mapReduce && result.mapReduce.degradedFromRefine === true && result.mapReduce.refineFailure === 'request',
        'A5 refine 第 2 步空响应 → 整条降级现有 map-reduce');
      ok(result.mapReduce.refineCalls === 2 && rows.length >= result.mapReduce.chunks + 3, 'A5a 失败前 2 次尝试 + 完整 map/reduce 均实际发出');
      ok(Number(result.usage && result.usage.prompt_tokens) > 11 * (result.mapReduce.chunks + 1), 'A5b 聚合 usage 包含降级前成功 refine 尝试');
    } finally { kill(fake); await sleep(200); fs.rmSync(dir, { recursive: true, force: true }); }
  }

  if (failures) { console.error('\nSUMMARY-REFINE E2E: FAIL (' + failures + ')'); process.exitCode = 1; }
  else console.log('\nSUMMARY-REFINE E2E: ALL PASS');
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
