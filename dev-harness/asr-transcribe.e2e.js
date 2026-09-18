require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
'use strict';
// 127-114b(26 号文 §3/§4,45 号文 §2 ②/§4 ②):POST /api/audio/transcribe 端到端。
// 判据逐项:
//   鉴权 —— 判据原文写「401」,仓里 token 级一律 403 + auth.token_invalid 统一信封(handleApi 顶部
//           authorizeRoute 块),新路由不另立第二套鉴权码,断言按 403(45 号文 §8 交付记录注明)。
//   未配置 409 / 非 audio/* 400 / 空体 400 / 超 25 MB 413(早于 128 MB 总闸,双道:Content-Length 预检
//   + 流式累计)/ 成功 200({ok,text,language?,durationMs,providerId,model,estimated})/
//   上游 5xx 统一信封 502 / 记账 kind:'aux', note:'asr',上游无 usage 时 estimated:true。
// 反向(45 号文 §4 ②):把 25 MB 闸换成 MAX_BODY_BYTES(晚于总闸)→ 超一字节夹具从 413 变 200,红;
//   摘掉 estimated 标记 → 记账断言红。判据里第二条反向「audioBaseUrl 绕过 URL 校验 → 私网红」
//   按 45 号文 §1.6 不适用(baseUrl 今天就没有那套校验,同等对待=无准入,107 记档)。
// 107-A1(46 号文 §5 A1)追加第三靴 H:provider.asrProtocol='chat-audio' 时出站改成
//   POST {base}/chat/completions + input_audio data URI(45 号文 §9.6.3 真机实测的 MiMo/百炼协议)。
//   H1 字段过 sanitizeProvider 存活 / H2 成功且真的打在 chat 支 / H2b-c usage 按
//   prompt_tokens+completion_tokens 映射(estimated:false,账本记真值) / H3 webm 被上游 400 拒
//   (浏览器端转 WAV 的理由) / H4 回体解析不出文本 → 与 Whisper 分支同一个 asr.bad_response。
//   反向:把 05 的协议分叉改成永远走 transcriptions → H2 红(回显来自 chat 支的桩,Whisper 支给不出)。
// 判定行:`ASR TRANSCRIBE E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-asr-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

let WB_PORT = 0, ASR_PORT = 0, TOKEN = '';
const ASR_MAX = 25 * 1024 * 1024;
// 107-S1 ⑦:夹具用的假 key【运行时拼出来】,源码里不留密钥形态长串(repo-hygiene (b) 的全仓扫描会误报,
// 与 S0 的口径一致)。形状取「sk- 后跟 48 位字母数字」——04 REDACT_PATTERNS 里那条裸 sk- 咬得到它。
const ASR_FAKE_KEY = 'sk' + '-' + 'a1b2c3d4'.repeat(6);

function writeConfig(extra) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(Object.assign({
    configSchema: 11, version: '2.7.0', permissionMode: 'bypass', toolLoadingMode: 'full',
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    providers: [], activeProvider: '', asrProviderId: '', asrModel: '',
  }, extra || {}), null, 2));
}
function spawnWB() {
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  wb.on('exit', (code, signal) => console.log('[wb] EXIT code=' + code + ' signal=' + signal));
  return wb;
}
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 8000 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); });
    });
    r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); });
  });
}
function reqRaw(method, p, buf, headers) {
  return new Promise((resolve, reject) => {
    const h = { ...(headers || {}) };
    if (buf && !h['content-length']) h['content-length'] = buf.length;
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers: h, timeout: 60000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(body); } catch { j = null; } resolve({ status: res.statusCode, json: j, text: body }); });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (buf) r.write(buf); r.end();
  });
}
const reqAsr = (p, buf, ct, withToken = true) => reqRaw('POST', '/api/audio/transcribe' + (p || ''), buf, {
  ...(withToken ? { 'x-wcw-token': TOKEN } : {}), ...(ct ? { 'content-type': ct } : {}),
});
async function waitForHttp(attempts = 300) {
  for (let i = 0; i < attempts; i++) { try { const r = await reqRaw('GET', '/api/status'); if (r.status === 200) return true; } catch { /* not up yet */ } await sleep(150); }
  return false;
}
function readUsageRows() {
  const dir = path.join(HOME, 'usage');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).flatMap(f => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean));
}

(async () => {
  WB_PORT = await getFreePort(); ASR_PORT = await getFreePort();
  let asr = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js'), String(ASR_PORT)], { windowsHide: true, env: { ...process.env } });
  asr.stdout.on('data', () => {}); asr.stderr.on('data', () => {});
  let wb = null;
  try {
    // ═══ 第一靴:未配置 —— 403 鉴权 / 409 未配置 ═══
    fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
    writeConfig();
    wb = spawnWB();
    ok(await waitForHttp(), 'A0 workbench listening');
    TOKEN = await getToken();
    ok(!!TOKEN, 'A0b got UI token');
    let r = await reqAsr('?filename=a.webm', Buffer.from([1, 2, 3]), 'audio/webm', false);
    ok(r.status === 403 && r.json && r.json.error && r.json.error.code === 'auth.token_invalid',
      'A1 无 token → 403 + auth.token_invalid(判据原文 401,仓里 token 级统一 403,见 §8) (status ' + r.status + ')');
    r = await reqAsr('?filename=a.webm', Buffer.from([1, 2, 3]), 'audio/webm');
    ok(r.status === 409 && r.json && r.json.error && r.json.error.code === 'asr.not_configured',
      'B1 未配置 → 409 + asr.not_configured (status ' + r.status + ')');
    killp(wb); wb = null; await sleep(300);

    // ═══ 第二靴:配置齐全(fake ASR 经 baseUrl 兜底) ═══
    writeConfig({
      providers: [{ id: 'asr-p', label: 'ASR', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + ASR_PORT, apiKey: ASR_FAKE_KEY, model: 'whisper-1', models: [{ id: 'whisper-1', label: 'whisper-1', caps: ['asr'] }] }],
      asrProviderId: 'asr-p', asrModel: 'whisper-1',
    });
    wb = spawnWB();
    ok(await waitForHttp(), 'A2 workbench listening (configured)');
    TOKEN = await getToken();

    r = await reqAsr('?filename=a.webm', Buffer.from([1, 2, 3]), 'text/plain');
    ok(r.status === 400 && r.json && r.json.error && r.json.error.code === 'asr.content_type', 'B3 非 audio/* → 400 (status ' + r.status + ')');
    r = await reqAsr('?filename=a.webm', Buffer.alloc(0), 'audio/webm');
    ok(r.status === 400 && r.json && r.json.error && r.json.error.code === 'asr.empty', 'B4 空体 → 400 (status ' + r.status + ')');

    // C1 成功:小音频体 → 200,回显 model/filename/字节数,language 透传,estimated:true
    const audio1234 = Buffer.alloc(1234, 7);
    r = await reqAsr('?filename=test.webm&language=zh', audio1234, 'audio/webm');
    ok(r.status === 200 && r.json && r.json.ok === true, 'C1 成功 → 200 (status ' + r.status + ')');
    ok(r.json && /model=whisper-1/.test(r.json.text || '') && /filename=test\.webm/.test(r.json.text || '') && /bytes=1234/.test(r.json.text || ''),
      'C1 fake 回显 model/filename/字节数 (' + JSON.stringify((r.json && r.json.text || '').slice(0, 80)) + ')');
    ok(r.json && r.json.language === 'zh', 'C1 language 透传 zh (' + (r.json && r.json.language) + ')');
    ok(r.json && r.json.providerId === 'asr-p' && r.json.model === 'whisper-1' && r.json.estimated === true && Number.isFinite(r.json.durationMs),
      'C1 响应形状 {providerId,model,estimated,durationMs} (' + JSON.stringify(r.json && { providerId: r.json.providerId, model: r.json.model, estimated: r.json.estimated, durationMs: r.json.durationMs }) + ')');

    // C2 记账:usage 账本落一条 kind:'aux', note:'asr', estimated:true(inTok=ceil(1234/1024)=2)
    await sleep(400); // appendUsageLedger 是链式异步落盘
    const rows = readUsageRows().filter(x => x.note === 'asr');
    const row = rows[rows.length - 1] || null;
    ok(!!row && row.kind === 'aux' && row.note === 'asr', 'C2 账本落 kind:aux, note:asr (' + JSON.stringify(row && { kind: row.kind, note: row.note }) + ')');
    ok(!!row && row.estimated === true && row.inTok === 2 && row.outTok > 0 && row.model === 'whisper-1' && row.provider === 'asr-p' && row.cost === null && row.costTrusted === false,
      'C2 估算行形状(inTok=2/outTok>0/estimated/无定价 cost:null+costTrusted:false) (' + JSON.stringify(row && { inTok: row.inTok, outTok: row.outTok, estimated: row.estimated, cost: row.cost, costTrusted: row.costTrusted }) + ')');

    // D1 上游 5xx → 统一信封 502 + asr.upstream + params.status
    r = await reqAsr('?filename=upstream500.webm', audio1234, 'audio/webm');
    ok(r.status === 502 && r.json && r.json.ok === false && r.json.error && r.json.error.code === 'asr.upstream' && r.json.error.params && r.json.error.params.status === 500,
      'D1 上游 5xx → 502 统一信封(params.status=500) (status ' + r.status + ' code ' + (r.json && r.json.error && r.json.error.code) + ')');

    // D1b 107-S1 ⑦(46 号文 §5 ⑦b L1a):上游把请求头回显进错误体 → 信封里那 1000 字必须已经脱敏。
    // 修前这一段是 `upstreamText.slice(0,1000)` 原样进 failure.message,而这条路的两个消费面分别是
    // 浏览器(本路由的 502 信封)与模型 ＋ 会话文件(audio_transcribe 的工具结果)。
    r = await reqAsr('?filename=secretecho.webm', audio1234, 'audio/webm');
    {
      const whole = String(r.text || '');
      const message = String((r.json && r.json.error && r.json.error.message) || '');
      ok(r.status === 502 && r.json && r.json.error && r.json.error.code === 'asr.upstream'
        && message.includes('echoing headers') && !whole.includes(ASR_FAKE_KEY) && message.includes('«redacted»'),
        'D1b 上游回显的 Authorization 在失败信封里已脱敏(整个响应体搜不到明文 key,原文其余部分还在) (message ' + JSON.stringify(message.slice(0, 160)) + ')');
    }

    // E1 25 MB 专用闸(早于 128 MB 总闸):上限-1 放行、上限+1 413
    r = await reqAsr('?filename=big.webm', Buffer.alloc(ASR_MAX - 1, 1), 'audio/webm');
    ok(r.status === 200 && r.json && r.json.ok === true, 'E1 25MB-1B 放行(200) (status ' + r.status + ')');
    r = await reqAsr('?filename=big.webm', Buffer.alloc(ASR_MAX + 1, 1), 'audio/webm');
    ok(r.status === 413 && r.json && r.json.error && r.json.error.code === 'asr.too_large' && r.json.error.params && r.json.error.params.maxBytes === ASR_MAX,
      'E1 25MB+1B → 413 + asr.too_large(maxBytes 入 params) (status ' + r.status + ')');

    // E2 同一体走 chunked(无 Content-Length)→ 流式累计闸照样 413
    {
      const chunked = await new Promise((resolve) => {
        const rq = http.request({ host: '127.0.0.1', port: WB_PORT, path: '/api/audio/transcribe?filename=big.webm', method: 'POST',
          headers: { 'x-wcw-token': TOKEN, 'content-type': 'audio/webm', 'transfer-encoding': 'chunked' }, timeout: 60000 }, res => {
            let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { j = null; } resolve({ status: res.statusCode, json: j }); });
          });
        rq.on('error', () => resolve({ status: 0, json: null }));
        const part = Buffer.alloc(13 * 1024 * 1024, 1);
        rq.write(part); setTimeout(() => { rq.write(part); rq.end(); }, 50);
      });
      ok(chunked.status === 413 && chunked.json && chunked.json.error && chunked.json.error.code === 'asr.too_large',
        'E2 chunked(无 Content-Length)26MB → 流式闸 413 (status ' + chunked.status + ')');
      // 413 早判 + 客户端续传 = 服务端经历一次瞬态接受停顿(几百毫秒级,内核清理在途字节;服务不死)。
      // 钉住「服务撑得住并恢复」,再继续后面的用例 —— 不钉的话 F1 会撞进停顿窗口拿到 ECONNRESET(实测)。
      ok(await waitForHttp(), 'E2b 瞬态接受停顿后服务恢复(不死)');
    }

    // F1 audioBaseUrl 优先于 baseUrl:把 audioBaseUrl 指到死端口 → 502 不可达(证明走的是 audioBaseUrl)
    {
      const status = await reqRaw('GET', '/api/status');
      const providers = status.json && status.json.config && status.json.config.providers;
      ok(Array.isArray(providers) && providers.length === 1, 'F1 读到现值 providers');
      const dead = providers.map(p => ({ ...p, apiKey: 'k', audioBaseUrl: 'http://127.0.0.1:9' }));
      const patch = await reqRaw('POST', '/api/config', Buffer.from(JSON.stringify({ providers: dead })), { 'x-wcw-token': TOKEN, 'content-type': 'application/json' });
      ok(patch.status === 200, 'F1 audioBaseUrl 落盘 (status ' + patch.status + ')');
      r = await reqAsr('?filename=test.webm', audio1234, 'audio/webm');
      ok(r.status === 502 && r.json && r.json.error && r.json.error.code === 'asr.upstream_unreachable',
        'F1 audioBaseUrl=死端口 → 502 asr.upstream_unreachable(证明 audioBaseUrl 优先) (status ' + r.status + ' code ' + (r.json && r.json.error && r.json.error.code) + ')');
      const back = await reqRaw('POST', '/api/config', Buffer.from(JSON.stringify({ providers })), { 'x-wcw-token': TOKEN, 'content-type': 'application/json' });
      ok(back.status === 200, 'F1 还原 providers (status ' + back.status + ')');
      r = await reqAsr('?filename=test.webm', audio1234, 'audio/webm');
      ok(r.status === 200 && r.json && r.json.ok === true, 'F1 还原后 baseUrl 兜底照常 200 (status ' + r.status + ')');
    }

    // G1 filename 清洗:穿越形态回落默认名 audio.webm
    r = await reqAsr('?filename=' + encodeURIComponent('../evil.webm'), audio1234, 'audio/webm');
    ok(r.status === 200 && r.json && /filename=audio\.webm/.test(r.json.text || ''), 'G1 ../evil.webm → 回落 audio.webm (' + JSON.stringify((r.json && r.json.text || '').slice(0, 70)) + ')');

    // ═══ 第三靴:107-A1 chat-audio 协议(45 号文 §9.6.3 真机实测:MiMo/百炼的 ASR 就是这套) ═══
    killp(wb); wb = null; await sleep(300);
    writeConfig({
      providers: [{
        id: 'asr-p', label: 'ASR', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + ASR_PORT,
        apiKey: ASR_FAKE_KEY, model: 'mimo-asr', models: [{ id: 'mimo-asr', label: 'mimo-asr', caps: ['asr'] }],
        asrProtocol: 'chat-audio',
      }],
      asrProviderId: 'asr-p', asrModel: 'mimo-asr',
    });
    wb = spawnWB();
    ok(await waitForHttp(), 'H0 workbench listening (chat-audio)');
    TOKEN = await getToken();
    {
      const status = await reqRaw('GET', '/api/status');
      const p0 = status.json && status.json.config && status.json.config.providers && status.json.config.providers[0];
      ok(!!p0 && p0.asrProtocol === 'chat-audio', 'H1 asrProtocol 过 sanitizeProvider 存活 (' + (p0 && p0.asrProtocol) + ')');
    }
    // H2 wav 成功:打的是 /chat/completions(桩只有那一支给得出 [fake-asr-chat]),回显 mime/字节数/语言
    const wav2048 = Buffer.alloc(2048, 3);
    r = await reqAsr('?filename=voice.wav&language=zh', wav2048, 'audio/wav');
    ok(r.status === 200 && r.json && r.json.ok === true && /\[fake-asr-chat\] model=mimo-asr mime=audio\/wav bytes=2048 lang=zh/.test(r.json.text || ''),
      'H2 chat-audio 成功 → 200,出站是 chat/completions + input_audio data URI (' + JSON.stringify((r.json && r.json.text || '').slice(0, 90)) + ')');
    // H2b usage 映射:chat 回体是 prompt_tokens/completion_tokens → estimated:false,账本记真值
    ok(r.json && r.json.estimated === false, 'H2b chat 回体带 usage → estimated:false (' + (r.json && r.json.estimated) + ')');
    await sleep(400);
    {
      const row = readUsageRows().filter(x => x.note === 'asr').pop();
      ok(!!row && row.inTok === 111 && row.outTok === 7 && row.estimated === false && row.model === 'mimo-asr',
        'H2c 账本按 prompt_tokens/completion_tokens 记真值 (' + JSON.stringify(row && { inTok: row.inTok, outTok: row.outTok, estimated: row.estimated }) + ')');
    }
    // H3 webm 在 chat-audio 上被上游 400 拒(MiMo 实测原话)→ 统一信封 502 + params.status=400。
    // 这条就是「浏览器端必须转 WAV」的理由,钉在这里,谁把转码摘了先来读它。
    r = await reqAsr('?filename=voice.webm', wav2048, 'audio/webm');
    ok(r.status === 502 && r.json && r.json.error && r.json.error.code === 'asr.upstream' && r.json.error.params && r.json.error.params.status === 400
      && /mime type must be one of/.test(String(r.json.error.message || '')),
      'H3 webm → 上游 400 → 502 asr.upstream(params.status=400,原话进信封) (status ' + r.status + ' code ' + (r.json && r.json.error && r.json.error.code) + ')');
    // H4 chat 回体解析不出文本 → asr.bad_response(与 transcriptions 分支同一个码)
    {
      const patch = await reqRaw('POST', '/api/config', Buffer.from(JSON.stringify({ asrModel: 'chatbadshape-asr' })), { 'x-wcw-token': TOKEN, 'content-type': 'application/json' });
      ok(patch.status === 200, 'H4 切 asrModel=chatbadshape-asr (status ' + patch.status + ')');
      r = await reqAsr('?filename=voice.wav', wav2048, 'audio/wav');
      ok(r.status === 502 && r.json && r.json.error && r.json.error.code === 'asr.bad_response',
        'H4 chat 回体没有 choices → 502 asr.bad_response (status ' + r.status + ' code ' + (r.json && r.json.error && r.json.error.code) + ')');
    }
  } catch (e) {
    fail++; console.log('FAIL exception ' + (e && e.stack || e));
  } finally {
    killp(wb); killp(asr); await sleep(200);
    if (process.env.ASR_KEEP_HOME) console.log('[keep-home] ' + HOME); else { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
  console.log(fail ? `ASR TRANSCRIBE E2E: FAIL (${fail})` : 'ASR TRANSCRIBE E2E: ALL PASS');
  process.exit(fail ? 1 : 0);
})();
