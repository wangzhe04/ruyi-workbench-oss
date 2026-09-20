require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 129 波 129f · 49 号文 §4 · 31 号文 §2.4「嘴 —— 叫得到你」):管家主动叫人。
//
// 修前:管家只会在壳里说话,用户不在就等于白说。安静卡那一路已经会在事件上自动发通知,
// 但那是**工作台在叫**、报的是事件;管家自己想说一句「你交给我盯的那条收工了,结论是 X」,
// 没有任何口子。
//
// 覆盖:
//  (A) 三类事之外一律拒 —— 能叫人的理由一多,用户会把通知整个关掉,那时真要紧的也叫不到他。
//  (B) 熔断:滚动一小时上限(配置可调、服务端钳位),超了回 hourly_cap,且**不发帧**。
//  (C) 坐在那条线程上就不叫(与 128f-⑪ 同一个判据函数);线程不存在也拒。
//  (D) 真发帧:RUYI_EVENTS 上出现 steward.notify,载荷是清洗过的三个字段;决策日志记一行。
//  (E) 诚实:回包说的是「送出去了」(queued),不是「他看到了」—— 静默时段与前台判定在前端,
//      服务端不知道结果,不许把不知道说成知道。
//
// 进程内直调 + 直接听 RUYI_EVENTS,零模型请求、零网络、零浏览器。
// 判定行:`STEWARD NOTIFY E2E: ALL PASS`。
const fs = require('fs'), os = require('os'), path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-notify-'));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  stewardEnabledV1: true, stewardPollMs: 120000,
  stewardNotifyPerHour: 3,   // 压到 3,熔断那一条不必叫六次
}, null, 2), 'utf8');
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const frames = [];
srv.RUYI_EVENTS.subscribe((name, payload) => { if (name === 'steward.notify') frames.push(payload); });
const ctx = { session: { id: 'steward', kind: 'steward', providerHistory: [{ role: 'user', content: 'x' }] }, sessionId: 'steward' };
const call = args => srv.toolCall('steward_notify', args, ctx);
let firstOk = null;   // (E) 段要核它的措辞

/* ═════════ (A) 只在三类事上叫 ═════════ */
console.log('── (A) 三类事 ──');
{
  for (const kind of ['needs_you', 'failed']) {
    const r = await call({ kind, text: `${kind} 这类事该叫人` });
    ok(r && r.ok === true && r.kind === kind, `A1-${kind} 这一类叫得出去`);
    if (!firstOk && r && r.ok === true) firstOk = r;
  }
  const bad = await call({ kind: 'progress', text: '例行汇报一下进度' });
  ok(bad && bad.ok === false && bad.error === 'invalid_request',
    `A2 三类之外一律拒(例行汇报不值得打扰人;got ${bad && bad.error})`);
  const empty = await call({ kind: 'done', text: '   ' });
  ok(empty && empty.ok === false && empty.error === 'invalid_request', 'A3 空正文拒');
}

/* ═════════ (B) 熔断 ═════════ */
console.log('── (B) 熔断 ──');
{
  const before = frames.length;
  const third = await call({ kind: 'done', text: '第三次' });
  ok(third && third.ok === true, 'B1(前提)第三次还在上限内(上限压到 3)');
  const fourth = await call({ kind: 'done', text: '第四次,应该被熔断' });
  ok(fourth && fourth.ok === false && fourth.error === 'hourly_cap' && fourth.cap === 3,
    `B2 超过一小时上限就拒,并把上限数告诉模型(got ${fourth && fourth.error}/${fourth && fourth.cap})`);
  ok(frames.length === before + 1, 'B3 被熔断的那一次【不发帧】(拒得干净,不是先发了再说)');
}

/* ═════════ (C) 在场与目标 ═════════ */
console.log('── (C) 在场与目标 ──');
{
  const missing = await call({ kind: 'done', text: '指向一条不存在的线程', sessionId: 'sess_definitely_not_here' });
  ok(missing && missing.ok === false && missing.error === 'not_found',
    `C1 线程不存在就拒 —— 通知点进去要能落到那条线程上,指向空的等于叫了个空(got ${missing && missing.error})`);
  // 「用户正坐在那条线程上」:在场信号的事实源是 13r 的 presenceSnapshot,这里把它换成一份定值 ——
  // 起一个真浏览器来制造在场信号,测的就成了在场上报的时序,不是这条门本身。
  const thread = await srv.createSession({ title: '他正看着的线程', cwd: HOME });
  const realSnapshot = srv.EventStreamHooks.presenceSnapshot;
  srv.EventStreamHooks.presenceSnapshot = () => [{ lens: 'classic', sessionId: thread.id }];
  try {
    const seated = await call({ kind: 'needs_you', text: '他就在看着这条', sessionId: thread.id });
    ok(seated && seated.ok === false && seated.error === 'seated_by_user',
      `C2 用户正坐在那条线程上就不叫他 —— 直接在对话里说(got ${seated && seated.error})`);
  } finally { srv.EventStreamHooks.presenceSnapshot = realSnapshot; }
}

/* ═════════ (D) 帧与账 ═════════ */
console.log('── (D) 帧与账 ──');
{
  const first = frames[0];
  ok(first && first.kind === 'needs_you' && /该叫人/.test(String(first.text || '')),
    'D1 帧载荷带 kind 与正文(前端据此起卡或发系统通知)');
  ok(first && Object.keys(first).sort().join(',') === 'kind,sessionId,text',
    `D2 载荷只有那三个字段(got ${first && Object.keys(first).sort().join(',')})`);
  let rows = [];
  for (let i = 0; i < 40; i++) {
    await new Promise(res => setTimeout(res, 25));
    try { rows = fs.readFileSync(path.join(HOME, 'steward', 'decisions-v1.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { rows = []; }
    if (rows.some(d => d && d.tool === 'steward_notify')) break;
  }
  ok(rows.some(d => d && d.tool === 'steward_notify'),
    'D3 决策日志记下了「我叫过你」(用户在行动流水里看得见管家打扰过他几次)');
}

/* ═════════ (E) 诚实 ═════════ */
console.log('── (E) 诚实 ──');
{
  ok(firstOk && firstOk.delivered === 'queued',
    `E1 回包说的是「送出去了」(queued),不是「他看到了」(got ${firstOk && firstOk.delivered})`);
  ok(firstOk && /可能不会弹/.test(String(firstOk.note || '')),
    'E2 并明说静默时段或人在前台时可能不弹 —— 服务端不知道结果,不许把不知道说成知道');
  ok(firstOk && !/已通知|看到|收到/.test(String(firstOk.note || '') + String(firstOk.message || '')),
    'E3 措辞里没有任何「他已经知道了」的意思');
}

try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
console.log(fail === 0 ? 'STEWARD NOTIFY E2E: ALL PASS' : `STEWARD NOTIFY E2E: ${fail} FAILED`);
process.exit(fail === 0 ? 0 : 1);
})();
