import { api, apiErrorInfo, apiRaw } from './net.js';
import { t, getLocale } from './i18n.js';
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
// 150 W3：普查/打包超出工程预算时，冷端在 job.limitDetail 里带上种类、上限与已普查到的顶层区域（13am limitDetail）。
// 说清楚多大、主要在哪些区域、怎么办；形状不对就不说。
const LIMIT_KINDS = { entries: 'Entries', files: 'Files', directories: 'Directories', bytes: 'Bytes', 'file-bytes': 'FileBytes', transport: 'Transport', depth: 'Depth' };
export function workDataJobLimit(job) {
  const limit = job && job.limitDetail, decimal = value => typeof value === 'string' && /^\d{1,20}$/.test(value);
  if (!limit || !Object.hasOwn(LIMIT_KINDS, limit.kind) || !decimal(limit.maximum)) return [];
  const count = ['entries', 'files', 'directories', 'depth'].includes(limit.kind);
  const maximum = count ? Number(limit.maximum).toLocaleString(getLocale()) : fmtBytes(Number(limit.maximum));
  const lines = [t('workData.limit' + LIMIT_KINDS[limit.kind], { maximum })];
  const areas = Array.isArray(limit.areas) ? limit.areas.filter(row => row && typeof row.area === 'string' && /^[a-z0-9.-]{1,32}$/.test(row.area)
    && decimal(row.entries) && decimal(row.bytes)).slice(0, 5) : [];
  if (areas.length) lines.push(t('workData.limitAreas', { areas: areas.map(row => t('workData.limitArea', {
    area: row.area === 'other' ? t('workData.limitAreaOther') : row.area, entries: Number(row.entries).toLocaleString(getLocale()), bytes: fmtBytes(Number(row.bytes)) })).join(t('workData.limitAreaSeparator')) }));
  // 3C 审查 S6：「原数据根没有被改动」只在冷端判定为 failed（它只在确认操作没有执行时才报 failed，否则报 uncertain）时说；
  // 结果未确认时不替它下结论，只说怎么办。
  lines.push(t(job.state === 'failed' ? 'workData.limitAdvice' : 'workData.limitAdviceUnconfirmed'));
  return lines;
}
// 151 阶段 3G（150 W3/W4）：数据根体检（01ac inspect）的人话。每条判定按码取文案（workData.hygiene.<驼峰>），
// 数字按语言分位、字节走 fmtBytes，路径只取前 5 条（服务端最多给 20 条），认不得的码不说。
const HYGIENE_BYTES = new Set(['census_bytes_exceeded', 'census_file_bytes_exceeded', 'package_bytes_exceeded', 'package_serialized_exceeded']);
const HYGIENE_CODES = new Set(['inventory_truncated', 'census_entries_exceeded', 'census_files_exceeded', 'census_directories_exceeded', 'census_bytes_exceeded',
  'census_file_bytes_exceeded', 'census_depth_exceeded', 'package_files_exceeded', 'package_bytes_exceeded', 'package_serialized_exceeded', 'aliases_present',
  'hardlinks_present', 'unreadable_entries', 'active_pointer_invalid', 'leftovers_present', 'superseded_leftovers_present', 'quarantine_incomplete',
  'quarantine_record_invalid', 'quarantined_plaintext_present']);
const hygieneCamel = name => name.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
const hygieneCount = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString(getLocale()) : '?';
function hygienePaths(rows, total) {
  const list = Array.isArray(rows) ? rows.filter(value => typeof value === 'string' && value.length > 0 && value.length <= 1024).slice(0, 5) : [];
  if (!list.length) return '';
  const more = Number.isSafeInteger(total) && total > list.length ? total - list.length : 0;
  return t('workData.hygiene.paths', { paths: list.join(t('workData.limitAreaSeparator')) }) + (more ? t('workData.hygiene.pathsMore', { count: more.toLocaleString(getLocale()) }) : '');
}
export function workDataHygieneVerdictText(verdict) {
  const code = verdict && typeof verdict.code === 'string' ? verdict.code : '';
  const name = code.startsWith('work_data_hygiene.') ? code.slice('work_data_hygiene.'.length) : '';
  if (!HYGIENE_CODES.has(name)) return '';
  const params = verdict.params && typeof verdict.params === 'object' ? verdict.params : {};
  const amount = value => HYGIENE_BYTES.has(name) ? (Number.isSafeInteger(value) && value >= 0 ? fmtBytes(value) : '?') : hygieneCount(value);
  let text = t('workData.hygiene.' + hygieneCamel(name), { actual: amount(params.actual), limit: amount(params.limit), count: hygieneCount(params.count) });
  if (Number.isSafeInteger(params.bytes) && params.bytes >= 0 && ['leftovers_present', 'superseded_leftovers_present'].includes(name)) text += ' ' + t('workData.hygiene.leftoverSize', { count: hygieneCount(params.count), bytes: fmtBytes(params.bytes) });
  const areaPaths = Array.isArray(params.areas) ? params.areas.map(row => row && typeof row.path === 'string' ? row.path : row && typeof row.stamp === 'string' ? (row.root ? row.root + '/' : '') + 'quarantine-v1/' + row.stamp : '') : null;
  const paths = hygienePaths(Array.isArray(params.paths) ? params.paths : areaPaths, Number.isSafeInteger(params.count) ? params.count : undefined);
  return paths ? text + ' ' + paths : text;
}
// 预计能否启用/导出/停用：只按体检时的规模与形状判断，措辞是「预计」，实际以操作时冷端的检查为准。
export function workDataHygienePrediction(inspection, mode) {
  if (!inspection || typeof inspection !== 'object' || inspection.schema !== 1) return '';
  const which = mode === 'encrypted' ? 'Encrypted' : mode === 'plain' ? 'Plain' : 'Unknown';
  return t((inspection.ok === true ? 'workData.hygiene.predictOk' : 'workData.hygiene.predictBlocked') + which);
}
const HYGIENE_UNDOABLE = new Set(['moving', 'moved', 'partial', 'partially-restored']);
const HYGIENE_STATES = new Set(['moving', 'moved', 'rolled-back', 'partial', 'restored', 'partially-restored', 'incomplete', 'invalid', 'unknown', 'alias']);
const HYGIENE_SKIPS = new Set(['directory', 'hardlink', 'writer-alive', 'too-recent', 'name']);
const HYGIENE_REASONS = new Set(['quarantined-corrupt', 'crash-stage', 'archive-stage']);
// 操作失败后「文件现在在哪」：移入失败时只有 quarantine_recovery_required 与意外错误可能留下已移动的文件，其余拒绝都在移动前
// 或已全部移回；撤销只有在开始移回之前的拒绝才能断言「没有移动任何文件」。
const NOTHING_MOVED = { quarantine: new Set(['work_data_hygiene.plan_changed', 'work_data_hygiene.quarantine_conflict', 'work_data_hygiene.quarantine_alias',
  'work_data_hygiene.inventory_truncated', 'work_data_hygiene.base_invalid', 'work_data_hygiene.base_unavailable']),
  undo: new Set(['work_data_hygiene.request_invalid', 'work_data_hygiene.quarantine_unknown', 'work_data_hygiene.record_invalid', 'work_data_hygiene.base_invalid', 'work_data_hygiene.base_unavailable']) };
export function workDataHygieneOutcomeKey(kind, code, status) {
  const value = typeof code === 'string' ? code : '';
  // 请求在进入引擎之前就被拒（4xx 的工作数据维护码、鉴权、维护中）：什么都没动。
  if (/^work_data_setup\./.test(value) && value !== 'work_data_setup.status_invalid' || /^auth\./.test(value) || value === 'desktop_lifetime.closing' || NOTHING_MOVED[kind]?.has(value)) return 'workData.hygiene.outcomeNothingMoved';
  if (kind === 'quarantine' && value === 'work_data_hygiene.quarantine_recovery_required') return 'workData.hygiene.outcomeStuck';
  return Number.isInteger(status) && status >= 400 && status < 500 && !value.startsWith('work_data_hygiene.') ? 'workData.hygiene.outcomeNothingMoved' : 'workData.hygiene.outcomeUnknown';
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
  // 151 阶段 3G · U13：这两栏只能由「选择文件夹…」填写。修前它们长得和可输入的框一样、点进去却打不了字；现在画成只读样式、
  // 空着时写明「请点选择文件夹」，点它（或在它上面按 Enter/空格）就打开同一个选择器。
  const pathField = (id, help) => {
    const element = input(id); element.readOnly = true; element.classList.add('work-data-path');
    if (help) element.setAttribute('aria-describedby', help);
    const open = () => { if (!element.disabled) void pickDirectory(element); };
    element.addEventListener('click', open);
    element.addEventListener('keydown', event => { if (event && (event.key === 'Enter' || event.key === ' ')) { if (typeof event.preventDefault === 'function') event.preventDefault(); open(); } });
    return element;
  };
  const backupHelp = node('p', 'backupDirectoryHelp', 'field-help'); backupHelp.id = 'workDataBackupDirectoryHelp';
  const backup = pathField('workDataBackupDirectory', backupHelp.id);
  const pickBackup = button('chooseFolder', 'workDataPickBackup', () => void pickDirectory(backup));
  const backupRow = field('backupDirectory', backup); backupRow.append(pickBackup, backupHelp);
  const parent = pathField('workDataRestoreParent', '');
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
  // 151 阶段 3G · U13：提交按钮灰着时，在按钮上方说清楚还差什么（只说第一条）。
  const submitReason = node('p', null, 'field-help work-data-submit-reason'); submitReason.id = 'workDataSubmitReason'; submitReason.hidden = true;
  submit.setAttribute('aria-describedby', submitReason.id);
  form.append(field('operationLabel', operation), backupRow, restoreFields, secretFields, passwordHelp, plaintextRow, restartNotice, unavailable, notice, progress, confirmBox, submitReason, actions);
  // ── 151 阶段 3G（150 W3/W4）：数据根体检与残留文件 ─────────────────────────────────────────────
  // 「检查数据根」只读（13ah → 01ac inspect）；「移入隔离区…」先取计划、列出将移动的文件，用户在确认段里再确认一次才执行；
  // 每个隔离区有「撤销」。确认段的键盘行为与启用加密的确认一致：打开时焦点在「返回」，Esc 只关这一段并把焦点还给触发按钮。
  const hygiene = node('section', null, 'work-data-hygiene'); hygiene.id = 'workDataHygiene'; hygiene.setAttribute('aria-labelledby', 'workDataHygieneTitle');
  const hygieneTitle = node('h5', 'hygiene.title', 'settings-subhead'); hygieneTitle.id = 'workDataHygieneTitle';
  const hygieneHelp = node('p', 'hygiene.help', 'field-help');
  const inspectButton = button('hygiene.inspect', 'workDataHygieneInspect', () => void runInspect());
  const quarantineButton = button('hygiene.quarantine', 'workDataHygieneQuarantine', () => void openQuarantine()); quarantineButton.hidden = true;
  const hygieneActions = node('div', null, 'work-data-actions'); hygieneActions.append(inspectButton, quarantineButton);
  const hygieneReason = node('p', null, 'field-help'); hygieneReason.id = 'workDataHygieneReason'; hygieneReason.hidden = true;
  const hygieneResult = node('div', null, 'work-data-hygiene-result'); hygieneResult.id = 'workDataHygieneResult'; hygieneResult.setAttribute('role', 'status'); hygieneResult.setAttribute('aria-live', 'polite');
  const hygieneNotice = node('p', null, 'work-data-notice'); hygieneNotice.id = 'workDataHygieneNotice'; hygieneNotice.tabIndex = -1; hygieneNotice.setAttribute('role', 'status'); hygieneNotice.setAttribute('aria-live', 'polite');
  const moveBox = node('div', null, 'work-data-confirm'); moveBox.id = 'workDataHygieneConfirm'; moveBox.hidden = true;
  moveBox.setAttribute('role', 'alertdialog'); moveBox.setAttribute('aria-labelledby', 'workDataHygieneConfirmTitle'); moveBox.setAttribute('aria-describedby', 'workDataHygieneConfirmBody');
  const moveTitle = node('strong'); moveTitle.id = 'workDataHygieneConfirmTitle';
  const moveBody = node('p', 'hygiene.confirmBody', 'field-help'); moveBody.id = 'workDataHygieneConfirmBody';
  const moveList = node('ul', null, 'field-help work-data-hygiene-files'); moveList.id = 'workDataHygieneFiles';
  const moveMore = node('p', null, 'field-help'); moveMore.id = 'workDataHygieneMore';
  const moveGo = button('hygiene.confirmGo', 'workDataHygieneGo', () => void confirmQuarantine());
  const moveBack = button('hygiene.confirmBack', 'workDataHygieneBack', () => closeQuarantine(true));
  const moveActions = node('div', null, 'work-data-actions'); moveActions.append(moveGo, moveBack);
  moveBox.append(moveTitle, moveBody, moveList, moveMore, moveActions);
  moveBox.addEventListener('keydown', event => {
    if (!event || event.key !== 'Escape' || !movePlan) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    closeQuarantine(true);
  });
  hygiene.append(hygieneTitle, hygieneHelp, hygieneActions, hygieneReason, hygieneResult, moveBox, hygieneNotice);
  host.append(heading, summary, scope, retained, form, hygiene);
  let current = null, job = null, lastResult = null, loading = false, writing = false, picking = false, downloading = false, unknownSubmission = false, stale = false, disposed = false, timer = null, reading = null, revision = 0, submittedAuthority = null, trackedId = null;
  let pendingRestore = null, restoreServing = null, confirming = false;
  let inspection = null, inspectedAuthority = '', hygieneBusy = false, movePlan = null, undoButtons = [];
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
    // 151 阶段 3G · U13：已是明文时不再提供「转为明文存储」，已加密时不再提供「启用加密」。当前选中的那项不适用了就换到「导出」
    // （不替用户选一个会改动数据的操作），并清掉为旧选项填的口令。
    const offered = value => !(value === 'enable' && mode === 'encrypted' || value === 'disable' && mode === 'plain');
    for (const option of operation.children) { const off = !offered(option.value); option.disabled = off; option.hidden = off; }
    if (!offered(operation.value)) { operation.value = 'export'; clearSecrets(); confirmRestore.checked = false; }
    backup.placeholder = t('workData.pathPlaceholder'); parent.placeholder = t('workData.pathPlaceholder');
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
    // U13：上限按字节数写人话（修前是「536870888字节」这样的裸数字）。
    uploadHelp.textContent = t('workData.restoreFileHelp', { size: fmtBytes(maximum) });
    if (upload.files?.length && !selectedFile()) uploadHelp.textContent = t('workData.restoreFileInvalid', { size: fmtBytes(maximum) });
    targetPreview.textContent = t('workData.restoreTarget', { target: targetDirectory() || t('workData.restoreTargetMissing') });
    unavailable.hidden = !blocked; unavailable.textContent = blocked ? codeText(blocked, 'workData.unavailable') : '';
    restartNotice.hidden = current?.processRestartRequired !== true || stale || active();
    submit.textContent = t('workData.operation.' + operation.value); submit.disabled = disabled || !!blocked || !backup.value
      || password.value.length < 12 || new TextEncoder().encode(password.value).length > 1024 || password.value.includes('\0')
      || password.value !== confirmation.value || operation.value === 'disable' && !plaintext.checked
      || operation.value === 'restore' && !targetDirectory()
      || operation.value === 'restore' && !selectedFile()
      || operation.value === 'restore' && !confirmRestore.checked
      || operation.value === 'enable' && mode === 'encrypted' || operation.value === 'disable' && mode === 'plain' || hygieneBusy;
    const reasonKey = submit.disabled ? submitReasonKey(mode, blocked) : '';
    submitReason.hidden = !reasonKey; submitReason.textContent = reasonKey ? t(reasonKey) : ''; submitReason.dataset.reason = reasonKey;
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
        for (const text of workDataJobLimit(job)) { const line = node('p', null, 'field-help work-data-cause'); line.textContent = text; progress.append(line); }
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
    renderHygiene();
  }
  // U13：灰着的提交按钮说第一条还差什么。连接读取中、能力不可用（另有一行说明）、选择器或确认段打开时不说。
  function submitReasonKey(mode, blocked) {
    if (!current || loading || blocked) return '';
    if (stale) return 'workData.reason.stale';
    if (writing || active() || unknownSubmission || hygieneBusy) return 'workData.reason.busy';
    if (picking || confirming) return '';
    const value = operation.value;
    if (value === 'enable' && mode === 'encrypted') return 'workData.reason.alreadyEncrypted';
    if (value === 'disable' && mode === 'plain') return 'workData.reason.alreadyPlain';
    if (!backup.value) return 'workData.reason.backup';
    if (value === 'restore' && !selectedFile()) return 'workData.reason.restoreFile';
    if (value === 'restore' && !targetDirectory()) return 'workData.reason.restoreTarget';
    if (password.value.length < 12) return 'workData.reason.passwordShort';
    if (new TextEncoder().encode(password.value).length > 1024 || password.value.includes('\0')) return 'workData.reason.passwordLong';
    if (password.value !== confirmation.value) return 'workData.reason.passwordMismatch';
    if (value === 'disable' && !plaintext.checked) return 'workData.reason.confirmPlaintext';
    if (value === 'restore' && !confirmRestore.checked) return 'workData.reason.confirmRestore';
    return '';
  }
  // ── 数据根体检：状态与绘制 ──
  // 体检只在面板空闲时可用；维护作业在准备/交接、提交结果待确认、连接待恢复或答话的是冷端维护进程时一律不可用（后台也会拒）。
  // hygieneHeld：真正不该再动数据根的状态（打开着的确认段会因此收起）；hygieneBlocked 另加「正在读状态」—— 一次后台刷新只让按钮
  // 暂时变灰，不该把用户正在看的确认段收掉（3G v2：修前设置页的后台 refresh 会关掉确认段）。
  const hygieneHeld = () => !current || stale || writing || picking || downloading || active() || unknownSubmission || confirming
    || current?.maintenance?.phase === 'retired';
  const hygieneBlocked = () => hygieneHeld() || loading;
  const moveOpenForUser = () => { try { return !!document.activeElement && moveBox.contains(document.activeElement); } catch { return false; } };
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString(getLocale()) : '?';
  function renderHygiene() {
    // 数据根换了（启用/停用/恢复之后），上一次的体检结果不再属于它。
    if (inspection && current && inspectedAuthority !== JSON.stringify(current.authority)) { inspection = null; drawInspection(); }
    let refocus = false;
    if (movePlan && (hygieneHeld() || movePlan.authority !== JSON.stringify(current.authority))) { refocus = moveOpenForUser(); movePlan = null; }
    const blocked = hygieneBlocked() || hygieneBusy;
    moveBox.hidden = !movePlan; moveGo.disabled = !movePlan || blocked; moveBack.disabled = !movePlan;
    inspectButton.disabled = blocked || !!movePlan;
    const movable = !!inspection && inspection.verdicts.some(row => row && row.action === 'quarantine');
    quarantineButton.hidden = !movable; quarantineButton.disabled = blocked || !!movePlan;
    for (const undo of undoButtons) undo.disabled = blocked || !!movePlan;
    const reason = !current || loading ? '' : stale ? 'workData.hygiene.blockedStale'
      : active() || unknownSubmission || writing || current?.maintenance?.phase === 'retired' ? 'workData.hygiene.blockedMaintenance' : '';
    hygieneReason.hidden = !reason; hygieneReason.textContent = reason ? t(reason) : ''; hygieneReason.dataset.reason = reason;
    if (refocus) focus(hygieneNotice);
  }
  const validInspection = value => !!value && typeof value === 'object' && value.schema === 1 && typeof value.ok === 'boolean' && Array.isArray(value.verdicts)
    && !!value.census && typeof value.census === 'object' && Array.isArray(value.quarantine);
  const validPlan = value => !!value && typeof value === 'object' && /^[a-f0-9]{64}$/.test(value.token || '') && Number.isSafeInteger(value.files) && value.files >= 0
    && Number.isSafeInteger(value.bytes) && Array.isArray(value.items) && Array.isArray(value.skipped);
  // 只在拿到新的体检结果时重画（render 只改按钮的可用状态），免得后台刷新把焦点从「撤销」按钮上冲掉。
  function drawInspection() {
    hygieneResult.replaceChildren(); undoButtons = [];
    if (!inspection) { hygieneResult.hidden = true; return; }
    hygieneResult.hidden = false;
    const line = (text, className, id) => { const element = node('p', null, className || 'field-help'); element.textContent = text; if (id) element.id = id; hygieneResult.append(element); return element; };
    const census = inspection.census, mode = current?.authority?.mode;
    const prediction = line(workDataHygienePrediction(inspection, mode), 'work-data-hygiene-prediction', 'workDataHygienePrediction'); prediction.dataset.state = inspection.ok ? 'ok' : 'blocked';
    line(t('workData.hygiene.summary', { files: count(census.files), directories: count(census.directories), bytes: Number.isSafeInteger(census.bytes) ? fmtBytes(census.bytes) : '?' }), null, 'workDataHygieneSummary');
    const included = inspection.scope && inspection.scope.included;
    if (included && Number.isSafeInteger(included.files) && Number.isSafeInteger(included.bytes)) line(t('workData.hygiene.package', { files: count(included.files), bytes: fmtBytes(included.bytes) }));
    if (Array.isArray(census.nativeOwnerRoots) && census.nativeOwnerRoots.length) line(t('workData.hygiene.nativeRoots', { count: count(census.nativeOwnerRoots.length) }));
    const areas = Array.isArray(census.largest) ? census.largest.filter(row => row && typeof row.path === 'string' && Number.isSafeInteger(row.bytes) && Number.isSafeInteger(row.files)).slice(0, 5) : [];
    if (areas.length) {
      line(t('workData.hygiene.largest'));
      const list = node('ul', null, 'field-help work-data-hygiene-areas'); list.id = 'workDataHygieneAreas';
      for (const row of areas) { const item = node('li'); item.textContent = t('workData.hygiene.area', { path: row.path, files: count(row.files), bytes: fmtBytes(row.bytes) }); list.append(item); }
      hygieneResult.append(list);
    }
    const verdicts = inspection.verdicts.map(row => ({ row, text: workDataHygieneVerdictText(row) })).filter(entry => entry.text);
    if (verdicts.length) {
      line(t('workData.hygiene.findings'));
      const list = node('ul', null, 'work-data-hygiene-verdicts'); list.id = 'workDataHygieneVerdicts';
      for (const { row, text } of verdicts) {
        const item = node('li', null, 'field-help'); item.textContent = text; item.dataset.code = row.code; item.dataset.severity = row.severity === 'blocking' ? 'blocking' : 'advice'; list.append(item);
      }
      hygieneResult.append(list);
    } else line(t('workData.hygiene.clean'), null, 'workDataHygieneClean');
    const rows = inspection.quarantine.filter(row => row && typeof row.stamp === 'string' && /^[\w.-]{1,64}$/.test(row.stamp) && typeof row.root === 'string' && HYGIENE_STATES.has(row.state));
    if (rows.length) {
      line(t('workData.hygiene.areasTitle'));
      const list = node('ul', null, 'work-data-hygiene-quarantine'); list.id = 'workDataHygieneAreasQuarantine';
      rows.forEach((row, index) => {
        const item = node('li', null, 'field-help'), label = node('span');
        label.textContent = t('workData.hygiene.areaRow', { path: (row.root ? row.root + '/' : '') + 'quarantine-v1/' + row.stamp, state: t('workData.hygiene.state.' + hygieneCamel(row.state.replace(/-/g, '_'))) })
          + (Number.isSafeInteger(row.plaintext) && row.plaintext > 0 ? ' ' + t('workData.hygiene.areaPlaintext', { count: count(row.plaintext) }) : '');
        item.append(label);
        if (HYGIENE_UNDOABLE.has(row.state)) {
          const undo = button('hygiene.undo', 'workDataHygieneUndo' + index, () => void undoArea(row)); undo.dataset.stamp = row.stamp; undoButtons.push(undo); item.append(undo);
        }
        list.append(item);
      });
      hygieneResult.append(list);
    }
    line(t('workData.hygiene.readOnlyDone'), 'field-help work-data-hygiene-readonly', 'workDataHygieneReadOnly');
  }
  function hygieneReport(error, kind) {
    const code = errorCode(error);
    let text = code === 'net.disconnected' ? t('workData.disconnected', { code }) : codeText(code, 'workData.hygiene.failed');
    // 3C 审查 S6：每条失败都说清楚文件动没动 —— 体检与列清单是只读的；移入/撤销按码判断（见 workDataHygieneOutcomeKey）。
    text += ' ' + t(kind ? workDataHygieneOutcomeKey(kind, code, Number.isInteger(error?.status) ? error.status : undefined) : 'workData.hygiene.outcomeReadOnly');
    hygieneNotice.textContent = text; hygieneNotice.dataset.state = 'error';
  }
  async function runInspect({ quiet = false } = {}) {
    if (hygieneBlocked() || hygieneBusy) return;
    hygieneBusy = true; if (!quiet) { hygieneNotice.textContent = t('workData.hygiene.inspecting'); hygieneNotice.dataset.state = ''; } render();
    const authorityAt = JSON.stringify(current.authority);
    try {
      const result = await api('/api/work-data/hygiene');
      if (!result?.ok || !validInspection(result.inspection)) throw { code: 'work_data_setup.status_invalid' };
      inspection = result.inspection; inspectedAuthority = authorityAt; if (!quiet) hygieneNotice.textContent = '';
      drawInspection();
    } catch (error) { hygieneReport(error, ''); }
    finally { hygieneBusy = false; render(); }
  }
  function skippedText(plan) {
    const rows = plan.skipped.filter(row => row && HYGIENE_SKIPS.has(row.reason));
    if (!rows.length) return '';
    const kinds = [...new Set(rows.map(row => row.reason))].map(reason => t('workData.hygiene.skip.' + hygieneCamel(reason.replace(/-/g, '_'))));
    return ' ' + t('workData.hygiene.skipped', { count: count(Number.isSafeInteger(plan.skippedCount) ? plan.skippedCount : rows.length), reasons: kinds.join(t('workData.limitAreaSeparator')) });
  }
  async function openQuarantine() {
    if (hygieneBlocked() || hygieneBusy || movePlan) return;
    hygieneBusy = true; hygieneNotice.textContent = t('workData.hygiene.planning'); hygieneNotice.dataset.state = ''; render();
    // 3G v2：清单属于发出请求那一刻的数据根。记下当时的 authority；回包到达前它变了就不打开确认段，确认时也只发这一份。
    let plan = null; const authorityAt = JSON.stringify(current.authority);
    try {
      const result = await api('/api/work-data/hygiene/plan');
      if (!result?.ok || !validPlan(result.plan)) throw { code: 'work_data_setup.status_invalid' };
      if (!current || JSON.stringify(current.authority) !== authorityAt) throw { code: 'work_data_setup.authority_changed' };
      plan = result.plan; hygieneNotice.textContent = '';
    } catch (error) { hygieneReport(error, ''); }
    finally { hygieneBusy = false; }
    if (plan && plan.files === 0) { hygieneNotice.textContent = t('workData.hygiene.nothingToMove') + skippedText(plan); render(); focus(hygieneNotice); return; }
    // 3G v3：清单回来时恰好有一次后台读状态（loading）也照常打开确认段 ——「确认移入」按 hygieneBlocked 灰到读完，
    // 读回来的 authority 若变了，renderHygiene 会自行收起。只有真正不该动数据根的状态（hygieneHeld）才不打开。
    if (plan && !hygieneHeld()) {
      movePlan = { plan, authority: authorityAt };
      drawPlan(plan); render(); focus(moveBack); return;
    }
    render();
  }
  // 确认段列出将移动的每个文件（服务端最多给 200 条，其余报个数）与被跳过的原因。
  function drawPlan(plan) {
    moveTitle.textContent = t('workData.hygiene.confirmTitle', { count: count(plan.files), bytes: fmtBytes(plan.bytes) });
    moveList.replaceChildren();
    for (const row of plan.items) {
      if (!row || typeof row.path !== 'string') continue;
      const item = node('li');
      item.textContent = t('workData.hygiene.fileRow', { path: row.path, bytes: Number.isSafeInteger(row.bytes) ? fmtBytes(row.bytes) : '?',
        reason: t(HYGIENE_REASONS.has(row.reason) ? 'workData.hygiene.reason.' + hygieneCamel(row.reason.replace(/-/g, '_')) : 'workData.hygiene.reason.other') });
      moveList.append(item);
    }
    const shown = moveList.children.length;
    moveMore.textContent = (plan.files > shown ? t('workData.hygiene.confirmMore', { count: count(plan.files - shown) }) : '') + skippedText(plan);
    moveMore.hidden = !moveMore.textContent.trim();
  }
  function closeQuarantine(returnFocus) { const was = !!movePlan; movePlan = null; render(); if (was && returnFocus) focus(quarantineButton); }
  async function confirmQuarantine() {
    if (!movePlan || hygieneBusy || hygieneBlocked()) return;
    const { plan, authority } = movePlan; movePlan = null;
    hygieneBusy = true; hygieneNotice.textContent = t('workData.hygiene.moving'); hygieneNotice.dataset.state = ''; render(); focus(hygieneNotice);
    try {
      // 移入是一次性回执：403 换令牌后不自动重放（重放也只会因计划已变而被拒，但不该发第二次）。
      const result = await api('/api/work-data/hygiene/quarantine', { method: 'POST', body: JSON.stringify({ token: plan.token, expectedAuthority: JSON.parse(authority) }), noTokenReplay: true });
      const value = result?.result;
      if (!result?.ok || !value || !Number.isSafeInteger(value.moved) || !Array.isArray(value.areas)) throw { code: 'work_data_setup.status_invalid' };
      const where = value.areas.map(row => row && typeof row.area === 'string' ? row.area : '').filter(Boolean).join(t('workData.limitAreaSeparator'));
      hygieneNotice.textContent = value.moved > 0 ? t('workData.hygiene.moved', { count: count(value.moved), area: where }) : t('workData.hygiene.movedNone');
      hygieneNotice.dataset.state = 'ok';
    } catch (error) { hygieneReport(error, 'quarantine'); }
    finally { hygieneBusy = false; render(); }
    await runInspect({ quiet: true });
  }
  async function undoArea(row) {
    if (hygieneBlocked() || hygieneBusy || movePlan) return;
    hygieneBusy = true; hygieneNotice.textContent = t('workData.hygiene.undoing'); hygieneNotice.dataset.state = ''; render(); focus(hygieneNotice);
    try {
      const result = await api('/api/work-data/hygiene/undo', { method: 'POST', body: JSON.stringify({ stamp: row.stamp, root: row.root, expectedAuthority: { ...current.authority } }), noTokenReplay: true });
      const value = result?.result;
      if (!result?.ok || !value || !Number.isSafeInteger(value.restored) || !Array.isArray(value.kept)) throw { code: 'work_data_setup.status_invalid' };
      const kept = Number.isSafeInteger(value.keptCount) ? value.keptCount : value.kept.length;
      hygieneNotice.textContent = t('workData.hygiene.restored', { count: count(value.restored) })
        + (kept ? ' ' + t('workData.hygiene.kept', { count: count(kept) }) + ' ' + hygienePaths(value.kept, kept) : '');
      hygieneNotice.dataset.state = kept ? 'error' : 'ok';
    } catch (error) { hygieneReport(error, 'undo'); }
    finally { hygieneBusy = false; render(); }
    await runInspect({ quiet: true });
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
  const translate = () => { for (const element of host.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n); drawInspection(); if (movePlan) drawPlan(movePlan.plan); render(); };
  window.addEventListener('i18n:change', translate);
  // 设置页的后台刷新（refreshStatus → fillSettings → mountWorkDataSettings）也走这里：用户正在答（焦点在确认段里）时不打断；
  // 焦点已不在确认段（弹窗被整体关掉后重新打开）才收起上一次没答的确认，并把焦点还给提交按钮。
  const controller = Object.freeze({ refresh() { if (confirming && !confirmOpenForUser()) closeConfirm(true); return refresh(); }, dispose() { disposed = true; if (timer) clearTimeout(timer); clearSecrets(); upload.value = ''; confirmRestore.checked = false; window.removeEventListener('i18n:change', translate); } });
  panels.set(host, controller); void refresh(); return controller;
}
