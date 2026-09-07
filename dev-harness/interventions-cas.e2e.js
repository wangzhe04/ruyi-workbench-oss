(async () => {
'use strict';
// E2E(第75a波 切片二):Intervention CAS 原语 + 失败注入矩阵 + 崩溃恢复。
// 覆盖(SCHEMA §7):
//  (a) 无崩溃成功转换:pending -> applying -> allowed,version 0 -> 2(CAS expectedVersion=0 通过)。
//  (b) CAS 版本冲突:expectedVersion 不匹配当前 interventionVersion -> version_conflict,不转换。
//  (c) not_found:ivId 不存在 -> not_found。
//  (d) 失败注入六窗口(SCHEMA §7「写 applying 前/后、resolve 前/后、terminal 前/后」):
//      每窗口:seed pending -> 调 /api/_test/intervention-cas 带 crashAt -> 验证磁盘停在对应状态 ->
//      重启 wb -> boot markInterruptedInterventions 验证恢复:
//        before_applying (pending) -> cancelled_restart;
//        after_applying/before_resolve/after_resolve/before_terminal (applying) -> indeterminate;
//        after_terminal (terminal) -> 不变(已终态,boot 不动)。
//  (e) 静态锁:transitionInterventionState / INTERVENTION_TERMINAL / indeterminate / test 端点在 server.js。
// 测试端点 /api/_test/intervention-cas 由 RUYI_TEST_HOOKS=1 env 门控(生产 404)。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-cas-e2e');
const WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function requestJson(port, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body == null ? 'GET' : 'POST', headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitHealth(port) { for (let i = 0; i < 60; i++) { const r = await requestJson(port, '/health', null).catch(() => null); if (r && r.status === 200) return true; await sleep(100); } return false; }
function ivFile(sid) { return path.join(HOME, 'sessions', sid + '.interventions.ndjson'); }
// merge-fold 读(对齐 server readInterventions):后写胜但保留前行的 type/requestedAt;version = 行数-1。
function readIv(sid) {
  const byId = new Map(), rowCount = new Map();
  let txt; try { txt = fs.readFileSync(ivFile(sid), 'utf8'); } catch { return byId; }
  for (const line of txt.split('\n')) {
    if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || !r.id) continue;
    const id = String(r.id);
    rowCount.set(id, (rowCount.get(id) || 0) + 1);
    const prev = byId.get(id);
    byId.set(id, prev ? { ...prev, ...r } : r);
  }
  for (const rec of byId.values()) rec.interventionVersion = Math.max((rowCount.get(String(rec.id)) || 1) - 1, Number(rec.interventionVersion) || 0);
  return byId;
}
async function waitForIv(sid, id, status, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 3000)) {
    const r = readIv(sid).get(String(id));
    if (r && (!status || r.status === status)) return r;
    await sleep(50);
  }
  return readIv(sid).get(String(id)) || null;
}
function resetIv(sid) { try { fs.writeFileSync(ivFile(sid), '', 'utf8'); } catch {} }
function seedPending(sid, ivId) {
  const rec = { id: ivId, type: 'permission', sessionId: sid, status: 'pending', requestedAt: new Date().toISOString(), decidedAt: '', decidedBy: '', interventionVersion: 0, toolName: 'Bash', tier: 'exec', revertible: false };
  fs.writeFileSync(ivFile(sid), JSON.stringify(rec) + '\n', 'utf8');
}
function spawnWb() {
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, RUYI_TEST_HOOKS: '1' }, windowsHide: true });
}
async function cas(token, sid, ivId, expectedVersion, toStatus, crashAt, source) {
  const body = { sessionId: sid, ivId, expectedVersion, toStatus };
  if (crashAt) body.crashAt = crashAt;
  if (source) body.source = source; // 116c: 省略即沿用默认 'test'(既有用例逐字节不变)
  return requestJson(WB_PORT, '/api/_test/intervention-cas', body, token);
}

(async () => {
  const src = readServerSource();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    // 116-5a:本件隔离回合/工具/台账,不测线程自动摘要(它有自己的 thread-brief.e2e.js)
    stewardThreadBriefV1: false,
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'bypass', includeWorkbenchMcp: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }), 'utf8');
  let wb = spawnWb(); wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));

  try {
    ok(await waitHealth(WB_PORT), 'workbench up (RUYI_TEST_HOOKS=1)');
    let token = readToken(); ok(!!token, 'runtime token');
    const sess = await requestJson(WB_PORT, '/api/sessions', { title: 'cas test' }, token);
    ok(sess.status === 200 && sess.json?.session?.id, 'POST /api/sessions 创建会话');
    const sid = sess.json.session.id;

    // ============ (a) 无崩溃成功转换 ============
    resetIv(sid); seedPending(sid, 'cas_ok');
    let r = await cas(token, sid, 'cas_ok', 0, 'allowed', null);
    ok(r.status === 200 && r.json?.ok === true && r.json?.status === 'allowed' && r.json?.interventionVersion === 2, '(a) 无崩溃:pending->allowed,v0->v2');
    let iv = readIv(sid).get('cas_ok');
    ok(!!iv && iv.status === 'allowed' && iv.type === 'permission' && Number(iv.interventionVersion) === 2, '(a) 磁盘:allowed + type 保留 + v2');

    // ============ (b) CAS 版本冲突 ============
    resetIv(sid); seedPending(sid, 'cas_vc');
    r = await cas(token, sid, 'cas_vc', 99, 'allowed', null); // curVer=0, expected=99
    ok(r.status === 200 && r.json?.ok === false && r.json?.reason === 'version_conflict', '(b) CAS:expectedVersion 不匹配 -> version_conflict');
    iv = readIv(sid).get('cas_vc');
    ok(!!iv && iv.status === 'pending', '(b) 版本冲突不转换(仍 pending)');

    // ============ (c) not_found ============
    r = await cas(token, sid, 'nonexistent_iv', 0, 'allowed', null);
    ok(r.status === 200 && r.json?.ok === false && r.json?.reason === 'not_found', '(c) not_found:ivId 不存在');

    // ============ (d) 失败注入六窗口 ============
    const WINDOWS = [
      ['before_applying', 'pending', 'cancelled_restart'],     // 写 applying 前 -> 磁盘 pending -> 重启 cancelled_restart
      ['after_applying', 'applying', 'indeterminate'],          // 写 applying 后 -> 磁盘 applying -> 重启 indeterminate
      ['before_resolve', 'applying', 'indeterminate'],          // resolve 前 -> 磁盘 applying -> 重启 indeterminate
      ['after_resolve', 'applying', 'indeterminate'],           // resolve 后 -> 磁盘 applying -> 重启 indeterminate
      ['before_terminal', 'applying', 'indeterminate'],        // 写 terminal 前 -> 磁盘 applying -> 重启 indeterminate
      ['after_terminal', 'allowed', 'allowed'],                 // 写 terminal 后 -> 磁盘 terminal -> 重启不变(已终态)
    ];
    for (const [at, diskStatus, recoveryStatus] of WINDOWS) {
      const ivId = 'cas_' + at;
      resetIv(sid); seedPending(sid, ivId);
      r = await cas(token, sid, ivId, 0, 'allowed', at);
      ok(r.status === 200 && r.json?.ok === false && r.json?.reason === 'crash' && r.json?.at === at, `(d) ${at}:crash 响应`);
      iv = readIv(sid).get(ivId);
      ok(!!iv && iv.status === diskStatus, `(d) ${at}:磁盘停在 ${diskStatus}(version=${iv && iv.interventionVersion})`);
      // 重启 -> boot markInterruptedInterventions 恢复
      kill(wb); await sleep(400);
      wb = spawnWb(); wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
      ok(await waitHealth(WB_PORT), `(d) ${at}:workbench 重启 up`);
      token = readToken();
      const recovered = await waitForIv(sid, ivId, recoveryStatus, 3000);
      ok(!!recovered && recovered.status === recoveryStatus, `(d) ${at}:重启恢复 -> ${recoveryStatus}(实际 ${recovered && recovered.status})`);
    }

    // ============ (f) 116c: source:'steward'(管家代答)三条路径 ============
    // 管家的决定与用户的决定共用同一套 CAS 与同一条落盘格式,唯一区别是 source 标签 —— 这三条用例
    // 证明「管家来源」既不走捷径(版本冲突照样冲突)、也不被特殊对待(成功路径与 'test' 同形)。
    console.log('\n── [f] source:steward ──');
    resetIv(sid); seedPending(sid, 'stew_ok');
    r = await cas(token, sid, 'stew_ok', 0, 'allowed', null, 'steward');
    ok(r.status === 200 && r.json?.ok === true && r.json?.status === 'allowed' && r.json?.interventionVersion === 2,
      "(f1) 成功:source:'steward' 的 pending->allowed 与用户来源同形(v0->v2)");
    iv = readIv(sid).get('stew_ok');
    ok(!!iv && iv.status === 'allowed' && iv.source === 'steward', "(f1) 磁盘终态行带 source:'steward'(事后可追责到管家)");

    resetIv(sid); seedPending(sid, 'stew_vc');
    r = await cas(token, sid, 'stew_vc', 7, 'allowed', null, 'steward');
    ok(r.status === 200 && r.json?.ok === false && r.json?.reason === 'version_conflict',
      "(f2) 版本冲突:管家来源不绕过 CAS -> version_conflict");
    iv = readIv(sid).get('stew_vc');
    ok(!!iv && iv.status === 'pending' && !iv.source, '(f2) 版本冲突不转换、不留 source 痕迹(仍 pending)');

    r = await cas(token, sid, 'stew_vc', 0, 'allowed', null, 'steward');
    ok(r.status === 200 && r.json?.ok === true, '(f3) 越权前置:同一条待决先由管家决掉');
    r = await cas(token, sid, 'stew_vc', 2, 'denied', null, 'steward');
    ok(r.status === 200 && r.json?.ok === false && r.json?.reason === 'already_terminal',
      '(f3) 越权:已终态的待决管家再决一次 -> already_terminal(不得改写用户已定的事)');
    const noToken = await requestJson(WB_PORT, '/api/_test/intervention-cas', { sessionId: sid, ivId: 'stew_vc', expectedVersion: 0, toStatus: 'allowed', source: 'steward' }, '');
    ok(noToken.status === 403, '(f3) 越权:无 token 的 steward 决策请求 -> 403(鉴权在管家之前)');

    // ============ (e) 静态锁 ============
    console.log('\n── [e] 静态锁 ──');
    ok(/async function transitionInterventionState\(sessionId, ivId, expectedVersion, toStatus, opts = \{\}\)/.test(src), 'e 02 有 transitionInterventionState(CAS 原语)');
    ok(/const INTERVENTION_TERMINAL = new Set\(\[/.test(src) && /'indeterminate'/.test(src), 'e 02 INTERVENTION_TERMINAL 含 indeterminate');
    ok(/interventionTransitionLocks/.test(src), 'e 02 per-ivId 串行锁 interventionTransitionLocks');
    ok(/'__cas_crash:before_applying'/.test(src) && /'__cas_crash:after_terminal'/.test(src), 'e 02 失败注入六窗口 crashAt 钩子');
    ok(/api\/_test\/intervention-cas/.test(src) && /RUYI_TEST_HOOKS/.test(src), 'e 13d 测试端点 + RUYI_TEST_HOOKS env 门控');
    ok(/\{ m: 'POST', p: '\/api\/_test\/intervention-cas', auth: 'token' \}/.test(src), 'e 01-config ROUTE_AUTH 测试端点 token 级');
    ok(/status: 'indeterminate'/.test(src), 'e 02 markInterruptedInterventions applying->indeterminate 恢复');
    // 116c: 管家来源的审计标签必须自成一档 —— 「谁按的这个批准」是事后解释与撤销的第一现场。
    ok(/source === 'steward' \? 'steward_decision'/.test(src), "e 13d 审计标签 switch 有 source==='steward' -> 'steward_decision' 分支");
    ok(/source: String\(opts\.source \|\| 'contract'\)/.test(src), "e 02 transitionInterventionState 把 source 原样写进 applying/terminal 行");
    ok(/function stewardMayAct\(permissionMode, eventKind, toolTier\)/.test(src), 'e 06i 管家放行范围经 stewardMayAct 真值表(管家自身无档位)');

  } finally {
    kill(wb); await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nINTERVENTIONS CAS E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
})();
