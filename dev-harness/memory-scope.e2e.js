require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
(async () => {
'use strict';
// E2E(记忆走查「A:作用域与写入路径」):模型填 global 不再被静默降成 project、项目记忆能升全局、候选卡不丢、
// 写入口围栏/版本校验/来源保留、迁移导入的敏感扫描。
//   [A] 进程内直调(临时 RUYI_HOME,零网络):
//       A1 降级不再静默:proposal 带 requestedScope='global' / scopeAdjusted=true,回执仍带 scopeAdjusted:'global->project';
//       A2 关键词补全 + 最近 3 条用户消息:上一轮说「以后所有项目…」、这一轮只回「好,记下来吧」→ 保持 global;
//          「全局偏好,所有会话」「Remember globally」「每个项目」放行;个人偏好(preference + 我喜欢…)放行;
//       A3 批量每一条都带 requestedScope/scopeAdjusted(混合:被降级的与没被降级的各自如实);
//       A4 project 里已有同一条 + 模型想提 global → ok:false/duplicate/promotable,错误点名 revise 的 newScope;
//       A5 revise 带 newScope → proposal.newScope + baseUpdatedAt;apply → 写进全局、删旧、回执 moved;
//       A6 revise 过期(提议后记忆被改过)→ apply 409 语义(conflict + errorCode memory.proposal_stale),盘上不动;
//       A7 revise apply:core 记忆改 description → 核心胶囊注入新摘要(修前仍是旧摘要)、来源会话不丢;
//       A8 批量 apply 的 overrides:每条可改作用域与「加入核心」,勾上的才生效。
//   [H] 真服务 + 假 provider(主回合工具循环真的调 propose / revise):
//       H1 工具结果如实回给模型(scopeAdjusted);回放接口(replay:true)给出同一张待决卡、不调 provider;
//       H2 用户在卡上改回 global 后保存 → 落全局目录、候选 settle、回放变空;
//       H3 全局偏好说法放行 → 卡上就是 global(scopeAdjusted:false);
//       H4 批量卡 apply 带 overrides → 各条落到用户选的作用域、core 开关;
//       H5 revise 升全局(newScope)经 /api/memory/proposal/apply:落全局、旧的没了、回执 moved;
//       H6 revise 过期 → 409 + 稳定码 memory.proposal_stale,用户后来的手改还在;
//       H7 POST /api/memory 围栏:缺省/拼错 scope 在围栏外 cwd 下 400,global 不受 cwd 约束;
//       H8 编辑弹窗换作用域(moveFromScope):另存 + 删旧;同 id 在目标已存在 → 409 + memory.move_conflict;
//       H9 /api/memory/metadata 切核心不抹 sourceSessionId;
//       H10 GET /api/memory 的 limits 读配置;
//       H11 /api/memory/draft 超长对话留最新的(起草提示里有最近一条助手回复);
//       H12 迁移导入:~/.claude/CLAUDE.md 里的密钥不进核心记忆,迁移中心扫描行 sensitiveSkipped;
//       H13 revise apply 改 description:核心摘要随之更新(经 /api/memory/item 读回);
//       H14 provider 回合后自动审稿同一道作用域闸:用户说了「所有项目」→ 保持 global;只说「以后…」→ 降成 project 且记 requestedScope/scopeAdjusted。
const { killOwnTree } = require('./lib/kill-own-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, toolCallFrames } = require('./lib/fake-openai-provider');

const t = createRunner('MEMORY SCOPE');
const { ok } = t;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');

const HOME_A = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mem-scope-a-'));
process.env.RUYI_HOME = HOME_A;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_A;
const srv = require(path.join(WB, 'app', 'server.js'));

const listMd = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => path.join(dir, f)) : []);
const globalFiles = root => listMd(path.join(root, 'memory', 'global'));
const projectFiles = root => listMd(path.join(root, 'memory', 'project'));
const stateOf = (root, sid) => { try { return JSON.parse(fs.readFileSync(path.join(root, 'memory', 'proposals', sid + '.json'), 'utf8')); } catch { return null; } };
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const fmField = (file, key) => { const m = new RegExp('^' + key + ': ?(.*)$', 'm').exec(readText(file)); return m ? m[1].trim() : ''; };

try {
  /* ───────────────────────── [A] 进程内直调 ───────────────────────── */
  const PROJ = path.join(HOME_A, 'proj');
  fs.mkdirSync(PROJ, { recursive: true });
  let sidN = 0;
  const newSid = () => 'mem-scope-' + (++sidN);
  const ctx = (sid, turnSeq, messages) => ({ sessionId: sid, turnSeq, workingDir: PROJ, config: null,
    session: { id: sid, turnSeq, cwd: PROJ, messages: Array.isArray(messages) ? messages : [{ role: 'user', content: String(messages || '把这条记下来') }] } });
  const cand = (n, extra = {}) => ({ name: `kqs${n}vale kqs${n}mirt`, description: `when editing kqs${n}sorn kqs${n}pelt`, type: 'convention', scope: 'global',
    body: `结论 ${n}:提交信息一律用中文写清楚改了什么。适用:每次提交时。`, reason: `第 ${n} 条是用户确认过的长期规则`, ...extra });

  // A1
  const S1 = newSid();
  const a1 = await srv.proposeWorkbenchMemory(cand(1), ctx(S1, 1, '记住:提交信息用中文写'));
  ok(a1.ok && a1.proposal && a1.proposal.scope === 'project' && a1.proposal.requestedScope === 'global' && a1.proposal.scopeAdjusted === true && a1.scopeAdjusted === 'global->project',
    `A1 模型要 global、用户没说跨项目 → 落 project,但 proposal 记 requestedScope=global / scopeAdjusted=true,回执仍带 scopeAdjusted(got ${JSON.stringify(a1.proposal && { s: a1.proposal.scope, r: a1.proposal.requestedScope, a: a1.proposal.scopeAdjusted })})`);
  ok(stateOf(HOME_A, S1).current.proposal.requestedScope === 'global' && stateOf(HOME_A, S1).current.proposal.scopeAdjusted === true, 'A1b 候选状态文件里也记着(刷新后回放的卡据此标出「AI 建议全局」)');
  const a1p = await srv.proposeWorkbenchMemory(cand(2, { scope: 'project' }), ctx(newSid(), 1, '随便记一条'));
  ok(a1p.ok && a1p.proposal.scope === 'project' && a1p.proposal.requestedScope === 'project' && a1p.proposal.scopeAdjusted === false && a1p.scopeAdjusted === undefined,
    'A1c 模型本来就要 project → requestedScope=project、scopeAdjusted=false、回执不带降级标记');

  // A2
  const kept = async (n, messages, extra = {}) => {
    const r = await srv.proposeWorkbenchMemory(cand(n, extra), ctx(newSid(), 1, messages));
    return r.ok && r.proposal.scope === 'global' && r.proposal.scopeAdjusted === false;
  };
  ok(await kept(10, [{ role: 'user', content: '以后所有项目的提交信息都用中文' }, { role: 'assistant', content: '好的' }, { role: 'user', content: '好,那就记下来吧' }]),
    'A2 上一轮说「以后所有项目…」,这一轮只回「好,记下来吧」→ 保持 global(修前只看最后一条 → 降级)');
  ok(await kept(11, '…这是全局偏好,所有会话都适用'), 'A2b「全局偏好,所有会话」放行');
  ok(await kept(12, 'Remember globally that I prefer tabs'), 'A2c「Remember globally」放行');
  ok(await kept(13, '记住:每个项目都用中文写提交信息'), 'A2d「每个项目」放行');
  ok(await kept(14, '记住:我喜欢简洁的中文回复', { type: 'preference' }), 'A2e 个人偏好(preference + 我喜欢…)放行(用户第一条复现)');
  const a2f = await srv.proposeWorkbenchMemory(cand(15, { type: 'preference' }), ctx(newSid(), 1, '我喜欢这个项目用 tabs'));
  ok(a2f.ok && a2f.proposal.scope === 'project' && a2f.proposal.scopeAdjusted === true, 'A2f 个人口味但限定「这个项目」→ 仍按保守原则落 project');
  const a2g = await srv.proposeWorkbenchMemory(cand(16), ctx(newSid(), 1, [
    { role: 'user', content: '以后所有项目都用中文' }, { role: 'assistant', content: '1' }, { role: 'user', content: '再问个问题' }, { role: 'assistant', content: '2' },
    { role: 'user', content: '又一个问题' }, { role: 'assistant', content: '3' }, { role: 'user', content: '记下来' }]));
  ok(a2g.ok && a2g.proposal.scope === 'project', 'A2g 「所有项目」在 3 条之外(第 4 条)→ 不算(窗口是最近 3 条)');

  // A3
  const S3 = newSid();
  const a3 = await srv.proposeWorkbenchMemory({ items: [cand(20), cand(21, { scope: 'project' }), cand(22)] }, ctx(S3, 1, '记住:这三条都记下来'));
  const a3items = a3.ok && a3.proposal && a3.proposal.items;
  ok(a3.batch === true && a3items && a3items.length === 3
    && a3items.map(x => `${x.requestedScope}>${x.scope}:${x.scopeAdjusted}`).join() === 'global>project:true,project>project:false,global>project:true'
    && JSON.stringify(a3.scopeAdjustedItems) === '[0,2]',
  `A3 批量每一条都带 requestedScope/scopeAdjusted(被降级的与没被降级的各自如实)(got ${JSON.stringify(a3items && a3items.map(x => [x.requestedScope, x.scope, x.scopeAdjusted]))})`);
  const a3k = await srv.proposeWorkbenchMemory({ items: [cand(23), cand(24)] }, ctx(newSid(), 1, '每个项目都这样,两条都记'));
  ok(a3k.ok && a3k.proposal.items.every(x => x.scope === 'global' && x.scopeAdjusted === false), 'A3b 用户说了「每个项目」→ 批量两条都保持 global');

  // A4
  const existingP = await srv.saveMemory({ id: 'prom-1', scope: 'project', type: 'convention', name: 'kqpromo vale kqpromo mirt', description: 'when editing kqpromo sorn kqpromo pelt', body: '已有的项目约定', core: true }, PROJ);
  const a4 = await srv.proposeWorkbenchMemory({ name: 'kqpromo vale kqpromo mirt', description: 'when editing kqpromo sorn kqpromo pelt', type: 'convention', scope: 'global', body: '同一条,想升全局', reason: '用户说所有项目' },
    ctx(newSid(), 1, '这条对所有项目都适用'));
  ok(!a4.ok && a4.duplicate === true && a4.promotable === true && a4.existingId === 'prom-1' && a4.existingScope === 'project' && /newScope:"global"/.test(a4.error) && /workbench_memory_revise/.test(a4.error),
    `A4 project 里已有同一条、想提 global → 可提升(promotable),错误点名 revise 的 newScope(got ${JSON.stringify(a4).slice(0, 220)})`);
  const a4b = await srv.proposeWorkbenchMemory({ name: 'kqpromo vale kqpromo mirt', description: 'when editing kqpromo sorn kqpromo pelt', type: 'convention', scope: 'project', body: '同 scope 再提', reason: 'x' }, ctx(newSid(), 1, '再提一次'));
  ok(!a4b.ok && a4b.duplicate === true && a4b.promotable === undefined && /same or very similar/.test(a4b.error), 'A4b 同 scope 仍是普通重复(不带 promotable)');

  // A5
  const SR = newSid();
  const rev = await srv.proposeMemoryRevision({ id: 'prom-1', scope: 'project', newScope: 'global', reason: '用户说对所有项目都适用' }, ctx(SR, 1, '把它升成全局'));
  ok(rev.ok && rev.proposal.kind === 'memory_revise' && rev.proposal.targetScope === 'project' && rev.proposal.newScope === 'global' && typeof rev.proposal.baseUpdatedAt === 'string' && rev.proposal.baseUpdatedAt === existingP.memory.updatedAt,
    `A5 revise 带 newScope → proposal.newScope=global,baseUpdatedAt 记下提议时记忆的 updatedAt(got ${JSON.stringify(rev.proposal || rev)})`);
  const same = await srv.proposeMemoryRevision({ id: 'prom-1', scope: 'project', newScope: 'project', reason: 'x' }, ctx(newSid(), 1, 'x'));
  ok(!same.ok && /至少提供/.test(same.error), 'A5b newScope 与现作用域相同 = 没给,没有别的改动就拒绝');
  await srv.saveMemory({ id: 'prom-rel', scope: 'project', type: 'reference', name: 'rel other', description: 'other', body: 'o' }, PROJ);
  await srv.proposeMemoryRelation({ type: 'supports', from: 'prom-1', to: 'prom-rel', scope: 'project' }, PROJ).then(r => srv.confirmMemoryRelation(r.relation.id, PROJ));
  const applied = await srv.applyMemoryRelationProposal(SR, rev.proposalId, PROJ);
  ok(applied.ok && applied.applied && applied.applied.moved && applied.applied.moved.from === 'project' && applied.applied.moved.to === 'global' && applied.applied.moved.relationsDropped === 1,
    `A5c apply → 写进全局、删旧,回执 moved(并如实说丢了 1 条关系边)(got ${JSON.stringify(applied).slice(0, 240)})`);
  ok(globalFiles(HOME_A).some(f => path.basename(f) === 'prom-1.md') && !projectFiles(HOME_A).some(f => path.basename(f) === 'prom-1.md'), 'A5d 全局目录有、项目目录没有');
  ok(fmField(path.join(HOME_A, 'memory', 'global', 'prom-1.md'), 'core') === 'true' && fmField(path.join(HOME_A, 'memory', 'global', 'prom-1.md'), 'createdAt') === existingP.memory.createdAt,
    'A5e core 标记与 createdAt 随迁');

  // A6
  await srv.saveMemory({ id: 'stale-1', scope: 'project', type: 'convention', name: 'kqstale vale kqstale mirt', description: 'STALE-OLD description', body: '旧正文' }, PROJ);
  const SS = newSid();
  const staleRev = await srv.proposeMemoryRevision({ id: 'stale-1', scope: 'project', description: 'AI 建议的新描述', body: 'AI 建议的新正文', reason: '过时了' }, ctx(SS, 1, '改一下'));
  await sleep(15);
  await srv.saveMemory({ id: 'stale-1', scope: 'project', type: 'convention', name: 'kqstale vale kqstale mirt', description: '用户后来的手改', body: '用户后来的正文' }, PROJ);
  const staleApply = await srv.applyMemoryRelationProposal(SS, staleRev.proposalId, PROJ);
  ok(staleRev.ok && staleApply.ok === false && staleApply.conflict === true && staleApply.errorCode === 'memory.proposal_stale',
    `A6 提议之后记忆被改过 → apply 拒绝(conflict + memory.proposal_stale)(got ${JSON.stringify(staleApply)})`);
  const staleFile = projectFiles(HOME_A).find(f => path.basename(f) === 'stale-1.md');
  ok(readText(staleFile).includes('用户后来的手改') && !readText(staleFile).includes('AI 建议的新描述'), 'A6b 用户后来的手改还在,旧建议没盖掉');
  ok(stateOf(HOME_A, SS).current.status === 'pending', 'A6c 这张卡仍 pending(用户可以忽略它)');

  // A7
  await srv.saveMemory({ id: 'core-1', scope: 'global', type: 'preference', name: 'kqcore vale kqcore mirt', description: 'OLDCORE 用中文回复', body: '正文', core: true, sourceSessionId: 'orig-session-1' }, '');
  const SC = newSid();
  const coreRev = await srv.proposeMemoryRevision({ id: 'core-1', scope: 'global', description: 'NEWCORE 用简洁中文回复', reason: '更准确' }, ctx(SC, 1, '改一下'));
  const coreApplied = await srv.applyMemoryRelationProposal(SC, coreRev.proposalId, PROJ);
  const coreFile = path.join(HOME_A, 'memory', 'global', 'core-1.md');
  ok(coreRev.ok && coreApplied.ok && fmField(coreFile, 'coreSummary') === 'NEWCORE 用简洁中文回复', `A7 revise 改 description → coreSummary 跟随(got ${fmField(coreFile, 'coreSummary')})`);
  const reg = await srv.loadMemoryRegistry(PROJ);
  const coreState = await srv.resolveCoreMemoryState(PROJ, reg, null);
  const coreSection = srv.buildCoreMemoryPromptSection(coreState.active, null);
  ok(/NEWCORE/.test(coreSection) && !/OLDCORE/.test(coreSection), 'A7b 核心胶囊注入的是新摘要(修前每轮仍注入旧摘要)');
  ok(fmField(coreFile, 'sourceSessionId') === 'orig-session-1', 'A7c revise 落盘不抹来源会话');

  // A8
  const S8 = newSid();
  const b8 = await srv.proposeWorkbenchMemory({ items: [cand(40, { scope: 'project' }), cand(41, { scope: 'project', type: 'lesson' }), cand(42, { scope: 'project' })] }, ctx(S8, 1, '三条都记'));
  const ap8 = await srv.applyMemoryRelationProposal(S8, b8.proposalId, PROJ, { accept: [0, 1], overrides: { 0: { scope: 'global', core: false }, 1: { scope: 'project', core: true }, 2: { scope: 'global' } } });
  const f40 = globalFiles(HOME_A).find(f => /kqs40vale/.test(readText(f)));
  const f41 = projectFiles(HOME_A).find(f => /kqs41vale/.test(readText(f)));
  ok(ap8.ok && ap8.saved.length === 2 && f40 && fmField(f40, 'core') === 'false' && f41 && fmField(f41, 'core') === 'true',
    `A8 批量 apply 的 overrides:第 0 条改成全局且不加入核心、第 1 条(lesson)改成加入核心(got ${JSON.stringify({ saved: ap8.saved, f40: Boolean(f40), f41: Boolean(f41) })})`);
  ok(!globalFiles(HOME_A).concat(projectFiles(HOME_A)).some(f => /kqs42vale/.test(readText(f))), 'A8b 没勾上的第 2 条即使带了 override 也不写');
  ok(ap8.saved.map(s => s.scope).join() === 'global,project', 'A8c 回执里的 scope 是用户最终选的');
  const b8n = await srv.proposeWorkbenchMemory({ items: [cand(43, { scope: 'project' }), cand(44, { scope: 'project', type: 'preference' })] }, ctx(newSid(), 1, '两条'));
  const S8n = b8n.proposal.sourceSessionId;
  const ap8n = await srv.applyMemoryRelationProposal(S8n, b8n.proposalId, PROJ, { accept: [0, 1] });
  const f43 = projectFiles(HOME_A).find(f => /kqs43vale/.test(readText(f))), f44 = projectFiles(HOME_A).find(f => /kqs44vale/.test(readText(f)));
  ok(ap8n.ok && f43 && fmField(f43, 'core') === 'true' && f44 && fmField(f44, 'core') === 'true', 'A8d 不带 overrides 时与修前一致:偏好/惯例默认进核心');

  /* ───────────────────────── [H] 真服务 + 假 provider ───────────────────────── */
  const HOME_H = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mem-scope-h-'));
  const WS = path.join(HOME_H, 'ws');
  const OUTSIDE = path.join(os.tmpdir(), 'ruyi-mem-scope-outside-' + process.pid);
  const CLI_HOME = path.join(HOME_H, 'cli-home');
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(path.join(CLI_HOME, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(CLI_HOME, '.claude', 'CLAUDE.md'), ['# 规矩', 'HOME_RULE_MARKER 回答一律用中文。', '', '# 部署', 'prod 数据库 password: SuperSecret998877', '', '# 收尾', '改完跑测试。'].join('\n'));
  const contentText = c => (typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => (p && p.text) || '').join('') : '');
  const errCode = b => (b && b.error && typeof b.error === 'object' ? b.error.code : '');
  const tagOf = req => {
    const lastUser = req.messages.map(m => m && m.role === 'user').lastIndexOf(true);
    const m = /\[(DOWN|KEEP|BATCH|REV|REVSTALE|REVDESC|LONG\d)\]/.exec(contentText(req.messages[lastUser] && req.messages[lastUser].content));
    return { tag: m ? m[1] : '', lastUser };
  };
  const targets = { up: '', stale: '', desc: '' };
  const LONG_REPLY = n => `TURN${n} ` + '字'.repeat(700);
  const fake = await startFakeProvider({
    handler(req) {
      const joined = JSON.stringify(req.messages);
      if (!req.stream && /严格审稿人/.test(joined)) {
        const keep = /AUTO-KEEP/.test(joined);
        return textFrames(JSON.stringify({ decision: 'propose', confidence: 0.95, durability: 'durable', name: '回答语言使用简洁中文', description: '所有项目的回答语言偏好 ' + (keep ? 'AUTOKEEP' : 'AUTODOWN'),
          type: 'preference', scope: 'global', body: '以后所有项目的回答语言都使用简洁中文。', reason: '用户给出的长期偏好' }));
      }
      if (!req.stream) return textFrames(/这次会话近况/.test(joined) ? '{"name":"起草的记忆","description":"d","type":"lesson","body":"b"}' : '{"title":"t","gist":"g"}');
      const { tag, lastUser } = tagOf(req);
      const answered = req.messages.slice(lastUser + 1).some(m => m && m.role === 'tool');
      const has = name => (req.tools || []).some(x => x && x.function && x.function.name === name);
      if (!answered && tag === 'DOWN' && has('workbench_memory_propose')) return toolCallFrames('workbench_memory_propose', { name: '提交信息用中文 kqhdown', description: '写提交信息时适用 kqhdown', type: 'convention', scope: 'global', body: '提交信息一律用中文写。', reason: '用户要求' }, 'c_down');
      if (!answered && tag === 'KEEP' && has('workbench_memory_propose')) return toolCallFrames('workbench_memory_propose', { name: '回复语言偏好 kqhkeep', description: '所有对话回复语言 kqhkeep', type: 'preference', scope: 'global', body: '回复一律用简洁中文。', reason: '用户说全局偏好' }, 'c_keep');
      if (!answered && tag === 'BATCH' && has('workbench_memory_propose')) return toolCallFrames('workbench_memory_propose', { items: [
        { name: 'kqhb1vale kqhb1mirt', description: 'when editing kqhb1sorn kqhb1pelt', type: 'convention', scope: 'global', body: '批量第一条正文', reason: 'r1' },
        { name: 'kqhb2vale kqhb2mirt', description: 'when editing kqhb2sorn kqhb2pelt', type: 'lesson', scope: 'project', body: '批量第二条正文', reason: 'r2' },
        { name: 'kqhb3vale kqhb3mirt', description: 'when editing kqhb3sorn kqhb3pelt', type: 'convention', scope: 'project', body: '批量第三条正文', reason: 'r3' }] }, 'c_batch');
      if (!answered && tag === 'REV' && has('workbench_memory_revise')) return toolCallFrames('workbench_memory_revise', { id: targets.up, scope: 'project', newScope: 'global', reason: '用户说所有项目都适用' }, 'c_rev');
      if (!answered && tag === 'REVSTALE' && has('workbench_memory_revise')) return toolCallFrames('workbench_memory_revise', { id: targets.stale, scope: 'project', description: 'AI 建议的新描述 HSTALE', reason: '过时了' }, 'c_revstale');
      if (!answered && tag === 'REVDESC' && has('workbench_memory_revise')) return toolCallFrames('workbench_memory_revise', { id: targets.desc, scope: 'global', description: 'HNEWDESC 新的说明', reason: '更准确' }, 'c_revdesc');
      if (/^LONG\d$/.test(tag)) return textFrames(LONG_REPLY(Number(tag.slice(4))));
      if (/AUTO-(KEEP|DOWN)/.test(contentText(req.messages[lastUser] && req.messages[lastUser].content))) return textFrames('好的,以后所有项目的回答语言都会使用简洁中文,我已经记住这个长期偏好,并会在后续回合持续遵守这个约定,不会再改回别的语言。'.repeat(2));
      return textFrames('好的。');
    },
  });
  fs.writeFileSync(path.join(HOME_H, 'config.json'), JSON.stringify({
    configSchema: 9, version: '1.0.0', permissionMode: 'bypass', engineMode: 'interactive', defaultWorkspace: WS,
    memoryRelevanceMaxV1: 5, memoryFixedSelectionMaxV1: 40,
    autoImportClaudeCodeMcp: false, enableMcpDropIn: false, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'F' }] }],
    activeProvider: 'fake',
  }));
  const WP = await getFreePort();
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, RUYI_HOME: HOME_H, WIN_CLAUDE_WORKBENCH_HOME: HOME_H, HOME: CLI_HOME, USERPROFILE: CLI_HOME } });
  let TOKEN = '';
  const requestJson = (method, route, payload) => new Promise((resolve, reject) => {
    const data = payload == null ? '' : JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WP, path: route, method, timeout: 20000,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...(TOKEN ? { 'x-wcw-token': TOKEN } : {}) } }, res => {
      let body = ''; res.setEncoding('utf8'); res.on('data', c => { body += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* non-json */ } resolve({ status: res.statusCode, body: json }); });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (data) r.write(data); r.end();
  });
  const streamTurn = payload => new Promise((resolve, reject) => {
    const raw = JSON.stringify(payload);
    const r = http.request({ host: '127.0.0.1', port: WP, path: '/api/chat/stream', method: 'POST', timeout: 30000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => {
      let buf = ''; res.setEncoding('utf8'); res.on('data', c => { buf += c; }); res.on('end', () => resolve(buf));
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout'))); r.write(raw); r.end();
  });
  const newSession = async () => { const c = await requestJson('POST', '/api/sessions', { cwd: WS }); return c.body && c.body.session && c.body.session.id; };
  const turn = async (sid, message) => streamTurn({ sessionId: sid, cwd: WS, message });
  const toolResultOf = (callId, tag) => {
    const second = fake.requests.filter(r => r.stream && JSON.stringify(r.messages).includes('[' + tag + ']')).find(r => r.messages.some(m => m && m.role === 'tool' && m.tool_call_id === callId));
    return second ? JSON.parse(contentText(second.messages.find(m => m.role === 'tool' && m.tool_call_id === callId).content) || 'null') : null;
  };
  const saveMem = (memory, extra = {}) => requestJson('POST', '/api/memory', { memory, cwd: WS, ...extra });
  try {
    let up = false;
    for (let i = 0; i < 300 && !up; i++) { try { up = (await requestJson('GET', '/health')).status === 200; } catch { /* not yet */ } if (!up) await sleep(120); }
    ok(up, 'H0 工作台起来了');
    for (let i = 0; i < 300 && !TOKEN; i++) { try { TOKEN = JSON.parse(fs.readFileSync(path.join(HOME_H, 'runtime.json'), 'utf8')).token || ''; } catch { /* not yet */ } if (!TOKEN) await sleep(100); }
    ok(Boolean(TOKEN), 'H0b 读到 token');

    // H1
    const H1 = await newSession();
    const out1 = await turn(H1, '记住:提交信息用中文写 [DOWN]');
    ok(Boolean(H1) && /"type":"result","ok":true/.test(out1), 'H1 回合跑完(主回合真的调了 workbench_memory_propose{scope:global})');
    const res1 = toolResultOf('c_down', 'DOWN');
    ok(res1 && res1.ok === true && res1.scopeAdjusted === 'global->project' && res1.proposal && res1.proposal.requestedScope === 'global' && res1.proposal.scope === 'project',
      `H1b 工具结果如实回给模型(降级 + proposal 带 requestedScope)(got ${JSON.stringify(res1).slice(0, 200)})`);
    const reqCount = fake.requests.length;
    const replay = await requestJson('POST', '/api/memory/proposal', { sessionId: H1, replay: true });
    const rp = replay.body || {};
    ok(replay.status === 200 && rp.ok && rp.replayed === true && rp.reason === 'pending_replay' && rp.proposalId === res1.proposalId && rp.proposal.requestedScope === 'global' && rp.proposal.scopeAdjusted === true,
      `H1c replay:true 回放同一张待决卡,卡上有 AI 建议的作用域(got ${JSON.stringify(rp).slice(0, 220)})`);
    ok(fake.requests.length === reqCount, 'H1d 回放不调 provider(零辅助调用)');
    const none = await requestJson('POST', '/api/memory/proposal', { sessionId: await newSession(), replay: true });
    ok(none.status === 200 && none.body.proposal === null && none.body.reason === 'none_pending', 'H1e 没有待决候选的会话回放为空');
    const bad = await requestJson('POST', '/api/memory/proposal', { sessionId: 'no-such-session-xyz', replay: true });
    ok(bad.status === 200 && bad.body.proposal === null, 'H1f 不存在的会话回放为空(不报错)');

    // H2
    const saved2 = await saveMem({ ...rp.proposal, scope: 'global' }, { proposalId: rp.proposalId, sourceSessionId: H1 });
    ok(saved2.status === 200 && globalFiles(HOME_H).some(f => /kqhdown/.test(readText(f))) && !projectFiles(HOME_H).some(f => /kqhdown/.test(readText(f))),
      `H2 用户在卡上改回 global 后保存 → 落全局目录(got ${saved2.status})`);
    const replay2 = await requestJson('POST', '/api/memory/proposal', { sessionId: H1, replay: true });
    ok(replay2.body && replay2.body.proposal === null, 'H2b 保存后候选 settle,回放变空(不会重复画卡)');

    // H3
    const H3 = await newSession();
    await turn(H3, '这是全局偏好,所有会话都适用 [KEEP]');
    const res3 = toolResultOf('c_keep', 'KEEP');
    ok(res3 && res3.ok && res3.proposal.scope === 'global' && res3.proposal.scopeAdjusted === false && res3.scopeAdjusted === undefined, `H3 「全局偏好,所有会话」→ 卡上就是 global,没被降级(got ${JSON.stringify(res3).slice(0, 160)})`);

    // H4
    const H4 = await newSession();
    await turn(H4, '把这三条记下来 [BATCH]');
    const rp4 = (await requestJson('POST', '/api/memory/proposal', { sessionId: H4, replay: true })).body || {};
    ok(rp4.proposal && rp4.proposal.kind === 'memory_batch' && rp4.proposal.items.map(x => `${x.requestedScope}>${x.scope}`).join() === 'global>project,project>project,project>project',
      `H4 批量卡回放:每条带 requestedScope(got ${JSON.stringify(rp4.proposal && rp4.proposal.items.map(x => [x.requestedScope, x.scope]))})`);
    const ap4 = await requestJson('POST', '/api/memory/proposal/apply', { sessionId: H4, proposalId: rp4.proposalId, cwd: WS, accept: [0, 1],
      overrides: { 0: { scope: 'global', core: false }, 1: { scope: 'global', core: true } } });
    const g4 = globalFiles(HOME_H).filter(f => /kqhb[12]/.test(readText(f)));
    ok(ap4.status === 200 && ap4.body.ok && g4.length === 2 && g4.every(f => /kqhb/.test(readText(f))) && fmField(g4.find(f => /kqhb1/.test(readText(f))), 'core') === 'false' && fmField(g4.find(f => /kqhb2/.test(readText(f))), 'core') === 'true',
      `H4b apply 带 overrides:两条落到用户选的全局,core 开关各自生效(got ${ap4.status} ${JSON.stringify(ap4.body).slice(0, 160)})`);
    ok(!projectFiles(HOME_H).some(f => /kqhb/.test(readText(f))), 'H4c 项目目录里没有这两条');

    // H5 / H6 / H13 先造被改的记忆
    const mk = async (id, extra = {}) => (await saveMem({ id, scope: 'project', type: 'convention', name: 'kq ' + id, description: 'DESC of ' + id, body: 'body of ' + id, ...extra })).body;
    await mk('h-up', { core: true, sourceSessionId: 'orig-up' });
    await mk('h-stale');
    await saveMem({ id: 'h-desc', scope: 'global', type: 'preference', name: 'kq h-desc', description: 'HOLDDESC 旧的说明', body: 'b', core: true });
    targets.up = 'h-up'; targets.stale = 'h-stale'; targets.desc = 'h-desc';
    const H5 = await newSession();
    await turn(H5, '请修订记忆:把 h-up 升成全局,它对所有项目都适用 [REV]');
    const rp5 = (await requestJson('POST', '/api/memory/proposal', { sessionId: H5, replay: true })).body || {};
    ok(rp5.proposal && rp5.proposal.kind === 'memory_revise' && rp5.proposal.targetScope === 'project' && rp5.proposal.newScope === 'global', `H5 主回合真的调了 revise{newScope:global}(got ${JSON.stringify(rp5.proposal || rp5).slice(0, 200)})`);
    const ap5 = await requestJson('POST', '/api/memory/proposal/apply', { sessionId: H5, proposalId: rp5.proposalId, cwd: WS });
    ok(ap5.status === 200 && ap5.body.ok && ap5.body.applied && ap5.body.applied.moved && ap5.body.applied.moved.to === 'global', `H5b apply → 200,回执 moved(got ${ap5.status} ${JSON.stringify(ap5.body).slice(0, 200)})`);
    ok(globalFiles(HOME_H).some(f => path.basename(f) === 'h-up.md') && !projectFiles(HOME_H).some(f => path.basename(f) === 'h-up.md'), 'H5c 全局有、项目没有');
    ok(fmField(path.join(HOME_H, 'memory', 'global', 'h-up.md'), 'sourceSessionId') === 'orig-up', 'H5d 来源会话沿用');

    const H6 = await newSession();
    await turn(H6, '请修订记忆:h-stale 的描述改一下 [REVSTALE]');
    const rp6 = (await requestJson('POST', '/api/memory/proposal', { sessionId: H6, replay: true })).body || {};
    ok(rp6.proposal && rp6.proposal.kind === 'memory_revise' && typeof rp6.proposal.baseUpdatedAt === 'string' && rp6.proposal.baseUpdatedAt !== '', 'H6 revise 提议记下 baseUpdatedAt');
    await sleep(20);
    await mk('h-stale', { description: '用户后来的手改 HUSER' });
    const ap6 = await requestJson('POST', '/api/memory/proposal/apply', { sessionId: H6, proposalId: rp6.proposalId, cwd: WS });
    ok(ap6.status === 409 && errCode(ap6.body) === 'memory.proposal_stale' && ap6.body.error.params && ap6.body.error.params.name,
      `H6b 提议之后记忆被改过 → 409 + 稳定码 memory.proposal_stale(got ${ap6.status} ${JSON.stringify(ap6.body).slice(0, 200)})`);
    const staleFile = projectFiles(HOME_H).find(f => path.basename(f) === 'h-stale.md');
    ok(readText(staleFile).includes('HUSER') && !readText(staleFile).includes('HSTALE'), 'H6c 用户后来的手改还在');

    const H13 = await newSession();
    await turn(H13, '请修订记忆:h-desc 的说明改一下 [REVDESC]');
    const rp13 = (await requestJson('POST', '/api/memory/proposal', { sessionId: H13, replay: true })).body || {};
    const ap13 = await requestJson('POST', '/api/memory/proposal/apply', { sessionId: H13, proposalId: rp13.proposalId, cwd: WS });
    const item13 = (await requestJson('GET', '/api/memory/item?id=h-desc&scope=global&cwd=' + encodeURIComponent(WS))).body;
    ok(ap13.status === 200 && item13.memory && item13.memory.description === 'HNEWDESC 新的说明' && item13.memory.coreSummary === 'HNEWDESC 新的说明',
      `H13 revise apply 改 description → 核心摘要随之更新(got ${JSON.stringify(item13.memory && { d: item13.memory.description, c: item13.memory.coreSummary })})`);

    // H7 围栏
    const f1 = await requestJson('POST', '/api/memory', { memory: { name: 'fence-1', body: 'x' }, cwd: OUTSIDE });
    ok(f1.status === 400, `H7 缺省 scope + 围栏外 cwd → 400(修前只拦 scope==='project',缺省的绕过去)(got ${f1.status})`);
    const f2 = await requestJson('POST', '/api/memory', { memory: { name: 'fence-2', body: 'x', scope: 'bogus' }, cwd: OUTSIDE });
    ok(f2.status === 400, `H7b scope 拼错 + 围栏外 cwd → 400(got ${f2.status})`);
    const f3 = await requestJson('POST', '/api/memory', { memory: { name: 'fence-3', body: 'x', scope: 'global' }, cwd: OUTSIDE });
    ok(f3.status === 200 && f3.body.ok, `H7c global 不受 cwd 约束(got ${f3.status})`);
    const projDirs = fs.existsSync(path.join(HOME_H, 'memory', 'project')) ? fs.readdirSync(path.join(HOME_H, 'memory', 'project')) : [];
    const outsideMeta = projDirs.some(d => { try { return JSON.parse(fs.readFileSync(path.join(HOME_H, 'memory', 'project', d, 'meta.json'), 'utf8')).path === path.resolve(OUTSIDE); } catch { return false; } });
    ok(!outsideMeta, 'H7d 围栏外 cwd 没有建出项目目录/meta.json');

    // H8 换作用域
    await saveMem({ id: 'h-move', scope: 'project', type: 'lesson', name: 'kq h-move', description: 'MOVE desc', body: 'MOVE body', importance: 'important', sourceSessionId: 'orig-move' });
    const mv = await requestJson('POST', '/api/memory', { memory: { id: 'h-move', scope: 'global', type: 'lesson', name: 'kq h-move', description: 'MOVE desc 改', body: 'MOVE body', importance: 'important', core: false, coreSummary: '', sourceSessionId: 'orig-move' }, cwd: WS, moveFromScope: 'project' });
    ok(mv.status === 200 && mv.body.ok && mv.body.moved && mv.body.moved.to === 'global'
      && globalFiles(HOME_H).some(f => path.basename(f) === 'h-move.md') && !projectFiles(HOME_H).some(f => path.basename(f) === 'h-move.md'),
    `H8 编辑弹窗换作用域(moveFromScope)→ 另存 + 删旧(got ${mv.status} ${JSON.stringify(mv.body).slice(0, 160)})`);
    await saveMem({ id: 'h-dup', scope: 'project', type: 'lesson', name: 'p-dup', description: 'd', body: 'PROJECT copy' });
    await saveMem({ id: 'h-dup', scope: 'global', type: 'lesson', name: 'g-dup', description: 'd', body: 'GLOBAL copy' });
    const mvc = await requestJson('POST', '/api/memory', { memory: { id: 'h-dup', scope: 'global', type: 'lesson', name: 'p-dup', description: 'd', body: 'PROJECT copy' }, cwd: WS, moveFromScope: 'project' });
    ok(mvc.status === 409 && errCode(mvc.body) === 'memory.move_conflict' && readText(path.join(HOME_H, 'memory', 'global', 'h-dup.md')).includes('GLOBAL copy')
      && projectFiles(HOME_H).some(f => path.basename(f) === 'h-dup.md'), `H8b 同 id 在目标已存在 → 409 + memory.move_conflict,两边都不动(got ${mvc.status})`);

    // H9 metadata
    await saveMem({ id: 'h-meta', scope: 'project', type: 'convention', name: 'kq h-meta', description: 'meta desc', body: 'meta body', sourceSessionId: 'orig-meta', sourceRunId: 'run-meta' });
    const meta = await requestJson('POST', '/api/memory/metadata', { id: 'h-meta', scope: 'project', cwd: WS, patch: { core: true, importance: 'important' } });
    const metaFile = projectFiles(HOME_H).find(f => path.basename(f) === 'h-meta.md');
    ok(meta.status === 200 && fmField(metaFile, 'core') === 'true' && fmField(metaFile, 'sourceSessionId') === 'orig-meta' && fmField(metaFile, 'sourceRunId') === 'run-meta',
      `H9 切核心/重要后 sourceSessionId / sourceRunId 还在(修前被抹掉)(got ${meta.status} ${fmField(metaFile, 'sourceSessionId')})`);

    // H10 limits
    const list = (await requestJson('GET', '/api/memory?cwd=' + encodeURIComponent(WS))).body || {};
    ok(list.ok && list.limits && list.limits.relevanceMax === 5 && list.limits.fixedSelectionMax === 40 && list.limits.coreItemMax === 200 && list.limits.coreCharBudget === 16000,
      `H10 GET /api/memory 回 limits(读配置:5/40,核心默认 200/16000)(got ${JSON.stringify(list.limits)})`);

    // H11 draft recency
    const H11 = await newSession();
    for (let n = 1; n <= 4; n++) await turn(H11, `第 ${n} 轮问题 [LONG${n}] ` + '问'.repeat(780));
    const draft = await requestJson('POST', '/api/memory/draft', { sessionId: H11 });
    const draftReq = fake.requests.filter(r => !r.stream && /这次会话近况/.test(JSON.stringify(r.messages))).pop();
    const draftPrompt = draftReq ? contentText(draftReq.messages[draftReq.messages.length - 1].content) : '';
    ok(draft.status === 200 && draft.body.ok && /TURN4/.test(draftPrompt) && !/TURN1 /.test(draftPrompt),
      `H11 起草提示里有最近一条助手回复(TURN4),最旧的被舍弃(修前反过来)(prompt 长 ${draftPrompt.length},got ${draft.status})`);

    // H14 自动审稿同一道作用域闸
    const autoTurn = async message => {
      const sid = await newSession();
      const out = await turn(sid, message);
      const r = await requestJson('POST', '/api/memory/proposal', { sessionId: sid });
      return { sid, out, body: r.body || {} };
    };
    const keepAuto = await autoTurn('以后所有项目的回答语言都用简洁中文 [AUTO-KEEP]');
    ok(/"type":"result","ok":true/.test(keepAuto.out) && keepAuto.body.proposal && keepAuto.body.proposal.scope === 'global' && keepAuto.body.proposal.requestedScope === 'global' && keepAuto.body.proposal.scopeAdjusted === false,
      `H14 自动审稿:用户说了「所有项目」→ 保持 global、没被降级(got ${JSON.stringify(keepAuto.body).slice(0, 220)})`);
    const downAuto = await autoTurn('以后回答语言都用简洁中文 [AUTO-DOWN]');
    ok(downAuto.body.proposal && downAuto.body.proposal.scope === 'project' && downAuto.body.proposal.requestedScope === 'global' && downAuto.body.proposal.scopeAdjusted === true,
      `H14b 自动审稿:只说「以后…」→ 降成 project,但 proposal 记 requestedScope=global / scopeAdjusted=true(got ${JSON.stringify(downAuto.body).slice(0, 220)})`);
    const downReplay = (await requestJson('POST', '/api/memory/proposal', { sessionId: downAuto.sid, replay: true })).body || {};
    ok(downReplay.proposalId === downAuto.body.proposalId && downReplay.proposal && downReplay.proposal.scopeAdjusted === true, 'H14c 自动候选同样能经 replay:true 回放(卡上带 AI 建议的作用域)');

    // H12 迁移导入敏感扫描
    const scan = (await requestJson('GET', '/api/migration/scan')).body || {};
    const row = (scan.instructions || []).find(x => x.key === 'claude-md');
    ok(row && row.status === 'imported' && row.sensitiveSkipped === 1, `H12 迁移中心扫描行如实标出被跳过的敏感段(got ${JSON.stringify(row)})`);
    const importedText = globalFiles(HOME_H).filter(f => /agentmd-claude-md-/.test(f)).map(readText).join('\n');
    ok(/HOME_RULE_MARKER/.test(importedText) && /改完跑测试/.test(importedText) && !/SuperSecret998877/.test(importedText), 'H12b 干净的段导入了,含 password 的那段没进核心记忆');
    const wholeData = [...globalFiles(HOME_H), ...projectFiles(HOME_H)].map(readText).join('\n');
    ok(!/SuperSecret998877/.test(wholeData), 'H12c 整个记忆库里没有那个口令');
  } finally {
    const exited = new Promise(resolve => { if (wb.exitCode !== null) resolve(); else wb.once('exit', resolve); });
    try { killOwnTree(wb.pid); } catch { /* gone */ }
    await Promise.race([exited, sleep(5000)]);
    await fake.close();
    try { fs.rmSync(HOME_H, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
} catch (e) {
  t.fail('fatal: ' + (e && e.stack || e));
} finally {
  try { fs.rmSync(HOME_A, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  t.done({ exit: true });
}
})();
