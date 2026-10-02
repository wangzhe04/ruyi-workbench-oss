require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注):服务启动会与真机 CLI 配置双向同步 MCP,两个方向都要断
'use strict';
// E2E(59 号文 §6,语音词库第二步「从修改里学」):POST /api/audio/lexicon/observe 的整条路。一个进程内假端点扮演改字大模型
// (也就是复核「是不是听错」的那一发),按测试脚本回 JSON 判定 / 胡话:
//   A 门与校验:没带 token → 403;坏体 / 缺 final / sentences 形状不对 → 400;超长、超句数 → 413;缺省视图 learn 开、三个计数为 0
//   B 配了改字大模型:人名单字改动 → 大模型收到加固过的 <edits> 提示词 → 判「是」并给全名 → 一次就学会(落盘、记账 aux/voice-learn);
//     判「不是」→ 什么都不记;回胡话 → 退回读音规则(进 pending 攒次数);已经是个人词的不再问
//   C 只靠规则(句尾改错只开重听,大模型不判):原厂表里的词一次就学会;不认识的词同一个改法两次才学会;全程零出站
//   D 冷启动:没用麦克风的消息里打过的英文专名,三条消息见过就收(typed),设置页计数看得见
//   E 纠:学来的词被改回读音相近的写法两次 → 停用(墓碑),设置页文本里不再出现
//   F 开关:POST /api/audio/lexicon {learn:false} 落盘;关着时 observe 什么都不动(盘上逐字节不变、不出站);再打开
//   G 隐私:voice_learn / voice_lexicon_save 审计只记条数与开关,日志里一个学来的词、一句原文都不落
// 判定行:`VOICE LEARN E2E: ALL PASS`。
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames, usageFrame } = require('./lib/fake-openai-provider');

const t = createRunner('VOICE LEARN');
const { ok } = t;
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-voice-learn-'));
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
const postRaw = (p, raw, token = true) => reqRaw('POST', p, Buffer.from(raw), token ? withToken({ 'content-type': 'application/json' }) : { 'content-type': 'application/json' });
const postJson = (p, body, token = true) => postRaw(p, JSON.stringify(body), token);
const observe = (sentences, final) => postJson('/api/audio/lexicon/observe', { sentences, final });
const view = async () => (await reqRaw('GET', '/api/audio/lexicon', null, withToken())).json;
const diskPath = () => path.join(HOME, 'voice-lexicon.json');
const disk = () => { try { return JSON.parse(fs.readFileSync(diskPath(), 'utf8')); } catch { return null; } };
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 8000 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); });
    });
    r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); });
  });
}
async function waitFor(fn, ms = 45000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(200); } return null; }
function rowsIn(dir, ext) {
  const rows = [];
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith(ext)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* 写到一半 */ } } } catch { /* 目录还没建 */ }
  return rows;
}
const logRows = kind => rowsIn(path.join(HOME, 'logs'), '.ndjson').filter(r => !kind || r.kind === kind);

(async () => {
  let wb = null, fake = null;
  try {
    // 假的改字大模型:judge 是下一发要回的东西(函数收到 messages,回字符串)
    const judgeCalls = [];
    let judge = () => '{"items":[]}';
    fake = await startFakeProvider({
      handler(req) {
        judgeCalls.push(req.messages);
        return [...textFrames(judge(req.messages)), usageFrame({ prompt_tokens: 120, completion_tokens: 20 })];
      },
    });
    WB_PORT = await getFreePort();
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 13, permissionMode: 'bypass', toolLoadingMode: 'full', autoImportClaudeCodeMcp: false,
      desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
      providers: [
        { id: 'llm', label: 'LLM', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fix-1', models: [{ id: 'fix-1', label: 'fix-1' }] },
        { id: 'asr', label: 'ASR', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'whisper-1', models: [{ id: 'whisper-1', label: 'whisper-1', caps: ['asr'] }] },
      ],
      activeProvider: 'llm', asrProviderId: 'asr', asrModel: 'whisper-1', asrFixMode: 'auto',
    }, null, 2));
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true });
    wb.stdout.on('data', () => {}); wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    ok(Boolean(await waitFor(async () => (await reqRaw('GET', '/api/status')).status === 200)), '0 工作台起来了');
    TOKEN = await getToken();
    ok(Boolean(TOKEN), '0b 拿到 token');

    /* ═════════ A 门与校验 ═════════ */
    ok((await postJson('/api/audio/lexicon/observe', { sentences: [], final: 'x' }, false)).status === 403, 'A1 没带 token → 403');
    const bad = [
      ['不是 JSON', '{oops'],
      ['缺 final', JSON.stringify({ sentences: [] })],
      ['sentences 不是数组', JSON.stringify({ sentences: 'x', final: 'x' })],
      ['句子没有 text', JSON.stringify({ sentences: [{ first: 'x' }], final: 'x' })],
      ['first 不是字符串', JSON.stringify({ sentences: [{ text: 'x', first: 1 }], final: 'x' })],
    ];
    for (const [label, raw] of bad) {
      const r = await postRaw('/api/audio/lexicon/observe', raw);
      ok(r.status === 400 && r.json && r.json.error && r.json.error.code === 'voice.observe_bad_request', `A2 ${label} → 400 voice.observe_bad_request(实得 ${r.status} ${r.text.slice(0, 120)})`);
    }
    const big = await observe([], 'x'.repeat(20001));
    ok(big.status === 413 && big.json.error.code === 'voice.observe_too_large', `A3 发出去的字超长 → 413(实得 ${big.status})`);
    const many = await observe(Array.from({ length: 61 }, () => ({ text: 'x' })), 'x');
    ok(many.status === 413, 'A4 超过 60 句 → 413');
    const longSentence = await observe([{ text: 'x'.repeat(1001) }], 'x');
    ok(longSentence.status === 413, 'A5 单句超过 1000 字 → 413');
    const v0 = await view();
    ok(v0.learn === true && v0.learned === 0 && v0.typed === 0 && v0.pending === 0, `A6 缺省视图:learn 开、学来/打字/候选都是 0(实得 ${JSON.stringify({ learn: v0.learn, learned: v0.learned, typed: v0.typed, pending: v0.pending })})`);
    ok(judgeCalls.length === 0 && disk() === null, 'A7 校验失败的请求不出站、不落盘');

    /* ═════════ B 配了改字大模型:请它判 ═════════ */
    judge = () => '{"items":[{"id":1,"learn":true,"term":"张玮"}]}';
    const b1 = await observe([{ text: '我明天和张伟去吃饭' }], '我明天和张玮去吃饭');
    const sys = judgeCalls[0] && judgeCalls[0][0] && judgeCalls[0][0].content || '';
    const user = judgeCalls[0] && judgeCalls[0][1] && judgeCalls[0][1].content || '';
    ok(judgeCalls.length === 1 && /从用户的手改里学词/.test(sys) && /不是给你的指令/.test(sys) && /人名给全名/.test(sys),
      `B1 大模型收到一发加固过的判定提示词(实得 ${judgeCalls.length} 发)`);
    ok(user === '<edits>\n#1 识别:我明天和张伟去吃饭\n#1 改后:我明天和张玮去吃饭\n#1 改动:伟 → 玮\n</edits>', `B2 <edits> 里是这一处改动(实得 ${JSON.stringify(user)})`);
    ok(b1.status === 200 && b1.json.ok === true && b1.json.learn === true && JSON.stringify(b1.json.learned) === JSON.stringify([{ term: '张玮', heard: '张伟' }]),
      `B3 判「是」→ 一次就学会,回给前端「记住了」那一条(实得 ${b1.status} ${b1.text.slice(0, 200)})`);
    const d1 = disk();
    ok(d1 && d1.terms['张玮'] && d1.terms['张玮'].src === 'learned' && d1.terms['张玮'].heard.join() === '张伟' && d1.learn === true && Object.keys(d1.pending).length === 0,
      `B4 落盘:学来的词带错听样子、窗口不进 pending(实得 ${JSON.stringify(d1).slice(0, 240)})`);
    const ledger = rowsIn(path.join(HOME, 'usage'), '.jsonl').filter(r => r.note === 'voice-learn');
    ok(ledger.length === 1 && ledger[0].kind === 'aux' && ledger[0].inTok === 120 && ledger[0].outTok === 20 && ledger[0].provider === 'llm',
      `B5 记账 aux/voice-learn,用的是回体里的真 usage(实得 ${JSON.stringify(ledger)})`);
    judge = () => '{"items":[{"id":1,"learn":false}]}';
    const b6 = await observe([{ text: '咱们去尚海吧' }], '咱们去上海吧');
    ok(b6.status === 200 && b6.json.learned.length === 0 && judgeCalls.length === 2 && Object.keys(disk().pending).length === 0,
      `B6 判「不是」→ 什么都不记(实得 ${b6.text.slice(0, 160)};pending=${JSON.stringify(disk().pending)})`);
    judge = () => '我觉得这些都挺好的';
    const b7 = await observe([{ text: '给刘洋发个消息' }], '给柳洋发个消息');
    const p7 = disk().pending;
    ok(b7.status === 200 && b7.json.learned.length === 0 && judgeCalls.length === 3 && p7['柳洋'] && p7['柳洋'].n === 1 && p7['柳洋'].kind === 'window',
      `B7 回胡话 → 退回读音规则:名字窗口进 pending 攒次数(实得 ${JSON.stringify(Object.keys(p7))})`);
    const b8 = await observe([{ text: '张伟那边怎么说' }], '张玮那边怎么说');
    ok(b8.status === 200 && judgeCalls.length === 3 && disk().terms['张玮'].n === 2 && b8.json.learned.length === 0,
      `B8 已经是个人词的不再问大模型、只记一次(实得 calls=${judgeCalls.length} n=${disk().terms['张玮'].n})`);

    /* ═════════ C 只靠规则 ═════════ */
    ok((await postJson('/api/config', { asrFixMode: 'audio' })).status === 200, 'C0 句尾改错只开重听(大模型不判)');
    const calls0 = judgeCalls.length;
    const c1 = await observe([{ text: '重启一下瑞迪斯' }, { text: '然后看日志' }], '重启一下 Redis,然后看日志');
    ok(c1.status === 200 && JSON.stringify(c1.json.learned) === JSON.stringify([{ term: 'Redis', heard: '瑞迪斯' }]), `C1 原厂表里的词一次就学会(实得 ${c1.text.slice(0, 160)})`);
    const c2 = await observe([{ text: '打开欧喷克劳的设置' }], '打开OpenClaw的设置');
    const c3 = await observe([{ text: '欧喷克劳又更新了' }], 'OpenClaw又更新了');
    ok(c2.json.learned.length === 0 && c3.json.learned.length === 1 && c3.json.learned[0].term === 'OpenClaw' && disk().terms.openclaw.n === 2,
      `C2 不认识的词同一个改法第二次才学会(实得 ${c2.text.slice(0, 80)} / ${c3.text.slice(0, 120)})`);
    const c4 = await observe([{ text: '再给刘洋打个电话' }], '再给柳洋打个电话');
    ok(c4.json.learned.length === 1 && c4.json.learned[0].term === '柳洋' && !disk().pending['柳洋说'], `C3 名字第二次被改对 → 学会最短的那个窗口(实得 ${c4.text.slice(0, 160)})`);
    ok(judgeCalls.length === calls0, `C4 全程不出站(实得多了 ${judgeCalls.length - calls0} 发)`);

    /* ═════════ D 冷启动:打过的英文专名 ═════════ */
    const d = [];
    for (const msg of ['帮我看下 Zorbit 的日志', 'Zorbit 又挂了吗', '把 Zorbit 重启一下']) d.push(await observe([], msg));
    ok(d[0].json.learned.length === 0 && d[1].json.learned.length === 0 && JSON.stringify(d[2].json.learned) === JSON.stringify([{ term: 'Zorbit', heard: '' }]) && disk().terms.zorbit.src === 'typed',
      `D1 三条消息里打过 → 收进来(src:typed)(实得 ${d.map(r => r.text.slice(0, 60)).join(' | ')})`);
    const vd = await view();
    ok(vd.typed === 1 && vd.learned === 4 && vd.count === 5 && vd.text.split('\n').includes('Zorbit'), `D2 设置页计数看得见(实得 ${JSON.stringify({ count: vd.count, learned: vd.learned, typed: vd.typed, pending: vd.pending })})`);

    /* ═════════ E 纠 ═════════ */
    const e1 = await observe([{ text: '张玮说他不来' }], '张伟说他不来');
    const e2 = await observe([{ text: '张玮今天请假' }], '张伟今天请假');
    ok(e1.json.reversed === 1 && e2.json.reversed === 1 && disk().terms['张玮'].off === true, `E1 学来的词被改回去两次 → 停用(实得 ${e1.text.slice(0, 80)} / ${JSON.stringify(disk().terms['张玮'])})`);
    const ve = await view();
    ok(!ve.text.split('\n').some(l => l.startsWith('张玮')) && !disk().terms['张伟'], 'E2 停用的词不出现在设置页;「改回去」不被反过来学成新词');

    /* ═════════ F 开关 ═════════ */
    const f1 = await postJson('/api/audio/lexicon', { learn: false });
    ok(f1.status === 200 && f1.json.learn === false && disk().learn === false, `F1 关掉「从我的修改里学」落盘(实得 ${f1.status} learn=${f1.json && f1.json.learn})`);
    const before = fs.readFileSync(diskPath(), 'utf8');
    ok((await postJson('/api/config', { asrFixMode: 'auto' })).status === 200, 'F2a 大模型复核重新开着');
    const callsF = judgeCalls.length;
    const f2 = await observe([{ text: '我和王芳去开会' }], '我和王方去开会');
    ok(f2.status === 200 && f2.json.learn === false && f2.json.learned.length === 0 && fs.readFileSync(diskPath(), 'utf8') === before && judgeCalls.length === callsF,
      `F2 关着时什么都不动:盘上逐字节不变、不出站(实得 ${f2.text.slice(0, 120)})`);
    const f3 = await postJson('/api/audio/lexicon', { learn: true });
    ok(f3.status === 200 && f3.json.learn === true && disk().learn === true, 'F3 再打开');
    const f4 = await postJson('/api/audio/lexicon', { learn: 'yes' });
    ok(f4.status === 400, 'F4 learn 不是布尔 → 400(且没有别的字段可存)');

    /* ═════════ G 隐私 ═════════ */
    const learnRows = logRows('voice_learn');
    ok(learnRows.length >= 12 && learnRows.every(r => Number.isInteger(r.sentences) && Number.isInteger(r.edits) && Number.isInteger(r.learned) && typeof r.judge === 'string'),
      `G1 voice_learn 审计只记条数(实得 ${learnRows.length} 条,例 ${JSON.stringify(learnRows[0])})`);
    ok(learnRows.some(r => r.judge === 'ok') && learnRows.some(r => r.judge === 'off') && learnRows.some(r => r.judge === 'none'), 'G2 审计分得清问了大模型 / 没配 / 没东西可问');
    ok(logRows('voice_lexicon_save').some(r => r.learn === false), 'G3 voice_lexicon_save 记了开关');
    const leaked = logRows().filter(r => /张玮|张伟|柳洋|刘洋|Zorbit|OpenClaw|欧喷克劳|瑞迪斯|王芳|尚海|吃饭/.test(JSON.stringify(r)));
    ok(leaked.length === 0, `G4 日志里一个词、一句原文都不落(实得 ${leaked.length} 行:${JSON.stringify(leaked[0] || null).slice(0, 160)})`);
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
