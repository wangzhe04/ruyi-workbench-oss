#!/usr/bin/env node
'use strict';
require('../lib/self-isolate-home.js');
// Opt-in actual local model + real browser. This is a UI wiring qualification,
// not the independent quality gate or a desktop installer/air-gap test.
const path = require('node:path');
const fs = require('node:fs');
const { startBrowserFixture, READY } = require('../lib/browser-fixture');
const { createRunner } = require('../lib/harness');
const t = createRunner('SEMANTIC SEARCH BROWSER'), { ok } = t;
const runtime = process.env.RUYI_SEMANTIC_RUNTIME_ROOT;
(async () => {
  let fx;
  try {
    if (!runtime || !path.isAbsolute(runtime) || !fs.existsSync(path.join(runtime, 'package.json'))) {
      throw Error('real local runtime requires an explicit absolute RUYI_SEMANTIC_RUNTIME_ROOT');
    }
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-semantic-browser-',
      config: { semanticRetrievalV1: false, sessionSearchIndexV1: true, privacyModeV1: 'off' },
      serverEnv: { RUYI_SEMANTIC_RUNTIME_ROOT: runtime },
    });
    const original = '忘记口令时使用已绑定邮箱的验证码重设登录密码。';
    const made = await fx.request('POST', '/api/sessions', { title: 'Fixture alpha', cwd: fx.work,
      messages: [{ id: 'synthetic-1', role: 'user', content: original }], providerHistory: [] });
    const sid = made?.json?.session?.id; ok(!!sid, 'S1 synthetic source created');
    if (!sid) throw Error('source creation failed');
    const read = await fx.request('GET', '/api/sessions/' + sid);
    ok(read?.json?.session?.messages?.some(row => row.content === original), 'S2 source re-read through real API');
    await fx.evaluate('window.__semanticReloadPending = true; location.reload(); true');
    await fx.waitForEval("!window.__semanticReloadPending && document.readyState === 'complete' && document.getElementById('sessionSearch') ? true : null");
    if (!await fx.waitForEval(READY)) throw Error('reloaded application did not become ready');
    await fx.evaluate(`(() => {
      const realFetch = window.fetch; window.__semanticSearchResponses = [];
      window.fetch = async (...args) => {
        const result = await realFetch(...args);
        if (String(args[0]).includes('/api/sessions/search?')) window.__semanticSearchResponses.push(await result.clone().json());
        return result;
      }; return true;
    })()`);
    async function enter(text) {
      await fx.evaluate(`(() => { window.__semanticSearchResponses = []; const input = document.getElementById('sessionSearch'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', {bubbles:true})); return true; })()`);
    }
    const query = 'I cannot remember the credential for signing in.';
    await enter(query);
    const disabled = await fx.waitForEval("window.__semanticSearchResponses.find(row => row.semantic?.status === 'disabled') || null");
    ok(!!disabled && !disabled.results.some(row => row.id === sid), 'S3 disabled model does not fabricate a cross-language match');
    const enabled = await fx.request('POST', '/api/config', { semanticRetrievalV1: true });
    ok(enabled?.status === 200, 'S4 existing configuration enables local semantics');
    await enter(query);
    const ready = await fx.waitForEval("window.__semanticSearchResponses.find(row => row.semantic?.status === 'ready' && row.semantic.coverage === 'complete') || null", 1200);
    const hit = ready?.results?.find(row => row.id === sid);
    ok(hit?.reference?.matchKind === 'semantic' && Number.isFinite(hit.semanticScore), 'S5 UI request reaches actual model and semantic-only source');
    const displayed = await fx.waitForEval(`document.querySelector('#railList [data-session-id="${sid}"] .rail-search-snippet')?.textContent || null`);
    ok(displayed === original, 'S6 real browser shows the exact original excerpt');
    const coverage = await fx.evaluate("document.getElementById('sessionSearchCoverage')?.textContent || ''");
    ok(/\d+\D+\d+/.test(coverage), 'S7 accessible coverage accompanies the result');
    const states = await fx.evaluate('window.__semanticSearchResponses.map(row => row.semantic?.status)');
    console.log('REAL SEMANTIC UI STATES ' + JSON.stringify(states));
    await enter('');
    ok(await fx.evaluate("document.getElementById('sessionSearchCoverage').hidden"), 'S8 clearing query removes stale coverage');
    await fx.request('POST', '/api/config', { semanticRetrievalV1: false });
    await enter('验证码');
    const lexical = await fx.waitForEval("window.__semanticSearchResponses.find(row => row.semantic?.status === 'disabled') || null");
    ok(lexical?.results?.some(row => row.id === sid), 'S9 disabled model preserves lexical source retrieval');
    ok(fx.exceptions.length === 0, 'S10 no uncaught browser exceptions');
  } catch (error) { t.fail('fatal: ' + (error.stack || error)); }
  finally { if (fx) await fx.close({keepRoot:t.failures > 0}); t.done({exit:true}); }
})();
