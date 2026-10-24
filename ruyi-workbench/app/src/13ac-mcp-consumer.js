// Independent MCP consumers use a running host. No management credential enters
// their process. This is an application authorization boundary, not OS isolation.
const McpConsumers = (() => {
  const connections = new Map(), writes = new Map(), revoking = new Set();
  const names = Object.freeze(['file_read', 'file_list', 'file_search', 'file_write', 'file_edit', 'file_copy', 'file_move']);
  const resources = Object.freeze(['capabilities', 'workspace']);
  const limit = Object.freeze({ consumers: 32, connections: 64, perConsumer: 4, inflight: 4, bytes: 1024 * 1024, resultBytes: 8 * 1024 * 1024, page: 2 });
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const error = (code, statusCode = 409) => Object.assign(new Error(code), { code, statusCode });
  const deny = code => { throw error('mcp_consumer.' + code); };
  const equal = (one, two) => typeof one === 'string' && typeof two === 'string' && one.length === two.length && crypto.timingSafeEqual(Buffer.from(one), Buffer.from(two));
  const validId = value => typeof value === 'string' && /^[a-f0-9]{48}$/.test(value);
  const store = DurableJsonStore.create({ id: 'mcp-consumers', file: () => path.join(paths.data, 'mcp-consumers-v1.json'), schemaVersion: 1,
    strictRead: true, defaultValue: () => ({ schema: 1, consumers: [] }),
    validate: value => Array.isArray(value.consumers) && value.consumers.length <= limit.consumers && value.consumers.every(row => validId(row.id)
      && typeof row.label === 'string' && row.label.length <= 100 && /^[a-f0-9]{64}$/.test(row.tokenHash) && typeof row.workspace === 'string'
      && typeof row.workspaceIdentity === 'string' && (row.auditSessionId === undefined || safeSessionId(row.auditSessionId) === row.auditSessionId) && typeof row.enabled === 'boolean' && Number.isSafeInteger(row.revision) && row.revision > 0
      && Array.isArray(row.tools) && row.tools.length <= names.length && row.tools.every(name => names.includes(name)) && Array.isArray(row.resources) && row.resources.length <= resources.length && row.resources.every(name => resources.includes(name))) });
  const instance = crypto.randomBytes(24).toString('hex');
  function workspaceIdentity(stat) { return [stat.dev, stat.ino, stat.birthtimeMs].join(':'); }
  async function workspaceSnapshot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) deny('workspace_invalid');
    const checked = await privacyInspectLocalPath(root);
    const stat = await fsp.stat(checked.path);
    if (!stat.isDirectory()) deny('workspace_invalid');
    return { path: checked.path, identity: workspaceIdentity(stat) };
  }
  function publicRow(row) { return { id: row.id, label: row.label, workspace: row.workspace, tools: row.tools, resources: row.resources, revision: row.revision, enabled: row.enabled, ...(row.auditSessionId ? { auditSessionId: row.auditSessionId } : {}) }; }
  async function administer(body) {
    return runKeyedChain(writes, 'consumers', async () => {
      const data = await store.read();
      if (body.op === 'list') return { ok: true, consumers: data.consumers.map(publicRow), toolChoices: names, resourceChoices: resources };
      if (body.op === 'revoke') {
        const row = data.consumers.find(row => row.id === body.id); if (!row) deny('not_found');
        // Revocation is effective in this process before waiting on persistence.
        revoking.add(row.id); row.enabled = false; row.revision++;
        for (const connection of connections.values()) if (connection.consumerId === row.id) retire(connection);
        await store.write(data); revoking.delete(row.id); return { ok: true };
      }
      if (body.op !== 'create') deny('grant_invalid');
      data.consumers = data.consumers.filter(row => row.enabled);
      if (data.consumers.length >= limit.consumers) deny('capacity');
      if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > 100 || /[\x00-\x1f]/.test(body.label)
        || !Array.isArray(body.tools) || !body.tools.length || body.tools.some(name => !names.includes(name))
        || !Array.isArray(body.resources) || body.resources.some(name => !resources.includes(name))) deny('grant_invalid');
      const workspace = await workspaceSnapshot(body.workspace), token = crypto.randomBytes(32).toString('hex');
      const row = { id: crypto.randomBytes(24).toString('hex'), label: body.label.trim(), tokenHash: digest(token), workspace: workspace.path,
        workspaceIdentity: workspace.identity, tools: [...new Set(body.tools)], resources: [...new Set(body.resources)], revision: 1, enabled: true };
      // A real local audit thread reuses the existing checkpoint journal; never
      // place the credential, arguments or result in chat/history.
      if (row.tools.some(name => nativeToolTier(name) !== 'read')) {
        const audit = await createSession({ title: 'MCP file audit / MCP 文件审计: ' + row.label, cwd: row.workspace, origin: 'user' });
        row.auditSessionId = audit.id;
      }
      data.consumers.push(row); await store.write(data);
      const command = commandForSelfMcp();
      // Only this explicit setup response contains the reusable token. Never list,
      // recover, log or put it on argv; the receiving application's config owns it.
      return { ok: true, consumer: publicRow(row), configuration: { mcpServers: { ['ruyi-consumer_' + row.id]: { type: 'stdio', command: command.command,
        args: [...command.args, '--consumer'], env: { RUYI_HOME: dataRoot(), RUYI_MCP_CONSUMER_ID: row.id, RUYI_MCP_CONSUMER_TOKEN: token } } } } };
    });
  }
  async function authenticate(req) {
    const token = req.headers['x-ruyi-mcp-consumer'];
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw error('mcp_consumer.unauthorized', 403);
    const tokenHash = digest(token), data = await store.read();
    const row = data.consumers.find(row => row.enabled && !revoking.has(row.id) && equal(row.tokenHash, tokenHash));
    if (!row) throw error('mcp_consumer.unauthorized', 403);
    return row;
  }
  function retire(connection) {
    if (connection.retired) return; connection.retired = true;
    clearTimeout(connection.unboundTimer); clearInterval(connection.heartbeat); connection.subscriptions.clear();
    connection.controller.abort(); connections.delete(connection.id); connection.scopeCapability.close();
    const lease = connection.lease; connection.lease = null; if (lease && !lease.destroyed) lease.destroy();
  }
  function assertCurrent(connection, row) {
    const current = store.readSync().consumers.find(item => item.id === row.id);
    if (revoking.has(row.id) || !connections.has(connection.id) || connection.controller.signal.aborted || !current?.enabled
      || current.revision !== connection.revision || !equal(current.tokenHash, connection.tokenHash)) deny('revoked');
  }
  async function open(row) {
    if (connections.size >= limit.connections || [...connections.values()].filter(connection => connection.consumerId === row.id).length >= limit.perConsumer) deny('capacity');
    const workspace = await workspaceSnapshot(row.workspace);
    if (workspace.path !== row.workspace || workspace.identity !== row.workspaceIdentity) deny('workspace_changed');
    // Recheck after filesystem awaits; this check-to-registration has no await.
    if (connections.size >= limit.connections || [...connections.values()].filter(connection => connection.consumerId === row.id).length >= limit.perConsumer) deny('capacity');
    const id = crypto.randomBytes(24).toString('hex'), connection = { id, consumerId: row.id, revision: row.revision, tokenHash: row.tokenHash,
      scopeCapability: PrivacyGateway.createConnectionScope(), controller: new AbortController(), inflight: new Map(), touched: Date.now(), cursors: new Map(), subscriptions: new Map(), checkingSubscriptions: false };
    connections.set(id, connection);
    connection.unboundTimer = setTimeout(() => retire(connection), 10000); connection.unboundTimer.unref();
    try { assertCurrent(connection, row); } catch (failure) { retire(connection); throw failure; }
    return { connectionId: id, instanceId: instance, grantRevision: row.revision };
  }
  function boundConnection(body, row) {
    const connection = validId(body.connectionId) && connections.get(body.connectionId);
    if (!connection || connection.consumerId !== row.id || body.instanceId !== instance || body.grantRevision !== connection.revision) deny('connection_invalid');
    assertCurrent(connection, row); connection.touched = Date.now(); return connection;
  }
  function page(connection, items, cursor, kind, policy) {
    for (const [key, value] of connection.cursors) if (value.expires < Date.now()) connection.cursors.delete(key);
    const sourceHash = digest(JSON.stringify(items));
    let offset = 0;
    if (cursor !== undefined) {
      const previous = connection.cursors.get(cursor); connection.cursors.delete(cursor);
      if (!previous || previous.kind !== kind || previous.expires < Date.now() || previous.revision !== connection.revision || previous.sourceHash !== sourceHash) deny('cursor_invalid');
      previous.policy();
      offset = previous.offset;
    }
    const result = { items: items.slice(offset, offset + limit.page) };
    if (offset + limit.page < items.length) {
      if (connection.cursors.size >= 64) deny('capacity');
      result.nextCursor = crypto.randomBytes(24).toString('hex');
      connection.cursors.set(result.nextCursor, { kind, offset: offset + limit.page, expires: Date.now() + 60000, revision: connection.revision, sourceHash, policy });
    }
    return result;
  }
  function toolAdvertised(name, config, session) {
    const tier = nativeToolTier(name);
    let gate = nativeToolGate(resolvePermissionMode({ session, config }), tier, name, {});
    if (gate === 'ask' && config.toolAllowRules?.[name] === 'allow' && ['read', 'edit'].includes(tier)) gate = 'allow';
    return gate === 'allow';
  }
  async function availableTools(row, config) {
    const id = row.auditSessionId, seq = id ? sessionDiskWriteSeqOf(id) : 0, owner = id ? turnSettlers.get(id) : undefined;
    let audit = null;
    if (id) { try { audit = await loadSession(id); } catch { audit = null; } }
    const check = () => {
      if (id && (sessionWriteChains.has(id) || sessionDiskWriteSeqOf(id) !== seq || turnSettlers.get(id) !== owner)) deny('audit_changed');
    };
    check();
    const available = row.tools.filter(name => !nativeToolDisabledByPolicy(name, config)
      && (nativeToolTier(name) === 'read' || audit) && toolAdvertised(name, config) && toolAdvertised(name, config, audit));
    return { names: available, assert: check };
  }
  function resourceTemplates(row) {
    // RFC URI-template expansion only selects one of the already granted fixed
    // resources. No file URI or arbitrary variable acquires a resource grant.
    return row.resources.length ? [{ uriTemplate: 'ruyi://consumer/{kind}', name: 'consumer-resources', mimeType: 'application/json',
      description: 'kind must be one of: ' + row.resources.join(', '), _meta: { allowedKinds: row.resources } }] : [];
  }
  function resourceKind(row, uri) {
    const kind = resources.find(kind => uri === 'ruyi://consumer/' + kind);
    if (!kind || !row.resources.includes(kind)) deny('resource_denied');
    return kind;
  }
  async function resourceSnapshot(row, kind, config) {
    const available = kind === 'capabilities' ? await availableTools(row, config) : null;
    const value = kind === 'capabilities' ? { grantedTools: row.tools, currentlyAvailableTools: available.names, resources: row.resources,
      templates: resourceTemplates(row), subscriptions: true, scope: 'connection-owned', osIsolation: false }
      : { workspace: row.workspace, permissions: 'existing-workbench-permission-floor', grantRevision: row.revision };
    return { value, hash: digest(JSON.stringify(value)), assert: available ? available.assert : () => {} };
  }
  async function projectedOutput(connection, value, control, assert, sourceAssert, emit) {
    if (control.notification === 'progress' && !(['string', 'number'].includes(typeof control.progressToken) && String(control.progressToken).length <= 128
      && (typeof control.progressToken !== 'number' || Number.isFinite(control.progressToken)))) deny('message_invalid');
    if (control.notification === 'resource-updated' && !resources.some(kind => control.uri === 'ruyi://consumer/' + kind)) deny('resource_denied');
    assert(); sourceAssert();
    const binding = { recipient: 'mcp-consumer:' + connection.id, purpose: control.notification || 'rpc-result', sourceHash: digest(JSON.stringify(value)) };
    const prepared = await PrivacyGateway.prepareDisclosure(value, binding);
    for (let pass = 0; pass < 4; pass++) {
      try {
        const current = pass ? await PrivacyGateway.refreshDisclosure(prepared.receipt, binding) : prepared.value;
        // These exact host-fixed URIs and the originating client's scalar token
        // are protocol routing fields. Source/body/error text is never exempted.
        const payload = control.notification === 'resource-updated'
          ? { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { ...current, uri: control.uri } }
          : control.notification === 'progress'
            ? { jsonrpc: '2.0', method: 'notifications/progress', params: { ...current, progressToken: control.progressToken } }
            : { jsonrpc: '2.0', id: control.id, result: current };
        const bytes = JSON.stringify(payload) + '\n';
        if (Buffer.byteLength(bytes) > limit.resultBytes) deny('result_limit');
        assert(); sourceAssert(); PrivacyGateway.assertDisclosure(prepared.receipt, { ...binding, value: current }); emit(bytes); return;
      } catch (failure) { if (failure.code !== 'privacy.disclosure_dirty' || pass === 3) throw failure; }
    }
  }
  async function checkSubscriptions(connection, row, lease) {
    if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.accepting && !WorkDataMaintenanceHooks.accepting()) return;
    // The existing heartbeat is the only scheduler. Idle consumers do no config
    // or resource reads; a held cycle never queues another background pass.
    if (!connection.subscriptions.size || connection.checkingSubscriptions) return;
    connection.checkingSubscriptions = true;
    try {
      const policy = PrivacyGateway.disclosurePolicyGuard(), generation = configReadGeneration;
      const assert = () => { policy(); assertCurrent(connection, row); if (generation !== configReadGeneration) deny('configuration_changed');
        if (connection.lease !== lease || lease.destroyed) deny('cancelled'); };
      const config = await readConfig(); assert();
      for (const [uri, subscription] of [...connection.subscriptions]) {
        if (!subscription.ready) continue;
        const source = await resourceSnapshot(row, subscription.kind, config); assert(); source.assert();
        if (connection.subscriptions.get(uri) !== subscription) continue;
        let changed = source.hash !== subscription.hash;
        try { subscription.policy(); } catch { changed = true; }
        if (!changed) continue;
        const sourceAssert = () => { source.assert(); if (connection.subscriptions.get(uri) !== subscription || !subscription.ready) deny('cancelled'); };
        await connection.scopeCapability.run(() => projectedOutput(connection, {}, { notification: 'resource-updated', uri }, assert, sourceAssert,
          bytes => { if (!lease.write(bytes)) { retire(connection); deny('cancelled'); } }));
        // scopeCapability.run resolves across an await. Recheck before advancing
        // the snapshot; invalidation may repeat a fixed update, never a tool.
        assert(); sourceAssert();
        subscription.hash = source.hash; subscription.policy = policy;
      }
    } catch { /* A dirty/held snapshot waits for the next heartbeat, never replays a tool. */ }
    finally { connection.checkingSubscriptions = false; }
  }
  async function withAuditWrite(row, controller, assert, work) {
    // Do not queue stale mutations or supersede a UI run. The caller may retry a
    // refused admission, but an admitted operation is never automatically replayed.
    if (!row.auditSessionId || writes.has('audit:' + row.id)) deny('audit_busy');
    return runKeyedChain(writes, 'audit:' + row.id, async () => {
      const initialWriteSeq = sessionDiskWriteSeqOf(row.auditSessionId);
      const session = await loadSession(row.auditSessionId); assert();
      if (sessionWriteChains.has(row.auditSessionId) || sessionDiskWriteSeqOf(row.auditSessionId) !== initialWriteSeq) deny('audit_changed');
      if (!session || session.id !== row.auditSessionId) deny('audit_missing');
      if (turnSettlers.has(session.id) || activeChildren.has(session.id)
        || SessionExecutionHooks.admissionBlocked?.(session.id)) deny('audit_busy');
      let settle;
      const owner = { promise: new Promise(resolve => { settle = resolve; }), source: 'mcp-consumer', driverRunId: makeId('drun'),
        startedAt: Date.now(), phase: 'running', cancelRequested: false,
        cancel() { this.cancelRequested = true; this.phase = 'stopping'; controller.abort(); } };
      // Admission check and ownership registration are deliberately synchronous.
      recordSessionExecutionOwner(session.id, owner);
      let expectedWriteSeq = initialWriteSeq;
      const checkOwner = () => { assert(); if (sessionWriteChains.has(session.id) || sessionDiskWriteSeqOf(session.id) !== expectedWriteSeq) deny('audit_changed'); if (controller.signal.aborted || owner.cancelRequested || turnSettlers.get(session.id) !== owner) deny('cancelled'); };
      try {
        session.turnSeq = (Number(session.turnSeq) || 0) + 1;
        await saveSession(session, { ifUnwrittenSince: initialWriteSeq, throwIfStale: true, writer: 'mcp_consumer_audit' });
        expectedWriteSeq = initialWriteSeq + 2; checkOwner();
        return await work(session, checkOwner);
      } finally {
        if (turnSettlers.get(session.id) === owner) turnSettlers.delete(session.id);
        settle();
      }
    });
  }
  async function run(row, connection, message, emit, transportSignal) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.method.length > 128 || (message.params !== undefined && (!message.params || typeof message.params !== 'object' || Array.isArray(message.params))) || (message.id !== undefined && (typeof message.id !== 'string' && typeof message.id !== 'number'))
      || String(message.id ?? '').length > 128 || !Number.isFinite(typeof message.id === 'number' ? message.id : 0)) deny('message_invalid');
    // Notifications carry no response and cannot invoke a side-effecting RPC.
    if (message.id === undefined && !['notifications/initialized', 'notifications/cancelled'].includes(message.method)) return;
    // Cancellation is connection authority, independent of configuration I/O.
    // Register each actual RPC before its first await, so early cancel cannot vanish.
    if (message.method === 'notifications/cancelled') {
      assertCurrent(connection, row); const requested = message.params?.requestId;
      connection.inflight.get(typeof requested + ':' + String(requested))?.abort(); return;
    }
    const policy = PrivacyGateway.disclosurePolicyGuard(), generation = configReadGeneration;
    const assert = () => { policy(); assertCurrent(connection, row); if (generation !== configReadGeneration) deny('configuration_changed'); };
    if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.run && !WorkDataMaintenanceHooks.entered('consumer-rpc')) return WorkDataMaintenanceHooks.run('consumer-rpc', () => run(...arguments));
    const id = message.id, requestKey = typeof id + ':' + String(id);
    if (connection.inflight.has(requestKey) || connection.inflight.size >= limit.inflight) deny('capacity');
    const controller = new AbortController(), cancel = () => controller.abort();
    connection.controller.signal.addEventListener('abort', cancel, { once: true });
    transportSignal?.addEventListener('abort', cancel, { once: true });
    if (transportSignal?.aborted || connection.controller.signal.aborted) controller.abort();
    connection.inflight.set(requestKey, controller);
    let config;
    let executed = false, finalSourceCheck = () => {};
    const requestAssert = () => { assert(); if (!connection.lease || connection.lease.destroyed || controller.signal.aborted) deny('cancelled'); };
    const send = (value, notification = false, progressToken) => projectedOutput(connection, value,
      { id, notification: notification ? 'progress' : null, progressToken }, requestAssert, () => finalSourceCheck(), emit);
    try {
      requestAssert(); config = await readConfig(); requestAssert();
      await withFileAccessCeiling(row.workspace, row.workspaceIdentity, () => connection.scopeCapability.run(async () => {
        assert();
        const params = message.params || {};
        if (message.method === 'initialize') return send({ protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: { subscribe: true } }, serverInfo: { name: 'ruyi', version: VERSION },
          _meta: { identity: 'authenticated-connection', isolation: 'application-grants-only', templates: 'granted-fixed-kinds', subscriptions: true } });
        if (message.method === 'notifications/initialized') return;
        if (message.method === 'ping') return send({});
        if (message.method === 'tools/list') {
          const available = await availableTools(row, config); finalSourceCheck = available.assert;
          const result = page(connection, MCP_TOOLS.filter(tool => available.names.includes(tool.name)), params.cursor, 'tools', policy);
          return send({ tools: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
        }
        if (message.method === 'resources/templates/list') {
          const result = page(connection, resourceTemplates(row), params.cursor, 'resource-templates', policy);
          return send({ resourceTemplates: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
        }
        if (message.method === 'resources/list') {
          const result = page(connection, row.resources.map(kind => ({ uri: 'ruyi://consumer/' + kind, name: kind, mimeType: 'application/json' })), params.cursor, 'resources', policy);
          return send({ resources: result.items, ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}) });
        }
        if (['resources/read', 'resources/subscribe', 'resources/unsubscribe'].includes(message.method)) {
          const kind = resourceKind(row, params.uri);
          if (message.method === 'resources/unsubscribe') { connection.subscriptions.delete(params.uri); return send({}); }
          const source = await resourceSnapshot(row, kind, config); requestAssert(); source.assert();
          if (message.method === 'resources/read') {
            finalSourceCheck = source.assert;
            return send({ contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(source.value) }] });
          }
          const existing = connection.subscriptions.get(params.uri);
          if (existing) { if (!existing.ready) deny('subscription_pending'); return send({}); }
          const subscription = { kind, hash: source.hash, policy, ready: false };
          connection.subscriptions.set(params.uri, subscription);
          finalSourceCheck = () => { source.assert(); if (connection.subscriptions.get(params.uri) !== subscription) deny('cancelled'); };
          try { await send({}); subscription.ready = true; }
          catch (failure) { if (connection.subscriptions.get(params.uri) === subscription) connection.subscriptions.delete(params.uri); throw failure; }
          return;
        }
        if (message.method !== 'tools/call') deny('method_not_supported');
        if (!names.includes(params.name) || !row.tools.includes(params.name)) deny('tool_denied');
        const tier = nativeToolTier(params.name), args = params.arguments || {};
        let gate = nativeToolGate(resolvePermissionMode({ config }), tier, params.name, args);
        if (gate === 'ask' && config.toolAllowRules?.[params.name] === 'allow' && ['read', 'edit'].includes(tier)) gate = 'allow';
        if (gate !== 'allow') deny('permission_required');
        const workspace = await workspaceSnapshot(row.workspace);
        if (workspace.path !== row.workspace || workspace.identity !== row.workspaceIdentity) deny('workspace_changed');
        assert();
        const execute = async (session, checkOwner = requestAssert) => {
        finalSourceCheck = checkOwner;
        if (!toolAdvertised(params.name, config, session)) deny('permission_required');
        const scope = PrivacyGateway.active()?.scopeId || 'consumer-off-' + connection.id;
        const context = { sessionId: session?.id || scope, session: session || { id: scope, cwd: row.workspace },
          ...(session ? { turnSeq: session.turnSeq } : {}), config, workingDir: row.workspace, signal: controller.signal };
        const call = await PrivacyGateway.prepareExecution({ name: params.name, rawArgs: JSON.stringify(args) }, context);
        if (call.privacyError) deny('private_arguments_denied');
        const input = PrivacyGateway.executionArgs(call);
        await PrivacyGateway.revalidateExecution(params.name, input, context); assert(); PrivacyGateway.assertExecution(params.name, input, context);
        if (params._meta?.progressToken !== undefined && !(['string', 'number'].includes(typeof params._meta.progressToken) && String(params._meta.progressToken).length <= 128 && (typeof params._meta.progressToken !== 'number' || Number.isFinite(params._meta.progressToken)))) deny('message_invalid');
        checkOwner();
        if (params._meta?.progressToken !== undefined) await send({ progress: 0, message: 'Operation started / 操作已开始' }, true, params._meta.progressToken);
        executed = tier !== 'read';
        const result = await withFileAccessCeiling(row.workspace, row.workspaceIdentity, () => { checkOwner(); return toolCall(params.name, input, context); }, checkOwner);
        if (VisualPipeline.extractToolImages(result).length) deny('media_not_supported');
        // Full logical result is projected before formatting/truncation, including errors.
        const protectedResult = await PrivacyGateway.modelToolResult(result);
        checkOwner();
        await send({ content: [{ type: 'text', text: truncateToolResult(params.name, JSON.stringify(protectedResult)) }], isError: protectedResult?.ok === false || protectedResult?.resultUnavailable === true,
          ...(session ? { _meta: { auditSessionId: session.id, turnSeq: session.turnSeq } } : {}) });
        };
        return tier === 'read' ? execute(null) : withAuditWrite(row, controller, requestAssert, execute);
      }), assert);
    } catch (failure) {
      // Never reflect arguments, paths, credentials or exception messages.
      const code = /^mcp_consumer\.[a-z_]+$/.test(failure.code || '') ? failure.code : 'mcp_consumer.operation_failed';
      if (!connection.controller.signal.aborted) {
        const value = { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, code,
          message: 'Request refused; review the connection grant in Ruyi. / 请求已拒绝，请在如意检查连接授权。',
          ...(executed ? { operationMayHaveExecuted: true, resultUnavailable: true, retry: false } : {}) }) }] };
        // A policy change/revocation allows only a fixed receipt, never source material.
        const payload = message.method === 'tools/call' ? { jsonrpc: '2.0', id, result: value } : { jsonrpc: '2.0', id, error: { code: code === 'mcp_consumer.method_not_supported' ? -32601 : -32000, message: code } };
        const bytes = JSON.stringify(payload) + '\n';
        assertCurrent(connection, row); emit(bytes);
      }
    } finally {
      if (connection.inflight.get(requestKey) === controller) connection.inflight.delete(requestKey);
      connection.controller.signal.removeEventListener('abort', cancel); transportSignal?.removeEventListener('abort', cancel);
    }
  }
  async function handle(req, res, pathname) {
    if (!['/api/mcp/consumer', '/api/mcp/consumers', '/api/mcp/internal/verify'].includes(pathname)) return false;
    const internal = pathname === '/api/mcp/internal/verify', admin = pathname === '/api/mcp/consumers';
    // This state exists before authentication/body/config awaits. It is not a map
    // lookup that can miss a request whose controller is not registered yet.
    const transport = new AbortController();
    res.once('close', () => { if (!res.writableEnded) transport.abort(); });
    res.once('error', () => transport.abort());
    const minimal = () => send(res, json({ ok: false, code: 'mcp_consumer.unauthorized' }, 403, { 'cache-control': 'no-store' }));
    try {
      if (req.method !== 'POST' || !requestIsLoopback(req) || (!admin && (req.headers.origin || req.headers['sec-fetch-site'] || req.headers['sec-fetch-mode']))) { minimal(); return true; }
      if ((admin || internal) && !tokenOk(req)) { minimal(); return true; }
      const row = admin || internal ? null : await authenticate(req);
      const chunks = []; let bytes = 0;
      if (Number(req.headers['content-length'] || 0) > limit.bytes) deny('body_limit');
      for await (const chunk of req) { bytes += chunk.length; if (bytes > limit.bytes) deny('body_limit'); chunks.push(chunk); }
      let body; try { body = JSON.parse(Buffer.concat(chunks)); } catch { deny('message_invalid'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) deny('message_invalid');
      if (internal) {
        const id = safeSessionId(body.sessionId), active = id && activeChildren.get(id);
        // Registered CLI ChildProcess ownership, not arbitrary environment claims
        // or a native provider turn's settlement record.
        if (!active || !active.child || active.kind === 'openai' || active.exited || active.state !== 'running'
          || active.child.exitCode !== null || active.child.signalCode !== null) { minimal(); return true; }
        PrivacyGateway.assertSupported(await readConfig(), 'cli');
        if (activeChildren.get(id) !== active || active.exited || active.child.exitCode !== null || active.child.signalCode !== null) { minimal(); return true; }
        send(res, json({ ok: true, instanceId: instance }, 200, { 'cache-control': 'no-store' })); return true;
      }
      if (admin) { send(res, json(await administer(body), 200, { 'cache-control': 'no-store' })); return true; }
      if (body.consumerId !== row.id) { minimal(); return true; }
      if (body.op === 'open') { const result = await open(row); send(res, json(result, 200, { 'cache-control': 'no-store' })); return true; }
      const connection = boundConnection(body, row);
      if (body.op === 'close') { retire(connection); send(res, json({ ok: true })); return true; }
      if (body.op === 'lease') {
        if (connection.lease) deny('lease_exists');
        if (res.destroyed) { retire(connection); return true; }
        // One transport owns this connection. A second socket cannot take it over.
        clearTimeout(connection.unboundTimer); connection.lease = res;
        res.on('close', () => retire(connection)); res.on('error', () => retire(connection));
        res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
        if (!res.write('\n')) { retire(connection); return true; }
        connection.heartbeat = setInterval(() => {
          try { assertCurrent(connection, row); if (res.destroyed || !res.write('\n')) retire(connection); else void checkSubscriptions(connection, row, res); }
          catch { retire(connection); }
        }, 15000); connection.heartbeat.unref();
        return true;
      }
      if (!connection.lease || connection.lease.destroyed) deny('lease_required');
      if (body.op !== 'request') deny('message_invalid');
      res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      if (res.destroyed) transport.abort();
      await run(row, connection, body.message, value => { if (!res.destroyed) res.write(value); }, transport.signal); res.end(); return true;
    } catch { if (!res.headersSent) minimal(); else res.end(); return true; }
  }
  async function listen() {
    await atomicWriteJson(path.join(dataRoot(), 'mcp-host-v1.json'), { schema: 1, host: '127.0.0.1', port: RUNTIME.port, instanceId: instance }, { mode: 0o600 });
  }
  async function relay() {
    const relayHttp = require('node:http'), relayFs = require('node:fs'), relayPath = require('node:path');
    const token = process.env.RUYI_MCP_CONSUMER_TOKEN, consumerId = process.env.RUYI_MCP_CONSUMER_ID;
    // Blank inherited management secrets even if a caller accidentally inherited
    // them. The independent transport never reads runtime.json or falls back.
    for (const key of ['WCW_TOKEN', 'WCW_SESSION_ID', 'WCW_PORT', 'WCW_HOST', 'RUYI_INTERNAL_MCP_CAP', 'RUYI_INTERNAL_MCP_PORT']) delete process.env[key];
    let connection = null, opening = null, buffered = '', running = 0, stopped = false;
    const requests = new Set(), queue = [], activeMessages = new Map();
    const messageKey = id => typeof id + ":" + String(id);
    const output = value => process.stdout.write(JSON.stringify(value) + '\n');
    const safeReplyId = id => (typeof id === 'string' && id.length <= 128) || (typeof id === 'number' && Number.isFinite(id)) ? id : null;
    const refusal = (id, code = 'unavailable') => output({ jsonrpc: '2.0', id: safeReplyId(id), error: { code: -32000,
      message: 'mcp_consumer.' + code + ': Start this Ruyi workbench, or create a connection in Settings > MCP. A write may already have completed: check its result; do not automatically retry. / 请先启动此如意工作台，或在设置的 MCP 页面生成连接配置。写操作可能已完成，请先核实，不要自动重试。', data: { operationMayHaveExecuted: true, resultUnavailable: true, retry: false } } });
    function discovery() {
      const file = relayPath.join(dataRoot(), 'mcp-host-v1.json'), stat = relayFs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error('unavailable');
      const value = JSON.parse(relayFs.readFileSync(file, 'utf8'));
      if (value.schema !== 1 || value.host !== '127.0.0.1' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 || !validId(value.instanceId)) throw Error('unavailable');
      return value;
    }
    function post(host, body, stream, signal, onPayload) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(Error('cancelled')); return; }
        const bytes = Buffer.from(JSON.stringify(body));
        const request = relayHttp.request({ hostname: '127.0.0.1', port: host.port, path: '/api/mcp/consumer', method: 'POST', agent: false,
          headers: { 'content-type': 'application/json', 'content-length': bytes.length, 'x-ruyi-mcp-consumer': token } }, response => {
          let buffer = '', total = 0;
          const decoder = new TextDecoder('utf-8', { fatal: true });
          response.on('data', chunk => {
            try {
              total += chunk.length; if (total > limit.resultBytes || response.statusCode !== 200) throw Error('unavailable');
              buffer += decoder.decode(chunk, { stream: true });
              if (stream) {
                let end;
                while ((end = buffer.indexOf('\n')) >= 0) {
                  const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
                  if (!line) continue;
                  const payload = JSON.parse(line);
                  if (payload?.jsonrpc !== '2.0' || typeof payload !== 'object') throw Error('unavailable');
                  // Host output is already protected. Do not synthesize results
                  // from client arguments or reflect transport exception text.
                  onPayload?.(payload); output(payload);
                }
              }
            } catch { response.destroy(); reject(Error('unavailable')); }
          });
          response.on('end', () => {
            try { decoder.decode(); if (response.statusCode !== 200 || (stream && buffer.trim())) throw Error('unavailable'); resolve(stream ? null : JSON.parse(buffer)); }
            catch { reject(Error('unavailable')); }
          });
          response.on('error', () => reject(Error('unavailable')));
        });
        requests.add(request);
        request.setTimeout(stream ? 120000 : 5000, () => request.destroy(Error('unavailable')));
        const cancel = () => request.destroy(Error('cancelled'));
        signal?.addEventListener('abort', cancel, { once: true });
        request.on('error', () => reject(Error('unavailable')));
        request.on('close', () => { requests.delete(request); signal?.removeEventListener('abort', cancel); });
        if (signal?.aborted) cancel(); else request.end(bytes);
      });
    }
    function lease(target) {
      return new Promise((resolve, reject) => {
        const bytes = Buffer.from(JSON.stringify({ op: 'lease', consumerId, connectionId: target.connectionId,
          instanceId: target.instanceId, grantRevision: target.grantRevision }));
        let acknowledged = false;
        const lost = () => {
          target.lost = true;
          for (const owned of requests) if (owned !== request) owned.destroy();
          if (!acknowledged) reject(Error('unavailable'));
        };
        const request = relayHttp.request({ hostname: '127.0.0.1', port: target.host.port, path: '/api/mcp/consumer', method: 'POST', agent: false,
          headers: { 'content-type': 'application/json', 'content-length': bytes.length, 'x-ruyi-mcp-consumer': token } }, response => {
          const decoder = new (require('node:string_decoder').StringDecoder)('utf8'); let pending = '', pausedForStdout = false;
          const resumeLease = () => { pausedForStdout = false; if (!target.lost && !response.destroyed) response.resume(); };
          response.once('close', () => process.stdout.removeListener('drain', resumeLease));
          response.on('data', chunk => {
            if (response.statusCode !== 200 || chunk.length > 4096) { request.destroy(); lost(); return; }
            pending += decoder.write(chunk);
            if (Buffer.byteLength(pending) > 4096) { request.destroy(); lost(); return; }
            let end;
            while ((end = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, end); pending = pending.slice(end + 1);
              if (!line) { if (!acknowledged) { acknowledged = true; request.setTimeout(45000); resolve(); } continue; }
              try {
                const value = JSON.parse(line);
                if (!acknowledged || Buffer.byteLength(line) > 512 || !value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'jsonrpc,method,params'
                  || value.jsonrpc !== '2.0' || value.method !== 'notifications/resources/updated' || !value.params || Array.isArray(value.params)
                  || Object.keys(value.params).join(',') !== 'uri' || !['ruyi://consumer/capabilities', 'ruyi://consumer/workspace'].includes(value.params.uri)) throw Error();
                if (!output(value)) {
                  response.pause();
                  if (!pausedForStdout) { pausedForStdout = true; process.stdout.once('drain', resumeLease); }
                }
              } catch { request.destroy(); lost(); return; }
            }
            if (Buffer.byteLength(pending) > 512) { request.destroy(); lost(); }
          });
          response.on('end', lost); response.on('error', lost); response.on('aborted', lost);
        });
        requests.add(request); request.setTimeout(5000, () => request.destroy());
        request.on('error', lost); request.on('close', () => { requests.delete(request); lost(); }); request.end(bytes);
      });
    }
    async function connected() {
      const host = discovery();
      if (connection) {
        if (connection.lost || connection.host.instanceId !== host.instanceId || connection.host.port !== host.port) throw Error('reconnect_required');
        return connection;
      }
      if (!opening) opening = post(host, { op: 'open', consumerId }).then(async value => {
        if (!validId(value.connectionId) || value.instanceId !== host.instanceId || !Number.isSafeInteger(value.grantRevision)) throw Error('unavailable');
        const target = { host, ...value, lost: false }; await lease(target);
        if (stopped || target.lost) throw Error('unavailable');
        connection = target; return connection;
      }).finally(() => { opening = null; });
      return opening;
    }
    async function processMessage(message) {
      if (stopped) return;
      const isRpc = message.id !== undefined && message.method !== 'notifications/cancelled';
      const key = messageKey(message.id), owner = isRpc ? { controller: new AbortController(), finalReply: false } : null;
      if (owner) {
        if (activeMessages.has(key)) { refusal(message.id, 'capacity'); return; }
        activeMessages.set(key, owner);
      }
      try {
        if (!/^[a-f0-9]{64}$/.test(token || '') || !validId(consumerId)) { refusal(message?.id, 'setup_required'); return; }
        const target = await connected();
        if (owner?.controller.signal.aborted || stopped) throw Error('cancelled');
        await post(target.host, { op: 'request', consumerId, connectionId: target.connectionId, instanceId: target.instanceId,
          grantRevision: target.grantRevision, message }, true, owner?.controller.signal, payload => {
            const result = Object.hasOwn(payload, 'result'), failure = Object.hasOwn(payload, 'error');
            if (owner && payload.id === message.id && payload.jsonrpc === '2.0' && result !== failure
              && (!failure || (payload.error && Number.isFinite(payload.error.code) && typeof payload.error.message === 'string'))) owner.finalReply = true;
          });
        if (message.id !== undefined && (!owner || !owner.finalReply)) refusal(message.id);
      } catch { if (message.id !== undefined && !owner?.finalReply) refusal(message.id, owner?.controller.signal.aborted ? 'cancelled' : 'unavailable'); }
      finally { if (owner && activeMessages.get(key) === owner) activeMessages.delete(key); }
      // No automatic reconnect or retry: a lost write response can mean that the
      // side effect already happened. Consumer restart creates a fresh scope.
    }
    function pump() {
      while (!stopped && running < limit.inflight && queue.length) {
        running++; void processMessage(queue.shift()).finally(() => { running--; pump(); });
      }
    }
    const close = () => {
      if (stopped) return; stopped = true; queue.length = 0;
      for (const owner of activeMessages.values()) owner.controller.abort();
      for (const request of requests) request.destroy();
      if (connection) void post(connection.host, { op: 'close', consumerId, connectionId: connection.connectionId, instanceId: connection.instanceId, grantRevision: connection.grantRevision }, false).catch(() => {});
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      buffered += chunk;
      if (Buffer.byteLength(buffered) > limit.bytes) { refusal(null, 'body_limit'); buffered = ''; close(); return; }
      let end;
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); if (!message || typeof message !== 'object' || Array.isArray(message)) throw Error(); }
        catch { refusal(null, 'message_invalid'); continue; }
        if (message.method === 'notifications/cancelled') {
          const key = messageKey(message.params?.requestId);
          const index = queue.findIndex(item => messageKey(item.id) === key);
          if (index >= 0) { const [removed] = queue.splice(index, 1); refusal(removed.id, 'cancelled'); }
          activeMessages.get(key)?.controller.abort();
          // The exact original HTTP is its host cancellation capability. Do not
          // forward a second ID-only notification that could arrive after ID reuse.
        } else {
          if (queue.length >= 32 || (message.id !== undefined && (activeMessages.has(messageKey(message.id)) || queue.some(item => messageKey(item.id) === messageKey(message.id))))) { refusal(message.id, 'capacity'); continue; }
          queue.push(message); pump();
        }
      }
    });
    process.stdin.on('end', close); process.stdin.on('error', close); process.once('SIGTERM', close);
  }
  async function verifyInternal() {
    const host = process.env.WCW_HOST || '127.0.0.1', port = Number(process.env.WCW_PORT), token = process.env.WCW_TOKEN, id = process.env.WCW_SESSION_ID;
    const setupError = () => error('mcp_consumer.setup_required: Create an independent connection in Ruyi Settings > MCP. / 请在如意设置的 MCP 页面生成独立连接配置。');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{32}$/.test(token || '') || !safeSessionId(id)) throw setupError();
    const relayHttp = require('node:http'), bytes = Buffer.from(JSON.stringify({ sessionId: id }));
    await new Promise((resolve, reject) => {
      const request = relayHttp.request({ hostname: host, port, path: '/api/mcp/internal/verify', method: 'POST', agent: false,
        headers: { 'x-wcw-token': token, 'content-type': 'application/json', 'content-length': bytes.length } }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 2048) response.destroy(); });
        response.on('end', () => { try { if (response.statusCode !== 200 || JSON.parse(body).ok !== true) throw Error(); resolve(); } catch { reject(setupError()); } });
        response.on('error', () => reject(setupError()));
      });
      request.setTimeout(3000, () => request.destroy()); request.on('error', () => reject(setupError())); request.end(bytes);
    });
  }
  function maintenanceState() { return { active: [...connections.values()].reduce((sum, row) => sum + row.inflight.size + Number(row.checkingSubscriptions), 0), pending: [...writes.values()] }; }
  return Object.freeze({ handle, listen, relay, verifyInternal, instance, maintenanceState });
})();
const priorConsumerApi = PrivacyCore.configHooks.handleApiRoutes;
PrivacyCore.configHooks.handleApiRoutes = async (req, res, pathname) => await McpConsumers.handle(req, res, pathname) || await priorConsumerApi(req, res, pathname);
PrivacyCore.configHooks.consumerListen = McpConsumers.listen;
PrivacyCore.configHooks.startConsumerMcp = McpConsumers.relay;
PrivacyCore.configHooks.verifyInternalMcp = McpConsumers.verifyInternal;
