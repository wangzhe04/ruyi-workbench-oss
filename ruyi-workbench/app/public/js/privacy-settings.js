import { api, apiErrorInfo } from './net.js';
import { t } from './i18n.js';
import { icon } from './icons.js';

const MODES = ['off', 'basic', 'enhanced', 'strict'];
let indicatorConfig = null, indicatorOpen = null;
function paintPrivacyMenuItem(button) {
  const value = indicatorConfig;
  const state = !value ? 'unknown' : value.privacyPolicyRecoveryRequiredV1 ? 'paused' : value.privacyModeV1 || 'off';
  const copy = document.createElement('span'); copy.className = 'privacy-menu-copy';
  const title = document.createElement('strong'); title.textContent = t('privacy.menuTitle');
  const hint = document.createElement('span'); hint.textContent = t('privacy.menuHint'); copy.append(title, hint);
  const label = document.createElement('span'); label.className = 'privacy-menu-state'; label.textContent = t('privacy.pill.' + state);
  button.replaceChildren(icon('shield', 16), copy, label);
  button.title = t(!value ? 'privacy.indicatorUnknown' : value.privacyPolicyRecoveryRequiredV1 ? 'privacy.indicatorPaused'
    : state !== 'off' ? 'privacy.indicatorOn' : 'privacy.indicatorOff', { level: t('privacy.level.' + state) });
  button.setAttribute('aria-label', t('privacy.menuTitle') + ': ' + button.title); button.setAttribute('aria-haspopup', 'dialog');
  button.dataset.privacy = state;
}
// Created only inside the existing composer More popover. No extra composer control or menu system.
export function privacyComposerMenuItem(id, close) {
  const button = document.createElement('button'); button.id = id; button.type = 'button'; button.className = 'cm-item privacy-menu-item';
  paintPrivacyMenuItem(button); button.onclick = () => { close(); indicatorOpen?.(); }; return button;
}
// Saved configuration only: no input listeners, scanning or mapping work on composer paths.
export function renderPrivacyIndicators(config, onOpen) {
  if (arguments.length > 0) indicatorConfig = config;
  if (onOpen) indicatorOpen = onOpen;
  for (const id of ['chatPrivacyIndicator', 'stewardPrivacyIndicator']) {
    const button = document.getElementById(id); if (!button) continue;
    paintPrivacyMenuItem(button);
  }
}

export function mountPrivacySettings({ onSaved = async () => {} } = {}) {
  const host = document.getElementById('privacySettings');
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = 'true'; host.classList.add('privacy-panel');
  const node = (tag, key, className) => { const element = document.createElement(tag); if (key) { element.textContent = t('privacy.' + key); element.dataset.i18n = 'privacy.' + key; } if (className) element.className = className; return element; };
  const field = (key, control) => { const row = node('div', null, 'field-block'); const label = node('label', key); label.htmlFor = control.id; row.append(label, control); return row; };
  const check = (key, input) => { const label = node('label', null, 'check privacy-check'); label.append(input, node('span', key)); return label; };
  const fold = (key, id) => { const details = node('details', null, 'privacy-fold'); details.id = id; details.append(node('summary', key)); return details; };
  const button = (key, id, handler) => { const element = node('button', key, 'btn'); element.id = id; element.type = 'button'; element.onclick = () => action(handler); return element; };
  let busy = false, saved = null, liveSaved = null, loaded = false, ticket = '', supported = false, manualEncryption = false, conflict = false, summaryUnknown = false;
  const summary = node('div', null, 'privacy-summary'); summary.id = 'privacySavedSummary'; summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  const recoveryNotice = node('p', 'policyRecoveryRequired', 'privacy-recovery'); recoveryNotice.id = 'privacyPolicyRecoveryNotice'; recoveryNotice.hidden = true;
  const mode = node('select'); mode.id = 'privacyMode'; mode.hidden = true; mode.setAttribute('aria-hidden', 'true'); mode.tabIndex = -1;
  for (const value of MODES) { const option = node('option', value); option.value = value; mode.append(option); }
  const levels = node('fieldset', null, 'privacy-levels'); levels.id = 'privacyLevels'; levels.append(node('legend', 'chooseLevel'));
  const radios = [];
  for (const value of MODES) {
    const label = node('label', null, 'privacy-level'); const input = node('input'); input.type = 'radio'; input.name = 'privacy-level'; input.value = value; input.id = 'privacyLevel-' + value;
    const text = node('span', null, 'privacy-level-copy'); text.append(node('strong', 'level.' + value), node('span', 'levelHelp.' + value));
    label.append(input, text); levels.append(label); radios.push(input);
    input.addEventListener('change', () => { if (input.checked) { mode.value = value; changed(true); } });
  }
  const encryption = node('input'); encryption.id = 'privacyEncryption'; encryption.type = 'checkbox';
  const technical = node('input'); technical.id = 'privacyTechnical'; technical.type = 'checkbox';
  const confirmPlaintext = node('input'); confirmPlaintext.id = 'privacyConfirmPlaintext'; confirmPlaintext.type = 'checkbox';
  const plaintextRow = check('confirmPlaintext', confirmPlaintext); plaintextRow.hidden = true;
  const encryptionState = node('p', null, 'field-help'); encryptionState.id = 'privacyEncryptionState';
  const dependency = node('p', 'encryptionDependency', 'privacy-dependency'); dependency.id = 'privacyEncryptionDependency'; dependency.hidden = true;
  const platformNotice = node('p', 'encryptionUnsupported', 'field-help'); platformNotice.id = 'privacyPlatformNotice'; platformNotice.hidden = true;
  const rules = node('textarea'); rules.id = 'privacyRules'; rules.rows = 6; rules.spellcheck = false; rules.autocomplete = 'off';
  const ruleKind = node('select'); ruleKind.id = 'privacyRuleKind';
  for (const value of ['literal', 'field', 'regex']) { const option = node('option', 'kind.' + value); option.value = value; ruleKind.append(option); }
  const ruleValue = node('input'); ruleValue.id = 'privacyRuleValue'; ruleValue.type = 'text'; ruleValue.maxLength = 4096; ruleValue.autocomplete = 'off'; ruleValue.spellcheck = false;
  const ruleCategory = node('select'); ruleCategory.id = 'privacyRuleCategory';
  for (const value of ['INTERNAL', 'CREDENTIAL', 'EMAIL', 'PHONE', 'IDENTITY', 'PAYMENT', 'PATH']) { const option = node('option', 'category.' + value); option.value = value; ruleCategory.append(option); }
  const ruleFlags = node('input'); ruleFlags.id = 'privacyRuleFlags'; ruleFlags.type = 'text'; ruleFlags.maxLength = 5; ruleFlags.autocomplete = 'off'; ruleFlags.spellcheck = false;
  const flagsRow = field('ruleFlags', ruleFlags); flagsRow.hidden = true;
  const ruleKindHelp = node('p', null, 'field-help'); ruleKindHelp.id = 'privacyRuleKindHelp';
  const ruleList = node('div', null, 'privacy-rule-list'); ruleList.id = 'privacyRuleList';
  let editingRule = null;
  const examples = [
    { id: 'project', kind: 'literal', value: 'PROJECT-LOTUS-DEMO', category: 'INTERNAL', sample: '项目代号：PROJECT-LOTUS-DEMO；公开备注保留。' },
    { id: 'customer', kind: 'field', value: '/customer/id', category: 'INTERNAL', sample: '{"customer":{"id":"CUSTOMER-DEMO-4821","note":"public note"}}' },
    { id: 'employee', kind: 'regex', value: 'EMP-[0-9]{4}', category: 'INTERNAL', sample: 'Employee EMP-4821; public note stays visible.' },
  ];
  const sample = node('textarea'); sample.id = 'privacyRuleSample'; sample.rows = 4; sample.maxLength = 65536; sample.autocomplete = 'off'; sample.spellcheck = false;
  const output = node('pre', null, 'privacy-output'); output.id = 'privacyRuleOutput';
  const hits = node('ul'); hits.id = 'privacyRuleHits';
  const version = node('p', null, 'field-help'); version.id = 'privacyRuleVersion';
  const pending = node('p', null, 'privacy-pending'); pending.id = 'privacyPending'; pending.setAttribute('role', 'status');
  const status = node('p', null, 'privacy-operation'); status.id = 'privacyStatus'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const coverage = node('ul'); coverage.id = 'privacyCoverage';
  const password = node('input'); password.type = 'password'; password.id = 'privacyPassword'; password.autocomplete = 'new-password'; password.maxLength = 1024;
  const file = node('input'); file.type = 'file'; file.id = 'privacyBackupFile'; file.accept = '.json,application/json';
  const preview = node('div'); preview.id = 'privacyRecoveryPreview';
  const restoreHint = node('p', 'restoreDraftNotice', 'field-help'); restoreHint.hidden = true;
  const clearTrial = () => { output.textContent = ''; hits.replaceChildren(); version.textContent = ''; };
  const invalidateTicket = () => { ticket = ''; preview.replaceChildren(); restore.disabled = true; restoreHint.hidden = true; };
  const ruleEntryPending = () => editingRule !== null || ruleValue.value.length > 0 || ruleFlags.value.length > 0;
  const dirty = () => !!saved && (ruleEntryPending() || mode.value !== saved.mode || technical.checked !== saved.technical || encryption.checked !== saved.encryption || rules.value !== JSON.stringify(saved.rules, null, 2));
  function renderSummary() {
    const current = liveSaved || saved;
    summary.replaceChildren(node('span', 'savedHeading', 'privacy-eyebrow'));
    const paused = current?.recoveryRequired;
    const heading = node('strong'); heading.textContent = t(!current ? summaryUnknown ? 'privacy.savedUnknown' : 'privacy.loading' : paused ? 'privacy.savedPaused' : current.mode === 'off' ? 'privacy.savedOff' : 'privacy.savedOn', { level: t('privacy.level.' + (current?.mode || 'off')) }); summary.append(heading);
    if (!current) { summary.dataset.mode = 'unknown'; recoveryNotice.hidden = true; return; }
    const explanation = node('p'); explanation.textContent = t(current?.mode && current.mode !== 'off' ? 'privacy.savedScope' : 'privacy.savedOffHelp'); summary.append(explanation);
    const storage = node('span', null, 'privacy-storage'); storage.textContent = t(current?.encryption ? 'privacy.encrypted' : 'privacy.storageOff'); summary.append(storage);
    summary.dataset.mode = paused ? 'paused' : current?.mode || 'unknown'; recoveryNotice.hidden = !paused;
  }
  function render() {
    for (const radio of radios) radio.checked = radio.value === mode.value;
    dependency.hidden = mode.value === 'off';
    platformNotice.hidden = !loaded || supported || saved?.encryption === true;
    plaintextRow.hidden = !saved?.encryption || encryption.checked;
    encryptionState.textContent = t('privacy.encryptionHelp');
    const pendingText = t(!loaded ? summaryUnknown ? 'privacy.savedUnknown' : 'privacy.loading' : ruleEntryPending() ? 'privacy.ruleEntryPending' : dirty() ? 'privacy.unsaved' : 'privacy.noPending') + (loaded && dirty() && !ruleEntryPending() ? ' · ' + t('privacy.level.' + mode.value) : '');
    if (pending.textContent !== pendingText) pending.textContent = pendingText;
    pending.dataset.dirty = String(dirty());
    save.textContent = t(mode.value !== 'off' && !saved?.encryption ? 'privacy.saveWithEncryption' : 'privacy.save', { level: t('privacy.level.' + mode.value) });
    for (const control of host.querySelectorAll('button,input,select,textarea')) control.disabled = busy || !loaded;
    save.disabled = busy || !loaded || conflict || ruleEntryPending() || (!dirty() && !saved?.recoveryRequired) || (mode.value !== 'off' && !supported && !saved?.encryption);
    encryption.disabled = busy || !loaded || mode.value !== 'off' || (!supported && !saved?.encryption);
    restore.disabled = busy || !loaded || !ticket || dirty(); restoreHint.hidden = !ticket || !dirty(); exportButton.disabled = busy || !loaded || !saved?.encryption;
    reload.hidden = loaded && !dirty() && !conflict; reload.disabled = busy || ruleEntryPending();
    rules.disabled = busy || !loaded || ruleEntryPending(); trial.disabled = busy || !loaded || ruleEntryPending();
    cancelEdit.hidden = !ruleEntryPending();
    for (const control of host.querySelectorAll('[data-rule-edit],[data-rule-remove],[id^="privacyAddExample-"]')) control.disabled = busy || !loaded || ruleEntryPending();
  }
  function changed(autoEncrypt = false) {
    if (autoEncrypt) encryption.checked = mode.value === 'off' ? manualEncryption : true;
    confirmPlaintext.checked = false; clearTrial(); status.textContent = conflict ? t('privacy.settingsChanged') : ''; render();
  }
  function draftRules() { const value = JSON.parse(rules.value || '[]'); if (!Array.isArray(value)) throw new SyntaxError(); return value; }
  function writeRules(value) { rules.value = JSON.stringify(value, null, 2); editingRule = null; renderRuleList(); changed(); }
  function freshRuleId(list, base = 'custom-rule') { let id = base, suffix = 1; while (list.some(rule => rule.id === id)) id = base + '-' + suffix++; return id; }
  function renderRuleList() {
    flagsRow.hidden = ruleKind.value !== 'regex'; ruleKindHelp.textContent = t('privacy.kindHelp.' + ruleKind.value);
    addRule.textContent = t(editingRule === null ? 'privacy.addRule' : 'privacy.updateRule'); cancelEdit.hidden = !ruleEntryPending();
    ruleList.replaceChildren();
    let list; try { list = draftRules(); } catch { ruleList.append(node('p', 'rulesInvalid', 'field-help')); return; }
    if (!list.length) { ruleList.append(node('p', 'rulesEmpty', 'field-help')); return; }
    for (const [index, entry] of list.entries()) {
      if (!entry || !['literal', 'field', 'regex'].includes(entry.kind) || typeof entry.value !== 'string' || !['INTERNAL', 'CREDENTIAL', 'EMAIL', 'PHONE', 'IDENTITY', 'PAYMENT', 'PATH'].includes(entry.category)) { ruleList.append(node('p', 'ruleInputInvalid', 'field-help')); continue; }
      const row = node('div', null, 'privacy-rule-row'); const copy = node('div', null, 'privacy-rule-copy');
      const title = node('strong'); title.textContent = t('privacy.kind.' + entry.kind) + ' · ' + t('privacy.category.' + entry.category);
      const value = node('code'); value.textContent = typeof entry.value === 'string' ? entry.value : t('privacy.rulesInvalid'); copy.append(title, value);
      const edit = button('editRule', '', async () => { editingRule = index; ruleKind.value = entry.kind; ruleCategory.value = entry.category; ruleValue.value = entry.value; ruleFlags.value = entry.flags || ''; renderRuleList(); status.textContent = ''; }); edit.dataset.ruleEdit = String(index);
      const remove = button('removeRule', '', async () => { const current = draftRules(); current.splice(index, 1); writeRules(current); }); remove.dataset.ruleRemove = String(index);
      const actions = node('div', null, 'privacy-rule-actions'); actions.append(edit, remove); row.append(copy, actions); ruleList.append(row);
    }
  }
  const addRule = button('addRule', 'privacyAddRule', async () => {
    const list = draftRules(), value = ruleValue.value;
    if (!value || ruleKind.value === 'field' && (!value.startsWith('/') || /~(?![01])/.test(value)) || ruleKind.value === 'regex' && (value.length > 1024 || !/^[gimsu]*$/.test(ruleFlags.value) || new Set(ruleFlags.value).size !== ruleFlags.value.length)) { status.textContent = t('privacy.ruleInputInvalid'); return; }
    const entry = { ...(editingRule === null ? { id: freshRuleId(list) } : list[editingRule]), kind: ruleKind.value, value, category: ruleCategory.value };
    if (entry.kind === 'regex') entry.flags = ruleFlags.value; else delete entry.flags;
    if (editingRule === null) list.push(entry); else list[editingRule] = entry;
    writeRules(list); ruleValue.value = ''; ruleFlags.value = ''; status.textContent = t('privacy.ruleDraftAdded');
  });
  const cancelEdit = button('cancelEdit', 'privacyCancelRuleEdit', async () => { editingRule = null; ruleValue.value = ''; ruleFlags.value = ''; renderRuleList(); status.textContent = ''; }); cancelEdit.hidden = true;
  ruleKind.addEventListener('change', () => { renderRuleList(); render(); });
  for (const control of [ruleValue, ruleFlags]) control.addEventListener('input', () => changed());
  mode.addEventListener('input', () => changed(true)); mode.addEventListener('change', () => changed(true));
  technical.addEventListener('input', () => changed());
  rules.addEventListener('input', () => { editingRule = null; renderRuleList(); changed(); });
  encryption.addEventListener('input', () => { if (mode.value === 'off') manualEncryption = encryption.checked; changed(); });
  confirmPlaintext.addEventListener('input', render); sample.addEventListener('input', clearTrial);
  file.addEventListener('change', invalidateTicket); password.addEventListener('input', invalidateTicket);
  async function action(work) {
    if (busy) return; busy = true; render(); status.textContent = t('privacy.working');
    try { await work(); }
    catch (error) {
      const detail = apiErrorInfo(error);
      if (!loaded) { summaryUnknown = true; renderSummary(); }
      if (['privacy.settings_changed', 'privacy.config_changed', 'privacy.settings_conflict'].includes(detail.code)) conflict = true;
      const keys = { 'privacy.regex_timeout': 'regexTimeout', 'privacy.regex_startup_timeout': 'regexTimeout', 'privacy.regex_invalid': 'regexInvalid', 'privacy.regex_empty_match': 'regexEmpty', 'privacy.regex_busy': 'regexBusy', 'privacy.regex_input_limit': 'regexLimit', 'privacy.regex_matches_limit': 'regexLimit', 'privacy.regex_rules_limit': 'regexLimit', 'privacy.preview_input_limit': 'regexLimit', 'privacy.json_sensitive_structure': 'jsonStructure', 'privacy.numeric_sensitive': 'numericSensitive', 'privacy.typed_sensitive': 'typedSensitive', 'privacy.encryption_required': 'encryptionRequired', 'privacy.plaintext_confirmation_required': 'plaintextRequired', 'credential_vault.unsupported': 'encryptionUnsupported', 'privacy.settings_changed': 'settingsChanged', 'privacy.config_changed': 'settingsChanged', 'privacy.settings_conflict': 'settingsChanged' };
      status.textContent = t(error instanceof SyntaxError ? 'privacy.rulesInvalid' : 'privacy.' + (detail.code === 'privacy.policy_unavailable' ? 'policyRecoveryRequired' : keys[detail.code] || 'failed'));
    } finally { busy = false; render(); }
  }
  async function load() {
    const [settings, state] = await Promise.all([api('/api/privacy/settings'), api('/api/privacy/status')]);
    summaryUnknown = false;
    const preserve = dirty(); supported = state.supported === true;
    liveSaved = { mode: settings.mode, technical: settings.technical, rules: settings.rules, encryption: settings.encryption === true, recoveryRequired: settings.recoveryRequired === true, ruleVersion: settings.ruleVersion };
    renderPrivacyIndicators({ privacyModeV1: settings.mode, credentialEncryptionV1: settings.encryption, privacyPolicyRecoveryRequiredV1: settings.recoveryRequired });
    if (!preserve) {
      saved = liveSaved; conflict = false;
      mode.value = saved.mode; technical.checked = saved.technical; rules.value = JSON.stringify(saved.rules, null, 2); encryption.checked = saved.encryption; manualEncryption = saved.encryption; confirmPlaintext.checked = false;
      editingRule = null; renderRuleList();
      clearTrial(); version.textContent = t('privacy.savedVersion') + ' ' + saved.ruleVersion; invalidateTicket();
    }
    renderSummary(); coverage.replaceChildren();
    for (const channel of state.channels || []) { const row = node('li'); row.textContent = t('privacy.channel.' + channel.id) + ' · ' + t(channel.supported ? 'privacy.supportedText' : 'privacy.blocked'); coverage.append(row); }
    loaded = true; render();
  }
  async function committed(message) {
    // A confirmed write and a failed follow-up fetch are different outcomes.
    saved = null; loaded = false;
    liveSaved = null; renderSummary(); renderPrivacyIndicators(null);
    try { await load(); await onSaved(); status.textContent = t('privacy.' + message); }
    catch { summaryUnknown = true; renderSummary(); renderPrivacyIndicators(null); status.textContent = t('privacy.savedRefreshFailed'); }
  }
  const save = button('save', 'privacySave', async () => {
    if (!loaded || !saved) return;
    const custom = JSON.parse(rules.value || '[]');
    await api('/api/privacy/settings', { method: 'POST', body: JSON.stringify({ mode: mode.value, technical: technical.checked, rules: custom, encryption: encryption.checked, confirmPlaintext: confirmPlaintext.checked, expectedRuleVersion: saved.ruleVersion, expectedEncryption: saved.encryption }) });
    await committed('saved');
  }); save.classList.add('primary');
  const reload = button('discardReload', 'privacyReload', async () => { saved = null; loaded = false; await load(); status.textContent = ''; });
  const trial = button('testRules', 'privacyTestRules', async () => {
    clearTrial(); const result = await api('/api/privacy/rules/test', { method: 'POST', body: JSON.stringify({ mode: mode.value, technical: technical.checked, rules: JSON.parse(rules.value || '[]'), sample: sample.value }) });
    output.textContent = result.protectedSample; version.textContent = t('privacy.trialVersion') + ' ' + result.ruleVersion;
    for (const match of result.matches) { const row = node('li'); row.textContent = [match.pointer || '/', match.start + '–' + match.end, match.category, match.ruleIds.join(', ')].join(' · '); hits.append(row); }
    status.textContent = t(result.matches.length ? 'privacy.tested' : 'privacy.noMatches');
  });
  const restore = button('restore', 'privacyRestore', async () => { const value = ticket; invalidateTicket(); await api('/api/privacy/backup/import', { method: 'POST', body: JSON.stringify({ ticket: value }) }); await committed('restored'); });
  const exportButton = button('export', 'privacyExport', async () => {
    const pass = password.value; password.value = ''; const response = await api('/api/privacy/backup/export', { method: 'POST', body: JSON.stringify({ password: pass }) });
    const url = URL.createObjectURL(new Blob([response.backup], { type: 'application/json' })); const link = node('a'); link.href = url; link.download = 'ruyi-credentials-recovery.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000); status.textContent = t('privacy.exported');
  });
  const previewButton = button('preview', 'privacyPreview', async () => {
    invalidateTicket(); const selected = file.files?.[0]; if (!selected || selected.size > 2 * 1024 * 1024) throw Error();
    const pass = password.value; password.value = ''; const response = await api('/api/privacy/backup/preview', { method: 'POST', body: JSON.stringify({ backup: await selected.text(), password: pass }) });
    file.value = ''; ticket = response.ticket; preview.append(node('p', 'mergeNotice'));
    for (const row of [...response.summary.providers, ...response.summary.connectors]) { const item = node('p'); item.textContent = [row.label, row.origin, row.command].filter(Boolean).join(' · '); preview.append(item); }
    if (response.summary.cli) preview.append(node('p', 'cli')); if (response.summary.search) preview.append(node('p', 'search'));
    status.textContent = t('privacy.previewReady');
  });
  const advanced = fold('advanced', 'privacyAdvanced');
  const builder = node('div', null, 'privacy-rule-builder'); const builderGrid = node('div', null, 'privacy-rule-grid');
  builderGrid.append(field('ruleKind', ruleKind), field('ruleCategory', ruleCategory), field('ruleValue', ruleValue), flagsRow);
  const builderActions = node('div', null, 'privacy-rule-actions'); builderActions.append(addRule, cancelEdit);
  builder.append(node('p', 'ruleBuilderHelp', 'field-help'), builderGrid, ruleKindHelp, builderActions);
  const exampleBox = fold('examplesTitle', 'privacyRuleExamples'); exampleBox.append(node('p', 'examplesHelp', 'field-help'));
  for (const example of examples) {
    const row = node('div', null, 'privacy-example'); const title = node('strong', 'example.' + example.id); const value = node('code'); value.textContent = example.value;
    const add = button('addExample', 'privacyAddExample-' + example.kind, async () => {
      const list = draftRules();
      if (list.some(rule => rule.kind === example.kind && rule.value === example.value && rule.category === example.category)) { status.textContent = t('privacy.exampleAlreadyAdded'); return; }
      list.push({ id: freshRuleId(list, 'example-' + example.id), kind: example.kind, value: example.value, category: example.category });
      writeRules(list); status.textContent = t('privacy.ruleDraftAdded');
    });
    row.append(title, value, node('p', 'exampleHelp.' + example.id, 'field-help'), add); exampleBox.append(row);
  }
  const rawRules = fold('rawRules', 'privacyRawRules'); rawRules.append(field('rules', rules), node('p', 'rulesHelp', 'field-help'));
  advanced.append(node('p', 'customScope', 'field-help'), ruleList, builder, exampleBox, rawRules);
  const trialExample = node('select'); trialExample.id = 'privacyTrialExample';
  for (const key of ['credentials', 'personal', ...examples.map(row => row.id)]) { const option = node('option', 'sampleExample.' + key); option.value = key; trialExample.append(option); }
  const fillExample = button('fillExample', 'privacyFillExample', async () => {
    sample.value = trialExample.value === 'credentials' ? 'API密钥：SYNTHETIC-DEMO-KEY-ONLY\npublic note stays visible.' : trialExample.value === 'personal' ? '邮箱：demo.person@example.test\n姓名：合成示例甲\npublic note stays visible.' : examples.find(row => row.id === trialExample.value).sample;
    clearTrial(); status.textContent = t('privacy.exampleFilled'); sample.focus();
  });
  const exampleToolbar = node('div', null, 'privacy-example-toolbar'); exampleToolbar.append(field('sampleExampleLabel', trialExample), fillExample);
  const trialFold = fold('trialTitle', 'privacyTrial'); trialFold.append(node('p', 'trialDraftHelp', 'field-help'), exampleToolbar, field('sample', sample), trial, output, hits);
  const channels = fold('compatibility', 'privacyCompatibility'); channels.append(node('p', 'nativeCoverage', 'field-help'), node('p', 'coverage', 'field-help'), coverage, node('p', 'sourceViews', 'field-help'), version);
  const backup = fold('backup', 'privacyBackup'); backup.append(node('p', 'backupHelp', 'field-help'), field('password', password), exportButton, field('file', file), previewButton, preview, restoreHint, restore);
  const savebar = node('div', null, 'privacy-savebar'); savebar.id = 'privacySavebar';
  const footerStatus = node('div', null, 'privacy-footer-status'); footerStatus.append(pending, status); savebar.append(footerStatus, reload, save);
  const footer = document.querySelector('#settingsModal .modal-foot'); footer.prepend(savebar);
  const securityTab = host.closest('.settings-tab');
  const footerVisibility = () => { const active = securityTab.classList.contains('active'); savebar.hidden = !active; footer.classList.toggle('privacy-footer-active', active); };
  new MutationObserver(footerVisibility).observe(securityTab, { attributes: true, attributeFilter: ['class'] }); footerVisibility();
  host.append(node('h4', 'title'), summary, recoveryNotice, mode, levels, dependency, platformNotice, check('technical', technical), check('encryptionToggle', encryption), encryptionState, plaintextRow, advanced, trialFold, channels, backup);
  const open = () => { if (!busy) void action(async () => { await load(); status.textContent = conflict ? t('privacy.settingsChanged') : ''; summary.tabIndex = -1; summary.focus({ preventScroll: true }); const body = document.getElementById('settingsBody'); if (body) body.scrollTop = 0; }); };
  document.querySelector('[data-stab="security"]')?.addEventListener('click', open);
  window.addEventListener('privacy:open', open);
  window.addEventListener('i18n:change', () => { renderSummary(); renderRuleList(); render(); renderPrivacyIndicators(); });
  renderSummary(); renderRuleList(); render(); if (securityTab.classList.contains('active')) open();
}
