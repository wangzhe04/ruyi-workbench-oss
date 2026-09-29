'use strict';
// hunt2-mcp:记忆预检(06d resolveMemoryPreflight)的两处名额错配。真源码、临时 HOME、真读盘。
//
//   [R] 相关记忆 Top-N 修前在「含已激活核心」的全集里排、排完再滤掉核心:核心条目恰好最相关时名额全被它们占掉,
//       related 变空,而明明还有匹配的非核心记忆。现在先去掉已激活核心再排。
//   [N] 原生 CLI 自己会读的导入条目(agentmd-claude-md-*,Claude Code 读 ~/.claude/CLAUDE.md)修前在调用点、
//       【核心预算算完之后】才摘掉:重复条目先占满核心名额又被丢弃,用户自己的核心记忆被挤出去。现在调用方传
//       options.cliType,在算核心预算之前摘掉。provider 引擎(不传 cliType)行为不变。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-preflight-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { saveMemory, resolveMemoryPreflight } = srv;

test('[R] 核心占满相关性前几名时,非核心的匹配记忆仍进 related', async () => {
  const cwd = path.join(root, 'proj-r');
  fs.mkdirSync(cwd, { recursive: true });
  for (let i = 0; i < 3; i++) await saveMemory({ id: 'plain-deploy-' + i, scope: 'project', name: 'deploy plain ' + i, description: 'deploy pipeline note ' + i, type: 'lesson', body: 'x' }, cwd);
  for (let i = 0; i < 9; i++) await saveMemory({ id: 'core-deploy-' + i, scope: 'project', name: 'deploy core ' + i, description: 'deploy pipeline rule ' + i, type: 'lesson', body: 'x', core: true }, cwd);
  const pf = await resolveMemoryPreflight({}, cwd, 'how do I deploy the pipeline', null, null);
  assert.ok(pf.coreEntries.length > 0, 'core entries active');
  const coreIds = new Set(pf.coreEntries.map(e => e.id));
  assert.ok(pf.entries.length > 0, 'related is not empty');
  assert.ok(pf.entries.every(e => !coreIds.has(e.id)), 'related never repeats an active core entry');
  assert.ok(pf.entries.every(e => e.id.startsWith('plain-deploy-')), JSON.stringify(pf.entries.map(e => e.id)));
});

test('[N] 传 cliType 时,原生 CLI 会读的导入条目不占核心预算', async () => {
  const cwd = path.join(root, 'proj-n');
  fs.mkdirSync(cwd, { recursive: true });
  for (let i = 1; i <= 12; i++) await saveMemory({ id: 'agentmd-claude-md-' + i, scope: 'global', name: 'claude md ' + i, description: 'd', coreSummary: 'c'.repeat(500), type: 'convention', body: 'x', core: true, importance: 'important' }, cwd);
  for (let i = 1; i <= 20; i++) await saveMemory({ id: 'mine-' + i, scope: 'global', name: 'mine ' + i, description: 'm'.repeat(500), coreSummary: 'm'.repeat(500), type: 'preference', body: 'x', core: true }, cwd);
  const plain = await resolveMemoryPreflight({}, cwd, 'hello', null, null);
  const plainMine = plain.coreEntries.filter(e => e.id.startsWith('mine-')).length;
  const forClaude = await resolveMemoryPreflight({}, cwd, 'hello', null, null, { cliType: 'claude' });
  const ids = forClaude.coreEntries.map(e => e.id);
  assert.equal(ids.filter(id => id.startsWith('agentmd-claude-md-')).length, 0, 'natively-read entries are excluded');
  assert.ok(ids.filter(id => id.startsWith('mine-')).length > plainMine,
    `own core memories get the freed budget (claude: ${ids.filter(id => id.startsWith('mine-')).length}, provider: ${plainMine})`);
  assert.ok(forClaude.entries.every(e => !e.id.startsWith('agentmd-claude-md-')), 'not re-added as related either');
  // provider 引擎(不传 cliType)照旧看得到导入条目。
  assert.ok(plain.coreEntries.some(e => e.id.startsWith('agentmd-claude-md-')));
});
