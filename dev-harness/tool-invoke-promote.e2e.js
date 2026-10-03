require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(代理壳还原 + 原生目标自动提升):真服务进程 + 脚本化假 provider,走主回合工具循环(09 runOpenAiTurn)。
// 背景:2026-10 真机复盘 4 天 86 次 tool_invoke_* 调用,目标 100% 是分包没装上的原生工具,失败几乎全在 {name, arguments} 这层壳上。
//   [P1] 目标名塞进 arguments 的壳({arguments:{name:'file_list',arguments:{}}})在入批处还原:真的执行了,下一发请求里
//        assistant.tool_calls 的 arguments 已是正统形状(模型照着历史抄就不再错)。
//   [P2] 代理到没装载的原生工具 → 下一发的工具表里出现它(隐式 tool_load),结果上附 proxyNote;第一发里它不在。
//   [P3] 已装载的工具还走代理 → 照常执行,结果上附「已在你的工具表里」的提醒。
//   [P4] tool_call_completed 带 proxyTarget / proxyRepair;提升记一条 tool_proxy_promoted。
//   [P5] 自套娃的壳({name:'tool_invoke_read', arguments:{name, arguments}})同样还原并执行(修前回 control-plane 拒绝)。
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
const WP = await getFreePort();
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
        if (step === 0) return toolCallFrames('tool_invoke_exec', { name: 'tool_invoke_read', arguments: { name: 'glob', arguments: { pattern: '*.txt' } } }, 's1');
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
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, stdio: 'ignore', env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME } });
const request = (method, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: WP, path: p, method }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
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
  let out = [];
  try {
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.ndjson'))) {
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (l.trim()) { try { out.push(JSON.parse(l)); } catch { /* skip */ } } }
    }
  } catch { /* no logs yet */ }
  return out;
};

try {
  let up = false;
  for (let i = 0; i < 300 && !up; i++) { try { up = (await request('GET', '/health')) === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
  ok(up, 'server up');

  // ── PROMOTE ──
  // 消息里不带任何分包关键词:files_read 包不装,file_list 只能经代理触达。
  await stream({ message: 'SCN-PROMOTE 你好' });
  const reqs = fake.requests.filter(r => r.stream && scenarioOf(r.messages) === 'PROMOTE');
  ok(reqs.length === 3, `PROMOTE 三发请求(got ${reqs.length})`);
  const [r1, r2, r3] = reqs;
  ok(r1 && toolNames(r1).includes('tool_invoke_read') && !toolNames(r1).includes('file_list'), `P2 第一发工具表里没有 file_list(got ${r1 && toolNames(r1).join(',')})`);
  ok(r2 && toolNames(r2).includes('file_list'), `P2 代理调过之后,第二发工具表里有 file_list(got ${r2 && toolNames(r2).join(',')})`);
  const asst = r2 ? r2.messages.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)) : [];
  const call1 = asst.length ? asst[asst.length - 1].tool_calls.find(c => c.id === 'p1') : null;
  let canon = null; try { canon = JSON.parse(call1.function.arguments); } catch { /* fail below */ }
  ok(canon && canon.name === 'file_list' && canon.arguments && typeof canon.arguments === 'object', `P1 历史里的 arguments 已还原成正统形状(got ${call1 && call1.function.arguments})`);
  const tool1 = r2 ? contentText((r2.messages.find(m => m.role === 'tool' && m.tool_call_id === 'p1') || {}).content) : '';
  ok(/marker-promote\.txt/.test(tool1) && !/missing required/.test(tool1), `P1 还原后真的执行了 file_list(got ${tool1.slice(0, 200)})`);
  ok(/已装载为直接工具/.test(tool1) && /file_list/.test(tool1), `P2 结果上附提升提示(got ${tool1.slice(0, 300)})`);
  const tool2 = r3 ? contentText((r3.messages.find(m => m.role === 'tool' && m.tool_call_id === 'p2') || {}).content) : '';
  ok(/marker-promote\.txt/.test(tool2) && /已在你的工具表里/.test(tool2), `P3 已装载还走代理:照常执行 + 提醒直调(got ${tool2.slice(0, 300)})`);

  // ── SELFWRAP ──
  await stream({ message: 'SCN-SELFWRAP 你好' });
  const sreqs = fake.requests.filter(r => r.stream && scenarioOf(r.messages) === 'SELFWRAP');
  const sLast = sreqs[sreqs.length - 1];
  const stool = sLast ? contentText((sLast.messages.find(m => m.role === 'tool' && m.tool_call_id === 's1') || {}).content) : '';
  ok(/marker-promote\.txt/.test(stool) && !/control-plane/.test(stool), `P5 自套娃的壳还原后执行了 glob(got ${stool.slice(0, 200)})`);

  // ── 埋点 ──
  let logs = [];
  for (let i = 0; i < 25; i++) { logs = readLogs(); if (logs.some(e => e.kind === 'tool_call_completed' && e.toolCallId === 's1')) break; await sleep(200); }
  const c1 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 'p1');
  ok(c1 && c1.proxyTarget === 'file_list' && c1.proxyRepair === 'nested_name' && c1.proxyTargetTier === 'read', `P4 tool_call_completed 带代理目标与还原类型(got ${JSON.stringify(c1)})`);
  const c2 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 'p2');
  ok(c2 && c2.proxyTarget === 'file_list' && c2.proxyRepair === undefined, `P4 正统形状不标 proxyRepair(got ${JSON.stringify(c2)})`);
  const s1 = logs.find(e => e.kind === 'tool_call_completed' && e.toolCallId === 's1');
  ok(s1 && s1.proxyTarget === 'glob' && s1.proxyRepair === 'self_wrap', `P4 自套娃记 self_wrap(got ${JSON.stringify(s1)})`);
  ok(logs.some(e => e.kind === 'tool_proxy_promoted' && e.tool === 'file_list'), 'P4 提升记一条 tool_proxy_promoted');
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  try { killOwnTree(wb.pid); } catch { /* gone */ }
  await fake.close();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}
t.done({ exit: true });
})();
