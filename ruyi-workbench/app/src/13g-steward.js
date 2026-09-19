// ============================================================================
// 第 116 波 116c(27 号文 §3.5「管家工具面设计」/ §4「管家记忆层」):管家(Steward)域路由、
// 记忆面板、管家工具的门控壳与 StewardHooks 注册表。
//
// 落点(transport 层,manifest 中位于 13l-steward-ops.js 之后、13h-steward-runner.js 之前)。
// 116-2e 拆分:收件箱轮询与游标(原本是本文件的前半)整体前移到 `13i-steward-inbox.js`,零行为搬家;
//   本文件引用它的符号(stewardDir / stewardInboxRead / stewardInboxState / startStewardInbox …)
//   全部是后向边。理由见 13i 的文件头。
// 第 117 波 T1 拆分(32 号文 §2.1):本文件曾 2088 行(`steward-runner.static` ①「≤2000 行」长期红),
//   工具实现与共享原语整体前移到三个新文件,同样是零行为搬家 ——
//   `13j-steward-tool-base.js`(共享常量、稳定信封、决策日志、记忆存储、深读预算、配额桶)、
//   `13k-steward-threads.js`(线程族:派活原语与 thread_* / quick_ask / threads_search)、
//   `13l-steward-ops.js`(观察族 / 决策族 / 记忆族 / 设置族 / 内容管理族)。
//   三者都排在本文件【之前】:注册表要引用它们的 stewardImpl*,排在后面才是后向边。
//   本文件留下的是:管家域路由 + 记忆面板六条 + 工具门控壳 + StewardHooks 注册表。
//
// 依赖纪律(§11.3「不得新增前向边」):
//   · 13g 只引用拼接顺序在它之前的模块符号(00/01/01b/02/06d/06i/13i/13j/13k/13l …),全部后向边;
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
    const focus = String(query.get('focus') || '').slice(0, 80);   // 128h-J03:可缺;合法性由钩子那一侧(13o)的 safeSessionId 判,不合法当没给
    const startedAt = Date.now();
    const result = typeof StewardHooks.preroute === 'function'
      ? await StewardHooks.preroute(q, config, { focus })
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

// ════════════════════════════════════════════════════════════════════════════
// 第 116 波 116-2e —— 记忆面板(§4「面板」)、如意设置三级分级(§3.5)、内容管理(§3.5)、
// 速查线程(§11.1 第 2 项)。
// ════════════════════════════════════════════════════════════════════════════

// ── 记忆面板(六条 token 级路由的域实现;不是工具,模型碰不到)─────────────────────────────
// 「新」标 isNew 是【纯派生】:createdAt 距今 < 24 小时。不落任何新字段 —— 否则 24 小时后还得有人
// 回来把它擦掉,而那个「有人」在真实系统里从来不存在。
function stewardMemoryPanelRow(entry, now, panelConfig) {
  const createdMs = Date.parse(String(entry.createdAt || ''));
  return {
    ...entry,
    isNew: Number.isFinite(createdMs) && (now - createdMs) < STEWARD_MEMORY_NEW_WINDOW_MS,
    // 126-M02:面板【照常列出】过期条目,只是带上标记 —— 时效是过滤不是删除(44 号文 §6 ②)。
    // 判据仍然只有一处:06d 的 memoryIsExpired,本文件不自己解析日期。
    expired: memoryIsExpired(entry, now),
    // 126-M01:作用域的人话标签(纯派生;scope 本身随 ...entry 已经带出)。
    scopeLabel: stewardMemoryScopeLabel(entry.scope, panelConfig).replace(/^,/, ''),
  };
}

async function stewardMemoryPanelList(kindArg) {
  const kind = String(kindArg || '');
  if (kind && !STEWARD_MEMORY_KINDS.includes(kind)) {
    return stewardFail('invalid_request', `kind must be one of ${STEWARD_MEMORY_KINDS.join('/')}`);
  }
  const store = await stewardReadMemoryStore();
  // 126-M01:作用域标签要认工作区表。面板是冷路径,读一次配置不心疼。
  const panelConfig = await readConfig().catch(() => ({}));
  const now = Date.now();
  const groups = {};
  for (const k of STEWARD_MEMORY_KINDS) if (!kind || k === kind) groups[k] = [];
  let total = 0, active = 0, vetoed = 0, isNewCount = 0;
  for (const entry of store.entries) {
    total += 1;
    if (entry.state === 'vetoed') vetoed += 1; else active += 1;
    if (kind && entry.kind !== kind) continue;
    if (!Object.prototype.hasOwnProperty.call(groups, entry.kind)) continue;
    const row = stewardMemoryPanelRow(entry, now, panelConfig);
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
    return { persist: true, result: { ok: true, entry: stewardMemoryPanelRow(entry, Date.now(), await readConfig().catch(() => ({}))) } };
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
