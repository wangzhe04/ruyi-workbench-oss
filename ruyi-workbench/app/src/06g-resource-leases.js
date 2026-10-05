// Resource-aware agent scheduling. A lease is scoped to an agent group: the node-level declaration and
// its individual tool calls may overlap each other, while other agents still see the resource as busy.
// Resource strings are intentionally portable/persistable: desktop, browser:<profile>, file:<path>,
// office:<path>, workspace:<path>. Prefix a declaration with "read:" for a shared/read lease.
const resourceLeases = new Map(); // token -> { group, resources, acquiredAt }
const resourceWaiters = [];
// v1.x (B1) deadlock backstop: a lease that cannot be acquired within this window is abandoned with a clear
// error instead of waiting forever. This bounds the nested-lease deadlock a DAG can hit — two concurrent
// nodes each hold their node-level lease, then each blocks on a tool-level lease over the other's resource;
// drainResourceWaiters can NEVER satisfy that cycle, so Promise.all (and the whole run) would hang. 0 = wait
// forever (the pre-fix semantics). WCW_RESOURCE_LEASE_TIMEOUT_MS is a test seam (fast deadlock e2e).
// v1.x (B1 hardening): the PRIMARY deadlock signal is now wait-for-graph cycle detection (wouldDeadlock),
// which rejects a real cycle instantly. This timeout is demoted to a LONG safety backstop that only guards the
// extreme "cycle detection missed it AND the holder never releases" case; the global idle watchdog is the final
// stop. 0 = wait forever. The old 60s default false-failed legitimate long holds (builds / large downloads /
// Office generation > 60s), so the default is now generous.
const DEFAULT_RESOURCE_LEASE_TIMEOUT_MS = 1800000; // 30min long backstop (was 60s)
// Blemish fix: `Number(env) || default` swallowed an explicit 0 (0 is falsy) into the default, contradicting
// the "0 = wait forever" contract the deadlock e2e seeds. Only fall back to the default when env is unset/blank;
// honor an explicit 0 (and any other finite >= 0 value, e.g. the test seam WCW_RESOURCE_LEASE_TIMEOUT_MS=1500).
const RESOURCE_LEASE_TIMEOUT_MS = (() => {
  const raw = process.env.WCW_RESOURCE_LEASE_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return DEFAULT_RESOURCE_LEASE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RESOURCE_LEASE_TIMEOUT_MS;
})();
function canonicalResourcePath(value, cwd) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return path.normalize(path.isAbsolute(raw) ? raw : path.resolve(cwd || process.cwd(), raw));
}
function normalizeAgentResource(value, cwd) {
  let raw = String(value || '').trim();
  if (!raw || raw.length > 2048) return null;
  let mode = 'write';
  if (raw.startsWith('read:')) { mode = 'read'; raw = raw.slice(5); }
  let type = '', target = '';
  const colon = raw.indexOf(':');
  if (colon < 0) { type = raw.toLowerCase(); }
  else { type = raw.slice(0, colon).toLowerCase(); target = raw.slice(colon + 1); }
  if (type === 'desktop') return { type, target: 'global', mode, key: 'desktop', label: 'desktop' };
  if (type === 'browser') {
    target = String(target || 'default').trim().toLowerCase() || 'default';
    return { type, target, mode, key: `browser:${target}`, label: `browser:${target}` };
  }
  if (!['file', 'office', 'workspace'].includes(type)) return null;
  target = canonicalResourcePath(target || cwd, cwd);
  if (!target) return null;
  const folded = process.platform === 'win32' ? target.toLowerCase() : target;
  return { type, target, folded, mode, key: `${type}:${folded}`, label: `${type}:${target}` };
}
function normalizeAgentResources(values, cwd) {
  const out = [], seen = new Set();
  for (const value of (Array.isArray(values) ? values : [])) {
    const spec = normalizeAgentResource(value, cwd);
    if (!spec) continue;
    const id = `${spec.mode}:${spec.key}`;
    if (!seen.has(id)) { seen.add(id); out.push(spec); }
  }
  return out.slice(0, 32);
}
function remapAgentResources(values, sourceRoot, targetRoot) {
  const specs = normalizeAgentResources(values, sourceRoot);
  return specs.map(spec => {
    let label = spec.label;
    if (spec.target && ['file', 'office', 'workspace'].includes(spec.type) && pathWithinRoot(spec.target, sourceRoot)) {
      label = `${spec.type}:${path.resolve(targetRoot, path.relative(sourceRoot, spec.target))}`;
    }
    return (spec.mode === 'read' ? 'read:' : '') + label;
  });
}
function resourcePathContains(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
}
function agentResourcesConflict(a, b) {
  if (!a || !b || (a.mode === 'read' && b.mode === 'read')) return false;
  if (a.type === 'desktop' || b.type === 'desktop') return a.type === 'desktop' && b.type === 'desktop';
  if (a.type === 'browser' || b.type === 'browser') return a.type === 'browser' && b.type === 'browser' && a.target === b.target;
  const pathTypes = new Set(['file', 'office', 'workspace']);
  if (!pathTypes.has(a.type) || !pathTypes.has(b.type)) return a.key === b.key;
  if (a.type === 'workspace' || b.type === 'workspace') {
    const workspace = a.type === 'workspace' ? a : b;
    const other = workspace === a ? b : a;
    return resourcePathContains(workspace.target, other.target) || resourcePathContains(other.target, workspace.target);
  }
  return a.folded === b.folded; // file and office aliases for the same document conflict
}
function resourceBlockers(group, resources) {
  const blockers = [];
  for (const [token, lease] of resourceLeases) {
    if (lease.group === group) continue;
    if (resources.some(a => lease.resources.some(b => agentResourcesConflict(a, b)))) blockers.push({ token, group: lease.group, resources: lease.resources.map(r => r.label) });
  }
  return blockers;
}
// 这个组手里此刻是否已经握着任何租约。节点级声明与它名下的工具级请求用同一个组名(`${runId}:${node.id}`),
// 所以「握着租约的组又来要租约」就是嵌套请求:它的释放要等这次请求完成,别的组可能正等着它释放。
function groupHoldsLease(group) {
  for (const [, lease] of resourceLeases) if (lease.group === group) return true;
  return false;
}
function drainResourceWaiters() {
  for (let i = 0; i < resourceWaiters.length;) {
    const waiter = resourceWaiters[i];
    if (waiter.signal && waiter.signal.aborted) { resourceWaiters.splice(i, 1); waiter.reject(Object.assign(new Error('resource wait aborted'), { name: 'AbortError' })); continue; }
    // 公平排队(写者不被后来的读者插队)只约束【手里没有租约】的组。握着租约的组不排在任何人后面,只看真正的持有者:
    // 更早的等待者若正等着这个组释放(典型:节点 A 持有 workspace 租约、节点 B 在等它,A 的某次工具调用再要 A 自己
    // workspace 下的文件),排在它后面就是 A 等 B、B 等 A 的死局 —— wouldDeadlock 只给「持有者」建边,看不见排队边。
    const earlierConflict = !groupHoldsLease(waiter.group)
      && resourceWaiters.slice(0, i).some(earlier => waiter.resources.some(a => earlier.resources.some(b => agentResourcesConflict(a, b))));
    if (earlierConflict || resourceBlockers(waiter.group, waiter.resources).length) { i += 1; continue; }
    resourceWaiters.splice(i, 1);
    const token = makeId('lease');
    resourceLeases.set(token, { group: waiter.group, resources: waiter.resources, acquiredAt: nowIso() });
    waiter.resolve(token);
  }
}
// v1.x (B1 hardening): wait-for-graph cycle detection - the PRIMARY deadlock signal, replacing the crude
// timeout. Groups are graph nodes; a (waiting) group G that wants a resource currently HELD by a different
// group H implies an edge G->H. We add the tentative edge for THIS request (group wanting specs) plus the
// edges already implied by every parked waiter, then ask: starting from `group`, can we get back to `group`?
// Because the only NEW edges are outgoing from `group`, any newly-created cycle must pass through `group`, so
// reachability-back-to-self is sufficient. Complexity is O(V+E) over resourceLeases x resourceWaiters (a
// visited set prevents revisits / self-edge infinite recursion). A block that is NOT a cycle (a peer holding
// the resource for a legitimately long time) returns false and is left to wait for the eventual release.
function wouldDeadlock(group, specs) {
  const edges = new Map(); // waiterGroup -> Set(holderGroup)
  const addEdges = (from, resources) => {
    for (const [, lease] of resourceLeases) {
      if (lease.group === from) continue; // a group never waits on resources it already holds
      if (resources.some(a => lease.resources.some(b => agentResourcesConflict(a, b)))) {
        if (!edges.has(from)) edges.set(from, new Set());
        edges.get(from).add(lease.group);
      }
    }
  };
  addEdges(group, specs); // the tentative new wait edge for this request
  for (const w of resourceWaiters) addEdges(w.group, w.resources); // edges implied by already-parked waiters
  const visited = new Set();
  const stack = [...(edges.get(group) || [])];
  while (stack.length) {
    const g = stack.pop();
    if (g === group) return true; // reached the start again -> the new edge closes a wait cycle -> real deadlock
    if (visited.has(g)) continue;
    visited.add(g);
    for (const next of (edges.get(g) || [])) stack.push(next);
  }
  return false;
}
async function acquireResourceLease(group, resources, signal, onWait, timeoutMs) {
  const specs = Array.isArray(resources) ? resources : [];
  if (!specs.length) return '';
  const blockers = resourceBlockers(group, specs);
  // 握着租约的组不排队(理由见 groupHoldsLease / drainResourceWaiters):嵌套的工具级请求只会被真正的持有者挡住。
  const queuedAhead = groupHoldsLease(group) ? [] : resourceWaiters.filter(waiter => specs.some(a => waiter.resources.some(b => agentResourcesConflict(a, b))));
  if (!blockers.length && !queuedAhead.length) {
    const token = makeId('lease'); resourceLeases.set(token, { group, resources: specs, acquiredAt: nowIso() }); return token;
  }
  // 传进来的 signal 已经 aborted 时,下面挂的 'abort' 监听永远不会再触发 —— 入队前先判,免得一个已取消的请求
  // 无限期挂在队里(还会挡住排在它后面的人)。
  if (signal && signal.aborted) throw Object.assign(new Error('resource wait aborted'), { name: 'AbortError' });
  // v1.x (B1 hardening): before parking a BLOCKED waiter, detect a real wait-for cycle. A cycle can NEVER be
  // drained (drainResourceWaiters would loop forever), so reject at once instead of waiting out the long
  // backstop timeout. This is the primary mechanism; the timeout below is only the extreme-case backstop.
  if (wouldDeadlock(group, specs)) {
    throw Object.assign(new Error('资源死锁(检测到等待环)，已放弃该资源'), { name: 'ResourceDeadlockError', code: 'RESOURCE_DEADLOCK' });
  }
  if (typeof onWait === 'function') onWait(blockers.concat(queuedAhead.map(waiter => ({ group: waiter.group, resources: waiter.resources.map(r => r.label), queued: true }))));
  // v1.x (B1): arm a deadlock backstop timer unless the caller opts out (timeoutMs <= 0). resolve/reject are
  // wrapped so EVERY settle path (drainResourceWaiters, abort, timeout) clears the timer — no dangling timers.
  const limit = timeoutMs == null ? RESOURCE_LEASE_TIMEOUT_MS : Number(timeoutMs);
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const waiter = { group, resources: specs, signal, resolve: token => { cleanup(); resolve(token); }, reject: err => { cleanup(); reject(err); } };
    resourceWaiters.push(waiter);
    if (Number.isFinite(limit) && limit > 0) {
      timer = setTimeout(() => {
        const i = resourceWaiters.indexOf(waiter); if (i >= 0) resourceWaiters.splice(i, 1);
        waiter.reject(Object.assign(new Error('资源等待超时(疑似死锁)，已放弃该资源'), { name: 'ResourceTimeoutError', code: 'RESOURCE_TIMEOUT' }));
      }, limit);
      if (timer && timer.unref) timer.unref();
    }
    if (signal) signal.addEventListener('abort', () => { const i = resourceWaiters.indexOf(waiter); if (i >= 0) resourceWaiters.splice(i, 1); waiter.reject(Object.assign(new Error('resource wait aborted'), { name: 'AbortError' })); }, { once: true });
  });
}
function releaseResourceLease(token) { if (token && resourceLeases.delete(token)) drainResourceWaiters(); }
// 审计 A9:ACC 桌面工具的租约分类。write = 改变桌面/输入状态(独占);read = 只观察屏幕或窗口状态(共享)。
const ACC_DESKTOP_WRITE_TOOLS = new Set([
  'mouse_click', 'mouse_move', 'mouse_drag', 'mouse_scroll', 'scroll_at', 'type_text', 'press_key', 'hotkey', 'key_down', 'key_up',
  'focus_window', 'resize_window', 'move_window', 'minimize_window', 'maximize_window', 'close_window', 'set_window_topmost',
  'ui_invoke', 'ocr_click', 'vision_click', 'macro_run', 'batch_actions', 'act_and_verify', 'launch_application',
  'set_clipboard', 'set_clipboard_image', 'message_box', 'show_notification',
]);
const ACC_DESKTOP_READ_TOOLS = new Set([
  'screenshot', 'screenshot_region', 'window_screenshot', 'observe', 'ocr_screen', 'find_on_screen', 'find_template', 'find_all_templates',
  'wait_for_image', 'wait_for_pixel', 'get_pixel_color', 'get_screen_info', 'list_windows', 'get_active_window', 'get_mouse_position',
  'list_monitors', 'get_dpi_info', 'ui_inspect', 'ui_find', 'wait_for_window', 'wait_for_window_idle', 'get_clipboard', 'get_clipboard_image',
]);
// ACC 里【不碰桌面】的其余注册名:文件/Office/记忆/网络/进程/浏览器(浏览器另有 browser:<profile> 锁)/发声/诊断。
const ACC_NON_DESKTOP_TOOLS = new Set([
  'audit_tail', 'diagnostics', 'safety_info', 'version_info', 'run_command', 'list_processes', 'kill_process', 'get_system_info', 'wait',
  'get_environment_variable', 'read_file', 'write_file', 'list_directory', 'copy_file', 'move_file', 'delete_file', 'file_info', 'read_document',
  'write_document', 'write_excel', 'write_pdf', 'excel_beautify', 'excel_chart', 'write_pptx', 'chart_image', 'excel_read', 'pdf_read_pages',
  'browser_open', 'browser_backend_status', 'browser_click', 'browser_type', 'browser_screenshot', 'browser_get_text', 'browser_execute_js',
  'browser_navigate', 'browser_get_elements', 'browser_list_tabs', 'browser_switch_tab', 'browser_close', 'edit_file', 'image_info', 'image_resize',
  'ocr_image', 'ocr_available_languages', 'record_start', 'record_stop', 'macro_list', 'memory_save', 'memory_read', 'memory_list', 'memory_delete',
  'fetch', 'sequential_thinking', 'beep', 'notify_attention', 'play_sound',
]);
function bridgedDesktopLeaseMode(bare, input) {
  if (ACC_DESKTOP_WRITE_TOOLS.has(bare)) return 'write';
  if (bare === 'ocr_find_text') return input && input.click === true ? 'write' : 'read';   // click=True 才真点击
  if (ACC_DESKTOP_READ_TOOLS.has(bare)) return 'read';
  if (ACC_NON_DESKTOP_TOOLS.has(bare)) return '';
  return /click|mouse|keyboard|hotkey|ocr|screen|window|desktop|type|press|scroll|drag/.test(bare) ? 'write' : '';   // 表外(第三方 MCP):旧口径
}
function inferToolResources(name, args, bridge, cwd, tier) {
  const bare = String(bridge ? bridge.toolName : name || '').toLowerCase();
  const input = args && typeof args === 'object' ? args : {};
  const specs = [];
  const add = (raw, mode) => { const s = normalizeAgentResource((mode === 'read' ? 'read:' : '') + raw, cwd); if (s) specs.push(s); };
  const exactReadNames = new Set(['file_read', 'docs_search']);
  const treeReadNames = new Set(['file_list', 'file_search', 'glob', 'project_snapshot', 'git_status', 'git_diff', 'git_log', 'dependency_inventory', 'code_review_scan', 'frontend_audit', 'claude_md_audit', 'codebase_symbol_search']);
  const writeNames = new Set(['file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download']);
  if (exactReadNames.has(name)) add(`file:${input.path || input.root || input.cwd || cwd}`, 'read');
  if (treeReadNames.has(name)) add(`workspace:${input.path || input.root || input.cwd || cwd}`, 'read');
  if (writeNames.has(name)) {
    for (const key of ['path', 'source', 'destination', 'dest', 'output', 'output_path']) if (input[key]) add(`file:${input[key]}`, 'write');
  }
  if (name === 'shell_start' || name === 'git_commit') add(`workspace:${input.cwd || cwd}`, 'write');
  if (name === 'browser_open' || /browser|chrom(e|ium)|playwright/.test(bare)) add(`browser:${input.profile || input.profileName || 'default'}`, 'write');
  if (name === 'office_open' || /excel|word|powerpoint|office|docx|xlsx|pptx|pdf/.test(bare)) {
    const p = input.path || input.file || input.input_path || input.output_path;
    if (p) add(`office:${p}`, tier === 'read' ? 'read' : 'write');
  }
  // 桌面锁(审计 A9):修前是一条名字正则 —— 漏掉 macro_run / batch_actions(回放鼠标键盘)、key_down/up、ui_invoke、act_and_verify、
  // launch_application、剪贴板写、message_box,两个 agent 可以交错点击;又把只读的 get_screen_info / list_windows 也当独占写锁。
  // 现在按 ACC 的真实工具名(mcp/ai-computer-control 的 108 个注册名逐个分过类)显式分两张表:会动桌面的 → 独占写锁,
  // 只看桌面的 → 共享读锁(读读可并发、与写互斥),其余 ACC 工具(文件/Office/记忆/网络/浏览器…)不占桌面。
  // 表外的名字(第三方 MCP)仍走旧正则兜底 —— 未知的保守当写。原生 keyboard_send_keys 修前完全没锁,一并补上。
  const deskMode = name === 'keyboard_send_keys' ? 'write'
    : name === 'desktop_screenshot' ? 'read'
    : bridge ? bridgedDesktopLeaseMode(bare, input) : '';
  if (deskMode) add('desktop', deskMode);
  if (bridge) {
    for (const target of collectBridgedWriteTargets(bridge.toolName, input)) add(`file:${target.path}`, 'write');
  }
  const seen = new Set(); return specs.filter(s => !seen.has(`${s.mode}:${s.key}`) && seen.add(`${s.mode}:${s.key}`));
}

