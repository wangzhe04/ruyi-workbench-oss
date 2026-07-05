// E2E (v0.8-S8 收官片): 开源合规 + 如意 Ruyi 品牌落地的回归钉。Ports 8990-8992.
//
// 断言:
//  a) 根 LICENSE 与 THIRD-PARTY-NOTICES.md 存在且非空;LICENSE 含 "Apache License"。
//  b) 全仓扫描:无真密钥模式命中(白名单:dev-harness 自身 + docs 的示例/占位如 <API_KEY>);
//     活文档(DEV-README / 两 README / ARCHITECTURE_CN / 路线总纲)无该真实用户名(见 USERNAME 常量)。
//  c) RUYI_HOME 生效:RUYI_HOME=临时目录 → /api/status.dataRoot === 该目录;
//     只带旧 WIN_CLAUDE_WORKBENCH_HOME → 旧 env 生效(兼容);两者都带 → RUYI_HOME 优先。
//  d) /api/status.app === '如意 Ruyi';index.html 含 favicon <link rel="icon"> 与「如意」。
//  e) F2 apiKey 掩码(安全):种一个带真实 apiKey 的 provider →
//     ① GET /api/status 响应里 apiKey 为 ••••<后4位> 且 hasKey:true、全响应不含明文 key;
//     ② 把 status 拿到的(掩码)providers 原样 POST /api/config → 磁盘 config.json 真 key 完好;
//     ③ POST /api/config 换新明文 key → 磁盘更新为新值。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');                       // repo root
const WB = path.resolve(ROOT, 'ruyi-workbench');
const PORT_A = 8990, PORT_B = 8991, PORT_C = 8992; // PORT_C: F2 apiKey-mask section (dedicated instance)

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

// Spawn the workbench with a specific env override map (env vars NOT listed are cleared re: the two HOME
// vars so precedence is deterministic — we start from the parent env, then delete both, then apply overrides).
async function statusWith(port, envOverrides) {
  const env = { ...process.env };
  delete env.RUYI_HOME; delete env.WIN_CLAUDE_WORKBENCH_HOME;
  Object.assign(env, envOverrides);
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(port); }
    if (!h) return { up: false, status: null };
    const st = await getJson(port, '/api/status');
    return { up: true, status: st.json };
  } finally { killp(wb); await sleep(300); }
}

// --- Recursive file walk (skips heavy/irrelevant dirs) ---
function walk(dir, acc, skip) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (skip.has(e.name)) continue;
      walk(full, acc, skip);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

  // ============ (a) LICENSE + THIRD-PARTY-NOTICES exist & non-empty ============
  const licPath = path.join(ROOT, 'LICENSE');
  const tpnPath = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
  const licExists = fs.existsSync(licPath);
  const tpnExists = fs.existsSync(tpnPath);
  ok(licExists, '(a) root LICENSE exists');
  ok(tpnExists, '(a) root THIRD-PARTY-NOTICES.md exists');
  let licText = '';
  if (licExists) { licText = fs.readFileSync(licPath, 'utf8'); ok(licText.trim().length > 100, '(a) LICENSE non-empty'); ok(/Apache License/.test(licText), '(a) LICENSE contains "Apache License"'); }
  if (tpnExists) { const t = fs.readFileSync(tpnPath, 'utf8'); ok(t.trim().length > 50, '(a) THIRD-PARTY-NOTICES non-empty'); }

  // ============ (b) full-repo scan: no real secrets; active docs no real personal username ============
  const skip = new Set(['.git', 'node_modules', '.venv', 'dist', 'build', '__pycache__', '.pytest_cache']);
  const files = walk(ROOT, [], skip);
  // Only scan textual sources; skip this very file (it carries the regexes) and binary-ish vendor libs.
  const SELF = path.resolve(__filename);
  const textExt = /\.(js|py|md|json|ps1|cmd|html|css|txt|yml|yaml|toml|cfg)$/i;
  const SECRET_RE = /sk-[a-zA-Z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,}|AUTH_TOKEN\s*=\s*[A-Za-z0-9._-]{16,}/;
  // Placeholders that are legitimate examples (NOT real secrets).
  const PLACEHOLDER_RE = /<API_KEY>|<TOKEN>|your[_-]?api[_-]?key|xxxx|\.\.\./i;
  const secretHits = [];
  for (const f of files) {
    if (f === SELF) continue;
    if (!textExt.test(f)) continue;
    let txt = '';
    try { txt = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const lines = txt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (SECRET_RE.test(ln) && !PLACEHOLDER_RE.test(ln)) {
        secretHits.push(path.relative(ROOT, f) + ':' + (i + 1));
      }
    }
  }
  ok(secretHits.length === 0, '(b) no real secret-pattern hits' + (secretHits.length ? ' — HITS: ' + secretHits.join(', ') : ''));

  // Active docs must not carry the real personal username. Built from parts so the literal token isn't
  // itself a fresh leak; this is the ONE deliberate test fixture reference.
  const USERNAME = '87' + '179';
  const activeDocs = [
    path.join(ROOT, 'DEV-README.md'),
    path.join(ROOT, 'README.md'),
    path.join(WB, 'README.md'),
    path.join(WB, 'docs', 'ARCHITECTURE_CN.md'),
    path.join(ROOT, 'docs', 'WCW-v0.8-v1.0-Roadmap-Design-Spec.md'),
  ];
  const userHits = [];
  for (const d of activeDocs) {
    if (!fs.existsSync(d)) continue;
    const t = fs.readFileSync(d, 'utf8');
    if (t.includes(USERNAME)) userHits.push(path.relative(ROOT, d));
  }
  ok(userHits.length === 0, '(b) active docs have no real personal username' + (userHits.length ? ' — HITS: ' + userHits.join(', ') : ''));

  // ============ (c) RUYI_HOME precedence ============
  const ruyiHome = path.join(os.tmpdir(), 'wcw-hygiene-ruyi');
  const oldHome = path.join(os.tmpdir(), 'wcw-hygiene-old');
  fs.rmSync(ruyiHome, { recursive: true, force: true });
  fs.rmSync(oldHome, { recursive: true, force: true });

  // (c1) RUYI_HOME only → dataRoot === ruyiHome
  const r1 = await statusWith(PORT_A, { RUYI_HOME: ruyiHome });
  ok(r1.up, '(c1) workbench up with RUYI_HOME');
  ok(r1.status && path.resolve(r1.status.dataRoot) === path.resolve(ruyiHome), '(c1) RUYI_HOME → dataRoot === ruyiHome (got ' + (r1.status && r1.status.dataRoot) + ')');
  ok(r1.status && r1.status.app === '如意 Ruyi', '(d) /api/status.app === 如意 Ruyi (got ' + (r1.status && r1.status.app) + ')');

  // (c2) old env only → old wins (compat)
  const r2 = await statusWith(PORT_A, { WIN_CLAUDE_WORKBENCH_HOME: oldHome });
  ok(r2.up, '(c2) workbench up with old env only');
  ok(r2.status && path.resolve(r2.status.dataRoot) === path.resolve(oldHome), '(c2) old WIN_CLAUDE_WORKBENCH_HOME still honored (got ' + (r2.status && r2.status.dataRoot) + ')');

  // (c3) both → RUYI_HOME wins
  const r3 = await statusWith(PORT_B, { RUYI_HOME: ruyiHome, WIN_CLAUDE_WORKBENCH_HOME: oldHome });
  ok(r3.up, '(c3) workbench up with both envs');
  ok(r3.status && path.resolve(r3.status.dataRoot) === path.resolve(ruyiHome), '(c3) RUYI_HOME takes precedence over old env (got ' + (r3.status && r3.status.dataRoot) + ')');

  // ============ (d) index.html favicon + 如意 branding ============
  const indexPath = path.join(WB, 'app', 'public', 'index.html');
  const idx = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : '';
  ok(/<link[^>]*rel=["']icon["']/i.test(idx), '(d) index.html has favicon <link rel="icon">');
  ok(idx.includes('如意'), '(d) index.html contains 如意');
  ok(/<title>[^<]*如意/.test(idx), '(d) index.html <title> carries 如意');

  // cleanup temp homes
  fs.rmSync(ruyiHome, { recursive: true, force: true });
  fs.rmSync(oldHome, { recursive: true, force: true });

  // ============ (e) F2: provider apiKey is masked in API responses; disk key never leaks/wipes ============
  {
    const F2_HOME = path.join(os.tmpdir(), 'wcw-hygiene-f2');
    fs.rmSync(F2_HOME, { recursive: true, force: true });
    fs.mkdirSync(F2_HOME, { recursive: true });
    const cfgPath = path.join(F2_HOME, 'config.json');
    const REAL_KEY = 'sk-test-1234abcd';
    fs.writeFileSync(cfgPath, JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1', apiKey: REAL_KEY, model: 'm', models: [{ id: 'm', label: 'M' }] }],
      activeProvider: 'fake',
    }, null, 2));
    const f2env = { ...process.env }; delete f2env.RUYI_HOME; f2env.WIN_CLAUDE_WORKBENCH_HOME = F2_HOME;
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT_C)], { cwd: WB, env: f2env, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    try {
      let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(PORT_C); }
      ok(!!h, '(e) F2 workbench up on :' + PORT_C);
      const token = await getToken(PORT_C);
      ok(!!token, '(e) F2 UI token scraped');

      // ① GET /api/status → apiKey masked to ••••abcd + hasKey:true; whole response has NO plaintext key.
      const st = await getJson(PORT_C, '/api/status');
      const prov = st.json && st.json.config && Array.isArray(st.json.config.providers) ? st.json.config.providers.find(p => p.id === 'fake') : null;
      ok(prov && prov.apiKey === '••••abcd', '(e①) GET /api/status apiKey masked to ••••abcd (got ' + (prov && prov.apiKey) + ')');
      ok(prov && prov.hasKey === true, '(e①) masked provider carries hasKey:true');
      ok(st.raw && !st.raw.includes(REAL_KEY), '(e①) full /api/status response contains NO plaintext key');

      // ② POST /api/config echoing the MASKED providers back → disk config.json keeps the REAL key.
      const echoed = st.json.config.providers; // masked providers straight from status
      const save1 = await postJson(PORT_C, '/api/config', { providers: echoed }, { 'x-wcw-token': token });
      ok(save1.status === 200 && save1.json && save1.json.ok === true, '(e②) POST /api/config (masked echo) ok');
      const disk1 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const dp1 = disk1.providers.find(p => p.id === 'fake');
      ok(dp1 && dp1.apiKey === REAL_KEY, '(e②) disk config.json real key intact after masked round-trip (got ' + (dp1 && dp1.apiKey) + ')');
      // the save response is itself masked (never re-emits the real key).
      ok(save1.raw && !save1.raw.includes(REAL_KEY), '(e②) POST /api/config response contains NO plaintext key');

      // ③ POST /api/config with a NEW plaintext key → disk updated to the new value.
      const NEW_KEY = 'sk-live-9999zzzz';
      const save2 = await postJson(PORT_C, '/api/config', { providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:1', apiKey: NEW_KEY, model: 'm', models: [{ id: 'm', label: 'M' }] }] }, { 'x-wcw-token': token });
      ok(save2.status === 200 && save2.json && save2.json.ok === true, '(e③) POST /api/config (new plaintext key) ok');
      const disk2 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const dp2 = disk2.providers.find(p => p.id === 'fake');
      ok(dp2 && dp2.apiKey === NEW_KEY, '(e③) disk config.json updated to the new key (got ' + (dp2 && dp2.apiKey) + ')');
    } catch (e) { console.log('ERROR(e) ' + (e && e.stack || e)); fail++; }
    finally { killp(wb); await sleep(300); fs.rmSync(F2_HOME, { recursive: true, force: true }); }
  }

  // Verdict line follows the harness convention (dev-harness/README.md): "<NAME> E2E: ALL PASS" —
  // the regression runner greps for "E2E:" to collect verdicts.
  console.log('\nREPO-HYGIENE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
