#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：经典壳流式回合在「切走再切回」与压缩指示条上的几处前端缺陷（前端 bug 扫查批）。
//
// 做法：起隔离工作台（只借它的同源静态服务），把页面导到一个同源空白页，在页里 import 真的
// chat-stream-runtime.js 与 turn-activity.js，其余依赖注入最小桩；/api/chat/stream 由页内假 fetch 供流，
// 测试逐帧往里推事件。这样判据落在【真 DOM、真计时器、真 rAF】上，而不是读源码。
//
//   R1 工具卡在跑时切走再切回（mountActiveTurn 重建实时壳）：旧壳身上的 1s 秒表被停掉，不在脱离文档的节点上一直走；
//      回合收尾后本页零残留 setInterval。
//   R2 切走再切回之后按「停止」：「已停止」落在屏上那只新壳里，闪烁光标收掉（修前画到闭包里那只已脱离的旧壳）。
//   R3 回合末 GET /api/sessions/:id 在飞时用户切到另一条：回包不许把 state.currentSession 与标题写回原会话。
//   R4 会话处于插话/排队/等批准（别处起的回合）时点「压缩」：只给一句提示，不开指示条、不禁用按钮、不发 /compact。
//   R5 Claude /compact 这一发 sendPrompt 没起回合就返回（同步上下文窗口失败）：指示条随之收掉，按钮恢复。
//   R6 流内 compact 'started'（自动压缩）起的指示条不挂 5 分钟超时（不会误报「压缩超时」）；回合被停、completed 没到，
//      指示条随回合收尾静默收掉。手动按钮那一路仍挂超时（对照）。
//   R7 挂着权限申请时按停止：活动状态条不再停在「等你拍板」。
//   R9 文件树后发先至：先点的工作区读盘慢、后点的快，晚到的旧结果不许盖掉新工作区的树。
//   R10 长回复流式期间正文分块(perf):尾巴攒满且有换行就把前面封进块级 .live-chunk —— 屏上文本与流出的逐字相同、
//       只剩尾巴一个裸文本节点在长;没有换行的一整段不切;回合收尾照旧换成一份 Markdown(不留分块)。
//       R10f 用户在尾巴里选着字时不切(挪走文本会清掉选区),松手后照常切;R10g 思维链面板同样分块、文本逐字相同。
//   R11 回合收尾的增量取(perf):回合起点 session 事件带 messagesStamp → 收尾只发一发 ?fromIndex=N&prefixStamp=S 并拼接;
//       不带戳 / 服务端落回全量 / 拼接自检不符 三种对照。四遍收尾后的会话与标题、元信息、步骤条、事项条、电量表、续跑横幅
//       拿到的输入逐项一致,乐观 user 行重绑到同一条持久化消息。
//   R13 回合起点 session 事件的增量(perf round 4):手上底子带戳 → 发送体带 knownMessages;服务端答增量事件 → 拼回发送那一刻的
//       前缀(新数组、记上新戳,于是收尾那一发从新条数接着增量);不带戳 → 发送体没有这个键(修前形状);增量事件拼不上 → 补一发无参全量。
//       三遍收尾后的会话一致。
//   R14 回合末 await 期间下一回合已经起来(插话落回 sendPrompt):旧回合的 finally 不许删掉新回合的登记 ——
//       新回合还在流时页面仍是「在跑」(按钮是停止),新回合收尾后才回到空闲。
//   R15 中止/断流之后,重取回来的会话装回 state(服务端已落盘的半截回答不会在下一次重画时从屏上消失)。
//   R16 切走切回重放事件时,一次性副作用(备用服务商切换 toast、调试面板的 stderr 行)不重来。
//   R12 屏外代码块懒高亮(perf,真 chat-render-primitives.js + vendor hljs):在文档外建好的一批行挂进滚动容器后,
//       可见区附近的代码块高亮了、离得远的还没动(连复制按钮都没补);滚过去之后它们也高亮了。已在文档里的容器照旧当场高亮。
// 判定行：`CHAT STREAM REMOUNT BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('CHAT STREAM REMOUNT BROWSER');
const { ok } = t;

// 页内夹具：window.__mk(opts) 建一份独立的 runtime；window.__h 暴露推帧/收流/计时器账本。
const HARNESS = `
window.__mk = async function (opts = {}) {
  const mod = await import('/js/chat-stream-runtime.js');
  const ta = await import('/js/turn-activity.js');
  document.body.innerHTML = '<div class="composer"><div class="composer-box"><textarea id="promptInput"></textarea><button id="sendBtn"></button><div id="composerHint"></div></div></div>'
    + '<div id="messages"></div><div id="modelChip"><i class="mc-dot"></i></div><div id="sessionTitle"></div><div id="sessionMeta"></div><button id="compactBtn">Compact</button>';
  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const state = { currentSession: { id: 'A', messages: [], turnSeq: 0 }, config: {}, streaming: false, attachments: [] };
  if (!window.__origTimers) window.__origTimers = { si: window.setInterval, ci: window.clearInterval, st: window.setTimeout, ct: window.clearTimeout };
  const O = window.__origTimers;
  const intervals = new Set();
  const toolTimers = new Set();   // 只记工具卡秒表(回调里写 card.dur);活动状态条自己的 1s 表另算
  const longTimeouts = new Set();
  window.setInterval = (f, ms, ...a) => { const id = O.si.call(window, f, ms, ...a); intervals.add(id); if (/card\.dur/.test(String(f))) toolTimers.add(id); return id; };
  window.clearInterval = id => { intervals.delete(id); toolTimers.delete(id); return O.ci.call(window, id); };
  window.setTimeout = (f, ms, ...a) => { const id = O.st.call(window, (...x) => { longTimeouts.delete(id); f(...x); }, ms, ...a); if (Number(ms) >= 60000) longTimeouts.add(id); return id; };
  window.clearTimeout = id => { longTimeouts.delete(id); return O.ct.call(window, id); };
  let streamCtl = null;
  const streamCtls = [];
  const enc = new TextEncoder();
  const streamBodies = [];
  window.fetch = (url, init) => {
    if (String(url).includes('/api/chat/stream')) {
      streamBodies.push(JSON.parse(init.body || '{}'));
      return new Promise(resolve => {
        const rs = new ReadableStream({ start(c) { streamCtl = c; streamCtls.push(c); init.signal.addEventListener('abort', () => { try { c.error(new DOMException('aborted', 'AbortError')); } catch {} }); } });
        resolve({ ok: true, body: rs, text: async () => '' });
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({}), text: async () => '' });
  };
  const toasts = [];
  const deps = {
    $, el, state, t: (k, p) => k + (p ? JSON.stringify(p) : ''), toast: m => toasts.push(m),
    api: async u => (u.startsWith('/api/sessions/') ? { session: state.currentSession } : { ok: true }),
    apiErrText: e => String((e && e.message) || e),
    agentCliMeta: () => ({ id: 'claude', nativeCompact: 'slash-command', alwaysInteractive: false }),
    appendToolOutput() {}, authHeaders: () => ({}), autoGrow() {}, cliMissingCard: () => el('div'),
    compactNarrativeProcessRuns() {}, createTurnActivity: ta.createTurnActivity, describeTurnActivity: ta.describeTurnActivity,
    currentEngineMeta: () => ({ agentCliType: 'claude', engine: 'claude' }), currentWorkspace: () => '', engineLabel: () => 'x',
    errorCard: () => el('div'), fmtTokens: x => String(x), handleAgentWorkflowEvent() {}, handlePermissionRequest() {}, handlePlanEvent() {},
    humanizeToolName: x => x, highlightIn() {}, iconTextBtn(b, i, label) { b.textContent = label; }, isProviderMode: () => false, isUntitledTitle: () => false,
    latestUsage: () => null, loadAutonomyGrants() {}, maybeScrollToBottom() {},
    messageShell() { const row = el('div', 'msg assistant'); const main = el('div', 'main'); row.appendChild(main); return { row, main }; },
    msgActions: () => el('div'), narrativeQuestionCard: () => el('div'), narrativeSemanticCard: () => el('div'), narrativeToolAnchor: id => 'turn-tool-' + id,
    newSession: async () => {}, openModal() {}, pushRawEvent() {}, refreshSessions: async () => {}, renderAttachments() {}, renderAutonomyBar() {},
    renderContextMeter() {}, renderCurrentSession() {}, renderGitDiffInto() {}, renderMarkdown: s => s, renderMissionBar() {}, renderResumeBanner() {}, renderSessions() {},
    renderStaticMessage: m => el('div', 'user-row', m.content), renderStepBar() {}, paintSessionMeta() {}, safeStringify: x => JSON.stringify(x),
    scrollMessagesToBottom() {}, settleLiveThinking() {}, showAskUserModal() {}, switchSettingsTab() {},
    thinkingPanel: () => { const d = el('details'); const body = el('div'); const summary = el('summary'); d.append(summary, body); return { d, body, summary }; },
    toolCard: ({ name }) => { const d = el('div', 'tool-card'); const status = el('span'); const statusbar = el('div', 'running'); const dur = el('span', 'dur'); const resPre = el('pre'); d.append(status, statusbar, dur, resPre); return { d, name, status, statusbar, dur, resPre, inp: el('pre'), diffHost: el('div'), imageHost: el('div'), staleHost: el('div') }; },
    toolArgSummary: () => '', toolGroupSummaryText: n => 'group' + n, turnArtifactChips: () => null, turnSummaryCard: () => el('div'), turnToolIndexCard: () => null,
    updateContextMeter() {}, updateJumpLatest() {}, usageLine: () => el('div'), wbNativeClaudeFinalize() {}, wbNativeClaudeOnSubagent() {}, wrapPreWithCopy: x => x,
    ...(opts.deps || {}),
  };
  const rt = mod.createChatStreamRuntime(deps);
  const sleep = ms => new Promise(r => O.st.call(window, r, ms));
  // 切会话：组合根的 openSession 先 renderCurrentSession(清空消息区)再 mountActiveTurn,这里照做。
  const switchTo = id => { state.currentSession = { id, messages: [] }; $('messages').innerHTML = ''; rt.mountActiveTurn(id); rt.syncStreamingUi(); };
  window.__h = {
    rt, state, intervals, toolTimers, longTimeouts, toasts, streamBodies, $, sleep, switchTo,
    push: o => streamCtl.enqueue(enc.encode(JSON.stringify(o) + '\\n')),
    end: () => streamCtl.close(),
    pushTo: (i, o) => streamCtls[i].enqueue(enc.encode(JSON.stringify(o) + '\\n')),
    endAt: i => streamCtls[i].close(),
  };
  return true;
};
true`;

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-chat-remount-' });
    // 同源空白页:页面本身不跑工作台的组合根,只借同源把 /js 模块 import 进来。
    await fx.cdp.send('Page.navigate', { url: `http://127.0.0.1:${fx.appPort}/robots.txt` });
    ok(Boolean(await fx.waitForEval(`location.pathname === '/robots.txt' && document.readyState === 'complete'`)), 'R0 同源空白页就绪');
    await fx.evaluate(HARNESS);

    // R1:旧壳工具卡秒表
    const r1 = await fx.evaluate(`(async () => {
      await window.__mk(); const h = window.__h;
      h.$('promptInput').value = 'hello'; const sp = h.rt.sendPrompt(); await h.sleep(50);
      h.push({ type: 'tool_use', id: 't1', name: 'bash', input: {} }); await h.sleep(50);
      const oldCard = h.$('messages').querySelector('.tool-card');
      const before = h.toolTimers.size;
      h.switchTo('B'); await h.sleep(20);
      h.switchTo('A'); await h.sleep(50);
      const afterMount = h.toolTimers.size;
      const oldDur0 = oldCard.querySelector('.dur').textContent;
      await h.sleep(1300);
      const oldDur1 = oldCard.querySelector('.dur').textContent;
      h.push({ type: 'tool_result', id: 't1', content: 'ok' }); h.push({ type: 'result', ok: true }); h.end();
      await sp; await h.sleep(80);
      return { before, afterMount, oldDetached: !oldCard.isConnected, oldTicked: oldDur0 !== oldDur1, afterEnd: h.intervals.size };
    })()`);
    ok(r1.oldDetached, 'R1a 切回后旧壳已不在文档里(前置成形)');
    ok(r1.before === 1 && r1.afterMount === 1, `R1b 切回重放后在跑的工具秒表仍只有一只(旧壳那只已停;切前 ${r1.before},切回 ${r1.afterMount})`);
    ok(!r1.oldTicked, 'R1c 脱离文档的旧工具卡计时不再走');
    ok(r1.afterEnd === 0, `R1d 回合收尾后本页零残留 setInterval(实为 ${r1.afterEnd})`);

    // R2:切走切回后停止
    const r2 = await fx.evaluate(`(async () => {
      await window.__mk(); const h = window.__h;
      h.$('promptInput').value = 'hello'; const sp = h.rt.sendPrompt(); await h.sleep(50);
      h.push({ type: 'assistant_delta', text: 'partial' }); await h.sleep(40);
      h.switchTo('B'); h.switchTo('A'); await h.sleep(40);
      h.rt.stopTurn(); await sp; await h.sleep(80);
      const box = h.$('messages');
      return { note: !!box.querySelector('.msg-note'), cursor: !!box.querySelector('.stream-cursor'), text: box.textContent };
    })()`);
    ok(r2.note, 'R2a 「已停止」画在屏上那只壳里');
    ok(!r2.cursor, 'R2b 屏上不再留闪烁光标');
    ok(/partial/.test(r2.text), 'R2c 停止前已流出的正文仍在屏上');

    // R3:回合末 GET 在飞时切走
    const r3 = await fx.evaluate(`(async () => {
      await window.__mk({ deps: { api: async u => {
        if (u === '/api/sessions/A') { await new Promise(r => window.__origTimers.st.call(window, r, 200)); return { session: { id: 'A', messages: [], title: 'A-title' } }; }
        return { ok: true };
      } } });
      const h = window.__h;
      h.$('promptInput').value = 'hello'; const sp = h.rt.sendPrompt(); await h.sleep(50);
      h.push({ type: 'assistant_delta', text: 'x' }); h.push({ type: 'result', ok: true }); h.end();
      await h.sleep(60);
      h.state.currentSession = { id: 'B', messages: [], title: 'B-title' }; h.$('sessionTitle').textContent = 'B-title';
      await sp; await h.sleep(40);
      return { id: h.state.currentSession.id, title: h.$('sessionTitle').textContent };
    })()`);
    ok(r3.id === 'B', `R3a 晚到的回包不把当前会话写回 A(实为 ${r3.id})`);
    ok(r3.title === 'B-title', `R3b 标题仍是刚打开的那条(实为 ${r3.title})`);

    // R4:插话 / 排队 / 等批准时点压缩
    for (const channel of ['steer', 'queued', 'permission']) {
      const r4 = await fx.evaluate(`(async () => {
        await window.__mk(); const h = window.__h;
        h.state.currentSession.messages = [{ role: 'user', content: 'x' }];
        h.state.sessionRelay = { sessionId: 'A', channel: '${channel}', live: ${channel === 'steer'} };
        await h.rt.compactContext(); await h.sleep(50);
        const bar = document.getElementById('compactIndicator');
        return { toasts: h.toasts.slice(), indicator: Boolean(bar && !bar.classList.contains('hidden')), btnDisabled: h.$('compactBtn').disabled, streams: h.streamBodies.length };
      })()`);
      ok(r4.toasts.length === 1 && !r4.toasts.includes('toast.compactRequested'), `R4a[${channel}] 只给一句提示(${r4.toasts.join(' | ')})`);
      ok(!r4.indicator && !r4.btnDisabled, `R4b[${channel}] 不开指示条、不禁用按钮`);
      ok(r4.streams === 0, `R4c[${channel}] 没有发出 /compact 回合`);
    }

    // R5:/compact 这一发没起回合
    const r5 = await fx.evaluate(`(async () => {
      await window.__mk({ deps: { syncContextWindowManual: async () => { throw new Error('sync failed'); } } });
      const h = window.__h;
      h.state.currentSession.messages = [{ role: 'user', content: 'x' }];
      await h.rt.compactContext(); await h.sleep(50);
      const bar = document.getElementById('compactIndicator');
      return { indicator: Boolean(bar && !bar.classList.contains('hidden')), btnDisabled: h.$('compactBtn').disabled, btnText: h.$('compactBtn').textContent, longTimeouts: h.longTimeouts.size, streams: h.streamBodies.length };
    })()`);
    ok(r5.streams === 0, 'R5a 前置成形:sendPrompt 没起回合');
    ok(!r5.indicator && !r5.btnDisabled && r5.btnText === 'Compact', `R5b 指示条收掉、按钮复原(${JSON.stringify(r5)})`);
    ok(r5.longTimeouts === 0, 'R5c 兜底超时一并撤掉');

    // R6:流内自动压缩起的指示条
    const r6 = await fx.evaluate(`(async () => {
      await window.__mk(); const h = window.__h;
      h.$('promptInput').value = 'hello'; const sp = h.rt.sendPrompt(); await h.sleep(50);
      h.push({ type: 'compact', phase: 'started', mode: 'external' }); await h.sleep(40);
      const bar = document.getElementById('compactIndicator');
      const shown = Boolean(bar && !bar.classList.contains('hidden'));
      const armed = h.longTimeouts.size;
      h.rt.stopTurn(); await sp; await h.sleep(60);
      const after = Boolean(bar && !bar.classList.contains('hidden'));
      // 对照:手动按钮那一路(Claude /compact)照旧挂超时
      h.state.currentSession.messages = [{ role: 'user', content: 'x' }];
      const cp = h.rt.compactContext(); await h.sleep(40);
      const manualArmed = h.longTimeouts.size;
      h.rt.stopTurn(); await cp; await h.sleep(60);
      return { shown, armed, after, manualArmed, timeoutToast: h.toasts.some(x => /compactTimeout/.test(x)) };
    })()`);
    ok(r6.shown, 'R6a 流内 started 打开指示条(前置成形)');
    ok(r6.armed === 0, `R6b 流内起的指示条不挂超时(挂了 ${r6.armed} 个)`);
    ok(!r6.after, 'R6c 回合被停(completed 未到):指示条随回合收尾收掉');
    ok(r6.manualArmed === 1, `R6d 对照:手动压缩仍挂兜底超时(实为 ${r6.manualArmed})`);
    ok(!r6.timeoutToast, 'R6e 全程没有「压缩超时」误报');

    // R6f:压缩中的回合在【后台】收尾(用户切到另一条也在跑的会话,setStreaming 不会替它收)——指示条照样收掉。
    const r6f = await fx.evaluate(`(async () => {
      await window.__mk(); const h = window.__h;
      h.switchTo('B'); h.$('promptInput').value = 'b'; const spB = h.rt.sendPrompt(); await h.sleep(40);   // 流 0 = B
      h.switchTo('A'); h.$('promptInput').value = 'a'; const spA = h.rt.sendPrompt(); await h.sleep(40);   // 流 1 = A
      h.pushTo(1, { type: 'compact', phase: 'started', mode: 'external' }); await h.sleep(40);
      const bar = document.getElementById('compactIndicator');
      const shown = Boolean(bar && !bar.classList.contains('hidden'));
      h.switchTo('B'); await h.sleep(30);
      const stillShownOnB = Boolean(bar && !bar.classList.contains('hidden'));
      h.pushTo(1, { type: 'result', ok: false }); h.endAt(1); await spA; await h.sleep(60);
      const afterA = Boolean(bar && !bar.classList.contains('hidden'));
      h.pushTo(0, { type: 'result', ok: true }); h.endAt(0); await spB; await h.sleep(40);
      return { shown, stillShownOnB, afterA, longTimeouts: h.longTimeouts.size };
    })()`);
    ok(r6f.shown && r6f.stillShownOnB, 'R6f1 前置成形:A 压缩中,切到也在跑的 B,指示条仍挂着');
    ok(!r6f.afterA, 'R6f2 A 的回合在后台收尾:指示条随之收掉,不会活过回合');
    ok(r6f.longTimeouts === 0, 'R6f3 没有残留的兜底超时');

    // R7:挂着权限申请时停止
    const r7 = await fx.evaluate(`(async () => {
      await window.__mk(); const h = window.__h;
      h.$('promptInput').value = 'hello'; const sp = h.rt.sendPrompt(); await h.sleep(50);
      h.push({ type: 'permission_request', requestId: 'r1', toolName: 'file_write' }); await h.sleep(80);
      const bar = document.getElementById('turnActivityBar');
      const during = bar.dataset.phase;
      h.rt.stopTurn(); await sp; await h.sleep(80);
      return { during, hidden: bar.classList.contains('hidden') };
    })()`);
    ok(r7.during === 'waiting_you', 'R7a 前置成形:申请挂着时状态条是「等你拍板」');
    ok(r7.hidden, 'R7b 停止后状态条收起,不再停在「等你拍板」');

    // R10:长回复分块
    const r10 = await fx.evaluate(`(async () => {
      await window.__mk(); const h = window.__h;
      h.$('promptInput').value = 'long'; const sp = h.rt.sendPrompt(); await h.sleep(50);
      let full = '';
      for (let i = 0; i < 300; i++) {
        const piece = 'line ' + i + ' 中文段落内容 lorem ipsum dolor\\n' + (i % 10 === 9 ? '\\n' : '');
        full += piece; h.push({ type: 'assistant_delta', text: piece });
        if (i % 20 === 19) await h.sleep(20);   // 让 rAF 跑几帧
      }
      await h.sleep(60);
      const bubble = h.$('messages').querySelector('.bubble.live-plain');
      const chunks = bubble ? bubble.querySelectorAll('.live-chunk').length : -1;
      const tail = bubble ? bubble.lastChild : null;
      const streamed = { chunks, same: bubble ? bubble.textContent === full : false, tailIsText: !!tail && tail.nodeType === 3, tailLen: tail && tail.nodeType === 3 ? tail.length : -1, total: full.length };
      // 一整段没有换行:不切
      h.push({ type: 'result', ok: true }); h.end(); await sp; await h.sleep(60);
      const settled = h.$('messages').querySelectorAll('.live-chunk').length;
      await window.__mk(); const h2 = window.__h;
      h2.$('promptInput').value = 'oneline'; const sp2 = h2.rt.sendPrompt(); await h2.sleep(50);
      h2.push({ type: 'assistant_delta', text: 'x'.repeat(6000) }); await h2.sleep(80);
      const b2 = h2.$('messages').querySelector('.bubble.live-plain');
      const oneLine = b2 ? b2.querySelectorAll('.live-chunk').length : -1;
      h2.push({ type: 'result', ok: true }); h2.end(); await sp2;
      return { ...streamed, settled, oneLine };
    })()`);
    ok(r10.chunks >= 3, `R10a 长回复流式期间分了块(${r10.chunks} 块,共 ${r10.total} 字)`);
    ok(r10.same, 'R10b 屏上文本与流出的逐字相同');
    ok(r10.tailIsText && r10.tailLen >= 0 && r10.tailLen < 1500 + 400, `R10c 只剩尾巴一个裸文本节点在长(尾巴 ${r10.tailLen} 字)`);
    ok(r10.settled === 0, 'R10d 回合收尾换成一份 Markdown,不留分块');
    ok(r10.oneLine === 0, 'R10e 没有换行的一整段不切');

    const r10b = await fx.evaluate(`(async () => {
      await window.__mk(); const h = window.__h;
      h.$('promptInput').value = 'select'; const sp = h.rt.sendPrompt(); await h.sleep(50);
      h.push({ type: 'assistant_delta', text: 'alpha beta gamma delta\\n' }); await h.sleep(40);
      const bubble = h.$('messages').querySelector('.bubble.live-plain');
      const tail = bubble.lastChild;
      const range = document.createRange(); const at = tail.data.indexOf('gamma');
      range.setStart(tail, at); range.setEnd(tail, at + 5);
      const sel = document.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      let more = '';
      for (let i = 0; i < 120; i++) { const piece = 'more line ' + i + ' lorem ipsum dolor sit\\n'; more += piece; h.push({ type: 'assistant_delta', text: piece }); if (i % 20 === 19) await h.sleep(20); }
      await h.sleep(60);
      const held = { selected: sel.toString(), chunks: bubble.querySelectorAll('.live-chunk').length };
      sel.removeAllRanges();
      h.push({ type: 'assistant_delta', text: 'after release\\n' }); await h.sleep(60);
      const released = bubble.querySelectorAll('.live-chunk').length;
      // 思维链:另起一个回合,只推 thinking_delta
      h.push({ type: 'result', ok: true }); h.end(); await sp; await h.sleep(40);
      await window.__mk(); const h2 = window.__h;
      h2.$('promptInput').value = 'think'; const sp2 = h2.rt.sendPrompt(); await h2.sleep(50);
      let thought = '';
      for (let i = 0; i < 200; i++) { const piece = 'reasoning step ' + i + ' 推理内容 lorem ipsum\\n'; thought += piece; h2.push({ type: 'thinking_delta', text: piece }); if (i % 20 === 19) await h2.sleep(20); }
      await h2.sleep(80);
      const body = h2.$('messages').querySelector('details > div');   // 夹具里的 thinkingPanel 桩:details > summary + 正文 div
      const think = { chunks: body ? body.querySelectorAll('.live-chunk').length : -1, same: body ? body.textContent === thought : false };
      h2.push({ type: 'result', ok: true }); h2.end(); await sp2;
      return { ...held, released, think };
    })()`);
    ok(r10b.selected === 'gamma' && r10b.chunks === 0, `R10f 选着字时不切、选区还在(选中「${r10b.selected}」,块数 ${r10b.chunks})`);
    ok(r10b.released >= 1, `R10f 松手后下一帧照常切(块数 ${r10b.released})`);
    ok(r10b.think.chunks >= 2 && r10b.think.same, `R10g 思维链面板分块、文本逐字相同(块数 ${r10b.think.chunks})`);

    // R11:回合收尾的增量取(perf)。同一个回合跑四遍,只换「底子带不带戳」与「服务端怎么答」:
    //   delta  = 回合起点 session 事件带 messagesStamp,服务端答增量 → 一发 ?fromIndex=2&prefixStamp=…,拼接;
    //   full   = 不带戳(修前的形状)→ 一发无参全量;
    //   server-full = 带戳但服务端落回全量(前缀被改写过)→ 一发,原样收下;
    //   bad-splice  = 增量条数自检不符 → 再补一发无参全量。
    // 判据:四遍收尾后 state.currentSession(去掉 providerHistory)一致,标题 / 元信息 / 步骤条 / 事项条 / 电量表 / 续跑横幅
    // 拿到的输入一致,乐观 user 行重绑到同一条持久化消息;底子那份 messages 一条没多。
    const r11 = await fx.evaluate(`(async () => {
      const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x);
      const dropPH = s => { if (!s) return s; const { providerHistory, ...rest } = s; return rest; };
      const u0 = { role: 'user', content: 'earlier', createdAt: '2026-01-01T00:00:00.000Z', turnSeq: 1 };
      const a0 = { role: 'assistant', content: 'earlier answer', createdAt: '2026-01-01T00:00:01.000Z', turnSeq: 1, usage: { inputTokens: 5 } };
      const u1 = { role: 'user', content: 'hello', createdAt: '2026-01-01T00:01:00.000Z', turnSeq: 2 };
      const a1 = { role: 'assistant', content: 'fresh answer', createdAt: '2026-01-01T00:01:01.000Z', turnSeq: 2, usage: { inputTokens: 9, outputTokens: 3 } };
      const BASE = { id: 'A', title: 'old title', turnSeq: 1, todos: [], messages: [u0, a0], providerHistory: [{ role: 'user', content: 'earlier' }] };
      const FULL = { ok: true, session: { id: 'A', title: 'new title', turnSeq: 2, todos: [{ content: 'step', status: 'in_progress' }], mission: { goal: 'g', changeSeq: 3 },
        messages: [u0, a0, u1, a1], providerHistory: [{ role: 'user', content: 'earlier' }, { role: 'user', content: 'hello' }] },
        resumable: { dangling: false, kind: null }, displayTitle: 'new title' };
      const { providerHistory: _ph, ...fullHead } = FULL.session;
      const DELTA = { ok: true, session: { ...fullHead, messages: [u1, a1] }, resumable: FULL.resumable, displayTitle: FULL.displayTitle,
        messagesFrom: 2, messageCount: 4, messagesStamp: 'm1.4.' + 'b'.repeat(40) };
      const clone = v => JSON.parse(JSON.stringify(v));
      const out = {};
      for (const mode of ['delta', 'full', 'server-full', 'bad-splice']) {
        const rec = { paths: [] };
        await window.__mk({ deps: {
          api: async u => {
            rec.paths.push(u);
            if (u === '/api/sessions/A') return clone(FULL);
            if (u.startsWith('/api/sessions/A?')) return mode === 'server-full' ? clone(FULL) : (mode === 'bad-splice' ? { ...clone(DELTA), messageCount: 5 } : clone(DELTA));
            return { ok: true };
          },
          renderStaticMessage: m => { const row = document.createElement('div'); row.className = 'user-row'; row.textContent = m.content; const bar = document.createElement('div'); bar.className = 'msg-actions'; row.appendChild(bar); return row; },
          msgActions: m => { rec.rebound = canon(m); const d = document.createElement('div'); d.className = 'msg-actions'; return d; },
          paintSessionMeta: (node, s) => { rec.meta = canon(dropPH(s)); },
          renderStepBar: todos => { rec.todos = canon(todos); },
          renderMissionBar: mission => { rec.mission = canon(mission); },
          latestUsage: s => { rec.usageInput = canon((s && s.messages) || []); return null; },
          renderContextMeter: v => { rec.meter = canon(v); },
          renderResumeBanner: () => { rec.resumable = canon(window.__h.state.resumable); },
        } });
        const h = window.__h;
        const base = clone(BASE);
        h.state.currentSession = base;
        h.$('promptInput').value = 'hello'; const sp = h.rt.sendPrompt(); await h.sleep(40);
        const baseMessages = clone(BASE).messages;
        const evt = { type: 'session', session: { ...clone(BASE), messages: baseMessages } };
        if (mode !== 'full') evt.messagesStamp = 'm1.2.' + 'a'.repeat(40);
        h.push(evt); await h.sleep(20);
        h.push({ type: 'assistant_delta', text: 'fresh answer' }); h.push({ type: 'result', ok: true }); h.end();
        await sp; await h.sleep(40);
        out[mode] = { ...rec, state: canon(dropPH(h.state.currentSession)), hasPH: Array.isArray(h.state.currentSession.providerHistory),
          title: h.$('sessionTitle').textContent, baseLen: baseMessages.length, sameArray: h.state.currentSession.messages === baseMessages };
      }
      return { out, expectState: canon(dropPH(FULL.session)), expectRebound: canon(u1) };
    })()`);
    {
      const { out, expectState, expectRebound } = r11;
      ok(out.delta.paths.length === 1 && out.delta.paths[0] === `/api/sessions/A?fromIndex=2&prefixStamp=m1.2.${'a'.repeat(40)}`, `R11a 带戳的底子 → 只发一发增量(${out.delta.paths.join(' , ')})`);
      ok(out.full.paths.length === 1 && out.full.paths[0] === '/api/sessions/A', `R11b 不带戳 → 与修前同一发无参全量(${out.full.paths.join(' , ')})`);
      ok(out['server-full'].paths.length === 1 && out['bad-splice'].paths.length === 2 && out['bad-splice'].paths[1] === '/api/sessions/A',
        `R11c 服务端落回全量 → 原样收下(1 发);拼接自检不符 → 补一发无参全量(${out['bad-splice'].paths.join(' , ')})`);
      for (const mode of ['delta', 'full', 'server-full', 'bad-splice']) {
        ok(out[mode].state === expectState, `R11d[${mode}] 收尾后的 state.currentSession 与全量(去掉 providerHistory)一致`);
      }
      ok(!out.delta.hasPH && out.full.hasPH, 'R11e 增量拼出来的会话不带 providerHistory(前端不读它);全量照旧带');
      const fields = ['title', 'meta', 'todos', 'mission', 'usageInput', 'meter', 'resumable', 'rebound'];
      const diff = fields.filter(key => ['full', 'server-full', 'bad-splice'].some(mode => out[mode][key] !== out.delta[key]));
      ok(diff.length === 0 && out.delta.title === 'new title', `R11f 标题/元信息/步骤条/事项条/电量表/续跑横幅的输入四遍一致${diff.length ? '(不同:' + diff.join(',') + ')' : ''}`);
      ok(out.delta.rebound === expectRebound, 'R11g 乐观 user 行重绑到增量尾巴里那条持久化的 user 消息');
      ok(out.delta.baseLen === 2 && !out.delta.sameArray, 'R11h 拼接出的是新数组,底子那份 messages 一条没多');
    }
    // R13:回合起点 session 事件的增量。底子 [u0,a0] 带戳 m1.2.aaa…;服务端起点事件只给尾巴 [u1](messagesFrom 2、共 3 条、新戳 m1.3.ccc…),
    // 收尾时客户端应当从 3 接着增量(服务端答 [a1],共 4 条)。
    const r13 = await fx.evaluate(`(async () => {
      const mod = await import('/js/chat-stream-runtime.js');
      const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x);
      const dropPH = s => { if (!s) return s; const { providerHistory, ...rest } = s; return rest; };
      const clone = v => JSON.parse(JSON.stringify(v));
      const u0 = { role: 'user', content: 'earlier', turnSeq: 1 }, a0 = { role: 'assistant', content: 'earlier answer', turnSeq: 1 };
      const u1 = { role: 'user', content: 'hello', turnSeq: 2 }, a1 = { role: 'assistant', content: 'fresh answer', turnSeq: 2 };
      const HEAD = { id: 'A', title: 'new title', turnSeq: 2, todos: [] };
      const FULL = { ok: true, session: { ...HEAD, messages: [u0, a0, u1, a1], providerHistory: [{ role: 'user', content: 'x' }] }, resumable: { dangling: false, kind: null }, displayTitle: 'new title' };
      const END_DELTA = { ok: true, session: { ...HEAD, messages: [a1] }, resumable: FULL.resumable, displayTitle: FULL.displayTitle, messagesFrom: 3, messageCount: 4, messagesStamp: 'm1.4.' + 'd'.repeat(40) };
      const STAMP2 = 'm1.2.' + 'a'.repeat(40);
      const out = {};
      for (const mode of ['start-delta', 'no-stamp', 'bad-splice']) {
        const rec = { paths: [] };
        await window.__mk({ deps: { api: async u => {
          rec.paths.push(u);
          if (u === '/api/sessions/A') return clone(FULL);
          if (u.startsWith('/api/sessions/A?fromIndex=3&')) return clone(END_DELTA);
          if (u.startsWith('/api/sessions/A?')) return clone(FULL);
          return { ok: true };
        } } });
        const h = window.__h;
        const base = { id: 'A', title: 'old title', turnSeq: 1, todos: [], messages: [clone(u0), clone(a0)] };
        if (mode !== 'no-stamp') mod.rememberMessagesStamp(base.messages, STAMP2);
        h.state.currentSession = base;
        h.$('promptInput').value = 'hello'; const sp = h.rt.sendPrompt(); await h.sleep(40);
        rec.body = h.streamBodies[h.streamBodies.length - 1];
        if (mode === 'no-stamp') h.push({ type: 'session', session: { ...HEAD, messages: [clone(u0), clone(a0), clone(u1)] } });
        else h.push({ type: 'session', session: { ...HEAD, messages: [clone(u1)] }, messagesFrom: 2, messageCount: mode === 'bad-splice' ? 9 : 3, messagesStamp: 'm1.3.' + 'c'.repeat(40) });
        await h.sleep(30);
        rec.afterStart = { len: h.state.currentSession.messages.length, sameBase: h.state.currentSession.messages === base.messages, path: mod.sessionRefetchPath('A', h.state.currentSession) };
        h.push({ type: 'assistant_delta', text: 'fresh answer' }); h.push({ type: 'result', ok: true }); h.end();
        await sp; await h.sleep(40);
        out[mode] = { ...rec, state: canon(dropPH(h.state.currentSession)), baseLen: base.messages.length };
      }
      return { out, expectState: canon(dropPH(FULL.session)), STAMP2 };
    })()`);
    {
      const { out, expectState, STAMP2 } = r13;
      const d = out['start-delta'];
      ok(d.body && d.body.knownMessages && d.body.knownMessages.count === 2 && d.body.knownMessages.stamp === STAMP2, `R13a 底子带戳 → 发送体带 knownMessages {count:2, stamp}(${JSON.stringify(d.body && d.body.knownMessages)})`);
      ok(out['no-stamp'].body && !('knownMessages' in out['no-stamp'].body), 'R13b 底子没戳 → 发送体没有 knownMessages(修前形状)');
      ok(d.afterStart.len === 3 && !d.afterStart.sameBase && d.afterStart.path === `/api/sessions/A?fromIndex=3&prefixStamp=m1.3.${'c'.repeat(40)}`,
        `R13c 增量起点事件拼回前缀(3 条、新数组),并记上新戳(收尾路径 ${d.afterStart.path})`);
      ok(d.paths.length === 1 && d.paths[0].startsWith('/api/sessions/A?fromIndex=3&'), `R13d 收尾只发一发、从 3 接着增量(${d.paths.join(' , ')})`);
      ok(out['bad-splice'].paths[0] === '/api/sessions/A', `R13e 起点增量拼不上 → 补一发无参全量(${out['bad-splice'].paths.join(' , ')})`);
      for (const mode of ['start-delta', 'no-stamp', 'bad-splice']) ok(out[mode].state === expectState, `R13f[${mode}] 收尾后的会话与全量(去掉 providerHistory)一致`);
      ok(d.baseLen === 2, 'R13g 底子那份 messages 一条没多(不就地改)');
    }
    // R14:旧回合的 finally 只收拾自己
    const r14 = await fx.evaluate(`(async () => {
      let release = null; const gate = new Promise(r => { release = r; });
      await window.__mk({ deps: { api: async u => {
        if (u.startsWith('/api/sessions/A')) { await gate; return { ok: true, session: { id: 'A', messages: [] } }; }
        return { ok: true };
      } } });
      const h = window.__h;
      h.$('promptInput').value = 'one'; const sp1 = h.rt.sendPrompt(); await h.sleep(30);
      h.pushTo(0, { type: 'result', ok: true }); h.endAt(0); await h.sleep(30);   // 回合 1 的流收尾,卡在回合末重取
      const midTurn1 = h.state.streaming;
      h.$('promptInput').value = 'two'; const sp2 = h.rt.sendPrompt(undefined, { skipSteer: true }); await h.sleep(30);  // 插话落回 → 新回合
      release(); await sp1; await h.sleep(30);          // 回合 1 的 finally 跑完
      const afterTurn1 = { streaming: h.state.streaming, bodies: h.streamBodies.length };
      h.pushTo(1, { type: 'result', ok: true }); h.endAt(1); await sp2; await h.sleep(30);
      return { midTurn1, afterTurn1, afterTurn2: h.state.streaming };
    })()`);
    ok(r14.afterTurn1.bodies === 2, `R14 前提:两个回合都发出了流(${r14.afterTurn1.bodies})`);
    ok(r14.afterTurn1.streaming === true, 'R14 回合 1 收尾之后,回合 2 还在流 → 页面仍是「在跑」(修前被回合 1 的 finally 删掉登记,按钮回到发送)');
    ok(r14.afterTurn2 === false, 'R14 回合 2 收尾之后才回到空闲');

    // R15:中止/断流后装回重取的会话
    const r15 = await fx.evaluate(`(async () => {
      const FULL = { ok: true, session: { id: 'A', messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'partial answer' }] } };
      await window.__mk({ deps: { api: async u => (u.startsWith('/api/sessions/A') ? JSON.parse(JSON.stringify(FULL)) : { ok: true }) } });
      const h = window.__h;
      h.$('promptInput').value = 'hello'; const sp = h.rt.sendPrompt(); await h.sleep(30);
      h.push({ type: 'assistant_delta', text: 'partial answer' }); await h.sleep(20);
      h.rt.stopTurn();
      await sp.catch(() => {}); await h.sleep(60);
      return { count: (h.state.currentSession.messages || []).length, last: (h.state.currentSession.messages || []).slice(-1)[0] };
    })()`);
    ok(r15.count === 2 && r15.last && r15.last.content === 'partial answer', `R15 中止后 state 里是服务端落盘的会话(${r15.count} 条)`);

    // R16:重放不重复一次性副作用
    const r16 = await fx.evaluate(`(async () => {
      let debugLines = 0;
      await window.__mk({ deps: { appendToolOutput() { debugLines++; } } });
      const h = window.__h;
      h.$('promptInput').value = 'go'; const sp = h.rt.sendPrompt(); await h.sleep(30);
      h.push({ type: 'failover', to: 'backup' }); h.push({ type: 'stderr', text: 'warn line' }); await h.sleep(30);
      const first = { toasts: h.toasts.length, debug: debugLines };
      for (let i = 0; i < 3; i++) { h.switchTo('B'); await h.sleep(10); h.switchTo('A'); await h.sleep(20); }
      const after = { toasts: h.toasts.length, debug: debugLines };
      h.push({ type: 'result', ok: true }); h.end(); await sp; await h.sleep(20);
      return { first, after };
    })()`);
    ok(r16.first.toasts >= 1 && r16.first.debug >= 1, `R16 前提:首次到达时弹了提示、写了调试行(${JSON.stringify(r16.first)})`);
    ok(r16.after.toasts === r16.first.toasts && r16.after.debug === r16.first.debug, `R16 切回三次重放,提示与调试行都没有再加(${JSON.stringify(r16.after)})`);

    // R12:屏外代码块懒高亮
    const r12 = await fx.evaluate(`(async () => {
      if (!window.hljs) await new Promise((resolve, reject) => { const sc = document.createElement('script'); sc.src = '/vendor/highlight.min.js'; sc.onload = resolve; sc.onerror = reject; document.head.appendChild(sc); });
      const { createChatRenderPrimitives } = await import('/js/chat-render-primitives.js');
      const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
      const p = createChatRenderPrimitives({ $: id => document.getElementById(id), el, t: k => k, tCount: k => k, toast() {}, hljs: window.hljs, state: {}, escapeHtml: s => String(s), icon: () => null });
      const frame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      document.body.innerHTML = '';
      const box = el('div'); box.style.cssText = 'height:400px;overflow-y:auto;';
      document.body.appendChild(box);
      const rows = [];
      for (let i = 0; i < 60; i++) {
        const row = el('div'); row.style.cssText = 'height:300px;';
        const pre = el('pre'); const code = el('code', 'language-js', 'const value' + i + ' = function () { return ' + i + '; };');
        pre.appendChild(code); row.appendChild(pre);
        p.highlightIn(row);   // 行还在文档外:交给懒高亮
        rows.push(row);
      }
      const syncNow = rows.filter(r => r.querySelector('code').dataset.hl).length;
      rows.forEach(r => box.appendChild(r));
      box.scrollTop = box.scrollHeight;
      await frame(); await frame();
      const hl = r => Boolean(r.querySelector('code').dataset.hl);
      const bottom = { last: hl(rows[59]), first: hl(rows[0]), firstCopy: Boolean(rows[0].querySelector('.copy-code')), lastSpans: rows[59].querySelectorAll('code span').length };
      box.scrollTop = 0;
      await frame(); await frame();
      const top = { first: hl(rows[0]), firstCopy: Boolean(rows[0].querySelector('.copy-code')) };
      // 对照:已在文档里的容器当场高亮
      const live = el('div'); const lp = el('pre'); lp.appendChild(el('code', 'language-js', 'let x = 1;')); live.appendChild(lp); box.appendChild(live);
      p.highlightIn(live);
      return { syncNow, bottom, top, liveNow: Boolean(live.querySelector('code').dataset.hl) };
    })()`);
    ok(r12.syncNow === 0, `R12a 行还在文档外时不当场高亮(当场高亮了 ${r12.syncNow} 块)`);
    ok(r12.bottom.last && r12.bottom.lastSpans > 0, `R12b 挂进去滚到底:可见的最后一块高亮了(${r12.bottom.lastSpans} 个 span)`);
    ok(!r12.bottom.first && !r12.bottom.firstCopy, 'R12c 离可见区很远的第一块还没动(没高亮、没补复制按钮)');
    ok(r12.top.first && r12.top.firstCopy, 'R12d 滚到顶之后第一块也高亮了、复制按钮补上了');
    ok(r12.liveNow, 'R12e 已在文档里的容器照旧当场高亮');
    // R12f(审查轮):刚挂上的一批行,调用方在同一拍补一下 nearView —— 视口附近的当场着色(不等懒高亮晚一帧的回调,
    // 否则每次重画都闪一帧没着色的代码),远处的照旧留给懒高亮。
    const r12f = await fx.evaluate(`(async () => {
      const { createChatRenderPrimitives } = await import('/js/chat-render-primitives.js');
      const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
      const p = createChatRenderPrimitives({ $: id => document.getElementById(id), el, t: k => k, tCount: k => k, toast() {}, hljs: window.hljs, state: {}, escapeHtml: s => String(s), icon: () => null });
      document.body.innerHTML = '';
      const box = el('div'); box.style.cssText = 'height:400px;overflow-y:auto;';
      document.body.appendChild(box);
      const rows = [];
      for (let i = 0; i < 60; i++) {
        const row = el('div'); row.style.cssText = 'height:300px;';
        const pre = el('pre'); pre.appendChild(el('code', 'language-js', 'const v' + i + ' = ' + i + ';'));
        row.appendChild(pre); p.highlightIn(row); rows.push(row); box.appendChild(row);
      }
      box.scrollTop = box.scrollHeight;
      p.highlightIn(box, { nearView: true });   // 同一拍,不等帧
      const hl = r => Boolean(r.querySelector('code').dataset.hl);
      return { last: hl(rows[59]), first: hl(rows[0]) };
    })()`);
    ok(r12f.last && !r12f.first, `R12f 挂上后同一拍补 nearView:视口附近当场着色、远处不动(最后一块 ${r12f.last} / 第一块 ${r12f.first})`);

    // R9:文件树后发先至(同一套同源空白页夹具,顺带钉 file-browser.js 的加载序号)
    const r9 = await fx.evaluate(`(async () => {
      const mod = await import('/js/file-browser.js');
      document.body.innerHTML = '<div id="fileTreeRoot"></div><div id="fileTree"></div><div id="filePreview"></div>';
      let ws = '/proj/X';
      const wait = ms => new Promise(r => window.__origTimers.st.call(window, r, ms));
      window.fetch = async (url, init) => {
        const root = JSON.parse((init && init.body) || '{}').root;
        await wait(root === '/proj/X' ? 300 : 20);   // 先发的 X 慢、后发的 Y 快
        const payload = { ok: true, result: { ok: true, files: [{ path: root + '/' + (root === '/proj/X' ? 'x-file.txt' : 'y-file.txt'), type: 'file' }] } };
        return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload, clone() { return this; } };
      };
      const d = mod.createFileBrowserDomain({ currentWorkspace: () => ws });
      const p1 = d.loadFileTree(); await wait(10);
      ws = '/proj/Y';
      const p2 = d.loadFileTree();
      await Promise.all([p1, p2]);
      return { header: document.getElementById('fileTreeRoot').textContent, tree: document.getElementById('fileTree').textContent };
    })()`);
    ok(/Y/.test(r9.header), `R9a 前置成形:树头是后切的工作区(${r9.header})`);
    ok(/y-file/.test(r9.tree) && !/x-file/.test(r9.tree), `R9b 晚到的旧工作区结果被丢弃,树里是 Y 的内容(${r9.tree})`);
    ok(fx.exceptions.length === 0, `R8 页面无未捕获异常${fx.exceptions.length ? ':' + fx.exceptions.join(' | ') : ''}`);
  } catch (error) {
    t.fail('fatal: ' + ((error && error.stack) || error));
  } finally {
    if (fx) await fx.close();
  }
  t.done({ exit: true });
})();
