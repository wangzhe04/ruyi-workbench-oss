'use strict';
// 子代理断点续跑(08 runSubAgentCore 第32波 savepoint)重放的历史要与原样一致(审计 t10)。真源码、临时 HOME、
// 进程内假 provider。
//   [P1] 第一发:带 reasoning_content 的工具调用;工具跑完存检查点;第二发 500 → 从检查点恢复
//        再发。恢复后那一发里重放的 assistant(tool_calls)仍带 reasoning_content。修前检查点按
//        role/content/tool_call_id/tool_calls 白名单抄,reasoning_content(DeepSeek 思考模式带工具调用时必须回传)
//        与 providerBlocks(Anthropic 线协议原样块)被丢掉。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startFakeProvider, textFrames, toolCallFrames, usageFrame } = require('../lib/fake-openai-provider');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-sub-savepoint-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { runSubAgentCore } = srv;

test('[P1] 检查点恢复后重放的 assistant 仍带 reasoning_content', async () => {
  let n = 0;
  const fake = await startFakeProvider({
    handler() {
      n += 1;
      if (n === 1) {
        const f = toolCallFrames('file_list', { path: root }, 'call_r1');
        f.unshift({ id: 'x', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'THINKING-BLOB' }, finish_reason: null }] });
        return f;
      }
      if (n >= 2 && n <= 5) return { status: 500, json: { error: { message: 'boom' } } };   // 工具之后的那一发失败 → 从检查点恢复
      return [...textFrames('final'), usageFrame(8, 4)];
    },
  });
  try {
    const provider = { id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' };
    const r = await runSubAgentCore({
      parentSession: { id: 'sess_savepoint01', cwd: root, turnSeq: 1 }, provider, config: { permissionMode: 'bypass', defaultWorkspace: root },
      task: 'list', toolTier: 'read', maxIters: 6, onEvent: () => {}, subagentId: 'sa_sp1', depth: 1, ctrl: new AbortController(), runId: 'run_sp1',
    });
    // 恢复之后那一发 = 请求里带「[自动恢复]」那条 user 的那一发
    const restored = fake.requests.find(q => q.messages.some(m => m.role === 'user' && /\[自动恢复\]/.test(String(m.content))));
    assert.ok(restored, `前提:走到了检查点恢复(实发 ${fake.requests.length} 次,结果 ${JSON.stringify(r)})`);
    const replayed = restored.messages.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.ok(replayed, '恢复那一发里有重放的 assistant(tool_calls)');
    assert.equal(replayed.reasoning_content, 'THINKING-BLOB', '重放的 assistant 丢了 reasoning_content');
  } finally {
    await fake.close();
  }
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
