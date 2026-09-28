// 01f-agent-cli-types.js - 架构还债批 4: Agent CLI 类型登记表(从 01-config.js 搬出并扩成唯一登记处)与 CLI 类型归一。
// v2.8: the historical "Claude engine" is now an Agent CLI host. Keep claudePath and the engine id for
// session/API compatibility, while selecting a protocol-specific launcher here. Kimi uses the official
// interactive ACP JSON-RPC stream (including reverse permission/question requests).
//
// 加第三个 agent CLI = 在这里登记一项 + 在 05 AGENT_CLI_ADAPTERS 给一份适配器(unit/agent-cli-adapters 钉两张表键集合相同、
// 各项成员齐全)。这里放 01/02 层就要用到的「这一家是谁、装在哪、怎么起」;回合与回合外能力(模型清单、原生压缩、
// 上下文探测、环境说明……)在 05 的适配器上。
//
// 本模块零出边、不进依赖环:02e 的会话路由归一与 01 的配置归一都要问「这是不是一个登记过的 CLI」,而 02e 够不着 01
// (引用 01 会把它拽进 SCC)。所以登记项里要用 01 实现的钩子(路径探测、npm 入口、MCP 同步)都经第一个参数 cliHost
// 拿(01 的 AGENT_CLI_HOST),不直接引用 01 的符号;装机候选只吃 { env, home, join } 三样,纯函数。
//
// 每项成员:
//   id / label / pathKey / detectedKey / streaming / interactive / mcp   数据(经 /api/status 的 agentCliDrivers 原样下发)
//   installCandidates({ env, home, join })   默认安装位置候选(按序探测;Claude 有自己的启动器解析,为空)
//   detectPath(cliHost)                      自动探测到的启动器路径('' = 没找到)
//   prepareSpawn(cliHost, command, argv)     起子进程的 { command, args, opts }(.cmd 走 cmd.exe、npm 垫片改 Node 直启……)
//   syncMcpManifest(cliHost, config) async   把如意的 MCP 清单推进这家 CLI 自己的用户配置(走命令行参数的 CLI 给空操作)
// 函数成员在 JSON 里自然消失,所以 /api/status 下发的形状与只有数据成员时逐字节相同 —— 钩子一律是函数,
// 不用 null 表示「没有这一步」(null 会出现在下发的 JSON 里)。
const AGENT_CLI_DEFAULT_TYPE = 'claude';
const AGENT_CLI_TYPES = Object.freeze({
  claude: Object.freeze({
    id: 'claude', label: 'Claude Code', pathKey: 'claudePath', detectedKey: 'detectedClaudePath', streaming: true, interactive: true, mcp: 'argument',
    installCandidates: () => [],
    detectPath: cliHost => cliHost.detectClaudePath(),
    // Route the real CLI through cmd.exe when it's a .cmd/.bat (fixes "spawn EINVAL" on modern Node).
    prepareSpawn: (cliHost, command, argv) => batchSafeSpawn(command, argv),
    // Claude 每回合经 --mcp-config 拿如意的 MCP 配置(05 适配器 buildArgs),没有用户配置文件要推。
    syncMcpManifest: async () => {},
  }),
  kimi: Object.freeze({
    id: 'kimi', label: 'Kimi Code', pathKey: 'kimiPath', detectedKey: 'detectedKimiPath', streaming: true, interactive: true, mcp: 'user-config',
    installCandidates({ env, home, join }) {
      const npmDir = home && join(home, 'AppData', 'Roaming', 'npm');
      return [
        env.KIMI_CLI_PATH, 'kimi.cmd', 'kimi.exe', 'kimi',
        npmDir && join(npmDir, 'kimi.cmd'),
        home && join(home, '.local', 'bin', 'kimi.exe'),
        home && join(home, '.local', 'bin', 'kimi'),
      ].filter(Boolean);
    },
    detectPath: cliHost => cliHost.detectFromInstallCandidates('kimi'),
    prepareSpawn(cliHost, command, argv) {
      // npm's shim goes through cmd.exe (8191-char ceiling). Resolve its deterministic package-relative entry
      // and launch with Node directly, matching the Claude shim escape hatch's intent. This also handles
      // PowerShell's `kimi.ps1` shim, so a saved terminal launcher behaves the same as `kimi.cmd`.
      const entry = cliHost.resolveKimiNpmEntry(command);
      const nodeExe = cliHost.bundledNodeExe();
      // In a packaged release process.execPath is Ruyi.exe, not Node. The offline packages deliberately ship
      // runtime/node/node.exe; use that runtime so the same direct-entry launch works in both source and ZIP builds.
      if (entry && nodeExe) return { command: nodeExe, args: [entry, ...argv], opts: {} };
      return batchSafeSpawn(command, argv);
    },
    syncMcpManifest: (cliHost, config) => cliHost.syncMcpServersToKimi(config),
  }),
});

// 「这是不是一个登记过的 CLI 类型」—— 只认登记表自己的键(不认 toString / constructor 这类原型链上的名字)。
function isAgentCliType(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(AGENT_CLI_TYPES, value);
}
// 全仓唯一的 CLI 类型归一:登记过的原样返回,其余(缺失、空串、野值、非字符串)一律回落 fallback(默认 claude)。
// 修前各处写的是 `x === 'kimi' ? 'kimi' : 'claude'`,第三家会被静默改写成 claude。
function normalizeAgentCliType(value, fallback = AGENT_CLI_DEFAULT_TYPE) {
  return isAgentCliType(value) ? value : fallback;
}
