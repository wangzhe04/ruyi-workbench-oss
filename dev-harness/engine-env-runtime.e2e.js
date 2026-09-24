require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(服务启动会同步 MCP 到 CLI 全局配置,见 lib 头注)
// E2E(145-W3):ripgrep 真可用 + 引擎运行环境说明真送达。两台工作台(provider 一台、fake Claude CLI 一台)。
//
// 用户 2026-09-24:「现在的 RipGrep 和 Mermaid 在如意启动后会自动注册吗,疑似至少 ripgrep 不会」。
// 取证结论:随包 rg.exe 在 app/vendor-bin,而修前 probeRg 找的是 appRoot()/vendor-bin(产品根下,不存在),
// 模型开的 shell/Bash 子进程 PATH 里也没有它 —— 在终端里敲 rg 是 command not found。
// 服务子进程用一条【去掉了所有含 rg 的目录】的 PATH 起(机器上本来装的 rg 一律不可见,RUYI_RG_PATH 也删掉),
// 于是能跑通的 rg 只可能是随包那一份:
//   (A) /api/status 首次调用:binaries.rg=true、rgSource='bundled';体检里 search-ripgrep 报 bundled、
//       diagram-renderer 报 mermaid 随包;并且整个启动+首个 status 期间【没有任何一次同步 spawn rg】
//       (--require 预载记下每一次 spawnSync/execFileSync/execSync 起 rg 的调用,不论耗时 —— 修前 hasRg()
//       冷缓存在请求路径上 spawnSync rg --version)。
//   (B) fake provider 回合里:powershell_run 跑 `rg --version` 成功(stdout 含 ripgrep);shell_start 起的
//       交互 shell 里 shell_send `rg --version` 同样成功。能力行/稳定层如实写了「终端里也可直接用 rg」与 mermaid 成图。
//   (C) fake Claude CLI:--append-system-prompt 以用户 append 开头、紧跟 <ruyi-environment>(Claude Code 变体,
//       随包 rg、mermaid);CLI 子进程 PATH 第一项就是 vendor-bin;连续两个回合环境说明逐字节相同、meta 指纹相同。
const { killOwnTree } = require('./lib/kill-own-tree');
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const VENDOR_BIN = path.join(WB, 'app', 'vendor-bin');
const RG_NAME = process.platform === 'win32' ? 'rg.exe' : 'rg';
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const ROOT_TMP = path.join(os.tmpdir(), 'wcw-engine-env-runtime-e2e');
const HOME_P = path.join(ROOT_TMP, 'provider');
const HOME_C = path.join(ROOT_TMP, 'claude');
const WORK = path.join(ROOT_TMP, 'work');
const SPAWN_LOG = path.join(ROOT_TMP, 'sync-spawn.ndjson');
const PRELOAD = path.join(ROOT_TMP, 'record-sync-rg.js');
const CAPTURE = path.join(ROOT_TMP, 'captures');
const ARGV_CAP = path.join(ROOT_TMP, 'argv.json');
const ENV_CAP = path.join(ROOT_TMP, 'env.json');
const MARKER = 'ENVBRIEF_USER_MARKER_Q7';

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 30000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
// PATH without any directory that holds an rg executable: the only rg the server can find is the bundled one.
// 覆盖写回 process.env 里 PATH 的【原键名】(Windows 上通常是 Path;两个大小写键并存时子进程拿哪个不确定),
// RUYI_RG_PATH 置空(服务端 trim 后视同未设)。spawn 处仍是 { ...process.env, ...} 一条来路(fixture-home 锁)。
const PATH_KEY = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
function rgFreeEnvOverrides() {
  const kept = String(process.env[PATH_KEY] || '').split(path.delimiter).filter(dir => {
    const d = String(dir || '').trim().replace(/^"|"$/g, '');
    if (!d) return false;
    try { return !fs.existsSync(path.join(d, RG_NAME)); } catch { return true; }
  });
  return { [PATH_KEY]: kept.join(path.delimiter), RUYI_RG_PATH: '' };
}
const sameDir = (a, b) => path.resolve(String(a || '')).toLowerCase() === path.resolve(String(b || '')).toLowerCase();

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  const [FAKE_PORT, WB_PORT, WB_PORT_C] = await Promise.all([getFreePort(), getFreePort(), getFreePort()]);
  try {
    fs.rmSync(ROOT_TMP, { recursive: true, force: true });
    for (const d of [HOME_P, HOME_C, WORK, CAPTURE]) fs.mkdirSync(d, { recursive: true });
    ok(fs.existsSync(path.join(VENDOR_BIN, RG_NAME)), 'A0 随包 app/vendor-bin/' + RG_NAME + ' 在仓里');
    // 预载:记下服务进程里【每一次】同步起 rg 的调用(不设耗时门槛,修前那一发 rg --version 常常 <50ms)。
    fs.writeFileSync(PRELOAD, [
      "'use strict';",
      "const fs = require('fs'), path = require('path'), cp = require('child_process');",
      'const out = process.env.RECORD_SYNC_RG_OUT;',
      "if (out && /server\\.js/.test(process.argv.join(' '))) {",
      "  for (const name of ['spawnSync', 'execFileSync', 'execSync']) {",
      '    const orig = cp[name];',
      '    cp[name] = function (...args) {',
      "      const cmd = String(args[0] || ''); const argv = Array.isArray(args[1]) ? args[1].map(String) : [];",
      "      if (/(^|[\\\\/])rg(\\.exe)?$/i.test(cmd) || argv.some(a => /(^|[\\\\/])rg(\\.exe)?\"?$/i.test(a))) {",
      "        try { fs.appendFileSync(out, JSON.stringify({ kind: name, cmd, argv: argv.slice(0, 6), stack: String(new Error().stack).split('\\n').slice(2, 8) }) + '\\n'); } catch {}",
      '      }',
      '      return orig.apply(this, args);',
      '    };',
      '  }',
      '}',
    ].join('\n'));

    /* ═══════════ (A)(B) provider 一台 ═══════════ */
    fs.writeFileSync(path.join(HOME_P, 'config.json'), JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass', toolLoadingMode: 'full', shellSessionMax: 3,
      workspaces: [{ path: WORK, read: true, write: true, execute: true }],
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
      activeProvider: 'fake',
    }, null, 2));
    const seq = JSON.stringify([
      { name: 'powershell_run', args: { command: 'rg --version', timeoutMs: 30000 } },
      { name: 'shell_start', args: { shellId: 'rgshell' } },
      { name: 'shell_send', args: { shellId: 'rgshell', input: 'rg --version' } },
    ]);
    const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seq, FAKE_CAPTURE_DIR: CAPTURE }, windowsHide: true });
    fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
    const wb = cp.spawn(process.execPath, ['--require', PRELOAD, 'app/server.js', 'serve', '--port', String(WB_PORT)], {
      cwd: WB, windowsHide: true,
      env: { ...process.env, ...rgFreeEnvOverrides(), WIN_CLAUDE_WORKBENCH_HOME: HOME_P, RUYI_HOME: HOME_P, RECORD_SYNC_RG_OUT: SPAWN_LOG },
    });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    procs.push(fake, wb);
    let h = null; for (let i = 0; i < 60 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'A1 provider workbench up (PATH 里没有任何系统 rg)');

    const status = await getJson(WB_PORT, '/api/status');
    ok(status && status.binaries && status.binaries.rg === true && status.binaries.rgSource === 'bundled',
      'A2 /api/status 首次调用:binaries.rg=true 且来源 bundled (' + JSON.stringify(status && status.binaries) + ')');
    const healthRows = (status && status.health) || [];
    const rgRow = healthRows.find(r => r && r.id === 'search-ripgrep');
    ok(rgRow && rgRow.ok === true && /^bundled: /.test(rgRow.detail) && /shell: bundled/.test(rgRow.detail),
      'A3 体检 search-ripgrep 报随包来源且终端可用 (' + JSON.stringify(rgRow) + ')');
    const mmRow = healthRows.find(r => r && r.id === 'diagram-renderer');
    ok(mmRow && mmRow.ok === true && /^present: /.test(mmRow.detail), 'A4 体检 diagram-renderer 报 mermaid 随包 (' + JSON.stringify(mmRow) + ')');
    const syncRg = fs.existsSync(SPAWN_LOG) ? fs.readFileSync(SPAWN_LOG, 'utf8').split('\n').filter(Boolean) : [];
    ok(syncRg.length === 0, 'A5 启动 + 首个 /api/status 期间没有一次同步 spawn rg(修前 hasRg() 冷缓存 spawnSync)' + (syncRg.length ? ' — ' + syncRg[0].slice(0, 300) : ''));

    const events = await postStream(WB_PORT, { message: '在终端里运行 rg --version 看看 ripgrep 能不能用', cwd: WORK });
    const results = events.filter(e => e.type === 'tool_result');
    const ps = results[0] && results[0].content;
    ok(ps && ps.ok === true && /ripgrep \d+\.\d+/.test(String(ps.stdout || '')),
      'B1 powershell_run `rg --version` 成功 (' + JSON.stringify(ps && { ok: ps.ok, stdout: String(ps.stdout || '').slice(0, 60), stderr: String(ps.stderr || '').slice(0, 120) }) + ')');
    const sendRes = results[2] && results[2].content;
    ok(sendRes && sendRes.ok === true && /ripgrep \d+\.\d+/.test(String(sendRes.output || '')),
      'B2 shell_start 起的交互 shell 里 `rg --version` 成功 (' + JSON.stringify(String(sendRes && (sendRes.output || sendRes.error) || '').slice(0, 160)) + ')');
    const reqFiles = fs.existsSync(CAPTURE) ? fs.readdirSync(CAPTURE).filter(f => /^req-\d+\.json$/.test(f)).sort() : [];
    // 取第一发【主回合】请求(带 tools 的那一发);线程起名那一发是旁路小请求,不带工具也不带环境说明。
    const firstReq = reqFiles.map(f => JSON.parse(fs.readFileSync(path.join(CAPTURE, f), 'utf8'))).find(j => j && Array.isArray(j.tools) && j.tools.length) || null;
    const sysMsg = firstReq && (firstReq.messages || []).find(m => m && m.role === 'system');
    const userMsg = firstReq && (firstReq.messages || []).find(m => m && m.role === 'user');
    const userText = userMsg ? (typeof userMsg.content === 'string' ? userMsg.content : (userMsg.content || []).map(p => (p && p.text) || '').join('\n')) : '';
    ok(sysMsg && String(sysMsg.content).includes('```mermaid') && !/<ruyi-environment>/.test(String(sysMsg.content)),
      'B3 provider 稳定层带 mermaid 成图一句(且不拿 CLI 的整段围栏)');
    ok(/终端里也可直接用 rg/.test(userText) && /权限：当前是「全自动」模式/.test(userText),
      'B4 provider 易变层:能力行写明终端可直接用 rg + 当前权限档含义');
    for (const c of procs.splice(0)) { try { killOwnTree(c); } catch { /* ignore */ } }
    await sleep(300);

    /* ═══════════ (C) fake Claude CLI 一台 ═══════════ */
    fs.writeFileSync(path.join(HOME_C, 'config.json'), JSON.stringify({
      configSchema: 9, version: '1.0.0', permissionMode: 'bypass', engineMode: 'print',
      appendSystemPrompt: MARKER + ' 用户自定义附加提示。',
      workspaces: [{ path: WORK, read: true, write: true, execute: true }],
    }, null, 2));
    const wbC = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT_C)], {
      cwd: WB, windowsHide: true,
      env: { ...process.env, ...rgFreeEnvOverrides(), WIN_CLAUDE_WORKBENCH_HOME: HOME_C, RUYI_HOME: HOME_C, USERPROFILE: HOME_C, HOME: HOME_C, WCW_FAKE_CLAUDE: FAKE_CLAUDE, WCW_FAKE_ARGV_CAPTURE: ARGV_CAP, WCW_FAKE_ENV_CAPTURE: ENV_CAP },
    });
    wbC.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wbC!] ' + l.trim())));
    procs.push(wbC);
    let hc = null; for (let i = 0; i < 60 && !hc; i++) { await sleep(150); hc = await health(WB_PORT_C); }
    ok(!!hc, 'C0 fake-Claude workbench up');
    const turn = async message => {
      const evts = await postStream(WB_PORT_C, { message, cwd: WORK });
      let argv = [];
      try { argv = JSON.parse(fs.readFileSync(ARGV_CAP, 'utf8')); } catch { argv = []; }
      const ai = argv.indexOf('--append-system-prompt');
      const meta = evts.find(e => e && e.type === 'meta');
      return { evts, append: ai >= 0 ? String(argv[ai + 1] || '') : '', meta };
    };
    const t1 = await turn('你好,说一下你在什么环境里');
    const open = t1.append.indexOf('<ruyi-environment>');
    const close = t1.append.indexOf('</ruyi-environment>');
    ok(t1.append.startsWith(MARKER) && open > 0 && close > open, 'C1 --append-system-prompt 以用户 append 开头,紧跟 <ruyi-environment>');
    const envBlock = open > 0 && close > open ? t1.append.slice(open, close + '</ruyi-environment>'.length) : '';
    ok(/Claude Code/.test(envBlock) && /mcp__win-claude-workbench__/.test(envBlock) && /ripgrep 可用（如意随包自带/.test(envBlock) && envBlock.includes('```mermaid'),
      'C2 Claude 变体:引擎名 + 如意 MCP 前缀 + 随包 rg + mermaid');
    ok(t1.append.indexOf('工具批次') > close, 'C3 环境说明排在四层工具协议之前(无条件前缀)');
    let envSeen = null; try { envSeen = JSON.parse(fs.readFileSync(ENV_CAP, 'utf8')); } catch { envSeen = null; }
    const firstPathEntry = envSeen && envSeen.PATH ? String(envSeen.PATH).split(path.delimiter)[0] : '';
    ok(sameDir(firstPathEntry, VENDOR_BIN), 'C4 Claude CLI 子进程 PATH 第一项是随包 vendor-bin (' + firstPathEntry + ')');
    const t2 = await turn('再说一遍');
    const envBlock2 = (() => { const o = t2.append.indexOf('<ruyi-environment>'); const c = t2.append.indexOf('</ruyi-environment>'); return o > 0 && c > o ? t2.append.slice(o, c + '</ruyi-environment>'.length) : ''; })();
    ok(envBlock && envBlock2 === envBlock, 'C5 连续两个回合环境说明逐字节相同(系统提示前缀稳定)');
    ok(t1.meta && t1.meta.envBrief && t2.meta && t2.meta.envBrief === t1.meta.envBrief, 'C6 meta 事件带同一个环境说明指纹 (' + (t1.meta && t1.meta.envBrief) + ')');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { killOwnTree(c); } catch { /* ignore */ } } }
    await sleep(300);
    if (!fail) fs.rmSync(ROOT_TMP, { recursive: true, force: true });
    console.log('\nENGINE-ENV-RUNTIME E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
