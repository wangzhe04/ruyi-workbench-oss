#!/usr/bin/env node
'use strict';
// Wave 103b static gate: dependency contracts are reproducible, duplicate globals are forbidden, and the
// explicit debt ceiling rejects new cycle/forward-order edges. Also locks the first namespace isolation pilot.
const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const {
  buildGraph, policyViolations, tokenize, declarationInfo,
} = require('./module-dependency-graph');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail++; console.log('FAIL ' + label); }
};

const checked = cp.spawnSync(process.execPath, [path.join(__dirname, 'module-dependency-graph.js'), '--check'], {
  cwd: ROOT, encoding: 'utf8', windowsHide: true,
});
ok(checked.status === 0, '103b generated contract and human/machine graphs match source byte-for-byte');
if (checked.status !== 0) console.log(String(checked.stdout || '') + String(checked.stderr || ''));

const graph = buildGraph();
const manifest = JSON.parse(fs.readFileSync(path.join(SRC, 'manifest.json'), 'utf8'));
const policy = JSON.parse(fs.readFileSync(path.join(SRC, 'module-dependency-policy.json'), 'utf8'));
const violations = policyViolations(graph, policy);
ok(graph.modules.length === manifest.modules.length && graph.modules.every((module, index) => module.file === manifest.modules[index].file),
  '103b graph covers every manifest module in concatenation order');
ok(graph.duplicateProvides.length === 0, '103b no duplicate top-level provides');
ok(violations.cycles.length === 0, '103b no cycle edge above the reviewed debt ceiling');
ok(violations.forward.length === 0, '103b no forward/order-layer edge above the reviewed debt ceiling');
// 架构还债批 1:环边已有逐条审过的上限,但「被卷进同一个强连通分量的模块数」没有 —— 往白名单里补一条边就可能把
// 一个本来干净的模块拖进大环。这里给 SCC 的规模也钉一个只降不升的上限(2026-09-27 实数:1 个 SCC、32 个模块)。
// 新模块默认挂在环外(零入边、经 *Hooks 延迟绑定,先例 06j-scheduler-core / 13t-steward-schedule);拆掉环以后把上限往下调。
const SCC_MAX_COUNT = 1, SCC_MAX_MEMBERS = 32;
const sccSizes = graph.stronglyConnectedComponents.map(component => component.length);
ok(sccSizes.length <= SCC_MAX_COUNT && sccSizes.every(size => size <= SCC_MAX_MEMBERS),
  `SCC 规模不超过上限(${SCC_MAX_COUNT} 个 / 每个 ≤ ${SCC_MAX_MEMBERS} 个模块;实测 ${JSON.stringify(sccSizes)})`);

// Scanner adversarial: declarations in comments/strings are ignored, template interpolation remains visible,
// and multi-declarator/destructuring bindings become provides. This protects the contract mechanism itself.
const fixture = [
  "const first = 1, second = `${externalCall(first)}`;",
  "const { URL, pathToFileURL } = require('url');",
  "// function fakeProvide() {}",
  "const text = 'hiddenIdentifier()';",
  'function realProvide() { return second; }',
].join('\n');
const fixtureTokens = tokenize(fixture);
const fixtureDeclarations = declarationInfo(fixtureTokens).provides.map(item => item.name).sort();
ok(JSON.stringify(fixtureDeclarations) === JSON.stringify(['URL', 'first', 'pathToFileURL', 'realProvide', 'second', 'text']),
  '103b scanner finds top-level multi/deconstructed declarations without comment/string ghosts');
ok(fixtureTokens.some(token => token.value === 'externalCall') && !fixtureTokens.some(token => token.value === 'hiddenIdentifier'),
  '103b scanner retains template-expression reads and discards quoted text');

const hooks = graph.modules.find(module => module.file === '06c-agent-loop-hooks.js');
ok(hooks && JSON.stringify(hooks.provides) === JSON.stringify(['AgentLoopHooks']),
  '103b isolation pilot exposes one namespace instead of fourteen hook internals');
ok(hooks && ['makeId', 'logEvent', 'redact'].every(symbol => hooks.requires.some(req => req.symbol === symbol)),
  '103b isolation pilot declares its three injected external dependencies');
for (const consumer of ['05-claude-engine.js', '05b-kimi-bridge.js', '09-workflow.js', '14-main.js']) {
  const module = graph.modules.find(item => item.file === consumer);
  ok(module && module.requires.some(req => req.provider === '06c-agent-loop-hooks.js' && req.symbol === 'AgentLoopHooks'),
    `103b ${consumer} consumes the isolated AgentLoopHooks namespace`);
}

console.log(`\nMODULE DEPENDENCY GRAPH STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
process.exit(fail ? 1 : 0);
