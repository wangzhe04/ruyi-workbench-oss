'use strict';
/*
 * release-dryrun.js (第49波49e, E4) — 打包验证干跑:不上传、不发布,机械验证发行链路可用。
 *
 *  ① 产物新鲜度(build.js --check,陈旧即拒)
 *  ② build-overlay 全装配(payload 逐文件存在 + update-manifest.json 生成)
 *  ③ manifest 完整性抽查:随机 5 个 payload 文件重算 sha256 与 manifest 对账
 *  ④ --pkg:pkg 打包冒烟(npm run build:exe → Ruyi.exe serve --port <free> → /health 200 → kill)
 *     本地默认跳过(pkg 需 npm ci 且耗时);CI release-dryrun job 传 --pkg。
 *
 * Run: node dev-harness/release-dryrun.js [--pkg]
 */
const cp = require('child_process'), fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const VERSION = '0.0.0-dryrun';
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const run = (cmd, args, cwd, opts = {}) => cp.execFileSync(cmd, args, { cwd, stdio: opts.quiet ? 'pipe' : 'inherit', timeout: opts.timeout || 300000 });
// Windows 上 npm 是 npm.cmd,execFile 不带 shell 找不到(ENOENT)/拒执行(EINVAL, Node 批处理防护)
// —— 与 batchSafeSpawn 同教训:经 cmd.exe /c 调。POSIX 直调 npm 带分词参数。
const NPM_RUN = process.platform === 'win32'
  ? { cmd: 'cmd.exe', args: ['/d', '/s', '/c', 'npm run build:exe'] }
  : { cmd: 'npm', args: ['run', 'build:exe'] };

(async () => {
  // ① 产物新鲜度
  try { run(process.execPath, [path.join(WB, 'app', 'build.js'), '--check'], WB, { quiet: true }); ok(true, '① 产物新鲜度(build.js --check)'); }
  catch (e) { ok(false, '① 产物新鲜度 —— 陈旧产物: ' + ((e.stdout || e.message) + '').slice(0, 200)); }

  // EC-A A3: 版本三角(package.json == 00-boot.js VERSION == facts.workbenchVersion == 产物)
  try {
    const pkgV = JSON.parse(fs.readFileSync(path.join(WB, 'package.json'), 'utf8'));
    const boot = fs.readFileSync(path.join(WB, 'app', 'src', '00-boot.js'), 'utf8');
    const bootV = (boot.match(/const VERSION = '([^']+)'/) || [])[1];
    const facts = JSON.parse(fs.readFileSync(path.join(ROOT, 'facts.json'), 'utf8'));
    const built = fs.readFileSync(path.join(WB, 'app', 'server.js'), 'utf8');
    ok(pkgV.version === bootV, 'A3 版本三角: package.json(' + pkgV.version + ') == 00-boot.js(' + bootV + ')');
    ok(facts.workbenchVersion === pkgV.version, 'A3 facts.workbenchVersion(' + facts.workbenchVersion + ') == package.json(' + pkgV.version + ')');
    const builtV = (built.match(/const VERSION = '([^']+)'/) || [])[1]; ok(builtV === pkgV.version, 'A3 产物 server.js 版本一致(package=' + pkgV.version + ', 产物=' + builtV + ')');
  } catch (e) { ok(false, 'A3 版本三角: ' + (e.message || e)); }
  // ② build-overlay 全装配
  try {
    run(process.execPath, [path.join(WB, 'tools', 'build-overlay.js'), VERSION], WB, { quiet: true });
    ok(true, '② build-overlay 装配成功');
  } catch (e) { ok(false, '② build-overlay 失败: ' + ((e.stdout || '') + (e.stderr || '') || e.message).slice(0, 300)); }

  const payload = path.join(WB, 'dist', 'overlay', 'payload');
  const manifestPath = path.join(payload, 'update-manifest.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* handled below */ }
  ok(!!manifest && typeof manifest === 'object', '③ update-manifest.json 生成且可解析');
  if (manifest) {
    const entries = Array.isArray(manifest.files) ? manifest.files : [];
    ok(entries.length > 30 && entries.every(e => e && typeof e.path === 'string' && e.path.length > 0 && typeof e.sha256 === 'string' && e.sha256.length === 64),
      '③ manifest 覆盖 ' + entries.length + ' 个 payload 文件(>30, 逐条 {path, sha256})');
    // EC-A A2: 全量 sha256 对账(36 文件,毫秒级,不再抽样)
    let mismatch = 0, missing = 0;
    for (const e of entries) {
      const full = path.join(payload, e.path);
      if (!fs.existsSync(full)) { missing++; continue; }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (e.sha256 !== actual) mismatch++;
    }
    ok(mismatch === 0 && missing === 0, 'A2 manifest 全量 sha256 对账(' + entries.length + ' 个, mismatch=' + mismatch + ', missing=' + missing + ')');
    // EC-A A4: minHostVersion 字段存在且为合法版本号(运行时兼容预检属 EC-B)
    const mhv = manifest.minHostVersion;
    ok(typeof mhv === 'string' && /^\d+\.\d+\.\d+/.test(mhv), 'A4 update-manifest.minHostVersion 存在且合法(' + mhv + ')');
  }

  // ④ pkg 冒烟(可选)
  if (process.argv.includes('--pkg')) {
    try {
      run(NPM_RUN.cmd, NPM_RUN.args, WB, { timeout: 600000 });
      const exe = path.join(WB, 'dist', 'Ruyi.exe');
      ok(fs.existsSync(exe) && fs.statSync(exe).size > 10 * 1024 * 1024, '④ pkg 打包出 Ruyi.exe(>10MB)');
      const port = await getFreePort();
      const HOME = path.join(ROOT, 'dev-harness', '.tmp-dryrun-home');
      fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
      const child = cp.spawn(exe, ['serve', '--port', String(port)], { env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
      let healthy = false;
      for (let i = 0; i < 60 && !healthy; i++) {
        healthy = await new Promise(resolve => {
          const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 2000 }, res => resolve(res.statusCode === 200));
          r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); });
        });
        if (!healthy) await new Promise(r => setTimeout(r, 500));
      }
      ok(healthy, '④ Ruyi.exe serve 冒烟(/health 200)');
      try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
      fs.rmSync(HOME, { recursive: true, force: true });
    } catch (e) { ok(false, '④ pkg 冒烟失败: ' + ((e.message || '') + '').slice(0, 300)); }
  } else {
    console.log('SKIP ④ pkg 冒烟(传 --pkg 启用;CI release-dryrun job 会跑)');
  }

  // EC-A A1: Slim 离线包文件清单可复验(stage 关键文件存在;ZIP 打包是 env 独立 concern,CI 原生 Windows 正常)
  try {
    const stageDir = path.join(WB, 'dist', 'Ruyi-slim-dryrun');
    fs.rmSync(stageDir, { recursive: true, force: true });
    let pkgErr = null;
    try { cp.execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(WB, 'tools', 'package-offline.ps1'), '-SkipExeBuild', '-Variant', 'slim-dryrun'], { cwd: WB, stdio: 'pipe', timeout: 120000, windowsHide: true }); }
    catch (e) { pkgErr = e; }
    const keyFiles = ['app/server.js', 'app/public/app.js', 'package.json', 'Start-Workbench.cmd', 'docs'];
    const missing = keyFiles.filter(f => !fs.existsSync(path.join(stageDir, f)));
    ok(missing.length === 0, 'A1 Slim 离线包文件清单可复验(' + keyFiles.length + ' 关键路径;missing=' + missing.join(',') + (pkgErr ? '; ZIP/stage 警告已忽略(env tar)' : '') + ')');
    fs.rmSync(stageDir, { recursive: true, force: true });
  } catch (e) { ok(false, 'A1 Slim 离线包清单检查失败: ' + (e.message || e)); }
  // EC-A A5: live probe 四态报告(配置探针,不实际调用 API;skip 不算 pass)
  try {
    const skipBlock = fs.readFileSync(path.join(__dirname, 'run-all.js'), 'utf8');
    const skipMatch = (skipBlock.match(/const SKIP = new Set\(\[([\s\S]*?)\]\)/) || [])[1] || '';
    const probes = (skipMatch.match(/'[^']+\.e2e\.js'/g) || []).map(x => x.slice(1, -1));
    const home = process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(process.env.USERPROFILE || process.env.HOME, '.win-claude-workbench');
    let cfg = null; try { cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8')); } catch {}
    const claudeOnPath = (() => { try { cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { stdio: 'pipe', timeout: 5000 }); return true; } catch { return false; } })();
    const accVenv = fs.existsSync(path.join(ROOT, 'mcp', 'ai-computer-control', '.venv', 'Scripts', 'python.exe'));
    const providerKeyed = !!(cfg && Array.isArray(cfg.providers) && cfg.providers.find(pr => pr && pr.apiKey));
    const dsKey = !!process.env.DEEPSEEK_API_KEY || !!(cfg && Array.isArray(cfg.providers) && cfg.providers.find(pr => pr && pr.apiKey && pr.baseUrl && /deepseek/i.test(pr.baseUrl)));
    function statusOf(name) {
      if (name === 'deepseek-live.e2e.js' || name === 'deepseek-tools.e2e.js') return dsKey ? 'CONFIGURED' : 'UNCONFIGURED';
      if (name === 'desktop-bridge-live.e2e.js') return accVenv ? 'CONFIGURED' : 'UNCONFIGURED';
      if (name === 'claude-binary-live.e2e.js' || name === 'claude-compact-probe-live.e2e.js') return claudeOnPath ? 'CONFIGURED' : 'UNCONFIGURED';
      if (name === 'compact-quality-live.e2e.js') return providerKeyed ? 'CONFIGURED' : 'UNCONFIGURED';
      return 'UNKNOWN';
    }
    console.log('  A5 live probe 状态(配置探针,不实跑;默认不调真实 API,--live 才真跑):');
    let configured = 0;
    for (const name of probes) { const st = statusOf(name); if (st === 'CONFIGURED') configured++; console.log('    ' + name + ': ' + st); }
    ok(probes.length > 0, 'A5 live probe 独立列出 ' + probes.length + ' 件(' + configured + ' CONFIGURED,余 UNCONFIGURED -- skip 不算 pass)');
  } catch (e) { ok(false, 'A5 live probe 报告失败: ' + (e.message || e)); }
  console.log('\nRELEASE-DRYRUN: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
