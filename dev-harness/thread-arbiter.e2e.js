#!/usr/bin/env node
'use strict';
// E2E:第 116 波 116h(27 号文 §3.1 116h 行 / §8.10「多线程看板与注意力预算」)—— 线程间仲裁。
// 真服务(两个工作台进程)+ fake-openai 慢响应(每个回合固定 ~700ms),黑盒只经 HTTP 断言。
//
// 判定行:`THREAD ARBITER E2E: ALL PASS`。
//
// 十一条判定(与交付物清单逐条对应):
//   ① 开关关:6 条不同 cwd 的会话并发跑,全部立即开始(总耗时远小于串行)、事件流零 agent_resource、
//      两条仲裁路由一律 409 steward.disabled;
//   ② 开 + stewardMaxParallelThreads=2:6 条不同 cwd -> 同时最多 2 条在跑,其余 wait.reason='slot'、
//      ahead 逐条递增且随队伍前进而递减,放行顺序是先到先得(FIFO);
//   ③ 同 cwd 两条 -> 第二条 wait.reason='lock' 且 blockedBy 指向第一条;两条【从不】同时在跑;
//   ④ 有待决的会话回合不占并发位、不入队,直接放行(并发已满时也放行);
//   ⑤ 优先级:prioritize 之后那一条排到队首,下一个释放出来的并发位归它;
//   ⑥ 饥饿避免(第二个工作台进程,WCW_STEWARD_ARBITER_STARVE_MS 覆盖阈值):队首一直被新插队的
//      条目挤,超时那一条被提到队首一次并先于后来者放行;
//   ⑦ 上限 2->3 即时生效:改完配置立刻多放一条,不必等谁跑完;
//   ⑧ 小时回合上限触顶 -> 新回合 wait.reason='budget'(排队而不是拒绝),上限调回去后自行放行;
//   ⑨ 原因单一性:同时满足 lock 与 slot 的条目只报 lock;
//   ⑩ /api/stop 停掉【还在排队】的回合:出队、不占位、流里是 process/stopped 而不是 error;
//   ⑪ 三处 wait 形状一致(GET /api/steward/arbiter 的 queue、GET /api/missions 的线程行、
//      steward_thread_prioritize 的返回),外加「四个展示面都走 06i 的 waitReasonFor」的源码单点锁。
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'ruyi-thread-arbiter-main');
const HOME2 = path.join(os.tmpdir(), 'ruyi-thread-arbiter-starve');
const FP = 9186;    // fake-openai
const WP = 9187;    // 工作台(主)
const SP = 9188;    // 工作台(饥饿避免专用:阈值被 env 压到 700ms)
const TURN_MS = 900;      // fake 每个回合固定睡这么久再回话
const STARVE_MS = 600;    // 第二个进程的饥饿阈值(整个覆盖,不受平均回合时长影响)

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
function kill(p) { if (p && p.pid) { try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

function req(port, method, p, body, headers) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port, path: p, method, timeout: 20000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(headers || {}) },
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => { let parsed = null; try { parsed = JSON.parse(b); } catch { parsed = null; } resolve({ status: res.statusCode, body: parsed, raw: b }); });
    });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: null, raw: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}
// 一条回合的 NDJSON 流。返回 {events, startedAt, endedAt}(时间戳用来证明重叠与不重叠)。
function stream(port, body, hdr) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const startedAt = Date.now();
    const events = [];
    const r = http.request({
      host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 60000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...hdr },
    }, res => {
      let b = '';
      res.on('data', c => {
        b += c;
        let i;
        while ((i = b.indexOf('\n')) >= 0) {
          const line = b.slice(0, i); b = b.slice(i + 1);
          if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } }
        }
      });
      res.on('end', () => resolve({ events, startedAt, endedAt: Date.now() }));
    });
    r.on('error', () => resolve({ events, startedAt, endedAt: Date.now(), errored: true }));
    r.on('timeout', () => { r.destroy(); resolve({ events, startedAt, endedAt: Date.now(), timedOut: true }); });
    r.write(raw); r.end();
  });
}
async function waitUp(port) { // 117q:预算 80×120ms=9.6s 小于本机冷启动实测 4.6-6.3s 且余量过窄,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) {
    const h = await req(port, 'GET', '/health');
    if (h.status === 200) return true;
    await sleep(120);
  }
  return false;
}
async function tokenOf(port) {
  const html = await new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: '/' }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); });
    r.on('error', () => resolve(''));
  });
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}

function writeConfig(home, extra) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: home,
    subagentMaxPerTurn: 0, killOnDisconnect: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FP}`, apiKey: 'k', model: 'fake-model' }],
    activeProvider: 'fake',
    ...extra,
  }, null, 2));
}

// 仲裁器快照采样器:每 60ms 拉一次 GET /api/steward/arbiter,把 running/queue 记成时间序列。
function sampler(port, hdr) {
  const frames = [];
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      const r = await req(port, 'GET', '/api/steward/arbiter', undefined, hdr);
      if (r.status === 200 && r.body && r.body.ok) frames.push({ at: Date.now(), running: r.body.running, queue: r.body.queue, maxParallel: r.body.maxParallel });
      await sleep(60);
    }
  })();
  return { frames, stop: async () => { stopped = true; await loop; } };
}
// 一组回合的「同时在跑峰值」:每条回合取 [第一条事件, result 事件] 这个区间(事件自带 ts),
// 扫一遍端点求最大重叠数。这是证明「有没有并发上限」最直接的度量 —— 比总耗时稳,不受机器负载影响。
function peakOverlap(runs) {
  const points = [];
  for (const r of runs) {
    const first = r.events[0];
    const last = r.events.find(e => e.type === 'result') || r.events[r.events.length - 1];
    const t0 = Date.parse((first && first.ts) || '');
    const t1 = Date.parse((last && last.ts) || '');
    if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) continue;
    points.push([t0, 1], [t1, -1]);
  }
  points.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0;
  for (const [, delta] of points) { cur += delta; if (cur > peak) peak = cur; }
  return peak;
}
const runningIds = frame => frame.running.map(r => r.sessionId);
const queueOf = (frames, sid) => { for (const f of frames) { const hit = f.queue.find(q => q.sessionId === sid); if (hit) return hit; } return null; };

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(HOME2, { recursive: true, force: true });
  writeConfig(HOME, {});                                  // 主进程:开关【关】着启动(①)
  writeConfig(HOME2, { stewardEnabledV1: true, stewardMaxParallelThreads: 1, stewardGlobalMaxTurnsPerHour: 2000, stewardGlobalMaxCostPerDay: 0 });
  const cwds = {};
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f', 'shared']) {
    cwds[name] = path.join(HOME, 'ws-' + name);
    fs.mkdirSync(cwds[name], { recursive: true });
  }
  const cwd2 = path.join(HOME2, 'ws');
  fs.mkdirSync(cwd2, { recursive: true });

  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], {
    env: { ...process.env, FAKE_OPENAI_PORT: String(FP), FAKE_REPLY_SEQUENCE: JSON.stringify([{ text: '好了。', delayMs: TURN_MS }]) },
    windowsHide: true,
  });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  const wbs = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(SP)], {
    cwd: WB,
    env: { ...process.env, RUYI_HOME: HOME2, WIN_CLAUDE_WORKBENCH_HOME: HOME2, WCW_STEWARD_ARBITER_STARVE_MS: String(STARVE_MS) },
    windowsHide: true,
  });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  wbs.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wbs!] ' + l.trim())));

  try {
    ok(await waitUp(WP), '主工作台启动');
    ok(await waitUp(SP), '饥饿避免用工作台启动');
    const hdr = { 'x-wcw-token': await tokenOf(WP) };
    const hdr2 = { 'x-wcw-token': await tokenOf(SP) };
    const newSession = async (title, cwd, port, headers) => {
      const r = await req(port || WP, 'POST', '/api/sessions', { title, cwd }, headers || hdr);
      return r.body && r.body.session && r.body.session.id;
    };
    const setConfig = patch => req(WP, 'POST', '/api/config', patch, hdr);

    /* ═════════ ① 开关关:零仲裁 ═════════ */
    {
      const ids = [];
      for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) ids.push(await newSession('off-' + name, cwds[name]));
      const t0 = Date.now();
      const runs = await Promise.all(ids.map((id, i) => stream(WP, { sessionId: id, message: '关着跑 ' + i, cwd: cwds[['a', 'b', 'c', 'd', 'e', 'f'][i]] }, hdr)));
      const elapsed = Date.now() - t0;
      ok(runs.every(r => r.events.some(e => e.type === 'result' && e.ok === true)), '① 开关关:6 条并发回合全部正常收尾');
      ok(runs.every(r => r.events.every(e => e.type !== 'agent_resource')), '① 开关关:事件流里零 agent_resource(根本没问过仲裁器)');
      ok(peakOverlap(runs) === 6, `① 开关关:6 条回合真的同时在跑(重叠峰值 ${peakOverlap(runs)},没有任何并发上限)`);
      ok(elapsed < TURN_MS * 6, `① 开关关:总耗时 ${elapsed}ms 低于串行下界 ${TURN_MS * 6}ms`);
      const st = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      ok(st.status === 409 && st.body && st.body.error && st.body.error.code === 'steward.disabled', '① 开关关:GET /api/steward/arbiter 409 steward.disabled');
      const pr = await req(WP, 'POST', '/api/steward/arbiter/prioritize', { sessionId: ids[0] }, hdr);
      ok(pr.status === 409 && pr.body && pr.body.error && pr.body.error.code === 'steward.disabled', '① 开关关:POST /api/steward/arbiter/prioritize 409 steward.disabled');
      const noTok = await req(WP, 'GET', '/api/steward/arbiter');
      ok(noTok.status === 403, '① 无 token:GET /api/steward/arbiter 403(鉴权在开关判定之前)');
    }

    /* ═════════ 打开管家:并发上限 2 ═════════ */
    await setConfig({ stewardEnabledV1: true, stewardMaxParallelThreads: 2, stewardGlobalMaxTurnsPerHour: 2000, stewardGlobalMaxCostPerDay: 0 });
    {
      const st = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      ok(st.status === 200 && st.body.enabled === true && st.body.maxParallel === 2, '开:GET /api/steward/arbiter 返回 enabled + maxParallel=2');
      ok(Array.isArray(st.body.running) && Array.isArray(st.body.queue) && st.body.running.length === 0 && st.body.queue.length === 0,
        '开:空闲时 running/queue 都是空数组');
    }

    /* ═════════ ②(并发上限 + slot + FIFO)═════════ */
    let phase2Ids = [];
    {
      const names = ['a', 'b', 'c', 'd', 'e', 'f'];
      for (const name of names) phase2Ids.push(await newSession('slot-' + name, cwds[name]));
      const s = sampler(WP, hdr);
      const runs = [];
      for (let i = 0; i < 6; i++) {
        runs.push(stream(WP, { sessionId: phase2Ids[i], message: '排队 ' + i, cwd: cwds[names[i]] }, hdr));
        await sleep(90);   // 拉开发起时刻,让「先到先得」是可判定的
      }
      const done = await Promise.all(runs);
      await s.stop();
      ok(done.every(r => r.events.some(e => e.type === 'result' && e.ok === true)), '② 6 条全部最终跑完(排队不是失败)');
      const maxRunning = Math.max(0, ...s.frames.map(f => f.running.length));
      ok(maxRunning <= 2 && maxRunning === 2, `② 同时在跑的线程数上限严格是 2(实测峰值 ${maxRunning})`);
      // 排队中的四条都必须给出 slot 原因,且 ahead 各不相同、从 0 起递增。
      const waits = phase2Ids.slice(2).map(id => queueOf(s.frames, id)).filter(Boolean);
      ok(waits.length >= 3, `② 后四条里至少 3 条被真的观察到在排队(实测 ${waits.length})`);
      ok(waits.every(w => w.wait && w.wait.reason === 'slot'), '② 排队原因一律是 slot(不同 cwd、预算充裕)');
      ok(waits.every(w => typeof w.wait.ahead === 'number' && w.wait.ahead >= 0 && w.wait.label.includes('等并发位')),
        '② 每条都带 ahead 与「等并发位」人话');
      // ahead 递减:任取一条线程,它在时间序列上的 ahead 必须单调不增。
      const target = phase2Ids[5];
      const aheadSeries = s.frames.map(f => (f.queue.find(q => q.sessionId === target) || {}).wait)
        .filter(Boolean).map(w => w.ahead);
      ok(aheadSeries.length >= 2 && aheadSeries.every((v, i) => i === 0 || v <= aheadSeries[i - 1]),
        `② 最后一条的 ahead 单调不增(实测 ${aheadSeries.join('>')})`);
      ok(aheadSeries.length >= 2 && aheadSeries[0] > aheadSeries[aheadSeries.length - 1],
        '② 最后一条的 ahead 确实递减过(队伍在动)');
      // FIFO:各条【首次出现在 running 里】的先后顺序 = 发起顺序。
      const firstSeen = new Map();
      for (const f of s.frames) for (const sid of runningIds(f)) if (!firstSeen.has(sid)) firstSeen.set(sid, f.at);
      const observed = phase2Ids.filter(id => firstSeen.has(id));
      const sorted = [...observed].sort((x, y) => firstSeen.get(x) - firstSeen.get(y));
      ok(observed.length >= 4 && JSON.stringify(sorted) === JSON.stringify(observed),
        `② 放行顺序 = 发起顺序(先到先得;观察到 ${observed.length} 条)`);
      const after = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      ok(after.body.running.length === 0 && after.body.queue.length === 0, '② 全部跑完后并发位与队列都清空(release 无遗漏)');
      ok(after.body.hour.turns >= 6, `② 小时窗口记满了这些回合(实测 ${after.body.hour.turns})`);
    }

    /* ═════════ ③(同 cwd 写互斥)═════════ */
    await setConfig({ stewardMaxParallelThreads: 8 });   // 把并发位撑开,证明第二条等的是【锁】不是位子
    {
      const a = await newSession('lock-A', cwds.shared);
      const b = await newSession('lock-B', cwds.shared);
      const s = sampler(WP, hdr);
      const pa = stream(WP, { sessionId: a, message: '先来', cwd: cwds.shared }, hdr);
      await sleep(150);
      const pb = stream(WP, { sessionId: b, message: '后到', cwd: cwds.shared }, hdr);
      const [ra, rb] = await Promise.all([pa, pb]);
      await s.stop();
      ok(ra.events.some(e => e.type === 'result' && e.ok === true) && rb.events.some(e => e.type === 'result' && e.ok === true),
        '③ 同 cwd 两条最终都跑完');
      const w = queueOf(s.frames, b);
      ok(w && w.wait && w.wait.reason === 'lock', `③ 第二条的等待原因是 lock(实测 ${w && w.wait ? w.wait.reason : '未观察到'})`);
      ok(w && w.wait.blockedBy && w.wait.blockedBy.sessionId === a, '③ blockedBy 指向占着这个文件夹的第一条');
      ok(w && w.wait.label.includes('等锁') && w.wait.label.includes('lock-A'), '③ 人话里写清楚被哪条线程占着');
      ok(s.frames.every(f => f.running.length <= 1), '③ 两条【从不】同时在跑(写互斥真的生效)');
      const waitEvt = rb.events.find(e => e.type === 'agent_resource' && e.state === 'waiting');
      ok(waitEvt && Array.isArray(waitEvt.resources) && String(waitEvt.resources[0]).startsWith('cwd-write:'),
        '③ 等待经既有 agent_resource 事件发出,资源名是 cwd-write:<hash>');
      ok(waitEvt && Array.isArray(waitEvt.blockers) && waitEvt.blockers[0] === 'lock-A', '③ blockers 里是占用者的人话名(112c 状态条可直接说「被 X 占着」)');
      ok(rb.events.some(e => e.type === 'agent_resource' && e.state === 'acquired')
        && rb.events.some(e => e.type === 'agent_resource' && e.state === 'released'),
        '③ 等过的回合拿到位子与释放都各发一条事件(状态条能把「等待资源」清掉)');
      ok(ra.events.every(e => e.type !== 'agent_resource'), '③ 没等过的那条不发多余事件(不给用户制造噪音)');
    }

    /* ═════════ ④(有待决 -> 不占位直接放行)═════════ */
    {
      await setConfig({ stewardMaxParallelThreads: 1 });
      const blocker = await newSession('pend-blocker', cwds.a);
      const pending = await newSession('pend-target', cwds.b);
      // 直接写一条 pending 干预(仲裁器的判据就是「这条线程有没有待决」)。
      fs.writeFileSync(path.join(HOME, 'sessions', `${pending}.interventions.ndjson`),
        JSON.stringify({ id: 'iv_arbiter_1', type: 'question', status: 'pending', requestedAt: new Date().toISOString(), interventionVersion: 1, questions: [{ question: '选哪个?' }] }) + '\n');
      const s = sampler(WP, hdr);
      const pblock = stream(WP, { sessionId: blocker, message: '占住唯一的位子', cwd: cwds.a }, hdr);
      await sleep(150);
      const t0 = Date.now();
      const ppend = await stream(WP, { sessionId: pending, message: '我有待决', cwd: cwds.b }, hdr);
      const pendElapsed = Date.now() - t0;
      await pblock;
      await s.stop();
      ok(ppend.events.some(e => e.type === 'result' && e.ok === true), '④ 有待决的会话回合正常跑完');
      ok(pendElapsed < TURN_MS * 2, `④ 它没有等并发位(耗时 ${pendElapsed}ms,占位者还没跑完)`);
      ok(ppend.events.every(e => e.type !== 'agent_resource'), '④ 它连一条等待事件都没发(不入队、不占位)');
      ok(!queueOf(s.frames, pending), '④ 它从没进过仲裁队列');
      ok(s.frames.every(f => !runningIds(f).includes(pending)), '④ 它也从不占用并发位(并发上限只管「等你」之外的线程)');
      fs.rmSync(path.join(HOME, 'sessions', `${pending}.interventions.ndjson`), { force: true });
    }

    /* ═════════ ⑤(插队)═════════ */
    {
      await setConfig({ stewardMaxParallelThreads: 1 });
      const a = await newSession('prio-A', cwds.a);
      const b = await newSession('prio-B', cwds.b);
      const c = await newSession('prio-C', cwds.c);
      const s = sampler(WP, hdr);
      const pa = stream(WP, { sessionId: a, message: '占位', cwd: cwds.a }, hdr);
      await sleep(120);
      const pb = stream(WP, { sessionId: b, message: '先排', cwd: cwds.b }, hdr);
      await sleep(120);
      const pc = stream(WP, { sessionId: c, message: '后排', cwd: cwds.c }, hdr);
      await sleep(120);
      const before = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      ok(before.body.queue.map(q => q.sessionId).join(',') === [b, c].join(','), '⑤ 插队前队列顺序是先到先得 B,C');
      const pr = await req(WP, 'POST', '/api/steward/arbiter/prioritize', { sessionId: c }, hdr);
      ok(pr.status === 200 && pr.body.ok === true && pr.body.prioritized === true, '⑤ prioritize 返回 prioritized:true');
      const after = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      ok(after.body.queue.map(q => q.sessionId).join(',') === [c, b].join(','), '⑤ 插队后 C 排到队首');
      ok((after.body.queue[0] || {}).priorityBump === true, '⑤ 队首条目带 priorityBump 标记(看板可显示「已插队」)');
      await Promise.all([pa, pb, pc]);
      await s.stop();
      const firstSeen = new Map();
      for (const f of s.frames) for (const sid of runningIds(f)) if (!firstSeen.has(sid)) firstSeen.set(sid, f.at);
      ok(firstSeen.has(c) && firstSeen.has(b) && firstSeen.get(c) < firstSeen.get(b), '⑤ 下一个并发位真的归了插队的 C(先于先到的 B)');
      const miss = await req(WP, 'POST', '/api/steward/arbiter/prioritize', { sessionId: a }, hdr);
      ok(miss.status === 200 && miss.body.ok === true && miss.body.prioritized === false && miss.body.reason === 'not_queued',
        '⑤ 对没在排队的线程插队 -> prioritized:false + not_queued(不是错误)');
      const bad = await req(WP, 'POST', '/api/steward/arbiter/prioritize', { sessionId: '../evil' }, hdr);
      ok(bad.status === 400 && bad.body.error && bad.body.error.code === 'invalid_session', '⑤ 非法 sessionId -> 400 invalid_session(稳定信封在路由层)');
    }

    /* ═════════ ⑦(上限 2->3 即时生效)═════════ */
    {
      await setConfig({ stewardMaxParallelThreads: 2 });
      const names = ['a', 'b', 'c', 'd', 'e'];
      const ids = [];
      for (const n of names) ids.push(await newSession('grow-' + n, cwds[n]));
      const runs = [];
      for (let i = 0; i < 5; i++) { runs.push(stream(WP, { sessionId: ids[i], message: '扩容 ' + i, cwd: cwds[names[i]] }, hdr)); await sleep(40); }
      await sleep(120);
      const before = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      const beforeRunning = before.body.running.map(r => r.sessionId);
      ok(before.body.running.length === 2 && before.body.queue.length === 3, `⑦ 改上限前:2 在跑 / 3 在等(实测 ${before.body.running.length}/${before.body.queue.length})`);
      await setConfig({ stewardMaxParallelThreads: 3 });
      await sleep(120);
      const after = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      const afterRunning = after.body.running.map(r => r.sessionId);
      ok(after.body.maxParallel === 3, '⑦ 新上限即时可读(配置不缓存)');
      ok(after.body.running.length === 3, `⑦ 改完立刻多放了一条(2 -> 3),没等任何回合跑完(实测 ${after.body.running.length} 在跑)`);
      ok(beforeRunning.every(id => afterRunning.includes(id)) && afterRunning.filter(id => !beforeRunning.includes(id)).length === 1,
        '⑦ 多出来的那一条正是刚才排在队首的(原来两条一条没换)');
      await Promise.all(runs);
    }

    /* ═════════ ⑧(全局小时回合上限 -> budget 排队)═════════ */
    {
      await setConfig({ stewardMaxParallelThreads: 8, stewardGlobalMaxTurnsPerHour: 1 });
      const id = await newSession('budget-1', cwds.d);
      const s = sampler(WP, hdr);
      const run = stream(WP, { sessionId: id, message: '预算触顶', cwd: cwds.d }, hdr);
      await sleep(400);
      const snap = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      const q = (snap.body.queue || [])[0];
      ok(q && q.sessionId === id && q.wait && q.wait.reason === 'budget', `⑧ 小时回合触顶 -> 排队而不是拒绝,原因是 budget(实测 ${q && q.wait ? q.wait.reason : '未排队'})`);
      ok(q && q.wait.label.includes('等预算') && q.wait.label.includes('回合'), '⑧ 人话说清楚是回合数触顶');
      ok(snap.body.hour.limit === 1, '⑧ 状态里回显当前的小时上限');
      await setConfig({ stewardGlobalMaxTurnsPerHour: 2000 });   // 调回去 -> 下一次唤醒即放行
      const r = await run;
      await s.stop();
      ok(r.events.some(e => e.type === 'result' && e.ok === true), '⑧ 上限调回去之后它自己跑完了(排队不是拒绝)');
      const budgetEvt = r.events.find(e => e.type === 'agent_resource' && e.state === 'waiting');
      ok(budgetEvt && budgetEvt.resources[0] === 'steward:budget', '⑧ 等预算也走既有 agent_resource,资源名 steward:budget');
    }

    /* ═════════ ⑨(原因单一性:lock 压过 slot)═════════ */
    {
      await setConfig({ stewardMaxParallelThreads: 1 });
      const a = await newSession('single-A', cwds.shared);
      const b = await newSession('single-B', cwds.shared);
      const s = sampler(WP, hdr);
      const pa = stream(WP, { sessionId: a, message: '占锁又占位', cwd: cwds.shared }, hdr);
      await sleep(150);
      const pb = stream(WP, { sessionId: b, message: '两条都成立', cwd: cwds.shared }, hdr);
      await sleep(200);
      const snap = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      const q = (snap.body.queue || []).find(x => x.sessionId === b);
      ok(q && q.wait && q.wait.reason === 'lock', `⑨ 同时满足 lock 与 slot 时只报 lock(实测 ${q && q.wait ? q.wait.reason : '未排队'})`);
      ok(q && Object.keys(q.wait).sort().join(',') === 'blockedBy,label,reason', '⑨ 结果里没有 slot 的 ahead(一条线程只给一个原因)');
      await Promise.all([pa, pb]);
      await s.stop();
    }

    /* ═════════ ⑩(/api/stop 停掉排队中的回合)═════════ */
    {
      await setConfig({ stewardMaxParallelThreads: 1 });
      const a = await newSession('stop-A', cwds.a);
      const b = await newSession('stop-B', cwds.b);
      const pa = stream(WP, { sessionId: a, message: '占位', cwd: cwds.a }, hdr);
      await sleep(150);
      const pb = stream(WP, { sessionId: b, message: '会被停掉', cwd: cwds.b }, hdr);
      await sleep(200);
      const stopped = await req(WP, 'POST', '/api/stop', { sessionId: b }, hdr);
      ok(stopped.status === 200 && stopped.body.ok === true && stopped.body.stopped === true, '⑩ /api/stop 对排队中的回合返回 stopped:true');
      const rb = await pb;
      ok(rb.events.some(e => e.type === 'process' && e.state === 'stopped'), '⑩ 被停的排队回合走的是 process/stopped(不是 error 信封)');
      ok(rb.events.every(e => e.type !== 'error'), '⑩ 流里没有 error 事件(排队被取消不是失败)');
      ok(!rb.events.some(e => e.type === 'result'), '⑩ 回合从没开始跑(没有 result 事件)');
      const snap = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      ok(!(snap.body.queue || []).some(q => q.sessionId === b) && !(snap.body.running || []).some(r => r.sessionId === b),
        '⑩ 它既不在队列也不占并发位(出队干净)');
      const ra = await pa;
      ok(ra.events.some(e => e.type === 'result' && e.ok === true), '⑩ 占位的那条不受影响,照常跑完');
    }

    /* ═════════ ⑪(三处 wait 形状一致)═════════ */
    {
      await setConfig({ stewardMaxParallelThreads: 1 });
      // GET /api/missions 的行 = 【线程行】(一条 mission 会话一张卡),所以这三条必须是 mission 会话。
      const mission = async (title, cwd) => {
        const id = await newSession(title, cwd);
        await req(WP, 'POST', '/api/mission', { sessionId: id, action: 'start', title, milestones: [{ title: '做完' }] }, hdr);
        return id;
      };
      const a = await mission('shape-A', cwds.a);
      const b = await mission('shape-B', cwds.b);
      const idle = await mission('shape-idle', cwds.e);
      const pa = stream(WP, { sessionId: a, message: '占位', cwd: cwds.a }, hdr);
      await sleep(200);
      const pb = stream(WP, { sessionId: b, message: '排队', cwd: cwds.b }, hdr);
      await sleep(300);
      const arb = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      const fromArbiter = ((arb.body.queue || []).find(q => q.sessionId === b) || {}).wait || null;
      const missions = await req(WP, 'GET', '/api/missions', undefined, hdr);
      const rowOf = sid => ((missions.body && missions.body.missions) || []).find(m => m.sessionId === sid) || null;
      const rowB = rowOf(b);
      const fromMissions = rowB ? rowB.wait : null;
      const act = await req(WP, 'POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_thread_prioritize', args: { sessionId: b } } }, hdr);
      const fromTool = act.body && act.body.result ? act.body.result.wait : null;
      ok(fromArbiter && fromArbiter.reason === 'slot', '⑪ 仲裁器快照给出 slot');
      ok(fromMissions && fromMissions.reason === 'slot', `⑪ GET /api/missions 的线程行给出同一个 slot(实测 ${fromMissions ? fromMissions.reason : (rowB ? 'null' : '行缺失')})`);
      ok(fromTool && fromTool.reason === 'slot', '⑪ steward_thread_prioritize 的返回给出同一个 slot');
      ok(JSON.stringify(Object.keys(fromArbiter || {}).sort()) === JSON.stringify(Object.keys(fromMissions || {}).sort())
        && JSON.stringify(Object.keys(fromMissions || {}).sort()) === JSON.stringify(Object.keys(fromTool || {}).sort()),
        '⑪ 三处的键集完全相同(同一个 waitReasonFor 的输出)');
      ok(fromArbiter && fromMissions && fromArbiter.label === fromMissions.label, '⑪ 三处的人话逐字相同(UI 与管家不会各说各的)');
      const rowIdle = rowOf(idle);
      ok(rowIdle && Object.prototype.hasOwnProperty.call(rowIdle, 'wait') && rowIdle.wait === null,
        '⑪ 不在等的线程 wait 字段恒在、值是 null(诚实,不编一个「在等」)');
      await Promise.all([pa, pb]);
    }

    /* ═════════ ⑥(饥饿避免:第二个进程)═════════ */
    {
      const mk = async (n) => {
        const dir = path.join(HOME2, 'ws-' + n);
        fs.mkdirSync(dir, { recursive: true });
        return { id: await newSession('starve-' + n, dir, SP, hdr2), cwd: dir };
      };
      const thr = await req(SP, 'GET', '/api/steward/arbiter', undefined, hdr2);
      ok(thr.status === 200 && thr.body.starveThresholdMs === STARVE_MS,
        `⑥ 测试接缝生效:饥饿阈值被 env 覆盖成 ${STARVE_MS}ms(实测 ${thr.body && thr.body.starveThresholdMs})`);
      const holder = await mk('holder');
      const victim = await mk('victim');
      const s = sampler(SP, hdr2);
      const runs = [];
      runs.push(stream(SP, { sessionId: holder.id, message: '一直占着', cwd: holder.cwd }, hdr2));
      await sleep(120);
      runs.push(stream(SP, { sessionId: victim.id, message: '先排队的可怜人', cwd: victim.cwd }, hdr2));
      await sleep(120);
      // 持续往队首塞插队者:没有饥饿避免的话,victim 会被无限期挤在后面。
      const jumpers = [];
      for (let i = 0; i < 6; i++) {
        const j = await mk('jump' + i);
        jumpers.push(j.id);
        runs.push(stream(SP, { sessionId: j.id, message: '插队 ' + i, cwd: j.cwd }, hdr2));
        await sleep(60);
        await req(SP, 'POST', '/api/steward/arbiter/prioritize', { sessionId: j.id }, hdr2);
        await sleep(180);
      }
      await Promise.all(runs);
      await s.stop();
      const firstSeen = new Map();
      for (const f of s.frames) for (const sid of runningIds(f)) if (!firstSeen.has(sid)) firstSeen.set(sid, f.at);
      ok(firstSeen.has(victim.id), '⑥ 被挤的那条最终拿到了并发位(没有饿死)');
      const laterJumpers = jumpers.filter(j => firstSeen.has(j) && firstSeen.get(j) > firstSeen.get(victim.id));
      ok(laterJumpers.length >= 1, `⑥ 它先于至少一条后来的插队者被放行(实测 ${laterJumpers.length} 条排在它后面)`);
      // 队伍里它确实被提到过队首(饥饿提升只做一次,不会退化成新的插队循环)。
      const headTimes = s.frames.filter(f => (f.queue[0] || {}).sessionId === victim.id).length;
      ok(headTimes > 0, '⑥ 观察到它被提到了队首');
      const stillQueued = await req(SP, 'GET', '/api/steward/arbiter', undefined, hdr2);
      ok(stillQueued.body.queue.length === 0 && stillQueued.body.running.length === 0, '⑥ 收场时队列与并发位都清空');
    }

    /* ═════════ ⑫(116-3 P0-5:同 cwd 写互斥的 TOCTOU)═════════ */
    // ③ 那一节两条回合之间隔了 150ms,先到的早就写进 running 了 —— 它测的是「排队看得懂」,不是竞态。
    // 这一节把 4 条【同 cwd】的回合真正同时发出去(零间隔):修前 stewardAcquireTurnSlot 对全新条目走的是
    // 「查一次 blocked -> 不阻塞就立刻 grant」的未同步快路径,中间隔着 readConfig / hasPending /
    // arbiterBudget 三次真实 await,四条会一起判定「没人占着」然后各自 grant,写互斥形同虚设。
    // 修后:全新条目也先入队,准入判定与写进 running 由 drain 在同一同步段里做。
    {
      // 并发位撑开:唯一还能挡住它们的只剩 cwd 写锁。
      // stewardGlobalMaxCostPerDay 必须【大于 0】—— 它决定 stewardArbiterBlocked 里的预算闸要不要真去读
      // 用量台账(一次真实磁盘读)。上限是 0 时那一步不 await 任何真东西,四条申请会被微任务顺序意外
      // 串起来,竞态根本不出现;上限 >0 才是用户的常态配置,也才是这条 TOCTOU 的真实触发条件。
      await setConfig({ stewardMaxParallelThreads: 8, stewardGlobalMaxCostPerDay: 100 });
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push(await newSession('toctou-' + i, cwds.shared));
      const s = sampler(WP, hdr);
      const runs = await Promise.all(ids.map((id, i) => stream(WP, { sessionId: id, message: '同时冲 ' + i, cwd: cwds.shared }, hdr)));
      await s.stop();
      ok(runs.every(r => r.events.some(e => e.type === 'result' && e.ok === true)), '⑫ 4 条同 cwd 的并发回合最终都跑完');
      const peakRunning = s.frames.reduce((max, f) => Math.max(max, f.running.length), 0);
      ok(peakRunning <= 1, `⑫ 同时申请时 running 峰值仍是 1(修前会同时放行多条;实测 ${peakRunning})`);
      // 墙钟下界:真串行的话总耗时至少是 4 个回合。并发放行的话 ~1 个回合就跑完了。
      // (不能用 peakOverlap:`session` 帧在申请并发位【之前】就发了,四条流的第一帧本来就重叠。)
      const elapsed = Math.max(...runs.map(r => r.endedAt)) - Math.min(...runs.map(r => r.startedAt));
      ok(elapsed >= TURN_MS * 3, `⑫ 总耗时 ${elapsed}ms ≥ 串行下界 ${TURN_MS * 3}ms(并发放行的话一个回合就跑完了)`);
      const waited = runs.filter(r => r.events.some(e => e.type === 'agent_resource' && e.state === 'waiting')).length;
      ok(waited === 3, `⑫ 4 条里有 3 条真的等过锁(第 1 条不等;实测 ${waited})`);
      const after = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      ok(after.body && after.body.running.length === 0 && after.body.queue.length === 0, '⑫ 收场时并发位与队列都清空(结转的入队路径不漏条目)');
    }

    /* ═════════ ⑬(116-3 P1-11:cwd 锁键先 realpath)═════════ */
    // 修前 stewardArbiterCwdKey 只做 path.resolve + Windows 折大小写,不做 realpath —— 两个会话的 cwd
    // 经不同的符号链接 / 目录联接(junction)指向同一个真实目录时会算出两个不同的锁键,写互斥完全
    // 不生效,同一棵目录树真的会被两条线程并发改。
    {
      const linkPath = path.join(HOME, 'ws-shared-link');
      let linked = false;
      try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.symlinkSync(cwds.shared, linkPath, 'junction'); linked = true; } catch { linked = false; }
      if (!linked) {
        console.log('SKIP ⑬ 本机建不出目录联接(需要 junction 支持),跳过 realpath 归一化判定');
      } else {
        await setConfig({ stewardMaxParallelThreads: 8, stewardGlobalMaxCostPerDay: 0 });
        const real = await newSession('junction-real', cwds.shared);
        const viaLink = await newSession('junction-link', linkPath);
        const s = sampler(WP, hdr);
        const pa = stream(WP, { sessionId: real, message: '真实路径', cwd: cwds.shared }, hdr);
        await sleep(150);
        const pb = stream(WP, { sessionId: viaLink, message: '走联接', cwd: linkPath }, hdr);
        const [ra, rb] = await Promise.all([pa, pb]);
        await s.stop();
        ok(ra.events.some(e => e.type === 'result' && e.ok === true) && rb.events.some(e => e.type === 'result' && e.ok === true),
          '⑬ 两条都跑完');
        const w = queueOf(s.frames, viaLink);
        ok(w && w.wait && w.wait.reason === 'lock',
          `⑬ 经目录联接指向同一个文件夹的第二条被判为等锁(修前算出不同的哈希键、直接并发;实测 ${w && w.wait ? w.wait.reason : '没等过'})`);
        ok(s.frames.every(f => f.running.length <= 1), '⑬ 两条从不同时在跑(realpath 归一化真的生效)');
        try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    /* ═════════ ⑭(116-3 P1-13:看板插队走工具实现,校验 + 审计)═════════ */
    // 修前这条路由直接调仲裁器裸原语:既不校验目标是否存在/是不是管家会话,也不落决策日志 ——
    // 于是【每一次经看板做的插队在 decisions-v1.ndjson 里都没有记录】,与 §3.4「全部行动经命令核心
    // 与审计」相悖;编造的 sessionId 也只是静默 not_queued。
    {
      const decisionsFile = path.join(HOME, 'steward', 'decisions-v1.ndjson');
      const readDecisions = () => {
        try {
          return fs.readFileSync(decisionsFile, 'utf8').split('\n').filter(Boolean)
            .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        } catch { return []; }
      };
      await setConfig({ stewardMaxParallelThreads: 1, stewardGlobalMaxCostPerDay: 0 });
      const head = await newSession('audit-head', cwds.a);
      const queuedOne = await newSession('audit-queued', cwds.b);
      const runs = [stream(WP, { sessionId: head, message: '占位', cwd: cwds.a }, hdr)];
      await sleep(200);
      runs.push(stream(WP, { sessionId: queuedOne, message: '排队', cwd: cwds.b }, hdr));
      await sleep(250);
      const before = readDecisions().length;
      const pr = await req(WP, 'POST', '/api/steward/arbiter/prioritize', { sessionId: queuedOne }, hdr);
      ok(pr.status === 200 && pr.body && pr.body.prioritized === true, `⑭ 看板插队照常成功(got ${pr.status})`);
      await Promise.all(runs);
      await sleep(400);
      const rows = readDecisions();
      const row = [...rows].reverse().find(r => r.tool === 'steward_thread_prioritize' && r.targetSessionId === queuedOne) || null;
      ok(rows.length > before && row, `⑭ 看板插队落进决策日志(修前一行都没有;新增 ${rows.length - before} 行)`);
      ok(row && typeof row.permissionMode === 'string' && row.undoRef && row.undoRef.kind === 'prioritize',
        '⑭ 与工具路径逐字同形(permissionMode / undoRef 都在)');
      const ghost = await req(WP, 'POST', '/api/steward/arbiter/prioritize', { sessionId: 'sess_does_not_exist' }, hdr);
      ok(ghost.status === 400 && ghost.body && ghost.body.error && ghost.body.error.code === 'not_found',
        `⑭ 编造的 sessionId 被目标存在性校验拦下(修前静默 not_queued;got ${ghost.status} ${ghost.body && ghost.body.error && ghost.body.error.code})`);
    }

    /* ═════════ ⑮(116-3 P2-15:待决豁免的两个写者至少彼此可见)═════════ */
    // §11.6 116h 记录的口子原话是「同 cwd 可能与排队条目并发(刻意)」,听起来只影响排队顺序;
    // 但那个 bypass 判定发生在 stewardArbiterBlocked(内含同 cwd 锁检查)【之前】,所以一条有待决的
    // 线程可以和【正在写同一个目录、持锁运行中】的另一条正面撞上。语义不改(它不该等 —— 用户正在
    // 答复它),但两个写者要彼此可见:pendingWriters + 一条 agent_resource 提示。
    {
      await setConfig({ stewardMaxParallelThreads: 4, stewardGlobalMaxCostPerDay: 0 });
      const writer = await newSession('p215-writer', cwds.shared);
      const pending = await newSession('p215-pending', cwds.shared);   // 与写者【同一个】工作文件夹
      fs.writeFileSync(path.join(HOME, 'sessions', `${pending}.interventions.ndjson`),
        JSON.stringify({ id: 'iv_p215', type: 'question', status: 'pending', requestedAt: new Date().toISOString(), interventionVersion: 1, questions: [{ question: '选哪个?' }] }) + '\n');
      const pw = stream(WP, { sessionId: writer, message: '我在写这个目录', cwd: cwds.shared }, hdr);
      await sleep(200);
      const pp = stream(WP, { sessionId: pending, message: '我有待决', cwd: cwds.shared }, hdr);
      await sleep(250);
      const mid = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      const [rw2, rp] = await Promise.all([pw, pp]);
      ok(rw2.events.some(e => e.type === 'result' && e.ok === true) && rp.events.some(e => e.type === 'result' && e.ok === true),
        '⑮ 两条都跑完(待决豁免的语义不变:它不等锁)');
      const midBody = mid.body || {};
      ok(Array.isArray(midBody.pendingWriters) && midBody.pendingWriters.some(r => r.sessionId === pending),
        `⑮ 读模型多出 pendingWriters,能看见这条待决豁免的写者(修前它在任何面上都不可见;got ${JSON.stringify((midBody.pendingWriters || []).map(r => r.sessionId))})`);
      ok(Array.isArray(midBody.running) && !midBody.running.some(r => r.sessionId === pending),
        '⑮ 它仍然【不】进 running(不占并发位、不挡别人 —— 116h 的刻意设计一字不动)');
      const signal = rp.events.find(e => e.type === 'agent_resource' && Array.isArray(e.resources) && String(e.resources[0] || '').startsWith('cwd-write:'));
      ok(signal && signal.state === 'acquired' && Array.isArray(signal.blockers) && signal.blockers.length > 0,
        `⑮ 撞上同 cwd 的活跃写者时发一条 acquired(不是 waiting —— 它没在等谁,只是同时在写;got ${signal && signal.state})`);
      const after = await req(WP, 'GET', '/api/steward/arbiter', undefined, hdr);
      ok(after.body && Array.isArray(after.body.pendingWriters) && after.body.pendingWriters.length === 0,
        '⑮ 回合收尾后从 pendingWriters 里摘掉(release 幂等,不留幽灵)');
      fs.rmSync(path.join(HOME, 'sessions', `${pending}.interventions.ndjson`), { force: true });
    }

    /* ═════════ 源码单点锁:四个展示面都走 06i 的 waitReasonFor ═════════ */
    {
      const SRC = path.join(WB, 'app', 'src');
      const rd = f => fs.readFileSync(path.join(SRC, f), 'utf8');
      ok(/function waitReasonFor\(thread, ctx\)/.test(rd('06i-steward-core.js')), '单点:waitReasonFor 只声明在 06i(引擎层纯函数)');
      // 117 波 T1(32 号文 §2.1)重钉:steward_thread_status 的实现随拆分搬进 13k-steward-threads.js
      // (纯搬家,逐字节不变)。判据不变 —— 那个展示面必须经 06i 的 waitReasonFor,只是它现在住在
      // 13g 族的哪个文件里由拆分决定,故改读整族。下面「没有第二处自己拼的等待人话」也随之覆盖全族。
      const STEWARD_FAMILY = ['13g-steward.js', '13j-steward-tool-base.js', '13k-steward-threads.js', '13l-steward-ops.js'];
      ok(/waitReasonFor\(/.test(STEWARD_FAMILY.map(rd).join('\n')), '单点:steward_thread_status 经 waitReasonFor');
      ok(/waitReasonFor\(/.test(rd('13d-core-domain-routes.js')), '单点:GET /api/missions 的线程行经 waitReasonFor');
      const src13h = rd('13h-steward-runner.js');
      ok((src13h.match(/waitReasonFor\(/g) || []).length >= 3, '单点:总览行 / 仲裁器读模型 / 插队工具三处都经 waitReasonFor');
      for (const f of ['06i-steward-core.js', '13d-core-domain-routes.js', ...STEWARD_FAMILY, '13h-steward-runner.js']) {
        ok(!/等你\(\$\{[^}]*\} 条待决\)/.test(rd(f).replace(/^.*function waitReasonFor[\s\S]*?\n}\n/m, '')) || f === '06i-steward-core.js',
          `单点:${f} 里没有第二处自己拼的等待人话`);
      }
    }
  } catch (e) {
    console.log('ERROR ' + ((e && e.stack) || e));
    fail++;
  } finally {
    kill(wb); kill(wbs); kill(fake);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(HOME2, { recursive: true, force: true });
  }
  console.log('\nTHREAD ARBITER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error((e && e.stack) || e); process.exitCode = 1; });
