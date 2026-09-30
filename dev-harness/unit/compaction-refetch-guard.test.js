'use strict';
// 压缩后重取守卫(10 createCompactionRefetchGuard)与每回合配额的回合键(10 providerTurnQuotaKey)的判据细节。
// 真源码整段切进 vm(这几个函数不出 module.exports);端到端的抖动复现与接线见 compaction-refetch-guard.e2e.js。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const { readServerSource } = require('../src-reader');
const { sliceBlock, constBlock, functionBlock } = require('../lib/source-slice');

const source = readServerSource();
const block = sliceBlock(source, '// ── 压缩后重取守卫(回合内)', '// True shadow evaluation for 20-C1');
// 工具档位用真表(07 NATIVE_TOOL_TIER + nativeToolTier),不另写一份假的
const tierBlock = constBlock(source, 'NATIVE_TOOL_TIER') + '\n' + functionBlock(source, 'nativeToolTier');
function load() {
  const ctx = vm.createContext({ EVAPORATED_PREFIX: '[已省略:' });
  vm.runInContext(tierBlock + '\n' + block + '\nglobalThis.__limits = COMPACTION_REFETCH_LIMITS;', ctx);
  return ctx;
}
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const asst = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls });
const tool = (id, content) => ({ role: 'tool', tool_call_id: id, content });
const READ_A = JSON.stringify({ path: 'a.txt' });

test('[R1] 完整 / 压缩后的判据:蒸发占位、两种缩减视图、守卫自己的拒绝都不算完整;正文里只是提到这几个字不误判', () => {
  const { toolResultIsFull } = load();
  assert.equal(toolResultIsFull('{"ok":true,"content":"hello"}'), true);
  assert.equal(toolResultIsFull('[已省略:{"ok":true,"content":"hel]'), false);
  assert.equal(toolResultIsFull('[Ruyi observation reduced · policy=text_head_tail · originalChars=9000 · rawRef=history:1]\nabc'), false);
  assert.equal(toolResultIsFull('{"ok":true,"content":"x","_ruyiObservation":{"reduced":true,"policy":"json_structured"}}'), false);
  assert.equal(toolResultIsFull('{"ok":false,"error":"compaction_refetch_refused","message":"…"}'), false);
  // 读到的文件正文里恰好有这些字:在 JSON 串值里引号被转义,不命中
  const fileBody = JSON.stringify({ ok: true, content: 'x = {"_ruyiObservation":{"reduced":true}} // "error":"compaction_refetch_refused"' });
  assert.equal(toolResultIsFull(fileBody), true);
  assert.equal(toolResultIsFull(undefined), false);
});

test('[R2] 历史里有没有这次调用的完整结果:按单元就近配对(跨迭代复用 call_1 不串味),参数逐字比', () => {
  const { historyHasFullToolResult } = load();
  const h = [
    { role: 'user', content: 'go' },
    asst(call('call_1', 'file_read', { path: 'a.txt' })), tool('call_1', '[已省略:a]'),
    asst(call('call_1', 'file_read', { path: 'b.txt' })), tool('call_1', '{"ok":true,"content":"B"}'),
  ];
  // 第二个单元的 call_1 是 b.txt 的完整结果,不能算到 a.txt 头上
  assert.equal(historyHasFullToolResult(h, 'file_read', READ_A), false);
  assert.equal(historyHasFullToolResult(h, 'file_read', JSON.stringify({ path: 'b.txt' })), true);
  // 参数串不同(多了 limit)就是另一次调用
  assert.equal(historyHasFullToolResult(h, 'file_read', JSON.stringify({ path: 'b.txt', limit: 5 })), false);
  // 同名不同工具
  assert.equal(historyHasFullToolResult(h, 'grep', JSON.stringify({ path: 'b.txt' })), false);
  // 重播种之后整段没了
  assert.equal(historyHasFullToolResult([{ role: 'user', content: '摘要' }, { role: 'assistant', content: '收到' }], 'file_read', READ_A), false);
});

test('[R3] 守卫计数:第一次调用不算;完整结果还在时重调不算;被压掉后重取依次 无 → 提醒 → 拒绝,拒绝后原样再来仍拒绝', () => {
  const ctx = load();
  const { WARN_AT, REFUSE_AT } = ctx.__limits;
  assert.deepEqual([WARN_AT, REFUSE_AT], [2, 3]);
  const check = ctx.createCompactionRefetchGuard();
  const full = [asst(call('c1', 'file_read', { path: 'a.txt' })), tool('c1', '{"ok":true,"content":"A"}')];
  const gone = [{ role: 'user', content: '【压缩摘要】…' }, { role: 'assistant', content: '收到' }];
  assert.equal(check([], 'file_read', READ_A).action, '');            // 第一次
  assert.equal(check(full, 'file_read', READ_A).count, 0);             // 完整结果还在:正常重读,不算
  assert.deepEqual({ ...check(gone, 'file_read', READ_A) }, { count: 1, action: '' });
  assert.deepEqual({ ...check(gone, 'file_read', READ_A) }, { count: 2, action: 'warn' });
  assert.deepEqual({ ...check(gone, 'file_read', READ_A) }, { count: 3, action: 'refuse' });
  const afterRefusal = [...gone, asst(call('c9', 'file_read', { path: 'a.txt' })), tool('c9', JSON.stringify(ctx.compactionRefetchRefusal(3)))];
  assert.equal(check(afterRefusal, 'file_read', READ_A).action, 'refuse', '拒绝结果不算完整结果,原样重试仍被拒');
  // 缩小范围 = 新签名,从头计
  assert.equal(check(gone, 'file_read', JSON.stringify({ path: 'a.txt', limit: 20 })).action, '');
  // 每个回合一个新守卫,计数不串
  assert.equal(ctx.createCompactionRefetchGuard()(gone, 'file_read', READ_A).action, '');
});

test('[R4] 拒绝与提醒的文案:错误码稳定、给出换做法', () => {
  const ctx = load();
  const refusal = ctx.compactionRefetchRefusal(3);
  assert.equal(refusal.ok, false);
  assert.equal(refusal.error, 'compaction_refetch_refused');
  assert.match(refusal.message, /offset\/limit/);
  assert.match(ctx.compactionRefetchWarning(2), /第 2 次/);
});

test('[R5] 每回合配额的回合键:优先 turnSeq(压缩改 user 条数不换桶);没有 turnSeq 时退回 user 条数', () => {
  const { providerTurnQuotaKey } = load();
  const before = { turnSeq: 7, providerHistory: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' }, { role: 'user' }] };
  const afterReseed = { turnSeq: 7, providerHistory: [{ role: 'user' }, { role: 'assistant' }, { role: 'user' }] };
  assert.equal(providerTurnQuotaKey(before), providerTurnQuotaKey(afterReseed));
  assert.notEqual(providerTurnQuotaKey({ ...before, turnSeq: 8 }), providerTurnQuotaKey(before));
  assert.equal(providerTurnQuotaKey({ providerHistory: [{ role: 'user' }, { role: 'user' }] }), 'u2');
  assert.equal(providerTurnQuotaKey(null), 'u0');
});

test('[R6] 只数内容型读取:结果会随状态变的调用(跑测试、git_status、截图、agent_result)重复多少次都不算重取', () => {
  const ctx = load();
  const check = ctx.createCompactionRefetchGuard();
  const gone = [{ role: 'user', content: '【压缩摘要】…' }, { role: 'assistant', content: '收到' }];
  const npmTest = JSON.stringify({ command: 'npm test' });
  for (let i = 0; i < 6; i++) assert.equal(check(gone, 'shell_exec', npmTest).action, '', `第 ${i + 1} 次 npm test 照常执行`);
  for (const [name, args] of [['git_status', '{}'], ['todo_write', '{"todos":[]}'], ['agent_result', '{"runId":"r1"}'], ['wait_agents', '{}']]) {
    for (let i = 0; i < 5; i++) assert.equal(check(gone, name, args).action, '', `${name} 不计`);
  }
  // 桥接(MCP)工具:档位未知 → 按 exec,既不计也会清零
  for (let i = 0; i < 5; i++) assert.equal(check(gone, 'acc__screenshot', '{}').action, '');
});

test('[R7] 本回合有非 read 档的调用(改文件、跑命令、桥接工具)就清零:改完再读是新信息,不是重取;纯 A/B 来回照样抓', () => {
  const ctx = load();
  const check = ctx.createCompactionRefetchGuard();
  const gone = [{ role: 'user', content: '【压缩摘要】…' }, { role: 'assistant', content: '收到' }];
  // 边改边读(review 复现的场景):读 → 压掉 → 改 → 读 …… 每一轮中间都有 file_edit,永远不提醒、不拒绝
  for (let i = 0; i < 6; i++) {
    assert.equal(check(gone, 'file_read', READ_A).action, '', `第 ${i + 1} 次核对读取照常`);
    check(gone, 'file_edit', JSON.stringify({ path: 'a.txt', old: 'x', new: 'y' }));
  }
  // 清零之后从头计:第一次算「首次见到」,之后依次 无 → 提醒 → 拒绝
  check(gone, 'shell_exec', JSON.stringify({ command: 'npm run build' }));
  assert.equal(check(gone, 'file_read', READ_A).action, '');
  assert.equal(check(gone, 'file_read', READ_A).action, '');
  assert.equal(check(gone, 'file_read', READ_A).action, 'warn');
  assert.equal(check(gone, 'file_read', READ_A).action, 'refuse');
  // 被拒后一次写动作解除拒绝
  check(gone, 'file_write', JSON.stringify({ path: 'a.txt', content: 'z' }));
  assert.equal(check(gone, 'file_read', READ_A).action, '');
  assert.equal(check(gone, 'file_read', READ_A).action, '', '清零后第一次重取不提醒');
});
