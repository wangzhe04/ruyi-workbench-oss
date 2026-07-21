'use strict';
/*
 * E2E (第46波46e): 编排盲区补测四联 —— 封版前把 roadmap §37.1 点名的四个编排盲区一次钉死。
 *
 *  S1 跨节点资源死锁(三节点环):agent-deadlock-watchdog 覆盖了【两节点】对持环(A持X等Y,B持Y等X)。
 *     本件补【三节点】传递环(A持X等Y、B持Y等Z、C持Z等X)——环检测必须能沿 wait-for 图走多跳,
 *     只认 pairwise 的实现会漏。闭环的最后一等须被 RESOURCE_DEADLOCK 快拒;破环后其余等待者正常获取。
 *  S2 loop×retry 收敛:子回合 loop-guard(连击 5 次中止)× 节点 failurePolicy:'retry' 的交互。
 *     中止不是 transient,但当前重试分类不区分 —— 无论将来是否细化分类,都必须【收敛】:
 *     attempts 封顶 maxRetries+1、每尝试仍在第 5 连击中止、run 到终态不悬挂、中止原因不丢。
 *  S3 双引擎 tier 等价:tierModelForNode/resolveNodeModel 源抽取直测。等价 = 决策契约对称:
 *     claude 引擎任何 tier 恒 ''(不替 CLI 挑模型);openai 按 tier 从【本引擎池】挑,绝不跨引擎
 *     (别名 opus/sonnet/haiku 与代理缓存 id 都必须被排除);显式 model 两引擎都原样尊重;'inherit'
 *     两引擎都归 ''。
 *  S4 双冷 resume 窄窗(46e 已修):runAgentWorkflow existingRun 分支的 run_resumed append 此前在
 *     activeAgentRuns 守卫【之前】,两次近同时手动 resume 会重复 append + eventSeq 重号(roadmap §28
 *     backlog 既定欠账)。修复 = resumeInFlight 同步占位提前关窗。本件:①静态锁钉死守卫先于 append;
 *     ②行为锁:同一终态 run 并发两个 resume POST,恰好一个 ok、事件流 run_resumed 恰好 1 条。
 *
 * Run: node dev-harness/orchestration-blindspots.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'ruyi-orch-blindspots');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function isSubRequest(msgs) {
  const sys = String(((msgs || []).find(m => m && m.role === 'system') || {}).content || '');
  return sys.includes('子任务执行体');
}
function emitToolCall(res, id, callId, name, args) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}

let subToolRequests = 0;
const EVIDENCE = () => path.join(HOME, 'evidence.txt');
const fake = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.includes('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  if (req.method === 'POST' && req.url.includes('/chat/completions')) {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let parsed = {}; try { parsed = JSON.parse(body); } catch {}
      const id = 'chatcmpl-blindspot';
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
      const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (isSubRequest(msgs) && hasTools) {
        subToolRequests += 1;
        return emitToolCall(res, id, 'call_loop', 'file_read', { path: EVIDENCE() });
      }
      return emitText(res, id, 'non-tool response');
    });
    return;
  }
  res.writeHead(404); res.end();
});

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 2000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(raw); r.end();
  });
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
async function waitFor(label, fn, tries = 120, gap = 250) {
  for (let i = 0; i < tries; i++) { const v = await fn(); if (v) return v; await sleep(gap); }
  return null;
}

(async () => {
  // ───────────────── S1: 三节点传递环(进程内租约直测) ─────────────────
  console.log('── S1: 跨节点资源死锁(三节点传递环) ──');
  const server = require(SERVER);
  const rX = server.normalizeAgentResources(['file:' + path.join(HOME, 'x.txt')], HOME); // 规格数组(非字符串 —— acquire 只认数组)
  const rY = server.normalizeAgentResources(['file:' + path.join(HOME, 'y.txt')], HOME);
  const rZ = server.normalizeAgentResources(['file:' + path.join(HOME, 'z.txt')], HOME);
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });

  const hA = await server.acquireResourceLease('ring-A', rX); // A 持 X
  const hB = await server.acquireResourceLease('ring-B', rY); // B 持 Y
  const hC = await server.acquireResourceLease('ring-C', rZ); // C 持 Z
  ok(!!(hA && hB && hC), 'S1 三把租约就位(X/Y/Z 各一)');
  let aGotY = false;
  const aWaitsY = server.acquireResourceLease('ring-A', rY, null, null, 0).then(t => { aGotY = true; return t; }).catch(() => null); // A 等 Y(B 持)
  let bGotZ = false;
  const bWaitsZ = server.acquireResourceLease('ring-B', rZ, null, null, 0).then(t => { bGotZ = true; return t; }).catch(() => null); // B 等 Z(C 持)
  await sleep(150); // 两等先挂上(尚不成环:C 没在等)
  let dlCode = '';
  try { await server.acquireResourceLease('ring-C', rX, null, null, 0); } // C 等 X(A 持)→ 三环闭合
  catch (e) { dlCode = String((e && (e.code || e.message)) || e); }
  ok(/RESOURCE_DEADLOCK/.test(dlCode), 'S1 三节点传递环被快拒 RESOURCE_DEADLOCK(多跳 wait-for 图, got ' + (dlCode || 'no-throw') + ')');
  // 破环:C 释放 Z → B 拿到 Z → B 释放 Y/Z → A 拿到 Y。传递环被破后不得有等待者泄漏。
  server.releaseResourceLease(hC);
  const tB = await Promise.race([bWaitsZ, sleep(3000).then(() => 'timeout')]);
  ok(tB !== 'timeout' && bGotZ, 'S1 C 释放后 B 的等待者获取 Z(无泄漏)');
  if (tB && tB !== 'timeout') server.releaseResourceLease(tB);
  server.releaseResourceLease(hB);
  const tA = await Promise.race([aWaitsY, sleep(3000).then(() => 'timeout')]);
  ok(tA !== 'timeout' && aGotY, 'S1 B 释放后 A 的等待者获取 Y(链式唤醒正常)');
  if (tA && tA !== 'timeout') server.releaseResourceLease(tA);
  server.releaseResourceLease(hA);

  // ───────────────── S3: 双引擎 tier 等价(源抽取直测) ─────────────────
  console.log('── S3: 双引擎 tier 等价 ──');
  const src = fs.readFileSync(SERVER, 'utf8');
  function extractFn(name) {
    const re = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`, 'm');
    const m = src.match(re);
    if (!m) throw new Error('extract failed: ' + name);
    return m[0];
  }
  const aliasMatch = src.match(/const CLAUDE_ALIAS_IDS = new Set\(\[[^\]]+\]\)/);
  ok(!!aliasMatch, 'S3 CLAUDE_ALIAS_IDS 可抽取');
  const sandbox = new Function(
    'getProxyModelsCache',
    `${aliasMatch[0]};\n${extractFn('modelCapabilityTier')}\n${extractFn('tierModelForNode')}\n${extractFn('resolveNodeModel')}\nreturn { modelCapabilityTier, tierModelForNode, resolveNodeModel };`
  );
  // 代理缓存桩:假装 /v1/models 发现过 kimi-k2(Claude 端),它【绝不】应进 openai 池。
  const tier = sandbox(() => ({ models: [{ id: 'kimi-k2' }] }));
  const prov = { id: 'p1', model: 'qwen-max', models: [{ id: 'qwen-max' }, { id: 'qwen-turbo' }, { id: 'glm-4' }] };
  const cfgT = { agentAutoModelTiering: true, extraModels: [], knownModels: [] };
  for (const t of ['read', 'edit', 'exec']) {
    ok(tier.tierModelForNode(t, 'claude', cfgT, prov) === '', `S3 claude 引擎 ${t} tier 恒 ''(不替 CLI 挑模型)`);
  }
  ok(tier.tierModelForNode('exec', 'openai', cfgT, prov) === 'qwen-max', 'S3 openai exec → strong 池成员(qwen-max)');
  ok(tier.tierModelForNode('read', 'openai', cfgT, prov) === 'qwen-turbo', 'S3 openai read → fast 池成员(qwen-turbo)');
  ok(tier.tierModelForNode('edit', 'openai', cfgT, prov) === 'glm-4', 'S3 openai edit → balanced 池成员(glm-4)');
  const provDirty = { id: 'p2', model: 'opus', models: [{ id: 'opus' }, { id: 'kimi-k2' }, { id: 'qwen-turbo' }] };
  for (const t of ['read', 'edit', 'exec']) {
    const got = tier.tierModelForNode(t, 'openai', cfgT, provDirty);
    ok(got === 'qwen-turbo', `S3 openai ${t} tier 绝不跨引擎(别名/缓存被排除, got ${got})`);
  }
  // resolveNodeModel 对称契约:显式尊重 / 角色默认,两引擎同规则;'inherit' 归空后在 openai+tiering-on
  // 会落到 tier 兜底(设计如此 —— 空即"让后端定"),故 inherit 归一的断言在 tiering 关闭下做。
  const cfgNoTier = { agentAutoModelTiering: false, extraModels: [], knownModels: [] };
  for (const eng of ['claude', 'openai']) {
    ok(tier.resolveNodeModel('my-explicit-x', '', 'read', eng, cfgT, prov) === 'my-explicit-x', `S3 ${eng} 显式 model 原样尊重`);
    ok(tier.resolveNodeModel('inherit', '', 'read', eng, cfgNoTier, prov) === '', `S3 ${eng} 'inherit' 归一为 ''(tiering 关闭下)`);
    ok(tier.resolveNodeModel('', 'role-model-y', 'read', eng, cfgT, prov) === 'role-model-y', `S3 ${eng} 角色默认 model 生效`);
  }
  ok(tier.resolveNodeModel('inherit', '', 'read', 'openai', cfgT, prov) === 'qwen-turbo', "S3 openai 'inherit'+tiering-on → 落 tier 兜底(空的既定语义)");
  ok(tier.resolveNodeModel('', '', 'exec', 'openai', cfgT, prov) === 'qwen-max', 'S3 openai 缺省 → tier 兜底(qwen-max)');
  ok(tier.resolveNodeModel('', '', 'exec', 'claude', cfgT, prov) === '', "S3 claude 缺省 → 空串(tier 兜底按引擎豁免)");
  ok(tier.resolveNodeModel('', '', 'exec', 'openai', cfgNoTier, prov) === '', "S3 tier 兜底是 opt-in(关 tiering → 空串)");

  // ───────────────── S4 静态锁:守卫先于 append ─────────────────
  console.log('── S4: 双冷 resume 窄窗(静态锁 + 并发行为锁) ──');
  const branchStart = src.indexOf('if (existingRun) {');
  const appendAt = src.indexOf("appendAgentRunEvent(run, { type: 'run_resumed'");
  const guardAt = src.indexOf('resumeInFlight.has(runId)', branchStart);
  const markAt = src.indexOf('resumeInFlight.add(runId)', branchStart);
  const releaseAt = src.indexOf('resumeInFlight.delete(runId)', branchStart);
  ok(branchStart > 0 && guardAt > branchStart && guardAt < markAt && markAt < appendAt && appendAt < releaseAt,
    'S4 静态锁:守卫 → 占位 → append → finally 释放,全序在 existingRun 分支内');
  ok(/const resumeInFlight = new Set\(\)/.test(src), 'S4 静态锁:resumeInFlight 在飞标记集定义在');

  // ───────────────── S2 + S4 行为:同一套 workbench 连跑 ─────────────────
  const FP = await getFreePort(), WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(EVIDENCE(), 'loop guard evidence content');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7,
    permissionMode: 'bypass',
    defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));
  await new Promise(r => fake.listen(FP, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'blindspots', cwd: HOME }, hdr);
    const sid = created.session.id;

    // S2: loop×retry —— 节点 retry 策略 × 子回合 loop-guard。maxRetries:2 → 3 次尝试 × 5 连击 = 15 请求封顶。
    console.log('── S2: loop×retry 收敛 ──');
    const s2 = await post(WP, '/api/agent-workflow/launch', {
      token, sessionId: sid,
      nodes: [{ id: 'loopr', task: 'REPEAT_SAME_TOOL', toolTier: 'read', failurePolicy: 'retry', maxRetries: 2 }],
    }, hdr);
    const s2node = s2 && s2.results && s2.results[0];
    console.log('  [loop×retry] status:', s2node && s2node.status, '| attempts:', s2node && s2node.attempts, '| subToolRequests:', subToolRequests, '| error:', s2node && s2node.error);
    ok(s2 && s2.ok === false && s2.status === 'failed', 'S2 run 到终态(failed)—— loop×retry 不悬挂');
    ok(!!s2node && s2node.status === 'failed', 'S2 重试耗尽后节点 failed');
    ok(!!s2node && Number(s2node.attempts) === 3, 'S2 attempts 封顶 maxRetries+1 = 3 (got ' + (s2node && s2node.attempts) + ')');
    ok(subToolRequests === 15, 'S2 fake 恰服务 15 次(3 尝试 × 5 连击)—— 每次尝试都被 guard 中止,非预算烧穿 (got ' + subToolRequests + ')');
    ok(!!s2node && /连续 5 次相同工具调用/.test(s2node.error || ''), 'S2 中止原因在重试后不丢(连续 5 次相同工具调用)');
    const runsS2 = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
    const runS2 = runsS2 && Array.isArray(runsS2.runs) && runsS2.runs.find(r => r.id === s2.runId);
    ok(!!runS2 && /^(failed|partial)$/.test(runS2.status || ''), 'S2 持久化 run 到终态 (got ' + (runS2 && runS2.status) + ')');

    // S4 行为锁:终态 run 上并发两个 resume。两种合法结局:①后到者走 cold 路径被 resumeInFlight
    // 拒为「已在运行」(ok:false);②先到者已注册为 live,后到者走 warm 路径(ok:true 的 no-op 唤醒)。
    // 两条路径都【不】再 append run_resumed —— 事件流增量恰 +1 才是本窄窗的回归锁(旧 bug:两个都走
    // cold 且守卫在 append 之后 → +2)。断言:至少一个 ok + run_resumed 恰 +1;若有 blocked 必是「已在运行」。
    console.log('── S4: 双冷 resume 窄窗行为锁 ──');
    const evBefore = await get(WP, `/api/agent-runs/${s2.runId}/events?sessionId=${encodeURIComponent(sid)}`, hdr);
    const resumedBefore = (evBefore && evBefore.events || []).filter(e => e.type === 'run_resumed').length;
    const [r1, r2] = await Promise.all([
      post(WP, `/api/agent-runs/${s2.runId}`, { token, sessionId: sid, action: 'resume' }, hdr),
      post(WP, `/api/agent-runs/${s2.runId}`, { token, sessionId: sid, action: 'resume' }, hdr),
    ]);
    const oks = [r1, r2].filter(r => r && r.ok === true).length;
    const blocked = [r1, r2].find(r => r && r.ok === false);
    console.log('  [resume×2] r1.ok:', r1 && r1.ok, '| r2.ok:', r2 && r2.ok, '| blocked err:', blocked && blocked.error);
    ok(oks >= 1, 'S4 并发双 resume 至少一个放行 (got ' + oks + ')');
    ok(!blocked || /已在运行/.test(blocked.error || ''), 'S4 若有被拦者必是「已在运行」(cold 路径拒;warm 路径 ok 属合法) (got ' + (blocked && blocked.error) + ')');
    // 等被放行的 resume 跑完(loop-guard 再次中止),然后数事件流里的 run_resumed。
    await waitFor('resumed run terminal again', async () => {
      const rr = await get(WP, `/api/agent-runs?sessionId=${encodeURIComponent(sid)}`, hdr);
      const run = rr && Array.isArray(rr.runs) && rr.runs.find(x => x.id === s2.runId);
      return run && /^(failed|partial|succeeded)$/.test(run.status || '') && !run.live && run;
    });
    const evAfter = await get(WP, `/api/agent-runs/${s2.runId}/events?sessionId=${encodeURIComponent(sid)}`, hdr);
    const resumedAfter = (evAfter && evAfter.events || []).filter(e => e.type === 'run_resumed').length;
    ok(resumedAfter - resumedBefore === 1, 'S4 事件流 run_resumed 恰 +1(旧 bug 会 +2:第二个在守卫前已 append) (got +' + (resumedAfter - resumedBefore) + ')');
  } catch (e) { console.error('ERROR ' + (e && e.stack || e)); failures++; }
  finally {
    kill(wb);
    fake.close();
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nORCHESTRATION BLINDSPOTS E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
