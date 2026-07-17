// E2E (P1: cmd8191 根治 — npm shim → 真身 claude.exe 解析): claude.cmd 只是转发 shim,经 cmd.exe
// 启动有 8191 字符整行硬上限(技能索引事故根因);resolveClaudeLauncher 把可解析的 npm shim 换成
// 同目录 node_modules/@anthropic-ai/claude-code/bin/claude.exe,直启走 CreateProcess(32767)。
// 两层:
//   (A) 单元(require server.js): 假 npm 布局(绝对路径/裸名沿 PATH)解析出 exe;无布局/非 batch/
//       不存在路径原样返回;normalizeConfig 咽喉点替换 claudePath;预算自动 7900 → 32000;memoize 一致。
//       假 exe 用 node.exe 副本 —— `--version` 退出 0,探测即通过。
//   (B) 集成: config.json 的 claudePath 指向假 shim → GET /api/status 的 config.claudePath 与健康
//       详情均为解析后的 exe 路径(全部消费方经 normalizeConfig 咽喉点一致受益)。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const FAKE_CLAUDE = path.join(WB, 'tools', 'fake-claude.js');
const HOME = path.join(os.tmpdir(), 'wcw-exe-resolve-e2e');
const CWD = path.join(HOME, 'project');

const srv = require(path.join(WB, 'app', 'server.js'));
const { getFreePort } = require('./free-port.js');

// ---- fixtures: 假 npm 布局(<dir>/claude.cmd + <dir>/node_modules/@anthropic-ai/claude-code/bin/claude.exe)
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(CWD, { recursive: true });
function makeNpmLayout(name) {
  const dir = path.join(HOME, name);
  const exeDir = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  fs.mkdirSync(exeDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'claude.cmd'), '@"%~dp0\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\n');
  const exe = path.join(exeDir, 'claude.exe');
  fs.copyFileSync(process.execPath, exe); // node.exe 副本:`--version` 退出 0,探测通过
  return { dir, shim: path.join(dir, 'claude.cmd'), exe };
}
const L1 = makeNpmLayout('npm-a');   // 绝对路径解析用
const L2 = makeNpmLayout('npm-b');   // 裸名沿 PATH 解析用
const NO_LAYOUT = path.join(HOME, 'npm-c'); // 阴性:有 shim 无 node_modules 布局
fs.mkdirSync(NO_LAYOUT, { recursive: true });
fs.writeFileSync(path.join(NO_LAYOUT, 'claude.cmd'), '@echo off\r\n');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 7, version: '1.0.0', permissionMode: 'bypass', engineMode: 'print', claudePath: L1.shim,
}, null, 2));

// ---- http helpers ---------------------------------------------------------------------------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJson(port, p) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
async function startServer(port) {
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, RUYI_HOME: HOME, WCW_FAKE_CLAUDE: FAKE_CLAUDE },
  });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let h = null; for (let i = 0; i < 40 && !(h && h.body && h.body.ok); i++) { await sleep(150); h = await getJson(port, '/health'); }
  return { wb, h };
}
async function stopServer(wb) { if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } await sleep(300); }

(async () => {
  let fail = 0;
  let wb = null;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  try {
    // ============================== (A) 单元层 ==============================
    // A1: 绝对路径 shim → 真身 exe(npm 相对布局)。
    const r1 = srv.resolveClaudeLauncher(L1.shim);
    ok(path.resolve(r1) === path.resolve(L1.exe), '(A1) 绝对路径 shim 解析出真身 exe — ' + r1);
    // A2: 裸名 'claude.cmd' 沿 PATH 找到 shim 后同样解析。
    const savedPath = process.env.PATH;
    process.env.PATH = L2.dir + path.delimiter + savedPath;
    try {
      const r2 = srv.resolveClaudeLauncher('claude.cmd');
      // 注意:本机 PATH 上若另有更早的真实 claude.cmd,命中的会是它 —— 两种命中都必须解析出【某个】exe 或原样。
      const hitOurs = path.resolve(r2) === path.resolve(L2.exe);
      const hitReal = /\.exe$/i.test(String(r2)) || String(r2) === 'claude.cmd';
      ok(hitOurs || hitReal, '(A2) 裸名沿 PATH 解析(命中本夹具=' + hitOurs + ') — ' + r2);
    } finally { process.env.PATH = savedPath; }
    // A3: 阴性 —— 有 shim 无 npm 布局 → 原样返回(行为逐字节不变)。
    const r3 = srv.resolveClaudeLauncher(path.join(NO_LAYOUT, 'claude.cmd'));
    ok(r3 === path.join(NO_LAYOUT, 'claude.cmd'), '(A3) 无 node_modules 布局 → 原样返回');
    const r3b = srv.resolveClaudeLauncher(path.join(HOME, 'no-such-dir', 'claude.cmd'));
    ok(r3b === path.join(HOME, 'no-such-dir', 'claude.cmd'), '(A3b) shim 不存在 → 原样返回');
    // A4: 非 batch 输入不动(.exe / 无扩展名 / 空)。
    ok(srv.resolveClaudeLauncher('claude.exe') === 'claude.exe', '(A4a) .exe 输入不动');
    ok(srv.resolveClaudeLauncher('claude') === 'claude', '(A4b) 无扩展名输入不动');
    ok(srv.resolveClaudeLauncher('') === '', '(A4c) 空输入不动');
    // A5: 预算自动升档 —— 解析到 exe 后 cmdLineBudgetFor 给 32000(降级阶梯近乎不再触发)。
    if (process.platform === 'win32') {
      delete process.env.WCW_CLAUDE_CMDLINE_BUDGET;
      ok(srv.cmdLineBudgetFor(r1) === 32000, '(A5) 解析后预算 7900 → 32000');
      ok(srv.cmdLineBudgetFor(L1.shim) === 7900, '(A5b) 未解析 shim 仍 7900(回退路径设防不变)');
    } else {
      ok(srv.cmdLineBudgetFor(r1) === 0, '(A5) 非 Windows 不设防(0)');
    }
    // A6: normalizeConfig 咽喉点 —— 配置里的 shim 被替换成 exe(全部消费方一致受益)。
    const cfg = srv.normalizeConfig({ configSchema: srv.CONFIG_SCHEMA, claudePath: L1.shim }).config;
    ok(path.resolve(cfg.claudePath) === path.resolve(L1.exe), '(A6) normalizeConfig 替换 claudePath → exe');
    // A7: memoize —— 同输入两次解析同值(缓存命中路径)。
    const r7a = srv.resolveClaudeLauncher(L1.shim);
    const r7b = srv.resolveClaudeLauncher(L1.shim);
    ok(r7a === r7b && path.resolve(r7a) === path.resolve(L1.exe), '(A7) memoize 一致');

    // ============================== (B) 集成层 ==============================
    if (process.platform === 'win32') {
      const PORT = await getFreePort();
      const S = await startServer(PORT);
      wb = S.wb;
      ok(!!(S.h && S.h.body), '(B0) 工作台 listening :' + PORT);
      const st = await getJson(PORT, '/api/status');
      const cpv = st && st.body && st.body.config && st.body.config.claudePath;
      ok(!!cpv && path.resolve(cpv) === path.resolve(L1.exe), '(B1) /api/status config.claudePath 已解析为 exe — ' + cpv);
      const cliHealth = st && st.body && Array.isArray(st.body.health) && st.body.health.find(x => x.id === 'claude-cli');
      ok(!!cliHealth && cliHealth.ok === true && /claude\.exe$/i.test(String(cliHealth.detail || '')), '(B2) 健康检查 claude-cli 用 exe 探测通过 — ' + (cliHealth && cliHealth.detail));
      await stopServer(wb); wb = null;
    } else {
      console.log('SKIP (B) 集成层 — 仅 Windows 有 cmd shim 问题');
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    await stopServer(wb);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nCLAUDE-EXE-RESOLVE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();
