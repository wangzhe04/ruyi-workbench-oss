'use strict';
// 前端走查第 1 波(设置面)里的纯函数判据(真浏览器那一半见 dev-harness/settings-wave1.browser.e2e.js):
//   [R] agent-roles.js 的 rolesToSave / roleEqualsBuiltin —— 保存角色不把没动过的内置角色固化进 agentRoleOverrides
//   [P] util.js 的 looksAbsolutePath / stripWrappingQuotes —— 设置页手填工作文件夹与顶栏同一判据
//   [E] net.js 的 apiErrText —— 服务端把 {ok:false,error:'字符串'} 信封成 {code,params,message} 后,取词函数给人话、不给 [object Object]
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const loadJs = name => { if (!globalThis.window) globalThis.window = globalThis; return import(pathToFileURL(path.join(app, 'public', 'js', name)).href); };
const { BUILTIN_AGENT_ROLES, normalizeAgentRole } = require(path.join(app, 'server.js'));

// 与 readRoleCard 同形的「草稿条目」:服务端内置角色 → 经表单读回来的样子(多出 builtin 标记)。
const draftOf = role => ({
  id: role.id, label: role.label, description: role.description, prompt: role.prompt, toolTier: role.toolTier,
  models: { openai: role.models.openai, claude: role.models.claude }, openaiTools: [...role.openaiTools], claudeTools: [...role.claudeTools],
  mcpServers: [...role.mcpServers], permissionMode: role.permissionMode, budgets: { ...role.budgets }, isolation: role.isolation,
  color: role.color || '', builtin: true,
});

test('[R] 没动过的内置角色不进保存清单;改过的与自定义的留下', async () => {
  const { rolesToSave, roleEqualsBuiltin } = await loadJs('agent-roles.js');
  const builtins = BUILTIN_AGENT_ROLES.map(r => normalizeAgentRole(r, { source: 'builtin', builtin: true }));
  assert.ok(builtins.length >= 3, '内置角色至少有几个才有意义');
  const draft = builtins.map(draftOf);
  for (const role of draft) assert.equal(roleEqualsBuiltin(role, builtins), true, `${role.id} 原样读回应当与内置相等`);
  assert.deepEqual(rolesToSave(draft, builtins, 'global'), [], '一个都没改 → 一个都不存');
  const edited = draft.map((r, i) => (i === 0 ? { ...r, label: '我改的名字' } : r));
  const custom = { ...draftOf(builtins[0]), id: 'my-own', label: '自定义', builtin: false };
  const saved = rolesToSave([...edited, custom], builtins, 'global');
  assert.deepEqual(saved.map(r => r.id), [builtins[0].id, 'my-own'], '只有改过的内置角色与自定义角色被保存');
  // 深度相等:嵌套的预算、模型、工具清单任何一处不同都算改过
  const budgetEdited = draft.map((r, i) => (i === 1 ? { ...r, budgets: { ...r.budgets, openai: r.budgets.openai + 1 } } : r));
  assert.deepEqual(rolesToSave(budgetEdited, builtins, 'global').map(r => r.id), [builtins[1].id]);
  const toolsEdited = draft.map((r, i) => (i === 2 ? { ...r, openaiTools: [...r.openaiTools, 'extra_tool'] } : r));
  assert.deepEqual(rolesToSave(toolsEdited, builtins, 'global').map(r => r.id), [builtins[2].id]);
  // 项目范围不过滤(.ruyi/agents.json 就是整份清单)
  assert.equal(rolesToSave(draft, builtins, 'project').length, draft.length);
});

test('[R2] 表单读回时的首尾空白不让内置角色被误判成「改过」', async () => {
  const { roleEqualsBuiltin } = await loadJs('agent-roles.js');
  const builtins = BUILTIN_AGENT_ROLES.map(r => normalizeAgentRole(r, { source: 'builtin', builtin: true }));
  const padded = { ...draftOf(builtins[0]), prompt: '\n  ' + builtins[0].prompt + '  \n', label: ' ' + builtins[0].label + ' ' };
  assert.equal(roleEqualsBuiltin(padded, builtins), true);
  assert.equal(roleEqualsBuiltin({ ...draftOf(builtins[0]), id: 'not-a-builtin' }, builtins), false, '没有同 id 的内置角色 → 不相等');
});

test('[P] 工作文件夹的绝对路径判据(与顶栏粘贴路径同一份)', async () => {
  const { looksAbsolutePath, stripWrappingQuotes } = await loadJs('util.js');
  for (const ok of ['C:\\Users\\me\\proj', 'c:/work', '\\\\server\\share\\dir', '/home/me/proj', '"C:\\Users\\me\\proj"', '“D:\\a”', " 'C:\\x' "]) {
    assert.equal(looksAbsolutePath(ok), true, `${ok} 应当算绝对路径`);
  }
  for (const bad of ['', '   ', 'abc', 'relative\\dir', './x', '..\\x', 'proj/sub', 'C:', 'C:proj']) {
    assert.equal(looksAbsolutePath(bad), false, `${JSON.stringify(bad)} 不该算绝对路径`);
  }
  assert.equal(stripWrappingQuotes('"C:\\a b"'), 'C:\\a b');
  assert.equal(stripWrappingQuotes('""C:\\x""'), 'C:\\x');
  assert.equal(stripWrappingQuotes('C:\\a"b'), 'C:\\a"b', '只剥成对且在首尾的引号');
});

test('[E] apiErrText 对「信封化的字符串错误」给人话,不给 [object Object]', async () => {
  const { apiErrText } = await loadJs('net.js');
  const envelope = { code: 'api.request_failed', params: {}, message: '该文件夹缺少有效的 ruyi-mcp.json' };
  assert.equal(apiErrText(envelope), envelope.message, '直接把 r.error(对象)交给它');
  assert.equal(apiErrText({ ok: false, error: envelope }), envelope.message, '整个响应体也行');
  assert.equal(apiErrText('仍有旧路由回字符串'), '仍有旧路由回字符串');
  assert.equal(apiErrText(undefined), '', '没有 error 字段 → 空串,调用方 || 兜底文案');
  assert.equal(apiErrText(new Error(JSON.stringify({ ok: false, error: envelope }))), envelope.message, 'api() 对非 2xx 抛的 Error(正文是 JSON)');
  for (const input of [envelope, '字符串', undefined, null, { error: envelope }]) assert.ok(!String(apiErrText(input)).includes('[object Object]'));
});
