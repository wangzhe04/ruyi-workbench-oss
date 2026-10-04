'use strict';
// N8:每回合发给模型的工具 schema 的字符预算。
//   [A] 描述里不许整段重复(orchestrate_agents 的描述曾把 885 字符的一整段原样写了两遍,外加「三种调用形态」又「两种」);
//   [B] core 包(每回合常驻)只放高频工具:三个记忆维护工具(关系边提议/修订/撤销边,≈3.1K 字符)归 memory 包,
//       用户提到记忆/修订/关系时自动装载,没装时 tool_load({packs:['memory']}) 可拉;
//   [C] 预算只减不增(棘轮):闲聊回合 / 全量 / 典型改代码回合的字符数各有上限,上限随优化往下调,调高 = 又往每回合塞东西;
//   [D] 核心编辑工具的描述要带着模型学不到的行为(file_edit 需唯一命中或 replaceAll、file_write 的 content 必填、script_run 默认语言与超时)。
// 真源码 require(server.js),临时家目录,零模型请求。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-schema-budget-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const cfg = srv.defaultConfig();
const offered = srv.buildOpenAiTools(cfg, null, { skillsEnabled: true });
const full = srv.buildOpenAiTools({ ...cfg, toolLoadingMode: 'full', subagentMaxPerTurn: 4 }, null, { skillsEnabled: true });
const byName = name => full.find(t => t.function.name === name);
const loaded = msg => srv.createToolLoadingState(cfg, msg, null, offered, null, null);
const chars = tools => JSON.stringify(tools).length;

test('N8-A 任何一条工具描述里都没有整段(≥80 字符)重复', () => {
  const offenders = [];
  for (const t of full) {
    const d = t.function.description;
    const seen = new Set();
    for (let i = 0; i + 80 <= d.length; i++) {
      const w = d.slice(i, i + 80);
      if (seen.has(w)) { offenders.push(`${t.function.name}@${i}: ${w.slice(0, 40)}…`); break; }
      seen.add(w);
    }
  }
  assert.deepEqual(offenders, []);
});

test('N8-A orchestrate_agents 的描述只有一种「调用形态」讲法', () => {
  const d = byName('orchestrate_agents').function.description;
  assert.equal((d.match(/The runtime emits workflow heartbeats/g) || []).length, 1);
  assert.equal((d.match(/Reliability guidance/g) || []).length, 1);
  assert.doesNotMatch(d, /Two ways to call it/);
  assert.match(d, /workflowId/);            // 删的是重复,不是信息
  assert.match(d, /background:true/);
  assert.match(d, /Sub-agents cannot launch further sub-agents/);
});

test('N8-B 记忆维护三件套不在 core 包,在 memory 包', () => {
  const rare = ['workbench_memory_relation_propose', 'workbench_memory_revise', 'workbench_memory_relation_revoke'];
  for (const n of rare) assert.equal(srv.toolPackForName(n), 'memory', n);
  for (const n of ['workbench_memory_list', 'workbench_memory_read', 'workbench_memory_propose']) assert.equal(srv.toolPackForName(n), 'core', n);
  const chit = loaded('你好').current().map(t => t.function.name);
  for (const n of rare) assert.ok(!chit.includes(n), `${n} 不应在闲聊回合出现`);
  assert.ok(chit.includes('workbench_memory_propose'), '常用的 propose 仍常驻');
  for (const msg of ['记住我喜欢用 tabs', '帮我修订记忆里那条过时的约定', 'remember this preference', 'which memory is outdated?']) {
    const names = loaded(msg).current().map(t => t.function.name);
    for (const n of rare) assert.ok(names.includes(n), `${JSON.stringify(msg)} 应装载 ${n}`);
  }
  const st = loaded('你好');                 // 没自动装上时,模型可手动 tool_load memory 包
  const r = st.load({ packs: ['memory'] });
  assert.ok(r.ok && rare.every(n => r.loaded.includes(n)));
});

test('N8-B 系统提示里的记忆指引:provider 回合说明维护工具按需装载(full 模式不说)', () => {
  const lazy = srv.getPromptPack('zh-CN').memoryCoreGuide({ list: 'L', read: 'R', propose: 'P', relationPropose: 'RP', revise: 'RV', relationRevoke: 'RR', lazyMaintenance: true });
  const eager = srv.getPromptPack('zh-CN').memoryCoreGuide({ list: 'L', read: 'R', propose: 'P', relationPropose: 'RP', revise: 'RV', relationRevoke: 'RR' });
  assert.match(lazy, /按需装载/);
  assert.match(lazy, /tool_load/);
  assert.doesNotMatch(eager, /按需装载/);                 // Claude 引擎那条路的文字不变
  assert.ok(lazy.startsWith(eager.slice(0, 200)));
  const enLazy = srv.getPromptPack('en-US').memoryCoreGuide({ list: 'L', read: 'R', propose: 'P', relationPropose: 'RP', revise: 'RV', relationRevoke: 'RR', lazyMaintenance: true });
  assert.match(enLazy, /load on demand/);
});

test('N8-C 字符预算棘轮(只减不增)', () => {
  // opt/native-desc 集成(files-core/files-walk/exec/net 四支给原生工具加了 encoding / offset+nextOffset / includeIgnored /
  // maxFileBytes / waitMs / list / absolute 等新入参与续读/截断键,13f 描述已压到一句话 + 入参描述 ≤80 字符后的实测:
  // codeEdit 26026、offeredDefault 51032;再压就得删新入参的语义,故 codeEdit 23000→26500(仍 ≤ master 的 26526)、
  // offeredDefault 46600→51500。其余不动。
  // 工具走查 R2(meta 组 item 9):给 ~90 个缺描述的入参补了 ≤30 字符的一句话(file_list/file_search/glob/project_snapshot 的
  // root·maxFiles·maxDepth·ignoreDirs…、exec 档的 command/timeoutMs、记忆/任务/管家定时的几个入参),同时把 orchestrate_agents
  // 的描述压短约 270 字符。实测净增:改代码回合 +2038、默认 offered +2165 —— 这是【有意的、一次性的】上调:codeEdit 26500→28200、
  // offeredDefault 51500→53700;闲聊回合(core 包里没有这些工具)不涨,仍是 10500。之后照旧只减不增。
  // 2026-10 起手工具(07 PROVIDER_STARTER_TOOLS:web_search / web_fetch / powershell_run,+2277 字符 ≈ 633 token):
  // 这是【有意的、一次性的】上调 —— 闲聊 10254→12531、改代码 28153→30430(实数),预算 10500→12600、28200→30500。
  // 理由在那张表的头注:本机这三个工具开局没装、中途补装时,提供方前缀缓存整段失效(命中率 97%→3%),一次的代价远大于每发多带的这点
  // (且基本命中缓存)。默认 offered 不变(它们本来就在里面)。之后照旧只减不增。
  // 61 号文 C4:只读工具 checkpoint_list(files_write 包,402 字符:描述一句 + 两个入参)—— 这是【有意的、一次性的】上调:改代码回合
  // 30449→30851、默认 offered 53776→54178(实数),预算 30500→30900、53800→54200;闲聊回合不涨(写包不在 core)。
  // 说明与「撤销只能由用户做」的提醒放在工具结果的 note 里而不是描述里,schema 已压到只剩判别名字与入参所需的字。之后照旧只减不增。
  const BUDGET = { chitchat: 12600, codeEdit: 30900, fullAll: 46500, offeredDefault: 54200 };   // 修前:13650 / 26526 / 48573(默认 63 工具) — 实数见各断言消息
  // 同轮 files 组:file_write.lineEnding + file_edit.oldText / glob.pattern 的 minLength:1(空串修前是抛异常)+151 字符,
  // 只把 offeredDefault 再抬 100(53700→53800);描述文字没有加(说明放在工具结果的 hint / note 里)。
  const chit = chars(loaded('你好').current());
  const edit = chars(loaded('请修改 src/a.js 修复 bug').current());
  assert.ok(chit <= BUDGET.chitchat, `闲聊回合 ${chit} > ${BUDGET.chitchat}`);
  assert.ok(edit <= BUDGET.codeEdit, `改代码回合 ${edit} > ${BUDGET.codeEdit}`);
  assert.ok(chars(offered) <= BUDGET.offeredDefault, `默认 offered ${chars(offered)} > ${BUDGET.offeredDefault}`);
  assert.ok(chars(byName('orchestrate_agents')) <= 9500, `orchestrate_agents ${chars(byName('orchestrate_agents'))} > 9500(修前 10706)`);
});

test('N8-D 核心编辑工具的描述带着模型学不到的行为', () => {
  const d = n => byName(n).function.description;
  assert.match(d('file_edit'), /replaceAll/);
  assert.match(d('file_edit'), /exactly once|once/);
  assert.match(d('file_write'), /content/);
  assert.match(d('file_write'), /""|empty/);
  assert.match(d('script_run'), /powershell/i);
  assert.match(d('script_run'), /60000/);
  assert.match(d('file_list'), /truncated/);
  for (const n of ['file_write', 'file_edit', 'file_list', 'script_run']) assert.ok(d(n).length >= 60, `${n} 描述太短`);
});
