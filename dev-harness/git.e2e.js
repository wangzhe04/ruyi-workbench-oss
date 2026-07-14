// E2E for v1.0-S4「git 工具族 + diff 查看器」。零依赖、离线、node 直跑;端口取空闲段(free-port)。
// 风格参考 ia.e2e.js / tools-v2.e2e.js:临时 HOME 起 workbench,直击 POST /api/tools/<name>(token 门)。
//
// 前置:execFile `git --version` 探测。**git 缺失的机器**:打印跳过说明后仍以精确判定行 `GIT E2E: ALL PASS`
// 收尾(离线可移植)。本机有 git 2.51 → 真跑下列路径:
//   ① git_status:未跟踪文件 → 结果含 untracked / 人话摘要;
//   ② git_commit → 返回 hash;git_log maxCount:5 → 含该 message;
//   ③ 修改文件 → git_diff → 输出含 `+` 新行与 `-` 旧行;
//   ④ 走私探针:git_diff {path:'--output=<临时文件>'} → 该文件不存在(`--` 分隔防御生效)、且不崩溃;
//   ⑤ git 仓库外目录调 git_status → 人话引导错误(非崩溃);
//   ⑥ 静态:server.js 的 git_commit tier 为 exec;app.js 含 .diff-view 渲染(textContent 构建);
//      styles.css 的 .diff-add/.diff-del 只用令牌 / color-mix。
//
// 末行判定固定为 `GIT E2E: ALL PASS`(任何失败打印明细并以非零码退出)。finally 清临时 HOME/仓库。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port');
const { readFrontendSrc } = require('./read-frontend-src.js'); // v1.3-FE1:app.js 拆模块后聚合读 public/app.js+public/js/**

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const PUB = path.join(WB, 'app', 'public');
const SERVER_JS = path.join(WB, 'app', 'server.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// POST a tool call; returns the parsed tool RESULT object (unwraps { ok, result }). Never throws.
function callTool(port, token, name, args) {
  return new Promise(resolve => {
    const data = JSON.stringify(args || {});
    const req = http.request({ host: '127.0.0.1', port, path: '/api/tools/' + name, method: 'POST', timeout: 20000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), 'x-wcw-token': token } }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve(j && typeof j === 'object' && 'result' in j ? j.result : j); });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(data); req.end();
  });
}

// Run git in a dir, synchronously, ignoring failures (used for repo setup). Returns stdout string.
function git(cwd, args) {
  try { return cp.execFileSync('git', args, { cwd, windowsHide: true, timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}
function gitAvailable() {
  try { const r = cp.spawnSync('git', ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 3000 }); return !r.error && r.status === 0; }
  catch { return false; }
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ══════════ 静态断言(不依赖 git,总是跑)══════════
  {
    const server = fs.readFileSync(SERVER_JS, 'utf8');
    const appjs = readFrontendSrc(); // 聚合:public/app.js + public/js/**/*.js(拆分后函数不再只在 app.js)
    const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');

    // ⑥a server.js 的 NATIVE_TOOL_TIER 表里 git_commit 为 exec(读 tier 表断言)。
    ok(/git_commit:\s*'exec'/.test(server), "⑥ server.js NATIVE_TOOL_TIER git_commit === 'exec'");
    // git_diff / git_log 为 read;git_status 亦 read。
    ok(/git_diff:\s*'read'/.test(server) && /git_log:\s*'read'/.test(server), "⑥ server.js git_diff/git_log === 'read'");
    ok(/git_status:\s*'read'/.test(server), "⑥ server.js git_status === 'read'");
    // TOOL_REQUIRES 四条 gitCli。
    ok(/git_commit:\s*\{\s*requires:\s*\['gitCli'\]/.test(server), '⑥ TOOL_REQUIRES git_commit requires gitCli');
    // ⑥d 安全加固(对抗复核 CRITICAL防回潮,git 缺失机器也守):runGit 前置 GIT_SAFE_FLAGS 中和仓库自带
    // core.fsmonitor / diff.external;gitDiff 加 --no-textconv。全部覆盖仓库配置的代码执行面。
    ok(/GIT_SAFE_FLAGS\s*=\s*\[[^\]]*core\.fsmonitor=/.test(server), '⑥ server.js GIT_SAFE_FLAGS 含 core.fsmonitor=(中和 fsmonitor RCE)');
    ok(/\[\s*\.\.\.GIT_SAFE_FLAGS\s*,\s*\.\.\.args\s*\]/.test(server), '⑥ runGit 对所有 git 调用前置 GIT_SAFE_FLAGS');
    // gitDiff 用 --no-ext-diff --no-textconv 封 diff.external / textconv 面(不能用 `-c diff.external=` 空值——会破坏正常 diff)。
    ok(/'diff',\s*'--no-ext-diff',\s*'--no-textconv'/.test(server), '⑥ gitDiff 加 --no-ext-diff --no-textconv(封 diff.external/textconv 面)');
    ok(!/GIT_SAFE_FLAGS\s*=\s*\[[^\]]*diff\.external=/.test(server), '⑥ GIT_SAFE_FLAGS 不含空 diff.external=(会破坏正常 diff)');

    // ⑥b app.js 含 .diff-view 渲染,且逐行用 textContent(禁 innerHTML)构建。
    ok(/renderDiffView/.test(appjs) && /'diff-view'/.test(appjs), "⑥ app.js 定义 renderDiffView('diff-view')");
    // diff 行赋值走 textContent(load-bearing 安全约束);renderDiffView 内不得用 innerHTML。
    const rdvIdx = appjs.indexOf('function renderDiffView');
    const rdvBody = rdvIdx >= 0 ? appjs.slice(rdvIdx, rdvIdx + 1400) : '';
    ok(/row\.textContent\s*=/.test(rdvBody), '⑥ renderDiffView 逐行以 row.textContent 赋值');
    ok(rdvIdx >= 0 && !/innerHTML/.test(rdvBody), '⑥ renderDiffView 内不使用 innerHTML');

    // ⑥c styles.css 的 .diff-add / .diff-del 只用令牌 / color-mix(无颜色字面量)。
    const takeRule = (sel) => { const i = css.indexOf(sel); if (i < 0) return ''; const o = css.indexOf('{', i); const c = css.indexOf('}', o); return (o < 0 || c < 0) ? '' : css.slice(o + 1, c); };
    const addRule = takeRule('.diff-view .diff-add');
    const delRule = takeRule('.diff-view .diff-del');
    ok(!!addRule, '⑥ styles.css 存在 .diff-add 规则');
    ok(!!delRule, '⑥ styles.css 存在 .diff-del 规则');
    const noColorLiteral = (rule) => !/#[0-9a-fA-F]{3,8}\b/.test(rule) && !/\brgba?\(/.test(rule) && !/\bhsla?\(/.test(rule);
    ok(noColorLiteral(addRule), '⑥ .diff-add 无颜色字面量(仅令牌/color-mix)');
    ok(noColorLiteral(delRule), '⑥ .diff-del 无颜色字面量(仅令牌/color-mix)');
    ok(/var\(--ok-bg\)/.test(addRule), '⑥ .diff-add 用 var(--ok-bg)(语义背景令牌,v3 P1 收敛手写 color-mix)');
    ok(/var\(--danger-bg\)/.test(delRule), '⑥ .diff-del 用 var(--danger-bg)(语义背景令牌,v3 P1 收敛手写 color-mix)');
  }

  // ══════════ 动态断言(需 git;缺失则跳过但仍 ALL PASS)══════════
  if (!gitAvailable()) {
    console.log('SKIP 动态路径:本机未检测到 git(离线可移植)。静态断言已覆盖 tier/前端/样式契约。');
    console.log('\nGIT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
    return;
  }

  const WB_PORT = await getFreePort();
  const HOME = path.join(os.tmpdir(), 'wcw-git-e2e-home');
  const REPO = path.join(os.tmpdir(), 'wcw-git-e2e-repo');
  const OUTSIDE = path.join(os.tmpdir(), 'wcw-git-e2e-outside'); // 非 git 仓库目录
  const SMUGGLE = path.join(os.tmpdir(), 'wcw-git-e2e-smuggle.txt'); // 走私探针目标文件(须不被创建)
  for (const p of [HOME, REPO, OUTSIDE]) { fs.rmSync(p, { recursive: true, force: true }); fs.mkdirSync(p, { recursive: true }); }
  fs.rmSync(SMUGGLE, { force: true });

  // 建仓 + 本仓身份(不污染全局 git config)。
  git(REPO, ['init', '-b', 'main']);
  git(REPO, ['config', 'user.name', 'E2E Bot']);
  git(REPO, ['config', 'user.email', 'e2e@example.com']);
  git(REPO, ['config', 'commit.gpgsign', 'false']);
  git(REPO, ['config', 'core.hooksPath', '/dev/null']); // 屏蔽任何全局 hook,commit 保持纯净

  let wb;
  try {
    // 临时 HOME 起服务(bypass 权限模式;直击 /api/tools 本就不过权限门,仅需 token)。
    fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass' }, null, 2));
    const env = { ...process.env }; delete env.RUYI_HOME; env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
    wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening');
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');

    // ① git_status:未跟踪文件 → untracked + 人话摘要。
    fs.writeFileSync(path.join(REPO, 'hello.txt'), 'hello world\nline two\n');
    const st1 = await callTool(WB_PORT, token, 'git_status', { cwd: REPO });
    ok(st1 && st1.ok === true, '① git_status ok');
    ok(st1 && st1.untracked >= 1, '① git_status 报告 untracked >= 1 (got ' + (st1 && st1.untracked) + ')');
    ok(st1 && typeof st1.summary === 'string' && /分支/.test(st1.summary) && /改动/.test(st1.summary), '① git_status 人话摘要含 分支/改动 (got "' + (st1 && st1.summary) + '")');

    // ② git_commit → hash;git_log maxCount:5 → 含该 message。
    const MSG = 'e2e: first commit';
    const cm = await callTool(WB_PORT, token, 'git_commit', { cwd: REPO, message: MSG });
    ok(cm && cm.ok === true, '② git_commit ok (' + (cm && (cm.error || cm.summary)) + ')');
    ok(cm && typeof cm.hash === 'string' && /^[0-9a-f]{4,40}$/.test(cm.hash), '② git_commit 返回 hash (got "' + (cm && cm.hash) + '")');
    const lg = await callTool(WB_PORT, token, 'git_log', { cwd: REPO, maxCount: 5 });
    ok(lg && lg.ok === true && Array.isArray(lg.commits) && lg.commits.length >= 1, '② git_log 返回 commits');
    ok(lg && lg.commits.some(c => c.subject === MSG), '② git_log 含该 commit message');
    ok(lg && lg.commits[0] && lg.commits[0].author === 'E2E Bot', '② git_log 携带 author');

    // ③ 修改文件 → git_diff → 含 `+` 新行与 `-` 旧行。
    fs.writeFileSync(path.join(REPO, 'hello.txt'), 'HELLO WORLD\nline two\n'); // 改第一行
    const df = await callTool(WB_PORT, token, 'git_diff', { cwd: REPO });
    ok(df && df.ok === true && typeof df.diff === 'string', '③ git_diff ok');
    const diffLines = (df && df.diff || '').split('\n');
    ok(diffLines.some(l => /^\+HELLO WORLD/.test(l)), '③ git_diff 含 + 新行 (+HELLO WORLD)');
    ok(diffLines.some(l => /^-hello world/.test(l)), '③ git_diff 含 - 旧行 (-hello world)');

    // ④ 走私探针:path='--output=<abs>' → 该文件不存在(`--` 分隔生效)、调用不崩溃。
    const smug = await callTool(WB_PORT, token, 'git_diff', { cwd: REPO, path: '--output=' + SMUGGLE });
    ok(smug && smug.ok === true, '④ 走私探针 git_diff 未崩溃(返回 ok)');
    ok(!fs.existsSync(SMUGGLE), '④ 走私目标文件未被创建(`--` 分隔防御生效)');

    // ⑤ 仓库外目录调 git_status → 人话引导错误(非崩溃)。
    const outSt = await callTool(WB_PORT, token, 'git_status', { cwd: OUTSIDE });
    ok(outSt && outSt.ok === false, '⑤ 仓库外 git_status ok:false(非崩溃)');
    ok(outSt && typeof outSt.error === 'string' && /Git 仓库/.test(outSt.error), '⑤ 人话引导错误含「Git 仓库」(got "' + (outSt && outSt.error) + '")');

    // ⑥ 安全防回潮(对抗复核 CONFIRMED·CRITICAL):被操作仓库自带的恶意 core.fsmonitor 不得经 read 档 git 工具
    // 执行(git_status/git_diff 零弹窗 → 若不加固即无提示 RCE)。武装一个会留痕的 sh fsmonitor hook,先用裸
    // git status(控制组,证明 hook 确实武装)、再经 git_status 工具(须被 GIT_SAFE_FLAGS 的 -c core.fsmonitor=
    // 中和,标记不得落地)。git for Windows 用自带 sh 执行 hook,故用 .sh。
    const MARK = path.join(os.tmpdir(), 'wcw-git-e2e-fsmon-mark.txt');
    const HOOK = path.join(REPO, 'evil-fsmon.sh');
    fs.rmSync(MARK, { force: true });
    fs.writeFileSync(HOOK, '#!/bin/sh\ntouch "' + MARK.replace(/\\/g, '/') + '"\nprintf "trigger\\0"\n');
    try { fs.chmodSync(HOOK, 0o755); } catch { /* ignore on win */ }
    git(REPO, ['config', 'core.fsmonitorHookVersion', '2']);
    git(REPO, ['config', 'core.fsmonitor', HOOK.replace(/\\/g, '/')]);
    fs.writeFileSync(path.join(REPO, 'hello.txt'), 'HELLO WORLD dirtied for fsmonitor\n'); // 让 status 读 index
    // 控制组:裸 git status(不经工具、无 GIT_SAFE_FLAGS)——本机若 fsmonitor 可触发则标记落地,证明 hook 武装。
    fs.rmSync(MARK, { force: true });
    git(REPO, ['status', '--porcelain=v1', '-b']);
    const armed = fs.existsSync(MARK);
    console.log('   (⑥ 控制组:裸 git status ' + (armed ? '触发了 hook — 已武装,以下加固断言有效' : '未触发 hook — 本机 fsmonitor 不可触发,加固断言退化为非否定') + ')');
    // 加固断言:经 git_status 工具后标记不得落地(GIT_SAFE_FLAGS 中和恶意 fsmonitor)。
    fs.rmSync(MARK, { force: true });
    const rce = await callTool(WB_PORT, token, 'git_status', { cwd: REPO });
    ok(rce && (rce.ok === true || rce.ok === false), '⑦ git_status(恶意仓库)未崩溃');
    ok(!fs.existsSync(MARK), '⑦ 恶意 core.fsmonitor 未经 git_status 工具执行(GIT_SAFE_FLAGS 中和)' + (armed ? '' : ' [控制组未武装,仅非否定]'));
    // 同样验 git_diff 路径(diff 亦读 index → 亦触发 fsmonitor)。
    fs.rmSync(MARK, { force: true });
    await callTool(WB_PORT, token, 'git_diff', { cwd: REPO });
    ok(!fs.existsSync(MARK), '⑦ 恶意 core.fsmonitor 未经 git_diff 工具执行');
    // 第二个 diff 面:恶意 diff.external 外部差异器(裸 git diff 会执行 → 已实证)。git_diff 的 --no-ext-diff
    // 须中和它。武装后经 git_diff 工具调用,标记不得落地。
    git(REPO, ['config', '--unset', 'core.fsmonitor']); // 先撤 fsmonitor,单独验 diff.external
    const EXT = path.join(REPO, 'evil-ext.sh');
    fs.writeFileSync(EXT, '#!/bin/sh\ntouch "' + MARK.replace(/\\/g, '/') + '"\n');
    try { fs.chmodSync(EXT, 0o755); } catch { /* ignore on win */ }
    git(REPO, ['config', 'diff.external', EXT.replace(/\\/g, '/')]);
    fs.writeFileSync(path.join(REPO, 'hello.txt'), 'HELLO WORLD ext-diff probe\n');
    fs.rmSync(MARK, { force: true });
    const extDf = await callTool(WB_PORT, token, 'git_diff', { cwd: REPO });
    ok(extDf && typeof extDf.diff === 'string', '⑦ git_diff(恶意 diff.external 仓库)仍正常产出 diff(--no-ext-diff 未破坏)');
    ok(!fs.existsSync(MARK), '⑦ 恶意 diff.external 未经 git_diff 工具执行(--no-ext-diff 中和)');
    // 清理 hook 配置(避免污染后续/清理阶段的 git 调用)。
    git(REPO, ['config', '--unset', 'diff.external']);
    fs.rmSync(MARK, { force: true });
  } catch (e) {
    ok(false, 'ERROR ' + (e && e.message || e));
  } finally {
    killp(wb);
    await sleep(300);
    for (const p of [HOME, REPO, OUTSIDE]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(SMUGGLE, { force: true }); } catch { /* ignore */ }
  }

  console.log('\nGIT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
