'use strict';
// 架构还债批 4:Agent CLI 登记表(01f AGENT_CLI_TYPES)与适配器回合外能力(05 AGENT_CLI_ADAPTERS)。
// 加第三个 agent CLI 应当只要「登记表一项 + 适配器一份」,不用满仓找 `=== 'kimi'`。本件钉三件事:
//   [R] 登记表:键集合 = 适配器表键集合;每项数据成员与钩子成员齐全、类型对;数据成员经 JSON 下发的形状与修前逐字节相同
//       (/api/status 的 agentCliDrivers 直接展开登记项);装机候选、起进程两个钩子的金样。
//   [N] 归一:normalizeAgentCliType / 会话路由 / 上次引擎路由 / 配置 / 适配器查找 / 起进程,对一张输入表
//       (两个真类型、缺失、空串、大小写错、第三家名字、原型链名字、非字符串)与修前 `=== 'kimi' ? 'kimi' : 'claude'`
//       的输出逐项相同 —— 「非 kimi 一律当 claude」这个口径现在由登记表给,输出不变。
//   [C] 适配器回合外能力:环境说明(06)的引擎分类与交互标志、原生提问、离线模型清单、原生上下文状态、原生压缩。
//   [M] MCP 清单同步收成一个入口 syncAgentCliMcpManifests:选中 Kimi 推、切走时清、Claude 不碰 Kimi 的文件、
//       requireWorkbenchMcp 时工作台 MCP 关着不推(真写临时 KIMI_CODE_HOME)。
//   [G] 迁走的调用点不再与 CLI 类型字面量比较(结构性判据,按 source-slice 切函数/路由块读逻辑全文)。
// 真源码、临时 HOME、零网络、不起 CLI。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-cli-registry-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const kimiHome = path.join(root, 'kimi-home');
process.env.KIMI_CODE_HOME = kimiHome;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const { readServerSource } = require('../src-reader');
const { functionBlock, bracedBlock } = require('../lib/source-slice');
const { AGENT_CLI_TYPES, AGENT_CLI_ADAPTERS, agentCliAdapter, normalizeAgentCliType } = srv;

// 修前各处的口径(01 sanitizeLastUsedEngineRoute / 02 normalizeSessionEngineRoute / 01 normalizeConfig / 05 agentCliAdapter)。
const legacyCliType = value => (value === 'kimi' ? 'kimi' : 'claude');
const INPUTS = ['claude', 'kimi', undefined, null, '', 'Kimi', 'KIMI', ' kimi', 'codex', 'gemini', 'openai', 'provider', 42, true, {}, []];
const PROTOTYPE_NAMES = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf'];

const DATA_KEYS = { id: 'string', label: 'string', pathKey: 'string', detectedKey: 'string', streaming: 'boolean', interactive: 'boolean', mcp: 'string' };
const HOOK_KEYS = { installCandidates: 'function', detectPath: 'function', prepareSpawn: 'function', syncMcpManifest: 'function' };

test('[R] 登记表成员齐全,键集合与适配器表相同;下发的数据形状与修前逐字节相同', () => {
  assert.ok(Object.isFrozen(AGENT_CLI_TYPES));
  assert.deepEqual(Object.keys(AGENT_CLI_TYPES), ['claude', 'kimi'], '登记顺序即设置页下拉顺序');
  assert.deepEqual(Object.keys(AGENT_CLI_ADAPTERS).sort(), Object.keys(AGENT_CLI_TYPES).sort(), '每个登记的 CLI 都有一份适配器');
  const want = [...Object.keys(DATA_KEYS), ...Object.keys(HOOK_KEYS)].sort();
  for (const [id, entry] of Object.entries(AGENT_CLI_TYPES)) {
    assert.ok(Object.isFrozen(entry), `${id} 冻结`);
    assert.equal(entry.id, id);
    assert.deepEqual(Object.keys(entry).sort(), want, `${id} 的成员 = 数据 + 钩子`);
    for (const [key, kind] of Object.entries({ ...DATA_KEYS, ...HOOK_KEYS })) {
      assert.equal(typeof entry[key], kind, `${id}.${key} 是 ${kind}`);
    }
    assert.equal(agentCliAdapter(id).id, id);
  }
  // /api/status 的 agentCliDrivers 是 `{ ...登记项, path }`:钩子是函数,JSON 里自然消失,下发形状与修前相同。
  // (所以钩子一律是函数、不用 null 表示「没有这一步」—— null 会出现在下发的 JSON 里。)
  assert.equal(JSON.stringify(Object.values(AGENT_CLI_TYPES)), JSON.stringify([
    { id: 'claude', label: 'Claude Code', pathKey: 'claudePath', detectedKey: 'detectedClaudePath', streaming: true, interactive: true, mcp: 'argument' },
    { id: 'kimi', label: 'Kimi Code', pathKey: 'kimiPath', detectedKey: 'detectedKimiPath', streaming: true, interactive: true, mcp: 'user-config' },
  ]));
});

test('[R] 装机候选与起进程钩子金样', () => {
  const join = (...parts) => parts.join('/');
  assert.deepEqual(AGENT_CLI_TYPES.claude.installCandidates({ env: {}, home: '/h', join }), [], 'Claude 有自己的启动器解析');
  assert.deepEqual(AGENT_CLI_TYPES.kimi.installCandidates({ env: { KIMI_CLI_PATH: 'X:/k/kimi.exe' }, home: '/h', join }), [
    'X:/k/kimi.exe', 'kimi.cmd', 'kimi.exe', 'kimi', '/h/AppData/Roaming/npm/kimi.cmd', '/h/.local/bin/kimi.exe', '/h/.local/bin/kimi',
  ]);
  assert.deepEqual(AGENT_CLI_TYPES.kimi.installCandidates({ env: {}, home: '', join }), ['kimi.cmd', 'kimi.exe', 'kimi'], '没有 HOME 时只剩裸命令');
  const argv = ['-p', 'x y'];
  for (const command of ['C:\\tools\\tool.exe', 'C:\\npm\\claude.cmd', 'X:\\tools\\kimi.exe', 'kimi-not-a-shim']) {
    const batch = srv.batchSafeSpawn(command, argv);
    assert.deepEqual(srv.prepareAgentCliSpawn('claude', command, argv), batch, `claude 起进程 = batchSafeSpawn(${command})`);
    for (const garbage of INPUTS.filter(v => !['claude', 'kimi'].includes(v)).concat(PROTOTYPE_NAMES)) {
      assert.deepEqual(srv.prepareAgentCliSpawn(garbage, command, argv), batch, `未登记类型 ${String(garbage)} 按 claude 起进程`);
    }
  }
  // 找不到 npm 入口时 Kimi 与 Claude 一样走 batchSafeSpawn;非数组参数按空数组。
  assert.deepEqual(srv.prepareAgentCliSpawn('kimi', 'X:\\tools\\kimi.exe', ['acp']), srv.batchSafeSpawn('X:\\tools\\kimi.exe', ['acp']));
  assert.deepEqual(srv.prepareAgentCliSpawn('kimi', 'X:\\tools\\kimi.exe', 'acp'), srv.batchSafeSpawn('X:\\tools\\kimi.exe', []));
});

test('[N] CLI 类型归一:对输入表与修前逐项相同', () => {
  for (const value of INPUTS) {
    const want = legacyCliType(value);
    const label = JSON.stringify(value) ?? String(value);
    assert.equal(normalizeAgentCliType(value), want, `normalizeAgentCliType(${label})`);
    assert.equal(agentCliAdapter(value), AGENT_CLI_ADAPTERS[want], `agentCliAdapter(${label})`);
    for (const engine of ['agent', 'claude']) {
      assert.deepEqual(srv.normalizeSessionEngineRoute({ engine, agentCliType: value, model: ' m ' }), { engine: 'agent', agentCliType: want, model: 'm' },
        `normalizeSessionEngineRoute(engine=${engine}, agentCliType=${label})`);
      const { config } = srv.normalizeConfig({ lastUsedEngineRoute: { engine, agentCliType: value, model: 'm' } });
      assert.deepEqual(config.lastUsedEngineRoute, { engine: 'agent', agentCliType: want, model: 'm' }, `lastUsedEngineRoute(engine=${engine}, agentCliType=${label})`);
    }
    assert.deepEqual(srv.sessionEngineRouteFromConfig({ agentCliType: value, model: 'm' }), { engine: 'agent', agentCliType: want, model: 'm' });
    const normalized = srv.normalizeConfig(value === undefined ? {} : { agentCliType: value });
    assert.equal(normalized.config.agentCliType, want, `normalizeConfig(agentCliType=${label})`);
  }
  // 原型链上的名字:修前 normalizeConfig / 会话路由都归 claude(`=== 'kimi'` / includes);归一器只认登记表自己的键。
  for (const value of PROTOTYPE_NAMES) {
    assert.equal(normalizeAgentCliType(value), 'claude', `normalizeAgentCliType(${value})`);
    assert.equal(agentCliAdapter(value), AGENT_CLI_ADAPTERS.claude, `agentCliAdapter(${value}) 不会拿到原型上的东西`);
    assert.equal(srv.normalizeSessionEngineRoute({ engine: 'agent', agentCliType: value }).agentCliType, 'claude');
    assert.equal(srv.normalizeConfig({ agentCliType: value }).config.agentCliType, 'claude');
  }
  // 路由形状的其余分支不受影响。
  assert.equal(srv.normalizeSessionEngineRoute(null), null);
  assert.equal(srv.normalizeSessionEngineRoute({ engine: 'weird', agentCliType: 'kimi' }), null);
  assert.deepEqual(srv.normalizeSessionEngineRoute({ engine: 'openai', providerId: 'p', agentCliType: 'kimi' }), { engine: 'openai', providerId: 'p', model: '' });
  assert.equal(srv.normalizeConfig({ lastUsedEngineRoute: { engine: 'weird' } }).config.lastUsedEngineRoute, null);
  // fallback 参数:调用方可以要一个别的兜底(例如「空 = 不认识」)。
  assert.equal(normalizeAgentCliType('codex', ''), '');
  assert.equal(normalizeAgentCliType('kimi', ''), 'kimi');
});

test('[C] 适配器回合外能力:环境说明、原生提问、模型清单、原生上下文状态与压缩', () => {
  const pack = srv.getPromptPack('zh-CN').engineBrief;
  // 环境说明(06 engineBriefFacts):登记过的 CLI 原样、provider 族归 provider、其余归 claude;交互标志只随适配器的 interactive。
  const kindOf = engine => srv.buildEngineEnvBrief({ engine, config: { engineMode: 'interactive' } }).facts;
  for (const [engine, kind] of [['claude', 'claude'], ['kimi', 'kimi'], ['provider', 'provider'], ['openai', 'provider'], [undefined, 'claude'], ['codex', 'claude'], ['toString', 'claude']]) {
    const facts = kindOf(engine);
    assert.equal(facts.engine, kind, `engineBriefFacts(${engine}).engine`);
    assert.equal(facts.interactive, kind === 'claude', `engineBriefFacts(${engine}).interactive`);
  }
  assert.equal(srv.buildEngineEnvBrief({ engine: 'claude', config: { engineMode: 'legacy' } }).facts.interactive, false);
  assert.equal(AGENT_CLI_ADAPTERS.claude.nativeAskUserQuestion, false);
  assert.equal(AGENT_CLI_ADAPTERS.kimi.nativeAskUserQuestion, true);
  for (const includeWorkbenchMcp of [true, false]) {
    const kimiText = srv.buildEngineEnvBrief({ engine: 'kimi', config: { includeWorkbenchMcp } }).text.split('\n');
    const claudeText = srv.buildEngineEnvBrief({ engine: 'claude', config: { includeWorkbenchMcp, engineMode: 'interactive' } }).text.split('\n');
    assert.ok(kimiText.includes(pack.askNative), `Kimi 原生提问落到提问卡(MCP ${includeWorkbenchMcp})`);
    assert.ok(!claudeText.includes(pack.askNative), `Claude 不说原生提问(MCP ${includeWorkbenchMcp})`);
    assert.equal(claudeText.includes(pack.mcpAsk + pack.mcpAskNoNative), includeWorkbenchMcp, 'Claude 交互模式走 MCP 提问且禁原生');
  }
  // 离线模型清单:Kimi 只列自己的默认项与当前选择,不混入 Claude 的 knownModels。
  assert.deepEqual(AGENT_CLI_ADAPTERS.kimi.modelCatalog.offline({ model: 'kimi-code/k3', knownModels: ['claude-x'] }),
    [{ id: '', label: '默认 (Kimi 配置)' }, { id: 'kimi-code/k3', label: 'kimi-code/k3 (当前选择)' }]);
  const claudeModels = AGENT_CLI_ADAPTERS.claude.modelCatalog.offline({ model: 'my-model', knownModels: ['known-a'] });
  assert.ok(claudeModels.some(m => m.id === 'known-a') && claudeModels.some(m => m.id === 'my-model' && m.label === 'my-model (自定义)'));
  assert.ok(!claudeModels.some(m => m.label === '默认 (Kimi 配置)'));
  for (const adapter of Object.values(AGENT_CLI_ADAPTERS)) assert.equal(typeof adapter.modelCatalog.discover, 'function');
  // 原生上下文状态与原生压缩:Claude 都没有(回合前压缩只走外部摘要;手动压缩提示用 /compact),Kimi 都有。
  assert.equal(AGENT_CLI_ADAPTERS.claude.contextStatus, null);
  assert.equal(AGENT_CLI_ADAPTERS.claude.nativeCompact, null);
  assert.equal(AGENT_CLI_ADAPTERS.kimi.nativeCompact.mode, 'kimi-native');
  const status = { ok: true, contextTokens: 1234, contextWindow: 262144, model: 'kimi-code/k3' };
  const usage = AGENT_CLI_ADAPTERS.kimi.contextStatus.usage(status);
  assert.equal(usage.contextAgentCliType, 'kimi');
  assert.equal(usage.source, 'kimi-native');
  assert.equal(usage.contextWindow, 262144);
  const session = { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] };
  assert.deepEqual(AGENT_CLI_ADAPTERS.kimi.contextStatus.apply(session, status), usage);
  assert.deepEqual(session.messages[1].usage, usage, '状态落到最后一条助手消息的用量行');
  assert.equal(session.kimiContextStatus.contextTokens, 1234);
  assert.equal(AGENT_CLI_ADAPTERS.kimi.contextStatus.apply(session, { ok: false }), null);
});

test('[M] MCP 清单同步一个入口:选中推、切走清、Claude 不碰、工作台 MCP 关着不推', async () => {
  const target = path.join(kimiHome, 'mcp.json');
  const read = () => (fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : null);
  const base = srv.normalizeConfig({ includeWorkbenchMcp: true, mcpCommandMode: 'node', desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [] }).config;
  const kimi = { ...base, agentCliType: 'kimi' };
  const claude = { ...base, agentCliType: 'claude' };
  await srv.syncAgentCliMcpManifests(claude);
  await srv.syncAgentCliMcpManifests(claude, claude);
  assert.equal(read(), null, 'Claude 选中时不写 Kimi 的 mcp.json');
  await srv.syncAgentCliMcpManifests({ ...kimi, includeWorkbenchMcp: false }, null, { requireWorkbenchMcp: true });
  assert.equal(read(), null, 'requireWorkbenchMcp:工作台 MCP 关着不推');
  fs.mkdirSync(kimiHome, { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ mcpServers: { keepMe: { command: 'keep-command' } } }));
  await srv.syncAgentCliMcpManifests(kimi, null, { requireWorkbenchMcp: true });
  assert.ok(read().mcpServers['win-claude-workbench'], '选中 Kimi 且工作台 MCP 开着:推如意的条目');
  await srv.syncAgentCliMcpManifests(kimi, claude);
  assert.ok(read().mcpServers['win-claude-workbench'], '切到 Kimi:推');
  await srv.syncAgentCliMcpManifests(kimi, kimi);
  assert.ok(read().mcpServers['win-claude-workbench'], '仍是 Kimi:不清');
  await srv.syncAgentCliMcpManifests(claude, kimi);
  assert.deepEqual(read().mcpServers, { keepMe: { command: 'keep-command' } }, '从 Kimi 切走:只清如意接管的条目,用户自己的留着');
  await srv.syncAgentCliMcpManifests(kimi);
  assert.ok(read().mcpServers['win-claude-workbench'], '启动预热:选中 Kimi 就推');
  await srv.syncAgentCliMcpManifests({ ...kimi, includeWorkbenchMcp: false }, kimi);
  assert.deepEqual(read().mcpServers, { keepMe: { command: 'keep-command' } }, '关掉工作台 MCP:选中那家按关着的配置推一次(清掉)');
});

test('[G] 迁走的调用点不再与 CLI 类型字面量比较', () => {
  const src = readServerSource();
  const code = text => text.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
  // 判据:与 'kimi' 字面量比较(kimi 只可能是 CLI 类型);agentCliType 与任何字面量比较;旧的 kind === 'claude';
  // ['claude', 'kimi'] 白名单;`? 'kimi' : 'claude'` 二选一。`engine === 'claude'` 不算 —— 那是引擎族的历史 id(CLI 族 vs provider 族)。
  const LITERAL_CLI_COMPARE = /[!=]==\s*'kimi'|'kimi'\s*[!=]==|agentCliType\s*[!=]==\s*['"`]|['"`]\s*[!=]==\s*[\w.]*agentCliType\b|\bkind\s*[!=]==\s*'claude'|\[\s*'claude'\s*,\s*'kimi'\s*\]|\?\s*'kimi'\s*:\s*'claude'/;
  const blocks = {
    sanitizeLastUsedEngineRoute: functionBlock(src, 'sanitizeLastUsedEngineRoute'),
    normalizeSessionEngineRoute: functionBlock(src, 'normalizeSessionEngineRoute'),
    agentCliInstallCandidates: functionBlock(src, 'agentCliInstallCandidates'),
    selectedAgentCli: functionBlock(src, 'selectedAgentCli'),
    prepareAgentCliSpawn: functionBlock(src, 'prepareAgentCliSpawn'),
    syncAgentCliMcpManifests: functionBlock(src, 'syncAgentCliMcpManifests'),
    agentCliAdapter: functionBlock(src, 'agentCliAdapter'),
    maybeAutoCompactAgentSession: functionBlock(src, 'maybeAutoCompactAgentSession'),
    engineBriefFacts: functionBlock(src, 'engineBriefFacts'),
    renderCliEnvBrief: functionBlock(src, 'renderCliEnvBrief'),
    agentConversationContextMeta: functionBlock(src, 'agentConversationContextMeta'),
    applyConfigPatch: functionBlock(src, 'applyConfigPatch'),
    startServerInner: functionBlock(src, 'startServerInner'),
    'route /api/models': bracedBlock(src, "if (req.method === 'GET' && pathname === '/api/models')"),
    'route /api/agent/compact': bracedBlock(src, "if (req.method === 'POST' && pathname === '/api/agent/compact')"),
  };
  for (const [name, block] of Object.entries(blocks)) {
    assert.ok(block.length > 60, `切到 ${name}`);
    assert.doesNotMatch(code(block), LITERAL_CLI_COMPARE, `${name} 不再按 CLI 名字面量分叉(问登记表 / 适配器)`);
  }
  // 配置归一里「agentCliType 必须是登记过的类型」那一句也问登记表(normalizeConfig 里仍有 Kimi 旧模型名迁移,那是 Kimi 自己的数据迁移)。
  const normalizeConfig = code(functionBlock(src, 'normalizeConfig'));
  assert.ok(normalizeConfig.includes('if (!isAgentCliType(config.agentCliType)) {'));
  assert.doesNotMatch(normalizeConfig, /\[\s*'claude'\s*,\s*'kimi'\s*\]/);
  // /api/status 的即时模型清单一行。
  const statusModels = code(src).split('\n').filter(line => /^\s*models: .*conversationConfig/.test(line));
  assert.equal(statusModels.length, 1);
  assert.match(statusModels[0], /agentCliAdapter\(conversationConfig\.agentCliType\)\.modelCatalog\.offline\(conversationConfig\)/);
  // 改配置与启动预热两处的 Kimi MCP 同步都收进 01 syncAgentCliMcpManifests(按登记表推),不再直调 Kimi 的同步函数。
  for (const name of ['applyConfigPatch', 'startServerInner']) {
    assert.doesNotMatch(code(blocks[name]), /(?<![.\w])syncMcpServersToKimi\(/, `${name} 不直调 syncMcpServersToKimi`);
    assert.match(code(blocks[name]), /syncAgentCliMcpManifests\(/, `${name} 经 syncAgentCliMcpManifests 同步`);
  }
});

test.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
