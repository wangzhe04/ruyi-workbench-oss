#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注);本件还会显式再指一次自己的临时家
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// steward-delegation-latency-live.js — 107 波 E1:**真管家模型**下的代批端到端延迟(LIVE,真 API)
//
//   node --require ./dev-harness/lib/fixture-home-guard.js dev-harness/steward-delegation-latency-live.js \
//        [--repeats=3] [--poll-ms=5000] [--factory-repeats=2] [--out=<json>] [--budget-cny=6]
//
// ── 为什么要这一件 ──────────────────────────────────────────────────────────────────────
// 45 号文 §9.6.5 (d) 的真模型代批延迟只有**一个样本**:37.0 s(其中两次管家模型调用 31.5 s),
// 对照 `permissionTimeoutMs` 120 s。一个样本说不了「离超时有多少余量」。
// `steward-exempt-delegation.e2e.js` 的 R 段有 7+8 个样本(12.5–17.6 s),但那是**假管家**,
// 量到的几乎全是 15 s 轮询节拍,模型那一段是 0。本件补的就是中间那一块:**真管家模型 × 多次重复**。
//
// ── 怎么量(混合夹具,理由写清楚) ─────────────────────────────────────────────────────
//   * **线程那一头用进程内 fake provider**(照 `steward-exempt-delegation.e2e.js` 的 R 段):
//     脚本化地发 `powershell_run Remove-Item .\tmpN -Recurse`,于是**待决在哪一刻出现是确定的**,
//     每次重复的起点一模一样。线程用真模型的话,起点会随模型的啰嗦程度漂移几十秒 —— 那正是
//     §9.6.5 只拿到一个样本的原因,也让重复之间不可比。
//   * **管家那一头是真模型**(`stewardProviderId`/`stewardModel` 指到真 provider)。要量的就是它:
//     真收件箱轮询 → 真去抖 → 真管家回合(`steward_thread_status` → `steward_decide`)。
//   * 计时口径与 e2e 的 R 段**逐字相同**:待决行的 `requestedAt` → 终态行的 `decidedAt`
//     (只认 02 的 INTERVENTION_TERMINAL,读到中间的 `applying` 会早一拍)。
//   * 两档轮询各跑几次:`--poll-ms`(默认 5000 = 用户真机值,与 §9.6.5 那个 37.0 s 可比)与
//     15000(出厂值,存量用户拿到的)。每个实例各有自己的一小时窗口,`代批 6 次/小时`的闸
//     (`06i:516`)因此不会把重复吃掉。
//   * 危险命令只删本实例临时目录里的 `tmpN`,不推送、不关机。
//
// ── 与 E1 其余部分隔离口径的差别(一处,必须说明) ───────────────────────────────────────
//   本件**必须** `stewardEnabledV1:true`(要量的就是管家),所以它不遵守 E1 主脚本那条
//   「管家全关」。其余照旧:自己的临时数据家＋临时用户家、不抄真机任何数据、端口走 getFreePort
//   (用户自己的 8765 一次不碰)、收尾删掉带密钥的配置并复扫。
//
// 花费:每次代批 = 2–3 次真管家调用(§9.6.7 实测约 ¥0.054/回合),3+2 次约 ¥0.5;`--budget-cny` 是硬闸。
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const cp = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const REPEATS = Math.max(1, Number(arg('repeats', 3)) || 3);
const POLL_MS = Number(arg('poll-ms', 5000)) || 5000;
const FACTORY_REPEATS = Math.max(0, Number(arg('factory-repeats', 2)) || 0);
const MODEL = String(arg('model', 'deepseek-v4-flash'));
const PROVIDER_ID = String(arg('provider', 'deepseek'));
const BUDGET_CNY = Number(arg('budget-cny', 6)) || 6;
const OUT = arg('out', '');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const brief = v => String(JSON.stringify(v === undefined ? null : v)).slice(0, 300);
async function waitFor(pred, ms, step = 150) { const end = Date.now() + ms; for (;;) { const v = await pred(); if (v) return v; if (Date.now() > end) return null; await sleep(step); } }
const psQuote = p => "'" + String(p).replace(/'/g, "''") + "'";
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ } } }

const REAL_HOME = process.env.RUYI_REAL_HOME || os.homedir();
const realConfig = JSON.parse(fs.readFileSync(path.join(REAL_HOME, '.win-claude-workbench', 'config.json'), 'utf8'));
const realProvider = (realConfig.providers || []).find(p => p.id === PROVIDER_ID);
if (!realProvider || !realProvider.apiKey) { console.error('FATAL: 真机配置里没有带 key 的 provider ' + PROVIDER_ID); process.exit(2); }
const API_KEY = String(realProvider.apiKey);
const redactKey = s => String(s || '').split(API_KEY).join('«redacted»');

// ── 进程内 fake provider:只服务**线程**回合 ────────────────────────────────────────────
let PROVIDER_PORT = 0;
let threadScript = [];
const toolNamesOf = b => (Array.isArray(b && b.tools) ? b.tools : []).map(t => String((t && t.function && t.function.name) || t.name || ''));
async function startFakeProvider() {
  PROVIDER_PORT = await getFreePort();
  const server = http.createServer(async (req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); await new Promise(r => req.on('end', r));
    if (req.url.includes('/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] })); }
    let body = null; try { body = JSON.parse(raw); } catch { body = null; }
    const msgs = Array.isArray(body && body.messages) ? body.messages : [];
    const last = msgs.length ? msgs[msgs.length - 1] : null;
    const names = toolNamesOf(body);
    // 管家的工具表里有 steward_decide —— 管家绝不该打到这个假端点上(它走真 provider)。
    // 真打过来了就是配置没生效,记一行让读数里看得见。
    if (names.includes('steward_decide')) { stewardHitFake++; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const frame = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
    const lastIsTool = !!(last && last.role === 'tool');
    if (threadScript.length && names.length && (!last || last.role === 'user' || lastIsTool)) {
      const next = threadScript.shift();
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_' + Date.now() + '_' + Math.floor(Math.random() * 1e6), type: 'function', function: { name: next.name, arguments: '' } }] } }] });
      frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(next.args) } }] } }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      frame({ choices: [{ index: 0, delta: { content: '巡检做完了。' } }] });
      frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    res.write('data: [DONE]\n\n'); res.end();
  });
  await new Promise(r => server.listen(PROVIDER_PORT, '127.0.0.1', r));
  return server;
}
let stewardHitFake = 0;

// ── 一个真服务实例 ─────────────────────────────────────────────────────────────────────
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function reqJson(inst, method, p, payload, timeoutMs = 60000) {
  return new Promise(resolve => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const headers = { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(inst.TOKEN ? { 'x-wcw-token': inst.TOKEN } : {}) };
    const r = http.request({ host: '127.0.0.1', port: inst.PORT, path: p, method, headers, timeout: timeoutMs }, res => {
      let b = ''; res.on('data', c => (b += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { j = null; } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', () => resolve({ status: 0, json: null }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null }); });
    if (data) r.write(data);
    r.end();
  });
}
async function startInstance(tag, pollMs) {
  const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-e1-deleg-' + tag + '-'));
  const USER = path.join(HOME, 'user');
  const WORK = path.join(HOME, 'work');
  for (const d of [USER, WORK, path.join(USER, 'AppData', 'Local'), path.join(USER, 'AppData', 'Roaming')]) fs.mkdirSync(d, { recursive: true });
  const PORT = await getFreePort();
  if (PORT === 8765) { throw new Error('拿到 8765 —— 那是用户自己的实例,拒绝使用'); }
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: realConfig.configSchema || 11, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'auto', permissionTimeoutMs: 120000,
    includeWorkbenchMcp: false, defaultWorkspace: WORK, recentWorkspaces: [], workspaces: [{ path: WORK, label: 'e1' }],
    subagentMaxPerTurn: 0, killOnDisconnect: false, shellSessionMax: 3,
    autoImportClaudeCodeMcp: false, externalMcpServers: [], claudePath: '', killPortOnStart: false,
    allowDesktopTools: false, desktopMcp: false, schedulerEnabledV1: true,
    // 要量的就是管家 —— 这一件按设计把它打开(见头注「与 E1 其余部分隔离口径的差别」)。
    stewardEnabledV1: true, stewardThreadBriefV1: false, stewardPollMs: pollMs,
    stewardMaxTurnsPerHour: 500, stewardGlobalMaxTurnsPerHour: 500,
    stewardWorkspaceRoot: path.join(HOME, 'Ruyi'),
    stewardProviderId: PROVIDER_ID, stewardModel: MODEL,   // ← 真管家模型
    providers: [
      { id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + PROVIDER_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] },
      // `pricing` 必须一起抄过来:不抄的话 `computeProviderCost` 返回 null,账本行的 `cost` 是 0,
      // 「花了多少」这一栏就成了假绿。首轮就是这么栽的(实得 3 行账本、cost 全 0)。
      { id: PROVIDER_ID, label: realProvider.label || PROVIDER_ID, type: realProvider.type || 'openai-compat', baseUrl: realProvider.baseUrl, apiKey: API_KEY, model: MODEL, models: [{ id: MODEL, label: MODEL }], ...(realProvider.pricing ? { pricing: realProvider.pricing } : {}) },
    ],
  }, null, 2), 'utf8');
  const env = {
    ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME,
    USERPROFILE: USER, HOME: USER, LOCALAPPDATA: path.join(USER, 'AppData', 'Local'), APPDATA: path.join(USER, 'AppData', 'Roaming'),
    KIMI_CODE_HOME: path.join(USER, '.kimi-code'), WCW_KILL_PORT: '0', RUYI_REAL_HOME: REAL_HOME,
  };
  const proc = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env, windowsHide: true });
  proc.stdout.on('data', () => {});
  proc.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb-' + tag + '!] ' + redactKey(l.trim()).slice(0, 200))));
  const inst = { tag, HOME, USER, WORK, PORT, proc, TOKEN: '', pollMs, sessionsDir: path.join(HOME, 'sessions') };
  let up = null; for (let i = 0; i < 200 && !up; i++) { await sleep(150); up = await health(PORT); }
  inst.up = !!up;
  inst.TOKEN = await waitFor(() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }, 15000) || '';
  return inst;
}
function ivFold(inst, sid) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(inst.sessionsDir, sid + '.interventions.ndjson'), 'utf8').split(/\r?\n/).filter(l => l.trim()); } catch { lines = []; }
  const byId = new Map();
  for (const l of lines) { let row = null; try { row = JSON.parse(l); } catch { row = null; } if (row && row.id) byId.set(row.id, { ...(byId.get(row.id) || {}), ...row }); }
  return byId;
}
function firstRow(inst, sid, id) {
  try {
    for (const l of fs.readFileSync(path.join(inst.sessionsDir, sid + '.interventions.ndjson'), 'utf8').split(/\r?\n/)) {
      if (!l.trim()) continue; let row = null; try { row = JSON.parse(l); } catch { row = null; }
      if (row && row.id === id) return row;
    }
  } catch { /* 没有就是没有 */ }
  return null;
}
const TERMINAL = ['allowed', 'denied', 'answered', 'cancelled', 'approved', 'rejected', 'cancelled_restart', 'indeterminate', 'expired'];
async function waitPending(inst, sid, seen, ms) {
  return waitFor(() => {
    for (const row of ivFold(inst, sid).values()) {
      if (row.type === 'permission' && row.status === 'pending' && !seen.has(row.id)) { seen.add(row.id); return row; }
    }
    return null;
  }, ms);
}
async function waitSettled(inst, sid, id, ms) {
  return waitFor(() => { const row = ivFold(inst, sid).get(id); return row && TERMINAL.includes(row.status) ? row : null; }, ms);
}
function ledger(inst) {
  const out = [];
  let files = [];
  // 账本文件叫 `2026-09.jsonl`(**不是** .ndjson);首轮筛错扩展名 → 读到 0 行、花费报成 0。
  try { files = fs.readdirSync(path.join(inst.HOME, 'usage')).filter(f => /\.(jsonl|ndjson)$/.test(f)); } catch { files = []; }
  for (const f of files) {
    let text = ''; try { text = fs.readFileSync(path.join(inst.HOME, 'usage', f), 'utf8'); } catch { text = ''; }
    for (const l of text.split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* 半行 */ } }
  }
  return out;
}
function realSpend(inst) {
  const rows = ledger(inst).filter(r => String(r.provider || '') === PROVIDER_ID);
  return {
    rows: rows.length,
    inTok: rows.reduce((a, r) => a + (Number(r.inTok) || 0), 0),
    outTok: rows.reduce((a, r) => a + (Number(r.outTok) || 0), 0),
    cny: Number(rows.reduce((a, r) => a + (Number(r.cost) || 0), 0).toFixed(4)),
  };
}
function auditRows(inst, kind) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(path.join(inst.HOME, 'logs')).filter(f => /^workbench-.*\.ndjson$/.test(f)); } catch { files = []; }
  for (const f of files) {
    let text = ''; try { text = fs.readFileSync(path.join(inst.HOME, 'logs', f), 'utf8'); } catch { text = ''; }
    for (const l of text.split(/\r?\n/)) { if (!l.includes(kind)) continue; try { const row = JSON.parse(l); if (row.kind === kind) out.push(row); } catch { /* 半行 */ } }
  }
  return out;
}

// ── 一个实例里跑 n 次代批 ──────────────────────────────────────────────────────────────
async function runInstance(tag, pollMs, n, readings) {
  const inst = await startInstance(tag, pollMs);
  const rec = { tag, pollMs, up: inst.up, hasToken: !!inst.TOKEN, samples: [], spend: null, notes: [] };
  readings.instances.push(rec);
  try {
    if (!inst.up || !inst.TOKEN) { rec.notes.push('服务没起来'); return rec; }
    const cursorReady = await waitFor(() => fs.existsSync(path.join(inst.HOME, 'steward', 'cursor-v1.json')), 40000);
    rec.cursorReady = !!cursorReady;
    // n 个各自独立的临时目录,脚本里 n 条 Remove-Item —— n 个确定时刻出现的待决。
    for (let i = 0; i < n; i++) {
      const d = path.join(inst.WORK, 'tmp' + i);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'keep.txt'), 'x', 'utf8');
    }
    threadScript = Array.from({ length: n }, (_, i) => ({ name: 'powershell_run', args: { command: 'Remove-Item .\\tmp' + i + ' -Recurse', cwd: inst.WORK, timeoutMs: 30000 } }));
    const created = await reqJson(inst, 'POST', '/api/scheduler/tasks', {
      title: 'E1 例行清理(代批延迟实测)', schedule: { kind: 'daily', at: '03:00' },
      payload: { kind: 'prompt', text: '按计划做一次例行清理' }, autonomy: { permissionMode: 'auto' },
    });
    const taskId = created.json && created.json.task ? created.json.task.id : '';
    rec.taskCreated = !!taskId;
    if (!taskId) { rec.notes.push('建定时任务失败: ' + brief(created.json)); return rec; }
    const runNow = reqJson(inst, 'POST', '/api/scheduler/tasks/' + taskId + '/run-now', {}, 900000);
    const sid = await waitFor(() => {
      let names = []; try { names = fs.readdirSync(inst.sessionsDir).filter(f => /^sess_[A-Za-z0-9]+\.json$/.test(f)); } catch { names = []; }
      for (const f of names) { try { const h = JSON.parse(fs.readFileSync(path.join(inst.sessionsDir, f), 'utf8')); if (h.origin === 'schedule') return h.id; } catch { /* 写到一半 */ } }
      return '';
    }, 40000);
    rec.sessionId = sid || '';
    if (!sid) { rec.notes.push('调度器线程没出现'); await runNow; return rec; }
    const seen = new Set();
    for (let i = 0; i < n; i++) {
      const t0 = Date.now();
      const pending = await waitPending(inst, sid, seen, 120000);
      if (!pending) { rec.samples.push({ i, klass: 'harness_bug', note: '没等到第 ' + i + ' 个待决' }); break; }
      const first = firstRow(inst, sid, pending.id) || pending;
      const settled = await waitSettled(inst, sid, pending.id, 200000);
      const requestedAt = Date.parse(first.requestedAt || '');
      const decidedAt = settled ? Date.parse(settled.decidedAt || settled.updatedAt || '') : NaN;
      const sample = {
        i, klass: !settled ? 'timeout' : (Number.isFinite(requestedAt) && Number.isFinite(decidedAt) ? 'ok' : 'harness_bug'),
        toolName: pending.toolName || '', status: settled ? settled.status : '',
        decidedBy: settled ? settled.decidedBy || '' : '',
        requestedAt: first.requestedAt || '', decidedAt: settled ? (settled.decidedAt || settled.updatedAt || '') : '',
        latencyMs: (Number.isFinite(requestedAt) && Number.isFinite(decidedAt)) ? decidedAt - requestedAt : null,
        wallMs: Date.now() - t0,
        // 落定那一刻目录**通常还在** —— 决定刚落定,工具才开始跑。首轮六次全是 false 而收尾时
        // work 目录是空的(五个 tmp 都被删了),所以这一栏只是「落定瞬间的快照」,不是「有没有删成」。
        // 「删成了没有」看实例收尾的 `workDirEmpty`。
        tmpGoneAtSettle: !fs.existsSync(path.join(inst.WORK, 'tmp' + i)),
      };
      rec.samples.push(sample);
      console.log('  [' + tag + '] #' + i + ' ' + (sample.latencyMs == null ? '(' + sample.klass + ')' : (sample.latencyMs / 1000).toFixed(1) + ' s')
        + ' status=' + sample.status + ' decidedBy=' + sample.decidedBy);
      const s = realSpend(inst);
      if (s.cny > BUDGET_CNY * 0.9) { rec.notes.push('预算闸:本实例已花 ¥' + s.cny); break; }
    }
    const ran = await runNow;
    rec.runNowOutcome = (ran.json && ran.json.outcome) || '';
    rec.delegatedAudits = auditRows(inst, 'steward_exempt_delegated').length;
    rec.stewardLedgerRows = ledger(inst).filter(r => String(r.kind || '') === 'aux' && String(r.note || '') === 'steward').length;
    try { rec.workDirEmpty = fs.readdirSync(inst.WORK).length === 0; } catch { rec.workDirEmpty = null; }
    rec.spend = realSpend(inst);
    rec.stewardHitFakeProvider = stewardHitFake;
    return rec;
  } finally {
    killp(inst.proc);
    // 带密钥的配置立刻删掉,再复扫整个临时家。
    try { fs.rmSync(path.join(inst.HOME, 'config.json'), { force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(inst.HOME, 'config.json.prev'), { force: true }); } catch { /* ignore */ }
    rec.secretsLeftAfterShred = scanForKey(inst.HOME);
  }
}
function scanForKey(dir) {
  const hits = [];
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      let text = '';
      try { if (fs.statSync(p).size > 8 * 1024 * 1024) continue; text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (text.includes(API_KEY)) hits.push(p);
    }
  };
  walk(dir);
  for (const p of hits) { try { fs.rmSync(p, { force: true }); } catch { /* ignore */ } }
  return hits.length;
}

(async () => {
  const readings = {
    schema: 1, wave: '107-E1', at: new Date().toISOString(),
    environment: {
      stewardProviderId: PROVIDER_ID, stewardModel: MODEL,
      stewardHost: (() => { try { return new URL(realProvider.baseUrl).host; } catch { return ''; } })(),
      threadProvider: 'in-process fake (scripted powershell_run)',
      permissionTimeoutMs: 120000, hourlyDelegationCap: 6,
      compare: '45 号文 §9.6.5 (d):真管家单样本 37.0 s(轮询 5000 ms);steward-exempt-delegation.e2e.js R 段:假管家 12.5–17.6 s(轮询 15000 ms)',
    },
    instances: [], summary: null,
  };
  const provider = await startFakeProvider();
  try {
    console.log('管家代批延迟 · 真管家模型(' + PROVIDER_ID + '/' + MODEL + ')· 线程是进程内 fake');
    await runInstance('poll' + POLL_MS, POLL_MS, REPEATS, readings);
    if (FACTORY_REPEATS > 0) await runInstance('poll15000', 15000, FACTORY_REPEATS, readings);
  } catch (e) {
    readings.error = redactKey(String((e && e.message) || e));
    console.error(readings.error);
  } finally {
    try { provider.close(); } catch { /* ignore */ }
  }
  const all = readings.instances.flatMap(i => i.samples.filter(s => s.klass === 'ok' && s.latencyMs != null).map(s => ({ pollMs: i.pollMs, ms: s.latencyMs, status: s.status, decidedBy: s.decidedBy })));
  const byPoll = {};
  for (const s of all) { (byPoll[s.pollMs] || (byPoll[s.pollMs] = [])).push(s.ms); }
  readings.summary = {
    n: all.length,
    nonOk: readings.instances.flatMap(i => i.samples.filter(s => s.klass !== 'ok')).length,
    byPollMs: Object.fromEntries(Object.entries(byPoll).map(([k, v]) => [k, {
      n: v.length, meanMs: Math.round(v.reduce((a, b) => a + b, 0) / v.length), minMs: Math.min(...v), maxMs: Math.max(...v),
      pctOfPermissionTimeout: Number((Math.max(...v) / 120000 * 100).toFixed(1)),
    }])),
    delegatedCount: all.filter(s => s.status === 'allowed' && s.decidedBy === 'steward').length,
    spendCny: Number(readings.instances.reduce((a, i) => a + ((i.spend && i.spend.cny) || 0), 0).toFixed(4)),
  };
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(readings, null, 2), 'utf8'); }
  console.log('\n汇总: ' + JSON.stringify(readings.summary));
  if (OUT) console.log('落盘: ' + OUT);
})().catch(e => { console.error(String((e && e.stack) || e)); process.exitCode = 1; });
