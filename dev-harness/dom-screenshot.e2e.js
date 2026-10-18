'use strict';
require('./lib/self-isolate-home.js');
// Classic shell visual regression: real app, fixed offline provider/workspace, real-time CDP readiness.
// The old CLI virtual-time capture raced initialization and photographed loading/health suggestions.
// Keep the original 12x8 grid and default thresholds. Review both PNGs before --update.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { signature, compare } = require('./lib/png-grid');
const t = createRunner('DOM-SCREENSHOT'), { ok } = t;
const BASELINE = path.join(__dirname, 'visual-baselines', 'workbench-shell-v2.json');
const update = process.argv.includes('--update');

(async () => {
  let fx;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-visual-v2-', width: 1440, height: 1000,
      config: { theme: 'dark', permissionMode: 'default' },
      prepare: async f => { fs.writeFileSync(path.join(f.work, 'visual-fixture.txt'), 'Fixed offline visual fixture.\n'); },
    });
    ok(Boolean(await fx.setLens('classic')), 'classic shell selected');
    await fx.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await fx.evaluate(`(() => {
      const style = document.createElement('style');
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
      document.head.appendChild(style); return true;
    })()`);
    // Never hide loading/failure notices to make a baseline: wait for real authoritative initialization.
    ok(Boolean(await fx.waitForEval(`(() => {
      const loading = document.querySelector('#stewardBoardReadHealth .workflow-read-health');
      return !loading && document.getElementById('fileTree')?.textContent.includes('visual-fixture.txt');
    })()`)), 'authoritative reads settled and fixture file visible');
    ok(Boolean(await fx.waitForEval(`document.querySelectorAll('#messages .pb-card').length > 0`)), 'offline Playbook cards loaded before capturing either theme');
    await fx.evaluate('document.fonts.ready.then(() => true)');
    const actual = { generatedAt: new Date().toISOString(), viewport: '1440x1000',
      fixture: 'offline-provider-classic-ready-v3', themes: {} };
    const pngs = {};
    for (const theme of ['dark', 'light']) {
      if ((await fx.evaluate(`document.documentElement.dataset.theme`)) !== theme) {
        await fx.evaluate(`document.getElementById('themeToggle').click(), true`);
      }
      ok(Boolean(await fx.waitForEval(`document.documentElement.dataset.theme === '${theme}'`)), `${theme} theme selected`);
      await fx.evaluate(`(() => { document.getElementById('appGearMenu').hidden=true; document.activeElement?.blur(); return true; })()`);
      let previous = '', steady = false, png;
      for (let i = 0; i < 8 && !steady; i++) {
        await sleep(300);
        png = await fx.screenshot();
        const grid = JSON.stringify(signature(png).grid);
        steady = grid === previous; previous = grid;
      }
      ok(steady && png.length > 10000, `${theme} screenshot captured after two matching grids`);
      pngs[theme] = png;
      actual.themes[theme] = { ...signature(png), sha256: crypto.createHash('sha256').update(png).digest('hex') };
      fs.writeFileSync(path.join(fx.root, theme + '.png'), png);
    }
    const distance = compare(actual.themes.dark, actual.themes.light);
    ok(!distance.ok && distance.mean > 20, `light/dark are materially distinct (mean delta ${distance.mean.toFixed(1)})`);
    ok(fx.exceptions.length === 0, `no uncaught browser errors (${fx.exceptions.join(' | ')})`);
    if (update) {
      if (t.failures) throw new Error('Refusing to update visual baselines from an unready or failed fixture');
      fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + '\n');
      for (const theme of ['dark', 'light']) fs.writeFileSync(BASELINE.replace(/\.json$/, `-${theme}.png`), pngs[theme]);
      console.log('UPDATED ' + BASELINE);
    } else {
      const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
      for (const theme of ['dark', 'light']) {
        const result = compare(actual.themes[theme], baseline.themes[theme]);
        ok(result.ok, `${theme} pixel-grid matches baseline (mean ${result.mean.toFixed(2)}, changed ${result.changed}/${result.cells})`);
      }
    }
    console.log('ARTIFACTS ' + fx.root);
  } catch (error) { t.fail(String(error.stack || error)); }
  finally { if (fx) await fx.close({ keepRoot: t.failures > 0 }); }
  t.done({ exit: true });
})();
