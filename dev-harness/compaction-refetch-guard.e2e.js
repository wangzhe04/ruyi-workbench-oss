'use strict';
require('./lib/self-isolate-home.js'); // 家目录自隔离(见 lib 头注)
/*
 * 压缩后重取守卫(10 createCompactionRefetchGuard,09 主回合接线)—— 真服务 + 假 provider。
 *
 * 要防的是工作集装不下预算时的抖动:模型同时要参考两份大结果 A、B,每份单独放得下、两份一起就超预算。
 * 读 B → L2 重播种只留最后一个单元(B)→ 回头重读 A → 再压、只留 A → 重读 B …… 同签名连击守卫只认【连续】相同调用,
 * A、B 交替每次都换签名,抓不到;结果指纹只比相邻两次,也抓不到;主回合迭代不设上限。修前这个脚本会一直跑到
 * 下面那道 40 发的保险丝。
 *
 * 假模型:默认 A、B 交替整份重读;一旦看到「被拒」就换成缩小范围的读法(新签名,必须照常执行),再收尾。
 * 摘要请求(非流式、带结构化摘要提示)回五节摘要。
 *   G1 某份文件第 3 次「压缩后重取」被拒(错误码 compaction_refetch_refused,附换做法的说明),回合没有无限转下去;
 *   G2 被拒之前那一次(第 2 次重取)的结果上带 compactionWarning 提醒;
 *   G3 被拒的调用没有执行:整份 file_read A / B 实际执行次数都有上限;
 *   G4 缩小范围的读法(新签名)照常执行;
 *   G5 回合正常收尾(result ok),providerHistory 配对完好(每个 tool_call 都有应答);
 *   G6 服务日志里有 compaction_refetch 的 warn / refuse 记录。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-refetch-guard-'));
const t = createRunner('COMPACTION REFETCH GUARD');
const { ok } = t;
const MAX_MAIN_REQUESTS = 40; // 保险丝:修前的行为会一路撞到这里

function request(port, method, route, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: route, method, timeout: 180000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...headers },
    }, res => {
      let text = ''; res.on('data', c => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(new Error('timeout ' + route)); });
    if (raw) req.write(raw);
    req.end();
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, tries = 100, gap = 120) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}

(async () => {
  // 两份 ~200KB 的文件:file_read 截断后每份 ~48KB(≈13K 估算 token)。窗口 32000 × 0.8 = 预算 25600:
  // 固定开销(系统提示 + 工具表)≈6K + 一份 ≈19K 放得下,两份 ≈33K 放不下。
  const fileA = path.join(HOME, 'alpha.txt');
  const fileB = path.join(HOME, 'beta.txt');
  fs.writeFileSync(fileA, ('alpha lorem ipsum dolor sit amet ' .repeat(32) + '\n').repeat(190), 'utf8');
  fs.writeFileSync(fileB, ('beta consectetur adipiscing elit ' .repeat(32) + '\n').repeat(190), 'utf8');
  const argsA = { path: fileA };
  const argsB = { path: fileB };
  const narrowA = { path: fileA, offset: 1, limit: 20 };

  let mainRequests = 0;
  let callSeq = 0;
  const fake = await startFakeProvider({
    handler(req) {
      if (req.stream === false && JSON.stringify(req.messages || []).includes('结构化摘要')) {
        return textFrames('【目标】对照 alpha 与 beta 两份文件\n【已确认的决定】无\n【未完成事项】对照两份文件\n【当前执行状态】已完成：无；正在进行：读取；阻塞：无；下一步：继续读取\n【关键文件与上下文】alpha.txt、beta.txt');
      }
      mainRequests += 1;
      if (mainRequests > MAX_MAIN_REQUESTS) return textFrames('fuse blown');
      const msgs = req.messages || [];
      const tools = msgs.filter(m => m && m.role === 'tool');
      const refused = tools.filter(m => String(m.content || '').includes('compaction_refetch_refused')).length;
      const narrowDone = msgs.some(m => m && m.role === 'assistant' && Array.isArray(m.tool_calls)
        && m.tool_calls.some(c => c.function && String(c.function.arguments || '').includes('"limit":20')));
      if (narrowDone) return textFrames('对照完成');
      if (refused >= 1) return toolCallFrames('file_read', narrowA, 'call_n' + (++callSeq));
      // 最近一次读的是哪份 → 这次读另一份(A、B 交替整份重读)
      let lastPath = '';
      for (let i = msgs.length - 1; i >= 0 && !lastPath; i--) {
        const m = msgs[i];
        if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          try { lastPath = JSON.parse(m.tool_calls[m.tool_calls.length - 1].function.arguments).path || ''; } catch { lastPath = ''; }
        }
      }
      return toolCallFrames('file_read', lastPath === fileA ? argsB : argsA, 'call_' + (++callSeq));
    },
  });

  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, permissionMode: 'bypass', defaultWorkspace: HOME, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', contextWindow: 32000 }],
    activeProvider: 'fake',
    autoCompactThreshold: 0.8,
  }));
  const WP = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: HOME },
  });
  try {
    ok(!!(await waitFor(() => request(WP, 'GET', '/health').then(r => r.json).catch(() => null))), 'workbench starts');
    const html = (await request(WP, 'GET', '/')).text;
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const auth = { 'x-wcw-token': token };
    const created = await request(WP, 'POST', '/api/sessions', { headers: auth, body: { title: 'refetch', cwd: HOME } });
    const sid = created.json.session.id;
    const streamed = await request(WP, 'POST', '/api/chat/stream', { headers: auth, body: { sessionId: sid, message: '对照 alpha.txt 与 beta.txt 两份文件', cwd: HOME } });
    const events = String(streamed.text || '').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const uses = new Map(events.filter(e => e.type === 'tool_use').map(e => [e.id, e]));
    const results = events.filter(e => e.type === 'tool_result').map(e => ({ ...e, use: uses.get(e.id) }));
    const pathOf = r => (r.use && r.use.input && r.use.input.path) || '';
    const isNarrow = r => !!(r.use && r.use.input && r.use.input.limit === 20);
    const refusedResults = results.filter(r => r.content && r.content.error === 'compaction_refetch_refused');
    const executedFull = p => results.filter(r => pathOf(r) === p && !isNarrow(r) && !(r.content && r.content.error === 'compaction_refetch_refused')).length;

    ok(mainRequests <= MAX_MAIN_REQUESTS, `G1 回合没有撞保险丝(主请求 ${mainRequests} 发 ≤ ${MAX_MAIN_REQUESTS})`);
    ok(refusedResults.length === 1 && [fileA, fileB].includes(pathOf(refusedResults[0])),
      `G1 整份重取被拒一次(实得 ${refusedResults.map(r => path.basename(pathOf(r))).join(',') || '无'})`);
    ok(refusedResults.every(r => r.isError === true && /offset\/limit/.test(String(r.content.message || ''))), 'G1 拒绝是一条错误结果,并说明了换做法(缩小范围等)');
    const warned = results.filter(r => r.content && typeof r.content.compactionWarning === 'string');
    ok(warned.length >= 1 && refusedResults.length === 1 && warned.some(r => pathOf(r) === pathOf(refusedResults[0])), `G2 被拒的那份在上一次重取时带过 compactionWarning(实得 ${warned.length} 条)`);
    ok(executedFull(fileA) <= 4 && executedFull(fileB) <= 4, `G3 整份读实际执行有上限(A ${executedFull(fileA)} 次、B ${executedFull(fileB)} 次,各 ≤ 4)`);
    const narrow = results.find(isNarrow);
    ok(narrow && narrow.content && narrow.content.ok === true, 'G4 缩小范围的读法(新签名)照常执行');
    const resultEvt = events.filter(e => e.type === 'result').pop();
    ok(resultEvt && resultEvt.ok !== false, 'G5 回合正常收尾');
    const summaries = fake.requests.filter(r => r.stream === false).length;
    ok(summaries >= 2, `前提:确实发生了多次 L2 重播种(摘要 ${summaries} 发)`);

    const sessionRes = await waitFor(async () => {
      const r = await request(WP, 'GET', `/api/sessions/${encodeURIComponent(sid)}`, { headers: auth });
      return r.json && r.json.session && Array.isArray(r.json.session.providerHistory) ? r.json.session : null;
    });
    const ph = sessionRes ? sessionRes.providerHistory : [];
    const answered = new Set(ph.filter(m => m && m.role === 'tool').map(m => String(m.tool_call_id)));
    const orphans = [];
    for (const m of ph) {
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (!answered.has(String(c.id))) orphans.push(c.id);
    }
    ok(ph.length > 0 && orphans.length === 0, `G5 providerHistory 配对完好(孤儿 tool_call ${orphans.length} 个)`);

    const logDir = path.join(HOME, 'logs');
    const logText = fs.existsSync(logDir) ? fs.readdirSync(logDir).map(f => { try { return fs.readFileSync(path.join(logDir, f), 'utf8'); } catch { return ''; } }).join('\n') : '';
    ok(/"kind":"compaction_refetch"[^\n]*"action":"warn"/.test(logText) && /"kind":"compaction_refetch"[^\n]*"action":"refuse"/.test(logText), 'G6 日志里有 compaction_refetch 的 warn 与 refuse');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    try { killOwnTree(wb); } catch { /* gone */ }
    await fake.close();
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  t.done();
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 2; });
