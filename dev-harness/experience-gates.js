#!/usr/bin/env node
'use strict';
// 体验门量具(151 号文 §4.2「新增体验门」,阶段 0 建量具;背景与现象见 150 号文 §2、§5)。
//
// 这【不是】pass/fail 的 e2e(故意不用 .e2e.js / .test.js 后缀:不进 run-all、不进 facts 计数)。它把 §4.2 的
// 体验门变成可重复的数字:默认只测量、出报告、exit 0;`--enforce` 时任一已实现的门不达标(或该测没测成)exit 1 ——
// 留给阶段 1–3 修完以后切成门禁。
//
// 用法:
//   node dev-harness/experience-gates.js [--quick] [--enforce] [--out <file.json>] [--only G-send,G-first,...] [--budget-s 540] [--keep-temp]
//   --quick     小规模(G-send 只测 0/200 条、每档 3 发;G-first 每种条件 1 个进程;不测 400 会话索引;大文本用 256 KB)。
//   --out       完整 JSON 报告写到这里(只含测量数字与环境描述:本机路径、用户名一律替换成占位符,不含任何密钥)。
//   --only      只跑列出的门(前缀匹配,如 G-send 同时跑明文与加密两档)。
//   --budget-s  总时长预算(默认 540 s):超出后排在后面的「可选」测量(第二轮 G-first、400 会话索引)记 skipped。
//   XG_VERBOSE=1 把工作进程的 stderr 直通出来。
//
// 隔离(拒跑条件见 lib/experience-gates-worker.js 头注):每个工作进程一份 mkdtemp 的家 + 数据根(%TEMP%\ruyi-xgates-*),
// 环境由 lib/release-checks.js 的 releaseEnvironment 造(USERPROFILE/HOME/APPDATA/LOCALAPPDATA/TEMP/TMP/RUYI_HOME/
// CLAUDE_CONFIG_DIR/KIMI_CODE_HOME 全部指进临时根、清掉 NODE_OPTIONS 等),再加 WCW_TEST_NO_NET_ANCHORS=1、WCW_NO_BROWSER=1。
// 宿主先核一遍环境、工作进程起来后再核一遍(含 os.homedir()/os.tmpdir()/cwd),任何一条不满足就不加载 server.js。
// 配置里只有进程内假 provider(127.0.0.1 随机端口)与占位密钥;不联网、不读写真实 ~/.ruyi、~/.claude。
// 进程:只杀自己 spawn 的那一个工作进程的树(lib/kill-own-tree.js 按创建时间认子孙),收工再核一遍起过的 pid 都已不在。
// 同一时刻只跑一个工作进程(测量互不争抢);但本机上别的负载管不了,所以每件都记 CPU 忙闲(见 environment)。
//
// ── 各门的测量方法与已知误差 ─────────────────────────────────────────────────────────────────
// G-send(热态发消息 → 请求发出):一个进程里起真 serve(provider 引擎)+ 进程内假 OpenAI provider。时延 =
//   客户端写出 POST /api/chat/stream 的时刻 → 假 provider 的 handler 拿到【这条消息的主请求体】(stream 请求、最后一条
//   user 消息带本回合唯一标记)的时刻,同一 performance.now() 时钟。记忆用 saveMemory 逐条写(走查 B 线同一生成器,
//   约 10% 命中查询词,前 5 条核心);每个条件(N × 语义开/关)新开一条会话,首回合当预热丢掉,随后 samples 回合计数。
//   查询固定为有词法命中的那句(较重的一路)。加密档:workDataEncryptionV1 + workDataKeys.ensure() 后再写记忆,并核盘上
//   记忆文件不含正文明文。误差:同进程客户端解析 SSE 的开销计入(<1 ms 级);会话逐回合变长(每条件 ≤6 回合,影响可忽略);
//   本检出没有安装语义运行时资产(semantic-runtime 无 node_modules/模型,worker 起来即 RUNTIME_UNAVAILABLE 退出,产品报
//   semantic.owner_identity),所以「语义开」= 开关开 + 运行时 failed;N≥200 时产品本来就判 budget 不重排,影响有限。
// G-first(开机首条):每个样本一个新进程。startWorkbenchServe 返回后立刻发第一条消息,量到 provider 收到主请求体。
//   三种条件:baseline;anchor-hang(capabilityProbeUrl 指向本机只收不答的 TCP 黑洞 = 能力探测锚点不应答);
//   mcp-hang(配一个 initialize 永不应答的 stdio MCP = 某 MCP 未就绪)。另记第二条(1.5 s 后)与「能力缓存过期后」
//   (invalidateCapabilityCache,模拟 60 s TTL 到期)两条的时延,用来看「不增加等待」那半句。误差:开机期 CLI 路径探测
//   用的是本机 PATH 上的真实 claude/kimi(只跑 --version 一类探测,家目录是临时的);样本少(每条件 1–2 个)。
// G-search(线程搜索 API 层):200 条会话直接写进数据根(会话头 + messages.ndjson + 空 provider.ndjson,mtime 按 updatedAt
//   回拨),10 条是「今天」、其余按天往前(threadVisible 窗口外)。首屏 = GET /api/sessions/search?q=…&limit=30&preview=1
//   (前端每换一个词先发这一发);冷 = 开机后第一次。命中/可画比 = 后端 preview 命中 N 条里,能在 GET /api/missions
//   主列表页 ∪ /api/missions?sessionIds=(前端 loadSearchExtras 同口径)拿到行的条数 / N。默认配置(语义开)。
//   误差:preview 在索引没建好时只看标题等元数据,正文词首屏为空(results 计数照记);「超时不清空已有结果」是前端行为,
//   API 层量不到(见 not-implemented)。
// G-search-index(400 会话后台索引):400 条会话、语义关,按前端节奏(上一发回来后 500 ms)连发非 preview 搜索,直到
//   coverage.complete 或到上限。语义开时本检出的非 preview 搜索直接 500(semantic.owner_identity),索引永远建不成,
//   所以这一门在语义关下量;语义开的这一现象记进 G-semantic-down。
// G-bigtext(大文本):30 条普通会话 + 1 条含 1 MiB(UTF-8)中文 user 消息的会话,语义关(理由同上)。服务就绪后开
//   perf_hooks.monitorEventLoopDelay(5 ms 分辨率)与一个 20 ms 定时器迟到对照,按前端节奏发搜索直到索引完成或 45 s,
//   门值 = 直方图 max。另记索引是否完成、30 条小会话是否都能被搜到(「不挡其他会话建索引」)。误差:同进程客户端也在
//   这个事件循环上,但它只做收发,远小于 50 ms 量级。
// G-codes(失败码文案):静态量具,判据见 lib/experience-gates-codes.js 头注(宁可漏报,不可误报;运行 public/js 的
//   api-error-i18n 与 privacy-failure 两个模块取它们的真表)。门值 = A 级(HTTP 必达)+ B 级(隐私族)里没有码专属
//   中英文案的码数;C 级(work_data_* / semantic.* 出错语境字面量)另列,不进门值。通用兜底句(「操作失败」「请求失败」
//   或把原码塞进模板)不算这个码的文案。
// G-privacy-short-learned(3.1 阶段 4 补):进程内真网关 enhanced 档(映射落盘、DPAPI 加密),15 个短值 × 两种标签,
//   第一回合带值、第二回合带历史与 file_read 工具定义再发;门值 = 第二回合被整轮拒掉的数目。
// G-privacy-detect-miss / -false(3.1 阶段 4 补,150 P12/P13):privacy-31 全部语料过真 PrivacyCore;漏报 = 正例值没被一个
//   匹配完整覆盖,误报 = 反例在同档位下有任何匹配。RUYI_TEST_SERVER_JS 指到修前产物即同尺量修前。
// G-privacy-trunc(截断边界残片):进程内装真 server.js 的 PrivacyCore(enhanced 档的探测器参数:personal:true),
//   语料 = 身份证/邮箱/sk- 密钥/手机号 × 带标签/不带标签 × 起始位置逐字扫过截断点两侧(标题 60 字:40–66;摘要 160 字:
//   140–166;最近请求 240 字:220–246,最后一处直接调真 sessionRecentUserRequest)。A 路(生产顺序)= 先按生产表达式截断、
//   再识别;B 路 = 先识别整段再截断。残片 = 截断窗口里留下的那一段原值(≥4 字)原样出现在识别后的输出里。A 路分别在新
//   scope 与「同一 scope 先识别过全文」两种状态下各跑一遍,门值取两者里更坏的那个,三处截断点求和。只测量,不改产品。
//   误差:150 P1 修复后标题/摘要直调 02 的 sessionAutoTitle / sessionAutoSummary(三个引擎共用的真函数),网关按
//   enhanced 档 configure;检出里没有这两个函数(修前)时退回照抄的行内表达式(9/05/05b 三处)。对照组(整段都认不出的值)不计。
// G-semantic-down(语义运行时不可用时对话照常):3 条命中记忆、默认配置。先在本检出「运行时真起不来」的自然状态下发
//   命中/不命中各若干条并试两发非 preview 搜索;再把 SemanticRuntimeHooks.prepare/encode 换成直接抛 semantic.owner_identity
//   (与 06hb startingFailure 同形)再发一轮。门值 = provider 收到请求的回合占比(目标 100%)与非 preview 搜索成功占比。
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { runJob, verifyGone, sampleCpuFor } = require('./lib/experience-gates-run');
const { scanErrorCopy } = require('./lib/experience-gates-codes');

const REPO = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { quick: false, enforce: false, out: '', only: null, budgetS: 540, keepTemp: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick') args.quick = true;
    else if (a === '--enforce') args.enforce = true;
    else if (a === '--keep-temp') args.keepTemp = true;
    else if (a === '--out') args.out = argv[++i] || '';
    else if (a === '--only') args.only = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--budget-s') args.budgetS = Number(argv[++i]) || args.budgetS;
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error('unknown argument: ' + a);
  }
  return args;
}

// ── 统计 ──────────────────────────────────────────────────────────────────────────────────────
function pct(sorted, q) { return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] : null; }
function stats(values) {
  const xs = values.filter(Number.isFinite).sort((a, b) => a - b);
  return { samples: xs.length, p50: pct(xs, 0.5), p95: pct(xs, 0.95), max: xs.length ? xs[xs.length - 1] : null };
}
function latencyGate({ id, title, condition, values, failures = 0, target, details }) {
  const s = stats(values);
  const measured = s.samples > 0 || failures > 0;
  const pass = measured ? (failures === 0 && s.p95 !== null && s.p95 <= target) : null;
  return { id, title, condition, status: measured ? 'measured' : 'error', unit: 'ms', ...s, failedSamples: failures,
    target: { stat: 'p95', op: '<=', value: target, alsoRequires: '全部样本都到达 provider' }, pass, details };
}
function valueGate({ id, title, condition, value, samples = 1, target, op = '<=', unit, details, status }) {
  const ok = value === null || value === undefined ? null : (op === '<=' ? value <= target : op === '>=' ? value >= target : value === target);
  return { id, title, condition, status: status || (ok === null ? 'error' : 'measured'), unit, samples, p50: null, p95: null, max: null, value,
    target: { op, value: target }, pass: ok, details };
}
function notImplemented(id, title, condition, reason, plan) { return { id, title, condition, status: 'not-implemented', pass: null, reason, plan }; }
function skipped(id, title, condition, reason, byDesign = false) { return { id, title, condition, status: 'skipped', pass: null, reason, ...(byDesign ? { byDesign: true } : {}) }; }
function errored(id, title, condition, job) {
  return { id, title, condition, status: 'error', pass: null, reason: job ? (job.refused ? 'refused: ' + job.refused.join('; ') : (job.result && job.result.fatal ? String(job.result.fatal).split('\n')[0] : 'job ' + job.reason)) : 'no job' };
}
const round = v => (Number.isFinite(v) ? Number(v.toFixed(1)) : v);

// ── 各门的取数 ────────────────────────────────────────────────────────────────────────────────
const SEND_TARGET = { 0: 100, 200: 400, 1000: 600 };
function sendGates(job, { encrypted }) {
  const gates = [];
  const r = job && job.result;
  if (!r || r.fatal || !Array.isArray(r.conditions)) {
    const id = encrypted ? 'G-send/encrypted/N=200' : 'G-send';
    return [errored(id, encrypted ? '发消息到请求发出(加密 200 条)' : '发消息到请求发出(热态)', 'provider 引擎热态', job)];
  }
  for (const c of r.conditions) {
    const target = encrypted ? 800 : SEND_TARGET[c.n];
    const id = `G-send/${encrypted ? 'encrypted/' : ''}N=${c.n}/semantic=${c.semantic ? 'on' : 'off'}`;
    const values = c.turns.filter(t => t.reached).map(t => t.ms);
    const statuses = {};
    for (const t of c.turns) statuses[t.semantic || 'none'] = (statuses[t.semantic || 'none'] || 0) + 1;
    gates.push(latencyGate({
      id, title: encrypted ? '发消息到请求发出(加密记忆,热态)' : '发消息到请求发出(热态)',
      condition: `provider 引擎热态;${c.n} 条项目记忆${encrypted ? '(工作数据加密已开,盘上已核封印)' : ''};语义检索${c.semantic ? '开' : '关'};每条件新会话、首回合预热后计数`,
      values, failures: c.turns.filter(t => !t.reached).length, target,
      details: { warmupMs: c.warmup && c.warmup.ms, semanticStatus: statuses, semanticRuntime: c.runtime, memoryMatches: c.turns[0] && c.turns[0].memory,
        resultMsP50: stats(c.turns.map(t => t.resultMs)).p50, ...(encrypted ? { sealedVerified: r.sealedVerified === true } : {}) },
    }));
  }
  return gates;
}

function firstGates(jobsByCondition) {
  const gates = [];
  const baselineFirst = [];
  const summary = {};
  for (const [condition, jobs] of Object.entries(jobsByCondition)) {
    const ok = jobs.filter(j => j.result && !j.result.fatal && j.result.first);
    const values = ok.filter(j => j.result.first.reached).map(j => j.result.first.ms);
    const failures = jobs.length - ok.length + ok.filter(j => !j.result.first.reached).length;
    const second = stats(ok.filter(j => j.result.second && j.result.second.reached).map(j => j.result.second.ms));
    const expired = stats(ok.filter(j => j.result.afterCapExpiry && j.result.afterCapExpiry.reached).map(j => j.result.afterCapExpiry.ms));
    summary[condition] = { first: stats(values), second, afterCapExpiry: expired, serveMs: stats(ok.map(j => j.result.serveMs)) };
    if (condition === 'baseline') baselineFirst.push(...values);
    const label = { baseline: '无故障', 'anchor-hang': '能力探测锚点不应答', 'mcp-hang': '某 MCP 未就绪(initialize 永不应答)' }[condition] || condition;
    if (!jobs.length) continue;
    if (!ok.length) { gates.push(errored(`G-first/${condition}`, '开机首条消息到请求发出', label, jobs[0])); continue; }
    gates.push(latencyGate({ id: `G-first/${condition}`, title: '开机首条消息到请求发出(不含模型)', condition: `serve 就绪后立刻发第一条;${label};每个样本一个新进程`,
      values, failures, target: 2000,
      details: { secondTurnAfter1500ms: second, afterCapabilityCacheExpiry: expired, serveMs: summary[condition].serveMs } }));
  }
  // 「任一 MCP 未就绪或网络锚点不应答不增加等待」:与 baseline 同位置回合的 p50 之差。容差 250 ms(151 原文是「不增加」,量具给噪声留的余量)。
  const base = summary.baseline;
  if (base) {
    for (const condition of ['anchor-hang', 'mcp-hang']) {
      const s = summary[condition];
      if (!s) continue;
      const deltas = {
        first: s.first.p50 !== null && base.first.p50 !== null ? round(s.first.p50 - base.first.p50) : null,
        second: s.second.p50 !== null && base.second.p50 !== null ? round(s.second.p50 - base.second.p50) : null,
        afterCapExpiry: s.afterCapExpiry.p50 !== null && base.afterCapExpiry.p50 !== null ? round(s.afterCapExpiry.p50 - base.afterCapExpiry.p50) : null,
      };
      const known = Object.values(deltas).filter(Number.isFinite);
      gates.push(valueGate({ id: `G-first-extra-wait/${condition}`, title: '故障条件不增加等待(相对无故障的增量)', condition: `${condition} 相对 baseline,首条 / 1.5 s 后第二条 / 能力缓存过期后,各取 p50 之差的最大值`,
        value: known.length ? Math.max(...known) : null, target: 250, unit: 'ms', samples: s.first.samples, details: { deltasMs: deltas } }));
    }
  }
  return gates;
}

function searchGates(job, indexJob, { indexSkipped }) {
  const gates = [];
  const r = job && job.result;
  if (!r || r.fatal) gates.push(errored('G-search-first-screen', '线程搜索关键词首屏', '200 会话', job));
  else {
    const fs1 = r.firstScreen || [];
    const ok = fs1.filter(x => x.status === 200);
    gates.push(latencyGate({ id: 'G-search-first-screen', title: '线程搜索关键词首屏(API 层)', condition: `${r.sessions} 条会话(${r.today} 条今天,其余较早);GET /api/sessions/search?limit=30&preview=1;冷 1 发 + 新词 + 重复词;默认配置`,
      values: ok.map(x => x.ms), failures: fs1.length - ok.length, target: 500,
      details: { coldMs: fs1[0] ? fs1[0].ms : null, perQuery: fs1.map(x => ({ label: x.label, ms: x.ms, results: x.results, lexicalPreview: x.lexicalPreview })) } }));
    const pv = (r.ratios || []).find(x => x.label === 'preview');
    const cont = (r.ratios || []).find(x => x.label === 'continue');
    gates.push(valueGate({ id: 'G-search-drawn-ratio', title: '后端命中 N 条,左栏可画 N 条(U1 机制)', condition: '命中里能从 /api/missions 主列表页 ∪ ?sessionIds= 补取拿到行的比例;标题词「灰度发布」(多数命中是较早线程)',
      value: pv ? pv.ratio : null, target: 1, op: '>=', unit: 'ratio', samples: pv ? pv.hits : 0,
      details: { preview: pv || null, continue: cont || null } }));
  }
  if (indexSkipped) gates.push(skipped('G-search-index', '400 会话后台索引', '400 会话,语义关', indexSkipped.reason, indexSkipped.byDesign));
  else if (indexJob) {
    const ir = indexJob.result;
    if (!ir || ir.fatal || !ir.index) gates.push(errored('G-search-index', '400 会话后台索引', '400 会话,语义关', indexJob));
    else gates.push(valueGate({ id: 'G-search-index', title: '400 会话后台索引建完', condition: `${ir.sessions} 条会话,语义关;按前端节奏连发非 preview 搜索直到 coverage.complete;上限 ${Math.round(ir.index.capMs / 1000)} s(未完成记为上限值)`,
      value: ir.index.completeAtMs === null ? ir.index.capMs : ir.index.completeAtMs, target: 60000, unit: 'ms', samples: 1,
      details: { complete: ir.index.completeAtMs !== null, polls: ir.index.polls, last: ir.index.last, trace: ir.index.trace } }));
  }
  return gates;
}

function bigtextGates(job, { reduced }) {
  const r = job && job.result;
  if (!r || r.fatal || !r.loop) return [errored('G-bigtext', '大文本不阻塞事件循环', '1 MiB 中文消息', job)];
  const cond = `${r.others} 条普通会话 + 1 条 ${Math.round(r.big.bytes / 1024)} KiB(${r.big.chars} 字)中文消息;语义关;搜索/建索引期间${reduced ? '(--quick 缩小规模)' : ''}`;
  return [
    valueGate({ id: 'G-bigtext-loop-block', title: '大文本不阻塞事件循环超过 50 ms', condition: cond, value: r.loop.maxMs, target: 50, unit: 'ms', samples: r.requests.length,
      details: { histogram: r.loop, bootMaxBlockMs: r.bootMaxBlockMs, indexComplete: r.indexComplete, requests: r.requests.map(q => ({ preview: q.preview, ms: q.ms, status: q.status, phase: q.phase, indexed: q.indexed, pending: q.pending, failure: q.failure })) } }),
    valueGate({ id: 'G-bigtext-others-indexed', title: '大文本不挡其他会话建索引', condition: cond + ';结束时只在小会话里才有的词能搜到几条', value: r.othersSearchable.hits === null ? null : r.others - r.othersSearchable.hits, target: 0, unit: 'sessions', samples: r.others,
      details: { othersSearchable: r.othersSearchable, indexComplete: r.indexComplete, lastCoverage: r.lastCoverage ? { sessions: r.lastCoverage.sessions, indexedSessions: r.lastCoverage.indexedSessions, pendingSessions: r.lastCoverage.pendingSessions, complete: r.lastCoverage.complete } : null } }),
  ];
}

function semdownGates(job) {
  const r = job && job.result;
  if (!r || r.fatal) return [errored('G-semantic-down', '语义运行时不可用时对话照常', '运行时起不来 / 注入失败', job)];
  const reached = turns => turns.filter(t => t.reached).length;
  const nat = r.natural, inj = r.injected;
  const total = nat.turns.length + inj.turns.length;
  const searchOk = (nat.search || []).filter(s => s.ok).length;
  return [
    valueGate({ id: 'G-semantic-down/chat', title: '语义运行时不可用时对话照常', condition: '3 条命中记忆;① 本检出运行时真起不来(自然);② prepare/encode 抛 semantic.owner_identity(注入,同 06hb startingFailure);命中/不命中各若干条',
      value: total ? round((reached(nat.turns) + reached(inj.turns)) / total) : null, target: 1, op: '>=', unit: 'ratio', samples: total,
      details: { natural: { runtime: nat.runtime, reached: reached(nat.turns), of: nat.turns.length, errors: [...new Set(nat.turns.flatMap(t => t.errors))] },
        injected: { reached: reached(inj.turns), of: inj.turns.length, errors: [...new Set(inj.turns.flatMap(t => t.errors))] } } }),
    valueGate({ id: 'G-semantic-down/search', title: '语义运行时不可用时线程搜索照常', condition: '同一进程(运行时起不来),默认配置下两发非 preview 搜索',
      value: (nat.search || []).length ? round(searchOk / nat.search.length) : null, target: 1, op: '>=', unit: 'ratio', samples: (nat.search || []).length,
      details: { search: nat.search } }),
  ];
}

function privacyGate(job) {
  const r = job && job.result;
  if (!r || r.fatal || !Array.isArray(r.sites)) return [errored('G-privacy-trunc', '截断边界语料 0 残片外发', 'PrivacyCore', job)];
  const worst = r.sites.reduce((n, s) => n + s.truncateThenDetect.worst, 0);
  const cases = r.sites.reduce((n, s) => n + s.cases, 0);
  return [valueGate({ id: 'G-privacy-trunc', title: '截断边界语料 0 残片外发', condition: '身份证/邮箱/sk- 密钥/手机号 × 带标签/不带标签 × 起点逐字扫过截断点;生产顺序(先截断再识别),新 scope 与已学过全文的 scope 取更坏者;标题 60 / 摘要 160 / 最近请求 240 三处求和',
    value: worst, target: 0, unit: 'fragments', samples: cases,
    details: { minFragmentChars: r.minFragmentChars, detectorOptions: r.detectorOptions, sites: r.sites.map(s => ({ site: s.site, cut: s.cut, where: s.where, offsets: s.offsets, cases: s.cases, straddling: s.straddling, controlMissed: s.controlMissed,
      truncateThenDetect: s.truncateThenDetect, detectThenTruncate: s.detectThenTruncate, byKind: s.byKind, examples: s.examples })) } })];
}

// 3.1 阶段 4(4B)补的两个隐私门,量法见 lib/experience-gates-worker.js 的 runPrivacyLearned / runPrivacyDetect 头注。
function privacyLearnedGate(job) {
  const r = job && job.result;
  if (!r || r.fatal || !Array.isArray(r.rows)) return [errored('G-privacy-short-learned', '短学习值不致整轮失败', 'PrivacyGateway', job)];
  return [valueGate({ id: 'G-privacy-short-learned', title: '短学习值不致整轮失败', condition: 'enhanced 档真网关,15 个短值 × 「token: 」/「密码：」两种标签;第一回合带值,第二回合带历史、普通问句与 file_read 工具定义;计第二回合被整轮拒掉的数目',
    value: r.failedSecond, target: 0, unit: 'turns', samples: r.cases,
    details: { failedFirst: r.failedFirst, failures: r.rows.filter(row => row.first !== 'ok' || row.second !== 'ok') } })];
}
function privacyDetectGates(job) {
  const r = job && job.result;
  if (!r || r.fatal || !r.total) return [errored('G-privacy-detect-miss', '检出语料正例完整覆盖', 'PrivacyCore', job), errored('G-privacy-detect-false', '检出语料反例零误报', 'PrivacyCore', job)];
  const sets = Object.fromEntries(Object.entries(r.sets).map(([name, b]) => [name, { covered: b.covered, positives: b.positives, falsePositives: b.falsePositives, negatives: b.negatives, missed: b.missed }]));
  return [
    valueGate({ id: 'G-privacy-detect-miss', title: '检出语料正例完整覆盖(漏报 0)', condition: 'privacy-31 全部语料的正例:值被一个匹配完整覆盖;档位按语料标注', value: r.total.positives - r.total.covered, target: 0, unit: 'values', samples: r.total.positives, details: { ruleCatalogVersion: r.ruleCatalogVersion, sets } }),
    valueGate({ id: 'G-privacy-detect-false', title: '检出语料反例零误报', condition: 'privacy-31 全部语料的反例:同档位下 0 个匹配', value: r.total.falsePositives, target: 0, unit: 'samples', samples: r.total.negatives, details: { sets } }),
  ];
}

function codesGate(scan, error) {
  if (!scan) return [{ id: 'G-codes', title: '已知失败码有中英文案', status: 'error', pass: null, reason: String(error && error.message || error) }];
  return [valueGate({ id: 'G-codes', title: '已知失败码有中英文案(静态)', condition: 'A 级(apiFailure/apiCode 字面量,HTTP 必达)+ B 级(隐私族 fail()/字面量);对照 api-error-i18n 与 privacy-failure 的运行时表、两份 locale、public/ 里的字面量',
    value: scan.gateMissing, target: 0, unit: 'codes', samples: (scan.byTier.A ? scan.byTier.A.total : 0) + (scan.byTier.B ? scan.byTier.B.total : 0),
    details: { byTier: scan.byTier, familyMissingTierC: scan.familyMissing, missingByNamespace: scan.missingByNamespace, missing: scan.missing.map(m => `${m.tier} ${m.code}`), mentionedOnly: scan.mentionedOnly, localeKeys: scan.localeKeys } })];
}

const NOT_IMPLEMENTED = [
  notImplemented('G-search-ui-timeout-keeps-results', '线程搜索超时不清空已有结果', '前端左栏', '这是前端状态机(session-experience.js 把超时的空结果直接覆盖进 sessionSearchState)的行为,API 层量不到。',
    '无头 Edge(lib/browser-fixture.js)开工作台,假会话 200 条;用 page 内桩让第一发 preview 正常回结果、第二发「继续搜索」回 coverage.phase=timeout 的空结果;量第二发回来后左栏行数是否仍为第一发的行数(期望不变)。'),
  notImplemented('G-search-ui-drawn', '后端命中 N 条则左栏画 N 条(DOM 层)', '前端左栏', 'API 层的同一机制已由 G-search-drawn-ratio 量;DOM 层(renderRail 真画出的行数)需要浏览器。',
    '同上夹具,搜标题词,读 #sessionList 下的行数与 /api/sessions/search 返回条数之比。'),
  notImplemented('G-fail-ui-no-raw', '界面不出现原始码或 JSON', '前端各失败面', '需要在浏览器里逐个失败面触发并读屏;静态侧已由 G-codes 覆盖「有没有文案」那一半。',
    '无头 Edge + 假 provider 注入一组失败(provider 429/500、隐私 control_field_sensitive、维护期 busy、work_data_* 失败);抓气泡/toast/设置页可见文本,断言不匹配 /^[a-z_]+\\.[a-z_.]+$/ 与以 { 开头的 JSON。'),
  notImplemented('G-encrypt-recover', '加密任何一步失败后无需隐藏 CLI 即可回到可用状态', '工作数据加密', '要逐步注入失败(verify-backup / flush / verifier 超时 / 交接 uncertain)并观察冷进程 hold 与重启后的 handoff_pending,需要真实维护进程与 DPAPI,单件就要数分钟,超出本量具 10 分钟预算。',
    '复用 work-data-production-host-fixture 的维护进程夹具:每个注入点一个样本,量「从失败到 /api/status 正常 + 面板可操作」是否不经 doctor --recover-work-data-source 达成,记成功占比。'),
  notImplemented('G-encrypt-backup-no-plaintext', '加密失败后备份目录不留明文', '工作数据加密', '同上,需要真实演练/备份流程(150 W7)。',
    '在上面每个失败样本后扫备份目录,按种子明文的特征串计数命中文件(期望 0)。'),
  notImplemented('G-load-semantic-3x', '4 路并发下语义相关 e2e 连续 3 轮通过', '回归负载', '这是回归门而非单点测量,一轮就超出本量具 10 分钟预算。',
    'node dev-harness/run-all.js --parallel 4 只跑 memory-semantic / memory-explicit-semantic / semantic-retrieval / memory-recall-injection 等语义件,连跑 3 轮,记每轮通过数与 CPU 忙闲;另在本量具里加一个「后台并发压测」选项复用 G-send 量语义预算被吃掉的比例。'),
];

// ── 报告脱敏:本机路径与用户名替换成占位符 ─────────────────────────────────────────────────────
function scrub(text, replacements) {
  let out = text;
  for (const [needle, label] of replacements) {
    if (!needle) continue;
    const forms = new Set([needle, needle.replace(/\\/g, '/'), needle.replace(/\\/g, '\\\\'), JSON.stringify(needle).slice(1, -1)]);
    for (const form of forms) {
      if (!form) continue;
      const re = new RegExp(form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(re, label);
    }
  }
  return out;
}

function gitInfo() {
  try {
    const sha = cp.spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.trim();
    const branch = cp.spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.trim();
    const dirty = cp.spawnSync('git', ['status', '--porcelain'], { cwd: REPO, encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter(Boolean).length;
    return { commit: sha || null, branch: branch || null, uncommittedPaths: dirty };
  } catch { return { commit: null }; }
}

function wanted(only, id) { return !only || only.some(prefix => id === prefix || id.startsWith(prefix)); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { process.stdout.write(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).join('\n') + '\n'); return 0; }
  const startedAt = new Date();
  const t0 = Date.now();
  const elapsedS = () => (Date.now() - t0) / 1000;
  const log = msg => process.stderr.write(`[experience-gates ${elapsedS().toFixed(0)}s] ${msg}\n`);
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-xgates-'));
  log(`run root ${path.basename(base)} (under %TEMP%); ${args.quick ? 'quick' : 'full'} mode`);
  const cpuBaseline = await sampleCpuFor(3000);
  log(`CPU busy before start: avg ${cpuBaseline.avgBusyPct}% max ${cpuBaseline.maxBusyPct}%`);
  const jobs = [];
  const gates = [];
  const run = async (name, mode, opts, timeoutMs) => {
    log(`job ${name} ...`);
    const job = await runJob({ base, name, mode, opts, timeoutMs });
    jobs.push(job);
    log(`job ${name}: ${job.reason} in ${((job.wallMs || 0) / 1000).toFixed(1)} s, cpu avg ${job.cpu && job.cpu.avgBusyPct}%${job.result && job.result.fatal ? ' FATAL ' + String(job.result.fatal).split('\n')[0] : ''}${job.refused ? ' REFUSED ' + job.refused.join('; ') : ''}`);
    return job;
  };

  // 1) G-codes(静态,宿主内)
  if (wanted(args.only, 'G-codes')) {
    let scan = null, error = null;
    try { scan = await scanErrorCopy(REPO); } catch (e) { error = e; }
    gates.push(...codesGate(scan, error));
  }
  // 2) G-privacy-trunc
  if (wanted(args.only, 'G-privacy-trunc')) gates.push(...privacyGate(await run('privacy', 'privacy', {}, 90000)));
  if (wanted(args.only, 'G-privacy-short-learned')) gates.push(...privacyLearnedGate(await run('privacy-learned', 'privacy-learned', {}, 180000)));
  if (wanted(args.only, 'G-privacy-detect')) gates.push(...privacyDetectGates(await run('privacy-detect', 'privacy-detect', {}, 90000)));
  // 3) G-send(明文)
  if (wanted(args.only, 'G-send')) {
    const sizes = args.quick ? [0, 200] : [0, 200, 1000];
    const job = await run('send-plain', 'send', { sizes, samples: args.quick ? 3 : 5 }, 420000);
    gates.push(...sendGates(job, { encrypted: false }));
    // 加密 200 条
    const enc = await run('send-encrypted', 'send', { encrypted: true, sizes: [200], samples: args.quick ? 2 : 3, semanticOrder: [false] }, 300000);
    gates.push(...sendGates(enc, { encrypted: true }));
  }
  // 4) G-first 第一轮(每种条件一个进程)
  const firstJobs = { baseline: [], 'anchor-hang': [], 'mcp-hang': [] };
  const wantFirst = wanted(args.only, 'G-first');
  if (wantFirst) for (const condition of Object.keys(firstJobs)) firstJobs[condition].push(await run(`first-${condition}-1`, 'first', { condition }, 150000));
  // 5) G-search
  let searchJob = null;
  if (wanted(args.only, 'G-search')) searchJob = await run('search', 'search', { sessions: 200, today: 10, ...(args.quick ? { words: ['数据库迁移', '回滚预案', 'XGK0007'] } : {}) }, 240000);
  // 6) G-bigtext
  if (wanted(args.only, 'G-bigtext')) {
    const reduced = args.quick;
    const job = await run('bigtext', 'bigtext', { bigBytes: reduced ? 262144 : 1048576, others: 30, capMs: reduced ? 20000 : 45000, config: { semanticRetrievalV1: false } }, 180000);
    gates.push(...bigtextGates(job, { reduced }));
  }
  // 7) G-semantic-down
  if (wanted(args.only, 'G-semantic-down')) gates.push(...semdownGates(await run('semdown', 'semdown', {}, 180000)));
  // 8) 可选:G-first 第二轮(全量模式)与 400 会话索引 —— 预算内才跑
  if (wantFirst && !args.quick) {
    for (const condition of Object.keys(firstJobs)) {
      if (elapsedS() > args.budgetS - 30) { log(`skip first-${condition}-2: time budget`); continue; }
      firstJobs[condition].push(await run(`first-${condition}-2`, 'first', { condition }, 150000));
    }
  }
  if (wantFirst) gates.push(...firstGates(firstJobs));
  let indexJob = null, indexSkipped = null;
  if (wanted(args.only, 'G-search')) {
    if (args.quick) indexSkipped = { reason: '--quick 不测 400 会话索引', byDesign: true };
    else if (elapsedS() > args.budgetS - 100) indexSkipped = { reason: `时长预算(${args.budgetS} s)已用 ${elapsedS().toFixed(0)} s,留不出 100 s`, byDesign: false };
    else indexJob = await run('search-index', 'search', { sessions: 400, today: 10, firstScreen: false, indexCapMs: Math.min(90000, Math.max(30000, (args.budgetS - elapsedS() - 20) * 1000)), config: { semanticRetrievalV1: false } }, 200000);
    gates.push(...searchGates(searchJob, indexJob, { indexSkipped }));
  }
  gates.push(...NOT_IMPLEMENTED.filter(g => wanted(args.only, g.id)));

  // 收工核对进程
  const gone = verifyGone(jobs);
  if (!args.keepTemp) { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 句柄未放干净时留给 temp-janitor(ruyi- 前缀) */ } }

  const measured = gates.filter(g => g.status === 'measured');
  const report = {
    tool: 'dev-harness/experience-gates.js', schema: 1, mode: args.quick ? 'quick' : 'full',
    startedAt: startedAt.toISOString(), durationS: Number(elapsedS().toFixed(1)),
    environment: {
      node: process.version, platform: `${process.platform} ${os.release()} ${process.arch}`, cpu: (os.cpus()[0] || {}).model || null, logicalCpus: os.cpus().length,
      memoryGiB: Number((os.totalmem() / 2 ** 30).toFixed(1)), cpuBusyBeforeStart: cpuBaseline,
      concurrency: '工作进程逐个串行(本量具同一时刻只跑一个);本机其他负载不受控,见各 job 的 cpuBusy',
      semanticRuntime: '本检出未安装语义运行时资产(worker.cjs 启动即 RUNTIME_UNAVAILABLE),产品侧表现为 semantic.owner_identity / state=failed',
      repo: gitInfo(),
      isolation: 'releaseEnvironment 临时家与数据根 + WCW_TEST_NO_NET_ANCHORS=1 + WCW_NO_BROWSER=1;假 provider 与占位密钥;宿主与工作进程双重核验',
    },
    summary: { gates: gates.length, measured: measured.length, passed: measured.filter(g => g.pass === true).length, failed: measured.filter(g => g.pass === false).length,
      notImplemented: gates.filter(g => g.status === 'not-implemented').length, skipped: gates.filter(g => g.status === 'skipped').length, errors: gates.filter(g => g.status === 'error').length },
    gates,
    jobs: jobs.map(j => ({ name: j.name, mode: j.mode, reason: j.reason, wallS: j.wallMs ? Number((j.wallMs / 1000).toFixed(1)) : null, cpuBusy: j.cpu || null,
      processes: (j.tree || []).map(p => ({ pid: p.pid, name: p.name })), killed: j.killed && j.killed.killed, killNote: j.killed && j.killed.skipped || null, exit: j.exit, refused: j.refused || null })),
    processCheck: gone,
  };
  const realHome = os.homedir();
  const userName = path.basename(realHome);
  let text = scrub(JSON.stringify(report, null, 2), [[base, '<run-root>'], [os.tmpdir(), '<temp>'], [REPO, '<repo>'], [realHome, '<home>']]);
  if (userName && userName.length >= 3) text = text.replace(new RegExp('([\\\\/]Users[\\\\/]+)' + userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '$1<user>');
  if (args.out) { fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true }); fs.writeFileSync(args.out, text + '\n'); }

  // stdout 摘要
  const line = g => {
    if (g.status === 'not-implemented') return `  ${g.id.padEnd(40)} not-implemented`;
    if (g.status === 'skipped') return `  ${g.id.padEnd(40)} skipped (${g.reason})`;
    if (g.status === 'error') return `  ${g.id.padEnd(40)} ERROR (${g.reason})`;
    const verdict = g.pass === true ? 'PASS' : g.pass === false ? 'FAIL' : '?';
    const nums = g.unit === 'ms' && g.p50 !== undefined && g.value === undefined
      ? `n=${g.samples} p50=${g.p50} p95=${g.p95} max=${g.max} ms (target p95 ${g.target.op} ${g.target.value})${g.failedSamples ? ` failed=${g.failedSamples}` : ''}`
      : `value=${g.value} ${g.unit || ''} (target ${g.target.op} ${g.target.value}) n=${g.samples}`;
    return `  ${g.id.padEnd(40)} ${verdict}  ${nums}`;
  };
  process.stdout.write(`experience gates (${report.mode}) — ${report.durationS} s, node ${process.version}, cpu busy before start ${cpuBaseline.avgBusyPct}%\n`);
  for (const g of gates) process.stdout.write(line(g) + '\n');
  process.stdout.write(`processes: tracked ${gone.tracked || 0}, still alive ${gone.alive ? gone.alive.length : '?'}${args.out ? `; report -> ${path.relative(process.cwd(), path.resolve(args.out)) || args.out}` : ''}\n`);
  if (gone.alive && gone.alive.length) process.stdout.write(`WARNING: still alive: ${JSON.stringify(gone.alive)}\n`);
  if (args.enforce) {
    // 没测成(error)与因预算跳过的门也算不达标:门禁不能靠「没量」变绿。--quick 按设计不测的那一项除外。
    const bad = gates.filter(g => (g.status === 'measured' && g.pass !== true) || g.status === 'error' || (g.status === 'skipped' && !g.byDesign));
    if (bad.length) { process.stdout.write(`--enforce: ${bad.length} gate(s) not passing: ${bad.map(g => g.id).join(', ')}\n`); return 1; }
  }
  return 0;
}

main().then(code => { process.exitCode = code; }, error => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 2; });
