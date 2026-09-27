'use strict';
// 常用文件夹去重不看结尾分隔符(代码走查 C14)。真源码 normalizeConfig,临时 HOME。
// 修前:服务端清洗只剥引号、去重只比小写 —— 同一个文件夹带不带结尾「\」存成两条,前端收藏里出现两行同名。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ws-sep-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const { normalizeConfig } = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

test('[W1] 带不带结尾分隔符是同一个常用文件夹', () => {
  const { config } = normalizeConfig({ workspaces: [{ path: 'C:\\Users\\me\\Projects' }, { path: 'C:\\Users\\me\\Projects\\' }, { path: 'c:\\users\\me\\projects\\\\' }] });
  assert.deepEqual(config.workspaces.map(w => w.path), ['C:\\Users\\me\\Projects']);
});

test('[W2] 存的时候去掉结尾分隔符;盘符根与 / 保留一个', () => {
  assert.equal(normalizeConfig({ defaultWorkspace: 'D:\\work\\' }).config.defaultWorkspace, 'D:\\work');
  const { config } = normalizeConfig({ workspaces: [{ path: 'C:\\' }, { path: 'E:\\\\' }, { path: '/' }, { path: '/home/me/' }] });
  assert.deepEqual(config.workspaces.map(w => w.path), ['C:\\', 'E:\\', '/', '/home/me']);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
