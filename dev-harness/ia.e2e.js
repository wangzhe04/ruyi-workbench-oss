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
const topbar = between(html, '<header class="topbar">', '</header>');
ok(/id="permChip"/.test(topbar) && /id="moreMenuBtn"/.test(topbar), '⑥ 顶栏保留安全与更多入口');
ok(/function openPermPopover\(/.test(appjs) && /function openMoreMenu\(/.test(appjs), '⑥ 顶栏弹层处理器存在');

const tempHome = path.join(os.tmpdir(), 'wcw-ia-e2e');
fs.rmSync(tempHome, { recursive: true, force: true });
fs.mkdirSync(tempHome, { recursive: true });
const env = { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: tempHome };
delete env.RUYI_HOME;
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
try {
  let ready = null;
  for (let i = 0; i < 40 && !ready; i++) { await sleep(150); ready = await health(WB_PORT); }
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
