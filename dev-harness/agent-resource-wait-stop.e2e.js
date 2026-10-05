'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:代理工作流两处走查缺陷(09-workflow)。
//   W1 节点级资源租约等待不是「空闲」:两个 run 争同一个 workspace 资源,先到的 run 持有它(provider 流式吐字,有进展)很久,
//      后到的 run 的唯一节点在 waiting_resource 里排队,等得比 run 级空闲看门狗上限(WCW_AGENT_WORKFLOW_IDLE_MS)还久。
//      修前节点级租约等待期间没有任何事件(工具级等待有心跳,节点级没有),整个 run 被判「无进展」中止(idleAborted、
//      节点 idle_timeout);现在在排队 = 不计空闲,持有者放手后照常拿到资源、跑完 succeeded。
//   W2 父回合被用户 Stop 导致 run 中止:run 终态记 stopped(与「停止这个 run」同一个终态),不是 failed / partial。
//      后台 run 的完成信封据此不会被当成失败去唤醒主会话(自动唤醒对 stopped 不唤醒)。
//
// W2 先跑、用不带测试旗的服务(没有空闲看门狗的干扰);W1 再起一个带旗的服务。
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-agent-wait-stop-'));
const t = createRunner('AGENT RESOURCE WAIT / PARENT STOP');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const isSub = messages => String(((messages || []).find(m => m.role === 'system') || {}).content || '').includes('子任务执行体');
const userTextOf = messages => (messages || []).filter(m => m && m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n');
const IDLE_MS = 2500;   // run 级空闲上限(测试旗);run 级看门狗每 5 s 一拍
const HOLD_CHUNKS = 30;
const HOLD_CHUNK_MS = 400;   // 持有者流式吐字 30 × 400 ms ≈ 12 s,每个 chunk 都是「子代理有进展」

function req(port, method, route, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = payload ? JSON.stringify(payload) : '';
    const r = http.request({ host: '127.0.0.1', port, path: route, method, timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* raw */ } resolve({ status: res.statusCode, body: j, raw: b }); });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + route)); });
    if (data) r.write(data); r.end();
  });
}
async function waitFor(fn, tries = 60, gap = 150) {
  for (let i = 0; i < tries; i++) { const v = await fn().catch(() => null); if (v) return v; await sleep(gap); }
  return null;
}

(async () => {
  let wb = null;
  let port = 0;
  const hdr = {};
  const fake = await startFakeProvider({
    async handler(r) {
      const text = userTextOf(r.messages);
      if (isSub(r.messages)) {
        if (text.includes('HOLDER-LONG')) {
          // 持有者:流式慢慢吐字,12 s 里一直有进展。
          r.open();
          for (let i = 0; i < HOLD_CHUNKS; i++) {
            if (r.res.destroyed || r.res.writableEnded) return undefined;
            r.sse({ id: 'hold', choices: [{ index: 0, delta: i === 0 ? { role: 'assistant', content: '.' } : { content: '.' }, finish_reason: null }] });
            await sleep(HOLD_CHUNK_MS);
          }
          r.sse({ id: 'hold', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
          r.end();
          return undefined;
        }
        if (text.includes('W2-SLOW')) { await sleep(20000); return textFrames('sub finally done'); }
        return textFrames('sub done');
      }
      // 父回合:W2 先起一个前台 run,拿到工具结果后收尾。
      if (!r.messages.some(m => m.role === 'tool') && text.includes('W2-GO')) return toolCallFrames('orchestrate_agents', { task: 'W2-SLOW 慢节点' }, 'c1');
      return textFrames('parent done');
    },
  });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 8, version: '1.0.0', permissionMode: 'bypass', toolLoadingMode: 'full', defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 32, subagentMaxConcurrent: 2, subagentBudgetMigrated: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  const start = async extraEnv => {
    port = await getFreePort();
    const env = { ...process.env, HOME, USERPROFILE: HOME, RUYI_HOME: HOME, ...(extraEnv || {}) };
    delete env.WIN_CLAUDE_WORKBENCH_HOME;
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env, windowsHide: true });
    wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
    const token = await waitFor(async () => { const r = await req(port, 'GET', '/'); const m = (r.raw || '').match(/name="wcw-token"\s+content="([a-f0-9]+)"/); return m && m[1]; }, 80, 200);
    if (!token) throw new Error('workbench did not start');
    hdr['x-wcw-token'] = token;
  };
  const stop = async () => { if (wb) { try { killOwnTree(wb); } catch { /* gone */ } wb = null; await sleep(400); } };
  const api = (method, route, body) => req(port, method, route, body, hdr);
  const getRun = async (sid, rid) => ((await api('GET', `/api/agent-runs/${rid}?sessionId=${sid}`)).body || {}).run || null;
  const settled = s => ['succeeded', 'failed', 'cancelled', 'stopped', 'partial'].includes(String(s));
  try {
    /* ═════════ W2 父回合被停止 → run 记 stopped ═════════ */
    await start();
    const sid2 = (await api('POST', '/api/sessions', { title: 'parent-stop', cwd: HOME })).body.session.id;
    let chatEnded = false;
    const data = JSON.stringify({ sessionId: sid2, message: 'W2-GO', cwd: HOME });
    const chat = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...hdr } }, res => { res.resume(); res.on('end', () => { chatEnded = true; }); });
    chat.on('error', () => { chatEnded = true; });
    chat.write(data); chat.end();
    const live2 = await waitFor(async () => { const l = (await api('GET', `/api/agent-runs?sessionId=${sid2}`)).body || {}; return (l.runs || []).find(x => x.live); }, 80, 150);
    ok(!!live2, 'W2 前提:回合内起了一个活的前台 run');
    if (live2) {
      // 等节点真的在跑(provider 请求已到),再按停止:这样走的是「在飞节点被中止」的路径。
      const running = await waitFor(async () => { const run = await getRun(sid2, live2.id); return run && (run.nodes || []).some(n => n.status === 'running') && run; }, 60, 100);
      ok(!!running, 'W2 前提:节点在跑');
      await api('POST', '/api/stop', { sessionId: sid2 });
      ok(await waitFor(async () => chatEnded, 80, 100), 'W2 按回合的停止 → 聊天流收尾');
      const fin = await waitFor(async () => { const run = await getRun(sid2, live2.id); return run && settled(run.status) && run; }, 80, 100);
      ok(!!fin && fin.status === 'stopped', `W2 父回合被停止导致的中止:run 记 stopped(修前 failed / partial;实得 ${fin && fin.status})`);
      ok(!!fin && fin.idleAborted !== true, 'W2 不是看门狗中止(没有 idleAborted 标)');
    }
    await stop();

    /* ═════════ W1 节点级资源等待不算空闲 ═════════ */
    await start({ WCW_AGENT_WORKFLOW_IDLE_MS: String(IDLE_MS), WCW_TURN_IDLE_MS: '4000' });
    const sid1 = (await api('POST', '/api/sessions', { title: 'lease-wait', cwd: HOME })).body.session.id;
    const resources = ['workspace:' + HOME];
    const holder = await api('POST', '/api/agent-workflow/launch', { token: hdr['x-wcw-token'], sessionId: sid1, async: true, nodes: [{ id: 'hold', task: 'HOLDER-LONG 持有资源', resources }] });
    ok(holder.body && holder.body.ok === true && holder.body.accepted === true, 'W1 持有者 run 被受理');
    const holderHolding = await waitFor(async () => { const run = await getRun(sid1, holder.body.runId); const n = run && (run.nodes || [])[0]; return n && n.status === 'running' && (n.acquiredResources || []).length && run; }, 80, 100);
    ok(!!holderHolding, 'W1 前提:持有者的节点拿到资源、在跑');
    const waiter = await api('POST', '/api/agent-workflow/launch', { token: hdr['x-wcw-token'], sessionId: sid1, async: true, nodes: [{ id: 'wait', task: 'WAITER-QUICK 等资源', resources }] });
    ok(waiter.body && waiter.body.ok === true && waiter.body.accepted === true, 'W1 等待者 run 被受理');
    const waitingSince = Date.now();
    const parked = await waitFor(async () => { const run = await getRun(sid1, waiter.body.runId); const n = run && (run.nodes || [])[0]; return n && n.status === 'waiting_resource' && run; }, 80, 100);
    ok(!!parked, 'W1 前提:等待者的节点在 waiting_resource 里排队');
    // 等持有者收尾,等待者随后拿到资源跑完。
    const holderDone = await waitFor(async () => { const run = await getRun(sid1, holder.body.runId); return run && settled(run.status) && run; }, 200, 200);
    const waitedMs = Date.now() - waitingSince;
    ok(!!holderDone && holderDone.status === 'succeeded', `W1 持有者自己跑完(实得 ${holderDone && holderDone.status})`);
    ok(waitedMs > IDLE_MS + 5000, `W1 前提:等待者排队时间(${waitedMs}ms)越过了 run 级空闲上限(${IDLE_MS}ms)加一整拍看门狗(5 s)`);
    const waiterDone = await waitFor(async () => { const run = await getRun(sid1, waiter.body.runId); return run && settled(run.status) && run; }, 200, 200);
    ok(!!waiterDone && waiterDone.status === 'succeeded', `W1 等待者没有被当成空闲中止,拿到资源后跑完 succeeded(修前 idleAborted / failed;实得 ${waiterDone && waiterDone.status})`);
    ok(!!waiterDone && waiterDone.idleAborted !== true, 'W1 等待者 run 没有 idleAborted 标');
    ok(!!waiterDone && (waiterDone.nodes || []).every(n => n.errorClass !== 'idle_timeout'), 'W1 等待者的节点没有 idle_timeout 归类');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    await stop();
    await fake.close();
    if (t.failures === 0) fs.rmSync(HOME, { recursive: true, force: true });
    else console.log('[keep] ' + HOME);
  }
  t.done({ exit: true });
})();
