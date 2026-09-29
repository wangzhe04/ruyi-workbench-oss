// 00b-ruyi-names.js - 3.0 收口:如意自有的对外标识(原 v1.0-S9 注释里「建议 v2.0 收口」的存量兼容标识)。
// 零出边(不引用任何其他模块的顶层符号),排在 00-boot 之后;所有用到 MCP server id 的模块都只引用这里,不进依赖环。
// 数据目录的新旧名在 00-boot(路径表 paths 在那里、加载即算)。

// 3.0 收口:如意自己的 MCP server id。Claude Code / Kimi Code 里看到的工具名是 mcp__ruyi__<工具>(修前是
// mcp__win-claude-workbench__<工具>)。旧 id 只用来认出并清掉存量登记(Kimi 的 mcp.json 由所有权旁车自动清,
// Claude Code 的用户登记在 install 时一并移除),以及在导入外部连接器时继续当保留名。
const RUYI_MCP_SERVER_ID = 'ruyi';
const LEGACY_RUYI_MCP_SERVER_IDS = Object.freeze(['win-claude-workbench']);
const RUYI_MCP_CLI_TOOL_PREFIX = `mcp__${RUYI_MCP_SERVER_ID}__`;
function isRuyiMcpServerId(id) {
  return id === RUYI_MCP_SERVER_ID || LEGACY_RUYI_MCP_SERVER_IDS.includes(id);
}
// 存量配置(Agent 角色的 mcpServers 白名单)里写的旧 id 一律当新 id 认,否则改名后如意自己的 MCP 会被白名单滤掉。
function canonicalRuyiMcpServerId(id) {
  return isRuyiMcpServerId(id) ? RUYI_MCP_SERVER_ID : id;
}
