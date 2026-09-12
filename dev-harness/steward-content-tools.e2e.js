require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
'use strict';
// E2E(第 116 波 116-2e · 27 号文 §3.5「内容管理」行):`steward_playbook_draft` 与
// `steward_skill_toggle` 的行为直测。
//
// 两个工具各有一条纪律要看住:
//   · playbook_draft 只【起草】不保存(保存走既有 UI POST /api/playbooks,117 接),而且它会调一次
//     模型 —— 每个管家回合最多 1 次,超了 quota_exceeded;
//   · skill_toggle 与 POST /api/session/skills 共用 setSessionSkillsCore(同一段校验/去重/截 8/
//     来源锁定),并且是【须确认】的 —— 没有 ctx.userPressed 一律 propose_required。
//
// 结构:进程内直调 TOOL_HANDLERS;起草那一步走真 fake-openai(要证明它真的调了模型并拿回草稿),
// 共用核心那一步同时走工具与 HTTP 路由,比对两边写出来的 session.skills 逐字节相同。
//
// 覆盖:
//  (A) playbook_draft:正向拿到草稿且【不落盘】(用户 playbook 目录里没多出文件);每回合 1 次;
//      管家会话自己不能被起草;不存在的线程 -> not_found。
//  (B) skill_toggle:无 userPressed -> propose_required(零写入);有 userPressed -> 真写入;
//      管家会话 -> steward.forbidden;不存在的线程 -> not_found。
//  (C) 共用核心:工具写出来的 skills 与 POST /api/session/skills 写出来的逐字节相同(去重、
//      不存在的 id 丢弃、截 8、source 从注册表带上)。
//
// 判定行:`STEWARD CONTENT TOOLS E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-content-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

const PROVIDER_PORT = await getFreePort();
const WB_PORT = await getFreePort();

// ── fake-openai:playbook 起草走的是【非流式】还是流式由引擎决定,两条都回同一段 JSON 文本。
let providerHits = 0;
const DRAFT_JSON = JSON.stringify({
  id: 'pb-drafted', title: '周报流程', summary: '把一周的提交整理成周报',
  promptTemplate: '把 {{repo}} 这一周的提交整理成周报', tags: ['周报'],
});
const providerServer = http.createServer(async (req, res) => {
  let raw = '';
  req.on('data', c => { raw += c; });
  await new Promise(r => req.on('end', r));
  if (req.url.includes('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
  }
  providerHits += 1;
  let body = null; try { body = JSON.parse(raw); } catch { body = null; }
  if (body && body.stream === false) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: DRAFT_JSON } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  const frame = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
  frame({ choices: [{ index: 0, delta: { content: DRAFT_JSON } }] });
  frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
  res.write('data: [DONE]\n\n');
  res.end();
});
await new Promise(r => providerServer.listen(PROVIDER_PORT, '127.0.0.1', r));

const SKILLS_DIR = path.join(HOME, 'skills');
function makeSkill(id, title) {
  const dir = path.join(SKILLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${id}\ndescription: ${title}\n---\n\n# ${title}\n\n用来测试的技能。\n`, 'utf8');
}
fs.mkdirSync(HOME, { recursive: true });
for (let i = 1; i <= 10; i++) makeSkill('skill-' + i, '技能 ' + i);

fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
  includeWorkbenchMcp: false, defaultWorkspace: HOME, recentWorkspaces: [], subagentMaxPerTurn: 0,
  stewardEnabledV1: true, stewardPollMs: 120000,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
}, null, 2), 'utf8');

process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;
const srv = require(SERVER);

// 每回合配额桶按 (ctx.sessionId, 回合序号) 记账 —— 回合序号 = providerHistory 里的 user 消息条数。
const stewardCtx = (turn, extra) => ({
  session: { id: 'steward', kind: 'steward', providerHistory: Array.from({ length: turn || 0 }, () => ({ role: 'user' })) },
  sessionId: 'steward',
  ...(extra || {}),
});
const call = (name, args, ctx) => srv.toolCall(name, args, ctx || stewardCtx(0));

async function makeThread(title) {
  const session = await srv.createSession({ title, cwd: HOME });
  session.kind = 'mission';
  session.messages = [
    { role: 'user', content: '把这周的提交整理成周报', turnSeq: 1, createdAt: new Date().toISOString() },
    { role: 'assistant', content: '好的，我已经整理完了。', turnSeq: 1, createdAt: new Date().toISOString() },
  ];
  session.turnSeq = 1;
  await srv.saveSession(session);
  return session.id;
}

let wb = null;
try {
  const threadId = await makeThread('周报线程');
  const threadId2 = await makeThread('第二条线程');

  /* ═════════ (A) playbook_draft ═════════ */
  console.log('── (A) playbook_draft ──');
  {
    const before = providerHits;
    const userPlaybooksDir = path.join(HOME, 'playbooks');
    const filesBefore = fs.existsSync(userPlaybooksDir) ? fs.readdirSync(userPlaybooksDir) : [];
    const r = await call('steward_playbook_draft', { sessionId: threadId }, stewardCtx(1));
    ok(r && r.ok === true, `A1 起草正向返回(got ${r && (r.error || 'ok')})`);
    ok(r.draft && typeof r.draft === 'object', 'A2 带回一份草稿对象');
    ok(r.saveVia === 'POST /api/playbooks', "A3 明确告诉模型「保存走 POST /api/playbooks」(它自己不保存)");
    ok(providerHits > before, 'A4 真的调了一次模型(起草不是编的)');
    const filesAfter = fs.existsSync(userPlaybooksDir) ? fs.readdirSync(userPlaybooksDir) : [];
    ok(JSON.stringify(filesAfter) === JSON.stringify(filesBefore), 'A5 起草【零落盘】(用户 playbook 目录没变)');
    ok(!fs.existsSync(path.join(userPlaybooksDir, 'pb-drafted.json')), 'A5b 草稿没有被存成用户 playbook 文件');
  }
  {
    // 同一回合(同 turnKey)第二次:配额用完。
    const r = await call('steward_playbook_draft', { sessionId: threadId2 }, stewardCtx(1));
    ok(r && r.ok === false && r.error === 'quota_exceeded', `A6 同一回合第二次起草 -> quota_exceeded(got ${r && r.error})`);
    // 下一回合(turnKey 变了)配额重置。
    const next = await call('steward_playbook_draft', { sessionId: threadId2 }, stewardCtx(2));
    ok(next && next.ok === true, 'A7 下一回合配额重置');
  }
  {
    const missing = await call('steward_playbook_draft', { sessionId: 'sess_nope' }, stewardCtx(3));
    ok(missing && missing.error === 'not_found', 'A8 不存在的线程 -> not_found');
    const self = await call('steward_playbook_draft', { sessionId: 'steward' }, stewardCtx(3));
    ok(self && self.ok === false, 'A9 管家会话自己不能被起草成 playbook');
  }

  /* ═════════ (B) skill_toggle ═════════ */
  console.log('── (B) skill_toggle ──');
  {
    const r = await call('steward_skill_toggle', { sessionId: threadId, skills: ['skill-1', 'skill-2'] });
    ok(r && r.ok === false && r.error === 'propose_required', `B1 无 userPressed -> propose_required(got ${r && r.error})`);
    ok(r.reason === 'confirm_required' && r.sessionId === threadId, 'B2 附 {reason:confirm_required, sessionId}');
    const s = await srv.loadSession(threadId);
    ok(!Array.isArray(s.skills) || s.skills.length === 0, 'B3 零写入(会话的 skills 没变)');
  }
  {
    const r = await call('steward_skill_toggle', { sessionId: threadId, skills: ['skill-1', 'skill-2'] }, stewardCtx(0, { userPressed: true }));
    ok(r && r.ok === true, `B4 有 userPressed 时真写入(got ${r && (r.error || 'ok')})`);
    ok(Array.isArray(r.skills) && r.skills.length === 2, 'B5 返回启用集');
    const s = await srv.loadSession(threadId);
    ok(Array.isArray(s.skills) && s.skills.length === 2 && s.skills.every(x => x.id && 'source' in x),
      'B6 会话头上落了 {id, source}(来源锁定,防调包)');
  }
  {
    const self = await call('steward_skill_toggle', { sessionId: 'steward', skills: [] }, stewardCtx(0, { userPressed: true }));
    ok(self && self.error === 'steward.forbidden', 'B7 管家会话自己没有技能面 -> steward.forbidden');
    const missing = await call('steward_skill_toggle', { sessionId: 'sess_nope', skills: [] }, stewardCtx(0, { userPressed: true }));
    ok(missing && missing.error === 'not_found', 'B8 不存在的线程 -> not_found');
    const notArray = await call('steward_skill_toggle', { sessionId: threadId, skills: 'skill-1' }, stewardCtx(0, { userPressed: true }));
    ok(notArray && notArray.error === 'invalid_request', 'B9 skills 不是数组 -> invalid_request');
  }

  /* ═════════ (C) 共用核心:工具与路由写出来的一模一样 ═════════ */
  console.log('── (C) 共用 setSessionSkillsCore ──');
  {
    const src13 = fs.readFileSync(path.join(WB, 'app', 'src', '13-http-router.js'), 'utf8');
    ok(/async function setSessionSkillsCore\(sessionId, skills\)/.test(src13), 'C0a 核心抽在 13-http-router 顶层');
    ok(/const result = await setSessionSkillsCore\(String\(body && body\.sessionId \|\| ''\), body && body\.skills\);/.test(src13),
      'C0b POST /api/session/skills 只剩壳,调核心');
    // 117 波 T1(32 号文 §2.1)重钉:steward_skill_toggle 的实现随拆分搬进了 13l-steward-ops.js
    // (纯搬家,逐字节不变)。原来钉「13g 这个文件里有这一行」= 钉落点;改成钉「整个 13g 族里
    // 恰好一处调这个核心」—— 跟着搬家走,且比原来严(族里再写第二套判据也红)。
    const stewardFamilySrc = ['13g-steward.js', '13j-steward-tool-base.js', '13k-steward-threads.js', '13l-steward-ops.js']
      .map(f => fs.readFileSync(path.join(WB, 'app', 'src', f), 'utf8')).join('\n');
    ok((stewardFamilySrc.match(/await setSessionSkillsCore\(sessionId, args\.skills\)/g) || []).length === 1,
      'C0c steward_skill_toggle 调同一个核心(不另写第二套判据;13g 族里恰好一处)');
  }
  {
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
      cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true,
    });
    wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));
    let token = '';
    for (let i = 0; i < 80 && !token; i++) {
      await sleep(150);
      try { token = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
    }
    const post = (p, body) => new Promise(resolve => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method: 'POST', headers: { 'x-wcw-token': token, 'content-type': 'application/json', 'content-length': payload.length } },
        res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => { try { resolve(JSON.parse(t)); } catch { resolve(null); } }); });
      r.on('error', () => resolve(null));
      r.write(payload); r.end();
    });
    // 一份「脏」输入:重复 id、不存在的 id、超过 8 个。两边都要清洗成同一个结果。
    const dirty = ['skill-1', 'skill-1', 'nope', 'skill-2', 'skill-3', 'skill-4', 'skill-5', 'skill-6', 'skill-7', 'skill-8', 'skill-9', 'skill-10'];
    let routeResult = null;
    for (let i = 0; i < 60 && !routeResult; i++) { routeResult = await post('/api/session/skills', { sessionId: threadId2, skills: dirty }); if (!routeResult) await sleep(150); }
    ok(routeResult && routeResult.ok === true, 'C1 路由写入成功');
    const toolResult = await call('steward_skill_toggle', { sessionId: threadId, skills: dirty }, stewardCtx(0, { userPressed: true }));
    ok(toolResult && toolResult.ok === true, 'C2 工具写入成功');
    ok(JSON.stringify(toolResult.skills) === JSON.stringify(routeResult.skills),
      `C3 两边清洗结果逐字节相同(去重/丢无效 id/截 8/带 source)\n      tool  = ${JSON.stringify(toolResult.skills)}\n      route = ${JSON.stringify(routeResult.skills)}`);
    ok(toolResult.skills.length === 8, `C4 截 8 生效(got ${toolResult.skills.length})`);
    ok(!toolResult.skills.some(s => s.id === 'nope'), 'C5 注册表里不存在的 id 被丢掉');
    ok(new Set(toolResult.skills.map(s => s.id)).size === toolResult.skills.length, 'C6 去重生效');
  }
} catch (e) {
  console.log('ERROR ' + ((e && e.stack) || e));
  fail++;
} finally {
  kill(wb);
  try { providerServer.close(); } catch { /* ignore */ }
  await sleep(300);
}

console.log('');
if (fail) { console.log(`STEWARD CONTENT TOOLS E2E: ${fail} FAILURE(S)`); process.exit(1); }
console.log('STEWARD CONTENT TOOLS E2E: ALL PASS');
process.exit(0);
})();
