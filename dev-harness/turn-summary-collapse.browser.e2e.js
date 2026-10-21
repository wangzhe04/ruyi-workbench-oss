#!/usr/bin/env node
'use strict';
// Real browser + production shared card factory. Static messages and turn_summary
// events call this same factory; this fixture does not fabricate another renderer.
require('./lib/self-isolate-home.js');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture } = require('./lib/browser-fixture');
const t = createRunner('TURN SUMMARY COLLAPSE'), { ok } = t;
(async () => {
  let fx;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-turn-summary-collapse-' });
    const ev = code => fx.evaluate(code);
    await ev(`(async () => {
      const { createSessionExperienceDomain } = await import('/js/session-experience.js');
      const { state } = await import('/js/state.js');
      const { setLocale } = await import('/js/i18n.js');
      await setLocale('zh-CN');
      const originalSession = state.currentSession;
      const domain = createSessionExperienceDomain();
      const host = document.createElement('section'); host.id = 'collapse-fixture';
      Object.assign(host.style, { position: 'fixed', left: '20px', top: '20px', width: '700px', zIndex: '20000', background: 'var(--panel)' });
      document.body.append(host);
      const summary = { turnSeq: 7, commands: 2, filesChanged: [{ path: 'C:/synthetic/card.txt', op: 'modify', revertible: true, entrySeq: 1 }] };
      const render = (sessionId, value = summary) => {
        state.currentSession = { ...(originalSession || {}), id: sessionId, messages: [] };
        const card = domain.turnSummaryCard(value); host.replaceChildren(card); return card;
      };
      window.__collapse = { state, originalSession, domain, host, summary, render };
      render('collapse_session_a'); return true;
    })()`);
    const card = `document.querySelector('#collapse-fixture .turn-summary')`;
    const toggle = `${card}.querySelector('.ts-toggle')`;
    const body = `${card}.querySelector('.turn-summary-body')`;
    ok(await ev(`${toggle}.getAttribute('aria-expanded') === 'true' && !${body}.hidden`), 'A1 card defaults expanded');
    ok(await ev(`${toggle}.tagName === 'BUTTON' && ${toggle}.type === 'button' && ${toggle}.getAttribute('aria-controls') === ${body}.id`), 'A2 native button controls the correct body');
    await ev(`(() => { const undo = ${card}.querySelector('.ts-undo'); undo.disabled = true; undo.textContent = 'pending rollback'; window.__collapse.undo = undo; ${toggle}.click(); return true; })()`);
    ok(await ev(`${toggle}.getAttribute('aria-expanded') === 'false' && getComputedStyle(${body}).display === 'none'`), 'A3 collapse hides the file list despite its flex layout');
    ok(await ev(`${toggle}.textContent.includes('本轮变更') && ${toggle}.textContent.includes('1') && ${toggle}.textContent.includes('2') && ${card}.querySelector('.ts-undo-all').getClientRects().length > 0`), 'A4 title, file/command counts and whole-turn action remain visible');
    await ev(`${toggle}.focus(), true`); await fx.enter();
    ok(await ev(`!${body}.hidden && document.activeElement === ${toggle}`), 'A5 Enter expands without losing button focus');
    ok(await ev(`${card}.querySelector('.ts-undo') === window.__collapse.undo && window.__collapse.undo.disabled && window.__collapse.undo.textContent === 'pending rollback'`), 'A6 folding preserves per-file control identity and in-progress state');
    await fx.key(' ', { code: 'Space', keyCode: 32, text: ' ' });
    ok(await ev(`${body}.hidden && ${toggle}.getAttribute('aria-expanded') === 'false'`), 'A7 Space collapses with native keyboard handling');
    await ev(`window.__collapse.render('collapse_session_a'), true`);
    ok(await ev(`${body}.hidden`), 'B1 explicit choice survives a same-session/turn factory rerender');
    await ev(`window.__collapse.render('collapse_session_b'), true`);
    ok(await ev(`!${body}.hidden`), 'B2 another session does not inherit the folded card choice');
    await ev(`window.__collapse.render('collapse_session_a', { ...window.__collapse.summary, turnSeq: 8 }), true`);
    ok(await ev(`!${body}.hidden`), 'B3 a new live-event-shaped turn starts expanded');
    await ev(`window.__collapse.render('collapse_session_a', { ...window.__collapse.summary, filesChanged: [{ ...window.__collapse.summary.filesChanged[0], reverted: true }] }), true`);
    ok(await ev(`${body}.hidden && ${card}.querySelector('.ts-undo-all.done').textContent.includes('已撤销')`), 'B4 already-reverted whole-turn status stays visible while collapsed');
    await ev(`(async () => { const i18n = await import('/js/i18n.js'); await i18n.setLocale('en-US'); window.__collapse.render('collapse_session_a'); return true; })()`);
    ok(await ev(`${body}.hidden && ${toggle}.title === 'Expand'`), 'C1 locale rerender retains the per-card choice and localized action');
    await ev(`(() => { const c = window.__collapse; for (let i = 0; i < 129; i++) { const card = c.render('collapse_capacity_' + i); card.querySelector('.ts-toggle').click(); } c.render('collapse_session_a'); return true; })()`);
    ok(await ev(`!${body}.hidden`), 'C2 bounded card-choice memory evicts old choices instead of becoming a global preference');
    await ev(`(() => { const c = window.__collapse; c.state.currentSession = c.originalSession; c.host.remove(); delete window.__collapse; return true; })()`);
  } catch (error) { console.error(error.stack || error); t.fail('uncaught fixture error'); }
  finally { if (fx) await fx.close(); t.done(); }
})();
