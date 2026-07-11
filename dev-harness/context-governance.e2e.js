// E2E: 第28波「上下文与产物治理」(AUTONOMY-PLAN §28)。无端口(纯源抽取 + 静态锁,离线 Node 直跑)。
// 覆盖:§28c 预算化上游上下文 buildUpstreamContext(取代 12000/32000 定长,两站点)· §28b 节点输出四分 deriveNodeOutputs ·
//       §28a 子代理两级压缩 maybeCompactSubHistory(关键:const 原地 splice + 钉住 task[0] + L1/L2 分级)· §28d degradedPolicy(4 归一 + 翻译接缝)。
// 技术同 scheduler-reducer/audit-w23:源抽取 + new Function 实跑纯逻辑 + 正则静态锁接线。
'use strict';
const fs = require('fs'), path = require('path');
const SERVER = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'server.js');
const src = fs.readFileSync(SERVER, 'utf8');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [S] 静态源锁 —— 接线不变式(防静默回归)
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [S] 静态源锁 ──');
// §28c:两处上游装配点都改用 buildUpstreamContext,旧 12000/32000 定长常量在装配点消失。
ok(/const priorText = buildUpstreamContext\(depNodes, upstreamBudgetTokens\)/.test(src), 'S §28c DAG runNode 用 buildUpstreamContext');
ok(/const dependencyText = buildUpstreamContext\(dependsOn\.map/.test(src), 'S §28c spawn_agent 站点用 buildUpstreamContext');
ok(!/\.join\('\\n\\n'\)\.slice\(0, 32000\)/.test(src), 'S §28c 旧 join.slice(0,32000) 定长截断已消失');
// §28b:节点完成派生四分。
ok(/deriveNodeOutputs\(node\);/.test(src), 'S §28b runNode 完成调 deriveNodeOutputs');
ok(/function deriveNodeOutputs\(node\)/.test(src) && /node\.summary =/.test(src) && /node\.evidence =/.test(src) && /node\.artifacts =/.test(src), 'S §28b deriveNodeOutputs 产 summary/evidence/artifacts');
// §28a:子代理循环边界压缩;Claude 引擎不引入。
ok(/await maybeCompactSubHistory\(\{ subHistory, sys, provider, subModel, config, onEvent, subagentId, parentSession \}\)/.test(src), 'S §28a runSubAgentCore 循环边界调 maybeCompactSubHistory');
ok(/subHistory\.splice\(0, subHistory\.length, \.\.\.reseeded\)/.test(src), 'S §28a L2 重播种用【原地 splice】(const 闭包安全)');
{
  const claudeOnce = (src.match(/async function runClaudeSubAgentOnce\([\s\S]*?\nasync function runSubAgentCore\(/) || [''])[0];
  // 排除注释里对这些词的提及,只查真实代码模式(声明/调用)。
  ok(claudeOnce.length > 500 && !/const subHistory|maybeCompactSubHistory\(/.test(claudeOnce), 'S §28a Claude 引擎【不】引入 subHistory 压缩(有意不对称)');
}
// §28d:degradedPolicy 归一(模板/新建/resume/工具 schema)+ 翻译接缝。
ok((src.match(/\['accept', 'retry', 'request_review', 'fail'\]/g) || []).length >= 3, 'S §28d degradedPolicy 枚举 ≥3 处(模板/新建/resume/schema)');
ok(/n\.degradedPolicy = \['accept', 'retry', 'request_review', 'fail'\]\.includes\(n\.degradedPolicy\)/.test(src), 'S §28d resume 回填 degradedPolicy(老 run 零回归)');
ok(/if \(node\.degraded === true && node\.status === 'succeeded'\) \{/.test(src), 'S §28d 翻译接缝(仅降级成功节点)');
ok(/degradedPolicy: \{ type: 'string', enum: \['accept', 'retry', 'request_review', 'fail'\]/.test(src), 'S §28d orchestrate 工具 schema 含 degradedPolicy');

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [P] 纯逻辑源抽取:§28c buildUpstreamContext + §28b deriveNodeOutputs
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [P] §28b/§28c 纯逻辑 ──');
const blk = src.match(/const NODE_SUMMARY_MAX = 2000;[\s\S]*?\nfunction buildUpstreamContext\(depNodes, budgetTokens\) \{[\s\S]*?\n\}/);
ok(!!blk, 'P 源抽取 28b/28c 块');
// estimateContentTokens 注入桩:~1 token / 4 字符(测预算/分级逻辑,非精确 token)。
const estimateContentTokens = s => Math.ceil(String(s || '').length / 4);
const g = new Function('estimateContentTokens', blk[0] + '\nreturn { deriveNodeOutputs, buildUpstreamContext, NODE_WRITE_FAMILY };')(estimateContentTokens);

// deriveNodeOutputs:结构化 summary/verdict 优先;findings→evidence;续点写族步骤→artifacts。
{
  const n1 = { structuredResult: { summary: '核心结论X', findings: [{ a: 1 }, { b: 2 }] }, result: '整段很长的 rawTranscript'.repeat(50), continuation: { steps: [{ tool: 'file_write', argsPreview: 'path=a.js' }, { tool: 'file_read', argsPreview: 'path=b.js' }] } };
  g.deriveNodeOutputs(n1);
  ok(n1.summary === '核心结论X', 'P §28b summary 取结构化 summary');
  ok(Array.isArray(n1.evidence) && n1.evidence.length === 2, 'P §28b evidence 取 findings');
  ok(n1.artifacts.length === 1 && n1.artifacts[0].tool === 'file_write', 'P §28b artifacts 只收写族步骤(file_read 不算)');
  const n2 = { structuredResult: null, result: '  这是   最终   结论文本  ', continuation: null };
  g.deriveNodeOutputs(n2);
  ok(n2.summary === '这是 最终 结论文本', 'P §28b 无结构化→result 扁平化为 summary');
  const n3 = { structuredResult: { verdict: 'fail', confidence: 0.9 }, result: '', continuation: null };
  g.deriveNodeOutputs(n3);
  ok(/verdict=fail/.test(n3.summary), 'P §28b 无 summary 有 verdict→verdict= 摘要');
}
// buildUpstreamContext:rung 分级 + 均分预算 + degraded 标注。
{
  const empty = g.buildUpstreamContext([], 1000);
  ok(empty === '', 'P §28c 无依赖→空串');
  // 全文放得下 → rung1 全文无损。
  const deps1 = [{ id: 'a', status: 'succeeded', result: 'short result' }];
  const t1 = g.buildUpstreamContext(deps1, 1000);
  ok(t1.includes('short result') && t1.includes('### a (succeeded)'), 'P §28c rung1:全文放得下→无损全文 + 头');
  // 全文超份额、summary 放得下 → rung2 摘要。
  const bigFull = 'X'.repeat(4000); // ~1000 token
  const deps2 = [{ id: 'b', status: 'succeeded', result: bigFull, summary: '简短摘要' }];
  const t2 = g.buildUpstreamContext(deps2, 100); // 份额 ~100 token,全文 1000 超,摘要 <100 放得下
  ok(t2.includes('简短摘要') && t2.includes('精简结论') && !t2.includes(bigFull), 'P §28c rung2:全文超份额→用 summary');
  // 无 summary、全文超份额 → rung3 截断(单依赖小预算下,总量硬钳制会接管 → 「按总预算截断」标注)。
  const deps3 = [{ id: 'c', status: 'succeeded', result: bigFull }];
  const t3 = g.buildUpstreamContext(deps3, 100);
  ok(/截断/.test(t3) && t3.length < bigFull.length, 'P §28c rung3/总钳:超预算→截断 + 标注');
  // 对抗轮 P3:总量硬钳制 —— 多个各自放得下但【累计超预算】的依赖,拼接结果被总预算截断(旧 32000 硬顶的等价物)。
  const many = Array.from({ length: 20 }, (_, i) => ({ id: 'n' + i, status: 'succeeded', result: 'body-' + i + '-'.repeat(60) }));
  const tMany = g.buildUpstreamContext(many, 300); // 20 依赖 × 200 下限 body 远超 300 → 总钳制
  ok(estimateContentTokens(tMany) <= 300 + 20, 'P §28c 总量硬钳制:拼接结果 ≤ 预算(+标注余量)不击穿');
  ok(tMany.includes('按总预算截断'), 'P §28c 总钳标注出现');
  // degraded 标注(§28d 上游可见)。
  const t4 = g.buildUpstreamContext([{ id: 'd', status: 'succeeded', degraded: true, result: 'x' }], 1000);
  ok(t4.includes('· 降级'), 'P §28c degraded 前序在标题标注');
  // 多依赖均分:靠后依赖不被靠前大依赖整段挤掉(旧 join.slice 的病)。
  const t5 = g.buildUpstreamContext([{ id: 'p', status: 'succeeded', result: 'Y'.repeat(8000) }, { id: 'q', status: 'succeeded', result: 'q-body' }], 400);
  ok(t5.includes('### q (succeeded)') && t5.includes('q-body'), 'P §28c 均分预算:靠后依赖 q 仍完整可见(不被 p 挤掉)');
}

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// [A] 源抽取实跑:§28a maybeCompactSubHistory(L1/L2 + 原地 splice + 钉 task[0])
// ══════════════════════════════════════════════════════════════════════════════════════════════════
console.log('\n── [A] §28a maybeCompactSubHistory ──');
const mm = src.match(/async function maybeCompactSubHistory\(opts\) \{[\s\S]*?\n\}/);
ok(!!mm, 'A 源抽取 maybeCompactSubHistory');
// 抽真 evaporateHistory + recentTurnsBoundary(保真);其余注入桩。
const em = src.match(/function evaporateHistory\(history\) \{[\s\S]*?\n\}/);
const evaporateHistory = new Function('EVAPORATED_PREFIX', em[0] + '\nreturn evaporateHistory;')('[已省略:'); // 注入模块级常量
const rm = src.match(/function recentTurnsBoundary\(history\) \{[\s\S]*?\n\}/);
const recentTurnsBoundary = new Function(rm[0] + '\nreturn recentTurnsBoundary;')();
// 桩:窗口 1000 token;估算 = 各消息 content 长度/4 + 40/条;摘要内核可控 ok/summary。
const providerContextWindow = () => 1000;
const estimateHistoryTokens = h => (Array.isArray(h) ? h : []).reduce((t, m) => t + 40 + Math.ceil(String((m && m.content) || '').length / 4), 0);
let summaryOk = true;
const providerSummaryCall = async () => (summaryOk ? { ok: true, summary: 'SUMMARY', usage: null } : { ok: false, error: 'boom' });
let recordCalls = 0; const recordCompactUsage = () => { recordCalls++; };
const maybeCompactSubHistory = new Function(
  'providerContextWindow', 'estimateHistoryTokens', 'evaporateHistory', 'providerSummaryCall', 'recentTurnsBoundary', 'recordCompactUsage',
  mm[0] + '\nreturn maybeCompactSubHistory;'
)(providerContextWindow, estimateHistoryTokens, evaporateHistory, providerSummaryCall, recentTurnsBoundary, recordCompactUsage);

const cfg = { autoCompactThreshold: 0.8 }; // budget = 0.8 × 1000 = 800 token
const prov = { model: 'm' };
(async () => {
  // (1) 未超预算 → 不动。
  {
    const sub = [{ role: 'user', content: 'task' }, { role: 'assistant', content: 'a' }, { role: 'tool', tool_call_id: 't1', content: 'small' }];
    const ref = sub;
    const changed = await maybeCompactSubHistory({ subHistory: sub, sys: 'sys', provider: prov, subModel: 'm', config: cfg, onEvent: () => {} });
    ok(changed === false && sub === ref && sub.length === 3, 'A(1) 未超预算→不压缩,数组不动');
  }
  // (2) 超预算 + L1 evaporate 足够 → 蒸发旧 tool 结果,返回 true,数组同一引用(原地)。
  {
    const big = 'Z'.repeat(3200); // ~800 token 单条,足以越 800 budget
    const sub = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: big },
      { role: 'assistant', content: 'a2' },
      { role: 'assistant', content: 'a3' },
    ];
    const ref = sub;
    let ev = null;
    const changed = await maybeCompactSubHistory({ subHistory: sub, sys: 'sys', provider: prov, subModel: 'm', config: cfg, onEvent: e => { if (e && e.type === 'compact') ev = e; }, subagentId: 's1' });
    ok(changed === true && sub === ref, 'A(2) 超预算→压缩,数组同一引用');
    ok(ev && ev.mode === 'evaporate' && ev.subagentId === 's1', 'A(2) 发 compact/evaporate 事件带 subagentId');
    ok(sub[2].content.startsWith('[已省略:'), 'A(2) L1 蒸发旧 tool 结果(占位)');
    // 配对不破:每个 assistant.tool_calls[].id 仍有匹配 role:'tool'。
    const toolIds = new Set(sub.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    const callIds = sub.filter(m => m.tool_calls).flatMap(m => m.tool_calls.map(tc => tc.id));
    ok(callIds.every(id => toolIds.has(id)), 'A(2) 蒸发后 tool_call/tool 配对不破');
  }
  // (3) 超预算 + L1 蒸发不到(唯一 tool 落在最近 2 assistant 之内)→ L2 摘要重播种:原地 splice + 钉 task[0] + 记账。
  {
    summaryOk = true; recordCalls = 0;
    // 现实子代理形状:单 user(task at [0])+ 大 assistant/tool。tool 在最近 2 assistant 内 → evaporate=0 → 直接 L2。
    const sub = [
      { role: 'user', content: 'TASK0' },
      { role: 'assistant', content: 'A'.repeat(4000) },
      { role: 'tool', tool_call_id: 't1', content: 'T'.repeat(4000) },
      { role: 'assistant', content: 'B'.repeat(4000) },
    ];
    const ref = sub;
    let ev = null;
    const changed = await maybeCompactSubHistory({ subHistory: sub, sys: 'sys', provider: prov, subModel: 'm', config: cfg, onEvent: e => { if (e && e.type === 'compact') ev = e; }, subagentId: 's2', parentSession: { id: 'p' } });
    ok(changed === true && sub === ref, 'A(3) L2→数组【同一引用】(原地 splice,非重新赋值)');
    ok(ev && ev.mode === 'summary', 'A(3) 发 compact/summary 事件');
    ok(sub[0].role === 'user' && /TASK0/.test(sub[0].content) && /SUMMARY/.test(sub[0].content), 'A(3) 首条 user 并入【原始 task + 摘要】(不连续 user)');
    ok(sub[1] && sub[1].role === 'assistant', 'A(3) reseed 交替:user→assistant');
    ok(sub.length < 4, 'A(3) 重播种后长度收缩(4→2)');
    ok(recordCalls === 1, 'A(3) 摘要调用记 aux 台账(recordCompactUsage)');
  }
  // (4) L1 蒸发到旧 tool 但仍超预算(近窗还有大 tool)→ L2 内核失败 → 保 L1 蒸发结果、不抛、不中断。
  {
    summaryOk = false;
    const big = 'Z'.repeat(4000);
    const sub = [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: '', tool_calls: [{ id: 't1' }] },
      { role: 'tool', tool_call_id: 't1', content: big },       // 落在最近2assistant之前 → 蒸发
      { role: 'assistant', content: 'a2' },
      { role: 'tool', tool_call_id: 't2', content: big },       // 近窗 → 保留,使 after1 仍超预算 → 进 L2
      { role: 'assistant', content: 'a3' },
    ];
    const changed = await maybeCompactSubHistory({ subHistory: sub, sys: 'sys', provider: prov, subModel: 'm', config: cfg, onEvent: () => {} });
    ok(changed === true && sub[2].content.startsWith('[已省略:'), 'A(4) L2 内核失败→保留 L1 蒸发结果,不抛');
    summaryOk = true;
  }

  console.log('');
  if (fail) { console.log('CONTEXT-GOVERNANCE E2E: FAIL (' + fail + ')'); process.exit(1); }
  console.log('CONTEXT-GOVERNANCE E2E: ALL PASS');
})();
