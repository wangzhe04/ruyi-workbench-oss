'use strict';

// 第127波 ⑦ 114c-①（45 号文 §2-quinquies「⑦ 麦克风：落点定案」／§4 ⑦；26 号文 §2「转写只回填，不替用户点发送」）：
// 输入框麦克风。两个视角各挂一枚 —— 工作台 .composer-actions 里 #sendBtn 之前、管家输入行里发送键之前 ——
// 实现只有这一份。
//
// 为什么单独成模块：app.js 离行数护栏只剩十来行（steward-walkthrough.static ≤1279）；steward-composer.js
// 钉着「恰好一处 setTimeout、零 setInterval」（steward-conversation.static I3/I4）—— 录音计时器放不进去。
// 所以计时、录音、转写、回填全住这里，两处挂载各两行。
//
// 边界（逐条对应落点定案）：
//   ① 零静态标记。节点只在四件事同时成立时才建（composerVoiceAvailable）：config.asrProviderId 与
//      config.asrModel 皆非空（26 号文冻结边界：未配置＝不可见）／安全上下文／navigator.mediaDevices／
//      MediaRecorder 支持 audio/webm;codecs=opus。45 号文 §1.5 实测这版 Edge 上 audio/wav 录不了，所以
//      webm/opus 是唯一录制格式，不支持就不出按钮，不写一条跑不通的回退。配置变了由组合根调
//      syncComposerVoices() 重判；语音识别被关掉时按钮连同播报节点一起拆掉（结构上不存在，不是藏起来）。
//   ② 交互：点一下开始、再点一下结束（原生 <button>，Space／Enter 天然可达）；录音中 Esc 取消（丢弃、
//      不转写）；aria-pressed 跟录音态走；满 COMPOSER_VOICE_MAX_MS（3 分钟，主会话定的工程默认）自动结束。
//   ③ 转写：POST /api/audio/transcribe?filename=voice.webm，原始 Blob 作请求体，走 net.js 的 apiRaw。
//      必须覆盖 apiRaw 默认的 JSON content-type，否则服务端 400 asr.content_type。apiRaw 遇 403
//      auth.token_invalid 会换 token 重放一次 —— 对 Blob 体是安全的：Blob 可重复读，第二次 fetch 重新取流
//      （不是一次性的 ReadableStream 体）。
//   ④ 回填：照 file-browser.js mentionFile 的模具在光标处拼接（替换选区，不是追加到末尾）→ 光标落到插入
//      之后 → 聚焦 → 派发 input 事件。自适应高度、草稿保存、发送键状态、管家的输入即预判都挂在各自输入框
//      的 input 监听上，这里一处不抄。**永不自动发送。**
//   ⑤ 失败：拿不到麦克风（拒绝授权／没有设备／桌面壳没放行麦克风 —— 那是 114e，已后置 128+）、转写 4xx/5xx、
//      转写为空：只播报一句本地化人话并把按钮置成错误态；输入框里的字一个不动，不抛。
//   ⑥ 播报：每枚按钮自带一个 .sr-only 的 aria-live="polite" 节点（录音中／转写中／已填入／已取消／失败）。
//   ⑦ 隐私：录音数据只在内存里走一趟请求，不落本机存储（26 号文 §4「录音数据不持久化」）。

import { apiRaw, apiErrorInfo } from './net.js';
import { icon } from './icons.js';

export const COMPOSER_VOICE_MIME = 'audio/webm;codecs=opus';   // 唯一录制格式（§1.5 实测）
export const COMPOSER_VOICE_UPLOAD_TYPE = 'audio/webm';        // 上传时的 Content-Type（服务端只认 audio/*）
export const COMPOSER_VOICE_FILENAME = 'voice.webm';
export const COMPOSER_VOICE_MAX_MS = 3 * 60 * 1000;            // 录满 3 分钟自动结束
const COMPOSER_VOICE_TICK_MS = 500;                            // 计时显示与「满时自动结束」共用这一拍

// 转写失败码 → 人话键。表外的码（含网络层异常）一律落到 error.failed，不把服务端原文搬上屏。
const TRANSCRIBE_ERROR_KEYS = Object.freeze({
  'asr.not_configured': 'composer.voice.error.notConfigured',
  'asr.provider_missing': 'composer.voice.error.notConfigured',
  'asr.too_large': 'composer.voice.error.tooLarge',
  'asr.upstream': 'composer.voice.error.upstream',
  'asr.upstream_unreachable': 'composer.voice.error.upstream',
  'asr.bad_response': 'composer.voice.error.upstream',
});

// getUserMedia 的拒绝原因 → 人话键。
function micErrorKey(error) {
  const name = String((error && error.name) || '');
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'composer.voice.error.denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'composer.voice.error.noDevice';
  return 'composer.voice.error.mic';
}

// 显示判据（①）。env 默认是页面全局；纯函数，便于静态件直接调用。
export function composerVoiceAvailable(config, env = globalThis) {
  if (!config || !String(config.asrProviderId || '').trim() || !String(config.asrModel || '').trim()) return false;
  if (!env || env.isSecureContext !== true) return false;
  const nav = env.navigator;
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') return false;
  const Recorder = env.MediaRecorder;
  return Boolean(Recorder && typeof Recorder.isTypeSupported === 'function' && Recorder.isTypeSupported(COMPOSER_VOICE_MIME));
}

export function formatVoiceElapsed(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
}

// 挂着的实例（两个视角各一枚）。配置变更与界面语言变更都按这张表逐个重判／重画。
const voices = new Set();
let i18nBound = false;
function bindI18nOnce() {
  if (i18nBound || typeof globalThis.addEventListener !== 'function') return;
  i18nBound = true;
  globalThis.addEventListener('i18n:change', () => { for (const voice of voices) voice.relabel(); });
}

// 组合根在「全局配置变了」那一处调（provider-settings.js 的 onEngineConfigChanged 注入口）。
export function syncComposerVoices() {
  for (const voice of voices) voice.sync();
}

const now = () => (globalThis.performance && typeof globalThis.performance.now === 'function'
  ? globalThis.performance.now()
  : Date.now());

export function createComposerVoice({
  state = null,
  t = key => key,
  id = '',
  input = () => null,    // 输入框取件函数（节点可能晚于本工厂才建）
  anchor = () => null,   // 麦克风插在它前面（发送键）
  request = apiRaw,
} = {}) {
  let button = null;
  let label = null;
  let live = null;
  let phase = 'idle';        // idle | starting | recording | transcribing | error
  let errorKey = '';
  let attempt = 0;           // 每次开始／取消 +1：拿到麦克风时发现不是这一次了，就把轨道放掉
  let recorder = null;
  let stream = null;
  let chunks = [];
  let discard = false;
  let startedAt = 0;
  let ticker = 0;
  let escapeBound = false;

  function announce(text) {
    if (live) live.textContent = text;
  }

  function paint() {
    if (!button) return;
    button.dataset.state = phase;
    button.setAttribute('aria-pressed', String(phase === 'starting' || phase === 'recording'));
    button.setAttribute('aria-disabled', String(phase === 'transcribing'));
    // 可访问名恒定（切换按钮的名字不随按下态变，按下与否由 aria-pressed 说）；提示与可见文字随阶段变。
    button.setAttribute('aria-label', t('composer.voice.label'));
    if (phase === 'error' && errorKey) button.title = t(errorKey);
    else if (phase === 'recording' || phase === 'starting') button.title = t('composer.voice.stop');
    else if (phase === 'transcribing') button.title = t('composer.voice.transcribing');
    else button.title = t('composer.voice.hint');
    if (!label) return;
    if (phase === 'recording') label.textContent = formatVoiceElapsed(now() - startedAt);
    else if (phase === 'transcribing') label.textContent = '…';
    else if (phase === 'error') label.textContent = t('composer.voice.errorShort');
    else label.textContent = '';
  }

  function clearTicker() {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = 0;
  }

  function onEscape(event) {
    if (event.key !== 'Escape' || event.isComposing) return;
    if (phase !== 'recording' && phase !== 'starting') return;
    // 录音中的 Esc 只做「取消录音」这一件事：不再往下传给工作台的全局 Esc（关抽屉／停回合）或管家的 Esc 栈。
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
  }
  function bindEscape(on) {
    if (on && !escapeBound) { globalThis.addEventListener('keydown', onEscape, true); escapeBound = true; }
    else if (!on && escapeBound) { globalThis.removeEventListener('keydown', onEscape, true); escapeBound = false; }
  }

  function releaseTracks(media) {
    if (!media || typeof media.getTracks !== 'function') return;
    for (const track of media.getTracks()) {
      try { track.stop(); } catch { /* 轨道已经停了 */ }
    }
  }
  function cleanupRecording() {
    clearTicker();
    releaseTracks(stream);
    stream = null;
    recorder = null;
    chunks = [];
    discard = false;
  }

  function fail(key) {
    clearTicker();
    bindEscape(false);
    errorKey = key;
    phase = 'error';
    paint();
    announce(t(key));
  }

  async function start() {
    const mine = ++attempt;
    errorKey = '';
    phase = 'starting';
    bindEscape(true);
    paint();
    let media = null;
    try {
      media = await globalThis.navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      if (mine !== attempt) return;
      fail(micErrorKey(error));
      return;
    }
    if (mine !== attempt || phase !== 'starting') { releaseTracks(media); return; }
    let next = null;
    try {
      next = new globalThis.MediaRecorder(media, { mimeType: COMPOSER_VOICE_MIME });
      next.addEventListener('dataavailable', event => { if (event.data && event.data.size > 0) chunks.push(event.data); });
      next.addEventListener('stop', () => { void finish(); });
      stream = media;
      recorder = next;
      chunks = [];
      discard = false;
      next.start();
    } catch {
      releaseTracks(media);
      stream = null;
      recorder = null;
      fail('composer.voice.error.mic');
      return;
    }
    startedAt = now();
    phase = 'recording';
    ticker = setInterval(tick, COMPOSER_VOICE_TICK_MS);
    paint();
    announce(t('composer.voice.recording'));
  }

  function tick() {
    if (phase !== 'recording') return;
    if (now() - startedAt >= COMPOSER_VOICE_MAX_MS) {
      announce(t('composer.voice.limitReached', { minutes: Math.round(COMPOSER_VOICE_MAX_MS / 60000) }));
      stop();
      return;
    }
    // 按钮已不在屏上（被拆掉、或所在视角被收起）还在录，就是在偷录 —— 当场取消。
    if (!button || !button.isConnected || (typeof button.checkVisibility === 'function' && !button.checkVisibility())) {
      cancel();
      return;
    }
    paint();
  }

  function stop() {
    if (phase !== 'recording' || !recorder) return;
    clearTicker();
    bindEscape(false);
    phase = 'transcribing';
    paint();
    try { recorder.stop(); }
    catch { cleanupRecording(); fail('composer.voice.error.mic'); }
  }

  function cancel() {
    attempt += 1;
    bindEscape(false);
    if (phase === 'starting') {
      phase = 'idle';
      paint();
      announce(t('composer.voice.cancelled'));
      return;
    }
    if (phase !== 'recording') return;
    clearTicker();
    discard = true;
    phase = 'idle';
    paint();
    announce(t('composer.voice.cancelled'));
    try { recorder.stop(); }
    catch { cleanupRecording(); }
  }

  // MediaRecorder 的 stop 事件之后：块已经全部冲出来了。
  async function finish() {
    const parts = chunks;
    const dropped = discard;
    cleanupRecording();
    bindEscape(false);   // 轨道自己断掉（设备被拔）也会走到这里，不能把 Esc 监听留在身后
    if (dropped) return;
    const blob = new Blob(parts, { type: COMPOSER_VOICE_MIME });
    if (!blob.size) { fail('composer.voice.error.empty'); return; }
    phase = 'transcribing';
    paint();
    announce(t('composer.voice.transcribing'));
    let text = '';
    try {
      const res = await request('/api/audio/transcribe?filename=' + COMPOSER_VOICE_FILENAME, {
        method: 'POST',
        body: blob,
        headers: { 'content-type': COMPOSER_VOICE_UPLOAD_TYPE },
      });
      if (!res.ok) {
        let raw = '';
        try { raw = await res.text(); } catch { raw = ''; }
        const info = apiErrorInfo(new Error(raw));
        fail(TRANSCRIBE_ERROR_KEYS[info.code] || 'composer.voice.error.failed');
        return;
      }
      const body = await res.json();
      text = String((body && body.text) || '').trim();
    } catch {
      fail('composer.voice.error.failed');
      return;
    }
    if (!text) { fail('composer.voice.error.empty'); return; }
    const box = input();
    if (!box) { phase = 'idle'; paint(); return; }
    insertAtCursor(box, text);
    phase = 'idle';
    paint();
    announce(t('composer.voice.inserted'));
  }

  // ④ 照 file-browser.js mentionFile：selectionStart/End 拼接 → setSelectionRange → focus；
  // 自适应高度与草稿保存由派发的 input 事件交给输入框自己的监听器。
  function insertAtCursor(box, text) {
    const value = String(box.value || '');
    const start = box.selectionStart ?? value.length;
    const end = box.selectionEnd ?? value.length;
    box.value = value.slice(0, start) + text + value.slice(end);
    const position = start + text.length;
    try { box.setSelectionRange(position, position); } catch { /* 不支持选区的宿主 */ }
    box.focus();
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onClick() {
    if (phase === 'transcribing') return;
    if (phase === 'recording') { stop(); return; }
    if (phase === 'starting') { cancel(); return; }   // 授权框迟迟不回（桌面壳）时，再点一下就是不录了
    void start();
  }

  function build() {
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'composer-voice';
    if (id) button.id = id;
    const glyph = icon('mic', 16);
    if (glyph) button.appendChild(glyph);
    label = document.createElement('span');
    label.className = 'composer-voice-text';
    label.setAttribute('aria-hidden', 'true');
    button.appendChild(label);
    button.addEventListener('click', onClick);
    live = document.createElement('span');
    live.className = 'sr-only';
    if (id) live.id = id + 'Status';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    if (phase === 'error') { phase = 'idle'; errorKey = ''; }
  }

  function teardown() {
    if (!button) return;
    if (phase === 'recording' || phase === 'starting') cancel();
    bindEscape(false);
    button.remove();
    if (live) live.remove();
    button = null;
    label = null;
    live = null;
  }

  // ① 重判：该有就建（插在发送键前、播报节点挂在同一个容器末尾），不该有就拆。
  function sync() {
    const box = input();
    const before = anchor();
    const host = before && before.parentNode;
    if (!box || !host || !composerVoiceAvailable(state && state.config)) { teardown(); return false; }
    if (!button) build();
    if (button.parentNode !== host || button.nextSibling !== before) host.insertBefore(button, before);
    if (live.parentNode !== host) host.appendChild(live);
    paint();
    return true;
  }

  const handle = Object.freeze({
    sync,
    relabel: paint,
    cancel,
    phase: () => phase,
  });
  voices.add(handle);
  bindI18nOnce();
  return handle;
}
