require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离（见 lib 头注）
'use strict';
// E2E（127 波 ⑦ B-114c-① · 45 号文 §4 ⑦ ／ §2-quinquies「⑦ 麦克风：落点定案」）：输入框麦克风【真浏览器件】。
//
// 形状：§1.5 先验已通过，走真麦克风 —— 无头 Edge 加 --use-fake-device-for-media-stream ＋
// --use-fake-ui-for-media-stream（A 组实证：不加就是 NotFoundError），fake-openai.js 的 ASR 桩回显
// `[fake-asr] model=… filename=… bytes=N`。这两个开关由 asr-config-ui.static.e2e.js ⑥ 钉住。
//
// 判据（§4 ⑦ 逐条）：
//   ① 工作台输入框：「前缀 后缀」光标放在两词之间 → 真鼠标点麦克风 → 录 ≥1.2 s → 再点停止 →
//      非空音频字节到了服务端（107-A1：录的是 webm/opus，上传前无条件转 16 kHz 单声道 16 bit WAV ——
//      请求体 RIFF/WAVE 魔数、Content-Type 被覆盖成 audio/wav、头里的采样率／声道数／位深都钉住、
//      回显 filename=voice.wav bytes>0 且与请求体字节数相等）→ 回填在【光标处】（前缀＋转写＋后缀）→
//      发送计数 0（页面里包一层 window.fetch，数 /api/(chat/stream|steer|steward/(message|act))）。
//   ② 同一套流程在管家视角的输入框里再走一遍。
//   ③ 键盘：Tab 走到麦克风 → Space 开始、Space 结束，aria-pressed 跟着翻，aria-live 节点播报过；
//      录音中 Esc 取消 → 零转写请求、输入框一个字不变。
//   ④ 未配置：设置页选择器切到「不启用」→ 两个输入框里的麦克风节点当场被拆；重载后仍一个都没有。
//   ⑤ 双主题（默认深色 ＋ ?theme=light）× 390px：两个视角的麦克风都看得见、点得中，输入框保有可用宽度
//      （getBoundingClientRect 读数打印出来），录音态变宽之后也一样。
//   ⑥ 失败：转写上游 5xx／转写为空／麦克风被拒 —— 播报本地化人话、按钮进错误态、输入框不动、零未捕获异常。
//   ⑧ 107-A1 回退：把 OfflineAudioContext 换成抛异常的桩 → 转码解不开就原样发 webm（EBML 魔数、
//      Content-Type 回退 audio/webm），转写照样成功回填 —— 录完了发不出去比「协议不对」更坏。
//   另加一条：录满 3 分钟自动结束（把页面的 performance.now 拨快 181 s，不点第二下，自己转写回填）。
//
// 反向（交付记录里有读数）：㈠ 模块回填后顺手点发送 → ① 发送计数红；㈡ 启动参数拿掉一个媒体开关 →
// asr-config-ui.static ⑥ 红并点名本件；㈢ 回填改成追加到末尾 → ① 光标处断言红。
// 判定行：`COMPOSER VOICE BROWSER E2E: ALL PASS`。
(async () => {
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const { findBrowserExecutable } = require('./lib/browser-path');
const { stopRuyiTestBrowsers } = require('./lib/browser-cleanup');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const appPort = await getFreePort();
const providerPort = await getFreePort();
const debugPort = await getFreePort();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-composer-voice-'));
const home = path.join(root, 'home');
const work = path.join(root, 'work');
const profile = path.join(root, 'profile');
for (const dir of [home, work]) fs.mkdirSync(dir, { recursive: true });

// 390px 下输入框「可用宽度」的下限：能完整看见一句 8 个汉字的短话（正文 15px × 8 = 120px）。
const USABLE_INPUT_MIN_PX = 120;
const NARROW_W = 390;
const NARROW_H = 844;

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function request(port, method, pathname, body, token) {
  return new Promise(resolve => {
    const raw = body == null ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method, timeout: 8000,
      headers: {
        ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}),
        ...(token ? { 'x-wcw-token': token } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* non-json */ }
        resolve({ status: response.statusCode, text, json });
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (raw) req.write(raw);
    req.end();
  });
}
async function waitForHttp(port, method, pathname, predicate, token, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    const result = await request(port, method, pathname, null, token);
    if (result && predicate(result)) return result;
    await sleep(80);
  }
  return null;
}
function killTree(child) {
  if (!child || !child.pid) return;
  try { if (process.platform === 'win32') killOwnTree(child); else child.kill('SIGKILL'); }
  catch { /* already exited */ }
}

class CdpClient {
  constructor(url) { this.url = url; this.nextId = 1; this.pending = new Map(); this.socket = null; this.listeners = new Map(); }
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
      this.socket.addEventListener('message', event => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message.id && message.method) {
          for (const fn of this.listeners.get(message.method) || []) { try { fn(message.params || {}); } catch { /* listener bug */ } }
          return;
        }
        if (!message.id || !this.pending.has(message.id)) return;
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || 'cdp error'));
        else pending.resolve(message.result || {});
      });
      this.socket.addEventListener('close', () => {
        for (const pending of this.pending.values()) pending.reject(new Error('CDP socket closed'));
        this.pending.clear();
      });
    });
  }
  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }
  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // 128c:socket 已关时 WebSocket.send() 按规范静默丢弃 —— 这个 Promise 就永远不 settle,测试挂到 run-all 超时、
      // 连一条 FAIL 都没有(F8 那批「只是超时」的偶发件就是这个形状:别的车道收尸杀了浏览器)。当场拒绝,带上方法名。
      if (!this.socket || this.socket.readyState !== 1) { const p = this.pending.get(id); this.pending.delete(id); (p ? p.reject : reject)(new Error('CDP socket not open (readyState=' + (this.socket ? this.socket.readyState : 'none') + '): ' + method)); return; }
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluate failed');
    }
    return result.result && result.result.value;
  }
  close() { try { this.socket && this.socket.close(); } catch { /* ignore */ } }
}
async function waitForTarget(port, appUrl) {
  for (let i = 0; i < 200; i++) {
    const result = await request(port, 'GET', '/json/list');
    const targets = result && Array.isArray(result.json) ? result.json : [];
    const target = targets.find(item => item.type === 'page' && String(item.url || '').startsWith(appUrl));
    if (target && target.webSocketDebuggerUrl) return target;
    await sleep(50);
  }
  return null;
}
async function waitForEval(cdp, expression, attempts = 400) {
  for (let i = 0; i < attempts; i++) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch { /* reload 会换执行上下文 */ }
    await sleep(40);
  }
  return null;
}

// ── 夹具：一个 openai 兼容端点（fake-openai.js，聊天与 ASR 桩同一个进程）──────────────────────
// 模型表里三枚 caps:['asr']：whisper-1 正常回显；upstream500 让桩回 500；emptytext 让桩回空白 text。
const PROVIDER = {
  id: 'fake', label: 'Fake', type: 'openai-compat',
  baseUrl: `http://127.0.0.1:${providerPort}`, apiKey: 'k', model: 'fake-model',
  models: [
    { id: 'fake-model', label: 'Fake' },
    { id: 'whisper-1', label: 'whisper-1', caps: ['asr'] },
    { id: 'upstream500', label: 'upstream500', caps: ['asr'] },
    { id: 'emptytext', label: 'emptytext', caps: ['asr'] },
  ],
};
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  configSchema: 11, version: '2.7.0', activeProvider: 'fake', engineMode: 'interactive',
  permissionMode: 'default', theme: 'dark', uiMode: 'pro', locale: 'zh-CN',
  defaultWorkspace: work, includeWorkbenchMcp: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  stewardEnabledV1: true,
  onboarding: { completedAt: '2026-09-17T00:00:00.000Z', version: 1, skipped: false },
  providers: [PROVIDER],
  asrProviderId: 'fake', asrModel: 'whisper-1',
}), 'utf8');

const spawnWb = () => cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(appPort)], {
  cwd: WB,
  env: { ...process.env, RUYI_HOME: home, WIN_CLAUDE_WORKBENCH_HOME: home, HOME: home, USERPROFILE: home },
  windowsHide: true, stdio: 'ignore',
});

const ZH = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));

const READY = `(() => {
  if (!window.state || !window.state.status || !window.state.config || !window.state.config.configSchema) return null;
  if (!document.getElementById('promptInput') || !document.getElementById('sendBtn') || !document.getElementById('stewardComposerSend')) return null;
  const lens = document.querySelector('#lensSeg [data-lens]');
  if (!lens || typeof lens.onclick !== 'function') return null;
  return { ready: true };
})()`;
const MICS_READY = `(() => {
  const wb = document.getElementById('composerVoiceBtn');
  const st = document.getElementById('stewardComposerVoice');
  return wb && st ? { ready: true } : null;
})()`;

// 页面里的量具：发送计数、转写请求（Content-Type／字节数／EBML 魔数）、播报流水、未捕获异常。
const INSTALL_PROBES = `(() => {
  if (window.__voiceProbe) return true;
  const probe = window.__voiceProbe = { sends: [], asr: [], announcements: [], errors: [] };
  const original = window.fetch;
  window.fetch = function (input, init) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || '');
    if (/\\/api\\/(chat\\/stream|steer|steward\\/(message|act))/.test(url)) probe.sends.push(url);
    if (url.indexOf('/api/audio/transcribe') >= 0) {
      const body = init && init.body;
      const headers = (init && init.headers) || {};
      const record = { url, contentType: String(headers['content-type'] || ''), size: body && typeof body.size === 'number' ? body.size : -1, magic: '', riff: '', wave: '', rate: 0, channels: 0, bits: 0 };
      probe.asr.push(record);
      if (body && typeof body.slice === 'function') {
        // 107-A1：读满 44 字节的 WAV 头 —— 魔数（RIFF/WAVE）＋ 声道数 ＋ 采样率 ＋ 位深都要能钉。
        body.slice(0, 44).arrayBuffer().then(buffer => {
          const bytes = new Uint8Array(buffer);
          record.magic = Array.from(bytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join('');
          const ascii = (from, to) => String.fromCharCode(...bytes.slice(from, to));
          if (bytes.length >= 44) {
            const view = new DataView(buffer);
            record.riff = ascii(0, 4);
            record.wave = ascii(8, 12);
            record.channels = view.getUint16(22, true);
            record.rate = view.getUint32(24, true);
            record.bits = view.getUint16(34, true);
          }
        }).catch(() => {});
      }
    }
    return original.apply(this, arguments);
  };
  window.addEventListener('error', event => probe.errors.push(String(event.message || 'error')));
  window.addEventListener('unhandledrejection', event => probe.errors.push('unhandled: ' + String(event.reason && (event.reason.message || event.reason))));
  const watch = node => {
    if (!node || node.__voiceWatched) return;
    node.__voiceWatched = true;
    new MutationObserver(() => {
      const text = node.textContent || '';
      if (text) probe.announcements.push({ id: node.id, text });
    }).observe(node, { childList: true, characterData: true, subtree: true });
  };
  const scan = () => { watch(document.getElementById('composerVoiceBtnStatus')); watch(document.getElementById('stewardComposerVoiceStatus')); };
  scan();
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  return true;
})()`;
const PROBE = `(() => { const p = window.__voiceProbe; return p ? { sends: p.sends.slice(), asr: p.asr.map(r => ({ ...r })), announcements: p.announcements.slice(), errors: p.errors.slice() } : null; })()`;

const PREP = (inputSel, text, caret) => `(() => {
  const box = document.querySelector(${JSON.stringify(inputSel)});
  if (!box) return null;
  box.focus();
  box.value = ${JSON.stringify(text)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  box.setSelectionRange(${caret}, ${caret});
  return { value: box.value, start: box.selectionStart, active: document.activeElement === box };
})()`;
const VOICE = sel => `(() => {
  const b = document.querySelector(${JSON.stringify(sel)});
  if (!b) return null;
  const text = b.querySelector('.composer-voice-text');
  return { state: b.dataset.state, pressed: b.getAttribute('aria-pressed'), label: b.getAttribute('aria-label'), title: b.title, text: text ? text.textContent : '' };
})()`;
const WAIT_STATE = (sel, wanted) => `(() => {
  const b = document.querySelector(${JSON.stringify(sel)});
  if (!b || b.dataset.state !== ${JSON.stringify(wanted)}) return null;
  const text = b.querySelector('.composer-voice-text');
  return { state: b.dataset.state, pressed: b.getAttribute('aria-pressed'), title: b.title, text: text ? text.textContent : '' };
})()`;
const WAIT_FILLED = (sel, inputSel, original) => `(() => {
  const b = document.querySelector(${JSON.stringify(sel)});
  const box = document.querySelector(${JSON.stringify(inputSel)});
  if (!b || !box || b.dataset.state !== 'idle' || box.value === ${JSON.stringify(original)}) return null;
  let draft = null;
  try { draft = localStorage.getItem('wcw.draft'); } catch { draft = null; }
  return { value: box.value, caret: box.selectionStart, caretEnd: box.selectionEnd, active: document.activeElement === box, pressed: b.getAttribute('aria-pressed'), draft };
})()`;
const SET_ASR = model => `(async () => {
  const select = document.querySelector('#stab-providers .asr-settings select');
  if (!select) return { error: 'no asr select' };
  const wantedModel = ${JSON.stringify(model)};
  const option = wantedModel ? Array.from(select.options).find(o => o.value.endsWith(String.fromCharCode(31) + wantedModel)) : { value: '' };
  if (!option) return { error: 'no option', options: Array.from(select.options).map(o => o.textContent) };
  select.value = option.value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (!select.disabled && String((window.state.config || {}).asrModel || '') === wantedModel) return { ok: true, asrModel: window.state.config.asrModel };
    await new Promise(r => setTimeout(r, 50));
  }
  return { error: 'timeout', asrModel: window.state.config && window.state.config.asrModel };
})()`;
const VOICE_NODES = `(() => ({
  buttons: document.querySelectorAll('.composer-voice').length,
  wbStatus: Boolean(document.getElementById('composerVoiceBtnStatus')),
  stStatus: Boolean(document.getElementById('stewardComposerVoiceStatus')),
  promptInput: Boolean(document.getElementById('promptInput')),
  sendBtn: Boolean(document.getElementById('sendBtn')),
  stewardInput: Boolean(document.getElementById('stewardComposerInput')),
  stewardSend: Boolean(document.getElementById('stewardComposerSend')),
  asr: [String(window.state.config.asrProviderId || ''), String(window.state.config.asrModel || '')],
}))()`;
const GEOMETRY = (micSel, inputSel, sendSel, boxSel) => `(() => {
  const rect = sel => {
    const n = document.querySelector(sel);
    if (!n) return null;
    const b = n.getBoundingClientRect();
    return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const mic = document.querySelector(${JSON.stringify(micSel)});
  const box = mic && mic.getBoundingClientRect();
  const hit = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
  const style = mic ? getComputedStyle(mic) : null;
  return {
    vw: document.documentElement.clientWidth,
    theme: document.documentElement.getAttribute('data-theme'),
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    mic: rect(${JSON.stringify(micSel)}), input: rect(${JSON.stringify(inputSel)}), send: rect(${JSON.stringify(sendSel)}), row: rect(${JSON.stringify(boxSel)}),
    hitMic: Boolean(hit && mic && mic.contains(hit)),
    color: style && style.color,
  };
})()`;

let provider = null, server = null, browser = null, cdp = null;
const cdpExceptions = [];
try {
  provider = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(providerPort)], { windowsHide: true, env: { ...process.env }, stdio: 'ignore' });
  ok(Boolean(await waitForHttp(providerPort, 'GET', '/v1/models', r => r.status === 200)), 'A0 fake-openai（聊天＋ASR 桩）已起');
  server = spawnWb();
  ok(Boolean(await waitForHttp(appPort, 'GET', '/health', r => r.status === 200)), 'A0b workbench started');
  const executable = findBrowserExecutable();
  ok(Boolean(executable), 'A1 Edge/Chrome found');
  if (!executable) throw new Error('browser unavailable');
  const appUrl = `http://127.0.0.1:${appPort}/`;
  browser = cp.spawn(executable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--force-device-scale-factor=1', '--window-size=1280,900',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--remote-debugging-port=' + debugPort, '--user-data-dir=' + profile, appUrl,
  ], { windowsHide: true, stdio: 'ignore' });
  const target = await waitForTarget(debugPort, appUrl);
  ok(Boolean(target), 'A2 CDP target found');
  if (!target) throw new Error('no CDP target');
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  cdp.on('Runtime.exceptionThrown', params => {
    const d = params.exceptionDetails || {};
    cdpExceptions.push({ text: String((d.exception && d.exception.description) || d.text || ''), url: String(d.url || '') });
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  ok(Boolean(await waitForEval(cdp, READY, 600)), 'A3 首屏就绪（config 已到、两个输入框都建好）');

  const env = await cdp.evaluate(`({ secure: window.isSecureContext, gum: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia), opus: MediaRecorder.isTypeSupported('audio/webm;codecs=opus'), wav: MediaRecorder.isTypeSupported('audio/wav') })`);
  ok(env && env.secure === true && env.gum === true && env.opus === true,
    `A4 显示判据的三件环境事实都成立（实得 ${JSON.stringify(env)}；audio/wav 录不了是 §1.5 的先验，这里只打印）`);
  ok(Boolean(await waitForEval(cdp, MICS_READY, 400)), 'A5 ASR 已配置 → 两个输入框里的麦克风节点都建了');

  const setLens = async lens => {
    await cdp.evaluate(`(document.querySelector('#lensSeg [data-lens="${lens}"]') || { click() {} }).click(), true`);
    return waitForEval(cdp, `(() => document.documentElement.getAttribute('data-shell-mode') === '${lens}'
      && !document.documentElement.dataset.vt ? 1 : null)()`);
  };
  // 真鼠标点元素中心。先等「中心点命中的就是它」再按 —— 切视角的 View Transition 动画期间整页的命中测试
  // 落在过渡层上（实测：切完视角立刻点，mousedown 只把焦点摘到 body、click 不发生）。
  const clickCenter = async selector => {
    const point = await waitForEval(cdp, `(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n) return null;
      n.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = n.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return hit && n.contains(hit) && document.getAnimations().every(a => a.playState !== 'running' || !(a.effect && a.effect.pseudoElement && a.effect.pseudoElement.indexOf('view-transition') >= 0)) ? { x, y } : null;
    })()`, 150);
    if (!point) return false;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    return true;
  };
  const KEYS = {
    Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
    Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  };
  const press = async name => {
    const k = KEYS[name];
    await cdp.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode, ...(k.text ? { text: k.text } : {}) });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.windowsVirtualKeyCode });
  };
  const ECHO = /\[fake-asr\] model=whisper-1 filename=voice\.wav bytes=(\d+)/;
  // 一趟「点开始 → 录 ms → 点结束 → 等回填」。返回回填后的现场与本趟新增的转写请求。
  const recordByMouse = async (micSel, inputSel, original, caret, ms) => {
    const baseline = await cdp.evaluate(PROBE);
    await cdp.evaluate(PREP(inputSel, original, caret));
    await clickCenter(micSel);
    const recording = await waitForEval(cdp, WAIT_STATE(micSel, 'recording'));
    await sleep(ms);
    const during = await cdp.evaluate(VOICE(micSel));
    await clickCenter(micSel);
    const filled = await waitForEval(cdp, WAIT_FILLED(micSel, inputSel, original), 600);
    await sleep(1200);   // 发送若被误触发，fetch 在这一拍里一定已经发出
    const after = await cdp.evaluate(PROBE);
    return { recording, during, filled, requests: after.asr.slice(baseline.asr.length), sends: after.sends.slice(baseline.sends.length), announcements: after.announcements.slice(baseline.announcements.length) };
  };
  const checkInsertion = (tag, original, caret, run, statusId) => {
    const before = original.slice(0, caret), after = original.slice(caret);
    ok(Boolean(run.recording) && run.recording.pressed === 'true',
      `${tag}a 点一下进入录音态、aria-pressed=true（实得 ${JSON.stringify(run.recording)}）`);
    ok(Boolean(run.during) && /^\d+:\d{2}$/.test(run.during.text) && run.during.text !== '0:00',
      `${tag}b 录音中可见计时 m:ss 在走（实得「${run.during && run.during.text}」）`);
    const req = run.requests[run.requests.length - 1] || null;
    // 107-A1：上传前无条件转 16 kHz 单声道 16 bit WAV（webm/opus 在 chat-audio 形上游是 400）。
    // 钉死 WAV 魔数与采样率——摘掉转码就退回 EBML 魔数 1a45dfa3 + Content-Type audio/webm，这条当场红。
    ok(run.requests.length === 1 && req && /filename=voice\.wav/.test(req.url) && req.contentType === 'audio/wav' && req.size > 44 && req.magic === '52494646',
      `${tag}c 恰好一发转写请求：filename=voice.wav、Content-Type 覆盖成 audio/wav、请求体是真 WAV（RIFF 魔数）（实得 ${JSON.stringify(run.requests)}）`);
    ok(req && req.riff === 'RIFF' && req.wave === 'WAVE' && req.rate === 16000 && req.channels === 1 && req.bits === 16,
      `${tag}c2 WAV 头就是 16 kHz／单声道／16 bit（实得 riff=${req && req.riff} wave=${req && req.wave} rate=${req && req.rate} ch=${req && req.channels} bits=${req && req.bits}）`);
    const value = run.filled ? run.filled.value : '';
    const transcript = value.startsWith(before) && value.endsWith(after) ? value.slice(before.length, value.length - after.length) : '';
    const echo = transcript.match(ECHO);
    ok(Boolean(echo) && Number(echo[1]) > 0 && req && Number(echo[1]) === req.size,
      `${tag}d 服务端收到的就是这段录音：回显 model=whisper-1 filename=voice.wav bytes=${echo ? echo[1] : '?'}（>0，且与请求体 ${req ? req.size : '?'} 字节相等）`);
    ok(Boolean(run.filled) && value === before + transcript + after && Boolean(echo) && transcript === echo[0],
      `${tag}e 回填在光标处：「${before}」＋转写＋「${after}」（实得 ${JSON.stringify(value)}）`);
    ok(Boolean(run.filled) && run.filled.caret === before.length + transcript.length && run.filled.caretEnd === run.filled.caret && run.filled.active === true && run.filled.pressed === 'false',
      `${tag}f 光标落在插入之后、焦点回到输入框、aria-pressed 翻回 false（实得 caret=${run.filled && run.filled.caret} 期望 ${before.length + transcript.length}，active=${run.filled && run.filled.active}，pressed=${run.filled && run.filled.pressed}）`);
    ok(run.sends.length === 0, `${tag}g 不自动发送：发送计数 ${run.sends.length}（${JSON.stringify(run.sends)}）`);
    const texts = run.announcements.filter(a => a.id === statusId).map(a => a.text);
    ok(texts.includes(ZH['composer.voice.recording']) && texts.includes(ZH['composer.voice.transcribing']) && texts.includes(ZH['composer.voice.inserted']),
      `${tag}h aria-live 节点依次播报「录音中／转写中／已填入」（实得 ${JSON.stringify(texts)}）`);
    return value;
  };

  await cdp.evaluate(INSTALL_PROBES);

  /* ═════════ ① 工作台输入框 ═════════ */
  ok(Boolean(await setLens('classic')), 'B0 工作台视角');
  const wbShape = await cdp.evaluate(`(() => {
    const b = document.getElementById('composerVoiceBtn');
    const live = document.getElementById('composerVoiceBtnStatus');
    return b ? {
      nextIsSend: b.nextElementSibling === document.getElementById('sendBtn'),
      host: b.parentElement.className, type: b.type, label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'),
      glyph: Boolean(b.querySelector('svg.ic')),
      live: live ? { className: live.className, role: live.getAttribute('role'), ariaLive: live.getAttribute('aria-live') } : null,
    } : null;
  })()`);
  ok(Boolean(wbShape) && wbShape.nextIsSend && wbShape.host === 'composer-actions' && wbShape.type === 'button' && wbShape.pressed === 'false' && wbShape.glyph
    && wbShape.label === ZH['composer.voice.label'] && wbShape.live && wbShape.live.className === 'sr-only' && wbShape.live.ariaLive === 'polite',
    `B1 工作台：麦克风是 .composer-actions 里紧挨 #sendBtn 前面的 <button>，字形来自 icons.js、自带 .sr-only aria-live=polite 节点（实得 ${JSON.stringify(wbShape)}）`);
  const wbText = '前缀 后缀';
  const wbRun = await recordByMouse('#composerVoiceBtn', '#promptInput', wbText, 3, 1500);
  const wbValue = checkInsertion('B2', wbText, 3, wbRun, 'composerVoiceBtnStatus');
  ok(Boolean(wbRun.filled) && wbRun.filled.draft === wbValue,
    `B3 回填派发了 input 事件：工作台输入框自己的监听器把草稿存成了新值（实得 draft=${JSON.stringify(wbRun.filled && wbRun.filled.draft)}）`);

  /* ═════════ ③ 键盘：Tab 到达、Space 开始／结束、Esc 取消 ═════════ */
  const kbText = '键盘路径';
  await cdp.evaluate(PREP('#promptInput', kbText, kbText.length));
  let tabs = 0;
  for (; tabs < 8; tabs++) {
    if (await cdp.evaluate(`document.activeElement && document.activeElement.id`) === 'composerVoiceBtn') break;
    await press('Tab');
  }
  const focusedMic = await cdp.evaluate(`document.activeElement && document.activeElement.id`);
  ok(focusedMic === 'composerVoiceBtn', `C1 从输入框按 Tab ${tabs} 下焦点落到麦克风（实得 activeElement=${focusedMic}）`);
  const kbBase = await cdp.evaluate(PROBE);
  await press('Space');
  const kbRec = await waitForEval(cdp, WAIT_STATE('#composerVoiceBtn', 'recording'));
  ok(Boolean(kbRec) && kbRec.pressed === 'true', `C2 Space 开始录音，aria-pressed=true（实得 ${JSON.stringify(kbRec)}）`);
  await sleep(1300);
  await press('Space');
  const kbFilled = await waitForEval(cdp, WAIT_FILLED('#composerVoiceBtn', '#promptInput', kbText), 600);
  await sleep(800);
  const kbAfter = await cdp.evaluate(PROBE);
  const kbAnn = kbAfter.announcements.slice(kbBase.announcements.length).map(a => a.text);
  ok(Boolean(kbFilled) && kbFilled.pressed === 'false' && kbFilled.value.startsWith(kbText) && ECHO.test(kbFilled.value.slice(kbText.length)),
    `C3 Space 结束 → 转写回填到光标处（末尾），aria-pressed=false（实得 ${JSON.stringify(kbFilled && { value: kbFilled.value, pressed: kbFilled.pressed })}）`);
  ok(kbAnn.includes(ZH['composer.voice.recording']) && kbAnn.includes(ZH['composer.voice.inserted']),
    `C4 aria-live 播报过（实得 ${JSON.stringify(kbAnn)}）`);
  ok(kbAfter.sends.length === kbBase.sends.length, `C5 键盘路径同样不自动发送（发送计数增量 ${kbAfter.sends.length - kbBase.sends.length}）`);
  // Esc：再 Tab 回麦克风、Space 开始、录到一半按 Esc。
  const escValue = kbFilled ? kbFilled.value : '';
  for (let i = 0; i < 8; i++) {
    if (await cdp.evaluate(`document.activeElement && document.activeElement.id`) === 'composerVoiceBtn') break;
    await press('Tab');
  }
  const escBase = await cdp.evaluate(PROBE);
  await press('Space');
  const escRec = await waitForEval(cdp, WAIT_STATE('#composerVoiceBtn', 'recording'));
  await sleep(700);
  await press('Escape');
  const escIdle = await waitForEval(cdp, WAIT_STATE('#composerVoiceBtn', 'idle'));
  await sleep(2000);   // 取消若没真丢弃，stop 事件之后的转写请求在这一拍里一定已经发出
  const escAfter = await cdp.evaluate(PROBE);
  const escNow = await cdp.evaluate(`document.getElementById('promptInput').value`);
  ok(Boolean(escRec) && Boolean(escIdle) && escIdle.pressed === 'false',
    `C6 录音中按 Esc → 回到空闲，aria-pressed=false（实得 ${JSON.stringify(escIdle)}）`);
  ok(escAfter.asr.length === escBase.asr.length && escNow === escValue,
    `C7 Esc 取消 = 丢弃：零转写请求（增量 ${escAfter.asr.length - escBase.asr.length}），输入框一个字不变（${escNow === escValue}）`);
  const escAnn = escAfter.announcements.slice(escBase.announcements.length).map(a => a.text);
  ok(escAnn[escAnn.length - 1] === ZH['composer.voice.cancelled'], `C8 播报「已取消」（实得 ${JSON.stringify(escAnn)}）`);

  /* ═════════ 录满 3 分钟自动结束 ═════════ */
  {
    const base = await cdp.evaluate(PROBE);
    await cdp.evaluate(PREP('#promptInput', '', 0));
    await clickCenter('#composerVoiceBtn');
    const rec = await waitForEval(cdp, WAIT_STATE('#composerVoiceBtn', 'recording'));
    await sleep(1200);
    await cdp.evaluate(`(() => { const real = performance.now.bind(performance); performance.now = () => real() + 181000; return true; })()`);
    const filled = await waitForEval(cdp, WAIT_FILLED('#composerVoiceBtn', '#promptInput', ''), 600);
    await cdp.evaluate(`(() => { delete performance.now; return typeof performance.now === 'function'; })()`);
    const after = await cdp.evaluate(PROBE);
    const ann = after.announcements.slice(base.announcements.length).map(a => a.text);
    const limitText = ZH['composer.voice.limitReached'].replace('{{minutes}}', '3');
    ok(Boolean(rec) && Boolean(filled) && ECHO.test(filled.value) && ann.includes(limitText) && after.asr.length === base.asr.length + 1 && after.sends.length === base.sends.length,
      `D1 录满 3 分钟（时钟拨快 181 s）不用再点就自动结束、转写、回填，且不发送（实得 value=${JSON.stringify(filled && filled.value)}，播报 ${JSON.stringify(ann)}）`);
  }

  /* ═════════ ⑥ 失败：上游 5xx／转写为空／麦克风被拒 ═════════ */
  {
    const exBase = cdpExceptions.length;
    const errBase = (await cdp.evaluate(PROBE)).errors.length;
    const failRun = async (tag, model, wantKey, prepare) => {
      if (model) {
        const switched = await cdp.evaluate(SET_ASR(model));
        ok(Boolean(switched && switched.ok), `${tag}0 设置页选择器切到 ${model}（实得 ${JSON.stringify(switched)}）`);
      }
      if (prepare) await cdp.evaluate(prepare);
      const original = '原样保留 不许动';
      const base = await cdp.evaluate(PROBE);
      await cdp.evaluate(PREP('#promptInput', original, 5));
      await clickCenter('#composerVoiceBtn');
      if (!prepare) {
        await waitForEval(cdp, WAIT_STATE('#composerVoiceBtn', 'recording'));
        await sleep(1300);
        await clickCenter('#composerVoiceBtn');
      }
      const errored = await waitForEval(cdp, WAIT_STATE('#composerVoiceBtn', 'error'), 600);
      await sleep(600);
      const after = await cdp.evaluate(PROBE);
      const now = await cdp.evaluate(`document.getElementById('promptInput').value`);
      const ann = after.announcements.slice(base.announcements.length).map(a => a.text);
      const want = ZH[wantKey];
      ok(Boolean(errored) && errored.title === want && errored.text === ZH['composer.voice.errorShort'] && errored.pressed === 'false',
        `${tag}1 按钮进错误态：可见短词「${errored && errored.text}」、title 是本地化原因（实得 ${JSON.stringify(errored)}）`);
      ok(ann[ann.length - 1] === want, `${tag}2 aria-live 播报「${want}」（实得 ${JSON.stringify(ann)}）`);
      ok(now === original && after.sends.length === base.sends.length,
        `${tag}3 输入框一个字不动（${JSON.stringify(now)}）、不发送（增量 ${after.sends.length - base.sends.length}）`);
      return after.asr.length - base.asr.length;
    };
    const n5xx = await failRun('E1', 'upstream500', 'composer.voice.error.upstream');
    ok(n5xx === 1, `E1-4 上游 5xx 那一趟确实发出了 1 发转写请求（实得 ${n5xx}）`);
    const nEmpty = await failRun('E2', 'emptytext', 'composer.voice.error.empty');
    ok(nEmpty === 1, `E2-4 转写为空那一趟确实发出了 1 发转写请求（实得 ${nEmpty}）`);
    const back = await cdp.evaluate(SET_ASR('whisper-1'));
    ok(Boolean(back && back.ok), `E3-0 选择器切回 whisper-1（实得 ${JSON.stringify(back)}）`);
    const nDenied = await failRun('E3', '', 'composer.voice.error.denied',
      `(() => { navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); return true; })()`);
    await cdp.evaluate(`(() => { delete navigator.mediaDevices.getUserMedia; return typeof navigator.mediaDevices.getUserMedia === 'function'; })()`);
    ok(nDenied === 0, `E3-4 麦克风被拒（桌面壳没放行麦克风是同一条路）→ 零转写请求（实得 ${nDenied}）`);
    const errAfter = (await cdp.evaluate(PROBE)).errors;
    const exNew = cdpExceptions.slice(exBase);
    ok(exNew.length === 0 && errAfter.length === errBase,
      `E4 三种失败全程零未捕获异常（CDP exceptionThrown 增量 ${JSON.stringify(exNew)}；页面 error/unhandledrejection 增量 ${JSON.stringify(errAfter.slice(errBase))}）`);
  }

  /* ═════════ ⑧ 107-A1：转码解不开 → 原样发 webm（回退不能把人卡死在「录完了发不出去」） ═════════ */
  {
    const patched = await cdp.evaluate(`(() => {
      window.__realOAC = window.OfflineAudioContext;
      window.OfflineAudioContext = function () { throw new Error('e2e: decode unavailable'); };
      window.webkitOfflineAudioContext = window.OfflineAudioContext;
      return { patched: window.OfflineAudioContext !== window.__realOAC };
    })()`);
    ok(Boolean(patched && patched.patched), 'J0 把 OfflineAudioContext 换成抛异常的桩（模拟这段字节解不开）');
    const fbText = '回退 前后';
    const fbRun = await recordByMouse('#composerVoiceBtn', '#promptInput', fbText, 3, 1500);
    const fbReq = fbRun.requests[fbRun.requests.length - 1] || null;
    ok(fbRun.requests.length === 1 && fbReq && /filename=voice\.webm/.test(fbReq.url) && fbReq.contentType === 'audio/webm' && fbReq.magic === '1a45dfa3',
      `J1 转码失败 → 原样发 webm（EBML 魔数、Content-Type 回退 audio/webm）（实得 ${JSON.stringify(fbRun.requests)}）`);
    const fbValue = fbRun.filled ? fbRun.filled.value : '';
    ok(/\[fake-asr\] model=whisper-1 filename=voice\.webm bytes=\d+/.test(fbValue) && fbValue.startsWith('回退 ') && fbValue.endsWith('前后'),
      `J2 回退路径照样转写成功并回填在光标处（实得 ${JSON.stringify(fbValue)}）`);
    const restored = await cdp.evaluate(`(() => { window.OfflineAudioContext = window.__realOAC; window.webkitOfflineAudioContext = window.__realOAC; delete window.__realOAC; return typeof window.OfflineAudioContext === 'function'; })()`);
    ok(restored === true, 'J3 还原 OfflineAudioContext');
    // 回填进去的是一长串回显文本，而草稿会跨重载留着 —— 不清掉，后面 ④ 的 390px 胶囊高度断言
    // 量到的就是「两行输入框」（实测 82px），红得跟麦克风一点关系都没有。清成空串并派发 input 让
    // 自适应高度与草稿一起回位。
    const cleared = await cdp.evaluate(`(() => {
      const box = document.getElementById('promptInput');
      if (!box) return null;
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return { value: box.value };
    })()`);
    ok(Boolean(cleared) && cleared.value === '', 'J4 清掉回填草稿（否则后面的窄屏高度断言量的是两行输入框）');
  }

  /* ═════════ ② 管家视角输入框 ═════════ */
  ok(Boolean(await setLens('steward')), 'F0 管家视角');
  const stShape = await cdp.evaluate(`(() => {
    const b = document.getElementById('stewardComposerVoice');
    const live = document.getElementById('stewardComposerVoiceStatus');
    return b ? { nextIsSend: b.nextElementSibling === document.getElementById('stewardComposerSend'), host: b.parentElement.className, pressed: b.getAttribute('aria-pressed'), live: live ? live.getAttribute('aria-live') : null } : null;
  })()`);
  ok(Boolean(stShape) && stShape.nextIsSend && stShape.host === 'steward-composer-row' && stShape.pressed === 'false' && stShape.live === 'polite',
    `F1 管家输入行：麦克风紧挨发送键前面，同样自带 aria-live 节点（实得 ${JSON.stringify(stShape)}）`);
  const stText = '前缀 后缀';
  const stRun = await recordByMouse('#stewardComposerVoice', '#stewardComposerInput', stText, 3, 1500);
  checkInsertion('F2', stText, 3, stRun, 'stewardComposerVoiceStatus');

  /* ═════════ ⑤ 双主题 × 390px ═════════ */
  const themeColors = {};
  for (const theme of ['dark', 'light']) {
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await cdp.send('Page.navigate', { url: theme === 'light' ? appUrl + '?theme=light' : appUrl });
    await sleep(300);
    ok(Boolean(await waitForEval(cdp, READY, 600)) && Boolean(await waitForEval(cdp, MICS_READY, 400)), `G0 ${theme}：重载后就绪、两枚麦克风都在`);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: NARROW_W, height: NARROW_H, deviceScaleFactor: 1, mobile: false });
    await sleep(600);
    for (const [lens, micSel, inputSel, sendSel, rowSel] of [
      ['classic', '#composerVoiceBtn', '#promptInput', '#sendBtn', '.composer-box'],
      ['steward', '#stewardComposerVoice', '#stewardComposerInput', '#stewardComposerSend', '.steward-composer-row'],
    ]) {
      ok(Boolean(await setLens(lens)), `G1 ${theme}/${lens} 视角`);
      await sleep(400);
      const idle = await cdp.evaluate(GEOMETRY(micSel, inputSel, sendSel, rowSel));
      if (lens === 'classic') themeColors[theme] = idle && idle.color;
      ok(Boolean(idle) && idle.vw === NARROW_W && idle.theme === theme && idle.overflow <= 1,
        `G2 ${theme}/${lens}：视口 ${idle && idle.vw}px、data-theme=${idle && idle.theme}、整页横向溢出 ${idle && idle.overflow}px`);
      ok(Boolean(idle && idle.mic) && idle.mic.w >= 30 && idle.mic.h >= 30 && idle.mic.l >= 0 && idle.mic.r <= idle.vw && idle.hitMic && idle.send && idle.send.r <= idle.vw,
        `G3 ${theme}/${lens}：麦克风看得见、点得中（mic ${JSON.stringify(idle && idle.mic)}，send ${JSON.stringify(idle && idle.send)}，中心命中 ${idle && idle.hitMic}）`);
      ok(Boolean(idle && idle.input) && idle.input.w >= USABLE_INPUT_MIN_PX,
        `G4 ${theme}/${lens}：输入框可用宽度 ${idle && idle.input && idle.input.w}px ≥ ${USABLE_INPUT_MIN_PX}px（行 ${JSON.stringify(idle && idle.row)}）`);
      // 录音态会多出 m:ss，按钮变宽 —— 输入框仍不能被挤没。
      await clickCenter(micSel);
      const rec = await waitForEval(cdp, WAIT_STATE(micSel, 'recording'));
      await sleep(1200);
      const busy = await cdp.evaluate(GEOMETRY(micSel, inputSel, sendSel, rowSel));
      await press('Escape');
      const back = await waitForEval(cdp, WAIT_STATE(micSel, 'idle'));
      ok(Boolean(rec) && Boolean(back) && Boolean(busy && busy.input && busy.mic) && busy.input.w >= USABLE_INPUT_MIN_PX && busy.mic.w > idle.mic.w && busy.mic.r <= busy.vw && busy.overflow <= 1,
        `G5 ${theme}/${lens}：录音态麦克风变宽到 ${busy && busy.mic && busy.mic.w}px（空闲 ${idle && idle.mic && idle.mic.w}px），输入框仍有 ${busy && busy.input && busy.input.w}px、横向溢出 ${busy && busy.overflow}px；Esc 收回`);
    }
  }
  ok(Boolean(themeColors.dark) && Boolean(themeColors.light) && themeColors.dark !== themeColors.light,
    `G6 两套主题的麦克风字形色确实不同（dark ${themeColors.dark} ／ light ${themeColors.light}）—— 走的是主题 token，不是写死的色`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* ═════════ ④ 未配置：节点结构上不存在 ═════════ */
  await sleep(300);
  const unset = await cdp.evaluate(SET_ASR(''));
  ok(Boolean(unset && unset.ok), `H0 设置页选择器切到「不启用」（实得 ${JSON.stringify(unset)}）`);
  const gone = await waitForEval(cdp, `(() => document.querySelectorAll('.composer-voice').length === 0 ? 1 : null)()`, 200);
  const goneNodes = await cdp.evaluate(VOICE_NODES);
  ok(Boolean(gone) && goneNodes.buttons === 0 && !goneNodes.wbStatus && !goneNodes.stStatus && goneNodes.sendBtn && goneNodes.stewardSend,
    `H1 ASR 关掉 → 两个输入框里的麦克风与播报节点当场被拆（发送键都在）（实得 ${JSON.stringify(goneNodes)}）`);
  await cdp.send('Page.navigate', { url: appUrl });
  await sleep(300);
  ok(Boolean(await waitForEval(cdp, READY, 600)), 'H2 重载后就绪');
  await sleep(1500);   // config 到达后的 syncComposerVoices 早就跑过了；再给一拍余量
  const coldNodes = await cdp.evaluate(VOICE_NODES);
  ok(coldNodes.buttons === 0 && !coldNodes.wbStatus && !coldNodes.stStatus && coldNodes.promptInput && coldNodes.stewardInput
    && coldNodes.asr[0] === '' && coldNodes.asr[1] === '',
    `H3 未配置冷启动：两个输入框都在，麦克风节点一个都没有（实得 ${JSON.stringify(coldNodes)}）`);
  // 390px 两行折叠只挂在「胶囊里真有麦克风」上（:has）：未配置时工作台胶囊仍是原来那一行 50px。
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: NARROW_W, height: NARROW_H, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  ok(Boolean(await setLens('classic')), 'H4a 未配置 × 390px 工作台视角');
  await sleep(400);
  const coldRow = await cdp.evaluate(`(() => {
    const box = document.querySelector('.composer-box').getBoundingClientRect();
    const input = document.getElementById('promptInput').getBoundingClientRect();
    return { rowH: Math.round(box.height), rowW: Math.round(box.width), inputW: Math.round(input.width), wrap: getComputedStyle(document.querySelector('.composer-box')).flexWrap };
  })()`);
  ok(Boolean(coldRow) && coldRow.rowH === 50 && coldRow.wrap === 'nowrap',
    `H4 未配置时 390px 工作台胶囊不折行、仍是一行 50px（实得 ${JSON.stringify(coldRow)}）—— 两行折叠只因麦克风而生`);
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  const voiceExceptions = cdpExceptions.filter(e => /composer-voice/.test(e.text + ' ' + e.url));
  ok(voiceExceptions.length === 0, `Z1 全程 composer-voice.js 零未捕获异常（实得 ${JSON.stringify(voiceExceptions)}）`);

  console.log('\nCOMPOSER VOICE BROWSER E2E: ' + (fail === 0 ? 'ALL PASS' : `FAIL (${fail})`));
} catch (e) {
  console.error('E2E ERROR', e && e.stack || e);
  fail++;
  console.log('\nCOMPOSER VOICE BROWSER E2E: FAIL (error)');
} finally {
  if (cdp) cdp.close();
  killTree(browser);
  killTree(server);
  killTree(provider);
  await sleep(300);
  try { stopRuyiTestBrowsers(profile); } catch { /* ignore */ }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(fail === 0 ? 0 : 1);
}
})();
