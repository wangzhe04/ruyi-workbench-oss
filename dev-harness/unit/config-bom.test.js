'use strict';
// 走查 W1 #5:带 UTF-8 BOM 的 config.json(Windows 记事本「另存为 UTF-8」)不再被判成损坏。
// 修前 JSON.parse 对 BOM 抛 SyntaxError → readConfig 当「文件写坏了」:有 .prev 就回滚覆盖用户的编辑(不留任何备份),
// 没有 .prev 就进入降级、拒绝一切写入。
//   [B1] 带 BOM、无 .prev:读得出用户编辑,不降级(writeConfig 不抛 config.read_degraded);
//   [B2] 带 BOM、有 .prev:用户编辑留下,没有回滚到 .prev,也没有生成 .corrupt;
//   [B3] 真损坏(截断)+ 有 .prev:仍从 .prev 恢复,但覆盖前把坏文件另存成 config.json.corrupt;
//   [B4] 带 BOM 的文件之后再写配置,.prev 也照常刷新(写入侧同口径认 BOM)。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-config-bom-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const cfgFile = path.join(root, 'config.json');
const BOM = '﻿';
const ws = path.join(root, 'ws-bom');
fs.mkdirSync(ws, { recursive: true });

beforeEach(() => {
  for (const f of [cfgFile, cfgFile + '.prev', cfgFile + '.corrupt']) fs.rmSync(f, { force: true });
});

test('[B1] 带 BOM 的 config.json:读得出用户编辑,不降级', async () => {
  fs.writeFileSync(cfgFile, BOM + JSON.stringify({ defaultWorkspace: ws, permissionMode: 'plan' }, null, 2), 'utf8');
  const cfg = await srv.readConfig();
  assert.equal(cfg.defaultWorkspace, ws, '修前被当成损坏,读到的是默认值');
  assert.equal(cfg.permissionMode, 'plan');
  // 没有进入降级:写配置不抛 config.read_degraded。
  await assert.doesNotReject(() => srv.mutateConfig(c => { c.defaultWorkspace = ws; }));
  assert.ok(!fs.existsSync(cfgFile + '.corrupt'));
});

test('[B2] 带 BOM + 有 .prev:不回滚覆盖用户的编辑', async () => {
  fs.writeFileSync(cfgFile + '.prev', JSON.stringify({ defaultWorkspace: path.join(root, 'old-prev') }), 'utf8');
  fs.writeFileSync(cfgFile, BOM + JSON.stringify({ defaultWorkspace: ws }, null, 2), 'utf8');
  const cfg = await srv.readConfig();
  assert.equal(cfg.defaultWorkspace, ws, '修前:回滚到 .prev 的旧值');
  assert.ok(fs.readFileSync(cfgFile, 'utf8').includes(ws.replace(/\\/g, '\\\\')), '磁盘上仍是用户的版本');
  assert.ok(!fs.existsSync(cfgFile + '.corrupt'), '合法 JSON 不该被当成坏文件留底');
});

test('[B3] 真损坏 + 有 .prev:从 .prev 恢复并按明确加密选择保留 .corrupt', async () => {
  const prevWs = path.join(root, 'prev-ws');
  fs.mkdirSync(prevWs, { recursive: true });
  const broken = '{ "defaultWorkspace": "' + ws.replace(/\\/g, '\\\\') + '", "oops": ';   // 截断,不是合法 JSON
  for (const encryption of process.platform === 'win32' ? [false, true] : [false]) {
    fs.writeFileSync(cfgFile + '.prev', JSON.stringify({ defaultWorkspace: prevWs, credentialEncryptionV1: encryption }), 'utf8');
    fs.writeFileSync(cfgFile, broken, 'utf8');
    const cfg = await srv.readConfig();
    assert.equal(cfg.defaultWorkspace, prevWs, '仍从 .prev 恢复');
    const recovery = fs.readFileSync(cfgFile + '.corrupt', 'utf8');
    if (encryption) {
      assert.equal(JSON.parse(recovery).ruyiEncryptedBackupV1, 1, '显式开启后，损坏留底采用认证加密');
      assert.equal(await require('../lib/privacy-backup-fixture').recoverCorruptBackup(root), broken, '加密留底仍逐字恢复原始坏文件');
    } else {
      assert.equal(recovery, broken, '默认关闭时保持原始留底格式');
      assert.ok(!fs.existsSync(path.join(root, 'credential-vault-v1.json')), '默认关闭恢复不创建加密库');
    }
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(cfgFile, 'utf8')));
  }
});

test('[B4] 带 BOM 的文件之后再写配置,.prev 照常刷新成用户那一版', async () => {
  fs.writeFileSync(cfgFile, BOM + JSON.stringify({ defaultWorkspace: ws }, null, 2), 'utf8');
  await srv.mutateConfig(c => { c.runtimeHistoryReadDedupV1 = false; });
  const prev = fs.readFileSync(cfgFile + '.prev', 'utf8');
  assert.ok(prev.includes('ws-bom'), '.prev 是写入前那份(带 BOM 的用户版),不是更早的旧备份');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
