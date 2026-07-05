// E2E for v1.0-S2「信息架构减负」: 顶栏收敛 + 页签分组 + composer 减负 + 新装默认简易模式。
// 零依赖、离线、node 直跑。静态断言只读 index.html/styles.css/app.js；动态断言起临时 HOME 的 workbench。
//
// 静态断言（读源文件）:
//   ① .tool-tabs 呈两组结构且常驻组在前（resident group 内 files/artifacts/audit，dev group 内 powershell…）。
//   ② 存在显示文案「终端」且 data-tab="powershell" 值未变（仅显示文案改，data-tab 不动）。
//   ③ 默认 active 为 files（按钮 data-tab="files" 带 class active + section id="tab-files" 带 active）。
//   ④ .composer-actions 内无 #compactBtn，且 #compactBtn 仍存在于文档（移入弹层 host）。
//   ⑤ 顶栏 header.topbar 内无 #capBadge/#themeToggle/#uiModeToggle 作为可见控件迁出（它们仍在 DOM 供 handler 复用，
//      但被 CSS display:none）；存在 #permChip 与 #moreMenuBtn。
//   ⑥ #permSelect 仍在 DOM。
//   ⑦ styles.css 简易模式隐藏规则覆盖开发者组五页签（powershell/desktop/mcp/debug/doctor）。
//
// 动态断言（临时 HOME 起服务）:
//   ⑧ 全新 HOME 首启后 config.uiMode === 'simple'（新装默认简易）。
//   ⑨ POST 非法 uiMode 仍清洗 → 'pro'（非法值回退保持 pro；uimode-style.e2e.js 同款不变契约）。
//
// 判定行精确为 `IA E2E: ALL PASS`（失败打印明细并非零退出）。Port 8999（空闲段，见 dev-harness/README.md）。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { readFrontendSrc } = require('./read-frontend-src.js'); // v1.3-FE1:app.js 拆模块后聚合读 public/app.js+public/js/**

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const PUB = path.join(WB, 'app', 'public');
const WB_PORT = 8999;

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function postJson(port, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 4000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// Slice out the substring between an opening marker (inclusive) and the first occurrence of `endNeedle`
// after it. Used to bound assertions to a container (e.g. the <header class="topbar">…</header>).
function between(hay, startNeedle, endNeedle) {
  const i = hay.indexOf(startNeedle);
  if (i < 0) return '';
  const j = hay.indexOf(endNeedle, i);
  return j < 0 ? hay.slice(i) : hay.slice(i, j + endNeedle.length);
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
  const appjs = readFrontendSrc(); // 聚合:public/app.js + public/js/**/*.js(拆分后函数不再只在 app.js)

  // ════════════ ① tool-tabs 两组结构，常驻组在前 ════════════
  const toolTabs = between(html, '<div class="tool-tabs">', '</div>');
  ok(!!toolTabs, '① 找到 .tool-tabs 块');
  const residentIdx = toolTabs.indexOf('data-tt-group="resident"');
  const devIdx = toolTabs.indexOf('data-tt-group="dev"');
  ok(residentIdx >= 0 && devIdx >= 0, '① tool-tabs 含 resident + dev 两组');
  ok(residentIdx >= 0 && devIdx >= 0 && residentIdx < devIdx, '① 常驻组在开发者组之前');
  // 常驻组内含 files/artifacts/audit 三个，且都在 dev 组之前出现。
  for (const t of ['files', 'artifacts', 'audit']) {
    const ti = toolTabs.indexOf(`data-tab="${t}"`);
    ok(ti >= 0 && ti < devIdx, `① 常驻页签 ${t} 在开发者组之前`);
  }
  // 开发者组内含 powershell/desktop/mcp/debug/doctor 五个，且都在 dev 组标记之后。
  for (const t of ['powershell', 'desktop', 'mcp', 'debug', 'doctor']) {
    const ti = toolTabs.indexOf(`data-tab="${t}"`);
    ok(ti > devIdx, `① 开发者页签 ${t} 在开发者组内`);
  }
  // 组间视觉分隔标存在。
  ok(/class="tool-tabs-sep"/.test(toolTabs), '① 存在组间分隔标 .tool-tabs-sep');

  // ════════════ ② 显示文案「终端」+ data-tab="powershell" 未变 ════════════
  ok(/data-tab="powershell"[^>]*>\s*终端\s*</.test(toolTabs), '② powershell 页签显示文案为「终端」');
  ok(/data-tab="powershell"/.test(toolTabs), '② data-tab="powershell" 值保留未变');
  ok(!/>PowerShell</.test(toolTabs), '② 页签不再显示旧文案「PowerShell」');

  // ════════════ ③ 默认 active = files（按钮 + section 双处）════════════
  ok(/<button[^>]*data-tab="files"[^>]*class="active"|<button[^>]*class="active"[^>]*data-tab="files"/.test(toolTabs), '③ files 页签按钮带 class active');
  ok(!/data-tab="powershell"[^>]*class="active"|class="active"[^>]*data-tab="powershell"/.test(toolTabs), '③ powershell 页签按钮不再是默认 active');
  ok(/<section class="tool-section active" id="tab-files">/.test(html), '③ section#tab-files 带 active');
  ok(/<section class="tool-section" id="tab-powershell">/.test(html), '③ section#tab-powershell 不再是默认 active');

  // ════════════ ④ .composer-actions 内无 #compactBtn，但 #compactBtn 仍在文档 ════════════
  const composerActions = between(html, '<div class="composer-actions">', '</div>');
  ok(!!composerActions, '④ 找到 .composer-actions 块');
  ok(!/id="compactBtn"/.test(composerActions), '④ .composer-actions 内不含 #compactBtn');
  ok(/id="compactBtn"/.test(html), '④ #compactBtn 仍存在于文档（移入弹层 host）');

  // ════════════ ⑤ 顶栏收敛：无 capBadge/themeToggle/uiModeToggle 可见控件迁出；有 permChip + moreMenuBtn ════════════
  const topbar = between(html, '<header class="topbar">', '</header>');
  ok(!!topbar, '⑤ 找到 header.topbar 块');
  ok(/id="permChip"/.test(topbar), '⑤ 顶栏存在 #permChip');
  ok(/id="moreMenuBtn"/.test(topbar), '⑤ 顶栏存在 #moreMenuBtn');
  // capBadge/themeToggle/uiModeToggle 的 DOM 仍在（供 handler 复用）但被 CSS display:none 迁出顶栏视觉。
  ok(/\.topbar-actions\s*>\s*#capBadge/.test(css) || /#capBadge[\s,]/.test(between(css, '.topbar-actions > #capBadge', '}')), '⑤ CSS 令 #capBadge 迁出顶栏（display:none）');
  const hideRule = between(css, '.topbar-actions > #capBadge', '}');
  ok(/#themeToggle/.test(hideRule) && /#uiModeToggle/.test(hideRule) && /display:\s*none/.test(hideRule), '⑤ 同一规则迁出 #themeToggle/#uiModeToggle（display:none）');

  // ════════════ ⑥ #permSelect 仍在 DOM ════════════
  ok(/id="permSelect"/.test(html), '⑥ #permSelect 仍在 DOM');

  // ════════════ ⑦ 简易模式隐藏规则覆盖开发者组五页签 ════════════
  // 收集所有 [data-ui-mode="simple"] .tool-tabs button[data-tab="X"] 选择器命中的 X。
  const simpleHidden = new Set();
  const re = /\[data-ui-mode="simple"\]\s*\.tool-tabs\s*button\[data-tab="([a-z]+)"\]/g;
  let m; while ((m = re.exec(css))) simpleHidden.add(m[1]);
  for (const t of ['powershell', 'desktop', 'mcp', 'debug', 'doctor']) {
    ok(simpleHidden.has(t), `⑦ 简易模式隐藏开发者页签 ${t}`);
  }

  // Sanity: app.js 里的 handler 迁移锚点（不放松行为，仅确认新入口存在）。
  ok(/function openPermPopover\(/.test(appjs), '(sanity) app.js 定义 openPermPopover（安全弹层）');
  ok(/function openMoreMenu\(/.test(appjs), '(sanity) app.js 定义 openMoreMenu（⋯菜单）');

  // ════════════ 动态：临时 HOME 起服务 ════════════
  const HOME = path.join(os.tmpdir(), 'wcw-ia-e2e');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  // 注意：不预写 config.json —— 要验证「全新安装」时服务端生成的默认配置为 simple。
  const env = { ...process.env }; delete env.RUYI_HOME; env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, '⑧ workbench listening（全新 HOME）');
    const token = await getToken(WB_PORT);
    ok(!!token, '⑧ UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // ⑧ 全新 HOME 首启 → config.uiMode === 'simple'。
    let st = await getJson(WB_PORT, '/api/status');
    ok(st.json && st.json.config && st.json.config.uiMode === 'simple', '⑧ 新装默认 uiMode === simple（got ' + (st.json && st.json.config && st.json.config.uiMode) + '）');
    // 且落盘 config.json 也是 simple。
    const disk = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(disk.uiMode === 'simple', '⑧ 磁盘 config.json uiMode === simple（got ' + disk.uiMode + '）');

    // ⑨ POST 非法 uiMode 仍清洗 → 'pro'（非法回退保持 pro；与 uimode-style.e2e.js 同款不变契约）。
    const bad = await postJson(WB_PORT, '/api/config', { uiMode: 'ultra' }, hdr);
    ok(bad.status === 200 && bad.json && bad.json.ok === true, '⑨ POST 非法 uiMode 被接受（清洗）');
    st = await getJson(WB_PORT, '/api/status');
    ok(st.json && st.json.config && st.json.config.uiMode === 'pro', '⑨ 非法 uiMode 清洗 → pro（got ' + (st.json && st.json.config && st.json.config.uiMode) + '）');
  } finally {
    killp(wb);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log('\nIA E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
