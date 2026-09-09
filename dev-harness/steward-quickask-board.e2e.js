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
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); } // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
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
  // 117r-D5:⑥ 段要一条【真的在飞】的回合,所以这里起一个只发首块、永不收尾的 fake provider
  // (与 steward-board.e2e.js 的 'hang' 分支同款)。①—⑤ 段一个字节都不碰它:那几段零回合零模型。
  const PROVIDER_PORT = await getFreePort();
  const hungResponses = [];
  const providerServer = http.createServer(async (req, res) => {
    if (String(req.url || '').includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"data":[{"id":"fake-model"}]}');
    }
    let raw = ''; for await (const chunk of req) raw += chunk;
    void raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: '开工了…' }, finish_reason: null }] }) + '\n\n');
    hungResponses.push(res);            // 故意不收尾:这条回合一直在飞
  });
  await new Promise(resolve => providerServer.listen(PROVIDER_PORT, '127.0.0.1', resolve));
  const inflight = [];
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + PROVIDER_PORT + '/v1', apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
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
    // 117r-D5 重钉(逐对交代):这一行原来断言 `derived.state === 'quick_ask'`。
    // 理由:D1 那一刀只关心「它进不进看板」,当时五态对它还是短路的;D5 把第 0 条守卫从
    // 「kind 是不是速查」换成「调用方有没有事实」之后,这条夹具线程手上有事实(turnSeq 1 +
    // stewardLastTurn{ok:true} = 跑完了),于是如实落 done。原断言钉的是【被修掉的那个症状】本身
    // (一条三小时前就跑完的速查线程永远只会说「速查中」),不是被误伤的正确行为。
    // 伴随的更强断言(原来一条都没有):同一屏上组标题的 aggregateState 必须与行上的五态【不打脸】——
    // 症状②就是「组标题已停工 / 组内那行速查中」,只钉行不钉组的话那条打脸下次还能悄悄回来。
    ok(derived && derived.state === 'done',
      '④ 跑完的速查线程五态落在 done(已收工;实 ' + (derived && derived.state) + ')');
    ok(quickRow && quickRow.aggregateState === 'done' && quickRow.aggregateState === derived.state,
      '④ 组标题的 aggregateState 与行上五态一致,不再互相打脸(实 aggregate=' + (quickRow && quickRow.aggregateState) + ' / row=' + (derived && derived.state) + ')');
    ok(quickRow && quickRow.derived === true && quickRow.missionId === sidQuick,
      '④ 它是一条「未归类」的派生行(derived:true、missionId 指回自己)—— 与 13g:1852 那句注释一致');

    // ── 抽屉打开一条速查线程时的第二发 ──────────────────────────────────────────────────
    const detail = await getJson(WB_PORT, '/api/missions/' + sidQuick, H(token));
    ok(detail.status === 200 && detail.body && detail.body.ok === true,
      '⑤ 抽屉第二发 GET /api/missions/<速查线程> -> 200(实 ' + detail.status + ')');
    ok(detail.body && detail.body.snapshot && detail.body.snapshot.kind === 'quick_ask',
      '⑤ 详情快照 kind 也如实是 quick_ask(实 ' + (detail.body && detail.body.snapshot && detail.body.snapshot.kind) + ')');

    // ── ⑥ 117r-D5:一条【在跑】的速查线程,行上的五态与它所在组的聚合态都必须是 running ──────
    // 这一条钉的是症状①(状态行数 view.state === 'running' 数出 0、看板头数仲裁器数出 1)与
    // 症状②(组标题「已停工」/ 组内那行「速查中」)。修前它恒是 quick_ask、聚合恒落 stopped,
    // 两个数字必然打脸;修后同一份事实只有一个说法。
    // 「在跑」用真回合造:开一条挂着不收尾的 SSE(provider 只发首块、不发 [DONE]),
    // activeTurn 于是一直为真 —— 不拿 autoMode 之类的旁门左道顶替(那不是速查线程的真实形状)。
    const streamReq = http.request({
      host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST',
      headers: { 'content-type': 'application/json', ...H(token) },
    }, res => { res.on('data', () => {}); res.on('error', () => {}); });
    streamReq.on('error', () => { /* 收尾时被掐断是预期的 */ });
    streamReq.end(JSON.stringify({ sessionId: sidQuick, message: 'hang here', cwd: HOME }));
    inflight.push(streamReq);

    let runningRow = null;
    for (let i = 0; i < 80 && !runningRow; i++) {
      await sleep(150);
      const poll = await getJson(WB_PORT, '/api/missions?limit=200', H(token)).catch(() => null);
      const row = ((poll && poll.body && poll.body.missions) || []).find(r => r && r.sessionId === sidQuick) || null;
      if (row && row.activeTurn === true) runningRow = row;
    }
    ok(!!runningRow, '⑥ 速查线程的回合真的在飞(行上 activeTurn=true)');
    const runningDerived = runningRow ? MissionState.fromCard(runningRow) : null;
    ok(runningDerived && runningDerived.state === 'running',
      '⑥ 在跑的速查线程,行上五态是 running(实 ' + (runningDerived && runningDerived.state) + ')—— 修前恒是 quick_ask,状态行「A 条在跑」永远数不到它');
    ok(runningRow && runningRow.aggregateState === 'running',
      '⑥ 它所在组的 aggregateState 也是 running(实 ' + (runningRow && runningRow.aggregateState) + ')—— 修前 aggregateMissionState([quick_ask]) 恒落 stopped,组标题「已停工」压着组内「速查中」');
    // 身份没有随状态一起消失:kind 仍如实是 quick_ask(看板行上那枚徽标读的就是它)。
    ok(runningRow && runningRow.kind === 'quick_ask',
      '⑥ 在跑时 kind 仍如实是 quick_ask(速查是 kind 不是 state;徽标读它)');
  } catch (error) {
    fail++; console.log('FAIL 未捕获异常: ' + (error && error.stack || error));
  } finally {
    // 收尸顺序:先掐在途的 SSE 客户端连接,再放掉挂着的 provider 响应,最后关服务与 workbench 进程 ——
    // 少一步这件 e2e 就会挂在 event loop 上不退出(与 117q-B4 那条 finally 收尸同一条纪律)。
    for (const r of inflight) { try { r.destroy(); } catch { /* 已断 */ } }
    for (const r of hungResponses) { try { r.end(); } catch { /* 已断 */ } }
    try { providerServer.close(); } catch { /* 已关 */ }
    for (const p of procs) killp(p);
  }
  console.log(fail ? `STEWARD QUICKASK BOARD E2E: ${fail} FAILURE(S)` : 'STEWARD QUICKASK BOARD E2E: ALL PASS');
  process.exit(fail ? 1 : 0);
})();
