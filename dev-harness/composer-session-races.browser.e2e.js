#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home');
// 真页面、隔离家目录：CDP 扣住创建/插话/撤回回包，构造跨会话竞态，不靠请求偶然变慢。
// N 创建迟到、创建逆序、自动创建被取代、创建后的列表请求被取代；
// S 插话成功/no_live_turn 跨会话与 A→B→A、同会话编辑草稿；C 批量/单条撤回的归属。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');
const runner = createRunner('COMPOSER SESSION RACES BROWSER');
const { ok } = runner;

(async () => {
  let fx;
  const ids = {};
  const creates = [], lists = [], steers = [], streams = [], cancellations = [];
  let holdCreates = false, holdList = false;
  const until = async predicate => {
    for (let i = 0; i < 200; i++) { if (predicate()) return true; await sleep(20); }
    throw new Error('held request not observed');
  };
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-composer-session-races-', width: 1440, height: 900,
      prepare: async f => {
        for (const name of ['A', 'B']) {
          const result = await f.request('POST', '/api/sessions', { title: 'Race ' + name, cwd: f.work });
          ids[name] = result.json.session.id;
        }
      },
    });
    await fx.setLens('classic');
    const select = async name => {
      await fx.evaluate(`(() => { window.__selectionBefore = window.state.currentSession; const n = document.querySelector('#railList .steward-board-thread[data-session-id="${ids[name]}"] .steward-board-thread-title'); if (!n) throw new Error('missing rail row'); n.click(); return true; })()`);
      if (!await fx.waitForEval(`window.state.currentSession !== window.__selectionBefore && window.state.currentSession?.id === ${JSON.stringify(ids[name])} ? 1 : null`)) throw new Error('selection not completed');
    };
    const draft = text => fx.evaluate(`(() => { const n = document.getElementById('promptInput'); n.value = ${JSON.stringify(text)}; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const snapshot = () => fx.evaluate(`({ sid: window.state.currentSession?.id, draft: document.getElementById('promptInput').value, rows: [...document.querySelectorAll('[data-steered="true"]')].map(n => n.textContent), queue: document.getElementById('composerHint').textContent, saved: localStorage.getItem('wcw.draft') })`);
    await select('A');
    await fx.evaluate(`(() => { const raw = window.fetch; window.__jsonSettled = []; window.fetch = async (...args) => { const response = await raw(...args); const json = response.json.bind(response); response.json = async () => { try { return await json(); } finally { window.__jsonSettled.push({ url: String(args[0]), method: args[1]?.method || 'GET' }); } }; return response; }; return true; })()`);
    const settledCount = (url, method) => fx.evaluate(`window.__jsonSettled.filter(r => r.url === ${JSON.stringify(url)} && r.method === ${JSON.stringify(method)}).length`);
    const waitSettled = (url, method, before) => fx.waitForEval(`window.__jsonSettled.filter(r => r.url === ${JSON.stringify(url)} && r.method === ${JSON.stringify(method)}).length > ${before} ? 1 : null`);

    fx.cdp.on('Fetch.requestPaused', async event => {
      const url = new URL(event.request.url).pathname;
      const method = event.request.method;
      const id = event.requestId;
      try {
        if (url === '/api/sessions' && method === 'POST' && holdCreates) {
          const raw = await fx.cdp.send('Fetch.getResponseBody', { requestId: id });
          const body = JSON.parse(raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString('utf8') : raw.body);
          creates.push({ id, session: body.session });
        } else if (url === '/api/sessions' && method === 'GET' && holdList) lists.push(id);
        else if (url === '/api/steer') {
          const request = { id, body: JSON.parse(event.request.postData), method };
          if (method === 'DELETE') cancellations.push(request); else steers.push(request);
        } else {
          if (url === '/api/chat/stream') streams.push(JSON.parse(event.request.postData));
          await fx.cdp.send('Fetch.continueRequest', { requestId: id });
        }
      } catch (error) { runner.fail('CDP pause: ' + error.message); }
    });
    await fx.cdp.send('Fetch.enable', { patterns: [
      { urlPattern: '*/api/sessions', requestStage: 'Response' },
      { urlPattern: '*/api/steer', requestStage: 'Request' },
      { urlPattern: '*/api/chat/stream', requestStage: 'Request' },
    ] });
    const releaseCreate = async item => {
      const before = await settledCount('/api/sessions', 'POST');
      await fx.cdp.send('Fetch.continueRequest', { requestId: item.id });
      if (!await waitSettled('/api/sessions', 'POST', before)) throw new Error('creation did not settle');
    };
    const reply = async (request, result) => {
      const before = await settledCount('/api/steer', request.method);
      await fx.cdp.send('Fetch.fulfillRequest', { requestId: request.id, responseCode: 200, responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from(JSON.stringify(result)).toString('base64') });
      if (!await waitSettled('/api/steer', request.method, before)) throw new Error('steer did not settle');
    };
    const sendSteer = async (text, queued = false) => {
      await fx.evaluate(`(() => { const s = window.state; s.sessionRelay = { sessionId: s.currentSession.id, live: true, channel: 'steer' }; s.streaming = ${queued}; return true; })()`);
      await draft(text);
      const before = steers.length;
      await fx.evaluate(`document.getElementById('sendBtn').click(), true`);
      await until(() => steers.length > before);
      return steers[before];
    };
    const queueSteer = async text => {
      await reply(await sendSteer(text, true), { ok: true, queued: 1 });
      if (!await fx.waitForEval(`document.getElementById('composerHint').textContent.includes(${JSON.stringify(text)}) ? 1 : null`)) throw new Error('steer queue not rendered');
    };

    holdCreates = true;
    await fx.evaluate(`document.getElementById('newSessionBtn').click(), true`);
    await until(() => creates.length === 1);
    await select('B'); await draft('B draft');
    await releaseCreate(creates[0]);
    let page = await snapshot();
    ok(page.sid === ids.B && page.draft === 'B draft', 'N1 迟到创建不能夺回后来选择的 B');
    ok(await fx.evaluate(`localStorage.getItem('wcw.lastSession')`) === ids.B, 'N1 上次会话仍是用户选的 B');

    await fx.evaluate(`document.getElementById('newSessionBtn').click(), true`);
    await until(() => creates.length === 2);
    await fx.evaluate(`document.getElementById('newSessionBtn').click(), true`);
    await until(() => creates.length === 3);
    await releaseCreate(creates[2]);
    await fx.waitForEval(`window.state.currentSession?.id === ${JSON.stringify(creates[2].session.id)} ? 1 : null`);
    await releaseCreate(creates[1]);
    ok((await snapshot()).sid === creates[2].session.id, 'N2 两次创建逆序回来仍选择最后一次');

    await select('A');
    await fx.evaluate(`window.state.currentSession = null, window.state.sessionRelay = null, true`);
    await draft('automatic original');
    const streamBeforeCreation = streams.length;
    await fx.evaluate(`document.getElementById('sendBtn').click(), true`);
    await until(() => creates.length === 4);
    await select('B'); await draft('B automatic draft');
    await releaseCreate(creates[3]);
    page = await snapshot();
    ok(page.sid === ids.B && page.draft === 'B automatic draft' && streams.length === streamBeforeCreation, 'N3 自动创建被取代后不能把旧话发进 B');

    await select('A');
    await fx.evaluate(`window.state.currentSession = null, window.state.sessionRelay = null, true`);
    await draft('list-wait original');
    await fx.evaluate(`document.getElementById('sendBtn').click(), true`);
    await until(() => creates.length === 5);
    holdList = true; await releaseCreate(creates[4]);
    await until(() => lists.length > 0);
    await select('B'); await draft('B list-wait draft');
    const beforeList = await settledCount('/api/sessions', 'GET');
    const releasedLists = lists.length;
    holdList = false;
    for (const id of lists.splice(0)) await fx.cdp.send('Fetch.continueRequest', { requestId: id });
    if (!await waitSettled('/api/sessions', 'GET', beforeList + releasedLists - 1)) throw new Error('creation list refresh did not settle');
    page = await snapshot();
    ok(page.sid === ids.B && page.draft === 'B list-wait draft' && streams.length === streamBeforeCreation, 'N4 创建后的列表 await 被取代也不能继续发送');
    holdCreates = false;

    await select('A');
    let request = await sendSteer('A stale success');
    await select('B'); await draft('B new draft');
    await reply(request, { ok: true, queued: 1 });
    page = await snapshot();
    ok(page.sid === ids.B && page.draft === 'B new draft' && !page.rows.some(text => text.includes('A stale success')), 'S1 成功插话回包不清 B 草稿、不在 B 画 A 的话');

    await select('A'); request = await sendSteer('A stale fallback');
    await select('B'); await draft('B unsent draft');
    const beforeFallback = streams.length;
    await reply(request, { ok: false, error: { code: 'steer.no_live_turn' } });
    ok((await snapshot()).draft === 'B unsent draft' && streams.length === beforeFallback, 'S2 no_live_turn 迟到不能自动发送 B 的未发送草稿');

    await select('A'); request = await sendSteer('A previous visit');
    await select('B'); await select('A'); await draft('A new visit');
    await reply(request, { ok: true, queued: 1 });
    page = await snapshot();
    ok(page.draft === 'A new visit' && !page.rows.some(text => text.includes('A previous visit')), 'S3 A→B→A 仍不接纳旧现场的回包');

    request = await sendSteer('A sent original'); await draft('A edited draft');
    await reply(request, { ok: true, queued: 1 });
    page = await snapshot();
    ok(page.draft === 'A edited draft' && page.saved === 'A edited draft' && page.rows.some(text => text.includes('A sent original')), 'S4 同会话成功回包保留新草稿、显示发送的原话');
    request = await sendSteer('fallback captured original'); await draft('fallback edited draft');
    await reply(request, { ok: false, error: { code: 'steer.no_live_turn' } });
    await until(() => streams.length > beforeFallback);
    ok(streams[streams.length - 1].sessionId === ids.A && streams[streams.length - 1].message === 'fallback captured original', 'S5 同会话 no_live_turn 重发捕获的原话');
    await fx.waitForEval(`!window.state.streaming ? 1 : null`);
    ok((await snapshot()).draft === 'fallback edited draft', 'S5 新草稿未被重发消费');

    await select('A');
    for (const text of ['cancel first', 'cancel same']) await queueSteer(text);
    const cancellationBefore = cancellations.length;
    await fx.evaluate(`void window.cancelSteer('', true), true`);
    await until(() => cancellations.length > cancellationBefore);
    await select('B'); await queueSteer('cancel same');
    await reply(cancellations[cancellationBefore], { ok: true });
    await until(() => cancellations.length > cancellationBefore + 1);
    await reply(cancellations[cancellationBefore + 1], { ok: true });
    ok(cancellations.slice(cancellationBefore).every(item => item.body.sessionId === ids.A), 'C1 批量撤回跨会话期间每条 DELETE 都属于 A');
    ok((await snapshot()).queue.includes('cancel same'), 'C1 B 的同文插话仍在队列中');

    await select('A'); await queueSteer('single same');
    const singleBefore = cancellations.length;
    await fx.evaluate(`void window.cancelSteer(encodeURIComponent('single same')), true`);
    await until(() => cancellations.length > singleBefore);
    await select('B'); await queueSteer('single same');
    await reply(cancellations[singleBefore], { ok: true });
    ok((await snapshot()).queue.includes('single same'), 'C2 单条撤回迟到回包不能删 B 的同文项');
    await fx.cdp.send('Fetch.disable');
    ok(fx.exceptions.length === 0, '页面无未捕获异常: ' + fx.exceptions.join(' | '));
  } catch (error) { runner.fail(error.stack || error); }
  finally { if (fx) await fx.close({ keepRoot: false }); }
  runner.done({ exit: true });
})();
