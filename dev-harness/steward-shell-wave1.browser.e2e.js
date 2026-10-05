#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 前端走查第一批（管家壳）的真浏览器回归。快通道（纯函数／静态契约）在 dev-harness/unit/steward-shell-wave1.test.js。
//
//   P1  管家视角 1024／1180 宽打开线程：#stewardShell.scrollLeft 必须是 0（修前 focus() 不带 preventScroll，焦点目标是
//       滑出层里的节点，浏览器把 overflow:hidden 的栅格横向拨到 392，中栏整体移到 x<0、输入框够不着）；
//   S-01 左栏行「⋯」菜单：菜单里点动作先收菜单、行当场更新；Esc 关菜单时补画被暂缓的那一次重画；
//   S-02 整单回退：确认框开着时焦点被切走 → 不动手（修前确认之后才读闭包里的 sessionId，停掉并回退了另一条线程）；
//   S-03 /api/missions 304 时左栏也要重画（行右侧「N 分钟前」按此刻算，不随行数据变）；
//   S-04 新建／删除当前会话都要让在场信号（事件流）跟着重连；
//   S-05 交接开关写失败要出 err 样式的 toast（修前静默）；
//   S-06 抽屉两个输入框按线程暂存／恢复草稿（修前回车发给新焦点线程）；
//   S-07 口袋入口每次打开都重载被点名的那一段（修前只首次加载）；
//   S-08 待决处理完，头像不再停在「等你确认」；
//   S-09 桌面壳里安静卡的系统通知走 chrome.webview.postMessage({ ruyiNotification:{ title, body } })；
//   S-10 安静卡：线程不再 needs_you／收工／被打开 → 撤卡；候选答案失败要提示并撤卡（断网则留着）；
//   S-11 后台任务七种终态都有文案与颜色；
//   S-13 抽屉发送失败不丢字（成功之后才清）；
//   S-15 免打扰时段只在开启本机通知时才压安静卡。
//
// 反向验证（先破坏、看真红、再还原；不在本件里自动做 —— 会把生产文件写脏）已逐组在本机独立跑过，记在提交说明里。
// 判定行：`STEWARD SHELL WAVE1 BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, waitForHttp, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('STEWARD SHELL WAVE1 BROWSER');
const { ok } = t;
const ZH = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));

// 确定性 provider：最后一条是用户消息且含「ask about X」→ 一条单选 request_user_input；其余一句短回答。
async function script(ctx) {
  const last = ctx.messages[ctx.messages.length - 1] || {};
  const match = last.role === 'user' ? String(last.content || '').match(/ask about (\w+)/) : null;
  if (match) {
    ctx.toolCall('request_user_input', { questions: [{
      id: `q_${match[1]}`, header: match[1], question: `${match[1]} 那件事要等吗？`, answerMode: 'single',
      options: [{ id: 'wait', label: '等' }, { id: 'skip', label: '不等' }],
    }] });
    return;
  }
  ctx.text('好。');
  ctx.stop();
}

const ids = {};
const rowSel = id => `#railList li.steward-board-thread[data-session-id="${id}"]`;

(async () => {
  let fx = null;
  const phase = async (name, fn) => {
    try { await fn(); } catch (error) { t.fail(`${name} 未预期异常：${error && error.stack || error}`); }
  };
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-steward-shell-wave1-', width: 1280, height: 900, provider: script,
      prepare: async f => {
        // 机器忙时一发请求可能超时回 null（夹具默认 30 s）：给长一点的超时并重试，拿不到 id 就当场红（别带着空 id 往下跑出一串假红）。
        const make = async title => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const r = await f.request('POST', '/api/sessions', { title, cwd: f.work }, 120000);
            if (r && r.json && r.json.session && r.json.session.id) return r.json.session.id;
          }
          return '';
        };
        ids.A = await make('线程甲');
        ids.B = await make('线程乙');
        ids.P = await make('置顶那条');
        ids.R = await make('改名那条');
        ids.S = await make('等你那条');
        ok(Object.values(ids).every(Boolean), `F0f 五条线程都建出来了（${JSON.stringify(ids)}）`);
        // A 先跑一轮：有用户消息，「整单回退」才有可回退的回合。
        await f.request('POST', '/api/chat/stream', { sessionId: ids.A, message: '你好', cwd: f.work }, 300000);
      },
    });
    const ev = expression => fx.evaluate(expression);
    const waitFor = (expression, attempts) => fx.waitForEval(expression, attempts);

    // ── 页内工具：fetch 记录／桩（桩只用于「会让真东西被动」的写口与要制造失败的那几处）──────────
    await ev(`(() => {
      if (window.__fx) return true;
      window.__fx = { calls: [], rules: [] };
      const realFetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : String((input && input.url) || '');
        const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        const call = { url, method, body: init && typeof init.body === 'string' ? init.body : '', status: 0 };
        window.__fx.calls.push(call);
        const rule = window.__fx.rules.find(r => r.method === method && url.indexOf(r.url) >= 0);
        if (rule) { call.status = rule.status; return Promise.resolve(new Response(JSON.stringify(rule.body), { status: rule.status, headers: { 'content-type': 'application/json' } })); }
        return realFetch(input, init).then(res => { call.status = res.status; return res; });
      };
      window.__fxRule = (method, url, status, body) => { window.__fx.rules = window.__fx.rules.filter(r => !(r.method === method && r.url === url)); window.__fx.rules.push({ method, url, status, body }); };
      window.__fxClear = () => { window.__fx.rules = []; };
      return true;
    })()`);

    // ── 事件流在场信号的抓手：每一发 /api/events/stream 的 sessionId 参数 ────────────────────────
    await fx.cdp.send('Network.enable');
    const streamUrls = [];
    fx.cdp.on('Network.requestWillBeSent', p => {
      const url = (p.request && p.request.url) || '';
      if (url.includes('/api/events/stream')) streamUrls.push(url);
    });
    const lastStreamSession = () => {
      if (!streamUrls.length) return null;
      try { return new URL(streamUrls[streamUrls.length - 1]).searchParams.get('sessionId'); } catch { return null; }
    };
    const waitStreamSession = async (predicate, ms = 9000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { const value = lastStreamSession(); if (value !== null && predicate(value)) return value; await sleep(100); }
      return lastStreamSession();
    };

    /* ═════════ 工作台视角（classic）：S-04／S-01／S-05 ═════════ */
    await fx.setLens('classic');
    ok(Boolean(await waitFor(`document.querySelectorAll('#railList li.steward-board-thread').length >= 5 ? 1 : null`)),
      'A0 左栏五条线程都画出来了');

    await phase('S-04', async () => {
      // 开机时页面已经打开着某条会话（上次那条），所以要等「当前会话」换成【另一个】id 才是新建完成。
      const previous = await ev(`(window.state && window.state.currentSession && window.state.currentSession.id) || ''`);
      await ev(`document.getElementById('newSessionBtn').click(), true`);
      const created = await waitFor(`(() => { const id = (window.state && window.state.currentSession && window.state.currentSession.id) || ''; return id && id !== ${JSON.stringify(previous)} ? id : null; })()`);
      ids.fresh = String(created || '');
      const seen = await waitStreamSession(value => value === ids.fresh);
      ok(Boolean(ids.fresh) && seen === ids.fresh,
        `S-04a 新建会话之后在场信号（事件流 ?sessionId=）跟着换成新会话（新会话 ${ids.fresh}；末次连接带的是 ${seen}）`);

      // 删除当前会话：原生 confirm 桩成同意；经「⋯」菜单点「删除」（同时走 S-01 的「点完动作先收菜单」）。
      await ev(`window.confirm = () => true, true`);
      ok(Boolean(await waitFor(`document.querySelector('${rowSel(ids.fresh)}') ? 1 : null`)), 'S-04b0 新会话在左栏有一行');
      await ev(`(() => { const row = document.querySelector('${rowSel(ids.fresh)}'); row.querySelector('.steward-board-more').click(); return true; })()`);
      ok(Boolean(await waitFor(`document.querySelector('${rowSel(ids.fresh)}.is-actions-open') ? 1 : null`)), 'S-01a 点「⋯」菜单开了');
      await ev(`(() => { const row = document.querySelector('${rowSel(ids.fresh)}'); row.querySelector('[data-session-action="delete"]').click(); return true; })()`);
      ok(Boolean(await waitFor(`document.querySelector('${rowSel(ids.fresh)}') ? null : 1`, 250)),
        'S-01b 菜单里点「删除」之后左栏这一行当场消失（修前菜单开着、重画被暂缓，行要等下一次重画才没）');
      const afterDelete = await waitStreamSession(value => value !== ids.fresh);
      ok(afterDelete !== ids.fresh && afterDelete !== null,
        `S-04c 删除当前会话之后在场信号不再停在已删的线程上（末次连接带的是「${afterDelete}」）`);
    });

    await phase('S-01', async () => {
      // 置顶：菜单里点「置顶」→ 菜单收起、这一行立刻是「已置顶」的样子。
      await ev(`(() => { document.querySelector('${rowSel(ids.P)} .steward-board-more').click(); return true; })()`);
      ok(Boolean(await waitFor(`document.querySelector('${rowSel(ids.P)}.is-actions-open') ? 1 : null`)), 'S-01c 置顶那条的「⋯」菜单开了');
      await ev(`(() => { document.querySelector('${rowSel(ids.P)} [data-session-action="pin"]').click(); return true; })()`);
      ok(Boolean(await waitFor(`(() => {
        const row = document.querySelector('${rowSel(ids.P)}');
        const pin = row && row.querySelector('[data-session-action="pin"]');
        return pin && pin.dataset.pinned === '1' && !document.querySelector('#railList .is-actions-open') ? 1 : null;
      })()`, 250)), 'S-01d 点「置顶」之后菜单收起，且这一行当场换成「取消置顶」');

      // Esc 关菜单：菜单开着时来的重画被暂缓，关的时候要补上（修前只有 chip 的 onMenuIdle 补，「⋯」这条路没人补）。
      await ev(`(() => { document.querySelector('${rowSel(ids.R)} .steward-board-more').click(); return true; })()`);
      ok(Boolean(await waitFor(`document.querySelector('${rowSel(ids.R)}.is-actions-open') ? 1 : null`)), 'S-01e 改名那条的「⋯」菜单开了');
      const renamed = await fx.request('PATCH', `/api/sessions/${ids.R}`, { title: '已改名的那条' });
      ok(Boolean(renamed && renamed.status === 200), `S-01f 服务端改名成功（HTTP ${renamed && renamed.status}）`);
      await sleep(1500);   // 让改名的推送到达（重画被暂缓）
      await fx.escape();
      ok(Boolean(await waitFor(`(() => {
        const row = document.querySelector('${rowSel(ids.R)}');
        const title = row && row.querySelector('.steward-board-thread-title');
        return title && title.textContent.indexOf('已改名的那条') >= 0 && !row.classList.contains('is-actions-open') ? 1 : null;
      })()`, 250)), 'S-01g Esc 关掉菜单之后，被暂缓的那一次重画补上了（行标题换成新名字）');
    });

    await phase('S-05', async () => {
      const rowThere = await waitFor(`document.querySelector('${rowSel(ids.A)}') ? 1 : null`, 250);
      if (!rowThere) console.log('DIAG S-05 左栏里的行：' + JSON.stringify(await ev(`[...document.querySelectorAll('#railList li.steward-board-thread')].map(li => li.dataset.sessionId + ':' + (li.querySelector('.steward-board-thread-title') || {}).textContent)`)));
      await ev(`document.querySelector('${rowSel(ids.A)}').click(), true`);
      ok(Boolean(await waitFor(`(window.state.currentSession && window.state.currentSession.id === '${ids.A}') ? 1 : null`)), 'S-05a 点行打开了线程甲');
      ok(Boolean(await waitFor(`(() => { const band = document.getElementById('threadStewardBand'); return band && !band.hidden ? 1 : null; })()`)), 'S-05b 线程头的管家条出来了');
      await ev(`window.__fxRule('PATCH', '/api/sessions/${ids.A}', 500, { ok: false, error: { code: 'watch.failed', message: '后台说不行' } }), true`);
      await ev(`(() => { const box = document.getElementById('threadStewardWatch'); box.click(); return true; })()`);
      const toast = await waitFor(`(() => {
        const node = [...document.querySelectorAll('#toastTray .toast')].find(n => n.textContent.indexOf('没改成') >= 0);
        return node ? { cls: node.className, text: node.textContent } : null;
      })()`, 200);
      ok(Boolean(toast) && /\berr\b/.test(toast.cls) && /后台说不行/.test(toast.text) && !/Failed to fetch|^\s*\{/.test(toast.text),
        `S-05c 交接开关写失败：出 err 样式的 toast，且是人话（实测 ${JSON.stringify(toast)}）`);
      ok(await ev(`document.getElementById('threadStewardWatch').checked === false`), 'S-05d 开关弹回「没盯」');
      await ev(`window.__fxClear(), true`);
    });

    /* ═════════ 安静卡（页内另建一份实例，状态由测试控制）：S-09／S-10／S-11／S-15 ═════════ */
    await phase('quiet', async () => {
      const setup = await ev(`(async () => {
        const zh = ${JSON.stringify(ZH)};
        const t = (key, vars) => String(zh[key] == null ? key : zh[key]).replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
        const m = await import('/js/quiet-card.js');
        const q = window.__q = { notes: [], posts: [], failures: [], api: null, settings: { version: 1, enabled: true, quietStart: '00:00', quietEnd: '00:00' }, state: { currentSession: { id: 'sess_seated' } } };
        class FakeNotification { constructor(title, opts) { q.notes.push({ title, body: opts && opts.body }); } }
        FakeNotification.permission = 'granted';
        q.make = () => m.createQuietCard({
          t, state: q.state, shellModeOf: () => 'classic',
          api: (...args) => q.api(...args),
          notifyFailure: text => q.failures.push(text),
          notifySettingsOf: () => q.settings,
          notificationApi: FakeNotification,
          missionRowOf: () => ({ title: '那条线程' }),
        });
        q.inst = q.make();
        q.clear = () => { for (const node of document.querySelectorAll('#quietCardHost .quiet-card')) node.remove(); q.notes.length = 0; q.posts.length = 0; q.failures.length = 0; };
        return { host: Boolean(document.getElementById('quietCardHost')) };
      })()`);
      ok(setup && setup.host, 'Q0 页面里建出一份安静卡实例（有宿主）');

      const frame = (sid, extra = {}) => ({ quiet: true, kind: 'needs_you', sessionId: sid, ask: '这件事要等吗', ...extra });
      const clock = minutes => { const m = ((minutes % 1440) + 1440) % 1440; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };

      // S-15：时段覆盖此刻。没开本机通知（默认）→ 卡照出；开了 → 不出。
      const hereMinutes = await ev(`(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); })()`);
      const coveringNow = { version: 1, quietStart: clock(hereMinutes - 60), quietEnd: clock(hereMinutes + 60) };
      const s15off = await ev(`(() => {
        const q = window.__q; q.clear(); q.settings = ${JSON.stringify({ ...coveringNow, enabled: false })};
        q.inst.onFrame(${JSON.stringify(frame('sess_s15a'))});
        return { card: Boolean(q.inst.cardFor('sess_s15a')) };
      })()`);
      ok(s15off.card === true, 'S-15a 没开本机通知（默认 enabled:false）、免打扰时段覆盖此刻 → 安静卡照出（修前夜里一张都不出）');
      const s15on = await ev(`(() => {
        const q = window.__q; q.clear(); q.settings = ${JSON.stringify({ ...coveringNow, enabled: true })};
        q.inst.onFrame(${JSON.stringify(frame('sess_s15b'))});
        return { card: Boolean(q.inst.cardFor('sess_s15b')) };
      })()`);
      ok(s15on.card === false, 'S-15b 开了本机通知、时段覆盖此刻 → 不出卡（用户自己调的免打扰仍然生效）');

      // S-09：桌面壳 → postMessage；浏览器 → Notification。
      const s09 = await ev(`(() => {
        const q = window.__q; q.clear(); q.settings = { version: 1, enabled: true, quietStart: '00:00', quietEnd: '00:00' };
        const realChrome = window.chrome; const had = Object.prototype.hasOwnProperty.call(window, '__ruyiDesktop');
        window.__ruyiDesktop = 1; window.chrome = { webview: { postMessage: msg => q.posts.push(msg) } };
        try { q.inst.onFrame(${JSON.stringify(frame('sess_s09a', { ask: '桌面壳里这一句要送到托盘' }))}); }
        finally { window.chrome = realChrome; if (!had) delete window.__ruyiDesktop; }
        const desktop = { posts: q.posts.slice(), notes: q.notes.slice() };
        q.clear();
        q.inst.onFrame(${JSON.stringify(frame('sess_s09b', { ask: '浏览器里这一句走 Notification' }))});
        return { desktop, browser: { posts: q.posts.slice(), notes: q.notes.slice() } };
      })()`);
      const post = s09.desktop.posts[0] && s09.desktop.posts[0].ruyiNotification;
      ok(s09.desktop.posts.length === 1 && post && post.title === '那条线程' && /桌面壳里这一句/.test(post.body || '') && s09.desktop.notes.length === 0,
        `S-09a 桌面壳里经 chrome.webview.postMessage({ ruyiNotification:{ title, body } }) 投递，不再只 new Notification（实测 ${JSON.stringify(s09.desktop)}）`);
      ok(s09.browser.posts.length === 0 && s09.browser.notes.length === 1 && /浏览器里这一句/.test(s09.browser.notes[0].body || ''),
        `S-09b 没有桌面壳时仍回落到 Notification（实测 ${JSON.stringify(s09.browser)}）`);

      // S-10：撤卡的几个口。
      const s10 = await ev(`(() => {
        const q = window.__q; q.clear(); q.settings = { version: 1, enabled: false, quietStart: '00:00', quietEnd: '00:00' };
        const out = {};
        q.inst.onFrame(${JSON.stringify(frame('sess_t1'))});
        q.inst.onThreadState({ sessionId: 'sess_t1', state: 'needs_you' });
        out.keptWhileNeedsYou = Boolean(q.inst.cardFor('sess_t1'));
        q.inst.onThreadState({ sessionId: 'sess_t1', state: 'running' });
        out.removedWhenNotNeedsYou = !q.inst.cardFor('sess_t1');
        q.inst.onFrame(${JSON.stringify(frame('sess_t2', { kind: 'failed', ask: '这回合失败了' }))});
        q.inst.onThreadState({ sessionId: 'sess_t2', state: 'running' });
        out.failedCardNotTouchedByState = Boolean(q.inst.cardFor('sess_t2'));
        q.inst.onThreadGone({ sessionId: 'sess_t2' });
        out.removedWhenGone = !q.inst.cardFor('sess_t2');
        // 订阅：模块在 bind 里真的订了 thread.state／thread.done／thread.removed。
        const handlers = {}; q.inst.bind({ on: (name, fn) => { handlers[name] = fn; } });
        out.subscribed = ['thread.state', 'thread.done', 'thread.removed', 'inbox.appended'].filter(name => typeof handlers[name] === 'function');
        q.inst.onFrame(${JSON.stringify(frame('sess_t3'))});
        handlers['thread.done']({ sessionId: 'sess_t3' });
        out.removedByDoneFrame = !q.inst.cardFor('sess_t3');
        q.inst.onFrame(${JSON.stringify(frame('sess_t4'))});
        handlers['thread.removed']({ sessionId: 'sess_t4' });
        out.removedByRemovedFrame = !q.inst.cardFor('sess_t4');
        return out;
      })()`);
      ok(s10.keptWhileNeedsYou && s10.removedWhenNotNeedsYou, `S-10a thread.state 说它还在等你就留着，不再等你了就撤 needs_you 卡（${JSON.stringify([s10.keptWhileNeedsYou, s10.removedWhenNotNeedsYou])}）`);
      ok(s10.failedCardNotTouchedByState && s10.removedWhenGone, 'S-10b failed 卡不由「是否在等你」决定；线程收工／没了才撤');
      ok(s10.subscribed.length === 4 && s10.removedByDoneFrame && s10.removedByRemovedFrame,
        `S-10c bind 里订了 thread.state／thread.done／thread.removed，收到帧就撤（订到 ${JSON.stringify(s10.subscribed)}）`);

      // 打开该会话 → 撤它的卡（#sessionTitle 变＝换了线程）。
      const s10open = await ev(`(async () => {
        const q = window.__q; q.clear();
        q.state.currentSession = { id: 'sess_seated' };
        q.inst.onFrame(${JSON.stringify(frame('sess_open'))});
        const before = Boolean(q.inst.cardFor('sess_open'));
        q.state.currentSession = { id: 'sess_open' };
        const title = document.getElementById('sessionTitle');
        const keep = title.textContent;
        title.textContent = keep + ' ';
        await new Promise(resolve => setTimeout(resolve, 150));
        title.textContent = keep;
        q.state.currentSession = { id: 'sess_seated' };
        return { before, after: Boolean(q.inst.cardFor('sess_open')) };
      })()`);
      ok(s10open.before === true && s10open.after === false, `S-10d 用户打开那条会话时，它的安静卡撤掉（实测 ${JSON.stringify(s10open)}）`);

      // 候选答案：问题已经过期（服务端报业务错）→ 提示 ＋ 撤卡；断网 → 提示、卡留着可重试。
      const s10answer = await ev(`(async () => {
        const q = window.__q; q.clear();
        const options = [{ id: 'wait', label: '等' }];
        const mk = sid => q.inst.onFrame({ quiet: true, kind: 'needs_you', sessionId: sid, ask: '要等吗', options, interventionId: 'iv_1', answerQuestionId: 'q_1' });
        const click = sid => { const b = document.querySelector('#quietCardHost .quiet-card[data-session-id="' + sid + '"] .quiet-card-btn-option'); if (b) b.click(); return Boolean(b); };
        const settle = () => new Promise(resolve => setTimeout(resolve, 150));
        const out = {};
        q.api = async () => { throw new Error(JSON.stringify({ ok: false, error: { code: 'intervention.not_found', message: 'gone' } })); };
        mk('sess_gone'); out.clickedGone = click('sess_gone'); await settle();
        out.goneRemoved = !q.inst.cardFor('sess_gone'); out.goneNote = q.failures.slice();
        q.failures.length = 0;
        q.api = async () => { throw new TypeError('Failed to fetch'); };
        mk('sess_net'); out.clickedNet = click('sess_net'); await settle();
        out.netKept = Boolean(q.inst.cardFor('sess_net')); out.netNote = q.failures.slice();
        q.failures.length = 0;
        q.api = async () => ({ ok: false, error: 'not pending' });
        mk('sess_soft'); click('sess_soft'); await settle();
        out.softRemoved = !q.inst.cardFor('sess_soft');
        return out;
      })()`);
      ok(s10answer.clickedGone && s10answer.goneRemoved && s10answer.goneNote.length === 1 && s10answer.goneNote[0] === ZH['quietCard.answerGone'],
        `S-10e 候选答案点下去、问题已经过期 → 提示「${ZH['quietCard.answerGone']}」并撤卡（实测 ${JSON.stringify([s10answer.goneRemoved, s10answer.goneNote])}）`);
      ok(s10answer.clickedNet && s10answer.netKept && s10answer.netNote.length === 1 && !/Failed to fetch/.test(s10answer.netNote[0]),
        `S-10f 断网：提示（人话，不是 Failed to fetch）、卡留着可重试（实测 ${JSON.stringify([s10answer.netKept, s10answer.netNote])}）`);
      ok(s10answer.softRemoved, 'S-10g 接口回 {ok:false} 同样按「已经过去了」撤卡');
      // 合并规则本身没变：线程一直在等你时，同线程同类 5 分钟内连来两帧 → 一张卡、计数 2
      // （quiet-card.browser 的真流程里「答完再问」先撤旧卡，走的是另一支，见那一件的 D 组头注）。
      const merged = await ev(`(() => {
        const q = window.__q; q.clear(); q.settings = { version: 1, enabled: false, quietStart: '00:00', quietEnd: '00:00' };
        q.inst.onFrame(${JSON.stringify(frame('sess_merge'))});
        q.inst.onFrame(${JSON.stringify(frame('sess_merge', { ask: '还是这件事' }))});
        const cards = [...document.querySelectorAll('#quietCardHost .quiet-card[data-session-id="sess_merge"]')];
        const badge = cards[0] && cards[0].querySelector('.quiet-card-count');
        return { n: cards.length, badge: badge ? badge.textContent : '' };
      })()`);
      ok(merged.n === 1 && merged.badge === '2', `S-10h 线程一直在等你时同类两帧仍合并成一张卡、计数 2（实测 ${JSON.stringify(merged)}）`);
      await ev(`window.__q.clear(), true`);
    });

    await phase('S-11', async () => {
      const outcomes = await ev(`(async () => {
        const m = await import('/js/session-experience.js');
        const out = {};
        for (const status of ['succeeded', 'failed', 'timed_out', 'cancelled', 'partial', 'stopped', 'interrupted', 'weird']) out[status] = m.backgroundToastOutcome(status);
        return out;
      })()`);
      const want = { succeeded: 'ok', failed: 'err', timed_out: 'err', cancelled: '', partial: 'warn', stopped: '', interrupted: 'err' };
      const good = Object.entries(want).every(([status, kind]) => outcomes[status].kind === kind
        && outcomes[status].key === 'chat.background.' + status && ZH[outcomes[status].key]);
      ok(good, `S-11a 七种终态各有文案键与颜色（partial=warn、stopped／cancelled=中性、失败类=err；实测 ${JSON.stringify(outcomes)}）`);
      ok(outcomes.weird.key === 'chat.background.finished' && outcomes.weird.kind === '' && ZH['chat.background.finished'],
        'S-11b 表外状态不显示「[chat.background.xxx]」，回落一句通用的「已结束」');
    });

    /* ═════════ 管家视角：P1／S-08／S-06／S-13／S-02／S-03／S-07 ═════════ */
    // 线程「等你那条」起一个等你回答的问题：待决留在服务端，进管家视角时到访摘要与左栏都会看到。
    // （放在这里而不是 prepare：那条 /api/chat/stream 连接空闲 10 分钟会被客户端超时掐掉，待决跟着被取消 —— 机器忙时前面的组会拖很久。）
    await phase('ask', async () => {
      void fx.request('POST', '/api/chat/stream', { sessionId: ids.S, message: 'ask about wait', cwd: fx.work }, 1800000);
      const pending = await waitForHttp(fx.appPort, 'GET', '/api/interventions?limit=100',
        r => ((r.json && r.json.pending) || []).some(item => item && item.sessionId === ids.S), fx.token, 900);
      ok(Boolean(pending), 'F1 线程「等你那条」真的停在待决上了（服务端事实）');
      if (pending) ids.interventionId = String(((pending.json.pending || []).find(item => item.sessionId === ids.S) || {}).id || '');
    });

    // P1：窄窗口下一进管家视角就自动打开焦点线程的抽屉 —— #stewardShell 不许被横向拨动。
    await phase('P1', async () => {
      await fx.resize(1024, 700);
      await fx.setLens('steward');
      ok(Boolean(await waitFor(`(() => { const d = document.getElementById('stewardDrawer'); return d && !d.hidden && d.dataset.sessionId ? 1 : null; })()`)),
        'P1a 1024 宽进管家视角，焦点线程的抽屉自己开了');
      await sleep(900);
      const geometry = () => ev(`(() => {
        const shell = document.getElementById('stewardShell');
        const input = document.getElementById('stewardComposerInput');
        const rect = input ? input.getBoundingClientRect() : null;
        return { scrollLeft: shell ? shell.scrollLeft : -1, inputLeft: rect ? Math.round(rect.left) : null, inputWidth: rect ? Math.round(rect.width) : null };
      })()`);
      let g = await geometry();
      ok(g.scrollLeft === 0 && g.inputLeft >= 0 && g.inputWidth > 0,
        `P1b 1024 宽：#stewardShell.scrollLeft 是 0，中栏输入框在视口里（实测 ${JSON.stringify(g)}）`);
      // 换去「在问你」的那条线程：openThread 末尾的 focusAsk 同样不许把容器拨走。
      await ev(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${ids.S}' } })), true`);
      ok(Boolean(await waitFor(`(() => { const d = document.getElementById('stewardDrawer'); return d && d.dataset.sessionId === '${ids.S}' ? 1 : null; })()`)), 'P1c 焦点换到「等你那条」');
      await sleep(900);
      g = await geometry();
      ok(g.scrollLeft === 0 && g.inputLeft >= 0, `P1d 焦点落进问答区之后 scrollLeft 仍是 0（实测 ${JSON.stringify(g)}）`);
      await fx.resize(1180, 700);
      await ev(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${ids.A}' } })), true`);
      await sleep(900);
      g = await geometry();
      ok(g.scrollLeft === 0 && g.inputLeft >= 0, `P1e 1180 宽同样 scrollLeft 是 0（实测 ${JSON.stringify(g)}）`);
      await fx.resize(1280, 900);
    });

    await phase('S-08', async () => {
      ok(Boolean(await waitFor(`document.getElementById('stewardAvatar') && document.getElementById('stewardAvatar').dataset.state === 'waiting_you' ? 1 : null`, 500)),
        'S-08a 有线程在等你（到访摘要里有待决）→ 头像是「等你确认」');
      const answered = await fx.request('POST', '/api/chat/answer', {
        sessionId: ids.S, questionId: ids.interventionId,
        answers: [{ questionId: 'q_wait', selectedOptionIds: ['wait'], otherText: '' }], content: '等',
      });
      ok(Boolean(answered && answered.json && answered.json.ok === true), `S-08b 待决在别处答掉了（HTTP ${answered && answered.status}）`);
      ok(Boolean(await waitFor(`document.getElementById('stewardAvatar').dataset.state !== 'waiting_you' ? 1 : null`, 700)),
        'S-08c 待决处理完，头像不再停在「等你确认」（修前 pendingCount 只在到访那一刻写一次）');
      const state = await ev(`document.getElementById('stewardAvatar').dataset.state`);
      ok(state !== 'waiting_you', `S-08d 头像稳定下来不是「等你确认」（实测 ${state}）`);
    });

    const focusThread = async id => {
      await ev(`document.dispatchEvent(new CustomEvent('steward:focus-thread', { detail: { sessionId: '${id}' } })), true`);
      return waitFor(`(() => { const d = document.getElementById('stewardDrawer'); return d && !d.hidden && d.dataset.sessionId === '${id}' ? 1 : null; })()`);
    };

    await phase('S-06', async () => {
      ok(Boolean(await focusThread(ids.A)), 'S-06a 抽屉开在线程甲');
      // 诊断（只在失败时打印）：谁在什么时候改了输入框的值、抽屉当时在哪条线程上。
      await ev(`(() => {
        window.__vlog = [];
        for (const id of ['stewardDrawerInput', 'stewardDrawerAskInput']) {
          const node = document.getElementById(id);
          const proto = Object.getPrototypeOf(node);
          const desc = Object.getOwnPropertyDescriptor(proto, 'value');
          Object.defineProperty(node, 'value', { configurable: true, get() { return desc.get.call(this); },
            set(v) { window.__vlog.push({ id, v: String(v), drawer: document.getElementById('stewardDrawer').dataset.sessionId, at: Date.now() % 100000, stack: String(new Error().stack).split('\\n').slice(2, 4).map(l => l.trim().slice(0, 60)).join(' < ') }); desc.set.call(this, v); } });
        }
        return true;
      })()`);
      await ev(`(() => { document.getElementById('stewardDrawerInput').value = '给甲的话'; document.getElementById('stewardDrawerAskInput').value = '给甲的回答'; return true; })()`);
      ok(Boolean(await focusThread(ids.B)), 'S-06b 焦点换到线程乙');
      const onB = await ev(`({ direct: document.getElementById('stewardDrawerInput').value, ask: document.getElementById('stewardDrawerAskInput').value })`);
      ok(onB.direct === '' && onB.ask === '', `S-06c 换线程之后两个输入框是空的（甲的话不会被回车发给乙；实测 ${JSON.stringify(onB)}）`);
      await ev(`(() => { document.getElementById('stewardDrawerInput').value = '给乙的话'; return true; })()`);
      await focusThread(ids.A);
      const backA = await ev(`({ direct: document.getElementById('stewardDrawerInput').value, ask: document.getElementById('stewardDrawerAskInput').value })`);
      ok(backA.direct === '给甲的话' && backA.ask === '给甲的回答', `S-06d 回到线程甲，甲那两句原样放回来（实测 ${JSON.stringify(backA)}）`);
      if (backA.direct !== '给甲的话') console.log('DIAG S-06 输入框写入记录：' + JSON.stringify(await ev('window.__vlog')));
      await focusThread(ids.B);
      const backB = await ev(`document.getElementById('stewardDrawerInput').value`);
      ok(backB === '给乙的话', `S-06e 回到线程乙，乙那句也在（实测「${backB}」）`);
      await ev(`(() => { document.getElementById('stewardDrawerInput').value = ''; return true; })()`);
      await focusThread(ids.A);
    });

    await phase('S-13', async () => {
      // 当前在线程甲，输入框里是「给甲的话」。relay 被拒 → 字还在；放行 → 清空。
      await ev(`window.__fxRule('POST', '/api/steward/relay', 409, { ok: false, error: { code: 'relay_failed', message: 'nope' } }), true`);
      await ev(`document.getElementById('stewardDrawerSendBtn').click(), true`);
      ok(Boolean(await waitFor(`window.__fx.calls.some(c => c.url.indexOf('/api/steward/relay') >= 0 && c.status === 409) ? 1 : null`)), 'S-13a 递话请求发出并被拒（409）');
      await sleep(400);
      const kept = await ev(`document.getElementById('stewardDrawerInput').value`);
      ok(kept === '给甲的话', `S-13b 被拒之后输入框里那句话还在，不用重打（实测「${kept}」；修前先清后发，丢了）`);
      await ev(`window.__fxRule('POST', '/api/steward/relay', 200, { ok: true, channel: 'turn' }), true`);
      await ev(`document.getElementById('stewardDrawerSendBtn').click(), true`);
      ok(Boolean(await waitFor(`document.getElementById('stewardDrawerInput').value === '' ? 1 : null`)), 'S-13c 递话成功之后才清空输入框');
      await ev(`window.__fxClear(), true`);
    });

    await phase('S-02', async () => {
      ok(Boolean(await focusThread(ids.A)), 'S-02a 抽屉开在线程甲');
      // 停止与回退两个写口桩掉（本件只看「发给了谁」，不真的去回退）。
      await ev(`window.__fxRule('POST', '/api/stop', 200, { ok: true }), window.__fxRule('POST', '/api/session/rewind', 200, { ok: true }), true`);
      const openConfirm = async () => {
        for (let i = 0; i < 6; i++) {
          await ev(`document.getElementById('stewardDrawerRewindBtn').click(), true`);
          if (await waitFor(`document.querySelector('.modal-backdrop.confirm-panel [data-confirm="ok"]') ? 1 : null`, 40)) return true;
          await sleep(600);   // 会话还没读回来（没有可回退的回合）时按钮只回一句提示，等一等再按
        }
        return false;
      };
      ok(await openConfirm(), 'S-02b 点「整单回退」弹出确认框');
      const before = await ev(`window.__fx.calls.length`);
      ok(Boolean(await focusThread(ids.B)), 'S-02c 确认框开着的时候焦点被切去线程乙');
      await ev(`document.querySelector('.modal-backdrop.confirm-panel [data-confirm="ok"]').click(), true`);
      await sleep(900);
      const switched = await ev(`({
        writes: window.__fx.calls.slice(${before}).filter(c => c.method === 'POST' && (c.url.indexOf('/api/stop') >= 0 || c.url.indexOf('/api/session/rewind') >= 0)).map(c => c.url + ' ' + c.body),
        note: (document.getElementById('stewardDrawerNote') || {}).textContent || '',
      })`);
      ok(switched.writes.length === 0, `S-02d 确认返回时焦点已经不在原来那条 → 不停止、不回退任何一条（修前会停掉并回退乙；实测写口 ${JSON.stringify(switched.writes)}）`);
      ok(switched.note.indexOf(ZH['stewardShell.drawer.threadSwitchedCancelled']) >= 0, `S-02e 并且说了一句人话（实测「${switched.note}」）`);

      // 对照：焦点没动 → 照常对【线程甲】动手。
      ok(Boolean(await focusThread(ids.A)), 'S-02f 回到线程甲');
      ok(await openConfirm(), 'S-02g 再点「整单回退」');
      const before2 = await ev(`window.__fx.calls.length`);
      await ev(`document.querySelector('.modal-backdrop.confirm-panel [data-confirm="ok"]').click(), true`);
      ok(Boolean(await waitFor(`window.__fx.calls.slice(${before2}).some(c => c.url.indexOf('/api/session/rewind') >= 0) ? 1 : null`)), 'S-02h 焦点没动：回退请求照常发出');
      const bodies = await ev(`window.__fx.calls.slice(${before2}).filter(c => c.method === 'POST' && (c.url.indexOf('/api/stop') >= 0 || c.url.indexOf('/api/session/rewind') >= 0)).map(c => { try { return JSON.parse(c.body).sessionId; } catch { return ''; } })`);
      ok(bodies.length >= 2 && bodies.every(id => id === ids.A), `S-02i 停止与回退发给的都是确认之前那条线程甲（线程甲 ${ids.A}；实测 ${JSON.stringify(bodies)}）`);
      await ev(`window.__fxClear(), true`);
    });

    await phase('S-03', async () => {
      const labelOf = () => ev(`(() => { const row = document.querySelector('${rowSel(ids.B)}'); const meta = row && row.querySelector('.steward-board-meta'); return meta ? meta.textContent : null; })()`);
      const before = await labelOf();
      ok(typeof before === 'string' && before.length > 0, `S-03a 线程乙行右侧有一句时间（「${before}」）`);
      await ev(`(() => { window.__realNow = Date.now; Date.now = () => window.__realNow() + 10 * 60 * 1000; window.__fx.calls.length = 0; return true; })()`);
      try {
        await ev(`document.dispatchEvent(new Event('visibilitychange')), true`);
        const called = await waitFor(`window.__fx.calls.some(c => c.url.indexOf('/api/missions') >= 0 && c.status) ? 1 : null`, 300);
        ok(Boolean(called), 'S-03b 这一拍发了 /api/missions');
        const statuses = await ev(`window.__fx.calls.filter(c => c.url.indexOf('/api/missions') >= 0).map(c => c.status)`);
        ok(statuses.includes(304), `S-03c 这一拍是 304（行没变；否则本组没有证明力；实测 ${JSON.stringify(statuses)}）`);
        const moved = await waitFor(`(() => { const row = document.querySelector('${rowSel(ids.B)}'); const meta = row && row.querySelector('.steward-board-meta'); return meta && meta.textContent !== ${JSON.stringify(before)} ? meta.textContent : null; })()`, 200);
        ok(Boolean(moved), `S-03d 304 时左栏也重画：行右侧时间按此刻重算（「${before}」→「${moved}」；修前 304 分支只刷状态行，一直停在旧值）`);
      } finally { await ev(`(() => { if (window.__realNow) Date.now = window.__realNow; return true; })()`); }
    });

    await phase('S-07', async () => {
      const count = prefix => ev(`window.__fx.calls.filter(c => c.method === 'GET' && c.url.indexOf(${JSON.stringify(prefix)}) >= 0).length`);
      const openPocket = async name => {
        await ev(`document.querySelector('.rail-pocket-item[data-pocket="${name}"]').click(), true`);
        return waitFor(`(() => { const m = document.getElementById('settingsModal'); return m && !m.classList.contains('hidden') ? 1 : null; })()`);
      };
      const closeSettings = async () => {
        await ev(`(() => { const b = document.querySelector('#settingsModal [data-close-modal]'); if (b) b.click(); return true; })()`);
        return waitFor(`document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null`);
      };
      for (const [name, prefix] of [['memory', '/api/steward/memory'], ['decisions', '/api/steward/decisions']]) {
        ok(Boolean(await openPocket(name)), `S-07a 口袋「${name}」第一次打开，设置弹层出来了`);
        await sleep(600);
        const first = await count(prefix);
        ok(first >= 1, `S-07b 第一次打开拉了一次 ${prefix}（${first}）`);
        await closeSettings();
        ok(Boolean(await openPocket(name)), `S-07c 口袋「${name}」第二次打开`);
        const reloaded = await waitFor(`window.__fx.calls.filter(c => c.method === 'GET' && c.url.indexOf(${JSON.stringify(prefix)}) >= 0).length > ${first} ? 1 : null`, 200);
        ok(Boolean(reloaded), `S-07d 第二次打开又重载了被点名的那一段 ${prefix}（修前只首次加载，之后显示旧列表）`);
        await closeSettings();
      }
    });

    ok(fx.exceptions.length === 0, `Z1 页面没有未捕获异常（${fx.exceptions.slice(0, 3).join(' | ') || '无'}）`);
  } catch (error) {
    t.fail('未预期异常：' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: false });
  }
  t.done({ exit: true });
})();
