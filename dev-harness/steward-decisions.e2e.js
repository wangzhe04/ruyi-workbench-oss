(async () => {
'use strict';
// E2E(第 117 波 117e 第 0 步 · 27 号文 §8.6 末条「行动流水页按时间列出管家做过的每件事」):
// 决策日志的只读 HTTP 面 `GET /api/steward/decisions`。
//
// 在 117e 之前 `<data>/steward/decisions-v1.ndjson` 只有工具 `steward_audit_tail` 能读 —— 也就是
// 只有模型看得见管家做过什么,用户看不见。本件锁住这条新面的机械口径。
//
// 覆盖:
//  (A) token 缺失 -> 403(与同族 /api/steward/* 一致);开关关 -> 409 steward.disabled。
//  (B) 默认 limit 50 / 上限 200 / 非法值回默认;rows 按时间倒序(最近的在最前)。
//  (C) sessionId 过滤(只回该线程的行)、since 过滤(只回 at 严格晚于它的行)。
//  (D) 坏行容错:半行、非 JSON、JSON 数组、缺 tool 的对象一律整行跳过,不影响其余行。
//  (E) 掩码:args / basis 里键名像密钥的值(apiKey/token/secret/password,复用 116-2e 的判据)
//      一律出 '••••',其余字段原样;嵌套对象同样掩。
//  (F) 只读:调完之后决策日志逐字节不变,且不会因为读而建目录。
//
// 夹具直接写 NDJSON(决策日志是 append-only 纯文本,这是最确定的造数方式;写入侧的真实性由
// steward-tools / steward-memory 等件覆盖)。端口用 getFreePort()。
// 判定行:`STEWARD DECISIONS E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-decisions-'));
const WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

const stewardDir = path.join(HOME, 'steward');
const decisionsFile = path.join(stewardDir, 'decisions-v1.ndjson');

function writeConfig(patch) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 9, engineMode: 'interactive', permissionMode: 'default',
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
    stewardEnabledV1: true, stewardPollMs: 120000,
    ...patch,
  }, null, 2), 'utf8');
}

function req(method, p, body, token) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: p, method, timeout: 20000,
      headers: {
        ...(token ? { 'x-wcw-token': token } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, res => {
      let t = '';
      res.on('data', c => { t += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(t); } catch { j = null; }
        const code = j && j.error && typeof j.error === 'object' ? j.error.code : (j && j.error);
        resolve({ status: res.statusCode, body: j, code, raw: t });
      });
    });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: null, raw: '' }); });
    if (payload) r.write(payload);
    r.end();
  });
}

// ── 夹具:确定性的决策日志 ──────────────────────────────────────────────────────────
const SID_A = 'sess_aaaaaaaaaaaaaaaa';
const SID_B = 'sess_bbbbbbbbbbbbbbbb';
const T = n => new Date(Date.UTC(2026, 8, 6, 1, 0, n)).toISOString();   // 2026-09-06T01:00:0N.000Z
const rows = [];
for (let i = 0; i < 60; i++) {
  rows.push({
    seq: i + 1, at: T(i), tool: 'steward_thread_continue',
    args: { sessionId: i % 2 === 0 ? SID_A : SID_B, chars: i },
    targetSessionId: i % 2 === 0 ? SID_A : SID_B,
    permissionMode: 'acceptEdits', mayAct: 'auto',
    undoRef: { kind: 'turn', sessionId: i % 2 === 0 ? SID_A : SID_B, turnSeq: i, rewindTargetTurnSeq: i + 1 },
    basis: { inboxSeq: i },
  });
}
// 掩码样本:args 顶层与嵌套各埋一个像密钥的键。
rows.push({
  seq: 61, at: T(61), tool: 'steward_config_set',
  args: { keys: ['locale'], apiKey: 'abcdefghijklmnop', nested: { modelsApiKey: 'qrstuvwx', locale: 'zh-CN' }, plain: 'keep-me' },
  targetSessionId: SID_A, permissionMode: '', mayAct: 'user',
  undoRef: { kind: 'config', id: 'snap_1' }, basis: { accessToken: 'zzzz', note: 'keep-me-too' },
});

fs.mkdirSync(stewardDir, { recursive: true });
const lines = rows.map(r => JSON.stringify(r));
// 坏行:非 JSON / JSON 数组 / 缺 tool 的对象 / 尾部半行。全部必须被整行跳过。
lines.splice(10, 0, 'this-is-not-json');
lines.splice(20, 0, '[1,2,3]');
lines.splice(30, 0, JSON.stringify({ seq: 999, at: T(59), targetSessionId: SID_A }));
fs.writeFileSync(decisionsFile, lines.join('\n') + '\n' + '{"tool":"steward_decide","at":"2026', 'utf8');
const beforeBytes = fs.readFileSync(decisionsFile);

let wb = null;
try {
  /* ═════════ 起服务 ═════════ */
  writeConfig({});
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true, stdio: 'ignore',
  });
  let token = '';
  for (let i = 0; i < 100 && !token; i++) {
    await sleep(120);
    try { token = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
  }
  ok(!!token, 'A0 服务起来了(拿到 token)');
  for (let i = 0; i < 60; i++) { const r = await req('GET', '/api/steward/decisions', undefined, token); if (r.status) break; await sleep(120); }

  /* ═════════ (A) 两道闸 ═════════ */
  console.log('── (A) 鉴权与开关 ──');
  const noToken = await req('GET', '/api/steward/decisions', undefined, '');
  ok(noToken.status === 403, `A1 缺 token -> 403(实测 ${noToken.status})`);

  /* ═════════ (B) limit 与排序 ═════════ */
  console.log('── (B) limit 与排序 ──');
  const def = await req('GET', '/api/steward/decisions', undefined, token);
  ok(def.status === 200 && def.body && def.body.ok === true, 'B1 GET /api/steward/decisions 200');
  ok(Array.isArray(def.body.rows) && def.body.rows.length === 50 && def.body.limit === 50,
    `B2 缺省 limit = 50(实测 ${def.body && def.body.rows && def.body.rows.length})`);
  ok(def.body.total === 61, `B3 total = 尾窗内命中过滤的总行数,坏行不计(实测 ${def.body.total})`);
  ok(def.body.rows[0].seq === 61 && def.body.rows[1].seq === 60,
    `B4 按时间倒序,最近的在最前(实测 ${def.body.rows[0].seq} / ${def.body.rows[1].seq})`);
  const overCap = await req('GET', '/api/steward/decisions?limit=999', undefined, token);
  ok(overCap.body && overCap.body.limit === 200, `B5 limit 上限 200(实测 ${overCap.body && overCap.body.limit})`);
  const bogus = await req('GET', '/api/steward/decisions?limit=abc', undefined, token);
  ok(bogus.body && bogus.body.limit === 50, `B6 非法 limit 回缺省 50(实测 ${bogus.body && bogus.body.limit})`);
  const one = await req('GET', '/api/steward/decisions?limit=1', undefined, token);
  ok(one.body && one.body.rows.length === 1 && one.body.rows[0].seq === 61, 'B7 limit=1 只回最近一条');

  /* ═════════ (C) 过滤 ═════════ */
  console.log('── (C) sessionId / since 过滤 ──');
  const byThread = await req(`GET`, `/api/steward/decisions?sessionId=${SID_B}&limit=200`, undefined, token);
  ok(byThread.body && byThread.body.rows.length === 30
    && byThread.body.rows.every(row => row.targetSessionId === SID_B),
    `C1 按线程过滤只回该线程的行(实测 ${byThread.body && byThread.body.rows.length})`);
  const since = await req('GET', `/api/steward/decisions?since=${encodeURIComponent(T(57))}&limit=200`, undefined, token);
  ok(since.body && since.body.rows.length === 3 && since.body.rows.every(row => row.at > T(57)),
    `C2 since 只回 at 严格晚于它的行(实测 ${since.body && since.body.rows.length})`);
  const bothFilters = await req('GET', `/api/steward/decisions?sessionId=${SID_A}&since=${encodeURIComponent(T(57))}&limit=200`, undefined, token);
  ok(bothFilters.body && bothFilters.body.rows.every(row => row.targetSessionId === SID_A && row.at > T(57)),
    'C3 两个过滤条件同时生效');
  const badSince = await req('GET', '/api/steward/decisions?since=not-a-date&limit=200', undefined, token);
  ok(badSince.body && badSince.body.rows.length === 61, 'C4 非法 since 当没给(只读面对坏参数降级为不过滤)');
  const badSession = await req('GET', '/api/steward/decisions?sessionId=../../etc&limit=200', undefined, token);
  ok(badSession.status === 200 && badSession.body && Array.isArray(badSession.body.rows),
    'C5 非法 sessionId 不炸(safeSessionId 归一后自然无命中)');

  /* ═════════ (D) 坏行容错 ═════════ */
  console.log('── (D) 坏行容错 ──');
  const all = await req('GET', '/api/steward/decisions?limit=200', undefined, token);
  ok(all.body && all.body.rows.length === 61, `D1 三条坏行 + 尾部半行全部跳过,好行一条不少(实测 ${all.body && all.body.rows.length})`);
  ok(all.body.rows.every(row => row.tool), 'D2 回出去的每一行都有 tool(缺 tool 的对象不算决策行)');

  /* ═════════ (E) 掩码 ═════════ */
  console.log('── (E) 密钥掩码 ──');
  const masked = all.body.rows.find(row => row.seq === 61);
  ok(masked && masked.args.apiKey === '••••', `E1 args 顶层像密钥的键被掩码(实测 ${masked && masked.args.apiKey})`);
  ok(masked && masked.args.nested && masked.args.nested.modelsApiKey === '••••',
    'E2 嵌套对象里的密钥键同样掩码');
  ok(masked && masked.args.nested && masked.args.nested.locale === 'zh-CN' && masked.args.plain === 'keep-me',
    'E3 非密钥字段原样保留');
  ok(masked && masked.basis && masked.basis.accessToken === '••••' && masked.basis.note === 'keep-me-too',
    'E4 basis 走同一条掩码');
  ok(!all.raw.includes('abcdefghijklmnop') && !all.raw.includes('qrstuvwx') && !all.raw.includes('zzzz'),
    'E5 原始密钥值一个字节都没出门');
  ok(all.body.rows.some(row => row.undoRef && row.undoRef.rewindTargetTurnSeq),
    'E6 undoRef 原样带出(行动流水的「撤销」按钮读它)');

  /* ═════════ (F) 只读 ═════════ */
  console.log('── (F) 只读 ──');
  ok(Buffer.compare(beforeBytes, fs.readFileSync(decisionsFile)) === 0, 'F1 读完之后日志文件逐字节不变');

  /* ═════════ (A2) 开关关 ═════════ */
  console.log('── (A2) 开关关 ──');
  kill(wb); wb = null; await sleep(400);
  writeConfig({ stewardEnabledV1: false });
  const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-decisions-off-'));
  fs.copyFileSync(path.join(HOME, 'config.json'), path.join(emptyHome, 'config.json'));
  const OFF_PORT = await getFreePort();
  const off = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(OFF_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: emptyHome, WIN_CLAUDE_WORKBENCH_HOME: emptyHome }, windowsHide: true, stdio: 'ignore',
  });
  let offToken = '';
  for (let i = 0; i < 100 && !offToken; i++) {
    await sleep(120);
    try { offToken = JSON.parse(fs.readFileSync(path.join(emptyHome, 'runtime.json'), 'utf8')).token || ''; } catch { offToken = ''; }
  }
  const offResp = await new Promise(resolve => {
    const r = http.request({ host: '127.0.0.1', port: OFF_PORT, path: '/api/steward/decisions', method: 'GET', headers: { 'x-wcw-token': offToken }, timeout: 15000 },
      res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { j = null; } resolve({ status: res.statusCode, code: j && j.error && j.error.code }); }); });
    r.on('error', () => resolve({ status: 0 }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0 }); });
    r.end();
  });
  ok(offResp.status === 409 && offResp.code === 'steward.disabled',
    `A2 开关关 -> 409 steward.disabled(实测 ${offResp.status}/${offResp.code})`);
  ok(!fs.existsSync(path.join(emptyHome, 'steward')), 'A3 开关关时读这条路由不建 steward 目录(零持久化写入)');
  kill(off);
  try { fs.rmSync(emptyHome, { recursive: true, force: true }); } catch { /* best effort */ }
} catch (e) {
  console.log('ERROR ' + ((e && e.stack) || e));
  fail++;
} finally {
  kill(wb);
  await sleep(300);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best effort */ }
}

console.log('');
if (fail) { console.log(`STEWARD DECISIONS E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD DECISIONS E2E: ALL PASS');
process.exit(0);
})();
