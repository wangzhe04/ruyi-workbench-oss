'use strict';
import { byId, el, clear, button } from './steward-chips.js';
import { apiErrorInfo } from './net.js';
import { getLocale } from './i18n.js';
import { confirmDanger } from './confirm-panel.js';

const SLOTS = { feishu: ['verificationToken', 'encryptKey', 'appSecret'], qq: ['botSecret'] };
export function validBotSetup(value) {
  const pair = value?.pairing;
  return Boolean(value?.ok === true && value.connection && typeof value.connection.id === 'string' && value.connection.id.length > 0
    && ['feishu', 'qq'].includes(value.connection.platform) && typeof value.connection.enabled === 'boolean'
    && typeof value.expectedSetupToken === 'string' && value.expectedSetupToken
    && typeof value.readiness?.ingressReady === 'boolean' && typeof value.readiness?.replyReady === 'boolean'
    && value.readiness.credentialSources && Array.isArray(value.readiness.missing) && value.readiness.missing.every(slot => typeof slot === 'string')
    && SLOTS[value.connection.platform].every(slot => { const item = value.readiness.credentialSources[slot]; return item && ['env', 'local', 'none'].includes(item.source) && typeof item.present === 'boolean' && typeof item.ready === 'boolean' && (!item.ready || item.present && item.source !== 'none' && !item.errorCode) && (item.errorCode === undefined || typeof item.errorCode === 'string'); })
    && (!value.readiness.ingressReady || (value.connection.platform === 'qq' ? ['botSecret'] : ['verificationToken', 'encryptKey']).every(slot => value.readiness.credentialSources[slot].ready))
    && (!value.readiness.replyReady || SLOTS[value.connection.platform].every(slot => value.readiness.credentialSources[slot].ready))
    && (pair === null || (pair && ['waiting', 'candidate'].includes(pair.state) && typeof pair.pairingId === 'string' && pair.pairingId.length > 0
      && Number.isFinite(Date.parse(pair.expiresAt)) && (pair.state !== 'waiting' || typeof pair.code === 'string')
      && (pair.state !== 'candidate' || pair.candidate && ['senderId', 'conversationId', 'conversationType'].every(key => typeof pair.candidate[key] === 'string' && pair.candidate[key].length > 0) && ['direct', 'group'].includes(pair.candidate.conversationType)))));
}
// Secrets live only in these password inputs and the dedicated POST body. No draft, storage, model or action path.
export function createExternalBotSetup({ api, t = key => key, isVisible = () => false, onChanged = () => {},
  later = (fn, ms) => setTimeout(fn, ms), cancelLater = timer => clearTimeout(timer), now = () => Date.now(), confirm = confirmDanger } = {}) {
  let connectionId = '', generation = 0, readSeq = 0, snapshot = null, timer = null, owner = null, confirmOwner = null;
  let quality = 'unread', note = '', polls = 0, ambiguous = false, replaceInput = null, landOnRead = false;
  const passwords = new Map();
  const pageVisible = () => isVisible() && globalThis.document?.visibilityState !== 'hidden';
  const host = () => byId('cfgStewardBotSetup');
  const live = mine => mine === generation && Boolean(connectionId) && isVisible();
  function stopTimer() { if (timer !== null) cancelLater(timer); timer = null; }
  function erase() { replaceInput = null; for (const input of passwords.values()) input.value = ''; passwords.clear(); }
  function close() { generation++; readSeq++; stopTimer(); erase(); owner = null; confirmOwner = null; connectionId = ''; snapshot = null; quality = 'unread'; ambiguous = false; landOnRead = false; const node = host(); if (node) { clear(node); node.hidden = true; } }
  function errorText(error) {
    const code = String(apiErrorInfo(error)?.code || '');
    const key = code.includes('setup_changed') || code.includes('conflict') ? 'changed'
      : code.includes('requires_disabled') ? 'requiresDisabled' : code.includes('unsupported') ? 'unsupported'
      : code.includes('expired') ? 'expired' : 'unconfirmed';
    return t('botSetup.' + key) + (/^external_(channel|credentials)\.[a-z_]{1,80}$/.test(code) ? ' (' + code + ')' : '');
  }
  function action(key, name, callback, disabled = false) {
    const node = button('btn btn-sm', t('botSetup.' + key), callback); node.dataset.setupAction = name;
    node.disabled = disabled || Boolean(owner) || Boolean(confirmOwner); return node;
  }
  function copy(value) {
    const mine = generation, id = connectionId;
    const failed = () => { if (live(mine) && connectionId === id) { note = t('botSetup.copyFailed'); render(); } };
    try { const result = globalThis.navigator?.clipboard?.writeText(value); if (!result) throw new Error();
      void result.catch(failed);
    } catch { failed(); }
  }
  function render() {
    const node = host(); if (!node || !connectionId || !isVisible()) return;
    erase(); clear(node); node.hidden = false;
    const heading = el('div', 'external-bots-toolbar');
    heading.append(el('strong', '', t('botSetup.title')), action('refresh', 'refresh', () => refresh(true)), action('close', 'close', close));
    node.append(heading, el('p', 'muted', connectionId));
    const status = el('p', 'external-bot-setup-status', note || t('botSetup.' + (quality === 'ready' ? 'loaded' : quality))); status.setAttribute('role', 'status'); node.appendChild(status);
    if (!snapshot) return;
    const { connection, readiness, pairing } = snapshot;
    node.appendChild(el('p', 'external-bot-setup-identity', [connection.label, connection.platform === 'qq' ? 'QQ' : t('externalBots.feishu'), connection.appId, connection.tenantId, connection.botUserId].filter(Boolean).join(' · ')));
    if (connection.enabled) node.appendChild(el('p', 'external-bot-setup-notice', t('botSetup.enabled')));
    const disabled = connection.enabled || quality !== 'ready' || ambiguous;
    const credentialError = readiness.errorCode || SLOTS[connection.platform].map(slot => readiness.credentialSources[slot]?.errorCode).find(code => code === 'external_credentials.decrypt_failed' || code === 'external_credentials.unsupported') || '';
    const recoverable = credentialError === 'external_credentials.decrypt_failed';
    if (credentialError) node.appendChild(el('p', 'external-bot-setup-notice', t(recoverable ? 'botSetup.decryptFailed' : credentialError === 'external_credentials.unsupported' ? 'botSetup.unsupported' : 'botSetup.credentialsUnavailable')));
    const credentials = el('form', 'external-bot-setup-step');
    credentials.append(el('h5', '', t('botSetup.credentials')), el('p', 'muted', t('botSetup.secretHint')));
    const fields = el('div', 'external-bots-fields');
    for (const slot of SLOTS[connection.platform]) {
      const source = readiness.credentialSources[slot] || { source: 'none', present: false };
      const label = el('label', 'external-bots-field'); label.appendChild(el('span', '', t('botSetup.slot.' + slot)));
      const input = el('input', ''); input.type = 'password'; input.autocomplete = 'new-password'; input.spellcheck = false;
      input.setAttribute('aria-label', t('botSetup.slot.' + slot)); input.dataset.credentialSlot = slot;
      input.disabled = disabled || (Boolean(credentialError) && !recoverable) || Boolean(pairing) || source.source === 'env'; passwords.set(slot, input); label.appendChild(input);
      label.appendChild(el('small', 'muted', t('botSetup.source.' + (source.source === 'env' ? 'env' : source.errorCode ? 'error' : source.present ? 'local' : 'none'))));
      if (source.errorCode) label.appendChild(el('small', 'muted', t(source.source === 'env' ? 'botSetup.envUnavailable' : source.errorCode === 'external_credentials.decrypt_failed' ? 'botSetup.slotDecryptFailed' : 'botSetup.credentialsUnavailable')));
      fields.appendChild(label);
    }
    credentials.appendChild(fields);
    if (recoverable) {
      const recovery = el('label', 'external-bots-enabled'); replaceInput = el('input', ''); replaceInput.type = 'checkbox'; replaceInput.dataset.setupRecovery = 'true';
      replaceInput.disabled = disabled; recovery.append(replaceInput, el('span', '', t('botSetup.replaceAll'))); credentials.appendChild(recovery);
    }
    credentials.append(action('saveCredentials', 'credentials', () => saveCredentials(), disabled || Boolean(credentialError) && !recoverable));
    credentials.addEventListener('submit', event => { event.preventDefault(); void saveCredentials(); }); node.appendChild(credentials);
    const pair = el('section', 'external-bot-setup-step'); pair.append(el('h5', '', t('botSetup.pair')), el('p', 'muted', t('botSetup.callbackHint')));
    if (typeof connection.callbackPath === 'string') { pair.appendChild(el('code', 'external-bots-callback', connection.callbackPath)); pair.appendChild(action('copyCallback', 'copyCallback', () => copy(connection.callbackPath))); }
    pair.appendChild(el('p', '', t(readiness.ingressReady && readiness.replyReady ? 'botSetup.ready' : 'botSetup.notReady')));
    if (!pairing) pair.appendChild(action('startPair', 'pair_start', () => write('pair_start'), disabled || !readiness.ingressReady || !readiness.replyReady));
    else {
      const expired = Date.parse(pairing.expiresAt) <= now();
      pair.appendChild(el('p', 'muted', t(expired ? 'botSetup.expired' : 'botSetup.expires', { time: new Date(pairing.expiresAt).toLocaleTimeString(getLocale()) })));
      if (pairing.state === 'waiting') {
        pair.append(el('p', '', t('botSetup.sendCode')), el('code', 'external-bot-pair-code', pairing.code), action('copyCode', 'copyCode', () => copy(pairing.code), expired));
      } else {
        const candidate = pairing.candidate;
        pair.append(el('p', '', t('botSetup.candidate')), el('p', 'external-bot-setup-identity', [candidate.senderId, candidate.conversationId, t(candidate.conversationType === 'group' ? 'externalBots.group' : 'externalBots.direct')].join(' · ')),
          el('p', 'external-bot-setup-notice', t('botSetup.authorityHint')),
          action('activate', 'activate', activate, disabled || expired));
      }
      pair.appendChild(action('cancelPair', 'pair_cancel', () => write('pair_cancel'), disabled));
    }
    node.appendChild(pair);
    node.appendChild(el('p', 'muted', t('botSetup.evidenceHint')));
  }
  function schedule() {
    stopTimer();
    if (!connectionId || !pageVisible() || owner || ambiguous || quality !== 'ready' || snapshot?.connection.enabled || !snapshot?.pairing
        || Date.parse(snapshot.pairing.expiresAt) <= now() || polls >= 150) return;
    const mine = generation;
    timer = later(() => { timer = null; if (live(mine) && pageVisible()) { polls++; void refresh(false); } }, 2000);
  }
  async function refresh(manual = false) {
    if (!connectionId || !isVisible() || owner) return false;
    const mine = generation, seq = ++readSeq;
    if (manual) { ambiguous = false; note = ''; polls = 0; }
    stopTimer(); if (manual || !snapshot) { quality = 'loading'; render(); }
    try {
      const value = await api('/api/external-bots/setup?connectionId=' + encodeURIComponent(connectionId));
      if (!live(mine) || seq !== readSeq) return false;
      if (!validBotSetup(value) || value.connection.id !== connectionId) throw new Error('shape');
      snapshot = value; quality = 'ready'; note = ''; render();
      if (landOnRead) { landOnRead = false; const node = host(); if (node) { node.setAttribute('tabindex', '-1'); node.setAttribute('aria-label', t('botSetup.title')); node.focus?.({ preventScroll: true }); node.scrollIntoView?.({ block: 'start' }); } }
      schedule(); return true;
    } catch (error) { if (live(mine) && seq === readSeq) { quality = 'failed'; note = errorText(error); render(); } return false; }
  }
  async function write(op, credentials = null, expected = snapshot) {
    if (!connectionId || !isVisible() || owner || quality !== 'ready' || ambiguous || !expected || expected.connection.enabled) return false;
    const mine = generation, id = connectionId, token = expected.expectedSetupToken, mineOwner = {};
    owner = mineOwner; readSeq++; stopTimer(); erase(); render();
    const body = credentials ? { connectionId: id, expectedSetupToken: token, credentials }
      : { op, connectionId: id, expectedSetupToken: token, ...(op === 'activate' ? { controlConfirmed: true } : {}) };
    try {
      const value = await api('/api/external-bots/' + (credentials ? 'credentials' : 'setup'), { method: 'POST', body: JSON.stringify(body) });
      if (!live(mine) || owner !== mineOwner) return false;
      if (!validBotSetup(value) || value.connection.id !== id) throw new Error('shape');
      snapshot = value; quality = 'ready'; note = t('botSetup.' + (credentials ? 'credentialsSaved' : op === 'activate' ? 'enabled' : op === 'pair_start' ? 'pairStarted' : 'pairCancelled'));
      onChanged(); return true;
    } catch (error) { if (live(mine) && owner === mineOwner) { ambiguous = true; note = errorText(error); } return false;
    } finally { if (owner === mineOwner) { owner = null; render(); schedule(); } }
  }
  function saveCredentials() {
    const set = {};
    for (const [slot, input] of passwords) if (!input.disabled && input.value) set[slot] = input.value;
    const replaceAll = replaceInput?.checked === true;
    if (replaceInput && !replaceAll) { note = t('botSetup.replaceRequired'); render(); return false; }
    const remove = [];
    if (replaceAll) {
      for (const slot of SLOTS[snapshot.connection.platform]) {
        if (snapshot.readiness.credentialSources[slot].source === 'env') remove.push(slot);
        else if (!set[slot]) { note = t('botSetup.replaceRequired'); render(); return false; }
      }
    }
    if (!Object.keys(set).length && !replaceAll) return false;
    return write('credentials', { set, remove, ...(replaceAll ? { replaceAll: true } : {}) });
  }
  async function activate() {
    if (owner || confirmOwner || ambiguous || !snapshot?.pairing?.candidate || snapshot.connection.enabled) return false;
    const expected = snapshot, mine = generation, candidate = expected.pairing.candidate, myConfirm = {};
    confirmOwner = myConfirm; render();
    let agreed = false;
    try { agreed = await confirm({ titleKey: 'externalBots.controlConfirmTitle', bodyKey: 'externalBots.controlConfirmBody', bodyParams: { sender: candidate.senderId, conversation: candidate.conversationId, type: t(candidate.conversationType === 'group' ? 'externalBots.group' : 'externalBots.direct') } });
    } catch { agreed = false; } finally { if (confirmOwner === myConfirm) { confirmOwner = null; render(); } }
    if (!agreed || !live(mine)) return false;
    return write('activate', null, expected);
  }
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (!pageVisible()) stopTimer(); else schedule(); });
  return Object.freeze({ open(id) { close(); if (typeof id !== 'string' || !id || !isVisible()) return false; connectionId = id; landOnRead = true; quality = 'loading'; render(); void refresh(); return true; }, close,
    repaint() { if (connectionId && isVisible()) render(); },
    syncVisibility() { if (!isVisible()) close(); }, restart: close, refresh,
    snapshot: () => ({ connectionId, generation, quality, writing: Boolean(owner), polling: timer !== null, ambiguous }) });
}
