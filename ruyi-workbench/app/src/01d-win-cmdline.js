// 01d-win-cmdline.js - 架构还债批 3·B: 从 01-config.js 搬出的 Windows 命令行包装与整行长度预算(batchSafeSpawn / cmd8191 防线;纯搬家,零行为变更)。
// Node >=18.20/20.12/22/24 refuse to spawn a .cmd/.bat with shell:false and throw "spawn EINVAL"
// (CVE-2024-27980). The intranet `claude` is almost always claude.cmd, so route batch launchers
// through cmd.exe with verbatim, manually-quoted args (the cross-spawn-proven pattern).
function isBatchLauncher(command) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(command || ''));
}
function quoteWinArg(a) {
  a = String(a);
  if (a === '') return '""';
  if (!/[\s"^&|<>()%!]/.test(a)) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}
// Returns { command, args, opts } ready for cp.spawn/spawnSync — transparently wrapping .cmd/.bat.
function batchSafeSpawn(command, args) {
  if (!isBatchLauncher(command)) return { command, args, opts: {} };
  const comspec = process.env.ComSpec || 'cmd.exe';
  const line = '"' + [command, ...args].map(quoteWinArg).join(' ') + '"'; // outer quotes stripped by /s
  return { command: comspec, args: ['/d', '/s', '/c', line], opts: { windowsVerbatimArguments: true } };
}

// ============================================================================
// cmd8191 防线(技能索引把 Claude CLI 命令行顶爆事故的根治): Windows 上 .cmd/.bat 启动器(claude.cmd)经
// cmd.exe /d /s /c 执行,cmd 对整条命令行有 8191 字符硬上限 —— 超限直接报「命令行太长。」退出码 1,claude
// 进程根本没启动。历史上 --append-system-prompt 钳 8000、--agents 钳 6000,两个各自合理的局部钳制相加
// (14000)远超整行预算 —— 局部钳制 ≠ 全局不变量。这里的防线把不变量收拢到一个汇合点:组装完 args 后用与
// batchSafeSpawn【严格同构】的构造核算整行长度,超限走确定性降级阶梯(见 runClaudeTurn 组装段)。
const CMD_EXE_LINE_LIMIT = 8191;          // cmd.exe /c 命令行硬上限(文档值)
const CMD_LINE_SAFE_BUDGET = 7900;        // 整行(含 comspec 路径与 /d /s /c 前缀)安全预算,留本地化/引号余量
const DIRECT_SPAWN_LINE_BUDGET = 32000;   // 直启(.exe/node)走 CreateProcess,上限 32767
const CMD_LINE_QUOTE_MARGIN = 48;         // quoteWinArg 引号翻倍等二阶效应的预留
// Off-by-default 测试缝: 强制预算值并让长度核算一律走 cmd 公式(即使启动器不是 .cmd)——e2e 借此在
// WCW_FAKE_CLAUDE(node 直启)下精确演练降级阶梯,无需真实 cmd.exe。
function cmdLineBudgetSeam() {
  const v = Number(process.env.WCW_CLAUDE_CMDLINE_BUDGET);
  return Number.isFinite(v) && v > 200 ? Math.floor(v) : 0;
}
// 本次 spawn 适用的整行字符预算;0 = 不设防(非 Windows: execve 上限 ~2MB,无 cmd 路径,保持行为逐字节不变)。
function cmdLineBudgetFor(command) {
  const seam = cmdLineBudgetSeam();
  if (seam) return Math.min(seam, CMD_EXE_LINE_LIMIT);
  if (process.platform !== 'win32') return 0;
  return isBatchLauncher(command) ? CMD_LINE_SAFE_BUDGET : DIRECT_SPAWN_LINE_BUDGET;
}
// 与 batchSafeSpawn 的行构造严格同构(改 batchSafeSpawn 必须同步改这里;e2e 有断言)。核算的就是 cmd.exe
// 实际解析的那一整行: "<comspec>" /d /s /c "<quoted join>"。测试缝开启时一律走 cmd 公式(模拟包装)。
function spawnCmdLineLength(command, args) {
  if (isBatchLauncher(command) || cmdLineBudgetSeam()) {
    const comspec = process.env.ComSpec || 'cmd.exe';
    const line = '"' + [command, ...args].map(quoteWinArg).join(' ') + '"';
    return `${comspec} /d /s /c ${line}`.length;
  }
  // 直启粗估(Node 自行 quoting): 只用于 32K 量级的宽松判断,无需精确。
  return String(command).length + args.reduce((n, a) => n + String(a).length + 3, 1);
}
