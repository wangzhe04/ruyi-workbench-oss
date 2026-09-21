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
//   ③ 转写：POST /api/audio/transcribe?filename=voice.wav，Blob 作请求体，走 net.js 的 apiRaw。
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
//   ⑧ 107-A1（45 号文 §9.6.3 真机实测）：上传前**无条件**把 webm/opus 解码成 16 kHz 单声道 16 bit PCM，
//      自己拼 WAV 头再发。为什么无条件：前端不该知道这台配的是哪种转写协议（provider.asrProtocol 是
//      服务端的事），而 Whisper 形端点一样收 wav —— 只有一条路就没有分叉可错。MiMo 实测直接 400 拒收
//      webm（「input_audio.data mime type must be one of: audio/wav, audio/mpeg, audio/mp3」），而麦克风
//      今天只录得出 webm/opus（§1.5：这版 Edge 上 audio/wav 录不了）。解码失败原样发 webm —— 录完了
//      发不出去，比「协议不对」更坏。
//   ⑨ 边说边出字（用户 2026-09-20：「希望在语音输入的同时，文字自动浮现在打字框上」，拍板方案一「按停顿切段」）：
//      录音中侦听响度，说过话之后停顿满 COMPOSER_VOICE_PAUSE_MS 就把这一段切下来先送去转写，字按顺序落进输入框，
//      麦克风继续录。每一秒音频仍然只转写一次 —— 费用与整段转写相同（不是「每隔几秒把整段重发」那种越录越贵的做法）。
//      不到 COMPOSER_VOICE_SEGMENT_MIN_MS 的短录音不切，行为与从前逐字节相同；宿主没有 AudioContext 时同样不切。
//      走的仍是 ③ 那一条转写接口，对服务商零新增要求；②「永不自动发送」、⑦「不落盘」不变。
//      Esc 取消＝还没转出来的都不要；已经落进输入框的字不往回收。转写这条路不通时当场停录并说清原因。

import { apiRaw, apiErrorInfo } from './net.js';
import { icon } from './icons.js';
import { toast } from './util.js';

export const COMPOSER_VOICE_MIME = 'audio/webm;codecs=opus';   // 唯一录制格式（§1.5 实测）
export const COMPOSER_VOICE_UPLOAD_TYPE = 'audio/webm';        // 转码失败时的回退 Content-Type
export const COMPOSER_VOICE_FILENAME = 'voice.webm';           // 同上：回退时的文件名
export const COMPOSER_VOICE_WAV_TYPE = 'audio/wav';            // ⑧ 正常路径的上传 Content-Type
export const COMPOSER_VOICE_WAV_FILENAME = 'voice.wav';
export const COMPOSER_VOICE_SAMPLE_RATE = 16000;               // ⑧ 16 kHz 单声道：ASR 上游的通用口味
export const COMPOSER_VOICE_MAX_MS = 3 * 60 * 1000;            // 录满 3 分钟自动结束
const COMPOSER_VOICE_TICK_MS = 500;                            // 计时显示与「满时自动结束」共用这一拍
// ⑨ 边说边出字（按停顿切段）。四个数都是工程默认：
export const COMPOSER_VOICE_CONTEXT_CHARS = 600;               // 133a：句尾改错带的前文最多这么多字（服务端同一上限）
export const COMPOSER_VOICE_PAUSE_MS = 700;                    // 停这么久算「一句说完」
export const COMPOSER_VOICE_SEGMENT_MIN_MS = 2000;             // 一段至少这么长才切（太碎的段转写不准，也多出网）
export const COMPOSER_VOICE_SEGMENT_MAX_MS = 30000;            // 一口气说这么久还没停顿就硬切一刀
const COMPOSER_VOICE_VAD_TICK_MS = 100;                        // 响度多久看一次
const COMPOSER_VOICE_VAD_MIN_RMS = 0.012;                      // 判「在说话」的响度下限（另有随底噪浮动的门限，取大的）

// 转写失败码 → 人话键。表外的码（含网络层异常）一律落到 error.failed，不把服务端原文搬上屏。
const TRANSCRIBE_ERROR_KEYS = Object.freeze({
  'asr.not_configured': 'composer.voice.error.notConfigured',
  'asr.provider_missing': 'composer.voice.error.notConfigured',
  'asr.too_large': 'composer.voice.error.tooLarge',
  'asr.upstream': 'composer.voice.error.upstream',
  'asr.upstream_unreachable': 'composer.voice.error.upstream',
  'asr.bad_response': 'composer.voice.error.upstream',
});

// 2026-09-20（用户实报「点了语音输入收不到字，怀疑没录上音」）：真因是服务商的接口类型选错了 —— 上游 404。
// 修前这类失败只落在按钮的悬停提示与读屏播报里，看得见的只有「未成功」三个字，人自然会去怀疑麦克风。
// 两件事：① 失败原因用 toast 直接说出来（fail 里）；② 上游 404/405 单独成一句 —— 「稍后再试」对它是句假话，
// 再试一万次也是 404，该做的是去设置里换接口类型。模型名不对（上游 400/500）说不准是哪一种，仍走通用那句。
function transcribeErrorKey(info) {
  const status = Number(info && info.params && info.params.status) || 0;
  if (info && info.code === 'asr.upstream' && (status === 404 || status === 405)) return 'composer.voice.error.protocol';
  if (info && info.code === 'asr.upstream' && (status === 401 || status === 403)) return 'composer.voice.error.auth';   // 密钥不对／没开通：同样不是「稍后再试」能好的
  return TRANSCRIBE_ERROR_KEYS[info && info.code] || 'composer.voice.error.failed';
}

// getUserMedia 的拒绝原因 → 人话键。
function micErrorKey(error) {
  const name = String((error && error.name) || '');
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'composer.voice.error.denied';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'composer.voice.error.noDevice';
  return 'composer.voice.error.mic';
}

// 128f-⑭（用户 2026-09-19：「前端并没有语音输入和语音转文字的入口」；拍板 A「未配置也显示，点它去设置里开启」）：
// 修前 ① 把两件事并成一个判据 ——「这台环境录不录得了」与「语音识别配没配」—— 没配就结构上不存在；而设置页那一栏
// 又只在某个模型被标成「可语音识别」时才出现，界面上【没有任何地方】能标它（只能手改 config.json）。于是一台正常
// 装好的机器上，语音入口一个都看不见。现在拆开：录不了（非安全上下文／没有 mediaDevices／录不了 webm/opus）照旧
// 不出按钮 —— 点了也录不了；录得了但没配置，出一枚【待开启】的灰按钮（data-state="setup"），点它派
// COMPOSER_VOICE_SETUP_EVENT，组合根打开设置页、定位到「语音识别」那一栏（那一栏现在无候选也渲染，并带「添加」口）。
export const COMPOSER_VOICE_SETUP_EVENT = 'ruyi:open-voice-settings';
export function composerVoiceConfigured(config) {
  return Boolean(config && String(config.asrProviderId || '').trim() && String(config.asrModel || '').trim());
}
// 130（51 号文 §2.3；用户拍板：校正默认静默替换、第一版只做麦克风）：流式路。配了实时识别就走它 ——
// AudioContext 取 PCM、重采样到 16 kHz、每 250 ms 一块 POST 到 /api/audio/stream/…；回包的 partial 作临时文字落在
// 输入框，final 一句定稿；定稿的每一句再把它的音频送 /api/audio/transcribe（第二遍：Qwen3-ASR／云端，配了才做），
// 回来的文本不同、且输入框里这一段还没被人碰过 → 静默换掉。没配实时识别／组件没起来 → 原样走上面的按停顿切段。
export const COMPOSER_VOICE_STREAM_CHUNK_MS = 250;        // 多久送一块（手机体验同量级；再小只会多打 HTTP）
export const COMPOSER_VOICE_CORRECT_MIN_MS = 300;         // 太短的一句不值得跑第二遍
export function composerVoiceStreamConfigured(config) {
  return Boolean(config && String(config.asrStreamProviderId || '').trim() && String(config.asrStreamModel || '').trim());
}
// 131b（52 号文 §5；用户拍板 2）：句尾改错有两条路 —— 重听音频（整段识别模型）与大模型改字（跟随对话主端点或单独指定）。
// 这两个纯函数只回答「要不要发第二遍」「要不要带音频」；发去 /api/audio/correct 之后怎么走由服务端按 asrFixMode 编排。
export function composerVoiceFixLlmAvailable(config) {
  const id = String((config && (config.asrFixProviderId || config.activeProvider)) || '').trim();
  return Boolean(id && id !== 'claude-cli' && !id.startsWith('toolbox-'));
}
export function composerVoiceCorrectConfigured(config) {
  if (!config) return false;
  const mode = String(config.asrFixMode || 'auto');
  if (mode === 'off') return false;
  if (mode === 'audio') return composerVoiceConfigured(config);
  if (mode === 'llm') return composerVoiceFixLlmAvailable(config);
  return composerVoiceConfigured(config) || composerVoiceFixLlmAvailable(config);
}
export function composerVoiceCorrectWantsAudio(config) {
  return Boolean(config) && String(config.asrFixMode || 'auto') !== 'llm' && composerVoiceConfigured(config);
}
// 流式路的文字拼接（纯函数，静态件直接调）：句与句之间只在两侧都是拉丁字母／数字时加空格（中文之间不加）。
export function streamJoin(parts) {
  let out = '';
  for (const p of parts) {
    const s = String(p || '');
    if (!s) continue;
    out += (out && /[A-Za-z0-9]$/.test(out) && /^[A-Za-z0-9]/.test(s) ? ' ' : '') + s;
  }
  return out;
}
// 把输入框里本次录音写下的那一段（region）整体换成新文本。那一段已被用户碰过（值不再逐字相同）就回 null —— 调用方从此停手，
// 这正是「静默替换只动没碰过的字」的判据。
export function replaceStreamRegion(value, region, rendered, next) {
  const v = String(value || '');
  if (!region || v.slice(region.start, region.end) !== String(rendered || '')) return null;
  const text = String(next || '');
  return { value: v.slice(0, region.start) + text + v.slice(region.end), region: { start: region.start, end: region.start + text.length } };
}
// 线性插值重采样到 16 kHz（语音识别的口味；每块独立算，块边界的那一点点不连续对识别无感）。
export function resampleTo16k(input, rate) {
  if (!input || !input.length) return new Float32Array(0);
  if (rate === COMPOSER_VOICE_SAMPLE_RATE) return Float32Array.from(input);
  const ratio = rate / COMPOSER_VOICE_SAMPLE_RATE;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(input.length - 1, i0 + 1), f = pos - i0;
    out[i] = input[i0] * (1 - f) + input[i1] * f;
  }
  return out;
}
function concatFloat(chunks, total) {
  const out = new Float32Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
export function composerVoiceCapable(env = globalThis) {
  if (!env || env.isSecureContext !== true) return false;
  const nav = env.navigator;
  if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function') return false;
  const Recorder = env.MediaRecorder;
  return Boolean(Recorder && typeof Recorder.isTypeSupported === 'function' && Recorder.isTypeSupported(COMPOSER_VOICE_MIME));
}
// 显示判据（①）：配好了、且录得了 —— 这时才是一枚能录的麦克风（idle 起步）。env 默认是页面全局；纯函数，便于静态件直接调用。
export function composerVoiceAvailable(config, env = globalThis) {
  if (!config || !String(config.asrProviderId || '').trim() || !String(config.asrModel || '').trim()) return false;
  return composerVoiceCapable(env);
}

// ⑧ 16 bit 单声道 WAV 打包：44 字节规范头 + 小端 PCM。浮点样本钳到 [-1,1] 再按有符号 16 位量化
// （负半轴 ×0x8000、正半轴 ×0x7fff —— 两边各自打满且不溢出）。
// 131b：一句的 WAV 以 base64 放进 /api/audio/correct 的 JSON 体（与第一遍文字同一个请求）。FileReader 走 data URL，剥掉前缀。
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error('read failed'));
    reader.onload = () => { const s = String(reader.result || ''); const at = s.indexOf(','); resolve(at >= 0 ? s.slice(at + 1) : s); };
    reader.readAsDataURL(blob);
  });
}
function wavBlobFromPcm(samples, sampleRate) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true);   // fmt 子块长度（PCM 恒 16）
  view.setUint16(20, 1, true);                       // 音频格式 1 = 未压缩 PCM
  view.setUint16(22, 1, true);                       // 声道数 = 1
  view.setUint32(24, sampleRate, true);              // 采样率
  view.setUint32(28, sampleRate * 2, true);          // 字节率 = 采样率 × 块对齐
  view.setUint16(32, 2, true);                       // 块对齐 = 1 声道 × 16 bit
  view.setUint16(34, 16, true);                      // 位深
  ascii(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([bytes], { type: COMPOSER_VOICE_WAV_TYPE });
}

// ⑧ 录音 Blob → 16 kHz 单声道 WAV Blob。解不开（宿主没有 OfflineAudioContext、字节不是能解的音频、
// 空音轨）一律回 null，调用方原样发原 Blob。3 分钟满录约 5.7 MB（16000 × 2 × 180），仍在服务端 25 MB 闸内。
export async function encodeVoiceWav(blob, env = globalThis) {
  const Ctx = env && (env.OfflineAudioContext || env.webkitOfflineAudioContext);
  if (!Ctx || !blob || typeof blob.arrayBuffer !== 'function') return null;
  let rendered = null;
  try {
    const bytes = await blob.arrayBuffer();
    // 解码上下文本身就按目标采样率建：Chromium 的 decodeAudioData 会顺手重采样到本上下文的速率，
    // 真重采样了下面那趟离线渲染就跳过；宿主不这么做时照样由离线渲染补上（两条都落到 16 kHz 单声道）。
    let decoded = await new Ctx(1, 1, COMPOSER_VOICE_SAMPLE_RATE).decodeAudioData(bytes);
    if (!decoded || !decoded.length) return null;
    if (decoded.sampleRate !== COMPOSER_VOICE_SAMPLE_RATE || decoded.numberOfChannels !== 1) {
      const frames = Math.max(1, Math.round(decoded.duration * COMPOSER_VOICE_SAMPLE_RATE));
      const offline = new Ctx(1, frames, COMPOSER_VOICE_SAMPLE_RATE);
      const source = offline.createBufferSource();
      source.buffer = decoded;                 // 多声道 → 单声道由 destination 的 1 通道自动下混
      source.connect(offline.destination);
      source.start();
      decoded = await offline.startRendering();
    }
    rendered = decoded.getChannelData(0);
  } catch { return null; }
  if (!rendered || !rendered.length) return null;
  return wavBlobFromPcm(rendered, COMPOSER_VOICE_SAMPLE_RATE);
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
  notify = toast,        // 失败时那句看得见的人话（测试与无 DOM 宿主可换成空函数）
  // 128f-⑭：待开启那一枚被点时做什么。缺省派 COMPOSER_VOICE_SETUP_EVENT（组合根接：打开设置、定位到语音识别）。
  openSetup = () => { try { globalThis.document.dispatchEvent(new CustomEvent(COMPOSER_VOICE_SETUP_EVENT)); } catch { /* 没有 document 的宿主 */ } },
} = {}) {
  let button = null;
  let label = null;
  let live = null;
  let phase = 'idle';        // idle | starting | recording | transcribing | error | setup（128f-⑭：录得了、但语音识别还没配）
  let errorKey = '';
  let attempt = 0;           // 每次开始／取消 +1：拿到麦克风时发现不是这一次了，就把轨道放掉
  let recorder = null;
  let stream = null;
  let segment = null;        // 正在录的这一段（⑨：一次录音按停顿切成若干段）
  let current = null;        // 这一次录音的 session（各段排队转写、按序落字）
  let vad = null;            // 停顿侦听（AudioContext + AnalyserNode）；宿主没有就为 null＝不切段
  let vadTimer = 0;
  let sx = null;             // 130：流式会话（非 null = 这次录音走流式路，不用 MediaRecorder 切段）
  let startedAt = 0;
  let ticker = 0;
  let escapeBound = false;

  function announce(text) {
    if (live) live.textContent = text;
  }

  function paint() {
    if (!button) return;
    if (phase === 'setup') {
      // 待开启：灰字形、不是录音开关（aria-pressed 恒 false），提示说清「还没开启、点这里去设置」。
      button.dataset.state = 'setup';
      button.setAttribute('aria-pressed', 'false');
      button.setAttribute('aria-disabled', 'false');
      button.setAttribute('aria-label', t('composer.voice.label'));
      button.title = t('composer.voice.setupHint');
      if (label) label.textContent = '';
      return;
    }
    button.dataset.state = phase;
    button.setAttribute('aria-pressed', String(phase === 'starting' || phase === 'recording'));
    button.setAttribute('aria-disabled', String(phase === 'transcribing'));
    // 可访问名恒定（切换按钮的名字不随按下态变，按下与否由 aria-pressed 说）；提示与可见文字随阶段变。
    button.setAttribute('aria-label', t('composer.voice.label'));
    if (phase === 'error' && errorKey) button.title = t(errorKey);
    else if (phase === 'recording' || phase === 'starting') button.title = t('composer.voice.stop');
    else if (phase === 'transcribing') button.title = t('composer.voice.transcribing');
    else button.title = t(composerVoiceStreamConfigured(state && state.config) ? 'composer.voice.hintStream' : 'composer.voice.hint');
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

  // ⑨ 停顿侦听：一个 AnalyserNode 看这一拍的响度（RMS）。门限跟着环境底噪走（安静时慢慢学底噪，门限取
  // 「底噪 × 3」与一个固定下限里大的那个），风扇声大的屋子不会永远判成「在说话」。只读响度，不碰录音数据。
  function startVad(media) {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctx) return null;
    try {
      const context = new Ctx();
      if (context.state === 'suspended' && typeof context.resume === 'function') { void context.resume().catch(() => {}); }
      const source = context.createMediaStreamSource(media);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      return { context, source, analyser, samples: new Float32Array(analyser.fftSize), floor: 0.004, quietSince: 0 };
    } catch { return null; }
  }
  function stopVad() {
    if (vadTimer) { clearInterval(vadTimer); vadTimer = 0; }
    if (!vad) return;
    try { vad.source.disconnect(); } catch { /* 已经断开 */ }
    try { void vad.context.close().catch(() => {}); } catch { /* 已经关了 */ }
    vad = null;
  }
  function vadTick() {
    if (phase !== 'recording' || !vad || !segment) return;
    let loud = false;
    try {
      vad.analyser.getFloatTimeDomainData(vad.samples);
      let sum = 0;
      for (let i = 0; i < vad.samples.length; i++) sum += vad.samples[i] * vad.samples[i];
      const rms = Math.sqrt(sum / vad.samples.length);
      const gate = Math.max(COMPOSER_VOICE_VAD_MIN_RMS, vad.floor * 3);
      loud = rms > gate;
      if (!loud) vad.floor = vad.floor * 0.95 + rms * 0.05;
    } catch { return; }
    const at = now();
    if (loud) { segment.spoke = true; vad.quietSince = 0; return; }
    if (!vad.quietSince) vad.quietSince = at;
    const age = at - segment.startedAt;
    const paused = segment.spoke && age >= COMPOSER_VOICE_SEGMENT_MIN_MS && at - vad.quietSince >= COMPOSER_VOICE_PAUSE_MS;
    // 一口气说太久也切一刀（宁可切在词中间，也不让屏上半分钟没有字）。
    if (paused || age >= COMPOSER_VOICE_SEGMENT_MAX_MS) rotateSegment();
  }

  // 一段 = 一个 MediaRecorder（webm 的中间块不能单独解码，想要「可独立转写的一段」只能让录音器停一次）。
  // 同一条麦克风流上先起新的、再停旧的：两只录音器短暂重叠，切口不丢声；切口又落在停顿里，重叠的那一点是静音。
  function startSegment(session) {
    const seg = { session, chunks: [], spoke: false, startedAt: now(), final: false };
    const next = new globalThis.MediaRecorder(stream, { mimeType: COMPOSER_VOICE_MIME });
    next.addEventListener('dataavailable', event => { if (event.data && event.data.size > 0) seg.chunks.push(event.data); });
    next.addEventListener('stop', () => { segmentDone(seg); });
    next.start();
    recorder = next;
    segment = seg;
  }
  function rotateSegment() {
    const old = recorder;
    const session = segment && segment.session;
    if (!old || !session) return;
    try { startSegment(session); } catch { return; }   // 起不了新的一段就不切：整段录到底，和从前一样
    if (vad) vad.quietSince = 0;
    try { old.stop(); } catch { /* 旧录音器已经停了 */ }
  }

  function endCapture() {
    clearTicker();
    stopVad();
    releaseTracks(stream);
    stream = null;
    recorder = null;
    segment = null;
  }

  function fail(key) {
    clearTicker();
    bindEscape(false);
    errorKey = key;
    phase = 'error';
    paint();
    announce(t(key));
    try { notify(t(key), 'err'); } catch { /* 没有 toast 托盘的宿主：悬停提示与播报仍在 */ }
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
    // 一次录音 = 一个 session：各段按先后排队转写（queue 是一条 Promise 链，保证字按说的顺序落进输入框）。
    const session = { id: mine, discard: false, failedKey: '', sent: 0, inserted: 0, anchor: null, queue: Promise.resolve() };
    // 130：配了实时识别就先试流式路；开会话失败（组件没起来／服务端 409）→ 说一句、原样走按停顿切段。
    if (composerVoiceStreamConfigured(state && state.config) && streamCapable()) {
      try { await startStreaming(media, session); }
      catch { sx = null; try { notify(t('composer.voice.error.streamFallback'), ''); } catch { /* 无托盘宿主 */ } }
      if (mine !== attempt || phase !== 'starting') { if (sx) streamTeardown(sx, true); sx = null; releaseTracks(media); return; }
    }
    if (sx) {
      stream = media;
    } else {
      try {
        stream = media;
        startSegment(session);
      } catch {
        releaseTracks(media);
        stream = null;
        recorder = null;
        segment = null;
        fail('composer.voice.error.mic');
        return;
      }
    }
    current = session;
    startedAt = now();
    phase = 'recording';
    ticker = setInterval(tick, COMPOSER_VOICE_TICK_MS);
    if (!sx) {
      vad = startVad(media);   // 宿主没有 AudioContext 就没有停顿侦听：整段录完再转，和从前一样
      if (vad) vadTimer = setInterval(vadTick, COMPOSER_VOICE_VAD_TICK_MS);
    }
    paint();
    announce(t(sx ? 'composer.voice.streaming' : 'composer.voice.recording'));
  }

  // ── 130 流式路 ──────────────────────────────────────────────────────────
  function streamCapable() { return Boolean(globalThis.AudioContext || globalThis.webkitAudioContext); }
  async function startStreaming(media, session) {
    const opened = await request('/api/audio/stream/sessions', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    if (!opened.ok) throw new Error('stream open failed');
    const body = await opened.json();
    if (!body || !body.id) throw new Error('stream open failed');
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    const context = new Ctx();
    if (context.state === 'suspended' && typeof context.resume === 'function') { void context.resume().catch(() => {}); }
    const source = context.createMediaStreamSource(media);
    // ScriptProcessor 而不是 AudioWorklet：后者要单独一个模块文件走 addModule，桌面壳的静态路由与 CSP 都得再开口；
    // 这里只读输入、不写输出（输出恒静音），接到 destination 只是为了让 onaudioprocess 在所有宿主上都跑。
    const processor = context.createScriptProcessor(4096, 1, 1);
    const s = {
      id: String(body.id), session, context, source, processor, rate: Number(context.sampleRate) || 48000,
      acc: [], accLen: 0, all: [], allLen: 0, queue: Promise.resolve(), timer: 0, closed: false, dead: false,
      sentences: [], pend: null, corrections: 0, focused: false,
    };
    processor.onaudioprocess = event => {
      if (s.closed) return;
      const down = resampleTo16k(event.inputBuffer.getChannelData(0), s.rate);
      if (!down.length) return;
      s.acc.push(down); s.accLen += down.length;
      s.all.push(down); s.allLen += down.length;
    };
    source.connect(processor);
    processor.connect(context.destination);
    s.timer = setInterval(() => { void streamFlush(s); }, COMPOSER_VOICE_STREAM_CHUNK_MS);
    sx = s;
    return s;
  }
  // 把攒下的样本送出去（排队：一块一块按序，回包按序落字）。
  function streamFlush(s) {
    if (s.dead || !s.accLen) return s.queue;
    const samples = concatFloat(s.acc, s.accLen);
    s.acc = []; s.accLen = 0;
    s.queue = s.queue.then(() => streamSend(s, samples)).catch(() => {});
    return s.queue;
  }
  async function streamSend(s, samples) {
    if (s.dead || s.session.discard) return;
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) { const v = Math.max(-1, Math.min(1, samples[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
    let res;
    try {
      res = await request('/api/audio/stream/sessions/' + s.id + '/audio', { method: 'POST', body: pcm.buffer, headers: { 'content-type': 'audio/L16; rate=16000' } });
    } catch { streamDead(s, 'composer.voice.error.failed'); return; }
    if (!res.ok) {
      let raw = '';
      try { raw = await res.text(); } catch { raw = ''; }
      streamDead(s, transcribeErrorKey(apiErrorInfo(new Error(raw))));
      return;
    }
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (body) streamApply(s, body);
  }
  // 流式路中途断了（组件崩了、服务端 5xx）：当场停录、说清原因；已经落进输入框的字留着。
  function streamDead(s, key) {
    if (s.dead) return;
    s.dead = true;
    segmentFailed(s.session, key);
  }
  // 落字模型：每一句各占输入框里的一段 [start,end)（sentences[i]），临时文字自己一段（pend）。改哪一段先核那一段是不是
  // 还逐字等于自己写的；不是就不碰它（用户改过了），别的段照旧 —— 「静默替换只动没碰过的字」就是这个判据
  // （纯函数 replaceStreamRegion）。段与段之间的空格只在拉丁字母／数字两侧加，归前一段之外（换文本时不动它）。
  function streamIntact(box, region) { return Boolean(region) && String(box.value || '').slice(region.start, region.end) === region.text; }
  // 从 from 起的所有段整体挪 delta（except 自己不挪）。
  function streamShift(s, from, delta, except) {
    if (!delta) return;
    for (const it of s.sentences) { if (it !== except && it.start >= from) { it.start += delta; it.end += delta; } }
    if (s.pend && s.pend !== except && s.pend.start >= from) { s.pend.start += delta; s.pend.end += delta; }
  }
  function streamInsertAt(s, box, at, text) {
    const value = String(box.value || '');
    const glue = /[A-Za-z0-9]$/.test(value.slice(0, at)) && /^[A-Za-z0-9]/.test(text) ? ' ' : '';
    box.value = value.slice(0, at) + glue + text + value.slice(at);
    const region = { text, start: at + glue.length, end: at + glue.length + text.length };
    streamShift(s, at, glue.length + text.length, region);
    return region;
  }
  function streamReplace(s, box, region, text) {
    const r = replaceStreamRegion(box.value, region, region.text, text);
    if (!r) return false;
    const oldEnd = region.end;
    box.value = r.value;
    region.text = text; region.end = region.start + text.length;
    streamShift(s, oldEnd, text.length - (oldEnd - region.start), region);
    return true;
  }
  // 新文字落在哪：临时段还在就换它；否则接在最后一句之后（那一句没被碰过）；再否则用户现在的光标。
  function streamAnchor(s, box) {
    const last = s.sentences.length ? s.sentences[s.sentences.length - 1] : null;
    if (last && streamIntact(box, last)) return last.end;
    const value = String(box.value || '');
    return box.selectionStart ?? value.length;
  }
  function streamCaret(s, box) {
    if (!s.focused) { try { box.focus(); } catch { /* 不可聚焦 */ } s.focused = true; }
    // 光标跟到刚写的那段末尾；只在用户没把焦点挪去别处时才动（每 250 ms 抢一次焦点会打断他在别处打字）。
    if (!globalThis.document || globalThis.document.activeElement !== box) return;
    const tail = s.pend || (s.sentences.length ? s.sentences[s.sentences.length - 1] : null);
    if (tail) { try { box.setSelectionRange(tail.end, tail.end); } catch { /* 不支持选区 */ } }
  }
  function streamApply(s, body) {
    const fresh = [];
    for (const f of (Array.isArray(body.finals) ? body.finals : [])) {
      const text = String((f && f.text) || '').trim();
      if (!text) continue;
      fresh.push({ text, startMs: Math.max(0, Number(f.startMs) || 0), endMs: Math.max(0, Number(f.endMs) || 0), start: 0, end: 0 });
    }
    const box = input();
    if (!box) { for (const f of fresh) { s.sentences.push(f); s.session.inserted += 1; } return; }
    for (const f of fresh) {
      // 定稿：临时段还在就把它换成定稿（那正是这一句的临时文字）；不在就当新一段接上。
      if (s.pend && streamReplace(s, box, s.pend, f.text)) { f.start = s.pend.start; f.end = s.pend.end; }
      else { const r = streamInsertAt(s, box, streamAnchor(s, box), f.text); f.start = r.start; f.end = r.end; }
      s.pend = null;
      s.sentences.push(f);
      s.session.inserted += 1;
    }
    const partial = String(body.partial || '').trim();
    if (partial) {
      if (s.pend) { if (!streamReplace(s, box, s.pend, partial)) s.pend = null; }   // 临时段被用户碰过 → 不再显示临时文字，到下一句定稿再接
      else s.pend = streamInsertAt(s, box, streamAnchor(s, box), partial);
    } else if (s.pend) {
      streamReplace(s, box, s.pend, '');   // 组件把这一段清了（静音收口、没有字）：临时文字撤掉
      s.pend = null;
    }
    streamCaret(s, box);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    for (const f of fresh) void streamCorrect(s, f);
  }
  // 第二遍（131b 起经 /api/audio/correct，服务端按 asrFixMode 决定重听／大模型改字／合成）：这一句的第一遍文字（＋音频，要重听时才带）
  // 送过去；回来不同、那一段还没被碰过 → 静默换掉（拍板 ①）。
  async function streamCorrect(s, item) {
    const cfg = state && state.config;
    if (!composerVoiceCorrectConfigured(cfg)) return;   // 没配第二遍 = 不校正
    const a = Math.min(s.allLen, item.startMs * 16), b = Math.min(s.allLen, item.endMs * 16);
    if (b - a < COMPOSER_VOICE_CORRECT_MIN_MS * 16) return;
    let audio = null;
    if (composerVoiceCorrectWantsAudio(cfg)) {
      const all = concatFloat(s.all, s.allLen);
      try { audio = await blobToBase64(wavBlobFromPcm(all.subarray(a, b), COMPOSER_VOICE_SAMPLE_RATE)); } catch { audio = null; }
    }
    // 133a：这句前面已经落在输入框里的字当上下文一起送去（同音字、术语、指代靠它判；评测里纯文字改错的错误数减半）。
    // 取的是发请求这一刻输入框里这一段之前的全部文字（含用户自己打的），服务端只用尾巴。
    const boxNow = input();
    const context = boxNow ? String(boxNow.value || '').slice(0, Math.max(0, item.start)).slice(-COMPOSER_VOICE_CONTEXT_CHARS) : '';
    let text = '';
    try {
      const res = await request('/api/audio/correct', { method: 'POST', body: JSON.stringify({ text: item.text, audio, contentType: COMPOSER_VOICE_WAV_TYPE, context }), headers: { 'content-type': 'application/json' } });
      if (!res.ok) return;   // 第二遍失败就留着第一遍的字：不弹错（第一遍已经把话记下来了）
      const body = await res.json();
      text = String((body && body.text) || '').trim();
    } catch { return; }
    if (!text || text === item.text || s.session.discard) return;
    const box = input();
    if (!box || !streamReplace(s, box, item, text)) return;   // 那一句被用户碰过 → 一个字不动
    s.corrections += 1;
    streamCaret(s, box);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // 停：closed 之后 onaudioprocess 不再攒；把最后一块送出去、finish 收尾句、再交给 finishSession 收工。
  function streamTeardown(s, discard) {
    s.closed = true;
    if (s.timer) { clearInterval(s.timer); s.timer = 0; }
    try { s.processor.disconnect(); } catch { /* 已断 */ }
    try { s.source.disconnect(); } catch { /* 已断 */ }
    try { void s.context.close().catch(() => {}); } catch { /* 已关 */ }
    if (discard) {
      s.dead = true;
      void request('/api/audio/stream/sessions/' + s.id, { method: 'DELETE' }).catch(() => {});
    }
  }
  async function streamStop(s) {
    streamTeardown(s, false);
    endCapture();
    bindEscape(false);
    await streamFlush(s);
    s.queue = s.queue.then(async () => {
      if (s.dead || s.session.discard) return;
      let res;
      try { res = await request('/api/audio/stream/sessions/' + s.id + '/finish', { method: 'POST', body: '', headers: { 'content-type': 'application/octet-stream' } }); }
      catch { return; }
      if (!res.ok) return;
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      if (body) streamApply(s, { partial: '', finals: body.finals });
    }).catch(() => {});
    await s.queue;
    if (sx === s) sx = null;
    finishSession(s.session);
  }
  function streamCancel(s) {
    streamTeardown(s, true);
    s.session.discard = true;
    endCapture();
    const box = input();
    if (box && s.pend) {   // 撤掉临时文字（没被碰过才撤）；定稿的字留着
      if (streamReplace(s, box, s.pend, '')) box.dispatchEvent(new Event('input', { bubbles: true }));
      s.pend = null;
    }
    if (sx === s) sx = null;
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
    if (phase !== 'recording') return;
    if (sx) {   // 130：流式路的结束 —— 送完最后一块、收尾句、等第二遍
      clearTicker();
      phase = 'transcribing';
      paint();
      void streamStop(sx);
      return;
    }
    if (!recorder) return;
    clearTicker();
    bindEscape(false);
    phase = 'transcribing';
    paint();
    if (segment) segment.final = true;
    try { recorder.stop(); }
    catch { endCapture(); fail('composer.voice.error.mic'); }
  }

  // 取消 = 还没转出来的都不要了（在录的这一段、排队等转写的那几段）；已经落进输入框的字不往回收。
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
    if (current) current.discard = true;
    phase = 'idle';
    paint();
    announce(t('composer.voice.cancelled'));
    if (sx) { streamCancel(sx); current = null; return; }   // 130：流式路的取消
    if (segment) segment.final = true;
    try { recorder.stop(); }
    catch { endCapture(); }
  }

  // MediaRecorder 的 stop 事件之后：这一段的块已经全部冲出来了。
  function segmentDone(seg) {
    const session = seg.session;
    // 最后一段：用户点了结束／取消，或轨道自己断了（设备被拔 —— 没人标 final，但它就是正在录的那一段）。
    const last = seg.final || seg === segment;
    const silent = Boolean(vad) && !seg.spoke;   // 有停顿侦听、而这一段从头到尾没出过声
    if (last) {
      endCapture();
      bindEscape(false);   // 轨道自己断掉也会走到这里，不能把 Esc 监听留在身后
      if (!session.discard && phase === 'recording') { phase = 'transcribing'; paint(); }
    }
    if (!session.discard && !session.failedKey) {
      const blob = new Blob(seg.chunks, { type: COMPOSER_VOICE_MIME });
      // 静音段不出网：中间被「说太久」硬切出来的静音段直接丢；收尾那一段静音（说完了、过一会儿才点结束）在前面
      // 已经送过字时也丢。整次录音唯一的一段永远照发 —— 有没有字由转写服务说了算，和从前一样。
      const skip = silent && (!last || session.sent > 0);
      if (blob.size && !skip) {
        session.sent += 1;
        session.queue = session.queue.then(() => transcribeSegment(session, blob));
      } else if (!blob.size && last && session.sent === 0) {
        session.failedKey = 'composer.voice.error.empty';
      }
    }
    if (last) session.queue = session.queue.then(() => finishSession(session));
  }

  async function transcribeSegment(session, blob) {
    if (session.discard || session.failedKey) return;
    if (session === current && phase === 'transcribing') announce(t('composer.voice.transcribing'));
    // ⑧ 上传前转 16 kHz 单声道 WAV；解不开就原样发 webm（回退，见 encodeVoiceWav 头注）。
    const wav = await encodeVoiceWav(blob);
    const upload = wav || blob;
    const uploadType = wav ? COMPOSER_VOICE_WAV_TYPE : COMPOSER_VOICE_UPLOAD_TYPE;
    const uploadName = wav ? COMPOSER_VOICE_WAV_FILENAME : COMPOSER_VOICE_FILENAME;
    let text = '';
    try {
      const res = await request('/api/audio/transcribe?filename=' + uploadName, {
        method: 'POST',
        body: upload,
        headers: { 'content-type': uploadType },
      });
      if (!res.ok) {
        let raw = '';
        try { raw = await res.text(); } catch { raw = ''; }
        const info = apiErrorInfo(new Error(raw));
        segmentFailed(session, transcribeErrorKey(info));
        return;
      }
      const body = await res.json();
      text = String((body && body.text) || '').trim();
    } catch {
      segmentFailed(session, 'composer.voice.error.failed');
      return;
    }
    if (session.discard || !text) return;   // 这一段没听出字（咳嗽、环境声）不算失败；整次一个字都没有才算（finishSession）
    const box = input();
    if (!box) return;
    insertSegment(session, box, text);
    session.inserted += 1;
  }

  // 转写这条路不通（接口类型不对、密钥被拒、服务商挂了）就别让人对着麦克风白说：当场停录、说清原因。
  // 已经落进输入框的字留着。
  function segmentFailed(session, key) {
    if (session.failedKey) return;
    session.failedKey = key;
    if (session !== current) return;
    if (phase === 'recording') {
      attempt += 1;
      clearTicker();
      session.discard = true;
      if (sx) { streamCancel(sx); current = null; }   // 130：流式路中途断了
      else {
        if (segment) segment.final = true;
        try { recorder.stop(); } catch { endCapture(); }
      }
    }
    fail(key);
  }

  function finishSession(session) {
    if (session !== current) return;
    current = null;
    if (session.failedKey) { if (phase !== 'error') fail(session.failedKey); return; }
    if (session.discard) return;
    if (!session.inserted) { fail('composer.voice.error.empty'); return; }
    phase = 'idle';
    paint();
    announce(t('composer.voice.inserted'));
  }

  // ④ 照 file-browser.js mentionFile：selectionStart/End 拼接 → setSelectionRange → focus；
  // 自适应高度与草稿保存由派发的 input 事件交给输入框自己的监听器。
  // ⑨ 第二段起接在上一段后面：输入框自上次落字之后没被人动过（值逐字相同）就续在那个位置；动过了就尊重
  // 用户现在的光标。两段之间要不要空格只看交界两侧是不是都是拉丁字母／数字（中文之间不加）。
  function insertSegment(session, box, text) {
    const value = String(box.value || '');
    const follow = session.anchor && session.anchor.box === box && session.anchor.value === value;
    const start = follow ? session.anchor.position : (box.selectionStart ?? value.length);
    const end = follow ? session.anchor.position : (box.selectionEnd ?? value.length);
    const glue = follow && /[A-Za-z0-9]$/.test(value.slice(0, start)) && /^[A-Za-z0-9]/.test(text) ? ' ' : '';
    box.value = value.slice(0, start) + glue + text + value.slice(end);
    const position = start + glue.length + text.length;
    try { box.setSelectionRange(position, position); } catch { /* 不支持选区的宿主 */ }
    box.focus();
    box.dispatchEvent(new Event('input', { bubbles: true }));
    session.anchor = { box, position, value: String(box.value || '') };
  }

  function onClick() {
    if (phase === 'setup') { openSetup(); return; }   // 128f-⑭：去设置里把语音识别开起来
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
    if (sx) { streamCancel(sx); }
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
    if (!box || !host || !composerVoiceCapable()) { teardown(); return false; }   // 128f-⑭：录不了才不出按钮
    if (!button) build();
    if (!composerVoiceConfigured(state && state.config)) {
      if (phase === 'recording' || phase === 'starting') cancel();   // 语音识别刚被关掉：在录的那一段丢弃
      phase = 'setup';
      errorKey = '';
    } else if (phase === 'setup') {
      phase = 'idle';   // 刚配好：从待开启变成能录
    }
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
