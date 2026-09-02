#!/usr/bin/env node
'use strict';
// 105j: 摘要调用策略回归。
// [U] 已知 DeepSeek V4 选择实测锚定的 reasoning/output 候选;未知端点零控制字段。
// [A] fake 端点拒绝参数时只兼容重试一次;命中 finish_reason=length 时只升一档,不放大到无限输出。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105j-policy-'));
const srv = require('../ruyi-workbench/app/server.js');
const { getFreePort } = require('./free-port.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const user = content => ({ role: 'user', content });
let failures = 0;
const ok = (value, label) => { if (value) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function fakeUp(port, env) {
  const child = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(port)], {
    env: { ...process.env, FAKE_OPENAI_PORT: String(port), ...env }, windowsHide: true,
  });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  return child;
}
function kill(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}
function bodies(dir) {
  return fs.readdirSync(dir).filter(name => name.startsWith('sum-')).sort().map(name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
}
function provider(port, id, model = 'deepseek-v4-flash') {
  return { id, baseUrl: `http://127.0.0.1:${port}/v1`, apiStyle: 'chat', apiKey: 'k', model, contextWindow: 128000 };
}

(async () => {
  console.log('SUMMARY CALL POLICY E2E');
  const responses = srv.resolveSummaryCallPolicy({ id: 'deepseek', baseUrl: 'https://api.deepseek.com' }, 'deepseek-v4-flash', 'responses', 'map');
  ok(responses.known && responses.reasoning.mode === 'effort' && responses.reasoning.value === 'minimal', 'U1 DeepSeek V4 Responses 选用 minimal');
  ok(responses.output.field === 'max_output_tokens' && responses.output.tiers[0] === 4096 && responses.output.tiers[1] === 6144, 'U2 Responses map 输出候选 4096→6144');
  const chat = srv.resolveSummaryCallPolicy({ id: 'deepseek', baseUrl: 'https://api.deepseek.com' }, 'deepseek-v4-pro', 'chat', 'reduce');
  ok(chat.output.field === 'max_tokens' && chat.output.tiers[0] === 6144 && chat.output.tiers[1] === 8192, 'U3 Chat reduce 输出候选 6144→8192');
  const unknown = srv.resolveSummaryCallPolicy({ id: 'custom', baseUrl: 'https://custom.invalid', reasoningEffort: 'xhigh' }, 'vendor-model', 'chat', 'map');
  ok(!unknown.known && unknown.reasoning.mode === 'omit' && unknown.output.field === '', 'U4 未知模型不发送 reasoning/max-output 控制');
  const normalized = srv.normalizeConfig({ providers: [{ id: 'p', baseUrl: 'https://x.invalid', reasoningEffort: 'MAX' }] }).config.providers[0];
  ok(srv.providerReasoningEffort(normalized) === 'max', 'U5 Provider reasoning max 归一化保留');

  const port = await getFreePort();
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105j-reject-'));
    const fake = fakeUp(port, { FAKE_RECORD_SUMMARY_DIR: dir, FAKE_SUMMARY_REJECT_PARAMS: 'max_tokens' });
    try {
      await sleep(350);
      const result = await srv.providerSummaryCall(provider(port, 'reject-case'), [user('兼容参数拒绝测试')], { config: {} });
      const sent = bodies(dir);
      ok(result.ok && result.summaryPolicy && result.summaryPolicy.retries === 1, 'A1 参数拒绝只做一次兼容重试并成功');
      ok(sent.length === 2 && sent[0].reasoning_effort === 'minimal' && sent[0].max_tokens === 6144 && sent[1].reasoning_effort === 'minimal' && !sent[1].max_tokens, 'A2 重试只移除被拒字段且保留兼容字段');
      ok(result.summaryPolicy.outputField === 'omit' && result.summaryPolicy.reasoning === 'minimal', 'A3 能力降级结果落在返回元数据');
    } finally { kill(fake); await sleep(150); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105j-incomplete-'));
    const fake = fakeUp(port, { FAKE_RECORD_SUMMARY_DIR: dir, FAKE_SUMMARY_INCOMPLETE_UNTIL: '6144' });
    try {
      await sleep(350);
      const result = await srv.providerSummaryCall(provider(port, 'incomplete-case'), [user('输出上限阶梯测试')], { config: {} });
      const sent = bodies(dir);
      ok(result.ok && result.summaryPolicy && result.summaryPolicy.retries === 1, 'A4 incomplete 只升一档后成功');
      ok(sent.length === 2 && sent[0].max_tokens === 6144 && sent[1].max_tokens === 8192, 'A5 输出上限按 6144→8192 有界升级');
    } finally { kill(fake); await sleep(150); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-105j-unknown-'));
    const fake = fakeUp(port, { FAKE_RECORD_SUMMARY_DIR: dir });
    try {
      await sleep(350);
      const result = await srv.providerSummaryCall(provider(port, 'unknown-case', 'vendor-model'), [user('未知模型兼容测试')], { config: {} });
      const sent = bodies(dir)[0];
      ok(result.ok && sent && !Object.prototype.hasOwnProperty.call(sent, 'reasoning_effort') && !Object.prototype.hasOwnProperty.call(sent, 'max_tokens'), 'A6 未知端点请求体保持最低兼容形状');
    } finally { kill(fake); await sleep(150); fs.rmSync(dir, { recursive: true, force: true }); }
  }
  console.log(failures ? `SUMMARY CALL POLICY E2E: FAIL (${failures})` : 'SUMMARY CALL POLICY E2E: ALL PASS');
  process.exitCode = failures ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
