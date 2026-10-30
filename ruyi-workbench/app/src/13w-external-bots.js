// External ingress defaults to an independent inbox. Explicit local owner bindings may additionally
// run the existing Steward and deliver one bounded reply; queued/running/sending facts are durable.
const EXTERNAL_BOT_LIMITS = Object.freeze({ connections: 16, retiredIds: 4096, items: 1000, textChars: 8192, textBytes: 32768, bodyBytes: 65536, stateBytes: 40 * 1024 * 1024, readTimeoutMs: 5000, inflightCallbacks: 8, callbacksPerMinute: 120 });
const EXTERNAL_BOT_CONNECTION_KEYS = Object.freeze(['id', 'platform', 'label', 'enabled', 'appId', 'tenantId', 'botUserId', 'allowedSenderIds', 'allowedConversationIds', 'verificationTokenEnv', 'encryptKeyEnv', 'botSecretEnv', 'appSecretEnv', 'mode', 'ownerSenderId', 'ownerConversationId', 'ownerConversationType', 'progressUpdates']);
const externalBotActors = new WeakMap();
const externalBotActiveActors = new Map();
const externalBotUnsettled = new Map();
const externalBotDeliveries = new Map();
const externalBotChains = new Map();
const externalBotPairings = new Map(); // At most one five-minute window per existing connection; never persisted.
const EXTERNAL_BOT_SETUP_KEYS = Object.freeze(['op', 'connectionId', 'platform', 'appId', 'tenantId', 'botUserId', 'label']);
const EXTERNAL_BOT_SETUP_PATHS = Object.freeze(['/api/external-bots/setup', '/api/external-bots/credentials', '/api/external-bots/discover']);
// A discovery probe performs outbound requests with an owner-supplied app secret: one flight, bounded rate.
const EXTERNAL_BOT_DISCOVERY_LIMITS = Object.freeze({ perMinute: 10 });
let externalBotDiscoveryBusy = false;
let externalBotDiscoveryRate = { at: 0, count: 0 };
let externalBotInflight = 0;
let externalBotRate = { at: 0, count: 0 };
let externalBotWorkerBusy = false;
let externalBotWorkerAgain = false;
let externalBotWorkerStopped = false;
let externalBotRecoveryDone = false;
let externalBotWorkerError = '';
let externalBotWorkerSignal = null;
let externalBotFeedbackTimer = null;
function externalBotError(code, statusCode = 400) {
  return Object.assign(new Error(code), { code, apiCode: code, statusCode });
}
function externalBotString(value, max = 128, empty = false) {
  return typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u001f\u007f]/.test(value);
}
function externalBotEnvReference(value) {
  return value === '' || (typeof value === 'string' && /^RUYI_BOT_[A-Z0-9_]{1,100}$/.test(value));
}
function externalBotIdentity(value) { return typeof value === 'string' && /^[\x21-\x7e]{1,128}$/.test(value); }
function externalBotNormalizeConnection(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !EXTERNAL_BOT_CONNECTION_KEYS.includes(key))) throw externalBotError('external_channel.connection_invalid');
  if (!['qq', 'feishu'].includes(raw.platform) || !externalBotIdentity(raw.appId)) throw externalBotError('external_channel.connection_invalid');
  if (raw.tenantId !== undefined && typeof raw.tenantId !== 'string') throw externalBotError('external_channel.connection_invalid');
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw externalBotError('external_channel.connection_invalid');
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw externalBotError('external_channel.connection_invalid');
  if (raw.progressUpdates !== undefined && typeof raw.progressUpdates !== 'boolean') throw externalBotError('external_channel.connection_invalid');
  const out = { id, platform: raw.platform, label: raw.label ?? '', enabled: raw.enabled === true, appId: raw.appId,
    tenantId: raw.tenantId || (raw.platform === 'qq' ? raw.appId : ''), botUserId: raw.botUserId ?? '',
    allowedSenderIds: raw.allowedSenderIds ?? [], allowedConversationIds: raw.allowedConversationIds ?? [],
    verificationTokenEnv: raw.verificationTokenEnv ?? '', encryptKeyEnv: raw.encryptKeyEnv ?? '', botSecretEnv: raw.botSecretEnv ?? '',
    appSecretEnv: raw.appSecretEnv ?? '', mode: raw.mode ?? 'inbox', ownerSenderId: raw.ownerSenderId ?? '',
    ownerConversationId: raw.ownerConversationId ?? '', ownerConversationType: raw.ownerConversationType ?? 'direct' };
  if (!externalBotString(out.label, 120, true) || !externalBotString(out.tenantId, 128, true) || !externalBotString(out.botUserId, 128, true)) throw externalBotError('external_channel.connection_invalid');
  if ((out.tenantId && !externalBotIdentity(out.tenantId)) || (out.botUserId && !externalBotIdentity(out.botUserId))) throw externalBotError('external_channel.connection_invalid');
  for (const key of ['allowedSenderIds', 'allowedConversationIds']) {
    if (!Array.isArray(out[key]) || out[key].length > 100 || out[key].some(value => !externalBotIdentity(value))) throw externalBotError('external_channel.connection_invalid');
    out[key] = [...new Set(out[key])];
  }
  for (const key of ['verificationTokenEnv', 'encryptKeyEnv', 'botSecretEnv', 'appSecretEnv']) if (!externalBotEnvReference(out[key])) throw externalBotError('external_channel.env_reference_invalid');
  if ((out.platform === 'qq' && (out.verificationTokenEnv || out.encryptKeyEnv || out.appSecretEnv)) || (out.platform === 'feishu' && out.botSecretEnv)) throw externalBotError('external_channel.connection_invalid');
  if (!['inbox', 'control'].includes(out.mode) || !['direct', 'group'].includes(out.ownerConversationType)
    || (out.ownerSenderId && !externalBotIdentity(out.ownerSenderId)) || (out.ownerConversationId && !externalBotIdentity(out.ownerConversationId))) throw externalBotError('external_channel.connection_invalid');
  if (out.mode === 'control' && (!out.ownerSenderId || !out.ownerConversationId || !['direct', 'group'].includes(raw.ownerConversationType)
    || !out.allowedSenderIds.includes(out.ownerSenderId) || !out.allowedConversationIds.includes(out.ownerConversationId))) throw externalBotError('external_channel.owner_invalid');
  if (raw.progressUpdates === true) out.progressUpdates = true;
  return out;
}
async function externalBotCredentialSnapshot(connection) {
  return ExternalBotCredentials.snapshot(connection);
}
async function externalBotSecrets(connection) { return (await externalBotCredentialSnapshot(connection)).values; }
function externalBotConfigured(connection, secrets) {
  const ingress = connection.platform === 'qq' ? Boolean(connection.appId && secrets.botSecret)
    : Boolean(connection.appId && connection.tenantId && connection.botUserId && secrets.verificationToken && secrets.encryptKey);
  return ingress && (connection.mode !== 'control' || connection.platform === 'qq' || Boolean(secrets.appSecret));
}
async function externalBotPublicConnection(connection) {
  const out = { ...connection, configured: false, callbackPath: '/api/external-bots/callback/' + connection.platform + '?connectionId=' + encodeURIComponent(connection.id) };
  try { out.configured = externalBotConfigured(connection, await externalBotSecrets(connection)); }
  catch (error) { out.credentialError = externalBotSafeCredentialError(error); }
  return out;
}
function externalBotSafeCredentialError(error) {
  return /^external_credentials\.[a-z_]+$/.test(error?.code) ? error.code : 'external_credentials.unavailable';
}
function externalBotConnectionFingerprint(connection) {
  return crypto.createHash('sha256').update(JSON.stringify(connection)).digest('hex');
}
function externalBotSetupReceipt(connectionId, message) {
  const textHash = crypto.createHash('sha256').update(message.text).digest('hex');
  return { connectionId, tenantId: message.tenantId, conversationId: message.conversationId, messageId: message.messageId,
    senderId: message.senderId, conversationType: message.conversationType, textHash,
    sourceKey: JSON.stringify([connectionId, message.tenantId, message.conversationId, message.messageId]),
    contentHash: crypto.createHash('sha256').update(JSON.stringify([message.senderId, message.conversationType, textHash])).digest('hex') };
}
function externalBotValidSetupReceipt(receipt) {
  return receipt && !Array.isArray(receipt) && !Object.keys(receipt).some(key => !['connectionId', 'tenantId', 'conversationId', 'messageId', 'senderId', 'conversationType', 'textHash', 'sourceKey', 'contentHash'].includes(key))
    && ['connectionId', 'tenantId', 'conversationId', 'messageId', 'senderId'].every(key => externalBotIdentity(receipt[key]))
    && ['direct', 'group'].includes(receipt.conversationType) && /^[a-f0-9]{64}$/.test(receipt.textHash)
    && receipt.sourceKey === JSON.stringify([receipt.connectionId, receipt.tenantId, receipt.conversationId, receipt.messageId])
    && receipt.contentHash === crypto.createHash('sha256').update(JSON.stringify([receipt.senderId, receipt.conversationType, receipt.textHash])).digest('hex');
}
async function externalBotCurrentPairing(connection, credentials) {
  const pairing = externalBotPairings.get(connection.id);
  if (!pairing) return null;
  const current = credentials || await externalBotCredentialSnapshot(connection);
  if (connection.enabled || current.credentialError || pairing.expiresAt <= Date.now() || pairing.fingerprint !== externalBotConnectionFingerprint(connection)
    || pairing.credentialRevision !== current.credentialRevision) {
    externalBotPairings.delete(connection.id); return null;
  }
  return pairing;
}
function externalBotSetupToken(connection, credentials, pairing) {
  return crypto.createHash('sha256').update(JSON.stringify([OVERLAY_ID, externalBotConnectionFingerprint(connection),
    credentials.credentialRevision, pairing?.pairingId || null, pairing?.candidate || null])).digest('hex');
}
async function externalBotSetupSnapshot(connection) {
  let credentials;
  try { credentials = await externalBotCredentialSnapshot(connection); }
  catch (error) {
    let inspected;
    try { inspected = await ExternalBotCredentials.inspect(connection); } catch { inspected = { credentialRevision: 'unavailable', fields: {} }; }
    credentials = { ...inspected, values: {}, credentialError: externalBotSafeCredentialError(error) };
  }
  const pairing = await externalBotCurrentPairing(connection, credentials);
  const inbound = connection.platform === 'qq' ? ['botSecret'] : ['verificationToken', 'encryptKey'];
  const required = connection.platform === 'qq' ? inbound : [...inbound, 'appSecret'];
  const missing = required.filter(slot => credentials.fields[slot]?.ready !== true);
  return { ok: true, connection: { ...connection,
    configured: externalBotConfigured(connection, credentials.values),
    callbackPath: '/api/external-bots/callback/' + connection.platform + '?connectionId=' + encodeURIComponent(connection.id) },
    readiness: { ingressReady: !credentials.credentialError && inbound.every(slot => credentials.fields[slot]?.ready === true), replyReady: !credentials.credentialError && missing.length === 0,
      missing, credentialSources: credentials.fields, ...(credentials.credentialError ? { errorCode: credentials.credentialError } : {}) },
    pairing: pairing ? { state: pairing.candidate ? 'candidate' : 'waiting', pairingId: pairing.pairingId,
      ...(pairing.candidate ? {} : { code: pairing.code }), expiresAt: new Date(pairing.expiresAt).toISOString(), candidate: pairing.candidate } : null,
    expectedSetupToken: externalBotSetupToken(connection, credentials, pairing) };
}
async function externalBotSetupOperation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['op', 'connectionId', 'expectedSetupToken', 'controlConfirmed'].includes(key))) throw externalBotError('external_channel.request_invalid');
  const state = await externalBotReadState();
  const connection = state.connections.find(row => row.id === body.connectionId);
  if (!connection) throw externalBotError('external_channel.connection_not_found', 404);
  const credentials = await externalBotCredentialSnapshot(connection);
  const pairing = await externalBotCurrentPairing(connection, credentials);
  if (typeof body.expectedSetupToken !== 'string' || body.expectedSetupToken !== externalBotSetupToken(connection, credentials, pairing)) throw externalBotError('external_channel.setup_conflict', 409);
  if (connection.enabled) throw externalBotError('external_channel.setup_requires_disabled', 409);
  if (body.op === 'pair_cancel') externalBotPairings.delete(connection.id);
  else if (body.op === 'pair_start') {
    if (!externalBotConfigured({ ...connection, mode: 'inbox' }, credentials.values)) throw externalBotError('external_channel.connection_incomplete', 409);
    externalBotPairings.set(connection.id, { pairingId: crypto.randomBytes(16).toString('hex'),
      code: 'RUYI-' + crypto.randomBytes(16).toString('base64url'), expiresAt: Date.now() + 5 * 60 * 1000,
      fingerprint: externalBotConnectionFingerprint(connection), credentialRevision: credentials.credentialRevision, candidate: null });
  } else if (body.op === 'activate') {
    if (body.controlConfirmed !== true) throw externalBotError('external_channel.control_confirmation_required', 409);
    if (!pairing?.candidate) throw externalBotError('external_channel.pairing_required', 409);
    if (!pairing.proof || !(state.setupReceipts || []).some(row => row.sourceKey === pairing.proof.sourceKey && row.contentHash === pairing.proof.contentHash)) throw externalBotError('external_channel.pairing_required', 409);
    if (!externalBotConfigured({ ...connection, mode: 'control' }, credentials.values)) throw externalBotError('external_channel.connection_incomplete', 409);
    const { senderId, conversationId, conversationType } = pairing.candidate;
    const { controlRevision, ...fields } = connection;
    await externalBotUpdateConnection({ op: 'upsert', controlConfirmed: true, connection: { ...fields, enabled: true, mode: 'control',
      ownerSenderId: senderId, ownerConversationId: conversationId, ownerConversationType: conversationType,
      allowedSenderIds: [senderId], allowedConversationIds: [conversationId] } }, pairing.proof);
    externalBotPairings.delete(connection.id);
    const updated = (await externalBotReadState()).connections.find(row => row.id === connection.id);
    return externalBotSetupSnapshot(updated);
  } else throw externalBotError('external_channel.request_invalid');
  return externalBotSetupSnapshot(connection);
}
function externalBotCapturePairing(connection, pairing, message, ack) {
  if (message.tenantId !== connection.tenantId) throw externalBotError('external_channel.source_forbidden', 403);
  // A verified event proves only who sent this exact one-time code. It never grants authority itself.
  if (!pairing.candidate && message.text === pairing.code) {
    pairing.candidate = { senderId: message.senderId, conversationId: message.conversationId, conversationType: message.conversationType, receivedAt: nowIso() };
    pairing.proof = externalBotSetupReceipt(connection.id, message);
  }
  return ack;
}
async function externalBotSaveCredentials(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['connectionId', 'expectedSetupToken', 'credentials'].includes(key))) throw externalBotError('external_channel.request_invalid');
  const state = await externalBotReadState(); const connection = state.connections.find(row => row.id === body.connectionId);
  if (!connection) throw externalBotError('external_channel.connection_not_found', 404);
  const patch = body.credentials;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['set', 'remove', 'replaceAll'].includes(key))) throw externalBotError('external_channel.request_invalid');
  const credentials = patch.replaceAll === true ? { ...await ExternalBotCredentials.inspect(connection), values: {} } : await externalBotCredentialSnapshot(connection);
  const pairing = await externalBotCurrentPairing(connection, credentials);
  if (body.expectedSetupToken !== externalBotSetupToken(connection, credentials, pairing)) throw externalBotError('external_channel.setup_conflict', 409);
  if (connection.enabled) throw externalBotError('external_channel.setup_requires_disabled', 409);
  await ExternalBotCredentials.save(connection, { ...patch, expectedRevision: credentials.credentialRevision });
  externalBotPairings.delete(connection.id);
  return externalBotSetupSnapshot(connection);
}
async function externalBotStewardSetup(args, ctx) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !EXTERNAL_BOT_SETUP_KEYS.includes(key))) return { ok: false, error: 'invalid_request' };
  if (!['inspect', 'prepare'].includes(args.op)) return { ok: false, error: 'invalid_request' };
  if (args.op === 'prepare' && ctx?.trigger !== 'user') return { ok: false, error: 'steward.forbidden', reason: 'local_user_required' };
  return runKeyedChain(externalBotChains, 'state', async () => {
    const state = await externalBotReadState();
    if (args.op === 'inspect') {
      const selected = state.connections.filter(row => !args.connectionId || row.id === args.connectionId);
      const connections = [];
      for (const connection of selected) {
        const snapshot = await externalBotSetupSnapshot(connection);
        connections.push({ connection: snapshot.connection, readiness: snapshot.readiness,
          localConfiguration: connection.enabled ? 'enabled' : 'disabled', pairingCandidate: snapshot.pairing?.state === 'candidate', controlBound: connection.enabled && connection.mode === 'control' && Boolean(connection.ownerSenderId && connection.ownerConversationId),
          evidence: { scope: 'retained_bodies', receivedMessages: state.items.filter(item => item.connectionId === connection.id).length,
            confirmedReplies: state.items.filter(item => item.connectionId === connection.id && item.delivery?.status === 'sent').length } });
      }
      return { ok: true, connections, requiredIdentity: { qq: ['appId'], feishu: ['appId', 'tenantId', 'botUserId'] },
        guidance: { appId: '应用管理后台的应用 ID', tenantId: '飞书应用所属租户 tenant_key', botUserId: '飞书机器人 open_id，不能用 user_id 或 union_id',
          evidence: 'receivedMessages/confirmedReplies 仅统计此连接当前保留的正文记录，不是累计历史；回收后计数减少或归零，不表示从未受理或撤销已确认的平台回复。受理、执行和发送事实仍分开；回收后的最小回执保留既有事实，不能按连接反推出完整历史总数',
          discovery: '飞书缺 tenant key 或机器人 open_id 时，请用户在本机「外部机器人」面板用「用应用信息自动发现」：填入应用 ID 与应用密钥，由本机固定官方接口探测。不要向用户索要密钥，也不要推测这两个标识',
          secrets: '密钥仅在本机机器人配置面板填写，不要发进聊天；已保存不代表公网回调或平台回复已经验证' } };
    }
    if (!['qq', 'feishu'].includes(args.platform)) return { ok: false, error: 'invalid_request', missing: ['platform'] };
    const required = args.platform === 'qq' ? ['appId'] : ['appId', 'tenantId', 'botUserId'];
    const missing = required.filter(key => !externalBotIdentity(args[key]));
    if (missing.length) return { ok: false, error: 'invalid_request', missing, guidance: '从应用后台获取这些标识；飞书 botUserId 必须为机器人 open_id，不能猜测。' };
    const identity = row => row.platform === args.platform && row.appId === args.appId && row.tenantId === (args.tenantId || args.appId) && row.botUserId === (args.botUserId || '');
    const existing = args.connectionId ? state.connections.find(row => row.id === args.connectionId) : state.connections.find(identity);
    if (existing && (!identity(existing) || existing.enabled || existing.mode !== 'inbox' || existing.ownerSenderId || existing.ownerConversationId)) return { ok: false, error: 'external_channel.setup_existing_conflict' };
    if (args.connectionId && !existing) return { ok: false, error: 'external_channel.connection_not_found' };
    if (existing) return { ok: true, prepared: true, reused: true, connectionId: existing.id, disabled: true };
    const id = 'bot_' + crypto.randomBytes(16).toString('hex');
    await externalBotUpdateConnection({ op: 'upsert', connection: { id, platform: args.platform, appId: args.appId,
      tenantId: args.tenantId, botUserId: args.botUserId, label: args.label || '', enabled: false, mode: 'inbox' } });
    return { ok: true, prepared: true, reused: false, connectionId: id, disabled: true };
  });
}
function externalBotDiscoveryFailure(errorCode) {
  const status = { 'external_discovery.invalid_input': 400, 'external_discovery.credentials_rejected': 400,
    'external_discovery.unsupported_platform': 400, 'external_discovery.credentials_missing': 409,
    'external_discovery.identity_missing': 409, 'external_discovery.rate_limited': 429, 'external_discovery.busy': 429 }[errorCode];
  return externalBotError(errorCode, status || 502);
}
// One probe in flight; the secret is passed through and then only the discovered identity is returned.
async function externalBotDiscoveryProbe(appId, appSecret) {
  const at = Date.now();
  if (at - externalBotDiscoveryRate.at >= 60000) externalBotDiscoveryRate = { at, count: 0 };
  if (externalBotDiscoveryBusy) throw externalBotError('external_discovery.busy', 429);
  if (externalBotDiscoveryRate.count >= EXTERNAL_BOT_DISCOVERY_LIMITS.perMinute) throw externalBotError('external_discovery.rate_limited', 429);
  externalBotDiscoveryBusy = true; externalBotDiscoveryRate.count += 1;
  let result;
  try { result = await ExternalBotDiscovery.probe({ appId, appSecret }); }
  finally { externalBotDiscoveryBusy = false; }
  if (!result.ok) throw externalBotDiscoveryFailure(result.errorCode);
  return result.identity;
}
async function externalBotDiscoverOperation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.op !== 'string') throw externalBotError('external_channel.request_invalid');
  if (body.op === 'verify') {
    if (Object.keys(body).some(key => !['op', 'connectionId'].includes(key)) || typeof body.connectionId !== 'string') throw externalBotError('external_channel.request_invalid');
    // Reading the stored secret is bounded to this call; verification never writes state or credentials.
    const target = await runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState();
      const connection = state.connections.find(row => row.id === body.connectionId);
      if (!connection) throw externalBotError('external_channel.connection_not_found', 404);
      if (connection.platform !== 'feishu') throw externalBotError('external_discovery.unsupported_platform', 400);
      const credentials = await externalBotCredentialSnapshot(connection);
      if (!credentials.values.appSecret) throw externalBotError('external_discovery.credentials_missing', 409);
      return { connectionId: connection.id, appId: connection.appId, tenantId: connection.tenantId, botUserId: connection.botUserId, appSecret: credentials.values.appSecret };
    });
    const discovered = await externalBotDiscoveryProbe(target.appId, target.appSecret);
    return { ok: true, connectionId: target.connectionId, discovery: discovered,
      matches: { tenantId: discovered.tenantId === target.tenantId, botUserId: discovered.botUserId === target.botUserId } };
  }
  if (body.op !== 'probe' || Object.keys(body).some(key => !['op', 'appId', 'appSecret', 'label', 'create'].includes(key))
    || typeof body.appId !== 'string' || typeof body.appSecret !== 'string'
    || (body.label !== undefined && typeof body.label !== 'string') || (body.create !== undefined && typeof body.create !== 'boolean')) throw externalBotError('external_channel.request_invalid');
  const label = body.label || '';
  if (!externalBotString(label, 120, true)) throw externalBotError('external_channel.request_invalid');
  const create = body.create === true;
  // Other platforms have no DPAPI vault: probing is still allowed, persisting a secret is not.
  if (create && process.platform !== 'win32') throw externalBotError('external_credentials.unsupported', 501);
  const appId = body.appId.trim();
  const discovery = await externalBotDiscoveryProbe(appId, body.appSecret);
  if (!create) return { ok: true, created: 'none', connectionId: '', discovery };
  // The probe already finished; only the identity existence check and the secret write share the state chain.
  return runKeyedChain(externalBotChains, 'state', async () => {
    const state = await externalBotReadState();
    const identity = row => row.platform === 'feishu' && row.appId === appId && row.tenantId === discovery.tenantId && row.botUserId === discovery.botUserId;
    const existing = state.connections.find(identity);
    // A live control connection is left untouched; discovery never rewrites an enabled or owner-bound entry.
    if (existing && existing.enabled) return { ok: true, created: 'existing', connectionId: existing.id, discovery };
    let connection = existing && !existing.ownerSenderId && !existing.ownerConversationId ? existing : null;
    let created = 'reused';
    if (!connection) {
      const id = 'bot_' + crypto.randomBytes(16).toString('hex');
      await externalBotUpdateConnection({ op: 'upsert', connection: { id, platform: 'feishu', appId,
        tenantId: discovery.tenantId, botUserId: discovery.botUserId, label, enabled: false, mode: 'inbox' } });
      connection = (await externalBotReadState()).connections.find(row => row.id === id);
      created = 'created';
    }
    // The secret is stored only after the immutable identity exists; an environment reference stays authoritative.
    const credentials = await externalBotCredentialSnapshot(connection);
    if (credentials.fields.appSecret?.source !== 'env') {
      await ExternalBotCredentials.save(connection, { set: { appSecret: body.appSecret }, remove: [], expectedRevision: credentials.credentialRevision });
      externalBotPairings.delete(connection.id);
    }
    const snapshot = await externalBotSetupSnapshot(connection);
    return { ok: true, created, connectionId: connection.id, discovery, connection: snapshot.connection, readiness: snapshot.readiness };
  });
}
// Payload6 is required for progress intents and QQ sequence reservations. The
// M3 queue envelope/AAD remain schema1; an old payload1-5 reader must refuse6.
function externalBotUpgradeFeedbackState(state) {
  if (state.schema === 1) for (const row of state.items) row.archivedAt = '';
  if (state.schema < 4) for (const row of state.items) row.replyHistory = [];
  if (state.schema < 5) { state.retentionReceipts = []; state.retentionRequests = []; }
  state.schema = 6;
}
function externalBotFeedback(item, message, progress = false, queryId = '', language = 'zh') {
  const sent = Date.parse(message.sentAt || item.receivedAt), received = Date.parse(item.receivedAt);
  return { sentAt: new Date(Math.min(Number.isFinite(sent) ? sent : received, received)).toISOString(), language, queryId,
    finalSeq: progress ? 2 : 1, reservations: [], cooldownUntil: '',
    progress: progress ? { text: language === 'en' ? 'Your request was accepted and is starting. Use /status to check its progress. This is not a completion receipt.'
      : '已接受指令，正在开始处理。可发送“进度”查询；这条提示不代表任务已完成。',
      delivery: { status: 'pending', attemptId: makeId('progress'), messageId: '', errorCode: '', updatedAt: nowIso() } } : null };
}
function externalBotValidFeedback(item) {
  const f = item.feedback;
  if (f === undefined) return true;
  if (!item.control && item.kind !== 'control' || !f || typeof f !== 'object' || Array.isArray(f)
    || Object.keys(f).sort().join(',') !== 'cooldownUntil,finalSeq,language,progress,queryId,reservations,sentAt'
    || !['zh', 'en'].includes(f.language) || ![1, 2].includes(f.finalSeq) || typeof f.queryId !== 'string'
    || f.queryId.length > 128 || ![f.sentAt, f.cooldownUntil].every((v, i) => typeof v === 'string' && (!v && i === 1 || Number.isFinite(Date.parse(v))))
    || !Array.isArray(f.reservations) || f.reservations.length > 130
    || !f.reservations.every(r => r && Object.keys(r).sort().join(',') === 'at,attemptId'
      && typeof r.attemptId === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(r.attemptId) && typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)))
    || new Set(f.reservations.map(r => r.attemptId)).size !== f.reservations.length) return false;
  if (f.progress === null) return f.finalSeq === 1;
  return f.finalSeq === 2 && f.queryId === '' && f.progress && Object.keys(f.progress).sort().join(',') === 'delivery,text'
    && typeof f.progress.text === 'string' && f.progress.text.length > 0 && f.progress.text.length <= 500
    && f.progress.delivery && Object.keys(f.progress.delivery).sort().join(',') === 'attemptId,errorCode,messageId,status,updatedAt'
    && ['pending', 'sending', 'sent', 'failed', 'unknown'].includes(f.progress.delivery.status)
    && typeof f.progress.delivery.attemptId === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(f.progress.delivery.attemptId)
    && externalBotString(f.progress.delivery.messageId, 128, true) && externalBotString(f.progress.delivery.errorCode, 128, true)
    && typeof f.progress.delivery.updatedAt === 'string' && Number.isFinite(Date.parse(f.progress.delivery.updatedAt))
    && (f.progress.delivery.status !== 'sent' || Boolean(f.progress.delivery.messageId));
}
function externalBotStatusCommand(text) {
  const match = /^(\/status|status|进度|查询进度)(?:\s+([A-Za-z0-9_-]{1,128}))?$/i.exec(text.trim());
  return match ? { targetId: match[2] || '', language: /[\u4e00-\u9fff]/.test(match[1]) ? 'zh' : 'en' }
    : /^(\/status|status|进度|查询进度)(?:\s|$)/i.test(text.trim()) ? { targetId: '!invalid', language: /[\u4e00-\u9fff]/.test(text) ? 'zh' : 'en' } : null;
}
function externalBotStatusText(target, language) {
  if (!target) return language === 'en' ? 'No matching request in this authorized conversation. Use /status followed by a request number, or check Ruyi locally.'
    : '此授权聊天中没有匹配的指令。可发送“进度 指令编号”，或在如意本地查看。';
  const en = language === 'en', execution = target.execution.status, sending = target.delivery?.status || 'not_queued';
  const labels = en ? { queued: 'waiting to start', running: 'processing', completed: 'processing finished', failed: 'processing failed', unknown: 'unconfirmed; check existing work before issuing the instruction again', pending: 'saved locally, awaiting sending', sending: 'sending; receipt not confirmed', sent: 'platform acknowledged sending', cancelled: 'sending cancelled', not_queued: 'reply not ready' }
    : { queued: '等待开始', running: '处理中', completed: '处理已结束', failed: '处理未完成', unknown: '结果未确认，请核对现有任务，不要重复下达指令', pending: '已保存在本地，等待发送', sending: '发送中，尚未确认回执', sent: '平台已确认发送', cancelled: '已取消发送', not_queued: '答复尚未就绪' };
  const waiting = externalBotFeedbackWaiting(target, 'delivery');
  const reply = sending === 'failed' ? en ? 'not sent' : '未发送' : labels[sending];
  return en ? `Request ${target.id}\nAccepted: yes\nExecution: ${labels[execution]}\nReply: ${reply}${waiting === 'window_closed' ? '\nThe passive reply window closed. View the saved result in Ruyi.' : ''}`
    : `指令 ${target.id}\n接受：已接受\n执行：${labels[execution]}\n答复：${reply}${waiting === 'window_closed' ? '\n原消息回复窗口已关闭，请在如意查看本地结果。' : ''}`;
}
function externalBotFeedbackWaiting(item, slot) {
  if (!item.feedback) return '';
  const delivery = slot === 'progress' ? item.feedback.progress?.delivery : item.delivery;
  if (delivery?.status !== 'pending') return '';
  // QQ's 2026-10-28 endpoint field says5min; the overview says60min for
  // direct replies. Use their supported intersection, never active/recall APIs.
  if (item.platform === 'qq' && Date.now() >= Date.parse(item.feedback.sentAt) + 300000) return 'window_closed';
  return Date.now() < Date.parse(item.feedback.cooldownUntil) ? 'throttled' : 'ready';
}
function externalBotFeedbackDelay(state, item) {
  const now = Date.now();
  // The durable original control identity survives a disabled/deleted connection.
  // Recreating a connection to the same app cannot reset its sending budget.
  const rows = state.items.filter(row => row.platform === item.platform && row.control?.appId === item.control?.appId);
  const app = rows.flatMap(row => row.feedback?.reservations || []).map(r => Date.parse(r.at)).filter(at => at > now - 60000);
  const room = rows.filter(row => row.conversationId === item.conversationId).flatMap(row => row.feedback?.reservations || []).map(r => Date.parse(r.at)).filter(at => at > now - 60000);
  // Product budgets, NOT a statement of platform quota:12/app/min,6/chat/min,
  // one/chat/sec. Platform429 and an explicit Retry-After remain authoritative.
  return Math.max(now, ...rows.map(row => Date.parse(row.feedback?.cooldownUntil) || 0),
    app.length >= 12 ? Math.min(...app) + 60000 : 0, room.length >= 6 ? Math.min(...room) + 60000 : 0,
    room.length ? Math.max(...room) + 1000 : 0);
}
function externalBotScheduleFeedbackWake(at) {
  if (externalBotFeedbackTimer || externalBotWorkerStopped) return;
  externalBotFeedbackTimer = setTimeout(() => {
    externalBotFeedbackTimer = null;
    if (externalBotWorkerStopped) return;
    // A timer outlives the intake lease which created it. Re-enter only while
    // open, and keep that fresh lease until the original drain actually settles.
    // Closed intake still records the original wake for the host's resume path.
    if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.fresh && WorkDataMaintenanceHooks.accepting()) {
      void WorkDataMaintenanceHooks.fresh('external-worker', () => externalBotWakeWorker())
        .catch(() => { externalBotWorkerError = 'external_channel.storage_unavailable'; externalBotWorkerAgain = true; });
    } else externalBotWakeWorker();
  }, Math.max(1, Math.min(60000, at - Date.now())));
  externalBotFeedbackTimer.unref?.();
}
function externalBotSendingItem(item, slot) {
  return slot === 'progress' ? { ...item, delivery: item.feedback.progress.delivery,
    execution: { ...item.execution, replyText: item.feedback.progress.text } } : item;
}
function externalBotPublicItem(item) {
  const out = {};
  for (const key of ['id', 'connectionId', 'platform', 'connectionLabel', 'tenantId', 'conversationId', 'senderId', 'conversationType', 'text', 'messageId', 'eventId', 'receivedAt', 'readAt', 'control', 'execution', 'delivery']) out[key] = item[key];
  if (item.archivedAt !== undefined) out.archivedAt = item.archivedAt;
  if (item.replyHistory !== undefined) out.replyHistory = item.replyHistory;
  if (item.feedback) out.feedback = { queryId: item.feedback.queryId, progress: item.feedback.progress?.delivery || null,
    progressWaiting: externalBotFeedbackWaiting(item, 'progress'), replyWaiting: externalBotFeedbackWaiting(item, 'delivery') };
  if (externalBotReplyRetryWindow(item)) out.retryAvailable = true;
  if (externalBotCancellationWindow(item)) out.cancelAvailable = true;
  const unsettled = externalBotUnsettled.get(item.id);
  if (unsettled?.slot === 'progress' && out.feedback?.progress?.status === 'sending') out.feedback.progress = { ...out.feedback.progress, status: 'unknown', errorCode: 'external_channel.delivery_unknown', updatedAt: unsettled.at };
  if (unsettled?.kind === 'run' && out.execution?.status === 'running') out.execution = { ...out.execution, status: 'unknown', errorCode: 'external_channel.execution_unknown', finishedAt: unsettled.at };
  if (unsettled?.kind === 'send' && out.delivery?.status === 'sending') out.delivery = { ...out.delivery, status: 'unknown', errorCode: 'external_channel.delivery_unknown', updatedAt: unsettled.at };
  return out;
}
// Payload v2 adds only a logical list marker. All records still consume the same permanent
// dedupe/capacity ledger; archival never changes execution, sending or an attempt identity.
function externalBotDeliveryPage(state, parameters) {
  const allowed = ['limit', 'cursor', 'connectionId', 'archive'];
  if ([...parameters.keys()].some(key => !allowed.includes(key) || parameters.getAll(key).length !== 1)) throw externalBotError('external_channel.request_invalid');
  const rawLimit = parameters.get('limit'), limit = rawLimit === null ? 50 : Number(rawLimit);
  const connectionId = parameters.get('connectionId') ?? '', archive = parameters.get('archive') ?? 'active';
  if (rawLimit !== null && !/^[1-9][0-9]{0,2}$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || connectionId && !/^[a-z][a-z0-9_-]{0,63}$/.test(connectionId) || !['active', 'archived', 'all'].includes(archive)) throw externalBotError('external_channel.request_invalid');
  const accepted = state.items.filter(item => item.control !== null);
  let watermark = accepted.at(-1)?.id || '', before = '';
  const cursor = parameters.get('cursor');
  if (cursor !== null) {
    try {
      if (!/^[A-Za-z0-9_-]{1,2048}$/.test(cursor)) throw new Error('cursor');
      const tuple = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(tuple) || tuple.length !== 5 || tuple[0] !== 1 || tuple[3] !== connectionId || tuple[4] !== archive
        || !externalBotString(tuple[1]) || !externalBotString(tuple[2])
        || Buffer.from(JSON.stringify(tuple)).toString('base64url') !== cursor) throw new Error('cursor');
      [, watermark, before] = tuple;
    } catch { throw externalBotError('external_channel.cursor_invalid'); }
  }
  const end = watermark ? accepted.findIndex(item => item.id === watermark) : -1;
  const start = before ? accepted.findIndex(item => item.id === before) : end + 1;
  if (watermark && end < 0 || before && (start < 0 || start > end)) throw externalBotError('external_channel.cursor_invalid');
  const matches = item => (!connectionId || item.connectionId === connectionId)
    && (archive === 'all' || Boolean(item.archivedAt) === (archive === 'archived'));
  const all = accepted.slice(0, end + 1).filter(matches);
  const remaining = accepted.slice(0, start).reverse().filter(matches), items = remaining.slice(0, limit);
  const nextCursor = remaining.length > items.length
    ? Buffer.from(JSON.stringify([1, watermark, items.at(-1).id, connectionId, archive])).toString('base64url') : '';
  return { ok: true, items: items.map(item => ({ ...externalBotPublicItem(item), archivedAt: item.archivedAt || '',
    acceptance: { status: 'accepted', receivedAt: item.receivedAt } })), total: all.length, nextCursor,
    capacity: EXTERNAL_BOT_LIMITS.items, retained: state.items.length, full: state.items.length >= EXTERNAL_BOT_LIMITS.items };
}
async function externalBotArchiveDelivery(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['id', 'archived'].includes(key))
    || !externalBotString(body.id) || typeof body.archived !== 'boolean') throw externalBotError('external_channel.request_invalid');
  const state = await externalBotReadState(), item = state.items.find(row => row.id === body.id && row.control !== null);
  if (!item) throw externalBotError('external_channel.item_not_found', 404);
  if (Boolean(item.archivedAt) !== body.archived) {
    if (state.schema === 1) { state.schema = 2; for (const row of state.items) row.archivedAt = ''; }
    item.archivedAt = body.archived ? nowIso() : '';
    await externalBotWriteState(state);
  }
  return { ok: true, item: { ...externalBotPublicItem(item), archivedAt: item.archivedAt || '' }, capacity: EXTERNAL_BOT_LIMITS.items,
    retained: state.items.length, full: state.items.length >= EXTERNAL_BOT_LIMITS.items };
}
// A queued/running business turn is not cancelled here. Only its existing reply
// attempt may be retired, before the message request's synchronous commit boundary.
function externalBotCancellationWindow(item) {
  if (!item.control || !['completed', 'failed', 'unknown'].includes(item.execution?.status)
    || externalBotUnsettled.has(item.id)) return false;
  if (item.delivery?.status === 'pending') return true;
  const owner = externalBotDeliveries.get(item.id);
  return item.delivery?.status === 'sending' && owner?.attemptId === item.delivery.attemptId
    && owner.submitted === false && !owner.controller.signal.aborted;
}
async function externalBotCancelDelivery(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'attemptId,id'
    || !externalBotString(body.id) || typeof body.attemptId !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(body.attemptId))
    throw externalBotError('external_channel.request_invalid');
  const state = await externalBotReadState(), item = state.items.find(row => row.id === body.id && row.control !== null);
  if (!item) {
    const receipt = state.retentionReceipts?.find(row => row.id === body.id && row.kind === 'control');
    if (!receipt) throw externalBotError('external_channel.item_not_found', 404);
    if (receipt.delivery.attemptId !== body.attemptId) throw externalBotError('external_channel.delivery_changed', 409);
    if (receipt.delivery.status !== 'cancelled') throw externalBotError('external_channel.delivery_cannot_cancel', 409);
    return { ok: true, item: externalBotPublicRetentionReceipt(receipt), alreadyCancelled: true };
  }
  if (item.delivery?.attemptId !== body.attemptId) throw externalBotError('external_channel.delivery_changed', 409);
  if (item.delivery.status === 'cancelled') return { ok: true, item: externalBotPublicItem(item), alreadyCancelled: true };
  if (!externalBotCancellationWindow(item)) throw externalBotError('external_channel.delivery_cannot_cancel', 409);
  const active = externalBotDeliveries.get(item.id);
  if (state.schema === 1) for (const row of state.items) row.archivedAt = '';
  if (state.schema < 3) state.schema = 3; // Never downgrade a ledger containing durable retry history.
  item.delivery = { ...item.delivery, status: 'cancelled', messageId: '', errorCode: 'external_channel.delivery_cancelled',
    cancelledAt: nowIso(), updatedAt: nowIso() };
  // Refuse this mutation before ACK/abort if its legacy plaintext representation
  // exceeds the existing physical read ceiling, even when sealing is enabled.
  if (Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8') > EXTERNAL_BOT_LIMITS.stateBytes)
    throw externalBotError('external_channel.inbox_full', 503);
  await externalBotWriteState(state); // No cancellation ACK or abort before durable ownership.
  if (active?.attemptId === body.attemptId && active.submitted === false) active.controller.abort();
  return { ok: true, item: externalBotPublicItem(item), alreadyCancelled: false };
}
// Manual reply retry is deliberately narrower than generic failed delivery.
// Only these existing adapter results prove no MESSAGE request was submitted.
// Rate-limit/rejection timing and unknown reconciliation need separate contracts.
const EXTERNAL_BOT_REPLY_RETRY_ERRORS = Object.freeze(['external_delivery.predispatch',
  'external_delivery.token_aborted', 'external_delivery.token_network', 'external_delivery.token_timeout',
  'external_delivery.token_invalid_response', 'external_delivery.token_unavailable',
  'external_delivery.token_rejected', 'external_delivery.token_invalid']);
const EXTERNAL_BOT_REPLY_RETRY_MAX = 128; // Refuse, never prune durable predecessor attempts.
// The future exact local HTTP handler may pass this private object only after
// its existing token + origin checks. Request JSON cannot mint this authority.
const EXTERNAL_BOT_LOCAL_REPLY_RETRY = Object.freeze({});
function externalBotValidReplyHistory(item, schema) {
  if (schema < 4) return item.replyHistory === undefined;
  const rows = item.replyHistory;
  if (!Array.isArray(rows) || rows.length > EXTERNAL_BOT_REPLY_RETRY_MAX) return false;
  if (!rows.length) return true;
  if ((!item.control && item.kind !== 'control') || !item.delivery) return false;
  const attempts = new Set(), requests = new Set();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index], attempt = row?.attempt;
    if (!row || typeof row !== 'object' || Array.isArray(row)
      || Object.keys(row).sort().join(',') !== 'attempt,nextAttemptId,requestedAt,retryRequestId'
      || typeof row.retryRequestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(row.retryRequestId)
      || typeof row.nextAttemptId !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(row.nextAttemptId)
      || typeof row.requestedAt !== 'string' || !row.requestedAt || !Number.isFinite(Date.parse(row.requestedAt))
      || !attempt || Object.keys(attempt).sort().join(',') !== 'attemptId,errorCode,messageId,status,updatedAt'
      || !(item.reclaimedAt ? externalBotValidReceiptDelivery(attempt, item.execution) : externalBotValidControlState({ ...item, delivery: attempt }))
      || attempt.status !== 'failed' || attempt.messageId || !attempt.updatedAt || !Number.isFinite(Date.parse(attempt.updatedAt))
      || !EXTERNAL_BOT_REPLY_RETRY_ERRORS.includes(attempt.errorCode)
      || attempts.has(attempt.attemptId) || requests.has(row.retryRequestId)
      || row.nextAttemptId !== (rows[index + 1]?.attempt?.attemptId || item.delivery.attemptId)) return false;
    attempts.add(attempt.attemptId); requests.add(row.retryRequestId);
  }
  return !attempts.has(item.delivery.attemptId);
}
function externalBotReplyRetryReceipt(item, row) {
  return { itemId: item.id, previousAttemptId: row.attempt.attemptId, attemptId: row.nextAttemptId,
    retryRequestId: row.retryRequestId, requestedAt: row.requestedAt };
}
function externalBotReplyRetryWindow(item) {
  return Boolean(item.control && ['completed', 'failed', 'unknown'].includes(item.execution?.status) && item.delivery?.status === 'failed'
    && EXTERNAL_BOT_REPLY_RETRY_ERRORS.includes(item.delivery.errorCode) && !item.delivery.messageId
    && item.delivery.updatedAt && Number.isFinite(Date.parse(item.delivery.updatedAt))
    && !externalBotUnsettled.has(item.id) && !externalBotDeliveries.has(item.id));
}
async function externalBotRetryReply(body, authority) {
  if (authority !== EXTERNAL_BOT_LOCAL_REPLY_RETRY) throw externalBotError('auth.origin_rejected', 403);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).sort().join(',') !== 'expectedAttemptId,id,retryRequestId' || !externalBotString(body.id)
    || typeof body.expectedAttemptId !== 'string' || !/^[A-Za-z0-9_-]{1,50}$/.test(body.expectedAttemptId)
    || typeof body.retryRequestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.retryRequestId))
    throw externalBotError('external_channel.request_invalid');
  const state = await externalBotReadState(), item = state.items.find(row => row.id === body.id && row.control !== null);
  if (!item) {
    const receipt = state.retentionReceipts?.find(row => row.id === body.id && row.kind === 'control');
    if (!receipt) throw externalBotError('external_channel.item_not_found', 404);
    const recorded = receipt.replyHistory.find(row => row.retryRequestId === body.retryRequestId);
    if (!recorded) throw externalBotError('external_channel.delivery_cannot_retry', 409);
    if (recorded.attempt.attemptId !== body.expectedAttemptId) throw externalBotError('external_channel.delivery_changed', 409);
    return { ok: true, item: externalBotPublicRetentionReceipt(receipt), receipt: externalBotReplyRetryReceipt(receipt, recorded), alreadyRetried: true };
  }
  const recorded = item.replyHistory?.find(row => row.retryRequestId === body.retryRequestId);
  if (recorded) {
    if (recorded.attempt.attemptId !== body.expectedAttemptId) throw externalBotError('external_channel.delivery_changed', 409);
    return { ok: true, item: externalBotPublicItem(item), receipt: externalBotReplyRetryReceipt(item, recorded), alreadyRetried: true };
  }
  if (item.delivery?.attemptId !== body.expectedAttemptId) throw externalBotError('external_channel.delivery_changed', 409);
  if (!externalBotReplyRetryWindow(item))
    throw externalBotError('external_channel.delivery_cannot_retry', 409);
  if ((item.replyHistory?.length || 0) >= EXTERNAL_BOT_REPLY_RETRY_MAX) throw externalBotError('external_channel.delivery_history_full', 409);
  if (!await externalBotOwnerMatches(state.connections.find(row => row.id === item.connectionId), item))
    throw externalBotError('external_channel.control_revoked', 403);
  const attemptId = makeId('reply');
  if (attemptId === item.delivery.attemptId || item.replyHistory?.some(row => row.attempt.attemptId === attemptId))
    throw externalBotError('external_channel.delivery_changed', 409);
  if (state.schema === 1) for (const row of state.items) row.archivedAt = '';
  if (state.schema < 4) for (const row of state.items) row.replyHistory = [];
  if (state.schema < 4) state.schema = 4; // Never downgrade a receipt-bearing ledger.
  const requestedAt = nowIso(), record = { attempt: { ...item.delivery }, nextAttemptId: attemptId, requestedAt, retryRequestId: body.retryRequestId };
  item.replyHistory.push(record);
  item.delivery = { status: 'pending', attemptId, messageId: '', errorCode: '', updatedAt: requestedAt };
  // The legacy OFF reader caps physical pretty JSON, while the generic writer
  // caps compact payload bytes. Preflight this new operation in both modes so
  // history growth never ACKs a ledger that would become unreadable when OFF.
  if (Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8') > EXTERNAL_BOT_LIMITS.stateBytes)
    throw externalBotError('external_channel.inbox_full', 503);
  await externalBotWriteState(state); // No worker wake or successful ACK before durable history + pending.
  return { ok: true, item: externalBotPublicItem(item), receipt: externalBotReplyRetryReceipt(item, record), alreadyRetried: false };
}
// Payload5 separates reclaimable bodies from bounded, permanent idempotency receipts.
// Retention is an explicit minimum age for this manual operation, never an automatic expiry.
const EXTERNAL_BOT_RETENTION = Object.freeze({ days: Object.freeze([7, 30, 90, 365]), batch: 100, receipts: 4096, requests: 4096, previewMs: 10 * 60 * 1000 });
// Only outcomes emitted as definite failure by the current 13x adapter/caller.
// A future or corrupted "failed" label alone is insufficient evidence to reclaim.
const EXTERNAL_BOT_RETENTION_FAILURES = Object.freeze([...EXTERNAL_BOT_REPLY_RETRY_ERRORS,
  'external_delivery.invalid_input', 'external_delivery.invalid_config', 'external_delivery.invalid_message',
  'external_delivery.identity_mismatch', 'external_delivery.text_invalid', 'external_delivery.aborted',
  'external_delivery.rate_limited', 'external_delivery.rejected', 'external_delivery.source_limit', 'external_channel.control_revoked']);
const externalBotRetentionKey = crypto.randomBytes(32); // Preview authority expires on restart.
function externalBotRetentionHash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function externalBotRetentionEligible(item, cutoff) {
  if (externalBotActiveActors.has(item.id) || externalBotUnsettled.has(item.id) || externalBotDeliveries.has(item.id)) return false;
  const dates = [item.receivedAt];
  if (item.feedback?.progress) {
    if (!['sent', 'failed'].includes(item.feedback.progress.delivery.status)) return false;
    if (item.feedback.progress.delivery.status === 'failed' && ![...EXTERNAL_BOT_RETENTION_FAILURES, 'external_delivery.progress_superseded'].includes(item.feedback.progress.delivery.errorCode)) return false;
    dates.push(item.feedback.progress.delivery.updatedAt);
  }
  if (item.control === null) {
    if (!item.readAt || item.execution !== null || item.delivery !== null) return false;
  } else {
    if (!item.archivedAt || !['completed', 'failed'].includes(item.execution?.status)
      || item.execution.contractIncomplete || item.execution.proposals || item.execution.actionFailures
      || !['sent', 'failed', 'cancelled'].includes(item.delivery?.status)
      || item.delivery.status === 'failed' && (item.delivery.messageId || !EXTERNAL_BOT_RETENTION_FAILURES.includes(item.delivery.errorCode))) return false;
    dates.push(item.execution.finishedAt, item.delivery.updatedAt);
    for (const row of item.replyHistory || []) dates.push(row.requestedAt, row.attempt.updatedAt);
  }
  return dates.every(value => typeof value === 'string' && value && Number.isFinite(Date.parse(value)) && Date.parse(value) <= cutoff);
}
function externalBotRetentionFingerprint(item) { return externalBotRetentionHash(JSON.stringify(item)); }
function externalBotValidReceiptDelivery(delivery, execution) {
  const date = value => typeof value === 'string' && value && Number.isFinite(Date.parse(value));
  return delivery && typeof delivery === 'object' && !Array.isArray(delivery)
    && Object.keys(delivery).sort().join(',') === (delivery.status === 'cancelled' ? 'attemptId,cancelledAt,errorCode,messageId,status,updatedAt' : 'attemptId,errorCode,messageId,status,updatedAt')
    && ['sent', 'failed', 'cancelled'].includes(delivery.status)
    && typeof delivery.attemptId === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(delivery.attemptId)
    && externalBotString(delivery.messageId, 128, true) && externalBotString(delivery.errorCode, 128, true) && date(delivery.updatedAt)
    && (delivery.status !== 'sent' || Boolean(delivery.messageId))
    && (delivery.status !== 'failed' || !delivery.messageId && EXTERNAL_BOT_RETENTION_FAILURES.includes(delivery.errorCode))
    && (delivery.status !== 'cancelled' || ['completed', 'failed'].includes(execution?.status) && date(delivery.cancelledAt)
      && !delivery.messageId && delivery.errorCode === 'external_channel.delivery_cancelled');
}
function externalBotValidRetentionReceipt(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)
    || Object.keys(row).filter(key => key !== 'feedback').sort().join(',') !== 'contentHash,delivery,execution,id,kind,receivedAt,reclaimedAt,replyHistory,sourceHash'
    || !externalBotString(row.id) || !['inbox', 'control'].includes(row.kind)
    || !['sourceHash', 'contentHash'].every(key => typeof row[key] === 'string' && /^[a-f0-9]{64}$/.test(row[key]))
    || !['receivedAt', 'reclaimedAt'].every(key => typeof row[key] === 'string' && row[key] && Number.isFinite(Date.parse(row[key]))) || !externalBotValidFeedback(row)) return false;
  if (row.kind === 'inbox') return row.execution === null && row.delivery === null && Array.isArray(row.replyHistory) && row.replyHistory.length === 0;
  const execution = row.execution;
  return execution && Object.keys(execution).sort().join(',') === 'actionFailures,contractIncomplete,errorCode,finishedAt,proposals,status,turnSeq'
    && ['completed', 'failed'].includes(execution.status) && externalBotString(execution.errorCode, 128, true)
    && typeof execution.finishedAt === 'string' && execution.finishedAt && Number.isFinite(Date.parse(execution.finishedAt))
    && Number.isSafeInteger(execution.turnSeq) && execution.turnSeq >= 0 && execution.actionFailures === 0 && execution.proposals === 0 && execution.contractIncomplete === false
    && externalBotValidReceiptDelivery(row.delivery, execution) && externalBotValidReplyHistory(row, 5);
}
function externalBotPublicRetentionReceipt(row) {
  return { id: row.id, reclaimed: true, receivedAt: row.receivedAt, reclaimedAt: row.reclaimedAt,
    acceptance: { status: 'accepted', receivedAt: row.receivedAt }, execution: row.execution, delivery: row.delivery, replyHistory: row.replyHistory };
}
function externalBotRetentionReceipt(item, reclaimedAt) {
  const execution = item.execution && Object.fromEntries(['status', 'finishedAt', 'errorCode', 'turnSeq', 'actionFailures', 'proposals', 'contractIncomplete'].map(key => [key, item.execution[key]]));
  const delivery = item.delivery && Object.fromEntries(['status', 'attemptId', 'messageId', 'errorCode', 'updatedAt', ...(item.delivery.status === 'cancelled' ? ['cancelledAt'] : [])].map(key => [key, item.delivery[key]]));
  return { id: item.id, kind: item.control === null ? 'inbox' : 'control', sourceHash: externalBotRetentionHash(item.sourceKey), contentHash: item.contentHash,
    receivedAt: item.receivedAt, reclaimedAt, execution, delivery, replyHistory: item.replyHistory || [], ...(item.feedback ? { feedback: item.feedback } : {}) };
}
function externalBotValidRetentionState(state) {
  if (state.schema < 5) return state.retentionReceipts === undefined && state.retentionRequests === undefined;
  if (!Array.isArray(state.retentionReceipts) || state.retentionReceipts.length > EXTERNAL_BOT_RETENTION.receipts
    || !state.retentionReceipts.every(externalBotValidRetentionReceipt)
    || !Array.isArray(state.retentionRequests) || state.retentionRequests.length > EXTERNAL_BOT_RETENTION.requests
    || !state.retentionRequests.every(row => row && Object.keys(row).sort().join(',') === 'count,reclaimedAt,requestHash,requestId'
      && typeof row.requestId === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(row.requestId)
      && typeof row.requestHash === 'string' && /^[a-f0-9]{64}$/.test(row.requestHash)
      && Number.isSafeInteger(row.count) && row.count >= 1 && row.count <= EXTERNAL_BOT_RETENTION.batch
      && typeof row.reclaimedAt === 'string' && row.reclaimedAt && Number.isFinite(Date.parse(row.reclaimedAt)))) return false;
  const ids = [...state.items, ...state.retentionReceipts].map(row => row.id);
  const sources = [...state.items.map(row => externalBotRetentionHash(row.sourceKey)), ...state.retentionReceipts.map(row => row.sourceHash)];
  return new Set(ids).size === ids.length && new Set(sources).size === sources.length
    && new Set(state.retentionRequests.map(row => row.requestId)).size === state.retentionRequests.length;
}
async function externalBotRetentionPreview(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'requestId,retainDays'
    || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.requestId) || !EXTERNAL_BOT_RETENTION.days.includes(body.retainDays)) throw externalBotError('external_channel.request_invalid');
  const state = await externalBotReadState(), now = Date.now(), cutoff = now - body.retainDays * 86400000;
  const eligible = state.items.filter(item => externalBotRetentionEligible(item, cutoff));
  const remaining = EXTERNAL_BOT_RETENTION.receipts - (state.retentionReceipts?.length || 0);
  if (eligible.length && (!remaining || (state.retentionRequests?.length || 0) >= EXTERNAL_BOT_RETENTION.requests)) throw externalBotError('external_channel.retention_receipts_full', 409);
  const items = eligible.slice(0, Math.min(EXTERNAL_BOT_RETENTION.batch, remaining));
  const selection = items.map(item => [item.id, externalBotRetentionFingerprint(item)]);
  const payload = { requestId: body.requestId, retainDays: body.retainDays, cutoff, expiresAt: now + EXTERNAL_BOT_RETENTION.previewMs, selection };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', externalBotRetentionKey).update(encoded).digest('hex');
  return { ok: true, requestId: body.requestId, retainDays: body.retainDays, cutoff: new Date(cutoff).toISOString(), expiresAt: new Date(payload.expiresAt).toISOString(),
    previewToken: items.length ? encoded + '.' + signature : '', count: items.length, eligible: eligible.length, retained: state.items.length,
    receipts: state.retentionReceipts?.length || 0, receiptCapacity: EXTERNAL_BOT_RETENTION.receipts,
    items: items.map(item => ({ id: item.id, kind: item.control === null ? 'inbox' : 'control', receivedAt: item.receivedAt })) };
}
async function externalBotRetentionCommit(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'previewToken,requestId'
    || typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(body.requestId)
    || typeof body.previewToken !== 'string' || body.previewToken.length > 24000 || !/^[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(body.previewToken)) throw externalBotError('external_channel.request_invalid');
  const state = await externalBotReadState(), requestHash = externalBotRetentionHash(body.previewToken);
  const recorded = state.retentionRequests?.find(row => row.requestId === body.requestId);
  if (recorded) {
    if (recorded.requestHash !== requestHash) throw externalBotError('external_channel.retention_changed', 409);
    return { ok: true, receipt: recorded, alreadyReclaimed: true, retained: state.items.length };
  }
  const [encoded, supplied] = body.previewToken.split('.'), expected = crypto.createHmac('sha256', externalBotRetentionKey).update(encoded).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw externalBotError('external_channel.retention_preview_expired', 409);
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw externalBotError('external_channel.request_invalid'); }
  const now = Date.now();
  if (payload.requestId !== body.requestId || !EXTERNAL_BOT_RETENTION.days.includes(payload.retainDays)
    || !Number.isSafeInteger(payload.cutoff) || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= now
    || payload.expiresAt > now + EXTERNAL_BOT_RETENTION.previewMs || payload.cutoff > now - payload.retainDays * 86400000)
    throw externalBotError('external_channel.retention_preview_expired', 409);
  if (!Array.isArray(payload.selection) || !payload.selection.length || payload.selection.length > EXTERNAL_BOT_RETENTION.batch
    || new Set(payload.selection.map(row => row[0])).size !== payload.selection.length) throw externalBotError('external_channel.request_invalid');
  const items = payload.selection.map(([id, fingerprint]) => {
    const item = state.items.find(row => row.id === id);
    if (!item || externalBotRetentionFingerprint(item) !== fingerprint || !externalBotRetentionEligible(item, payload.cutoff)) throw externalBotError('external_channel.retention_changed', 409);
    return item;
  });
  if ((state.retentionReceipts?.length || 0) + items.length > EXTERNAL_BOT_RETENTION.receipts
    || (state.retentionRequests?.length || 0) >= EXTERNAL_BOT_RETENTION.requests) throw externalBotError('external_channel.retention_receipts_full', 409);
  const reclaimedAt = nowIso(), receipt = { requestId: body.requestId, requestHash, count: items.length, reclaimedAt };
  if (state.schema === 1) for (const row of state.items) row.archivedAt = '';
  if (state.schema < 4) for (const row of state.items) row.replyHistory = [];
  state.schema = Math.max(state.schema, 5);
  state.retentionReceipts = [...(state.retentionReceipts || []), ...items.map(item => externalBotRetentionReceipt(item, reclaimedAt))];
  state.retentionRequests = [...(state.retentionRequests || []), receipt];
  const selected = new Set(items.map(item => item.id));
  state.items = state.items.filter(item => !selected.has(item.id));
  if (Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8') > EXTERNAL_BOT_LIMITS.stateBytes) throw externalBotError('external_channel.inbox_full', 503);
  await externalBotWriteState(state); // Bodies and receipts share exactly one durable commit before ACK.
  return { ok: true, receipt, alreadyReclaimed: false, retained: state.items.length };
}

function externalBotValidItem(item) {
  return item && typeof item === 'object' && !Array.isArray(item) && externalBotString(item.id) && externalBotString(item.connectionId)
    && ['qq', 'feishu'].includes(item.platform) && externalBotString(item.connectionLabel, 120, true)
    && ['tenantId', 'conversationId', 'senderId', 'messageId', 'eventId'].every(key => externalBotIdentity(item[key]))
    && ['direct', 'group'].includes(item.conversationType) && typeof item.text === 'string' && item.text.trim().length > 0
    && item.text.length <= EXTERNAL_BOT_LIMITS.textChars && Buffer.byteLength(item.text, 'utf8') <= EXTERNAL_BOT_LIMITS.textBytes && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.text)
    && item.sourceKey === JSON.stringify([item.connectionId, item.tenantId, item.conversationId, item.messageId])
    && item.contentHash === crypto.createHash('sha256').update(JSON.stringify([item.senderId, item.conversationType, item.text])).digest('hex')
    && typeof item.receivedAt === 'string' && Number.isFinite(Date.parse(item.receivedAt))
    && typeof item.readAt === 'string' && (!item.readAt || Number.isFinite(Date.parse(item.readAt))) && externalBotValidControlState(item) && externalBotValidFeedback(item);
}
function externalBotValidControlState(item) {
  if (item.control === null) return item.execution === null && item.delivery === null;
  const control = item.control, execution = item.execution, delivery = item.delivery;
  const date = value => typeof value === 'string' && (!value || Number.isFinite(Date.parse(value)));
  if (!control || typeof control !== 'object' || Array.isArray(control) || !Number.isSafeInteger(control.controlRevision) || control.controlRevision < 1
    || !externalBotIdentity(control.appId) || !['connectionId', 'platform', 'tenantId', 'senderId', 'conversationId', 'conversationType'].every(key => control[key] === item[key])) return false;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution) || !['queued', 'running', 'completed', 'failed', 'unknown'].includes(execution.status)
    || !externalBotString(execution.serverInstanceId, 128, true) || !date(execution.startedAt) || !date(execution.finishedAt)
    || !externalBotString(execution.errorCode, 128, true) || typeof execution.replyText !== 'string' || Buffer.byteLength(execution.replyText) > 1048576
    || !Number.isSafeInteger(execution.turnSeq) || execution.turnSeq < 0 || typeof execution.contractIncomplete !== 'boolean'
    || ![execution.actionFailures, execution.proposals].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100)) return false;
  return delivery === null || (delivery && typeof delivery === 'object' && !Array.isArray(delivery)
    && ['pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled'].includes(delivery.status) && typeof delivery.attemptId === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(delivery.attemptId)
    && externalBotString(delivery.messageId, 128, true) && externalBotString(delivery.errorCode, 128, true) && date(delivery.updatedAt)
    && (delivery.status !== 'sent' || Boolean(delivery.messageId))
    && (delivery.status === 'cancelled'
      ? ['completed', 'failed', 'unknown'].includes(execution.status) && date(delivery.cancelledAt) && Boolean(delivery.cancelledAt)
        && !delivery.messageId && delivery.errorCode === 'external_channel.delivery_cancelled'
      : delivery.cancelledAt === undefined));
}
async function externalBotOwnerMatches(connection, item) {
  return Boolean(connection && connection.enabled && connection.mode === 'control' && item.control
    && connection.id === item.connectionId && connection.controlRevision === item.control.controlRevision
    && connection.platform === item.platform && connection.appId === item.control.appId && connection.tenantId === item.tenantId
    && connection.ownerSenderId === item.senderId && connection.ownerConversationId === item.conversationId && connection.ownerConversationType === item.conversationType
    && connection.allowedSenderIds.includes(item.senderId) && connection.allowedConversationIds.includes(item.conversationId) && externalBotConfigured(connection, await externalBotSecrets(connection)));
}
async function externalBotValidateActor(actor) {
  const proof = actor && typeof actor === 'object' ? externalBotActors.get(actor) : null;
  if (!proof || proof.controller.signal.aborted || externalBotWorkerStopped) throw externalBotError('external_channel.control_revoked', 403);
  return runKeyedChain(externalBotChains, 'state', async () => {
    const state = await externalBotReadState(); const item = state.items.find(row => row.id === proof.itemId);
    const connection = state.connections.find(row => row.id === proof.connectionId);
    if (!item || item.execution?.status !== 'running' || item.execution.serverInstanceId !== OVERLAY_ID || proof.controlRevision !== item.control?.controlRevision
      || !(await externalBotOwnerMatches(connection, item))) throw externalBotError('external_channel.control_revoked', 403);
    return { ...item.control, itemId: item.id };
  });
}
function externalBotReplyText(result) {
  let text = externalBotResultUncertain(result) ? '本次处理未完整结束，结果无法确认；请查询现有任务，确认已发生的操作后再决定下一步。不要重复下达同一指令。'
    : result?.error === 'external_channel.control_revoked' ? '远程控制授权已撤销，未开始的操作已停止；此前已开始的任务或操作不会自动回滚。'
      : typeof result?.say === 'string' ? result.say.trim() : '';
  if (!text) text = result?.ok === true ? '本次指令处理已结束，请查询任务确认实际进展。' : '本次处理未完成，请查询现有任务，确认已经发生的操作后再决定下一步。';
  const outcome = externalBotOutcome(result);
  const facts = [];
  if (outcome.contractIncomplete) facts.push('答复未形成完整执行契约，请在如意核对。');
  if (outcome.proposals) facts.push(`有 ${outcome.proposals} 项后续选项，请在如意查看。`);
  if (outcome.actionFailures) facts.push(`有 ${outcome.actionFailures} 项操作失败，请在如意查看详情。`);
  if (facts.length) text = facts.join('\n') + '\n' + text;
  // Keep the complete logical reply for disclosure. Channel clipping belongs after
  // protection; a private match may extend beyond what the platform can display.
  return text;
}
function externalBotBoundReplyText(text) {
  const tail = '\n（答复已截短，完整内容请在如意查看或继续追问。）';
  if (text.length <= 1700 && Buffer.byteLength(text, 'utf8') <= 5500) return text;
  let out = '';
  for (const point of text) { if ((out + point + tail).length > 1700 || Buffer.byteLength(out + point + tail, 'utf8') > 5500) break; out += point; }
  return out + tail;
}
function externalBotResultUncertain(result) {
  return result?.executionUnknown === true || (result?.ok === false && ['steward.turn_failed', 'steward.cancelled'].includes(typeof result.error === 'string' ? result.error : result.error?.code));
}
function externalBotOutcome(result) {
  const count = value => Number.isSafeInteger(value) && value >= 0 ? Math.min(100, value) : 0;
  return {
    actionFailures: Math.min(100, count(result?.toolFailures) + (Array.isArray(result?.actions) ? result.actions : []).filter(row => row?.result?.ok === false && row.result.error !== 'propose_required').length),
    proposals: Math.min(100, count(result?.toolProposals) + (Array.isArray(result?.acts) ? result.acts.length : 0)), contractIncomplete: result?.contractIncomplete === true,
  };
}
async function externalBotRecover() {
  if (externalBotRecoveryDone) return;
  await runKeyedChain(externalBotChains, 'state', async () => {
    const state = await externalBotReadState(); let changed = false;
    for (const item of state.items) {
      if (item.execution?.status === 'running') {
        item.execution = { ...item.execution, status: 'unknown', errorCode: 'external_channel.execution_unknown', finishedAt: nowIso() }; changed = true;
      }
      if (item.delivery?.status === 'sending') {
        item.delivery = { ...item.delivery, status: 'unknown', errorCode: 'external_channel.delivery_unknown', updatedAt: nowIso() }; changed = true;
      }
      if (item.feedback?.progress?.delivery.status === 'sending') {
        item.feedback.progress.delivery = { ...item.feedback.progress.delivery, status: 'unknown', errorCode: 'external_channel.delivery_unknown', updatedAt: nowIso() }; changed = true;
      }
      if (item.feedback?.progress?.delivery.status === 'pending' && !['queued', 'running'].includes(item.execution?.status)) {
        item.feedback.progress.delivery = { ...item.feedback.progress.delivery, status: 'failed', errorCode: 'external_delivery.progress_superseded', updatedAt: nowIso() }; changed = true;
      }
    }
    if (changed) await externalBotWriteState(state);
    externalBotUnsettled.clear();
    externalBotRecoveryDone = true;
  });
}
async function externalBotNextJob(sendOnly = false) {
  return runKeyedChain(externalBotChains, 'state', async () => {
    const state = await externalBotReadState();
    let slot = 'delivery', deferred = false;
    const available = row => {
      if (!row.feedback) return true;
      if (externalBotFeedbackWaiting(row, slot) === 'window_closed') return false;
      const at = externalBotFeedbackDelay(state, row);
      if (at > Date.now()) { if (Date.parse(row.feedback.cooldownUntil) !== at) { row.feedback.cooldownUntil = new Date(at).toISOString(); deferred = true; } externalBotScheduleFeedbackWake(at); return false; }
      return true;
    };
    let item = state.items.find(row => row.delivery?.status === 'pending' && available(row));
    if (!item) { slot = 'progress'; item = state.items.find(row => row.execution?.status === 'running' && row.feedback?.progress?.delivery.status === 'pending' && available(row)); }
    if (!item && !sendOnly) { slot = ''; item = state.items.find(row => row.execution?.status === 'queued'); }
    if (!item) { if (deferred) await externalBotWriteState(state); return null; }
    const connection = state.connections.find(row => row.id === item.connectionId);
    if (slot === 'progress' && !connection?.progressUpdates) {
      item.feedback.progress.delivery = { ...item.feedback.progress.delivery, status: 'failed', errorCode: 'external_channel.control_revoked', updatedAt: nowIso() };
      await externalBotWriteState(state); return { kind: 'skip' };
    }
    if (!(await externalBotOwnerMatches(connection, item))) {
      if (item.execution?.status === 'queued') item.execution = { ...item.execution, status: 'failed', finishedAt: nowIso(), errorCode: 'external_channel.control_revoked', replyText: '' };
      if (item.delivery?.status === 'pending') item.delivery = { ...item.delivery, status: 'failed', updatedAt: nowIso(), errorCode: 'external_channel.control_revoked' };
      if (item.feedback?.progress?.delivery.status === 'pending') item.feedback.progress.delivery = { ...item.feedback.progress.delivery, status: 'failed', updatedAt: nowIso(), errorCode: 'external_channel.control_revoked' };
      await externalBotWriteState(state); return { kind: 'skip' };
    }
    if (slot) {
      const delivery = slot === 'progress' ? item.feedback.progress.delivery : item.delivery;
      if (item.feedback) {
        if (item.feedback.reservations.length >= 130 || item.feedback.reservations.some(row => row.attemptId === delivery.attemptId)) throw externalBotError('external_channel.delivery_history_full', 409);
        item.feedback.reservations.push({ attemptId: delivery.attemptId, at: nowIso() });
      }
      delivery.status = 'sending'; delivery.updatedAt = nowIso();
      try { await externalBotWriteState(state); }
      catch (error) { if (item.feedback) { externalBotUnsettled.set(item.id, { kind: 'send', slot, at: nowIso() }); externalBotRecoveryDone = false; } throw error; }
      const credentials = await externalBotCredentialSnapshot(connection);
      return { kind: 'send', slot, item: JSON.parse(JSON.stringify(externalBotSendingItem(item, slot))), connection: { ...connection, ...credentials.values }, credentialRevision: credentials.credentialRevision,
        connectionFingerprint: externalBotConnectionFingerprint(connection) };
    }
    item.execution = { ...item.execution, status: 'running', serverInstanceId: OVERLAY_ID, startedAt: nowIso() }; await externalBotWriteState(state);
    const actor = Object.freeze({}); const proof = { itemId: item.id, connectionId: item.connectionId, controlRevision: item.control.controlRevision, controller: new AbortController() };
    externalBotActors.set(actor, proof); externalBotActiveActors.set(item.id, proof);
    return { kind: 'run', item: JSON.parse(JSON.stringify(item)), actor };
  });
}
async function externalBotFinishJob(job, result) {
  return runKeyedChain(externalBotChains, 'state', async () => {
    const state = await externalBotReadState(); const item = state.items.find(row => row.id === job.item.id);
    if (!item) throw externalBotError('external_channel.storage_unavailable', 503);
    if (job.kind === 'run') {
      if (item.execution?.status !== 'running' || item.execution.serverInstanceId !== OVERLAY_ID) throw externalBotError('external_channel.execution_unknown', 409);
      item.execution = { ...item.execution, status: externalBotResultUncertain(result) ? 'unknown' : result?.ok === true ? 'completed' : 'failed', finishedAt: nowIso(),
        errorCode: externalBotResultUncertain(result) ? 'external_channel.execution_unknown' : result?.ok === true ? '' : result?.error === 'external_channel.control_revoked' ? result.error : 'external_channel.execution_failed',
        replyText: externalBotReplyText(result), turnSeq: Math.max(0, Number.isSafeInteger(result?.turnSeq) ? result.turnSeq : 0), ...externalBotOutcome(result) };
      item.delivery = { status: 'pending', attemptId: makeId('reply'), messageId: '', errorCode: '', updatedAt: nowIso() };
      if (item.feedback?.progress?.delivery.status === 'pending') item.feedback.progress.delivery = { ...item.feedback.progress.delivery, status: 'failed', errorCode: 'external_delivery.progress_superseded', updatedAt: nowIso() };
      // A completed business turn must not become running/unknown just because its
      // outbox source is too large. Never send a clipped, unscanned private prefix.
      if (Buffer.byteLength(item.execution.replyText) > 1048576 || Buffer.byteLength(JSON.stringify(state)) > EXTERNAL_BOT_LIMITS.stateBytes) {
        item.execution.replyText = '答复过长，外部投递未开始；请在如意查看本次处理结果。';
        item.delivery = { ...item.delivery, status: 'failed', errorCode: 'external_delivery.source_limit' };
      }
    } else {
      if (job.slot === 'progress') {
        const progress = item.feedback?.progress;
        if (!progress || progress.delivery.status !== 'sending' || progress.delivery.attemptId !== job.item.delivery.attemptId) throw externalBotError('external_channel.delivery_unknown', 409);
        const sent = result?.status === 'sent' && externalBotIdentity(result.messageId);
        progress.delivery = { ...progress.delivery, status: sent ? 'sent' : result?.status === 'pending' && result.errorCode === 'external_delivery.reply_window_closed' ? 'pending' : result?.status === 'failed' ? 'failed' : 'unknown',
          messageId: sent ? result.messageId : '', errorCode: sent ? '' : typeof result?.errorCode === 'string' && /^external_(channel|delivery)\.[a-z_]{1,80}$/.test(result.errorCode) ? result.errorCode : 'external_channel.delivery_unknown', updatedAt: nowIso() };
        if (result?.errorCode === 'external_delivery.rate_limited') item.feedback.cooldownUntil = new Date(Date.now() + Math.min(86400000, Math.max(1000, result.retryAfterMs || 60000))).toISOString();
        await externalBotWriteState(state); return;
      }
      // A cancelled precommit attempt has no message request to settle. Keep the
      // durable cancellation and completed business result when its old job exits.
      if (item.delivery?.status === 'cancelled' && item.delivery.attemptId === job.item.delivery.attemptId) return;
      if (item.delivery?.status !== 'sending' || item.delivery.attemptId !== job.item.delivery.attemptId) throw externalBotError('external_channel.delivery_unknown', 409);
      const sent = result?.status === 'sent' && externalBotIdentity(result.messageId);
      item.delivery = { ...item.delivery, status: sent ? 'sent' : result?.status === 'pending' && result.errorCode === 'external_delivery.reply_window_closed' ? 'pending' : result?.status === 'failed' ? 'failed' : 'unknown',
        messageId: sent ? result.messageId : '', errorCode: sent ? '' : (typeof result?.errorCode === 'string' && /^external_(channel|delivery)\.[a-z_]{1,80}$/.test(result.errorCode) ? result.errorCode : 'external_channel.delivery_unknown'), updatedAt: nowIso() };
    }
    if (item.feedback && result?.errorCode === 'external_delivery.rate_limited') item.feedback.cooldownUntil = new Date(Date.now() + Math.min(86400000, Math.max(1000, result.retryAfterMs || 60000))).toISOString();
    await externalBotWriteState(state);
  });
}
function externalBotReplyBinding(connection, item, credentialRevision) {
  const recipient = JSON.stringify([connection.id, connection.platform, connection.appId, connection.botUserId, connection.tenantId,
    item.conversationType, item.conversationId, item.senderId, item.messageId, connection.controlRevision, credentialRevision]);
  const source = [item.id, item.control, item.execution, item.delivery?.attemptId, item.delivery?.status];
  if (item.feedback) source.push(item.feedback);
  const sourceHash = crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex');
  return { recipient, purpose: 'external-bot-reply', sourceHash };
}
async function externalBotPrepareReply(job, controller, dispatch, assertPolicy = PrivacyGateway.disclosurePolicyGuard()) {
  assertPolicy();
  // The adapter continuation creates the request within the existing state chain.
  // Release the chain after request creation, not after the platform response.
  const prepared = await runKeyedChain(externalBotChains, 'state', async () => {
    const check = async () => {
      const state = await externalBotReadState(), saved = state.items.find(row => row.id === job.item.id);
      const item = saved && externalBotSendingItem(saved, job.slot);
      const connection = state.connections.find(row => row.id === job.item.connectionId);
      if (!item || !connection || job.slot === 'progress' && !connection.progressUpdates || item.delivery?.status !== 'sending' || controller.signal.aborted || externalBotWorkerStopped
        || externalBotConnectionFingerprint(connection) !== job.connectionFingerprint || !(await externalBotOwnerMatches(connection, item))) throw externalBotError('external_channel.control_revoked', 403);
      const credentials = await externalBotCredentialSnapshot(connection);
      const binding = externalBotReplyBinding(connection, item, credentials.credentialRevision);
      const expected = externalBotReplyBinding(job.connection, job.item, job.credentialRevision);
      if (JSON.stringify(binding) !== JSON.stringify(expected)) throw externalBotError('external_channel.delivery_changed', 409);
      return { item, connection, credentials, binding };
    };
    assertPolicy();
    const initial = await check();
    const { receipt } = await PrivacyGateway.prepareDisclosure(initial.item.execution.replyText,
      { ...initial.binding, knownSecrets: Object.values(initial.credentials.values).filter(Boolean) });
    // Privacy projection/persistence can await workers or disk. Re-read the current
    // authoritative item, recipient and credential revision after those waits.
    const current = await check();
    const env = ['botSecretEnv', 'verificationTokenEnv', 'encryptKeyEnv', 'appSecretEnv'].filter(key => current.connection[key])
      .map(key => [current.connection[key], process.env[current.connection[key]]]);
    const fullText = await PrivacyGateway.refreshDisclosure(receipt, current.binding);
    const text = externalBotBoundReplyText(fullText);
    return { result: dispatch({ text, assertCurrent: () => {
      if (controller.signal.aborted || externalBotWorkerStopped || env.some(([key, value]) => process.env[key] !== value)) throw externalBotError('external_channel.control_revoked', 403);
      assertPolicy();
      PrivacyGateway.assertDisclosure(receipt, { ...current.binding, value: fullText });
      const owner = externalBotDeliveries.get(job.item.id);
      if (!owner || owner.controller !== controller || owner.attemptId !== job.item.delivery.attemptId || owner.submitted)
        throw externalBotError('external_channel.delivery_changed', 409);
      // No await separates this latch and 13x's fixed official message request.
      owner.submitted = true;
    } }) };
  });
  return prepared.result;
}
async function externalBotSendJob(job) {
  const controller = new AbortController(); let result, entered = false;
  externalBotDeliveries.set(job.item.id, { connectionId: job.item.connectionId, controlRevision: job.item.control.controlRevision, slot: job.slot, attemptId: job.item.delivery.attemptId, submitted: false, controller });
  try {
    const allowed = await runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(), item = state.items.find(row => row.id === job.item.id);
      return item && await externalBotOwnerMatches(state.connections.find(row => row.id === item.connectionId), item);
    });
    result = !allowed || controller.signal.aborted ? { status: 'failed', errorCode: 'external_channel.control_revoked' }
      : await PrivacyGateway.withPolicy(STEWARD_SESSION_ID, () => {
        const assertPolicy = PrivacyGateway.disclosurePolicyGuard(); entered = true;
        return ExternalChannelDelivery.sendReply(job.connection, job.item, job.item.execution.replyText, {
          attemptId: job.item.delivery.attemptId, messageSeq: job.slot === 'progress' ? 1 : job.item.feedback?.finalSeq || 1,
          signal: controller.signal, prepare: dispatch => externalBotPrepareReply(job, controller, dispatch, assertPolicy) });
      });
  } catch { result = entered ? { status: 'unknown', errorCode: 'external_channel.delivery_unknown' } : { status: 'failed', errorCode: 'external_delivery.predispatch' }; }
  finally { externalBotDeliveries.delete(job.item.id); }
  try { await externalBotFinishJob(job, result); }
  catch (error) { externalBotUnsettled.set(job.item.id, { kind: 'send', slot: job.slot, at: nowIso() }); externalBotRecoveryDone = false; throw error; }
}
async function externalBotRunWithFeedback(job) {
  // One original worker and one business owner. During that same owner's wait,
  // pump only its existing outbox (including read-only queries), never another
  // queued business instruction. A wake cannot create a second drain/engine.
  let done = false, result;
  const running = Promise.resolve().then(() => runStewardTurn({ trigger: 'external', externalActor: job.actor, message: job.item.text }))
    .then(value => { result = value; done = true; }, error => { result = error?.code === 'external_channel.control_revoked' ? { ok: false, error: error.code } : { ok: false, executionUnknown: true }; done = true; });
  while (!done && !externalBotWorkerStopped) {
    try {
      const send = await externalBotNextJob(true);
      if (send) { if (send.kind !== 'skip') await externalBotSendJob(send); continue; }
    } catch { externalBotWorkerError = 'external_channel.storage_unavailable'; break; }
    if (done) break;
    if (externalBotWorkerAgain) { externalBotWorkerAgain = false; continue; }
    let notify;
    const wake = new Promise(resolve => { notify = resolve; externalBotWorkerSignal = resolve; });
    await Promise.race([running, wake]);
    if (externalBotWorkerSignal === notify) externalBotWorkerSignal = null;
  }
  await running;
  return result;
}
async function externalBotDrain() {
  if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.accepting && !WorkDataMaintenanceHooks.accepting()) return;
  if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.run && !WorkDataMaintenanceHooks.entered('external-worker')) return WorkDataMaintenanceHooks.run('external-worker', () => externalBotDrain(...arguments));
  if (externalBotWorkerStopped) return;
  if (externalBotWorkerBusy) { externalBotWorkerAgain = true; return; }
  externalBotWorkerBusy = true;
  try {
    await externalBotRecover();
    do {
      externalBotWorkerAgain = false;
      while (!externalBotWorkerStopped && (typeof WorkDataMaintenanceHooks === 'undefined' || !WorkDataMaintenanceHooks.accepting || WorkDataMaintenanceHooks.accepting())) {
        const job = await externalBotNextJob(); if (!job) break; if (job.kind === 'skip') continue;
        let result;
        try {
          if (job.kind === 'run') result = await externalBotRunWithFeedback(job);
          else { await externalBotSendJob(job); continue; }
        } catch (error) { if (job.kind === 'send') throw error; result = error?.code === 'external_channel.control_revoked' ? { ok: false, error: error.code } : { ok: false, executionUnknown: true }; }
        finally { if (job.actor) { externalBotActors.delete(job.actor); externalBotActiveActors.delete(job.item.id); } externalBotDeliveries.delete(job.item.id); }
        try { await externalBotFinishJob(job, result); }
        catch (error) { externalBotUnsettled.set(job.item.id, { kind: job.kind, at: nowIso() }); externalBotRecoveryDone = false; throw error; }
      }
    } while (externalBotWorkerAgain && !externalBotWorkerStopped && (typeof WorkDataMaintenanceHooks === 'undefined' || !WorkDataMaintenanceHooks.accepting || WorkDataMaintenanceHooks.accepting()));
    externalBotWorkerError = '';
  } catch { externalBotWorkerError = 'external_channel.storage_unavailable'; }
  finally { externalBotWorkerBusy = false; }
}
function externalBotWakeWorker() { if (!externalBotWorkerStopped) { externalBotWorkerAgain = true; externalBotWorkerSignal?.(); if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.accepting && !WorkDataMaintenanceHooks.accepting()) return; return externalBotDrain(); } }
function externalBotValidState(state) {
  if (state?.setupReceipts !== undefined && (!Array.isArray(state.setupReceipts) || state.setupReceipts.length > 4096
    || !state.setupReceipts.every(externalBotValidSetupReceipt) || new Set(state.setupReceipts.map(row => row.sourceKey)).size !== state.setupReceipts.length)) return false;
  if (Object.keys(state).some(key => !['schema', 'connections', 'items', 'retiredConnectionIds', 'setupReceipts', 'retentionReceipts', 'retentionRequests'].includes(key)) || ![1, 2, 3, 4, 5, 6].includes(state.schema) || !Array.isArray(state.connections) || state.connections.length > EXTERNAL_BOT_LIMITS.connections
    || !Array.isArray(state.items) || state.items.length > EXTERNAL_BOT_LIMITS.items
    || !Array.isArray(state.retiredConnectionIds) || state.retiredConnectionIds.length > EXTERNAL_BOT_LIMITS.retiredIds
    || state.retiredConnectionIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id))
    || new Set(state.retiredConnectionIds).size !== state.retiredConnectionIds.length) return false;
  try {
    for (const connection of state.connections) {
      const { controlRevision, ...fields } = connection;
      if (!Number.isSafeInteger(controlRevision) || controlRevision < 1 || JSON.stringify(externalBotNormalizeConnection(fields, fields.id)) !== JSON.stringify(fields)) return false;
      // Credentials may now live in the separate encrypted vault. This synchronous schema validates
      // metadata only; every admission still resolves and verifies the current credentials strictly.
      if (connection.enabled && (!connection.allowedSenderIds.length || !connection.allowedConversationIds.length
        || (connection.platform === 'feishu' && (!connection.tenantId || !connection.botUserId)))) return false;
    }
  } catch { return false; }
  return new Set(state.connections.map(row => row.id)).size === state.connections.length && state.items.every(item => externalBotValidItem(item)
      && (state.schema >= 3 || item.delivery?.status !== 'cancelled') && (state.schema >= 6 || item.feedback === undefined) && externalBotValidReplyHistory(item, state.schema)
      && (state.schema === 1 ? item.archivedAt === undefined : typeof item.archivedAt === 'string' && (!item.archivedAt || Number.isFinite(Date.parse(item.archivedAt)))))
    && !state.connections.some(row => state.retiredConnectionIds.includes(row.id))
    && new Set(state.items.map(row => row.id)).size === state.items.length && new Set(state.items.map(row => row.sourceKey)).size === state.items.length
    && externalBotValidRetentionState(state);
}
// This authority/dedupe ledger never caches or quarantines. Only a missing file is an initial state.
// The 40 MiB business cap measures compact JSON; the old plaintext read cap still measures disk bytes.
const externalBotStore = (() => {
  const filePath = () => path.join(paths.data, 'external-bots', 'state-v1.json');
  const initial = () => ({ schema: 1, connections: [], items: [], retiredConnectionIds: [] });
  const parse = (text, sealed) => {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) || !externalBotValidState(value)
      || (sealed && Buffer.byteLength(JSON.stringify(value), 'utf8') > EXTERNAL_BOT_LIMITS.stateBytes)) throw new Error('invalid external bot ledger');
    return value;
  };
  const textStore = onSealed => WorkDataStore.createText({
    file: filePath, purpose: 'queue', schema: 1, scopeId: 'global', recordId: 'external-bots:state-v1',
    chunked: true, maxPlaintextBytes: 256 * 1024 * 1024,
    keys: { snapshot: () => WorkDataStore.acquireSnapshot(WorkDataStore.requireKeys()), unlock: () => WorkDataStore.requireKeys().unlock(), instance: () => WorkDataStore.requireKeys().instance() },
    enabled: async () => (await readConfig()).workDataEncryptionV1 === true,
    writeJson: atomicWriteJson,
    validateSealedText: text => { const value = parse(text, true); if (onSealed) onSealed(value); return true; },
  });
  async function read() {
    const stat = await fsp.stat(filePath()).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (!stat) return initial();
    const oversized = stat.size > EXTERNAL_BOT_LIMITS.stateBytes;
    // Only chunks-v1 can legitimately exceed the old disk cap. Inspect a bounded complete first
    // line; a nested marker in a huge plain business value must not bypass the legacy read limit.
    if (oversized) {
      const handle = await fsp.open(filePath(), 'r');
      try {
        const buffer = Buffer.alloc(16 * 1024 + 1); let used = 0;
        while (used < buffer.length) {
          const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
          if (!bytesRead) break;
          used += bytesRead;
          if (buffer.subarray(0, used).includes(10)) break;
        }
        const end = buffer.subarray(0, used).indexOf(10);
        if (end < 0 || end > 16 * 1024 || JSON.parse(buffer.subarray(0, end).toString('utf8'))?.workData !== 3) throw new Error('oversized plaintext ledger');
      } finally { await handle.close(); }
    }
    let sealedValue;
    let text;
    try { text = await textStore(value => { sealedValue = value; }).read(); }
    catch (error) { if (error.code === 'ENOENT') return initial(); throw error; }
    if (sealedValue !== undefined) return sealedValue;
    if (oversized) throw new Error('oversized plaintext ledger');
    return parse(text, false);
  }
  async function write(value) {
    // Match DurableJsonStore's strict schema check, JSON snapshot and pretty plaintext bytes.
    const snapshot = parse(JSON.stringify(value), true);
    await read(); // Never overwrite a bad legacy ledger, even when sealing is currently disabled.
    await textStore().write(JSON.stringify(snapshot, null, 2));
    return snapshot;
  }
  return Object.freeze({ filePath, read, write });
})();
async function externalBotReadState() {
  try { return await externalBotStore.read(); }
  catch { throw externalBotError('external_channel.storage_unavailable', 503); }
}
async function externalBotWriteState(state) {
  if (state.items.some(item => item.feedback) || state.connections.some(connection => connection.progressUpdates)) externalBotUpgradeFeedbackState(state);
  // Keep payload6 readable after OFF as well as in the chunked sealed store.
  if (state.schema >= 6 && Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8') > EXTERNAL_BOT_LIMITS.stateBytes) throw externalBotError('external_channel.inbox_full', 503);
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > EXTERNAL_BOT_LIMITS.stateBytes) throw externalBotError('external_channel.inbox_full', 503);
  try { await externalBotStore.write(state); }
  catch { throw externalBotError('external_channel.storage_unavailable', 503); }
}
async function externalBotReadBody(req) {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > EXTERNAL_BOT_LIMITS.bodyBytes) throw externalBotError('external_channel.body_too_large', 413);
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => { clearTimeout(timer); req.removeListener('data', onData); req.removeListener('end', onEnd); req.removeListener('error', onError); req.removeListener('aborted', onAbort); };
    const fail = error => { cleanup(); req.once('error', () => {}); req.pause(); reject(error); };
    const onData = chunk => { bytes += chunk.length; if (bytes > EXTERNAL_BOT_LIMITS.bodyBytes) fail(externalBotError('external_channel.body_too_large', 413)); else chunks.push(chunk); };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = () => fail(externalBotError('external_channel.body_invalid'));
    const onAbort = () => fail(externalBotError('external_channel.body_invalid'));
    const timer = setTimeout(() => fail(externalBotError('external_channel.read_timeout', 408)), EXTERNAL_BOT_LIMITS.readTimeoutMs);
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError); req.once('aborted', onAbort);
  });
}
function externalBotDecodeJson(raw) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object required');
    return value;
  } catch { throw externalBotError('external_channel.body_invalid'); }
}
async function externalBotUpdateConnection(body, setupReceipt) {
  const state = await externalBotReadState();
  if (body.op === 'upsert') {
    const id = body.connection?.id;
    if (typeof id !== 'string' || !id) throw externalBotError('external_channel.connection_invalid');
    const connection = externalBotNormalizeConnection(body.connection, id);
    if (connection.enabled && (!externalBotConfigured(connection, await externalBotSecrets(connection)) || !connection.allowedSenderIds.length || !connection.allowedConversationIds.length)) throw externalBotError('external_channel.connection_incomplete');
    const index = state.connections.findIndex(row => row.id === id);
    const previous = index >= 0 ? state.connections[index] : null;
    if (connection.mode === 'control' && (!previous || previous.mode !== 'control' || (!previous.enabled && connection.enabled)
      || ['ownerSenderId', 'ownerConversationId', 'ownerConversationType'].some(key => previous[key] !== connection[key])) && body.controlConfirmed !== true) throw externalBotError('external_channel.control_confirmation_required', 409);
    if (state.retiredConnectionIds.includes(id)) throw externalBotError('external_channel.connection_retired', 409);
    if (index >= 0 && ['platform', 'appId', 'tenantId', 'botUserId'].some(key => state.connections[index][key] !== connection[key])) throw externalBotError('external_channel.identity_immutable', 409);
    if (index < 0 && state.retiredConnectionIds.length >= EXTERNAL_BOT_LIMITS.retiredIds) throw externalBotError('external_channel.retired_ids_full', 409);
    if (index < 0 && state.connections.length >= EXTERNAL_BOT_LIMITS.connections) throw externalBotError('external_channel.connections_full', 409);
    const authorityKeys = ['enabled', 'mode', 'ownerSenderId', 'ownerConversationId', 'ownerConversationType', 'allowedSenderIds', 'allowedConversationIds', 'verificationTokenEnv', 'encryptKeyEnv', 'botSecretEnv', 'appSecretEnv'];
    const changed = !previous || authorityKeys.some(key => JSON.stringify(previous[key]) !== JSON.stringify(connection[key]));
    connection.controlRevision = previous ? previous.controlRevision + (changed ? 1 : 0) : 1;
    if (!Number.isSafeInteger(connection.controlRevision)) throw externalBotError('external_channel.request_invalid');
    if (index < 0) state.connections.push(connection); else state.connections[index] = connection;
  } else if (['disable', 'delete'].includes(body.op) && typeof body.id === 'string') {
    const index = state.connections.findIndex(row => row.id === body.id);
    if (index < 0) throw externalBotError('external_channel.connection_not_found', 404);
    if (body.op === 'disable') { if (state.connections[index].enabled) state.connections[index].controlRevision += 1; state.connections[index].enabled = false; }
    else {
      if (state.retiredConnectionIds.length >= EXTERNAL_BOT_LIMITS.retiredIds) throw externalBotError('external_channel.retired_ids_full', 409);
      state.retiredConnectionIds.push(body.id);
      state.connections.splice(index, 1); // Inbox and retired identity evidence remain permanent until a future explicit management policy.
    }
  } else throw externalBotError('external_channel.request_invalid');
  if (setupReceipt) {
    if (!externalBotValidSetupReceipt(setupReceipt) || setupReceipt.connectionId !== body.connection?.id) throw externalBotError('external_channel.pairing_required', 409);
    const receipts = state.setupReceipts || [];
    const existing = receipts.find(row => row.sourceKey === setupReceipt.sourceKey);
    if (existing && existing.contentHash !== setupReceipt.contentHash) throw externalBotError('external_channel.message_conflict', 409);
    if (!existing) {
      if (receipts.length >= 4096) throw externalBotError('external_channel.setup_receipts_full', 409);
      state.setupReceipts = receipts.concat(setupReceipt);
    }
  }
  await externalBotWriteState(state);
  externalBotPairings.delete(body.id || body.connection?.id);
  // Cancellation affects only the outbound request still in flight; tasks already started are not
  // rolled back. Token-phase aborts can prevent a message POST, while post-phase ambiguity stays unknown.
  for (const delivery of externalBotDeliveries.values()) {
    const current = state.connections.find(row => row.id === delivery.connectionId);
    if (!current || !current.enabled || current.controlRevision !== delivery.controlRevision || delivery.slot === 'progress' && !current.progressUpdates) delivery.controller.abort();
  }
  for (const actor of externalBotActiveActors.values()) {
    const current = state.connections.find(row => row.id === actor.connectionId);
    if (!current || !current.enabled || current.controlRevision !== actor.controlRevision) actor.controller.abort();
  }
  return { ok: true, connections: await Promise.all(state.connections.map(externalBotPublicConnection)) };
}
async function externalBotAcceptCallback(platform, connectionId, headers, rawBody) {
  const state = await externalBotReadState();
  const connection = state.connections.find(row => row.id === connectionId && row.platform === platform);
  const credentials = connection && (connection.enabled || externalBotPairings.has(connection.id)) ? await externalBotCredentialSnapshot(connection) : null;
  const pairing = connection ? await externalBotCurrentPairing(connection, credentials) : null;
  if (!connection || (!connection.enabled && !pairing)) throw externalBotError('external_channel.connection_unavailable', 404);
  const secrets = credentials.values;
  if (!externalBotConfigured({ ...connection, mode: 'inbox' }, secrets)) throw externalBotError('external_channel.connection_unavailable', 503);
  externalBotDecodeJson(rawBody); // Fatal UTF-8 and root-shape checks do not alter the exact bytes the protocol verifies.
  let verified;
  try { verified = ExternalChannelProtocols.verifyAndNormalize(platform, { ...connection, ...secrets }, headers, rawBody); }
  catch (error) { throw externalBotError(String(error?.code || 'external_channel.protocol_invalid'), [400, 401, 403, 413].includes(error?.statusCode) ? error.statusCode : 400); }
  if (verified?.kind === 'challenge') return verified.body;
  const ack = platform === 'qq' ? { op: 12 } : {};
  if (verified?.kind === 'ignored') return ack;
  if (verified?.kind !== 'message') throw externalBotError('external_channel.protocol_invalid');
  const message = verified.message;
  if (!message || !['tenantId', 'conversationId', 'senderId', 'messageId', 'eventId'].every(key => externalBotIdentity(message[key]))
    || !['direct', 'group'].includes(message.conversationType) || typeof message.text !== 'string' || !message.text.trim()
    || message.text.length > EXTERNAL_BOT_LIMITS.textChars || Buffer.byteLength(message.text, 'utf8') > EXTERNAL_BOT_LIMITS.textBytes
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message.text)) throw externalBotError('external_channel.message_invalid');
  const setupReceipt = externalBotSetupReceipt(connection.id, message);
  const priorSetup = (state.setupReceipts || []).find(row => row.sourceKey === setupReceipt.sourceKey);
  if (priorSetup) {
    if (priorSetup.contentHash !== setupReceipt.contentHash) throw externalBotError('external_channel.message_conflict', 409);
    if (pairing) return externalBotCapturePairing(connection, pairing, message, ack);
    return ack;
  }
  const reclaimed = state.retentionReceipts?.find(row => row.sourceHash === externalBotRetentionHash(setupReceipt.sourceKey));
  if (reclaimed) {
    // Re-pairing must not repurpose an already accepted message identity or bypass its conflict check.
    const contentHash = crypto.createHash('sha256').update(JSON.stringify([message.senderId, message.conversationType, message.text])).digest('hex');
    if (reclaimed.contentHash !== contentHash) throw externalBotError('external_channel.message_conflict', 409);
    return ack;
  }
  if (pairing) {
    if ((state.setupReceipts || []).length >= 4096) throw externalBotError('external_channel.setup_receipts_full', 409);
    if (message.tenantId !== connection.tenantId) throw externalBotError('external_channel.source_forbidden', 403);
    // Every verified message ACKed as setup-only stays setup-only after activation, cancellation
    // and process restarts. Persist before fixing the in-memory candidate or acknowledging receipt.
    state.setupReceipts = (state.setupReceipts || []).concat(setupReceipt);
    await externalBotWriteState(state);
    return externalBotCapturePairing(connection, pairing, message, ack);
  }
  if (!connection.enabled) throw externalBotError('external_channel.connection_unavailable', 404);
  if (message.tenantId !== connection.tenantId || !connection.allowedSenderIds.includes(message.senderId) || !connection.allowedConversationIds.includes(message.conversationId)) throw externalBotError('external_channel.source_forbidden', 403);
  const sourceKey = JSON.stringify([connection.id, message.tenantId, message.conversationId, message.messageId]);
  const contentHash = crypto.createHash('sha256').update(JSON.stringify([message.senderId, message.conversationType, message.text])).digest('hex');
  const existing = state.items.find(item => item.sourceKey === sourceKey);
  if (existing) {
    if (existing.contentHash !== contentHash) throw externalBotError('external_channel.message_conflict', 409);
    return ack;
  }
  if (state.items.length >= EXTERNAL_BOT_LIMITS.items) throw externalBotError('external_channel.inbox_full', 503);
  const control = connection.mode === 'control' && connection.ownerSenderId === message.senderId && connection.ownerConversationId === message.conversationId && connection.ownerConversationType === message.conversationType
    ? { connectionId: connection.id, controlRevision: connection.controlRevision, platform, appId: connection.appId, tenantId: message.tenantId, senderId: message.senderId, conversationId: message.conversationId, conversationType: message.conversationType } : null;
  const item = { id: makeId('botmsg'), connectionId: connection.id, platform, connectionLabel: connection.label,
    tenantId: message.tenantId, conversationId: message.conversationId, senderId: message.senderId,
    conversationType: message.conversationType, text: message.text, messageId: message.messageId, eventId: message.eventId,
    receivedAt: nowIso(), readAt: '', sourceKey, contentHash, control, ...(state.schema >= 2 ? { archivedAt: '' } : {}), ...(state.schema >= 4 ? { replyHistory: [] } : {}),
    execution: control ? { status: 'queued', serverInstanceId: '', startedAt: '', finishedAt: '', errorCode: '', replyText: '', turnSeq: 0, actionFailures: 0, proposals: 0, contractIncomplete: false } : null, delivery: null };
  const query = control && externalBotStatusCommand(message.text);
  if (control && (connection.progressUpdates || query)) {
    let target = null;
    if (query) target = state.items.slice().reverse().find(row => row.control && !row.feedback?.queryId
      && row.connectionId === item.connectionId && row.platform === item.platform && row.tenantId === item.tenantId
      && row.senderId === item.senderId && row.conversationId === item.conversationId && row.conversationType === item.conversationType
      && row.control.controlRevision === control.controlRevision && (!query.targetId || row.id === query.targetId));
    item.feedback = externalBotFeedback(item, message, !query && connection.progressUpdates === true, query ? target?.id || 'not_found' : '', query?.language || 'zh');
    if (query) {
      // The same owner projection used locally includes uncommitted run/send outcomes.
      // Keep the original identity/window facts while describing authoritative uncertainty.
      const projected = target && externalBotPublicItem(target);
      const statusTarget = target && { ...target, execution: projected.execution, delivery: projected.delivery };
      item.execution = { ...item.execution, status: 'completed', finishedAt: nowIso(), replyText: externalBotStatusText(statusTarget, query.language) };
      item.delivery = { status: 'pending', attemptId: makeId('reply'), messageId: '', errorCode: '', updatedAt: nowIso() };
    }
  }
  state.items.push(item);
  await externalBotWriteState(state);
  return ack;
}
async function externalBotSetupHttpOperation(req, res, operation) {
  if (new URL(req.url, 'http://localhost').search) throw externalBotError('external_channel.request_invalid');
  const body = externalBotDecodeJson(await externalBotReadBody(req));
  const result = await runKeyedChain(externalBotChains, 'state', () => operation(body));
  externalBotWakeWorker();
  if (!res.destroyed && !res.writableEnded) send(res, json(result));
  return true;
}
async function handleExternalBotApiRoutes(req, res, pathname) {
  const adminPaths = ['/api/external-bots/setup', '/api/external-bots/credentials', '/api/external-bots/discover', '/api/external-bots/connections', '/api/external-bots/inbox', '/api/external-bots/inbox/read', '/api/external-bots/deliveries', '/api/external-bots/deliveries/archive', '/api/external-bots/deliveries/cancel', '/api/external-bots/deliveries/retry'];
  let callbackPlatform = '';
  if (req.method === 'POST' && pathname === '/api/external-bots/callback/qq') callbackPlatform = 'qq';
  if (req.method === 'POST' && pathname === '/api/external-bots/callback/feishu') callbackPlatform = 'feishu';
  if (!adminPaths.includes(pathname) && !['/api/external-bots/retention/preview', '/api/external-bots/retention/commit'].includes(pathname) && !callbackPlatform) return false;
  let admitted = false;
  try {
    const url = new URL(req.url, 'http://localhost');
    if (callbackPlatform) {
      if (typeof WorkDataMaintenanceHooks !== 'undefined' && WorkDataMaintenanceHooks.run && !WorkDataMaintenanceHooks.entered('external-intake')) return await WorkDataMaintenanceHooks.run('external-intake', () => handleExternalBotApiRoutes(req, res, pathname));
      if (req.method !== 'POST') throw externalBotError('external_channel.request_invalid', 405);
      const id = url.searchParams.get('connectionId');
      if ([...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('connectionId').length !== 1 || !id || !/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw externalBotError('external_channel.connection_unavailable', 404);
      const at = Date.now();
      if (at - externalBotRate.at >= 60000) externalBotRate = { at, count: 0 };
      if (externalBotInflight >= EXTERNAL_BOT_LIMITS.inflightCallbacks || externalBotRate.count >= EXTERNAL_BOT_LIMITS.callbacksPerMinute) throw externalBotError('external_channel.rate_limited', 429);
      externalBotInflight += 1; externalBotRate.count += 1; admitted = true;
      const raw = await externalBotReadBody(req);
      const result = await runKeyedChain(externalBotChains, 'state', () => externalBotAcceptCallback(callbackPlatform, id, req.headers, raw));
      externalBotWakeWorker(); // Durable acceptance owns this wakeup even if the peer already lost the ACK.
      if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
    }
    if (!tokenOk(req)) throw externalBotError('auth.token_invalid', 403);
    const archiveMutation = pathname === '/api/external-bots/deliveries/archive' || pathname === '/api/external-bots/deliveries/cancel' || pathname === '/api/external-bots/deliveries/retry';
    const retentionMutation = ['/api/external-bots/retention/preview', '/api/external-bots/retention/commit'].includes(pathname);
    if ((EXTERNAL_BOT_SETUP_PATHS.includes(pathname) || archiveMutation || retentionMutation) && !originOk(req)) throw externalBotError('auth.origin_rejected', 403);
    if (req.method === 'GET' && pathname === '/api/external-bots/setup') {
      if ([...url.searchParams.keys()].some(key => key !== 'connectionId') || url.searchParams.getAll('connectionId').length !== 1) throw externalBotError('external_channel.request_invalid');
      const result = await runKeyedChain(externalBotChains, 'state', async () => {
        const state = await externalBotReadState(); const connection = state.connections.find(row => row.id === url.searchParams.get('connectionId'));
        if (!connection) throw externalBotError('external_channel.connection_not_found', 404);
        return externalBotSetupSnapshot(connection);
      });
      send(res, json(result)); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/setup') return await externalBotSetupHttpOperation(req, res, externalBotSetupOperation);
    if (req.method === 'POST' && pathname === '/api/external-bots/credentials') return await externalBotSetupHttpOperation(req, res, externalBotSaveCredentials);
    if (req.method === 'POST' && pathname === '/api/external-bots/discover') {
      if (url.search) throw externalBotError('external_channel.request_invalid');
      // Discovery owns its own chaining: the probe runs outside the state lock, the optional write inside it.
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await externalBotDiscoverOperation(body);
      if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
    }
    if (req.method === 'GET' && pathname === '/api/external-bots/connections') {
      const state = await runKeyedChain(externalBotChains, 'state', externalBotReadState);
      send(res, json({ ok: true, connections: await Promise.all(state.connections.map(externalBotPublicConnection)) })); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/connections') {
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await runKeyedChain(externalBotChains, 'state', () => externalBotUpdateConnection(body));
      externalBotWakeWorker();
      if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
    }
    if (req.method === 'GET' && pathname === '/api/external-bots/deliveries') {
      const result = await runKeyedChain(externalBotChains, 'state', async () => externalBotDeliveryPage(await externalBotReadState(), url.searchParams));
      send(res, json(result)); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/deliveries/archive') {
      if (url.search) throw externalBotError('external_channel.request_invalid');
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await runKeyedChain(externalBotChains, 'state', () => externalBotArchiveDelivery(body));
      send(res, json(result)); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/deliveries/retry') {
      if (url.search) throw externalBotError('external_channel.request_invalid');
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await runKeyedChain(externalBotChains, 'state', () => externalBotRetryReply(body, EXTERNAL_BOT_LOCAL_REPLY_RETRY));
      // A repeated explicit request may resume its own durable pending reply.
      // Retired, submitted or later attempts never inherit an old receipt's wake.
      if (result.item.delivery?.status === 'pending' && result.item.delivery.attemptId === result.receipt.attemptId) externalBotWakeWorker();
      if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/deliveries/cancel') {
      if (url.search) throw externalBotError('external_channel.request_invalid');
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await runKeyedChain(externalBotChains, 'state', () => externalBotCancelDelivery(body));
      send(res, json(result)); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/retention/preview') {
      if (url.search) throw externalBotError('external_channel.request_invalid');
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await runKeyedChain(externalBotChains, 'state', () => externalBotRetentionPreview(body));
      if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/retention/commit') {
      if (url.search) throw externalBotError('external_channel.request_invalid');
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await runKeyedChain(externalBotChains, 'state', () => externalBotRetentionCommit(body));
      if (!res.destroyed && !res.writableEnded) send(res, json(result)); return true;
    }
    if (req.method === 'GET' && pathname === '/api/external-bots/inbox') {
      const state = await runKeyedChain(externalBotChains, 'state', externalBotReadState);
      const limitRaw = url.searchParams.get('limit'); const limit = limitRaw === null ? 50 : Number(limitRaw);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw externalBotError('external_channel.request_invalid');
      const filter = url.searchParams.get('connectionId'); const before = url.searchParams.get('before');
      const all = state.items.slice().reverse().filter(item => !filter || item.connectionId === filter);
      const start = before ? all.findIndex(item => item.id === before) + 1 : 0;
      if (before && start === 0) throw externalBotError('external_channel.cursor_invalid');
      const items = all.slice(start, start + limit);
      send(res, json({ ok: true, items: items.map(externalBotPublicItem), total: all.length,
        nextBefore: start + limit < all.length ? items.at(-1)?.id || '' : '', capacity: EXTERNAL_BOT_LIMITS.items, full: state.items.length >= EXTERNAL_BOT_LIMITS.items,
        worker: { running: externalBotWorkerBusy, errorCode: externalBotWorkerError } })); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/inbox/read') {
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await runKeyedChain(externalBotChains, 'state', async () => {
        const state = await externalBotReadState(); const item = state.items.find(row => row.id === body.id);
        if (!item) throw externalBotError('external_channel.item_not_found', 404);
        if (!item.readAt) { item.readAt = nowIso(); await externalBotWriteState(state); }
        return { ok: true, item: externalBotPublicItem(item) };
      });
      send(res, json(result)); return true;
    }
    throw externalBotError('external_channel.request_invalid', 405);
  } catch (error) {
    const code = typeof error?.apiCode === 'string' && /^(external_channel\.|external_credentials\.|external_discovery\.|auth\.)[a-z_]+$/.test(error.apiCode) ? error.apiCode : 'external_channel.storage_unavailable';
    res.setHeader('connection', 'close');
    if (!req.complete) res.once('finish', () => req.destroy());
    send(res, apiFailure(code, {}, code, error?.statusCode || 503)); return true;
  } finally {
    if (admitted) externalBotInflight -= 1;
  }
}
Object.assign(ExternalBotHooks, {
  handleApiRoutes: handleExternalBotApiRoutes,
  validateActor: externalBotValidateActor,
  stewardSetup: externalBotStewardSetup,
  actorSignal: actor => externalBotActors.get(actor)?.controller.signal || null,
  start: () => { externalBotWorkerStopped = false; externalBotWakeWorker(); },
  stop: () => { externalBotWorkerStopped = true; externalBotWorkerSignal?.(); externalBotWorkerSignal = null; clearTimeout(externalBotFeedbackTimer); externalBotFeedbackTimer = null; externalBotPairings.clear(); for (const delivery of externalBotDeliveries.values()) delivery.controller.abort(); for (const actor of externalBotActiveActors.values()) actor.controller.abort(); },
});
