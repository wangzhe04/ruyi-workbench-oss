require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(61 号文 C4:检查点对模型可见):真服务进程 + 脚本化假 provider,走主回合工具循环(09 runOpenAiTurn)。
//   [L] 只读工具 checkpoint_list:写两个回合的文件后,列出当前会话的检查点(回合/序号/工具/路径/op/时间/可撤销/已撤销);
//       turnSeq 过滤与 limit 有界;注入的 sessionId 参数不起作用,别的会话读不到;模型拿到的工具里没有任何回滚类工具。
//   [N] 用户在界面撤销(POST /api/checkpoints/rollback,要 token)之后,下一回合 user 消息末尾带一行「用户已在界面撤销」:
//       界面消息不带;落盘后字节不变(下一回合请求里那条逐字节一致);再下一回合不重复;checkpoint_list 把撤销过的标 reverted。
//   [R] 告知跨重启还在(旁车文件落盘,不靠内存);rewind 截断后指向被丢弃回合的待告知被清掉,不留一句悬空的告知;
//       rewind(rollbackFiles:true)本身不给模型记告知(被丢弃的回合对模型而言没发生过)。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const t = createRunner('CHECKPOINT VISIBILITY');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
const scenarioOf = messages => {
  const tagged = messages.filter(m => m && m.role === 'user' && /SCN-[A-Z0-9]+/.test(contentText(m.content)));
  const m = tagged.length ? /SCN-([A-Z0-9]+)/.exec(contentText(tagged[tagged.length - 1].content)) : null;
  return m ? m[1] : '';
};
const toolRepliesThisTurn = messages => {
  const lastUser = messages.map(m => m && m.role === 'user' && /SCN-/.test(contentText(m.content))).lastIndexOf(true);
  return messages.slice(lastUser + 1).filter(m => m && m.role === 'tool').length;
};
const toolNames = req => (req.tools || []).map(x => x && x.function && x.function.name).filter(Boolean);
const toolMsg = (req, id) => (req ? contentText((req.messages.find(m => m.role === 'tool' && m.tool_call_id === id) || {}).content) : '');
const parseJson = s => { try { return JSON.parse(s); } catch { return null; } };
const userTexts = req => (req ? req.messages.filter(m => m.role === 'user').map(m => contentText(m.content)) : []);
const NOTICE = '[用户已在界面撤销：';
const TIME_THEN_NOTICE_RE = /\n\n\[本条消息发送于 [^\]\n]+\]\n\[用户已在界面撤销：[^\n]*\]$/;
// 3.0 收口 · 记忆召回 #9(77751c2)起,每回合会变的记忆回执与相关索引贴在末条 user 的最后、不落盘(与 recall / notes 同位)。
// 「告知在时间行之后、落盘后逐字节不变」比的是落盘的那一段:先摘掉本回合的记忆块再判 —— 告知落盘、重放不变这条不变量原样钉着。
const persistedUserText = s => { const i = String(s || '').lastIndexOf('\n\n<workbench-memory-check'); return i >= 0 ? s.slice(0, i) : String(s || ''); };

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cp-visibility-'));
const WS = path.join(HOME, 'ws');
fs.mkdirSync(WS, { recursive: true });
const A = path.join(WS, 'a.txt'), B = path.join(WS, 'b.txt'), OLD = path.join(WS, 'old.txt'), E = path.join(WS, 'e.txt'), C = path.join(WS, 'c.txt');
fs.writeFileSync(OLD, 'v0');
let sidA = '', sidB = '';

const fake = await startFakeProvider({
  async handler(req) {
    const msgs = req.messages;
    if (!req.stream) return textFrames('{"title":"t","gist":"g"}');
    const step = toolRepliesThisTurn(msgs);
    switch (scenarioOf(msgs)) {
      case 'W1':   // 回合 1:新建 a.txt + 覆盖 old.txt(一条 create、一条 modify)
        if (step === 0) return toolCallFrames([{ name: 'file_write', args: { path: A, content: 'A1' }, id: 'w1' }, { name: 'file_write', args: { path: OLD, content: 'v1' }, id: 'w2' }]);
        return textFrames('done');
      case 'W2':
        if (step === 0) return toolCallFrames('file_write', { path: B, content: 'B1' }, 'w3');
        return textFrames('done');
      case 'W4':
        if (step === 0) return toolCallFrames('file_write', { path: E, content: 'E1' }, 'w4');
        return textFrames('done');
      case 'W5':
        if (step === 0) return toolCallFrames('file_write', { path: C, content: 'C1' }, 'w5');
        return textFrames('done');
      case 'LIST1':
        if (step === 0) return toolCallFrames([
          { name: 'checkpoint_list', args: {}, id: 'l1' },
          { name: 'checkpoint_list', args: { turnSeq: 1 }, id: 'l2' },
          { name: 'checkpoint_list', args: { limit: 1 }, id: 'l3' },
        ]);
        return textFrames('done');
      case 'ISO':   // 另一条会话里夹带第一条会话的 id
        if (step === 0) return toolCallFrames('checkpoint_list', { sessionId: sidA, session: sidA }, 'i1');
        return textFrames('done');
      case 'LIST2': case 'LISTRESTART': case 'LISTREWOUND': case 'LISTRW':
        if (step === 0) return toolCallFrames('checkpoint_list', {}, 'q1');
        return textFrames('done');
      default: return textFrames('ok');
    }
  },
});
fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: WS, toolLoadingMode: 'full',
  bridgeExternalToolsToProvider: false, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false }, externalMcpServers: [],
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }] }],
  activeProvider: 'fake',
}));
let WP = 0;
let wb = null;
const requestStatus = (method, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: WP, path: p, method }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  r.on('error', reject); r.end();
});
const startServer = async () => {
  WP = await getFreePort();
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, stdio: 'ignore', env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME } });
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { up = (await requestStatus('GET', '/health')) === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
  return up;
};
const stopServer = async () => {
  if (!wb) return;
  const exited = new Promise(resolve => { if (wb.exitCode !== null) resolve(); else wb.once('exit', resolve); });
  try { killOwnTree(wb.pid); } catch { /* gone */ }
  await Promise.race([exited, sleep(5000)]);
  wb = null;
};
const call = (method, p, payload, headers) => new Promise((resolve, reject) => {
  const raw = payload === undefined ? '' : JSON.stringify(payload);
  const r = http.request({ host: '127.0.0.1', port: WP, path: p, method, headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(headers || {}) } }, res => {
    let buf = ''; res.setEncoding('utf8'); res.on('data', c => { buf += c; });
    res.on('end', () => resolve({ status: res.statusCode, json: parseJson(buf) }));
  });
  r.on('error', reject); if (raw) r.write(raw); r.end();
});
const tokenOf = async () => ((await call('POST', '/api/bootstrap', {})).json || {}).token || '';
const stream = payload => new Promise((resolve, reject) => {
  const raw = JSON.stringify(payload);
  const r = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
    let buf = ''; const evs = [];
    res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!l.trim()) continue; try { evs.push(JSON.parse(l)); } catch { /* skip */ } } });
    res.on('end', () => resolve(evs));
  });
  r.on('error', reject); r.write(raw); r.end();
});
const sidOf = evs => ((evs.find(e => e && e.type === 'session') || {}).session || {}).id || '';
const reqsOf = scn => fake.requests.filter(r => r.stream && scenarioOf(r.messages) === scn);
const sessionBody = async sid => ((await call('GET', '/api/sessions/' + sid)).json || {}).session || {};
const rowsOf = (req, id) => { const r = parseJson(toolMsg(req, id)); return r && Array.isArray(r.checkpoints) ? r : null; };
const same = (x, y) => path.resolve(String(x)) === path.resolve(String(y));

try {
  ok(await startServer(), 'server up');
  let token = await tokenOf();
  ok(!!token, 'UI token bootstrapped');

  // ── 准备:会话 A 写两个回合 ──
  const w1 = await stream({ message: 'SCN-W1 写两个文件' });
  sidA = sidOf(w1);
  ok(/^sess_/.test(sidA), `L0 拿到会话 id(got ${sidA})`);
  ok(fs.existsSync(A) && fs.readFileSync(OLD, 'utf8') === 'v1', 'L0 回合 1 写了 a.txt 并覆盖了 old.txt');
  await stream({ message: 'SCN-W2 再写一个', sessionId: sidA });
  ok(fs.existsSync(B), 'L0 回合 2 写了 b.txt');

  // ── [L] checkpoint_list ──
  await stream({ message: 'SCN-LIST1 列一下检查点', sessionId: sidA });
  const l1Reqs = reqsOf('LIST1');
  const offered = toolNames(l1Reqs[0] || { tools: [] });
  ok(offered.includes('checkpoint_list'), 'L1 模型拿得到 checkpoint_list');
  ok(offered.filter(n => /checkpoint|rollback|restore|undo|rewind/i.test(n)).join(',') === 'checkpoint_list', `L2 模型没有任何回滚类工具(只有 checkpoint_list;got ${offered.filter(n => /checkpoint|rollback|restore|undo|rewind/i.test(n)).join(',')})`);
  const lr = rowsOf(l1Reqs[1], 'l1');
  ok(lr && lr.ok === true && lr.total === 3 && lr.shown === 3 && !('truncated' in lr), `L3 列出 3 行(回合 2 一行 + 回合 1 两行)(got ${JSON.stringify(lr).slice(0, 400)})`);
  const rows = (lr && lr.checkpoints) || [];
  ok(rows.map(r => r.turnSeq).join(',') === '2,1,1', `L4 回合新的在前(got ${rows.map(r => r.turnSeq).join(',')})`);
  const rB = rows[0] || {}, rOld = rows.find(r => r.turnSeq === 1 && r.op === 'modify') || {}, rA = rows.find(r => r.turnSeq === 1 && r.op === 'create') || {};
  ok(rB.tool === 'file_write' && rB.op === 'create' && same(rB.path, B), `L5 回合 2:file_write create b.txt(got ${JSON.stringify(rB)})`);
  ok(rOld.tool === 'file_write' && same(rOld.path, OLD) && rA.tool === 'file_write' && same(rA.path, A), `L5 回合 1:old.txt modify + a.txt create(got ${JSON.stringify([rOld, rA])})`);
  ok(rows.every(r => r.undoable === true && r.reverted === false && Number.isSafeInteger(r.entrySeq) && !Number.isNaN(Date.parse(r.at))), 'L6 每行 undoable:true、reverted:false、entrySeq 是整数、at 是时间');
  ok(/only the user can undo/.test(lr && lr.note || ''), 'L7 结果里说明撤销只能由用户在界面做');
  const lf = rowsOf(l1Reqs[1], 'l2');
  ok(lf && lf.total === 2 && lf.checkpoints.every(r => r.turnSeq === 1), `L8 turnSeq 过滤只留回合 1(got ${lf && lf.total})`);
  const ll = rowsOf(l1Reqs[1], 'l3');
  ok(ll && ll.shown === 1 && ll.total === 3 && ll.truncated === true, `L9 limit:1 有界且 truncated 如实(got ${JSON.stringify(ll && { shown: ll.shown, total: ll.total, truncated: ll.truncated })})`);

  // 别的会话读不到:会话 B 里夹带 A 的 id
  const isoEvs = await stream({ message: 'SCN-ISO 看看别人的' });
  sidB = sidOf(isoEvs);
  const iso = rowsOf(reqsOf('ISO')[1], 'i1');
  ok(sidB && sidB !== sidA && iso && iso.ok === true && iso.total === 0 && !JSON.stringify(iso).includes('a.txt'), `L10 夹带 sessionId 无效:会话 B 看不到 A 的检查点(got ${JSON.stringify(iso).slice(0, 200)})`);

  // ── [N] 用户在界面撤销回合 1 ──
  const rb = await call('POST', '/api/checkpoints/rollback', { sessionId: sidA, turnSeq: 1 }, { 'x-wcw-token': token });
  ok(rb.status === 200 && rb.json && rb.json.ok === true && rb.json.reverted.length === 2, `N1 经 HTTP 路由撤销回合 1(got ${JSON.stringify(rb.json).slice(0, 300)})`);
  ok(!fs.existsSync(A) && fs.readFileSync(OLD, 'utf8') === 'v0' && fs.existsSync(B), 'N2 文件真的恢复了(a.txt 删除、old.txt 回到 v0),回合 2 的 b.txt 不动');

  const evAfter = await stream({ message: 'SCN-AFTER 继续', sessionId: sidA });
  ok(sidOf(evAfter) === sidA, 'N3 同一会话继续');
  const after1 = userTexts(reqsOf('AFTER')[0]);
  const lastAfter = persistedUserText(after1[after1.length - 1] || '');
  ok(lastAfter.startsWith('SCN-AFTER 继续') && TIME_THEN_NOTICE_RE.test(lastAfter), `N4 请求里这条 user 消息末尾(时间行之后)带撤销告知(got …${JSON.stringify(lastAfter.slice(-260))})`);
  ok(lastAfter.includes('第 1 回合') && lastAfter.includes(path.resolve(OLD)) && lastAfter.includes('已恢复到修改前') && lastAfter.includes('新建的 ' + path.resolve(A) + ' 已删除'),
    'N5 告知点明回合、被恢复的文件与被删掉的新建文件');
  ok(!lastAfter.includes(path.resolve(B)), 'N6 没撤销的回合 2 不在告知里');
  const shown = (await sessionBody(sidA)).messages.filter(m => m.role === 'user').pop();
  ok(shown && shown.content === 'SCN-AFTER 继续', `N7 界面消息不带告知(got ${JSON.stringify(shown && shown.content)})`);

  await stream({ message: 'SCN-LIST2 再列一次', sessionId: sidA });
  const l2Reqs = reqsOf('LIST2');
  const users2 = userTexts(l2Reqs[0]);
  ok(users2.includes(lastAfter), 'N8 下一回合请求里上一轮那条带告知的 user 消息逐字节不变(落盘,不破前缀缓存)');
  ok(!(users2[users2.length - 1] || '').includes(NOTICE), 'N9 再下一回合不重复告知');
  const lr2 = rowsOf(l2Reqs[1], 'q1');
  const r2 = (lr2 && lr2.checkpoints) || [];
  ok(r2.length === 3 && r2.filter(r => r.turnSeq === 1).length === 2 && r2.filter(r => r.turnSeq === 1).every(r => r.reverted === true && r.undoable === false && typeof r.revertedAt === 'string'),
    `N10 checkpoint_list 把撤销过的回合 1 标 reverted:true、undoable:false(got ${JSON.stringify(r2).slice(0, 500)})`);
  ok(r2.filter(r => r.turnSeq === 2).length === 1 && r2.find(r => r.turnSeq === 2).reverted === false && r2.find(r => r.turnSeq === 2).undoable === true, 'N11 回合 2 的 b.txt 仍可撤销');

  // ── [R] 撤销后重启,告知还在 ──
  await stream({ message: 'SCN-W4 再写一个 e.txt', sessionId: sidA });
  ok(fs.existsSync(E), 'R0 回合 3(全局第 6 回合)写了 e.txt');
  const sessNow = await sessionBody(sidA);
  const eTurn = Number(sessNow.turnSeq);
  const rb2 = await call('POST', '/api/checkpoints/rollback', { sessionId: sidA, turnSeq: eTurn }, { 'x-wcw-token': token });
  ok(rb2.json && rb2.json.ok === true && !fs.existsSync(E), 'R1 用户撤销 e.txt 那一回合');
  await stopServer();
  ok(await startServer(), 'R2 服务重启');
  token = await tokenOf();
  await stream({ message: 'SCN-LISTRESTART 重启之后', sessionId: sidA });
  const rs = userTexts(reqsOf('LISTRESTART')[0]);
  const lastRs = persistedUserText(rs[rs.length - 1] || '');
  ok(TIME_THEN_NOTICE_RE.test(lastRs) && lastRs.includes(`第 ${eTurn} 回合`) && lastRs.includes('新建的 ' + path.resolve(E) + ' 已删除'), `R3 重启后的第一个回合照样带告知(got …${JSON.stringify(lastRs.slice(-200))})`);
  ok(!lastRs.includes(path.resolve(OLD)), 'R4 回合 1 那条已告知过,不再重复');

  // rewind 清掉指向被丢弃回合的待告知:先撤销回合 2(b.txt),再回退到回合 2 —— 回合 2 已不存在
  const rb3 = await call('POST', '/api/checkpoints/rollback', { sessionId: sidA, turnSeq: 2 }, { 'x-wcw-token': token });
  ok(rb3.json && rb3.json.ok === true && !fs.existsSync(B), 'R5 用户撤销回合 2(b.txt)');
  const rw = await call('POST', '/api/session/rewind', { sessionId: sidA, targetTurnSeq: 2, rollbackFiles: false }, { 'x-wcw-token': token });
  ok(rw.json && rw.json.ok === true, `R6 回退到回合 2(got ${JSON.stringify(rw.json).slice(0, 200)})`);
  await stream({ message: 'SCN-LISTREWOUND 回退之后', sessionId: sidA });
  const rwReqs = reqsOf('LISTREWOUND');
  const rwUsers = userTexts(rwReqs[0]);
  ok(!rwUsers.some(u => u.includes(NOTICE)), `R7 回退之后不再有指向被丢弃回合的告知(got ${JSON.stringify(rwUsers.map(u => u.slice(-80)))})`);
  const lrw = rowsOf(rwReqs[1], 'q1');
  ok(lrw && lrw.checkpoints.every(r => r.turnSeq === 1 && r.reverted === true) && lrw.total === 2, `R8 清单里只剩回合 1 的两条已撤销记录,回合 2 与之后的记录随回退一起清掉(got ${JSON.stringify(lrw && lrw.checkpoints.map(r => [r.turnSeq, r.reverted]))})`);

  // rewind(rollbackFiles:true)自己不给模型记告知
  const evC = await stream({ message: 'SCN-W5 新会话写 c.txt' });
  const sidC = sidOf(evC);
  ok(fs.existsSync(C) && /^sess_/.test(sidC), 'R9 会话 C 的回合 1 写了 c.txt');
  const rwC = await call('POST', '/api/session/rewind', { sessionId: sidC, targetTurnSeq: 1, rollbackFiles: true }, { 'x-wcw-token': token });
  ok(rwC.json && rwC.json.ok === true && !fs.existsSync(C), 'R10 rewind(rollbackFiles:true)把 c.txt 撤回');
  await stream({ message: 'SCN-LISTRW 回退之后', sessionId: sidC });
  const rcReqs = reqsOf('LISTRW');
  ok(!userTexts(rcReqs[0]).some(u => u.includes(NOTICE)), 'R11 rewind 的文件回滚不产生「用户已撤销」告知(被丢弃的回合对模型而言没发生过)');
  const lrc = rowsOf(rcReqs[1], 'q1');
  ok(lrc && lrc.total === 0, `R12 回退后检查点清单为空(got ${lrc && lrc.total})`);
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  await stopServer();
  try { await fake.close(); } catch { /* gone */ }
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  t.done({ exit: true });
}
})();
