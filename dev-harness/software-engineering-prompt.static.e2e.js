#!/usr/bin/env node
'use strict';

// Static behavior lock for the task-routed software-engineering prompt pack. No provider or port is needed:
// this verifies routing, bilingual parity, memory preflight wording, and parent/sub-agent wiring directly.
const fs = require('fs');
const path = require('path');
const SERVER = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const SRC = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'src');
const srv = require(SERVER);
let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail++; console.log('FAIL ' + label); }
};

const generic = srv.softwareEngineeringTaskProfile('帮我总结一下今天的讨论');
ok(generic && generic.relevant === false, 'generic conversation does not load the engineering pack');

const continued = srv.buildPromptTaskContext('可以的，按照你说的直接推进落实吧', {
  messages: [{ role: 'user', content: '请修复这个仓库的 plan mode 回归并补测试' }],
});
ok(srv.softwareEngineeringTaskProfile(continued).relevant, 'short continuation inherits engineering routing from a recent user task');
const switched = srv.buildPromptTaskContext('现在请帮我写一封给客户的项目进度邮件，说明下周安排和会议时间', {
  messages: [{ role: 'user', content: '请修复这个仓库的 plan mode 回归并补测试' }],
});
ok(!srv.softwareEngineeringTaskProfile(switched).relevant, 'an explicit new topic does not inherit stale engineering routing');

const implementation = srv.buildSoftwareEngineeringPolicy('请实现 app.js 的设置保存功能并运行测试', { locale: 'zh-CN' });
ok(/<software-engineering-policy>[\s\S]*<\/software-engineering-policy>/.test(implementation), 'engineering policy has a closed trust fence');
ok(/先判定交付类型/.test(implementation) && /只读调查/.test(implementation), 'engineering policy separates read-only diagnosis from authorized changes');
ok(/工作区状态/.test(implementation) && /最小一致改动/.test(implementation), 'implementation receives preflight and smallest-coherent-change rules');
ok(/注释密度/.test(implementation) && /非显然约束/.test(implementation), 'implementation follows local code idiom and keeps comments purposeful');
ok(/最终 diff/.test(implementation) && /不得声称通过/.test(implementation) && /完成标准/.test(implementation), 'implementation receives evidence-backed verification and definition of done');
ok(!/Git 安全/.test(implementation), 'Git rules stay conditional when Git is not part of the task');

const regression = srv.buildSoftwareEngineeringPolicy('修复 plan mode 回归并提交 git commit', { locale: 'zh-CN' });
ok(/可复现的失败路径/.test(regression) && /证据与假设/.test(regression), 'debugging tasks receive root-cause and regression-test guidance');
ok(/Git 安全/.test(regression) && /不得夹带无关文件/.test(regression), 'Git tasks receive workspace and history safety guidance');

const english = srv.buildSoftwareEngineeringPolicy('Debug the failing TypeScript tests in src/app.ts', { locale: 'en-US' });
ok(/classify the deliverable/.test(english) && /smallest coherent change/.test(english) && /reproducible failing path/.test(english) && /Definition of done/.test(english), 'English engineering pack is structurally equivalent');

const genericTurn = srv.appendTurnPolicies('', { locale: 'zh-CN' }, false, 0, false, '解释一下什么是光合作用');
const codeTurn = srv.appendTurnPolicies('', { locale: 'zh-CN' }, false, 0, false, '审查这个仓库的代码并运行测试');
ok(!genericTurn.includes('<software-engineering-policy>') && codeTurn.includes('<software-engineering-policy>'), 'turn router injects the pack only for software work');
for (const limit of [200, 800, 1200]) {
  const bounded = srv.appendTurnPolicies('', { locale: 'zh-CN' }, false, limit, true, '修复 app.js 回归并运行测试');
  ok(bounded.length <= limit && bounded.includes('<response-language-policy>') && bounded.includes('</response-language-policy>'), `bounded policy at ${limit} chars retains a complete language tail`);
  ok((bounded.includes('<software-engineering-policy>') === bounded.includes('</software-engineering-policy>')) &&
    (bounded.includes('<ruyi-claude-native-agent-lifecycle>') === bounded.includes('</ruyi-claude-native-agent-lifecycle>')), `bounded policy at ${limit} chars contains only complete optional modules`);
}

const provider = { id: 'fake', label: 'Fake', model: 'fake-model' };
const tools = [{ function: { name: 'file_read', description: 'read', parameters: { type: 'object', properties: {} } } }];
const stable = srv.buildStableSystemPrompt(provider, 'fake-model', 'C:\\repo', tools, false, { locale: 'zh-CN' });
ok(/向用户提问时/.test(stable) && /推荐/.test(stable), 'Provider stable prompt now includes the shared questioning protocol');
ok(/授权与指令边界/.test(stable) && /不得改用终端、其他工具或子 Agent 绕过/.test(stable), 'stable prompt treats observed text as data and forbids permission bypass');

const memory = srv.buildMemoryPromptSection([
  { id: 'repo-conventions', name: 'Repo conventions', description: 'project rules', file: 'C:\\memory\\repo.md' },
], 'openai', { locale: 'zh-CN' });
ok(/每次收到新的用户消息/.test(memory) && /相关的记忆/.test(memory) && /file_read/.test(memory), 'memory index requires a lightweight relevance check on every user message');
ok(/可能过时/.test(memory) && /当前工作区仍成立/.test(memory) && /实质改变/.test(memory), 'matching memory is verified against current workspace state before use');
const zeroMemoryCheck = srv.buildMemoryCheckPrompt({ mode: 'default', enabled: true, checked: true, candidateCount: 12, matchCount: 0, projectMatches: 0, globalMatches: 0 }, { locale: 'zh-CN' });
ok(/<workbench-memory-check[^>]*candidates="12"[^>]*matches="0"/.test(zeroMemoryCheck), 'zero-match memory preflight remains machine-readable');
ok(/不要把零命中表述为工作台没有记忆/.test(zeroMemoryCheck) && /不构成用户授权/.test(zeroMemoryCheck), 'zero-match receipt prevents capability denial and preserves the authorization boundary');
const rankedMemory = srv.rankRelevantMemories([
  { id: 'global-release', scope: 'global', name: 'Release checklist', description: 'deployment rollback steps', type: 'reference', createdAt: '2026-01-01' },
  { id: 'project-style', scope: 'project', name: 'Project style', description: 'format conventions', type: 'convention', createdAt: '2026-01-02' },
  { id: 'irrelevant', scope: 'global', name: 'Meeting notes', description: 'customer agenda', type: 'reference', createdAt: '2026-01-03' },
], 'Please verify the deployment rollback checklist', 3);
ok(rankedMemory.some(m => m.id === 'global-release') && rankedMemory.some(m => m.id === 'project-style') && !rankedMemory.some(m => m.id === 'irrelevant'), 'default retrieval considers relevant global memory plus project conventions without injecting unrelated references');

ok(srv.planDiscoveryToolBatchAllowed([{ name: 'file_read' }, { name: 'git_diff' }], {}, {}) === true, 'plan discovery allows native read-only inspection batches');
ok(srv.planDiscoveryToolBatchAllowed([{ name: 'request_user_input' }], {}, {}) === true, 'plan discovery allows a material user clarification');
ok(srv.planDiscoveryToolBatchAllowed([{ name: 'provider_web', serverSide: true }], {}, {}) === true, 'plan discovery allows provider-side observational search');
const bridgedPlanRoute = {
  acc__read_file: { serverId: 'acc', toolName: 'read_file' },
  acc__write_file: { serverId: 'acc', toolName: 'write_file' },
};
ok(srv.planDiscoveryToolBatchAllowed([{ name: 'acc__read_file' }], bridgedPlanRoute, {}) === true &&
  srv.planDiscoveryToolBatchAllowed([{ name: 'acc__write_file' }], bridgedPlanRoute, {}) === false, 'plan discovery applies bridged-tool risk tiers');
ok(srv.planDiscoveryToolBatchAllowed([{ name: 'file_read' }, { name: 'file_write' }], {}, {}) === false, 'plan discovery rejects a mixed read/write batch');
ok(srv.planDiscoveryToolBatchAllowed([{ name: 'spawn_agent' }], {}, {}) === false && srv.planDiscoveryToolBatchAllowed([{ name: 'todo_write' }], {}, {}) === false, 'plan discovery blocks delegation and planning-metadata side effects');
ok(srv.planDiscoveryToolBatchAllowed([{ name: 'unknown_future_tool' }], {}, {}) === false, 'plan discovery fails closed for unknown tools');

const claudeSrc = fs.readFileSync(path.join(SRC, '05-claude-engine.js'), 'utf8');
const autonomySrc = fs.readFileSync(path.join(SRC, '07-autonomy.js'), 'utf8');
const agentSrc = fs.readFileSync(path.join(SRC, '08-agent-runs.js'), 'utf8');
const workflowSrc = fs.readFileSync(path.join(SRC, '09-workflow.js'), 'utf8');
const registrySrc = fs.readFileSync(path.join(SRC, '06b-prompt-registry.js'), 'utf8');
ok(/appendTurnPolicies\('', config, agentTeam, appendLimit, true, promptTaskContext\)/.test(claudeSrc), 'Claude parent turn routes the current task into engineering policy selection');
ok(/promptPack: PROMPT_PACK_VERSION/.test(claudeSrc) && /promptPolicies: \{ softwareEngineering: softwareEngineeringTaskProfile\(promptTaskContext\) \}/.test(claudeSrc), 'Claude turn trace records prompt-pack version and engineering routing decision');
ok(/appendResponseLanguagePolicy\('', config, 0, task\)/.test(autonomySrc), 'Claude DAG node receives the same engineering policy');
ok(/appendResponseLanguagePolicy\([\s\S]*task,[\s\S]*\);/.test(agentSrc), 'OpenAI sub-agent receives the same engineering policy');
ok(/appendTurnPolicies\(volatileExtras, config, agentTeam, 0, false, promptTaskContext\)/.test(workflowSrc), 'Provider parent turn routes the current task into engineering policy selection');
ok(/promptPack: PROMPT_PACK_VERSION/.test(workflowSrc) && /promptPolicies: \{ softwareEngineering: softwareEngineeringTaskProfile\(promptTaskContext\) \}/.test(workflowSrc), 'Provider turn trace records prompt-pack version and engineering routing decision');
ok(/planDiscoveryToolBatchAllowed\(call\.toolCalls, bridgedRoute, config\)/.test(workflowSrc), 'Provider plan runtime routes pre-plan tool calls through the read-only discovery gate');
ok(/目标与范围/.test(registrySrc) && /风险\/兼容性/.test(registrySrc) && /工作台负责请求批准/.test(registrySrc), 'plan prompt requests one executable plan and avoids a redundant approval question');

console.log('\nSOFTWARE ENGINEERING PROMPT STATIC E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);
