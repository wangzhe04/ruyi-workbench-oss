#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 2026-10 设置补全（用户：「把所有能配置的都放进设置页，且要美观」「工具与集成里啥都没有」）的真浏览器件。
// public/js/settings-catalog.js 把修前没有任何控件的约 70 个 config 键画进设置页；本件在真浏览器里逐类走一遍，
// 每一条都读服务端落盘值（GET /api/status），不信界面自己说的：
//   C1 简易档（出厂默认）下「工具与集成」组里集成与 MCP、扩展组件、技能与模板、迁移中心都看得见，迁移中心住自己的页签；
//   C2 拨钮：「允许执行命令」关掉 → allowCommandTools:false 落盘，再打开 → true；
//   C3 数字框按显示单位存：上下文 70% → autoCompactThreshold 0.7；乱填 200 → 钳成 95% 落盘、框里回显 95；
//   C4 依赖置灰：「暂停最多保留」在「等不到答复时先暂停」关着时置灰，打开后可改，分钟换算成毫秒落盘；
//   C5 嵌套键：联网搜索「失败时改用内置搜索」写 searchBackend.fallbackToBuiltin，同一对象里的 type 不被冲掉；
//   C6 「总是允许」清单：预置一条 file_read，页上看得见，点「撤销」后 toolAllowRules 里没了；
//   C7 外部工具权限档：加一条 foo_tool → read 落盘，改成 edit 落盘，移除后没了；
//   C8 主题下拉：选深色 → theme:dark 落盘且 <html data-theme> 当场变；
//   C9 存储与数据：数据目录、保留策略与「查看日志」都在这一页；
//   C10 全程没有未捕获异常、没有 console.error、设置面板没有横向滚动。
// 判定行：`SETTINGS CATALOG BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('SETTINGS CATALOG BROWSER');
const { ok } = t;

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok,
      prefix: 'ruyi-settings-catalog-',
      width: 1440,
      height: 900,
      config: { uiMode: 'simple', theme: 'light', toolAllowRules: { file_read: 'allow' }, searchBackend: { type: 'builtin', baseUrl: '', apiKey: '' } },
    });
    const ev = expr => fx.evaluate(expr);
    const status = async () => { const r = await fx.request('GET', '/api/status'); return (r && r.json && r.json.config) || {}; };
    const waitConfig = async pred => {
      for (let i = 0; i < 150; i++) {
        const c = await status();
        try { if (pred(c)) return c; } catch { /* 还没到 */ }
        await sleep(80);
      }
      return null;
    };
    const switchTab = async stab => {
      await ev(`(() => { document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(g => g.classList.add('is-open')); const b = document.querySelector('#settingsTabs button[data-stab="${stab}"]'); if (b) b.click(); return true; })()`);
      return fx.waitForEval(`(() => { const a = document.querySelector('.settings-tab.active'); return a && a.id === 'stab-${stab}' ? 1 : null; })()`, 100);
    };
    const visible = selector => ev(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return Boolean(n) && n.offsetParent !== null && getComputedStyle(n).display !== 'none'; })()`);
    // 目录控件的 id 由 catalogFieldId 推出：setcat_<键名里的非字母数字换成下划线>。
    const id = key => '#setcat_' + key.replace(/[^A-Za-z0-9]+/g, '_');
    const toggle = (key, checked) => ev(`(() => {
      const n = document.querySelector(${JSON.stringify(id(key))});
      if (!n || n.disabled) return false;
      n.checked = ${checked ? 'true' : 'false'};
      n.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const setValue = (selector, value) => ev(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n || n.disabled) return false;
      n.value = ${JSON.stringify(value)};
      n.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const clickText = (scope, text) => ev(`(() => {
      const b = [...document.querySelectorAll(${JSON.stringify(scope + ' button')})].find(x => x.textContent.trim() === ${JSON.stringify(text)});
      if (!b) return false;
      b.click();
      return true;
    })()`);

    await ev(`(() => { document.getElementById('openSettingsBtn').click(); return true; })()`);
    ok(Boolean(await fx.waitForEval(`(() => !document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 200)), 'C0 设置弹窗打开了');

    /* ═════════ C1 简易档也看得见全部页签 ═════════ */
    ok((await ev(`document.documentElement.getAttribute('data-ui-mode')`)) === 'simple', 'C1a 出厂默认的简易档');
    await ev(`(() => { document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(g => g.classList.add('is-open')); return true; })()`);
    await sleep(120);
    for (const stab of ['integrations', 'toolbox', 'skills', 'migration', 'claude', 'agents', 'advanced', 'storage', 'voice']) {
      ok(await visible(`#settingsTabs button[data-stab="${stab}"]`), `C1b 简易档看得见「${stab}」页签`);
    }
    ok(Boolean(await switchTab('migration')) && Boolean(await fx.waitForEval(`document.querySelector('#stab-migration #migrationCenter') ? 1 : null`, 100)),
      'C1c 迁移中心住自己的页签，切过去就在');

    /* ═════════ C2 拨钮 ═════════ */
    await switchTab('security');
    ok(await visible(id('allowCommandTools')) || await ev(`Boolean(document.querySelector(${JSON.stringify(id('allowCommandTools'))}))`), 'C2a 「允许执行命令」在权限与安全页');
    ok(await toggle('allowCommandTools', false) && Boolean(await waitConfig(c => c.allowCommandTools === false)), 'C2b 关掉 → allowCommandTools:false 落盘');
    ok(await toggle('allowCommandTools', true) && Boolean(await waitConfig(c => c.allowCommandTools === true)), 'C2c 打开 → allowCommandTools:true 落盘');

    /* ═════════ C3 数字框按显示单位存、越界钳位 ═════════ */
    await switchTab('limits');
    ok(await setValue(id('autoCompactThreshold'), '70') && Boolean(await waitConfig(c => c.autoCompactThreshold === 0.7)), 'C3a 上下文 70% → autoCompactThreshold 0.7');
    ok(await setValue(id('autoCompactThreshold'), '200') && Boolean(await waitConfig(c => c.autoCompactThreshold === 0.95)), 'C3b 乱填 200 → 钳成 95% 落盘');
    // 钳位后框里立刻显示落盘的那个数(同一拍同步读:证明是 change 处理器写回的,不是之后的整页回填)。
    const shownAfterClamp = await ev(`(() => { const n = document.querySelector(${JSON.stringify(id('autoCompactThreshold'))}); n.focus(); n.value = '300'; n.dispatchEvent(new Event('change', { bubbles: true })); const v = n.value; n.blur(); return v; })()`);
    ok(shownAfterClamp === '95', `C3b2 乱填 300 → 框里随即显示 95(got ${shownAfterClamp})`);
    ok(Boolean(await fx.waitForEval(`(() => document.querySelector(${JSON.stringify(id('autoCompactThreshold'))}).value === '95' ? 1 : null)()`, 60)), 'C3c 框里回显钳过的 95');
    ok(await setValue(id('memoryRelevanceMaxV1'), '12') && Boolean(await waitConfig(c => c.memoryRelevanceMaxV1 === 12)), 'C3d 记忆容量（折叠段里的数字框）照样即存');

    /* ═════════ C4 依赖置灰 ═════════ */
    await switchTab('security');
    ok(await ev(`document.querySelector(${JSON.stringify(id('autonomyPauseTtlMs'))}).disabled === true`), 'C4a 「等不到答复时先暂停」关着时「暂停最多保留」置灰');
    ok(await toggle('autonomyPauseOnTimeout', true) && Boolean(await waitConfig(c => c.autonomyPauseOnTimeout === true)), 'C4b 打开「等不到答复时先暂停」');
    ok(Boolean(await fx.waitForEval(`document.querySelector(${JSON.stringify(id('autonomyPauseTtlMs'))}).disabled === false ? 1 : null`, 60)), 'C4c 依赖满足后可改');
    ok(await setValue(id('autonomyPauseTtlMs'), '10') && Boolean(await waitConfig(c => c.autonomyPauseTtlMs === 600000)), 'C4d 10 分钟 → 600000 毫秒落盘');

    /* ═════════ C5 嵌套键 ═════════ */
    await switchTab('network');
    ok(await toggle('searchBackend.fallbackToBuiltin', true)
      && Boolean(await waitConfig(c => c.searchBackend && c.searchBackend.fallbackToBuiltin === true && c.searchBackend.type === 'builtin')),
      'C5 「失败时改用内置搜索」写进 searchBackend，同一对象里的 type 原样保留');

    /* ═════════ C6 「总是允许」清单 ═════════ */
    await switchTab('security');
    ok(await ev(`[...document.querySelectorAll('#setcat_toolAllowRules .setcat-chip code')].some(n => n.textContent === 'file_read')`), 'C6a 预置的 file_read 在「总是允许」清单里');
    ok(await clickText('#setcat_toolAllowRules', '撤销') && Boolean(await waitConfig(c => !(c.toolAllowRules && c.toolAllowRules.file_read))), 'C6b 点「撤销」→ toolAllowRules 里没了');
    ok(Boolean(await fx.waitForEval(`document.querySelector('#setcat_toolAllowRules .setcat-empty') ? 1 : null`, 60)), 'C6c 清单回到空态');

    /* ═════════ C7 外部工具权限档 ═════════ */
    ok(await ev(`(() => {
      const host = document.getElementById('setcat_bridgedToolTiers');
      host.querySelector('.setcat-tier-name').value = 'foo_tool';
      host.querySelector('.setcat-tier-add select').value = 'read';
      host.querySelector('.setcat-tier-add button').click();
      return true;
    })()`) && Boolean(await waitConfig(c => c.bridgedToolTiers && c.bridgedToolTiers.foo_tool === 'read')), 'C7a 加一条 foo_tool → read 落盘');
    await fx.waitForEval(`document.querySelector('#setcat_bridgedToolTiers .setcat-tier-row select') ? 1 : null`, 60);
    ok(await setValue('#setcat_bridgedToolTiers .setcat-tier-row select', 'edit') && Boolean(await waitConfig(c => c.bridgedToolTiers && c.bridgedToolTiers.foo_tool === 'edit')), 'C7b 改成 edit 落盘');
    ok(await clickText('#setcat_bridgedToolTiers .setcat-tier-row', '移除') && Boolean(await waitConfig(c => !c.bridgedToolTiers || !c.bridgedToolTiers.foo_tool)), 'C7c 移除后没了');

    /* ═════════ C8 主题 ═════════ */
    await switchTab('basic');
    ok(await setValue(id('theme'), 'dark') && Boolean(await waitConfig(c => c.theme === 'dark'))
      && Boolean(await fx.waitForEval(`document.documentElement.getAttribute('data-theme') === 'dark' ? 1 : null`, 60)), 'C8 选深色 → theme:dark 落盘且当场换肤');

    /* ═════════ C9 存储与数据 ═════════ */
    await switchTab('storage');
    for (const sel of ['#advDataRoot', '#openDataDirBtn', '#storagePolicyLogsDays', '#settingsViewLogsBtn', '#settingsExportSessionBtn', '#settingsImportSessionBtn']) {
      ok(Boolean(await ev(`Boolean(document.querySelector('#stab-storage ${sel}'))`)), `C9 「存储与数据」页有 ${sel}`);
    }

    /* ═════════ C10 收尾 ═════════ */
    const overflow = [];
    for (const stab of ['basic', 'security', 'limits', 'steward', 'claude', 'integrations', 'advanced', 'storage']) {
      await switchTab(stab);
      const w = await ev(`(() => { const b = document.getElementById('settingsBody'); return b.scrollWidth - b.clientWidth; })()`);
      if (w > 1) overflow.push(`${stab}:${w}`);
    }
    ok(overflow.length === 0, `C10a 设置面板没有横向滚动（${overflow.join(' ') || '无'}）`);
    ok(fx.exceptions.length === 0, `C10b 页面没有未捕获异常（${fx.exceptions.slice(0, 3).join(' | ') || '无'}）`);
    ok(fx.consoleErrors.length === 0, `C10c 页面没有 console.error（${fx.consoleErrors.slice(0, 3).join(' | ') || '无'}）`);
  } catch (e) {
    t.fail('未捕获异常:' + (e && e.stack || e));
  } finally {
    if (fx) await fx.close();
    t.done({ exit: true });
  }
})();
