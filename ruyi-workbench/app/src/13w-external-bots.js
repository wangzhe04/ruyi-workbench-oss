// External ingress defaults to an independent inbox. Explicit local owner bindings may additionally
// run the existing Steward and deliver one bounded reply; queued/running/sending facts are durable.
const EXTERNAL_BOT_LIMITS = Object.freeze({ connections: 16, retiredIds: 4096, items: 1000, textChars: 8192, textBytes: 32768, bodyBytes: 65536, stateBytes: 40 * 1024 * 1024, readTimeoutMs: 5000, inflightCallbacks: 8, callbacksPerMinute: 120 });
const EXTERNAL_BOT_CONNECTION_KEYS = Object.freeze(['id', 'platform', 'label', 'enabled', 'appId', 'tenantId', 'botUserId', 'allowedSenderIds', 'allowedConversationIds', 'verificationTokenEnv', 'encryptKeyEnv', 'botSecretEnv', 'appSecretEnv', 'mode', 'ownerSenderId', 'ownerConversationId', 'ownerConversationType']);
const externalBotActors = new WeakMap();
const externalBotActiveActors = new Map();
const externalBotUnsettled = new Map();
const externalBotDeliveries = new Map();
const externalBotChains = new Map();
let externalBotInflight = 0;
let externalBotRate = { at: 0, count: 0 };
let externalBotWorkerBusy = false;
let externalBotWorkerAgain = false;
let externalBotWorkerStopped = false;
let externalBotRecoveryDone = false;
let externalBotWorkerError = '';
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
  return out;
}
function externalBotSecrets(connection) {
  const out = {};
  for (const [reference, name] of [['verificationTokenEnv', 'verificationToken'], ['encryptKeyEnv', 'encryptKey'], ['botSecretEnv', 'botSecret'], ['appSecretEnv', 'appSecret']]) {
    const key = connection[reference];
    // Only names explicitly declared on this connection and in this reserved namespace are resolved.
    const value = externalBotEnvReference(key) && key ? process.env[key] : '';
    out[name] = typeof value === 'string' && value.length <= 8192 ? value : '';
  }
  return out;
}
function externalBotConfigured(connection, secrets = externalBotSecrets(connection)) {
  const ingress = connection.platform === 'qq' ? Boolean(connection.appId && secrets.botSecret)
    : Boolean(connection.appId && connection.tenantId && connection.botUserId && secrets.verificationToken && secrets.encryptKey);
  return ingress && (connection.mode !== 'control' || connection.platform === 'qq' || Boolean(secrets.appSecret));
}
function externalBotPublicConnection(connection) {
  return { ...connection, configured: externalBotConfigured(connection), callbackPath: '/api/external-bots/callback/' + connection.platform + '?connectionId=' + encodeURIComponent(connection.id) };
}
function externalBotPublicItem(item) {
  const out = {};
  for (const key of ['id', 'connectionId', 'platform', 'connectionLabel', 'tenantId', 'conversationId', 'senderId', 'conversationType', 'text', 'messageId', 'eventId', 'receivedAt', 'readAt', 'control', 'execution', 'delivery']) out[key] = item[key];
  const unsettled = externalBotUnsettled.get(item.id);
  if (unsettled?.kind === 'run' && out.execution?.status === 'running') out.execution = { ...out.execution, status: 'unknown', errorCode: 'external_channel.execution_unknown', finishedAt: unsettled.at };
  if (unsettled?.kind === 'send' && out.delivery?.status === 'sending') out.delivery = { ...out.delivery, status: 'unknown', errorCode: 'external_channel.delivery_unknown', updatedAt: unsettled.at };
  return out;
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
    && typeof item.readAt === 'string' && (!item.readAt || Number.isFinite(Date.parse(item.readAt))) && externalBotValidControlState(item);
}
function externalBotValidControlState(item) {
  if (item.control === null) return item.execution === null && item.delivery === null;
  const control = item.control, execution = item.execution, delivery = item.delivery;
  const date = value => typeof value === 'string' && (!value || Number.isFinite(Date.parse(value)));
  if (!control || typeof control !== 'object' || Array.isArray(control) || !Number.isSafeInteger(control.controlRevision) || control.controlRevision < 1
    || !externalBotIdentity(control.appId) || !['connectionId', 'platform', 'tenantId', 'senderId', 'conversationId', 'conversationType'].every(key => control[key] === item[key])) return false;
  if (!execution || typeof execution !== 'object' || Array.isArray(execution) || !['queued', 'running', 'completed', 'failed', 'unknown'].includes(execution.status)
    || !externalBotString(execution.serverInstanceId, 128, true) || !date(execution.startedAt) || !date(execution.finishedAt)
    || !externalBotString(execution.errorCode, 128, true) || typeof execution.replyText !== 'string' || execution.replyText.length > 3000
    || !Number.isSafeInteger(execution.turnSeq) || execution.turnSeq < 0 || typeof execution.contractIncomplete !== 'boolean'
    || ![execution.actionFailures, execution.proposals].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 100)) return false;
  return delivery === null || (delivery && typeof delivery === 'object' && !Array.isArray(delivery)
    && ['pending', 'sending', 'sent', 'failed', 'unknown'].includes(delivery.status) && typeof delivery.attemptId === 'string' && /^[a-zA-Z0-9_-]{1,50}$/.test(delivery.attemptId)
    && externalBotString(delivery.messageId, 128, true) && externalBotString(delivery.errorCode, 128, true) && date(delivery.updatedAt)
    && (delivery.status !== 'sent' || Boolean(delivery.messageId)));
}
function externalBotOwnerMatches(connection, item) {
  return Boolean(connection && connection.enabled && connection.mode === 'control' && item.control
    && connection.id === item.connectionId && connection.controlRevision === item.control.controlRevision
    && connection.platform === item.platform && connection.appId === item.control.appId && connection.tenantId === item.tenantId
    && connection.ownerSenderId === item.senderId && connection.ownerConversationId === item.conversationId && connection.ownerConversationType === item.conversationType
    && connection.allowedSenderIds.includes(item.senderId) && connection.allowedConversationIds.includes(item.conversationId) && externalBotConfigured(connection));
}
async function externalBotValidateActor(actor) {
  const proof = actor && typeof actor === 'object' ? externalBotActors.get(actor) : null;
  if (!proof || proof.controller.signal.aborted || externalBotWorkerStopped) throw externalBotError('external_channel.control_revoked', 403);
  return runKeyedChain(externalBotChains, 'state', async () => {
    const state = await externalBotReadState(); const item = state.items.find(row => row.id === proof.itemId);
    const connection = state.connections.find(row => row.id === proof.connectionId);
    if (!item || item.execution?.status !== 'running' || item.execution.serverInstanceId !== OVERLAY_ID || proof.controlRevision !== item.control?.controlRevision
      || !externalBotOwnerMatches(connection, item)) throw externalBotError('external_channel.control_revoked', 403);
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
    }
    if (changed) await externalBotWriteState(state);
    externalBotUnsettled.clear();
    externalBotRecoveryDone = true;
  });
}
async function externalBotNextJob() {
  return runKeyedChain(externalBotChains, 'state', async () => {
    const state = await externalBotReadState();
    const item = state.items.find(row => row.delivery?.status === 'pending') || state.items.find(row => row.execution?.status === 'queued');
    if (!item) return null;
    const connection = state.connections.find(row => row.id === item.connectionId);
    if (!externalBotOwnerMatches(connection, item)) {
      if (item.execution?.status === 'queued') item.execution = { ...item.execution, status: 'failed', finishedAt: nowIso(), errorCode: 'external_channel.control_revoked', replyText: '' };
      if (item.delivery?.status === 'pending') item.delivery = { ...item.delivery, status: 'failed', updatedAt: nowIso(), errorCode: 'external_channel.control_revoked' };
      await externalBotWriteState(state); return { kind: 'skip' };
    }
    if (item.delivery?.status === 'pending') {
      item.delivery = { ...item.delivery, status: 'sending', updatedAt: nowIso() }; await externalBotWriteState(state);
      return { kind: 'send', item: JSON.parse(JSON.stringify(item)), connection: { ...connection, ...externalBotSecrets(connection) } };
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
    } else {
      if (item.delivery?.status !== 'sending' || item.delivery.attemptId !== job.item.delivery.attemptId) throw externalBotError('external_channel.delivery_unknown', 409);
      const sent = result?.status === 'sent' && externalBotIdentity(result.messageId);
      item.delivery = { ...item.delivery, status: sent ? 'sent' : result?.status === 'failed' ? 'failed' : 'unknown',
        messageId: sent ? result.messageId : '', errorCode: sent ? '' : (typeof result?.errorCode === 'string' && /^external_(channel|delivery)\.[a-z_]{1,80}$/.test(result.errorCode) ? result.errorCode : 'external_channel.delivery_unknown'), updatedAt: nowIso() };
    }
    await externalBotWriteState(state);
  });
}
async function externalBotDrain() {
  if (externalBotWorkerStopped) return;
  if (externalBotWorkerBusy) { externalBotWorkerAgain = true; return; }
  externalBotWorkerBusy = true;
  try {
    await externalBotRecover();
    do {
      externalBotWorkerAgain = false;
      while (!externalBotWorkerStopped) {
        const job = await externalBotNextJob(); if (!job) break; if (job.kind === 'skip') continue;
        let result;
        try {
          if (job.kind === 'run') result = await runStewardTurn({ trigger: 'external', externalActor: job.actor, message: job.item.text });
          else {
            const controller = new AbortController();
            externalBotDeliveries.set(job.item.id, { connectionId: job.item.connectionId, controlRevision: job.item.control.controlRevision, controller });
            const allowed = await runKeyedChain(externalBotChains, 'state', async () => {
              const state = await externalBotReadState(); const item = state.items.find(row => row.id === job.item.id);
              return item && externalBotOwnerMatches(state.connections.find(row => row.id === item.connectionId), item);
            });
            result = !allowed || controller.signal.aborted ? { status: 'failed', errorCode: 'external_channel.control_revoked' }
              : await ExternalChannelDelivery.sendReply(job.connection, job.item, job.item.execution.replyText, { attemptId: job.item.delivery.attemptId, signal: controller.signal });
          }
        } catch (error) { result = job.kind === 'run' ? (error?.code === 'external_channel.control_revoked' ? { ok: false, error: error.code } : { ok: false, executionUnknown: true }) : { status: 'unknown', errorCode: 'external_channel.delivery_unknown' }; }
        finally { if (job.actor) { externalBotActors.delete(job.actor); externalBotActiveActors.delete(job.item.id); } externalBotDeliveries.delete(job.item.id); }
        try { await externalBotFinishJob(job, result); }
        catch (error) { externalBotUnsettled.set(job.item.id, { kind: job.kind, at: nowIso() }); externalBotRecoveryDone = false; throw error; }
      }
    } while (externalBotWorkerAgain && !externalBotWorkerStopped);
    externalBotWorkerError = '';
  } catch { externalBotWorkerError = 'external_channel.storage_unavailable'; }
  finally { externalBotWorkerBusy = false; }
}
function externalBotWakeWorker() { if (!externalBotWorkerStopped) void externalBotDrain(); }
function externalBotValidState(state) {
  if (Object.keys(state).some(key => !['schema', 'connections', 'items', 'retiredConnectionIds'].includes(key)) || state.schema !== 1 || !Array.isArray(state.connections) || state.connections.length > EXTERNAL_BOT_LIMITS.connections
    || !Array.isArray(state.items) || state.items.length > EXTERNAL_BOT_LIMITS.items
    || !Array.isArray(state.retiredConnectionIds) || state.retiredConnectionIds.length > EXTERNAL_BOT_LIMITS.retiredIds
    || state.retiredConnectionIds.some(id => typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(id))
    || new Set(state.retiredConnectionIds).size !== state.retiredConnectionIds.length) return false;
  try {
    for (const connection of state.connections) {
      const { controlRevision, ...fields } = connection;
      if (!Number.isSafeInteger(controlRevision) || controlRevision < 1 || JSON.stringify(externalBotNormalizeConnection(fields, fields.id)) !== JSON.stringify(fields)) return false;
      if (connection.enabled && (!connection.allowedSenderIds.length || !connection.allowedConversationIds.length
        || (connection.platform === 'qq' ? !connection.botSecretEnv : !connection.verificationTokenEnv || !connection.encryptKeyEnv || !connection.tenantId || !connection.botUserId)
        || (connection.mode === 'control' && connection.platform === 'feishu' && !connection.appSecretEnv))) return false;
    }
  } catch { return false; }
  return new Set(state.connections.map(row => row.id)).size === state.connections.length && state.items.every(externalBotValidItem)
    && !state.connections.some(row => state.retiredConnectionIds.includes(row.id))
    && new Set(state.items.map(row => row.id)).size === state.items.length && new Set(state.items.map(row => row.sourceKey)).size === state.items.length;
}
const externalBotStore = DurableJsonStore.create({
  id: 'external-bots', file: () => path.join(paths.data, 'external-bots', 'state-v1.json'), schemaVersion: 1,
  defaultValue: () => ({ schema: 1, connections: [], items: [], retiredConnectionIds: [] }), cache: false, quarantine: false, strictRead: true,
  validate: externalBotValidState,
});
async function externalBotReadState() {
  try {
    const stat = await fsp.stat(externalBotStore.filePath()).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (stat && stat.size > EXTERNAL_BOT_LIMITS.stateBytes) throw new Error('oversized state');
    return await externalBotStore.read();
  } catch { throw externalBotError('external_channel.storage_unavailable', 503); }
}
async function externalBotWriteState(state) {
  if (Buffer.byteLength(JSON.stringify(state), 'utf8') > EXTERNAL_BOT_LIMITS.stateBytes) throw externalBotError('external_channel.inbox_full', 503);
  try { await externalBotStore.write(state); }
  catch { externalBotStore.invalidate(); throw externalBotError('external_channel.storage_unavailable', 503); }
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
async function externalBotUpdateConnection(body) {
  const state = await externalBotReadState();
  if (body.op === 'upsert') {
    const id = body.connection?.id;
    if (typeof id !== 'string' || !id) throw externalBotError('external_channel.connection_invalid');
    const connection = externalBotNormalizeConnection(body.connection, id);
    if (connection.enabled && (!externalBotConfigured(connection) || !connection.allowedSenderIds.length || !connection.allowedConversationIds.length)) throw externalBotError('external_channel.connection_incomplete');
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
  await externalBotWriteState(state);
  // Cancellation affects only the outbound request still in flight; tasks already started are not
  // rolled back. Token-phase aborts can prevent a message POST, while post-phase ambiguity stays unknown.
  for (const delivery of externalBotDeliveries.values()) {
    const current = state.connections.find(row => row.id === delivery.connectionId);
    if (!current || !current.enabled || current.controlRevision !== delivery.controlRevision) delivery.controller.abort();
  }
  for (const actor of externalBotActiveActors.values()) {
    const current = state.connections.find(row => row.id === actor.connectionId);
    if (!current || !current.enabled || current.controlRevision !== actor.controlRevision) actor.controller.abort();
  }
  return { ok: true, connections: state.connections.map(externalBotPublicConnection) };
}
async function externalBotAcceptCallback(platform, connectionId, headers, rawBody) {
  const state = await externalBotReadState();
  const connection = state.connections.find(row => row.id === connectionId && row.platform === platform);
  if (!connection || !connection.enabled) throw externalBotError('external_channel.connection_unavailable', 404);
  const secrets = externalBotSecrets(connection);
  if (!externalBotConfigured(connection, secrets)) throw externalBotError('external_channel.connection_unavailable', 503);
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
  state.items.push({ id: makeId('botmsg'), connectionId: connection.id, platform, connectionLabel: connection.label,
    tenantId: message.tenantId, conversationId: message.conversationId, senderId: message.senderId,
    conversationType: message.conversationType, text: message.text, messageId: message.messageId, eventId: message.eventId,
    receivedAt: nowIso(), readAt: '', sourceKey, contentHash, control,
    execution: control ? { status: 'queued', serverInstanceId: '', startedAt: '', finishedAt: '', errorCode: '', replyText: '', turnSeq: 0, actionFailures: 0, proposals: 0, contractIncomplete: false } : null, delivery: null });
  await externalBotWriteState(state);
  return ack;
}
async function handleExternalBotApiRoutes(req, res, pathname) {
  const adminPaths = ['/api/external-bots/connections', '/api/external-bots/inbox', '/api/external-bots/inbox/read'];
  let callbackPlatform = '';
  if (req.method === 'POST' && pathname === '/api/external-bots/callback/qq') callbackPlatform = 'qq';
  if (req.method === 'POST' && pathname === '/api/external-bots/callback/feishu') callbackPlatform = 'feishu';
  if (!adminPaths.includes(pathname) && !callbackPlatform) return false;
  let admitted = false;
  try {
    const url = new URL(req.url, 'http://localhost');
    if (callbackPlatform) {
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
    if (req.method === 'GET' && pathname === '/api/external-bots/connections') {
      const state = await runKeyedChain(externalBotChains, 'state', externalBotReadState);
      send(res, json({ ok: true, connections: state.connections.map(externalBotPublicConnection) })); return true;
    }
    if (req.method === 'POST' && pathname === '/api/external-bots/connections') {
      const body = externalBotDecodeJson(await externalBotReadBody(req));
      const result = await runKeyedChain(externalBotChains, 'state', () => externalBotUpdateConnection(body));
      externalBotWakeWorker();
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
    const code = typeof error?.apiCode === 'string' && /^(external_channel\.|auth\.)[a-z_]+$/.test(error.apiCode) ? error.apiCode : 'external_channel.storage_unavailable';
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
  actorSignal: actor => externalBotActors.get(actor)?.controller.signal || null,
  start: () => { externalBotWorkerStopped = false; externalBotWakeWorker(); },
  stop: () => { externalBotWorkerStopped = true; for (const delivery of externalBotDeliveries.values()) delivery.controller.abort(); for (const actor of externalBotActiveActors.values()) actor.controller.abort(); },
});
