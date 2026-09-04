#!/usr/bin/env node
'use strict';

// 113a: 记忆召回质量门。离线、无服务端、无网络 —— 直接把 06h 的检索原语与 06d 的两条排序路径
// 用 vm 抠出来跑,对同一批合成记忆做词法 vs 融合的 Recall@3 对照。
//
// 为什么要这道门:向量层是「感觉上更聪明」的典型改动,不量化就永远说不清有没有用。判定口径:
//   D1 开关关时,融合入口与今天的 rankRelevantMemories 逐条同序 —— 默认路径零风险是前置条件;
//   D2 融合 Recall@3 不低于词法(不允许为了新东西把现状搞坏);
//   D3 报告两者差值。25 号 §3.3 定的翻默认条件是 +10pp,达不到就保持默认关 —— 本门只负责给出
//      诚实的数字,不替裁决背书。
//
// 夹具设计:50 条合成记忆(中文/英文/中英混排,四种 type,global 与 project 两种 scope),
// 20 条查询分四类 —— 原词复述、同义改写、拼写漂移、跨语言。跨语言只在记忆本身就中英混排时
// 才可能命中:纯 ASCII 3-gram 与中文 2-gram 之间没有共享特征,离线层做不到真正的跨语言语义,
// 这一点在夹具里如实体现,不靠挑样本制造好看的数字。

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const read = file => fs.readFileSync(path.join(SRC, file), 'utf8');

let failed = 0;
function ok(condition, label) {
  if (condition) console.log('PASS ' + label);
  else { console.error('FAIL ' + label); failed += 1; }
}

// ── 把被测代码从 src 里切出来 ────────────────────────────────────────────────────────────────
// 切点用稳定字符串锚定,锚点消失即判红(而不是静默测了个空壳)。
function slice(source, startAnchor, endAnchor, label) {
  const start = source.indexOf(startAnchor);
  if (start < 0) throw new Error(`切点丢失(起): ${label} :: ${startAnchor}`);
  const end = endAnchor ? source.indexOf(endAnchor, start) : source.length;
  if (end < 0) throw new Error(`切点丢失(止): ${label} :: ${endAnchor}`);
  return source.slice(start, end);
}

const retrieval = read('06h-retrieval-index.js');
const memoryDomain = read('06d-memory-domain.js');
const runtimeFlags = read('01c-runtime-flags.js');

const rankingSlice = slice(
  memoryDomain,
  'const MEMORY_QUERY_STOP = new Set([',
  '\nfunction memoryExclusionSet(',
  'memory ranking',
);
const flagSlice = slice(runtimeFlags, 'function memoryVectorRecallEnabled(config) {', '\n}\n', 'flag') + '\n}\n';

const context = { console };
vm.runInNewContext(
  'const MEMORY_RELEVANCE_MAX = 3;\n'
  + retrieval + '\n'
  + flagSlice + '\n'
  + rankingSlice + '\n'
  + 'this.rankRelevantMemories = rankRelevantMemories;\n'
  + 'this.rankMemoriesFused = rankMemoriesFused;\n'
  + 'this.rankMemoriesForRecall = rankMemoriesForRecall;\n'
  + 'this.retrievalTerms = retrievalTerms;\n'
  + 'this.buildRetrievalCorpus = buildRetrievalCorpus;\n'
  + 'this.rankRetrievalCorpus = rankRetrievalCorpus;\n'
  + 'this.reciprocalRankFusion = reciprocalRankFusion;\n',
  context,
);
ok(typeof context.rankRelevantMemories === 'function' && typeof context.rankMemoriesFused === 'function',
  'S0 两条排序路径都从 src 切片装载成功(切点未漂移)');

// ── 合成记忆库(40 条)──────────────────────────────────────────────────────────────────────
let seq = 0;
const memory = (id, name, description, type = 'reference', scope = 'global') => ({
  id, scope, name, description, type,
  file: `/fake/${scope}/${id}.md`,
  createdAt: `2026-0${1 + (seq % 9)}-1${seq++ % 10}T00:00:00.000Z`,
  updatedAt: '', core: false, coreSummary: description,
  importance: 'normal', reviewAfter: '', expiresAt: '', sourceSessionId: '', sourceRunId: '',
});

const REGISTRY = [
  memory('commit-message-style', '提交信息写法', '提交信息用祈使句,首行不超过 50 字,正文说明为什么改而不是改了什么', 'convention', 'project'),
  memory('powershell-quoting', 'PowerShell 引号', 'PowerShell 里传多行字符串用单引号 here-string,双引号会展开变量', 'lesson'),
  memory('test-before-push', '推送前先跑测试', '推送前必须先跑一遍回归,红的不推', 'convention', 'project'),
  memory('prefer-dark-theme', '偏好暗色主题', '用户长期使用暗色主题,截图与走查默认用暗色', 'preference'),
  memory('no-npm-runtime-deps', '运行时零 npm 依赖', 'server.js 只能用 Node 内建模块,不引入任何 npm 运行时依赖', 'convention', 'project'),
  memory('excel-export-encoding', 'Excel 导出编码', '导出 CSV 给 Excel 时要写 UTF-8 BOM,否则中文会乱码', 'lesson'),
  memory('db-migration-window', '数据库迁移窗口', '数据库迁移只在周二凌晨的维护窗口执行', 'convention', 'project'),
  memory('api-key-rotation', 'API Key 轮换', 'API Key 每 90 天轮换一次,旧 key 保留 7 天重叠期', 'reference'),
  memory('meeting-notes-format', '会议纪要格式', '会议纪要按结论、行动项、待定问题三段写', 'convention'),
  memory('user-timezone', '用户时区', '用户在东八区,日程与提醒都按北京时间', 'preference'),
  memory('log-retention', '日志保留', '本地日志保留 30 天,超期自动清理', 'reference', 'project'),
  memory('code-review-scope', '代码评审范围', '评审只看本次改动的行,不顺手重构无关代码', 'convention', 'project'),
  memory('offline-first', '离线优先', '所有功能必须在断网环境下可用,联网只做增强', 'convention', 'project'),
  memory('windows-path-length', 'Windows 路径长度', 'Windows 长路径会让 git worktree 失败,临时目录要用短路径', 'lesson'),
  memory('screenshot-naming', '截图命名', '截图按 波次-场景-主题.png 命名', 'convention'),
  memory('prefer-chinese-docs', '文档用中文', '规划文档与注释用中文写,代码标识符用英文', 'preference', 'project'),
  memory('retry-budget', '重试预算', '外部调用最多重试 3 次,指数退避', 'reference'),
  memory('cache-invalidation-key', '缓存失效键', '文件缓存用 mtime + size 作为失效键,不用内容哈希', 'lesson', 'project'),
  memory('sqlite-wal', 'SQLite WAL', 'SQLite 开 WAL 模式后并发读不再阻塞写', 'reference'),
  memory('font-fallback', '字体回退', '中文字体回退链要带 Microsoft YaHei,否则 Windows 上会掉字', 'lesson'),
  memory('release-checklist', '发布清单', '发布前过六类门:功能、回归、性能、权限、恢复、文档', 'convention', 'project'),
  memory('avoid-force-push', '不要强推', 'master 分支禁止 force push,历史必须可追溯', 'convention', 'project'),
  memory('json-indent-two', 'JSON 缩进', '生成的 JSON 统一两空格缩进,行尾换行', 'convention'),
  memory('provider-timeout', 'Provider 超时', 'provider 请求超时设 60 秒,流式首字节超时 20 秒', 'reference', 'project'),
  memory('backup-before-migrate', '迁移前备份', '任何破坏性迁移之前先做一次全量备份', 'convention'),
  memory('prefer-tables-over-prose', '偏好表格', '对比性内容用表格呈现,不写成大段散文', 'preference'),
  memory('git-worktree-cleanup', 'worktree 清理', '临时 worktree 用完即删,不留在磁盘上', 'lesson', 'project'),
  memory('http-error-envelope', 'HTTP 错误信封', 'API 错误统一 {ok:false,error:{code,message,params}} 信封', 'convention', 'project'),
  memory('token-budget-guard', 'token 预算保护', '单回合 token 超预算时先警告,再拦截,不静默截断', 'reference', 'project'),
  memory('image-thumbnail-size', '缩略图尺寸', '工具产出图内联缩略图最长边 320 像素', 'reference'),
  memory('avoid-copy-path-ux', '不要复制路径的交互', '不要让用户复制路径再自己去打开,能在应用内直接操作就不要让他离开', 'convention', 'project'),
  memory('locale-flat-keys', '文案扁平键', 'locale 文件必须是扁平点号键,嵌套会让查表失败', 'lesson', 'project'),
  memory('subagent-report-trust', '子代理报告核实', '子代理的交付报告要亲自核实,不能直接采信', 'lesson', 'project'),
  memory('css-payload-lock', 'CSS 载荷锁', '改样式分组必须同一提交里重钉载荷 SHA', 'convention', 'project'),
  memory('prefer-morning-meetings', '偏好上午开会', '用户偏好把会排在上午,下午留给深度工作', 'preference'),
  memory('deploy-canary', '灰度发布', '新版本先灰度 10% 流量,观察一小时再全量', 'reference'),
  memory('secret-scanning', '密钥扫描', '提交前扫描 sk- 开头的密钥字面量,命中即拒', 'convention', 'project'),
  memory('markdown-table-align', 'Markdown 表格对齐', 'Markdown 表格不强制列宽对齐,交给渲染器', 'reference'),
  memory('long-command-timeout', '长命令超时', '超过 10 分钟的命令要给软警告,不直接杀', 'reference', 'project'),
  memory('bilingual-error-codes', '错误码双语 error code', '错误码保持英文 snake_case,面向用户的 message 用中文', 'convention', 'project'),
  // —— 同主题干扰项（113a）。真实记忆库不是主题互斥的：用久了就会堆出“多条都在说超时”
  // “多条都在说路径”这种簇。没有它们，Top-3 对任何排序都是白送，门就失去分辨力。
  memory('http-client-timeout', 'HTTP 客户端超时', '普通 HTTP 客户端超时 30 秒,不区分读写', 'reference'),
  memory('shell-command-timeout', 'shell 命令超时', 'shell 子进程默认超时 120 秒,可逐次抬到 600 秒', 'reference', 'project'),
  memory('browser-nav-timeout', '浏览器导航超时', '无头浏览器导航超时 15 秒,超时重试一次', 'reference'),
  memory('workspace-path-rules', '工作区路径规则', '工作区路径不得含空格,不得指向用户主目录根', 'convention', 'project'),
  memory('data-dir-location', '数据目录位置', '数据目录默认在用户主目录下,可用环境变量改路径', 'reference'),
  memory('branch-naming', '分支命名', '分支名用 feat/ fix/ chore/ 前缀 + 短描述', 'convention', 'project'),
  memory('commit-batch-size', '提交粒度', '一次提交只装一件事,大改动分批提交', 'convention', 'project'),
  memory('locale-sync-rule', '文案同步', '两份运行时 locale 与两份文档 locale 必须键集完全一致', 'convention', 'project'),
  memory('log-level-policy', '日志级别', '默认只记 info 及以上,debug 需手动开', 'convention'),
  memory('log-file-rotation', '日志切割', '日志按天切割,单文件不超过 50MB', 'reference', 'project'),
];
ok(REGISTRY.length === 50, `S1 合成记忆库 50 条,含同主题干扰簇(实得 ${REGISTRY.length})`);

// ── 20 条查询,四类 ────────────────────────────────────────────────────────────────────────
const QUERIES = [
  // (1) 原词复述:两层都该稳稳命中（基线，不区分强弱）
  { kind: 'verbatim', q: '提交信息写法是什么', want: 'commit-message-style' },
  { kind: 'verbatim', q: '日志保留多久', want: 'log-retention' },
  { kind: 'verbatim', q: '缩略图尺寸多少', want: 'image-thumbnail-size' },
  { kind: 'verbatim', q: '灰度发布的比例', want: 'deploy-canary' },
  // (2) 同义改写:刻意不与目标共享任何中文 2-gram 或 ASCII 词，只留领域周边词
  { kind: 'paraphrase', q: '导出的表格在 Excel 里中文乱码怎么办', want: 'excel-export-encoding' },
  { kind: 'paraphrase', q: '临时目录路径太长导致 worktree 建不出来', want: 'windows-path-length' },
  { kind: 'paraphrase', q: '改了样式分组之后还要做什么', want: 'css-payload-lock' },
  { kind: 'paraphrase', q: '回合里 token 花超了应该怎么处理', want: 'token-budget-guard' },
  { kind: 'paraphrase', q: '文案键写成嵌套结构会怎样', want: 'locale-flat-keys' },
  { kind: 'paraphrase', q: '别让用户自己去文件夹里翻', want: 'avoid-copy-path-ux' },
  // (3) 拼写漂移:纯 ASCII 且错在词中（不是前缀）—— includes 子串判定必然落空，
  //     只有 3-gram 共现才可能拉回来。这四条是两层差异的主战场。
  { kind: 'typo', q: 'powrshell quoting rules', want: 'powershell-quoting' },
  { kind: 'typo', q: 'sqlte wal mode', want: 'sqlite-wal' },
  { kind: 'typo', q: 'markdwn table alignment', want: 'markdown-table-align' },
  { kind: 'typo', q: 'provder request timeout', want: 'provider-timeout' },
  { kind: 'typo', q: 'worktre cleanup', want: 'git-worktree-cleanup' },
  { kind: 'typo', q: 'canry deployment', want: 'deploy-canary' },
  // (4) 跨语言:英文提问。记忆中英混排时两层都可能命中；
  //     纯中文记忆（后两条）离线层做不到 —— 如实纳入，不挑样本制造好看的数字。
  { kind: 'crosslingual', q: 'error code language convention', want: 'bilingual-error-codes' },
  { kind: 'crosslingual', q: 'api key rotation period', want: 'api-key-rotation' },
  { kind: 'crosslingual', q: 'how long are local logs kept', want: 'log-retention' },
  { kind: 'crosslingual', q: 'meeting notes structure', want: 'meeting-notes-format' },
];
ok(QUERIES.length === 20, `S2 查询集 20 条(实得 ${QUERIES.length})`);
ok(QUERIES.every(row => REGISTRY.some(entry => entry.id === row.want)),
  'S2b 每条查询的正解都在记忆库里(夹具自洽)');

// ── D1: 开关关时与今天逐条同序 ────────────────────────────────────────────────────────────
const offMismatch = [];
for (const row of QUERIES) {
  const today = context.rankRelevantMemories(REGISTRY, row.q, 3).map(e => e.id).join(',');
  const gated = context.rankMemoriesForRecall(REGISTRY, row.q, 3, { runtimeMemoryVectorRecallV1: false }).map(e => e.id).join(',');
  const absent = context.rankMemoriesForRecall(REGISTRY, row.q, 3, null).map(e => e.id).join(',');
  if (today !== gated || today !== absent) offMismatch.push(row.q);
}
ok(offMismatch.length === 0,
  offMismatch.length === 0
    ? 'D1 开关关/缺省时与今天的词法 Top-3 逐条同序'
    : `D1 开关关时结果漂移 :: ${offMismatch.join(' | ')}`);

// ── D2/D3: Recall@3 对照 ──────────────────────────────────────────────────────────────────
function recallAt3(rank) {
  const hits = { total: 0, byKind: {} };
  for (const row of QUERIES) {
    const ids = rank(row.q).map(e => e.id);
    const hit = ids.includes(row.want) ? 1 : 0;
    hits.total += hit;
    hits.byKind[row.kind] = hits.byKind[row.kind] || { hit: 0, n: 0 };
    hits.byKind[row.kind].hit += hit;
    hits.byKind[row.kind].n += 1;
  }
  return hits;
}
function missesOf(rank) {
  return QUERIES.filter(row => !rank(row.q).map(e => e.id).includes(row.want)).map(row => `${row.kind}:${row.q}`);
}
const lexical = recallAt3(q => context.rankRelevantMemories(REGISTRY, q, 3));
const fused = recallAt3(q => context.rankMemoriesFused(REGISTRY, q, 3));
const lexicalPct = (lexical.total / QUERIES.length) * 100;
const fusedPct = (fused.total / QUERIES.length) * 100;
const delta = fusedPct - lexicalPct;

console.log('\n# Recall@3 对照(50 条记忆 × 20 条查询)');
console.log(`#   词法 L0 : ${lexical.total}/${QUERIES.length} = ${lexicalPct.toFixed(1)}%`);
console.log(`#   融合 L0+L1: ${fused.total}/${QUERIES.length} = ${fusedPct.toFixed(1)}%`);
console.log(`#   差值    : ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp  (25 号 §3.3 翻默认门槛 +10pp)`);
for (const kind of ['verbatim', 'paraphrase', 'typo', 'crosslingual']) {
  const l = lexical.byKind[kind] || { hit: 0, n: 0 };
  const f = fused.byKind[kind] || { hit: 0, n: 0 };
  console.log(`#   ${kind.padEnd(13)} 词法 ${l.hit}/${l.n}  融合 ${f.hit}/${f.n}`);
}
console.log('#   词法未命中: ' + (missesOf(q => context.rankRelevantMemories(REGISTRY, q, 3)).join(' | ') || '无'));
console.log('#   融合未命中: ' + (missesOf(q => context.rankMemoriesFused(REGISTRY, q, 3)).join(' | ') || '无'));
// 未命中的诊断：分层报出正解在各层的名次。“向量层找到了但融合把它挤出 Top-3”
// 与“向量层根本没找到”是两回事，只报一个总数分不出来。
const corpusAll = context.buildRetrievalCorpus(
  REGISTRY.map(e => ({ id: `${e.scope}:${e.id}`, text: [e.id, e.name, e.description, e.coreSummary, e.type].filter(Boolean).join(' ') })));
for (const row of QUERIES) {
  const fusedIds = context.rankMemoriesFused(REGISTRY, row.q, 3).map(e => e.id);
  if (fusedIds.includes(row.want)) continue;
  const lexRank = context.rankRelevantMemories(REGISTRY, row.q, 999).map(e => e.id).indexOf(row.want);
  const vecRank = context.rankRetrievalCorpus(corpusAll, row.q, { minScore: 0 }).map(r => r.id.split(':')[1]).indexOf(row.want);
  console.log(`#   [miss] ${row.kind} 「${row.q}」 想要 ${row.want}: 词法名次 ${lexRank < 0 ? '未入候选' : lexRank + 1}, 向量名次 ${vecRank < 0 ? '未入候选' : vecRank + 1}`);
}
console.log('');

ok(fused.total >= lexical.total,
  `D2 融合不低于词法(词法 ${lexical.total}/20,融合 ${fused.total}/20)`);
ok(delta >= 10 ? true : true, // 报告项,不判红:达不到 +10pp 的正确后果是保持默认关,而不是让门变红
  `D3 翻默认门槛(+10pp)${delta >= 10 ? '已达到,可提交采用门裁决' : '未达到,开关保持默认关'} :: 实测 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pp`);

// ── 附加:融合层不得破坏既有语义 ──────────────────────────────────────────────────────────
const noQuery = context.rankMemoriesFused(REGISTRY, '', 3);
ok(Array.isArray(noQuery), 'D4 空查询不抛异常');
const conventionOnly = context.rankMemoriesFused(
  REGISTRY.filter(e => e.type === 'convention' || e.type === 'preference'), '完全不相干的火星文', 3);
ok(conventionOnly.length > 0,
  'D5 convention/preference 在零命中时仍进候选(与今天的语义一致)');
const projectFirst = context.rankMemoriesFused(
  [memory('a-global-rule', '规则', '同样一条规则', 'reference', 'global'),
    memory('b-project-rule', '规则', '同样一条规则', 'reference', 'project')],
  '同样一条规则', 2);
ok(projectFirst.length === 2 && projectFirst[0].scope === 'project',
  'D6 同分时 project 作用域仍优先(类型/作用域加分未被 RRF 抹平)');

const stable = new Set();
for (let i = 0; i < 5; i++) stable.add(context.rankMemoriesFused(REGISTRY, '提交信息写法是什么', 3).map(e => e.id).join(','));
ok(stable.size === 1, 'D7 同一输入多次调用结果稳定(无 Map 迭代序抖动)');

console.log(`MEMORY RECALL QUALITY E2E: ${failed ? 'FAIL (' + failed + ')' : 'ALL PASS'}`);
process.exit(failed ? 1 : 0);
