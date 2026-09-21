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

// 假组件:按登记约定 §2.2 行事 —— 端口以环境变量为准、/health 回 component、Whisper 形转写回显、把收到的环境写进一个文件供断言。
const FAKE_SERVICE = `
const http = require('http'), fs = require('fs'), path = require('path');
const port = Number(process.env.FAKE_ASR_PORT || 0);
fs.writeFileSync(path.join(__dirname, 'env-' + process.pid + '.json'), JSON.stringify({ port, parent: process.env.RUYI_TOOLBOX_PARENT_PID || '', extra: process.env.FAKE_EXTRA || '', argv: process.argv.slice(2) }));
http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, component: 'fake-asr-component', version: '0.0.1', pid: process.pid })); }
  if (req.method === 'POST' && req.url === '/v1/audio/transcriptions') {
    let n = 0; req.on('data', c => { n += c.length; }); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ text: '[fake-toolbox-asr] pid=' + process.pid + ' bytes>0=' + (n > 0) })); });
    return;
  }
  res.writeHead(404); res.end('{}');
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
    run: { command: process.execPath, args: [path.join(FAKE_DIR, 'service.js'), '--flag'], cwd: FAKE_DIR, env: { FAKE_EXTRA: 'from-manifest' } },
    service: { port: 0, portEnv: 'FAKE_ASR_PORT', health: '/health', component: 'fake-asr-component' },
    provides: [{ type: 'asr', basePath: '/v1', model: 'fake-local-asr', protocol: 'transcriptions' }, { type: 'time-travel', basePath: '/v9', model: 'x' }],
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
    fs.writeFileSync(path.join(FAKE_DIR, 'mcp-stub.js'), 'setTimeout(() => {}, 3000);');   // 不说 MCP 话的占位:断言的是「进了清单」
    WB_PORT = await getFreePort();
    const P1 = await getFreePort();
    writeConfig();
    register('fake-asr', { service: { port: P1 } });
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

    /* ── G 坏登记 / H MCP ── */
    const st1 = await status();
    const ids = ((st1.toolbox && st1.toolbox.components) || []).map(c => c.id).sort();
    ok(JSON.stringify(ids) === JSON.stringify(['fake-asr', 'fake-mcp']), `G1 四份坏登记(相对路径／id 与文件名不符／不认识的 schema／命令不存在)一律当没装(实得组件 ${JSON.stringify(ids)})`);
    ok(envFiles().length === 1, `G2 坏登记一个都没被执行(组件进程只起过 ${envFiles().length} 个)`);
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

    /* ── F 停用 / 总开关 ── */
    await saveConfig({ toolbox: { autoDiscover: true, disabled: ['fake-asr'], seen: cfg2.toolbox.seen } });
    const stopped = await waitFor(async () => (!(await health(P1)) ? 1 : null), 10000);
    const cfg3 = await waitFor(async () => { const c = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')); return (c.providers || []).some(p => p.id === 'toolbox-fake-asr') ? null : c; }, 10000);
    const stF = await status();
    ok(Boolean(stopped) && Boolean(cfg3) && component(stF, 'fake-asr').state === 'disabled', `F1 逐个停用:进程被停、服务商条目撤走、状态如实显示 disabled(实得 ${JSON.stringify(component(stF, 'fake-asr'))})`);
    await saveConfig({ toolbox: { autoDiscover: true, disabled: [], seen: cfg2.toolbox.seen } });
    const back = await waitFor(async () => { const c = component(await status(), 'fake-asr'); return c && c.state === 'running' ? c : null; });
    ok(Boolean(back) && Boolean(await health(P1)), 'F2 再启用:不用重启如意,组件又被拉起来');
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
