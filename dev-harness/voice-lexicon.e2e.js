require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注):服务启动会与真机 CLI 配置双向同步 MCP,两个方向都要断
'use strict';
// E2E(59 号文,语音词库第一步):个人词 + 原厂常用词 → 三处识别口。一个进程内假端点同时扮演
// 改字大模型(chat/completions)、整段识别(Whisper 形 /v1/audio/transcriptions)、对话型识别(chat-audio)与实时识别会话(/v1/stream/sessions),
// 只看「出站请求里带了什么」:
//   A 门:GET/POST /api/audio/lexicon 没带 token → 403;读到缺省视图(个人词空、原厂表开、≥ 400 条;?base=1 才附原厂表全文)
//   B 写:整份存个人词 → 落盘 <data>/voice-lexicon.json(schema 1)、读回同一份;坏体 400、超长 413、超条数 400 且盘上不变;只开关原厂表
//   C 句尾改错:重听那一发的 multipart 带 prompt(个人词 + 这一句命中的原厂词)、改字那一发的 system/user 带 <glossary>(含错听样子)
//   D 关掉原厂表:改字的词表里只剩个人词,原厂词(debug)不再出现
//   E 词库全空 + 原厂表关:改字提示词里没有 <glossary>、重听那一发不带 prompt 字段(与改动前逐字同形)
//   F 实时识别:前端开会话不给热词 → 上游收到个人词;前端给了 → 用前端的
//   G 整段识别:/api/audio/transcribe 没给 prompt → 带个人词;给了 ?prompt= → 用调用方的
//   H 对话型识别(chat-audio):不带词表(那条路把 prompt 当一段文字塞进对话,没量过不冒险)
//   I 隐私:审计日志只有条数(voice_lexicon_save.terms、asr_fix.glossary),一个词都不落
// 判定行:`VOICE LEXICON E2E: ALL PASS`。
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');

const t = createRunner('VOICE LEXICON');
const { ok } = t;
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-voice-lexicon-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let WB_PORT = 0, TOKEN = '';

function reqRaw(method, p, buf, headers) {
  return new Promise((resolve, reject) => {
    const h = { ...(headers || {}) };
    if (buf && !h['content-length']) h['content-length'] = buf.length;
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers: h, timeout: 30000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { json = null; } resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject); r.on('timeout', () => r.destroy(new Error('timeout')));
    if (buf) r.write(buf); r.end();
  });
}
const withToken = extra => ({ 'x-wcw-token': TOKEN, ...(extra || {}) });
const postJson = (p, body, token = true) => reqRaw('POST', p, Buffer.from(JSON.stringify(body)), token ? withToken({ 'content-type': 'application/json' }) : { 'content-type': 'application/json' });
const getLexicon = (q = '', token = true) => reqRaw('GET', '/api/audio/lexicon' + q, null, token ? withToken() : {});
const saveLexicon = body => postJson('/api/audio/lexicon', body);
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 8000 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); });
    });
    r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); });
  });
}
async function waitFor(fn, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(200); } return null; }
function silentWav(ms) {
  const samples = Math.round(16 * ms), wav = Buffer.alloc(44 + samples * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + samples * 2, 4); wav.write('WAVE', 8); wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}
const multipartField = (raw, name) => { const m = raw.toString('utf8').match(new RegExp('name="' + name + '"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--')); return m ? m[1] : null; };
function logRows(kind) {
  const rows = [], dir = path.join(HOME, 'logs');
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.ndjson')) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* 写到一半 */ } } } catch { /* 目录还没建 */ }
  return kind ? rows.filter(r => r.kind === kind) : rows;
}

(async () => {
  let wb = null, fake = null;
  try {
    // ── 假端点:四种角色,各自记下收到的请求 ──
    const asrCalls = [], streamOpens = [], fixCalls = [], chatAudioCalls = [];
    fake = await startFakeProvider({
      handler(req) {
        const first = req.messages[0] || {};
        if (Array.isArray(first.content)) {   // chat-audio 识别:content 是 [text?, input_audio]
          chatAudioCalls.push(req.body);
          return textFrames('对话型识别的结果');
        }
        fixCalls.push(req.messages);
        return textFrames('把日志级别调成 debug，再问问如意那边。');
      },
      fallback(req, res) {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks);
          if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
            asrCalls.push({ prompt: multipartField(raw, 'prompt'), model: multipartField(raw, 'model') });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ text: '把日志级别调成低报，再问问如艺那边。' }));
            return;
          }
          if (req.method === 'POST' && req.url === '/v1/stream/sessions') {
            let body = {};
            try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch { body = {}; }
            streamOpens.push(body.hotwords);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ id: require('crypto').randomBytes(16).toString('hex'), sampleRate: 16000 }));
            return;
          }
          if (req.method === 'DELETE' && req.url.startsWith('/v1/stream/sessions/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
          res.writeHead(404); res.end();
        });
      },
    });
    WB_PORT = await getFreePort();
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 13, permissionMode: 'bypass', toolLoadingMode: 'full', autoImportClaudeCodeMcp: false,
      desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
      providers: [
        { id: 'llm', label: 'LLM', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fix-1', models: [{ id: 'fix-1', label: 'fix-1' }] },
        { id: 'asr', label: 'ASR', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'whisper-1', models: [{ id: 'whisper-1', label: 'whisper-1', caps: ['asr'] }] },
        { id: 'mimo', label: 'MiMo', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'mimo-asr', asrProtocol: 'chat-audio', models: [{ id: 'mimo-asr', label: 'mimo-asr', caps: ['asr'] }] },
        { id: 'st', label: 'Stream', type: 'openai-compat', baseUrl: fake.url + '/v1', apiKey: '', model: 'zip', models: [{ id: 'zip', label: 'zip', caps: ['asr-stream'] }] },
      ],
      activeProvider: 'llm', asrProviderId: 'asr', asrModel: 'whisper-1', asrStreamProviderId: 'st', asrStreamModel: 'zip', asrFixMode: 'auto',
    }, null, 2));
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true });
    wb.stdout.on('data', () => {}); wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    ok(Boolean(await waitFor(async () => (await reqRaw('GET', '/api/status')).status === 200)), '0 工作台起来了');
    TOKEN = await getToken();
    ok(Boolean(TOKEN), '0b 拿到 token');

    /* ═════════ A 门与缺省视图 ═════════ */
    ok((await getLexicon('', false)).status === 403, 'A1 GET 没带 token → 403');
    ok((await postJson('/api/audio/lexicon', { text: 'x' }, false)).status === 403, 'A2 POST 没带 token → 403');
    const a3 = await getLexicon();
    ok(a3.status === 200 && a3.json.ok === true && a3.json.text === '' && a3.json.count === 0 && a3.json.base.enabled === true && a3.json.base.count >= 400 && a3.json.base.text === undefined,
      `A3 缺省视图:个人词空、原厂表开、≥ 400 条、不附全文(实得 ${a3.status} count=${a3.json && a3.json.count} base=${JSON.stringify(a3.json && a3.json.base && { e: a3.json.base.enabled, n: a3.json.base.count })})`);
    const a4 = await getLexicon('?base=1');
    ok(a4.status === 200 && typeof a4.json.base.text === 'string' && a4.json.base.text.includes('debug = 低报'), 'A4 ?base=1 附原厂表全文(只读展示用)');
    ok(!fs.existsSync(path.join(HOME, 'voice-lexicon.json')), 'A5 只读不落盘');

    /* ═════════ B 写 ═════════ */
    const b1 = await saveLexicon({ text: 'HB360 = 爱趣比三六零\n如意 = 如艺, 如一\n张伟\n???' });
    ok(b1.status === 200 && b1.json.count === 3 && b1.json.skipped === 1 && b1.json.text === 'HB360 = 爱趣比三六零\n如意 = 如艺, 如一\n张伟', `B1 存个人词:3 条、认不出的行计入 skipped(实得 ${b1.status} ${JSON.stringify(b1.json).slice(0, 160)})`);
    const disk = JSON.parse(fs.readFileSync(path.join(HOME, 'voice-lexicon.json'), 'utf8'));
    ok(disk.schema === 1 && disk.base === true && Object.keys(disk.terms).join() === 'hb360,如意,张伟' && disk.terms['如意'].src === 'manual' && disk.terms['如意'].heard.join() === '如艺,如一',
      `B2 落盘 <data>/voice-lexicon.json:schema 1、键是小写词、来源 manual(实得 ${JSON.stringify(disk).slice(0, 200)})`);
    ok((await getLexicon()).json.text === b1.json.text, 'B3 读回同一份');
    const b4 = await saveLexicon({});
    ok(b4.status === 400 && b4.json.error.code === 'voice.lexicon_bad_request', `B4 text/base 都没给 → 400 voice.lexicon_bad_request(实得 ${b4.status})`);
    const b5 = await saveLexicon({ text: 'x'.repeat(40001) });
    ok(b5.status === 413 && b5.json.error.code === 'voice.lexicon_too_large', `B5 文本超长 → 413(实得 ${b5.status})`);
    const before = fs.readFileSync(path.join(HOME, 'voice-lexicon.json'), 'utf8');
    const b6 = await saveLexicon({ text: Array.from({ length: 501 }, (_, i) => '词' + i).join('\n') });
    ok(b6.status === 400 && b6.json.error.code === 'voice.lexicon_too_many' && b6.json.error.params.maxTerms === 500, `B6 超过 500 条 → 400 voice.lexicon_too_many(实得 ${b6.status} ${JSON.stringify(b6.json).slice(0, 120)})`);
    ok(fs.readFileSync(path.join(HOME, 'voice-lexicon.json'), 'utf8') === before, 'B7 整份拒收:盘上一个字节都没变');
    const b8 = await saveLexicon({ base: false });
    ok(b8.status === 200 && b8.json.base.enabled === false && b8.json.count === 3, 'B8 只开关原厂表:个人词不动');
    ok((await saveLexicon({ base: true })).json.base.enabled === true, 'B9 原厂表开回来');

    /* ═════════ C 句尾改错 ═════════ */
    const audio = silentWav(800).toString('base64');
    const c0 = { asr: asrCalls.length, fix: fixCalls.length };
    const c1 = await postJson('/api/audio/correct', { text: '把日志级别调成低报再问问如艺那边', audio, contentType: 'audio/wav', context: '' });
    ok(c1.status === 200 && c1.json.ok === true && c1.json.used.audio === true && c1.json.used.llm === true && c1.json.text === '把日志级别调成 debug，再问问如意那边。',
      `C1 句尾改错照常:重听 + 改字都用上了(实得 ${c1.status} ${JSON.stringify(c1.json).slice(0, 160)})`);
    const asr1 = asrCalls[c0.asr];
    ok(asr1 && typeof asr1.prompt === 'string' && asr1.prompt.split(', ').slice(0, 2).sort().join() === ['debug', '如意'].sort().join() && asr1.prompt.includes('HB360') && asr1.prompt.includes('张伟') && !asr1.prompt.includes('低报'),
      `C2 重听那一发带 prompt:命中的(如意、debug)在前、其余个人词随后、不列错听样子(实得 ${JSON.stringify(asr1 && asr1.prompt)})`);
    const fix1 = fixCalls[c0.fix] || [];
    const sys1 = String((fix1[0] || {}).content || ''), user1 = String((fix1[1] || {}).content || '');
    ok(sys1.includes('<glossary> 标签里是这位用户常说的词') && user1.startsWith('<glossary>\n') && user1.includes('如意 ← 如艺、如一') && user1.includes('debug ← 低报') && user1.includes('HB360 ← 爱趣比三六零') && user1.includes('张伟'),
      `C3 改字那一发带 <glossary>:个人词全在、命中的原厂词 debug 带着错听样子(实得 ${JSON.stringify(user1.slice(0, 200))})`);
    ok(user1.indexOf('</glossary>') < user1.indexOf('<transcript>') && user1.includes('<transcript>A：把日志级别调成低报再问问如艺那边\nB：'), 'C4 词表在转写之前,转写仍是 A/B 两版');

    /* ═════════ D 关掉原厂表 ═════════ */
    await saveLexicon({ base: false });
    const d0 = fixCalls.length;
    const d1 = await postJson('/api/audio/correct', { text: '把日志级别调成低报再问问如艺那边', audio, contentType: 'audio/wav', context: '' });
    const user2 = String(((fixCalls[d0] || [])[1] || {}).content || '');
    ok(d1.status === 200 && user2.includes('如意 ← 如艺、如一') && !user2.includes('debug'), `D1 原厂表关掉:词表里只剩个人词(实得 ${JSON.stringify(user2.slice(0, 160))})`);

    /* ═════════ E 词库全空 + 原厂表关 = 与改动前同形 ═════════ */
    ok((await saveLexicon({ text: '' })).json.count === 0, 'E0 清空个人词');
    const e0 = { asr: asrCalls.length, fix: fixCalls.length };
    const e1 = await postJson('/api/audio/correct', { text: '把日志级别调成低报', audio, contentType: 'audio/wav', context: '' });
    const fix3 = fixCalls[e0.fix] || [];
    ok(e1.status === 200 && !String((fix3[0] || {}).content || '').includes('<glossary>') && String((fix3[1] || {}).content || '').startsWith('<transcript>'), 'E1 没有词:改字提示词里没有 <glossary>');
    ok(asrCalls[e0.asr] && asrCalls[e0.asr].prompt === null, `E2 没有词:重听那一发不带 prompt 字段(实得 ${JSON.stringify(asrCalls[e0.asr])})`);
    await saveLexicon({ text: 'HB360\n如意 = 如艺\n张伟', base: true });

    /* ═════════ F 实时识别的热词 ═════════ */
    const f1 = await postJson('/api/audio/stream/sessions', {});
    ok(f1.status === 200 && f1.json.ok === true && JSON.stringify(streamOpens[streamOpens.length - 1]) === JSON.stringify(['HB360', '如意', '张伟']),
      `F1 前端不给热词 → 上游收到个人词(只个人词、不含原厂词)(实得 ${f1.status} ${JSON.stringify(streamOpens[streamOpens.length - 1])})`);
    if (f1.json && f1.json.id) await reqRaw('DELETE', '/api/audio/stream/sessions/' + f1.json.id, null, withToken());
    const f2 = await postJson('/api/audio/stream/sessions', { hotwords: ['前端给的'] });
    ok(f2.status === 200 && JSON.stringify(streamOpens[streamOpens.length - 1]) === JSON.stringify(['前端给的']), 'F2 前端给了热词 → 用前端的');
    if (f2.json && f2.json.id) await reqRaw('DELETE', '/api/audio/stream/sessions/' + f2.json.id, null, withToken());

    /* ═════════ G 整段识别 ═════════ */
    const g0 = asrCalls.length;
    const g1 = await reqRaw('POST', '/api/audio/transcribe?filename=voice.wav', silentWav(500), withToken({ 'content-type': 'audio/wav' }));
    ok(g1.status === 200 && asrCalls[g0] && asrCalls[g0].prompt === 'HB360, 如意, 张伟', `G1 没给 prompt → 带个人词(实得 ${g1.status} ${JSON.stringify(asrCalls[g0])})`);
    const g2 = await reqRaw('POST', '/api/audio/transcribe?filename=voice.wav&prompt=' + encodeURIComponent('调用方的提示'), silentWav(500), withToken({ 'content-type': 'audio/wav' }));
    ok(g2.status === 200 && asrCalls[g0 + 1] && asrCalls[g0 + 1].prompt === '调用方的提示', 'G2 给了 ?prompt= → 用调用方的');

    /* ═════════ H 对话型识别不带词表 ═════════ */
    ok((await postJson('/api/config', { asrProviderId: 'mimo', asrModel: 'mimo-asr' })).status === 200, 'H0 切到对话型识别(chat-audio)');
    const h0 = chatAudioCalls.length;
    const h1 = await reqRaw('POST', '/api/audio/transcribe?filename=voice.wav', silentWav(500), withToken({ 'content-type': 'audio/wav' }));
    const parts = (((chatAudioCalls[h0] || {}).messages || [])[0] || {}).content || [];
    ok(h1.status === 200 && h1.json.text === '对话型识别的结果' && Array.isArray(parts) && parts.length === 1 && parts[0].type === 'input_audio',
      `H1 chat-audio:只有音频一段,没有词表那段文字(实得 ${h1.status} ${JSON.stringify(parts.map(p => p && p.type))})`);

    /* ═════════ I 隐私 ═════════ */
    const saves = logRows('voice_lexicon_save');
    ok(saves.length >= 5 && saves.every(r => Number.isInteger(r.terms) && typeof r.base === 'boolean'), `I1 审计有 voice_lexicon_save(只记条数与开关;实得 ${saves.length} 条)`);
    const fixes = logRows('asr_fix');
    ok(fixes.some(r => r.glossary >= 4) && fixes.some(r => r.glossary === 0), `I2 asr_fix 记了词表行数(实得 ${JSON.stringify(fixes.map(r => r.glossary))})`);
    const leaked = logRows().filter(r => /HB360|如艺|张伟|爱趣比/.test(JSON.stringify(r)));
    ok(leaked.length === 0, `I3 日志里一个词都不落(实得 ${leaked.length} 行含词条)`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (wb && wb.pid) { try { killOwnTree(wb); } catch { /* 已经退了 */ } }
    if (fake) await fake.close().catch(() => {});
    await sleep(300);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  t.done({ exit: true });
})();
