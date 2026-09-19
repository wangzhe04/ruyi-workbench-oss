#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 用户首启走查(2026-09-19):「首次启动会显示连接错误、连接不上,但实际是连上了,新开个线程就好」,
// 追问后第二句:「查看日志诊断似乎显示不出具体原因」。
//
// 修前的启动故障卡有这几处不对,本件在真浏览器里(出厂默认的【管家视角】)用 CDP Fetch 拦截造几种失败,逐条钉住:
//   ① 卡画在 #messages 里 —— 那是工作台视角的对话区,管家视角里整个不显示:用户只看得到一个 2 秒的 toast
//      「无法连接本地服务,请点『重试连接』」,却找不到任何「重试」;
//   ② 不分青红皂白说「连不上」:boot 的大半步骤是在服务【已经应答】之后才跑的,那种错说连不上是假话;
//   ③ 一抛就整段中止:boot 的最后一步是起推送连接,前面随便哪步抛了,推送就再也没起 —— 界面能用、却不再自己更新;
//   ④ 诊断框只有一行:500 被译成「服务发生内部错误。」、真原因扔掉;前端异常没有步骤、没有栈;提示只有半句「常见原因：」;
//   ⑤ 点「重试」后状态行原样写着「已尝试 {n} 次」(单花括号不插值)。
// 以及本刀自己带出来、必须一起钉的一条:
//   ⑥ 不再整段中止之后,/api/status 没到时语言那一步会走到 —— 【不许】把猜出来的语言写回配置(写回没读到的状态)。
// 判据:
//   B1 传输层失败(状态接口连接被拒):管家视角里【看得见】的故障卡,标题「无法连接本地服务」＋ 三条原因;
//   B2 服务应答了但某一步出错(会话列表回 500):看得见的卡,标题换成「本地服务是通的,但启动时有一步没走通」,
//      不列那三条,诊断写明哪一步／HTTP 500／路径／原话,状态行不说连不上;boot 照走完(推送连接照样发起);
//      卡上有「先继续用」可以关掉;
//   B4 服务端兜底码 api.internal_error:诊断里有服务端原话与错误码,说明那一行不再只剩「服务发生内部错误。」;
//   B5 前端异常(状态接口回 200、正文 null → 我们代码里抛 TypeError):诊断写明界面代码出错、哪一步、栈里有那一帧;
//      B5b 这一轮没有任何一发 POST /api/config 带 locale;B5c 回的不是 JSON:诊断点名 SyntaxError 与原话;
//   B6 「复制诊断」:交给剪贴板的就是诊断原文;剪贴板不给用时原文被整段选中(页内桩,不碰系统剪贴板);
//   B3 拦截撤掉之后点「重新加载」:状态行里没有生花括号、写着第 1 次;卡消失、左栏出现那条线程。
// 判定行:`BOOT FAILURE KIND BROWSER E2E: ALL PASS`。
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

// 卡在不在、看不看得见(矩形在视口里且标题中心点命中卡本身 —— 不是被别的层盖住、也不是 display:none 的祖先里)。
const CARD = `(() => {
  const card = document.querySelector('.boot-failure');
  if (!card) return null;
  const title = card.querySelector('.boot-failure-title');
  const b = (title || card).getBoundingClientRect();
  const root = document.documentElement;
  const hit = b.width > 0 && b.height > 0 ? document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) : null;
  return {
    title: title ? title.textContent : '',
    reasons: card.querySelectorAll('.boot-failure-reason').length,
    diag: (card.querySelector('.boot-failure-diag-pre') || {}).textContent || '',
    hint: (card.querySelector('.boot-failure-hint') || {}).textContent || '',
    kind: card.dataset.kind || '',
    visible: b.width > 0 && b.height > 0 && b.top >= 0 && b.bottom <= root.clientHeight && Boolean(hit) && card.contains(hit),
    hitBy: hit ? (hit.id ? '#' + hit.id : hit.tagName.toLowerCase() + '.' + String(hit.className || '').split(' ')[0]) : '',
    dismiss: Boolean(card.querySelector('.boot-dismiss')),
    copy: Boolean(card.querySelector('.boot-diag-copy')),
    lens: document.documentElement.getAttribute('data-shell-mode'),
  };
})()`;

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-boot-kind-', width: 1280, height: 860,
      prepare: async f => {
        const created = await f.request('POST', '/api/sessions', { title: '启动故障卡那条', cwd: f.work });
        ok(Boolean(created && created.json && created.json.session), 'B0 线程已建');
      },
    });
    ok(Boolean(await fx.setLens('steward')), 'B0b 出厂默认的管家视角');
    const zh = await fx.evaluate(`(async () => (await fetch('/locales/zh-CN.json')).json())()`);
    let mode = '';
    let streamAfter = 0;   // 本轮重载之后发起的推送连接次数
    let localeWrites = 0;  // 本轮重载之后带 locale 的 POST /api/config
    const json = body => Buffer.from(JSON.stringify(body)).toString('base64');
    fx.cdp.on('Fetch.requestPaused', async p => {
      const url = String(p.request && p.request.url || '');
      const method = p.request && p.request.method;
      try {
        if (url.includes('/api/events/stream')) streamAfter += 1;
        if (method === 'POST' && /\/api\/config(\?|$)/.test(url) && /locale/.test(String(p.request.postData || ''))) localeWrites += 1;
        if (mode === 'status-refused' && /\/api\/status(\?|$)/.test(url)) {
          await fx.cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'ConnectionRefused' });
        } else if (mode === 'sessions-500' && /\/api\/sessions(\?|$)/.test(url) && method === 'GET') {
          await fx.cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 500,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: json({ ok: false, error: 'index exploded (synthetic)' }) });
        } else if (mode === 'sessions-internal' && /\/api\/sessions(\?|$)/.test(url) && method === 'GET') {
          await fx.cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 500,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: json({ ok: false, error: { code: 'api.internal_error', params: {}, message: 'ENOENT: synthetic boom, open sessions-index.json' } }) });
        } else if (mode === 'status-null' && /\/api\/status(\?|$)/.test(url) && method === 'GET') {
          await fx.cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }], body: Buffer.from('null').toString('base64') });
        } else if (mode === 'status-garbage' && /\/api\/status(\?|$)/.test(url) && method === 'GET') {
          await fx.cdp.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200,
            responseHeaders: [{ name: 'content-type', value: 'application/json' }],
            body: Buffer.from('this is not json (synthetic)').toString('base64') });
        } else {
          await fx.cdp.send('Fetch.continueRequest', { requestId: p.requestId });
        }
      } catch { /* 页面已走 */ }
    });
    await fx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*' }] });
    const reloadAndWaitCard = async () => {
      streamAfter = 0;
      localeWrites = 0;
      await fx.cdp.send('Page.reload', { ignoreCache: true });
      return fx.waitForEval(CARD, 400);
    };
    // 「看得见」要等画面落定再判:config 一到视角会从工作台切到管家,切换走视图过渡,过渡期间命中测试落在根上。
    // 3 s 内看得见就算;一直看不见就把最后一次的命中对象报出来(是被谁盖住)。
    const waitVisible = async () => {
      const seen = await fx.waitForEval(`(() => { const c = ${CARD}; return c && c.visible ? c : null; })()`, 30);
      return seen || await fx.evaluate(CARD);
    };

    /* ═════════ B1 传输层失败 ═════════ */
    mode = 'status-refused';
    const c1 = await reloadAndWaitCard();
    ok(Boolean(c1) && c1.title === zh['bootFailure.title'] && c1.reasons === 3,
      `B1 状态接口连接被拒:「${zh['bootFailure.title']}」＋ 三条原因(实「${c1 && c1.title}」,${c1 && c1.reasons} 条)`);
    const v1 = await waitVisible();
    ok(Boolean(v1) && v1.visible, `B1b 这张卡在【${v1 && v1.lens}】视角里看得见(命中 ${v1 && v1.hitBy})`);
    ok(Boolean(c1) && c1.diag.includes(zh['bootFailure.diag.kindUnreachable']) && c1.diag.includes('refreshStatus'),
      `B1c 诊断写明「${zh['bootFailure.diag.kindUnreachable']}」与步骤 refreshStatus(实「${c1 && c1.diag.split('\n').slice(0, 2).join(' / ')}」)`);

    /* ═════════ B2 服务应答了、某一步出错 ═════════ */
    mode = 'sessions-500';
    const c2 = await reloadAndWaitCard();
    ok(Boolean(c2) && c2.title === zh['bootFailure.stepTitle'],
      `B2 会话列表回 500:不说「连不上」,标题是「${zh['bootFailure.stepTitle']}」(实「${c2 && c2.title}」)`);
    const v2 = await waitVisible();
    ok(Boolean(v2) && v2.visible && v2.lens === 'steward' && v2.reasons === 0,
      `B2b 在【管家】视角里看得见,且不列端口／服务没起／安全软件那三条(视角 ${v2 && v2.lens},可见 ${v2 && v2.visible},命中 ${v2 && v2.hitBy},${v2 && v2.reasons} 条;修前画在工作台的 #messages 里,管家视角整个不显示)`);
    const diag2 = (c2 && c2.diag) || '';
    ok(/index exploded/.test(diag2) && diag2.includes('refreshSessions') && /HTTP 500/.test(diag2) && diag2.includes('/api/sessions'),
      `B2c 诊断写明哪一步、HTTP 500、路径、原话(实:\n${diag2.split('\n').slice(0, 4).join('\n')})`);
    ok(Boolean(c2) && c2.hint === zh['bootFailure.diagHint'] && c2.hint !== '常见原因：',
      `B2c2 诊断下的提示是整句(修前只有半句「常见原因：」;实「${c2 && c2.hint}」)`);
    const status2 = await fx.evaluate(`(document.getElementById('statusLine') || {}).textContent || ''`);
    ok(status2 !== zh['connection.cannotConnect'], `B2d 状态行也不说「${zh['connection.cannotConnect']}」(实「${status2}」)`);
    for (let i = 0; i < 60 && !streamAfter; i++) await sleep(100);
    const streamed = streamAfter;
    ok(streamed > 0, `B2e boot 照走完:推送连接照样发起(本轮 /api/events/stream ${streamed} 次;修前一抛就整段中止,推送再也不起)`);
    ok(Boolean(c2) && c2.dismiss, 'B2f 卡上有「先继续用」(服务是通的,界面能用)');
    await fx.evaluate(`(() => { const b = document.querySelector('.boot-dismiss'); if (b) b.click(); return true; })()`);
    ok(!(await fx.evaluate(CARD)), 'B2g 点「先继续用」卡就收起');

    /* ═════════ B4 服务端兜底码:原话不再被译文吞掉 ═════════ */
    mode = 'sessions-internal';
    const c4 = await reloadAndWaitCard();
    const diag4 = (c4 && c4.diag) || '';
    ok(diag4.includes('ENOENT: synthetic boom') && diag4.includes('api.internal_error'),
      `B4 api.internal_error:诊断里有服务端原话与错误码(实:\n${diag4.split('\n').slice(0, 5).join('\n')})`);
    const summary4 = (diag4.split('\n').find(l => l.startsWith(zh['bootFailure.diag.summary'] + ':')) || '');
    ok(summary4.includes('ENOENT: synthetic boom') && !summary4.trim().endsWith(zh['error.api.internalError']),
      `B4b 说明那一行不再只剩「${zh['error.api.internalError']}」(实「${summary4}」)`);

    /* ═════════ B5 前端异常 ＋ 不写回没读到的配置 ═════════ */
    // 状态接口回 200、正文是 JSON 的 null:refreshStatus 里读 state.status.config 抛 TypeError —— 我们自己代码里的
    // 异常,栈里有帧。(res.json() 的 SyntaxError 是原生 promise 里抛的,没有 JS 帧,量不出「带栈」,见 B5c。)
    mode = 'status-null';
    const c5 = await reloadAndWaitCard();
    const diag5 = (c5 && c5.diag) || '';
    const stackLines5 = diag5.split('\n').filter(l => /^\s+at\s/.test(l));
    ok(Boolean(c5) && c5.kind === 'step' && diag5.includes(zh['bootFailure.diag.kindClient'].replace('{{name}}', 'TypeError'))
      && diag5.includes('refreshStatus') && stackLines5.some(l => /refreshStatus|provider-settings/.test(l)),
      `B5 前端异常:诊断写明界面代码出错(TypeError)、步骤 refreshStatus、栈里有出错的那一帧(栈 ${stackLines5.length} 行;首帧「${(stackLines5[0] || '').trim().slice(0, 90)}」)`);
    for (let i = 0; i < 30 && !streamAfter; i++) await sleep(100);
    await sleep(500);   // 语言那一步在推送之前;给它足够时间把本该有(修前)的写发出来
    ok(localeWrites === 0, `B5b 配置没读到的这一轮,没有一发 POST /api/config 带 locale(实 ${localeWrites} 发;否则会拿猜的语言覆盖用户设的)`);

    /* ═════════ B6 复制诊断 ═════════ */
    // 【不碰真剪贴板】:新无头 Edge 用的是 Windows 系统剪贴板(读回来换行成了 CRLF 就是证据),测试写进去会冲掉
    // 用户自己复制的东西。页内把 navigator.clipboard 换成桩:一次收下文本(成功路),一次拒绝(退路:整段选中原文)。
    ok(Boolean(c5) && c5.copy, 'B6a 诊断里有「复制诊断」');
    const copied = await fx.evaluate(`(async () => {
      const card = document.querySelector('.boot-failure');
      const btn = card && card.querySelector('.boot-diag-copy');
      const pre = card && card.querySelector('.boot-failure-diag-pre');
      if (!btn || !pre) return null;
      // 用户的路:先点「查看诊断」展开(复制钮在面板里,收着的面板里选中的是 0 字的不可见文本)
      const toggle = card.querySelector('.boot-diag');
      if (toggle && card.querySelector('.boot-failure-diag').hidden) toggle.click();
      const expanded = toggle ? toggle.getAttribute('aria-expanded') : '';
      const got = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { got.push(text); } } });
      btn.click();
      await new Promise(r => setTimeout(r, 100));
      const okLabel = btn.textContent;
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied (stub)'); } } });
      getSelection().removeAllRanges();
      btn.click();
      await new Promise(r => setTimeout(r, 100));
      return { expanded, okLabel, got, failLabel: btn.textContent, selected: String(getSelection()), text: pre.textContent };
    })()`);
    ok(Boolean(copied) && copied.expanded === 'true', `B6c 「查看诊断」展开面板(aria-expanded=${copied && copied.expanded})`);
    ok(Boolean(copied) && copied.okLabel === zh['common.copied'] && copied.got.length === 1 && copied.got[0] === copied.text,
      `B6 交给剪贴板的就是诊断原文(按钮「${copied && copied.okLabel}」,${copied && copied.got.length} 次,${copied && copied.got[0] && copied.got[0].length} 字/原文 ${copied && copied.text.length} 字)`);
    ok(Boolean(copied) && copied.failLabel === zh['bootFailure.diagCopyFailed'] && copied.selected === copied.text,
      `B6b 剪贴板不给用时整段选中原文、按钮说怎么办(「${copied && copied.failLabel}」,选中 ${copied && copied.selected.length} 字)`);

    /* ═════════ B5c 原生 SyntaxError 也点得出名 ═════════ */
    mode = 'status-garbage';
    const c5c = await reloadAndWaitCard();
    const diag5c = (c5c && c5c.diag) || '';
    ok(Boolean(c5c) && c5c.kind === 'step' && diag5c.includes('SyntaxError') && diag5c.includes('refreshStatus') && diag5c.includes('not valid JSON'),
      `B5c 状态接口回 200 但不是 JSON:诊断点名 SyntaxError、步骤 refreshStatus、原话(实:\n${diag5c.split('\n').slice(0, 3).join('\n')})`);

    /* ═════════ B3 重试真的能拉起来 ═════════ */
    mode = 'sessions-500';
    const c3 = await reloadAndWaitCard();
    mode = '';
    await fx.evaluate(`(() => {
      window.__statusSeen = [];
      const node = document.getElementById('statusLine');
      if (node) new MutationObserver(() => window.__statusSeen.push(node.textContent || '')).observe(node, { childList: true, characterData: true, subtree: true });
      const b = document.querySelector('.boot-retry'); if (b) b.click(); return Boolean(b);
    })()`);
    const recovered = await fx.waitForEval(`(() => !document.querySelector('.boot-failure')
      && [...document.querySelectorAll('#railList .steward-board-thread-title')].some(n => (n.textContent || '').includes('启动故障卡那条')) ? 1 : null)()`, 400);
    ok(Boolean(c3) && Boolean(recovered), 'B3 拦截撤掉后点「重新加载」:卡消失、左栏出现那条线程');
    const seen = await fx.evaluate('window.__statusSeen || []');
    const retryLine = zh['bootFailure.reconnectingStatus'].replace('{{n}}', '1');
    ok(seen.includes(retryLine) && !seen.some(s => /\{/.test(s)),
      `B3b 重试时状态行写「${retryLine}」、没有生花括号(实 ${JSON.stringify(seen.slice(0, 4))})`);
    await fx.cdp.send('Fetch.disable');
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log(fail === 0 ? 'BOOT FAILURE KIND BROWSER E2E: ALL PASS' : `BOOT FAILURE KIND BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
