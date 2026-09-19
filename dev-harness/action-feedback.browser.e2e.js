#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128f-⑫(用户 2026-09-19:「当前删除线程等操作时,没有及时的界面反馈,需要点别的地方才会刷新消失」)。
//
// 修前(本机真浏览器取证,scratchpad/probe-rail-feedback2):管家视角里删掉一条线程,6 s 内那一行一直在 —— 删除之后
// 页面根本没有重拉 /api/missions(steward-board syncRail 只在工作台视角补拉,理由是「管家视角有兜底计时器」,而那一拍
// 默认 15 s);服务端删除也一帧推送都不派。工作台视角 46 ms 就消失。另外:请求在飞时行一动不动、删不掉时一个没人接的
// rejection(没有任何提示)。
//
// 判据(真服务 ＋ 无头浏览器;夹具的兜底轮询是 120 s,所以凡是「几秒内跟上」的都不是轮询给的):
//   R1 管家视角点删除:请求在飞时那一行立刻变灰、aria-busy(CDP 在请求阶段扣住 DELETE);放行之后那一行几秒内消失。
//   R2 删不掉(服务端答 500):那一行恢复原样(不再变灰),并出一条「删除失败」提示。
//   R3 别处删掉的(测试直接调 API,页面什么都没做):靠推送 thread.removed,几秒内从左栏消失。
//   R4 工作台视角点删除:同样几秒内消失(修前就好,钉住不退)。
//   R6 同一条线程的权限 chip 在线程头与左栏行上各有一份:线程头改了,左栏那一行当场跟上;左栏行上改了,线程头当场跟上
//      (审计 C;修前另一份要等换线程才重喂)。
//   R6f 左栏行上的菜单开着时别处来了变动(推送要重画左栏):菜单不许被打断;菜单一收,暂缓的那次重画当场补上。
//      (R6d 第一版在负载下偶发红,现场是「补读会话那一趟里左栏被推送重画、被点的按钮整行换掉」—— 产品缺陷,不是测试的时序)
//   R7 工作台打开着「甲」、人切到管家视角期间「甲」跑完一回合;切回工作台,中栏当场是新的(审计 E;修前要换一次会话)。
//   R8 管家视角焦点在「己」上,点它行上的「优先」:右栏焦点栏当场重读一次(审计 B;修前还拿着动作之前的切片。
//      「优先」服务端不派任何推送,所以这一发重读只可能来自动作自己)。
//   R1d/R1e 把 R1 那一刀的三道保险逐条单独钉住(第一版只钉了合力,反向时拿掉两道、第三道照样让它绿):
//      R1d 扣住所有 GET /api/missions(补拉与推送都落不了地)再删 —— 只有「删完立刻不画」(state.sessionRemoval.done)能让它消失;
//      R1e 扣住事件流(推送来不了)再在管家视角改名 —— 只有 syncRail 在管家视角的补拉能让新名字上屏;
//      推送那一道(thread.removed)由 R3 单独钉。
//   R5 管家视角「清理历史」:删掉的那些几秒内全部从左栏消失,当前那条留着。
//   RA 设置里把「同时并行线程上限」改掉:左栏头上那个数当场跟上(审计 F;修前它读仲裁面,要等整份刷新那一拍)。
// 判定行:`ACTION FEEDBACK BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const TITLES = ['反馈甲', '反馈乙', '反馈丙', '反馈丁', '反馈戊', '反馈己', '反馈庚'];

(async () => {
  let fx = null;
  const ids = {};
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-action-feedback-', width: 1400, height: 900,
      prepare: async f => {
        for (const title of TITLES) {
          const made = await f.request('POST', '/api/sessions', { title, cwd: f.work });
          ids[title] = made && made.json && made.json.session && made.json.session.id;
        }
      },
    });
    ok(TITLES.every(title => Boolean(ids[title])), 'R0 建出七条线程');
    // 原生确认框在无头浏览器里会卡住页面:一律答「是」。提示条记进 window.__toasts(它 3.2 s 后自己淡出)。
    await fx.evaluate(`(() => {
      window.confirm = () => true;
      window.__toasts = [];
      // 页面发出的每一发请求记一笔(方法 ＋ 路径),R8 数「焦点栏重读」用。
      window.__net = [];
      const origFetch = window.fetch;
      window.fetch = function (input, init) {
        try { window.__net.push({ method: String((init && init.method) || 'GET'), url: (u => { const p = new URL(u, location.href); return p.pathname + p.search; })(String((input && input.url) || input)) }); } catch { /* 记账失败不影响请求 */ }
        return origFetch.apply(this, arguments);
      };
      const tray = document.getElementById('toastTray');
      if (tray) new MutationObserver(list => { for (const m of list) for (const n of m.addedNodes) window.__toasts.push(String(n.textContent || '')); })
        .observe(tray, { childList: true });
      return true;
    })()`);
    const rowSel = id => `#railList .steward-board-thread[data-session-id="${id}"]`;
    const rowState = id => fx.evaluate(`(() => { const r = document.querySelector('${rowSel(id)}');
      return r ? { present: true, removing: r.classList.contains('is-removing'), busy: r.getAttribute('aria-busy') } : { present: false }; })()`);
    const clickDelete = id => fx.evaluate(`(() => { const b = document.querySelector('#railList [data-session-action="delete"][data-session-id="${id}"]');
      if (!b) return false; b.click(); return true; })()`);
    const waitGone = async (id, maxMs) => {
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        if (!(await rowState(id)).present) return Date.now() - t0;
        await sleep(40);
      }
      return -1;
    };

    ok(Boolean(await fx.setLens('steward')), 'R0b 管家视角');
    ok(Boolean(await fx.waitForEval(`(() => ${JSON.stringify(Object.values(ids))}.every(id => document.querySelector('#railList [data-session-id="' + id + '"]')) ? 1 : null)()`)),
      'R0c 左栏七条都在');

    // 扣包:删除请求(POST + x-http-method: DELETE)按 mode 扣住或答 500;R1d 扣取行、R1e 扣事件流;其余一律放行。
    let mode = 'pass';
    const held = [];
    const holdKinds = { missions: false, stream: false };
    const heldKinds = { missions: [], stream: [] };
    fx.cdp.on('Fetch.requestPaused', async p => {
      const method = String((p.request && p.request.method) || 'GET');
      const url = String((p.request && p.request.url) || '');
      const headers = (p.request && p.request.headers) || {};
      const isDelete = method === 'POST' && Object.keys(headers).some(k => k.toLowerCase() === 'x-http-method' && String(headers[k]).toUpperCase() === 'DELETE');
      const kind = url.includes('/api/events/stream') ? 'stream' : (method === 'GET' && url.split('?')[0].endsWith('/api/missions') ? 'missions' : '');
      try {
        if (kind && holdKinds[kind]) { heldKinds[kind].push(p.requestId); return; }
        if (isDelete && mode === 'hold') { held.push(p.requestId); return; }
        if (isDelete && mode === 'fail') {
          await fx.cdp.send('Fetch.fulfillRequest', {
            requestId: p.requestId, responseCode: 500,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify({ ok: false, error: '磁盘被占用（测试注入）' })).toString('base64'),
          });
          return;
        }
        await fx.cdp.send('Fetch.continueRequest', { requestId: p.requestId });
      } catch { /* 页面已走 */ }
    });
    await fx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/sessions/*' }, { urlPattern: '*/api/missions*' }, { urlPattern: '*/api/events/stream*' }] });
    const releaseKind = async kind => {
      holdKinds[kind] = false;
      for (const id of heldKinds[kind].splice(0)) { try { await fx.cdp.send('Fetch.continueRequest', { requestId: id }); } catch { /* 页面已走 */ } }
    };

    /* ── R1 管家视角:在飞变灰,放行即消失 ── */
    const b = ids['反馈乙'];
    mode = 'hold';
    ok(await clickDelete(b), 'R1a 点「删除」(反馈乙)');
    for (let i = 0; i < 100 && !held.length; i++) await sleep(40);
    ok(held.length === 1, 'R1b 删除请求确实在飞(被扣住)');
    const inFlight = await rowState(b);
    ok(inFlight.present && inFlight.removing && inFlight.busy === 'true',
      `R1c 请求在飞时那一行立刻变灰、aria-busy(实测 ${JSON.stringify(inFlight)};修前一动不动)`);
    mode = 'pass';
    for (const id of held.splice(0)) { try { await fx.cdp.send('Fetch.continueRequest', { requestId: id }); } catch { /* 页面已走 */ } }
    const goneB = await waitGone(b, 5000);
    ok(goneB >= 0, `R1 放行之后那一行消失(${goneB} ms;修前要等兜底轮询或点别处)`);

    /* ── R2 删不掉:恢复原样 ＋ 提示 ── */
    const c = ids['反馈丙'];
    mode = 'fail';
    await fx.evaluate('(window.__toasts.length = 0, true)');
    ok(await clickDelete(c), 'R2a 点「删除」(反馈丙,服务端注入 500)');
    const toastSeen = await fx.waitForEval(`(() => window.__toasts.some(s => s.includes('删除失败')) ? window.__toasts.join(' | ') : null)()`, 150);
    ok(Boolean(toastSeen), `R2b 出一条「删除失败」提示(实测 ${toastSeen || '无'};修前是一个没人接的 rejection)`);
    await sleep(300);
    const afterFail = await rowState(c);
    ok(afterFail.present && !afterFail.removing && afterFail.busy !== 'true', `R2 那一行恢复原样(实测 ${JSON.stringify(afterFail)})`);
    mode = 'pass';

    /* ── R3 别处删掉的:推送 thread.removed ── */
    const d = ids['反馈丁'];
    const apiDelete = await fx.request('DELETE', `/api/sessions/${d}`);
    ok(Boolean(apiDelete && apiDelete.status === 200), 'R3a 测试直接调 API 删掉反馈丁(页面什么都没做)');
    const goneD = await waitGone(d, 5000);
    ok(goneD >= 0, `R3 靠推送 thread.removed 从左栏消失(${goneD} ms)`);

    /* ── R4 工作台视角 ── */
    ok(Boolean(await fx.setLens('classic')), 'R4a 切到工作台视角');
    const e = ids['反馈戊'];
    ok(await clickDelete(e), 'R4b 点「删除」(反馈戊)');
    const goneE = await waitGone(e, 5000);
    ok(goneE >= 0, `R4 工作台视角里同样当场消失(${goneE} ms)`);

    /* ── R6 权限 chip:线程头 ↔ 左栏行 ── */
    const a = ids['反馈甲'];
    const openedA = await fx.evaluate(`(() => { const title = document.querySelector('${rowSel(a)} .steward-board-thread-title'); if (!title) return false; title.click(); return true; })()`);
    ok(openedA && Boolean(await fx.waitForEval(`(() => window.state && window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(a)}
      && document.querySelector('#threadChips [data-chip="permission"]') ? 1 : null)()`)), 'R6a 工作台里打开「反馈甲」,线程头 chip 就位');
    const pickPermission = async (chipSelector, mode) => {
      // 现场记录(R6-DIAG):点下去那一刻按钮在不在文档里、菜单项出没出现过、这期间左栏重画了几次、hydrate 那一发回没回来。
      await fx.evaluate(`(() => {
        const d = window.__r6 = { clickedConnected: null, laterConnected: null, optionSeen: 0, optionGone: 0, railRenders: 0, sessionGets: 0 };
        const btn = document.querySelector(${JSON.stringify(chipSelector)});
        d.clickedConnected = Boolean(btn && btn.isConnected);
        window.__r6btn = btn;
        const mo = new MutationObserver(list => { for (const m of list) {
          for (const n of m.addedNodes) if (n.nodeType === 1 && (n.matches('.steward-chip-option') || n.querySelector('.steward-chip-option'))) d.optionSeen += 1;
          for (const n of m.removedNodes) if (n.nodeType === 1 && (n.matches('.steward-chip-option') || n.querySelector('.steward-chip-option'))) d.optionGone += 1;
          if (m.target && m.target.id === 'railList') d.railRenders += 1;
        } });
        mo.observe(document.body, { childList: true, subtree: true });
        window.__r6mo = mo;
        d.netMark = window.__net.length;
        if (btn) btn.click();
        setTimeout(() => { d.laterConnected = Boolean(window.__r6btn && window.__r6btn.isConnected); }, 300);
        return true;
      })()`);
      const label = await fx.waitForEval(`(() => { const o = document.querySelector('.steward-chip-option[data-permission-mode="${mode}"]');
        return o ? (o.querySelector('.steward-chip-option-label') || o).textContent : null; })()`, 150);
      const diag = await fx.evaluate(`(() => { const d = window.__r6; if (window.__r6mo) window.__r6mo.disconnect();
        d.after = window.__net.slice(d.netMark).map(n => n.method + ' ' + n.url.split('?')[0]).join(', '); return d; })()`);
      if (!label) { console.log('R6-DIAG ' + chipSelector + ' ' + JSON.stringify(diag)); return null; }
      await fx.evaluate(`(document.querySelector('.steward-chip-option[data-permission-mode="${mode}"]').click(), true)`);
      return String(label).trim();
    };
    const chipText = selector => fx.evaluate(`(() => { const v = document.querySelector(${JSON.stringify(selector + ' .steward-chip-value')}); return v ? v.textContent.trim() : ''; })()`);
    const headChip = '#threadChips [data-chip="permission"]';
    const railChip = `${rowSel(a)} [data-chip="permission"]`;
    const planLabel = await pickPermission(headChip, 'plan');
    ok(Boolean(planLabel), `R6b 在线程头把权限改成「${planLabel}」`);
    const railFollowed = await fx.waitForEval(`(() => { const v = document.querySelector(${JSON.stringify(railChip + ' .steward-chip-value')}); return v && v.textContent.trim() === ${JSON.stringify(planLabel)} ? 1 : null; })()`, 125);
    ok(Boolean(railFollowed), `R6c 左栏那一行当场跟上(实测「${await chipText(railChip)}」)`);
    const editsLabel = railFollowed ? await pickPermission(railChip, 'acceptEdits') : null;
    ok(Boolean(editsLabel), `R6d 在左栏行上把权限改成「${editsLabel}」`);
    const headFollowed = await fx.waitForEval(`(() => { const v = document.querySelector(${JSON.stringify(headChip + ' .steward-chip-value')}); return v && v.textContent.trim() === ${JSON.stringify(editsLabel || '')} ? 1 : null; })()`, 125);
    ok(Boolean(headFollowed), `R6 线程头当场跟上(实测「${await chipText(headChip)}」;修前停在「${planLabel}」直到换线程)`);

    /* ── R6f 左栏行上的菜单开着时,别处的变动不许把它打断;菜单一收,变动当场补上 ── */
    // 128f-⑫ 续(R6d 在负载下复现出来的产品缺陷:左栏被推送重画 → 整行 DOM 换掉 → 开着的 chip 菜单跟着没了)。
    // 这里确定性地造一次:菜单开着 → 测试直接调 API 删掉另一条线程(推送 thread.removed → 左栏要重画)→ 菜单还在、还连在文档里;
    // Esc 收起菜单 → 被删的那一行当场消失(暂缓的那一次重画补上了)。
    const doomedF = ids['反馈庚'];
    await fx.evaluate(`(document.querySelector(${JSON.stringify(railChip)}).click(), true)`);
    const menuOpen = await fx.waitForEval(`(() => { const o = document.querySelector('${rowSel(a)} .steward-chip-option[data-permission-mode="plan"]'); return o && o.isConnected ? 1 : null; })()`, 150);
    ok(Boolean(menuOpen), 'R6f-a 左栏「反馈甲」行上的权限菜单打开了');
    const delF = await fx.request('DELETE', `/api/sessions/${doomedF}`);
    await sleep(1200);   // 推送(thread.removed)→ pushRefreshRows → renderRail 要走的那一趟:足够它落地
    const stillOpen = await fx.evaluate(`(() => { const o = document.querySelector('${rowSel(a)} .steward-chip-option[data-permission-mode="plan"]'); return Boolean(o && o.isConnected && !o.closest('[hidden]')); })()`);
    ok(Boolean(delF && delF.status === 200) && stillOpen, `R6f-b 期间别处删掉一条线程(推送来了),开着的菜单没被重画打断(修前整行重建、菜单跟着没了;实测 ${stillOpen})`);
    await fx.escape();
    const goneF = await waitGone(doomedF, 5000);
    ok(goneF >= 0, `R6f 菜单一收,暂缓的那次重画当场补上 —— 被删的那一行消失(${goneF} ms)`);

    /* ── R7 离开工作台期间当前线程跑完一回合 ── */
    ok(Boolean(await fx.setLens('steward')), 'R7a 切到管家视角(工作台里当前仍是「反馈甲」)');
    const R7_SAY = 'R7 人在管家视角时这条线程跑的一回合';
    const turn = await fx.request('POST', '/api/chat/stream', { sessionId: a, message: R7_SAY, cwd: fx.work }, 120000);
    ok(Boolean(turn && turn.status === 200), 'R7b 这一回合跑完(测试直接调 API,页面什么都没做)');
    ok(Boolean(await fx.setLens('classic')), 'R7c 切回工作台');
    const seen = await fx.waitForEval(`(() => (document.getElementById('messages') || {}).textContent.includes(${JSON.stringify(R7_SAY)}) ? 1 : null)()`, 125);
    ok(Boolean(seen), 'R7 中栏当场是新的(那一回合在屏上;修前要换一次会话才重读)');

    /* ── R8 焦点那一条上点「优先」 → 焦点栏重读 ── */
    ok(Boolean(await fx.setLens('steward')), 'R8a 回到管家视角');
    const g = ids['反馈己'];
    // 数的是【事项切片】那一发(GET /api/missions/:id):焦点栏整份重读(refreshOnce)才读它;焦点栏自己的轮询拍只读会话与待决
    // 两面(steward-drawer「轮询只刷新本线程切片」),所以这一发不会被轮询拍冒充(第一版数会话 GET,反向时被轮询拍冒充成 PASS)。
    const slicePath = `/api/missions/${g}`;
    const sliceReads = () => fx.evaluate(`window.__net.filter(n => n.method === 'GET' && n.url.split('?')[0] === ${JSON.stringify(slicePath)}).length`);
    await fx.evaluate(`(() => { const title = document.querySelector('${rowSel(g)} .steward-board-thread-title'); if (title) title.click(); return true; })()`);
    const focused = await fx.waitForEval(`(() => window.__net.some(n => n.method === 'GET' && n.url.split('?')[0] === ${JSON.stringify(slicePath)}) ? 1 : null)()`, 125);
    ok(Boolean(focused), 'R8b 焦点落到「反馈己」,焦点栏读过它的事项切片一次');
    await sleep(600);
    const before = await sliceReads();
    const netMark = await fx.evaluate('window.__net.length');
    const clicked = await fx.evaluate(`(() => { const btn = document.querySelector('${rowSel(g)} [data-action="prioritize"]'); if (!btn) return false; btn.click(); return true; })()`);
    ok(clicked, 'R8c 点它行上的「优先」');
    const reread = await fx.waitForEval(`(() => window.__net.filter(n => n.method === 'GET' && n.url.split('?')[0] === ${JSON.stringify(slicePath)}).length > ${before} ? 1 : null)()`, 125);
    const afterClick = await fx.evaluate(`window.__net.slice(${netMark}).map(n => n.method + ' ' + n.url.split('?')[0]).join(', ')`);
    ok(Boolean(reread), `R8 焦点栏当场重读(点之前读过 ${before} 次,之后 ${await sliceReads()} 次;修前焦点没换就不重读;点之后的请求:${afterClick})`);

    /* ── R1d 取行全被扣住时删除:只靠「删完立刻不画」 ── */
    const h = ids['反馈己'];   // 庚在 R6f 删掉了;己在 R8 用完
    holdKinds.missions = true;
    ok(await clickDelete(h), 'R1d-a 扣住所有 GET /api/missions 之后点「删除」(反馈己)');
    const goneH = await waitGone(h, 5000);
    ok(goneH >= 0, `R1d 取行一发都落不了地时那一行照样消失(${goneH} ms;这一刻被扣住的取行 ${heldKinds.missions.length} 发)`);
    await releaseKind('missions');

    /* ── R1e 推送来不了时在管家视角改名:只靠 syncRail 的补拉 ── */
    const cRow = ids['反馈丙'];
    holdKinds.stream = true;
    // 换一次视角 = 在场信号变了 = 事件流重连(去抖 300 ms);新的那条连接被扣住,旧的已经断开 —— 从此收不到推送。
    ok(Boolean(await fx.setLens('classic')) && Boolean(await fx.setLens('steward')), 'R1e-a 扣住事件流、换两次视角逼它重连');
    for (let i = 0; i < 100 && !heldKinds.stream.length; i++) await sleep(40);
    ok(heldKinds.stream.length >= 1, `R1e-b 新的事件流连接确实被扣住(${heldKinds.stream.length} 发)`);
    await sleep(400);
    const NEW_NAME = '改名之后的反馈丙';
    await fx.evaluate(`(document.querySelector('#railList [data-session-action="rename"][data-session-id="${cRow}"]').click(), true)`);
    const popped = await fx.waitForEval(`(() => document.querySelector('.rename-pop input') ? 1 : null)()`, 100);
    await fx.evaluate(`(() => { const i = document.querySelector('.rename-pop input'); i.value = ${JSON.stringify(NEW_NAME)}; document.querySelector('.rename-pop button.primary').click(); return true; })()`);
    const renamed = await fx.waitForEval(`(() => { const r = document.querySelector('${rowSel(cRow)}'); return r && r.textContent.includes(${JSON.stringify(NEW_NAME)}) ? 1 : null; })()`, 125);
    ok(Boolean(popped) && Boolean(renamed), 'R1e 推送来不了时,管家视角里改完名那一行当场是新名字(修前 syncRail 在管家视角不补拉,要等兜底轮询)');
    await releaseKind('stream');

    /* ── R5 管家视角「清理历史」 ── */
    ok(Boolean(await fx.setLens('steward')), 'R5a 回到管家视角');
    const current = await fx.evaluate('(window.state && window.state.currentSession && window.state.currentSession.id) || ""');
    const survivors = [ids['反馈甲'], ids['反馈丙']];   // R6／R7 之后当前那条是「反馈甲」;庚在 R6f、己在 R1d 删掉了
    await fx.evaluate(`(document.getElementById('bulkCleanupBtn').click(), true)`);
    const go = await fx.waitForEval(`(() => { const btn = [...document.querySelectorAll('.modal button.danger')].pop(); return btn ? 1 : null; })()`, 100);
    ok(Boolean(go), 'R5b 「清理历史」确认框打开');
    await fx.evaluate(`([...document.querySelectorAll('.modal button.danger')].pop().click(), true)`);
    const expectGone = survivors.filter(id => id !== current);
    const t0 = Date.now();
    let allGone = false;
    while (Date.now() - t0 < 5000 && !allGone) {
      const states = await Promise.all(expectGone.map(rowState));
      allGone = states.every(s => !s.present);
      if (!allGone) await sleep(40);
    }
    ok(allGone, `R5 清理掉的 ${expectGone.length} 条都从左栏消失(${allGone ? Date.now() - t0 : -1} ms;当前那条「${current || '无'}」不在清理之列)`);
    if (current) ok((await rowState(current)).present, 'R5c 当前那条留着');

    /* ── RA 设置里改并发上限 → 左栏头上的数当场跟上 ── */
    const boardMax = () => fx.evaluate(`(document.getElementById('stewardBoardMax') || {}).value || ''`);
    const maxBefore = await boardMax();
    const target = String(Number(maxBefore || 5) === 3 ? 4 : 3);
    await fx.evaluate(`(() => { const i = document.getElementById('cfgStewardMaxParallelThreads'); i.value = ${JSON.stringify(target)}; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const maxFollowed = await fx.waitForEval(`(() => (document.getElementById('stewardBoardMax') || {}).value === ${JSON.stringify(target)} ? 1 : null)()`, 125);
    ok(Boolean(maxFollowed), `RA 左栏头上「同时最多」当场是 ${target}(之前 ${maxBefore};实测 ${await boardMax()})`);

    ok(fx.exceptions.length === 0, `R9 页面没有未捕获异常(${fx.exceptions.slice(0, 3).join(' | ') || '无'})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: false });
  }
  console.log(fail === 0 ? 'ACTION FEEDBACK BROWSER E2E: ALL PASS' : `ACTION FEEDBACK BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
