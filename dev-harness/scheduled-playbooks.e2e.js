'use strict';
require('./lib/self-isolate-home');
// Real HTTP/auth, scheduler clock, Playbook owner, final provider requests and
// native file tools. No real platform/network or mocked execution success.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, toolCallFrames, textFrames } = require('./lib/fake-openai-provider');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { killOwnTree } = require('./lib/kill-own-tree');
const { getFreePort } = require('./free-port');
const t = createRunner('SCHEDULED PLAYBOOKS');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-scheduled-playbooks-'));
const home = path.join(root, 'home'), work = path.join(root, 'work'), clock = path.join(root, 'clock.txt');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });
const wb = path.resolve(__dirname, '../ruyi-workbench');
let server, fake, port, token = '', diagnostic = '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tickAt = iso => fs.writeFileSync(clock, String(Date.parse(iso)));
async function wait(label, read, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await sleep(50); }
  throw new Error('timed out: ' + label + '\n' + diagnostic.slice(-3000));
}
async function request(method, route, body, auth = token) {
  try {
    const response = await fetch('http://127.0.0.1:' + port + route, { method, signal: AbortSignal.timeout(30000),
      headers: { ...(auth ? { 'x-wcw-token': auth } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  } catch (error) { return { status: 0, error: String(error) }; }
}
async function start() {
  port = await getFreePort(); diagnostic = '';
  server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: wb, windowsHide: true,
    env: { ...fixtureChildEnv(), RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home,
      WCW_SCHEDULER_CLOCK_FILE: clock, WCW_SCHEDULER_TICK_MS: '100', WCW_TEST_NO_NET_ANCHORS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-12000); });
  await wait('health', async () => (await request('GET', '/health')).status === 200);
  token = await wait('token', async () => { try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token; } catch { return ''; } });
}
async function stop() {
  if (!server) return;
  const child = server; server = null;
  if (child.exitCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    killOwnTree(child); await Promise.race([closed, sleep(5000)]);
  }
}
const runs = async id => (await request('GET', '/api/scheduler/tasks/' + id + '/runs')).body?.runs || [];
const pending = async (sid, excluded = []) => (await request('GET', '/api/interventions/' + sid)).body?.interventions?.find(row => row.type === 'permission' && row.status === 'pending' && !excluded.includes(row.id));
(async () => {
  try {
    fake = await startFakeProvider({ handler: req => {
      const last = req.messages.findLastIndex(row => row.role === 'user'), message = String(req.messages[last]?.content || '');
      if (!message.includes('SCHEDULE_HTTP')) return textFrames('No changes.');
      const tools = req.messages.slice(last + 1).filter(row => row.role === 'tool');
      const material = /Read source: ([^\r\n]+)/.exec(message)?.[1], output = /Write report: ([^\r\n]+)/.exec(message)?.[1];
      if (!tools.length) return toolCallFrames('file_read', { path: material });
      if (tools.length === 1) {
        if (!JSON.stringify(tools[0]).includes('12.50') || !JSON.stringify(tools[0]).includes('21.25')) return textFrames('Source missing or unreadable; incomplete.');
        return toolCallFrames('file_write', { path: output, content: '# Scheduled report\n33.75\nSource: new material\n' });
      }
      return textFrames('Completed the report from this run’s source.');
    } });
    fs.writeFileSync(path.join(work, 'material.txt'), '12.50\n21.25\n');
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ configSchema: 12, schedulerEnabledV1: true, stewardEnabledV1: false,
      activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'acceptEdits', defaultWorkspace: work, workspaces: [{ path: work }],
      includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false, threadBriefV1: false,
      providers: [{ id: 'fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'fixture-only', model: 'fake-model' }] }));
    tickAt('2026-10-30T08:00:00Z'); await start();
    const saved = await request('POST', '/api/playbooks', { id: 'pb_schedule_http', title: '定时核对做法',
      inputs: [{ key: 'material', label: '材料', type: 'file', required: true }, { key: 'output', label: '报告', type: 'file', required: true }],
      promptTemplate: 'SCHEDULE_HTTP\nRead source: {material}\nWrite report: {output}', requires: [] });
    const pb = saved.body?.playbook; t.ok(saved.status === 200 && /^[a-f0-9]{64}$/.test(pb?.revision), 'save through original Playbook API returns a stable content revision');
    if (!pb) throw new Error('Playbook not saved');
    const session = (await request('POST', '/api/sessions', { title: '定时目标', cwd: work })).body?.session;
    if (!session) throw new Error('target session unavailable');
    const payload = output => ({ kind: 'playbook', playbookId: pb.id, revision: pb.revision,
      values: { material: path.join(work, 'material.txt'), output: path.join(work, output) }, checks: ['Re-read this run’s source and report 33.75'] });
    const body = { title: '定时核对', schedule: { kind: 'daily', at: '09:00', tz: 'UTC' }, payload: payload('old-report.md'), target: { mode: 'existing-session', sessionId: session.id } };
    t.ok((await request('POST', '/api/scheduler/tasks/preview', body, '')).status === 403, 'preview requires header token');
    const preview = await request('POST', '/api/scheduler/tasks/preview', body);
    t.ok(preview.status === 200 && preview.body.times[0] === '2026-10-30T09:00:00.000Z' && preview.body.times.length === 5, 'pre-save preview gives exact future times in selected zone');
    t.ok((await request('GET', '/api/scheduler/tasks')).body.tasks.length === 0, 'preview never creates an occurrence or task');
    tickAt('2026-10-03T15:29:00Z');
    const halfHourBody = { ...body, schedule: { kind: 'cron', expr: '0,20,40 2 * * *', tz: 'Australia/Lord_Howe' } };
    const halfHourPreview = await request('POST', '/api/scheduler/tasks/preview', halfHourBody);
    t.ok(JSON.stringify(halfHourPreview.body?.times?.slice(0, 3)) === JSON.stringify(['2026-10-03T15:30:00.000Z', '2026-10-03T15:40:00.000Z', '2026-10-03T15:50:00.000Z']), 'R2: actual preview preserves existing 02:40 inside half-hour DST transition');
    tickAt('2026-10-03T15:35:00Z');
    const middlePreview = await request('POST', '/api/scheduler/tasks/preview', halfHourBody);
    t.ok(middlePreview.body?.times?.[0] === '2026-10-03T15:40:00.000Z', 'R2: a mid-gap cursor chooses the earliest actual epoch');
    tickAt('2026-10-30T08:00:00Z');
    t.ok((await request('POST', '/api/scheduler/tasks', { ...body, payload: { ...body.payload, revision: '0'.repeat(64) } })).status === 400, 'stale template selection is refused');
    const task = (await request('POST', '/api/scheduler/tasks', body)).body?.task;
    if (!task) throw new Error('scheduled task not created');
    const revision = pb.revision;
    await request('POST', '/api/playbooks', { ...pb, title: '未来做法', promptTemplate: pb.promptTemplate + '\nLIBRARY_EDIT' });
    tickAt('2026-10-30T09:00:01Z');
    const first = await wait('scheduled file execution', async () => (await runs(task.id)).find(row => row.outcome === 'succeeded'));
    t.ok(fs.readFileSync(path.join(work, 'old-report.md'), 'utf8').includes('33.75'), 'clock trigger uses actual file_read/file_write tools and creates this run’s result');
    t.ok(first.snapshot.payload.revision === revision && first.snapshot.target.sessionId === session.id, 'fire receipt records original full template, variables and target');
    const sent = fake.requests.find(row => row.messages.some(message => message.role === 'user' && String(message.content).includes('SCHEDULE_HTTP')));
    const finalPrompt = String(sent?.messages.findLast(row => row.role === 'user')?.content || '');
    t.ok(finalPrompt.includes('old-report.md') && finalPrompt.includes(body.payload.checks[0]) && !finalPrompt.includes('LIBRARY_EDIT'), 'actual final model prompt contains pinned revision inputs and acceptance checks');
    t.ok((await runs(task.id)).length === 1, 'the same scheduled time creates one execution');
    const changedHead = (await request('GET', '/api/sessions/' + session.id)).body?.session;
    t.ok(changedHead?.stewardLastTurn?.ok === true && changedHead.stewardLastTurn.seq === changedHead.turnSeq && changedHead.stewardLastTurn.quiet !== true, 'R3: completed changed run already has its matching committed session outcome');
    t.ok(changedHead?.stewardLastTurn?.scheduler?.state === 'settled' && changedHead.stewardLastTurn.scheduler.taskId === task.id && changedHead.stewardLastTurn.scheduler.occurrenceKey === first.occurrenceKey, 'R4: real engine result retains exact durable task/run/occurrence correlation');
    const forgedReceipt = await request('PATCH', '/api/sessions/' + session.id, { stewardLastTurn: { ...changedHead.stewardLastTurn, scheduler: { ...changedHead.stewardLastTurn.scheduler, state: 'pending' } } });
    const afterForgery = (await request('GET', '/api/sessions/' + session.id)).body?.session;
    t.ok(forgedReceipt.status === 400 && JSON.stringify(afterForgery?.stewardLastTurn) === JSON.stringify(changedHead.stewardLastTurn), 'R5: public metadata JSON cannot replace the real engine receipt');

    const quietPb = (await request('POST', '/api/playbooks', { id: 'pb_schedule_quiet', title: 'Quiet check', inputs: [], promptTemplate: 'SCHEDULE_QUIET', requires: [] })).body?.playbook;
    const quietTask = (await request('POST', '/api/scheduler/tasks', { ...body, title: 'Quiet check', enabled: false,
      payload: { kind: 'playbook', playbookId: quietPb?.id, revision: quietPb?.revision, values: {}, checks: ['Report meaningful changes only'] } })).body?.task;
    if (!quietTask) throw new Error('quiet Playbook task unavailable');
    const quietRun = await request('POST', '/api/scheduler/tasks/' + quietTask.id + '/run-now', {});
    const quietHead = (await request('GET', '/api/sessions/' + session.id)).body?.session;
    t.ok(quietRun.body?.outcome === 'succeeded' && quietHead?.stewardLastTurn?.seq === quietHead?.turnSeq && quietHead?.stewardLastTurn?.quiet === true, 'R3: no-change real model turn commits quiet before run-now responds');
    await request('DELETE', '/api/scheduler/tasks/' + quietTask.id);

    // A normal permission request belongs to the already persisted old snapshot.
    await request('PATCH', '/api/scheduler/tasks/' + task.id, { autonomy: { permissionMode: 'default' }, payload: payload('approval-old.md') });
    const run = request('POST', '/api/scheduler/tasks/' + task.id + '/run-now', {});
    const ask = await wait('real file-write permission', () => pending(session.id));
    await request('PATCH', '/api/scheduler/tasks/' + task.id, { payload: payload('approval-future.md') });
    t.ok(JSON.stringify(ask).includes('approval-old.md') && !fs.existsSync(path.join(work, 'approval-old.md')), 'permission pending item is bound to old output before any write');
    await request('POST', '/api/permission/decision', { requestId: ask.id, behavior: 'allow' });
    const permitted = await run;
    t.ok(permitted.status === 200 && fs.existsSync(path.join(work, 'approval-old.md')) && !fs.existsSync(path.join(work, 'approval-future.md')), 'editing during approval cannot redirect the authorized old operation');
    const nextRun = request('POST', '/api/scheduler/tasks/' + task.id + '/run-now', {});
    const nextAsk = await wait('future permission is fresh', () => pending(session.id, [ask.id]));
    t.ok(nextAsk.id !== ask.id && JSON.stringify(nextAsk).includes('approval-future.md'), 'template approval never grants future changed operations');
    await request('PATCH', '/api/scheduler/tasks/' + task.id, { autonomy: { permissionMode: 'plan' } });
    const staleTaskApproval = await request('POST', '/api/permission/decision', { requestId: nextAsk.id, behavior: 'allow' });
    const taskRevoked = await nextRun;
    t.ok([404, 409].includes(staleTaskApproval.status) && taskRevoked.body?.outcome !== 'succeeded' && !fs.existsSync(path.join(work, 'approval-future.md')), 'R1: task revocation retires a pending old authorization; late allow cannot write');
    await request('PATCH', '/api/scheduler/tasks/' + task.id, { autonomy: { permissionMode: 'default' }, payload: payload('global-revoked.md') });
    const globalRun = request('POST', '/api/scheduler/tasks/' + task.id + '/run-now', {});
    const globalAsk = await wait('global revocation pending item', () => pending(session.id, [ask.id, nextAsk.id]));
    await request('POST', '/api/config', { permissionMode: 'plan' });
    const staleGlobalApproval = await request('POST', '/api/permission/decision', { requestId: globalAsk.id, behavior: 'allow' });
    const globalRevoked = await globalRun;
    t.ok([404, 409].includes(staleGlobalApproval.status) && globalRevoked.body?.outcome !== 'succeeded' && !fs.existsSync(path.join(work, 'global-revoked.md')), 'R1: global revocation also rejects a late approval before the actual file tool');
    await request('POST', '/api/config', { permissionMode: 'acceptEdits' });
    await request('PATCH', '/api/scheduler/tasks/' + task.id, { payload: payload('restart-future.md') });
    const interruptedRun = request('POST', '/api/scheduler/tasks/' + task.id + '/run-now', {});
    await wait('restart permission pending', () => pending(session.id, [ask.id, nextAsk.id, globalAsk.id]));
    const countBeforeRestart = fake.requests.filter(row => row.messages.some(message => message.role === 'user' && String(message.content).includes('SCHEDULE_HTTP'))).length;
    await stop(); await interruptedRun;
    await start();
    const unknownRun = await wait('unknown recovery', async () => (await runs(task.id)).find(row => row.outcome === 'unknown'));
    const unknownHead = (await request('GET', '/api/sessions/' + session.id)).body?.session;
    t.ok(unknownHead?.stewardLastTurn?.scheduler?.state === 'unknown' && unknownHead.stewardLastTurn.scheduler.runId === unknownRun.runId && unknownHead.stewardLastTurn.seq === unknownRun.turnSeq, 'R4: cold unknown receipt and exact session turn retain the same uncertainty authority');
    t.ok(!fs.existsSync(path.join(work, 'restart-future.md')), 'restart leaves interrupted operation unknown and does not write output');
    const countAfterRestart = fake.requests.filter(row => row.messages.some(message => message.role === 'user' && String(message.content).includes('SCHEDULE_HTTP'))).length;
    t.ok(countAfterRestart === countBeforeRestart, 'unknown occurrence is not automatically replayed through the model');
    await request('PATCH', '/api/scheduler/tasks/' + task.id, { enabled: false });
    tickAt('2026-11-01T12:00:00Z');
    await request('PATCH', '/api/scheduler/tasks/' + task.id, { enabled: true });
    const resumed = (await request('GET', '/api/scheduler/tasks')).body.tasks.find(row => row.id === task.id);
    t.ok(resumed.nextRunAt === '2026-11-02T09:00:00.000Z', 'resume skips paused dates and computes next wall-clock occurrence');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally {
    await stop(); if (fake) await fake.close();
    if (t.failures === 0) { const resolved = path.resolve(root); if (path.dirname(resolved) !== path.resolve(os.tmpdir())) throw Error('fixture cleanup escaped temp'); fs.rmSync(resolved, { recursive: true, force: true }); }
    else console.log('fixture retained: ' + root);
    t.done({ exit: true });
  }
})();
