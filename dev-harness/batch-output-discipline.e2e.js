(async () => {
'use strict';
// 106 #3 批量输出纪律 · 离线机制件（fake-openai，不起真实模型）。
//
// 场景：design-and-decide 的 option 扇出（独立/同构/容量受控的三方案生成）。
// 逐项臂 = option_a/b/c 三个独立节点；批量臂 = 一个节点用「槽位对象」outputSchema
// 一次产出 option_a/b/c 三个槽位。本件只验机制契约（22 号文 §6.2），不验质量：
//   - 稳定候选 ID = schema 属性键；完整覆盖 = required 三槽；漏项/异常候选 = schema 拒绝
//   - 重复槽位在对象属性编码下结构上不可能（同名键后者覆盖前者，仍是三键）
//   - 失败重试：failurePolicy retry 整体重试；schema 失败时【部分结果保留】——
//     09-workflow.js:970 先落 structuredResult 再记 schemaErrors，下游能读到有效槽位 +
//     缺失槽位名，逐项修补（只重生成失败项）可行；兜底链用 condition status_is failed 接管
// 真实模型的逐项/批量质量·调用数·费用对照在 batch-output-gate-live.js（live 件）。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-batch-output-discipline');
const FP = await getFreePort(), WP = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function get(port, p, headers = {}) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function post(port, p, body, headers = {}) { return new Promise((resolve, reject) => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } }); }); r.on('error', reject); r.write(raw); r.end(); }); }
async function up(port, path0 = '/health') { for (let i = 0; i < 60; i++) { if (await get(port, path0)) return true; await sleep(150); } return false; }

const OPTION = {
  type: 'object', additionalProperties: false,
  required: ['orientation', 'overview', 'tradeoffs', 'risks'],
  properties: { orientation: { type: 'string' }, overview: { type: 'string' }, tradeoffs: { type: 'string' }, risks: { type: 'string' } },
};
const SLOTS = {
  type: 'object', additionalProperties: false,
  required: ['option_a', 'option_b', 'option_c'],
  properties: { option_a: OPTION, option_b: OPTION, option_c: OPTION },
};
const slot = (o) => ({ orientation: o, overview: `overview ${o}`, tradeoffs: `tradeoffs ${o}`, risks: `risks ${o}` });
const GOOD = JSON.stringify({ option_a: slot('conservative'), option_b: slot('performance'), option_c: slot('minimal') });
const MISSING = JSON.stringify({ option_a: slot('conservative'), option_b: slot('performance') });
const EXTRA = JSON.stringify({ option_a: slot('conservative'), option_b: slot('performance'), option_c: slot('minimal'), option_d: slot('surprise') });
const BADTYPE = JSON.stringify({ option_a: slot('conservative'), option_b: 'not-an-object', option_c: slot('minimal') });

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const script = {
    subText: 'plain done',
    subTextByTask: {
      BATCH_OK: GOOD,
      BATCH_MISSING: MISSING,
      BATCH_EXTRA: EXTRA,
      BATCH_BADTYPE: BADTYPE,
      FALLBACK_A: JSON.stringify(slot('conservative')),
      FALLBACK_B: JSON.stringify(slot('performance')),
      FALLBACK_C: JSON.stringify(slot('minimal')),
    },
  };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_SUBAGENT_SCRIPT: JSON.stringify(script) }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(FP, '/v1/models') && await up(WP), 'fake provider and workbench start');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'batch', cwd: HOME }, hdr);
    const sid = created.session.id;
    const by = (res, id) => (res.results || []).find(n => n.id === id) || {};

    // Run 1: 批量节点一次产出三槽 —— 覆盖完整时与逐项等价地进入 decide
    const r1 = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [
      { id: 'clarify', task: 'CLARIFY the subject' },
      { id: 'options_batch', task: 'BATCH_OK produce three options', dependsOn: ['clarify'], outputSchema: SLOTS },
      { id: 'decide', task: 'DECIDE among options', dependsOn: ['options_batch'] },
    ] }, hdr);
    ok(r1.ok === true, 'run1 launch ok');
    ok(by(r1, 'options_batch').status === 'succeeded' && by(r1, 'options_batch').attempts === 1, 'run1 batch succeeds on first attempt');
    const sr1 = by(r1, 'options_batch').structuredResult || {};
    const keys1 = Object.keys(sr1).sort();
    ok(keys1.join(',') === 'option_a,option_b,option_c', 'run1 stable candidate ids = exactly the three slots');
    ok(['option_a', 'option_b', 'option_c'].every(k => sr1[k] && typeof sr1[k].overview === 'string' && typeof sr1[k].tradeoffs === 'string' && typeof sr1[k].risks === 'string' && typeof sr1[k].orientation === 'string'), 'run1 every slot carries the full field set');
    ok(by(r1, 'decide').status === 'succeeded', 'run1 decide consumes the batch result');

    // Run 2: 漏项 → schema 拒绝 → 整体重试仍失败 → condition 接管的逐项兜底三节点
    const r2 = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [
      { id: 'options_batch', task: 'BATCH_MISSING drops option_c', outputSchema: SLOTS, failurePolicy: 'retry', maxRetries: 1, retryFallback: 'continue' },
      { id: 'fallback_a', task: 'FALLBACK_A only', dependsOn: ['options_batch'], dependencyPolicy: 'all_settled', condition: { node: 'options_batch', path: '$', operator: 'status_is', value: 'failed' }, outputSchema: OPTION },
      { id: 'fallback_b', task: 'FALLBACK_B only', dependsOn: ['options_batch'], dependencyPolicy: 'all_settled', condition: { node: 'options_batch', path: '$', operator: 'status_is', value: 'failed' }, outputSchema: OPTION },
      { id: 'fallback_c', task: 'FALLBACK_C only', dependsOn: ['options_batch'], dependencyPolicy: 'all_settled', condition: { node: 'options_batch', path: '$', operator: 'status_is', value: 'failed' }, outputSchema: OPTION },
      { id: 'never', task: 'NEVER_RUN on success path', dependsOn: ['options_batch'], dependencyPolicy: 'all_settled', condition: { node: 'options_batch', path: '$', operator: 'status_is', value: 'succeeded' } },
      { id: 'decide', task: 'DECIDE among options', dependsOn: ['options_batch', 'fallback_a', 'fallback_b', 'fallback_c'], dependencyPolicy: 'all_settled' },
    ] }, hdr);
    const fb = by(r2, 'options_batch');
    ok(fb.attempts === 2, 'run2 missing slot triggers exactly one whole-node retry');
    ok(fb.status === 'failed', 'run2 missing slot is rejected after retry');
    // 09-workflow.js:970 —— schema 失败时解析值与 schemaErrors 一并保留,下游可读到「哪些槽位有效、缺哪个」,
    // 逐项修补(只重生成缺失槽位)因此可行;但下游必须把它当未验证数据(状态 failed + schemaErrors 非空)。
    ok(fb.structuredResult && fb.structuredResult.option_a && fb.structuredResult.option_b && !fb.structuredResult.option_c, 'run2 partial result stays visible with the valid slots marked');
    ok(fb.errorClass === 'schema_failed' && String(fb.error || '').includes('option_c'), 'run2 failure names the missing slot');    ok(['fallback_a', 'fallback_b', 'fallback_c'].every(id => by(r2, id).status === 'succeeded'), 'run2 per-item fallback nodes take over on failure');
    ok(by(r2, 'fallback_c').structuredResult && by(r2, 'fallback_c').structuredResult.orientation === 'minimal', 'run2 fallback slot carries its own stable shape');
    ok(by(r2, 'never').status === 'skipped', 'run2 success-path branch stays skipped');
    ok(by(r2, 'decide').status === 'succeeded', 'run2 decide completes via all_settled fan-in');

    // Run 3: 槽位类型错误 → 拒绝；不重试（maxRetries 0）→ continue 降级放行
    const r3 = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [
      { id: 'options_batch', task: 'BATCH_BADTYPE has a string slot', outputSchema: SLOTS, failurePolicy: 'continue' },
      { id: 'after', task: 'AFTER_BADTYPE child', dependsOn: ['options_batch'], dependencyPolicy: 'all_settled' },
    ] }, hdr);
    ok(by(r3, 'options_batch').status === 'failed' && by(r3, 'options_batch').attempts === 1, 'run3 wrong-typed slot rejected without retry');
    ok(by(r3, 'after').status === 'succeeded', 'run3 continue policy unlocks the child in degraded mode');

    // Run 4: 异常候选（多出一个未申报槽位）→ additionalProperties:false 拒绝
    const r4 = await post(WP, '/api/agent-workflow/launch', { token, sessionId: sid, nodes: [
      { id: 'options_batch', task: 'BATCH_EXTRA adds option_d', outputSchema: SLOTS, failurePolicy: 'continue' },
    ] }, hdr);
    ok(by(r4, 'options_batch').status === 'failed', 'run4 undeclared extra candidate rejected by closed schema');

    console.log(failures ? `\n${failures} FAILURES` : 'ALL PASS');
    process.exitCode = failures ? 1 : 0;
  } finally {
    kill(wb); kill(fake);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
})();
})();
