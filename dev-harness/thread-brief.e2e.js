(async () => {
'use strict';
// E2E(第 116 波 116-5a · 27 号文 §11.8「线程自动摘要」):每开一条新线程自动生成一个 ≤24 字的
// 名字与一句 ≤80 字的概括,写进会话头 threadBrief。
//
// 用户证据(2026-09-06 夜截图):线程搜索结果里整条是用户原话「帮我分析一下AMD——按美股超威半导体…」,
// 一屏放不下三条,看不出哪条是哪件事。
//
// 结构:全程进程内(直调 runSessionTurn / listSessions / sessionDisplayTitle)+ 一个假 OpenAI 端点。
// 那个假端点按【系统提示词里的口令】把「起名字的那一发」与「真回合」分开计数,所以每一条断言里的
// 调用次数都是可判定的。
//
// 覆盖:
//  (A) 正常路径:首轮之后 threadBrief 落盘(title/gist/at/model/stage 五字段齐)、**只调一次模型**;
//      session.title 仍是用户原话(红线:brief 绝不改写原话);sessionMeta 带出 brief;
//      sessionDisplayTitle 用生成的名字。
//  (B) 第二回合不再调(一条线程只起一次名字)。
//  (C) 用户改名:titleSource:'user' 落盘,显示名字换成用户起的那个,brief 本身不动。
//  (D) 模型吐非 JSON:首回合机会性的一发 + 收工那次的三发 = 4 次之后放弃,brief 留空,
//      **回合照常收工**(红线:摘要绝不阻塞回合)。
//  (E) 开关关(stewardThreadBriefV1:false):零调用、零字段。
//  (F) 管家会话不起名(它不是线程)。
//  (G) 端点解析:配了 stewardProviderId 就用它(模型跟 stewardModel);配了却不在 providers 列表
//      -> 不生成(fail-closed,不静默换成别的端点)。
//  (H) 记账:aux 台账里是 note:'thread-brief',**不是** 'steward'(不进管家日费用熔断)。
//  (I) 解析器 parseThreadBrief:围栏/前后杂字/数组/缺 title/空串。
//  (J) 落盘时就夹死上限:超长 title/gist 在会话头上已经是 24/80 字。
//  (K) 116-5b 消费面:事项卡片(看板/抽屉/「现在这一件」读的那一份)带 displayTitle 与 brief、
//      title 仍是原话;管家的线程搜索结果带 brief、title 仍是原话。
//
// 判定行:`THREAD BRIEF E2E: ALL PASS`。
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-brief-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const PROVIDER_PORT = await getFreePort();
const TITLE = 'AMD 收盘分析';
const GIST = '拉 AMD 最新行情与新闻,给博物影业格式的结论';
let briefHits = 0, turnHits = 0, lastBriefModel = '';
let briefMode = 'json';          // json | garbage | oversize
const providerServer = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  await new Promise(r => req.on('end', r));
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }, { id: 'brief-model' }] }));
  }
  let body = null; try { body = JSON.parse(raw); } catch { body = null; }
  const text = String(((body && body.messages) || []).map(m => m && m.content).join(' '));
  // 起名字那一发的口令来自 06-provider-engine 的 buildThreadBriefMessages 系统层。
  if (text.includes('你给一条对话线程起名字') || text.includes('You name a conversation thread')) {
    briefHits += 1;
    lastBriefModel = String((body && body.model) || '');
    let content = '```json\n' + JSON.stringify({ title: TITLE, gist: GIST }) + '\n```';
    if (briefMode === 'garbage') content = '这不是 JSON,只是一段解释性的话。';
    if (briefMode === 'oversize') content = JSON.stringify({ title: '标'.repeat(60), gist: '概'.repeat(200) });
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 120, completion_tokens: 30 } }));
  }
  turnHits += 1;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
  frame({ choices: [{ index: 0, delta: { content: 'AMD 今天收在 168.2,量能放大。' } }] });
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

const BASE_CONFIG = {
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }, { id: 'brief-model', label: 'Brief' }] }],
};
fs.mkdirSync(HOME, { recursive: true });
const writeConfig = extra => fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ ...BASE_CONFIG, ...(extra || {}) }, null, 2), 'utf8');
writeConfig();

process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const headOf = id => JSON.parse(fs.readFileSync(path.join(HOME, 'sessions', id + '.json'), 'utf8'));
const newSession = async () => { const s = await srv.createSession({ title: '', cwd: HOME }); await srv.saveSession(s); return s.id; };
const waitBrief = async (id, ms = 12000) => {
  for (let i = 0; i < Math.ceil(ms / 200); i++) {
    const h = headOf(id);
    if (h.threadBrief && String(h.threadBrief.title || '').trim()) return h.threadBrief;
    await sleep(200);
  }
  return null;
};
const usageRows = () => {
  const dir = path.join(HOME, 'usage');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
};

const RAW = '帮我分析一下AMD——按美股超威半导体，今天收盘怎么样，有什么新闻';

try {
  /* ═════════ (A) 正常路径 ═════════ */
  console.log('── (A) 首轮之后自动起名字 ──');
  const idA = await newSession();
  const briefCallsBefore = briefHits;
  await srv.runSessionTurn({ sessionId: idA, message: RAW, cwd: HOME, onEvent: () => {} });
  const brief = await waitBrief(idA);
  ok(!!brief, 'A1 首轮之后 threadBrief 落盘');
  ok(brief && brief.title === TITLE, `A2 title 是任务的名字(got ${brief && JSON.stringify(brief.title)})`);
  ok(brief && brief.gist === GIST, 'A3 gist 是一句人话概括');
  ok(brief && brief.schema === 1 && !!brief.at && !!brief.model && brief.stage === 'first_turn',
    `A4 五字段齐且 stage 是首回合那次(got ${brief && JSON.stringify({ schema: brief.schema, at: !!brief.at, model: brief.model, stage: brief.stage })})`);
  ok(briefHits - briefCallsBefore === 1,
    `A5 常见路径【只调一次】模型(got ${briefHits - briefCallsBefore};修前首回合与收工两条路各调一次,因为落盘被延后到 settle 之后、收工钩子看见的还是空的)`);
  ok(headOf(idA).title === RAW, 'A6 红线:session.title 仍是用户原话,brief 绝不改写它');
  const metaA = (await srv.listSessions()).find(m => m.id === idA);
  ok(metaA && metaA.brief && metaA.brief.title === TITLE && metaA.brief.gist === GIST,
    'A7 sessionMeta 带出 brief(经典壳侧栏与 113b 会话搜索共用这一份)');
  ok(metaA && !('titleSource' in metaA), 'A8 没改过名的线程不带 titleSource(载荷只在需要时扩张)');
  ok(srv.sessionDisplayTitle(headOf(idA)) === TITLE, 'A9 sessionDisplayTitle 用生成的名字');
  ok(srv.sessionDisplayTitle(metaA) === TITLE, 'A9b 索引条目形态也认(快路径喂进来的是它)');

  /* ═════════ (B) 一条线程只起一次名字 ═════════ */
  console.log('── (B) 第二回合不再调 ──');
  {
    const before = briefHits;
    await srv.runSessionTurn({ sessionId: idA, message: '再看看它的竞品', cwd: HOME, onEvent: () => {} });
    await sleep(800);
    ok(briefHits - before === 0, `B1 第二回合零调用(got ${briefHits - before})`);
    ok(headOf(idA).threadBrief.at === brief.at, 'B2 原来的 brief 一字未动');
  }

  /* ═════════ (C) 用户改名压过生成的名字 ═════════ */
  console.log('── (C) 用户改名 ──');
  {
    await srv.updateSessionMeta(idA, { title: '我自己起的名字' });
    const head = headOf(idA);
    ok(head.titleSource === 'user', "C1 改名落下 titleSource:'user'");
    ok(srv.sessionDisplayTitle(head) === '我自己起的名字', 'C2 显示优先级:人起的名字 > 生成的名字');
    ok(head.threadBrief && head.threadBrief.title === TITLE, 'C3 brief 本身不被删(只是不再显示)');
    const metaC = (await srv.listSessions()).find(m => m.id === idA);
    ok(metaC && metaC.titleSource === 'user' && srv.sessionDisplayTitle(metaC) === '我自己起的名字', 'C4 索引条目同口径');
  }

  /* ═════════ (D) 模型吐非 JSON:放弃,但绝不阻塞回合 ═════════ */
  console.log('── (D) 模型吐非 JSON ──');
  {
    briefMode = 'garbage';
    const idD = await newSession();
    const before = briefHits;
    const result = await srv.runSessionTurn({ sessionId: idD, message: '看看 README 里写了什么', cwd: HOME, onEvent: () => {} });
    ok(result && result.ok === true && result.result && result.result.ok === true,
      'D1 红线:摘要失败绝不阻塞回合(回合照常收工)');
    await sleep(8000);   // 收工那次:首发 + 1s + 4s 两次退避
    ok(briefHits - before === 4,
      `D2 首回合机会性的一发 + 收工那次的三发 = 4 次后放弃(got ${briefHits - before})`);
    ok(!headOf(idD).threadBrief, 'D3 解析不出就留空,绝不拿整段原文当名字');
    ok(srv.sessionDisplayTitle(headOf(idD)) === headOf(idD).title, 'D4 brief 缺席时显示回落到原话');
    briefMode = 'json';
  }

  /* ═════════ (E) 开关关 ═════════ */
  console.log('── (E) 开关关 ──');
  {
    writeConfig({ stewardThreadBriefV1: false });
    const idE = await newSession();
    const before = briefHits;
    await srv.runSessionTurn({ sessionId: idE, message: '开关关着的时候开的线程', cwd: HOME, onEvent: () => {} });
    await sleep(1500);
    ok(briefHits - before === 0, `E1 零调用(got ${briefHits - before})`);
    ok(!headOf(idE).threadBrief, 'E2 零字段');
    const metaE = (await srv.listSessions()).find(m => m.id === idE);
    ok(metaE && !('brief' in metaE), 'E3 sessionMeta 载荷逐字节不变(brief 键根本不出现)');
    writeConfig();
  }

  /* ═════════ (F) 管家会话不起名 ═════════ */
  console.log('── (F) 管家会话 ──');
  {
    const stewardSession = await srv.createSession({ title: '管家', cwd: HOME });
    stewardSession.kind = 'steward';
    await srv.saveSession(stewardSession);
    const before = briefHits;
    const r = await srv.maybeWriteThreadBrief({ sessionId: stewardSession.id, message: '在吗', stage: 'first_turn', config: JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')), threadProvider: BASE_CONFIG.providers[0] });
    ok(r === null && briefHits - before === 0, 'F1 管家会话不是线程,不起名字也不调模型');
  }

  /* ═════════ (G) 端点解析 ═════════ */
  console.log('── (G) 端点解析 ──');
  {
    writeConfig({ stewardProviderId: 'fake', stewardModel: 'brief-model' });
    const idG = await newSession();
    await srv.runSessionTurn({ sessionId: idG, message: '走管家端点的线程', cwd: HOME, onEvent: () => {} });
    ok(!!(await waitBrief(idG)), 'G1 配了 stewardProviderId 照常生成');
    ok(lastBriefModel === 'brief-model', `G2 模型跟 stewardModel(got ${lastBriefModel})`);

    writeConfig({ stewardProviderId: 'not-in-list' });
    const idG2 = await newSession();
    const before = briefHits;
    await srv.runSessionTurn({ sessionId: idG2, message: '管家端点配错了的线程', cwd: HOME, onEvent: () => {} });
    await sleep(1500);
    ok(briefHits - before === 0, `G3 配了却不在 providers 列表 -> 不生成(fail-closed,不静默换成别的端点;got ${briefHits - before})`);
    ok(!headOf(idG2).threadBrief, 'G4 零字段');
    writeConfig();
  }

  /* ═════════ (H) 记账 ═════════ */
  console.log('── (H) aux 台账 ──');
  {
    const rows = usageRows();
    const mine = rows.filter(r => r.note === 'thread-brief');
    ok(mine.length > 0, `H1 起名字的调用进了用量台账(got ${mine.length} 行)`);
    ok(mine.every(r => r.kind === 'aux'), "H2 记的是 kind:'aux'(与 playbook-draft / json-repair 同款)");
    ok(mine.every(r => r.note !== 'steward'), 'H3 **不是** steward —— 它不是管家回合,不该进管家日费用熔断');
  }

  /* ═════════ (I) 解析器 ═════════ */
  console.log('── (I) parseThreadBrief ──');
  {
    const p = srv.parseThreadBrief;
    ok(p('```json\n{"title":"甲","gist":"乙"}\n```').title === '甲', 'I1 代码围栏容忍');
    ok(p('好的,这是结果:{"title":"甲","gist":"乙"} 以上。').gist === '乙', 'I2 前后杂字容忍');
    ok(p('[{"title":"甲"}]').title === '甲', 'I3 单元素数组被拆开(与围栏同一条宽容:少一次失败就少两次模型调用)');
    ok(p('[{"title":"甲"},{"title":"乙"}]') === null, 'I3b 多元素数组仍是失败(切出来的不是合法 JSON)');
    ok(p('{"gist":"只有概括"}') === null, 'I4 没有 title 不算成功');
    ok(p('{"title":"甲"}').gist === '', 'I5 只有 title 也算成功(概括可以空)');
    ok(p('') === null && p(null) === null && p('这不是 JSON') === null, 'I6 空/非法一律 null');
    ok(p('{"title":" 甲  乙 ","gist":"丙\\n丁"}').title === '甲 乙', 'I7 空白折叠');
  }

  /* ═════════ (J) 上限在落盘时就夹死 ═════════ */
  console.log('── (J) 字数上限 ──');
  {
    briefMode = 'oversize';
    const idJ = await newSession();
    await srv.runSessionTurn({ sessionId: idJ, message: '会吐超长摘要的线程', cwd: HOME, onEvent: () => {} });
    const b = await waitBrief(idJ);
    ok(b && b.title.length === 24, `J1 title 落盘时就夹到 24 字(got ${b && b.title.length})`);
    ok(b && b.gist.length === 80, `J2 gist 落盘时就夹到 80 字(got ${b && b.gist.length})`);
    briefMode = 'json';
  }
  /* ═════════ (K) 116-5b 消费面:服务端一处装配、多处消费 ═════════ */
  console.log('── (K) 消费面 ──');
  {
    writeConfig({ stewardEnabledV1: true });
    // 投影【只给 kind:'mission' 的会话建卡片】,而看板/抽屉/「现在这一件」读的就是那张卡片 ——
    // 前面几组用的都是 quick_ask 会话(createSession 的默认档),它们没有卡片,测不到这一面。
    const sK = await srv.createSession({ title: '', cwd: HOME });
    sK.kind = 'mission';
    await srv.saveSession(sK);
    const idK = sK.id;
    await srv.runSessionTurn({ sessionId: idK, message: RAW, cwd: HOME, onEvent: () => {} });
    ok(!!(await waitBrief(idK)), 'K0 事项线程同样起名字(摘要不挑 kind,只挑「有没有人给的名字」)');

    // ① 事项卡片:13d buildMissionCard -> 13e 投影 -> GET /api/missions -> 看板行/抽屉页签/「现在这一件」
    const index = await srv.getPretenderProjectionIndex();
    const slice = ((index && index.sessions) || []).find(r => r && r.sessionId === idK);
    const card = slice && slice.card;
    ok(card && card.displayTitle === TITLE, `K1 卡片带服务端算好的显示名(got ${card && JSON.stringify(card.displayTitle)})`);
    ok(card && card.title === RAW, 'K2 卡片的 title 仍是原话(它是权威,也是壳层的 hover 全文)');
    ok(card && card.brief && card.brief.gist === GIST, 'K3 卡片带那句概括(抽屉与搜索结果要用)');

    // ② 管家的线程搜索:13g steward_threads_search
    const found = await srv.StewardHooks.threadsSearch({ q: 'AMD' }, { session: { kind: 'steward' } });
    const rowK = ((found && found.results) || []).find(r => r && r.sessionId === idK);
    ok(rowK && rowK.brief && rowK.brief.title === TITLE && rowK.brief.gist === GIST,
      `K4 线程搜索结果带 brief(got ${rowK && JSON.stringify(rowK.brief)})`);
    ok(rowK && rowK.title === RAW,
      'K5 线程搜索的 title 仍是原话 —— 管家要凭它认出用户当时的原始说法,压过的名字只是【多】给的');
    writeConfig();
  }
} catch (e) {
  console.log('ERROR ' + ((e && e.stack) || e));
  fail++;
} finally {
  try { providerServer.close(); } catch { /* ignore */ }
  await sleep(200);
}

console.log('');
if (fail) { console.log(`THREAD BRIEF E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('THREAD BRIEF E2E: ALL PASS');
process.exit(0);
})();
