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
const runner = createRunner('SESSION REWIND EXECUTION');
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
    await until(async () => {
      try {
        const runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8'));
        token = runtime.pid === server.pid ? runtime.token || '' : '';
        return token && (await request('GET', '/api/status')).status === 200;
      } catch { token = ''; return false; }
    }, 'current process runtime token and authenticated readiness');
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
  const idleState = body => ({ turnSeq: Number(body.session.turnSeq) || 0, rewindGen: Number(body.session.rewindGen) || 0,
    executionObservation: body.executionObservation });
  try {
    fake = await startFakeProvider({ handler(req) {
      const text = req.messages.filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join('\n');
      if (text.includes('REWIND_HOLD')) {
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
    const made = await request('POST', '/api/sessions', { title: 'identity undo fixture', cwd: work });
    const id = made.json.session.id;
    const a = await relay(id, 'REWIND_DONE_A');
    ok(Boolean(a?.execution?.driverRunId && a.execution.serverInstanceId && a.rewindTargetTurnSeq === 1), 'R1 relay captures the admitted execution and first-turn anchor');
    await idle(id);
    const undone = await rewind(id, a);
    ok(undone.json.ok === true && undone.json.removedTurns > 0, 'R2 completed A remains undoable with matching last-admitted evidence');
    ok(!(await readSession(id)).session.messages.some(m => String(m.content).includes('REWIND_DONE_A')), 'R3 completed undo persists the truncated history');

    const old = await relay(id, 'REWIND_DONE_OLD');
    const observedIdle = idleState(await idle(id));
    const newer = await relay(id, 'REWIND_DONE_NEW');
    const before = await idle(id);
    const rejected = await rewind(id, old);
    ok(code(rejected.json) === 'execution_changed', 'R4 completed B invalidates the old A undo identity even while idle');
    ok(JSON.stringify((await readSession(id)).session.messages) === JSON.stringify(before.session.messages), 'R5 rejected stale undo neither truncates A nor B');
    const staleIdle = await rewind(id, newer, { expectedExecution: null, expectedIdleState: observedIdle });
    ok(code(staleIdle.json) === 'execution_changed', 'R5a null to B to null cannot reuse the previous idle observation');
    const noObservation = await rewind(id, newer, { expectedExecution: null });
    ok(code(noObservation.json) === 'execution_identity_required', 'R5b guarded idle without an observation is not a safe rewind target');
    for (const field of ['turnSeq', 'rewindGen']) {
      const expectedIdleState = idleState(before); expectedIdleState[field] += 1;
      const changed = await rewind(id, newer, { expectedExecution: null, expectedIdleState });
      ok(code(changed.json) === 'execution_changed', 'R5c changed idle ' + field + ' refuses rollback');
    }

    const activeMade = await request('POST', '/api/sessions', { title: 'active undo fixture', cwd: work });
    const activeId = activeMade.json.session.id;
    const active = await relay(activeId, 'REWIND_HOLD');
    await until(() => started.has('hold'), 'held provider');
    const missing = await request('POST', '/api/session/rewind', { sessionId: activeId,
      targetTurnSeq: active.rewindTargetTurnSeq, rollbackFiles: true, guardExecution: true });
    ok(code(missing.json) === 'execution_identity_required', 'R6 guarded missing identity cannot auto-stop a live execution');
    const idleConflict = await rewind(activeId, active, { expectedExecution: null });
    ok(code(idleConflict.json) === 'execution_changed', 'R7 explicit idle observation cannot target a live execution');
    ok((await readSession(activeId)).execution?.driverRunId === active.execution.driverRunId, 'R8 rejected undo leaves the original execution active');
    const activeUndone = await rewind(activeId, active);
    ok(activeUndone.json.ok === true, 'R9 matching active undo stops, settles and rewinds in one guarded request');
    await idle(activeId);

    await stopServer();
    await start();
    const restart = await rewind(id, newer);
    ok(code(restart.json) === 'execution_changed', 'R10 a new server instance rejects the old completed execution identity');
    const restartIdle = await rewind(id, newer, { expectedExecution: null, expectedIdleState: idleState(before) });
    ok(code(restartIdle.json) === 'execution_changed', 'R10a old idle observation cannot cross a server instance restart');
    const legacy = await request('POST', '/api/session/rewind', { sessionId: id,
      targetTurnSeq: newer.rewindTargetTurnSeq, rollbackFiles: false });
    ok(legacy.json.ok === true, 'R11 old idle API rewind remains compatible without the guarded UI contract');
    const currentIdle = idleState(await readSession(id));
    const idleUndone = await rewind(id, old, { expectedExecution: null, expectedIdleState: currentIdle });
    ok(idleUndone.json.ok === true, 'R12 matching explicit idle observation and persistent anchor permit guarded rewind');
  } catch (error) {
    runner.fail(error.stack || String(error));
  } finally {
    try { await stopServer(); } catch (error) { runner.fail('cleanup: ' + error.message); }
    if (fake) await fake.close();
    if (!runner.failures) fs.rmSync(home, { recursive: true, force: true });
    runner.done();
  }
})();
