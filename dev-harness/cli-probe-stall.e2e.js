#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(服务启动会导入真机 MCP 配置,见 lib 头注)
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间)
// 128f-⑬(48 号文;mission-index-scale (e)/(f) 取证时 CPU 剖面里挖出来的):读配置不再把整个服务钉住。
//
// 修前:defaultConfig()(normalizeConfig 在【每一次】readConfig 里都展开它)调 detectClaudePath() 与 detectKimiPath(),
// 两者按 60 s 记忆 —— 过期后的第一次读配置同步 spawnSync 一轮「<cli> --version」(每个候选最多等 4 s)。
// 探测期间事件循环整个被占住:别的请求、推送、计时器全部排队。本机剖面里一轮 1.2 s;装了真 CLI 的机器上每个
// 候选就是一次 node 冷启动。于是【大约每分钟一次】,赶上的那个请求(以及同时在飞的所有请求)平白慢一两秒。
// 修后:只有第一次(进程里还没有任何结果)同步探;过期之后先答旧值、后台异步重探,探完换上新值。
//
// 判据(真服务子进程;两支 CLI 都是合成的「慢 CLI」—— 各睡 SLOW_MS 再退出;PATH／APPDATA／LOCALAPPDATA／ProgramFiles
// 全指到临时目录,真机上装的 claude/kimi 一个都探不到;测试口把记忆期缩到 TTL_MS):
//   C1 首探照旧:/api/status 报出两支合成 CLI 的路径。
//   C2 过期之后那一发读配置不再被探测钉住:/api/status 本身、以及同时在打的 /health 都秒回(修前各 ≥ 2×SLOW_MS)。
//   C3 过期期间答的是旧值,不是空串(后台在探 ≠ 没探到)。
//   C4 后台那一轮真的换上了新结果:把 kimi 改成退出码 1(探测判它不可用)→ 过期后 detectedKimiPath 变成空串。
// 判定行:`CLI PROBE STALL E2E: ALL PASS`。
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const SLOW_MS = 1500;   // 每支合成 CLI 睡多久;修前过期那一发同步探两支 = 至少 3 s
const TTL_MS = 1000;    // 测试口:记忆期(产品里是 60 s)
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-128f13-'));
const HOME = path.join(WORK, 'home');
const BIN = path.join(WORK, 'bin');
const EMPTY = path.join(WORK, 'empty');   // APPDATA／LOCALAPPDATA／ProgramFiles 指到这里:安装位置候选一个都不存在
for (const d of [HOME, BIN, EMPTY]) fs.mkdirSync(d, { recursive: true });
const KIMI_BROKEN = path.join(WORK, 'kimi-broken.flag');
const slowCli = (name, flag) => {
  const file = path.join(BIN, name);
  // 睡 SLOW_MS 再退出;flag 文件存在时退出码 1(kimi 的探测只认 0,见 01-config probeAgentCliLauncher)。
  const script = `setTimeout(() => process.exit(require('fs').existsSync(process.argv[1]) ? 1 : 0), ${SLOW_MS})`;
  fs.writeFileSync(file, `@"${process.execPath}" -e "${script}" "${flag}"\r\n`);
  return file;
};
const CLAUDE_CLI = slowCli('claude-slow.cmd', path.join(WORK, 'claude-never.flag'));
const KIMI_CLI = slowCli('kimi-slow.cmd', KIMI_BROKEN);
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 13, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
  desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
}, null, 2));

const get = (port, p) => new Promise(resolve => {
  const t0 = Date.now();
  const req = http.get({ host: '127.0.0.1', port, path: p, timeout: 30000 }, res => {
    let body = '';
    res.on('data', d => { body += d; });
    res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch { /* 非 JSON */ } resolve({ status: res.statusCode, json, ms: Date.now() - t0 }); });
  });
  req.on('error', () => resolve({ status: 0, json: null, ms: Date.now() - t0 }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, ms: Date.now() - t0 }); });
});
const sameFile = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

(async () => {
  const port = await getFreePort();
  const sysDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const child = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(port)], {
    cwd: path.join(ROOT, 'ruyi-workbench', 'app'),
    env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME, HOME, USERPROFILE: HOME,
      PATH: sysDir, Path: sysDir, APPDATA: EMPTY, LOCALAPPDATA: EMPTY, ProgramFiles: EMPTY,
      CLAUDE_CLI_PATH: CLAUDE_CLI, KIMI_CLI_PATH: KIMI_CLI, WCW_TEST_CLI_PROBE_TTL_MS: String(TTL_MS) },
    windowsHide: true, stdio: 'ignore',
  });
  try {
    let health = null;
    for (let i = 0; i < 300 && !(health && health.status === 200); i++) { await sleep(100); health = await get(port, '/health'); }
    ok(Boolean(health) && health.status === 200, 'C0 服务起来了');
    const s1 = await get(port, '/api/status');
    ok(s1.status === 200 && sameFile(s1.json && s1.json.detectedClaudePath, CLAUDE_CLI) && sameFile(s1.json && s1.json.detectedKimiPath, KIMI_CLI),
      `C1 首探照旧:/api/status 报出两支合成 CLI(claude ${s1.json && s1.json.detectedClaudePath} / kimi ${s1.json && s1.json.detectedKimiPath})`);

    // 过期:之后第一发读配置就是修前被钉住的那一发。同时每 50 ms 打一发 /health,量事件循环有没有被占住。
    await sleep(TTL_MS + 500);
    let pinging = true;
    const pings = [];
    const pinger = (async () => { while (pinging) { pings.push((await get(port, '/health')).ms); await sleep(50); } })();
    const s2 = await get(port, '/api/status');
    await sleep(SLOW_MS * 2 + 800);   // 让后台那一轮(两支各 SLOW_MS)在测量窗里跑完:修后它不该占住循环
    pinging = false;
    await pinger;
    const worst = Math.max(0, ...pings);
    // 墙钟上界豁免：判的是「没被同步探测钉住」—— 钉住时至少 2×SLOW_MS（3 s），修后单跑几十毫秒，界取 SLOW_MS 的 2/3
    ok(s2.status === 200 && s2.ms < SLOW_MS * 2 / 3, `C2 过期之后那一发 /api/status 秒回(${s2.ms} ms;修前 ≥ ${SLOW_MS * 2} ms)`);
    ok(pings.length >= 5 && worst < SLOW_MS * 2 / 3, `C2b 同一时段 /health 也没被钉住(${pings.length} 发,最慢 ${worst} ms)`);
    ok(sameFile(s2.json && s2.json.detectedClaudePath, CLAUDE_CLI) && sameFile(s2.json && s2.json.detectedKimiPath, KIMI_CLI),
      `C3 过期期间答旧值,不是空串(claude ${s2.json && s2.json.detectedClaudePath} / kimi ${s2.json && s2.json.detectedKimiPath})`);

    // kimi 从此探测不通过(退出码 1):后台那一轮要把它换成空串。
    fs.writeFileSync(KIMI_BROKEN, 'broken');
    let s3 = null;
    for (let i = 0; i < 40; i++) {
      await sleep(400);
      s3 = await get(port, '/api/status');
      if (s3.json && !s3.json.detectedKimiPath) break;
    }
    ok(Boolean(s3 && s3.json) && s3.json.detectedKimiPath === '' && sameFile(s3.json.detectedClaudePath, CLAUDE_CLI),
      `C4 后台那一轮换上了新结果:kimi 不可用之后 detectedKimiPath 变空、claude 照旧(kimi「${s3 && s3.json && s3.json.detectedKimiPath}」)`);
  } catch (error) {
    fail++;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    killOwnTree(child.pid);
    await sleep(300);
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* Windows 句柄 */ }
  }
  console.log(fail === 0 ? 'CLI PROBE STALL E2E: ALL PASS' : `CLI PROBE STALL E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
