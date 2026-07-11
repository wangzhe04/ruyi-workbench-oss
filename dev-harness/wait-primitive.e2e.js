// E2E: 第28e波「wait_for 等待原语」(AUTONOMY-PLAN §28e)。端口 WB 9118(已登记)。
// [P] 纯逻辑源抽取:normalizeWaitSpec(clamp/校验)+ evalWaitCondition(timer/file/process/url 四模式,注入护栏桩)。
// [S] 静态锁:reducer 传 isWaitNode、外壳 arm/poll/tick、wait×worktree 互斥、process 仅信号0、file 过工作区护栏、url 过 SSRF。
// [H] Live:纯 timer wait 节点 arm→waiting→succeeded(零 token,无 provider 调用);file wait 中途建文件→succeeded;超时→failed。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const WB_PORT = 9118;
const HOME = path.join(os.tmpdir(), 'wcw-wait-primitive-e2e');
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
      let buf = ''; res.on('data', c => (buf += c)); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {} await sleep(150); } return false; }
const src = fs.readFileSync(SERVER, 'utf8');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [S] 静态锁
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [S] 静态锁 ──');
ok(/isWaitNode: n => !!\(n && n\.wait\)/.test(src), 'S reducer 调用点传 isWaitNode');
ok(/const toDispatch = \[\], toArm = \[\];/.test(src) && /toArm\.push\(node\.id\)/.test(src), 'S reducer 就绪 wait 节点单列 toArm');
ok(/for \(const id of \(step\.toArm \|\| \[\]\)\)/.test(src) && /node\.status = 'waiting'; node\.waitStartedAt = nowIso\(\)/.test(src), 'S 外壳 arm:queued→waiting + waitStartedAt');
ok(/await evalWaitCondition\(node, \{ session: parentSession, config, cwd: waitCwd \}\)/.test(src), 'S 外壳 poll 块调 evalWaitCondition');
ok(/else if \(anyWaiting\) await abortableSleep\(waitPollMs\(\)\)/.test(src), 'S 外壳 tick:仅 waiting 时可中断 sleep(防 busy-spin)');
ok(/isolationMode: \(!wait &&/.test(src) && /\(item\.isolation === 'worktree' && !wait\)/.test(src), 'S wait × worktree 互斥(两归一器均降级 none,无不可启动模板)');
ok(/spec\.timeoutMs = Math\.max\(spec\.timeoutMs, spec\.durationMs \+ spec\.pollMs\)/.test(src), 'S 对抗轮 P2:timer 的 timeoutMs 抬到 ≥ durationMs+pollMs(超时不抢先)');
ok(/if \(Date\.now\(\) - \(Number\(node\.lastWaitPollAt\) \|\| 0\) < \(Number\(w\.pollMs\)/.test(src), 'S 对抗轮 P3:per-node pollMs 节流');
ok(/for \(const n of nodes\) if \(n\.status === 'waiting' && n\.waitStartedAt\) \{ const t = Date\.parse/.test(src), 'S 对抗轮 P2:暂停补偿 waitStartedAt');
ok(/for \(const n of nodes\) if \(n\.status === 'waiting'\) n\.waitStartedAt = nowIso\(\);/.test(src), 'S 对抗轮 P3:resume 重置 waiting 等待窗');
ok(/process\.kill\(w\.pid, 0\)/.test(src) && !/process\.kill\(w\.pid, ['"]?SIG/.test(src), 'S process 模式仅发信号 0(绝不真实信号)');
ok(/guardWorkspacePath\(path\.resolve\(String\(ctx\.cwd \|\| ''\), String\(w\.path \|\| ''\)\), ctx\.session, ctx\.config\)/.test(src), 'S file 模式过 guardWorkspacePath(按 ctx.cwd 解析 + 工作区/敏感面护栏)');
ok(/const chk = ssrfCheck\(String\(w\.url \|\| ''\)\)/.test(src) && /httpGetGuarded\(String\(w\.url/.test(src), 'S url 模式过 ssrfCheck + httpGetGuarded');
ok(/waiting: '等待条件'/.test(src), 'S agentWorkflowStatusText 含 waiting:等待条件');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [P] 纯逻辑:normalizeWaitSpec + evalWaitCondition
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [P] normalizeWaitSpec ──');
const nm = src.match(/function normalizeWaitSpec\(raw\) \{[\s\S]*?\n\}/);
ok(!!nm, 'P 源抽取 normalizeWaitSpec');
const normalizeWaitSpec = new Function(nm[0] + '\nreturn normalizeWaitSpec;')();
ok(normalizeWaitSpec(null) === null && normalizeWaitSpec({ mode: 'nope' }) === null, 'P 非法/未知 mode → null');
{
  const t = normalizeWaitSpec({ mode: 'timer', durationMs: 5000, timeoutMs: 999, pollMs: 100 });
  ok(t && t.mode === 'timer' && t.durationMs === 5000, 'P timer 规整');
  ok(t.pollMs === 500, 'P pollMs 夹到 ≥500ms');
  const tf = normalizeWaitSpec({ mode: 'file', path: 'a', timeoutMs: 999, pollMs: 100 }); // 无 durationMs 抬升,纯测 timeoutMs 下限
  ok(tf.timeoutMs === 1000 && tf.pollMs === 500, 'P timeoutMs 夹到 ≥1s(file 模式)');
  const t2 = normalizeWaitSpec({ mode: 'timer', timeoutMs: 99 * 3600 * 1000, pollMs: 99999 });
  ok(t2.timeoutMs === 24 * 3600 * 1000 && t2.pollMs === 60000, 'P timeoutMs 夹到 ≤24h、pollMs 夹到 ≤60s');
  // 对抗轮 P2:timer 的 timeoutMs 被抬到 ≥ durationMs+pollMs,>5min(默认 timeout)的 timer 不再被超时抢先判失败。
  const t3 = normalizeWaitSpec({ mode: 'timer', durationMs: 600000 }); // 10min > 默认 5min timeout
  ok(t3.timeoutMs >= t3.durationMs + t3.pollMs && t3.timeoutMs === 600000 + 2000, 'P timer timeoutMs 抬到 ≥ durationMs+pollMs(超时不抢先)');
}
ok(normalizeWaitSpec({ mode: 'file' }) === null, 'P file 缺 path → null');
ok(normalizeWaitSpec({ mode: 'file', path: 'a.txt' }).exists === true, 'P file exists 默认 true');
ok(normalizeWaitSpec({ mode: 'file', path: 'a.txt', exists: false }).exists === false, 'P file exists=false 尊重');
ok(normalizeWaitSpec({ mode: 'process' }) === null && normalizeWaitSpec({ mode: 'process', pid: 1 }) === null, 'P process pid≤1 → null(禁 0/init)');
ok(normalizeWaitSpec({ mode: 'process', pid: 4242 }).state === 'alive', 'P process state 默认 alive');
ok(normalizeWaitSpec({ mode: 'url' }) === null && !!normalizeWaitSpec({ mode: 'url', url: 'http://x' }), 'P url 缺 url → null');

console.log('\n── [P] evalWaitCondition(注入护栏桩) ──');
const em = src.match(/async function evalWaitCondition\(node, ctx\) \{[\s\S]*?\n\}/);
ok(!!em, 'P 源抽取 evalWaitCondition');
// 注入:guardWorkspacePath(桩:含 SENS→拒,否则 ok)、fsp(真)、path(真)、process(真)、ssrfCheck/httpGetGuarded(桩)。
const fsp = require('fs').promises;
let guardCalls = 0, lastGuardPath = '';
const guardWorkspacePath = async (p) => { guardCalls++; lastGuardPath = String(p); return /SENS/.test(String(p)) ? { ok: false, error: '敏感面拒绝' } : { ok: true, absPath: String(p) }; };
let ssrfAllow = true, httpOk = true;
const ssrfCheck = () => ({ allowed: ssrfAllow, reason: 'stub' });
const httpGetGuarded = async () => (httpOk ? { ok: true, status: 200 } : { ok: false, failClass: 'connect' });
const evalWaitCondition = new Function('guardWorkspacePath', 'fsp', 'path', 'process', 'ssrfCheck', 'httpGetGuarded',
  em[0] + '\nreturn evalWaitCondition;')(guardWorkspacePath, fsp, path, process, ssrfCheck, httpGetGuarded);

(async () => {
  // timer:未到→not done;已到→done。
  const past = new Date(Date.now() - 5000).toISOString();
  const now = new Date().toISOString();
  ok((await evalWaitCondition({ wait: { mode: 'timer', durationMs: 1000 }, waitStartedAt: past }, {})).done === true, 'P timer 已到→done');
  ok((await evalWaitCondition({ wait: { mode: 'timer', durationMs: 100000 }, waitStartedAt: now }, {})).done === false, 'P timer 未到→未 done');
  // file:存在性匹配 exists;护栏拒→failed。
  const realFile = path.join(os.tmpdir(), 'wait-e2e-exists-' + process.pid + '.txt'); fs.writeFileSync(realFile, 'x');
  ok((await evalWaitCondition({ wait: { mode: 'file', path: realFile, exists: true } }, { session: {}, config: {} })).done === true, 'P file 存在且 exists=true→done');
  ok((await evalWaitCondition({ wait: { mode: 'file', path: realFile + '.nope', exists: false } }, { session: {}, config: {} })).done === true, 'P file 不存在且 exists=false→done');
  const gErr = await evalWaitCondition({ wait: { mode: 'file', path: '/SENS/config.json', exists: true } }, { session: {}, config: {} });
  ok(gErr.failed === true, 'P file 护栏拒(敏感面)→failed');
  // 对抗轮 P3:相对路径按 ctx.cwd(工作区)解析,不是服务器进程 cwd。
  const wsRoot = path.join(os.tmpdir(), 'wait-ws-root');
  await evalWaitCondition({ wait: { mode: 'file', path: 'sub/flag.txt', exists: true } }, { session: {}, config: {}, cwd: wsRoot });
  ok(lastGuardPath === path.resolve(wsRoot, 'sub/flag.txt'), 'P file 相对路径按 ctx.cwd 解析(而非进程 cwd)');
  fs.unlinkSync(realFile);
  // process:自身 pid 存活;不存在的大 pid→不存活。仅信号0(不杀)。
  ok((await evalWaitCondition({ wait: { mode: 'process', pid: process.pid, state: 'alive' } }, {})).done === true, 'P process 自身存活 alive→done');
  ok((await evalWaitCondition({ wait: { mode: 'process', pid: 999999, state: 'exit' } }, {})).done === true, 'P process 不存在 exit→done');
  // url:ssrf 拒→failed;可达→done;连不上→维持等待(not done, not failed)。
  ssrfAllow = false; ok((await evalWaitCondition({ wait: { mode: 'url', url: 'http://evil' } }, {})).failed === true, 'P url SSRF 拒→failed');
  ssrfAllow = true; httpOk = true; ok((await evalWaitCondition({ wait: { mode: 'url', url: 'http://x' } }, {})).done === true, 'P url 可达→done');
  httpOk = false; { const r = await evalWaitCondition({ wait: { mode: 'url', url: 'http://x' } }, {}); ok(r.done === false && r.failed === false, 'P url 连不上→维持等待(不 done 不 failed)'); }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // [H] Live:arm→waiting→succeeded / file 中途建 / 超时 failed
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WS,
    // 哑 provider:纯 wait DAG 永不调用它,仅用于通过 launch 的"需一个引擎"门。
    providers: [{ id: 'dummy', label: 'Dummy', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'm', models: [{ id: 'm', label: 'm' }] }], activeProvider: 'dummy',
  }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    console.log('\n── [H] Live ──');
    ok(await up(), 'H workbench up on :' + WB_PORT);
    const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
    const H = { 'x-wcw-token': token };
    const s = (await req('POST', '/api/sessions', { title: 'wait', cwd: WS }, H)).json.session;
    const launch = async (nodes) => (await req('POST', '/api/agent-workflow/launch', { token, sessionId: s.id, nodes, async: true }, H)).json;
    const getRun = async (runId) => (await req('GET', '/api/agent-runs/' + runId + '?sessionId=' + encodeURIComponent(s.id), null, H)).json;
    const pollRun = async (runId, ms) => { for (let i = 0; i < ms / 200; i++) { const j = await getRun(runId); const run = j && j.run; if (run && ['succeeded', 'failed', 'partial', 'stopped', 'cancelled'].includes(run.status)) return run; await sleep(200); } return null; };

    // (1) 纯 timer wait 节点:arm→waiting→succeeded(零 provider 调用)。
    const l1 = await launch([{ id: 'w1', wait: { mode: 'timer', durationMs: 700, pollMs: 500, timeoutMs: 20000 } }]);
    ok(l1 && l1.runId, 'H1 timer wait DAG 已启动');
    const r1 = await pollRun(l1.runId, 15000);
    ok(r1 && r1.status === 'succeeded', 'H1 timer wait run → succeeded(实 ' + (r1 && r1.status) + ')');
    ok(r1 && r1.nodes[0].status === 'succeeded' && r1.nodes[0].wait && r1.nodes[0].wait.mode === 'timer', 'H1 wait 节点 succeeded + 保留 wait 规格');

    // (2) file wait:先启动(文件不存在→waiting),中途建文件→succeeded。
    const target = path.join(WS, 'ready.flag');
    const l2 = await launch([{ id: 'w2', wait: { mode: 'file', path: target, exists: true, pollMs: 500, timeoutMs: 20000 } }]);
    await sleep(1200); // 让它进入 waiting
    const mid = await getRun(l2.runId);
    ok(mid && mid.run && mid.run.nodes[0].status === 'waiting', 'H2 文件未建时节点处于 waiting');
    fs.writeFileSync(target, 'go'); // 中途建文件
    const r2 = await pollRun(l2.runId, 15000);
    ok(r2 && r2.status === 'succeeded' && r2.nodes[0].status === 'succeeded', 'H2 建文件后 → succeeded');

    // (3) file wait 超时:文件永不建 + 短 timeout → failed。
    const l3 = await launch([{ id: 'w3', wait: { mode: 'file', path: path.join(WS, 'never.flag'), exists: true, pollMs: 500, timeoutMs: 1000 } }]);
    const r3 = await pollRun(l3.runId, 15000);
    ok(r3 && r3.nodes[0].status === 'failed' && /超时/.test(r3.nodes[0].error || ''), 'H3 文件永不建 + 短 timeout → failed(超时)');
  } catch (e) { ok(false, 'H 异常:' + (e && e.message)); }
  finally {
    kill(wb);
    console.log('');
    if (fail) { console.log('WAIT-PRIMITIVE E2E: FAIL (' + fail + ')'); process.exit(1); }
    console.log('WAIT-PRIMITIVE E2E: ALL PASS');
  }
})();
