import { api, apiErrorInfo, apiRaw } from './net.js';
import { t } from './i18n.js';
import { apiErrorCopyKey } from './api-error-i18n.js';
import { fmtBytes } from './util.js';

const panels = new WeakMap();
const OPERATIONS = ['enable', 'disable', 'export', 'restore'];
const STATES = ['queued', 'draining', 'preparing', 'ready', 'handoff', 'uncertain', 'cancel_requested', 'cancelled', 'failed'];
const TERMINAL = new Set(['cancelled', 'failed']);
// 151 阶段 1 · W10/U3：任务说明按【状态】选，不按 takeover。冷端只读服务对交接后的作业一律报 takeover:true，
// 修前 failed 也显示「请等待新进程」；现在 handoff / uncertain / 交接后失败 / 交接前失败各说各的。
export function workDataJobHelpKey(job) {
  if (!job) return '';
  if (job.state === 'handoff') return 'workData.handoffHelp';
  if (job.state === 'uncertain') return 'workData.uncertainHelp';
  if (job.state === 'failed') return job.takeover === true ? 'workData.failedAfterHandoffHelp' : 'workData.failureHelp';
  if (job.state === 'cancelled') return 'workData.cancelledHelp';
  return job.takeover === true ? 'workData.handoffHelp' : 'workData.drainHelp';
}
// processRestartRequired：这类操作靠换进程收尾。结果没法在本进程里确认时（uncertain、交接后失败、或答话的已是
// 退休的冷端维护进程且不在交接中），明确告诉用户要重启如意。
export function workDataRestartRequired(status, job) {
  if (!status || status.processRestartRequired !== true || !job) return false;
  if (job.state === 'uncertain' || (job.state === 'failed' && job.takeover === true)) return true;
  return status.maintenance?.phase === 'retired' && job.state !== 'handoff';
}
// 151 阶段 1E（150 号文 W10 子项）：外层失败码（如 preparation_failed）只说「哪一段没做完」，冷端在 job.reason 里带上
// cause 链里更具体的那一枚码（13am failureReason），空间不足时另带需要/可用字节数。这里把它说成人话；没有专属文案的
// 原因码照原样给出（它本身就是稳定码），形状不对就不说。
export function workDataJobCause(job, errorCode) {
  const reason = job && typeof job.reason === 'string' && /^work_data(?:_[a-z0-9]+)*\.[a-z0-9_.-]{1,96}$/.test(job.reason) && job.reason !== errorCode ? job.reason : '';
  if (!reason) return '';
  const key = apiErrorCopyKey(reason);
  let text = t('workData.causeLine', { reason: key ? t(key) : reason });
  const detail = job.reasonDetail, decimal = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
  if (detail && decimal(detail.requiredBytes) && decimal(detail.availableBytes)) {
    text += ' ' + t('workData.causeSpace', { required: fmtBytes(Number(detail.requiredBytes)), available: fmtBytes(Number(detail.availableBytes)) });
  }
  return text;
}
// 151 阶段 3B · W14：维护准备期（draining）谁在阻塞、多少、等了多久；超时失败后同一份快照留在作业上。
// 只认后台给的已知种类（13ah BLOCKER_KINDS 加 requests/writes/pendingWrites/other），形状不对就不说。
const BLOCKER_KINDS = new Set(['turns', 'agentRuns', 'scheduler', 'steward', 'externalBots', 'consumers', 'internalMcp', 'index', 'shells', 'services',
  'helperRequests', 'requests', 'writes', 'pendingWrites', 'other']);
export function workDataDrainLines(job) {
  const drain = job && job.drain && typeof job.drain === 'object' ? job.drain : null;
  if (!drain || !Number.isSafeInteger(drain.waitedMs) || drain.waitedMs < 0 || !Number.isSafeInteger(drain.limitMs) || drain.limitMs <= 0) return null;
  const seconds = value => Math.max(0, Math.round(value / 1000));
  const rows = Array.isArray(drain.blockers) ? drain.blockers.filter(row => row && BLOCKER_KINDS.has(row.kind) && Number.isSafeInteger(row.count) && row.count > 0) : [];
  return {
    waited: t(drain.timedOut === true ? 'workData.drainTimedOut' : 'workData.drainWaited', { waited: seconds(drain.waitedMs), limit: seconds(drain.limitMs) }),
    blockers: rows.map(row => t('workData.blocker.' + row.kind, { count: row.count })),
    none: rows.length ? '' : t('workData.blockerNone'),
  };
}
// 150 W2：备份包只在需要它的操作里校验。状态里只带一次 lstat 的观察：被移走/删掉/替换时说人话，并指向「放回原处或重新导出」。
export function workDataBackupNoticeKey(lastResult) {
  const state = lastResult && typeof lastResult.backupState === 'string' ? lastResult.backupState : '';
  return state === 'missing' ? 'workData.backupMissing' : state === 'changed' ? 'workData.backupChanged' : state === 'unavailable' ? 'workData.backupUnavailable' : '';
}
// 只有确知包不在（missing）或已被替换（changed）才停用保存；查不清（unavailable）时照样可以点，下载那一步会在打开的句柄上再核对。
export function workDataBackupBlocksSave(lastResult) {
  const state = lastResult && typeof lastResult.backupState === 'string' ? lastResult.backupState : '';
  return state === 'missing' || state === 'changed';
}
// 码 → 人话（仍带着码，便于对照）；没有专属文案的码沿用原来那句带码的通用话。
function codeText(code, fallbackKey) {
  const key = apiErrorCopyKey(code);
  return key ? t('workData.errorReason', { reason: t(key), code }) : t(fallbackKey, { code });
}

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
  const uploadHelp = node('p', null, 'field-help'); uploadHelp.id = 'workDataRestoreFileHelp';
  upload.setAttribute('aria-describedby', uploadHelp.id);
  const uploadRow = field('restoreFile', upload); uploadRow.append(uploadHelp);
  const targetPreview = node('p', null, 'field-help work-data-notice'); targetPreview.id = 'workDataRestoreTarget';
  const confirmRestore = input('workDataConfirmRestore', 'checkbox'), restoreConfirmation = node('label', null, 'check');
  restoreConfirmation.append(confirmRestore, node('span', 'confirmRestore'));
  const restoreFields = node('div', null, 'work-data-restore'); restoreFields.append(uploadRow, parentRow, restoreName, targetPreview, restoreConfirmation); restoreFields.hidden = true;
  const password = input('workDataPassword', 'password'), confirmation = input('workDataPasswordConfirm', 'password');
  for (const control of [password, confirmation]) { control.autocomplete = 'new-password'; control.maxLength = 1024; }
  const secretFields = node('div', null, 'field-row work-data-passwords'); secretFields.append(field('password', password), field('passwordConfirm', confirmation));
  const passwordHelp = node('p', 'passwordHelp', 'field-help');
  const plaintext = input('workDataConfirmPlaintext', 'checkbox'), plaintextRow = node('label', null, 'check'); plaintextRow.append(plaintext, node('span', 'confirmPlaintext')); plaintextRow.hidden = true;
  const unavailable = node('p', null, 'field-help work-data-unavailable'); unavailable.id = 'workDataUnavailable'; unavailable.setAttribute('role', 'status');
  const notice = node('p', null, 'work-data-notice'); notice.id = 'workDataNotice'; notice.tabIndex = -1; notice.setAttribute('role', 'status'); notice.setAttribute('aria-live', 'polite');
  const progress = node('div', null, 'work-data-progress'); progress.id = 'workDataProgress'; progress.tabIndex = -1; progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
  const submit = button('operation.enable', 'workDataSubmit', event => { event.preventDefault(); void submitJob(); }); submit.type = 'submit';
  const reconnect = button('refresh', 'workDataRefresh', () => void refresh());
  const cancel = button('cancel', 'workDataCancel', () => void cancelJob());
  const download = button('downloadPackage', 'workDataDownload', () => void savePackage());
  const clear = button('clearDraft', 'workDataClearDraft', () => { if (clear.disabled) return; clearSecrets(); upload.value = ''; confirmRestore.checked = false; notice.textContent = ''; render(); });
  const actions = node('div', null, 'work-data-actions'); actions.append(submit, cancel, reconnect, download, clear);
  const restartNotice = node('p', 'restartNotice', 'field-help work-data-restart-notice'); restartNotice.id = 'workDataRestartNotice'; restartNotice.hidden = true;
  // 151 阶段 3B · W14：启用加密前的二次确认。点「启用加密」只打开这一段；口令留在输入框里直到「确认启用」才提交并清空。
  // 键盘：打开时焦点落在「返回修改」（按住或连按 Enter 只会退回，不会误启用），Tab 可到「确认启用」，Esc 等同返回并把焦点还给提交按钮。
  const confirmBox = node('div', null, 'work-data-confirm'); confirmBox.id = 'workDataConfirm'; confirmBox.hidden = true;
  confirmBox.setAttribute('role', 'alertdialog'); confirmBox.setAttribute('aria-labelledby', 'workDataConfirmTitle'); confirmBox.setAttribute('aria-describedby', 'workDataConfirmBody');
  const confirmTitle = node('strong', 'confirmEnableTitle'); confirmTitle.id = 'workDataConfirmTitle';
  const confirmBody = node('ul', null, 'field-help'); confirmBody.id = 'workDataConfirmBody';
  for (const key of ['confirmEnablePause', 'confirmEnablePassword', 'confirmEnableRetained']) confirmBody.append(node('li', key));
  // 确认后这段收起：焦点交给提示行（它马上报「正在提交」，之后报回执或错误），不掉到 body 上。
  const confirmGo = button('confirmEnableGo', 'workDataConfirmGo', () => { if (!confirming) return; closeConfirm(false); void submitJob(true); focus(notice); });
  const confirmBack = button('confirmEnableBack', 'workDataConfirmBack', () => closeConfirm(true));
  const confirmActions = node('div', null, 'work-data-actions'); confirmActions.append(confirmGo, confirmBack);
  confirmBox.append(confirmTitle, confirmBody, confirmActions);
  // Esc 只关这一段确认，不能冒泡上去把整个设置弹窗也关掉（设置弹窗自己也听 Esc）。
  confirmBox.addEventListener('keydown', event => {
    if (!event || event.key !== 'Escape' || !confirming) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    closeConfirm(true);
  });
  form.append(field('operationLabel', operation), backupRow, restoreFields, secretFields, passwordHelp, plaintextRow, restartNotice, unavailable, notice, progress, confirmBox, actions);
  host.append(heading, summary, scope, retained, form);
  let current = null, job = null, lastResult = null, loading = false, writing = false, picking = false, downloading = false, unknownSubmission = false, stale = false, disposed = false, timer = null, reading = null, revision = 0, submittedAuthority = null, trackedId = null;
  let pendingRestore = null, restoreServing = null, confirming = false;
  const active = () => !!job && !TERMINAL.has(job.state);
  const focus = element => { try { if (element && typeof element.focus === 'function') element.focus(); } catch { /* focus is a convenience */ } };
  const confirmOpenForUser = () => { try { return typeof document.activeElement !== 'undefined' && !!document.activeElement && confirmBox.contains(document.activeElement); } catch { return false; } };
  function openConfirm() { confirming = true; render(); focus(confirmBack); }
  function closeConfirm(returnFocus) { const was = confirming; confirming = false; render(); if (was && returnFocus) focus(submit); }
  const validAuthority = value => value && Number.isSafeInteger(value.generation) && value.generation >= 0 && ['plain', 'encrypted'].includes(value.mode)
    && (value.id === null || /^[a-f0-9]{48}$/.test(value.id || '')) && (value.sha256 === null || /^[a-f0-9]{64}$/.test(value.sha256 || ''));
  const validJob = value => value && /^[a-f0-9]{48}$/.test(value.id || '') && OPERATIONS.includes(value.operation) && STATES.includes(value.state)
    && typeof value.cancellable === 'boolean' && typeof value.takeover === 'boolean' && value.retry === false;
  const retireRestore = candidate => {
    if (pendingRestore && candidate && (candidate.id !== pendingRestore.id || candidate.operation !== 'restore' || TERMINAL.has(candidate.state))) pendingRestore = null;
  };
  const errorCode = error => { const code = apiErrorInfo(error).code; return /^[a-zA-Z0-9_.-]{1,128}$/.test(code || '') ? code : 'net.disconnected'; };
  function report(error) { const code = errorCode(error); notice.textContent = code === 'net.disconnected' ? t('workData.disconnected', { code }) : codeText(code, 'workData.failed'); notice.dataset.state = 'error'; }
  function blockedByCapability() {
    if (!current?.capabilities?.worker) return 'work_data_setup.worker_unavailable';
    // Export writes a backup directory; it never depended on a download endpoint.
    // Restore needs both a live worker and the one-shot upload sink: the package
    // itself is uploaded once before the job is created, so a missing upload
    // capability refuses the operation instead of inventing a ticket.
    if (operation.value === 'restore' && (current?.capabilities?.upload !== true || !uploadMaximum())) return 'work_data_setup.restore_unavailable';
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
    return file.size <= uploadMaximum() ? file : null;
  }
  function uploadMaximum() { return Number.isSafeInteger(current?.uploadMaxBytes) && current.uploadMaxBytes > 0 ? current.uploadMaxBytes : 0; }
  // Target names come from an absolute directory-picker receipt plus one leaf.
  // Compare only exact roots; a child generation or a shared prefix is no proof.
  function rootKey(value) {
    if (typeof value !== 'string' || !value || /[\x00-\x1f]/.test(value) || /^[\\/]{2}/.test(value)) return '';
    const windows = /^[a-z]:[\\/]/i.test(value);
    if (!windows && !value.startsWith('/')) return '';
    const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = normalized.slice(windows ? 3 : 1).split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || windows && /[ .]$/.test(part))) return '';
    return windows ? normalized.toLowerCase() : normalized;
  }
  function clearSecrets() { password.value = ''; confirmation.value = ''; plaintext.checked = false; }
  function render() {
    summary.replaceChildren(node('span', stale ? 'lastKnownMode' : 'currentMode', 'work-data-eyebrow'));
    const mode = current?.authority?.mode, label = node('strong'); label.textContent = t('workData.mode.' + (mode || 'unknown')); summary.append(label);
    const saved = node('p', null, 'field-help'); saved.textContent = t('workData.' + (mode === 'encrypted' ? 'encryptedHelp' : mode === 'plain' ? 'plainHelp' : 'unknownHelp')); summary.append(saved); summary.dataset.mode = mode || 'unknown';
    const blocked = blockedByCapability(), busy = !current || stale || writing || picking || active() || unknownSubmission;
    // The confirmation belongs to the form exactly as it stood when it opened: any state that would refuse the submit closes it.
    // 151 阶段 3B 复审建议 5：表单变忙而自动收起确认段时，焦点若还在段里，挪到看得见的状态区（进度区，否则提示行），不掉到 body。
    let refocus = false;
    if (confirming && (busy || operation.value !== 'enable')) { refocus = confirmOpenForUser(); confirming = false; }
    confirmBox.hidden = !confirming; confirmGo.disabled = !confirming || loading; confirmBack.disabled = !confirming;
    const disabled = busy || loading || confirming;
    for (const control of [operation, backup, pickBackup, parent, pickParent, name, password, confirmation, plaintext, confirmRestore]) control.disabled = disabled;
    // Only the ordinary disabled state disables the file picker: the selected
    // File is a user-owned draft, and capability refusals are surfaced (and
    // enforced) on submit instead of silently throwing the choice away.
    upload.disabled = disabled;
    restoreFields.hidden = operation.value !== 'restore'; plaintextRow.hidden = operation.value !== 'disable';
    passwordHelp.dataset.i18n = operation.value === 'restore' ? 'workData.restorePasswordHelp' : 'workData.passwordHelp';
    passwordHelp.textContent = t(passwordHelp.dataset.i18n);
    const maximum = uploadMaximum();
    uploadHelp.textContent = t('workData.restoreFileHelp', { bytes: maximum });
    if (upload.files?.length && !selectedFile()) uploadHelp.textContent = t('workData.restoreFileInvalid', { bytes: maximum });
    targetPreview.textContent = t('workData.restoreTarget', { target: targetDirectory() || t('workData.restoreTargetMissing') });
    unavailable.hidden = !blocked; unavailable.textContent = blocked ? codeText(blocked, 'workData.unavailable') : '';
    restartNotice.hidden = current?.processRestartRequired !== true || stale || active();
    submit.textContent = t('workData.operation.' + operation.value); submit.disabled = disabled || !!blocked || !backup.value
      || password.value.length < 12 || new TextEncoder().encode(password.value).length > 1024 || password.value.includes('\0')
      || password.value !== confirmation.value || operation.value === 'disable' && !plaintext.checked
      || operation.value === 'restore' && !targetDirectory()
      || operation.value === 'restore' && !selectedFile()
      || operation.value === 'restore' && !confirmRestore.checked
      || operation.value === 'enable' && mode === 'encrypted' || operation.value === 'disable' && mode === 'plain';
    cancel.hidden = !active(); cancel.disabled = writing || !job?.cancellable || job?.takeover === true;
    reconnect.disabled = loading || writing;
    clear.disabled = disabled;
    // One action for the one current result. It is offered only when the service
    // advertises the transfer and a verified result exists, and every state that
    // makes the receipt stale disables it instead of guessing.
    const backupNotice = workDataBackupNoticeKey(lastResult);
    const downloadable = !downloading && !!lastResult && /^[a-f0-9]{48}$/.test(lastResult.id || '') && current?.capabilities?.download === true && !workDataBackupBlocksSave(lastResult);
    download.hidden = !lastResult; download.disabled = disabled || !downloadable;
    progress.replaceChildren();
    if (job) {
      const line = node('strong'); line.textContent = t('workData.job.' + job.state); progress.append(line);
      const help = node('p', null, 'field-help'); help.textContent = t(workDataJobHelpKey(job)); progress.append(help);
      const drain = (job.state === 'draining' || job.error === 'work_data_setup.drain_timeout') ? workDataDrainLines(job) : null;
      if (drain) {
        const waited = node('p', null, 'field-help work-data-drain'); waited.id = 'workDataDrainWaited'; waited.textContent = drain.waited; progress.append(waited);
        if (drain.blockers.length) {
          const list = node('ul', null, 'field-help work-data-blockers'); list.id = 'workDataDrainBlockers';
          for (const text of drain.blockers) { const item = node('li'); item.textContent = text; list.append(item); }
          progress.append(list);
        } else { const none = node('p', null, 'field-help'); none.textContent = drain.none; progress.append(none); }
      }
      if (job.error) {
        const value = typeof job.error === 'string' && /^[\w.-]{1,128}$/.test(job.error) ? job.error : 'work_data_setup.job_failed';
        const reasonKey = apiErrorCopyKey(value);
        if (reasonKey) { const reason = node('p', null, 'field-help work-data-reason'); reason.textContent = t(reasonKey); progress.append(reason); }
        const cause = workDataJobCause(job, value);
        if (cause) { const line = node('p', null, 'field-help work-data-cause'); line.textContent = cause; progress.append(line); }
        const code = node('code'); code.textContent = value + (cause ? ' · ' + job.reason : ''); progress.append(code);
      }
      if (workDataRestartRequired(current, job)) { const restart = node('p', 'restartRequired', 'work-data-restart'); restart.setAttribute('role', 'alert'); progress.append(restart); }
    } else if (restoreServing && !stale && rootKey(current?.selectedBase) === rootKey(restoreServing.target)) {
      const line = node('strong'); line.textContent = t('workData.restoreServing'); progress.append(line);
      const help = node('p', null, 'field-help'); help.textContent = t('workData.restoreServingHelp', { target: restoreServing.target }); progress.append(help);
    } else if (lastResult) {
      progress.append(node('p', 'lastReceipt', 'field-help'));
      if (lastResult.operation === 'restore' && lastResult.state === 'verified' && typeof lastResult.restored?.target === 'string') {
        const result = node('p', null, 'field-help'); result.textContent = t('workData.restoreVerified', { target: lastResult.restored.target }); progress.append(result);
      }
      if (backupNotice) { const line = node('p', backupNotice.slice('workData.'.length), 'field-help work-data-notice'); line.id = 'workDataBackupNotice'; progress.append(line); }
    } else if (!stale && typeof current?.lastResultError === 'string' && /^work_data(?:_[a-z0-9]+)*\.[a-z0-9_.-]{1,96}$/.test(current.lastResultError)) {
      // 150 W2：回执读不出来不再让整面板失效；说明这一句，其余操作照常可用。
      const line = node('p', null, 'field-help work-data-notice'); line.id = 'workDataResultNotice';
      // 「不影响其他操作」只对单纯读不出回执（result_unavailable）成立；其他码（例如来源已不确定）按码自己的说明讲。
      line.textContent = current.lastResultError === 'work_data_setup.result_unavailable'
        ? t('workData.lastResultUnreadable', { code: current.lastResultError }) : codeText(current.lastResultError, 'workData.unavailable');
      progress.append(line);
    }
    progress.hidden = progress.children.length === 0;
    if (refocus) focus(progress.hidden ? notice : progress);
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
        retireRestore(result.job);
        // The successor's selected base proves that this submitted target is
        // serving. Its lastResult can be absent or package history: neither is
        // the source's durable receipt for this restore.
        if (pendingRestore && rootKey(result.selectedBase) && rootKey(result.selectedBase) === rootKey(pendingRestore.target)) {
          restoreServing = { target: pendingRestore.target }; pendingRestore = null;
          job = null; trackedId = null; unknownSubmission = false;
        }
        if (result.job) { job = result.job; trackedId = job.id; }
        else if (!trackedId || lastResult?.id === trackedId) job = null;
        if (result.job || unknownSubmission && (submittedAuthority !== JSON.stringify(result.authority)
          || trackedId && lastResult?.id === trackedId)) unknownSubmission = false;
        if (job && active()) {
          const status = await api('/api/work-data/jobs/' + job.id);
          if (version !== revision || disposed) return;
          if (!status?.ok || !validJob(status.job) || status.job.id !== job.id) throw { code: 'work_data_setup.status_invalid' };
          retireRestore(status.job);
          job = status.job;
        }
        stale = false;
        if (!unknownSubmission) { notice.textContent = ''; notice.dataset.state = ''; }
        // 维护期输入框闸门（app.js 的 work-data-maintenance-gate）从这里拿到同一份已校验的状态，不再自己多轮询一路。
        if (typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('workdata:status', { detail: { maintenance: current.maintenance || null, job, processRestartRequired: current.processRestartRequired === true } }));
        }
      } catch (error) { stale = true; report(error); }
      finally { reading = null; loading = false; render(); schedule(); }
    })();
    return reading;
  }
  async function pickDirectory(control) {
    if (picking || writing || active() || unknownSubmission) return;
    picking = true; render();
    try { const result = await api('/api/pick-folder', { method: 'POST', body: '{}' }); if (result?.ok && typeof result.path === 'string') { control.value = result.path; if (control === parent || control === backup) confirmRestore.checked = false; } }
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
  async function submitJob(confirmed = false) {
    render(); if (submit.disabled || writing) return;
    // 151 阶段 3B · W14：启用加密先过二次确认；确认这一下才真正提交，取消/Esc 不发任何请求、不清空口令。
    if (operation.value === 'enable' && confirmed !== true) { openConfirm(); return; }
    const restoring = operation.value === 'restore', file = restoring ? selectedFile() : null;
    if (restoring && !file) return;
    writing = true; revision++; submittedAuthority = JSON.stringify(current.authority); trackedId = null;
    pendingRestore = null; restoreServing = null;
    let secret = password.value; const target = restoring ? targetDirectory() : '';
    const payload = { operation: operation.value, expectedAuthority: { ...current.authority }, backupDirectory: backup.value,
      ...(operation.value === 'disable' ? { confirmPlaintext: true } : {}) };
    let options = null;
    job = null;
    clearSecrets(); confirmRestore.checked = false;
    notice.textContent = t(restoring ? 'workData.uploading' : 'workData.submitting'); render();
    try {
      if (restoring) { payload.targetDirectory = target; payload.uploadId = await uploadPackage(file); notice.textContent = t('workData.submitting'); }
      // Job writes are one-way receipts too: no token-refresh replay.
      payload.password = secret;
      options = { method: 'POST', body: JSON.stringify(payload), noTokenReplay: true }; payload.password = ''; secret = '';
      const result = await api('/api/work-data/jobs', options);
      if (!result?.ok || !validJob(result.job) || result.job.operation !== payload.operation) { unknownSubmission = true; throw { code: 'work_data_setup.status_invalid' }; }
      job = result.job; trackedId = job.id; unknownSubmission = false; notice.textContent = '';
      if (restoring && job.operation === 'restore') pendingRestore = { id: job.id, target };
    } catch (error) {
      // Only an explicit HTTP 4xx refusal proves that this request was rejected.
      // A 5xx, lost response or malformed success body can follow acceptance —
      // and neither the upload nor the job is ever sent a second time here.
      if (!(Number.isInteger(error?.status) && error.status >= 400 && error.status < 500)) unknownSubmission = true;
      report(error);
    }
    finally { secret = ''; payload.password = ''; if (options) options.body = ''; clearSecrets(); writing = false; render(); schedule(); }
  }
  async function cancelJob() {
    if (writing || !active() || job.cancellable !== true || job.takeover === true) return;
    clearSecrets(); writing = true; revision++; job = { ...job, cancellable: false }; render();
    try {
      // Cancel is a one-way receipt as well: never replayed after a token refresh.
      const result = await api('/api/work-data/jobs/' + job.id + '/cancel', { method: 'POST', body: '{}', noTokenReplay: true });
      if (!result?.ok || !validJob(result.job) || result.job.id !== job.id) throw { code: 'work_data_setup.status_invalid' };
      retireRestore(result.job);
      job = result.job;
    } catch (error) { report(error); }
    finally { writing = false; render(); schedule(); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); void submitJob(); });
  for (const control of [operation, password, confirmation, plaintext, name, confirmRestore]) control.addEventListener('input', () => { if (control === name) confirmRestore.checked = false; notice.textContent = ''; render(); });
  // File pickers fire change, not input: without this the submit gate would keep
  // the state it rendered before the package was chosen.
  upload.addEventListener('change', () => { confirmRestore.checked = false; notice.textContent = ''; render(); });
  operation.addEventListener('change', () => { clearSecrets(); confirmRestore.checked = false; render(); });
  const translate = () => { for (const element of host.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n); render(); };
  window.addEventListener('i18n:change', translate);
  // 设置页的后台刷新（refreshStatus → fillSettings → mountWorkDataSettings）也走这里：用户正在答（焦点在确认段里）时不打断；
  // 焦点已不在确认段（弹窗被整体关掉后重新打开）才收起上一次没答的确认，并把焦点还给提交按钮。
  const controller = Object.freeze({ refresh() { if (confirming && !confirmOpenForUser()) closeConfirm(true); return refresh(); }, dispose() { disposed = true; if (timer) clearTimeout(timer); clearSecrets(); upload.value = ''; confirmRestore.checked = false; window.removeEventListener('i18n:change', translate); } });
  panels.set(host, controller); void refresh(); return controller;
}
