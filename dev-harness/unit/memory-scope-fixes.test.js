'use strict';
// 记忆走查「A:作用域与写入路径」(06d-memory-domain)。真源码、临时 HOME、零网络。
// 未导出的内部函数经 dev-harness/lib/server-internals.js 取真函数(不增加 14-main.js 的导出面)。
//   [G]  作用域闸:模型要 global 时,用户最近几条消息里有没有「全局」的说法(关键词补全 + 多条消息窗口 + 个人偏好口径);
//   [N]  normalizeMemoryProposalCandidate:requestedScope / scopeAdjusted 写进 proposal(被降级不再是静默的);
//   [D]  重复判定:project 里已有同一条、模型想提 global → promotable(指向 revise 的 newScope),同 scope 仍是重复;
//   [C]  saveMemory 的 coreSummary:旧摘要只是 description 的跟随值、description 变了,摘要跟着变(核心胶囊不再注入旧摘要);
//   [R]  readMemoryItem 回传来源字段,「读原条目 → saveMemory」的元数据快捷操作不再抹掉 sourceSessionId;
//   [M]  moveMemoryScope:提升/下放,createdAt、用量旁账随迁,关系边(不能跨作用域)摘掉并如实计数,同 id 冲突拒绝;
//   [P]  迁移导入的敏感扫描:命中的块不导入(含横跨硬切接缝的 key=value),sync 行如实带 sensitiveSkipped,旧记录补扫重导;
//   [K]  起草上下文超长时留最新的;
//   [G4][G5]  (第三波复核)编程语义的「全局变量 / global variables / 全局搜索」不算「全局生效」;自动审稿路径与工具路径同一口径(explicit 也放行)。
// 反向验证:RUYI_TEST_SERVER_JS 指到修前的 server.js,本文件应当红(见各用例的「修前」说明)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-scope-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.HOME = path.join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
delete process.env.CODEX_HOME;
delete process.env.KIMI_CODE_HOME;
fs.mkdirSync(path.join(process.env.HOME, '.claude'), { recursive: true });
const PROJ = path.join(root, 'proj');
fs.mkdirSync(PROJ, { recursive: true });

const { loadServerInternals } = require('../lib/server-internals');
// 反向验证时 server.js 是修前那份:新符号不存在会让 loadServerInternals 直接抛 ReferenceError(整件加载失败)。
// 这里只取源码里真有的名字,缺的留 undefined,让用到它的用例各自红在「功能不存在」上,而不是整件一起死。
const SERVER = process.env.RUYI_TEST_SERVER_JS ? path.resolve(process.env.RUYI_TEST_SERVER_JS) : path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'server.js');
const SERVER_SRC = fs.readFileSync(SERVER, 'utf8');
const WANT = ['memoryGlobalScopeAllowed', 'memoryRecentUserTexts', 'normalizeMemoryProposalCandidate', 'findMemoryProposalDuplicate', 'memoryProposalDuplicateFailure',
  'saveMemory', 'readMemoryItem', 'moveMemoryScope', 'memoryGlobalDir', 'memoryProjectDir', 'memoryUsageKey', 'touchMemoryUsage', 'readMemoryUsageState',
  'writeMemoryRelations', 'readMemoryRelations', 'loadMemoryRegistry', 'resolveCoreMemoryState', 'buildCoreMemoryPromptSection',
  'planAgentInstructionEntries', 'syncAgentInstructionImports', 'agentInstructionSources', 'readAgentInstructionSource', 'splitAgentInstructionText',
  'renderAgentInstructionMemory', 'agentInstructionMemoryId', 'agentInstructionImportFile', 'sha256Hex', 'clipRecentMemoryDraftContext', 'parseFrontmatter',
  'memoryAutoGlobalAllowed', 'memoryProposalPrefilter'];
const present = WANT.filter(n => new RegExp('(?:function|const|let)\\s+' + n + '\\b').test(SERVER_SRC));
const I = loadServerInternals(present);
const need = name => { assert.equal(typeof I[name], 'function', `${name} 不存在(修前代码没有这个功能)`); return I[name]; };

const memFile = (scope, id) => path.join(scope === 'global' ? path.join(root, 'memory', 'global') : I.memoryProjectDir(PROJ), id + '.md');
const fmOf = (scope, id) => I.parseFrontmatter(fs.readFileSync(memFile(scope, id), 'utf8'));

// ───────────── [G] 作用域闸 ─────────────
test('[G1] 用户说「全局/所有会话/每个项目/globally/everywhere…」时放行 global(修前只认四五个词)', () => {
  const allow = need('memoryGlobalScopeAllowed');
  for (const text of ['…这是全局偏好,所有会话都适用', 'Remember globally that I prefer tabs', '记住:每个项目都用中文写提交信息', '各个项目都这样', '不管哪个项目都要先跑测试',
    '跨工作区的约定', '所有工作区都生效', 'use tabs everywhere', 'in any project please', 'across all workspaces', 'across workspaces',
    // 修前就认的四个(不能退化)
    '以后所有项目都用 tab', '跨项目通用', '任何项目里都这样', '个人偏好:简洁', 'for all projects', 'across projects', 'in every project', 'my personal preference']) {
    assert.equal(allow('convention', text), true, `应放行:${text}`);
  }
});

test('[G2] 没有任何跨项目说法 → 不放行(保守原则仍在);个人口味(type=preference)走第二条路,但限定「这个项目」的不算', () => {
  const allow = need('memoryGlobalScopeAllowed');
  for (const text of ['记住:提交信息用中文写', '本项目用 pnpm', 'remember to use pnpm', '好的', '']) assert.equal(allow('convention', text), false, `不应放行:${text}`);
  assert.equal(allow('preference', '记住:我喜欢简洁的中文回复'), true, '个人偏好:「我喜欢…」(用户第一条复现)');
  assert.equal(allow('preference', 'I prefer concise answers'), true);
  assert.equal(allow('convention', '记住:我喜欢简洁的中文回复'), false, '第二条路只给 preference');
  assert.equal(allow('preference', '我喜欢这个项目用 tabs'), false, '同一句话把范围限在「这个项目」');
  assert.equal(allow('preference', 'I like tabs in this project'), false);
});

test('[G3] 看最近 3 条非插话用户消息,不只最后一条;插话 / 后台唤醒不算', () => {
  const recent = need('memoryRecentUserTexts'), allow = need('memoryGlobalScopeAllowed');
  const session = { messages: [
    { role: 'user', content: '以后所有项目的提交信息都用中文' },
    { role: 'assistant', content: '好的' },
    { role: 'user', content: '顺便问下端口', steered: true },
    { role: 'user', content: '后台代理完成了', meta: { origin: 'agent_wake' } },
    { role: 'user', content: '再看看这个报错' },
    { role: 'assistant', content: '…' },
    { role: 'user', content: '好,那就记下来吧' },
  ] };
  const texts = recent(session, 3);
  assert.deepEqual(texts, ['好,那就记下来吧', '再看看这个报错', '以后所有项目的提交信息都用中文'], '新→旧,跳过插话与唤醒');
  assert.equal(allow('convention', texts), true, '上一轮说了「所有项目」,这一轮只回「记下来」(修前只看最后一条 → 降级)');
  assert.equal(allow('convention', texts.slice(0, 1)), false, '只有最后一条时没有信号');
  assert.deepEqual(recent(session, 1), ['好,那就记下来吧']);
  assert.deepEqual(recent({ messages: [] }, 3), []);
});

// 第三波复核:「全局」「global」在编码讨论里是常用术语(全局变量 / global state / 全局搜索替换),不是在说「这条记忆全局生效」。
test('[G4] 编程语义的「全局变量 / global variables / 全局搜索」不放行 global;同一句里另有跨项目说法照旧放行', () => {
  const allow = need('memoryGlobalScopeAllowed');
  for (const text of ['这个模块里不要用全局变量,用依赖注入', 'avoid global variables in this repo, pass config explicitly', '踩坑:全局搜索替换会把测试夹具也改掉',
    'use global search to find the callers', '别在这里读全局状态', 'global state makes the tests flaky', 'the global namespace is polluted', '全局对象不要挂东西',
    'Python 里的 global 语句要慎用', 'the global keyword makes this function impure']) {
    assert.equal(allow('convention', text), false, `编程用语不该放行:${text}`);
    assert.equal(allow('lesson', text), false, `编程用语不该放行(lesson):${text}`);
  }
  // 同一条消息里既有编程用语、又明说跨项目 → 放行(以说「所有项目」为准)
  assert.equal(allow('convention', '不要用全局变量;这条对所有项目都适用'), true);
  assert.equal(allow('convention', 'avoid global variables, in every project'), true);
  // 剥掉编程用语之后剩下的「全局」仍算(全局偏好 / 全局生效 / globally)
  assert.equal(allow('convention', '不要用全局变量,这条设成全局偏好'), true);
  assert.equal(allow('convention', 'no global variables, apply this globally'), true);
  // 编程用语不影响 preference 的第二条路(个人口味)
  assert.equal(allow('preference', '我喜欢不用全局变量的写法'), true);
  // 候选的 scope 不被编程用语抬成 global(模型要 global、用户只说了「全局变量」→ 降成 project 并如实记下)
  const norm = need('normalizeMemoryProposalCandidate');
  const r = norm({ name: '禁用全局变量', description: '写本模块时适用', type: 'convention', scope: 'global', body: '不要使用全局变量,依赖通过参数注入。', reason: '用户明确要求' }, ['这个模块里不要用全局变量,用依赖注入']);
  assert.deepEqual([r.proposal.scope, r.proposal.requestedScope, r.proposal.scopeAdjusted], ['project', 'global', true]);
});

// 第三波复核:自动审稿路径修前要求 durablePreference(以后 / 默认 / 一律…),用户明说「记住:所有项目…」(explicit)却降成 project,与工具路径不一致。
test('[G5] memoryAutoGlobalAllowed:durablePreference 或 explicit(记住 / remember this)+ 用户说了跨项目 → 放行;两者皆无 → 不放行', () => {
  const auto = need('memoryAutoGlobalAllowed'), pre = need('memoryProposalPrefilter');
  const gateOf = text => pre({ turnSeq: 1, messages: [{ role: 'user', content: text, turnSeq: 1 }, { role: 'assistant', content: '好的,我已经记下了这条要求,之后提交信息都会按你说的写,并在每个项目里照做。'.repeat(3), turnSeq: 1 }] });
  const g1 = gateOf('记住:所有项目的提交信息都用中文');
  assert.deepEqual([g1.explicit, g1.durablePreference], [true, false], '前置:这句话是 explicit、不是 durablePreference');
  assert.equal(auto(g1, 'preference', [g1.userText]), true, '修前:durablePreference 为假 → 降成 project');
  const g2 = gateOf('Remember this: use Chinese commit messages in every project');
  assert.equal(auto(g2, 'preference', [g2.userText]), true);
  const g3 = gateOf('以后所有项目的提交信息都用中文');
  assert.equal(g3.durablePreference, true);
  assert.equal(auto(g3, 'preference', [g3.userText]), true, '原有放行路径不退化');
  const g4 = gateOf('记住:提交信息用中文写');
  assert.equal(auto(g4, 'convention', [g4.userText]), false, 'explicit 但用户没说跨项目 → 仍降成 project');
  assert.equal(auto({ explicit: false, durablePreference: false }, 'convention', ['所有项目都这样']), false, '既不是 explicit 也不是 durablePreference → 不放行');
});

// ───────────── [N] requestedScope / scopeAdjusted ─────────────
const rawCand = (extra = {}) => ({ name: '提交信息用中文', description: '写提交信息时适用', type: 'convention', scope: 'global', body: '提交信息一律用中文写清楚改了什么。', reason: '用户明确要求', ...extra });

test('[N1] 模型要 global、用户没说跨项目 → 降成 project,但 requestedScope/scopeAdjusted 写进 proposal(修前只回给模型)', () => {
  const norm = need('normalizeMemoryProposalCandidate');
  const r = norm(rawCand(), ['记住:提交信息用中文写']);
  assert.equal(r.ok, true);
  assert.equal(r.proposal.scope, 'project');
  assert.equal(r.proposal.requestedScope, 'global');
  assert.equal(r.proposal.scopeAdjusted, true);
  assert.equal(r.scopeAdjusted, true, '返回值上的旧字段仍在');
});

test('[N2] 用户说了「全局」→ 保持 global、没被改;模型要 project → requestedScope=project、scopeAdjusted=false', () => {
  const norm = need('normalizeMemoryProposalCandidate');
  const g = norm(rawCand(), ['这是全局偏好,所有会话都适用']);
  assert.deepEqual([g.proposal.scope, g.proposal.requestedScope, g.proposal.scopeAdjusted], ['global', 'global', false]);
  const p = norm(rawCand({ scope: 'project' }), ['随便']);
  assert.deepEqual([p.proposal.scope, p.proposal.requestedScope, p.proposal.scopeAdjusted], ['project', 'project', false]);
  const s = norm(rawCand({ scope: 'global' }), '以后所有项目');                      // 旧调用形态:userText 是字符串
  assert.equal(s.proposal.scope, 'global');
});

// ───────────── [D] 重复判定:可提升 ─────────────
test('[D1] project 里已有同一条、模型想提 global → duplicate + promotable,错误点名 revise 的 newScope;同 scope 照旧', () => {
  const find = need('findMemoryProposalDuplicate'), failure = need('memoryProposalDuplicateFailure');
  const registry = [{ id: 'mem_a1', scope: 'project', name: '提交信息用中文', description: '写提交信息时适用' }];
  const globalProposal = { name: '提交信息用中文', description: '写提交信息时适用', body: 'x', scope: 'global' };
  const dup = find(globalProposal, registry, { history: [] });
  assert.ok(dup && dup.existing && dup.existing.id === 'mem_a1');
  const f = failure(dup, globalProposal);
  assert.equal(f.duplicate, true);
  assert.equal(f.promotable, true);
  assert.equal(f.existingScope, 'project');
  assert.match(f.error, /newScope:"global"/);
  assert.match(f.error, /workbench_memory_revise/);
  const same = failure(find({ ...globalProposal, scope: 'project' }, registry, { history: [] }), { ...globalProposal, scope: 'project' });
  assert.equal(same.promotable, undefined, '同 scope 是普通重复');
  assert.match(same.error, /same or very similar memory already exists/);
  const globalExisting = failure({ existing: { id: 'g1', scope: 'global', name: 'n' } }, { ...globalProposal, scope: 'project' });
  assert.equal(globalExisting.promotable, undefined, '已有的是全局 = 已经覆盖本项目,不是「可提升」');
});

// ───────────── [C] coreSummary 跟随 description ─────────────
test('[C1] 摘要从没单独写过:description 变了,coreSummary 跟着变(修前一直停在旧文字)', async () => {
  const save = need('saveMemory');
  const created = await save({ id: 'cs1', scope: 'global', type: 'preference', name: '回复语言', description: 'OLD 用中文回复', body: '正文', core: true }, '');
  assert.equal(created.ok, true);
  assert.equal(fmOf('global', 'cs1').coresummary, 'OLD 用中文回复');
  const revised = await save({ id: 'cs1', scope: 'global', type: 'preference', name: '回复语言', description: 'NEW 用简洁中文回复', body: '正文' }, '');   // 没带 coreSummary(revise apply 的形状)
  assert.equal(revised.ok, true);
  assert.equal(fmOf('global', 'cs1').coresummary, 'NEW 用简洁中文回复');
  assert.equal(revised.memory.coreSummary, 'NEW 用简洁中文回复');
});

test('[C2] 用户自己写过的摘要(与旧 description 不同)一字不碰', async () => {
  const save = need('saveMemory');
  await save({ id: 'cs2', scope: 'global', type: 'preference', name: 'n', description: 'D1', body: 'b', coreSummary: '自定义摘要', core: true }, '');
  await save({ id: 'cs2', scope: 'global', type: 'preference', name: 'n', description: 'D2 改了', body: 'b' }, '');
  assert.equal(fmOf('global', 'cs2').coresummary, '自定义摘要');
  await save({ id: 'cs2', scope: 'global', type: 'preference', name: 'n', description: 'D3 又改了', body: 'b', coreSummary: '自定义摘要' }, '');   // 编辑弹窗把旧摘要原样送回
  assert.equal(fmOf('global', 'cs2').coresummary, '自定义摘要');
});

test('[C3] 编辑弹窗形状:预填的旧摘要原样送回(等于旧 description)也算没动 → 跟随新 description;用户改了摘要则以用户为准', async () => {
  const save = need('saveMemory');
  await save({ id: 'cs3', scope: 'project', type: 'convention', name: 'n', description: 'ALPHA', body: 'b', core: true }, PROJ);
  await save({ id: 'cs3', scope: 'project', type: 'convention', name: 'n', description: 'BETA', body: 'b', coreSummary: 'ALPHA' }, PROJ);
  assert.equal(fmOf('project', 'cs3').coresummary, 'BETA');
  await save({ id: 'cs3', scope: 'project', type: 'convention', name: 'n', description: 'GAMMA', body: 'b', coreSummary: '我手写的摘要' }, PROJ);
  assert.equal(fmOf('project', 'cs3').coresummary, '我手写的摘要');
});

test('[C4] 旧文件根本没有 coreSummary 行:改 description 后摘要 = 新 description;并且核心胶囊注入的是新的', async () => {
  const gdir = path.join(root, 'memory', 'global');
  fs.mkdirSync(gdir, { recursive: true });
  fs.writeFileSync(path.join(gdir, 'cs4.md'), '---\nname: 旧文件\ndescription: OLDDESC\ntype: preference\ncreatedAt: 2026-01-01T00:00:00.000Z\ncore: true\n---\n\n正文\n');
  await need('saveMemory')({ id: 'cs4', scope: 'global', type: 'preference', name: '旧文件', description: 'NEWDESC', body: '正文' }, '');
  assert.equal(fmOf('global', 'cs4').coresummary, 'NEWDESC');
  const registry = await need('loadMemoryRegistry')(PROJ);
  const state = await need('resolveCoreMemoryState')(PROJ, registry, null);
  const section = need('buildCoreMemoryPromptSection')(state.active, null);
  assert.match(section, /NEWDESC/);
  assert.doesNotMatch(section, /OLDDESC/, '核心胶囊每轮注入的是摘要:不能还是旧文字');
});

// ───────────── [R] 来源字段 ─────────────
test('[R1] readMemoryItem 回传 sourceSessionId/sourceRunId;读原条目再 saveMemory(元数据快捷操作)不抹来源', async () => {
  const save = need('saveMemory'), read = need('readMemoryItem');
  await save({ id: 'src1', scope: 'project', type: 'lesson', name: 'n', description: 'd', body: 'b', sourceSessionId: 'sess-abc', sourceRunId: 'run-xyz' }, PROJ);
  const item = await read('src1', 'project', PROJ);
  assert.equal(item.ok, true);
  assert.equal(item.memory.sourceSessionId, 'sess-abc');
  assert.equal(item.memory.sourceRunId, 'run-xyz');
  const toggled = await save({ ...item.memory, core: true }, PROJ);        // 与 /api/memory/metadata 同一形状:{...item.memory} + 补丁
  assert.equal(toggled.ok, true);
  const fm = fmOf('project', 'src1');
  assert.equal(fm.core, 'true');
  assert.equal(fm.sourcesessionid, 'sess-abc', '修前:readMemoryItem 不带来源 → 切核心后 sourceSessionId 消失');
  assert.equal(fm.sourcerunid, 'run-xyz');
});

// ───────────── [M] 换作用域 ─────────────
test('[M1] 项目 → 全局:写新删旧,createdAt 沿用,用量旁账随迁,同 id 在两处不并存', async () => {
  const save = need('saveMemory'), move = need('moveMemoryScope'), read = need('readMemoryItem');
  await save({ id: 'mv1', scope: 'project', type: 'convention', name: '提交规范', description: '写提交信息时', body: '用中文', core: true, importance: 'important' }, PROJ);
  const before = await read('mv1', 'project', PROJ);
  await new Promise(r => setTimeout(r, 15));
  await need('touchMemoryUsage')([{ id: 'mv1', scope: 'project' }], PROJ, 'relevant');
  const r = await move({ id: 'mv1', scope: 'global', name: '提交规范', description: '写提交信息时', type: 'convention', body: '用中文', core: true, importance: 'important', coreSummary: '写提交信息时' }, 'project', PROJ);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.moved.from, r.moved.to, r.moved.usageMoved], ['project', 'global', true]);
  assert.equal(fs.existsSync(memFile('project', 'mv1')), false, '旧的删了');
  assert.equal(fs.existsSync(memFile('global', 'mv1')), true, '新的在全局');
  const after = await read('mv1', 'global', PROJ);
  assert.equal(after.memory.createdAt, before.memory.createdAt, 'createdAt 沿用(记忆列表按它排序)');
  assert.equal(after.memory.core, true);
  assert.equal(after.memory.importance, 'important');
  const usage = (await need('readMemoryUsageState')()).entries;
  assert.ok(usage['global:mv1'] && usage['global:mv1'].useCount >= 1, `用量换键:${JSON.stringify(Object.keys(usage))}`);
  assert.equal(usage['project:' + path.basename(path.dirname(memFile('project', 'mv1'))) + ':mv1'], undefined);
});

test('[M2] 关系边不能跨作用域:涉及它的边从原作用域摘掉并如实计数;无关的边保留', async () => {
  const save = need('saveMemory'), move = need('moveMemoryScope');
  for (const id of ['rel-a', 'rel-b', 'rel-c']) await save({ id, scope: 'project', type: 'reference', name: id, description: id + ' d', body: id }, PROJ);
  await need('writeMemoryRelations')('project', PROJ, [
    { id: 'edge1', type: 'supports', from: 'rel-a', to: 'rel-b', scope: 'project', confirmed: true },
    { id: 'edge2', type: 'contradicts', from: 'rel-c', to: 'rel-a', scope: 'project', confirmed: false },
    { id: 'edge3', type: 'supports', from: 'rel-b', to: 'rel-c', scope: 'project', confirmed: true },
  ]);
  const r = await move({ id: 'rel-a', scope: 'global', name: 'rel-a', description: 'rel-a d', type: 'reference', body: 'rel-a' }, 'project', PROJ);
  assert.equal(r.ok, true);
  assert.equal(r.moved.relationsDropped, 2);
  const left = await need('readMemoryRelations')('project', PROJ);
  assert.deepEqual(left.map(e => e.id), ['edge3']);
});

test('[M3] 全局 → 项目(下放);目标作用域已有同 id → 拒绝(conflict + 稳定码),两边都不动', async () => {
  const save = need('saveMemory'), move = need('moveMemoryScope');
  await save({ id: 'dn1', scope: 'global', type: 'preference', name: 'g', description: 'gd', body: 'gb' }, '');
  const demoted = await move({ id: 'dn1', scope: 'project', name: 'g', description: 'gd', type: 'preference', body: 'gb' }, 'global', PROJ);
  assert.equal(demoted.ok, true);
  assert.equal(fs.existsSync(memFile('global', 'dn1')), false);
  assert.equal(fs.existsSync(memFile('project', 'dn1')), true);
  await save({ id: 'dn2', scope: 'global', type: 'preference', name: 'g2', description: 'gd2', body: 'gb2' }, '');
  await save({ id: 'dn2', scope: 'project', type: 'preference', name: 'p2', description: 'pd2', body: 'pb2' }, PROJ);
  const conflict = await move({ id: 'dn2', scope: 'project', name: 'g2', description: 'gd2', type: 'preference', body: 'gb2' }, 'global', PROJ);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.conflict, true);
  assert.equal(conflict.errorCode, 'memory.move_conflict');
  assert.equal(fs.existsSync(memFile('global', 'dn2')), true);
  assert.match(fs.readFileSync(memFile('project', 'dn2'), 'utf8'), /pb2/, '目标里原有的那条没被覆盖');
  const same = await move({ id: 'dn2', scope: 'global', name: 'x', description: 'x', type: 'preference', body: 'x' }, 'global', PROJ);
  assert.equal(same.ok, false, '原/目标同一作用域无需移动');
});

// ───────────── [P] 迁移导入敏感扫描 ─────────────
const SRC = { key: 'claude-md', label: 'Claude Code' };
const readOf = text => ({ file: path.join(process.env.HOME, '.claude', 'CLAUDE.md'), text, hash: 'h' });

test('[P1] 指令文件里命中敏感扫描的块不导入;剔了几块如实计数(修前整份原样进核心记忆,每轮发给服务商)', () => {
  const plan = need('planAgentInstructionEntries');
  const text = ['# 规矩', '回复用中文,提交信息写清楚。', '', '# 部署', '数据库 password: hunter2xyz999', '', '# 其它', '改代码前先读文件。'].join('\n');
  const entries = plan(SRC, readOf(text), '~/.claude/CLAUDE.md');
  const all = entries.map(e => e.body + '\n' + e.coreSummary + '\n' + e.description).join('\n');
  assert.doesNotMatch(all, /hunter2xyz999/);
  assert.match(all, /回复用中文/, '干净的块照常导入');
  assert.match(all, /改代码前先读文件/);
  assert.equal(entries.skippedSensitive, 1);
});

test('[P2] 横跨硬切接缝的「key=value」(切开后任何一块单看都不命中)也挡住:按整段落查,不按切开后的块查', () => {
  const plan = need('planAgentInstructionEntries');
  const para = 'n'.repeat(470) + ' password=' + 'S3cretValue99' + ' 后面还有一些普通文字'.repeat(8);   // 无空行的长段:会被按 480 字硬切,「password=」恰在切口前
  const entries = plan(SRC, readOf('# 笔记\n' + para), '~/.claude/CLAUDE.md');
  assert.doesNotMatch(entries.map(e => e.body).join('\n'), /S3cretValue99/);
  assert.ok(entries.skippedSensitive >= 1);
  const mixed = plan(SRC, readOf('# 笔记\n' + '干净的第一段。\n\n' + para + '\n\n干净的第三段。'), '~/.claude/CLAUDE.md');
  const body = mixed.map(e => e.body).join('\n');
  assert.doesNotMatch(body, /S3cretValue99/);
  assert.match(body, /干净的第一段/);
  assert.match(body, /干净的第三段/, '同一节里别的段落照常导入(只剔命中的那一段)');
  const clean = plan(SRC, readOf('# 笔记\n' + 'n'.repeat(700)), '~/.claude/CLAUDE.md');
  assert.equal(clean.skippedSensitive, 0, '没有敏感内容时不多剔');
});

test('[P3] sync:首次自动导入 → 条目文件里没有秘密、行上 sensitiveSkipped、记录带 scanVersion', async () => {
  const sync = need('syncAgentInstructionImports');
  const file = path.join(process.env.HOME, '.claude', 'CLAUDE.md');
  fs.writeFileSync(file, ['# 规矩', '回复用中文。', '', '# 密码', 'api_key=sk-live-abcdef1234567890', '', '# 收尾', '改完跑测试。'].join('\n'));
  const r = await sync({ auto: true });
  const row = r.sources.find(s => s.key === 'claude-md');
  assert.equal(row.status, 'imported');
  assert.equal(row.sensitiveSkipped, 1);
  const files = fs.readdirSync(path.join(root, 'memory', 'global')).filter(f => f.startsWith('agentmd-claude-md-'));
  assert.ok(files.length >= 1);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(root, 'memory', 'global', f), 'utf8'), /sk-live-abcdef/);
  const sidecar = JSON.parse(fs.readFileSync(I.agentInstructionImportFile(), 'utf8'));
  assert.equal(sidecar.sources['claude-md'].scanVersion, 1);
  assert.equal(sidecar.sources['claude-md'].skippedSensitive, 1);
  const again = await sync({ auto: true });
  assert.equal(again.sources.find(s => s.key === 'claude-md').sensitiveSkipped, 1, '再扫一遍行上仍如实标出');
});

test('[P4] 扫描上线之前导入的旧记录(无 scanVersion、条目里已含秘密、没被用户改过)→ 自动补扫重导,秘密清掉', async () => {
  const sync = need('syncAgentInstructionImports');
  const file = path.join(process.env.HOME, '.claude', 'CLAUDE.md');
  fs.rmSync(path.join(root, 'memory', 'global'), { recursive: true, force: true });
  fs.rmSync(I.agentInstructionImportFile(), { force: true });
  const text = ['# 规矩', '回复用中文。', '', '# 密码', 'password: LegacySecret99', '', '# 收尾', '改完跑测试。'].join('\n');
  fs.writeFileSync(file, text);
  // 手工还原「修前导入器」落下的东西:不过滤的分块 + 不带 scanVersion 的 sidecar。
  const src = I.agentInstructionSources().find(s => s.key === 'claude-md');
  const read = await I.readAgentInstructionSource(src);
  const chunks = I.splitAgentInstructionText(read.text);
  fs.mkdirSync(path.join(root, 'memory', 'global'), { recursive: true });
  const importedAt = new Date().toISOString();
  const entries = chunks.map((c, i) => {
    const entry = { id: I.agentInstructionMemoryId('claude-md', i + 1), core: true, part: `${i + 1}/${chunks.length}`, name: 'Claude Code 全局指令 · ' + (c.heading || i), description: 'd', coreSummary: c.flat, body: c.body };
    const content = I.renderAgentInstructionMemory(entry, src, read, importedAt);
    fs.writeFileSync(path.join(root, 'memory', 'global', entry.id + '.md'), content);
    return { id: entry.id, hash: I.sha256Hex(content).slice(0, 32), core: true };
  });
  fs.writeFileSync(I.agentInstructionImportFile(), JSON.stringify({ schema: 1, updatedAt: importedAt, sources: { 'claude-md': { key: 'claude-md', file: read.file, sourceHash: read.hash, importedAt, entries, dismissed: false } } }, null, 2));
  assert.match(fs.readdirSync(path.join(root, 'memory', 'global')).map(f => fs.readFileSync(path.join(root, 'memory', 'global', f), 'utf8')).join('\n'), /LegacySecret99/, '前置:旧条目里确有秘密');
  const r = await sync({ auto: true });
  const row = r.sources.find(s => s.key === 'claude-md');
  assert.equal(row.status, 'imported');
  assert.ok(row.sensitiveSkipped >= 1);
  const now = fs.readdirSync(path.join(root, 'memory', 'global')).map(f => fs.readFileSync(path.join(root, 'memory', 'global', f), 'utf8')).join('\n');
  assert.doesNotMatch(now, /LegacySecret99/, '补扫重导之后秘密不在了');
  assert.match(now, /回复用中文/);
});

// ───────────── [K] 起草上下文 ─────────────
test('[K1] 起草上下文超长时留最新的(修前 slice(0,4000) 留的是最旧的,最近一轮被截没了)', () => {
  const clip = need('clipRecentMemoryDraftContext');
  const lines = Array.from({ length: 8 }, (_, i) => `${i % 2 ? 'AI' : '用户'}: TURN${i} ` + '字'.repeat(700));
  const recent = lines.join('\n');
  assert.ok(recent.length > 4000);
  const out = clip(recent, 4000);
  assert.ok(out.length <= 4000);
  assert.match(out, /TURN7/, '最新一条在');
  assert.doesNotMatch(out, /TURN0/, '最旧的被舍弃');
  assert.match(out, /^(用户|AI): TURN\d/, '开头不是被切断的半行');
  assert.equal(clip('short', 4000), 'short');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
