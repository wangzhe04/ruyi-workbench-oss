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
    if (info.code === 'api.request_failed' && info.message) return info.message;
    // 128f-①（同一个模具，用户首启走查「显示不出具体原因」）：api.internal_error 是服务端 sendError 的兜底码，
    // 真原因在 message 里（那一刻抛出来的 err.message）。只按码翻译，屏幕上就剩「服务发生内部错误。」——
    // 现在译文后面带上原话（过长截断；message 只是码本身时不带）。
    if (info.code === 'api.internal_error' && info.message && info.message !== info.code) {
      const detail = info.message.length > 300 ? info.message.slice(0, 300) + '…' : info.message;
      return t('error.api.internalErrorDetail', { detail });
    }
    const key = API_ERROR_I18N[info.code];
    return key ? t(key, info.params) : rawApiErrText(error);
  }
  return apiErrText;
}
