(async () => {
'use strict';
// Workspace information-architecture contract. The right pane is for user-visible files, outputs,
// changes and progress; model-facing execution tools stay behind the conversation/runtime boundary.
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');
const { readFrontendSrc } = require('./read-frontend-src.js');

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const PUB = path.join(WB, 'app', 'public');
const WB_PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function between(hay, startNeedle, endNeedle) {
  const i = hay.indexOf(startNeedle);
  if (i < 0) return '';
  const j = hay.indexOf(endNeedle, i);
  return j < 0 ? hay.slice(i) : hay.slice(i, j + endNeedle.length);
}
function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, res => {
      let body = ''; res.on('data', c => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function getJson(port, requestPath) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: requestPath, timeout: 4000 }, res => {
      let body = ''; res.on('data', c => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function killp(child) {
  if (!child || !child.pid) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail++; console.log('FAIL ' + label); }
};

const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const css = require('./read-frontend-css.js').readFrontendCss();
const appjs = readFrontendSrc();
const toolTabs = between(html, '<div class="tool-tabs"', '</div>');
ok(!!toolTabs, '① 找到工作区 tablist');
for (const tab of ['files', 'artifacts', 'changes', 'agent-runs', 'usage', 'audit'])
  ok(toolTabs.includes(`data-tab="${tab}"`), `① 用户视图 ${tab} 存在`);
for (const tab of ['powershell', 'desktop', 'mcp', 'debug', 'storage'])
  ok(!toolTabs.includes(`data-tab="${tab}"`), `① 底层页签 ${tab} 未暴露`);
ok(/role="tablist"/.test(toolTabs) && /aria-selected="true"/.test(toolTabs), '① tablist 可访问语义完整');

for (const id of ['runPsBtn', 'searchBtn', 'readFileBtn', 'browserOpenBtn', 'screenshotBtn', 'refreshMcpBtn'])
  ok(!html.includes(`id="${id}"`), `② #${id} 不再对用户暴露`);
ok(/class="workspace-assist"/.test(html) && /tool\.askRuyiForFiles/.test(html), '② 文件页改为自然语言引导');

ok(/<button[^>]*data-tab="files"[^>]*class="active"|<button[^>]*class="active"[^>]*data-tab="files"/.test(toolTabs), '③ files 默认激活');
ok(/<section class="tool-section active" id="tab-files">/.test(html), '③ #tab-files 默认激活');
ok(/id="toolOutput" class="tool-output hidden"/.test(html), '③ raw tool output 仅作隐藏兼容宿主');

const doctor = between(html, '<div class="settings-tab" id="stab-doctor">', '<!-- ===== 高级 ===== -->');
for (const id of ['storageSummary', 'metricsPanel', 'rawEvents', 'debugDownloadBtn'])
  ok(doctor.includes(`id="${id}"`), `④ #${id} 已迁入设置体检`);
ok(/\.tool-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(3/.test(css), '④ 右栏六视图为稳定三列布局');

const composerActions = between(html, '<div class="composer-actions">', '</div>');
ok(!/id="compactBtn"/.test(composerActions) && /id="compactBtn"/.test(html), '⑤ 压缩控件未回潮到 composer');
// 121-K5 重钩（前值钉的是「安全 #permChip 留在 2.0 那一条 topbar 里」）。
// §2.5／§3.1：线程的权限／模型／引擎在任一视角只画一次 —— #permChip 与 #modelChip 都退役，
// 位置由线程头第二行那一组 chip（#threadChips，工厂在 js/steward-chips.js）接手。于是：
//   · 本线程的权限 → 线程头 #threadChips（一处控件、一条 PATCH /api/sessions/:id）；
//   · 新任务的默认权限 → 外框顶栏的盾牌 #stewardShieldBtn（全局，一处写口）；
//   · 「更多」（#moreMenuBtn）是【全局】入口，仍在外框顶栏的齿轮菜单 #appGearMenu。
// 钩的事实还是那一条：每个入口都在、且各只有一枚（没有第二份）。
// 反向验证：把 #permChip 那一段 HTML 加回线程头 → 「零残留」那一半当场红。
const topbar = between(html, '<header class="topbar thread-head" id="threadHead">', '</header>');
const appTopbar = between(html, '<header class="app-topbar" id="appTopbar">', '</header>');
const gearMenu = between(appTopbar, '<div id="appGearMenu" class="app-gear-menu" role="menu" hidden>', '</div>');
ok(/id="threadChips"/.test(topbar) && /id="stewardShieldBtn"/.test(appTopbar) && /id="moreMenuBtn"/.test(gearMenu)
  && (html.match(/ id="moreMenuBtn"/g) || []).length === 1
  && (html.match(/ id="threadChips"/g) || []).length === 1
  && (html.match(/ id="stewardShieldBtn"/g) || []).length === 1
  && !/ id="permChip"/.test(html) && !/ id="modelChip"/.test(html),
  '⑥ 线程配置、新任务默认权限、更多三个入口各只一枚：线程头 #threadChips ／ 顶栏盾牌 ／ 齿轮菜单（121-K5 §2.5）');
ok(/function openPermPopover\(/.test(appjs) && /function openMoreMenu\(/.test(appjs), '⑥ 顶栏弹层处理器存在');

const tempHome = path.join(os.tmpdir(), 'wcw-ia-e2e');
fs.rmSync(tempHome, { recursive: true, force: true });
fs.mkdirSync(tempHome, { recursive: true });
const env = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: tempHome };
delete env.RUYI_HOME;
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
try {
  let ready = null;
  // 121-治抖动（2026-09-12 换机器实测）：这一行是「服务起得来」的门，不是性能指标。全新 HOME 首启
  // 会走 01-config detectDesktopMcp 的三次 python 探针（python/python3/py -3 各 ~1.7 s，装了 Python
  // 但没装 mcp 包的机器每次都慢失败）＋ claude/kimi CLI 探针，实测 6.5 s 才到 /health —— 原来 40×150ms
  // = 6 s 的预算在这种机器上必红（基线提交同样红，不是回归）。门放到 20 s；探针本身的阻塞登记为产品债。
  for (let i = 0; i < 134 && !ready; i++) { await sleep(150); ready = await health(WB_PORT); }
  ok(!!ready, '⑦ workbench listening（全新 HOME）');
  const status = await getJson(WB_PORT, '/api/status');
  ok(status && status.config && status.config.uiMode === 'simple', '⑦ 新装默认 simple 模式');
} finally {
  killp(wb);
  await sleep(250);
  fs.rmSync(tempHome, { recursive: true, force: true });
}

console.log('\nIA E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
process.exit(fail ? 1 : 0);
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
