// Pure presentation metadata. Only exact stable codes and structured receipts
// are recognized; arbitrary prose containing a code remains ordinary text.
const FAILURES = Object.freeze({
  'privacy.engine_not_supported': ['engine', 'engine'],
  'privacy.media_not_supported': ['media'],
  'privacy.policy_unavailable': ['unavailable', 'privacy'],
  'privacy.policy_changed': ['changed', 'privacy'],
  'privacy.disclosure_not_supported': ['adapter'],
  'privacy.disclosure_requires_planning': ['adapter'],
  'privacy.recipient_denied': ['reference'],
  'privacy.recipient_changed': ['reference'],
  'privacy.reference_unknown': ['reference'],
  'privacy.reference_expired': ['reference'],
  'privacy.reference_revoked': ['reference'],
  'privacy.reference_malformed': ['reference'],
  'privacy.reference_unavailable_history': ['reference'],
  'privacy.credential_context': ['reference'],
  'privacy.scope_changed': ['reference'],
  'privacy.disclosure_dirty': ['reference'],
  'privacy.disclosure_changed': ['reference'],
  'privacy.tool_result_withheld': ['withheld'],
  'privacy.typed_sensitive': ['content'],
  'privacy.numeric_sensitive': ['content'],
  'privacy.json_sensitive_structure': ['content'],
  'privacy.control_field_sensitive': ['content'],
  'privacy.reserved_literal': ['content'],
  'privacy.opaque_content_not_supported': ['content'],
  'privacy.source_proof_invalid': ['reference'],
  'privacy.source_view_changed': ['reference'],
  'privacy.source_view_stale': ['reference'],
  'privacy.source_range_invalid': ['reference'],
  'privacy.source_structure_invalid': ['reference'],
  'privacy.mapping_invalid': ['unavailable', 'privacy'],
  'privacy.adapter_changed': ['changed'],
  'privacy.execution_cancelled': ['cancelled'],
  'privacy.mcp_arguments_changed': ['mcpChanged'],
  'privacy.mcp_cancelled': ['cancelled'],
  'privacy.mcp_dispatch_changed': ['mcpChanged'],
  'privacy.mcp_recipient_changed': ['mcpChanged'],
  'privacy.mcp_resource_binary_unsupported': ['mcpBinary'],
  'privacy.mcp_resource_changed': ['mcpChanged'],
  'privacy.mcp_resource_invalid': ['mcpInvalid'],
  'privacy.mcp_resource_limit': ['mcpLimit'],
  'privacy.mcp_resource_unavailable': ['mcpUnavailable'],
  'privacy.mcp_resource_unsupported': ['mcpUnsupported'],
  'privacy.mcp_result_unavailable': ['withheld'],
  'privacy.mcp_turn_changed': ['mcpChanged'],
  'privacy.server_tools_not_supported': ['serverTools'],
  'privacy.tool_channel_not_supported': ['toolChannel'],
  'mcp_consumer.unauthorized': ['consumerGrant'],
  'mcp_consumer.revoked': ['consumerGrant'],
  'mcp_consumer.not_found': ['consumerGrant'],
  'mcp_consumer.grant_invalid': ['consumerGrant'],
  'mcp_consumer.workspace_invalid': ['consumerWorkspace'],
  'mcp_consumer.workspace_changed': ['consumerWorkspace'],
  'mcp_consumer.workspace_denied': ['consumerWorkspace'],
  'mcp_consumer.connection_invalid': ['consumerConnection'],
  'mcp_consumer.configuration_changed': ['consumerConnection'],
  'mcp_consumer.cursor_invalid': ['consumerCursor'],
  'mcp_consumer.capacity': ['consumerLimit'],
  'mcp_consumer.audit_changed': ['consumerAudit'],
  'mcp_consumer.audit_busy': ['consumerAudit'],
  'mcp_consumer.audit_missing': ['consumerAudit'],
  'mcp_consumer.cancelled': ['cancelled'],
  'mcp_consumer.message_invalid': ['consumerRequest'],
  'mcp_consumer.result_limit': ['consumerLimit'],
  'mcp_consumer.body_limit': ['consumerLimit'],
  'mcp_consumer.resource_denied': ['consumerGrant'],
  'mcp_consumer.method_not_supported': ['consumerRequest'],
  'mcp_consumer.tool_denied': ['consumerGrant'],
  'mcp_consumer.permission_required': ['consumerGrant'],
  'mcp_consumer.private_arguments_denied': ['reference'],
  'mcp_consumer.media_not_supported': ['mcpBinary'],
  'mcp_consumer.operation_failed': ['consumerFailed'],
  'mcp_consumer.lease_exists': ['consumerConnection'],
  'mcp_consumer.lease_required': ['consumerConnection'],
  'mcp_consumer.setup_required': ['consumerConnection'],
  'mcp_consumer.unavailable': ['consumerConnection'],
  'mcp_consumer.subscription_pending': ['consumerSubscription'],
});
export function privacyFailure(value) {
  const seen = new Set(); let mayHaveExecuted = false, resultUnavailable = false, code = '';
  function inspect(item, depth, errorContext = false) {
    if (depth > 5 || item == null) return;
    if (typeof item === 'string') {
      if (Object.hasOwn(FAILURES, item)) { code ||= item; return; }
      // HTTP Error.message can contain an entire JSON response. No substring
      // matching, stack parsing or params interpolation into privacy copy.
      if (item.length <= 65536 && item.startsWith('{')) { try { inspect(JSON.parse(item), depth + 1, errorContext); } catch { /* ordinary prose */ } }
      return;
    }
    if (typeof item !== 'object' || seen.has(item)) return;
    seen.add(item);
    if (item.ok === true || item.isError === false) return; // Successful business data is not an error envelope.
    mayHaveExecuted ||= item.operationMayHaveExecuted === true;
    resultUnavailable ||= item.resultUnavailable === true;
    if (typeof item.code === 'string' && Object.hasOwn(FAILURES, item.code)) code ||= item.code;
    // Plain file/tool business text is not an error serialization boundary.
    const isError = errorContext || item instanceof Error || item.ok === false || item.isError === true || item.type === 'error';
    for (const key of ['errorInfo', 'error', 'receipt']) inspect(item[key], depth + 1, true);
    if (isError) for (const key of ['message', 'text']) inspect(item[key], depth + 1, true);
    // Only a complete JSON-RPC error envelope grants meaning to error.data.
    // Ordinary business data, including nested code fields, remains opaque.
    const rpcError = item.error;
    if (item.jsonrpc === '2.0' && Object.hasOwn(item, 'id') && !Object.hasOwn(item, 'result')
      && (item.id === null || typeof item.id === 'string' || typeof item.id === 'number' && Number.isFinite(item.id))
      && rpcError && typeof rpcError === 'object' && !Array.isArray(rpcError)
      && Number.isInteger(rpcError.code) && typeof rpcError.message === 'string'
      && rpcError.ok !== true && rpcError.isError !== false) inspect(rpcError.data, depth + 1, true);
    // MCP text envelopes are inspected only when explicitly marked as errors.
    if (item.isError === true && Array.isArray(item.content)) for (const part of item.content.slice(0, 32)) if (part?.type === 'text') inspect(part.text, depth + 1, true);
  }
  inspect(value, 0);
  if (!code && mayHaveExecuted && resultUnavailable) code = 'privacy.tool_result_withheld';
  if (!code) return null;
  const [name, action] = FAILURES[code];
  return { code, titleKey: 'privacy.failure.title', key: 'privacy.failure.' + name, action: action || '',
    mayHaveExecuted: mayHaveExecuted || code === 'privacy.tool_result_withheld', resultUnavailable };
}
export function privacyVoiceFailure(config) {
  if (config?.privacyPolicyRecoveryRequiredV1 === true) return privacyFailure('privacy.policy_unavailable');
  return config && (config.privacyModeV1 || 'off') !== 'off' ? privacyFailure('privacy.media_not_supported') : null;
}
