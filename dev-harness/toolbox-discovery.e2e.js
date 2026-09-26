require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注):服务启动会与真机 CLI 配置双向同步 MCP,两个方向都要断
'use strict';
// ruyi-toolbox 组件自动发现端到端(用户 2026-09-21:「如意启动时自动探测本机上有没有,有就自动拉起并自动配置好,
// 开箱即用」→「toolbox 下的都是这样:是 MCP 就自动配上」)。对接面:ruyi-toolbox 仓 docs/00-component-registry.md。
// 登记目录经 RUYI_TOOLBOX_HOME 指到临时目录;「组件」是本文件现写的一个 Node 小服务(真仓里是 Python 的 Qwen3-ASR shim,
// 如意只认登记文件,不关心它是什么语言)。
//   A 发现并拉起:启动后自己起来、端口与父 pid 经环境变量给到、/api/status 如实显示
//   B 自动配置:生成 toolbox-<id> 服务商、带语音识别标记、用户没配过语音识别时自动选中;转写真的打到组件上
//   C 不替用户做主:用户关掉语音识别后重启,不再自动选回来(seen 一次性)
//   D 端口被别人占:换端口拉起,服务商地址跟着变;component 对不上的端口绝不接管
//   E 已经有人起好了:直接接管、不起第二个、退出时不杀它
//   F 停用／总开关:进程被停、服务商条目撤走;再启用又回来
//   G 坏登记文件一律当没装:相对路径、id 与文件名不符、不认识的 schema、命令不存在
//   H MCP 类:并进外部 MCP 清单,内部 id toolbox-<id>
//   I 崩了就地再起:杀掉组件进程之后再转写,如意自己把它拉起来
//   J 如意退出,自己拉起的组件跟着没
// 判定行:`TOOLBOX DISCOVERY E2E: ALL PASS`。
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-toolbox-'));
const TOOLBOX_HOME = path.join(HOME, 'toolbox-home');
const COMPONENTS = path.join(TOOLBOX_HOME, 'components');
const FAKE_DIR = path.join(HOME, 'fake-component');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function killp(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* already gone */ } } }
let WB_PORT = 0, TOKEN = '';

// 假启动器:与 Windows venv 的 python.exe 同形 —— 真服务是它的子进程;收到终止信号就转给子进程;子进程退了它还要晚
// 2.5 秒才退(真机上那一拍更短,但窗口同一个)。
const FAKE_LAUNCHER = `
const cp = require('child_process');
const [script, ...rest] = process.argv.slice(2);
const child = cp.spawn(process.execPath, [script, ...rest], { stdio: 'inherit' });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { try { child.kill(sig); } catch {} setTimeout(() => process.exit(0), 200); });
child.on('exit', code => setTimeout(() => process.exit(code == null ? 1 : code), 2500));
`;
// 假组件:按登记约定 §2.2 行事 —— 端口以环境变量为准、/health 回 component、Whisper 形转写回显、把收到的环境写进一个文件供断言。
const FAKE_SERVICE = `
const http = require('http'), fs = require('fs'), path = require('path');
const port = Number(process.env.FAKE_ASR_PORT || 0);
fs.writeFileSync(path.join(__dirname, 'env-' + process.pid + '.json'), JSON.stringify({ port, parent: process.env.RUYI_TOOLBOX_PARENT_PID || '', extra: process.env.FAKE_EXTRA || '', argv: process.argv.slice(2) }));
let unloads = 0;
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, component: 'fake-asr-component', version: '0.0.1', pid: process.pid, unloads })); }
  // 133:登记的 service.unload 路 —— 如意在用户把整段识别切走时打它;计数经 /health 回给断言看
  if (req.method === 'POST' && req.url === '/v1/unload') { unloads += 1; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, unloaded: true })); }
  if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
    let n = 0; req.on('data', c => { n += c.length; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: '[fake-toolbox-asr] pid=' + process.pid + ' bytes>0=' + (n > 0) })); });
    return;
  }
  res.writeHead(404); res.end('{}');
}).listen(port, '127.0.0.1');
`;
// 130(51 号文):假的【流式】组件 —— 照 docs/02-asr-stream-plan.md §2 的会话 API:开会话／喂块回 partial+finals／finish／DELETE。
// 判据可预测:partial = 累计收到的字节数;每收到 3 块就收口一句 final「句N」;finish 把剩下的收成最后一句。
const FAKE_STREAM = `
const http = require('http'), crypto = require('crypto');
const port = Number(process.env.FAKE_STREAM_PORT || 0);
const sessions = new Map();
http.createServer((req, res) => {
  const j = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
  if (req.url === '/health') return j(200, { ok: true, component: 'fake-stream-component', version: '0.0.1', loaded: true, sessions: sessions.size });
  const m = req.url.match(/^\\/v1\\/stream\\/sessions(?:\\/([0-9a-f]{32})(?:\\/(audio|finish))?)?$/);
  if (!m) return j(404, { error: { message: 'no', type: 'not_found' } });
  let chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
    const body = Buffer.concat(chunks);
    if (req.method === 'POST' && !m[1]) { const id = crypto.randomBytes(16).toString('hex'); let hot = []; try { hot = JSON.parse(body.toString() || '{}').hotwords || []; } catch {} sessions.set(id, { bytes: 0, chunks: 0, finals: 0, hot }); return j(200, { id, sampleRate: 16000 }); }
    const s = sessions.get(m[1]); if (!s) return j(404, { error: { message: 'unknown', type: 'unknown_session' } });
    if (req.method === 'DELETE') { sessions.delete(m[1]); res.writeHead(204); return res.end(); }
    if (m[2] === 'audio') { s.bytes += body.length; s.chunks += 1; const finals = []; if (s.chunks % 3 === 0) { s.finals += 1; finals.push({ text: '句' + s.finals + (s.hot.length ? '[' + s.hot.join(',') + ']' : ''), startMs: s.lastEnd || 0, endMs: Math.round(s.bytes / 32) }); s.lastEnd = Math.round(s.bytes / 32); } return j(200, { partial: 'p' + s.bytes, finals }); }
    if (m[2] === 'finish') { sessions.delete(m[1]); return j(200, { finals: [{ text: '尾句', startMs: s.lastEnd || 0, endMs: Math.round(s.bytes / 32) }] }); }
    j(404, { error: { message: 'no', type: 'not_found' } });
  });
}).listen(port, '127.0.0.1');
`;
// 「别人」:占着端口、/health 也回 200,但 component 对不上。
const startStranger = port => new Promise(resolve => {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, component: 'somebody-else' })); });
  s.listen(port, '127.0.0.1', () => resolve(s));
});

function register(id, patch) {
  fs.mkdirSync(COMPONENTS, { recursive: true });
  const base = {
    schema: 1, id, kind: 'service', name: '假语音识别组件', version: '0.0.1',
    // I1 的真根(Windows CI 偶发 502):venv 的 python.exe 是启动器,/health 报的是它的子进程。这里照样摆一层启动器,
    // 让「真服务死了、启动器晚一拍才退」在每个平台上都成立 —— 修前这一拍里如意认定组件还活着、不去重起。
    run: { command: process.execPath, args: [path.join(FAKE_DIR, 'launcher.js'), path.join(FAKE_DIR, 'service.js'), '--flag'], cwd: FAKE_DIR, env: { FAKE_EXTRA: 'from-manifest' } },
    service: { port: 0, portEnv: 'FAKE_ASR_PORT', health: '/health', component: 'fake-asr-component', unload: '/v1/unload' },
    // 133:多尺寸清单(约定 §2.2 可选字段)—— 缺省那份 + 一份「大的」,各带设置页要显示的 label
    provides: [{ type: 'asr', basePath: '/v1', model: 'fake-local-asr', protocol: 'transcriptions', models: [{ id: 'fake-local-asr', label: '小的（约 2 GB 显存）' }, { id: 'fake-local-asr-big', label: '大的（约 5 GB 显存）' }] }, { type: 'time-travel', basePath: '/v9', model: 'x' }],
    registeredAt: new Date().toISOString(),
  };
  const merged = { ...base, ...patch, run: { ...base.run, ...((patch && patch.run) || {}) }, service: { ...base.service, ...((patch && patch.service) || {}) } };
  fs.writeFileSync(path.join(COMPONENTS, (patch && patch.__file) || (id + '.json')), JSON.stringify(merged, (k, v) => (k === '__file' ? undefined : v), 2));
}
function writeConfig(extra) {
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(Object.assign({
    configSchema: 13, permissionMode: 'bypass', toolLoadingMode: 'full',
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    providers: [], activeProvider: '', asrProviderId: '', asrModel: '',
  }, extra || {}), null, 2));
}
function spawnWB() {
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME, RUYI_TOOLBOX_HOME: TOOLBOX_HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  return wb;
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
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 8000 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); });
    });
    r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); });
  });
}
const status = async () => (await reqRaw('GET', '/api/status', null, { 'x-wcw-token': TOKEN })).json;
const saveConfig = patch => reqRaw('POST', '/api/config', Buffer.from(JSON.stringify(patch)), { 'x-wcw-token': TOKEN, 'content-type': 'application/json' });
const transcribe = () => reqRaw('POST', '/api/audio/transcribe?filename=voice.wav', Buffer.from('RIFF....WAVEfake'), { 'x-wcw-token': TOKEN, 'content-type': 'audio/wav' });
const component = (st, id) => ((st && st.toolbox && st.toolbox.components) || []).find(c => c.id === id) || null;
async function waitFor(fn, ms = 30000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(250); } return null; }
async function bootWB() {
  const wb = spawnWB();
  await waitFor(async () => (await reqRaw('GET', '/api/status')).status === 200, 45000);
  TOKEN = await getToken();
  return wb;
}
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const health = port => new Promise(resolve => {
  const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
  r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
});
const envFiles = () => fs.readdirSync(FAKE_DIR).filter(f => /^env-\d+\.json$/.test(f)).map(f => JSON.parse(fs.readFileSync(path.join(FAKE_DIR, f), 'utf8')));

(async () => {
  let wb = null, stranger = null, manual = null;
  try {
    fs.mkdirSync(FAKE_DIR, { recursive: true });
    fs.writeFileSync(path.join(FAKE_DIR, 'service.js'), FAKE_SERVICE);
    fs.writeFileSync(path.join(FAKE_DIR, 'launcher.js'), FAKE_LAUNCHER);
    fs.writeFileSync(path.join(FAKE_DIR, 'mcp-stub.js'), 'setTimeout(() => {}, 3000);');   // 不说 MCP 话的占位:断言的是「进了清单」
    fs.writeFileSync(path.join(FAKE_DIR, 'stream.js'), FAKE_STREAM);
    WB_PORT = await getFreePort();
    const P1 = await getFreePort();
    const P2 = await getFreePort();
    writeConfig();
    register('fake-asr', { service: { port: P1 } });
    // 130:流式组件(provides asr-stream)。与 fake-asr 并存:两对配置键各自自动选中。
    // 131c:同一个组件同时提供 asr-stream 与 asr(真组件 asr-stream 配了 SenseVoice 就是这个形状)→ 一个服务商、两个带不同标记的模型;
    // 整段识别那对键已被 fake-asr 先占,这里的 asr 只列为候选、不改用户选择。
    register('fake-stream', { name: '假流式识别组件', run: { args: [path.join(FAKE_DIR, 'stream.js')] }, service: { port: P2, portEnv: 'FAKE_STREAM_PORT', component: 'fake-stream-component' }, provides: [{ type: 'asr-stream', basePath: '/v1', model: 'fake-stream-model' }, { type: 'asr', basePath: '/v1', model: 'fake-stream-offline', protocol: 'transcriptions' }] });
    // G 的四份坏登记(从头就在盘上:坏文件不许打断启动,也不许被执行)
    register('bad-relative', { run: { command: 'node' } });
    register('bad-idmismatch', { __file: 'other-name.json' });
    register('bad-schema', { schema: 99 });
    register('bad-missing', { run: { command: path.join(FAKE_DIR, 'no-such.exe') } });
    // H 一个 MCP 类组件(命令存在即可:断言的是「进了清单」,不真去连它)
    register('fake-mcp', { kind: 'mcp', name: '假 MCP 组件', mcp: { transport: 'stdio' }, service: undefined, provides: undefined, run: { args: [path.join(FAKE_DIR, 'mcp-stub.js')] } });

    /* ── A 发现并拉起 ── */
    wb = await bootWB();
    const up = await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    ok(Boolean(up) && up.port === P1 && up.owned === true && up.kind === 'service' && up.provides.join() === 'asr',
      `A1 启动后登记的服务自己起来了:state=running、端口就是登记的那个、是如意拉起的、不认识的能力(time-travel)被跳过(实得 ${JSON.stringify(up)})`);
    const h1 = await health(P1);
    ok(Boolean(h1) && h1.component === 'fake-asr-component', `A2 组件真的在登记端口上应答(实得 ${JSON.stringify(h1)})`);
    const env1 = envFiles()[0] || {};
    ok(env1.port === P1 && /^\d+$/.test(env1.parent) && Number(env1.parent) === wb.pid && env1.extra === 'from-manifest' && JSON.stringify(env1.argv) === JSON.stringify(['--flag']),
      `A3 端口与父进程 pid 经环境变量给到、登记的 env 与 args 原样带上(实得 ${JSON.stringify(env1)},如意 pid=${wb.pid})`);

    /* ── B 自动配置 ── */
    const cfg1 = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    const prov1 = (cfg1.providers || []).find(p => p.id === 'toolbox-fake-asr') || null;
    ok(Boolean(prov1) && prov1.baseUrl === `http://127.0.0.1:${P1}/v1` && !prov1.apiKey && (prov1.models || []).some(m => m.id === 'fake-local-asr' && (m.caps || []).includes('asr')),
      `B1 自动生成服务商 toolbox-fake-asr:地址指着组件、无密钥、模型带语音识别标记(实得 ${JSON.stringify(prov1 && { baseUrl: prov1.baseUrl, models: prov1.models })})`);
    ok(cfg1.asrProviderId === 'toolbox-fake-asr' && cfg1.asrModel === 'fake-local-asr' && (cfg1.toolbox.seen || []).includes('fake-asr'),
      `B2 用户没配过语音识别 → 自动选中它,并记进 seen(实得 asr=${cfg1.asrProviderId}/${cfg1.asrModel} seen=${JSON.stringify(cfg1.toolbox && cfg1.toolbox.seen)})`);
    const t1 = await transcribe();
    ok(t1.status === 200 && /^\[fake-toolbox-asr\] pid=\d+ bytes>0=true$/.test((t1.json && t1.json.text) || ''), `B3 转写真的打到了组件上(实得 ${t1.status} ${t1.text.slice(0, 160)})`);

    /* ── M 133:多尺寸清单 + 切走即卸载 ── */
    const modelsM = (prov1 && prov1.models) || [];
    ok(modelsM.length === 2 && modelsM[0].id === 'fake-local-asr' && modelsM[0].label === '小的（约 2 GB 显存）' && modelsM[1].id === 'fake-local-asr-big' && modelsM[1].label === '大的（约 5 GB 显存）' && modelsM.every(m => (m.caps || []).join() === 'asr'),
      `M1 登记的 provides.models 落成服务商条目里两份带 label 的模型(实得 ${JSON.stringify(modelsM)})`);
    const cmpM = component(await status(), 'fake-asr');
    ok(Boolean(cmpM) && cmpM.state === 'running', 'M1b 组件仍在跑');
    const u0 = ((await health(P1)) || {}).unloads;
    const sw1 = await saveConfig({ asrModel: 'fake-local-asr-big' });
    const u1 = await waitFor(async () => { const h = await health(P1); return h && h.unloads === 1 ? h.unloads : null; }, 8000);
    ok(sw1.status === 200 && u0 === 0 && u1 === 1, `M2 同一组件换到另一份模型 → 立刻打了它的 unload 路一次(实得 ${u0} → ${u1})`);
    const sw2 = await saveConfig({ asrFixMode: 'llm' });
    await sleep(600);
    ok(sw2.status === 200 && ((await health(P1)) || {}).unloads === 1, 'M3 只改别的键(改字方式)→ 不打 unload');
    const sw3 = await saveConfig({ asrProviderId: 'cloud-nope', asrModel: 'whisper-1' });
    const u3 = await waitFor(async () => { const h = await health(P1); return h && h.unloads === 2 ? h.unloads : null; }, 8000);
    ok(sw3.status === 200 && u3 === 2, `M4 换到别的服务商 → 再打一次(实得 ${u3})`);
    await saveConfig({ asrProviderId: 'toolbox-fake-asr', asrModel: 'fake-local-asr', asrFixMode: 'auto' });
    await sleep(600);
    ok(((await health(P1)) || {}).unloads === 2, 'M5 换【回来】不打(原来选的不是它)');
    const cfgM = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(cfgM.asrProviderId === 'toolbox-fake-asr' && cfgM.asrModel === 'fake-local-asr', 'M6 选择已复位,后面的段照旧');

    /* ── K 整份保存不带 toolbox 服务商(用户真机 2026-09-21:设置页草稿是页面加载时的快照,组件晚一两秒才把条目写进配置;
          一次「保存」把它撤掉,语音识别选择随即被清空 —— 日志 config_providers_shrunk lost:['toolbox-asr-shim']) ── */
    const stK = await status();
    const foreignK = (stK.config.providers || []).filter(p => !String(p.id || '').startsWith('toolbox-'));
    const cloudK = { id: 'cloud-x', label: 'Cloud X', type: 'openai-compat', baseUrl: 'https://cloud.invalid/v1', apiKey: 'sk-cloud', model: 'm', models: [{ id: 'm', label: 'm' }] };
    const forgedK = { id: 'toolbox-forged', label: 'forged', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'x', models: [{ id: 'x', label: 'x', caps: ['asr'] }] };
    const saveK = await saveConfig({ providers: [...foreignK, cloudK, forgedK] });
    const cfgK = (saveK.json && saveK.json.config) || {};
    const idsK = (cfgK.providers || []).map(p => p.id);
    ok(saveK.status === 200 && idsK.includes('toolbox-fake-asr') && idsK.includes('cloud-x') && !idsK.includes('toolbox-forged') && cfgK.asrProviderId === 'toolbox-fake-asr' && cfgK.asrModel === 'fake-local-asr',
      `K1 整份保存的 providers 不带 toolbox 服务商 → 服务端把它保住(那个前缀归自动发现所有:改不了、撤不掉)、语音识别选择不被清空;来件伪造的 toolbox- 条目不落盘(实得 ${JSON.stringify(idsK)} asr=${cfgK.asrProviderId}/${cfgK.asrModel})`);
    const cfgKDisk = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    const tK = await transcribe();
    ok((cfgKDisk.providers || []).some(p => p.id === 'toolbox-fake-asr') && !fs.readdirSync(HOME).some(f => f.startsWith('config.json.bak-providers-')) && tK.status === 200 && /fake-toolbox-asr/.test(tK.text),
      `K2 盘上也还在、没触发「缩水」备份、保存之后转写照样打到组件上(实得 ${tK.status},备份文件 ${fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-')).length} 个)`);

    /* ── L 130 流式组件:发现、自动配置、代理路由 ── */
    const upS = await waitFor(async () => { const c = component(await status(), 'fake-stream'); return c && c.state === 'running' ? c : null; });
    const cfgL = await waitFor(async () => { const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); return c.asrStreamProviderId ? c : null; }, 10000);
    const provL = cfgL && (cfgL.providers || []).find(p => p.id === 'toolbox-fake-stream');
    ok(Boolean(upS) && upS.provides.join() === 'asr-stream,asr' && Boolean(provL) && provL.baseUrl === `http://127.0.0.1:${P2}/v1` && (provL.models || []).some(m => m.id === 'fake-stream-model' && (m.caps || []).includes('asr-stream'))
      && (provL.models || []).some(m => m.id === 'fake-stream-offline' && (m.caps || []).join() === 'asr')
      && cfgL.asrStreamProviderId === 'toolbox-fake-stream' && cfgL.asrStreamModel === 'fake-stream-model' && cfgL.asrProviderId === 'toolbox-fake-asr',
      `L1 流式组件被发现并自动配成实时识别端点(模型带 asr-stream 标记),整段识别那一对不受影响(实得 stream=${cfgL && cfgL.asrStreamProviderId}/${cfgL && cfgL.asrStreamModel} asr=${cfgL && cfgL.asrProviderId})`);
    const openL = await reqRaw('POST', '/api/audio/stream/sessions', Buffer.from(JSON.stringify({ hotwords: ['如意', 'x'.repeat(80)] })), { 'x-wcw-token': TOKEN, 'content-type': 'application/json' });
    const sidL = openL.json && openL.json.id;
    ok(openL.status === 200 && /^[0-9a-f]{32}$/.test(String(sidL)) && openL.json.sampleRate === 16000, `L2 开流式会话:拿到本进程发的 32 位 id(实得 ${openL.status} ${openL.text.slice(0, 120)})`);
    const pcm = Buffer.alloc(8000);   // 250 ms 的 16 kHz PCM16
    const a1 = await reqRaw('POST', `/api/audio/stream/sessions/${sidL}/audio`, pcm, { 'x-wcw-token': TOKEN, 'content-type': 'audio/L16; rate=16000' });
    const a2 = await reqRaw('POST', `/api/audio/stream/sessions/${sidL}/audio`, pcm, { 'x-wcw-token': TOKEN, 'content-type': 'application/octet-stream' });
    const a3 = await reqRaw('POST', `/api/audio/stream/sessions/${sidL}/audio`, pcm, { 'x-wcw-token': TOKEN, 'content-type': 'audio/L16; rate=16000' });
    ok(a1.status === 200 && a1.json.partial === 'p8000' && a1.json.finals.length === 0 && a2.status === 200 && a3.status === 200 && a3.json.finals.length === 1 && a3.json.finals[0].text === '句1[如意,' + 'x'.repeat(40) + ']' && a3.json.finals[0].endMs === 750,
      `L3 喂块:partial 与 finals 原样转回,热词经代理传到组件并被截到 40 字(实得 ${a1.status}/${a2.status}/${a3.status} ${a3.text.slice(0, 160)})`);
    const bad1 = await reqRaw('POST', `/api/audio/stream/sessions/${sidL}/audio`, Buffer.alloc(3), { 'x-wcw-token': TOKEN, 'content-type': 'audio/L16; rate=16000' });
    const bad2 = await reqRaw('POST', `/api/audio/stream/sessions/${sidL}/audio`, pcm, { 'x-wcw-token': TOKEN, 'content-type': 'audio/wav' });
    const bad3 = await reqRaw('POST', `/api/audio/stream/sessions/${sidL}/audio`, Buffer.alloc(1024 * 1024 + 2), { 'x-wcw-token': TOKEN, 'content-type': 'audio/L16; rate=16000' });
    const bad4 = await reqRaw('POST', `/api/audio/stream/sessions/${'0'.repeat(32)}/audio`, pcm, { 'x-wcw-token': TOKEN, 'content-type': 'audio/L16; rate=16000' });
    const codeOf = r => String((r.json && r.json.error && r.json.error.code) || '');
    ok(bad1.status === 400 && bad2.status === 400 && bad3.status === 413 && bad4.status === 404 && codeOf(bad3) === 'asr.stream_chunk_too_large' && codeOf(bad4) === 'asr.stream_session_missing',
      `L4 奇数字节 400 / 错 Content-Type 400 / 超 1 MB 413 / 没这个会话 404(实得 ${bad1.status}/${bad2.status}/${bad3.status}/${bad4.status} codes=${codeOf(bad3)}/${codeOf(bad4)})`);
    const finL = await reqRaw('POST', `/api/audio/stream/sessions/${sidL}/finish`, Buffer.alloc(0), { 'x-wcw-token': TOKEN, 'content-type': 'application/octet-stream' });
    const afterL = await reqRaw('POST', `/api/audio/stream/sessions/${sidL}/audio`, pcm, { 'x-wcw-token': TOKEN, 'content-type': 'audio/L16; rate=16000' });
    ok(finL.status === 200 && finL.json.finals.length === 1 && finL.json.finals[0].text === '尾句' && afterL.status === 404, `L5 finish 收尾句、会话随即失效(实得 ${finL.status} ${finL.text.slice(0, 100)} → ${afterL.status})`);
    const openD = await reqRaw('POST', '/api/audio/stream/sessions', Buffer.alloc(0), { 'x-wcw-token': TOKEN, 'content-type': 'application/json' });
    const delD = await reqRaw('DELETE', `/api/audio/stream/sessions/${openD.json.id}`, null, { 'x-wcw-token': TOKEN });
    const delAgain = await reqRaw('DELETE', `/api/audio/stream/sessions/${openD.json.id}`, null, { 'x-wcw-token': TOKEN });
    const noTok = await reqRaw('POST', '/api/audio/stream/sessions', Buffer.alloc(0), { 'content-type': 'application/json' });
    ok(openD.status === 200 && delD.status === 200 && delAgain.status === 404 && (noTok.status === 401 || noTok.status === 403), `L6 DELETE 关会话(再删 404);不带 token 进不来(实得 ${delD.status}/${delAgain.status}/${noTok.status})`);

    /* ── G 坏登记 / H MCP ── */
    const st1 = await status();
    const ids = ((st1.toolbox && st1.toolbox.components) || []).map(c => c.id).sort();
    ok(JSON.stringify(ids) === JSON.stringify(['fake-asr', 'fake-mcp', 'fake-stream']), `G1 四份坏登记(相对路径／id 与文件名不符／不认识的 schema／命令不存在)一律当没装(实得组件 ${JSON.stringify(ids)})`);
    ok(envFiles().length === 1, `G2 坏登记一个都没被执行(组件进程只起过 ${envFiles().length} 个;流式假组件不写 env 文件)`);
    const mcpIds = (st1.mcpServers || st1.externalMcp || []).map(s => s.id);
    const mcpView = component(st1, 'fake-mcp');
    ok(Boolean(mcpView) && mcpView.kind === 'mcp' && mcpView.state === 'registered', `H1 MCP 类组件出现在组件清单里(实得 ${JSON.stringify(mcpView)})`);
    const mcpList = await reqRaw('GET', '/api/mcp/connectors', null, { 'x-wcw-token': TOKEN });
    const listed = JSON.stringify(mcpList.json || {}).includes('toolbox-fake-mcp') || mcpIds.includes('toolbox-fake-mcp');
    ok(listed, `H2 它被并进外部 MCP 清单,内部 id 是 toolbox-fake-mcp(/api/mcp/connectors ${mcpList.status})`);

    /* ── I 崩了就地再起 ── */
    const pidBefore = h1.pid;
    try { process.kill(pidBefore); } catch { /* ignore */ }
    await waitFor(async () => !(await health(P1)), 8000);
    const t2 = await transcribe();
    const h2 = await health(P1);
    ok(t2.status === 200 && Boolean(h2) && h2.pid !== pidBefore, `I1 组件进程被杀之后再转写:如意就地把它重新拉起来、转写成功(旧 pid ${pidBefore} → 新 pid ${h2 && h2.pid},转写 ${t2.status})`);

    /* ── C 不替用户做主 ── */
    await saveConfig({ asrProviderId: '', asrModel: '' });
    killp(wb); await sleep(1500);
    ok(!(await health(P1)), 'J1 如意退出,自己拉起的组件跟着没(端口不再应答)');
    wb = await bootWB();
    await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    await sleep(800);
    const cfg2 = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(cfg2.asrProviderId === '' && cfg2.asrModel === '' && (cfg2.providers || []).some(p => p.id === 'toolbox-fake-asr'),
      `C1 用户关掉语音识别后重启:组件照常拉起、仍是候选,但【不再自动选回来】(实得 asr=${JSON.stringify(cfg2.asrProviderId)})`);
    // C2 条目在盘上被弄丢(模拟 2026-09-21 真机那种「整份保存撤掉它」的老版本,或用户手改 config.json)→ 重启补回 + 重新自动选中。
    killp(wb); await sleep(1200);
    { const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); c.providers = c.providers.filter(p => p.id !== 'toolbox-fake-asr'); fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify(c, null, 2)); }
    wb = await bootWB();
    await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    const cfgC2 = await waitFor(async () => { const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); return c.asrProviderId === 'toolbox-fake-asr' ? c : null; }, 10000);
    ok(Boolean(cfgC2) && (cfgC2.providers || []).some(p => p.id === 'toolbox-fake-asr') && cfgC2.asrModel === 'fake-local-asr',
      `C2 条目在盘上丢了(seen 里却有它)→ 重启补回条目、且重新自动选中(实得 asr=${JSON.stringify(cfgC2 && cfgC2.asrProviderId)})`);
    // C3(131,2026-09-21 真机):组件把【自己的】模型名改了(asr-shim 登记成 auto 后 provides.model 变成 qwen3-asr-auto),用户选的仍是这家
    // → 模型名跟着走(服务商 id 没变,不是「用户换走」);否则设置页那一格显示「不启用」而转写还在打旧名字。
    killp(wb); await sleep(1200);
    register('fake-asr', { service: { port: P1 }, provides: [{ type: 'asr', basePath: '/v1', model: 'fake-local-asr-v2', protocol: 'transcriptions' }, { type: 'time-travel', basePath: '/v9', model: 'x' }] });
    wb = await bootWB();
    await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    const cfgC3 = await waitFor(async () => { const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); return c.asrModel === 'fake-local-asr-v2' ? c : null; }, 10000);
    ok(Boolean(cfgC3) && cfgC3.asrProviderId === 'toolbox-fake-asr' && (cfgC3.providers.find(p => p.id === 'toolbox-fake-asr').models || []).some(m => m.id === 'fake-local-asr-v2'),
      `C3 组件改了自己的模型名 → 选的还是这家,模型名跟着变(实得 ${JSON.stringify(cfgC3 && [cfgC3.asrProviderId, cfgC3.asrModel])})`);
    killp(wb); await sleep(1200);
    register('fake-asr', { service: { port: P1 } });   // 改回原名,后面各段按原判据走
    wb = await bootWB();
    await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    await waitFor(async () => { const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); return c.asrModel === 'fake-local-asr' ? c : null; }, 10000);
    await saveConfig({ asrProviderId: '', asrModel: '' });   // F 段从「用户没配」出发
    const cfg2b = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    cfg2.toolbox = cfg2b.toolbox;

    /* ── F 停用 / 总开关 ── */
    await saveConfig({ toolbox: { autoDiscover: true, disabled: ['fake-asr'], seen: cfg2.toolbox.seen } });
    const stopped = await waitFor(async () => (!(await health(P1)) ? 1 : null), 10000);
    const cfg3 = await waitFor(async () => { const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); return (c.providers || []).some(p => p.id === 'toolbox-fake-asr') ? null : c; }, 10000);
    const stF = await status();
    ok(Boolean(stopped) && Boolean(cfg3) && component(stF, 'fake-asr').state === 'disabled', `F1 逐个停用:进程被停、服务商条目撤走、状态如实显示 disabled(实得 ${JSON.stringify(component(stF, 'fake-asr'))})`);
    await saveConfig({ toolbox: { autoDiscover: true, disabled: [], seen: cfg2.toolbox.seen } });
    const back = await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    ok(Boolean(back) && Boolean(await health(P1)), 'F2 再启用:不用重启如意,组件又被拉起来');
    // 2026-09-21 用户真机:条目被【补回】(再启用／被别的什么弄丢)而用户又没配别的语音识别 → 重新自动选中;
    // 修前 seen 一次性,停用再启用之后语音输入就没了,得自己去设置里再选一次。C1(条目还在、用户亲手关掉)仍然不选回。
    const cfgF2 = await waitFor(async () => { const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); return c.asrProviderId === 'toolbox-fake-asr' ? c : null; }, 10000);
    ok(Boolean(cfgF2) && cfgF2.asrModel === 'fake-local-asr', `F2b 再启用后条目补回 → 用户没配别的语音识别就重新自动选中(实得 asr=${JSON.stringify(cfgF2 && cfgF2.asrProviderId)})`);
    await saveConfig({ asrProviderId: '', asrModel: '' });   // 下面 F3 之后的 D/E 段从全新配置开始,这里只是把选择清回去
    await saveConfig({ toolbox: { autoDiscover: false, disabled: [], seen: cfg2.toolbox.seen } });
    const allOff = await waitFor(async () => (!(await health(P1)) ? 1 : null), 10000);
    const stOff = await status();
    const mcpOff = await reqRaw('GET', '/api/mcp/connectors', null, { 'x-wcw-token': TOKEN });
    ok(Boolean(allOff) && stOff.toolbox.autoDiscover === false && !JSON.stringify(mcpOff.json || {}).includes('toolbox-fake-mcp'),
      'F3 总开关关掉:服务停、MCP 类组件也从清单里撤掉');
    killp(wb); wb = null; await sleep(1200);

    /* ── D 端口被别人占 ── */
    stranger = await startStranger(P1);
    writeConfig();   // 全新配置:总开关回到缺省开
    wb = await bootWB();
    const moved = await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    const cfg4 = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    const prov4 = (cfg4.providers || []).find(p => p.id === 'toolbox-fake-asr') || {};
    ok(Boolean(moved) && moved.port !== P1 && moved.owned === true && prov4.baseUrl === `http://127.0.0.1:${moved.port}/v1`,
      `D1 登记端口被别的服务占着(它的 /health 也回 200,但 component 对不上)→ 不接管它,换端口拉起,服务商地址跟着变(登记 ${P1} → 实际 ${moved && moved.port},地址 ${prov4.baseUrl})`);
    const t4 = await transcribe();
    ok(t4.status === 200 && /fake-toolbox-asr/.test(t4.text), `D2 换了端口之后转写照样通(实得 ${t4.status})`);
    killp(wb); wb = null; await sleep(1200);
    await new Promise(r => stranger.close(r)); stranger = null;

    /* ── E 已经有人起好了 ── */
    manual = cp.spawn(process.execPath, [path.join(FAKE_DIR, 'service.js')], { cwd: FAKE_DIR, env: { ...process.env, FAKE_ASR_PORT: String(P1) }, windowsHide: true, stdio: 'ignore' });
    await waitFor(async () => health(P1), 8000);
    const before = envFiles().length;
    wb = await bootWB();
    const adopted = await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    ok(Boolean(adopted) && adopted.owned === false && adopted.port === P1 && envFiles().length === before,
      `E1 用户自己已经起好了 → 直接接管、不起第二个(实得 ${JSON.stringify(adopted)},新起进程 ${envFiles().length - before} 个)`);
    killp(wb); wb = null; await sleep(1500);
    ok(Boolean(await health(P1)) && pidAlive(manual.pid), 'E2 如意退出时不杀接管来的那个(它是用户自己起的)');
  } catch (error) {
    fail++; console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    killp(wb); killp(manual);
    if (stranger) try { stranger.close(); } catch { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows 句柄迟放 */ }
  }
  console.log(fail ? `TOOLBOX DISCOVERY E2E: FAIL (${fail})` : 'TOOLBOX DISCOVERY E2E: ALL PASS');
  process.exit(fail ? 1 : 0);
})();
