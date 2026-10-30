'use strict';
// ACTUAL OFFLINE BROWSER E2E. Shared browser fixture/provider and runner. Opens
// real existing A/B/C selections, reviews exact material, starts B once, accepts
// B and starts C. Includes same-title identity, bilingual labels, narrow layout
// and explicit cancellation. Execute only in the serial actual-test window.
require('./lib/self-isolate-home');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture } = require('./lib/browser-fixture');
const t = createRunner('THREAD RELAY BROWSER'); const { ok } = t;
let fx, a, b, c, calls = [];
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-thread-relay-ui-', ok, width: 1440,
      config: { permissionMode: 'auto', agentAutoWake: false, agentTaskPoolPolicy: 'off' },
      provider: ctx => {
        const text = String([...ctx.messages].reverse().find(row => row.role === 'user')?.content || ''); calls.push(text);
        ctx.text(text.includes('SOURCE_BROWSER_RELAY') ? 'APPROVED_BROWSER_MATERIAL' : 'BROWSER_TARGET_DELIVERY'); ctx.stop();
      },
      prepare: async fixture => {
        const create = async () => (await fixture.request('POST', '/api/sessions', { token: fixture.token, title: 'Same title', cwd: fixture.work })).json.session.id;
        a = await create(); b = await create(); c = await create();
        const response = await fixture.request('POST', '/api/chat/stream', { token: fixture.token, sessionId: a, message: 'SOURCE_BROWSER_RELAY', cwd: fixture.work });
        if (response.status !== 200) throw Error('source turn failed');
      } });
    await fx.evaluate(`document.getElementById('threadRelayBtn').click(); true`);
    ok(await fx.waitForEval(`document.querySelector('.thread-relay [data-relay-field="source"]') ? 1 : null`), 'relay UI opens with actual existing thread choices');
    const choose = (field, value, index = 0) => fx.evaluate(`(() => { const input=document.querySelectorAll('.thread-relay [data-relay-field="${field}"]')[${index}]; input.value=${JSON.stringify(value)}; input.dispatchEvent(new Event('change',{bubbles:true})); return input.value; })()`);
    await choose('source', a); await choose('target', b);
    const identities = await fx.evaluate(`(() => [...document.querySelector('.thread-relay [data-relay-field="source"]').options].filter(option=>option.textContent.includes('Same title')).map(option=>[option.value,option.textContent]))()`);
    ok(identities.length >= 3 && identities.some(row => row[0] === a && row[1].includes(a)) && identities.some(row => row[0] === b && row[1].includes(b)), 'same-title choices visibly distinguish real session IDs');
    await fx.evaluate(`document.querySelector('.thread-relay-step textarea').value='BROWSER_EXISTING_B'; document.querySelector('.thread-relay-add').click(); true`);
    await choose('target', c, 1);
    await fx.evaluate(`document.querySelectorAll('.thread-relay-step textarea')[1].value='BROWSER_EXISTING_C'; document.querySelector('.thread-relay-inspect').click(); true`);
    ok(await fx.waitForEval(`document.querySelector('.thread-relay-text')?.textContent.includes('APPROVED_BROWSER_MATERIAL') ? 1 : null`), 'source inspection shows the exact real delivery text');
    await fx.evaluate(`document.querySelector('.thread-relay-save').click(); true`);
    ok(await fx.waitForEval(`document.querySelector('.thread-relay').textContent.includes('请先勾选') ? 1 : null`), 'unchecked acceptance refuses to save or launch');
    await fx.evaluate(`document.querySelector('.thread-relay-accept').checked=true; document.querySelector('.thread-relay-save').click(); true`);
    ok(await fx.waitForEval(`document.querySelectorAll('.thread-relay-edge').length===2 ? 1 : null`), 'actual UI saves the ordered B then C dependency');
    const relayId = await fx.evaluate(`document.querySelector('.thread-relay-card').dataset.relayId`);
    await fx.evaluate(`(() => {const start=document.querySelector('.thread-relay-start'); start.click(); start.click(); return true;})()`);
    const checkProgress = async index => {
      for (let n = 0; n < 20; n++) {
        await fx.evaluate(`document.querySelector('.thread-relay-refresh').click(); true`);
        if (await fx.waitForEval(`document.querySelectorAll('.thread-relay-edge')[${index}]?.querySelector('.thread-relay-review-result') ? 1 : null`, 30)) return true;
      }
      return false;
    };
    ok(await checkProgress(0), 'real existing B completes and becomes available for delivery review');
    ok(calls.filter(value => value.includes('BROWSER_EXISTING_B')).length === 1 && !calls.some(value => value.includes('BROWSER_EXISTING_C')), 'repeat click launches B once and leaves C blocked');
    await fx.evaluate(`document.querySelector('.thread-relay-review-result').click(); true`);
    ok(await fx.waitForEval(`document.querySelector('.thread-relay-review .thread-relay-accept-result') ? 1 : null`), 'review action opens B’s exact new delivery');
    await fx.evaluate(`document.querySelector('.thread-relay-accept').checked=true; document.querySelector('.thread-relay-accept-result').click(); true`);
    ok(await fx.waitForEval(`document.querySelectorAll('.thread-relay-edge')[1]?.querySelector('.thread-relay-start') ? 1 : null`), 'acceptance prepares C with B’s new material version');
    await fx.evaluate(`document.querySelectorAll('.thread-relay-edge')[1].querySelector('.thread-relay-start').click(); true`);
    ok(await checkProgress(1), 'real existing C completes through the same UI journey');
    const target = await fx.request('GET', '/api/sessions/' + c);
    ok(target.json.session.id === c && target.json.session.turnSeq === 1, 'C execution preserves the selected existing session identity');
    await fx.evaluate(`document.querySelector('.thread-relay-cancel').click(); true`);
    ok(await fx.waitForEval(`document.querySelector('.thread-relay-cancel')?.disabled ? 1 : null`), 'explicit cancellation is reflected in the saved chain');
    await fx.evaluate(`document.querySelector('.modal-actions button').click(); true`);
    await fx.evaluate(`import('/js/i18n.js').then(m=>m.setLocale('en-US')).then(()=>{document.documentElement.dataset.theme='light'; return true;})`);
    await fx.resize(580, 900);
    await fx.evaluate(`document.getElementById('threadRelayBtn').click(); true`);
    ok(await fx.waitForEval(`document.querySelector('.thread-relay')?.textContent.includes('Choose existing threads') ? 1 : null`), 'English relay controls are usable in the light theme');
    const overflow = await fx.evaluate(`(() => {const panel=document.querySelector('.thread-relay'); return panel ? panel.scrollWidth>panel.clientWidth+2 : true;})()`);
    ok(!overflow, 'narrow relay form wraps exact IDs and material text without horizontal overflow');
    const result = await fx.request('GET', '/api/thread-relays?sessionId=' + a + '&relayId=' + relayId);
    ok(result.json.relays[0].threadRelay.cancelled, 'UI cancellation survives independent HTTP readback');
    ok(fx.exceptions.length === 0, 'relay journey has no uncaught browser exceptions');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { if (fx) await fx.close(); }
  t.done();
})();
