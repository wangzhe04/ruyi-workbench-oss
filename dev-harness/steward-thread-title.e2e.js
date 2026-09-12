#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// ════════════════════════════════════════════════════════════════════════════════════════════
// E2E 117s-A D2/D3(27 号文 §11.13 ⑤):**管家开的线程要有一个短名,不是把用户那句话抄一遍**。
//
// 用户第九轮走查原话:「线程标题概括就是管家发的提示词本身,太长了,根本不对」。
// 真机证据(`~/.win-claude-workbench`,2026-09-09 上午):
//   · `steward_thread_new` 开的两条线程(sess_e97b… 大A / sess_8bb0… 博纳)**`titleSource:'user'`
//     且 `threadBrief:null`** —— 13g 把模型给的 `args.title` 交给 createSession,02 见非占位标题即写
//     `titleSource:'user'`,而 116-5 的自动摘要判据(06:「titleSource === 'user' 就跳过」)于是永远短路。
//     §11.8.4 当年的假设是「args.title 是管家【有意】起的名字」,真机证明不成立:模型只是把用户那句
//     原话抄进了 title。
//   · `steward_quick_ask` 开的 sess_23ed… **有** threadBrief(「Ruyi 工作台推进状态盘点」),
//     `title` 却是提示词前 80 字,截图里看板显示的正是那 80 字(⑤b)。
//
// 覆盖:
//   (A) `steward_thread_new` 带 title -> 会话头 `titleSource:'steward'`(**不是** 'user'),
//       摘要照常生成并落盘;`session.title` 仍是管家给的那句(红线:不改写原话)。
//   (B) `displayTitle` 三个消费面同口径:GET /api/sessions/:id 的信封、GET /api/missions 的行、
//       索引条目(GET /api/sessions 列表)—— 全是摘要的名字,不是抄来的那句。
//   (C) `steward_thread_rename` 之后 `titleSource:'user'`,显示名换成用户/管家改的那个名字,
//       摘要本身不动(只是不再显示)——「人起的名字压过生成的名字」这条优先级一个字没改。
//   (D) 117s-A D3 回归:速查线程的摘要**落盘之后的下一次** GET /api/missions 读到的 displayTitle
//       就是摘要,不是 80 字原话;同一拍 ETag 也失效(条件读不会拿到 304 + 陈旧的标题)。
//       ——【复现结论,写在这里备查】:在真服务器上,这条链路(02 sessionDisplayTitle -> 13d
//       buildMissionCard -> 13e 卡片索引 -> 行)**没有陈旧**:updateSessionMeta -> saveSession ->
//       markPretenderIndexDirty(02:2537)-> 下一次读重算该会话切片,displayTitle 当场就是摘要。
//       真机上看到的 80 字因此是【客户端那一拍没再刷】,归 117s-B(看板刷新)那一刀。
//       这一段仍然留着:它是服务端这一半的回归锁 —— 哪天谁把脏页标记去掉,这里当场红。
//
// 夹具:真服务器 + 假 OpenAI 端点。端点按「起名字」那一发的系统层口令分流(与 thread-brief.e2e.js
// 同一个口令),回固定 {"title":…,"gist":…};别的请求回一段普通 SSE。零真模型。
//
// 判定行:`STEWARD THREAD TITLE E2E: ALL PASS`。
// ════════════════════════════════════════════════════════════════════════════════════════════
(async () => {
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-thread-title-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const kill = c => { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已退出 */ } } };

const WB_PORT = await getFreePort();
const PROVIDER_PORT = await getFreePort();

// 用户真机上模型抄进 title 的那句话(逐字),以及摘要该给出的短名。
const COPIED = '大A接下来的走势会怎么样';
const BRIEF_TITLE = 'A股走势研判';
const BRIEF_GIST = '看一下 A 股接下来的方向,给一句结论和依据';
let briefHits = 0;

const providerServer = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (String(req.url || '').includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"data":[{"id":"fake-model"}]}');
  }
  let body = null; try { body = JSON.parse(raw); } catch { body = null; }
  const text = String(((body && body.messages) || []).map(m => m && m.content).join(' '));
  // 起名字那一发的口令来自 06-provider-engine 的 buildThreadBriefMessages 系统层(与 thread-brief.e2e.js 同款)。
  if (text.includes('你给一条对话线程起名字') || text.includes('You name a conversation thread')) {
    briefHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: JSON.stringify({ title: BRIEF_TITLE, gist: BRIEF_GIST }) } }],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const sse = v => { try { res.write('data: ' + JSON.stringify(v) + '\n\n'); } catch { /* 客户端已断 */ } };
  sse({ choices: [{ index: 0, delta: { role: 'assistant', content: '看过了,先说结论。' }, finish_reason: null }] });
  sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* 客户端已断 */ }
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  locale: 'zh-CN',
  stewardEnabledV1: true, stewardThreadBriefV1: true, stewardPollMs: 120000,
  stewardProviderId: 'fake', stewardModel: 'fake-model',
  stewardMaxTurnsPerHour: 500, stewardGlobalMaxTurnsPerHour: 2000,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');

function request(method, p, body, headers) {
  return new Promise(resolve => {
    const raw = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: p, method, timeout: 60000,
      headers: { ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...(headers || {}) },
    }, res => {
      let b = ''; res.on('data', c => { b += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch { json = null; } resolve({ status: res.statusCode, json, raw: b, etag: res.headers.etag || '' }); });
    });
    r.on('error', () => resolve({ status: 0, json: null, raw: '', etag: '' }));
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '', etag: '' }); });
    if (raw) r.write(raw);
    r.end();
  });
}
async function waitUp() { for (let i = 0; i < 300; i++) { const h = await request('GET', '/health'); if (h.status === 200) return true; await sleep(120); } return false; }
async function tokenOf() {
  const html = await new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 5000 }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve(b)); });
    r.on('error', () => resolve('')); r.on('timeout', () => { r.destroy(); resolve(''); });
  });
  return (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
}
const headFile = id => path.join(HOME, 'sessions', id + '.json');
const readHead = id => { try { return JSON.parse(fs.readFileSync(headFile(id), 'utf8')); } catch { return null; } };
const missionRow = async (sid, hdr) => {
  const r = await request('GET', '/api/missions?limit=200', undefined, hdr);
  return { etag: r.etag, row: ((r.json && r.json.missions) || []).find(x => x && x.sessionId === sid) || null };
};

let wb = null;
const spawnWb = () => {
  const p = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  return p;
};

try {
  wb = spawnWb();
  ok(await waitUp(), '① workbench started on :' + WB_PORT);
  const hdr = { 'x-wcw-token': await tokenOf() };

  /* ═════════ (A) steward_thread_new 的 title 不是「人起的名字」═════════ */
  console.log('── (A) steward_thread_new ──');
  const act = args => request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_thread_new', args } }, hdr);
  const created = await act({ title: COPIED, cwd: HOME, brief: { userText: COPIED, goal: '给一句结论' } });
  const sid = created.json && created.json.result && created.json.result.sessionId;
  ok(!!sid, `A1 线程建起来了(实 ${sid});act 回执 ${created.status}`);

  let head = null;
  for (let i = 0; i < 150; i++) { head = readHead(sid); if (head && head.threadBrief && String(head.threadBrief.title || '').trim()) break; await sleep(200); }
  ok(!!(head && head.titleSource === 'steward'),
    `A2 会话头 titleSource === 'steward'(实 ${JSON.stringify(head && head.titleSource)})—— 修前是 'user',摘要于是永远不跑`);
  ok(!!(head && head.threadBrief && head.threadBrief.title === BRIEF_TITLE && head.threadBrief.gist === BRIEF_GIST),
    `A3 摘要真的落盘了(实 ${JSON.stringify(head && head.threadBrief && head.threadBrief.title)};起名字那一发命中 ${briefHits} 次)`);
  ok(head && head.title === COPIED,
    `A4 红线:session.title 仍是管家送来的那句原话,摘要绝不改写它(实 ${JSON.stringify(head && head.title)})`);
  ok(head && head.launchedBy === 'steward' && head.kind === 'mission',
    'A5 既有落盘形状零回归(launchedBy:steward / kind:mission)');

  /* ═════════ (B) displayTitle 三个消费面同口径 ═════════ */
  console.log('── (B) displayTitle 三个消费面 ──');
  const envelope = await request('GET', `/api/sessions/${sid}`, undefined, hdr);
  ok(envelope.json && envelope.json.displayTitle === BRIEF_TITLE,
    `B1 GET /api/sessions/:id 的信封 displayTitle 是摘要的名字(实 ${JSON.stringify(envelope.json && envelope.json.displayTitle)})`);
  ok(envelope.json && envelope.json.session && envelope.json.session.title === COPIED,
    'B1b 同一个信封里 session.title 仍是原话(显示名是【多】给的一个键,不是替换)');
  const board = await missionRow(sid, hdr);
  ok(board.row && board.row.displayTitle === BRIEF_TITLE,
    `B2 GET /api/missions 那一行的 displayTitle 是摘要的名字(实 ${JSON.stringify(board.row && board.row.displayTitle)})`);
  ok(board.row && board.row.title === COPIED, 'B2b 行上的 title 仍是原话');
  const listed = await request('GET', '/api/sessions', undefined, hdr);
  const entry = ((listed.json && listed.json.sessions) || []).find(s => s && s.id === sid) || null;
  ok(entry && entry.brief && entry.brief.title === BRIEF_TITLE,
    `B3 索引条目(经典壳侧栏与会话搜索共用的那一份)带出 brief(实 ${JSON.stringify(entry && entry.brief)})`);
  ok(entry && entry.titleSource === 'steward',
    `B3b 索引条目如实说出标题的来源是 'steward'(实 ${JSON.stringify(entry && entry.titleSource)})`);

  /* ═════════ (C) 改名之后回到「人起的名字」═════════ */
  console.log('── (C) steward_thread_rename ──');
  const RENAMED = '大A复盘';
  const renamed = await request('POST', '/api/steward/act', { act: { kind: 'tool', tool: 'steward_thread_rename', args: { sessionId: sid, title: RENAMED } } }, hdr);
  ok(renamed.status === 200 && renamed.json && renamed.json.result && renamed.json.result.ok === true,
    `C1 steward_thread_rename 成功(实 ${renamed.status} ${JSON.stringify(renamed.json && renamed.json.result && renamed.json.result.error || '')})`);
  let head2 = null;
  for (let i = 0; i < 100; i++) { head2 = readHead(sid); if (head2 && head2.title === RENAMED) break; await sleep(100); }
  ok(head2 && head2.titleSource === 'user',
    `C2 改名写的是 'user'(那才是人起的名字;实 ${JSON.stringify(head2 && head2.titleSource)})—— 这条与 D2 对称,一字未动`);
  ok(head2 && head2.threadBrief && head2.threadBrief.title === BRIEF_TITLE,
    'C3 摘要本身不被删(只是不再显示)');
  const envelope2 = await request('GET', `/api/sessions/${sid}`, undefined, hdr);
  ok(envelope2.json && envelope2.json.displayTitle === RENAMED,
    `C4 显示优先级:人起的名字压过生成的名字(实 ${JSON.stringify(envelope2.json && envelope2.json.displayTitle)})`);
  const board2 = await missionRow(sid, hdr);
  ok(board2.row && board2.row.displayTitle === RENAMED,
    `C5 看板那一行同口径(实 ${JSON.stringify(board2.row && board2.row.displayTitle)})`);

  /* ═════════ (D) D3:速查线程的摘要落盘 -> 下一次读就是摘要 ═════════ */
  console.log('── (D) 117s-A D3 速查线程 ──');
  const QUICK_RAW = '在当前这台机器上找到 Ruyi 工作台本体(ruyi-workbench-oss 这个仓库/项目,注意排除 prototype/godot、SiliconDaw';
  const QUICK_BRIEF = 'Ruyi 工作台推进状态盘点';
  const qCreated = await request('POST', '/api/sessions', { title: QUICK_RAW, cwd: HOME }, hdr);
  const qid = qCreated.json && qCreated.json.session && qCreated.json.session.id;
  ok(!!qid, `D0 速查线程的壳建起来了(实 ${qid})`);

  // 停机,在盘上补 13g stewardImplQuickAsk 在真回合里写的那三个机器痕迹(含它显式 delete 掉的
  // titleSource)。停机重启是为了让投影索引全新重建,复现不依赖脏页标记的时序。
  kill(wb); await sleep(500);
  {
    const qh = readHead(qid);
    Object.assign(qh, {
      kind: 'quick_ask', launchedBy: 'steward', turnSeq: 1,
      stewardLastTurn: { seq: 1, ok: true, aborted: false, errorClass: '', at: qh.updatedAt },
      stewardQuick: { schema: 1, askedAt: qh.createdAt, question: QUICK_RAW, stewardTurnKey: 'qk1', closedAt: null },
    });
    delete qh.titleSource;
    delete qh.threadBrief;
    fs.writeFileSync(headFile(qid), JSON.stringify(qh, null, 2), 'utf8');
  }
  wb = spawnWb();
  ok(await waitUp(), 'D0b workbench restarted (fresh projection index)');
  const hdr2 = { 'x-wcw-token': await tokenOf() };

  const before = await missionRow(qid, hdr2);
  ok(before.row && before.row.displayTitle === before.row.title && String(before.row.title).length > 40,
    `D1 摘要落盘【之前】,行上的 displayTitle 回落到那一长串原话(${String(before.row && before.row.title).length} 字)`);

  // 摘要落盘走 06 用的同一条通道(applySessionMetaPatch 的 threadBrief 白名单;PATCH /api/sessions/:id
  // 与 updateSessionMeta 共用它)。这里不跑真回合:D3 要复现的是【落盘之后读得到吗】,不是怎么生成。
  const patched = await request('PATCH', `/api/sessions/${qid}`, {
    threadBrief: { title: QUICK_BRIEF, gist: '定位本地仓库,查进度与下一步', at: new Date().toISOString(), model: 'fake-model', stage: 'first_turn' },
  }, hdr2);
  ok(patched.status === 200, `D2 摘要经 updateSessionMeta 落盘(实 ${patched.status})`);
  ok((readHead(qid) || {}).threadBrief && readHead(qid).threadBrief.title === QUICK_BRIEF, 'D2b 会话头上确实有摘要了');

  const after = await missionRow(qid, hdr2);
  ok(after.row && after.row.displayTitle === QUICK_BRIEF,
    `D3 【下一次】GET /api/missions 的那一行 displayTitle 就是摘要,不是 80 字原话(实 ${JSON.stringify(after.row && after.row.displayTitle)})`);
  ok(after.row && before.row && after.row.title === before.row.title && after.row.title.length > 40,
    'D3b 速查线程的 title 仍维持问题原话,逐字未被摘要改写(管家和搜索要认它)');
  ok(after.etag && before.etag && after.etag !== before.etag,
    `D4 同一拍 ETag 也失效了(旧 ${before.etag} / 新 ${after.etag})—— 条件读不会拿到 304 + 陈旧的标题`);
  const conditional = await request('GET', '/api/missions?limit=200', undefined, { ...hdr2, 'if-none-match': before.etag });
  ok(conditional.status === 200,
    `D4b 拿摘要落盘前的 ETag 来条件读【不】返回 304(实 ${conditional.status})`);
} catch (error) {
  fail++; console.log('FAIL 未捕获异常: ' + (error && error.stack || error));
} finally {
  kill(wb);
  try { providerServer.close(); } catch { /* 已关 */ }
}
console.log(fail ? `STEWARD THREAD TITLE E2E: ${fail} FAILURE(S)` : 'STEWARD THREAD TITLE E2E: ALL PASS');
process.exit(fail ? 1 : 0);
})();
