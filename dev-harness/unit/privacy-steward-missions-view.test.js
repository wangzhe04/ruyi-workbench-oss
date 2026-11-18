'use strict';
// 150 号文 §4 P8:steward_missions 的结果与其他管家视图同口径投影外线程代号(foreignView),
// 不再因为别的线程标题/摘要里的代号被网关整份扣成 privacy.tool_result_withheld。
// Real generated server functions and PrivacyGateway; mission rows and session metadata are synthetic stubs.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-steward-missions-view-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['PrivacyGateway', 'PrivacyCore', 'stewardImplMissions', 'buildMissionAggregateRows'], { withEval: true });
const f = require('../lib/privacy-test-fixture').fixture();
app.PrivacyCore.configHooks.sealLocal = f.vault.sealLocal; app.PrivacyCore.configHooks.openLocal = f.vault.openLocal;
after(() => { f.vault.clear(); if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('ruyi-steward-missions-view-')) throw Error('cleanup scope'); fs.rmSync(root, { recursive: true, force: true }); });
const foreign = '[[RUYI_PVT:EMAIL:' + 'c'.repeat(32) + ']]';
const policy = mode => ({ privacyModeV1: mode, privacyRulesV1: [], privacyTechnicalV1: false, providers: [] });
const PLACEHOLDER = '[其他线程的隐私内容已省略]';

test('thread summaries in mission rows are projected before their 120-character clip', async () => {
  app.__eval(`(() => {
    getPretenderProjectionIndex = async () => ({ sessions: [] });
    listMissionContainers = async () => [];
    listSessions = async () => [{ id: 'sess_foreign_summary', kind: 'quick_ask', title: '给 ' + ${JSON.stringify(foreign)} + ' 回信',
      summary: 'x'.repeat(100) + ${JSON.stringify(foreign)}, updatedAt: '2026-11-18T00:00:00.000Z', cwd: '' }];
  })()`);
  app.PrivacyGateway.configure(policy('basic'));
  const aggregate = await app.buildMissionAggregateRows({ config: policy('basic') });
  const said = aggregate.rows[0].threads[0].lastAssistantText;
  assert.equal(said.includes('RUYI_PVT'), false, 'no clipped reference fragment survives: ' + said);
  assert.ok(said.startsWith('x'.repeat(100) + PLACEHOLDER.slice(0, 5)));
});

test('steward_missions output reaches the steward model instead of being withheld', async () => {
  app.__eval(`buildMissionAggregateRows = async () => ({ rows: [{ missionId: 'mission_foreign', title: '整理 ' + ${JSON.stringify(foreign)} + ' 的邮件',
    goal: '回复 ' + ${JSON.stringify(foreign)}, aggregateState: 'running', derived: false, workspace: null, budget: {}, cost: {},
    acceptance: { done: 0, total: 1, items: [{ id: 'a1', text: '确认 ' + ${JSON.stringify(foreign)}, done: false }] },
    threads: [{ sessionId: 'sess_foreign', title: '给 ' + ${JSON.stringify(foreign)} + ' 回信', state: 'running', stateLabel: '进行中', cwd: '',
      permissionMode: null, lastAssistantText: '已写好草稿 ' + ${JSON.stringify(foreign)}, brief: { gist: '联系 ' + ${JSON.stringify(foreign)} }, wait: null }] }] })`);
  app.PrivacyGateway.configure(policy('basic'));
  await app.PrivacyGateway.withPolicy('steward', async () => {
    const result = await app.stewardImplMissions({}, {}, policy('basic'));
    const sent = await app.PrivacyGateway.modelToolResult(result);
    assert.notEqual(sent.code, 'privacy.tool_result_withheld', 'mission view is not withheld');
    assert.equal(sent.ok, true); assert.equal(sent.missions.length, 1);
    const text = JSON.stringify(sent);
    assert.equal(text.includes('RUYI_PVT'), false);
    assert.ok(sent.missions[0].title.includes(PLACEHOLDER) && sent.missions[0].threads[0].lastAssistantText.includes(PLACEHOLDER));
    assert.equal(sent.missions[0].threads[0].sessionId, 'sess_foreign');
  });
  // OFF keeps the exact rows (foreignView is a no-op without privacy).
  app.PrivacyGateway.configure(policy('off'));
  const plain = await app.stewardImplMissions({}, {}, policy('off'));
  assert.ok(plain.missions[0].threads[0].title.includes(foreign));
});
