'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { createRunner } = require('./lib/harness');
const { loadServerInternals } = require('./lib/server-internals');
const { setTimeout: sleep } = require('node:timers/promises');
const t = createRunner('STEWARD DECISIONS'); const { ok } = t;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-decisions-api-'));
process.env.RUYI_HOME = root; process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const s = loadServerInternals(['createSession', 'saveSession', 'writeConfig', 'readConfig', 'createMissionContainer',
  'requestNativePermission', 'requestPlanApproval', 'requestUserQuestion', 'handleInterventionApiRoutes', 'readInterventions'], { withEval: true });
(async () => {
  let server;
  try {
    await s.writeConfig({ ...(await s.readConfig()), defaultWorkspace: root, stewardEnabledV1: true, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false });
    // 只替换本件 HTTP 握手 token；路由、投影、运行时消费者和 CAS 均为生产代码。
    s.__eval("tokenOk = req => req.headers['x-wcw-token'] === 'fixture-token'");
    server = http.createServer((req, res) => s.handleInterventionApiRoutes(req, res, new URL(req.url, 'http://localhost').pathname).catch(e => { res.writeHead(500); res.end(String(e)); }));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const call = async (method, url, body) => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + url, { method,
        headers: { 'x-wcw-token': 'fixture-token', 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
      return { status: response.status, json: await response.json() };
    };
    const a = await s.createSession({ title: '同名事项', cwd: root }), b = await s.createSession({ title: '同名事项', cwd: root });
    const m = (await s.createMissionContainer({ title: '季度事项' })).mission;
    a.missionId = m.missionId; b.missionId = m.missionId; await s.saveSession(a); await s.saveSession(b);
    let idA, idB, planId;
    const permitA = s.requestNativePermission(a.id, 'powershell_run', { command: 'Write-Output fixture' }, e => { if (e.requestId) idA = e.requestId; }, 60000, 'exec');
    const permitB = s.requestNativePermission(b.id, 'powershell_run', { command: 'Write-Output fixture' }, e => { if (e.requestId) idB = e.requestId; }, 60000, 'exec');
    const planText = '计划：\n' + '完整说明\n'.repeat(160) + '结尾不能被摘要代替';
    const plan = s.requestPlanApproval(a.id, planText, e => { if (e.planId) planId = e.planId; }, 60000);
    const question = s.requestUserQuestion(b.id, 'question-source-b', [{ header: '取舍', question: '同样的问题？', options: [{ label: '甲' }, { label: '乙' }] }], () => {}, 60000);
    let data;
    for (let i = 0; i < 80; i++) { data = await call('GET', '/api/interventions?view=steward&limit=100'); if (data.json?.pending.length === 4) break; await sleep(30); }
    const items = data.json.pending;
    ok(items.length === 4 && items.every(iv => iv.missionId === m.missionId && iv.missionTitle === '季度事项'), '按现有事项身份补齐标题,两条同名任务待决均保留');
    const legacy = await call('GET', '/api/interventions?limit=100');
    ok(!('detailsText' in legacy.json.pending[0]) && legacy.json.pending[0].interventionVersion === 0, '普通投影形状保持兼容,显式版本从原日志取得');
    ok(items.find(iv => iv.id === planId).detailsText === planText && items.find(iv => iv.id === planId).detailsComplete, '计划完整原文保留摘要外内容供逐项审阅');
    const first = (await call('GET', '/api/interventions?view=steward&limit=2')).json;
    const second = (await call('GET', '/api/interventions?view=steward&limit=2&cursor=' + encodeURIComponent(first.nextCursor))).json;
    ok(first.pending.length === 2 && second.pending.length === 2 && new Set([...first.pending, ...second.pending].map(iv => iv.id)).size === 4, '分页不按文案去重或漏项');
    const decide = (sid, id, action, version = 0, key = 'fixture-' + id, extra = {}) => call('POST', '/api/missions/' + sid + '/interventions/' + id + '/decision', { expectedVersion: version, idempotencyKey: key, action, ...extra });
    const wrong = await decide(a.id, idA, 'allow', 99);
    ok(wrong.status === 409 && (await s.readInterventions(a.id)).find(iv => iv.id === idA).status === 'pending', '陈旧版本不能批准');
    ok((await decide(a.id, idB, 'allow')).status === 404, '事项归组不会把另一来源任务的待决交给错误线程');
    const denied = await decide(a.id, idA, 'deny');
    ok(denied.json.ok && denied.json.status === 'denied' && (await permitA).behavior === 'deny', '逐项拒绝送达真实消费者并写独立回执');
    ok((await decide(a.id, idA, 'allow')).status === 409, '相同请求身份不能把原来的拒绝改成允许');
    const replay = await decide(a.id, idA, 'deny');
    ok(replay.json.ok && replay.json.status === 'denied', '重复同一次决定返回原回执');
    ok((await decide(a.id, idA, 'allow', 0, 'other-entry')).status === 409, '他处已经拒绝后旧批准按钮失效');
    const q = items.find(iv => iv.type === 'question');
    const answered = await decide(b.id, q.id, 'answer', 0, 'answer-b', { answer: { answers: [{ questionId: q.questions[0].id, selectedOptionIds: [q.questions[0].options[1].id], otherText: '' }] } });
    ok(answered.json.ok && (await question).ok, '回答绑定原问题及选项身份');
    // 写 applying 之前失败:与写盘失败门相同,不向消费者放行。
    s.__eval('globalThis.decisionsOriginalAppend = appendIntervention; appendIntervention = async (sid, row) => row.id === ' + JSON.stringify(idB) + ' && row.status === "applying" ? false : globalThis.decisionsOriginalAppend(sid, row)');
    const failed = await decide(b.id, idB, 'allow');
    ok(failed.status === 503 && (await s.readInterventions(b.id)).find(iv => iv.id === idB).status === 'pending', '一项写盘失败仍待决,不冒充批准');
    s.__eval('appendIntervention = globalThis.decisionsOriginalAppend; delete globalThis.decisionsOriginalAppend');
    const rejectedPlan = await decide(a.id, planId, 'reject');
    ok(rejectedPlan.json.ok && (await plan).decision === 'reject', '另一项仍能独立拒绝,不受失败项影响');
    ok((await decide(b.id, idB, 'deny', 0, 'retry-b-deny')).json.ok && (await permitB).behavior === 'deny', '失败项恢复后仍可明确拒绝');
    const history = (await call('GET', '/api/interventions/' + a.id + '?limit=100')).json;
    ok(history.interventions.find(iv => iv.id === idA).status === 'denied' && history.interventions.find(iv => iv.id === planId).status === 'rejected', '清单消失后可从原日志核对两项各自状态');
    ok((await call('GET', '/api/interventions?view=steward')).json.pending.length === 0, '完成后清单不复活已处理待决');
  } catch (error) { t.fail(error.stack); }
  finally { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } }
  await sleep(50); t.done({ exit: true });
})();
