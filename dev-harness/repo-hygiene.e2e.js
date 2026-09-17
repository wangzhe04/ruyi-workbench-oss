require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
(async () => {
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
//  f) 107-S0b 外部 MCP 连接器密钥(stdio 的 env、远程的 headers、args 里的 `--token xyz`／URL userinfo):
//     ① GET /api/status 与其它回显面(POST /api/config 回包、/api/mcp/connectors、workbench_self_status、mcp_list)全文零明文,
//        env／headers 键名可见、值是 ••••<后4位>,args 显示脱敏;
//     ② 掩码原样回传 → 磁盘逐字节不变;改一个 env 为新明文 → 照存;删一个键 → 删掉;新 id／改名／改了启动向量 → 清空不落掩码;
//     ③ 磁盘、.mcp.json、Kimi 的 mcp.json、`claude mcp add-json` 的实参、MCP 子进程 env、远程请求头拿到的都是真值。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');

const { getFreePort } = require('./free-port.js');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..');                       // repo root
const WB = path.resolve(ROOT, 'ruyi-workbench');
const PORT_A = await getFreePort(), PORT_B = await getFreePort(), PORT_C = await getFreePort(); // PORT_C: F2 apiKey-mask section (dedicated instance)

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function postJson(port, p, payload, headers, timeoutMs) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: timeoutMs || 4000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 5000 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); } // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// Spawn the workbench with a specific env override map (env vars NOT listed are cleared re: the two HOME
// vars so precedence is deterministic — we start from the parent env, then delete both, then apply overrides).
async function statusWith(port, envOverrides) {
  const env = { ...process.env };
  delete env.RUYI_HOME; delete env.WIN_CLAUDE_WORKBENCH_HOME;
  Object.assign(env, envOverrides);
  // This test owns only the Ruyi data-root precedence contract. Isolate Claude Code discovery too, otherwise
  // real ~/.claude.json MCP entries can be imported on the first boot and make a later restart exceed 6s.
  const isolatedUserHome = envOverrides.RUYI_HOME || envOverrides.WIN_CLAUDE_WORKBENCH_HOME;
  if (isolatedUserHome) { env.HOME = isolatedUserHome; env.USERPROFILE = isolatedUserHome; }
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
  ok(/<title(?:\s[^>]*)?>[^<]*如意/.test(idx), '(d) index.html <title> carries 如意');

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
    // 107-S0(46 号文 §1.5 ②):Claude CLI 引擎的认证覆盖值,修前 maskSecrets 不盖它、GET /api/status 明文下发。
    // 失败信息只打前 6 个字符(本件的假 key 也按真 key 的口径对待)。
    const REAL_MODELS_KEY = 'mk-test-5566wxyz';
    const keyHead = v => (typeof v === 'string' ? JSON.stringify(v.slice(0, 6) + (v.length > 6 ? '…' : '')) : String(v));
    fs.writeFileSync(cfgPath, JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass', autoImportClaudeCodeMcp: false,
      modelsApiBase: 'http://127.0.0.1:1', modelsApiKey: REAL_MODELS_KEY,
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

      // ④ 107-S0:modelsApiKey 在 GET /api/status 里是掩码,整个响应体里找不到明文。
      const st2 = await getJson(PORT_C, '/api/status');
      const maskedModelsKey = st2.json && st2.json.config ? st2.json.config.modelsApiKey : undefined;
      ok(maskedModelsKey === '••••wxyz', '(e④) GET /api/status config.modelsApiKey masked to ••••wxyz (got ' + keyHead(maskedModelsKey) + ')');
      ok(st2.raw && !st2.raw.includes(REAL_MODELS_KEY), '(e④) full /api/status response contains NO plaintext modelsApiKey' + (st2.raw && st2.raw.includes(REAL_MODELS_KEY) ? ' (leaked ' + keyHead(REAL_MODELS_KEY) + ')' : ''));

      // ⑤ 设置页的保存形状:把掩码原样回传(连同掩码过的 providers)→ 磁盘上的真值逐字节不变,回包也不带明文。
      const save3 = await postJson(PORT_C, '/api/config', { modelsApiBase: 'http://127.0.0.1:1', modelsApiKey: maskedModelsKey, providers: st2.json.config.providers }, { 'x-wcw-token': token });
      ok(save3.status === 200 && save3.json && save3.json.ok === true, '(e⑤) POST /api/config (masked modelsApiKey echo) ok');
      const disk3 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      ok(disk3.modelsApiKey === REAL_MODELS_KEY, '(e⑤) disk modelsApiKey byte-identical after masked round-trip (got ' + keyHead(disk3.modelsApiKey) + ')');
      ok((disk3.providers.find(p => p.id === 'fake') || {}).apiKey === NEW_KEY, '(e⑤) provider key intact in the same save');
      ok(save3.raw && !save3.raw.includes(REAL_MODELS_KEY), '(e⑤) POST /api/config response contains NO plaintext modelsApiKey');

      // ⑥ 真新填的明文照存;清成空串照清(掩码还原只认掩码前缀)。
      const NEW_MODELS_KEY = 'mk-live-7788abcd';
      const save4 = await postJson(PORT_C, '/api/config', { modelsApiKey: NEW_MODELS_KEY }, { 'x-wcw-token': token });
      const disk4 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      ok(save4.status === 200 && disk4.modelsApiKey === NEW_MODELS_KEY, '(e⑥) POST a new plaintext modelsApiKey → disk updated (got ' + keyHead(disk4.modelsApiKey) + ')');
      ok(save4.raw && !save4.raw.includes(NEW_MODELS_KEY) && save4.json && save4.json.config && save4.json.config.modelsApiKey === '••••abcd',
        '(e⑥) the save response echoes the NEW key masked, not plaintext (got ' + keyHead(save4.json && save4.json.config && save4.json.config.modelsApiKey) + ')');
      const save5 = await postJson(PORT_C, '/api/config', { modelsApiKey: '' }, { 'x-wcw-token': token });
      const disk5 = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      ok(save5.status === 200 && disk5.modelsApiKey === '', '(e⑥) POST modelsApiKey:"" clears it (got ' + keyHead(disk5.modelsApiKey) + ')');
    } catch (e) { console.log('ERROR(e) ' + (e && e.stack || e)); fail++; }
    finally { killp(wb); await sleep(300); fs.rmSync(F2_HOME, { recursive: true, force: true }); }
  }

  // ============ (f) 107-S0b:外部 MCP 连接器的 env／headers／args 不明文下发,回传不抹、不落掩码 ============
  {
    const MCP_HOME = path.join(os.tmpdir(), 'wcw-hygiene-mcp-secrets');
    fs.rmSync(MCP_HOME, { recursive: true, force: true });
    fs.mkdirSync(MCP_HOME, { recursive: true });
    const cfgPath = path.join(MCP_HOME, 'config.json');
    const KIMI_HOME = path.join(MCP_HOME, 'kimi-code');
    const KIMI_FILE = path.join(KIMI_HOME, 'mcp.json');
    const CLAUDE_LOG = path.join(MCP_HOME, 'claude-argv.log');
    const ENV_CAPTURE = path.join(MCP_HOME, 'mcp-env-capture.ndjson');
    const GEN_FILE = path.join(MCP_HOME, 'generated', 'workbench.mcp.json');
    const FAKE_MCP = path.join(HERE, 'fake-mcp.js');
    const PORT_F = await getFreePort(), PORT_REMOTE = await getFreePort();
    // 假密钥全部运行时拼出((b) 的全仓扫描不误报);失败信息只打前 6 个字符,与 (e) 同口径。
    const GH = 'ghp_' + 'S0bFake' + 'Token1234567890abcdWXYZ';
    const GH_NEW = 'ghp_' + 'S0bRotated' + '0987654321zyxwQRST';
    const BEARER_VAL = 'fake' + 'Bearer' + 'S0b0123456789ABCDEFxyzw';
    const ARG_TOKEN = 'argTok' + 'S0b' + 'MnOpQrStUv987';
    const DB_PW = 'dbPw' + 'S0b' + '4455';
    const SECRETS = { GH, BEARER_VAL, ARG_TOKEN, DB_PW };
    const MASK = '••••', REDACTED = '«redacted»';
    const keyHead = v => (typeof v === 'string' ? JSON.stringify(v.slice(0, 6) + (v.length > 6 ? '…' : '')) : String(v));
    const leaks = text => Object.entries(SECRETS).filter(([, v]) => String(text || '').includes(v)).map(([k]) => k);
    const readDisk = () => JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const findIn = (list, id) => (Array.isArray(list) ? list : []).find(s => s && s.id === id) || null;
    const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
    const safeParse = t => { try { return JSON.parse(t); } catch { return null; } };

    // 假 claude:把整行实参追加进日志(quoteWinArg 用 "" 转义,JSON 整段在 cmd 眼里始终在引号内,echo %* 原样落盘)。
    const fakeClaude = path.join(MCP_HOME, 'claude.cmd');
    fs.writeFileSync(fakeClaude, '@echo off\r\n>>"' + CLAUDE_LOG + '" echo %*\r\nexit /b 0\r\n', 'utf8');
    // 假远程 MCP(streamable HTTP,只回 JSON):记下每个请求带来的 Authorization。
    const remoteAuth = [];
    const remote = http.createServer((req, res) => {
      let b = ''; req.on('data', c => (b += c));
      req.on('end', () => {
        remoteAuth.push(req.headers['authorization'] || null);
        let msg = null; try { msg = JSON.parse(b || '{}'); } catch { /* ignore */ }
        if (!msg || !msg.method) { res.writeHead(400); return res.end(); }
        if (msg.id == null) { res.writeHead(202); return res.end(); }
        const result = msg.method === 'initialize'
          ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'hyg-remote', version: '1.0' } }
          : msg.method === 'tools/list' ? { tools: [{ name: 'remote_echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] } : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    }).listen(PORT_REMOTE, '127.0.0.1');

    const STDIO = {
      id: 'hyg-stdio', label: 'Hyg stdio', command: process.execPath,
      args: [FAKE_MCP, '--token', ARG_TOKEN, 'postgres://svc:' + DB_PW + '@127.0.0.1/db'],
      cwd: '', enabled: true,
      env: { GITHUB_TOKEN: GH, FAKE_MCP_ENV_CAPTURE: ENV_CAPTURE, FAKE_MCP_ENV_CAPTURE_KEYS: 'GITHUB_TOKEN,DROP_ME', DROP_ME: 'drop-me-value' },
    };
    const REMOTE = { id: 'hyg-remote', label: 'Hyg remote', type: 'http', url: 'http://127.0.0.1:' + PORT_REMOTE + '/mcp', headers: { Authorization: 'Bearer ' + BEARER_VAL }, enabled: true };
    fs.writeFileSync(cfgPath, JSON.stringify({
      configSchema: 11, version: '1.0.0', permissionMode: 'bypass', autoImportClaudeCodeMcp: false, enableMcpDropIn: false,
      desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
      claudePath: fakeClaude, agentCliType: 'kimi', includeWorkbenchMcp: true,
      stewardEnabledV1: false, stewardThreadBriefV1: false,
      externalMcpServers: [STDIO, REMOTE],
    }, null, 2));
    const fenv = { ...process.env }; delete fenv.RUYI_HOME;
    fenv.WIN_CLAUDE_WORKBENCH_HOME = MCP_HOME; fenv.KIMI_CODE_HOME = KIMI_HOME;
    const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT_F)], { cwd: WB, env: fenv, windowsHide: true });
    wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    try {
      let h = null; for (let i = 0; i < 200 && !h; i++) { await sleep(150); h = await health(PORT_F); }
      ok(!!h, '(f) MCP-secrets workbench up on :' + PORT_F);
      const token = await getToken(PORT_F);
      ok(!!token, '(f) UI token scraped');
      const hdr = { 'x-wcw-token': token };
      // 启动期的两路同步是 fire-and-forget:等它们各落一次,再清掉产物,之后看到的就只属于「掩码回传」那一次保存。
      for (let i = 0; i < 100 && !(/add-json hyg-stdio/.test(readText(CLAUDE_LOG)) && fs.existsSync(KIMI_FILE)); i++) await sleep(150);
      await sleep(1000);
      const diskBase = readDisk();   // 启动时 normalize 过的那一份才是「磁盘真值」基线
      const baseStdio = findIn(diskBase.externalMcpServers, 'hyg-stdio');
      const baseRemote = findIn(diskBase.externalMcpServers, 'hyg-remote');
      ok(baseStdio && baseStdio.env.GITHUB_TOKEN === GH && baseRemote && baseRemote.headers.Authorization === 'Bearer ' + BEARER_VAL, '(f) fixture on disk carries the real env/header values');

      // ① GET /api/status:全文零明文;键名可见;值是掩码;args 显示脱敏;结构字段原样。
      const st = await getJson(PORT_F, '/api/status');
      const sStdio = st.json && st.json.config ? findIn(st.json.config.externalMcpServers, 'hyg-stdio') : null;
      const sRemote = st.json && st.json.config ? findIn(st.json.config.externalMcpServers, 'hyg-remote') : null;
      ok(st.status === 200 && leaks(st.raw).length === 0, '(f①) GET /api/status body has 0 plaintext MCP secrets' + (leaks(st.raw).length ? ' (leaked ' + leaks(st.raw).join(',') + ')' : ''));
      ok(sStdio && JSON.stringify(Object.keys(sStdio.env)) === JSON.stringify(['GITHUB_TOKEN', 'FAKE_MCP_ENV_CAPTURE', 'FAKE_MCP_ENV_CAPTURE_KEYS', 'DROP_ME']), '(f①) env key names visible (got ' + (sStdio && JSON.stringify(Object.keys(sStdio.env || {}))) + ')');
      ok(sStdio && sStdio.env.GITHUB_TOKEN === MASK + GH.slice(-4) && Object.values(sStdio.env).every(v => v.startsWith(MASK)), '(f①) every env value masked ••••<last4> (got ' + keyHead(sStdio && sStdio.env.GITHUB_TOKEN) + ')');
      ok(sRemote && sRemote.headers && sRemote.headers.Authorization === MASK + BEARER_VAL.slice(-4), '(f①) remote headers.Authorization masked (got ' + keyHead(sRemote && sRemote.headers && sRemote.headers.Authorization) + ')');
      ok(sStdio && sStdio.args[0] === FAKE_MCP && sStdio.args[1] === '--token' && sStdio.args[2] === REDACTED && sStdio.args[3] === 'postgres://svc:' + REDACTED + '@127.0.0.1/db',
        '(f①) args redacted for display (--token value, URL userinfo) (got ' + (sStdio && JSON.stringify(sStdio.args.slice(1)).slice(0, 80)) + ')');
      ok(sStdio && sStdio.command === process.execPath && sStdio.id === 'hyg-stdio' && sStdio.enabled === true && sRemote && sRemote.url === REMOTE.url,
        '(f①) structural fields (id/command/url/enabled) unmasked');

      // ② 掩码原样回传 → 磁盘逐字节不变,回包零明文。先清掉启动期的同步产物,③ 看到的只属于这一次保存。
      fs.rmSync(CLAUDE_LOG, { force: true }); fs.rmSync(KIMI_FILE, { force: true });
      const echoed = st.json.config.externalMcpServers;
      const save1 = await postJson(PORT_F, '/api/config', { externalMcpServers: echoed }, hdr, 20000);
      ok(save1.status === 200 && save1.json && save1.json.ok === true, '(f②) POST /api/config with masked MCP echo ok (status ' + save1.status + ')');
      const disk1 = readDisk();
      ok(JSON.stringify(disk1.externalMcpServers) === JSON.stringify(diskBase.externalMcpServers),
        '(f②) disk externalMcpServers byte-identical after masked round-trip (GITHUB_TOKEN ' + keyHead(findIn(disk1.externalMcpServers, 'hyg-stdio') && findIn(disk1.externalMcpServers, 'hyg-stdio').env.GITHUB_TOKEN) + ')');
      ok(leaks(save1.raw).length === 0, '(f①) POST /api/config response has 0 plaintext MCP secrets' + (leaks(save1.raw).length ? ' (leaked ' + leaks(save1.raw).join(',') + ')' : ''));

      // ① 其它回显面。
      const conn = await getJson(PORT_F, '/api/mcp/connectors', hdr);
      ok(conn.status === 200 && conn.json && conn.json.ok === true && leaks(conn.raw).length === 0, '(f①) GET /api/mcp/connectors has 0 plaintext MCP secrets' + (leaks(conn.raw).length ? ' (leaked ' + leaks(conn.raw).join(',') + ')' : ''));
      const self = await postJson(PORT_F, '/api/tools/workbench_self_status', {}, hdr, 20000);
      ok(self.status === 200 && self.json && self.json.ok === true && leaks(self.raw).length === 0, '(f①) workbench_self_status has 0 plaintext MCP secrets');
      const list = await postJson(PORT_F, '/api/tools/mcp_list', {}, hdr, 20000);
      const lStdio = list.json && list.json.result ? findIn(list.json.result.servers, 'hyg-stdio') : null;
      ok(list.status === 200 && lStdio && leaks(list.raw).length === 0, '(f①) mcp_list has 0 plaintext MCP secrets (args redacted: ' + (lStdio && lStdio.args[2] === REDACTED) + ')' + (leaks(list.raw).length ? ' (leaked ' + leaks(list.raw).join(',') + ')' : ''));

      // ③ 没有任何掩码到盘上／同步产物／子进程,而且那几处拿到的都是真值。
      const cfgText = readText(cfgPath);
      ok(!cfgText.includes(MASK) && !cfgText.includes(REDACTED), '(f③) config.json contains no mask / redaction marker');
      await getJson(PORT_F, '/api/status');   // 它会重生成 .mcp.json
      const gen = safeParse(readText(GEN_FILE));
      const gStdio = gen && gen.mcpServers && gen.mcpServers['hyg-stdio'];
      const gRemote = gen && gen.mcpServers && gen.mcpServers['hyg-remote'];
      ok(gStdio && gStdio.env.GITHUB_TOKEN === GH && gStdio.args[2] === ARG_TOKEN && gRemote && gRemote.headers.Authorization === 'Bearer ' + BEARER_VAL
        && !readText(GEN_FILE).includes(MASK) && !readText(GEN_FILE).includes(REDACTED), '(f③) generated workbench.mcp.json carries real values, no masks');
      const kimi = safeParse(readText(KIMI_FILE));
      const kStdio = kimi && kimi.mcpServers && kimi.mcpServers['hyg-stdio'];
      const kRemote = kimi && kimi.mcpServers && kimi.mcpServers['hyg-remote'];
      ok(kStdio && kStdio.env.GITHUB_TOKEN === GH && kStdio.args[2] === ARG_TOKEN && kRemote && kRemote.headers.Authorization === 'Bearer ' + BEARER_VAL
        && !readText(KIMI_FILE).includes(MASK) && !readText(KIMI_FILE).includes(REDACTED), '(f③) Kimi sync (mcp.json written by this save) carries real values, no masks (exists=' + fs.existsSync(KIMI_FILE) + ')');
      const addJsonLines = readText(CLAUDE_LOG).split(/\r?\n/).filter(l => /add-json hyg-stdio/.test(l));
      ok(addJsonLines.length >= 1 && addJsonLines.every(l => l.includes(GH) && l.includes(ARG_TOKEN) && l.includes(DB_PW)),
        '(f③) claude mcp add-json from this save got the real env/args (' + addJsonLines.length + ' call(s))');
      // 子进程:能力探测(workbench_self_status 的 counts → getCapabilities → collectBridgedTools)早就把连接器拉起来了,
      // 活客户端复用、不会重新 spawn。先停用再启用(同一条 invalidateMcpRuntime 杀掉活客户端),保证下面这一发是
      // 「掩码回传保存之后」新起的子进程。
      for (const id of ['hyg-stdio', 'hyg-remote']) {
        const off = await postJson(PORT_F, '/api/mcp/connectors/toggle', { id, enabled: false }, hdr, 20000);
        const on = await postJson(PORT_F, '/api/mcp/connectors/toggle', { id, enabled: true }, hdr, 20000);
        ok(off.status === 200 && on.status === 200 && on.json && on.json.ok === true, '(f③) toggle ' + id + ' off→on to drop the live client');
      }
      fs.rmSync(ENV_CAPTURE, { force: true });
      const hStdio = await postJson(PORT_F, '/api/mcp/connectors/health', { id: 'hyg-stdio', timeoutMs: 15000 }, hdr, 25000);
      const capLine = readText(ENV_CAPTURE).split(/\r?\n/).filter(Boolean).map(safeParse).filter(Boolean).pop();
      ok(hStdio.json && hStdio.json.ok === true && capLine && capLine.env && capLine.env.GITHUB_TOKEN === GH && capLine.env.DROP_ME === 'drop-me-value',
        '(f③) MCP child spawned via connectors/health received the real env (GITHUB_TOKEN ' + keyHead(capLine && capLine.env && capLine.env.GITHUB_TOKEN) + ', health ' + (hStdio.json && hStdio.json.health && hStdio.json.health.status) + ')');
      remoteAuth.length = 0;
      const hRemote = await postJson(PORT_F, '/api/mcp/connectors/health', { id: 'hyg-remote', timeoutMs: 15000 }, hdr, 25000);
      ok(hRemote.json && hRemote.json.ok === true && remoteAuth.length > 0 && remoteAuth.every(a => a === 'Bearer ' + BEARER_VAL),
        '(f③) remote MCP requests carried the real Authorization header (' + remoteAuth.length + ' request(s), first ' + keyHead(remoteAuth[0]) + ')');

      // ② 改一个 env 为新明文 → 照存(其余掩码值照常还原);删一个键 → 删掉。
      const rotated = JSON.parse(JSON.stringify(echoed));
      findIn(rotated, 'hyg-stdio').env.GITHUB_TOKEN = GH_NEW;
      delete findIn(rotated, 'hyg-stdio').env.DROP_ME;
      const save2 = await postJson(PORT_F, '/api/config', { externalMcpServers: rotated }, hdr, 20000);
      const d2 = findIn(readDisk().externalMcpServers, 'hyg-stdio');
      ok(save2.status === 200 && d2 && d2.env.GITHUB_TOKEN === GH_NEW, '(f②) a new plaintext env value is stored (got ' + keyHead(d2 && d2.env.GITHUB_TOKEN) + ')');
      ok(d2 && !Object.prototype.hasOwnProperty.call(d2.env, 'DROP_ME') && d2.env.FAKE_MCP_ENV_CAPTURE === ENV_CAPTURE && JSON.stringify(d2.args) === JSON.stringify(baseStdio.args),
        '(f②) a deleted env key is removed; the untouched masked env/args are restored (keys ' + (d2 && JSON.stringify(Object.keys(d2.env))) + ')');
      ok(leaks(save2.raw).length === 0 && !save2.raw.includes(GH_NEW), '(f②) the save response does not echo the new plaintext value');

      // ② 新 id／改了 id 的条目带着别人的掩码 → 没有匹配 → 清空,不落掩码。
      const st3 = await getJson(PORT_F, '/api/status');
      const cur = st3.json.config.externalMcpServers;
      const newbie = { ...JSON.parse(JSON.stringify(findIn(cur, 'hyg-stdio'))), id: 'hyg-new', label: 'new' };
      const renamed = { ...JSON.parse(JSON.stringify(findIn(cur, 'hyg-remote'))), id: 'hyg-remote-renamed' };
      const save3 = await postJson(PORT_F, '/api/config', { externalMcpServers: [...cur, newbie, renamed] }, hdr, 20000);
      const disk3 = readDisk();
      const n3 = findIn(disk3.externalMcpServers, 'hyg-new'), r3 = findIn(disk3.externalMcpServers, 'hyg-remote-renamed');
      ok(save3.status === 200 && n3 && n3.env.GITHUB_TOKEN === '' && n3.args[2] === '' && n3.args[3] === '' && r3 && r3.headers.Authorization === '',
        '(f②) new/renamed server with masked values and no match → cleared (env ' + keyHead(n3 && n3.env.GITHUB_TOKEN) + ', header ' + keyHead(r3 && r3.headers.Authorization) + ')');
      ok(findIn(disk3.externalMcpServers, 'hyg-stdio').env.GITHUB_TOKEN === GH_NEW && findIn(disk3.externalMcpServers, 'hyg-remote').headers.Authorization === 'Bearer ' + BEARER_VAL,
        '(f②) the original servers keep their real values in the same save');
      const text3 = readText(cfgPath);
      ok(!text3.includes(MASK) && !text3.includes(REDACTED), '(f③) still no mask / redaction marker anywhere in config.json');

      // ② 启动向量变了(同 id,改 command／url)→ 回传的掩码不跟过去,按清空处理。
      const st4 = await getJson(PORT_F, '/api/status');
      const moved = JSON.parse(JSON.stringify(st4.json.config.externalMcpServers.filter(s => s.id === 'hyg-stdio' || s.id === 'hyg-remote')));
      findIn(moved, 'hyg-stdio').command = path.join(MCP_HOME, 'other-launcher.exe');
      findIn(moved, 'hyg-remote').url = 'http://127.0.0.1:1/elsewhere';
      const save4 = await postJson(PORT_F, '/api/config', { externalMcpServers: moved }, hdr, 20000);
      const disk4 = readDisk();
      const m4 = findIn(disk4.externalMcpServers, 'hyg-stdio'), mr4 = findIn(disk4.externalMcpServers, 'hyg-remote');
      ok(save4.status === 200 && m4 && m4.env.GITHUB_TOKEN === '' && m4.args[2] === '' && mr4 && mr4.headers.Authorization === '' && leaks(readText(cfgPath)).length === 0 && !readText(cfgPath).includes(GH_NEW),
        '(f②) same id but changed command/url → masked values are NOT re-attached (env ' + keyHead(m4 && m4.env.GITHUB_TOKEN) + ', header ' + keyHead(mr4 && mr4.headers.Authorization) + ')');
    } catch (e) { console.log('ERROR(f) ' + (e && e.stack || e)); fail++; }
    finally { killp(wb); remote.close(); await sleep(300); fs.rmSync(MCP_HOME, { recursive: true, force: true }); }
  }

  // Verdict line follows the harness convention (dev-harness/README.md): "<NAME> E2E: ALL PASS" —
  // the regression runner greps for "E2E:" to collect verdicts.
  console.log('\nREPO-HYGIENE E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
