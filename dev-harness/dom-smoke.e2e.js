'use strict';
// E2E (第46波46c): 浏览器 DOM 冒烟 v1 —— 真实浏览器渲染真实前端,零依赖。
//
// 路线:系统 Edge/Chrome headless `--dump-dom --virtual-time-budget`(Windows 必装 Edge,
// CI windows-latest 同),不引入 Playwright/npm 依赖。01 方案说"Playwright 已捆绑"实测不成立
// (无 node_modules / 无 npm 包 / 无 python playwright),且本仓零依赖纪律优先 —— 视觉回归门
// (第50波)届时也可用同款 headless --screenshot 延续零依赖,或再评估引入 Playwright。
//
// v1 断言三层:
//   (A) 静态资源完整:/ /app.js /styles.css /locales/zh-CN.json 全 200(抓 404/MIME 回归)
//   (B) 渲染后 DOM 结构:sidebar/sessionList/messages/promptInput/sendBtn/modelChip/
//       workflowEditorBtn/newSessionBtn 在;__WCW_TOKEN__ 占位符已替换(抓 token 注入回归)
//   (C) JS 真启动:modelChip 的 title 由 app.js 拉 /api/status 后渲染("Claude CLI · 默认"),
//       它在静态 index.html 里不存在 —— 在 = JS boot + API 通路 + 渲染管线全活。
//
// v1 不覆盖(留给第50波视觉回归门的 v2): 控制台错误捕获、交互(点开弹层/DAG 编辑器)、截图对比。
// dump-dom 无交互能力,这是刻意取舍而非遗漏。
(async () => {
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-dom-smoke-e2e');
const PORT = await getFreePort();
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

function get(p) {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: PORT, path: p, timeout: 3000 }, resp => {
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => res({ status: resp.statusCode, body: b }));
    });
    r.on('error', () => res({ status: 0, body: '' })); r.on('timeout', () => { r.destroy(); res({ status: 0, body: '' }); });
  });
}

// 浏览器探测:Edge(Win 必装) -> Chrome -> 明确 FAIL(不静默跳过,沉默的跳过 = 假绿)。
function findBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* next */ } }
  return '';
}

function dumpDom(browser, url, profileDir) {
  const r = cp.spawnSync(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-sync', '--disable-background-networking',
    '--user-data-dir=' + profileDir,
    '--virtual-time-budget=10000', // 虚拟时间快进:等 fetch /api/status + 渲染尘埃落定
    '--dump-dom', url,
  ], { encoding: 'utf8', timeout: 90000, windowsHide: true });
  return { dom: r.stdout || '', error: r.error ? String(r.error) : '', status: r.status };
}

fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass' }));
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
const profile = path.join(os.tmpdir(), 'wcw-dom-smoke-profile-' + PORT);

(async () => {
  try {
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); up = (await get('/health')).status === 200; }
    ok(up, 'workbench up on :' + PORT);

    // ── A 段: 静态资源完整 ──
    console.log('── A 段: 静态资源全 200 ──');
    for (const p of ['/', '/app.js', '/styles.css', '/locales/zh-CN.json', '/locales/en-US.json']) {
      const r = await get(p);
      ok(r.status === 200 && r.body.length > 100, 'A GET ' + p + ' -> 200 (' + r.body.length + 'B) got ' + r.status);
    }

    // ── B/C 段: 真实浏览器渲染 ──
    console.log('── B/C 段: headless 渲染 DOM ──');
    const browser = findBrowser();
    ok(!!browser, 'B0 找到系统浏览器(Edge/Chrome headless)' + (browser ? ' -> ' + path.basename(browser) : ' —— 无浏览器则本件无法成立,明确 FAIL 不静默跳过'));
    if (browser) {
      const { dom, error, status } = dumpDom(browser, 'http://127.0.0.1:' + PORT + '/', profile);
      ok(!error && status === 0 && dom.length > 50000, 'B1 dump-dom 完成 (' + dom.length + 'B, status=' + status + (error ? ', ' + error : '') + ')');
      ok(!!dom && !dom.includes('__WCW_TOKEN__'), 'B2 token 占位符已替换(__WCW_TOKEN__ 绝迹,抓 S1 注入回归)');
      ok(dom.includes('wcw-token'), 'B3 wcw-token meta 在(前端启动凭据送达)');
      for (const id of ['sidebar', 'sessionList', 'messages', 'promptInput', 'sendBtn', 'modelChip', 'workflowEditorBtn', 'newSessionBtn']) {
        ok(dom.includes('id="' + id + '"'), 'B4 结构节点 #' + id + ' 在渲染后 DOM 中');
      }
      // C 段: JS 真启动 —— modelChip title 是 app.js 拉 /api/status 后渲染的,静态 HTML 里没有。
      const chip = dom.match(/id="modelChip"[^>]*title="([^"]*)"/);
      ok(!!chip && /Claude CLI/.test(chip[1]), 'C1 modelChip 已按 /api/status 渲染引擎标签(title="' + (chip && chip[1]) + '") = JS boot + API + 渲染全活');
      ok(dom.includes('提示词、计划或问题') || dom.includes('placeholder="描述你要做的事') || /placeholder="[^"]{4,}"/.test(dom.match(/id="promptInput"[^>]*/)?.[0] || ''),
        'C2 输入框 placeholder 就位(i18n/静态文案管线活)');
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(profile, { recursive: true, force: true }); // best-effort:浏览器锁未放时留残渣无碍
    console.log('\nDOM-SMOKE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
})();
