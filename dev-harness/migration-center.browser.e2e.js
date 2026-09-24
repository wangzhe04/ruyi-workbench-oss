#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注);工作台另由公共夹具起在它自己的临时家里
// W2 迁移中心的前端那一半(真浏览器;公共夹具 lib/browser-fixture 起工作台 + 无头 Edge)。
// 现场:夹具的临时家里放一份 ~/.claude/CLAUDE.md(服务起来之后放 —— 由 scan 的自动同步导入,也就有了「没看过」的候选)。
// 判据:
//   M1 迁移区块挂进设置「集成」页签:#stab-integrations 里有 #migrationCenter(index.html 不改,运行时追加)
//   M2 首启卡在工作台视角出现(非模态,不抢焦点)
//   M3 切到管家视角,同一张卡仍然看得见(两个视角都出)
//   M4 「以后再说」→ 卡消失;服务端记了「看过了」(scan.prompt.show=false)
//   M5 刷新页面后卡不再出现
//   M6 打开设置 → 集成页签:区块渲染出 claude-md 那一行,状态「已导入」;老版本一栏说「没有发现」
//   M7 整个过程页面零未捕获异常
// 判定行:`MIGRATION CENTER BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const CARD = `(() => { const c = document.querySelector('#migrationCardHost .migration-card'); if (!c) return null;
  const r = c.getBoundingClientRect(); const cs = getComputedStyle(c);
  return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' ? { w: Math.round(r.width), focusInside: c.contains(document.activeElement) } : null; })()`;

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-migration-', width: 1280, height: 860,
      config: { uiMode: 'pro' },
      prepare: async f => {
        fs.mkdirSync(path.join(f.home, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(f.home, '.claude', 'CLAUDE.md'), '# 我的规矩\n\nBROWSER_CLAUDE_MD_MARKER 回答一律用中文\n', 'utf8');
      },
    });
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);

    const mounted = await fx.waitForEval(`(() => { const p = document.getElementById('stab-integrations'); const m = document.getElementById('migrationCenter');
      return p && m && p.contains(m) ? 1 : null; })()`, 200);
    ok(Boolean(mounted), 'M1 #migrationCenter 挂进设置「集成」页签 #stab-integrations');

    await fx.setLens('classic');
    const card = await fx.waitForEval(CARD, 400);
    ok(Boolean(card) && card.focusInside === false, 'M2 工作台视角出现首启卡(非模态、没抢焦点)' + (card ? '' : ' → 没出现'));
    const title = await fx.evaluate(`(document.querySelector('#migrationCardHost .quiet-card-title') || {}).textContent || ''`);
    ok(title === zh['migration.card.title'], `M2b 卡片标题是「${zh['migration.card.title']}」(实「${title}」)`);

    await fx.setLens('steward');
    await sleep(300);
    ok(Boolean(await fx.evaluate(CARD)), 'M3 切到管家视角,首启卡仍然看得见');

    await fx.evaluate(`(document.querySelector('#migrationCardHost [data-migration-card="later"]') || { click() {} }).click(), true`);
    const gone = await fx.waitForEval(`document.querySelector('#migrationCardHost .migration-card') ? null : 1`, 200);
    ok(Boolean(gone), 'M4 点「以后再说」卡片消失');
    let seen = false;
    for (let i = 0; i < 50 && !seen; i++) {
      const r = await fx.request('GET', '/api/migration/scan');
      seen = Boolean(r && r.json && r.json.prompt && r.json.prompt.show === false);
      if (!seen) await sleep(100);
    }
    ok(seen, 'M4b 服务端记了「看过了」(scan.prompt.show=false)');

    await fx.cdp.send('Page.reload', {});
    await sleep(800);
    await fx.waitForEval(`(() => window.state && window.state.config && document.getElementById('migrationCenter') ? 1 : null)()`, 400);
    await sleep(3000); // 首启卡的起跑延迟是 1.2 s + 一次 scan;等够它
    ok(!(await fx.evaluate(`Boolean(document.querySelector('#migrationCardHost .migration-card'))`)), 'M5 刷新后首启卡不再出现');

    await fx.setLens('classic');
    await fx.evaluate(`(document.getElementById('openSettingsBtn') || { click() {} }).click(), true`);
    await sleep(300);
    await fx.evaluate(`(document.querySelector('#settingsTabs button[data-stab="integrations"]') || { click() {} }).click(), true`);
    const row = await fx.waitForEval(`(() => { const r = document.querySelector('#migrationCenter .migration-row-instruction[data-key="claude-md"]');
      const chip = r && r.querySelector('.migration-chip'); return chip ? { status: chip.dataset.status, text: chip.textContent } : null; })()`, 400);
    ok(row && row.status === 'imported' && row.text === zh['migration.status.imported'], 'M6 集成页签里渲染出 claude-md 那一行,状态「已导入」' + (row ? '' : ' → 没渲染'));
    const noneText = await fx.evaluate(`(() => { const g = document.querySelector('#migrationCenter [data-group="packages"]'); return g ? g.textContent : ''; })()`);
    ok(noneText.includes(zh['migration.old.none']), 'M6b 老版本一栏如实说「没有发现」');

    ok(fx.exceptions.length === 0, 'M7 页面零未捕获异常' + (fx.exceptions.length ? ' → ' + fx.exceptions.join(' | ') : ''));
  } catch (error) {
    fail += 1;
    console.log('FAIL 夹具/驱动异常: ' + ((error && error.stack) || error));
  } finally {
    if (fx) await fx.close();
  }
  console.log('\nMIGRATION CENTER BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
