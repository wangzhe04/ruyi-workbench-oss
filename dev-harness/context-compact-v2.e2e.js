#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// context-compact-v2.e2e.js — 第45波 上下文压缩 v2(45a/45b/45c/45d)
//
// 覆盖:
//   [U] 45d 校准原语(require 直测):EMA 因子样本门/clamp、窗口学习只降不升、providerContextWindow 咽喉点
//   [A] 45a 摘要载荷预算化(fake-openai + RECORD_SUMMARY_DIR):
//       小历史单次调用;超大历史 map-reduce(N≥2 分段 + mapReduce.chunks);摘要 payload 不超预算
//   [B] 45b 主回合 400 强压重试(fake CONTEXT_400_ONCE,真 WB + 真 turn):
//       首个请求 400 → forced_400 事件 → 摘要调用 → 重试成功,回合 ok;历史被重播种
//   [C] 45c 分类器(claude 子代理 over_window → retry:true;definitive 不再含 context)
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

// 隔离纪律:require server.js 之前先把数据根指向临时目录 —— 校准存储(45d)会写
// <data>/context-calibration.json,直写默认根 = 污染用户真实数据(本测试曾因此翻车;
// 且本机 WIN_CLAUDE_WORKBENCH_HOME 系统级指向真实根,必须【无条件】覆盖,不能 || 兜底)。
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w45-unit-'));

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function get(port, p, headers = {}) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500, headers }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function post(port, p, body, headers = {}) { return new Promise(resolve => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); r.write(raw); r.end(); }); }
function stream(port, body, headers = {}) { return new Promise(resolve => { const raw = JSON.stringify(body); const r = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => { let b = '', events = []; res.on('data', c => { b += c; let i; while ((i = b.indexOf('\n')) >= 0) { const line = b.slice(0, i); b = b.slice(i + 1); try { if (line.trim()) events.push(JSON.parse(line)); } catch { /* ignore */ } } }); res.on('end', () => resolve(events)); }); r.on('error', () => resolve(events)); r.on('timeout', () => { r.destroy(); resolve(events); }); r.write(raw); r.end(); }); }
async function up(port) { for (let i = 0; i < 60; i++) { if (await get(port, '/health')) return true; await sleep(150); } return false; }
async function tokenFor(port) { const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); })); return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1]; }
function fakeUp(port, env) { const p = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(port)], { env: { ...process.env, FAKE_OPENAI_PORT: String(port), ...env }, windowsHide: true }); p.stdout.on('data', () => {}); p.stderr.on('data', () => {}); return p; }
const user = (content, extra) => ({ role: 'user', content, ...(extra || {}) });
const asst = content => ({ role: 'assistant', content });

(async () => {
  // ═══ [U] 45d 校准原语 ═══
  console.log('── [U] 45d 估算自校准/窗口学习 ──');
  srv.noteEstimateSample('u-prov', 'u-m1', 1000, 1500);
  srv.noteEstimateSample('u-prov', 'u-m1', 1000, 1500);
  ok(srv.estimateFactor('u-prov', 'u-m1') === 1, 'U1 样本<3 因子=1(门)');
  srv.noteEstimateSample('u-prov', 'u-m1', 1000, 1500);
  ok(Math.abs(srv.estimateFactor('u-prov', 'u-m1') - 1.5) < 0.01, 'U2 样本≥3 EMA 因子≈1.5');
  srv.noteEstimateSample('u-prov', 'u-m1', 1000, 100000); // 异常样本
  ok(srv.estimateFactor('u-prov', 'u-m1') <= 3, 'U3 因子 clamp ≤3');
  srv.noteWindowOvershoot('u-prov', 'u-m1', 100000);
  ok(srv.learnedWindowCap('u-prov', 'u-m1') === 90000, 'U4 窗口学习 = 失败时估算 ×0.9');
  srv.noteWindowOvershoot('u-prov', 'u-m1', 200000);
  ok(srv.learnedWindowCap('u-prov', 'u-m1') === 90000, 'U5 只降不升(更大失败值不覆盖)');
  ok(srv.providerContextWindow({ id: 'u-prov', model: 'u-m1', baseUrl: 'http://x', contextWindow: 200000 }, 'u-m1') === 90000, 'U6 providerContextWindow 咽喉点应用学习上限(manual 200K → 90K)');
  ok(srv.providerContextWindow({ id: 'u-none', model: 'u-m2', baseUrl: 'http://x', contextWindow: 200000 }, 'u-m2') === 200000, 'U7 无学习的 provider 不受影响');

  // ═══ [A] 45a 摘要载荷预算化 ═══
  console.log('── [A] 45a 摘要载荷预算化 ──');
  {
    const FAKE = await getFreePort();
    const SUMDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w45-sum-'));
    const fake = fakeUp(FAKE, { FAKE_RECORD_SUMMARY_DIR: SUMDIR });
    try {
      await sleep(400);
      const provider = { id: 'a-prov', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'a-m1', contextWindow: 100000 };
      // A1: 小历史 → 单次调用,无 map-reduce
      const small = [user('目标A'), asst('答A')];
      const r1 = await srv.providerSummaryCall(provider, small);
      ok(r1.ok && !r1.mapReduce, 'A1 小历史单次摘要成功');
      // A2: 大历史(60 个 user 块,每块 ~6KB) → fit 截断或 map-reduce;摘要 payload 必须 ≤ 预算
      const big = [];
      for (let i = 0; i < 60; i++) { big.push(user('任务' + i + ' ' + 'x'.repeat(5000))); big.push(asst('答' + i + ' ' + 'y'.repeat(5000))); }
      const r2 = await srv.providerSummaryCall(provider, big);
      ok(r2.ok, 'A2 超大历史摘要成功(预算化内核不 400)');
      const budget = Math.floor(100000 * 0.5);
      const sumFiles = fs.readdirSync(SUMDIR).filter(f => f.startsWith('sum-')).sort();
      ok(sumFiles.length >= 1, 'A2 摘要请求已落盘(' + sumFiles.length + ' 个)');
      let maxReq = 0;
      for (const f of sumFiles) maxReq = Math.max(maxReq, fs.statSync(path.join(SUMDIR, f)).size);
      // 预算 50000 tokens ≈ 估算 18 万字节(CJK/ASCII 混合);payload 必须远小于「未预算化的整史」(60×10KB=600KB)
      ok(maxReq < 250000, 'A3 摘要 payload 受预算约束(最大 ' + maxReq + 'B < 250KB;旧内核会发 ~600KB)');
      if (r2.mapReduce) ok(r2.mapReduce.chunks >= 2 && sumFiles.length >= 3, 'A4 map-reduce 分段 ≥2 且落盘含分段+总摘要(' + r2.mapReduce.chunks + ' 段/' + sumFiles.length + ' 请求)');
      else ok(r2.droppedMiddle > 0, 'A4 fit 截断路径:droppedMiddle=' + r2.droppedMiddle);
      // A5: fitHistoryForSummary 不动调用方数组(manual compact 失败原样保留契约)
      const ref = big.slice();
      srv.fitHistoryForSummary(big, 5000);
      ok(JSON.stringify(big) === JSON.stringify(ref), 'A5 fit 不 mutate 调用方 history');
      // A6: 截断保头(原始目标)保尾
      const fit = srv.fitHistoryForSummary(big, 30000);
      ok(fit.messages[0].content.includes('任务0') && fit.messages[fit.messages.length - 1].content.includes('答59'), 'A6 截断保头(原始目标)保尾(最近回合)');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }

  // ═══ [B] 45b 主回合 400 强压重试(真 WB + CONTEXT_400_ONCE) ═══
  console.log('── [B] 45b 主回合 400 强压重试 ──');
  {
    const HOME = path.join(os.tmpdir(), 'ruyi-w45b-e2e');
    const FAKE = await getFreePort();
    const PORT = await getFreePort();
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME,
      providers: [{ id: 'b-prov', label: 'B', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'b-m1', models: [{ id: 'b-m1', label: 'b-m1' }] }],
      activeProvider: 'b-prov',
    }, null, 2));
    const fake = fakeUp(FAKE, { FAKE_CONTEXT_400_ONCE: '1' });
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
    try {
      ok(await up(PORT), 'B workbench up');
      const token = await tokenFor(PORT);
      const hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'w45b', cwd: HOME }, hdr);
      // fake 的【第 1 个】请求即 400(CONTEXT_400_ONCE),所以强压发生在第一回合。
      const events = await stream(PORT, { sessionId: created.session.id, message: '第一问:记住数字 42', cwd: HOME }, hdr);
      const forced = events.find(e => e.type === 'compact' && e.mode === 'forced_400');
      if (!forced) console.log('   [diag B] 事件类型: ' + events.map(e => e.type).join(',') + ' | fake 请求数: ' + JSON.stringify(await get(FAKE, '/__count')));
      ok(!!forced, 'B1 出现 forced_400 压缩事件(服务端 400 → 自动强压)');
      const result = events.find(e => e.type === 'result');
      ok(result && result.ok === true, 'B2 强压后重试成功,回合 ok(旧行为 = 回合失败)');
      // 历史被重播种(摘要 user + ack + 保留尾部)而非裸失败 —— 存储 v2 头是瘦的,
      // providerHistory 正文在 sessions/<id>.provider.ndjson(v2 布局)。
      const bodyFile = path.join(HOME, 'sessions', created.session.id + '.provider.ndjson');
      const bodyText = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : '';
      ok(bodyText.includes('压缩摘要'), 'B3 providerHistory 含摘要重播种条目');
      // 45d(b):窗口学习落盘 —— 异步写穿,轮询等 flush。
      let calib = null;
      for (let i = 0; i < 20 && !calib; i++) {
        try { calib = JSON.parse(fs.readFileSync(path.join(HOME, 'context-calibration.json'), 'utf8')); } catch { await sleep(150); }
      }
      ok(calib && calib.windowCaps && calib.windowCaps['b-prov/b-m1'] && calib.windowCaps['b-prov/b-m1'].cap > 0, 'B4 窗口学习落盘(cap=' + ((calib && calib.windowCaps['b-prov/b-m1']) || {}).cap + ')');
    } finally { kill(wb); kill(fake); await sleep(300); fs.rmSync(HOME, { recursive: true, force: true }); }
  }

  // ═══ [C] 45c 分类器 ═══
  console.log('── [C] 45c 子代理 over_window 分类 ──');
  {
    const cls = srv.classifyClaudeSubagentFailure({ killed: false, exitCode: 1, stderrText: 'Error: prompt_too_long: input exceeds the model context window', assistantText: '', toolCallCount: 0, gotResult: false, resultOk: false });
    ok(cls.retry === true && cls.reason === 'over_window', 'C1 over-window → retry:true/over_window(新鲜重试)');
    const cls2 = srv.classifyClaudeSubagentFailure({ killed: false, exitCode: 1, stderrText: 'Error: prompt_too_long', assistantText: '', toolCallCount: 2, gotResult: false, resultOk: false });
    ok(cls2.retry === false && cls2.reason === 'progress_made', 'C2 有进展(tool×2)→ progress_made 不重试(防重放铁律不变)');
    const cls3 = srv.classifyClaudeSubagentFailure({ killed: false, exitCode: 1, stderrText: 'invalid_api_key 401', assistantText: '', toolCallCount: 0, gotResult: false, resultOk: false });
    ok(cls3.retry === false && cls3.reason === 'definitive', 'C3 auth 仍 definitive 不重试(分类拆分不扩大重试面)');
    // 45f P1-2:真实 Anthropic 报文形态(空格非下划线;"N tokens > M maximum")必须命中 ——
    // 作者假想形态(prompt_too_long)曾让整条分支成为死代码。
    const cls4 = srv.classifyClaudeSubagentFailure({ killed: false, exitCode: 1, stderrText: 'Error: invalid_request_error: prompt is too long: 213462 tokens > 200000 maximum', assistantText: '', toolCallCount: 0, gotResult: false, resultOk: false });
    ok(cls4.retry === true && cls4.reason === 'over_window', 'C4 真实报文形态(prompt is too long: N > M)命中 over_window');
    // 45f P1-2:CLI 执行期错误常以 result 帧收尾(gotResult + resultOk=false)—— over_window 判定必须先于
    // clean_error_result,否则被「确定性错误不重试」吃掉。
    const cls5 = srv.classifyClaudeSubagentFailure({ killed: false, exitCode: 0, stderrText: '', assistantText: '', toolCallCount: 0, gotResult: true, resultOk: false, resultText: 'prompt is too long: 213462 tokens > 200000 maximum' });
    ok(cls5.retry === true && cls5.reason === 'over_window', 'C5 result 帧形态的错误文本也能命中(resultText 扫描)');
    const cls6 = srv.classifyClaudeSubagentFailure({ killed: false, exitCode: 0, stderrText: '', assistantText: '', toolCallCount: 0, gotResult: true, resultOk: false, resultText: 'some other deterministic error' });
    ok(cls6.retry === false && cls6.reason === 'clean_error_result', 'C6 非超窗 result 错误仍 clean_error_result 不重试');
  }

  if (failures) { console.log('\nCONTEXT-COMPACT-V2 E2E: FAIL (' + failures + ')'); process.exitCode = 1; }
  else console.log('\nCONTEXT-COMPACT-V2 E2E: ALL PASS');
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
