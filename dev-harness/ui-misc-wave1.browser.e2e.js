#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)

// 真实浏览器 E2E:前端走查第一波「杂项」修复(file-browser / 键盘可达 / 帮助菜单焦点 / 英文界面 / 设置导航)。
// 纯函数与目录判据在 dev-harness/unit/ui-misc-wave1.test.js,服务端那一半在 unit/file-list-browse-links.test.js;
// 本件钉的是「真页面里这些修复真的生效」。
//
//   F 文件树
//     F1  目录行/文件行的结构:目录行 role=button + tabindex=0 + aria-expanded;文件行里可聚焦的是 .ftree-main,
//         @ 与它并列(没有按钮套按钮)
//     F2  文件行与目录行一样高(修前 .ftree-at 继承 tap-min:文件行 52px、目录行 24px)
//     F3  .ftree-name 带 title=完整名
//     F4  键盘:Enter 展开目录(aria-expanded 翻面、子项出现);F5 空格在文件行上打开预览
//     F6  Tab 到 @ 钮时它可见(平时 opacity:0)
//     F7  目录被删后点开:本地化的「文件夹不存在」,不是「(空文件夹)」,也不露服务端中文
//     F8  600 项的目录:排在最后的子文件夹不再消失(maxFiles 放宽)
//     F9  >5000 项:末尾补「只列出前 5000 项」一行
//     F10 指向目录的符号链接(Linux 可建)是目录行、点开能列出目标内容
//     F11 CSV 预览:带引号的逗号不拆、BOM 不进首个表头;恰好 200 行不提示截断,201 行才提示
//   A 键盘可达
//     A1  #contextMeter 是 role=button、tabindex=0、有 aria-label;Enter/空格打开弹层,Esc 关后焦点回它
//     A2  审计行是 role=button,Enter 展开/收起并带 aria-expanded;A3 #auditSourceFilter 有可访问名称
//     A4  toast:err 类停留明显超过 3.2s,普通提示照旧
//   H 帮助菜单焦点
//     H1  键盘打开帮助菜单 → 焦点进第一项;↑↓/Home/End 导航;H3 Esc 关闭后焦点不丢到 body
//     H4  从菜单项打开手册 → Esc 关闭后焦点回 #appGearBtn(修前掉到 body)
//     H6  鼠标路径(触发项随菜单收起而不可见)同样回 #appGearBtn —— modal/help-viewer 的 trigger 回退
//     H5  日志面板:先点的慢请求(100 行)晚到,不能盖掉后发的快请求(500 行);关闭后焦点回 #appGearBtn
//   E 英文界面
//     E1  设置左导航在英文下没有横向溢出(中文同样没有)
//     E2  MCP 兼容性框与「桌面控制」连接器名不露服务端中文
//     E3  命令面板里 CLI 默认模型走本地化的「Default」,不是服务端的「默认 (CLI 配置)」
//     E4  审计行摘要英文化;E5 手册渲染不把硬折行画成 <br>
//
// 判定行:`UI MISC WAVE1 BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep, WB } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('UI MISC WAVE1 BROWSER');
const { ok } = t;
const readLocale = name => JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', name + '.json'), 'utf8'));
const zh = readLocale('zh-CN');
const en = readLocale('en-US');
const THREAD = '杂项走查线程';
const KEY_DOWN = { code: 'ArrowDown', keyCode: 40 };
const KEY_UP = { code: 'ArrowUp', keyCode: 38 };
const KEY_HOME = { code: 'Home', keyCode: 36 };
const KEY_END = { code: 'End', keyCode: 35 };
const KEY_SPACE = { code: 'Space', keyCode: 32, text: ' ' };

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-ui-misc-', config: { uiMode: 'pro' } });
    const W = fx.work;
    const mk = (rel, content = 'x') => { const p = path.join(W, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
    const q = expression => fx.evaluate(expression);
    const waitFor = (expression, attempts = 500) => fx.waitForEval(expression, attempts);
    const press = (key, extra) => fx.key(key, extra);

    /* ── 工作区内容 ── */
    mk('dir-a/inner.txt');
    mk('gone/x.txt');
    mk('plain.txt', 'hello');
    mk('a-very-long-file-name-that-the-tree-will-cut-with-an-ellipsis-0123456789-abcdefghijklmnopqrstuvwxyz.txt');
    for (let i = 0; i < 600; i++) mk(`crowd/f${String(i).padStart(4, '0')}.txt`);
    fs.mkdirSync(path.join(W, 'crowd', 'zzz-sub'));
    fs.mkdirSync(path.join(W, 'big'));
    for (let i = 0; i < 5100; i++) fs.writeFileSync(path.join(W, 'big', `g${String(i).padStart(5, '0')}.txt`), 'x');
    const csvRows = n => Array.from({ length: n }, (_, i) => (i === 0 ? 'id,v' : `r${i},${i}`)).join('\n') + '\n';
    mk('bom-quoted.csv', '﻿name,note\n"Smith, J",ok\n"a ""q"" b","line1\nline2"\n');
    mk('rows200.csv', csvRows(200));
    mk('rows201.csv', csvRows(201));
    let linkMade = false;
    try { fs.symlinkSync(path.join(W, 'dir-a'), path.join(W, 'linkdir'), 'dir'); linkMade = true; } catch { /* Windows 无权限建符号链接:F10 跳过 */ }

    /* ── 进经典视角、开线程、切到「文件」页签 ── */
    // 刚写完 5000 多个文件,机器偶尔忙:建线程的请求超时(fx.request 回 null)就重发,别让夹具的偶发拖红本件。
    let created = null;
    for (let attempt = 0; attempt < 3 && !(created && created.json); attempt++) created = await fx.request('POST', '/api/sessions', { title: THREAD, cwd: W }, 60000);
    ok(Boolean(created && created.json), 'S0 线程已建');
    await q(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    await waitFor(`document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
    await waitFor(`[...document.querySelectorAll('#railList .steward-board-thread')].some(n => n.textContent.includes(${JSON.stringify(THREAD)})) ? 1 : null`, 400);
    await q(`(() => {
      const item = [...document.querySelectorAll('#railList .steward-board-thread')].find(n => n.textContent.includes(${JSON.stringify(THREAD)}));
      if (item) item.querySelector('.steward-board-thread-title').click();
      return true;
    })()`);
    await waitFor(`window.state && window.state.currentSession && window.state.currentSession.title === ${JSON.stringify(THREAD)} ? 1 : null`, 300);
    await q(`(document.querySelector('.tool-pane .tool-tabs button[data-tab="files"]') || { click() {} }).click(), true`);
    await q(`(document.getElementById('fileTreeRefreshBtn') || { click() {} }).click(), true`);
    const treeReady = await waitFor(`(() => { const names = [...document.querySelectorAll('#fileTree > .ftree-row .ftree-name')].map(n => n.textContent); return names.includes('dir-a') && names.includes('plain.txt') ? names : null; })()`, 400);
    ok(Boolean(treeReady), `S1 文件树画出来了(${JSON.stringify(treeReady)})`);

    /* ═════════ F 文件树 ═════════ */
    const shape = await q(`(() => {
      const rows = [...document.querySelectorAll('#fileTree > .ftree-row')];
      const dirs = rows.filter(r => r.getAttribute('role') === 'button');
      const files = rows.filter(r => !r.hasAttribute('role'));
      const tall = rows.map(r => Math.round(r.getBoundingClientRect().height));
      return {
        dirNames: dirs.map(r => r.querySelector('.ftree-name').textContent),
        dirsOk: dirs.every(r => r.getAttribute('tabindex') === '0' && r.getAttribute('aria-expanded') === 'false'),
        filesOk: files.every(r => { const m = r.querySelector(':scope > .ftree-main'); return m && m.getAttribute('role') === 'button' && m.getAttribute('tabindex') === '0' && r.querySelector(':scope > button.ftree-at'); }),
        nested: document.querySelectorAll('#fileTree [role="button"] button, #fileTree button [role="button"]').length,
        dirH: dirs.map(r => Math.round(r.getBoundingClientRect().height)),
        fileH: files.map(r => Math.round(r.getBoundingClientRect().height)),
        maxH: Math.max(...tall),
        titles: [...document.querySelectorAll('#fileTree .ftree-name')].every(n => n.title === n.textContent),
        longTitle: (([...document.querySelectorAll('#fileTree .ftree-name')].find(n => n.textContent.startsWith('a-very-long')) || {}).title || '').length,
      };
    })()`);
    ok(shape.dirNames.includes('dir-a') && shape.dirNames.includes('crowd') && shape.dirsOk, `F1a 目录行 role=button、tabindex=0、aria-expanded=false(${JSON.stringify(shape.dirNames)})`);
    ok(shape.filesOk && shape.nested === 0, `F1b 文件行:.ftree-main 是按钮、@ 并列,没有按钮套按钮(嵌套 ${shape.nested})`);
    ok(shape.maxH <= 34 && Math.abs(Math.max(...shape.fileH) - Math.max(...shape.dirH)) <= 3,
      `F2 文件行与目录行同高、没被 tap-min 撑开(目录 ${Math.max(...shape.dirH)}px / 文件 ${Math.max(...shape.fileH)}px / 最高 ${shape.maxH}px)`);
    ok(shape.titles && shape.longTitle > 60, `F3 .ftree-name 都带 title=完整名(长名 ${shape.longTitle} 字)`);

    // F4 键盘展开目录
    await q(`(() => { const row = [...document.querySelectorAll('#fileTree > .ftree-row[role="button"]')].find(r => r.querySelector('.ftree-name').textContent === 'dir-a'); row.focus(); return true; })()`);
    await fx.enter();
    const expanded = await waitFor(`(() => {
      const row = [...document.querySelectorAll('#fileTree > .ftree-row[role="button"]')].find(r => r.querySelector('.ftree-name').textContent === 'dir-a');
      const kids = row.nextElementSibling;
      const names = [...kids.querySelectorAll('.ftree-name')].map(n => n.textContent);
      return row.getAttribute('aria-expanded') === 'true' && names.includes('inner.txt') ? names : null;
    })()`, 300);
    ok(Boolean(expanded), `F4 键盘 Enter 展开目录:aria-expanded=true 且子项出现(${JSON.stringify(expanded)})`);

    // F5 空格在文件行上打开预览;F6 Tab 到 @ 时它可见
    await q(`(() => { const row = [...document.querySelectorAll('#fileTree > .ftree-row')].find(r => !r.hasAttribute('role') && r.querySelector('.ftree-name').textContent === 'plain.txt'); row.querySelector('.ftree-main').focus(); return true; })()`);
    await press(' ', KEY_SPACE);
    const previewed = await waitFor(`(() => { const box = document.getElementById('filePreview'); return box && !box.classList.contains('hidden') && /plain\\.txt/.test((box.querySelector('.fp-name') || {}).textContent || '') ? 1 : null; })()`, 300);
    ok(Boolean(previewed), 'F5 键盘空格在文件行上打开预览');
    await fx.tab();
    // 按钮基类给 opacity 挂了过渡,Tab 之后要等过渡走完再量(轮询到 1 为止)。
    const atFocus = await waitFor(`(() => { const a = document.activeElement; return a.classList.contains('ftree-at') && getComputedStyle(a).opacity === '1' ? { isAt: true, opacity: '1' } : null; })()`, 100);
    ok(Boolean(atFocus), `F6 Tab 到 @ 钮上它可见(焦点在 @ 且 opacity 终为 1;实 ${JSON.stringify(atFocus || await q(`({ tag: document.activeElement.className, opacity: getComputedStyle(document.activeElement).opacity })`))})`);

    // F7 目录被删后点开
    fs.rmSync(path.join(W, 'gone'), { recursive: true, force: true });
    await q(`(() => { [...document.querySelectorAll('#fileTree > .ftree-row[role="button"]')].find(r => r.querySelector('.ftree-name').textContent === 'gone').click(); return true; })()`);
    const goneText = await waitFor(`(() => {
      const row = [...document.querySelectorAll('#fileTree > .ftree-row[role="button"]')].find(r => r.querySelector('.ftree-name').textContent === 'gone');
      const note = row.nextElementSibling.querySelector('.ftree-empty');
      return note && !/加载中/.test(note.textContent) ? note.textContent : null;
    })()`, 300);
    ok(goneText === zh['file.tree.readFailed'].replace('{{reason}}', zh['file.tree.notFound']),
      `F7 目录读不了:本地化的读取失败(「${goneText}」),不是「${zh['file.tree.empty']}」`);
    ok(!/目录不存在|root/.test(String(goneText)), 'F7b 不露服务端中文原文');

    // F8 600 项的目录里排在最后的子文件夹还在
    await q(`(() => { [...document.querySelectorAll('#fileTree > .ftree-row[role="button"]')].find(r => r.querySelector('.ftree-name').textContent === 'crowd').click(); return true; })()`);
    const crowd = await waitFor(`(() => {
      const row = [...document.querySelectorAll('#fileTree > .ftree-row[role="button"]')].find(r => r.querySelector('.ftree-name').textContent === 'crowd');
      const kids = row.nextElementSibling;
      const names = [...kids.querySelectorAll('.ftree-name')].map(n => n.textContent);
      return names.length > 1 ? { count: names.length, hasSub: names.includes('zzz-sub'), trunc: Boolean(kids.querySelector('.ftree-truncated')) } : null;
    })()`, 300);
    ok(Boolean(crowd) && crowd.count === 601 && crowd.hasSub && !crowd.trunc, `F8 600 项目录列全、zzz-sub 子文件夹还在、不报截断(${JSON.stringify(crowd)})`);

    // F9 >5000 项:提示行
    await q(`(() => { [...document.querySelectorAll('#fileTree > .ftree-row[role="button"]')].find(r => r.querySelector('.ftree-name').textContent === 'big').click(); return true; })()`);
    const big = await waitFor(`(() => {
      const row = [...document.querySelectorAll('#fileTree > .ftree-row[role="button"]')].find(r => r.querySelector('.ftree-name').textContent === 'big');
      const kids = row.nextElementSibling;
      const note = kids.querySelector('.ftree-truncated');
      return note ? { note: note.textContent, rows: kids.querySelectorAll('.ftree-row').length } : null;
    })()`, 600);
    ok(Boolean(big) && big.note === zh['file.tree.truncated'].replace('{{count}}', '5000') && big.rows === 5000,
      `F9 超过 5000 项:末尾提示「${big && big.note}」,前 5000 项照列(${big && big.rows} 行)`);

    // F10 指向目录的符号链接
    if (linkMade) {
      const linkRow = await q(`(() => { const row = [...document.querySelectorAll('#fileTree > .ftree-row')].find(r => r.querySelector('.ftree-name').textContent === 'linkdir'); return row ? row.getAttribute('role') : null; })()`);
      ok(linkRow === 'button', `F10a 指向目录的符号链接画成目录行(role=${linkRow})`);
      await q(`(() => { [...document.querySelectorAll('#fileTree > .ftree-row')].find(r => r.querySelector('.ftree-name').textContent === 'linkdir').click(); return true; })()`);
      const linkKids = await waitFor(`(() => {
        const row = [...document.querySelectorAll('#fileTree > .ftree-row')].find(r => r.querySelector('.ftree-name').textContent === 'linkdir');
        const names = [...row.nextElementSibling.querySelectorAll('.ftree-name')].map(n => n.textContent);
        return names.length ? names : null;
      })()`, 300);
      ok(Array.isArray(linkKids) && linkKids.includes('inner.txt'), `F10b 点开链接目录能列出目标内容(${JSON.stringify(linkKids)})`);
    } else {
      console.log('SKIP F10 本环境建不了符号链接');
    }

    // F11 CSV 预览
    const previewCsv = async name => {
      await q(`(() => { [...document.querySelectorAll('#fileTree > .ftree-row')].find(r => !r.hasAttribute('role') && r.querySelector('.ftree-name').textContent === ${JSON.stringify(name)}).click(); return true; })()`);
      return waitFor(`(() => {
        const box = document.getElementById('filePreview');
        const wrap = box && box.querySelector('.fp-csv-wrap');
        if (!wrap || !new RegExp(${JSON.stringify(name.replace('.', '\\.'))}).test((box.querySelector('.fp-name') || {}).textContent || '')) return null;
        const rows = [...wrap.querySelectorAll('tr')].map(tr => [...tr.children].map(c => c.textContent));
        return { rows, trunc: Boolean(wrap.querySelector('.fp-trunc')) };
      })()`, 300);
    };
    const bom = await previewCsv('bom-quoted.csv');
    ok(Boolean(bom) && bom.rows.length === 3 && bom.rows[0].length === 2 && bom.rows[0][0] === 'name' && bom.rows[0][0].charCodeAt(0) === 110,
      `F11a 表头 2 列、首列是 name(BOM 没混进去)(${JSON.stringify(bom && bom.rows[0])})`);
    ok(Boolean(bom) && bom.rows[1][0] === 'Smith, J' && bom.rows[2][0] === 'a "q" b' && bom.rows[2][1] === 'line1\nline2',
      `F11b 带引号的逗号/引号/换行不拆(${JSON.stringify(bom && bom.rows.slice(1))})`);
    const r200 = await previewCsv('rows200.csv');
    ok(Boolean(r200) && r200.rows.length === 200 && !r200.trunc, `F11c 恰好 200 行:不提示「只显示前 200 行」(${r200 && r200.rows.length} 行,提示 ${r200 && r200.trunc})`);
    const r201 = await previewCsv('rows201.csv');
    ok(Boolean(r201) && r201.rows.length === 200 && r201.trunc, `F11d 201 行:只画 200 行并提示(${r201 && r201.rows.length} 行,提示 ${r201 && r201.trunc})`);

    /* ═════════ A 键盘可达 ═════════ */
    const meter = await q(`(() => { const m = document.getElementById('contextMeter'); return {
      role: m.getAttribute('role'), tab: m.getAttribute('tabindex'), label: m.getAttribute('aria-label') || '', hidden: m.classList.contains('hidden'),
      describedBy: Boolean(document.getElementById(m.getAttribute('aria-describedby') || '__none__')),
    }; })()`);
    ok(meter.role === 'button' && meter.tab === '0' && meter.label === zh['ctx.meter.aria'] && meter.describedBy && !meter.hidden,
      `A1a #contextMeter:role=button、tabindex=0、aria-label、aria-describedby 指得到(${JSON.stringify(meter)})`);
    await q(`(document.getElementById('contextMeter').focus(), true)`);
    await fx.enter();
    const popOpen = await waitFor(`document.querySelector('.popover .ctx-pop') ? 1 : null`, 200);
    ok(Boolean(popOpen), 'A1b 焦点在电量上按 Enter 打开上下文弹层');
    await fx.escape();
    const popGone = await waitFor(`!document.querySelector('.popover .ctx-pop') && document.activeElement.id === 'contextMeter' ? 1 : null`, 200);
    ok(Boolean(popGone), 'A1c Esc 关闭弹层后焦点回到 #contextMeter');
    await press(' ', KEY_SPACE);
    ok(Boolean(await waitFor(`document.querySelector('.popover .ctx-pop') ? 1 : null`, 200)), 'A1d 空格同样打开弹层');
    await fx.escape();
    await waitFor(`!document.querySelector('.popover .ctx-pop') ? 1 : null`, 200);

    await q(`(document.querySelector('.tool-pane .tool-tabs button[data-tab="audit"]') || { click() {} }).click(), true`);
    const audit = await waitFor(`(() => {
      const head = document.querySelector('#auditList .audit-row .audit-head');
      return head ? { role: head.getAttribute('role'), tab: head.getAttribute('tabindex'), expanded: head.getAttribute('aria-expanded'), rows: document.querySelectorAll('#auditList .audit-row').length } : null;
    })()`, 400);
    ok(Boolean(audit) && audit.role === 'button' && audit.tab === '0' && audit.expanded === 'false', `A2a 审计行头 role=button、tabindex=0、aria-expanded=false(${JSON.stringify(audit)})`);
    await q(`(document.querySelector('#auditList .audit-row .audit-head').focus(), true)`);
    await fx.enter();
    const opened = await waitFor(`(() => { const row = document.querySelector('#auditList .audit-row'); return row.classList.contains('open') && row.querySelector('.audit-detail') && row.querySelector('.audit-head').getAttribute('aria-expanded') === 'true' ? 1 : null; })()`, 200);
    ok(Boolean(opened), 'A2b Enter 展开详情(.open、.audit-detail、aria-expanded=true)');
    await fx.enter();
    const closed = await waitFor(`(() => { const row = document.querySelector('#auditList .audit-row'); return !row.classList.contains('open') && !row.querySelector('.audit-detail') && row.querySelector('.audit-head').getAttribute('aria-expanded') === 'false' ? 1 : null; })()`, 200);
    ok(Boolean(closed), 'A2c 再按 Enter 收起');
    const filterName = await q(`document.getElementById('auditSourceFilter').getAttribute('aria-label') || ''`);
    ok(filterName === zh['audit.sourceFilterLabel'], `A3 #auditSourceFilter 有可访问名称(「${filterName}」)`);

    await q(`import('/js/util.js').then(m => { m.toast(${JSON.stringify('长'.repeat(120))}, 'err'); m.toast('短提示', 'ok'); return true; })`);
    await sleep(4300);
    const toasts = await q(`[...document.querySelectorAll('#toastTray .toast')].map(n => n.textContent.slice(0, 4) + '|' + n.className)`);
    ok(toasts.some(x => x.includes('err')) && !toasts.some(x => x.startsWith('短提示')),
      `A4 4.3s 后:长 err 提示还在、普通 ok 提示已消失(${JSON.stringify(toasts)})`);

    /* ═════════ H 帮助菜单焦点 ═════════ */
    const openGear = () => q(`(() => { const m = document.getElementById('appGearMenu'); if (m.hidden) document.getElementById('appGearBtn').click(); return true; })()`);
    const helpItemFocused = () => q(`(document.activeElement && document.activeElement.dataset && document.activeElement.dataset.helpItem) || ''`);
    const openHelpMenuByKeyboard = async () => {
      await openGear();
      await q(`(document.getElementById('helpMenuBtn').focus(), true)`);
      await fx.enter();
      return waitFor(`document.querySelector('.popover .help-menu') ? 1 : null`, 200);
    };
    ok(Boolean(await openHelpMenuByKeyboard()), 'H0 键盘在「帮助」项上按 Enter 打开帮助菜单');
    ok(await helpItemFocused() === 'user-guide', `H1a 打开即聚焦第一项(焦点 ${await helpItemFocused()})`);
    await press('ArrowDown', KEY_DOWN);
    ok(await helpItemFocused() === 'admin-guide', `H1b ↓ 移到第二项(${await helpItemFocused()})`);
    await press('End', KEY_END);
    ok(await helpItemFocused() === 'open-data-dir', `H1c End 到最后一项(${await helpItemFocused()})`);
    await press('ArrowDown', KEY_DOWN);
    ok(await helpItemFocused() === 'user-guide', `H1d 末项再 ↓ 循环回第一项(${await helpItemFocused()})`);
    await press('ArrowUp', KEY_UP);
    ok(await helpItemFocused() === 'open-data-dir', `H1e 首项 ↑ 循环到末项(${await helpItemFocused()})`);
    await press('Home', KEY_HOME);
    ok(await helpItemFocused() === 'user-guide', `H1f Home 回第一项(${await helpItemFocused()})`);
    await fx.escape();
    const afterEsc = await waitFor(`!document.querySelector('.popover .help-menu') ? (document.activeElement && document.activeElement.id || document.activeElement.tagName) : null`, 200);
    ok(afterEsc === 'appGearBtn' || afterEsc === 'helpMenuBtn', `H3 Esc 关闭帮助菜单后焦点没丢到 body(在 ${afterEsc})`);

    // H4:键盘选「使用手册」→ Esc 关闭 → 焦点回齿轮钮
    ok(Boolean(await openHelpMenuByKeyboard()), 'H4a 再次打开帮助菜单');
    await fx.enter();   // 焦点在第一项「使用手册」
    const viewer = await waitFor(`document.querySelector('.help-viewer-backdrop') ? 1 : null`, 300);
    ok(Boolean(viewer), 'H4b Enter 选中「使用手册」,应用内阅读器打开');
    await waitFor(`document.querySelector('.help-viewer-doc') && document.querySelector('.help-viewer-doc').children.length > 1 ? 1 : null`, 300);
    await fx.escape();
    const viewerGone = await waitFor(`!document.querySelector('.help-viewer-backdrop') ? (document.activeElement && document.activeElement.id || document.activeElement.tagName) : null`, 200);
    ok(viewerGone === 'appGearBtn', `H4c 关闭阅读器后焦点回 #appGearBtn(修前掉到 body;实 ${viewerGone})`);

    // H6:鼠标路径 —— 触发项(齿轮菜单里的「帮助」)随菜单收起而不可见
    await openGear();
    await q(`(document.getElementById('helpMenuBtn').focus(), document.getElementById('helpMenuBtn').click(), true)`);
    await waitFor(`document.querySelector('.popover .help-menu') ? 1 : null`, 200);
    await q(`(() => { const first = document.querySelector('.popover .help-menu [data-help-item="user-guide"]'); first.click(); return true; })()`);
    await waitFor(`document.querySelector('.help-viewer-doc') && document.querySelector('.help-viewer-doc').children.length > 1 ? 1 : null`, 300);
    const triggerState = await q(`(() => { const t = document.getElementById('helpMenuBtn'); return { rects: t.getClientRects().length, gearHidden: document.getElementById('appGearMenu').hidden }; })()`);
    ok(triggerState.rects === 0 || triggerState.gearHidden, `H6a 前置:阅读器打开后齿轮菜单收起、触发项不可见(${JSON.stringify(triggerState)})`);
    await fx.escape();
    const mouseBack = await waitFor(`!document.querySelector('.help-viewer-backdrop') ? (document.activeElement && document.activeElement.id || document.activeElement.tagName) : null`, 200);
    ok(mouseBack === 'appGearBtn', `H6b 触发项不可见时关闭阅读器,焦点回 #appGearBtn(实 ${mouseBack})`);

    // H5:日志面板的序号保护 + 关闭后焦点
    await q(`(() => {
      window.__origFetch = window.fetch.bind(window);
      window.fetch = (url, opts) => {
        const u = String(url);
        if (!u.includes('/api/logs/tail')) return window.__origFetch(url, opts);
        const slow = u.includes('lines=100');
        const body = JSON.stringify({ ok: true, file: slow ? 'slow.log' : 'fast.log', lines: [slow ? 'OLD' : 'NEW'] });
        return new Promise(resolve => setTimeout(() => resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })), slow ? 900 : 10));
      };
      return true;
    })()`);
    ok(Boolean(await openHelpMenuByKeyboard()), 'H5a 打开帮助菜单');
    await press('ArrowDown', KEY_DOWN); await press('ArrowDown', KEY_DOWN); await press('ArrowDown', KEY_DOWN);
    ok(await helpItemFocused() === 'view-logs', `H5b ↓↓↓ 到「查看日志」(${await helpItemFocused()})`);
    await fx.enter();
    await waitFor(`document.querySelector('.help-logs-modal') ? 1 : null`, 200);
    await q(`(() => { const sel = document.querySelector('.help-logs-lines'); sel.value = '500'; sel.dispatchEvent(new Event('change')); return true; })()`);
    await sleep(1500);
    const logs = await q(`({ pre: document.querySelector('.help-logs-pre').textContent, file: document.querySelector('.help-logs-file').textContent })`);
    ok(logs.pre === 'NEW' && /fast\.log/.test(logs.file), `H5c 慢的旧响应(100 行)晚到,没盖掉后发的新结果(「${logs.pre}」/「${logs.file}」)`);
    await q(`(window.fetch = window.__origFetch, document.querySelector('.help-logs-foot .primary').click(), true)`);
    const logsGone = await waitFor(`!document.querySelector('.help-logs-modal') ? (document.activeElement && document.activeElement.id || document.activeElement.tagName) : null`, 200);
    ok(logsGone === 'appGearBtn', `H5d 关闭日志面板后焦点回 #appGearBtn(实 ${logsGone})`);

    /* ═════════ E 英文界面 ═════════ */
    // E1 设置导航:中文先量一遍(回归),再切英文量
    await q(`(document.getElementById('openSettingsBtn').click(), true)`);
    await waitFor(`!document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null`, 200);
    const navOverflow = () => q(`(() => {
      for (const label of document.querySelectorAll('#settingsTabs .settings-nav-label')) if (label.getAttribute('aria-expanded') !== 'true') label.click();
      const tabs = document.getElementById('settingsTabs');
      const wide = [...tabs.querySelectorAll('button[data-stab], .settings-nav-label')].filter(b => b.offsetParent !== null && b.scrollWidth > b.clientWidth + 1).map(b => b.textContent.trim());
      return { scroll: tabs.scrollWidth - tabs.clientWidth, wide, count: tabs.querySelectorAll('button[data-stab]').length };
    })()`);
    const zhNav = await navOverflow();
    ok(zhNav.scroll <= 0 && zhNav.wide.length === 0 && zhNav.count >= 15, `E1a 中文设置导航无横向溢出(${JSON.stringify(zhNav)})`);
    await q(`import('/js/i18n.js').then(m => m.setLocale('en-US')).then(() => document.documentElement.lang)`);
    await sleep(300);
    const enNav = await navOverflow();
    ok(enNav.scroll <= 0 && enNav.wide.length === 0, `E1b 英文设置导航无横向溢出(Permissions & safety 等折行;${JSON.stringify(enNav)})`);

    // E2 MCP 兼容性框 / 桌面控制连接器名
    await q(`(() => {
      const orig = window.fetch.bind(window);
      window.__origFetch2 = orig;
      window.fetch = async (url, opts) => {
        const u = String(url);
        if (!/\\/api\\/mcp\\/connectors(\\?|$)/.test(u)) return orig(url, opts);
        const res = await orig(url, opts);
        const json = await res.json();
        json.connectors = [...(json.connectors || []), { id: 'ai-computer-control', label: '桌面控制 (ai-computer-control)', source: 'desktop', builtIn: true, transport: 'stdio', commandOrUrl: 'ai-computer-control', enabled: true, health: { status: 'ok', toolCount: 1 } }];
        return new Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      return true;
    })()`);
    await q(`(document.querySelector('#settingsTabs button[data-stab="integrations"]').click(), document.getElementById('mcpRefreshBtn').click(), true)`);
    const mcp = await waitFor(`(() => {
      const items = [...document.querySelectorAll('#mcpCompatBox .mcp-compat-item')];
      const title = [...document.querySelectorAll('#mcpConnList .mcp-conn-title strong')].map(n => n.textContent);
      return items.length >= 3 && title.length ? { text: items.map(i => i.textContent).join(' | '), title } : null;
    })()`, 300);
    ok(Boolean(mcp) && !/[㐀-鿿]/.test(mcp.text), `E2a MCP 兼容性框无中文(${mcp && mcp.text.slice(0, 160)})`);
    ok(Boolean(mcp) && mcp.text.includes(en['settings.mcp.compat.stdio.limitations']) && mcp.text.includes(en['settings.mcp.compat.http.limitations']),
      'E2b 能力/局限用的是本地化条目');
    ok(Boolean(mcp) && mcp.title.includes(en['settings.mcp.desktopControl.label']) && !mcp.title.some(x => /桌面控制/.test(x)),
      `E2c 桌面控制连接器名本地化(${JSON.stringify(mcp && mcp.title)})`);
    await q(`(window.fetch = window.__origFetch2, document.getElementById('settingsModal').classList.add('hidden'), true)`);

    // E3 命令面板
    const status = await q(`(window.state.status && window.state.status.models && window.state.status.models[0]) || null`);
    ok(Boolean(status) && status.id === '' && /[㐀-鿿]/.test(String(status.label || '')), `E3a 前置:/api/status.models[0] 是 id 为空、label 为服务端中文的默认项(${JSON.stringify(status)})`);
    await q(`(document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })), true)`);
    const palette = await waitFor(`(() => {
      const modal = document.getElementById('paletteModal');
      if (!modal || modal.classList.contains('hidden')) return null;
      const items = [...document.querySelectorAll('#paletteList .palette-item')].map(n => n.textContent);
      return items.length ? items : null;
    })()`, 200);
    const engineRows = (palette || []).filter(x => x.startsWith('Engine'));
    ok(engineRows.some(x => /· Default/.test(x)) && !engineRows.some(x => /默认/.test(x)), `E3b 命令面板里 CLI 默认模型是「Default」,不是服务端中文(${JSON.stringify(engineRows.slice(0, 3))})`);
    await fx.escape();

    // E4 审计行摘要
    await q(`(document.querySelector('.tool-pane .tool-tabs button[data-tab="audit"]') || { click() {} }).click(), true`);
    const summaries = await waitFor(`(() => { const list = [...document.querySelectorAll('#auditList .audit-summary')].map(n => n.textContent); return list.length ? list : null; })()`, 300);
    ok(Boolean(summaries) && summaries.every(x => !/[㐀-鿿]/.test(x)), `E4a 审计行摘要在英文界面没有中文(${JSON.stringify((summaries || []).slice(0, 6))})`);
    ok(Boolean(summaries) && summaries.some(x => x.startsWith(en['audit.kind.server_start'])), `E4b 服务启动那一行是「${en['audit.kind.server_start']}」`);
    const enFilter = await q(`document.getElementById('auditSourceFilter').getAttribute('aria-label')`);
    ok(enFilter === en['audit.sourceFilterLabel'], `E4c 来源过滤的可访问名称跟随语言(${enFilter})`);

    // E5 手册:硬折行不画成 <br>
    ok(Boolean(await openHelpMenuByKeyboard()), 'E5a 英文界面打开帮助菜单');
    await fx.enter();
    const manual = await waitFor(`(() => { const doc = document.querySelector('.help-viewer-doc'); return doc && doc.querySelectorAll('p').length > 5 ? { paras: doc.querySelectorAll('p').length, br: doc.querySelectorAll('br').length } : null; })()`, 400);
    ok(Boolean(manual) && manual.br === 0, `E5b 英文手册里没有由硬折行画出来的 <br>(段落 ${manual && manual.paras},<br> ${manual && manual.br})`);
    await fx.escape();

    ok(fx.exceptions.length === 0, `Z1 页面零未捕获异常(${JSON.stringify(fx.exceptions)})`);
  } catch (error) {
    t.fail('fatal: ' + ((error && error.stack) || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
})();
