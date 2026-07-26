'use strict';
/*
 * E2E (第53波 EC-B 安全更新中心): overlay 离线更新核心 -- PS1 受测核心 + API 编排层。
 *
 * 双层覆盖:
 *   A 段(PS1 直测):precheck/apply/rollback/audit 直接调 Manage-Overlay.ps1,临时部署作 target。
 *   B 段(故障注入,写入前拒绝):路径穿越 / 篡改 / 缺文件 / 版本不兼容 四类坏包,precheck+apply 均拒,且不写一字节。
 *   C 段(API 编排层):把 server.js 复制到临时部署跑(externalRoot()=临时部署),走 HTTP 全路径
 *       precheck(合法) / apply(合法+备份+审计) / apply(幂等拒) / apply(-Force) / status / rollback。
 *   D 段(可恢复):apply 后回滚,原文件恢复(用户数据不丢)。
 *   S 段(静态锁):PS1 含 precheck/audit/路径穿越/幂等/审计日志;API 路由入 ROUTE_AUTH;manifest 模块 18。
 *
 * 安全模型:apply 永远先 precheck(PS1 内联);precheck 失败 -> 拒绝且零写入(backup 目录都不建)。
 *
 * Run: node dev-harness/overlay-update-core.e2e.js
 */
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const crypto = require('crypto');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER_SRC = path.join(WB, 'app', 'server.js');
const PS1_SRC = path.join(WB, 'tools', 'Manage-Overlay.ps1');
const HERE = __dirname;
const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
const ok = (v, label) => { if (v) console.log('PASS ' + label); else { failures++; console.error('FAIL ' + label); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }

// ── HTTP helpers ──
function get(port, p, headers = {}) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 5000, headers }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, ...(JSON.parse(b) || {}) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}
function post(port, p, body, headers = {}) {
  return new Promise(resolve => {
    const raw = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 120000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), ...headers } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve({ status: res.statusCode, ...(JSON.parse(b) || {}) }); } catch { resolve({ status: res.statusCode, body: b }); } });
    });
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null); });
    r.write(raw); r.end();
  });
}
async function up(port) { for (let i = 0; i < 60; i++) { if (await get(port, '/health')) return true; await sleep(120); } return false; }

// ── PS1 调用(直测 A/B 段用) ──
// 严格输出纪律:-Json 模式应只输出单 JSON 对象。检测 first-{ 前是否有非空白(管道泄漏,如 $x++ 吐数字),
// 设 leak 字段供断言(防 BUG-1 类回归:对抗审查曾因 forgiving 切片解析漏抓 $restored++ 泄漏)。
function parsePs1Json(raw) {
  const t = String(raw || '').trim();
  const s = t.indexOf('{'); const e = t.lastIndexOf('}');
  const leak = s > 0 ? t.slice(0, s).trim() : ''; // { 前的非空白 = 管道泄漏
  if (s >= 0 && e > s) { try { return { json: JSON.parse(t.slice(s, e + 1)), leak }; } catch { /* fall */ } }
  return { json: null, leak };
}
function runPs1(action, overlayRoot, target, extraArgs = []) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1_SRC, '-Action', action, '-Json'];
  if (overlayRoot) args.push('-OverlayRoot', overlayRoot);
  if (target) args.push('-Target', target);
  args.push(...extraArgs);
  try {
    const out = cp.execFileSync('powershell', args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
    const p = parsePs1Json(out);
    return { ...p, raw: out, rc: 0 };
  } catch (err) {
    const so = err && err.stdout ? String(err.stdout) : '';
    const p = parsePs1Json(so);
    return { ...p, raw: so || '', rc: err.status || 1, error: String(err && err.message || err) };
  }
}

// ── 构造假 overlay 包目录(返回 overlayRoot 路径;含 Manage-Overlay.ps1 + payload/) ──
function sha256(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }
function buildOverlayPkg(pkgDir, opts) {
  // opts: { version, minHostVersion, files: [{path, content}], manifestOverrides }
  fs.rmSync(pkgDir, { recursive: true, force: true });
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.copyFileSync(PS1_SRC, path.join(pkgDir, 'Manage-Overlay.ps1'));
  const payloadDir = path.join(pkgDir, 'payload');
  fs.mkdirSync(payloadDir, { recursive: true });
  const files = [];
  for (const f of opts.files) {
    const fp = path.join(payloadDir, f.path);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, f.content);
    files.push({ path: f.path, sha256: sha256(fp), bytes: f.content.length });
  }
  const manifest = { name: 'Ruyi Overlay', version: opts.version, overlay: `overlay-${opts.version}`, minHostVersion: opts.minHostVersion, generatedFrom: 'test', fileCount: files.length, files };
  if (opts.manifestOverrides) Object.assign(manifest, opts.manifestOverrides);
  fs.writeFileSync(path.join(payloadDir, 'update-manifest.json'), JSON.stringify(manifest, null, 2));
  return pkgDir;
}

// 把 overlay 包目录打成 zip(Compress-Archive;zip 内文件在根,无包裹文件夹)。
function zipOverlayPkg(pkgDir, zipPath) {
  fs.rmSync(zipPath, { force: true });
  // Compress-Archive -Path 包内条目(Manage-Overlay.ps1 + payload/)->zip 根。
  const qs = s => String(s).replace(/'/g, "''");
  const items = path.join(pkgDir, '*');
  cp.execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `Compress-Archive -Path '${qs(items)}' -DestinationPath '${qs(zipPath)}' -Force`], { encoding: 'utf8', timeout: 60000 });
  return zipPath;
}

(async () => {
  const HOME = path.join(os.tmpdir(), 'ruyi-overlay-ec');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });

  // ── S 段: 静态锁(PS1 + API 路由 + manifest 模块) ──
  console.log('── S 段: 静态锁(PS1 安全原语 / API 路由 / manifest 模块) ──');
  const ps1 = fs.readFileSync(PS1_SRC, 'utf8');
  ok(ps1.includes("ValidateSet('apply', 'rollback', 'list', 'verify', 'precheck', 'audit')"), 'S1 PS1 含 precheck+audit action');
  ok(/function Test-PathTraversal/.test(ps1) && ps1.includes("path traversal:"), 'S2 PS1 路径逃逸检测在(含 .. / 盘符 / 绝对路径)');
  ok(ps1.includes('minHostVersion') && /function Test-VersionCompat/.test(ps1), 'S3 PS1 版本兼容预检在(minHostVersion <= host)');
  ok(ps1.includes('idempotent_rejected') && ps1.includes('-Force'), 'S4 PS1 幂等拒绝 + -Force 覆盖在');
  ok(ps1.includes('.overlay-audit.jsonl') && ps1.includes('function Write-Audit'), 'S5 PS1 审计日志(append-only jsonl)在');
  ok(ps1.includes('Invoke-PrecheckInternal') && /Do-Apply[\s\S]{0,400}Invoke-PrecheckInternal/.test(ps1), 'S6 apply 内联 precheck(写入前先全检)在');
  const serverSrc = fs.readFileSync(SERVER_SRC, 'utf8');
  ok(serverSrc.includes('handleOverlayApiRoutes'), 'S7 API 编排层 handleOverlayApiRoutes 入 bundle');
  ok(serverSrc.includes("'POST', p: '/api/overlay/precheck'") && serverSrc.includes("'POST', p: '/api/overlay/apply'") && serverSrc.includes("'POST', p: '/api/overlay/rollback'") && serverSrc.includes("'GET', p: '/api/overlay/status'"), 'S8 四条 overlay 路由入 ROUTE_AUTH(token 级)');
  const manifestJson = JSON.parse(fs.readFileSync(path.join(WB, 'app', 'src', 'manifest.json'), 'utf8'));
  ok(manifestJson.modules.some(m => m.file === '13c-overlay-routes.js'), 'S9 manifest 模块 18(13c-overlay-routes.js)注册');

  // ── 临时部署(target;A/B 段 PS1 直测 + C 段 API 共用同一份) ──
  const DEPLOY = path.join(HOME, 'deploy');
  fs.mkdirSync(path.join(DEPLOY, 'app'), { recursive: true });
  fs.copyFileSync(SERVER_SRC, path.join(DEPLOY, 'app', 'server.js')); // 让 externalRoot()=DEPLOY(C 段跑这)
  fs.writeFileSync(path.join(DEPLOY, 'package.json'), JSON.stringify({ name: 'ruyi-test-deploy', version: '2.0.1' }));
  // 一个会被覆盖的存量文件(验证 backup+rollback 恢复用户数据)
  fs.mkdirSync(path.join(DEPLOY, 'app', 'public'), { recursive: true });
  fs.writeFileSync(path.join(DEPLOY, 'app', 'public', 'hello.txt'), 'ORIGINAL-USER-DATA');

  // 合法 overlay 包(2 文件:覆盖 hello.txt + 新增 marker.txt;minHost=2.0.1 == host 2.0.1 通过)
  const VALID_PKG = path.join(HOME, 'pkg-valid');
  const VALID_ZIP = path.join(HOME, 'pkg-valid.zip');
  buildOverlayPkg(VALID_PKG, {
    version: '9.9.9-test', minHostVersion: '2.0.1',
    files: [
      { path: 'app/public/hello.txt', content: 'NEW-OVERLAY-DATA' },
      { path: 'app/public/marker.txt', content: 'added-by-overlay' },
    ],
  });
  zipOverlayPkg(VALID_PKG, VALID_ZIP);

  // 第二个合法包(不同版本 + 不同内容,供 rollback 一步回退验证 V2-DATA -> NEW-OVERLAY-DATA)
  const VALID2_PKG = path.join(HOME, 'pkg-valid2');
  const VALID2_ZIP = path.join(HOME, 'pkg-valid2.zip');
  buildOverlayPkg(VALID2_PKG, {
    version: '9.9.10-test2', minHostVersion: '2.0.1',
    files: [
      { path: 'app/public/hello.txt', content: 'V2-DATA' },
      { path: 'app/public/marker2.txt', content: 'added-by-overlay-v2' },
    ],
  });
  zipOverlayPkg(VALID2_PKG, VALID2_ZIP);

  // ── A 段: PS1 直测 precheck/apply/audit(合法包) ──
  console.log('── A 段: PS1 受测核心(precheck/apply/audit 合法包) ──');
  const pc = runPs1('precheck', VALID_PKG, DEPLOY);
  ok(pc.json && pc.json.ok === true, 'A1 precheck 合法包 ok=true');
  ok(pc.json && pc.json.hostVersion === '2.0.1' && pc.json.minHostVersion === '2.0.1', 'A2 precheck 版本字段读取正确(host=minHost=2.0.1)');
  ok(pc.json && pc.json.preview && pc.json.preview.overwritten.includes('app/public/hello.txt'), 'A3 precheck 预览识别 overwritten(hello.txt)');
  ok(pc.json && pc.json.preview && pc.json.preview.new.includes('app/public/marker.txt'), 'A4 precheck 预览识别 new(marker.txt)');

  const ap = runPs1('apply', VALID_PKG, DEPLOY);
  ok(ap.json && ap.json.ok === true, 'A5 apply 合法包 ok=true');
  ok(ap.json && ap.json.restartNeeded === true, 'A6 apply 返回 restartNeeded=true');
  ok(fs.readFileSync(path.join(DEPLOY, 'app', 'public', 'hello.txt'), 'utf8') === 'NEW-OVERLAY-DATA', 'A7 apply 写入新内容(hello.txt)');
  ok(fs.readFileSync(path.join(DEPLOY, 'app', 'public', 'marker.txt'), 'utf8') === 'added-by-overlay', 'A8 apply 新增文件(marker.txt)');
  ok(fs.existsSync(path.join(DEPLOY, '.overlay-applied.json')), 'A9 apply 写应用标记(.overlay-applied.json)');
  ok(fs.existsSync(path.join(DEPLOY, '.overlay-backups')), 'A10 apply 建备份目录(.overlay-backups)');

  const au = runPs1('audit', null, DEPLOY);
  ok(au.json && au.json.count >= 1, 'A11 audit 返回条目');
  ok(au.json && au.json.entries.some(e => e.action === 'apply' && e.result === 'ok'), 'A12 audit 含 apply ok 记录');
  // 对抗审查 BUG-1 防回归:apply -Json 输出无管道泄漏(first-{ 前无非空白)
  ok(ap.leak === '' && au.leak === '', 'A13 PS1 -Json 输出无管道泄漏(BUG-1 防回归:无 first-{ 前散写)');

  // ── B 段: 故障注入(写入前拒绝,零写入) ──
  console.log('── B 段: 故障注入(路径穿越/篡改/缺文件/版本不兼容 -- 写入前拒绝) ──');

  // B1 路径穿越:manifest 条目含 ../
  const TRAVERSAL_PKG = path.join(HOME, 'pkg-traversal');
  buildOverlayPkg(TRAVERSAL_PKG, {
    version: '9.9.9-trav', minHostVersion: '2.0.1',
    files: [{ path: '../evil-traversal.txt', content: 'should-not-write' }],
  });
  // buildOverlayPkg 算的是真实文件 sha,但 payload 文件在 payload/../evil-traversal.txt(实际 payload/evil-traversal.txt? 不:path.join(payload,'../evil-traversal.txt')=HOME/evil-traversal.txt)
  // 这里只需 precheck 拒绝;sha 是否对无所谓(路径穿越先判)。
  const DEPLOY_B1 = path.join(HOME, 'deploy-b1');
  fs.mkdirSync(path.join(DEPLOY_B1, 'app'), { recursive: true });
  fs.writeFileSync(path.join(DEPLOY_B1, 'package.json'), JSON.stringify({ version: '2.0.1' }));
  const rb1 = runPs1('precheck', TRAVERSAL_PKG, DEPLOY_B1);
  ok(rb1.json && rb1.json.ok === false, 'B1 precheck 路径穿越包 ok=false');
  ok(rb1.json && rb1.json.errors.some(e => /path traversal/.test(e)), 'B1 precheck 错误含 path traversal');
  const rb1apply = runPs1('apply', TRAVERSAL_PKG, DEPLOY_B1);
  ok(rb1apply.json && rb1apply.json.ok === false && rb1apply.json.rejected === true, 'B1 apply 路径穿越包 rejected(写入前拒)');
  ok(!fs.existsSync(path.join(HOME, 'evil-traversal.txt')), 'B1 路径穿越文件未被写出(零越界写入)');
  ok(!fs.existsSync(path.join(DEPLOY_B1, '.overlay-backups')), 'B1 apply 拒绝时未建备份目录(零写入)');

  // B2 篡改:payload 文件内容 != manifest sha(改 manifest 的 sha 为假值)
  const TAMPER_PKG = path.join(HOME, 'pkg-tamper');
  buildOverlayPkg(TAMPER_PKG, {
    version: '9.9.9-tamp', minHostVersion: '2.0.1',
    files: [{ path: 'app/public/t.txt', content: 'genuine-content' }],
    manifestOverrides: { _tamper: true }, // 标记;下面改 sha
  });
  // 篡改 manifest 的 sha 为错误值
  const tamperManiPath = path.join(TAMPER_PKG, 'payload', 'update-manifest.json');
  const tamperMani = JSON.parse(fs.readFileSync(tamperManiPath, 'utf8'));
  tamperMani.files[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(tamperManiPath, JSON.stringify(tamperMani, null, 2));
  const DEPLOY_B2 = path.join(HOME, 'deploy-b2');
  fs.mkdirSync(path.join(DEPLOY_B2, 'app', 'public'), { recursive: true });
  fs.writeFileSync(path.join(DEPLOY_B2, 'package.json'), JSON.stringify({ version: '2.0.1' }));
  const rb2 = runPs1('precheck', TAMPER_PKG, DEPLOY_B2);
  ok(rb2.json && rb2.json.ok === false, 'B2 precheck 篡改包 ok=false');
  ok(rb2.json && rb2.json.errors.some(e => /checksum mismatch/.test(e)), 'B2 precheck 错误含 checksum mismatch');
  const rb2apply = runPs1('apply', TAMPER_PKG, DEPLOY_B2);
  ok(rb2apply.json && rb2apply.json.ok === false && rb2apply.json.rejected === true, 'B2 apply 篡改包 rejected');
  ok(!fs.existsSync(path.join(DEPLOY_B2, '.overlay-backups')), 'B2 apply 拒绝时未建备份目录(零写入)');

  // B3 缺文件:manifest 列了文件但 payload 没有
  const MISSING_PKG = path.join(HOME, 'pkg-missing');
  buildOverlayPkg(MISSING_PKG, {
    version: '9.9.9-miss', minHostVersion: '2.0.1',
    files: [{ path: 'app/public/exists.txt', content: 'here' }],
  });
  // 删掉 payload 文件,manifest 仍列它
  fs.rmSync(path.join(MISSING_PKG, 'payload', 'app', 'public', 'exists.txt'));
  const DEPLOY_B3 = path.join(HOME, 'deploy-b3');
  fs.mkdirSync(path.join(DEPLOY_B3, 'app'), { recursive: true });
  fs.writeFileSync(path.join(DEPLOY_B3, 'package.json'), JSON.stringify({ version: '2.0.1' }));
  const rb3 = runPs1('precheck', MISSING_PKG, DEPLOY_B3);
  ok(rb3.json && rb3.json.ok === false, 'B3 precheck 缺文件包 ok=false');
  ok(rb3.json && rb3.json.errors.some(e => /missing files/.test(e)), 'B3 precheck 错误含 missing files');
  const rb3apply = runPs1('apply', MISSING_PKG, DEPLOY_B3);
  ok(rb3apply.json && rb3apply.json.ok === false && rb3apply.json.rejected === true, 'B3 apply 缺文件包 rejected');
  ok(!fs.existsSync(path.join(DEPLOY_B3, '.overlay-backups')), 'B3 apply 拒绝时未建备份目录(零写入)');

  // B4 版本不兼容:minHost 9.9.9 > host 2.0.1
  const INCOMPAT_PKG = path.join(HOME, 'pkg-incompat');
  buildOverlayPkg(INCOMPAT_PKG, {
    version: '9.9.9-incompat', minHostVersion: '9.9.9',
    files: [{ path: 'app/public/x.txt', content: 'x' }],
  });
  const DEPLOY_B4 = path.join(HOME, 'deploy-b4');
  fs.mkdirSync(path.join(DEPLOY_B4, 'app'), { recursive: true });
  fs.writeFileSync(path.join(DEPLOY_B4, 'package.json'), JSON.stringify({ version: '2.0.1' }));
  const rb4 = runPs1('precheck', INCOMPAT_PKG, DEPLOY_B4);
  ok(rb4.json && rb4.json.ok === false, 'B4 precheck 版本不兼容包 ok=false');
  ok(rb4.json && rb4.json.errors.some(e => /version incompatible/.test(e)), 'B4 precheck 错误含 version incompatible');
  const rb4apply = runPs1('apply', INCOMPAT_PKG, DEPLOY_B4);
  ok(rb4apply.json && rb4apply.json.ok === false && rb4apply.json.rejected === true, 'B4 apply 版本不兼容包 rejected(写入前拒)');
  ok(!fs.existsSync(path.join(DEPLOY_B4, '.overlay-backups')), 'B4 apply 拒绝时未建备份目录(零写入)');

  // ── C 段: API 编排层(HTTP 全路径,externalRoot=DEPLOY) ──
  console.log('── C 段: API 编排层(HTTP precheck/apply/幂等/Force/status/rollback) ──');
  // 先回滚 A 段在 DEPLOY 上的 apply,让 C 段从干净态开始。-Force:跳过端口拒(8765 可能被占用)。
  runPs1('rollback', null, DEPLOY, ['-Force']);
  // rollback 后 hello.txt 恢复原值;marker.txt(新增)留在原处(overlay 不删新增,无害)
  ok(fs.readFileSync(path.join(DEPLOY, 'app', 'public', 'hello.txt'), 'utf8') === 'ORIGINAL-USER-DATA', 'C0 rollback 恢复用户数据(hello.txt=ORIGINAL)');

  const WP = await getFreePort();
  const wb = cp.spawn(process.execPath, [path.join(DEPLOY, 'app', 'server.js'), 'serve', '--port', String(WP)], {
    cwd: DEPLOY, windowsHide: true,
    env: { ...process.env, RUYI_HOME: path.join(HOME, 'data') },
  });
  try {
    ok(await up(WP), 'C1 workbench 启动(临时部署 externalRoot=DEPLOY)');
    // 47c(S1):POST /api/bootstrap(open 级)拿 token -- 不依赖 index.html(测试部署无前端资源)。
    const boot = await post(WP, '/api/bootstrap', {});
    const token = (boot && boot.token) || '';
    ok(!!token, 'C2 取得 workbench token(POST /api/bootstrap)');
    const hdr = { 'x-wcw-token': token };

    // 初始 status(rollback 后无 .overlay-applied)
    const st0 = await get(WP, '/api/overlay/status', hdr);
    ok(st0 && st0.ok === true && st0.current === null, 'C3 GET status 初始 current=null(无应用)');

    // 无 token -> 403
    const noAuth = await get(WP, '/api/overlay/status');
    ok(noAuth && noAuth.status === 403, 'C4 GET status 无 token -> 403');

    // precheck(合法 zip)
    const pcApi = await post(WP, '/api/overlay/precheck', { zipPath: VALID_ZIP }, hdr);
    ok(pcApi && pcApi.ok === true, 'C5 POST precheck 合法 zip ok=true');
    ok(pcApi && pcApi.preview && pcApi.preview.overwritten.includes('app/public/hello.txt'), 'C6 precheck 预览含 overwritten hello.txt');
    ok(pcApi && pcApi.hostVersion === '2.0.1', 'C7 precheck 返回 hostVersion=2.0.1');

    // precheck 非 zip 路径 -> 400
    const pcBad = await post(WP, '/api/overlay/precheck', { zipPath: path.join(HOME, 'not-a-zip.txt') }, hdr);
    ok(pcBad && pcBad.status === 400, 'C8 precheck 非 zip 路径 -> 400');

    // precheck 相对路径 -> 400
    const pcRel = await post(WP, '/api/overlay/precheck', { zipPath: 'relative/path.zip' }, hdr);
    ok(pcRel && pcRel.status === 400, 'C9 precheck 相对路径 -> 400');

    // apply(合法 zip)
    const apApi = await post(WP, '/api/overlay/apply', { zipPath: VALID_ZIP }, hdr);
    ok(apApi && apApi.ok === true, 'C10 POST apply 合法 zip ok=true');
    ok(apApi && apApi.restartNeeded === true, 'C11 apply 返回 restartNeeded=true');
    ok(fs.readFileSync(path.join(DEPLOY, 'app', 'public', 'hello.txt'), 'utf8') === 'NEW-OVERLAY-DATA', 'C12 apply 写入新内容(经 API)');
    ok(fs.existsSync(path.join(DEPLOY, '.overlay-backups')), 'C13 apply 建备份目录(经 API)');

    // 幂等:同版本再 apply -> idempotent 拒绝
    const apIdem = await post(WP, '/api/overlay/apply', { zipPath: VALID_ZIP }, hdr);
    ok(apIdem && apIdem.ok === false && apIdem.idempotent === true, 'C14 apply 同版本幂等拒绝(idempotent=true)');

    // -Force 覆盖
    const apForce = await post(WP, '/api/overlay/apply', { zipPath: VALID_ZIP, force: true }, hdr);
    ok(apForce && apForce.ok === true, 'C15 apply -Force 覆盖 ok=true');

    // status 反映当前版本 + 备份 + 审计
    const st1 = await get(WP, '/api/overlay/status', hdr);
    ok(st1 && st1.ok === true && st1.current && st1.current.version === '9.9.9-test', 'C16 status current.version=9.9.9-test');
    ok(st1 && Array.isArray(st1.backups) && st1.backups.length >= 2, 'C17 status 列出备份(>=2:C10 + C15-Force 各一,证 -Force apply 真执行)');
    ok(st1 && Array.isArray(st1.audit) && st1.audit.length >= 1, 'C18 status 列出审计条目');

    // 再 apply 第二个包(不同版本 + 不同内容),为 D 段 rollback 造一个「上一步状态」可验证
    const ap2 = await post(WP, '/api/overlay/apply', { zipPath: VALID2_ZIP }, hdr);
    ok(ap2 && ap2.ok === true, 'C19 apply VALID2(v9.9.10) ok=true');
    ok(fs.readFileSync(path.join(DEPLOY, 'app', 'public', 'hello.txt'), 'utf8') === 'V2-DATA', 'C20 VALID2 写入 V2-DATA');
    const st2 = await get(WP, '/api/overlay/status', hdr);
    ok(st2 && st2.current && st2.current.version === '9.9.10-test2', 'C21 status current.version=9.9.10-test2');

    // ── D 段: 可恢复(rollback 一步回退到上一步状态) ──
    console.log('── D 段: 可恢复(API rollback 一回退 V2-DATA -> NEW-OVERLAY-DATA) ──');
    // rollback 需无服务监听 8765/8799;本测试服务在 WP(随机端口),API 带 -Force 跳过端口拒。
    const rbApi = await post(WP, '/api/overlay/rollback', {}, hdr);
    ok(rbApi && rbApi.ok === true, 'D1 POST rollback ok=true');
    ok(rbApi && typeof rbApi.restored === 'number' && rbApi.restored >= 1, 'D2 rollback restored>=1 文件');
    ok(fs.readFileSync(path.join(DEPLOY, 'app', 'public', 'hello.txt'), 'utf8') === 'NEW-OVERLAY-DATA', 'D3 rollback 一回退 hello.txt=NEW-OVERLAY-DATA(上一步状态,V2-DATA 已回退)');

  } finally {
    kill(wb);
  }

  // ── E 段: 故障注入(verify 失败检测 + 中断可恢复 + 审计可追溯,EC-B 退出条件#2) ──
  console.log('── E 段: 故障注入(verify 失败 + 中断可恢复 + 审计追溯) ──');
  // 独立部署,避免污染 D 段状态。VALID_PKG 是合法 overlay 包目录(仍在)。
  const DEPLOY_E = path.join(HOME, 'deploy-e');
  fs.mkdirSync(path.join(DEPLOY_E, 'app', 'public'), { recursive: true });
  fs.writeFileSync(path.join(DEPLOY_E, 'app', 'public', 'hello.txt'), 'ORIGINAL-E');
  fs.writeFileSync(path.join(DEPLOY_E, 'package.json'), JSON.stringify({ version: '2.0.1' }));
  // apply 合法包(建备份 + 写新内容)
  const ea = runPs1('apply', VALID_PKG, DEPLOY_E);
  ok(ea.json && ea.json.ok === true, 'E1 apply 合法包到 E 部署 ok=true');
  ok(fs.readFileSync(path.join(DEPLOY_E, 'app', 'public', 'hello.txt'), 'utf8') === 'NEW-OVERLAY-DATA', 'E2 apply 写入新内容');
  // 故障:篡改已应用文件(模拟磁盘损坏 / 杀毒实时改写 / copy 中途留下损坏文件)
  fs.writeFileSync(path.join(DEPLOY_E, 'app', 'public', 'hello.txt'), 'CORRUPTED-BY-FAULT');
  // verify 应检测到 mismatch(post-apply 完整性校验的独立验证)
  const ev = runPs1('verify', VALID_PKG, DEPLOY_E);
  ok(ev.json && ev.json.ok === false, 'E3 verify 检测到篡改 ok=false');
  ok(ev.json && Array.isArray(ev.json.mismatches) && ev.json.mismatches.some(m => m.includes('hello.txt')), 'E4 verify mismatches 含 hello.txt');
  // 中断可恢复:rollback -Force 恢复到 apply 前的原数据(用户数据不丢)
  const er = runPs1('rollback', null, DEPLOY_E, ['-Force']);
  ok(er.json && er.json.ok === true, 'E5 故障后 rollback -Force 恢复 ok=true');
  ok(fs.readFileSync(path.join(DEPLOY_E, 'app', 'public', 'hello.txt'), 'utf8') === 'ORIGINAL-E', 'E6 rollback 恢复用户原数据(故障可恢复,数据不丢)');
  // 审计可追溯:audit 尾含 apply ok(故障前)+ rollback ok(恢复),整条故障->恢复链可追溯
  const eau = runPs1('audit', null, DEPLOY_E);
  ok(eau.json && eau.json.entries.some(e => e.action === 'apply' && e.result === 'ok'), 'E7 audit 含 apply ok(故障前状态)');
  ok(eau.json && eau.json.entries.some(e => e.action === 'rollback' && e.result === 'ok'), 'E8 audit 含 rollback ok(恢复操作)');
  ok(eau.json && eau.json.entries.filter(e => e.action === 'apply' || e.action === 'rollback').length >= 2, 'E9 audit 完整追溯故障->恢复链(>=2 条)');

  // 收尾
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`);
  process.exit(failures === 0 ? 0 : 1);
})().catch(e => { console.error('FATAL', e); process.exit(2); });
