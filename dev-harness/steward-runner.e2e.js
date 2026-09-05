(async () => {
'use strict';
// E2E(第 116 波 116f · 27 号文 §3.5/§8.9/§11.2/§11.3):管家回合运行器、输出契约、熔断与到访。
//
// 结构:前半用【真服务 + 真 fake-openai 子进程】跑三条新路由(/api/steward/{message,visit,act});
// 后半关掉服务,在【进程内】直调 runStewardTurn/stewardVisit 跑契约、降级、抢占、来源校验等矩阵
// (单进程 = 单份运行时状态与单份投影缓存,时序断言才可判定)。两半共用同一个 HOME 与同一个 fake。
//
// fake 的剧本能力:本件给 dev-harness/fake-openai.js 新加了 FAKE_REPLY_SEQUENCE(照 FAKE_SUMMARY_SEQUENCE
// 同款:第 N 个【流式】请求返回第 N 条最终文本,超出钳到末条;条目可为 {text,delayMs} 做慢回合)。
// 管家回合的剧本文本里【不含】任何 tool_call,所以「一个管家回合 = 一个流式请求」,序号可判定。
//
// 覆盖:
//  (A) 开关关:visit/message/act 三条路由 409 steward.disabled,<data>/steward 零文件,普通会话工具面不变。
//  (B) 开关开:首次 message 懒建管家会话(kind:'steward');会话列表 / 113b 内容搜索 / 13e 投影 / 收件箱
//      四个排除面都不含它;真实请求体里的系统提示是管家包(稳定层+记忆块+总览行)、工具面只有 steward_*。
//  (C) 输出契约:JSON -> say/why/acts 解析正确且 acts ≤3;非 JSON -> say 取原文。
//  (D) actions:default 权限线程的 decide -> propose_required 并【降级成一条 act】(不算失败);
//      auto 权限线程 -> 真执行并落决策日志;relay 没勾选时 thread_continue -> 自理清单挡下并降级。
//  (E) 收件箱回合:events -> 一条 origin:'inbox' 的 user 消息;拿它当记忆来源 -> source_not_user。
//  (F) 用户消息抢占在途收件箱回合(fake 慢响应):被抢占的回合 steward.cancelled,事件重排不丢。
//  (G) 到访:静默判定、归档文件出现、历史清空、待决仍在、digest ≤5 条。
//  (H) 熔断:stewardMaxTurnsPerHour=1 时下一条 message 得 circuit 且不再调模型;连续 5 次零进展的
//      收件箱回合后退避到下一次用户消息(no_progress)。
//  (K) 记账:管家回合在用量台账里是 kind:'aux' + note:'steward'(日费用熔断按这条口径累计)。
//  (I) 上下文预算分叉:管家预算 = min(配置, 模型窗口) × 60%。
//  (J) CLI 引擎主端点 -> steward.unsupported_engine。
//
// 端口全部 getFreePort() 动态取。判定行:`STEWARD RUNNER E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-runner-'));
const CAPTURE = path.join(HOME, 'capture');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();
const stewardDir = path.join(HOME, 'steward');
const visitsDir = path.join(stewardDir, 'visits');
const decisionsFile = path.join(stewardDir, 'decisions-v1.ndjson');
const inboxFile = path.join(stewardDir, 'inbox-v1.ndjson');

// ── 剧本(顺序即断言基础;超出末条时 fake 钳到末条)────────────────────────────────────────────
const CONTRACT_A = JSON.stringify({
  say: '有三条线程在跑,一条在等你。',
  why: '来自收件箱事件与线程总览',
  acts: [
    { label: '打开周报', kind: 'open_thread', sessionId: 'sess_demo', primary: true },
    { label: '知道了', kind: 'dismiss' },
    { label: '重试', kind: 'tool', tool: 'steward_run_action', args: { sessionId: 'sess_demo', runId: 'run_x', action: 'retry_node' }, primary: true },
    { label: '越权', kind: 'tool', tool: 'file_write', args: { path: 'C:/x' } },
    { label: '第四个', kind: 'dismiss' },
  ],
  actions: [],
});
const PLAIN_TEXT = '这不是 JSON,只是一段大白话。';
const contractDecide = (missionId, interventionId, extraActions) => JSON.stringify({
  say: '这条线程在问能不能改文件,我看可以。',
  why: '待决 ' + interventionId,
  acts: [],
  actions: [{ tool: 'steward_decide', args: { missionId, interventionId, action: 'allow' } }, ...(extraActions || [])],
});
const CONTRACT_MIN = JSON.stringify({ say: '暂时没有需要打扰你的事。', why: '收件箱里都是收工事件', acts: [], actions: [] });
const contractRelay = sessionId => JSON.stringify({
  say: '我想接着让它办。',
  why: '失败事件',
  acts: [],
  actions: [{ tool: 'steward_thread_continue', args: { sessionId, message: '接着做' } }],
});

let THREAD_ID = '';   // 进程内阶段建好后回填(剧本里用到它的两条在建好之后才被消费)

// ── 起 fake-openai ──────────────────────────────────────────────────────────────────────────
// 剧本条目在下面按消费顺序排列。THREAD_ID 在进程内阶段才知道,故 decide/relay 两条改用「占位 →
// 起服务前无法确定」的方案不可行 —— 改为:先起 fake 只带前两条,进程内阶段用到 decide 时【重启】fake?
// 不必:decide 的 missionId 只在 args 里,fake 原样回放我们给它的文本,故这里把整份剧本先写成文件,
// 由 fake 从环境变量读一次即可 —— 于是把线程 id 定死为下面这个固定值,进程内阶段用同一个 id 建线程。
const FIXED_THREAD = 'sess_stewardrunner01';
THREAD_ID = FIXED_THREAD;
const REPLY_SEQUENCE = [
  CONTRACT_A,                                          // [0] 服务端 /api/steward/message
  PLAIN_TEXT,                                          // [1] 进程内:非 JSON
  contractDecide(FIXED_THREAD, 'perm_default'),        // [2] 进程内:default 权限 -> 降级
  contractDecide(FIXED_THREAD, 'perm_auto', [{ tool: 'steward_thread_rename', args: { sessionId: FIXED_THREAD, title: '周报-W36 · 收尾' } }]),
                                                       // [3] 进程内:auto 权限 -> 过档位门 + 一条真落账的写动作
  CONTRACT_MIN,                                        // [4] 进程内:收件箱回合
  { text: CONTRACT_MIN, delayMs: 3000 },               // [5] 进程内:慢的收件箱回合(被抢占)
  CONTRACT_MIN,                                        // [6] 进程内:抢占的用户回合
  contractRelay(FIXED_THREAD),                         // [7] 进程内:自理清单(relay 未勾选)
  CONTRACT_MIN,                                        // [8+] 其余钳到末条
];

const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(PROVIDER_PORT)], {
  env: { ...process.env, FAKE_REPLY_SEQUENCE: JSON.stringify(REPLY_SEQUENCE), FAKE_CAPTURE_DIR: CAPTURE },
  windowsHide: true,
});
fake.stderr.on('data', d => String(d).trim() && console.error('[fake!] ' + String(d).trim()));
await sleep(600);

// ── config ──────────────────────────────────────────────────────────────────────────────────
function writeConfig(patch) {
  const config = {
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'default', permissionTimeoutMs: 120000,
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 0, killOnDisconnect: false,
    stewardEnabledV1: true, stewardPollMs: 120000,
    stewardMaxTurnsPerHour: 12, stewardMaxCostPerDay: 1,
    stewardContextBudgetTokens: 200000, stewardReadBudgetChars: 48000,
    stewardVisitIdleMinutes: 60, stewardConversationRetention: 'visit',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    ...patch,
  };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
  return config;
}
fs.mkdirSync(HOME, { recursive: true });
writeConfig({ stewardEnabledV1: false });

// ── HTTP 小工具 ─────────────────────────────────────────────────────────────────────────────
function token() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function request(method, urlPath, body) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: WB_PORT, path: urlPath, method,
      headers: { 'x-wcw-token': token(), ...(payload ? { 'content-type': 'application/json' } : {}) },
    }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json, lines: text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) });
      });
    });
    req.on('error', () => resolve({ status: 0, text: '', json: null, lines: [] }));
    if (payload) req.write(payload);
    req.end();
  });
}
function countFiles(dir) { try { return fs.readdirSync(dir).length; } catch { return -1; } }

let wb = null;
try {
  /* ═════════ (A) 开关关 ═════════ */
  console.log('── (A) 开关关 ──');
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  let up = null;
  for (let i = 0; i < 100 && !up; i++) { await sleep(150); const r = await request('GET', '/api/status'); up = r.status === 200 ? r : null; }
  ok(!!up, 'A0 工作台起来了');

  {
    const visit = await request('POST', '/api/steward/visit', {});
    const message = await request('POST', '/api/steward/message', { message: '在吗' });
    const act = await request('POST', '/api/steward/act', { act: { kind: 'dismiss' } });
    ok(visit.status === 409 && visit.json && visit.json.error && visit.json.error.code === 'steward.disabled', `A1 开关关:visit -> 409 steward.disabled(got ${visit.status})`);
    ok(message.status === 409 && message.json && message.json.error && message.json.error.code === 'steward.disabled', `A2 开关关:message -> 409 steward.disabled(got ${message.status})`);
    ok(act.status === 409 && act.json && act.json.error && act.json.error.code === 'steward.disabled', `A3 开关关:act -> 409 steward.disabled(got ${act.status})`);
    ok(!fs.existsSync(stewardDir), 'A4 开关关:<data>/steward 目录不存在(零写入)');
    ok(!fs.existsSync(path.join(HOME, 'sessions', 'steward.json')), 'A5 开关关:不建管家会话');
    const sessions = await request('GET', '/api/sessions');
    ok(sessions.status === 200 && Array.isArray(sessions.json.sessions) && sessions.json.sessions.length === 0, 'A6 开关关:会话列表仍是空的');
  }

  /* ═════════ (B) 开关开:懒建会话 + 四个排除面 + 提示词与工具面 ═════════ */
  console.log('── (B) 开关开:管家会话与提示词 ──');
  writeConfig({});
  let firstReply = null;
  {
    const res = await request('POST', '/api/steward/message', { message: '你在看什么' });
    ok(res.status === 200, `B0 message 返回 200 NDJSON 流(got ${res.status})`);
    firstReply = res.lines.find(l => l && l.type === 'steward_reply') || null;
    ok(!!firstReply, 'B1 流末尾有一条 steward_reply 事件');
    ok(res.lines.some(l => l && l.type === 'session'), 'B1b 流形态与 /api/chat/stream 同款(session/assistant_delta/result 等既有事件照常)');
    const head = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', 'steward.json'), 'utf8')); } catch { return null; } })();
    ok(head && head.kind === 'steward' && head.id === 'steward' && head.title === '如意管家',
      'B2 首次 message 懒建管家会话(固定 id steward、kind:steward、标题「如意管家」)');
    ok(head && head.permissionMode === 'steward', "B2b 管家会话的 permissionMode 是独立模式 'steward'(不进 PERMISSION_MODES)");

    const sessions = await request('GET', '/api/sessions');
    ok(sessions.json && !sessions.json.sessions.some(s => s.id === 'steward'), 'B3 排除面 1:/api/sessions 会话列表不含管家会话');
    const search = await request('GET', '/api/sessions/search?q=' + encodeURIComponent('如意管家'));
    ok(search.status === 200 && search.json && !(search.json.results || []).some(r => r.id === 'steward'), 'B4 排除面 2:113b 内容搜索不含管家会话');
    const missions = await request('GET', '/api/missions');
    ok(missions.status === 200 && !(missions.json.missions || []).some(m => m.sessionId === 'steward'), 'B5 排除面 3:13e 投影(/api/missions)不含管家会话');
    const inboxRows = (() => { try { return fs.readFileSync(inboxFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } })();
    ok(!inboxRows.some(r => r && r.sessionId === 'steward'), 'B6 排除面 4:116b 收件箱不含管家会话(否则回合自激励成环)');
  }
  {
    // 真实请求体:管家包整段替换了普通会话的身份/工具协议层,工具面只有 steward_*。
    const files = fs.readdirSync(CAPTURE).filter(f => f.endsWith('.json')).sort();
    const bodies = files.map(f => { try { return JSON.parse(fs.readFileSync(path.join(CAPTURE, f), 'utf8')); } catch { return null; } }).filter(Boolean);
    const stewardBody = bodies.find(b => Array.isArray(b.tools) && b.tools.length && b.tools.every(t => String(t.function && t.function.name).startsWith('steward_')));
    ok(!!stewardBody, 'B7 工具面:管家回合的请求体里只有 steward_* 工具(零文件/shell/桌面/联网/元工具)');
    // 116-2a 重钉:17 → 18(新增 steward_thread_permission);116-2b 重钉:18 → 19(新增 steward_thread_note)。
    ok(stewardBody && stewardBody.tools.length === 19, `B7b 管家回合拿到全部 19 个 steward_*(按需装载对管家强制 full;got ${stewardBody && stewardBody.tools.length})`);
    const sys = stewardBody ? String((stewardBody.messages.find(m => m.role === 'system') || {}).content || '') : '';
    ok(/我是如意/.test(sys) && /永久豁免/.test(sys) && /输出契约/.test(sys), 'B8 稳定层:身份/永久豁免/输出契约都在系统提示里');
    ok(!/先读后改/.test(sys) && !/当前能力/.test(sys), 'B8b 稳定层【整段替换】普通包(不含工具协议层与能力层)');
    const firstUser = stewardBody ? String((stewardBody.messages.find(m => m.role === 'user') || {}).content || '') : '';
    ok(/我记得的关于用户的事|还没有记下/.test(firstUser), 'B9 半稳定层:记忆块在第一条 user 消息前缀里(易变内容后置)');
    ok(/线程总览|当前没有线程/.test(firstUser) && /steward_thread_read/.test(firstUser), 'B10 到访层:线程总览 + 「更多细节用 steward_thread_read」尾句');
  }

  /* ═════════ (C) 输出契约(服务端这一条:acts 归一) ═════════ */
  console.log('── (C) 输出契约 ──');
  {
    ok(firstReply && firstReply.say === '有三条线程在跑,一条在等你。', 'C1 say 解析正确');
    ok(firstReply && firstReply.why === '来自收件箱事件与线程总览', 'C2 why 解析正确');
    ok(firstReply && Array.isArray(firstReply.acts) && firstReply.acts.length === 3, `C3 acts 归一到 ≤3 个(got ${firstReply && firstReply.acts.length})`);
    ok(firstReply && firstReply.acts.every(a => a.kind !== 'tool' || String(a.tool).startsWith('steward_')), 'C4 acts 里的 tool 只认 steward_*(file_write 那条被丢弃)');
    ok(firstReply && firstReply.acts.filter(a => a.primary).length === 1, 'C5 主动作只有一个(第一个 primary 胜出)');
    ok(firstReply && firstReply.parsed === true, 'C6 parsed:true');
  }

  /* ═════════ (G-1) 到访:确定性摘要 + 归档 ═════════ */
  console.log('── (G) 到访 ──');
  {
    const visit = await request('POST', '/api/steward/visit', { force: true });
    ok(visit.status === 200 && visit.json && visit.json.ok === true, 'G1 visit 返回 200');
    ok(visit.json && visit.json.newVisit === true, 'G2 force:true -> 新到访');
    ok(visit.json && visit.json.digest && Array.isArray(visit.json.digest.items) && visit.json.digest.items.length <= 5, 'G3 digest 条数 ≤5(确定性归纳,不调模型)');
    ok(visit.json && Array.isArray(visit.json.pending), 'G4 待决列表随到访一起下发');
    ok(visit.json && 'focus' in visit.json && 'visit' in visit.json, 'G5 返回 focus 与 visit 时间戳');
    ok(countFiles(visitsDir) === 1, `G6 归档文件出现在 <data>/steward/visits/(got ${countFiles(visitsDir)})`);
    const head = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', 'steward.json'), 'utf8'));
    ok(head.messageCount === 0, `G7 retention:'visit' -> 归档后管家历史清空(messageCount ${head.messageCount})`);
    const archived = JSON.parse(fs.readFileSync(path.join(visitsDir, fs.readdirSync(visitsDir)[0]), 'utf8'));
    ok(archived.schema === 1 && Array.isArray(archived.messages) && archived.messages.length >= 2, 'G8 归档文件里是完整的这次到访对话');
  }

  /* ═════════ (D-1) act 落定:dismiss 只记日志、tool 走 13g 同一实现 ═════════ */
  console.log('── (D) act 落定 ──');
  {
    const dismissed = await request('POST', '/api/steward/act', { act: { kind: 'dismiss', label: '知道了' } });
    ok(dismissed.status === 200 && dismissed.json && dismissed.json.kind === 'dismiss', 'D1 act:dismiss 只记日志');
    const opened = await request('POST', '/api/steward/act', { act: { kind: 'open_thread', sessionId: FIXED_THREAD } });
    ok(opened.status === 200 && opened.json && opened.json.sessionId === FIXED_THREAD, 'D2 act:open_thread 只回 sessionId(切换由 UI 完成)');
    const forbidden = await request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'file_write', args: {} } });
    ok(forbidden.status === 400 && forbidden.json && forbidden.json.error && forbidden.json.error.code === 'not_allowed', 'D3 act:非管家工具 -> not_allowed(动世界的工具永远进不来)');
    const memVeto = await request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_memory_veto', args: { id: 'smem_nope' } } });
    ok(memVeto.status === 200 && memVeto.json && memVeto.json.result && memVeto.json.result.error === 'not_found', 'D4 act:tool 走 13g 的同一实现(稳定信封原样回传)');
  }

  /* ═════════ (H) 熔断 ═════════ */
  console.log('── (H) 熔断 ──');
  {
    const capturedBefore = countFiles(CAPTURE);
    writeConfig({ stewardMaxTurnsPerHour: 1 });
    const res = await request('POST', '/api/steward/message', { message: '再看一眼' });
    const reply = res.lines.find(l => l && l.type === 'steward_reply') || null;
    ok(reply && reply.circuit && reply.circuit.kind === 'turns_per_hour',
      `H1 每小时回合上限=1 且本小时已跑过 1 个回合 -> 下一条 message 得 circuit(got ${reply && JSON.stringify(reply.circuit)})`);
    ok(countFiles(CAPTURE) === capturedBefore, 'H2 熔断时不再调模型(fake 没有收到新请求)');
    const state = await request('GET', '/api/steward/state');
    ok(state.status === 200 && state.json && state.json.circuit && state.json.circuit.kind === 'turns_per_hour', 'H3 /api/steward/state 带 circuit');
    ok(state.json && state.json.visit && state.json.turns && state.json.cost && 'lastReply' in state.json, 'H4 /api/steward/state 扩展了 visit/turns/cost/lastReply');
    writeConfig({});
  }
} finally {
  kill(wb);
  wb = null;
}
await sleep(400);

/* ═════════════════════ 进程内阶段 ═════════════════════ */
console.log('── 进程内阶段(单进程运行时,时序可判定)──');
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);
const readDecisions = () => { try { return fs.readFileSync(decisionsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };
const stewardCtx = () => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] } });

try {
  // 建一条真线程(固定 id,剧本里 decide/relay 用的就是它),再手工放三条待决进它的干预日志。
  {
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(HOME, 'sessions', FIXED_THREAD + '.json'), JSON.stringify({
      id: FIXED_THREAD, schemaVersion: 3, storageVersion: 2, turnSeq: 1, title: '周报-W36', summary: '上一步在等华南的表',
      pinned: false, cwd: HOME, createdAt: now, updatedAt: now, claudeSessionId: null, attachments: [],
      messageCount: 0, providerHistoryCount: 0, mission: null, missionId: FIXED_THREAD, kind: 'quick_ask',
    }, null, 2), 'utf8');
    // 存储 v2:头是提交点,两个正文文件缺失 = 头不可信(loadSession 会把它隔离成 .corrupt)。
    // 合成线程也必须把空正文写出来,否则 rename/decide 全部 not_found。
    fs.writeFileSync(path.join(HOME, 'sessions', FIXED_THREAD + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(HOME, 'sessions', FIXED_THREAD + '.provider.ndjson'), '', 'utf8');
    const ivFile = path.join(HOME, 'sessions', FIXED_THREAD + '.interventions.ndjson');
    const putIv = (id, extra) => fs.appendFileSync(ivFile, JSON.stringify({
      id, type: 'permission', sessionId: FIXED_THREAD, status: 'pending', requestedAt: now,
      decidedAt: '', decidedBy: '', interventionVersion: 0, ...extra,
    }) + '\n', 'utf8');
    putIv('perm_default', { toolName: 'file_write', tier: 'edit' });
    putIv('perm_auto', { toolName: 'file_write', tier: 'edit' });
  }

  /* ═════════ (C-2) 非 JSON -> say 取原文 ═════════ */
  {
    const r = await srv.runStewardTurn({ trigger: 'user', message: '随便说点什么' });
    ok(r && r.ok === true && r.parsed === false && r.say === PLAIN_TEXT, `C7 非 JSON 输出 -> say 取原文、acts 空(got parsed=${r && r.parsed})`);
    ok(r && r.acts.length === 0 && r.actions.length === 0, 'C8 非 JSON 时不臆造按钮与动作');
  }

  /* ═════════ (D-2) actions:降级 / 执行 / 自理清单 ═════════ */
  {
    const before = readDecisions().length;
    const r = await srv.runStewardTurn({ trigger: 'user', message: '看看那条待决' });
    const executed = (r.actions || [])[0];
    ok(executed && executed.tool === 'steward_decide' && executed.result && executed.result.error === 'propose_required',
      `D5 default 权限线程的 decide -> propose_required(got ${executed && executed.result && executed.result.error})`);
    ok(r.acts.some(a => a.kind === 'tool' && a.tool === 'steward_decide' && a.label === '允许'),
      'D6 propose_required 自动降级成一条 act(label 由工具与 args 派生:允许)');
    ok(r.ok === true, 'D7 降级不算失败(回合照常返回 ok)');
    ok(readDecisions().length === before, 'D8 propose_required 不落决策日志');
  }
  {
    writeConfig({ permissionMode: 'auto' });
    const before = readDecisions().length;
    const r = await srv.runStewardTurn({ trigger: 'user', message: '这条可以放行' });
    const executed = (r.actions || [])[0];
    ok(executed && executed.result && executed.result.error !== 'propose_required',
      `D9 auto 权限线程的 decide 过档位门、进命令核心(合成待决没有活回合可投递 -> delivery_unavailable,不是被权限挡下;got ${executed && JSON.stringify(executed.result && executed.result.error || 'ok')})`);
    const renamed = (r.actions || [])[1];
    ok(renamed && renamed.tool === 'steward_thread_rename' && renamed.result && renamed.result.ok === true,
      'D10 同一回合里的写动作真的执行了(thread_rename 成功)');
    const rows = readDecisions();
    ok(rows.length > before && rows.some(r2 => r2.tool === 'steward_thread_rename' && r2.targetSessionId === FIXED_THREAD && typeof r2.permissionMode === 'string' && r2.undoRef),
      'D10b 执行后落一行决策日志(含目标线程、权限档与 undoRef)');
    writeConfig({});
  }

  /* ═════════ (E) 收件箱回合与来源校验 ═════════ */
  console.log('── (E) 收件箱回合 ──');
  let inboxTurnSeq = 0;
  {
    const events = [
      { inboxSeq: 1, kind: 'failed', sessionId: FIXED_THREAD, missionId: FIXED_THREAD, seq: 3, at: new Date().toISOString(), payload: { summary: '节点 build 失败' }, count: 1 },
      { inboxSeq: 2, kind: 'done', sessionId: FIXED_THREAD, missionId: FIXED_THREAD, seq: 4, at: new Date().toISOString(), payload: { summary: '另一条收工' }, count: 2 },
    ];
    const r = await srv.runStewardTurn({ trigger: 'inbox', events });
    ok(r && r.ok === true && r.trigger === 'inbox', 'E1 收件箱回合跑通');
    const rows = fs.readFileSync(path.join(HOME, 'sessions', 'steward.messages.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const lastUser = [...rows].reverse().find(m => m && m.role === 'user');
    inboxTurnSeq = Number(lastUser && lastUser.turnSeq) || 0;
    ok(lastUser && lastUser.meta && lastUser.meta.origin === 'inbox', 'E2 收件箱事件以一条 origin:inbox 的 user 消息注入(元数据随正文落盘)');
    ok(lastUser && /收件箱/.test(String(lastUser.content)) && /不是用户说的话/.test(String(lastUser.content)), 'E3 消息文本自己就说清了「这不是用户说的话」');
    const write = await srv.toolCall('steward_memory_write', {
      kind: 'preference', text: '用户喜欢一页纸摘要', sourceRef: { sessionId: 'steward', turnSeq: inboxTurnSeq },
    }, stewardCtx());
    ok(write && write.ok === false && write.error === 'source_not_user',
      `E4 拿 origin:inbox 的回合当记忆来源 -> source_not_user(got ${write && write.error})`);
    const userTurn = [...rows].reverse().find(m => m && m.role === 'user' && !(m.meta && m.meta.origin === 'inbox'));
    const write2 = await srv.toolCall('steward_memory_write', {
      kind: 'preference', text: '用户喜欢一页纸摘要', sourceRef: { sessionId: 'steward', turnSeq: Number(userTurn && userTurn.turnSeq) || 0 },
    }, stewardCtx());
    ok(write2 && write2.ok === true, `E5 同一会话里用户【本人】那一回合仍是合法来源(got ${write2 && write2.error})`);
  }

  /* ═════════ (F) 用户消息抢占在途收件箱回合 ═════════ */
  console.log('── (F) 抢占 ──');
  {
    const events = [{ inboxSeq: 9, kind: 'stalled', sessionId: FIXED_THREAD, missionId: FIXED_THREAD, seq: 9, at: new Date().toISOString(), payload: { summary: '停住了' }, count: 1 }];
    const slow = srv.runStewardTurn({ trigger: 'inbox', events });
    await sleep(700);   // 让慢回合真的把请求发出去(剧本第 [5] 条 delayMs=3000)
    const fast = await srv.runStewardTurn({ trigger: 'user', message: '别管它了,先跟我说话' });
    const slowResult = await slow;
    ok(fast && fast.ok === true && fast.trigger === 'user', 'F1 用户回合抢占后照常跑完(用户永远优先)');
    ok(slowResult && slowResult.ok === false && slowResult.error === 'steward.cancelled',
      `F2 在途收件箱回合被就地取消(got ${slowResult && slowResult.error})`);
    const state = await srv.StewardHooks.runnerState(srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config);
    ok(state && state.queued >= 1, `F3 被抢占那批事件重排进队列不丢(queued=${state && state.queued})`);
  }

  /* ═════════ (D-3) 自理清单:relay 未勾选 -> 只提议 ═════════ */
  {
    const events = [{ inboxSeq: 20, kind: 'failed', sessionId: FIXED_THREAD, missionId: FIXED_THREAD, seq: 20, at: new Date().toISOString(), payload: { summary: '又失败了' }, count: 1 }];
    const r = await srv.runStewardTurn({ trigger: 'inbox', events });
    // 116-2b 重钉:自理动作(确定性处置)排在【模型 actions 之前】,故不能再按下标 0 取模型那条。
    // 断言本意一字未改 —— 找的仍是「模型提的 thread_continue 被自理清单 relay 那道闸挡下」这一条。
    const executed = (r.actions || []).find(a => a && a.result && a.result.reason === 'self_serve_off');
    ok(executed && executed.tool === 'steward_thread_continue' && executed.result && executed.result.error === 'propose_required' && executed.result.reason === 'self_serve_off',
      `D11 自理清单里 relay 默认关 -> 无人值守回合的递话只提议(got ${executed && executed.result && executed.result.error})`);
    // 116-2b 追加:同一批里工作台自己那条确定性重试,被【目标线程权限】那道闸挡下(全局档 default)。
    const selfServed = (r.actions || []).find(a => a && a.auto === true);
    ok(selfServed && selfServed.tool === 'steward_thread_continue' && selfServed.args.message === '继续'
      && selfServed.result && selfServed.result.reason === 'self_serve_gate',
      `D11b 自理重试在 default 档线程上只提议(got ${selfServed && selfServed.result && selfServed.result.reason})`);
    ok(r.acts.some(a => a.tool === 'steward_thread_continue' && a.label === '接着办'), 'D12 自理清单挡下的 action 同样降级成一条按钮');
  }

  /* ═════════ (G-2) 到访:静默判定与预算重置 ═════════ */
  {
    const notNew = await srv.stewardVisit({});
    ok(notNew && notNew.ok === true && notNew.newVisit === false, 'G9 刚活动过(未静默 60 分钟)-> 不是新到访,只回当前状态');
    const forced = await srv.stewardVisit({ force: true });
    ok(forced && forced.newVisit === true && countFiles(visitsDir) >= 2, `G10 force -> 又一个归档文件(got ${countFiles(visitsDir)})`);
    const pendingStill = (forced.pending || []).some(p => p.sessionId === FIXED_THREAD);
    ok(pendingStill, 'G11 到访清空对话,但待决仍在(待决持久化,重开必现)');
  }

  /* ═════════ (K) 记账口径 ═════════ */
  console.log('── (K) 记账 ──');
  {
    const usageDir = path.join(HOME, 'usage');
    const rows = (fs.existsSync(usageDir) ? fs.readdirSync(usageDir) : [])
      .filter(f => f.endsWith('.jsonl'))
      .flatMap(f => fs.readFileSync(path.join(usageDir, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }))
      .filter(Boolean);
    const stewardRows = rows.filter(r => r.sessionId === 'steward');
    ok(stewardRows.length > 0, `K1 管家回合进了用量台账(got ${stewardRows.length} 行)`);
    ok(stewardRows.every(r => r.kind === 'aux' && r.note === 'steward'),
      "K2 管家回合一律 kind:'aux' + note:'steward'(不是用户的聊天回合;日费用熔断按这条口径累计)");
    ok(rows.filter(r => r.sessionId === FIXED_THREAD).every(r => r.note !== 'steward'),
      'K3 线程自己的回合不带 steward 记号(管家开销与线程开销分得开)');
  }

  /* ═════════ (H-2) 无进展熔断 ═════════ */
  {
    // 前面的相位已经跑掉十几个回合,先把每小时上限抬高 —— 否则「回合上限」会抢在「无进展」之前命中,
    // 这一相位测的就不再是无进展那条闸了。此后的相位都不测回合上限,故不再调回 12。
    writeConfig({ stewardMaxTurnsPerHour: 100 });
    // 剧本已钳到末条 CONTRACT_MIN(零 acts 零 actions)= 连续零进展。第 5 次之后退避。
    let lastResult = null;
    for (let i = 0; i < 6; i++) {
      lastResult = await srv.runStewardTurn({ trigger: 'inbox', events: [{ inboxSeq: 100 + i, kind: 'done', sessionId: FIXED_THREAD, missionId: FIXED_THREAD, seq: 100 + i, at: new Date().toISOString(), payload: { summary: '收工' }, count: 1 }] });
      if (lastResult && lastResult.circuit) break;
    }
    ok(lastResult && lastResult.circuit && lastResult.circuit.kind === 'no_progress',
      `H5 连续 ${5} 次收件箱回合零 acts 零 actions -> no_progress 退避(got ${lastResult && JSON.stringify(lastResult.circuit)})`);
    const afterUser = await srv.runStewardTurn({ trigger: 'user', message: '你还在吗' });
    ok(afterUser && afterUser.ok === true && !afterUser.circuit, 'H6 用户消息永远优先:一说话就解除无进展退避');
  }
  /* ═════════ (I) 上下文预算分叉 ═════════ */
  console.log('── (I) 预算分叉 ──');
  {
    const config = srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config;
    const session = { id: 'steward', kind: 'steward' };
    const big = srv.stewardContextBudget(session, config, 1000000);
    const small = srv.stewardContextBudget(session, config, 50000);
    ok(big === Math.round(200000 * 0.6), `I1 模型窗口够大时预算 = stewardContextBudgetTokens × 60%(got ${big})`);
    ok(small === Math.round(50000 * 0.6), `I2 模型窗口更小时取小值 × 60%(got ${small})`);
    ok(typeof srv.StewardHooks.contextBudget === 'function' && typeof srv.StewardHooks.visitNotesPrompt === 'function',
      'I3 分叉经 StewardHooks 挂接(10-context-governance 不认识 13h)');
    ok(/交接笔记|已经做出的决定/.test(String(srv.StewardHooks.visitNotesPrompt(config))), 'I4 到访内 L2 压缩用 steward.visitNotes 摘要 prompt');
  }

  /* ═════════ (J) CLI 引擎主端点 ═════════ */
  console.log('── (J) 引擎守卫 ──');
  {
    writeConfig({ activeProvider: '', agentCliType: 'claude', stewardProviderId: '', stewardMaxTurnsPerHour: 100 });
    const resolved = srv.stewardResolveRoute(srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config);
    ok(resolved && resolved.ok === false && resolved.error === 'steward.unsupported_engine', 'J1 主端点是 Claude CLI -> stewardResolveRoute 稳定信封');
    const r = await srv.runStewardTurn({ trigger: 'user', message: '在吗' });
    ok(r && r.ok === false && r.error === 'steward.unsupported_engine', `J2 回合入口同样 fail-closed(got ${r && r.error})`);
    writeConfig({ stewardMaxTurnsPerHour: 100 });
  }

  /* ═════════ (A-2) 开关关时回合入口零副作用 ═════════ */
  {
    writeConfig({ stewardEnabledV1: false, stewardMaxTurnsPerHour: 100 });
    const r = await srv.runStewardTurn({ trigger: 'user', message: '在吗' });
    ok(r && r.ok === false && r.error === 'steward.disabled', 'A7 开关关:runStewardTurn 直接 steward.disabled');
    const v = await srv.stewardVisit({ force: true });
    ok(v && v.ok === false && v.error === 'steward.disabled', 'A8 开关关:stewardVisit 直接 steward.disabled(不建归档)');
    writeConfig({ stewardMaxTurnsPerHour: 100 });
  }
} finally {
  kill(fake);
}

console.log('');
if (fail) { console.log(`STEWARD RUNNER E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD RUNNER E2E: ALL PASS');
process.exit(0);
})();
