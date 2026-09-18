#!/usr/bin/env node
// 纪律 15：第一行先把本进程的家目录（USERPROFILE／HOME／APPDATA／LOCALAPPDATA）换成临时目录，子进程继承。
// 不做这一步，下面起的临时工作台虽然数据目录在 TMP，os.homedir() 仍是用户真家目录 ——
// 它启动时往 Kimi／Claude Code 同步 MCP 的那几路会把一份空列表写进用户【真实】的配置。
require('./lib/self-isolate-home.js');
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// asr-chat-audio-probe-live.js — 107 波 A2:107-A1 加的 `chat-audio` 协议，在【用户真机真 key】上
// 经【产品路由】跑一次配对对照。A1 全程是假桩，这是那条功能唯一缺的一环实证。
//
//   node --require ./dev-harness/lib/fixture-home-guard.js dev-harness/asr-chat-audio-probe-live.js [--out=<json>]
//
// **为什么要配对**：单跑「新协议 200」证明不了「是协议切换让它能用的」。所以每个候选都跑两臂 ——
// 同一段音频、同一个端点、同一把 key，**只切 `provider.asrProtocol`**：
//   · 关臂 `transcriptions`（缺省）→ 预期仍 502/`asr.upstream`（上游 404），与 45 号文 §9.6.3 逐字可比；
//   · 开臂 `chat-audio`          → 预期 200 ＋ 转写文本。
// 两臂之间除了这一个字段，别的一律不动。
//
// **经产品路由，不是直连上游**：`POST /api/audio/transcribe`。直连只能证明协议对
//（`asr-endpoint-probe-live.js` 已经在做那一半），经路由才能证明**产品**对：URL 拼法、鉴权头、
// data URI 拼装、回体解析、usage 映射、记账、错误信封，全都在测量范围内。
//
// 隔离：
//   · 只**读**真机 `config.json` 取端点与凭据，**不写真机任何文件**；服务跑在 mkdtemp 出来的临时家目录。
//   · 临时配置里 `autoImportClaudeCodeMcp:false`（否则启动会去扫真机 `~/.claude.json`，污染读数）。
//   · `stewardEnabledV1:false`、`schedulerEnabledV1:false`、桌面 MCP 关 —— 别让无关回合花钱。
// 密钥：全程只出现在临时配置与 Authorization 头里；**读数落盘前只留 host／模型／状态码／文本**，
//       且文本本身也过一遍 redact（转写结果理论上不含密钥，但不赌）。
// 花费：每个候选 2 发（关臂上游 404 不计费）。四个候选 ≈ 4 次真转写，分币级。
// ─────────────────────────────────────────────────────────────────────────────

const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find(a => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const OUT = arg('out', path.join(ROOT, 'docs', 'optimization-plan', '107-a2-asr-chat-audio.json'));

// 45 号文 §9.6.3 那四个候选（provider id 取自用户真机配置）
const CANDIDATES = [
  { providerId: 'openai-compatible-2', model: 'mimo-v2.5-asr', label: 'MiMo' },
  { providerId: 'openai-compatible', model: 'qwen3-asr-flash-2026-02-10', label: '百炼 qwen3-asr-flash' },
  { providerId: 'openai-compatible', model: 'fun-asr-flash-2026-06-15', label: '百炼 fun-asr-flash' },
  { providerId: 'openai-compatible-5', model: 'hy-asr-3.0-preview', label: '混元' },
];

const SPOKEN = '今天下午三点提醒我检查A股收盘计划';   // 与 §9.6.3 同一句，读数可逐字对比
const sleep = ms => new Promise(r => setTimeout(r, ms));
const redact = s => String(s || '')
  .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
  .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/gi, 'Bearer ***');

function hostOf(u) { try { return new URL(String(u)).host; } catch { return '(bad url)'; } }

// ── 真机配置：只读 ─────────────────────────────────────────────────────────
// 自隔离之后 os.homedir() 已是临时目录；真家目录由 fixture-home 记下（只读取，绝不写）。
const REAL_HOME = require('./lib/fixture-home').REAL_HOME;
const realConfigPath = path.join(REAL_HOME, '.win-claude-workbench', 'config.json');
if (!fs.existsSync(realConfigPath)) { console.error('找不到真机 config.json:', realConfigPath); process.exit(1); }
const real = JSON.parse(fs.readFileSync(realConfigPath, 'utf8'));
const realProviders = Array.isArray(real.providers) ? real.providers : [];

// ── 音频：SAPI 合成 16 kHz 单声道 WAV（不落用户目录）────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-a2-'));
const wavPath = path.join(TMP, 'zh.wav');
function synthWav() {
  const ps = [
    'Add-Type -AssemblyName System.Speech;',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
    '$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,' +
      ' [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,' +
      ' [System.Speech.AudioFormat.AudioChannel]::Mono);',
    '$s.SetOutputToWaveFile(' + JSON.stringify(wavPath) + ', $fmt);',
    '$v = $s.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq "zh-CN" } | Select-Object -First 1;',
    'if ($v) { $s.SelectVoice($v.VoiceInfo.Name) }',
    '$s.Speak(' + JSON.stringify(SPOKEN) + ');',
    '$s.Dispose();',
  ].join(' ');
  cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
  const b = fs.readFileSync(wavPath);
  if (b.length < 4096 || b.slice(0, 4).toString('ascii') !== 'RIFF') throw new Error('SAPI 合成失败或不是 WAV');
  return b;
}

// ── 服务：临时家目录里起一台 ───────────────────────────────────────────────
let child = null, PORT = 0, TOKEN = '';
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* 已经没了 */ } } }

function writeFixtureConfig(cand, protocol) {
  const src = realProviders.find(p => p && p.id === cand.providerId);
  if (!src) return null;
  const provider = {
    id: src.id, label: src.label || src.id, type: src.type || 'openai-compat',
    baseUrl: src.baseUrl, apiKey: src.apiKey,
    model: cand.model,
    models: [{ id: cand.model, label: cand.model, caps: ['asr'] }],
    ...(src.audioBaseUrl ? { audioBaseUrl: src.audioBaseUrl } : {}),
    ...(protocol === 'chat-audio' ? { asrProtocol: 'chat-audio' } : {}),
  };
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify({
    configSchema: 12, version: '2.8.0', permissionMode: 'bypass',
    providers: [provider], activeProvider: provider.id,
    asrProviderId: provider.id, asrModel: cand.model,
    autoImportClaudeCodeMcp: false, includeWorkbenchMcp: false, enableMcpDropIn: false,
    externalMcpServers: [], desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    stewardEnabledV1: false, schedulerEnabledV1: false,
    defaultWorkspace: TMP, locale: 'zh-CN',
  }, null, 2));
  return provider;
}

const req = (method, p, body, headers) => new Promise(resolve => {
  const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
    const c = []; res.on('data', d => c.push(d));
    res.on('end', () => {
      const text = Buffer.concat(c).toString('utf8');
      let json = null; try { json = JSON.parse(text); } catch { /* 非 JSON */ }
      resolve({ status: res.statusCode, json, text: text.slice(0, 600) });
    });
  });
  r.on('error', e => resolve({ status: 0, json: null, text: String(e && e.message || e) }));
  if (body) r.write(body);
  r.end();
});

// 启动与取 token 的写法【照抄 asr-transcribe.e2e.js:45/:51】—— 不自己发明：
// 家目录靠 WIN_CLAUDE_WORKBENCH_HOME／RUYI_HOME 两个环境变量，token 在首页的
// <meta name="wcw-token"> 里，就绪判据是 GET /api/status 回 200。
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: '/', timeout: 8000 }, resp => {
      let b = ''; resp.on('data', c => (b += c));
      resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); });
    });
    r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); });
  });
}
async function boot() {
  const { getFreePort } = require('./free-port.js');
  PORT = await getFreePort();
  let log = '';
  child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], {
    cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: TMP, RUYI_HOME: TMP },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', d => { log += d.toString(); });
  child.stderr.on('data', d => { log += d.toString(); });
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const r = await req('GET', '/api/status', null, {});
    if (r.status === 200 || r.status === 403) {   // 403 = 起来了、只是要 token
      TOKEN = await getToken();
      if (TOKEN) return { ok: true, log: log.slice(0, 800) };
    }
  }
  return { ok: false, log: log.slice(0, 2000) };
}

// 准确率：去标点后按字比对（与 §9.6.3 同口径）
const norm = s => String(s || '').replace(/[\s，。、！？,.!?；;：:]/g, '');
function charAccuracy(got, want) {
  const a = norm(got), b = norm(want);
  if (!b.length) return 0;
  let hit = 0; const pool = a.split('');
  for (const ch of b) { const i = pool.indexOf(ch); if (i >= 0) { hit++; pool.splice(i, 1); } }
  return Math.round((hit / b.length) * 1000) / 10;
}

(async () => {
  const out = {
    schema: 1, wave: '107-A2', startedAt: new Date().toISOString(),
    spoken: SPOKEN, audio: null, arms: [], notes: [],
  };
  let audio = null;
  try { audio = synthWav(); out.audio = { bytes: audio.length, rate: 16000, channels: 1, bits: 16 }; }
  catch (e) { console.error('音频合成失败:', e.message); process.exit(1); }
  console.log('音频:', audio.length, 'B');

  for (const cand of CANDIDATES) {
    for (const protocol of ['transcriptions', 'chat-audio']) {
      const provider = writeFixtureConfig(cand, protocol);
      if (!provider) {
        out.arms.push({ label: cand.label, model: cand.model, protocol, skipped: 'provider 不在真机配置里' });
        console.log('SKIP', cand.label, protocol, '(provider 缺)');
        continue;
      }
      const b = await boot();
      let row = { label: cand.label, model: cand.model, protocol, host: hostOf(provider.audioBaseUrl || provider.baseUrl) };
      if (!b.ok) {
        row.error = 'workbench 起不来'; row.log = redact(b.log);
      } else {
        const t0 = Date.now();
        const r = await req('POST', '/api/audio/transcribe?filename=zh.wav&language=zh', audio, {
          'content-type': 'audio/wav', 'content-length': String(audio.length),
          ...(TOKEN ? { 'x-wcw-token': TOKEN } : {}),
        });
        row.ms = Date.now() - t0;
        row.status = r.status;
        row.code = r.json && r.json.error ? r.json.error.code : null;
        // 失败时把上游原话留下来（产品信封里的片段本身已先脱敏再裁 1000；这里再脱一遍、裁到 300）——
        // 发布说明要写「为什么不行」，不是只写「不行」。
        if (r.json && r.json.error) row.upstream = redact(String(r.json.error.message || '')).slice(0, 300);
        row.text = r.json && typeof r.json.text === 'string' ? redact(r.json.text) : null;
        row.estimated = r.json ? r.json.estimated : null;
        row.accuracy = row.text ? charAccuracy(row.text, SPOKEN) : null;
        if (!r.json) row.raw = redact(r.text);
        // 账本:这一发有没有落一行
        try {
          const usageDir = path.join(TMP, 'usage');
          const rows = fs.existsSync(usageDir)
            ? fs.readdirSync(usageDir).flatMap(f => fs.readFileSync(path.join(usageDir, f), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }))
            : [];
          const asrRows = rows.filter(x => x && x.note === 'asr');
          row.ledgerRows = asrRows.length;
          row.ledgerLast = asrRows.length ? { kind: asrRows[asrRows.length - 1].kind, estimated: asrRows[asrRows.length - 1].estimated, inTok: asrRows[asrRows.length - 1].inTok } : null;
        } catch { row.ledgerRows = -1; }
      }
      killp(child); child = null;
      try { fs.rmSync(path.join(TMP, 'usage'), { recursive: true, force: true }); } catch { /* 下一臂重新计 */ }
      out.arms.push(row);
      console.log([cand.label, cand.model, protocol, 'status=' + row.status, 'code=' + row.code,
        'acc=' + row.accuracy, 'ms=' + row.ms, 'ledger=' + row.ledgerRows].join('  '));
    }
  }

  out.finishedAt = new Date().toISOString();
  // 配对判读
  for (const cand of CANDIDATES) {
    const off = out.arms.find(a => a.model === cand.model && a.protocol === 'transcriptions');
    const on = out.arms.find(a => a.model === cand.model && a.protocol === 'chat-audio');
    if (!off || !on) continue;
    out.notes.push(`${cand.label} / ${cand.model}: 关臂 ${off.status}${off.code ? '/' + off.code : ''} → 开臂 ${on.status}${on.code ? '/' + on.code : ''}${on.accuracy != null ? `，字准确率 ${on.accuracy}%` : ''}`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('\n读数已落盘:', OUT);
  for (const n of out.notes) console.log(' ', n);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 临时目录留着也无害 */ }
})().catch(e => { killp(child); console.error(e); process.exit(1); });
