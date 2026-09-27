#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：英文 UI 走查（U14/U15/U16）—— 语言切到 en-US 之后，界面不该再露出硬编码中文，
// 复数也不该印成 "1 files"，运行时切语言也不该有文案停在旧语言等下次刷新。
//
// 两个夹具，对应两种不同的现场（不能共用一个：一个要「开局就是 en-US」，一个要「开局 zh-CN、
// 运行时切」，混在一起就分不清是哪句话在测哪件事）：
//   夹具 A（config.locale='en-US'，模拟「切语言 + 刷新页面」）：
//     U14 硬编码中文清零 —— 整页 outerHTML 剥掉 <script>/<!-- --> 之后零 CJK 残留（除两条已登记的
//       后端字面量豁免），另外单点核对 U14 列名的几处；
//     U15 单复数 —— tCount('changes.fileCount', 1) 是 "1 file" 不是 "1 files"。
//   夹具 B（config.locale 缺省＝zh-CN，模拟「运行时切语言，不刷新页面」）：
//     U16 —— POST /api/config 切 locale 后原地 setLocale('en-US')（不重新导航），「一键停机」按钮与
//       管家状态点文案要跟着换新，不是停在旧中文。
//
// 判定行：`LOCALE EN-US BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const cjk = value => typeof value === 'string' && /[一-鿿]/.test(value);

// 扫描白名单：这两处的中文来自服务端 05-claude-engine.js 的字面量数据（预置 Agent 工作流模板全文、
// 品牌名「火山方舟」），不是本刀 i18n 改动的范围 —— 翻译整份工作流模板（含喂给模型的任务提示词）
// 是另一件独立的活，硬约束「不轻易碰 app/src」下不在本刀里做。真出现新的、不在这张表里的中文才算红。
const ALLOWED_SUBSTRINGS = ['Built-in ·', '火山方舟 Ark Coding Plan'];

(async () => {
  let fxA = null;
  let fxB = null;
  try {
    // ══════════ 夹具 A：开局 en-US（切语言 + 刷新） ══════════
    fxA = await startBrowserFixture({ ok, prefix: 'ruyi-locale-en-us-a-', config: { locale: 'en-US' } });
    // READY 只等基础骨架就位，不等 boot() 里那发异步 setLocale(state.config.locale) 落定
    // （它要再拉一次 /locales/en-US.json）——这里额外等 <html lang> 真的翻过来，不然一开始
    // 拍到的还是 zh-CN 首屏，下面的断言全部假红。
    await fxA.waitForEval(`document.documentElement.lang === 'en-US' ? 1 : null`, 300);
    await sleep(200);

    // 用 innerText（不是 outerHTML）扫「真正看得见」的文字 —— innerText 只含渲染树里可见的文本节点，
    // 隐藏对话框(hidden="")、尚未打开过的设置弹层、菜单浮层这些「建了但没画到屏幕上」的节点天然被
    // 排除，不必为它们各自登记豁免理由（那类是懒建内容 refreshStatus() 早于 setLocale 落定那一次
    // 建出来的初值，真打开时会自愈——U14b 那两条断言单独核实这件事，这里不必重复关心它）。
    const visibleText = await fxA.evaluate('document.body.innerText');
    const hits = [];
    for (const m of visibleText.matchAll(/.{0,16}[一-鿿]+.{0,16}/g)) {
      const s = m[0].trim();
      if (ALLOWED_SUBSTRINGS.some(allow => allow.includes(s) || s.includes(allow))) continue;
      hits.push(s);
    }
    ok(hits.length === 0, 'U14 首屏可见文字零硬编码中文残留（除已登记的两条后端字面量豁免）'
      + (hits.length ? ` —— 命中 ${hits.length} 处，例：${JSON.stringify(hits.slice(0, 6))}` : ''));

    const spot = await fxA.evaluate(`(() => {
      const g = (id) => document.getElementById(id);
      const shield = g('stewardShieldBtn');
      const workspacePicker = g('workspacePicker');
      const composerMore = g('composerMoreBtn');
      const attach = document.querySelector('.composer-file');
      const send = g('sendBtn');
      const chips = g('threadChips');
      const resize = g('rightResizeHandle');
      return {
        shieldTitle: shield ? shield.title : '',
        shieldAria: shield ? shield.getAttribute('aria-label') : '',
        workspaceAria: workspacePicker ? workspacePicker.getAttribute('aria-label') : '',
        composerMoreTitle: composerMore ? composerMore.title : '',
        attachTitle: attach ? attach.title : '',
        sendText: send ? send.textContent : '',
        chipsAria: chips ? chips.getAttribute('aria-label') : '',
        resizeTitle: resize ? resize.title : '',
        resizeAria: resize ? resize.getAttribute('aria-label') : '',
      };
    })()`);
    ok(Boolean(spot.shieldTitle) && !cjk(spot.shieldTitle), `U14 safety-mode chip title 无中文（实测 ${JSON.stringify(spot.shieldTitle)}）`);
    ok(Boolean(spot.shieldAria) && !cjk(spot.shieldAria), `U14 safety-mode chip aria-label 无中文（实测 ${JSON.stringify(spot.shieldAria)}）`);
    ok(Boolean(spot.workspaceAria) && !cjk(spot.workspaceAria), `U14 workspacePicker aria-label 无中文（实测 ${JSON.stringify(spot.workspaceAria)}）`);
    ok(!cjk(spot.composerMoreTitle), `U14 composer「更多」title 无中文（实测 ${JSON.stringify(spot.composerMoreTitle)}）`);
    ok(Boolean(spot.attachTitle) && !cjk(spot.attachTitle), `U14 composer「添加文件」title 无中文（实测 ${JSON.stringify(spot.attachTitle)}）`);
    ok(Boolean(spot.sendText) && !cjk(spot.sendText), `U14 composer 发送按钮文案无中文（实测 ${JSON.stringify(spot.sendText)}）`);
    ok(Boolean(spot.chipsAria) && !cjk(spot.chipsAria), `U14 线程头 chips 宿主 aria-label 无中文（实测 ${JSON.stringify(spot.chipsAria)}）`);
    ok(Boolean(spot.resizeTitle) && !cjk(spot.resizeTitle), `U14 右栏拖拽手柄 title 无中文（实测 ${JSON.stringify(spot.resizeTitle)}）`);
    ok(Boolean(spot.resizeAria) && !cjk(spot.resizeAria), `U14 右栏拖拽手柄 aria-label 无中文（实测 ${JSON.stringify(spot.resizeAria)}）`);

    const plural = await fxA.evaluate(`import('/js/i18n.js').then(m => ({ one: m.tCount('changes.fileCount', 1), two: m.tCount('changes.fileCount', 2) }))`);
    ok(plural.one === '1 file', `U15 changes.fileCount 单数是 "1 file"（实测 ${JSON.stringify(plural.one)}）`);
    ok(plural.two === '2 files', `U15 changes.fileCount 复数仍是 "N files"（实测 ${JSON.stringify(plural.two)}）`);

    // 上面 ALLOWED_SUBSTRINGS 放行的「设置页懒建内容 refreshStatus() 早于 setLocale 落定那一次
    // 建出来的初值」到底会不会自愈 —— 不能只靠头注断言，真打开设置页核实一次：openSettingsBtn 的
    // click() 走 navigation-controls.js 的 openModal('settingsModal') -> fillSettings()，
    // 这时 locale 早已是 en-US，「设置」应该已经变成 "Settings"（标题）且空工作区列表是英文。
    await fxA.evaluate(`(() => { const btn = document.getElementById('openSettingsBtn'); if (btn) btn.click(); return true; })()`);
    await sleep(200);
    const settingsHealed = await fxA.evaluate(`(() => ({
      title: (document.querySelector('#settingsModal h3') || {}).textContent || '',
      workspaceEmpty: (document.getElementById('workspacePermList') || {}).textContent || '',
    }))()`);
    ok(!cjk(settingsHealed.title), `U14b 打开一次设置页之后标题自愈成英文（实测 ${JSON.stringify(settingsHealed.title)}）`);
    ok(!cjk(settingsHealed.workspaceEmpty), `U14b 打开一次设置页之后空工作区提示自愈成英文（实测 ${JSON.stringify(settingsHealed.workspaceEmpty)}）`);

    ok(fxA.exceptions.length === 0, `F1a 夹具 A 零未捕获异常（${JSON.stringify(fxA.exceptions)}）`);

    // ══════════ 夹具 B：开局 zh-CN，运行时切到 en-US（不刷新页面） ══════════
    fxB = await startBrowserFixture({ ok, prefix: 'ruyi-locale-en-us-b-' });
    const before = await fxB.evaluate(`(() => ({
      stopBtn: (document.getElementById('stewardStopBtn') || {}).textContent || '',
      presence: (document.getElementById('stewardPresenceText') || {}).textContent || '',
    }))()`);
    ok(cjk(before.stopBtn), `U16 切语言前基线：停机键是中文（实测 ${JSON.stringify(before.stopBtn)}）`);
    ok(cjk(before.presence), `U16 切语言前基线：管家状态点是中文（实测 ${JSON.stringify(before.presence)}）`);

    const saved = await fxB.request('POST', '/api/config', { locale: 'en-US' });
    ok(Boolean(saved && saved.status === 200), 'U16 POST /api/config 切 locale 成功');
    // 只调 i18n.js 的 setLocale（它会 applyTranslations() 再派 i18n:change），不重新导航 —— 这正是
    // 「运行时切语言，没刷新页面」的现场；cfgLocale 下拉走的也是这同一条函数（provider-settings.js）。
    await fxB.evaluate(`import('/js/i18n.js').then(m => m.setLocale('en-US'))`);
    await sleep(300);
    const after = await fxB.evaluate(`(() => ({
      stopBtn: (document.getElementById('stewardStopBtn') || {}).textContent || '',
      presence: (document.getElementById('stewardPresenceText') || {}).textContent || '',
    }))()`);
    ok(!cjk(after.stopBtn), `U16 运行时切语言后「一键停机」按钮不停在旧中文（实测 ${JSON.stringify(after.stopBtn)}）`);
    ok(!cjk(after.presence), `U16 运行时切语言后管家状态点文案不停在旧中文（实测 ${JSON.stringify(after.presence)}）`);

    ok(fxB.exceptions.length === 0, `F1b 夹具 B 零未捕获异常（${JSON.stringify(fxB.exceptions)}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    if (fxA) await fxA.close({ keepRoot: fail > 0 });
    if (fxB) await fxB.close({ keepRoot: fail > 0 });
  }
  console.log('\nLOCALE EN-US BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
