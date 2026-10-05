require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(61 号文:模型自评的 harness 摩擦点):真服务进程 + 脚本化假 provider + 假 MCP,走主回合工具循环(09 runOpenAiTurn)。
//   [T] A3 每条 user 消息落历史时带一行本地时间(含星期与 UTC 偏移);界面消息不带;下一回合请求里上一轮那条逐字节不变(缓存零损失)。
//   [S] B1 tool_search 排在前面的未装载命中给 full 参数骨架(全部参数,不再截成「…(+N)」);
//       B3 与内置工具同一件事的桥接工具(fake__read_file ↔ file_read)带 preferred、排到同批未遮蔽项之后。
//   [E] A4 零命中给 note,不再只回一张空表。
//   [L] A4 tool_load 的包里还有没装的桥接工具时如实点名(修前 ok:true、loaded:[],模型以为装上了)。
//   [K] B2 list_tools 带 tiers(非 read 的名字按档列出)。
//   [R] B2 代理档低报(tool_invoke_read 去叫 edit 档的 file_write / exec 档的桥接写)在入批处只升不降地改道:真的执行了,
//       历史里记的是改写后的代理名,埋点 proxyRepair:'retier'。
//   [C] B4 file_read 读缓存命中时 cacheHit 带一句说明。
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
const t = createRunner('HARNESS FRICTION');
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
const TURN_TIME_RE = /\n\n\[本条消息发送于 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) 周[日一二三四五六]\(本地时间 UTC[+-]\d{2}:\d{2}\)\]$/;

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-harness-friction-'));
const WS = path.join(HOME, 'ws');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'cache-me.txt'), 'cached-content');
const fake = await startFakeProvider({
  async handler(req) {
    const msgs = req.messages;
    if (!req.stream) return textFrames('{"title":"t","gist":"g"}');
    const step = toolRepliesThisTurn(msgs);
    switch (scenarioOf(msgs)) {
      case 'SEARCH':
        if (step === 0) return toolCallFrames('tool_search', { query: 'read file' }, 's1');
        return textFrames('done');
      case 'EMPTY':
        if (step === 0) return toolCallFrames('tool_search', { query: 'zzqx frobnicate quux' }, 'e1');
        return textFrames('done');
      case 'LOAD':
        if (step === 0) return toolCallFrames('tool_load', { packs: ['files_read'] }, 'l1');
        return textFrames('done');
      case 'LIST':
        if (step === 0) return toolCallFrames('list_tools', {}, 'k1');
        return textFrames('done');
      case 'RETIER':
        if (step === 0) return toolCallFrames('tool_invoke_read', { name: 'file_write', arguments: { path: path.join(WS, 'retier-native.txt'), content: 'n' } }, 'r1');
        if (step === 1) return toolCallFrames('tool_invoke_read', { name: 'fake__write_file', arguments: { path: path.join(WS, 'retier-bridged.txt'), content: 'b' } }, 'r2');
        return textFrames('done');
      case 'CACHE':
        if (step === 0) return toolCallFrames('file_read', { path: path.join(WS, 'cache-me.txt') }, 'c1');
        if (step === 1) return toolCallFrames('file_read', { path: path.join(WS, 'cache-me.txt') }, 'c2');
        return textFrames('done');
      default: return textFrames('ok');
    }
  },
});
fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: WS, toolLoadingMode: 'auto', toolEconomicsShadowV1: true,
  bridgeExternalToolsToProvider: true, autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  externalMcpServers: [{ id: 'fake', label: 'Fake', command: process.execPath, args: [path.join(__dirname, 'fake-mcp.js')], enabled: true }],
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }] }],
  activeProvider: 'fake',
}));
let WP = 0;
let wb = null;
const request = (method, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: WP, path: p, method }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
  r.on('error', reject); r.end();
});
const startServer = async () => {
  WP = await getFreePort();
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, stdio: 'ignore', env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME } });
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { up = (await request('GET', '/health')) === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
  return up;
};
const stopServer = async () => {
  if (!wb) return;
  const exited = new Promise(resolve => { if (wb.exitCode !== null) resolve(); else wb.once('exit', resolve); });
  try { killOwnTree(wb.pid); } catch { /* gone */ }
  await Promise.race([exited, sleep(5000)]);
  wb = null;
};
const getText = p => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: WP, path: p, method: 'GET' }, res => { let buf = ''; res.setEncoding('utf8'); res.on('data', c => { buf += c; }); res.on('end', () => resolve(buf)); });
  r.on('error', reject); r.end();
});
const stream = payload => new Promise((resolve, reject) => {
  const raw = JSON.stringify(payload);
  const r = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
    let buf = ''; const evs = [];
    res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!l.trim()) continue; try { evs.push(JSON.parse(l)); } catch { /* skip */ } } });
    res.on('end', () => resolve(evs));
  });
  r.on('error', reject); r.write(raw); r.end();
});
const readLogs = () => {
  const dir = path.join(HOME, 'logs');
  const out = [];
  try {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ndjson'))) {
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* skip */ } } }
    }
  } catch { /* no logs yet */ }
  return out;
};
const waitLogs = async pred => {
  let logs = [];
  for (let i = 0; i < 25; i++) { logs = readLogs(); if (pred(logs)) break; await sleep(200); }
  return logs;
};
const reqsOf = scn => fake.requests.filter(r => r.stream && scenarioOf(r.messages) === scn);

try {
  ok(await startServer(), 'server up');

  // ── [T] 本地时间随 user 消息落历史 ──
  const timeEvs = await stream({ message: 'SCN-TIME 你好' });
  const sid = ((timeEvs.find(e => e && e.type === 'session') || {}).session || {}).id || '';
  ok(/^sess_/.test(sid), `T0 拿到会话 id(got ${sid})`);
  const t1 = reqsOf('TIME')[0];
  const t1Users = t1 ? t1.messages.filter(m => m.role === 'user').map(m => contentText(m.content)) : [];
  const t1Last = t1Users[t1Users.length - 1] || '';
  ok(TURN_TIME_RE.test(t1Last) && t1Last.includes('SCN-TIME 你好'), `T1 请求里这条 user 消息末尾带本地时间行(got …${JSON.stringify(t1Last.slice(-80))})`);
  const sessBody = parseJson(await getText('/api/sessions/' + sid));
  const sess = sessBody && sessBody.session;
  const shown = sess && Array.isArray(sess.messages) ? sess.messages.find(m => m.role === 'user') : null;
  ok(shown && shown.content === 'SCN-TIME 你好', `T2 界面消息不带时间行(got ${JSON.stringify(shown && shown.content)})`);
  await stream({ message: 'SCN-TIMETWO 继续', sessionId: sid });
  const t2 = reqsOf('TIMETWO')[0];
  const t2Users = t2 ? t2.messages.filter(m => m.role === 'user').map(m => contentText(m.content)) : [];
  ok(t2Users.length >= 2 && t2Users[t2Users.length - 2] === t1Last, 'T3 下一回合请求里上一轮那条 user 消息逐字节不变(时间落盘,不破前缀缓存)');
  ok(TURN_TIME_RE.test(t2Users[t2Users.length - 1] || ''), 'T4 新一轮 user 消息带它自己的时间行');

  // ── [S] 搜到即会调 + 冗余桥接标首选 ──
  await stream({ message: 'SCN-SEARCH 你好' });
  const sres = parseJson(toolMsg(reqsOf('SEARCH')[1], 's1'));
  const smatches = (sres && sres.matches) || [];
  const iNative = smatches.findIndex(m => m.name === 'file_read');
  const iBridged = smatches.findIndex(m => m.name === 'fake__read_file');
  ok(iNative >= 0 && iBridged >= 0, `S1 内置 file_read 与桥接 fake__read_file 都命中(got ${smatches.map(m => m.name).join(',')})`);
  ok(iBridged > iNative && smatches[iBridged].preferred === 'file_read' && smatches[iNative].preferred === undefined,
    `S2 桥接项带 preferred:file_read、排在内置项之后(got native@${iNative} bridged@${iBridged} ${JSON.stringify(smatches[iBridged])})`);
  const fr = smatches[iNative] || {};
  ok(typeof fr.args === 'string' && /\bpath\*:string/.test(fr.args) && !/…\(\+\d+/.test(fr.args) && /; /.test(fr.args),
    `S3 排在前面的未装载命中给 full 骨架(全部参数、不截断)(got ${JSON.stringify(fr.args)})`);
  const later = smatches.filter(m => typeof m.args === 'string' && m.preferred === undefined).slice(3);
  ok(later.every(m => !/ — /.test(m.args)), 'S4 前 3 个之后仍是 brief 骨架(不带用途说明)');

  // ── [E] 零命中给 note ──
  await stream({ message: 'SCN-EMPTY 你好' });
  const eres = parseJson(toolMsg(reqsOf('EMPTY')[1], 'e1'));
  ok(eres && Array.isArray(eres.matches) && eres.matches.length === 0 && /No dedicated tool matched/.test(eres.note || ''),
    `E1 零命中带 note(got ${JSON.stringify(eres).slice(0, 300)})`);

  // ── [L] tool_load 如实点名没装的桥接工具 ──
  await stream({ message: 'SCN-LOAD 你好' });
  const lres = parseJson(toolMsg(reqsOf('LOAD')[1], 'l1'));
  ok(lres && lres.ok === true && lres.bridgedNotLoaded && Array.isArray(lres.bridgedNotLoaded.files_read) && lres.bridgedNotLoaded.files_read.includes('fake__read_file') && /精确名/.test(lres.hint || ''),
    `L1 包里没装的桥接工具被点名 + 给拿法(got ${JSON.stringify(lres).slice(0, 400)})`);
  ok(lres && Array.isArray(lres.loaded) && lres.loaded.includes('file_read') && !lres.loaded.includes('fake__read_file'), 'L2 内置工具照常随包装上,桥接工具不随包装');

  // ── [K] list_tools 带 tiers ──
  await stream({ message: 'SCN-LIST 你好' });
  const kres = parseJson(toolMsg(reqsOf('LIST')[1], 'k1'));
  ok(kres && kres.tiers && Array.isArray(kres.tiers.edit) && kres.tiers.edit.includes('file_write') && Array.isArray(kres.tiers.exec) && kres.tiers.exec.includes('powershell_run') && !('read' in kres.tiers),
    `K1 list_tools 按档列出非 read 的名字(got ${JSON.stringify(kres && kres.tiers).slice(0, 300)})`);

  // ── [R] 代理档低报只升不降地改道 ──
  await stream({ message: 'SCN-RETIER 你好' });
  const rreqs = reqsOf('RETIER');
  const r1 = toolMsg(rreqs[1], 'r1');
  ok(fs.existsSync(path.join(WS, 'retier-native.txt')) && !/tier-mismatch/.test(r1), `R1 tool_invoke_read{file_write} 改道后真的执行了(got ${r1.slice(0, 200)})`);
  const asst1 = rreqs[1] ? rreqs[1].messages.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)).pop() : null;
  const call1 = asst1 ? asst1.tool_calls.find(c => c.id === 'r1') : null;
  ok(call1 && call1.function.name === 'tool_invoke_edit', `R2 历史里记的是改写后的代理名(got ${call1 && call1.function.name})`);
  const r2 = toolMsg(rreqs[2], 'r2');
  ok(fs.existsSync(path.join(WS, 'retier-bridged.txt')) && !/tier-mismatch/.test(r2), `R3 桥接写目标按入参定档改道到 exec 后执行了(got ${r2.slice(0, 200)})`);
  const logs = await waitLogs(ls => ['r1', 'r2'].every(id => ls.some(e => e.kind === 'tool_call_completed' && e.toolCallId === id)));
  const lr1 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 'r1');
  const lr2 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 'r2');
  ok(lr1 && lr1.proxyRepair === 'retier' && lr1.name === 'tool_invoke_edit', `R4 埋点记 proxyRepair:retier(got ${JSON.stringify(lr1)})`);
  ok(lr2 && lr2.proxyRepair === 'retier' && lr2.name === 'tool_invoke_exec', `R5 桥接目标同样记 retier、走 exec 代理(got ${JSON.stringify(lr2)})`);

  // ── [C] 读缓存命中带说明 ──
  await stream({ message: 'SCN-CACHE 读取文件' });
  const creqs = reqsOf('CACHE');
  const c2 = parseJson(toolMsg(creqs[2], 'c2'));
  ok(c2 && c2.ok === true && c2.cacheHit && /unchanged since that read/.test(c2.cacheHit.note || ''), `C1 cacheHit 带说明(got ${JSON.stringify(c2 && c2.cacheHit)})`);
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  await stopServer();
  await fake.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}
t.done({ exit: true });
})();
