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
    await ev(`(() => {
      const c = window.__collapse;
      c.artifactSummary = { turnSeq: 700, commands: 0, filesChanged: [
        { path: 'C:/synthetic/card.txt', op: 'modify', revertible: true, entrySeq: 1 },
        { path: 'C:/synthetic/deleted.md', op: 'delete', revertible: true, entrySeq: 3 },
        { path: 'C:/synthetic/undone.md', op: 'create', reverted: true, revertible: true, entrySeq: 2 }
      ], artifacts: [
        { path: 'C:/synthetic/card.txt', kind: 'text' }, { path: 'c:/synthetic/card.txt', kind: 'text' },
        { path: 'C:/synthetic/generated report.html', kind: 'html' }, { path: 'C:/synthetic/generated report.html', kind: 'html' },
        { path: 'C:/synthetic/undone.md', kind: 'md', reverted: true },
        { path: 'C:/synthetic/<img src=x onerror=alert(1)>.md', kind: 'md' }
      ] };
      c.render('artifact_owner', c.artifactSummary);
      c.originalFetch = window.fetch; c.requests = [];
      window.fetch = async (input, options) => {
        const endpoint = new URL(String(input), location.href).pathname;
        if (endpoint === '/api/file/reveal' || endpoint === '/api/checkpoints/rollback') {
          c.requests.push(JSON.parse(options.body));
          return new Response(JSON.stringify(endpoint === '/api/file/reveal' ? {ok:true} : {ok:true,reverted:[{path:'c:/synthetic/deleted.md'}]}), {status:200,headers:{'content-type':'application/json'}});
        }
        return c.originalFetch(input, options);
      };
      return true;
    })()`);
    ok(await ev(`${card}.querySelectorAll('.turn-summary-file').length === 5 && !document.querySelector('#collapse-fixture .artifact-chip, #collapse-fixture .turn-artifacts')`), 'D1 artifacts and changes share five unique rows without a second chip strip');
    ok(await ev(`${toggle}.textContent.includes('5') && !${card}.querySelector('.turn-summary-empty')`), 'D2 merged count includes outputs that have no journal entry');
    ok(await ev(`(() => { const rows = [...${card}.querySelectorAll('.turn-summary-file')]; const changed = rows.find(r => r.dataset.path.endsWith('card.txt')); const output = rows.find(r => r.dataset.path.endsWith('generated report.html')); return changed.querySelectorAll('.ts-file-action').length === 2 && !!changed.querySelector('button.ts-undo') && output.querySelectorAll('.ts-file-action').length === 2 && !output.querySelector('.ts-undo'); })()`), 'D3 open/reveal join the existing undo action without granting artifact-only undo');
    ok(await ev(`(() => { const rows = [...${card}.querySelectorAll('.turn-summary-file')]; return rows.filter(r => /deleted.md|undone.md/.test(r.dataset.path)).every(r => !r.querySelector('.ts-file-action')) && !${card}.querySelector('img'); })()`), 'D4 deleted and undone creations have no file actions, and filenames remain text');
    await ev(`(() => { const c = window.__collapse; c.state.currentSession = {id:'different_current_session'}; const row = [...${card}.querySelectorAll('.turn-summary-file')].find(r => r.dataset.path.endsWith('generated report.html')); row.querySelector('[data-mode="open"]').click(); row.querySelector('[data-mode="select"]').click(); return true; })()`);
    await fx.waitForEval(`window.__collapse.requests.length === 2`, 100);
    ok(await ev(`window.__collapse.requests.every(r => r.sessionId === 'artifact_owner' && r.path === 'C:/synthetic/generated report.html') && window.__collapse.requests.map(r => r.mode).join(',') === 'open,select'`), 'D5 both buttons call the existing reveal API with exact path and owning session');
    await ev(`(async () => { const c = window.__collapse; const row = [...${card}.querySelectorAll('.turn-summary-file')].find(r => r.dataset.path.endsWith('deleted.md')); await c.domain.rollbackTurn(700, 3, row.querySelector('button.ts-undo'), 'deleted.md'); row.querySelector('[data-mode="open"]').click(); return true; })()`);
    await fx.waitForEval(`window.__collapse.requests.length === 4`, 100);
    ok(await ev(`window.__collapse.requests.slice(2).every(r => r.sessionId === 'artifact_owner') && window.__collapse.requests[2].entrySeq === 3 && window.__collapse.requests[3].path === 'C:/synthetic/deleted.md'`), 'D6 rollback and restored file actions retain card ownership after switching sessions');
    for (const locale of ['zh-CN', 'en-US']) {
      for (const theme of ['light', 'dark']) {
        await ev(`(async () => { const c = window.__collapse; await (await import('/js/i18n.js')).setLocale(${JSON.stringify(locale)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)}); c.host.style.width = '300px'; c.render('artifact_layout_' + ${JSON.stringify(locale + theme)}, c.artifactSummary); return true; })()`);
        ok(await ev(`(() => { const c = ${card}; const bounds = c.getBoundingClientRect(); return c.scrollWidth <= c.clientWidth + 1 && [...c.querySelectorAll('.ts-file-action')].every(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.left >= bounds.left - 1 && r.right <= bounds.right + 1; }); })()`), 'E narrow layout keeps actions visible: ' + locale + '/' + theme);
      }
    }
    if (process.env.RUYI_ARTIFACT_SCREENSHOT) {
      const clip = await ev(`(async () => { const c = window.__collapse; await (await import('/js/i18n.js')).setLocale('zh-CN'); document.documentElement.setAttribute('data-theme','light'); document.documentElement.setAttribute('data-ui-mode','pro'); c.host.style.width='900px'; c.render('artifact_preview', {turnSeq:702,commands:2,filesChanged:[{path:'C:/Work/report.docx',op:'create',revertible:true,entrySeq:1}],artifacts:[{path:'C:/Work/report.docx',kind:'docx'},{path:'C:/Work/data.xlsx',kind:'xlsx'},{path:'C:/Work/preview.png',kind:'img'}]}); const r = c.host.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; })()`);
      require('node:fs').writeFileSync(process.env.RUYI_ARTIFACT_SCREENSHOT, await fx.screenshot(clip));
    }
    await ev(`(() => { const c = window.__collapse; window.fetch = c.originalFetch; c.render('artifact_only', {turnSeq:701, artifacts:[{path:'C:/synthetic/output.pdf',kind:'pdf'}]}); return true; })()`);
    ok(await ev(`${card}.querySelectorAll('.turn-summary-file').length === 1 && !${card}.querySelector('.turn-summary-empty, .ts-undo-all, .ts-undo')`), 'F artifact-only turns show their file without a false empty message or invented rollback');
    await ev(`(() => { const c = window.__collapse; c.state.currentSession = c.originalSession; c.host.remove(); delete window.__collapse; return true; })()`);
  } catch (error) { console.error(error.stack || error); t.fail('uncaught fixture error'); }
  finally { if (fx) await fx.close(); t.done(); }
})();
