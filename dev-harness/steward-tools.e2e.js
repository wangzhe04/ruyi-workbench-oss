(async () => {
'use strict';
// E2E(第 116 波 116c · 27 号文 §3.3/§3.5/§4/§11.2):管家工具的行为直测。
// 116-2a 重钉:工具数 17 → 18(新增 steward_thread_permission,线程权限只降不升)。
//
// 结构:主体在【进程内】直调 TOOL_HANDLERS(合成管家 ctx `{session:{id,kind:'steward'}}`)——116f 才会
// 真正创建管家会话,本切片按交办单用合成 ctx;回合本身走真实 runSessionTurn + fake-openai(真实 HTTP),
// 所以「委托书真的跑起来了」是可验证的。最后再起一个真服务与一个 MCP 子进程,验四个 offer 面里剩下的两个。
//
// 覆盖:
//  (A) 开关关:全部工具 steward.disabled,且 <data>/steward 目录一个字节都不写。
//  (B) 开关开 + 普通会话 ctx:全部工具 steward.forbidden(fail-closed 二次校验)。
//  (C) 观察族九个工具的正向返回形状。
//  (D) 委托书:原话逐字在最前、补充在 <steward-brief added-by="steward"> 围栏内且尖括号被中和、
//      sessionMeta.brief 分开落盘、fake-openai 真的收到了请求(回合跑起来了)。
//  (E) thread_continue:原话直递、undoRef.turnSeq === 递话前 turnSeq、在途回合 -> steward.busy。
//  (F) thread_read:配额(每回合 6 次)与预算(stewardReadBudgetChars)两个稳定信封;读取零持久化。
//  (G) decide 三档矩阵:default -> propose_required(不落决策日志);acceptEdits 对 edit 放行、对 exec 拒;
//      auto 放行;永久豁免正则命中 -> 任何档都拒。越权/错 id/版本冲突三个稳定信封。
//  (H) run_action:收紧类任何档可做、推进类非全自动 -> propose_required。
//  (I) 记忆:来源非用户消息 -> source_not_user;敏感 -> sensitive_rejected;同义合并;veto 后同义拒。
//  (J) 决策日志:每个写动作恰好一行,字段齐整。
//  (K) 四门:普通会话在 buildOpenAiTools / adaptive 目录 / /api/status / MCP tools/list 四处都看不到 steward_*。
//
// 端口全部 getFreePort() 动态取(run-all 端口审计口径)。判定行:`STEWARD TOOLS E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-tools-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

const STEWARD_TOOLS = [
  'steward_self_status', 'steward_threads_search', 'steward_thread_status', 'steward_thread_read',
  'steward_runs_status', 'steward_inbox_read', 'steward_usage', 'steward_health', 'steward_audit_tail',
  'steward_missions', // 116g
  'steward_thread_new', 'steward_thread_continue', 'steward_thread_rename', 'steward_thread_permission',
  'steward_decide', 'steward_run_action',
  'steward_memory_write', 'steward_memory_veto', 'steward_memory_search',
];
// 每个工具一组「形状合法但目标不存在」的最小参数:门控壳必须在碰这些参数之前就返回 disabled/forbidden。
const MIN_ARGS = {
  steward_threads_search: { q: 'x' },
  steward_thread_status: { sessionId: 'sess_nope' },
  steward_thread_read: { sessionId: 'sess_nope' },
  steward_thread_new: { brief: { userText: 'x' } },
  steward_thread_continue: { sessionId: 'sess_nope', message: 'x' },
  steward_thread_rename: { sessionId: 'sess_nope', title: 'x' },
  steward_thread_permission: { sessionId: 'sess_nope', permissionMode: 'plan' },
  steward_decide: { missionId: 'sess_nope', interventionId: 'iv_nope', action: 'allow' },
  steward_run_action: { sessionId: 'sess_nope', runId: 'run_nope', action: 'pause' },
  steward_memory_write: { kind: 'preference', text: 'x', sourceRef: { sessionId: 'sess_nope', turnSeq: 0 } },
  steward_memory_veto: { id: 'nope' },
};

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();
const stewardDir = path.join(HOME, 'steward');
const decisionsFile = path.join(stewardDir, 'decisions-v1.ndjson');
const memoryFile = path.join(stewardDir, 'memory-v1.json');

// ── fake-openai:自带的最小实现(要能计数请求、按需慢回、按需发工具调用)────────────────────────
let providerHits = 0;
let providerDelayMs = 0;
let emitFileWriteOnce = false;
let fileWriteEmitted = false;
const providerServer = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  await new Promise(r => req.on('end', r));
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  providerHits += 1;
  if (providerDelayMs) await sleep(providerDelayMs);
  let body = null; try { body = JSON.parse(raw); } catch { body = null; }
  const hasToolResult = Array.isArray(body && body.messages) && body.messages.some(m => m && m.role === 'tool');
  const wantTool = emitFileWriteOnce && !fileWriteEmitted && !hasToolResult && Array.isArray(body && body.tools) && body.tools.length;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  if (wantTool) {
    fileWriteEmitted = true;
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'file_write', arguments: '' } }] } }] });
    frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ path: path.join(HOME, 'steward-e2e-target.txt'), content: 'hi' }) } }] } }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  } else {
    frame({ choices: [{ index: 0, delta: { content: '好的，已经看过了。' } }] });
    frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  }
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

// ── config ──────────────────────────────────────────────────────────────────────────────
function writeConfig(patch) {
  const config = {
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive',
    permissionMode: 'default', permissionTimeoutMs: 120000,
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 0,
    stewardEnabledV1: true, stewardPollMs: 120000, stewardReadBudgetChars: 4000,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    ...patch,
  };
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}
fs.mkdirSync(HOME, { recursive: true });
writeConfig({ stewardEnabledV1: false });

process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const stewardCtx = id => ({ session: { id: id || 'steward', kind: 'steward', providerHistory: [] } });
const plainCtx = { session: { id: 'plain-sess', kind: 'quick_ask', providerHistory: [] } };
const call = (name, args, ctx) => srv.toolCall(name, args || MIN_ARGS[name] || {}, ctx);
const readDecisions = () => { try { return fs.readFileSync(decisionsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); } catch { return []; } };

try {
  /* ═════════ (A) 开关关:全部 steward.disabled 且零写入 ═════════ */
  console.log('── (A) 开关关 ──');
  {
    let bad = [];
    for (const name of STEWARD_TOOLS) {
      const r = await call(name, null, stewardCtx());
      if (!r || r.ok !== false || r.error !== 'steward.disabled') bad.push(`${name}:${r && r.error}`);
    }
    ok(bad.length === 0, 'A1 开关关时 19 个工具全部返回 steward.disabled' + (bad.length ? ' → ' + bad.join(',') : ''));
    ok(!fs.existsSync(stewardDir), 'A2 开关关时 <data>/steward 目录不存在(零写入)');
  }

  /* ═════════ (B) 开关开 + 普通会话 ctx -> steward.forbidden ═════════ */
  console.log('── (B) 普通会话越权 ──');
  writeConfig({});
  {
    let bad = [];
    for (const name of STEWARD_TOOLS) {
      const r = await call(name, null, plainCtx);
      if (!r || r.ok !== false || r.error !== 'steward.forbidden') bad.push(`${name}:${r && r.error}`);
    }
    ok(bad.length === 0, 'B1 普通会话 ctx 下 19 个工具全部返回 steward.forbidden' + (bad.length ? ' → ' + bad.join(',') : ''));
    const noCtx = await call('steward_health', {}, null);
    ok(noCtx && noCtx.error === 'steward.forbidden', 'B2 无 ctx(桥接/子进程路径)同样 fail-closed forbidden');
    ok(!fs.existsSync(decisionsFile), 'B3 越权调用不写决策日志');
  }

  /* ═════════ (C) 观察族正向 ═════════ */
  console.log('── (C) 观察族正向 ──');
  {
    const st = await call('steward_self_status', {}, stewardCtx());
    ok(st && st.ok === true && st.version && st.steward && st.steward.config && st.steward.inbox,
      'C1 steward_self_status 复用 108c 装配并带 steward 段(config 掩码 + 收件箱状态)');
    ok(st && st.steward.config.stewardEnabledV1 === true && !('apiKey' in st.steward.config),
      'C1b steward 段只回显白名单管家键,不含任何密钥字段');
    const sec = await call('steward_self_status', { section: 'steward' }, stewardCtx());
    ok(sec && sec.ok === true && sec.steward && !('counts' in sec) && !('config' in sec),
      "C1c section:'steward' 只带身份 + 管家段(省上下文)");

    const health = await call('steward_health', {}, stewardCtx());
    ok(health && health.ok === true && Array.isArray(health.health) && health.health.length > 0, 'C2 steward_health 返回体检项数组');

    const audit = await call('steward_audit_tail', { limit: 500 }, stewardCtx());
    ok(audit && audit.ok === true && Array.isArray(audit.entries), 'C3 steward_audit_tail 返回条目数组(limit 越界夹取不报错)');

    const usage = await call('steward_usage', {}, stewardCtx());
    ok(usage && usage.ok === true && usage.total && usage.steward && Array.isArray(usage.byDay),
      'C4 steward_usage 返回总量 + 管家自身开销单列 + 按日切片');

    const inbox = await call('steward_inbox_read', { limit: 5 }, stewardCtx());
    ok(inbox && inbox.ok === true && Array.isArray(inbox.items), 'C5 steward_inbox_read 委托 116b 原始读取器');

    const runs = await call('steward_runs_status', {}, stewardCtx());
    ok(runs && runs.ok === true && Array.isArray(runs.runs), 'C6 steward_runs_status 返回班组 digest 数组');

    const search = await call('steward_threads_search', { q: '不存在的关键词zzzq' }, stewardCtx());
    ok(search && search.ok === true && Array.isArray(search.results) && search.results.length === 0, 'C7 steward_threads_search 无命中返回空数组');

    const missing = await call('steward_thread_status', { sessionId: 'sess_nope' }, stewardCtx());
    ok(missing && missing.ok === false && missing.error === 'not_found', 'C8 steward_thread_status 目标不存在 -> not_found');
    const missingRead = await call('steward_thread_read', { sessionId: 'sess_nope' }, stewardCtx());
    ok(missingRead && missingRead.ok === false && missingRead.error === 'not_found', 'C9 steward_thread_read 目标不存在 -> not_found');

    // 116g: 事项级只读视图。此刻还没有任何事项文件 -> 每条线程各自是一个「未归类」事项(derived:true)。
    const missions = await call('steward_missions', {}, stewardCtx());
    ok(missions && missions.ok === true && Array.isArray(missions.missions), 'C12 steward_missions 返回事项数组');
    ok(missions && missions.missions.every(m => m.missionId && typeof m.aggregateState === 'string' && m.acceptance && Array.isArray(m.threads)),
      'C12b 每个事项行带 missionId/aggregateState/acceptance/threads');
    ok(missions && missions.missions.every(m => m.derived === true),
      'C12c 没有事项文件时全部是「未归类」派生视图(存量零迁移)');
    ok(missions && missions.missions.every(m => m.threads.every(t => t.sessionId && typeof t.state === 'string' && String(t.lastAssistantText || '').length <= 120)),
      'C12d 子线程带 sessionId/五态,最后一句 ≤120 字');
  }

  /* ═════════ (D) 委托书 ═════════ */
  console.log('── (D) 委托书 ──');
  let threadId = '';
  {
    const hitsBefore = providerHits;
    const userText = '把 <b>季度报告</b> 整理成一页纸';
    const res = await call('steward_thread_new', {
      title: '季度报告整理',
      cwd: HOME,
      brief: {
        userText,
        goal: '产出 <one-pager> 摘要',
        acceptance: ['一页纸内讲清三件事', '中文输出'],
        context: ['E:\\reports\\q3.md'],
        preferences: ['中文'],
        constraints: ['不要联网'],
        memoryIds: ['smem_demo'],
      },
    }, stewardCtx());
    ok(res && res.ok === true && res.sessionId && res.undoRef && res.undoRef.kind === 'thread_new',
      'D1 steward_thread_new 返回 {ok,sessionId,missionId,undoRef}');
    // 117d 第 0 步:回退锚点显式化 —— 新线程 turnSeq 从 0 起,委托书那一回合是第 1 回合。
    ok(res.undoRef.rewindTargetTurnSeq === 1, 'D1b thread_new 的 undoRef 带 rewindTargetTurnSeq === 1(委托书那一回合)');
    threadId = res.sessionId;
    const head = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', threadId + '.json'), 'utf8'));
    ok(head.kind === 'mission' && head.missionId === threadId, 'D2 新线程落盘为 kind:mission,missionId 自成事项');
    ok(head.brief && head.brief.by === 'steward' && head.brief.userText === userText && head.brief.supplement.includes('目标'),
      'D3 sessionMeta.brief 落盘:原话与管家补充分开存(供 117 显示与「改一下」)');
    ok(head.brief.memoryIds.join(',') === 'smem_demo', 'D3b 委托书记下引用的管家记忆条目 id');

    // 首条消息:等回合把 user 消息写进 messages 正文。
    let first = null;
    for (let i = 0; i < 120 && !first; i++) {
      await sleep(100);
      try {
        const rows = fs.readFileSync(path.join(HOME, 'sessions', threadId + '.messages.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        first = rows.find(m => m && m.role === 'user') || null;
      } catch { first = null; }
    }
    ok(!!first, 'D4 委托书作为首条用户消息落盘');
    if (first) {
      ok(first.content.startsWith(userText), 'D5 用户原话【逐字】在最前(尖括号原样保留,不被中和)');
      const fence = first.content.slice(userText.length);
      ok(fence.includes('<steward-brief added-by="steward">') && fence.includes('</steward-brief>'),
        'D6 管家补充在 <steward-brief added-by="steward"> 围栏内');
      ok(fence.includes('[one-pager]') && !fence.includes('<one-pager>'), 'D7 围栏内补充的尖括号被中和');
      ok(fence.includes('一页纸内讲清三件事') && fence.includes('不要联网'), 'D8 验收项/约束等段进入补充');
    }
    // 回合真的跑起来了(fake-openai 收到了请求)。
    for (let i = 0; i < 100 && providerHits === hitsBefore; i++) await sleep(100);
    ok(providerHits > hitsBefore, 'D9 委托书交出去后回合真的跑起来了(fake-openai 收到请求)');
    const rows = readDecisions();
    ok(rows.some(r => r.tool === 'steward_thread_new' && r.targetSessionId === threadId && r.undoRef && r.undoRef.kind === 'thread_new'),
      'D10 决策日志记下 thread_new 一行(含 undoRef)');
  }

  /* ═════════ (E) thread_continue ═════════ */
  console.log('── (E) 递话 ──');
  {
    // 等上一回合收尾(避免撞上 busy)。
    for (let i = 0; i < 120; i++) {
      const s = await call('steward_thread_status', { sessionId: threadId }, stewardCtx());
      if (s && s.ok && s.activeTurn === false) break;
      await sleep(100);
    }
    const before = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', threadId + '.json'), 'utf8'));
    const beforeTurnSeq = Number(before.turnSeq) || 0;
    providerDelayMs = 3000; // 让下一回合停留在途,好测 busy
    // 递话内容故意做长(≥2500 字):后面 (F) 的读预算断言需要一条真有分量的回合。
    const relay = '再补一句：只要中文。' + '细节'.repeat(900);
    const r1 = await call('steward_thread_continue', { sessionId: threadId, message: relay }, stewardCtx());
    ok(r1 && r1.ok === true && r1.undoRef && r1.undoRef.kind === 'turn' && r1.undoRef.turnSeq === beforeTurnSeq,
      `E1 thread_continue 返回 undoRef 锚在递话前 turnSeq(${beforeTurnSeq})`);
    // 117d 第 0 步:rewindSession 的主键是【被递那一回合】的 seq,不是递话前的 seq。
    ok(r1.undoRef.rewindTargetTurnSeq === r1.undoRef.turnSeq + 1,
      `E1b thread_continue 的 undoRef.rewindTargetTurnSeq === turnSeq + 1(${beforeTurnSeq + 1},整单回退的锚点)`);
    // 在途的目标线程。先等回合真的挂上活标志(fire-and-forget 有一个 loadSession 的异步窗口),
    // 再【只发一次】探针 —— 循环重发会真的开出更多回合。
    for (let i = 0; i < 100; i++) {
      const s = await call('steward_thread_status', { sessionId: threadId }, stewardCtx());
      if (s && s.ok && s.activeTurn === true) break;
      await sleep(50);
    }
    const busy = await call('steward_thread_continue', { sessionId: threadId, message: '再来一句' }, stewardCtx());
    // 【117l D2 重钉】旧断言钉的是 116f 那一版的契约:「目标线程有在途回合 -> steward.busy」。
    // 那一版只有一道 activeChildren.has 判据,它把三种完全不同的情形混成了一个「忙」:线程在跑、
    // 线程在等用户回答、线程在等用户批准。用户第四轮走查的第 1、6 条正是它的后果 —— 线程挂在
    // request_user_input 上等答案时,用户那句「走 A」被原地退回,界面还说成「我正忙着上一件」。
    // 新契约(27 号文 §11.9 D2):按目标状态选四条通道,在跑 = 插话(steer),不是拒绝。
    ok(busy && busy.ok === true && busy.channel === 'steer',
      `E2 同一目标线程已有在途回合 -> 走插话通道(不再是 steward.busy;got ok=${busy && busy.ok} channel=${busy && busy.channel})`);
    // companion(钉住新契约的另一半):插话【不】开新回合、【不】顶掉在途那个。
    const afterSteer = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', threadId + '.json'), 'utf8'));
    ok(Number(afterSteer.turnSeq) === Number(before.turnSeq) + 1,
      `E2b companion:插话没有再开一个回合(turnSeq 仍是递话那一回合的 ${Number(before.turnSeq) + 1};got ${afterSteer.turnSeq})`);
    ok(Number(busy.queued) >= 1 || busy.injected === true,
      `E2c companion:这句话真的进了在途回合的插话队列(queued=${busy && busy.queued} injected=${busy && busy.injected})`);
    providerDelayMs = 0;
    for (let i = 0; i < 150; i++) {
      const s = await call('steward_thread_status', { sessionId: threadId }, stewardCtx());
      if (s && s.ok && s.activeTurn === false) break;
      await sleep(100);
    }
    const rows = fs.readFileSync(path.join(HOME, 'sessions', threadId + '.messages.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    ok(rows.some(m => m && m.role === 'user' && m.content === relay), 'E3 递话原话直递(逐字,不加任何管家注解)');
    const self = await call('steward_thread_continue', { sessionId: 'sess_nope', message: 'x' }, stewardCtx());
    ok(self && self.error === 'not_found', 'E4 目标不存在 -> not_found');

    // 改名同样受忙锁保护(读改写会用陈旧副本盖掉活回合刚写的消息),等回合彻底收尾再改。
    for (let i = 0; i < 200; i++) {
      const s = await call('steward_thread_status', { sessionId: threadId }, stewardCtx());
      if (s && s.ok && s.activeTurn === false) break;
      await sleep(100);
    }
    const renamed = await call('steward_thread_rename', { sessionId: threadId, title: '季度报告 · 一页纸' }, stewardCtx());
    ok(renamed && renamed.ok === true && renamed.undoRef && renamed.undoRef.previousTitle === '季度报告整理',
      'E5 thread_rename 返回旧标题作 undoRef');
  }

  /* ═════════ (C 续) thread_status / threads_search 正向 ═════════ */
  {
    const st = await call('steward_thread_status', { sessionId: threadId }, stewardCtx());
    ok(st && st.ok === true && st.state && st.permissionMode && Array.isArray(st.pending)
      && typeof st.lastAssistantText === 'string' && st.lastAssistantText.length <= 201,
      'C10 steward_thread_status 返回五态/权限档/待决摘要/最后一句(≤200 字)');
    ok(st && ['dispatching', 'running', 'needs_you', 'done', 'stopped', 'quick_ask'].includes(st.state), 'C10b 五态取值落在真值表内');
    // 116g: thread_status 带出它所属【事项】的身份与聚合态(未归类线程 = 只有它自己一条)。
    ok(st && st.mission && st.mission.missionId === st.missionId && typeof st.mission.title === 'string',
      'C10c thread_status 带 mission:{missionId,title,aggregateState}');
    ok(st && st.mission && st.mission.aggregateState === st.state && st.mission.threadCount === 1 && st.mission.derived === true,
      'C10d 未归类事项的聚合态 === 该线程五态,threadCount=1');
    const found = await call('steward_threads_search', { q: '季度报告' }, stewardCtx());
    ok(found && found.ok === true && found.results.some(r => r.sessionId === threadId), 'C11 steward_threads_search 能按标题/内容找到线程');
    ok(found && found.results.every(r => r.kind !== 'steward'), 'C11b 搜索结果永不包含管家自己的会话');
  }

  /* ═════════ (F) thread_read 配额与预算 ═════════ */
  console.log('── (F) 读预算 ──');
  {
    const okRead = await call('steward_thread_read', { sessionId: threadId, tail: 2, maxChars: 1000 }, stewardCtx('steward-quota'));
    ok(okRead && okRead.ok === true && Array.isArray(okRead.rows) && okRead.quota.callsMax === 6,
      'F1 thread_read 正向返回回合原话行 + 配额账面');
    ok(okRead && okRead.rows.every(r => r.role !== 'tool' || /→ \d+ 字符|不可序列化/.test(r.text)),
      'F1b 工具调用只给一行摘要与结果长度(不给工具输出全文)');
    // 配额:同一 ctx(同会话 + 同回合键)第 7 次必红。
    let quota = null;
    for (let i = 0; i < 6; i++) quota = await call('steward_thread_read', { sessionId: threadId, tail: 1, maxChars: 1000 }, stewardCtx('steward-quota'));
    ok(quota && quota.ok === false && quota.error === 'quota_exceeded', 'F2 每回合第 7 次深读 -> quota_exceeded');
    // 预算:stewardReadBudgetChars=4000;上面的递话是一条 ≥2500 字的真回合,两次全量深读即读满(换一个
    // 桶,避开配额)。第三次必须撞预算而不是配额 —— 两个信封要分得开。
    let budget = null, budgetCalls = 0;
    for (let i = 0; i < 4; i++) {
      budget = await call('steward_thread_read', { sessionId: threadId, tail: 20, maxChars: 12000 }, stewardCtx('steward-budget'));
      budgetCalls += 1;
      if (budget && budget.error === 'budget_exceeded') break;
    }
    ok(budget && budget.ok === false && budget.error === 'budget_exceeded',
      `F3 读满 stewardReadBudgetChars(4000)后 -> budget_exceeded(第 ${budgetCalls} 次;got ${budget && budget.error})`);
    const beforeRows = readDecisions().length;
    await call('steward_thread_read', { sessionId: threadId, tail: 1 }, stewardCtx('steward-read-audit'));
    ok(readDecisions().length === beforeRows, 'F4 深读是只读动作:不写决策日志、不落任何持久化');
  }

  /* ═════════ (G) decide 矩阵 ═════════ */
  console.log('── (G) 决策矩阵 ──');
  {
    const ivFile = path.join(HOME, 'sessions', threadId + '.interventions.ndjson');
    const putIv = (id, extra) => fs.appendFileSync(ivFile, JSON.stringify({
      id, type: 'permission', sessionId: threadId, status: 'pending', requestedAt: new Date().toISOString(),
      decidedAt: '', decidedBy: '', interventionVersion: 0, ...extra,
    }) + '\n', 'utf8');
    putIv('perm_edit', { toolName: 'file_write', tier: 'edit' });
    putIv('perm_exec', { toolName: 'powershell_run', tier: 'exec' });
    putIv('perm_exempt', { toolName: 'send_email', tier: 'read' });

    const decide = (id, patch) => call('steward_decide', { missionId: threadId, interventionId: id, action: 'allow', ...patch }, stewardCtx());

    writeConfig({ permissionMode: 'default' });
    const beforeRows = readDecisions().length;
    const d1 = await decide('perm_edit');
    ok(d1 && d1.ok === false && d1.error === 'propose_required' && d1.reason === 'permission_mode',
      'G1 default(每步都问):edit 级 permission -> propose_required');
    ok(readDecisions().length === beforeRows, 'G1b propose_required 不落决策日志(没做决定就没有决定可记)');

    writeConfig({ permissionMode: 'plan' });
    const d2 = await decide('perm_edit');
    ok(d2 && d2.error === 'propose_required', 'G2 plan(只做计划):一律 propose_required');

    writeConfig({ permissionMode: 'acceptEdits' });
    const d3 = await decide('perm_edit');
    ok(d3 && d3.error !== 'propose_required', 'G3 acceptEdits:edit 级 permission 通过档位门(进入命令核心)');
    const d4 = await decide('perm_exec');
    ok(d4 && d4.error === 'propose_required' && d4.reason === 'permission_mode', 'G4 acceptEdits:exec 级 permission -> propose_required');

    writeConfig({ permissionMode: 'auto' });
    const d5 = await decide('perm_exec');
    ok(d5 && d5.error !== 'propose_required', 'G5 auto(全自动):exec 级 permission 也通过档位门');
    const d6 = await decide('perm_exempt');
    ok(d6 && d6.error === 'propose_required' && d6.reason === 'permanently_exempt',
      'G6 永久豁免(send_email)在全自动档仍 propose_required —— 管家不得替用户按不可撤销的动作');

    const d7 = await decide('iv_nope');
    ok(d7 && d7.error === 'not_found', 'G7 错误 interventionId -> not_found');
    putIv('perm_cas', { toolName: 'file_write', tier: 'edit' });
    const d8 = await decide('perm_cas', { expectedVersion: 999 });
    ok(d8 && d8.error === 'version_conflict', 'G8 版本冲突 -> version_conflict(稳定信封,由命令核心 CAS 判定)');
    const d9 = await call('steward_decide', { missionId: 'sess_nope', interventionId: 'x', action: 'allow' }, stewardCtx());
    ok(d9 && d9.error === 'not_found', 'G9 错误 missionId -> not_found');
  }

  /* ═════════ (H) run_action 口径 ═════════ */
  console.log('── (H) 班组动作 ──');
  {
    writeConfig({ permissionMode: 'acceptEdits' });
    const advance = await call('steward_run_action', { sessionId: threadId, runId: 'run_nope', action: 'resume' }, stewardCtx());
    // 116-2b 验收对齐(Fable):resume/retry_node 按 §3.3 'failed' 档口径,「改文件不问」即可由管家直接做
    // (与 13h 自理侧预闸同口径);同一 commit 内改口径与断言。run_nope 不存在 -> 过档位门后由核心报 run_action_failed。
    ok(advance && advance.error === 'run_action_failed',
      `H1 改文件不问档:resume(失败处置类)过档位门,由核心判定(got ${advance && advance.error})`);
    writeConfig({ permissionMode: 'default' });
    const advanceDefault = await call('steward_run_action', { sessionId: threadId, runId: 'run_nope', action: 'resume' }, stewardCtx());
    ok(advanceDefault && advanceDefault.error === 'propose_required' && advanceDefault.reason === 'permission_mode',
      'H1b 每步都问档:resume -> propose_required');
    writeConfig({ permissionMode: 'acceptEdits' });
    const steer = await call('steward_run_action', { sessionId: threadId, runId: 'run_nope', action: 'steer_node', nodeId: 'n1', message: 'x' }, stewardCtx());
    ok(steer && steer.error === 'propose_required' && steer.reason === 'permission_mode',
      'H1c 改文件不问档:steer_node(改指令类)仍需全自动 -> propose_required');
    const tighten = await call('steward_run_action', { sessionId: threadId, runId: 'run_nope', action: 'pause' }, stewardCtx());
    ok(tighten && tighten.error === 'run_action_failed', 'H2 pause(收紧类)任何档都放行到核心(run 不存在 -> run_action_failed)');
    writeConfig({ permissionMode: 'auto' });
    const advance2 = await call('steward_run_action', { sessionId: threadId, runId: 'run_nope', action: 'resume' }, stewardCtx());
    ok(advance2 && advance2.error !== 'propose_required', 'H3 全自动档:resume 通过档位门');
    const bogus = await call('steward_run_action', { sessionId: threadId, runId: 'run_nope', action: 'explode' }, stewardCtx());
    ok(bogus && bogus.error === 'invalid_request', 'H4 未知动作 -> invalid_request');
  }

  /* ═════════ (I) 记忆最小版 ═════════ */
  console.log('── (I) 管家记忆 ──');
  {
    const rows = fs.readFileSync(path.join(HOME, 'sessions', threadId + '.messages.ndjson'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const userMsg = rows.find(m => m && m.role === 'user' && Number.isFinite(Number(m.turnSeq)));
    const asstMsg = rows.find(m => m && m.role === 'assistant' && Number.isFinite(Number(m.turnSeq)));
    ok(!!userMsg, 'I0 找到一条带 turnSeq 的用户消息作为合法来源');

    const badSource = await call('steward_memory_write', {
      kind: 'preference', text: '用户偏好深色主题',
      sourceRef: { sessionId: threadId, turnSeq: 99999 },
    }, stewardCtx());
    ok(badSource && badSource.error === 'source_not_user', 'I1 来源回合里没有用户消息(工具输出/助手回合)-> source_not_user');

    const sensitive = await call('steward_memory_write', {
      // 只用「api_key: <够长的值>」这一条判据触发敏感过滤;有意【不写】sk- 形状的假 token ——
      // repo-hygiene.e2e.js 会把仓库里任何 sk-[A-Za-z0-9]{20,} 判成真密钥泄漏(测试夹具也不例外)。
      kind: 'profile', text: 'api_key: REDACTEDPLACEHOLDERVALUE',
      sourceRef: { sessionId: threadId, turnSeq: userMsg.turnSeq },
    }, stewardCtx());
    ok(sensitive && sensitive.error === 'sensitive_rejected', 'I2 密钥样文本 -> sensitive_rejected(复用工作台记忆的敏感过滤)');

    const w1 = await call('steward_memory_write', {
      kind: 'preference', text: '用户偏好中文输出并且喜欢一页纸摘要',
      sourceRef: { sessionId: threadId, turnSeq: userMsg.turnSeq },
    }, stewardCtx());
    ok(w1 && w1.ok === true && w1.merged === false && w1.id && w1.undoRef && w1.undoRef.kind === 'memory',
      'I3 首次写入返回 {ok,id,merged:false,undoRef}');
    ok(fs.existsSync(memoryFile) && JSON.parse(fs.readFileSync(memoryFile, 'utf8')).schema === 1,
      'I3b 记忆落 <data>/steward/memory-v1.json(schema 1)');

    const w2 = await call('steward_memory_write', {
      kind: 'preference', text: '用户偏好中文输出并且喜欢一页纸摘要（补充）',
      sourceRef: { sessionId: threadId, turnSeq: userMsg.turnSeq },
    }, stewardCtx());
    ok(w2 && w2.ok === true && w2.merged === true && w2.id === w1.id, 'I4 同义条目合并到既有条目而非新增(词项 Jaccard ≥0.8)');

    const s1 = await call('steward_memory_search', { q: '中文输出' }, stewardCtx());
    ok(s1 && s1.ok === true && s1.entries.some(e => e.id === w1.id), 'I5 memory_search 词法命中');

    const v1 = await call('steward_memory_veto', { id: w1.id }, stewardCtx());
    ok(v1 && v1.ok === true && v1.state === 'vetoed' && v1.undoRef && v1.undoRef.prev === 'active', 'I6 memory_veto 置 vetoed 并带 undoRef.prev');
    const s2 = await call('steward_memory_search', { q: '中文输出' }, stewardCtx());
    ok(s2 && !s2.entries.some(e => e.id === w1.id), 'I7 默认检索不含 vetoed 条目');
    const s3 = await call('steward_memory_search', { q: '中文输出', includeVetoed: true }, stewardCtx());
    ok(s3 && s3.entries.some(e => e.id === w1.id), 'I7b includeVetoed:true 时能看到被否决的条目');

    const w3 = await call('steward_memory_write', {
      kind: 'preference', text: '用户偏好中文输出并且喜欢一页纸摘要',
      sourceRef: { sessionId: threadId, turnSeq: userMsg.turnSeq },
    }, stewardCtx());
    ok(w3 && w3.error === 'vetoed_duplicate', 'I8 被否决过的同义内容拒绝写回 -> vetoed_duplicate');

    const badKind = await call('steward_memory_write', { kind: 'gossip', text: 'x', sourceRef: { sessionId: threadId, turnSeq: userMsg.turnSeq } }, stewardCtx());
    ok(badKind && badKind.error === 'invalid_request', 'I9 kind 不在白名单 -> invalid_request');
    ok(!!asstMsg || true, 'I10 (info) 助手回合存在' + (asstMsg ? '' : '(本轮未落助手消息,不影响判定)'));
  }

  /* ═════════ (J) 决策日志形状 ═════════ */
  console.log('── (J) 决策日志 ──');
  {
    const rows = readDecisions();
    ok(rows.length >= 5, `J1 每个写动作一行决策日志(共 ${rows.length} 行)`);
    const shapeOk = rows.every(r => Number.isInteger(r.seq) && r.at && r.tool && ('undoRef' in r)
      && typeof r.args === 'object' && typeof r.basis === 'object' && typeof r.permissionMode === 'string' && typeof r.mayAct === 'string');
    ok(shapeOk, 'J2 每行字段齐整 {seq,at,tool,args,targetSessionId,permissionMode,mayAct,undoRef,basis}');
    const tools = new Set(rows.map(r => r.tool));
    ok(tools.has('steward_thread_new') && tools.has('steward_thread_continue') && tools.has('steward_thread_rename')
      && tools.has('steward_memory_write') && tools.has('steward_memory_veto'),
      'J3 线程族与记忆族的写动作都落了账');
    ok(rows.some(r => r.tool === 'steward_memory_write' && Array.isArray(r.basis.memoryIds) && r.basis.memoryIds.length),
      'J4 记忆写入的 basis 记下 memoryIds(事后可解释「因为你上次说…」)');
  }

  /* ═════════ (K) 四门:普通会话看不到 steward_* ═════════ */
  console.log('── (K) 四个 offer 面 ──');
  {
    const cfg = srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config;
    const plainTools = srv.buildOpenAiTools(cfg, null, {}).map(t => t.function.name);
    ok(!plainTools.some(n => n.startsWith('steward_')), 'K1 面 1 buildOpenAiTools(普通会话)零 steward_*');
    // 116-2b 重钉:18 → 19(新增 steward_thread_note);116g 再钉:19 → 20(新增 steward_missions);
    // 116h 再钉:20 → 21(新增 steward_thread_prioritize,27 号文 §3.1 116h 行 / §8.10「提升优先级」)。
    // 116-2e 再钉:21 → 26(新增 config_get/config_set/playbook_draft/skill_toggle/quick_ask)。
    ok(srv.buildOpenAiTools(cfg, null, { stewardSession: true }).map(t => t.function.name).filter(n => n.startsWith('steward_')).length === 26,
      'K1b 面 1 管家会话拿到全部 26 个');
    const cat = await srv.adaptiveCatalogForMcp(cfg);
    const catNames = (cat.catalog.tools || cat.catalog || []).map(t => t.name || (t.function && t.function.name));
    ok(!catNames.some(n => String(n).startsWith('steward_')), 'K2 面 3 adaptive 目录(普通会话)零 steward_*');
  }

  // 面 2(MCP tools/list 桥)与面 4(/api/status)要真进程:一个 MCP 子进程 + 一个真服务。
  {
    const mcpOut = await new Promise(resolve => {
      const child = cp.spawn(process.execPath, [SERVER, 'mcp'], { cwd: path.join(WB, 'app'), env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
      let out = '';
      const timer = setTimeout(() => { kill(child); resolve(out); }, 25000);
      child.stdout.on('data', d => {
        out += String(d);
        if (out.includes('"tools"')) { clearTimeout(timer); kill(child); resolve(out); }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
      setTimeout(() => { try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n'); } catch {} }, 800);
    });
    ok(mcpOut.includes('"tools"'), 'K3 面 2 MCP 子进程返回 tools/list');
    ok(mcpOut.includes('"tools"') && !mcpOut.includes('steward_'), 'K3b 面 2 MCP tools/list(未注入 WCW_SESSION_KIND)零 steward_*');
  }
  {
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
      cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
    });
    wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
    try {
      let status = null;
      for (let i = 0; i < 80 && !status; i++) {
        await sleep(150);
        status = await new Promise(resolve => {
          let token = ''; try { token = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
          const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/status', method: 'GET', headers: token ? { 'x-wcw-token': token } : {} },
            res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve(null); } }); });
          req.on('error', () => resolve(null));
          req.end();
        });
      }
      ok(status && Array.isArray(status.tools) && status.tools.length > 0, 'K4 面 4 /api/status 返回工具清单');
      ok(status && Array.isArray(status.tools) && !status.tools.some(t => String(t.name).startsWith('steward_')),
        'K4b 面 4 /api/status 工具清单零 steward_*(它是给用户看的会话工具目录)');
    } finally { kill(wb); }
  }
} finally {
  try { providerServer.close(); } catch {}
}

console.log('');
if (fail) { console.log(`STEWARD TOOLS E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD TOOLS E2E: ALL PASS');
process.exit(0);
})();
