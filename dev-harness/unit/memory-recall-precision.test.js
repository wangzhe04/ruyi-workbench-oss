'use strict';
// 走查「记忆 B:召回与注入」的单测。真源码、临时 HOME、零网络(经 lib/server-internals 取未导出符号,不动 14-main 的导出面)。
//   [P] #7  无关问句不应召回无关条目(负例精度):向量层开/关都一样 —— 修前向量开时 30 句无关问句里 25 句被塞进无关条目。
//   [V] #7  向量只当重排器:向量独有的候选要「余弦 ≥ 0.25 且 ≥ 0.6×向量第一名」才进;拼写漂移的真命中由词法层的编辑距离准入,召回率不退。
//   [L] #8  词法噪声:hay 不含 type;≥3 字符 ASCII 词只认整词/词首前缀;CJK 停用二元组。
//   [Z] #17 memoryRelevanceMaxV1=0 就是 0(修前 `Number(limit) || 8` 实际等于 8)。
//   [H] check 行如实:零命中的 preference/convention 默认规则补位不算「额外匹配」。
//   [S] #16 supersedes 的运行时效果:取代者在场就不重复注入旧版本、否则降权 + 标「[已被 X 取代]」;维护建议带「停用」。
//   [I] #6  provider 引擎的索引行不带路径、按 id 用 workbench_memory_read 读(Claude/Kimi 仍带路径用 Read)。
// 反向验证:RUYI_TEST_SERVER_JS 指到修前 server.js 时本件应当红(见提交说明里的实测)。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-precision-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.HOME = path.join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
fs.mkdirSync(process.env.HOME, { recursive: true });
const { loadServerInternals } = require('../lib/server-internals');
const S = loadServerInternals([
  'rankMemoriesForRecall', 'rankRelevantMemories', 'memorySearchTerms', 'resolveMemoryPreflight', 'buildMemoryPromptSection', 'buildMemoryCheckPrompt',
  'buildMemoryConflictMap', 'analyzeMemoryMaintenance', 'saveMemory', 'deleteMemory', 'proposeMemoryRelation', 'confirmMemoryRelation',
]);

let seq = 0;
const E = (scope, type, id, name, description, extra = {}) => ({
  scope, type, id, name, description, coreSummary: description, file: `/fake/${scope}/${id}.md`,
  createdAt: `2026-01-${String(10 + (seq++ % 18))}T00:00:00Z`, ...extra,
});
// 走查里那份 16 条中英混合库(8 全局 + 8 项目,全是 lesson/reference,没有 preference/convention 补位项)。
const M16 = [
  E('global', 'lesson', 'g1', 'PowerShell 写文件编码', 'PowerShell 5.1 Out-File 默认 UTF-16,写文件要加 -Encoding utf8'),
  E('global', 'lesson', 'g2', 'git push 被拒绝', 'push rejected non-fast-forward 时先 pull --rebase 再 push'),
  E('global', 'lesson', 'g3', 'Windows 路径长度限制', 'Windows 路径超过 260 字符会失败,需要启用长路径'),
  E('global', 'lesson', 'g4', '端口被占用排查', 'netstat -ano 查占用端口的 PID,再用 taskkill 结束'),
  E('global', 'reference', 'g5', '公司内部 wiki 地址', '内部 wiki 在 wiki.corp.example,API 文档在 /api 页面'),
  E('global', 'reference', 'g6', '常用镜像源', 'npm 镜像用 registry.npmmirror.com,pip 用清华源'),
  E('global', 'lesson', 'g7', 'Excel 日期序列号', 'Excel 日期序列号 45000 对应 2023 年,需要转换'),
  E('global', 'lesson', 'g8', 'Python 虚拟环境', '创建 venv 后要激活再 pip install,避免装进全局'),
  E('project', 'lesson', 'p1', 'e2e 前清构建缓存', '跑 e2e 之前必须清理 build cache,否则会读到旧产物'),
  E('project', 'reference', 'p2', '订单表字段说明', '订单表 orders 的字段含义与索引设计'),
  E('project', 'lesson', 'p3', '数据库迁移顺序', 'alembic 迁移必须按顺序执行,不能跳过'),
  E('project', 'lesson', 'p4', '前端热更新失效', 'vite 热更新失效时检查 watch 配置和文件监听数量'),
  E('project', 'reference', 'p5', '部署流程', '部署走 GitHub Actions 的 release 工作流,手动触发'),
  E('project', 'lesson', 'p6', '日志乱码', '后端日志乱码是因为 Windows 控制台代码页 936,需要 chcp 65001'),
  E('project', 'lesson', 'p7', '接口超时重试', '第三方支付接口超时要幂等重试,最多三次'),
  E('project', 'reference', 'p8', '测试账号', '测试环境账号说明见内部文档,不要在仓库里写密码'),
];
// 与上面这批记忆毫无关系的问句:任何一条召回结果都是误报。
const NEGATIVE = [
  '今天天气怎么样', '帮我写一首诗', '这段代码的时间复杂度是多少', 'explain how closures work in JavaScript', '帮我把这个函数重构一下',
  '帮我翻译这段英文', '统计一下这个表格的平均值', 'can you turn it on', 'what is going on with this one', 'explain the lesson',
  'hello', '你好', '谢谢', '继续', '讲个笑话', '推荐一本小说', 'what is the capital of France', 'how do I bake bread', 'tell me about quantum computing',
  '帮我写一封邮件给客户', '把这段话润色一下', '1+1等于几', 'summarize this paragraph for me', 'write a haiku about autumn', '北京明天会下雨吗',
  '怎么减肥', 'translate this to French', '这个问题怎么解决', '请检查一下这个文件有没有问题', 'recommend a movie for tonight',
];
const POSITIVE = [
  ['日志里出现乱码怎么办', 'p6'], ['push 失败了', 'g2'], ['订单表有多少字段', 'p2'], ['数据库迁移要注意什么', 'p3'], ['PowerShell 写文件出现乱码怎么办', 'g1'],
  ['怎么部署到生产环境', 'p5'], ['vite 热更新不生效', 'p4'], ['端口被占用了怎么办', 'g4'], ['Windows 路径太长', 'g3'], ['支付接口超时怎么重试', 'p7'], ['pip 镜像源用哪个', 'g6'], ['excel 日期变成数字了', 'g7'],
];
const ids = list => list.map(e => e.id);
const ruleFree = list => list.filter(e => e.type !== 'convention' && e.type !== 'preference');

// ───────────── [P] 负例精度 ─────────────
for (const vec of [false, true]) {
  test(`[P1] 无关问句不召回无关条目(向量层${vec ? '开' : '关'}):${NEGATIVE.length} 句里 0 句被污染`, () => {
    const polluted = [];
    for (const q of NEGATIVE) {
      const got = ruleFree(S.rankMemoriesForRecall(M16, q, 8, { runtimeMemoryVectorRecallV1: vec }));
      if (got.length) polluted.push(`${q} => ${ids(got).join(',')}`);
    }
    assert.deepEqual(polluted, [], `修前向量开时 25/30 句被污染(58 条无关项),词法也有 4 句:${polluted.join(' | ')}`);
  });

  test(`[P2] 精度修好后召回不退(向量层${vec ? '开' : '关'}):12 句相关问句的正解全进 Top-3`, () => {
    const missed = [];
    for (const [q, want] of POSITIVE) {
      const got = ids(S.rankMemoriesForRecall(M16, q, 3, { runtimeMemoryVectorRecallV1: vec }));
      if (!got.includes(want)) missed.push(`${q} 想要 ${want} 实得 ${got.join(',')}`);
    }
    assert.deepEqual(missed, []);
  });
}

// ───────────── [V] 向量只重排 / 高分才独立准入 ─────────────
test('[V1] 向量开时,无关问句的结果恰好等于词法准入的结果(向量没有「额外」放进任何条目)', () => {
  for (const q of NEGATIVE) {
    const lex = ids(S.rankMemoriesForRecall(M16, q, 8, { runtimeMemoryVectorRecallV1: false }));
    const fused = ids(S.rankMemoriesForRecall(M16, q, 8, { runtimeMemoryVectorRecallV1: true }));
    assert.deepEqual(fused, lex, q);
  }
});

test('[V2] 拼写漂移的真命中(canry→canary、powrshell→powershell)靠词法的编辑距离准入,向量开/关都召回', () => {
  const reg = [
    E('project', 'reference', 'deploy-canary', '灰度发布', '新版本先灰度 10% 流量,观察一小时再全量'),
    E('global', 'lesson', 'powershell-quoting', 'PowerShell 引号', 'PowerShell 里传多行字符串用单引号 here-string'),
    E('global', 'lesson', 'noise-a', '无关甲', '数据目录默认在用户主目录下'),
    E('global', 'lesson', 'noise-b', '无关乙', '截图按波次命名'),
  ];
  for (const vec of [false, true]) {
    const cfg = { runtimeMemoryVectorRecallV1: vec };
    assert.deepEqual(ids(S.rankMemoriesForRecall(reg, 'canry deployment', 3, cfg)), ['deploy-canary'], `canry (vec=${vec})`);
    assert.deepEqual(ids(S.rankMemoriesForRecall(reg, 'powrshell quoting rules', 3, cfg)), ['powershell-quoting'], `powrshell (vec=${vec})`);
  }
});

test('[V3] 编辑距离只对 ≥5 字符的 ASCII 词生效:cache 与 catch(距离 2)、短词、CJK 都不会被「容错」命中', () => {
  const reg = [E('global', 'lesson', 'catch-all', 'catch all errors', 'wrap the handler and catch every error')];
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'cache invalidation', 3)), [], 'cache ≠ catch');
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'cach', 3)), [], '4 字符不容错');
  assert.deepEqual(ids(S.rankRelevantMemories([E('global', 'lesson', 'x1', '日志保留', '本地日志保留三十天')], '日至保留', 3)), ['x1'], '「保留」二元组照常命中(CJK 不走编辑距离,但不受影响)');
});

// ───────────── [L] 词法噪声 ─────────────
test('[L1] hay 不含 type:"on" 不再 ⊂ "lesson","explain the lesson" 不再把所有 lesson 拉进来', () => {
  const reg = [E('global', 'lesson', 'a1', 'alpha', 'alpha notes'), E('global', 'lesson', 'a2', 'beta', 'beta notes')];
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'what is going on with this one', 3)), []);
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'explain the lesson', 3)), []);
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'alpha', 3)), ['a1'], '真命中不受影响');
});

test('[L2] ≥3 字符 ASCII 词:整词或词首前缀,不再是词中子串("api" ⊄ "rapid"、"log" ⊄ "catalog"、"fer" ⊄ "prefer")', () => {
  const reg = [
    E('global', 'reference', 'r1', 'rapid prototyping', 'rapid iteration with the product catalog and prefer small steps'),
    E('global', 'reference', 'r2', 'deployment notes', 'logs go to the shared bucket after deployment'),
  ];
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'api', 3)), [], '"api" 不在 "rapid" 里');
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'fer', 3)), [], '"fer" 在 "prefer" 的词中,不是词首');
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'deploy pipeline', 3)), ['r2'], '词首前缀 deploy → deployment 仍命中');
  assert.deepEqual(ids(S.rankRelevantMemories(reg, 'log rotation', 3)), ['r2'], '词首前缀 log → logs 仍命中');
  assert.deepEqual(ids(S.rankRelevantMemories([E('global', 'reference', 'c1', 'catalog', 'catalog of items')], 'log', 3)), [], '"log" 不在 "catalog" 里');
  // 带分隔符的复合词仍整串匹配
  assert.deepEqual(ids(S.rankRelevantMemories([E('project', 'reference', 'deploy-canary', 'x', 'y')], 'deploy-canary status', 3)), ['deploy-canary']);
});

test('[L3] CJK 停用二元组:什么/怎么/说明/文件/代码/问题 与含助词的碎片(时的/的说)不产生词项', () => {
  const terms = S.memorySearchTerms('提交代码时的说明文字怎么写,这个文件有什么问题');
  for (const w of ['代码', '说明', '怎么', '文件', '什么', '问题', '时的', '的说']) assert.ok(!terms.includes(w), `${w} 不该是词项:${terms.join(',')}`);
  assert.ok(terms.includes('提交') && terms.includes('文字'), '实义二元组保留');
  // 领域词不进停用表
  const dom = S.memorySearchTerms('部署日志编码超时');
  for (const w of ['部署', '日志', '编码', '超时']) assert.ok(dom.includes(w), `${w} 应保留`);
});

test('[L4] 走查例:「提交代码时的说明文字怎么写」不再召回「订单表字段说明」,提交规范排第一', () => {
  const reg = [
    E('global', 'preference', 'g-commit', '提交信息用中文', '写 git commit 提交信息时使用中文,不加 emoji'),
    E('project', 'reference', 'a-orders', '订单表字段说明', '订单表 orders 的字段含义与索引'),
  ];
  for (const vec of [false, true]) {
    const got = ids(S.rankMemoriesForRecall(reg, '提交代码时的说明文字怎么写', 8, { runtimeMemoryVectorRecallV1: vec }));
    assert.deepEqual(got, ['g-commit'], `vec=${vec}`);
  }
});

// ───────────── [Z] relevance = 0 ─────────────
test('[Z1] 召回条数 0 就是 0(向量开/关都一样);缺省与非数字仍回默认 8', () => {
  const many = Array.from({ length: 12 }, (_, i) => E('global', 'lesson', 'deploy-' + i, 'deploy note ' + i, 'deploy pipeline step ' + i));
  for (const vec of [false, true]) {
    const cfg = { runtimeMemoryVectorRecallV1: vec };
    assert.deepEqual(S.rankMemoriesForRecall(many, 'deploy pipeline', 0, cfg), [], `limit 0 (vec=${vec})`);
    assert.equal(S.rankMemoriesForRecall(many, 'deploy pipeline', undefined, cfg).length, 8, 'undefined → 默认 8');
    assert.equal(S.rankMemoriesForRecall(many, 'deploy pipeline', 'x', cfg).length, 8, '非数字 → 默认 8');
    assert.equal(S.rankMemoriesForRecall(many, 'deploy pipeline', 3, cfg).length, 3);
  }
  assert.deepEqual(S.rankRelevantMemories(many, 'deploy pipeline', 0), []);
});

test('[Z2] resolveMemoryPreflight:memoryRelevanceMaxV1=0 → 不补相关条目,核心胶囊不受影响', async () => {
  const cwd = path.join(root, 'proj-z'); fs.mkdirSync(cwd, { recursive: true });
  await S.saveMemory({ id: 'z-core', scope: 'project', name: '核心规则', description: '回答用中文', type: 'preference', body: 'x', core: true }, cwd);
  await S.saveMemory({ id: 'z-deploy', scope: 'project', name: 'deploy notes', description: 'deploy pipeline notes', type: 'lesson', body: 'x' }, cwd);
  const on = await S.resolveMemoryPreflight({}, cwd, 'deploy pipeline', null, { memoryRelevanceMaxV1: 8 });
  assert.deepEqual(ids(on.entries), ['z-deploy']);
  const off = await S.resolveMemoryPreflight({}, cwd, 'deploy pipeline', null, { memoryRelevanceMaxV1: 0 });
  assert.deepEqual(off.entries, [], '修前 0 被当成假值,实际取 8');
  assert.deepEqual(ids(off.coreEntries), ['z-core']);
  assert.equal(off.status.matchCount, 0);
});

// ───────────── [H] check 行如实 ─────────────
test('[H1] 零命中的 preference/convention 补位不算「额外匹配」,另报 rule-fill', async () => {
  const cwd = path.join(root, 'proj-h'); fs.mkdirSync(cwd, { recursive: true });
  await S.saveMemory({ id: 'h-rule', scope: 'project', name: '提交规范', description: '提交信息写清楚改了什么', type: 'convention', body: 'x' }, cwd);
  await S.saveMemory({ id: 'h-lesson', scope: 'project', name: 'vite 热更新失效', description: 'vite 热更新失效时检查 watch 配置', type: 'lesson', body: 'x' }, cwd);
  const none = await S.resolveMemoryPreflight({}, cwd, '今天天气怎么样', null, {});
  assert.deepEqual(ids(none.entries), ['h-rule'], '规则类照旧补位(语义不变)');
  assert.equal(none.status.matchCount, 0, '但它不是「匹配」');
  assert.equal(none.status.ruleFillCount, 1);
  const line = S.buildMemoryCheckPrompt(none.status, {});
  assert.match(line, /matches="0"/);
  assert.match(line, /rule-fill="1"/);
  assert.doesNotMatch(line, /额外匹配 1 条/);
  assert.match(line, /默认规则补位/);
  const hit = await S.resolveMemoryPreflight({}, cwd, 'vite 热更新不生效', null, {});
  assert.equal(hit.status.matchCount, 1);
  assert.equal(hit.status.ruleFillCount, 1);
  assert.equal(hit.status.projectMatches, 1, 'project-matches 也只数真命中');
  assert.match(S.buildMemoryCheckPrompt(hit.status, {}), /额外匹配 1 条.*另有 1 条偏好\/惯例是默认规则补位/);
  assert.match(S.buildMemoryCheckPrompt(hit.status, { locale: 'en-US' }), /1 additional matches.*1 more preference\/convention entries are default-rule fill-ins/);
});

// ───────────── [S] supersedes ─────────────
async function supersedeFixture(name) {
  const cwd = path.join(root, 'proj-' + name); fs.mkdirSync(cwd, { recursive: true });
  const base = { scope: 'project', type: 'lesson', body: 'x' };
  await S.saveMemory({ ...base, id: name + '-old', name: 'deploy old way', description: 'deploy by hand with scp' }, cwd);
  await S.saveMemory({ ...base, id: name + '-new', name: 'deploy new way', description: 'deploy through the release workflow' }, cwd);
  const rel = await S.proposeMemoryRelation({ type: 'supersedes', from: name + '-new', to: name + '-old', scope: 'project' }, cwd);
  assert.ok(rel.ok, JSON.stringify(rel));
  return { cwd, relId: rel.relation.id };
}

test('[S1] pending 的 supersedes 没有运行时效果;confirmed 之后:取代者在场 → 旧版本不重复注入', async () => {
  const { cwd, relId } = await supersedeFixture('s1');
  const before = await S.resolveMemoryPreflight({}, cwd, 'deploy way', null, {});
  assert.deepEqual(ids(before.entries).sort(), ['s1-new', 's1-old'], 'pending 边不改变召回');
  assert.ok((await S.confirmMemoryRelation(relId, cwd)).ok);
  const after = await S.resolveMemoryPreflight({}, cwd, 'deploy way', null, {});
  assert.deepEqual(ids(after.entries), ['s1-new'], '修前两条等价注入,无任何区别');
  assert.equal(after.status.matchCount, 1);
});

test('[S2] 取代者没进本轮 → 旧版本保留但排到最后(降权),索引行标 [已被 X 取代] 并带说明句', async () => {
  const { cwd, relId } = await supersedeFixture('s2');
  await S.confirmMemoryRelation(relId, cwd);
  await S.saveMemory({ id: 's2-other', scope: 'project', name: 'hand tools', description: 'hand tools for debugging', type: 'lesson', body: 'x' }, cwd);
  // 「scp hand」:旧版本命中两个词(排第一),取代者 s2-new 一个词都没命中 → 不在名单里
  const pf = await S.resolveMemoryPreflight({}, cwd, 'scp hand', null, {});
  assert.deepEqual(ids(pf.entries), ['s2-other', 's2-old'], '修前旧版本因命中更多排第一;现在被取代者排到末尾');
  const conflicts = await S.buildMemoryConflictMap(cwd);
  assert.ok(conflicts.supersededBy instanceof Map && conflicts.supersededBy.get('project:s2-old').has('s2-new'));
  const sec = S.buildMemoryPromptSection(pf.entries.map(e => ({ ...e, coreStatus: 'library' })), 'openai', {}, conflicts);
  assert.match(sec, /\[s2-old\]\(project\):[^\n]*\[已被 s2-new 取代\]/);
  assert.doesNotMatch(sec, /\[s2-other\]\(project\):[^\n]*已被/);
  assert.match(sec, /已有用户确认的新版本 X/);
  // 没有 supersededBy 的普通 Map(旧调用方/夹具)照旧无标记
  assert.doesNotMatch(S.buildMemoryPromptSection(pf.entries.map(e => ({ ...e, coreStatus: 'library' })), 'openai', {}, new Map()), /已被/);
});

test('[S3] 核心胶囊里被取代的条目也标 [已被 X 取代](不删,删由用户停用)', async () => {
  const cwd = path.join(root, 'proj-s3'); fs.mkdirSync(cwd, { recursive: true });
  await S.saveMemory({ id: 's3-old', scope: 'project', name: '旧规则', description: '提交信息用英文', type: 'preference', body: 'x', core: true }, cwd);
  await S.saveMemory({ id: 's3-new', scope: 'project', name: '新规则', description: '提交信息改用中文', type: 'preference', body: 'x', core: true }, cwd);
  const rel = await S.proposeMemoryRelation({ type: 'supersedes', from: 's3-new', to: 's3-old', scope: 'project' }, cwd);
  await S.confirmMemoryRelation(rel.relation.id, cwd);
  const pf = await S.resolveMemoryPreflight({}, cwd, 'hello', null, {});
  assert.deepEqual(ids(pf.coreEntries).sort(), ['s3-new', 's3-old'], '核心条目不被自动剔除');
  const conflicts = await S.buildMemoryConflictMap(cwd);
  const sec = S.buildMemoryPromptSection(pf.coreEntries, 'openai', {}, conflicts);
  assert.match(sec, /\[s3-old\]: 提交信息用英文 \[已被 s3-new 取代\]/);
  assert.doesNotMatch(sec, /\[s3-new\]: [^\n]*已被/);
});

test('[S4] 取代者被删除后,旧版本不再标「被一条不存在的记忆取代」,召回照旧', async () => {
  const { cwd, relId } = await supersedeFixture('s4');
  await S.confirmMemoryRelation(relId, cwd);
  assert.ok((await S.deleteMemory('s4-new', 'project', cwd)).ok);
  const conflicts = await S.buildMemoryConflictMap(cwd);
  assert.equal(conflicts.supersededBy.size, 0);
  const pf = await S.resolveMemoryPreflight({}, cwd, 'deploy hand', null, {});
  assert.deepEqual(ids(pf.entries), ['s4-old']);
  assert.doesNotMatch(S.buildMemoryPromptSection(pf.entries.map(e => ({ ...e, coreStatus: 'library' })), 'openai', {}, conflicts), /已被/);
});

test('[S5] 互相取代(环)时不会两条都丢', async () => {
  const cwd = path.join(root, 'proj-s5'); fs.mkdirSync(cwd, { recursive: true });
  const base = { scope: 'project', type: 'lesson', body: 'x' };
  await S.saveMemory({ ...base, id: 's5-a', name: 'ring alpha', description: 'ring shared topic alpha' }, cwd);
  await S.saveMemory({ ...base, id: 's5-b', name: 'ring beta', description: 'ring shared topic beta' }, cwd);
  for (const [from, to] of [['s5-a', 's5-b'], ['s5-b', 's5-a']]) {
    const r = await S.proposeMemoryRelation({ type: 'supersedes', from, to, scope: 'project' }, cwd);
    await S.confirmMemoryRelation(r.relation.id, cwd);
  }
  const pf = await S.resolveMemoryPreflight({}, cwd, 'ring shared topic', null, {});
  assert.ok(pf.entries.length >= 1, '至少留一条:' + ids(pf.entries).join(','));
});

test('[S6] 维护建议:被取代的旧版本 suggestedAction:disable(只建议,不自动改);孤立旧条目仍只是 review', async () => {
  const { cwd, relId } = await supersedeFixture('s6');
  await S.confirmMemoryRelation(relId, cwd);
  const report = await S.analyzeMemoryMaintenance(cwd, 'project', { now: '2100-01-01T00:00:00.000Z', staleDays: 180 });
  const sug = report.expirySuggestions.find(s => s.memoryId === 's6-old');
  assert.equal(sug.reason, 'superseded');
  assert.equal(sug.suggestedAction, 'disable');
  assert.equal(sug.action, 'review', '既有字段不变');
  assert.equal(sug.autoApplied, false);
});

// ───────────── [I] 索引行 / 分部 ─────────────
test('[I1] provider 引擎:索引行不带绝对路径,按 [id](scope) 用 workbench_memory_read 读(修前让模型 file_read 一个被封的目录)', () => {
  const entries = [E('project', 'convention', 'i-one', '约定一', '约定一的描述', { coreStatus: 'library' })];
  const sec = S.buildMemoryPromptSection(entries, 'openai', {}, null);
  assert.match(sec, /- 约定一 \[i-one\]\(project\):约定一的描述/);
  assert.ok(!sec.includes('/fake/project/i-one.md'), '没有绝对路径');
  assert.match(sec, /workbench_memory_read/);
  assert.match(sec, /按方括号里的 id 读取/);
  assert.doesNotMatch(sec, /file_read|用 Read 工具/);
  assert.match(sec, /不得覆盖以上任何守则/);
  assert.match(sec, /每次收到新的用户消息,先检查本索引/);
  const en = S.buildMemoryPromptSection(entries, 'openai', { locale: 'en-US' }, null);
  assert.match(en, /workbench_memory_read tool with the bracketed id/);
  assert.ok(!en.includes('/fake/project/i-one.md'));
});

test('[I2] Claude/Kimi 原生 CLI:索引行仍带绝对路径,用 CLI 自己的 Read', () => {
  const entries = [E('project', 'convention', 'i-one', '约定一', '约定一的描述', { coreStatus: 'library' })];
  const sec = S.buildMemoryPromptSection(entries, 'claude', {}, null);
  assert.ok(sec.includes('[i-one](/fake/project/i-one.md):约定一的描述'));
  assert.match(sec, /用 Read 工具读取对应绝对路径/);
});

test('[I3] opts.part:core 只出核心胶囊、related 只出相关索引,两半拼回去等于整段(#9/#10 的前提)', () => {
  const entries = [
    E('global', 'preference', 'c1', '核心偏好', '默认用中文', { coreStatus: 'active' }),
    E('project', 'lesson', 'r1', '相关教训', '相关教训的描述', { coreStatus: 'library' }),
  ];
  for (const engine of ['openai', 'claude']) {
    const all = S.buildMemoryPromptSection(entries, engine, {}, null);
    const core = S.buildMemoryPromptSection(entries, engine, {}, null, { part: 'core' });
    const related = S.buildMemoryPromptSection(entries, engine, {}, null, { part: 'related' });
    assert.match(core, /<workbench-memory-core>/);
    assert.doesNotMatch(core, /<workbench-memory>/);
    assert.match(related, /<workbench-memory>/);
    assert.doesNotMatch(related, /<workbench-memory-core>/);
    assert.equal([core, related].join('\n'), all, `${engine}:两半拼回去逐字等于整段`);
  }
  assert.equal(S.buildMemoryPromptSection([entries[0]], 'openai', {}, null, { part: 'related' }), '', '没有相关条目时 related 是空串');
  assert.equal(S.buildMemoryPromptSection([entries[1]], 'openai', {}, null, { part: 'core' }), '', '没有核心条目时 core 是空串');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
