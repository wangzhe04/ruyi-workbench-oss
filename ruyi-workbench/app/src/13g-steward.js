// ============================================================================
// 第 116 波 116c(27 号文 §3.5「管家工具面设计」/ §4「管家记忆层」):管家(Steward)域路由、
// 决策日志、记忆存储与全部管家工具的实现。
//
// 落点(transport 层,manifest 中位于 13i-steward-inbox.js 之后、13h-steward-runner.js 之前)。
// 116-2e 拆分:收件箱轮询与游标(原本是本文件的前半)整体前移到 `13i-steward-inbox.js`,零行为搬家;
//   本文件引用它的符号(stewardDir / stewardInboxRead / stewardInboxState / startStewardInbox …)
//   全部是后向边。理由见 13i 的文件头。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 13g 只引用拼接顺序在它之前的模块符号(00/01/01b/02/06i/08/13e/13i …),全部后向边;
//   · 13-http-router.js 【不得】直接引用本文件的任何符号 —— 那会是前向边。挂接走延迟绑定:
//     本文件在加载时 `Object.assign(StewardHooks, { handleApiRoutes, stopInbox, inboxRead, ... })`,
//     13 只写 `StewardHooks.handleApiRoutes`(13 → 06i 是后向边);
//   · 12-tool-dispatch.js 的管家工具 handler 同理,只写 `StewardHooks.<键>(args, ctx)`。
//
// 开关(§3.4 红线):`stewardEnabledV1 !== true` 时路由 409 `steward.disabled`、工具门控壳零写入。
// ============================================================================

// ────────────────────────────────────────────────────────────────────────────
// 路由(全部 token 级,ROUTE_AUTH 在 01b-route-auth.js 登记;handler 内另做 tokenOk 纵深自查)。
// 13-http-router.js 只经 StewardHooks.handleApiRoutes 调用本函数,不直接引用它(禁止前向边)。
// ────────────────────────────────────────────────────────────────────────────
// 形态与 handleOverlayApiRoutes 一致:命中即 send(调用方以 res.writableEnded 为命中信号),
// 不命中就自然返回让路由链继续(不写前缀早退守卫 —— 那会在路由清册里多出一个无鉴权首配的裸前缀判定点)。
// 116-2e 记忆面板六条路由共用的两道闸:token 级鉴权 + 管家总开关。命中返回要 send 的响应对象,
// 放行返回 null。抽出来是为了让每条路由只多一行 —— 而不是为了少写一个前缀守卫就把闸也省了。
async function stewardPanelGate(req) {
  if (!tokenOk(req)) return apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403);
  const config = await readConfig();
  if (config.stewardEnabledV1 !== true) return apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409);
  return null;
}
// 域层稳定信封 -> 路由层 apiFailure(不转的话会被 normalizeApiErrorPayload 归一成 api.request_failed)。
function stewardPanelFailure(result) {
  const code = String((result && result.error) || 'invalid_request');
  const status = code === 'version_conflict' ? 409 : (code === 'not_found' ? 404 : 400);
  return apiFailure(code, {}, String((result && result.message) || code), status);
}

async function handleStewardApiRoutes(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/steward/start') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const started = await startStewardInbox(config);
    return send(res, json({ ok: true, running: Boolean(started && started.running) }));
  }

  if (req.method === 'POST' && pathname === '/api/steward/stop') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    stopStewardInbox();
    return send(res, json({ ok: true, running: false }));
  }

  if (req.method === 'GET' && pathname === '/api/steward/state') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    // 116f: 收件箱状态之上并进回合运行器状态(visit/turns/cost/circuit/lastReply)。运行器故障时
    // 这条只读路由仍然返回收件箱那一半 —— 状态面不该因为旁路组件出错而整条不可用。
    let runner = {};
    if (typeof StewardHooks.runnerState === 'function') {
      try { runner = (await StewardHooks.runnerState(config)) || {}; } catch { runner = {}; }
    }
    return send(res, json({ ok: true, ...await stewardInboxState(config), ...runner }));
  }

  if (req.method === 'GET' && pathname === '/api/steward/inbox') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const query = new URL(req.url, 'http://x').searchParams;
    const result = await stewardInboxRead({ since: query.get('since'), limit: query.get('limit') });
    return send(res, json({ ok: true, ...result }));
  }

  // 116-pre(27号文§8.12/§11.1第3项/§11.3):递话预判——只读、零模型、不写盘。装配(读投影+会话头+
  // 记忆存储、缓存)在 13h-steward-runner.js(拼接顺序在本文件之后),故经 StewardHooks 转交(同
  // handleRunnerApiRoutes 一手法);q 长度在这里再夹一遍(纯函数自己也夹,双重防线)。tookMs 只计
  // StewardHooks.preroute 这一段(排除 token 校验与 HTTP 层开销),与「p50 ≤50ms」的度量口径对齐。
  if (req.method === 'GET' && pathname === '/api/steward/preroute') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const config = await readConfig();
    if (config.stewardEnabledV1 !== true) {
      return send(res, apiFailure('steward.disabled', {}, 'steward is disabled (stewardEnabledV1=false)', 409));
    }
    const query = new URL(req.url, 'http://x').searchParams;
    const q = String(query.get('q') || '').slice(0, STEWARD_PREROUTE_QUERY_MAX);
    const startedAt = Date.now();
    const result = typeof StewardHooks.preroute === 'function'
      ? await StewardHooks.preroute(q, config)
      : { kind: 'new', hits: [] }; // 理论上不可能(13h 恒填充);兜底而不是抛异常
    const tookMs = Date.now() - startedAt;
    return send(res, json({ ok: true, kind: result.kind, hits: result.hits, tookMs }));
  }

  // ── 116-2e 记忆面板(27 号文 §4「面板」:按 kind 分组、可编辑、可否决、可清空、导出 JSON)──────
  // 六条 exact 路由,与其余 /api/steward/* 同一鉴权等级(token 级,ROUTE_AUTH 逐条登记)。刻意【不写】
  // `pathname.startsWith('/api/steward/memory')` 的前缀守卫 —— 那会在路由清册里多出一个裸前缀判定点
  // (116b 的原注释已经写明这条纪律);共用的「token + 开关」两道闸抽成 stewardPanelGate 一行调用。
  // 稳定信封必须在【路由层】转成 apiFailure —— 域层的 {ok:false,error} 送进 json() 会被
  // normalizeApiErrorPayload 归一成 api.request_failed(116g 交付记录里的硬教训)。
  if (req.method === 'GET' && pathname === '/api/steward/memory') {
    const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
    const result = await stewardMemoryPanelList(new URL(req.url, 'http://x').searchParams.get('kind') || '');
    return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
  }

  if (req.method === 'GET' && pathname === '/api/steward/memory/export') {
    const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
    return send(res, json(await stewardMemoryPanelExport()));
  }

  if (req.method === 'POST' && pathname === '/api/steward/memory/edit') {
    const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
    const result = await stewardMemoryPanelEdit(await readJsonBody(req).catch(() => ({})));
    return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
  }

  if (req.method === 'POST' && pathname === '/api/steward/memory/veto') {
    const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await stewardImplMemoryVeto({ id: (body && body.id) || '' });
    return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
  }

  if (req.method === 'POST' && pathname === '/api/steward/memory/restore') {
    const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await stewardMemoryPanelRestore((body && body.id) || '');
    return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
  }

  if (req.method === 'POST' && pathname === '/api/steward/memory/clear') {
    const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
    const body = await readJsonBody(req).catch(() => ({}));
    const result = await stewardMemoryPanelClear((body && body.confirm) || '');
    return send(res, result.ok === false ? stewardPanelFailure(result) : json(result));
  }

  // ── 117e 第 0 步:行动流水的只读面(§8.6 末条)────────────────────────────────────────
  // 与记忆面板同族(exact 路由、token 级、共用 stewardPanelGate 的两道闸)。纯只读:不建目录、
  // 不写盘、不启轮询。每行的 args 与 basis 过一遍 116-2e 的密钥判据再出门。
  if (req.method === 'GET' && pathname === '/api/steward/decisions') {
    const gate = await stewardPanelGate(req); if (gate) return send(res, gate);
    const query = new URL(req.url, 'http://x').searchParams;
    return send(res, json(await stewardDecisionsRead({
      limit: query.get('limit'), sessionId: query.get('sessionId'), since: query.get('since'),
    })));
  }

  // 116f: /api/steward/{visit,message,act} 住 13h-steward-runner.js(拼接顺序在本文件【之后】)。
  // 与 13 挂 13g 同一手法:直接写函数名会是前向边,故经 06i 的延迟绑定命名空间转交;未填充时本行
  // 是无操作,路由链继续往下走(最终 404)。命中与否仍以 res.writableEnded 为准。
  if (typeof StewardHooks.handleRunnerApiRoutes === 'function') {
    await StewardHooks.handleRunnerApiRoutes(req, res, pathname);
  }
}


// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116c(27 号文 §3.5 工具面 / §4 记忆层 / §11.2 读预算):管家工具集实现。
//
// 定位:12-tool-dispatch.js 里的 17 个 steward_* handler 只写一行 `StewardHooks.xxx(args, ctx)`,
// 真实实现全在这里。这样 12(工具层)→ 06i(引擎层命名空间)是后向边,13g(传输层)单向往 06i 挂方法,
// 全程零新增前向边。
//
// 铁律(§3.4 红线 + §3.3):
//   ① 管家「动如意」,不「动世界」—— 本文件不提供任何文件读写/shell/桌面/浏览器/联网/git 写能力;
//      要动手就 steward_thread_new / steward_thread_continue 委派给线程,由线程按自己的权限档执行。
//   ② 双重 fail-closed:stewardEnabledV1 !== true -> steward.disabled(零写入);
//      ctx.session.kind !== 'steward' -> steward.forbidden(普通会话即使拿到工具名也调不动)。
//   ③ 管家只能收紧,不能放宽:放行范围一律经 06i 的 stewardMayAct(目标线程 permissionMode, ...);
//      永久豁免清单(stewardToolPermanentlyExempt)在任何权限档都返回 propose_required。
//   ④ 每个写动作追加一行决策日志 `<data>/steward/decisions-v1.ndjson`,带 undoRef 与依据。
// ════════════════════════════════════════════════════════════════════════════

// ── 落盘常量(两个新面,已登记进 durable-state-inventory)────────────────────────────────────
const STEWARD_DECISIONS_FILE = 'decisions-v1.ndjson';
const STEWARD_MEMORY_FILE = 'memory-v1.json';
const STEWARD_MEMORY_SCHEMA = 1;

// ── 工具面数值口径 ──────────────────────────────────────────────────────────────────────
const STEWARD_SEARCH_LIMIT_DEFAULT = 10, STEWARD_SEARCH_LIMIT_MAX = 50;
const STEWARD_LAST_SAY_CHARS = STEWARD_DIGEST_LIMITS.lastSayChars;   // 200,与总览行同一口径
const STEWARD_READ_TAIL_DEFAULT = 6, STEWARD_READ_TAIL_MAX = 20;
const STEWARD_READ_CHARS_DEFAULT = 12000, STEWARD_READ_CHARS_MIN = 1000, STEWARD_READ_CHARS_MAX = 12000;
const STEWARD_READ_CALLS_PER_TURN = 6;      // §11.2:每回合 ≤6 次深读
const STEWARD_AUDIT_LIMIT_DEFAULT = 20, STEWARD_AUDIT_LIMIT_MAX = 100;
const STEWARD_TITLE_MAX = 80;
const STEWARD_STEER_TEXT_MAX = 2000;
// 116-2b steward_thread_note:管家给【已在跑】的线程补一句上下文。600 字上限比 steer_node 的 2000
// 紧得多 —— 它是"补一句",不是"改任务";前缀由服务端加,与 [用户插话] 的前缀纪律同精神(用户一眼
// 就能分清哪句是自己说的、哪句是管家加的)。
const STEWARD_NOTE_TEXT_MAX = 600;
const STEWARD_NOTE_PREFIX = '（管家补充）';
const STEWARD_PENDING_SUMMARY_MAX = 12;     // thread_status 里最多列几条待决摘要
const STEWARD_RUNS_MAX = 20;                // runs_status 单次最多返回几个 run digest
// 116-2e:同义合并时保留的来源 ref 上限(§4 ⑥「mergedFrom 最多 5 个来源 ref」)。
const STEWARD_MEMORY_MERGED_FROM_MAX = 5;
const STEWARD_MEMORY_NEW_WINDOW_MS = 24 * 60 * 60 * 1000;  // §4 ⑤「新写入 24 小时内带『新』标记」
const STEWARD_PLAYBOOK_DRAFTS_PER_TURN = 1;                // §3.5 内容管理:起草要调模型,每回合一次
const STEWARD_QUICK_ASKS_PER_TURN = 2;                     // §11.1 第 2 项:速查线程每回合最多两条

// ── 稳定信封 ────────────────────────────────────────────────────────────────────────────
// 形状与 105a observation_recall 同源:{ ok:false, error:<稳定码>, message:<人话> }。error 是模型要
// 分支的机器码,message 只给人看;调用方(模型)对 propose_required / quota_exceeded / steward.busy
// 一律不重试 —— schema description 里写明了。
function stewardFail(code, message, extra) {
  return { ok: false, error: String(code), message: String(message || code), ...(extra && typeof extra === 'object' ? extra : {}) };
}

// 管家会话身份:只认会话头上【显式】的 kind === 'steward'。有意不用 sessionKind()——那个归一化函数
// 只回 'mission'|'quick_ask',把管家会话也算成普通会话,拿它做身份判定等于把门拆了。
function stewardCtxIsSteward(ctx) {
  const session = ctx && ctx.session;
  return !!(session && typeof session === 'object' && session.kind === 'steward');
}

// 17 个工具共用的门控壳:开关 -> 身份 -> 实现 -> 异常兜底。单一判定点(12 的 handler 不重复判断)。
function stewardToolHandler(toolName, impl) {
  return async (args, ctx) => {
    let config = null;
    try { config = await readConfig(); } catch { config = null; }
    if (!config || config.stewardEnabledV1 !== true) {
      return stewardFail('steward.disabled', `${toolName} is unavailable: the workbench steward is disabled (stewardEnabledV1=false)`);
    }
    if (!stewardCtxIsSteward(ctx)) {
      return stewardFail('steward.forbidden', `${toolName} is only available to the workbench steward session (session.kind must be 'steward')`);
    }
    try {
      // 116-2e:剥掉 args 里任何名为 userPressed 的字段。它的唯一合法来源是 ctx(由 13h 的
      // POST /api/steward/act 在用户【亲手按下按钮】时置 true);模型在参数里自称「用户按了」
      // 不算数,静默丢弃比报错更稳(报错会让模型学会换个名字再试一次)。
      const raw = (args && typeof args === 'object' && !Array.isArray(args)) ? args : {};
      const clean = {};
      for (const key of Object.keys(raw)) { if (key !== 'userPressed') clean[key] = raw[key]; }
      return await impl(clean, ctx || {}, config);
    } catch (error) {
      const message = String((error && error.message) || error);
      logEvent({ kind: 'steward_tool_error', tool: toolName, message: message.slice(0, 400) });
      return stewardFail('steward.failed', `${toolName} failed: ${message}`);
    }
  };
}

// ── 小工具 ──────────────────────────────────────────────────────────────────────────────
function stewardClampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}
function stewardClipSay(value) {
  const raw = stewardSanitizeText(value);
  return raw.length > STEWARD_LAST_SAY_CHARS ? raw.slice(0, STEWARD_LAST_SAY_CHARS) + '…' : raw;
}
// 会话头的原始 kind(未经 sessionKind 归一)。管家会话过滤与目标合法性判定都靠它。
async function stewardReadSessionHead(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return null;
  try {
    const head = safeJsonParse(await fsp.readFile(sessionPath(sid), 'utf8'), null);
    // 116-2a: 这条读路径绕过 loadSession(只要头,不装正文),所以要自己盖一次会话级权限档的内存
    // 覆盖表 —— 否则用户刚在活回合期间切了档、还没落盘,管家读到的就是旧档(见 02 的覆盖表头注)。
    return head && typeof head === 'object' ? applySessionPermissionModeOverride(head) : head;
  } catch { return null; }
}
function stewardRawKind(head) {
  const k = head && head.kind;
  return (typeof k === 'string' && k) ? k : (head && head.mission ? 'mission' : 'quick_ask');
}
// 线程的【生效】权限档 = resolvePermissionMode 的会话级 > 全局两层(§3.3「新线程用全局默认权限」)。
// 116-2a:改为直调 01-config 的解析器,与回合执行侧(runSessionTurn)用的是同一个函数、同一张白名单 ——
// 管家判「我能不能替它答」与线程实际按哪档执行,从此不可能各算各的。请求级那一层是回合内临时值,
// 不在会话头上,管家看不到也不该看到(它只对那一单当前执行链有效)。
function stewardThreadPermissionMode(head, config) {
  return resolvePermissionMode({ session: head, config });
}
function stewardLastAssistantText(session) {
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'assistant' && String(m.content || '').trim()) return String(m.content);
  }
  return String((session && session.summary) || '');
}
function stewardEngineOf(head) {
  const route = (head && head.engineRoute && typeof head.engineRoute === 'object') ? head.engineRoute : null;
  if (!route) return { engine: '', model: '' };
  return {
    engine: route.engine === 'openai' ? 'openai' : (route.agentCliType || 'claude'),
    model: String(route.model || ''),
    providerId: String(route.providerId || ''),
  };
}

// ── 决策日志(§3.5「所有写工具返回 undoRef,决策日志记录」)───────────────────────────────
// 与 inbox 同款 append-only 纪律:先 repairMissionChangeTornTail 把尾部半行截干净,再整行 appendFile,
// 全部经一条 per-process 串行链。开关关时根本走不到这里(门控壳先返回 steward.disabled)。
const stewardDecisionsPath = () => path.join(stewardDir(), STEWARD_DECISIONS_FILE);
let stewardDecisionChain = Promise.resolve();
let stewardDecisionSeq = 0;
// 116-2b:自理动作的溯源基底。13h 在【工具入参】上挂一个内部字段 stewardBasis({inboxSeq,auto,origin}),
// 由下面两个实现并进决策日志的 basis —— 事后能分清「这一次重试是管家自理做的、由第 N 条收件箱
// 事件触发」。它不在工具 schema 里(additionalProperties:false),模型即使编造出来也只影响日志注解,
// 不影响任何判定;args 照旧只记摘要字段,这一坨不进 args。
function stewardBasisOf(args, extra) {
  const raw = (args && typeof args.stewardBasis === 'object' && args.stewardBasis) ? args.stewardBasis : null;
  const base = (extra && typeof extra === 'object') ? { ...extra } : {};
  if (!raw) return base;
  if (raw.inboxSeq != null) base.inboxSeq = Number(raw.inboxSeq) || 0;
  if (raw.auto != null) base.auto = raw.auto === true;
  if (raw.origin) base.origin = String(raw.origin).slice(0, 40);
  return base;
}

function stewardAppendDecision(row) {
  const record = {
    seq: ++stewardDecisionSeq,
    at: nowIso(),
    tool: String((row && row.tool) || ''),
    args: (row && row.args && typeof row.args === 'object') ? row.args : {},
    targetSessionId: String((row && row.targetSessionId) || ''),
    permissionMode: String((row && row.permissionMode) || ''),
    mayAct: String((row && row.mayAct) || ''),
    undoRef: (row && row.undoRef) || null,
    basis: (row && row.basis && typeof row.basis === 'object') ? row.basis : {},
  };
  const line = JSON.stringify(record) + '\n';
  stewardDecisionChain = stewardDecisionChain.then(async () => {
    await fsp.mkdir(stewardDir(), { recursive: true });
    const file = stewardDecisionsPath();
    await repairMissionChangeTornTail(file);
    await fsp.appendFile(file, line, 'utf8');
  }).catch(() => {}); // 记账失败绝不回滚已经做完的动作(与 usage ledger 同款 fire-and-forget 纪律)
  return record;
}

// ── 决策日志的只读面(117e 第 0 步 · §8.6「行动流水」)────────────────────────────────────
// 在 117e 之前决策日志【只有】工具 `steward_audit_tail` 能读 —— 也就是说,只有模型看得见管家做过
// 什么,用户看不见。§8.6 明写「行动流水页按时间列出管家做过的每件事(依据、线程权限、undoRef、
// 费用),支持按线程与按日期过滤」,那需要一条 HTTP 只读面。
//
// 纪律与 inbox 尾窗读取同源(13i stewardReadInboxText/ParseInboxText 的形状):小文件整读、大文件只读
// 尾窗并丢首个半行、坏行整行跳过、文件不存在 = 空(绝不 mkdir —— 开关关时零持久化写入的红线)。
const STEWARD_DECISIONS_LIMIT_DEFAULT = 50;
const STEWARD_DECISIONS_LIMIT_MAX = 200;
const STEWARD_DECISIONS_FULL_READ_BYTES = 8 * 1024 * 1024;
const STEWARD_DECISIONS_TAIL_BYTES = 1024 * 1024;
const STEWARD_DECISIONS_MASK = '••••';

// args 里像密钥的值一律掩码。**判据复用 116-2e 的那一条**(06i 的 STEWARD_CONFIG_SECRET_PATTERN,
// `/apiKey|token|secret|password/i`)—— 不另写第二份正则:两份正则迟早会漂移,而漂移的方向永远是
// 「新面漏掉了旧面拦住的东西」。按【键名】判定(值本身可能是任意串,按值猜是猜不准的),对象递归,
// 深度与宽度都有硬顶(决策日志的 args 本就只记摘要字段,超了说明写日志的地方出了别的问题)。
function stewardMaskDecisionArgs(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => stewardMaskDecisionArgs(item, depth + 1));
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (STEWARD_CONFIG_SECRET_PATTERN.test(key)) { out[key] = STEWARD_DECISIONS_MASK; continue; }
    out[key] = stewardMaskDecisionArgs(item, depth + 1);
  }
  return out;
}

async function stewardReadDecisionsText() {
  const file = stewardDecisionsPath();
  let size = -1;
  try { size = (await fsp.stat(file)).size; } catch { return { text: '', droppedHead: false }; }
  if (size <= STEWARD_DECISIONS_FULL_READ_BYTES) {
    try { return { text: await fsp.readFile(file, 'utf8'), droppedHead: false }; } catch { return { text: '', droppedHead: false }; }
  }
  let fh = null;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(STEWARD_DECISIONS_TAIL_BYTES);
    const { bytesRead } = await fh.read(buf, 0, STEWARD_DECISIONS_TAIL_BYTES, size - STEWARD_DECISIONS_TAIL_BYTES);
    return { text: buf.toString('utf8', 0, bytesRead), droppedHead: true };
  } catch { return { text: '', droppedHead: false }; }
  finally { if (fh) await fh.close().catch(() => {}); }
}

// { limit, sessionId, since } -> { ok, rows, total, limit }
//   · rows 按时间【倒序】(最近的在最前),这是行动流水页的自然阅读序;
//   · since 认 ISO 时间串(比 seq 稳:seq 是 per-process 计数器,重启即从 1 重来),给了就只回
//     `at > since` 的行;非法值当没给(不是报错 —— 只读面对坏参数一律降级为「不过滤」);
//   · total = 尾窗内命中过滤的总行数(不是全量文件行数,尾窗外的行本来就读不到)。
async function stewardDecisionsRead(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const rawLimit = Number(o.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(STEWARD_DECISIONS_LIMIT_MAX, Math.max(1, Math.round(rawLimit)))
    : STEWARD_DECISIONS_LIMIT_DEFAULT;
  const sessionId = safeSessionId(String(o.sessionId || ''));
  const sinceRaw = String(o.since || '').trim().slice(0, 40);
  const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? sinceRaw : '';
  const { text, droppedHead } = await stewardReadDecisionsText();
  const lines = String(text || '').split('\n');
  const matched = [];
  for (let i = droppedHead ? 1 : 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const row = safeJsonParse(line, null);
    if (!row || typeof row !== 'object' || Array.isArray(row) || !row.tool) continue;  // 坏行整行跳过
    const at = String(row.at || '');
    if (sessionId && String(row.targetSessionId || '') !== sessionId) continue;
    if (since && !(at > since)) continue;
    matched.push({
      seq: Number(row.seq) || 0,
      at,
      tool: String(row.tool || ''),
      args: stewardMaskDecisionArgs((row.args && typeof row.args === 'object') ? row.args : {}),
      targetSessionId: String(row.targetSessionId || ''),
      permissionMode: String(row.permissionMode || ''),
      mayAct: String(row.mayAct || ''),
      undoRef: (row.undoRef && typeof row.undoRef === 'object') ? row.undoRef : null,
      basis: (row.basis && typeof row.basis === 'object') ? stewardMaskDecisionArgs(row.basis) : {},
      ...(row.cost != null ? { cost: Number(row.cost) || 0 } : {}),
    });
  }
  matched.reverse();
  return { ok: true, rows: matched.slice(0, limit), total: matched.length, limit };
}

// ── 管家记忆存储(§4)────────────────────────────────────────────────────────────────────
const stewardMemoryPath = () => path.join(stewardDir(), STEWARD_MEMORY_FILE);
let stewardMemoryChain = Promise.resolve();
function stewardEmptyMemoryStore() { return { schema: STEWARD_MEMORY_SCHEMA, updatedAt: '', entries: [] }; }
function stewardNormalizeMemoryEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  const kind = String(raw.kind || '');
  const text = String(raw.text || '');
  if (!id || !STEWARD_MEMORY_KINDS.includes(kind) || !text) return null;
  const confidence = Number(raw.confidence);
  return {
    id,
    kind,
    text: text.slice(0, STEWARD_MEMORY_LIMITS.textChars),
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.6,
    sourceSessionId: String(raw.sourceSessionId || ''),
    sourceSeq: Math.max(0, Number(raw.sourceSeq) || 0),
    createdAt: String(raw.createdAt || ''),
    updatedAt: String(raw.updatedAt || ''),
    lastUsedAt: String(raw.lastUsedAt || ''),
    useCount: Math.max(0, Number(raw.useCount) || 0),
    state: raw.state === 'vetoed' ? 'vetoed' : 'active',
    // 116-2e(§4 ⑥ 去重合并):被并进本条的来源 ref,最多 5 个(先进先出)。老条目没有这个字段,
    // 读成空数组 —— 存量零迁移。
    mergedFrom: Array.isArray(raw.mergedFrom)
      ? raw.mergedFrom
        .filter(r => r && typeof r === 'object')
        .slice(-STEWARD_MEMORY_MERGED_FROM_MAX)
        .map(r => ({ sessionId: String(r.sessionId || ''), turnSeq: Math.max(0, Number(r.turnSeq) || 0), at: String(r.at || '') }))
      : [],
  };
}
async function stewardReadMemoryStore() {
  let raw = null;
  try { raw = safeJsonParse(await fsp.readFile(stewardMemoryPath(), 'utf8'), null); } catch { raw = null; }
  // 损坏/缺失/错 schema = 空库(不抢救、不 mkdir):记忆是旁路增强,坏了不该拖住任何回合。
  if (!raw || raw.schema !== STEWARD_MEMORY_SCHEMA || !Array.isArray(raw.entries)) return stewardEmptyMemoryStore();
  const entries = [];
  for (const item of raw.entries) {
    const entry = stewardNormalizeMemoryEntry(item);
    if (entry) entries.push(entry);
    if (entries.length >= STEWARD_MEMORY_LIMITS.maxEntries) break;
  }
  return { schema: STEWARD_MEMORY_SCHEMA, updatedAt: String(raw.updatedAt || ''), entries };
}
// 读-改-写全程串在一条 per-process 链上(同 usage/inbox 纪律),两次并发写不会互相盖掉。
function stewardMutateMemory(mutator) {
  const next = stewardMemoryChain.then(async () => {
    const store = await stewardReadMemoryStore();
    const outcome = await mutator(store);
    if (outcome && outcome.persist) {
      store.updatedAt = nowIso();
      await fsp.mkdir(stewardDir(), { recursive: true });
      await atomicWriteJson(stewardMemoryPath(), store);
    }
    return outcome ? outcome.result : null;
  });
  stewardMemoryChain = next.catch(() => {});
  return next;
}

// ── §11.2 深读预算:每回合 ≤6 次、累计字符 ≤ stewardReadBudgetChars ─────────────────────────
// 桶键与 105a observation_recall 同款:会话 id + 回合序号(= providerHistory 里 user 消息条数,回合内
// 稳定、下回合自增,不需要新管线)。每会话保留最近 4 个桶,全局最多 64 个会话,先进先出。
const _stewardReadBudget = new Map(); // sessionId -> Map(turnKey -> { calls, chars })
function stewardReadBucket(sessionId, turnKey) {
  let buckets = _stewardReadBudget.get(sessionId);
  if (!buckets) { buckets = new Map(); _stewardReadBudget.set(sessionId, buckets); }
  while (_stewardReadBudget.size > 64) _stewardReadBudget.delete(_stewardReadBudget.keys().next().value);
  if (!buckets.has(turnKey)) {
    buckets.set(turnKey, { calls: 0, chars: 0 });
    while (buckets.size > 4) buckets.delete(buckets.keys().next().value);
  }
  return buckets.get(turnKey);
}
function stewardTurnKeyOf(ctx) {
  const session = ctx && ctx.session;
  const history = Array.isArray(session && session.providerHistory) ? session.providerHistory : [];
  return history.reduce((n, m) => n + (m && m.role === 'user' ? 1 : 0), 0);
}

// ════════════════════════════════════════════════════════════════════════════
// 观察族(tier read)—— 只读如意自身账面,零副作用,不写任何持久化。
// ════════════════════════════════════════════════════════════════════════════

// 1) steward_self_status —— 复用 108c 的装配函数(12-tool-dispatch 的 buildWorkbenchSelfStatus),
//    再追加一个 steward 段(管家设置掩码 + 收件箱状态)。不新造任何事实源。
const STEWARD_CONFIG_KEYS = Object.freeze([
  'stewardEnabledV1', 'stewardProviderId', 'stewardModel', 'stewardPollMs', 'stewardMaxTurnsPerHour',
  'stewardMaxCostPerDay', 'stewardAutoActions', 'stewardContextBudgetTokens', 'stewardReadBudgetChars',
  'stewardVisitIdleMinutes', 'stewardConversationRetention',
]);
async function stewardImplSelfStatus(args, ctx, config) {
  const wantSteward = !args.section || args.section === 'all' || args.section === 'steward';
  // section:'steward' 只要身份 + 管家段(省上下文);其余 section 原样透传给 108c 的装配函数。
  const base = await buildWorkbenchSelfStatus({ section: args.section === 'steward' ? 'identity' : args.section }, ctx);
  if (!wantSteward) return base;
  const stewardConfig = {};
  // 全部是标量/小对象开关,天生不含 apiKey/token;仍按白名单逐键回显,防将来新增敏感键被顺带带出。
  for (const key of STEWARD_CONFIG_KEYS) stewardConfig[key] = config[key];
  return { ...base, steward: { config: stewardConfig, inbox: await stewardInboxState(config) } };
}

// 2) steward_threads_search —— 113b 的会话内容搜索核心(不走 HTTP)+ 标题词法兜底。
async function stewardImplThreadsSearch(args, ctx, config) {
  const q = String(args.q || '').trim();
  const limit = stewardClampInt(args.limit, 1, STEWARD_SEARCH_LIMIT_MAX, STEWARD_SEARCH_LIMIT_DEFAULT);
  const includeClosed = args.includeClosed === true;   // 116-2e:把已收工的速查线程也算进来
  if (!q) return { ok: true, query: '', results: [], indexed: 0, reason: 'query_empty' };
  const metas = await listSessions().catch(() => []);
  const byId = new Map(metas.map(meta => [meta.id, meta]));

  let ranked = [];        // [{ id, score }]
  let indexed = 0;
  let degraded = '';
  if (sessionSearchIndexEnabled(config)) {
    // 内容索引在:直接用 113b 的核心函数(GET /api/sessions/search 背后那一个)。
    const found = await searchSessionsByContent(q, Math.min(STEWARD_SEARCH_LIMIT_MAX, limit + 10)).catch(() => null);
    if (found && Array.isArray(found.results)) {
      indexed = Number(found.indexed) || 0;
      ranked = found.results.map(row => ({ id: row.id, score: Number(row.score) || 0 }));
    } else degraded = 'search_failed';
  } else degraded = 'index_disabled';
  if (!ranked.length) {
    // 退化词法:只看标题与摘要(不读正文),命中即按更新时间排序 —— 索引关着时仍然能找到线程。
    const needle = q.toLowerCase();
    ranked = metas
      .filter(meta => (String(meta.title || '') + ' ' + String(meta.summary || '')).toLowerCase().includes(needle))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .map(meta => ({ id: meta.id, score: 0 }));
    if (!degraded) degraded = 'lexical_fallback';
  }

  const index = await getPretenderProjectionIndex().catch(() => null);
  const slices = new Map(((index && index.sessions) || []).map(row => [row.sessionId, row]));
  // 116g:同一事项被多条命中线程共用时只读一次事项文件(结果上限 50,不做无界扫描)。
  const missionTitles = new Map();
  const missionTitleOf = async missionId => {
    if (!missionTitles.has(missionId)) {
      const container = await readMissionContainer(missionId).catch(() => null);
      missionTitles.set(missionId, container ? stewardSanitizeText(container.title) : '');
    }
    return missionTitles.get(missionId);
  };
  const results = [];
  for (const row of ranked) {
    if (results.length >= limit) break;
    const head = await stewardReadSessionHead(row.id);
    const rawKind = stewardRawKind(head);
    if (rawKind === 'steward') continue;                       // §11.3:管家自己的会话永不出现在结果里
    // 116-2e(§11.1 第 2 项):已收工的速查线程默认不出现 —— 它答完那一句就没用了,留在结果里
    // 只会挤掉真正的任务线程。includeClosed:true 可以要回来(用户问「刚才那条速查说了啥」)。
    if (!includeClosed && stewardQuickClosed(head)) continue;
    const meta = byId.get(row.id) || {};
    const slice = slices.get(row.id) || null;
    const card = slice ? overlayMissionCard(slice) : null;
    // 116-3 P1-5:兜底判据从「非 mission 即 quick_ask」改成「只有管家自己开的速查线程才是 quick_ask」。
    // sessionKind() 里的 'quick_ask' 是第 70 波遗留的「纯问答默认档」,与 116 波的「速查线程」是两个概念;
    // 混用会把用户正在进行的普通对话打上「速查中」标签喂给管家,让它以为那是「答完即扔」的临时线程。
    const derived = card ? stewardThreadStateFromCard(card) : deriveStewardThreadState({ kind: stewardQuickThread(head) ? 'quick_ask' : 'mission' });
    const missionId = (slice && slice.missionId) || (head && sessionMissionId(head)) || row.id;
    results.push({
      sessionId: row.id,
      missionId,
      // 116g:命中的线程属于哪个【事项】。未归类线程这里是空串(事项标题就是线程标题,不重复说)。
      missionTitle: await missionTitleOf(missionId),
      title: stewardSanitizeText(meta.title || (head && head.title) || ''),
      ...(sessionBriefOf(head) || sessionBriefOf(meta) ? { brief: sessionBriefOf(head) || sessionBriefOf(meta) } : {}),   // 116-5b(§11.8.5):title 仍是原话(管家凭它认出用户当时的说法),名字与概括另给一个键,缺席时不出现;经典壳那一面在 13d 的 searchSessionsByContent
      kind: rawKind,
      state: derived.state,
      stateLabel: derived.label,
      // 诚实:总览与搜索结果里的「最后一句」用会话摘要(= 助手原话经既有收尾裁剪),不做模型改写。
      lastAssistantText: stewardClipSay(meta.summary || (head && head.summary) || ''),
      updatedAt: String(meta.updatedAt || (head && head.updatedAt) || ''),
      score: Number(row.score) || 0,
    });
  }
  return { ok: true, query: q, results, indexed, ...(degraded ? { degraded } : {}) };
}

// 3) steward_thread_status —— 五态优先取投影 card,没有则按 mission-state.js 同一判据在服务端派生。
function stewardPendingOneLine(iv) {
  const type = String((iv && iv.type) || '');
  if (type === 'permission') return `工具 ${stewardSanitizeText(iv.toolName || '?')}(${stewardSanitizeText(iv.tier || 'exec')} 级)等待放行`;
  if (type === 'question') {
    const first = (Array.isArray(iv && iv.questions) ? iv.questions : [])[0];
    return stewardClipSay((first && (first.question || first.title)) || '等待你回答');
  }
  if (type === 'plan') return stewardClipSay(iv.planSummary || '计划等待批准');
  if (type === 'pool') return stewardClipSay(iv.task || '任务池提案等待批准');
  if (type === 'replan') return stewardClipSay(iv.summary || '重规划提案等待批准');
  return stewardClipSay(type || '未知待决');
}
async function stewardImplThreadStatus(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  const rawKind = stewardRawKind(head);
  if (rawKind === 'steward') return stewardFail('not_found', 'the steward session is not a thread');

  const index = await getPretenderProjectionIndex().catch(() => null);
  const slice = ((index && index.sessions) || []).find(row => row.sessionId === sessionId) || null;
  const card = slice ? overlayMissionCard(slice) : null;
  const derived = card
    ? stewardThreadStateFromCard(card)
    : deriveStewardThreadState({
      kind: stewardQuickThread(head) ? 'quick_ask' : 'mission',   // 116-3 P1-5,判据同 threads_search
      autoMode: head.mission && head.mission.autoMode,
      resultStatus: (head.mission && head.mission.result && head.mission.result.status) || '',
      pending: await missionPendingCounts(sessionId, [], null).catch(() => null),
      activeTurn: activeChildren.has(sessionId),
      runCount: 0,
      turnSeq: head.turnSeq,
    });

  const interventions = (await readInterventions(sessionId).catch(() => []))
    .filter(iv => iv && iv.status === 'pending')
    .slice(0, STEWARD_PENDING_SUMMARY_MAX)
    .map(iv => ({ id: String(iv.id), type: String(iv.type || ''), toolName: String(iv.toolName || ''), tier: String(iv.tier || ''), summary: stewardPendingOneLine(iv), interventionVersion: Number(iv.interventionVersion) || 0 }));

  const session = await loadSession(sessionId).catch(() => null);
  const usage = (slice && slice.usage) || null;
  const engine = stewardEngineOf(head);
  const lastRun = card && card.lastRun ? card.lastRun : null;
  // 116g:这条线程属于哪个【事项】,以及那个事项整体是什么状态(由 06i 的 aggregateMissionState 单点
  // 纯函数按全部子线程五态算出;未归类事项 = 只有它自己一条线程,聚合态就等于自己的五态)。
  const missionOfThread = sessionMissionId(head) || sessionId;
  const missionRow = (await buildMissionAggregateRows({ includeArchived: true }).catch(() => null) || { rows: [] })
    .rows.find(row => row.missionId === missionOfThread) || null;
  return {
    ok: true,
    sessionId,
    missionId: sessionMissionId(head),
    mission: {
      missionId: missionOfThread,
      title: stewardSanitizeText(missionRow ? missionRow.title : (head.title || '')),
      aggregateState: missionRow ? missionRow.aggregateState : derived.state,
      threadCount: missionRow ? missionRow.threadCount : 1,
      derived: missionRow ? missionRow.derived : true,
    },
    title: stewardSanitizeText(head.title || ''),
    kind: rawKind,
    state: derived.state,
    stateLabel: derived.label,
    stateSources: derived.sources,
    activeTurn: activeChildren.has(sessionId),
    currentAction: lastRun ? stewardSanitizeText(`班组运行 ${lastRun.id || ''} · ${lastRun.status || ''}`) : (activeChildren.has(sessionId) ? '回合进行中' : ''),
    lastStep: lastRun ? stewardSanitizeText(`${lastRun.nodeCount || 0} 个节点 · eventSeq ${lastRun.eventSeq || 0}`) : '',
    pending: interventions,
    pendingCounts: (card && card.pending) || await missionPendingCounts(sessionId, [], null).catch(() => null),
    // 116h(§3.1 116h 行 / §8.10「排队可解释」):等待原因【单一】,由 06i 的 waitReasonFor 单点判定
    // (等你 > 等锁 > 等预算 > 等并发位)。pending 用五态判据已经算好的那一份,不再数第二遍;
    // 仲裁器一侧是同步只读(开关关时 arbiterWait 恒返回 null,wait 只可能是「等你」或 null)。
    wait: waitReasonFor(
      { pending: (derived.sources && derived.sources.pendingTotal) || 0 },
      typeof StewardHooks.arbiterWait === 'function' ? StewardHooks.arbiterWait(sessionId) : null,
    ),
    // permissionMode 保持既有语义 =【生效】档(既有断言与提示词都读它;断言只加不改)。
    permissionMode: stewardThreadPermissionMode(head, config),
    permissionLabel: stewardPermissionLabel(stewardThreadPermissionMode(head, config)),
    // 116-2a 只加两个字段,把「生效档」与「这条线程自己定的档」显式分开:
    //   effectivePermissionMode —— 与 permissionMode 同值,名字自解释,给 117 的 chip 与管家提示词读;
    //   sessionPermissionMode —— 会话级设置,null = 没定、跟着全局走(chip 的实底/浅底就看它)。
    effectivePermissionMode: stewardThreadPermissionMode(head, config),
    sessionPermissionMode: sessionPermissionModeOf(head),
    engine: engine.engine,
    model: engine.model,
    providerId: engine.providerId || '',
    usage: usage ? { inTok: usage.inTok, outTok: usage.outTok, cachedInTok: usage.cachedInTok, turns: usage.turns, costsByCurrency: usage.costsByCurrency } : null,
    turnSeq: Math.max(0, Number(head.turnSeq) || 0),
    updatedAt: String(head.updatedAt || ''),
    lastAssistantText: stewardClipSay(session ? stewardLastAssistantText(session) : (head.summary || '')),
  };
}

// 4) steward_thread_read —— §11.2 按需层。配额与预算在写任何东西之前先扣;读到的内容【不写入任何
//    持久化】(记忆只记用户本人陈述,深读结果不进记忆,也不落决策日志)。
function stewardToolCallLine(call) {
  const name = stewardSanitizeText((call && call.name) || 'tool');
  let inputHint = '';
  try {
    const raw = JSON.stringify((call && call.input) || {});
    inputHint = stewardSanitizeText(raw).slice(0, 160);
  } catch { inputHint = '{…}'; }
  let resultChars = 0;
  try { resultChars = JSON.stringify((call && call.result) != null ? call.result : '').length; } catch { resultChars = -1; }
  // 工具输出只给长度(与既有 observation reducer 的缩减视图同一诚实口径:不给全文,给可回读的把手)。
  return `[工具] ${name} ${inputHint} → ${resultChars >= 0 ? resultChars + ' 字符' : '不可序列化'}${call && call.id ? ' (id=' + stewardSanitizeText(call.id) + ')' : ''}`;
}
async function stewardImplThreadRead(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const tail = stewardClampInt(args.tail, 1, STEWARD_READ_TAIL_MAX, STEWARD_READ_TAIL_DEFAULT);
  const maxChars = stewardClampInt(args.maxChars, STEWARD_READ_CHARS_MIN, STEWARD_READ_CHARS_MAX, STEWARD_READ_CHARS_DEFAULT);
  const budgetChars = stewardClampInt(config.stewardReadBudgetChars, 4000, 400000, 48000);
  const stewardSessionId = String((ctx.session && ctx.session.id) || 'steward');
  const bucket = stewardReadBucket(stewardSessionId, stewardTurnKeyOf(ctx));
  if (bucket.calls >= STEWARD_READ_CALLS_PER_TURN) {
    return stewardFail('quota_exceeded', `steward_thread_read quota exhausted for this turn (${STEWARD_READ_CALLS_PER_TURN} deep reads); answer from the overview instead of retrying`);
  }
  if (bucket.chars >= budgetChars) {
    return stewardFail('budget_exceeded', `steward read budget exhausted for this visit (${budgetChars} chars, stewardReadBudgetChars); answer from the overview instead of retrying`);
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('not_found', 'the steward session is not a thread');
  const session = await loadSession(sessionId).catch(() => null);
  if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);

  // 消耗一次配额:一旦真的开读就计数(不论最终返回多少字符),否则「读了但没算」就是预算漏洞。
  bucket.calls += 1;

  const messages = Array.isArray(session.messages) ? session.messages : [];
  const turnSeqs = [...new Set(messages.map(m => Number(m && m.turnSeq)).filter(Number.isFinite))].sort((a, b) => a - b);
  const wanted = new Set(turnSeqs.slice(-tail));
  const rows = [];
  for (const m of messages) {
    if (!m) continue;
    const seq = Number(m.turnSeq);
    if (Number.isFinite(seq) && !wanted.has(seq)) continue;
    if (!Number.isFinite(seq) && turnSeqs.length) continue; // 无 turnSeq 的历史消息在有回合号时跳过
    if (m.role === 'user') rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: 'user', text: stewardSanitizeBlock(m.content || '') });
    else if (m.role === 'assistant') {
      rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: 'assistant', text: stewardSanitizeBlock(m.content || '') });
      for (const call of (Array.isArray(m.toolCalls) ? m.toolCalls : [])) {
        rows.push({ turnSeq: Number.isFinite(seq) ? seq : null, role: 'tool', text: stewardToolCallLine(call) });
      }
    }
  }
  // 超出 maxChars 时从【最早】的行开始丢(最近的对话最有用),并如实标 truncated。
  let used = 0, cut = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    used += rows[i].text.length + 16;
    if (used > maxChars) { cut = i + 1; break; }
    cut = i;
  }
  const kept = rows.slice(cut);
  const chars = kept.reduce((n, r) => n + r.text.length, 0);
  bucket.chars += chars;
  return {
    ok: true,
    sessionId,
    tail,
    turnSeqs: [...wanted].sort((a, b) => a - b),
    truncated: cut > 0,
    chars,
    quota: { callsUsed: bucket.calls, callsMax: STEWARD_READ_CALLS_PER_TURN, charsUsed: bucket.chars, charsMax: budgetChars },
    rows: kept,
  };
}

// 5) steward_runs_status —— 复用 08 的 listAgentRuns + 13d 的 missionRunDigest(不另造 digest)。
async function stewardImplRunsStatus(args, ctx, config) {
  const explicit = args.sessionId ? safeSessionId(args.sessionId) : '';
  if (args.sessionId && !explicit) return stewardFail('not_found', 'invalid sessionId');
  let sessionIds = [];
  if (explicit) sessionIds = [explicit];
  else {
    const index = await getPretenderProjectionIndex().catch(() => null);
    sessionIds = ((index && index.sessions) || []).filter(row => row.card).map(row => row.sessionId);
  }
  const runs = [];
  for (const sid of sessionIds) {
    if (runs.length >= STEWARD_RUNS_MAX) break;
    const head = await stewardReadSessionHead(sid);
    if (stewardRawKind(head) === 'steward') continue;
    for (const run of await listAgentRuns(sid).catch(() => [])) {
      if (runs.length >= STEWARD_RUNS_MAX) break;
      const live = activeAgentRuns.get(run.id);
      const mem = live && live.run ? live.run : run;
      const nodes = Array.isArray(mem.nodes) ? mem.nodes : [];
      runs.push({
        sessionId: sid,
        runId: String(run.id || ''),
        status: String(mem.status || ''),
        live: !!live,
        paused: !!(live && live.paused),
        nodes: { total: nodes.length, done: nodes.filter(n => n && n.status === 'done').length, failed: nodes.filter(n => n && n.status === 'failed').length, running: nodes.filter(n => n && (n.status === 'running' || n.status === 'waiting_resource')).length },
        // 等待原因单一化:优先「等你」(池提案待批),其次「等锁」(资源),再次「已暂停」。
        waitReason: (Array.isArray(mem.taskPool) ? mem.taskPool : []).some(p => p && p.status === 'proposed') ? '等你批任务池提案'
          : nodes.some(n => n && n.status === 'waiting_resource') ? '等资源锁'
            : (live && live.paused) ? '已暂停' : '',
        resumeTier: String(mem.resumeTier || ''),
        digest: missionRunDigest(mem, !!live),
      });
    }
  }
  return { ok: true, runs, truncated: runs.length >= STEWARD_RUNS_MAX };
}

// 6) steward_inbox_read —— 直接委托 116b 的原始读取器(同一实现,不复制第二份)。
async function stewardImplInboxRead(args) {
  return { ok: true, ...await stewardInboxRead({ since: args.since, limit: args.limit }) };
}

// 7) steward_usage —— 用量台账按会话/按日汇总;管家自身开销(kind:'aux', note:'steward')单列。
function stewardEmptyUsageBucket() { return { turns: 0, inTok: 0, outTok: 0, cachedInTok: 0, costsByCurrency: {} }; }
function stewardAddUsageRow(bucket, row) {
  bucket.turns += 1;
  bucket.inTok += Number(row.inTok) || 0;
  bucket.outTok += Number(row.outTok) || 0;
  bucket.cachedInTok += Number(row.cachedInTok) || 0;
  const cost = Number(row.cost);
  const currency = typeof row.currency === 'string' ? row.currency : '';
  // costTrusted === false 的行(套餐制的名义金额)不进真实费用合计 —— 与 13e 的 addMissionUsageRow 同口径。
  if (row.costTrusted !== false && currency && Number.isFinite(cost)) {
    bucket.costsByCurrency[currency] = Math.round(((bucket.costsByCurrency[currency] || 0) + cost) * 1e6) / 1e6;
  }
}
async function stewardImplUsage(args) {
  const sessionId = args.sessionId ? safeSessionId(args.sessionId) : '';
  if (args.sessionId && !sessionId) return stewardFail('not_found', 'invalid sessionId');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(args.day || '')) ? String(args.day) : '';
  const rows = await readUsageRows(0).catch(() => []);
  const total = stewardEmptyUsageBucket();
  const steward = stewardEmptyUsageBucket();
  const bySession = new Map();
  const byDay = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if (sessionId && String(row.sessionId || '') !== sessionId) continue;
    const rowDay = usageDayKey(Date.parse(row.ts));
    if (day && rowDay !== day) continue;
    stewardAddUsageRow(total, row);
    if (row.kind === 'aux' && row.note === 'steward') stewardAddUsageRow(steward, row);
    const sid = String(row.sessionId || '');
    if (!bySession.has(sid)) bySession.set(sid, stewardEmptyUsageBucket());
    stewardAddUsageRow(bySession.get(sid), row);
    if (!byDay.has(rowDay)) byDay.set(rowDay, stewardEmptyUsageBucket());
    stewardAddUsageRow(byDay.get(rowDay), row);
  }
  const topSessions = [...bySession.entries()]
    .sort((a, b) => (b[1].inTok + b[1].outTok) - (a[1].inTok + a[1].outTok))
    .slice(0, 20)
    .map(([sid, bucket]) => ({ sessionId: sid, ...bucket }));
  const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-31).map(([d, bucket]) => ({ day: d, ...bucket }));
  return { ok: true, scope: { sessionId: sessionId || '', day: day || '' }, total, steward, bySession: topSessions, byDay: days };
}

// 8) steward_health —— computeHealth 的原始项(人话映射留给前端/管家自己说)。
async function stewardImplHealth(args, ctx, config) {
  const { health } = await computeHealth(config);
  return { ok: true, health: (Array.isArray(health) ? health : []).map(h => ({ id: h.id, ok: h.ok, detail: h.detail })) };
}

// 9) steward_audit_tail —— 既有 collectAudit(内部已过 redact 脱敏),只取 workbench 源(桌面 MCP 审计
//    要起桥,管家的「刚才发生了什么」不该为此拉起一个子进程)。
async function stewardImplAuditTail(args, ctx, config) {
  const limit = stewardClampInt(args.limit, 1, STEWARD_AUDIT_LIMIT_MAX, STEWARD_AUDIT_LIMIT_DEFAULT);
  const audit = await collectAudit(config, { limit, sourceFilter: 'workbench', typeFilter: null });
  return { ok: true, entries: (audit && audit.entries) || [], truncated: !!(audit && audit.truncated) };
}

// ════════════════════════════════════════════════════════════════════════════
// 线程族(tier edit)—— 建线程/递话/改名。全部返回 undoRef 并落决策日志。
// ════════════════════════════════════════════════════════════════════════════

// 后台回合:fire-and-forget(不 await)。管家回合不能被线程回合的时长绑住 —— 它要立刻回一句
// 「已经交给线程 X 去做了」。异常只写 logEvent,绝不冒泡到工具返回值(那会让模型以为没交出去)。
// 116-4(27 号文 §11.7「第四源 sessionTurns」):回合 settle 之后把【身份与成败】落到会话头上。
// 为什么必须落盘:收件箱只读磁盘上的账,而会话头本来没有任何回合成败字段(实测:回合失败后头上只有
// summary 里那句人话,那是渲染不是信号),runSessionTurn 的返回值只活在这一个进程的这一个闭包里。
// 不落盘 = 第四源永远只能报「跑完了」,报不出「挂了」。
//   · launchedBy 在这里补写,是为了覆盖 thread_continue(递话给用户自己的会话,它没经过 createSession)；
//     quick_ask / thread_new 已经在建会话时就地写过了,这里重复写是幂等的。
//   · 成败取【内层】result.result.ok —— 外层 ok 只表示「这次调用完成了」,一条 HTTP 500 的回合外层
//     仍然是 ok:true(116-4 实测),拿外层判会把每一条失败回合都说成收工。
//   · 走 updateSessionMeta 而不是 loadSession+saveSession:settle 那一刻会话可能还在收尾窗口里,
//     这条通道会延后到 settle 之后在【重新装载的副本】上重放,不会用陈旧正文盖掉回合刚写的消息。
//   · 旁路纪律:写失败只是少一条账(第四源退化成报 done),绝不反噬回合本身。
function stewardRecordLaunchOutcome(sessionId, result) {
  const sid = safeSessionId(sessionId);
  if (!sid) return Promise.resolve(null);
  const inner = (result && typeof result === 'object' && result.result && typeof result.result === 'object') ? result.result : null;
  const aborted = !!(inner ? inner.aborted : (result && result.stopped));
  const ok = inner ? inner.ok === true : !!(result && result.ok);
  return updateSessionMeta(sid, {
    launchedBy: 'steward',
    stewardLastTurn: {
      seq: Math.max(0, Number(result && result.turnSeq) || 0),
      ok,
      aborted,
      errorClass: String((inner && inner.errorClass) || ''),
      at: nowIso(),
    },
  }).catch(() => null);
}

function stewardLaunchTurn(input, tool) {
  const promise = runSessionTurn({ ...input, onEvent: () => {} });
  promise.then(result => {
    logEvent({ kind: 'steward_turn_done', tool, sessionId: String(input.sessionId || ''), ok: !!(result && result.ok), stopped: !!(result && result.stopped) });
    void stewardRecordLaunchOutcome(input.sessionId, result);
  }).catch(error => {
    logEvent({ kind: 'steward_turn_error', tool, sessionId: String(input.sessionId || ''), message: String((error && error.message) || error).slice(0, 400) });
    // 回合整个抛出来(不是回合内部失败):同样要留一条落盘的账,否则第四源看见 turnSeq 没动
    // 就什么都不报,管家永远不知道自己派出去的这一趟连回合都没起来。
    void stewardRecordLaunchOutcome(input.sessionId, { result: { ok: false, aborted: false, errorClass: 'launch_error' } });
  });
  return promise;
}

// ── 116-3 P0-2(对抗审查:线程族三工具在三条路径上都没有接入权限门)────────────────────────
// 触发面判定。`ctx.trigger` 由回合运行器的三个执行点显式给:
//   · 模型在结构化回复里声明的 actions —— 透传本回合的 'user' | 'inbox';
//   · 确定性自理(七道闸那条路)—— 恒 'inbox',并另带 ctx.selfServe = true;
//   · 用户在界面上亲手按下按钮的 act 执行路径 —— 恒 'user'。
// 这里用的是 trigger 而【不是】 userPressed:后者的读者按 06i 契约与静态锁只有 config_set /
// skill_toggle 两处(「按钮 ≠ 扩权」),线程族的在不在场判定不该去挤那个字段。
// 其余调用面(工具循环里模型直接调、进程内直调)没有 trigger —— 保持既有直递语义。
function stewardTriggerOf(ctx) {
  const raw = String((ctx && ctx.trigger) || '');
  return raw === 'inbox' || raw === 'user' ? raw : '';
}
// 这一次调用是不是「模型自己在无人值守回合里决定要动别的线程」。
// 三者都不是它:① 用户就在跟前(trigger==='user',含亲手按按钮那条路);② 13h 的【确定性自理】(七道闸,
// ctx.selfServe === true —— 它按事件类别走的是 §3.3 真值表的 'failed' 档,不是 'relay' 档,已经在
// stewardSelfServeGate 里逐条判过了,这里再按 relay 判一次会把「失败自动重试」也一起挡掉);
// ③ 没有 trigger 的调用面(进程内直调/工具循环)—— 保持既有直递语义。
// ctx 由 13h 构造,模型碰不到它;args 里同名字段一概不作数(与 userPressed 同一条纪律)。
function stewardUnattendedByModel(ctx) {
  if (!ctx || ctx.selfServe === true) return false;
  return stewardTriggerOf(ctx) === 'inbox';
}
// 无人值守(inbox)触发时线程族的自理清单闸:relay 没勾选就只提议。
function stewardRelayAutoAllowed(config) {
  const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
  return auto.relay === true;
}

// 10) steward_thread_new —— 委托书。原话逐字在最前,管家补充经中和后进围栏(见 06i buildStewardBrief)。
async function stewardImplThreadNew(args, ctx, config) {
  const brief = (args.brief && typeof args.brief === 'object') ? args.brief : null;
  if (!brief || !String(brief.userText || '').trim()) {
    return stewardFail('invalid_request', 'brief.userText is required and must contain the user\'s own words verbatim');
  }
  // 116-3 P0-2:收件箱触发的「自己新开线程」要用户先在自理清单里留着这一项(§11.1 第 6 项)。
  // 新线程还没有目标线程可判权限,所以这里只有清单这一道闸;新线程自己的权限由全局默认档决定。
  if (stewardUnattendedByModel(ctx)) {
    const auto = (config && config.stewardAutoActions && typeof config.stewardAutoActions === 'object') ? config.stewardAutoActions : {};
    if (auto.newThread === false) {
      return stewardFail('propose_required', '「自己新开线程」已经关掉,无人值守时只能把它作为提议交给用户,不要重试', {
        reason: 'self_serve_off', tool: 'steward_thread_new',
      });
    }
  }
  const composed = buildStewardBrief(brief);
  const requestedMissionId = args.missionId ? safeSessionId(args.missionId) : '';
  if (args.missionId && !requestedMissionId) return stewardFail('invalid_request', 'invalid missionId');

  const session = await createSession({
    title: args.title ? String(args.title).slice(0, STEWARD_TITLE_MAX) : undefined,
    cwd: args.cwd ? String(args.cwd) : undefined,
  });
  session.kind = 'mission';                                   // 线程 = 任务线程(不是速问)
  session.launchedBy = 'steward';                             // 116-4:收件箱第四源的「管家关心」标
  if (requestedMissionId) session.missionId = requestedMissionId; // 归入既有事项;否则 createSession 已置 missionId = 自身 id
  // 委托书落盘:原话与管家补充【分开存】,供 117 显示与用户「改一下」;不把拼好的整段存成一坨。
  session.brief = {
    schema: 1,
    by: 'steward',
    createdAt: nowIso(),
    userText: composed.userText,
    supplement: composed.supplement,
    truncated: composed.truncated,
    memoryIds: composed.memoryIds,
    playbookId: String(brief.playbookId || ''),
  };
  await saveSession(session);
  // 116g:显式指定了事项就写反向索引(事项文件不存在 = 「未归类」,missionIndexAdd 自身 no-op ——
  // 新会话的 missionId === sessionId 那条常规路径永远不会凭空建出一个事项文件)。
  if (requestedMissionId) await missionIndexAdd(requestedMissionId, session.id);

  stewardLaunchTurn({
    sessionId: session.id,
    message: composed.text,
    cwd: session.cwd,
    source: 'steward',
    requestMeta: { tool: 'steward_thread_new' },
  }, 'steward_thread_new');

  // 117d 第 0 步:回退锚点。undoRef.sessionId 是「删掉这条线程」的把手,但整单回退要的是
  // 【被递那一回合将拥有的 seq】—— 与 09-workflow 的 plannedTurnSeq 同口径(session.turnSeq + 1);
  // 新建会话 turnSeq 恒为 0,故委托书是第 1 回合。rewindSession 按这个 seq 定位首条用户消息。
  const undoRef = { kind: 'thread_new', sessionId: session.id, rewindTargetTurnSeq: (Number(session.turnSeq) || 0) + 1 };
  stewardAppendDecision({
    tool: 'steward_thread_new',
    args: { title: session.title, missionId: session.missionId, briefChars: composed.text.length, supplementChars: composed.supplement.length, truncated: composed.truncated },
    targetSessionId: session.id,
    permissionMode: stewardThreadPermissionMode(session, config),
    mayAct: 'auto',
    undoRef,
    basis: { memoryIds: composed.memoryIds },
  });
  return { ok: true, sessionId: session.id, missionId: sessionMissionId(session), title: session.title, briefTruncated: composed.truncated, undoRef };
}

// 11) steward_thread_continue —— 原话直递。undoRef 锚在递话【前】的 turnSeq(rewindSession 的主键)。
async function stewardImplThreadContinue(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const message = String(args.message == null ? '' : args.message);
  if (!message.trim()) return stewardFail('invalid_request', 'message is required');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot be a relay target');
  // 忙锁复用既有活回合判定(activeChildren —— 与 mission 五态的 activeTurn 同一权威信号),不新造锁。
  if (activeChildren.has(sessionId)) return stewardFail('steward.busy', `thread ${sessionId} already has a turn in flight; do not retry — tell the user or wait for it to settle`);

  // 116-3 P0-2:无人值守(收件箱)触发的递话要过两道闸 —— 自理清单勾选 + 目标线程权限档
  // (§3.5 工具面表格:线程族按目标线程权限,「每步都问」「只做计划」一律提议)。判据与
  // stewardImplDecide / stewardImplRunAction 同一写法:先算 mayAct,不是 'auto' 就 propose_required。
  const permissionMode = stewardThreadPermissionMode(head, config);
  let mayAct = 'auto';
  if (stewardUnattendedByModel(ctx)) {
    if (!stewardRelayAutoAllowed(config)) {
      return stewardFail('propose_required', '「事项内自动交接」没有勾选,无人值守时的递话只能作为提议交给用户,不要重试', {
        reason: 'self_serve_off', sessionId, permissionMode,
      });
    }
    mayAct = stewardMayAct(permissionMode, 'relay', 'edit');
    if (mayAct !== 'auto') {
      return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(permissionMode)}」,管家不能在你不在场时直接往它里面递话;把它作为提议交给用户,不要重试`, {
        reason: 'target_permission', sessionId, permissionMode,
      });
    }
  }

  // 递话【前】的 turnSeq:检查点以它为锚。但 rewindSession 的主键【不是】它 —— 它按「要删的那一回合的
  // 第一条用户消息」定位,即 plannedTurnSeq = 递话前 turnSeq + 1(与 09-workflow 同口径)。117d 第 0 步
  // 补出显式字段 rewindTargetTurnSeq;turnSeq 语义保持「递话前」不变(既有消费者逐字节不受影响)。
  const beforeTurnSeq = Math.max(0, Number(head.turnSeq) || 0);
  const undoRef = { kind: 'turn', sessionId, turnSeq: beforeTurnSeq, rewindTargetTurnSeq: beforeTurnSeq + 1 };
  const basis = stewardBasisOf(args);
  stewardLaunchTurn({
    sessionId,
    message,
    source: 'steward',
    requestMeta: { tool: 'steward_thread_continue', ...(basis.origin ? { origin: basis.origin } : {}) },
  }, 'steward_thread_continue');

  stewardAppendDecision({
    tool: 'steward_thread_continue',
    args: { messageChars: message.length },
    targetSessionId: sessionId,
    permissionMode,
    // 116-3 P0-2:写【真实】判定值,不再是硬编码 'auto' —— 决策日志要能事后对账
    // 「这个动作到底是不是该提议而没提议」。
    mayAct,
    undoRef,
    basis,
  });
  return { ok: true, sessionId, undoRef };
}

// 12) steward_thread_rename —— undoRef 带旧标题(一键改回)。
async function stewardImplThreadRename(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const title = String(args.title == null ? '' : args.title).replace(/[\r\n]+/g, ' ').trim().slice(0, STEWARD_TITLE_MAX);
  if (!title) return stewardFail('invalid_request', 'title is required');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot be renamed by a tool');
  // 与 thread_continue 同一条忙锁:改名走 loadSession -> saveSession 的读改写,活回合期间那份内存副本会
  // 在回合的收尾 save 之后落盘,把回合刚写进去的消息用陈旧副本盖掉(会话正文缩水 = 头计数与正文行数错位)。
  // 经典壳的重命名由用户手动触发、撞上的概率低;管家是自动的,必须显式挡住。
  if (activeChildren.has(sessionId)) return stewardFail('steward.busy', `thread ${sessionId} has a turn in flight; rename it after the turn settles`);
  // 116-3 P0-2:改名同样按目标线程权限档判(§3.5 线程族整行都是「按目标线程权限」)。
  // 13h 的 stewardSelfServeAllows 末尾原有的注释说「rename 由 13g 内部的 stewardMayAct 裁决」——
  // 那句话此前是错的(内部根本没有这个裁决),这一行把它补成真的。
  const currentMode = stewardThreadPermissionMode(head, config);
  let renameMayAct = 'auto';
  if (stewardUnattendedByModel(ctx)) {
    renameMayAct = stewardMayAct(currentMode, 'relay', 'edit');
    if (renameMayAct !== 'auto') {
      return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(currentMode)}」,管家不能在你不在场时改它的标题;把它作为提议交给用户,不要重试`, {
        reason: 'target_permission', sessionId, permissionMode: currentMode,
      });
    }
  }
  const previousTitle = String(head.title || '');
  // 复用既有的会话元数据更新原语(PUT /api/sessions/:id 背后那一个),不另开第二条改名写路径。
  const session = await updateSessionMeta(sessionId, { title });
  if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);
  const undoRef = { kind: 'title', sessionId, previousTitle };
  stewardAppendDecision({
    tool: 'steward_thread_rename',
    args: { title, previousTitle },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(session, config),
    mayAct: renameMayAct,   // 116-3 P0-2:真实判定值,不再是常量
    undoRef,
    basis: {},
  });
  return { ok: true, sessionId, title, undoRef };
}

// 12b) steward_thread_permission —— 线程权限【只降不升】(116-2a)。
// 这是永久豁免清单第 2 条(「管家不得自我扩权:放宽任一线程的 permissionMode」)的机器实现:
// 目标档必须严格比【当前生效档】更紧(STEWARD_PERMISSION_RANK 的单调性判定),否则一律
// steward.widen_forbidden —— 放宽只能由用户在界面上改,那条路上还有一道「切到全自动须二次确认」。
// 不加忙锁:116-2a 把 updateSessionMeta 的读改写竞态改成了「活回合期间延后落盘 + 内存覆盖表立刻生效」,
// 收紧对下一回合立即有效且不会盖掉在途回合刚写的消息 —— 这正是收紧最该起效的时刻,拒绝反而危险。
async function stewardImplThreadPermission(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const target = String(args.permissionMode == null ? '' : args.permissionMode);
  if (!PERMISSION_MODES.includes(target)) {
    return stewardFail('invalid_request', `permissionMode must be one of ${PERMISSION_MODES.join('/')}`);
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session has no thread permission');

  const current = stewardThreadPermissionMode(head, config);
  if (!stewardMayTightenTo(current, target)) {
    return stewardFail('steward.widen_forbidden',
      `线程 ${sessionId} 当前权限是「${stewardPermissionLabel(current)}」,管家只能收紧、不能放宽或平移到「${stewardPermissionLabel(target)}」;要放宽请让用户在界面上改`,
      { sessionId, permissionMode: current, requested: target });
  }
  const previous = sessionPermissionModeOf(head); // 会话级旧值(null = 之前跟着全局走)
  const session = await updateSessionMeta(sessionId, { permissionMode: target });
  if (!session) return stewardFail('not_found', `thread ${sessionId} not found`);
  const undoRef = { kind: 'permission', sessionId, previous };
  stewardAppendDecision({
    tool: 'steward_thread_permission',
    args: { permissionMode: target, previous },
    targetSessionId: sessionId,
    permissionMode: target,
    mayAct: 'auto',
    undoRef,
    basis: { previousEffective: current },
  });
  return { ok: true, sessionId, permissionMode: target, effectivePermissionMode: target, previousEffective: current, previous, undoRef };
}

// ════════════════════════════════════════════════════════════════════════════
// 决策族(tier exec)—— 替用户答复待决 / 控制班组。放行范围一律经 stewardMayAct + 永久豁免。
// ════════════════════════════════════════════════════════════════════════════

// 13) steward_decide。判定顺序(顺序即安全):
//     读待决 -> 永久豁免正则 -> stewardMayAct(目标线程权限) -> 才真正 decideIntervention。
//     前两道拦下的一律【不落决策日志】—— 没做决定就没有决定可记(只记「做过什么」,不记「想做什么」)。
async function stewardImplDecide(args, ctx, config) {
  const missionId = safeSessionId(args.missionId);
  const interventionId = String(args.interventionId || '');
  const action = String(args.action || '');
  if (!missionId || !interventionId || !action) return stewardFail('invalid_request', 'missionId, interventionId and action are required');
  const head = await stewardReadSessionHead(missionId);
  if (!head || !head.id) return stewardFail('not_found', 'mission or intervention not found');
  const current = (await readInterventions(missionId).catch(() => [])).find(iv => iv && String(iv.id) === interventionId);
  if (!current) return stewardFail('not_found', 'mission or intervention not found');

  const type = String(current.type || '');
  const toolName = String(current.toolName || '');
  const tier = String(current.tier || '');
  const permissionMode = stewardThreadPermissionMode(head, config);

  // §3.3 永久豁免:命中即降级为提议,任何权限档都不放行 —— 这类动作没有 checkpoint 可回滚。
  // 116-3 P0-1:read/edit 档只看工具名(那两档本来就不碰系统面);其余(exec 与档位缺失)连
  // 命令文本一起看 —— `Bash`/`PowerShell`/`run_command` 这类通用执行工具的名字什么关键词都不含,
  // 只看名字等于对 `rm -rf` / `winget uninstall` / `curl -X POST` / `git push` 完全不设防。
  // 两问分开写(而不是一次带 input 的调用):① 工具名本身就在清单里;② 名字看不出来,但命令文本
  // 命中了那五类动作。分开的好处是信封能说清楚「因为哪一条被降级」,审计与人话都更实在。
  const exemptInput = (tier === 'read' || tier === 'edit') ? null : current.input;
  const exemptByName = stewardToolPermanentlyExempt(toolName);
  const exemptByCommand = !exemptByName && stewardToolPermanentlyExempt(toolName, exemptInput);
  if (type === 'permission' && (exemptByName || exemptByCommand)) {
    const because = exemptByName
      ? `工具 ${stewardSanitizeText(toolName)} 属于永久豁免清单`
      : `工具 ${stewardSanitizeText(toolName)} 这次要执行的命令命中了永久豁免清单`;
    return stewardFail('propose_required', `${because}(不可撤销且外溢的动作),任何权限档都必须由用户亲自决定`, {
      reason: 'permanently_exempt', exemptBy: exemptByName ? 'tool_name' : 'command_text',
      missionId, interventionId, type, toolName, permissionMode,
    });
  }
  const mayAct = stewardMayAct(permissionMode, type === 'permission' ? 'permission' : type, tier);
  if (mayAct !== 'auto') {
    return stewardFail('propose_required', `目标线程的权限档为「${stewardPermissionLabel(permissionMode)}」,这类待决只能由用户决定;把它作为提议交给用户,不要重试`, {
      reason: 'permission_mode', missionId, interventionId, type, toolName, tier, permissionMode,
    });
  }

  const expectedVersion = Number.isInteger(args.expectedVersion) && args.expectedVersion >= 0
    ? args.expectedVersion
    : Math.max(0, Number(current.interventionVersion) || 0);
  const result = await decideIntervention({
    missionId,
    interventionId,
    payload: { action, ...(args.payload && typeof args.payload === 'object' && !Array.isArray(args.payload) ? args.payload : {}) },
    expectedVersion,
    idempotencyKey: makeId('stew'),
    source: 'steward',
    decidedBy: 'steward',
    contractRequest: true,
  });
  const body = (result && result.body) || {};
  // permission 放行后不可撤销(工具已经开跑);其余三类锚回会话 turnSeq(可回退检查点)。
  const undoRef = body.ok === true
    ? (type === 'permission' && action === 'allow'
      ? { kind: 'none', note: '不可撤销' }
      : { kind: 'turn', sessionId: missionId, turnSeq: Math.max(0, Number(head.turnSeq) || 0) })
    : null;
  if (body.ok === true) {
    stewardAppendDecision({
      tool: 'steward_decide',
      args: { type, action, toolName, tier, interventionId, expectedVersion },
      targetSessionId: missionId,
      permissionMode,
      mayAct,
      undoRef,
      basis: { interventionId, interventionVersion: Number(body.interventionVersion) || 0 },
    });
    return { ...body, undoRef };
  }
  // 失败按 decideIntervention 的稳定 reason 原样回传(version_conflict / not_found / already_terminal /
  // delivery_unavailable …)。用 body.reason 而不是 error.code:reason 是命令核心的机器码,
  // error.code 只是它加了 'intervention.' 前缀的 HTTP 变体,工具面统一暴露前者更好分支。
  const failure = (body.error && typeof body.error === 'object') ? body.error : {};
  return stewardFail(String(body.reason || failure.code || 'decision_failed'), String(failure.message || body.message || 'decision could not be delivered'), {
    missionId, interventionId, type, params: failure.params || {}, status: result && result.status,
  });
}

// 14) steward_run_action。口径(§11.3 116c 行):
//     pause / stop —— 收紧类,任何权限档都可做(把事情停下来永远比让它跑下去保守);
//     resume / retry_node —— 失败处置类,按 §3.3 真值表的 'failed' 档口径:「改文件不问」以上可由管家直接做
//     (续跑/重试只是让线程接着走,线程自己的权限门仍会对 exec 逐条问);「每步都问」「只做计划」只提议。
//     116-2b 验收对齐(Fable):原先借 'plan' 档判定把它们限定为「只有全自动」,与 §3.3 自理清单
//     (失败重试/重启续跑对改文件不问生效)及 13h 自理侧预闸口径不一致,两道闸统一为 'failed'。
//     steer_node —— 改变线程要做的事,按 'plan' 档口径只有「全自动」可做。
const STEWARD_RUN_TIGHTENING = Object.freeze(['pause', 'stop']);
const STEWARD_RUN_ADVANCING = Object.freeze(['resume', 'retry_node', 'steer_node']);
const STEWARD_RUN_ACTION_KIND = Object.freeze({ resume: 'failed', retry_node: 'failed', steer_node: 'plan' });
// 116-3 P0-4(对抗审查):续跑的第六道闸(§11.3 116-2b 行「权限面不可证明就不自动」)此前【只】长在
// 13h 的确定性自理路径上 —— 模型在结构化回复里声明 {tool:'steward_run_action', args:{action:'resume'}}
// 的那条路完全绕开它,一个被判为 manual_resume_required(有非纯读节点停在半路 / 权限面变过)的班组
// 会被自动续跑。判据的【唯一权威点】按 §3.3 的既定纪律在 13g 工具内部,故函数搬到这里;13h 的自理
// 预闸仍调它(13h -> 13g 是后向边),两处共用同一份判定,不再各写一份。
// 读不到快照一律按不安全处理('unknown' ≠ 'auto_resumable')。
async function stewardRunResumeTier(sessionId, runId, config) {
  let raw = null;
  try {
    raw = await fsp.readFile(agentRunFile(sessionId, runId), 'utf8');
  } catch (error) {
    // 快照【根本不存在】≠「不敢续跑」:那是「没有这条班组可续」,核心自己会回 run_action_failed,
    // 拿它当危险来挡会把一个 not-found 说成安全问题。其余读失败(权限/IO)一律按不安全处理。
    return (error && error.code === 'ENOENT') ? 'missing' : 'unknown';
  }
  const run = safeJsonParse(raw, null);
  if (!run) return 'unknown';
  return String(classifyRunResumeTier(run, config && config.permissionMode).tier || '');
}
async function stewardImplRunAction(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  const runId = safeSessionId(args.runId);
  const action = String(args.action || '');
  if (!sessionId || !runId) return stewardFail('invalid_request', 'sessionId and runId are required');
  if (!STEWARD_RUN_TIGHTENING.includes(action) && !STEWARD_RUN_ADVANCING.includes(action)) {
    return stewardFail('invalid_request', `unknown action: ${stewardSanitizeText(action)}`);
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session has no agent runs');
  const permissionMode = stewardThreadPermissionMode(head, config);
  const mayAct = STEWARD_RUN_TIGHTENING.includes(action) ? 'auto' : stewardMayAct(permissionMode, STEWARD_RUN_ACTION_KIND[action], 'exec');
  if (mayAct !== 'auto') {
    return stewardFail('propose_required', `「${stewardSanitizeText(action)}」是推进类动作,当前线程权限「${stewardPermissionLabel(permissionMode)}」不允许管家直接执行(续跑/重试需「改文件不问」以上,改指令需「全自动」)——把它作为提议交给用户,不要重试`, {
      reason: 'permission_mode', sessionId, runId, action, permissionMode,
    });
  }
  // 116-3 P0-4:第六道闸。放在 mayAct 之后、真正下发命令之前 —— 权限档允许不代表这条班组
  // 「重启后自动跑起来」是安全的(那是 run 快照自己的分级,与线程权限档正交)。
  if (action === 'resume') {
    const resumeTier = await stewardRunResumeTier(sessionId, runId, config);
    if (resumeTier !== 'auto_resumable' && resumeTier !== 'missing') {
      return stewardFail('propose_required', `这条班组重启后被判为「${stewardSanitizeText(resumeTier || '未知')}」,自动续跑不安全;把它作为提议交给用户按,不要重试`, {
        reason: 'resume_tier', sessionId, runId, action, permissionMode, resumeTier,
      });
    }
  }
  const cmd = await agentRunActionCommand({
    sessionId, runId, action,
    nodeId: args.nodeId,
    text: args.message == null ? '' : String(args.message).slice(0, STEWARD_STEER_TEXT_MAX),
  });
  if (!cmd) return stewardFail('invalid_request', `unsupported action: ${stewardSanitizeText(action)}`);
  const body = cmd.body || {};
  if (body.ok !== true) return stewardFail('run_action_failed', String(body.error || 'agent run action failed'), { sessionId, runId, action, status: cmd.status });
  // pause/stop 可由 resume 撤销;推进类动作没有对称撤销原语,如实标注不可撤销。
  const undoRef = action === 'pause' || action === 'stop'
    ? { kind: 'run_action', sessionId, runId, action: 'resume' }
    : { kind: 'none', note: '不可撤销' };
  stewardAppendDecision({
    tool: 'steward_run_action',
    args: { action, runId, nodeId: String(args.nodeId || '') },
    targetSessionId: sessionId,
    permissionMode,
    mayAct,
    undoRef,
    basis: stewardBasisOf(args, { runId }),
  });
  return { ...body, sessionId, runId, action, undoRef };
}

// 15b) steward_thread_note —— 既有线程的【插话补充】(116-2b,§3.5 委派行末句)。
//
// 为什么是插话而不是递话:§8.12 定的是「既有线程的递话走原话直递,管家如有补充以插话追加,不阻塞
// 线程启动」。递话(thread_continue)会【起一个新回合】,补充却必须落在【正在跑的那个回合】里 ——
// 它是给线程补上下文,不是给它派新活。所以走的是 /api/steer 背后的同一条注入通道(116-2b 把它零行为
// 抽成了 13b 的 steerSessionCore),而不是第二条注入路径:引擎分流(openai 队列 / Claude stdin /
// Kimi ACP 跟随)、队列上限、提问挂起时拒绝、持久呈现进会话正文,一条纪律都不用重写。
//
// 三条自己的收紧:①≤600 字;②尖括号中和(stewardSanitizeText,与总览行同一函数);③服务端加
// 「（管家补充）」前缀 —— 用户在 2.0 视窗里看到的插话必须能一眼分清是谁说的。
// 没有在途回合(或该回合不接受插话)时一律 steward.no_active_turn:模型看到这个信封就该改用
// steward_thread_continue,而不是轮询重试。
async function stewardImplThreadNote(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  const text = stewardSanitizeText(args.text).trim().slice(0, STEWARD_NOTE_TEXT_MAX);
  if (!text) return stewardFail('invalid_request', 'text is required');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('invalid_target', 'the steward session cannot receive a steward note');

  const outcome = await steerSessionCore({ sessionId, text: STEWARD_NOTE_PREFIX + text });
  // 核心的两种"没成"(apiFailure 形态的 400/409 与裸 json 的 {ok:false,error}) 归一成同一个稳定信封:
  // 对模型来说它们是同一件事 —— 现在没法把这句话插进去,别重试。
  if (outcome.kind === 'failure' || !(outcome.body && outcome.body.ok === true)) {
    const detail = String((outcome.kind === 'failure' ? outcome.message : (outcome.body && outcome.body.error)) || '').slice(0, 300);
    return stewardFail('steward.no_active_turn', `thread ${sessionId} cannot take a note right now: ${detail} —— do not retry; use steward_thread_continue to start a new turn instead`, { sessionId });
  }
  const body = outcome.body;
  // 撤回原语是 DELETE /api/steer,它按【文本】在队列里找那一条 —— 所以 undoRef 的真正把手是 text
  // 而不是某个 id(既有插话通道就没有 id 这个东西,编一个出来只会骗人)。
  const undoRef = { kind: 'note', sessionId, text: STEWARD_NOTE_PREFIX + text, queued: Number(body.queued) || 0, injected: body.injected === true };
  stewardAppendDecision({
    tool: 'steward_thread_note',
    args: { textChars: text.length },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'auto',
    undoRef,
    basis: {},
  });
  return { ok: true, sessionId, queued: Number(body.queued) || 0, injected: body.injected === true, undoRef };
}

// ════════════════════════════════════════════════════════════════════════════
// 记忆族(§4)—— 只记「用户本人陈述」。四道闸:来源必须是用户消息 -> 敏感过滤 -> 容量 -> 同义去重。
// ════════════════════════════════════════════════════════════════════════════

// 来源校验:sourceRef 指向的那个回合里必须真有一条【用户】消息。工具输出/助手消息来源确定性拒绝
// (§11.3「工具输出来源确定性拒绝」)—— 否则管家会把自己或工具说的话当成用户的偏好记下来。
async function stewardSourceIsUserMessage(sourceRef) {
  const sessionId = safeSessionId(sourceRef && sourceRef.sessionId);
  if (!sessionId) return false;
  const turnSeq = Number(sourceRef && sourceRef.turnSeq);
  if (!Number.isFinite(turnSeq)) return false;
  const session = await loadSession(sessionId).catch(() => null);
  if (!session) return false;
  const messages = Array.isArray(session.messages) ? session.messages : [];
  // 116f 第二道:role:'user' 还不够 —— 管家的【收件箱回合】也是以一条 user 消息注入的(工作台把
  // 几十条系统事件归成一段文本发给模型),但那不是用户本人说的话。13h 在那条消息上落了
  // meta.origin === 'inbox'(随会话正文持久化,重启后仍在),这里确定性拒绝它。同理拒绝
  // 驱动器自动续跑的消息(source:'mission-driver')—— 也不是人说的。
  return messages.some(m => m && m.role === 'user' && Number(m.turnSeq) === turnSeq
    && !(m.meta && typeof m.meta === 'object' && m.meta.origin === 'inbox')
    && m.source !== 'mission-driver');
}

// 15) steward_memory_write
async function stewardImplMemoryWrite(args, ctx, config) {
  const kind = String(args.kind || '');
  if (!STEWARD_MEMORY_KINDS.includes(kind)) return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
  const text = stewardSanitizeText(args.text).trim();
  if (!text) return stewardFail('invalid_request', 'text is required');
  if (text.length > STEWARD_MEMORY_LIMITS.textChars) {
    return stewardFail('invalid_request', `text must be at most ${STEWARD_MEMORY_LIMITS.textChars} characters`);
  }
  const sourceRef = (args.sourceRef && typeof args.sourceRef === 'object') ? args.sourceRef : null;
  if (!sourceRef) return stewardFail('invalid_request', 'sourceRef {sessionId, turnSeq} is required');
  if (!await stewardSourceIsUserMessage(sourceRef)) {
    return stewardFail('source_not_user', 'sourceRef must point at a turn that contains the user\'s own message; tool output and assistant text are not valid memory sources');
  }
  // 敏感过滤复用工作台记忆的同一条正则(密钥/口令/JWT/连接串),不另写第二套判据。
  if (memoryProposalLooksSensitive({ body: text })) {
    return stewardFail('sensitive_rejected', 'the text looks like a credential/secret and will never be stored in steward memory');
  }

  const terms = stewardMemoryTerms(text);
  return stewardMutateMemory(async store => {
    // 被否决过的同义内容拒绝写回(§4 第 ⑤ 条:vetoed 之后同义不再自动写回)。
    const vetoed = store.entries.find(e => e.state === 'vetoed' && stewardTermJaccard(terms, e.text) >= STEWARD_MEMORY_LIMITS.dedupeJaccard);
    if (vetoed) {
      return { persist: false, result: stewardFail('vetoed_duplicate', `a synonymous memory was vetoed by the user (${vetoed.id}); do not write it back`, { id: vetoed.id }) };
    }
    const existing = store.entries.find(e => e.state === 'active' && e.kind === kind && stewardTermJaccard(terms, e.text) >= STEWARD_MEMORY_LIMITS.dedupeJaccard);
    const at = nowIso();
    if (existing) {
      // 116-2e(§4 ⑥):合并【不新增条目】—— 保留旧 id(引用它的决策日志与提示词行不失效),
      // text 取新(用户最近一次的说法更准),confidence 取两者较大再 +0.1 封顶 1(同一件事被说了
      // 第二遍,置信度只该升不该降),来源 ref 进 mergedFrom(最多 5 个,先进先出)。
      const incomingConfidence = Number.isFinite(Number(args.confidence)) ? Math.min(1, Math.max(0, Number(args.confidence))) : 0.6;
      const prevRef = { sessionId: existing.sourceSessionId, turnSeq: existing.sourceSeq, at: existing.updatedAt || existing.createdAt };
      existing.text = text;
      existing.confidence = Math.min(1, Math.max(existing.confidence, incomingConfidence) + 0.1);
      existing.mergedFrom = [...(Array.isArray(existing.mergedFrom) ? existing.mergedFrom : []), prevRef].slice(-STEWARD_MEMORY_MERGED_FROM_MAX);
      existing.sourceSessionId = String(sourceRef.sessionId || '');
      existing.sourceSeq = Math.max(0, Number(sourceRef.turnSeq) || 0);
      existing.updatedAt = at;
      const undoRef = { kind: 'memory', id: existing.id, prev: null };
      stewardAppendDecision({ tool: 'steward_memory_write', args: { kind, chars: text.length, merged: true }, targetSessionId: String(sourceRef.sessionId || ''), permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [existing.id] } });
      return { persist: true, result: { ok: true, id: existing.id, merged: true, undoRef } };
    }
    const activeCount = store.entries.filter(e => e.state === 'active').length;
    if (activeCount >= STEWARD_MEMORY_LIMITS.maxEntries) {
      return { persist: false, result: stewardFail('capacity_exceeded', `steward memory is full (${STEWARD_MEMORY_LIMITS.maxEntries} active entries); veto something before writing more`) };
    }
    const entry = {
      id: makeId('smem'),
      kind,
      text,
      confidence: Number.isFinite(Number(args.confidence)) ? Math.min(1, Math.max(0, Number(args.confidence))) : 0.6,
      sourceSessionId: String(sourceRef.sessionId || ''),
      sourceSeq: Math.max(0, Number(sourceRef.turnSeq) || 0),
      createdAt: at,
      updatedAt: at,
      lastUsedAt: '',
      useCount: 0,
      state: 'active',
      mergedFrom: [],
    };
    store.entries.push(entry);
    const undoRef = { kind: 'memory', id: entry.id, prev: null };
    stewardAppendDecision({ tool: 'steward_memory_write', args: { kind, chars: text.length, merged: false }, targetSessionId: entry.sourceSessionId, permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [entry.id] } });
    return { persist: true, result: { ok: true, id: entry.id, merged: false, undoRef } };
  });
}

// 16) steward_memory_veto
async function stewardImplMemoryVeto(args) {
  const id = String(args.id || '');
  if (!id) return stewardFail('invalid_request', 'id is required');
  return stewardMutateMemory(async store => {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
    const prev = entry.state;
    entry.state = 'vetoed';
    entry.updatedAt = nowIso();
    const undoRef = { kind: 'memory', id, prev };
    stewardAppendDecision({ tool: 'steward_memory_veto', args: { id }, targetSessionId: entry.sourceSessionId, permissionMode: '', mayAct: 'auto', undoRef, basis: { memoryIds: [id] } });
    return { persist: true, result: { ok: true, id, state: 'vetoed', undoRef } };
  });
}

// 17) steward_memory_search —— 词法匹配(词项 Jaccard + 子串命中),默认排除 vetoed。
async function stewardImplMemorySearch(args) {
  const q = String(args.q || '').trim();
  const kind = STEWARD_MEMORY_KINDS.includes(String(args.kind || '')) ? String(args.kind) : '';
  const limit = stewardClampInt(args.limit, 1, STEWARD_MEMORY_LIMITS.searchLimit, 20);
  const includeVetoed = args.includeVetoed === true;
  const store = await stewardReadMemoryStore();
  const terms = q ? stewardMemoryTerms(q) : null;
  const needle = q.toLowerCase();
  const rows = store.entries
    .filter(e => (includeVetoed || e.state === 'active') && (!kind || e.kind === kind))
    .map(e => ({
      entry: e,
      score: terms ? Math.max(stewardTermJaccard(terms, e.text), e.text.toLowerCase().includes(needle) ? 0.9 : 0) : 0,
    }))
    .filter(row => !terms || row.score > 0)
    .sort((a, b) => b.score - a.score || String(b.entry.updatedAt).localeCompare(String(a.entry.updatedAt)))
    .slice(0, limit)
    .map(row => ({ ...row.entry, score: Number(row.score.toFixed(4)) }));
  return { ok: true, query: q, kind: kind || '', total: store.entries.length, entries: rows };
}

// 20) steward_missions —— 事项级只读视图(116g / §3.1 / §8.10)。
// 纪律:装配全部委托 13d 的 buildMissionAggregateRows(与看板 GET /api/missions 逐字节同源),
// 事项级状态只经 06i 的 aggregateMissionState 纯函数 —— 本文件【不】自己判定任何状态。
async function stewardImplMissions(args, ctx, config) {
  const includeArchived = !!(args && args.includeArchived === true);
  const aggregate = await buildMissionAggregateRows({ includeArchived }).catch(() => ({ rows: [] }));
  const missions = aggregate.rows.map(row => {
    const mission = {
      missionId: row.missionId,
      title: stewardSanitizeText(row.title),
      goal: stewardSanitizeText(row.goal).slice(0, 400),
      aggregateState: row.aggregateState,
      aggregateStateLabel: stewardStateLabel(row.aggregateState),
      acceptance: {
        done: row.acceptance.done,
        total: row.acceptance.total,
        items: row.acceptance.items.map(item => ({ id: item.id, text: stewardSanitizeText(item.text), done: item.done === true })),
      },
      budget: row.budget,
      cost: row.cost,
      derived: row.derived,
      threads: row.threads.map(thread => ({
        sessionId: thread.sessionId,
        title: thread.title,
        state: thread.state,
        stateLabel: thread.stateLabel,
        permissionMode: thread.permissionMode,
        lastAssistantText: thread.lastAssistantText,   // 13d 已按 §11.2 截到 120 字
        ...(thread.brief ? { brief: thread.brief } : {}),   // 116-5b:同 threads_search —— title 仍是原话,brief 多给的
        wait: thread.wait || null,                     // 116h:等待原因原样透传(13d 已经过 waitReasonFor)
      })),
    };
    if (row.archivedAt) mission.archivedAt = row.archivedAt;
    return mission;
  });
  return { ok: true, missions, count: missions.length };
}

// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116-2e —— 记忆面板(§4「面板」)、如意设置三级分级(§3.5)、内容管理(§3.5)、
// 速查线程(§11.1 第 2 项)。
// ════════════════════════════════════════════════════════════════════════════

// ── 记忆面板(六条 token 级路由的域实现;不是工具,模型碰不到)─────────────────────────────
// 「新」标 isNew 是【纯派生】:createdAt 距今 < 24 小时。不落任何新字段 —— 否则 24 小时后还得有人
// 回来把它擦掉,而那个「有人」在真实系统里从来不存在。
function stewardMemoryPanelRow(entry, now) {
  const createdMs = Date.parse(String(entry.createdAt || ''));
  return {
    ...entry,
    isNew: Number.isFinite(createdMs) && (now - createdMs) < STEWARD_MEMORY_NEW_WINDOW_MS,
  };
}

async function stewardMemoryPanelList(kindArg) {
  const kind = String(kindArg || '');
  if (kind && !STEWARD_MEMORY_KINDS.includes(kind)) {
    return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
  }
  const store = await stewardReadMemoryStore();
  const now = Date.now();
  const groups = {};
  for (const k of STEWARD_MEMORY_KINDS) if (!kind || k === kind) groups[k] = [];
  let total = 0, active = 0, vetoed = 0, isNewCount = 0;
  for (const entry of store.entries) {
    total += 1;
    if (entry.state === 'vetoed') vetoed += 1; else active += 1;
    if (kind && entry.kind !== kind) continue;
    if (!Object.prototype.hasOwnProperty.call(groups, entry.kind)) continue;
    const row = stewardMemoryPanelRow(entry, now);
    if (row.isNew) isNewCount += 1;
    groups[entry.kind].push(row);
  }
  for (const k of Object.keys(groups)) {
    groups[k].sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  }
  return { ok: true, kind: kind || '', groups, counts: { total, active, vetoed, isNew: isNewCount }, updatedAt: store.updatedAt };
}

// 面板改的条目:置信度拉满(用户亲手写的比管家推断的准),来源标 user_panel。version 是乐观锁 ——
// 传 updatedAt 原值,与库里对不上就 version_conflict(面板开着的时候管家可能刚合并过同一条)。
async function stewardMemoryPanelEdit(body) {
  const id = String((body && body.id) || '');
  if (!id) return stewardFail('invalid_request', 'id is required');
  const text = stewardSanitizeText(body && body.text).trim();
  if (!text) return stewardFail('invalid_request', 'text is required');
  if (text.length > STEWARD_MEMORY_LIMITS.textChars) {
    return stewardFail('invalid_request', `text must be at most ${STEWARD_MEMORY_LIMITS.textChars} characters`);
  }
  const kind = body && body.kind ? String(body.kind) : '';
  if (kind && !STEWARD_MEMORY_KINDS.includes(kind)) {
    return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
  }
  // 用户亲手写的也过敏感过滤:面板不是绕过密钥拒收的后门。
  if (memoryProposalLooksSensitive({ body: text })) {
    return stewardFail('sensitive_rejected', 'the text looks like a credential/secret and will never be stored in steward memory');
  }
  const version = body && body.version != null ? String(body.version) : '';
  return stewardMutateMemory(async store => {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
    if (version && String(entry.updatedAt || '') !== version) {
      return { persist: false, result: stewardFail('version_conflict', 'this entry changed since you loaded it; reload the panel and edit again', { version: entry.updatedAt }) };
    }
    entry.text = text;
    if (kind) entry.kind = kind;
    entry.confidence = 1;
    entry.sourceSessionId = 'user_panel';
    entry.sourceSeq = 0;
    entry.updatedAt = nowIso();
    stewardAppendDecision({ tool: 'steward_memory_panel_edit', args: { id, chars: text.length, kind: entry.kind }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: { kind: 'memory', id, prev: null }, basis: { memoryIds: [id] } });
    return { persist: true, result: { ok: true, entry: stewardMemoryPanelRow(entry, Date.now()) } };
  });
}

async function stewardMemoryPanelRestore(idArg) {
  const id = String(idArg || '');
  if (!id) return stewardFail('invalid_request', 'id is required');
  return stewardMutateMemory(async store => {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return { persist: false, result: stewardFail('not_found', `memory ${stewardSanitizeText(id)} not found`) };
    if (entry.state === 'active') return { persist: false, result: { ok: true, id, state: 'active', restored: false } };
    entry.state = 'active';
    entry.updatedAt = nowIso();
    stewardAppendDecision({ tool: 'steward_memory_panel_restore', args: { id }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: { kind: 'memory', id, prev: 'vetoed' }, basis: { memoryIds: [id] } });
    return { persist: true, result: { ok: true, id, state: 'active', restored: true } };
  });
}

// 清空:confirm 必须【逐字】等于 'clear'(同 DELETE /api/skills 的「输入 id 才解锁」摩擦)。
async function stewardMemoryPanelClear(confirm) {
  if (String(confirm) !== 'clear') return stewardFail('invalid_request', "confirm must be exactly 'clear'");
  return stewardMutateMemory(async store => {
    const removed = store.entries.length;
    store.entries = [];
    stewardAppendDecision({ tool: 'steward_memory_panel_clear', args: { removed }, targetSessionId: '', permissionMode: '', mayAct: 'user', undoRef: null, basis: {} });
    return { persist: true, result: { ok: true, removed } };
  });
}

// 导出:只含 active,字段就是条目本身那几个(不含 isNew 这类派生视图字段,也不含任何别处的东西)。
async function stewardMemoryPanelExport() {
  const store = await stewardReadMemoryStore();
  return {
    ok: true,
    schema: STEWARD_MEMORY_SCHEMA,
    exportedAt: nowIso(),
    entries: store.entries.filter(e => e.state === 'active'),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 设置族(tier exec)—— §3.5「如意设置」行的三级分级。判据唯一来源是 06i 的 stewardConfigTierFor。
// ════════════════════════════════════════════════════════════════════════════

// 22) steward_config_get —— 掩码复用 POST /api/config 回包用的同一个 maskProviders(不另写一套)。
//     forbidden 级的键【连掩码值都不回】,只在 omitted[] 里列键名 —— 给出掩码值等于承认它存在
//     并暗示它的形状,而 forbidden 的意思是「这一族根本不经管家」。
async function stewardImplConfigGet(args, ctx, config) {
  const masked = maskProviders(config);
  const requested = Array.isArray(args.keys)
    ? args.keys.map(k => String(k || '').trim()).filter(Boolean).slice(0, 64)
    : Object.keys(masked);
  const values = {};
  const tiers = {};
  const omitted = [];
  for (const key of requested) {
    const tier = stewardConfigTierFor(key);
    if (tier === 'forbidden') { omitted.push(key); continue; }
    if (!Object.prototype.hasOwnProperty.call(masked, key)) { omitted.push(key); continue; }
    values[key] = masked[key];
    tiers[key] = tier;
  }
  return { ok: true, values, tiers, omitted };
}

// 23) steward_config_set —— 整份原子:任一键 forbidden 就整份拒绝(零写入),任一键 confirm 且用户
//     没亲手按就整份 propose_required。不做「能写的写、不能写的跳过」—— 半份生效的配置是最难解释
//     的那种状态,用户按下按钮时看到的也必须是他刚才看到的那一整份。
async function stewardImplConfigSet(args, ctx, config) {
  const rawPatch = (args.patch && typeof args.patch === 'object' && !Array.isArray(args.patch)) ? args.patch : null;
  if (!rawPatch) return stewardFail('invalid_request', 'patch must be an object of {key: value}');
  const patch = { ...rawPatch };   // 本地副本:下面要往里塞一个请求级信号(confirm),不该改模型给的对象
  const keys = Object.keys(patch);
  if (!keys.length) return stewardFail('invalid_request', 'patch is empty');
  if (keys.length > 32) return stewardFail('invalid_request', 'patch carries too many keys (max 32)');

  const forbidden = keys.filter(k => stewardConfigTierFor(k) === 'forbidden');
  if (forbidden.length) {
    return stewardFail('steward.forbidden', `these keys can never be changed through the steward: ${forbidden.join(', ')}`, { keys: forbidden });
  }
  // 116-3 P2-12(§8.6):把全局默认权限切到「全自动」是一条【专门】要求二次确认的动作,不是任意
  // confirm 键共用的通用按钮语义。判定与错误口径与 13d 的线程级 PATCH、13 的 applyConfigPatch 共用
  // 同一张 PERMISSION_MODES_REQUIRING_CONFIRM 与同一个 `permission.confirm_required` 码。
  // 外层信封仍是 propose_required —— 13h 只对这个码做「降级成一个按钮」,换成别的码用户就再也
  // 按不到那个按钮了;专门口径放在 reason 与人话里(界面按 reason 取 §8.6 那五条文案)。
  // 只读一次 ctx.userPressed:06i 的契约与 steward-tools.static ⑦ 把「13g 里读它的地方」钉成两处
  //(config_set / skill_toggle 各一处),下面两道门共用这一个局部量。
  const pressed = ctx.userPressed === true;
  if (Object.prototype.hasOwnProperty.call(patch, 'permissionMode') && !pressed) {
    const requested = patch.permissionMode == null ? '' : String(patch.permissionMode);
    if (PERMISSION_MODES_REQUIRING_CONFIRM.includes(requested)) {
      return stewardFail('propose_required',
        `把【新线程的默认权限】切到「${stewardPermissionLabel(requested)}」要你亲手确认:那之后线程可以在你不在的时候改文件、跑命令、装东西、联网发东西。把它作为提议交给用户按,不要重试`,
        { reason: 'permission.confirm_required', keys: ['permissionMode'], permissionMode: requested });
    }
  }
  const confirmKeys = keys.filter(k => stewardConfigTierFor(k) === 'confirm');
  if (confirmKeys.length && !pressed) {
    // 13h 既有的降级路径会把 propose_required 变成一个按钮;用户按下那个按钮走 POST /api/steward/act,
    // 只有那条路径会置 ctx.userPressed = true(06i 的契约注释里写死了唯一来源)。
    return stewardFail('propose_required', `changing ${confirmKeys.join(', ')} needs the user to press the button`, { reason: 'confirm_required', keys: confirmKeys });
  }

  // 校验整份 patch 走【与 POST /api/config 同一条】normalize/sanitize:先合进当前配置跑一遍
  // normalizeConfig,再逐键比对 —— 被 sanitize 清洗掉(非法值静默回落)的键当场拒绝,而不是写进去
  // 之后让用户在设置页里发现「我改的没生效」。
  const probe = normalizeConfig({ ...config, ...patch }).config;
  const rejected = keys.filter(k => JSON.stringify(probe[k]) !== JSON.stringify(patch[k]));
  if (rejected.length) {
    return stewardFail('invalid_request', `these values did not survive config sanitize (illegal value or out of range): ${rejected.join(', ')}`, { keys: rejected });
  }

  const before = {};
  for (const key of keys) before[key] = config[key];
  // 落盘走与 POST /api/config 同一个 applyConfigPatch:116h 的 arbiterRefresh、CLI settings 同步、
  // MCP 同步全在那条路径上,管家另开一条就会静默漏掉它们。
  // 116-3 B1:applyConfigPatch 顶部新加了「切全局默认权限到全自动须 confirm:true」的服务端门。
  // 走到这一行时 confirm 档的判定已经过了(permissionMode 本来就在 STEWARD_CONFIG_TIER_CONFIRM 里,
  // 所以想改它必须 ctx.userPressed === true = 用户在界面上亲手按下了那个按钮),这个事实如实带过去。
  // 它是请求级信号不是配置键:applyConfigPatch 判完就把它剥掉,绝不会进 config.json;放在
  // keys/probe/before 三处算完【之后】才塞,免得它被当成一个待写的配置键。
  patch.confirm = true;
  const next = await applyConfigPatch(patch);
  const applied = {};
  for (const key of keys) applied[key] = next[key];
  // undoRef 内联在决策日志行里({kind:'config', before:{key:oldValue}}),不新增任何持久化面。
  const undoRef = { kind: 'config', before };
  stewardAppendDecision({
    tool: 'steward_config_set',
    args: { keys, confirmed: confirmKeys.length > 0 },
    targetSessionId: '',
    permissionMode: '',
    mayAct: confirmKeys.length ? 'user' : 'auto',
    undoRef,
    basis: stewardBasisOf(args),
  });
  return { ok: true, applied, tiers: Object.fromEntries(keys.map(k => [k, stewardConfigTierFor(k)])), undoRef };
}

// ════════════════════════════════════════════════════════════════════════════
// 内容管理族 —— §3.5「内容管理」行。playbook 只起草不保存;技能启停须确认;速查线程自己收工。
// ════════════════════════════════════════════════════════════════════════════

// 每回合配额桶:复用 116c 的 stewardReadBucket 形状(会话 id + 回合序号),但各族一张自己的表 ——
// 深读预算与起草/速查次数是三件不同的事,合在一个桶里会互相饿死。
const _stewardTurnQuota = new Map(); // bucket -> Map(`${sessionId} ${turnKey}` -> count)
function stewardTurnQuotaTake(bucket, ctx, max) {
  const key = String(ctx && ctx.sessionId ? ctx.sessionId : '') + ' ' + stewardTurnKeyOf(ctx);
  let table = _stewardTurnQuota.get(bucket);
  if (!table) { table = new Map(); _stewardTurnQuota.set(bucket, table); }
  const used = Number(table.get(key)) || 0;
  if (used >= max) return false;
  table.set(key, used + 1);
  while (table.size > 64) table.delete(table.keys().next().value);
  return true;
}

// 22) steward_playbook_draft —— 只返回草稿,【不保存】。保存走既有 UI(POST /api/playbooks,117 接)。
//     每回合 1 次:draftPlaybookFromSession 自己要调一次模型,管家一个回合里连起五个草稿是纯烧钱。
async function stewardImplPlaybookDraft(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  // 同 skill_toggle:身份判定排在装载之前(见那边的原注释)。
  if (sessionId === STEWARD_SESSION_ID) return stewardFail('steward.forbidden', 'the steward session cannot be turned into a playbook');
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') return stewardFail('steward.forbidden', 'the steward session cannot be turned into a playbook');
  if (!stewardTurnQuotaTake('playbook_draft', ctx, STEWARD_PLAYBOOK_DRAFTS_PER_TURN)) {
    return stewardFail('quota_exceeded', `at most ${STEWARD_PLAYBOOK_DRAFTS_PER_TURN} playbook draft per steward turn; do not retry - tell the user what you have`);
  }
  const draft = await draftPlaybookFromSession(sessionId);
  if (!draft || draft.ok === false) {
    return stewardFail('draft_failed', String((draft && draft.error) || 'the engine could not draft a playbook from this thread'));
  }
  return { ok: true, sessionId, draft: draft.playbook || draft.draft || null, saveVia: 'POST /api/playbooks' };
}

// 23) steward_skill_toggle —— 与 POST /api/session/skills 共用 setSessionSkillsCore(同一段校验/去重/
//     截 8/来源锁定/活动回合同步)。须确认:改了技能就等于改了那条线程下一回合的工具面与提示词。
async function stewardImplSkillToggle(args, ctx, config) {
  const sessionId = safeSessionId(args.sessionId);
  if (!sessionId) return stewardFail('not_found', 'invalid sessionId');
  // 管家不能对自己用:管家提示词包本来就不含技能索引(§3.5「管家动如意、线程动世界」)。这一条排在
  // 会话装载【之前】—— 目标是管家自己时,答案是「这件事不该做」,不该因为管家会话恰好还没建出来
  // 就退化成「找不到」(两个信封说的是完全不同的两件事)。
  if (sessionId === STEWARD_SESSION_ID) {
    return stewardFail('steward.forbidden', 'the steward session has no skills to toggle');
  }
  const head = await stewardReadSessionHead(sessionId);
  if (!head || !head.id) return stewardFail('not_found', `thread ${sessionId} not found`);
  if (stewardRawKind(head) === 'steward') {
    return stewardFail('steward.forbidden', 'the steward session has no skills to toggle');
  }
  if (!Array.isArray(args.skills)) return stewardFail('invalid_request', 'skills must be an array of skill ids');
  if (ctx.userPressed !== true) {
    return stewardFail('propose_required', 'changing the enabled skills of a thread needs the user to press the button',
      { reason: 'confirm_required', sessionId, skills: args.skills.map(x => String((x && x.id) || x || '')).slice(0, 8) });
  }
  const result = await setSessionSkillsCore(sessionId, args.skills);
  if (!result.ok) return stewardFail('not_found', String(result.error || 'session not found'));
  stewardAppendDecision({
    tool: 'steward_skill_toggle',
    args: { skills: result.skills.map(s => s.id) },
    targetSessionId: sessionId,
    permissionMode: stewardThreadPermissionMode(head, config),
    mayAct: 'user',
    undoRef: { kind: 'skills', sessionId, before: Array.isArray(head.skills) ? head.skills.map(s => (s && s.id) || '') : [] },
    basis: stewardBasisOf(args),
  });
  return { ok: true, sessionId, skills: result.skills };
}

// 24) steward_quick_ask —— 速查线程(§11.1 第 2 项)。
//     何时用:要读文件、联网或动手才能答的问题。何时别用:关于如意、事项、费用、设置的问题 —— 那些
//     管家自己就知道,开一条线程去问等于让用户白等一次回合。
//     不进任何事项;权限用新线程默认权限(即全局 permissionMode),照常受 116h 仲裁;答完自动收工。
async function stewardImplQuickAsk(args, ctx, config) {
  const question = stewardSanitizeText(args.question).trim();
  if (!question) return stewardFail('invalid_request', 'question is required');
  if (question.length > STEWARD_QUICK_QUESTION_CHARS) {
    return stewardFail('invalid_request', `question must be at most ${STEWARD_QUICK_QUESTION_CHARS} characters`);
  }
  if (!stewardTurnQuotaTake('quick_ask', ctx, STEWARD_QUICK_ASKS_PER_TURN)) {
    return stewardFail('quota_exceeded', `at most ${STEWARD_QUICK_ASKS_PER_TURN} quick-ask threads per steward turn; do not retry - answer with what you already know or tell the user`);
  }
  const session = await createSession({
    title: question.slice(0, STEWARD_TITLE_MAX),
    cwd: args.cwd ? String(args.cwd) : undefined,
  });
  session.kind = STEWARD_QUICK_KIND;
  // 116-5a:速查线程建出来时 title 是【问题原话的前 N 个字】,那不是「人给的名字」而恰恰是本波要
  // 替换掉的东西。createSession 会因为它非占位而标上 titleSource:'user',这里清掉 —— 否则这条线程
  // 永远拿不到自动摘要。thread_new 那边不清:args.title 是管家【有意】起的名字,与改名同一性质。
  delete session.titleSource;
  // 116-4:管家关心的会话的三个机器痕迹之一(另两个是 stewardQuick、线程在别人的事项里)。
  // 在这里就地写进内存副本,跟着下面那次 saveSession 一起落盘 —— 零额外写。
  session.launchedBy = 'steward';
  // 速查线程【不进事项】:missionId 指回自己(createSession 的缺省),不写任何反向索引,
  // GET /api/missions 里它就是一条「未归类」的派生行,不占任何事项的验收与预算。
  session.stewardQuick = {
    schema: 1,
    askedAt: nowIso(),
    question,
    stewardTurnKey: String(stewardTurnKeyOf(ctx)),
    closedAt: null,
  };
  await saveSession(session);

  stewardLaunchTurn({
    sessionId: session.id,
    message: question,
    cwd: session.cwd,
    source: 'steward',
    requestMeta: { tool: 'steward_quick_ask' },
  }, 'steward_quick_ask');

  // 117e 第 0 步:与 117d-0 的 thread_new / thread_continue 同口径 —— 撤回锚点显式化。
  // rewindSession 按「要删的那一回合的第一条用户消息」定位(09 的 plannedTurnSeq = turnSeq + 1),
  // 按 `turnSeq` 字面传会得 target turn not found。新建会话的 turnSeq 恒为 0,这里仍按字段读,
  // 与上面那两处逐字同形(将来 createSession 若带出非零 seq 也不会错)。
  const undoRef = { kind: 'thread_new', sessionId: session.id, rewindTargetTurnSeq: (Number(session.turnSeq) || 0) + 1 };
  stewardAppendDecision({
    tool: 'steward_quick_ask',
    args: { chars: question.length },
    targetSessionId: session.id,
    permissionMode: stewardThreadPermissionMode(session, config),
    mayAct: 'auto',
    undoRef,
    basis: stewardBasisOf(args),
  });
  return { ok: true, sessionId: session.id, kind: STEWARD_QUICK_KIND, question, undoRef };
}

// ── 速查会话的收件箱增强(13i 每轮落盘前调,经 StewardHooks 延迟绑定)────────────────────────
// 给速查会话的 `done` 行补 `quick:true` 与 `answer`(最后一句助手原话,≤1200 字符)。
// 为什么在这里而不是在 13i:13i 只认三条 seq 日志,不读会话正文;而「最后一句助手原话」要装载会话。
// 放在 13g 并经命名空间回调,13i 就不需要认识 13g 的任何符号(前向边红线)。
// 旁路纪律:抛错绝不反噬轮询器 —— 13i 那边整段包在 try 里,补不上就是少两个字段。
async function stewardEnrichInboxRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const heads = new Map();
  for (const row of list) {
    if (!row || row.kind !== 'done') continue;
    const sid = safeSessionId(row.sessionId);
    if (!sid) continue;
    if (!heads.has(sid)) heads.set(sid, await stewardReadSessionHead(sid).catch(() => null));
    const head = heads.get(sid);
    if (!head || stewardRawKind(head) !== STEWARD_QUICK_KIND || !head.stewardQuick) continue;
    const session = await loadSession(sid).catch(() => null);
    const answer = stewardSanitizeText(stewardLastAssistantText(session)).slice(0, STEWARD_QUICK_ANSWER_CHARS);
    row.payload = { ...(row.payload && typeof row.payload === 'object' ? row.payload : {}), quick: true, answer };
  }
  return list;
}

// 收工:回合结束后由 13h 调 —— 把 stewardQuick.closedAt 落在会话头上。收工后这条线程从管家的总览
// 与 steward_threads_search 里消失(经典壳照常看得见,它只是数据)。幂等:已收工的再调是无操作。
async function stewardQuickClose(sessionId) {
  const sid = safeSessionId(sessionId);
  if (!sid) return { ok: false, error: 'invalid_request' };
  const head = await stewardReadSessionHead(sid);
  if (!head || stewardRawKind(head) !== STEWARD_QUICK_KIND || !head.stewardQuick) return { ok: false, error: 'not_found' };
  // 116-3 P1-6:判「还算不算收工」走 stewardQuickClosed(它会把「收工后用户又聊了」算成重开),
  // 而不是只看 closedAt 是不是真值 —— 否则一条被用户重新用起来的速查线程再次收工时会被当成幂等
  // 直接返回,closedTurnSeq 永远停在第一次收工那一刻,它就再也关不上了。
  if (stewardQuickClosed(head)) return { ok: true, sessionId: sid, closedAt: head.stewardQuick.closedAt, changed: false };
  const closedAt = nowIso();
  // 收工时记下【当时的回合数】。之后会话每多一个用户回合,turnSeq 就会超过它 = 用户在继续用这条线程。
  const closedTurnSeq = Math.max(0, Number(head.turnSeq) || 0);
  await updateSessionMeta(sid, { stewardQuick: { ...head.stewardQuick, closedAt, closedTurnSeq } });
  return { ok: true, sessionId: sid, closedAt, closedTurnSeq, changed: true };
}

// 已收工的速查会话:总览与线程搜索默认把它排除(includeClosed 可要回来)。判据单点在这里,
// 13g 的 threads_search 与 13h 的 stewardThreadDigestRows 都调它。
//
// 116-3 P1-6:closedAt 【不是】终态。用户完全可能在经典 2.0 视窗里把这条速查线程继续聊下去
// (§11.1 第 2 项只说「答完即收工」,没说「从此不许再用」);修前 closedAt 一旦写入就永久生效,
// 管家的总览与线程搜索从此把它当成历史,彻底跟丢用户的后续对话。判据用 turnSeq 而不是 updatedAt:
// updateSessionMeta 自己就会推 updatedAt,拿它比会在收工的下一刻把线程又「重开」一次。
function stewardQuickClosed(head) {
  const quick = head && head.stewardQuick;
  if (!quick || typeof quick !== 'object' || !quick.closedAt) return false;
  const closedTurnSeq = Number(quick.closedTurnSeq);
  if (!Number.isFinite(closedTurnSeq)) return true;   // 116-3 之前落盘的旧速查线程:没有这个字段,维持原语义
  return Math.max(0, Number(head && head.turnSeq) || 0) <= closedTurnSeq;
}

// 116-3 P1-5:「这条线程是不是管家自己开的速查线程」的唯一判据。
// 【不能】拿 sessionKind() / head.kind === 'quick_ask' 当判据 —— 那是第 70 波遗留的「纯问答默认档」,
// 用户自己发起的普通对话绝大多数都落在它上面;真正的速查线程由 steward_quick_ask 创建,
// 头上带 stewardQuick 这个字段,那才是 116 波「速查线程」这个概念的机器痕迹。
function stewardQuickThread(head) {
  const quick = head && head.stewardQuick;
  return !!(quick && typeof quick === 'object');
}

// 延迟绑定(先例 06c AgentLoopHooks):06i 声明空命名空间,本文件在加载时填充实现。
// 消费者(13-http-router 的路由链、13-http-router 的关服收尾、116c 的管家工具 handler)全程只看
// StewardHooks.*,从不直接依赖 13g —— 这就是「不新增前向边」的落地方式。
Object.assign(StewardHooks, {
  handleApiRoutes: handleStewardApiRoutes,
  stopInbox: stopStewardInbox,
  inboxRead: stewardInboxRead,
  inboxState: stewardInboxState,
  // 116c: 17 个管家工具的实现键(116-2a 增第 18 个 threadPermission;116-2b 增第 19 个 threadNote;
  // 116g 增第 20 个 missions)。每个都经 stewardToolHandler
  // 包一层门控壳(开关 -> 身份 -> 实现),
  // 12-tool-dispatch 的 handler 只写一行 `StewardHooks.<键>(args, ctx)`。键名与 06i 的契约注释逐条对应。
  selfStatus: stewardToolHandler('steward_self_status', stewardImplSelfStatus),
  threadsSearch: stewardToolHandler('steward_threads_search', stewardImplThreadsSearch),
  threadStatus: stewardToolHandler('steward_thread_status', stewardImplThreadStatus),
  threadRead: stewardToolHandler('steward_thread_read', stewardImplThreadRead),
  runsStatus: stewardToolHandler('steward_runs_status', stewardImplRunsStatus),
  inboxReadTool: stewardToolHandler('steward_inbox_read', stewardImplInboxRead),
  usage: stewardToolHandler('steward_usage', stewardImplUsage),
  health: stewardToolHandler('steward_health', stewardImplHealth),
  auditTail: stewardToolHandler('steward_audit_tail', stewardImplAuditTail),
  missions: stewardToolHandler('steward_missions', stewardImplMissions), // 116g
  threadNew: stewardToolHandler('steward_thread_new', stewardImplThreadNew),
  threadContinue: stewardToolHandler('steward_thread_continue', stewardImplThreadContinue),
  threadRename: stewardToolHandler('steward_thread_rename', stewardImplThreadRename),
  threadPermission: stewardToolHandler('steward_thread_permission', stewardImplThreadPermission), // 116-2a
  threadNote: stewardToolHandler('steward_thread_note', stewardImplThreadNote), // 116-2b
  decide: stewardToolHandler('steward_decide', stewardImplDecide),
  runAction: stewardToolHandler('steward_run_action', stewardImplRunAction),
  memoryWrite: stewardToolHandler('steward_memory_write', stewardImplMemoryWrite),
  memoryVeto: stewardToolHandler('steward_memory_veto', stewardImplMemoryVeto),
  memorySearch: stewardToolHandler('steward_memory_search', stewardImplMemorySearch),
  // 116-2e:设置族两个 + 内容管理三个(工具数 84 -> 89),外加两个基础设施键(收件箱行增强与速查收工,
  // 消费者分别是 13i 的轮询器与 13h 的回合收尾 —— 它们都只看 StewardHooks,不认识 13g)。
  configGet: stewardToolHandler('steward_config_get', stewardImplConfigGet),
  configSet: stewardToolHandler('steward_config_set', stewardImplConfigSet),
  playbookDraft: stewardToolHandler('steward_playbook_draft', stewardImplPlaybookDraft),
  skillToggle: stewardToolHandler('steward_skill_toggle', stewardImplSkillToggle),
  quickAsk: stewardToolHandler('steward_quick_ask', stewardImplQuickAsk),
  enrichInboxRows: stewardEnrichInboxRows,
  quickClose: stewardQuickClose,
  quickClosed: stewardQuickClosed,
});
