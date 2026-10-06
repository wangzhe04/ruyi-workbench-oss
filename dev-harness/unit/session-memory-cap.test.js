'use strict';
// 走查 W1 #3:固定记忆的上限只有一个来源。
// 修前 /api/session/memories 按 memoryFixedSelectionMax(config)(默认 64,可调 [1,1024])接受保存,
// 而 02 normalizeSession 落盘清洗里写死 `cleaned.length >= 12` —— 保存回 ok、重载就只剩 12 条。
//   [C1] normalizeSession 保留 12 条以上(默认上限 64 条整份保留);
//   [C2] 上界与配置钳位同源:配置里把 memoryFixedSelectionMaxV1 调到天花板,normalizeSession 能留住同样多;
//   [C3] 端到端:64 条固定记忆经 saveSession → loadSession 往返不丢。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mem-cap-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));

const mems = n => Array.from({ length: n }, (_, i) => ({ id: 'mem_' + String(i).padStart(4, '0'), scope: 'global' }));

test('[C1] normalizeSession 不再把固定记忆截成 12 条', () => {
  const { session: s } = srv.normalizeSession({ id: 'sess_a', memoriesExplicit: true, memories: mems(40) });
  assert.equal(s.memories.length, 40, '修前恒为 12');
  assert.equal(s.memories[39].id, 'mem_0039');
});

test('[C2] 上界与配置钳位同源:配置天花板 = normalizeSession 的保留上限', async () => {
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ memoryFixedSelectionMaxV1: 999999 }));
  const cfg = await srv.readConfig();
  const ceiling = cfg.memoryFixedSelectionMaxV1;   // 钳位后的最大值(1024)
  assert.ok(ceiling > 64, '配置钳位上界应远大于默认 64');
  const { session: s } = srv.normalizeSession({ id: 'sess_b', memoriesExplicit: true, memories: mems(ceiling + 50) });
  assert.equal(s.memories.length, ceiling, '路由按配置最多接受多少条,清洗就最多留多少条');
  // 默认配置(64)下保存 64 条:不被清洗截断。
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({}));
  const def = await srv.readConfig();
  assert.equal(def.memoryFixedSelectionMaxV1, 64);
  assert.equal(srv.normalizeSession({ id: 'sess_c', memoriesExplicit: true, memories: mems(64) }).session.memories.length, 64);
});

test('[C3] 64 条固定记忆 saveSession → loadSession 往返不丢', async () => {
  const created = await srv.createSession({ title: 'mem', cwd: root });
  const live = await srv.loadSession(created.id);
  live.memories = mems(64);
  live.memoriesExplicit = true;
  await srv.saveSession(live);
  const back = await srv.loadSession(created.id);
  assert.equal(back.memories.length, 64, '重载后被截成 12 是修前的症状');
  assert.equal(back.memoriesExplicit, true);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
