#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(服务启动会导入真机 MCP 配置,见 lib 头注)
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间)
// 128f-③(48 号文 §2-c):/api/status 不再等桌面组件的 Python 探测。
//
// 修前:状态路由在 computeHealth、generateMcpConfig、desktopMcp 三处 await 那趟异步预热 —— Full 包里它是内嵌 Python
// 导入 FastMCP,首个 /api/status 实测 8.7–8.9 s,整个界面(boot 的第一步就是它)跟着等;进程内缓存肯定结果只活 5 分钟,
// 所以隔 5 分钟以上的每一次启动都要付。
// 判据(真服务子进程;合成的桌面组件根目录;测试口让探测确定性地在飞 DELAY 毫秒;TMP 指到新目录绕开跨进程磁盘缓存):
//   P1 探测在飞时 /api/status 秒回(远小于 DELAY),desktopMcp.probing === true、detected/resolved 为 null;
//   P2 同一份响应里健康项 desktop-control 报既有的 preparing 态(不新造状态),mcpConfigPath 仍是那条路径;
//   P3 在飞期间 /health 也秒回(没有被同步探针钉住);
//   P4 探测完之后 /api/status 不再 probing,desktopMcp 的形状与改前一致(enabled/detected/resolved 三键,没有 probing 键)。
//   (不另判探测完之后的 desktop-control:「桥配上了、能力探测还没跑」也叫 preparing,同一句 detail,分不开。)
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePort } = require('./free-port.js');
const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'ruyi-workbench', 'app', 'server.js');
const DELAY = 6000;   // 门槛取它的一半(3 s):并行负载下 /api/status 也远在其内,反向(等探测)至少 DELAY
let fail = 0;
const ok = (c, label) => { if (c) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-128f3-'));
const HOME = path.join(WORK, 'home');
const TMP = path.join(WORK, 'tmp');             // 跨进程的 Python 探测磁盘缓存住在 os.tmpdir() —— 指到新目录 = 冷
const ACC = path.join(WORK, 'acc');             // 合成的桌面组件根:只要长得像(src/ai_computer_control/server.py)就会进探测计划
for (const d of [HOME, TMP, path.join(ACC, 'src', 'ai_computer_control')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(ACC, 'src', 'ai_computer_control', 'server.py'), '# synthetic stand-in for the desktop control component (128f-3 e2e)\n');
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 13, includeWorkbenchMcp: false, autoImportClaudeCodeMcp: false,
  desktopMcp: { enabled: true, command: '', args: [], cwd: '', autodetect: true },
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
const desktopHealth = status => ((status && status.json && status.json.health) || []).find(h => h && h.id === 'desktop-control') || null;

(async () => {
  const port = await getFreePort();
  const child = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(port)], {
    cwd: path.join(ROOT, 'ruyi-workbench', 'app'),
    env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME, TMP, TEMP: TMP,
      AI_COMPUTER_CONTROL_HOME: ACC, WCW_TEST_DESKTOP_PROBE_DELAY_MS: String(DELAY) },
    windowsHide: true, stdio: 'ignore',
  });
  try {
    let health = null;
    for (let i = 0; i < 200 && !(health && health.status === 200); i++) { await sleep(100); health = await get(port, '/health'); }
    ok(Boolean(health) && health.status === 200, 'P0 服务起来了');
    const s1 = await get(port, '/api/status');
    const dm1 = s1.json && s1.json.desktopMcp;
    // 墙钟上界豁免：界取测试口延时的一半（3 s）而非性能门 —— 反向（路由照旧等探测）实得 ≥ 5.4 s，修后单跑 0.2 s，离界十倍余量
    ok(s1.status === 200 && s1.ms < DELAY / 2 && Boolean(dm1) && dm1.probing === true && dm1.detected === null && dm1.resolved === null,
      `P1 探测在飞时 /api/status 秒回、desktopMcp.probing(${s1.ms} ms,探测至少还要 ${DELAY} ms;desktopMcp ${JSON.stringify(dm1)})`);
    const h1 = desktopHealth(s1);
    ok(Boolean(h1) && /^preparing\b/.test(String(h1.detail || '')) && h1.ok === false && /workbench\.mcp\.json$/.test(String(s1.json && s1.json.mcpConfigPath || '')),
      `P2 健康项 desktop-control 报既有的 preparing 态、mcpConfigPath 仍是那条路径(${JSON.stringify(h1)})`);
    const hz = await get(port, '/health');
    // 墙钟上界豁免：只判「没被同步探针钉住」—— 被钉住时是秒级（修前 detectDesktopMcp 同步一轮 ≥ 1.7 s），修后单跑 1 ms，界 1 s
    ok(hz.status === 200 && hz.ms < 1000, `P3 在飞期间 /health 也秒回(${hz.ms} ms)`);
    let s2 = null;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      s2 = await get(port, '/api/status');
      if (s2.json && s2.json.desktopMcp && !s2.json.desktopMcp.probing) break;
    }
    const dm2 = s2 && s2.json && s2.json.desktopMcp;
    ok(Boolean(dm2) && !('probing' in dm2) && ['enabled', 'detected', 'resolved'].every(k => k in dm2),
      `P4 探测完之后不再 probing,desktopMcp 形状与改前一致(${JSON.stringify(dm2 && Object.keys(dm2))})`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    killOwnTree(child);
    await sleep(300);
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 子进程刚停,文件句柄可能还没放 */ }
  }
  console.log(fail === 0 ? 'DESKTOP PROBE STATUS E2E: ALL PASS' : `DESKTOP PROBE STATUS E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
