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
//   [D] 通用压缩模型窗口隔离:本地小模型负责摘要时,上下文面板仍跟随后续对话模型且写入路由身份
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
async function tokenFor(port) { return (await post(port, '/api/bootstrap', {}))?.token; }
function isolatedEnv(home) {
  return { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home, HOME: home, USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'), KIMI_CODE_HOME: path.join(home, '.kimi') };
}
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
      const summaryFiles = () => fs.readdirSync(SUMDIR).filter(f => f.startsWith('sum-')).sort();
      const firstPayload = JSON.parse(fs.readFileSync(path.join(SUMDIR, summaryFiles()[0]), 'utf8'));
      ok((firstPayload.messages || []).some(m => m && m.role === 'user' && String(m.content || '').includes('【当前执行状态】')),
        'A1a 摘要提示词要求可交接的当前执行状态');
      const legacyFourSections = '【目标】目标\n【已确认的决定】决定\n【未完成事项】无\n【关键文件与上下文】文件';
      const completeFiveSections = legacyFourSections.replace('【关键文件与上下文】', '【当前执行状态】已完成：无；正在进行：测试；阻塞：无；下一步：继续\n【关键文件与上下文】');
      ok(typeof srv.validateStructuredSummary === 'function' && !srv.validateStructuredSummary(legacyFourSections),
        'A1a-1 缺当前执行状态的旧四节摘要被拒绝');
      ok(srv.validateStructuredSummary(completeFiveSections), 'A1a-2 含状态四项的五节摘要通过校验');

      // 22-S0 边界:32K 是「禁单发」门槛而非普通窗口预算。31K 仍一发，33K 必须走
      // 约24K 的 map-reduce。用真实估算器反推文本长度，避免把字符/token 比假定写死。
      const historyNearTokens = target => {
        let lo = 1, hi = target * 5, best = 1;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          const candidate = [user('边界回合 ' + 'x'.repeat(mid))];
          if (srv.estimateHistoryTokens(candidate) <= target) { best = mid; lo = mid + 1; }
          else hi = mid - 1;
        }
        return [user('边界回合 ' + 'x'.repeat(best))];
      };
      const n31 = historyNearTokens(31000);
      const before31 = summaryFiles().length;
      const r31 = await srv.providerSummaryCall(provider, n31);
      ok(r31.ok && !r31.mapReduce && summaryFiles().length === before31 + 1,
        'A1b 约31K 摘要仍为单发');
      const n33 = historyNearTokens(33000);
      const before33 = summaryFiles().length;
      const r33 = await srv.providerSummaryCall(provider, n33);
      ok(r33.ok && r33.mapReduce && r33.mapReduce.chunks >= 2 && summaryFiles().length >= before33 + 3,
        'A1c 约33K 摘要强制 map-reduce（分段＋总汇）');

      // Pi 式固定 token 尾部：只保留完整 user 回合，绝不在 tool_call/tool_result 之间切开。
      const tailCap = srv.COMPACT_RESEED_TAIL_MAX_TOKENS;
      const tailHistory = [
        user('旧回合 ' + 'o'.repeat(35000)), asst('旧答复'),
        user('近期回合 ' + 'r'.repeat(26000)),
        { role: 'assistant', content: '', tool_calls: [{ id: 'tail-call', type: 'function', function: { name: 'file_read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tail-call', content: '近期工具结果' },
      ];
      const tailBoundary = srv.recentTurnsBoundary(tailHistory, tailCap);
      const tail = tailHistory.slice(tailBoundary);
      ok(tailBoundary === 2 && tail[0].role === 'user' && srv.estimateHistoryTokens(tail) <= tailCap,
        'A1d 固定尾部保留近期完整 user 回合并受 16K 上限约束');
      const tailToolIds = new Set(tail.filter(m => m.role === 'tool').map(m => m.tool_call_id));
      ok(tail.filter(m => Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls).every(tc => tailToolIds.has(tc.id)),
        'A1e 固定尾部不拆 tool_call/tool_result 配对');
      const giantRecent = [
        user('旧回合'), asst('旧答复'),
        user('超大近期回合 ' + 'g'.repeat(70000)),
        { role: 'assistant', content: '', tool_calls: [{ id: 'giant-call', type: 'function', function: { name: 'file_read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'giant-call', content: '超大工具结果' },
      ];
      ok(srv.recentTurnsBoundary(giantRecent, tailCap) === giantRecent.length,
        'A1f 超大最近回合不半截保留，交给摘要以维持固定尾部预算');
      // A2: 大历史(60 个 user 块,每块 ~6KB) → fit 截断或 map-reduce;摘要 payload 必须 ≤ 预算
      const big = [];
      for (let i = 0; i < 60; i++) { big.push(user('任务' + i + ' ' + 'x'.repeat(5000))); big.push(asst('答' + i + ' ' + 'y'.repeat(5000))); }
      const r2 = await srv.providerSummaryCall(provider, big);
      ok(r2.ok, 'A2 超大历史摘要成功(预算化内核不 400)');
      const budget = Math.floor(100000 * 0.5);
      const sumFiles = summaryFiles();
      ok(sumFiles.length >= 1, 'A2 摘要请求已落盘(' + sumFiles.length + ' 个)');
      let maxReq = 0;
      for (const f of sumFiles) maxReq = Math.max(maxReq, fs.statSync(path.join(SUMDIR, f)).size);
      // 预算 50000 tokens ≈ 估算 18 万字节(CJK/ASCII 混合);payload 必须远小于「未预算化的整史」(60×10KB=600KB)
      ok(maxReq < 250000, 'A3 摘要 payload 受预算约束(最大 ' + maxReq + 'B < 250KB;旧内核会发 ~600KB)');
      ok(r2.mapReduce && r2.mapReduce.chunks >= 2 && sumFiles.length >= 3, 'A4 超预算不丢中段，必须 map-reduce ≥2(' + ((r2.mapReduce && r2.mapReduce.chunks) || 0) + ' 段/' + sumFiles.length + ' 请求)');
      // A5: fitHistoryForSummary 不动调用方数组(manual compact 失败原样保留契约)
      const ref = big.slice();
      srv.fitHistoryForSummary(big, 5000);
      ok(JSON.stringify(big) === JSON.stringify(ref), 'A5 fit 不 mutate 调用方 history');
      // A6: 截断保头(原始目标)保尾
      const fit = srv.fitHistoryForSummary(big, 30000);
      ok(fit.messages[0].content.includes('任务0') && fit.messages[fit.messages.length - 1].content.includes('答59'), 'A6 截断保头(原始目标)保尾(最近回合)');
      // A7: one user turn may contain a very long agent/tool loop. Every emitted map chunk must remain
      // within budget, and transcript splitting must retain both the beginning and the end of that turn.
      const giantTurn = [user('超长回合起点')];
      for (let i = 0; i < 80; i++) giantTurn.push({ role: i % 2 ? 'tool' : 'assistant', content: `片段-${i}-` + 'z'.repeat(2400) });
      giantTurn.push(asst('超长回合终点'));
      const giantChunks = srv.chunkHistoryByBudget(giantTurn, 8000);
      const giantJoined = giantChunks.flat().map(m => String(m.content || '')).join('\n');
      ok(giantChunks.length > 1 && giantChunks.every(chunk => srv.estimateHistoryTokens(chunk) <= 8000), 'A7 超长单回合无损拆分且每段严格不超预算');
      ok(giantJoined.includes('超长回合起点') && giantJoined.includes('超长回合终点') && giantJoined.includes('片段-79-'), 'A8 超长单回合保留首尾及中后段（不再逐消息截断）');
    } finally { kill(fake); await sleep(200); fs.rmSync(SUMDIR, { recursive: true, force: true }); }
  }

  // ═══ [D] 压缩模型窗口不能污染主会话窗口 ═══
  console.log('── [D] 通用压缩窗口路由隔离 ──');
  {
    const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ctx-route-'));
    const FAKE = await getFreePort();
    const PORT = await getFreePort();
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME,
      providers: [
        { id: 'main-prov', label: 'Main 1M', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'main-model', contextWindow: 1000000, models: [{ id: 'main-model', label: 'main-model' }] },
        { id: 'local-compact', label: 'Local 128K', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FAKE}/v1`, apiKey: 'k', model: 'local-small', contextWindow: 131072, models: [{ id: 'local-small', label: 'local-small' }] },
      ],
      activeProvider: 'main-prov', compactProviderId: 'local-compact', compactModel: 'local-small',
    }, null, 2));
    const fake = fakeUp(FAKE, {});
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: isolatedEnv(HOME), windowsHide: true });
    wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
    try {
      ok(await up(PORT), 'D workbench up');
      const token = await tokenFor(PORT), hdr = { 'x-wcw-token': token };
      const created = await post(PORT, '/api/sessions', { title: 'ctx-route', cwd: HOME }, hdr);
      await stream(PORT, { sessionId: created.session.id, message: '请记住主会话使用 1M 模型。', cwd: HOME }, hdr);
      const compacted = await post(PORT, '/api/provider/compact', { sessionId: created.session.id }, hdr);
      ok(compacted && compacted.ok && compacted.provider === 'local-compact', 'D1 摘要实际由本地压缩 provider 执行');
      const fetched = await get(PORT, `/api/sessions/${created.session.id}`, hdr);
      const messages = fetched && fetched.session && fetched.session.messages || [];
      const usage = messages.length && messages[messages.length - 1].usage;
      ok(usage && usage.contextWindow === 1000000, 'D2 压缩后面板上限保持后续对话模型 1M（非压缩模型 128K）');
      ok(usage && usage.contextEngine === 'openai' && usage.contextProviderId === 'main-prov' && usage.contextModel === 'main-model', 'D3 压缩用量携带主会话路由身份，切换 provider 后可判旧值失效');
      const providerKey = srv.contextWindowOverrideKey('openai', 'main-prov', 'main-model');
      const agentKey = srv.contextWindowOverrideKey('agent', 'claude', 'ark-code-latest');
      const overrides = { [providerKey]: 300000, [agentKey]: 1000000 };
      const saved = await post(PORT, '/api/config', { contextWindowOverrides: overrides }, hdr);
      ok(saved?.ok && saved.config.contextWindowOverrides[agentKey] === 1000000, 'D4 手动窗口通过真实 config API 持久化');
      const providerStatus = await get(PORT, '/api/status', hdr);
      ok(providerStatus?.contextWindowResolved?.value === 300000, 'D5 provider 面板读数与服务端会话 override 一致');
      await post(PORT, '/api/config', { activeProvider: '', agentCliType: 'claude', model: 'ark-code-latest' }, hdr);
      const agentStatus = await get(PORT, '/api/status', hdr);
      ok(agentStatus?.contextWindowResolved?.value === 1000000 && agentStatus.contextWindowResolved.engine === 'agent'
        && agentStatus.contextWindowResolved.source === 'manual', 'D6 未知 CLI 模型采用手动 1M，不受本地 128K 摘要模型影响');
      await post(PORT, '/api/config', { model: 'other-unknown-model' }, hdr);
      const switched = await get(PORT, '/api/status', hdr);
      ok(switched?.contextWindowResolved?.value === srv.CONTEXT_WINDOW_FALLBACK, 'D7 切换模型不继承原模型手动窗口');
      await post(PORT, '/api/config', { model: 'ark-code-latest', contextWindowOverrides: { ...overrides, [agentKey]: 0 } }, hdr);
      const auto = await get(PORT, '/api/status', hdr);
      ok(auto?.contextWindowResolved?.value === srv.CONTEXT_WINDOW_FALLBACK && auto.contextWindowResolved.source === 'fallback', 'D8 选自动清除手动窗口，状态接口不继续报告旧 1M');
    } finally { kill(wb); kill(fake); await sleep(300); fs.rmSync(HOME, { recursive: true, force: true }); }
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
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: isolatedEnv(HOME), windowsHide: true });
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
