'use strict';
// Agent 角色颜色(设置页「Agent 角色」编辑器)。修前的丢失链:
//   编辑卡 captureAgentRoleDraft 不读 color → 存「全局覆盖」时 normalizeAgentRole 把缺失收成 color:'' →
//   getAgentRoleLibrary 里 mergeAgentRole 的 {...base, ...override} 用 '' 盖掉内置角色的蓝/绿/橙… →
//   工作流画布的角色胶囊 / 左色条变灰。
// 本件钉四层:
//   [S] 服务端合并:空颜色的覆盖(含老配置里已落盘的 color:'')不抹内置色;非空的覆盖照常生效;自定义角色不受影响
//   [C] 前端读卡:readRoleCard 把颜色原样带回(含调色板之外的手编值)
//   [M] 前端草稿合并:mergeRoleDraft 与服务端同口径
//   [P] 调色板:前端候选 = tokens.css 的 --role-* 全集;roleColorCss 只放行合法名字
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-role-color-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
after(() => fs.rmSync(root, { recursive: true, force: true }));
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
// agent-roles.js 的依赖链(state.js)在模块顶层写一次 window.state 兼容层;给它一个 window 别名即可,不引入 DOM。
const loadRoles = () => { if (!globalThis.window) globalThis.window = globalThis; return import(pathToFileURL(path.join(app, 'public', 'js', 'agent-roles.js')).href); };

test('[S] 全局覆盖里的空颜色不抹内置角色的颜色', async () => {
  // 修前设置页存盘带出的形状:没改颜色,只改了描述;normalizeAgentRole 把缺失的 color 收成 ''
  const saved = srv.normalizeAgentRole({ id: 'explorer', description: '改过的描述' }, { source: 'global' });
  assert.equal(saved.color, '', '前提:覆盖条目的 color 是空串');
  const lib = await srv.getAgentRoleLibrary(root, { agentRoleOverrides: [saved] });
  const explorer = lib.find(r => r.id === 'explorer');
  assert.equal(explorer.description, '改过的描述', '覆盖的其它字段照常生效');
  assert.equal(explorer.color, 'blue', '空颜色让位给内置色');
  // 其余内置角色的颜色一个不丢
  const builtins = srv.BUILTIN_AGENT_ROLES.map(r => srv.normalizeAgentRole(r, { source: 'builtin', builtin: true }));
  assert.ok(builtins.length >= 10 && builtins.every(r => r.color), '前提:内置角色都有颜色');
  const overrides = builtins.map(r => srv.normalizeAgentRole({ id: r.id, label: 'X' }, { source: 'global' }));
  const all = await srv.getAgentRoleLibrary(root, { agentRoleOverrides: overrides });
  for (const r of builtins) assert.equal(all.find(x => x.id === r.id).color, r.color, `${r.id} 的颜色`);
});

test('[S] 非空的覆盖颜色照常生效;自定义角色的颜色按自己的来', async () => {
  const lib = await srv.getAgentRoleLibrary(root, { agentRoleOverrides: [
    srv.normalizeAgentRole({ id: 'explorer', color: 'red' }, { source: 'global' }),
    srv.normalizeAgentRole({ id: 'my-role', color: 'teal' }, { source: 'global' }),
    srv.normalizeAgentRole({ id: 'plain-role' }, { source: 'global' }),
  ] });
  assert.equal(lib.find(r => r.id === 'explorer').color, 'red');
  assert.equal(lib.find(r => r.id === 'my-role').color, 'teal');
  assert.equal(lib.find(r => r.id === 'plain-role').color, '', '自定义角色没选颜色就是无色');
});

test('[C] 读卡把颜色原样带回', async () => {
  const { readRoleCard } = await loadRoles();
  const card = color => {
    const values = { id: ' explorer ', label: 'E', description: '', prompt: '', toolTier: 'read', openaiModel: '', claudeModel: '', openaiTools: '', claudeTools: 'Read, Grep', mcpServers: '', permissionMode: 'plan', openaiBudget: '100', claudeBudget: '100', isolation: 'none', color };
    return { dataset: { builtin: '1' }, querySelector: sel => { const m = /data-role-field="(\w+)"/.exec(sel); return m && m[1] in values ? { value: values[m[1]] } : null; } };
  };
  assert.equal(readRoleCard(card('blue')).color, 'blue');
  assert.equal(readRoleCard(card('')).color, '');
  assert.equal(readRoleCard(card('my-brand-color')).color, 'my-brand-color', '调色板之外的手编值也不丢');
  const row = readRoleCard(card('green'));
  assert.equal(row.id, 'explorer');
  assert.deepEqual(row.claudeTools, ['Read', 'Grep']);
  assert.equal(row.builtin, true);
  // 读出来的草稿原样送去服务端清洗 → 颜色保住
  assert.equal(srv.normalizeAgentRole(row, { source: 'global' }).color, 'green');
});

test('[M] 前端草稿合并:空颜色让位给内置色,非空覆盖照常生效', async () => {
  const { mergeRoleDraft } = await loadRoles();
  const base = { id: 'worker', color: 'green', models: { openai: '', claude: 'inherit' }, budgets: { openai: 100, claude: 100 } };
  assert.equal(mergeRoleDraft(base, { id: 'worker', color: '' }).color, 'green');
  assert.equal(mergeRoleDraft(base, { id: 'worker' }).color, 'green');
  assert.equal(mergeRoleDraft(base, { id: 'worker', color: 'red' }).color, 'red');
  assert.equal('color' in mergeRoleDraft({ id: 'c' }, { id: 'c', color: '' }), false, '两边都没有就不留空串');
  assert.deepEqual(mergeRoleDraft(base, { id: 'worker', models: { openai: 'm' } }).models, { openai: 'm', claude: 'inherit' }, '其它字段的深合并不变');
});

test('[P] 前端候选 = tokens.css 的 --role-* 全集;色块只放行合法名字', async () => {
  const { AGENT_ROLE_COLORS, roleColorCss } = await loadRoles();
  const css = fs.readFileSync(path.join(app, 'public', 'css', 'tokens.css'), 'utf8');
  const tokens = [...css.matchAll(/--role-([a-z0-9]+):\s*#/g)].map(m => m[1]);
  assert.deepEqual([...AGENT_ROLE_COLORS].sort(), [...tokens].sort());
  assert.ok(Object.isFrozen(AGENT_ROLE_COLORS));
  // 内置角色用到的颜色都在候选里
  for (const r of srv.BUILTIN_AGENT_ROLES) assert.ok(AGENT_ROLE_COLORS.includes(r.color), `${r.id}:${r.color}`);
  assert.equal(roleColorCss('blue'), 'var(--role-blue, var(--muted))');
  assert.equal(roleColorCss(''), 'transparent');
  assert.equal(roleColorCss('x); background:url(//e'), 'transparent', '带括号分号的值不进 style');
});
