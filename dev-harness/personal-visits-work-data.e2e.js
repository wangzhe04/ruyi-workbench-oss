'use strict';
require('./lib/self-isolate-home');
// Real lifecycle + Windows DPAPI, isolated synthetic data, no model invocation or network traffic.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const t = createRunner('PERSONAL VISITS WORK DATA');
const temp = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(temp, 'ruyi-personal-visits-e2e-'));
Object.assign(process.env, require('./lib/release-checks').releaseEnvironment(path.join(root, 'home'), path.join(root, 'data')));
const api = require('./lib/server-internals').loadServerInternals([
  'saveAgentWorkflow', 'getAgentWorkflows', 'readPersonalAgentWorkflows', 'deleteAgentWorkflow',
  'stewardArchiveConversation', 'stewardVisitStore', 'stewardVisitsDir', 'stewardVisitFileName',
  'saveSession', 'loadSession', 'mutateSession', 'SESSION_SCHEMA', 'STEWARD_SESSION_ID',
  'readConfig', 'writeConfig', 'workDataKeys', 'paths',
]);
const privateError = error => String(error && error.code || '').startsWith('work_data');
const setSwitch = async flag => { const config = await api.readConfig(); config.workDataEncryptionV1 = flag; await api.writeConfig(config); };
const workflow = { id: 'private_flow', title: '切换前的工作流', nodes: Array.from({ length: 40 }, (_v, i) => ({ id: 'n' + i, task: '保密工作步骤'.repeat(3000) })) };
const startedAt = '2026-10-22T02:00:00.000Z';
const sessionFiles = () => Object.fromEntries(fs.readdirSync(api.paths.sessions).filter(name => name.startsWith(api.STEWARD_SESSION_ID)
  && fs.statSync(path.join(api.paths.sessions, name)).isFile()).map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(api.paths.sessions, name))).digest('hex')]));

(async () => {
  await setSwitch(false);
  const saved = await api.saveAgentWorkflow('personal', root, workflow);
  const personalFile = path.join(api.paths.agentWorkflows, workflow.id + '.json');
  t.ok(fs.readFileSync(personalFile, 'utf8') === JSON.stringify(saved, null, 2), 'OFF keeps the original personal pretty JSON');
  t.ok(Buffer.byteLength(JSON.stringify(saved)) > 1024 * 1024, 'fixture exercises a personal workflow above the old single-envelope limit');
  const now = new Date().toISOString();
  const live = { id: api.STEWARD_SESSION_ID, schemaVersion: api.SESSION_SCHEMA, turnSeq: 0, title: '管家归档测试', summary: '', pinned: false,
    cwd: api.paths.data, createdAt: now, updatedAt: now, claudeSessionId: null, providerHistory: [], providerHistoryCursor: 0,
    attachments: [], engineRoute: { engine: 'claude', agentCliType: 'claude' }, mission: null, missionId: api.STEWARD_SESSION_ID, kind: 'steward',
    messages: [{ role: 'user', content: '归档原文甲'.repeat(40000), createdAt: '2026-10-22T01:00:00.000Z' },
      { role: 'assistant', content: '归档原文乙'.repeat(40000), createdAt: '2026-10-22T01:01:00.000Z' }] };
  await api.saveSession(live);
  if (process.platform !== 'win32') {
    console.log('SKIP real DPAPI sealing: Windows only; synthetic crypto/domain coverage is in the unit suite');
    return;
  }
  await setSwitch(true); await api.workDataKeys.ensure();
  await api.saveAgentWorkflow('personal', root, { ...workflow, title: '切换后继续编辑' });
  const personalBytes = fs.readFileSync(personalFile, 'utf8');
  t.ok(JSON.parse(personalBytes.split('\n')[0]).workData === 3 && !personalBytes.includes('保密工作步骤'), 'resuming the existing workflow seals the complete large record');
  t.ok((await api.getAgentWorkflows(root)).find(row => row.id === workflow.id)?.title === '切换后继续编辑', 'normal workflow listing restores the actual personal override');
  const visit = await api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt);
  const visitFile = path.join(api.stewardVisitsDir(), visit.file), visitBytes = fs.readFileSync(visitFile, 'utf8');
  t.ok(visit.archived === 2 && JSON.parse(visitBytes.split('\n')[0]).workData === 3 && !visitBytes.includes('归档原文甲'), 'visit persists a sealed large archive before truncating live');
  const opened = JSON.parse(await api.stewardVisitStore(visitFile).read());
  t.ok(opened.messages.length === 2 && (await api.loadSession(api.STEWARD_SESSION_ID)).messages.length === 0, 'the archive retains the exact turns removed from live');
  await api.mutateSession(api.STEWARD_SESSION_ID, fresh => { fresh.messages.push({ role: 'user', content: '旧档坏了也不能丢的新消息', createdAt: now }); });
  const beforeLive = JSON.stringify((await api.loadSession(api.STEWARD_SESSION_ID)).messages);
  fs.writeFileSync(visitFile, visitBytes.slice(0, -30));
  await assert.rejects(() => api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt), privateError);
  t.ok(JSON.stringify((await api.loadSession(api.STEWARD_SESSION_ID)).messages) === beforeLive
    && fs.readFileSync(visitFile, 'utf8') === visitBytes.slice(0, -30), 'unreadable existing archive refuses overwrite and leaves live turns intact');
  fs.writeFileSync(visitFile, visitBytes);
  const collision = await api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt);
  t.ok(collision.archived === 1 && collision.file !== visit.file && fs.readFileSync(visitFile, 'utf8') === visitBytes
    && (await api.loadSession(api.STEWARD_SESSION_ID)).messages.length === 0, 'a valid existing archive remains unchanged while a new unique archive receives the next turns');
  await api.mutateSession(api.STEWARD_SESSION_ID, fresh => { fresh.messages.push({ role: 'user', content: '供重置归档的新消息', createdAt: now }); });
  const reset = await api.stewardArchiveConversation({}, startedAt, { reset: true });
  const resetData = JSON.parse(await api.stewardVisitStore(path.join(api.stewardVisitsDir(), reset.file)).read());
  t.ok(reset.archived === 1 && Object.hasOwn(resetData, 'sessionNotes')
    && (await api.loadSession(api.STEWARD_SESSION_ID)).messages.length === 0, 'reset also seals its archive and session notes before clearing live');
  const keyFile = path.join(api.paths.data, 'work-data-key-v1.json'), beforeFiles = sessionFiles();
  api.workDataKeys.clear(); fs.renameSync(keyFile, keyFile + '.bak');
  try {
    await assert.rejects(() => api.readPersonalAgentWorkflows(), privateError);
    await assert.rejects(() => api.saveAgentWorkflow('personal', root, workflow), privateError);
    await assert.rejects(() => api.stewardArchiveConversation({ stewardConversationRetention: 'visit' }, startedAt), privateError);
    t.ok(fs.readFileSync(personalFile, 'utf8') === personalBytes && JSON.stringify(sessionFiles()) === JSON.stringify(beforeFiles), 'missing keys never manufacture an empty personal layer or rewrite live sessions');
  } finally { fs.renameSync(keyFile + '.bak', keyFile); }
  await setSwitch(false);
  await assert.rejects(() => api.saveAgentWorkflow('personal', root, workflow), { code: 'work_data_store.downgrade_refused' });
  t.ok(fs.readFileSync(personalFile, 'utf8') === personalBytes, 'turning the switch back off does not downgrade existing sealed workflows');
})().catch(error => { t.fail(error && error.stack || String(error)); }).finally(() => {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('ruyi-personal-visits-e2e-')) throw new Error('unexpected fixture directory');
  fs.rmSync(resolved, { recursive: true, force: true });
  t.done();
});
