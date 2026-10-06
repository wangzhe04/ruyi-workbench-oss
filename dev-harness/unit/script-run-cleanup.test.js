'use strict';
// Unit(走查 W1·F10):script_run 的脚本明文不再在 <data>/generated/scripts 里留着(模型嵌进脚本的密钥)。
//   [S1] node 脚本:运行期间文件在(解释器读得到);结果返回后文件已删;generated/scripts 里没有残留。
//   [S2] 脚本超时被杀 / 脚本报错退出:同样删。
//   [S3] python 脚本(本机有 python 才跑)与 powershell 分支(非 Windows 回 windows_only 也要删)。
//   [S4] 按龄清扫 sweepStaleScriptFiles:超过 24h 的孤儿删,新的、子目录不动。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-script-cleanup-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { toolCall, dispatchTestHooks } = srv;
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });
const ctx = { sessionId: 'sess_script_cleanup', session: { id: 'sess_script_cleanup', cwd: ws }, workingDir: ws, config: { permissionMode: 'bypass', allowCommandTools: true } };
const scriptsDir = () => path.join(process.env.RUYI_HOME, 'generated', 'scripts');
const leftovers = () => { try { return fs.readdirSync(scriptsDir()); } catch { return []; } };
const SECRET = 'sk-test-' + 'S3cretValue' + '123456789';

test('[S1] node 脚本:运行期间文件在,结束后删掉,不留带密钥的明文', async () => {
  const code = `const fs = require('fs'); console.log(JSON.stringify({ file: __filename, existsWhileRunning: fs.existsSync(__filename) })); const k = '${SECRET}';`;
  const r = await toolCall('script_run', { language: 'node', code }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  const seen = JSON.parse(String(r.stdout).trim());
  assert.equal(seen.existsWhileRunning, true, '运行期间脚本文件必须在');
  assert.ok(seen.file.startsWith(scriptsDir()), `脚本落在 generated/scripts(${seen.file})`);
  assert.equal(fs.existsSync(seen.file), false, '返回之后脚本文件已删');
  assert.deepEqual(leftovers(), [], 'generated/scripts 里没有残留');
});

test('[S2] 超时被杀与脚本报错退出:同样删', async () => {
  const hang = await toolCall('script_run', { language: 'node', code: `setInterval(() => {}, 1000); // ${SECRET}`, timeoutMs: 1000 }, ctx);
  assert.equal(hang.timedOut, true, JSON.stringify(hang).slice(0, 300));
  const boom = await toolCall('script_run', { language: 'node', code: `throw new Error('boom ${SECRET}')` }, ctx);
  assert.equal(boom.ok, false);
  assert.deepEqual(leftovers(), [], '超时 / 报错之后 generated/scripts 里没有残留');
});

const havePython = (() => { for (const c of process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) { try { if (cp.spawnSync(c, ['--version']).status === 0) return true; } catch { /* next */ } } return false; })();
test('[S3] python 脚本删掉', { skip: havePython ? false : '本机没有 python' }, async () => {
  const r = await toolCall('script_run', { language: 'python', code: `import os\nprint(os.path.exists(__file__))  # ${SECRET}\n` }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.match(String(r.stdout), /True/);
  assert.deepEqual(leftovers(), []);
});

test('[S3] powershell 分支:没有 PowerShell 的平台回 windows_only 也不留脚本', { skip: process.platform === 'win32' ? 'Windows 上走真 PowerShell' : false }, async () => {
  const r = await toolCall('script_run', { code: `Write-Output '${SECRET}'` }, ctx);
  assert.equal(r.ok, false);
  assert.deepEqual(leftovers(), []);
});

test('[S4] sweepStaleScriptFiles:按龄清孤儿,新文件与子目录不动', async () => {
  fs.mkdirSync(path.join(scriptsDir(), 'keep-dir'), { recursive: true });
  const stale = path.join(scriptsDir(), 'script_old.ps1');
  const fresh = path.join(scriptsDir(), 'script_new.js');
  const nested = path.join(scriptsDir(), 'keep-dir', 'old-in-subdir.txt');
  for (const f of [stale, fresh, nested]) fs.writeFileSync(f, SECRET);
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  fs.utimesSync(stale, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(nested, twoDaysAgo, twoDaysAgo);
  const removed = await dispatchTestHooks.sweepStaleScriptFiles();
  assert.equal(removed, 1);
  assert.equal(fs.existsSync(stale), false, '超龄孤儿被删');
  assert.equal(fs.existsSync(fresh), true, '新文件不动(可能正在跑)');
  assert.equal(fs.existsSync(nested), true, '只扫 scripts/ 这一层的普通文件');
  assert.equal(await dispatchTestHooks.sweepStaleScriptFiles(Date.now() + 3 * 24 * 3600 * 1000), 1, '再过三天:新文件也成了孤儿');
  assert.equal(fs.existsSync(fresh), false);
});

test('[S4] scripts 目录不存在:清扫静默返回 0', async () => {
  fs.rmSync(scriptsDir(), { recursive: true, force: true });
  assert.equal(await dispatchTestHooks.sweepStaleScriptFiles(), 0);
});
