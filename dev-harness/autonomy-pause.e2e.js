// E2E: 第27f波「权限超时→存档暂停」(AUTONOMY-PLAN §27 §6 / 红队 R2-R4)。无端口(源抽取 + 静态锁,离线 Node 直跑)。
// [P] 源抽取 requestNativePermission 实跑两段定时:无 pause→基础超时 deny;pause→基础超时发 permission_paused+onPause+延长到 TTL→回落 deny;
//     窗口内经 /api/permission/decision(直接 resolve entry)→按决定返回。
// [S] 静态锁:config 默认 opt-in false + TTL clamp;provider gate 仅 driverAuto 启用;CLI 桥仅 driverAutoSessions;两路径 fail-closed deny。
'use strict';
const fs = require('fs'), path = require('path');
const SERVER = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [S] 静态锁
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [S] 静态锁 ──');
ok(/autonomyPauseOnTimeout: false,/.test(src), 'S config 默认 autonomyPauseOnTimeout=false(opt-in,安全默认零行为变化)');
ok(/autonomyPauseTtlMs: 2700000,/.test(src), 'S config 默认 TTL 45min');
ok(/config\.autonomyPauseOnTimeout = config\.autonomyPauseOnTimeout === true;/.test(src), 'S normalizeConfig 布尔规整');
ok(/config\.autonomyPauseTtlMs = Number\.isFinite\(apt\) \? Math\.min\(6 \* 3600000, Math\.max\(300000, apt\)\)/.test(src), 'S TTL clamp [5min,6h]');
ok(/\(config\.autonomyPauseOnTimeout && driverAuto\) \? \{/.test(src), 'S provider gate 仅【opt-in + driverAuto 无人值守】启用');
ok(/const cliPause = config\.autonomyPauseOnTimeout && driverAutoSessions\.has\(sessionId\);/.test(src), 'S CLI 桥仅【opt-in + driverAutoSessions】启用');
ok(/if \(driverAuto\) driverAutoSessions\.add\(session\.id\);/.test(src) && /if \(driverAuto\) driverAutoSessions\.delete\(session\.id\);/.test(src), 'S runTurn 维护 driverAutoSessions(进出平衡)');
// fail-closed:两处 pause 分支的 TTL 定时器都 resolve deny(pausedTimeout)。
ok((src.match(/resolve\(\{ behavior: 'deny', message: '权限已存档暂停但在时限内无人决定,已回落拒绝', pausedTimeout: true \}\)/g) || []).length >= 2, 'S 两引擎路径 TTL 到点均 fail-closed deny(pausedTimeout)');
// 对抗轮 P2:两引擎 idle 看门狗都在暂停期间豁免(否则 idle 会在 TTL 内先杀回合/子进程,provider 还会 abort 中毒 ctrl 令窗口内批准失效)。
ok((src.match(/if \(reg\.exited \|\| reg\.pausePending\) return;/g) || []).length >= 2, 'S 两引擎 idle 看门狗暂停期间豁免(reg.exited||reg.pausePending)');
ok((src.match(/pausePending: false,/g) || []).length >= 2, 'S 两引擎 reg 都带 pausePending 字段');
ok(/onPause: rid => \{ reg\.pausePending = true;/.test(src), 'S provider onPause 置 pausePending');
ok(/reg\.pausePending = false; \/\/ 决定\/TTL-deny/.test(src) || /reg\.pausePending = false;.*解除暂停豁免/.test(src), 'S provider await 返回后解除豁免');
ok(/if \(reg\) reg\.pausePending = true;/.test(src) && /if \(reg\) \{ reg\.pausePending = false; reg\.lastEventAt = Date\.now\(\); \}/.test(src), 'S CLI 桥置/解除 pausePending + 重置看门狗时钟');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [P] 源抽取 requestNativePermission 两段定时实跑
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [P] requestNativePermission 两段定时 ──');
const m = src.match(/function requestNativePermission\(sessionId, toolName, input, onEvent, timeoutMs, tier, pause\) \{[\s\S]*?\n\}/);
ok(!!m, 'P 源抽取 requestNativePermission(含 pause 形参)');
const pending = new Map();
let idc = 0; const makeId = p => p + '_' + (++idc);
const toolIsRevertible = () => false;
// 注入【可控 fake setTimeout/clearTimeout】—— clamp 把基础超时夹到 ≥5s、TTL ≥60s,实时等不现实;用假定时器手动触发,确定性且瞬时。
let timers = [];
const setTimeoutF = (cb, ms) => { const t = { cb, ms, cleared: false }; timers.push(t); return t; };
const clearTimeoutF = t => { if (t) t.cleared = true; };
const fireNext = () => { const live = timers.filter(x => !x.cleared).sort((a, b) => a.ms - b.ms); if (live[0]) { live[0].cleared = true; live[0].cb(); return true; } return false; };
const requestNativePermission = new Function('makeId', 'toolIsRevertible', 'pendingPermissions', 'setTimeout', 'clearTimeout',
  m[0] + '\nreturn requestNativePermission;')(makeId, toolIsRevertible, pending, setTimeoutF, clearTimeoutF);

(async () => {
  const settle = p => Promise.race([p, sleep(0).then(() => '__pending__')]);
  // (1) 无 pause:基础超时 → deny。
  {
    timers = []; const events = [];
    const p = requestNativePermission('s1', 'powershell_run', {}, e => events.push(e), 120000, 'exec', null);
    fireNext(); // 基础超时
    const d = await p;
    ok(d.behavior === 'deny' && !d.pausedTimeout, 'P(1) 无 pause:基础超时→deny(非 pausedTimeout)');
    ok(events.some(e => e.type === 'permission_request') && !events.some(e => e.type === 'permission_paused'), 'P(1) 只发 permission_request,不发 permission_paused');
  }
  // (2) pause 启用:基础超时→发 permission_paused + onPause;延长到 TTL→回落 deny(pausedTimeout)。
  {
    timers = []; const events = []; let paused = 0;
    const p = requestNativePermission('s2', 'powershell_run', {}, e => events.push(e), 120000, 'exec', { enabled: true, ttlMs: 2700000, onPause: () => { paused++; } });
    fireNext(); // 基础超时 → 进 pause 分支(同步:onPause + emit + 注册 TTL 定时器)
    ok(events.some(e => e.type === 'permission_paused') && paused === 1, 'P(2) 基础超时→发 permission_paused + onPause 检查点(1 次)');
    ok((await settle(p)) === '__pending__', 'P(2) pause 窗口内 promise 仍挂起(未 resolve)');
    fireNext(); // TTL 到点
    const d = await p;
    ok(d.behavior === 'deny' && d.pausedTimeout === true, 'P(2) TTL 无人决定→回落 deny(pausedTimeout)');
  }
  // (3) pause 窗口内决定(模拟 /api/permission/decision:取 entry 直接 resolve allow),不被 TTL 覆盖。
  {
    timers = []; const events = [];
    const p = requestNativePermission('s3', 'file_write', { path: 'a' }, e => events.push(e), 120000, 'edit', { enabled: true, ttlMs: 2700000, onPause: () => {} });
    fireNext(); // 进 pause 窗口(TTL 定时器已注册但未触发)
    const rid = events.find(e => e.type === 'permission_request').requestId;
    const entry = pending.get(rid);
    ok(!!entry, 'P(3) pending 有该 requestId 条目');
    clearTimeoutF(entry.timer); pending.delete(rid); entry.resolve({ behavior: 'allow', updatedInput: { path: 'b' } }); // 模拟 UI 决定
    const d = await p;
    ok(d.behavior === 'allow' && d.updatedInput.path === 'b', 'P(3) pause 窗口内 UI 决定 allow→按决定返回(不被 TTL 覆盖)');
  }
  // (4) 基础超时前决定(pause 启用但用户很快决定)→ 不进 pause 窗口,不发 permission_paused。
  {
    timers = []; const events = [];
    const p = requestNativePermission('s4', 'powershell_run', {}, e => events.push(e), 120000, 'exec', { enabled: true, ttlMs: 2700000, onPause: () => {} });
    const rid = events.find(e => e.type === 'permission_request').requestId;
    const entry = pending.get(rid); clearTimeoutF(entry.timer); pending.delete(rid); entry.resolve({ behavior: 'deny', message: 'user denied' }); // 基础超时前决定
    const d = await p;
    ok(d.behavior === 'deny' && !events.some(e => e.type === 'permission_paused'), 'P(4) 基础超时前决定→不进 pause 窗口(无 permission_paused)');
  }

  console.log('');
  if (fail) { console.log('AUTONOMY-PAUSE E2E: FAIL (' + fail + ')'); process.exit(1); }
  console.log('AUTONOMY-PAUSE E2E: ALL PASS');
})();
