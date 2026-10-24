// A per-execution capability for the two read-only memory tools. The capability grants no
// general API authority, no key access and no global MCP configuration changes.
const MemoryCliRelay = (() => {
  const tools = Object.freeze(['workbench_memory_list', 'workbench_memory_read']);
  const allowed = new Set(tools), bodyCap = 16384, resultCap = 2 * 1024 * 1024;
  const nodeGrants = new Set();
  const Hooks = { run: work => work() };
  const serverId = config => RUYI_MCP_SERVER_ID + (config.includeWorkbenchMcp ? '-memory' : '');
  const readerTool = config => 'mcp__' + serverId(config) + '__workbench_memory_read';
  const fail = code => { throw Object.assign(new Error('memory_cli.' + code), { code: 'memory_cli.' + code, statusCode: 403 }); };
  const digest = token => crypto.createHash('sha256').update(token).digest();
  const same = (one, two) => Buffer.isBuffer(one) && Buffer.isBuffer(two) && one.length === two.length && crypto.timingSafeEqual(one, two);
  function nodeCurrent(context) {
    const runtime = context?.runtime, node = context?.node;
    if (!runtime || activeAgentRuns.get(context.runId) !== runtime || runtime.run.sessionId !== context.session?.id
      || runtime.stopRequested || runtime.paused || runtime.ctrl?.signal?.aborted || AGENT_RUN_TERMINAL.has(runtime.run.status)
      || !node || !runtime.run.nodes.includes(node) || node.attempts !== context.attempt || !context.ctrl || context.ctrl.signal.aborted
      || !context.review && (runtime.nodeControls.get(node.id) !== context.ctrl || node.status !== 'running')) fail('unavailable');
    return context.session;
  }
  function current(grant, reg) {
    if (grant?.nodeContext) {
      if (grant.revoked || !nodeGrants.has(grant) || grant.reg !== reg || !reg?.child
        || reg.child.exitCode !== null || reg.child.signalCode !== null) fail('unavailable');
      return nodeCurrent(grant.nodeContext);
    }
    if (!grant || grant.revoked || !reg || grant.reg !== reg || activeChildren.get(grant.sessionId) !== reg || reg.memoryCliGrant !== grant
      || reg.exited || reg.state !== 'running' || !['claude', 'kimi-acp'].includes(reg.kind)
      || !reg.child || reg.child.exitCode !== null || reg.child.signalCode !== null
      || !grant.executionOwner || grant.executionOwner.cancelRequested || reg.executionOwner !== grant.executionOwner
      || turnSettlers.get(grant.sessionId) !== grant.executionOwner || !reg.session || reg.session.id !== grant.sessionId) fail('unavailable');
    return reg.session;
  }
  async function create({ session, executionOwner, config }) {
    const sessionId = safeSessionId(session?.id || '');
    if (!sessionId || !executionOwner || executionOwner.cancelRequested || turnSettlers.get(sessionId) !== executionOwner) fail('owner_unavailable');
    const token = crypto.randomBytes(32).toString('hex'), self = commandForSelfMcp(config.mcpCommandMode);
    const definition = { type: 'stdio', command: self.command, args: [...self.args, '--memory-read-only'], env: {
      RUYI_HOME: dataRoot(), RUYI_MEMORY_SESSION: sessionId, RUYI_MEMORY_PORT: String(RUNTIME.port), RUYI_MEMORY_CAP: token,
      WCW_SESSION_ID: '', WCW_PORT: '', WCW_HOST: '', WCW_TOKEN: '', RUYI_INTERNAL_MCP_CAP: '', RUYI_INTERNAL_MCP_PORT: '',
    } };
    const configPath = path.join(paths.generated, `workbench.mcp.${sessionId}.json`);
    await fsp.mkdir(paths.generated, { recursive: true });
    if (executionOwner.cancelRequested || turnSettlers.get(sessionId) !== executionOwner) fail('owner_unavailable');
    await atomicWriteJson(configPath, { mcpServers: { [serverId(config)]: definition } }, { mode: 0o600 });
    if (executionOwner.cancelRequested || turnSettlers.get(sessionId) !== executionOwner) fail('owner_unavailable');
    return { sessionId, executionOwner, tokenHash: digest(token), configPath, definition, serverId: serverId(config), revoked: false, reg: null };
  }
  function revoke(grant, reg) {
    if (!grant || grant.reg !== reg) return;
    grant.revoked = true; grant.tokenHash.fill(0); nodeGrants.delete(grant);
    if (grant.detach) { grant.detach(); grant.detach = null; }
    if (reg.memoryCliGrant === grant) reg.memoryCliGrant = null;
  }
  function bind(grant, reg, executionOwner) {
    if (!grant || grant.reg || grant.executionOwner !== executionOwner || reg.executionOwner !== executionOwner
      || activeChildren.get(grant.sessionId) !== reg || turnSettlers.get(grant.sessionId) !== executionOwner) fail('owner_unavailable');
    grant.reg = reg; reg.memoryCliGrant = grant;
    try { current(grant, reg); } catch (error) { revoke(grant, reg); throw error; }
    reg.child.once('close', () => revoke(grant, reg));
    reg.child.once('error', () => revoke(grant, reg));
  }
  async function createNode({ config, context, subagentId, baseConfigPath }) {
    nodeCurrent(context);
    const token = crypto.randomBytes(32).toString('hex'), self = commandForSelfMcp(config.mcpCommandMode);
    const definition = { type: 'stdio', command: self.command, args: [...self.args, '--memory-read-only'], env: {
      RUYI_HOME: dataRoot(), RUYI_MEMORY_PORT: String(RUNTIME.port), RUYI_MEMORY_CAP: token,
      WCW_SESSION_ID: '', WCW_PORT: '', WCW_HOST: '', WCW_TOKEN: '', RUYI_INTERNAL_MCP_CAP: '', RUYI_INTERNAL_MCP_PORT: '',
    } };
    const configPath = path.join(paths.generated, `workbench.memory-mcp.${safeSessionId(subagentId)}.json`);
    let servers = {};
    if (config.includeWorkbenchMcp && baseConfigPath) {
      const previous = JSON.parse(await fsp.readFile(baseConfigPath, 'utf8')); nodeCurrent(context);
      servers = previous.mcpServers || {};
      if (Object.hasOwn(servers, serverId(config))) fail('server_conflict');
    }
    await fsp.mkdir(paths.generated, { recursive: true }); nodeCurrent(context);
    // Preserve explicitly enabled full Ruyi/external servers. The restricted reader has its
    // own name in that mode; disabled full MCP still gets only this read-only transport.
    await atomicWriteJson(configPath, { mcpServers: { ...servers, [serverId(config)]: definition } }, { mode: 0o600 }); nodeCurrent(context);
    return { sessionId: context.session.id, nodeContext: context, tokenHash: digest(token), configPath, definition, serverId: serverId(config), revoked: false, reg: null };
  }
  function bindNode(grant, child) {
    nodeCurrent(grant.nodeContext);
    const reg = { child }; grant.reg = reg; nodeGrants.add(grant);
    try { current(grant, reg); } catch (error) { revoke(grant, reg); throw error; }
    child.once('close', () => revoke(grant, reg)); child.once('error', () => revoke(grant, reg));
    const abort = () => revoke(grant, reg), signal = grant.nodeContext.ctrl.signal;
    signal.addEventListener('abort', abort, { once: true }); grant.detach = () => signal.removeEventListener('abort', abort);
  }
  function kimiDefinition(grant) {
    const value = grant.definition;
    return { name: grant.serverId, command: value.command, args: [...value.args],
      env: Object.entries(value.env).map(([name, value]) => ({ name, value: String(value) })) };
  }
  const schemas = () => MCP_TOOLS.filter(tool => allowed.has(tool.name));
  function argumentsOf(name, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('arguments_invalid');
    const keys = name === 'workbench_memory_read' ? ['id', 'scope'] : ['query', 'scope', 'limit'];
    if (Object.keys(value).some(key => !keys.includes(key))) fail('arguments_invalid');
    if (name === 'workbench_memory_read' && (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id))) fail('arguments_invalid');
    if (value.query !== undefined && (typeof value.query !== 'string' || value.query.length > 4096)) fail('arguments_invalid');
    const scopes = name === 'workbench_memory_read' ? ['global', 'project'] : ['global', 'project', 'all'];
    if (value.scope !== undefined && !scopes.includes(value.scope)) fail('arguments_invalid');
    if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1 || value.limit > 50)) fail('arguments_invalid');
    return value;
  }
  async function handle(req, res, pathname) {
    if (pathname !== '/api/memory-cli') return false;
    const refuse = (status = 403, code = 'memory_cli.unavailable') => send(res, json({ ok: false, code }, status, { 'cache-control': 'no-store' }));
    let grant, reg;
    try {
      const token = req.headers['x-ruyi-memory-cap'];
      if (req.method !== 'POST' || !requestIsLoopback(req) || req.headers.origin || req.headers['sec-fetch-site'] || req.headers['sec-fetch-mode']
        || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || Number(req.headers['content-length'] || 0) > bodyCap) fail('unavailable');
      // Authenticate before buffering a body. Iterate active CLI owners only; no caller-provided
      // session or turn identity grants authority and an ordinary API token is never accepted.
      const tokenHash = digest(token);
      for (const candidate of activeChildren.values()) {
        const found = candidate.memoryCliGrant;
        if (found && !found.revoked && same(found.tokenHash, tokenHash)) { grant = found; reg = candidate; break; }
      }
      if (!grant) for (const found of nodeGrants) { if (!found.revoked && same(found.tokenHash, tokenHash)) { grant = found; reg = found.reg; break; } }
      tokenHash.fill(0); current(grant, reg);
      const work = async () => {
      const controller = new AbortController();
      res.once('close', () => { if (!res.writableEnded) controller.abort(); }); res.once('error', () => controller.abort());
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { current(grant, reg); bytes += chunk.length; if (bytes > bodyCap) fail('body_limit'); chunks.push(chunk); }
      current(grant, reg);
      let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('message_invalid'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['op', 'name', 'args'].includes(key))) fail('message_invalid');
      const config = await readConfig(); current(grant, reg); PrivacyGateway.assertSupported(config, 'cli');
      if (controller.signal.aborted) fail('unavailable');
      if (body.op === 'list') {
        if (Object.hasOwn(body, 'name') || Object.hasOwn(body, 'args')) fail('message_invalid');
        current(grant, reg); send(res, json({ ok: true, tools: schemas() }, 200, { 'cache-control': 'no-store' })); return true;
      }
      if (body.op !== 'call' || !allowed.has(body.name)) fail('tool_not_allowed');
      const args = argumentsOf(body.name, body.args || {}), session = current(grant, reg);
      const ctx = { config, session, sessionId: grant.sessionId, turnSeq: session.turnSeq, workingDir: grant.nodeContext?.workingDir || session.cwd,
        memoryLiveRead: true, memoryReadOwner: () => { try { current(grant, reg); return true; } catch { return false; } }, signal: controller.signal };
      const result = await (body.name === 'workbench_memory_list' ? listWorkbenchMemories(args, ctx) : readWorkbenchMemory(args, ctx));
      current(grant, reg); if (controller.signal.aborted) fail('unavailable');
      if (Buffer.byteLength(JSON.stringify(result), 'utf8') > resultCap) fail('result_too_large');
      send(res, json({ ok: true, result }, 200, { 'cache-control': 'no-store' })); return true;
      };
      return await Hooks.run(work, grant.executionOwner || grant.nodeContext?.runtime);
    } catch (error) {
      // No private exception message or partial tool result escapes a lost execution owner.
      if (res.destroyed || res.writableEnded) return true;
      const code = String(error?.code || '');
      if (code.startsWith('work_data') && grant && reg) {
        try { current(grant, reg); refuse(503, code); return true; } catch { /* owner lost */ }
      }
      refuse(); return true;
    }
  }
  async function startRelay() {
    const http = require('node:http'), token = process.env.RUYI_MEMORY_CAP, port = Number(process.env.RUYI_MEMORY_PORT);
    for (const key of ['WCW_TOKEN', 'WCW_SESSION_ID', 'WCW_PORT', 'WCW_HOST', 'RUYI_INTERNAL_MCP_CAP', 'RUYI_INTERNAL_MCP_PORT']) delete process.env[key];
    const post = body => new Promise((resolve, reject) => {
      if (!/^[a-f0-9]{64}$/.test(String(token)) || !Number.isSafeInteger(port) || port < 1 || port > 65535) { reject(Error('memory_cli.unavailable')); return; }
      const payload = Buffer.from(JSON.stringify(body));
      const request = http.request({ hostname: '127.0.0.1', port, path: '/api/memory-cli', method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-ruyi-memory-cap': token } }, response => {
        const decoder = new TextDecoder('utf-8', { fatal: true }); let text = '', bytes = 0;
        response.on('data', chunk => { try { bytes += chunk.length; if (bytes > resultCap) throw Error('memory_cli.result_too_large'); text += decoder.decode(chunk, { stream: true }); } catch (error) { response.destroy(error); } });
        response.on('error', reject); response.on('end', () => {
          try { text += decoder.decode(); const value = JSON.parse(text); if (response.statusCode !== 200 || !value.ok) throw Error(/^work_data/.test(value.code || '') ? value.code : 'memory_cli.unavailable'); resolve(value); } catch (error) { reject(error); }
        });
      });
      request.once('error', reject); request.setTimeout(15000, () => request.destroy(Error('memory_cli.unavailable'))); request.end(payload);
    });
    const output = value => process.stdout.write(JSON.stringify(value) + '\n');
    const safeId = id => typeof id === 'string' && id.length <= 128 || typeof id === 'number' && Number.isFinite(id);
    async function dispatch(message) {
      if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return;
      if (!Object.hasOwn(message, 'id')) return;
      const id = safeId(message.id) ? message.id : null;
      try {
        let result;
        if (message.method === 'initialize') { await post({ op: 'list' }); result = { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: RUYI_MCP_SERVER_ID, version: VERSION } }; }
        else if (message.method === 'ping') { await post({ op: 'list' }); result = {}; }
        else if (message.method === 'tools/list') { const value = await post({ op: 'list' }); result = { tools: value.tools }; }
        else if (message.method === 'tools/call') {
          const name = message.params?.name; if (!allowed.has(name)) fail('tool_not_allowed');
          const value = await post({ op: 'call', name, args: argumentsOf(name, message.params?.arguments || {}) });
          result = { content: [{ type: 'text', text: JSON.stringify(value.result, null, 2) }], isError: value.result?.ok === false };
        } else { output({ jsonrpc: '2.0', id, error: { code: -32601, message: 'memory_cli.method_not_allowed' } }); return; }
        output({ jsonrpc: '2.0', id, result });
      } catch (error) { output({ jsonrpc: '2.0', id, error: { code: -32000, message: /^work_data/.test(String(error.message)) ? error.message : 'memory_cli.unavailable' } }); }
    }
    let buffer = '', busy = false; const queue = [];
    const pump = async () => { if (busy) return; busy = true; try { while (queue.length) await dispatch(queue.shift()); } finally { busy = false; } };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, 'utf8') > bodyCap) { output({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'memory_cli.body_limit' } }); continue; }
        let message; try { message = JSON.parse(line); } catch { output({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'memory_cli.message_invalid' } }); continue; }
        if (queue.length >= 8) {
          if (Object.hasOwn(message || {}, 'id')) output({ jsonrpc: '2.0', id: safeId(message.id) ? message.id : null, error: { code: -32000, message: 'memory_cli.busy' } });
          continue;
        }
        queue.push(message);
      }
      if (Buffer.byteLength(buffer, 'utf8') > bodyCap) { buffer = ''; process.stdin.pause(); }
      void pump();
    });
  }
  return Object.freeze({ create, bind, createNode, bindNode, revoke, readerTool, kimiDefinition, handle, startRelay, Hooks });
})();
Object.assign(MemoryCliHooks, MemoryCliRelay);
