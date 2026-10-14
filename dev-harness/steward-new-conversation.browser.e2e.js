'use strict';
require('./lib/self-isolate-home.js');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, request, sleep } = require('./lib/browser-fixture');
const run = createRunner('STEWARD NEW CONVERSATION BROWSER');
const envelope = say => JSON.stringify({ say, why: 'test', acts: [], actions: [] });
let fx, oldStarted = false;
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-steward-new-browser-', ok: run.ok,
      config: { stewardProviderId: 'fake', stewardConversationRetention: 'forever', desktopMcp: { enabled: false, autodetect: false } },
      provider: async ctx => {
        const user = [...ctx.messages].reverse().find(m => m.role === 'user');
        if (String(user?.content).includes('browser old')) {
          oldStarted = true; ctx.text('{"say":"OLD_REPLY'); await sleep(1000); ctx.text('_LATE","why":"test","acts":[],"actions":[]}'); ctx.stop();
        } else { ctx.text(envelope('FRESH_REPLY')); ctx.stop(); }
      },
    });
    await fx.setLens('steward');
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);
    const control = await fx.waitForEval(`(() => { const b = document.getElementById('stewardNewConversation'); return b && b.offsetParent && !b.disabled && b.textContent.trim(); })()`);
    run.ok(control === zh['stewardShell.chat.newConversation'], 'new conversation is visible directly in conversation header');
    const denied = await request(fx.appPort, 'POST', '/api/steward/reset', {}, 'invalid');
    run.ok(denied?.status === 403, 'HTTP reset rejects an invalid token');
    const get = await fx.request('GET', '/api/steward/reset');
    run.ok(get?.status !== 200, 'reset is POST only');
    const send = text => fx.evaluate(`(() => { const i = document.getElementById('stewardComposerInput'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('stewardComposerSend').click(); return true; })()`);
    await send('browser old');
    for (let i = 0; i < 100 && !oldStarted; i++) await sleep(20);
    run.ok(oldStarted, 'old provider stream is in flight before clicking reset');
    await send('browser queued one'); await send('browser queued two');
    await fx.evaluate(`document.getElementById('stewardNewConversation').click(), true`);
    const reset = await fx.waitForEval(`(() => { const b = document.getElementById('stewardNewConversation'); const feed = document.getElementById('stewardFeed'); return !b.disabled && feed.textContent.includes(${JSON.stringify(zh['stewardShell.chat.newConversationDone'])}); })()`);
    run.ok(Boolean(reset), 'real UI click completes HTTP reset and shows exact context-cleared receipt');
    await sleep(1200);
    const after = await fx.evaluate(`(() => ({ feed: document.getElementById('stewardFeed').textContent, queued: document.querySelectorAll('#stewardFeed .is-queued').length, typing: document.querySelectorAll('#stewardFeed .steward-typing').length, enabled: !document.getElementById('stewardComposerInput').disabled }))()`);
    run.ok(!/browser old|browser queued|OLD_REPLY/.test(after.feed) && after.queued === 0 && after.typing === 0, 'old streamed reply and queued UI rows never refill new conversation');
    run.ok(after.enabled, 'composer is ready after reset');
    const old = await fx.request('GET', '/api/sessions/steward');
    run.ok(old.json?.session?.messages?.length === 0, 'HTTP session is truly empty after UI reset');
    await send('browser fresh');
    run.ok(Boolean(await fx.waitForEval(`document.getElementById('stewardFeed').textContent.includes('FRESH_REPLY')`)), 'new conversation receives a fresh reply');
    run.ok(fx.exceptions.length === 0, 'browser has no uncaught exceptions');
  } catch (error) { run.fail(error.stack || error); }
  finally { if (fx) await fx.close(); run.done(); }
})();
