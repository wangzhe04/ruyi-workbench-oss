// E2E: 第29波「监控与运营 §29a/§29c」(AUTONOMY-PLAN §29)。端口 WB 9120(已登记)。
// [S] 静态锁:config 键/归一、events 路由排在通配 GET 前、node_progress 跳过 gen、digest 视图、前端增量缓存 + force 全量调用点。
// [H] Live:digest 轻量视图字段、events afterSeq 补播(幂等重放)+ limit/hasMore + 坏行免疫 + 鉴权 403 + 跨会话空、
//     【验收锁】增量模式传输字节 ≤ 全量模式 20%(忠实模拟客户端算法 N tick)、run.metrics 干预计数、ops 指标端点、单 run GET live 叠加。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const APPJS = path.join(WB, 'app', 'public', 'app.js');
const WB_PORT = 9120;
const HOME = path.join(os.tmpdir(), 'wcw-monitor-incremental-e2e');
const WS = path.join(HOME, 'ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = ''; res.on('data', c => (buf += c)); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, text: buf, bytes: Buffer.byteLength(buf) }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {} await sleep(150); } return false; }
const src = fs.readFileSync(SERVER, 'utf8');
const app = fs.readFileSync(APPJS, 'utf8');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [S] 静态锁
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [S] 静态锁 ──');
ok(/monitorIncremental: true,/.test(src) && /config\.monitorIncremental = config\.monitorIncremental !== false;/.test(src), 'S config monitorIncremental 默认 true(!==false 归一)');
ok(/const AGENT_RUN_EVENTS_PAGE_MAX = 500;/.test(src) && /async function readAgentRunEvents\(sessionId, runId, afterSeq, limit\)/.test(src), 'S readAgentRunEvents + 分页上限 500');
ok(/const evt = safeJsonParse\(t, null\);\s*\n\s*if \(!evt \|\| !Number\.isFinite\(Number\(evt\.seq\)\)/.test(src), 'S 事件读取逐行 safeJsonParse 跳坏行(尾行半写免疫)');
// 路由顺序:events 端点必须排在通配 GET /api/agent-runs/ 之前(线性 if 链顺序即优先级)。
const evRouteIdx = src.indexOf("pathname.endsWith('/events')");
const genericGetIdx = src.indexOf("const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));");
ok(evRouteIdx > 0 && genericGetIdx > 0 && evRouteIdx < genericGetIdx, 'S events 路由排在通配单 run GET 之前(不被吞)');
ok(/if \(kind !== 'gen'\) appendAgentRunEvent\(run, \{ type: 'node_progress'/.test(src), 'S node_progress 只记离散里程碑(gen 流式字数不落取证文件)');
ok(/listUrl\.searchParams\.get\('view'\) === 'digest'/.test(src), 'S 列表路由带 digest 轻量视图');
ok(/type: 'run_pool', data: \{ action: 'proposed'/.test(src) && (src.match(/type: 'run_pool'/g) || []).length >= 4, 'S 任务池提案/物化/审批均发 run_pool 事件');
ok(/const liveOne = activeAgentRuns\.get\(runId\);/.test(src) && /run: \{ \.\.\.liveOne\.run, live: true, paused: !!liveOne\.paused \}/.test(src), 'S 单 run GET live 时以内存对象下发(快照节流恒旧)');
ok(/if \(liveOne\.run\.sessionId !== sessionId\) return send\(res, json\(\{ ok: false, error: 'agent run not found' \}, 404\)\);/.test(src), 'S 单 run GET 内存路径保留跨会话 404 守卫');
// 29c 静态锁
ok(/function bumpRunIntervention\(run, kind\)/.test(src) && (src.match(/bumpRunIntervention\(/g) || []).length >= 8, 'S bumpRunIntervention 接入 ≥7 个干预点');
ok(/run\.metrics\.failuresByClass\[cls\] = \(run\.metrics\.failuresByClass\[cls\] \|\| 0\) \+ 1;/.test(src), 'S 收尾聚合 failuresByClass(幂等重算)');
ok((src.match(/node\.errorClass = '/g) || []).length >= 10, 'S errorClass 显式标注 ≥10 个 error 设置点');
ok(/kind: 'mission_budget_exhausted'/.test(src) && /kind: 'mission_start'/.test(src), 'S mission 预算超支率分子/分母均落审计账');
ok((src.match(/kind: 'intervention'/g) || []).length >= 3, 'S 会话级干预(permission/plan/steer)落审计账');
ok(/async function buildOpsMetrics\(days\)/.test(src) && /pathname === '\/api\/ops\/metrics'/.test(src), 'S ops 指标聚合端点');
ok(/onEvent\(\{ type: 'subagent_usage'/.test(src) && (src.match(/type: 'subagent_usage'/g) || []).length >= 2, 'S 两引擎子代理用量事件(与台账同源)');
ok(/function accumulateRunUsage\(run, u\)/.test(src) && /accumulateRunUsage\(run, evt\)/.test(src), 'S nodeEvent 累进 run.usageTotals(点亮前端预订字段)');
// 前端静态锁
ok(/const agentRunsCache = \{ sid: '', runs: new Map\(\) \};/.test(app), 'S(前端) per-run 增量缓存');
ok(/async function loadAgentRuns\(force\)/.test(app) && /state\.config\.monitorIncremental !== false/.test(app), 'S(前端) 总开关回落(config.monitorIncremental=false → 旧全量)');
ok(/function applyAgentRunEvent\(run, evt\)/.test(app), 'S(前端) 事件轻应用(progress/start),其余走单 run 快照');
ok((app.match(/loadAgentRuns\(true\)/g) || []).length >= 5, 'S(前端) 动作后 force 全量 ≥5 处(审批/操作/插话/删除/启动)');
ok(/const mySeq = \+\+agentRunsSeq;/.test(app) && /if \(mySeq !== agentRunsSeq\) return;/.test(app), 'S(前端) agentRunsSeq 乱序防护保留');
ok(/c\.stuckTicks = \(c\.stuckTicks \|\| 0\) \+ 1;/.test(app) && /if \(c\.stuckTicks >= 3\) needFull = true;/.test(app), 'S(前端) 事件僵局自愈(连续 3 tick 空拉 → 全量)');
// ── 对抗轮修复静态锁 ──
ok(/ar\.onclick = \(\) => loadAgentRuns\(true\)/.test(app), 'S(前端) 对抗轮 P2(#14): 刷新按钮显式 force 全量(不再把 MouseEvent 当 force)');
ok(/if \(dg\.status && c\.run\.status !== dg\.status\) needFull = true;/.test(app) && !/if \(!dg\.live && dg\.status/.test(app), 'S(前端) 对抗轮 P2(#15): status 漂移检测去掉 !dg.live 门(live run 也比 status)');
ok(/if \(dg\.updatedAt && c\.run\.updatedAt && dg\.updatedAt !== c\.run\.updatedAt\) needFull = true;/.test(app), 'S(前端) 对抗轮 P3(#13): updatedAt 前进兜底刷新(冷路径 apply_isolation 自愈)');
ok(/c\.run\.persistenceDegraded = dg\.persistenceDegraded === true;/.test(app) && /c\.run\.resumeTier = dg\.resumeTier \|\| '';/.test(app), 'S(前端) 对抗轮 P3(#16): 旗标叠加对称(dg 值覆写含空,不残留)');
ok(/logEvent\(\{ kind: 'intervention', source: k, sessionId:/.test(src), 'S 对抗轮 P3(#12): bumpRunIntervention 兼落 logEvent(ops 头条含 run 级干预)');
ok(/const wasPaused = live\.paused === true;/.test(src) && /if \(!wasPaused\) bumpRunIntervention\(live\.run, 'pause'\)/.test(src), 'S 对抗轮 P3(#8): pause 计数按状态迁移幂等');
ok(/if \(wasPaused\) bumpRunIntervention\(live\.run, 'resume'\)/.test(src) && /const wasStopping = live\.stopRequested === true;/.test(src), 'S 对抗轮 P3(#8): resume/stop 计数按状态迁移幂等');
ok(/if \(n\.fromPool && n\.failurePolicy === 'continue' && n\.status !== 'rejected'\) continue;/.test(src), 'S 对抗轮 P2(#7): failuresByClass 对齐 fromPool+continue 排除(与 run 总态口径一致)');
ok(/const firstExhaust = !m\.budgetExhaustedAt;/.test(src) && /if \(firstExhaust\) logEvent\(\{ kind: 'mission_budget_exhausted'/.test(src), 'S 对抗轮 P2(#6): budget_exhausted 只在转入时落一次(超支率 ≤100%)');
ok(/budgetExhaustedAt: String\(p\.budgetExhaustedAt \|\| ''\)/.test(src), 'S 对抗轮 P2(#6): normalizeMission 保留 budgetExhaustedAt(update 再武装不清)');
ok(/if \(node\.status === 'rejected'\) node\.errorClass = 'gate_rejected'; else delete node\.errorClass;/.test(src), 'S 对抗轮 P3(#10): vote 门 rejected 标 errorClass(与模型门对称)');
ok(/if \(activeAgentRuns\.has\(run\.id\)\) continue;/.test(src) && (src.match(/if \(activeAgentRuns\.has\(run\.id\)\) continue;/g) || []).length >= 2, 'S 对抗轮 P2(#2): autoResume 前后双复检 live(防 seq 重号/陈旧覆盖)');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [H] Live
// ══════════════════════════════════════════════════════════════════════════════════════════════════
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WS,
  providers: [{ id: 'dummy', label: 'Dummy', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }], activeProvider: 'dummy',
}, null, 2));
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
(async () => {
  try {
    console.log('\n── [H] Live ──');
    ok(await up(), 'H workbench up on :' + WB_PORT);
    const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
    const H = { 'x-wcw-token': token };
    const s = (await req('POST', '/api/sessions', { title: 'mon', cwd: WS }, H)).json.session;
    const sid = s.id;
    const launch = async (nodes) => (await req('POST', '/api/agent-workflow/launch', { token, sessionId: sid, nodes, async: true }, H)).json;
    const getRun = async (runId, q = '') => (await req('GET', '/api/agent-runs/' + runId + '?sessionId=' + encodeURIComponent(sid) + q, null, H)).json;
    const pollRun = async (runId, ms) => { for (let i = 0; i < ms / 200; i++) { const j = await getRun(runId); const run = j && j.run; if (run && ['succeeded', 'failed', 'partial', 'stopped', 'cancelled'].includes(run.status)) return run; await sleep(200); } return null; };
    const runsDir = path.join(HOME, 'agent-runs', sid);

    // (0) 历史负载:直接落 3 份"胖"终态 run 快照(每节点 result 5KB —— 模拟真实历史,全量轮询的浪费主体)。
    fs.mkdirSync(runsDir, { recursive: true });
    const fat = 'R'.repeat(5000);
    for (let i = 0; i < 3; i++) {
      const rid = 'run_' + ('f00d' + i).padEnd(16, '0');
      fs.writeFileSync(path.join(runsDir, rid + '.json'), JSON.stringify({
        schemaVersion: 4, id: rid, sessionId: sid, status: 'succeeded', createdAt: new Date(Date.now() - 86400000 + i).toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
        concurrency: 2, taskPool: [], messages: [], poolPolicy: 'manual', poolAutoCap: 3, eventSeq: 5,
        nodes: [{ id: 'n1', task: '历史任务', dependsOn: [], status: 'succeeded', attempts: 1, result: fat, error: '', progressLog: [] },
                { id: 'n2', task: '历史任务2', dependsOn: ['n1'], status: 'succeeded', attempts: 1, result: fat, error: '', progressLog: [] }],
      }));
    }

    // (1) 跑一个真 wait run 到完成(产生真实事件文件)。
    const l1 = await launch([{ id: 'w1', wait: { mode: 'timer', durationMs: 600, pollMs: 500, timeoutMs: 20000 } }]);
    ok(l1 && l1.runId, 'H1 timer wait run 启动');
    const r1 = await pollRun(l1.runId, 15000);
    ok(r1 && r1.status === 'succeeded', 'H1 run 完成(实 ' + (r1 && r1.status) + ')');

    // (2) digest 轻量视图:字段齐、不带 nodes/result;字节数远小于全量。
    const full = await req('GET', '/api/agent-runs?sessionId=' + encodeURIComponent(sid), null, H);
    const dig = await req('GET', '/api/agent-runs?sessionId=' + encodeURIComponent(sid) + '&view=digest', null, H);
    ok(dig.json && dig.json.view === 'digest' && Array.isArray(dig.json.runs) && dig.json.runs.length === 4, 'H2 digest 返回 4 个 run');
    const d1 = dig.json.runs.find(x => x.id === l1.runId);
    ok(d1 && d1.status === 'succeeded' && Number(d1.eventSeq) > 0 && typeof d1.nodeCount === 'number' && !d1.nodes, 'H2 digest 含 status/eventSeq/nodeCount,不含 nodes 体');
    ok(!/RRRRRRRR/.test(dig.text), 'H2 digest 不携带节点 result(胖字段不下发)');
    ok(dig.bytes < full.bytes * 0.2, `H2 digest 字节 ${dig.bytes} < 全量 ${full.bytes} 的 20%`);

    // (3) events afterSeq 补播:全量→尾段→幂等重放→越界空→limit/hasMore。
    const ev0 = await req('GET', `/api/agent-runs/${l1.runId}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=0`, null, H);
    const evs = ev0.json && ev0.json.events || [];
    ok(ev0.json && ev0.json.ok && evs.length >= 3, 'H3 afterSeq=0 拿到全部事件(≥3 条,实 ' + evs.length + ')');
    ok(evs.every((e, i) => i === 0 || e.seq > evs[i - 1].seq), 'H3 seq 严格递增');
    ok(evs.some(e => e.type === 'run_created') && evs.some(e => e.type === 'node_wait') && evs.some(e => e.type === 'node_settled') && evs.some(e => e.type === 'run_end'), 'H3 事件链含 run_created/node_wait/node_settled/run_end');
    const midSeq = evs[1].seq;
    const evMid = (await req('GET', `/api/agent-runs/${l1.runId}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=${midSeq}`, null, H)).json;
    ok(evMid.events.length === evs.length - 2 && evMid.events[0].seq === evs[2].seq, 'H3 afterSeq=中位 只回尾段(断线补播语义)');
    const evReplay = (await req('GET', `/api/agent-runs/${l1.runId}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=${midSeq}`, null, H)).json;
    ok(JSON.stringify(evReplay.events) === JSON.stringify(evMid.events), 'H3 同 afterSeq 重放幂等(无重无漏)');
    const evBig = (await req('GET', `/api/agent-runs/${l1.runId}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=99999`, null, H)).json;
    ok(evBig.ok && evBig.events.length === 0 && evBig.hasMore === false, 'H3 afterSeq 越界 → 空(不报错)');
    const evLim = (await req('GET', `/api/agent-runs/${l1.runId}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=0&limit=2`, null, H)).json;
    ok(evLim.events.length === 2 && evLim.hasMore === true, 'H3 limit=2 截断 + hasMore=true');

    // (4) 坏行免疫:事件文件尾部注入垃圾行/半写行 → 读取不炸、事件数不变。
    const evFile = path.join(runsDir, l1.runId + '.events.ndjson');
    fs.appendFileSync(evFile, 'GARBAGE-NOT-JSON\n{"seq":');
    const evDirty = (await req('GET', `/api/agent-runs/${l1.runId}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=0`, null, H)).json;
    ok(evDirty.ok && evDirty.events.length === evs.length, 'H4 坏行/半写尾行被跳过(数量不变,不 500)');

    // (5) 鉴权与跨会话:无 token 403;别人的 sessionId 拿不到事件与快照。
    ok((await req('GET', `/api/agent-runs/${l1.runId}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=0`)).status === 403, 'H5 events 无 token → 403');
    ok((await req('GET', '/api/agent-runs?sessionId=' + encodeURIComponent(sid) + '&view=digest')).status === 403, 'H5 digest 无 token → 403');
    ok((await req('GET', '/api/ops/metrics')).status === 403, 'H5 ops 指标无 token → 403');
    const foreign = (await req('GET', `/api/agent-runs/${l1.runId}/events?sessionId=someoneelse00000&afterSeq=0`, null, H)).json;
    ok(foreign.ok && foreign.events.length === 0, 'H5 错 session 的事件请求 → 空(按目录天然隔离)');
    ok((await req('GET', `/api/agent-runs/${l1.runId}?sessionId=someoneelse00000`, null, H)).status === 404, 'H5 错 session 的单 run GET → 404');

    // (6) 活跃 run:file wait 挂起 → 单 run GET live 叠加;pause/resume 干预计数 + digest 即时反映。
    const flag = path.join(WS, 'mon-ready.flag');
    const l2 = await launch([{ id: 'w2', wait: { mode: 'file', path: flag, exists: true, pollMs: 500, timeoutMs: 60000 } }]);
    await sleep(1200);
    const live1 = await getRun(l2.runId);
    ok(live1 && live1.run && live1.run.live === true && live1.run.nodes[0].status === 'waiting', 'H6 单 run GET 对活跃 run 叠加 live:true(内存态)');
    await req('POST', '/api/agent-runs/' + l2.runId, { sessionId: sid, action: 'pause' }, H);
    const digP = (await req('GET', '/api/agent-runs?sessionId=' + encodeURIComponent(sid) + '&view=digest', null, H)).json;
    const dp = digP.runs.find(x => x.id === l2.runId);
    ok(dp && dp.paused === true && dp.live === true, 'H6 pause 后 digest 即时反映 paused(内存旗标)');
    await req('POST', '/api/agent-runs/' + l2.runId, { sessionId: sid, action: 'resume' }, H);
    const liveM = await getRun(l2.runId);
    ok(liveM.run && liveM.run.metrics && liveM.run.metrics.interventions && liveM.run.metrics.interventions.pause === 1 && liveM.run.metrics.interventions.resume === 1, 'H6 run.metrics.interventions 计到 pause=1/resume=1(29c)');

    // (7) 【验收锁】传输量:忠实模拟前端增量算法 N tick(digest→seq 前进拉 events→settle 类拉单 run 快照;
    //     live 慢刷 10s 在 20tick×~150ms 窗口内不触发),对照全量模式(每 tick 全量列表)。要求 ≤20%。
    let fullBytes = 0, incrBytes = 0;
    const cache = new Map(); // runId -> lastSeq
    // 起步基线:两种模式第一拍都要拿全量(公平比较,基线各计一次)。
    const base = await req('GET', '/api/agent-runs?sessionId=' + encodeURIComponent(sid), null, H);
    fullBytes += base.bytes; incrBytes += base.bytes;
    for (const r of base.json.runs) cache.set(r.id, Number(r.eventSeq) || 0);
    // tick 10 下建旗标文件令活跃 run 落定(制造真实事件流量,而非纯静止的作弊对比)。
    for (let tick = 0; tick < 20; tick++) {
      if (tick === 10) fs.writeFileSync(flag, 'go');
      // 全量模式:每 tick 拉全量列表。
      fullBytes += (await req('GET', '/api/agent-runs?sessionId=' + encodeURIComponent(sid), null, H)).bytes;
      // 增量模式:digest;seq 前进的 run 拉增量事件;settle 类事件出现才拉该 run 快照。
      const d = await req('GET', '/api/agent-runs?sessionId=' + encodeURIComponent(sid) + '&view=digest', null, H);
      incrBytes += d.bytes;
      for (const dg of d.json.runs) {
        const last = cache.get(dg.id);
        if (last == null) { const fr = await req('GET', `/api/agent-runs/${dg.id}?sessionId=${encodeURIComponent(sid)}`, null, H); incrBytes += fr.bytes; cache.set(dg.id, Number(fr.json.run.eventSeq) || 0); continue; }
        if ((Number(dg.eventSeq) || 0) > last) {
          const er = await req('GET', `/api/agent-runs/${dg.id}/events?sessionId=${encodeURIComponent(sid)}&afterSeq=${last}`, null, H);
          incrBytes += er.bytes;
          const es = er.json.events || [];
          if (es.length) {
            cache.set(dg.id, es[es.length - 1].seq);
            if (es.some(e => e.type !== 'node_progress' && e.type !== 'node_start')) { const fr = await req('GET', `/api/agent-runs/${dg.id}?sessionId=${encodeURIComponent(sid)}`, null, H); incrBytes += fr.bytes; cache.set(dg.id, Number(fr.json.run.eventSeq) || 0); }
          }
        }
      }
      await sleep(150);
    }
    const ratio = incrBytes / fullBytes;
    ok(ratio <= 0.2, `H7 【验收锁】增量传输 ${incrBytes}B ≤ 全量 ${fullBytes}B 的 20%(实 ${(ratio * 100).toFixed(1)}%)`);

    // (8) ops 指标端点形状(干预 logEvent 已由 steer/permission 等触发面覆盖,此处至少形状与聚合不炸)。
    const ops = (await req('GET', '/api/ops/metrics?days=7', null, H)).json;
    ok(ops && ops.ok === true && ops.interventions && typeof ops.interventions.total === 'number' && ops.missions && typeof ops.missions.budgetOverrunRate === 'number', 'H8 ops 指标端点形状(interventions/missions)');
    // mission_start 落账 → 分母可算。
    await req('POST', '/api/mission', { sessionId: sid, action: 'start', goal: '测试目标', milestones: [{ id: 'm1', title: 't' }] }, H);
    await sleep(300); // logEvent 是流式追加,给写盘一拍
    const ops2 = (await req('GET', '/api/ops/metrics?days=7', null, H)).json;
    ok(ops2.missions.started >= 1, 'H8 mission_start 计入分母(实 ' + ops2.missions.started + ')');
  } catch (e) { ok(false, 'H 异常:' + (e && e.stack || e)); }
  finally {
    kill(wb);
    console.log('');
    if (fail) { console.log('MONITOR-INCREMENTAL E2E: FAIL (' + fail + ')'); process.exit(1); }
    console.log('MONITOR-INCREMENTAL E2E: ALL PASS');
  }
})();
