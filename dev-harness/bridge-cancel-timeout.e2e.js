'use strict';
/*
 * E2E (第47波47b): 桥 cancel/超时契约 —— 消灭"桥先超时、ACC 僵尸执行"的契约错位。
 *
 * 场景:fake-openai 一回合内按 FAKE_TOOL_SEQUENCE 连发两步:
 *   ① fake__slow_task(ms:30000) —— 桥超时(WCW_BRIDGED_TIMEOUT_OVERRIDE 打到 1500ms)远小于工具时长;
 *   ② fake__echo —— 超时杀客户端后的【下一次调用】,验证惰性重 spawn 恢复服务。
 * 断言:
 *   A ①的工具结果错误文本如实告知"桥接进程树已终止"(不再裸 'tool timed out' 留僵尸);
 *   B fake-mcp 收到 notifications/cancelled(MCP 标准取消通知,requestId 为数字);
 *   C fake-mcp 进程在超时后真的死了(tasklist 查 pid 不在);
 *   D ②的 echo 成功(新客户端重连并恢复服务);
 *   E 静态锁:声明式超时表 / cancelled 通知点 / catch 内 kill / env 测试缝。
 *
 * Run: node dev-harness/bridge-cancel-timeout.e2e.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HERE = __dirname;
const FAKE_MCP = path.join(HERE, 'fake-mcp.js');
const HOME = path.join(os.tmpdir(), 'ruyi-bridge-cancel');
const NOTIFY_CAPTURE = path.join(HOME, 'notify.jsonl');
const PID_CAPTURE = path.join(HOME, 'fake-mcp.pid');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 60000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, ...(JSON.parse(b) || {}) }); } catch { resolve({ status: res.statusCode }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(raw); r.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 90000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); });
    req.write(raw); req.end();
  });
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }
function pidAlive(pid) {
  try {
    const out = cp.execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true });
    return new RegExp('\\b' + pid + '\\b').test(out) && !/No tasks/.test(out);
  } catch { return false; }
}

(async () => {
  // ── E 段: 静态锁 ──
  console.log('── E 段: 静态锁(超时表 / cancelled 通知 / kill 兜底) ──');
  const src = fs.readFileSync(SERVER, 'utf8');
  ok(/const BRIDGED_TOOL_TIMEOUTS = \{/.test(src) && /run_command: 650000/.test(src), 'E1 声明式按工具超时表在(run_command/launch_application 650s)');
  ok(src.includes("notifications/cancelled"), 'E2 tools/call 超时发 notifications/cancelled(MCP 标准取消)');
  ok(/catch \(e\) \{[\s\S]{0,400}timed out[\s\S]{0,300}this\.kill\(\)/.test(src), 'E3 callTool catch 内超时即 kill 客户端进程树');
  ok(src.includes('WCW_BRIDGED_TIMEOUT_OVERRIDE'), 'E4 env 测试缝在(e2e 打秒级超时)');
  ok(src.includes('bridgedToolTimeoutMs(name)'), 'E5 callTool 缺省超时走声明式表(调用点免费获得)');

  // ── 起服务 ──
  const WP = await getFreePort(), FP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const seq = JSON.stringify([
    { name: 'fake__slow_task', args: { ms: 30000 } },
    { name: 'fake__echo', args: { message: 'alive-after-kill' } },
  ]);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '2.0.0', permissionMode: 'bypass', defaultWorkspace: HOME,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
    externalMcpServers: [{
      id: 'fake', label: 'Fake MCP', command: process.execPath, args: [FAKE_MCP], enabled: true,
      env: { FAKE_MCP_NOTIFY_CAPTURE: NOTIFY_CAPTURE, FAKE_MCP_PID_CAPTURE: PID_CAPTURE },
    }],
    bridgeExternalToolsToProvider: true,
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }));
  const fakeProvider = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_TOOL_SEQUENCE: seq }, windowsHide: true });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, RUYI_HOME: HOME, WCW_BRIDGED_TIMEOUT_OVERRIDE: 'slow_task:1500' },
  });
  try {
    ok(await up(WP), 'workbench starts');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
    const hdr = { 'x-wcw-token': token };
    const created = await post(WP, '/api/sessions', { title: 'bridge-cancel', cwd: HOME }, hdr);
    const sid = created.session.id;

    console.log('── A-D 段: 一回合双步(超时杀 → 重连恢复) ──');
    const t0 = Date.now();
    const events = await postStream(WP, { sessionId: sid, message: '先跑慢任务再说', cwd: HOME });
    const elapsed = Date.now() - t0;
    ok(elapsed < 25000, '回合在远小于 30s 内结束(慢工具被超时中止,没等满) (' + elapsed + 'ms)');

    const slowTool = events.find(e => e.type === 'tool_use' && e.name === 'fake__slow_task');
    ok(!!slowTool, '① fake__slow_task 被调用');
    const slowResult = events.find(e => e.type === 'tool_result' && slowTool && e.id === slowTool.id);
    const slowText = JSON.stringify((slowResult && slowResult.content) || '');
    ok(!!slowResult && /timed out|超时/.test(slowText), 'A1 ①的工具结果为超时错误 (got ' + slowText.slice(0, 120) + ')');
    ok(/桥接进程树已终止/.test(slowText), 'A2 错误文本如实告知"桥接进程树已终止"(无僵尸执行)');

    // B: cancelled 通知(可能在进程被杀前落盘 —— 通知先于 kill 发出)
    let notifyLines = [];
    for (let i = 0; i < 20 && !notifyLines.length; i++) {
      await sleep(200);
      if (fs.existsSync(NOTIFY_CAPTURE)) notifyLines = fs.readFileSync(NOTIFY_CAPTURE, 'utf8').split(/\r?\n/).filter(Boolean);
    }
    const cancelled = notifyLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .find(m => m.method === 'notifications/cancelled');
    ok(!!cancelled, 'B1 fake-mcp 收到 notifications/cancelled');
    ok(!!cancelled && Number.isFinite(cancelled.params && cancelled.params.requestId), 'B2 cancelled 带数字 requestId(MCP 标准形)');
    ok(!!cancelled && cancelled.params && cancelled.params.reason === 'timeout', 'B3 cancelled reason=timeout');

    // C: pid 日志一行一个(首个=被杀的旧客户端,末个=重连的新客户端)。
    const pids = fs.existsSync(PID_CAPTURE) ? fs.readFileSync(PID_CAPTURE, 'utf8').split(/\r?\n/).filter(Boolean).map(Number) : [];
    ok(pids.length === 2, 'C0 fake-mcp 先后两个 pid(被杀 + 重连) (got ' + pids.join(',') + ')');
    const firstPid = pids[0] || 0;
    let firstAlive = true;
    for (let i = 0; i < 30 && firstAlive; i++) { await sleep(300); firstAlive = pidAlive(firstPid); }
    ok(firstPid > 0 && !firstAlive, 'C1 超时后旧 fake-mcp 进程树被杀(tasklist 查不到 pid ' + firstPid + ')');
    ok(pids.length === 2 && pidAlive(pids[1]), 'C2 重连的新 fake-mcp 活着(pid ' + (pids[1] || 0) + ',回合并发期间应在线)');

    // D: echo 成功(新客户端重连)
    const echoTool = events.find(e => e.type === 'tool_use' && e.name === 'fake__echo');
    ok(!!echoTool, '② fake__echo 被调用(超时杀后的下一次调用)');
    const echoResult = events.find(e => e.type === 'tool_result' && echoTool && e.id === echoTool.id);
    const echoText = JSON.stringify((echoResult && echoResult.content) || '');
    ok(!!echoResult && /alive-after-kill/.test(echoText), 'D1 ②的 echo 成功 —— 新客户端惰性重连恢复服务 (got ' + echoText.slice(0, 100) + ')');
    const turnSummary = events.find(e => e.type === 'turn_summary');
    ok(!!turnSummary, '回合正常收尾(turn_summary 在)');
  } catch (e) { console.error('ERROR ' + (e && e.stack || e)); failures++; }
  finally {
    kill(wb); kill(fakeProvider);
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nBRIDGE CANCEL/TIMEOUT E2E: ' + (failures ? `FAIL (${failures})` : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error(e.stack || e); process.exitCode = 1; });
