require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// E2E (第116波 116c-0 · 27 号文 §1/§3.5): 会话回合核心 runSessionTurn 与 HTTP 壳 streamChat 的等价性。
// 背景:streamChat 原来既是 HTTP 处理器又是回合执行器;管家(116c)与定时任务(119)要在不经 HTTP 的前提下、
// 自带 sink 地在任意会话上发起一个完整回合。本件把「HTTP 路径」与「进程内核心路径」跑同一条消息,断言两者
// 事件序列、持久化形状、用量台账逐项同构 —— 这是「零行为搬家」的主证据。
//
// 拓扑(全离线、零依赖):
//   · fake-openai(纯 chat 回声,不发工具)一份,两条路径共用;
//   · HTTP 路径:子进程起真服务(HOME_HTTP),POST /api/chat/stream;
//   · 核心路径:本进程 require(app/server.js)(HOME_CORE,require 前已把 RUYI_HOME/WIN_CLAUDE_WORKBENCH_HOME
//     指到临时目录),直接调用导出的 runSessionTurn,自带 onEvent sink。
//   两条路径各用独立 HOME,避免共享 config/会话索引产生写竞态,污染「形状等价」的判读。
//
// 断言:
//  ① 导出面:runSessionTurn 是函数;HTTP 路径一回合正常完成(有 session/assistant/result 事件)。
//  ② 事件序列等价:两条路径的「事件类型游程序列」(合并相邻同类型,抹平 HTTP 壳 50ms delta 合批)完全相同。
//  ③ 返回值契约:ok / sessionId / turnSeq / result / usage / source 齐备且自洽(turnSeq 推进到 1)。
//  ④ 持久化形状同构:会话 meta(turnSeq、消息角色序列)、messages.ndjson 的角色与引擎字段一致。
//  ⑤ 用量台账:两个 HOME 各恰好 1 行,键集合与 engine/provider/model/kind 一致(source 不进台账、不改判定)。
//  ⑥ source/requestMeta 只透传:传 'steward' 时返回值回显,台账行与 'http' 那条同形(不多不少一个键)。
//  ⑦ 并发同会话:核心并发发起两回合与 HTTP 并发双发的语义相同(supersede,不是忙错误);两次都收敛,
//     且事后同一会话还能正常跑一回合 —— 没有留下脏锁。
//  ⑧ signal abort:回合被 abort 后核心按原语义收尾(promise 正常 resolve、disconnected:true),
//     且同一会话随后仍能正常跑一回合(授权登记/settle 登记都已清干净)。
//  ⑨ engineRoute 显式覆盖:不传时与搬家前等价(走会话推断);显式传 openai 路由时同样跑通同一 provider。
// 判定行(exact): SESSION-TURN-CORE E2E: ALL PASS
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME_HTTP = path.join(os.tmpdir(), 'wcw-session-turn-core-http-e2e');
const HOME_CORE = path.join(os.tmpdir(), 'wcw-session-turn-core-core-e2e');
const MONTH = new Date().toISOString().slice(0, 7);
const MESSAGE = '同一条消息,两条路径';

// require 之前钉死本进程的 HOME —— 核心路径的 paths.* 在模块加载期定型。
fs.rmSync(HOME_CORE, { recursive: true, force: true });
fs.mkdirSync(HOME_CORE, { recursive: true });
process.env.RUYI_HOME = HOME_CORE;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_CORE;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } });
    });
    r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); });
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } }
      });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); });
    req.write(data); req.end();
  });
}
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    // 116-5a:本件隔离回合/工具/台账,不测线程自动摘要(它有自己的 thread-brief.e2e.js)
    stewardThreadBriefV1: false,
    // 121 波 K0(34 号文 §8.4):stewardEnabledV1 默认翻成 true。同上一条的理由 —— 本件隔离的是
    // 【一条回合的旁车文件集合与台账形状】,管家开着会往同一个 HOME 里另写 steward/ 那一族面,
    // ④「两条路径会话旁车文件集合相同」当场红。管家自己的覆盖在 steward-* 那十几件里。
    stewardEnabledV1: false,
    configSchema: 7, version: '1.4.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
// 事件类型游程序列:合并相邻同类型,抹平 HTTP 壳的 50ms delta 合批(纯传输层优化),留下真正的顺序骨架。
function typeRuns(events) {
  const out = [];
  for (const e of events) { const t = e && e.type; if (!t) continue; if (out[out.length - 1] !== t) out.push(t); }
  return out;
}
function ndjsonRoles(home, sessionId) {
  const p = path.join(home, 'sessions', sessionId + '.messages.ndjson');
  let raw = ''; try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  return raw.split(/\r?\n/).filter(l => l.trim()).map(l => { let j = null; try { j = JSON.parse(l); } catch { /* ignore */ } return j; })
    .filter(Boolean).map(m => [m.role, m.engine || '', m.providerId || '', m.model || ''].join('|'));
}
function sessionMeta(home, sessionId) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'sessions', sessionId + '.json'), 'utf8')); } catch { return null; }
}
// 台账是 fire-and-forget 的全局串行追加链(00-boot.js appendUsageLedger),回合 promise resolve 时那一行
// 可能还没落盘。HTTP 路径靠网络往返天然等到了;核心路径必须显式轮询,不能裸 sleep 也不能不等。
async function waitLedger(home, want) {
  for (let i = 0; i < 60; i++) { const rows = ledgerRows(home); if (rows.length >= want) return rows; await sleep(50); }
  return ledgerRows(home);
}
function ledgerRows(home) {
  const p = path.join(home, 'usage', MONTH + '.jsonl');
  let raw = ''; try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  return raw.split(/\r?\n/).filter(l => l.trim()).map(l => { let j = null; try { j = JSON.parse(l); } catch { /* ignore */ } return j; }).filter(Boolean);
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const FAKE_PORT = await getFreePort();
  const WB_PORT = await getFreePort();

  fs.rmSync(HOME_HTTP, { recursive: true, force: true });
  fs.mkdirSync(HOME_HTTP, { recursive: true });
  writeConfig(HOME_HTTP, FAKE_PORT);
  writeConfig(HOME_CORE, FAKE_PORT);

  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT) }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME_HTTP, WIN_CLAUDE_WORKBENCH_HOME: HOME_HTTP }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 60 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening on :' + WB_PORT);

    // 核心路径的模块实例(HOME_CORE)。require 必须在 HOME 环境变量钉死之后 —— 见文件头。
    const api = require(path.join(WB, 'app', 'server.js'));
    ok(typeof api.runSessionTurn === 'function', '① 14-main 导出 runSessionTurn');

    // ---- ① HTTP 路径一回合 ----
    const httpEvents = await postStream(WB_PORT, { message: MESSAGE, cwd: HOME_HTTP });
    const httpSession = httpEvents.find(e => e.type === 'session');
    const httpResult = httpEvents.find(e => e.type === 'result');
    ok(!!httpSession && !!httpSession.session && !!httpSession.session.id, '① HTTP 路径首事件带 session');
    ok(!!httpResult && httpResult.ok === true, '① HTTP 路径以 ok 的 result 收尾');
    ok(!httpEvents.some(e => e.type === 'error'), '① HTTP 路径无 error 事件');
    const httpSid = httpSession.session.id;

    // ---- ② 核心路径同一条消息 ----
    const coreEvents = [];
    const coreRet = await api.runSessionTurn({ message: MESSAGE, cwd: HOME_CORE, source: 'http', onEvent: e => coreEvents.push(e) });
    const coreSid = coreRet.sessionId;
    ok(!coreEvents.some(e => e.type === 'error'), '② 核心路径无 error 事件');

    const httpRuns = typeRuns(httpEvents), coreRuns = typeRuns(coreEvents);
    ok(JSON.stringify(httpRuns) === JSON.stringify(coreRuns), '② 事件类型游程序列相同: ' + coreRuns.join(',') + (httpRuns.join(',') === coreRuns.join(',') ? '' : ' vs HTTP ' + httpRuns.join(',')));
    ok(coreRuns[0] === 'session' && coreRuns[coreRuns.length - 1] === 'result', '② 序列首尾仍是 session…result');

    // ---- ③ 返回值契约 ----
    ok(coreRet.ok === true && !coreRet.error, '③ 返回 ok:true 且无 error');
    ok(coreRet.turnSeq === 1, '③ turnSeq 推进到 1(实测 ' + coreRet.turnSeq + ')');
    ok(!!coreRet.result && coreRet.result.type === 'result' && coreRet.result.ok === true, '③ result 回传最后一个 result 事件');
    ok(coreRet.usage && Number(coreRet.usage.frames) > 0 && Number(coreRet.usage.lastTurnTokens) > 0, '③ usage 取样非空');
    ok(coreRet.source === 'http' && coreRet.stopped === false && coreRet.disconnected === false, '③ source/stopped/disconnected 自洽');

    // ---- ④ 持久化形状同构 ----
    const httpMeta = sessionMeta(HOME_HTTP, httpSid), coreMeta = sessionMeta(HOME_CORE, coreSid);
    ok(!!httpMeta && !!coreMeta && httpMeta.turnSeq === coreMeta.turnSeq && coreMeta.turnSeq === 1, '④ 两条路径会话 meta 的 turnSeq 相同');
    ok(!!httpMeta && !!coreMeta && httpMeta.schemaVersion === coreMeta.schemaVersion, '④ 会话 schemaVersion 相同');
    const httpRoles = ndjsonRoles(HOME_HTTP, httpSid), coreRoles = ndjsonRoles(HOME_CORE, coreSid);
    ok(!!httpRoles && httpRoles.length > 0 && JSON.stringify(httpRoles) === JSON.stringify(coreRoles), '④ messages.ndjson 角色/引擎序列相同: ' + (coreRoles || []).join(' → '));
    const suffixes = home => fs.readdirSync(path.join(home, 'sessions')).filter(f => !f.startsWith('_')).map(f => f.replace(/^[^.]+/, '')).sort();
    ok(JSON.stringify(suffixes(HOME_HTTP)) === JSON.stringify(suffixes(HOME_CORE)), '④ 会话旁车文件集合相同: ' + suffixes(HOME_CORE).join(' '));

    // ---- ⑤ 用量台账 ----
    const httpLedger = await waitLedger(HOME_HTTP, 1), coreLedger = await waitLedger(HOME_CORE, 1);
    ok(httpLedger.length === 1 && coreLedger.length === 1, '⑤ 两个 HOME 各恰好 1 行台账(' + httpLedger.length + '/' + coreLedger.length + ')');
    const keysOf = row => Object.keys(row || {}).sort().join(',');
    ok(keysOf(httpLedger[0]) === keysOf(coreLedger[0]), '⑤ 台账键集合相同: ' + keysOf(coreLedger[0]));
    const ident = row => [row && row.engine, row && row.provider, row && row.model, row && row.kind].join('|');
    ok(httpLedger.length === 1 && coreLedger.length === 1 && ident(httpLedger[0]) === ident(coreLedger[0]), '⑤ 台账 engine/provider/model/kind 相同: ' + ident(coreLedger[0]));

    // ---- ⑥ source / requestMeta 只透传 ----
    const stewardEvents = [];
    const stewardRet = await api.runSessionTurn({
      message: '管家侧回合', cwd: HOME_CORE, source: 'steward',
      requestMeta: { threadId: 'thr_demo' }, onEvent: e => stewardEvents.push(e),
    });
    ok(stewardRet.ok === true && stewardRet.source === 'steward', '⑥ source 原样回传(steward)');
    const afterSteward = await waitLedger(HOME_CORE, 2);
    ok(afterSteward.length === 2, '⑥ 管家回合照常记一行台账(共 ' + afterSteward.length + ' 行)');
    ok(keysOf(afterSteward[1]) === keysOf(coreLedger[0]), '⑥ 台账形状不因 source 改变(source 不进台账、不改判定)');
    ok(JSON.stringify(typeRuns(stewardEvents)) === JSON.stringify(coreRuns), '⑥ 管家回合事件序列与 HTTP 回合相同');

    // ---- ⑦ 并发同会话:核心与 HTTP 同语义(supersede,不是忙错误) ----
    const httpConcSid = (await postStream(WB_PORT, { message: '并发底座', cwd: HOME_HTTP })).find(e => e.type === 'session').session.id;
    const [hA, hB] = await Promise.all([
      postStream(WB_PORT, { sessionId: httpConcSid, message: '并发 A', cwd: HOME_HTTP }),
      postStream(WB_PORT, { sessionId: httpConcSid, message: '并发 B', cwd: HOME_HTTP }),
    ]);
    const httpConcShape = [hA, hB].map(evs => ({ hasResult: evs.some(e => e.type === 'result'), busyError: evs.filter(e => e.type === 'error').map(e => e.error) }));
    const coreConcSid = (await api.runSessionTurn({ message: '并发底座', cwd: HOME_CORE, onEvent: () => {} })).sessionId;
    const cA = [], cB = [];
    const [rA, rB] = await Promise.all([
      api.runSessionTurn({ sessionId: coreConcSid, message: '并发 A', cwd: HOME_CORE, onEvent: e => cA.push(e) }),
      api.runSessionTurn({ sessionId: coreConcSid, message: '并发 B', cwd: HOME_CORE, onEvent: e => cB.push(e) }),
    ]);
    const coreConcShape = [cA, cB].map(evs => ({ hasResult: evs.some(e => e.type === 'result'), busyError: evs.filter(e => e.type === 'error').map(e => e.error) }));
    ok(JSON.stringify(httpConcShape.map(s => s.hasResult)) === JSON.stringify(coreConcShape.map(s => s.hasResult)),
      '⑦ 并发同会话:两路径「是否各自收尾」判定相同(HTTP ' + JSON.stringify(httpConcShape.map(s => s.hasResult)) + ')');
    ok(JSON.stringify(httpConcShape.map(s => s.busyError.length)) === JSON.stringify(coreConcShape.map(s => s.busyError.length)),
      '⑦ 并发同会话:两路径 error 事件条数相同(现网语义是 supersede,没有忙错误信封)');
    ok(rA.sessionId === coreConcSid && rB.sessionId === coreConcSid, '⑦ 并发两回合都落在同一会话');
    const afterConc = await api.runSessionTurn({ sessionId: coreConcSid, message: '并发之后', cwd: HOME_CORE, onEvent: () => {} });
    ok(afterConc.ok === true, '⑦ 并发之后同一会话仍能正常跑一回合(没有留下脏锁)');

    // ---- ⑧ signal abort ----
    const abortCtl = new AbortController();
    const abortEvents = [];
    const abortRet = await api.runSessionTurn({
      message: '会被打断的回合', cwd: HOME_CORE, signal: abortCtl.signal,
      onEvent: e => { abortEvents.push(e); if (e && e.type === 'session') abortCtl.abort(); },
    });
    ok(abortRet && abortRet.disconnected === true, '⑧ abort 后 disconnected:true');
    ok(abortEvents.some(e => e.type === 'session'), '⑧ abort 的回合仍按原语义收尾(promise 正常 resolve)');
    const afterAbort = await api.runSessionTurn({ sessionId: abortRet.sessionId, message: 'abort 之后', cwd: HOME_CORE, onEvent: () => {} });
    ok(afterAbort.ok === true, '⑧ abort 之后同一会话仍能正常跑一回合(授权/settle 登记已清)');
    // 入口即 aborted 的极端态:同样只是走断线分支,不抛。
    const preAborted = new AbortController(); preAborted.abort();
    const preRet = await api.runSessionTurn({ message: '入口即断线', cwd: HOME_CORE, signal: preAborted.signal, onEvent: () => {} });
    ok(preRet && preRet.disconnected === true, '⑧ 入口即 aborted 的 signal 也走断线分支,不抛');

    // ---- ⑨ engineRoute 显式覆盖 ----
    const routedEvents = [];
    const routedRet = await api.runSessionTurn({
      message: '显式路由回合', cwd: HOME_CORE,
      engineRoute: { engine: 'openai', providerId: 'fake', model: 'fake-model' },
      onEvent: e => routedEvents.push(e),
    });
    ok(routedRet.ok === true, '⑨ 显式 engineRoute 的回合跑通');
    ok(JSON.stringify(typeRuns(routedEvents)) === JSON.stringify(coreRuns), '⑨ 显式路由与推断路由的事件序列相同');
  } catch (e) {
    fail++; console.log('FAIL 未捕获异常: ' + (e && e.stack || e));
  } finally {
    killp(wb); killp(fake);
  }

  console.log(fail ? ('SESSION-TURN-CORE E2E: ' + fail + ' FAIL') : 'SESSION-TURN-CORE E2E: ALL PASS');
  process.exit(fail ? 1 : 0);
})();
