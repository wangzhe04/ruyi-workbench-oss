// E2E for v1.0-S3「新手起步与设置补全」: 首跑引导 + 设置补全（联网搜索 / provider vision）+ 小白安全默认。
// 零依赖、离线、node 直跑。静态断言读 index.html/styles.css/app.js；动态断言起临时 HOME 的 workbench。
//
// 静态断言（读源文件）:
//   ① index.html 有 data-stab="network" 页签 + searchBackend 表单控件（type/baseUrl/apiKey）。
//   ② app.js 含首跑引导渲染函数（buildFirstRunState / isFirstRun）+ 触发条件读 recentWorkspaces/会话空；
//      且含 provider vision checkbox 构建代码（p.vision 读写）。
//   ③ styles.css 首跑引导区样式只用令牌（.onboard-drop 无 #hex / rgba() 字面量；hover/dragging 走 --accent）。
//
// 动态断言（临时 HOME 起服务）:
//   ④ 全新 HOME 首启 config: permissionMode==='default' && engineMode==='interactive'
//      && permissionBridge===true && uiMode==='simple'。
//   ⑤ searchBackend 掩码回存往返: POST {type:'searxng',baseUrl,apiKey:真值} → GET /api/status apiKey 是掩码
//      （非明文、hasKey===true）→ 把掩码原样 POST 回去 → 读磁盘 config.json: apiKey 仍是真值（掩码回存不覆盖）。
//   ⑥ provider vision 存续: POST providers[{id:'t1',...,vision:true}] → GET: vision===true。
//
// 判定行精确为 `ONBOARD E2E: ALL PASS`（失败打印明细并非零退出）。Port 8997（空闲段，见 dev-harness/README.md）。
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
const WB_PORT = 8997;

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

// Slice out the substring between an opening marker (inclusive) and the first `endNeedle` after it.
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

  // ════════════ ① 联网搜索页签 + searchBackend 表单控件 ════════════
  const settingsTabs = between(html, '<div class="tool-tabs settings-tabs" id="settingsTabs">', '</div>');
  ok(/data-stab="network"/.test(settingsTabs), '① 设置有 data-stab="network" 页签');
  // 页签顺序：network 在 integrations 之后、advanced 之前。
  const iIdx = settingsTabs.indexOf('data-stab="integrations"');
  const nIdx = settingsTabs.indexOf('data-stab="network"');
  const aIdx = settingsTabs.indexOf('data-stab="advanced"');
  ok(iIdx >= 0 && nIdx > iIdx && aIdx > nIdx, '① network 页签插在 集成/MCP 之后、高级 之前');
  const netPanel = between(html, 'id="stab-network"', 'id="stab-advanced"');
  ok(!!netPanel, '① 找到 #stab-network 面板');
  ok(/id="cfgSearchType"/.test(netPanel), '① 面板含类型 select #cfgSearchType');
  // 五枚举齐全，'none' 显示为「不启用」。
  for (const v of ['none', 'searxng', 'bing', 'brave', 'custom']) ok(new RegExp(`value="${v}"`).test(netPanel), `① 类型 select 含枚举 ${v}`);
  ok(/value="none"[^>]*>\s*不启用\s*</.test(netPanel), '① none 显示为「不启用」');
  ok(/id="cfgSearchBaseUrl"/.test(netPanel), '① 面板含 Base URL 文本框 #cfgSearchBaseUrl');
  ok(/id="cfgSearchApiKey"[^>]*type="password"/.test(netPanel) || /id="cfgSearchApiKey"[\s\S]*?type="password"/.test(between(netPanel, 'id="cfgSearchApiKey"', '>')), '① 面板含 API Key password 框 #cfgSearchApiKey');
  ok(/配置后 AI 可以联网搜索/.test(netPanel), '① 面板顶部人话说明存在');

  // ════════════ ② app.js 首跑引导渲染 + 触发条件 + provider vision ════════════
  ok(/function buildFirstRunState\(/.test(appjs), '② app.js 定义 buildFirstRunState（首跑引导渲染）');
  ok(/function isFirstRun\(/.test(appjs), '② app.js 定义 isFirstRun（触发判定）');
  // 触发条件读 recentWorkspaces 与会话空。
  ok(/isFirstRun[\s\S]{0,400}recentWorkspaces/.test(appjs) && /isFirstRun[\s\S]{0,400}state\.sessions/.test(appjs), '② isFirstRun 读 state.sessions + config.recentWorkspaces');
  // 引擎状态派生做成小函数（不嵌模板）。
  ok(/function engineReadiness\(/.test(appjs), '② app.js 定义 engineReadiness（引擎就绪派生小函数）');
  // 拖放引导区点击走文件夹选择。v1.0.2 (G6):顶栏入口改为小弹层(浏览 + 粘贴路径兜底),引导区保持一键直开
  // → 调 pickWorkspaceNative()(原 pickWorkspace 的原生选择器部分拆出);两个名字都算达标。
  ok(/buildOnboardDropZone[\s\S]{0,600}pickWorkspace(?:Native)?\(\)/.test(appjs), '② 拖放引导区点击调文件夹选择(pickWorkspace/pickWorkspaceNative)');
  // provider vision checkbox 构建代码：读写 p.vision。
  ok(/p\.vision\s*=/.test(appjs) && /checked\s*=\s*!!p\.vision/.test(appjs), '② provider 卡片含 vision checkbox（读写 p.vision）');
  ok(/支持视觉/.test(appjs), '② vision 开关文案「支持视觉」存在');

  // ════════════ ③ styles.css 首跑引导区样式只用令牌 ════════════
  // 抽取 .onboard-* 相关规则行，扫描不得含 #hex 或 rgba() 字面量（color-mix + var 允许）。
  const cssLines = css.split(/\r?\n/);
  const onboardLines = cssLines.filter(l => /\.onboard/.test(l));
  ok(onboardLines.length > 0, '③ styles.css 存在 .onboard-* 规则');
  const hexRe = /#[0-9a-fA-F]{3,8}\b/;
  const rgbaRe = /\brgba?\s*\(/;
  const offenders = onboardLines.filter(l => hexRe.test(l) || rgbaRe.test(l));
  ok(offenders.length === 0, '③ 引导区样式无颜色字面量（#hex/rgba）' + (offenders.length ? ' → 违规: ' + offenders.map(s => s.trim()).join(' | ') : ''));
  // hover/dragging 走 --accent（描边）+ --accent-soft（底），与 dropHint 心智一致。
  ok(/\.onboard-drop:hover[\s\S]{0,160}var\(--accent\)/.test(css), '③ .onboard-drop:hover 用 --accent 描边');
  ok(/\.onboard-drop\.dragging[\s\S]{0,160}var\(--accent-soft\)/.test(css), '③ .onboard-drop.dragging 用 --accent-soft 底');

  // ════════════ 动态：临时 HOME 起服务 ════════════
  const HOME = path.join(os.tmpdir(), 'wcw-onboard-e2e');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  // 不预写 config.json —— 验证「全新安装」时服务端生成的小白安全默认。
  const env = { ...process.env }; delete env.RUYI_HOME; env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, '④ workbench listening（全新 HOME）');
    const token = await getToken(WB_PORT);
    ok(!!token, '④ UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // ④ 小白安全默认（三键联动 + simple）。
    let st = await getJson(WB_PORT, '/api/status');
    const c0 = (st.json && st.json.config) || {};
    ok(c0.permissionMode === 'default', '④ 新装 permissionMode === default（got ' + c0.permissionMode + '）');
    ok(c0.engineMode === 'interactive', '④ 新装 engineMode === interactive（got ' + c0.engineMode + '）');
    ok(c0.permissionBridge === true, '④ 新装 permissionBridge === true（got ' + c0.permissionBridge + '）');
    ok(c0.uiMode === 'simple', '④ 新装 uiMode === simple（got ' + c0.uiMode + '）');

    // ⑤ searchBackend 掩码回存往返。
    const REAL = 'sk-e2e-test-secret-123456';
    const sbSet = await postJson(WB_PORT, '/api/config', { searchBackend: { type: 'searxng', baseUrl: 'http://192.0.2.1:8888', apiKey: REAL } }, hdr);
    ok(sbSet.status === 200 && sbSet.json && sbSet.json.ok === true, '⑤ POST searchBackend 被接受');
    st = await getJson(WB_PORT, '/api/status');
    const sb1 = (st.json && st.json.config && st.json.config.searchBackend) || {};
    ok(sb1.type === 'searxng' && sb1.baseUrl === 'http://192.0.2.1:8888', '⑤ searchBackend type/baseUrl 存续');
    ok(typeof sb1.apiKey === 'string' && sb1.apiKey !== REAL && sb1.apiKey.length > 0, '⑤ GET apiKey 是掩码（非明文，got ' + sb1.apiKey + '）');
    ok(sb1.hasKey === true, '⑤ GET searchBackend.hasKey === true');
    // 掩码原样回存（用户没改密钥框）。
    const sbEcho = await postJson(WB_PORT, '/api/config', { searchBackend: { type: 'searxng', baseUrl: 'http://192.0.2.1:8888', apiKey: sb1.apiKey } }, hdr);
    ok(sbEcho.status === 200 && sbEcho.json && sbEcho.json.ok === true, '⑤ 掩码回存 POST 被接受');
    // 读磁盘 config.json：apiKey 仍是真值（掩码回存不覆盖真 key）。
    const disk = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(disk.searchBackend && disk.searchBackend.apiKey === REAL, '⑤ 磁盘 config.json apiKey 仍为真值（掩码回存不覆盖，got ' + (disk.searchBackend && disk.searchBackend.apiKey) + '）');

    // ⑥ provider vision 存续。
    const pvSet = await postJson(WB_PORT, '/api/config', { providers: [{ id: 't1', label: 'T1', type: 'openai-compat', baseUrl: 'http://192.0.2.1:9', apiKey: 'k', model: 'm', vision: true }] }, hdr);
    ok(pvSet.status === 200 && pvSet.json && pvSet.json.ok === true, '⑥ POST providers[vision:true] 被接受');
    st = await getJson(WB_PORT, '/api/status');
    const prov = (st.json && st.json.config && st.json.config.providers) || [];
    const t1 = prov.find(p => p.id === 't1');
    ok(t1 && t1.vision === true, '⑥ provider t1 vision === true 存续（got ' + (t1 && t1.vision) + '）');
  } finally {
    killp(wb);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  // ════════════ ⑦ v1.0.2-S6: CLI 缺失时的错误归因（code:'cli-missing' + 中文人话含「API」）════════════
  // engine=claude（activeProvider 空）+ claudePath 指向不存在的可执行 → 发消息应收到:
  //   · result 事件带 code:'cli-missing'（只增字段）；
  //   · assistant 文本含「API」（引导用户直接配 API 引擎）；
  //   · 不冒出与 CLAUDE.md 相关的错误/警告。
  {
    const HOME2 = path.join(os.tmpdir(), 'wcw-onboard-s6-e2e');
    const WS2 = path.join(HOME2, 'ws');
    fs.rmSync(HOME2, { recursive: true, force: true });
    fs.mkdirSync(WS2, { recursive: true });
    fs.writeFileSync(path.join(HOME2, 'config.json'), JSON.stringify({
      configSchema: 7, version: '1.0.0', permissionMode: 'bypass',
      claudePath: path.join(HOME2, 'no-such-claude.exe'), // 不存在 → existsExecutable 假 → fallback 触发
      activeProvider: '', defaultWorkspace: WS2,
    }, null, 2));
    const env2 = { ...process.env }; delete env2.RUYI_HOME; env2.WIN_CLAUDE_WORKBENCH_HOME = HOME2;
    delete env2.WCW_FAKE_CLAUDE; // 确保不走假 CLI seam
    const PORT2 = 8998;
    const wb2 = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT2)], { cwd: WB, env: env2, windowsHide: true });
    wb2.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb2!] ' + l.trim())));
    const postStream = (port, payload) => new Promise((resolve, reject) => {
      const data = JSON.stringify(payload);
      const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
        let buf = ''; const events = [];
        res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
        res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
      });
      req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
    });
    try {
      let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(PORT2); }
      ok(!!h, '⑦ workbench up (CLI-missing 场景)');
      const created = await postJson(PORT2, '/api/sessions', { title: 's6', cwd: WS2 }, {});
      const sid = created.json && created.json.session && created.json.session.id;
      ok(!!sid, '⑦ session created');
      const events = await postStream(PORT2, { sessionId: sid, message: '你好', cwd: WS2 });
      const result = events.find(e => e.type === 'result');
      ok(result && result.code === 'cli-missing', '⑦ result 事件带 code:cli-missing（got ' + (result && result.code) + '）');
      const text = events.filter(e => e.type === 'assistant_delta').map(e => e.text).join('');
      ok(/API/.test(text), '⑦ 错误文本含「API」（引导配 API 引擎）');
      ok(/未检测到 Claude CLI/.test(text), '⑦ 错误文本为中文人话');
      // 不冒 CLAUDE.md 相关错误/警告(任何事件文本不得含 CLAUDE.md / claude.md 的报错)。
      const anyCmdErr = events.some(e => /claude\.md/i.test(JSON.stringify(e)) && (e.type === 'error' || e.type === 'warning'));
      ok(!anyCmdErr, '⑦ 无 CLAUDE.md 相关错误/警告事件');
    } catch (e) { console.log('ERROR ⑦ ' + (e && e.message || e)); fail++; }
    finally {
      killp(wb2);
      await sleep(300);
      fs.rmSync(HOME2, { recursive: true, force: true });
    }
  }

  console.log('\nONBOARD E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
