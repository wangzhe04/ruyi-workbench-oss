'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// observation-recall-replay.e2e.js — 105a 真实历史回放 harness(B 类证据:模型行为闭环)
//
// 思路(用户指定):用真实历史做种子会话,把上下文窗口卡死,模拟真实压缩触发——
//   首调用前 maybeAutoCompact → L1 蒸发种子里的冷观察 → 缩减视图携带 rawRef 进入模型可见上下文
//   → 模型(自发性)调用 observation_recall → 回读原文 → 回答只有 recall 才能知道的问题。
//
// 与 105a [E] 段的本质区别:种子自带 200+ 条冷 tool 观察,L1 有大量可蒸发材料,
// 蒸发后立即回到预算内(不需要 L2 摘要),因此 HTTP 回合内稳定触发(autocompact.e2e 已证明该形态)。
//
// 用法:
//   node dev-harness/observation-recall-replay.e2e.js              # fake 离线闭环(A 类:机制+保真)
//   REPLAY_PROVIDER=deepseek REPLAY_MODEL=deepseek-v4-pro node dev-harness/observation-recall-replay.e2e.js
//                                                                  # 指定同端点真模型(B 类:自发性+正确性)
//   REPLAY_PROVIDER=deepseek REPLAY_GUIDED=1 node dev-harness/observation-recall-replay.e2e.js
//                                                                  # 明确要求使用 rawRef 的可用性对照
//
// 硬约束:原历史记录(.win-claude-workbench/checkpoints)零写入;deepseek 密钥只从本机 config
// 复制进临时 HOME,绝不打印。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'),
  http = require('http'), zlib = require('zlib');
const HERE = __dirname, WB = path.resolve(HERE, '..', 'ruyi-workbench');
const PROVIDER = process.env.REPLAY_PROVIDER === 'deepseek' ? 'deepseek' : 'fake';
const REAL_MODEL = String(process.env.REPLAY_MODEL || 'deepseek-v4-flash');
const REAL_CONFIG = 'C:/Users/87179/.win-claude-workbench/config.json';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-replay-'));
// Use an ordinary fact that already exists in the real file_search output, rather than injecting a
// canary/secret-like string. It lies beyond the reduced text head but within recall's default 8K head.
const TARGET_FACT = '`data-main-view` 状态机';
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getFreePort() { return new Promise(res => { const s = require('net').createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); }); }
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { } }
function get(port, p) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); }); r.on('error', () => resolve(null)); }); }
function postStream(port, payload, timeoutMs) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: timeoutMs || 240000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { } } } });
      res.on('end', () => resolve(events));
    });
    req.on('error', () => resolve([])); req.write(data); req.end();
  });
}

(async () => {
  // ═══ [S] 种子:真实快照 → 选取省略区中的既有事实 → 写入临时 HOME ═══
  // 选 history-25 而不是最大快照:它仍是完整真实历史,且有一条边界外 60K file_search 观察；
  // reducer 后约缩到 4K，可稳定制造「L1 足够、无需 L2」的窗口，同时把真实 API 输入控制在约 60K tokens。
  const SNAP = path.join(HERE, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354', 'history-25.json.gz');
  const raw = JSON.parse(zlib.gunzipSync(fs.readFileSync(SNAP)).toString('utf8'));
  const toolNames = new Map();
  for (const m of raw) if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (tc && tc.id && tc.function) toolNames.set(String(tc.id), String(tc.function.name || ''));
  // 选边界外最大的工具观察(不在最后 2 个 assistant 回合内 → 蒸发边界外)。
  // 不限定工具名：rawRef/recall 契约覆盖所有 reducer 策略，真实夹具中的最佳候选是 file_search。
  const asstIdx = [];
  for (let i = 0; i < raw.length; i++) if (raw[i] && raw[i].role === 'assistant') asstIdx.push(i);
  const boundary = asstIdx.length >= 2 ? asstIdx[asstIdx.length - 2] : 0; // 蒸发只处理此之前的 tool
  let markerIdx = -1, markerSize = -1;
  for (let i = 0; i < boundary; i++) {
    const m = raw[i];
    if (m && m.role === 'tool' && typeof m.content === 'string' && m.content.length >= 2500 && m.content.length > markerSize) {
      markerIdx = i; markerSize = m.content.length;
    }
  }
  ok(markerIdx > 0, 'S1 找到边界外的大观察 idx=' + markerIdx + ' tool=' + (toolNames.get(String(raw[markerIdx] && raw[markerIdx].tool_call_id)) || 'unknown') + ' chars=' + markerSize + ' (boundary=' + boundary + ')');
  // 全部 tool 保留原尺寸且不注入测试数据；事实来自原始项目历史，避免模型把任务误判为数据外带。
  const seed = raw.map(m => m && m.role === 'tool' && typeof m.content === 'string' ? { ...m } : m);
  const targetOriginal = seed[markerIdx].content;
  const targetIndex = targetOriginal.indexOf(TARGET_FACT);
  ok(targetIndex >= 900 && targetIndex < 5200, 'S2 真实目标事实位于缩减省略区且处于默认 recall 8K head 内(index=' + targetIndex + ')');

  process.env.RUYI_HOME = HOME; process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
  const srv = require(path.join(WB, 'app', 'server.js'));
  const seedSession = await srv.createSession({ title: 'replay-seed' });
  seedSession.providerHistory = seed;
  seedSession.messages = [{ role: 'user', content: '(历史会话回放种子)' }];
  // 105b-replay 关键:maybeAutoCompact 只挂在 openai 引擎主回合迭代边界;createSession 默认 engineRoute 是
  // agent 引擎(claude CLI),不触发压缩。种子必须走 openai 引擎,否则 L1 蒸发永远不会发生。
  seedSession.engineRoute = { engine: 'openai', providerId: PROVIDER === 'deepseek' ? 'deepseek' : 'fake', model: PROVIDER === 'deepseek' ? REAL_MODEL : 'fake-model' };
  seedSession.contextEngine = 'openai'; seedSession.contextProviderId = seedSession.engineRoute.providerId; seedSession.contextModel = seedSession.engineRoute.model;
  await srv.saveSession(seedSession);
  const back = await srv.loadSession(seedSession.id);
  ok(back && Array.isArray(back.providerHistory) && back.providerHistory.length === seed.length, 'S3 种子会话落盘并完整恢复(' + (back ? back.providerHistory.length : 0) + '/' + seed.length + ')');
  const routeFields = {};
  for (const k of ['engine', 'contextEngine', 'contextProviderId', 'contextModel', 'providerId', 'model', 'providerHistoryCursor', 'storageVersion']) routeFields[k] = back ? back[k] : undefined;
  console.log('[diag] seedRoute=' + JSON.stringify(routeFields));

  // ═══ [C] 配置:双开关开 + 卡死窗口 + provider ═══
  const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
  // 窗口两段式自校准:先给一个大窗口(WINDOW_HI)让回合只做快照不压缩,测出蒸发后估算 EST_AFTER,
  // 再用 WINDOW_LO = max(8000, EST_AFTER × 0.85) 重启服务 —— 蒸发后必然 ≤ 预算 → L1-only,无 L2 reseed。
  const WINDOW_HI = 2000000; // ≥2M: 规范化 clamp 上限,种子再大也不触发
  const WINDOW_LO = Number(process.env.REPLAY_WINDOW) || 75000;
  const overrides = {};
  let providers;
  const WINDOW = WINDOW_LO || WINDOW_HI; // 自校准模式首跑用大窗口,测出蒸发后估算后重启
  if (PROVIDER === 'deepseek') {
    const rc = fs.existsSync(REAL_CONFIG) ? JSON.parse(fs.readFileSync(REAL_CONFIG, 'utf8')) : {};
    const dp = (rc.providers || []).find(p => p.id === 'deepseek');
    const apiKey = String(process.env.DEEPSEEK_API_KEY || (dp && dp.apiKey) || '');
    const baseUrl = String(process.env.DEEPSEEK_BASE_URL || (dp && dp.baseUrl) || 'https://api.deepseek.com');
    if (!apiKey) { console.error('FATAL 未提供 DEEPSEEK_API_KEY，且本机 config 无 deepseek 密钥'); process.exit(1); }
    providers = [{ id: 'deepseek', label: 'DeepSeek', type: 'openai-compat', baseUrl, apiKey, model: REAL_MODEL, models: [{ id: REAL_MODEL, label: REAL_MODEL }], apiStyle: 'responses', contextWindow: WINDOW }];
    overrides[JSON.stringify(['openai', 'deepseek', REAL_MODEL])] = WINDOW;
  } else {
    providers = [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], contextWindow: WINDOW }];
    overrides['["openai","fake","fake-model"]'] = WINDOW;
  }
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    autoImportClaudeCodeMcp: false, // mem-b18c4569:不关会把本机 10 个真实 MCP 导入沙箱,污染请求体与预算
    providers, activeProvider: providers[0].id,
    autoCompactThreshold: 0.8, contextWindowOverrides: overrides,
    runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
  }, null, 2));
  const seedEst = srv.estimateHistoryTokens(seed, 'S'.repeat(1310), [{ type: 'function', function: { name: 'file_read' } }]);
  console.log('[seed] msgs=' + seed.length + ' estTokens=' + seedEst + ' window=' + WINDOW + ' budget=' + Math.round(WINDOW * 0.8) + ' mode=' + (WINDOW_LO ? 'fixed' : 'auto-calibrate'));
  // 自校准:种子估算 → 蒸发后估算 = 原始 tool 内容的缩减收益已知(真实历史实测:整体缩减 81%),
  // 但精确值依 provider 因子;此处直接用未缩减大观察的逐条 token 估算反推 WINDOW_LO。
  // 做法:对种子跑 measureObservationReductionShadow,取 candidateVisibleChars,按 3.6 chars/token(ascii)
  // 折算 + system/tools 开销,得到蒸发后估算 EST_AFTER;WINDOW_LO = EST_AFTER / 0.8 × 0.85,即蒸发后
  // 必然低于预算、蒸发前必然高于预算。
  let WINDOW_EFFECTIVE = WINDOW;
  if (!WINDOW_LO) {
    const shadow = srv.measureObservationReductionShadow(seed);
    // 蒸发后模型可见 ≈ candidateVisibleChars(缩减视图)+保护回合原文字符。estimator 按 3.6 chars/token(ascii);
    // 2f69 种子 CJK 含量高,按 2.5 chars/token 保守折算。额外 +2000 tokens 覆盖 system+工具 schema。
    const estAfter = Math.ceil(shadow.candidateVisibleChars / 2.5) + 2000;
    // 蒸发后必须低于预算(L1-only):WINDOW_LO × 0.8 > estAfter → WINDOW_LO > estAfter / 0.8;
    // 留 20% 余量:WINDOW_LO = estAfter / 0.8 × 1.2。蒸发前必须超预算:WINDOW_LO × 0.8 < seedEst
    // (seedEst=322576 >> WINDOW_LO,天然成立)。
    WINDOW_EFFECTIVE = Math.max(8000, Math.round(estAfter / 0.8 * 1.2));
    providers[0].contextWindow = WINDOW_EFFECTIVE;
    overrides[PROVIDER === 'deepseek' ? JSON.stringify(['openai', 'deepseek', REAL_MODEL]) : '["openai","fake","fake-model"]'] = WINDOW_EFFECTIVE;
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
      autoImportClaudeCodeMcp: false, // mem-b18c4569:不关会把本机 10 个真实 MCP 导入沙箱
      providers, activeProvider: providers[0].id,
      autoCompactThreshold: 0.8, contextWindowOverrides: overrides,
      runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
    }, null, 2));
    console.log('[calibrate] shadowVisibleChars=' + shadow.candidateVisibleChars + ' estAfter≈' + estAfter + ' → WINDOW_LO=' + WINDOW_EFFECTIVE + ' (budget=' + Math.round(WINDOW_EFFECTIVE * 0.8) + ')');
  }

  // ═══ [R] 回合:种子会话上发起新任务 ═══
  const fake = PROVIDER === 'fake' ? cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
    windowsHide: true,
    env: { ...process.env, FAKE_NO_USAGE: '1', FAKE_SEQUENCE_FROM_LAST_USER: '1', FAKE_LOG_BODY: path.join(HOME, 'reqs.ndjson'), FAKE_RECORD_SUMMARY_DIR: path.join(HOME, 'sums'), FAKE_TOOL_SEQUENCE: JSON.stringify([
      { name: 'observation_recall', argsFromLastRawRef: true },
    ]) },
  }) : null;
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => { const t = l.trim(); if (t) console.log('[wb] ' + t.slice(0, 260)); }));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await get(WB_PORT, '/health'); }
    ok(!!h, 'R0 workbench listening on :' + WB_PORT);
    const guided = process.env.REPLAY_GUIDED === '1';
    const question = guided
      ? '这个会话之前进行过一系列任务。早前 file_search 结果中写明：主区域显隐应该使用什么状态机？该结果若已被缩减，请读取缩减视图里的 rawRef，调用 observation_recall 回读原文，再给出状态机名称。'
      : '这个会话之前进行过一系列任务。早前 file_search 结果中写明：主区域显隐应该使用什么状态机？请给出状态机名称。';
    const events = await postStream(WB_PORT, { sessionId: seedSession.id, message: question }, PROVIDER === 'deepseek' ? 300000 : 120000);
    // fake 侧请求计数:主循环请求数(排除摘要调用)——摘要调用不带 tools,主调用带 tools。
    if (PROVIDER === 'fake') { try { const cnt = await get(FAKE_PORT, '/__count'); console.log('[diag] fakeChatRequests=' + JSON.stringify(cnt)); } catch { } }
    // 请求结构回放:每条请求的角色序列摘要(只看形状,不打印内容)
    try {
      const reqLines = fs.readFileSync(path.join(HOME, 'reqs.ndjson'), 'utf8').trim().split(/\r?\n/);
      reqLines.forEach((l, i) => {
        try {
          const r = JSON.parse(l);
          const shape = (r.roles || '').split(',').map(role => role + '').join(',');
          console.log('[req' + i + '] t=' + r.t + ' stream=' + r.stream + ' tools=' + r.hasTools + ' n=' + r.n + ' roles=' + shape.slice(0, 160));
        } catch { }
      });
    } catch { /* diagnostic only */ }
    const evSid = (events.find(e => e.type === 'session') || {}).session && events.find(e => e.type === 'session').session.id;
    console.log('[diag] requestedSession=' + seedSession.id + ' turnSession=' + evSid + ' same=' + (evSid === seedSession.id));
    const result = events.find(e => e.type === 'result');
    ok(result && result.ok === true, 'R1 回合 result ok:true' + (result && result.ok ? '' : ' err=' + (result && result.error)));
    const compactEvents = events.filter(e => e.type === 'compact');
    ok(compactEvents.some(e => e.mode === 'evaporate'), 'R2 真实历史上触发 L1 蒸发 compact(mode=evaporate, 共 ' + compactEvents.length + ' 次压缩, before→after: ' + compactEvents.map(e => e.beforeTokens + '→' + e.afterTokens).join(', ') + ')');
    const ceEvents = events.filter(e => e.type === 'context_estimate');
    console.log('[diag] context_estimate=' + JSON.stringify(ceEvents).slice(0, 500));
    const reduced = events.filter(e => e.type === 'observation_reduced');
    ok(reduced.length > 0 && reduced.every(e => /^history:/.test(e.rawRef || '')), 'R3 observation_reduced 携带 rawRef(' + reduced.length + ' 条)');

    // 会话终态:模型可见视图含 rawRef;recall 调用发生;回读逐字节一致
    const s1 = await get(WB_PORT, '/api/sessions/' + encodeURIComponent(seedSession.id));
    const ph = (s1 && s1.session && s1.session.providerHistory) || [];
    // 结构诊断:只输出形状,不输出内容
    const shape = ph.map(m => m ? (m.role + (Array.isArray(m.tool_calls) ? '(' + m.tool_calls.map(tc => (tc.function && tc.function.name) || '?').join('+') + ')' : '')) : 'null');
    console.log('[diag] providerHistory.len=' + ph.length + ' first8=' + shape.slice(0, 8).join(',') + ' last8=' + shape.slice(-8).join(','));
    console.log('[diag] watermark=' + JSON.stringify(s1 && s1.session && s1.session.autoCompactWatermark) + ' turnSeq=' + JSON.stringify(s1 && s1.session && s1.session.turnSeq) + ' msgsLen=' + JSON.stringify(s1 && s1.session && (s1.session.messages || []).length));
    console.log('[diag] eventsSample=' + JSON.stringify(events.slice(0, 3)).slice(0, 400));
    console.log('[diag] eventTypes=' + JSON.stringify([...new Set(events.map(e => e.type))]));
    const reducedView = ph.find(m => m && m.role === 'tool' && typeof m.content === 'string' && m.content.includes('rawRef=history:'));
    ok(!!reducedView, 'R4 providerHistory 中存在携带 rawRef 的缩减视图(模型可见)');
    const recallCall = ph.find(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.some(tc => tc.function && tc.function.name === 'observation_recall'));
    ok(!!recallCall, 'R5 模型' + (PROVIDER === 'deepseek' ? '自发性' : '(脚本化)') + '调用了 observation_recall');
    if (recallCall) {
      const rc = recallCall.tool_calls.find(tc => tc.function.name === 'observation_recall');
      let args = {}; try { args = JSON.parse(rc.function.arguments || '{}'); } catch { }
      ok(/^history:\d+:[a-f0-9]{16}:\d+:[a-f0-9]{16}$/.test(args.rawRef || ''), 'R6 recall 参数携带合法 rawRef(' + (args.rawRef || '无') + ')');
      const toolIds = new Set(ph.filter(m => m && m.role === 'tool').map(m => m.tool_call_id));
      const recallMsg = ph.find(m => m && m.role === 'tool' && m.tool_call_id === rc.id);
      let rr = null; try { rr = JSON.parse(recallMsg && recallMsg.content || 'null'); } catch { }
      ok(rr && rr.ok === true, 'R7 recall 工具信封 ok:true');
      if (rr && rr.ok) {
        // observation_recall 的生产契约上限是 60K；模型可用默认 8K，也可在允许范围内请求更大值。
        // 这里按真实 tool-call 参数验证精确的 65/35 head-tail 截断；逐字节全量保真由
        // observation-recall-realhistory.e2e 的内核层覆盖。
        const requestedMax = Math.max(1000, Math.min(60000, Number(args.maxChars) || 8000));
        const head = Math.floor(requestedMax * 0.65), tail = requestedMax - head;
        const boundedOk = targetOriginal.length <= requestedMax
          ? rr.truncated === false && rr.content === targetOriginal
          : rr.truncated === true && rr.originalChars === targetOriginal.length
            && String(rr.content).length <= requestedMax + 256
            && String(rr.content).startsWith(targetOriginal.slice(0, head))
            && String(rr.content).endsWith(targetOriginal.slice(-tail));
        ok(boundedOk, 'R8 回读符合请求 maxChars=' + requestedMax + ' 的有界 head/tail 契约(original=' + targetOriginal.length + ', returned=' + (rr.content || '').length + ')');
        ok(String(rr.content).includes(TARGET_FACT), 'R9 回读内容含真实目标事实');
      }
      // 配对铁律
      let allPaired = true, tcCount = 0;
      for (const m of ph) if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) { tcCount++; if (!toolIds.has(tc.id)) allPaired = false; }
      ok(allPaired, 'R10 配对铁律:' + tcCount + ' 个 tool_call 全有应答');
    }
    // 最终回答质量:最终文本是否包含只能通过回读可靠获得的真实历史事实
    const texts = events.filter(e => e.type === 'text' || e.type === 'delta' || e.type === 'assistant_delta').map(e => e.text || e.delta || '').join('');
    const finalTexts = events.filter(e => e.type === 'message' || e.type === 'final' || e.type === 'assistant').map(e => e.text || e.content || '').join('');
    const answer = (texts + finalTexts);
    if (PROVIDER === 'deepseek') {
      console.log('[deepseek 回答摘要] ' + answer.slice(-600).replace(/\s+/g, ' '));
      ok(answer.includes(TARGET_FACT), 'R11 最终回答包含正确的真实历史事实(模型用 recall 结果完成了任务)');
      const usage = events.find(e => e.type === 'usage' || (e && e.usage));
      if (usage) console.log('[usage] ' + JSON.stringify(usage.usage || usage).slice(0, 300));
    }
    const eventCounts = {};
    for (const e of events) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
    console.log('[events] ' + JSON.stringify(eventCounts));
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); failures++; }
  finally {
    kill(wb); if (fake) kill(fake);
    await sleep(300);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { }
  }
  console.log('\nREPLAY(' + PROVIDER + '): ' + (failures ? 'FAIL (' + failures + ')' : 'ALL PASS'));
  setImmediate(() => process.exit(failures ? 1 : 0));
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
