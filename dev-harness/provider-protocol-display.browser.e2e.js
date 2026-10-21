#!/usr/bin/env node
'use strict';
// Real browser/product factories: current engine/chips/capability snapshot and
// recorded message badges. Synthetic local config only; no external accounts.
require('./lib/self-isolate-home.js');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture } = require('./lib/browser-fixture');
const t = createRunner('PROVIDER PROTOCOL DISPLAY'), { ok } = t;
(async () => {
  let fx;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-provider-protocol-display-' });
    const ev = code => fx.evaluate(code);
    await ev(`(async () => {
      const { state } = await import('/js/state.js');
      const i18n = await import('/js/i18n.js'); await i18n.setLocale('zh-CN');
      const { createProviderSettingsDomain } = await import('/js/provider-settings.js');
      const { createQuickSwitchChips } = await import('/js/steward-chips.js');
      const { createNavigationControlsDomain } = await import('/js/navigation-controls.js');
      const { createChatRenderPrimitives } = await import('/js/chat-render-primitives.js');
      const { el } = await import('/js/util.js');
      const { closePopover } = await import('/js/popover.js');
      const originalConfig = state.config, originalSession = state.currentSession, originalFetch = window.fetch;
      const provider = { id: 'protocol-fixture', label: 'Configured Endpoint', type: 'openai-compat', model: 'same-model-id', models: [{ id: 'same-model-id' }], apiStyle: 'anthropic' };
      state.config = { ...originalConfig, activeProvider: provider.id, providers: [provider] };
      state.currentSession = { id: 'protocol_fixture_session', engineRoute: { engine: 'openai', providerId: provider.id, model: provider.model }, messages: [] };
      const domain = createProviderSettingsDomain();
      const nav = createNavigationControlsDomain({ engineLabel: domain.engineLabel, isProviderMode: domain.isProviderMode, currentEngineMeta: domain.currentEngineMeta });
      const primitives = createChatRenderPrimitives({ state, t: i18n.t, tCount: i18n.tCount, el, engineVisual: domain.engineVisual, currentEngineMeta: domain.currentEngineMeta, fmtTime: () => '' });
      const host = document.createElement('section'); host.id = 'protocol-display-fixture';
      Object.assign(host.style, { position: 'fixed', left: '20px', top: '20px', width: '800px', zIndex: '20000', background: 'var(--panel)' });
      const chipHost = document.createElement('div'), status = document.createElement('span'); status.id = 'protocol-current-status';
      const badgeHost = document.createElement('div'), anchor = document.createElement('button'); anchor.textContent = 'capability fixture';
      host.append(status, chipHost, badgeHost, anchor); document.body.append(host);
      let writes = 0;
      const chips = createQuickSwitchChips({ state, t: i18n.t, api: async () => { writes++; throw Error('Display must not change selection'); } }); chips.mount(chipHost);
      const sample = { state, i18n, domain, nav, primitives, chips, host, status, chipHost, badgeHost, anchor, provider, closePopover,
        originalConfig, originalSession, originalFetch, packet: null, writes: () => writes };
      window.__protocolDisplay = sample;
      window.fetch = (input, init) => String(typeof input === 'string' ? input : input.url).includes('/api/capabilities')
        ? Promise.resolve(new Response(JSON.stringify(sample.packet), { status: 200, headers: { 'content-type': 'application/json' } })) : originalFetch.call(window, input, init);
      sample.render = style => { provider.apiStyle = style; chips.setSession(state.currentSession); status.textContent = domain.engineLabel(); status.title = domain.engineLabel(); };
      sample.capability = async style => {
        sample.closePopover();
        sample.packet = { ok: true, engine: 'openai', provider: { id: 'global-capability-endpoint', ...(style === undefined ? {} : { apiStyle: style }) }, network: { online: true }, binaries: {}, desktopMcp: {} };
        await nav.fetchCapabilities(true); nav.openCapPopover(anchor);
      };
      return true;
    })()`);
    const styles = ['chat', 'responses', 'anthropic'];
    for (const locale of ['zh-CN', 'en-US']) {
      await ev(`window.__protocolDisplay.i18n.setLocale(${JSON.stringify(locale)}).then(() => true)`);
      for (let index = 0; index < styles.length; index++) {
        const style = styles[index], capStyle = styles[(index + 1) % styles.length];
        const facts = await ev(`(async () => {
          const c = window.__protocolDisplay; c.render(${JSON.stringify(style)});
          const { providerApiStyleMeta } = await import('/js/provider-api-styles.js');
          const expected = 'Configured Endpoint · ' + c.i18n.t(providerApiStyleMeta(${JSON.stringify(style)}).labelKey);
          const chip = c.chipHost.querySelector('[data-chip="engine"] .steward-chip-value');
          const routeBefore = JSON.stringify(c.state.currentSession.engineRoute);
          c.chipHost.querySelector('[data-chip="engine"]').click();
          const menu = c.chipHost.querySelector('[data-chip="engine"]').parentElement.querySelector('.steward-chip-menu');
          const menuLabel = menu && menu.textContent.includes(expected); c.chips.closeMenu();
          c.badgeHost.replaceChildren(c.primitives.messageShell('assistant', '', { engine: 'openai', providerId: 'recorded-endpoint', providerLabel: 'Recorded historical endpoint', model: 'same-model-id' }).row);
          await c.capability(${JSON.stringify(capStyle)});
          const rows = [...document.querySelectorAll('.cap-pop .cap-item')];
          const capRow = rows.find(row => row.querySelector('.cap-k')?.textContent === c.i18n.t('capability.engine.label'));
          return { expected, status: c.status.textContent, statusTitle: c.status.title, chip: chip.textContent, chipTitle: chip.title, menuLabel,
            cap: capRow?.querySelector('.cap-v')?.textContent, expectedCap: c.i18n.t('capability.engine.providerNative') + ' · ' + c.i18n.t(providerApiStyleMeta(${JSON.stringify(capStyle)}).labelKey),
            history: c.badgeHost.querySelector('.eng-badge').textContent, routeSame: routeBefore === JSON.stringify(c.state.currentSession.engineRoute), writes: c.writes() };
        })()`);
        ok(facts.status === facts.expected && facts.statusTitle === facts.expected, `${locale}/${style} current engine status follows configured wire protocol`);
        ok(facts.chip === facts.expected && facts.chipTitle === facts.expected && facts.menuLabel, `${locale}/${style} actual chip/title/engine menu agree`);
        ok(facts.cap === facts.expectedCap, `${locale}/${style} capability popover uses its explicit packet protocol rather than current route`);
        ok(facts.history === 'Recorded historical endpoint', `${locale}/${style} historical message badge is not relabeled from current config`);
        ok(facts.routeSame && facts.writes === 0, `${locale}/${style} presentation does not alter selection or call write APIs`);
      }
    }
    for (const style of [undefined, 'unknown-future-protocol']) {
      const expression = style === undefined ? 'undefined' : JSON.stringify(style);
      const result = await ev(`(async () => { const c = window.__protocolDisplay; await c.capability(${expression}); const row = [...document.querySelectorAll('.cap-pop .cap-item')].find(row => row.querySelector('.cap-k')?.textContent === c.i18n.t('capability.engine.label')); return row?.querySelector('.cap-v')?.textContent === c.i18n.t('capability.engine.providerNative'); })()`);
      ok(result, `capability packet ${style === undefined ? 'without protocol' : 'with unrecognized protocol'} retains generic label without guessing`);
    }
    await ev(`(() => { const c = window.__protocolDisplay; c.closePopover(); c.chips.closeMenu(); c.state.config = c.originalConfig; c.state.currentSession = c.originalSession; window.fetch = c.originalFetch; c.host.remove(); delete window.__protocolDisplay; return true; })()`);
  } catch (error) { console.error(error.stack || error); t.fail('uncaught fixture error'); }
  finally { if (fx) await fx.close(); t.done(); }
})();
