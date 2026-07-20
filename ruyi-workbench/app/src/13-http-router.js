async function handleApi(req, res, pathname) {
  // --- auth gate ---
  // The MCP child authenticates /api/permission/request with its own body token (checked there).
  // Every other state-changing route must be same-origin (blocks browser CSRF). The tool-exec and
  // config routes additionally require the injected UI token (blocks other local processes).
  // 第33波:声明式 auth 路由表 deny-by-default(替换原 needsToken/uiMutatingRoute/uiReadRoute 三条 OR 链)。
  // authorizeRoute 按 ROUTE_AUTH 表 first-match 判定 open/origin/token/token-browser/body-token;未匹配 -> 拒(403)。
  // 14 处 handler 内 tokenOk 自查保留作纵深;Host 门在 HTTP handler 顶层 hostAllowed(全请求含 GET 与 serveStatic)。
  const authErr = authorizeRoute(req, req.method, pathname);
  if (authErr) {
    const code = authErr === 'missing or invalid workbench token' ? 'auth.token_invalid'
      : authErr === 'cross-origin request rejected' ? 'auth.origin_rejected' : 'auth.denied';
    return send(res, apiFailure(code, {}, authErr, 403));
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const config = await readConfig();
    const { health, manifest } = await computeHealth(config);
    return send(res, json({
      ok: true,
      app: APP_NAME,
      version: VERSION,
      configSchema: CONFIG_SCHEMA, // v0.8-S0: surfaced top-level so clients/tests don't dig into config
      overlayId: OVERLAY_ID,
      launchMode: LAUNCH_MODE,
      dataRoot: paths.data,
      exePath: exePath(),
      // v1.0-S9 exe 改名 Ruyi.exe;双名兼容探测——先探新名,再探旧名(兼容窗口:存量安装/旧 launcher,建议 v2.0 收口)。
      exePresent: fs.existsSync(path.join(externalRoot(), 'Ruyi.exe')) || fs.existsSync(path.join(externalRoot(), 'WinClaudeWorkbench.exe')),
      isPkg: isPkg(),
      config: maskProviders(config), // F2: never emit plaintext provider api keys in the response

      permissionModes: PERMISSION_MODES,
      // v1.0.2-S2: 当前激活 provider+model 的上下文窗口解析结果(附加字段, 只增)。无激活原生 provider
      // (即 claude-cli 路径)时 source 为 'fallback' 且 provider/model 为空 —— 前端可据此决定是否展示。
      contextWindowResolved: (() => {
        const p = activeOpenAiProvider(config);
        const model = p ? String(p.model || (p.models && p.models[0] && p.models[0].id) || '').trim() : '';
        const r = resolveContextWindow(p, model);
        return { value: r.value, source: r.source, provider: p ? p.id : '', model };
      })(),
      models: offlineModelList(config), // instant offline list; UI enriches via GET /api/models (proxy)
      providerPresets: PROVIDER_PRESETS, // v0.5: built-in OpenAI-compatible provider templates (DeepSeek/DashScope/custom)
      claudeEndpointPresets: CLAUDE_ENDPOINT_PRESETS, // v1.4.4: third-party Anthropic-compatible endpoint templates for the Claude CLI engine (Ark Coding Plan/custom)
      detectedClaudePath: detectClaudePath(),
      mcpConfigPath: await generateMcpConfig(config.mcpCommandMode),
      // v0.7d: desktop MCP discovery status for the settings UI. `detected` is the autodetect result
      // (null when not found); `resolved` is what would actually be launched (honors explicit overrides).
      desktopMcp: (() => {
        const enabled = !!(config.desktopMcp && config.desktopMcp.enabled);
        const detected = detectDesktopMcp();
        const resolved = resolveExternalMcpServers(config).find(s => s.id === 'ai-computer-control') || null;
        return {
          enabled,
          detected: detected ? { command: detected.command, args: detected.args, via: detected.via, pythonSource: detected.pythonSource || '' } : null,
          resolved: resolved ? { command: resolved.command, args: resolved.args, cwd: resolved.cwd || '', pythonSource: resolved.pythonSource || '' } : null,
        };
      })(),
      health,
      manifest,
      // v0.8-S1: vendored-binary capability probe (additive). S6's capability matrix will formally own
      // this; the `rg` field is established here so file_search's fast-path status is observable now.
      binaries: { rg: hasRg() },
      // v0.9-S1 (C6): expose the ERROR_CLASSES table top-level so the error-humanization UI renders zh/next
      // from the single server-side source of truth (result.errorClass keys into this) — no double-maintain.
      errorClasses: ERROR_CLASSES,
      tools: MCP_TOOLS.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    }));
  }
  // v0.8-S6: capability matrix (§7.2). Read-only → same-origin gate is enough (not in needsToken). 60s
  // internal cache; ?force=1 busts it (used by the UI popover for an on-open refresh). Never throws.
  if (req.method === 'GET' && pathname === '/api/capabilities') {
    const config = await readConfig();
    const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
    const caps = await getCapabilities(config, force).catch(() => null);
    if (!caps) return send(res, json({ ok: false, error: 'capability probe failed' }, 500));
    return send(res, json({ ok: true, ...caps }));
  }
  // ── v0.9-S2 Playbooks (§7.8 / §4 C2) ──────────────────────────────────────────────────────────────
  // GET: 内置 ∪ 用户 playbook,每项经能力矩阵评 available + unavailableReason(read-only, same-origin only).
  if (req.method === 'GET' && pathname === '/api/playbooks') {
    const config = await readConfig();
    const playbooks = await listPlaybooksWithAvailability(config);
    return send(res, json({ ok: true, playbooks }));
  }
  // POST /api/playbooks/draft {sessionId} — 让当前引擎从会话起草一个 playbook 草稿(token-gated above).
  // Must come BEFORE the generic POST /api/playbooks handler so the /draft suffix isn't swallowed.
  if (req.method === 'POST' && pathname === '/api/playbooks/draft') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body && body.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    return send(res, json(await draftPlaybookFromSession(sessionId)));
  }
  // POST /api/playbooks — save a user playbook (normalized; token-gated). Body = the playbook object.
  if (req.method === 'POST' && pathname === '/api/playbooks') {
    const body = await readJsonBody(req);
    const pb = normalizePlaybook(body && body.playbook ? body.playbook : body);
    if (!pb) return send(res, json({ ok: false, error: '无效的 playbook(缺 id/title/promptTemplate)' }, 400));
    const saved = await saveUserPlaybook(pb);
    return send(res, json({ ok: true, playbook: saved }));
  }
  // DELETE user playbook via POST /api/playbooks/<id> + x-http-method:DELETE (sessions convention).
  // Built-in ids (no user override file) → 403. A user override CAN be deleted (reverts to built-in).
  if (pathname.startsWith('/api/playbooks/') && (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))) {
    const id = path.basename(pathname); // guards traversal
    const r = await deleteUserPlaybook(id);
    if (r.ok) return send(res, json(r));
    return send(res, json(r, r.builtin ? 403 : 404));
  }
  // ── v0.9-S3 (C3) Workspace-by-fingerprint + native folder picker ────────────────────────────────────
  // POST /api/workspace/resolve {name, children[]} — locate the dropped folder's real absolute path by
  // fingerprint (basename + first-level child names). Token-gated (whitelisted above). Never throws.
  if (req.method === 'POST' && pathname === '/api/workspace/resolve') {
    const body = await readJsonBody(req);
    const config = await readConfig();
    try {
      const r = await resolveWorkspace({ name: body && body.name, children: body && body.children }, config);
      return send(res, json(r));
    } catch (e) {
      return send(res, json({ ok: false, error: String(e && e.message || e), matches: [] }));
    }
  }
  // POST /api/pick-folder — pop the native Windows folder picker (STA WinForms). Token-gated. 120s.
  if (req.method === 'POST' && pathname === '/api/pick-folder') {
    return send(res, json(await pickFolder()));
  }
  if (req.method === 'GET' && pathname === '/api/models') {
    // Live-enriched model list. For an active native provider: its models ∪ live GET /models.
    // Otherwise the Claude path: proxy ∪ offline. Read-only, best-effort; never throws.
    const config = await readConfig();
    const provider = activeOpenAiProvider(config);
    if (provider) {
      const live = await fetchOpenAiModels(provider).catch(() => ({ models: [] }));
      const seen = new Map();
      // v1.0.2-S2: 每个模型对象带 contextLength(有则带)。探测(live)条目自带; 无探测时回退探测缓存;
      // 已有条目在 live 补到 contextLength 时就地补齐(only-add, 不改既有字段语义)。
      const add = (id, label, contextLength) => {
        const k = String(id || ''); if (!k) return;
        const cl = (Number.isFinite(contextLength) && contextLength > 0) ? Math.round(contextLength) : cachedContextLength(provider.id, k);
        if (!seen.has(k)) { const o = { id: k, label: label || k }; if (cl) o.contextLength = cl; seen.set(k, o); }
        else if (cl && !seen.get(k).contextLength) seen.get(k).contextLength = cl;
      };
      for (const m of (provider.models || [])) add(m.id, m.label, m.contextLength);
      for (const m of (live.models || [])) add(m.id, m.label, m.contextLength);
      return send(res, json({ ok: true, engine: 'openai', provider: provider.id, models: [...seen.values()], proxyCount: (live.models || []).length }));
    }
    return send(res, json({ ok: true, engine: 'claude', ...(await discoverModels(config)) }));
  }
  if (req.method === 'POST' && pathname === '/api/config') {
    const body = await readJsonBody(req);
    const current = await readConfig();
    const merged = { ...current, ...body };
    // F2 (安全·防掩码覆盖): if the payload carries providers[] or searchBackend, any apiKey still the mask
    // (`••••…`) means the UI round-tripped the masked value from GET /api/status — restore the real key
    // from the same-id provider (or on-disk searchBackend) before persisting, so a save never wipes the
    // stored key. unmaskSecrets covers BOTH secret sites in one pass (v0.9-S9).
    if ((body && Array.isArray(body.providers)) || (body && body.searchBackend && typeof body.searchBackend === 'object')) {
      const restored = unmaskSecrets(body, current);
      if (Array.isArray(body.providers)) merged.providers = restored.providers;
      if (body.searchBackend && typeof body.searchBackend === 'object') merged.searchBackend = restored.searchBackend;
    }
    // Remember an explicitly-chosen model so it persists in the list even if the proxy later drops it.
    if (body && typeof body.model === 'string' && body.model && !(merged.knownModels || []).includes(body.model)) {
      merged.knownModels = [...(merged.knownModels || []), body.model];
    }
    const next = await writeConfig(merged);
    // v1.4.3: keep ~/.claude/ in sync — settings.json + agent roles + MCP servers
    if (body && (Object.prototype.hasOwnProperty.call(body, 'permissionMode') || Object.prototype.hasOwnProperty.call(body, 'model') || Object.prototype.hasOwnProperty.call(body, 'thinkingBudget') || Object.prototype.hasOwnProperty.call(body, 'appendSystemPrompt'))) {
      await syncClaudeCliSettings(next);
    }
    if (body && (Object.prototype.hasOwnProperty.call(body, 'agentRoleOverrides') || Object.prototype.hasOwnProperty.call(body, 'permissionMode'))) {
      await syncAgentRolesToClaude(next.defaultWorkspace || os.homedir(), next);
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'externalMcpServers')) {
      await syncMcpServersToClaude(next);
    }
    return send(res, json({ ok: true, config: maskProviders(next) })); // F2: masked response
  }
  if (req.method === 'GET' && pathname === '/api/agent-roles') {
    const config = await readConfig();
    const u = new URL(req.url, 'http://x');
    const cwd = normalizeCwd(u.searchParams.get('cwd') || config.defaultWorkspace, config.defaultWorkspace);
    const roles = await getAgentRoleLibrary(cwd, config);
    const builtinRoles = BUILTIN_AGENT_ROLES.map(r => normalizeAgentRole(r, { source: 'builtin', builtin: true }));
    const globalRoles = (config.agentRoleOverrides || []).map(r => normalizeAgentRole(r, { source: 'global' })).filter(Boolean);
    const projectRoles = await readProjectAgentRoles(cwd);
    const nativeClaudeRoles = await readClaudeProjectAgentRoles(cwd);
    const claudeDefs = await buildClaudeAgentDefinitions(cwd, config);
    const mcpServers = [{ id: 'win-claude-workbench', label: 'Ruyi Workbench' }, ...resolveExternalMcpServers(config).map(s => ({ id: s.id, label: s.label || s.id }))];
    return send(res, json({ ok: true, cwd, roles, builtinRoles, globalRoles, projectRoles, nativeClaudeRoles, mcpServers, drivers: { openai: { mode: 'workbench-native' }, claude: { mode: 'claude-native', flag: '--agents', synced: Object.keys(claudeDefs.definitions), omitted: claudeDefs.omitted } } }));
  }
  if (req.method === 'POST' && pathname === '/api/agent-roles') {
    const body = await readJsonBody(req);
    const scope = body && body.scope === 'project' ? 'project' : 'global';
    const roles = (Array.isArray(body && body.roles) ? body.roles : []).map(r => normalizeAgentRole(r, { source: scope })).filter(Boolean).slice(0, 32);
    if (scope === 'project') {
      const cwdRaw = String(body && body.cwd || '');
      if (!cwdRaw || !path.isAbsolute(cwdRaw)) return send(res, json({ ok: false, error: 'project scope requires an absolute cwd' }, 400));
      const saved = await saveProjectAgentRoles(path.resolve(cwdRaw), roles);
      return send(res, json({ ok: true, scope, roles: saved, file: projectAgentRoleFile(cwdRaw) }));
    }
    const config = await readConfig(); config.agentRoleOverrides = roles;
    const next = await writeConfig(config);
    return send(res, json({ ok: true, scope, roles: next.agentRoleOverrides }));
  }
  if (req.method === 'GET' && pathname === '/api/agent-workflows') {
    const config = await readConfig(); const u = new URL(req.url, 'http://x');
    const cwd = normalizeCwd(u.searchParams.get('cwd') || config.defaultWorkspace, config.defaultWorkspace);
    return send(res, json({ ok: true, cwd, workflows: await getAgentWorkflows(cwd) }));
  }
  if (req.method === 'POST' && pathname === '/api/agent-workflows') {
    const body = await readJsonBody(req); const scope = body && body.scope === 'project' ? 'project' : 'personal';
    const config = await readConfig(); const cwd = normalizeCwd(body && body.cwd || config.defaultWorkspace, config.defaultWorkspace);
    const workflow = await saveAgentWorkflow(scope, cwd, body && body.workflow);
    if (!workflow) return send(res, json({ ok: false, error: '无效工作流：需要唯一 id、标题和合法 DAG 节点' }, 400));
    return send(res, json({ ok: true, scope, workflow }));
  }
  if (pathname.startsWith('/api/agent-workflows/') && (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))) {
    const id = String(pathname.slice('/api/agent-workflows/'.length)).toLowerCase(); const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const config = await readConfig(); const scope = body && body.scope === 'project' ? 'project' : 'personal'; const cwd = normalizeCwd(body && body.cwd || config.defaultWorkspace, config.defaultWorkspace);
    return send(res, json({ ok: await deleteAgentWorkflow(scope, cwd, id), id, scope }));
  }
  if (req.method === 'POST' && pathname === '/api/provider/test') {
    // Test a provider's base URL + key by listing its models. Body: { provider } (saved or draft) or a bare provider.
    const body = await readJsonBody(req);
    let rawProvider = (body && body.provider) || body;
    // F2 (安全): the UI may send back a masked apiKey (`••••…`) from GET /api/status — restore the real
    // key from the same-id provider in config before firing the test, else the test would use the mask.
    if (rawProvider && typeof rawProvider === 'object' && typeof rawProvider.apiKey === 'string' && rawProvider.apiKey.startsWith(KEY_MASK_PREFIX)) {
      const cfg = await readConfig();
      const prev = (Array.isArray(cfg.providers) ? cfg.providers : []).find(p => String(p && p.id || '') === String(rawProvider.id || ''));
      rawProvider = { ...rawProvider, apiKey: (prev && typeof prev.apiKey === 'string') ? prev.apiKey : '' };
    }
    const sp = sanitizeProvider(rawProvider);
    if (!sp) return send(res, json({ ok: false, error: 'invalid provider (need at least an id + baseUrl)' }));
    // 审计 P2: 测试连接把 fetchOpenAiModels 的裸 'HTTP 401' 直接回吐给用户 —— 首跑最高频故障(密钥错/无权限)却无
    // 中文人话、无下一步。这里把常见状态映射为可行动文案 + errorClass(前端据此渲染 ERROR_CLASSES 的 zh/next)。
    const probe = await fetchOpenAiModels(sp, 6000);
    if (!probe.ok && probe.error) {
      const e = String(probe.error);
      if (/\bHTTP 401\b|\bHTTP 403\b|unauthorized/i.test(e)) { probe.error = '密钥无效或无权限(' + e + '):请检查 API Key 是否正确、是否有额度/权限'; probe.errorClass = 'provider_misconfigured'; }
      else if (/\bHTTP 404\b/i.test(e)) { probe.error = '端点地址可能不对(' + e + '):检查 Base URL 是否为 OpenAI 兼容的 /v1 地址'; probe.errorClass = 'provider_misconfigured'; }
      else if (/timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/i.test(e)) { probe.error = '连不上端点(' + e + '):检查网络与 Base URL,内网端点确认可达'; probe.errorClass = 'network_down'; }
    }
    return send(res, json(probe));
  }
  if (req.method === 'GET' && pathname === '/api/sessions') {
    return send(res, json({ ok: true, sessions: await listSessions() }));
  }
  // v1 技能体系: 统一技能注册表(四源合并)。read-only → same-origin gate 足够(不在 needsToken)。?cwd= 供
  // 解析项目级技能(<cwd>/.ruyi/skills);缺省用 defaultWorkspace。向后兼容: 保留 skills 数组字段名,每项在
  // 原有 name/description/insert 之外新增 kind/source/dir/available/unavailableReason,并给老前端 type=kind。
  if (req.method === 'GET' && pathname === '/api/skills') {
    const config = await readConfig();
    const cwdQ = new URL(req.url, 'http://x').searchParams.get('cwd') || '';
    // P3-2: ?cwd= 决定项目级技能(<cwd>/.ruyi/skills)的解析根 —— 约束它必须落在本应用允许触碰的工作区根内
    // (fileAllowedRoots: defaultWorkspace + recentWorkspaces + dataRoot),否则忽略该参数、静默回退 defaultWorkspace
    // (不报错),防调用方传入任意路径去解析该目录外仓库里的项目技能。
    let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
    if (cwdQ) {
      const resolved = normalizeCwd(cwdQ, config.defaultWorkspace);
      if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved;
    }
    const registry = await loadSkillRegistry(cwd, config).catch(() => []);
    const skills = registry.map(e => ({
      id: e.id, name: e.name, description: e.description, detail: e.detail || '', kind: e.kind, type: e.kind,
      source: e.source, insert: e.insert, dir: e.dir, requires: e.requires,
      available: e.available, unavailableReason: e.unavailableReason,
      ...(e.kind === 'command' ? { prompt: e.prompt || '' } : {}),
      // Playbook 条目带上完整 playbook 对象(前端「技能库」的 Playbook 项直接走 openPlaybookModal 流程)。
      ...(e.kind === 'playbook' && e.playbook ? { playbook: e.playbook } : {}),
    }));
    return send(res, json({ ok: true, skills }));
  }
  // v1 技能体系: 设置本会话启用的技能。body {sessionId, skills:[ids 或 {id}]}。校验 id 存在于注册表且 kind==='skill'、
  // 去重、截 8,每项落盘为 {id, source}(P2-2 来源锁定),写 session 后回 {ok, skills}。浏览器调用受 uiMutatingRoute
  // token 门(P3-7,与 /api/sessions 同级);非浏览器 loopback(e2e)仍只走 same-origin。
  if (req.method === 'POST' && pathname === '/api/session/skills') {
    const body = await readJsonBody(req);
    const session = await loadSession(String(body && body.sessionId || '')).catch(() => null);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    const config = await readConfig();
    const cwd = normalizeCwd(session.cwd, config.defaultWorkspace);
    const registry = await loadSkillRegistry(cwd, config).catch(() => []);
    const byIdReg = new Map(registry.filter(e => e.kind === 'skill').map(e => [e.id, e]));
    const cleaned = [];
    const seen = new Set();
    for (const raw of (Array.isArray(body && body.skills) ? body.skills : [])) {
      const id = String((raw && typeof raw === 'object') ? (raw.id || '') : (raw || '')).trim(); // 兼容前端传 id 或 {id,source}
      const e = byIdReg.get(id);
      if (!e || seen.has(id)) continue; // 只收注册表里存在的技能 id;去重
      seen.add(id);
      cleaned.push({ id, source: e.source || '' }); // P2-2: 从注册表带上 source 落盘 —— 锁定「启用当时的来源」,解析时据此防调包
      if (cleaned.length >= 8) break; // 上限 8
    }
    session.skills = cleaned;
    await saveSession(session);
    // P2-3: 若该会话正有活动回合(内存另持一份 session 快照),同步把新启用集写进该活动 session,避免回合收尾整体
    // saveSession 覆盖本次变更(与两个 turn 函数收尾前的磁盘合并互为兜底)。
    { const reg = activeChildren.get(session.id); if (reg && reg.session && reg.session !== session) reg.session.skills = cleaned; }
    return send(res, json({ ok: true, skills: cleaned }));
  }
  // ── v2 跨会话记忆(团队模式 v2 Phase 3, 设计稿 C) ─────────────────────────────────────────────
  // POST /api/session/memories {sessionId, memories:[{id,scope}]} —— 显式覆盖会话启用记忆(校验存在性)。走 uiMutatingRoute。
  if (req.method === 'POST' && pathname === '/api/session/memories') {
    const body = await readJsonBody(req);
    const session = await loadSession(String(body && body.sessionId || '')).catch(() => null);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    const config = await readConfig();
    const cwd = normalizeCwd(session.cwd, config.defaultWorkspace);
    const registry = await loadMemoryRegistry(cwd).catch(() => []);
    const byKey = new Map(registry.map(e => [e.scope + ':' + e.id, e]));
    const projKey = projectKeyForCwd(cwd); // P3-3: 权威 projectKey(取自 session.cwd),给 project 条目落盘锁定来源
    const cleaned = [];
    const seen = new Set();
    for (const raw of (Array.isArray(body && body.memories) ? body.memories : [])) {
      const id = String((raw && raw.id) || '').trim();
      const scope = (raw && raw.scope === 'global') ? 'global' : 'project';
      const key = scope + ':' + id;
      if (!byKey.has(key) || seen.has(key)) continue; // 只收注册表里存在的(存在性校验)
      seen.add(key);
      // P3-3: project 条目落盘 projectKey(锁定「启用当时的项目组」);global 无此概念。前端如传 projectKey 一律以服务端权威值覆盖。
      cleaned.push(scope === 'project' ? { id, scope, projectKey: projKey } : { id, scope });
      if (cleaned.length >= 8) break;
    }
    session.memories = cleaned;
    session.memoriesExplicit = true; // 用户显式设置过 → 关闭默认自动启用
    await saveSession(session);
    { const reg = activeChildren.get(session.id); if (reg && reg.session && reg.session !== session) { reg.session.memories = cleaned; reg.session.memoriesExplicit = true; } }
    return send(res, json({ ok: true, memories: cleaned }));
  }
  // GET /api/memory?cwd= —— 列表(global + 当前项目组 + 其它组供迁移)。返回记忆条目含绝对文件路径 → 属只读内容型
  // GET,须 tokenOk 自校验(v1.4.6-S1 DNS-rebinding 加固既定模式,同 /api/file/preview;GET 不过 mutating 鉴权块)。
  // ?cwd= 约束到 fileAllowedRoots,越界静默回退 defaultWorkspace(同 GET /api/skills 的 P3-2)。
  if (req.method === 'GET' && pathname === '/api/memory') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const config = await readConfig();
    const cwdQ = new URL(req.url, 'http://x').searchParams.get('cwd') || '';
    let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
    if (cwdQ) { const resolved = normalizeCwd(cwdQ, config.defaultWorkspace); if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved; }
    const memories = await loadMemoryRegistry(cwd).catch(() => []);
    const projectKey = projectKeyForCwd(cwd);
    const otherProjects = await listMemoryProjectGroups(projectKey).catch(() => []);
    return send(res, json({ ok: true, memories, projectKey, cwd, otherProjects }));
  }
  // GET /api/memory/item?id=&scope=&cwd= —— 读单条记忆全文(编辑回填)。返回文件正文 → 只读内容型 GET,须 tokenOk
  // 自校验(同 /api/memory 与 /api/file/preview 的 DNS-rebinding 加固模式)。
  if (req.method === 'GET' && pathname === '/api/memory/item') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const config = await readConfig();
    const sp = new URL(req.url, 'http://x').searchParams;
    const scope = sp.get('scope') === 'global' ? 'global' : 'project';
    const cwdQ = sp.get('cwd') || '';
    let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
    if (cwdQ) { const resolved = normalizeCwd(cwdQ, config.defaultWorkspace); if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved; }
    const item = await readMemoryItem(String(sp.get('id') || ''), scope, cwd);
    return send(res, json(item, item.ok ? 200 : 404));
  }
  // POST /api/memory/draft {sessionId} —— provider 起草(镜像 playbook/draft)。必须在通配 /api/memory/<id> 之前。
  if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/draft') {   // 对抗轮 P3: 放行删除约定穿透
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body && body.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    return send(res, json(await draftMemoryFromSession(sessionId)));
  }
  // POST /api/memory/migrate {id, fromKey, cwd} —— 迁移一条项目记忆到当前 cwd 的项目组。
  if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/migrate') {   // 对抗轮 P3: 放行删除约定穿透
    const body = await readJsonBody(req);
    const config = await readConfig();
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    if (!pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
    const r = await migrateMemory(String(body && body.id || ''), String(body && body.fromKey || ''), cwd);
    // P2-4: 同名冲突返回 409(Conflict),与一般失败 400 区分,供前端汇总「N 条冲突跳过」。
    return send(res, json(r, r.ok ? 200 : (r.conflict ? 409 : 400)));
  }
  // POST /api/memory {memory:{id?,scope,name,description,type,body}, cwd} —— 保存(id 缺省合成,原子写)。
  if (req.method === 'POST' && pathname === '/api/memory') {
    const body = await readJsonBody(req);
    const config = await readConfig();
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    const memIn = (body && body.memory) || {};
    if (memIn.scope === 'project' && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
    const r = await saveMemory(memIn, cwd);
    return send(res, json(r, r.ok ? 200 : 400));
  }
  // DELETE 经 POST /api/memory/<id> + x-http-method:DELETE {scope, cwd}(sessions/playbooks 同款约定)。
  if (pathname.startsWith('/api/memory/') && (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))) {
    const id = path.basename(pathname); // guards traversal
    const body = await readJsonBody(req);
    const config = await readConfig();
    const scope = body && body.scope === 'global' ? 'global' : 'project';
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    if (scope === 'project' && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));   // 对抗轮 P3: 与保存分支同款 root 校验
    const r = await deleteMemory(id, scope, cwd);
    return send(res, json(r, r.ok ? 200 : 404));
  }
  if (req.method === 'POST' && pathname === '/api/sessions') {
    const body = await readJsonBody(req);
    return send(res, json({ ok: true, session: await createSession(body) }));
  }
  // Bulk history cleanup is intentionally narrower than the single-session DELETE endpoint: it only
  // clears unpinned sessions and can preserve the currently open session supplied by the UI.
  if (req.method === 'POST' && pathname === '/api/sessions/bulk-delete') {
    const body = await readJsonBody(req);
    return send(res, json(await bulkDeleteUnpinnedSessions({
      preserveSessionId: body && body.preserveSessionId,
      purgeAssociated: Boolean(body && body.purgeAssociated),
    })));
  }
  if (pathname.startsWith('/api/sessions/')) {
    const id = path.basename(pathname); // guards traversal
    if (req.method === 'GET') {
      const session = await loadSession(id);
      if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
      // v0.8-S0 A6: surface whether the last turn dangles (arrested mid-flight) so the UI can offer resume.
      return send(res, json({ ok: true, session, resumable: detectDanglingTurn(session) }));
    }
    if (req.method === 'PATCH' || (req.method === 'POST' && req.headers['x-http-method'] === 'PATCH')) {
      const body = await readJsonBody(req);
      const session = await updateSessionMeta(id, body);
      if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
      return send(res, json({ ok: true, session }));
    }
    if (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE')) {
      return send(res, json(await deleteSession(id)));
    }
  }
  if (req.method === 'POST' && pathname === '/api/stop') {
    const body = await readJsonBody(req);
    const sid = safeSessionId(body.sessionId);
    const stopped = stopSession(String(body.sessionId || ''), 'stopped');
    // 第27波:显式停止 = 用户介入夺回控制 → 撤销该会话【全部】授权书(含 scope:'session')。断连触发的 stopSession 不
    // 走此处,仅由 streamChat finally 蒸发 scope:'run'(保留 session 授权供重连续用)—— intent-aware 精确撤销。
    if (sid) { try { revokeAllGrants(sid, 'ui-stop'); } catch { /* best-effort */ } }
    return send(res, json({ ok: true, stopped }));
  }
  if (req.method === 'POST' && pathname === '/api/provider/compact') {
    // §5.2: native-provider context compaction. Same-origin protected (mutating) like /api/stop and
    // /api/chat/answer — deliberately NOT in needsToken (commander's amendment) to stay consistent.
    const body = await readJsonBody(req);
    return send(res, json(await runProviderCompact(String(body.sessionId || ''))));
  }
  if (req.method === 'POST' && pathname === '/api/chat/answer') {
    // Settle exactly one live question. A stale/wrong-session answer is a conflict, never a fake success:
    // the UI must keep the modal open so the user can retry or see that the turn already ended.
    const body = await readJsonBody(req);
    const sessionId = String(body.sessionId || '');
    const questionId = String(body.questionId || body.toolUseId || '');
    const entry = pendingQuestions.get(questionId);
    if (!entry || entry.sessionId !== sessionId) {
      return send(res, apiFailure('question.not_pending', {}, 'question is no longer pending', 409));
    }
    const delivered = entry.deliver(normalizeQuestionAnswer(body));
    if (!delivered) return send(res, apiFailure('question.delivery_failed', {}, 'answer could not be delivered; the question is still pending', 409));
    logEvent({ kind: 'intervention', source: 'question_answer', sessionId, questionId });
    return send(res, json({ ok: true, delivered: true, questionId }));
  }
  if (req.method === 'POST' && pathname === '/api/question/request') {
    // Called by request_user_input in the per-session Claude MCP child. Hold the tool call until the UI
    // answers, then return a normal MCP tool result. Provider turns use the same registry in-process.
    const body = await readJsonBody(req);
    if (!RUNTIME.token || body.token !== RUNTIME.token) return send(res, apiFailure('auth.token_invalid', {}, 'bad token', 403));
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    const reg = activeChildren.get(sessionId);
    if (!reg || !reg.onEvent) return send(res, apiFailure('question.no_active_turn', {}, 'no active UI stream to prompt', 409));
    const config = await readConfig();
    const answer = await requestUserQuestion(sessionId, makeId('question'), body.questions, reg.onEvent, config.permissionTimeoutMs);
    return send(res, json(answer && answer.ok
      ? { ok: true, answers: answer.answers, content: answer.content }
      : { ok: false, error: (answer && (answer.error || answer.content)) || 'question cancelled' }));
  }
  if (req.method === 'POST' && pathname === '/api/permission/request') {
    // Called by the permission-bridge MCP tool (loopback). Holds until the UI decides or times out.
    const body = await readJsonBody(req);
    if (!RUNTIME.token || body.token !== RUNTIME.token) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const config = await readConfig();
    const sessionId = String(body.sessionId || '');
    const reg = activeChildren.get(sessionId);
    const requestId = makeId('perm');
    if (!reg || !reg.onEvent) {
      // No live UI stream to ask — fail closed.
      return send(res, json({ behavior: 'deny', message: 'no active UI to prompt', requestId }));
    }
    // v0.8-S4b: mirror the native path — carry tier + revertible so the popup renders the badge + the
    // revertibility line for CLI-bridge permission prompts too. The CLI reports its own tool names (Edit/
    // Write/Bash/…); toolIsRevertible only matches the workbench file_* set, so a native CLI Edit shows
    // 「无法自动撤销」(correct: CLI-native edits don't pass through toolCall → aren't journaled).
    // 第27波:CLI 桥授权书消耗点。命中直接 allow —— 连 permission_request 事件都不发(免弹窗静默放行)。工具名按 CLI
    // 弹窗实际显示的 Claude 名(Bash/Edit/Write)匹配,与签发卡片同名口径。范围外回落到下方正常弹窗。session 仅需 .id。
    const bridgeTier = nativeToolTier(String(body.toolName || ''));
    // 对抗轮 P3(天花板对称):与 native 主 gate 对齐 —— 仅当工作台自身权限模式对该档判定为 'ask' 时才允许授权书降级。
    // 工作台若处于 plan 模式(该档判 'block'),即便 CLI 发来请求也不放行(子集律:授权书永不把 block 提升为 allow),
    // 回落到下方正常弹窗由人定夺。default→'ask' 授权书生效;bypass→'allow' 本就免弹窗,无需授权书。
    if (nativeToolGate(config.permissionMode, bridgeTier) === 'ask') {
      const grantHit = consumeGrant({ id: sessionId }, String(body.toolName || ''), body.input || {}, 'cli', null);
      // 第42b波(live 冒烟擒获):CLI ≥2.1 的 zod union 要求 allow 变体【必须】带 updatedInput record,
      // 裸 {behavior:'allow'} 会被 CLI 判 invalid_union 拒掉 → 回显原始输入。
      if (grantHit) return send(res, json({ behavior: 'allow', updatedInput: body.input || {} }));
    }
    reg.onEvent({ type: 'permission_request', requestId, toolName: body.toolName, input: body.input, tier: bridgeTier, revertible: toolIsRevertible(body.toolName) });
    // 第27f波:CLI 桥超时→存档暂停(与 provider 路径对称)。仅【opt-in + 本会话处于无人值守 driverAuto 回合】才启用;
    // 否则维持"超时即拒杀"安全默认。两段定时:基础超时→检查点(logEvent+saveSession)+ permission_paused 事件 + 延长到 TTL;
    // TTL 内无决定则回落 deny(fail-closed)。entry.timer 重赋为 TTL 定时器,/api/permission/decision 与 clearPendingPermissions 照常清对。
    const cliPause = config.autonomyPauseOnTimeout && driverAutoSessions.has(sessionId);
    const decision = await new Promise(resolve => {
      const entry = { resolve, sessionId, timer: null };
      const baseMs = Number(config.permissionTimeoutMs || 120000);
      if (cliPause) {
        entry.timer = setTimeout(() => {
          if (reg) reg.pausePending = true; // 第27f波:存档暂停期间豁免子进程 idle 看门狗(否则 TTL 内先杀子,窗口被截断)
          try { logEvent({ kind: 'permission_paused', sessionId, tool: String(body.toolName || ''), tier: bridgeTier, requestId, engine: 'claude' }); } catch { /* ignore */ }
          loadSession(sessionId).then(s => s && saveSession(s)).catch(() => {}); // 检查点:会话已在磁盘,重写一遍固化
          try { reg.onEvent({ type: 'permission_paused', requestId, toolName: body.toolName, tier: bridgeTier, ttlMs: config.autonomyPauseTtlMs }); } catch { /* stream gone */ }
          entry.timer = setTimeout(() => { pendingPermissions.delete(requestId); resolve({ behavior: 'deny', message: '权限已存档暂停但在时限内无人决定,已回落拒绝', pausedTimeout: true }); }, Math.max(60000, Number(config.autonomyPauseTtlMs) || 2700000));
        }, baseMs);
      } else {
        entry.timer = setTimeout(() => { pendingPermissions.delete(requestId); resolve({ behavior: 'deny', message: 'permission prompt timed out' }); }, baseMs);
      }
      pendingPermissions.set(requestId, entry);
    });
    if (reg) { reg.pausePending = false; reg.lastEventAt = Date.now(); } // 解除暂停豁免 + 重置看门狗时钟(暂停不算子进程空闲)
    if (res.writableEnded || res.destroyed) return; // request already gone (e.g. child died)
    // 第42b波(live 冒烟擒获):CLI ≥2.1 的 --permission-prompt-tool 响应是 zod union —— allow 变体必须
    // 带 updatedInput record;UI 纯「允许」(未改输入)时 decision.updatedInput 为 undefined,JSON 序列化
    // 掉键后被 CLI 拒(invalid_union: expected record, received undefined)→ 回合必败。回填原始输入。
    if (decision && decision.behavior === 'allow' && (typeof decision.updatedInput !== 'object' || decision.updatedInput === null || Array.isArray(decision.updatedInput))) {
      decision.updatedInput = body.input || {};
    }
    return send(res, json(decision));
  }
  if (req.method === 'POST' && pathname === '/api/permission/decision') {
    // UI's allow/deny for a pending permission request.
    const body = await readJsonBody(req);
    const entry = pendingPermissions.get(String(body.requestId || ''));
    if (!entry) return send(res, json({ ok: false, error: 'unknown or expired request' }, 404));
    clearTimeout(entry.timer);
    pendingPermissions.delete(String(body.requestId));
    const behavior = body.behavior === 'allow' ? 'allow' : 'deny';
    // 29c: 干预落账 —— 只对真实待决请求计数(过期/重复决定已被上面 404 滤掉);entry 自带 sessionId。
    // 存档暂停(27f)窗口内的决定与基础窗内的决定走同一 handler,天然同权重。
    logEvent({ kind: 'intervention', source: 'permission_decision', sessionId: entry.sessionId || '', behavior });
    entry.resolve(behavior === 'allow' ? { behavior: 'allow', updatedInput: body.updatedInput } : { behavior: 'deny', message: body.message || 'denied by user' });
    return send(res, json({ ok: true }));
  }
  if (req.method === 'POST' && pathname === '/api/plan/decision') {
    // v0.9-S5 (真流程 plan mode): the UI's approve/reject for a paused plan. Token-gated (needsToken whitelist
    // above; header-token — this decision unlocks mutating tools for the turn, so it is at least as sensitive
    // as /api/permission). Looks up pendingPlans[planId], verifies the sessionId matches (so a decision can't
    // resolve another session's plan), settles the promise, and clears the timer. Idempotent: a second
    // decision for the same (already-settled) planId finds no entry → {ok:false, error:'no pending plan'}.
    const body = await readJsonBody(req);
    const planId = String(body.planId || '');
    const sessionId = String(body.sessionId || '');
    const entry = pendingPlans.get(planId);
    if (!entry || entry.sessionId !== sessionId) return send(res, json({ ok: false, error: 'no pending plan' }));
    clearTimeout(entry.timer);
    pendingPlans.delete(planId);
    const decision = body.decision === 'approve' ? 'approve' : 'reject';
    logEvent({ kind: 'intervention', source: 'plan_decision', sessionId, decision }); // 29c
    entry.resolve({ decision, note: body.note != null ? String(body.note) : '' });
    return send(res, json({ ok: true }));
  }
  if (req.method === 'POST' && pathname === '/api/todo') {
    // v0.8-S3: called by the todo_write tool running in the MCP child (Claude engine) over loopback. The
    // child must NOT write session files itself (races the serve process's saveSession), so it delegates
    // the persist here. Body-token authenticated (same pattern as /api/permission/request). Validates →
    // loadSession → session.todos = items → saveSession → if a live turn owns this session, emit `todo`.
    const body = await readJsonBody(req);
    if (!RUNTIME.token || body.token !== RUNTIME.token) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const sessionId = safeSessionId(body.sessionId); // F4
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const items = normalizeTodoItems(body.items);
    const session = await loadSession(sessionId);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    session.todos = items;
    await saveSession(session);
    const reg = activeChildren.get(sessionId);
    if (reg && reg.onEvent) { try { reg.onEvent({ type: 'todo', items }); } catch { /* stream gone */ } }
    return send(res, json({ ok: true, count: items.length }));
  }
  // ── 第26波b: 任务账本 API。GET 读(header token);POST 改(header token 或 body token —— 后者供 MCP 子进程
  //    的 mission_update 工具 loopback,同 /api/todo 纪律)。action: start(全量设)/update(合并)/stop/check(跑验收)。──
  if (pathname === '/api/mission') {
    const bodyOrQ = req.method === 'GET' ? Object.fromEntries(new URL(req.url, 'http://x').searchParams) : await readJsonBody(req);
    const bodyTokenOk = RUNTIME.token && bodyOrQ.token === RUNTIME.token;
    if (!tokenOk(req) && !bodyTokenOk) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(bodyOrQ.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const session = await loadSession(sessionId);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    if (req.method === 'GET') return send(res, json({ ok: true, mission: session.mission || null }));
    if (req.method !== 'POST') return send(res, json({ ok: false, error: 'method not allowed' }, 405));
    const action = String(bodyOrQ.action || 'update');
    const emitMission = () => { const reg = activeChildren.get(sessionId); if (reg && reg.onEvent) { try { reg.onEvent({ type: 'mission', mission: session.mission }); } catch { /* stream gone */ } } };
    if (action === 'stop') {
      if (session.mission) { session.mission.autoMode = 'off'; session.mission.updatedAt = nowIso(); await saveSession(session); emitMission(); }
      return send(res, json({ ok: true, mission: session.mission || null }));
    }
    if (action === 'check') {
      // 跑全部里程碑机器验收;autoMark!==false 时把 pass 的 pending/blocked 里程碑标 done(证据落 detail)。
      const cwd = normalizeCwd(session.cwd, (await readConfig()).defaultWorkspace);
      const results = [];
      for (const m of ((session.mission && session.mission.milestones) || [])) {
        const r = await evaluateMissionCheck(m.check, cwd);
        results.push({ id: m.id, checkType: m.check ? m.check.type : 'none', result: r });
        if (r && r.pass && bodyOrQ.autoMark !== false && m.status !== 'done') { m.status = 'done'; m.evidence = String(r.detail || '机器验收通过').slice(0, MISSION_MAX_TEXT); }
        if (r && !r.pass && m.status === 'done') { /* 不自动回退 done → 避免抖动;仅 report */ }
      }
      if (session.mission) session.mission.updatedAt = nowIso();
      await saveSession(session); emitMission();
      return send(res, json({ ok: true, mission: session.mission || null, checks: results }));
    }
    // start = 全量新建(normalizeMission,prev=null);update = 按 id 增量合并(applyMissionUpdate,不抹其它里程碑)。
    // autoMode 可作 body 兄弟字段或 mission.autoMode 传入,两条路径都尊重。
    // 对抗轮 P1: trusted = 【header token】(UI/用户)——只有它能定义机器 check;body-token loopback(模型经 MCP 子进程)
    // 视为不可信,不能设 check.cmd。header token 存在即 UI 直连(浏览器 CORS 拿不到该 token)。
    const trusted = tokenOk(req);
    if (action === 'start') {
      const input = { ...(bodyOrQ.mission || bodyOrQ) };
      if (bodyOrQ.autoMode != null && input.autoMode == null) input.autoMode = bodyOrQ.autoMode;
      session.mission = normalizeMission(input, null, trusted);
      logEvent({ kind: 'mission_start', sessionId, trusted, autoMode: session.mission.autoMode }); // 29c: 预算超支率的分母
    } else {
      if (!session.mission) return send(res, json({ ok: false, error: '当前会话没有活动任务账本;请先 action:start' }, 400));
      session.mission = applyMissionUpdate(session.mission, bodyOrQ.patch || bodyOrQ, trusted);
      if (bodyOrQ.autoMode != null) session.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : session.mission.autoMode;
    }
    await saveSession(session); emitMission();
    return send(res, json({ ok: true, mission: session.mission }));
  }
  // ── 第27波:自主性授权书 API。全部 header-token 白名单路由(需 needsToken 命中 + 此处再自查 tokenOk,【绝不】带
  //    body-token 兜底 —— R-P2-2 签发主权律:被注入的模型经 MCP 子进程 loopback 拿的是 body-token,永无签发/撤销能力)。──
  if (pathname === '/api/autonomy/grants') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    const sessionId = safeSessionId(q.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    return send(res, json({ ok: true, grants: listGrantsView(sessionId), activeRun: activeDriverRuns.get(sessionId) || null }));
  }
  if (req.method === 'POST' && pathname === '/api/autonomy/grant') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const session = await loadSession(sessionId);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    const config = await readConfig();
    const norm = normalizeGrant(body, session, config, Date.now());
    if (!norm.ok) return send(res, json({ ok: false, error: norm.error }, 400));
    const g = norm.grant;
    // dry-run:签发瞬间 glob 一次,展示将命中的工作区内文件(所见即所授闭环)。边界内、有限步、best-effort。
    let dryRun = { count: 0, sample: [], truncated: false };
    if (g.tier === 'read' || g.tier === 'edit') {
      try { dryRun = await dryRunGrantFiles(g, 40); } catch { /* best-effort */ }
    }
    // preview 模式:只 normalize + dry-run,【不】入 Map、不发审计/SSE —— 供 UI「预览命中」无副作用。
    if (body.preview === true) {
      return send(res, json({ ok: true, preview: true, grant: { tool: g.tool, tier: g.tier, scope: g.scope, pathGlob: g.pathGlob, cmdAllow: g.cmdAllow, netAllowed: g.netAllowed, maxUses: g.maxUses }, dropped: norm.dropped, dryRun }));
    }
    const list = autonomyGrants.get(sessionId) || [];
    list.push(g);
    autonomyGrants.set(sessionId, list);
    logEvent({ kind: 'autonomy_grant_issued', grantId: g.grantId, sessionId, tool: g.tool, tier: g.tier, scope: g.scope, pathGlob: g.pathGlob, cmdAllow: g.cmdAllow, netAllowed: g.netAllowed, maxUses: g.maxUses, ttlMs: g.ttlMs });
    const reg = activeChildren.get(sessionId);
    if (reg && reg.onEvent) { try { reg.onEvent({ type: 'autonomy_grant', grants: listGrantsView(sessionId) }); } catch { /* stream gone */ } }
    return send(res, json({ ok: true, grant: listGrantsView(sessionId).find(x => x.grantId === g.grantId) || null, dropped: norm.dropped, dryRun }));
  }
  if (req.method === 'POST' && pathname === '/api/autonomy/revoke') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    let n = 0;
    if (body.all === true) n = revokeAllGrants(sessionId, 'ui-revoke-all');
    else if (body.grantId) n = revokeGrant(sessionId, String(body.grantId)) ? 1 : 0;
    else return send(res, json({ ok: false, error: '需提供 grantId 或 all:true' }, 400));
    const reg = activeChildren.get(sessionId);
    if (reg && reg.onEvent) { try { reg.onEvent({ type: 'autonomy_grant', grants: listGrantsView(sessionId) }); } catch { /* stream gone */ } }
    return send(res, json({ ok: true, revoked: n, grants: listGrantsView(sessionId) }));
  }
  if (req.method === 'POST' && pathname === '/api/agent-workflow/launch') {
    // Claude CLI's one-shot MCP child proxies the persistent DAG into the serve process. v1.4.4: the DAG
    // is genuinely dual-engine now — each node picks 'openai' (HTTP against a configured Provider) or
    // 'claude' (a native one-shot `claude` CLI spawn, runClaudeSubAgentOnce) via runAgentWorkflow's
    // per-node engine resolution, so a Claude-CLI-only setup no longer needs a Provider configured at all.
    const body = await readJsonBody(req);
    if (!RUNTIME.token || body.token !== RUNTIME.token) return send(res, json({ ok: false, error: 'bad token' }, 403));
    const sessionId = safeSessionId(body.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const session = await loadSession(sessionId);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    const config = await readConfig();
    const provider = resolveProvider(config, body.providerId) || (config.providers || []).find(p => p && p.baseUrl && (p.model || (p.models && p.models.length)));
    const claudeCli = config.claudePath || detectClaudePath();
    const claudeCliUsable = Boolean(process.env.WCW_FAKE_CLAUDE) || Boolean(claudeCli && existsExecutable(claudeCli)); // test seam, see runClaudeTurn
    // Only reject up front when NEITHER engine could possibly run anything; a specific node explicitly
    // requesting an unavailable engine still fails gracefully per-node inside runAgentWorkflow.
    if (!provider && !claudeCliUsable) {
      return send(res, json({ ok: false, error: 'Agent DAG 需要至少配置一个 OpenAI 兼容 Provider，或安装并配置 Claude CLI' }, 400));
    }
    const reg = activeChildren.get(sessionId); const onEvent = reg && reg.onEvent ? reg.onEvent : () => {};
    const resolved = await resolveOrchestrateNodes(body, normalizeCwd(session.cwd, config.defaultWorkspace));
    if (resolved.error) return send(res, json({ ok: false, error: resolved.error, startedCount: 0 }));
    // v1.4.4: a persisted DAG's node-count ceiling is agentWorkflowMaxNodes, NOT subagentMaxPerTurn (that's
    // an ad hoc, single-CHAT-TURN spawn_agent/orchestrate_agents fan-out budget — a 4-node default there
    // used to reject any real pipeline with 5+ nodes outright here, even though resuming the same run used
    // a hardcoded 32).
    const contextText = String(body.context || '').trim();
    const completion = run => appendAgentWorkflowSummaryToSession(session.id, run, { title: body.workflowId ? `Agent 工作流 ${body.workflowId}` : 'Agent 工作流' });
    if (body.async === true) {
      const runId = makeId('run');
      void runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: config.permissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, runIdOverride: runId, onComplete: completion, poolPolicy: body.poolPolicy }).catch(async e => {
        activeAgentRuns.delete(runId); // 对抗轮 P2: 启动期抛出时兜底清注册(与 launchPersistedAgentRun 的 catch 对齐)
        const run = { schemaVersion: 4, id: runId, sessionId: session.id, turnSeq: session.turnSeq, providerId: provider && provider.id || '', status: 'failed', createdAt: nowIso(), updatedAt: nowIso(), completedAt: nowIso(), error: String(e && e.message || e), nodes: [] };
        await saveAgentRun(run).catch(() => {});
        await completion(run).catch(() => {});
      });
      return send(res, json({ ok: true, accepted: true, runId }));
    }
    const result = await runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: config.permissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, onComplete: activeChildren.has(session.id) ? null : completion, poolPolicy: body.poolPolicy });
    return send(res, json(result));
  }
  // v1.4-OSS 用量/成本看板: read-only aggregation over the append-only usage ledgers. Same gate as the other
  // read-only GETs (agent-runs/checkpoints): self-check tokenOk here; NOT in the needsToken mutating whitelist.
  if (req.method === 'GET' && pathname === '/api/usage/summary') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const rawRange = new URL(req.url, 'http://x').searchParams.get('range') || 'month';
    const range = ['today', 'week', 'month', 'all'].includes(rawRange) ? rawRange : 'month';
    try {
      return send(res, json(await buildUsageSummary(range)));
    } catch {
      // Old install with no ledger / any read error -> empty aggregation, never a 500.
      return send(res, json({ ok: true, range, totals: { inTok: 0, outTok: 0, turns: 0, estimatedTurns: 0, planBasedTurns: 0, costsByCurrency: {} }, byEngine: [], byProvider: [], bySession: [], byDay: [], budget: null }));
    }
  }
  // 第29波(§29c): 运营指标聚合(read-only GET,同 usage/summary 纪律:handler 自查 tokenOk,失败回空聚合)。
  if (req.method === 'GET' && pathname === '/api/ops/metrics') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const daysQ = new URL(req.url, 'http://x').searchParams.get('days');
    try { return send(res, json(await buildOpsMetrics(daysQ))); }
    catch { return send(res, json({ ok: true, days: 7, interventions: { total: 0, bySource: {} }, missions: { started: 0, budgetExhausted: 0, budgetOverrunRate: 0 } })); }
  }
  // v0.8-S4a: checkpoint query (read-only → same-origin gate is enough; not in needsToken).
  if (req.method === 'GET' && pathname === '/api/agent-runs') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const listUrl = new URL(req.url, 'http://x');
    const sessionId = safeSessionId(listUrl.searchParams.get('sessionId'));
    if (!sessionId) return send(res, json({ ok: false, error: 'sessionId required' }, 400));
    const runs = await listAgentRuns(sessionId);
    // 25.2: persistenceDegraded 从内存活跃对象叠加下发 —— 快照写失败时磁盘是陈旧的,这条旗标必须绕过磁盘到达 UI。
    for (const run of runs) { const live = activeAgentRuns.get(run.id); if (live) { run.live = true; run.paused = !!live.paused; if (live.run && live.run.persistenceDegraded) run.persistenceDegraded = true; } }
    // 第29波(§29a): digest 轻量视图 —— 增量客户端每 tick 只拉这份 run 级标量做变更探测(eventSeq/status/
    // updatedAt),不再每 2s 重传全部节点(单节点 result≤24KB + roleSnapshot 8KB prompt,历史终态 run 每 tick
    // 白传)。live run 的 eventSeq/status/updatedAt 以【内存】为准(快照节流 1.5s,磁盘恒旧);快照仍是唯一
    // 权威状态源,digest 只是"该不该去拉"的信号。
    if (listUrl.searchParams.get('view') === 'digest') {
      const digest = runs.map(r => {
        const live = activeAgentRuns.get(r.id);
        const mem = live && live.run ? live.run : null;
        return {
          id: r.id, status: mem ? mem.status : r.status, eventSeq: Number((mem || r).eventSeq) || 0,
          updatedAt: (mem || r).updatedAt || '', createdAt: r.createdAt || '', completedAt: (mem || r).completedAt || '',
          nodeCount: Array.isArray((mem || r).nodes) ? (mem || r).nodes.length : 0,
          poolPending: ((mem || r).taskPool || []).filter(p => p && p.status === 'proposed').length,
          live: !!live, paused: !!(live && live.paused), persistenceDegraded: !!(mem && mem.persistenceDegraded) || r.persistenceDegraded === true,
          resumeTier: (mem || r).resumeTier || '', pendingReview: !!(mem || r).pendingReview,
          anyRunning: Array.isArray((mem || r).nodes) && (mem || r).nodes.some(n => n && (n.status === 'running' || n.status === 'waiting_resource')),
        };
      });
      return send(res, json({ ok: true, view: 'digest', runs: digest }));
    }
    return send(res, json({ ok: true, runs }));
  }
  // 第29波(§29a): 增量事件消费 —— 客户端记住 lastSeq,断线/重开后 afterSeq=lastSeq 重发即天然补播;
  // seq 严格单调(25.3)保证补播无重无漏。必须排在文件底部 GET /api/agent-runs/:id 通配前缀分支之前,
  // 否则被吞。跨会话防护与快照端点同源:事件文件按 sessionId 分目录,错 session 只会 404→空数组。
  if (req.method === 'GET' && pathname.startsWith('/api/agent-runs/') && pathname.endsWith('/events')) {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const evUrl = new URL(req.url, 'http://x');
    const sessionId = safeSessionId(evUrl.searchParams.get('sessionId'));
    const evParts = pathname.split('/').filter(Boolean); // ['api','agent-runs',runId,'events']
    const runId = evParts.length === 4 ? safeSessionId(evParts[2]) : null;
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    const afterSeq = Number(evUrl.searchParams.get('afterSeq')) || 0;
    const { events, hasMore } = await readAgentRunEvents(sessionId, runId, afterSeq, Number(evUrl.searchParams.get('limit')) || 0);
    return send(res, json({ ok: true, runId, afterSeq, events, hasMore }));
  }
  if (req.method === 'POST' && pathname.startsWith('/api/agent-runs/')) {
    const parts = pathname.split('/').filter(Boolean);
    const runId = safeSessionId(parts[2]);
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId);
    const action = String(body.action || '');
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    const live = activeAgentRuns.get(runId);
    // runId 是全局命名空间（不像持久化文件那样按 sessionId 分目录），live runtime 挂在内存 Map 里也不天然按
    // sessionId 隔离——不加这层校验，一个知道/猜到 runId 的会话就能 pause/resume/stop/steer 另一个会话正在跑的
    // 工作流。对齐 apply_isolation 从文件读到 run 后做的 run.sessionId !== sessionId 校验语义，统一在这里拦截，
    // 对 pause/resume/stop/steer_node 全部生效；resume 的冷启动分支（live 为空）走 launchPersistedAgentRun，
    // 本来就按 sessionId 找持久化文件，不受影响。
    if (live && live.run && live.run.sessionId && live.run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
    if (action === 'pause') {
      if (!live) return send(res, json({ ok: false, error: '工作流当前未运行' }, 409));
      // 对抗轮 P3(#8): 计数按【状态迁移】幂等 —— 对已暂停 run 重复 POST(UI 按钮态滞后期双击/双面板)端点行为
      // 无害但计数器会被 UI 时延系统性抬高。只在真正 running→paused 时计一次干预(与本文件 pool_approve 先查
      // status!=='proposed' 的"无效重复不计干预"模式一致)。
      const wasPaused = live.paused === true;
      live.paused = true; live.run.pauseRequestedAt = nowIso();
      if (!wasPaused) bumpRunIntervention(live.run, 'pause'); // 29c(状态迁移才计)
      appendAgentRunEvent(live.run, { type: 'run_paused', data: { reason: 'user' } }); // 25.3
      await saveAgentRun(live.run);
      return send(res, json({ ok: true, state: 'pausing' }));
    }
    if (action === 'resume') {
      if (live) {
        // Reset the idle clock ATOMICALLY with clearing paused: the watchdog reads live.lastActivityAt, so by the
        // time it observes paused=false the clock is already fresh -> no false idle-abort right after a long pause.
        const wasPaused = live.paused === true; // 对抗轮 P3(#8): 仅 paused→running 计一次(对运行中 run resume 是 no-op,不计)
        live.paused = false; live.lastActivityAt = Date.now(); const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake();
        if (wasPaused) bumpRunIntervention(live.run, 'resume'); // 29c
        appendAgentRunEvent(live.run, { type: 'run_resume_requested', data: { mode: 'warm' } }); // 25.3
        saveAgentRun(live.run).catch(() => {}); // 对抗轮修: 追写快照,让 eventSeq 尽快落盘(缩小崩溃重号窗口)
        return send(res, json({ ok: true, state: 'running' }));
      }
      return send(res, json(await launchPersistedAgentRun({ sessionId, runId, interventionKind: 'resume' })));
    }
    if (action === 'stop') {
      if (!live) return send(res, json({ ok: false, error: '工作流当前未运行' }, 409));
      const wasStopping = live.stopRequested === true; // 对抗轮 P3(#8): 重复 stop 不重复计
      live.stopRequested = true; live.paused = false; try { if (live.ctrl) live.ctrl.abort(); } catch {}
      const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake();
      if (!wasStopping) bumpRunIntervention(live.run, 'stop'); // 29c
      appendAgentRunEvent(live.run, { type: 'run_stop_requested' }); // 25.3
      saveAgentRun(live.run).catch(() => {}); // 对抗轮修: 同 resume —— 追写快照缩小 eventSeq 崩溃重号窗口
      return send(res, json({ ok: true, state: 'stopping' }));
    }
    if (action === 'retry_node') {
      if (live) return send(res, json({ ok: false, error: '请先等待或停止当前运行' }, 409));
      const nodeId = String(body.nodeId || '').trim();
      return send(res, json(await launchPersistedAgentRun({ sessionId, runId, retryNodeId: nodeId, retryCascade: body.cascade === true, interventionKind: 'retry_node' })));
    }
    if (action === 'apply_isolation') {
      if (live) return send(res, json({ ok: false, error: '请先等待当前运行结束' }, 409));
      const nodeId = String(body.nodeId || '').trim();
      const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8').catch(() => ''), null);
      if (!run || run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
      const applied = await applyAgentWorktree(run, nodeId).catch(e => ({ ok: false, error: String(e && (e.gitStderr || e.message) || e) }));
      return send(res, json(applied, applied.ok ? 200 : 409));
    }
    // v1 定向插话（steer 到指定运行中子代理节点）: enqueue a user interjection onto ONE running/queued OpenAI
    // node's steer queue; runSubAgentCore drains it at its next iteration boundary. Requires a live run (the
    // queue lives on the in-memory runtime). Claude-engine nodes are -p single-shot processes with no
    // iteration boundary to inject at, so they are rejected here (symmetric with /api/steer rejecting Claude).
    if (action === 'steer_node') {
      if (!live) return send(res, json({ ok: false, error: '工作流当前未运行，无法插话' }, 409));
      // 停止收尾窗口：stop 已经请求（或 ctrl 已中止）之后，节点即将被标记 cancelled，不会再有下一次迭代边界来
      // 消费插话队列；此时接受插话只会让用户误以为它会生效，直接拒绝更诚实。
      if (live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted)) return send(res, json({ ok: false, error: '工作流正在停止，无法插话' }, 409));
      const nodeId = String(body.nodeId || '').trim();
      if (!nodeId) return send(res, json({ ok: false, error: 'nodeId required' }, 400));
      // 团队模式 v2 (B1): 投递资格判定与 send_to_agent 共用同一小函数(不复制两份),reason 各自映射为本处既有措辞。
      const elig = nodeDeliveryEligibility(live.run, nodeId);
      if (elig.reason === 'not_found') return send(res, json({ ok: false, error: '节点不存在' }, 404));
      if (elig.reason === 'claude_engine') return send(res, json({ ok: false, error: 'Claude 引擎节点为单发进程，暂不支持中途插话' }, 409));
      if (elig.reason === 'deterministic_gate') return send(res, json({ ok: false, error: '确定性质量门节点不经过模型，无法插话' }, 409));
      if (elig.reason === 'terminal') return send(res, json({ ok: false, error: '节点已结束，无法插话' }, 409));
      const text = String(body.text || '').trim().slice(0, 2000);
      if (!text) return send(res, json({ ok: false, error: '插话内容不能为空' }, 400));
      if (!live.steerQueues) live.steerQueues = new Map();
      let q = live.steerQueues.get(nodeId);
      if (!q) { q = []; live.steerQueues.set(nodeId, q); }
      if (q.length >= STEER_QUEUE_MAX) return send(res, json({ ok: false, error: '该节点插话队列已满' }, 409));
      q.push(text);
      bumpRunIntervention(live.run, 'steer_node'); // 29c(队列在内存,计数随下一次快照落盘即可,不额外写盘)
      return send(res, json({ ok: true, queued: q.length }));
    }
    // 团队模式 v2 (A2/A4): 任务池审批。归属守卫(live.run.sessionId !== sessionId → 404)已在上方对全 action 生效。
    // 非 live 或 closing(收尾已原子置位)→ 409 带指引;宽限窗内 closing 仍为 false,故窗内可批并物化并继续调度。
    if (action === 'pool_approve' || action === 'pool_reject') {
      if (!live || live.closing) return send(res, json({ ok: false, error: '运行已结束;可在新运行中执行该任务' }, 409));
      const poolId = String(body.poolId || '').trim();
      if (!poolId) return send(res, json({ ok: false, error: 'poolId required' }, 400));
      const item = (Array.isArray(live.run.taskPool) ? live.run.taskPool : []).find(p => p && p.id === poolId);
      if (!item) return send(res, json({ ok: false, error: '提案不存在' }, 404));
      if (item.status !== 'proposed') return send(res, json({ ok: false, error: `该提案已处理(${item.status})` }, 409));
      if (action === 'pool_reject') {
        item.status = 'rejected'; item.decidedBy = 'user'; item.decidedAt = nowIso();
        bumpRunIntervention(live.run, 'pool_reject'); // 29c
        appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'rejected', poolId, by: 'user' } }); // 29a
        await saveAgentRun(live.run);
        return send(res, json({ ok: true, status: 'rejected', poolId }));
      }
      // approve → 物化(normalizeAgentWorkflow 同款单节点清洗,见 materializePoolItem)。角色库按会话 cwd 构建以校验 roleId。
      // 对抗轮 P3: 停止收尾窗(stopRequested/aborted 已置、closing 尚未置位)内拒绝审批——否则返回"已加入工作流",
      // 节点却在批次落地后立刻被 cancel,语义不诚实。与 steer_node 的停止窗 409 对齐;入口与复检各一道。
      const stoppingNow = () => live.stopRequested || (live.ctrl && live.ctrl.signal && live.ctrl.signal.aborted);
      if (stoppingNow()) return send(res, json({ ok: false, error: '工作流正在停止,无法再加入新任务' }, 409));
      let cwd = '', roleLib = new Map(), cfgRef = null;
      try { cfgRef = await readConfig(); const sess = await loadSession(sessionId); cwd = normalizeCwd(sess && sess.cwd, cfgRef.defaultWorkspace); roleLib = new Map((await getAgentRoleLibrary(cwd, cfgRef)).map(r => [r.id, r])); } catch { /* 角色库不可用则以空库物化(无角色节点仍可执行) */ }
      // 团队模式 v2 (P1 TOCTOU): 上面连续 await(readConfig/loadSession/getAgentRoleLibrary)后、物化前同步复检——
      // 入口校验(!live/closing、item.status==='proposed')与物化之间隔着这些 await,期间调度循环可能已推进:
      //  (a) 宽限窗到期 → 收尾原子置 closing 并 finalize(run 已记终态),此时物化只会追加一个永远 queued 的孤儿节点;
      //  (b) 并发的 pool_reject(其检查到落地无 await)已把本 item 置 rejected,恢复后照物化 = 执行已被拒的任务。
      // 复检 activeAgentRuns.get(runId)/closing/item.status;此复检 → materializePoolItem → 置 materialized 全程无
      // await,与调度循环收尾段(runtime.closing=true 起同步执行到首个 await)互斥,原子成立。
      if (activeAgentRuns.get(runId) !== live || live.closing || stoppingNow()) return send(res, json({ ok: false, error: '运行已结束或正在停止;可在新运行中执行该任务' }, 409));
      if (!item || item.status !== 'proposed') return send(res, json({ ok: false, error: `该提案已处理(${item && item.status || 'unknown'})` }, 409));
      const mat = materializePoolItem(live.run, item, { roleLibrary: roleLib, cwd, config: cfgRef });
      if (!mat.ok) return send(res, json({ ok: false, error: mat.error || '物化失败' }, 409));
      item.status = 'materialized'; item.decidedBy = 'user'; item.decidedAt = nowIso(); item.resultNodeId = mat.node.id;
      bumpRunIntervention(live.run, 'pool_approve'); // 29c
      appendAgentRunEvent(live.run, { type: 'run_pool', data: { action: 'materialized', poolId, by: 'user', nodeId: mat.node.id } }); // 29a
      // 团队模式 v2 (P2-1 重新武装): 物化成功 → 允许宽限窗再武装一次。窗只在有新节点物化后才能重开,而物化必消耗一条
      // proposed(POOL_MAX_TOTAL=8 天然封顶总提案),故续窗次数 ≤ 物化次数 ≤ 8,不会无限续窗。
      try { live.poolGraceArmed = true; } catch {}
      // 若正处宽限窗,唤醒调度循环(其 200ms poll 也会自然发现新 queued 节点;这里加速 paused 情况的唤醒)。
      if (live.inPoolGrace && Array.isArray(live.resumeWaiters)) { const waiters = live.resumeWaiters.splice(0); for (const wake of waiters) wake(); }
      await saveAgentRun(live.run);
      return send(res, json({ ok: true, status: 'materialized', poolId, nodeId: mat.node.id }));
    }
    return send(res, json({ ok: false, error: 'unknown action' }, 400));
  }
  if (req.method === 'DELETE' && pathname.startsWith('/api/agent-runs/')) {
    const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));
    const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
    if (!sessionId || !runId) return send(res, json({ ok: false, error: 'sessionId/runId required' }, 400));
    if (activeAgentRuns.has(runId)) return send(res, json({ ok: false, error: '运行中的工作流不能删除' }, 409));
    try {
      const file = agentRunFile(sessionId, runId);
      const run = safeJsonParse(await fsp.readFile(file, 'utf8'), null);
      for (const node of (run && run.nodes || [])) if (node.isolation) await cleanupAgentWorktree(node.isolation);
      await fsp.unlink(file);
      // 对抗轮修(第25波): 删除快照必须连带删姊妹事件日志 —— 用户删「运行记录」的心智模型是数据消失,
      // 取证 ndjson(含时间线/错误切片)不该在删除后无限期残留。
      await fsp.unlink(agentRunEventsFile(sessionId, runId)).catch(() => {});
      await fsp.unlink(agentRunEventsFile(sessionId, runId) + '.gz').catch(() => {}); // v1.9 数据管家: 归档压缩变体一并删
    } catch { return send(res, json({ ok: false, error: 'agent run not found' }, 404)); }
    return send(res, json({ ok: true }));
  }
  if (req.method === 'GET' && pathname.startsWith('/api/agent-runs/')) {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId'));
    const runId = safeSessionId(pathname.slice('/api/agent-runs/'.length));
    if (!sessionId || !runId) return send(res, apiFailure('agent_run.id_required', {}, 'sessionId/runId required', 400));
    // 第29波(§29a): live run 以【内存】对象下发 —— 增量客户端在 settle 类事件后靠本端点刷新单 run 状态,
    // 磁盘快照节流 1.5s 恒旧,读盘会让客户端 lastSeq 与状态错位(拿旧状态配新 seq)。JSON.stringify 同步
    // 执行,事件循环内原子,无撕裂读。归属校验与 POST action 的 live 分支同源(sessionId 不符 = 404)。
    const liveOne = activeAgentRuns.get(runId);
    if (liveOne && liveOne.run) {
      if (liveOne.run.sessionId !== sessionId) return send(res, json({ ok: false, error: 'agent run not found' }, 404));
      return send(res, json({ ok: true, run: { ...liveOne.run, live: true, paused: !!liveOne.paused } }));
    }
    try {
      const run = safeJsonParse(await fsp.readFile(agentRunFile(sessionId, runId), 'utf8'), null);
      if (!run) throw new Error('invalid run');
      return send(res, json({ ok: true, run }));
    } catch { return send(res, json({ ok: false, error: 'agent run not found' }, 404)); }
  }
  if (req.method === 'GET' && pathname === '/api/checkpoints') {
    // F2 (安全·泄露面): this GET exposes the file-change history. It is a GET, so it never runs through the
    // mutating auth block above — the token gate MUST be applied here in the handler. The UI's api() always
    // sends the token, so it is unaffected; only tokenless local processes are refused.
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const sessionId = safeSessionId(new URL(req.url, 'http://x').searchParams.get('sessionId')); // F4
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const entries = await journalReadIndex(sessionId);
    // v1.4.1: 附上每条目当前磁盘大小(改动后状态),前端可显示「原 X → 现 Y」的大小变化 + 判定是否值得看 diff。
    const enriched = await Promise.all(entries.map(async e => {
      let currentBytes = null;
      if (e && e.path) { try { const st = await fsp.stat(e.path); currentBytes = st.isFile() ? st.size : null; } catch { currentBytes = null; } }
      return { ...e, currentBytes };
    }));
    const totalBytes = entries.reduce((s, e) => s + (Number(e.bytes) || 0), 0);
    return send(res, json({ ok: true, entries: enriched, totalBytes }));
  }
  // v1.4.1: 单条变更的「改动前↔现在」对比。GET /api/checkpoints/diff?sessionId=&turnSeq=&entrySeq=
  // before = 本地 .gz 快照(create 无);after = 当前磁盘文件(delete 无)。文本文件返回内容(前端渲染 diff),
  // 二进制/过大只返回字节数。token-gated(GET 不走上面的变更类鉴权块,此处显式校验)。path 取自我方 journal
  // 索引(非用户输入,零穿越面);内容为工作台自身写过的文件,不新增暴露面(是 /api/file/preview 的严格子集)。
  if (req.method === 'GET' && pathname === '/api/checkpoints/diff') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const q = new URL(req.url, 'http://x').searchParams;
    const sessionId = safeSessionId(q.get('sessionId'));
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    const turnSeq = Number(q.get('turnSeq')), entrySeq = Number(q.get('entrySeq'));
    if (!Number.isInteger(turnSeq) || !Number.isInteger(entrySeq) || turnSeq < 0 || entrySeq < 0) {
      return send(res, apiFailure('checkpoint.reference_invalid', {}, 'invalid turnSeq or entrySeq', 400));
    }
    const idx = await journalReadIndex(sessionId);
    const entry = idx.find(e => e && Number(e.turnSeq) === turnSeq && Number(e.entrySeq) === entrySeq);
    if (!entry) return send(res, apiFailure('checkpoint.not_found', {}, 'entry not found', 404));
    const p = String(entry.path || '');
    const ext = String(path.extname(p).replace(/^\./, '')).toLowerCase();
    const DIFF_TEXT_MAX = 256 * 1024; // 单侧文本上限;超限只给大小
    const textish = PREVIEW_TEXT_EXTS.has(ext) || ext === '' || ext === 'log';
    let beforeBuf = null, afterBuf = null;
    if (entry.op !== 'create' && !entry.skipped) {
      try { beforeBuf = zlib.gunzipSync(await fsp.readFile(path.join(journalDir(sessionId), `${turnSeq}-${entrySeq}.gz`))); } catch { beforeBuf = null; }
    }
    if (entry.op !== 'delete') { try { afterBuf = await fsp.readFile(p); } catch { afterBuf = null; } }
    const looksBinary = b => !!b && b.slice(0, 8192).includes(0);
    const tooBig = b => !!b && b.length > DIFF_TEXT_MAX;
    const out = { ok: true, op: entry.op, path: p, skipped: !!entry.skipped,
      beforeBytes: beforeBuf ? beforeBuf.length : (entry.op === 'create' ? 0 : (Number(entry.bytes) || null)),
      afterBytes: afterBuf ? afterBuf.length : (entry.op === 'delete' ? 0 : (Number(entry.currentBytes) || null)) };
    if (textish && !looksBinary(beforeBuf) && !looksBinary(afterBuf) && !tooBig(beforeBuf) && !tooBig(afterBuf)) {
      out.isText = true;
      out.before = beforeBuf ? beforeBuf.toString('utf8') : '';
      out.after = afterBuf ? afterBuf.toString('utf8') : '';
    } else {
      out.isText = false; out.binary = true;
    }
    return send(res, json(out));
  }
  // v0.9-S4 (C4): local file PREVIEW. GET /api/file/preview?path=&sessionId= — returns file content for the
  // 「产物」gallery + file tree. Token-gated (needsToken whitelist above) AND re-checked here (GETs never run
  // through the mutating auth block). SECOND闸: `path` must be absolute and resolve INSIDE one of the session's
  // allowed roots (cwd ∪ defaultWorkspace ∪ recentWorkspaces ∪ dataRoot) — else 403. This prevents a
  // token-holding page from reading arbitrary files (C:\Windows\win.ini etc.). See fileAllowedRoots.
  if (req.method === 'GET' && pathname === '/api/file/preview') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const q = new URL(req.url, 'http://x').searchParams;
    const rawPath = q.get('path') || '';
    if (!rawPath) return send(res, apiFailure('file.path_required', {}, 'path is required', 400));
    if (!path.isAbsolute(rawPath)) return send(res, apiFailure('file.path_not_absolute', {}, 'path must be absolute', 400));
    const target = path.resolve(rawPath);
    const sessionId = safeSessionId(q.get('sessionId')); // may be null (session-less preview still allowed if in a global root)
    const session = sessionId ? await loadSession(sessionId) : null;
    const config = await readConfig();
    const roots = fileAllowedRoots(session, config);
    // v0.9 F3: check the REALPATH (symlink-resolved) target, not the lexical path. A symlink living inside an
    // allowed root but pointing OUTSIDE it would otherwise pass the lexical containment check and leak an
    // arbitrary file. ENOENT/EPERM (missing/unresolvable) → fall back to `target` so readFilePreview surfaces a
    // normal "not found". Resolve the roots too so a root that is itself a symlink still matches.
    const real = await fsp.realpath(target).catch(() => target);
    // 审计 P1(对抗轮补漏): preview 端点原来只做 fileAllowedRoots+realpath 包含校验,不查敏感表 —— 「file_read
    // runtime.json 拿 token → 用 token 打 preview 读 config.json」的链由此成立。这里与文件工具同源拒绝敏感控制面文件。
    await ensureDataRootReal();
    if (isSensitiveDataPath(target) || isSensitiveDataPath(real)) {
      return send(res, json({ ok: false, error: '该路径属于应用内部数据(配置/会话/记忆等),已禁止预览' }, 403));
    }
    const realRoots = await Promise.all(roots.map(r => fsp.realpath(r).catch(() => r)));
    if (!pathWithinAnyRoot(real, realRoots)) {
      // 防任意文件读取:第二道闸(GET-token 之外)。不在任何允许根下 → 403。
      return send(res, json({ ok: false, error: 'path not in an allowed workspace' }, 403));
    }
    try {
      return send(res, json(await readFilePreview(target)));
    } catch (e) {
      return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
    }
  }
  // v1.0.2-S3: 在资源管理器中打开/定位文件。POST /api/file/reveal {sessionId, path, mode:'open'|'select'}.
  // 安全命门:path 经 fs.realpath 解析后须位于该 session 工作区(cwd)或 dataRoot 下(guardWorkspacePath —
  // 与 /api/file/preview 同一护栏), 文件必须存在。执行绝不走 shell(命令注入面), 用 cp.spawn('explorer.exe',…,
  // {detached, stdio:'ignore'}).unref()。非 win32 → {ok:false,error:'仅支持 Windows'}。token 白名单已加。
  if (req.method === 'POST' && pathname === '/api/file/reveal') {
    if (process.platform !== 'win32') return send(res, json({ ok: false, error: '仅支持 Windows' }));
    const body = await readJsonBody(req);
    const mode = (body && body.mode === 'select') ? 'select' : 'open';
    const rawPath = body && typeof body.path === 'string' ? body.path : '';
    const sessionId = safeSessionId(body && body.sessionId);
    const session = sessionId ? await loadSession(sessionId) : null;
    const config = await readConfig();
    const guard = await guardWorkspacePath(rawPath, session, config);
    if (!guard.ok) return send(res, json({ ok: false, error: guard.error }, guard.code === 'bad-path' ? 400 : 403));
    // 文件必须存在(realpath 已解析符号链接;此处确认目标本身在盘上)。
    let stat = null;
    try { stat = await fsp.stat(guard.absPath); } catch { /* missing */ }
    if (!stat) return send(res, json({ ok: false, error: '文件不存在' }, 404));
    // buildRevealSpawn 仍是「模式决策」的权威:决定 open vs select + 对可执行/脚本扩展名把 open 降级为 select。
    // 但【执行】改走 revealInExplorer(前台助手),不再直接 spawn explorer(后台服务直接 spawn 会开在浏览器后面)。
    const spawnSpec = buildRevealSpawn(mode, guard.absPath);
    const okStarted = revealInExplorer(guard.absPath, spawnSpec.mode);
    if (!okStarted) return send(res, json({ ok: false, error: '无法打开资源管理器(系统未提供 PowerShell/Explorer)' }));
    logEvent({ kind: 'file_reveal', sessionId: sessionId || '', mode: spawnSpec.mode, degraded: !!spawnSpec.degraded, pathLen: guard.absPath.length });
    // 把关加固:可执行/脚本类「打开」被降级为「定位」时明确告知前端(前端可提示用户)。
    return send(res, json(spawnSpec.degraded
      ? { ok: true, degradedTo: 'select', note: '出于安全考虑,可执行/脚本文件不会直接打开,已改为在资源管理器中定位。' }
      : { ok: true }));
  }
  // v1.0.2-S5: 从文件夹导入外部 MCP。POST /api/mcp/import-folder {path}(用户经 /api/pick-folder 选好的绝对
  // 路径)。读该文件夹下 ruyi-mcp.json 清单(≤32KB), 经 sanitizeExternalMcpServer 清洗, 尊重 externalMcpServers
  // ≤10 上限, id 已存在则更新该条(否则追加), 持久化 config(writeConfig 原子写)并再生成 generateMcpConfig。
  // token 白名单已加; 审计 action 'mcp_import'; 响应附 server(env 值掩码防泄漏)。
  if (req.method === 'POST' && pathname === '/api/mcp/import-folder') {
    const body = await readJsonBody(req);
    const folder = body && typeof body.path === 'string' ? body.path.trim() : '';
    if (!folder || !path.isAbsolute(folder)) return send(res, json({ ok: false, error: '请提供文件夹的绝对路径' }, 400));
    const MANIFEST_TEMPLATE = { id: 'my-mcp', label: '我的 MCP 服务', command: './server.exe', args: [], env: {}, cwd: '', enabled: true };
    // 读清单(≤32KB)。缺失/超限/解析失败 → 统一「缺少有效清单」+ template(前端可据此提示用户如何写)。
    const manifestPath = path.join(folder, 'ruyi-mcp.json');
    let raw = null;
    try {
      const st = await fsp.stat(manifestPath);
      if (!st.isFile() || st.size > 32 * 1024) throw new Error('manifest too large or not a file');
      raw = safeJsonParse(await fsp.readFile(manifestPath, 'utf8'), null);
    } catch { raw = null; }
    if (!raw || typeof raw !== 'object') {
      return send(res, json({ ok: false, error: '该文件夹缺少有效的 ruyi-mcp.json 清单', template: MANIFEST_TEMPLATE }));
    }
    // cwd 缺省 = 该文件夹本身(相对 command 如 ./server.exe 由 cwd 保证; args 里的相对路径不改写)。
    const withCwd = { ...raw, cwd: (typeof raw.cwd === 'string' && raw.cwd.trim()) ? raw.cwd : folder };
    const cleaned = sanitizeExternalMcpServer(withCwd);
    if (!cleaned) return send(res, json({ ok: false, error: '清单无效:至少需要 id 与 command 两个字段', template: MANIFEST_TEMPLATE }));
    const config = await readConfig();
    const list = Array.isArray(config.externalMcpServers) ? config.externalMcpServers.slice() : [];
    const existingIdx = list.findIndex(s => s && s.id === cleaned.id);
    let updated = false;
    if (existingIdx >= 0) { list[existingIdx] = cleaned; updated = true; }
    else {
      if (list.length >= 10) return send(res, json({ ok: false, error: '外部 MCP 数量已达上限(最多 10 个),请先移除一个再导入' }));
      list.push(cleaned);
    }
    const next = await writeConfig({ ...config, externalMcpServers: list });
    await generateMcpConfig(next.mcpCommandMode).catch(() => {}); // 再生成 .mcp.json(缺失时不阻断导入)
    logEvent({ kind: 'mcp_import', id: cleaned.id, updated, source: folder });
    // 响应附清洗后的条目, env 值掩码(参考 apiKey 掩码模式, 防泄漏 token 类环境变量)。
    const maskedEnv = {};
    for (const [k, v] of Object.entries(cleaned.env || {})) maskedEnv[k] = maskKey(String(v));
    const serverEcho = { ...cleaned, env: maskedEnv };
    return send(res, json({ ok: true, ...(updated ? { updated: true } : { added: true }), server: serverEcho }));
  }
  // v0.9-S8 (§4 B4): 审计中心 — merged read-only timeline of workbench NDJSON logs + desktop MCP audit_tail.
  // GET /api/audit?limit=&source=&type= . This is a GET, so it NEVER runs through the mutating auth block;
  // the token gate MUST be applied HERE in the handler (the S0 lesson — same as /api/checkpoints & preview).
  // Paths & commands live in these records, so it is token-gated at the checkpoints sensitivity level.
  if (req.method === 'GET' && pathname === '/api/audit') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const q = new URL(req.url, 'http://x').searchParams;
    const limit = q.get('limit'); // collectAudit clamps to 1..500 (default 100)
    const sourceRaw = q.get('source');
    const sourceFilter = (sourceRaw === 'workbench' || sourceRaw === 'desktop') ? sourceRaw : null;
    const typeFilter = (q.get('type') || '').trim() || null;
    const config = await readConfig();
    try {
      return send(res, json(await collectAudit(config, { limit, sourceFilter, typeFilter })));
    } catch (e) {
      return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
    }
  }
  // v1.9 数据管家: 存储管理(专家界面「存储」页签)。GET 在 handler 内自查 token(同 /api/audit 纵深纪律);
  // 两个 POST 由 ROUTE_AUTH 表的 token 级把门。清理全部 best-effort,慢盘/失败不 500(sweep 内部全静默,
  // 只有 stats 聚合异常才落 500)。
  if (req.method === 'GET' && pathname === '/api/storage/summary') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const config = await readConfig();
    try {
      const stats = await collectStorageStats(config);
      await maybeRecordStorageTrend(stats); // 第40波:summary 与 metrics 共用趋势追点(≥1h 节流)
      return send(res, json(stats));
    } catch (e) {
      return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
    }
  }
  // 第40波:性能观测面(只读;请求耗时环形 + 进程/子进程内存 + 存储趋势)。
  if (req.method === 'GET' && pathname === '/api/metrics') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const config = await readConfig();
    try {
      return send(res, json(await buildMetricsPayload(config)));
    } catch (e) {
      return send(res, json({ ok: false, error: String(e && e.message || e) }, 500));
    }
  }
  if (req.method === 'POST' && pathname === '/api/storage/policy') {
    const body = await readJsonBody(req);
    const src = (body && typeof body === 'object')
      ? (body.storagePolicy && typeof body.storagePolicy === 'object' ? body.storagePolicy : body)
      : {};
    const config = await readConfig();
    config.storagePolicy = { ...(config.storagePolicy || {}), ...src };
    const saved = await writeConfig(config);
    return send(res, json({ ok: true, policy: normalizeStoragePolicy(saved.storagePolicy) }));
  }
  if (req.method === 'POST' && pathname === '/api/storage/clean') {
    const body = await readJsonBody(req);
    const VALID = new Set(['logs', 'agent-runs', 'webcache', 'engine-transcripts']);
    let targets = null; // null = 全部
    if (body && body.target && body.target !== 'all') {
      const t = String(body.target);
      if (!VALID.has(t)) return send(res, json({ ok: false, error: 'unknown target' }, 400));
      targets = new Set([t]);
    }
    const config = await readConfig();
    return send(res, json(await storageSweep(config.storagePolicy, targets)));
  }
  // v0.8-S4a: checkpoint rollback (mutating; header-token — see needsToken whitelist above). entrySeq given
  // = single-entry rollback; omitted = whole turn (all entries for turnSeq, reverse order). Idempotent:
  // reverted entries are removed from the index, so re-rolling the same turn → {ok:false,error:'no entries'}.
  if (req.method === 'POST' && pathname === '/api/checkpoints/rollback') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId); // F4: consume only well-formed ids
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    if (body.turnSeq === undefined || body.turnSeq === null) return send(res, json({ ok: false, error: 'turnSeq is required' }, 400));
    // F1: refuse rollback while a turn is live for this session — same guard/wording as /api/session/rewind.
    // The three index.json writers (journalRecord / journalGc / journalRollback) all do an unlocked
    // read-modify-write; letting rollback through during an active turn races those writers and can drop
    // an update (lost-write on the shared index). rewindSession has this guard internally; the direct
    // rollback route did not, so add it here BEFORE calling journalRollback.
    if (activeChildren.has(sessionId)) return send(res, json({ ok: false, error: '回合进行中,请先停止' }, 409));
    return send(res, json(await journalRollback(sessionId, body.turnSeq, body.entrySeq)));
  }
  // v0.8-S4b: conversation REWIND (mutating; header-token — see needsToken whitelist above). Truncates the
  // session to just before `targetTurnSeq`, clears providerHistory (lazy-reseed rebuilds it), optionally
  // rolls back the discarded turns' files. Returns {ok, removedTurns, lastUserText, filesReverted, filesFailed}.
  if (req.method === 'POST' && pathname === '/api/session/rewind') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId); // F4
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    if (body.targetTurnSeq === undefined || body.targetTurnSeq === null) return send(res, apiFailure('request.field_required', { field: 'targetTurnSeq' }, 'targetTurnSeq is required', 400));
    return send(res, json(await rewindSession(sessionId, body.targetTurnSeq, !!body.rollbackFiles)));
  }
  // v0.8-S7: mid-turn STEERING (§4 A3). UI-only, header-token (needsToken whitelist above). Enqueues plain
  // user text onto the LIVE provider turn's steerQueue; the tool loop drains it at the next boundary (see
  // drainSteerQueue). Rejects (never crashes) when: no live turn / the live turn is the Claude engine (its
  // tools run in a transient MCP child — stdin steering is out of this slice) / the queue is full (cap 3).
  if (req.method === 'POST' && pathname === '/api/steer') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body.sessionId); // F4
    const text = String(body.text || '').trim().slice(0, 2000); // 与 steer_node 的单条插话长度上限对齐
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    if (!text) return send(res, apiFailure('request.field_required', { field: 'text' }, 'text is required', 400));
    const reg = activeChildren.get(sessionId);
    if (!reg) return send(res, json({ ok: false, error: '当前没有进行中的回合' }));
    if (reg.kind !== 'openai') return send(res, json({ ok: false, error: '仅 provider 引擎支持插话' }));
    if (!Array.isArray(reg.steerQueue)) reg.steerQueue = [];
    if (reg.steerQueue.length >= STEER_QUEUE_MAX) return send(res, json({ ok: false, error: '插话队列已满' }));
    reg.steerQueue.push(text);
    logEvent({ kind: 'intervention', source: 'steer', sessionId }); // 29c
    return send(res, json({ ok: true, queued: reg.steerQueue.length }));
  }
  if (req.method === 'POST' && pathname === '/api/upload') {
    const body = await readJsonBody(req);
    const file = await makeAttachmentRecord(body);
    return send(res, json({ ok: true, file }));
  }
  if (req.method === 'POST' && pathname === '/api/chat/stream') {
    return streamChat(req, res);
  }
  if (req.method === 'POST' && pathname.startsWith('/api/tools/')) {
    const body = await readJsonBody(req);
    const name = pathname.split('/').pop();
    // v0.8-S4a: a direct tool call may carry `sessionId` (and optionally `turnSeq`) so file mutations
    // checkpoint under that session. With sessionId only, turnSeq is read from the session file; an explicit
    // turnSeq pins the entry to a specific turn (used by e2e to exercise cross-turn rollback). Absent →
    // journalSessionCtx resolves to no context and journaling silently no-ops. Extra keys are ignored by the file tools.
    const ctx = body && body.sessionId ? { sessionId: String(body.sessionId), ...(Number.isFinite(Number(body.turnSeq)) && body.turnSeq !== '' && body.turnSeq != null ? { turnSeq: Number(body.turnSeq) } : {}) } : null;
    // v1.1-W2 (T1): thread session+config into ctx so http_download can guard its dest against the session's
    // allowed workspace roots (guardDownloadDest → guardWorkspacePath). Best-effort; a load failure just falls
    // back to guardDownloadDest's degraded (dataRoot/cwd) guard, never blocking the other tools.
    if (ctx) {
      try {
        ctx.config = await readConfig();
        const s = await loadSession(ctx.sessionId).catch(() => null);
        if (s) ctx.session = s;
      } catch { /* degrade gracefully */ }
    }
    return send(res, json({ ok: true, result: await toolCall(name, body, ctx) }));
  }
  return send(res, apiFailure('api.route_not_found', {}, 'Not found', 404));
}

// --- startup port fallback: if the port is held by a STALE workbench, free it and retry ---
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// PIDs LISTENING on `port` (any local interface). Parses `netstat -ano`. Returns [] on any error.
function pidsOnPort(port) {
  return new Promise(resolve => {
    cp.execFile('netstat', ['-ano'], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const suffix = ':' + port;
      const pids = new Set();
      for (const line of stdout.split(/\r?\n/)) {
        if (!/\bLISTENING\b/i.test(line)) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        if (!String(parts[1]).endsWith(suffix)) continue; // local address column ends with :port
        const pid = parseInt(parts[parts.length - 1], 10);
        if (Number.isInteger(pid) && pid > 0) pids.add(pid);
      }
      resolve([...pids]);
    });
  });
}
function processImage(pid) {
  return new Promise(resolve => {
    cp.execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const m = !err && stdout ? /^"([^"]+)"/.exec(stdout.trim()) : null;
      resolve(m ? m[1] : '');
    });
  });
}
// 第36波(v1.7): 命令行取证 —— node.exe 镜像名单独不足以证明"这是我们的 stale workbench"(见 freeStalePort
// 的 image:node 分支)。返回 CommandLine+ExecutablePath 的小写合并串供证据匹配,拿不到返回 ''。pid 是 netstat
// 解析出的整数,execFile 直调无 shell,无注入面;CIM 首次查询较慢,给 8s。
function processCommandLine(pid) {
  return new Promise(resolve => {
    const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CommandLine; $p.ExecutablePath }`;
    cp.execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-Command', ps], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err || !stdout ? '' : String(stdout).toLowerCase());
    });
  });
}
function killPid(pid) {
  return new Promise(resolve => {
    cp.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve());
  });
}
function probeHealth(port, host) {
  return new Promise(resolve => {
    const req = http.get({ host, port, path: '/health', timeout: 900 }, res => {
      let body = '';
      res.on('data', c => { body += c; if (body.length > 65536) req.destroy(); });
      res.on('end', () => resolve(safeJsonParse(body, null)));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
// Kill the port's holder(s) ONLY when confirmed to be a stale workbench: /health responds like one,
// OR the PID matches our own runtime.json, OR the image is node/Ruyi/WinClaudeWorkbench. An unrelated
// service is left alone (returns {ok:false, blocked}) so we never clobber someone else's app.
async function freeStalePort(port, host) {
  const pids = await pidsOnPort(port);
  if (!pids.length) return { ok: true, killed: [] }; // maybe TIME_WAIT with no live listener — retry handles it
  const health = await probeHealth(port, host);
  const isWorkbench = !!(health && (health.app === APP_NAME || health.overlayId || health.version));
  let ourPid = null;
  try {
    const rt = safeJsonParse(await fsp.readFile(path.join(paths.data, 'runtime.json'), 'utf8'), null);
    if (rt && Number.isInteger(rt.pid)) ourPid = rt.pid;
  } catch { /* no prior runtime.json */ }
  const killed = [];
  for (const pid of pids) {
    if (pid === process.pid) continue; // never kill self
    let why = null;
    if (isWorkbench) why = 'health';
    else if (pid === ourPid) why = 'runtime.json';
    else {
      const img = await processImage(pid);
      if (/Ruyi|WinClaudeWorkbench/i.test(img)) why = 'image:' + img; // v1.0-S9 exe 改名 Ruyi.exe;双名兼容(旧构建/存量进程仍可能名 WinClaudeWorkbench)
      else if (/^node(\.exe)?$/i.test(img)) {
        // 第36波(v1.7): node.exe 镜像名【不是】充分的处死证据 —— 占着同一端口的可能是任何人的 node 服务,旧
        // image:node 分支直接 taskkill,与本函数头注 "never clobber someone else's app" 的契约矛盾。补命令行
        // 取证:命令行指向【本应用的 server.js 全路径】(源码/overlay 形态),或 server.js 与 Ruyi/WinClaudeWorkbench
        // 命名的发行目录同现(打包 runtime\node 形态 —— Start-Workbench.cmd 以相对路径 "app\server.js" 启动,
        // 靠 ExecutablePath 里的发行目录名佐证)。证据不足一律 blocked(安全方向),报错请用户手动处理。
        const evidence = await processCommandLine(pid);
        const ourServer = path.join(__dirname, 'server.js').toLowerCase();
        const isOurs = evidence.includes(ourServer)
          || (/server\.js/.test(evidence) && /ruyi|winclaudeworkbench/.test(evidence));
        if (isOurs) why = 'image:node+cmdline';
        else return { ok: false, blocked: { pid, image: img || '(unknown)' } };
      }
      else return { ok: false, blocked: { pid, image: img || '(unknown)' } };
    }
    await killPid(pid);
    killed.push({ pid, why });
    console.log(`[port] :${port} held by stale workbench — killed PID ${pid} (${why})`);
  }
  return { ok: true, killed };
}
// Listen; on EADDRINUSE, free a stale workbench (if allowed + safe) and retry a few times.
async function listenWithFallback(server, port, host, config) {
  const attempt = () => new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
  try { return await attempt(); }
  catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const envDisabled = /^(0|false|off|no)$/i.test(String(process.env.WCW_KILL_PORT || ''));
    if (envDisabled || config.killPortOnStart === false) {
      throw new Error(`端口 ${port} 已被占用，且已禁用自动接管（killPortOnStart=false / WCW_KILL_PORT=0）。请换端口：--port <其它端口>。`);
    }
    console.log(`[port] :${port} in use — checking whether it's a stale workbench…`);
    const res = await freeStalePort(port, host);
    if (!res.ok) {
      throw new Error(`端口 ${port} 被非工作台进程占用（PID ${res.blocked.pid} / ${res.blocked.image}），已避免误杀。请换端口（--port）或手动结束该进程。`);
    }
    for (let i = 0; i < 25; i++) {
      await sleep(160);
      try {
        await attempt();
        if (res.killed.length) console.log(`[port] reclaimed :${port} (freed ${res.killed.length} stale process(es)).`);
        return;
      } catch (e2) { if (e2.code !== 'EADDRINUSE') throw e2; }
    }
    throw new Error(`端口 ${port} 结束占用进程后仍无法监听（已结束 ${res.killed.length} 个）。`);
  }
}

async function startServer(opts) {
  await ensureDirs();
  await markInterruptedAgentRuns();
  // 第29波(§29b): boot 自动恢复分级(opt-in,默认 false=零行为变化)。放在诚实标死【之后】、fire-and-forget:
  // 恢复失败/慢盘绝不阻塞 boot;真正的续跑在 runAgentWorkflow 内自走调度环。
  void autoResumeInterruptedRuns().catch(() => {});
  // PF2 fix: a hard crash (SIGKILL / power loss, where no exit handler ran to flush) can leave sessions/index.json
  // stale while its id-set still MATCHES the session files on disk — listSessions' fast path would then trust that
  // stale index FOREVER (renames / pins / messageCounts / summaries never re-surface until some OTHER session is
  // added or removed). Invalidate once at boot so the first listSessions rebuilds from the authoritative session
  // files. One full scan, boot-only (the pre-PF2 behavior); every read after that uses the incremental index.
  await invalidateSessionIndex();
  LAUNCH_MODE = isPkg() ? 'exe' : 'node';
  const config = await readConfig();
  // v1.4.3: sync settings, agent roles, and MCP servers to Claude CLI's own config on startup
  await syncClaudeCliSettings(config);
  await syncAgentRolesToClaude(config.defaultWorkspace || os.homedir(), config);
  await syncMcpServersToClaude(config);
  // v1.9 数据管家: boot sweep(fire-and-forget —— 慢盘/清理失败绝不阻塞 boot;结果落审计账 storage_sweep)。
  void storageSweep(config.storagePolicy).catch(() => {});
  const port = Number(opts.port || process.env.PORT || DEFAULT_PORT);
  const host = opts.host || '127.0.0.1';
  const server = http.createServer(async (req, res) => {
    const reqT0 = Date.now(); // 第40波:请求耗时插桩(res finish 时入账,/health 不计 —— 高频探针会淹没真分布)
    res.on('finish', () => { try { const u0 = new URL(req.url, 'http://x'); if (u0.pathname !== '/health') recordRequestMetric(req.method, u0.pathname, Date.now() - reqT0); } catch { /* 观测不阻断 */ } });
    try {
      // 第33波:顶层 host 门(DNS-rebinding 防御覆盖全 GET 面 + 静态 /,治第29波 backlog #0)。hostAllowed 之前
      // 只在 originOk(mutating 块)内调用,GET 与 serveStatic 跳过 -> index.html 的 token 可被 rebinding 页读走。
      // 此处一律拦非 loopback Host;所有合法调用方(e2e/MCP 子/CLI/浏览器)连 127.0.0.1:PORT,Host 已是 loopback。
      if (!hostAllowed(req)) return send(res, json({ ok: false, error: 'host not allowed' }, 403));
      const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      // Liveness + restart proof: version alone can't prove a restart, so echo the per-process overlay id.
      if (u.pathname === '/health') {
        return send(res, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'x-workbench-version': VERSION, 'x-overlay-id': OVERLAY_ID },
          body: JSON.stringify({ ok: true, version: VERSION, overlayId: OVERLAY_ID, launchMode: LAUNCH_MODE, uptimeSec: Math.round(process.uptime()) }) });
      }
      if (u.pathname.startsWith('/api/')) return await handleApi(req, res, u.pathname);
      return send(res, await serveStatic(u.pathname));
    } catch (err) {
      return sendError(res, err);
    }
  });
  await listenWithFallback(server, port, host, config);
  const url = `http://${host}:${port}/`;
  // Port+token handshake file for the permission-bridge MCP child; also useful for tooling.
  const runtimeToken = crypto.randomBytes(16).toString('hex');
  RUNTIME.port = port; RUNTIME.host = host; RUNTIME.token = runtimeToken;
  await fsp.writeFile(path.join(paths.data, 'runtime.json'),
    JSON.stringify({ port, host, pid: process.pid, token: runtimeToken, overlayId: OVERLAY_ID, version: VERSION, launchMode: LAUNCH_MODE, startedAt: nowIso() }, null, 2), 'utf8').catch(() => {});
  console.log(`${APP_NAME} ${VERSION}  (launch: ${LAUNCH_MODE}, overlay ${OVERLAY_ID})`);
  console.log(`UI: ${url}`);
  console.log(`Data: ${paths.data}`);
  console.log(`Server source: ${externalServerJs() || '(baked exe)'}`);
  console.log(`MCP config: ${await generateMcpConfig(config.mcpCommandMode)}`);
  logEvent({ kind: 'server_start', port, launchMode: LAUNCH_MODE, version: VERSION });
  // v0.7d: reap any bridged desktop/external MCP children on shutdown so they aren't orphaned.
  let cleanedUp = false;
  const cleanupMcp = () => { if (cleanedUp) return; cleanedUp = true; try { killAllMcpClients(); } catch { /* ignore */ } try { killAllShellSessions(); } catch { /* ignore */ } };
  // PF2 fix: flush the pending session-index batch synchronously on the way out. 'exit' runs for a normal exit,
  // for the SIGINT/SIGTERM handlers below (they call process.exit), and for the uncaughtException handler — so a
  // single registration here covers every graceful termination path.
  process.on('exit', () => { try { flushSessionIndexSync(); } catch { /* ignore */ } cleanupMcp(); });
  process.once('SIGINT', () => { cleanupMcp(); process.exit(0); });
  process.once('SIGTERM', () => { cleanupMcp(); process.exit(0); });
  // v1.4.6-S5: top-level crash safety net (serve mode only — registered here, not at module load, so a
  // require()'d unit test keeps Node's default handling). Before this, an uncaught exception left no journal
  // trace and an unhandled rejection could die silently. Policy: a stray REJECTION is logged and the process
  // CONTINUES (one orphaned promise must not kill a live turn); an uncaught EXCEPTION is logged, then we run
  // the existing MCP/shell cleanup and exit(1) — a process in an unknown state is not safe to keep serving.
  // No auto-restart loop (a supervisor / the user restarts) — avoids a crash-loop that hammers the machine.
  process.on('unhandledRejection', (reason) => {
    try { logEvent({ kind: 'unhandled_rejection', error: (reason && reason.stack) || (reason && reason.message) || String(reason) }); } catch { /* logging must never re-throw */ }
    try { console.error('unhandledRejection:', (reason && reason.stack) || reason); } catch { /* ignore */ }
  });
  process.on('uncaughtException', (err) => {
    try { logEvent({ kind: 'uncaught_exception', error: (err && err.stack) || (err && err.message) || String(err) }); } catch { /* logging must never re-throw */ }
    try { console.error('uncaughtException (exiting):', (err && err.stack) || err); } catch { /* ignore */ }
    try { cleanupMcp(); } catch { /* ignore */ }
    process.exit(1);
  });
  if (opts.open) {
    cp.spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  }
}

// 第44波(模型列表 API 化):预设只剩「默认 + CLI 内建别名(opus/sonnet/haiku)」——别名由 CLI 自己解析、非版本
// 型号,永不失效;版本化型号(如 claude-opus-4-8)【不再硬编码】,真实清单来自代理 /v1/models 的发现缓存
// (getProxyModelsCache)+ 用户自定义(extraModels/knownModels)。离线兜底见 offlineModelList。
const MODEL_PRESETS = [
  { id: '', label: '默认 (CLI 配置)' },
  { id: 'opus', label: 'Opus (别名·最强)' },
  { id: 'sonnet', label: 'Sonnet (别名·均衡)' },
  { id: 'haiku', label: 'Haiku (别名·最快)' },
];

// 第44波: 代理模型列表 sidecar 缓存(<dataRoot>/proxy-models-cache.json)。发现成功即落盘,供离线启动时的列表
// 兜底 + buildModelHint 的 Claude 组。【不】写进 config.json:GET /api/models 是读路径,把缓存合并进 config 再
// writeConfig 会让陈旧全量快照与用户的 POST /api/config 竞态互踩(25.1 对抗轮教训);sidecar 独占写点、零竞态。
const PROXY_MODELS_CACHE_PATH = () => path.join(paths.data, 'proxy-models-cache.json');
let proxyModelsCacheMemo = null; // null=未读盘;读后为 {at, models:[{id,label}]}(可为空数组)
function getProxyModelsCache() {
  if (proxyModelsCacheMemo === null) {
    proxyModelsCacheMemo = { at: '', models: [] };
    try {
      const j = JSON.parse(fs.readFileSync(PROXY_MODELS_CACHE_PATH(), 'utf8'));
      if (j && Array.isArray(j.models)) {
        proxyModelsCacheMemo = {
          at: String(j.at || ''),
          models: j.models.filter(m => m && m.id).map(m => ({ id: String(m.id), label: String(m.label || m.id) })).slice(0, 50),
        };
      }
    } catch { /* 无缓存文件/坏 JSON → 空缓存 */ }
  }
  return proxyModelsCacheMemo;
}
// 发现成功时调用:归一化 + 去重 + cap 50;内容没变则不写盘(避免每次 /api/models 都动文件)。尽力而为,不抛。
function setProxyModelsCache(models) {
  const seen = new Map();
  for (const m of (Array.isArray(models) ? models : [])) {
    const id = String((m && m.id) || '').trim();
    if (id && !seen.has(id)) seen.set(id, { id, label: String((m && m.label) || id) });
    if (seen.size >= 50) break;
  }
  const next = { at: new Date().toISOString(), models: [...seen.values()] };
  const prev = getProxyModelsCache();
  if (JSON.stringify(prev.models) === JSON.stringify(next.models)) return;
  proxyModelsCacheMemo = next;
  atomicWriteJson(PROXY_MODELS_CACHE_PATH(), next).catch(() => { /* 失败只影响下次离线兜底 */ });
}

// Offline list = 默认+别名预设 ∪ 代理发现缓存 ∪ manual (extraModels: "id" or "id|Label") ∪ remembered (knownModels)
// ∪ the current custom model. Deduped by id; the empty '默认' entry stays first. No network.
function offlineModelList(config) {
  const seen = new Map();
  const add = (id, label) => { const k = String(id ?? ''); if (!seen.has(k)) seen.set(k, { id: k, label: label || (k || '默认 (CLI 配置)') }); };
  for (const m of MODEL_PRESETS) add(m.id, m.label);
  for (const m of getProxyModelsCache().models) add(m.id, m.label); // 第44波: API 发现的版本化型号由此进列表
  for (const raw of (config.extraModels || [])) { const [id, label] = String(raw).split('|'); if (id && id.trim()) add(id.trim(), (label || '').trim() || undefined); }
  for (const id of (config.knownModels || [])) if (id) add(id);
  if (config.model && !seen.has(String(config.model))) add(config.model, config.model + ' (自定义)');
  return [...seen.values()];
}

// ============================================================================
// 第30波(编排按难度选模型):让 AI 编排者(orchestrate_agents/spawn_agent/propose_task)按任务难易【自主】为
// 不同节点选模型。机制其实已在(node.model 优先级链贯通两引擎),补齐:①能力档位提示 buildModelHint(让 AI 知道
// 每个模型强弱,按引擎分组防选错)②'inherit' 归一为空(修 OpenAI 把字面量当模型发失败)③toolTier 兜底(opt-in)。
// 对抗轮教训(改这块务必记牢):
//  - 【不】在通用写入点对 node.model 做白名单丢弃 —— 人工在编辑器/模板里填的 live 发现但未进 knownModels 的真实
//    模型会被误杀(回归);显式 model 一律尊重原样,幻觉靠【引擎分组的 hint 强引导】规避,填错则节点可见失败(errorClass)。
//  - buildModelHint / tier 兜底必须【引擎感知】:offlineModelList 混着 Claude 预设别名(opus/sonnet/haiku)与 provider
//    模型,给 openai 节点选 Claude 别名必失败。故 hint 按引擎分组、tier 池排除预设别名。
//  - 'inherit' 两引擎都用【空】表达"用默认":Claude runner 7109 剥 inherit,OpenAI runner 7639 不剥会把字面量当模型。
// 从模型 id/label 启发式推断能力档位。用户 extraModels 的 "id|Label" 标签(可含 强/均衡/快)一并参与。纯串匹配,无网络。
function modelCapabilityTier(id, label) {
  const s = (String(id || '') + ' ' + String(label || '')).toLowerCase();
  // 对抗轮 P3:'plus' 移出 strong(qwen-plus/glm-4-plus 是中档,误判会把难节点分给弱模型);pro/max/opus 等保留。
  if (/(opus|ultra|large|huge)|[-_ ]max\b|[-_ ]max$|\bmax[-_ ]|[-_ ]pro\b|405b|235b|72b|70b|32b|旗舰|高级|reasoner|thinking/.test(s)) return 'strong';
  if (/flash|mini|lite|small|turbo|nano|air|tiny|fast|haiku|8b|7b|4b|3b|1\.5b|轻量|极速/.test(s)) return 'fast';
  if (/[·\s【\[]强[·\s】\]]|^强|强$/.test(s)) return 'strong'; // 标签里的裸"强"(避免误吞 model id 里的偶发字)
  if (/[·\s【\[]快[·\s】\]]|^快|快$/.test(s)) return 'fast';
  return 'balanced';
}
const MODEL_TIER_LABEL = { strong: '强', balanced: '均衡', fast: '快' };
const MODEL_TIER_USE = { strong: '复杂推理/综合/裁判/难题', balanced: '一般实现与分析', fast: '简单/大批量/检索类节点' };
const MODEL_PRESET_IDS = new Set(MODEL_PRESETS.map(m => m.id).filter(Boolean)); // Claude 预设别名集(引擎归属判定用)
// 供编排者(AI)选型的可选模型清单 + 能力档位 + 按难度选型指引。【引擎分组】:OpenAI 节点用 provider 模型 + 用户
// 自定义(非预设);Claude 节点用别名 ∪ 代理发现缓存(第44波,替代原硬编码版本型号)。防 AI 给 openai 节点选 Claude
// 别名(必失败)。label 扁平化防注入。
function buildModelHint(config, provider) {
  const all = offlineModelList(config).filter(m => m.id);
  if (!all.length) return '';
  // OpenAI 组【优先用当前激活 provider 声明的模型】—— 只有它们对该 provider 真实可用;knownModels/config.model 可能
  // 是【别的 provider】的模型(如 deepseek 激活时 knownModels 里的 qwen 属 dashscope),混进来会诱导 AI 选了必失败。
  // 直接从 provider.models 构建(它们未必在 offlineModelList 里),label 命中 offlineModelList 则取其 label。
  const provList = []; const seenP = new Set();
  const addP = id => { id = String(id || '').trim(); if (id && !seenP.has(id) && !MODEL_PRESET_IDS.has(id)) { seenP.add(id); const f = all.find(m => m.id === id); provList.push(f || { id, label: id }); } };
  if (provider) { if (Array.isArray(provider.models)) for (const x of provider.models) addP((x && x.id) || x); if (provider.model) addP(provider.model); }
  // provider 声明了模型 → 只列这些;什么都没声明(自建单模型)→ 退回非预设自定义(尽力)。
  // 第44波: Claude 组 = 别名 ∪ 代理发现缓存(API 真实清单);openai 兜底池同步排除两者(防跨引擎诱导选错必失败)。
  const claudeCacheIds = new Set(getProxyModelsCache().models.map(m => m.id));
  const openaiModels = provList.length ? provList : all.filter(m => !MODEL_PRESET_IDS.has(m.id) && !claudeCacheIds.has(m.id));
  const claudeModels = all.filter(m => MODEL_PRESET_IDS.has(m.id) || claudeCacheIds.has(m.id)); // 别名 + 代理缓存(Claude)
  const fmt = m => { const t = modelCapabilityTier(m.id, m.label); const lb = m.label && m.label !== m.id ? '（' + String(m.label).replace(/\s+/g, ' ').trim() + '）' : ''; return `- ${m.id}【${MODEL_TIER_LABEL[t]}·${MODEL_TIER_USE[t]}】${lb}`; };
  const parts = [];
  if (openaiModels.length) parts.push('OpenAI 引擎节点(engine:openai)可选:\n' + openaiModels.map(fmt).join('\n'));
  if (claudeModels.length) parts.push('Claude 引擎节点(engine:claude)可选:\n' + claudeModels.map(fmt).join('\n'));
  if (!parts.length) return '';
  return '\n\n可选模型（node.model 按任务难易自主选;须与节点 engine 匹配;省略 model=用默认模型）:\n'
    + parts.join('\n')
    + '\n按难度选型:简单/大批量节点用【快】省成本提速;核心推理/综合/质量门/难题用【强】保质量;其余用【均衡】。填与引擎不符或不存在的模型会让该节点失败,不确定就省略 model。';
}
// 按 toolTier 挑一个档位合适的模型(后端兜底,opt-in agentAutoModelTiering):read→快、exec→强、edit→均衡;
// 目标档缺则顺位降级,全无则空(继承)。【引擎感知】:claude→空(继承 CLI 默认,不替它挑贵模型);openai 从 provider
// 模型 ∪ 用户自定义模型(knownModels/config.model/extraModels)里挑,【排除 Claude 预设别名】(对 openai 无意义)。
// 对抗轮 P3:池扩到 knownModels/config.model,修 provider.models=[] (常见自建配置)时 tier 兜底静默失效。
function tierModelForNode(toolTier, engine, config, provider) {
  if (engine === 'claude') return '';
  // 优先【当前激活 provider 声明的模型】(对该 provider 真实可用);只有 provider 什么都没声明时才退回用户全局
  // 自定义模型(knownModels/config.model,尽力兜底,可能跨 provider —— 但总比 provider.models=[] 时静默失效强)。
  const provIds = [];
  if (provider && Array.isArray(provider.models)) for (const x of provider.models) { const id = String((x && x.id) || x); if (id) provIds.push(id); }
  if (provider && provider.model) provIds.push(String(provider.model));
  let ids;
  if (provIds.length) ids = provIds;
  else { ids = []; for (const raw of (config.extraModels || [])) { const id = String(raw).split('|')[0].trim(); if (id) ids.push(id); } for (const id of (config.knownModels || [])) if (id) ids.push(String(id)); if (config.model) ids.push(String(config.model)); }
  const claudeCacheIds = new Set(getProxyModelsCache().models.map(m => m.id)); // 第44波: 缓存的 Claude 端模型同样排除
  const pool = [...new Set(ids)].filter(id => !MODEL_PRESET_IDS.has(id) && !claudeCacheIds.has(id)); // 排除 Claude 别名+代理缓存
  if (!pool.length) return '';
  const want = toolTier === 'exec' ? 'strong' : (toolTier === 'edit' ? 'balanced' : 'fast');
  const order = want === 'strong' ? ['strong', 'balanced', 'fast'] : want === 'fast' ? ['fast', 'balanced', 'strong'] : ['balanced', 'fast', 'strong'];
  for (const t of order) { const hit = pool.find(id => modelCapabilityTier(id, '') === t); if (hit) return hit; }
  return '';
}
// 节点最终 model 解析:显式(原样尊重,'inherit'→空)> 角色按引擎默认 > 按 tier 兜底(opt-in,引擎感知)> 继承(空)。
// 对抗轮:【不】做白名单丢弃 —— 显式 model 无论人工/AI 一律尊重(避免误杀 live 发现/未记住的真实模型,消除回归);
// 'inherit' 归一为空(两引擎都用空表达"用默认";OpenAI runner 不剥 inherit 字面量会当真模型发失败)。
function resolveNodeModel(rawModel, roleModel, toolTier, engine, config, provider) {
  let m = String(rawModel || '').trim().slice(0, 160);
  if (m === 'inherit') m = '';                      // 归一:两引擎"用默认"都用空
  if (m) return m;                                  // 显式非空 → 原样尊重(不白名单丢弃)
  const rm = String(roleModel || '').trim();
  if (rm && rm !== 'inherit') return rm;            // 角色默认(用户配置)
  if (config && config.agentAutoModelTiering) { const t = tierModelForNode(toolTier, engine, config, provider); if (t) return t; }
  return '';                                        // 继承 / provider 兜底链
}

// Best-effort live model list from the intranet proxy's /v1/models. NEVER throws (returns [] on any
// problem: no base URL, offline, timeout, non-2xx, bad JSON). Auth/URL come from config or env.
async function fetchProxyModels(config, timeoutMs = 2500) {
  // v1.4.4: reuse the exact same env resolution the real Claude CLI child gets (effectiveAnthropicEnv),
  // so the discovered list can never point at a different endpoint than what actually answers the chat.
  const effEnv = effectiveAnthropicEnv(config);
  const base = String(effEnv.ANTHROPIC_BASE_URL || effEnv.ANTHROPIC_BASE || '').trim().replace(/\/+$/, '');
  if (!base || typeof fetch !== 'function' || typeof AbortController !== 'function') return [];
  const headers = { 'anthropic-version': '2023-06-01' };
  if (effEnv.ANTHROPIC_AUTH_TOKEN) headers['authorization'] = 'Bearer ' + effEnv.ANTHROPIC_AUTH_TOKEN;
  if (effEnv.ANTHROPIC_API_KEY) headers['x-api-key'] = effEnv.ANTHROPIC_API_KEY;
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* ignore */ } }, timeoutMs);
  try {
    const res = await fetch(base + '/v1/models?limit=1000', { headers, signal: ctrl.signal });
    if (!res || !res.ok) return [];
    const body = await res.json();
    const data = Array.isArray(body && body.data) ? body.data
      : Array.isArray(body && body.models) ? body.models
      : Array.isArray(body) ? body : [];
    return data
      .map(m => (typeof m === 'string' ? { id: m, label: m } : { id: String(m.id || m.model || m.name || ''), label: String(m.display_name || m.id || m.model || '') }))
      .filter(m => m.id);
  } catch { return []; }
  finally { clearTimeout(timer); }
}

// Full list surfaced to the UI = proxy (live) ∪ offline, deduped, '默认' first.
// 第44波: 发现成功即更新 sidecar 缓存(setProxyModelsCache 内部做变更比对,没变不写盘)。
async function discoverModels(config) {
  const proxy = (config && config.discoverModelsFromProxy !== false) ? await fetchProxyModels(config).catch(() => []) : [];
  if (proxy.length) setProxyModelsCache(proxy);
  const seen = new Map();
  const add = (id, label) => { const k = String(id ?? ''); if (!seen.has(k)) seen.set(k, { id: k, label: label || k }); };
  add('', '默认 (CLI 配置)');
  for (const m of proxy) add(m.id, m.label);
  for (const m of offlineModelList(config)) if (m.id !== '') add(m.id, m.label);
  return { models: [...seen.values()], proxyCount: proxy.length };
}

const MCP_TOOLS = [
  ...adaptiveMetaToolSchemas(true),
  {
    name: 'permission_prompt',
    description: 'Internal: handles --permission-prompt-tool requests by asking the workbench UI to allow/deny a tool call.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
      },
    },
  },
  {
    name: 'powershell_run',
    description: 'Run a one-shot PowerShell command on Windows. For a persistent/interactive terminal that keeps state across calls, use shell_start/shell_send instead.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['command'],
    },
  },
  // v0.8-S2 shell session族 — a persistent PowerShell terminal that keeps working directory, variables,
  // and background processes alive across calls. AVAILABLE ONLY on the native provider engine: session
  // state lives in the serve process. Under the Claude CLI engine (tools run in a one-shot MCP subprocess)
  // these return a guiding error — use powershell_run for one-shot commands there.
  {
    name: 'shell_start',
    description: 'Start a persistent PowerShell session (keeps cwd/vars/background processes across calls). Provider engine only. Returns {shellId}. Then drive it with shell_send / shell_poll.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'working directory (defaults to home)' },
        name: { type: 'string', description: 'human-readable label' },
        shellId: { type: 'string', description: 'optional deterministic id ([a-zA-Z0-9_-]{1,32}); auto-generated if omitted' },
      },
    },
  },
  {
    name: 'shell_send',
    description: 'Send a line of input to a shell session and return the output that settles within timeoutMs (best-effort; long tasks: track with shell_poll). output is the increment since the last cursor.',
    inputSchema: {
      type: 'object',
      properties: {
        shellId: { type: 'string' },
        input: { type: 'string' },
        timeoutMs: { type: 'number', description: 'max wait for output to settle (default 10000)' },
      },
      required: ['shellId', 'input'],
    },
  },
  {
    name: 'shell_poll',
    description: 'Read new output from a shell session since an absolute byte cursor. Returns {output, cursor, running, exitCode?, truncated?}. Pass the returned cursor back next time to tail incrementally.',
    inputSchema: {
      type: 'object',
      properties: {
        shellId: { type: 'string' },
        cursor: { type: 'number', description: 'absolute byte offset to read from (default 0)' },
      },
      required: ['shellId'],
    },
  },
  {
    name: 'shell_kill',
    description: 'Terminate a shell session and its process tree.',
    inputSchema: {
      type: 'object',
      properties: { shellId: { type: 'string' } },
      required: ['shellId'],
    },
  },
  {
    name: 'shell_list',
    description: 'List active shell sessions: [{shellId,name,cwd,running,exitCode,startedAt,lastUsedAt,bytes}].',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'script_run',
    description: 'Run a temporary PowerShell, Python, or Node script',
    inputSchema: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['powershell', 'python', 'node', 'javascript'] },
        code: { type: 'string' },
        cwd: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['code'],
    },
  },
  {
    name: 'file_read',
    description: 'Read a local file. Char slice via offset/limit, or line mode via lineOffset (1-based) / lineLimit (returns cat -n style content with totalLines). Image/binary files are refused (use the vision channel).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'number', description: 'char offset (char-slice mode)' },
        limit: { type: 'number', description: 'char count (char-slice mode)' },
        lineOffset: { type: 'number', description: '1-based start line (line mode)' },
        lineLimit: { type: 'number', description: 'number of lines to return (line mode)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'file_write',
    description: 'Write a local file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, createDirs: { type: 'boolean' } },
      required: ['path', 'content'],
    },
  },
  {
    name: 'file_edit',
    description: 'Replace text in a local file',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, replaceAll: { type: 'boolean' } },
      required: ['path', 'oldText', 'newText'],
    },
  },
  {
    name: 'file_delete',
    description: 'Delete a local file (checkpointed first, so it can be rolled back). Directories are refused.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'file_move',
    description: '移动或重命名一个文件（from→to）。已先存检查点，可一键撤销。默认不覆盖已存在的目标（overwrite=true 才覆盖）。仅支持单个文件，不支持文件夹；跨磁盘自动退化为复制+删除。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件绝对路径' },
        to: { type: 'string', description: '目标绝对路径（含新文件名即为重命名）' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'file_copy',
    description: '复制一个文件（from→to）。目标已存在时会先存检查点，可一键撤销。默认不覆盖（overwrite=true 才覆盖）。仅支持单个文件，不支持文件夹。',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '源文件绝对路径' },
        to: { type: 'string', description: '目标绝对路径' },
        overwrite: { type: 'boolean', description: '目标已存在时是否覆盖，默认 false' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'archive_zip',
    description: '把工作区内的文件/文件夹打包成一个 .zip（deflate 压缩，中文文件名正确保留）。dest 已存在时先存检查点，可撤销。单文件上限 100MB、总量上限 500MB，超限会人话拒绝。',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要打包的文件或文件夹的绝对路径数组' },
        dest: { type: 'string', description: '输出 .zip 的绝对路径' },
      },
      required: ['paths', 'dest'],
    },
  },
  {
    name: 'archive_unzip',
    description: '把一个 .zip 解压到 destDir（支持 stored/deflate 两种压缩方式）。含越界路径（Zip Slip，如 ..\\）的压缩包会被整包拒绝；符号链接条目会被跳过。条目数上限 2000、解压总量上限 500MB。覆盖已存在文件需 overwrite=true，覆盖前会存检查点。',
    inputSchema: {
      type: 'object',
      properties: {
        src: { type: 'string', description: '要解压的 .zip 绝对路径' },
        destDir: { type: 'string', description: '解压目标文件夹的绝对路径' },
        overwrite: { type: 'boolean', description: '覆盖已存在的文件，默认 false' },
      },
      required: ['src', 'destDir'],
    },
  },
  {
    name: 'http_download',
    description: '从一个 http(s) 网址下载文件保存到工作区内的 dest（内网/回环地址会被 SSRF 防护拒绝）。dest 已存在时先存检查点，可撤销。默认单文件上限 100MB（maxBytes 可调），Content-Length 与实际字节都会卡上限，超限拒绝。返回 {path, bytes, contentType}。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要下载的 http(s) 网址' },
        dest: { type: 'string', description: '保存到的绝对路径（须在工作区内）' },
        maxBytes: { type: 'number', description: '最大字节数，默认 100MB' },
      },
      required: ['url', 'dest'],
    },
  },
  {
    name: 'file_list',
    description: 'List files under a directory',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, pattern: { type: 'string' }, recursive: { type: 'boolean' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' } },
    },
  },
  {
      name: 'file_search',
      description: 'Search text (regex, per line) in files under a directory. Optional context lines, relative-path glob filter, and per-file grouping.',
      inputSchema: {
        type: 'object',
        properties: {
          root: { type: 'string' }, pattern: { type: 'string' },
          maxResults: { type: 'number' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' },
          ignoreDirs: { type: 'array', items: { type: 'string' } },
          context: { type: 'number', description: '0-5 lines of context before/after each match' },
          glob: { type: 'string', description: 'relative-path glob filter (** / * / ?) restricting scanned files' },
          group: { type: 'boolean', description: 'group results by file: [{path, matches:[...]}]' },
        },
        required: ['pattern'],
      },
  },
  {
    name: 'glob',
    description: 'Find files by glob pattern (** crosses dirs, * within a segment, ? one char). Returns matches sorted by mtime (newest first).',
    inputSchema: {
      type: 'object',
      properties: { pattern: { type: 'string' }, root: { type: 'string' }, maxResults: { type: 'number' }, maxDepth: { type: 'number' } },
      required: ['pattern'],
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL or local HTML file in a new tab of the default browser. Never navigate or close the current Ruyi Workbench tab.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    },
  },
  {
    name: 'mcp_list',
    description: 'List the currently configured built-in and external MCP connectors, their launch command, argument list, working directory, environment key names, and browser target. Secret environment values are never returned. Use this before changing tool/MCP configuration.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'mcp_configure',
    description: 'Configure tools/MCP on the user\'s explicit request. Supports upsert/remove/enable of an external stdio MCP connector and changing the ai-computer-control browser target. This is an exec-tier persistent configuration change: inspect with mcp_list first, explain the diff, and rely on the permission prompt before applying. It cannot replace the built-in desktop MCP executable or edit application binaries.',
    inputSchema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['upsert', 'remove', 'set-enabled', 'set-browser'] },
        id: { type: 'string', description: 'External MCP id for upsert/remove/set-enabled.' },
        enabled: { type: 'boolean', description: 'For set-enabled.' },
        server: { type: 'object', description: 'For upsert: {id,label,command,args[],cwd,env{},enabled}. Keep credentials only in env and never echo them after saving.' },
        browser: { type: 'object', description: 'For set-browser: {mode:system|managed|custom|cdp|bundled, executable?, cdpUrl?}. system is the safe default and uses the user browser plus desktop UIA/OCR.' },
      },
      required: ['operation'],
    },
  },
  {
    name: 'office_open',
    description: 'Open a local Office document with the default application',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'desktop_screenshot',
    description: 'Capture the primary Windows screen to a PNG file',
    inputSchema: {
      type: 'object',
      properties: { outputPath: { type: 'string' }, timeoutMs: { type: 'number' } },
    },
  },
  {
    name: 'keyboard_send_keys',
    description: 'Send keystrokes to the active Windows application',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string' }, delayMs: { type: 'number' }, timeoutMs: { type: 'number' } },
      required: ['keys'],
    },
  },
  {
    name: 'project_snapshot',
    description: 'Return a compact project tree snapshot',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' } },
    },
  },
  // v1.0-S4 git 工具族 — 看状态/看差异/看历史/提交。为非程序员管版本(「帮我把这次改动存个版本」)。全部
  // execFile('git',…) 无 shell,模型可控路径一律在 `--` 之后,git 缺失/非仓库/缺身份 → 人话引导错误。
  {
    name: 'git_status',
    description: 'Show the git status of a folder (current branch, ahead/behind, and how many files changed). Read-only. Returns a plain-language summary plus the raw porcelain status.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'the repo folder (defaults to the session/home workspace)' },
      },
    },
  },
  {
    name: 'git_diff',
    description: 'Show what changed in a git repo as a unified diff (the +added / -removed lines). Read-only. Use staged:true to see staged changes, path to limit to one file, contextLines to widen/narrow context.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'the repo folder (defaults to the session/home workspace)' },
        path: { type: 'string', description: 'limit the diff to this file/pathspec' },
        staged: { type: 'boolean', description: 'diff the staged (index) changes instead of the working tree' },
        contextLines: { type: 'number', description: 'lines of context around each change (0..50, default git 3)' },
      },
    },
  },
  {
    name: 'git_log',
    description: 'List recent git commits (hash, date, author, subject) as a table. Read-only. maxCount defaults to 10 (clamped 1..100); path limits history to one file.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'the repo folder (defaults to the session/home workspace)' },
        maxCount: { type: 'number', description: 'how many commits to return (1..100, default 10)' },
        path: { type: 'string', description: 'limit history to this file/pathspec' },
      },
    },
  },
  {
    name: 'git_commit',
    description: 'Save a version: stage changes then create a git commit with the given message. This RUNS git hooks (pre-commit etc.), so it is an exec-tier action. If the repo has no Git identity configured, it returns a guiding error (it never invents a fake name/email).',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'the repo folder (defaults to the session/home workspace)' },
        message: { type: 'string', description: 'the commit message (required) — one line describing the change' },
        addAll: { type: 'boolean', description: 'stage all changes first with `git add -A` (default true when no explicit paths)' },
        paths: { type: 'array', items: { type: 'string' }, description: 'stage only these files (overrides addAll)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'dependency_inventory',
    description: 'Inventory local dependency and runtime configuration files without installing anything',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
    },
  },
  {
    name: 'code_review_scan',
    description: 'Run a lightweight offline code review scan for common security and quality risks',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' }, maxFindings: { type: 'number' }, ignoreDirs: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'frontend_audit',
    description: 'Audit frontend files for offline asset and UI polish issues',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, maxFiles: { type: 'number' }, maxDepth: { type: 'number' }, ignoreDirs: { type: 'array', items: { type: 'string' } } },
    },
  },
  {
    name: 'claude_md_audit',
    description: 'Find and audit CLAUDE.md project memory files',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' } },
    },
  },
  {
    name: 'docs_search',
    description: 'Search local project documentation as an offline docs lookup',
    inputSchema: {
      type: 'object',
      properties: { root: { type: 'string' }, query: { type: 'string' }, maxResults: { type: 'number' }, maxDepth: { type: 'number' }, ignoreDirs: { type: 'array', items: { type: 'string' } } },
      required: ['query'],
    },
  },
  {
    name: 'http_request',
    description: 'Make an HTTP request to a local or intranet endpoint for API debugging',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, method: { type: 'string' }, headers: { type: 'object' }, body: { type: 'string' }, timeoutMs: { type: 'number' }, maxBodyChars: { type: 'number' } },
      required: ['url'],
    },
  },
  // v0.9-S9 (D6): web search + fetch. Only offered when the capability matrix satisfies TOOL_REQUIRES
  // (web_search: network+searchBackend; web_fetch: network). web_fetch's url is SSRF-guarded (rejects
  // loopback/私网/元数据/协议) — an untrusted url can never reach an internal endpoint.
  {
    name: 'web_search',
    description: 'Search the web via the configured search backend (searxng/bing/brave/custom). Returns {results:[{title,url,snippet}]}. Use it for time-sensitive facts, external information, or anything that may have changed after your knowledge cutoff — search first, then answer. Then use web_fetch to read a promising result in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'the search query' },
        maxResults: { type: 'number', description: 'max results to return (default 5, clamped 1..20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public web page over http/https and return its extracted main text + title. Follows redirects (≤3), 10s timeout, ≤2MB. Internal/loopback/metadata addresses are refused for safety. Offline, it serves a cached copy if one exists (fromCache:true). Use it to read a page found via web_search.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'the http(s) URL to fetch' },
        maxChars: { type: 'number', description: 'max characters of extracted text to return (default 20000)' },
      },
      required: ['url'],
    },
  },
  // Shared main-turn question tool. Provider runs it in-process; Claude runs it through the per-session MCP
  // loopback. It is hidden from sub-agents and standalone MCP sessions because neither owns the chat UI.
  {
    name: 'request_user_input',
    description: 'Pause and ask the user one to three concise questions in the workbench UI. Use this whenever a missing preference or choice materially affects the result. The tool returns the user answers; continue only after it returns.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: 3,
          items: {
            type: 'object',
            properties: {
              header: { type: 'string', description: 'Short label for the question' },
              question: { type: 'string', description: 'The question shown to the user' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { label: { type: 'string' }, description: { type: 'string' } },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Allow more than one option' },
            },
            required: ['question'],
          },
        },
      },
      required: ['questions'],
    },
  },
  // v0.8-S3: task-list (TodoWrite) tool. FULL-REPLACE semantics — each call replaces the whole list.
  // Drives the UI step-bar. State lands on session.todos (provider engine: serve-process closure special-
  // case in runOpenAiTurn; Claude engine: loopback POST /api/todo, since the one-shot MCP child must not
  // write session files — see the todo_write case in toolCall()).
  {
    name: 'todo_write',
    description: 'Record/replace the task list for the current turn (full replace each call). Use it to plan multi-step work and mark progress. items:[{id?,text,status:pending|in_progress|done}]. Drives the workbench step-bar.',
    inputSchema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
            },
            required: ['text'],
          },
        },
      },
      required: ['items'],
    },
  },
  // 第26波b: 任务账本更新。与 todo_write 同款双引擎持久化路径(provider serve 闭包特例 / Claude 走 loopback
  // POST /api/mission)。仅当会话已有 mission(用户发起长任务)时,模型才被鼓励用它;无 mission 时调用也安全(会创建)。
  {
    name: 'mission_update',
    description: 'Update the long-running task ledger (Mission): mark milestones done/blocked, add milestones, or record evidence. Use it ONLY when a Mission is active for this session (the system prompt shows a <mission-ledger> block). action="update" merges; provide milestones:[{id,desc?,status:pending|done|blocked,evidence?}]. Do NOT invent a Mission for simple one-shot tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        milestones: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              desc: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'done', 'blocked'] },
              evidence: { type: 'string', description: '完成证据摘要(文件/测试/结论)' },
            },
            required: ['id'],
          },
        },
        goal: { type: 'string' },
      },
    },
  },
  // v0.9-S6 (子代理, L): spawn a self-contained SUB-TURN to carry out a delegated task, with its OWN
  // isolated history + tool subset (toolTier) + iteration budget, returning only the final conclusion text.
  // PROVIDER-ENGINE ONLY: it needs the live provider/session/journal/onEvent closure, so it is special-cased
  // in runOpenAiTurn's tool loop (like todo_write/bridge) and NEVER reaches the context-free toolCall(). It
  // is also filtered OUT of the Claude-CLI MCP surface (registered only when subagentMaxPerTurn>0 via
  // buildOpenAiTools). Sub-turns do NOT get spawn_agent themselves (禁嵌套). Registered in MCP_TOOLS so the
  // schema is shared; buildOpenAiTools decides whether to offer it.
  {
    name: 'spawn_agent',
    description: 'Delegate a self-contained subtask to an isolated sub-agent. Independent calls in the same assistant message run concurrently up to the configured stage limit. For dependent orchestration, first assign stable agentKey values (for example pro/con), wait for all tool results, then call a later reviewer/summary agent with dependsOn:["pro","con"]; their completed conclusions are injected automatically. Dependencies in the same batch are refused because that stage has not completed. toolTier: read (default) | edit | exec. Sub-agents cannot spawn further sub-agents.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'the concrete task to delegate (a self-contained instruction)' },
        role: { type: 'string', description: 'Agent role id from the role library, for example explorer, worker, reviewer, verifier' },
        agentKey: { type: 'string', description: 'optional stable identifier for this sub-agent within the parent turn (for later dependsOn references)' },
        dependsOn: { type: 'array', items: { type: 'string' }, description: 'agentKey values from completed earlier stages whose conclusions should be injected into this task' },
        toolTier: { type: 'string', enum: ['read', 'edit', 'exec'], description: "tool access level for the sub-agent (default 'read')" },
        maxIters: { type: 'number', description: 'sub-loop iteration budget (default 100, clamped 1..300)' },
        model: { type: 'string', description: 'optional model id for the sub-turn (engine is openai), chosen by task difficulty (fast model for simple/bulk work, strong model for hard reasoning). Pick from the OpenAI models listed in the system prompt; a wrong/unknown id makes the sub-agent fail. Omit to use the default.' },
        resources: { type: 'array', items: { type: 'string' }, description: 'resources held for the whole subtask. Examples: desktop, browser:default, file:C:\\project\\a.js, workspace:C:\\project. Prefix with read: for shared access.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'orchestrate_agents',
    description: "Run a persistent sub-agent DAG. Supports structured JSON Schema outputs, automatic Reviewer/Verifier quality gates, explicit vote-contract validation, deterministic voting/deduplication, cross-review, semantic loop progress keys, tool-evidence requirements, and per-node failure/dependency policies. Reliability guidance: give factual probes minSuccessfulToolCalls>=1; make unavailable schema fields nullable; use dependencyPolicy:'all_settled' only on fan-in nodes designed to consume failed inputs; set loop.progressPath to a stable structured field; every dependency of a vote node must explicitly output {verdict,confidence}. vote/dedupe nodes are deterministic aggregators and do NOT execute their task text, so keep synthesis in a preceding node. Two ways to call it: (1) author `nodes` inline for a one-off DAG, or (2) pass `workflowId` to reuse a saved/built-in template by id (available ids + when to reach for each are listed in the system prompt) plus `context` — a short description of THIS run's actual subject/task, since a template's node tasks are often generic placeholders with no subject of their own. Prefer (2) for complex, multi-step tasks that match a listed template; skip it for simple one-shot requests.",
    inputSchema: {
      type: 'object',
      properties: {
        nodes: {
          type: 'array', minItems: 1, maxItems: 64,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'unique stable node id, letters/numbers/_/- only' },
              task: { type: 'string', description: 'self-contained task for this node' },
              role: { type: 'string', description: 'Agent role id; the role supplies model, tools, MCP, permission and iteration defaults' },
              engine: { type: 'string', enum: ['openai', 'claude'], description: "which engine runs this node: 'openai' (HTTP against a configured Provider) or 'claude' (a native Claude CLI spawn). Omit to auto-pick whichever is available." },
              dependsOn: { type: 'array', items: { type: 'string' }, description: 'node ids that must finish before this node starts' },
              toolTier: { type: 'string', enum: ['read', 'edit', 'exec'] },
              maxIters: { type: 'number' },
              model: { type: 'string', description: 'optional model id for THIS node, chosen by task difficulty (fast model for simple/bulk nodes, strong model for hard reasoning/synthesis/quality-gates). Pick from the models listed in the system prompt AND matching this node engine; a wrong/unknown id makes the node fail. Omit to use the role/default model.' },
              resources: { type: 'array', items: { type: 'string' }, description: 'exclusive resources required by this node; use read: prefix for shared access' },
              isolation: { type: 'string', enum: ['none', 'worktree'], description: 'worktree runs this node in a detached Git worktree and keeps its commit for explicit user application; never auto-merges' },
              outputSchema: { type: 'object', description: 'optional JSON Schema for this node final JSON value (objects, arrays, and primitives supported); invalid JSON/schema fails the node. Fields that may be unavailable must explicitly allow null, for example type:["integer","null"].' },
              gate: {
                type: 'object', description: 'quality gate; reviewer/verifier roles get one automatically',
                properties: {
                  mode: { type: 'string', enum: ['review', 'verify', 'vote', 'cross_review', 'dedupe'], description: 'vote/dedupe are deterministic aggregator nodes and do not execute task; vote dependencies must each return explicit verdict+confidence' },
                  threshold: { type: 'number', description: 'vote pass ratio, 0..1' },
                  minApprovals: { type: 'number' },
                },
              },
              failurePolicy: { type: 'string', enum: ['block', 'continue', 'retry'], description: 'block downstream (default), continue in degraded mode, or retry automatically' },
              dependencyPolicy: { type: 'string', enum: ['all_success', 'all_settled'], description: 'all_success blocks this node on a failed dependency (default); all_settled runs after every dependency settles and injects failed status/error for tolerant fan-in aggregation' },
              degradedPolicy: { type: 'string', enum: ['accept', 'retry', 'request_review', 'fail'], description: '当节点【降级成功】(产出可用但执行异常)时的处置:accept 照用(默认)/ retry 重跑一次 / request_review 暂停待人工 / fail 判失败(交 failurePolicy 决定下游)' },
              maxRetries: { type: 'number', description: 'additional automatic attempts for retry policy, 0..5' },
              retryFallback: { type: 'string', enum: ['block', 'continue'], description: 'behavior after retries are exhausted' },
              minSuccessfulToolCalls: { type: 'number', description: '0..20; fail the node unless this attempt records at least this many successful tool calls. Use >=1 for independently checkable factual probes.' },
              condition: { type: 'object', description: 'optional branch condition: {node,path,operator,value}; operators include equals/not_equals/truthy/falsy/contains/comparisons/status_is' },
              loop: { type: 'object', description: 'bounded loop: {maxIterations,until,progressPath,noProgressLimit,onNoProgress}. progressPath selects a stable field from structured output (for example status or remainingCount), so prose/verbosity changes do not fake progress.' },
            },
            required: ['id', 'task'],
          },
        },
        providerId: { type: 'string', description: 'optional configured OpenAI-compatible provider id; useful when the Claude CLI parent launches this DAG' },
        workflowId: { type: 'string', description: 'saved/built-in workflow id to launch instead of sending nodes' },
        context: { type: 'string', description: "this run's actual subject/task, prepended to every node's task — required in practice when workflowId is used, since template node tasks are generic placeholders" },
      },
    },
  },
];

function sendMcp(id, result, error) {
  const payload = error
    ? { jsonrpc: '2.0', id, error: { code: -32000, message: error.message || String(error) } }
    : { jsonrpc: '2.0', id, result };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

async function startMcp() {
  await ensureDirs();
  // v0.8-S2: mark this process as the one-shot MCP child. Shell-session tools detect this and return a
  // guiding error instead of pretending to work — their state (the powershell child + ring buffer) lives
  // in the serve process and cannot survive across this transient child's turns.
  RUNTIME.isMcpChild = true;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    void (async () => {
      if (!line.trim()) return;
      const msg = safeJsonParse(line);
      if (!msg || !msg.method) return;
      try {
        if (msg.method === 'initialize') {
          return sendMcp(msg.id, {
            protocolVersion: msg.params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'win-claude-workbench', version: VERSION }, // 【存量兼容标识】MCP 服务端标识名保持旧名(与 server id 一致)
          });
        }
        if (msg.method === 'tools/list') {
          // A single spawn_agent still needs the provider turn closure. The persistent DAG is safe to
          // advertise: in a Claude CLI session it loops back to the serve process and uses a configured
          // OpenAI-compatible provider for worker nodes.
          const userInputEnabled = Boolean(process.env.WCW_SESSION_ID) && process.env.WCW_DISABLE_USER_INPUT !== '1';
          const mode = process.env.WCW_TOOL_LOADING_MODE || 'full';
          const routedPacks = new Set(String(process.env.WCW_TOOL_PACKS || '').split(',').filter(Boolean));
          routedPacks.add('core');
          const adaptiveAlways = new Set(['permission_prompt', 'tool_search', 'tool_load', 'tool_invoke_read', 'tool_invoke_edit', 'tool_invoke_exec']);
          const listed = MCP_TOOLS.filter(t => {
            if (t.name === 'spawn_agent') return false;
            if (t.name === 'request_user_input' && !userInputEnabled) return false;
            if (mode !== 'auto') return true;
            return adaptiveAlways.has(t.name) || routedPacks.has(toolPackForName(t.name, {}));
          });
          return sendMcp(msg.id, { tools: listed });
        }
        if (msg.method === 'tools/call') {
          const name = msg.params?.name;
          const args = msg.params?.arguments || {};
          const result = await toolCall(name, args);
          return sendMcp(msg.id, {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            isError: result.ok === false,
          });
        }
        if (msg.method === 'resources/list') {
          return sendMcp(msg.id, {
            resources: [
              {
                uri: `file://${paths.config.replace(/\\/g, '/')}`,
                name: 'Workbench config',
                description: 'Local workbench configuration file',
                mimeType: 'application/json',
              },
            ],
          });
        }
        if (msg.method === 'resources/read') {
          const uri = String(msg.params?.uri || '');
          if (!uri.startsWith('file://')) throw new Error('Only file:// resources are supported');
          const p = decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/^\/+/, '');
          // resources/list only exposes the config file — confine reads to exactly it (no traversal,
          // no UNC/SMB egress from an "offline" tool).
          const resolved = path.resolve(p);
          if (resolved.toLowerCase() !== path.resolve(paths.config).toLowerCase()) throw new Error('resource not found');
          const content = await fsp.readFile(resolved, 'utf8');
          return sendMcp(msg.id, { contents: [{ uri, mimeType: 'text/plain', text: content }] });
        }
        if (msg.id !== undefined) return sendMcp(msg.id, {});
      } catch (err) {
        return sendMcp(msg.id, null, err);
      }
    })();
  });
}

async function installIntegration() {
  await ensureDirs();
  const config = await readConfig();
  const mcpPath = await generateMcpConfig();
  const installer = path.join(externalRoot(), 'resources', 'scripts', 'install-workbench.ps1');
  console.log(`${APP_NAME} integration`);
  console.log(`Data root: ${paths.data}`);
  console.log(`MCP config: ${mcpPath}`);
  console.log(`Claude CLI: ${config.claudePath || '(not configured)'}`);
  if (fs.existsSync(installer)) {
    console.log(`Run installer script: powershell -ExecutionPolicy Bypass -File "${installer}"`);
  }
  if (config.claudePath && existsExecutable(config.claudePath)) {
    // 【存量兼容标识】注册进用户全局 Claude MCP 时沿用旧 server id 'win-claude-workbench'(与生成的配置一致)。
    const result = await runProcess(config.claudePath, ['mcp', 'add-json', 'win-claude-workbench', JSON.stringify(JSON.parse(await fsp.readFile(mcpPath, 'utf8')).mcpServers['win-claude-workbench'])], {
      cwd: os.homedir(),
      timeoutMs: 30000,
    });
    console.log(result.stdout || result.stderr || JSON.stringify(result, null, 2));
  }
  // v1.4.3: full sync — settings.json + agent roles + MCP servers
  await syncClaudeCliSettings(config);
  await syncAgentRolesToClaude(config.defaultWorkspace || os.homedir(), config);
  await syncMcpServersToClaude(config);
  console.log('Claude CLI synced: settings+agents+mcp (permissionMode=' + config.permissionMode + ')');
}

async function doctor() {
  await ensureDirs();
  const config = await readConfig();
  const mcpConfigPath = await generateMcpConfig();
  const info = {
    app: APP_NAME,
    version: VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    isPkg: isPkg(),
    exePath: exePath(),
    dataRoot: paths.data,
    configPath: paths.config,
    mcpConfigPath,
    claudePath: config.claudePath,
    claudeDetected: detectClaudePath(),
    claudeWorks: Boolean(config.claudePath && existsExecutable(config.claudePath)),
    resourcesRoot: path.join(externalRoot(), 'resources'),
  };
  console.log(JSON.stringify(info, null, 2));
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}
