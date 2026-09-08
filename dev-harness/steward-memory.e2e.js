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
    const allowed = new Set(['id', 'kind', 'text', 'confidence', 'sourceSessionId', 'sourceSeq', 'createdAt', 'updatedAt', 'lastUsedAt', 'useCount', 'state', 'mergedFrom']);
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
