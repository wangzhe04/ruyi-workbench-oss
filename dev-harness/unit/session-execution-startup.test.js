'use strict';
require('../lib/self-isolate-home');
// Real runSessionTurn and steward tool, paused at the existing slot hook before either engine starts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const http = require('node:http');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-start-stop-'));
const work = path.join(home, 'work'); fs.mkdirSync(work, { recursive: true });
process.env.RUYI_HOME = home; process.env.WIN_CLAUDE_WORKBENCH_HOME = home;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
process.env.WCW_FAKE_CLAUDE = path.resolve(app, '../tools/fake-claude.js');
const configuration = engine => ({ configSchema: 14, permissionMode: 'default', defaultWorkspace: work,
  autoImportClaudeCodeMcp: false, enableMcpDropIn: false, includeWorkbenchMcp: false,
  stewardEnabledV1: true, schedulerEnabledV1: false, activeProvider: engine === 'provider' ? 'probe' : '', engineMode: 'print',
  providers: engine === 'provider' ? [{ id: 'probe', label: 'probe', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1', apiKey: 'synthetic', model: 'synthetic' }] : [],
});
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(configuration('cli')));
const srv = require(path.join(app, 'server.js'));
for (const engine of ['cli', 'provider']) test(engine + ' driver stopped during pre-queue admission never starts a child or provider request', async () => {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(configuration(engine)));
  const session = await srv.createSession({ title: engine + ' startup stop', cwd: work });
  const originalAcquire = srv.StewardHooks.acquireTurnSlot;
  const originalSpawn = cp.spawn; const originalRequest = http.request; const originalFetch = globalThis.fetch;
  let engineCalls = 0, identity, release, arrived;
  const atAdmission = new Promise(resolve => { arrived = resolve; });
  srv.StewardHooks.acquireTurnSlot = () => { arrived(); return new Promise(resolve => { release = resolve; }); };
  cp.spawn = () => { engineCalls++; throw Error('unexpected child'); };
  http.request = () => { engineCalls++; throw Error('unexpected HTTP'); };
  globalThis.fetch = () => { engineCalls++; throw Error('unexpected provider'); };
  try {
    const events = [];
    const turn = srv.runSessionTurn({ sessionId: session.id, message: 'do not start', cwd: work, onEvent(event) {
      events.push(event); if (event.type === 'session') identity = event.execution;
    } });
    await atAdmission;
    assert.ok(identity?.driverRunId);
    assert.equal(srv.activeChildren.has(session.id), false);
    const stopped = await srv.StewardHooks.threadStop({ sessionId: session.id, expectedExecution: identity }, { session: { id: 'steward', kind: 'steward' }, userPressed: true });
    assert.equal(stopped.ok, true, JSON.stringify(stopped));
    assert.equal(stopped.stopped, true);
    release({ granted: true, release() {} });
    const result = await turn;
    assert.equal(result.stopped, true);
    assert.equal(engineCalls, 0);
    assert.equal(events.some(event => event.type === 'process' && event.state === 'running'), false);
    assert.equal(events.some(event => event.type === 'process' && event.state === 'stopped'), true);
  } finally {
    if (release) release({ granted: false });
    srv.StewardHooks.acquireTurnSlot = originalAcquire; cp.spawn = originalSpawn; http.request = originalRequest; globalThis.fetch = originalFetch;
  }
});
