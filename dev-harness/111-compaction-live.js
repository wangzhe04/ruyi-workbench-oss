#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 111-compaction-live.js — 107 波 E1:111 五个压缩开关的 **B 类真模型配对读数**(LIVE,手工跑,真 API)
//
//   node --require dev-harness/lib/fixture-home-guard.js dev-harness/111-compaction-live.js \
//        [--switches=111d,111e,111a,111b,111c] [--repeats=5] [--model=deepseek-v4-flash] \
//        [--dir=<证据目录>] [--budget-cny=25] [--out=docs/optimization-plan/107-e1-readings.json]
//
// 为什么叫 *-live.js 而不是 *.e2e.js:`run-all.js:248` 只收 `.e2e.js`,live 件(真 key、真花钱)
// 一律不许进全量。本件与 `deepseek-ab-live.js` / `compact-quality-live.e2e.js` 同族。
//
// ── 量什么(25 号文 §1.3「默认翻开规则」里那五条主指标,一条一条对) ───────────────────────
//   111a `runtimeEvaporateBudgetBoundaryV1` → 会话内 L2(摘要重播种)次数,目标 −20%
//   111b `runtimeReseedTailUnitsV1`         → 尾部为空的重播种比例,目标 −80%
//   111c `runtimeReseedReattachFilesV1`     → 压缩后首个工具调用是「重读已知文件」的比率,目标 −50%
//   111d `runtimeSummaryPromptI18nV1`       → EN 夹具 validateStructuredSummary 通过率 ≥ ZH
//   111e `runtimeHistoryReadDedupV1`        → L1 这一趟释放的 token,目标 +10%
// 外加每次 B 类非劣信号:可确定性核对的答案质量(夹具事实标记命中)、实体保留、工具调用形状、
// 调用次数、token、费用、墙钟。**质量判定一律确定性**:标记串是否出现在回答里,不用模型判模型。
//
// ── 怎么量(与保真度的边界,照实写清楚) ─────────────────────────────────────────────────
//   * **进程内**跑真源码:`require(ruyi-workbench/app/server.js)` 后直接调导出的压缩原语
//     (`evaporateHistory` / `CompactionPlan` / `providerSummaryCall` / `calibratedEstimate` …),
//     开关在**调用点**按产品的判定函数把门(`evaporateBudgetBoundaryEnabled` 等),与生产同一处。
//   * 两级驱动循环(先 L1 后 L2、水位滞回)是**照抄** `src/10-context-governance.js:2218-2309`
//     的 `maybeAutoCompact` 顺序写的 —— 那个函数没导出。抄了哪些:预算/窗口/rearmMargin/
//     armedBudget/before→L1→after1→L2→reseed。没抄的三处(都写在读数里):
//       · `repairProviderHistoryPairing` 未导出 → 本件自己做孤儿检查(按设计它一条都不该修);
//       · `writeHistorySnapshot` 未导出 → rawRefPrefix 用合成串(观测缩减的算法一字不差,只是
//         `observation_recall` 回读不到盘上的快照 —— 不影响任何一条本件要量的算术);
//       · `recordCompactUsage` / `maybeWriteSessionNotes` 是 session 副作用,本件无 session →
//         **花费不从 `usage/` 台账读,而是逐次从 `sc.usage` 自行累加**(口径见 PRICING)。
//   * 模型真参与的三处:① L2 摘要本身(`providerSummaryCall`,真调用真校验);② 压缩后拿**真模型**
//     回答一个可确定性核对的问题(B 类非劣);③ 111c 的「首个动作」探针 —— 压缩后给真模型挂上
//     工具,看它是不是先去重读一个内容已经在上下文里的文件。③ 的工具 schema 与系统提示是**本件
//     自己写的**(产品的 `MCP_TOOLS` / `buildOpenAiTools` 没导出),所以绝对比率不等于产品实测;
//     但两臂用的是同一份 schema 同一句系统提示,**配对比较仍然成立**。
//   * **窗口缩小以控成本**:provider.contextWindow 置 30000(`resolveContextWindow` 的 manual 档)。
//     于是预算 24000、尾预算 12000、L1 保护区 6000、摘要单发输入 ~2 万 —— 机制一字不变,只是
//     整套尺子等比缩小,一次 L2 约 ¥0.02 而不是 ¥1。夹具按这把尺子搭「贴着窗口的长历史」。
//
// ── 配对与分类纪律 ───────────────────────────────────────────────────────────────────────
//   * 每个 repeat 里 A 臂(开关关)与 B 臂(开关开)**背靠背**跑同一份种子历史、同一句提示词、
//     同一个模型;repeat 之间**交替先后顺序**(奇数 repeat 先跑 B),抵消 provider 侧缓存与
//     `context-calibration` 的 EMA 漂移。
//   * 每一次运行先分类再算比例:`ok` / `timeout` / `empty` / `refusal` / `harness_bug`。
//     非 ok 一律记 `unknown`,**不进任何分母**。
//
// ── 花费 ────────────────────────────────────────────────────────────────────────────────
//   默认 5 repeats × 五开关,实测约 ¥1–2(deepseek-v4-flash)。`--budget-cny` 是硬闸:累计逼近
//   即停并照实报。定价用产品预设(`05-claude-engine.js:1055`):输入 ¥1／缓存 ¥0.02／输出 ¥2 每百万。
//
// ── 隔离(45 号文 §9.6 的配方) ───────────────────────────────────────────────────────────
//   数据家 `<dir>\home`、用户家 `<dir>\user`(USERPROFILE/HOME/HOMEDRIVE/HOMEPATH/LOCALAPPDATA/
//   APPDATA 全指过去),两者都不许等于真机家(启动即自检,违反就退)。副本 config 只抄**一个**
//   provider 的凭据,`autoImportClaudeCodeMcp:false`、`externalMcpServers:[]`、`claudePath:''`、
//   `allowDesktopTools:false`、`stewardEnabledV1:false`、`stewardAutoActions` 全关、
//   `killPortOnStart:false`、工作区指向 `<dir>\work`。**不起 HTTP 服务、不开端口**(用户自己的
//   8765 一次都不碰)。收尾把带密钥的副本 config 删掉并复扫证据目录。
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// ── 参数 ────────────────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const ALL_SWITCHES = ['111d', '111e', '111a', '111b', '111c'];
const SWITCHES = String(arg('switches', ALL_SWITCHES.join(','))).split(',').map(s => s.trim()).filter(Boolean);
const REPEATS = Math.max(1, Number(arg('repeats', 5)) || 5);
const MODEL = String(arg('model', 'deepseek-v4-flash'));
const PROVIDER_ID = String(arg('provider', 'deepseek'));
const BUDGET_CNY = Number(arg('budget-cny', 25)) || 25;
const OUT = arg('out', path.resolve(__dirname, '..', 'docs', 'optimization-plan', '107-e1-readings.json'));
const HARNESS_VERSION = 'e1-1';

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
const DIR = path.resolve(arg('dir', path.join(os.tmpdir(), 'ruyi-e1-' + stamp)));
const SIM_HOME = path.join(DIR, 'home');
const SIM_USER = path.join(DIR, 'user');
const SIM_WORK = path.join(DIR, 'work');
const EVID = path.join(DIR, 'evidence');

// ── 隔离:先换家,再 require server.js ──────────────────────────────────────────────────
const REAL_HOME_DIR = process.env.RUYI_REAL_HOME || os.homedir();
const norm = p => { let s = path.resolve(String(p || '')); while (s.length > 3 && /[\\/]$/.test(s)) s = s.slice(0, -1); return process.platform === 'win32' ? s.toLowerCase() : s; };
const REAL_WCW = path.join(REAL_HOME_DIR, '.win-claude-workbench');

for (const d of [SIM_HOME, SIM_USER, SIM_WORK, EVID, path.join(SIM_USER, 'AppData', 'Local'), path.join(SIM_USER, 'AppData', 'Roaming')]) fs.mkdirSync(d, { recursive: true });

// 真实凭据只读一次,只抄需要的那一个 provider。
const realConfig = JSON.parse(fs.readFileSync(path.join(REAL_WCW, 'config.json'), 'utf8'));
const realProvider = (realConfig.providers || []).find(p => p.id === PROVIDER_ID);
if (!realProvider) { console.error('FATAL: 真机配置里没有 provider ' + PROVIDER_ID); process.exit(2); }
if (!realProvider.apiKey) { console.error('FATAL: provider ' + PROVIDER_ID + ' 没有 apiKey'); process.exit(2); }
const API_KEY = String(realProvider.apiKey);
const KEY_TAIL = API_KEY.slice(-4);

const SIM_CONFIG = {
  configSchema: realConfig.configSchema || 11,
  version: realConfig.version || '2.7.0',
  locale: 'zh-CN',
  permissionMode: 'bypass',
  autoCompactThreshold: 0.8,
  providers: [{
    id: PROVIDER_ID, label: realProvider.label || PROVIDER_ID, type: realProvider.type || 'openai-compat',
    baseUrl: realProvider.baseUrl, apiKey: API_KEY, model: MODEL,
    models: [{ id: MODEL, label: MODEL }],
    reasoning: false,
    contextWindow: 30000, // 见头注「窗口缩小以控成本」
  }],
  activeProvider: PROVIDER_ID,
  // 隔离硬项
  autoImportClaudeCodeMcp: false,
  externalMcpServers: [],
  claudePath: '',
  killPortOnStart: false,
  allowDesktopTools: false,
  desktopMcp: false,
  stewardEnabledV1: false,
  stewardAutoActions: { reply: false, schedule: false, memory: false, delegate: false, act: false },
  schedulerEnabledV1: false,
  workspaces: [{ path: SIM_WORK, label: 'e1-work' }],
  defaultWorkspace: SIM_WORK,
  stewardWorkspaceRoot: SIM_WORK,
};
const SIM_CONFIG_FILE = path.join(SIM_HOME, 'config.json');
fs.writeFileSync(SIM_CONFIG_FILE, JSON.stringify(SIM_CONFIG, null, 2), 'utf8');

process.env.WIN_CLAUDE_WORKBENCH_HOME = SIM_HOME;
process.env.RUYI_HOME = SIM_HOME;
process.env.USERPROFILE = SIM_USER;
process.env.HOME = SIM_USER;
if (process.platform === 'win32') {
  const parsed = path.parse(SIM_USER);
  process.env.HOMEDRIVE = parsed.root.replace(/[\\/]+$/, '');
  process.env.HOMEPATH = SIM_USER.slice(parsed.root.length - 1);
}
process.env.LOCALAPPDATA = path.join(SIM_USER, 'AppData', 'Local');
process.env.APPDATA = path.join(SIM_USER, 'AppData', 'Roaming');
process.env.KIMI_CODE_HOME = path.join(SIM_USER, '.kimi-code');
process.env.WCW_KILL_PORT = '0';
if (!process.env.RUYI_REAL_HOME) process.env.RUYI_REAL_HOME = REAL_HOME_DIR;

// 自检:数据家/用户家都不许是真机家。
for (const [label, value] of [['WIN_CLAUDE_WORKBENCH_HOME', SIM_HOME], ['USERPROFILE', SIM_USER], ['HOME', SIM_USER]]) {
  if (norm(value) === norm(REAL_HOME_DIR) || norm(value) === norm(REAL_WCW)) {
    console.error('FATAL 隔离自检红:' + label + ' 指向真机家 ' + value); process.exit(2);
  }
}

const APP = path.resolve(__dirname, '..', 'ruyi-workbench', 'app');
const srv = require(path.join(APP, 'server.js'));
const RULES = require(path.join(APP, 'src', 'context-governance-rules.json'));

// ── 花费账 ─────────────────────────────────────────────────────────────────────────────
const PRICING = { inputPerM: 1, cachedInputPerM: 0.02, outputPerM: 2 }; // 05-claude-engine.js:1055 预设
const spend = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, cny: 0, byPhase: {} };
function cachedOf(u) {
  if (!u) return 0;
  const d = u.prompt_tokens_details || u.input_tokens_details || {};
  const raw = d.cached_tokens != null ? d.cached_tokens
    : (u.prompt_cache_hit_tokens != null ? u.prompt_cache_hit_tokens
      : (u.cache_read_input_tokens != null ? u.cache_read_input_tokens : u.cached_tokens));
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? Math.round(v) : 0;
}
function bill(phase, usage) {
  const u = usage || {};
  const inTok = Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens) || 0;
  const outTok = Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens) || 0;
  const cached = Math.min(inTok, cachedOf(u));
  const cny = ((inTok - cached) * PRICING.inputPerM + cached * PRICING.cachedInputPerM + outTok * PRICING.outputPerM) / 1e6;
  spend.calls++; spend.inputTokens += inTok; spend.cachedInputTokens += cached; spend.outputTokens += outTok; spend.cny += cny;
  const b = spend.byPhase[phase] || (spend.byPhase[phase] = { calls: 0, inputTokens: 0, outputTokens: 0, cny: 0 });
  b.calls++; b.inputTokens += inTok; b.outputTokens += outTok; b.cny += cny;
  return { inputTokens: inTok, cachedInputTokens: cached, outputTokens: outTok, cny: Number(cny.toFixed(6)) };
}
function budgetCheck() {
  if (spend.cny > BUDGET_CNY * 0.9) throw new Error('BUDGET_STOP: 累计花费 ¥' + spend.cny.toFixed(4) + ' 已达上限 ¥' + BUDGET_CNY + ' 的 90%');
}

// ── 真模型直调(chat completions);仅用于 B 类答案与 111c 首动作探针 ────────────────────
const CHAT_TIMEOUT_MS = 120000;
function chatUrl() {
  const b = String(realProvider.baseUrl || '').replace(/\/+$/, '');
  return (/\/v\d+$/i.test(b) ? b : b + '/v1') + '/chat/completions';
}
async function chat(phase, messages, opts = {}) {
  const t0 = Date.now();
  const body = { model: MODEL, messages, stream: false, ...(opts.tools ? { tools: opts.tools } : {}), ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}) };
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, CHAT_TIMEOUT_MS);
  try {
    const res = await fetch(chatUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + API_KEY },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    const ms = Date.now() - t0;
    if (!res.ok) {
      let d = ''; try { d = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      return { klass: 'harness_bug', ok: false, ms, httpStatus: res.status, error: 'HTTP ' + res.status + ': ' + redactKey(d) };
    }
    const payload = await res.json().catch(() => null);
    // 注意:`fetch` 在**响应头**到达时就 resolve,`stream:false` 的正文是之后才读完的 ——
    // 所以计时必须打在 `res.json()` 之后。第一版打在 fetch 之后,读到的是 100–150 ms 的 TTFB,
    // 看着像「2 万 token 的补全 100 ms 就回来了」(E1 首轮 111d/111e/111c 的 `answer.ms`
    // 就是那个口径,已在 46 号文 §5 E1 里注明;每个 repeat 的 `wallMs` 一直是全程口径)。
    const msFull = Date.now() - t0;
    const choice = payload && payload.choices && payload.choices[0];
    const msg = (choice && choice.message) || {};
    const text = String(msg.content || '').trim();
    const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls.map(c => ({
      name: (c.function && c.function.name) || '', args: (c.function && c.function.arguments) || '',
    })) : [];
    const billed = bill(phase, payload && payload.usage);
    const klass = (!text && !toolCalls.length) ? 'empty' : 'ok';
    return { klass, ok: klass === 'ok', ms: msFull, ttfbMs: ms, text, toolCalls, finishReason: (choice && choice.finish_reason) || '', billed };
  } catch (e) {
    const ms = Date.now() - t0;
    const aborted = /abort/i.test(String((e && e.name) || '') + String((e && e.message) || ''));
    return { klass: aborted ? 'timeout' : 'harness_bug', ok: false, ms, error: redactKey(String((e && e.message) || e)) };
  } finally { clearTimeout(timer); }
}
const redactKey = s => String(s || '').split(API_KEY).join('«redacted»');

// ── 夹具原料 ───────────────────────────────────────────────────────────────────────────
// 工具结果的形状照 `12-tool-dispatch` 的 `JSON.stringify(result)`(与五件 unit 判据同一份)。
const readResult = (p, body) => JSON.stringify({
  ok: true, path: p, content: body, size: body.length, totalChars: body.length,
  truncated: false, sourceLineEnding: 'lf', contentLineEnding: 'lf',
});
const searchResult = (tag, n) => JSON.stringify({
  ok: true, rows: Array.from({ length: n }, (_, i) => ({ i, file: tag + '/mod' + i + '.js', text: 'X'.repeat(140) })),
});
// 写族工具结果:`protectedObservation`(`10:413-420`)按设计**不蒸发**它们(回滚/审计依赖)。
// 夹具靠它造出「L1 缩不下来、只能上 L2」的真实形状 —— 一条改代码的线程里 file_edit 本来就成串。
const editResult = (i, n) => JSON.stringify({
  ok: true, op: 'modify', path: 'billing/mod' + i + '.js', bytesWritten: 4200,
  diff: Array.from({ length: n }, (_, k) => '@@ -' + (k * 10) + ',5 +' + (k * 10) + ',6 @@\n-  retry(' + k + ');\n+  retry(' + k + ', RETRY_LIMIT);').join('\n'),
});
let CALL_SEQ = 0;
function unit(toolName, content, assistantText) {
  const id = 'c' + (++CALL_SEQ);
  return [
    { role: 'assistant', content: assistantText == null ? null : assistantText, tool_calls: [{ id, type: 'function', function: { name: toolName, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: id, content },
  ];
}
function parallelUnit(toolName, contents) {
  const ids = contents.map(() => 'c' + (++CALL_SEQ));
  return [
    { role: 'assistant', content: null, tool_calls: ids.map(id => ({ id, type: 'function', function: { name: toolName, arguments: '{}' } })) },
    ...contents.map((c, i) => ({ role: 'tool', tool_call_id: ids[i], content: contents[i] })),
  ];
}

// invoice.js 的头 40 行里埋两类事实 —— 111c 的重附块只带头 40 行,事实必须落在里面。
//   · **高显著度**(RETRY_LIMIT / REGION_CODE):任务本身就在说它们,真摘要会把它们**原文抄进
//     【关键文件与上下文】**。E1 首轮就是这么栽的:111c 关臂的 `factAnywhere` 实测 true ——
//     摘要自己带着答案,「模型要不要重读」这件事就不由开关决定了,那一格读数作废。
//   · **低显著度**(SHARD_SALT):一个随机样子的常量,与任务目标无关,摘要不会去抄它。
//     这才是能把「上下文里有没有这份文件」与「模型要不要重读」隔离开的事实。
const INVOICE_HEAD = [
  '// billing/invoice.js — 账单出票主流程',
  "'use strict';",
  "const { queue } = require('./queue');",
  'const RETRY_LIMIT = 7;              // E1-FACT-RETRY 重试上限',
  'const TIMEOUT_MS = 30000;',
  'const REGION_CODE = "RC-8842";      // E1-FACT-REGION 区域批准码',
  "const SHARD_SALT = 'Q7X-LUMEN';     // E1-FACT-SALT 分片盐值(低显著度事实)",
  'const SHARD_COUNT = 24;',
];
function invoiceBody(lines) {
  const rows = INVOICE_HEAD.slice();
  while (rows.length < 6 + lines) rows.push('function step' + rows.length + '(ctx) { return ctx.next(' + rows.length + '); }');
  return rows.join('\n');
}

// 十条可确定性核对的事实标记(中文夹具)。
const FACTS_ZH = [
  { marker: 'PINEAPPLE-42', line: '本次任务的暗号是 PINEAPPLE-42,后面问你时要能答出来。', where: 'user' },
  { marker: 'billing/invoice.js', line: '问题出在 billing/invoice.js 这个文件的出票分支。', where: 'user' },
  { marker: '方案B', line: '结论:在方案A和方案B之间,最终决定采用方案B(异步队列),放弃方案A。', where: 'assistant' },
  { marker: '修复登录页超时', line: '待办清单第一项:修复登录页超时(用户反馈超过 30 秒)。', where: 'user' },
  { marker: '17 个', line: '扫描完成:一共发现 17 个未处理的异常分支。', where: 'assistant' },
  { marker: '张伟', line: '接口对接人是张伟,有问题找他确认字段口径。', where: 'user' },
  { marker: '2026-08-01', line: '已确认:上线窗口定在 2026-08-01,不能推迟。', where: 'assistant' },
  { marker: 'PostgreSQL 15', line: '生产库是 PostgreSQL 15,不要用 MySQL 的语法。', where: 'user' },
  { marker: 'RC-8842', line: '区域批准码是 RC-8842,提单时必须带上。', where: 'assistant' },
  { marker: 'config.yaml', line: '约束:不要再动 config.yaml,上次改坏过一次。', where: 'user' },
];
const FACTS_EN = [
  { marker: 'PINEAPPLE-42', line: 'The passphrase for this task is PINEAPPLE-42; you must be able to repeat it later.', where: 'user' },
  { marker: 'billing/invoice.js', line: 'The defect is in billing/invoice.js, in the issuing branch.', where: 'user' },
  { marker: 'Plan B', line: 'Decision: between Plan A and Plan B we settled on Plan B (async queue) and dropped Plan A.', where: 'assistant' },
  { marker: 'login page timeout', line: 'Todo item one: fix the login page timeout (users report over 30 seconds).', where: 'user' },
  { marker: '17 ', line: 'Scan complete: exactly 17 unhandled exception branches were found.', where: 'assistant' },
  { marker: 'Zhang Wei', line: 'The integration contact is Zhang Wei; confirm field semantics with him.', where: 'user' },
  { marker: '2026-08-01', line: 'Confirmed: the release window is 2026-08-01 and cannot slip.', where: 'assistant' },
  { marker: 'PostgreSQL 15', line: 'Production runs PostgreSQL 15; do not use MySQL syntax.', where: 'user' },
  { marker: 'RC-8842', line: 'The regional approval code is RC-8842 and must be attached when filing.', where: 'assistant' },
  { marker: 'config.yaml', line: 'Constraint: do not touch config.yaml again, it was broken once already.', where: 'user' },
];

// 一份「贴着窗口的长密对话」:十条事实分散其间,中间用真实感的填充轮次拉长。
// 填充倍数 30 是量出来的:zh ≈ 13.9K / en ≈ 17.3K token,都贴着摘要单发预算(窗口 30000 −
// reserve 9608 ≈ 20.4K)却**都还塞得进一次调用** —— 再大一档(38)英文那份就会 needsMapReduce
// 并丢掉中段 38 条,事实保留率量的就不再是摘要质量而是截断,配对当场失效。
function factHistory(facts, lang) {
  const fillerUser = i => (lang === 'en'
    ? `Round ${i}: walk me through the caching, retry, logging and monitoring implications once more. `.repeat(30)
    : `第 ${i} 轮讨论:关于缓存、重试、日志与监控的常规展开,逐条说清楚。`.repeat(30));
  const fillerAsst = i => (lang === 'en'
    ? `Round ${i} notes: the retry path is idempotent, logs are sampled, monitors alert on p99. `.repeat(30)
    : `第 ${i} 轮小结:重试路径是幂等的,日志按比例采样,监控盯 p99。`.repeat(30));
  const h = [{ role: 'user', content: lang === 'en' ? 'Goal: harden the billing system end to end.' : '我们的目标:为账单系统做一次稳定性整改。' }];
  facts.forEach((f, i) => {
    h.push({ role: 'user', content: fillerUser(i) });
    h.push({ role: 'assistant', content: fillerAsst(i + 100) });
    if (f.where === 'user') {
      h.push({ role: 'user', content: f.line });
      h.push({ role: 'assistant', content: lang === 'en' ? 'Understood, noted.' : '好的,记下了。' });
    } else {
      h.push({ role: 'assistant', content: f.line });
      h.push({ role: 'user', content: lang === 'en' ? 'Good, go on.' : '好,继续。' });
    }
  });
  h.push({ role: 'user', content: lang === 'en' ? 'Pause here; we continue later.' : '先到这里,后面继续。' });
  return h;
}

const cjkRatio = s => {
  const t = String(s || '');
  if (!t) return 0;
  const cjk = (t.match(/[一-鿿]/g) || []).length;
  const letters = (t.match(/[A-Za-z]/g) || []).length;
  return (cjk + letters) ? cjk / (cjk + letters) : 0;
};
const langOf = s => (cjkRatio(s) >= 0.2 ? 'zh' : 'en');

// ── 两级压缩驱动(照抄 maybeAutoCompact 的顺序,见头注) ───────────────────────────────
function providerFor() { return SIM_CONFIG.providers[0]; }
const SYS = '你是如意工作台的编码助手。';
function orphanCount(history) {
  const callIds = history.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls.map(c => c.id));
  const replies = new Set(history.filter(m => m.role === 'tool').map(m => m.tool_call_id));
  return callIds.filter(id => !replies.has(id)).length;
}
async function compactStep(state, config, phase) {
  const provider = providerFor();
  const history = state.history;
  const plan0 = srv.CompactionPlan.create({ scope: 'main', trigger: 'auto', history, provider, model: MODEL, config, conversationWindow: true });
  const window = plan0.window, budget = plan0.budget;
  const rearmMargin = Math.max(2000, Math.round(window * 0.02));
  const wm = Number(state.watermark);
  const armedBudget = Number.isFinite(wm) && wm > 0 ? Math.max(budget, wm + rearmMargin) : budget;
  const sysMsg = { role: 'system', content: SYS };
  const before = srv.calibratedEstimate(provider, MODEL, [sysMsg, ...history]);
  if (before <= armedBudget) return { fired: false, mode: '', before, budget, armedBudget };

  const rawRefPrefix = 'history:' + state.seq + ':' + crypto.createHash('sha256').update(String(state.seq)).digest('hex').slice(0, 16);
  const evaporated = srv.evaporateHistory(history, {
    config, rawRefPrefix,
    boundaryBudget: srv.evaporateBudgetBoundaryEnabled(config) ? budget : 0, // 126-111a 的门,与生产同一处
    dedupeReads: srv.historyReadDedupEnabled(config),                        // 126-111e 同上
  });
  let after1 = null;
  if (evaporated > 0) {
    after1 = srv.calibratedEstimate(provider, MODEL, [sysMsg, ...history]);
    if (after1 <= budget) {
      state.watermark = after1;
      return { fired: true, mode: 'evaporate', before, after1, evaporated, released: before - after1, budget, armedBudget };
    }
  }
  const before2 = srv.calibratedEstimate(provider, MODEL, [sysMsg, ...history]);
  const target = srv.resolveCompactionProvider(config, provider);
  const summaryProvider = target.provider || provider;
  const t0 = Date.now();
  const sc = await srv.providerSummaryCall(summaryProvider, history, { model: target.model || MODEL, config, auxCtx: { trigger: 'auto_L2' } });
  const summaryMs = Date.now() - t0;
  const billed = bill(phase + ':summary', sc && sc.usage);
  budgetCheck();
  if (!sc || !sc.ok) {
    if (evaporated > 0) { state.watermark = after1; }
    return { fired: evaporated > 0, mode: evaporated > 0 ? 'evaporate' : '', before, after1, evaporated, released: after1 == null ? 0 : before - after1, budget, armedBudget, l2Error: redactKey((sc && sc.error) || 'unknown'), summaryMs, billed };
  }
  const plan = srv.CompactionPlan.create({ scope: 'main', trigger: 'auto', history, provider, model: MODEL, config, conversationWindow: true });
  state.history = srv.CompactionPlan.reseed(plan, sc.summary);
  const after2 = srv.estimateHistoryTokens([sysMsg, ...state.history]);
  state.watermark = after2;
  return {
    fired: true, mode: 'summary', before, before2, after1, after2, evaporated,
    released: after1 == null ? 0 : before - after1, budget, armedBudget,
    keptCount: plan.kept.length, tailBudget: plan.tailBudget, boundary: plan.boundary,
    recentFiles: (plan.recentFiles || []).map(f => f.path),
    summary: sc.summary, summaryChars: sc.summary.length, summaryMs, billed,
    orphans: orphanCount(state.history),
    mapReduce: sc.mapReduce ? sc.mapReduce.chunks : 0, droppedMiddle: sc.droppedMiddle || 0,
  };
}

// 通用:压缩后拿真模型回答一个可确定性核对的问题。
const ASK_MAX_TOKENS = 1200;
async function askFacts(state, phase, question, wanted) {
  const msgs = [{ role: 'system', content: SYS }, ...state.history, { role: 'user', content: question }];
  const r = await chat(phase + ':ask', msgs, { maxTokens: ASK_MAX_TOKENS });
  budgetCheck();
  if (!r.ok) return { klass: r.klass, error: r.error, ms: r.ms };
  const hits = wanted.filter(m => r.text.includes(m.trim()));
  const refusal = /无法|不知道|没有.{0,4}信息|not (?:sure|available)|cannot|don'?t (?:know|have)/i.test(r.text) && hits.length === 0;
  // **先分类再算比例**:`finish_reason === 'length'` 且一条都没命中 = 输出预算被吃光(推理型模型会
  // 把额度花在思维链上,正文只剩几个字),那是**量具**的毛病不是产品的。E1 首轮 111a #5 ON 就是这样:
  // outputTokens 恰好 700(= 当时的上限)、正文 4 字、命中 0/2 —— 首轮把它记成了 ok 的质量失分。
  // 现在它进 `truncated`,**不进分母**;上限同时抬到 1200。
  const truncated = String(r.finishReason || '') === 'length' && hits.length === 0;
  return {
    klass: truncated ? 'truncated' : (refusal ? 'refusal' : 'ok'),
    ms: r.ms, ttfbMs: r.ttfbMs, chars: r.text.length, finishReason: r.finishReason || '',
    factsHit: hits.length, factsTotal: wanted.length, hits, missing: wanted.filter(m => !hits.includes(m)),
    billed: r.billed, toolCalls: r.toolCalls.length,
  };
}

// ── 111d · 摘要 prompt 双语与标题容错 ──────────────────────────────────────────────────
// 案例怎么搭:两份**内容一一对应**的长密对话(中／英各十条事实),各自 ~2 万 token,直接过
// L2 摘要内核 `providerSummaryCall`。为什么打这条路:111d 唯一改的就是**写摘要那一头的 prompt**
// (`summaryPromptWithGuidance(config)` 按 locale 选包),再往上的两级驱动与它无关,多跑一层只是
// 多花钱。三臂:zh_off(今天的中文用户)、en_off(今天的英文用户 —— 拿到中文摘要,这就是那条缺陷)、
// en_on(开关开)。通过率由 `providerSummaryCall` 自己判:结构校验不过它直接返回
// `structured summary validation failed` —— 判据与生产同一处,不是本件另写的。
async function run111d(repeat, order) {
  const zh = factHistory(FACTS_ZH, 'zh');
  const en = factHistory(FACTS_EN, 'en');
  const arms = {
    zh_off: { history: zh, config: { ...SIM_CONFIG, locale: 'zh-CN', runtimeSummaryPromptI18nV1: false }, facts: FACTS_ZH, expectLang: 'zh' },
    en_off: { history: en, config: { ...SIM_CONFIG, locale: 'en-US', runtimeSummaryPromptI18nV1: false }, facts: FACTS_EN, expectLang: 'en' },
    en_on: { history: en, config: { ...SIM_CONFIG, locale: 'en-US', runtimeSummaryPromptI18nV1: true }, facts: FACTS_EN, expectLang: 'en' },
  };
  const names = order % 2 ? ['en_on', 'en_off', 'zh_off'] : ['zh_off', 'en_off', 'en_on'];
  const out = {};
  for (const name of names) {
    const a = arms[name];
    const provider = providerFor();
    const promptLang = langOf(srv.summaryPromptWithGuidance(a.config).slice(0, 400));
    const t0 = Date.now();
    const sc = await srv.providerSummaryCall(provider, a.history, { model: MODEL, config: a.config, auxCtx: { trigger: 'e1_111d' } });
    const ms = Date.now() - t0;
    const billed = bill('111d:' + name, sc && sc.usage);
    budgetCheck();
    if (!sc) { out[name] = { klass: 'harness_bug', error: 'no result' }; continue; }
    const validationFailed = !sc.ok && /structured summary validation failed/i.test(String(sc.error || ''));
    if (!sc.ok && !validationFailed) { out[name] = { klass: /timeout|abort/i.test(String(sc.error || '')) ? 'timeout' : 'harness_bug', error: redactKey(sc.error), ms, billed, promptLang }; continue; }
    const summary = String(sc.summary || '');
    out[name] = {
      klass: 'ok', ms, promptLang,
      validationPassed: !!sc.ok,
      summaryLang: sc.ok ? langOf(summary) : null,
      summaryLangMatchesLocale: sc.ok ? (langOf(summary) === a.expectLang) : null,
      cjkRatio: sc.ok ? Number(cjkRatio(summary).toFixed(3)) : null,
      summaryChars: summary.length,
      factsHit: sc.ok ? a.facts.filter(f => summary.includes(f.marker.trim())).length : 0,
      factsTotal: a.facts.length,
      sectionsSeen: sc.ok ? RULES.summary.sections.filter(sec => sec.some(alias => summary.toLowerCase().includes(String(alias).toLowerCase()))).length : 0,
      inputTokensEst: srv.estimateHistoryTokens(a.history),
      billed,
    };
  }
  return { repeat, arms: out };
}

// ── 111e · 历史内重复读取去重 ─────────────────────────────────────────────────────────
// 案例怎么搭(两个子案,都真的走 `dedupeRepeatedReads` 那一趟):
//   (i) legacy-tail:去重只作用在 **L1 边界之后**(44 号文 ② 的设计判断:冷区已经缩过,重复读取
//       还占位置的地方是受保护的尾部)。今天的边界是「倒数第 2 条 assistant」,所以把四次**同一
//       文件同一内容**的读取放进**一条 assistant 的并行 tool_calls**里 —— 这是 OpenAI 形并行
//       工具调用的真实形状,四条 tool 回复全部落在尾部窗口内。
//  (ii) with-111a:再把 111a 一起开 —— 尾部按 token 预算撑开,于是分散在最近几个回合里的重复
//       读取也都落在保护区内。这是「一条线程里同一个文件读了三四遍」的真实形状。
//   指标:L1 这一趟释放的 token(before − after1),两臂之比。
//   B 类非劣:压缩后问一个**只能从那份文件正文里读出来**的事实(RETRY_LIMIT / REGION_CODE)。
function historyRepeatedReads(mode) {
  CALL_SEQ = 0;
  const body = invoiceBody(120);
  const dup = readResult('billing/invoice.js', body);
  const h = [{ role: 'user', content: '排查出票重试的问题,反复核对 billing/invoice.js 与周边模块。' }];
  // pad=9 是量出来的:seed ≈ 27.7K token > 预算 24000,L1 才会真的被调用(pad=6 只有 20.8K,
  // 两臂都 `fired:false` —— 那种读数没有意义,生产里也不出现)。
  for (let i = 0; i < 9; i++) {
    h.push(...unit('file_edit', editResult(i, 40), null), ...unit('file_search', searchResult('src' + i, 26), null),
      { role: 'assistant', content: '第 ' + i + ' 段看完了。' }, { role: 'user', content: '继续。' });
  }
  if (mode === 'legacy-tail') {
    h.push({ role: 'user', content: '再把 invoice.js 完整读四遍,四个角度各看一遍。' });
    h.push(...parallelUnit('file_read', [dup, dup, dup, dup]));
    h.push({ role: 'assistant', content: '四遍都读到了,内容一致。' });
  } else {
    for (let i = 0; i < 4; i++) {
      h.push({ role: 'user', content: '第 ' + i + ' 次再读一遍 invoice.js 确认。' });
      h.push(...unit('file_read', dup, null));
      h.push({ role: 'assistant', content: '读到了。' });
    }
  }
  return h;
}
async function run111e(repeat, order) {
  const results = {};
  for (const mode of ['legacy-tail', 'with-111a']) {
    const armNames = order % 2 ? ['on', 'off'] : ['off', 'on'];
    const perMode = {};
    for (const armName of armNames) {
      const on = armName === 'on';
      const config = {
        ...SIM_CONFIG,
        runtimeHistoryReadDedupV1: on,
        runtimeEvaporateBudgetBoundaryV1: mode === 'with-111a',
        runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
      };
      const state = { history: historyRepeatedReads(mode), watermark: 0, seq: repeat };
      const seedTokens = srv.estimateHistoryTokens(state.history);
      const step = await compactStep(state, config, '111e:' + mode + ':' + armName);
      const pointers = state.history.filter(m => m.role === 'tool' && String(m.content || '').startsWith('[重复读取:')).length;
      const ask = await askFacts(state, '111e:' + mode + ':' + armName,
        '继续:invoice.js 里的重试上限(RETRY_LIMIT)当前是多少?区域批准码是什么?只回答这两个值。',
        ['7', 'RC-8842']);
      perMode[armName] = {
        klass: step.fired ? (ask.klass === 'ok' ? 'ok' : ask.klass) : 'harness_bug',
        fixtureNote: step.fired ? '' : '夹具没触发压缩(L1/L2 都没跑)—— 读数无意义',
        seedTokens, mode: step.mode, before: step.before, after1: step.after1 == null ? null : step.after1,
        releasedTokensL1: step.released || 0, evaporated: step.evaporated || 0,
        dedupPointers: pointers, budget: step.budget,
        l2Fired: step.mode === 'summary', keptCount: step.keptCount == null ? null : step.keptCount,
        orphans: step.orphans == null ? null : step.orphans,
        answer: ask,
      };
    }
    results[mode] = perMode;
  }
  return { repeat, cases: results };
}

// ── 111a / 111b · 会话增长循环 ────────────────────────────────────────────────────────
// 案例怎么搭:一条会话从「贴着窗口的长密历史」起步,之后每一轮**追加一个工具单元**
// (assistant(tool_calls) ＋ 大工具结果,约 2.5K token),每追加一轮就按生产顺序跑一次两级压缩 ——
// 这正是 `maybeAutoCompact` 在真回合里被调用的位置(每个 provider 迭代边界、下一次 API 调用之前)。
// 两臂追加的单元内容**逐字节相同**,只有开关不同;L2 触发后历史自然分叉,那正是要量的机制。
//   111a 指标 = 整条会话里 mode==='summary' 的次数。
//   111b 指标 = 重播种里「尾部为空」(plan.kept.length===0)的比例 —— 夹具只有**一个** user 回合,
//               它整条都装不进尾预算,于是今天必然 kept=[];开关开时退化为按单元装。
// 每一轮追加:一个写族单元(L1 不许蒸发 → 不可压的那一半,逼出 L2)＋一个搜索单元(可压的那一半)。
// 多回合臂(111a)另加「收尾 assistant ＋ 下一句 user」,单回合臂(111b)不加 —— 它整条线程只有
// 一个 user 回合,这正是 111b 要打的那个形状。
function growthUnit(i, singleUserTurn) {
  const out = [...unit('file_edit', editResult(i, 60), null), ...unit('file_search', searchResult('pkg' + i, 30), null)];
  if (!singleUserTurn) out.push({ role: 'assistant', content: '第 ' + i + ' 轮改完了。' }, { role: 'user', content: '继续第 ' + (i + 1) + ' 轮。' });
  return out;
}
function seedDense(singleUserTurn) {
  CALL_SEQ = 0;
  const h = [{ role: 'user', content: singleUserTurn
    ? '把整个仓库里所有用到 RETRY_LIMIT 的地方找出来,逐个文件确认,一次做完不要停。暗号 PINEAPPLE-42。'
    : '开始排查:先把仓库里所有用到 RETRY_LIMIT 的地方找出来。暗号 PINEAPPLE-42。' }];
  for (let i = 0; i < 4; i++) {
    h.push(...unit('file_search', searchResult('seed' + i, 28), null));
    if (!singleUserTurn) { h.push({ role: 'assistant', content: '第 ' + i + ' 批找完了。' }, { role: 'user', content: '继续下一批。' }); }
  }
  h.push(...unit('file_read', readResult('billing/invoice.js', invoiceBody(90)), null));
  if (!singleUserTurn) h.push({ role: 'assistant', content: 'invoice.js 读到了。' });
  return h;
}
async function runGrowth(which, repeat, order) {
  const singleUserTurn = which === '111b';
  const flagKey = which === '111a' ? 'runtimeEvaporateBudgetBoundaryV1' : 'runtimeReseedTailUnitsV1';
  // 30 轮是量出来的:18 轮一臂只摊到 1 次 L2(指标没有分母),30 轮稳定 2–3 次。
  const ITER = 30;
  const armNames = order % 2 ? ['on', 'off'] : ['off', 'on'];
  const arms = {};
  for (const armName of armNames) {
    const config = {
      ...SIM_CONFIG, [flagKey]: armName === 'on',
      runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
    };
    const state = { history: seedDense(singleUserTurn), watermark: 0, seq: repeat };
    const seedTokens = srv.estimateHistoryTokens(state.history);
    const steps = [];
    let l2 = 0, l1 = 0, emptyTail = 0, reseeds = 0, l2Failures = 0, orphanMax = 0, released = 0;
    let broke = '';
    // 「刚重播种完」那一刻的快照 —— B 类问答必须问在这儿。问在循环末尾是**不承重**的:那时
    // 后续几轮的新单元已经追加回历史,两臂手里又都有最近的工具往来了,尾部有没有留住东西量不出来。
    let lastReseed = null, lastReseedIter = -1, lastSummaryText = '', lastKeptJson = '';
    for (let i = 0; i < ITER; i++) {
      state.history.push(...growthUnit(i, singleUserTurn));
      let step;
      try { step = await compactStep(state, config, which + ':' + armName); }
      catch (e) { broke = String((e && e.message) || e); break; }
      if (step.fired || step.l2Error) {
        if (step.mode === 'evaporate') l1++;
        if (step.l2Error) l2Failures++;
        if (step.mode === 'summary') {
          l2++; reseeds++;
          if (step.keptCount === 0) emptyTail++;
          orphanMax = Math.max(orphanMax, step.orphans || 0);
          lastReseed = JSON.parse(JSON.stringify(state.history));
          lastReseedIter = i; lastSummaryText = step.summary || '';
          lastKeptJson = JSON.stringify(state.history.slice(2));
        }
        released += step.released || 0;
        steps.push({ iter: i, mode: step.mode, before: step.before, after1: step.after1 == null ? null : step.after1, after2: step.after2 == null ? null : step.after2, evaporated: step.evaporated, keptCount: step.keptCount == null ? null : step.keptCount, boundary: step.boundary == null ? null : step.boundary, orphans: step.orphans == null ? null : step.orphans, l2Error: step.l2Error || '' });
      }
    }
    // 111b 的辨别事实 = 最后一次 L2 之前那一轮追加的搜索标记 `pkg<i>`。它只存在于**尾部**,
    // 所以「摘要里有没有」要单独记 —— 答对了究竟是尾部给的还是摘要转述的,必须分得清。
    const tailMarker = 'pkg' + lastReseedIter;
    const question = which === '111b'
      ? '继续:你最近一次代码搜索是在哪个包目录下做的(形如 pkgNN)?本次任务的暗号是什么?只回答这两项。'
      : '继续:本次任务的暗号是什么?invoice.js 里的 RETRY_LIMIT 是多少?只回答这两项。';
    const wanted = which === '111b' ? [tailMarker, 'PINEAPPLE-42'] : ['PINEAPPLE-42', '7'];
    const ask = lastReseed
      ? await askFacts({ history: lastReseed }, which + ':' + armName, question, wanted)
      : { klass: 'harness_bug', error: '整条循环没有一次 L2,配对指标无分母' };
    arms[armName] = {
      klass: broke ? 'harness_bug' : (lastReseed ? (ask.klass === 'ok' ? 'ok' : ask.klass) : 'harness_bug'),
      broke: broke || '', seedTokens, iterations: ITER,
      l1Count: l1, l2Count: l2, l2Failures, reseeds, emptyTailReseeds: emptyTail,
      emptyTailRate: reseeds ? Number((emptyTail / reseeds).toFixed(3)) : null,
      releasedTokensTotal: released, orphansMax: orphanMax,
      askedAfterIter: lastReseedIter, tailMarker: which === '111b' ? tailMarker : '',
      markerInSummary: which === '111b' ? lastSummaryText.includes(tailMarker) : null,
      markerInKeptTail: which === '111b' ? lastKeptJson.includes(tailMarker) : null,
      finalTokens: srv.estimateHistoryTokens(state.history), steps, answer: ask,
    };
  }
  return { repeat, arms };
}

// ── 111c · 重播种后重附最近读过的文件 ────────────────────────────────────────────────
// 案例怎么搭:会话里**读过** billing/invoice.js(要用的事实落在头 40 行内 —— 重附块只带头 40 行,
// 事实不在里面这条判据就是空的),随后历史涨到越预算、L2 重播种。重播种之后给真模型挂上工具,
// 派一件**必须知道那个常量当前值**的活。量的就是 25 号文那条指标:「压缩后首个工具调用为
// 『重读已知文件』的比率」。首动作三分类:
//   reread_known_file(file_read 打在已经读过的路径上)／answered_without_read(直接给答案)／other。
//
// `--c-fact` 选用哪个事实(默认 `salt`):
//   * `retry` = E1 首轮用的 `RETRY_LIMIT = 7`。**这一档是被污染的**:它就是任务目标本身,真摘要
//     把它原文抄进了【关键文件与上下文】,于是关臂的 `factAnywhere` 也是 true —— 两臂手里都有答案,
//     开关决定不了模型要不要重读。读数保留(首轮六次都在),但本件把它标成 `harness_bug`。
//   * `salt` = `SHARD_SALT = 'Q7X-LUMEN'`,与任务目标无关的低显著度常量,摘要不会去抄。
//     这一档才能把「这份文件在不在上下文里」与「模型要不要重读」隔离开。
const TOOLS_111C = [
  { type: 'function', function: { name: 'file_read', description: '读取一个文本文件的内容。', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'integer' }, endLine: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'file_edit', description: '把文件里的一段文本替换成另一段。', parameters: { type: 'object', properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } }, required: ['path', 'find', 'replace'] } } },
  { type: 'function', function: { name: 'file_search', description: '在仓库里按关键字搜索。', parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'powershell_run', description: '在工作目录里执行一条 PowerShell 命令。', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
];
const KNOWN_PATHS = ['billing/invoice.js', 'billing/queue.js'];
const C_FACTS = {
  retry: {
    label: 'RETRY_LIMIT = 7', needle: /RETRY_LIMIT = 7/, answer: /\b7\b/,
    task: '接着做:把 billing/invoice.js 里的重试上限改成 9。先把它**现在**的值说出来,再动手。',
  },
  salt: {
    label: "SHARD_SALT = 'Q7X-LUMEN'", needle: /Q7X-LUMEN/, answer: /Q7X[- ]?LUMEN/i,
    task: '接着做:把 billing/invoice.js 里的分片盐值(SHARD_SALT)换成 Z2M-VERDE。先把它**现在**的值原样说出来,再动手。',
  },
};
const C_FACT = C_FACTS[String(arg('c-fact', 'salt'))] ? String(arg('c-fact', 'salt')) : 'salt';
const FACT = C_FACTS[C_FACT];
function seed111c() {
  CALL_SEQ = 0;
  const h = [{ role: 'user', content: '把出票这块的几个常量核一遍,先摸清现状。暗号 PINEAPPLE-42。' }];
  for (let i = 0; i < 5; i++) {
    h.push(...unit('file_search', searchResult('svc' + i, 28), null));
    h.push({ role: 'assistant', content: '第 ' + i + ' 批搜完了。' }, { role: 'user', content: '继续。' });
  }
  h.push(...unit('file_read', readResult('billing/queue.js', invoiceBody(60).replace('invoice.js', 'queue.js')), null));
  h.push({ role: 'assistant', content: 'queue.js 读到了。' }, { role: 'user', content: '再读 invoice.js。' });
  h.push(...unit('file_read', readResult('billing/invoice.js', invoiceBody(110)), null));
  h.push({ role: 'assistant', content: 'invoice.js 也读到了,几个常量都在文件头部。' });
  return h;
}
async function run111c(repeat, order) {
  const armNames = order % 2 ? ['on', 'off'] : ['off', 'on'];
  const arms = {};
  for (const armName of armNames) {
    const config = {
      ...SIM_CONFIG, runtimeReseedReattachFilesV1: armName === 'on',
      runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
    };
    const state = { history: seed111c(), watermark: 0, seq: repeat };
    const seedTokens = srv.estimateHistoryTokens(state.history);
    // 涨到越预算为止(最多 12 轮),然后要求走到 L2。
    let step = null, iter = 0;
    while (iter < 14) {
      step = await compactStep(state, config, '111c:' + armName);
      if (step.mode === 'summary') break;
      state.history.push(...growthUnit(iter, false)); iter++;
    }
    if (!step || step.mode !== 'summary') { arms[armName] = { klass: 'harness_bug', error: '没能走到 L2', seedTokens }; continue; }
    const reseeded = state.history;
    const reattachedInPrompt = /最近读过的文件/.test(String(reseeded[0] && reseeded[0].content || ''));
    const headHasFact = FACT.needle.test(String(reseeded[0] && reseeded[0].content || ''));
    // 判据承重自检:关臂的重播种历史里**任何地方**都不该还留着那个事实 —— 留着就说明
    // 「模型要不要重读」这件事根本没被开关决定,这一格读数作废(记 harness_bug,不进分母)。
    const factAnywhere = FACT.needle.test(JSON.stringify(reseeded));
    const probe = await chat('111c:' + armName + ':probe', [
      { role: 'system', content: SYS + ' 你可以调用工具。工作目录是 ' + SIM_WORK + '。动手前先把当前值说出来。' },
      ...reseeded,
      { role: 'user', content: FACT.task },
      // 1500 而不是 500:推理型模型会把额度花在思维链上,正文与 tool_calls 双空 —— E1 第二轮
      // 111c 关臂六次里有四次就是这么变成 `empty` 的(量具的毛病,不是产品的)。
    ], { tools: TOOLS_111C, maxTokens: 1500 });
    budgetCheck();
    if (!probe.ok) { arms[armName] = { klass: probe.klass, error: probe.error, ms: probe.ms, seedTokens }; continue; }
    const first = probe.toolCalls[0] || null;
    let firstPath = '';
    if (first) { try { firstPath = String((JSON.parse(first.args || '{}') || {}).path || ''); } catch { firstPath = ''; } }
    const isKnown = !!firstPath && KNOWN_PATHS.some(p => firstPath.replace(/\\/g, '/').endsWith(p) || p.endsWith(firstPath.replace(/\\/g, '/')));
    const saidValue = FACT.answer.test(probe.text);
    const firstAction = !first
      ? (saidValue ? 'answered_without_read' : 'answered_without_read_wrong')
      : (first.name === 'file_read' && isKnown ? 'reread_known_file' : 'other_tool:' + first.name);
    // 关臂里那个事实**仍然在上下文里**这件事,两轮实测都成立:真摘要会把它读过的那个文件里的
    // 常量原文抄进【关键文件与上下文】。换低显著度常量(salt)没能绕开 —— 夹具的任务本身就在说
    // 「核一遍常量」。所以这里不再把关臂整格作废(那样首动作比率**连分母都没有**),改成:
    // 照样计入 `ok`,另记一个 `confounded` 位,读数分「全部有效」与「未被污染的那些」两栏算。
    arms[armName] = {
      klass: 'ok',
      confounded: armName === 'off' && factAnywhere,
      fixtureNote: (armName === 'off' && factAnywhere) ? ('关臂历史里仍留着「' + FACT.label + '」(真摘要抄进去的)——「要不要重读」这一格是配对的但被污染') : '',
      factVariant: C_FACT,
      seedTokens, l2: { keptCount: step.keptCount, recentFiles: step.recentFiles, summaryChars: step.summaryChars, orphans: step.orphans },
      reattachedInPrompt, headHasFact, factAnywhere,
      firstAction, firstToolName: first ? first.name : '', firstToolPath: firstPath,
      saidCurrentValue: saidValue, replyChars: probe.text.length,
      toolCallCount: probe.toolCalls.length, ms: probe.ms, ttfbMs: probe.ttfbMs, billed: probe.billed,
    };
  }
  return { repeat, arms };
}

// ── 主流程 ─────────────────────────────────────────────────────────────────────────────
function fingerprint(label) {
  const targets = [
    ['wcw-config', path.join(REAL_HOME_DIR, '.win-claude-workbench', 'config.json')],
    ['scheduler-tasks', path.join(REAL_HOME_DIR, '.win-claude-workbench', 'scheduler', 'tasks-v1.json')],
    ['claude-json', path.join(REAL_HOME_DIR, '.claude.json')],
    ['kimi-mcp', path.join(REAL_HOME_DIR, '.kimi-code', 'mcp.json')],
  ];
  const out = { label, at: new Date().toISOString(), files: {} };
  for (const [k, p] of targets) {
    try {
      const b = fs.readFileSync(p); const st = fs.statSync(p);
      out.files[k] = { sha256_12: crypto.createHash('sha256').update(b).digest('hex').slice(0, 12), bytes: b.length, mtime: st.mtime.toISOString() };
    } catch (e) { out.files[k] = { error: e.code }; }
  }
  return out;
}
function shredSecrets() {
  const removed = [];
  try { fs.rmSync(SIM_CONFIG_FILE, { force: true }); removed.push(SIM_CONFIG_FILE); } catch { /* ignore */ }
  // 复扫证据目录与 sim 数据家:任何含密钥尾四位的文件都报出来(不打印内容)。
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
  walk(DIR);
  for (const p of hits) { try { fs.rmSync(p, { force: true }); removed.push(p); } catch { /* ignore */ } }
  return { removed, rescanHits: hits.length ? [] : [], keyTail: KEY_TAIL };
}

(async () => {
  const readings = {
    schema: 1, harnessVersion: HARNESS_VERSION, wave: '107-E1',
    startedAt: new Date().toISOString(),
    environment: {
      model: MODEL, providerId: PROVIDER_ID, providerHost: (() => { try { return new URL(realProvider.baseUrl).host; } catch { return String(realProvider.baseUrl || ''); } })(),
      contextWindowManual: SIM_CONFIG.providers[0].contextWindow,
      budget: Math.round(SIM_CONFIG.providers[0].contextWindow * 0.8),
      pricingCnyPerM: PRICING, node: process.version, platform: process.platform,
      simDir: DIR, repeats: REPEATS, switches: SWITCHES,
      compactionRules: RULES.compactionPlan,
      summaryReserveTokens: (() => { try { return srv.summarySingleShotReserveTokens(SIM_CONFIG); } catch { return null; } })(),
      notes: [
        '进程内跑真源码;两级驱动照抄 10-context-governance.js:2218-2309 的 maybeAutoCompact 顺序',
        'repairProviderHistoryPairing / writeHistorySnapshot / recordCompactUsage 未导出:分别用自做孤儿检查、合成 rawRefPrefix、自行按 sc.usage 记账代替',
        '111c 的工具 schema 与系统提示由本件提供(产品 MCP_TOOLS 未导出);两臂同一份,配对成立、绝对比率不等于产品实测',
      ],
    },
    fingerprints: [fingerprint('① 开工前')],
    results: {}, nonOk: [], spend: null, errors: [],
  };
  const save = () => {
    readings.spend = { ...spend, cny: Number(spend.cny.toFixed(4)) };
    readings.finishedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(readings, null, 2), 'utf8');
    fs.writeFileSync(path.join(EVID, 'readings.json'), JSON.stringify(readings, null, 2), 'utf8');
  };

  console.log('E1 · 111 五开关真模型配对读数');
  console.log('证据目录: ' + DIR);
  console.log('provider: ' + PROVIDER_ID + ' / ' + MODEL + ' | 手动窗口 ' + SIM_CONFIG.providers[0].contextWindow + ' → 预算 ' + Math.round(SIM_CONFIG.providers[0].contextWindow * 0.8));
  console.log('开关: ' + SWITCHES.join(',') + ' | repeats ' + REPEATS + ' | 预算上限 ¥' + BUDGET_CNY + '\n');

  const runners = { '111d': run111d, '111e': run111e, '111a': (r, o) => runGrowth('111a', r, o), '111b': (r, o) => runGrowth('111b', r, o), '111c': run111c };
  let secondFp = false;
  try {
    for (const sw of SWITCHES) {
      if (!runners[sw]) { readings.errors.push('未知开关 ' + sw); continue; }
      readings.results[sw] = [];
      for (let r = 1; r <= REPEATS; r++) {
        const t0 = Date.now();
        let row;
        try { row = await runners[sw](r, r); }
        catch (e) {
          const msg = redactKey(String((e && e.message) || e));
          readings.errors.push(sw + ' repeat ' + r + ': ' + msg);
          console.log('  ' + sw + ' #' + r + ' 中断: ' + msg);
          if (/BUDGET_STOP/.test(msg)) { save(); throw e; }
          row = { repeat: r, klass: 'harness_bug', error: msg };
        }
        row.wallMs = Date.now() - t0;
        readings.results[sw].push(row);
        if (!secondFp) { readings.fingerprints.push(fingerprint('② 首次 require + 首个真模型调用之后')); secondFp = true; }
        console.log('  ' + sw + ' #' + r + ' 完成 (' + (row.wallMs / 1000).toFixed(1) + ' s, 累计 ¥' + spend.cny.toFixed(4) + ')');
        save();
      }
    }
  } catch (e) {
    readings.errors.push('提前收束: ' + redactKey(String((e && e.message) || e)));
  }

  readings.fingerprints.push(fingerprint('③ 收尾'));
  readings.secrets = shredSecrets();
  save();
  console.log('\n花费: ' + spend.calls + ' 次调用 / 输入 ' + spend.inputTokens + '(缓存 ' + spend.cachedInputTokens + ') / 输出 ' + spend.outputTokens + ' / ¥' + spend.cny.toFixed(4));
  console.log('读数已落盘: ' + OUT);
})().catch(e => { console.error(String((e && e.stack) || e)); process.exitCode = 1; });
