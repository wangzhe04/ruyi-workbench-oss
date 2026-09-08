'use strict';
// ════════════════════════════════════════════════════════════════════════════════════════════
// E2E 117r-D1(用户第八轮走查③):**管家开的速查线程必须出现在 GET /api/missions**。
//
// 为什么要有这一条:管家看板正文的唯一数据源是 GET /api/missions(public/js/steward-board.js),
// 而那条路由的行集是 `index.sessions.filter(row => row.card)`(13d-core-domain-routes.js)。
// 卡片修前只给 kind === 'mission' 的会话造(13e-pretender-index.js),而 steward_quick_ask 开的
// 线程显式写 `session.kind = 'quick_ask'`(13g-steward.js)—— 于是它恒无卡片、恒不进看板,
// 而面板顶部那两个数字来自仲裁器(速查回合照常占并发位),同一块面板上「在跑 1」与
// 「还没有任务」互相打脸。这个洞从 116 波活到 117r 没人报警,**因为一条断言都没有**。
//
// 两个方向都钉(只钉「有」的话,哪天有人把过滤器整个删掉、把几百条用户会话全灌进看板,
// 这条断言照样绿):
//   ① 管家开的速查线程(head.stewardQuick + launchedBy:'steward')**在** /api/missions 里;
//   ② 用户自己在经典壳里聊的普通会话(missionId === sessionId、无 stewardQuick、无 launchedBy)
//      **不在** /api/missions 里;
//   ③ 速查那条行的 kind 如实是 'quick_ask'、五态落在 quick_ask(速查中)—— 不许为了让它进列表
//      就把 kind 谎报成 mission;
//   ④ 抽屉打开一条速查线程时的第二发 GET /api/missions/<id> 拿得到详情(steward-drawer.js 同时
//      发 /api/missions?limit=200 与 /api/missions/<id>)。
//
// 夹具形态:会话经真 API 建(POST /api/sessions,正文与 index.json 都是真的),然后停机、在盘上
// 给速查那条会话头补 stewardQuick / launchedBy 两个机器痕迹(13g 在真回合里写的就是这两个),
// 再起一次 —— 停机重启是为了绕开投影索引的进程内缓存(buildOrLoadPretenderIndex 只在内存副本
// 缺席时才重扫会话目录),让夹具的确定性不依赖脏页标记的时序。零模型、零回合。
// ════════════════════════════════════════════════════════════════════════════════════════════
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const MissionState = require('../ruyi-workbench/app/public/js/mission-state.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-quickask-board-e2e');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 2000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 8000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: resp.statusCode, body: null, text: b }); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout ' + p)); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null, text: b }); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

(async () => {
  const WB_PORT = await getFreePort();
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));

  const spawnWb = () => {
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    wb.stdout.on('data', () => {});
    procs.push(wb);
    return wb;
  };
  const waitUp = async () => { let h = null; for (let i = 0; i < 60 && !h; i++) { await sleep(150); h = await health(WB_PORT); } return !!h; };
  const headFile = id => path.join(HOME, 'sessions', id + '.json');
  const H = token => ({ 'x-wcw-token': token });

  try {
    // ── 第一次启动:用真 API 建三条会话(正文、index.json、投影脏页全部是真的)────────────
    let wb = spawnWb();
    ok(await waitUp(), '① workbench started on :' + WB_PORT);
    let token = await getToken(WB_PORT);
    ok(!!token, '① UI token scraped');

    const mk = async title => (await postJson(WB_PORT, '/api/sessions', { title, cwd: HOME })).body.session.id;
    const sidQuick = await mk('联网查一下这个报错');   // 管家 steward_quick_ask 开的速查线程
    const sidUser = await mk('我自己在 2.0 里聊的');   // 用户自己开的普通会话
    const sidMission = await mk('一条真任务');          // 对照:kind=mission 的会话,修前修后都该在
    ok(!!sidQuick && !!sidUser && !!sidMission, '① three sessions created via POST /api/sessions');

    killp(wb); await sleep(400);

    // ── 在盘上补机器痕迹:13g 的 stewardImplQuickAsk 在真回合里写的就是这两个字段 ──────────
    const patch = (sid, extra) => {
      const head = JSON.parse(fs.readFileSync(headFile(sid), 'utf8'));
      fs.writeFileSync(headFile(sid), JSON.stringify(Object.assign(head, extra), null, 2));
    };
    patch(sidQuick, {
      kind: 'quick_ask',
      launchedBy: 'steward',
      stewardQuick: { schema: 1, askedAt: new Date().toISOString(), question: '联网查一下这个报错', stewardTurnKey: 'k1', closedAt: null },
      turnSeq: 1,
      stewardLastTurn: { seq: 1, ok: true, aborted: false },
    });
    patch(sidMission, { kind: 'mission' });
    // 用户那条一个字不动:kind 仍是 createSession 的缺省 quick_ask,missionId === sessionId,
    // 没有 stewardQuick、没有 launchedBy —— 这正是「用户自己在经典壳里聊的普通会话」的形状。
    const userHead = JSON.parse(fs.readFileSync(headFile(sidUser), 'utf8'));
    ok(userHead.kind === 'quick_ask' && !userHead.stewardQuick && !userHead.launchedBy && userHead.missionId === sidUser,
      '② 用户那条会话确实是「普通会话」形状(kind=quick_ask/无 stewardQuick/无 launchedBy/missionId 指回自己)');

    wb = spawnWb();
    ok(await waitUp(), '② workbench restarted (fresh projection index)');
    token = await getToken(WB_PORT);

    // ── 看板正文的唯一数据源 ────────────────────────────────────────────────────────────
    const list = await getJson(WB_PORT, '/api/missions?limit=200', H(token));
    ok(list.status === 200 && Array.isArray(list.body && list.body.missions),
      '③ GET /api/missions?limit=200 -> 200(实 ' + list.status + ')');
    const rows = (list.body && list.body.missions) || [];
    const rowOf = sid => rows.find(r => r && r.sessionId === sid) || null;

    const quickRow = rowOf(sidQuick);
    ok(!!quickRow, '③ 【有】管家开的速查线程在 /api/missions 里(' + sidQuick + ';行数 ' + rows.length + ')');
    ok(!rowOf(sidUser), '③ 【没有】用户自己聊的普通会话(' + sidUser + ')—— 两个方向都钉:过滤器被整个删掉时这条必红');
    ok(!!rowOf(sidMission), '③ 对照组:kind=mission 的会话照旧在(既有行为零回归)');

    // ── 卡片必须如实,不许为了进列表把 kind 谎报成 mission ──────────────────────────────
    ok(quickRow && quickRow.kind === 'quick_ask',
      '④ 速查行的 kind 如实是 quick_ask(实 ' + (quickRow && quickRow.kind) + ')');
    const derived = quickRow ? MissionState.fromCard(quickRow) : null;
    ok(derived && derived.state === 'quick_ask',
      '④ 五态落在 quick_ask(速查中;实 ' + (derived && derived.state) + ')');
    ok(quickRow && quickRow.derived === true && quickRow.missionId === sidQuick,
      '④ 它是一条「未归类」的派生行(derived:true、missionId 指回自己)—— 与 13g:1852 那句注释一致');

    // ── 抽屉打开一条速查线程时的第二发 ──────────────────────────────────────────────────
    const detail = await getJson(WB_PORT, '/api/missions/' + sidQuick, H(token));
    ok(detail.status === 200 && detail.body && detail.body.ok === true,
      '⑤ 抽屉第二发 GET /api/missions/<速查线程> -> 200(实 ' + detail.status + ')');
    ok(detail.body && detail.body.snapshot && detail.body.snapshot.kind === 'quick_ask',
      '⑤ 详情快照 kind 也如实是 quick_ask(实 ' + (detail.body && detail.body.snapshot && detail.body.snapshot.kind) + ')');
  } catch (error) {
    fail++; console.log('FAIL 未捕获异常: ' + (error && error.stack || error));
  } finally {
    for (const p of procs) killp(p);
  }
  console.log(fail ? `STEWARD QUICKASK BOARD E2E: ${fail} FAILURE(S)` : 'STEWARD QUICKASK BOARD E2E: ALL PASS');
  process.exit(fail ? 1 : 0);
})();
