#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// ════════════════════════════════════════════════════════════════════════════════════════════
// E2E 117s-A D1(27 号文 §11.13 ③):**GET /api/missions 的行序是「状态优先、其次 updatedAt」**。
//
// 用户第九轮走查原话:「在运行中的线程,最好能自动排到最前面」。截图 1 上「已收工」压在「进行中」
// 上面,两条都是 20 秒前有动静 —— 根因是服务端只按 `updatedAt` 排(13d 三处 sort 全是
// `String(b.updatedAt).localeCompare(String(a.updatedAt))`),一条刚收工的线程只要新一秒就在上面。
//
// 秩由 06i 的 stewardThreadStateRank 单点给:needs_you > running > dispatching > done/stopped。
// **这不是第二个状态机** —— 入参是既有五态判据算出来的那个字符串,本件只钉「谁排在谁前面」。
//
// 覆盖:
//   ① 在跑的线程(updatedAt 最旧)排在已收工的线程(updatedAt 最新)前面 —— 修前必然相反;
//   ② needs_you 压过 running:三条线程的 updatedAt 顺序与期望行序【完全相反】,
//      所以这一条只有真按状态排才可能绿(纯 updatedAt 排出来的是逐条倒过来的那一列);
//   ③ 组序同规则(组的秩 = 它的聚合态的秩,聚合态只经 06i 的 aggregateMissionState),
//      且同一个事项的行仍然是【连续】的(看板 groupRows() 按 missionId 首次出现定组序);
//   ④ 状态变了而会话头的 updatedAt 一个字节没动时,ETag 必须失效 —— 否则带 If-None-Match
//      来的下一拍会拿到 304 + 一份旧顺序的行(与 117h 那条 acceptance 的 304 教训同一个模具)。
//
// 夹具形态(零模型、零回合、全确定性):
//   · 三条会话经真 API 建(POST /api/sessions),然后停机在盘上补机器痕迹,再起一次 ——
//     停机重启是为了绕开投影索引的进程内缓存,让确定性不依赖脏页标记的时序(与
//     steward-quickask-board.e2e.js 同款);
//   · running 用 `mission.autoMode:'until-done'`(deriveStewardThreadState 的 running 分支之一),
//     不用活回合 —— 活回合会把 updatedAt 推成最新,那样就没法钉「旧的在跑压过新的收工」;
//   · needs_you 用一条 `status:'paused'` 的班组 run + 一条 `status:'proposed'` 的池提案:
//     missionPendingCounts 直接数 runs[].taskPool 的 proposed(13d:415),pendingTotal>0 -> needs_you,
//     而且 paused run 的提案在重启时被【刻意保留】(08 markInterruptedAgentRuns 的 paused 分支 +
//     02 markInterruptedInterventions 的 pool 分流)—— 换成 question 型 pending 会在下次 boot 被
//     终态化成 cancelled_restart,夹具当场失效;
//   · done 用「跑过回合 + 无账本 + 末回合 ok」(117p-S2 那条 ledgerless 分支)。
//
// 判定行:`STEWARD THREAD ORDER E2E: ALL PASS`。
// ════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const MissionState = require('../ruyi-workbench/app/public/js/mission-state.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-order-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const kill = c => { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } } };

const WB_PORT = await getFreePort();
const PROVIDER_PORT = await getFreePort();

// 端点只为「配置合法」而存在:本件一次回合都不跑,provider 不会收到任何请求。
const providerServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"data":[{"id":"fake-model"}]}');
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  locale: 'zh-CN', stewardEnabledV1: true, stewardThreadBriefV1: false, stewardPollMs: 120000,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');

function request(method, p, body, headers) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: p, method, timeout: 30000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(headers || {}) },
    }, res => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { json = null; } resolve({ status: res.statusCode, json, raw: b, etag: res.headers.etag || '' }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, raw: '', etag: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '', etag: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}
async function waitUp() { for (let i = 0; i < 300; i++) { const h = await request('GET', '/health'); if (h.status === 200) return true; await sleep(120); } return false; }
async function tokenOf() {
  const html = await new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 5000 }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); });
    r.on('error', () => resolve('')); r.on('timeout', () => { r.destroy(); resolve(''); });
  });
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}
const headFile = id => path.join(HOME, 'sessions', id + '.json');
const readHead = id => JSON.parse(fs.readFileSync(headFile(id), 'utf8'));
const writeHead = (id, head) => fs.writeFileSync(headFile(id), JSON.stringify(head, null, 2), 'utf8');

// updatedAt 三个刻度:期望行序是 N -> R -> D,而 updatedAt 顺序恰好是 D > R > N(逐条相反)。
const AT_OLD = '2026-09-01T00:00:00.000Z';   // needs_you 那条:最旧
const AT_MID = '2026-09-02T00:00:00.000Z';   // running   那条:居中
const AT_NEW = '2026-09-03T00:00:00.000Z';   // done      那条:最新

let wb = null;
const spawnWb = () => {
  const p = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  return p;
};

try {
  /* ═══════ 第一次启动:用真 API 建三条会话 ═══════ */
  wb = spawnWb();
  ok(await waitUp(), '① workbench started on :' + WB_PORT);
  let hdr = { 'x-wcw-token': await tokenOf() };
  const mk = async title => {
    const r = await request('POST', '/api/sessions', { title, cwd: HOME }, hdr);
    return r.json && r.json.session && r.json.session.id;
  };
  const N = await mk('等你按一下的线程');
  const R = await mk('正在跑的线程');
  const D = await mk('已经收工的线程');
  ok(!!N && !!R && !!D, `① 三条会话建起来了(N=${N} R=${R} D=${D})`);

  kill(wb); await sleep(500);

  /* ═══════ 在盘上补机器痕迹 ═══════ */
  // R:在跑。autoMode='until-done' 是 deriveStewardThreadState 的 running 三条判据之一
  //   (activeTurn || autoMode==='until-done' || liveRuns>0),它住在会话头里,重启后仍在。
  writeHead(R, Object.assign(readHead(R), {
    kind: 'mission', launchedBy: 'steward', turnSeq: 2, updatedAt: AT_MID,
    mission: { goal: '把这件事跑完', createdAt: AT_MID, updatedAt: AT_MID, autoMode: 'until-done', milestones: [], budget: { maxAutoTurns: 10, maxTokens: 0 }, spent: { autoTurns: 1, tokens: 0 }, result: null },
  }));
  // D:已收工。117p-S2 的 ledgerless 分支 —— 跑过回合(turnSeq>0)、头上没有 mission 账本、末回合 ok。
  writeHead(D, Object.assign(readHead(D), {
    kind: 'mission', launchedBy: 'steward', turnSeq: 3, updatedAt: AT_NEW,
    stewardLastTurn: { seq: 3, ok: true, aborted: false, errorClass: '', at: AT_NEW },
  }));
  // N:等你。池提案 -> missionPendingCounts 的 pool 计数 -> pendingTotal>0 -> needs_you。
  // run 必须是 paused:running/waiting_pool 会在 boot 被标 interrupted 并把提案 expire 掉。
  writeHead(N, Object.assign(readHead(N), {
    kind: 'mission', launchedBy: 'steward', turnSeq: 1, updatedAt: AT_OLD,
    stewardLastTurn: { seq: 1, ok: true, aborted: false, errorClass: '', at: AT_OLD },
  }));
  const runDir = path.join(HOME, 'agent-runs', N);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'run_a1b2c3d4.json'), JSON.stringify({
    id: 'run_a1b2c3d4', sessionId: N, status: 'paused', createdAt: AT_OLD, updatedAt: AT_OLD,
    nodes: [], messages: [], eventSeq: 0,
    taskPool: [{ id: 'pool_seed01', status: 'proposed', task: '要不要顺手把这个也做了', proposedBy: 'agent-1', proposedAt: AT_OLD }],
  }, null, 2), 'utf8');

  /* ═══════ 第二次启动:投影索引全新重建 ═══════ */
  wb = spawnWb();
  ok(await waitUp(), '② workbench restarted (fresh projection index)');
  hdr = { 'x-wcw-token': await tokenOf() };

  const list = await request('GET', '/api/missions?limit=200', undefined, hdr);
  ok(list.status === 200 && Array.isArray(list.json && list.json.missions), `② GET /api/missions -> 200(实 ${list.status})`);
  const rows = (list.json && list.json.missions) || [];
  const at = sid => rows.findIndex(r => r && r.sessionId === sid);
  const rowOf = sid => rows.find(r => r && r.sessionId === sid) || null;
  const stateOf = sid => { const r = rowOf(sid); return r ? MissionState.fromCard(r).state : ''; };

  // 前置:三条线程的五态与 updatedAt 确实是夹具想要的那个样子(不然下面的行序断言无从谈起)。
  ok(stateOf(N) === 'needs_you', `③ N 的五态是 needs_you(实 ${stateOf(N)})`);
  ok(stateOf(R) === 'running', `③ R 的五态是 running(实 ${stateOf(R)})`);
  ok(stateOf(D) === 'done', `③ D 的五态是 done(实 ${stateOf(D)})`);
  ok(rowOf(N) && rowOf(N).updatedAt === AT_OLD && rowOf(R) && rowOf(R).updatedAt === AT_MID && rowOf(D) && rowOf(D).updatedAt === AT_NEW,
    `③ updatedAt 三个刻度落定且与期望行序完全相反(N=${rowOf(N) && rowOf(N).updatedAt} R=${rowOf(R) && rowOf(R).updatedAt} D=${rowOf(D) && rowOf(D).updatedAt})`);

  // ④ 核心:在跑的排在已收工的前面 —— 尽管它的 updatedAt 更旧。修前这一条必然相反。
  ok(at(R) >= 0 && at(D) >= 0 && at(R) < at(D),
    `④ 在跑的线程排在已收工的线程前面(R 在第 ${at(R)} 行、D 在第 ${at(D)} 行;R 的 updatedAt 比 D 旧一整天)`);
  // ⑤ needs_you 压过 running。
  ok(at(N) >= 0 && at(N) < at(R),
    `⑤ 等你的线程压过在跑的线程(N 在第 ${at(N)} 行、R 在第 ${at(R)} 行)`);
  // ⑥ 三条一次到位:行序与 updatedAt 顺序【逐条相反】—— 只按 updatedAt 排绝不可能排出这一列。
  ok(at(N) < at(R) && at(R) < at(D),
    `⑥ 整列行序 = 状态秩(needs_you -> running -> done),与 updatedAt 降序(D -> R -> N)逐条相反`);

  // ⑦ 组序同规则,且同一事项的行连续。这三条各自成组(未归类,missionId 指回自己),
  //    所以组的聚合态就是它自己那条线程的五态 —— 组序与行序必然一致;这一条钉的是
  //    aggregateState 也被排序键读到了,而不是只排了线程。
  const groupSeq = [];
  for (const row of rows) { const mid = String(row.missionId || row.sessionId); if (groupSeq[groupSeq.length - 1] !== mid) groupSeq.push(mid); }
  ok(new Set(groupSeq).size === groupSeq.length, `⑦ 同一个事项的行是连续的(组序 ${JSON.stringify(groupSeq.map(s => s.slice(-6)))} 无重复出现)`);
  ok(groupSeq.indexOf(N) < groupSeq.indexOf(R) && groupSeq.indexOf(R) < groupSeq.indexOf(D),
    '⑦ 组序也是 needs_you -> running -> done');
  ok(rowOf(N).aggregateState === 'needs_you' && rowOf(R).aggregateState === 'running' && rowOf(D).aggregateState === 'done',
    `⑦ 组的聚合态只经 06i aggregateMissionState,与行上五态不打脸(实 ${rowOf(N).aggregateState}/${rowOf(R).aggregateState}/${rowOf(D).aggregateState})`);

  // ⑧ 条件读:先确认同一份事实拿得到 304(否则下面那条「失效」不成立)。
  const etag1 = list.etag;
  ok(!!etag1, `⑧ /api/missions 带 ETag(实 ${etag1})`);
  const notModified = await request('GET', '/api/missions?limit=200', undefined, { ...hdr, 'if-none-match': etag1 });
  ok(notModified.status === 304, `⑧ 事实没变时同一个 ETag 拿到 304(实 ${notModified.status})`);

  /* ═══════ 只改状态、不动 updatedAt ═══════ */
  // R 从「在跑」落到「已收工」:把 autoMode 关掉、给一条成功的末回合,**updatedAt 一个字节不动**。
  // 直接写盘 + 重启(而不是走 PATCH),正是为了让 updatedAt 保持不变 —— saveSession 会把它推成 now。
  kill(wb); await sleep(500);
  {
    const head = readHead(R);
    head.mission = null;
    head.stewardLastTurn = { seq: 2, ok: true, aborted: false, errorClass: '', at: AT_MID };
    head.updatedAt = AT_MID;                       // 逐字不变
    writeHead(R, head);
  }
  wb = spawnWb();
  ok(await waitUp(), '⑨ workbench restarted after a state-only change');
  hdr = { 'x-wcw-token': await tokenOf() };

  const after = await request('GET', '/api/missions?limit=200', undefined, hdr);
  const rows2 = (after.json && after.json.missions) || [];
  const at2 = sid => rows2.findIndex(r => r && r.sessionId === sid);
  const row2R = rows2.find(r => r && r.sessionId === R) || null;
  ok(row2R && row2R.updatedAt === AT_MID, `⑨ R 的 updatedAt 逐字未变(实 ${row2R && row2R.updatedAt})`);
  ok(row2R && MissionState.fromCard(row2R).state === 'done', `⑨ R 的五态由 running 落到 done(实 ${row2R && MissionState.fromCard(row2R).state})`);
  // R 与 D 现在同为 done,行序回落到 updatedAt 降序 -> D(更新)在 R 前面。
  ok(at2(D) < at2(R), `⑨ 同秩时仍按 updatedAt 降序(D 第 ${at2(D)} 行、R 第 ${at2(R)} 行)—— 状态秩只是【第一】排序键,没有吃掉第二键`);
  // ⑩ 旧 ETag 必须失效:否则带 If-None-Match 来的那一拍会拿到 304 + 一份旧顺序的行。
  ok(after.etag && after.etag !== etag1, `⑩ 状态变了而 updatedAt 没变 -> ETag 变了(旧 ${etag1} / 新 ${after.etag})`);
  const stale = await request('GET', '/api/missions?limit=200', undefined, { ...hdr, 'if-none-match': etag1 });
  ok(stale.status === 200, `⑩ 拿旧 ETag 来条件读【不】返回 304(实 ${stale.status})—— 不会把旧行序留在看板上`);
  // ⑪ 上一条只钉了「ETag 整体变了」,而 ETag 有三段(missionsRevision - liveOverlay - 行指纹),
  //    卡片本身也变了 -> 第一段本来就会动。这一条单独钉【第三段】(buildMissionAggregateRows 的行指纹):
  //    修前它只吃事项容器,本夹具一个容器都没有 -> 恒等于空数组的哈希,两次读逐字相同。
  //    把秩写进指纹之后它才随状态动 —— 这一条是对「指纹纳入秩」这一行代码本身的反向可证断言。
  const stampOf = etag => String(etag).replace(/^W\/"|"$/g, '').split('-')[3] || '';
  const emptyHash = String(etag1).replace(/^W\/"|"$/g, '').split('-')[2] || ''; // liveOverlay 恒空 = 空数组的哈希
  ok(stampOf(etag1) && stampOf(etag1) !== emptyHash,
    `⑪ 行指纹段不再是「空数组的哈希」(指纹 ${stampOf(etag1)} / 空哈希 ${emptyHash})—— 本夹具零事项容器,修前这两个必然相等`);
  ok(stampOf(after.etag) !== stampOf(etag1),
    `⑪ 只有状态变(updatedAt 与容器字段都没动)时,行指纹段也变了(旧 ${stampOf(etag1)} / 新 ${stampOf(after.etag)})`);
} catch (error) {
  fail++; console.log('FAIL 未捕获异常: ' + (error && error.stack || error));
} finally {
  kill(wb);
  try { providerServer.close(); } catch { /* 已关 */ }
}
console.log(fail ? `STEWARD THREAD ORDER E2E: ${fail} FAILURE(S)` : 'STEWARD THREAD ORDER E2E: ALL PASS');
process.exit(fail ? 1 : 0);
})();
