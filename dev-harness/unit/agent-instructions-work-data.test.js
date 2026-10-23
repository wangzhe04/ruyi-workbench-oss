'use strict';
// M3-2d batch 4: agent-instructions-import (the ownership sidecar for imported sub-agent instructions).
// It is the mechanical DurableJsonStore -> createJson swap, so the test pins the three properties that
// make the swap safe: legacy bytes when off, sealed + readable when on, and no empty overwrite.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-wdagentmd-'));
process.env.RUYI_HOME = HOME_DIR;
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME_DIR;

const { loadServerInternals } = require('../lib/server-internals');
const api = loadServerInternals(['readAgentInstructionState', 'writeAgentInstructionState', 'workDataKeys', 'readConfig', 'writeConfig']);
const file = path.join(HOME_DIR, 'memory', '.agent-instructions-import-v1.json');
const setSwitch = async on => { const config = await api.readConfig(); config.workDataEncryptionV1 = on === true; await api.writeConfig(config); };
const state = { sources: { 'claude-md': { file: 'C:/work/CLAUDE.md', sourceHash: 'abc', importedAt: '2026-10-23T00:00:00.000Z', entries: [{ id: 'agentmd-claude-md-1', hash: 'h1', core: true }] } } };
const keyFile = path.join(HOME_DIR, 'work-data-key-v1.json');

if (process.platform !== 'win32') {
  test('agent instruction import sealing needs DPAPI', { skip: 'Windows DPAPI only' }, () => {});
} else {
  test('switch off: the sidecar keeps the legacy pretty JSON bytes', async () => {
    await setSwitch(false);
    await api.writeAgentInstructionState(state);
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes('"workData"'), false);
    assert.equal(text, JSON.stringify(JSON.parse(text), null, 2));
    const parsed = JSON.parse(text);
    assert.equal(parsed.schema, 1);
    assert.equal(parsed.sources['claude-md'].entries[0].id, 'agentmd-claude-md-1');
    assert.equal((await api.readAgentInstructionState()).sources['claude-md'].sourceHash, 'abc');
  });

  test('switch on: the sidecar is sealed and still round-trips', async () => {
    await setSwitch(true);
    await api.workDataKeys.ensure();
    await api.writeAgentInstructionState({ sources: { ...state.sources, 'kimi-agents': { file: 'C:/work/AGENTS.md', sourceHash: 'def' } } });
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(JSON.parse(text).workData, 2);
    assert.equal(text.includes('CLAUDE.md'), false, 'source paths must not stay readable');
    const back = await api.readAgentInstructionState();
    assert.equal(back.sources['claude-md'].sourceHash, 'abc');
    assert.equal(back.sources['kimi-agents'].sourceHash, 'def');
  });

  test('a missing key is an error and never rewrites the sealed sidecar', async () => {
    const before = fs.readFileSync(file, 'utf8');
    api.workDataKeys.clear();
    fs.renameSync(keyFile, keyFile + '.bak');
    try {
      await assert.rejects(() => api.readAgentInstructionState(), error => String(error.code).startsWith('work_data'));
      await assert.rejects(() => api.writeAgentInstructionState({ sources: {} }), error => String(error.code).startsWith('work_data'));
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'the sealed sidecar is byte-identical afterwards');
    } finally { fs.renameSync(keyFile + '.bak', keyFile); }
  });
}
