'use strict';
// 子代理/工作流收尾的几处「停不下来」(代码走查 C10 / C11,回合引擎审计 t8)。真源码、临时 HOME。
//   [L1] 子代理的 provider 端点或模型没配好 → 提前返回时初始化心跳一并停掉。
//        修前 setInterval 不清:每秒一次 subagent_progress,一直重写 run 快照,直到进程退出。
//   [L3] 第一次模型调用之前就被中止(循环顶端 break)→ 初始化心跳同样停掉(审计 t8;外壳 finally 兜所有出口)。
//   [L2] 工作流收尾等事件落盘有上限:事件追加真卡住(网络盘/杀软持锁)时,收尾不跟着一起卡死。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-run-leaks-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { runSubAgentCore, appendAgentRunEvent, flushAgentRunEvents } = srv;
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('[L1] 没配好 provider 提前返回 → 心跳停掉', async () => {
  const beats = [];
  const r = await runSubAgentCore({
    parentSession: { id: 'sess_leak01', cwd: root }, provider: { baseUrl: '', model: '' }, config: {},
    task: 't', onEvent: e => { if (e && e.type === 'subagent_progress') beats.push(e); }, subagentId: 'sa_1', depth: 1,
  });
  assert.equal(r.ok, false);
  const before = beats.length;
  await sleep(2300);
  assert.equal(beats.length, before, `返回之后心跳还在跳(多了 ${beats.length - before} 次)`);
});

test('[L3] 第一次模型调用之前就被中止 → 初始化心跳也停掉(审计 t8)', async () => {
  // 修前:循环顶端查到 ctrl 已中止就 break,stopInitBeat 在后面(发第一次模型调用前)才调 —— break 走了那条路之外,
  // 返回之后心跳每秒一条 subagent_progress 一直跳。端点是个不监听的本机端口:真走到模型调用也只会连接失败,不会挂住。
  const beats = [];
  let endedAt = 0;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 1);
  const r = await runSubAgentCore({
    parentSession: { id: 'sess_leak03', cwd: root, turnSeq: 1 },
    provider: { id: 'p', baseUrl: 'http://127.0.0.1:9', model: 'm' }, config: {},
    task: 't', toolTier: 'read', maxIters: 3, subagentId: 'sa_3', depth: 1, ctrl, runId: 'run_leak03',
    onEvent: e => {
      if (e && e.type === 'subagent' && e.state === 'end') endedAt = Date.now();
      if (e && e.type === 'subagent_progress' && endedAt) beats.push(Date.now() - endedAt);
    },
  });
  assert.equal(r.ok, false);
  await sleep(2300);
  assert.deepEqual(beats, [], `返回之后心跳还在跳(结束后 ${JSON.stringify(beats)} ms 各一次)`);
});

test('[L2] 事件追加卡住 → 收尾最多等上限时长', async () => {
  const run = { id: 'run_hang01', sessionId: 'sess_hang01', eventSeq: 0 };
  const orig = fsp.appendFile;
  let release;
  fsp.appendFile = function (p) {
    if (String(p).includes('run_hang01')) return new Promise(r => { release = () => r(orig.apply(fsp, arguments)); });
    return orig.apply(this, arguments);
  };
  try {
    appendAgentRunEvent(run, { type: 'run_end', data: {} });
    const t0 = Date.now();
    await flushAgentRunEvents(run.id, 200);
    const waited = Date.now() - t0;
    assert.ok(waited < 1500, `收尾被卡住的事件追加拖了 ${waited} ms`);
  } finally {
    fsp.appendFile = orig;
    if (release) release();
  }
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
