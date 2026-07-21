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
    ok(entries.length > 30 && entries.every(e => e && typeof e.path === 'string' && typeof e.sha256 === 'string'),
      '③ manifest 覆盖 ' + entries.length + ' 个 payload 文件(>30, 逐条 {path, sha256})');
    // 抽查 5 个重算 sha256
    let checked = 0, mismatch = 0;
    for (const e of entries.filter((_, i) => i % Math.ceil(entries.length / 5) === 0).slice(0, 5)) {
      const full = path.join(payload, e.path);
      if (!fs.existsSync(full)) { mismatch++; continue; }
      const actual = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (e.sha256 !== actual) mismatch++;
      checked++;
    }
    ok(checked > 0 && mismatch === 0, '③ manifest sha256 抽查 ' + checked + ' 个全对账(mismatch=' + mismatch + ')');
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

  console.log('\nRELEASE-DRYRUN: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log('ERROR ' + (e && e.stack || e)); process.exit(1); });
