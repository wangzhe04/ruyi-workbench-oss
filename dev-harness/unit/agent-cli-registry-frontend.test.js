'use strict';
// ENGINEERING-SPEC §11.1 末行:前端对「哪一个 Agent CLI」的知识收进一张登记表 public/js/agent-cli-registry.js。
// 修前六个 public/js 文件里约 32 处按 `agentCliType === 'kimi'` / 两份 AGENT_CLI_LABELS 分叉;现在调用点只问登记表,
// 加第三个 CLI = 在表里加一行。
//
// 判据:
//   [K] 登记表的键集合与服务端 01 AGENT_CLI_TYPES 的键集合逐项相同(顺序也同);两边共有的事实(品牌名、路径键、
//       探测路径键)逐字相同 —— 服务端状态接口里的 detected* 键、config 的 *Path 键就是前端读的那几个。
//   [F] 每一行字段齐全、类型对、id 等于键、整张表与每一行都冻结;派生量(AGENT_CLI_IDS、思考强度并集)与表一致。
//   [H] 小工具的归一化口径:不认识的值(缺省、旧数据、非字符串、原型链上的名字)一律归到缺省 CLI。
//   [G] 结构锁:除登记表本身,public/app.js 与 public/js/*.js 里不再有把 agentCliType 与字面量比较的代码,
//       不再有第二份 AGENT_CLI_LABELS 表,也不再和非引擎族的 CLI id 字面量(如 'kimi')做相等比较。
//       'claude' 例外:它同时是历史「引擎族」取值(engine === 'claude' 表示 Agent CLI 族 vs 'openai' 族),那类比较不是按 CLI 分叉。
// 真源码、临时 HOME、零网络。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-registry-fe-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const { AGENT_CLI_TYPES } = require(path.join(app, 'server.js'));
const PUBLIC = path.join(app, 'public');
const REGISTRY_FILE = path.join(PUBLIC, 'js', 'agent-cli-registry.js');
const loadRegistry = () => import(pathToFileURL(REGISTRY_FILE).href);

// 每一行必须带齐的字段与类型('array' = 冻结的字符串数组;'array|null' = 同上或 null)。
const FIELDS = {
  id: 'string',
  label: 'string',
  avatarLetter: 'string',
  eventTag: 'string',
  pathKey: 'string',
  detectedKey: 'string',
  thinkingEfforts: 'array',
  settingsThinkingEfforts: 'array|null',
  compactDefaultLabelKey: 'string',
  nativeCompact: 'string',
  statusEndpoint: 'string',
  alwaysInteractive: 'boolean',
  legacyUsageSources: 'array',
};
// 引擎族取值(不是 CLI 分叉):'claude' = Agent CLI 族的历史名,'openai' = 服务商族。
const ENGINE_FAMILY_IDS = new Set(['claude', 'openai']);

function assertStringArray(value, where) {
  assert.ok(Array.isArray(value), `${where} is an array`);
  assert.ok(Object.isFrozen(value), `${where} is frozen`);
  for (const item of value) assert.equal(typeof item, 'string', `${where} holds strings`);
  assert.equal(new Set(value).size, value.length, `${where} has no duplicates`);
}

test('[K] registry ids and shared facts match the server AGENT_CLI_TYPES', async () => {
  const registry = await loadRegistry();
  assert.ok(AGENT_CLI_TYPES && typeof AGENT_CLI_TYPES === 'object', 'server exports AGENT_CLI_TYPES');
  assert.deepEqual(Object.keys(registry.AGENT_CLI_REGISTRY), Object.keys(AGENT_CLI_TYPES));
  assert.deepEqual([...registry.AGENT_CLI_IDS], Object.keys(AGENT_CLI_TYPES));
  for (const [id, server] of Object.entries(AGENT_CLI_TYPES)) {
    const row = registry.AGENT_CLI_REGISTRY[id];
    assert.equal(row.id, server.id, `${id}.id`);
    assert.equal(row.label, server.label, `${id}.label`);
    assert.equal(row.pathKey, server.pathKey, `${id}.pathKey`);
    assert.equal(row.detectedKey, server.detectedKey, `${id}.detectedKey`);
  }
  // 缺省 CLI 与服务端 selectedAgentCli 的兜底同一个。
  assert.equal(registry.AGENT_CLI_DEFAULT_ID, 'claude');
  assert.ok(registry.AGENT_CLI_IDS.includes(registry.AGENT_CLI_DEFAULT_ID));
});

test('[F] every row carries the full field set with the right types', async () => {
  const registry = await loadRegistry();
  assert.ok(Object.isFrozen(registry.AGENT_CLI_REGISTRY), 'registry frozen');
  assert.ok(Object.isFrozen(registry.AGENT_CLI_IDS), 'ids frozen');
  for (const [id, row] of Object.entries(registry.AGENT_CLI_REGISTRY)) {
    assert.ok(Object.isFrozen(row), `${id} row frozen`);
    assert.deepEqual(Object.keys(row).sort(), Object.keys(FIELDS).sort(), `${id} has exactly the registered fields`);
    for (const [field, type] of Object.entries(FIELDS)) {
      const value = row[field], where = `${id}.${field}`;
      if (type === 'array') assertStringArray(value, where);
      else if (type === 'array|null') { if (value !== null) assertStringArray(value, where); }
      else assert.equal(typeof value, type, where);
    }
    assert.equal(row.id, id, `${id}.id equals its key`);
    assert.ok(row.label && row.avatarLetter.length === 1 && row.eventTag, `${id} label/avatar/eventTag non-empty`);
    assert.ok(row.thinkingEfforts.includes(''), `${id} thinking efforts keep the default ('') option`);
    if (row.settingsThinkingEfforts) {
      assert.ok(row.settingsThinkingEfforts.includes(''), `${id} settings efforts keep the default option`);
      for (const value of row.settingsThinkingEfforts) assert.ok(registry.AGENT_CLI_THINKING_EFFORT_VALUES.includes(value), `${id} settings effort ${value} is a known value`);
    }
    assert.ok(['slash-command', 'server-api'].includes(row.nativeCompact), `${id}.nativeCompact is a known mode`);
    assert.ok(row.statusEndpoint === '' || row.statusEndpoint.startsWith('/api/'), `${id}.statusEndpoint is '' or an /api route`);
    assert.match(row.compactDefaultLabelKey, /^ctx\.compact\.default[A-Z]\w*$/, `${id}.compactDefaultLabelKey`);
  }
  // 缺省名的 i18n 键在两份 public 语言包里都有值。
  for (const lang of ['zh-CN', 'en-US']) {
    const catalog = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', lang + '.json'), 'utf8'));
    for (const row of Object.values(registry.AGENT_CLI_REGISTRY)) {
      assert.ok(typeof catalog[row.compactDefaultLabelKey] === 'string' && catalog[row.compactDefaultLabelKey].trim(), `${lang} ${row.compactDefaultLabelKey}`);
      assert.ok(typeof catalog[`settings.agentCli.hint.${row.id}`] === 'string', `${lang} settings.agentCli.hint.${row.id}`);
    }
  }
  // 思考强度并集 = 各行候选按登记顺序去重拼起来;config.claudeThinkingEffort 的校验就用它。
  const union = [...new Set(registry.AGENT_CLI_IDS.flatMap(id => registry.AGENT_CLI_REGISTRY[id].thinkingEfforts))];
  assert.deepEqual([...registry.AGENT_CLI_THINKING_EFFORT_VALUES], union);
});

test('[H] helpers normalize unknown values to the default CLI', async () => {
  const { AGENT_CLI_REGISTRY, AGENT_CLI_DEFAULT_ID, AGENT_CLI_IDS, agentCliMeta, knownAgentCliMeta, normalizeAgentCliType, isAgentCliId } = await loadRegistry();
  for (const id of AGENT_CLI_IDS) {
    assert.equal(isAgentCliId(id), true);
    assert.equal(normalizeAgentCliType(id), id);
    assert.equal(agentCliMeta(id), AGENT_CLI_REGISTRY[id]);
    assert.equal(knownAgentCliMeta(id), AGENT_CLI_REGISTRY[id]);
  }
  for (const bad of [undefined, null, '', 'nope', 'toString', '__proto__', 'constructor', 5, {}, ['kimi']]) {
    assert.equal(isAgentCliId(bad), false, `isAgentCliId(${String(bad)})`);
    assert.equal(normalizeAgentCliType(bad), AGENT_CLI_DEFAULT_ID, `normalize(${String(bad)})`);
    assert.equal(agentCliMeta(bad), AGENT_CLI_REGISTRY[AGENT_CLI_DEFAULT_ID], `meta(${String(bad)})`);
    assert.equal(knownAgentCliMeta(bad), null, `known(${String(bad)})`);
  }
});

test('[G] no public/js file other than the registry branches on an agentCliType literal', async () => {
  const { AGENT_CLI_IDS } = await loadRegistry();
  const files = ['app.js', ...fs.readdirSync(path.join(PUBLIC, 'js')).filter(name => name.endsWith('.js')).map(name => 'js/' + name)]
    .filter(rel => rel !== 'js/agent-cli-registry.js');
  assert.ok(files.length > 40, 'scanned the frontend modules');
  const quote = `['"\`]`;
  const cliOnlyIds = AGENT_CLI_IDS.filter(id => !ENGINE_FAMILY_IDS.has(id)).map(id => id.replace(/[-]/g, '\\-'));
  const patterns = [
    [new RegExp(`agentCliType\\s*[!=]==?\\s*${quote}`), 'agentCliType compared to a literal'],
    [new RegExp(`${quote}[\\w-]*${quote}\\s*[!=]==?\\s*[\\w.?$]*agentCliType\\b`), 'literal compared to agentCliType'],
    [/\bAGENT_CLI_LABELS\b/, 'a second Agent CLI label table'],
  ];
  if (cliOnlyIds.length) {
    const ids = cliOnlyIds.join('|');
    patterns.push([new RegExp(`[!=]==?\\s*${quote}(?:${ids})${quote}`), 'comparison with a CLI id literal']);
    patterns.push([new RegExp(`${quote}(?:${ids})${quote}\\s*[!=]==?`), 'comparison with a CLI id literal']);
  }
  const hits = [];
  for (const rel of files) {
    const lines = fs.readFileSync(path.join(PUBLIC, ...rel.split('/')), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const [re, why] of patterns) if (re.test(line)) hits.push(`${rel}:${index + 1} ${why}: ${line.trim().slice(0, 160)}`);
    });
  }
  assert.deepEqual(hits, [], 'per-CLI knowledge belongs in js/agent-cli-registry.js');
  // 判据自检:这组正则确实认得修前的写法(防止锁对任何输入恒绿)。
  const before = [
    "return { engine: 'agent', agentCliType: raw.agentCliType === 'kimi' ? 'kimi' : 'claude', model };",
    "if (!isProviderMode() && currentEngineMeta().agentCliType !== 'kimi' && !state.config?.compactProviderId) {",
    "const AGENT_CLI_LABELS = { claude: 'Claude Code', kimi: 'Kimi Code' };",
    "const pathKey = type === 'kimi' ? 'kimiPath' : 'claudePath';",
  ];
  for (const line of before) assert.ok(patterns.some(([re]) => re.test(line)), `lock recognizes: ${line}`);
});
