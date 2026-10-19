'use strict';
require('./lib/self-isolate-home');
// Production page/HTTP: retain the actual rendered A control and withhold a real applied stop response.
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');
const runner = createRunner('SESSION STOP IDENTITY BROWSER');
const { ok } = runner;
(async () => {
  let fx, id;
  const releases = [];
  const row = () => `#railList .steward-board-thread[data-session-id="${id}"]`;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-stop-identity-', width: 1440, height: 960,
      config: { schedulerEnabledV1: false },
      prepare: async f => { id = (await f.request('POST', '/api/sessions', { title: 'identity A then B', cwd: f.work })).json.session.id; },
      provider: async ctx => { ctx.text('identity fixture running'); await new Promise(resolve => releases.push(resolve)); ctx.stop(); },
    });
    await fx.setLens('steward');
    const relay = async message => {
      const response = await fx.request('POST', '/api/steward/relay', { sessionId: id, message });
      if (!response?.json?.undoRef?.execution) throw Error('relay lacks execution: ' + JSON.stringify(response));
      const execution = response.json.undoRef.execution;
      ok(Boolean(await fx.waitForEval(`document.querySelector(${JSON.stringify(row() + ' [data-action="stop"]')})?.dataset.stewardStopTarget.includes(${JSON.stringify(execution.driverRunId)})`)), 'rendered stop is bound to ' + message);
      return execution;
    };
    const waitIdle = async () => {
      for (let i = 0; i < 200; i++) { const r = await fx.request('GET', '/api/sessions/' + id); if (r.json?.execution === null) return; await sleep(40); }
      throw Error('driver did not settle');
    };
    const a = await relay('A');
    await fx.evaluate(`(() => {
      window.retainedStopA = document.querySelector(${JSON.stringify(row() + ' [data-action="stop"]')});
      window.identityWrites = []; window.identityDelay = false;
      const original = window.fetch;
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname !== '/api/stop' || init?.method !== 'POST') return original(input, init);
        const payload = JSON.parse(init.body); identityWrites.push(payload);
        const response = await original(input, init);
        if (identityDelay) { identityDelay = false; await response.clone().json(); await new Promise(resolve => { window.identityRelease = resolve; }); throw new TypeError('applied but response lost'); }
        return response;
      };
    })()`);
    const stoppedA = await fx.request('POST', '/api/stop', { sessionId: id, expectedExecution: a });
    ok(stoppedA.json.stopped === true, 'A applied stop prepares the retained-button race');
    await waitIdle();
    const b = await relay('B');
    await fx.evaluate('retainedStopA.click()');
    ok(Boolean(await fx.waitForEval('identityWrites.length === 1')), 'retained production A handler issued its original request');
    ok(await fx.evaluate(`identityWrites[0].expectedExecution.driverRunId === ${JSON.stringify(a.driverRunId)}`), 'old handler sends captured A, never looks up B at click');
    ok((await fx.request('GET', '/api/sessions/' + id)).json.execution.driverRunId === b.driverRunId, 'real backend rejects stale A while B remains active');
    ok(await fx.evaluate(`!document.querySelector(${JSON.stringify(row() + ' [data-stop-outcome="failed"]')})`), 'A rejection cannot overwrite B feedback');

    // Apply B stop but lose its response. Start C while B's write is still in flight.
    await fx.evaluate(`identityDelay = true; document.querySelector(${JSON.stringify(row() + ' [data-action="stop"]')}).click()`);
    ok(Boolean(await fx.waitForEval('typeof identityRelease === "function"')), 'service applied B stop with its response withheld');
    await waitIdle();
    const c = await relay('C');
    ok(await fx.evaluate(`!document.querySelector(${JSON.stringify(row() + ' [data-action="stop"]')}).disabled`), 'B in-flight request does not lock new C button');
    await fx.evaluate('identityRelease()');
    await sleep(150);
    ok((await fx.request('GET', '/api/sessions/' + id)).json.execution.driverRunId === c.driverRunId, 'late lost-response B does not stop C');
    ok(await fx.evaluate(`!document.querySelector(${JSON.stringify(row() + ' [data-stop-outcome="unknown"]')})`), 'late B unknown does not masquerade as C feedback');
    await fx.evaluate(`document.querySelector(${JSON.stringify(row() + ' [data-action="stop"]')}).click()`);
    ok(Boolean(await fx.waitForEval('identityWrites.length === 3')), 'C sends its own stop despite B request');
    ok(await fx.evaluate(`identityWrites[2].expectedExecution.driverRunId === ${JSON.stringify(c.driverRunId)}`), 'C request carries C execution');
    await waitIdle();
    ok(Boolean(await fx.waitForEval(`document.querySelector(${JSON.stringify(row() + ' [data-stop-outcome="accepted"]')})`)), 'idle history shows the newest C request, not late B unknown');
    ok(await fx.evaluate('identityWrites.length === 3'), 'unknown B never automatically replays');
    ok(fx.exceptions.length === 0, 'no uncaught page exceptions: ' + fx.exceptions.join('; '));
  } catch (error) { runner.fail(error.stack || String(error)); }
  finally { for (const release of releases) release(); if (fx) await fx.close({ keepRoot: runner.failures > 0 }); }
  runner.done({ exit: true });
})();
