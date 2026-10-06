'use strict';
/*
 * E2E(Windows 真跑):Start-Workbench.cmd 的 node 回落路径,在【带空格的安装目录】里真的把 node 起起来,
 * 而且 server.js 路径没有被空格劈成两个参数。
 *
 * 为什么需要它:启动器回落路径(没有 RuyiDesktop.exe / WebView2Loader.dll 时)用
 *   Start-Process -FilePath $env:RUYI_NODE -ArgumentList @($env:RUYI_SERVER,'serve','--open')
 * 起 node。Windows PowerShell 5.1 对【数组形式】的 -ArgumentList 只用空格拼接、不给含空格的元素补引号(官方文档要求自己加转义引号),
 * 装在 `C:\Program Files\Ruyi` 这类目录时 node 收到的是 `C:\Program` 与 `Files\Ruyi\app\server.js`,隐藏启动失败且没有任何提示。
 * 旧注释与 start-experience.static.e2e.js 只做静态字符串断言,却声称「带空格目录不会劈参数」—— 从来没有真跑过。
 * 现在改为单个已加引号的参数串,本件在真 cmd.exe + 真 PowerShell 上跑一遍:带空格目录下启动器执行完,
 * 桩 server.js 收到的 argv 恰好是 ['serve','--open'],且 __filename 是完整路径。
 *
 * 非 Windows 平台直接跳过(cmd.exe / Windows PowerShell 才有这个行为)。不起任何网络服务。
 * 判定行:`LAUNCHER SPACED PATH E2E: ALL PASS`。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createRunner } = require('./lib/harness');

const t = createRunner('LAUNCHER SPACED PATH');
const { ok } = t;
const ROOT = path.resolve(__dirname, '..');
const LAUNCHER_SRC = path.join(ROOT, 'ruyi-workbench', 'Start-Workbench.cmd');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(pred, limitMs) {
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(100);
  }
  return pred();
}

(async () => {
  if (process.platform !== 'win32') {
    console.log('SKIP launcher spaced-path: Windows only (cmd.exe + Windows PowerShell 5.1)');
    t.done();
    return;
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi launcher '));      // 目录名带空格
  const pkg = path.join(base, 'Program Files', 'Ruyi Test');                  // 再嵌一层带空格的
  try {
    fs.mkdirSync(path.join(pkg, 'app'), { recursive: true });
    fs.mkdirSync(path.join(pkg, 'runtime', 'node'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'spaced-path-stub', version: '0.0.0' }));
    // 桩 server.js:把收到的参数与自己的路径写成 marker.json 就退出(不起任何服务)。
    fs.writeFileSync(path.join(pkg, 'app', 'server.js'),
      "require('fs').writeFileSync(require('path').join(__dirname, '..', 'marker.json'), JSON.stringify({ argv: process.argv.slice(2), script: __filename }));\n");
    fs.copyFileSync(process.execPath, path.join(pkg, 'runtime', 'node', 'node.exe'));
    const launcher = path.join(pkg, 'Start-Workbench.cmd');
    fs.copyFileSync(LAUNCHER_SRC, launcher);
    // 刻意没有 RuyiDesktop.exe / WebView2Loader.dll:走 node 回落路径。
    ok(!fs.existsSync(path.join(pkg, 'RuyiDesktop.exe')), 'L0 夹具里没有桌面壳,启动器只能走 node 回落路径');

    const run = cp.spawnSync('cmd.exe', ['/d', '/c', launcher], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    ok(run.status === 0, `L1 启动器正常退出(退出码 ${run.status};stderr=${String(run.stderr || '').trim().slice(0, 200)})`);

    const marker = path.join(pkg, 'marker.json');
    const arrived = await waitFor(() => fs.existsSync(marker), 30000);
    ok(arrived, 'L2 带空格的安装目录下,隐藏启动的 node 真的跑了 server.js(marker.json 出现)');
    if (arrived) {
      let seen = null;
      await waitFor(() => { try { seen = JSON.parse(fs.readFileSync(marker, 'utf8')); return true; } catch { return false; } }, 5000);
      ok(seen && JSON.stringify(seen.argv) === JSON.stringify(['serve', '--open']),
        `L3 server.js 收到的参数恰好是 serve --open,路径没被空格劈成两个参数(实得 ${JSON.stringify(seen && seen.argv)})`);
      ok(seen && seen.script === path.join(pkg, 'app', 'server.js'), `L4 脚本路径完整(实得 ${seen && seen.script})`);
    }
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 桩 node 可能还没完全退出:留给系统临时目录清理 */ }
  }
  t.done();
})();
