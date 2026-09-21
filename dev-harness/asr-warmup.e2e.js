require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注):服务启动会与真机 CLI 配置双向同步 MCP,两个方向都要断
'use strict';
// E2E(133f,用户 2026-09-21「标准/重度第一次的语音识别又卡又不准」):POST /api/audio/warmup —— 本地识别模型装好了没、没好就现在装。
//
// 成因(日志实证):toolbox 的 asr-shim 空转时不装载模型,第一发转写才加载,新进程上首句 12–33 s。「组件」是 lib/fake-cold-shim.js:
// 照真 shim 的形状 —— /health 只读且不触发加载、首发请求才加载(可配耗时)、换模型要重载、/v1/unload、可注入失败。
//
//   A 门:没带 token → 403;没配语音识别 → 409 asr.not_configured(前端据此根本不会来问)
//   B 冷:模型没装 → 等它装好才回(耗时 ≥ 加载耗时)、warm:false;组件那头恰好多一次装载、一发转写、文件段 = 1 秒 16 kHz 单声道静音(32044 字节)
//   C 热:再问 → 秒回、warm:true、组件那头没有新的转写(不打扰它)
//   D 不是用户的一次转写:审计里有 asr_warmup、没有 asr_transcribe_ok;usage 账本没有 note:'asr' 的行 ——
//     自带尺子:随后做一发真转写,账本与审计才各多一条(否则「零」可能只是账本读歪了)
//   E 并发合并:卸掉后同时来 3 发 → 组件那头只装一次、只多一发转写,三发都成功(取消再点／两个输入框同时点都不装两遍)
//   F 模型对不上:已装着 fake-small、配置要的是 fake-big(卸载那一发没生效)→ 不当作「已装」→ 换载;再问才是热的
//   G 云端服务商:不是 toolbox- → skipped:'remote' 秒回,组件那头一发没打
//   H 失败:组件回 500 → 502 asr.upstream(信封稳定,不炸);组件恢复后再问就成
//   I 组件崩了:杀掉进程后再问,如意就地把它拉起来、再装模型(与转写同一条路)
// 判定行:`ASR WARMUP E2E: ALL PASS`。
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-asr-warmup-'));
const TOOLBOX_HOME = path.join(HOME, 'toolbox-home');
const COMPONENTS = path.join(TOOLBOX_HOME, 'components');
const FAKE_SHIM = path.join(__dirname, 'lib', 'fake-cold-shim.js');
const LOAD_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function killp(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* already gone */ } } }
let WB_PORT = 0, FAKE_PORT = 0, TOKEN = '';

function reqRaw(method, p, buf, headers, port) {
  return new Promise((resolve, reject) => {
    const h = { ...(headers || {}) };
    if (buf && !h['content-length']) h['content-length'] = buf.length;
    const r = http.request({ host: '127.0.0.1', port: port || WB_PORT, path: p, method, headers: h, timeout: 60000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const body = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(body); } catch { j = null; } resolve({ status: res.statusCode, json: j, text: body }); });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (buf) r.write(buf); r.end();
  });
}
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 8000 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); });
    });
    r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); });
  });
}
const withToken = extra => ({ 'x-wcw-token': TOKEN, ...(extra || {}) });
const warmup = (token = true) => reqRaw('POST', '/api/audio/warmup', Buffer.from('{}'), token ? withToken({ 'content-type': 'application/json' }) : { 'content-type': 'application/json' });
const saveConfig = patch => reqRaw('POST', '/api/config', Buffer.from(JSON.stringify(patch)), withToken({ 'content-type': 'application/json' }));
const getConfig = async () => ((await reqRaw('GET', '/api/status', null, withToken())).json || {}).config || {};
const fakeHealth = async () => (await reqRaw('GET', '/health', null, {}, FAKE_PORT).catch(() => ({}))).json;
const fakeControl = q => reqRaw('POST', '/control?' + q, Buffer.alloc(0), { 'content-length': '0' }, FAKE_PORT);
const fakeUnload = () => reqRaw('POST', '/v1/unload', Buffer.alloc(0), { 'content-length': '0' }, FAKE_PORT);
async function waitFor(fn, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(200); } return null; }
function readNdjson(dir, ext) {
  const rows = [];
  try { for (const f of fs.readdirSync(dir)) if (f.endsWith(ext)) for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!l.trim()) continue; try { rows.push(JSON.parse(l)); } catch { /* 写到一半 */ } } } catch { /* 目录还没建 */ }
  return rows;
}
const logRows = kind => readNdjson(path.join(HOME, 'logs'), '.ndjson').filter(r => r.kind === kind);
const asrLedgerRows = () => readNdjson(path.join(HOME, 'usage'), '.jsonl').filter(r => r && r.note === 'asr');

(async () => {
  let wb = null;
  try {
    WB_PORT = await getFreePort();
    FAKE_PORT = await getFreePort();
    fs.mkdirSync(COMPONENTS, { recursive: true });
    fs.writeFileSync(path.join(COMPONENTS, 'fake-cold.json'), JSON.stringify({
      schema: 1, id: 'fake-cold', kind: 'service', name: '假冷启动识别组件', version: '0.0.1',
      run: { command: process.execPath, args: [FAKE_SHIM], cwd: path.dirname(FAKE_SHIM), env: { FAKE_COLD_LOAD_MS: String(LOAD_MS) } },
      service: { port: FAKE_PORT, portEnv: 'FAKE_ASR_PORT', health: '/health', component: 'fake-cold-shim', unload: '/v1/unload' },
      provides: [{ type: 'asr', basePath: '/v1', model: 'fake-auto', protocol: 'transcriptions', models: [{ id: 'fake-auto', label: '自动' }, { id: 'fake-small', label: '小' }, { id: 'fake-big', label: '大' }] }],
      registeredAt: new Date().toISOString(),
    }, null, 2));
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
      configSchema: 13, permissionMode: 'bypass', toolLoadingMode: 'full', autoImportClaudeCodeMcp: false,
      desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false }, providers: [], activeProvider: '', asrProviderId: '', asrModel: '',
    }, null, 2));
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME, RUYI_TOOLBOX_HOME: TOOLBOX_HOME }, windowsHide: true });
    wb.stdout.on('data', () => {}); wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    ok(Boolean(await waitFor(async () => (await reqRaw('GET', '/api/status')).status === 200, 45000)), '0 工作台起来了');
    TOKEN = await getToken();
    ok(Boolean(TOKEN), '0b 拿到 token');
    ok(Boolean(await waitFor(async () => (await fakeHealth()).component === 'fake-cold-shim', 30000)), '0c 假冷启动组件被如意拉起(登记经 RUYI_TOOLBOX_HOME)');
    const picked = await waitFor(async () => { const c = await getConfig(); return c.asrProviderId === 'toolbox-fake-cold' && c.asrModel === 'fake-auto' ? c : null; }, 15000);
    ok(Boolean(picked), '0d 语音识别自动选中假组件(toolbox-fake-cold / fake-auto)');
    const h0 = await fakeHealth();
    ok(h0 && h0.loaded === false && h0.loads === 0 && h0.calls === 0, `0e 起来时模型没装(/health 不触发加载;实得 ${JSON.stringify(h0 && { loaded: h0.loaded, loads: h0.loads, calls: h0.calls })})`);

    /* ═════════ A 门 ═════════ */
    const a1 = await warmup(false);
    ok(a1.status === 403, `A1 没带 token → 403(token 级路由;实得 ${a1.status})`);
    const off = await saveConfig({ asrProviderId: '', asrModel: '' });
    ok(off.status === 200, `A2a 暂时清空语音识别配置(实得 ${off.status})`);
    const a2 = await warmup();
    ok(a2.status === 409 && a2.json && a2.json.error && a2.json.error.code === 'asr.not_configured', `A2 没配语音识别 → 409 asr.not_configured(实得 ${a2.status} ${a2.text.slice(0, 120)})`);
    const back = await saveConfig({ asrProviderId: 'toolbox-fake-cold', asrModel: 'fake-auto' });
    ok(back.status === 200, `A2b 配回(实得 ${back.status})`);
    await fakeUnload();   // 上面这一来一回会触发「切走即卸载」;此刻组件本来就没装,清一下计数口径
    const base = await fakeHealth();

    /* ═════════ B 冷 ═════════ */
    const t0 = Date.now();
    const b1 = await warmup();
    const bMs = Date.now() - t0;
    ok(b1.status === 200 && b1.json && b1.json.ok === true && b1.json.ready === true && b1.json.warm === false, `B1 冷:200 ready:true warm:false(实得 ${b1.status} ${b1.text.slice(0, 120)})`);
    ok(bMs >= LOAD_MS - 100, `B2 等它装好才回(耗时 ${bMs} ms ≥ 加载 ${LOAD_MS} ms)`);
    const h1 = await fakeHealth();
    ok(h1.loaded === true && h1.loads === base.loads + 1 && h1.calls === base.calls + 1, `B3 组件那头恰好多一次装载、一发转写(loads ${base.loads}→${h1.loads} calls ${base.calls}→${h1.calls})`);
    ok(h1.lastFileBytes === 44 + 32000 && h1.lastModel === 'fake-auto', `B4 探针是 1 秒 16 kHz 单声道静音(文件段 ${h1.lastFileBytes} 字节 = 44+32000)、带的是配置里的模型名(${h1.lastModel})`);

    /* ═════════ C 热 ═════════ */
    const t1 = Date.now();
    const c1 = await warmup();
    const cMs = Date.now() - t1;
    const h2 = await fakeHealth();
    ok(c1.status === 200 && c1.json.ready === true && c1.json.warm === true, `C1 热:warm:true(实得 ${c1.text.slice(0, 120)})`);
    // 墙钟上界豁免：热路径只是一次 /health 探测，正常实得约 13–15 ms、界 800 ms；失败形态是走成了冷路径，要等满 1500 ms 的加载耗时，差两个数量级。
    ok(cMs < 800 && h2.calls === h1.calls && h2.loads === h1.loads, `C2 秒回(${cMs} ms)且没打扰组件(calls ${h1.calls}→${h2.calls} loads ${h1.loads}→${h2.loads})`);

    /* ═════════ D 不是用户的一次转写 ═════════ */
    const warmLogs = logRows('asr_warmup');
    ok(warmLogs.length >= 2 && warmLogs.some(r => r.warm === false && r.ok === true) && warmLogs.some(r => r.warm === true), `D1 审计里有 asr_warmup(冷 ok + 热;实得 ${warmLogs.length} 条)`);
    ok(logRows('asr_transcribe_ok').length === 0 && asrLedgerRows().length === 0, `D2 预热不记 asr_transcribe_ok、不进账本(ok=${logRows('asr_transcribe_ok').length} ledger=${asrLedgerRows().length})`);
    const real = await reqRaw('POST', '/api/audio/transcribe?filename=voice.wav', Buffer.from('RIFF....WAVEfake'), withToken({ 'content-type': 'audio/wav' }));
    ok(real.status === 200 && /\[fake-cold\]/.test((real.json && real.json.text) || ''), `D3a 自带尺子:一发真转写成功(实得 ${real.status})`);
    await sleep(300);
    ok(logRows('asr_transcribe_ok').length === 1 && asrLedgerRows().length === 1, `D3 真转写才记:审计 ${logRows('asr_transcribe_ok').length} 条、账本 ${asrLedgerRows().length} 行(读法有效)`);

    /* ═════════ E 并发合并 ═════════ */
    await fakeUnload();
    const e0 = await fakeHealth();
    const many = await Promise.all([warmup(), warmup(), warmup()]);
    const e1 = await fakeHealth();
    ok(many.every(r => r.status === 200 && r.json.ready === true && r.json.warm === false), `E1 三发并发都成功、都是冷(实得 ${many.map(r => r.status + ':' + (r.json && r.json.warm)).join(' ')})`);
    ok(e1.loads === e0.loads + 1 && e1.calls === e0.calls + 1, `E2 组件那头只装一次、只多一发转写(loads ${e0.loads}→${e1.loads} calls ${e0.calls}→${e1.calls})`);

    /* ═════════ F 模型对不上 ═════════ */
    await fakeControl('ignoreUnload=1');           // 卸载那一发装作成功、其实没卸:组件仍装着 fake-small
    const f0 = await fakeHealth();
    const swap = await saveConfig({ asrModel: 'fake-big' });   // 触发如意的「切走即卸载」,被组件忽略
    ok(swap.status === 200, `F0 配置改要 fake-big(实得 ${swap.status})`);
    const f1pre = await waitFor(async () => (await fakeHealth()).unloads > f0.unloads, 5000);
    ok(Boolean(f1pre), 'F1 如意确实打了 unload(被组件忽略)');
    const fh = await fakeHealth();
    ok(fh.loaded === true && fh.resolvedModel === 'fake-small', `F2 此刻组件仍装着 fake-small(实得 loaded=${fh.loaded} resolved=${fh.resolvedModel})`);
    const f3 = await warmup();
    const fh2 = await fakeHealth();
    ok(f3.status === 200 && f3.json.warm === false && fh2.resolvedModel === 'fake-big' && fh2.loads === fh.loads + 1, `F3 装的不是要的那份 → 不当作已装、换载(warm=${f3.json && f3.json.warm} resolved=${fh2.resolvedModel} loads ${fh.loads}→${fh2.loads})`);
    const f4 = await warmup();
    ok(f4.status === 200 && f4.json.warm === true, `F4 换载之后再问才是热的(warm=${f4.json && f4.json.warm})`);
    await fakeControl('ignoreUnload=0');
    await saveConfig({ asrModel: 'fake-auto' });

    /* ═════════ G 云端服务商 ═════════ */
    const cfg = await getConfig();
    const plain = { id: 'plain-asr', label: 'Plain', type: 'openai-compat', baseUrl: `http://127.0.0.1:${FAKE_PORT}/v1`, apiKey: 'k', model: 'whisper-1', models: [{ id: 'whisper-1', label: 'whisper-1', caps: ['asr'] }] };
    const g0 = await saveConfig({ providers: [...(cfg.providers || []), plain], asrProviderId: 'plain-asr', asrModel: 'whisper-1' });
    ok(g0.status === 200, `G0 配一个非 toolbox 的语音识别服务商(实得 ${g0.status})`);
    const gBefore = await fakeHealth();
    const g1 = await warmup();
    const gAfter = await fakeHealth();
    ok(g1.status === 200 && g1.json.ready === true && g1.json.skipped === 'remote' && gAfter.calls === gBefore.calls, `G1 云端服务商 → skipped:'remote' 秒回、组件那头一发没打(实得 ${g1.text.slice(0, 100)} calls ${gBefore.calls}→${gAfter.calls})`);
    const g2 = await saveConfig({ asrProviderId: 'toolbox-fake-cold', asrModel: 'fake-auto' });
    ok(g2.status === 200, `G2 配回假组件(实得 ${g2.status})`);

    /* ═════════ H 失败 ═════════ */
    await fakeUnload();
    await fakeControl('fail=1');
    const h1r = await warmup();
    ok(h1r.status === 502 && h1r.json && h1r.json.ok === false && h1r.json.error && h1r.json.error.code === 'asr.upstream', `H1 组件回 500 → 502 asr.upstream 信封(实得 ${h1r.status} ${h1r.text.slice(0, 140)})`);
    const h2r = await warmup();
    ok(h2r.status === 200 && h2r.json.ready === true && h2r.json.warm === false, `H2 组件恢复后再问就成(失败没有留下脏状态;实得 ${h2r.status} ${h2r.text.slice(0, 100)})`);

    /* ═════════ I 组件崩了 ═════════ */
    const before = await fakeHealth();
    try { process.kill(before.pid); } catch { /* 已没了 */ }
    ok(Boolean(await waitFor(async () => !(await fakeHealth()), 8000)), 'I1 假组件进程被杀,端口不再应答');
    const i2 = await warmup();
    ok(i2.status === 200 && i2.json.ready === true && i2.json.warm === false, `I2 就地把它拉起来再装模型(实得 ${i2.status} ${i2.text.slice(0, 120)})`);
    const after = await fakeHealth();
    ok(Boolean(after) && after.pid !== before.pid && after.loaded === true, `I3 是新进程(pid ${before.pid}→${after && after.pid})且模型已装`);
  } catch (error) {
    fail++; console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    console.log('\nASR WARMUP E2E: ' + (fail === 0 ? 'ALL PASS' : `FAIL (${fail})`));
    killp(wb);
    await sleep(500);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
    process.exit(fail === 0 ? 0 : 1);
  }
})();
