require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注);登记目录另经 RUYI_TOOLBOX_HOME 指到临时目录,不碰真机 ~/.ruyi-toolbox
'use strict';
// E2E(133f,用户 2026-09-21「标准/重度第一次的语音识别又卡又不准……加个简单的动效,等加载完成后才让用户语音输入」):
// 输入框麦克风的【预热闸】,真浏览器件。
//
// 成因(日志实证):标准／重度档的第二遍是 toolbox 的 asr-shim,它空转时不装载模型、第一发请求才加载(新进程上首句 12–33 s);
// 期间屏上只有第一遍小模型的字。修法:点麦克风后先 POST /api/audio/warmup,装好才去拿麦克风 —— 装着的秒过,没装的显示「加载中」。
// 「组件」是 lib/fake-cold-shim.js(照真 shim:首发才加载、可配耗时、可卸载、可注入失败)+ lib/fake-stream-component.js(流式第一遍)。
//
//   B 冷点(流式路):进「加载中」态 —— 按钮上有转圈(动画中)+ 计时 + 一句人话;此刻【没碰麦克风】、没开流式会话、输入框没动;
//     装好后自动进录音态(状态序列 starting → warming → starting → recording),说了「已就绪」;第二遍随即落地(自开录起 < 加载耗时:
//     没有闸的时候这一句要多等一整个加载)
//   C 热点:模型已装 → 一次「加载中」都不出现,直接录
//   D 加载中再点一下＝取消:不会在装好之后自己开录(那是替一个走开的人开麦克风);服务端的装载照常完成(只装一次),下一次点击就是热的
//   E 加载中按 Esc＝取消
//   F 预热失败不拦流式路:第一遍不依赖它 → 照录、说一句「没能加载好」
//   H 装好时页面不在前台:不替他开麦克风,回到空闲并说一句;之后回来点一下就是热的
//   G 没有第一遍的(按停顿切段)+ 预热失败:录了也转不出字 → 当场说清原因(error 态)、不碰麦克风
//   I 没有第一遍的 + 冷点:同样先闸后录,说完转写第一句就是热的(自停止起 < 加载耗时)
//   J 零未捕获异常
// 设 RUYI_SHOT_DIR 可把「加载中／录音／空闲」的输入区截图落到那个目录(人眼核对用)。
// 判定行:`COMPOSER VOICE WARMUP BROWSER E2E: ALL PASS`。
const path = require('path'), fs = require('fs'), os = require('os');
const { startBrowserFixture, waitForHttp, request, sleep, WB } = require('./lib/browser-fixture');
const { getFreePort } = require('./free-port.js');

const LOAD_MS = 2500;
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

(async () => {
  let fx = null;
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-voice-warmup-x-'));
  const toolboxHome = path.join(extra, 'toolbox');
  fs.mkdirSync(path.join(toolboxHome, 'components'), { recursive: true });
  const coldPort = await getFreePort();
  const streamPort = await getFreePort();
  const libDir = path.join(__dirname, 'lib');
  const reg = (id, name, script, portEnv, port, component, provides, env) => fs.writeFileSync(path.join(toolboxHome, 'components', id + '.json'), JSON.stringify({
    schema: 1, id, kind: 'service', name, version: '0.0.1',
    run: { command: process.execPath, args: [path.join(libDir, script)], cwd: libDir, env: env || {} },
    service: { port, portEnv, health: '/health', component, ...(id === 'fake-cold' ? { unload: '/v1/unload' } : {}) },
    provides, registeredAt: new Date().toISOString(),
  }, null, 2));
  reg('fake-cold', '假冷启动识别组件', 'fake-cold-shim.js', 'FAKE_ASR_PORT', coldPort, 'fake-cold-shim', [{ type: 'asr', basePath: '/v1', model: 'fake-auto', protocol: 'transcriptions' }], { FAKE_COLD_LOAD_MS: String(LOAD_MS) });
  reg('fake-stream', '假流式识别组件', 'fake-stream-component.js', 'FAKE_STREAM_PORT', streamPort, 'fake-stream-component', [{ type: 'asr-stream', basePath: '/v1', model: 'fake-stream-model' }]);
  const shotDir = process.env.RUYI_SHOT_DIR || '';
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-voice-warmup-', width: 1280, height: 900,
      browserArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
      config: {
        configSchema: 13, uiMode: 'pro', desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
        // 第二遍走「重听」(缺省 auto 会把夹具自带的对话桩当大模型拉进来合成);本件只验重听那条路上的预热闸
        asrFixMode: 'audio',
      },
      serverEnv: { RUYI_TOOLBOX_HOME: toolboxHome },
      prepare: async f => {
        // 129j 的做法:红了要说得出为什么 —— 组件的状态(/api/status 的 toolbox 视图:state/error/stderrTail)与如意审计里的 toolbox_service 行。
        // 前缀 FIXTURE-DIAG 会被 run-all 的 failLines 收走。
        const toolboxDiag = async () => {
          try {
            const st = await f.request('GET', '/api/status');
            const comps = ((st && st.json && st.json.toolbox && st.json.toolbox.components) || []).map(c => ({ id: c.id, state: c.state, port: c.port, error: c.error, stderr: String(c.stderrTail || '').slice(-160) }));
            const rows = [];
            for (const name of fs.readdirSync(path.join(f.home, 'logs'))) {
              for (const line of fs.readFileSync(path.join(f.home, 'logs', name), 'utf8').split(/\r?\n/)) {
                try { const r = JSON.parse(line); if (/^toolbox/.test(r.kind)) rows.push([String(r.ts || '').slice(11, 23), r.kind, r.action || '', r.id || '', r.reason || r.error || (r.ms != null ? r.ms + 'ms' : '')].join(' ')); } catch { /* 空行／写到一半 */ }
              }
            }
            console.log('FIXTURE-DIAG toolbox 组件=' + JSON.stringify(comps) + ' 审计=' + JSON.stringify(rows.slice(-14)) + ` 端口 cold=${coldPort} stream=${streamPort}`);
          } catch (e) { console.log('FIXTURE-DIAG toolbox 诊断本身失败: ' + (e && e.message)); }
        };
        const coldUp = await waitForHttp(coldPort, 'GET', '/health', r => r.status === 200 && r.json && r.json.component === 'fake-cold-shim');
        ok(Boolean(coldUp), 'A1 假冷启动组件被如意自动拉起');
        const streamUp = await waitForHttp(streamPort, 'GET', '/health', r => r.status === 200 && r.json && r.json.component === 'fake-stream-component');
        ok(Boolean(streamUp), 'A2 假流式组件被如意自动拉起');
        if (!coldUp || !streamUp) await toolboxDiag();
        let cfg = null;
        for (let i = 0; i < 100 && !cfg; i++) {
          try { const c = JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8')); if (c.asrProviderId === 'toolbox-fake-cold' && c.asrStreamProviderId === 'toolbox-fake-stream') cfg = c; } catch { /* 写到一半 */ }
          if (!cfg) await sleep(100);
        }
        ok(Boolean(cfg) && cfg.asrModel === 'fake-auto' && cfg.asrStreamModel === 'fake-stream-model', `A3 两个组件都被自动配上(asr=${cfg && cfg.asrProviderId}/${cfg && cfg.asrModel} stream=${cfg && cfg.asrStreamProviderId})`);
      },
    });
    const ZH = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
    const ready = await fx.waitForEval(`(() => {
      if (!window.state || !window.state.config || !window.state.config.configSchema) return null;
      if (!document.getElementById('promptInput') || !document.getElementById('composerVoiceBtn')) return null;
      return { asr: String(window.state.config.asrProviderId || ''), stream: String(window.state.config.asrStreamProviderId || '') };
    })()`, 600);
    ok(Boolean(ready) && ready.asr === 'toolbox-fake-cold' && ready.stream === 'toolbox-fake-stream', `A4 首屏就绪,页面里的 config 带着两个 toolbox 端点(实得 ${JSON.stringify(ready)})`);
    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    await fx.waitForEval(`(() => document.documentElement.getAttribute('data-shell-mode') === 'classic' && !document.documentElement.dataset.vt ? 1 : null)()`);

    // 页内探针:按钮状态序列(MutationObserver)、getUserMedia 次数(桩)、/api/audio/* 请求、播报与 toast。
    // document.hasFocus 固定成可控的开关:无头浏览器对它的回答不可靠,而 H 段要专门验「人不在前台」。
    await fx.evaluate(`(() => {
      if (window.__vp) return true;
      const vp = window.__vp = { states: [document.getElementById('composerVoiceBtn').dataset.state], gum: 0, fetches: [], announcements: [], toasts: [], errors: [] };
      window.__focus = true;
      document.hasFocus = () => window.__focus;
      const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
      md.getUserMedia = function () { vp.gum += 1; return orig.apply(md, arguments); };
      const f = window.fetch;
      window.fetch = function (input, init) {
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        if (url.indexOf('/api/audio/') >= 0) vp.fetches.push({ url: url.replace(/[0-9a-f]{32}/, '<id>'), method: (init && init.method) || 'GET' });
        return f.apply(this, arguments);
      };
      // paint() 每 500 ms 把同一个 data-state 再写一遍(加载中的计时),MutationObserver 每次都记一条 → 只留状态【变化】
      new MutationObserver(recs => { for (const r of recs) { if (r.target && r.target.id === 'composerVoiceBtn' && vp.states[vp.states.length - 1] !== r.target.dataset.state) vp.states.push(r.target.dataset.state); } })
        .observe(document.body, { attributes: true, attributeFilter: ['data-state'], subtree: true });
      window.addEventListener('error', event => vp.errors.push(String(event.message || 'error')));
      window.addEventListener('unhandledrejection', event => vp.errors.push('unhandled: ' + String(event.reason && (event.reason.message || event.reason))));
      const watch = node => { if (!node || node.__vpWatched) return; node.__vpWatched = true; new MutationObserver(() => { const text = node.textContent || ''; if (text) vp.announcements.push(text); }).observe(node, { childList: true, characterData: true, subtree: true }); };
      const scan = () => { watch(document.getElementById('composerVoiceBtnStatus')); for (const n of document.querySelectorAll('.toast')) { if (!n.__seen) { n.__seen = true; vp.toasts.push(n.textContent || ''); } } };
      scan();
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
      return true;
    })()`);
    const probe = () => fx.evaluate(`(() => { const p = window.__vp; return { states: p.states.slice(), gum: p.gum, fetches: p.fetches.slice(), announcements: p.announcements.slice(), toasts: p.toasts.slice() }; })()`);
    const waitState = (s, n = 200) => fx.waitForEval(`(() => { const b = document.getElementById('composerVoiceBtn'); return b && b.dataset.state === ${JSON.stringify(s)} ? b.dataset.state : null; })()`, n);
    const click = () => fx.evaluate(`(document.getElementById('composerVoiceBtn').click(), true)`);
    const value = () => fx.evaluate(`document.getElementById('promptInput').value`);
    const waitValue = (re, n = 100) => fx.waitForEval(`(() => { const v = document.getElementById('promptInput').value; return ${re}.test(v) ? v : null; })()`, n);
    const prep = () => fx.evaluate(`(() => { const box = document.getElementById('promptInput'); box.focus(); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const cold = async () => { await request(coldPort, 'POST', '/v1/unload'); const h = await request(coldPort, 'GET', '/health'); return Boolean(h && h.json && h.json.loaded === false); };
    const coldHealth = async () => (await request(coldPort, 'GET', '/health')).json;
    const control = q => request(coldPort, 'POST', '/control?' + q);
    const setCfg = async patch => {
      const r = await fx.request('POST', '/api/config', patch);
      await fx.evaluate(`(() => { window.state.config = Object.assign({}, window.state.config, ${JSON.stringify(patch)}); return true; })()`);
      return Boolean(r) && r.status === 200;
    };
    const shot = async name => {
      if (!shotDir) return;
      try {
        fs.mkdirSync(shotDir, { recursive: true });
        const r = await fx.evaluate(`(() => { const c = document.querySelector('.composer').getBoundingClientRect(); return { x: Math.max(0, c.x - 8), y: Math.max(0, c.y - 8), width: c.width + 16, height: c.height + 16 }; })()`);
        fs.writeFileSync(path.join(shotDir, name + '.png'), await fx.screenshot(r));
      } catch (e) { console.log('shot 失败 ' + name + ': ' + (e && e.message)); }
    };
    ok((await waitState('idle', 50)) === 'idle', 'A5 麦克风起步是空闲态');
    await shot('0-idle');

    /* ═════════ B 冷点(流式路) ═════════ */
    ok(await cold(), 'B0 组件是冷的(/health loaded:false;起来之后没人用过它)');
    await prep();
    const b0 = await probe();
    const tClick = Date.now();
    await click();
    ok(Boolean(await waitState('warming', 100)), 'B1 点麦克风 → 模型没装 → 进「加载中」态');
    const warmAfter = Date.now() - tClick;
    // 墙钟上界豁免：真判据是次序（加载态要早于装好），上界只是把「亮在装好之后」挡住；正常实得约 430 ms（阈值 400 ms）、界取一次完整加载 2500 ms，失败形态是加载态迟迟不亮。
    ok(warmAfter >= 350 && warmAfter < LOAD_MS, `B1b 加载态是【超过一小会儿才亮出来】的(自点击 ${warmAfter} ms;≥ 400 ms 阈值附近、且早于装好)`);
    const w = await fx.evaluate(`(() => {
      const b = document.getElementById('composerVoiceBtn'), t = b.querySelector('.composer-voice-text'), cs = getComputedStyle(t, '::before');
      return { label: t.textContent, title: b.title, pressed: b.getAttribute('aria-pressed'), spinName: cs.animationName, spinW: cs.width, spinBorder: cs.borderTopColor, value: document.getElementById('promptInput').value };
    })()`);
    ok(/^加载模型 \d:\d\d$/.test(w.label), `B2 按钮上是计时 + 人话「加载模型 m:ss」(实得 ${JSON.stringify(w.label)})`);
    ok(w.title === ZH['composer.voice.warming.title'] && w.pressed === 'true', `B3 悬停提示说清「装好自动开始、再点／Esc 取消」、aria-pressed=true(实得 ${JSON.stringify(w.title)} ${w.pressed})`);
    ok(w.spinName === 'compact-spin' && w.spinW === '11px', `B4 转圈在动(::before 的动画 ${w.spinName}、宽 ${w.spinW})`);
    const bWarm = await probe();
    ok(bWarm.gum === b0.gum && bWarm.fetches.length === b0.fetches.length + 1 && bWarm.fetches[bWarm.fetches.length - 1].url.endsWith('/api/audio/warmup') && w.value === '',
      `B5 加载期间【没碰麦克风】(getUserMedia ${b0.gum}→${bWarm.gum})、没开流式会话、只多了一发 warmup、输入框没动(实得 fetch ${JSON.stringify(bWarm.fetches.slice(b0.fetches.length).map(f => f.url))})`);
    ok(bWarm.announcements.slice(b0.announcements.length).includes(ZH['composer.voice.warming.announce']) && bWarm.toasts.slice(b0.toasts.length).some(t => t === ZH['composer.voice.warming.toast']),
      `B6 读屏播报了「正在加载」,屏上有一句 toast 说明白(实得播报 ${JSON.stringify(bWarm.announcements.slice(b0.announcements.length))})`);
    await shot('1-warming');
    const tReady = Date.now();
    ok(Boolean(await waitState('recording', 400)), 'B7 装好后自动进录音态(不用再点)');   // Windows CI 高负载时实测过 200 拍(约 8 s)内仍停在 starting；判据不变，只把等的上限放宽
    const loadWait = Date.now() - tClick;
    ok(loadWait >= LOAD_MS - 200, `B7b 是【等到装好才】开录的(自点击 ${loadWait} ms ≥ 加载 ${LOAD_MS} ms)`);
    const bRec = await probe();
    const seq = bRec.states.slice(b0.states.length).join('>');
    ok(/^starting>warming>starting>recording$/.test(seq), `B8 状态序列 starting → warming → starting → recording(实得 ${seq})`);
    ok(bRec.gum === b0.gum + 1 && bRec.fetches.some(f => f.url.endsWith('/api/audio/stream/sessions')), `B9 装好之后才拿麦克风(getUserMedia ${b0.gum}→${bRec.gum})、才开流式会话`);
    const bAnn = bRec.announcements.slice(b0.announcements.length);
    ok(bAnn.includes(ZH['composer.voice.warming.ready']) && bAnn.includes(ZH['composer.voice.streaming']) && bRec.toasts.slice(b0.toasts.length).some(t => t === ZH['composer.voice.warming.ready']),
      `B10 说了「已就绪,请说话」(播报 + toast),随后是「正在听」(实得 ${JSON.stringify(bAnn)})`);
    await shot('2-recording');
    const tRec = Date.now();
    const corrected = await waitValue('/\\[fake-cold\\] model=fake-small bytes=\\d+/', 100);
    const corrMs = Date.now() - tRec;
    // 墙钟上界豁免：闸后第一句的第二遍自开录起正常实得约 740 ms、界取一次完整加载 2500 ms；失败形态是闸没生效，这一句要多等一整个加载（≥ 3.2 s），差三倍以上。
    ok(Boolean(corrected) && corrMs < LOAD_MS, `B11 第一句的第二遍随即落地:自开录起 ${corrMs} ms < 加载耗时 ${LOAD_MS} ms(没有闸时这一句要多等一整个加载;实得 ${JSON.stringify(corrected)})`);
    await click();
    ok(Boolean(await waitState('idle', 200)), 'B12 再点一下结束回到空闲');
    const bh = await coldHealth();
    ok(bh.loads === 1, `B13 整个过程模型只装了一次(loads=${bh.loads})`);

    /* ═════════ C 热点 ═════════ */
    await prep();
    const c0 = await probe();
    const tC = Date.now();
    await click();
    ok(Boolean(await waitState('recording', 60)), 'C1 模型已装 → 直接进录音态');
    const cMs = Date.now() - tC;
    const c1 = await probe();
    const cSeq = c1.states.slice(c0.states.length).join('>');
    // 墙钟上界豁免：真判据是状态序列里没有 warming，上界只是防挂死；热点自点击到录音态正常实得约 45–60 ms、界 1500 ms，失败形态是走了加载态（≥ 2500 ms 的加载耗时）。
    ok(!cSeq.includes('warming') && cMs < 1500, `C2 一次「加载中」都没出现(状态 ${cSeq}),${cMs} ms 就开录`);
    ok(!c1.toasts.slice(c0.toasts.length).some(t => t === ZH['composer.voice.warming.toast'] || t === ZH['composer.voice.warming.ready']), 'C3 热的时候一句话都不多说(没有加载／就绪的 toast)');
    await click();
    await waitState('idle', 200);

    /* ═════════ D 加载中再点一下＝取消 ═════════ */
    ok(await cold(), 'D0 卸载,回到冷');
    await prep();
    const d0 = await probe();
    const dh0 = await coldHealth();
    await click();
    await waitState('warming', 100);
    await click();
    ok(Boolean(await waitState('idle', 25)), 'D1 加载中再点一下 → 取消,回到空闲');
    await sleep(LOAD_MS + 900);
    const d1 = await probe();
    ok((await waitState('idle', 3)) === 'idle' && d1.gum === d0.gum && !d1.fetches.slice(d0.fetches.length).some(f => f.url.includes('/stream/')),
      `D2 装好之后也不会自己开录(getUserMedia ${d0.gum}→${d1.gum}、没有流式会话;状态 ${d1.states.slice(d0.states.length).join('>')})`);
    ok(d1.announcements.slice(d0.announcements.length).includes(ZH['composer.voice.cancelled']), 'D3 取消说了一句「已取消」');
    const dh1 = await coldHealth();
    ok(dh1.loaded === true && dh1.loads === dh0.loads + 1, `D4 取消掐的是这一发请求,不是服务端的装载:模型照装、只装一次(loads ${dh0.loads}→${dh1.loads})`);
    const d2 = await probe();
    await click();
    ok(Boolean(await waitState('recording', 60)), 'D5 取消之后再点 → 已经是热的,直接开录');
    ok(!(await probe()).states.slice(d2.states.length).includes('warming'), 'D5b 这一次没有加载态');
    await click();
    await waitState('idle', 200);

    /* ═════════ E Esc 取消 ═════════ */
    ok(await cold(), 'E0 卸载,回到冷');
    await prep();
    const e0 = await probe();
    await click();
    await waitState('warming', 100);
    await fx.escape();
    ok(Boolean(await waitState('idle', 25)), 'E1 加载中按 Esc → 取消');
    await sleep(LOAD_MS + 900);
    const e1 = await probe();
    ok(e1.gum === e0.gum && (await waitState('idle', 3)) === 'idle', `E2 Esc 之后同样不会自己开录(getUserMedia ${e0.gum}→${e1.gum})`);

    /* ═════════ F 预热失败不拦流式路 ═════════ */
    ok(await cold(), 'F0 卸载,回到冷');
    await control('fail=1');
    await prep();
    const f0 = await probe();
    await click();
    ok(Boolean(await waitState('recording', 100)), 'F1 预热失败 → 流式路照样开录(第一遍不依赖它)');
    const f1 = await probe();
    ok(!f1.states.slice(f0.states.length).includes('warming') && f1.toasts.slice(f0.toasts.length).some(t => t === ZH['composer.voice.warming.failed']),
      `F2 说了一句「更准的本地识别模型没能加载好…」(状态 ${f1.states.slice(f0.states.length).join('>')})`);
    ok(Boolean(await waitValue('/p\\d+/', 100)), 'F3 第一遍的字照样实时出现');
    await click();
    await waitState('idle', 200);
    await sleep(LOAD_MS + 500);   // 让后台的第二遍把模型装完,后面的段落回到干净的冷/热口径

    /* ═════════ H 装好时页面不在前台 ═════════ */
    ok(await cold(), 'H0 卸载,回到冷');
    await prep();
    await fx.evaluate(`(window.__focus = false, true)`);
    const h0 = await probe();
    await click();
    await waitState('warming', 100);
    ok(Boolean(await waitState('idle', 200)), 'H1 装好了,但人不在前台 → 不替他开麦克风,回到空闲');
    const h1 = await probe();
    ok(h1.gum === h0.gum && h1.toasts.slice(h0.toasts.length).some(t => t === ZH['composer.voice.warming.readyIdle']) && h1.announcements.slice(h0.announcements.length).includes(ZH['composer.voice.warming.readyIdle']),
      `H2 说了一句「已就绪,点一下麦克风开始说话」(getUserMedia ${h0.gum}→${h1.gum})`);
    await fx.evaluate(`(window.__focus = true, true)`);
    const h2 = await probe();
    await click();
    ok(Boolean(await waitState('recording', 60)) && !(await probe()).states.slice(h2.states.length).includes('warming'), 'H3 回来点一下 → 已经是热的,直接开录');
    await click();
    await waitState('idle', 200);

    /* ═════════ G 没有第一遍 + 预热失败 ═════════ */
    ok(await setCfg({ asrStreamProviderId: '', asrStreamModel: '' }), 'G0 关掉实时识别(只剩按停顿切段)');
    ok(await cold(), 'G0b 卸载,回到冷');
    await control('fail=1');
    await prep();
    const g0 = await probe();
    await click();
    ok(Boolean(await waitState('error', 100)), 'G1 没有第一遍的,预热失败 → 当场说清原因(error 态)');
    const g1 = await fx.evaluate(`(() => { const b = document.getElementById('composerVoiceBtn'); return { title: b.title, gum: window.__vp.gum }; })()`);
    ok(g1.title === ZH['composer.voice.error.upstream'] && g1.gum === g0.gum, `G2 提示是「转写服务报错」那一句、没碰麦克风(getUserMedia ${g0.gum}→${g1.gum};title ${JSON.stringify(g1.title.slice(0, 24))})`);

    /* ═════════ I 没有第一遍 + 冷点 ═════════ */
    ok(await cold(), 'I0 卸载,回到冷');
    await prep();
    const i0 = await probe();
    const tI = Date.now();
    await click();
    ok(Boolean(await waitState('warming', 100)), 'I1 冷点 → 加载中');
    ok(Boolean(await waitState('recording', 200)), 'I2 装好后进录音态(按停顿切段那条路)');
    ok((await probe()).gum === i0.gum + 1, 'I2b 装好之后才拿麦克风');
    await sleep(1800);
    const tStop = Date.now();
    await click();
    const iText = await waitValue('/\\[fake-cold\\] model=fake-small/', 100);
    const iMs = Date.now() - tStop;
    // 墙钟上界豁免：停止后第一句转写正常实得约 50 ms、界取一次完整加载 2500 ms；失败形态是预热没生效，首句要等整个加载（≥ 2.5 s），差两个数量级。
    ok(Boolean(iText) && iMs < LOAD_MS, `I3 停止后第一句转写就是热的(自停止起 ${iMs} ms < 加载耗时 ${LOAD_MS} ms;实得 ${JSON.stringify(iText)})`);
    const ih = await coldHealth();
    ok(ih.loads >= 1 && (await probe()).fetches.some(f => f.url.includes('/api/audio/transcribe')), 'I4 走的是 /api/audio/transcribe(按停顿切段)');

    const errs = await fx.evaluate(`(() => window.__vp && window.__vp.errors || [])()`).catch(() => []);
    ok(fx.exceptions.length === 0 && (errs || []).length === 0, `J1 零未捕获异常(CDP ${JSON.stringify(fx.exceptions)})`);
  } catch (error) {
    fail++; console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    console.log('\nCOMPOSER VOICE WARMUP BROWSER E2E: ' + (fail === 0 ? 'ALL PASS' : `FAIL (${fail})`));
    if (fx) { try { await fx.close(); } catch { /* ignore */ } }
    try { fs.rmSync(extra, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(fail === 0 ? 0 : 1);
  }
})();
