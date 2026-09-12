require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(121 波 K0b):投影索引的空目录守卫必须长在 getPretenderProjectionIndex() 本身,而不是只长在
// warmPretenderProjectionIndex() 那一次 boot 预热里。
//
// 病根(K0 执行者实测,见 121-K0b 报告 / src/13e-pretender-index.js buildOrLoadPretenderIndex):
// 管家默认开(121-K0)之后,服务一起来第一拍收件箱 tick(13i-steward-inbox.js stewardCollectEvents)
// 就直接调 getPretenderProjectionIndex(),完全绕过 warm 那道「目录里没有 sess_* 就不建索引」的守卫。
// 若 sessions 目录此刻确实是空的(外部导入/多进程写入/本仓夹具都在 boot 之后才把会话物化到盘上),
// 这次调用会把一份【空】投影索引建出来、落盘、缓存为「已建」——下一次调用只看 diskStamp 没变就直接
// 信任这份空索引,再也不会重新扫描 sessions 目录,GET /api/missions 从此永远读到 0 行。
//
// 本件复现的正是这条时间线:起服务(stewardEnabledV1:true、stewardPollMs 钳到最小值 5000ms,
// 让 tick 尽快先跑一拍)→ 等第一拍 tick 真的跑完(/api/steward/state.lastTickAt 从空变非空,此时
// sessions 目录确实一份 sess_* 都没有,tick 已经在这个窗口里调过 getPretenderProjectionIndex)→
// 再把两条 mission 会话文件写进 sessions 目录(造法照 pretender-index-scale.e2e.js 的
// seedScaleDataset)→ GET /api/missions 必须返回 2 行。
//
// 反向验证见文末 REVERSE VERIFICATION 注释块:把 13e-pretender-index.js 里新加的空目录早退分支
// 临时改成 `if (false && ...)` 后单跑本件,必须 FAIL(page.total === 0);跑完照原样改回来。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-mission-index-late-121k0b-e2e');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(child) { if (child && child.pid) { try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
function runtimeToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function request(pathname, token, opts = {}) {
  return new Promise((resolve, reject) => {
    const raw = opts.body == null ? '' : JSON.stringify(opts.body);
    const req = http.request({ host: '127.0.0.1', port: opts.port, path: pathname, method: opts.method || (raw ? 'POST' : 'GET'), headers: {
      ...(token ? { 'x-wcw-token': token } : {}),
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(opts.headers || {}),
    } }, res => {
      let text = '';
      res.on('data', c => text += c);
      res.on('end', () => { let body = null; try { body = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, body, text }); });
    });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitHealth(port) { // 117q:80×100ms=8s 余量过窄是「FAIL workbench up」假红的根(30号文 P1-31),沿用 300×100ms
  for (let i = 0; i < 300; i++) { const r = await request('/health', '', { port }).catch(() => null); if (r && r.status === 200) return true; await sleep(100); }
  return false;
}
async function waitToken() { // 117q-P1-33:runtime.json 落盘晚于 /health 200(13-http-router.js:1619 vs :1777)
  for (let i = 0; i < 300; i++) { const t = runtimeToken(); if (t) return t; await sleep(100); } return runtimeToken(); }

function sessionId(i) { return 'sess_late_' + String(i).padStart(3, '0'); }
function iso(i) { return new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(); }

function seedTwoMissions() {
  const sessionsDir = path.join(HOME, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (let i = 0; i < 2; i++) {
    const sid = sessionId(i), stamp = iso(i);
    const head = {
      schemaVersion: 4, storageVersion: 2, id: sid, missionId: sid, kind: 'mission',
      title: 'Late mission ' + i, summary: '', cwd: ROOT, pinned: false,
      createdAt: stamp, updatedAt: stamp, turnSeq: i, messageCount: 0, providerHistoryCount: 0,
      mission: {
        goal: 'Late-materialized mission ' + i, createdAt: stamp, updatedAt: stamp,
        autoMode: 'off', changeSeq: i,
        milestones: [{ id: 'm1', desc: 'late item', status: 'pending', evidence: '', check: null }],
        budget: { maxAutoTurns: 10, maxTokens: 100000 }, spent: { autoTurns: 0, tokens: 0 },
        stall: { lastSignature: '', sameCount: 0 }, result: null,
      },
    };
    fs.writeFileSync(path.join(sessionsDir, sid + '.json'), JSON.stringify(head), 'utf8');
    fs.writeFileSync(path.join(sessionsDir, sid + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(sessionsDir, sid + '.provider.ndjson'), '', 'utf8');
  }
}

const WB_PORT = await getFreePort();
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
// stewardEnabledV1:true(121-K0 默认值,此处显式写出以自证)+ stewardPollMs 钳到 13i 允许的最小值
// 5000ms,让第一拍 tick 尽早跑(它在 14-main.js 里是 startServer 之后【同步 await】的,/health 200
// 不蕴含这一拍已经跑完 —— 下面用 /api/steward/state.lastTickAt 显式等它跑完,而不是猜时间)。
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, includeWorkbenchMcp: false, stewardEnabledV1: true, stewardPollMs: 5000 }), 'utf8');
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, RUYI_TEST_HOOKS: '1' }, windowsHide: true });
let stderr = ''; wb.stderr.on('data', d => stderr += String(d));

try {
  ok(await waitHealth(WB_PORT), 'workbench up');
  const token = await waitToken(); ok(!!token, 'runtime token');

  // 此刻 sessions 目录必须还是空的(还没造数据)——这就是病根打开的那扇窗口:第一拍 tick 会撞上一个
  // 真·空目录,而不是我们后面刻意造出来的巧合。
  let filesBeforeSeed = [];
  try { filesBeforeSeed = fs.readdirSync(path.join(HOME, 'sessions')); } catch {}
  ok(!filesBeforeSeed.some(f => /^sess_/.test(f)), 'sessions 目录起初确实为空(未造数据)');

  // 显式等第一拍 tick 跑完,而不是猜一个固定延迟 —— stewardRunTick 在 stewardCollectEvents 里调
  // getPretenderProjectionIndex(),lastTickAt 从空变非空就证明那次调用已经发生过。
  let tickState = null;
  for (let i = 0; i < 100; i++) {
    tickState = await request('/api/steward/state', token, { port: WB_PORT }).catch(() => null);
    if (tickState && tickState.body && tickState.body.lastTickAt) break;
    await sleep(100);
  }
  ok(!!(tickState && tickState.body && tickState.body.lastTickAt), '管家第一拍 tick 已在空目录上跑完(lastTickAt 非空)');

  // 现在才把两条 mission 会话物化到盘上(照 pretender-index-scale.e2e.js 的造法,规模缩到 2 条)。
  seedTwoMissions();

  // 冷读 /api/missions:没有守卫的话,index 在上一步已经被建成空的并持久化,这里会稳定读到 0 行。
  let missions = null;
  for (let i = 0; i < 30; i++) {
    missions = await request('/api/missions?limit=10', token, { port: WB_PORT }).catch(() => null);
    if (missions && missions.body && missions.body.page && missions.body.page.total === 2) break;
    await sleep(200);
  }
  ok(!!missions && missions.status === 200, 'GET /api/missions 200');
  ok(!!missions && missions.body && missions.body.page && missions.body.page.total === 2, `GET /api/missions 必须看见迟到的 2 条 mission(实 total=${missions && missions.body && missions.body.page ? missions.body.page.total : 'n/a'})`);
  ok(!!missions && Array.isArray(missions.body.missions) && missions.body.missions.length === 2, 'missions 数组长度为 2');
  const gotIds = new Set((missions && missions.body && missions.body.missions || []).map(m => m.missionId));
  ok(gotIds.has(sessionId(0)) && gotIds.has(sessionId(1)), '两条 mission 的 id 都在(不是碰巧凑出 total=2)');

  const src = readServerSource();
  ok(/getPretenderProjectionIndex\(\)/.test(src) && /empty_sessions_dir/.test(src), '(静态锁)空目录守卫的判据字面量在编译产物里');
} finally {
  kill(wb); await sleep(250); fs.rmSync(HOME, { recursive: true, force: true });
}

console.log('\nMISSION INDEX LATE MATERIALIZE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });

// ────────────────────────────────────────────────────────────────────────────
// REVERSE VERIFICATION(121-K0b 报告要求逐条核):
//   1. 打开 ruyi-workbench/app/src/13e-pretender-index.js,把 buildOrLoadPretenderIndex() 里新加的
//      `if (currentDiskStamp === '-' && Object.keys(sources).length === 0) { return finalizePretenderIndex(...); }`
//      整行 if 的条件改成 `if (false && currentDiskStamp === '-' && Object.keys(sources).length === 0)`。
//   2. node ruyi-workbench/app/build.js(重生成 server.js)。
//   3. node dev-harness/mission-index-late-materialize.e2e.js —— 必须 FAIL,断在
//      「GET /api/missions 必须看见迟到的 2 条 mission」(实 total=0)。
//   4. 把条件改回原样,重跑 build.js,确认本件回到 ALL PASS。
// 这一步的实测记录见 121-K0b 报告正文,不在此脚本里自动跑(自动跑需要临时改源码并重跑生成器链,
// 与本仓「改一次源码、整条生成器链只在最后一次改动后跑一遍」的纪律冲突)。
// ────────────────────────────────────────────────────────────────────────────
