#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// E2E(W7 · 用户 2026-09-24):
//   「如果是如意自己开的工作区,默认不显示在常用工作区中,不要让用户自己感知到;然后管家需要把工作区和
//    任务联系起来,有时候很多任务应该在特定工作区开的,管家会新开工作区」
//
// 根因(13k 文件头有全文):① 管家上下文里只给末段名,cwd 校验却只收绝对路径 —— 模型照清单填回来的名字
// 一律被拒,只能省掉 cwd;② 省掉 cwd 时没有任何「沿用」,同一事项、接着某条线程的活也照样按标题新开;
// ③ 新开的文件夹被追加进 workspaces[](= 界面上的常用工作区)。
//
// 本件一律走【真回合 + 真工具循环】:管家回合由 runStewardTurn({trigger:'user'}) 起,开线程的工具由
// fake provider 按脚本在工具循环里调 —— 断的是模型真正拿到的回执(下一次请求体里的 role:'tool')与
// 落盘的会话头/配置,不直调工具、不手工塞 ctx。
//
// 覆盖:
//   (A) 同一事项里已有线程在 /ws/A,管家不带 cwd 开新线程 → 新线程 cwd 为 /ws/A(cwdSource:mission_thread),
//       事项容器随之记下这个工作区;之后同事项再开 → 直接用事项记着的(cwdSource:mission)。
//   (B) 用户明确给的目录优先:同一事项里给 cwd = 另一个工作区的【名字】→ 用它(cwdSource:explicit)。
//   (C) relatedSessionId:接着某条线程的活 → 沿用那条线程的目录;id 不是线程 → not_found,不静默回落。
//   (D) 都不沾边 → 在 Ruyi 根下新开,登记进如意自己那张表,【不】进常用工作区;老版本塞进常用工作区的
//       那一行(带老备注)读配置时被挪回如意那张表;数据目录与如意那张表里的目录不出现在常用工作区里,
//       前端的显示函数(util.js)也把它们滤掉,用户自己的工作区照常出现。
//   (E) 管家真正收到的提示词里有「已知工作区」清单:每行带最近的线程名与所属事项、默认标;清单受预算
//       约束(行数 ≤ 20、每行 ≤ 3 条线程、整块有字数上限,超出折叠成一句)。
//   (F) 读模型带出工作区:steward_thread_status 的 workspace {name, ruyiOwned}、steward_missions 的名字。
//
// 判定行:`STEWARD WORKSPACE AFFINITY E2E: ALL PASS`。
(async () => {
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { pathToFileURL } = require('url');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-ws-'));
// 数据目录与工作区【分开】放:数据目录里的路径按定义算如意自己的(不沿用、不当常用工作区显示)。
const DATA = path.join(TMP, 'data');
const WS_DEF = path.join(TMP, 'ws', 'default');
const WS_A = path.join(TMP, 'ws', 'A');
const WS_B = path.join(TMP, 'ws', 'B');
const RUYI_ROOT = path.join(TMP, 'Ruyi');
const LEGACY = path.join(RUYI_ROOT, '老版本开的');
for (const d of [DATA, WS_DEF, WS_A, WS_B, LEGACY]) fs.mkdirSync(d, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const PROVIDER_PORT = await getFreePort();

// ── fake provider:管家回合按 stewardScript 依次弹({tool,args} = 发一个 tool_call;字符串 = 最终正文);
// 线程回合一律回一句话收尾。
let stewardScript = [];
const providerBodies = [];
const providerServer = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if ((req.url || '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"data":[{"id":"fake-model"}]}');
  }
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch { body = {}; }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const sys = messages.filter(m => m && m.role === 'system').map(m => String(m.content || '')).join('\n');
  const isSteward = /我是如意/.test(sys);
  providerBodies.push({ isSteward, messages });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* gone */ } };
  const done = () => { try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* gone */ } };
  const emitToolCall = (id, name, args) => {
    sse({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: '' } }] }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
  };
  const emitText = text => {
    sse({ choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    sse({ choices: [], usage: { prompt_tokens: 8, completion_tokens: 4 } });
  };
  if (isSteward) {
    const step = stewardScript.length ? stewardScript.shift() : JSON.stringify({ say: '好。', why: '', acts: [], actions: [] });
    if (step && typeof step === 'object' && step.tool) { emitToolCall('call_' + step.tool + '_' + providerBodies.length, step.tool, step.args || {}); return done(); }
    emitText(String(step));
    return done();
  }
  emitText('好的,照办。');
  return done();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

// ── config ──
const base = `http://127.0.0.1:${PROVIDER_PORT}`;
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({
  configSchema: 11, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, recentWorkspaces: [WS_A],
  workspaces: [
    { path: WS_DEF, read: true, write: true, execute: true },
    { path: WS_A, read: true, write: true, execute: true },
    { path: WS_B, read: true, write: true, execute: true },
    // 老版本(117w-W1 ②)派生时追加进常用工作区的一行,带着老备注 —— 读配置时要被挪回如意那张表。
    { path: LEGACY, read: true, write: true, execute: true, note: 'Ruyi 自动开的' },
  ],
  stewardWorkspaceRoot: RUYI_ROOT,
  subagentMaxPerTurn: 0, killOnDisconnect: false, locale: 'zh-CN',
  stewardEnabledV1: true, stewardPollMs: 120000, stewardMaxTurnsPerHour: 500, stewardMaxCostPerDay: 0,
  stewardGlobalMaxTurnsPerHour: 2000, stewardGlobalMaxCostPerDay: 0,
  stewardProviderId: 'fake', stewardModel: 'fake-model', stewardThreadBriefV1: false, autoImportClaudeCodeMcp: false,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: base, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');

process.env.RUYI_HOME = DATA;
process.env.WIN_CLAUDE_WORKBENCH_HOME = DATA;
const srv = require(SERVER);

// ── 小工具 ──
const headOf = sid => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'sessions', sid + '.json'), 'utf8')); } catch { return null; } };
const diskConfig = () => JSON.parse(fs.readFileSync(path.join(DATA, 'config.json'), 'utf8'));
const same = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();
// 管家这一回合调工具拿到的【真实回执】:以 role:'tool' 出现在下一次管家请求里。since 是水位线 ——
// 回合没跑时往回找会捡到上一轮的回执,那种绿是假的。
function lastToolResult(toolName, since) {
  for (let i = providerBodies.length - 1; i >= Math.max(0, Number(since) || 0); i--) {
    const b = providerBodies[i];
    if (!b.isSteward) continue;
    const wanted = new Set();
    for (const m of b.messages) if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (c && c.function && c.function.name === toolName) wanted.add(String(c.id || ''));
    if (!wanted.size) continue;
    const results = b.messages.filter(m => m && m.role === 'tool' && wanted.has(String(m.tool_call_id || '')));
    if (!results.length) continue;
    try { return JSON.parse(String(results[results.length - 1].content || '')); } catch { return null; }
  }
  return null;
}
async function stewardDoes(tool, args, message) {
  const mark = providerBodies.length;
  stewardScript = [{ tool, args }, JSON.stringify({ say: '好,我开条线程去办。', why: '用户刚说的', acts: [], actions: [] })];
  await srv.runStewardTurn({ trigger: 'user', message: message || '办一下' });
  return lastToolResult(tool, mark);
}
// 线程回合是后台跑的:等它收尾,免得下一段的管家回合与它抢事件循环里的写锁/配额。
async function settle(sid) {
  for (let i = 0; i < 100; i++) {
    const s = await srv.loadSession(sid).catch(() => null);
    if (s && (s.messages || []).some(m => m.role === 'assistant')) return;
    await sleep(60);
  }
}

try {
  /* ═════════ (A) 事项里已有线程在 /ws/A → 不带 cwd 开新线程就开在 /ws/A ═════════ */
  console.log('── (A) 事项继承 ──');
  const mission = await srv.createMissionContainer({ title: 'A 项目' });
  const missionId = mission && mission.ok ? mission.mission.missionId : '';
  ok(!!missionId && !mission.mission.cwd, 'A0 前提:建好事项「A 项目」,容器里还没有工作区');
  const old = await srv.createSession({ title: 'A 旧线程', cwd: WS_A });
  await srv.missionAttachThread(missionId, old.id);
  const a1 = await stewardDoes('steward_thread_new', { title: 'A 新活', missionId, brief: { userText: '把 A 项目的测试再跑一遍' } });
  const a1Head = a1 && a1.ok ? headOf(a1.sessionId) : null;
  ok(a1 && a1.ok === true && a1Head && same(a1Head.cwd, WS_A),
    `A1 同事项里已有线程在 /ws/A,管家不带 cwd 开新线程 → 新线程 cwd 为 /ws/A(got ${JSON.stringify(a1Head && a1Head.cwd)} / ${JSON.stringify(a1 && a1.error)})`);
  ok(a1 && a1.cwdSource === 'mission_thread' && a1.workspace === 'A', `A2 回执说清目录从哪来、叫什么(got ${JSON.stringify(a1 && [a1.cwdSource, a1.workspace])})`);
  const containerAfter = await srv.readMissionContainer(missionId);
  ok(containerAfter && same(containerAfter.cwd, WS_A), `A3 事项容器记下了这个工作区(got ${JSON.stringify(containerAfter && containerAfter.cwd)})`);
  if (a1 && a1.ok) await settle(a1.sessionId);
  // A4 —— 事项记着工作区之后:哪怕把老线程挪走,同事项再开仍用事项记着的那个。
  await srv.updateSessionMeta(old.id, { cwd: WS_B });
  const a4 = await stewardDoes('steward_thread_new', { title: 'A 再一件', missionId, brief: { userText: 'A 项目再加个功能' } });
  const a4Head = a4 && a4.ok ? headOf(a4.sessionId) : null;
  ok(a4 && a4.ok === true && a4Head && same(a4Head.cwd, WS_A) && a4.cwdSource === 'mission',
    `A4 事项容器记着的工作区优先于同事项线程(got ${JSON.stringify(a4Head && a4Head.cwd)} / ${JSON.stringify(a4 && a4.cwdSource)})`);
  if (a4 && a4.ok) await settle(a4.sessionId);
  ok(!(diskConfig().stewardManagedWorkspaces || []).some(m => String(m.path).includes('A 新活') || String(m.path).includes('A 再一件')),
    'A5 沿用时没有新开任何文件夹(如意那张表里没有这两条线程的派生目录)');
  ok(!fs.existsSync(path.join(RUYI_ROOT, 'A 新活')), 'A5b Ruyi 根下也没长出「A 新活」');

  /* ═════════ (B) 用户明确给的目录优先 ═════════ */
  console.log('── (B) 明确 cwd 优先 ──');
  const b1 = await stewardDoes('steward_thread_new', { title: 'A 项目的文档', missionId, cwd: 'B', brief: { userText: '文档放到 B 那个目录里写' } });
  const b1Head = b1 && b1.ok ? headOf(b1.sessionId) : null;
  ok(b1 && b1.ok === true && b1Head && same(b1Head.cwd, WS_B) && b1.cwdSource === 'explicit',
    `B1 明确给了 cwd(工作区的名字 B)→ 用它,事项记着的 A 让位(got ${JSON.stringify(b1Head && b1Head.cwd)} / ${JSON.stringify(b1 && b1.cwdSource)})`);
  if (b1 && b1.ok) await settle(b1.sessionId);
  const b2 = await stewardDoes('steward_quick_ask', { question: 'A 里现在有几个文件?', cwd: WS_A });
  ok(b2 && b2.ok === true && same((headOf(b2.sessionId) || {}).cwd, WS_A) && b2.cwdSource === 'explicit', 'B2 速查同一口径:给完整路径也认');
  if (b2 && b2.ok) await settle(b2.sessionId);
  const b3 = await stewardDoes('steward_thread_new', { title: '编的路径', cwd: path.join(TMP, 'made-up'), brief: { userText: 'x' } });
  ok(b3 && b3.ok === false && b3.error === 'invalid_request' && !fs.existsSync(path.join(TMP, 'made-up')),
    `B3 清单外的路径照旧拒、不建目录(got ${JSON.stringify(b3 && b3.error)})`);
  ok(b3 && /现有:[^。]*\bA\b/.test(String(b3.message || '')) && !String(b3.message || '').includes(WS_A),
    `B3b 拒绝文案列的是名字,不是全路径(got ${JSON.stringify(b3 && b3.message)})`);

  /* ═════════ (C) relatedSessionId ═════════ */
  console.log('── (C) 相关线程 ──');
  const bOld = await srv.createSession({ title: 'B 里的报表', cwd: WS_B });
  const c1 = await stewardDoes('steward_quick_ask', { question: '那张报表的合计是多少?', relatedSessionId: bOld.id });
  ok(c1 && c1.ok === true && same((headOf(c1.sessionId) || {}).cwd, WS_B) && c1.cwdSource === 'related',
    `C1 接着某条线程的活 → 开在那条线程的目录里(got ${JSON.stringify(c1 && [c1.cwdSource, (headOf(c1.sessionId) || {}).cwd])})`);
  if (c1 && c1.ok) await settle(c1.sessionId);
  const c2 = await stewardDoes('steward_thread_new', { title: '瞎指', relatedSessionId: 'sess_doesnotexist', brief: { userText: 'x' } });
  ok(c2 && c2.ok === false && c2.error === 'not_found', `C2 relatedSessionId 不是线程 → not_found,不静默回落(got ${JSON.stringify(c2 && c2.error)})`);
  // C3 —— 相关线程的目录在数据目录里(管家会话自己的 cwd 就是数据目录):不沿用,落到「新开」。
  const inData = await srv.createSession({ title: '数据目录里的', cwd: DATA });
  const c3 = await stewardDoes('steward_thread_new', { title: '别跟管家抢目录', relatedSessionId: inData.id, brief: { userText: 'x' } });
  const c3Head = c3 && c3.ok ? headOf(c3.sessionId) : null;
  ok(c3 && c3.ok === true && c3Head && !same(c3Head.cwd, DATA) && c3.cwdSource === 'new',
    `C3 数据目录不沿用(got ${JSON.stringify(c3Head && c3Head.cwd)} / ${JSON.stringify(c3 && c3.cwdSource)})`);
  if (c3 && c3.ok) await settle(c3.sessionId);

  /* ═════════ (D) 都不沾边 → 新开,且不出现在常用工作区 ═════════ */
  console.log('── (D) 新开的文件夹不进常用工作区 ──');
  const d1 = await stewardDoes('steward_thread_new', { title: '陕西菜调研', brief: { userText: '帮我查一下陕西菜有什么特色' } });
  const d1Head = d1 && d1.ok ? headOf(d1.sessionId) : null;
  const d1Want = path.join(RUYI_ROOT, '陕西菜调研');
  ok(d1 && d1.ok === true && d1Head && same(d1Head.cwd, d1Want) && d1.cwdSource === 'new' && fs.existsSync(d1Want),
    `D1 都不沾边 → 在 Ruyi 根下按标题新开(got ${JSON.stringify(d1Head && d1Head.cwd)})`);
  if (d1 && d1.ok) await settle(d1.sessionId);
  {
    const cfg = srv.normalizeConfig(diskConfig()).config;
    const fav = cfg.workspaces.map(w => w.path);
    const managed = (cfg.stewardManagedWorkspaces || []).map(m => m.path);
    ok(!fav.some(p => same(p, d1Want)) && managed.some(p => same(p, d1Want)),
      `D2 新开的文件夹登记在如意那张表里,不在常用工作区(常用 ${JSON.stringify(fav)})`);
    ok(!fav.some(p => same(p, LEGACY)) && managed.some(p => same(p, LEGACY)),
      'D3 老版本塞进常用工作区的那一行(带「Ruyi 自动开的」)被挪回如意那张表');
    ok(fav.length === 3 && [WS_DEF, WS_A, WS_B].every(p => fav.some(q => same(q, p))),
      `D4 用户自己的三个工作区照常在(got ${JSON.stringify(fav)})`);
    ok(!(cfg.recentWorkspaces || []).some(p => managed.some(m => same(m, p))) && !(cfg.recentWorkspaces || []).some(p => same(p, DATA)),
      'D5 近期工作区里也没有如意的目录(工作台从不往里写)');
    // D6 —— 前端「常用工作区」的显示函数(public/js/util.js,顶栏弹层与文件页快捷条都经它):
    // 把数据目录里的、如意那张表里的都滤掉,用户的照常出现。喂的是【盘上这份配置】。
    const util = await import(pathToFileURL(path.join(ROOT, 'ruyi-workbench', 'app', 'public', 'js', 'util.js')).href);
    const shown = util.visibleFavoriteWorkspaces(
      [...cfg.workspaces, { path: path.join(DATA, 'agent-worktrees', 'run_x') }, { path: d1Want }],
      { dataRoot: DATA, owned: cfg.stewardManagedWorkspaces },
    ).map(w => w.path);
    ok(shown.length === 3 && [WS_DEF, WS_A, WS_B].every(p => shown.some(q => same(q, p))),
      `D6 前端显示函数:数据目录与如意的目录不显示,用户的三个照常(got ${JSON.stringify(shown)})`);
  }
  // D7 —— 新开的那个文件夹立刻成为已知工作区:用它的名字就能再派活进去(闭环)。
  const d7 = await stewardDoes('steward_thread_new', { title: '陕西菜第二篇', cwd: '陕西菜调研', brief: { userText: '接着写第二篇' } });
  ok(d7 && d7.ok === true && same((headOf(d7.sessionId) || {}).cwd, d1Want), 'D7 如意开的文件夹用名字就能派回去');
  if (d7 && d7.ok) await settle(d7.sessionId);

  /* ═════════ (E) 提示词里的已知工作区清单 ═════════ */
  console.log('── (E) 已知工作区清单 ──');
  {
    const mark = providerBodies.length;
    stewardScript = [JSON.stringify({ say: '在。', why: '', acts: [], actions: [] })];
    await srv.runStewardTurn({ trigger: 'user', message: '现在都在忙什么' });
    const req = providerBodies.slice(mark).find(b => b.isSteward) || { messages: [] };
    const sysText = req.messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n');
    const userText = req.messages.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n');
    const block = (userText.split('\n\n').find(seg => seg.startsWith('已知工作区(')) || '');
    const rowOf = name => (block.split('\n').find(l => l.startsWith('· ' + name + '(') || l.startsWith('· ' + name + ':') || l === '· ' + name) || '');
    ok(!!block && !sysText.includes('已知工作区('), 'E1 管家真正收到的请求里有「已知工作区」清单,且在易变层(不在 system)');
    ok(rowOf('default').includes('(默认'), `E2 默认工作区标「默认」(got ${JSON.stringify(rowOf('default'))})`);
    ok(rowOf('A').includes('「A 再一件」') && rowOf('A').includes('(事项「A 项目」)'),
      `E3 每行带最近在那儿做过的线程名与所属事项(got ${JSON.stringify(rowOf('A'))})`);
    ok(rowOf('陕西菜调研').includes('我开的'), `E4 如意自己开的文件夹标「我开的」(got ${JSON.stringify(rowOf('陕西菜调研'))})`);
    ok(!block.includes(TMP) && !block.includes(DATA), 'E5 清单里零全路径(围栏信息不进上下文)');
    ok(block.includes('relatedSessionId') && block.includes('missionId'), 'E6 清单尾巴给出选目录的顺序');
  }
  // E7 —— 预算:30 个工作区、每个都有 4 条长标题的线程 → 至多 20 行、每行至多 3 条线程、整块有上限、超出折叠。
  {
    const many = [];
    for (let i = 1; i <= 30; i++) {
      const dir = path.join(TMP, 'many', 'w' + String(i).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      many.push({ path: dir, read: true, write: true, execute: true });
      for (let j = 1; j <= 4; j++) await srv.createSession({ title: `第 ${i} 号工作区里一条标题相当长相当长相当长的线程 ${j}`, cwd: dir });
    }
    const cfgMany = { ...srv.normalizeConfig(diskConfig()).config, workspaces: many, defaultWorkspace: many[0].path };
    const built = await srv.buildStewardSystemPrompt({ id: 'steward', kind: 'steward', providerHistory: [] }, cfgMany, {});
    const block = (String(built.volatile).split('\n\n').find(seg => seg.startsWith('已知工作区(')) || '');
    const rows = block.split('\n').filter(l => l.startsWith('· '));
    const rowChars = rows.reduce((n, l) => n + l.length + 1, 0);
    ok(rows.length > 0 && rows.length <= 20, `E7 行数受上限约束(got ${rows.length})`);
    ok(rows.every(l => (l.match(/「/g) || []).length <= 3), 'E7b 每行至多 3 条线程');
    ok(rows.every(l => l.length <= 260) && rowChars <= 2400, `E7c 每行 ≤ 260 字、整块行合计 ≤ 2400 字(got ${rowChars})`);
    ok(/…另有 \d+ 个工作区未列出/.test(block), `E7d 超出的折叠成一句,不截断(got ${JSON.stringify(block.split('\n').find(l => l.includes('未列出')) || '(无)')})`);
    ok(rows.every(l => !l.endsWith('…') || l.length === 260), 'E7e 行尾不出现半截话(砍的是整条线程,不是半个名字)');
  }

  /* ═════════ (F) 读模型带出工作区 ═════════ */
  console.log('── (F) 读模型 ──');
  {
    const ctx = { session: { id: 'steward', kind: 'steward', providerHistory: [] }, sessionId: 'steward' };
    const st1 = await srv.toolCall('steward_thread_status', { sessionId: d1.sessionId }, ctx);
    ok(st1 && st1.ok === true && st1.workspace && st1.workspace.name === '陕西菜调研' && st1.workspace.ruyiOwned === true,
      `F1 thread_status 带 workspace,如意开的标 ruyiOwned(got ${JSON.stringify(st1 && st1.workspace)})`);
    const st2 = await srv.toolCall('steward_thread_status', { sessionId: a1.sessionId }, ctx);
    ok(st2 && st2.workspace && st2.workspace.name === 'A' && st2.workspace.ruyiOwned === false && st2.mission && st2.mission.workspace && st2.mission.workspace.name === 'A',
      `F2 用户工作区里的线程 ruyiOwned:false,事项的工作区也带出来(got ${JSON.stringify(st2 && [st2.workspace, st2.mission && st2.mission.workspace])})`);
    const ms = await srv.toolCall('steward_missions', {}, ctx);
    const mRow = ms && Array.isArray(ms.missions) ? ms.missions.find(m => m.missionId === missionId) : null;
    ok(mRow && mRow.workspace === 'A' && mRow.threads.every(t => typeof t.workspace === 'string') && !JSON.stringify(mRow).includes(path.basename(TMP)),
      `F3 steward_missions 带事项与线程的工作区名字,零全路径(got ${JSON.stringify(mRow && [mRow.workspace, mRow.threads.map(t => t.workspace)])})`);
  }
} finally {
  try { providerServer.close(); } catch { /* ignore */ }
}

console.log('');
if (fail) { console.log(`STEWARD WORKSPACE AFFINITY E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD WORKSPACE AFFINITY E2E: ALL PASS');
process.exit(0);
})();
