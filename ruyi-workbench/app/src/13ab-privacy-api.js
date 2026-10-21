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
PrivacyCore.configHooks.handleApiRoutes = async (req, res, pathname) => {
  const routes = new Set(['/api/privacy/status', '/api/privacy/settings', '/api/privacy/encryption', '/api/privacy/rules/test', '/api/privacy/use-native', '/api/privacy/backup/export', '/api/privacy/backup/preview', '/api/privacy/backup/import']);
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
    if (req.method === 'POST' && pathname === '/api/privacy/settings') {
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
