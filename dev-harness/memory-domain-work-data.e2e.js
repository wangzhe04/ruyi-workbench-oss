'use strict';
require('./lib/self-isolate-home');
// Real memory-maintenance functions + Windows DPAPI. Resume a pre-existing pending proposal after
// enabling storage encryption; confirmation must seal both the proposal state and relation array.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const t = createRunner('MEMORY DOMAIN WORK DATA');
const { ok } = t;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-memory-domain-e2e-'));
process.env.RUYI_HOME = dataDir;
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataDir;
const api = require('./lib/server-internals').loadServerInternals([
  'saveMemory', 'proposeMemoryRelationTool', 'applyMemoryRelationProposal', 'listMemoryRelations',
  'readMemoryProposalState', 'memoryProposalStateFile', 'memoryRelationsFile',
  'readConfig', 'writeConfig', 'workDataKeys',
]);
const cwd = path.join(dataDir, 'project');
const sid = 'session_preexisting';
const setSwitch = async enabled => {
  const config = await api.readConfig(); config.workDataEncryptionV1 = enabled;
  await api.writeConfig(config);
};

(async () => {
  await setSwitch(false);
  const a = await api.saveMemory({ scope: 'project', name: '甲', body: '甲的记忆正文' }, cwd);
  const b = await api.saveMemory({ scope: 'project', name: '乙', body: '乙的记忆正文' }, cwd);
  ok(a.ok && b.ok, 'fixture memory bodies exist');
  const ctx = { sessionId: sid, session: { id: sid, cwd, turnSeq: 1, messages: [] }, turnSeq: 1, workingDir: cwd, config: null };
  const proposed = await api.proposeMemoryRelationTool({ scope: 'project', type: 'supports', from: a.memory.id, to: b.memory.id, note: '确认后封印的关系说明', reason: '测试旧候选继续确认' }, ctx);
  ok(proposed.ok && proposed.pendingUserConfirmation, 'existing session has a pending proposal');
  const proposalFile = api.memoryProposalStateFile(sid);
  const legacy = fs.readFileSync(proposalFile, 'utf8');
  ok(!legacy.includes('"workData"') && legacy === JSON.stringify(JSON.parse(legacy), null, 2), 'disabled writes retain legacy pretty JSON bytes');
  if (process.platform !== 'win32') {
    console.log('SKIP real DPAPI sealing: Windows only; cross-platform crypto coverage is in the unit suite');
    return;
  }
  await setSwitch(true);
  await api.workDataKeys.ensure();
  const accepted = await api.applyMemoryRelationProposal(sid, proposed.proposalId, cwd);
  ok(accepted.ok, 'resume and confirm legacy proposal after enabling encryption');
  const relationFile = api.memoryRelationsFile('project', cwd);
  const proposalText = fs.readFileSync(proposalFile, 'utf8'), relationText = fs.readFileSync(relationFile, 'utf8');
  ok(JSON.parse(proposalText).workData === 2 && JSON.parse(relationText).workData === 2, 'confirmation seals both domain families');
  ok(!proposalText.includes('确认后封印') && !relationText.includes('确认后封印'), 'relation explanation is absent from both ciphertext files');
  const graph = await api.listMemoryRelations(cwd, 'project');
  ok(graph.confirmed.length === 1 && graph.confirmed[0].from === a.memory.id, 'sealed relation remains available to normal graph readers');
  const state = await api.readMemoryProposalState(sid);
  ok(state.current && state.current.status === 'saved', 'sealed proposal retains saved status');
  await setSwitch(false);
  const blockedCtx = { ...ctx, session: { ...ctx.session, turnSeq: 2 }, turnSeq: 2 };
  await assert.rejects(() => api.proposeMemoryRelationTool({ scope: 'project', type: 'contradicts', from: a.memory.id, to: b.memory.id }, blockedCtx), error => String(error.code).startsWith('work_data'));
  ok(fs.readFileSync(proposalFile, 'utf8') === proposalText && fs.readFileSync(relationFile, 'utf8') === relationText, 'disabled switch refuses downgrading existing sealed files');
  await setSwitch(true);
  const keyFile = path.join(dataDir, 'work-data-key-v1.json');
  api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.bak');
  try {
    await assert.rejects(() => api.listMemoryRelations(cwd, 'project'), error => String(error.code).startsWith('work_data'));
    await assert.rejects(() => api.proposeMemoryRelationTool({ scope: 'project', type: 'contradicts', from: a.memory.id, to: b.memory.id }, blockedCtx), error => String(error.code).startsWith('work_data'));
    ok(fs.readFileSync(proposalFile, 'utf8') === proposalText && fs.readFileSync(relationFile, 'utf8') === relationText, 'missing DPAPI key fails closed and leaves both sealed files untouched');
  } finally { fs.renameSync(keyFile + '.bak', keyFile); }
  const truncatedProposal = proposalText.slice(0, -20);
  fs.writeFileSync(proposalFile, truncatedProposal);
  await assert.rejects(() => api.proposeMemoryRelationTool({ scope: 'project', type: 'contradicts', from: a.memory.id, to: b.memory.id }, blockedCtx), { code: 'work_data_store.corrupt' });
  ok(fs.readFileSync(proposalFile, 'utf8') === truncatedProposal && fs.readFileSync(relationFile, 'utf8') === relationText, 'truncated proposal is refused without overwriting either file');
  fs.writeFileSync(proposalFile, proposalText);
  const truncatedRelations = relationText.slice(0, -20);
  fs.writeFileSync(relationFile, truncatedRelations);
  await assert.rejects(() => api.listMemoryRelations(cwd, 'project'), { code: 'work_data_store.corrupt' });
  ok(fs.readFileSync(relationFile, 'utf8') === truncatedRelations, 'truncated relation ciphertext is an error and remains untouched');
})().catch(error => { t.fail(error && error.stack || String(error)); }).finally(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  t.done();
});
