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

  if (req.method === 'POST' && pathname === '/api/bootstrap') {
    // 47c(S1):浏览器拿 token 的【唯一】通道(HTML 不再明文下发)。auth=open -> 顶层 host 门已挡 rebinding
    // (Host=攻击域 -> 403),信任面与旧 GET / 明文下发完全等同;非浏览器(curl/node)亦同旧规可得。
    // 不查 Origin:'open' 级本就允许 loopback 非浏览器,浏览器同源(Host=loopback)也放行,跨站 rebinding 已被 host 门拦。
    return send(res, json({ ok: true, token: RUNTIME.token || '' }));
  }
  if (req.method === 'GET' && pathname === '/api/status') {
    const config = await readConfig();
    let conversationConfig = config;
    try {
      const requestedSessionId = safeSessionId(new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') || '');
      if (requestedSessionId) {
        const statusSession = await loadSession(requestedSessionId);
        if (statusSession) conversationConfig = configForSessionEngineRoute(config, statusSession);
      }
    } catch { /* status without a valid session keeps the global new-session default */ }
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
      // Resolve the conversation route (including CLI/manual overrides), never the summary provider.
      contextWindowResolved: await (async () => {
        const p = activeOpenAiProvider(conversationConfig);
        if (!p) {
          const meta = await agentConversationContextMeta(conversationConfig, null);
          return { value: meta.contextWindow, source: meta.contextWindowSource, engine: 'agent', agentCliType: meta.contextAgentCliType, provider: '', model: String(conversationConfig.model || '') };
        }
        const model = p ? String(p.model || (p.models && p.models[0] && p.models[0].id) || '').trim() : '';
        const manual = configuredConversationWindow(conversationConfig, 'openai', p.id, model);
        const r = resolveContextWindow(manual ? { ...p, contextWindow: manual } : p, model);
        // 45f 对抗轮 P3-5:窗口学习生效时如实展示 —— 否则用户看到「才用一半就压缩」会对不上账。
        const cap = p ? learnedWindowCap(p.id, model) : 0;
        return { value: cap ? Math.min(r.value, cap) : r.value, source: r.source, provider: p ? p.id : '', model, learnedCap: cap || undefined };
      })(),
      models: conversationConfig.agentCliType === 'kimi' ? kimiModelList(conversationConfig) : offlineModelList(conversationConfig), // instant offline list for the requested conversation route
      providerPresets: PROVIDER_PRESETS, // v0.5: built-in OpenAI-compatible provider templates (DeepSeek/DashScope/custom)
      claudeEndpointPresets: CLAUDE_ENDPOINT_PRESETS, // v1.4.4: third-party Anthropic-compatible endpoint templates for the Claude CLI engine (Ark Coding Plan/custom)
      detectedClaudePath: detectClaudePath(),
      detectedKimiPath: detectKimiPath(),
      agentCliDrivers: Object.values(AGENT_CLI_TYPES).map(d => ({ ...d, path: selectedAgentCli({ ...config, agentCliType: d.id }).detected })),
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
  // 第53波 EC-B(53d): POST /api/pick-file - 原生文件选择器(OpenFileDialog,选 overlay zip 等)。token 级。
  if (req.method === 'POST' && pathname === '/api/pick-file') {
    const body = await readJsonBody(req);
    return send(res, json(await pickFile(body && body.filter)));
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
    if (config.agentCliType === 'kimi') {
      const discovered = await discoverKimiModels(config);
      return send(res, json({ ...discovered, engine: 'claude', agentCliType: 'kimi', proxyCount: discovered.discoveredCount || 0 }));
    }
    return send(res, json({ ok: true, engine: 'claude', agentCliType: 'claude', ...(await discoverModels(config)) }));
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
    if (body && ['agentCliType', 'claudePath', 'kimiPath'].some(k => Object.prototype.hasOwnProperty.call(body, k))) {
      invalidateAgentCliPathCaches();
    }
    // v1.4.3: keep ~/.claude/ in sync — settings.json + agent roles + MCP servers
    if (body && (Object.prototype.hasOwnProperty.call(body, 'permissionMode') || Object.prototype.hasOwnProperty.call(body, 'model') || Object.prototype.hasOwnProperty.call(body, 'thinkingBudget') || Object.prototype.hasOwnProperty.call(body, 'appendSystemPrompt'))) {
      await syncClaudeCliSettings(next);
    }
    if (body && (Object.prototype.hasOwnProperty.call(body, 'agentRoleOverrides') || Object.prototype.hasOwnProperty.call(body, 'permissionMode'))) {
      await syncAgentRolesToClaude(next.defaultWorkspace || os.homedir(), next);
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'externalMcpServers')) {
      await syncMcpServersToClaude(next);
      if (next.agentCliType === 'kimi' && next.includeWorkbenchMcp) await syncMcpServersToKimi(next);
    }
    if (body && (Object.prototype.hasOwnProperty.call(body, 'agentCliType') || Object.prototype.hasOwnProperty.call(body, 'includeWorkbenchMcp'))) {
      if (next.agentCliType === 'kimi') await syncMcpServersToKimi(next);
      else if (current.agentCliType === 'kimi') await syncMcpServersToKimi({ ...next, includeWorkbenchMcp: false });
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
    if (rawProvider && typeof rawProvider === 'object') {
      const cfg = await readConfig();
      rawProvider = unmaskProviders([rawProvider], cfg.providers)[0];
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
  // EC-D Wave 65: session CRUD routes live in 13d-core-domain-routes.js.
  await handleSessionApiRoutes(req, res, pathname); if (res.writableEnded) return;
  // 第70波(EC-E):/api/missions 聚合只读投影,同在 13d。
  await handleMissionsApiRoutes(req, res, pathname); if (res.writableEnded) return;
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
  // v2.5: 删除用户技能。DELETE /api/skills {id, confirm}。「不要太简单」的摩擦:confirm 必须等于 id
  // (前端弹确认窗要求输入 id 才解锁确认键)。仅 source==='user' 可删(对应 paths.skills/<id>/ 目录);
  // builtin/project/claude-code 拒绝并给原因(builtin 是内置、project 在用户项目里、claude-code 是 Claude Code
  // 的文件 -- 都不该由 Ruyi 删)。路径双保险:entry.dir 必须解析为 paths.skills/id,防穿越/调包。
  if (req.method === 'DELETE' && pathname === '/api/skills') {
    const body = await readJsonBody(req);
    const id = String((body && body.id) || '').trim();
    const confirm = String((body && body.confirm) || '').trim();
    if (!id || !SKILL_ID_RE.test(id)) return send(res, json({ ok: false, error: '无效的技能 id' }, 400));
    if (confirm !== id) return send(res, json({ ok: false, error: '确认不匹配:请输入该技能的 id 以确认删除' }, 400));
    const config = await readConfig();
    const registry = await loadSkillRegistry('', config).catch(() => []);
    const entry = registry.find(e => e && e.id === id && e.kind === 'skill');
    if (!entry) return send(res, json({ ok: false, error: '未找到该技能: ' + id }, 404));
    if (entry.source !== 'user') return send(res, json({ ok: false, error: `仅可删除用户技能(当前来源: ${entry.source || '未知'})。内置/项目/Claude Code 技能请到对应位置管理。` }, 403));
    const expected = path.resolve(paths.skills, id);
    const actual = path.resolve(entry.dir || '');
    if (actual !== expected) return send(res, json({ ok: false, error: '路径校验失败:技能目录不在用户技能目录下' }, 400));
    try { await fsp.rm(actual, { recursive: true, force: true }); }
    catch (e) { return send(res, json({ ok: false, error: '删除失败: ' + ((e && e.message) || String(e)) })); }
    logEvent({ kind: 'skill_delete', id });
    return send(res, json({ ok: true, id, removed: true }));
  }
  // ── v2 跨会话记忆(团队模式 v2 Phase 3, 设计稿 C) ─────────────────────────────────────────────
  // POST /api/session/memories:memories=固定选择；useDefault=true 恢复项目+全局默认检索，并可携带会话排除项。
  if (req.method === 'POST' && pathname === '/api/session/memories') {
    const body = await readJsonBody(req);
    const session = await loadSession(String(body && body.sessionId || '')).catch(() => null);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    const config = await readConfig();
    const cwd = normalizeCwd(session.cwd, config.defaultWorkspace);
    const registry = await loadMemoryRegistry(cwd).catch(() => []);
    const byKey = new Map(registry.map(e => [e.scope + ':' + e.id, e]));
    const projKey = projectKeyForCwd(cwd); // P3-3: 权威 projectKey(取自 session.cwd),给 project 条目落盘锁定来源
    if (body && body.useDefault === true) {
      const excluded = [];
      const excludedSeen = new Set();
      for (const raw of (Array.isArray(body.memoryExclusions) ? body.memoryExclusions : [])) {
        const id = String((raw && raw.id) || '').trim();
        const scope = raw && raw.scope === 'global' ? 'global' : 'project';
        const key = scope + ':' + id;
        if (!byKey.has(key) || excludedSeen.has(key)) continue;
        excludedSeen.add(key);
        excluded.push(scope === 'project' ? { id, scope, projectKey: projKey } : { id, scope });
        if (excluded.length >= MEMORY_EXCLUSION_MAX) break;
      }
      session.memories = [];
      session.memoriesExplicit = false;
      session.memoryExclusions = excluded;
      await saveSession(session);
      { const reg = activeChildren.get(session.id); if (reg && reg.session && reg.session !== session) { reg.session.memories = []; reg.session.memoriesExplicit = false; reg.session.memoryExclusions = excluded; } }
      return send(res, json({ ok: true, memories: [], memoriesExplicit: false, memoryExclusions: excluded }));
    }
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
      if (cleaned.length >= MEMORY_MAX) break;
    }
    session.memories = cleaned;
    session.memoriesExplicit = true; // 用户显式设置过 → 关闭默认自动启用
    session.memoryExclusions = [];
    await saveSession(session);
    { const reg = activeChildren.get(session.id); if (reg && reg.session && reg.session !== session) { reg.session.memories = cleaned; reg.session.memoriesExplicit = true; reg.session.memoryExclusions = []; } }
    return send(res, json({ ok: true, memories: cleaned, memoriesExplicit: true, memoryExclusions: [] }));
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
    const registry = await loadMemoryRegistry(cwd).catch(() => []);
    const coreState = await resolveCoreMemoryState(cwd, registry).catch(() => ({ all: registry, active: [], standby: [], expired: [], stats: { total: registry.length, coreRequested: 0, active: 0, standby: 0, expired: 0, reviewDue: 0, charsUsed: 0, charLimit: CORE_MEMORY_CHAR_CAP, itemLimit: CORE_MEMORY_MAX } }));
    const projectKey = projectKeyForCwd(cwd);
    const otherProjects = await listMemoryProjectGroups(projectKey).catch(() => []);
    return send(res, json({ ok: true, memories: coreState.all, core: coreState.stats, projectKey, cwd, otherProjects }));
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
  // POST /api/memory/proposal {sessionId} —— 高门槛自动候选：确定性预筛后才让同一 provider 模型裁决；
  // 只返回候选，不写记忆。模型否决、冷却、重复、敏感或不可用都静默返回 proposal:null。
  if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/proposal') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body && body.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    return send(res, json(await proposeMemoryFromSession(sessionId)));
  }
  // POST /api/memory/proposal/decision —— 只有用户在卡片上保存/忽略时落候选状态；仍不替用户写记忆。
  if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/proposal/decision') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body && body.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const r = await decideMemoryProposal(sessionId, String(body && body.proposalId || ''), String(body && body.decision || ''));
    return send(res, json(r, r.ok ? 200 : 404));
  }
  // POST /api/memory/proposal/apply —— 用户在维护卡片上确认后,按候选 kind 落盘(memory_revise 覆盖 /
  // relation_propose 写 confirmed 边 / relation_revoke 删边)。模型只 propose,此路由只由 UI 调用(用户批准)。
  if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/proposal/apply') {
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body && body.sessionId);
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const config = await readConfig();
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    if (!pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
    const r = await applyMemoryRelationProposal(sessionId, String(body && body.proposalId || ''), cwd);
    return send(res, json(r, r.ok ? 200 : (r.conflict ? 409 : 404)));
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
  // POST /api/memory/metadata —— 工具箱里的核心/重要性快捷操作。先读原条目再完整保存，正文不丢失；
  // LRU 只据这些元数据调整核心席位，不会在此路由删除或替换任何记忆。
  if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/metadata') {
    const body = await readJsonBody(req);
    const config = await readConfig();
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    const scope = body && body.scope === 'global' ? 'global' : 'project';
    if (scope === 'project' && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
    const item = await readMemoryItem(String(body && body.id || ''), scope, cwd);
    if (!item.ok) return send(res, json(item, 404));
    const patch = body && body.patch && typeof body.patch === 'object' ? body.patch : {};
    const memory = { ...item.memory };
    if (Object.prototype.hasOwnProperty.call(patch, 'core')) memory.core = patch.core === true;
    if (Object.prototype.hasOwnProperty.call(patch, 'importance')) memory.importance = patch.importance === 'important' ? 'important' : 'normal';
    if (Object.prototype.hasOwnProperty.call(patch, 'reviewAfter')) memory.reviewAfter = patch.reviewAfter;
    if (Object.prototype.hasOwnProperty.call(patch, 'expiresAt')) memory.expiresAt = patch.expiresAt;
    const r = await saveMemory(memory, cwd);
    return send(res, json(r, r.ok ? 200 : 400));
  }
  // POST /api/memory {memory:{id?,scope,name,description,type,body}, cwd} —— 保存(id 缺省合成,原子写)。
  if (req.method === 'POST' && pathname === '/api/memory') {
    const body = await readJsonBody(req);
    const config = await readConfig();
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    const memIn = (body && body.memory) || {};
    if (memIn.scope === 'project' && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
    const proposalSourceSessionId = body && body.proposalId ? String(body.sourceSessionId || '') : '';
    const proposalId = body && body.proposalId ? String(body.proposalId || '') : '';
    if (proposalId) {
      const sourceCheck = await validateMemoryProposalSave(proposalSourceSessionId, proposalId, cwd);
      if (!sourceCheck.ok) return send(res, json(sourceCheck, sourceCheck.conflict ? 409 : 404));
    }
    const r = await saveMemory(memIn, cwd);
    // The memory write and proposal acknowledgement belong to the same server-side
    // operation from the UI's perspective. Settle here so a dropped browser response
    // does not normally leave a successfully saved candidate pending.
    if (r.ok && proposalId) await decideMemoryProposal(proposalSourceSessionId, proposalId, 'saved').catch(() => {});
    return send(res, json(r, r.ok ? 200 : 400));
  }
  // R4 Local Memory Graph(设计稿 15-r4-memory-graph.md)。relations 路由须在通配 /api/memory/<id>(下文 DELETE)之前,
  // 否则 path.basename('/api/memory/relations/rel-x')='rel-x' 会误删记忆。模型只 propose;confirm/delete 仅用户。
  // GET /api/memory/relations?cwd=&scope=&includePending= -- 列边(默认仅 confirmed;includePending=true 含 pending)。
  if (req.method === 'GET' && pathname === '/api/memory/relations') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const config = await readConfig();
    const sp = new URL(req.url, 'http://x').searchParams;
    const scope = sp.get('scope') === 'global' ? 'global' : 'project';
    const cwdQ = sp.get('cwd') || '';
    let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
    if (cwdQ) { const resolved = normalizeCwd(cwdQ, config.defaultWorkspace); if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved; }
    const r = await listMemoryRelations(cwd, scope, { includePending: sp.get('includePending') === 'true' });
    return send(res, json(r));
  }
  // R4-S3 GET /api/memory/maintenance?cwd=&scope=&staleDays= -- 确定性聚类 + 过期复核建议。
  // 只读且永不自动删/禁用；内容含项目记忆 id，ROUTE_AUTH + handler 双 token 门。
  if (req.method === 'GET' && pathname === '/api/memory/maintenance') {
    if (!tokenOk(req)) return send(res, json({ ok: false, error: 'missing or invalid workbench token' }, 403));
    const config = await readConfig();
    const sp = new URL(req.url, 'http://x').searchParams;
    const scope = sp.get('scope') === 'global' ? 'global' : 'project';
    const cwdQ = sp.get('cwd') || '';
    let cwd = normalizeCwd(config.defaultWorkspace, config.defaultWorkspace);
    if (cwdQ) { const resolved = normalizeCwd(cwdQ, config.defaultWorkspace); if (pathWithinAnyRoot(path.resolve(resolved), fileAllowedRoots(null, config))) cwd = resolved; }
    const r = await analyzeMemoryMaintenance(cwd, scope, { staleDays: sp.get('staleDays') });
    try { appendUsageLedger({ engine: 'openai', kind: 'aux', note: 'memory-maintenance-scan', meta: { scope, clusters: r.stats.clusters, suggestions: r.stats.expirySuggestions } }); } catch { /* 审计失败不阻断只读分析 */ }
    return send(res, json(r));
  }
  // POST /api/memory/relations/propose {type,from,to,scope?,evidenceRef?,sourceRunId?,note?,cwd} -- 提议(confirmed:false)。
  if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/relations/propose') {
    const body = await readJsonBody(req);
    const config = await readConfig();
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    if (body && body.scope === 'project' && !pathWithinAnyRoot(path.resolve(cwd), fileAllowedRoots(null, config))) return send(res, json({ ok: false, error: 'cwd 不在允许的工作区内' }, 400));
    const r = await proposeMemoryRelation(body || {}, cwd);
    return send(res, json(r, r.ok ? 200 : 400));
  }
  // POST /api/memory/relations/confirm {id,cwd} -- 确认(confirmed:true,仅用户)。
  if (req.method === 'POST' && req.headers['x-http-method'] !== 'DELETE' && pathname === '/api/memory/relations/confirm') {
    const body = await readJsonBody(req);
    const config = await readConfig();
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    const r = await confirmMemoryRelation(String(body && body.id || ''), cwd);
    return send(res, json(r, r.ok ? 200 : 404));
  }
  // DELETE /api/memory/relations/<id> {cwd} -- 删边(仅用户)。须在通配 /api/memory/<id> 之前匹配。
  if (pathname.startsWith('/api/memory/relations/') && (req.method === 'DELETE' || (req.method === 'POST' && req.headers['x-http-method'] === 'DELETE'))) {
    const id = path.basename(pathname); // guards traversal(relations/ 前缀已匹配,id 须过 SKILL_ID_RE)
    const body = await readJsonBody(req);
    const config = await readConfig();
    const cwd = normalizeCwd((body && body.cwd) || config.defaultWorkspace, config.defaultWorkspace);
    const r = await deleteMemoryRelation(id, cwd);
    return send(res, json(r, r.ok ? 200 : 404));
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
    const sessionId = safeSessionId(String(body.sessionId || ''));
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    if (activeChildren.has(sessionId)) return send(res, json({ ok: false, error: '回合进行中，请先停止或等待完成' }, 409));
    return send(res, json(await runProviderCompact(sessionId)));
  }
  if (req.method === 'POST' && pathname === '/api/agent/compact') {
    const body = await readJsonBody(req);
    const storedConfig = await readConfig();
    const sessionId = safeSessionId(String(body.sessionId || ''));
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    // Native Kimi compaction and external summary reseeding both mutate the same session a live turn
    // owns. Enforce the UI's no-overlap rule at the API boundary to avoid last-writer-wins data loss.
    if (activeChildren.has(sessionId)) return send(res, json({ ok: false, error: '回合进行中，请先停止或等待完成' }, 409));
    const compactSession = await loadSession(sessionId);
    const config = compactSession ? configForSessionEngineRoute(storedConfig, compactSession) : storedConfig;
    const result = config.compactProviderId
      ? await runAgentExternalCompact(sessionId, config, 'manual')
      : (config.agentCliType === 'kimi'
        ? await runKimiCompact(sessionId, config, 'manual')
        : { ok: false, error: 'Claude 默认压缩请使用原生 /compact；或先选择通用压缩模型' });
    return send(res, json(result, result.ok ? 200 : 400));
  }
  if (req.method === 'GET' && pathname === '/api/kimi/status') {
    const config = await readConfig();
    if (config.agentCliType !== 'kimi') return send(res, json({ ok: false, error: '当前不是 Kimi Code 接入' }, 400));
    const u = new URL(req.url, 'http://x');
    const sessionId = safeSessionId(String(u.searchParams.get('sessionId') || ''));
    if (!sessionId) return send(res, json({ ok: false, error: 'invalid sessionId' }, 400));
    const session = await loadSession(sessionId).catch(() => null);
    if (!session) return send(res, json({ ok: false, error: 'session not found' }, 404));
    const status = await kimiSessionStatus(config, session.claudeSessionId, session.claudeSessionModel);
    if (!status.ok) return send(res, json(status, 400));
    const usage = applyKimiStatusToSession(session, status);
    await saveSession(session).catch(() => {});
    return send(res, json({ ...status, usage }));
  }
  // EC-D Wave 65: question, permission, and plan routes live in 13d-core-domain-routes.js.
  await handleInterventionApiRoutes(req, res, pathname); if (res.writableEnded) return;
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
      const result = await missionControlCommand(sessionId, 'stop');
      return send(res, json(result.body, result.status));
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
      const resultBefore = String(session.mission && session.mission.result && session.mission.result.status || '');
      await maybeFinalizeMission(session, 'check'); // 第72波:全 done 盖 complete 章
      await saveSession(session);
      if (session.mission) {
        const resultAfter = String(session.mission.result && session.mission.result.status || '');
        const revision = await bumpMissionChangeSeq(sessionId, {
          type: resultAfter && resultAfter !== resultBefore ? 'result' : 'progress',
          cursor: { action: 'check' },
          detail: { checks: results.length, passed: results.filter(item => item.result && item.result.pass).length, status: resultAfter },
        });
        if (revision) session.mission.changeSeq = revision;
      }
      emitMission();
      return send(res, json({ ok: true, mission: session.mission || null, checks: results }));
    }
    // start = 全量新建(normalizeMission,prev=null);update = 按 id 增量合并(applyMissionUpdate,不抹其它里程碑)。
    // autoMode 可作 body 兄弟字段或 mission.autoMode 传入,两条路径都尊重。
    // 对抗轮 P1: trusted = 【header token】(UI/用户)——只有它能定义机器 check;body-token loopback(模型经 MCP 子进程)
    // 视为不可信,不能设 check.cmd。header token 存在即 UI 直连(浏览器 CORS 拿不到该 token)。
    const trusted = tokenOk(req);
    const resultBefore = String(session.mission && session.mission.result && session.mission.result.status || '');
    if (action === 'start') {
      const input = { ...(bodyOrQ.mission || bodyOrQ) };
      if (bodyOrQ.autoMode != null && input.autoMode == null) input.autoMode = bodyOrQ.autoMode;
      session.mission = normalizeMission(input, null, trusted);
      session.mission.startedTurnSeq = Math.max(1, (Number(session.turnSeq) || 0) + 1);
      session.kind = 'mission'; // 第70波(EC-E):start 是显式任务动作 → Quick Ask 翻转 Mission(非启发式)
      logEvent({ kind: 'mission_start', sessionId, trusted, autoMode: session.mission.autoMode }); // 29c: 预算超支率的分母
    } else {
      if (!session.mission) return send(res, json({ ok: false, error: '当前会话没有活动任务账本;请先 action:start' }, 400));
      session.mission = applyMissionUpdate(session.mission, bodyOrQ.patch || bodyOrQ, trusted);
      if (bodyOrQ.autoMode != null) session.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : session.mission.autoMode;
      await maybeFinalizeMission(session, 'update'); // 第72波:全 done 盖 complete 章 / 再武装清旧章
    }
    await saveSession(session);
    if (session.mission) {
      const resultAfter = String(session.mission.result && session.mission.result.status || '');
      const revision = await bumpMissionChangeSeq(sessionId, {
        type: action === 'start' ? 'mission_started' : (resultAfter && resultAfter !== resultBefore ? 'result' : 'progress'),
        cursor: { action },
        detail: {
          status: resultAfter,
          autoMode: session.mission.autoMode || 'off',
          milestonesTotal: Array.isArray(session.mission.milestones) ? session.mission.milestones.length : 0,
          milestonesDone: Array.isArray(session.mission.milestones) ? session.mission.milestones.filter(item => item && item.status === 'done').length : 0,
        },
      });
      if (revision) session.mission.changeSeq = revision;
    }
    emitMission();
    // C4 (75a-3): sync the mission change to the active turn's in-memory session, so the provider round-tail
    // saveSession (09:1924) doesn't cover back this route mutation. provider engine updates mission in-process
    // (09:1719) and saves only at round-tail; without sync the turn's stale in-memory mission clobbers the
    // route mutation. 'update' applies the patch (merge via applyMissionUpdate, preserving in-process
    // mission_update changes); start/stop/check replace (full-state action). claude engine re-reads at 05:765
    // instead (its mission_update loops back to disk), so it doesn't need this sync.
    { const reg = activeChildren.get(sessionId); if (reg && reg.session && reg.session !== session) {
      if (action === 'update' && reg.session.mission) {
        reg.session.mission = applyMissionUpdate(reg.session.mission, bodyOrQ.patch || bodyOrQ, trusted);
        if (bodyOrQ.autoMode != null) reg.session.mission.autoMode = ['off', 'until-done', 'supervised'].includes(bodyOrQ.autoMode) ? bodyOrQ.autoMode : reg.session.mission.autoMode;
        // 第97波对抗复审(B2):本路由已把磁盘权威侧落盘(含 maybeFinalizeMission 盖的 complete/stopped 章
        // 与归档的 resultHistory);reg 内存侧只是 applyMissionUpdate 深拷旧值,result/resultHistory 仍是旧的。
        // 若不同步,09/provider 回合收尾 saveSession(reg.session)会用陈旧内存覆盖磁盘,新章与归档整条丢失。
        // 同步磁盘权威的 result 与 resultHistory(归档历史是追加语义,以磁盘为准)。
        reg.session.mission.result = session.mission && session.mission.result || null;
        reg.session.mission.resultHistory = Array.isArray(session.mission && session.mission.resultHistory) ? session.mission.resultHistory.slice(-10) : [];
        if (session.mission && session.mission.result && session.mission.result.status === 'complete' && resultBefore !== 'complete') {
          Object.defineProperty(reg.session, '__missionFinalizeHow', { value: 'update', writable: true, configurable: true, enumerable: false });
        }
      } else {
        reg.session.mission = session.mission;
        if (action === 'start') reg.session.kind = 'mission';
      }
    } }
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
    const reg = activeChildren.get(sessionId);
    const provider = resolveProvider(config, body.providerId)
      || activeOpenAiProvider(config)
      || (config.providers || []).find(p => p && p.baseUrl && (p.model || (p.models && p.models.length)));
    // A direct UI/MCP launch has no active parent registry. In a Claude-only installation, defaulting such
    // a launch to OpenAI manufactured an unusable route with provider=null and failed before the fake/real
    // Claude child could start. Choose from actual availability when no live parent turn exists.
    const parentEngine = reg ? (reg.kind === 'claude' ? 'claude' : 'openai') : (provider ? 'openai' : 'claude');
    const parentModel = parentEngine === 'claude'
      ? String(config.model || '')
      : String(provider && (provider.model || (provider.models && provider.models[0] && (provider.models[0].id || provider.models[0]))) || '');
    const claudeCli = config.claudePath || detectClaudePath();
    const claudeCliUsable = Boolean(process.env.WCW_FAKE_CLAUDE) || Boolean(claudeCli && existsExecutable(claudeCli)); // test seam, see runClaudeTurn
    // Only reject up front when NEITHER engine could possibly run anything; a specific node explicitly
    // requesting an unavailable engine still fails gracefully per-node inside runAgentWorkflow.
    if (!provider && !claudeCliUsable) {
      return send(res, json({ ok: false, error: 'Agent DAG 需要至少配置一个 OpenAI 兼容 Provider，或安装并配置 Claude CLI' }, 400));
    }
    const onEvent = reg && reg.onEvent ? reg.onEvent : () => {};
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
      void runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: config.permissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, runIdOverride: runId, onComplete: completion, poolPolicy: body.poolPolicy, parentEngine, parentModel }).catch(async e => {
        activeAgentRuns.delete(runId); // 对抗轮 P2: 启动期抛出时兜底清注册(与 launchPersistedAgentRun 的 catch 对齐)
        const run = { schemaVersion: 4, id: runId, sessionId: session.id, turnSeq: session.turnSeq, providerId: provider && provider.id || '', status: 'failed', createdAt: nowIso(), updatedAt: nowIso(), completedAt: nowIso(), error: String(e && e.message || e), nodes: [] };
        await saveAgentRun(run).catch(() => {});
        await completion(run).catch(() => {});
      });
      return send(res, json({ ok: true, accepted: true, runId }));
    }
    const result = await runAgentWorkflow({ parentSession: session, provider, config, nodes: resolved.nodes, onEvent, permModeOverride: config.permissionMode, maxNodes: Math.max(0, Number(config.agentWorkflowMaxNodes) || 0), contextText, onComplete: activeChildren.has(session.id) ? null : completion, poolPolicy: body.poolPolicy, parentEngine, parentModel });
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
      return send(res, json({ ok: true, range, totals: { inTok: 0, outTok: 0, cachedInTok: 0, turns: 0, estimatedTurns: 0, planBasedTurns: 0, costsByCurrency: {} }, byEngine: [], byProvider: [], bySession: [], byDay: [], budget: null }));
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
  // EC-D Wave 65: Agent Run query, event, and control routes live in 13d-core-domain-routes.js.
  await handleAgentRunApiRoutes(req, res, pathname); if (res.writableEnded) return;
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
  // User-clicked handoff to the native editor selected by Windows for code files. POST body:
  // {sessionId,turnSeq,entrySeq?,action:'diff'|'open'}. Omit entrySeq to open every distinct code-file diff
  // in the turn (bounded to 12). Unlike office_open this never hands source files to an arbitrary association:
  // resolvePreferredCodeEditor accepts only known editors/IDEs, preventing `.js` -> WScript execution.
  if (req.method === 'POST' && pathname === '/api/checkpoints/open-external') {
    if (process.platform !== 'win32') return send(res, apiFailure('editor.platform_unsupported', {}, '仅支持 Windows', 400));
    const body = await readJsonBody(req);
    const sessionId = safeSessionId(body && body.sessionId);
    const turnSeq = Number(body && body.turnSeq);
    const hasEntrySeq = body && body.entrySeq !== undefined && body.entrySeq !== null && body.entrySeq !== '';
    const entrySeq = hasEntrySeq ? Number(body.entrySeq) : null;
    const action = body && body.action === 'open' ? 'open' : 'diff';
    if (!sessionId) return send(res, apiFailure('session.id_invalid', {}, 'invalid sessionId', 400));
    if (!Number.isInteger(turnSeq) || turnSeq < 0 || (hasEntrySeq && (!Number.isInteger(entrySeq) || entrySeq < 0))) {
      return send(res, apiFailure('checkpoint.reference_invalid', {}, 'invalid turnSeq or entrySeq', 400));
    }
    if (action === 'open' && !hasEntrySeq) return send(res, apiFailure('checkpoint.reference_invalid', {}, 'entrySeq is required for open', 400));
    const session = await loadSession(sessionId);
    if (!session) return send(res, apiFailure('session.not_found', {}, 'session not found', 404));
    const config = await readConfig();
    const turnEntries = (await journalReadIndex(sessionId))
      .filter(e => e && Number(e.turnSeq) === turnSeq)
      .sort((a, b) => Number(a.entrySeq) - Number(b.entrySeq));
    let targets = hasEntrySeq ? turnEntries.filter(e => Number(e.entrySeq) === entrySeq) : turnEntries;
    if (!targets.length) return send(res, apiFailure('checkpoint.not_found', {}, 'entry not found', 404));
    if (!hasEntrySeq) {
      const earliestByPath = new Map();
      for (const entry of targets) {
        const key = workspaceBaselinePathKey(entry.path);
        if (!earliestByPath.has(key)) earliestByPath.set(key, entry);
      }
      targets = [...earliestByPath.values()].slice(0, 12);
    }
    const opened = [], failed = [];
    for (const entry of targets) {
      const sourcePath = String(entry.path || '');
      if (!workspaceBaselineIsCodePath(sourcePath)) { failed.push({ entrySeq: entry.entrySeq, reason: '不是支持的代码/文本文件' }); continue; }
      const guard = await guardWorkspacePath(sourcePath, session, config);
      if (!guard.ok) { failed.push({ entrySeq: entry.entrySeq, reason: guard.error }); continue; }
      let exists = false;
      try { exists = (await fsp.stat(guard.absPath)).isFile(); } catch { exists = false; }
      if (entry.op !== 'delete' && !exists) { failed.push({ entrySeq: entry.entrySeq, reason: '当前文件不存在' }); continue; }
      const editor = resolvePreferredCodeEditor(sourcePath);
      if (!editor) { failed.push({ entrySeq: entry.entrySeq, reason: '未检测到安全的本机代码编辑器；请先为任一代码文件选择默认编辑器' }); continue; }
      let spawnSpec;
      if (action === 'open') {
        if (entry.op === 'delete') { failed.push({ entrySeq: entry.entrySeq, reason: '文件已删除，请使用 Diff 查看删除前内容' }); continue; }
        spawnSpec = buildCodeEditorSpawn(editor, 'open', '', guard.absPath);
      } else {
        const materialized = await materializeCheckpointEditorDiff(sessionId, entry, exists ? guard.absPath : '');
        if (!materialized.ok) { failed.push({ entrySeq: entry.entrySeq, reason: materialized.error }); continue; }
        spawnSpec = buildCodeEditorSpawn(editor, 'diff', materialized.beforePath, materialized.afterPath);
        // Generic safe editors have no command-line diff contract. Keep the browser's internal diff as the
        // comparison view and open the meaningful side in the native editor (before for a deletion).
        if (spawnSpec.diffUnsupported) spawnSpec.args = [entry.op === 'delete' ? materialized.beforePath : materialized.afterPath];
      }
      if (!spawnSpec.ok || !await launchCodeEditor(spawnSpec)) {
        failed.push({ entrySeq: entry.entrySeq, reason: spawnSpec.error || '无法启动本机编辑器' });
        continue;
      }
      opened.push({ entrySeq: Number(entry.entrySeq), editor: spawnSpec.editor, mode: spawnSpec.mode,
        source: spawnSpec.source, diffSupported: !spawnSpec.diffUnsupported });
    }
    if (!opened.length) {
      const reason = failed[0] && failed[0].reason || '没有可打开的代码改动';
      return send(res, apiFailure('editor.open_failed', { failed: failed.length }, reason, 409));
    }
    logEvent({ kind: 'checkpoint_external_open', sessionId, turnSeq, action, opened: opened.length,
      failed: failed.length, editor: opened[0].editor, mode: opened[0].mode });
    return send(res, json({ ok: true, action, opened, failed, limited: !hasEntrySeq && turnEntries.length > targets.length }));
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
  // 49f(A1): MCP 域路由抽至 13b-api-domain-routes.js(import-folder/import-config scan|apply)。
  await handleMcpApiRoutes(req, res, pathname); if (res.writableEnded) return; // send 无返回值,以响应已结束为命中信号
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
  // 49f(A1): checkpoint·storage 域路由抽至 13b-api-domain-routes.js。
  await handleCheckpointApiRoutes(req, res, pathname); if (res.writableEnded) return;
  // 49f(A1): steer 域路由抽至 13b-api-domain-routes.js。
  await handleSteerApiRoute(req, res, pathname); if (res.writableEnded) return;
  // 第53波 EC-B(53b): overlay 离线更新域路由抽至 13c-overlay-routes.js(precheck/apply/rollback/status,编排 Manage-Overlay.ps1)。
  await handleOverlayApiRoutes(req, res, pathname); if (res.writableEnded) return;
  if (req.method === 'POST' && pathname === '/api/upload') {
    const body = await readJsonBody(req);
    const file = await makeAttachmentRecord(body);
    return send(res, json({ ok: true, file }));
  }
  // 图片/附件回显:读取 makeAttachmentRecord 写下的上传件原字节(聊天气泡里的图片缩略图/大图)。
  // 只读内容型 GET:token 门 + handler 自查(同 /api/file/preview 纵深);第二道闸把目标锁死在
  // uploads 根内(词法 + realpath 双校验,符号链接也逃不出),服务面 = 工作台自己写过的上传目录。
  if (req.method === 'GET' && pathname === '/api/upload/content') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const q = new URL(req.url, 'http://x').searchParams;
    const id = String(q.get('id') || '');
    const name = String(q.get('name') || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return send(res, apiFailure('upload.id_invalid', {}, 'invalid upload id', 400));
    // name 只许纯 basename(无分隔符/无 ..);与 makeAttachmentRecord 的 safeName 同域。
    if (!name || name.length > 255 || name !== path.basename(name) || name === '.' || name === '..') {
      return send(res, apiFailure('upload.name_invalid', {}, 'invalid attachment name', 400));
    }
    const uploadsRoot = await fsp.realpath(paths.uploads).catch(() => paths.uploads);
    const target = path.resolve(path.join(paths.uploads, id, name));
    if (!pathWithinRoot(target, path.normalize(paths.uploads))) return send(res, apiFailure('upload.not_found', {}, 'attachment not found', 404));
    const real = await fsp.realpath(target).catch(() => null);
    if (!real || !pathWithinRoot(real, uploadsRoot)) return send(res, apiFailure('upload.not_found', {}, 'attachment not found', 404));
    let buffer = null;
    try { buffer = await fsp.readFile(real); } catch { buffer = null; }
    if (!buffer) return send(res, apiFailure('upload.not_found', {}, 'attachment not found', 404));
    return send(res, { status: 200, headers: { 'content-type': contentTypeFor(name), 'cache-control': 'private, max-age=86400' }, body: buffer });
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
  await markInterruptedInterventions(); // 第71波:重启终态化 pending Intervention(与 markInterruptedAgentRuns 对称,不重挂)
  // Wave 80: start warming after crash/intervention reconciliation and overlap it with configuration sync
  // plus the default classic-shell hydration. It never delays listen; the empty-directory guard keeps later
  // external-import discovery authoritative.
  void warmPretenderProjectionIndex().catch(() => {});
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
  let config = await readConfig(); // let: autoImportClaudeCodeMcp 写回后需重绑到最新引用
  // v2 工作台记忆接管 ACC Memory：启动期一次性、幂等导入。失败只记审计且保留 ACC memory 工具，
  // 不阻断工作台；成功标记会让后续生成/桥接的 ACC 进程隐藏旧工具面。
  const accMemoryMigration = await migrateLegacyAccMemory().catch(e => ({ ok: false, error: (e && e.message) || String(e) }));
  if (!accMemoryMigration.ok) logEvent({ kind: 'acc_memory_import_failed', error: accMemoryMigration.error || 'unknown error' });
  // v1.4.3: sync settings, agent roles, and MCP servers to Claude CLI's own config on startup
  await syncClaudeCliSettings(config);
  await syncAgentRolesToClaude(config.defaultWorkspace || os.homedir(), config);
  // v2.7.1 (boot fix): claude add-json 串行慢,await 拖死 boot(10 MCP x <=10s)。fire-and-forget:
  // 后台同步最多 15s 预算,超预算余量丢弃(add-json 幂等,下次 boot 补齐);与下方 autoImport 的竞态只影响
  // "本次是否拉到 Claude 新增 MCP",最坏下次 boot 补齐,可接受。
  void syncMcpServersToClaude(config).catch(() => {});
  if (config.agentCliType === 'kimi') void syncMcpServersToKimi(config).catch(() => {});
  // 把本机 Claude Code 注册的 MCP(~/.claude.json mcpServers)自动映射进 Ruyi(逆向于上面的 sync)。
  // 在 syncMcpServersToClaude 之后跑:Claude 的 user-scope 配置已是最新全量,只导入 Ruyi 还没有的 id。
  // 失败仅审计不阻断 boot;返回的 config 是写回后的最新引用,避免后续 generateMcpConfig 用陈旧 config。
  {
    const imp = await autoImportClaudeCodeMcp(config).catch(() => null);
    if (imp && imp.config) config = imp.config;
    if (imp && imp.added) console.log(`Auto-imported ${imp.added} MCP server(s) from Claude Code: ${(imp.ids || []).join(', ')}`);
  }
  // v1.9 数据管家: boot sweep(fire-and-forget —— 慢盘/清理失败绝不阻塞 boot;结果落审计账 storage_sweep)。
  void storageSweep(config.storagePolicy).catch(() => {});
  // G1: 预热能力矩阵(网络探测/桌面 MCP 探测/二进制探测,首次可达 10s+)。fire-and-forget —— 探测慢/失败绝不
  // 阻塞 listen;首个用户回合或子代理调用 getCapabilities 时命中 60s 缓存,冷启动不再吃满探测耗时。
  void getCapabilities(config).catch(() => {});
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
      return send(res, await serveStatic(u.pathname, req));
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

// 第44波(模型列表 API 化,44e 修订):显示预设只剩「默认(CLI 配置)」——版本化型号(如 claude-opus-4-8)与 CLI
// 内建别名(opus/sonnet/haiku)都【不进列表】;真实清单 = 代理 /v1/models 发现缓存(getProxyModelsCache)
// + 用户自定义(extraModels/knownModels)。别名集合仍保留作引擎归属判定(CLAUDE_ALIAS_IDS,见下)。
const MODEL_PRESETS = [
  { id: '', label: '默认 (CLI 配置)' },
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

// Kimi's `--model` values are aliases from `kimi provider list --json` (for example
// `kimi-code/k3-256k`), not the bare backend model ids historically remembered by the Claude adapter.
// The no-discovery form is intentionally tiny so Claude knownModels never leak into the Kimi picker.
function kimiModelList(config, discovered) {
  const seen = new Map([['', { id: '', label: '默认 (Kimi 配置)' }]]);
  const add = (id, label, contextLength) => {
    const key = String(id || '').trim();
    if (!key || seen.has(key)) return;
    const item = { id: key, label: String(label || key).trim() || key };
    const cl = Number(contextLength);
    if (Number.isFinite(cl) && cl > 0) item.contextLength = Math.round(cl);
    seen.set(key, item);
  };
  if (Array.isArray(discovered)) {
    for (const item of discovered) add(item && item.id, item && item.label, item && item.contextLength);
  } else if (config && config.model) {
    add(config.model, `${config.model} (当前选择)`);
  }
  return [...seen.values()];
}

// Query the installed Kimi Code CLI itself, which is the source of truth for OAuth-managed and custom
// providers. This is local/read-only and avoids baking account-specific aliases into Ruyi.
function discoverKimiModels(config) {
  const fallback = kimiModelList(config);
  const selected = selectedAgentCli({ ...(config || {}), agentCliType: 'kimi' });
  if (!selected.path) return Promise.resolve({ ok: false, models: fallback, discoveredCount: 0, error: '未检测到 Kimi Code CLI' });
  const launch = prepareAgentCliSpawn('kimi', selected.path, ['provider', 'list', '--json']);
  return new Promise(resolve => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      try { if (child && !child.killed) child.kill(); } catch { /* best effort */ }
      finish({ ok: false, models: fallback, discoveredCount: 0, error: '读取 Kimi Code 模型列表超时' });
    }, 10000);
    try {
      child = cp.spawn(launch.command, launch.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...launch.opts });
    } catch (error) {
      finish({ ok: false, models: fallback, discoveredCount: 0, error: `无法启动 Kimi Code CLI: ${redact(error && error.message || String(error))}` });
      return;
    }
    child.stdout.on('data', chunk => { if (stdout.length < 1024 * 1024) stdout += decodeClaudeCliText(chunk); });
    child.stderr.on('data', chunk => { if (stderr.length < 64 * 1024) stderr += decodeClaudeCliText(chunk); });
    child.on('error', error => finish({ ok: false, models: fallback, discoveredCount: 0, error: `无法启动 Kimi Code CLI: ${redact(error && error.message || String(error))}` }));
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) {
        finish({ ok: false, models: fallback, discoveredCount: 0, error: redact(stderr.trim() || `Kimi Code CLI 退出码 ${code}`).slice(0, 1000) });
        return;
      }
      const parsed = safeJsonParse(stdout.trim(), null);
      const rawModels = parsed && parsed.models && typeof parsed.models === 'object' ? parsed.models : null;
      if (!rawModels || Array.isArray(rawModels)) {
        finish({ ok: false, models: fallback, discoveredCount: 0, error: 'Kimi Code 返回了无法识别的模型列表' });
        return;
      }
      const discovered = [];
      for (const [alias, raw] of Object.entries(rawModels).slice(0, 100)) {
        const id = String(alias || '').trim();
        if (!id) continue;
        const item = raw && typeof raw === 'object' ? raw : {};
        const display = String(item.displayName || item.model || id).trim() || id;
        discovered.push({ id, label: display === id ? id : `${display} · ${id}`, contextLength: Number(item.maxContextSize) || undefined });
      }
      finish({ ok: true, models: kimiModelList(config, discovered), discoveredCount: discovered.length });
    });
  });
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
const CLAUDE_ALIAS_IDS = new Set(['opus', 'sonnet', 'haiku']); // Claude CLI 内建别名(44e:仅引擎归属判定用 —— 用户 knownModels/extraModels 里的别名串仍归 Claude 侧、防混入 openai 组;不再进显示列表)
// 供编排者(AI)选型的可选模型清单 + 能力档位 + 按难度选型指引。【引擎分组】:OpenAI 节点用 provider 模型 + 用户
// 自定义(非预设);Claude 节点用代理发现缓存 ∪ 用户持有的别名(第44波,替代原硬编码版本型号;44e 别名出列表)。防 AI 给
// openai 节点选 Claude 别名(必失败)。label 扁平化防注入。
function buildModelHint(config, provider) {
  const all = offlineModelList(config).filter(m => m.id);
  if (!all.length) return '';
  // OpenAI 组【优先用当前激活 provider 声明的模型】—— 只有它们对该 provider 真实可用;knownModels/config.model 可能
  // 是【别的 provider】的模型(如 deepseek 激活时 knownModels 里的 qwen 属 dashscope),混进来会诱导 AI 选了必失败。
  // 直接从 provider.models 构建(它们未必在 offlineModelList 里),label 命中 offlineModelList 则取其 label。
  const provList = []; const seenP = new Set();
  const addP = id => { id = String(id || '').trim(); if (id && !seenP.has(id) && !CLAUDE_ALIAS_IDS.has(id)) { seenP.add(id); const f = all.find(m => m.id === id); provList.push(f || { id, label: id }); } };
  if (provider) { if (Array.isArray(provider.models)) for (const x of provider.models) addP((x && x.id) || x); if (provider.model) addP(provider.model); }
  // provider 声明了模型 → 只列这些;什么都没声明(自建单模型)→ 退回非预设自定义(尽力)。
  // 第44波: Claude 组 = 别名 ∪ 代理发现缓存(API 真实清单);openai 兜底池同步排除两者(防跨引擎诱导选错必失败)。
  const claudeCacheIds = new Set(getProxyModelsCache().models.map(m => m.id));
  const openaiModels = provList.length ? provList : all.filter(m => !CLAUDE_ALIAS_IDS.has(m.id) && !claudeCacheIds.has(m.id));
  const claudeModels = all.filter(m => CLAUDE_ALIAS_IDS.has(m.id) || claudeCacheIds.has(m.id)); // 别名(用户持有的) + 代理缓存(Claude)
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
  const pool = [...new Set(ids)].filter(id => !CLAUDE_ALIAS_IDS.has(id) && !claudeCacheIds.has(id)); // 排除 Claude 别名+代理缓存
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
  // 52x: 全局子 agent 优先模型(openai 引擎,跨 provider)--用户显式选择,优先于自动 tier
  if (engine === 'openai' && config && config.subagentPreferredModel) { const pm = String(config.subagentPreferredModel).trim().slice(0, 160); if (pm) return pm; }
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
    name: 'workbench_memory_list',
    description: 'List/search confirmed Workbench Memory metadata for the current project and global scope. Use when the user asks what is remembered or the injected memory preflight/index is insufficient. This does not read full bodies.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional relevance query. Omit to list newest entries.' },
        scope: { type: 'string', enum: ['all', 'project', 'global'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
  },
  {
    name: 'workbench_memory_read',
    description: 'Read one confirmed Workbench Memory entry by id. Read only entries relevant to the current request and verify stale facts against the workspace before relying on them.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Optional unless the same id exists in both scopes.' },
      },
    },
  },
  {
    name: 'workbench_memory_propose',
    description: 'Submit one durable memory candidate for user review. It never saves directly: the user must confirm the card shown after the turn. Use when the user explicitly asks to remember something, or for a stable preference, confirmed project convention/decision, or verified recurring lesson that is not already in repository files. Never include secrets, transient status, guesses, or ordinary task output.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['name', 'description', 'type', 'scope', 'body', 'reason'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 120 },
        description: { type: 'string', minLength: 1, maxLength: 400, description: 'When this memory is useful.' },
        type: { type: 'string', enum: ['preference', 'convention', 'lesson', 'reference'] },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Use global only for an explicitly cross-project personal preference.' },
        body: { type: 'string', minLength: 1, maxLength: 4000, description: 'Concise Markdown with conclusion, applicability and concrete practice.' },
        reason: { type: 'string', minLength: 1, maxLength: 240, description: 'Why this will remain useful across future sessions.' },
      },
    },
  },
  {
    name: 'workbench_memory_relation_propose',
    description: 'Propose a relation edge between two existing confirmed Workbench Memory entries (supports/contradicts/supersedes/derived_from). It never saves directly: the user must confirm the card after the turn. from/to must be memory ids that already exist in the same scope.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['type', 'from', 'to'],
      properties: {
        type: { type: 'string', enum: ['supports', 'contradicts', 'supersedes', 'derived_from'], description: 'How from relates to to.' },
        from: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Source memory id (must exist in the target scope).' },
        to: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Target memory id (must exist in the target scope).' },
        scope: { type: 'string', enum: ['project', 'global'], default: 'project', description: 'Scope of both from/to.' },
        note: { type: 'string', maxLength: 200, description: 'Optional short rationale for the relation.' },
        reason: { type: 'string', maxLength: 240, description: 'Why this relation is worth confirming.' },
      },
    },
  },
  {
    name: 'workbench_memory_revise',
    description: 'Propose a revision to an existing confirmed Workbench Memory entry (name/description/type/body). It never saves directly: the user must confirm the card after the turn. Provide the suggested replacement values; unchanged fields may be omitted.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id', 'reason'],
      properties: {
        id: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Memory id to revise.' },
        scope: { type: 'string', enum: ['project', 'global'], description: 'Scope of the target memory.' },
        name: { type: 'string', minLength: 1, maxLength: 120, description: 'Suggested replacement name (omit to keep).' },
        description: { type: 'string', minLength: 1, maxLength: 400, description: 'Suggested replacement description (omit to keep).' },
        type: { type: 'string', enum: ['preference', 'convention', 'lesson', 'reference'], description: 'Suggested replacement type (omit to keep).' },
        body: { type: 'string', minLength: 1, maxLength: 4000, description: 'Suggested replacement Markdown body (omit to keep).' },
        reason: { type: 'string', minLength: 1, maxLength: 240, description: 'Why the entry is stale/wrong and should be revised.' },
      },
    },
  },
  {
    name: 'workbench_memory_relation_revoke',
    description: 'Propose revoking (deleting) an existing memory relation edge. It never deletes directly: the user must confirm the card after the turn. Use relationId from listMemoryRelations or a prior confirmed relation.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['relationId'],
      properties: {
        relationId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Relation edge id to revoke.' },
        note: { type: 'string', maxLength: 200, description: 'Optional short rationale for revoking.' },
        reason: { type: 'string', maxLength: 240, description: 'Why this edge should be removed.' },
      },
    },
  },
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
    description: 'Terminate a shell session and its process tree. CAUTION: any un-consumed buffered output of that session is lost, and any long-running command inside it is killed.',
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
        timeoutMs: { type: 'number', description: '单请求超时（毫秒），默认 30s' },
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
    description: 'Send keystrokes to the active Windows application. CAUTION: keys go to whatever window currently has focus; SendKeys meta characters + ^ % ~ ( ) { } [ ] are live modifiers (e.g. ^s = Ctrl+S, %{F4} = Alt+F4). Confirm the focus target before sending, and prefer explicit app control over raw keys when possible.',
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
    name: 'codebase_symbol_search',
    description: 'Search a codebase for where a symbol (function/class/method/variable name) is defined and referenced, returning file-level definition/reference evidence grouped by file. Grep-level lexical scan (not AST/type-aware): it matches identifier occurrences by word boundary. Use when auditing or tracing where a symbol is defined and called, so claims are grounded in real file:line evidence instead of name-similarity guesses. Do not use for semantic/type-aware queries, cross-language resolution, or when an exact definition-vs-reference distinction matters (use a language server). The symbol argument is treated as a literal (regex metacharacters are escaped).',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'The symbol name to search (function/class/method/variable).' },
        root: { type: 'string', description: 'Codebase root directory (defaults to workspace).' },
        kind: { type: 'string', enum: ['any', 'definition', 'reference'], description: 'Only return definitions, references, or both (default any).' },
        maxResults: { type: 'number', description: 'Max total matches (default 200).' },
        maxFiles: { type: 'number', description: 'Max files scanned (default 1500).' },
        maxDepth: { type: 'number', description: 'Max directory depth (default 8).' },
        ignoreDirs: { type: 'array', items: { type: 'string' }, description: 'Extra dirs to skip (node_modules/.git/.venv always skipped).' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'debug_hypothesis',
    description: 'Advisory hypothesis/experiment/refutation ledger for structured debugging (bisect/elimination method). Tracks which hypotheses are pending/refuted/supported/confirmed so you can see how many remain unrefuted, catch repeated experiments, and avoid locking a root cause before excluding alternatives. It is a STATELESS helper (the ledger is carried in the conversation, not persisted server-side): pass the ledger returned by the previous call back on every subsequent call. Actions: init(hypotheses[]) to create the ledger, test(hypothesisId,result,evidence) to record a refuting/supporting experiment (refutation is sticky; a refuted hypothesis cannot be revived), conclude(hypothesisId) to lock the root cause (only a supported hypothesis may be concluded; warns if alternatives remain unexcluded), status to see stats + duplicate/contradiction warnings. Do not use when the bug is already obvious or there is nothing to disambiguate.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['init', 'test', 'conclude', 'status'], description: 'State-machine action.' },
        hypotheses: { type: 'array', items: { type: 'object' }, description: 'init: array of {id?, description, mechanism?, expectedEvidence?, verification?}.' },
        ledger: { type: 'object', description: 'Current ledger snapshot (previous call\'s returned ledger); required for test/conclude/status, ignored by init.' },
        hypothesisId: { type: 'string', description: 'test/conclude: target hypothesis id.' },
        result: { type: 'string', enum: ['supports', 'refutes', 'inconclusive'], description: 'test: experiment result.' },
        evidence: { type: 'string', description: 'test: what you did and what you observed.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'data_profile',
    description: 'Profile a data file (CSV/TSV/JSON/JSONL/text log) into a machine-computed summary: row/column counts, per-column type, null/unique counts, numeric min/max/mean/median/std + IQR outlier count, and sample values. Use to replace eyeballing a large file with file_read when you need its structure, scale and data-quality issues (missing/outliers/format) before planning an analysis. Do not use for small files where reading directly is cheaper, or for cleaning/transforming the data (this tool is read-only). Column type and outlier detection are statistical heuristics, not data lineage.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the data file to profile.' },
        maxRows: { type: 'number', description: 'Max rows to sample (default 2000).' },
        delimiter: { type: 'string', description: 'CSV/TSV delimiter; auto-detected when omitted.' },
        maxSampleValues: { type: 'number', description: 'Sample values shown per column (default 5).' },
      },
      required: ['path'],
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
    description: 'Pause and ask the user one to three concise questions in the workbench UI. Prefer 2-5 concrete, mutually exclusive options whenever the answer can be enumerated; put the recommended option first and label it (Recommended). Choice questions include an Other typed fallback by default. Use text-only mode only when options genuinely cannot represent the answer. The tool returns structured user answers; continue only after it returns.',
    inputSchema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: 3,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stable identifier within this request; generated when omitted' },
              header: { type: 'string', description: 'Short label for the question' },
              question: { type: 'string', description: 'The question shown to the user' },
              answerMode: { type: 'string', enum: ['single', 'multiple', 'text'], description: 'Single or multiple choice is preferred. Use text only when a useful finite option set cannot be offered. Inferred from options/multiSelect when omitted.' },
              options: {
                type: 'array', description: 'Prefer 2-5 concrete choices. Put the recommended option first and suffix its label with (Recommended). Omit only for genuinely open-ended text answers.',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Stable option identifier; generated when omitted' },
                    label: { type: 'string' },
                    description: { type: 'string' },
                  },
                  required: ['label'],
                },
              },
              multiSelect: { type: 'boolean', description: 'Legacy alias for answerMode=multiple' },
              allowOther: { type: 'boolean', default: true, description: 'With single/multiple choices, allow a custom typed fallback. Defaults to true; set false only when custom input would be invalid.' },
              otherLabel: { type: 'string', description: 'Optional label for the custom-answer choice' },
              otherPlaceholder: { type: 'string', description: 'Optional placeholder for the custom-answer input' },
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
    description: 'Delegate a self-contained subtask to an isolated sub-agent. Every accepted spawn is projected into the persistent Workbench DAG. Set background:true when the parent can continue useful independent work: the call returns a runId/nodeId receipt immediately, and wait_agents collects the result later. Omit background (or set false) only when the result is required before the parent can proceed. Independent calls in the same assistant message run concurrently up to the configured stage limit. For dependent orchestration, assign stable agentKey values and use completed earlier-stage keys in dependsOn; their conclusions are injected automatically. Dependencies in the same batch are refused. toolTier: read (default) | edit | exec. Sub-agents cannot spawn further sub-agents.',
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
        background: { type: 'boolean', description: 'true = launch into the Workbench DAG and return immediately so the parent can continue in parallel; later call wait_agents. false/default = wait for this result synchronously.' },
      },
      required: ['task'],
    },
  },
  {
    name: 'orchestrate_agents',
    description: "Run a persistent sub-agent DAG. The runtime emits workflow heartbeats during quiet windows, asks an overlong model node to wrap up, and stops only that node if it ignores the bounded grace period. Supports structured JSON Schema outputs, automatic Reviewer/Verifier quality gates, explicit vote-contract validation, deterministic voting/deduplication, cross-review, semantic loop progress keys, tool-evidence requirements, and per-node failure/dependency policies. Reliability guidance: give factual probes minSuccessfulToolCalls>=1; make unavailable schema fields nullable; use dependencyPolicy:'all_settled' only on fan-in nodes designed to consume failed inputs; set loop.progressPath to a stable structured field; every dependency of a vote node must explicitly output {verdict,confidence}. vote/dedupe nodes are deterministic aggregators and do NOT execute their task text, so keep synthesis in a preceding node. Two ways to call it: (1) author `nodes` inline for a one-off DAG, or (2) pass `workflowId` to reuse a saved/built-in template by id (available ids + when to reach for each are listed in the system prompt) plus `context` — a short description of THIS run's actual subject/task, since a template's node tasks are often generic placeholders with no subject of their own. Prefer (2) for complex, multi-step tasks that match a listed template; skip it for simple one-shot requests.",
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
              model: { type: 'string', description: 'optional explicit model override for THIS node. Omit by default so the runtime can validate and use the configured sub-agent preferred endpoint/model, then fall back to the current conversation endpoint/model. Set only when the user/task requires a different model; it must match the node engine.' },
              resources: { type: 'array', items: { type: 'string' }, description: 'exclusive resources required by this node; use read: prefix for shared access' },
              isolation: { type: 'string', enum: ['none', 'worktree'], description: 'worktree runs this node in a detached Git worktree and keeps its commit for explicit user application; never auto-merges' },
              outputSchema: { type: 'object', description: 'optional JSON Schema for this node final JSON value (objects, arrays, and primitives supported); invalid JSON/schema fails the node. Fields that may be unavailable must explicitly allow null, for example type:["integer","null"].' },
              context: { type: 'string', description: 'optional node-level context injected ONLY into this node (appended after the run-wide context). Use for per-node specifics (structure summary for exploration, concrete fragment for execution, artifact list for verify); omit to inherit only the run-wide context. Capped at 4000 chars.' },
              gate: {
                type: 'object', description: 'quality gate; reviewer/verifier roles get one automatically',
                properties: {
                  mode: { type: 'string', enum: ['review', 'verify', 'vote', 'cross_review', 'dedupe', 'coverage', 'propagate'], description: 'vote/dedupe/coverage/propagate are deterministic aggregator nodes and do not execute task' },
                  threshold: { type: 'number', description: 'vote pass ratio, 0..1' },
                  minApprovals: { type: 'number' },
                  minConfidence: { type: 'number', description: 'minimum aggregate vote confidence, 0..1' },
                  abstainThreshold: { type: 'number', description: 'negative votes below this confidence become abstentions; 0..1, default 0' },
                  inputSet: { type: 'array', items: { type: 'string' }, description: 'coverage items that must appear in upstream handledItems or findings/claims evidenceRefs' },
                  propagateKey: { type: 'string', description: 'item record key used to inherit assignments among equal-key items' },
                  allowPartialCoverage: { type: 'boolean', description: 'allow coverage nodes or model gates with uncovered items to succeed with a warning' },
                  allowPartial: { type: 'boolean', description: 'allow propagate nodes with unpropagated items to succeed' },
                  requireEvidence: { type: 'boolean', description: 'R1 high-stakes gate (audit/research). When true, structuredResult.findings claims whose evidenceRefs are missing/invalid/cross-workspace are marked unverified, and if any unverified claim exists the node is rejected (gate_unverified). Default false: unverified claims are merely marked, not blocking (backwards-compatible).' },
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
              replan: { type: 'boolean', description: 'R5: when true, a failed/rejected node generates a reviewable replanPatch proposal (status pending, never auto-applied). Default false = zero-migration.' },
            },
            required: ['id', 'task'],
          },
        },
        providerId: { type: 'string', description: 'optional explicit OpenAI-compatible provider override. Omit by default so runtime routing can validate the configured sub-agent preference and safely fall back to the current conversation route.' },
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
function sendMcpNotification(method, params) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
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
          const adaptiveAlways = new Set(['permission_prompt', 'list_tools', 'tool_search', 'tool_load', 'tool_invoke_read', 'tool_invoke_edit', 'tool_invoke_exec']);
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
          const progressToken = msg.params?._meta?.progressToken;
          const progressStartedAt = Date.now();
          // Claude CLI may attach an MCP progress token to a long tool call. Report elapsed liveness while
          // orchestrate_agents is waiting on the synchronous DAG result; this is in addition to the app-level
          // workflow heartbeat and helps MCP clients distinguish "still running" from a dead server.
          const progressTimer = name === 'orchestrate_agents' && progressToken != null ? setInterval(() => {
            const elapsedSec = Math.max(1, Math.round((Date.now() - progressStartedAt) / 1000));
            try { sendMcpNotification('notifications/progress', { progressToken, progress: elapsedSec, message: `Agent 工作流仍在运行 · ${elapsedSec}s` }); } catch {}
          }, 10000) : null;
          if (progressTimer && progressTimer.unref) progressTimer.unref();
          try {
            const result = await toolCall(name, args);
            // S1 修复:MCP tools/call 路径(Claude 引擎)原样直出大结果会灌爆 CLI context。
            // 经 truncateToolResult 截断(file_read 走 head/tail,其余 60KB+标记),与 OpenAI 引擎 push 路径一致。
            const text = truncateToolResult(name, JSON.stringify(result, null, 2));
            return sendMcp(msg.id, {
              content: [{ type: 'text', text }],
              isError: result.ok === false,
            });
          } finally {
            if (progressTimer) clearInterval(progressTimer);
          }
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
