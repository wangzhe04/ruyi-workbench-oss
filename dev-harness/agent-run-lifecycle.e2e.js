'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E:代理 run 生命周期的五个竞态 / 漏洞(Sonnet 找 bug 波复核后修):
//   L1 后台发起(async:true)校验失败 → 照实回错,不回 accepted、不留一个永远等不到的 runId;
//   L2 retry_node 指向不存在的节点 → 照实回错(修前回 accepted、什么都没发生);
//   L3 暂停后立刻恢复 —— 恢复落在「写暂停状态」的窗口里时 run 不能卡死在 paused(丢唤醒),多轮都不卡;
//   L4 回合内 run 暂停中、用户按回合的「停止」(/api/stop)→ run 被叫醒收尾,聊天流收得了尾;
//   L5 后台 run 被重启打断 → 人工 resume 跑完 → 交付信封照样送达(修前续跑不传 onComplete,模型收不到完成通知)。
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
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-agent-lifecycle-'));
const t = createRunner('AGENT RUN LIFECYCLE');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));

let subDelayMs = 400;
const isSub = messages => String(((messages || []).find(m => m.role === 'system') || {}).content || '').includes('子任务执行体');

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
  const fake = await startFakeProvider({
    async handler(r) {
      if (isSub(r.messages)) { await sleep(subDelayMs); return textFrames('sub done'); }
      // 父回合:先调一次 orchestrate_agents,拿到工具结果后收尾
      if (!r.messages.some(m => m.role === 'tool')) return toolCallFrames('orchestrate_agents', { task: 'do it' }, 'c1');
      return textFrames('parent done');
    },
  });
  const port = await getFreePort();
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 8, version: '1.0.0', permissionMode: 'bypass', toolLoadingMode: 'full', defaultWorkspace: HOME, recentWorkspaces: [],
    subagentMaxPerTurn: 32, subagentMaxConcurrent: 2, subagentBudgetMigrated: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  const env = { ...process.env, HOME, USERPROFILE: HOME, RUYI_HOME: HOME };
  delete env.WIN_CLAUDE_WORKBENCH_HOME;
  const hdr = {};
  const start = async () => {
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
    await start();
    const sid = (await api('POST', '/api/sessions', { title: 'lifecycle', cwd: HOME })).body.session.id;

    // ── L1 后台发起校验失败 ─────────────────────────────────────────────────────────────────────────
    const bad = await api('POST', '/api/agent-workflow/launch', { token: hdr['x-wcw-token'], sessionId: sid, async: true, nodes: [{ id: 'a', task: 'x' }, { id: 'a', task: 'y' }] });
    ok(bad.body && bad.body.ok === false && !bad.body.accepted && /重复/.test(JSON.stringify(bad.body.error)), `L1 后台发起重复节点 id → 照实回错(${JSON.stringify(bad.body).slice(0, 160)})`);
    const runsAfterBad = ((await api('GET', `/api/agent-runs?sessionId=${sid}`)).body || {}).runs || [];
    ok(runsAfterBad.length === 0, 'L1 没有留下运行记录');

    // ── L2 retry_node 未知节点 ──────────────────────────────────────────────────────────────────────
    const good = await api('POST', '/api/agent-workflow/launch', { token: hdr['x-wcw-token'], sessionId: sid, async: true, nodes: [{ id: 'a', task: 'x' }] });
    ok(good.body && good.body.ok === true && good.body.accepted === true, 'L2 前提:正常的后台发起被受理');
    const goodRun = await waitFor(async () => { const r = await getRun(sid, good.body.runId); return r && settled(r.status) && r; });
    ok(goodRun && goodRun.status === 'succeeded', `L2 前提:后台 run 跑完(${goodRun && goodRun.status})`);
    const retryBad = await api('POST', `/api/agent-runs/${good.body.runId}`, { sessionId: sid, action: 'retry_node', nodeId: 'nope' });
    ok(retryBad.body && retryBad.body.ok === false && !retryBad.body.accepted, `L2 retry_node 未知节点 → 照实回错(${JSON.stringify(retryBad.body).slice(0, 160)})`);

    // ── L3 暂停 → 立刻恢复,多轮不卡 ─────────────────────────────────────────────────────────────────
    subDelayMs = 500;
    let stuck = 0, rounds = 0;
    for (let i = 0; i < 8; i++) {
      const r = await api('POST', '/api/agent-workflow/launch', { token: hdr['x-wcw-token'], sessionId: sid, async: true, nodes: [{ id: 'a', task: 'x' }] });
      if (!r.body || !r.body.runId) continue;
      const rid = r.body.runId;
      await sleep(120);
      await api('POST', `/api/agent-runs/${rid}`, { sessionId: sid, action: 'pause' });
      // 紧盯:一看到 paused 就立刻 resume —— 丢唤醒的窗口就是「状态已是 paused、等待者还没入队」(中间隔着一次落盘)。
      const paused = await waitFor(async () => { const run = await getRun(sid, rid); return run && (run.status === 'paused' || settled(run.status)) && run; }, 400, 1);
      if (!paused || paused.status !== 'paused') { await api('POST', `/api/agent-runs/${rid}`, { sessionId: sid, action: 'stop' }).catch(() => {}); continue; }
      rounds++;
      await api('POST', `/api/agent-runs/${rid}`, { sessionId: sid, action: 'resume' });
      const done = await waitFor(async () => { const run = await getRun(sid, rid); return run && settled(run.status) && run; }, 40, 100);
      if (!done) { stuck++; await api('POST', `/api/agent-runs/${rid}`, { sessionId: sid, action: 'stop' }).catch(() => {}); }
    }
    ok(rounds > 0 && stuck === 0, `L3 暂停后立刻恢复:${rounds} 轮里卡死 ${stuck} 轮(应为 0)`);

    // ── L4 回合内 run 暂停中,按回合的停止 ────────────────────────────────────────────────────────────
    subDelayMs = 1500;
    const sid4 = (await api('POST', '/api/sessions', { title: 'turn-stop', cwd: HOME })).body.session.id;
    let chatEnded = false;
    const data = JSON.stringify({ sessionId: sid4, message: 'go', cwd: HOME });
    const chat = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...hdr } }, res => { res.resume(); res.on('end', () => { chatEnded = true; }); });
    chat.on('error', () => { chatEnded = true; });
    chat.write(data); chat.end();
    const liveRun = await waitFor(async () => { const l = (await api('GET', `/api/agent-runs?sessionId=${sid4}`)).body || {}; return (l.runs || []).find(x => x.live); }, 60, 150);
    ok(!!liveRun, 'L4 前提:回合内起了一个活 run');
    if (liveRun) {
      await api('POST', `/api/agent-runs/${liveRun.id}`, { sessionId: sid4, action: 'pause' });
      const paused = await waitFor(async () => { const run = await getRun(sid4, liveRun.id); return run && run.status === 'paused' && run; }, 60, 100);
      ok(!!paused, 'L4 前提:run 进入 paused');
      await api('POST', '/api/stop', { sessionId: sid4 });
      const ended = await waitFor(async () => chatEnded, 50, 100);
      ok(ended, 'L4 暂停中按回合的停止 → 聊天流收尾(修前一直挂着)');
      const after = await getRun(sid4, liveRun.id);
      ok(after && !after.live, `L4 run 不再是活的(${after && after.status})`);
    }

    // ── L5 后台 run 被重启打断 → resume → 信封送达 ──────────────────────────────────────────────────
    subDelayMs = 2500;
    const sid5 = (await api('POST', '/api/sessions', { title: 'resume-envelope', cwd: HOME })).body.session.id;
    const r5 = await api('POST', '/api/agent-workflow/launch', { token: hdr['x-wcw-token'], sessionId: sid5, async: true, nodes: [{ id: 'b', task: 'y' }] });
    const rid5 = r5.body && r5.body.runId;
    await sleep(800);
    await stop();
    subDelayMs = 300;
    await start();
    const interrupted = await getRun(sid5, rid5);
    ok(interrupted && interrupted.background === true && !settled(interrupted.status), `L5 前提:重启后 run 处于未完成态(${interrupted && interrupted.status})`);
    const resumed = await api('POST', `/api/agent-runs/${rid5}`, { sessionId: sid5, action: 'resume' });
    ok(resumed.body && resumed.body.ok === true, 'L5 resume 被受理');
    const fin = await waitFor(async () => { const run = await getRun(sid5, rid5); return run && settled(run.status) && run; }, 80, 150);
    ok(fin && fin.status === 'succeeded', `L5 续跑跑完(${fin && fin.status})`);
    const jobFile = path.join(HOME, 'sessions', `${sid5}.background-jobs.json`);
    const hasEnvelope = await waitFor(async () => {
      const g = (await api('GET', `/api/sessions/${sid5}`)).body || {};
      const msgs = (g.session || g).messages || [];
      if (msgs.some(m => m && m.backgroundJobId === `agent:${rid5}`)) return true;
      try { return JSON.parse(fs.readFileSync(jobFile, 'utf8')).some(j => j && j.id === `agent:${rid5}`); } catch { return false; }
    }, 40, 150);
    ok(hasEnvelope, 'L5 续跑完成后交付信封送达(修前续跑不送)');
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
