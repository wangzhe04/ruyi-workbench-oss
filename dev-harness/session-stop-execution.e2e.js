'use strict';
require('./lib/self-isolate-home');
// Real isolated HTTP service + production relay/rewind + scripted provider. No real model or browser.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { fixtureChildEnv } = require('./lib/fixture-home');
const { getFreePort } = require('./free-port');
const { killOwnTree } = require('./lib/kill-own-tree');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const runner = createRunner('SESSION STOP EXECUTION');
const { ok } = runner;
const WB = path.resolve(__dirname, '../ruyi-workbench');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const isolated = fixtureChildEnv({ perTest: true });
  const home = isolated.home;
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  let fake, server, port, token = '';
  const started = new Set();
  const request = async (method, route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { 'x-wcw-token': token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, json: await response.json() };
  };
  const until = async (fn, description) => {
    for (let i = 0; i < 200; i++) {
      const value = await fn();
      if (value) return value;
      await sleep(40);
    }
    throw new Error('timeout: ' + description);
  };
  const start = async () => {
    token = '';
    server = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
      cwd: WB, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ...isolated.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home },
    });
    await until(async () => { try { return (await request('GET', '/health')).status === 200; } catch { return false; } }, 'service health');
    await until(() => {
      try { token = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')).token || ''; } catch { token = ''; }
      return token;
    }, 'runtime token');
  };
  const stopServer = async () => {
    const child = server;
    if (!child) return;
    killOwnTree(child);
    await until(() => child.exitCode !== null || child.signalCode !== null, 'service exit');
    server = null;
  };
  const readSession = async id => (await request('GET', '/api/sessions/' + id)).json;
  const idle = id => until(async () => {
    const body = await readSession(id);
    return body.execution === null && body.resumable?.live !== true ? body : false;
  }, 'driver settlement');
  const relay = async (id, message) => {
    const r = await request('POST', '/api/steward/relay', { sessionId: id, message });
    if (r.json.ok !== true) throw new Error('relay failed: ' + JSON.stringify(r.json));
    return r.json.undoRef;
  };
  const rewind = (id, ref, extra = {}) => request('POST', '/api/session/rewind', {
    sessionId: id, targetTurnSeq: ref.rewindTargetTurnSeq, rollbackFiles: true,
    guardExecution: true, expectedExecution: ref.execution, ...extra,
  });
  const code = body => body?.error?.code || body?.error;
  try {
    fake = await startFakeProvider({ handler(req) {
      const text = req.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join('\n');
      if (text.includes('STOP_HOLD')) {
        started.add('hold'); req.open(); req.sse(textFrames('holding', { finish: null })[0]); return;
      }
      return textFrames('synthetic completed');
    } });
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      configSchema: 14, activeProvider: 'fake', engineMode: 'interactive', permissionMode: 'default',
      defaultWorkspace: work, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
      enableMcpDropIn: false, schedulerEnabledV1: false, stewardEnabledV1: true,
      stewardMaxParallelThreads: 4, missionAutoContinue: false,
      desktopMcp: { enabled: false, autodetect: false },
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url,
        apiKey: 'synthetic-key', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    }), 'utf8');
    port = await getFreePort();
    await start();
    const make = async title => (await request('POST', '/api/sessions', { title, cwd: work })).json.session.id;
    const begin = async id => {
      const ref = await relay(id, 'STOP_HOLD');
      const view = await until(async () => { const s = await readSession(id); return s.execution && s; }, 'execution registration');
      return ref.execution || view.execution;
    };
    const stop = (id, expectedExecution) => request('POST', '/api/stop', { sessionId: id, expectedExecution });
    const id = await make('stop identity A then B');
    const noWork = await stop(id, null);
    ok(noWork.status === 200 && noWork.json.stopped === false, 'I1 explicit idle stop is a truthful no-op');
    const a = await begin(id);
    ok(Boolean(a.driverRunId && a.serverInstanceId), 'I2 production relay exposes its admitted identity');
    const missing = await stop(id, undefined);
    ok(missing.status === 409 && code(missing.json) === 'execution_identity_required', 'I3 legacy missing identity refuses an active execution');
    const observedIdle = await stop(id, null);
    ok(observedIdle.status === 409 && code(observedIdle.json) === 'execution_changed', 'I4 old idle observation cannot stop an execution admitted later');
    const wrongEpoch = await stop(id, { ...a, serverInstanceId: 'previous-process' });
    ok(wrongEpoch.status === 409 && code(wrongEpoch.json) === 'execution_changed', 'I5 previous process identity refuses before effects');
    ok((await readSession(id)).execution.driverRunId === a.driverRunId, 'I6 rejected requests leave A running');
    const accepted = await stop(id, a);
    ok(accepted.json.ok === true && accepted.json.stopped === true, 'I7 same identity accepts a stop request');
    await idle(id);
    const b = await begin(id);
    ok(b.driverRunId !== a.driverRunId && b.serverInstanceId === a.serverInstanceId, 'I8 B has a new logical identity within the same process');
    const oldButton = await stop(id, a);
    ok(oldButton.status === 409 && code(oldButton.json) === 'execution_changed', 'I9 retained A button cannot stop B');
    ok((await readSession(id)).execution.driverRunId === b.driverRunId, 'I10 B remains owned after old A request');
    const queuedId = await make('same cwd queued');
    const queued = await begin(queuedId);
    await until(async () => (await request('GET', '/api/steward/arbiter')).json.queue.some(row => row.sessionId === queuedId), 'queued owner');
    const queueView = await request('GET', '/api/steward/arbiter');
    ok(queueView.json.queue.find(row => row.sessionId === queuedId).execution.driverRunId === queued.driverRunId, 'I11 queue read surface carries the same driver identity');
    const queueStop = await stop(queuedId, queued);
    ok(queueStop.json.stopped === true && queueStop.json.queuedStopped === true, 'I12 actual queue cancellation is acknowledged before abort removes its evidence');
    await idle(queuedId);
    ok(!(await request('GET', '/api/steward/arbiter')).json.queue.some(row => row.sessionId === queuedId), 'I13 cancelled owner cannot reappear after pending-check await');
    ok((await readSession(id)).execution.driverRunId === b.driverRunId, 'I14 stopping queued peer does not stop its blocker');
    await stop(id, b); await idle(id);
    await stopServer(); await start();
    const restarted = await begin(id);
    ok(restarted.serverInstanceId !== b.serverInstanceId, 'I15 restart reuses OVERLAY_ID as a changed process identity');
    const late = await stop(id, b);
    ok(late.status === 409 && (await readSession(id)).execution.driverRunId === restarted.driverRunId, 'I16 delayed pre-restart stop cannot affect the new process execution');
    await stop(id, restarted); await idle(id);
  } catch (error) {
    runner.fail(error.stack || String(error));
  } finally {
    try { await stopServer(); } catch (error) { runner.fail('cleanup: ' + error.message); }
    if (fake) await fake.close();
    if (!runner.failures) fs.rmSync(home, { recursive: true, force: true });
    runner.done();
  }
})();
