// 118a-fix: 应用内手册阅读器的服务端事实源。
// 反模式治理:118a 的完成页只给了一行相对路径 + 「复制路径」,等于把用户推到文件管理器里自己找手册。
// 产品口径是「每件事都能在如意里做完」,所以手册改为应用内直接读:本端点只吐 markdown 原文,
// 前端用既有 marked + sanitizeNode 白名单管线渲染,不新增第二套解析器。
// 安全口径:docId 与 lang 都只在下面这张【源码写死】的白名单里查表,客户端字符串永不参与路径拼接,
// 因此不存在目录穿越面(id=../../.. 只会查不到表 -> 404)。
const HELP_DOC_FILES = Object.freeze({
  'user-guide': Object.freeze({ 'zh-CN': 'USER-GUIDE_CN.md', 'en-US': 'USER-GUIDE_EN.md' }),
  'admin-guide': Object.freeze({ 'zh-CN': 'ADMIN-GUIDE_CN.md', 'en-US': 'ADMIN-GUIDE_EN.md' }),
});
const HELP_DOC_LANGS = Object.freeze(['zh-CN', 'en-US']);
// 手册体量在 30~60KB 量级;512KB 上限只是防止有人把巨型文件放进 docs/manuals 后一次性灌进浏览器。
const HELP_DOC_MAX_BYTES = 512 * 1024;

// 手册目录。发布件把 docs/ 放在 Ruyi.exe 同级(externalRoot),源码运行时是 <repo>/ruyi-workbench/docs。
// 与 staticBase() 同一口径:先看外部目录,不存在则回落打包内相对路径。
function helpDocsDir() {
  const ext = path.join(externalRoot(), 'docs', 'manuals');
  try { if (fs.existsSync(ext)) return ext; } catch { /* 探测失败按不存在处理 */ }
  return path.join(__dirname, '..', 'docs', 'manuals');
}

// 标题取正文第一个一级标题;取不到就用文件名兜底(阅读器抬头永远有字)。
function helpDocTitle(markdown, fallback) {
  const line = String(markdown || '').split(/\r?\n/).find(l => /^#\s+\S/.test(l));
  return line ? line.replace(/^#\s+/, '').trim() : String(fallback || '');
}

// 118d: 「如意替你打开」的真动作通道。产品红线是不给路径让用户自己去文件管理器里找,
// 所以「打开数据目录 / 日志目录 / 工作文件夹 / 手册目录」由服务端直接把资源管理器开出来。
// 安全口径:请求只能传下面这张【源码写死】的枚举 key。绝对路径全部由服务端常量(paths.*)、
// 手册目录解析或当前会话的 cwd 推导,客户端字符串永不参与拼路径、也永不进 spawn 的 argv;
// 执行沿用 /api/file/reveal 的 DesktopShell.revealInExplorer(路径经环境变量交给 PowerShell 助手,
// 零 shell 拼接,且能把窗口提到前台 : 后台服务直接 spawn explorer 会开在浏览器后面)。
const OPEN_PATH_TARGETS = Object.freeze(['data', 'logs', 'workspace', 'manuals']);

// 118d: 应用内看日志。不是所有环境都有图形外壳(远程桌面/受控终端/精简部署),「打开日志目录」不能是
// 唯一出路,所以再给一条只读的尾部读取通道。日志文件名由服务端按当天日期自己生成,请求只能给行数。
const LOG_TAIL_MAX_LINES = 2000;
const LOG_TAIL_DEFAULT_LINES = 200;
// 只读文件尾部这么多字节再切行:日志按天滚动,单份也可能到几十 MB,整份读进内存没有必要。
const LOG_TAIL_MAX_BYTES = 2 * 1024 * 1024;

// 枚举 -> 绝对目录。data/logs 是 00-boot 的 paths 常量,manuals 复用手册阅读器的同一份目录解析,
// workspace 取当前会话 cwd;取不到就让调用方报 400,绝不去猜一个目录打开。
function openPathTargetDir(target, session) {
  if (target === 'data') return paths.data;
  if (target === 'logs') return paths.logs;
  if (target === 'manuals') return helpDocsDir();
  if (target === 'workspace') return String((session && session.cwd) || '');
  return '';
}

// 最近一份工作台日志(04-permission-runtime 的 logEvent 按天写 workbench-YYYY-MM-DD.ndjson)。
// 只在【服务端已知目录】里按【固定正则】筛文件名,不接受任何外部路径入参。
function latestLogFile() {
  let names = [];
  try { names = fs.readdirSync(paths.logs); } catch { return ''; }
  const hits = names.filter(n => /^workbench-\d{4}-\d{2}-\d{2}\.ndjson$/.test(n)).sort();
  return hits.length ? path.join(paths.logs, hits[hits.length - 1]) : '';
}

// 尾部若干行。startedMidFile 时首行大概率被切断(字节偏移不是行/字符边界),直接丢掉半行。
function tailLinesFromBuffer(buf, startedMidFile, wanted) {
  let text = buf.toString('utf8');
  if (startedMidFile) {
    const nl = text.indexOf('\n');
    text = nl >= 0 ? text.slice(nl + 1) : '';
  }
  const all = text.split(/\r?\n/).filter(line => line.length > 0);
  const lines = all.slice(Math.max(0, all.length - wanted));
  return { lines, more: all.length > lines.length };
}

// 118c: 启动体验。两件用户看得见的事,都通过 GET /api/status 的【一个】只读字段 startNotice 上线:
//   ① 上一次启动【失败】过 -- 失败时把人话写进 <data>/last-start-error.json,下一次成功启动读出来、
//      交给前端顶部条,读完立刻删文件(所以它天然是一次性的,不会反复骚扰)。
//   ② 本次启动【改用了别的端口】 -- 原端口被非工作台进程占着,自动往后找到第一个能用的。
// 选 /api/status 而不是新开一条路由:前端 boot 本来就必调 status,零新增路由、零新增鉴权判定点,
// route-inventory 不动;两个字段都是进程内常量派生,不读盘、不做任何探测。
const LAST_START_ERROR_FILE = 'last-start-error.json';
// 端口自动改用的搜索宽度:原端口 +1 .. +9。够覆盖「本机同时开了几个自建服务」的现实场景,
// 又不会在真的全被占满时无限试下去(九个都不行时报错并留下 last-start-error.json)。
const PORT_FALLBACK_SPAN = 9;
// 只认这三类:端口拿不到 / 数据目录写不进 / 其它启动异常。文件里出现别的 kind 一律当作损坏丢弃。
const START_ERROR_KINDS = Object.freeze(['port-unavailable', 'data-dir-unwritable', 'startup-failed']);
const START_NOTICE = { lastError: null, portFallback: null };

// 「怎么办」一句话。刻意不给命令行、不给要用户自己去开的路径:能在如意里做的事就指向如意里的入口。
function startErrorNextText(kind) {
  if (kind === 'port-unavailable') return '先关掉占着这些端口的那个程序(常见是另一个本机服务),再启动一次如意。';
  if (kind === 'data-dir-unwritable') return '磁盘可能满了,或者数据文件夹被安全软件锁住了。腾出一些空间后再启动一次如意。';
  return '再启动一次通常就好。如果一直起不来,在「帮助 → 查看日志」里把最后几行发给支持人员。';
}

// 失败落盘。best-effort:数据目录本身写不进时这一步当然也会失败,那就只剩 console 输出 --
// 这正是「数据目录不可写」这一类的诚实下限,绝不假装记下了。
async function writeStartError(kind, message) {
  const safeKind = START_ERROR_KINDS.includes(kind) ? kind : 'startup-failed';
  try {
    await fsp.mkdir(paths.data, { recursive: true });
    await atomicWriteJson(path.join(paths.data, LAST_START_ERROR_FILE), {
      at: nowIso(),
      kind: safeKind,
      message: String(message || '').slice(0, 800),
      next: startErrorNextText(safeKind),
    });
  } catch { /* 记不下就算了:失败信息此刻已经在 console 上 */ }
}

// 读出并删除。返回归一化后的记录(或 null)。删除放在读之后、判定之前:即使内容坏了也要清掉,
// 否则一份损坏的文件会永远赖在数据目录里。
async function consumeStartError() {
  const file = path.join(paths.data, LAST_START_ERROR_FILE);
  let raw = null;
  try { raw = safeJsonParse(await fsp.readFile(file, 'utf8'), null); } catch { raw = null; }
  try { await fsp.unlink(file); } catch { /* 没有这份文件是最常见的情况 */ }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = String(raw.kind || '');
  if (!START_ERROR_KINDS.includes(kind)) return null;
  return {
    at: String(raw.at || ''),
    kind,
    message: String(raw.message || '').slice(0, 800),
    next: String(raw.next || '').slice(0, 800) || startErrorNextText(kind),
  };
}

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
      // 118c: 一次性启动提示(上次启动失败的人话 / 本次改用了哪个端口)。纯进程内常量,恒定形状,
      // 两个位都可能为 null。前端顶部条消费,详见 START_NOTICE 处的口径说明。
      startNotice: START_NOTICE,
      // v0.8-S1: vendored-binary capability probe (additive). S6's capability matrix will formally own
      // this; the `rg` field is established here so file_search's fast-path status is observable now.
      binaries: { rg: hasRg() },
      // v0.9-S1 (C6): expose the ERROR_CLASSES table top-level so the error-humanization UI renders zh/next
      // from the single server-side source of truth (result.errorClass keys into this) — no double-maintain.
      errorClasses: ERROR_CLASSES,
      tools: MCP_TOOLS.filter(t => t.name !== 'observation_recall' || observationRecallEnabled(config)).map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
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
    return send(res, json(await DesktopShell.pickFolder()));
  }
  // 第53波 EC-B(53d): POST /api/pick-file - 原生文件选择器(OpenFileDialog,选 overlay zip 等)。token 级。
  if (req.method === 'POST' && pathname === '/api/pick-file') {
    const body = await readJsonBody(req);
    return send(res, json(await DesktopShell.pickFile(body && body.filter)));
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
      // 再无探测则使用版本化名称表，让离线 Provider 模型列表也能显示当前默认值；
      // 已有条目在 live 补到 contextLength 时就地补齐(only-add, 不改既有字段语义)。
      const add = (id, label, contextLength) => {
        const k = String(id || ''); if (!k) return;
        const cl = (Number.isFinite(contextLength) && contextLength > 0) ? Math.round(contextLength)
          : (cachedContextLength(provider.id, k) || contextWindowFromTable(k));
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
      if (cleaned.length >= memoryFixedSelectionMax(config)) break;
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
    const coreState = await resolveCoreMemoryState(cwd, registry, config).catch(() => ({ all: registry, active: [], standby: [], expired: [], stats: { total: registry.length, coreRequested: 0, active: 0, standby: 0, expired: 0, reviewDue: 0, charsUsed: 0, charLimit: coreMemoryCharBudget(config), itemLimit: coreMemoryMaxItems(config) } }));
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
  // 118a-fix: 应用内手册阅读器的取文端点。GET /api/help/doc?id=<docId>&lang=<zh-CN|en-US>
  // 只吐 markdown 原文,渲染在前端走既有 marked + sanitizeNode 白名单管线(help-viewer.js)。
  // 鉴权:ROUTE_AUTH 记 token 级(同 /api/file/preview),这里再自查一遍(GET 不过上面的变更类鉴权块)。
  // 第二道闸不是路径包含校验而是【查表】:id 与 lang 都只能命中 HELP_DOC_FILES 里写死的键,命不中即 404;
  // 真正拼进 path.join 的只有常量文件名,请求里的任何字符串都到不了文件系统,穿越面为零。
  // 降级:Slim 包可能不带 docs/ -> 200 {ok:false,error:'help.doc_missing'},前端在应用内解释,
  // 绝不回退成「自己去某个路径打开文件」。
  if (req.method === 'GET' && pathname === '/api/help/doc') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const q = new URL(req.url, 'http://x').searchParams;
    const id = String(q.get('id') || '');
    const variants = Object.prototype.hasOwnProperty.call(HELP_DOC_FILES, id) ? HELP_DOC_FILES[id] : null;
    if (!variants) return send(res, apiFailure('help.doc_unknown', {}, 'unknown help document id', 404));
    let lang = String(q.get('lang') || '');
    if (!HELP_DOC_LANGS.includes(lang)) {
      // 没显式指定语言就跟随配置;config.locale 可能是 'auto' 或非法值,一律回落中文。
      const config = await readConfig().catch(() => null);
      const configured = config ? String(config.locale || '') : '';
      lang = HELP_DOC_LANGS.includes(configured) ? configured : 'zh-CN';
    }
    const fileName = variants[lang];
    const target = path.join(helpDocsDir(), fileName); // fileName 来自白名单常量,不是请求数据
    let raw = null;
    try { raw = await fsp.readFile(target); } catch { raw = null; }
    if (!raw) return send(res, json({ ok: false, error: 'help.doc_missing', id, lang }));
    const truncated = raw.length > HELP_DOC_MAX_BYTES;
    let markdown = (truncated ? raw.subarray(0, HELP_DOC_MAX_BYTES) : raw).toString('utf8');
    // 截断按整行收口:按字节切可能把一个多字节字符劈开,丢掉尾行比留半个字符干净。
    if (truncated) markdown = markdown.slice(0, Math.max(0, markdown.lastIndexOf('\n')));
    const available = HELP_DOC_LANGS.filter(l => variants[l]);
    return send(res, json({ ok: true, id, lang, available, title: helpDocTitle(markdown, fileName),
      markdown, bytes: raw.length, truncated }));
  }
  // 118d: POST /api/open-path {target}. 帮助菜单的「打开数据目录 / 日志目录 / 工作文件夹 / 手册目录」。
  // 鉴权:ROUTE_AUTH 记 token 级(同 /api/file/reveal),这里再自查一遍作纵深。
  // 校验:target 必须命中 OPEN_PATH_TARGETS 这张源码枚举 -- 客户端【不能传路径】,所以既没有穿越面,
  // 也没有「target:'data;calc'」这类注入面(枚举外的值在拼路径之前就 400 掉了)。
  if (req.method === 'POST' && pathname === '/api/open-path') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const body = await readJsonBody(req).catch(() => ({}));
    const target = typeof (body && body.target) === 'string' ? body.target : '';
    if (!OPEN_PATH_TARGETS.includes(target)) {
      return send(res, apiFailure('openPath.target_unknown', {}, '只能打开如意自己的几个固定位置,不接受任意路径', 400));
    }
    if (process.platform !== 'win32') return send(res, json({ ok: false, error: '仅支持 Windows' }));
    const sessionId = safeSessionId(body && body.sessionId);
    const session = sessionId ? await loadSession(sessionId) : null;
    const dir = openPathTargetDir(target, session);
    if (!dir) {
      // 只可能是 workspace:当前会话还没有工作文件夹。给人话,不给路径。
      return send(res, apiFailure('openPath.workspace_missing', {}, '这个会话还没有选工作文件夹,先在上方选一个再打开', 400));
    }
    let exists = false;
    try { exists = fs.existsSync(dir); } catch { exists = false; }
    if (!exists) return send(res, apiFailure('openPath.missing', { target }, '这个位置暂时还不存在,等如意用一会儿再试', 404));
    const started = DesktopShell.revealInExplorer(dir, 'open');
    if (!started) return send(res, json({ ok: false, error: '无法打开资源管理器(系统未提供 PowerShell/Explorer)' }));
    logEvent({ kind: 'open_path', target, pathLen: dir.length });
    return send(res, json({ ok: true, target }));
  }
  // 118d: GET /api/logs/tail?lines=N. 应用内看日志(等宽只读面板 + 「复制全部」发给支持人员)。
  // 鉴权:ROUTE_AUTH 记 token 级;GET 不过变更类鉴权块,这里必须自查(与 /api/audit 同一纪律)。
  // 只读服务端自己的日志:文件名由 latestLogFile() 在已知目录里按固定正则挑,请求里只有一个数字 lines,
  // 上限 LOG_TAIL_MAX_LINES;没有日志文件时 200 降级(前端在应用内解释),不 500 也不回退成给路径。
  if (req.method === 'GET' && pathname === '/api/logs/tail') {
    if (!tokenOk(req)) return send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403));
    const q = new URL(req.url, 'http://x').searchParams;
    const asked = Number.parseInt(q.get('lines') || '', 10);
    const wanted = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), LOG_TAIL_MAX_LINES) : LOG_TAIL_DEFAULT_LINES;
    const file = latestLogFile();
    if (!file) return send(res, json({ ok: false, error: 'logs.none', maxLines: LOG_TAIL_MAX_LINES }));
    let handle = null;
    try {
      const st = await fsp.stat(file);
      const size = Math.min(st.size, LOG_TAIL_MAX_BYTES);
      const start = Math.max(0, st.size - size);
      const buf = Buffer.alloc(size);
      handle = await fsp.open(file, 'r');
      if (size > 0) await handle.read(buf, 0, size, start);
      const { lines, more } = tailLinesFromBuffer(buf, start > 0, wanted);
      // 只回文件名不回目录:面板抬头要能说清这是哪一天的日志,但界面上不出现任何可以「照着去找」的路径。
      return send(res, json({ ok: true, file: path.basename(file), lines, count: lines.length,
        requested: wanted, maxLines: LOG_TAIL_MAX_LINES, more }));
    } catch (e) {
      // 只回一个机器码,【不回 e.message】:Node 的 ENOENT/EPERM 文本里带着日志文件的绝对路径,
      // 回给前端就等于又把路径印到界面上了(本波要消灭的正是这类出口)。原因进结构化日志。
      logEvent({ kind: 'logs_tail_failed', error: String(e && e.message || e) });
      return send(res, json({ ok: false, error: 'logs.read_failed', maxLines: LOG_TAIL_MAX_LINES }));
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
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
    const okStarted = DesktopShell.revealInExplorer(guard.absPath, spawnSpec.mode);
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
// One listen attempt on an explicit port. Extracted from listenWithFallback so the 118c fallback scan can
// reuse it. A failed listen leaves the server unbound, so calling it again on another port is legal.
function listenOnce(server, port, host) {
  return new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, host);
  });
}

// 118c: 原端口拿不到时,顺序试 port+1 .. port+PORT_FALLBACK_SPAN,第一个能监听的就用它,并把
// 「原端口 -> 实际端口」登记进 START_NOTICE 让前端顶部条说清楚(「已改用 8766(原 8765 被占用)」)。
// 全部不可用才抛错,错误带上 ruyiStartErrorKind 供 startServer 写 last-start-error.json。
// 返回值是【实际】端口:runtime.json、控制台 URL、--open 一律用它,不存在「文件写 8765 实际在 8766」的分裂。
async function listenOnNextFreePort(server, port, host, why) {
  for (let step = 1; step <= PORT_FALLBACK_SPAN; step++) {
    const candidate = port + step;
    if (candidate > 65535) break;
    try {
      await listenOnce(server, candidate, host);
      START_NOTICE.portFallback = { requested: port, actual: candidate };
      console.log(`[port] :${port} unavailable (${why}) -- listening on :${candidate} instead.`);
      return candidate;
    } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
    }
  }
  const error = new Error(`${why} 随后自动改用的 ${port + 1}-${port + PORT_FALLBACK_SPAN} 端口也全部不可用。`);
  error.ruyiStartErrorKind = 'port-unavailable';
  throw error;
}

// Listen; on EADDRINUSE, free a stale workbench (if allowed + safe) and retry a few times.
// 118c: 每一条「拿不到原端口」的岔路都不再是死路 -- 统一交给 listenOnNextFreePort 往后找。
// 自动接管被禁用时同样往后找:那个开关的语义是「不许杀别人的进程」,不是「必须占住这个端口不放」。
async function listenWithFallback(server, port, host, config) {
  const attempt = () => listenOnce(server, port, host);
  try { await attempt(); return port; }
  catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    const envDisabled = /^(0|false|off|no)$/i.test(String(process.env.WCW_KILL_PORT || ''));
    if (envDisabled || config.killPortOnStart === false) {
      return await listenOnNextFreePort(server, port, host,
        `端口 ${port} 已被占用,且已禁用自动接管(killPortOnStart=false / WCW_KILL_PORT=0)。`);
    }
    console.log(`[port] :${port} in use -- checking whether it's a stale workbench...`);
    const res = await freeStalePort(port, host);
    if (!res.ok) {
      return await listenOnNextFreePort(server, port, host,
        `端口 ${port} 被其它程序占用(PID ${res.blocked.pid} / ${res.blocked.image}),没有去误杀它。`);
    }
    for (let i = 0; i < 25; i++) {
      await sleep(160);
      try {
        await attempt();
        if (res.killed.length) console.log(`[port] reclaimed :${port} (freed ${res.killed.length} stale process(es)).`);
        return port;
      } catch (e2) { if (e2.code !== 'EADDRINUSE') throw e2; }
    }
    return await listenOnNextFreePort(server, port, host,
      `端口 ${port} 在结束 ${res.killed.length} 个陈旧进程后仍然无法监听。`);
  }
}

// 118c: 启动失败必须在【应用里】看得见,而不是只打在一个用户根本没打开的终端上。
// 这层薄包装把三类致命失败落成 <data>/last-start-error.json(人话 + 下一步),
// 下一次成功启动由 startServerInner 读出来交给前端顶部条;console 输出与退出码一字未改。
async function startServer(opts) {
  try {
    return await startServerInner(opts);
  } catch (error) {
    const kind = error && START_ERROR_KINDS.includes(error.ruyiStartErrorKind) ? error.ruyiStartErrorKind : 'startup-failed';
    const message = String((error && error.message) || error || '').slice(0, 800)
      || '如意启动时出错了,没能开起来。';
    await writeStartError(kind, message);
    throw error;
  }
}

async function startServerInner(opts) {
  try {
    await ensureDirs();
  } catch (error) {
    // 数据目录建不出来/写不进去(磁盘满、权限、被安全软件锁)。标类型后原样上抛,由 startServer 落盘。
    if (error && !error.ruyiStartErrorKind) error.ruyiStartErrorKind = 'data-dir-unwritable';
    throw error;
  }
  // 118c: 上一次启动失败的人话记录 -- 读出来挂进 START_NOTICE 并把文件删掉(一次性提示,不反复骚扰)。
  // 【必须在 listen 之前做】:listen 之后到 RUNTIME.port/host/token 赋值之间【不许有任何 await】。
  // 服务一旦开始监听,健康探针立刻就能通,而握手常量还没写好 -- 那段窗口里进来的请求会看到空 token,
  // 桥接子进程的回调、能力探测因此偶发失败。这是本刀第一版真实踩到的坑(capabilities e2e 稳定复现)。
  START_NOTICE.lastError = await consumeStartError();
  if (START_NOTICE.lastError) console.log(`[start] previous launch failed (${START_NOTICE.lastError.kind}): ${START_NOTICE.lastError.message}`);
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
  const requestedPort = Number(opts.port || process.env.PORT || DEFAULT_PORT);
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
  // 118c: 实际监听端口可能不是请求的那个(原端口被别的程序占着时自动往后找)。下面的 runtime.json、
  // 控制台 URL 与 --open 全部用【实际】端口,前端顶部条另有 START_NOTICE.portFallback 说明改用了谁。
  const port = await listenWithFallback(server, requestedPort, host, config);
  const url = `http://${host}:${port}/`;
  // Port+token handshake file for the permission-bridge MCP child; also useful for tooling.
  const runtimeToken = crypto.randomBytes(16).toString('hex');
  RUNTIME.port = port; RUNTIME.host = host; RUNTIME.token = runtimeToken;
  await atomicWriteJson(path.join(paths.data, 'runtime.json'),
    { port, host, pid: process.pid, token: runtimeToken, overlayId: OVERLAY_ID, version: VERSION, launchMode: LAUNCH_MODE, startedAt: nowIso() }).catch(() => {});
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

// 110-1: MCP_TOOLS 原生工具 schema 数组抽至 13f-native-tool-schemas.js。

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
          const listConfig = await readConfig().catch(() => null);
          const recallEnabled = observationRecallEnabled(listConfig);
          const listed = MCP_TOOLS.filter(t => {
            if (t.name === 'spawn_agent') return false;
            if (t.name === 'request_user_input' && !userInputEnabled) return false;
            if (t.name === 'observation_recall' && !recallEnabled) return false; // 105a: 双开关门
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
    const result = await DesktopShell.runProcess(config.claudePath, ['mcp', 'add-json', 'win-claude-workbench', JSON.stringify(JSON.parse(await fsp.readFile(mcpPath, 'utf8')).mcpServers['win-claude-workbench'])], {
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

// ── 118b: `doctor --human` ─────────────────────────────────────────────────────────────────────────
// 默认输出仍是逐字节不变的 JSON(脚本依赖它);加 --human 才多打一段人话体检,让支持人员可以直接让用户
// 跑一条命令、念出结果,而不必读 JSON。
//
// 文案不在这里重抄一遍:直接读前端 i18n 目录里同一批 health.* 键。之所以不抽公共模块,是因为两端的模
// 块制式本就不通 -- 前端 health-i18n.js 是浏览器原生 ES Module,服务端是 src/*.js 拼接出来的单文件
// CommonJS,任何「共享模块」都得在 public/ 与 src/ 之间新开一条跨制式引用。真正会重复的只剩下面这张
// 严重度小表(纯机器判定,没有文案),人话一个字都不重复。
const DOCTOR_HUMAN_LANGS = Object.freeze(['zh-CN', 'en-US']);
const DOCTOR_HEALTH_SEVERITY = Object.freeze({
  'agent-cli': Object.freeze({ ok: 'ok', bad: 'warn' }),
  'claude-cli': Object.freeze({ ok: 'ok', bad: 'warn' }),
  'data-writable': Object.freeze({ ok: 'ok', bad: 'error' }),
  'server-source': Object.freeze({ ok: 'ok', bad: 'ok' }),
  'mcp-target': Object.freeze({ ok: 'ok', bad: 'warn' }),
  'vendor-libs': Object.freeze({ ok: 'ok', bad: 'warn' }),
  'overlay-integrity': Object.freeze({ ok: 'ok', bad: 'error' }),
  'desktop-control': Object.freeze({
    ready: 'ok', disabled: 'warn', 'not-installed': 'warn',
    'python-missing': 'warn', preparing: 'warn', unreachable: 'error',
  }),
});
// 文案目录。与 helpDocsDir()/staticBase() 同一口径:先看发布件外部目录,再回落打包内相对路径。
function doctorLocaleCatalog(lang) {
  const file = DOCTOR_HUMAN_LANGS.includes(lang) ? lang : 'zh-CN';
  const candidates = [
    path.join(externalRoot(), 'app', 'public', 'locales', `${file}.json`),
    path.join(__dirname, 'public', 'locales', `${file}.json`),
  ];
  for (const full of candidates) {
    try { if (fs.existsSync(full)) return JSON.parse(fs.readFileSync(full, 'utf8')); }
    catch { /* 这一份读不通就试下一个候选 */ }
  }
  return {};
}
// health 条目 -> 变体键。desktop-control 的变体写在 detail 的状态前缀里;其余项只有 ok/bad 两态。
function doctorHealthVariant(item) {
  if (!item) return 'bad';
  if (item.id === 'desktop-control') return String(item.detail || '').split(':')[0].trim() || 'not-installed';
  return item.ok ? 'ok' : 'bad';
}
function doctorHealthSeverity(item) {
  const table = DOCTOR_HEALTH_SEVERITY[item && item.id];
  if (!table) return item && item.ok ? 'ok' : 'warn';
  return table[doctorHealthVariant(item)] || (item && item.ok ? 'ok' : 'warn');
}
// 只做 {{name}} 占位替换 -- 与前端 i18n interpolate 同一约定,不引入任何模板引擎。
function doctorFill(text, params) {
  return String(text || '').replace(/{{\s*([\w.-]+)\s*}}/g, (_m, key) => (params && key in params ? String(params[key]) : ''));
}
// 把 health[] 渲染成人话行。返回字符串数组(便于测试逐行断言),不直接 console.log。
function doctorHumanLines(health, catalog) {
  const pick = (key, fallback) => (typeof catalog[key] === 'string' && catalog[key] ? catalog[key] : fallback);
  const lines = [pick('health.cli.title', 'Ruyi health check')];
  for (const item of Array.isArray(health) ? health : []) {
    if (!item || item.id === 'claude-cli') continue; // claude-cli 与 agent-cli 是同一件事的旧别名,人话输出只列一次
    const id = String(item.id || '');
    const known = typeof catalog[`health.item.${id}.label`] === 'string';
    const variant = doctorHealthVariant(item);
    const severity = doctorHealthSeverity(item);
    const label = known ? catalog[`health.item.${id}.label`] : pick('health.item.unknown.label', 'Other check');
    const count = Number((String(item.detail || '').match(/(\d+)/) || [])[1] || 0);
    const hint = known
      ? doctorFill(catalog[`health.item.${id}.hint.${variant}`] || catalog[`health.item.${id}.hint.bad`] || '', { count })
      : pick(`health.item.unknown.hint.${item.ok ? 'ok' : 'bad'}`, '');
    const next = known ? String(catalog[`health.item.${id}.next.${variant}`] || '') : '';
    lines.push(`[${pick('health.status.' + severity, severity)}] ${label}`);
    if (hint) lines.push('    ' + hint);
    if (severity !== 'ok' && next) lines.push('    ' + pick('health.action.howto', 'What to do') + ': ' + next);
    lines.push('    ' + pick('health.tech.toggle', 'Technical details') + ': ' + id + ' · ' + String(item.detail || ''));
  }
  return lines;
}

async function doctor(argv) {
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
  // 118b: 加法开关。没有 --human 时上面的 JSON 就是全部输出,与历史逐字节一致。
  if (!(argv && (argv.human === true || argv.human === '1' || argv.human === 'true'))) return;
  // 刻意不在这里预热能力缓存:getCapabilities(force) 会真去把桌面 MCP 桥起来,子进程会把一次性 CLI
  // 的事件循环吊住(实测不退出)。所以 CLI 的桌面控制在冷缓存下如实报「正在准备中」,不为一行文案
  // 换一个会挂住的命令。
  const { health } = await computeHealth(config).catch(() => ({ health: [] }));
  const catalog = doctorLocaleCatalog(String(config.locale || ''));
  console.log('');
  for (const line of doctorHumanLines(health, catalog)) console.log(line);
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
