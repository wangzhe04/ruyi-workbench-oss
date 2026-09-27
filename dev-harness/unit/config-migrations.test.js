'use strict';
// 架构还债批 2 B1:normalizeConfig 的一次性 schema 迁移抽成按版本登记的表 CONFIG_MIGRATIONS(01-config.js)。
// 真源码、临时 HOME、零网络、不落盘。
//
// 判据:
//   [A] 表的形状:每条 { to: 正整数, apply: 函数 };to 严格升序(= 每个版本恰好一条、执行顺序即版本顺序);
//       最大的 to 不超过 CONFIG_SCHEMA;版本清单与本文件登记的一致(加一条迁移要有意识地改这里)。
//   [B] 源码形状:normalizeConfig 函数体里不再有 `incomingConfigSchema < 数字` 的阶梯,迁移只从
//       applyConfigMigrations 的唯一调用点进;唯一保留的比较是落盘前「旧格式读」的 < CONFIG_SCHEMA。
//   [C] 金样:一组代表性输入(空配置、各旧 schema、显式键 vs 缺省、脏值)的迁移相关输出逐项钉死。
//       金样由抽表前(origin/master)的 normalizeConfig 产出,抽表后逐字相同 —— 抽表期间另用差分脚本对比过
//       新旧两份 server.js 在八千多份输入(含 dev-harness 里收来的三百多份夹具配置)上的完整输出。
//       家目录随机器变,投影里换成 <HOME>;路径一律用盘符形,在 Windows 与 Linux 上都只走字符串清洗。
//   [D] 幂等:每个金样的落盘投影再过一遍,changed 为假、迁移不再动任何东西。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cfg-migrations-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const { normalizeConfig, CONFIG_MIGRATIONS, CONFIG_SCHEMA } = require(path.join(app, 'server.js'));

const FLAGS = ['runtimeHistoryReadDedupV1', 'runtimeSummaryPromptI18nV1', 'runtimeReseedTailUnitsV1'];
const F3 = { runtimeHistoryReadDedupV1: false, runtimeSummaryPromptI18nV1: false, runtimeReseedTailUnitsV1: false };
const CASES = {
  'null (fresh install)': null,
  'empty object': {},
  'current schema, sparse': { configSchema: 13 },
  'schema 8: legacy engine migrates': { configSchema: 8, engineMode: 'legacy' },
  'schema 8: print engine migrates': { configSchema: 8, engineMode: 'print' },
  'schema 8: explicit legacy stays': { configSchema: 8, engineMode: 'legacy', configExplicitKeysV1: ['engineMode'] },
  'schema 9: legacy stays legacy': { configSchema: 9, engineMode: 'legacy' },
  'schema 9: print alias folds to legacy': { configSchema: 9, engineMode: 'print' },
  'schema 13: bogus engine falls back': { configSchema: 13, engineMode: 'bogus' },
  'schema 9: no workspaces seeds default + recent': { configSchema: 9, defaultWorkspace: 'D:\\Work\\main', recentWorkspaces: ['D:\\Work\\r1', 'd:\\work\\MAIN', 5, '', 'D:\\Work\\r2\\'] },
  'schema 9: only unusable rows still seeds': { configSchema: 9, defaultWorkspace: '"D:\\Quoted"', workspaces: [null, 5, 'D:\\str', [], {}, { path: '  ' }] },
  'schema 9: a usable row blocks the seed': { configSchema: 9, defaultWorkspace: 'D:\\Work\\main', recentWorkspaces: ['D:\\Work\\r1'], workspaces: [{ path: 'D:\\Work\\kept', write: false, note: ' notes ' }] },
  'schema 10: empty table is not reseeded': { configSchema: 10, defaultWorkspace: 'D:\\Work\\main', recentWorkspaces: ['D:\\Work\\r1'], workspaces: [] },
  'schema 9: blank default seeds home': { configSchema: 9, defaultWorkspace: '   ' },
  'schema 11: explicit-off flags flip on': { configSchema: 11, ...F3 },
  'schema 11: string "false" is coerced then flipped': { configSchema: 11, runtimeHistoryReadDedupV1: 'false', runtimeSummaryPromptI18nV1: 'false', runtimeReseedTailUnitsV1: 'false' },
  'schema 11: flags in explicit set stay off': { configSchema: 11, ...F3, configExplicitKeysV1: ['runtimeSummaryPromptI18nV1'] },
  'schema 12: off flags stay off': { configSchema: 12, ...F3 },
  'schema 12: old default killOnDisconnect=true folds to false': { configSchema: 12, killOnDisconnect: true },
  'schema 12: explicit killOnDisconnect=true stays': { configSchema: 12, killOnDisconnect: true, configExplicitKeysV1: ['killOnDisconnect'] },
  'schema 13: killOnDisconnect=true stays': { configSchema: 13, killOnDisconnect: true },
  'schema 12: string "true" killOnDisconnect untouched': { configSchema: 12, killOnDisconnect: 'true' },
  'garbage schema counts as 0': { configSchema: 'x', engineMode: 'legacy', killOnDisconnect: true, ...F3 },
  'schema 4 full old file': { configSchema: 4, version: '1.0.0', engineMode: 'print', killOnDisconnect: true, ...F3, defaultWorkspace: 'E:\\proj', recentWorkspaces: ['E:\\proj', 'E:\\other'], unknownFutureKey: 1 },
};

const GOLDEN = {
  "null (fresh install)": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["workspaces"],"changed":true},
  "empty object": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["workspaces"],"changed":true},
  "current schema, sparse": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":[],"changed":true},
  "schema 8: legacy engine migrates": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["workspaces"],"changed":true},
  "schema 8: print engine migrates": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["workspaces"],"changed":true},
  "schema 8: explicit legacy stays": {"engineMode":"legacy","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["engineMode","workspaces"],"changed":true},
  "schema 9: legacy stays legacy": {"engineMode":"legacy","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["engineMode","workspaces"],"changed":true},
  "schema 9: print alias folds to legacy": {"engineMode":"legacy","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["engineMode","workspaces"],"changed":true},
  "schema 13: bogus engine falls back": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":[],"changed":true},
  "schema 9: no workspaces seeds default + recent": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"D:\\Work\\main","read":true,"write":true,"execute":true},{"path":"D:\\Work\\r1","read":true,"write":true,"execute":true},{"path":"D:\\Work\\r2","read":true,"write":true,"execute":true}],"defaultWorkspace":"D:\\Work\\main","explicit":["defaultWorkspace","recentWorkspaces","workspaces"],"changed":true},
  "schema 9: only unusable rows still seeds": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"D:\\Quoted","read":true,"write":true,"execute":true}],"defaultWorkspace":"D:\\Quoted","explicit":["defaultWorkspace","workspaces"],"changed":true},
  "schema 9: a usable row blocks the seed": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"D:\\Work\\kept","read":true,"write":false,"execute":true,"note":"notes"}],"defaultWorkspace":"D:\\Work\\kept","explicit":["defaultWorkspace","recentWorkspaces","workspaces"],"changed":true},
  "schema 10: empty table is not reseeded": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[],"defaultWorkspace":"D:\\Work\\main","explicit":["defaultWorkspace","recentWorkspaces"],"changed":true},
  "schema 9: blank default seeds home": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["workspaces"],"changed":true},
  "schema 11: explicit-off flags flip on": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":[],"changed":true},
  "schema 11: string \"false\" is coerced then flipped": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":[],"changed":true},
  "schema 11: flags in explicit set stay off": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,false,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":["runtimeSummaryPromptI18nV1"],"changed":true},
  "schema 12: off flags stay off": {"engineMode":"interactive","killOnDisconnect":false,"flags":[false,false,false],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":["runtimeHistoryReadDedupV1","runtimeReseedTailUnitsV1","runtimeSummaryPromptI18nV1"],"changed":true},
  "schema 12: old default killOnDisconnect=true folds to false": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":[],"changed":true},
  "schema 12: explicit killOnDisconnect=true stays": {"engineMode":"interactive","killOnDisconnect":true,"flags":[true,true,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":["killOnDisconnect"],"changed":true},
  "schema 13: killOnDisconnect=true stays": {"engineMode":"interactive","killOnDisconnect":true,"flags":[true,true,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":["killOnDisconnect"],"changed":true},
  "schema 12: string \"true\" killOnDisconnect untouched": {"engineMode":"interactive","killOnDisconnect":"true","flags":[true,true,true],"workspaces":[],"defaultWorkspace":"<HOME>","explicit":["killOnDisconnect"],"changed":true},
  "garbage schema counts as 0": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"<HOME>","read":true,"write":true,"execute":true}],"defaultWorkspace":"<HOME>","explicit":["workspaces"],"changed":true},
  "schema 4 full old file": {"engineMode":"interactive","killOnDisconnect":false,"flags":[true,true,true],"workspaces":[{"path":"E:\\proj","read":true,"write":true,"execute":true},{"path":"E:\\other","read":true,"write":true,"execute":true}],"defaultWorkspace":"E:\\proj","explicit":["defaultWorkspace","recentWorkspaces","workspaces"],"changed":true},
};

const H = os.homedir();
const homeless = v => JSON.parse(JSON.stringify(v === undefined ? null : v).split(JSON.stringify(H).slice(1, -1)).join('<HOME>'));
const project = r => homeless({
  engineMode: r.config.engineMode,
  killOnDisconnect: r.config.killOnDisconnect,
  flags: FLAGS.map(k => r.config[k]),
  workspaces: r.config.workspaces,
  defaultWorkspace: r.config.defaultWorkspace,
  explicit: r.config.configExplicitKeysV1,
  changed: r.changed,
});
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

test('[A] 迁移表按版本升序、每个版本恰好一条、不超过 CONFIG_SCHEMA', () => {
  assert.ok(Array.isArray(CONFIG_MIGRATIONS) && Object.isFrozen(CONFIG_MIGRATIONS), 'CONFIG_MIGRATIONS 应为冻结数组');
  const tos = CONFIG_MIGRATIONS.map(m => m.to);
  for (const m of CONFIG_MIGRATIONS) {
    assert.ok(Number.isInteger(m.to) && m.to > 0, `to 必须是正整数,实得 ${m.to}`);
    assert.equal(typeof m.apply, 'function', `to:${m.to} 缺 apply`);
  }
  for (let i = 1; i < tos.length; i++) assert.ok(tos[i] > tos[i - 1], `to 必须严格升序(不许重复),实得 ${tos.join(',')}`);
  assert.ok(tos[tos.length - 1] <= CONFIG_SCHEMA, `最大的 to(${tos[tos.length - 1]})不能超过 CONFIG_SCHEMA(${CONFIG_SCHEMA})`);
  assert.deepEqual(tos, [9, 10, 12, 13], '迁移版本清单变了:确认新迁移的位置与读到的键,再更新这里与金样');
});

test('[B] normalizeConfig 里不再有散落的 schema 阶梯,迁移只从一个点进', () => {
  const src = fs.readFileSync(path.join(app, 'src', '01-config.js'), 'utf8');
  const start = src.indexOf('function normalizeConfig(');
  assert.ok(start > 0, '找不到 normalizeConfig');
  const end = src.indexOf('\n}\n', start);
  const body = src.slice(start, end);
  const ladders = body.match(/incomingConfigSchema\s*<\s*\d+/g) || [];
  assert.deepEqual(ladders, [], '一次性迁移请登记进 CONFIG_MIGRATIONS,不要在函数体里写 incomingConfigSchema < N');
  assert.equal((body.match(/applyConfigMigrations\(/g) || []).length, 1, 'applyConfigMigrations 在 normalizeConfig 里应恰好调用一次');
  const all = fs.readdirSync(path.join(app, 'src')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(app, 'src', f), 'utf8')).join('\n');
  assert.equal((all.match(/(?<!function )applyConfigMigrations\(config\b/g) || []).length, 1, 'applyConfigMigrations 只有 normalizeConfig 里那一个调用点');
});

test('[C] 金样:迁移相关输出逐项钉死', () => {
  assert.deepEqual(Object.keys(GOLDEN), Object.keys(CASES), '金样与输入一一对应');
  for (const [name, raw] of Object.entries(CASES)) {
    assert.deepEqual(project(normalizeConfig(clone(raw))), GOLDEN[name], name);
  }
});

test('[D] 幂等:落盘投影再读一遍不再变', () => {
  for (const [name, raw] of Object.entries(CASES)) {
    const first = normalizeConfig(clone(raw));
    const again = normalizeConfig(clone(first.persisted));
    assert.equal(again.changed, false, `${name}: 投影再读应 changed=false`);
    assert.deepEqual(JSON.parse(JSON.stringify(again.config)), JSON.parse(JSON.stringify(first.config)), `${name}: 投影再读的内存视图应不变`);
  }
});

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录 */ } });
