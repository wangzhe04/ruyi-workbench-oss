#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128d(48 号文 §1;47 号文 G3 缺口①):简易模式的真浏览器渲染件。
//
// 出厂默认就是 uiMode='simple'(01-config 的 defaultConfig),而在本件之前 20 件真浏览器测试【全部】把
// uiMode 钉成 'pro' —— 新用户第一眼看到的那一档,零渲染覆盖。本件的配置【不写 uiMode】(走出厂默认),量:
//   S1 出厂默认真的落成简易:<html data-ui-mode="simple">、根字号 15px(简易档 +1px);
//   S2 两个视角都画得出来:宽窄两档视口都没有横向滚动,当前视角的输入框看得见;
//   S3 工作台右栏:「用量」「记录」两枚页签藏起来,其余五枚看得见;原始输出槽 #toolOutput 不显示;
//   S4 设置弹窗:看得见的页签恰好是白名单六枚(基础／管家／服务商／联网搜索／体检／更新中心),其余五枚与
//      「集成」整组藏起来;六枚逐枚点过去,面板真的切过去、不是空的;
//   S5 一个真回合(在简易档的输入框里打字、按 Enter 发送,假 provider 要一次 file_read):工具卡显示人话动词、
//      藏起原始工具名,「详情」折叠头看得见;对照组:切到专家档,同一张卡反过来 —— 证明判据分得清两档;
//   S6 齿轮菜单里的「界面」切换真的落盘(服务端配置 uiMode 跟着变),再切回来也落盘;
//   S7 全程页面上没有未捕获异常、没有 console.error。
// 判定行:`SIMPLE MODE BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const THREAD_TITLE = '简易档那条线程';
const NOTE_TEXT = '简易模式的一行笔记';
const REPLY = '读完了。';
const WIDE_W = 1440;
const WIDE_H = 900;
const NARROW_W = 640;
const NARROW_H = 800;
const SIMPLE_TABS = ['basic', 'steward', 'providers', 'network', 'doctor', 'update'];
const PRO_ONLY_TABS = ['claude', 'agents', 'integrations', 'mcp', 'advanced'];

(async () => {
  let fx = null;
  let notePath = '';
  try {
    fx = await startBrowserFixture({
      ok,
      prefix: 'ruyi-simple-mode-',
      width: WIDE_W,
      height: WIDE_H,
      // 刻意不写 uiMode:量的就是出厂默认。
      config: { uiMode: undefined },
      provider: async ctx => {
        if (!ctx.answered) { ctx.toolCall('file_read', { path: notePath }, 'call_simple_read'); return; }
        ctx.text(REPLY); ctx.stop();
      },
      prepare: async f => {
        notePath = path.join(f.work, 'note.txt');
        fs.writeFileSync(notePath, NOTE_TEXT + '\n', 'utf8');
        const created = await f.request('POST', '/api/sessions', { title: THREAD_TITLE, cwd: f.work });
        f.sid = created && created.json && created.json.session && created.json.session.id;
        ok(Boolean(f.sid), `S0 线程已建(${f.sid})`);
      },
    });
    const ev = expr => fx.evaluate(expr);

    /* ═════════ S1 出厂默认落成简易 ═════════ */
    const mode = await fx.waitForEval(`(() => document.documentElement.getAttribute('data-ui-mode') === 'simple'
      ? { mode: 'simple', font: getComputedStyle(document.documentElement).fontSize, cfg: window.state.config.uiMode } : null)()`, 200);
    ok(Boolean(mode) && mode.cfg === 'simple', `S1 配置里没写 uiMode,出厂默认落成简易(属性 ${mode && mode.mode}、服务端给的 ${mode && mode.cfg})`);
    ok(Boolean(mode) && mode.font === '15px', `S1b 简易档根字号 15px(实 ${mode && mode.font})`);

    /* ═════════ S2 两个视角、宽窄两档都画得出来 ═════════ */
    const fit = composerId => `(() => {
      const root = document.documentElement;
      const input = document.getElementById('${composerId}');
      const b = input ? input.getBoundingClientRect() : null;
      return {
        overflow: root.scrollWidth - root.clientWidth,
        composer: Boolean(b) && b.width > 40 && b.height > 10 && b.right <= root.clientWidth + 1 && b.bottom <= root.clientHeight + 1,
      };
    })()`;
    for (const [lens, composerId] of [['steward', 'stewardComposerInput'], ['classic', 'promptInput']]) {
      ok(Boolean(await fx.setLens(lens)), `S2a 切到${lens === 'steward' ? '管家' : '工作台'}视角`);
      for (const [w, h] of [[WIDE_W, WIDE_H], [NARROW_W, NARROW_H]]) {
        await fx.resize(w, h);
        const got = await ev(fit(composerId));
        ok(got.overflow <= 1 && got.composer,
          `S2 ${lens} 视角 ${w}px:无横向滚动(差 ${got.overflow}px)、输入框 #${composerId} 整个看得见(${got.composer})`);
      }
      await fx.resize(WIDE_W, WIDE_H);
    }

    /* ═════════ S3 工作台右栏 ═════════ */
    // 右栏在宽屏常驻;万一被折起来就先打开(本件量的是页签的藏/显,不是右栏的开合)。
    await ev(`(() => { const pane = document.getElementById('toolPane'); if (pane && pane.offsetParent === null) document.getElementById('toggleToolsBtn')?.click(); return true; })()`);
    await sleep(300);
    const tabs = await ev(`(() => [...document.querySelectorAll('#toolPane .tool-tabs button[data-tab]')].map(b => ({
      tab: b.dataset.tab, display: getComputedStyle(b).display, shown: b.offsetParent !== null })))()`);
    const shownTabs = tabs.filter(t => t.shown).map(t => t.tab).sort();
    const hiddenTabs = tabs.filter(t => t.display === 'none').map(t => t.tab).sort();
    ok(JSON.stringify(hiddenTabs) === JSON.stringify(['audit', 'usage']),
      `S3 简易档右栏藏起的页签恰好是「用量」「记录」(实藏 ${JSON.stringify(hiddenTabs)})`);
    ok(['agent-runs', 'artifacts', 'changes', 'files', 'memory'].every(t => shownTabs.includes(t)),
      `S3b 其余五枚看得见(实见 ${JSON.stringify(shownTabs)})`);
    const rawOut = await ev(`getComputedStyle(document.getElementById('toolOutput')).display`);
    ok(rawOut === 'none', `S3c 原始输出槽 #toolOutput 不显示(实 display:${rawOut})`);

    /* ═════════ S4 设置弹窗 ═════════ */
    await ev(`(() => { document.getElementById('appGearBtn').click(); return true; })()`);
    await ev(`(() => { document.getElementById('openSettingsBtn').click(); return true; })()`);
    ok(Boolean(await fx.waitForEval(`(() => !document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 200)),
      'S4a 设置弹窗打开了');
    // 分组导航默认只展开「通用」:先把所有组展开,量的才是「简易档藏了谁」而不是「哪组折着」。
    await ev(`(() => { document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(g => g.classList.add('is-open')); return true; })()`);
    await sleep(150);
    const stabs = await ev(`(() => ({
      buttons: [...document.querySelectorAll('#settingsTabs button[data-stab]')].map(b => ({ stab: b.dataset.stab, shown: b.offsetParent !== null && getComputedStyle(b).display !== 'none' })),
      integrationsGroup: (() => { const g = document.querySelector('#settingsTabs .settings-nav-group[data-group="integrations"]'); return g ? getComputedStyle(g).display : 'missing'; })(),
    }))()`);
    const visibleStabs = stabs.buttons.filter(b => b.shown).map(b => b.stab).sort();
    ok(JSON.stringify(visibleStabs) === JSON.stringify([...SIMPLE_TABS].sort()),
      `S4 看得见的设置页签恰好是白名单六枚(实见 ${JSON.stringify(visibleStabs)})`);
    ok(PRO_ONLY_TABS.every(s => stabs.buttons.some(b => b.stab === s && !b.shown)),
      `S4b 专家页签五枚都在 DOM 里、都藏着(${PRO_ONLY_TABS.join('/')})`);
    ok(stabs.integrationsGroup === 'none', `S4c 「集成」整组藏起来,不留空组头(实 display:${stabs.integrationsGroup})`);
    const switched = [];
    for (const stab of SIMPLE_TABS) {
      await ev(`(() => { document.querySelector('#settingsTabs button[data-stab="${stab}"]').click(); return true; })()`);
      const panel = await fx.waitForEval(`(() => {
        const active = document.querySelector('.settings-tab.active');
        if (!active || active.id !== 'stab-${stab}') return null;
        return { id: active.id, text: (active.innerText || '').trim().length };
      })()`, 100);
      switched.push(`${stab}:${panel ? panel.text : 'x'}`);
      ok(Boolean(panel) && panel.text > 20, `S4d 点「${stab}」面板真的切过去且不是空的(${panel ? panel.text + ' 字' : '没切过去'})`);
    }
    // 专家页签在简易档被 JS 兜底拦回「基础」(死键的反面:藏起来的确实点不到,就算被程序化调用也落回基础)。
    await ev(`(() => { document.querySelector('#settingsTabs button[data-stab="advanced"]').click(); return true; })()`);
    await sleep(150);
    const fallback = await ev(`(document.querySelector('.settings-tab.active') || {}).id || ''`);
    ok(fallback === 'stab-basic', `S4e 程序化点一枚藏着的专家页签,落回「基础」(实 ${fallback})`);
    await fx.escape();
    ok(Boolean(await fx.waitForEval(`(() => document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 100)),
      'S4f Esc 关掉设置弹窗');

    /* ═════════ S5 真回合:简易档的工具卡 ═════════ */
    await ev(`(() => {
      const title = [...document.querySelectorAll('#railList .steward-board-thread-title')].find(n => (n.textContent || '').includes(${JSON.stringify(THREAD_TITLE)}));
      if (title) title.click();
      return Boolean(title);
    })()`);
    ok(Boolean(await fx.waitForEval(`(() => window.state && window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(fx.sid)} ? 1 : null)()`, 300)),
      'S5a 从左栏点开那条线程');
    await ev(`(() => { const i = document.getElementById('promptInput'); i.focus(); return document.activeElement === i; })()`);
    await fx.cdp.send('Input.insertText', { text: '把笔记读一下' });
    await fx.enter();
    const card = await fx.waitForEval(`(() => {
      const card = [...document.querySelectorAll('#messages .tool-card')].find(c => (c.querySelector('.tc-name') || {}).textContent === 'file_read');
      const reply = (document.getElementById('messages').innerText || '').includes(${JSON.stringify(REPLY)});
      if (!card || !reply) return null;
      const show = sel => { const n = card.querySelector(sel); return n ? { display: getComputedStyle(n).display, text: (n.textContent || '').trim() } : null; };
      return { verb: show('.tc-verb'), name: show('.tc-name'), sum: show('.tc-detail > summary.tc-detail-sum') };
    })()`, 1500);
    ok(Boolean(card), 'S5b 回合跑完:工具卡与答复都上屏了');
    ok(Boolean(card) && card.verb && card.verb.display !== 'none' && card.verb.text.length > 0 && card.verb.text !== 'file_read',
      `S5 简易档工具卡显示人话动词(${card && JSON.stringify(card.verb)})`);
    ok(Boolean(card) && card.name && card.name.display === 'none', `S5c 简易档藏起原始工具名(${card && JSON.stringify(card.name)})`);
    ok(Boolean(card) && card.sum && card.sum.display !== 'none', `S5d 简易档「详情」折叠头看得见(${card && JSON.stringify(card.sum)})`);

    /* ═════════ S6 齿轮菜单里的「界面」切换落盘 ═════════ */
    const flip = async expected => {
      await ev(`(() => { document.getElementById('appGearBtn').click(); document.getElementById('uiModeToggle').click(); return true; })()`);
      const attr = await fx.waitForEval(`(() => document.documentElement.getAttribute('data-ui-mode') === '${expected}' ? '${expected}' : null)()`, 100);
      let saved = '';
      for (let i = 0; i < 50 && saved !== expected; i++) {
        const status = await fx.request('GET', '/api/status');
        saved = status && status.json && status.json.config ? status.json.config.uiMode : '';
        if (saved !== expected) await sleep(100);
      }
      return { attr, saved };
    };
    const toPro = await flip('pro');
    ok(toPro.attr === 'pro' && toPro.saved === 'pro', `S6 齿轮菜单切到专家档:属性 ${toPro.attr}、服务端配置 ${toPro.saved}`);
    // S5 的对照组:同一张卡在专家档反过来。
    const proCard = await ev(`(() => {
      const card = [...document.querySelectorAll('#messages .tool-card')].find(c => (c.querySelector('.tc-name') || {}).textContent === 'file_read');
      if (!card) return null;
      return { verb: getComputedStyle(card.querySelector('.tc-verb')).display, name: getComputedStyle(card.querySelector('.tc-name')).display };
    })()`);
    ok(Boolean(proCard) && proCard.verb === 'none' && proCard.name !== 'none',
      `S5e 对照:专家档同一张卡反过来 —— 动词藏、原始名显(${JSON.stringify(proCard)})`);
    const toSimple = await flip('simple');
    ok(toSimple.attr === 'simple' && toSimple.saved === 'simple', `S6b 再切回简易档:属性 ${toSimple.attr}、服务端配置 ${toSimple.saved}`);

    /* ═════════ S7 全程无未捕获异常 ═════════ */
    ok(fx.exceptions.length === 0, `S7 全程页面上没有未捕获异常(实 ${fx.exceptions.length}${fx.exceptions.length ? ':' + fx.exceptions.slice(0, 3).join(' | ') : ''})`);
    ok(fx.consoleErrors.length === 0, `S7b 全程没有 console.error(实 ${fx.consoleErrors.length}${fx.consoleErrors.length ? ':' + fx.consoleErrors.slice(0, 3).join(' | ') : ''})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
    if (fx && fail > 0) console.log('NOTE 失败现场保留在 ' + fx.root);
  }
  console.log(fail === 0 ? 'SIMPLE MODE BROWSER E2E: ALL PASS' : `SIMPLE MODE BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
