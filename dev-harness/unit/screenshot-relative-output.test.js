'use strict';
// Unit(走查 W1·F1):desktop_screenshot 的 outputPath 与 file_write 同一条解析链 ——
// 相对路径接在【会话工作区】下(不再落到服务进程 cwd),~ / %USERPROFILE% 先展开。
// 判据只看写闸的去留与报错里的 path(平台无关):越界的相对路径在 PowerShell 起来之前就被拒,
// 报出来的路径必须是「工作区 + 相对段」,不是进程 cwd 下的某个路径。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-shot-rel-unit-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { toolCall } = srv;
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });
const ctx = { sessionId: 'sess_shot_rel', session: { id: 'sess_shot_rel', cwd: ws }, workingDir: ws, config: { allowDesktopTools: true, permissionMode: 'default' } };

test('[F1] desktop_screenshot 相对 outputPath 按工作区解析:越界相对路径报的是工作区下的路径,不是进程 cwd 下的', async () => {
  const r = await toolCall('desktop_screenshot', { outputPath: '../escape-shot.png' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-allowed', `越界写恒拒(got ${JSON.stringify(r).slice(0, 200)})`);
  assert.equal(r.path, path.resolve(ws, '..', 'escape-shot.png'),
    `报出的路径应是工作区解析的结果;修前是 path.resolve('../escape-shot.png') 落到进程 cwd(${process.cwd()})`);
});

test('[F1] desktop_screenshot 工作区内的相对 outputPath 不再被判越界(非 Windows 上停在「只能在 Windows 使用」)', { skip: process.platform === 'win32' }, async () => {
  const r = await toolCall('desktop_screenshot', { outputPath: 'shots/inside.png' }, ctx);
  assert.notEqual(r.code, 'not-allowed', `工作区内的相对路径不该被写闸拒(got ${JSON.stringify(r).slice(0, 200)})`);
  assert.match(String(r.error || ''), /Windows/, '没有 PowerShell 的平台上,走到截图那一步才报「只能在 Windows 上使用」');
});

test('[F1] desktop_screenshot 的 ~ 先展开成家目录再过写闸(家目录在工作区外 → 拒,报展开后的真路径)', async () => {
  const r = await toolCall('desktop_screenshot', { outputPath: '~/home-shot.png' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not-allowed');
  assert.equal(r.path, path.join(os.homedir(), 'home-shot.png'), '不是工作区下一个叫「~」的文件夹');
});

test('[F1] desktop_screenshot 的 outputPath 含 NUL → bad_path 信封,不抛', async () => {
  const r = await toolCall('desktop_screenshot', { outputPath: 'a\0b.png' }, ctx);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'bad_path');
});
