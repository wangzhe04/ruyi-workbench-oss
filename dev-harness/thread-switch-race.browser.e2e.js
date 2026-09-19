#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128f(c3a3585 全量里 workbench-thread-head 的偶发 E3;负载复现 6×3 另逮到 C1／D1 成对红 —— 两处产品缺陷,都在工作台视角):
//   ① 打开会话【后发先至】:开机那一发 openSession(B) 在负载下晚到,用户已经点了 C;C 先回来画成 C,B 晚到又把
//      state.currentSession 与标题写回 B —— 线程头与 chip 从此绑在 B 上,用户以为在改 C 的模型,PATCH 落在 B(C1),
//      面包屑是 B 那件事的(D1)。修:session-experience.js openSession 取序号,晚到的回包整个丢掉。
//   ② 管家条那句「你坐着时它不动手」跟不上在场:行上的 seatedBy 是服务端按在场现算的,在场只在事件流连上那一刻登记;
//      在那之前取回来的行说「没人坐着」,而工作台视角没有兜底节拍、在场变了服务端也不推 —— 那一句就一直错(E3 的 DIAG:
//      服务端行 seatedBy='user',界面仍是「如意盯着这条」)。修:steward-board.js 收到 presence.ack 补一发 ETag 化的行,
//      且 refreshRows 行变了要告诉宿主(线程头读的也是这批行,修前推送那一路只重画左栏)。
// 判据(真浏览器;CDP Fetch 扣住回包,形状是构造出来的,不靠负载去赌):
//   T1 扣住 GET /api/sessions/B,点 B、再点 C;C 画出来之后放行 B —— 页面仍是 C(会话、标题)。
//   S1 B 先由测试从服务端交给管家盯(页面坐在 C 上、推送当场到);扣住事件流再点 B —— 此刻服务端不知道你坐在 B
//      (行上 seatedBy 空),管家条是「如意盯着这条」(前置成形);放行事件流 —— 服务端记下在场,管家条换成
//      「如意盯着这条，你坐着时它不动手」。
//   W1 取行在【回包】阶段扣住,点开关(别盯了)、再点一下(再交给它盯):第二下必须发出 PATCH(修前「忙」占到写完之后那一发读回来,
//      第二下被静默吞掉 —— 负载复现里 E4c 的 DIAG:零 PATCH、开关弹回);W1e 再放行那几发带旧数据的取行,管家条一次都不许被盖回去
//      (steward-board.js loadMissions 只认最后发出的那一发)。
//   W2 写完那一发取行 #A 被更晚的 #B 取代时(事件流先扣住,放行后补发的行事件／在场回执发出 #B),只放行 #A —— 开关不许拿旧行
//      画一帧「勾着」(修 W1e 那一刀的副作用:被取代的那一发立刻回 false,setWatch 紧接着 render 旧行;负载复现第三轮 E4c 的形状)。
//   T2 开机那一发「打开上次那条」是缺省:用户点 C 的那一发还在飞(wcw.lastSession 没写)时开机读到的是 B —— 它让路,页面仍是 C
//      (负载复现里 A11 红的那一种;只有序号时它按「更新」赢)。
// 判定行:`THREAD SWITCH RACE BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};
const TITLES = { B: '后发先至那一条', C: '后来点的那一条' };

(async () => {
  let fx = null;
  const ids = {};
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-thread-switch-', width: 1440, height: 900,
      prepare: async f => {
        for (const k of ['B', 'C']) {
          const made = await f.request('POST', '/api/sessions', { title: TITLES[k], cwd: f.work });
          ids[k] = made && made.json && made.json.session && made.json.session.id;
        }
        ok(Boolean(ids.B && ids.C), `T00 两条线程已建（${ids.B} / ${ids.C}）`);
      },
    });
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);
    const rowSel = id => `#railList .steward-board-thread[data-session-id="${id}"] .steward-board-thread-title`;
    const clickRow = id => fx.evaluate(`(() => { const n = document.querySelector('${rowSel(id)}'); if (n) n.click(); return Boolean(n); })()`);
    const page = () => fx.evaluate(`(() => ({
      id: window.state && window.state.currentSession && window.state.currentSession.id,
      title: (document.getElementById('sessionTitle') || {}).textContent || '',
      band: (document.getElementById('threadStewardText') || {}).textContent || '',
    }))()`);
    const serverRow = async id => {
      const r = await fx.request('GET', '/api/missions?limit=200');
      return ((r && r.json && r.json.missions) || []).find(item => item.sessionId === id) || null;
    };
    const waitServer = async (id, pred, attempts = 200) => {
      for (let i = 0; i < attempts; i++) {
        const row = await serverRow(id).catch(() => null);
        if (pred(row)) return row || true;
        await sleep(50);
      }
      return null;
    };

    ok(Boolean(await fx.setLens('classic')), 'T0 工作台视角');
    ok(Boolean(await fx.waitForEval(`(() => document.querySelector('${rowSel(ids.B)}') && document.querySelector('${rowSel(ids.C)}') ? 1 : null)()`)),
      'T0b 左栏两条线程都在');

    // 扣包:按 URL 分四种 —— 会话 B 的 GET、事件流、左栏取行、开机那一发会话列表。hold 集合里的一律扣下,其余放行。
    const hold = { session: false, sessionC: false, stream: false, missions: false, list: false };
    const held = { session: [], sessionC: [], stream: [], missions: [], list: [] };
    const sessionUrl = `/api/sessions/${ids.B}`;
    const sessionUrlC = `/api/sessions/${ids.C}`;
    const kindOf = (url, method) => {
      const bare = url.split('?')[0];
      if (url.includes('/api/events/stream')) return 'stream';
      if (bare.endsWith(sessionUrl)) return method === 'GET' ? 'session' : '';
      if (bare.endsWith(sessionUrlC)) return method === 'GET' ? 'sessionC' : '';
      if (bare.endsWith('/api/missions') && method === 'GET') return 'missions';
      if (bare.endsWith('/api/sessions') && method === 'GET') return 'list';
      return '';
    };
    fx.cdp.on('Fetch.requestPaused', async p => {
      const kind = kindOf(String((p.request && p.request.url) || ''), String((p.request && p.request.method) || 'GET'));
      try {
        if (kind && hold[kind]) held[kind].push(p.requestId);
        else await fx.cdp.send('Fetch.continueRequest', { requestId: p.requestId });
      } catch { /* 页面已走 */ }
    });
    // 取行在【回包】阶段扣（服务端已经按那一刻的状态答完）：放行时它带的是旧数据 —— 这才造得出「先发的晚到」。
    await fx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: `*${sessionUrl}*` }, { urlPattern: `*${sessionUrlC}*` }, { urlPattern: '*/api/events/stream*' }, { urlPattern: '*/api/missions*', requestStage: 'Response' }, { urlPattern: '*/api/sessions' }] });
    const release = async kind => {
      hold[kind] = false;
      for (const id of held[kind].splice(0)) { try { await fx.cdp.send('Fetch.continueRequest', { requestId: id }); } catch { /* 页面已走 */ } }
    };

    /* ── T1 打开会话后发先至 ── */
    hold.session = true;
    ok(await clickRow(ids.B), 'T1a 点 B（它的 GET 被扣住）');
    for (let i = 0; i < 100 && !held.session.length; i++) await sleep(50);
    ok(held.session.length > 0, 'T1b B 的那一发 GET /api/sessions/:id 确实在飞');
    ok(await clickRow(ids.C), 'T1c 紧接着点 C');
    const atC = await fx.waitForEval(`(() => (window.state && window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(ids.C)}
      && (document.getElementById('sessionTitle') || {}).textContent === ${JSON.stringify(TITLES.C)}) ? 1 : null)()`);
    ok(Boolean(atC), 'T1d C 先回来、页面画成 C');
    await release('session');
    await fx.waitForEval(`performance.getEntriesByType('resource').some(e => e.name.split('?')[0].endsWith(${JSON.stringify(sessionUrl)}) && e.responseEnd > 0) ? 1 : null`);
    await sleep(600);
    const afterB = await page();
    ok(afterB.id === ids.C && afterB.title === TITLES.C,
      `T1 B 晚到的回包不许把页面写回 B（实测会话 ${afterB.id}、标题「${afterB.title}」）`);

    /* ── S1 管家条跟上在场 ── */
    // 页面坐在 C 上：先等服务端记下这件事（它是后面「在场变了」的起点）。
    ok(Boolean(await waitServer(ids.C, row => Boolean(row && row.seatedBy === 'user'))), 'S1a 服务端知道你坐在 C 上');
    // 测试从服务端把 B 交给管家盯 —— 推送走的是【现在这条】连接，页面左栏当场拿到 watched；之后扣事件流就没有可补发的行事件，
    // 能让行重取的只剩「在场回执」这一条路（这正是 E3 的形状：开关早就翻过了，只差在场）。
    const patched = await fx.request('PATCH', `/api/sessions/${ids.B}`, { stewardWatch: true });
    ok(Boolean(patched && patched.status === 200), 'S1b 服务端把 B 交给管家盯（PATCH /api/sessions/:id {stewardWatch:true}）');
    ok(Boolean(await waitServer(ids.B, row => Boolean(row && row.watched === true))), 'S1c /api/missions 行上 B 的 watched 翻面');
    await sleep(800);   // 推送落地、左栏行重取（同一条连接上，不扣）
    hold.stream = true;
    ok(await clickRow(ids.B), 'S1d 扣住事件流，点 B');
    const atB = await fx.waitForEval(`(() => (window.state && window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(ids.B)}) ? 1 : null)()`);
    ok(Boolean(atB), 'S1e 页面换到 B');
    for (let i = 0; i < 100 && !held.stream.length; i++) await sleep(50);
    ok(held.stream.length > 0, 'S1f 换会话那一次重连被扣住了（服务端此刻不知道你坐在哪）');
    const unseated = await waitServer(ids.B, row => Boolean(row && row.watched === true && !row.seatedBy), 60);
    const wrongFirst = await fx.waitForEval(`(() => (document.getElementById('threadStewardText') || {}).textContent === ${JSON.stringify(zh['threadHead.steward.watching'])} ? 1 : null)()`, 200);
    ok(Boolean(unseated) && Boolean(wrongFirst),
      `S1g 前置成形：服务端行上 B 没人坐（seatedBy 空）、管家条是「${zh['threadHead.steward.watching']}」`);
    await release('stream');
    ok(Boolean(await waitServer(ids.B, row => Boolean(row && row.seatedBy === 'user'))), 'S1h 放行之后服务端记下你坐在 B 上');
    const seated = await fx.waitForEval(`(() => (document.getElementById('threadStewardText') || {}).textContent === ${JSON.stringify(zh['threadHead.steward.watchingSeated'])} ? 1 : null)()`, 125);
    const now = await page();
    ok(Boolean(seated),
      `S1 在场登记之后管家条跟上：「${zh['threadHead.steward.watchingSeated']}」（实测「${now.band}」）`);

    /* ── W1 开关写完之后那一发读还没回来时，再点一下不许被吞；那一发旧的读晚到也不许把新行盖回去 ── */
    const toggle = () => fx.evaluate(`(() => { const b = document.getElementById('threadStewardWatch'); if (b) b.click(); return Boolean(b); })()`);
    const SEATED = JSON.stringify(zh['threadHead.steward.watchingSeated']);
    hold.missions = true;
    ok(await toggle(), 'W1a 扣住取行的回包，点开关（别盯了）');
    ok(Boolean(await waitServer(ids.B, row => Boolean(row && row.watched === false))), 'W1b 第一下的 PATCH 落了（服务端 watched=false）');
    for (let i = 0; i < 100 && !held.missions.length; i++) await sleep(50);
    ok(held.missions.length > 0, 'W1c 写完之后那一发取行（带着 watched=false）被扣在半路 —— 修前「忙」一直占到它回来');
    hold.missions = false;   // 之后的取行照常放行；扣着的那几发留到后面再放
    ok(await toggle(), 'W1d 这时再点一下（再交给它盯）');
    const second = await waitServer(ids.B, row => Boolean(row && row.watched === true), 100);
    const settled = await fx.waitForEval(`(() => {
      const b = document.getElementById('threadStewardWatch');
      return b && b.checked === true && (document.getElementById('threadStewardText') || {}).textContent === ${SEATED} ? 1 : null;
    })()`, 200);
    ok(Boolean(second) && Boolean(settled),
      `W1 第二下没被吞：服务端 watched 回到 true（${Boolean(second)}），开关与管家条跟着是「盯着、你坐着」（${Boolean(settled)}）`);
    // 探针：从这一刻起记下管家条与开关的每一次变化，再放行那几发扣着的旧回包。
    await fx.evaluate(`(() => {
      window.__bandLog = [];
      const text = document.getElementById('threadStewardText');
      const box = document.getElementById('threadStewardWatch');
      const note = () => window.__bandLog.push((text && text.textContent) + '|' + Boolean(box && box.checked));
      window.__bandObs = new MutationObserver(note);
      window.__bandObs.observe(text, { childList: true, characterData: true, subtree: true });
      box.addEventListener('change', note);
      return true;
    })()`);
    const staleCount = held.missions.length;
    await release('missions');
    await sleep(1200);
    const log = await fx.evaluate(`(() => { const l = window.__bandLog.slice(); window.__bandObs && window.__bandObs.disconnect(); return l; })()`);
    const final = await fx.evaluate(`(() => ({ band: (document.getElementById('threadStewardText') || {}).textContent, checked: (document.getElementById('threadStewardWatch') || {}).checked }))()`);
    const flips = (log || []).filter(entry => !entry.startsWith(zh['threadHead.steward.watchingSeated'] + '|'));
    ok(staleCount > 0 && flips.length === 0 && final.band === zh['threadHead.steward.watchingSeated'] && final.checked === true,
      `W1e 扣着的 ${staleCount} 发旧取行放行之后，管家条一次都没被盖回旧状态（变化记录 ${JSON.stringify(log)}；最终「${final.band}」/ 勾选 ${final.checked}）`);

    /* ── W2 开关写完那一发取行被【更晚的一发】取代时，不许拿旧行画一帧 ──
       负载复现第三轮 E4c 的形状（DIAG：第二下发了 PATCH，服务端却停在 false）：写完 → 取行 #A；#A 回来之前推送／在场回执又发了 #B；
       loadMissions 只认最后一发，#A 被丢弃 —— 而 setWatch 接着 render()，画的是【两发都还没落地】时的旧行（watched 仍是 true），
       开关被勾回去；下一下点击于是发出的是 false。修：被取代的那一发等最后那一发落地再回。
       构造：先扣住事件流（推送与在场回执都到不了，#A 之前不会有别的取行），扣住取行的回包，点开关（别盯了）→ #A 扣住；
       放行事件流 → 补发的行事件与在场回执发出 #B（也扣住）；只放行 #A。 */
    const sw = await fx.evaluate(`(() => {
      window.__w2 = [];
      const text = document.getElementById('threadStewardText');
      const box = document.getElementById('threadStewardWatch');
      const note = () => window.__w2.push((text && text.textContent) + '|' + Boolean(box && box.checked));
      window.__w2Obs = new MutationObserver(note);
      window.__w2Obs.observe(text, { childList: true, characterData: true, subtree: true });
      box.addEventListener('change', note);
      return Boolean(box && box.checked);
    })()`);
    ok(sw === true, 'W2a 起点：B 盯着（开关勾着）');
    // 扣住事件流：换一次视角再换回来 = 两次重连，第二次被扣住（此后推送与在场回执都进不来）。
    hold.stream = true;
    await fx.setLens('steward');
    await fx.setLens('classic');
    for (let i = 0; i < 100 && !held.stream.length; i++) await sleep(50);
    ok(held.stream.length > 0, 'W2b 事件流重连被扣住（推送与在场回执此刻都到不了）');
    hold.missions = true;
    const missionsBefore = held.missions.length;
    await fx.evaluate('(window.__w2.length = 0, true)');   // 换视角那两下也会重画，记录从点击这一刻起算
    ok(await toggle(), 'W2c 点开关（别盯了）');
    ok(Boolean(await waitServer(ids.B, row => Boolean(row && row.watched === false))), 'W2d PATCH 落了（服务端 watched=false）');
    for (let i = 0; i < 100 && held.missions.length <= missionsBefore; i++) await sleep(50);
    const idA = held.missions[held.missions.length - 1];
    ok(Boolean(idA), 'W2e 写完之后那一发取行 #A 扣在回包阶段');
    await release('stream');   // 取行仍在扣（hold.missions 没动），#B 一出门也扣住
    for (let i = 0; i < 100 && held.missions[held.missions.length - 1] === idA; i++) await sleep(50);
    ok(held.missions.length >= 2 && held.missions[held.missions.length - 1] !== idA, 'W2f 放行事件流 → 补发的行事件／在场回执发出更晚的 #B（也扣住）');
    held.missions.splice(held.missions.indexOf(idA), 1);
    try { await fx.cdp.send('Fetch.continueRequest', { requestId: idA }); } catch { /* 页面已走 */ }
    await sleep(900);
    const midLog = await fx.evaluate('window.__w2.slice()');
    const reChecked = (midLog || []).slice(1).some(entry => entry.endsWith('|true'));
    ok(!reChecked, `W2 只放行 #A（被 #B 取代）：开关与管家条不许拿旧行画一帧「勾着」（变化记录 ${JSON.stringify(midLog)}）`);
    await release('missions');
    const w2Final = await fx.waitForEval(`(() => {
      const b = document.getElementById('threadStewardWatch');
      return b && b.checked === false && (document.getElementById('threadStewardText') || {}).textContent === ${JSON.stringify(zh['threadHead.steward.seeing'])} ? 1 : null;
    })()`, 200);
    await fx.evaluate('(window.__w2Obs && window.__w2Obs.disconnect(), true)');
    ok(Boolean(w2Final), `W2g 全部放行之后落在服务端的事实上：「${zh['threadHead.steward.seeing']}」、开关没勾`);

    /* ── T2 开机「打开上次那条」是缺省：用户先点了别的，它让路 ──
       形状（负载复现里 A11 红的那一种）：openSession 要等 GET 回来才写 wcw.lastSession；用户点 C 的那一发还在飞时，
       开机那一段读到的「上次那条」仍是 B，于是它发出「打开 B」—— 按序号它比用户那一下更新，修前（只有序号）它赢。 */
    await fx.evaluate(`(() => { try { localStorage.setItem('wcw.lastSession', ${JSON.stringify(ids.B)}); } catch {} return true; })()`);
    hold.list = true;
    await fx.cdp.send('Page.reload', { ignoreCache: true });
    await sleep(300);
    const railUp = await fx.waitForEval(`(() => document.readyState === 'complete' && document.querySelector('${rowSel(ids.C)}') ? 1 : null)()`);
    for (let i = 0; i < 100 && !held.list.length; i++) await sleep(50);
    ok(Boolean(railUp) && held.list.length > 0, 'T2a 刷新页面；开机那一发会话列表被扣住（「打开上次那条」还没发），左栏已经点得了');
    const lensOk = await fx.evaluate(`document.documentElement.getAttribute('data-shell-mode')`);
    if (lensOk !== 'classic') await fx.setLens('classic');
    hold.sessionC = true;
    ok(await clickRow(ids.C), 'T2b 用户先点了 C（它的 GET 扣在半路，wcw.lastSession 还没写）');
    for (let i = 0; i < 100 && !held.sessionC.length; i++) await sleep(50);
    ok(held.sessionC.length > 0, 'T2c 用户那一发 GET /api/sessions/C 在飞');
    await release('list');
    await sleep(1500);   // 开机那一段接着跑：读到的「上次那条」是 B（修前它此刻发「打开 B」并按序号盖过用户那一下）
    await release('sessionC');
    await fx.waitForEval(`(() => (window.state && window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(ids.C)}) ? 1 : null)()`, 100);
    await sleep(600);
    const afterBoot = await page();
    ok(afterBoot.id === ids.C && afterBoot.title === TITLES.C,
      `T2 开机的「打开上次那条（B）」让路给用户的选择（实测会话 ${afterBoot.id}、标题「${afterBoot.title}」）`);
    await fx.cdp.send('Fetch.disable');
    ok(fx.exceptions.length === 0, `T9 页面没有未捕获异常（${fx.exceptions.slice(0, 3).join(' | ') || '无'}）`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: false });
  }
  console.log(fail === 0 ? 'THREAD SWITCH RACE BROWSER E2E: ALL PASS' : `THREAD SWITCH RACE BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
