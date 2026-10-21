PrivacyRecipientHooks.isPrivateExecution = () => PrivacyGateway.isExecutingOriginal();
PrivacyRecipientHooks.configState = () => ({ generation: configReadGeneration, config: configReadCache?.snapshot });
PrivacyRecipientHooks.queryDrives = (roots, signal) => PrivacyLocalDriveProbe.query(roots, signal);
PrivacyFileIoHooks.beforeIo = (targets, write, kind) => PrivacyGateway.beforeExecutionIo(targets, write, kind);
PrivacyFileIoHooks.assertIo = () => PrivacyGateway.assertIo();
// 81: This administration surface requires the workbench token, including loopback clients.
PrivacyGateway.setHost({ data: paths.data, planDisclosure: planPrivacyToolDisclosure, isRegisteredTool: name => Object.prototype.hasOwnProperty.call(TOOL_HANDLERS, name) || Boolean(nativeToolSchema(name)), normalizeToolInvokeArgs: args => normalizeToolInvokeArgs(args), makeStore: (file, key) => DurableJsonStore.create({
  id: 'privacy-mapping-' + key, file, schemaKey: 'version', schemaVersion: 1, cache: false, strictRead: true, quarantine: false,
  defaultValue: () => ({}), validate: value => value.version === 1 && typeof value.instanceId === 'string' && !!value.envelope,
}) });
PrivacyCore.configHooks.isBusy = () => activeChildren.size > 0 || turnSettlers.size > 0;
// One validator/transaction for the settings page and the steward. Pending drafts are
// process-local and owned by one turn; they never change that turn's privacy policy.
const PrivacySettings = (() => {
  const pending = new Map();
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const draft = body => {
    if (!['off', 'basic', 'enhanced', 'strict'].includes(body.mode) || typeof body.technical !== 'boolean' || !Array.isArray(body.rules) || body.rules.length > 100) fail('privacy.settings_invalid');
    PrivacyRegex.validateSchema(body.rules);
    return { privacyModeV1: body.mode, privacyTechnicalV1: body.technical, privacyRulesV1: structuredClone(body.rules) };
  };
  async function apply(body) {
    if (PrivacyCore.configHooks.isBusy()) fail('privacy.busy');
    const policy = draft(body);
    const conditional = Object.hasOwn(body, 'expectedRuleVersion') || Object.hasOwn(body, 'expectedEncryption');
    if (conditional && (!/^[a-f0-9]{16}$/.test(body.expectedRuleVersion || '') || typeof body.expectedEncryption !== 'boolean')) fail('privacy.settings_invalid');
    await PrivacyRegex.validate(body.rules);
    await mutateConfig(current => {
      if (PrivacyCore.configHooks.isBusy()) fail('privacy.busy');
      if (conditional && (body.expectedRuleVersion !== PrivacyGateway.ruleVersion(current) || body.expectedEncryption !== (current.credentialEncryptionV1 === true))) fail('privacy.settings_changed');
      if (Object.hasOwn(body, 'encryption')) {
        if (typeof body.encryption !== 'boolean') fail('privacy.settings_invalid');
        if (body.encryption && process.platform !== 'win32') fail('credential_vault.unsupported');
        if (!body.encryption && body.mode !== 'off') fail('privacy.encryption_required');
        if (!body.encryption && current.credentialEncryptionV1 === true && body.confirmPlaintext !== true) fail('privacy.plaintext_confirmation_required');
        current.credentialEncryptionV1 = body.encryption;
      }
      if (body.mode !== 'off' && current.credentialEncryptionV1 !== true) fail('privacy.encryption_required');
      Object.assign(current, policy);
      current.privacyPolicyRecoveryRequiredV1 = false;
      return {};
    }, { credentialEncryptionDisable: body.encryption === false && body.confirmPlaintext === true });
    return { ok: true, ruleVersion: PrivacyGateway.ruleVersion(policy) };
  }
  const inspect = config => ({ mode: config.privacyModeV1, technical: config.privacyTechnicalV1 === true,
    encryption: config.credentialEncryptionV1 === true, rules: (config.privacyRulesV1 || []).map(rule => rule.kind === 'literal'
      ? { id: rule.id, kind: rule.kind, category: rule.category, valueConfigured: true } : structuredClone(rule)), ruleVersion: PrivacyGateway.ruleVersion(config) });
  async function administer(args, owner) {
    const config = await readConfig();
    if (args.op === 'inspect') return { ok: true, privacy: inspect(config), pending: pending.has(owner?.sessionId) };
    if (!['preview', 'update'].includes(args.op) || typeof args.expectedRuleVersion !== 'string' || args.expectedRuleVersion !== PrivacyGateway.ruleVersion(config)) fail('privacy.settings_changed');
    if (args.mode !== undefined && !['off', 'basic', 'enhanced', 'strict'].includes(args.mode)) fail('privacy.settings_invalid');
    if (args.technical !== undefined && typeof args.technical !== 'boolean') fail('privacy.settings_invalid');
    if ((args.upsert !== undefined && !Array.isArray(args.upsert)) || (args.remove !== undefined && (!Array.isArray(args.remove) || args.remove.some(id => typeof id !== 'string')))) fail('privacy.settings_invalid');
    const upsert = args.upsert || [], remove = args.remove || [];
    if (upsert.length > 20 || remove.length > 100 || upsert.some(rule => !rule || Object.keys(rule).some(key => !['id', 'kind', 'value', 'category', 'flags'].includes(key)))) fail('privacy.settings_invalid');
    if (args.mode === undefined && args.technical === undefined && !upsert.length && !remove.length) fail('privacy.settings_invalid');
    PrivacyRegex.validateSchema(upsert);
    if (new Set(remove).size !== remove.length || remove.some(id => !config.privacyRulesV1.some(rule => rule.id === id)) || upsert.some(rule => remove.includes(rule.id))) fail('privacy.settings_invalid');
    const rules = new Map((config.privacyRulesV1 || []).map(rule => [rule.id, rule]));
    for (const id of remove) rules.delete(id);
    for (const rule of upsert) rules.set(rule.id, structuredClone(rule));
    const body = { mode: args.mode ?? config.privacyModeV1, technical: args.technical ?? config.privacyTechnicalV1,
      rules: [...rules.values()], expectedRuleVersion: args.expectedRuleVersion, expectedEncryption: config.credentialEncryptionV1 === true };
    const policy = draft(body);
    await PrivacyRegex.validate(body.rules);
    // Synthetic cases are local only. Every changed rule needs its own positive
    // and negative case, tested alone so an existing detector cannot hide a bad rule.
    const tests = args.tests || [];
    if (!Array.isArray(tests) || tests.length > 40) fail('privacy.settings_invalid');
    if (upsert.some(rule => !tests.some(row => row.ruleId === rule.id && row.match === true) || !tests.some(row => row.ruleId === rule.id && row.match === false))) fail('privacy.rule_tests_required');
    const checks = [];
    for (const row of tests) {
      const rule = upsert.find(item => item.id === row?.ruleId);
      if (!rule || Object.keys(row).some(key => !['ruleId', 'sample', 'match'].includes(key)) || typeof row.sample !== 'string' || Buffer.byteLength(row.sample) > 8192 || typeof row.match !== 'boolean') fail('privacy.settings_invalid');
      const tested = await PrivacyGateway.preview({ ...config, privacyModeV1: 'enhanced', privacyTechnicalV1: false, privacyRulesV1: [rule] }, row.sample);
      const matched = tested.matches.some(hit => hit.ruleIds?.includes(rule.id));
      checks.push({ ruleId: rule.id, expected: row.match, matched, passed: matched === row.match });
    }
    if (checks.some(row => !row.passed)) return { ok: false, error: 'privacy.rule_test_failed', checks, saved: false };
    const target = { ...config, ...policy };
    const preview = { ok: true, saved: false, checks, privacy: { mode: body.mode, technical: body.technical, ruleCount: body.rules.length, ruleVersion: PrivacyGateway.ruleVersion(target) } };
    if (args.op === 'preview') return preview;
    if (!owner?.sessionId || !Number.isSafeInteger(owner.turnSeq) || !turnSettlers.has(owner.sessionId)) fail('privacy.turn_required');
    if (pending.has(owner.sessionId)) fail('privacy.update_pending');
    if (body.mode !== 'off' && !body.expectedEncryption) body.encryption = true;
    if (body.encryption && process.platform !== 'win32') fail('credential_vault.unsupported');
    pending.set(owner.sessionId, { turnSeq: owner.turnSeq, body: structuredClone(body) });
    return { ...preview, status: 'pending', effective: 'after_successful_turn', note: '本轮正常结束且应用空闲时保存；冲突、停止或失败则不保存。关闭脱敏保留凭据加密。' };
  }
  async function settle(sessionId, turnSeq, successful) {
    const item = pending.get(sessionId);
    if (!item || item.turnSeq !== turnSeq) return null;
    pending.delete(sessionId);
    let result;
    try {
      if (!successful) result = { ok: false, saved: false, error: 'privacy.turn_cancelled' };
      else result = { ...await apply(item.body), saved: true, status: 'applied', mode: item.body.mode, technical: item.body.technical, ruleCount: item.body.rules.length };
    } catch (error) { result = { ok: false, saved: false, error: /^(?:privacy|credential_vault)\.[a-z_]+$/.test(error.code || '') ? error.code : 'privacy.request_failed' }; }
    // Only metadata enters the decision log; no patterns, literal secrets or samples.
    stewardAppendDecision({ tool: 'steward_config_set', args: { privacy: true, turnSeq, result }, targetSessionId: sessionId,
      permissionMode: '', mayAct: 'user', undoRef: { kind: 'none' }, basis: {} });
    return result;
  }
  return { draft, apply, administer, settle };
})();
PrivacyCore.configHooks.stewardPrivacy = PrivacySettings.administer;
PrivacyCore.configHooks.settleStewardPrivacy = PrivacySettings.settle;
// Text copies have one host boundary. Proofs contain assertions, not private mappings.
const PrivacyTextExports = (() => {
  const proofs = new Map(), omitted = '[来源无法核验，内容未导出 / Unverified source: content withheld]';
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  async function memorySource() {
    const store = await stewardReadMemoryStore();
    return { ok: true, schema: STEWARD_MEMORY_SCHEMA, entries: store.entries.filter(e => e.state === 'active') };
  }
  async function prepare(body, retainProof = true, operationGuard = PrivacyGateway.disclosurePolicyGuard()) {
    for (let attempt = 0; attempt < 4; attempt++) {
      operationGuard();
      try { return await prepareOnce(body, retainProof, operationGuard); }
      catch (error) { if (error.code !== 'privacy.disclosure_dirty' || attempt === 3) throw error; }
    }
  }
  async function prepareOnce(body, retainProof, guard) {
    const configGeneration = configReadGeneration;
    const config = await readConfig(); guard();
    const privacySnapshot = { mode: config.privacyModeV1 || 'off', technical: config.privacyTechnicalV1 === true, rules: config.privacyRulesV1 || [] };
    if ((Object.hasOwn(body, 'expectedPrivacy') || body.kind === 'mermaid-document') && JSON.stringify(body.expectedPrivacy) !== JSON.stringify(privacySnapshot)) fail('privacy.export_source_changed');
    if (body.kind === 'memory' && configGeneration !== configReadGeneration) fail('privacy.disclosure_dirty');
    const enabled = PrivacyGateway.enabled(config), plaintext = body.plaintext === true;
    const sourceGuards = []; let mappingGuardCount = 0;
    let value, scopes = [], source, check, format = body.format, missing = false;
    if (body.kind === 'session') {
      const id = safeSessionId(body.sessionId);
      if (!id || !(source = await loadSession(id))) fail('privacy.export_source_missing');
      const sourceHash = hash(source), seq = sessionDiskWriteSeqOf(id);
      sourceGuards.push(() => { if (sessionDiskWriteSeqOf(id) !== seq) fail('privacy.export_source_changed'); });
      check = async () => { if (hash(await loadSession(id)) !== sourceHash || sessionDiskWriteSeqOf(id) !== seq) fail('privacy.export_source_changed'); };
      scopes = [id];
      let session = source;
      if (plaintext || !enabled) {
        const local = await PrivacyGateway.prepareLocalDisclosure(id, () => plaintext ? PrivacyGateway.restoreHistory(id, source)
          : PrivacyGateway.displayEnvelope(id, { session: source }));
        session = plaintext ? local.value : local.value.session; sourceGuards.push(local.assert);
      }
      format = ['json', 'html', 'md'].includes(format) ? format : 'md';
      value = { session, filename: `${session.title || 'session'}.${format}` };
    } else if (body.kind === 'mermaid-document') {
      if (!['copy', 'svg', 'png'].includes(format) || typeof body.expectedDocumentHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedDocumentHash)) fail('privacy.export_invalid');
      const id = safeSessionId(body.sessionId);
      let document;
      if (!id) {
        // OFF-only local views have no session/restoration authority. A later
        // opt-in cannot reuse this caller-supplied source as a canonical proof.
        if ((config.privacyModeV1 || 'off') !== 'off' || plaintext || body.sessionId !== undefined || typeof body.localDocument !== 'string') fail('privacy.export_source_missing');
        document = body.localDocument; source = { localDocument: document };
        check = async () => {};
      } else {
        const session = await loadSession(id), index = body.messageIndex, identity = body.messageIdentity;
        const message = session?.messages?.[index];
        if (!session || !Number.isSafeInteger(index) || index < 0 || !message || !identity || typeof identity !== 'object' || Array.isArray(identity)
          || identity.role !== message.role || identity.role !== 'assistant' || identity.createdAt !== (message.createdAt || '')
          || identity.turnSeq !== (message.turnSeq ?? null) || identity.id !== (message.id || '')) fail('privacy.export_source_changed');
        if (body.slot === 'content') document = message.content;
        else {
          const segment = Number.isSafeInteger(body.segmentIndex) && body.segmentIndex >= 0 ? message.segments?.[body.segmentIndex] : null;
          if (body.slot === 'segment-text' && segment?.type === 'text') document = segment.text;
          else if (body.slot === 'segment-markdown' && segment?.type === 'plan') document = segment.markdown;
        }
        if (typeof document !== 'string') fail('privacy.export_source_missing');
        const sourceHash = hash(session), seq = sessionDiskWriteSeqOf(id);
        sourceGuards.push(() => { if (sessionDiskWriteSeqOf(id) !== seq) fail('privacy.export_source_changed'); });
        check = async () => { if (hash(await loadSession(id)) !== sourceHash || sessionDiskWriteSeqOf(id) !== seq) fail('privacy.export_source_changed'); };
        source = { sessionId: id, messageIndex: index, messageIdentity: identity, slot: body.slot, segmentIndex: body.segmentIndex, document };
        scopes = [id];
        const selectDocument = row => body.slot === 'content' ? row.content : row.segments?.[body.segmentIndex]?.[body.slot === 'segment-text' ? 'text' : 'markdown'];
        // Match GET's exact content/segment display contract, including escaped
        // JSON aliases and plan snapshots that intentionally remain literal.
        const local = await PrivacyGateway.prepareLocalDisclosure(id, () => PrivacyGateway.displayMessages(id, [message]));
        sourceGuards.push(local.assert);
        const displayedDocument = selectDocument(local.value[0]);
        if (hash(displayedDocument) !== body.expectedDocumentHash) fail('privacy.export_source_changed');
        if (plaintext) {
          const plain = await PrivacyGateway.prepareLocalDisclosure(id, () => PrivacyGateway.restoreHistory(id, { document }));
          document = plain.value.document; sourceGuards.push(plain.assert);
        } else if (!enabled) document = displayedDocument;
      }
      if (Buffer.byteLength(document) > 1048576 || (!id && hash(document) !== body.expectedDocumentHash)) fail('privacy.export_source_limit');
      value = { document, filename: 'mermaid-' + Date.now() + (format === 'copy' ? '.txt' : '.' + format) };
    } else if (body.kind === 'memory') {
      if (config.stewardEnabledV1 !== true) fail('privacy.export_source_changed');
      await stewardMemoryChain;
      const epoch = stewardMemoryWriteEpoch;
      const memoryGuard = () => {
        if (stewardMemoryWriteEpoch !== epoch || epoch % 2) fail('privacy.export_source_changed');
        if (configReadGeneration !== configGeneration) fail('privacy.disclosure_dirty');
      };
      memoryGuard(); sourceGuards.push(memoryGuard);
      source = await memorySource(); const originalHash = hash(source);
      check = async () => {
        if ((await readConfig()).stewardEnabledV1 !== true || hash(await memorySource()) !== originalHash) fail('privacy.export_source_changed');
      };
      scopes = [STEWARD_SESSION_ID];
      const entries = [];
      for (const entry of source.entries) {
        const ids = [entry.sourceSessionId, ...(entry.mergedFrom || []).map(ref => ref.sessionId)].filter(Boolean);
        const valid = [];
        for (const id of [...new Set(ids)]) if (safeSessionId(id)) valid.push(id);
        if (enabled && (!ids.length || valid.length !== new Set(ids).size)) {
          missing = true; entries.push({ id: entry.id, state: entry.state, contentWithheld: true, text: omitted });
        } else if (enabled && !plaintext) {
          const copy = await PrivacyGateway.prepareMultiSourceDisclosure(entry, [...new Set([STEWARD_SESSION_ID, ...valid])], { recipient: 'user-file-copy', purpose: 'text-export:memory-entry', sourceHash: hash(entry) });
          mappingGuardCount += new Set([STEWARD_SESSION_ID, ...valid]).size;
          entries.push(copy.value); sourceGuards.push(copy.assert);
        } else { entries.push(entry); scopes.push(...valid); }
      }
      // Memory may contain aliases from merged sources. Explicit plaintext copies
      // retain local raw text but never guess which scope owns such an alias.
      value = { payload: { ...source, exportedAt: nowIso(), entries }, filename: 'steward-memory.json' };
      if (plaintext && enabled) {
        const before = JSON.stringify(value); value = PrivacyGateway.foreignView(value);
        missing ||= before !== JSON.stringify(value);
      }
      if (enabled && !plaintext) scopes = [STEWARD_SESSION_ID];
      format = 'json';
    } else if (body.kind === 'raw-events') {
      if (!Array.isArray(body.events) || body.events.length > 2000 || Buffer.byteLength(JSON.stringify(body.events)) > 1024 * 1024) fail('privacy.body_limit');
      source = structuredClone(body.events); check = async () => {};
      const events = [], groups = new Map();
      const sourceSessions = new Map();
      for (const event of source) {
        if (!event || typeof event.line !== 'string' || !Number.isSafeInteger(event.seq)) fail('privacy.export_invalid');
        const id = typeof event.sourceSessionId === 'string' && safeSessionId(event.sourceSessionId);
        if (id && !sourceSessions.has(id)) sourceSessions.set(id, await loadSession(id));
        const valid = id && sourceSessions.get(id);
        if (enabled && !plaintext && !valid) { missing = true; events.push(JSON.stringify({ seq: event.seq, contentWithheld: true, message: omitted })); }
        else {
          const index = events.push(event.line) - 1;
          if (valid && enabled && !plaintext) {
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id).push({ index, line: event.line });
          }
        }
      }
      for (const [id, group] of groups) {
        const copy = await PrivacyGateway.prepareMultiSourceDisclosure(group.map(row => row.line), [id], { recipient: 'user-file-copy', purpose: 'text-export:raw-group', sourceHash: hash(group) });
        mappingGuardCount++;
        group.forEach((row, index) => { events[row.index] = copy.value[index]; }); sourceGuards.push(copy.assert);
      }
      // Submitted debug lines are requested local content, never restoration proof.
      value = { events, filename: `claude-events-${Date.now()}.ndjson` }; format = 'ndjson';
    } else fail('privacy.export_invalid');
    scopes = [...new Set(scopes)];
    if (!scopes.length) scopes = [STEWARD_SESSION_ID];
    if (enabled && !plaintext && Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) fail('privacy.export_source_limit');
    const binding = { recipient: 'user-file-copy', purpose: 'text-export:' + body.kind, sourceHash: hash(source) };
    const sourceGuard = plaintext && enabled ? await PrivacyGateway.prepareMultiSourceDisclosure(null, scopes, binding) : null;
    const prepared = plaintext || !enabled ? { value, assert: () => { guard(); sourceGuard?.assert(); } } : await PrivacyGateway.prepareMultiSourceDisclosure(value, scopes, binding);
    mappingGuardCount += scopes.length;
    value = prepared.value;
    let content, mime;
    if (body.kind === 'session') {
      const s = value.session;
      if (format === 'json') { content = JSON.stringify(s, null, 2); mime = 'application/json'; }
      else if (format === 'html') {
        const rows = (s.messages || []).map(m => `<div class="m ${escape(m.role)}"><b>${escape(m.role)}</b><pre>${escape(m.content || '')}</pre></div>`).join('\n');
        content = `<!doctype html><meta charset="utf-8"><title>${escape(s.title || '')}</title><style>body{font-family:sans-serif;max-width:820px;margin:2rem auto}pre{white-space:pre-wrap;background:#f4f4f4;padding:8px;border-radius:6px}.m{margin:1rem 0}</style><h1>${escape(s.title || '')}</h1>${rows}`; mime = 'text/html';
      } else { content = `# ${s.title || 'Session'}\n\n` + (s.messages || []).map(m => `## ${m.role}\n\n${m.content || ''}`).join('\n\n'); mime = 'text/markdown'; }
    } else if (body.kind === 'mermaid-document') { content = value.document; mime = 'text/markdown'; }
    else if (body.kind === 'memory') { content = JSON.stringify(value.payload, null, 2); mime = 'application/json'; }
    else { content = value.events.join('\n'); mime = 'application/x-ndjson'; }
    const assert = () => { guard(); prepared.assert(); for (const sourceGuard of sourceGuards) sourceGuard(); };
    await check(); assert();
    const filename = body.kind === 'session' ? `${(value.session.title || 'session').replace(/[^\w一-龥-]+/g, '_').slice(0, 40)}.${format}` : value.filename;
    const artifact = { ok: true, filename, mime, content, protected: enabled && !plaintext, contentWithheld: missing };
    if (!retainProof) return { artifact, assert, payload: value.payload };
    const proof = crypto.randomBytes(24).toString('hex'), artifactHash = hash(artifact);
    for (const [id, item] of proofs) if (item.expires < Date.now()) proofs.delete(id);
    const bytes = 3 * (Buffer.byteLength(JSON.stringify(body)) + Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(content)) + mappingGuardCount * 2048;
    if (proofs.size >= 4 || bytes + [...proofs.values()].reduce((sum, item) => sum + item.bytes, 0) > 64 * 1024 * 1024) fail('privacy.export_busy');
    proofs.set(proof, { expires: Date.now() + 60000, bytes, hash: artifactHash, check, assert, reprepare: () => prepare(body, true, guard) });
    return { artifact: { ...artifact, proof, hash: artifactHash }, assert, payload: value.payload };
  }
  async function validate(body) {
    const item = proofs.get(body.proof);
    if (!item || item.expires < Date.now() || item.hash !== body.hash) fail('privacy.export_expired');
    proofs.delete(body.proof);
    await item.check();
    try { item.assert(); return { assert: item.assert }; }
    catch (error) { if (error.code !== 'privacy.disclosure_dirty') throw error; return item.reprepare(); }
  }
  return { prepare, validate };
})();
// The domain route loads earlier. Bind only its protected, proof-free memory
// copy capability after this policy owner initializes; no raw fallback exists.
StewardHooks.prepareMemoryExportCopy = () => PrivacyTextExports.prepare({ kind: 'memory' }, false);
PrivacyCore.configHooks.handleApiRoutes = async (req, res, pathname) => {
  const routes = new Set(['/api/privacy/export', '/api/privacy/status', '/api/privacy/settings', '/api/privacy/encryption', '/api/privacy/rules/test', '/api/privacy/use-native', '/api/privacy/backup/export', '/api/privacy/backup/preview', '/api/privacy/backup/import']);
  if (!routes.has(pathname)) return false;
  const reply = value => send(res, json(value, 200, { 'cache-control': 'no-store' }));
  const nativeProviders = config => (config.providers || []).filter(provider => provider.type === 'openai-compat' && provider.model && !String(provider.id).startsWith('toolbox-')).map(provider => ({ id: provider.id, label: provider.label || provider.id, model: provider.model }));
  const draft = PrivacySettings.draft;
  const encryption = (current, enabled, confirmPlaintext, mode = current.privacyModeV1) => {
    if (typeof enabled !== 'boolean') throw Object.assign(new Error(), { code: 'privacy.settings_invalid' });
    if (enabled && process.platform !== 'win32') throw Object.assign(new Error(), { code: 'credential_vault.unsupported' });
    if (!enabled && mode !== 'off') throw Object.assign(new Error(), { code: 'privacy.encryption_required' });
    if (!enabled && current.credentialEncryptionV1 === true && confirmPlaintext !== true) throw Object.assign(new Error(), { code: 'privacy.plaintext_confirmation_required' });
    current.credentialEncryptionV1 = enabled;
  };
  try {
    if (req.method === 'GET') {
      const config = await readConfig();
      if (req.method === 'GET' && pathname === '/api/privacy/status') reply({ ok: true, encryption: config.credentialEncryptionV1 === true, supported: process.platform === 'win32', recoveryRequired: PrivacyGateway.recoveryRequired(), mode: config.privacyModeV1, coverage: 'native-text', activeProvider: config.activeProvider, nativeProviders: nativeProviders(config), channels: [
        { id: 'nativeText', supported: true }, { id: 'managedMcpText', supported: true },
        { id: 'cli', supported: false }, { id: 'standaloneMcp', supported: false }, { id: 'media', supported: false }, { id: 'serverTools', supported: false },
      ] });
      else if (req.method === 'GET' && pathname === '/api/privacy/settings') reply({ ok: true, encryption: config.credentialEncryptionV1 === true, recoveryRequired: PrivacyGateway.recoveryRequired(), mode: config.privacyModeV1, technical: config.privacyTechnicalV1, rules: config.privacyRulesV1, ruleVersion: PrivacyGateway.ruleVersion(config), regexLimits: PrivacyRegex.LIMITS, catalog: PrivacyRuleCatalog.list() });
      else return false;
      return true;
    }
    if (req.method !== 'POST') return false;
    const cap = 2 * 1024 * 1024;
    if (Number(req.headers['content-length'] || 0) > cap) throw Object.assign(new Error(), { code: 'privacy.body_limit' });
    const chunks = []; let bytes = 0;
    for await (const chunk of req) { bytes += chunk.length; if (bytes > cap) throw Object.assign(new Error(), { code: 'privacy.body_limit' }); chunks.push(chunk); }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error(), { code: 'privacy.settings_invalid' });
    if (pathname === '/api/privacy/export') {
      if (body.kind === 'memory' && body.op !== 'validate') {
        const gate = await stewardPanelGate(req); if (gate) { send(res, gate); return true; }
      }
      const prepared = body.op === 'validate' ? await PrivacyTextExports.validate(body) : await PrivacyTextExports.prepare(body);
      const response = json(prepared.artifact || { ok: true }, 200, { 'cache-control': 'no-store' });
      prepared.assert(); send(res, response);
    } else if (req.method === 'POST' && pathname === '/api/privacy/settings') {
      reply(await PrivacySettings.apply(body));
    } else if (req.method === 'POST' && pathname === '/api/privacy/encryption') {
      await mutateConfig(current => {
        if (PrivacyCore.configHooks.isBusy()) throw Object.assign(new Error(), { code: 'privacy.busy' });
        encryption(current, body.enabled, body.confirmPlaintext);
        return {};
      }, { credentialEncryptionDisable: body.enabled === false && body.confirmPlaintext === true });
      reply({ ok: true, encryption: body.enabled });
    } else if (req.method === 'POST' && pathname === '/api/privacy/rules/test') {
      const policy = draft(body);
      reply({ ok: true, ...await PrivacyGateway.preview({ ...await readConfig(), ...policy }, body.sample) });
    } else if (req.method === 'POST' && pathname === '/api/privacy/use-native') {
      await mutateConfig(current => {
        if (PrivacyCore.configHooks.isBusy()) throw Object.assign(new Error(), { code: 'privacy.busy' });
        if (typeof body.providerId !== 'string' || !nativeProviders(current).some(provider => provider.id === body.providerId)) throw Object.assign(new Error(), { code: 'privacy.provider_invalid' });
        current.activeProvider = body.providerId;
        current.lastUsedEngineRoute = sessionEngineRouteFromConfig(current);
        return {};
      }); reply({ ok: true });
    } else if (req.method === 'POST' && pathname === '/api/privacy/backup/export') {
      if ((await readConfig()).credentialEncryptionV1 !== true) throw Object.assign(new Error(), { code: 'privacy.encryption_required' });
      reply({ ok: true, backup: await PrivacyCore.configHooks.exportBackup(body.password) });
    }
    else if (req.method === 'POST' && pathname === '/api/privacy/backup/preview') reply({ ok: true, ...await PrivacyCore.configHooks.preview(body.backup, body.password) });
    else if (req.method === 'POST' && pathname === '/api/privacy/backup/import') reply(await PrivacyCore.configHooks.commit(body.ticket));
    else return false;
  } catch (error) {
    const code = /^(?:privacy|credential_vault|credential_recovery)\.[a-z_]+$/.test(error.code || '') ? error.code : 'privacy.request_failed';
    const params = typeof error.ruleId === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(error.ruleId) ? { ruleId: error.ruleId } : {};
    const response = apiFailure(code, params, code, code === 'privacy.body_limit' ? 413 : 409);
    response.headers['cache-control'] = 'no-store'; send(res, response);
  }
  return true;
};
