// Default internal MCP has no disk owner in its stdio process. Only a capability bound to
// the exact registered CLI execution may dispatch its RPCs in serve. Consumer and memory
// transports retain separate registries, credentials and tool surfaces.
const InternalMcpRelay = (() => {
  const route = '/api/mcp/internal/request', bodyCap = MAX_BODY_BYTES, frameCap = 64 * 1024 * 1024;
  const grants = new Set(), contexts = new WeakMap(), issuedContexts = new WeakSet();
  const mainOnly = new Set(['permission_prompt', 'request_user_input', 'todo_write', 'mission_update',
    'spawn_agent', 'orchestrate_agents', 'wait_agents', 'agent_result']);
  const fail = code => { throw Object.assign(Error('internal_mcp.' + code), { code: 'internal_mcp.' + code, statusCode: 403 }); };
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const equal = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
  const Hooks = { run: work => work() }; // Host may attach its integrated writer gate; no global coverage claim.
  function nodeCurrent(context) {
    const runtime = context?.runtime, node = context?.node;
    if (!runtime || activeAgentRuns.get(context.runId) !== runtime || runtime.run.sessionId !== context.session?.id
      || runtime.stopRequested || runtime.paused || runtime.ctrl?.signal?.aborted || AGENT_RUN_TERMINAL.has(runtime.run.status)
      || !node || !runtime.run.nodes.includes(node) || node.attempts !== context.attempt || !context.ctrl || context.ctrl.signal.aborted
      || !context.review && (runtime.nodeControls.get(node.id) !== context.ctrl || node.status !== 'running')) fail('unavailable');
    return context.session;
  }
  function current(grant) {
    const reg = grant?.reg;
    if (!grant || grant.revoked || !grants.has(grant) || !reg?.child
      || reg.child.exitCode !== null || reg.child.signalCode !== null) fail('unavailable');
    if (grant.nodeContext) return nodeCurrent(grant.nodeContext);
    if (activeChildren.get(grant.sessionId) !== reg || reg.internalMcpGrant !== grant || reg.exited || reg.state !== 'running'
      || !['claude', 'kimi-acp'].includes(reg.kind) || reg.executionOwner !== grant.executionOwner
      || grant.executionOwner.cancelRequested || turnSettlers.get(grant.sessionId) !== grant.executionOwner
      || reg.session?.id !== grant.sessionId) fail('unavailable');
    return reg.session;
  }
  function create({ session, executionOwner, config, packs = [], nodeContext = null }) {
    const sessionId = safeSessionId(session?.id || '');
    if (!sessionId || !config) fail('owner_unavailable');
    if (nodeContext) nodeCurrent(nodeContext);
    else if (!executionOwner || executionOwner.cancelRequested || turnSettlers.get(sessionId) !== executionOwner) fail('owner_unavailable');
    const token = crypto.randomBytes(32).toString('hex'), command = commandForSelfMcp(config.mcpCommandMode);
    const policy = Object.freeze({ mode: config.toolLoadingMode || 'auto', packs: Object.freeze([...new Set(packs)]),
      userInput: !nodeContext, steward: !nodeContext && session.kind === 'steward' });
    const env = Object.freeze({ RUYI_HOME: dataRoot(), RUYI_INTERNAL_MCP_PORT: String(RUNTIME.port), RUYI_INTERNAL_MCP_CAP: token,
      WCW_TOKEN: '', WCW_SESSION_ID: '', WCW_PORT: '', WCW_HOST: '' });
    return { sessionId, executionOwner, nodeContext, policy, tokenHash: digest(token), definition: Object.freeze({
      type: 'stdio', command: command.command, args: Object.freeze([...command.args]), env }), reg: null, revoked: false, inflight: 0 };
  }
  function createNode({ config, context }) {
    return create({ session: context?.session, config, nodeContext: context, packs: Object.keys(TOOL_PACK_DESCRIPTIONS) });
  }
  function revoke(grant, reg) {
    if (!grant || grant.reg !== reg || grant.revoked) return;
    grant.revoked = true; grant.tokenHash.fill(0); grants.delete(grant);
    if (grant.detach) { grant.detach(); grant.detach = null; }
    if (reg?.internalMcpGrant === grant) reg.internalMcpGrant = null;
    for (const controller of grant.controllers || []) controller.abort();
  }
  function bind(grant, reg, executionOwner) {
    if (!grant || grant.reg || grant.revoked || grant.nodeContext || executionOwner !== grant.executionOwner
      || reg.executionOwner !== executionOwner || activeChildren.get(grant.sessionId) !== reg
      || turnSettlers.get(grant.sessionId) !== executionOwner) fail('owner_unavailable');
    grant.reg = reg; reg.internalMcpGrant = grant; grants.add(grant);
    try { current(grant); } catch (error) { revoke(grant, reg); throw error; }
    reg.child.once('close', () => revoke(grant, reg)); reg.child.once('error', () => revoke(grant, reg));
  }
  function bindNode(grant, child) {
    if (!grant || grant.reg || grant.revoked || !grant.nodeContext) fail('owner_unavailable');
    nodeCurrent(grant.nodeContext); const reg = { child }; grant.reg = reg; grants.add(grant);
    try { current(grant); } catch (error) { revoke(grant, reg); throw error; }
    child.once('close', () => revoke(grant, reg)); child.once('error', () => revoke(grant, reg));
    const signal = grant.nodeContext.ctrl.signal, abort = () => revoke(grant, reg);
    signal.addEventListener('abort', abort, { once: true }); grant.detach = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) revoke(grant, reg);
  }
  function launchEnv(grant) { if (!grant || grant.revoked) fail('owner_unavailable'); return { ...grant.definition.env }; }
  function isContext(ctx) { return !!ctx && issuedContexts.has(ctx); }
  function contextOwner(ctx) {
    const state = ctx && contexts.get(ctx); if (!state) fail('unavailable');
    if (state.signal.aborted) fail('unavailable'); current(state.grant); return state;
  }
  function cliToolAllowed(name, grant) {
    return name !== 'mcp_resource' && (!grant.nodeContext || !mainOnly.has(name))
      && (name !== 'request_user_input' || grant.policy.userInput)
      && (!isStewardToolName(name) || grant.policy.steward);
  }
  function assertTool(ctx, name) {
    const state = contextOwner(ctx);
    if (!cliToolAllowed(name, state.grant)) fail('tool_not_allowed');
  }
  function resourceRefusal(ctx, name) {
    contextOwner(ctx);
    return name === 'mcp_resource' ? ManagedMcp.rejected({ code: 'privacy.mcp_native_turn_required' }) : null;
  }
  async function business(name, args, ctx) {
    const state = contextOwner(ctx), grant = state.grant;
    if (grant.nodeContext) return name === 'permission_prompt' ? { behavior: 'deny', message: 'permission bridge requires a main CLI turn' }
      : { ok: false, error: 'this tool requires a main CLI workbench turn' };
    const body = { ...args, sessionId: grant.sessionId }, options = { ownerReg: grant.reg, trusted: false,
      ownerCheck: () => contextOwner(ctx), isClosed: () => state.signal.aborted };
    let response;
    if (name === 'permission_prompt') response = await cliPermissionService({ sessionId: grant.sessionId,
      toolName: args.tool_name || args.toolName || args.name || 'unknown', input: args.input || args.tool_input || args.arguments || {} }, options);
    else if (name === 'request_user_input') response = await cliQuestionService(body, options);
    else if (name === 'todo_write') response = await cliTodoService(body, options);
    else if (name === 'mission_update') response = await cliMissionService({ sessionId: grant.sessionId,
      action: 'update', milestones: args.milestones, goal: args.goal }, options);
    else if (name === 'wait_agents' || name === 'agent_result') response = await cliAgentResultService(body, name === 'wait_agents' ? 'wait' : 'result', options);
    else if (name === 'orchestrate_agents') {
      const launch = { sessionId: grant.sessionId, background: args.background === true, envelope: true };
      for (const key of ['nodes', 'workflowId', 'context', 'providerId', 'task', 'role', 'agentKey', 'toolTier', 'maxIters', 'model', 'resources']) {
        if (Object.hasOwn(args, key)) launch[key] = args[key];
      }
      response = await cliAgentLaunchService(launch, options);
    }
    else fail('tool_not_allowed');
    contextOwner(ctx);
    const result = response ? JSON.parse(response.body) : { ok: false, error: 'request unavailable' };
    return name === 'mission_update' && result.ok ? { ok: true, mission: result.mission } : result;
  }
  async function dispatch(msg, grant, ctx, check, notify) {
        if (msg.method === 'initialize') {
          return ({
            protocolVersion: msg.params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: RUYI_MCP_SERVER_ID, version: VERSION }, // MCP 服务端标识名与 server id 一致
          });
        }
        if (msg.method === 'tools/list') {
          // 代理模式 v2:orchestrate_agents / wait_agents / agent_result 三个代理工具都可以 advertise —— 在 Claude/Kimi
          // 会话里它们回环到 serve 进程(/api/agent-workflow/launch|wait|result),节点由配置的 provider 或 Claude CLI 跑。
          const userInputEnabled = !grant.nodeContext && grant.policy.userInput;
          const mode = grant.policy.mode;
          const routedPacks = new Set(grant.policy.packs);
          routedPacks.add('core');
          const adaptiveAlways = new Set(['permission_prompt', 'list_tools', 'tool_search', 'tool_load', 'tool_invoke_read', 'tool_invoke_edit', 'tool_invoke_exec']);
          const listConfig = await readConfig(); check();
          PrivacyGateway.assertPolicyAvailable(listConfig);
          if (PrivacyGateway.enabled(listConfig)) return ({ tools: [], _meta: { privacy: 'privacy.engine_not_supported' } });
          const recallEnabled = observationRecallEnabled(listConfig);
          // 116c: Claude/Kimi CLI 桥的 offer 面。管家会话由注入的 WCW_SESSION_KIND 标识;缺失/非
          // 'steward' 一律隐藏 steward_*(fail-closed —— 普通 CLI 会话永远看不到管家工具)。
          const stewardSession = grant.policy.steward;
          const listed = MCP_TOOLS.filter(t => {
            if (!nativeToolAvailableInContext(t.name) || !cliToolAllowed(t.name, grant)) return false;
            if (t.name === 'request_user_input' && !userInputEnabled) return false;
            if (t.name === 'observation_recall' && !recallEnabled) return false; // 105a: 双开关门
            if (isStewardToolName(t.name) && !stewardSession) return false; // 116c: 管家工具族门
            if (mode !== 'auto') return true;
            return adaptiveAlways.has(t.name) || routedPacks.has(toolPackForName(t.name, {}));
          });
          return ({ tools: listed });
        }
        if (msg.method === 'tools/call') {
          const name = msg.params?.name;
          const refusal = resourceRefusal(ctx, name);
          if (!refusal && !cliToolAllowed(name, grant)) fail('tool_not_allowed');
          const args = msg.params?.arguments || {};
          const progressToken = msg.params?._meta?.progressToken;
          const progressStartedAt = Date.now();
          // Claude CLI may attach an MCP progress token to a long tool call. Report elapsed liveness while
          // orchestrate_agents is waiting on the synchronous DAG result; this is in addition to the app-level
          // workflow heartbeat and helps MCP clients distinguish "still running" from a dead server.
          const progressTimer = (name === 'orchestrate_agents' || name === 'wait_agents') && progressToken != null ? setInterval(() => {
            const elapsedSec = Math.max(1, Math.round((Date.now() - progressStartedAt) / 1000));
            try { notify('notifications/progress', { progressToken, progress: elapsedSec, message: `Agent 工作流仍在运行 · ${elapsedSec}s` }); } catch {}
          }, 10000) : null;
          if (progressTimer && progressTimer.unref) progressTimer.unref();
          try {
            const result = refusal || await toolCall(name, args, ctx);
            PrivacyGateway.assertSupported(await readConfig(), 'external-tool-result');
            // S1 修复:MCP tools/call 路径(Claude 引擎)原样直出大结果会灌爆 CLI context。
            // 经 truncateToolResult 截断(file_read 走 head/tail,其余 60KB+标记),与 OpenAI 引擎 push 路径一致。
            const images = VisualPipeline.extractToolImages(result);
            const modelResult = images.length ? VisualPipeline.stripToolImageFields(result, '[image attached in MCP content]') : result;
            const serialized = JSON.stringify(modelResult, null, 2);
            const memoryRead = name === 'workbench_memory_list' || name === 'workbench_memory_read';
            if (memoryRead && Buffer.byteLength(serialized, 'utf8') > 2 * 1024 * 1024) throw new Error('memory_cli.result_too_large');
            const text = memoryRead ? serialized : truncateToolResult(name, serialized);
            return ({
              content: [{ type: 'text', text }, ...images.map(uri => {
                const split = uri.indexOf(';base64,');
                return { type: 'image', mimeType: uri.slice(5, split), data: uri.slice(split + 8) };
              })],
              isError: result.ok === false,
            });
          } finally {
            if (progressTimer) clearInterval(progressTimer);
          }
        }
        if (msg.method === 'resources/list') {
          const resourceConfig = await readConfig(); check();
          PrivacyGateway.assertPolicyAvailable(resourceConfig);
          if (PrivacyGateway.enabled(resourceConfig)) return ({ resources: [], _meta: { privacy: 'privacy.engine_not_supported' } });
          return ({
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
          const resourceConfig = await readConfig(); check();
          PrivacyGateway.assertSupported(resourceConfig, 'external-resource');
          const uri = String(msg.params?.uri || '');
          if (!uri.startsWith('file://')) throw new Error('Only file:// resources are supported');
          const p = decodeURIComponent(uri.replace(/^file:\/\//, '')).replace(/^\/+/, '');
          // resources/list only exposes the config file — confine reads to exactly it (no traversal,
          // no UNC/SMB egress from an "offline" tool).
          const resolved = path.resolve(p);
          if (resolved.toLowerCase() !== path.resolve(paths.config).toLowerCase()) throw new Error('resource not found');
          // 128e(48 号文 §1,实测坐实):修前这里把 config.json【原样】读出来返回 —— 明文的 provider apiKey、Claude CLI 的
          // modelsApiKey、外部 MCP 连接器 env 里的令牌,连到工作台 MCP 的模型用读资源的工具就能拿走(GET /api/status 早在
          // 107-S0／S0b 掩了同一批值,文件工具也把 config.json 列为敏感路径拒读 —— 这是绕过两道门的第三条路)。
          // 现在交出去的是与 /api/status 同一份掩码视图(maskProviders,不另写一套),并且是归一化后的整份配置 ——
          // 128a 之后盘上是稀疏文件,原样读反而给不出「当前生效的配置」。
          const view = maskProviders(resourceConfig);
          return ({ contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(view, null, 2) }] });
        }
        if (msg.id !== undefined) return ({});

  }
  const validId = id => id === null || typeof id === 'string' && id.length <= 128 || typeof id === 'number' && Number.isFinite(id);
  function messageOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.jsonrpc !== '2.0'
      || typeof value.method !== 'string' || value.method.length > 128 || Object.hasOwn(value, 'id') && !validId(value.id)
      || value.params !== undefined && (!value.params || typeof value.params !== 'object' || Array.isArray(value.params))) fail('message_invalid');
    return value;
  }
  async function handle(req, res, pathname) {
    if (pathname !== route) return false;
    let grant, controller, authenticated = false;
    const unavailable = () => { if (!res.destroyed && !res.writableEnded) send(res, json({ ok: false, code: 'internal_mcp.unavailable' }, 403, { 'cache-control': 'no-store' })); };
    try {
      const token = req.headers['x-ruyi-internal-mcp-cap'];
      if (req.method !== 'POST' || !requestIsLoopback(req) || req.headers.origin || req.headers['sec-fetch-site'] || req.headers['sec-fetch-mode']
        || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
        || req.headers['content-length'] && (!/^\d{1,9}$/.test(req.headers['content-length']) || Number(req.headers['content-length']) > bodyCap)) fail('unavailable');
      const hashed = digest(token);
      try { for (const candidate of grants) if (!candidate.revoked && equal(candidate.tokenHash, hashed)) { grant = candidate; break; } }
      finally { hashed.fill(0); }
      current(grant);
      if (grant.inflight >= 16) fail('busy');
      grant.inflight++; authenticated = true;
      controller = new AbortController(); (grant.controllers || (grant.controllers = new Set())).add(controller);
      res.once('close', () => { if (!res.writableEnded) controller.abort(); }); res.once('error', () => controller.abort());
      const check = () => { current(grant); if (controller.signal.aborted) fail('unavailable'); };
      const chunks = []; let length = 0;
      for await (const chunk of req) { check(); length += chunk.length; if (length > bodyCap) fail('body_limit'); chunks.push(chunk); }
      check(); let msg;
      try { msg = messageOf(JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks)))); } catch { fail('message_invalid'); }
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      const emit = payload => { check(); const frame = JSON.stringify(payload); if (Buffer.byteLength(frame, 'utf8') > frameCap) fail('result_limit'); if (!res.destroyed) res.write(frame + '\n'); };
      await Hooks.run(async () => {
        let ctx;
        try {
          const config = await readConfig(); check(); PrivacyGateway.assertSupported(config, 'cli');
          const session = current(grant);
          ctx = { config, session, sessionId: grant.sessionId, turnSeq: session.turnSeq,
            workingDir: grant.nodeContext?.workingDir || session.cwd, signal: controller.signal, mainTurn: false,
            memoryLiveRead: true, memoryReadOwner: () => { try { check(); return true; } catch { return false; } } };
          issuedContexts.add(ctx); contexts.set(ctx, { grant, signal: controller.signal });
          const result = await dispatch(msg, grant, ctx, check, (method, params) => emit({ jsonrpc: '2.0', method, params }));
          const after = await readConfig(); check(); PrivacyGateway.assertSupported(after, 'external-tool-result');
          if (Object.hasOwn(msg, 'id')) emit({ jsonrpc: '2.0', id: msg.id, result: result || {} });
        } catch (error) {
          check(); let message = String(error?.message || error);
          try { PrivacyGateway.assertSupported(await readConfig(), 'external-error'); check(); }
          catch (policyError) { check(); message = policyError?.code === 'privacy.engine_not_supported' ? policyError.code : 'privacy.policy_unavailable'; }
          if (Object.hasOwn(msg, 'id')) emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });
        } finally { if (ctx) contexts.delete(ctx); }
      }, grant.executionOwner || grant.nodeContext?.runtime);
      if (!res.destroyed) res.end();
    } catch {
      if (res.headersSent) { if (!res.destroyed) res.end(); } else unavailable();
    } finally {
      if (authenticated) grant.inflight--;
      if (controller) grant.controllers.delete(controller);
    }
    return true;
  }
  async function startRelay() {
    const http = require('node:http'), token = process.env.RUYI_INTERNAL_MCP_CAP, port = Number(process.env.RUYI_INTERNAL_MCP_PORT);
    for (const key of ['RUYI_INTERNAL_MCP_CAP', 'RUYI_INTERNAL_MCP_PORT', 'WCW_TOKEN', 'WCW_SESSION_ID', 'WCW_PORT', 'WCW_HOST', 'RUYI_MEMORY_CAP', 'RUYI_MEMORY_PORT', 'RUYI_MEMORY_SESSION']) delete process.env[key];
    // This branch never resolves data paths, reads configuration, or executes tools locally.
    const output = value => process.stdout.write(JSON.stringify(value) + '\n');
    const requests = new Set(); let closed = false, inputEnded = false, active = 0, buffer = '';
    async function forward(msg) {
      const hasId = Object.hasOwn(msg, 'id'); let terminal = false;
      try {
        if (closed) fail('unavailable');
        if (!/^[a-f0-9]{64}$/.test(String(token)) || !Number.isSafeInteger(port) || port < 1 || port > 65535) fail('setup_required');
        const bytes = Buffer.from(JSON.stringify(msg)); if (bytes.length > bodyCap) fail('body_limit');
        await new Promise((resolve, reject) => {
          let received = false, text = '', total = 0; const decoder = new TextDecoder('utf8', { fatal: true });
          const request = http.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', agent: false,
            headers: { 'content-type': 'application/json', 'content-length': bytes.length, 'x-ruyi-internal-mcp-cap': token } }, response => {
            if (response.statusCode === 403) {
              // A revoked execution uses the same setup guidance as an unconfigured child.
              // Drain the host's ordinary JSON error without interpreting it as RPC frames.
              response.once('error', reject); response.resume();
              reject(Object.assign(Error('internal_mcp.setup_required'), { code: 'internal_mcp.setup_required' })); return;
            }
            response.on('data', chunk => {
              try {
                total += chunk.length; if (total > frameCap * 2) fail('result_limit'); text += decoder.decode(chunk, { stream: true });
                let end;
                while ((end = text.indexOf('\n')) >= 0) {
                  const line = text.slice(0, end); text = text.slice(end + 1); if (!line.trim()) continue;
                  if (Buffer.byteLength(line, 'utf8') > frameCap || response.statusCode !== 200) fail('unavailable');
                  const value = JSON.parse(line);
                  if (value.jsonrpc !== '2.0' || Object.hasOwn(value, 'id') && (!hasId || value.id !== msg.id)) fail('message_invalid');
                  if (Object.hasOwn(value, 'id')) { if (received) fail('message_invalid'); received = true; terminal = true; }
                  output(value);
                }
                if (Buffer.byteLength(text, 'utf8') > frameCap) fail('result_limit');
              } catch (error) { response.destroy(error); }
            });
            response.once('error', reject); response.once('end', () => {
              try { text += decoder.decode(); if (response.statusCode !== 200 || text.trim() || hasId && !received) fail('unavailable'); resolve(); } catch (error) { reject(error); }
            });
          });
          requests.add(request); request.once('close', () => requests.delete(request)); request.once('error', reject);
          // Long workflow/question calls use business deadlines. Transport never retries on error.
          request.setTimeout(86400000, () => request.destroy(Error('internal_mcp.unavailable'))); request.end(bytes);
        });
      } catch (error) {
        const message = error?.code === 'internal_mcp.setup_required'
          ? 'mcp_consumer.setup_required: Create an independent connection in Ruyi Settings > MCP. / 请在如意设置的 MCP 页面生成独立连接配置。'
          : 'internal_mcp.unavailable';
        if (hasId && !closed && !terminal) output({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message } });
      } finally { active--; if (inputEnded && active === 0) closed = true; }
    }
    const close = () => { closed = true; for (const request of requests) request.destroy(); };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk; let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
        let msg;
        try { if (Buffer.byteLength(line, 'utf8') > bodyCap) fail('body_limit'); msg = messageOf(JSON.parse(line)); }
        catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'internal_mcp.message_invalid' } }); continue; }
        if (active >= 16) { if (Object.hasOwn(msg, 'id')) output({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'internal_mcp.busy' } }); continue; }
        active++; void forward(msg);
      }
      if (Buffer.byteLength(buffer, 'utf8') > bodyCap) { buffer = ''; close(); process.stdin.pause(); }
    });
    process.stdin.once('end', () => { inputEnded = true; if (active === 0) closed = true; }); process.stdin.once('error', close); process.once('SIGTERM', close);
  }
  function maintenanceState() { return { active: [...grants].reduce((sum, grant) => sum + grant.inflight, 0) }; }
  return Object.freeze({ create, createNode, bind, bindNode, revoke, launchEnv, handle, startRelay, isContext, assertTool, resourceRefusal, business, Hooks, maintenanceState });
})();

Object.assign(InternalMcpHooks, InternalMcpRelay);
