// Unit: 21-E3 action-argument model view — envelope projection, sha256 gate, pairing preservation, idempotency.
'use strict';
const crypto = require('crypto');
const { readServerSource } = require('../src-reader');
const src = readServerSource();
let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const start = src.indexOf('const ACTION_VIEW_TOOLS = new Set(');
const end = src.indexOf('\nfunction buildResponsesInputItems(', start);
ok(start >= 0 && end > start, 'E3 source block found');
const block = src.slice(start, end);
const t3 = new Function('crypto', 'path', block + '\nreturn { ACTION_VIEW_TOOLS, ACTION_VIEW_MIN_CHARS, buildActionEnvelope, projectActionModelView };')(crypto, require('path'));

const BIG = 'x'.repeat(5000);
const bigArgs = JSON.stringify({ path: 'C:\\repo\\report.md', content: BIG });
const sha = crypto.createHash('sha256').update(bigArgs).digest('hex');
const audit = new Map([['call-1', { actionRef: 'action-v1:3:call-1', toolCallId: 'call-1', toolName: 'file_write', turnSeq: 3, sha256: sha, chars: bigArgs.length, status: 'completed', target: { kind: 'path', basename: 'report.md', pathHash: 'abc' } }]]);

// 1. 命中 audit 且校验通过 → arguments 投影为 envelope
const history = [
  { role: 'assistant', content: 'plan', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'file_write', arguments: bigArgs } }] },
  { role: 'tool', tool_call_id: 'call-1', content: '{"ok":true}' },
];
const p1 = t3.projectActionModelView(history, audit);
ok(p1.changed === true && p1.history[0] !== history[0], 'E3 hit projects to a NEW assistant message');
ok(p1.history[0].tool_calls[0].id === 'call-1' && p1.history[0].tool_calls[0].function.name === 'file_write', 'E3 projection preserves tool_call id + function name (pairing)');
const env = JSON.parse(p1.history[0].tool_calls[0].function.arguments);
ok(env._ruyiActionRef === 'action-v1:3:call-1' && env.operation === 'file_write' && env.target.basename === 'report.md' && env.payload.sha256 === sha, 'E3 envelope carries actionRef/operation/target/payload');
ok(p1.history[1] === history[1], 'E3 non-assistant rows untouched (tool row kept verbatim)');
ok(p1.history[0].tool_calls[0].function.arguments.length < 600, 'E3 envelope is compact (<600 chars vs 5000+)');

// 2. sha256 校验失败(历史被改)→ 不投影(保守)
const tampered = [
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'file_write', arguments: bigArgs + 'tampered' } }] },
];
ok(t3.projectActionModelView(tampered, audit).changed === false, 'E3 sha256 mismatch blocks projection (tamper-safe)');

// 3. status=failed → 不投影(失败/中断不瘦身)
const failedAudit = new Map([['call-1', { ...audit.get('call-1'), status: 'failed' }]]);
ok(t3.projectActionModelView(history, failedAudit).changed === false, 'E3 failed actions are never projected');

// 4. 无 audit 命中 → 原样返回
const noHit = [
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-9', type: 'function', function: { name: 'file_write', arguments: bigArgs } }] },
];
const p4 = t3.projectActionModelView(noHit, audit);
ok(p4.changed === false && JSON.stringify(p4.history) === JSON.stringify(noHit), 'E3 no-hit is a stable no-op (content-identical, changed=false)');

// 5. 幂等:重复投影同一(已投影)history → 不再变化(原 history 未被污染)
const p5a = t3.projectActionModelView(history, audit);
ok(history[0].tool_calls[0].function.arguments === bigArgs, 'E3 does NOT mutate the original history');
const p5b = t3.projectActionModelView(p5a.history, audit);
ok(p5b.changed === false, 'E3 idempotent: already-projected history is stable');

// 6. 小参数(<阈值)不投影
const smallAudit = new Map([['call-2', { actionRef: 'r', toolCallId: 'call-2', toolName: 'file_write', sha256: crypto.createHash('sha256').update('{"path":"a"}').digest('hex'), status: 'completed' }]]);
const small = [{ role: 'assistant', content: '', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'file_write', arguments: '{"path":"a"}' } }] }];
ok(t3.projectActionModelView(small, smallAudit).changed === false, 'E3 sub-threshold args are not projected');

// 7. 工具白名单:非投影工具不投影
const readAudit = new Map([['call-3', { toolCallId: 'call-3', toolName: 'file_read', sha256: crypto.createHash('sha256').update(bigArgs).digest('hex'), status: 'completed' }]]);
const readHist = [{ role: 'assistant', content: '', tool_calls: [{ id: 'call-3', type: 'function', function: { name: 'file_read', arguments: bigArgs } }] }];
ok(t3.projectActionModelView(readHist, readAudit).changed === false, 'E3 non-action tools (file_read) never projected');

console.log('\n── 对抗验证 ──');
// A1: 伪造 audit 条目(sha 对不上)→ 不投影(tamper-safe, 已覆盖)
// A2: 幂等(已覆盖)
// A3: responses 路径透传 —— 投影后的 arguments 经 buildResponsesInputItems 原样透传为 function_call.arguments
ok(src.includes("const viewHistory = actionAuditMap.size ? projectActionModelView(session.providerHistory, actionAuditMap).history : session.providerHistory;")
  && src.includes("const msgs = [{ role: 'system', content: sys }, ...viewHistory];"), 'A3 responses+chat buildBody both consume the projected view');
// A4: malformed rawArgs(非 JSON)→ 拒绝生成空 envelope,不投影
const malformedAudit = new Map([['call-4', { actionRef: 'r4', toolCallId: 'call-4', toolName: 'file_write', sha256: crypto.createHash('sha256').update('{not-json').digest('hex'), status: 'completed' }]]);
const malformedHist = [{ role: 'assistant', content: '', tool_calls: [{ id: 'call-4', type: 'function', function: { name: 'file_write', arguments: '{not-json' } }] }];
ok(t3.projectActionModelView(malformedHist, malformedAudit).changed === false, 'A4 malformed arguments are never projected (no empty envelope)');
// A5: 白名单外工具(已覆盖)
// A6: 路径穿越 → basename 只取尾段,不携带上级路径
const travEnv = t3.buildActionEnvelope('file_write', { path: 'C:\\repo\\..\\..\\evil.txt' }, '{"path":"C:\\\\repo\\\\..\\\\..\\\\evil.txt"}');
ok(travEnv.target.basename === 'evil.txt' && !travEnv.target.basename.includes('..'), 'A6 path traversal sanitized: basename is the tail segment only');
// A7: 审计容量上限 —— server 端 200 条截断存在
ok(src.includes('session.actionAudit.length > 200') && src.includes("splice(0, session.actionAudit.length - 200)"), 'A7 audit capped at 200 entries (no unbounded growth)');
// A8: 失败/中断动作不瘦身(execution view 完整) —— 服务端失败动作落 audit 时记 status=failed
ok(src.includes("status: isErr ? 'failed' : 'completed'"), 'A8 failed actions recorded as failed (never projected)');

console.log('');
if (fail) { console.log(`ACTION-MODEL-VIEW UNIT: FAIL (${fail})`); process.exit(1); }
console.log('ACTION-MODEL-VIEW UNIT: ALL PASS');
