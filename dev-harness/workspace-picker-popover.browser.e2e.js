#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：工作文件夹选择弹层（顶栏 #workspacePicker）—— 3.0 收口重做（用户：「选择路径的那个界面太古老了，
// 希望现代一点、易用一点」）。修前一行只有一个名字（同名文件夹分不清，完整路径只在悬停提示里），↑↓★ 是文字字形，
// 粘贴错路径只有一闪而过的 toast，原生「浏览」按钮弹的是 XP 时代的树形对话框、也不从当前文件夹打开。
//
// 覆盖：
//   P1 弹层第一项就是「浏览文件夹」主按钮，打开时焦点在它上面；
//   P2 常用工作区每行 = 名字 ＋ 完整路径两行，当前文件夹有「当前」标与 aria-current；
//   P3 行尾三个动作是带 aria-label 的真按钮（图标，不是 ↑↓★ 文字），首行的「上移 / 设为默认」禁用；
//      点「下移」就地调整优先级（config.workspaces 次序变了）且弹层不关；
//   P4 「最近用过」只列 recentWorkspaces 里不在常用工作区的那几条；
//   P5 粘贴一个不是绝对路径的东西 → 弹层不关、输入框下就地出现 role=alert 的说明、aria-invalid；再打字说明消失；
//   P6 点「浏览文件夹」→ POST /api/pick-folder 带上 title 与 initialDir（＝当前工作文件夹），原生对话框从当前文件夹打开；
//   P7 粘贴一个合法的绝对路径回车 → 弹层收起、默认工作文件夹换成它（还没有线程时选文件夹＝以后新线程的默认文件夹）。
// 判定行：`WORKSPACE PICKER POPOVER BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

const t = createRunner('WORKSPACE PICKER POPOVER BROWSER');
const { ok } = t;

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-wspick-' });
    const alpha = path.join(fx.root, 'proj-alpha');
    const report = path.join(fx.root, 'My Projects', 'report final');
    const site = path.join(fx.root, 'work', 'ruyi-site');
    const old = path.join(fx.root, 'scratch', 'old-notes');
    const pasted = path.join(fx.root, 'pasted-folder');
    for (const d of [alpha, report, site, old, pasted]) fs.mkdirSync(d, { recursive: true });
    const workspaces = [alpha, report, site].map(p => ({ path: p, read: true, write: true, execute: true }));
    const saved = await fx.request('POST', '/api/config', { workspaces, defaultWorkspace: alpha, recentWorkspaces: [site, old, alpha] });
    ok(Boolean(saved && saved.status === 200), `P0 预置三个常用工作区与一条只在「最近用过」里的文件夹（HTTP ${saved && saved.status}）`);
    await fx.evaluate('location.reload(), true');
    await sleep(300);
    ok(Boolean(await fx.waitForEval(`(window.state && window.state.config && Array.isArray(window.state.config.workspaces) && window.state.config.workspaces.length === 3) ? 1 : null`, 400)), 'P0 页面拿到了新配置');
    ok(Boolean(await fx.setLens('classic')), 'P0 工作台视角');
    // 抓 /api/pick-folder 的请求体（非 Windows 上接口必然回 ok:false，我们只看前端交过去的东西）。
    await fx.evaluate(`(() => {
      window.__pickBodies = [];
      const orig = window.fetch;
      window.fetch = function (input, init) {
        try { if (String(input).includes('/api/pick-folder')) window.__pickBodies.push(String((init && init.body) || '')); } catch { /* 旁路 */ }
        return orig.apply(this, arguments);
      };
      return true;
    })()`);
    const open = async () => {
      await fx.evaluate(`(document.getElementById('workspacePicker').click(), true)`);
      return fx.waitForEval(`document.querySelector('.popover .wp-pop') ? 1 : null`, 200);
    };

    ok(Boolean(await open()), 'P1 点顶栏工作文件夹 → 弹层出现');
    await sleep(80);
    const shape = await fx.evaluate(`(() => {
      const pop = document.querySelector('.wp-pop');
      const first = pop.firstElementChild;
      const favRows = [...pop.querySelectorAll('.wp-fav-list:not(.wp-recent-list) .wp-fav-item')];
      const rows = favRows.map(r => ({
        name: (r.querySelector('.wp-fav-name') || {}).textContent || '',
        path: (r.querySelector('.wp-fav-path') || {}).textContent || '',
        current: r.classList.contains('current'),
        badge: Boolean(r.querySelector('.wp-fav-badge')),
        ariaCurrent: (r.querySelector('.wp-fav-main') || { getAttribute: () => '' }).getAttribute('aria-current') || '',
        btns: [...r.querySelectorAll('.wp-fav-btn')].map(b => ({ label: b.getAttribute('aria-label') || '', svg: Boolean(b.querySelector('svg')), text: b.textContent.trim(), disabled: b.disabled })),
      }));
      const recent = [...pop.querySelectorAll('.wp-recent-list .wp-fav-item .wp-fav-path')].map(n => n.textContent);
      return {
        firstIsBrowse: Boolean(first && first.classList.contains('wp-pop-browse')),
        focusOnBrowse: document.activeElement === first,
        rows, recent,
        errHidden: (pop.querySelector('.wp-pop-err') || {}).hidden,
      };
    })()`);
    ok(shape.firstIsBrowse && shape.focusOnBrowse, `P1 第一项是「浏览文件夹」主按钮且打开时焦点在它上面（实测 ${JSON.stringify({ first: shape.firstIsBrowse, focus: shape.focusOnBrowse })}）`);
    ok(shape.rows.length === 3 && shape.rows[0].name === 'proj-alpha' && shape.rows[0].path === alpha && shape.rows[1].path === report && shape.rows[2].path === site,
      `P2 常用工作区每行带完整路径（实测 ${JSON.stringify(shape.rows.map(r => [r.name, r.path]))}）`);
    ok(shape.rows[0].current && shape.rows[0].badge && shape.rows[0].ariaCurrent === 'true' && !shape.rows[1].badge,
      `P2 当前文件夹有「当前」标与 aria-current，别的行没有（实测 ${JSON.stringify(shape.rows.map(r => [r.current, r.badge, r.ariaCurrent]))}）`);
    const btns0 = shape.rows[0].btns;
    ok(btns0.length === 3 && btns0.every(b => b.svg && b.label && !/[↑↓★]/.test(b.text)),
      `P3 行尾三个动作是带 aria-label 的图标按钮（实测 ${JSON.stringify(btns0)}）`);
    ok(btns0[0].disabled && !btns0[1].disabled && btns0[2].disabled && !shape.rows[1].btns[0].disabled,
      `P3 首行的「上移」「设为默认」禁用、「下移」可用（实测 ${JSON.stringify(btns0.map(b => b.disabled))}）`);
    ok(shape.recent.length === 1 && shape.recent[0] === old, `P4 「最近用过」只列不在常用工作区的那条（实测 ${JSON.stringify(shape.recent)}）`);
    ok(shape.errHidden === true, 'P5 打开时没有错误行');

    // P3：点首行「下移」→ 次序变了、弹层还开着。
    await fx.evaluate(`(document.querySelectorAll('.wp-fav-list:not(.wp-recent-list) .wp-fav-item')[0].querySelectorAll('.wp-fav-btn')[1].click(), true)`);
    const moved = await fx.waitForEval(`(() => {
      const ws = (window.state.config.workspaces || []).map(w => w.path);
      const paths = [...document.querySelectorAll('.wp-fav-list:not(.wp-recent-list) .wp-fav-path')].map(n => n.textContent);
      return ws[0] === ${JSON.stringify(report)} && ws[1] === ${JSON.stringify(alpha)} ? { ws, paths, open: Boolean(document.querySelector('.popover .wp-pop')) } : null;
    })()`, 200);
    ok(Boolean(moved) && moved.open && moved.paths[0] === report, `P3 「下移」就地调整优先级、弹层不关（实测 ${JSON.stringify(moved)}）`);

    // P5：粘贴非绝对路径。
    await fx.evaluate(`(() => { const i = document.querySelector('.wp-pop-input'); i.focus(); i.value = 'not-a-path'; return true; })()`);
    await fx.enter();
    const err = await fx.waitForEval(`(() => {
      const e = document.querySelector('.wp-pop-err');
      const i = document.querySelector('.wp-pop-input');
      return e && !e.hidden && e.textContent ? { text: e.textContent, role: e.getAttribute('role'), invalid: i.getAttribute('aria-invalid'), open: Boolean(document.querySelector('.popover .wp-pop')) } : null;
    })()`, 100);
    ok(Boolean(err) && err.role === 'alert' && err.invalid === 'true' && err.open && /绝对路径/.test(err.text),
      `P5 非绝对路径 → 弹层不关、输入框下就地说明（实测 ${JSON.stringify(err)}）`);
    await fx.evaluate(`(() => { const i = document.querySelector('.wp-pop-input'); i.value = 'n'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const cleared = await fx.evaluate(`(() => { const e = document.querySelector('.wp-pop-err'); return { hidden: e.hidden, invalid: document.querySelector('.wp-pop-input').getAttribute('aria-invalid') }; })()`);
    ok(cleared.hidden === true && cleared.invalid === 'false', `P5 再打字说明消失（实测 ${JSON.stringify(cleared)}）`);

    // P6：点「浏览文件夹」→ 请求体带 title 与 initialDir（当前工作文件夹）。
    const current = await fx.evaluate(`(window.state.currentSession && window.state.currentSession.cwd) || window.state.config.defaultWorkspace || ''`);
    await fx.evaluate(`(document.querySelector('.wp-pop-browse').click(), true)`);
    const body = await fx.waitForEval(`window.__pickBodies && window.__pickBodies.length ? window.__pickBodies[0] : null`, 200);
    let parsed = null; try { parsed = JSON.parse(body); } catch { parsed = null; }
    ok(Boolean(parsed) && parsed.initialDir === current && Boolean(current) && /工作文件夹/.test(String(parsed.title || '')),
      `P6 「浏览文件夹」把当前工作文件夹与标题交给原生选择器（实测 ${JSON.stringify({ body, current })}）`);
    ok(!(await fx.evaluate(`Boolean(document.querySelector('.popover .wp-pop'))`)), 'P6 点「浏览」后弹层收起（让位给系统对话框）');

    // P7：粘贴合法绝对路径（带一对包裹引号，与资源管理器「复制文件地址」同形）。
    ok(Boolean(await open()), 'P7 再次打开弹层');
    await fx.evaluate(`(() => { const i = document.querySelector('.wp-pop-input'); i.focus(); i.value = ${JSON.stringify('"' + pasted + '"')}; return true; })()`);
    await fx.enter();
    const switched = await fx.waitForEval(`(() => {
      const open = Boolean(document.querySelector('.popover .wp-pop'));
      const cur = (window.state.currentSession && window.state.currentSession.cwd) || window.state.config.defaultWorkspace || '';
      return !open && cur === ${JSON.stringify(pasted)} ? { cur } : null;
    })()`, 300);
    ok(Boolean(switched), `P7 合法路径回车 → 弹层收起、工作文件夹换成它（实测 ${JSON.stringify(switched)}）`);
    ok(fx.exceptions.length === 0, `P8 全程无页面异常（实测 ${JSON.stringify(fx.exceptions.slice(0, 3))}）`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
})();
