'use strict';
// 2026-10: the learned window cap (a context-400 saw the real limit) must still clamp an agent node,
// including nodes that never name a model. The seed has to land before server.js is loaded because the
// calibration store reads (and caches) `<data>/context-calibration.json` on its first read.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ctxwincap-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;
fs.writeFileSync(path.join(HOME_DIR, 'context-calibration.json'), JSON.stringify({
  schema: 1, factors: {}, windowCaps: { 'ds/deepseek-chat': { cap: 200000 } },
}, null, 2), 'utf8');

const { loadServerInternals } = require('../lib/server-internals');
const { agentNodeContextWindow } = loadServerInternals(['agentNodeContextWindow']);
const provider = { id: 'ds', model: 'deepseek-chat', models: [{ id: 'deepseek-chat' }] };
const manual = { contextWindowOverrides: { [JSON.stringify(['openai', 'ds', 'deepseek-chat'])]: 1000000 } };

test('the learned cap still beats a manual per-model window on an agent node', () => {
  assert.equal(agentNodeContextWindow({ engine: 'openai', model: 'deepseek-chat' }, provider, manual), 200000);
  assert.equal(agentNodeContextWindow({ engine: 'openai' }, provider, manual), 200000,
    'a node without its own model must use the provider model for the cap lookup too');
  assert.equal(agentNodeContextWindow({ engine: 'openai' }, provider, {}), 131072);
});

test('a node naming another model is not clamped by that provider/model cap', () => {
  const other = { ...provider, model: 'deepseek-flash' };
  assert.equal(agentNodeContextWindow({ engine: 'openai', model: 'deepseek-flash' }, other, {}), 1000000);
});
