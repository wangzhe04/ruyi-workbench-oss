// Localized API error presentation. Pure factory; callers supply parsing and translation.
const API_ERROR_I18N = {
  'auth.token_invalid': 'error.api.authToken',
  'api.route_not_found': 'error.api.routeNotFound',
  'api.request_failed': 'error.api.requestFailed',
  'api.internal_error': 'error.api.internalError',
  'api.method_not_allowed': 'error.api.methodNotAllowed',
  'api.host_rejected': 'error.api.hostRejected',
  'request.action_unknown': 'error.api.actionUnknown',
  'session.id_invalid': 'error.api.sessionInvalid',
  'session.id_required': 'error.api.sessionRequired',
  'session.not_found': 'error.api.sessionNotFound', 'agent_workflow.cycle': 'error.api.agentWorkflowCycle', 'agent_workflow.unknown_role': 'error.api.agentWorkflowUnknownRole',
  'memory.proposal_stale': 'error.api.memoryProposalStale', 'memory.move_conflict': 'error.api.memoryMoveConflict',
  'checkpoint.not_found': 'error.api.checkpointNotFound',
  'checkpoint.reference_invalid': 'error.api.checkpointReferenceInvalid',
  'file.path_required': 'error.api.pathRequired',
  'file.path_not_absolute': 'error.api.pathNotAbsolute',
  'request.field_required': 'error.api.fieldRequired',
  'agent_run.id_required': 'error.api.agentRunRequired',
  'question.not_pending': 'error.api.questionNotPending',
  'question.delivery_failed': 'error.api.questionDeliveryFailed',
  'steer.claude_requires_interactive': 'error.api.steerClaudeRequiresInteractive',
  // 128b:撤回与读改写冲突的三个稳定码(Brief §4.2 第 18 条:修前以原串 'rewind_superseded' 显示)。
  'session.rewind_superseded': 'error.api.rewindSuperseded',
  'session.rewound_during_write': 'error.api.rewoundDuringWrite',
  'session.history_changed_during_compact': 'error.api.historyChangedDuringCompact',
};
// 151 阶段 1 · W10/U3/P10：后端在出错路径上发出的稳定码 → 「发生了什么 + 用户能做什么」文案。键名由码机械推出
// （error.code.<驼峰>，见 apiErrorCopyKey），所以这里只登记码；中英文案在两份 locale（与 docs/i18n 镜像）。
// 体验门 G-codes（dev-harness/lib/experience-gates-codes.js）运行本模块判「有没有专属文案」，单测
// unit/api-error-copy.test.js 钉住每枚码在两份 locale 都有非空译文、推出的键互不冲突。
// 隐私网关与凭据库的码不在这里：它们走 privacy-failure.js 的 FAILURES（同一张表也给聊天里的隐私卡片用）。
const CODE_COPY = new Set([
  'api.bad_json', 'api.body_invalid', 'api.body_too_large', 'asr.content_type', 'asr.empty', 'asr.fix_audio_too_large', 'asr.fix_bad_request',
  'asr.fix_disabled', 'asr.fix_failed', 'asr.fix_not_configured', 'asr.stream_bad_request', 'asr.stream_busy', 'asr.stream_chunk_too_large',
  'asr.stream_session_missing', 'asr.stream_unreachable', 'asr.stream_upstream', 'asr.warmup_failed', 'auth.remote_denied',
  'config.first_provider_intent_invalid', 'delivery.file_changed', 'delivery.invalid_source', 'editor.open_failed', 'editor.platform_unsupported',
  'events.too_many_clients', 'file.internal_data', 'file.not_in_workspace', 'help.doc_unknown', 'local_crypto.unsupported',
  'permission.confirm_required', 'project.cwd_not_directory', 'projection.invalid_cursor', 'projection.snapshot_changed', 'question.no_active_turn',
  'scheduler.busy', 'scheduler.capacity_exceeded', 'scheduler.disabled', 'scheduler.not_found', 'scheduler.unavailable', 'session_search.disabled',
  'session.import_cwd_not_allowed', 'session.invalid_permission_mode', 'session.metadata_internal', 'session.scratchpad_unreadable',
  'session.turn_busy_elsewhere', 'steward.forbidden', 'tool.failed', 'upload.empty', 'upload.id_invalid', 'upload.name_invalid', 'upload.not_found',
  'upload.sealed_unavailable', 'voice.lexicon_bad_request', 'voice.lexicon_unreadable', 'voice.observe_bad_request', 'voice.observe_too_large',
  'work_data_backup.native_helper_uncertain', 'work_data_backup.portable_create_uncertain', 'work_data_backup.portable_install_uncertain',
  'work_data_backup.portable_stage_failed', 'work_data_journal.archive_mismatch', 'work_data_journal.downgrade_refused', 'work_data_journal.shape',
  'work_data_journal.source_changed', 'work_data_key.changed', 'work_data_setup.path_invalid', 'work_data_setup.rehearsal_changed',
  'work_data_store.binding', 'work_data_store.downgrade_refused', 'work_data_store.physical_check_unproven', 'work_data_store.snapshot_release',
  'work_data_store.storage_unavailable', 'work_data_store.switch_unavailable', 'work_data_store.validate',
  'work_data_tree.captured_file_owner_uncertain', 'work_data.encryption_requires_setup', 'work_data.maintenance_busy', 'credential_recovery.busy',
  'credential_recovery.capacity', 'credential_recovery.configuration_changed', 'credential_recovery.empty', 'credential_recovery.journal_invalid',
  'credential_recovery.journal_unreadable', 'credential_recovery.recovery_required', 'credential_recovery.ticket_expired', 'work_data_setup.busy',
  'work_data_setup.worker_unavailable', 'work_data_setup.restore_unavailable', 'work_data_setup.password_invalid',
  'work_data_setup.plaintext_confirmation_required', 'work_data_setup.mode_conflict', 'work_data_setup.mode_unchanged',
  'work_data_setup.authority_changed', 'work_data_setup.cancel_too_late', 'work_data_setup.cancelled', 'work_data_setup.job_not_found',
  'work_data_setup.takeover_committed', 'work_data_setup.status_unavailable', 'work_data_setup.status_invalid', 'work_data_setup.job_failed',
  'work_data_setup.capacity', 'work_data_setup.body_too_large', 'work_data_setup.request_invalid', 'work_data_setup.upload_unavailable',
  'work_data_setup.upload_incomplete', 'work_data_setup.package_unavailable', 'work_data_setup.download_unavailable',
  'work_data_setup.result_unavailable', 'work_data_setup.target_exists', 'work_data_setup.target_invalid', 'work_data_setup.space_insufficient',
  'work_data_setup.space_unavailable', 'work_data_setup.backup_directory_invalid', 'work_data_setup.backup_changed',
  'work_data_setup.backup_verification_failed', 'work_data_setup.file_too_large', 'work_data_setup.file_invalid',
  'work_data_setup.fresh_verification_failed', 'work_data_setup.handoff_pending', 'work_data_setup.worker_failed',
  'work_data_setup.worker_failed_after_handoff', 'work_data_setup.root_unavailable', 'work_data_setup.config_unavailable',
  'work_data_setup.intent_pending', 'work_data_setup.native_helper_uncertain', 'work_data_setup.preparation_failed',
  'work_data_setup.transition_requires_recovery', 'work_data_setup.restore_requires_inspection', 'work_data_setup.result_requires_recovery',
  'work_data.maintenance_not_idle', 'work_data.maintenance_infrastructure_unavailable', 'work_data.maintenance_infrastructure_uncertain',
  'work_data.authenticate_failed',
  // 151 阶段 1E：桌面关闭期间的拒收（13ag/13ax 的 apiCode），以及冷端在 job.reason 里带出的系统错误原因（13am SYSTEM_REASONS）。
  'desktop_lifetime.closing', 'work_data_setup.disk_full', 'work_data_setup.access_denied', 'work_data_setup.file_busy',
  'work_data_setup.file_missing', 'work_data_setup.read_only_volume', 'work_data_setup.too_many_open_files', 'work_data_setup.io_error',
  'work_data_setup.path_too_long',
  // 151 阶段 3B：备份包被移走/删掉（150 W2）与维护准备等待超限（150 W14）。
  'work_data_setup.package_missing', 'work_data_setup.drain_timeout', 'work_data_result.backup_missing', 'work_data_result.backup_changed',
  'work_data_setup.result_deferred', 'work_data_result.stage_pending', 'work_data_result.record_invalid', 'work_data_result.record_changed', 'work_data_result.path_alias',
]);
// 服务端 message 里带着「这一次具体为什么」的码（不是固定英文句）：文案后面附上原话。
const WITH_DETAIL = new Set(['tool.failed', 'editor.open_failed']);
const STABLE_CODE = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
export function apiErrorCopyKey(code) {
  const value = typeof code === 'string' ? code : '';
  if (Object.hasOwn(API_ERROR_I18N, value)) return API_ERROR_I18N[value];
  return CODE_COPY.has(value) ? 'error.code.' + value.replace(/[._]([a-z0-9])/g, (_, c) => c.toUpperCase()) : '';
}
// 响应体原文（JSON / HTML）不是给人看的：U3 走查里维护期发消息，气泡与 toast 直出了整段 JSON。
export function looksLikeRawPayload(text) {
  const value = String(text == null ? '' : text).trim();
  // 只认「整段就是载荷」：以 { / [ 开头，或以 HTML 文档标签开头。不锚定的 `"error":` 判据会把
  // 「HTTP 401: {"error":{"message":"Incorrect API key"}}」这类服务商人话也当原文吞掉（1D 审查）。
  return /^[{[]/.test(value) || /^<(?:!doctype|html|head|body)\b/i.test(value);
}
// 「人话前缀 + 内嵌 JSON」（06 providerRawCompletion、05 providerFixCompletion、07 fetchOpenAiModels 的
// `HTTP 401: {...}`）：从 JSON 里取 error.message / message 拼回前缀；取不到就保留截断后的原话。
export function humanizeEmbeddedPayload(text, max = 300) {
  const value = String(text == null ? '' : text).trim();
  const at = value.search(/[{[]/);
  if (at > 0) {
    try {
      const body = JSON.parse(value.slice(at));
      const pick = body && typeof body === 'object' ? (typeof body.error === 'string' ? body.error
        : body.error && typeof body.error.message === 'string' ? body.error.message
          : typeof body.message === 'string' ? body.message : '') : '';
      if (pick && !looksLikeRawPayload(pick)) {
        const prefix = value.slice(0, at).replace(/[\s:：-]+$/, '');
        const joined = prefix ? prefix + ': ' + pick : pick;
        return joined.length > max ? joined.slice(0, max) + '…' : joined;
      }
    } catch { /* 不是完整 JSON：保留原话 */ }
  }
  return value.length > max ? value.slice(0, max) + '…' : value;
}
// 124 真机 bug（用户 2026-09-15）：**api.request_failed 是「没有稳定码」的兜底码，按它翻译等于把
// 服务端刚说清楚的原因抹掉。** 00-boot 的 normalizeApiErrorPayload 对任何不在 LEGACY_API_ERROR_CODES
// 表里的遗留字符串错误一律派这个码，真话全留在 message 里；这里若先查表，屏幕上就只剩一句
// 「请求失败。」。用户那次看到的正是它 —— 服务端说的是「当前 Kimi 回合正在收尾，请作为下一条
// 消息发送」，该怎么做都写在里面了，却被吞掉。
// 所以这个码【单独】走 message 优先。其余码都是真码（服务端明确选的），仍然按表翻译，
// 因为那才是能本地化的那一半。
// provider-settings.js 的 mcpErrText 早就为同一个坑就地打过一块（它的注释写的是同一个诊断）。
// 上游收口之后那一块已经是冗余的，但删它是另一处回归面，本刀不顺手动：登记在号文里。
export function createApiErrorPresenter({ t, apiErrorInfo, rawApiErrText, privacyFailure }) {
  function apiErrText(error) {
    const privacy = privacyFailure(error);
    if (privacy) return t(privacy.key);
    const info = apiErrorInfo(error);
    if (info.code === 'api.request_failed' && info.message) return looksLikeRawPayload(info.message) ? t('error.api.unreadableResponse') : humanizeEmbeddedPayload(info.message, Infinity);
    // 128f-①（同一个模具，用户首启走查「显示不出具体原因」）：api.internal_error 是服务端 sendError 的兜底码，
    // 真原因在 message 里（那一刻抛出来的 err.message）。只按码翻译，屏幕上就剩「服务发生内部错误。」——
    // 现在译文后面带上原话（过长截断；message 只是码本身时不带）。
    // 151 阶段 1：抛错方只带了 code 没带 apiCode 时（如 13ag 的 work_data.maintenance_busy），sendError 落成
    // internal_error、message 就是那枚码 —— 有专属文案就按它翻，不再显示「内部错误：work_data.…」。
    if (info.code === 'api.internal_error' && info.message && info.message !== info.code) {
      const inner = STABLE_CODE.test(info.message) ? apiErrorCopyKey(info.message) : '';
      if (inner) return t(inner);
      if (looksLikeRawPayload(info.message)) return t('error.api.unreadableResponse');
      const detail = humanizeEmbeddedPayload(info.message);
      return t('error.api.internalErrorDetail', { detail });
    }
    const key = apiErrorCopyKey(info.code);
    if (key) {
      const text = t(key, info.params);
      const message = String(info.message || '');
      const detail = WITH_DETAIL.has(info.code) && message && message !== info.code && !looksLikeRawPayload(message) ? humanizeEmbeddedPayload(message) : '';
      return detail ? t('error.code.withDetail', { text, detail }) : text;
    }
    const raw = rawApiErrText(error);
    if (typeof raw !== 'string' || !raw) return raw;
    // 没有专属文案的码：绝不把响应体原文端给用户；message 只是码本身时说一句带码的通用话。
    if (looksLikeRawPayload(raw)) return STABLE_CODE.test(info.code || '') ? t('error.api.codeOnly', { code: info.code }) : t('error.api.unreadableResponse');
    const bare = raw.trim();
    if (STABLE_CODE.test(bare) && (bare === info.code || apiErrorCopyKey(bare))) {
      const inner = apiErrorCopyKey(bare);
      return inner ? t(inner) : t('error.api.codeOnly', { code: bare });
    }
    return humanizeEmbeddedPayload(raw, Infinity);
  }
  return apiErrText;
}
