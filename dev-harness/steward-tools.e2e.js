require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
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
//  (N) 117w-W1 提交①②(27 号文 §11.19.4)cwd 三态:表内 -> 用表里那一行的归一化值(斜杠/大小写两种
//      写法各一次);其它 -> invalid_request 且不静默回落(表外 / `~` / 主目录 / 只在 recentWorkspaces
//      里的 / 相对路径),thread_new 与 quick_ask 共用一份校验;省略 -> 提交② 起在 Ruyi 根下派生
//      <root>/<slug(标题)> 并登记进 workspaces[] 末尾(带 note),撞名 -2、空目录复用、标题全非法字符
//      回落 thread-<id>,外加「cwdWarning 对它静默 / defaultWorkspace 没被顶掉」两条反向保护。
//  (P) 117w-W1④(§11.19.8 债表第一行)workspaces[] 的行数帽子 20 -> 64:63 行派生成功且第 64 行
//      落盘;64 行时派生【拒开线程】(invalid_request / workspace_table_full)、不建目录、表不动
//      —— 二者必居其一,不许「目录建了、行没了」;25 行的表经得过清洗,折叠句因此生产可达。
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
    // 117m-A4 再钉:26 → 27(新增 steward_thread_stop,§11.10 用户第六轮走查第 ③ 条 —— 管家原先只有
    // 班组级的 run_action,普通线程没有 runId 必然 invalid_request)。重钉的同时把这条从【只数个数】
    // 换成【逐名对账】:个数对但少一个多一个的错法从此也会红。
    const stewardOffered = srv.buildOpenAiTools(cfg, null, { stewardSession: true }).map(t => t.function.name).filter(n => n.startsWith('steward_')).sort();
    ok(stewardOffered.length === 27, `K1b 面 1 管家会话拿到全部 27 个(got ${stewardOffered.length})`);
    const stewardRegistered = Object.keys(srv.TOOL_HANDLERS).filter(n => n.startsWith('steward_')).sort();
    ok(JSON.stringify(stewardOffered) === JSON.stringify(stewardRegistered),
      `K1c offer 出去的那一份与 12 的注册表【逐名】相同(缺: ${stewardRegistered.filter(n => !stewardOffered.includes(n)).join(',') || '无'};多: ${stewardOffered.filter(n => !stewardRegistered.includes(n)).join(',') || '无'})`);
    ok(stewardOffered.includes('steward_thread_stop'), 'K1d 117m-A4:线程级停止真的 offer 给了管家(否则模型手里仍然只有 run_action)');
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
  /* ═════════ (N) 117w-W1 提交①:cwd 校验先行(27 号文 §11.19.4)═════════ */
  // 修前:13k 两处把 args.cwd 原样透传给 createSession(零校验),幻觉路径会被直接接受并落进
  // 线程的 cwd。修后三态:省略 → 照旧回落;表内 → 用表里那一行的归一化值;其它 → invalid_request。
  // 每一条都在下面【反向验过】(见 117w-W1 交付报告:把校验注释掉后 N2/N3/N5/N6/N7/N8 全部翻红)。
  console.log('── (N) cwd 校验先行 ──');
  {
    const WS_ALPHA = path.join(HOME, 'ws-alpha');
    const WS_BETA = path.join(HOME, 'ws-beta');
    const WS_RECENT_ONLY = path.join(HOME, 'ws-recent-only');
    // 117w-W1 ②:Ruyi 根【必须】指到夹具的临时 HOME 里。出厂默认是 ~/Ruyi(真实主目录),不覆盖
    // 就会在跑测试的人的机器上真建目录 —— 那是污染,不是覆盖。
    const RUYI_ROOT = path.join(HOME, 'Ruyi');
    for (const d of [WS_ALPHA, WS_BETA, WS_RECENT_ONLY]) fs.mkdirSync(d, { recursive: true });
    // HOME 放在第 0 位:01-config 的清洗会把 defaultWorkspace 同步成 workspaces[0].path,
    // 放别的在前面会把 N14b「defaultWorkspace 仍等于 workspaces[0].path」那条锁的比较对象换掉。
    // recentWorkspaces 里那一条【有意】不进 workspaces —— 打开过 ≠ 授权过(§11.19.2 红线)。
    const baseWorkspaces = () => ([
      { path: HOME, read: true, write: true, execute: true },
      { path: WS_ALPHA, read: true, write: true, execute: true },
      { path: WS_BETA, read: true, write: true, execute: true },
    ]);
    writeConfig({
      permissionMode: 'default',
      stewardWorkspaceRoot: RUYI_ROOT,
      workspaces: baseWorkspaces(),
      recentWorkspaces: [WS_RECENT_ONLY],
    });
    const headOf = sid => JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', sid + '.json'), 'utf8'));
    const readCfg = () => srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config;
    const newThread = (cwd, tag) => call('steward_thread_new', {
      title: 'cwd 锁 ' + tag, ...(cwd === undefined ? {} : { cwd }),
      brief: { userText: 'cwd 锁 ' + tag },
    }, stewardCtx('cwd-' + tag));
    const effectiveDefault = readCfg().defaultWorkspace;

    // N1/N2 —— 省略 cwd:117w-W1 ② 起【不再】回落 defaultWorkspace,而是在 Ruyi 根下按标题派生一条
    // 属于这条线程自己的子工作区。修前十几条线程全挤在主目录根上,而仓里自己的 03 cwdWarning 恰恰把
    // 「cwd 落在主目录根」判成最高风险目标 —— 这条锁钉的就是那个病灶被治好。
    const omitted = await newThread(undefined, 'omit');
    ok(omitted && omitted.ok === true, 'N1 省略 cwd 仍然照常开线程');
    const omittedCwd = omitted && omitted.ok ? headOf(omitted.sessionId).cwd : '';
    ok(omittedCwd === path.join(RUYI_ROOT, 'cwd 锁 omit'),
      `N2 省略 cwd -> 线程 cwd == <Ruyi 根>/<slug(标题)>(want ${path.join(RUYI_ROOT, 'cwd 锁 omit')};got ${omittedCwd})`);
    ok(omittedCwd !== effectiveDefault, 'N2b 省略 cwd 不再落在 defaultWorkspace 上(这一刀改掉的正是它)');
    ok(fs.existsSync(omittedCwd) && fs.statSync(omittedCwd).isDirectory(), 'N2c 派生出来的目录真的建出来了');
    {
      const rows = readCfg().workspaces;
      const last = rows[rows.length - 1];
      ok(last && last.path === omittedCwd && last.note === 'Ruyi 自动开的'
        && last.read === true && last.write === true && last.execute === true,
        `N2d 派生目录登记进 workspaces[] 【末尾】且带 note(got ${JSON.stringify(last)})`);
      ok(rows[0].path === HOME, 'N2e 派生追加在末尾,没有顶掉 workspaces[0](defaultWorkspace 的同步源)');
    }
    // N2f —— 派生出来的路径立刻就是【表内路径】:再传一次它,走的是三态的第 ② 态而不是被拒。
    const reuseDerived = await newThread(omittedCwd, 'reuse-derived');
    ok(reuseDerived && reuseDerived.ok === true && headOf(reuseDerived.sessionId).cwd === omittedCwd,
      'N2f 派生目录进表之后,把它当 cwd 传回来 -> 命中表内(闭环)');

    // N3 —— 表内路径原样:线程 cwd 就是表里那一行。
    const inTable = await newThread(WS_ALPHA, 'alpha');
    ok(inTable && inTable.ok === true && headOf(inTable.sessionId).cwd === WS_ALPHA,
      'N3 表内路径 -> 线程 cwd 等于表里那个归一化值');

    // N4 —— 同一个表内路径,换【斜杠写法】(正斜杠 + 尾斜杠):归一化后仍然命中,且回的是表里那一行。
    const slashy = await newThread(WS_BETA.replace(/\\/g, '/') + '/', 'slash');
    ok(slashy && slashy.ok === true && headOf(slashy.sessionId).cwd === WS_BETA,
      `N4 表内路径换正斜杠/尾斜杠写法 -> 仍命中,cwd 归一到 ${WS_BETA}(got ${slashy && slashy.ok ? headOf(slashy.sessionId).cwd : JSON.stringify(slashy)})`);

    // N5 —— 换【大小写】。win32 上文件系统不区分大小写、01-config 的去重键也是 toLowerCase,
    // 所以这里折大小写比较;非 win32 上文件系统真区分,同一个字符串折成两个目标才是对的。
    const cased = await newThread(WS_ALPHA.toLowerCase(), 'case');
    if (process.platform === 'win32') {
      ok(cased && cased.ok === true && headOf(cased.sessionId).cwd === WS_ALPHA,
        `N5 (win32)表内路径换小写 -> 仍命中,cwd 回的是表里那一行的原样大小写(got ${cased && cased.ok ? headOf(cased.sessionId).cwd : JSON.stringify(cased)})`);
    } else {
      ok(cased && cased.ok === false && cased.error === 'invalid_request',
        'N5 (非 win32)大小写不同视为两个目标 -> invalid_request');
    }

    // N6 —— 表外路径:拒,且错误文案里要有表内候选的【末段名】(模型据此改对,又不泄露全路径)。
    const outside = await newThread(path.join(HOME, 'ws-not-registered'), 'outside');
    ok(outside && outside.ok === false && outside.error === 'invalid_request' && outside.reason === 'cwd_not_in_workspaces',
      `N6 表外路径 -> invalid_request(reason cwd_not_in_workspaces;got ${JSON.stringify(outside && outside.error)})`);
    ok(outside && String(outside.message || '').includes('ws-alpha') && String(outside.message || '').includes('ws-beta')
      && String(outside.message || '').includes(path.basename(HOME)),
      `N6b 错误文案列出表内候选的末段名(got ${JSON.stringify(outside && outside.message)})`);
    ok(!fs.existsSync(path.join(HOME, 'ws-not-registered')),
      'N6c 被拒时零副作用:没有建目录、没有开线程');

    // N7 —— `~` 与主目录:两种写法都在「其它」档里。仓里自己的 03 cwdWarning 把主目录判成最高
    // 风险目标,所以 §11.19.3 明确【不】给 `~` 开口子。
    const tilde = await newThread('~', 'tilde');
    ok(tilde && tilde.ok === false && tilde.error === 'invalid_request', "N7 cwd 传 '~' -> invalid_request(`~` 不是合法值)");
    const homeDir = await newThread(os.homedir(), 'home');
    ok(homeDir && homeDir.ok === false && homeDir.error === 'invalid_request',
      `N7b cwd 传 os.homedir() -> invalid_request(主目录不在表里就不许用;got ${JSON.stringify(homeDir && homeDir.error)})`);

    // N8 —— recentWorkspaces 里有、workspaces 里没有:拒。打开过 ≠ 授权过。
    const recentOnly = await newThread(WS_RECENT_ONLY, 'recent');
    ok(recentOnly && recentOnly.ok === false && recentOnly.error === 'invalid_request',
      `N8 只在 recentWorkspaces 里的路径 -> invalid_request(打开过 ≠ 授权过;got ${JSON.stringify(recentOnly && recentOnly.error)})`);

    // N9 —— 相对路径:拒。放行等于让 path.resolve 按【服务进程的 cwd】补全,那是一条无声的越权路。
    const relative = await newThread('ws-alpha', 'rel');
    ok(relative && relative.ok === false && relative.error === 'invalid_request', 'N9 相对路径 -> invalid_request');

    // N10 —— quick_ask 走【同一份】校验:同样的三态,同样的稳定信封。
    const qBad = await call('steward_quick_ask', { question: 'cwd 锁:表外', cwd: path.join(HOME, 'ws-not-registered') }, stewardCtx('cwd-q1'));
    ok(qBad && qBad.ok === false && qBad.error === 'invalid_request' && qBad.reason === 'cwd_not_in_workspaces',
      'N10 quick_ask 表外路径 -> invalid_request(与 thread_new 同一份校验)');
    const qTilde = await call('steward_quick_ask', { question: 'cwd 锁:波浪号', cwd: '~' }, stewardCtx('cwd-q2'));
    ok(qTilde && qTilde.ok === false && qTilde.error === 'invalid_request', "N10b quick_ask 传 '~' -> invalid_request");
    const qGood = await call('steward_quick_ask', { question: 'cwd 锁:表内', cwd: WS_BETA }, stewardCtx('cwd-q3'));
    ok(qGood && qGood.ok === true && headOf(qGood.sessionId).cwd === WS_BETA,
      `N10c quick_ask 表内路径 -> 线程 cwd 等于表里那一行(got ${qGood && qGood.ok ? headOf(qGood.sessionId).cwd : JSON.stringify(qGood)})`);
    const qOmit = await call('steward_quick_ask', { question: 'cwd 锁:省略' }, stewardCtx('cwd-q4'));
    ok(qOmit && qOmit.ok === true && headOf(qOmit.sessionId).cwd === path.join(RUYI_ROOT, 'cwd 锁:省略'.replace(/:/g, '_')),
      `N10d quick_ask 省略 cwd -> 同样派生子工作区(问题原话当标题,冒号被换成 _;got ${qOmit && qOmit.ok ? headOf(qOmit.sessionId).cwd : JSON.stringify(qOmit)})`);

    /* ── 117w-W1 提交②:派生的三条判据(§11.19.2)—— 撞名 / 空目录复用 / slug 回落 ── */
    // N11 —— 同标题第二条:第一条的目录【非空】(N2 那条线程正在里面跑,而且我们下面先塞个文件
    // 保证它一定非空)→ 派生 -2。「非空才让位」是设计里明写的:同一件事重开线程不该长出第二个空壳。
    // 护栏:下面 N12 要把 omittedCwd 【清空】。派生要是哪天静默失效,omittedCwd 就会是夹具的
    // 临时 HOME 本身,那一句 rmSync 会把 config.json 和整个 sessions 目录一起删掉,后面几十条锁
    // 于是变成一片 steward.disabled —— 真红被伪装成别的病。所以先钉死「它必须在 Ruyi 根之下」。
    ok(omittedCwd.startsWith(RUYI_ROOT + path.sep),
      `N11a(护栏)派生路径落在 Ruyi 根之下,清空它才是安全的(got ${omittedCwd})`);
    fs.writeFileSync(path.join(omittedCwd, 'report.md'), 'x', 'utf8');
    const dup2 = await newThread(undefined, 'omit');
    const dup2Cwd = dup2 && dup2.ok ? headOf(dup2.sessionId).cwd : '';
    ok(dup2Cwd === path.join(RUYI_ROOT, 'cwd 锁 omit-2'),
      `N11 同标题第二条 -> <slug>-2(want ${path.join(RUYI_ROOT, 'cwd 锁 omit-2')};got ${dup2Cwd})`);
    ok(fs.existsSync(dup2Cwd), 'N11b -2 目录真的建出来了');
    // N12 —— 把第一条的目录【清空】,再开第三条:直接【复用】第一条,不长出 -3。
    if (omittedCwd.startsWith(RUYI_ROOT + path.sep)) {
      for (const name of fs.readdirSync(omittedCwd)) fs.rmSync(path.join(omittedCwd, name), { recursive: true, force: true });
    }
    const dup3 = await newThread(undefined, 'omit');
    const dup3Cwd = dup3 && dup3.ok ? headOf(dup3.sessionId).cwd : '';
    ok(dup3Cwd === omittedCwd,
      `N12 第一条目录清空后再开 -> 【复用】第一条,不长 -3(want ${omittedCwd};got ${dup3Cwd})`);
    ok(!fs.existsSync(path.join(RUYI_ROOT, 'cwd 锁 omit-3')), 'N12b 没有凭空长出 -3');
    // N12c —— 复用不重复登记:workspaces 里 <slug> 那一行仍然只有一行。
    {
      const hits = readCfg().workspaces.filter(w => String(w.path).toLowerCase() === omittedCwd.toLowerCase());
      ok(hits.length === 1, `N12c 复用同一个目录不重复登记进 workspaces(got ${hits.length} 行)`);
    }
    // N13 —— 标题整条都是非法字符(尖括号/冒号/引号/斜杠/竖线/问号/星号)→ slug 空 → 回落 thread-<id>。
    // 用【去掉 sess_ 前缀之后】的 8 位:id 是 sess_+16 位十六进制,直接切前 8 位只剩 3 位有效字符。
    const nasty = await call('steward_thread_new', {
      title: '<>:"/\\|?*', brief: { userText: '全是非法字符的标题' },
    }, stewardCtx('cwd-nasty'));
    const nastyCwd = nasty && nasty.ok ? headOf(nasty.sessionId).cwd : '';
    const nastyWant = path.join(RUYI_ROOT, 'thread-' + String(nasty && nasty.sessionId).replace(/^sess_/, '').slice(0, 8));
    ok(nastyCwd === nastyWant, `N13 标题全非法字符 -> thread-<id 8 位>(want ${nastyWant};got ${nastyCwd})`);
    ok(!/[<>:"/\\|?*]/.test(path.basename(nastyCwd)), 'N13b 派生出来的目录名里零 Windows 非法字符');
    // N13c —— 中文标题原样保留(slug 只做文件系统安全,不做 ASCII 化)。
    const zh = await call('steward_thread_new', {
      title: '英伟达分析', brief: { userText: '看一下英伟达' },
    }, stewardCtx('cwd-zh'));
    ok(zh && zh.ok === true && headOf(zh.sessionId).cwd === path.join(RUYI_ROOT, '英伟达分析'),
      `N13c 中文标题原样进目录名(got ${zh && zh.ok ? headOf(zh.sessionId).cwd : JSON.stringify(zh)})`);

    /* ── N14 反向保护:派生的目标不是「高风险目录」,且默认工作区没被顶掉 ── */
    ok(srv.cwdWarning(omittedCwd) === null,
      `N14 cwdWarning(<Ruyi 根>/<slug>) === null(它是主目录的子目录,不是 03 点名的四个根之一)`);
    ok(srv.cwdWarning(os.homedir()) !== null,
      'N14a 反向:cwdWarning(主目录) 仍然报警 —— 这条锁没被写成恒 null');
    {
      const cfg = readCfg();
      ok(cfg.defaultWorkspace === cfg.workspaces[0].path,
        `N14b defaultWorkspace 仍然等于 workspaces[0].path(${cfg.defaultWorkspace} / ${cfg.workspaces[0].path})`);
      ok(cfg.defaultWorkspace === HOME, 'N14c 派生了这么多次,用户的默认工作区一个字都没变');
      ok(cfg.workspaces.filter(w => w.note === 'Ruyi 自动开的').every(w => String(w.path).startsWith(RUYI_ROOT)),
        'N14d 带「Ruyi 自动开的」备注的行全都在 Ruyi 根下(没有给根外目录加备注)');
      ok(cfg.workspaces.slice(0, 3).every(w => !('note' in w)),
        'N14e 用户原有那三行没有被加上 note(只写新追加的那一行)');
    }
  }

  /* ═════════ (O) 117w-W1 提交③:候选表进上下文(27 号文 §11.19.2)═════════ */
  // 修前:workspaces 在 06i 的 forbidden 清册里,管家【读不到】表,于是从不传 cwd,一切落到默认
  // 工作区。这一段钉的是「有得可选」——到访层多了一份【只读投影】,而三个围栏键仍然一个都改不了。
  // 驱动的是真装配函数 buildStewardSystemPrompt(09 的分叉入口本身),不是复刻一份渲染。
  console.log('── (O) 工作区候选表进上下文 ──');
  {
    const WS_RO = path.join(HOME, 'ws-readonly');
    const WS_NOTE = path.join(HOME, 'ws-noted');
    const WS_HIDDEN = path.join(HOME, 'ws-recent-hidden');
    writeConfig({
      configSchema: 11,                      // ≥10:关掉「空表就从 defaultWorkspace 播种」那条一次性迁移
      stewardWorkspaceRoot: path.join(HOME, 'Ruyi'),
      workspaces: [
        { path: HOME, read: true, write: true, execute: true },
        { path: WS_NOTE, read: true, write: true, execute: true, note: '股票资料' },
        { path: WS_RO, read: true, write: false, execute: true },
      ],
      recentWorkspaces: [WS_HIDDEN],
      allowOutsideWorkspace: true,           // 有意打开:围栏字段【就算是 true】也不许进上下文
      additionalDirectories: [path.join(HOME, 'ws-extra')],
    });
    const stewardSession = { id: 'steward', kind: 'steward', providerHistory: [] };
    // srv 不导出 readConfig(它是内部原语);与 N 段同款,直接读盘 + normalizeConfig 拿到归一化配置。
    const cfgNow = () => srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config;
    const built = await srv.buildStewardSystemPrompt(stewardSession, cfgNow(), {});
    const volatileText = String((built && built.volatile) || '');
    const stableText = String((built && built.stable) || '');
    const tableBlock = (volatileText.split('\n\n').find(seg => seg.includes('以下是你可以交给线程用的工作区')) || '');

    ok(!!tableBlock, 'O1 管家上下文(易变层)里有工作区候选表');
    ok(tableBlock.includes('· ' + path.basename(WS_NOTE)) && tableBlock.includes('· ' + path.basename(WS_RO)),
      'O1b 表里逐行是路径的【末段名】');
    ok(!stableText.includes('以下是你可以交给线程用的工作区'),
      'O1c 表在【易变层】,不在 stable —— stable 是版本级常量,吃前缀缓存,工作区是用户随时会改的东西');

    // O2 —— 只读标。write:false 的那一行标「只读」,可写的行不标(§11.19.7 裁决:校验层先不拒,
    // 但要让管家看得见,免得它把写活派进一个只能读的文件夹)。
    const rowOf = name => (tableBlock.split('\n').find(l => l.startsWith('· ' + name)) || '');
    ok(rowOf(path.basename(WS_RO)).includes('(只读)'), `O2 write:false 的行标「只读」(got ${JSON.stringify(rowOf(path.basename(WS_RO)))})`);
    ok(!rowOf(path.basename(WS_NOTE)).includes('(只读)'), 'O2b 可写的行不标只读(反向)');
    ok(rowOf(path.basename(WS_NOTE)).includes('(股票资料)'), `O2c note 跟在末段名后面(got ${JSON.stringify(rowOf(path.basename(WS_NOTE)))})`);

    // O3 —— 零围栏字段。表是【投影】不是转储:allowOutsideWorkspace 此刻是 true、additionalDirectories
    // 非空,两者都不许出现在整段上下文里(管家看得见围栏开关就等于知道往哪推)。
    for (const fence of ['allowOutsideWorkspace', 'additionalDirectories', 'recentWorkspaces']) {
      ok(!tableBlock.includes(fence), `O3 候选表里零「${fence}」`);
      ok(!volatileText.includes(fence), `O3b 整段易变层里零「${fence}」`);
    }
    // O3c —— 连全路径都不投影:末段名足够让模型选对,全路径是围栏信息。
    ok(!tableBlock.includes(WS_RO) && !tableBlock.includes(HOME),
      'O3c 表里只有末段名,没有任何一条全路径');

    // O4 —— recentWorkspaces 里有、workspaces 里没有的 → 不在表里。打开过 ≠ 授权过。
    ok(!tableBlock.includes(path.basename(WS_HIDDEN)) && !volatileText.includes(path.basename(WS_HIDDEN)),
      'O4 只在 recentWorkspaces 里的目录不进表(打开过 ≠ 授权过)');

    // O5 —— 折叠。这里直接把 25 行喂给装配函数,验的是投影【自己】的预算行为(超出折叠、不截断),
    // 与配置层能不能存下 25 行无关。
    // 【117w-W1④ 更新】原注写「25 行经不过 normalizeConfig,生产路径上折叠句不可达」——那是帽子还
    // 在 20 时的事实。帽子抬到 64 之后 25 行的表经得过清洗,折叠句在生产形状下可达,那一条由 (P) 段
    // 的 P5/P5b 走真 writeConfig 钉住;本条继续只钉投影函数自己。
    {
      const many = [];
      for (let i = 1; i <= 25; i++) many.push({ path: path.join(HOME, 'many-' + i), read: true, write: true, execute: true });
      const cfgMany = { ...(cfgNow()), workspaces: many };
      const builtMany = await srv.buildStewardSystemPrompt(stewardSession, cfgMany, {});
      const blockMany = (String(builtMany.volatile).split('\n\n').find(seg => seg.includes('以下是你可以交给线程用的工作区')) || '');
      const listed = blockMany.split('\n').filter(l => l.startsWith('· '));
      ok(listed.length === 20, `O5 表最多 20 行(got ${listed.length})`);
      ok(blockMany.includes('另有 5 个工作区未列出'),
        `O5b 超出的 5 个折叠成一句,不截断(got ${JSON.stringify(blockMany.split('\n').find(l => l.includes('未列出')) || '(没有折叠句)')})`);
      // 用 String(listed[i]) 而不是 listed[i].startsWith:表被整段拿掉时 listed 是空数组,
      // 裸下标会抛 TypeError 把整件 e2e 打断在这里 —— 后面 O6/O7 那些锁就再也不报了,
      // 一次真红被伪装成一次崩溃。断言要红,不要炸。
      ok(String(listed[0]).startsWith('· many-1') && String(listed[19]).startsWith('· many-20'),
        'O5c 折叠是从尾部折的(前 20 行按表里的优先级顺序原样列出)');
    }

    // O6 —— 两处上限【是同一个数字】(§11.19.7 裁决)。提交① 落地时 13k 的拒绝文案上限是 8、
    // 候选表投影是 20:模型在上下文里看得见 20 行,被拒时只被提醒 8 个,它会合理推断「另外 12 个
    // 不能用」然后去编路径。
    // 【为什么夹具必须是 20 行】3 行的夹具下两边都会列 3 个,常量分叉与否都绿 —— 那是假锁。
    // 20 恰好【踩在】STEWARD_WORKSPACE_TABLE_MAX 上:上限一旦被改小(比如退回 8),文案侧会只列
    // 8 个并追加「另有 12 个未列出」,这条与下面的 O6b 一起红。
    // 【117w-W1④ 更新】原注写「01-config 截 20 行,所以 20 是这条路径上能造出的最大表」——帽子抬到
    // 64 之后不再成立(表能到 64)。「有人把上限改【大】」那一半仍由 steward-tools.static ⑨ 的源码锁管。
    {
      const twenty = [];
      for (let i = 1; i <= 20; i++) twenty.push({ path: path.join(HOME, 'align-' + i), read: true, write: true, execute: true });
      writeConfig({ configSchema: 11, stewardWorkspaceRoot: path.join(HOME, 'Ruyi'), workspaces: twenty, recentWorkspaces: [] });
      ok(cfgNow().workspaces.length === 20, `O6(前提)夹具真有 20 行进了配置(got ${cfgNow().workspaces.length})`);
      const rejected = await call('steward_thread_new', {
        title: '上限对齐', cwd: path.join(HOME, 'nowhere-at-all'), brief: { userText: '上限对齐' },
      }, stewardCtx('table-align'));
      const msg = String((rejected && rejected.message) || '');
      const listedInMsg = (msg.split('表里现有:')[1] || '').split('。')[0].split(/[、,]/).filter(Boolean);
      const builtAlign = await srv.buildStewardSystemPrompt(stewardSession, cfgNow(), {});
      const blockAlign = (String(builtAlign.volatile).split('\n\n').find(seg => seg.includes('以下是你可以交给线程用的工作区')) || '');
      const listedInTable = blockAlign.split('\n').filter(l => l.startsWith('· '));
      ok(rejected && rejected.ok === false, 'O6a 20 行表 + 表外 cwd 仍然被拒');
      ok(listedInMsg.length === listedInTable.length && listedInTable.length === 20,
        `O6 拒绝文案列出的候选数 == 候选表的行数 == 20(文案 ${listedInMsg.length} / 表 ${listedInTable.length})`);
      ok(!msg.includes('未列出') && !blockAlign.includes('未列出'),
        'O6b 20 行【正好】不触发折叠 —— 两处的边界也是同一个数(任一处改小,上一条与这一条一起红)');
    }

    // O7 —— 表为空又给了 cwd(提交① 登记的债,归本提交补锁):文案要说「一个工作区都没有登记」
    // 并让模型【省掉 cwd】,而不是甩一句空的「表里现有:」。
    {
      writeConfig({ configSchema: 11, stewardWorkspaceRoot: path.join(HOME, 'Ruyi'), workspaces: [], recentWorkspaces: [] });
      const emptyCfg = cfgNow();
      ok(Array.isArray(emptyCfg.workspaces) && emptyCfg.workspaces.length === 0,
        'O7(前提)configSchema ≥ 10 时空表【不】被 defaultWorkspace 播种回去');
      const rejectedEmpty = await call('steward_thread_new', {
        title: '空表', cwd: path.join(HOME, 'nowhere-at-all'), brief: { userText: '空表' },
      }, stewardCtx('table-empty'));
      const emptyMsg = String((rejectedEmpty && rejectedEmpty.message) || '');
      ok(rejectedEmpty && rejectedEmpty.ok === false && rejectedEmpty.error === 'invalid_request'
        && rejectedEmpty.reason === 'cwd_not_in_workspaces',
        'O7b 表为空 + 表外 cwd -> 仍是同一个稳定信封');
      ok(emptyMsg.includes('一个工作区都没有登记') && emptyMsg.includes('省掉 cwd') && !emptyMsg.includes('表里现有'),
        `O7c 空表那支文案说清「一个都没有,请省掉 cwd」,不甩空清单(got ${JSON.stringify(emptyMsg)})`);
      // O7d —— 空表时候选表投影输出的是「还没有登记任何工作区」,不是一个只有表头的空壳。
      const builtEmpty = await srv.buildStewardSystemPrompt(stewardSession, emptyCfg, {});
      ok(String(builtEmpty.volatile).includes('(还没有登记任何工作区)'),
        'O7d 空表时投影明说「还没有登记任何工作区」');
    }
  }

  /* ═════════ (P) 117w-W1④:workspaces[] 的行数帽子(27 号文 §11.19.8 债表第一行)═════════ */
  // 修前:01-config 对 workspaces[] 的帽子是 20 行,而 117w-W1② 起工作台【自己】会往表里追加派生
  // 行。用户已有 20 个工作区时,派生行在下一次 normalizeConfig 就被截掉 —— 目录建了、行没了,线程
  // 的 cwd 指向表外目录,再拿它当 cwd 会被拒。修后:帽子 64,且派生【之前】先算超不超帽,会超就
  // fail-closed 拒开线程(不建目录、不写表)。
  // 本段的核心断言是 P2c/P3c 那一对:【帽满时派生要么行落盘、要么拒,二者必居其一】,不许有中间态。
  // 反向实测(修前 = 帽子 20 且无帽检查):P1/P1b/P2c/P3/P3b/P3c/P4/P5/P5b 九条红,
  // 其中 P2b「目录建出来了」仍绿而 P2c「第 64 行落盘」红 —— 那正是「目录建了、行没了」的形状。
  console.log('── (P) 工作区表行数帽子 ──');
  {
    const RUYI_CAP_ROOT = path.join(HOME, 'Ruyi-cap');
    const capCfg = () => srv.normalizeConfig(JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'))).config;
    const capHead = sid => JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', sid + '.json'), 'utf8'));
    const capRows = n => {
      const rows = [];
      for (let i = 1; i <= n; i++) rows.push({ path: path.join(HOME, 'cap-' + i), read: true, write: true, execute: true });
      return rows;
    };
    const capWrite = rows => writeConfig({
      configSchema: 11, stewardWorkspaceRoot: RUYI_CAP_ROOT, workspaces: rows, recentWorkspaces: [],
    });
    // 派生目录都落在 Ruyi 根下 —— 用绝对路径判,不用字符串 startsWith(别把 Ruyi-cap2 误判进来)。
    const capInRoot = p => !!p && path.resolve(p).startsWith(path.resolve(RUYI_CAP_ROOT) + path.sep);
    // 回落链的落点是 createSession 的 `cwd || defaultWorkspace || homedir`;capWrite 每写一次配置,
    // 01-config 的清洗就把 defaultWorkspace 同步成 workspaces[0].path(见 P6/P6b)—— 所以断言要拿
    // 【当前配置里的 defaultWorkspace】,不能写死成夹具的 HOME。
    const capDefaultWs = () => capCfg().defaultWorkspace;
    fs.mkdirSync(path.join(HOME, 'cap-1'), { recursive: true });

    // P1 —— 帽子本身抬到了 64:63 行原样进得去(修前只剩 20 行)。
    capWrite(capRows(63));
    ok(capCfg().workspaces.length === 63, `P1 63 行的表原样通过清洗(got ${capCfg().workspaces.length};修前帽子 20)`);
    // P1b —— 帽子【是 64,不是无界】:65 行正好被截到 64。
    capWrite(capRows(65));
    ok(capCfg().workspaces.length === 64, `P1b 65 行被截到 64(帽子仍在,只是抬高了;got ${capCfg().workspaces.length})`);

    // P2 —— 63 行 + 省略 cwd:派生成功,第 64 行【落盘】。
    capWrite(capRows(63));
    const capOk = await call('steward_thread_new', {
      title: '帽子 63', brief: { userText: '帽子 63' },
    }, stewardCtx('cap-63'));
    ok(capOk && capOk.ok === true, `P2 63 行表 + 省略 cwd -> 照常开线程(got ${JSON.stringify(capOk && capOk.error)})`);
    const capDerived = capOk && capOk.ok ? capHead(capOk.sessionId).cwd : '';
    ok(capDerived === path.join(RUYI_CAP_ROOT, '帽子 63'),
      `P2a 线程 cwd == <Ruyi 根>/<slug>(want ${path.join(RUYI_CAP_ROOT, '帽子 63')};got ${capDerived})`);
    ok(!!capDerived && fs.existsSync(capDerived), 'P2b 派生目录真的建出来了');
    {
      const rows = capCfg().workspaces;
      const last = rows[rows.length - 1];
      ok(rows.length === 64 && String(last && last.path) === capDerived && (last && last.note) === 'Ruyi 自动开的',
        `P2c 第 64 行【落盘】了,不是被帽子吞掉(表 ${rows.length} 行;末行 ${JSON.stringify(last)})`);
    }

    // P3 —— 64 行 + 省略 cwd:fail-closed 拒开线程,目录不建、表不动。
    capWrite(capRows(64));
    const CAP_FULL_TITLE = '帽子 64';
    const capRefused = await call('steward_thread_new', {
      title: CAP_FULL_TITLE, brief: { userText: CAP_FULL_TITLE },
    }, stewardCtx('cap-64'));
    ok(capRefused && capRefused.ok === false && capRefused.error === 'invalid_request'
      && capRefused.reason === 'workspace_table_full',
      `P3 表满 + 省略 cwd -> invalid_request / workspace_table_full(got ${JSON.stringify(capRefused && [capRefused.error, capRefused.reason])})`);
    const capMsg = String((capRefused && capRefused.message) || '');
    ok(capMsg.includes('工作区表已满(64/64)') && capMsg.includes('设置') && capMsg.includes('不要重试'),
      `P3b 文案是人话:说清满员数、让用户去设置里清理、别重试(got ${JSON.stringify(capMsg)})`);
    ok(!fs.existsSync(path.join(RUYI_CAP_ROOT, CAP_FULL_TITLE)),
      'P3c 目录【没有】建出来 —— 拒得干净,不留「目录建了、行没了」的残骸');
    ok(!(capRefused && capRefused.sessionId), 'P3d 拒的是「开线程」,连 sessionId 都没有');
    ok(capCfg().workspaces.length === 64, `P3e 表仍然是 64 行,一行没多(got ${capCfg().workspaces.length})`);

    // P4 —— quick_ask 走同一份帽检查(不许各抄一遍)。
    const CAP_Q_TITLE = '帽子满了的速查';
    const capQ = await call('steward_quick_ask', { question: CAP_Q_TITLE }, stewardCtx('cap-64q'));
    ok(capQ && capQ.ok === false && capQ.error === 'invalid_request' && capQ.reason === 'workspace_table_full',
      `P4 quick_ask 省略 cwd + 表满 -> 同一个稳定信封(got ${JSON.stringify(capQ && [capQ.error, capQ.reason])})`);
    ok(!fs.existsSync(path.join(RUYI_CAP_ROOT, CAP_Q_TITLE)), 'P4b quick_ask 那一路同样不建目录');
    // P4c —— 帽子只挡【派生】,不挡「用表里现成的」:表满时显式给表内 cwd 照常开线程。
    const capExplicit = await call('steward_thread_new', {
      title: '帽子满但指定 cwd', cwd: path.join(HOME, 'cap-1'), brief: { userText: 'x' },
    }, stewardCtx('cap-64x'));
    ok(capExplicit && capExplicit.ok === true && capHead(capExplicit.sessionId).cwd === path.join(HOME, 'cap-1'),
      `P4c 表满 + 表内 cwd -> 照常开线程(帽子只挡派生;got ${JSON.stringify(capExplicit && capExplicit.error)})`);

    // P5 —— 候选表的折叠句【生产可达】。走真 writeConfig(不是直接喂装配函数):修前 25 行经不过
    // 清洗、只剩 20,折叠句在生产形状下永远印不出来 —— O5 那一条是拿 25 行直喂装配函数验的,
    // 验的是投影自己的预算行为,验不到「这条路上真能有 25 行」。
    capWrite(capRows(25));
    const cap25 = capCfg();
    ok(cap25.workspaces.length === 25, `P5 25 行的表【经得过 normalizeConfig】(got ${cap25.workspaces.length};修前 20)`);
    {
      const built25 = await srv.buildStewardSystemPrompt({ id: 'steward', kind: 'steward', providerHistory: [] }, cap25, {});
      const block25 = (String(built25.volatile).split('\n\n').find(seg => seg.includes('以下是你可以交给线程用的工作区')) || '');
      ok(block25.includes('另有 5 个工作区未列出'),
        `P5b 管家上下文里真的出现折叠句(got ${JSON.stringify(block25.split('\n').find(l => l.includes('未列出')) || '(没有折叠句)')})`);
      const listed25 = block25.split('\n').filter(l => l.startsWith('· '));
      ok(listed25.length === 20, `P5c 到访层仍然只印 20 行 —— 抬的是存储帽子,不是投影预算(got ${listed25.length})`);
    }

    // P6 —— 反向保护:64 行时 defaultWorkspace 与 workspaces[0].path 的同步语义一个字没变。
    capWrite(capRows(64));
    {
      const cap64 = capCfg();
      ok(cap64.workspaces.length === 64 && cap64.defaultWorkspace === cap64.workspaces[0].path,
        `P6 64 行时 defaultWorkspace 仍等于 workspaces[0].path(${cap64.defaultWorkspace} / ${cap64.workspaces[0].path})`);
      ok(cap64.defaultWorkspace === path.join(HOME, 'cap-1'), 'P6b 同步的是【第一行】,不是最后追加的那一行');
    }

    // P7 —— 本刀的核心不变量(27 号文 §11.19.9 债表第一行):帽检查与占位建目录在【同一个串行段】,
    // 两条线程同时派生不会把表顶到 65。
    // 修前形状:两条线程在 63 行时同时过预检(两侧读到的都是 63 行) → 各自 append → 表 65 行 →
    // 下一次 normalizeConfig 截掉一行 —— 被截掉那条线程的 cwd 指向【表外】目录,再用它当 cwd 会被拒。
    // 这里用真并发直测(toolCall 同一个 tick 发出两条 thread_new,标题不同),断言四件事:
    //   ① 表恰好 64 行;② 恰好一条线程拿到派生目录,另一条回落默认工作区且线程照常开;
    //   ③ 落盘的就是那一条的行、note 对;④ 没落盘的那条【目录也没建出来】(零残骸)。
    capWrite(capRows(63));
    {
      const RACE_A = '竞态甲';
      const RACE_B = '竞态乙';
      const [raceA, raceB] = await Promise.all([
        call('steward_thread_new', { title: RACE_A, brief: { userText: RACE_A } }, stewardCtx('cap-race-a')),
        call('steward_thread_new', { title: RACE_B, brief: { userText: RACE_B } }, stewardCtx('cap-race-b')),
      ]);
      ok(raceA && raceA.ok === true && raceB && raceB.ok === true,
        `P7a 两条线程都开成了(派生失败只回落,不挡开线程;got ${JSON.stringify([raceA && raceA.error, raceB && raceB.error])})`);
      const rows = capCfg().workspaces;
      ok(rows.length === 64, `P7b 表恰好 64 行 —— 并发派生没把表顶到 65(got ${rows.length})`);
      const cwdA = raceA && raceA.ok ? capHead(raceA.sessionId).cwd : '';
      const cwdB = raceB && raceB.ok ? capHead(raceB.sessionId).cwd : '';
      const derivedCount = (capInRoot(cwdA) ? 1 : 0) + (capInRoot(cwdB) ? 1 : 0);
      ok(derivedCount === 1, `P7c 恰好一条线程拿到派生目录(甲 ${JSON.stringify(cwdA)} / 乙 ${JSON.stringify(cwdB)})`);
      const wonCwd = capInRoot(cwdA) ? cwdA : cwdB;
      const loserTitle = capInRoot(cwdA) ? RACE_B : RACE_A;
      const loserCwd = capInRoot(cwdA) ? cwdB : cwdA;
      const last = rows[rows.length - 1];
      ok(String(last && last.path) === wonCwd && (last && last.note) === 'Ruyi 自动开的',
        `P7d 落盘那行就是派生成功那条线程的目录(末行 ${JSON.stringify(last)})`);
      ok(!capInRoot(loserCwd) && loserCwd === capDefaultWs(),
        `P7e 另一条线程回落默认工作区 ${capDefaultWs()},没拿一个表外目录(got ${JSON.stringify(loserCwd)})`);
      ok(!fs.existsSync(path.join(RUYI_CAP_ROOT, loserTitle)),
        `P7f 没落盘那条线程【没有留下目录】(帽检查在占目录之前;检查 ${path.join(RUYI_CAP_ROOT, loserTitle)})`);
      const racedDirs = (fs.existsSync(RUYI_CAP_ROOT) ? fs.readdirSync(RUYI_CAP_ROOT) : [])
        .filter(n => n === RACE_A || n === RACE_B);
      ok(racedDirs.length === 1, `P7g Ruyi 根下这次只多了 1 个派生目录(got ${JSON.stringify(racedDirs)})`);
    }

    // P8 —— 第二条来路(同一债表下一行):占位之后的【落盘失败】不再被吞掉。
    // 修前:stewardRegisterDerivedWorkspace 的 `catch { return false }` 把写失败吞了,调用方照样返回
    // 目录 —— 目录在、行不在。修后:行没落盘 = 派生没成 = 删掉【本次新建】的目录并回落。
    // 造法:把 config.json 设成只读(Windows 的 +R 属性),写链的 tmp -> rename 覆盖会失败。
    // P8(前提) 先证明这一写【真的】失败了 —— 否则整条锁是假绿。
    capWrite(capRows(3));
    {
      const cfgPath = path.join(HOME, 'config.json');
      const beforeText = fs.readFileSync(cfgPath, 'utf8');
      const WRITE_FAIL_TITLE = '写不下去';
      let wfail = null;
      fs.chmodSync(cfgPath, 0o444);
      try {
        wfail = await call('steward_thread_new', { title: WRITE_FAIL_TITLE, brief: { userText: WRITE_FAIL_TITLE } }, stewardCtx('cap-wfail'));
      } finally {
        fs.chmodSync(cfgPath, 0o666);
      }
      ok(fs.readFileSync(cfgPath, 'utf8') === beforeText,
        'P8(前提)只读窗口里 config.json 一个字节没被改写 —— 这一落盘真的失败了');
      ok(wfail && wfail.ok === true, `P8a 落盘失败不挡开线程(got ${JSON.stringify(wfail && wfail.error)})`);
      const wfailCwd = wfail && wfail.ok ? capHead(wfail.sessionId).cwd : '';
      ok(!capInRoot(wfailCwd) && wfailCwd === capDefaultWs(),
        `P8b 线程回落默认工作区 ${capDefaultWs()},没拿那个没登记成的目录(got ${JSON.stringify(wfailCwd)})`);
      ok(!fs.existsSync(path.join(RUYI_CAP_ROOT, WRITE_FAIL_TITLE)), 'P8c 落盘失败 -> 刚建的目录被删掉,不留残骸');
      ok(capCfg().workspaces.length === 3, `P8d 表还是 3 行(行没落盘也没多出来;got ${capCfg().workspaces.length})`);
    }
  }

} finally {
  try { providerServer.close(); } catch {}
}

console.log('');
if (fail) { console.log(`STEWARD TOOLS E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD TOOLS E2E: ALL PASS');
process.exit(0);
})();
