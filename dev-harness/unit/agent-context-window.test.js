'use strict';
// 2026-10: sub-agent nodes must honour the per-model conversation window from Settings. Before this a
// node ignored it and fell back to the name table (deepseek-flash -> 131072), so a sub-agent compacted
// about eight times earlier than the conversation that spawned it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ctxwin-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const { agentNodeContextWindow, contextWindowFromTable, configuredConversationWindow } =
  loadServerInternals(['agentNodeContextWindow', 'contextWindowFromTable', 'configuredConversationWindow']);
const overrideKey = (engine, routeId, model) => JSON.stringify([engine, routeId, model]);
const provider = { id: 'ds', model: 'deepseek-flash', models: [{ id: 'deepseek-flash' }] };

test('the model name table knows deepseek-flash is 1M and keeps the 128K rows intact', () => {
  assert.equal(contextWindowFromTable('deepseek-flash'), 1000000);
  assert.equal(contextWindowFromTable('deepseek-v4-flash'), 1000000);
  assert.equal(contextWindowFromTable('deepseek-chat'), 131072);
  assert.equal(contextWindowFromTable('deepseek-reasoner'), 131072);
});

test('an openai agent node inherits the per-model conversation window', () => {
  const bare = agentNodeContextWindow({ engine: 'openai', model: 'deepseek-flash' }, provider, {});
  assert.equal(bare, 1000000, 'deepseek-flash resolves to 1M from the table');
  // A provider whose model the table only knows generically: the manual window must win.
  const legacyProvider = { id: 'ds', model: 'deepseek-chat', models: [{ id: 'deepseek-chat' }] };
  assert.equal(agentNodeContextWindow({ engine: 'openai', model: 'deepseek-chat' }, legacyProvider, {}), 131072);
  const config = { contextWindowOverrides: { [overrideKey('openai', 'ds', 'deepseek-chat')]: 1000000 } };
  assert.equal(configuredConversationWindow(config, 'openai', 'ds', 'deepseek-chat'), 1000000);
  assert.equal(agentNodeContextWindow({ engine: 'openai', model: 'deepseek-chat' }, legacyProvider, config), 1000000,
    'the node must use the same manual window as the conversation it was spawned from');
});

test('an out-of-range manual window is ignored, and claude nodes keep their own override', () => {
  const legacyProvider = { id: 'ds', model: 'deepseek-chat', models: [{ id: 'deepseek-chat' }] };
  const tooSmall = { contextWindowOverrides: { [overrideKey('openai', 'ds', 'deepseek-chat')]: 4000 } };
  assert.equal(configuredConversationWindow(tooSmall, 'openai', 'ds', 'deepseek-chat'), 0);
  assert.equal(agentNodeContextWindow({ engine: 'openai', model: 'deepseek-chat' }, legacyProvider, tooSmall), 131072);
  const claudeConfig = { contextWindowOverrides: { [overrideKey('agent', 'claude', 'sonnet-5')]: 400000 } };
  assert.equal(agentNodeContextWindow({ engine: 'claude', model: 'sonnet-5' }, null, claudeConfig), 400000);
  assert.equal(agentNodeContextWindow({ engine: 'claude', model: 'sonnet-5' }, null, {}), 1000000);
});
