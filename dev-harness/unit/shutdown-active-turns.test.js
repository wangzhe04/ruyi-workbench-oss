'use strict';
// 走查 2026-10-08(13 cleanupMcp):关服收尾(exit / SIGINT / SIGTERM / uncaughtException)修前只停 MCP、shell、toolbox,
// activeChildren 里在途的 Claude / Kimi CLI 回合子进程没人管 —— 服务退了它们变孤儿,继续把当前回合跑完。
// 现在收尾逐个走 stopSession(id, 'shutdown')(13 stopAllActiveTurnsSync)。
//   [S1] 收尾原语:登记表里挂一个真子进程(长睡的 node)→ stopAllActiveTurnsSync 返回 1、登记表清空、子进程被杀;
//        一项抛错不拦后面的。跨平台(Windows 上 killChildTree 走 PowerShell 那一支)。
//   [S2] 真服务 + 假 CLI(WCW_FAKE_CLAUDE 指到一个记下 pid 后永不收尾的小脚本):回合在途时给服务发 SIGTERM →
//        服务退出后 CLI 子进程也没了。修前它活着(孤儿)。Windows 上外发 SIGTERM 是无条件终止、走不到收尾,跳过。
// 反向验证:RUYI_TEST_SERVER_JS 指到修前产物 → [S1] 因 stopAllActiveTurnsSync 不存在而红(ReferenceError);
// [S2] 用的是工作树里的 server.js,拿修前产物覆盖后跑会红(CLI 子进程活过服务)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-shutdown-turns-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
process.env.HOME = root;
process.env.USERPROFILE = root;
const { loadServerInternals } = require('../lib/server-internals');
const { killOwnTree } = require('../lib/kill-own-tree');
const { getFreePort } = require('../free-port.js');
const { stopAllActiveTurnsSync, activeChildren } = loadServerInternals(['stopAllActiveTurnsSync', 'activeChildren']);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const deadline = ms => new Promise(r => { const t = setTimeout(() => r(null), ms); if (t.unref) t.unref(); });   // 不拖住进程退出
const pidAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return Boolean(await fn()); }
const spawned = [];
after(() => { for (const c of spawned) { try { killOwnTree(c); } catch { /* gone */ } } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows 句柄迟放 */ } });

test('[S1] stopAllActiveTurnsSync:登记表里每一项都走 stopSession,子进程被杀、登记表清空、一项抛错不拦后面', async () => {
  const child = cp.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  spawned.push(child);
  const exited = new Promise(r => child.once('exit', () => r(true)));
  activeChildren.set('sess_shutdown_a', { child, pid: child.pid, state: 'running', startedAt: Date.now() });
  // 第二项:abort 抛错的原生引擎项 —— 收尾吞掉它,照样往下走
  let aborted = 0;
  activeChildren.set('sess_shutdown_b', { abort: () => { aborted += 1; throw new Error('boom'); }, state: 'running' });
  const stopped = stopAllActiveTurnsSync('shutdown');
  assert.equal(stopped, 2, '两项都算停了');
  assert.equal(aborted, 1, '原生引擎项的在途请求被 abort');
  assert.equal(activeChildren.size, 0, '登记表清空');
  const gone = await Promise.race([exited, deadline(15000)]);
  assert.equal(gone, true, 'CLI 子进程(整棵树)被杀');
});

test('[S2] 真服务回合在途时收到 SIGTERM → 退出后 CLI 子进程不留孤儿', { skip: process.platform === 'win32' ? 'Windows 上外发 SIGTERM 是无条件终止,走不到收尾' : false }, async () => {
  const home = path.join(root, 's2');
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  const pidFile = path.join(home, 'cli.pid');
  const hangCli = path.join(home, 'hang-cli.js');
  // 假 CLI:记下自己的 pid、吐一行 init,然后永不收尾(真 CLI 正跑着一个长回合)
  fs.writeFileSync(hangCli, [
    "const fs = require('fs');",
    `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'hang', tools: [], model: 'fake' }) + '\\n');",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 13, permissionMode: 'bypass', engineMode: 'print', defaultWorkspace: work, activeProvider: '',
    autoImportClaudeCodeMcp: false, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }, null, 2));
  const port = await getFreePort();
  const wbDir = path.resolve(__dirname, '../../ruyi-workbench');
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: wbDir, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: home, RUYI_HOME: home, HOME: home, USERPROFILE: home, WCW_FAKE_CLAUDE: hangCli },
  });
  spawned.push(wb);
  wb.stderr.on('data', () => {});
  const wbExited = new Promise(r => wb.once('exit', (code, signal) => r({ code, signal })));
  const health = () => new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, res => { res.resume(); res.on('end', () => resolve(res.statusCode === 200)); });
    r.on('error', () => resolve(false)); r.on('timeout', () => { r.destroy(); resolve(false); });
  });
  assert.ok(await waitUntil(health, 45000), '服务起来了');
  const raw = JSON.stringify({ message: '跑一个长回合', cwd: work });
  const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } }, res => { res.resume(); });
  req.on('error', () => { /* 服务退出时流被切断,预期 */ });
  req.end(raw);
  assert.ok(await waitUntil(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, 'utf8')) > 0, 30000), '回合起了 CLI 子进程');
  const cliPid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pidAlive(cliPid), 'CLI 子进程此刻活着');
  await sleep(300);
  process.kill(wb.pid, 'SIGTERM');
  const ex = await Promise.race([wbExited, deadline(15000)]);
  assert.ok(ex, '服务在 SIGTERM 后退出');
  const gone = await waitUntil(() => !pidAlive(cliPid), 5000);
  if (!gone) { try { process.kill(cliPid, 'SIGKILL'); } catch { /* gone */ } }
  assert.equal(gone, true, `服务退出后 CLI 子进程(pid ${cliPid})不该还活着(修前变孤儿)`);
});
