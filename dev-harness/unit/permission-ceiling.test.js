#!/usr/bin/env node
'use strict';
// Unit: 117m 天花板不变量 —— 「管家能自动放行的，原生引擎本身也必须允许」。
//
// 为什么要有这一件（117m 后端复用审查的结论）：仓库里有两套独立维护的真值表回答两个不同的问题——
//   · nativeToolGate(mode, tier, toolName, input)  「这一步工具要不要人当场按」 -> allow | ask | block
//   · stewardMayAct(permissionMode, eventKind, toolTier) 「已经挂起的待决，管家能不能替人按」 -> auto | propose
// 两张表形状不同、覆盖同一批权限档。历史上已经因为它们不同步出过对抗轮修复（CLI 桥那处
// 「天花板对称」的注释就是那次留下的），但对称性一直只靠注释与人工 review 维持，没有机器看着。
// 117m 又把 auto 档的 exec 从「一律 ask」改成「高风险才 ask」——两张表的耦合面比以前更大。
//
// 本件不改任何实现，只把那条口口相传的不变量钉成回归红线：
//   P1 管家自动放行一条 permission 待决时，原生闸门对同一 (档位, tier, 工具) 不得判 block。
//      —— block 是「这个档根本不许做这件事」（plan 档）。管家越过它替用户放行 = 越权。
//   P2 高风险动作在【任何】档位下都不许由管家自动放行（永久豁免清单，§3.3）。
//   P3 原生闸门判 allow 的组合，管家侧不得更严到 block（不存在这个返回值，等价于：两张表不打架）。
const path = require('path');
const srv = require(path.join(__dirname, '..', '..', 'ruyi-workbench', 'app', 'server.js'));
const { nativeToolGate, stewardMayAct, stewardToolPermanentlyExempt, PERMISSION_MODES } = srv;

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };

const MODES = [...PERMISSION_MODES, 'bypassPermissions', 'dontAsk', '', 'garbage'];
const TIERS = ['read', 'edit', 'exec', ''];
const TOOLS = [
  { name: 'script_run', input: { command: 'echo hi' }, risky: false },
  { name: 'file_write', input: { path: 'a.txt' }, risky: false },
  { name: 'http_request', input: { method: 'GET', url: 'https://example.com' }, risky: false },
  { name: 'http_request', input: { method: 'POST', url: 'https://example.com' }, risky: true },
  { name: 'script_run', input: { command: 'git push origin main' }, risky: true },
  { name: 'mcp_configure', input: { id: 'x' }, risky: true },
  { name: 'send_email', input: {}, risky: true },
];

// P1 + P2：笛卡尔积全覆盖。
{
  const violationsP1 = [];
  const violationsP2 = [];
  for (const mode of MODES) {
    for (const tier of TIERS) {
      for (const tool of TOOLS) {
        const exempt = stewardToolPermanentlyExempt(tool.name, tool.input);
        const stewardAuto = stewardMayAct(mode, 'permission', tier) === 'auto' && !exempt;
        const gate = nativeToolGate(mode, tier, tool.name, tool.input);
        if (stewardAuto && gate === 'block') violationsP1.push(`${mode}/${tier}/${tool.name}`);
        if (tool.risky && !exempt) violationsP2.push(`${tool.name}(${JSON.stringify(tool.input)})`);
      }
    }
  }
  ok(violationsP1.length === 0,
    'P1 管家自动放行的组合，原生闸门都不判 block（越权为零）' + (violationsP1.length ? ' -> ' + violationsP1.slice(0, 6).join(' | ') : ''));
  ok(violationsP2.length === 0,
    'P2 高风险动作在任何档位下都进永久豁免清单' + (violationsP2.length ? ' -> ' + [...new Set(violationsP2)].join(' | ') : ''));
}

// P3：两张表对「全自动」这一档的口径必须一致 —— 这是 117m 改动的正面覆盖。
{
  for (const mode of ['auto', 'bypass', 'bypassPermissions']) {
    ok(stewardMayAct(mode, 'permission', 'exec') === 'auto', `P3 ${mode}: 管家可替答 permission`);
  }
  ok(nativeToolGate('auto', 'exec', 'script_run', { command: 'echo hi' }) === 'allow',
    'P3 auto 档的低风险 exec：原生闸门直接放行（不再弹窗）');
  ok(nativeToolGate('auto', 'exec', 'script_run', { command: 'git push' }) === 'ask',
    'P3 auto 档的高风险 exec：仍然要人按');
  ok(nativeToolGate('auto', 'exec', '', {}) === 'ask',
    'P3 auto 档缺工具名：保守回落要人按');
  ok(nativeToolGate('plan', 'exec', 'script_run', { command: 'echo hi' }) === 'block'
    && stewardMayAct('plan', 'permission', 'exec') === 'propose',
    'P3 plan 档：闸门 block、管家只提议（两张表在最严那一档也一致）');
}

console.log('');
if (fail) { console.log(`PERMISSION CEILING UNIT: ${fail} FAILURE(S)`); process.exit(1); }
console.log('PERMISSION CEILING UNIT: ALL PASS');
process.exit(0);
