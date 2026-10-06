'use strict';
// 第二波后端走查(2026-10)对「后台代理唤醒 / 压缩索引」的几条修复,钉纯函数与小闭包(真 server.js,经 lib/server-internals)。
//  C1 压缩工具索引:服务商每次迭代都从 call_1 起编号时,三次调用各配各的结果、三行都在(修前全配到第一次的结果,
//     算出同一个 rawRef 被去重,一次性的 web_fetch / powershell_run 恰好被丢)。
//  C2 手动 L2 塌成的 [摘要, 收到] 再被自动压缩时,「原始任务」取旧摘要的【目标】一节,旧工具索引不会被钉成任务原文(修前出现两份)。
//  W1 记账键带完成时刻:同一个 run 续跑 / 重试后再交一份信封,键不同 → 会再唤醒;同一份信封键相同。
//  W2 进程重启打断的(interrupted)与用户叫停的一样不唤醒。
//  G1 runGit 的 timeoutMs 不是数字时回落缺省,不再 1 ms 就把跑完的 git 杀掉、报「超过 0 秒」。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-unit-wake-compaction-'));
process.env.RUYI_HOME = home;
const { loadServerInternals } = require('../lib/server-internals');
const {
  buildCompactionToolIndex, compactionTaskText, COMPACTION_TOOL_INDEX_HEADER,
  agentWakeJobKey, agentWakeSkipsStatus, runGit,
} = loadServerInternals(['buildCompactionToolIndex', 'compactionTaskText', 'COMPACTION_TOOL_INDEX_HEADER', 'agentWakeJobKey', 'agentWakeSkipsStatus', 'runGit']);

const call = (name, args, id = 'call_1') => ({ role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (text, id = 'call_1') => ({ role: 'tool', tool_call_id: id, content: text });

describe('compaction tool index · reused tool_call ids', () => {
  it('C1 three iterations that all use call_1 keep three index lines, each with its own result', () => {
    const history = [
      { role: 'user', content: '查一下' },
      call('file_read', { path: 'a.txt' }), result('A'.repeat(500)),
      call('web_fetch', { url: 'https://example.invalid/x' }), result('B'.repeat(900)),
      call('powershell_run', { command: 'Get-Date' }), result('C'.repeat(1300)),
      { role: 'assistant', content: '好了' },
    ];
    const index = buildCompactionToolIndex(history, { upto: history.length, rawRefPrefix: 'history:3:0123456789abcdef', config: { runtimeObservationRecallV1: true, runtimeObservationReducerV1: true } });
    const lines = index.split('\n').filter(l => l.startsWith('- '));
    assert.equal(lines.length, 3, index);
    assert.ok(lines[0].includes('file_read') && lines[0].includes('500 字'), lines[0]);
    assert.ok(lines[1].includes('web_fetch') && lines[1].includes('900 字'), lines[1]);
    assert.ok(lines[2].includes('powershell_run') && lines[2].includes('1300 字'), lines[2]);
    const refs = lines.map(l => (l.match(/rawRef=(\S+)/) || [])[1]).filter(Boolean);
    assert.equal(refs.length, 3, 'every call carries a rawRef (recall is on)');
    assert.equal(new Set(refs).size, 3, 'each call has its own rawRef');
  });
  it('C1b a tool result separated from its call by an injected user message is still paired', () => {
    const history = [call('web_fetch', { url: 'u' }, 'call_x'), { role: 'user', content: '插话' }, result('Z'.repeat(77), 'call_x')];
    const index = buildCompactionToolIndex(history, { upto: history.length });
    assert.ok(index.includes('77 字'), index);
  });
});

describe('compaction · task text after a manual L2', () => {
  it('C2 takes the 【目标】 section of the old summary, not the summary + tool index', () => {
    const manual = { role: 'user', content: '(以下是此前对话的压缩摘要)\n【目标】把报表导出成 CSV\n并发给财务\n【已确认的决定】无\n【当前执行状态】已完成:读文件\n\n' + COMPACTION_TOOL_INDEX_HEADER + '\n- file_read path=a.txt → 10 字' };
    const text = compactionTaskText(manual);
    assert.ok(text.startsWith('【目标】把报表导出成 CSV'), text);
    assert.ok(text.includes('并发给财务'), text);
    assert.ok(!text.includes(COMPACTION_TOOL_INDEX_HEADER) && !text.includes('【已确认的决定】'), text);
  });
  it('C2b without a 【目标】 section the tool index is still cut off', () => {
    const manual = { role: 'user', content: '(以下是此前对话的压缩摘要)\n随便写的摘要\n\n' + COMPACTION_TOOL_INDEX_HEADER + '\n- x → 1 字' };
    assert.equal(compactionTaskText(manual), '随便写的摘要');
  });
});

describe('agent wake bookkeeping', () => {
  it('W1 the attempted key changes when the same run delivers a new envelope', () => {
    const first = { id: 'agent:run_a', completedAt: '2026-10-06T01:00:00.000Z' };
    const again = { id: 'agent:run_a', completedAt: '2026-10-06T01:05:00.000Z' };
    assert.notEqual(agentWakeJobKey(first), agentWakeJobKey(again));
    assert.equal(agentWakeJobKey(first), agentWakeJobKey({ ...first }));
  });
  it('W2 interrupted, stopped and cancelled runs do not wake; finished ones do', () => {
    for (const s of ['interrupted', 'stopped', 'cancelled', 'canceled']) assert.equal(agentWakeSkipsStatus(s), true, s);
    for (const s of ['succeeded', 'failed', 'partial']) assert.equal(agentWakeSkipsStatus(s), false, s);
  });
});

describe('runGit · non-numeric timeout', () => {
  it('G1 timeoutMs:"30s" falls back to the default instead of killing git after 1 ms', async () => {
    // 在本仓库里跑 git status(比 1 ms 慢得多;修前这里稳定 timedOut:true)。
    const r = await runGit(['status', '--short'], path.resolve(__dirname, '..', '..'), '30s');
    assert.notEqual(r && r.timedOut, true, JSON.stringify(r));
  });
});
