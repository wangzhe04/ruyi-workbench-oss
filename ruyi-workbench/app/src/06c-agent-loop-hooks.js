// ============================================================================
// 第75d波（Escapade Harness 小迭代）：Agent Loop 生命周期钩子 + 轻量 trace spine。
//
// 钩子是进程内、只读、best-effort 的扩展点：
//   - 固定注册顺序，便于指标/日志/限额观察保持确定性；
//   - 每个钩子独立超时与故障隔离，扩展故障不改变主回合结果；
//   - 上下文先做有界复制再深冻结，返回值一律忽略，不能借钩子绕过权限或改写工具参数；
//   - 不自动装载磁盘脚本/第三方包，保持气隙部署与信任边界不变。
//
// Claude CLI 自己持有内部工具循环，因此适配器只发 turn/model 边界；Provider 原生循环还会发
// preToolCall/postToolCall。后续若引入可变 middleware，必须另立显式契约并重新过权限安全评审。
// ============================================================================
// 103b 隔离试点：内部状态与 helper 收进单一命名空间，只把七个稳定入口暴露给拼接作用域。
// 依赖以 IIFE 参数显式注入；运行时加载顺序和 module.exports 的公共形状保持不变。
const AgentLoopHooks = ((makeIdFn, logEventFn, redactFn) => {
const AGENT_LOOP_HOOK_PHASES = Object.freeze([
  'onTurnStart',
  'beforeModelCall',
  'preToolCall',
  'postToolCall',
  'onTurnEnd',
  'onError',
]);
const AGENT_LOOP_HOOK_PHASE_SET = new Set(AGENT_LOOP_HOOK_PHASES);
const AGENT_LOOP_HOOKS = new Map();
const AGENT_LOOP_HOOK_TIMEOUT_MS = 250;

function makeAgentLoopTraceId() {
  return makeIdFn('trace');
}

function cloneAgentLoopHookValue(value, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length > 32768 ? value.slice(0, 32768) + '…[truncated]' : value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return undefined;
  if (depth >= 8) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.slice(0, 200).map(item => cloneAgentLoopHookValue(item, depth + 1, seen));
    if (value.length > 200) out.push(`[+${value.length - 200} items]`);
    seen.delete(value);
    return out;
  }
  // Null-prototype copy prevents a JSON argument named "__proto__" from mutating the hook snapshot's
  // prototype while it is being bounded/frozen.
  const out = Object.create(null);
  for (const key of Object.keys(value).slice(0, 200)) {
    const cloned = cloneAgentLoopHookValue(value[key], depth + 1, seen);
    if (cloned !== undefined) out[key] = cloned;
  }
  seen.delete(value);
  return out;
}

function deepFreezeAgentLoopHookValue(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreezeAgentLoopHookValue(child, seen);
  return Object.freeze(value);
}

function immutableAgentLoopHookContext(context) {
  return deepFreezeAgentLoopHookValue(cloneAgentLoopHookValue(context && typeof context === 'object' ? context : {}));
}

function normalizeAgentLoopHookTimeout(value) {
  if (value == null || value === '') return AGENT_LOOP_HOOK_TIMEOUT_MS;
  return Math.max(25, Math.min(2000, Math.round(Number(value) || AGENT_LOOP_HOOK_TIMEOUT_MS)));
}

function registerAgentLoopHook(hook) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook)) throw new Error('agent loop hook 必须是对象');
  const id = String(hook.id || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error('agent loop hook.id 必须为 1-64 位字母、数字、点、下划线或连字符');
  if (AGENT_LOOP_HOOKS.has(id)) throw new Error(`agent loop hook 已注册: ${id}`);
  const handlers = {};
  for (const phase of AGENT_LOOP_HOOK_PHASES) if (typeof hook[phase] === 'function') handlers[phase] = hook[phase];
  if (!Object.keys(handlers).length) throw new Error('agent loop hook 至少实现一个生命周期阶段');
  AGENT_LOOP_HOOKS.set(id, { id, handlers, timeoutMs: normalizeAgentLoopHookTimeout(hook.timeoutMs) });
  return { id, phases: Object.keys(handlers), timeoutMs: normalizeAgentLoopHookTimeout(hook.timeoutMs) };
}

function unregisterAgentLoopHook(id) {
  return AGENT_LOOP_HOOKS.delete(String(id || '').trim());
}

function listAgentLoopHooks() {
  return [...AGENT_LOOP_HOOKS.values()].map(hook => ({
    id: hook.id,
    phases: Object.keys(hook.handlers),
    timeoutMs: hook.timeoutMs,
  }));
}

function runAgentLoopHookWithTimeout(handler, context, timeoutMs, id, phase) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`agent loop hook timeout: ${id}.${phase} > ${timeoutMs}ms`);
      err.code = 'AGENT_LOOP_HOOK_TIMEOUT';
      reject(err);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => handler(context)), timeout]).finally(() => clearTimeout(timer));
}

async function dispatchAgentLoopHooks(phase, context) {
  if (!AGENT_LOOP_HOOK_PHASE_SET.has(phase)) throw new Error(`未知 agent loop hook 阶段: ${phase}`);
  const snapshot = immutableAgentLoopHookContext({ phase, ...(context || {}) });
  let invoked = 0, failed = 0;
  // Snapshot the registry at phase entry: a hook may register/unregister another hook, but that mutation
  // only affects the next phase dispatch and can never extend/reorder the current iteration.
  for (const hook of [...AGENT_LOOP_HOOKS.values()]) {
    const handler = hook.handlers[phase];
    if (!handler) continue;
    invoked += 1;
    try {
      await runAgentLoopHookWithTimeout(handler, snapshot, hook.timeoutMs, hook.id, phase);
    } catch (error) {
      failed += 1;
      try {
        logEventFn({
          kind: 'agent_loop_hook_error',
          hookId: hook.id,
          phase,
          traceId: String(snapshot.traceId || ''),
          code: error && error.code === 'AGENT_LOOP_HOOK_TIMEOUT' ? 'timeout' : 'exception',
          error: redactFn(String(error && error.message || error)).slice(0, 500),
        });
      } catch { /* hook telemetry must never break the turn */ }
    }
  }
  return { phase, invoked, failed };
}

function summarizeAgentLoopToolResult(result) {
  let bytes = 0;
  try { bytes = Buffer.byteLength(JSON.stringify(result == null ? null : result), 'utf8'); } catch { bytes = 0; }
  const isObject = result && typeof result === 'object' && !Array.isArray(result);
  return {
    ok: !(isObject && result.ok === false),
    bytes,
    keys: isObject ? Object.keys(result).slice(0, 40) : [],
    error: isObject && result.ok === false && result.error ? redactFn(String(result.error)).slice(0, 500) : undefined,
  };
}

return Object.freeze({
  AGENT_LOOP_HOOK_PHASES,
  registerAgentLoopHook,
  unregisterAgentLoopHook,
  listAgentLoopHooks,
  dispatchAgentLoopHooks,
  makeAgentLoopTraceId,
  summarizeAgentLoopToolResult,
});
})(makeId, logEvent, redact);
