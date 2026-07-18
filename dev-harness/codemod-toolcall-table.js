// 第41波(V2.0「立柱」41a)一次性 codemod:toolCall() 的 50 分支 switch → 分组表驱动注册表。
// 机械转换,零转写风险:case 体逐字节搬入 handler,行结束符保持原样。
// 用法:node dev-harness/codemod-toolcall-table.js [--dry]
'use strict';
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const src = fs.readFileSync(FILE, 'utf8');

// ── ① 定位 toolCall 函数体 ──
const startMark = 'async function toolCall(name, args = {}, ctx = null) {';
const startIdx = src.indexOf(startMark);
if (startIdx < 0) throw new Error('toolCall 起点未找到');
const endMark = '\nlet LAUNCH_MODE';
const endIdx = src.indexOf(endMark, startIdx);
if (endIdx < 0) throw new Error('toolCall 终点未找到');
const fnText = src.slice(startIdx, endIdx);

// ── ② 切 case 段(4 空格锚定,nested switch 更深不中招;注释归下一段) ──
const lines = fnText.split('\n');
const segs = []; // {name, caseLine, bodyLines}
let cur = null;
let sawDefault = false;
for (const line of lines) {
  const m = line.match(/^    case '([^']+)':\s*(.*)$/);
  if (m) { cur = { name: m[1], firstRest: m[2], bodyLines: [] }; segs.push(cur); continue; }
  if (/^    default:/.test(line)) { sawDefault = true; cur = null; continue; }
  if (!cur) continue; // switch 头/default 体(未知工具 throw,新 toolCall 自带)
  cur.bodyLines.push(line);
}
if (!sawDefault) throw new Error('default 分支未找到,switch 形状已变,人工介入');

// ── ③ 每段:剥 case 行/包装块;段尾注释(trivia)移交给下一段开头 ──
for (const seg of segs) {
  // case 行尾直接带代码的单行形式:case 'x': return f(...);
  if (seg.firstRest && seg.firstRest !== '{') seg.bodyLines.unshift('      ' + seg.firstRest);
  // 先剥段尾注释(trivia,属下一段),再验包装块收尾
  seg.trivia = [];
  while (seg.bodyLines.length && (/^\s*(\/\/|$)/.test(seg.bodyLines[seg.bodyLines.length - 1]))) {
    seg.trivia.unshift(seg.bodyLines.pop());
  }
  // 包装块形式 case 'x': { → 剥最后的 4 空格 }
  if (seg.firstRest === '{') {
    const last = seg.bodyLines[seg.bodyLines.length - 1];
    if (last !== '    }') throw new Error(`case ${seg.name} 包装块收尾异常: ${JSON.stringify(last)}`);
    seg.bodyLines.pop();
  }
}
// trivia 移交:段 i 的尾部注释属于段 i+1
for (let i = 0; i < segs.length - 1; i++) {
  if (segs[i].trivia.length) { segs[i + 1].bodyLines.unshift(...segs[i].trivia); segs[i].trivia = []; }
}
// 尾段 trivia(纯空行)丢弃
for (const seg of segs) {
  while (seg.bodyLines.length && seg.bodyLines[seg.bodyLines.length - 1] === '') seg.bodyLines.pop();
}

// ── ④ 分组 + 41b 声明(paths/guardNote) ──
// paths: 'read'|'write'|'both'|'conditional' → handler 内必须过 guardFileToolPath/guardDownloadDest(行为锁校验);
//        null → 不触文件路径,guardNote 必须录理由(设计豁免/权限门/纯网络/loopback)。
const GROUPS = {
  CORE: {
    tool_search: [null, '目录检索控制面,不触文件路径'],
    tool_load: [null, '元工具提示,不触文件路径'],
    tool_invoke_read: [null, '代理分发:桥接工具经 bridgedWriteRelativePathArg/journalBridgedWrite;原生目标递归回本注册表走各自 guard'],
    tool_invoke_edit: [null, '代理分发:同 tool_invoke_read'],
    tool_invoke_exec: [null, '代理分发:同 tool_invoke_read'],
    permission_prompt: [null, 'CLI 权限桥 loopback,不触文件路径(fail-closed)'],
    request_user_input: [null, 'loopback 提问,不触文件路径'],
    todo_write: [null, '任务清单经 loopback /api/todo 落会话,不触任意文件路径'],
    mission_update: [null, '任务账本经 loopback /api/mission 落会话,不触任意文件路径'],
  },
  FILE: {
    file_read: ['read', ''],
    file_write: ['write', ''],
    file_edit: ['write', ''],
    file_delete: ['write', ''],
    file_move: ['both', ''],
    file_copy: ['both', ''],
    file_list: ['read', ''],
    file_search: ['read', ''],
    glob: ['read', ''],
    project_snapshot: ['read', ''],
  },
  ARCHIVE: {
    archive_zip: ['both', ''],
    archive_unzip: ['both', ''],
  },
  SHELL: {
    powershell_run: [null, '任意 shell 命令,exec tier+权限弹窗/授权书把守;路径闸对自由命令不可施'],
    script_run: [null, '任意脚本执行(落 generated/scripts 应用自选目录),exec tier+权限链把守;Office 手写软闸内置'],
    shell_start: [null, '持久 shell 会话状态面,exec tier 门+MCP 子进程拒;不直接触文件路径'],
    shell_send: [null, '同 shell_start'],
    shell_poll: [null, '同 shell_start'],
    shell_kill: [null, '同 shell_start'],
    shell_list: [null, '会话清单只读,不触文件路径'],
  },
  DESKTOP: {
    desktop_screenshot: ['conditional', '仅当模型给定 outputPath 才过写闸;缺省落 generated/ 应用自选目录(第36波录在案)'],
    keyboard_send_keys: [null, '键盘注入,不触文件路径'],
    office_open: [null, '第36波录在案:不加读闸(打开不回流模型;exec tier 权限门);v1.4.6-S2 无 shell spawn'],
  },
  NETWORK: {
    web_search: [null, '纯网络读;searchBackend 为管理端可信端点(SSRF 豁免录在案 v0.9-S9)'],
    web_fetch: [null, '纯网络读,SSRF 全套护栏内置(ssrfCheck/dnsResolvesToPrivate 逐跳)'],
    http_request: [null, '纯网络调用,不触文件路径'],
    http_download: ['write', ''],
    browser_open: [null, 'spawn 默认浏览器(buildBrowserOpenSpawn 无 shell);exec tier 门,不触文件路径'],
  },
  CODE: {
    git_status: [null, 'git 子进程 execFile 无 shell;cwd 经 resolveGitCwd(存在的目录才用);只读检查'],
    git_diff: [null, '同 git_status;另 --no-ext-diff/--no-textconv 关外部执行面'],
    git_log: [null, '同 git_status'],
    git_commit: [null, 'git 子进程 execFile 无 shell;exec tier(commit 触发 hooks)录在案;cwd 经 resolveGitCwd'],
    dependency_inventory: [null, '只读盘点,walkFiles 自带敏感子树跳过'],
    code_review_scan: [null, '只读扫描,walkFiles 自带敏感子树跳过'],
    frontend_audit: [null, '只读扫描,walkFiles 自带敏感子树跳过'],
    claude_md_audit: [null, '只读扫描,walkFiles 自带敏感子树跳过'],
    docs_search: [null, '只读搜索,walkFiles 自带敏感子树跳过'],
  },
  AGENT: {
    spawn_agent: [null, '无回合上下文一律拒绝(特例闭包在 runOpenAiTurn)'],
    orchestrate_agents: [null, 'MCP 子进程 loopback /api/agent-workflow/launch;无会话上下文拒绝'],
  },
  INTEGRATION: {
    skill_read: [null, '技能目录内自守:注册表 dir 解析+path.relative 双保险防穿越(非工作区闸,设计录在案)'],
    mcp_list: [null, '配置盘点(env 脱敏),不触文件路径'],
    mcp_configure: [null, '写应用配置(exec tier 门),不触任意文件路径'],
  },
};

// 覆盖校验:case 集与声明集必须精确相等(漏声明/多声明 = codemod 拒绝落地)
const caseNames = segs.map(s => s.name);
const declNames = Object.values(GROUPS).flatMap(g => Object.keys(g));
const missing = caseNames.filter(n => !declNames.includes(n));
const extra = declNames.filter(n => !caseNames.includes(n));
const dup = declNames.filter((n, i) => declNames.indexOf(n) !== i);
if (missing.length || extra.length || dup.length) {
  throw new Error(`声明集与 case 集不一致: missing=${missing} extra=${extra} dup=${dup}`);
}
if (new Set(caseNames).size !== caseNames.length) throw new Error('switch 内存在重名 case');

// ── ⑤ 发射 ──
const out = [];
out.push('// 第41波(V2.0「立柱」41a): toolCall() 50 分支 switch → 分组表驱动注册表。');
out.push('// 每个工具声明 { paths, guardNote, handler }:');
out.push("//   paths: 'read'|'write'|'both' → handler 内必须对模型给定路径过 guardFileToolPath(read=读闸/write=写闸/both=双闸);");
out.push("//          'conditional' → 仅当模型给定路径参数时过闸(缺省落应用自选目录,录在案);");
out.push('//          null → 不触文件路径,guardNote 必须录理由(exec 权限门/纯网络/loopback/设计豁免)。');
out.push('// 41b 行为锁(dev-harness/tool-dispatch.e2e.js): edit/exec 级且 paths 非 null 的条目,handler 源必须含 guard');
out.push('// 调用;paths:null 必须有非空 guardNote;注册表键集 === NATIVE_TOOL_PACKS 键集(目录漂移=锁红)。');
out.push('// 新工具忘了声明 = 锁红 —— archive 漏 guard(第27波)、desktop_screenshot 越界写(第36波)这类漏审整类收口。');
for (const [gname, tools] of Object.entries(GROUPS)) {
  out.push(`const ${gname}_TOOL_HANDLERS = {`);
  for (const [tname, [paths, note]] of Object.entries(tools)) {
    const seg = segs.find(s => s.name === tname);
    const decl = paths === null
      ? `paths: null, guardNote: ${JSON.stringify(note)}`
      : `paths: ${JSON.stringify(paths)}, guardNote: ''`;
    out.push(`  ${tname}: { ${decl}, handler: async (args, ctx) => {`);
    out.push(...seg.bodyLines);
    out.push('  } },');
  }
  out.push('};');
  out.push('');
}
out.push('const TOOL_HANDLERS = Object.freeze(Object.assign({},');
out.push('  CORE_TOOL_HANDLERS, FILE_TOOL_HANDLERS, ARCHIVE_TOOL_HANDLERS, SHELL_TOOL_HANDLERS,');
out.push('  DESKTOP_TOOL_HANDLERS, NETWORK_TOOL_HANDLERS, CODE_TOOL_HANDLERS, AGENT_TOOL_HANDLERS,');
out.push('  INTEGRATION_TOOL_HANDLERS));');
out.push('// 装时机断言:组间重名会被 Object.assign 静默覆盖 —— 启动即炸,不允许带病运行(行为锁另有 e2e)。');
out.push('{');
out.push('  const declared = [CORE_TOOL_HANDLERS, FILE_TOOL_HANDLERS, ARCHIVE_TOOL_HANDLERS, SHELL_TOOL_HANDLERS,');
out.push('    DESKTOP_TOOL_HANDLERS, NETWORK_TOOL_HANDLERS, CODE_TOOL_HANDLERS, AGENT_TOOL_HANDLERS, INTEGRATION_TOOL_HANDLERS]');
out.push('    .reduce((n, g) => n + Object.keys(g).length, 0);');
out.push("  if (declared !== Object.keys(TOOL_HANDLERS).length) throw new Error('TOOL_HANDLERS: 组间存在重名工具,注册表被静默覆盖');");
out.push('}');
out.push('');
out.push(startMark);
out.push('  const entry = TOOL_HANDLERS[name];');
out.push('  if (!entry) throw new Error(`Unknown tool: ${name}`);');
out.push('  return entry.handler(args, ctx);');
out.push('}');

const next = src.slice(0, startIdx) + out.join('\n') + src.slice(endIdx);
if (process.argv.includes('--dry')) {
  console.log(`cases=${caseNames.length} emitted=${declNames.length} bytes ${src.length} → ${next.length}`);
} else {
  fs.writeFileSync(FILE, next, 'utf8');
  console.log(`OK: ${caseNames.length} handlers, bytes ${src.length} → ${next.length}`);
}
