#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// prefix-layout.e2e.js — 106 #1 前缀缓存布局修复(21-E4 §7.1/§7.2/§7.3)
//
// 覆盖:
//   [U] 开关三态(严格布尔)+ createToolLoadingState 冻结纯函数:
//       冻结序只追加不重排(tool_load/换分类消息都追加尾部)、freezeKey 缺省=现状、
//       catalog 缺失条目保名义位置不发送。
//   [E-G1] 集成(fake-openai 两回合):
//       开关关 = volatile 前插历史首条 user(现状);开关开 = 首条 user 逐字节不动、
//       volatile 追加当前最新 user 尾部;layout_shadow 采样事件双布局字段齐全(E4 §7.3)。
//   [E-G2] 集成(fake-openai 两回合换分类):
//       开关开 = 第二回合 tools 以第一回合为前缀、新包工具追加尾部 + tool_schema_freeze
//       init/append 事件;开关关 = 零冻结事件(现状由 tool-loading.e2e 等基线锁定)。
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

// 隔离纪律(同 budget-guard):require server.js 之前把数据根指向临时目录。
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106g1-unit-'));

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
function get(port, p) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 3000 }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); }); }); }
function postStream(port, payload) { return new Promise(resolve => { const events = []; const data = JSON.stringify(payload); const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let buf = ''; res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } }); res.on('end', () => resolve(events)); }); req.on('error', () => resolve(events)); req.on('timeout', () => { req.destroy(); resolve(events); }); req.write(data); req.end(); }); }

// 起一套 fake-openai + workbench;flags 写进 config.json。
async function launchStack(tag, flags) {
  const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
  const EHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-106g1-e-' + tag + '-'));
  const CAP = path.join(EHOME, 'caps'); fs.mkdirSync(CAP, { recursive: true });
  fs.writeFileSync(path.join(EHOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'test-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }], contextWindow: 40000 }],
    activeProvider: 'fake',
    ...(flags || {}),
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], {
    windowsHide: true,
    env: { ...process.env, FAKE_CAPTURE_DIR: CAP },
  });
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: EHOME, RUYI_HOME: EHOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!' + tag + '] ' + l.trim())));
  let h = null; for (let i = 0; i < 80 && !h; i++) { await sleep(250); h = await get(WB_PORT, '/health'); }
  const readCap = n => { try { return JSON.parse(fs.readFileSync(path.join(CAP, 'req-' + String(n).padStart(3, '0') + '.json'), 'utf8')); } catch { return null; } };
  const logFile = path.join(EHOME, 'logs', 'workbench-' + new Date().toISOString().slice(0, 10) + '.ndjson');
  const waitLog = async (pred, ms) => {
    const deadline = Date.now() + (ms || 4000);
    while (Date.now() < deadline) {
      let lines = []; try { lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* not yet */ }
      const hit = lines.filter(pred);
      if (hit.length) return hit;
      await sleep(200);
    }
    return [];
  };
  const cleanup = async () => { kill(wb); kill(fake); await sleep(300); fs.rmSync(EHOME, { recursive: true, force: true }); };
  return { EHOME, WB_PORT, readCap, waitLog, cleanup, healthy: !!h };
}
const userMsgs = body => (((body && body.messages) || []).filter(m => m && m.role === 'user').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')));
const toolNames = body => (((body && body.tools) || []).map(t => t && t.function && t.function.name).filter(Boolean));

(async () => {
  // ═══ [U] 开关三态 + G2 冻结纯函数 ═══
  console.log('── [U] #1 开关三态与 schema 冻结契约 ──');
  ok(srv.volatileTailLayoutEnabled(srv.defaultConfig()) === false && srv.appendOnlyToolSchemasEnabled(srv.defaultConfig()) === true, 'U1 G1 默认关闭、G2 真实 provider 门后默认开启');
  ok(srv.volatileTailLayoutEnabled({ runtimeVolatileTailLayoutV1: true }) === true && srv.appendOnlyToolSchemasEnabled({ runtimeAppendOnlyToolSchemasV1: true }) === true, 'U2 显式 true 各自生效');
  const cfgStr = srv.normalizeConfig({ runtimeVolatileTailLayoutV1: 'true', runtimeAppendOnlyToolSchemasV1: 'true' }).config;
  ok(srv.volatileTailLayoutEnabled(cfgStr) === false && srv.appendOnlyToolSchemasEnabled(cfgStr) === false, 'U3 字符串 "true" 洗回 false(严格布尔)');

  const T = name => ({ type: 'function', function: { name, description: 'd ' + name, parameters: { type: 'object', properties: {} } } });
  const fakeTools = ['list_tools', 'tool_search', 'tool_load', 'alpha_read', 'beta_write', 'gamma_thing'].map(T);
  const names = arr => arr.map(t => t.function.name);
  { // G2 冻结:on + freezeKey —— tool_load 与换分类消息都只追加尾部
    const cfgOn = { toolLoadingMode: 'auto', runtimeAppendOnlyToolSchemasV1: true };
    const s1 = srv.createToolLoadingState(cfgOn, 'hello', null, fakeTools, {}, 'u-freeze-1');
    const n1 = names(s1.current());
    ok(n1.join(',') === 'list_tools,tool_search,tool_load', 'U4 首回合冻结初值 = core 分类基线(' + n1.join(',') + ')');
    s1.load({ tools: ['gamma_thing'] });
    ok(names(s1.current()).join(',') === 'list_tools,tool_search,tool_load,gamma_thing', 'U5 tool_load 新工具追加尾部(非 catalog 原位插入)');
    const s2 = srv.createToolLoadingState(cfgOn, '帮我读取这个文件', null, fakeTools, {}, 'u-freeze-1');
    ok(names(s2.current()).join(',') === 'list_tools,tool_search,tool_load,gamma_thing,alpha_read', 'U6 换分类消息:冻结序保持,新激活包工具追加尾部(alpha_read 排在 gamma_thing 之后,无视 catalog 序)');
  }
  { // G2 关/缺 freezeKey:纯 catalog 序过滤,无跨状态记忆
    const cfgOff = { toolLoadingMode: 'auto' };
    const s1 = srv.createToolLoadingState(cfgOff, 'hello', null, fakeTools, {}, 'u-freeze-2');
    s1.load({ tools: ['gamma_thing'] });
    const s2 = srv.createToolLoadingState(cfgOff, '帮我读取这个文件', null, fakeTools, {}, 'u-freeze-2');
    ok(names(s2.current()).join(',') === 'list_tools,tool_search,tool_load,alpha_read', 'U7 开关关:无冻结记忆,按当次分类 catalog 序过滤(现状)');
    const cfgOnNoKey = { toolLoadingMode: 'auto', runtimeAppendOnlyToolSchemasV1: true };
    const s3 = srv.createToolLoadingState(cfgOnNoKey, 'hello', null, fakeTools, {});
    const s4 = srv.createToolLoadingState(cfgOnNoKey, '帮我读取这个文件', null, fakeTools, {});
    ok(names(s4.current()).join(',') === 'list_tools,tool_search,tool_load,alpha_read', 'U8 开关开但缺 freezeKey(子代理/一次性调用):不冻结,与现状逐字节一致');
    void s3;
  }
  { // G2 catalog 缺失(MCP 离线/撤权):条目保名义位置但不发送,顺序不断裂
    const cfgOn = { toolLoadingMode: 'auto', runtimeAppendOnlyToolSchemasV1: true };
    const s1 = srv.createToolLoadingState(cfgOn, 'hello', null, fakeTools, {}, 'u-freeze-3');
    s1.load({ tools: ['gamma_thing'] });
    const fewer = fakeTools.filter(t => t.function.name !== 'gamma_thing');
    const s2 = srv.createToolLoadingState(cfgOn, '帮我读取这个文件', null, fewer, {}, 'u-freeze-3');
    ok(names(s2.current()).join(',') === 'list_tools,tool_search,tool_load,alpha_read', 'U9 catalog 缺失条目不发送且不引发重排(缓存断裂记日志,见集成 E8)');
    void s1;
  }

  // ═══ [E-G1] 易变层布局集成(两回合) ═══
  console.log('── [E-G1] volatile 前插(现状) vs 尾部追加(开关开) ──');
  const M1 = '第一轮:随便聊聊即可';
  const M2 = '第二轮:继续聊聊';
  { // A: 开关关 —— volatile 前插历史首条 user(现状基线)
    const A = await launchStack('a', {});
    ok(A.healthy, 'E0a workbench A listening on :' + A.WB_PORT);
    try {
      const ev1 = await postStream(A.WB_PORT, { message: M1 });
      const sid = (ev1.find(e => e.type === 'session') || {}).session?.id;
      const ev2 = await postStream(A.WB_PORT, { message: M2, sessionId: sid });
      ok(!!(ev2.find(e => e.type === 'result') || {}).ok, 'E1a 开关关:两回合均正常完成');
      const req2 = A.readCap(2);
      const users = userMsgs(req2);
      ok(users.length === 2 && users[0] !== M1 && users[0].endsWith(M1) && users[0].length > M1.length + 50, 'E2a 开关关:volatile 前插首条 user(现状,前缀缓存从 messages[1] 断裂的布局)');
      ok(users[1] === M2, 'E3a 开关关:最新 user 无注入(无 recall/notes 对象的_plain 回合)');
    } finally { await A.cleanup(); }
  }
  { // B: 开关开 —— 首条 user 逐字节不动,volatile 追加最新 user 尾部
    const B = await launchStack('b', { runtimeVolatileTailLayoutV1: true });
    ok(B.healthy, 'E0b workbench B listening on :' + B.WB_PORT);
    try {
      const ev1 = await postStream(B.WB_PORT, { message: M1 });
      const sid = (ev1.find(e => e.type === 'session') || {}).session?.id;
      const ev2 = await postStream(B.WB_PORT, { message: M2, sessionId: sid });
      ok(!!(ev2.find(e => e.type === 'result') || {}).ok, 'E1b 开关开:两回合均正常完成');
      const req2 = B.readCap(2);
      const users = userMsgs(req2);
      ok(users.length === 2 && users[0] === M1, 'E2b 开关开:历史首条 user 逐字节不动(跨回合前缀不再从 messages[1] 断裂)');
      ok(users[1] && users[1].startsWith(M2) && users[1].length > M2.length + 50, 'E3b 开关开:volatile 追加当前最新 user 尾部(与 recall/notes 同位)');
      const shadow = await B.waitLog(x => x.kind === 'layout_shadow', 4000);
      ok(shadow.length >= 1 && shadow.every(x => x.sentLayout === 'tail' && Number.isFinite(x.stablePrefixCharsSent) && Number.isFinite(x.stablePrefixCharsAlt) && x.totalCharsAlt > 0), 'E4b layout_shadow 采样事件齐全(sentLayout=tail + 双布局 stablePrefixChars,E4 §7.3)');
    } finally { await B.cleanup(); }
  }

  // ═══ [E-G2] schema 冻结集成(两回合换分类) ═══
  console.log('── [E-G2] tools schema 会话级冻结 + 只追加 ──');
  const G1MSG = '你好,随便聊聊';
  const G2MSG = '帮我读取 package.json 这个文件看看';
  { // C: 开关开 —— 第二回合 tools 以第一回合为前缀
    const C = await launchStack('c', { runtimeAppendOnlyToolSchemasV1: true });
    ok(C.healthy, 'E0c workbench C listening on :' + C.WB_PORT);
    try {
      const ev1 = await postStream(C.WB_PORT, { message: G1MSG });
      const sid = (ev1.find(e => e.type === 'session') || {}).session?.id;
      await postStream(C.WB_PORT, { message: G2MSG, sessionId: sid });
      const t1 = toolNames(C.readCap(1)), t2 = toolNames(C.readCap(2));
      ok(t1.length > 0 && t2.length > t1.length, 'E5 开关开:第二回合分类激活 files_read,tools 变多(' + t1.length + ' → ' + t2.length + ')');
      ok(t2.slice(0, t1.length).join('') === t1.join(''), 'E6 开关开:第二回合 tools 以第一回合为严格前缀(新增只追加尾部)');
      const fz = await C.waitLog(x => x.kind === 'tool_schema_freeze', 4000);
      ok(fz.some(x => x.state === 'init') && fz.some(x => x.state === 'append' && Array.isArray(x.added) && x.added.length > 0), 'E7 tool_schema_freeze init+append 事件落账');
    } finally { await C.cleanup(); }
  }
  { // D: 开关关 —— 零冻结事件(布局现状由 tool-loading 基线锁定)
    const D = await launchStack('d', { runtimeAppendOnlyToolSchemasV1: false });
    ok(D.healthy, 'E0d workbench D listening on :' + D.WB_PORT);
    try {
      const ev1 = await postStream(D.WB_PORT, { message: G1MSG });
      const sid = (ev1.find(e => e.type === 'session') || {}).session?.id;
      await postStream(D.WB_PORT, { message: G2MSG, sessionId: sid });
      const fz = await D.waitLog(x => x.kind === 'tool_schema_freeze', 1500);
      ok(fz.length === 0, 'E8 开关关:零冻结事件、零布局干预(回退逐字节现状)');
    } finally { await D.cleanup(); }
  }

  console.log(failures ? `\nPREFIX-LAYOUT E2E: FAIL (${failures})` : '\nPREFIX-LAYOUT E2E: ALL PASS');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR ' + (e && e.stack || e)); process.exit(1); });
