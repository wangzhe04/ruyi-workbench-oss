require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// 第22波(开放子代理工具面)回归锁:
//  能力面: ①Claude 子代理 read/edit 白名单含 WebSearch/WebFetch(两引擎联网能力对齐);②内置 explorer/reviewer/
//    verifier 角色 claudeTools 含联网;③OpenAI 子代理桥接 MCP 工具按 BRIDGED_TOOL_TIERS 分级参与所有层
//    (bridgedToolTier 过滤,不再 exec 一刀切)。
//  安全不变量(开放的边界,防未来误扩): ④Claude 路径 mcp-config 仍 exec-only(bypass 下 --allowed-tools 非硬限,
//    提前挂桥接面=桌面全控泄漏);⑤web_search/web_fetch 保持 read 级但 http_request 保持 exec、git_commit 保持
//    exec、spawn_agent 保持 exec + 子回合 noSpawnAgent;⑥bridgedToolTier 未知工具缺省 exec、用户覆盖生效。
'use strict';
const { readServerSource } = require('./src-reader');
const { functionBlock } = require('./lib/source-slice.js');
const fs = require('fs');
const path = require('path');
// 架构还债批 3·D:②⑤⑥ 断言的都是运行时可达的值(BUILTIN_AGENT_ROLES / NATIVE_TOOL_TIER / bridgedToolTier 经
// server.js 导出),改成直读产物;修前是逐行正则抠角色行、切 `const NATIVE_TOOL_TIER = {…};` 文本、
// 再把 bridgedToolTier 与两张依赖表 new Function 拼起来跑 —— 表挪文件、改成派生或换引号就静默失明。
// ①(CLAUDE_SUBAGENT_TIER_TOOLS 未导出)仍抽字面量求值;③④ 是「某函数体里有/没有某条调用」的结构判据,
// 改用公共切片取整个函数体(修前按 5000/6000 字截,函数一长就截断)。
const srv = require(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'server.js'));

let failures = 0;
function ok(cond, label) { if (cond) { console.log(`PASS ${label}`); } else { failures++; console.log(`FAIL ${label}`); } }

const src = readServerSource();

// ---- ① Claude tier 白名单(抽出实际求值,不靠正则目测) ----
{
  const m = src.match(/const CLAUDE_SUBAGENT_TIER_TOOLS = (\{[^;]+\});/);
  ok(!!m, '① CLAUDE_SUBAGENT_TIER_TOOLS 定义可抽取');
  if (m) {
    const t = new Function(`return ${m[1]};`)();
    ok(t.read.includes('WebSearch') && t.read.includes('WebFetch'), '① read 级含 WebSearch/WebFetch(研究/审查类节点可联网检索)');
    ok(t.edit.includes('WebSearch') && t.edit.includes('WebFetch'), '① edit 级含 WebSearch/WebFetch');
    ok(t.read.includes('Read') && t.read.includes('Grep') && t.read.includes('Glob') && !t.read.includes('Write') && !t.read.includes('Bash'), '① read 级仍无落盘/执行工具(Write/Bash 未混入)');
    ok(Array.isArray(t.exec) && t.exec.length === 0, '① exec 级保持空数组(=CLI 不限制,行为不变)');
  }
}

// ---- ② 内置角色联网 ----
{
  const role = id => (srv.BUILTIN_AGENT_ROLES || []).find(r => r && r.id === id);
  const online = id => { const r = role(id); return !!r && Array.isArray(r.claudeTools) && r.claudeTools.includes('WebSearch') && r.claudeTools.includes('WebFetch'); };
  ok(online('explorer'), '② explorer 角色 claudeTools 含联网(显式白名单覆盖 tier 缺省,必须单独补)');
  ok(online('reviewer'), '② reviewer 角色 claudeTools 含联网');
  ok(online('verifier'), '② verifier 角色 claudeTools 含联网');
}

// ---- ③ OpenAI 子代理桥接分级(runSubAgentCore 源检查) ----
// 回合引擎审计 t8:runSubAgentCore 成了只管「任何出口都停心跳」的外壳,子回合本体在 runSubAgentCoreBody —— 判据切本体。
{
  ok(/return await runSubAgentCoreBody\(opts, lifecycle\)/.test(functionBlock(src, 'runSubAgentCore')), '③ runSubAgentCore 外壳委托本体 runSubAgentCoreBody');
  const fnSlice = functionBlock(src, 'runSubAgentCoreBody');
  ok(fnSlice.length > 0, '③ runSubAgentCore 存在');
  ok(!/if \(tier === 'exec'\) \{ try \{ bridged = await collectBridgedTools/.test(fnSlice), '③ 桥接收集不再被 tier===exec 一刀切门控');
  ok(/bridged = await collectBridgedTools\(config\)/.test(fnSlice), '③ 所有层级都收集桥接工具');
  ok(/bridgedToolTier\(/.test(fnSlice) && /rank\[tier\]/.test(fnSlice), '③ read/edit 按 bridgedToolTier 分级过滤(含 config.bridgedToolTiers 用户覆盖)');
}

// ---- ④ Claude 路径 mcp-config 仍 exec-only(安全不变量) ----
{
  const fnSlice = functionBlock(src, 'runClaudeSubAgentOnce');
  ok(/tier === 'exec' \? await generateAgentNodeMcpConfig/.test(fnSlice), "④ Claude 子代理 mcp-config 仍仅 exec 级挂载(bypass 下 allowlist 非硬限,不得提前开放)");
}

// ---- ⑤ NATIVE_TOOL_TIER 分级不变量 ----
{
  const T = srv.NATIVE_TOOL_TIER || {};
  ok(Object.keys(T).length >= 90, `⑤ NATIVE_TOOL_TIER 可读(${Object.keys(T).length} 项)`);
  ok(T.web_search === 'read' && T.web_fetch === 'read', "⑤ web_search/web_fetch 保持 read 级(联网只读)");
  ok(T.http_request === 'exec', "⑤ http_request 保持 exec 级(任意方法/头的原始请求)");
  ok(T.git_commit === 'exec', "⑤ git_commit 保持 exec 级(触发 hooks)");
  // 137 集成重钉:spawn_agent 兼容口仍在 TOOL_HANDLERS(tool-dispatch L4 要求每个注册工具有 tier),所以它还在表里;
  // 本条守的是「委派子代理不落低档」—— 它在表里就必须与 orchestrate_agents 同为 exec(将来整个撤掉兼容口也照样绿)。
  ok(T.orchestrate_agents === 'exec' && (!('spawn_agent' in T) || T.spawn_agent === 'exec'), "⑤ orchestrate_agents 保持 exec 级;spawn_agent 兼容口若在表里也必须 exec(代理模式 v2)");
  ok(/noAgentTools: true/.test(functionBlock(src, 'runSubAgentCoreBody')), '⑤ 子回合仍禁嵌套(noAgentTools:三个代理工具都不 offer)');
}

// ---- ⑥ bridgedToolTier 实跑(产物导出的那一个函数) ----
{
  const f = srv.bridgedToolTier;
  ok(typeof f === 'function', '⑥ bridgedToolTier 可调用(产物导出)');
  if (typeof f === 'function') {
    ok(f('screenshot', null) === 'read', '⑥ ACC 只读族(screenshot)→ read(read 级子代理可用)');
    ok(f('get_windows', null) === 'read' && f('list_processes', null) === 'read', '⑥ get_/list_ 前缀族 → read');
    ok(f('type_text', null) === 'exec' && f('mouse_click', null) === 'exec', '⑥ 未知/操控类工具缺省 exec(不会漏进 read 级)');
    ok(f('type_text', { bridgedToolTiers: { type_text: 'edit' } }) === 'edit', '⑥ config.bridgedToolTiers 用户覆盖生效');
  }
}

console.log('');
if (failures) { console.log(`SUBAGENT NET TOOLS E2E: ${failures} FAILURE(S)`); process.exit(1); }
console.log('SUBAGENT NET TOOLS E2E: ALL PASS');
