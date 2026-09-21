require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注);登记目录另经 RUYI_TOOLBOX_HOME 指到临时目录,不碰真机 ~/.ruyi-toolbox
'use strict';
// E2E(第 130 波,51 号文;用户拍板:校正默认静默替换、只做麦克风):输入框麦克风的【流式路】,真浏览器件。
//
// 形状:公共夹具 lib/browser-fixture(128d)起工作台与无头 Edge,加假麦克风开关;一个假的流式组件(照 ruyi-toolbox docs/02 §2
// 的会话 API,经 RUYI_TOOLBOX_HOME 登记,如意启动时自动发现并配成实时识别端点);fake-openai.js 的 ASR 桩当第二遍(回显 [fake-asr] …)。
// 假流式组件的判据可预测:partial = 'p<累计字节>';每 3 块收口一句 '句N';finish 收 '尾句';时间轴按收到的字节算(ms = 字节/32)。
// 第二遍把每句换成 '[fake-asr] model=…'。
//
// 判据:
//   A 启动:组件被发现、asrStream* 自动配上;麦克风的悬停提示是流式那句。
//   B 边说边出字:点麦克风 → 输入框里出现临时文字 p<字节>(随块变) → 定稿句被第二遍【静默换成】回显文本;
//     结束 → finish 的尾句也进来并被换掉;最终没有临时文字残留;不自动发送;aria-live 播报过「正在听」与「已填入」。
//   C 只动没碰过的字:录音中用户把已定稿那一句改掉一个字 → 那一句不再被碰;后面的句子照样接上、照样被换(每句各管各的段)。
//   D Esc 取消:临时文字撤掉、已定稿的字留着、服务端会话被 DELETE。
//   E 回落:实时识别指向一个不会开会话的端点(fake-openai 没有 /stream/sessions)→ 说一句、这次走按停顿切段,转写照样回填。
//   F 零未捕获异常。
// 判定行:`COMPOSER VOICE STREAM BROWSER E2E: ALL PASS`。
const cp = require('child_process'), path = require('path'), fs = require('fs'), os = require('os');
const { startBrowserFixture, waitForHttp, request, sleep, WB } = require('./lib/browser-fixture');
const { getFreePort } = require('./free-port.js');

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

// ── 夹具 1:假流式组件 ─────────────────────────────────────────────────────────────────────
const FAKE_STREAM = `
const http = require('http'), crypto = require('crypto');
const port = Number(process.env.FAKE_STREAM_PORT || 0);
const sessions = new Map(); let deleted = 0;
http.createServer((req, res) => {
  const j = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  if (req.url === '/health') return j(200, { ok: true, component: 'fake-stream-component', version: '0.0.1', loaded: true, sessions: sessions.size, deleted });
  const m = req.url.match(/^\\/v1\\/stream\\/sessions(?:\\/([0-9a-f]{32})(?:\\/(audio|finish))?)?$/);
  if (!m) return j(404, { error: { message: 'no', type: 'not_found' } });
  let chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && !m[1]) { const id = crypto.randomBytes(16).toString('hex'); sessions.set(id, { bytes: 0, chunks: 0, finals: 0, lastEnd: 0 }); return j(200, { id, sampleRate: 16000 }); }
    const s = sessions.get(m[1]); if (!s) return j(404, { error: { message: 'unknown', type: 'unknown_session' } });
    if (req.method === 'DELETE') { sessions.delete(m[1]); deleted += 1; res.writeHead(204); return res.end(); }
    if (m[2] === 'audio') { s.bytes += body.length; s.chunks += 1; const finals = []; if (s.chunks % 3 === 0) { s.finals += 1; finals.push({ text: '句' + s.finals, startMs: s.lastEnd, endMs: Math.round(s.bytes / 32) }); s.lastEnd = Math.round(s.bytes / 32); } return j(200, { partial: 'p' + s.bytes, finals }); }
    if (m[2] === 'finish') { sessions.delete(m[1]); return j(200, { finals: [{ text: '尾句', startMs: s.lastEnd, endMs: Math.round(s.bytes / 32) }] }); }
    j(404, { error: { message: 'no', type: 'not_found' } });
  });
}).listen(port, '127.0.0.1');
`;

(async () => {
  let fx = null, asrStub = null;
  const extra = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-voice-stream-x-'));
  const toolboxHome = path.join(extra, 'toolbox');
  const fakeDir = path.join(extra, 'fake');
  fs.mkdirSync(path.join(toolboxHome, 'components'), { recursive: true });
  fs.mkdirSync(fakeDir, { recursive: true });
  fs.writeFileSync(path.join(fakeDir, 'stream.js'), FAKE_STREAM);
  const streamPort = await getFreePort();
  const asrPort = await getFreePort();
  fs.writeFileSync(path.join(toolboxHome, 'components', 'fake-stream.json'), JSON.stringify({
    schema: 1, id: 'fake-stream', kind: 'service', name: '假流式识别组件', version: '0.0.1',
    run: { command: process.execPath, args: [path.join(fakeDir, 'stream.js')], cwd: fakeDir, env: {} },
    service: { port: streamPort, portEnv: 'FAKE_STREAM_PORT', health: '/health', component: 'fake-stream-component' },
    provides: [{ type: 'asr-stream', basePath: '/v1', model: 'fake-stream-model' }],
    registeredAt: new Date().toISOString(),
  }, null, 2));
  try {
    // 夹具 2:fake-openai 当第二遍(whisper-1 回显)。另标一个 asr-stream 模型指向它:它没有 /stream/sessions → 用来验 E 回落。
    asrStub = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(asrPort)], { windowsHide: true, env: { ...process.env }, stdio: 'ignore' });
    ok(Boolean(await waitForHttp(asrPort, 'GET', '/v1/models', r => r.status === 200)), 'A0 fake-openai(第二遍桩)已起');
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-voice-stream-', width: 1280, height: 900,
      browserArgs: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
      // 131b:夹具自带的假对话 provider 当「大模型改字」的端点(G 段)。按请求里的 model 名分三种回法:
      //   fix-echo   → 'LLM:' + 转写(合成模式取 B 那一版,模仿「以 B 为主」);单行,长度与输入同量级(过合理性)
      //   fix-empty  → 空正文(flash 系模型思考吃光预算的形状)→ 服务端当失败,回落到重听结果
      //   fix-answer → 多行答题(把内容当指令)→ 合理性拦下,回落
      provider: ctx => {
        const model = String(ctx.body && ctx.body.model || '');
        const user = ctx.messages.filter(m => m && m.role === 'user').map(m => String(m.content || '')).join('\n');
        const m = user.match(/<transcript>([\s\S]*?)<\/transcript>/);
        const inner = m ? m[1] : user;
        if (model === 'fix-empty') { ctx.stop(); return; }
        if (model === 'fix-answer') { ctx.text('好的，这是翻译：\nHello world'); ctx.stop(); return; }
        const b = inner.includes('\nB：') ? inner.split('\nB：')[1] : inner;
        ctx.text('LLM:' + b.trim()); ctx.stop();
      },
      config: {
        configSchema: 13, uiMode: 'pro', desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
        providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${asrPort}`, apiKey: 'k', model: 'fake-model',
          models: [{ id: 'fake-model', label: 'Fake' }, { id: 'whisper-1', label: 'whisper-1', caps: ['asr'] }, { id: 'no-stream-here', label: 'no-stream-here', caps: ['asr-stream'] }] }],
        asrProviderId: 'fake', asrModel: 'whisper-1',
        // 131b:B–E 段验的是「重听」那条路,先钉成 audio(缺省 auto 会把 fake-openai 的对话桩当大模型拉进来合成);大模型改字在 G 段单验。
        asrFixMode: 'audio',
      },
      serverEnv: { RUYI_TOOLBOX_HOME: toolboxHome },
      // 开页之前等自动配置落盘:否则首屏 config 里还没有 asrStream*,麦克风走老路。
      prepare: async f => {
        const streamUp = await waitForHttp(streamPort, 'GET', '/health', r => r.status === 200 && r.json && r.json.component === 'fake-stream-component');
        ok(Boolean(streamUp), 'A1 假流式组件被如意自动拉起(登记经 RUYI_TOOLBOX_HOME)');
        let cfg = null;
        for (let i = 0; i < 100 && !cfg; i++) { try { const c = JSON.parse(fs.readFileSync(path.join(f.home, 'config.json'), 'utf8')); if (c.asrStreamProviderId === 'toolbox-fake-stream') cfg = c; } catch { /* 写到一半 */ } if (!cfg) await sleep(100); }
        ok(Boolean(cfg) && cfg.asrStreamModel === 'fake-stream-model' && cfg.asrProviderId === 'fake', `A2 asrStream* 自动配成假流式组件,第二遍仍是 fake/whisper-1(实得 ${JSON.stringify(cfg && [cfg.asrStreamProviderId, cfg.asrStreamModel, cfg.asrProviderId])})`);
      },
    });
    const ZH = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
    const ready = await fx.waitForEval(`(() => {
      if (!window.state || !window.state.config || !window.state.config.configSchema) return null;
      if (!document.getElementById('promptInput') || !document.getElementById('composerVoiceBtn')) return null;
      const lens = document.querySelector('#lensSeg [data-lens]');
      if (!lens || typeof lens.onclick !== 'function') return null;
      return { stream: [String(window.state.config.asrStreamProviderId || ''), String(window.state.config.asrStreamModel || '')] };
    })()`, 600);
    ok(Boolean(ready) && ready.stream[0] === 'toolbox-fake-stream', `A3 首屏就绪,页面里的 config 带着 asrStream*(实得 ${JSON.stringify(ready && ready.stream)})`);
    await fx.evaluate(`(() => {
      if (window.__voiceProbe) return true;
      const probe = window.__voiceProbe = { sends: [], asr: [], stream: [], announcements: [], errors: [], toasts: [], correct: 0 };
      const original = window.fetch;
      window.fetch = function (input, init) {
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        if (/\\/api\\/(chat\\/stream|steer|steward\\/(message|act))/.test(url)) probe.sends.push(url);
        if (url.indexOf('/api/audio/transcribe') >= 0) probe.asr.push({ url, size: init && init.body && typeof init.body.size === 'number' ? init.body.size : -1 });
        // 131b:第二遍改经 /api/audio/correct;带没带音频看 JSON 体里 audio 是不是 null。asr 计数从此按「带音频的第二遍」算(与修前语义一致)。
        if (url.indexOf('/api/audio/correct') >= 0) { probe.correct += 1; try { const b = JSON.parse(String(init && init.body || '{}')); if (b && typeof b.audio === 'string' && b.audio) probe.asr.push({ url, size: b.audio.length }); } catch { /* 非 JSON */ } }
        if (url.indexOf('/api/audio/stream/') >= 0) probe.stream.push({ url: url.replace(/[0-9a-f]{32}/, '<id>'), method: (init && init.method) || 'GET', bytes: init && init.body && init.body.byteLength ? init.body.byteLength : 0 });
        return original.apply(this, arguments);
      };
      window.addEventListener('error', event => probe.errors.push(String(event.message || 'error')));
      window.addEventListener('unhandledrejection', event => probe.errors.push('unhandled: ' + String(event.reason && (event.reason.message || event.reason))));
      const watch = node => { if (!node || node.__voiceWatched) return; node.__voiceWatched = true; new MutationObserver(() => { const text = node.textContent || ''; if (text) probe.announcements.push(text); }).observe(node, { childList: true, characterData: true, subtree: true }); };
      const scan = () => { watch(document.getElementById('composerVoiceBtnStatus')); for (const n of document.querySelectorAll('.toast')) { if (!n.__seen) { n.__seen = true; probe.toasts.push(n.textContent || ''); } } };
      scan();
      new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
      return true;
    })()`);
    const PROBE = `(() => { const p = window.__voiceProbe; return { sends: p.sends.slice(), asr: p.asr.slice(), stream: p.stream.slice(), announcements: p.announcements.slice(), errors: p.errors.slice(), toasts: p.toasts.slice(), correct: p.correct }; })()`;
    const PREP = (text, caret) => `(() => { const box = document.getElementById('promptInput'); box.focus(); box.value = ${JSON.stringify(text)}; box.dispatchEvent(new Event('input', { bubbles: true })); box.setSelectionRange(${caret}, ${caret}); return box.value; })()`;
    const BOX = `(() => { const b = document.getElementById('composerVoiceBtn'); const box = document.getElementById('promptInput'); return { value: box.value, state: b.dataset.state, title: b.title }; })()`;
    const WAIT_VALUE = re => `(() => { const box = document.getElementById('promptInput'); return ${re}.test(box.value) ? box.value : null; })()`;
    const WAIT_STATE = wanted => `(() => { const b = document.getElementById('composerVoiceBtn'); return b && b.dataset.state === ${JSON.stringify(wanted)} ? b.dataset.state : null; })()`;
    const VALUE = `document.getElementById('promptInput').value`;
    const clickMic = () => fx.evaluate(`(document.getElementById('composerVoiceBtn').click(), true)`);

    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    await fx.waitForEval(`(() => document.documentElement.getAttribute('data-shell-mode') === 'classic' && !document.documentElement.dataset.vt ? 1 : null)()`);
    const idle = await fx.evaluate(BOX);
    ok(idle.state === 'idle' && idle.title === ZH['composer.voice.hintStream'], `A4 麦克风空闲、悬停提示是流式那句(实得 state=${idle.state} title=${JSON.stringify(idle.title)})`);

    /* ═════════ B 边说边出字 + 静默校正 ═════════ */
    await fx.evaluate(PREP('前缀 后缀', 3));   // 光标在「前缀 」之后:落字形状是「前缀 」＋ 字 ＋「后缀」
    const b0 = await fx.evaluate(PROBE);
    await clickMic();
    ok(Boolean(await fx.waitForEval(WAIT_STATE('recording'))), 'B1 点麦克风进入录音态(流式会话已开)');
    const partial = await fx.waitForEval(WAIT_VALUE('/^前缀 p\\d+后缀$/'), 200);
    ok(Boolean(partial), `B2 临时文字实时出现在光标处(实得 ${JSON.stringify(partial)})`);
    const corrected1 = await fx.waitForEval(WAIT_VALUE('/\\[fake-asr\\] model=whisper-1 filename=voice\\.wav bytes=\\d+/'), 300);
    ok(Boolean(corrected1) && /^前缀 \[fake-asr\] model=whisper-1 filename=voice\.wav bytes=\d+/.test(corrected1) && /p\d+后缀$/.test(corrected1),
      `B3 第一句定稿(句1)随即被第二遍静默换成回显文本,临时文字还接在后面(实得 ${JSON.stringify(corrected1)})`);
    // 在「一句刚定稿、下一句的临时文字刚出现」之后约 300 ms 点结束:尾巴那一句约 550–650 ms 音频 —— 够第二遍跑(≥ 300 ms),
    // 又赶在假组件下一次收口(每 3 块 = 750 ms)之前,所以 finish 收到的尾句一定有音频可校正。
    ok(Boolean(await fx.waitForEval(WAIT_VALUE('/(句\\d+|bytes=\\d+) ?p\\d+后缀$/'), 300)), 'B3b 下一句的临时文字接在定稿句后面');
    await sleep(300);
    await clickMic();
    const done = await fx.waitForEval(`(() => { const b = document.getElementById('composerVoiceBtn'); const box = document.getElementById('promptInput'); return b.dataset.state === 'idle' && !/p\\d+/.test(box.value) ? box.value : null; })()`, 400);
    await sleep(1500);   // 第二遍与误触发的发送都会在这一拍里落地
    const b1 = await fx.evaluate(PROBE);
    const doneValue = await fx.evaluate(VALUE);
    const echoes = (doneValue || '').match(/\[fake-asr\] model=whisper-1/g) || [];
    ok(Boolean(done) && doneValue.startsWith('前缀 ') && doneValue.endsWith('后缀') && echoes.length >= 2 && !/句\d|尾句|p\d+后缀/.test(doneValue),
      `B4 结束后:尾句也进来了、每句都被换成回显、没有临时文字残留、前缀后缀原样(实得 ${JSON.stringify(doneValue)})`);
    const streamCalls = b1.stream.slice(b0.stream.length);
    ok(streamCalls[0] && streamCalls[0].url.endsWith('/api/audio/stream/sessions') && streamCalls.some(c => c.url.endsWith('/audio') && c.bytes > 0 && c.bytes % 2 === 0) && streamCalls.some(c => c.url.endsWith('/finish')),
      `B5 走的是流式代理:开会话 → 若干块 PCM(偶数字节) → finish(实得 ${streamCalls.length} 次,首=${streamCalls[0] && streamCalls[0].url})`);
    ok(b1.asr.length - b0.asr.length === echoes.length, `B6 第二遍每句一发 /api/audio/transcribe(实得 ${b1.asr.length - b0.asr.length} 发,换了 ${echoes.length} 句)`);
    ok(b1.sends.length === b0.sends.length, `B7 不自动发送(发送计数增量 ${b1.sends.length - b0.sends.length})`);
    const ann = b1.announcements.slice(b0.announcements.length);
    ok(ann.includes(ZH['composer.voice.streaming']) && ann.includes(ZH['composer.voice.inserted']), `B8 播报过「正在听」与「已填入」(实得 ${JSON.stringify(ann)})`);

    /* ═════════ C 只动没碰过的字 ═════════ */
    await fx.evaluate(PREP('', 0));
    await clickMic();
    await fx.waitForEval(WAIT_STATE('recording'));
    const firstFinal = await fx.waitForEval(WAIT_VALUE('/^\\[fake-asr\\][^\\n]*p\\d+$/'), 300);
    ok(Boolean(firstFinal), `C1 第一句已定稿并被换成回显(实得 ${JSON.stringify(firstFinal)})`);
    await fx.evaluate(`(() => { const box = document.getElementById('promptInput'); box.value = box.value.replace('[fake-asr]', '[FAKE-asr]'); box.setSelectionRange(box.value.length, box.value.length); box.dispatchEvent(new Event('input', { bubbles: true })); return box.value; })()`);
    await sleep(1800);
    await clickMic();
    await fx.waitForEval(WAIT_STATE('idle'), 400);
    await sleep(1500);
    const cValue = await fx.evaluate(VALUE);
    ok(cValue.startsWith('[FAKE-asr]') && !/p\d+/.test(cValue) && !/句\d|尾句/.test(cValue) && (cValue.match(/\[fake-asr\]/g) || []).length >= 1,
      `C2 被用户改过的那一句一个字不动;后面的句子照样接上、照样被第二遍换成回显(每句各管各的段)(实得 ${JSON.stringify(cValue)})`);

    /* ═════════ D Esc 取消 ═════════ */
    await fx.evaluate(PREP('', 0));
    const hBefore = await request(streamPort, 'GET', '/health');
    await clickMic();
    await fx.waitForEval(WAIT_STATE('recording'));
    await fx.waitForEval(WAIT_VALUE('/^\\[fake-asr\\][^\\n]*p\\d+$/'), 300);
    await fx.cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await fx.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await fx.waitForEval(WAIT_STATE('idle'), 200);
    await sleep(600);
    const dValue = await fx.evaluate(VALUE);
    const hAfter = await waitForHttp(streamPort, 'GET', '/health', r => r.json && r.json.deleted > hBefore.json.deleted, null, 50);
    ok(/^\[fake-asr\]/.test(dValue) && !/p\d+/.test(dValue), `D1 Esc:临时文字撤掉、已定稿的字留着(实得 ${JSON.stringify(dValue)})`);
    ok(Boolean(hAfter), `D2 服务端会话被 DELETE 掉(组件 deleted 计数 ${hBefore.json.deleted} → ${hAfter && hAfter.json.deleted})`);

    /* ═════════ G 大模型改字(131b,52 号文 §5;用户拍板 2) ═════════ */
    // 假大模型 = 夹具自带的对话 provider(fx.providerPort);加一条服务商 'fix' 指向它,三个模型名对应三种回法(见 provider 脚本)。
    const cfgNow = (await fx.request('GET', '/api/status')).json.config;
    const addFix = await fx.request('POST', '/api/config', { providers: [...(cfgNow.providers || []), { id: 'fix', label: 'Fix', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fx.providerPort}`, apiKey: 'k', model: 'fix-echo', models: [{ id: 'fix-echo' }, { id: 'fix-empty' }, { id: 'fix-answer' }] }] });
    ok(Boolean(addFix) && addFix.status === 200, `G0 加一条假大模型服务商 fix(实得 ${addFix && addFix.status})`);
    const setFix = async (patch) => {
      const r = await fx.request('POST', '/api/config', patch);
      await fx.evaluate(`(() => { window.state.config = Object.assign({}, window.state.config, ${JSON.stringify(patch)}); return true; })()`);
      return r && r.status === 200;
    };
    const recordOnce = async (settle = 1800) => {
      await fx.evaluate(PREP('', 0));
      const before = await fx.evaluate(PROBE);
      await clickMic();
      await fx.waitForEval(WAIT_STATE('recording'));
      await fx.waitForEval(WAIT_VALUE('/^(LLM:|\\[fake-asr\\]|句\\d)[^\\n]*p\\d+$/'), 300);   // 第一句定稿(被换或没被换)、临时文字接在后面
      await sleep(400);
      await clickMic();
      await fx.waitForEval(WAIT_STATE('idle'), 400);
      await sleep(settle);
      const after = await fx.evaluate(PROBE);
      return { value: await fx.evaluate(VALUE), asr: after.asr.length - before.asr.length, sends: after.sends.length - before.sends.length };
    };
    // G1 只让大模型改字:句子被换成 LLM:句N;不带音频 → /api/audio/transcribe 一次都不发(第二遍走的是 /api/audio/correct)
    ok(await setFix({ asrFixMode: 'llm', asrFixProviderId: 'fix', asrFixModel: 'fix-echo' }), 'G1a 配成 llm / fix / fix-echo');
    const g1 = await recordOnce();
    ok(/LLM:句\d/.test(g1.value) && !/\[fake-asr\]/.test(g1.value) && !/p\d+/.test(g1.value) && g1.asr === 0 && g1.sends === 0,
      `G1 只改字:每句被换成 LLM:句N、没重听、没临时文字残留、不自动发送(实得 ${JSON.stringify(g1)})`);
    // G2 自动:重听 + 合成 → 大模型拿到 A(句N)与 B([fake-asr] …),以 B 为主 → LLM:[fake-asr] …
    ok(await setFix({ asrFixMode: 'auto' }), 'G2a 配成 auto');
    const g2 = await recordOnce();
    ok(/LLM:\[fake-asr\] model=whisper-1/.test(g2.value) && !/句\d/.test(g2.value),
      `G2 自动 = 重听 + 合成:句子被换成 LLM:[fake-asr] …(大模型拿到了重听那一版)(实得 ${JSON.stringify(g2.value)})`);
    // G3 大模型回空正文(思考吃光预算的形状)→ 回落到重听结果:[fake-asr] … 而不是 LLM:
    ok(await setFix({ asrFixModel: 'fix-empty' }), 'G3a 改字模型换成 fix-empty');
    const g3 = await recordOnce();
    ok(/\[fake-asr\] model=whisper-1/.test(g3.value) && !/LLM:/.test(g3.value) && !/句\d/.test(g3.value),
      `G3 大模型回空正文 → 回落到重听结果(实得 ${JSON.stringify(g3.value)})`);
    // G4 大模型把内容当指令答题(多行)→ 合理性拦下;llm 模式没有重听可回落 → 保留第一遍的字(句N),一个字不动
    ok(await setFix({ asrFixMode: 'llm', asrFixModel: 'fix-answer' }), 'G4a 配成 llm / fix-answer');
    const g4 = await recordOnce();
    ok(/句\d/.test(g4.value) && !/Hello|翻译|LLM:/.test(g4.value), `G4 答题形输出被拦下、保留第一遍(实得 ${JSON.stringify(g4.value)})`);
    // G5 关闭 → 不发第二遍:保留 句N,/api/audio/correct 不打
    ok(await setFix({ asrFixMode: 'off' }), 'G5a 配成 off');
    const p5 = await fx.evaluate(PROBE);
    const g5 = await recordOnce(800);
    const p5b = await fx.evaluate(PROBE);
    ok(/句\d/.test(g5.value) && !/LLM:|\[fake-asr\]/.test(g5.value) && p5b.correct === p5.correct, `G5 关闭 → 句子保留第一遍、不发第二遍(实得 ${JSON.stringify(g5.value)} correct=${p5b.correct - p5.correct})`);
    ok(await setFix({ asrFixMode: 'audio', asrFixProviderId: '', asrFixModel: '' }), 'G6 回到 audio(E 段验回落时第二遍仍走重听)');

    /* ═════════ E 回落 ═════════ */
    const sw = await fx.request('POST', '/api/config', { asrStreamProviderId: 'fake', asrStreamModel: 'no-stream-here' });
    ok(Boolean(sw) && sw.status === 200, `E1 把实时识别指向一个开不了会话的端点(实得 ${sw && sw.status} ${sw && sw.text.slice(0, 120)})`);
    await fx.evaluate(`(() => { window.state.config = Object.assign({}, window.state.config, { asrStreamProviderId: 'fake', asrStreamModel: 'no-stream-here' }); return true; })()`);
    await fx.evaluate(PREP('', 0));
    const e0 = await fx.evaluate(PROBE);
    await clickMic();
    await fx.waitForEval(WAIT_STATE('recording'));
    await sleep(1500);
    await clickMic();
    const eValue = await fx.waitForEval(WAIT_VALUE('/\\[fake-asr\\] model=whisper-1/'), 400);
    await sleep(800);
    const e1 = await fx.evaluate(PROBE);
    ok(Boolean(eValue) && e1.toasts.slice(e0.toasts.length).some(t => t.includes(ZH['composer.voice.error.streamFallback'])) && e1.stream.slice(e0.stream.length).every(c => c.url.endsWith('/api/audio/stream/sessions')),
      `E2 开会话失败 → 说一句「实时识别没起来」、这次走按停顿切段、转写照样回填(实得 ${JSON.stringify(eValue)} toasts=${JSON.stringify(e1.toasts.slice(e0.toasts.length))})`);

    const final = await fx.evaluate(PROBE);
    ok(final.errors.length === 0 && fx.exceptions.length === 0, `F1 零未捕获异常(页面 ${JSON.stringify(final.errors)} / CDP ${JSON.stringify(fx.exceptions)})`);
  } catch (error) {
    fail++; console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    console.log('\nCOMPOSER VOICE STREAM BROWSER E2E: ' + (fail === 0 ? 'ALL PASS' : `FAIL (${fail})`));
    if (fx) { try { await fx.close(); } catch { /* ignore */ } }
    if (asrStub && asrStub.pid) { try { asrStub.kill(); } catch { /* already gone */ } }
    try { fs.rmSync(extra, { recursive: true, force: true }); } catch { /* ignore */ }
    process.exit(fail === 0 ? 0 : 1);
  }
})();
