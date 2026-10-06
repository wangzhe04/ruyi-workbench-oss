'use strict';
// 走查 W1 #12 / #13(13u-migration-center)。真源码、临时 HOME / 数据根、零网络;未导出的内部函数经 lib/server-internals.js 取。
//   [T] TOML 子表:migrationTomlSection 只认精确的 [mcp_servers.<id>],Codex 常见的 [mcp_servers.<id>.env] 子表里的老包路径
//       解析侧(_parseTomlMcpServers)算进了改写项,这里却搜不到子表 → 改写不了(却被当成已应用 / 整体 nothing-applied)。
//       现在区间覆盖本段 + 以 <id>. 开头的全部子表,且不越界到别的服务器(foo 与 foobar / "foo.bar" 互不串)。
//   [U] 撤销:单个文件还原失败只 skipped++、照样写 undoneAt → 剩余部分再也撤不了(重试得 409 already-undone)。
//       现在有失败就不置 undoneAt:已还原的文件各自记 undoneAt、响应如实报 failed(500 undo-incomplete),修好原因后重试只做剩下的。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-migration-w1-'));
const home = path.join(root, 'home');
const data = path.join(root, 'data');
for (const d of [home, data, path.join(home, '.codex')]) fs.mkdirSync(d, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = data;
process.env.RUYI_HOME = data;
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.KIMI_CODE_HOME = path.join(home, '.kimi-code');
delete process.env.CODEX_HOME;
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.4.0', autoImportClaudeCodeMcp: false, activeProvider: '' }, null, 2));
const { loadServerInternals } = require('../lib/server-internals');
const { migrationTomlSections, migrationTomlReplace, migrationCollectRefs, migrationRewriteRefs, migrationUndo, readConfig, migrationCurrentRoot } = loadServerInternals([
  'migrationTomlSections', 'migrationTomlReplace', 'migrationCollectRefs', 'migrationRewriteRefs', 'migrationUndo', 'readConfig', 'migrationCurrentRoot',
]);

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); };
const read = file => fs.readFileSync(file, 'utf8');

// ───────────── [T] ─────────────
const TOML = [
  'model = "gpt-5"',
  '',
  '[mcp_servers.foo]',
  'command = "OLDPATH"',
  'args = ["OLDPATH/x.js"]',
  '',
  '[mcp_servers.foo.env]',
  'ROOT = "OLDPATH"',
  '',
  '[mcp_servers.foobar]',
  'command = "OLDPATH"',
  '',
  '[other]',
  'k = "OLDPATH"',
  '',
  '[mcp_servers."foo".tools.x]',
  'note = \'OLDPATH\'',
  '',
  '[[mcp_servers.foo.arr]]',
  'k = "OLDPATH"',
  '',
  '[mcp_servers."foo.bar"]',
  'command = "OLDPATH"',
].join('\n');

test('[T1] 区间覆盖本段 + 子表(含带引号的表头),不串到 foobar / other / 表数组 / "foo.bar"', () => {
  const ranges = migrationTomlSections(TOML, 'foo');
  const slices = ranges.map(r => TOML.slice(r.start, r.end));
  assert.equal(slices.length, 3, `本段 + [.env] + ["foo".tools.x](实际 ${slices.length})`);
  assert.ok(slices[0].includes('command = "OLDPATH"') && slices[0].includes('args ='), '本段');
  assert.ok(slices[1].includes('ROOT = "OLDPATH"'), 'env 子表');
  assert.ok(slices[2].includes("note = 'OLDPATH'"), '带引号表头的子表');
  for (const s of slices) assert.ok(!s.includes('[other]') && !s.includes('foobar') && !s.includes('[['), '区间止于下一个表头');
  assert.equal(migrationTomlSections(TOML, 'nope').length, 0);
  assert.equal(migrationTomlSections(TOML, 'foo.bar').length, 1, '带点号的 id 按引号段精确匹配');
});

test('[T2] 替换:本段与子表里的旧值都改,别的服务器不动', () => {
  const r = migrationTomlReplace(TOML, 'foo', 'OLDPATH', 'NEWPATH');
  const lines = r.text.split('\n');
  const at = prefix => lines.find(l => l.startsWith(prefix));
  assert.equal(at('command = "NEWPATH"') !== undefined, true, '本段 command');
  assert.equal(lines[lines.indexOf('[mcp_servers.foo.env]') + 1], 'ROOT = "NEWPATH"', 'env 子表(修前搜不到 → 改不了)');
  assert.equal(lines[lines.indexOf('[mcp_servers."foo".tools.x]') + 1], "note = 'NEWPATH'", '单引号样式保留');
  assert.equal(lines[lines.indexOf('[mcp_servers.foobar]') + 1], 'command = "OLDPATH"', 'foobar 不动');
  assert.equal(lines[lines.indexOf('[other]') + 1], 'k = "OLDPATH"', '别的表不动');
  assert.equal(lines[lines.indexOf('[[mcp_servers.foo.arr]]') + 1], 'k = "OLDPATH"', '表数组不是我们的段');
  assert.equal(lines[lines.indexOf('[mcp_servers."foo.bar"]') + 1], 'command = "OLDPATH"', '"foo.bar" 是另一个服务器');
  assert.equal(r.count, 3, 'command + env.ROOT + tools.x.note');
  const back = migrationTomlReplace(r.text, 'foo', 'NEWPATH', 'OLDPATH');
  assert.equal(back.text, TOML, '反向替换(撤销)逐字还原');
  assert.equal(back.count, 3);
  assert.deepEqual(migrationTomlReplace(TOML, 'nope', 'OLDPATH', 'X'), { text: TOML, count: 0 });
});

test('[T3] CRLF 文件与带行尾注释的表头同样认', () => {
  const crlf = '[mcp_servers.foo]\r\ncommand = "OLDPATH"\r\n\r\n[mcp_servers.foo.env]  # env\r\nROOT = "OLDPATH"\r\n[x]\r\nk = "OLDPATH"\r\n';
  const r = migrationTomlReplace(crlf, 'foo', 'OLDPATH', 'NEWPATH');
  assert.equal(r.count, 2);
  assert.equal(r.text, crlf.replace('command = "OLDPATH"', 'command = "NEWPATH"').replace('ROOT = "OLDPATH"', 'ROOT = "NEWPATH"'));
});

test('[T4] 端到端:Codex config.toml 的 env 子表里的老包路径被扫出来、改写落盘、撤销还原(单项也不再 nothing-applied)', async () => {
  const current = migrationCurrentRoot();
  const old = path.join(root, 'old', 'Ruyi-v1.0.0-full');
  write(path.join(old, 'app', 'server.js'), '// fake old\n');
  write(path.join(old, 'package.json'), JSON.stringify({ name: 'ruyi-workbench', version: '1.0.0' }));
  write(path.join(old, 'Start-Workbench.cmd'), '@echo off\r\n');
  const oldServer = path.join(old, 'app', 'server.js');
  const newServer = path.join(current, 'app', 'server.js');
  assert.ok(fs.existsSync(newServer), '当前包里有对应文件(改写目标存在)');
  const codexToml = path.join(home, '.codex', 'config.toml');
  // 只有 env 子表引用老包:修前这一项改写不了 → 整体 nothing-applied
  const original = `[mcp_servers.old-bridge]\ncommand = "node"\nargs = ["server.js"]\n\n[mcp_servers.old-bridge.env]\nRUYI_SERVER = "${oldServer}"\n`;
  write(codexToml, original);
  const refs = await migrationCollectRefs(await readConfig());
  const item = refs.find(r => r.kind === 'toml' && r.serverId === 'old-bridge');
  assert.ok(item, '扫到了子表里的引用');
  assert.equal(item.action, 'rewrite');
  assert.deepEqual(item.changes.map(c => c.field), ['env.RUYI_SERVER']);
  const applied = await migrationRewriteRefs([item.id]);
  assert.equal(applied.ok, true, `改写成功(修前:${JSON.stringify(applied.error)})`);
  assert.equal(applied.items, 1);
  assert.equal(read(codexToml), original.replace(oldServer, newServer), '子表里的路径改到当前包');
  const undone = await migrationUndo({});
  assert.equal(undone.ok, true);
  assert.equal(read(codexToml), original, '撤销还原成原样');
});

// ───────────── [U] ─────────────
const migDir = path.join(data, 'migrations');
function makeLog(id, files) {
  fs.mkdirSync(migDir, { recursive: true });
  fs.writeFileSync(path.join(migDir, id + '.json'), JSON.stringify({ schema: 1, id, createdAt: '2026-01-01T00:00:00.000Z', files }, null, 2));
}
const readLog = id => JSON.parse(read(path.join(migDir, id + '.json')));
const jsonItem = (serverId, from, to) => ({ serverId, container: ['mcpServers'], action: 'rewrite', changes: [{ field: 'command', from, to }] });

test('[U1] 部分文件还原失败:不置 undoneAt、如实报 failed;修好后重试只做剩下的,最后才算撤销完成', async () => {
  const id = '2099-01-01T00-00-00-000Z';
  const fileOk = path.join(root, 'u1-ok.json');
  const fileStuck = path.join(root, 'u1-stuck.json');
  write(fileOk, JSON.stringify({ mcpServers: { a: { command: 'NEW' } } }, null, 2));
  fs.mkdirSync(fileStuck);   // 读不动、写不进(EISDIR;Windows 上被占用 / 无权限同属「抛错」)
  makeLog(id, [
    { file: fileOk, kind: 'json', backup: '', items: [jsonItem('a', 'OLD', 'NEW')] },
    { file: fileStuck, kind: 'json', backup: '', items: [jsonItem('b', 'OLD', 'NEW')] },
  ]);

  const first = await migrationUndo({ id });
  assert.equal(first.ok, false, '有失败就不能报整体成功');
  assert.equal(first.error, 'undo-incomplete');
  assert.equal(first.status, 500);
  assert.equal(first.failed.length, 1, '失败的那个文件被点名');
  assert.match(first.failed[0].file, /u1-stuck\.json$/);
  assert.equal(first.restored, 1, '另一个文件已还原');
  assert.equal(JSON.parse(read(fileOk)).mcpServers.a.command, 'OLD', '能还原的照常还原');
  const mid = readLog(id);
  assert.equal(mid.undoneAt, undefined, '修前这里已写 undoneAt,剩余部分再也撤不了');
  assert.ok(mid.files[0].undoneAt && !mid.files[1].undoneAt, '已完成的文件各自带完成标记');

  // 修好原因(把目录换成它本该是的 JSON 文件),重试:只做剩下的
  fs.rmSync(fileStuck, { recursive: true });
  write(fileStuck, JSON.stringify({ mcpServers: { b: { command: 'NEW' } } }, null, 2));
  fs.writeFileSync(fileOk, JSON.stringify({ mcpServers: { a: { command: 'USER-CHANGED-AFTER' } } }));   // 已完成的文件重试时不得再碰
  const second = await migrationUndo({ id });
  assert.equal(second.ok, true, '重试成功(修前 409 already-undone)');
  assert.equal(second.restored, 1, '只还原剩下的那个文件');
  assert.equal(JSON.parse(read(fileStuck)).mcpServers.b.command, 'OLD');
  assert.equal(JSON.parse(read(fileOk)).mcpServers.a.command, 'USER-CHANGED-AFTER', '已完成的文件没被重复处理');
  const done = readLog(id);
  assert.ok(done.undoneAt, '全部完成才置 undoneAt');
  assert.deepEqual({ restored: done.undoResult.restored, skipped: done.undoResult.skipped }, { restored: 2, skipped: 0 }, 'undoResult 累计前后两轮');
  assert.equal(done.undoProgress, undefined, '临时进度账清掉');
  const third = await migrationUndo({ id });
  assert.deepEqual({ ok: third.ok, error: third.error, status: third.status }, { ok: false, error: 'already-undone', status: 409 }, '之后才是真的「已撤销」');
});

test('[U2] 全部成功的撤销形状不变(restored / skipped / 写 undoneAt);值被用户改过的按设计 skipped,不算失败', async () => {
  const id = '2099-01-02T00-00-00-000Z';
  const file = path.join(root, 'u2.json');
  write(file, JSON.stringify({ mcpServers: { a: { command: 'NEW' }, c: { command: 'SOMETHING-ELSE' } } }, null, 2));
  makeLog(id, [{ file, kind: 'json', backup: '', items: [jsonItem('a', 'OLD', 'NEW'), jsonItem('c', 'OLD', 'NEW')] }]);
  const r = await migrationUndo({ id });
  assert.equal(r.ok, true);
  assert.deepEqual({ restored: r.restored, skipped: r.skipped }, { restored: 1, skipped: 1 });
  assert.ok(readLog(id).undoneAt);
  assert.equal(JSON.parse(read(file)).mcpServers.c.command, 'SOMETHING-ELSE', '用户改过的值不动');
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
