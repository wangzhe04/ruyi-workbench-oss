'use strict';
require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
// 2026-09-06 事故回归锁：用户的五个 Provider（含密钥）被一次整份 POST /api/config 写成 providers: [] 清空。
// 两道保险：
//   ① 服务端（13-http-router applyConfigPatch）：现值有 Provider、来件把它清成空数组时，先把当前 config
//      原样另存 config.json.bak-providers-<时间戳>，并记 config_providers_cleared 审计事件；不拦截。
//   ② 前端（provider-settings.js saveSettings）：providersDraft 没被 config 播种过就不上传 providers 键
//      （providersDraftSeeded），服务端 {...current, ...body} 因此保留现值。这里用源码锚锁住。
// 判定行：`CONFIG PROVIDERS GUARD E2E: ALL PASS`。
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-providers-guard-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } } }

(async () => {
const WB_PORT = await getFreePort();
const CONFIG = path.join(HOME, 'config.json');
const providers = [
  { id: 'fake-a', label: 'A', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-real-key-A', model: 'm-a', models: [{ id: 'm-a', label: 'm-a' }] },
  { id: 'fake-b', label: 'B', type: 'openai-compat', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'sk-real-key-B', model: 'm-b', models: [{ id: 'm-b', label: 'm-b' }] },
];
fs.writeFileSync(CONFIG, JSON.stringify({ configSchema: 7, activeProvider: 'fake-a', engineMode: 'interactive', providers, locale: 'zh-CN' }, null, 2));

let TOKEN = '';
function getToken() {
  return new Promise(res => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/', timeout: 5000 }, resp => { // 117q-§8.14:抓 token 这一次原给 1500,重载下 GET / p90=2083ms 被击穿(不是竞态,见 30 号文 §8.14)
      let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); });
    });
    r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); });
  });
}
function reqJson(method, p, payload) {
  return new Promise((resolve, reject) => {
    const data = payload === undefined ? null : JSON.stringify(payload);
    const headers = { ...(TOKEN ? { 'x-wcw-token': TOKEN } : {}), ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) };
    const r = http.request({ host: '127.0.0.1', port: WB_PORT, path: p, method, headers, timeout: 15000 }, res => {
      let body = ''; res.on('data', c => { body += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(body); } catch { j = null; } resolve({ status: res.statusCode, json: j, text: body }); });
    });
    r.on('error', reject); r.on('timeout', () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data); r.end();
  });
}
async function waitForHttp(attempts = 300) { // 117q:预算 100×150ms=15s 低于 30 号文 P1-31 建议的 300×同款间隔量级,为同批口径统一一并抬高(30 号文 P1-31)
  for (let i = 0; i < attempts; i++) { try { const r = await reqJson('GET', '/api/status'); if (r.status === 200) return true; } catch { /* not up yet */ } await sleep(150); }
  return false;
}
const readDisk = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

let wb = null;
try {
  wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, windowsHide: true, stdio: 'ignore' });
  ok(await waitForHttp(), 'A0 workbench listening');
  TOKEN = await getToken();
  ok(!!TOKEN, 'A0b got UI token (POST /api/config is token-level)');

  // ① 部分 patch 不带 providers → 现值原样保留（合并语义）。
  let r = await reqJson('POST', '/api/config', { locale: 'en-US', stewardProviderId: 'fake-a' });
  ok(r.status === 200 && r.json && r.json.ok === true, `A1 partial patch accepted (status ${r.status})`);
  let disk = readDisk();
  ok(Array.isArray(disk.providers) && disk.providers.length === 2 && disk.providers[0].apiKey === 'sk-real-key-A',
    'A2 partial patch keeps both providers and the real keys on disk');
  ok(!fs.readdirSync(HOME).some(f => f.startsWith('config.json.bak-providers-')), 'A3 no backup written for a harmless patch');

  // ② 掩码回传（UI 把 GET /api/status 的 ••••… 原样发回）→ 密钥经 unmaskSecrets 复原，不被抹掉。
  const status = await reqJson('GET', '/api/status');
  const masked = status.json && status.json.config && status.json.config.providers;
  ok(Array.isArray(masked) && masked.length === 2 && String(masked[0].apiKey || '').includes('•'), 'B1 GET /api/status masks provider keys');
  r = await reqJson('POST', '/api/config', { providers: masked });
  disk = readDisk();
  ok(r.status === 200 && disk.providers.length === 2 && disk.providers[1].apiKey === 'sk-real-key-B', 'B2 masked round-trip restores the real keys');

  // ②b 缩水（2 → 1，丢 fake-b）也要备份 + 审计（设置弹窗子审查：草稿未播种时「添加一条再保存」正是这种丢法）。
  r = await reqJson('POST', '/api/config', { providers: [masked[0]] });
  disk = readDisk();
  const shrinkBackups = fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-'));
  ok(r.status === 200 && disk.providers.length === 1 && disk.providers[0].id === 'fake-a', 'B3 shrinking to a partial list is still honoured');
  ok(shrinkBackups.length === 1, `B4 a backup is written on shrink, not only on clear (${shrinkBackups.join(',')})`);
  await sleep(300);
  ok(/config_providers_shrunk/.test(fs.existsSync(path.join(HOME, 'logs')) ? fs.readdirSync(path.join(HOME, 'logs')).filter(f => f.endsWith('.ndjson')).map(f => fs.readFileSync(path.join(HOME, 'logs', f), 'utf8')).join('\n') : ''),
    'B5 audit event config_providers_shrunk logged with the lost ids');
  // 恢复成两条（fake-b 已不在盘上，掩码无从复原，这里显式带真密钥），下面的清空场景从两条开始。
  r = await reqJson('POST', '/api/config', { providers: [masked[0], { ...masked[1], apiKey: 'sk-real-key-B' }] });
  ok(r.status === 200 && readDisk().providers.length === 2 && readDisk().providers[1].apiKey === 'sk-real-key-B', 'B6 re-adding the second provider with an explicit key lands on disk');
  const backupsBeforeClear = fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-')).length;

  // ③ 整份保存把 providers 清成 [] → 仍然写入（不拦截），但先另存一份备份 + 审计事件。
  r = await reqJson('POST', '/api/config', { providers: [], permissionMode: 'default' });
  disk = readDisk();
  const backups = fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-'));
  ok(r.status === 200 && Array.isArray(disk.providers) && disk.providers.length === 0, 'C1 clearing providers is still honoured (last-one-deleted is legal)');
  ok(backups.length === backupsBeforeClear + 1, `C2 exactly one more backup written before the wipe (${backups.join(',')})`);
  const newestBackup = backups.slice().sort().pop();
  const backup = newestBackup ? JSON.parse(fs.readFileSync(path.join(HOME, newestBackup), 'utf8')) : null;
  ok(backup && Array.isArray(backup.providers) && backup.providers.length === 2 && backup.providers[0].apiKey === 'sk-real-key-A',
    'C3 the backup carries both providers with real keys (recoverable)');
  await sleep(300);
  const logDir = path.join(HOME, 'logs');
  const logText = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter(f => f.endsWith('.ndjson')).map(f => fs.readFileSync(path.join(logDir, f), 'utf8')).join('\n') : '';
  ok(/config_providers_cleared/.test(logText), 'C4 audit event config_providers_cleared logged');

  // ④ 已经是空的再发 [] → 不再重复备份。
  r = await reqJson('POST', '/api/config', { providers: [] });
  ok(fs.readdirSync(HOME).filter(f => f.startsWith('config.json.bak-providers-')).length === backupsBeforeClear + 1, 'C5 no extra backup when there was nothing to lose');

  // ⑤ 前端守门的源码锚：saveSettings 只在草稿播种后上传 providers。
  const ps = fs.readFileSync(path.join(WB, 'app', 'public', 'js', 'provider-settings.js'), 'utf8');
  ok(/providers: state\.providersDraftSeeded === true \? \(state\.providersDraft \|\| \[\]\) : undefined/.test(ps),
    'D1 saveSettings uploads providers only when the draft was seeded from config');
  // 117k（2026-09-07 真机走查复现的【剩余那半个洞】）：那道守卫只问「播种过没有」，没问「播种的
  // 是不是真的 config」。config 还没到达时打开设置弹窗 → fillSettings 拿着空 state.config 跑一次，
  // 草稿播成 [] 并被标成【已播种】；config 随后到了，可「弹窗开着」分支跳过重播，草稿就一直空着。
  // 此时点保存 = 把用户整份 Provider 连同密钥写成 []。实测：加载后 2ms 打开设置 → 一次保存清空。
  // 判据必须是「这一次拿到的确实是一份带 providers 数组的 config」。
  ok(/state\.providersDraftSeeded = Array\.isArray\(c\.providers\);/.test(ps),
    'D2 fillSettings 只在【真的拿到 config】时才把草稿标成已播种（config 没到就不声称播过种）');
  ok(/state\.providersDraftSeeded = true;   \/\/ 用户亲手添加/.test(ps),
    'D2b 用户亲手添加 Provider 仍然直接标记已播种（那是用户意图，保存时照常上传）');
  ok(!/state\.providersDraftSeeded = true;\n/.test(ps.slice(0, ps.indexOf('renderProviders();'))),
    'D2c fillSettings 那一处不再无条件标 true（防回改）');

  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  // ⑤ 107-S2（46 号文 §5 ⑦b M5）：掩码回传的【启动向量闸】走一遍真 HTTP。
  //    修前：同一次保存里把 baseUrl 换成别人的地址、apiKey 框里仍是 GET /api/status 下发的 ••••，
  //    服务端按 id 配对就把真 key 贴到了新端点上 —— 主端点每回合都用。
  //    现在：地址变了就【整份拒绝、零写入】，回包带稳定码 config.masked_secret_vector_changed，
  //    人话里点名是哪一条要重填密钥（不是静默清空 —— 那是用户看不见的丢失）。
  //    假密钥运行时拼出（repo-hygiene (b) 的全仓扫描不误报），失败信息只打前 6 个字符。
  // ═════════════════════════════════════════════════════════════════════════════════════════════════
  const head6 = v => (typeof v === 'string' ? JSON.stringify(v.slice(0, 6) + (v.length > 6 ? '…' : '')) : String(v));
  const KEY_E = 'sk-' + 'S2Guard' + 'Fake' + '4321';
  const HDR_E = 'Bearer ' + 'hdrS2' + 'Guard' + 'WxYz';   // 末四位不用数字：8700-9199 是 run-all 的端口唯一性审计带
  // 假上游：/v1/models 返回一个模型，并记下每次请求的 Authorization（provider/test 会打到这里）。
  const seenAuth = [];
  const upstream = http.createServer((req, res) => {
    seenAuth.push(req.headers['authorization'] || null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'guard-model' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const UP = 'http://127.0.0.1:' + upstream.address().port;
  // 「攻击者端点」必须是【真在监听并记录】的 —— 换成一个没人听的端口，反向摘闸时请求会连不上，
  // 「没收到」就有了第二种解释（对照组不在屏上，那条断言就不再是判据；见 32 号文纪律里那条教训）。
  const evilAuth = [];
  const evil = http.createServer((req, res) => {
    evilAuth.push(req.headers['authorization'] || null);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'evil-model' }] }));
  });
  await new Promise(resolve => evil.listen(0, '127.0.0.1', resolve));
  const EVIL = 'http://127.0.0.1:' + evil.address().port;
  try {
    r = await reqJson('POST', '/api/config', { providers: [
      { id: 'vec', label: 'Vec', type: 'openai-compat', baseUrl: UP, apiKey: KEY_E, model: 'guard-model', models: [{ id: 'guard-model', label: 'guard-model' }], extraHeaders: { Authorization: HDR_E, 'X-Organization': 'org-9' } },
    ] });
    ok(r.status === 200 && readDisk().providers[0].apiKey === KEY_E, 'E0 fixture provider with a key + sensitive header is on disk');

    const st = await reqJson('GET', '/api/status');
    const shown = st.json.config.providers.find(p => p && p.id === 'vec');
    ok(shown && shown.apiKey.startsWith('••••') && shown.hasKey === true && shown.extraHeaders.Authorization.startsWith('••••') && shown.baseUrl === UP,
      'E1 GET /api/status masks apiKey + sensitive header, baseUrl（无凭据）逐字节不变');
    const diskBefore = fs.readFileSync(CONFIG, 'utf8');

    // ① 地址没变 + 掩码原样回传 → 磁盘逐字节不变。
    r = await reqJson('POST', '/api/config', { providers: [JSON.parse(JSON.stringify(shown))] });
    ok(r.status === 200 && fs.readFileSync(CONFIG, 'utf8') === diskBefore, 'E2 masked echo with an UNCHANGED baseUrl → disk byte-identical');

    // ② 地址变了 + 掩码原样回传 → 409、零写入、回包点名。
    const moved = { ...JSON.parse(JSON.stringify(shown)), baseUrl: EVIL };
    r = await reqJson('POST', '/api/config', { providers: [moved] });
    const errInfo = r.json && r.json.error && typeof r.json.error === 'object' ? r.json.error : {};
    ok(r.status === 409 && errInfo.code === 'config.masked_secret_vector_changed', `E3 masked echo with a CHANGED baseUrl is refused (status ${r.status}, code ${errInfo.code})`);
    ok(typeof errInfo.message === 'string' && errInfo.message.includes('Vec') && errInfo.message.includes('重新填'),
      'E3 the response says which provider needs its key re-entered（人话里带条目名）');
    ok(Array.isArray(errInfo.params && errInfo.params.conflicts) && errInfo.params.conflicts[0].reason === 'endpoint_changed'
      && !r.text.includes(KEY_E) && !r.text.includes(HDR_E), 'E3 the refusal carries a machine-readable conflict list and NO secret value');
    ok(fs.readFileSync(CONFIG, 'utf8') === diskBefore, 'E4 the refused save wrote nothing at all（连同一次保存里的别的字段一起回滚）');
    ok(readDisk().providers[0].apiKey === KEY_E && readDisk().providers[0].baseUrl === UP, `E4 the real key is still attached to the ORIGINAL endpoint (${head6(readDisk().providers[0].apiKey)} @ ${readDisk().providers[0].baseUrl})`);

    // ③ 换地址同时重填明文密钥与敏感头 → 照存。
    const NEW_E = 'sk-' + 'S2Rot' + 'Fake' + '1122', NEWH = 'Bearer ' + 'rotS2' + 'Fake' + '3344';
    r = await reqJson('POST', '/api/config', { providers: [{ ...moved, apiKey: NEW_E, extraHeaders: { Authorization: NEWH, 'X-Organization': 'org-9' } }] });
    let d = readDisk().providers[0];
    ok(r.status === 200 && d.baseUrl === EVIL && d.apiKey === NEW_E && d.extraHeaders.Authorization === NEWH,
      `E5 a new plaintext key + header with a changed baseUrl is stored (${head6(d.apiKey)})`);
    // 换回来，后面的 provider/test 要真的打得通。
    r = await reqJson('POST', '/api/config', { providers: [{ ...moved, baseUrl: UP, apiKey: KEY_E, extraHeaders: { Authorization: HDR_E, 'X-Organization': 'org-9' } }] });
    ok(r.status === 200 && readDisk().providers[0].baseUrl === UP, 'E5b provider restored to the reachable endpoint');

    // ④ 掩码永远到不了磁盘。
    ok(!fs.readFileSync(CONFIG, 'utf8').includes('••••'), 'E6 config.json contains no mask anywhere');

    // ⑤ POST /api/provider/test —— 这条路会把还原出来的 key【当场发出去】，所以闸要在发请求之前。
    const st2 = await reqJson('GET', '/api/status');
    const shown2 = st2.json.config.providers.find(p => p && p.id === 'vec');
    seenAuth.length = 0; evilAuth.length = 0;
    r = await reqJson('POST', '/api/provider/test', { provider: { ...JSON.parse(JSON.stringify(shown2)), baseUrl: EVIL } });
    ok(r.json && r.json.ok === false && r.json.code === 'config.masked_secret_vector_changed', `E7 provider/test refuses a masked key aimed at a new endpoint (code ${r.json && r.json.code})`);
    ok(evilAuth.length === 0 && seenAuth.length === 0 && !r.text.includes(KEY_E),
      `E7 …and the attacker endpoint（真在监听）收到 0 个请求，真 key 一个字节都没出门（evil ${evilAuth.length} 次，首个 ${head6(evilAuth[0])}）`);
    r = await reqJson('POST', '/api/provider/test', { provider: JSON.parse(JSON.stringify(shown2)) });
    // undici 把大小写不同的两个 Authorization 合成一行（内置 bearer 在前、extraHeaders 的在后），
    // 所以这一行同时证明了 apiKey 与敏感头【两个掩码】都按真值还原了。
    ok(r.json && r.json.ok === true && seenAuth.length === 1 && String(seenAuth[0]).includes(KEY_E) && String(seenAuth[0]).includes(HDR_E),
      `E8 the same masked draft against the UNCHANGED endpoint still probes with the real key + header (${head6(seenAuth[0])}, len ${String(seenAuth[0] || '').length})`);

    // ⑥ 机械锁：maskSecrets 里每多一处掩码，就必须在 maskedSecretConflicts 里给它声明一条启动向量，
    //    否则又是一个「掩码回传把密钥搬到新端点」的洞。这里把掩码点的数量钉住 —— 数量一变就红，
    //    改的人被迫回来读这条注释（手攒的名单必须配锁；本仓已经因为漏登记翻车过几次）。
    const src = fs.readFileSync(path.join(WB, 'app', 'src', '05-claude-engine.js'), 'utf8');
    const body = src.slice(src.indexOf('function maskSecrets(config)'), src.indexOf('function unmaskSecrets('));
    const maskPoints = (body.match(/maskKey\(|maskExtraHeaders\(|maskExternalMcpServerForDisplay\b/g) || []).length;
    ok(maskPoints === 6, `E9 maskSecrets 的掩码点恰好 6 处（providers.apiKey / providers.extraHeaders / searchBackend.apiKey / modelsApiKey / externalMcpServers ×2 引用）——实得 ${maskPoints}；新增一处就要在 maskedSecretConflicts 里同时声明它的启动向量`);
    ok(/config\.masked_secret_vector_changed/.test(ps), 'E9 设置页按【稳定码】分支渲染这条拒绝（不匹配中文）');
  } finally {
    await new Promise(resolve => upstream.close(resolve));
    await new Promise(resolve => evil.close(resolve));
  }
} catch (e) {
  fail++; console.log('FAIL exception ' + (e && e.stack || e));
} finally {
  killp(wb);
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}
console.log(fail ? `CONFIG PROVIDERS GUARD E2E: FAIL (${fail})` : 'CONFIG PROVIDERS GUARD E2E: ALL PASS');
process.exit(fail ? 1 : 0);
})();
