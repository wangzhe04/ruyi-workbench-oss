'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
/*
 * 子代理时限(用户:「给子 agent 的限时似乎太少了」)—— 真服务 + 假 provider,env 缝把分钟缩成秒(只读 env、缺省即生产)。
 * 公式与出厂值由 unit/agent-time-limits.test.js 钉;这里钉【行为】:持续有进展的不被中止、真卡死的仍被中止、说明里讲清楚是哪种时限。
 *
 *   boot A(收尾 1s / 宽限 2.5s / 硬上限 10s / 节点空闲 30s / wait 默认 1.2s 上限 2.5s):
 *     A1 持续有进展的节点(约 6 秒,每步都是真工具调用)跑过「收尾 + 宽限」(3.5s)仍成功,只记「催过收尾」、没被强制中止;
 *        (修前:催收尾后宽限期一到墙钟就杀,同一个节点在 3.5s 处失败)
 *     A2 一直吐字、从不收尾的节点,在总时长硬上限(10s)处被中止 —— 原因 hard_cap、说明里写明「硬上限 / 节点自动收尾」怎么调;兄弟节点不受牵连;
 *     A3 催过收尾之后彻底没了动静的节点,宽限期(2.5s)一过就被中止 —— 原因 quiet、说明里写明「宽限期内没有任何进展」;
 *     A4 wait_agents:不给 timeoutMs 用默认窗、超大值按上限截;到点返回的是「这一次等待窗到了」(timedOut + 说明),run 照跑、不被中止。
 *   boot B(收尾关闭 / 节点空闲 3s / wait 用生产值):
 *     B1 空闲判据跟着进展走、不看墙钟:总时长 6 秒的节点(> 3s 空闲上限)只要一直有进展就成功;
 *     B2 从头到尾没有任何动静的节点,3 秒空闲上限一到被中止 —— errorClass idle_timeout、说明里写明哪个设置能调大;
 *     B3 wait_agents 的生产默认窗 / 上限经回环接口回报(waitMs):缺省 120000、超大 300000、0 与非数字 0。
 * 判定行:`AGENT NODE LIMITS E2E: ALL PASS`。
 */
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const t = createRunner('AGENT NODE LIMITS');
const { ok } = t;
const FRAME = { id: 'limits' };
const STEPS = 9;

function isSub(req) { return String((req.messages.find(m => m && m.role === 'system') || {}).content || '').includes('子任务执行体'); }
// 脚本化假 provider:按子代理任务里的标记分支。父回合不参与(工作流经 /api/agent-workflow/launch 直接起)。
async function handleChat(req) {
  if (!isSub(req)) return textFrames('parent', FRAME);
  const all = JSON.stringify(req.messages);
  const tools = req.messages.filter(m => m && m.role === 'tool').length;
  if (all.includes('ACTIVE_LONG')) {
    if (tools >= STEPS) return textFrames('long task finished', FRAME);
    await sleep(600);
    return toolCallFrames('file_read', { path: `f${tools}.txt` }, `call_long_${tools}`, FRAME);
  }
  if (all.includes('ACTIVE_FOREVER')) {
    req.open();
    const timer = setInterval(() => { req.sse({ id: 'limits', choices: [{ index: 0, delta: { content: '.' }, finish_reason: null }] }); }, 100);
    req.res.on('close', () => clearInterval(timer));
    return undefined;   // 自己接管:一直吐字,永远不收尾
  }
  if (all.includes('SILENT_AFTER_NUDGE')) {
    if (tools === 0) return toolCallFrames('file_read', { path: 'f0.txt' }, 'call_quiet_0', FRAME);
    return undefined;   // 第二发起一个字节都不回:催过收尾之后彻底没了动静
  }
  if (all.includes('HANG_NODE')) return undefined;   // 从头到尾没有动静
  return textFrames('fast sibling complete', FRAME);
}
function get(port, route, headers = {}) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: route, timeout: 2500, headers }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function post(port, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let out = ''; res.on('data', c => { out += c; }); res.on('end', () => { try { resolve(JSON.parse(out)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout ' + route)));
    req.on('error', reject); req.write(raw); req.end();
  });
}
async function waitFor(fn, tries = 100, gap = 100) {
  for (let i = 0; i < tries; i++) { const value = await fn(); if (value) return value; await sleep(gap); }
  return null;
}
const isTerminal = status => ['succeeded', 'failed', 'partial', 'stopped', 'cancelled'].includes(status);

async function boot(fake, env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-node-limits-'));
  for (let i = 0; i < STEPS; i++) fs.writeFileSync(path.join(home, `f${i}.txt`), `file ${i} has its own distinct content ${i * 7919}\n`, 'utf8');
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 12, permissionMode: 'bypass', defaultWorkspace: home, stewardThreadBriefV1: false,
    subagentMaxConcurrent: 4, agentWorkflowMaxNodes: 16,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
  }));
  const port = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, windowsHide: true, env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, ...env } });
  if (!(await waitFor(() => get(port, '/health'), 100, 150))) throw new Error('workbench did not start');
  const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port, path: '/' }, res => { let body = ''; res.on('data', c => { body += c; }); res.on('end', () => resolve(body)); }));
  const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1];
  const headers = { 'x-wcw-token': token };
  const created = await post(port, '/api/sessions', { title: 'limits', cwd: home }, headers);
  const sessionId = created.session.id;
  const env2 = {
    port, home, wb, headers, token, sessionId,
    launch: nodes => post(port, '/api/agent-workflow/launch', { token, sessionId, async: true, nodes }, headers),
    wait: body => post(port, '/api/agent-workflow/wait', { token, sessionId, ...body }, headers),
    async terminalRun(runId, tries = 200) {
      return waitFor(async () => {
        const list = await get(port, `/api/agent-runs?sessionId=${encodeURIComponent(sessionId)}`, headers);
        const run = list && Array.isArray(list.runs) && list.runs.find(r => r.id === runId);
        return run && !run.live && isTerminal(run.status) ? run : null;
      }, tries, 100);
    },
    close() { try { killOwnTree(wb); } catch { /* gone */ } try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* windows 句柄 */ } },
  };
  return env2;
}
const nodeOf = (run, id) => run && run.nodes.find(n => n.id === id);

(async () => {
  const fake = await startFakeProvider({ handler: handleChat });
  let a = null, b = null;
  try {
    // ───────── boot A:收尾 / 宽限 / 硬上限 缩成 1s / 2.5s / 10s ─────────
    a = await boot(fake, {
      WCW_AGENT_NODE_WRAPUP_MS: '1000', WCW_AGENT_NODE_WRAPUP_GRACE_MS: '2500', WCW_AGENT_NODE_HARDCAP_MS: '10000',
      WCW_AGENT_NODE_IDLE_MS: '30000', WCW_AGENT_WORKFLOW_IDLE_MS: '60000', WCW_TURN_IDLE_MS: '1500', WCW_AGENT_WORKFLOW_HEARTBEAT_MS: '200',
      WCW_WAIT_AGENTS_DEFAULT_MS: '1200', WCW_WAIT_AGENTS_MAX_MS: '2500',
    });
    // A1 + A4:一个约 6 秒的节点,边跑边收件
    const long = await a.launch([{ id: 'long', task: 'ACTIVE_LONG: a task that really keeps working for several seconds', toolTier: 'read' }]);
    ok(long && long.runId, 'A0 后台 run 受理');
    await sleep(400);
    let started = Date.now();
    const w1 = await a.wait({ runIds: [long.runId] });
    const w1Ms = Date.now() - started;
    ok(w1 && w1.ok === true && w1.timedOut === true && w1.settled === false, 'A4a 不给 timeoutMs:等待窗到点返回当前信封(timedOut:true,run 仍在跑)');
    ok(w1 && w1.waitMs === 1200 && w1Ms >= 1000 && w1Ms < 4000, `A4b 用默认窗(缝 1200ms),约 1.2 秒返回(实得 waitMs=${w1 && w1.waitMs},耗时 ${w1Ms}ms)`);
    ok(w1 && /等待窗/.test(w1.note || '') && /没有被中止/.test(w1.note || '') && /wait_agents/.test(w1.note || ''), `A4c 到点的说明讲清是「这一次等待窗」到了、代理没被中止、怎么办(${w1 && w1.note})`);
    started = Date.now();
    const w2 = await a.wait({ runIds: [long.runId], timeoutMs: 99999 });
    const w2Ms = Date.now() - started;
    ok(w2 && w2.waitMs === 2500 && w2Ms >= 2300 && w2Ms < 4600, `A4d 超大的 timeoutMs 按上限(缝 2500ms)截(实得 waitMs=${w2 && w2.waitMs},耗时 ${w2Ms}ms)`);
    const longRun = await a.terminalRun(long.runId);
    const longNode = nodeOf(longRun, 'long');
    ok(longRun && longRun.status === 'succeeded' && longNode && longNode.status === 'succeeded', `A1 持续有进展的节点跑过「收尾 + 宽限」(3.5s)仍成功(run=${longRun && longRun.status},node=${longNode && longNode.status},${longNode && longNode.error || ''})`);
    ok(longNode && longNode.wrapUpRequestedAt && !longNode.wrapUpForcedAt, 'A1b 它被催过收尾(只是催),但没被强制中止');
    ok(longNode && String(longNode.result || '').includes('long task finished'), 'A1c 节点把任务做完并给出了最终结论');

    // A2:一直吐字的节点 → 硬上限;兄弟不受牵连
    started = Date.now();
    const forever = await a.launch([
      { id: 'forever', task: 'ACTIVE_FOREVER: stream forever and never wrap up', toolTier: 'read', failurePolicy: 'continue' },
      { id: 'sibling', task: 'FAST_SIBLING: finish normally', toolTier: 'read' },
    ]);
    const foreverRun = await a.terminalRun(forever.runId, 300);
    const foreverMs = Date.now() - started;
    const fNode = nodeOf(foreverRun, 'forever');
    ok(foreverRun && foreverRun.status === 'partial' && fNode && fNode.status === 'failed', `A2 一直吐字的节点被中止、整个 run 记 partial(run=${foreverRun && foreverRun.status})`);
    ok(fNode && fNode.wrapUpForcedAt && fNode.wrapUpForcedReason === 'hard_cap', `A2b 中止原因是总时长硬上限 hard_cap(实得 ${fNode && fNode.wrapUpForcedReason})`);
    ok(foreverMs >= 9 * 1000 && foreverMs < 20 * 1000, `A2c 不是更早被误杀:约在 10 秒硬上限处(耗时 ${foreverMs}ms)`);
    ok(fNode && /硬上限/.test(fNode.error || '') && /节点自动收尾/.test(fNode.error || '') && /设置/.test(fNode.error || '') && /自动收尾宽限期/.test(fNode.error || ''), `A2d 说明讲清是哪种时限、怎么调(${fNode && fNode.error})`);
    ok(fNode && fNode.errorClass === 'timeout', `A2e errorClass 归「超时」(实得 ${fNode && fNode.errorClass})`);
    ok(nodeOf(foreverRun, 'sibling') && nodeOf(foreverRun, 'sibling').status === 'succeeded', 'A2f 强制中止只管这一个节点,兄弟照常成功');

    // A3:催过收尾之后彻底没了动静 → quiet
    started = Date.now();
    const quiet = await a.launch([{ id: 'quiet', task: 'SILENT_AFTER_NUDGE: do one call then go silent', toolTier: 'read' }]);
    const quietRun = await a.terminalRun(quiet.runId, 300);
    const quietMs = Date.now() - started;
    const qNode = nodeOf(quietRun, 'quiet');
    ok(qNode && qNode.status === 'failed' && qNode.wrapUpForcedAt && qNode.wrapUpForcedReason === 'quiet', `A3 催过收尾后彻底没动静的节点被中止、原因 quiet(实得 ${qNode && qNode.status}/${qNode && qNode.wrapUpForcedReason})`);
    ok(quietMs < 9 * 1000, `A3b 在宽限期(2.5s)之后很快被中止,没有拖到硬上限(耗时 ${quietMs}ms)`);
    ok(qNode && /自动收尾宽限期/.test(qNode.error || '') && /没有任何进展/.test(qNode.error || '') && /节点自动收尾/.test(qNode.error || ''), `A3c 说明讲清「宽限期内没有任何进展」与怎么调(${qNode && qNode.error})`);
    a.close(); a = null;

    // ───────── boot B:自动收尾关闭,只留空闲看门狗(节点空闲 3s) ─────────
    b = await boot(fake, { WCW_AGENT_NODE_WRAPUP_MS: '0', WCW_AGENT_NODE_IDLE_MS: '3000', WCW_TURN_IDLE_MS: '1500', WCW_AGENT_WORKFLOW_IDLE_MS: '60000' });
    started = Date.now();
    const steady = await b.launch([{ id: 'steady', task: 'ACTIVE_LONG: steady progress for longer than the idle limit', toolTier: 'read' }]);
    const steadyRun = await b.terminalRun(steady.runId, 300);
    const steadyMs = Date.now() - started;
    ok(steadyRun && steadyRun.status === 'succeeded' && steadyMs > 3500, `B1 空闲判据跟着进展走:总时长 ${steadyMs}ms 超过 3s 空闲上限的节点,只要一直有进展就成功(run=${steadyRun && steadyRun.status})`);
    started = Date.now();
    const hung = await b.launch([{ id: 'hung', task: 'HANG_NODE: never answers', toolTier: 'read' }]);
    const hungRun = await b.terminalRun(hung.runId, 300);
    const hungMs = Date.now() - started;
    const hNode = nodeOf(hungRun, 'hung');
    ok(hNode && hNode.status === 'failed' && hNode.errorClass === 'idle_timeout' && hungMs < 12000, `B2 从头到尾没动静的节点被空闲看门狗中止(${hNode && hNode.status}/${hNode && hNode.errorClass},耗时 ${hungMs}ms)`);
    ok(hNode && /空闲超时/.test(hNode.error || '') && /一个回合多久没动静算卡住/.test(hNode.error || '') && /流式输出/.test(hNode.error || ''), `B2b 说明讲清空闲判的是什么、哪个设置能调大(${hNode && hNode.error})`);
    // B3:生产默认窗 / 上限
    const bounds = async timeoutMs => (await b.wait({ runIds: ['run_doesnotexist'], ...(timeoutMs === undefined ? {} : { timeoutMs }) })).waitMs;
    ok(await bounds() === 120000, 'B3a 缺省 timeoutMs → 生产默认窗 120000ms');
    ok(await bounds(99999999) === 300000, 'B3b 超大 timeoutMs → 生产上限 300000ms');
    ok(await bounds(0) === 0 && await bounds('abc') === 0 && await bounds(45000) === 45000, 'B3c 0 / 非数字 → 0,合法值原样');
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (a) a.close();
    if (b) b.close();
    await fake.close();
  }
  t.done({ exit: true });
})();
