(async () => {
// E2E (第70波 EC-E 首切片): /api/missions 聚合只读投影 + Quick Ask 显式标识 + 旧会话只读派生。
// 覆盖:
//  (a) Quick Ask:新会话显式 kind='quick_ask';详情快照形状齐全;列表不收录纯问答;
//      旧会话(磁盘头文件无 kind 字段)只读派生,绝不回写磁盘(迁移契约:无破坏性批量改写)。
//  (b) mission start → kind 翻转 'mission';列表卡片进度投影;sessionMeta 携带 kind。
//  (c) 一回合(写文件工具)→ 详情快照:变更(filesChanged/revertible)、产物、检查点引用、
//      用量切片(fake 有 usage 帧 → 账本行)、游标(turnSeq)。
//  (d) 验收推进:里程碑 done 后 acceptance 与列表进度同步;全部 done → status 'complete'。
//  (e) 静态锁:ROUTE_AUTH token-browser 条目、handler 挂载、createSession/mission-start kind 写入。
//  (f) 未知 sessionId → 404。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-missions-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function fakeReachable() { return new Promise(resolve => { const net = require('net'); const s = net.connect({ host: '127.0.0.1', port: FAKE_PORT }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.setTimeout(500, () => { s.destroy(); resolve(false); }); }); }
async function waitFakeUp() { for (let i = 0; i < 50; i++) { if (await fakeReachable()) return true; await sleep(100); } return false; }
async function waitFakeDown() { for (let i = 0; i < 50; i++) { if (!await fakeReachable()) return true; await sleep(100); } return false; }
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}
function spawnFake(seq, extraEnv) {
  const env = { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), ...(extraEnv || {}) };
  if (seq) env.FAKE_TOOL_SEQUENCE = JSON.stringify(seq);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env, windowsHide: true });
  fake.stdout.on('data', () => {});
  return fake;
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const artifact = path.join(HOME, 'artifact.md');
  writeConfig(HOME, FAKE_PORT);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(wb);
  const H = token => ({ 'x-wcw-token': token });
  const headFile = id => path.join(HOME, 'sessions', id + '.json');

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    // ============ (a) Quick Ask 显式标识 + 旧会话只读派生 ============
    const ca = await postJson(WB_PORT, '/api/sessions', { title: 'quick ask', cwd: HOME });
    const sidA = ca.body.session && ca.body.session.id;
    ok(!!sidA, '(a) session A created');
    ok(ca.body.session && ca.body.session.kind === 'quick_ask', '(a) 新会话显式 kind=quick_ask(实 ' + (ca.body.session && ca.body.session.kind) + ')');

    const detA0 = await getJson(WB_PORT, '/api/missions/' + sidA, H(token));
    ok(detA0.status === 200 && detA0.body.ok === true, '(a) quick-ask 会话也可读快照(200;实 ' + detA0.status + ')');
    const snapA = detA0.body.snapshot || {};
    ok(snapA.kind === 'quick_ask' && snapA.mission === null, '(a) 快照 kind=quick_ask 且 mission=null(实 ' + snapA.kind + ')');
    ok(snapA.acceptance && Array.isArray(snapA.runs) && snapA.changes && snapA.checkpoints && snapA.usage && snapA.pending && snapA.cursor,
      '(a) 快照形状齐全(acceptance/runs/changes/checkpoints/usage/pending/cursor)');
    ok(snapA.pending && snapA.pending.permissions === 0 && snapA.pending.questions === 0 && snapA.pending.plans === 0 && snapA.pending.pool === 0,
      '(a) 未决计数全 0(权限/提问/计划/任务池)');

    const listA = await getJson(WB_PORT, '/api/missions', H(token));
    ok(listA.status === 200 && Array.isArray(listA.body.missions), '(a) GET /api/missions 列表 200(实 ' + listA.status + ')');
    ok(!(listA.body.missions || []).some(m => m.sessionId === sidA), '(a) 纯问答会话不进任务列表');

    // 旧会话适配:磁盘头文件【删掉 kind 字段】模拟第70波前的存量会话 → 只读派生,磁盘不被回写。
    const headA = JSON.parse(fs.readFileSync(headFile(sidA), 'utf8'));
    delete headA.kind;
    fs.writeFileSync(headFile(sidA), JSON.stringify(headA, null, 2));
    const detLegacy = await getJson(WB_PORT, '/api/missions/' + sidA, H(token));
    ok(detLegacy.body.snapshot && detLegacy.body.snapshot.kind === 'quick_ask', '(a) 无 kind 旧会话只读派生 quick_ask');
    const headAfter = JSON.parse(fs.readFileSync(headFile(sidA), 'utf8'));
    ok(!('kind' in headAfter), '(a) 读模型绝不回写磁盘(迁移契约:无破坏性改写;实 kind 键存在=' + ('kind' in headAfter) + ')');

    // ============ (b) mission start → kind 翻转 + 列表卡片 ============
    const cb = await postJson(WB_PORT, '/api/sessions', { title: 'real mission', cwd: HOME });
    const sidB = cb.body.session && cb.body.session.id;
    ok(!!sidB, '(b) session B created');
    const ms = await postJson(WB_PORT, '/api/mission', {
      sessionId: sidB, action: 'start',
      mission: { goal: '第70波投影验证任务', milestones: [{ id: 'm1', desc: '第一步' }, { id: 'm2', desc: '第二步' }] },
    }, H(token));
    ok(ms.body.ok === true, '(b) mission start ok');
    const detB0 = await getJson(WB_PORT, '/api/missions/' + sidB, H(token));
    ok(detB0.body.snapshot && detB0.body.snapshot.kind === 'mission', '(b) start 后 kind=mission(显式动作标识,非启发式)');
    ok(detB0.body.snapshot.acceptance && detB0.body.snapshot.acceptance.total === 2 && detB0.body.snapshot.acceptance.done === 0,
      '(b) acceptance 投影 total=2 done=0(实 ' + JSON.stringify(detB0.body.snapshot.acceptance && { t: detB0.body.snapshot.acceptance.total, d: detB0.body.snapshot.acceptance.done }) + ')');
    ok(detB0.body.snapshot.status === 'idle', '(b) autoMode=off 且未完成 → status=idle(实 ' + detB0.body.snapshot.status + ')');

    const listB = await getJson(WB_PORT, '/api/missions', H(token));
    const cardB = (listB.body.missions || []).find(m => m.sessionId === sidB);
    ok(!!cardB, '(b) 任务列表收录 B');
    ok(cardB && cardB.mission && cardB.mission.milestonesTotal === 2 && cardB.mission.done === 0 && cardB.mission.goal === '第70波投影验证任务',
      '(b) 列表卡片投影 goal/进度(实 ' + JSON.stringify(cardB && cardB.mission && { t: cardB.mission.milestonesTotal, d: cardB.mission.done }) + ')');
    const sessList = await getJson(WB_PORT, '/api/sessions', H(token));
    const metaB = (sessList.body.sessions || []).find(s => s.id === sidB);
    ok(metaB && metaB.kind === 'mission', '(b) sessionMeta 携带 kind(侧栏/索引同源;实 ' + (metaB && metaB.kind) + ')');

    // 旧会话带 mission 但无 kind → 派生 'mission' 且不回写。
    const headB = JSON.parse(fs.readFileSync(headFile(sidB), 'utf8'));
    ok(headB.kind === 'mission', '(b) start 已把 kind 持久化进头文件(显式标识落盘)');
    delete headB.kind;
    fs.writeFileSync(headFile(sidB), JSON.stringify(headB, null, 2));
    const detBLegacy = await getJson(WB_PORT, '/api/missions/' + sidB, H(token));
    ok(detBLegacy.body.snapshot && detBLegacy.body.snapshot.kind === 'mission', '(b) 有 mission 的无 kind 旧会话派生 mission');
    ok(!('kind' in JSON.parse(fs.readFileSync(headFile(sidB), 'utf8'))), '(b) 派生同样不回写磁盘');

    // ============ (c) 回合后快照:变更/产物/检查点/用量/游标 ============
    const f1 = spawnFake([{ name: 'file_write', args: { path: artifact, content: '# mission artifact' } }]); procs.push(f1);
    ok(await waitFakeUp(), '(c) fake up');
    await postStream(WB_PORT, { sessionId: sidB, message: 'write the artifact', cwd: HOME });
    killp(f1); await waitFakeDown();
    ok(fs.existsSync(artifact), '(c) artifact.md written');

    const detB1 = await getJson(WB_PORT, '/api/missions/' + sidB, H(token));
    const snap1 = detB1.body.snapshot || {};
    const fc = (snap1.changes && snap1.changes.filesChanged) || [];
    const hit = fc.find(f => f && f.path === artifact);
    ok(!!hit, '(c) changes.filesChanged 含 artifact.md(实 ' + fc.length + ' 条)');
    ok(hit && hit.revertible === true && hit.op === 'create', '(c) 变更带 revertible/op 标注(不可逆显式可辨;实 ' + JSON.stringify(hit && { r: hit.revertible, op: hit.op }) + ')');
    ok(((snap1.changes && snap1.changes.artifacts) || []).some(a => a && a.path === artifact), '(c) artifacts 含产物引用');
    ok(snap1.checkpoints && Array.isArray(snap1.checkpoints.turnSeqs) && snap1.checkpoints.turnSeqs.includes(1),
      '(c) 检查点引用含 turnSeq=1(实 ' + JSON.stringify(snap1.checkpoints && snap1.checkpoints.turnSeqs) + ')');
    ok(snap1.usage && snap1.usage.turns >= 1, '(c) 用量切片 turns>=1(fake usage 帧 → 账本行;实 ' + (snap1.usage && snap1.usage.turns) + ')');
    ok(snap1.cursor && Number(snap1.cursor.turnSeq) >= 1, '(c) 游标 turnSeq>=1(实 ' + (snap1.cursor && snap1.cursor.turnSeq) + ')');

    // ============ (d) 验收推进 → acceptance / status / 列表进度 ============
    const u1 = await postJson(WB_PORT, '/api/mission', { sessionId: sidB, action: 'update', patch: { milestones: [{ id: 'm1', status: 'done', evidence: 'e2e' }] } }, H(token));
    ok(u1.body.ok === true, '(d) mission update m1 done ok');
    const detB2 = await getJson(WB_PORT, '/api/missions/' + sidB, H(token));
    ok(detB2.body.snapshot.acceptance.done === 1, '(d) acceptance done=1(实 ' + detB2.body.snapshot.acceptance.done + ')');
    const listB2 = await getJson(WB_PORT, '/api/missions', H(token));
    const cardB2 = (listB2.body.missions || []).find(m => m.sessionId === sidB);
    ok(cardB2 && cardB2.mission.done === 1, '(d) 列表进度同步 done=1(实 ' + (cardB2 && cardB2.mission.done) + ')');
    await postJson(WB_PORT, '/api/mission', { sessionId: sidB, action: 'update', patch: { milestones: [{ id: 'm2', status: 'done', evidence: 'e2e' }] } }, H(token));
    const detB3 = await getJson(WB_PORT, '/api/missions/' + sidB, H(token));
    ok(detB3.body.snapshot.acceptance.done === 2 && detB3.body.snapshot.status === 'complete', '(d) 全部 done → status=complete(实 ' + detB3.body.snapshot.status + ')');

    // ============ (f) 未知 sessionId → 404 ============
    const nf = await getJson(WB_PORT, '/api/missions/sess_nonexistent', H(token));
    ok(nf.status === 404, '(f) 未知 sessionId → 404(实 ' + nf.status + ')');

    // ============ (e) 静态锁 ============
    const srcRouter = fs.readFileSync(path.join(WB, 'app', 'src', '13-http-router.js'), 'utf8');
    // 110-2a: ROUTE_AUTH 已搬至 01b-route-auth.js,改为源+目标拼接读取(断言原样保留)。
    const srcConfig = fs.readFileSync(path.join(WB, 'app', 'src', '01-config.js'), 'utf8')
      + fs.readFileSync(path.join(WB, 'app', 'src', '01b-route-auth.js'), 'utf8');
    const src13d = fs.readFileSync(path.join(WB, 'app', 'src', '13d-core-domain-routes.js'), 'utf8');
    const src02 = fs.readFileSync(path.join(WB, 'app', 'src', '02-session-store.js'), 'utf8');
    ok(/\{ m: 'GET', p: '\/api\/missions', auth: 'token-browser' \}/.test(srcConfig), '(e) ROUTE_AUTH /api/missions 标 token-browser');
    ok(/\{ m: 'GET', p: '\/api\/missions\/', auth: 'token-browser', prefix: true \}/.test(srcConfig), '(e) ROUTE_AUTH /api/missions/ 前缀标 token-browser');
    ok(/async function handleMissionsApiRoutes\(/.test(src13d), '(e) handleMissionsApiRoutes 在 13d 核心域路由');
    ok(/await handleMissionsApiRoutes\(req, res, pathname\)/.test(srcRouter), '(e) 路由器挂载 missions 处理器');
    ok(/kind: 'quick_ask'/.test(src02), '(e) createSession 显式写入 kind=quick_ask');
    ok(/function sessionKind\(/.test(src02), '(e) sessionKind 只读派生器在 02');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nMISSIONS READMODEL E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
