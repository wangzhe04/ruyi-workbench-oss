require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离——服务启动会从真机 ~/.claude.json 导入 MCP 并把 externalMcpServers 同步回真机 CLI 配置，两个方向都要断（见 lib 头注）
'use strict';
// E2E(第122波 §2.5):启动探针挪到 listen 之后 —— 「打开工作台等半天才出界面」。
//
// 现状(修前,本机实测,全新 HOME + TEMP 指向全新目录即磁盘缓存冷):
//   spawnSync 逐发计时 → readConfig 里 claude/kimi 的 --version 各一发(合计 ~1 s),
//   然后 syncMcpServersToClaude 的【同步前缀】resolveExternalMcpServers → detectDesktopMcp → pickPython
//   一发 python 探针 1983 ms;listen 落在 3.2 s,/health 200 落在 3.35 s。
//   那三处 void 调用虽是 fire-and-forget,函数体在第一个 await 之前照样同步跑。
// 修后:三处 fire-and-forget 与 generateMcpConfig 预热整体挪到 listen 之后;/health 200 实测 1.28 s。
//
// 为什么本件不按号文那样用 PATH 垫片(python.cmd/python3.cmd/py.cmd 各 ping 2 s):**实测垫片根本跑不到**——
// probeDesktopPython 走 cp.spawnSync('python', …)(不带 shell、不过 batchSafeSpawn),Node 在 Windows 上
// 对 PATH 里的 .cmd 直接 ENOENT(把 PATH 设成只有垫片目录,spawnSync 立刻 ENOENT,连 CVE-2024-27980 的
// EINVAL 都到不了)。也就是说垫片永远不会被 spawn,更不会慢 2 s。所以本件不造假探针,直接量真机:
//   ① 墙钟判据:spawn → /health 200 ≤ 2.5 s（本机真探针 ~2 s，修前必然超）；
//   ② /api/status 在 15 s 内返回；desktopMcp 探完是原样三键、在飞时多一个 probing（128f-③ 起首个请求不再付探针，见 48 号文 §2-c）；
//   ③ 形状锁:三处 fire-and-forget 与 generateMcpConfig 预热都排在 listenWithFallback 之【后】、
//      在延迟 setImmediate 段里，且 detectDesktopMcp 仍是同步签名（39 号文的拍板：签名保留，
//      预热改走异步孪生 ensureDesktopMcpWarm()，形状锁跟着钉住「三处 fire-and-forget 排在它的 .then 里」）；
//   ④ 39 号文：探针在飞的时候 /health 不该被挡住（同步 spawnSync 会把整个进程钉住 ~2 s）。
//      —— ① 在「本机没装任何 python」的机器上会变弱（探针本来就不慢），③ 是与机器无关的那一半。
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { readServerSource } = require('./src-reader');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const BASE = path.join(os.tmpdir(), 'wcw-boot-listen-budget-e2e');
const HOME = path.join(BASE, 'home');
const FRESH_TMP = path.join(BASE, 'tmp');       // TEMP/TMP 指向全新目录 -> 桌面 python 探针的磁盘缓存必冷
const SHIM = path.join(BASE, 'shim');
const WB_PORT = 8732;                            // 本件固定端口(端口审计:跨文件零撞车)
const HEALTH_BUDGET_MS = 2500;
const STATUS_BUDGET_MS = 15000;
const HEALTH_DURING_PROBE_BUDGET_MS = 800;   // 39 号文 ④:探针在飞时另一个请求的天花板(同步版实测 ~2 s)

const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
function kill(c) { if (c && c.pid) { try { killOwnTree(c); } catch { /* already gone */ } } }
function health() {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: '/health', timeout: 3000 }, res => { res.resume(); resolve(res.statusCode === 200); });
    r.on('error', () => resolve(false));
    r.on('timeout', () => { r.destroy(); resolve(false); });
  });
}
function getJson(pathname, token, timeoutMs) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port: WB_PORT, path: pathname, timeout: timeoutMs, headers: token ? { 'x-wcw-token': token } : {} }, res => {
      let b = ''; res.on('data', c => { b += c; }); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* non-json */ } resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', () => resolve(null));
    r.on('timeout', () => { r.destroy(); resolve(null); });
  });
}

(async () => {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true }); fs.mkdirSync(FRESH_TMP, { recursive: true }); fs.mkdirSync(SHIM, { recursive: true });
  // 假 claude(只 exit 0):让 syncMcpServersToClaude 过掉 existsExecutable 那道门，从而真的走到
  // resolveExternalMcpServers → detectDesktopMcp 这条探针路径——否则这一刀要治的那段根本不执行。
  const fakeClaude = path.join(SHIM, 'claude.cmd');
  fs.writeFileSync(fakeClaude, '@echo off\r\nexit /b 0\r\n', 'utf8');
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, permissionMode: 'bypass', includeWorkbenchMcp: true, claudePath: fakeClaude,
  }), 'utf8');

  const t0 = Date.now();
  // env 就地写在 spawn 里（不抽成变量）：fixture-home.static 的静态扫按「实参文本里出现 RUYI_HOME」
  // 认这一处，抽成变量它就扫不到，那条「每一处都 spread process.env」的守卫也就管不到本件。
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, RUYI_HOME: HOME, HOME, USERPROFILE: HOME, TEMP: FRESH_TMP, TMP: FRESH_TMP },
  });
  let stdout = '';
  wb.stdout.on('data', d => { stdout += String(d); });
  wb.stderr.on('data', d => String(d).trim() && console.error('[wb!] ' + String(d).trim()));

  try {
    let healthMs = -1;
    for (let i = 0; i < 1500; i++) { if (await health()) { healthMs = Date.now() - t0; break; } await sleep(20); }
    ok(healthMs >= 0 && healthMs <= HEALTH_BUDGET_MS, `spawn → /health 200 ≤ ${HEALTH_BUDGET_MS} ms（实得 ${healthMs} ms）`);

    let token = '';
    for (let i = 0; i < 300; i++) { try { token = JSON.parse(fs.readFileSync(path.join(HOME, 'runtime.json'), 'utf8')).token || ''; } catch { /* not yet */ } if (token) break; await sleep(50); }
    ok(!!token, 'runtime token available');

    // 39 号文 ④:趁 /api/status 那一发探针还在飞,横插一个 /health。同步 spawnSync 那版会把整个进程
    // 钉住 ~2 s(此刻 token 刚落盘,离 listen 只有几十毫秒,启动预热的 500 ms 延迟还没到,所以这一发
    // /api/status 就是那趟探针的发起者)。本机没装 python 的话探针本来就快,这条会变弱但不会假红。
    const s0 = Date.now();
    const statusPending = getJson('/api/status', token, STATUS_BUDGET_MS);
    await sleep(50);
    const h0 = Date.now();
    const healthyDuringProbe = await health();
    const healthDuringProbeMs = Date.now() - h0;
    const status = await statusPending;
    const statusMs = Date.now() - s0;
    ok(healthyDuringProbe && healthDuringProbeMs <= HEALTH_DURING_PROBE_BUDGET_MS,
      `探针在飞时 /health 仍然秒答(实得 ${healthDuringProbeMs} ms ≤ ${HEALTH_DURING_PROBE_BUDGET_MS}；同一时刻 /api/status 用了 ${Date.now() - s0} ms)`);
    ok(status && status.status === 200 && status.json && status.json.ok !== false, `/api/status 在 ${STATUS_BUDGET_MS} ms 内返回（实得 ${statusMs} ms）`);
    const dm = status && status.json ? status.json.desktopMcp : undefined;
    const dmKeys = dm && typeof dm === 'object' ? Object.keys(dm).sort().join(',') : String(dm);
    // 128f-③（48 号文 §2-c）改了本条的口径：探测在飞时 /api/status 不再「首个请求付一次探针」，而是秒回并多带 probing:true
    // （detected／resolved 为 null，前端有界跟进）；探完之后形状与改前逐键相同。所以这里认两种形状，且 probing 形必须是在飞的样子。
    const probingShape = dmKeys === 'detected,enabled,probing,resolved' && dm.probing === true && dm.detected === null && dm.resolved === null;
    ok(dmKeys === 'detected,enabled,resolved' || probingShape, `/api/status 的 desktopMcp 字段形状：探完是原样三键、在飞是三键＋probing（${dmKeys}）`);
    ok(typeof (status && status.json && status.json.mcpConfigPath) === 'string' && status.json.mcpConfigPath.length > 0,
      '/api/status 仍带 mcpConfigPath（探完现算；在飞时只回路径、不重新生成）');

    // ── 形状锁:与机器无关的那一半 ──
    const src = readServerSource();
    // 锚点必须落在 boot 段【自己】那一句上:`await invalidateSessionIndex();` 在全文里第一处出现于 02，
    // 拿它切片会把半个仓库都算进 "listen 之前"。这一句带注释的 readConfig 是 boot 段独有的。
    const bootStart = src.indexOf('let config = await readConfig(); // let: autoImportClaudeCodeMcp 写回后需重绑到最新引用');
    const listenAt = src.indexOf('const port = await listenWithFallback(server, requestedPort, host, config);');
    ok(bootStart > 0 && listenAt > bootStart, 's 定位到 boot 段与 listenWithFallback');
    const beforeListen = src.slice(bootStart, listenAt);
    const afterListen = src.slice(listenAt);
    for (const name of ['syncMcpServersToClaude(config)', 'syncMcpServersToKimi(config)', 'getCapabilities(config)']) {
      ok(!beforeListen.includes(name) && afterListen.includes(name), `s boot 段 listen 之前不再调 ${name}，挪到了 listen 之后`);
    }
    ok(!/await generateMcpConfig\(config\.mcpCommandMode\)/.test(beforeListen)
      && /void generateMcpConfig\(config\.mcpCommandMode\)/.test(afterListen),
    's MCP 配置预热也在 listen 之后（原来 autoImportClaudeCodeMcp 内那一发已摘除）');
    ok(/const BOOT_PROBE_WARMUP_MS = \d+;/.test(afterListen) && /setTimeout\(\(\) => setImmediate\(\(\) => \{/.test(afterListen),
      's 探针段用「listen 之后再让一小段起跑延迟」的形状（同步 spawnSync 会占住事件循环，只 setImmediate 不够）');
    ok(/^\s*const imp = await autoImportClaudeCodeMcp\(config\)/m.test(beforeListen),
      's autoImportClaudeCodeMcp 仍留在 listen 之前（它只读 ~/.claude.json，不碰探针）');
    ok(/function detectDesktopMcp\(\)/.test(src) && !/async function detectDesktopMcp\(\)/.test(src),
      's detectDesktopMcp 保持同步签名（39 号文 §2 的拍板：它的调用方 resolveExternalMcpServers 一族散在 8 个模块，改 async 是跨模块大手术）');
    // ── 39 号文的三把形状锁 ──
    ok(/async function detectDesktopMcpAsync\(\)/.test(src) && /async function pickPythonAsync\(/.test(src),
      's 异步孪生 detectDesktopMcpAsync／pickPythonAsync 都在');
    ok(/function probeDesktopPythonAsync\(/.test(src) && /cp\.execFile\(candidate\.command/.test(src),
      's 异步探针走 cp.execFile（不过 shell，与 spawnSync 那支同口径）');
    const warmAt = afterListen.indexOf('void ensureDesktopMcpWarm(config).then(() => {');
    ok(warmAt > 0 && warmAt < afterListen.indexOf('syncMcpServersToClaude(config)'),
      's boot 段先 ensureDesktopMcpWarm()，三处 fire-and-forget 排在它的 .then 里（预热之后它们的同步前缀全部吃缓存）');
  } finally {
    kill(wb);
    await sleep(300);
    try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* windows file lock */ }
  }
  console.log('\nBOOT LISTEN BUDGET E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
