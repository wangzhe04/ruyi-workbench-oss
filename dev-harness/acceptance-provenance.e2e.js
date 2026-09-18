require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
(async () => {
// E2E (第124波 P1 · 40 号文 §2 ①):验收四态与只读投影。
// 治的是「它到底办完了没有」这个问题在普通线程里问不出答案 —— 界面上一条「已完成」,背后可能是
// 模型自己说的,也可能是机器真跑过检查,今天看不出来。本件钉六件事:
//  (a) 不可信来源(模型/loopback body-token)标的 done → 「自报完成」,且 trusted 门照旧:它设不了机器检查;
//  (b) 【核心】一条【用户定义了机器检查】的里程碑被模型标 done、而机器一次没跑过 → 仍然是「自报完成」
//      (checkState='never'),绝不冒充「机器检查」—— 41 号方案 §9 J08 要挡的正是这种谎;
//  (c) 真跑过且通过 → 「机器检查」+ 时间戳;产物随后消失、再跑一次没通过 → 落回「自报完成」并如实
//      带出「最近一次没通过」(既有语义不变:done 不自动回退,但界面不再被这个 done 骗过去);
//  (d) 事项容器里用户亲手勾的那一条 → 「人工复核」,并进同一张清单与 a/b;容器改了不许 304 陈旧;
//  (e) 无账本线程 → ledger:false(界面据此说「未记录验收」,不说 0/0,J15);
//  (f) 静态锁:机器验收的章全仓【一个写入口】、容器验收项的写面【全是 UI token 路由、模型面零处】、
//      前端零处自己推四态(判据只许在服务端那一份)。
// 反向(本件写作时逐条真做过):把 provenance 恒写 'self' → (a)(c)(d) 红;把「机器检查」的判据换回
// 「有 check.type 就算」→ (b) 红;拔掉 ETag 里的容器指纹 → (d) 的条件 GET 拿到 304 → 红;
// 在 13k 里加一处 patchMissionContainer → (f) 单写入口锁红。
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-acceptance-provenance-e2e');
const WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
// 回执要带 headers:(d) 那条「容器改了不许 304」只能看状态码与 ETag。
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { if (resp.statusCode === 304) return resolve({ status: 304, headers: resp.headers, body: null }); try { resolve({ status: resp.statusCode, headers: resp.headers, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function sendJson(port, method, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
const postJson = (port, p, payload, headers) => sendJson(port, 'POST', p, payload, headers);
const patchJson = (port, p, payload, headers) => sendJson(port, 'PATCH', p, payload, headers);
function killp(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* ignore */ } } }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 6, version: '1.0.0', permissionMode: 'bypass' }, null, 2));
  const deliverable = path.join(HOME, 'deliverable.md');
  fs.writeFileSync(deliverable, '# 交付物\n');
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(wb);
  const H = token => ({ 'x-wcw-token': token });
  const itemById = (snapshot, id) => (((snapshot || {}).acceptance || {}).items || []).find(row => row && row.id === id) || {};

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    const created = await postJson(WB_PORT, '/api/sessions', { title: '124-P1 验收四态', cwd: HOME });
    const sid = created.body.session && created.body.session.id;
    ok(!!sid, 'session created');

    // 用户(UI header token = trusted)立账本:m1 没有机器检查,m2 有 file_exists。
    const start = await postJson(WB_PORT, '/api/mission', {
      sessionId: sid, action: 'start',
      mission: { goal: '把交付物做出来', milestones: [
        { id: 'm1', desc: '结论写清楚' },
        { id: 'm2', desc: '交付物真的在', check: { type: 'file_exists', path: 'deliverable.md' } },
      ] },
    }, H(token));
    ok(start.body.ok === true, 'mission start ok');

    const det0 = await getJson(WB_PORT, '/api/missions/' + sid, H(token));
    const acc0 = (det0.body.snapshot || {}).acceptance || {};
    ok(acc0.ledger === true, '(前置) 有账本 → ledger=true(实 ' + acc0.ledger + ')');
    ok(itemById(det0.body.snapshot, 'm2').checkType === 'file_exists', '(前置) 用户设的 file_exists 检查在(实 ' + itemById(det0.body.snapshot, 'm2').checkType + ')');
    ok(itemById(det0.body.snapshot, 'm1').provenance === 'open' && itemById(det0.body.snapshot, 'm2').provenance === 'open',
      '(前置) 还没完成的两条都是 open,没有来源牌子');
    ok(itemById(det0.body.snapshot, 'm2').checkState === 'never', '(前置) 有检查但一次没跑过 → checkState=never(实 ' + itemById(det0.body.snapshot, 'm2').checkState + ')');

    // ============ (a) 不可信来源标 done = 自报完成;trusted 门照旧挡住机器检查 ============
    // 刻意不带 header token:这条就是模型经 MCP 子进程 loopback 的那条路(body-token,不可信)。
    const untrusted = await postJson(WB_PORT, '/api/mission', {
      token, sessionId: sid, action: 'update',
      patch: { milestones: [
        { id: 'm1', status: 'done', evidence: '我做完了', check: { type: 'command', cmd: 'echo 我说的算' } },
        { id: 'm2', status: 'done', evidence: '交付物我放好了' },
      ] },
    });
    ok(untrusted.body.ok === true, '(a) 不可信来源的 mission_update 照旧收下(它有权自报进度)');
    const det1 = await getJson(WB_PORT, '/api/missions/' + sid, H(token));
    const m1a = itemById(det1.body.snapshot, 'm1'), m2a = itemById(det1.body.snapshot, 'm2');
    ok(m1a.checkType === 'none', '(a) trusted 门反向:不可信来源带 check.cmd 来,仍然是 none(实 ' + m1a.checkType + ')');
    ok(m1a.status === 'done' && m1a.provenance === 'self', '(a) 模型标的 done → 自报完成(实 ' + m1a.provenance + ')');

    // ============ (b) 核心:有机器检查 ≠ 跑过机器检查 ============
    ok(m2a.status === 'done' && m2a.provenance === 'self' && m2a.checkState === 'never',
      '(b) 有机器检查却一次没跑过、被模型标 done → 仍是「自报完成」,不冒充机器检查(实 ' + m2a.provenance + '/' + m2a.checkState + ')');
    ok(!m2a.checkedAt, '(b) 没跑过就没有时间戳(实 ' + JSON.stringify(m2a.checkedAt) + ')');

    // ============ (c) 真跑过 → 机器检查;产物随后消失 → 落回自报完成并说实话 ============
    const check1 = await postJson(WB_PORT, '/api/mission', { sessionId: sid, action: 'check' }, H(token));
    ok(check1.body.ok === true, '(c) action:check 跑完');
    const det2 = await getJson(WB_PORT, '/api/missions/' + sid, H(token));
    const m2b = itemById(det2.body.snapshot, 'm2');
    ok(m2b.provenance === 'machine' && m2b.checkState === 'pass', '(c) 机器真跑过且通过 → 机器检查(实 ' + m2b.provenance + '/' + m2b.checkState + ')');
    ok(!!m2b.checkedAt, '(c) 机器检查带最近一次时间(实 ' + JSON.stringify(m2b.checkedAt) + ')');
    ok(itemById(det2.body.snapshot, 'm1').provenance === 'self', '(c) 没有机器检查的那条不受影响,仍是自报完成');
    const byProv = (det2.body.snapshot.acceptance || {}).byProvenance || {};
    ok(byProv.machine === 1 && byProv.self === 1, '(c) byProvenance 计数 machine=1/self=1(实 ' + JSON.stringify(byProv) + ')');

    fs.rmSync(deliverable, { force: true });   // J08 的处境:产物生成过,随后没了
    const check2 = await postJson(WB_PORT, '/api/mission', { sessionId: sid, action: 'check' }, H(token));
    ok(check2.body.ok === true, '(c) 产物消失后再跑一次 check');
    const det3 = await getJson(WB_PORT, '/api/missions/' + sid, H(token));
    const m2c = itemById(det3.body.snapshot, 'm2');
    ok(m2c.status === 'done', '(c) 既有语义不变:机器没通过【不】自动把 done 退回去(实 ' + m2c.status + ')');
    ok(m2c.checkState === 'fail' && m2c.provenance === 'self',
      '(c) 但界面不再被这个 done 骗:最近一次没通过 → 落回自报完成并标 fail(实 ' + m2c.provenance + '/' + m2c.checkState + ')');
    ok(/不存在/.test(String(m2c.checkDetail || '')), '(c) 带出机器给的实情(实 ' + JSON.stringify(m2c.checkDetail) + ')');

    // ============ (d) 事项容器:人工复核 + 容器改了不许 304 ============
    const containerRes = await postJson(WB_PORT, '/api/missions', { title: '交付贯通' }, H(token));
    const mid = containerRes.body.mission && containerRes.body.mission.missionId;
    ok(!!mid, '(d) 事项容器建起来了');
    const attach = await postJson(WB_PORT, '/api/missions/' + mid + '/threads', { action: 'attach', sessionId: sid }, H(token));
    ok(attach.body.ok === true, '(d) 线程挂进事项');
    // 投影索引跟上之后再取 ETag —— 否则那一拍的指纹里本来就没有容器,(d) 的条件 GET 会验错东西。
    let grouped = false;
    for (let i = 0; i < 40 && !grouped; i++) {
      const list = await getJson(WB_PORT, '/api/missions', H(token));
      grouped = (list.body.missions || []).some(row => row && row.sessionId === sid && row.missionId === mid);
      if (!grouped) await sleep(150);
    }
    ok(grouped, '(d) 列表投影已把线程归到事项下');
    const det4 = await getJson(WB_PORT, '/api/missions/' + sid, H(token));
    const etag = det4.headers && det4.headers.etag;
    ok(!!etag, '(d) 详情带 ETag(实 ' + JSON.stringify(etag) + ')');
    ok(((det4.body.snapshot.acceptance || {}).container || {}).total === 0, '(d) 容器还没有验收项时如实是 0 条');
    const patched = await patchJson(WB_PORT, '/api/missions/' + mid, { acceptance: [{ text: '我自己看过一遍', done: true }] }, H(token));
    ok(patched.body.ok === true, '(d) 用户经唯一写入口勾了一条容器验收项');
    const det5 = await getJson(WB_PORT, '/api/missions/' + sid, { ...H(token), 'if-none-match': etag });
    ok(det5.status === 200, '(d) 容器改了,带 If-None-Match 来【不】拿到 304(ETag 含容器指纹;实 ' + det5.status + ')');
    const accd = (det5.body.snapshot || {}).acceptance || {};
    const human = ((accd.container || {}).items || [])[0] || {};
    ok(human.provenance === 'human' && human.done === true, '(d) 容器里用户勾的那条 → 人工复核(实 ' + human.provenance + ')');
    ok(accd.merged && accd.merged.total === 2 && accd.merged.done === 2,
      '(d) 有账本时 a/b 数的是账本那两条 —— 事项级验收项属于整个事项,挂到每条线程上会把同一份账印几遍(实 ' + JSON.stringify(accd.merged) + ')');
    ok((accd.byProvenance || {}).human === 1, '(d) byProvenance 认得人工复核那一档(实 ' + JSON.stringify(accd.byProvenance) + ')');

    // ============ (d2) 人工复核是【接】出来的:逐字同文 + 用户勾过 → 里程碑那一条也认 ============
    const patched2 = await patchJson(WB_PORT, '/api/missions/' + mid, {
      acceptance: [{ text: '我自己看过一遍', done: true }, { text: '结论写清楚', done: true }, { text: '交付物真的在', done: true }],
    }, H(token));
    ok(patched2.body.ok === true, '(d2) 用户又勾了两条与账本逐字同文的验收项');
    const det6 = await getJson(WB_PORT, '/api/missions/' + sid, H(token));
    ok(itemById(det6.body.snapshot, 'm1').provenance === 'human',
      '(d2) 逐字同文且用户勾过 → 那条里程碑自此是「人工复核」,不再是模型的自报(实 ' + itemById(det6.body.snapshot, 'm1').provenance + ')');
    ok(((det6.body.snapshot.acceptance || {}).container || {}).items.filter(row => row.duplicate).length === 2,
      '(d2) 同文那两条标了 duplicate,界面不会把同一句话印两遍');
    // 强弱序:机器的章比人的勾更硬 —— 产物回来、检查再通过一次,牌子回到「机器检查」。
    fs.writeFileSync(deliverable, '# 交付物(回来了)' + String.fromCharCode(10));
    await postJson(WB_PORT, '/api/mission', { sessionId: sid, action: 'check' }, H(token));
    const det7 = await getJson(WB_PORT, '/api/missions/' + sid, H(token));
    const m2d = itemById(det7.body.snapshot, 'm2');
    ok(m2d.provenance === 'machine' && m2d.checkState === 'pass',
      '(d2) machine > human > self:同一条上三样证据都在时,牌子印最硬的那一份(实 ' + m2d.provenance + '/' + m2d.checkState + ')');

    // ============ (e) 无账本线程:ledger=false,不是 0/0 ============
    const plain = await postJson(WB_PORT, '/api/sessions', { title: '随手开的一条', cwd: HOME });
    const plainId = plain.body.session && plain.body.session.id;
    const detPlain = await getJson(WB_PORT, '/api/missions/' + plainId, H(token));
    const accPlain = (detPlain.body.snapshot || {}).acceptance || {};
    ok(accPlain.ledger === false, '(e) 没有账本 → ledger=false(界面据此说「未记录验收」;实 ' + accPlain.ledger + ')');
    ok(accPlain.total === 0 && (accPlain.items || []).length === 0 && accPlain.container === null,
      '(e) 三样都如实为空,不拿别的东西冒充(实 total=' + accPlain.total + ' container=' + JSON.stringify(accPlain.container) + ')');
    // (e2) 没有账本、但挂在事项下的线程(管家开的普通线程就是这个形状):退到事项级验收项 ——
    // 此前这一块只有「暂无」,那是 40 号文 §1 结论 3 说的「问不出答案」。
    await postJson(WB_PORT, '/api/missions/' + mid + '/threads', { action: 'attach', sessionId: plainId }, H(token));
    const detPlain2 = await getJson(WB_PORT, '/api/missions/' + plainId, H(token));
    const accPlain2 = (detPlain2.body.snapshot || {}).acceptance || {};
    ok(accPlain2.ledger === false && accPlain2.container && accPlain2.container.total === 3,
      '(e2) 仍然没有账本,但事项级那三条如实带出来了(实 ledger=' + accPlain2.ledger + ' container=' + JSON.stringify(accPlain2.container && accPlain2.container.total) + ')');
    ok(accPlain2.merged && accPlain2.merged.total === 3 && accPlain2.merged.done === 3,
      '(e2) 没有账本时 a/b 数的就是事项那一套(实 ' + JSON.stringify(accPlain2.merged) + ')');

    // ============ (g) 124 还债①：【列表路由】也得答得出「记过验收没有」============
    // 40 号文 §8.5 ① 登记的那笔。详情路由从 P1 起就有 `ledger`，所以抽屉说得出「未记录验收」；
    // 列表行（GET /api/missions）上只有容器那三个数，于是看板分不清「记过、是空的」与
    // 「压根没人记过」—— `total === 0` 两种情形长得一模一样，只能两者都当没话说。
    // 现在 13d 把两个【组级】事实一起投影下来：
    //   · ledger  —— 组里任一条线程带自己的验收账本；
    //   · tracked —— 这一组是不是一件活（有事项容器，或组里有 mission 线程）。
    // 前端判据仍然只有 thread-facts.acceptanceRecorded 一处，这里只钉「事实投影得对不对」。
    const listRows = async () => {
      const res = await getJson(WB_PORT, '/api/missions', H(token));
      return (res.body && res.body.missions) || [];
    };
    const rowOf = (list, id) => list.find(row => String(row.sessionId || '') === String(id)) || null;
    const gList = await listRows();
    const gMission = rowOf(gList, sid);        // 有账本、挂在事项下的那条
    const gPlain = rowOf(gList, plainId);      // 没账本、也挂在同一个事项下的那条
    ok(Boolean(gMission) && Boolean(gPlain),
      '(g) 两条线程都在列表里（实 mission=' + Boolean(gMission) + ' plain=' + Boolean(gPlain) + '）');
    ok(gMission && gMission.acceptance && gMission.acceptance.ledger === true,
      '(g) 有账本的线程：ledger=true（实 ' + (gMission && gMission.acceptance && gMission.acceptance.ledger) + '）');
    ok(gMission && gMission.acceptance && gMission.acceptance.tracked === true,
      '(g) 挂在事项容器下 → tracked=true（实 ' + (gMission && gMission.acceptance && gMission.acceptance.tracked) + '）');
    // **组级口径**：这两条线程同属一个事项，所以【同组每一行的 ledger/tracked 都一样】——
    // 看板按组取领头那一行的 acceptance（groupRows 里 `acceptance: row.acceptance`），
    // 行与行之间不一致的话，看板会随行序说出不同的话。
    ok(gPlain && gPlain.acceptance && gPlain.acceptance.ledger === true
      && gPlain.acceptance.tracked === true,
      '(g) 同组另一条（自己没账本）拿到的是【同一份组级事实】（实 ledger='
        + (gPlain && gPlain.acceptance && gPlain.acceptance.ledger) + ' tracked='
        + (gPlain && gPlain.acceptance && gPlain.acceptance.tracked) + '）');

    // (g2) 一条谁都不挂的普通会话：没账本、不是一件活 —— 两个门都得关上。
    // 这一条正是「不带 tracked 就会满栏灰字」的那个形状：左栏自 121-K3 之后大半是这种行，
    // 它们聚合态恒落 stopped、也从来没有验收记录。
    const loose = await postJson(WB_PORT, '/api/sessions', { title: '谁都不挂的一条', cwd: HOME });
    const looseId = loose.body.session && loose.body.session.id;
    let gLoose = null;
    for (let i = 0; i < 40 && !gLoose; i++) { gLoose = rowOf(await listRows(), looseId); if (!gLoose) await sleep(100); }
    ok(Boolean(gLoose), '(g2) 那条普通会话进了列表（实 ' + Boolean(gLoose) + '）');
    ok(gLoose && gLoose.acceptance && gLoose.acceptance.ledger === false,
      '(g2) 没账本 → ledger=false（实 ' + (gLoose && gLoose.acceptance && gLoose.acceptance.ledger) + '）');
    ok(gLoose && gLoose.acceptance && gLoose.acceptance.tracked === false,
      '(g2) **不是一件活 → tracked=false** —— 看板据此闭嘴，不对普通聊天会话说「未记录验收」（实 '
        + (gLoose && gLoose.acceptance && gLoose.acceptance.tracked) + '）');
    ok(gLoose && gLoose.acceptance && gLoose.acceptance.total === 0,
      '(g2) 验收项如实为空（实 ' + (gLoose && gLoose.acceptance && gLoose.acceptance.total) + '）');

    // ============ (f) 静态锁 ============
    const readSrc = name => fs.readFileSync(path.join(WB, 'app', 'src', name), 'utf8');
    const readPub = name => fs.readFileSync(path.join(WB, 'app', 'public', 'js', name), 'utf8');
    const srcNames = fs.readdirSync(path.join(WB, 'app', 'src')).filter(name => name.endsWith('.js'));
    // f1:机器验收的章 —— 全仓只有一个地方写得了它。
    const stampWriters = srcNames.filter(name => /\.lastCheck\s*=/.test(readSrc(name)));
    ok(stampWriters.length === 1 && stampWriters[0] === '02-session-store.js',
      'f1 机器验收的章只有一处写入口(实 ' + JSON.stringify(stampWriters) + ')');
    ok((readSrc('02-session-store.js').match(/milestone\.lastCheck = /g) || []).length === 1
      && /function recordMissionCheckResult\(/.test(readSrc('02-session-store.js')),
      'f1 那一处就是 recordMissionCheckResult(不许有第二条赋值)');
    // f2:落章的调用点恰两处,都是真的跑了检查那两条路。
    const stampCallers = srcNames.filter(name => name !== '02-session-store.js' && /recordMissionCheckResult\(/.test(readSrc(name)));
    ok(stampCallers.length === 2 && stampCallers.includes('06e-mission-domain.js') && stampCallers.includes('13-http-router.js'),
      'f2 落章的调用点恰两处:驱动器每轮 + action:check(实 ' + JSON.stringify(stampCallers) + ')');
    for (const name of stampCallers) {
      ok(/evaluateMissionCheck\([\s\S]{0,400}?recordMissionCheckResult\(/.test(readSrc(name)),
        'f2 ' + name + ' 的章紧跟着真跑过的那次 evaluateMissionCheck(不是凭空落章)');
    }
    // f3:容器验收项的写面 —— 规范器只在 02,HTTP 侧三条路由全是 UI header token,模型工具面零处。
    const acceptanceWriters = srcNames.filter(name => /normalizeMissionAcceptance\(/.test(readSrc(name)));
    ok(acceptanceWriters.length === 1 && acceptanceWriters[0] === '02-session-store.js',
      'f3 容器验收项的规范器只在 02(实 ' + JSON.stringify(acceptanceWriters) + ')');
    const src13d = readSrc('13d-core-domain-routes.js');
    for (const fn of ['createMissionContainer', 'patchMissionContainer', 'missionMergeInto']) {
      const at = src13d.indexOf('await ' + fn + '(');
      ok(at > 0 && /tokenOk\(req\)/.test(src13d.slice(Math.max(0, at - 700), at)),
        'f3 ' + fn + ' 的 HTTP 入口就在它前面那道 tokenOk(UI header token)门后');
    }
    const toolFacing = ['09-workflow.js', '11-native-tools.js', '12-tool-dispatch.js', '13f-native-tool-schemas.js',
      '13j-steward-tool-base.js', '13k-steward-threads.js', '13l-steward-ops.js', '13t-steward-schedule.js'];
    const leaked = toolFacing.filter(name => /(createMissionContainer|patchMissionContainer|missionMergeInto)\(/.test(readSrc(name)));
    ok(leaked.length === 0, 'f3 模型工具面零处写容器验收项(实 ' + JSON.stringify(leaked) + ')');
    // f4:四态的判据只许有一份 —— 前端不许自己按 checkType 推。
    const facts = readPub('thread-facts.js'), drawer = readPub('steward-drawer.js');
    ok(/function buildMissionAcceptanceProjection\(/.test(readSrc('02-session-store.js')),
      'f4 四态判据的正身在服务端 02');
    ok(!/checkType\s*[!=]==?\s*'(command|file_exists)'/.test(facts) && !/checkType\s*[!=]==?\s*'(command|file_exists)'/.test(drawer),
      'f4 前端零处按 checkType 自己推来源(推导只许在服务端那一份)');
    ok(/acceptanceRecorded/.test(facts) && (drawer.match(/acceptanceUnrecorded/g) || []).length === 2,
      'f4 「未记录验收」两处都在(干到哪那一行 + 空清单),判据取 acceptanceRecorded');
    // f5:四份 locale 逐字齐备。
    const locales = [
      path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), path.resolve(__dirname, '..', 'docs', 'i18n', 'locales', 'zh-CN.json'),
      path.join(WB, 'app', 'public', 'locales', 'en-US.json'), path.resolve(__dirname, '..', 'docs', 'i18n', 'locales', 'en-US.json'),
    ].map(file => JSON.parse(fs.readFileSync(file, 'utf8')));
    const keys = ['acceptanceUnrecorded', 'provenanceMachine', 'provenanceHuman', 'provenanceSelf',
      'provenanceSelfCheckNever', 'provenanceSelfCheckFailed', 'provenanceCheckedAt'].map(k => 'stewardShell.drawer.' + k);
    ok(keys.every(key => locales.every(pack => typeof pack[key] === 'string' && pack[key].trim())),
      'f5 七条新键四份 locale 齐备');
    ok(keys.every(key => locales[0][key] === locales[1][key] && locales[2][key] === locales[3][key]),
      'f5 app 与 docs 两份逐字一致');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nACCEPTANCE PROVENANCE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
