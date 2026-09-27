// 02f-turn-effect-kinds.js - 架构还债批 3·B: 从 02-session-store.js 搬出的回合摘要工具分类表与不可逆操作账分类(纯数据+纯函数;buildTurnSummary 仍在 02;纯搬家,零行为变更)。
const TURN_SUMMARY_FILE_TOOLS = new Set(['file_write', 'file_edit', 'file_delete']);
const TURN_SUMMARY_COMMAND_TOOLS = new Set(['powershell_run', 'script_run', 'shell_send']);

// v0.9-S4: keys a bridged/creation tool result may use to report a file it produced (ACC document creation,
// screenshot tools, office bridges all echo one of these). Harvested into turn_summary.artifacts alongside
// this turn's journal `create` entries. Purely a hint source — never a security boundary (the preview
// endpoint re-checks every path against the allowed roots regardless of how it entered a summary).
const ARTIFACT_OUTPUT_PATH_KEYS = ['output_path', 'outputPath', 'saved_path', 'savedPath'];
// v1.5-W1.5: ACC(官方原生 MCP)的写族文档工具返回 {success:true, path:...} —— 裸 `path` 不在
// ARTIFACT_OUTPUT_PATH_KEYS 里(读类工具 read_document/file_info 也回 path,加进去会把「读过的文件」误登记
// 为产物)。所以对 bridged 工具改用「工具名限定的 path 收割」:仅当工具名匹配写族时,才把结果里的字符串
// `path` 当产物。这是对已装 旧版 ACC(未回 output_path)的兼容层;新版 ACC 已同时回 output_path,走上面的
// 通用键即可。判定纯按名字前缀 + 结果 success:true,不做 I/O。裸名(去 serverId__ 前缀)参与匹配。
// 明确写族名(ACC 与常见 office bridge):write_document/write_excel/write_pdf/write_docx。
const ARTIFACT_BRIDGED_WRITE_NAMES = new Set(['write_docx', 'write_excel', 'write_pdf', 'write_document']);
// 前缀写族:名字以这些开头的 bridged 工具也算「产出文件」(create_*/export_*/save_*/write_*)。
const ARTIFACT_BRIDGED_WRITE_PREFIXES = ['write_', 'create_', 'export_', 'save_'];
// 去掉 bridged 工具的 serverId__ 前缀,取裸工具名(collectBridgedTools 用 `${prefix}__${toolName}` 拼接)。
function unprefixedBridgedName(name) {
  const s = String(name || '');
  const i = s.lastIndexOf('__');
  return i >= 0 ? s.slice(i + 2) : s;
}
function isBridgedWriteTool(name) {
  const bare = unprefixedBridgedName(name);
  if (ARTIFACT_BRIDGED_WRITE_NAMES.has(bare)) return true;
  return ARTIFACT_BRIDGED_WRITE_PREFIXES.some(p => bare.startsWith(p));
}
// Workbench tools whose effect we can attribute precisely; anything the claude CLI runs OUTSIDE this set
// (native Edit/Write/Bash, which never reach toolCall) only counts as a command.
const TURN_SUMMARY_KNOWN_TOOLS = new Set([
  ...TURN_SUMMARY_FILE_TOOLS, ...TURN_SUMMARY_COMMAND_TOOLS,
  'todo_write', 'file_read', 'file_list', 'file_search', 'glob', 'project_snapshot', 'git_status',
  'git_diff', 'git_log', 'git_commit', // v1.0-S4 git 工具族
  'dependency_inventory', 'code_review_scan', 'frontend_audit', 'claude_md_audit', 'docs_search', 'codebase_symbol_search',
  'shell_start', 'shell_poll', 'shell_kill', 'shell_list', 'http_request', 'browser_open', 'office_open',
  'desktop_screenshot', 'keyboard_send_keys', 'permission_prompt',
  // v1.1-W2 (T1): 新五工具是内建可撤销工具(journal 驱动) —— 归入 KNOWN 集合,故 claude 引擎不会把它们误计为「命令」。
  // 它们产生的 journal 条目由 buildTurnSummary 的 journalEntries 叠加为 filesChanged(revertible:true)。
  'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download',
]);
// ── 第72波(EC-E 切片三):不可逆操作正向账 ─────────────────────────────────────────────────
// toolIsRevertible 是名字级承诺 + journal 缺位这个负信号;exec/desktop/network 类操作天然不在变更清单,
// 此前只有一个 commands 计数 —— 「这个任务到底干过哪些撤不掉的事」无处可查。本账在回合摘要里正向记录
// 每一条【有副作用且无 journal 快照】的工具调用:{kind, name, detail, ok}。
// 收录判据(与权限系统同一风险分级,不另立启发式):
//  - 内建:nativeToolTier(name)==='exec' 且非可撤销(journal 族已被 toolIsRevertible 覆盖)且非编排元工具;
//  - 桥接:bridgedToolTier 默认即 'exec'(未知一律最严)——只收显式已知会留副作用的族,防把未知 MCP 的
//    只读调用误记为不可逆(谎报比漏报更糟:用户会不再信任账);未命中白名单的桥接 exec 不记账(不谎称账全);
//  - claude 引擎未知名:CLI 原生工具不过 toolCall —— Bash 族/Edit/Write 直落盘无 journal(08:238 注),记账;
//    其余未知名保持原样只进 commands 计数。
// 注意:exec 命令【结果失败也记账】(ok:false)——命令已跑,副作用可能已发生;与文件工具「失败=未改动」不同。
const IRREVERSIBLE_NATIVE_KIND = {
  powershell_run: 'exec', script_run: 'exec', shell_start: 'exec', shell_send: 'exec', shell_kill: 'exec',
  git_commit: 'exec', mcp_configure: 'exec',
  keyboard_send_keys: 'desktop', browser_open: 'desktop', office_open: 'desktop', desktop_screenshot: 'desktop',
  http_request: 'network',
};
// 桥接(exec 默认)里的已知副作用族 → kind;未列出的桥接 exec 工具不记账(见上「不谎称账全」)。
const IRREVERSIBLE_BRIDGED_KIND = {
  run_command: 'exec', kill_process: 'exec', launch_application: 'exec',
  mouse_click: 'desktop', mouse_move: 'desktop', mouse_drag: 'desktop', mouse_scroll: 'desktop', scroll_at: 'desktop',
  type_text: 'desktop', press_key: 'desktop', hotkey: 'desktop', key_down: 'desktop', key_up: 'desktop',
  set_clipboard: 'desktop', set_clipboard_image: 'desktop', close_window: 'desktop', move_window: 'desktop',
  resize_window: 'desktop', minimize_window: 'desktop', maximize_window: 'desktop', set_window_topmost: 'desktop',
  message_box: 'desktop', show_notification: 'desktop', beep: 'desktop', play_sound: 'desktop', notify_attention: 'desktop',
  browser_open: 'network', fetch: 'network',
};
const CLAUDE_IRREVERSIBLE_KIND = {
  Bash: 'exec', BashOutput: 'exec', KillBash: 'exec', KillShell: 'exec',
  Edit: 'exec', Write: 'exec', MultiEdit: 'exec', NotebookEdit: 'exec', // CLI 直落盘,工作台无 journal(08:238)
};
const IRREVERSIBLE_LEDGER_MAX = 50;
function irreversibleToolKind(name) {
  const n = String(name || '');
  if (Object.prototype.hasOwnProperty.call(IRREVERSIBLE_NATIVE_KIND, n)) return IRREVERSIBLE_NATIVE_KIND[n];
  if (Object.prototype.hasOwnProperty.call(CLAUDE_IRREVERSIBLE_KIND, n)) return CLAUDE_IRREVERSIBLE_KIND[n];
  const bare = unprefixedBridgedName(n);
  if (bare !== n && Object.prototype.hasOwnProperty.call(IRREVERSIBLE_BRIDGED_KIND, bare)) return IRREVERSIBLE_BRIDGED_KIND[bare];
  return '';
}
// 账条 detail:从 input 里挑最有辨识度的字段(command/url/path/text),截断 120 字符;全工具调用正文
// 本就存在会话里,无新增暴露面。
function irreversibleDetail(input) {
  const o = (input && typeof input === 'object') ? input : {};
  for (const k of ['command', 'cmd', 'code', 'script', 'url', 'path', 'text', 'name', 'pid']) {
    if (typeof o[k] === 'string' && o[k].trim()) return o[k].replace(/\s+/g, ' ').trim().slice(0, 120);
    if (typeof o[k] === 'number' && Number.isFinite(o[k])) return String(o[k]);
  }
  return '';
}
