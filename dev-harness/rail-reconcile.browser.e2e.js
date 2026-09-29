#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）
// 浏览器 e2e:左栏（js/steward-board.js 的 renderRail）按「件」复用行，不再每拍整栏重建。
// 修前每次 renderRail 都 clear(#railList) 再把每一行重建（300 条会话一次 30–40 ms，自己发一轮对话画六次）；
// 现在每一件先算签名，签名没变就原样留着那几个节点。复用最怕的是【漏了一样输入】—— 左栏停在旧样子比慢更糟，
// 所以本件两头都钉：
//   A 输入没变的重画（搜索框清空那条同步路、i18n:change 那条带复核的路）不摘任何一行、每一行还是原来那个元素
//     （反向验证：换回修前的 renderRail —— clear 再全建 —— A1/A2 当场红）；
//   B 每一类输入变了，左栏都跟着变：行的标题（且别的行不被连带重建）、行的状态（跑完一轮换组）、选中、
//     搜索过滤、视角（管家＝焦点，工作台＝当前会话）、组的折叠、多线程任务的展开、语言。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('RAIL RECONCILE BROWSER');
const { ok } = t;
const LOCALES = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'locales');
const en = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en-US.json'), 'utf8'));
const zh = JSON.parse(fs.readFileSync(path.join(LOCALES, 'zh-CN.json'), 'utf8'));
const PREFIX = 'rail-reconcile-';

// 页内工具：行元素快照（按会话 id／任务 id）与「被摘掉的行」计数。
const INSTALL = `(() => {
  window.__rr = { removed: 0 };
  window.__rrSnap = () => {
    const map = new Map();
    for (const li of document.querySelectorAll('#railList li.steward-board-thread[data-session-id]')) map.set('s:' + li.dataset.sessionId, li);
    for (const li of document.querySelectorAll('#railList li.rail-task[data-mission-id]')) map.set('m:' + li.dataset.missionId, li);
    return map;
  };
  window.__rrSame = snap => {
    const now = window.__rrSnap();
    let same = 0; const changed = [];
    for (const [key, node] of snap) { if (now.get(key) === node && node.isConnected) same += 1; else changed.push(key); }
    return { same, total: snap.size, now: now.size, changed: changed.slice(0, 5) };
  };
  new MutationObserver(list => {
    for (const m of list) for (const n of m.removedNodes) {
      if (n.nodeType === 1 && n.matches('li.steward-board-thread, .rail-group, .rail-threads')) window.__rr.removed += 1;
    }
  }).observe(document.getElementById('railList'), { childList: true, subtree: true });
  return true;
})()`;
const rowSel = id => `#railList li.steward-board-thread[data-session-id="${id}"]`;

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-rail-reconcile-' });
    const create = async title => {
      const r = await fx.request('POST', '/api/sessions', { title, cwd: fx.work });
      return r && r.json && r.json.session ? r.json.session.id : '';
    };
    const ids = [];
    for (let i = 0; i < 24; i++) ids.push(await create(PREFIX + i));
    // 一件两条线程的任务：左栏画成任务行 ＋ 展开容器（另一种「件」）。
    const t1 = await create('拆开的活·甲');
    const t2 = await create('拆开的活·乙');
    const container = await fx.request('POST', '/api/missions', { title: '拆开的活' });
    const missionId = container && container.json && container.json.mission ? container.json.mission.missionId : '';
    for (const id of [t1, t2]) await fx.request('POST', `/api/missions/${encodeURIComponent(missionId)}/threads`, { action: 'attach', sessionId: id });
    ok(ids.every(Boolean) && Boolean(t1 && t2 && missionId), `A0 造好 24 条会话与一件两线程的任务（${missionId}）`);

    await fx.evaluate('location.reload(), true');
    await sleep(800);
    ok(Boolean(await fx.setLens('classic')), 'A0b 工作台视角');
    const ready = await fx.waitForEval(`(() => {
      const n = document.querySelectorAll('#railList li.steward-board-thread[data-session-id]').length;
      return n >= 26 && document.querySelector('#railList li.rail-task[data-mission-id="${missionId}"]') ? n : null;
    })()`, 1500);
    ok(Boolean(ready), `A0c 左栏画出了全部行与那一件任务行（${ready} 行）`);
    await sleep(1500);   // 开机那几发（在场回执、首趟取行）落定
    await fx.evaluate(INSTALL);

    /* ═════ A 输入没变：不摘行、不换元素 ═════ */
    await fx.evaluate(`window.__rrA = window.__rrSnap(), window.__rr.removed = 0, true`);
    // A1 同步那一路：搜索框清空（scheduleSessionSearch → renderSessions({ refresh:false }) → renderRail），连按三次。
    await fx.evaluate(`(() => { const s = document.getElementById('sessionSearch'); for (let i = 0; i < 3; i++) { s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); } return true; })()`);
    const a1 = await fx.evaluate(`({ removed: window.__rr.removed, ...window.__rrSame(window.__rrA) })`);
    ok(a1 && a1.removed === 0 && a1.same === a1.total && a1.total >= 27,
      `A1 输入没变的重画（搜索清空 ×3）不摘任何一行，${a1 && a1.total} 个行元素全是原来那一个（实测 ${JSON.stringify(a1)}）`);
    // A2 带复核的那一路：i18n:change（同语言）→ renderSessions() → syncRail：先按手上的行画、再补一发 /api/missions。
    await fx.evaluate(`window.dispatchEvent(new CustomEvent('i18n:change', { detail: { changed: false } })), true`);
    await sleep(1200);
    const a2 = await fx.evaluate(`({ removed: window.__rr.removed, ...window.__rrSame(window.__rrA) })`);
    ok(a2 && a2.removed === 0 && a2.same === a2.total,
      `A2 重画 ＋ 复核取行（行没变）之后仍然零摘除、元素身份不变（实测 ${JSON.stringify(a2)}）`);

    /* ═════ B 每一类输入变了，左栏都跟着变 ═════ */
    // B1 行的标题：改一条的名字 → 那一行的字变了；别的行不被连带重建（按件对账，不是整栏重来）。
    const [x, y, z, w, v] = [ids[3], ids[5], ids[8], ids[11], ids[14]];
    await fx.evaluate(`window.__rrB = window.__rrSnap(), true`);
    await fx.request('PATCH', `/api/sessions/${encodeURIComponent(x)}`, { title: '改过名的这一条' });
    await fx.evaluate(`window.dispatchEvent(new CustomEvent('i18n:change', { detail: { changed: false } })), true`);
    const b1 = await fx.waitForEval(`(() => {
      const row = document.querySelector('${rowSel(x)} .steward-board-thread-title');
      return row && row.textContent === '改过名的这一条' ? window.__rrSame(window.__rrB) : null;
    })()`, 250);
    ok(Boolean(b1), 'B1 改名之后那一行的标题跟着变了');
    ok(Boolean(b1 && b1.changed.includes('s:' + x) && b1.same >= b1.total - 2),
      `B1b 只有变了的那一行换了元素，其余照旧（实测 ${JSON.stringify(b1)}）`);

    // B2 行的状态：跑完一轮 → 五态与所在组都变（事件流推送 → pushRefreshRows → renderRail）。
    const before2 = await fx.evaluate(`(() => { const r = document.querySelector('${rowSel(z)}'); return r ? { state: r.dataset.state || '', group: r.closest('.rail-group').dataset.group } : null; })()`);
    await fx.request('POST', '/api/chat/stream', { sessionId: z, message: '说一句', cwd: fx.work }, 60000);
    const after2 = await fx.waitForEval(`(() => {
      const r = document.querySelector('${rowSel(z)}');
      if (!r) return null;
      const now = { state: r.dataset.state || '', group: r.closest('.rail-group').dataset.group };
      return now.group !== ${JSON.stringify(before2 && before2.group)} && now.state !== ${JSON.stringify(before2 && before2.state)} ? now : null;
    })()`, 250);
    ok(Boolean(before2 && after2), `B2 跑完一轮之后那一行的状态与所在组跟着变了（${JSON.stringify(before2)} → ${JSON.stringify(after2)}）`);

    // B3 选中（工作台视角＝当前会话）：点 y → y 高亮；再点 w → 高亮挪到 w。
    const selOf = `[...document.querySelectorAll('#railList li.steward-board-thread.is-sel[data-session-id]')].map(n => n.dataset.sessionId)`;
    await fx.evaluate(`document.querySelector('${rowSel(y)} .steward-board-thread-title').click(), true`);
    const b3a = await fx.waitForEval(`(() => { const s = ${selOf}; return s.length === 1 && s[0] === '${y}' ? s : null; })()`, 250);
    await fx.evaluate(`document.querySelector('${rowSel(w)} .steward-board-thread-title').click(), true`);
    const b3b = await fx.waitForEval(`(() => { const s = ${selOf}; return s.length === 1 && s[0] === '${w}' ? s : null; })()`, 250);
    ok(Boolean(b3a && b3b), `B3 选中跟着当前会话走（先 y 后 w，各只有一行高亮；${JSON.stringify(b3a)} → ${JSON.stringify(b3b)}）`);

    // B4 搜索过滤：输入一条的完整名字 → 只剩它；清空 → 全部回来。
    const threadCount = `document.querySelectorAll('#railList li.steward-board-thread[data-session-id]').length`;
    const full = await fx.evaluate(threadCount);
    await fx.evaluate(`(() => { const s = document.getElementById('sessionSearch'); s.value = '${PREFIX}7'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const b4a = await fx.waitForEval(`(() => { const rows = [...document.querySelectorAll('#railList li.steward-board-thread[data-session-id]')]; return rows.length === 1 && rows[0].dataset.sessionId === '${ids[7]}' ? 1 : null; })()`, 250);
    await fx.evaluate(`(() => { const s = document.getElementById('sessionSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const b4b = await fx.waitForEval(`(() => ${threadCount} === ${full} ? 1 : null)()`, 250);
    ok(Boolean(b4a && b4b), `B4 搜索只留命中的那一行，清空后 ${full} 行全部回来`);

    // B5 视角：管家视角的选中＝焦点线程（派一个焦点事件钉到 v），切回工作台＝当前会话（w）。
    ok(Boolean(await fx.setLens('steward')), 'B5a 切到管家视角');
    await fx.evaluate(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${v}' } })), true`);
    const b5a = await fx.waitForEval(`(() => { const s = ${selOf}; return s.length === 1 && s[0] === '${v}' ? s : null; })()`, 250);
    ok(Boolean(b5a), `B5b 管家视角里高亮的是焦点那一条（v；实测 ${JSON.stringify(await fx.evaluate(selOf))}）`);
    ok(Boolean(await fx.setLens('classic')), 'B5c 切回工作台视角');
    const b5b = await fx.waitForEval(`(() => { const s = ${selOf}; return s.length === 1 && s[0] === '${w}' ? s : null; })()`, 250);
    ok(Boolean(b5b), `B5d 回到工作台，高亮回到当前会话（w；实测 ${JSON.stringify(await fx.evaluate(selOf))}）`);

    // B6 组的折叠：点组头 → 这一组收起；再点 → 展开。
    const groupKey = await fx.evaluate(`(document.querySelector('${rowSel(y)}').closest('.rail-group') || { dataset: {} }).dataset.group || ''`);
    const toggleGroup = `document.querySelector('#railList .rail-group[data-group="${groupKey}"] .rail-gh-toggle').click(), true`;
    const collapsed = `document.querySelector('#railList .rail-group[data-group="${groupKey}"]').classList.contains('is-collapsed')`;
    await fx.evaluate(toggleGroup);
    const b6a = await fx.evaluate(collapsed);
    await fx.evaluate(toggleGroup);
    const b6b = await fx.evaluate(collapsed);
    ok(b6a === true && b6b === false, `B6 组头点一下收起、再点一下展开（${groupKey}：${b6a} → ${b6b}）`);

    // B7 多线程任务的展开：点折角 → 展开容器 is-open 翻转、折角的 aria-expanded 跟着翻。
    const openOf = `(() => { const w = document.querySelector('#railList .rail-threads[data-mission-id="${missionId}"]'); const c = document.querySelector('#railList li.rail-task[data-mission-id="${missionId}"] .rail-chev'); return w && c ? [w.classList.contains('is-open'), c.getAttribute('aria-expanded')] : null; })()`;
    const b7a = await fx.evaluate(openOf);
    await fx.evaluate(`document.querySelector('#railList li.rail-task[data-mission-id="${missionId}"] .rail-chev').click(), true`);
    const b7b = await fx.evaluate(openOf);
    ok(Boolean(b7a && b7b && b7a[0] !== b7b[0] && b7b[1] === String(b7b[0])), `B7 任务展开／收起跟着点击翻转（${JSON.stringify(b7a)} → ${JSON.stringify(b7b)}）`);

    // B8 语言：原地 setLocale('en-US') → 组头与药丸换成英文；换回 zh-CN → 换回中文。
    const labels = `(() => { const g = document.querySelector('#railList .rail-group[data-group="${groupKey}"] .rail-gh-toggle'); const p = document.querySelector('${rowSel(y)} .steward-board-pill[data-state]'); return { group: g ? g.textContent : '', pill: p ? p.textContent.trim() : '', state: p ? p.dataset.state : '' }; })()`;
    const RAIL_GROUP_KEY = { needs_you: 'needsYou', running: 'running', queued: 'queued', fresh: 'fresh', unfinished: 'unfinished', doneToday: 'doneToday', earlier: 'earlier' };
    const groupLabelKey = 'rail.group.' + (RAIL_GROUP_KEY[groupKey] || groupKey);
    await fx.evaluate(`import('/js/i18n.js').then(m => m.setLocale('en-US')).then(() => true)`);
    const b8a = await fx.waitForEval(`(() => { const l = ${labels}; return l.group === ${JSON.stringify(en[groupLabelKey])} ? l : null; })()`, 250);
    ok(Boolean(b8a && b8a.pill === en['mission.state.' + b8a.state]),
      `B8 切到英文：组头与五态药丸都换成英文（${JSON.stringify(b8a)}）`);
    await fx.evaluate(`import('/js/i18n.js').then(m => m.setLocale('zh-CN')).then(() => true)`);
    const b8b = await fx.waitForEval(`(() => { const l = ${labels}; return l.group === ${JSON.stringify(zh[groupLabelKey])} ? l : null; })()`, 250);
    ok(Boolean(b8b && b8b.pill === zh['mission.state.' + b8b.state]), `B8b 切回中文：组头与药丸换回中文（${JSON.stringify(b8b)}）`);

    ok(fx.exceptions.length === 0, `C1 页面无未捕获异常（${JSON.stringify(fx.exceptions.slice(0, 2))}）`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
})();
