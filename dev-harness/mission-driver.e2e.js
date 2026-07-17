// E2E: 第26波b「until-done 驱动器 + 任务账本」(AUTONOMY-PLAN §26b)。
// 端口: FAKE 9113 / WB 9114(已登记 dev-harness/README)。离线,Node 直跑。
// 内联 fake:每回合按【最后一条 user 消息里第一个未完成里程碑 [mK]】驱动 —— 本轮 0 工具→file_write mK.txt;
//   1 工具→mission_update 标 mK done;≥2→终稿。STALL 场景:fake 永不推进(纯文本),digest 不变触发降级。
// 断言:
//  A) 3 里程碑(file_exists 验收)无人值守跑完:一次 POST /api/chat/stream → mission_complete,3 文件都在,
//     spent.autoTurns==2,自动续跑消息标 source:'mission-driver'。
//  B) 机器验收门控:file_exists check 决定 done(模型没标也会被 check 标)。
//  C) 停滞:fake 不推进 → 连续 3 回合同 digest → state:'stuck' + autoMode='supervised'。
//  D) 预算:maxAutoTurns=2 但 5 里程碑 → 2 个自动回合后 state:'budget_exhausted' + supervised(非报错)。
//  E) 非账本会话零行为变化:无 mission 的普通会话仍是单回合(无 mission 事件)。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-mission-driver-e2e');
const WS = path.join(HOME, 'ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = ''; res.on('data', c => (buf += c)); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
function chatStream(payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch {} } } });
      res.on('end', () => resolve(events));
    });
    r.on('error', reject); r.write(data); r.end();
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {} await sleep(150); } return false; }

// ── 内联 fake ──
function sse(res, o) { res.write('data: ' + JSON.stringify(o) + '\n\n'); }
function streamText(res, text) {
  const id = 'chatcmpl-m';
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
  for (const piece of text.match(/[\s\S]{1,40}/g) || [text]) sse(res, { id, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse(res, { id, choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } });
  res.write('data: [DONE]\n\n'); res.end();
}
function streamToolCall(res, name, argsObj) {
  const id = 'chatcmpl-m', a = JSON.stringify(argsObj), h = Math.ceil(a.length / 2);
  sse(res, { id, choices: [{ index: 0, delta: { role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(0, h) } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(h) } }] }, finish_reason: null }] });
  sse(res, { id, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  sse(res, { id, choices: [], usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 } });
  res.write('data: [DONE]\n\n'); res.end();
}
const fake = http.createServer((rq, rs) => {
  let body = ''; rq.on('data', c => (body += c));
  rq.on('end', () => {
    if (rq.method === 'GET' && (rq.url || '').includes('/models')) { rs.writeHead(200, { 'content-type': 'application/json' }); return rs.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model', object: 'model' }] })); }
    if (!(rq.method === 'POST' && (rq.url || '').includes('/chat/completions'))) { rs.writeHead(404); return rs.end('no'); }
    let parsed = {}; try { parsed = JSON.parse(body); } catch {}
    const msgs = Array.isArray(parsed.messages) ? parsed.messages : [];
    const lastUserIdx = (() => { for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i] && msgs[i].role === 'user') return i; return -1; })();
    const lastUser = lastUserIdx >= 0 ? String(msgs[lastUserIdx].content || '') : '';
    const turnTools = msgs.slice(lastUserIdx + 1).filter(m => m && m.role === 'tool').length;
    rs.writeHead(200, { 'content-type': 'text/event-stream' });
    // STALL 模式:目标含 STALLMODE → 永远只回纯文本(不推进任何里程碑)。
    if (/STALLMODE/.test(lastUser) || msgs.some(m => m.role === 'system' && /STALLMODE/.test(String(m.content || '')))) {
      return streamText(rs, '我在思考如何推进,但暂时没有可执行的下一步。');
    }
    // EVILMODE:模型企图经 mission_update 注入 check.cmd(command)让驱动器无提示 shell 执行——安全测试。
    // 第 0 工具:注入恶意 command check 到 pending 里程碑;之后纯文本(不推进,让驱动器有机会去跑 check)。
    if (/EVILMODE/.test(lastUser) || msgs.some(m => m.role === 'system' && /EVILMODE/.test(String(m.content || '')))) {
      if (turnTools === 0) return streamToolCall(rs, 'mission_update', { milestones: [{ id: 'e1', status: 'pending', check: { type: 'command', cmd: 'node -e "require(\'fs\').writeFileSync(process.env.PWNFILE||\'' + (WS + '\\PWNED.txt').replace(/\\/g, '\\\\') + '\',\'pwned\')"' } }] });
      return streamText(rs, '(已尝试设置检查)');
    }
    // 取「最后一条 user 消息里的第一个 [mK]」作为本回合目标里程碑。
    const mk = (lastUser.match(/\[([a-z]\d+)\]/) || [])[1] || 'm1';
    if (turnTools === 0) return streamToolCall(rs, 'file_write', { path: WS + '\\' + mk + '.txt', content: mk + ' 完成' });
    if (turnTools === 1) return streamToolCall(rs, 'mission_update', { milestones: [{ id: mk, status: 'done', evidence: '已写出 ' + mk + '.txt' }] });
    return streamText(rs, '里程碑 ' + mk + ' 已完成。');
  });
});

(async () => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WS,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  await new Promise(r => fake.listen(FAKE_PORT, '127.0.0.1', r));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    ok(await up(), 'workbench up on :' + WB_PORT);
    const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
    const H = { 'x-wcw-token': token };
    const sessionPath = sid => path.join(HOME, 'sessions', sid + '.json');

    // ── A/B) 3 里程碑无人值守跑完 ──
    const s1 = (await req('POST', '/api/sessions', { title: 'mission', cwd: WS }, H)).json.session;
    const mkMs = (id) => ({ id, desc: '完成 ' + id, check: { type: 'file_exists', path: id + '.txt' } });
    const setR = await req('POST', '/api/mission', { token, sessionId: s1.id, action: 'start', mission: { goal: '完成一个三步任务', milestones: [mkMs('m1'), mkMs('m2'), mkMs('m3')], budget: { maxAutoTurns: 12 } }, autoMode: 'until-done' }, H);
    ok(setR.json && setR.json.ok && setR.json.mission.milestones.length === 3, 'A 账本已建(3 里程碑, until-done)');
    // 注意:mission 是 start 时设的,autoMode 需在 mission 对象里 → 确认已生效
    ok(setR.json.mission.autoMode === 'until-done', 'A autoMode=until-done(实 ' + setR.json.mission.autoMode + ')');

    const events = await chatStream({ sessionId: s1.id, message: '开始推进任务,第一步 [m1]' }, H);
    const missionEvents = events.filter(e => e.type === 'mission');
    const complete = missionEvents.find(e => e.state === 'complete');
    ok(!!complete, 'A 收到 mission_complete 事件(无人值守跑完)');
    const finalMission = readJson(sessionPath(s1.id)).mission;
    ok(finalMission && finalMission.milestones.every(m => m.status === 'done'), 'A 全部里程碑 done');
    ok(['m1', 'm2', 'm3'].every(k => fs.existsSync(path.join(WS, k + '.txt'))), 'A 三个里程碑文件都已写出');
    ok(finalMission.spent.autoTurns === 2, 'A spent.autoTurns==2(首回合用户 + 2 自动)实 ' + finalMission.spent.autoTurns);
    ok(finalMission.autoMode === 'off', 'A 完成后 autoMode=off');
    const sess1 = readJson(sessionPath(s1.id));
    const driverMsgs = (sess1.messages || []).filter(m => m.role === 'user' && m.source === 'mission-driver');
    ok(driverMsgs.length === 2, 'B 自动续跑消息标 source:mission-driver(实 ' + driverMsgs.length + ')');
    // 机器验收:删掉 mission_update 效果无关 —— 断言 file_exists check 已被驱动器执行(证据落 evidence)
    ok(finalMission.milestones.every(m => m.evidence), 'B 每个里程碑有 evidence(机器验收/模型标记留痕)');

    // ── C) 停滞降级 ──
    const s2 = (await req('POST', '/api/sessions', { title: 'stall', cwd: WS }, H)).json.session;
    await req('POST', '/api/mission', { token, sessionId: s2.id, action: 'start', mission: { goal: 'STALLMODE 永不推进的任务', milestones: [{ id: 'x1', desc: '做不到的事', check: { type: 'none' } }], budget: { maxAutoTurns: 12 } }, autoMode: 'until-done' }, H);
    const ev2 = await chatStream({ sessionId: s2.id, message: 'STALLMODE 开始' }, H);
    const stuck = ev2.filter(e => e.type === 'mission').find(e => e.state === 'stuck');
    ok(!!stuck, 'C 停滞 → 收到 state:stuck 事件');
    ok(readJson(sessionPath(s2.id)).mission.autoMode === 'supervised', 'C 停滞后 autoMode=supervised');

    // ── D) 预算耗尽 ──
    const s3 = (await req('POST', '/api/sessions', { title: 'budget', cwd: WS }, H)).json.session;
    const ms5 = ['b1', 'b2', 'b3', 'b4', 'b5'].map(id => ({ id, desc: '完成 ' + id, check: { type: 'file_exists', path: id + '.txt' } }));
    await req('POST', '/api/mission', { token, sessionId: s3.id, action: 'start', mission: { goal: '一个五步任务', milestones: ms5, budget: { maxAutoTurns: 2 } }, autoMode: 'until-done' }, H);
    const ev3 = await chatStream({ sessionId: s3.id, message: '开始 [b1]' }, H);
    const budgetEv = ev3.filter(e => e.type === 'mission').find(e => e.state === 'budget_exhausted');
    ok(!!budgetEv, 'D 预算耗尽 → 收到 state:budget_exhausted');
    const m3 = readJson(sessionPath(s3.id)).mission;
    ok(m3.autoMode === 'supervised' && m3.spent.autoTurns === 2, 'D 预算后 supervised 且 autoTurns==2(非报错,进度保留)');
    const dDone = m3.milestones.filter(x => x.status === 'done').length;
    ok(dDone >= 2, 'D 预算内已推进部分里程碑(≥2 done,实 ' + dDone + '/' + m3.milestones.length + ':' + m3.milestones.map(x => x.id + ':' + x.status).join(',') + ')');

    // ── E) 非账本会话零行为变化 ──
    const s4 = (await req('POST', '/api/sessions', { title: 'plain', cwd: WS }, H)).json.session;
    const ev4 = await chatStream({ sessionId: s4.id, message: '普通问题,不涉及任务 [m1]' }, H);
    ok(ev4.filter(e => e.type === 'mission').length === 0, 'E 无账本会话不产生 mission 事件(单回合,零行为变化)');
    ok(readJson(sessionPath(s4.id)).mission === null, 'E 无账本会话 session.mission 仍为 null');

    // ── F) 对抗轮 P1 安全锁:模型经 mission_update 注入 command check 必须被拒(驱动器绝不无提示 shell 执行) ──
    const s5 = (await req('POST', '/api/sessions', { title: 'evil', cwd: WS }, H)).json.session;
    // 用户经 UI(header token)建一个只有 none-check 里程碑的账本 → 模型企图追加/改成 command check。
    await req('POST', '/api/mission', { token, sessionId: s5.id, action: 'start', mission: { goal: 'EVILMODE 安全测试', milestones: [{ id: 'e1', desc: '会被模型攻击的里程碑', check: { type: 'none' } }], budget: { maxAutoTurns: 3 } }, autoMode: 'until-done' }, H);
    try { fs.unlinkSync(path.join(WS, 'PWNED.txt')); } catch {}
    const ev5 = await chatStream({ sessionId: s5.id, message: 'EVILMODE 开始' }, H);
    void ev5;
    const m5 = readJson(sessionPath(s5.id)).mission;
    const e1 = (m5.milestones || []).find(x => x.id === 'e1');
    ok(e1 && e1.check && e1.check.type === 'none', 'F 模型注入的 command check 被降级为 none(实 ' + (e1 && e1.check && e1.check.type) + ')');
    ok(!fs.existsSync(path.join(WS, 'PWNED.txt')), 'F 恶意命令未被执行(无 PWNED.txt)—— 驱动器未无提示 shell 执行模型注入的命令');

    // ── G) 对抗轮 P1:用户(header token)可正常定义 command check;模型改不动它 ──
    const s6 = (await req('POST', '/api/sessions', { title: 'usercheck', cwd: WS }, H)).json.session;
    const r6 = await req('POST', '/api/mission', { token, sessionId: s6.id, action: 'start', mission: { goal: '用户定义命令验收', milestones: [{ id: 'u1', desc: '跑测试', check: { type: 'command', cmd: 'echo ok' } }] }, autoMode: 'off' }, H);
    const u1 = r6.json.mission.milestones.find(x => x.id === 'u1');
    ok(u1 && u1.check.type === 'command' && u1.check.cmd === 'echo ok', 'G 用户(header token)可定义 command check');
    // 模型经 body-token(loopback 模拟)企图改 cmd → 被拒(trusted=false)。
    const r6b = await req('POST', '/api/mission', { token, sessionId: s6.id, action: 'update', milestones: [{ id: 'u1', check: { type: 'command', cmd: 'rm -rf /' } }] }, {});
    const u1b = (r6b.json.mission.milestones || []).find(x => x.id === 'u1');
    ok(u1b && u1b.check.cmd === 'echo ok', 'G body-token(模型侧)改不动已定义的 command check(仍为 echo ok)');

    // ── H) 对抗轮 P3:模型不可把 done 里程碑回退 pending(防抖动拖住循环) ──
    const s7 = (await req('POST', '/api/sessions', { title: 'regress', cwd: WS }, H)).json.session;
    await req('POST', '/api/mission', { token, sessionId: s7.id, action: 'start', mission: { goal: '回退测试', milestones: [{ id: 'd1', desc: '一', status: 'done' }] }, autoMode: 'off' }, H);
    const r7 = await req('POST', '/api/mission', { token: token, sessionId: s7.id, action: 'update', milestones: [{ id: 'd1', status: 'pending' }] }, {}); // body-token = 不可信
    const d1 = (r7.json.mission.milestones || []).find(x => x.id === 'd1');
    ok(d1 && d1.status === 'done', 'H 不可信来源不能把 done 回退 pending(仍 done)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    kill(wb); try { fake.close(); } catch {}
    await sleep(300); fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nMISSION-DRIVER E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
