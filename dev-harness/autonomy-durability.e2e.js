(async () => {
// E2E: 第25波「耐久基座」(AUTONOMY-PLAN 25.1-25.5) —— 崩溃注入 + 断点续跑 + 幂等写 + 事件日志。
// 端口: FAKE 9109 / WB 9110(已登记 dev-harness/README 端口表)。离线,Node 直跑。
// 断言面:
//  A) atomicWriteJson 源抽取单测:20 路并发写同一目标 → 终稿是完整 JSON(无交错撕裂)、无 *.tmp 孤儿。
//  B) 静态锁:七处原子写全部收编(旧手写 tmp 模式清零);persistenceDegraded 经 live 叠加下发;阈值常量在。
//  C) 崩溃注入·杀点1(≥1 个工具步骤完成后强杀):重启 → run/node 标 interrupted、continuation 存活、
//     interruptedAttempt 记录;resume → 子代理提示词含【断点续跑】(FAKE_CAPTURE_DIR 断言)、
//     首个 file_write 幂等跳过(检查点无 modify 条目)、run 最终 succeeded、续点清理;
//     events.ndjson: seq 严格单调,含 run_created/node_start/run_interrupted/run_resumed/node_settled/run_end。
//  D) 崩溃注入·杀点2(node_start 后、0 个工具完成前强杀):resume 不注入【断点续跑】,run 照常完成。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-autonomy-durability-e2e');
const WS = path.join(HOME, 'ws');
const CAP1 = path.join(HOME, 'cap1'), CAP2 = path.join(HOME, 'cap2');
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
function spawnWb() {
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  return wb;
}
function spawnFake(env) {
  const fk = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), ...env }, windowsHide: true });
  fk.stdout.on('data', () => {}); fk.stderr.on('data', () => {});
  return fk;
}
function runFileOf(sessionId, runId) { return path.join(HOME, 'agent-runs', sessionId, runId + '.json'); }
function eventsFileOf(sessionId, runId) { return path.join(HOME, 'agent-runs', sessionId, runId + '.events.ndjson'); }
function readEvents(sessionId, runId) {
  try { return fs.readFileSync(eventsFileOf(sessionId, runId), 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function capturesContaining(dir, needle) {
  let hits = 0; try { for (const f of fs.readdirSync(dir)) { if (!/^req-\d+\.json$/.test(f)) continue; if (fs.readFileSync(path.join(dir, f), 'utf8').includes(needle)) hits++; } } catch { /* none */ }
  return hits;
}

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  const src = fs.readFileSync(path.join(WB, 'app', 'server.js'), 'utf8');

  // ── A) atomicWriteJson 源抽取 + 并发单测 ──
  {
    const m = src.match(/async function atomicWriteJson\(finalPath, value, opts = \{\}\) \{[\s\S]*?\n\}/);
    ok(!!m, 'A atomicWriteJson 可抽取');
    if (m) {
      const fsp = fs.promises, crypto = require('crypto');
      const make = new Function('fsp', 'crypto', m[0] + '\nreturn atomicWriteJson;');
      const awj = make(fsp, crypto);
      const dest = path.join(HOME, 'concurrent.json');
      await Promise.all(Array.from({ length: 20 }, (_, i) => awj(dest, { writer: i, payload: 'x'.repeat(2048) })));
      const parsed = readJson(dest);
      ok(parsed && typeof parsed.writer === 'number' && parsed.payload.length === 2048, 'A 20 路并发写终稿是完整 JSON(无撕裂),writer=' + (parsed && parsed.writer));
      const orphans = fs.readdirSync(HOME).filter(f => f.includes('.tmp'));
      ok(orphans.length === 0, 'A 无 *.tmp 孤儿(实 ' + orphans.length + ')');
    }
  }

  // ── B) 静态锁 ──
  {
    ok((src.match(/await atomicWriteJson\(/g) || []).length >= 14, 'B 原子写调用点 ≥14(全量收编,实 ' + (src.match(/await atomicWriteJson\(/g) || []).length + ')');
    // 硬不变量:全文件 " + '.tmp'" 只允许 4 处豁免 —— ①atomicWriteJson 自身的唯一名构造;②flushSessionIndexSync
    // (exit 监听器只能同步 I/O,但 tmp 名同样唯一);③检查点回滚的二进制内容恢复(非 JSON,单写者语义);
    // ④v1.9 数据管家 sweep 的 events.ndjson.gz 归档(二进制,进程内串行 sweep 单写者,tmp+rename 原子替换)。
    // 任何人新增第 5 处手写 tmp 写点 → 此断言红,逼着走 atomicWriteJson。
    const tmpSites = (src.match(/\+ '\.tmp'/g) || []).length;
    ok(tmpSites === 4, 'B 手写 tmp 写点=4(白名单豁免;实 ' + tmpSites + ')');
    ok(!/dest \+ '\.' \+ process\.pid \+ '\.tmp'/.test(src), 'B saveAgentRun 旧 pid-only tmp 模式已清零');
    ok(/AGENT_RUN_PERSIST_DEGRADED_AFTER = 3/.test(src) && /AGENT_RUN_PERSIST_PAUSE_AFTER = 8/.test(src), 'B 持久化退化阈值常量在(3/8)');
    ok(/live\.run\.persistenceDegraded\) run\.persistenceDegraded = true/.test(src), 'B GET /api/agent-runs 经 live 叠加下发 persistenceDegraded');
    ok(/function appendAgentRunEvent\(run, evt\)/.test(src) && (src.match(/appendAgentRunEvent\(/g) || []).length >= 10, 'B 事件日志助手 + ≥10 发射点');
    ok(/op === 'skip'\) continue/.test(src), 'B 幂等跳过不进本轮变更清单');
    const fe = fs.readFileSync(path.join(WB, 'app', 'public', 'app.js'), 'utf8');
    const zh = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
    ok(/persistenceDegraded/.test(fe) && /workflow\.stall\.persistence/.test(fe) && /进度持久化异常/.test(zh['workflow.stall.persistence'] || ''), 'B 前端横幅明示持久化退化');
  }

  // ── C) 崩溃注入·杀点1:≥1 工具完成后强杀 → 续点恢复 + 幂等跳过 ──
  const FILE_A = path.join(WS, 'a.txt'), FILE_B = path.join(WS, 'b.txt'), FILE_C = path.join(WS, 'c.txt');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WS,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  let fake = spawnFake({
    FAKE_TOOL_SEQUENCE: JSON.stringify([
      { name: 'file_write', args: { path: FILE_A, content: 'ALPHA-内容-42' } },
      { name: 'file_write', args: { path: FILE_B, content: 'BRAVO-内容-42' } },
      { name: 'file_write', args: { path: FILE_C, content: 'CHARLIE-内容-42' } },
    ]),
    FAKE_STREAM_DELAY_MS: '350', FAKE_CAPTURE_DIR: CAP1,
  });
  let wb = spawnWb();
  ok(await up(WB_PORT), 'C workbench up on :' + WB_PORT);
  const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
  ok(!!token, 'C runtime token 可读');
  const H = { 'x-wcw-token': token };
  const sess = (await httpReq(WB_PORT, 'POST', '/api/sessions', { title: 'durability', cwd: WS }, H)).json;
  const sid = sess && sess.session && sess.session.id;
  ok(!!sid, 'C 会话已建 ' + sid);
  const launch = (await httpReq(WB_PORT, 'POST', '/api/agent-workflow/launch', {
    token, sessionId: sid, async: true,
    nodes: [{ id: 'longwork', task: '把三份文件写好(演示长节点)', toolTier: 'edit', maxIters: 8 }],
  }, H)).json;
  const runId = launch && launch.runId;
  ok(!!(launch && launch.ok && runId), 'C 异步 launch 接受 ' + runId);

  // 等到续点里出现 ≥1 个已完成步骤 → 强杀(模拟工具边界后、节点完成前崩溃)
  let sawStep = false;
  for (let i = 0; i < 200 && !sawStep; i++) {
    await sleep(120);
    const run = readJson(runFileOf(sid, runId));
    const node = run && (run.nodes || []).find(n => n.id === 'longwork');
    if (node && node.continuation && Array.isArray(node.continuation.steps) && node.continuation.steps.length >= 1) sawStep = true;
  }
  ok(sawStep, 'C 续点已含 ≥1 已完成工具步骤(1.5s 节流落盘)');
  const tKill = Date.now(); // §5 MTTR(第31波验收):从强杀到续跑完成的端到端恢复时延
  kill(wb); await sleep(400);
  ok(fs.existsSync(FILE_A) && fs.readFileSync(FILE_A, 'utf8') === 'ALPHA-内容-42', 'C 杀前副作用已生效(a.txt)');

  // 重启 → markInterruptedAgentRuns 标中断,续点存活
  wb = spawnWb();
  ok(await up(WB_PORT), 'C 重启后 workbench up');
  let run = null, node = null;
  for (let i = 0; i < 40; i++) { await sleep(200); run = readJson(runFileOf(sid, runId)); if (run && run.status === 'interrupted') break; }
  node = run && (run.nodes || []).find(n => n.id === 'longwork');
  ok(run && run.status === 'interrupted', 'C 重启后 run=interrupted(实 ' + (run && run.status) + ')');
  ok(node && node.status === 'interrupted', 'C 节点=interrupted');
  ok(node && Number(node.interruptedAttempt) === 1, 'C interruptedAttempt=1 已记录');
  ok(node && node.continuation && node.continuation.attemptId === 1 && node.continuation.steps.length >= 1, 'C 续点存活(attemptId=1, steps=' + (node && node.continuation && node.continuation.steps.length) + ')');
  ok(readEvents(sid, runId).some(e => e.type === 'run_interrupted'), 'C 事件日志含 run_interrupted');

  // resume → 注入【断点续跑】,首个 file_write 幂等跳过,run 最终 succeeded
  const capBefore = fs.existsSync(CAP1) ? fs.readdirSync(CAP1).length : 0;
  const token2 = (readJson(path.join(HOME, 'runtime.json')) || {}).token || token;
  const resume = (await httpReq(WB_PORT, 'POST', '/api/agent-runs/' + runId, { sessionId: sid, action: 'resume' }, { 'x-wcw-token': token2 })).json;
  ok(resume && resume.ok, 'C resume 接受');
  let done = false;
  for (let i = 0; i < 200 && !done; i++) { await sleep(150); run = readJson(runFileOf(sid, runId)); if (run && ['succeeded', 'partial', 'failed', 'stopped'].includes(run.status)) done = true; }
  node = run && (run.nodes || []).find(n => n.id === 'longwork');
  ok(run && run.status === 'succeeded', 'C 续跑后 run=succeeded(实 ' + (run && run.status) + ')');
  ok(Date.now() - tKill < 30000, 'C §5 MTTR<30s(第31波:崩溃->重启->续跑完成 实 ' + (Date.now() - tKill) + 'ms)');
  ok(node && node.status === 'succeeded' && !node.continuation && !node.interruptedAttempt, 'C 成功后续点/中断标记已清理');
  ok(capturesContaining(CAP1, '断点续跑') >= 1, 'C 续跑提示词含【断点续跑】(captured=' + capturesContaining(CAP1, '断点续跑') + ', capBefore=' + capBefore + ')');
  ok(fs.existsSync(FILE_B) && fs.existsSync(FILE_C), 'C b.txt/c.txt 都已写出');
  // 幂等锁:a.txt 在续跑中被同内容重写 → 检查点索引里它只有 1 条 create、0 条 modify
  const jidx = readJson(path.join(HOME, 'checkpoints', sid, 'index.json')) || [];
  const aEntries = jidx.filter(e => e && String(e.path || '') === FILE_A);
  ok(aEntries.filter(e => e.op === 'create').length === 1 && aEntries.filter(e => e.op === 'modify').length === 0,
    'C 幂等跳过:a.txt 检查点 create=1/modify=0(实 ' + JSON.stringify(aEntries.map(e => e.op)) + ')');
  // 事件日志:seq 严格单调 + 关键事件齐
  const evts = readEvents(sid, runId);
  const seqs = evts.map(e => e.seq);
  ok(seqs.length >= 6 && seqs.every((s, i) => i === 0 || s > seqs[i - 1]), 'C events seq 严格单调(' + seqs.length + ' 条)');
  for (const t of ['run_created', 'node_start', 'run_interrupted', 'run_resumed', 'node_settled', 'run_end']) {
    ok(evts.some(e => e.type === t), 'C 事件含 ' + t);
  }

  // ── D) 杀点2:node_start 后、0 工具完成前强杀 → resume 不注入断点,照常完成 ──
  kill(fake); await sleep(200);
  const FILE_D = path.join(WS, 'd.txt');
  fake = spawnFake({
    FAKE_TOOL_SEQUENCE: JSON.stringify([{ name: 'file_write', args: { path: FILE_D, content: 'DELTA-内容' } }]),
    FAKE_STREAM_DELAY_MS: '1500', FAKE_CAPTURE_DIR: CAP2,
  });
  const launch2 = (await httpReq(WB_PORT, 'POST', '/api/agent-workflow/launch', {
    token: token2, sessionId: sid, async: true,
    nodes: [{ id: 'coldstart', task: '写一份文件', toolTier: 'edit', maxIters: 4 }],
  }, { 'x-wcw-token': token2 })).json;
  const runId2 = launch2 && launch2.runId;
  ok(!!(launch2 && launch2.ok && runId2), 'D 第二次异步 launch 接受');
  let dispatched = false;
  for (let i = 0; i < 100 && !dispatched; i++) {
    await sleep(80);
    const r2 = readJson(runFileOf(sid, runId2));
    const n2 = r2 && (r2.nodes || []).find(n => n.id === 'coldstart');
    if (n2 && n2.status === 'running') dispatched = true;
  }
  ok(dispatched, 'D 节点已 dispatch(running 已落盘)');
  kill(wb); await sleep(400);
  const r2AfterKill = readJson(runFileOf(sid, runId2));
  const n2AfterKill = r2AfterKill && (r2AfterKill.nodes || []).find(n => n.id === 'coldstart');
  const hadSteps = !!(n2AfterKill && n2AfterKill.continuation && (n2AfterKill.continuation.steps || []).length);
  wb = spawnWb();
  ok(await up(WB_PORT), 'D 再次重启 up');
  const token3 = (readJson(path.join(HOME, 'runtime.json')) || {}).token || token2;
  let r2 = null;
  for (let i = 0; i < 40; i++) { await sleep(200); r2 = readJson(runFileOf(sid, runId2)); if (r2 && r2.status === 'interrupted') break; }
  ok(r2 && r2.status === 'interrupted', 'D 重启后 run2=interrupted');
  const resume2 = (await httpReq(WB_PORT, 'POST', '/api/agent-runs/' + runId2, { sessionId: sid, action: 'resume' }, { 'x-wcw-token': token3 })).json;
  ok(resume2 && resume2.ok, 'D resume2 接受');
  let done2 = false;
  for (let i = 0; i < 200 && !done2; i++) { await sleep(150); r2 = readJson(runFileOf(sid, runId2)); if (r2 && ['succeeded', 'partial', 'failed', 'stopped'].includes(r2.status)) done2 = true; }
  ok(r2 && r2.status === 'succeeded', 'D 0 步续点也能续跑完成(实 ' + (r2 && r2.status) + ')');
  if (!hadSteps) ok(capturesContaining(CAP2, '断点续跑') === 0, 'D 无已完成步骤 → 不注入【断点续跑】');
  else ok(true, 'D (info) 杀点竞态落在首工具之后,断点注入语义由 C 段覆盖');
  ok(fs.existsSync(FILE_D) && fs.readFileSync(FILE_D, 'utf8') === 'DELTA-内容', 'D d.txt 内容正确');

  kill(wb); kill(fake); await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nAUTONOMY-DURABILITY E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.log('ERROR ' + (e && e.stack || e)); process.exitCode = 1; });

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
