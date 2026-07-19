// 第22波(开放子代理工具面)回归锁:
//  能力面: ①Claude 子代理 read/edit 白名单含 WebSearch/WebFetch(两引擎联网能力对齐);②内置 explorer/reviewer/
//    verifier 角色 claudeTools 含联网;③OpenAI 子代理桥接 MCP 工具按 BRIDGED_TOOL_TIERS 分级参与所有层
//    (bridgedToolTier 过滤,不再 exec 一刀切)。
//  安全不变量(开放的边界,防未来误扩): ④Claude 路径 mcp-config 仍 exec-only(bypass 下 --allowed-tools 非硬限,
//    提前挂桥接面=桌面全控泄漏);⑤web_search/web_fetch 保持 read 级但 http_request 保持 exec、git_commit 保持
//    exec、spawn_agent 保持 exec + 子回合 noSpawnAgent;⑥bridgedToolTier 未知工具缺省 exec、用户覆盖生效。
'use strict';
const { readServerSource } = require('./src-reader');
const fs = require('fs');
const path = require('path');

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
  const explorer = src.match(/\{ id: 'explorer'[^\n]+/);
  const reviewer = src.match(/\{ id: 'reviewer'[^\n]+/);
  const verifier = src.match(/\{ id: 'verifier'[^\n]+/);
  ok(explorer && /'WebSearch', 'WebFetch'/.test(explorer[0]), '② explorer 角色 claudeTools 含联网(显式白名单覆盖 tier 缺省,必须单独补)');
  ok(reviewer && /'WebSearch', 'WebFetch'/.test(reviewer[0]), '② reviewer 角色 claudeTools 含联网');
  ok(verifier && /'WebSearch', 'WebFetch'/.test(verifier[0]), '② verifier 角色 claudeTools 含联网');
}

// ---- ③ OpenAI 子代理桥接分级(runSubAgentCore 源检查) ----
{
  const fnStart = src.indexOf('async function runSubAgentCore(');
  const fnSlice = src.slice(fnStart, fnStart + 6000);
  ok(fnStart > 0, '③ runSubAgentCore 存在');
  ok(!/if \(tier === 'exec'\) \{ try \{ bridged = await collectBridgedTools/.test(fnSlice), '③ 桥接收集不再被 tier===exec 一刀切门控');
  ok(/bridged = await collectBridgedTools\(config\)/.test(fnSlice), '③ 所有层级都收集桥接工具');
  ok(/bridgedToolTier\(/.test(fnSlice) && /rank\[tier\]/.test(fnSlice), '③ read/edit 按 bridgedToolTier 分级过滤(含 config.bridgedToolTiers 用户覆盖)');
}

// ---- ④ Claude 路径 mcp-config 仍 exec-only(安全不变量) ----
{
  const fnStart = src.indexOf('async function runClaudeSubAgentOnce(');
  const fnSlice = src.slice(fnStart, fnStart + 5000);
  ok(/tier === 'exec' \? await generateAgentNodeMcpConfig/.test(fnSlice), "④ Claude 子代理 mcp-config 仍仅 exec 级挂载(bypass 下 allowlist 非硬限,不得提前开放)");
}

// ---- ⑤ NATIVE_TOOL_TIER 分级不变量 ----
{
  const m = src.match(/const NATIVE_TOOL_TIER = \{[\s\S]*?\n\};/);
  ok(!!m, '⑤ NATIVE_TOOL_TIER 定义可抽取');
  if (m) {
    const table = m[0];
    ok(/web_search: 'read', web_fetch: 'read'/.test(table), "⑤ web_search/web_fetch 保持 read 级(联网只读)");
    ok(/http_request: 'exec'/.test(table.replace(/\n/g, ' ')) || /http_request: 'exec'/.test(table), "⑤ http_request 保持 exec 级(任意方法/头的原始请求)");
    ok(/git_commit: 'exec'/.test(table), "⑤ git_commit 保持 exec 级(触发 hooks)");
    ok(/spawn_agent: 'exec'/.test(table), "⑤ spawn_agent 保持 exec 级");
  }
  ok(/noSpawnAgent: true/.test(src.slice(src.indexOf('async function runSubAgentCore('), src.indexOf('async function runSubAgentCore(') + 6000)), '⑤ 子回合仍禁嵌套 spawn_agent');
}

// ---- ⑥ bridgedToolTier 实跑(抽函数+依赖表) ----
{
  const setM = src.match(/const BRIDGED_READ_TOOLS = new Set\(\[[\s\S]*?\]\);/);
  const preM = src.match(/const BRIDGED_READ_PREFIXES = \[[^\]]*\];/);
  const fnM = src.match(/function bridgedToolTier\(unprefixedName, config\) \{[\s\S]*?\n\}/);
  ok(!!(setM && preM && fnM), '⑥ bridgedToolTier 及依赖表可抽取');
  if (setM && preM && fnM) {
    const B = {};
    new Function('exports', setM[0] + '\n' + preM[0] + '\n' + fnM[0] + '\nexports.f = bridgedToolTier;')(B);
    ok(B.f('screenshot', null) === 'read', '⑥ ACC 只读族(screenshot)→ read(read 级子代理可用)');
    ok(B.f('get_windows', null) === 'read' && B.f('list_processes', null) === 'read', '⑥ get_/list_ 前缀族 → read');
    ok(B.f('type_text', null) === 'exec' && B.f('mouse_click', null) === 'exec', '⑥ 未知/操控类工具缺省 exec(不会漏进 read 级)');
    ok(B.f('type_text', { bridgedToolTiers: { type_text: 'edit' } }) === 'edit', '⑥ config.bridgedToolTiers 用户覆盖生效');
  }
}

console.log('');
if (failures) { console.log(`SUBAGENT NET TOOLS E2E: ${failures} FAILURE(S)`); process.exit(1); }
console.log('SUBAGENT NET TOOLS E2E: ALL PASS');
