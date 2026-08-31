// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 第27波(AUTONOMY-PLAN §27):自主性授权书(Autonomy Grant)—— 现有权限系统的严格【子集缓存】,不是新权限来源。
// 只做一件事:在用户【预先经 UI header token 明示】的「工具 × 路径 × 命令 × 次数 × 时长」笼子内,把工具决策点
// 本会弹出的 gate:'ask' 就地降为 'allow' 并计数;范围外一切照旧弹窗。解决第25/26波痛点:until-done 长任务一遇
// exec 弹窗(120s 超时自动拒)就死。三条硬不变式(写死在码):
//   ① 子集律:只 ask→allow,【永不】 block→allow。plan 的 block、越界写 DENY、敏感路径 denylist 全在其上,授权书
//      一律不触碰(consumeGrant 只在 gate==='ask' 分支被调用,结构上够不到 block)。permissionMode 恒为天花板。
//   ② 签发主权律:签发/撤销唯一入口 = UI header token(tokenOk / trusted)。body-token(MCP child loopback,模型
//      可间接触达)【永无签发能力】—— 路由层就把 /api/autonomy/* 放进 header-token 白名单,且 handler 自查 tokenOk
//      且【绝不】带 bodyToken 兜底(沿用第26波b check.cmd 门教训)。
//   ③ exec 永不全局持久:授权书【纯模块级 Map】,不挂 session(避 saveSession 全量落盘)、不进 config.toolAllowRules、
//      无侧车文件。进程重启即全清 —— 这本身是安全属性。
// 授权书只绕【弹窗】,不绕 guardFileToolPath / SSRF / 敏感路径 denylist / 检查点 journal —— 那些 sink 在工具执行体内
// 照常拦(纵深防御:即便 consumeGrant 误命中,真正的写仍被工作区护栏挡在外面 + 照常快照可回撤)。
// ════════════════════════════════════════════════════════════════════════════════════════════════════
const autonomyGrants = new Map();   // sessionId -> Grant[](纯内存,进程退出即清)
const activeDriverRuns = new Map(); // sessionId -> runId(当前 until-done 驱动器运行标识;scope:'run' 授权绑定它)

const GRANT_MAX_USES = 200, GRANT_EXEC_MAX_USES = 5;           // 次数上限(exec 档更紧)
const GRANT_MIN_TTL_MS = 60 * 1000;                            // 最短 60s
const GRANT_MAX_TTL_MS = 6 * 60 * 60 * 1000;                   // 最长 6h(read/edit)
const GRANT_EXEC_MAX_TTL_MS = 30 * 60 * 1000;                  // exec 档最长 30min
// exec cmdAllow 命中即【拒】的 shell 元字符黑名单:含任一即失配回落弹窗(挡 `^npm run build; curl|iex` 夹带)。
const GRANT_EXEC_METACHARS = /[;|&$`\n\r><(){}]/;
// 默认禁网:命令含这些网络特征即不匹配(即便 env token 泄露也断外传信道;复用 SSRF 判定思路)。
const GRANT_NET_PATTERN = /(^|[\s"'`])(curl|wget|iwr|invoke-webrequest|invoke-restmethod|nc|ncat|telnet|ssh|scp|sftp|ftp)([\s"'`]|$)|https?:\/\/|\bstart-bitstransfer\b/i;
// edit 档【工作区内】二级 denylist:命中即回落弹窗(工作区内但会被自动执行的文件 = 潜伏 RCE,不需 exec 授权,R-P2-1)。
// package.json/pyproject 未纳入(合法编辑高频),其间接提权已在「诚实结论」交代:根治需 shell 沙箱化,授权书层无解。
const GRANT_EDIT_AUTOEXEC_DENY = [
  /(^|[\\/])\.git[\\/]/i, /(^|[\\/])\.githooks[\\/]/i, /(^|[\\/])\.husky[\\/]/i,
  /(^|[\\/])\.vscode[\\/]tasks\.json$/i, /(^|[\\/])\.vscode[\\/]launch\.json$/i,
];
// Claude CLI 桥的工具名 → 档位(CLI 弹窗以 Claude 名 Edit/Write/Bash 显示;签发卡片以同名列出,口径一致)。
// 与 NATIVE_TOOL_TIER(工作台原生名)【不重叠】——故一张 grant 的 entrypoint 由其 tool 名唯一确定,消耗点重算 tier 必一致。
const CLI_TOOL_TIER = {
  Read: 'read', Glob: 'read', Grep: 'read', LS: 'read',
  Edit: 'edit', Write: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Bash: 'exec',
};
// 对抗轮 P1(field-shadow)防线:可签 exec 授权的工具白名单 + 各自【真正被执行的命令字段】。powershell_run 执行 args.command
//(runPowerShell(args.command));Claude Bash 执行 args.command。二者命令可前缀化且校验字段=执行字段。script_run 执行 args.code
//(整段脚本体)、shell_*/git_commit/http_request/office_open/browser_open/keyboard_send_keys/desktop_screenshot 等语义不符 → 不入表。
const GRANT_EXEC_TOOLS = new Set(['powershell_run', 'Bash']);
const GRANT_EXEC_CMD_FIELD = { powershell_run: 'command', Bash: 'command' };
// 签发时推断 entrypoint + tier(不信任调用方传入的 tier;消耗点再按 entrypoint 重算)。未知工具 → null(拒绝签发,
// 无法精确 gate 的工具不给授权)。禁 spawn_agent/orchestrate_agents(红线#4:防子代理递归放大授权)。
function grantIssueTierInfo(tool) {
  const t = String(tool || '');
  if (t === 'spawn_agent' || t === 'orchestrate_agents' || t === '*' || !t) return null;
  let info = null;
  if (Object.prototype.hasOwnProperty.call(NATIVE_TOOL_TIER, t)) info = { entrypoint: 'native', tier: NATIVE_TOOL_TIER[t] };
  else if (Object.prototype.hasOwnProperty.call(CLI_TOOL_TIER, t)) info = { entrypoint: 'cli', tier: CLI_TOOL_TIER[t] };
  if (!info) return null;
  // 对抗轮 P1(field-shadow):exec 授权只允许【命令可前缀化 且 校验字段=执行字段】的工具。script_run 执行 args.code
  // (整段脚本体,非可前缀化命令)、shell_*/git_commit/http_request 等执行字段与 cmdAllow 语义不符 → 一律不可签 exec 授权
  //(否则「校验 command、执行 code」= 绕过 cmdAllow 的任意 RCE)。仅 powershell_run(native)/Bash(cli)执行 args.command,可签。
  if (info.tier === 'exec' && !GRANT_EXEC_TOOLS.has(t)) return null;
  return info;
}
// 统一上下文解析器(红队 R-P1-2 核心):按 entrypoint 感知【参数形状】抽 {tier, fileFamily, pathArgs[], cmdArg, cwdArg}。
// 绝不跨形状复用键(native 用 path/source/dest,CLI 用 file_path/command)——否则文件族授权抽不到路径 → pathGlob 真空
// 满足 → 越界放行。文件族无法解析出任一受控路径 → 由 consumeGrant fail-closed 回落弹窗,【绝不真空放行】。纯字符串,无 I/O。
const NATIVE_FILE_FAMILY = new Set(['file_read', 'file_write', 'file_edit', 'file_delete', 'file_move', 'file_copy', 'archive_zip', 'archive_unzip', 'http_download', 'file_list', 'file_search', 'glob', 'project_snapshot']);
const CLI_FILE_FAMILY = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'LS', 'Glob', 'Grep']);
function resolveToolPermissionContext(name, args, entrypoint) {
  const input = (args && typeof args === 'object') ? args : {};
  const tool = String(name || '');
  const pathArgs = [];
  let cmdArg = null, cwdArg = null, tier = 'exec', fileFamily = false;
  const pushPath = v => { if (typeof v === 'string' && v.trim()) pathArgs.push(v.trim()); };
  if (entrypoint === 'cli') {
    tier = CLI_TOOL_TIER[tool] || 'exec';
    fileFamily = CLI_FILE_FAMILY.has(tool);
    // Claude CLI 形状:Edit/Write/Read → file_path;NotebookEdit → notebook_path;LS → path;Bash → command。
    for (const k of ['file_path', 'notebook_path', 'path']) pushPath(input[k]);
    if (tool === 'Bash') cmdArg = typeof input.command === 'string' ? input.command : '';
  } else { // 'native'
    tier = nativeToolTier(tool);
    fileFamily = NATIVE_FILE_FAMILY.has(tool);
    // 对抗轮 P2-GapA/P3:按【所有工具的真实形参名】取【全部触及路径】—— file_move/file_copy 用 from/to、archive_unzip 用
    // src/destDir、archive_zip 的源是【数组】paths[]。缺任一 → 该工具的授权书要么真空放行(源不受控)要么永不可消耗(fail-closed)。
    // 补齐后:consumeGrant 对每条路径(含数组源)都验 grantRoot/denylist/glob → 授权书对这些工具既生效又受约束。
    for (const k of ['path', 'source', 'destination', 'dest', 'output', 'output_path', 'root', 'from', 'to', 'src', 'destDir']) pushPath(input[k]);
    if (Array.isArray(input.paths)) for (const p of input.paths) pushPath(p);
    // 对抗轮 P1(field-shadow):按【真正被执行的字段】取命令,绝不 OR-merge 多字段 —— powershell_run 只执行 args.command
    //(见 case 'powershell_run')。未在 GRANT_EXEC_CMD_FIELD 映射的 exec 工具 → cmdArg=null → consumeGrant 恒不命中(fail-closed)。
    if (tier === 'exec') { const f = GRANT_EXEC_CMD_FIELD[tool]; cmdArg = f ? String(input[f] || '') : null; }
    if (typeof input.cwd === 'string' && input.cwd.trim()) cwdArg = input.cwd.trim();
  }
  return { tool, tier, fileFamily, pathArgs, cmdArg, cwdArg };
}
// 规范化签发请求 → 冻结的 Grant(纯函数,无 I/O)。返回 {ok, grant?, error?, dropped:[{glob,reason}]}。
// grantRoot 签发时冻结(glob 相对它解析);pathGlob 逐条:禁 '..'、须落 grantRoot 内、不撞敏感 denylist,越界丢弃并记因。
function normalizeGrant(raw, session, config, now) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const info = grantIssueTierInfo(r.tool);
  if (!info) return { ok: false, error: '未知或禁止授权的工具名(不可对 spawn_agent/orchestrate_agents 或通配符签发)' };
  const { entrypoint, tier } = info;
  const grantRoot = normalizeCwd(session && session.cwd, config && config.defaultWorkspace);
  if (!grantRoot || !path.isAbsolute(grantRoot)) return { ok: false, error: '无法确定授权工作区根' };
  // pathGlob 规范化(文件族才有意义):禁 '..'、绝对路径条目须落 grantRoot 内,否则裁剪。
  const dropped = [];
  const pathGlob = [];
  for (const raw0 of (Array.isArray(r.pathGlob) ? r.pathGlob : [])) {
    const g0 = String(raw0 || '').trim().replace(/\\/g, '/');
    if (!g0) continue;
    if (g0.split('/').some(seg => seg === '..')) { dropped.push({ glob: g0, reason: '含 .. 上跳,已裁剪' }); continue; }
    if (path.isAbsolute(g0)) {
      // 绝对 glob:其静态前缀须落在 grantRoot 内(带 * 的部分之前的目录段)。
      const staticPrefix = g0.split(/[*?]/)[0];
      const absPrefix = path.resolve(staticPrefix);
      if (!pathWithinRoot(absPrefix, grantRoot)) { dropped.push({ glob: g0, reason: '绝对路径越出授权工作区根,已裁剪' }); continue; }
      pathGlob.push(path.relative(grantRoot, absPrefix).replace(/\\/g, '/') + g0.slice(staticPrefix.length));
    } else {
      pathGlob.push(g0);
    }
  }
  // 文件族但没给任何 pathGlob → 默认 '**'(整个 grantRoot);但敏感 denylist/越界仍在 consume 逐路径兜底。
  if ((tier === 'read' || tier === 'edit') && pathGlob.length === 0) pathGlob.push('**');
  // cmdAllow(exec 必填):逐条锚定前缀(存去 '^' 的字面前缀);含元字符的前缀本身拒收(防 `npm; curl` 混入)。
  const cmdAllow = [];
  for (const raw1 of (Array.isArray(r.cmdAllow) ? r.cmdAllow : [])) {
    let p0 = String(raw1 || '').trim();
    if (p0.startsWith('^')) p0 = p0.slice(1);
    if (!p0) continue;
    if (GRANT_EXEC_METACHARS.test(p0)) { dropped.push({ glob: p0, reason: 'cmdAllow 前缀含 shell 元字符,已剔除' }); continue; }
    cmdAllow.push(p0);
  }
  if (tier === 'exec' && cmdAllow.length === 0) return { ok: false, error: 'exec 类授权必须提供至少一条合法的 cmdAllow 命令前缀' };
  const isExec = tier === 'exec';
  const maxUsesCap = isExec ? GRANT_EXEC_MAX_USES : GRANT_MAX_USES;
  const maxUses = Math.max(1, Math.min(maxUsesCap, Math.floor(Number(r.maxUses) || (isExec ? 3 : 20))));
  const ttlCap = isExec ? GRANT_EXEC_MAX_TTL_MS : GRANT_MAX_TTL_MS;
  const ttlMs = Math.max(GRANT_MIN_TTL_MS, Math.min(ttlCap, Math.floor(Number(r.ttlMs) || (isExec ? 15 * 60 * 1000 : 60 * 60 * 1000))));
  const scope = r.scope === 'session' ? 'session' : 'run';
  // scope:'run' 绑当前活动驱动器 run;无活动 run 时 runId='' 且 bindNextRun=true(驱动器启动时补绑,支持 run 启动前预承诺)。
  const curRun = (session && activeDriverRuns.get(session.id)) || '';
  const grant = {
    grantId: makeId('grant'),
    sessionId: session && session.id,
    entrypoint, tool: String(r.tool), tier,
    scope, runId: scope === 'run' ? curRun : '', bindNextRun: scope === 'run' && !curRun,
    grantRoot, pathGlob,
    cmdAllow, netAllowed: isExec ? Boolean(r.netAllowed) : false,
    maxUses, usedCount: 0,
    issuedAt: now, expiresAt: now + ttlMs, ttlMs,
    issuedBy: 'ui-token', revoked: false, revokedAt: 0,
  };
  return { ok: true, grant, dropped };
}
// 唯一收口:校验 + 计数消耗。【全程同步无 await】→ Node 单线程读改写不可分割(并发原子性根基)。命中 → usedCount++
// (不退还,工具失败不回补,杜绝失败重试刷额度)+ 审计 + 返回 {grantId, remaining, tool, tier};未命中 → null(回落弹窗)。
function consumeGrant(session, toolName, args, entrypoint, workingDir) {
  if (!session || !session.id) return null;
  const list = autonomyGrants.get(session.id);
  if (!list || !list.length) return null;
  const ctx = resolveToolPermissionContext(toolName, args, entrypoint);
  const now = Date.now();
  const curRun = activeDriverRuns.get(session.id) || '';
  for (const g of list) {
    if (g.revoked) continue;
    if (g.tool !== toolName) continue;                       // 精确工具名(禁通配)
    if (g.entrypoint !== entrypoint) continue;               // native grant 绝不被 CLI 调用命中,反之亦然
    if (now >= g.expiresAt) continue;                        // TTL 过期
    if (g.usedCount >= g.maxUses) continue;                  // 次数耗尽
    if (g.scope === 'run' && (!curRun || g.runId !== curRun)) continue; // scope 隔离(无活动 run 或 runId 不符/未绑定 → 不命中)
    if (ctx.tier !== g.tier) continue;                       // F5 自防御:tier 消耗点重算,不信签发快照
    if (g.tier === 'exec') {
      const cmd = String(ctx.cmdArg || '');
      if (!cmd) continue;                                    // exec 无命令 → 不命中
      if (GRANT_EXEC_METACHARS.test(cmd)) continue;          // 元字符 → 失配(挡夹带)
      if (!g.netAllowed && GRANT_NET_PATTERN.test(cmd)) continue; // 默认禁网 → 失配
      const trimmed = cmd.replace(/^\s+/, '');
      const okCmd = g.cmdAllow.some(p => {
        if (trimmed.toLowerCase().indexOf(p.toLowerCase()) !== 0) return false;  // 锚定前缀
        const after = trimmed.slice(p.length);
        return after === '' || /^\s/.test(after);            // 前缀后须 EOL 或空白(挡 `build`→`buildEVIL`)
      });
      if (!okCmd) continue;
      if (ctx.cwdArg) {                                       // 若显式给了 cwd,须落 grantRoot 内(禁工作区外)
        const absCwd = path.isAbsolute(ctx.cwdArg) ? path.resolve(ctx.cwdArg) : path.resolve(g.grantRoot, ctx.cwdArg);
        if (!pathWithinRoot(absCwd, g.grantRoot)) continue;
      }
    } else {
      if (ctx.fileFamily && ctx.pathArgs.length === 0) continue; // 文件族抽不到路径 → fail-closed(R-P1-2)
      let allOk = ctx.pathArgs.length > 0;
      for (const p of ctx.pathArgs) {
        const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(g.grantRoot, p);
        if (isSensitiveDataPath(abs)) { allOk = false; break; }          // 敏感 denylist 无条件先行
        if (!pathWithinRoot(abs, g.grantRoot)) { allOk = false; break; } // 须落授权根内
        const rel = path.relative(g.grantRoot, abs).replace(/\\/g, '/');
        // 对抗轮 P3:先对每个组件去尾点/尾空格再匹配 —— Win32 语义下 '.git.'/'.git ' 等价于 '.git',词法保留会绕过 denylist。
        const relN = rel.split('/').map(s => s.replace(/[. ]+$/, '')).join('/');
        if (g.tier === 'edit' && GRANT_EDIT_AUTOEXEC_DENY.some(re => re.test(relN) || re.test(rel) || re.test(abs))) { allOk = false; break; } // 工作区内自动执行文件
        if (g.pathGlob.length && !g.pathGlob.some(gl => globToRegExp(gl).test(rel))) { allOk = false; break; } // glob 匹配
      }
      if (!allOk) continue;
    }
    // ── 命中:同步消耗(读改写不可分割)──
    g.usedCount += 1;
    const remaining = g.maxUses - g.usedCount;
    let argsHash = '';
    try { argsHash = crypto.createHash('sha1').update(JSON.stringify(args || {})).digest('hex').slice(0, 12); } catch { /* best-effort */ }
    logEvent({ kind: 'autonomy_grant_consume', grantId: g.grantId, sessionId: session.id, tool: g.tool, tier: g.tier, scope: g.scope, usedCount: g.usedCount, maxUses: g.maxUses, remaining, argsHash });
    return { grantId: g.grantId, remaining, tool: g.tool, tier: g.tier };
  }
  return null;
}
// 撤销即时生效(consumeGrant 每次现读 Map、无飞行中缓存 → 下一次调用立即失配;进行中的单次调用不追溯)。
function revokeGrant(sessionId, grantId) {
  const list = autonomyGrants.get(sessionId);
  if (!list) return false;
  const g = list.find(x => x.grantId === grantId && !x.revoked);
  if (!g) return false;
  g.revoked = true; g.revokedAt = Date.now();
  logEvent({ kind: 'autonomy_grant_revoked', grantId: g.grantId, sessionId, tool: g.tool, tier: g.tier });
  return true;
}
function revokeAllGrants(sessionId, reason) {
  const list = autonomyGrants.get(sessionId);
  if (!list) return 0;
  let n = 0;
  for (const g of list) if (!g.revoked) { g.revoked = true; g.revokedAt = Date.now(); n++; }
  autonomyGrants.delete(sessionId);
  if (n) logEvent({ kind: 'autonomy_grant_revoked', sessionId, count: n, reason: reason || 'revoke-all' });
  return n;
}
// scope:'run' 授权在驱动器 run 结束/中止时蒸发(遍历删 runId 匹配项)。
function revokeGrantsForRun(sessionId, runId) {
  const list = autonomyGrants.get(sessionId);
  if (!list || !runId) return 0;
  let n = 0;
  for (const g of list) if (!g.revoked && g.scope === 'run' && g.runId === runId) { g.revoked = true; g.revokedAt = Date.now(); n++; }
  const live = list.filter(g => !g.revoked);
  if (live.length) autonomyGrants.set(sessionId, live); else autonomyGrants.delete(sessionId);
  if (n) logEvent({ kind: 'autonomy_grant_revoked', sessionId, runId, count: n, reason: 'run-ended' });
  return n;
}
// 驱动器 run 启动:登记活动 runId,并把该会话所有 bindNextRun 的 scope:'run' 授权补绑到本 run(支持 run 启动前预承诺)。
function bindDriverRun(sessionId, runId) {
  activeDriverRuns.set(sessionId, runId);
  const list = autonomyGrants.get(sessionId);
  if (list) for (const g of list) if (!g.revoked && g.scope === 'run' && g.bindNextRun && !g.runId) { g.runId = runId; g.bindNextRun = false; }
}
// UI 只读快照(不含可重建授权面的敏感细节顺序,但 UI 需要 glob/cmd 展示 → 给足;审计仍走 logEvent NDJSON)。
function listGrantsView(sessionId) {
  const now = Date.now();
  const list = autonomyGrants.get(sessionId) || [];
  return list.filter(g => !g.revoked && now < g.expiresAt && g.usedCount < g.maxUses).map(g => ({
    grantId: g.grantId, tool: g.tool, tier: g.tier, scope: g.scope,
    pathGlob: g.pathGlob, cmdAllow: g.cmdAllow, netAllowed: g.netAllowed,
    usedCount: g.usedCount, maxUses: g.maxUses, expiresAt: g.expiresAt, remainingMs: Math.max(0, g.expiresAt - now),
  }));
}
// 签发瞬间的 dry-run:有界遍历 grantRoot,统计将命中 pathGlob 的文件(所见即所授)。硬上限防病态目录:最多扫 SCAN_CAP
// 个条目,返回前 `limit` 个样本。跳过敏感 denylist / edit 自动执行 denylist(与 consume 同口径)。永不抛。
async function dryRunGrantFiles(grant, limit) {
  const root = grant.grantRoot;
  const globs = (grant.pathGlob || []).map(g => globToRegExp(g));
  const out = []; let count = 0, scanned = 0; const SCAN_CAP = 4000;
  const stack = [root];
  while (stack.length) {
    if (scanned >= SCAN_CAP) return { count, sample: out, truncated: true };
    const dir = stack.pop();
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (scanned >= SCAN_CAP) return { count, sample: out, truncated: true };
      scanned++;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === '.git' || ent.name === 'node_modules') continue; // 剪枝(不进 VCS/依赖树)
        stack.push(abs); continue;
      }
      if (!ent.isFile()) continue;
      if (isSensitiveDataPath(abs)) continue;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      const relN = rel.split('/').map(s => s.replace(/[. ]+$/, '')).join('/'); // 对抗轮 P3:组件去尾点/尾空格再匹配
      if (grant.tier === 'edit' && GRANT_EDIT_AUTOEXEC_DENY.some(re => re.test(relN) || re.test(rel) || re.test(abs))) continue;
      if (globs.length && !globs.some(re => re.test(rel))) continue;
      count++;
      if (out.length < limit) out.push(rel);
    }
  }
  return { count, sample: out, truncated: false };
}

// ────────────────────────────────────────────────────────────────────────────────────────────────────

