'use strict';
/*
 * E2E (第118波 118c): 启动体验 -- 启动失败看得见,端口被占不再是死路。
 *
 * 立项理由:端口占用、数据目录不可写这类启动失败以前【只打在终端上】。而 118c 之后启动器不再留黑窗,
 * 用户根本没有那个终端可看 -- 失败必须以别的方式抵达用户。做法是:
 *   · 失败时把人话写进 <data>/last-start-error.json({at, kind, message, next});
 *   · 下一次【成功】启动把它读出来挂到 GET /api/status 的 startNotice 上,并【立刻删文件】(一次性提示);
 *   · 原端口被非工作台进程占着时,自动往后试 port+1..port+9,实际端口写进 runtime.json 并在顶部条说明。
 *
 * 本件钉死的契约:
 *   ① 端口被占 -> 自动改用下一个端口;runtime.json 记录【实际】端口;status.startNotice.portFallback 如实上报。
 *   ② last-start-error.json 的形状(四个字段)与消费(读出即删;第二次启动不再重复提示)。
 *   ③ 数据目录不可用 -> 落 kind=data-dir-unwritable 的记录(见下面对 Windows 构造方式的说明)。
 *   ④ 连着九个端口全被占 -> 启动失败并落 kind=port-unavailable,message/next 都是人话。
 *   ⑤ 源码锁:三类 kind 是 Object.freeze 常量、回退宽度是常量、读出即删、runtime.json 用实际端口。
 *
 * 关于 ③ 的构造:Windows 上用 ACL 造一个"存在但写不进"的目录在 CI 里既不可靠也难清理(需要 icacls +
 * 管理员语义)。这里改用等价且确定的构造 -- 把 <data>/sessions 做成一个【文件】,于是 ensureDirs 的
 * mkdir 必然抛错,走的正是"数据目录不可用"的同一条 catch 分支。真正的 ACL 拒写没有单独覆盖,已在
 * 交付报告里写明。
 *
 * 全离线,端口全部用 getFreePort() 动态取(不占用 8700-9199 登记带)。
 * 判定行:`START ERROR SURFACE E2E: ALL PASS`。
 */
const cp = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const HOME_BASE = path.join(os.tmpdir(), 'wcw-start-error-e2e');
const sleep = ms => new Promise(r => setTimeout(r, ms));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };

function getJson(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: p, timeout: 20000 }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* non-JSON */ } resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout ' + p)); });
  });
}

// 占位监听:一个【不像工作台】的裸 TCP 服务(不回 /health),所以 freeStalePort 不会认领它。
function holdPort(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(socket => socket.destroy());
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
function closeServer(srv) { return new Promise(resolve => { try { srv.close(() => resolve()); } catch { resolve(); } }); }

// 每个临时 HOME 先落一份最小 config:关掉 autoImportClaudeCodeMcp,否则 boot 会去读【真实】的
// ~/.claude.json 并把本机的 MCP 登记灌进这个临时数据目录(既慢又污染夹具)。
function seedHome(home) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ autoImportClaudeCodeMcp: false }, null, 2), 'utf8');
  return home;
}

function spawnWorkbench(home, port, extraEnv = {}) {
  const child = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, ...extraEnv }, windowsHide: true,
  });
  child.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  child.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  return child;
}
function waitExit(child, ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ms);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
async function waitHealth(port, tries = 200) {
  for (let i = 0; i < tries; i++) {
    try { const r = await getJson(port, '/health'); if (r.status === 200) return true; } catch { /* not yet */ }
    await sleep(150);
  }
  return false;
}
function readRuntime(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, 'runtime.json'), 'utf8')); } catch { return null; }
}
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try { cp.execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
  catch { try { child.kill(); } catch { /* already gone */ } }
}

(async () => {
  fs.rmSync(HOME_BASE, { recursive: true, force: true });
  fs.mkdirSync(HOME_BASE, { recursive: true });

  /* ═══ ① 端口被非工作台进程占用 -> 自动改用下一个端口 ═══ */
  const homeA = path.join(HOME_BASE, 'fallback');
  seedHome(homeA);
  const takenPort = await getFreePort();
  const holder = await holdPort(takenPort);
  let wbA = null;
  try {
    wbA = spawnWorkbench(homeA, takenPort);
    const expected = takenPort + 1;
    ok(await waitHealth(expected), `① 原端口 :${takenPort} 被占 -> 工作台改用 :${expected} 并可服务`);

    const runtime = readRuntime(homeA);
    ok(!!runtime && runtime.port === expected,
      `① runtime.json 记录的是【实际】端口 ${runtime && runtime.port} (期望 ${expected},不是请求的 ${takenPort})`);

    const status = await getJson(expected, '/api/status');
    const notice = status.json && status.json.startNotice;
    ok(!!notice && typeof notice === 'object', '① GET /api/status 带 startNotice 只读字段');
    ok(!!notice && notice.portFallback && notice.portFallback.requested === takenPort && notice.portFallback.actual === expected,
      `① startNotice.portFallback 如实上报 {requested:${takenPort}, actual:${expected}}`);
    ok(!!notice && notice.lastError === null, '① 干净数据目录下 startNotice.lastError 为 null(没有历史失败就不提示)');
    ok(!fs.existsSync(path.join(homeA, 'last-start-error.json')), '① 端口成功改用【不算】启动失败,不写 last-start-error.json');
  } finally {
    killTree(wbA);
    await waitExit(wbA, 8000);
    await closeServer(holder);
  }

  /* ═══ ② last-start-error.json 的形状与消费(读出即删、只提示一次) ═══ */
  const homeB = path.join(HOME_BASE, 'consume');
  seedHome(homeB);
  const seeded = {
    at: '2026-09-04T01:02:03.000Z',
    kind: 'startup-failed',
    message: '如意上次启动时出错了,没能开起来。',
    next: '再启动一次通常就好。如果一直起不来,在「帮助 → 查看日志」里把最后几行发给支持人员。',
  };
  fs.writeFileSync(path.join(homeB, 'last-start-error.json'), JSON.stringify(seeded, null, 2), 'utf8');
  const portB = await getFreePort();
  let wbB = null;
  try {
    wbB = spawnWorkbench(homeB, portB);
    ok(await waitHealth(portB), '② 工作台在干净端口上起来');
    const status = await getJson(portB, '/api/status');
    const last = status.json && status.json.startNotice && status.json.startNotice.lastError;
    ok(!!last && last.kind === 'startup-failed' && last.at === seeded.at,
      '② startNotice.lastError 带 at/kind(上一次失败的记录被读出来了)');
    ok(!!last && last.message === seeded.message && last.next === seeded.next,
      '② message 与 next 都是人话且原样上报(前端顶部条直接可用)');
    ok(!/--port|http:\/\/|[A-Za-z]:\\\\/.test(String(last && last.next)),
      '② next 里没有命令行、没有 URL、没有让用户自己去开的绝对路径');
    ok(!fs.existsSync(path.join(homeB, 'last-start-error.json')),
      '② 读出后立刻删文件(一次性提示,不会每次启动都骚扰)');
  } finally {
    killTree(wbB);
    await waitExit(wbB, 8000);
  }
  // 同一个数据目录再起一次:不该再有提示。
  const portB2 = await getFreePort();
  let wbB2 = null;
  try {
    wbB2 = spawnWorkbench(homeB, portB2);
    ok(await waitHealth(portB2), '② 同一数据目录第二次启动');
    const status2 = await getJson(portB2, '/api/status');
    ok(status2.json && status2.json.startNotice && status2.json.startNotice.lastError === null,
      '② 第二次启动 lastError 回到 null(提示只出现一次)');
  } finally {
    killTree(wbB2);
    await waitExit(wbB2, 8000);
  }

  // 坏内容 / 未知 kind 一律丢弃,并且照样把文件清掉。
  const homeB3 = path.join(HOME_BASE, 'garbage');
  seedHome(homeB3);
  fs.writeFileSync(path.join(homeB3, 'last-start-error.json'), '{"kind":"whatever","message":"x"}', 'utf8');
  const portB3 = await getFreePort();
  let wbB3 = null;
  try {
    wbB3 = spawnWorkbench(homeB3, portB3);
    ok(await waitHealth(portB3), '② 未知 kind 的记录不影响启动');
    const status3 = await getJson(portB3, '/api/status');
    ok(status3.json && status3.json.startNotice && status3.json.startNotice.lastError === null,
      '② 未知 kind 被丢弃(不把机器码当人话印到界面上)');
    ok(!fs.existsSync(path.join(homeB3, 'last-start-error.json')), '② 坏记录同样被清掉,不会永远赖在数据目录里');
  } finally {
    killTree(wbB3);
    await waitExit(wbB3, 8000);
  }

  /* ═══ ③ 数据目录不可用 -> kind=data-dir-unwritable ═══ */
  // 见文件头说明:Windows 上 ACL 只读目录不好在 CI 里构造,这里让 <data>/sessions 是个【文件】,
  // ensureDirs 的 mkdir 必然抛错,走的是同一条 catch 分支。
  const homeC = path.join(HOME_BASE, 'unwritable');
  seedHome(homeC);
  fs.writeFileSync(path.join(homeC, 'sessions'), 'not a directory', 'utf8');
  const portC = await getFreePort();
  const wbC = spawnWorkbench(homeC, portC);
  const codeC = await waitExit(wbC, 60000);
  killTree(wbC);
  ok(codeC !== null && codeC !== 0, '③ 数据目录不可用时启动失败并以非零码退出(不假装起来了)');
  let recC = null;
  try { recC = JSON.parse(fs.readFileSync(path.join(homeC, 'last-start-error.json'), 'utf8')); } catch { recC = null; }
  ok(!!recC && recC.kind === 'data-dir-unwritable', '③ 落 kind=data-dir-unwritable');
  ok(!!recC && typeof recC.at === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(recC.at)
    && typeof recC.message === 'string' && recC.message.length > 0
    && typeof recC.next === 'string' && recC.next.length > 0,
    '③ 四个字段齐全:at(ISO) / kind / message / next');
  ok(!!recC && /磁盘|数据文件夹/.test(recC.next), '③ next 是人话「怎么办」,不是错误码');

  /* ═══ ④ 连着九个后备端口也全被占 -> kind=port-unavailable ═══ */
  // 用 WCW_KILL_PORT=0 跳过 netstat/tasklist/CIM 取证(那条路径 ① 已经真跑过),让本用例只测穷尽分支。
  const homeD = path.join(HOME_BASE, 'exhausted');
  seedHome(homeD);
  let base = 0;
  const holders = [];
  for (let attempt = 0; attempt < 6 && !base; attempt++) {
    const candidate = await getFreePort();
    const opened = [];
    let okAll = true;
    for (let i = 0; i <= 9; i++) {
      try { opened.push(await holdPort(candidate + i)); } catch { okAll = false; break; }
    }
    if (okAll) { base = candidate; holders.push(...opened); }
    else { for (const s of opened) await closeServer(s); }
  }
  ok(base > 0, '④ 夹具:连续占住 10 个端口(原端口 + 九个后备)');
  if (base > 0) {
    const wbD = spawnWorkbench(homeD, base, { WCW_KILL_PORT: '0' });
    const codeD = await waitExit(wbD, 60000);
    killTree(wbD);
    ok(codeD !== null && codeD !== 0, '④ 十个端口全占时启动失败并以非零码退出');
    let recD = null;
    try { recD = JSON.parse(fs.readFileSync(path.join(homeD, 'last-start-error.json'), 'utf8')); } catch { recD = null; }
    ok(!!recD && recD.kind === 'port-unavailable', '④ 落 kind=port-unavailable');
    ok(!!recD && recD.message.includes(String(base)) && recD.message.includes(String(base + 9)),
      `④ message 说清了试过哪些端口(${base}-${base + 9})`);
    ok(!!recD && /关掉|端口/.test(recD.next), '④ next 是人话「怎么办」');
    ok(!!recD && !/--port/.test(recD.next), '④ next 不给命令行(产品红线:不让用户去开终端)');
  }
  for (const s of holders) await closeServer(s);

  /* ═══ ⑤ 源码锁 ═══ */
  const routerSrc = fs.readFileSync(path.join(WB, 'app', 'src', '13-http-router.js'), 'utf8');
  ok(/const START_ERROR_KINDS = Object\.freeze\(\['port-unavailable', 'data-dir-unwritable', 'startup-failed'\]\);/.test(routerSrc),
    '⑤ 三类 kind 是源码写死的 Object.freeze 常量');
  ok(/const PORT_FALLBACK_SPAN = 9;/.test(routerSrc), '⑤ 端口回退宽度是常量(port+1..port+9)');
  ok(/const LAST_START_ERROR_FILE = 'last-start-error\.json';/.test(routerSrc),
    '⑤ 文件名是常量(103c 登记用的锚点)');
  const consumeStart = routerSrc.indexOf('async function consumeStartError()');
  const consumeBlock = consumeStart >= 0 ? routerSrc.slice(consumeStart, routerSrc.indexOf('\n}\n', consumeStart)) : '';
  ok(!!consumeBlock && consumeBlock.includes('fsp.unlink(file)') && consumeBlock.indexOf('fsp.unlink(file)') > consumeBlock.indexOf('fsp.readFile(file'),
    '⑤ 先读后删,且删除在形状判定【之前】(坏记录也会被清掉)');
  ok(/const port = await listenWithFallback\(server, requestedPort, host, config\);/.test(routerSrc)
    && /\{ port, host, pid: process\.pid/.test(routerSrc),
    '⑤ runtime.json 写的是 listenWithFallback 返回的【实际】端口,不是请求的端口');
  ok(/START_NOTICE\.portFallback = \{ requested: port, actual: candidate \};/.test(routerSrc),
    '⑤ 改用端口时如实登记 requested/actual 两端');
  // 本刀真实踩过的坑:第一版把 consumeStartError 放在 listen 之后,于是「已经在监听」与「握手常量写好」
  // 之间多了一个 await -- 那段窗口里进来的请求看到空 RUNTIME.token,能力探测与桥接回调偶发失败
  // (capabilities e2e 稳定复现)。这条断言防止任何人再往这段临界区里塞 await。
  const listenAt = routerSrc.indexOf('const port = await listenWithFallback(server, requestedPort, host, config);');
  const runtimeAt = routerSrc.indexOf('RUNTIME.token = runtimeToken;');
  const criticalSection = listenAt >= 0 && runtimeAt > listenAt ? routerSrc.slice(listenAt, runtimeAt) : 'await';
  ok(!/\bawait\b/.test(criticalSection.replace('const port = await listenWithFallback', '')),
    '⑤ listen 与 RUNTIME 握手常量赋值之间零 await(服务可服务时 token 必须已就位)');
  ok(routerSrc.indexOf('START_NOTICE.lastError = await consumeStartError();') < listenAt,
    '⑤ 上次失败记录在 listen 【之前】读出(不占用上面那段临界区)');
  const inventory = fs.readFileSync(path.join(__dirname, 'durable-state-inventory.js'), 'utf8');
  ok(inventory.includes("'last-start-error','<data>/last-start-error.json','13-http-router.js'"),
    '⑤ 103c 已登记 last-start-error.json(regenerable-exemption)');

  fs.rmSync(HOME_BASE, { recursive: true, force: true });
  console.log('\nSTART ERROR SURFACE E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})().catch(error => {
  console.error('START ERROR SURFACE E2E: FAIL');
  console.error(error.stack || error);
  process.exit(1);
});
