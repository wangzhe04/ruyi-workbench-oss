// 第21波(多agent对抗性验证轮)修复回归锁:
//  D-P1  结构化候选提取——完整合法的 fail 裁决不得被解析成 findings 子对象翻成 pass(包含过滤);
//        截断输出不得降级取内层子块(截断护栏,诚实 PARSE_FAIL 交 provider 修复层)。
//  D-P2  候选按"结束越晚越优先"排序(围栏内过期草稿不得压过其后修订);repairJson 不得改写字符串内容里的弯引号。
//  D-P3  行内 JSON(前有含 { 的 prose)可解析。
//  B-P2  normalizeAgentGate: 显式 false 持久化(经两轮 normalize 仍为 false,不被 reviewer autoMode 回填);
//        编辑器条件文本 parse 支持 无node前缀 / 空path / 纯op 形态(与 evaluateWorkflowCondition 合法形态对齐)。
// 纯函数按锚点从 server.js / app.js 逐字节抽出实跑(不 spawn 服务,不碰 dataRoot)。
'use strict';
const { readServerSource } = require('./src-reader');
const fs = require('fs');
const path = require('path');

let failures = 0;
function ok(cond, label) { if (cond) { console.log(`PASS ${label}`); } else { failures++; console.log(`FAIL ${label}`); } }

function cutBlock(src, startAnchor, endAnchor, what) {
  const lines = src.split('\n');
  const s = lines.findIndex(l => l.includes(startAnchor));
  const e = lines.findIndex(l => l.includes(endAnchor));
  if (s < 0 || e < 0 || e <= s) { console.error(`anchor not found for ${what}: ${s}..${e}`); process.exit(1); }
  return lines.slice(s, e).join('\n');
}

// ---- 抽取 server.js 纯函数 ----
const serverSrc = readServerSource();
const blockA = cutBlock(serverSrc, 'const QUALITY_GATE_OUTPUT_SCHEMA', 'const BUILTIN_AGENT_WORKFLOWS', 'judge fns');
const blockB = cutBlock(serverSrc, 'function normalizeWorkflowCondition(', 'function projectAgentWorkflowsFile(', 'normalize fns');
const S = {};
new Function('exports', blockA + '\n' + blockB + '\nexports.parseStructuredAgentOutput=parseStructuredAgentOutput;exports.repairJson=repairJson;exports.structuredJsonCandidates=structuredJsonCandidates;exports.balancedJsonSpan=balancedJsonSpan;exports.normalizeAgentGate=normalizeAgentGate;exports.normalizeAgentWorkflow=normalizeAgentWorkflow;exports.verdictPasses=verdictPasses;')(S);

// ---- 抽取 app.js 条件文本纯函数 ----
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'app.js'), 'utf8');
const blockF = cutBlock(appSrc, 'function workflowConditionText(', 'async function openWorkflowEditor(', 'condition fns');
const F = {};
new Function('exports', blockF + '\nexports.workflowConditionText=workflowConditionText;exports.parseWorkflowConditionText=parseWorkflowConditionText;')(F);

// ============ D-P1a: 完整合法围栏 fail 裁决(字符串含 ``` + 尾注 {完}) ============
const p1a = [
  '审查完成，整体不通过。',
  '```json',
  '{',
  '  "verdict": "fail",',
  '  "confidence": 0.9,',
  '  "summary": "示例代码含 ``` 围栏",',
  '  "findings": [',
  '    {',
  '      "verdict": "pass", "confidence": 0.9, "summary": "单项 A 无问题"',
  '    },',
  '    {',
  '      "verdict": "pass", "confidence": 0.8, "summary": "单项 B 无问题"',
  '    },',
  '    {',
  '      "verdict": "pass", "confidence": 0.8, "summary": "单项 C 无问题"',
  '    }',
  '  ]',
  '}',
  '```',
  '以上 {完}',
].join('\n');
{
  const r = S.parseStructuredAgentOutput(p1a);
  ok(r.ok && r.value && r.value.verdict === 'fail' && Array.isArray(r.value.findings) && r.value.findings.length === 3,
    'D-P1a 完整合法 fail 裁决解析为整体对象(不被 findings 子项翻成 pass)');
  const v = r.ok ? S.verdictPasses(r.value, { minConfidence: 0.5 }) : { pass: true };
  ok(v.pass === false, 'D-P1a 质量门判 fail(门未被绕过)');
}

// ============ D-P1b: 截断输出(缺收尾大括号)→ 诚实解析失败,绝不取内层子块 ============
const p1b = [
  '{',
  '  "verdict": "fail",',
  '  "confidence": 0.9,',
  '  "findings": [',
  '    {',
  '      "verdict": "pass", "confidence": 0.9, "summary": "单项无问题"',
  '    }',
  '  ],',
  '  "summary": "整体不通',   // 截断于此
].join('\n');
{
  const r = S.parseStructuredAgentOutput(p1b);
  ok(!r.ok, 'D-P1b 截断输出 → 解析失败(截断护栏,不降级取 findings 子块)');
}

// ============ D-P2a: 围栏内过期草稿 vs 其后的最终修订 → 修订版胜出 ============
const p2a = [
  '```json',
  '{"verdict": "pass", "confidence": 0.9, "summary": "初稿"}',
  '```',
  '更正：以上有误，最终结论：',
  '{"verdict": "fail", "confidence": 0.95, "summary": "严重问题"}',
].join('\n');
{
  const r = S.parseStructuredAgentOutput(p2a);
  ok(r.ok && r.value.verdict === 'fail' && r.value.summary === '严重问题', 'D-P2a 末位修订版压过围栏内过期草稿');
}

// ============ D-P2b: repairJson 不改写字符串内容(弯引号保留);结构修复仍有效 ============
{
  const input = '{"verdict": "fail", "confidence": 0.9, "summary": "用户输入“确认”后崩溃",}';
  const r = S.parseStructuredAgentOutput(input);
  ok(r.ok && r.value.summary === '用户输入“确认”后崩溃', 'D-P2b 尾逗号修复后字符串内容的弯引号原样保留');
  const smartDelim = S.repairJson('{“verdict”: “fail”}');
  ok(JSON.parse(smartDelim).verdict === 'fail', 'D-P2b 弯引号作分隔符时仍被修复(结构位置替换未回归)');
  const legacy = S.parseStructuredAgentOutput('{"summary": "未到"fail"级别", "verdict": "fail", "confidence": 1}');
  ok(legacy.ok && legacy.value.summary === '未到"fail"级别', 'D-P2b 未转义内引号修复(v1.5 既有能力未回归)');
  const valid = '{"a":[1,-0.5,1e-5],"b":"x\\"y\\\\","c":{"d":null}}';
  ok(S.repairJson(valid) === valid, 'D-P2b repairJson 对合法 JSON 幂等');
}

// ============ D-P3a: 行内 JSON(prose 含 {)可解析 ============
{
  const r = S.parseStructuredAgentOutput('我按照 {verdict,summary} 格式输出：{"verdict": "fail", "confidence": 0.9, "summary": "问题"}');
  ok(r.ok && r.value.verdict === 'fail', 'D-P3a 行内 JSON(前有含 { 的 prose)命中');
}

// ============ B-P2: gate 显式 false 持久化(两轮 normalize 模拟 保存→launch) ============
{
  ok(S.normalizeAgentGate(false, 'reviewer') === false, 'B-P2 normalizeAgentGate(false, reviewer) → false(不回填)');
  const auto = S.normalizeAgentGate(null, 'reviewer');
  ok(auto && auto.mode === 'review', 'B-P2 normalizeAgentGate(null, reviewer) → 角色自动门(内置模板默认保持)');
  const wf1 = S.normalizeAgentWorkflow({ id: 'g-test', title: 'G', nodes: [{ id: 'review', task: 't', role: 'reviewer', gate: false }] }, { source: 'personal' });
  ok(wf1 && wf1.nodes[0].gate === false, 'B-P2 保存期 normalize: reviewer 节点 gate:false 持久为 false');
  const wf2 = S.normalizeAgentWorkflow(JSON.parse(JSON.stringify(wf1)), { source: 'personal' });
  ok(wf2 && wf2.nodes[0].gate === false, 'B-P2 launch 期二次 normalize: gate 仍为 false(不被 autoMode 复活)');
}

// ============ B-P2: 编辑器条件文本四形态 round-trip ============
{
  const t1 = F.parseWorkflowConditionText('review.verdict equals "fail"');
  ok(t1 && t1.node === 'review' && t1.path === 'verdict' && t1.operator === 'equals' && t1.value === 'fail', 'B-P2 条件 node.path op value 解析');
  const t2 = F.parseWorkflowConditionText('done truthy');
  ok(t2 && t2.node === '' && t2.path === 'done' && t2.operator === 'truthy', 'B-P2 条件 无node前缀(对当前节点求值)解析');
  const t3 = F.parseWorkflowConditionText('a. status_is "succeeded"');
  ok(t3 && t3.node === 'a' && t3.path === '' && t3.operator === 'status_is', 'B-P2 条件 空path(整个结构化结果)解析');
  const t4 = F.parseWorkflowConditionText('truthy');
  ok(t4 && t4.node === '' && t4.path === '' && t4.operator === 'truthy', 'B-P2 条件 纯op形态解析');
  for (const cond of [{ node: '', path: 'done', operator: 'truthy' }, { node: 'a', path: '', operator: 'status_is' }, { node: 'review', path: 'verdict', operator: 'equals', value: 'fail' }]) {
    const rt = F.parseWorkflowConditionText(F.workflowConditionText(cond));
    ok(rt && rt.node === cond.node && rt.path === cond.path && rt.operator === cond.operator, `B-P2 条件 round-trip: ${JSON.stringify(cond)}`);
  }
}

// ============ D 回归护栏: 常规形态未被重设计破坏 ============
{
  const classic = '分析如下……\n\n```json\n{"verdict": "pass", "confidence": 0.8, "summary": "OK"}\n```\n';
  const r1 = S.parseStructuredAgentOutput(classic);
  ok(r1.ok && r1.value.verdict === 'pass', 'D 回归 经典"分析+围栏收尾"形态');
  const bare = '{"verdict": "uncertain", "confidence": 0.5, "summary": "s"}';
  const r2 = S.parseStructuredAgentOutput(bare);
  ok(r2.ok && r2.value.verdict === 'uncertain', 'D 回归 裸 JSON 形态');
  const arr = '结果:\n[{"file": "a.js", "line": 1}]';
  const r3 = S.parseStructuredAgentOutput(arr);
  ok(r3.ok && Array.isArray(r3.value) && r3.value[0].file === 'a.js', 'D 回归 数组输出形态');
}

console.log('');
if (failures) { console.log(`ADVERSARIAL W21 E2E: ${failures} FAILURE(S)`); process.exit(1); }
console.log('ADVERSARIAL W21 E2E: ALL PASS');
