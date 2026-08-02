(async () => {
'use strict';
// E2E(第72波 EC-E 切片三):任务结果模型 + 不可逆操作正向账。
// 覆盖:
//  (a) provider 回合内 mission_update 全 done -> maybeFinalizeMission 盖 complete 章(09 接线);
//      同回合 powershell_run 进不可逆账(kind exec + detail),file_read 只读不记账;
//      snapshot.result 全字段(acceptance/unfinished/artifacts/changes/checkpoints/irreversible);
//      changes.commands 是数字(第70波 NaN bug 修复回归)。
//  (b) 再武装:update 加 pending 里程碑 -> 旧 complete 章清理(result=null);
//      stop -> 盖 stopped 章(unfinished 列出未完成里程碑);
//      update 把剩余标 done -> 路由路径盖 complete 章;重复 update 不重复盖章(finishedAt 稳定)。
//  (c) 旧会话诚实标注:第72波前回合(turnSummary 无 irreversible 字段)-> legacyCommands 单列,不混入新账。
//  (s) 静态锁:02 账/结果模型/盖章点,13 stop+update 接线,09 回合内接线,13d 快照字段。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-mission-result-e2e');
const PROVIDER_PORT = await getFreePort(), WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} } }
function readToken() { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { return ''; } }
function requestJson(port, pathname, body, token) {
  return new Promise((resolve, reject) => {
    const raw = body == null ? '' : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: body == null ? 'GET' : 'POST', headers: {
      ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
      ...(token ? { 'x-wcw-token': token } : {}),
    } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); }); });
    req.on('error', reject); if (raw) req.write(raw); req.end();
  });
}
async function waitHealth(port) { for (let i = 0; i < 60; i++) { const r = await requestJson(port, '/health', null).catch(() => null); if (r && r.status === 200) return true; await sleep(100); } return false; }

function sse(res, obj) { res.write('data: ' + JSON.stringify(obj) + '\n\n'); }
function emitToolCall(res, id, callId, name, argsObj) {
  const args = JSON.stringify(argsObj);
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function emitText(res, id, text) {
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  res.write('data: [DONE]\n\n'); res.end();
}
function startProvider() {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health' || (req.url || '').includes('/v1/models')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"fake-model"}]}'); }
    if (!(req.url || '').includes('/chat/completions')) { res.writeHead(404); return res.end(); }
    let raw = ''; for await (const chunk of req) raw += chunk;
    let parsed = {}; try { parsed = JSON.parse(raw); } catch {}
    const id = 'chatcmpl-mr';
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    const done = msgs.filter(m => m && m.role === 'tool').length;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    if (done === 0) return emitToolCall(res, id, 'call_m1', 'mission_update', { milestones: [{ id: 'm1', status: 'done', evidence: '第一步完成' }] });
    if (done === 1) return emitToolCall(res, id, 'call_m2', 'mission_update', { milestones: [{ id: 'm2', status: 'done', evidence: '第二步完成' }] });
    if (done === 2) return emitToolCall(res, id, 'call_cmd', 'powershell_run', { command: 'echo seventy-two' });
    if (done === 3) return emitToolCall(res, id, 'call_rd', 'file_read', { path: 'package.json' });
    return emitText(res, id, '全部完成');
  });
  return new Promise(resolve => server.listen(PROVIDER_PORT, '127.0.0.1', () => resolve(server)));
}
function streamChat(body, token) {
  return new Promise((resolve, reject) => {
    const raw = JSON.stringify(body); const events = []; let buf = '';
    const req = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-wcw-token': token } }, res => {
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; try { events.push(JSON.parse(line)); } catch {} } });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.write(raw); req.end();
  });
}
function spawnWb() {
  return cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME }, windowsHide: true });
}

(async () => {
  const src = readServerSource();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'bypass', includeWorkbenchMcp: true,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  }), 'utf8');
  const provider = await startProvider();
  let wb = spawnWb(); wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));

  try {
    ok(await waitHealth(WB_PORT), 'workbench up');
    let token = readToken(); ok(!!token, 'runtime token available');

    // ============ (a) 回合内全 done -> complete 章 + 不可逆账 ============
    const created = await requestJson(WB_PORT, '/api/sessions', { title: 'mission-result-a' }, token);
    const sid = created.json && created.json.session && created.json.session.id;
    ok(!!sid, '(a) 会话已建');
    const started = await requestJson(WB_PORT, '/api/mission', { action: 'start', sessionId: sid, token, mission: { goal: '结果模型测试', milestones: [{ id: 'm1', desc: '第一步' }, { id: 'm2', desc: '第二步' }] } }, token);
    ok(started.status === 200 && started.json && started.json.ok === true, '(a) mission start(trusted)');

    const events = await streamChat({ sessionId: sid, message: '把两个里程碑做掉,跑条命令,再读个文件' }, token);
    const tsEvt = events.find(e => e.type === 'turn_summary');
    const tsIv = (tsEvt && Array.isArray(tsEvt.irreversible)) ? tsEvt.irreversible : [];
    ok(!!tsEvt && Array.isArray(tsEvt.irreversible), '(a) turn_summary 事件带 irreversible 账');
    ok(tsIv.length === 1 && tsIv[0].name === 'powershell_run' && tsIv[0].kind === 'exec' && /seventy-two/.test(tsIv[0].detail), '(a) powershell_run 入账(exec + detail)');
    ok(!tsIv.some(iv => iv.name === 'file_read'), '(a) file_read 只读不记账');

    // 等回合收尾 save 落盘,再读快照
    let snap = null;
    for (let i = 0; i < 60 && !snap; i++) {
      const det = await requestJson(WB_PORT, '/api/missions/' + sid, null, token);
      if (det.json && det.json.snapshot && det.json.snapshot.result && det.json.snapshot.result.status === 'complete') snap = det.json.snapshot;
      else await sleep(150);
    }
    ok(!!snap, '(a) snapshot.result 已盖章(complete)');
    const res = snap && snap.result;
    ok(res && res.how === 'update' && !!res.finishedAt, '(a) 盖章来源 how=update + finishedAt');
    ok(res && res.acceptance && res.acceptance.total === 2 && res.acceptance.done === 2, '(a) 验收状态 2/2 done');
    ok(res && Array.isArray(res.unfinished) && res.unfinished.length === 0, '(a) 未完成项为空');
    ok(res && res.irreversible && res.irreversible.total === 1 && res.irreversible.byKind && res.irreversible.byKind.exec === 1, '(a) 结果内不可逆账 total=1(exec)');
    ok(res && res.checkpoints && typeof res.checkpoints.rollbackAvailable === 'boolean', '(a) 真实回滚能力引用(checkpoints)');
    ok(snap && typeof snap.changes.commands === 'number' && snap.changes.commands === 1, '(a) changes.commands 是数字=1(第70波 NaN bug 修复回归)');
    ok(snap && snap.irreversible && snap.irreversible.total === 1 && snap.irreversible.legacyCommands === 0, '(a) 快照级不可逆账(活投影)total=1 legacy=0');

    // ============ (b) 再武装清章 + stop 盖章 + 路由路径 complete + 不重复盖章 ============
    const rearm = await requestJson(WB_PORT, '/api/mission', { action: 'update', sessionId: sid, token, patch: { milestones: [{ id: 'm3', desc: '追加第三步', status: 'pending' }] } }, token);
    ok(rearm.status === 200 && rearm.json && rearm.json.mission && rearm.json.mission.result == null, '(b) 再武装(加 pending 里程碑)-> 旧 complete 章清理');

    const stopped = await requestJson(WB_PORT, '/api/mission', { action: 'stop', sessionId: sid, token }, token);
    const sres = stopped.json && stopped.json.mission && stopped.json.mission.result;
    ok(!!sres && sres.status === 'stopped' && sres.how === 'stop', '(b) stop -> 盖 stopped 章');
    ok(!!sres && sres.unfinished.some(u => u.id === 'm3' && u.status === 'pending'), '(b) stopped 章列出未完成项(m3 pending)');
    ok(!!sres && sres.acceptance.done === 2 && sres.acceptance.total === 3, '(b) stopped 章验收 2/3');

    const fin = await requestJson(WB_PORT, '/api/mission', { action: 'update', sessionId: sid, token, patch: { milestones: [{ id: 'm3', status: 'done', evidence: '补完' }] } }, token);
    const fres = fin.json && fin.json.mission && fin.json.mission.result;
    ok(!!fres && fres.status === 'complete' && fres.how === 'update', '(b) 剩余标 done -> 路由路径盖 complete 章');
    ok(!!fres && fres.acceptance.done === 3, '(b) complete 章验收 3/3');
    const stamp1 = fres && fres.finishedAt;
    const again = await requestJson(WB_PORT, '/api/mission', { action: 'update', sessionId: sid, token, patch: { milestones: [{ id: 'm3', status: 'done', evidence: '重复更新' }] } }, token);
    ok(again.json && again.json.mission && again.json.mission.result && again.json.mission.result.finishedAt === stamp1, '(b) 重复 update 不重复盖章(finishedAt 稳定)');

    // ============ (c) 旧会话诚实标注(legacyCommands)============
    kill(wb); await sleep(500);
    const headPath = path.join(HOME, 'sessions', sid + '.json');
    const head = JSON.parse(fs.readFileSync(headPath, 'utf8'));
    const legacyMsg = { role: 'assistant', content: '旧回合', ts: new Date().toISOString(), turnSummary: { turnSeq: 0, filesChanged: [], commands: 2, artifacts: [] } }; // 第72波前形状:无 irreversible 字段
    fs.appendFileSync(path.join(HOME, 'sessions', sid + '.messages.ndjson'), JSON.stringify(legacyMsg) + '\n', 'utf8');
    head.messageCount = (Number(head.messageCount) || 0) + 1;
    fs.writeFileSync(headPath, JSON.stringify(head), 'utf8');
    wb = spawnWb(); wb.stderr.on('data', d => String(d).trim() && console.error('[wb2!] ' + String(d).trim()));
    ok(await waitHealth(WB_PORT), '(c) workbench 重启 up');
    token = readToken();
    const det2 = await requestJson(WB_PORT, '/api/missions/' + sid, null, token);
    const iv2 = det2.json && det2.json.snapshot && det2.json.snapshot.irreversible;
    ok(!!iv2 && iv2.legacyCommands === 2, '(c) 旧回合 commands=2 单列 legacyCommands(不混入新账)');
    ok(!!iv2 && iv2.total === 1, '(c) 新账 total 仍为 1(旧计数不污染明细)');
    ok(!!(det2.json.snapshot.result) && det2.json.snapshot.result.status === 'complete' && det2.json.snapshot.result.acceptance.done === 3, '(c) 重启后 complete 章仍在(持久化)');

    // ============ (s) 静态锁 ============
    console.log('\n── [s] 静态锁 ──');
    ok(/IRREVERSIBLE_NATIVE_KIND = \{/.test(src) && /CLAUDE_IRREVERSIBLE_KIND = \{/.test(src), 's 02 不可逆账分类表(内建+claude)');
    ok(/function irreversibleToolKind\(name\)/.test(src) && /irreversible\.push\(\{ kind, name/.test(src), 's 02 buildTurnSummary 记账');
    ok(/return \{ turnSeq: Number\(turnSeq\) \|\| 0, filesChanged, commands, artifacts, irreversible \}/.test(src), 's 02 turnSummary 返回 irreversible');
    ok(/function foldTurnSummaries\(session\)/.test(src) && /legacyCommands/.test(src), 's 02 foldTurnSummaries 单一折叠 + legacyCommands');
    ok(/async function buildMissionResult\(session, opts\)/.test(src) && /rollbackAvailable/.test(src), 's 02 buildMissionResult(含真实回滚引用)');
    ok(/async function maybeFinalizeMission\(session, how\)/.test(src), 's 02 maybeFinalizeMission 盖章/清章');
    ok(/result: \(p\.result && typeof p\.result === 'object'\) \? p\.result : null,/.test(src), 's 02 normalizeMission 深拷携带 result');
    ok(/const result = await missionControlCommand\(sessionId, 'stop'\)/.test(src) && /mission\.result = await buildMissionResult\(session, \{ status: 'stopped', how: 'stop' \}\)/.test(src), 's 13 stop 复用整单控制核心盖 stopped 章');
    ok(/await maybeFinalizeMission\(session, 'check'\)/.test(src) && /await maybeFinalizeMission\(session, 'update'\)/.test(src), 's 13 check/update 接线盖章');
    ok(/Object\.defineProperty\(session, '__missionFinalizeHow'/.test(src) && /if \(session\.__missionFinalizeHow\) \{/.test(src), 's 09 回合内 mission_update 推迟盖章 + 收尾 finalize(含本回合摘要)');
    ok(/if \(onDisk && onDisk\.mission && typeof onDisk\.mission === 'object'\) session\.mission = onDisk\.mission;/.test(src), 's 05 claude 收尾磁盘回读补 mission(loopback 盖章防盖回)');
    ok(/result: \(session\.mission && session\.mission\.result\) \|\| null,/.test(src), 's 13d 快照带 result');
    ok(/const fold = foldTurnSummaries\(session\);/.test(src), 's 13d 折叠走 foldTurnSummaries(NaN bug 修复)');

  } finally {
    kill(wb); await new Promise(r => provider.close(r));
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nMISSION RESULT E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
})();
