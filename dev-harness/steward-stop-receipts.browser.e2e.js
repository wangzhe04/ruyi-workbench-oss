'use strict';
require('./lib/self-isolate-home');
// Real page + HTTP + fake provider. Stop acknowledgement is not process-exit evidence.
// Lost write responses stay unknown; only read requests may follow them automatically.
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');
const runner = createRunner('STEWARD STOP RECEIPTS BROWSER');
const { ok } = runner;

(async () => {
  let fx;
  const ids = {};
  const releases = [];
  const started = new Set();
  let actionTarget = '';
  const row = id => `#railList .steward-board-thread[data-session-id="${id}"]`;
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-stop-receipts-', width: 1440, height: 960,
      config: { stewardMaxParallelThreads: 4, schedulerEnabledV1: false },
      prepare: async f => {
        fx = f;
        for (const name of ['idle', 'lost', 'other', 'queued', 'tool', 'bad']) {
          const cwd = path.join(f.work, name === 'queued' ? 'lost' : name);
          fs.mkdirSync(cwd, { recursive: true });
          const made = await f.request('POST', '/api/sessions', { title: 'stop receipt ' + name, cwd });
          ids[name] = made.json.session.id;
        }
      },
      provider: async ctx => {
        const last = ctx.messages.filter(m => m.role === 'user').map(m => typeof m.content === 'string' ? m.content
          : JSON.stringify(m.content || '')).join('\n');
        const hold = last.match(/HOLD_(?:LOST|OTHER|QUEUED|TOOL)/)?.[0];
        const sys = ctx.messages.filter(m => m.role === 'system').map(m => String(m.content || '')).join('\n');
        if (/我是如意|I am Ruyi/.test(sys)) {
          const expectedExecution = actionTarget ? (await fx.request('GET', '/api/sessions/' + actionTarget)).json.execution : null;
          ctx.text(JSON.stringify({ say: '已处理停止请求。', why: '', acts: [], actions: last.includes('STOP_ACTION')
            ? [{ tool: 'steward_thread_stop', args: { sessionId: actionTarget, expectedExecution } }] : [] }));
        } else if (hold) {
          started.add(hold);
          ctx.text(hold + ' running');
          await new Promise(resolve => releases.push(resolve));
        } else ctx.text('fixture completed');
        ctx.stop();
      },
    });
    await fx.setLens('steward');
    ok(Boolean(await fx.waitForEval(`document.querySelector(${JSON.stringify(row(ids.idle))})`)), 'S0 actual task row is rendered');
    await fx.evaluate(`(() => {
      window.stopCounts = {}; window.stopModes = {}; window.stopWaits = {};
      window.stopOriginalFetch = window.fetch;
      window.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input.url, location.href);
        if (url.pathname !== '/api/stop' || init?.method !== 'POST') return stopOriginalFetch(input, init);
        const id = JSON.parse(init.body).sessionId;
        stopCounts[id] = (stopCounts[id] || 0) + 1;
        if (stopModes[id] === 'reject') return new Response(JSON.stringify({ ok: false, error: { code: 'probe.denied', message: 'fixture refusal detail' } }), { status: 409 });
        const response = await stopOriginalFetch(input, init);
        if (stopModes[id] === 'drop') {
          await response.clone().json();
          await new Promise(resolve => { stopWaits[id] = resolve; });
          throw new TypeError('Failed to fetch');
        }
        if (stopModes[id] === 'malformed') return new Response('null', { headers: { 'Content-Type': 'application/json' } });
        return response;
      };
    })()`);
    const clickStop = async id => {
      ok(Boolean(await fx.waitForEval(`document.querySelector(${JSON.stringify(row(id) + ' [data-action="stop"]')})`)), 'row stop control exists');
      await fx.evaluate(`document.querySelector(${JSON.stringify(row(id) + ' [data-action="stop"]')}).click()`);
    };
    const feedback = (id, outcome) => `document.querySelector(${JSON.stringify(row(id) + ' [data-stop-receipt][data-stop-outcome="' + outcome + '"]')})`;
    const waitIdle = async id => {
      for (let i = 0; i < 200; i++) {
        const r = await fx.request('GET', '/api/sessions/' + id);
        if (r.json && r.json.resumable?.live !== true) return r.json;
        await sleep(40);
      }
      throw new Error('turn did not stop: ' + id);
    };
    const launch = async (name, marker) => {
      const r = await fx.request('POST', '/api/steward/relay', { sessionId: ids[name], message: marker });
      if (r.status !== 200) throw new Error('launch failed: ' + r.text);
      for (let i = 0; i < 200 && !started.has(marker); i++) await sleep(40);
      if (!started.has(marker)) throw new Error('fake turn did not start: ' + marker);
    };

    await clickStop(ids.idle);
    if (!ok(Boolean(await fx.waitForEval(feedback(ids.idle, 'noop'), 100)), 'S1 real /api/stop stopped:false is a no-op, not a successful stop')) {
      throw new Error('idle stop acknowledgement contract failed');
    }
    ok(await fx.evaluate(`document.getElementById('stewardBoardNote').textContent === '当前没有正在运行的任务'`), 'S2 idle control does not announce stopped');

    await launch('lost', 'HOLD_LOST');
    await launch('other', 'HOLD_OTHER');
    const queuedLaunch = await fx.request('POST', '/api/steward/relay', { sessionId: ids.queued, message: 'HOLD_QUEUED' });
    const queuedExecution = queuedLaunch.json?.undoRef?.execution;
    if (!queuedExecution?.driverRunId) throw new Error('queued relay did not expose its admitted identity');
    let queued = false;
    for (let i = 0; i < 200; i++) {
      const a = await fx.request('GET', '/api/steward/arbiter');
      if (a.json?.queue?.some(q => q.sessionId === ids.queued)) { queued = true; break; }
      await sleep(40);
    }
    ok(queued && !started.has('HOLD_QUEUED'), 'S3 target is truly waiting on the same workspace lock');
    ok(Boolean(await fx.waitForEval(`document.querySelector(${JSON.stringify(row(ids.queued) + ' [data-action="stop"]')})?.dataset.stewardStopTarget.includes(${JSON.stringify(queuedExecution.driverRunId)})`)), 'S3b actual queued stop button has received the admitted execution identity');
    await clickStop(ids.queued);
    ok(Boolean(await fx.waitForEval(feedback(ids.queued, 'accepted'))), 'S4 queued turn receives a stop-request acknowledgement');
    const afterQueueStop = await fx.request('GET', '/api/steward/arbiter');
    ok(afterQueueStop?.status === 200 && Array.isArray(afterQueueStop.json?.queue) && !afterQueueStop.json.queue.some(q => q.sessionId === ids.queued), 'S4b actual queued execution was cancelled, not merely acknowledged by UI');
    ok(!started.has('HOLD_QUEUED'), 'S5 cancelled queue entry never invokes the provider');

    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(ids.lost)} } }))`);
    ok(Boolean(await fx.waitForEval(`document.getElementById('stewardDrawerStopBtn').dataset.stewardStopSession === ${JSON.stringify(ids.lost)}`)), 'S6 actual drawer owns the intended thread');
    await fx.evaluate(`stopModes[${JSON.stringify(ids.lost)}] = 'drop'`);
    await clickStop(ids.lost);
    ok(Boolean(await fx.waitForEval(`typeof stopWaits[${JSON.stringify(ids.lost)}] === 'function'`)), 'S7 service applied stop while the response is withheld');
    await waitIdle(ids.lost);
    ok(await fx.evaluate(`document.getElementById('stewardDrawerStopBtn').disabled`), 'S8 a second control for the same target is disabled while awaiting receipt');
    await fx.evaluate(`document.getElementById('stewardDrawerStopBtn').click()`);
    await clickStop(ids.other);
    ok(Boolean(await fx.waitForEval(feedback(ids.other, 'accepted'))), 'S9 a different target can stop independently');
    await waitIdle(ids.other);
    await fx.evaluate(`stopWaits[${JSON.stringify(ids.lost)}]()`);
    ok(Boolean(await fx.waitForEval(feedback(ids.lost, 'unknown'))), 'S10 lost response stays unknown even though the service performed the stop');
    ok(await fx.evaluate(`stopCounts[${JSON.stringify(ids.lost)}] === 1 && document.getElementById('stewardBoardNote').textContent === '未确认停止结果，请核对状态' && document.querySelector('#stewardDrawerStopBtn + [data-stop-outcome="unknown"]')`), 'S11 no duplicate write and both controls retain unknown after response loss');
    await fx.setLens('classic');
    await fx.setLens('steward');
    ok(Boolean(await fx.waitForEval(feedback(ids.lost, 'unknown'))), 'S12 a read-only view refresh retains unknown feedback');
    ok(await fx.evaluate(`(${feedback(ids.lost, 'unknown')}).textContent.startsWith('最近一次停止请求：') && stopCounts[${JSON.stringify(ids.lost)}] === 1`), 'S13 feedback names the previous request, never the current task state; refresh does not resend');

    await fx.evaluate(`stopModes[${JSON.stringify(ids.bad)}] = 'malformed'`);
    await clickStop(ids.bad);
    ok(Boolean(await fx.waitForEval(feedback(ids.bad, 'unknown'))), 'S14 malformed HTTP success is unknown');
    await fx.evaluate(`stopModes[${JSON.stringify(ids.bad)}] = 'reject'`);
    await clickStop(ids.bad);
    ok(Boolean(await fx.waitForEval(feedback(ids.bad, 'failed'))), 'S15 explicit HTTP rejection is failure');
    ok(await fx.evaluate(`(${feedback(ids.bad, 'failed')}).textContent.includes('fixture refusal detail')`), 'S16 rejection retains its reason');
    await fx.evaluate(`(async () => { const { setLocale } = await import('/js/i18n.js'); await setLocale('en-US'); })()`);
    ok(Boolean(await fx.waitForEval(`(${feedback(ids.lost, 'unknown')})?.textContent.startsWith('Last stop request:')`)), 'S17 retained feedback follows language changes');
    await fx.evaluate(`(async () => { const { setLocale } = await import('/js/i18n.js'); await setLocale('zh-CN'); })()`);

    const shots = process.env.RUYI_SHOT_DIR;
    for (const width of [1440, 390]) {
      await fx.resize(width, 960);
      for (const locale of ['zh-CN', 'en-US']) {
        await fx.evaluate(`(async () => { await (await import('/js/i18n.js')).setLocale(${JSON.stringify(locale)}); })()`);
        for (const theme of ['light', 'dark']) {
          await fx.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
          for (const [name, outcome] of [['lost', 'unknown'], ['idle', 'noop']]) {
            await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: ${JSON.stringify(ids[name])} } }))`);
            const receiptReady = await fx.waitForEval(`document.getElementById('stewardDrawerStopBtn').dataset.stewardStopSession === ${JSON.stringify(ids[name])} && document.querySelector('#stewardDrawerStopBtn + [data-stop-receipt]')?.dataset.stopOutcome === ${JSON.stringify(outcome)}`);
            if (!receiptReady) throw new Error(`drawer receipt did not load for ${width}/${locale}/${theme}/${outcome}`);
            await fx.evaluate(`document.getElementById('stewardDrawerSendBtn').focus(); document.getElementById('stewardDrawerFoot').scrollIntoView({block:'end'})`);
            const bounds = await fx.evaluate(`(() => {
              const drawer = document.getElementById('stewardDrawer'), foot = document.getElementById('stewardDrawerFoot');
              const feedback = document.querySelector('#stewardDrawerStopBtn + [data-stop-receipt]');
              const send = document.getElementById('stewardDrawerSendBtn'), rect = feedback.getBoundingClientRect(), b = send.getBoundingClientRect();
              return { visible: feedback.checkVisibility() && rect.left >= 0 && rect.right <= innerWidth + 1 && rect.top >= 0 && rect.bottom <= innerHeight + 1,
                fits: foot.scrollWidth <= foot.clientWidth + 1 && drawer.scrollWidth <= drawer.clientWidth + 1,
                focus: document.activeElement === send && send.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),
                outcome: feedback.dataset.stopOutcome, text: feedback.textContent };
            })()`);
            ok(bounds.visible && bounds.fits && bounds.focus && bounds.outcome === outcome,
              `V ${width}/${locale}/${theme}/${outcome} feedback is visible, wraps, and preserves an actionable focused control: ${JSON.stringify(bounds)}`);
            if (shots) {
              fs.mkdirSync(shots, { recursive: true });
              fs.writeFileSync(path.join(shots, `stop-${width}-${locale}-${theme}-${outcome}.png`), await fx.screenshot());
            }
          }
        }
      }
    }
    await fx.resize(1440, 960);
    await fx.evaluate(`(async () => { await (await import('/js/i18n.js')).setLocale('zh-CN'); })()`);

    // The acknowledgement is persisted by the real tool path and rendered by the same live/replay logic.
    await launch('tool', 'HOLD_TOOL');
    actionTarget = ids.tool;
    await fx.evaluate(`(async () => {
      const { createStewardConversation } = await import('/js/steward-conversation.js');
      const { api } = await import('/js/net.js'); const { t } = await import('/js/i18n.js');
      window.stopConversation = createStewardConversation({ api, state, t, isStewardMode: () => true });
      await stopConversation.sendToSteward('STOP_ACTION');
    })()`);
    ok(Boolean(await fx.waitForEval(`document.querySelector('#stewardFeed [data-receipt="action"][data-stop-outcome="accepted"]')`)), 'S18 real tool acknowledgement uses request-sent wording in the live conversation');
    await waitIdle(ids.tool);
    await fx.evaluate(`stopConversation.sendToSteward('STOP_ACTION again')`);
    ok(Boolean(await fx.waitForEval(`document.querySelector('#stewardFeed [data-receipt="action"][data-stop-outcome="noop"]')`)), 'S18b real tool not_running is a no-op, not a rejected stop');
    const history = await fx.request('GET', '/api/sessions/steward');
    const stopRows = (history.json?.session?.messages || []).filter(m => m.steward?.actions?.some(a => a.tool === 'steward_thread_stop'));
    ok(stopRows.some(m => m.steward.actions.some(a => a.result?.stopped === true)), 'S19 stop acknowledgement is present in the actual saved tool receipt');
    await fx.evaluate(`(async () => { document.getElementById('stewardFeed').replaceChildren(); await stopConversation.appendSince('2000-01-01T00:00:00.000Z'); })()`);
    ok(await fx.evaluate(`document.querySelector('#stewardFeed [data-stop-outcome="accepted"]')?.textContent.includes('已发出停止请求')`), 'S20 replay uses the saved acknowledgement without claiming process exit');
    ok(await fx.evaluate(`document.querySelector('#stewardFeed [data-stop-outcome="noop"]')?.textContent.includes('当前没有正在运行的任务')`), 'S20b persisted not_running replays as no-op');

    // A completed turn may still be rewound: no-op stop must not block the existing undo protocol.
    const completed = await fx.request('POST', '/api/steward/relay', { sessionId: ids.idle, message: 'COMPLETE_FOR_REWIND' });
    ok(completed.status === 200, 'S21 completed-turn fixture launched');
    let saved;
    for (let i = 0; i < 200; i++) {
      saved = await fx.request('GET', '/api/sessions/' + ids.idle);
      if (saved.json?.session?.turnSeq > 0 && saved.json?.resumable?.live !== true) break;
      await sleep(40);
    }
    const noop = await fx.request('POST', '/api/stop', { sessionId: ids.idle });
    const undone = await fx.request('POST', '/api/session/rewind', { sessionId: ids.idle, targetTurnSeq: saved.json.session.turnSeq, rollbackFiles: true });
    ok(noop.json?.stopped === false && undone.json?.ok === true, 'S22 idle stop remains compatible with rewinding a completed turn');
    const audit = await fx.request('GET', '/api/steward/decisions?limit=100');
    const rows = audit.json?.items || audit.json?.rows || [];
    ok(rows.some(r => r.tool === 'user_stop' && r.targetSessionId === ids.lost) && !rows.some(r => r.tool === 'user_stop' && r.targetSessionId === ids.idle), 'S23 audit records actual stop requests, not no-op clicks');
    ok(fx.exceptions.length === 0, 'S24 no uncaught browser exceptions: ' + fx.exceptions.join('; '));
  } catch (error) { runner.fail(error.stack || String(error)); }
  finally {
    for (const release of releases) release();
    if (fx) await fx.close({ keepRoot: runner.failures > 0 });
  }
  runner.done({ exit: true });
})();
