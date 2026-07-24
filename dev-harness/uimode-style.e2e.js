(async () => {
// E2E for v0.9-S1 (C1/C6): uiMode / outputStyle config round-trip + outputStyle prompt injection +
// /api/status.errorClasses table. Backend-testable slices only; the UI assertions (simple-mode hides,
// humanized tool cards, error human-card) are verified via the preview self-check and listed in the
// delivery notes (no headless DOM here).
//
// Ports 8995 (fake-openai) + 8996 (workbench). Uses FAKE_CAPTURE_DIR to read the injected `system` message.
//
// Scenarios:
//   A) config round-trip — POST /api/config with ILLEGAL uiMode/outputStyle → normalizeConfig cleanses to
//      the enum defaults ('pro' / 'detailed'); POST with LEGAL values → persisted + surfaced in /api/status.
//   B) outputStyle prompt injection — with outputStyle:'concise', run a turn; the captured request's system
//      message MUST contain the short-answer instruction. With 'detailed', it MUST NOT.
//   C) /api/status carries the errorClasses table top-level (the error-humanization UI's source of truth),
//      with the expected keys + {zh,next} shape.
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();

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
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function readCaptures(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /^req-\d+\.json$/.test(f)).sort()
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}
// Clear the capture FILES but KEEP the directory — the fake only mkdir's CAPTURE_DIR once at startup, so
// removing the dir would make its subsequent writeFileSync silently fail (it doesn't re-create the dir).
function clearCaptures(dir) {
  if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { recursive: true }); return; }
  for (const f of fs.readdirSync(dir)) { if (/^req-\d+\.json$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ } } }
}
function systemOf(reqBody) {
  const msgs = (reqBody && Array.isArray(reqBody.messages)) ? reqBody.messages : [];
  const sys = msgs.find(m => m && m.role === 'system');
  const user = msgs.find(m => m && m.role === 'user');
  let userText = '';
  if (user && typeof user.content === 'string') userText = user.content;
  else if (user && Array.isArray(user.content)) userText = user.content.map(part => (part && part.type === 'text') ? String(part.text || '') : '').join('\n');
  return ((sys && typeof sys.content === 'string') ? sys.content : '') + '\n' + userText;
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
function seedConfig(home, extra) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake Model' }] }],
    activeProvider: 'fake',
    ...(extra || {}),
  }, null, 2));
}

const SHORT_INSTR = '回答尽量简短，直接给结果，不解释过程除非被问。';

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ══════════ v1.5 静态断言（分级 UI 一致性 + 青花视觉系统）：读源文件，不起服务 ══════════
  // 覆盖第 2.5 波后端一致的四件前端事：设置弹窗按 uiMode 收敛、首次连接失败故障卡、data-density 分级、
  // 青花设计 token 补全 + 如意云纹极淡水印。纯字符串/正则断言（与本仓其它 e2e 同款静态护栏风格）。
  {
    const PUB = path.resolve(__dirname, '..', 'ruyi-workbench', 'app', 'public');
    const css = fs.readFileSync(path.join(PUB, 'styles.css'), 'utf8');
    const html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
    const appjs = fs.readFileSync(path.join(PUB, 'app.js'), 'utf8');
    const zh = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'i18n', 'locales', 'zh-CN.json'), 'utf8'));

    // ── (S1) 设置弹窗按 uiMode 收敛（§1.2）──────────────────────────────────────────────────────
    for (const stab of ['claude', 'agents', 'integrations', 'advanced']) {
      ok(new RegExp(`\\[data-ui-mode="simple"\\][^{]*#settingsTabs button\\[data-stab="${stab}"\\]`).test(css),
        `(S1) 简易模式隐藏设置页签 ${stab}（CSS）`);
    }
    // 白名单页签（基础/服务商/联网搜索）不得被简易模式规则藏掉。
    for (const stab of ['basic', 'providers', 'network']) {
      ok(!new RegExp(`\\[data-ui-mode="simple"\\][^{]*#settingsTabs button\\[data-stab="${stab}"\\][^{]*\\{[^}]*display:\\s*none`).test(css),
        `(S1) 简易模式保留设置页签 ${stab}`);
    }
    ok(/SETTINGS_SIMPLE_TABS\s*=\s*new Set\(\[[^\]]*'basic'[^\]]*'providers'[^\]]*'network'/.test(appjs),
      '(S1) app.js 定义 SETTINGS_SIMPLE_TABS 白名单（basic/providers/network）');
    ok(/function switchSettingsTab\(name,\s*force\)/.test(appjs) && /!SETTINGS_SIMPLE_TABS\.has\(name\)/.test(appjs),
      '(S1) switchSettingsTab 按 uiMode 收敛（非白名单落回 basic，force 逃生门可绕过）');
    ok(/settingsModal'\)[\s\S]{0,320}SETTINGS_SIMPLE_TABS\.has\([\s\S]{0,60}switchSettingsTab\('basic'\)/.test(appjs),
      '(S1) applyUiMode 切到简易时若设置停在隐藏页签则落回 basic（实时生效）');

    // ── (S2) 首次连接失败故障卡（§1.3）─────────────────────────────────────────────────────────
    ok(/function buildBootFailureCard\(/.test(appjs) && /function renderBootFailure\(/.test(appjs),
      '(S2) app.js 定义 buildBootFailureCard / renderBootFailure');
    ok(/t\('bootFailure\.title'\)/.test(appjs) && zh['bootFailure.title'] === '无法连接本地服务',
      '(S2) 故障卡大标题「无法连接本地服务」(代码与中文 locale 双向锁)');
    for (const [key, label] of [
      ['connection.reason.portOccupied', '端口被占用'],
      ['connection.reason.serverNotStarted', '服务未启动'],
      ['connection.reason.securityBlock', '被安全软件拦截'],
    ]) ok(appjs.includes(`t('${key}')`) && zh[key] === label, `(S2) 故障卡列可能原因「${label}」(i18n)`);
    ok(/t\('bootFailure\.retry'\)/.test(appjs) && zh['bootFailure.retry'] === '重试连接' && /await bootData\(\)/.test(appjs),
      '(S2) 「重试连接」按钮重跑 bootData（不重复 bindEvents）');
    ok(/t\('bootFailure\.diagButton'\)/.test(appjs) && /诊断/.test(zh['bootFailure.diagButton']),
      '(S2) 诊断入口存在并走 i18n');
    ok(/boot\(\)\.catch\(err\s*=>\s*renderBootFailure\(err\)\)/.test(appjs), '(S2) boot 失败 wire 到 renderBootFailure（不再只塞英文进状态行）');
    ok(/role',\s*'alert'\)/.test(appjs) && /setAttribute\('aria-expanded'/.test(appjs), '(S2) 故障卡可访问（role=alert + aria-expanded 诊断按钮）');
    ok(/\.boot-failure\b/.test(css) && /\.boot-failure-reasons\b/.test(css), '(S2) styles.css 有故障卡样式（令牌驱动）');

    // ── (S3) data-density 分级（§3.4）──────────────────────────────────────────────────────────
    ok(/setAttribute\('data-density'/.test(appjs), '(S3) applyUiMode 写 data-density（跟随 uiMode）');
    ok(/setAttribute\('data-density'/.test(html), '(S3) index.html 预绘 data-density（避免首屏闪烁）');
    ok(/\[data-density="comfortable"\]/.test(css) && /\[data-density="compact"\]/.test(css),
      '(S3) styles.css 有 comfortable / compact 两档密度块');
    ok(/--density-scale/.test(css) && /--tap-min/.test(css), '(S3) 密度驱动 --density-scale / --tap-min token');

    // ── (S4) 青花设计 token 补全 + 如意云纹水印（§3.1 / §3.3）────────────────────────────────────
    for (const t of ['--sp-8', '--r-sm', '--r-md', '--r-pill', '--ease-out', '--dur-fast', '--dur-base', '--dur-slow', '--info']) { // 50a:--sp-7 零引用清障删除
      ok(new RegExp(`${t}\\s*:`).test(css), `(S4) 设计 token ${t} 已定义`);
    }
    for (const t of ['--ok-bg', '--ok-fg', '--warn-bg', '--warn-fg', '--danger-bg', '--danger-fg', '--info-bg', '--info-fg']) {
      ok(new RegExp(`${t}\\s*:`).test(css), `(S4) 语义色变体 ${t} 已定义`);
    }
    ok(/--ok\s*:/.test(css) && /--warn\s*:/.test(css) && /--danger\s*:/.test(css), '(S4) --ok/--warn/--danger 齐全');
    ok(!/--success\s*:/.test(css) && !/--warning\s*:/.test(css), '(S4) 未回退到 --success/--warning');
    ok(/--ruyi-cloud\s*:\s*url\("data:image\/svg\+xml/.test(css), '(S4) --ruyi-cloud 内联 SVG data-URI token（离线，不引外部资源）');
    ok(/\.empty-state::before[\s\S]{0,500}var\(--ruyi-cloud\)/.test(css), '(S4) 空状态/故障卡 ::before 用 --ruyi-cloud 作云纹水印');
    ok(/mask:\s*var\(--ruyi-cloud\)/.test(css) && /background:\s*var\(--brand-qh\)/.test(css), '(S4) 云纹走 mask + --brand-qh 上色（随主题，不硬编码）');
    // 第26波b 修存量过期断言: 品牌云纹 opacity 在 UI v3(§C3)已刻意从 .04 提到 .07(「仍克制但可见」),
    // 旧断言 ≤0.05 随之过期。放宽到 ≤0.09(仍是极淡水印,守住"克制"意图)。
    ok(/opacity:\s*\.0[0-9]\b/.test(css.match(/::before\s*\{[^}]*var\(--ruyi-cloud\)[^}]*\}/)?.[0] || css), '(S4) 云纹水印 opacity ≤ 0.09(克制)');
  }

  const HOME = path.join(os.tmpdir(), 'wcw-uimode-style-e2e');
  const CAP_DIR = path.join(HOME, 'captures');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  seedConfig(HOME); // starts detailed / pro (defaults expand from schema-6 seed)

  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js'), String(FAKE_PORT)], { windowsHide: true, env: { ...process.env, FAKE_CAPTURE_DIR: CAP_DIR } });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench listening');
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // ── A) config round-trip ─────────────────────────────────────────────────────────────────────────
    // Illegal values → cleansed back to enum defaults.
    const badSave = await postJson(WB_PORT, '/api/config', { uiMode: 'ultra', outputStyle: 'poetic' }, hdr);
    ok(badSave.status === 200 && badSave.json && badSave.json.ok === true, '(A) POST illegal uiMode/outputStyle accepted (cleansed)');
    let st = await getJson(WB_PORT, '/api/status');
    ok(st.json && st.json.config && st.json.config.uiMode === 'simple', '(A) illegal uiMode cleansed → simple (第36波:回退与 defaultConfig 对齐,不再 pro;got ' + (st.json && st.json.config && st.json.config.uiMode) + ')');
    ok(st.json && st.json.config && st.json.config.outputStyle === 'detailed', '(A) illegal outputStyle cleansed → detailed (got ' + (st.json && st.json.config && st.json.config.outputStyle) + ')');

    // Legal values → persisted + surfaced.
    const goodSave = await postJson(WB_PORT, '/api/config', { uiMode: 'simple', outputStyle: 'concise' }, hdr);
    ok(goodSave.status === 200 && goodSave.json && goodSave.json.ok === true, '(A) POST legal uiMode:simple/outputStyle:concise ok');
    st = await getJson(WB_PORT, '/api/status');
    ok(st.json && st.json.config && st.json.config.uiMode === 'simple', '(A) uiMode:simple persisted');
    ok(st.json && st.json.config && st.json.config.outputStyle === 'concise', '(A) outputStyle:concise persisted');
    // And on disk (config.json).
    const disk = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok(disk.uiMode === 'simple' && disk.outputStyle === 'concise', '(A) both persisted to disk config.json');

    // ── B) outputStyle prompt injection ──────────────────────────────────────────────────────────────
    // concise is active now → the captured stable-system + volatile-user prompt contains the instruction.
    clearCaptures(CAP_DIR);
    await postStream(WB_PORT, { message: 'hello concise' });
    await sleep(300); // let the fake flush its req-NNN.json capture to disk
    let caps = readCaptures(CAP_DIR);
    ok(caps.length >= 1, '(B) concise: request captured (' + caps.length + ')');
    const sysConcise = caps.map(systemOf).join('\n');
    ok(sysConcise.includes(SHORT_INSTR), '(B) concise: request prompt contains short-answer instruction');

    // Switch to detailed → the instruction is absent.
    await postJson(WB_PORT, '/api/config', { outputStyle: 'detailed' }, hdr);
    clearCaptures(CAP_DIR);
    await postStream(WB_PORT, { message: 'hello detailed' });
    await sleep(300); // let the fake flush its capture
    caps = readCaptures(CAP_DIR);
    ok(caps.length >= 1, '(B) detailed: request captured (' + caps.length + ')');
    const sysDetailed = caps.map(systemOf).join('\n');
    ok(!sysDetailed.includes(SHORT_INSTR), '(B) detailed: request prompt does NOT contain short-answer instruction');
    // Sanity: the identity pin is present either way (proves we captured a real layered prompt, not empty).
    ok(/由 .* 的 .* 模型驱动/.test(sysDetailed), '(B) detailed: identity-pinned system prompt captured (sanity)');

    // ── C) /api/status.errorClasses ──────────────────────────────────────────────────────────────────
    st = await getJson(WB_PORT, '/api/status');
    const ec = st.json && st.json.errorClasses;
    ok(ec && typeof ec === 'object', '(C) /api/status carries errorClasses table top-level');
    const expectKeys = ['provider_misconfigured', 'network_down', 'permission_denied', 'tool_error', 'idle_timeout', 'tool_loop'];
    ok(ec && expectKeys.every(k => ec[k] && typeof ec[k].zh === 'string' && typeof ec[k].next === 'string'), '(C) errorClasses has all expected keys with {zh,next}');
    ok(ec && ec.provider_misconfigured && /设置/.test(ec.provider_misconfigured.next), '(C) provider_misconfigured.next points at 设置 (Providers)');
  } finally {
    killp(wb); killp(fake);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }

  console.log('\nUIMODE-STYLE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
