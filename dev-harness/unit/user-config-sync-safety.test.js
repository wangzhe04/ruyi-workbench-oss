'use strict';
// 走查 W1 #1/#7 与补充 A/B:工作台往【用户自己的】CLI 配置里同步时不得丢用户的东西。真源码、临时 HOME / KIMI_CODE_HOME、零网络。
//   [K] Kimi 的 mcp.json(syncMcpServersToKimi):
//       K1 带尾逗号的坏 JSON / 根不是对象 / 读不动(这里用「它是个目录」造 EISDIR,Windows 上 EBUSY/EPERM 同属「非 ENOENT 的读错误」)
//          → 整次同步跳过,mcp.json 原样、所有权旁账也不写;
//       K2 带 UTF-8 BOM 的合法 JSON(Windows 记事本保存)→ 先剥 BOM 再解析,用户条目保留;
//       K3 文件不存在 / 全空白 → 视为「空」,新建 / 合并。
//   [C] ~/.claude/settings.json(syncClaudeCliSettings):同三类情形(启动即调,所以「仅仅启动工作台」就会丢 permissions/env/hooks)。
//   [T] 如意没设思考预算时,只删【自己写过的】MAX_THINKING_TOKENS(sidecar 记权属),用户手写的值留着。
//   [A] syncAgentRolesToClaude 只覆盖带标记的自家文件:同名的用户文件不动、老版本(无标记)写出且没改过的升级成带标记、
//       其余无标记的保守跳过;用户删掉标记行 = 接管,不再被覆盖。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-user-sync-safety-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
const kimiHome = path.join(root, 'kimi-home');
const work = path.join(root, 'work');
for (const d of [home, data, kimiHome, work]) fs.mkdirSync(d, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
process.env.RUYI_HOME = data;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.KIMI_CODE_HOME = kimiHome;
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.4.0', autoImportClaudeCodeMcp: false, activeProvider: '' }, null, 2));
const { loadServerInternals } = require('../lib/server-internals');
const internals = loadServerInternals(['syncClaudeCliSettings', 'syncMcpServersToKimi', 'syncAgentRolesToClaude', 'normalizeConfig', 'RUYI_AGENT_FILE_MARKER']);
const { syncClaudeCliSettings, syncMcpServersToKimi, syncAgentRolesToClaude, normalizeConfig, RUYI_AGENT_FILE_MARKER } = internals;

const BOM = '\uFEFF';
const rd = file => fs.readFileSync(file, 'utf8');
const rmrf = file => fs.rmSync(file, { recursive: true, force: true });

// ───────────── [K] Kimi mcp.json ─────────────
const kimiTarget = path.join(kimiHome, 'mcp.json');
const kimiSidecar = path.join(data, 'kimi-mcp-sync.json');
const kimiConfig = normalizeConfig({ includeWorkbenchMcp: true, mcpCommandMode: 'node', desktopMcp: { enabled: false, autodetect: false }, externalMcpServers: [] }).config;
const kimiReset = () => { rmrf(kimiTarget); rmrf(kimiSidecar); };

test('[K1] 带尾逗号的坏 JSON:mcp.json 与旁账都不动', async () => {
  kimiReset();
  const bad = '{\n  "mcpServers": {\n    "my-own": { "command": "node", "args": ["x.js"] },\n  }\n}\n';   // 尾逗号 = 非法 JSON
  fs.writeFileSync(kimiTarget, bad);
  await syncMcpServersToKimi(kimiConfig);
  assert.equal(rd(kimiTarget), bad, '用户的 mcp.json 原样(修前被当成 {} 整份覆盖,「my-own」丢光)');
  assert.equal(fs.existsSync(kimiSidecar), false, '没写进去就不记所有权旁账');
});

test('[K1] 根不是对象(数组 / 字面量)与读不动(是个目录)同样跳过', async () => {
  for (const content of ['[1, 2, 3]', '"just a string"', 'null']) {
    kimiReset();
    fs.writeFileSync(kimiTarget, content);
    await syncMcpServersToKimi(kimiConfig);
    assert.equal(rd(kimiTarget), content, `根为 ${content}:原样`);
    assert.equal(fs.existsSync(kimiSidecar), false);
  }
  kimiReset();
  fs.mkdirSync(kimiTarget);   // readFile 抛 EISDIR:不是 ENOENT,不能当「空」
  await syncMcpServersToKimi(kimiConfig);
  assert.ok(fs.statSync(kimiTarget).isDirectory(), '读错误:没去覆盖它');
  assert.equal(fs.existsSync(kimiSidecar), false);
  rmrf(kimiTarget);
});

test('[K2] 带 BOM 的合法 mcp.json:用户条目保留,如意条目并进去', async () => {
  kimiReset();
  fs.writeFileSync(kimiTarget, BOM + JSON.stringify({ mcpServers: { 'my-own': { command: 'node', args: ['x.js'] } }, theme: 'dark' }, null, 2));
  await syncMcpServersToKimi(kimiConfig);
  const out = JSON.parse(rd(kimiTarget));
  assert.deepEqual(out.mcpServers['my-own'], { command: 'node', args: ['x.js'] }, '用户自己的条目还在(修前 BOM 让 JSON.parse 失败 → 整份重写)');
  assert.equal(out.theme, 'dark', '用户的其它顶层键也在');
  assert.ok(out.mcpServers.ruyi, '如意自己的条目合并进去了');
  assert.ok(fs.existsSync(kimiSidecar), '写了就记旁账');
});

test('[K3] 文件不存在与全空白都当「空」:照常新建 / 合并', async () => {
  kimiReset();
  await syncMcpServersToKimi(kimiConfig);
  assert.ok(JSON.parse(rd(kimiTarget)).mcpServers.ruyi, '不存在 → 新建');
  kimiReset();
  fs.writeFileSync(kimiTarget, '  \r\n\r\n');
  await syncMcpServersToKimi(kimiConfig);
  assert.ok(JSON.parse(rd(kimiTarget)).mcpServers.ruyi, '全空白 → 合并');
  kimiReset();
});

// ───────────── [C] ~/.claude/settings.json ─────────────
const claudeDir = path.join(home, '.claude');
const settingsPath = path.join(claudeDir, 'settings.json');
const settingsSidecar = path.join(data, 'claude-settings-sync.json');
const settingsReset = () => { rmrf(claudeDir); rmrf(settingsSidecar); fs.mkdirSync(claudeDir, { recursive: true }); };
const settingsConfig = (patch = {}) => ({ permissionMode: 'default', model: '', thinkingBudget: 0, ...patch });
const userSettings = { permissions: { allow: ['Bash(npm test)'] }, env: { MY_VAR: '1' }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] }, statusLine: { type: 'command', command: 'keep-me' } };

test('[C1] 带尾逗号的坏 settings.json 原样不动(旁账也不写)', async () => {
  settingsReset();
  const bad = '{\n  "permissions": { "allow": ["Bash(npm test)"], },\n  "env": { "MY_VAR": "1" }\n}\n';
  fs.writeFileSync(settingsPath, bad);
  await syncClaudeCliSettings(settingsConfig({ permissionMode: 'acceptEdits', thinkingBudget: 5000 }));
  assert.equal(rd(settingsPath), bad, '用户的 settings.json 原样(修前被覆盖成只剩 permissions.defaultMode)');
  assert.equal(fs.existsSync(settingsSidecar), false);
  for (const content of ['[]', '42']) {
    fs.writeFileSync(settingsPath, content);
    await syncClaudeCliSettings(settingsConfig());
    assert.equal(rd(settingsPath), content, `根为 ${content}:原样`);
  }
  fs.rmSync(settingsPath);
  fs.mkdirSync(settingsPath);   // 读不动(EISDIR,非 ENOENT)
  await syncClaudeCliSettings(settingsConfig());
  assert.ok(fs.statSync(settingsPath).isDirectory());
  rmrf(settingsPath);
});

test('[C2] 带 BOM 的合法 settings.json(仅启动就会调到):permissions/env/hooks 全部保留,只合并工作台那几个键', async () => {
  settingsReset();
  fs.writeFileSync(settingsPath, BOM + JSON.stringify(userSettings, null, 2));
  await syncClaudeCliSettings(settingsConfig({ permissionMode: 'default' }));
  const out = JSON.parse(rd(settingsPath));
  assert.deepEqual(out.permissions.allow, ['Bash(npm test)'], '用户的 allow 列表还在');
  assert.equal(out.env.MY_VAR, '1');
  assert.deepEqual(out.hooks, userSettings.hooks, 'hooks 还在');
  assert.deepEqual(out.statusLine, userSettings.statusLine);
  assert.ok(out.permissions.defaultMode, '工作台的 permissions.defaultMode 合并进去了');
});

test('[C3] 不存在 / 全空白 → 新建 / 合并', async () => {
  settingsReset();
  await syncClaudeCliSettings(settingsConfig());
  assert.ok(JSON.parse(rd(settingsPath)).permissions.defaultMode, '不存在 → 新建');
  fs.writeFileSync(settingsPath, '\n\n');
  await syncClaudeCliSettings(settingsConfig());
  assert.ok(JSON.parse(rd(settingsPath)).permissions.defaultMode, '全空白 → 合并');
});

// ───────────── [T] MAX_THINKING_TOKENS 权属 ─────────────
test('[T1] 没设预算时不删用户手写的 MAX_THINKING_TOKENS', async () => {
  settingsReset();
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { MAX_THINKING_TOKENS: '31999', KEEP: 'x' } }, null, 2));
  await syncClaudeCliSettings(settingsConfig({ thinkingBudget: 0 }));   // sidecar 还不存在:没有任何「我写过」的证据
  assert.equal(JSON.parse(rd(settingsPath)).env.MAX_THINKING_TOKENS, '31999', '手写值还在(修前无条件 delete)');
  await syncClaudeCliSettings(settingsConfig({ thinkingBudget: 0 }));
  assert.equal(JSON.parse(rd(settingsPath)).env.MAX_THINKING_TOKENS, '31999', '再同步一次也还在');
});

test('[T2] 工作台写过的值,清掉预算时才被删;之后用户自己改过的值不删', async () => {
  settingsReset();
  fs.writeFileSync(settingsPath, JSON.stringify({ env: { KEEP: 'x' } }, null, 2));
  await syncClaudeCliSettings(settingsConfig({ thinkingBudget: 8000 }));
  assert.equal(JSON.parse(rd(settingsPath)).env.MAX_THINKING_TOKENS, '8000', '设了预算:写入');
  assert.equal(JSON.parse(rd(settingsSidecar)).maxThinkingTokens, '8000', 'sidecar 记下权属');
  await syncClaudeCliSettings(settingsConfig({ thinkingBudget: 0 }));
  const cleared = JSON.parse(rd(settingsPath));
  assert.equal('MAX_THINKING_TOKENS' in cleared.env, false, '清掉预算:自己写的那个值被删');
  assert.equal(cleared.env.KEEP, 'x');
  assert.equal(JSON.parse(rd(settingsSidecar)).maxThinkingTokens, null, 'sidecar 同步清空');
  // 用户在工作台写入之后又自己改了值 → 不再是「我们写的」,清预算时不删
  await syncClaudeCliSettings(settingsConfig({ thinkingBudget: 8000 }));
  const edited = JSON.parse(rd(settingsPath)); edited.env.MAX_THINKING_TOKENS = '12345';
  fs.writeFileSync(settingsPath, JSON.stringify(edited, null, 2));
  await syncClaudeCliSettings(settingsConfig({ thinkingBudget: 0 }));
  assert.equal(JSON.parse(rd(settingsPath)).env.MAX_THINKING_TOKENS, '12345', '用户改过的值留着');
});

// ───────────── [A] ~/.claude/agents ─────────────
const agentsDir = path.join(claudeDir, 'agents');
const agentFiles = () => fs.readdirSync(agentsDir).filter(f => f.endsWith('.md')).sort();
const rolesConfig = () => normalizeConfig({ agentRoleOverrides: [] }).config;

test('[A1] 全新目录:每个角色写出带标记的文件;标记在 frontmatter 之后第一行,frontmatter 本身不含标记', async () => {
  rmrf(claudeDir);
  await syncAgentRolesToClaude(work, rolesConfig());
  const files = agentFiles();
  assert.ok(files.length >= 2, `写出了内置角色文件(${files.join(',')})`);
  for (const f of files) {
    const text = rd(path.join(agentsDir, f));
    const m = /^---\n([\s\S]*?)\n---\n\n(.*)\n/.exec(text);
    assert.ok(m, `${f}:frontmatter 形状不变`);
    assert.ok(!m[1].includes('ruyi-managed'), `${f}:标记不在 frontmatter 里(不影响 Claude Code 解析)`);
    assert.equal(m[2], RUYI_AGENT_FILE_MARKER, `${f}:frontmatter 后第一行是标记`);
  }
});

test('[A2] 用户自己的同名文件不被覆盖;其它角色照常写', async () => {
  rmrf(claudeDir);
  fs.mkdirSync(agentsDir, { recursive: true });
  await syncAgentRolesToClaude(work, rolesConfig());   // 先拿到会写出哪些文件名
  const ids = agentFiles();
  rmrf(agentsDir); fs.mkdirSync(agentsDir, { recursive: true });
  const mine = ids[0];
  const mineContent = '---\nname: mine\ndescription: "我自己写的子代理"\n---\n\n我自己的提示词,不许覆盖。\n';
  fs.writeFileSync(path.join(agentsDir, mine), mineContent);
  await syncAgentRolesToClaude(work, rolesConfig());
  assert.equal(rd(path.join(agentsDir, mine)), mineContent, '用户的同名文件原样(修前被整文件覆盖、无备份)');
  for (const other of ids.slice(1)) assert.ok(rd(path.join(agentsDir, other)).includes(RUYI_AGENT_FILE_MARKER), `${other}:没冲突的照常写出`);
});

test('[A3] 自家文件:旧内容被更新;内容已是最新则不重写;老版本(无标记)写出且没改过的升级成带标记', async () => {
  rmrf(claudeDir);
  fs.mkdirSync(agentsDir, { recursive: true });
  await syncAgentRolesToClaude(work, rolesConfig());
  const [a, b, c] = agentFiles();
  const fa = path.join(agentsDir, a), fb = path.join(agentsDir, b), fc = path.join(agentsDir, c);
  const generatedA = rd(fa), generatedB = rd(fb);
  // a:带标记但正文是旧的 → 更新回当前生成结果
  fs.writeFileSync(fa, generatedA.replace(/\n\n(?!<!--)([^\n]*)\n$/, '\n\n过期的旧提示词\n'));
  assert.notEqual(rd(fa), generatedA);
  // b:老版本写法 = 去掉标记行与其后空行,其余逐字相同
  const legacyB = generatedB.replace(RUYI_AGENT_FILE_MARKER + '\n\n', '');
  assert.notEqual(legacyB, generatedB);
  fs.writeFileSync(fb, legacyB);
  // c:老版本写法 + 一行改动(用户或后来的角色配置改过)→ 判不了,保守跳过
  const legacyC = rd(fc).replace(RUYI_AGENT_FILE_MARKER + '\n\n', '') + '用户补了一句\n';
  fs.writeFileSync(fc, legacyC);
  await syncAgentRolesToClaude(work, rolesConfig());
  assert.equal(rd(fa), generatedA, '带标记的旧内容 → 更新');
  assert.equal(rd(fb), generatedB, '老版本写出且没动过 → 升级成带标记');
  assert.equal(rd(fc), legacyC, '无标记且与老写法对不上 → 不碰');
});

test('[A4] 用户删掉标记行 = 接管:之后不再被覆盖;读不动的目标(同名目录)跳过不炸', async () => {
  rmrf(claudeDir);
  fs.mkdirSync(agentsDir, { recursive: true });
  await syncAgentRolesToClaude(work, rolesConfig());
  const [a, b] = agentFiles();
  const fa = path.join(agentsDir, a);
  const taken = rd(fa).replace(RUYI_AGENT_FILE_MARKER + '\n\n', '').replace(/\n$/, '\n接管后我自己加的内容\n');
  fs.writeFileSync(fa, taken);
  rmrf(path.join(agentsDir, b)); fs.mkdirSync(path.join(agentsDir, b));   // 读 EISDIR
  await syncAgentRolesToClaude(work, rolesConfig());
  assert.equal(rd(fa), taken, '删了标记的文件保持用户版本');
  assert.ok(fs.statSync(path.join(agentsDir, b)).isDirectory(), '读不动的目标不去覆盖');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
