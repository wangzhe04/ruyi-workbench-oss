import { api, apiErrorInfo, apiRaw } from './net.js';
import { t } from './i18n.js';

const panels = new WeakMap();
const OPERATIONS = ['enable', 'disable', 'export', 'restore'];
const STATES = ['queued', 'draining', 'preparing', 'ready', 'handoff', 'uncertain', 'cancel_requested', 'cancelled', 'failed'];
const TERMINAL = new Set(['cancelled', 'failed']);

export function mountWorkDataSettings() {
  const host = document.getElementById('workDataSettings');
  if (!host) return null;
  if (panels.has(host)) { const panel = panels.get(host); void panel.refresh(); return panel; }
  const node = (tag, key, className) => {
    const element = document.createElement(tag);
    if (key) { element.dataset.i18n = 'workData.' + key; element.textContent = t('workData.' + key); }
    if (className) element.className = className;
    return element;
  };
  const button = (key, id, handler) => { const element = node('button', key, 'btn btn-sm'); element.id = id; element.type = 'button'; element.addEventListener('click', handler); return element; };
  const field = (key, control) => { const row = node('div', null, 'field-block'), label = node('label', key); label.htmlFor = control.id; row.append(label, control); return row; };
  const input = (id, type = 'text') => { const element = node('input'); element.id = id; element.type = type; element.autocomplete = 'off'; element.spellcheck = false; return element; };
  host.classList.add('work-data-panel'); host.setAttribute('aria-labelledby', 'workDataHeading');
  const heading = node('h4', 'title', 'settings-subhead'); heading.id = 'workDataHeading';
  const summary = node('div', null, 'work-data-summary'); summary.id = 'workDataSummary'; summary.setAttribute('role', 'status'); summary.setAttribute('aria-live', 'polite');
  const scope = node('details', null, 'work-data-scope'); scope.append(node('summary', 'scopeTitle'), node('p', 'scopeIncluded', 'field-help'), node('p', 'scopeExcluded', 'field-help'));
  const retained = node('p', 'retainedPlaintext', 'field-help work-data-retained');
  const form = node('form'); form.noValidate = true;
  const operation = node('select'); operation.id = 'workDataOperation';
  for (const value of OPERATIONS) { const option = node('option', 'operation.' + value); option.value = value; operation.append(option); }
  const backup = input('workDataBackupDirectory'); backup.readOnly = true;
  const pickBackup = button('chooseFolder', 'workDataPickBackup', () => void pickDirectory(backup));
  const backupRow = field('backupDirectory', backup); backupRow.append(pickBackup, node('p', 'backupDirectoryHelp', 'field-help'));
  const parent = input('workDataRestoreParent'); parent.readOnly = true;
  const pickParent = button('chooseFolder', 'workDataPickParent', () => void pickDirectory(parent));
  const parentRow = field('restoreParent', parent); parentRow.append(pickParent);
  const name = input('workDataRestoreName'); name.maxLength = 128;
  const restoreName = field('restoreName', name); restoreName.append(node('p', 'restoreNameHelp', 'field-help'));
  const upload = input('workDataRestoreFile', 'file'); upload.disabled = true; upload.accept = '.ruyi,.ruyi-backup,application/octet-stream';
  const uploadRow = field('restoreFile', upload);
  const restoreFields = node('div', null, 'work-data-restore'); restoreFields.append(parentRow, restoreName, uploadRow); restoreFields.hidden = true;
  const password = input('workDataPassword', 'password'), confirmation = input('workDataPasswordConfirm', 'password');
  for (const control of [password, confirmation]) { control.autocomplete = 'new-password'; control.maxLength = 1024; }
  const secretFields = node('div', null, 'field-row work-data-passwords'); secretFields.append(field('password', password), field('passwordConfirm', confirmation));
  const plaintext = input('workDataConfirmPlaintext', 'checkbox'), plaintextRow = node('label', null, 'check'); plaintextRow.append(plaintext, node('span', 'confirmPlaintext')); plaintextRow.hidden = true;
  const unavailable = node('p', null, 'field-help work-data-unavailable'); unavailable.id = 'workDataUnavailable'; unavailable.setAttribute('role', 'status');
  const notice = node('p', null, 'work-data-notice'); notice.id = 'workDataNotice'; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const progress = node('div', null, 'work-data-progress'); progress.id = 'workDataProgress'; progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
  const submit = button('operation.enable', 'workDataSubmit', event => { event.preventDefault(); void submitJob(); }); submit.type = 'submit';
  const reconnect = button('refresh', 'workDataRefresh', () => void refresh());
  const cancel = button('cancel', 'workDataCancel', () => void cancelJob());
  const download = button('downloadPackage', 'workDataDownload', () => void savePackage());
  const actions = node('div', null, 'work-data-actions'); actions.append(submit, cancel, reconnect, download);
  form.append(field('operationLabel', operation), backupRow, restoreFields, secretFields, node('p', 'passwordHelp', 'field-help'), plaintextRow, unavailable, notice, progress, actions);
  host.append(heading, summary, scope, retained, form);
  let current = null, job = null, lastResult = null, loading = false, writing = false, picking = false, downloading = false, unknownSubmission = false, stale = false, disposed = false, timer = null, reading = null, revision = 0, submittedAuthority = null, trackedId = null;
  const active = () => !!job && !TERMINAL.has(job.state);
  const validAuthority = value => value && Number.isSafeInteger(value.generation) && value.generation >= 0 && ['plain', 'encrypted'].includes(value.mode)
    && (value.id === null || /^[a-f0-9]{48}$/.test(value.id || '')) && (value.sha256 === null || /^[a-f0-9]{64}$/.test(value.sha256 || ''));
  const validJob = value => value && /^[a-f0-9]{48}$/.test(value.id || '') && OPERATIONS.includes(value.operation) && STATES.includes(value.state)
    && typeof value.cancellable === 'boolean' && typeof value.takeover === 'boolean' && value.retry === false;
  const errorCode = error => { const code = apiErrorInfo(error).code; return /^[a-zA-Z0-9_.-]{1,128}$/.test(code || '') ? code : 'net.disconnected'; };
  function report(error) { const code = errorCode(error); notice.textContent = t(code === 'net.disconnected' ? 'workData.disconnected' : 'workData.failed', { code }); notice.dataset.state = 'error'; }
  function blockedByCapability() {
    if (!current?.capabilities?.worker) return 'work_data_setup.worker_unavailable';
    // Export writes a backup directory; it never depended on a download endpoint.
    // Restore needs both a live worker and the one-shot upload sink: the package
    // itself is uploaded once before the job is created, so a missing upload
    // capability refuses the operation instead of inventing a ticket.
    if (operation.value === 'restore' && current?.capabilities?.upload !== true) return 'work_data_setup.restore_unavailable';
    return '';
  }
  function targetDirectory() {
    const value = name.value;
    if (!parent.value || !value || value === '.' || value === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(value) || /[ .]$/.test(value)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) return '';
    return parent.value.replace(/[\\/]+$/, '') + (parent.value.includes('\\') ? '\\' : '/') + value;
  }
  // A restore is only submittable with exactly one real, non-empty file: the
  // upload route rejects an empty or missing body before it issues a ticket.
  function selectedFile() {
    const files = upload.files;
    if (!files || typeof files.length !== 'number' || files.length !== 1) return null;
    const file = files[0];
    if (!file || typeof file !== 'object' || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 1) return null;
    return file;
  }
  function render() {
    summary.replaceChildren(node('span', stale ? 'lastKnownMode' : 'currentMode', 'work-data-eyebrow'));
    const mode = current?.authority?.mode, label = node('strong'); label.textContent = t('workData.mode.' + (mode || 'unknown')); summary.append(label);
    const saved = node('p', null, 'field-help'); saved.textContent = t('workData.' + (mode === 'encrypted' ? 'encryptedHelp' : mode === 'plain' ? 'plainHelp' : 'unknownHelp')); summary.append(saved); summary.dataset.mode = mode || 'unknown';
    const blocked = blockedByCapability(), disabled = !current || stale || loading || writing || picking || active() || unknownSubmission;
    for (const control of [operation, backup, pickBackup, parent, pickParent, name, password, confirmation, plaintext]) control.disabled = disabled;
    // Only the ordinary disabled state disables the file picker: the selected
    // File is a user-owned draft, and capability refusals are surfaced (and
    // enforced) on submit instead of silently throwing the choice away.
    upload.disabled = disabled;
    restoreFields.hidden = operation.value !== 'restore'; plaintextRow.hidden = operation.value !== 'disable';
    unavailable.hidden = !blocked; unavailable.textContent = blocked ? t('workData.unavailable', { code: blocked }) : '';
    submit.textContent = t('workData.operation.' + operation.value); submit.disabled = disabled || !!blocked || !backup.value
      || password.value.length < 12 || new TextEncoder().encode(password.value).length > 1024 || password.value.includes('\0')
      || password.value !== confirmation.value || operation.value === 'disable' && !plaintext.checked
      || operation.value === 'restore' && !targetDirectory()
      || operation.value === 'restore' && !selectedFile()
      || operation.value === 'enable' && mode === 'encrypted' || operation.value === 'disable' && mode === 'plain';
    cancel.hidden = !active(); cancel.disabled = writing || !job?.cancellable || job?.takeover === true;
    reconnect.disabled = loading || writing;
    // One action for the one current result. It is offered only when the service
    // advertises the transfer and a verified result exists, and every state that
    // makes the receipt stale disables it instead of guessing.
    const downloadable = !downloading && !!lastResult && /^[a-f0-9]{48}$/.test(lastResult.id || '') && current?.capabilities?.download === true;
    download.hidden = !lastResult; download.disabled = disabled || !downloadable;
    progress.replaceChildren();
    if (job) {
      const line = node('strong'); line.textContent = t('workData.job.' + job.state); progress.append(line);
      const help = node('p', null, 'field-help'); help.textContent = t(job.takeover || ['handoff', 'uncertain'].includes(job.state) ? 'workData.handoffHelp'
        : job.state === 'cancelled' ? 'workData.cancelledHelp' : job.state === 'failed' ? 'workData.failureHelp' : 'workData.drainHelp'); progress.append(help);
      if (job.error) { const code = node('code'); code.textContent = typeof job.error === 'string' && /^[\w.-]{1,128}$/.test(job.error) ? job.error : 'work_data_setup.job_failed'; progress.append(code); }
    } else if (lastResult) progress.append(node('p', 'lastReceipt', 'field-help'));
    progress.hidden = !job && !lastResult;
  }
  function schedule() {
    if (timer) clearTimeout(timer); timer = null;
    if (!disposed && (active() || unknownSubmission)) timer = setTimeout(() => { timer = null; void refresh(); }, 1500);
  }
  async function refresh() {
    if (disposed) return;
    if (reading) return reading;
    loading = true; render();
    const version = revision;
    reading = (async () => {
      try {
        const result = await api('/api/work-data/status');
        if (version !== revision || disposed) return;
        if (!result?.ok || !validAuthority(result.authority) || result.job !== null && !validJob(result.job)) throw { code: 'work_data_setup.status_invalid' };
        current = result; lastResult = result.lastResult;
        if (result.job) { job = result.job; trackedId = job.id; }
        else if (!trackedId || lastResult?.id === trackedId) job = null;
        if (result.job || unknownSubmission && (submittedAuthority !== JSON.stringify(result.authority)
          || trackedId && lastResult?.id === trackedId)) unknownSubmission = false;
        if (job && active()) {
          const status = await api('/api/work-data/jobs/' + job.id);
          if (version !== revision || disposed) return;
          if (!status?.ok || !validJob(status.job) || status.job.id !== job.id) throw { code: 'work_data_setup.status_invalid' };
          job = status.job;
        }
        stale = false;
        if (!unknownSubmission) { notice.textContent = ''; notice.dataset.state = ''; }
      } catch (error) { stale = true; report(error); }
      finally { reading = null; loading = false; render(); schedule(); }
    })();
    return reading;
  }
  async function pickDirectory(control) {
    if (picking || writing || active() || unknownSubmission) return;
    picking = true; render();
    try { const result = await api('/api/pick-folder', { method: 'POST', body: '{}' }); if (result?.ok && typeof result.path === 'string') control.value = result.path; }
    catch (error) { report(error); }
    finally { picking = false; render(); }
  }
  // One upload, then one job. The upload goes through apiRaw so the package is
  // sent as verbatim bytes (content-type: application/octet-stream) and, with
  // noTokenReplay, a 403 token refresh can never silently retransmit it.
  // A non-2xx body is the only place a typed refusal code can come from; a
  // success without a 48-hex ticket is treated like a lost response.
  async function uploadPackage(file) {
    const res = await apiRaw('/api/work-data/uploads', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file, noTokenReplay: true });
    let value = null;
    try { value = await res.json(); } catch { value = null; }
    if (res.ok && value?.ok === true && /^[a-f0-9]{48}$/.test(value.uploadId || '')) return value.uploadId;
    throw { code: value?.error?.code || 'work_data_setup.status_invalid', status: res.status };
  }
  // The one current result, saved by the browser as its original bytes. The route
  // is the record's own id; a non-2xx body is the only source of a typed refusal.
  // Nothing about the package path, password or name is written to the DOM.
  async function savePackage() {
    const result = lastResult;
    if (downloading || writing || loading || stale || active() || unknownSubmission) return;
    if (!result || !/^[a-f0-9]{48}$/.test(result.id || '') || current?.capabilities?.download !== true) return;
    downloading = true; render();
    try {
      const res = await apiRaw('/api/work-data/results/' + result.id + '/package', { method: 'GET' });
      if (!res.ok) {
        let value = null;
        try { value = await res.json(); } catch { value = null; }
        throw { code: value?.error?.code || 'work_data_setup.package_unavailable', status: res.status };
      }
      const blob = await res.blob();
      const expected = Number.isSafeInteger(result.backup?.bytes) ? result.backup.bytes : null;
      if (expected !== null && blob.size !== expected) throw { code: 'work_data_setup.package_unavailable' };
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url; link.download = 'ruyi-work-data-' + result.id + '.ruyi-backup'; link.rel = 'noopener'; link.hidden = true;
      if (document.body && typeof document.body.append === 'function') document.body.append(link);
      link.click();
      if (typeof link.remove === 'function') link.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch { /* already released */ } }, 1000);
      notice.textContent = t('workData.packageSaved'); notice.dataset.state = 'ok';
    } catch (error) { report(error); }
    finally { downloading = false; render(); }
  }
  async function submitJob() {
    render(); if (submit.disabled || writing) return;
    const restoring = operation.value === 'restore', file = restoring ? selectedFile() : null;
    if (restoring && !file) return;
    writing = true; revision++; submittedAuthority = JSON.stringify(current.authority); trackedId = null;
    const secret = password.value, target = restoring ? targetDirectory() : '';
    const payload = { operation: operation.value, expectedAuthority: { ...current.authority }, backupDirectory: backup.value,
      ...(operation.value === 'disable' ? { confirmPlaintext: true } : {}) };
    let options = null;
    job = null;
    password.value = ''; confirmation.value = ''; plaintext.checked = false;
    notice.textContent = t('workData.submitting'); render();
    try {
      if (restoring) { payload.targetDirectory = target; payload.uploadId = await uploadPackage(file); }
      // Job writes are one-way receipts too: no token-refresh replay.
      payload.password = secret;
      options = { method: 'POST', body: JSON.stringify(payload), noTokenReplay: true }; payload.password = '';
      const result = await api('/api/work-data/jobs', options);
      if (!result?.ok || !validJob(result.job)) { unknownSubmission = true; throw { code: 'work_data_setup.status_invalid' }; }
      job = result.job; trackedId = job.id; unknownSubmission = false; notice.textContent = '';
    } catch (error) {
      // Only an explicit HTTP 4xx refusal proves that this request was rejected.
      // A 5xx, lost response or malformed success body can follow acceptance —
      // and neither the upload nor the job is ever sent a second time here.
      if (!(Number.isInteger(error?.status) && error.status >= 400 && error.status < 500)) unknownSubmission = true;
      report(error);
    }
    finally { if (options) options.body = ''; writing = false; render(); schedule(); }
  }
  async function cancelJob() {
    if (writing || !active() || job.cancellable !== true || job.takeover === true) return;
    writing = true; revision++; job = { ...job, cancellable: false }; render();
    try {
      // Cancel is a one-way receipt as well: never replayed after a token refresh.
      const result = await api('/api/work-data/jobs/' + job.id + '/cancel', { method: 'POST', body: '{}', noTokenReplay: true });
      if (!result?.ok || !validJob(result.job) || result.job.id !== job.id) throw { code: 'work_data_setup.status_invalid' };
      job = result.job;
    } catch (error) { report(error); }
    finally { writing = false; render(); schedule(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void submitJob(); });
  for (const control of [operation, password, confirmation, plaintext, name]) control.addEventListener('input', () => { notice.textContent = ''; render(); });
  // File pickers fire change, not input: without this the submit gate would keep
  // the state it rendered before the package was chosen.
  upload.addEventListener('change', () => { notice.textContent = ''; render(); });
  operation.addEventListener('change', () => { password.value = ''; confirmation.value = ''; plaintext.checked = false; render(); });
  const translate = () => { for (const element of host.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n); render(); };
  window.addEventListener('i18n:change', translate);
  const controller = Object.freeze({ refresh, dispose() { disposed = true; if (timer) clearTimeout(timer); password.value = ''; confirmation.value = ''; window.removeEventListener('i18n:change', translate); } });
  panels.set(host, controller); void refresh(); return controller;
}
