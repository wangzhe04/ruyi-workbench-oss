(async () => {
'use strict';
// E2E(第 116 波 116g · 27 号文 §3.1「事项跨会话升格」):事项容器、反向索引、四个归属操作与聚合状态。
// 真服务(node app/server.js serve),全程只经既有 HTTP 路径造事实;不 monkey-patch 服务端。
//
// 覆盖:
//  (A) 存量零迁移:没有事项文件的会话在 GET /api/missions 里以 derived:true 出现,aggregateState 与
//      它自己那条线程的五态一致(用产物导出的 stewardThreadStateFromCard + aggregateMissionState 在
//      测试进程内独立算一遍对账),且读一遍列表前后会话头文件的 sha256 逐字节不变。
//  (B) 建事项 -> attach 两条线程:事项文件的 sessionIds 与两个会话头的 missionId 完全一致;
//      列表行 threadCount=2 / derived=false / acceptance / budget 到位;attach 幂等;detach 回未归类。
//  (C) 聚合状态真值表(直接调导出的纯函数,与 unit 件同一口径,e2e 侧再钉一次)。
//  (D) merge 幂等:两次合并结果逐字段一致(除 updatedAt)、from 归档、验收项按文本去重。
//  (E) split 幂等:同一组 sessionIds + 同标题第二次调用返回同一个事项,不再建第二个空壳。
//  (F) PATCH 勾选验收项 -> 列表行 acceptance.done 变化;验收项 id 跨 PATCH 稳定。
//  (G) 归属变更落 Mission Change('mission_membership');删线程时反向索引同步摘除。
//  (H) 容量上限:事项文件数达上限后新建返回稳定信封 capacity_exceeded(409)。
//  (I) 事项文件损坏 -> 整份隔离成 .corrupt,该 missionId 退化成按会话头派生的未归类事项(线程不丢)。
//  (J) 管家会话不可 attach(400 invalid_target)。
//
// 端口:getFreePort() 动态取(run-all 端口审计口径)。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-mission-threads-e2e');
const WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// 纯函数对账用:在【测试进程】里独立 require 一份产物(自己的临时数据根,绝不碰被测服务的 HOME)。
// 这样 aggregateState 的期望值来自「五态判据 + 聚合纯函数」两个导出件,而不是把服务端答案抄一遍。
const PURE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wcw-mission-threads-pure-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = PURE_HOME;
const srv = require(path.join(WB, 'app', 'server.js'));
const { aggregateMissionState, stewardThreadStateFromCard } = srv;

function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
async function waitToken() { // 117q:预算 60×100ms=6s 小于本机冷启动实测 4.6-6.3s,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) { const t = readToken(); if (t) return t; await sleep(100); } return ''; }

function request(method, pathname, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: pathname, method, headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
      ...(extraHeaders || {}),
    } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
const get = (p, token) => request('GET', p, null, token);
const post = (p, body, token, extra) => request('POST', p, body == null ? {} : body, token, extra);

async function waitHealth() { // 117q:预算 80×100ms=8s 小于本机冷启动实测 4.6-6.3s 且余量过窄,是「FAIL workbench up」假红的根(30 号文 P1-31)
  for (let i = 0; i < 300; i++) {
    const r = await get('/health').catch(() => null);
    if (r && r.status === 200) return true;
    await sleep(100);
  }
  return false;
}

function writeConfig() {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, engineMode: 'interactive', permissionMode: 'default',
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [],
    providers: [], activeProvider: '',
  }), 'utf8');
}
function spawnWb() {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true,
  });
  child.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  return child;
}

const headFile = sid => path.join(HOME, 'sessions', sid + '.json');
const readHead = sid => JSON.parse(fs.readFileSync(headFile(sid), 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const missionsDir = () => path.join(HOME, 'missions');
const missionFile = id => path.join(missionsDir(), id + '.json');
const readMissionFile = id => JSON.parse(fs.readFileSync(missionFile(id), 'utf8'));
const changesFile = sid => path.join(HOME, 'sessions', sid + '.changes.ndjson');
function readChanges(sid) {
  try {
    return fs.readFileSync(changesFile(sid), 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
const stripVolatile = m => { const c = JSON.parse(JSON.stringify(m)); delete c.updatedAt; return c; };

async function newMissionSession(title, token) {
  const created = await post('/api/sessions', { title, cwd: HOME }, token);
  const sid = created.json && created.json.session && created.json.session.id;
  // mission start 把 kind 翻成 'mission'(投影只收录 mission 会话;这是既有的显式动作,不是启发式)。
  await post('/api/mission', { sessionId: sid, action: 'start', mission: { goal: title + ' 目标', milestones: [{ id: 'm1', desc: '第一步' }] } }, token);
  return sid;
}
async function missionRows(token) {
  const r = await get('/api/missions', token);
  return { status: r.status, rows: (r.json && r.json.missions) || [] };
}
const rowOf = (rows, sid) => rows.find(m => m.sessionId === sid) || null;

readServerSource(); // 顺带验证 src/ 与产物新鲜度
fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
writeConfig();
let wb = null;

try {
  wb = spawnWb();
  ok(await waitHealth(), '(A) workbench up on :' + WB_PORT);
  const token = await waitToken();
  ok(!!token, '(A) runtime token 可读');

  /* ═════════════ (A) 存量零迁移:未归类事项按会话头派生 ═════════════ */

  const s1 = await newMissionSession('线程一', token);
  const s2 = await newMissionSession('线程二', token);
  ok(!!s1 && !!s2, '(A) 两条 mission 线程已建');
  ok(!fs.existsSync(missionsDir()), '(A) 没建过事项:<data>/missions 目录一个字节都不写');

  const shaBefore = { [s1]: sha(headFile(s1)), [s2]: sha(headFile(s2)) };
  const list0 = await missionRows(token);
  ok(list0.status === 200 && list0.rows.length >= 2, '(A) GET /api/missions 200 且收录两条线程');
  const row1 = rowOf(list0.rows, s1);
  ok(!!row1 && row1.derived === true, '(A) 无事项文件 -> derived:true(未归类,不落盘)');
  ok(row1 && row1.threadCount === 1, '(A) 未归类事项只有它自己一条线程(threadCount=1;实 ' + (row1 && row1.threadCount) + ')');
  ok(row1 && row1.missionId === s1, '(A) 未归类事项的 missionId === sessionId(75a 语义不变)');
  ok(row1 && row1.acceptance && row1.acceptance.total === 0 && row1.acceptance.done === 0, '(A) 未归类事项无事项级验收项');
  // 117h 第 0 步(只加三个字段):无容器时事项标题就是这条线程自己的标题,目标与验收项如实为空。
  ok(row1 && row1.missionTitle === row1.title,
    '(A) 117h-0:无容器 -> missionTitle === 本行标题(实 ' + JSON.stringify(row1 && row1.missionTitle) + ')');
  ok(row1 && row1.goal === '' && Array.isArray(row1.acceptanceItems) && row1.acceptanceItems.length === 0,
    '(A) 117h-0:无容器 -> goal 空串、acceptanceItems 空数组(不猜、不拿线程摘要冒充)');
  {
    // 独立对账:aggregateState 必须 === aggregateMissionState([该行卡片的五态])。
    const expected = aggregateMissionState([stewardThreadStateFromCard(row1).state]);
    ok(row1 && row1.aggregateState === expected,
      `(A) 单线程事项的聚合态 === 该线程五态(期望 ${expected},实 ${row1 && row1.aggregateState})`);
  }
  ok(sha(headFile(s1)) === shaBefore[s1] && sha(headFile(s2)) === shaBefore[s2],
    '(A) 读一遍列表:会话头文件 sha256 逐字节不变(零迁移、零回写)');

  /* ═════════════ (B) 建事项 / attach / 反向索引 / detach / 幂等 ═════════════ */

  const createRes = await post('/api/missions', {
    title: '跨会话事项', goal: '把两条线合成一件事',
    acceptance: [{ text: '验收项甲' }, { text: '验收项乙' }],
    budget: { maxCost: 5, currency: 'usd' }, cwd: HOME,
  }, token);
  ok(createRes.status === 201 && createRes.json && createRes.json.ok === true, '(B) POST /api/missions -> 201(实 ' + createRes.status + ')');
  const m1 = createRes.json && createRes.json.mission && createRes.json.mission.missionId;
  ok(!!m1 && fs.existsSync(missionFile(m1)), '(B) 事项文件落在 <data>/missions/<missionId>.json');
  ok(createRes.json.mission.schema === 1 && createRes.json.mission.sessionIds.length === 0,
    '(B) 新事项 schema=1 且反向索引为空(建事项不建会话)');
  ok(createRes.json.mission.budget && createRes.json.mission.budget.maxCost === 5 && createRes.json.mission.budget.currency === 'USD',
    '(B) 预算归一(币种大写)');
  const accIds = createRes.json.mission.acceptance.map(a => a.id);
  ok(accIds.length === 2 && accIds.every(Boolean) && new Set(accIds).size === 2, '(B) 验收项 id 稳定且唯一');

  ok((await post('/api/missions', { title: '无 token' }, '')).status === 403, '(B) POST /api/missions 无 token -> 403');
  ok((await post('/api/missions', {}, token)).status === 400, '(B) 缺 title -> 400 invalid_request');

  const at1 = await post(`/api/missions/${m1}/threads`, { sessionId: s1, action: 'attach' }, token);
  const at2 = await post(`/api/missions/${m1}/threads`, { sessionId: s2, action: 'attach' }, token);
  ok(at1.status === 200 && at1.json.ok === true && at1.json.changed === true, '(B) attach 线程一 -> 200 changed:true');
  ok(at2.status === 200 && at2.json.ok === true, '(B) attach 线程二 -> 200');
  ok(readHead(s1).missionId === m1 && readHead(s2).missionId === m1, '(B) 两个会话头的 missionId 都指向事项');
  {
    const file = readMissionFile(m1);
    ok(file.sessionIds.length === 2 && file.sessionIds.includes(s1) && file.sessionIds.includes(s2),
      '(B) 反向索引与会话头一致(sessionIds=[s1,s2];实 ' + JSON.stringify(file.sessionIds) + ')');
  }
  {
    const rows = (await missionRows(token)).rows;
    const r1 = rowOf(rows, s1), r2 = rowOf(rows, s2);
    ok(r1 && r1.missionId === m1 && r1.threadCount === 2 && r1.derived === false, '(B) 列表行 threadCount=2 / derived=false');
    ok(r2 && r2.threadCount === 2 && r2.missionId === m1, '(B) 同事项的另一条线程看到同一份聚合');
    ok(r1 && r1.acceptance.total === 2 && r1.acceptance.done === 0, '(B) 列表行带事项级验收进度 0/2');
    // 117h 第 0 步:有容器时三个新字段直出容器的 title / goal / acceptance 整表(看板按事项分组要它们;
    // 117d 抽屉此前只能按确定性顺序回落到线程标题,见 27 号文 §11.6 117d 拍板①)。
    ok(r1 && r1.missionTitle === '跨会话事项' && r2 && r2.missionTitle === '跨会话事项',
      '(B) 117h-0:同事项的两条线程 missionTitle 都是容器标题(实 ' + JSON.stringify(r1 && r1.missionTitle) + ')');
    ok(r1 && r1.goal === '把两条线合成一件事', '(B) 117h-0:goal 直出容器目标');
    ok(r1 && Array.isArray(r1.acceptanceItems) && r1.acceptanceItems.length === 2
      && r1.acceptanceItems.map(item => item.text).join(',') === '验收项甲,验收项乙'
      && r1.acceptanceItems.every(item => item.id && item.done === false),
      '(B) 117h-0:acceptanceItems 是容器验收项整表(带 id 与 done;实 ' + JSON.stringify(r1 && r1.acceptanceItems) + ')');
    ok(r1 && r1.budget && r1.budget.maxCost === 5, '(B) 列表行带事项级预算');
    ok(r1 && r1.cost && typeof r1.cost.costsByCurrency === 'object', '(B) 列表行带按 sessionIds 汇总的费用桶');
    ok(r1 && r1.aggregateState === aggregateMissionState([stewardThreadStateFromCard(r1).state, stewardThreadStateFromCard(r2).state]),
      '(B) 两线程事项的聚合态 === aggregateMissionState(两条五态)');
    // 既有字段一个不少(70 波投影契约:只加不改)。
    ok(r1 && r1.sessionId && r1.mission && typeof r1.status === 'string' && typeof r1.runCount === 'number' && r1.pending,
      '(B) 既有卡片字段(sessionId/mission/status/runCount/pending)原样保留');
  }

  const atAgain = await post(`/api/missions/${m1}/threads`, { sessionId: s1, action: 'attach' }, token);
  ok(atAgain.status === 200 && atAgain.json.ok === true && atAgain.json.changed === false, '(B) attach 幂等(第二次 changed:false)');
  ok(readMissionFile(m1).sessionIds.length === 2, '(B) attach 幂等:反向索引不重复登记');

  const det = await post(`/api/missions/${m1}/threads`, { sessionId: s2, action: 'detach' }, token);
  ok(det.status === 200 && det.json.changed === true, '(B) detach -> 200');
  ok(readHead(s2).missionId === s2, '(B) detach 后会话头 missionId 回到自身(未归类)');
  ok(!readMissionFile(m1).sessionIds.includes(s2), '(B) detach 后反向索引摘除');
  ok((await post(`/api/missions/${m1}/threads`, { sessionId: s2, action: 'detach' }, token)).json.changed === false, '(B) detach 幂等');
  {
    const rows = (await missionRows(token)).rows;
    ok(rowOf(rows, s2) && rowOf(rows, s2).derived === true && rowOf(rows, s2).threadCount === 1, '(B) 移出后该线程回到未归类事项');
    ok(rowOf(rows, s1) && rowOf(rows, s1).threadCount === 1, '(B) 原事项 threadCount 回到 1');
  }
  await post(`/api/missions/${m1}/threads`, { sessionId: s2, action: 'attach' }, token); // 装回去,后续用例继续用

  ok((await post(`/api/missions/mission_deadbeef/threads`, { sessionId: s1, action: 'attach' }, token)).status === 404,
    '(B) 目标事项不存在 -> 404');
  ok((await post(`/api/missions/${m1}/threads`, { sessionId: 'sess_nope', action: 'attach' }, token)).status === 404,
    '(B) 线程不存在 -> 404 session_not_found');
  ok((await post(`/api/missions/${m1}/threads`, { sessionId: s1, action: 'nope' }, token)).status === 400,
    '(B) 非法 action -> 400');

  /* ═════════════ (C) 聚合状态真值表(纯函数,合成五态直调) ═════════════ */

  ok(aggregateMissionState([]) === 'dispatching', '(C) 空数组 -> dispatching');
  ok(aggregateMissionState(['needs_you', 'done', 'running']) === 'needs_you', '(C) 任一 needs_you -> needs_you');
  ok(aggregateMissionState(['done', 'done']) === 'done', '(C) 全部 done -> done');
  ok(aggregateMissionState(['done', 'running']) === 'running', '(C) 有 running(且非全 done)-> running');
  ok(aggregateMissionState(['done', 'dispatching']) === 'dispatching', '(C) 有 dispatching(无 running)-> dispatching');
  ok(aggregateMissionState(['stopped', 'done']) === 'stopped', '(C) 其余 -> stopped');

  /* ═════════════ (D) merge 幂等 ═════════════ */

  const s3 = await newMissionSession('线程三', token);
  const m2 = (await post('/api/missions', { title: '待并入的事项', acceptance: [{ text: '验收项甲' }, { text: '验收项丙' }] }, token)).json.mission.missionId;
  await post(`/api/missions/${m2}/threads`, { sessionId: s3, action: 'attach' }, token);

  const merge1 = await post(`/api/missions/${m1}/merge`, { from: m2 }, token);
  ok(merge1.status === 200 && merge1.json.ok === true, '(D) merge -> 200');
  ok(readHead(s3).missionId === m1, '(D) from 的线程已搬到目标事项');
  {
    const target = readMissionFile(m1);
    const texts = target.acceptance.map(a => a.text);
    ok(texts.length === 3 && texts.includes('验收项甲') && texts.includes('验收项乙') && texts.includes('验收项丙'),
      '(D) 验收项按文本去重并入(甲只留一条;实 ' + JSON.stringify(texts) + ')');
    ok(target.sessionIds.length === 3, '(D) 目标事项反向索引 3 条线程');
    ok(!!readMissionFile(m2).archivedAt, '(D) from 事项标 archivedAt');
  }
  const snapAfterFirstMerge = stripVolatile(readMissionFile(m1));
  const merge2 = await post(`/api/missions/${m1}/merge`, { from: m2 }, token);
  ok(merge2.status === 200 && merge2.json.ok === true, '(D) 再合一次仍 200');
  ok(JSON.stringify(stripVolatile(readMissionFile(m1))) === JSON.stringify(snapAfterFirstMerge),
    '(D) merge 幂等:第二次零变化(除 updatedAt 外逐字段一致)');
  ok((await post(`/api/missions/${m1}/merge`, { from: m1 }, token)).status === 400, '(D) 自己并自己 -> 400');
  ok((await post(`/api/missions/${m1}/merge`, { from: 'mission_nope' }, token)).status === 404, '(D) from 不存在 -> 404');
  {
    const rows = (await missionRows(token)).rows;
    ok(!rows.some(r => r.missionId === m2), '(D) 归档事项不再出现在默认列表里');
    ok(rowOf(rows, s3) && rowOf(rows, s3).threadCount === 3, '(D) 合并后三条线程同属一个事项');
  }

  /* ═════════════ (E) split 幂等 ═════════════ */

  const split1 = await post(`/api/missions/${m1}/split`, { sessionIds: [s3], title: '拆出来的事项' }, token);
  ok(split1.status === 200 && split1.json.ok === true && split1.json.created === true, '(E) split -> 200 created:true');
  const m3 = split1.json.missionId;
  ok(readHead(s3).missionId === m3 && readMissionFile(m3).sessionIds.includes(s3), '(E) 被拆线程已归入新事项(两侧一致)');
  const split2 = await post(`/api/missions/${m1}/split`, { sessionIds: [s3], title: '拆出来的事项' }, token);
  ok(split2.status === 200 && split2.json.missionId === m3 && split2.json.created === false,
    '(E) split 幂等:同一组 sessionIds + 同标题返回同一个事项,不再建第二个');
  ok(fs.readdirSync(missionsDir()).filter(f => f.endsWith('.json')).length === 3, '(E) 事项文件仍是 3 个(m1/m2/m3)');
  ok((await post(`/api/missions/${m1}/split`, { sessionIds: [], title: 'x' }, token)).status === 400, '(E) 空 sessionIds -> 400');
  ok((await post(`/api/missions/${m1}/split`, { sessionIds: [s3] }, token)).status === 400, '(E) 缺 title -> 400');

  /* ═════════════ (F) PATCH 验收项勾选 ═════════════ */

  const before = readMissionFile(m1);
  const patched = await post(`/api/missions/${m1}`, {
    acceptance: before.acceptance.map((item, i) => (i === 0 ? { ...item, done: true } : item)),
  }, token, { 'x-http-method': 'PATCH' });
  ok(patched.status === 200 && patched.json.ok === true, '(F) PATCH(经 x-http-method 双通道)-> 200');
  ok(patched.json.mission.acceptance[0].done === true && !!patched.json.mission.acceptance[0].doneAt, '(F) 勾选项带 doneAt 时间戳');
  ok(patched.json.mission.acceptance.map(a => a.id).join(',') === before.acceptance.map(a => a.id).join(','),
    '(F) 验收项 id 跨 PATCH 稳定');
  {
    const rows = (await missionRows(token)).rows;
    ok(rowOf(rows, s1) && rowOf(rows, s1).acceptance.done === 1 && rowOf(rows, s1).acceptance.total === 3,
      '(F) 列表行 acceptance.done 随之变化(1/3;实 ' + JSON.stringify(rowOf(rows, s1) && rowOf(rows, s1).acceptance) + ')');
    // 117h 第 0 步:整表也跟着变(ETag 指纹已把容器 title/goal 纳入,勾完不会拿到 304 + 陈旧的整表)。
    const items = rowOf(rows, s1) && rowOf(rows, s1).acceptanceItems;
    ok(Array.isArray(items) && items.length === 3 && items[0].done === true && items[0].doneAt,
      '(F) 117h-0:acceptanceItems 随 PATCH 更新且带 doneAt(实 ' + JSON.stringify(items) + ')');
  }
  const renamed = await request('PATCH', `/api/missions/${m1}`, { title: '改过名的事项' }, token);
  ok(renamed.status === 200 && renamed.json.mission.title === '改过名的事项', '(F) 原生 PATCH 通道同样可用');
  ok(readMissionFile(m1).acceptance.length === 3, '(F) 只改标题不动验收项(只认传进来的字段)');
  ok((await request('PATCH', `/api/missions/mission_nope`, { title: 'x' }, token)).status === 404, '(F) PATCH 不存在的事项 -> 404');
  ok(readHead(s1).mission && readHead(s1).mission.goal === '线程一 目标',
    '(F) 会话内任务账本 head.mission 一个字节都没被事项级操作动过');

  /* ═════════════ (G) 归属变更落 Mission Change ═════════════ */

  const membership = readChanges(s1).filter(r => r.type === 'mission_membership');
  ok(membership.length >= 1, '(G) attach 落了 mission_membership 变更记录(实 ' + membership.length + ' 条)');
  ok(membership[0] && membership[0].detail && membership[0].detail.action === 'attach' && membership[0].detail.missionId === m1,
    '(G) 变更记录带 action 与目标 missionId');
  ok(membership.every(r => Number.isSafeInteger(Number(r.seq)) && Number(r.seq) >= 1), '(G) 变更记录带 seq(收件箱可消费的形态)');

  /* ═════════════ (G2) 删线程 -> 反向索引同步摘除 ═════════════ */

  {
    const doomed = await newMissionSession('待删线程', token);
    const mDel = (await post('/api/missions', { title: '删除对账用事项' }, token)).json.mission.missionId;
    await post(`/api/missions/${mDel}/threads`, { sessionId: doomed, action: 'attach' }, token);
    ok(readMissionFile(mDel).sessionIds.includes(doomed), '(G2) 删除前索引里有它');
    const del = await post(`/api/sessions/${doomed}`, {}, token, { 'x-http-method': 'DELETE' });
    ok(del.status === 200, '(G2) 删会话 -> 200(实 ' + del.status + ')');
    ok(!readMissionFile(mDel).sessionIds.includes(doomed), '(G2) 反向索引同步摘除(权威里不留死 id)');
  }

  /* ═════════════ (H) 容量上限稳定信封 ═════════════ */

  const MAX = srv.MISSION_CONTAINER_MAX_FILES;
  ok(MAX === 2000, '(H) 容量常量 = 2000(实 ' + MAX + ')');
  const filler = [];
  for (let i = fs.readdirSync(missionsDir()).filter(f => f.endsWith('.json')).length; i < MAX; i++) {
    const id = 'mission_fill' + i;
    fs.writeFileSync(missionFile(id), JSON.stringify({ schema: 1, missionId: id, title: 'filler ' + i, sessionIds: [] }), 'utf8');
    filler.push(id);
  }
  const overflow = await post('/api/missions', { title: '第 2001 个事项' }, token);
  const overflowErr = (overflow.json && overflow.json.error) || {};
  ok(overflow.status === 409 && overflow.json && overflow.json.ok === false && overflowErr.code === 'mission.capacity_exceeded',
    '(H) 达上限后新建 -> 409 mission.capacity_exceeded(P2 稳定信封;实 ' + overflow.status + '/' + JSON.stringify(overflowErr.code) + ')');
  ok(overflowErr.params && overflowErr.params.limit === MAX && typeof overflowErr.message === 'string',
    '(H) 信封带 params.limit 与人话 message');
  for (const id of filler) fs.rmSync(missionFile(id), { force: true });
  ok((await post('/api/missions', { title: '腾出位置后又能建' }, token)).status === 201, '(H) 腾出位置后新建恢复');

  /* ═════════════ (I) 事项文件损坏 -> 隔离 + 按会话头派生恢复 ═════════════ */

  const threadsOfM1 = readMissionFile(m1).sessionIds.slice();
  ok(threadsOfM1.length === 2, '(I) 损坏前 m1 有两条线程');
  fs.writeFileSync(missionFile(m1), '{ this is not json', 'utf8');
  {
    const rows = (await missionRows(token)).rows;
    const r = rowOf(rows, threadsOfM1[0]);
    ok(!fs.existsSync(missionFile(m1)) && fs.existsSync(missionFile(m1) + '.corrupt'), '(I) 损坏文件整份隔离成 .corrupt(原件不再被读)');
    ok(r && r.derived === true && r.missionId === m1, '(I) 该 missionId 退化成未归类派生视图(会话头不改写)');
    ok(r && r.threadCount === threadsOfM1.length, '(I) 反向索引从会话头重建,线程一条不丢(实 ' + (r && r.threadCount) + ')');
    ok(r && r.acceptance.total === 0, '(I) 事项级字段随文件一起失去(它们的唯一归属就是那个文件)');
  }

  /* ═════════════ (J) 管家会话不可 attach ═════════════ */

  // 管家会话的固定 id/kind 是冻结常量(06i STEWARD_SESSION_ID);这里直接以会话头夹具造出它,
  // 不必把整套管家开关与回合跑起来 —— 被测的是 attach 的守卫,不是管家本身。
  fs.writeFileSync(headFile(srv.STEWARD_SESSION_ID), JSON.stringify({
    id: srv.STEWARD_SESSION_ID, kind: 'steward', title: srv.STEWARD_SESSION_TITLE, schemaVersion: 2,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [], cwd: HOME,
  }, null, 2), 'utf8');
  const m4 = (await post('/api/missions', { title: '守卫用事项' }, token)).json.mission.missionId;
  const stewardAttach = await post(`/api/missions/${m4}/threads`, { sessionId: srv.STEWARD_SESSION_ID, action: 'attach' }, token);
  ok(stewardAttach.status === 400 && stewardAttach.json && stewardAttach.json.error && stewardAttach.json.error.code === 'mission.invalid_target',
    '(J) 管家会话 attach -> 400 mission.invalid_target(实 ' + stewardAttach.status + '/' + JSON.stringify(stewardAttach.json && stewardAttach.json.error && stewardAttach.json.error.code) + ')');
  ok(readMissionFile(m4).sessionIds.length === 0, '(J) 被拒的 attach 没有写进反向索引');
  ok(readHead(srv.STEWARD_SESSION_ID).missionId === undefined, '(J) 管家会话头未被写入 missionId');
} catch (e) {
  fail++; console.log('FAIL 未捕获异常: ' + ((e && e.stack) || e));
} finally {
  kill(wb);
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(PURE_HOME, { recursive: true, force: true });
}

console.log(fail === 0 ? 'MISSION THREADS E2E: ALL PASS' : `MISSION THREADS E2E: ${fail} FAILED`);
process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
