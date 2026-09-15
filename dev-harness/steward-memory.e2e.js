require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 116 波 116-2e · 27 号文 §4「管家记忆层」):记忆完整版的行为直测。
//
// 116c 已经落了记忆最小版(写/否决/检索、来源校验、敏感过滤、容量、同义合并)。本件测的是 116-2e
// 补齐的那一半:合并的【语义细节】(保留旧 id、text 取新、confidence 只升不降、mergedFrom ≤5)、
// vetoed 同义拒写,以及六条【面板路由】(它们不是工具,模型碰不到,只有用户的界面走)。
//
// 结构:写入侧在【进程内】直调 TOOL_HANDLERS(合成管家 ctx),面板侧起一个真服务走真 HTTP ——
// 稳定信封必须在路由层转成 apiFailure 才不会被归一成 api.request_failed,这条只有真 HTTP 能验。
//
// 覆盖:
//  (A) 合并语义:同 kind 且 Jaccard ≥0.8 -> 合并进旧条目(id 不变、条数不增、text 取新、
//      confidence = min(1, max(old,new)+0.1)、mergedFrom 追加且封顶 5)。
//  (B) 否决后同义拒写:vetoed 条目挡住同义写入(稳定信封,零写入)。
//  (C) 面板六路由:list(按 kind 分组 + isNew 派生)、edit(confidence=1 / 来源 user_panel /
//      版本冲突)、veto、restore、clear(confirm 必须逐字 'clear')、export(只含 active)。
//  (D) isNew 是纯派生:落盘的 JSON 里没有 isNew 这个字段(24 小时后没人回来擦它)。
//  (E) export 无敏感:导出的每一条都过得了 memoryProposalLooksSensitive(密钥根本进不去库)。
//  (F) 开关关:六条路由全部 409 steward.disabled,且不建目录。
//
// 端口用 getFreePort()。判定行:`STEWARD MEMORY E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-memory-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

const WB_PORT = await getFreePort();
const stewardDir = path.join(HOME, 'steward');
const memoryFile = path.join(stewardDir, 'memory-v1.json');

fs.mkdirSync(HOME, { recursive: true });
function writeConfig(patch) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, engineMode: 'interactive', permissionMode: 'default',
    includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
    stewardEnabledV1: true, stewardPollMs: 120000,
    ...patch,
  }, null, 2), 'utf8');
}
writeConfig({});

process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

const stewardCtx = { session: { id: 'steward', kind: 'steward', providerHistory: [] } };
const call = (name, args) => srv.toolCall(name, args, stewardCtx);
const readStore = () => { try { return JSON.parse(fs.readFileSync(memoryFile, 'utf8')); } catch { return null; } };

// 记忆写入的来源必须指向一条【用户自己的】消息。造一条真实会话满足这条闸。
async function makeUserTurn(text) {
  const session = await srv.createSession({ title: '来源会话', cwd: HOME });
  session.messages = [{ role: 'user', content: text, turnSeq: 1, createdAt: new Date().toISOString() }];
  session.turnSeq = 1;
  await srv.saveSession(session);
  return { sessionId: session.id, turnSeq: 1 };
}

function req(method, p, body, token) {
  return new Promise(resolve => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: WB_PORT, path: p, method,
      headers: {
        ...(token ? { 'x-wcw-token': token } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { j = null; } const code = j && j.error && typeof j.error === 'object' ? j.error.code : (j && j.error); resolve({ status: res.statusCode, body: j, code, raw: t }); }); });
    r.on('error', () => resolve({ status: 0, body: null, raw: '' }));
    if (payload) r.write(payload);
    r.end();
  });
}

let wb = null;
try {
  /* ═════════ (A) 合并语义 ═════════ */
  console.log('── (A) 合并语义 ──');
  const src1 = await makeUserTurn('报告都给我写成中文');
  const w1 = await call('steward_memory_write', { kind: 'preference', text: '报告都给我写成中文', sourceRef: src1, confidence: 0.6 });
  ok(w1 && w1.ok === true && w1.merged === false, 'A1 首次写入:新建条目(merged:false)');
  const id1 = w1.id;
  {
    const store = readStore();
    const entry = store.entries.find(e => e.id === id1);
    ok(store.entries.length === 1, 'A2 库里恰好一条');
    ok(Array.isArray(entry.mergedFrom) && entry.mergedFrom.length === 0, 'A2b 新条目 mergedFrom 是空数组(形状一致)');
  }

  const src2 = await makeUserTurn('报告都写成中文给我');
  const w2 = await call('steward_memory_write', { kind: 'preference', text: '报告都给我写成中文的', sourceRef: src2, confidence: 0.5 });
  ok(w2 && w2.ok === true && w2.merged === true && w2.id === id1, 'A3 同义写入合并进【旧 id】,不新增条目');
  {
    const store = readStore();
    ok(store.entries.length === 1, 'A4 合并后库里仍然只有一条');
    const entry = store.entries[0];
    ok(entry.text === '报告都给我写成中文的', 'A5 text 取新(用户最近一次的说法)');
    // max(0.6, 0.5) + 0.1 = 0.7
    ok(Math.abs(entry.confidence - 0.7) < 1e-9, `A6 confidence = min(1, max(old,new)+0.1)(got ${entry.confidence})`);
    ok(entry.mergedFrom.length === 1 && entry.mergedFrom[0].sessionId === src1.sessionId,
      'A7 旧来源 ref 进 mergedFrom');
    ok(entry.sourceSessionId === src2.sessionId && entry.sourceSeq === src2.turnSeq, 'A8 当前来源更新为最新那条');
    ok(entry.createdAt && entry.updatedAt && entry.updatedAt >= entry.createdAt, 'A9 updatedAt 更新,createdAt 不动');
  }
  // 再合并 6 次:mergedFrom 封顶 5
  for (let i = 0; i < 6; i++) {
    const src = await makeUserTurn('报告写中文 ' + i);
    await call('steward_memory_write', { kind: 'preference', text: '报告都给我写成中文' + '的'.repeat(i + 1), sourceRef: src, confidence: 0.9 });
  }
  {
    const store = readStore();
    const entry = store.entries.find(e => e.id === id1);
    ok(store.entries.length === 1, 'A10 连续同义写入始终只有一条');
    ok(entry.mergedFrom.length === 5, `A11 mergedFrom 封顶 5(got ${entry.mergedFrom.length})`);
    ok(entry.confidence === 1, 'A12 confidence 封顶 1(只升不降)');
  }
  // 不同 kind 的同一句话不合并(合并判据是「同 kind 且同义」)。
  {
    const src = await makeUserTurn('报告都给我写成中文（习惯）');
    const w = await call('steward_memory_write', { kind: 'habit', text: '报告都给我写成中文', sourceRef: src });
    ok(w && w.ok === true && w.merged === false, 'A13 不同 kind 的同义内容【不】合并(各记各的)');
    ok(readStore().entries.length === 2, 'A14 库里两条');
  }

  /* ═════════ (B) 否决后同义拒写 ═════════ */
  console.log('── (B) 否决后同义拒写 ──');
  {
    const v = await call('steward_memory_veto', { id: id1 });
    ok(v && v.ok === true && v.state === 'vetoed', 'B1 否决成功');
    const before = JSON.stringify(readStore());
    const src = await makeUserTurn('报告要中文的');
    const w = await call('steward_memory_write', { kind: 'preference', text: '报告都给我写成中文', sourceRef: src });
    ok(w && w.ok === false && w.error === 'vetoed_duplicate', `B2 同义内容拒绝写回(稳定信封 ${w && w.error})`);
    ok(JSON.stringify(readStore()) === before, 'B3 拒写是【零写入】(库逐字节不变)');
  }

  /* ═════════ (E) 敏感内容进不去库 ═════════ */
  console.log('── (E) 敏感过滤 ──');
  {
    const src = await makeUserTurn('我的 key');
    const w = await call('steward_memory_write', { kind: 'profile', text: 'api key: NOT-A-REAL-CREDENTIAL-just-a-fixture', sourceRef: src });
    ok(w && w.ok === false && w.error === 'sensitive_rejected', 'E1 密钥形状的内容确定性拒绝');
  }

  /* ═════════ (D) isNew 不落盘 ═════════ */
  {
    const raw = fs.readFileSync(memoryFile, 'utf8');
    ok(!raw.includes('isNew'), 'D1 落盘的 memory-v1.json 里没有 isNew 字段(它是纯派生)');
  }

  /* ═════════ (C) 面板六路由(真 HTTP)═════════ */
  console.log('── (C) 面板六路由 ──');
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
  });
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
  let token = '';
  for (let i = 0; i < 300 && !token; i++) { // 117q:预算 80×150ms=12s 余量对本机冷启动实测 4.6-6.3s 偏窄,是「FAIL workbench up」假红的根(30 号文 P1-31)
    await sleep(150);
    try { token = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
  }
  ok(!!token, 'C0 服务起来了(拿到 token)');
  // 起服务后等它真的能应答
  for (let i = 0; i < 60; i++) { const s = await req('GET', '/api/steward/memory', undefined, token); if (s.status) break; await sleep(150); }

  {
    const noToken = await req('GET', '/api/steward/memory', undefined, '');
    ok(noToken.status === 403, `C1 缺 token -> 403(与同族 /api/steward/* 一致;got ${noToken.status})`);
  }
  let activeId = '', activeVersion = '';
  {
    const r = await req('GET', '/api/steward/memory', undefined, token);
    ok(r.status === 200 && r.body && r.body.ok === true, 'C2 GET /api/steward/memory 200');
    ok(r.body && r.body.groups && Object.keys(r.body.groups).join(',') === 'profile,preference,habit,focus,policy',
      'C2b 按 kind 分组,五类齐全(空组也在)');
    const habit = (r.body.groups.habit || [])[0];
    ok(habit && habit.isNew === true, 'C2c 刚写的条目带 isNew:true(createdAt 距今 <24h)');
    ok(r.body.counts && r.body.counts.total === 2 && r.body.counts.vetoed === 1 && r.body.counts.active === 1,
      `C2d counts 齐整(total/active/vetoed;got ${JSON.stringify(r.body && r.body.counts)})`);
    activeId = habit.id; activeVersion = habit.updatedAt;
  }
  {
    const r = await req('GET', '/api/steward/memory?kind=habit', undefined, token);
    ok(r.status === 200 && Object.keys(r.body.groups).join(',') === 'habit', 'C3 ?kind= 只回那一组');
    const bad = await req('GET', '/api/steward/memory?kind=nope', undefined, token);
    ok(bad.status === 400 && bad.code === 'invalid_request',
      `C3b 非法 kind -> 400 invalid_request(稳定信封没被归一成 api.request_failed;got ${bad.code})`);
  }
  {
    const r = await req('POST', '/api/steward/memory/edit', { id: activeId, text: '用户习惯周一整理上周任务', version: activeVersion }, token);
    ok(r.status === 200 && r.body && r.body.ok === true, 'C4 edit 200');
    ok(r.body.entry && r.body.entry.text === '用户习惯周一整理上周任务', 'C4b text 改掉了');
    ok(r.body.entry && r.body.entry.confidence === 1, 'C4c 用户面板改的条目 confidence:1');
    ok(r.body.entry && r.body.entry.sourceSessionId === 'user_panel', "C4d 来源标 user_panel");
    // 版本冲突:再用【旧】 version 提交一次
    const conflict = await req('POST', '/api/steward/memory/edit', { id: activeId, text: '再改一次', version: activeVersion }, token);
    ok(conflict.status === 409 && conflict.code === 'version_conflict',
      `C4e 旧 version 提交 -> 409 version_conflict(got ${conflict.status}/${conflict.code})`);
    const missing = await req('POST', '/api/steward/memory/edit', { id: 'nope', text: 'x' }, token);
    ok(missing.status === 404 && missing.code === 'not_found', 'C4f 不存在的 id -> 404 not_found');
    const sensitive = await req('POST', '/api/steward/memory/edit', { id: activeId, text: 'api key = NOT-A-REAL-CREDENTIAL-just-a-fixture' }, token);
    ok(sensitive.status === 400 && sensitive.code === 'sensitive_rejected',
      'C4g 面板不是绕过敏感过滤的后门');
  }
  {
    const r = await req('POST', '/api/steward/memory/veto', { id: activeId }, token);
    ok(r.status === 200 && r.body && r.body.state === 'vetoed', 'C5 veto 200 且状态变 vetoed');
    const back = await req('POST', '/api/steward/memory/restore', { id: activeId }, token);
    ok(back.status === 200 && back.body && back.body.state === 'active' && back.body.restored === true, 'C6 restore 把 vetoed 拉回 active');
    const again = await req('POST', '/api/steward/memory/restore', { id: activeId }, token);
    ok(again.status === 200 && again.body && again.body.restored === false, 'C6b restore 幂等(已 active 再调是无操作)');
  }
  {
    const r = await req('GET', '/api/steward/memory/export', undefined, token);
    ok(r.status === 200 && r.body && Array.isArray(r.body.entries), 'C7 export 200 且带 entries 数组');
    ok(r.body.entries.every(e => e.state === 'active'), 'C7b export 只含 active(被否决的不导出)');
    ok(r.body.entries.every(e => !('isNew' in e)), 'C7c export 不含 isNew 这类派生视图字段');
    const dumped = JSON.stringify(r.body.entries);
    ok(!/api[_ -]?key\s*[:=]/i.test(dumped) && !/NOT-A-REAL-CREDENTIAL/.test(dumped), 'C7d(E2)export 里零密钥形状字符串');
    const fields = new Set();
    for (const e of r.body.entries) for (const k of Object.keys(e)) fields.add(k);
    const allowed = new Set(['id', 'kind', 'text', 'confidence', 'sourceSessionId', 'sourceSeq', 'createdAt', 'updatedAt', 'lastUsedAt', 'useCount', 'state', 'mergedFrom', 'expiresAt', 'scope']); // 126-M02/M01 新增(这把锁两次都按设计拦住了:加字段必须回来登记)
    const extra = [...fields].filter(f => !allowed.has(f));
    ok(extra.length === 0, 'C7e export 只含条目本身的字段' + (extra.length ? ' → 多出: ' + extra.join(',') : ''));
  }
  {
    const bad = await req('POST', '/api/steward/memory/clear', { confirm: 'CLEAR' }, token);
    ok(bad.status === 400 && bad.code === 'invalid_request', "C8 confirm 大小写不同 -> 400(必须逐字 'clear')");
    const none = await req('POST', '/api/steward/memory/clear', {}, token);
    ok(none.status === 400, 'C8b 缺 confirm -> 400');
    ok((readStore().entries || []).length === 2, 'C8c 拒绝的 clear 是零写入');
    const done = await req('POST', '/api/steward/memory/clear', { confirm: 'clear' }, token);
    ok(done.status === 200 && done.body && done.body.removed === 2, `C9 confirm:'clear' 清空(removed ${done.body && done.body.removed})`);
    ok((readStore().entries || []).length === 0, 'C9b 库真的空了');
  }

  /* ═════════ (G) 126-M02 时效(expiresAt)═════════ */
  // 放在 (C) 之后、(F) 之前:那时库刚被 clear 清空(C9b),本段因此自成一体;而 (F) 只判六条路由的
  // 状态码,不看库里有什么,所以新增本段不会扰动它(125 波那次「新断言插在中段扰动后面的件」的教训)。
  console.log('── (G) 时效 expiresAt ──');
  {
    const past = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const future = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const srcG = await makeUserTurn('这两周在赶 A 项目');

    const gExpired = await call('steward_memory_write', { kind: 'focus', text: '用户这两周在赶 A 项目', sourceRef: srcG, expiresAt: past });
    ok(gExpired && gExpired.ok === true, 'G1 带过期时间的写入成功');
    ok((readStore().entries.find(e => e.id === gExpired.id) || {}).expiresAt === past, 'G1b expiresAt 原样落盘');

    const srcG2 = await makeUserTurn('下个月要交季度总结');
    const gLive = await call('steward_memory_write', { kind: 'focus', text: '用户下个月要交季度总结', sourceRef: srcG2, expiresAt: future });
    ok(gLive && gLive.ok === true, 'G2 带未来到期日的写入成功');

    // 读取口过滤:过期的那条不出现在检索结果里(提示词块走的就是这一口)。
    const found = await call('steward_memory_search', { limit: 50 });
    const ids = (found.entries || []).map(e => e.id);
    ok(!ids.includes(gExpired.id), `G3 过期条目【不出现】在检索结果里(实得 ${ids.length} 条)`);
    ok(ids.includes(gLive.id), 'G4 未过期的照常出现');

    const all = await call('steward_memory_search', { limit: 50, includeExpired: true });
    ok((all.entries || []).map(e => e.id).includes(gExpired.id), 'G5 显式 includeExpired 时能拿到过期条目(是过滤,不是删除)');

    // 面板照常列出,并带上标记 —— 用户看得见「它过期了」,可以续期或删除。
    const panel = await req('GET', '/api/steward/memory', undefined, token);
    const rows = Object.values((panel.body && panel.body.groups) || {}).flat();
    const panelExpired = rows.find(r => r.id === gExpired.id);
    const panelLive = rows.find(r => r.id === gLive.id);
    ok(!!panelExpired, 'G6 过期条目仍在面板上列着(时效是过滤不是删除)');
    ok(panelExpired && panelExpired.expired === true, 'G6b 面板给它打了 expired 标');
    ok(panelLive && panelLive.expired === false, 'G6c 没过期的那条 expired:false');

    // 最要紧的一条:合并进一条【已经过期】的条目而没给新到期日 -> 到期日必须被清掉。
    // 不这么做会留一个陷阱:合并成功、却因为继承了过去的到期日而仍然不进提示词块(写了等于没写)。
    const srcG3 = await makeUserTurn('这两周还在赶 A 项目');
    const gMerge = await call('steward_memory_write', { kind: 'focus', text: '用户这两周在赶 A 项目呢', sourceRef: srcG3 });
    ok(gMerge && gMerge.merged === true && gMerge.id === gExpired.id, 'G7 同义写入合并进那条已过期的条目');
    ok((readStore().entries.find(e => e.id === gExpired.id) || {}).expiresAt === '',
      'G7b **合并时旧的已过期且没给新到期日 -> 到期日被清掉**(用户又说了一遍,这条就是当下有效的)');
    const after = await call('steward_memory_search', { limit: 50 });
    ok((after.entries || []).map(e => e.id).includes(gExpired.id), 'G7c 于是它重新出现在检索结果里(写了不等于没写)');

    // 给了新到期日就用新的。
    const srcG4 = await makeUserTurn('A 项目再延一周');
    // 注意:这里要用与当前条目【逐字相同】的 text。第一版写成只差末字的另一句,双字组 Jaccard
    // 只有 0.778(阈值 0.8),于是它另开了一条新条目 —— 夹具错了,不是实现错了(实测两句的
    // terms 分别是 ...|项目|目呢 与 ...|项目|目啊,九个双字组里差了两个)。
    const gMerge2 = await call('steward_memory_write', { kind: 'focus', text: '用户这两周在赶 A 项目呢', sourceRef: srcG4, expiresAt: future });
    ok(gMerge2 && gMerge2.merged === true, 'G8 再次同义写入仍然合并');
    ok((readStore().entries.find(e => e.id === gExpired.id) || {}).expiresAt === future, 'G8b 给了新到期日就用新的');

    // 非法/缺省一律清洗成空串 = 永不过期(存量条目没有这个字段,读成空串,与今天逐字节同义)。
    const srcG5 = await makeUserTurn('我用的是 Windows');
    const gBad = await call('steward_memory_write', { kind: 'profile', text: '用户用的是 Windows 系统', sourceRef: srcG5, expiresAt: '明天' });
    ok((readStore().entries.find(e => e.id === gBad.id) || {}).expiresAt === '', 'G9 非法到期日清洗成空串(= 永不过期,绝不静默当成已过期)');
    const srcG6 = await makeUserTurn('报告给我写成中文的哈');
    const gNone = await call('steward_memory_write', { kind: 'preference', text: '用户要求报告写成中文哈', sourceRef: srcG6 });
    ok((readStore().entries.find(e => e.id === gNone.id) || {}).expiresAt === '', 'G10 不给到期日 = 空串(绝大多数条目就该是这样)');
  }

  /* ═════════ (H) 126-M01 作用域(scope)═════════ */
  console.log('── (H) 作用域 scope ──');
  {
    // 来源会话的 cwd 就是 HOME(makeUserTurn 建会话时传的),所以 project 档推出来的键是 HOME 的键。
    const srcH = await makeUserTurn('这个仓用 pnpm 不用 npm');
    const hProject = await call('steward_memory_write', { kind: 'policy', text: '用户在这个仓里用 pnpm 不用 npm', sourceRef: srcH, scope: 'project' });
    ok(hProject && hProject.ok === true, 'H1 project 档写入成功');
    const projectEntry = readStore().entries.find(e => e.id === hProject.id) || {};
    ok(/^project:[0-9a-f]{16}$/.test(String(projectEntry.scope || '')),
      `H1b 作用域键由**服务端**从来源会话的 cwd 推出来(实得 ${projectEntry.scope})`);

    const srcH2 = await makeUserTurn('报告都写成中文');
    const hGlobal = await call('steward_memory_write', { kind: 'preference', text: '用户要求所有报告写成中文', sourceRef: srcH2 });
    ok((readStore().entries.find(e => e.id === hGlobal.id) || {}).scope === '', 'H2 不说就是全局(空串)');

    // 模型编一个键进来 —— 一律回落全局,绝不静默把它锁进某个项目。
    const srcH3 = await makeUserTurn('随便写点什么');
    const hBad = await call('steward_memory_write', { kind: 'habit', text: '用户习惯早上处理邮件', sourceRef: srcH3, scope: 'project:deadbeefdeadbeef' });
    ok((readStore().entries.find(e => e.id === hBad.id) || {}).scope === '',
      'H3 **模型自己填的键不算数** —— scope 只认 global/project 两个词,键永远服务端推(31 号文 §2.6 红线)');

    // 检索:不传 scope 不筛(管家是跨项目的看护者);传了就只剩「全局 + 那个项目」。
    const all = await call('steward_memory_search', { limit: 50 });
    const allIds = (all.entries || []).map(e => e.id);
    ok(allIds.includes(hProject.id) && allIds.includes(hGlobal.id), 'H4 不传 scope = 不筛(项目条目照常拿得到)');
    const scoped = await call('steward_memory_search', { limit: 50, scope: projectEntry.scope });
    const scopedIds = (scoped.entries || []).map(e => e.id);
    ok(scopedIds.includes(hProject.id) && scopedIds.includes(hGlobal.id), 'H5 传本项目 = 全局 ＋ 本项目都在');
    const other = await call('steward_memory_search', { limit: 50, scope: 'project:0123456789abcdef' });
    const otherIds = (other.entries || []).map(e => e.id);
    ok(!otherIds.includes(hProject.id), 'H6 传【别的】项目 -> 本项目那条不出现');
    ok(otherIds.includes(hGlobal.id), 'H6b 但全局那条仍然在(全局到处算数)');

    // 面板:scope 原样带出,另有人话标签。
    const panelH = await req('GET', '/api/steward/memory', undefined, token);
    const rowsH = Object.values((panelH.body && panelH.body.groups) || {}).flat();
    const panelProject = rowsH.find(r => r.id === hProject.id);
    const panelGlobal = rowsH.find(r => r.id === hGlobal.id);
    ok(panelProject && panelProject.scope === projectEntry.scope, 'H7 面板把 scope 原样带出');
    ok(panelProject && typeof panelProject.scopeLabel === 'string' && panelProject.scopeLabel.length > 0,
      `H7b 面板另给一句人话(实得「${panelProject && panelProject.scopeLabel}」)`);
    ok(panelGlobal && panelGlobal.scopeLabel === '', 'H7c 全局那条没有标签(不是所有条目都印)');

    // 合并:没重新表态就不改作用域(与 expiresAt 那条的不对称是有意的 —— 作用域不会「到期」)。
    const srcH4 = await makeUserTurn('这个仓还是用 pnpm');
    const hMerge = await call('steward_memory_write', { kind: 'policy', text: '用户在这个仓里用 pnpm 不用 npm 的', sourceRef: srcH4 });
    ok(hMerge && hMerge.merged === true, 'H8 同义写入合并');
    ok((readStore().entries.find(e => e.id === hProject.id) || {}).scope === projectEntry.scope,
      'H8b 没重新表态 -> 作用域【不动】(它不会「到期」,不该被悄悄改)');
  }

  /* ═════════ (F) 开关关 ═════════ */
  console.log('── (F) 开关关 ──');
  {
    writeConfig({ stewardEnabledV1: false });
    await sleep(300);
    const paths = [
      ['GET', '/api/steward/memory'], ['GET', '/api/steward/memory/export'],
      ['POST', '/api/steward/memory/edit'], ['POST', '/api/steward/memory/veto'],
      ['POST', '/api/steward/memory/restore'], ['POST', '/api/steward/memory/clear'],
    ];
    const bad = [];
    for (const [m, p] of paths) {
      const r = await req(m, p, m === 'POST' ? {} : undefined, token);
      if (r.status !== 409 || r.code !== 'steward.disabled') bad.push(`${m} ${p}:${r.status}/${r.code}`);
    }
    ok(bad.length === 0, 'F1 开关关时六条路由全部 409 steward.disabled' + (bad.length ? ' → ' + bad.join(', ') : ''));
  }
} catch (e) {
  console.log('ERROR ' + ((e && e.stack) || e));
  fail++;
} finally {
  kill(wb);
  await sleep(300);
}

console.log('');
if (fail) { console.log(`STEWARD MEMORY E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD MEMORY E2E: ALL PASS');
process.exit(0);
})();
