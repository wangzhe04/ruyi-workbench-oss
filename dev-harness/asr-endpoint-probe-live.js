#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// asr-endpoint-probe-live.js — 107 波 E1:再确认一次「四个已配 ASR 模型都不提供
// `/audio/transcriptions`」(45 号文 §9.6.3 的读数),给 Release Brief 留一份可复跑的取证。
//
//   node --require ./dev-harness/lib/fixture-home-guard.js dev-harness/asr-endpoint-probe-live.js [--out=<json>]
//
// 量什么:对每个候选(provider × ASR 模型)按 `transcribeAudioViaProvider`
// (`src/05-claude-engine.js:1640-1658`)**逐字段照搬**的出站请求打一发 —— 同一个 URL 拼法
// (`providerBaseWithV1(audioBaseUrl || baseUrl) + '/audio/transcriptions'`)、同一组 multipart
// 字段(`model` / `response_format=json` / `language` / `file`)、同一个 Bearer 头。记录 HTTP 状态
// 与回体前 200 字。**不建适配器、不换 base 重试、不走 chat 协议** —— 派单明确说了不做。
//
// 与 45 号文 §9.6.3 的差别(照实写):那一轮是**经产品路由** `POST /api/audio/transcribe` 打的,
// 所以读到的是产品把上游 404 映射成的 502＋`asr.upstream`;本件是**直连上游**,读到的是上游自己的
// 状态码。两者量的是同一件事的两端,产品侧映射 §9.6.3 已有读数,本件只补「上游今天还是不是 404」。
//
// 音频:本件自己合成一段 0.5 s / 16 kHz / 16 bit 单声道正弦 WAV(不依赖 SAPI、不落用户目录)。
// 404 出在路由不存在,发生在任何音频解析之前 —— 用什么音频都读到同一个状态码。
//
// 花费:上游 404 不计费、不进任何账本(§9.6.7 已实测「无行」)。
// 隔离:只**读**真机 config.json 取端点与凭据,不写真机任何文件、不起服务、不开端口。
// 密钥:全程只出现在 Authorization 头里;落盘前一律经 redact,读数里只留 host/模型/状态码。
// ─────────────────────────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const OUT = arg('out', '');

const REAL_HOME = process.env.RUYI_REAL_HOME || os.homedir();
const config = JSON.parse(fs.readFileSync(path.join(REAL_HOME, '.win-claude-workbench', 'config.json'), 'utf8'));

// 45 号文 §9.6.3 点名的四个候选(provider id × 模型 id)。
const CANDIDATES = [
  ['openai-compatible-2', 'mimo-v2.5-asr'],
  ['openai-compatible', 'qwen3-asr-flash-2026-02-10'],
  ['openai-compatible', 'fun-asr-flash-2026-06-15'],
  ['openai-compatible-5', 'hy-asr-3.0-preview'],
];

function baseWithV1(u) { const b = String(u || '').trim().replace(/\/+$/, ''); return !b ? '' : (/\/v\d+$/i.test(b) ? b : b + '/v1'); }
// 控制字符清洗:正则用 new RegExp 从字符串拼起来,**源码里一个控制字符都不出现**。
// 第一版直接在正则字面量里写了「反斜杠 u 0000 到反斜杠 u 001f」这两个转义序列,落盘时变成了
// 两个**真的**控制字节(NUL 与 0x1F)——
// 运行时等价所以测试照绿,但它会破坏 grep/diff/编辑器。交付前的控制字符扫描抓到的,不是测试抓到的。
const CTRL_RE = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + ']+', 'g');
const stripCtrl = s => String(s == null ? '' : s).replace(CTRL_RE, ' ');

function tinyWav() {
  const rate = 16000, secs = 0.5, n = Math.round(rate * secs);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write('data', 36); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

(async () => {
  const audio = tinyWav();
  const rows = [];
  const keys = [];
  console.log('ASR 端点直连探针(四个候选,各一发)· 音频 ' + audio.length + ' B / 16 kHz / 16 bit / 单声道');
  console.log('注意:真机 config 里 asrProviderId=' + JSON.stringify(config.asrProviderId || '') + '、asrModel=' + JSON.stringify(config.asrModel || '')
    + ' —— 两者为空时产品侧 /api/audio/transcribe 直接 409 asr.not_configured,麦克风不渲染。');
  for (const [providerId, model] of CANDIDATES) {
    const provider = (config.providers || []).find(p => p.id === providerId);
    if (!provider) { rows.push({ providerId, model, error: 'provider 不在配置里' }); continue; }
    if (provider.apiKey) keys.push(String(provider.apiKey));
    const base = baseWithV1(provider.audioBaseUrl || provider.baseUrl);
    const url = base + '/audio/transcriptions';
    const form = new FormData();
    form.append('model', model);
    form.append('response_format', 'json');
    form.append('language', 'zh');
    form.append('file', new Blob([audio], { type: 'audio/wav' }), 'probe.wav');
    const headers = { ...(provider.extraHeaders || {}) };
    if (provider.apiKey) headers.authorization = 'Bearer ' + provider.apiKey;
    const t0 = Date.now();
    let row;
    try {
      const res = await fetch(url, { method: 'POST', headers, body: form, signal: AbortSignal.timeout(60000) });
      let text = ''; try { text = (await res.text()).slice(0, 8192); } catch { /* ignore */ }
      row = {
        providerId, model, host: (() => { try { return new URL(url).host; } catch { return ''; } })(),
        urlPath: (() => { try { return new URL(url).pathname; } catch { return ''; } })(),
        httpStatus: res.status, ms: Date.now() - t0,
        bodyHead: stripCtrl(text).slice(0, 200),
        hasTextField: (() => { try { return typeof JSON.parse(text).text === 'string'; } catch { return false; } })(),
      };
    } catch (e) {
      row = { providerId, model, httpStatus: null, ms: Date.now() - t0, error: String((e && e.name) || '') + ': ' + String((e && e.message) || e) };
    }
    rows.push(row);
    console.log('  ' + model + ' @ ' + (row.host || providerId) + ' → HTTP ' + (row.httpStatus == null ? ('(' + row.error + ')') : row.httpStatus) + ' / ' + row.ms + ' ms');
  }
  const redact = s => { let t = JSON.stringify(s); for (const k of keys) if (k) t = t.split(k).join('«redacted»'); return JSON.parse(t); };
  const readings = {
    schema: 1, wave: '107-E1', at: new Date().toISOString(),
    asrConfigured: !!(String(config.asrProviderId || '').trim() && String(config.asrModel || '').trim()),
    audioBytes: audio.length, rows: redact(rows),
    verdict: rows.every(r => r.httpStatus === 404 || (r.httpStatus && r.httpStatus >= 400))
      ? '四个候选全部 4xx —— 与 45 号文 §9.6.3 的读数一致' : '有候选返回了非 4xx,读数与 §9.6.3 不一致,要重查',
  };
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(readings, null, 2), 'utf8'); console.log('落盘: ' + OUT); }
  console.log('结论: ' + readings.verdict);
})().catch(e => { console.error(String((e && e.stack) || e)); process.exitCode = 1; });
