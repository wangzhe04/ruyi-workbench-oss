require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(代理壳还原 + 原生目标自动装载 + 会话工具表跨重启):真服务进程 + 脚本化假 provider,走主回合工具循环(09 runOpenAiTurn)。
// 背景:2026-10 真机复盘 4 天 86 次 tool_invoke_* 调用,目标 100% 是分包没装上的原生工具,失败几乎全在 {name, arguments} 这层壳上;
// 又实测工具表在会话中途每变一次,提供方的前缀缓存就整段失效(命中率 97%→3%)。
//   [P1] 目标名塞进 arguments 的壳({arguments:{name:'file_list',arguments:{}}})在入批处还原:真的执行了,下一发请求里
//        assistant.tool_calls 的 arguments 已是正统形状(模型照着历史抄就不再错)。
//   [P2] 代理到没装载的原生工具 → 下一发的工具表里出现它【所在的整个包】(一次断缓存装齐),结果上附 proxyNote;第一发里它不在。
//   [P3] 已装载的工具还走代理 → 照常执行,结果上附「已在你的工具表里」的提醒。
//   [P4] tool_call_completed 带 proxyTarget / proxyRepair;提升记 tool_proxy_promoted(带包名);冻结表追加带 addedBy;
//        工具表变化后那一发记 tool_schema_changed(前后工具数 + 那一发的输入 / 命中缓存 token)。
//   [P5] 自套娃的壳({name:'tool_invoke_read', arguments:{name, arguments}})同样还原并执行(修前回 control-plane 拒绝)。
//   [P6] 起手工具:第一发里就有 web_search / web_fetch / powershell_run。
//   [P7] 会话工具表跨重启:重启服务后同一会话的下一回合,第一发的工具表与重启前最后一发【逐项同序】(提供方缓存接得上),
//        并记一条 tool_schema_freeze state:'restore'。
//   [P8] 代叫「叫得对」:tool_search 的目录卡带参数骨架;照着漏了必填去代叫 → 不执行、错误里递完整骨架(argsGuide)、
//        埋点记 argsGuided;改对后执行成功。
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
const t = createRunner('TOOL INVOKE PROMOTE');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
const scenarioOf = messages => {
  const tagged = messages.filter(m => m && m.role === 'user' && /SCN-[A-Z0-9]+/.test(contentText(m.content)));
  const m = tagged.length ? /SCN-([A-Z0-9]+)/.exec(contentText(tagged[tagged.length - 1].content)) : null;
  return m ? m[1] : '';
};
// 本回合(最后一条带 SCN 的 user 之后)已经回了几条 tool 结果 —— 用它决定这一发回第几步。
const toolRepliesThisTurn = messages => {
  const lastUser = messages.map(m => m && m.role === 'user' && /SCN-/.test(contentText(m.content))).lastIndexOf(true);
  return messages.slice(lastUser + 1).filter(m => m && m.role === 'tool').length;
};
const toolNames = req => (req.tools || []).map(x => x && x.function && x.function.name).filter(Boolean);

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-tool-invoke-promote-'));
const WS = path.join(HOME, 'ws');
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, 'marker-promote.txt'), 'x');
const fake = await startFakeProvider({
  async handler(req) {
    const msgs = req.messages;
    if (!req.stream) return textFrames('{"title":"t","gist":"g"}');
    const step = toolRepliesThisTurn(msgs);
    switch (scenarioOf(msgs)) {
      case 'PROMOTE':
        if (step === 0) return toolCallFrames('tool_invoke_read', { arguments: { name: 'file_list', arguments: {} } }, 'p1');   // 名字塞进了 arguments
        if (step === 1) return toolCallFrames('tool_invoke_read', { name: 'file_list', arguments: {} }, 'p2');                  // 已提升后仍走代理
        return textFrames('done');
      case 'SELFWRAP':
        if (step === 0) return toolCallFrames('tool_invoke_exec', { name: 'tool_invoke_read', arguments: { name: 'git_status', arguments: {} } }, 's1');
        return textFrames('done');
      case 'GUIDE':   // 搜 → 照目录卡漏了一个必填去代叫 → 拿到骨架 → 改对
        if (step === 0) return toolCallFrames('tool_search', { query: 'zip archive' }, 'g1');
        if (step === 1) return toolCallFrames('tool_invoke_edit', { name: 'archive_zip', arguments: { dest: path.join(WS, 'guide.zip') } }, 'g2');
        if (step === 2) return toolCallFrames('tool_invoke_edit', { name: 'archive_zip', arguments: { paths: [path.join(WS, 'marker-promote.txt')], dest: path.join(WS, 'guide.zip') } }, 'g3');
        return textFrames('done');
      default: return textFrames('default');
    }
  },
});
fs.mkdirSync(path.join(HOME, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: WS, toolLoadingMode: 'auto', toolEconomicsShadowV1: true,
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
  let out = [];
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

try {
  ok(await startServer(), 'server up');

  // ── PROMOTE ──
  // 消息里不带任何分包关键词:files_read 包不装,file_list 只能经代理触达。
  const promoteEvs = await stream({ message: 'SCN-PROMOTE 你好' });
  const sessEv = promoteEvs.find(e => e && e.type === 'session' && e.session && e.session.id);
  const promoteSessionId = sessEv ? sessEv.session.id : '';
  ok(/^sess_/.test(promoteSessionId), `拿到会话 id(got ${promoteSessionId})`);
  const reqs = fake.requests.filter(r => r.stream && scenarioOf(r.messages) === 'PROMOTE');
  ok(reqs.length === 3, `PROMOTE 三发请求(got ${reqs.length})`);
  const [r1, r2, r3] = reqs;
  ok(r1 && ['web_search', 'web_fetch', 'powershell_run'].every(n => toolNames(r1).includes(n)), `P6 第一发就带起手工具(got ${r1 && toolNames(r1).join(',')})`);
  ok(r1 && toolNames(r1).includes('tool_invoke_read') && !toolNames(r1).includes('file_list'), `P2 第一发工具表里没有 file_list(got ${r1 && toolNames(r1).join(',')})`);
  ok(r2 && toolNames(r2).includes('file_list') && toolNames(r2).includes('glob') && toolNames(r2).includes('file_read'), `P2 代理调过之后,第二发里有 file_list 所在的整个 files_read 包(got ${r2 && toolNames(r2).join(',')})`);
  ok(r2 && r1 && toolNames(r2).slice(0, toolNames(r1).length).join(',') === toolNames(r1).join(','), 'P2 新装的只追加在尾部,原有顺序不变');
  const asst = r2 ? r2.messages.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)) : [];
  const call1 = asst.length ? asst[asst.length - 1].tool_calls.find(c => c.id === 'p1') : null;
  let canon = null; try { canon = JSON.parse(call1.function.arguments); } catch { /* fail below */ }
  ok(canon && canon.name === 'file_list' && canon.arguments && typeof canon.arguments === 'object', `P1 历史里的 arguments 已还原成正统形状(got ${call1 && call1.function.arguments})`);
  const tool1 = r2 ? contentText((r2.messages.find(m => m.role === 'tool' && m.tool_call_id === 'p1') || {}).content) : '';
  ok(/marker-promote\.txt/.test(tool1) && !/missing required/.test(tool1), `P1 还原后真的执行了 file_list(got ${tool1.slice(0, 200)})`);
  ok(/已装载为直接工具/.test(tool1) && /同包的/.test(tool1), `P2 结果上附提升提示、点明同包也装了(got ${tool1.slice(0, 300)})`);
  const tool2 = r3 ? contentText((r3.messages.find(m => m.role === 'tool' && m.tool_call_id === 'p2') || {}).content) : '';
  ok(/marker-promote\.txt/.test(tool2) && /已在你的工具表里/.test(tool2), `P3 已装载还走代理:照常执行 + 提醒直调(got ${tool2.slice(0, 300)})`);

  // ── SELFWRAP ──(新会话;git_status 在 code 包,不在起手 / 分包里)
  await stream({ message: 'SCN-SELFWRAP 你好' });
  const sreqs = fake.requests.filter(r => r.stream && scenarioOf(r.messages) === 'SELFWRAP');
  const sLast = sreqs[sreqs.length - 1];
  const stool = sLast ? contentText((sLast.messages.find(m => m.role === 'tool' && m.tool_call_id === 's1') || {}).content) : '';
  // 工作区不是 Git 仓库:git_status 回它自己的「还不是 Git 仓库」—— 这正说明壳被还原、真的跑到了目标。
  ok(/Git 仓库/.test(stool) && !/control-plane/.test(stool) && !/missing required/.test(stool), `P5 自套娃的壳还原后跑到了 git_status(got ${stool.slice(0, 200)})`);

  // ── GUIDE ──(代叫「叫得对」:目录卡带骨架 → 叫错递完整骨架 → 改对)
  await stream({ message: 'SCN-GUIDE 你好' });
  const greqs = fake.requests.filter(r => r.stream && scenarioOf(r.messages) === 'GUIDE');
  const toolMsg = (req, id) => (req ? contentText((req.messages.find(m => m.role === 'tool' && m.tool_call_id === id) || {}).content) : '');
  const searchCard = toolMsg(greqs[1], 'g1');
  ok(/"name":"archive_zip"/.test(searchCard) && /"args":"paths\*:array<string>, dest\*:string/.test(searchCard), `P8 tool_search 的目录卡带参数骨架(got ${searchCard.slice(0, 400)})`);
  const wrong = toolMsg(greqs[2], 'g2');
  ok(/invalid-arguments/.test(wrong) && /missing required 'paths'/.test(wrong) && /"argsGuide":"paths\*:array<string>/.test(wrong),
    `P8 漏了必填:不执行(校验在执行前),错误里递完整骨架(got ${wrong.slice(0, 400)})`);
  const fixed = toolMsg(greqs[3], 'g3');
  ok(!/invalid-arguments/.test(fixed) && fs.existsSync(path.join(WS, 'guide.zip')), `P8 照骨架改对后执行成功(got ${fixed.slice(0, 300)})`);

  // ── 埋点 ──
  let logs = await waitLogs(ls => ls.some(e => e.kind === 'tool_call_completed' && e.toolCallId === 's1') && ls.some(e => e.kind === 'tool_call_completed' && e.toolCallId === 'g3'));
  const g2 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 'g2');
  ok(g2 && g2.errorCode === 'invalid-arguments' && g2.argsGuided === true && g2.proxyTarget === 'archive_zip', `P8 叫错那次记 argsGuided(got ${JSON.stringify(g2)})`);
  const g3 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 'g3');
  ok(g3 && g3.status === 'completed' && g3.argsGuided === undefined, `P8 叫对那次不记 argsGuided(got ${JSON.stringify(g3)})`);
  const c1 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 'p1');
  ok(c1 && c1.proxyTarget === 'file_list' && c1.proxyRepair === 'nested_name' && c1.proxyTargetTier === 'read', `P4 tool_call_completed 带代理目标与还原类型(got ${JSON.stringify(c1)})`);
  const c2 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 'p2');
  ok(c2 && c2.proxyTarget === 'file_list' && c2.proxyRepair === undefined, `P4 正统形状不标 proxyRepair(got ${JSON.stringify(c2)})`);
  const s1 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 's1');
  ok(s1 && s1.proxyTarget === 'git_status' && s1.proxyRepair === 'self_wrap', `P4 自套娃记 self_wrap(got ${JSON.stringify(s1)})`);
  const promoted = logs.find(e => e.kind === 'tool_proxy_promoted' && e.tool === 'file_list');
  ok(promoted && promoted.pack === 'files_read' && promoted.loaded > 1, `P4 提升记 tool_proxy_promoted,按包装(got ${JSON.stringify(promoted)})`);
  const append = logs.find(e => e.kind === 'tool_schema_freeze' && e.state === 'append' && e.sessionId === promoteSessionId && e.addedBy && e.addedBy.proxy_promote);
  ok(append && append.added.includes('file_list'), `P4 冻结表追加按原因分桶(got ${JSON.stringify(append)})`);
  const initAppend = logs.find(e => e.kind === 'tool_schema_freeze' && e.state === 'append' && e.sessionId === promoteSessionId && e.addedBy && e.addedBy.starter);
  ok(initAppend && initAppend.addedBy.starter === 3, `P4 回合开头的追加里起手工具单独成桶(got ${JSON.stringify(initAppend && initAppend.addedBy)})`);
  const changed = logs.find(e => e.kind === 'tool_schema_changed' && e.sessionId === promoteSessionId);
  ok(changed && changed.tools > changed.prevTools && changed.added.includes('file_list') && Number.isFinite(changed.inputTokens), `P4 工具表变化后那一发记 tool_schema_changed(got ${JSON.stringify(changed)})`);

  // ── 重启后同一会话:工具表原序恢复 ──
  const lastBefore = toolNames(r3);
  await stopServer();
  ok(await startServer(), 'server up again after restart');
  await stream({ message: 'SCN-AFTER 继续', sessionId: promoteSessionId });
  const after = fake.requests.filter(r => r.stream && scenarioOf(r.messages) === 'AFTER');
  ok(after.length >= 1 && toolNames(after[0]).join(',') === lastBefore.join(','),
    `P7 重启后第一发的工具表与重启前最后一发逐项同序(before ${lastBefore.length}: ${lastBefore.join(',')} | after ${after.length ? toolNames(after[0]).join(',') : '-'})`);
  logs = await waitLogs(ls => ls.some(e => e.kind === 'tool_schema_freeze' && e.state === 'restore' && e.sessionId === promoteSessionId));
  const restore = logs.find(e => e.kind === 'tool_schema_freeze' && e.state === 'restore' && e.sessionId === promoteSessionId);
  ok(restore && restore.count === lastBefore.length, `P7 记一条 restore(got ${JSON.stringify(restore)})`);
  let head = null; try { head = JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', `${promoteSessionId}.json`), 'utf8')); } catch { /* fail below */ }
  ok(head && Array.isArray(head.toolSchemaNames) && head.toolSchemaNames.join(',') === lastBefore.join(','), `P7 会话头上记着这张表(got ${head && JSON.stringify(head.toolSchemaNames)})`);
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  await stopServer();
  await fake.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}
t.done({ exit: true });
})();
