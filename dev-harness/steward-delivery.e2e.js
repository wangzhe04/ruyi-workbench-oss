'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const t = createRunner('STEWARD DELIVERY'); const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-delivery-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
const s = loadServerInternals(['createSession', 'saveSession', 'loadSession', 'writeConfig', 'readConfig', 'normalizeMission', 'recordMissionCheckResult',
  'stewardCaptureDelivery', 'stewardDeliveryProjection', 'stewardValidateDeliveryReference', 'stewardRunAct', 'stewardLaunchingTurns', 'runSessionTurn', 'createMissionContainer', 'turnSettlers']);
const ref = d => ({ turnSeq: d.turnSeq, latestTurnSeq: d.latestTurnSeq, sourceStamp: d.sourceStamp, fileStamp: d.fileStamp });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  let fake;
  try {
    fake = await startFakeProvider({ handler: req => textFrames('只修改了第二部分,已重新核对。') });
    const work = path.join(root, 'work'); fs.mkdirSync(work, { recursive: true });
    const cfg = { ...(await s.readConfig()), defaultWorkspace: work, workspaces: [{ path: work, name: '报告' }], permissionMode: 'auto',
      activeProvider: 'fake', includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, stewardEnabledV1: true,
      providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }] };
    await s.writeConfig(cfg);
    const session = await s.createSession({ title: '原报告', cwd: work });
    const a = path.join(work, 'a', 'report.md'), b = path.join(work, 'b', 'report.md');
    fs.mkdirSync(path.dirname(a)); fs.mkdirSync(path.dirname(b));
    fs.writeFileSync(a, '# 第一份\n## 第二部分\n旧内容'); fs.writeFileSync(b, '# 同名另一份');
    session.turnSeq = 1;
    session.mission = s.normalizeMission({ goal: '报告', milestones: [
      { id: 'machine', desc: '文件已生成', status: 'done', check: { type: 'file_exists', path: a } },
      { id: 'self', desc: '模型认为内容完整', status: 'done' },
      { id: 'unfinished', desc: '待补充引用', status: 'pending' },
      { id: 'failed', desc: '引用检查', status: 'blocked', check: { type: 'file_exists', path: a } },
    ] }, null);
    s.recordMissionCheckResult(session.mission.milestones[0], { pass: true, detail: '文件存在' });
    s.recordMissionCheckResult(session.mission.milestones[3], { pass: false, detail: '缺少引用' });
    const summary = { turnSeq: 1, artifacts: [{ path: a }, { path: b }], filesChanged: [], commands: 0 };
    session.messages = [{ role: 'user', content: '生成报告', turnSeq: 1, createdAt: new Date(Date.now() - 2000).toISOString() }];
    await s.stewardCaptureDelivery(session, summary, { startedAt: Date.now() - 1500 });
    session.messages.push({ role: 'assistant', content: '报告已生成,第二部分仍待补充引用。', turnSeq: 1, turnSummary: summary, createdAt: new Date().toISOString() });
    await s.saveSession(session);
    let d = await s.stewardDeliveryProjection(session.id, 1, cfg);
    ok(d.ok && d.files.length === 2 && d.files.every(file => file.status === 'same'), '文件指纹随既有回合摘要保存,投影准确找到本轮两份同名文件');
    ok(d.files[0].path !== d.files[1].path && d.files[0].name === d.files[1].name, '同名文件保留完整路径身份');
    ok(d.checks.find(row => row.id === 'machine').provenance === 'machine' && d.checks.find(row => row.id === 'machine').applicable, '本轮真实检查通过有明确来源和适用范围');
    ok(d.checks.find(row => row.id === 'self').provenance === 'self' && d.checks.find(row => row.id === 'failed').checkState === 'fail' && d.unfinished.length === 2, '模型自报、检查失败和未完成项分别保留');
    ok((await s.stewardValidateDeliveryReference(session.id, ref(d), cfg)).ok, '修订来源可以核对');
    const original = d;
    fs.writeFileSync(a, '外部改动');
    d = await s.stewardDeliveryProjection(session.id, 1, cfg);
    ok(d.files[0].status === 'changed' && d.checks.every(row => !row.applicable), '文件外部修改后旧检查不再验证当前版本');
    ok(!(await s.stewardValidateDeliveryReference(session.id, ref(original), cfg)).ok, '草稿形成后文件变化会拒绝发送');
    fs.unlinkSync(b);
    d = await s.stewardDeliveryProjection(session.id, 1, cfg);
    ok(d.files[1].status === 'missing', '缺文件不会被显示为可打开或已验证');
    fs.writeFileSync(b, '# 同名另一份');
    const missing = await s.stewardDeliveryProjection(session.id, 999, cfg);
    ok(!missing.ok && missing.error === 'delivery_not_found', '缺失的回合不退回最新交付');
    const old = await s.createSession({ title: '旧报告', cwd: work });
    old.turnSeq = 1; old.messages = [{ role: 'assistant', turnSeq: 1, content: '旧结果', turnSummary: { turnSeq: 1, artifacts: [{ path: a }] } }];
    old.mission = session.mission; await s.saveSession(old);
    const legacy = await s.stewardDeliveryProjection(old.id, 1, cfg);
    ok(!legacy.evidenceRecorded && legacy.files[0].status === 'unverified' && legacy.checks.length === 0, '历史没有快照时不借当前检查冒充本轮证据');
    old.messages[0].turnSummary.deliveryEvidence = JSON.parse(JSON.stringify(summary.deliveryEvidence));
    old.messages[0].meta = { imported: true }; await s.saveSession(old);
    ok(!(await s.stewardDeliveryProjection(old.id, 1, cfg)).evidenceRecorded, '导入回合不能携带本机检查通过凭据');
    const human = await s.createSession({ title: '人工复核', cwd: work });
    const at = new Date().toISOString();
    const container = await s.createMissionContainer({ title: '验收事项', acceptance: [{ id: 'human', text: '用户已复核', done: true, doneAt: at }] });
    human.missionId = container.mission.missionId;
    human.mission = s.normalizeMission({ milestones: [{ id: 'human', desc: '用户已复核', status: 'done', check: { type: 'file_exists', path: a } }] }, null);
    s.recordMissionCheckResult(human.mission.milestones[0], { pass: false, detail: '以前的机器检查' });
    human.mission.milestones[0].lastCheck.at = new Date(Date.now() - 60000).toISOString();
    const humanSummary = { artifacts: [], filesChanged: [] };
    await s.stewardCaptureDelivery(human, humanSummary, { startedAt: Date.now() - 1000 });
    ok(humanSummary.deliveryEvidence.checks[0].provenance === 'human' && humanSummary.deliveryEvidence.checks[0].currentTurn && humanSummary.deliveryEvidence.checks[0].checkedAt === at, '人工确认取本人勾选时间,不借以前机器检查的时间');
    const large = path.join(work, 'large.bin'); fs.writeFileSync(large, Buffer.alloc(8 * 1024 * 1024 + 1));
    const bounded = { artifacts: [{ path: large }, { path: path.join(process.env.RUYI_HOME, 'config.json') }, ...Array.from({ length: 22 }, (_, i) => ({ path: path.join(work, 'missing-' + i) }))] };
    await s.stewardCaptureDelivery(old, bounded);
    ok(bounded.deliveryEvidence.files.length === 20 && bounded.deliveryEvidence.filesTruncated && bounded.deliveryEvidence.files[0].status === 'unverified', '文件数量和单文件读取有界,超限不颁发指纹');
    ok(bounded.deliveryEvidence.files[1].status === 'blocked', '交付引用不能借预览读取工作台内部敏感文件');
    await s.writeConfig({ ...cfg, stewardEnabledV1: false });
    const disabled = { artifacts: [{ path: a }] }; await s.stewardCaptureDelivery(old, disabled);
    ok(!disabled.deliveryEvidence, '关闭管家时不增加交付文件读取');
    await s.writeConfig(cfg);
    const delivered = await s.stewardDeliveryProjection(session.id, 1, cfg);
    const message = '只改第二部分';
    const act = { kind: 'tool', tool: 'steward_thread_continue', args: { sessionId: session.id, message, deliverySource: ref(delivered) } };
    const result = await s.stewardRunAct(act, cfg, { attemptId: 'delivery-revision-0001' });
    ok(result.executed && result.result.channel === 'turn', '修订复用原任务和既有递话回合');
    for (let i = 0; i < 200 && s.stewardLaunchingTurns.has(session.id); i++) await sleep(25);
    const revised = await s.loadSession(session.id);
    const user = revised.messages.filter(row => row.role === 'user').at(-1);
    ok(user.content === message && user.meta.revisionOf.turnSeq === 1 && user.meta.revisionOf.sessionId === session.id, '原话逐字保存,修订关系作为元数据持久化');
    ok(fake.requests.some(req => req.messages.some(row => String(row.content).includes('交付修订来源') && String(row.content).includes(JSON.stringify(user.meta.revisionOf.files)))), '来源回合及文件引用真实送达执行模型');
    const replay = await s.stewardRunAct(act, cfg, { attemptId: 'delivery-revision-0001' });
    ok(replay.replayed && (await s.loadSession(session.id)).messages.filter(row => row.role === 'user').length === 2, '重复递送同一修订不会创建第二回合');
    const stale = await s.stewardValidateDeliveryReference(session.id, ref(delivered), cfg);
    ok(!stale.ok && stale.error === 'delivery_changed', '任务已进入新回合时旧修订请求会被拒绝');
    const historical = await s.stewardDeliveryProjection(session.id, 1, cfg);
    ok(historical.outdated && historical.checks.every(row => !row.applicable), '刷新后旧交付仍可查,不代表后续要求已完成');
    const current = await s.stewardDeliveryProjection(session.id, 2, cfg);
    ok(current.evidenceRecorded && current.files.length === 0 && current.checks.filter(row => row.checkState === 'pass').every(row => !row.applicable), '新回合没有新检查时不会继承旧通过章');
    revised.messages = revised.messages.filter(row => Number(row.turnSeq) !== 1); await s.saveSession(revised);
    ok(!(await s.stewardDeliveryProjection(session.id, 1, cfg)).ok, '撤回删除来源回合后不再展示该交付');
    let errorCode = '';
    try { await s.runSessionTurn({ sessionId: old.id, source: 'steward', message: '不能覆盖新要求', expectedTurnSeq: 99 }); } catch (error) { errorCode = error.code; }
    ok(errorCode === 'DELIVERY_CHANGED', '回合启动单点也校验期望版本,覆盖校验之后的竞态窗口');
    const busyRef = ref(await s.stewardDeliveryProjection(old.id, 1, cfg));
    s.turnSettlers.set(old.id, { source: 'steward' });
    try {
      let busyError = '';
      try { await s.runSessionTurn({ sessionId: old.id, source: 'steward', message: '修订不能顶掉另一轮', expectedDelivery: busyRef }); } catch (error) { busyError = error.code; }
      ok(busyError === 'SESSION_TURN_BUSY_ELSEWHERE', '修订校验期间同源管家启动了另一轮时,驱动器也拒绝顶替');
    } finally { s.turnSettlers.delete(old.id); }
  } catch (error) { t.fail(error.stack); }
  finally { if (fake) await fake.close(); }
  await sleep(50);
  t.done({ exit: true });
})();
