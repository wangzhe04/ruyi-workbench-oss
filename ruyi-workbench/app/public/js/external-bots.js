'use strict';
import { doc, byId, el, clear, button } from './steward-chips.js';
import { apiErrorInfo } from './net.js';
import { EVENT_STREAM_INSTANCE_EVENT } from './event-stream.js';
import { confirmDanger } from './confirm-panel.js';
import { createExternalBotSetup } from './external-bot-setup.js';
import { createReplyRetryState, validReplyRetryHistory } from './external-bot-retry-state.js';

const ENV_NAME = /^RUYI_BOT_[A-Z0-9_]+$/;
const FIELDS = ['id', 'platform', 'label', 'appId', 'tenantId', 'botUserId', 'verificationTokenEnv', 'encryptKeyEnv', 'botSecretEnv', 'mode', 'ownerSenderId', 'ownerConversationId', 'ownerConversationType', 'appSecretEnv'];
const ENV_FIELDS = ['verificationTokenEnv', 'encryptKeyEnv', 'botSecretEnv', 'appSecretEnv'];
const IDS = { id: 'cfgStewardBotId', platform: 'cfgStewardBotPlatform', label: 'cfgStewardBotLabel', appId: 'cfgStewardBotAppId', tenantId: 'cfgStewardBotTenantId',
  botUserId: 'cfgStewardBotUserId', verificationTokenEnv: 'cfgStewardBotVerificationEnv', encryptKeyEnv: 'cfgStewardBotEncryptEnv', botSecretEnv: 'cfgStewardBotSecretEnv',
  mode: 'cfgStewardBotMode', ownerSenderId: 'cfgStewardBotOwnerSender', ownerConversationId: 'cfgStewardBotOwnerConversation', ownerConversationType: 'cfgStewardBotOwnerType', appSecretEnv: 'cfgStewardBotAppSecretEnv' };
const strings = value => Array.isArray(value) && value.every(id => typeof id === 'string' && id.length > 0);
export function validExternalConnection(row) {
  return Boolean(row && typeof row.id === 'string' && row.id && ['feishu', 'qq'].includes(row.platform)
    && typeof row.label === 'string' && typeof row.enabled === 'boolean'
    && strings(row.allowedSenderIds) && strings(row.allowedConversationIds)
    && FIELDS.every(key => row[key] === undefined || typeof row[key] === 'string')
    && ENV_FIELDS.every(key => !row[key] || ENV_NAME.test(row[key]))
    && (row.mode === undefined || ['inbox', 'control'].includes(row.mode)));
}
export function validExternalInboxItem(row) {
  return Boolean(row && ['feishu', 'qq'].includes(row.platform)
    && ['id', 'connectionId', 'conversationId', 'senderId', 'text', 'receivedAt'].every(key => typeof row[key] === 'string' && row[key])
    && ['connectionLabel', 'tenantId', 'conversationType', 'messageId', 'eventId', 'readAt'].every(key => row[key] === undefined || row[key] === null || typeof row[key] === 'string')
    && (!row.execution || (['queued', 'running', 'completed', 'failed', 'unknown', 'cancelled'].includes(row.execution.status)
      && ['errorCode', 'replyText'].every(key => row.execution[key] === undefined || typeof row.execution[key] === 'string')))
    && (!row.delivery || ['pending', 'sending', 'sent', 'failed', 'unknown', 'cancelled'].includes(row.delivery.status)
      && (row.delivery.status !== 'cancelled' || typeof row.delivery.cancelledAt === 'string' && row.delivery.cancelledAt.length <= 64 && Boolean(row.delivery.cancelledAt) && Number.isFinite(Date.parse(row.delivery.cancelledAt)))));
}
export function validExternalDeliveryItem(row) {
  return validExternalInboxItem(row) && validReplyRetryHistory(row)
    && (row.retryAvailable === undefined || typeof row.retryAvailable === 'boolean')
    && (!row.retryAvailable || row.delivery?.status === 'failed') && (row.cancelAvailable === undefined || typeof row.cancelAvailable === 'boolean')
    && (!row.cancelAvailable || ['pending', 'sending'].includes(row.delivery?.status)) && Boolean(row.execution && row.acceptance?.status === 'accepted'
    && row.acceptance.receivedAt === row.receivedAt && Number.isFinite(Date.parse(row.receivedAt))
    && typeof row.archivedAt === 'string' && row.archivedAt.length <= 64 && (!row.archivedAt || Number.isFinite(Date.parse(row.archivedAt)))
    && (!row.delivery || typeof row.delivery.attemptId === 'string' && /^[A-Za-z0-9_-]{1,50}$/.test(row.delivery.attemptId)
      && (row.delivery.errorCode === undefined || typeof row.delivery.errorCode === 'string')));
}
function connectionPayload(row) {
  const value = { enabled: row.enabled === true, allowedSenderIds: [...row.allowedSenderIds], allowedConversationIds: [...row.allowedConversationIds] };
  for (const key of FIELDS) if (row[key]) value[key] = row[key];
  return value;
}
function visiblePanel() {
  const modal = byId('settingsModal'), tab = byId('stab-steward');
  return Boolean(modal && tab && !modal.classList.contains('hidden') && !modal.hidden && tab.classList.contains('active')
    && (!tab.dataset.only || tab.dataset.only === 'externalBots'));
}

export function createExternalBotsPanel({ api, t = key => key, isVisible = visiblePanel } = {}) {
  const replyRetries = createReplyRetryState();
  const setup = createExternalBotSetup({ api, t, isVisible, onChanged: () => { void loadConnections(); } });
  let active = false, generation = 0, bound = false, importer = null;
  let connectionSeq = 0, inboxSeq = 0, filter = '', writeOwner = null, nextBefore = '', total = 0;
  let connections = [], items = [];
  let deliverySeq = 0, deliveryFilter = '', archiveFilter = 'active', deliveryCursor = '', deliveryTotal = 0, retained = 0;
  let deliveries = [];
  let archivePending = null; // A physical write survives closing or reopening this view.
  let deliveryNotice = { key: '', code: '', failed: false };
  const deliveryOpen = () => byId('cfgStewardBotDeliverySection')?.open === true;
  let worker = { running: false, errorCode: '' };
  let discovering = false;
  const DISCOVER = { form: 'cfgStewardBotDiscoverForm', appId: 'cfgStewardBotDiscoverAppId', secret: 'cfgStewardBotDiscoverSecret',
    label: 'cfgStewardBotDiscoverLabel', note: 'cfgStewardBotDiscoverNote', run: 'cfgStewardBotDiscoverRun' };
  const quality = { connections: 'unread', inbox: 'unread', deliveries: 'unread' };
  const errorDetail = { connections: '', inbox: '', deliveries: '' };
  const current = (mine, seq, kind) => active && isVisible() && mine === generation && seq === (kind === 'connections' ? connectionSeq : kind === 'deliveries' ? deliverySeq : inboxSeq)
    && (kind !== 'deliveries' || deliveryOpen());
  const say = (key, tone = '') => {
    const node = byId('cfgStewardExternalBotNote');
    if (node) { node.textContent = t(key); node.dataset.tone = tone; }
  };
  function errorText(error, includeCode = true) {
    const info = apiErrorInfo(error);
    const keys = { 'external_channel.connection_incomplete': 'incomplete', 'external_channel.env_reference_invalid': 'envOnly',
      'external_channel.identity_immutable': 'identityHint', 'external_channel.connection_retired': 'retired',
      'external_channel.connection_invalid': 'invalidConnection', 'external_channel.connection_not_found': 'missingConnection',
      'external_channel.storage_unavailable': 'storageUnavailable', 'external_channel.inbox_full': 'capacityFull',
      'external_channel.connections_full': 'capacityFull', 'external_channel.retired_ids_full': 'capacityFull',
      'external_channel.control_revoked': 'controlRevoked', 'external_channel.owner_invalid': 'ownerRequired',
      'external_channel.control_confirmation_required': 'controlConfirmationRequired', 'external_channel.cursor_invalid': 'deliveryCursorExpired', 'external_channel.delivery_cannot_cancel': 'cancelTooLate', 'external_channel.delivery_changed': 'cancelChanged', 'external_channel.delivery_cancelled': 'delivery.cancelled',
      'external_discovery.credentials_rejected': 'discoverRejected', 'external_discovery.unsupported_platform': 'discoverUnsupportedPlatform',
      'external_discovery.credentials_missing': 'discoverCredentialsMissing', 'external_discovery.identity_missing': 'discoverIdentityMissing',
      'external_discovery.busy': 'discoverBusy', 'external_discovery.invalid_input': 'discoverInvalid',
      'external_credentials.unsupported': 'discoverUnsupported' };
    const code = String(info?.code || '');
    const delivery = code.startsWith('external_delivery.');
    const discovery = code.startsWith('external_discovery.');
    const key = keys[code] || (code.endsWith('.rate_limited') ? (discovery ? 'discoverBusy' : 'rateLimited')
      : discovery ? 'discoverUnavailable'
      : delivery && code.startsWith('external_delivery.token_') ? 'replyAuth'
      : delivery && ['external_delivery.invalid_config', 'external_delivery.identity_mismatch'].includes(code) ? 'replyConfig'
      : delivery && code.endsWith('.rejected') ? 'replyRejected'
      : delivery ? 'delivery.unknown' : 'requestFailed');
    return t('externalBots.' + key) + (includeCode && /^external_(channel|delivery|discovery|credentials)\.[a-z_]{1,80}$/.test(code) ? ' (' + code + ')' : '');
  }
  function deliveryErrorCode(error) {
    const code = String(apiErrorInfo(error)?.code || '');
    return /^external_(channel|delivery|discovery|credentials)\.[a-z_]{1,80}$/.test(code) ? code : '';
  }
  function readStatus(kind) {
    const node = byId(kind === 'connections' ? 'cfgStewardBotConnectionsStatus' : kind === 'deliveries' ? 'cfgStewardBotDeliveryStatus' : 'cfgStewardBotInboxStatus');
    if (!node) return;
    const state = quality[kind];
    const hasCache = kind === 'connections' ? connections.length > 0 : kind === 'deliveries' ? deliveries.length > 0 : items.length > 0;
    node.textContent = ['failed', 'restarting'].includes(state) ? t(hasCache ? 'externalBots.stale' : 'externalBots.unavailable')
      : state === 'loading' ? t('externalBots.loading') : state === 'unread' ? t('externalBots.notLoaded') : '';
    node.dataset.state = state;
    const detail = kind === 'deliveries' ? (state === 'failed' ? errorText({ code: errorDetail.deliveries }, false) : '') : errorDetail[kind];
    node.title = detail;
    if (kind === 'deliveries' && state === 'failed') node.textContent += ' ' + detail;
  }
  function control(label, action, callback) {
    const node = button('btn btn-sm', t(label), callback);
    node.dataset.botAction = action; node.disabled = Boolean(writeOwner);
    return node;
  }
  function renderConnections() {
    const host = byId('cfgStewardBotConnections');
    if (!host) return;
    clear(host); readStatus('connections');
    if (!connections.length && quality.connections === 'ok') host.appendChild(el('li', 'external-bots-empty muted', t('externalBots.noConnections')));
    for (const row of connections) {
      const node = el('li', 'external-bots-row'); node.dataset.connectionId = row.id;
      const copy = el('div', 'external-bots-copy');
      const heading = el('div', 'external-bots-row-title');
      heading.append(el('strong', '', row.label || row.id), el('span', 'external-bots-state', t(row.enabled ? 'externalBots.enabled' : 'externalBots.disabled')));
      copy.append(heading, el('p', 'muted', [t(row.platform === 'qq' ? 'externalBots.qq' : 'externalBots.feishu'), row.appId, row.id].filter(Boolean).join(' · ')));
      if (typeof row.callbackPath === 'string') copy.appendChild(el('code', 'external-bots-callback', row.callbackPath));
      copy.appendChild(el('p', 'muted', t(row.configured ? 'externalBots.configured' : 'externalBots.notConfigured')));
      copy.appendChild(el('p', '', t(row.mode === 'control' ? 'externalBots.controlMode' : 'externalBots.inboxMode')));
      if (row.mode === 'control') copy.appendChild(el('p', 'muted', [row.ownerSenderId, row.ownerConversationId, t(row.ownerConversationType === 'group' ? 'externalBots.group' : 'externalBots.direct')].join(' · ')));
      const actions = el('div', 'external-bots-actions');
      actions.append(control('botSetup.open', 'setup', () => setup.open(row.id)), control('externalBots.edit', 'edit', () => edit(row)),
        control(row.enabled ? 'externalBots.disable' : 'externalBots.enable', 'toggle', () => mutate(row.enabled ? { op: 'disable', id: row.id }
          : { op: 'upsert', connection: { ...connectionPayload(row), enabled: true } })),
        control('externalBots.delete', 'delete', () => removeConnection(row)));
      // Feishu identity can be re-probed with the stored app secret; this never writes configuration.
      if (row.platform === 'feishu') actions.append(control('externalBots.verifyIdentity', 'verify', () => verifyIdentity(row)));
      for (const action of actions.children) action.disabled ||= quality.connections !== 'ok';
      node.append(copy, actions); host.appendChild(node);
    }
    const select = byId('cfgStewardBotInboxConnection');
    if (select) {
      clear(select); const all = el('option', '', t('externalBots.allConnections')); all.value = ''; select.appendChild(all);
      for (const row of connections) { const option = el('option', '', row.label || row.id); option.value = row.id; select.appendChild(option); }
      select.value = filter;
    }
    renderDeliveryFilter();
  }
  function renderInbox() {
    const host = byId('cfgStewardBotInbox');
    if (!host) return;
    clear(host); readStatus('inbox');
    const workerStatus = byId('cfgStewardBotInboxWorkerStatus');
    if (workerStatus) workerStatus.textContent = worker.errorCode ? t('externalBots.workerFailed') + ' ' + errorText({ code: worker.errorCode }) : '';
    const more = byId('cfgStewardBotInboxMore');
    if (more) { more.hidden = !nextBefore; more.disabled = quality.inbox === 'loading'; }
    const count = byId('cfgStewardBotInboxCount');
    if (count) count.textContent = quality.inbox === 'ok' ? t('externalBots.count', { shown: items.length, total }) : '';
    if (!items.length && quality.inbox === 'ok') host.appendChild(el('li', 'external-bots-empty muted', t('externalBots.emptyInbox')));
    for (const item of items) {
      const node = el('li', 'external-bots-message'); node.dataset.inboxId = item.id;
      const details = el('details', '');
      const summary = el('summary', 'external-bots-message-summary');
      summary.append(el('strong', '', item.connectionLabel || item.connectionId), el('span', 'external-bots-state', t(item.readAt ? 'externalBots.read' : 'externalBots.unread')),
        el('span', 'external-bots-preview', item.text.replace(/\s+/g, ' ').slice(0, 120)));
      if (item.execution) summary.appendChild(el('span', 'external-bots-state', t('externalBots.execution.' + item.execution.status)));
      if (item.delivery) summary.appendChild(el('span', 'external-bots-state', t('externalBots.delivery.' + item.delivery.status)));
      const source = el('p', 'external-bots-source muted', [t(item.platform === 'qq' ? 'externalBots.qq' : 'externalBots.feishu'), item.senderId, item.conversationId, item.receivedAt].join(' · '));
      const text = el('pre', 'external-bots-text', item.text);
      const actions = el('div', 'external-bots-actions');
      actions.append(control('externalBots.addDraft', 'draft', () => addDraft(item)),
        control('externalBots.markRead', 'read', () => markRead(item)));
      if (item.readAt) actions.lastChild.disabled = true;
      details.append(summary, source, text);
      if (item.execution) {
        details.appendChild(el('p', 'external-bots-fact', t('externalBots.execution.' + item.execution.status)));
        if (item.execution.errorCode) details.appendChild(el('p', 'muted', errorText({ code: item.execution.errorCode })));
        if (item.execution.replyText) { details.appendChild(el('strong', '', t('externalBots.reply'))); details.appendChild(el('pre', 'external-bots-text', item.execution.replyText)); }
      }
      if (item.delivery) {
        details.appendChild(el('p', 'external-bots-fact', t('externalBots.delivery.' + item.delivery.status)));
        if (item.delivery.errorCode) details.appendChild(el('p', 'muted', errorText({ code: item.delivery.errorCode })));
      }
      details.appendChild(actions); node.appendChild(details); host.appendChild(node);
    }
  }
  function renderDeliveryFilter() {
    const select = byId('cfgStewardBotDeliveryConnection');
    if (!select) return;
    clear(select); const all = el('option', '', t('externalBots.allConnections')); all.value = ''; select.appendChild(all);
    const known = new Map(connections.map(row => [row.id, row.label || row.id]));
    for (const item of deliveries) if (!known.has(item.connectionId)) known.set(item.connectionId, item.connectionLabel || item.connectionId);
    if (deliveryFilter && !known.has(deliveryFilter)) known.set(deliveryFilter, deliveryFilter);
    for (const [id, label] of known) { const option = el('option', '', label); option.value = id; select.appendChild(option); }
    select.value = deliveryFilter;
  }
  function renderDeliveries() {
    const host = byId('cfgStewardBotDeliveries'); if (!host) return;
    clear(host); renderDeliveryFilter(); readStatus('deliveries');
    host.setAttribute('aria-busy', String(quality.deliveries === 'loading'));
    const more = byId('cfgStewardBotDeliveryMore');
    if (more) { more.hidden = !deliveryCursor; more.disabled = quality.deliveries === 'loading' || Boolean(writeOwner); }
    const refresh = byId('cfgStewardBotDeliveryRefresh'); if (refresh) refresh.disabled = quality.deliveries === 'loading' || Boolean(writeOwner);
    const count = byId('cfgStewardBotDeliveryCount');
    if (count) count.textContent = quality.deliveries === 'ok' ? t('externalBots.deliveryCount', { shown: deliveries.length, total: deliveryTotal, retained, capacity: 1000 }) : '';
    const note = byId('cfgStewardBotDeliveryNote');
    if (note) {
      note.textContent = deliveryNotice.key ? t(deliveryNotice.key) + (deliveryNotice.failed ? ' ' + errorText({ code: deliveryNotice.code }, false) : '') : '';
      note.dataset.tone = deliveryNotice.failed ? 'err' : '';
    }
    if (!deliveries.length && quality.deliveries === 'ok') host.appendChild(el('li', 'external-bots-empty muted', t('externalBots.emptyDeliveries')));
    for (const item of deliveries) {
      const node = el('li', 'external-bots-message external-bots-delivery'); node.dataset.deliveryId = item.id;
      const heading = el('div', 'external-bots-row-title');
      heading.append(el('strong', 'external-bots-copy', item.connectionLabel || item.connectionId), el('time', 'external-bots-state', item.receivedAt));
      if (item.archivedAt) heading.appendChild(el('span', 'external-bots-state', t('externalBots.archived')));
      const facts = el('dl', 'external-bots-delivery-facts');
      for (const [label, value] of [['acceptedFact', 'externalBots.accepted'], ['executionFact', 'externalBots.execution.' + item.execution.status],
        ['sendingFact', item.delivery ? 'externalBots.delivery.' + item.delivery.status : 'externalBots.notQueued']]) {
        const fact = el('div', ''); fact.append(el('dt', 'muted', t('externalBots.' + label)), el('dd', '', t(value))); facts.appendChild(fact);
      }
      const details = el('details', ''), summary = el('summary', 'external-bots-message-summary');
      summary.appendChild(el('span', 'external-bots-preview', item.text.replace(/\s+/g, ' ').slice(0, 120)));
      details.append(summary, el('p', 'external-bots-source muted', [item.senderId, item.conversationId, item.messageId].filter(Boolean).join(' · ')), el('pre', 'external-bots-text', item.text));
      if (item.execution.replyText) details.append(el('strong', '', t('externalBots.reply')), el('pre', 'external-bots-text', item.execution.replyText));
      if (item.execution.errorCode) details.appendChild(el('p', 'muted', errorText({ code: item.execution.errorCode })));
      if (item.delivery) {
        details.appendChild(el('p', 'external-bots-source muted', t('externalBots.attempt') + ' · ' + item.delivery.attemptId));
        if (item.delivery.errorCode) details.appendChild(el('p', 'muted', errorText({ code: item.delivery.errorCode })));
      }
      if(item.replyHistory?.length) {
        const history=el('details',''),title=el('summary','',t('externalBots.retryHistory'));
        history.appendChild(title);
        for(const record of item.replyHistory)history.appendChild(el('p','external-bots-source muted',[record.attempt.attemptId,record.attempt.status,record.attempt.errorCode,record.requestedAt,record.nextAttemptId].join(' · ')));
        details.appendChild(history);
      }
      const actions = el('div', 'external-bots-actions');
      const archive = control(item.archivedAt ? 'externalBots.unarchive' : 'externalBots.archive', 'archive', () => archiveDelivery(item, archive));
      archive.disabled ||= quality.deliveries !== 'ok' || Boolean(archivePending); actions.appendChild(archive);
      if (item.cancelAvailable === true) {
        const cancel = control('externalBots.cancelReply', 'cancel', () => cancelDelivery(item, cancel));
        cancel.disabled ||= quality.deliveries !== 'ok' || Boolean(archivePending); actions.appendChild(cancel);
      }
      const choice=replyRetries.available(item);
      if(choice) {
        const retry=control(choice.mode==='new'?'externalBots.retryReply':choice.mode==='waiting'?'externalBots.retryWaiting':'externalBots.retryResume','retry',()=>retryDelivery(item,retry));
        retry.disabled ||= choice.mode==='waiting'||quality.deliveries!=='ok'||Boolean(archivePending);actions.appendChild(retry);
      }
      node.append(heading, facts, details, actions); host.appendChild(node);
    }
  }
  async function loadDeliveries(older = false) {
    if (!active || !isVisible() || !deliveryOpen()) return false;
    older = older === true;
    if (older && (!deliveryCursor || quality.deliveries === 'loading')) return false;
    const cursor = older ? deliveryCursor : '', mine = generation, seq = ++deliverySeq, connectionId = deliveryFilter, archive = archiveFilter;
    quality.deliveries = 'loading'; renderDeliveries();
    try {
      const body = await api('/api/external-bots/deliveries?limit=50&archive=' + archive + (connectionId ? '&connectionId=' + encodeURIComponent(connectionId) : '')
        + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      if (!current(mine, seq, 'deliveries')) return false;
      if (body?.ok !== true || !Array.isArray(body.items) || body.items.length > 50 || !body.items.every(validExternalDeliveryItem)
        || typeof body.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{0,2048}$/.test(body.nextCursor)
        || !Number.isInteger(body.total) || body.total < body.items.length || body.total > 1000
        || !Number.isInteger(body.retained) || body.retained < body.total || body.retained > 1000 || body.capacity !== 1000 || typeof body.full !== 'boolean'
        || body.items.some(item => connectionId && item.connectionId !== connectionId || archive !== 'all' && Boolean(item.archivedAt) !== (archive === 'archived'))) throw new Error('invalid_response');
      const merged = older ? [...new Map([...deliveries, ...body.items].map(item => [item.id, item])).values()] : body.items;
      if (merged.length > 1000) throw new Error('invalid_response');
      deliveries = merged; deliveryCursor = body.nextCursor; deliveryTotal = body.total; retained = body.retained;
      quality.deliveries = 'ok'; errorDetail.deliveries = '';
    } catch (error) {
      if (!current(mine, seq, 'deliveries')) return false;
      quality.deliveries = 'failed'; errorDetail.deliveries = deliveryErrorCode(error);
    }
    renderDeliveries(); return quality.deliveries === 'ok';
  }
  async function archiveDelivery(item, source) {
    if (archivePending || writeOwner || !active || !isVisible() || !deliveryOpen() || quality.deliveries !== 'ok') return false;
    const mine = generation, owner = {}, archived = !item.archivedAt, restoreFocus = doc()?.activeElement === source;
    archivePending = owner; deliverySeq++;
    const settle = (failed, error) => {
      if (archivePending !== owner) return;
      archivePending = null; deliverySeq++;
      if (failed || quality.deliveries !== 'restarting') quality.deliveries = failed ? 'failed' : 'unread';
      errorDetail.deliveries = failed ? deliveryErrorCode(error) : '';
      if (active && isVisible()) renderDeliveries();
    };
    writeOwner = owner; renderConnections(); renderInbox(); renderDeliveries();
    try {
      const body = await api('/api/external-bots/deliveries/archive', { method: 'POST', body: JSON.stringify({ id: item.id, archived }) });
      if (body?.ok !== true || body.item?.id !== item.id || typeof body.item?.archivedAt !== 'string' || body.item.archivedAt.length > 64
        || Boolean(body.item.archivedAt) !== archived || body.item.archivedAt && !Number.isFinite(Date.parse(body.item.archivedAt))) throw new Error('write_unconfirmed');
      settle(false);
      if (mine !== generation || !active || !isVisible() || writeOwner !== owner) return false;
      deliveryNotice = { key: archived ? 'externalBots.archiveSaved' : 'externalBots.unarchiveSaved', code: '', failed: false };
      await loadDeliveries(); return true;
    } catch (error) {
      settle(true, error);
      if (mine === generation && active && isVisible() && writeOwner === owner) {
        deliveryNotice = { key: 'externalBots.archiveFailed', code: deliveryErrorCode(error), failed: true };
      }
      return false;
    } finally {
      if (writeOwner === owner) {
        writeOwner = null;
        if (active && isVisible()) {
          renderConnections(); renderInbox(); renderDeliveries();
          if (restoreFocus && deliveryOpen() && (!doc()?.activeElement || doc().activeElement === doc().body || doc().activeElement === source)) {
            const row = [...(byId('cfgStewardBotDeliveries')?.querySelectorAll?.('[data-delivery-id]') || [])].find(node => node.dataset.deliveryId === item.id);
            const action = row?.querySelector('[data-bot-action="archive"]');
            (action && !action.disabled ? action : byId('cfgStewardBotDeliveryRefresh'))?.focus();
          }
        }
      }
    }
  }
  async function cancelDelivery(item, source) {
    if (item.cancelAvailable !== true || !item.delivery?.attemptId || archivePending || writeOwner || !active || !isVisible() || !deliveryOpen() || quality.deliveries !== 'ok') return false;
    const mine = generation, owner = {}, attemptId = item.delivery.attemptId, restoreFocus = doc()?.activeElement === source;
    archivePending = owner; deliverySeq++;
    const settle = (failed, error) => {
      if (archivePending !== owner) return;
      archivePending = null; deliverySeq++;
      if (failed || quality.deliveries !== 'restarting') quality.deliveries = failed ? 'failed' : 'unread';
      errorDetail.deliveries = failed ? deliveryErrorCode(error) : '';
      if (active && isVisible()) renderDeliveries();
    };
    writeOwner = owner; renderConnections(); renderInbox(); renderDeliveries();
    try {
      const body = await api('/api/external-bots/deliveries/cancel', { method: 'POST', body: JSON.stringify({ id: item.id, attemptId }) });
      if (body?.ok !== true || !validExternalInboxItem(body.item) || body.item.id !== item.id
        || body.item.delivery?.attemptId !== attemptId || body.item.delivery.status !== 'cancelled') throw new Error('write_unconfirmed');
      settle(false);
      if (mine !== generation || !active || !isVisible() || writeOwner !== owner) return false;
      deliveryNotice = { key: 'externalBots.cancelSaved', code: '', failed: false };
      await loadDeliveries(); return true;
    } catch (error) {
      settle(true, error);
      if (mine === generation && active && isVisible() && writeOwner === owner) {
        deliveryNotice = { key: 'externalBots.cancelFailed', code: deliveryErrorCode(error), failed: true };
      }
      return false;
    } finally {
      if (writeOwner === owner) {
        writeOwner = null;
        if (active && isVisible()) {
          renderConnections(); renderInbox(); renderDeliveries();
          if (restoreFocus && deliveryOpen() && (!doc()?.activeElement || doc().activeElement === doc().body || doc().activeElement === source)) {
            const row = [...(byId('cfgStewardBotDeliveries')?.querySelectorAll?.('[data-delivery-id]') || [])].find(node => node.dataset.deliveryId === item.id);
            const action = row?.querySelector('[data-bot-action="cancel"]');
            (action && !action.disabled ? action : byId('cfgStewardBotDeliveryRefresh'))?.focus();
          }
        }
      }
    }
  }
  async function retryDelivery(item, source) {
    if (archivePending || writeOwner || !active || !isVisible() || !deliveryOpen() || quality.deliveries !== 'ok') return false;
    let record;
    try { record = replyRetries.begin(item); } catch { deliveryNotice={key:'externalBots.retryUnknown',code:'',failed:true};renderDeliveries();return false; }
    if (!record) return false;
    const mine=generation,owner={},restoreFocus=doc()?.activeElement===source;
    archivePending=owner;deliverySeq++;writeOwner=owner;renderConnections();renderInbox();renderDeliveries();
    const settle=(failed,error)=>{
      if(archivePending!==owner)return;
      archivePending=null;deliverySeq++;
      if(failed||quality.deliveries!=='restarting')quality.deliveries=failed?'failed':'unread';
      errorDetail.deliveries=failed?deliveryErrorCode(error):'';
      if(active&&isVisible())renderDeliveries();
    };
    try {
      const body=await api('/api/external-bots/deliveries/retry',{method:'POST',body:JSON.stringify(record.body)});
      if(!validExternalInboxItem(body?.item))throw new Error('write_unconfirmed');
      replyRetries.confirm(record,body);settle(false);
      if(mine!==generation||!active||!isVisible()||writeOwner!==owner)return false;
      deliveryNotice={key:'externalBots.retrySaved',code:'',failed:false};await loadDeliveries();return true;
    } catch(error) {
      const code=deliveryErrorCode(error),rejected=['external_channel.delivery_changed','external_channel.delivery_cannot_retry','external_channel.control_revoked','external_channel.delivery_history_full','external_channel.inbox_full'].includes(code);
      if(rejected)replyRetries.rejected(record);else replyRetries.uncertain(record);settle(true,error);
      if(mine===generation&&active&&isVisible()&&writeOwner===owner)deliveryNotice={key:rejected?'externalBots.retryRejected':'externalBots.retryUnknown',code,failed:true};
      return false;
    } finally {
      if(writeOwner===owner) {
        writeOwner=null;
        if(active&&isVisible()) {
          renderConnections();renderInbox();renderDeliveries();
          if(restoreFocus&&deliveryOpen()&&(!doc()?.activeElement||doc().activeElement===doc().body||doc().activeElement===source)) {
            const row=[...(byId('cfgStewardBotDeliveries')?.querySelectorAll?.('[data-delivery-id]')||[])].find(node=>node.dataset.deliveryId===item.id);
            const action=row?.querySelector('[data-bot-action="retry"]');
            (action&&!action.disabled?action:byId('cfgStewardBotDeliveryRefresh'))?.focus();
          }
        }
      }
    }
  }
  function changeDeliveryFilter() {
    deliveryFilter = byId('cfgStewardBotDeliveryConnection')?.value || ''; archiveFilter = byId('cfgStewardBotDeliveryArchive')?.value || 'active';
    deliverySeq++; deliveries = []; deliveryCursor = ''; deliveryTotal = 0; quality.deliveries = 'loading'; errorDetail.deliveries = '';
    renderDeliveries(); void loadDeliveries();
  }
  function discoverNote(text, tone = '') {
    const node = byId(DISCOVER.note);
    if (node) { node.textContent = text; node.dataset.tone = tone; }
  }
  function panelNote(key, params = {}, tone = '') {
    const node = byId('cfgStewardExternalBotNote');
    if (node) { node.textContent = t(key, params); node.dataset.tone = tone; }
  }
  function closeDiscover() {
    const form = byId(DISCOVER.form); if (form) form.hidden = true;
    const secret = byId(DISCOVER.secret); if (secret) secret.value = '';
    const run = byId(DISCOVER.run); if (run) run.disabled = false;
    discovering = false;
  }
  function openDiscover() {
    if (!active || !isVisible() || writeOwner) return false;
    const form = byId(DISCOVER.form); if (!form) return false;
    form.hidden = false; discoverNote(t('externalBots.discoverHint'));
    const appId = byId(DISCOVER.appId); if (appId) appId.focus();
    return true;
  }
  async function runDiscover(event) {
    event?.preventDefault();
    if (discovering || writeOwner || !active || !isVisible()) return false;
    const appId = String(byId(DISCOVER.appId)?.value || '').trim();
    const appSecret = String(byId(DISCOVER.secret)?.value || '');
    const label = String(byId(DISCOVER.label)?.value || '').trim();
    // Clear the DOM value before the request leaves: the secret must not survive in the page.
    const secretNode = byId(DISCOVER.secret); if (secretNode) secretNode.value = '';
    if (!appId || !appSecret) { discoverNote(t('externalBots.discoverInvalid'), 'err'); return false; }
    const mine = generation; discovering = true;
    const run = byId(DISCOVER.run); if (run) run.disabled = true;
    discoverNote(t('externalBots.discoverRunning'));
    try {
      const body = await api('/api/external-bots/discover', { method: 'POST', body: JSON.stringify({ op: 'probe', appId, appSecret, label, create: true }) });
      if (mine !== generation || !active || !isVisible()) return false;
      if (body?.ok !== true) throw body || new Error('write_unconfirmed');
      const created = ['created', 'reused', 'existing'].includes(body.created) ? body.created : 'created';
      const params = { tenant: String(body.discovery?.tenantId || ''), bot: String(body.discovery?.botUserId || '') };
      discoverNote(t('externalBots.discover' + created[0].toUpperCase() + created.slice(1), params), created === 'existing' ? 'warn' : '');
      await loadConnections();
      if (created !== 'existing' && typeof body.connectionId === 'string' && body.connectionId) setup.open(body.connectionId);
      return true;
    } catch (error) {
      if (mine === generation && active && isVisible()) discoverNote(t('externalBots.discoverFailed') + ' ' + errorText(error), 'err');
      return false;
    } finally { discovering = false; const node = byId(DISCOVER.run); if (node) node.disabled = false; }
  }
  // Read-only re-probe with the stored app secret: reports agreement, never rewrites the connection identity.
  async function verifyIdentity(row) {
    if (discovering || writeOwner || !active || !isVisible()) return false;
    discovering = true; panelNote('externalBots.verifying');
    try {
      const body = await api('/api/external-bots/discover', { method: 'POST', body: JSON.stringify({ op: 'verify', connectionId: row.id }) });
      if (!active || !isVisible()) return false;
      if (body?.ok !== true) throw body || new Error('write_unconfirmed');
      const match = body.matches?.tenantId === true && body.matches?.botUserId === true;
      const params = { tenant: String(body.discovery?.tenantId || ''), bot: String(body.discovery?.botUserId || '') };
      panelNote(match ? 'externalBots.verifyMatch' : 'externalBots.verifyMismatch', params, match ? '' : 'err');
      return match;
    } catch (error) {
      if (active && isVisible()) panelNote('externalBots.discoverFailed', {}, 'err');
      return false;
    } finally { discovering = false; }
  }
  async function loadConnections() {
    if (!active || !isVisible()) return false;
    const mine = generation, seq = ++connectionSeq;
    quality.connections = 'loading'; readStatus('connections');
    try {
      const body = await api('/api/external-bots/connections');
      if (!current(mine, seq, 'connections')) return false;
      if (body?.ok !== true || !Array.isArray(body.connections) || !body.connections.every(validExternalConnection)) throw new Error('invalid_response');
      connections = body.connections; quality.connections = 'ok'; errorDetail.connections = '';
    } catch (error) {
      if (!current(mine, seq, 'connections')) return false;
      quality.connections = 'failed'; errorDetail.connections = errorText(error);
    }
    renderConnections(); return quality.connections === 'ok';
  }
  async function loadInbox(older = false) {
    if (!active || !isVisible()) return false;
    older = older === true;
    if (older && (!nextBefore || quality.inbox === 'loading')) return false;
    const before = older ? nextBefore : '';
    if (!older) nextBefore = '';
    const mine = generation, seq = ++inboxSeq, connectionId = filter;
    quality.inbox = 'loading'; readStatus('inbox');
    try {
      const body = await api('/api/external-bots/inbox?limit=50' + (connectionId ? '&connectionId=' + encodeURIComponent(connectionId) : '')
        + (before ? '&before=' + encodeURIComponent(before) : ''));
      if (!current(mine, seq, 'inbox')) return false;
      if (body?.ok !== true || !Array.isArray(body.items) || !body.items.every(validExternalInboxItem)
          || typeof body.nextBefore !== 'string' || !Number.isInteger(body.total) || body.total < 0
          || (body.worker !== undefined && (!body.worker || typeof body.worker.running !== 'boolean' || typeof body.worker.errorCode !== 'string'))
          || (connectionId && body.items.some(item => item.connectionId !== connectionId))) throw new Error('invalid_response');
      items = older ? [...new Map([...items, ...body.items].map(item => [item.id, item])).values()] : body.items;
      nextBefore = body.nextBefore; total = body.total; quality.inbox = 'ok'; errorDetail.inbox = '';
      worker = body.worker || { running: false, errorCode: '' };
    } catch (error) {
      if (!current(mine, seq, 'inbox')) return false;
      quality.inbox = 'failed'; errorDetail.inbox = errorText(error);
    }
    renderInbox(); return quality.inbox === 'ok';
  }
  async function mutate(payload) {
    if (writeOwner || !active || !isVisible() || quality.connections !== 'ok') return false;
    const owner = {}; writeOwner = owner; const mine = generation;
    renderConnections(); renderInbox(); renderDeliveries();
    try {
      if (payload.op === 'upsert' && payload.connection?.mode === 'control') {
        const row = payload.connection;
        if (!await confirmDanger({ titleKey: 'externalBots.controlConfirmTitle', bodyKey: 'externalBots.controlConfirmBody',
          bodyParams: { sender: row.ownerSenderId, conversation: row.ownerConversationId, type: t(row.ownerConversationType === 'group' ? 'externalBots.group' : 'externalBots.direct') } })) return false;
        if (mine !== generation || !active || !isVisible() || writeOwner !== owner) return false;
        payload = { ...payload, controlConfirmed: true };
      }
      const response = await api('/api/external-bots/connections', { method: 'POST', body: JSON.stringify(payload) });
      if (mine !== generation || !active || !isVisible()) return false;
      if (response?.ok !== true) throw response || new Error('write_unconfirmed');
      const form = byId('cfgStewardBotForm'); if (form) form.hidden = true;
      say('externalBots.saved'); await loadConnections();
      return true;
    } catch (error) {
      if (mine === generation && active && isVisible()) { say('externalBots.saveFailed', 'err'); const note = byId('cfgStewardExternalBotNote'); if (note) note.textContent += ' ' + errorText(error); }
      return false;
    } finally { if (writeOwner === owner) { writeOwner = null; if (active && isVisible()) { renderConnections(); renderInbox(); renderDeliveries(); } } }
  }
  async function removeConnection(row) {
    const mine = generation;
    if (writeOwner || !active || !isVisible()) return false;
    if (!await confirmDanger({ titleKey: 'externalBots.delete', bodyKey: 'externalBots.deleteConfirm', bodyParams: { label: row.label || row.id } })) return false;
    if (mine !== generation || !active || !isVisible()) return false;
    return mutate({ op: 'delete', id: row.id });
  }
  async function markRead(item) {
    if (writeOwner || !active || !isVisible()) return false;
    const mine = generation, owner = {}; writeOwner = owner; renderInbox(); renderDeliveries();
    try {
      const response = await api('/api/external-bots/inbox/read', { method: 'POST', body: JSON.stringify({ id: item.id }) });
      if (mine !== generation || !active || !isVisible()) return false;
      if (response?.ok !== true) throw new Error('write_unconfirmed');
      await loadInbox(); return true;
    } catch {
      if (mine === generation && active && isVisible()) say('externalBots.readFailed', 'err');
      return false;
    } finally { if (writeOwner === owner) { writeOwner = null; if (active && isVisible()) { renderConnections(); renderInbox(); renderDeliveries(); } } }
  }
  function addDraft(item) {
    if (!active || !isVisible()) return false;
    const result = typeof importer === 'function' ? importer(item) : { ok: false, reason: 'unavailable' };
    say(result?.ok === true ? 'externalBots.draftAdded' : result?.reason === 'draftBusy' ? 'externalBots.draftBusy' : 'externalBots.draftUnavailable', result?.ok === true ? '' : 'err');
    return result?.ok === true;
  }
  function edit(row = null) {
    if (!active || !isVisible() || writeOwner) return;
    for (const key of FIELDS) { const node = byId(IDS[key]); if (node) { node.value = row?.[key] || ({ platform: 'feishu', mode: 'inbox', ownerConversationType: 'direct' }[key] || ''); node.disabled = Boolean(row) && ['id', 'platform', 'appId', 'tenantId', 'botUserId'].includes(key); } }
    for (const [key, id] of [['allowedSenderIds', 'cfgStewardBotAllowedSenders'], ['allowedConversationIds', 'cfgStewardBotAllowedConversations']]) {
      const node = byId(id); if (node) node.value = (row?.[key] || []).join('\n');
    }
    const enabled = byId('cfgStewardBotEnabled'); if (enabled) enabled.checked = row?.enabled === true;
    if (!row) { const id = byId(IDS.id); if (id) id.value = 'bot_' + globalThis.crypto.randomUUID().replace(/-/g, ''); }
    platformFields(false);
    modeFields();
    const form = byId('cfgStewardBotForm'); if (form) form.hidden = false;
    byId('cfgStewardBotLabel')?.focus();
  }
  function platformFields(clearUnused = true) {
    const feishu = byId(IDS.platform)?.value !== 'qq';
    for (const key of ENV_FIELDS) {
      const applicable = feishu ? key !== 'botSecretEnv' : key === 'botSecretEnv';
      const node = byId(IDS[key]);
      if (node) { const label = node.closest('label'); if (label) label.hidden = !applicable; if (!applicable && clearUnused) node.value = ''; }
    }
    for (const key of ['tenantId', 'botUserId']) { const node = byId(IDS[key]); if (node) node.required = feishu; }
  }
  function modeFields() {
    const control = byId(IDS.mode)?.value === 'control';
    for (const key of ['ownerSenderId', 'ownerConversationId', 'ownerConversationType']) { const node = byId(IDS[key]); if (node) { node.closest('label').hidden = !control; node.required = control; } }
  }
  function save(event) {
    event?.preventDefault();
    const connection = {};
    for (const key of FIELDS) connection[key] = String(byId(IDS[key])?.value || '').trim();
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(connection.id)) { say('externalBots.invalidConnection', 'err'); return false; }
    connection.enabled = byId('cfgStewardBotEnabled')?.checked === true;
    connection.allowedSenderIds = String(byId('cfgStewardBotAllowedSenders')?.value || '').split(/[\r\n,]+/).map(id => id.trim()).filter(Boolean);
    connection.allowedConversationIds = String(byId('cfgStewardBotAllowedConversations')?.value || '').split(/[\r\n,]+/).map(id => id.trim()).filter(Boolean);
    if (connection.mode === 'control' && (!connection.ownerSenderId || !connection.ownerConversationId
        || !connection.allowedSenderIds.includes(connection.ownerSenderId) || !connection.allowedConversationIds.includes(connection.ownerConversationId))) { say('externalBots.ownerRequired', 'err'); return false; }
    if (ENV_FIELDS.some(key => connection[key] && !ENV_NAME.test(connection[key]))) { say('externalBots.envOnly', 'err'); return false; }
    return mutate({ op: 'upsert', connection });
  }
  function invalidate(reason = 'failed') {
    setup.close(); closeDiscover();
    generation++; connectionSeq++; inboxSeq++; deliverySeq++; writeOwner = null; nextBefore = ''; deliveryCursor = '';
    quality.connections = reason; quality.inbox = reason; quality.deliveries = reason;
    if (active && isVisible()) { renderConnections(); renderInbox(); renderDeliveries(); }
  }
  function syncVisibility() {
    const next = isVisible();
    if (next === active) return;
    active = next; invalidate(active ? 'loading' : 'unread');
    if (active) { void loadConnections(); void loadInbox(); if (deliveryOpen()) void loadDeliveries(); }
  }
  function bind() {
    if (bound || !doc()) return false;
    bound = true;
    const on = (id, event, callback) => byId(id)?.addEventListener(event, callback);
    on('cfgStewardBotConnectionsRefresh', 'click', loadConnections); on('cfgStewardBotInboxRefresh', 'click', loadInbox);
    on('cfgStewardBotInboxMore', 'click', () => loadInbox(true));
    on('cfgStewardBotDeliverySection', 'toggle', () => { if (deliveryOpen()) void loadDeliveries(); else { deliverySeq++; quality.deliveries = 'unread'; } });
    on('cfgStewardBotDeliveryRefresh', 'click', loadDeliveries); on('cfgStewardBotDeliveryMore', 'click', () => loadDeliveries(true));
    on('cfgStewardBotDeliveryConnection', 'change', changeDeliveryFilter); on('cfgStewardBotDeliveryArchive', 'change', changeDeliveryFilter);
    on('cfgStewardBotNew', 'click', () => edit()); on('cfgStewardBotForm', 'submit', save);
    on('cfgStewardBotDiscoverOpen', 'click', openDiscover); on('cfgStewardBotDiscoverForm', 'submit', runDiscover);
    on('cfgStewardBotDiscoverCancel', 'click', closeDiscover);
    on('cfgStewardBotPlatform', 'change', () => platformFields());
    on('cfgStewardBotMode', 'change', () => modeFields());
    on('cfgStewardBotCancel', 'click', () => { const form = byId('cfgStewardBotForm'); if (form) form.hidden = true; });
    on('cfgStewardBotInboxConnection', 'change', () => { filter = byId('cfgStewardBotInboxConnection')?.value || ''; items = []; nextBefore = ''; quality.inbox = 'loading'; renderInbox(); void loadInbox(); });
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(syncVisibility);
      for (const id of ['settingsModal', 'stab-steward']) { const node = byId(id); if (node) observer.observe(node, { attributes: true, attributeFilter: ['class', 'hidden', 'data-only'] }); }
    }
    try { globalThis.addEventListener('i18n:change', () => { if (active && isVisible()) { renderConnections(); renderInbox(); renderDeliveries(); setup.repaint(); } }); } catch { /* optional host */ }
    syncVisibility(); return true;
  }
  return Object.freeze({ bind, syncVisibility, loadConnections, loadInbox, loadDeliveries, openSetup: id => { syncVisibility(); return setup.open(id); },
    setDraftImporter: handler => { importer = typeof handler === 'function' ? handler : null; },
    setEventStream: stream => {
      if (!stream || typeof stream.on !== 'function') return;
      let restarting = false;
      stream.on(EVENT_STREAM_INSTANCE_EVENT, () => { restarting = true; invalidate('restarting'); });
      stream.on('presence.ack', () => { if (restarting) { restarting = false; if (active && isVisible()) { void loadConnections(); void loadInbox(); if (deliveryOpen()) void loadDeliveries(); } } });
    },
    snapshot: () => ({ connections: connections.slice(), items: items.slice(), quality: { ...quality }, worker: { ...worker }, generation, writing: Boolean(writeOwner), discovering, nextBefore, total, deliveries: deliveries.slice(), deliveryCursor, deliveryTotal, retained, deliveryFilter, archiveFilter, archivePending: Boolean(archivePending), retryRequests:replyRetries.snapshot() }),
  });
}
