'use strict';
/*
 * E2E (第48波48b): 性能 P2(verifyManifest mtime 快路径)。P1(readConfig 缓存)经对抗验证回退(见 01-config.js 注释)。
 *
 *  P2 verifyManifest mtime+size 快路径:
 *   S2 静态锁:_maniCache + mtime/size 跳过 SHA + 60s forceFull + version 失效。
 *   P2 行为锁:连发 5x GET /api/status 的 manifest 字段一致(缓存安全,不抖动);无 manifest 环境返回 present:false 不崩。
 *  P1 回退锁:readConfig 无 _configCache(对抗验证回退--5 件 e2e 直接写 config.json 依赖 uncached readConfig)。
 *
 * Run: node dev-harness/perf-config-cache.e2e.js
 */
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'wcw-perf-config-cache');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, raw: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
async function up(port) { for (let i = 0; i < 50; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }

(async () => {
  console.log('── 静态锁: P1 回退 + P2 verifyManifest 快路径 ──');
  const src = fs.readFileSync(SERVER, 'utf8');
  ok(!/let _configCache = null;/.test(src) && /48b\(P1\) readConfig 内存缓存 -- 经对抗验证【回退】/.test(src), 'S1 P1 readConfig 缓存已回退(对抗验证:5 件 e2e 直接写 config.json 依赖 uncached readConfig)');
  ok(/let _maniCache = null;/.test(src) && /MANIFEST_FULL_VERIFY_MS = 60000/.test(src), 'S2 P2 verifyManifest 缓存 + 60s 强制全量');
  ok(/const canSkip = !forceFull && prev && prev\.mtime === st\.mtimeMs && prev\.size === st\.size/.test(src), 'S3 P2 mtime+size 快路径(未变跳过 SHA)');
  ok(/_maniCache\.version !== manifest\.version/.test(src), 'S4 P2 manifest.version 变更即失效(新 overlay 落地重算)');
  ok(/_maniCache = null; return \{ present: false \}/.test(src), 'S5 P2 无 manifest 环境清缓存返回 present:false');

  // ── 起服务 ──
  const WP = await getFreePort();
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '2.0.0', permissionMode: 'bypass' }));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WP)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  try {
    ok(await up(WP), 'workbench up');
    const html = await new Promise(resolve => http.get({ host: '127.0.0.1', port: WP, path: '/' }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve(b)); }));
    const token = (html.match(/name="wcw-token"\s+content="([a-f0-9]+)"/) || [])[1] || '';
    const hdr = { 'x-wcw-token': token };

    // ── P2 行为:缓存安全 ──
    console.log('── P2 行为: verifyManifest 缓存安全 ──');
    let maniConsistent = true, maniSeen = null, allOk = true;
    for (let i = 0; i < 5; i++) {
      const s = await get(WP, '/api/status', hdr);
      if (!s || s.status !== 200) allOk = false;
      const mani = s && s.json && s.json.manifest;
      if (maniSeen === null) maniSeen = JSON.stringify(mani);
      else if (JSON.stringify(mani) !== maniSeen) maniConsistent = false;
    }
    ok(allOk, 'P2a 连发 5x GET /api/status 全 200(缓存负载安全)');
    ok(maniConsistent, 'P2b manifest 字段 5x 一致(缓存安全,不抖动)');
    ok(maniSeen !== null, 'P2c manifest 可达(无 overlay 则 present:false,缓存路径不崩)');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    await sleep(200); fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nPERF CONFIG CACHE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
