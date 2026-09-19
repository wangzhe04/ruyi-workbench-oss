#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 128f-⑪(用户 2026-09-19 拍板 A「立刻通知你」)前端那一半:quiet-card.js 的 onDeferred 收 steward.deferred 帧之后做什么。
// 服务端那一半(什么时候发这一帧、窗口多长)在 steward-deferred-permission.e2e;这里在真页面里 import 模块、单独建一份实例
// (假 Notification 记下每一次系统通知;视角、坐没坐、前台与否都由测试控制),逐条钉:
//   Q1 工作台、没坐在那条线程上 → 出一张 needs_you 安静卡,卡头以「如意留给你了，还等 N 分钟」起头;发一次系统通知。
//   Q2 工作台、正坐在那条线程上 → 什么都不出(请求是当面弹着的)。
//   Q3 管家视角、页面在前台 → 不出卡、不发通知(管家那句「留给你」已经在对话流里)。
//   Q4 管家视角、页面不在前台 → 发一条系统通知、不出卡;同一条请求再来一帧不发第二次。
//   Q5 静默时段 → 什么都不出。
//   Q6 没有截止时刻 → 换那句不说分钟的话。
//   Q7 模块在 bind 里真的订了 steward.deferred(上面都是直接调 onDeferred,拿掉订阅的话服务端发了也没人接)。
// 判定行:`STEWARD DEFERRED NOTICE BROWSER E2E: ALL PASS`。
const { startBrowserFixture } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-deferred-notice-', width: 1280, height: 860 });
    const setup = await fx.evaluate(`(async () => {
      const zh = await (await fetch('/locales/zh-CN.json')).json();
      const t = (key, vars) => String(zh[key] == null ? key : zh[key]).replace(/\\{\\{(\\w+)\\}\\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ''));
      const m = await import('/js/quiet-card.js');
      window.__qc = { notes: [], mode: 'classic', quiet: false, hidden: false, focused: true };
      class FakeNotification { constructor(title, opts) { window.__qc.notes.push({ title, body: opts && opts.body, tag: opts && opts.tag }); } }
      FakeNotification.permission = 'granted';
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.__qc.hidden });
      document.hasFocus = () => window.__qc.focused;
      window.__qc.inst = m.createQuietCard({
        t,
        state: { currentSession: { id: 'sess_seated' } },
        shellModeOf: () => window.__qc.mode,
        notifySettingsOf: () => (window.__qc.quiet ? { enabled: true, quietStart: '00:00', quietEnd: '23:59' } : { enabled: true }),
        notificationApi: FakeNotification,
        missionRowOf: () => ({ title: '那条线程' }),
      });
      return { host: Boolean(document.getElementById('quietCardHost')), hasOnDeferred: typeof window.__qc.inst.onDeferred === 'function' };
    })()`);
    ok(setup && setup.host && setup.hasOnDeferred, `Q0 页面里建出一份安静卡实例（有宿主 ${setup && setup.host}、有 onDeferred ${setup && setup.hasOnDeferred}）`);
    const frame = (sid, iv, minutes) => ({
      sessionId: sid, interventionId: iv, ask: '请求执行工具 powershell_run · exec',
      deadlineAt: minutes == null ? '' : new Date(Date.now() + minutes * 60000 + 20000).toISOString(),
    });
    const fire = (f, opts = {}) => fx.evaluate(`(() => {
      Object.assign(window.__qc, ${JSON.stringify({ mode: 'classic', quiet: false, hidden: false, focused: true, ...opts })});
      const before = window.__qc.notes.length;
      window.__qc.inst.onDeferred(${JSON.stringify(f)});
      const card = window.__qc.inst.cardFor(${JSON.stringify(f.sessionId)});
      return { notes: window.__qc.notes.slice(before), card: card ? { kind: card.kind, ask: card.frame && card.frame.ask } : null };
    })()`);

    const q1 = await fire(frame('sess_q1', 'perm_q1', 10));
    ok(q1.card && q1.card.kind === 'needs_you' && /^如意留给你了，还等 10 分钟：请求执行工具 powershell_run/.test(q1.card.ask),
      `Q1 工作台、没坐着 → needs_you 安静卡，卡上那句以「还等 10 分钟」起头（实测 ${JSON.stringify(q1.card)}）`);
    ok(q1.notes.length === 1 && /还等 10 分钟/.test(q1.notes[0].body || ''),
      `Q1b 同时发一次系统通知，前 22 字里就有「还等 10 分钟」（实测 ${JSON.stringify(q1.notes)}）`);

    const q2 = await fire(frame('sess_seated', 'perm_q2', 10));
    ok(!q2.card && q2.notes.length === 0, `Q2 工作台、正坐在那条线程上 → 不出卡、不发通知（实测 卡 ${Boolean(q2.card)} / 通知 ${q2.notes.length}）`);

    const q3 = await fire(frame('sess_q3', 'perm_q3', 10), { mode: 'steward', hidden: false, focused: true });
    ok(!q3.card && q3.notes.length === 0, `Q3 管家视角、页面在前台 → 不出卡、不发通知（实测 卡 ${Boolean(q3.card)} / 通知 ${q3.notes.length}）`);

    const q4 = await fire(frame('sess_q4', 'perm_q4', 7), { mode: 'steward', hidden: true, focused: false });
    ok(!q4.card && q4.notes.length === 1 && /还等 7 分钟/.test(q4.notes[0].body || '') && q4.notes[0].title === '那条线程',
      `Q4 管家视角、页面不在前台 → 发一条系统通知（标题是线程名）、不出卡（实测 ${JSON.stringify(q4)}）`);
    const q4b = await fire(frame('sess_q4', 'perm_q4', 6), { mode: 'steward', hidden: true, focused: false });
    ok(q4b.notes.length === 0, `Q4b 同一条请求再来一帧不发第二次（实测 ${q4b.notes.length}）`);
    const q4c = await fire(frame('sess_q4', 'perm_q4c', 5), { mode: 'steward', hidden: false, focused: false });
    ok(q4c.notes.length === 1, `Q4c 页面没藏起来、但窗口没有焦点（用户在别的程序里）也算人不在 → 发（实测 ${q4c.notes.length}）`);

    const q5 = await fire(frame('sess_q5', 'perm_q5', 10), { quiet: true });
    ok(!q5.card && q5.notes.length === 0, `Q5 静默时段 → 什么都不出（实测 卡 ${Boolean(q5.card)} / 通知 ${q5.notes.length}）`);

    const q6 = await fire(frame('sess_q6', 'perm_q6', null));
    ok(q6.card && q6.card.ask === '如意留给你了：请求执行工具 powershell_run · exec', `Q6 没有截止时刻 → 不说分钟（实测「${q6.card && q6.card.ask}」）`);
    // 上面是直接调 onDeferred；真页面里那一份实例得真的订了这一帧（bind 里那一行）—— 拿掉它，服务端发了也没人接。
    const src = await fx.evaluate(`(async () => (await fetch('/js/quiet-card.js')).text())()`);
    ok(/eventStream\.on\('steward\.deferred', onDeferred\)/.test(String(src || '')), 'Q7 安静卡模块在 bind 里订了 steward.deferred（组合根那一份实例据此收帧）');
    ok(fx.exceptions.length === 0, `Q9 页面没有未捕获异常（${fx.exceptions.slice(0, 3).join(' | ') || '无'}）`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: false });
  }
  console.log(fail === 0 ? 'STEWARD DEFERRED NOTICE BROWSER E2E: ALL PASS' : `STEWARD DEFERRED NOTICE BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
