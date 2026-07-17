(async () => {
// E2E: 第31波B「shell 沙箱化 L1」(autoexec denylist 下沉到 guardFileToolPath)。
// 端口: WB 9125(已登记 dev-harness/README)。离线,Node 直跑。
// 两段:
//   A 直接单元测 guardFileToolPath(require server.js,无 HTTP 开销,测 L1 护栏本身)
//   B 全工具分发路径(起 server → /api/tools 打到 file_write/file_edit/file_delete,验 L1 真接线)
// 验收锁(设计稿§8):
//   ✓ L1 bypass 模式 .git/hooks 被拒
//   ✓ L1 路径变形(.GIT/hooks/.git./hooks/.git /hooks)均拒
//   ✓ L1 扩展路径(.github/workflows/.gitlab-ci.yml/Jenkinsfile)拒
//   ✓ L1 .gitignore/.gitattributes 不误伤
//   ✓ L1 file_edit/file_delete 对称
//   ✓ L1 .git/config/config.worktree 被拒（可用 core.hooksPath 重定向 hook）
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-shell-sandbox-e2e');
const WS = path.join(HOME, 'ws');
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(p) { if (p && p.pid) try { cp.execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
function req(method, p, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => { let j = null; try { j = JSON.parse(buf); } catch {} resolve({ status: res.statusCode, json: j, text: buf }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
async function up() { for (let i = 0; i < 60; i++) { try { const r = await req('GET', '/health'); if (r.status === 200) return true; } catch {} await sleep(150); } return false; }

// ═══════════════════════ A 段: guardFileToolPath 直接单元测 ═══════════════════════
async function runA() {
console.log('── A 段: guardFileToolPath 直接单元 ──');
  const mod = require(path.join(WB, 'app', 'server.js'));
  const guard = mod.guardFileToolPath;
  const fakeCtx = { config: { defaultWorkspace: WS }, session: { cwd: WS } };

  // L1: bypass 模式 .git/hooks 被拒
  let r = await guard(path.join(WS, '.git', 'hooks', 'pre-commit'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .git/hooks/pre-commit write → autoexec-denied');

  // L1: file_delete .git/hooks 也拒
  r = await guard(path.join(WS, '.git', 'hooks', 'post-commit'), fakeCtx, { tool: 'file_delete', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .git/hooks/post-commit delete → autoexec-denied');

  // L1: read .git/hooks 不拒(只拦 write)
  r = await guard(path.join(WS, '.git', 'hooks', 'pre-commit'), fakeCtx, { tool: 'file_read', write: false });
  ok(r.ok, 'L1 .git/hooks read → ok(不拦读)');

  // L1: 路径变形 .GIT/hooks(大小写)
  r = await guard(path.join(WS, '.GIT', 'hooks', 'pre-commit'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .GIT/hooks(大小写) → autoexec-denied');

  // L1: 路径变形 .git./hooks(尾点)
  r = await guard(path.join(WS, '.git.', 'hooks', 'pre-commit'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .git./hooks(尾点) → autoexec-denied');

  // L1: 路径变形 .git /hooks(尾空格)
  r = await guard(path.join(WS, '.git ', 'hooks', 'pre-commit'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .git /hooks(尾空格) → autoexec-denied');

  // L1: CI 扩展路径 .github/workflows/
  r = await guard(path.join(WS, '.github', 'workflows', 'ci.yml'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .github/workflows/ci.yml → autoexec-denied');

  // L1: CI 扩展路径 .gitlab-ci.yml
  r = await guard(path.join(WS, '.gitlab-ci.yml'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .gitlab-ci.yml → autoexec-denied');

  // L1: CI 扩展路径 Jenkinsfile
  r = await guard(path.join(WS, 'Jenkinsfile'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 Jenkinsfile → autoexec-denied');

  // L1: .gitignore 不误伤(工作区根级,非 .git/ 内)
  r = await guard(path.join(WS, '.gitignore'), fakeCtx, { tool: 'file_write', write: true });
  ok(r.ok, 'L1 .gitignore write → ok(不误伤)');

  // L1: .gitattributes 不误伤
  r = await guard(path.join(WS, '.gitattributes'), fakeCtx, { tool: 'file_write', write: true });
  ok(r.ok, 'L1 .gitattributes write → ok(不误伤)');

  // L1: .git/config 可通过 core.hooksPath 把 hook 重定向到任意目录，必须拒绝
  r = await guard(path.join(WS, '.git', 'config'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .git/config write → autoexec-denied(core.hooksPath 绕过)');

  r = await guard(path.join(WS, '.git', 'config.worktree'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .git/config.worktree write → autoexec-denied');

  // L1: .vscode/tasks.json
  r = await guard(path.join(WS, '.vscode', 'tasks.json'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .vscode/tasks.json → autoexec-denied');

  // L1: .vscode/launch.json
  r = await guard(path.join(WS, '.vscode', 'launch.json'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .vscode/launch.json → autoexec-denied');

  // L1: .vscode/settings.json 不误伤(非 tasks/launch)
  r = await guard(path.join(WS, '.vscode', 'settings.json'), fakeCtx, { tool: 'file_write', write: true });
  ok(r.ok, 'L1 .vscode/settings.json write → ok(不误伤,非 tasks/launch)');

  // L1: .githooks/ 目录
  r = await guard(path.join(WS, '.githooks', 'pre-commit'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .githooks/pre-commit → autoexec-denied');

  // L1: .husky/ 目录
  r = await guard(path.join(WS, '.husky', 'pre-commit'), fakeCtx, { tool: 'file_write', write: true });
  ok(!r.ok && r.code === 'autoexec-denied', 'L1 .husky/pre-commit → autoexec-denied');
}

// ═══════════════════════ B 段: 全工具分发路径(起 server → /api/tools) ═══════════════════════
async function runB() {
console.log('\n── B 段: 全工具分发路径验证 ──');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', defaultWorkspace: WS,
  }, null, 2));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stdout.on('data', () => {}); wb.stderr.on('data', () => {});
  try {
    ok(await up(), 'B workbench up on :' + WB_PORT);
    const token = (readJson(path.join(HOME, 'runtime.json')) || {}).token || '';
    const H = { 'x-wcw-token': token };

    // B1: file_write .git/hooks → autoexec-denied (bypass 模式全路径)
    const p1 = path.join(WS, '.git', 'hooks', 'pre-commit');
    const r1 = await req('POST', '/api/tools/file_write', { path: p1, content: '#!/bin/sh\necho pwned\n' }, H);
    const j1 = r1.json && r1.json.result;
    ok(r1.status === 200 && j1 && j1.code === 'autoexec-denied', 'B1 file_write .git/hooks → autoexec-denied(全路径)');

    // B2: file_edit .git/hooks → autoexec-denied(L1 对称)
    fs.mkdirSync(path.join(WS, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(WS, '.git', 'hooks', 'pre-commit'), 'echo ok\n');
    const r2 = await req('POST', '/api/tools/file_edit', { path: path.join(WS, '.git', 'hooks', 'pre-commit'), oldText: 'echo ok', newText: 'echo pwned' }, H);
    const j2 = r2.json && r2.json.result;
    ok(r2.status === 200 && j2 && j2.code === 'autoexec-denied', 'B2 file_edit .git/hooks → autoexec-denied(对称)');

    // B3: file_delete .git/hooks → autoexec-denied(L1 对称)
    const r3 = await req('POST', '/api/tools/file_delete', { path: path.join(WS, '.git', 'hooks', 'pre-commit') }, H);
    const j3 = r3.json && r3.json.result;
    ok(r3.status === 200 && j3 && j3.code === 'autoexec-denied', 'B3 file_delete .git/hooks → autoexec-denied(对称)');

    // B4: file_write .gitignore → ok(不误伤)
    const r4 = await req('POST', '/api/tools/file_write', { path: path.join(WS, '.gitignore'), content: 'node_modules\n' }, H);
    const j4 = r4.json && r4.json.result;
    ok(r4.status === 200 && j4 && j4.ok, 'B4 file_write .gitignore → ok(不误伤)');

    // B5: file_write .github/workflows/ci.yml → autoexec-denied
    const r5 = await req('POST', '/api/tools/file_write', { path: path.join(WS, '.github', 'workflows', 'ci.yml'), content: 'name: CI\n' }, H);
    const j5 = r5.json && r5.json.result;
    ok(r5.status === 200 && j5 && j5.code === 'autoexec-denied', 'B5 file_write .github/workflows/ci.yml → autoexec-denied');

    // B6: file_read .git/hooks → ok(只拦 write)
    const r6 = await req('POST', '/api/tools/file_read', { path: path.join(WS, '.git', 'hooks', 'pre-commit') }, H);
    const j6 = r6.json && r6.json.result;
    ok(r6.status === 200 && j6 && j6.ok, 'B6 file_read .git/hooks → ok(不拦读)');

  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    kill(wb);
    await sleep(300); fs.rmSync(HOME, { recursive: true, force: true });
  }
}

(async () => {
  await runA();
  await runB();
  console.log('\nSHELL-SANDBOX E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
