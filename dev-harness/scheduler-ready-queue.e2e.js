// E2E: 第26波「连续就绪队列」(AUTONOMY-PLAN §1 缺口2) —— 去批次屏障。
// 端口: FAKE 9111 / WB 9112(已登记 dev-harness/README 端口表)。离线,Node 直跑。
// 断言面:
//  A) 快下游不等慢兄弟:DAG = slowA(~4s) ∥ fastB(~0.3s) → fastC(依赖 fastB),并发 2。
//     旧批次屏障下 fastC 必须等 [slowA,fastB] 整批结束;连续队列下必能观测到
//     「fastC=succeeded 而 slowA 仍 running」的中间态,且总时长 ≈ slowA 而非串行和。
//  B) 环检测语义保持:a⇄b 互依赖 → run failed,error 含「依赖图存在环」。
//  C) 静态锁:调度器无批次残留 + 26a 对抗轮三铁律(判环=零派发且在飞空 / 收尾=全终态且在飞空 /
//     防双派发 + 身份守卫删除 + 池级兜底不静默)。
//  D) P1-1 确定性反例:同步型 vote 门节点单独在飞时,其 flight 在派发器 save await 期间即 settle ——
//     修前下游 d 被误诊「依赖图存在环」;修后 a,b→v(vote)→d 全链 succeeded。
//  E) 收尾封口:run 完成后快照不再变动(mtime/eventSeq 冻结)、事件日志末条=run_end、
//     node_start 与 node_settled/node_requeued 按 attemptId 一一配对。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_PORT = 9111, WB_PORT = 9112;
const HOME = path.join(os.tmpdir(), 'wcw-ready-queue-e2e');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function httpReq(port, method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = ''; res.on('data', c => (buf += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch { /* raw */ } resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
}
async function up(port) { for (let i = 0; i < 60; i++) { try { const r = await httpReq(port, 'GET', '/health'); if (r.status === 200) return true; } catch { /* not yet */ } await sleep(150); } return false; }

// 内联 fake:按请求体里的任务标记决定响应延迟(SLOWMARK ~4s / 其余 ~0.25s),纯文本回答(无工具)。
const fake = http.createServer((req, res) => {
  let body = ''; req.on('data', c => (body += c));
  req.on('end', async () => {
    if (req.method === 'GET' && (req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] }));
    }
    if (req.method === 'POST' && (req.url || '').includes('/chat/completions')) {
      const delay = body.includes('SLOWMARK') ? 4000 : 250;
      await sleep(delay);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const id = 'chatcmpl-rq';
      const sse = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      sse({ id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      sse({ id, choices: [{ index: 0, delta: { content: '节点完成:' + (body.includes('SLOWMARK') ? '慢任务' : '快任务') }, finish_reason: null }] });
      sse({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      sse({ id, choices: [], usage: { prompt_tokens: 40, completion_tokens: 12, total_tokens: 52 } });
      res.write('data: [DONE]\n\n'); res.end();
      return;
    }
    res.writeHead(404); res.end('nope');
  });
});

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const src = fs.readFileSync(path.join(WB, 'app', 'server.js'), 'utf8');

  // ── C) 静态锁 ──
  ok(!/await Promise\.all\(batch\.map\(/.test(src), 'C 批次屏障代码已移除(Promise.all(batch.map) 不存在)');
  ok(/const inFlight = new Map\(\)/.test(src) && /raceInFlight/.test(src), 'C 连续队列结构在(inFlight/raceInFlight)');
  ok(/if \(!dispatched && !inFlight\.size\)/.test(src), 'C 铁律①: 判环=「本轮零派发 且 在飞空」(防同步节点 fast-settle 误诊)');
  ok(/nodes\.every\(terminal\) && !inFlight\.size/.test(src), 'C 铁律②: 收尾/宽限窗=「全终态 且 在飞空」(防 run_end 后写/queued 僵尸)');
  ok(/if \(inFlight\.has\(node\.id\)\) continue/.test(src), 'C 铁律③a: 重排节点防双派发');
  ok(/inFlight\.get\(node\.id\) === flight\) inFlight\.delete/.test(src), 'C 铁律③b: finally 删除带身份守卫');
  ok(/调度器兜底异常/.test(src), 'C 池级兜底不静默(钉节点+落事件)');

  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: HOME, subagentMaxConcurrent: 2,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    ok(await up(WB_PORT), 'workbench up on :' + WB_PORT);
    const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
    const H = { 'x-wcw-token': token };
    const sid = ((await httpReq(WB_PORT, 'POST', '/api/sessions', { title: 'rq', cwd: HOME }, H)).json || {}).session.id;
    ok(!!sid, '会话已建');

    // ── A) 快下游不等慢兄弟 ──
    const t0 = Date.now();
    const launch = (await httpReq(WB_PORT, 'POST', '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'slowA', task: '慢任务 SLOWMARK:研究一个大问题', toolTier: 'read', maxIters: 3 },
        { id: 'fastB', task: '快任务:先导小步骤', toolTier: 'read', maxIters: 3 },
        { id: 'fastC', task: '快任务:基于 fastB 的下游', toolTier: 'read', maxIters: 3, dependsOn: ['fastB'] },
      ],
    }, H)).json;
    const runId = launch && launch.runId;
    ok(!!(launch && launch.ok && runId), '异步 launch 接受 ' + runId);
    const runFile = path.join(HOME, 'agent-runs', sid, runId + '.json');
    let sawOverlap = false, done = false, finalRun = null;
    while (!done && Date.now() - t0 < 30000) {
      await sleep(100);
      const run = readJson(runFile);
      if (!run) continue;
      const st = Object.fromEntries((run.nodes || []).map(n => [n.id, n.status]));
      if (st.fastC === 'succeeded' && st.slowA === 'running') sawOverlap = true;
      if (['succeeded', 'partial', 'failed', 'stopped'].includes(run.status)) { done = true; finalRun = run; }
    }
    const wall = Date.now() - t0;
    ok(!!finalRun && finalRun.status === 'succeeded', 'A run 最终 succeeded(实 ' + (finalRun && finalRun.status) + ')');
    ok(sawOverlap, 'A 观测到「fastC 已完成而 slowA 仍在跑」—— 批次屏障下不可能出现的中间态');
    ok(wall < 4000 + 2500, 'A 总时长 ≈ 慢节点而非串行和(实 ' + wall + 'ms < 6500ms)');

    // ── B) 环检测 ──
    const launch2 = (await httpReq(WB_PORT, 'POST', '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'a', task: '快任务 甲', toolTier: 'read', maxIters: 2, dependsOn: ['b'] },
        { id: 'b', task: '快任务 乙', toolTier: 'read', maxIters: 2, dependsOn: ['a'] },
      ],
    }, H)).json;
    const runId2 = launch2 && launch2.runId;
    ok(!!(launch2 && launch2.ok && runId2), 'B 环 DAG launch 接受');
    let r2 = null;
    for (let i = 0; i < 60; i++) { await sleep(150); r2 = readJson(path.join(HOME, 'agent-runs', sid, runId2 + '.json')); if (r2 && ['failed', 'partial', 'succeeded'].includes(r2.status)) break; }
    ok(r2 && r2.status === 'failed', 'B 环 run=failed(实 ' + (r2 && r2.status) + ')');
    ok(r2 && (r2.nodes || []).every(n => /依赖图存在环/.test(String(n.error || ''))), 'B 节点 error 含「依赖图存在环」');

    // ── D) P1-1 确定性反例:a,b → v(vote 门,同步 settle)→ d ──
    const launch3 = (await httpReq(WB_PORT, 'POST', '/api/agent-workflow/launch', {
      token, sessionId: sid, async: true,
      nodes: [
        { id: 'a', task: '快任务 甲:给出正面观点', toolTier: 'read', maxIters: 2 },
        { id: 'b', task: '快任务 乙:给出反面观点', toolTier: 'read', maxIters: 2 },
        // dedupe 门 = 确定性同步节点(无模型调用,首个 await 即尾部落盘)—— P1-1 的精确形态:
        // 它单独在飞时,flight 在派发器自己的 save await 期间 settle 清空 inFlight。
        { id: 'v', task: '发现去重聚合', toolTier: 'read', dependsOn: ['a', 'b'], gate: { mode: 'dedupe' } },
        { id: 'd', task: '快任务 丁:基于聚合的下游', toolTier: 'read', maxIters: 2, dependsOn: ['v'] },
      ],
    }, H)).json;
    ok(!!(launch3 && launch3.ok && launch3.runId), 'D vote-DAG launch 接受');
    let r3 = null;
    for (let i = 0; i < 100; i++) { await sleep(150); r3 = readJson(path.join(HOME, 'agent-runs', sid, launch3.runId + '.json')); if (r3 && ['failed', 'partial', 'succeeded', 'stopped'].includes(r3.status)) break; }
    const st3 = Object.fromEntries(((r3 && r3.nodes) || []).map(n => [n.id, n.status]));
    ok(r3 && ['succeeded', 'partial'].includes(r3.status) && st3.d && st3.d !== 'failed' && !/依赖图存在环/.test(String(((r3.nodes || []).find(n => n.id === 'd') || {}).error || '')),
      'D 同步 vote 节点 fast-settle 后下游未被误诊为环(d=' + st3.d + ', run=' + (r3 && r3.status) + ')');

    // ── E) 收尾封口:run1 完成后快照冻结 + 事件配对 ──
    const evFile = path.join(HOME, 'agent-runs', sid, runId + '.events.ndjson');
    const snapBefore = fs.statSync(runFile).mtimeMs + ':' + (readJson(runFile) || {}).eventSeq;
    await sleep(1800);   // > 1.5s 节流窗,若有 detached 尾巴写入必被观测
    const snapAfter = fs.statSync(runFile).mtimeMs + ':' + (readJson(runFile) || {}).eventSeq;
    ok(snapBefore === snapAfter, 'E run 完成后快照冻结(无 run_end 后写)');
    const evts = fs.readFileSync(evFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    ok(evts.length && evts[evts.length - 1].type === 'run_end', 'E 事件日志末条 = run_end(实 ' + (evts.length && evts[evts.length - 1].type) + ')');
    const starts = evts.filter(e => e.type === 'node_start').map(e => e.nodeId + '#' + e.attemptId);
    const settles = evts.filter(e => e.type === 'node_settled' || e.type === 'node_requeued').map(e => e.nodeId + '#' + e.attemptId);
    ok(starts.length && starts.every(k => settles.includes(k)), 'E node_start 与 settle/requeue 按 attemptId 配对(' + starts.length + ' 对)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    kill(wb); try { fake.close(); } catch { /* ignore */ }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSCHEDULER-READY-QUEUE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
