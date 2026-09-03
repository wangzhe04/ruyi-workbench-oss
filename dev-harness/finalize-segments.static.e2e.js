#!/usr/bin/env node
'use strict';

// 47b/86 (v1.9.1 wave): 验证「工具超时但一直卡在运行中」修复。
// 回合被 Stop/看门狗/异常中止时,正在执行的 tool/subagent/workflow 段拿不到 tool_result/end 事件,
// 旧行为以 status:'running' 落盘并在刷新后永远显示「运行中」。本门验证两条兜底:
//   1) createTurnSegmentBuilder().finalizeAll(reason) 在 snapshot() 前把悬空 running 段标 'cancelled',
//      已 done/error 的段不动;
//   2) healStalePendingSegments 在 loadSession 时把存量 running tool/subagent/workflow 段标 'cancelled'
//      (修复前落盘的旧会话);
//   3) 桥接超时表给 ACC `wait`(cap 300s) 310s,不再用默认 120s 杀掉合法 wait(300)。
// 纯静态:vm 加载 02c-turn-segments.js 的 builder 片段 + 02-session-store.js 的 heal 片段
// + 04-permission-runtime.js 的超时表,不启服务器。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const read = file => fs.readFileSync(file, 'utf8');

let failures = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { failures += 1; console.log('FAIL ' + label); }
};

// --- load createTurnSegmentBuilder + healStalePendingSegments from source -------------------
// 110-3b: createTurnSegmentBuilder 已搬至 02c-turn-segments.js。builder 片段改从 02c 取(02c 只含
// 该构建器,故终点即文件末尾,切出的字节与旧哨兵 '\n// v0.8-S3/S4a:' 截出的完全相同);
// healStalePendingSegments 仍取自 02。只改读取来源,断言与期望值一字未改。
const store = read(path.join(SRC, '02-session-store.js'));
const builderSrc = read(path.join(SRC, '02c-turn-segments.js'));
const builderStart = builderSrc.indexOf('function createTurnSegmentBuilder()');
const builderEnd = builderSrc.length;
ok(builderStart >= 0 && builderEnd > builderStart, 'F1 createTurnSegmentBuilder 在 session store 源码');

const healStart = store.indexOf('function healStalePendingSegments(session)');
const healEnd = store.indexOf('\nasync function loadSession(', healStart);
ok(healStart >= 0 && healEnd > healStart, 'F2 healStalePendingSegments 在 session store 源码');

// Build a vm context with the globals healStalePendingSegments references (the pending registries).
const pendingPermissions = new Map();
const pendingPlans = new Map();
const pendingQuestions = new Map();
const ctx = { pendingPermissions, pendingPlans, pendingQuestions };
// Load the builder + healStalePendingSegments together (healStalePendingSegments is standalone,
// references the module-level Maps which we inject via context).
const slice = builderSrc.slice(builderStart, builderEnd) + '\n' + store.slice(healStart, healEnd) +
  '\nthis.createTurnSegmentBuilder = createTurnSegmentBuilder; this.healStalePendingSegments = healStalePendingSegments;';
vm.runInNewContext(slice, ctx);

const builder = ctx.createTurnSegmentBuilder();

// --- F3: finalizeAll marks running tool/subagent/workflow as cancelled, leaves done alone ----
const batch = builder.createBatchId('openai');
builder.consume({ type: 'assistant_delta', text: '先说明。' });
builder.consume({ type: 'tool_use', id: 't-running', name: 'run_command', batchId: batch });
builder.consume({ type: 'tool_use', id: 't-done', name: 'file_read', batchId: batch });
builder.consume({ type: 'tool_result', id: 't-done', content: 'ok' });
builder.consume({ type: 'tool_use', id: 't-error', name: 'shell_send', batchId: batch });
builder.consume({ type: 'tool_result', id: 't-error', content: 'boom', isError: true });
builder.consume({ type: 'subagent', id: 's-running', state: 'start' });
builder.consume({ type: 'agent_workflow', id: 'wf1', state: 'run' });

const healed = builder.finalizeAll('回合被停止,进行中的工具已中断');
const segs = builder.snapshot();
const find = (cid) => segs.find(s => s.toolCallId === cid || s.workflowId === cid);

ok(healed === 3, `F3 finalizeAll 报告 3 处悬空段 (got ${healed})`);
ok(find('t-running').status === 'cancelled', 'F3a 运行中工具 -> cancelled');
ok(find('t-running').note && find('t-running').note.includes('停止'), 'F3b cancelled 段带中断 note');
ok(find('t-done').status === 'done', 'F3c 已完成工具不被触碰 (仍 done)');
ok(find('t-error').status === 'error', 'F3d 已出错工具不被触碰 (仍 error)');
ok(find('s-running').status === 'cancelled', 'F3e 运行中 subagent -> cancelled');
ok(find('wf1').status === 'cancelled', 'F3f 运行中 workflow -> cancelled');

// --- F4: a normally-completing turn (no finalizeAll) still works & running segments persist ---
const b2 = ctx.createTurnSegmentBuilder();
const batch2 = b2.createBatchId('claude');
b2.consume({ type: 'tool_use', id: 'x1', name: 'git_status', batchId: batch2 });
const beforeSegs = b2.snapshot();
ok(beforeSegs.find(s => s.toolCallId === 'x1').status === 'running', 'F4 未 finalize 的运行段保持 running (证明 finalizeAll 是显式收尾,不是副作用)');
b2.consume({ type: 'tool_result', id: 'x1', content: 'clean' });
ok(b2.snapshot().find(s => s.toolCallId === 'x1').status === 'done', 'F4 正常 tool_result 仍把 running -> done');

// --- F5: healStalePendingSegments heals persisted running tool/subagent/workflow segments ------
const session = {
  messages: [{
    role: 'assistant',
    segments: [
      { type: 'tool', toolCallId: 'old-tool', status: 'running' },
      { type: 'tool', toolCallId: 'old-done', status: 'done' },
      { type: 'subagent', toolCallId: 'old-sub', status: 'running' },
      { type: 'workflow', workflowId: 'old-wf', status: 'running' },
      { type: 'workflow', workflowId: 'old-wf-paused', status: 'paused' },
      { type: 'permission', requestId: 'old-perm', status: 'pending' },
      { type: 'tool', toolCallId: 'old-done2', status: 'done' },
    ],
  }],
};
const healedSession = ctx.healStalePendingSegments(session);
ok(healedSession === true, 'F5 healStalePendingSegments 报告有修复');
const seg = (cid) => session.messages[0].segments.find(s => s.toolCallId === cid || s.workflowId === cid || s.requestId === cid);
ok(seg('old-tool').status === 'cancelled', 'F5a 存量 running 工具 -> cancelled');
ok(seg('old-done').status === 'done' && seg('old-done2').status === 'done', 'F5b 已完成工具不动');
ok(seg('old-sub').status === 'cancelled', 'F5c 存量 running subagent -> cancelled');
ok(seg('old-wf').status === 'cancelled', 'F5d 存量 running workflow -> cancelled');
ok(seg('old-wf-paused').status === 'cancelled', 'F5e 存量 paused workflow -> cancelled');
ok(seg('old-perm').status === 'cancelled', 'F5f 存量 pending permission 仍被修 (回归保护)');

// --- F6: live pending permission is NOT healed (decision may still arrive) ------------------
pendingPermissions.set('live-perm', { sessionId: 'x' });
const live = { messages: [{ segments: [{ type: 'permission', requestId: 'live-perm', status: 'pending' }] }] };
ctx.healStalePendingSegments(live);
ok(live.messages[0].segments[0].status === 'pending', 'F6 活待决 permission 不被误标 (决策仍会到达)');

// --- F7: bridge timeout table gives `wait` 310s, run_command 650s, default 120s -------------
const perm = read(path.join(SRC, '04-permission-runtime.js'));
const tStart = perm.indexOf('const BRIDGED_TOOL_TIMEOUTS = {');
const fnStart = perm.indexOf('function bridgedToolTimeoutMs(name)', tStart);
const fnEnd = perm.indexOf('\n}', fnStart) + 2;
ok(tStart >= 0 && fnEnd > fnStart, 'F7 桥超时表 + 函数在源码');
const tctx = { process: { env: {} } };
// Load: the timeout table const + the default const + bridgedToolTimeoutMs (all contiguous in source).
vm.runInNewContext(perm.slice(tStart, fnEnd) + '\nthis.bridgedToolTimeoutMs = bridgedToolTimeoutMs;', tctx);
ok(typeof tctx.bridgedToolTimeoutMs === 'function', 'F7 bridgedToolTimeoutMs 可调用');
if (typeof tctx.bridgedToolTimeoutMs === 'function') {
  ok(tctx.bridgedToolTimeoutMs('wait') === 310000, `F7a wait -> 310000ms (got ${tctx.bridgedToolTimeoutMs('wait')})`);
  ok(tctx.bridgedToolTimeoutMs('run_command') === 650000, 'F7b run_command -> 650000ms');
  ok(tctx.bridgedToolTimeoutMs('file_read') === 900000, 'F7c 未知长工具默认 -> 900000ms');
  // override env path
  tctx.process.env.WCW_BRIDGED_TIMEOUT_OVERRIDE = 'wait:5000';
  ok(tctx.bridgedToolTimeoutMs('wait') === 5000, 'F7d WCW_BRIDGED_TIMEOUT_OVERRIDE 覆盖 wait -> 5000ms');
}

// --- summary ---------------------------------------------------------------------------------
console.log('\n' + (failures ? `FINALIZE-SEGMENTS STATIC: FAIL (${failures})` : 'FINALIZE-SEGMENTS STATIC: ALL PASS'));
process.exit(failures ? 1 : 0);
