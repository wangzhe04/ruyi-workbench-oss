'use strict';
import { doc, byId, el, clear, button } from './steward-chips.js';
import { apiErrorInfo } from './net.js';
import { EVENT_STREAM_INSTANCE_EVENT } from './event-stream.js';
import { confirmDanger } from './confirm-panel.js';

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
    && (!row.delivery || ['pending', 'sending', 'sent', 'failed', 'unknown'].includes(row.delivery.status)));
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
  let active = false, generation = 0, bound = false, importer = null;
  let connectionSeq = 0, inboxSeq = 0, filter = '', writeOwner = null, nextBefore = '', total = 0;
  let connections = [], items = [];
  let worker = { running: false, errorCode: '' };
  const quality = { connections: 'unread', inbox: 'unread' };
  const errorDetail = { connections: '', inbox: '' };
  const current = (mine, seq, kind) => active && isVisible() && mine === generation && seq === (kind === 'connections' ? connectionSeq : inboxSeq);
  const say = (key, tone = '') => {
    const node = byId('cfgStewardExternalBotNote');
    if (node) { node.textContent = t(key); node.dataset.tone = tone; }
  };
  function errorText(error) {
    const info = apiErrorInfo(error);
    const keys = { 'external_channel.connection_incomplete': 'incomplete', 'external_channel.env_reference_invalid': 'envOnly',
      'external_channel.identity_immutable': 'identityHint', 'external_channel.connection_retired': 'retired',
      'external_channel.connection_invalid': 'invalidConnection', 'external_channel.connection_not_found': 'missingConnection',
      'external_channel.storage_unavailable': 'storageUnavailable', 'external_channel.inbox_full': 'capacityFull',
      'external_channel.connections_full': 'capacityFull', 'external_channel.retired_ids_full': 'capacityFull',
      'external_channel.control_revoked': 'controlRevoked', 'external_channel.owner_invalid': 'ownerRequired',
      'external_channel.control_confirmation_required': 'controlConfirmationRequired' };
    const code = String(info?.code || '');
    const delivery = code.startsWith('external_delivery.');
    const key = keys[code] || (code.endsWith('.rate_limited') ? 'rateLimited'
      : delivery && code.startsWith('external_delivery.token_') ? 'replyAuth'
      : delivery && ['external_delivery.invalid_config', 'external_delivery.identity_mismatch'].includes(code) ? 'replyConfig'
      : delivery && code.endsWith('.rejected') ? 'replyRejected'
      : delivery ? 'delivery.unknown' : 'requestFailed');
    return t('externalBots.' + key) + (/^external_(channel|delivery)\.[a-z_]{1,80}$/.test(code) ? ' (' + code + ')' : '');
  }
  function readStatus(kind) {
    const node = byId(kind === 'connections' ? 'cfgStewardBotConnectionsStatus' : 'cfgStewardBotInboxStatus');
    if (!node) return;
    const state = quality[kind];
    const hasCache = kind === 'connections' ? connections.length > 0 : items.length > 0;
    node.textContent = ['failed', 'restarting'].includes(state) ? t(hasCache ? 'externalBots.stale' : 'externalBots.unavailable')
      : state === 'loading' ? t('externalBots.loading') : state === 'unread' ? t('externalBots.notLoaded') : '';
    node.dataset.state = state;
    node.title = errorDetail[kind];
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
      actions.append(control('externalBots.edit', 'edit', () => edit(row)),
        control(row.enabled ? 'externalBots.disable' : 'externalBots.enable', 'toggle', () => mutate(row.enabled ? { op: 'disable', id: row.id }
          : { op: 'upsert', connection: { ...connectionPayload(row), enabled: true } })),
        control('externalBots.delete', 'delete', () => removeConnection(row)));
      for (const action of actions.children) action.disabled ||= quality.connections !== 'ok';
      node.append(copy, actions); host.appendChild(node);
    }
    const select = byId('cfgStewardBotInboxConnection');
    if (select) {
      clear(select); const all = el('option', '', t('externalBots.allConnections')); all.value = ''; select.appendChild(all);
      for (const row of connections) { const option = el('option', '', row.label || row.id); option.value = row.id; select.appendChild(option); }
      select.value = filter;
    }
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
    renderConnections(); renderInbox();
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
    } finally { if (writeOwner === owner) { writeOwner = null; if (active && isVisible()) { renderConnections(); renderInbox(); } } }
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
    const mine = generation, owner = {}; writeOwner = owner; renderInbox();
    try {
      const response = await api('/api/external-bots/inbox/read', { method: 'POST', body: JSON.stringify({ id: item.id }) });
      if (mine !== generation || !active || !isVisible()) return false;
      if (response?.ok !== true) throw new Error('write_unconfirmed');
      await loadInbox(); return true;
    } catch {
      if (mine === generation && active && isVisible()) say('externalBots.readFailed', 'err');
      return false;
    } finally { if (writeOwner === owner) { writeOwner = null; if (active && isVisible()) { renderConnections(); renderInbox(); } } }
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
    generation++; connectionSeq++; inboxSeq++; writeOwner = null; nextBefore = '';
    quality.connections = reason; quality.inbox = reason;
    if (active && isVisible()) { renderConnections(); renderInbox(); }
  }
  function syncVisibility() {
    const next = isVisible();
    if (next === active) return;
    active = next; invalidate(active ? 'loading' : 'unread');
    if (active) { void loadConnections(); void loadInbox(); }
  }
  function bind() {
    if (bound || !doc()) return false;
    bound = true;
    const on = (id, event, callback) => byId(id)?.addEventListener(event, callback);
    on('cfgStewardBotConnectionsRefresh', 'click', loadConnections); on('cfgStewardBotInboxRefresh', 'click', loadInbox);
    on('cfgStewardBotInboxMore', 'click', () => loadInbox(true));
    on('cfgStewardBotNew', 'click', () => edit()); on('cfgStewardBotForm', 'submit', save);
    on('cfgStewardBotPlatform', 'change', () => platformFields());
    on('cfgStewardBotMode', 'change', () => modeFields());
    on('cfgStewardBotCancel', 'click', () => { const form = byId('cfgStewardBotForm'); if (form) form.hidden = true; });
    on('cfgStewardBotInboxConnection', 'change', () => { filter = byId('cfgStewardBotInboxConnection')?.value || ''; items = []; nextBefore = ''; quality.inbox = 'loading'; renderInbox(); void loadInbox(); });
    if (typeof MutationObserver === 'function') {
      const observer = new MutationObserver(syncVisibility);
      for (const id of ['settingsModal', 'stab-steward']) { const node = byId(id); if (node) observer.observe(node, { attributes: true, attributeFilter: ['class', 'hidden', 'data-only'] }); }
    }
    try { globalThis.addEventListener('i18n:change', () => { if (active && isVisible()) { renderConnections(); renderInbox(); } }); } catch { /* optional host */ }
    syncVisibility(); return true;
  }
  return Object.freeze({ bind, syncVisibility, loadConnections, loadInbox,
    setDraftImporter: handler => { importer = typeof handler === 'function' ? handler : null; },
    setEventStream: stream => {
      if (!stream || typeof stream.on !== 'function') return;
      let restarting = false;
      stream.on(EVENT_STREAM_INSTANCE_EVENT, () => { restarting = true; invalidate('restarting'); });
      stream.on('presence.ack', () => { if (restarting) { restarting = false; if (active && isVisible()) { void loadConnections(); void loadInbox(); } } });
    },
    snapshot: () => ({ connections: connections.slice(), items: items.slice(), quality: { ...quality }, worker: { ...worker }, generation, writing: Boolean(writeOwner), nextBefore, total }),
  });
}
