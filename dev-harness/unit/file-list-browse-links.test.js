// Unit(前端走查 W1 · 第 3/9 条的服务端一半):file_list 的目录浏览(recursive:false)。
//
//   [L1] 指向目录的符号链接/联接(Windows 的 My Documents 之类)在浏览模式下标 directory —— 修前被标成 file,
//        前端点开报「is a directory」。Dirent 对链接报的是 isSymbolicLink() 而不是 isDirectory()。
//   [L2] 只改标记不下钻:递归列举不跟随符号链接(防环),链接仍按原样(file)出现、目标里的内容不重复出现;
//        循环链接(a/loop -> a)在两种模式下都不挂死、不无限递归。
//   [L3] 指向遍历根之外的链接照旧不返回(skippedLinks),指向文件的链接仍是 file,悬空链接不抛。
//   [L4] 浏览模式下链接目录也过一遍剪枝名单(名叫 node_modules 的目录链接不露出来)。
//   [L5] maxFiles:前端文件树请求 maxFiles:5000 —— 600 项的目录一次列全(默认 500 会截断且排后面的子文件夹消失);
//        撞顶时 truncated:true 带 hint(前端据此补「只列了前 N 项」一行)。
//
// 符号链接在 Linux 上可建(Windows 上无管理员/开发者模式建不了 dir symlink,本件在那边对应用例自动跳过;
// 目录联接 mklink /J 的行为同属「Dirent 报 isSymbolicLink」这一路,由 Windows CI 的 file-* 件覆盖)。
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-list-links-'));
const home = path.join(root, 'home');
const dataRootDir = path.join(home, '.ruyi-workbench');
fs.mkdirSync(dataRootDir, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataRootDir;
process.env.RUYI_HOME = dataRootDir;
const srv = require(process.env.WALK_TEST_SERVER || path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

let seq = 0;
function freshWs() { const ws = path.join(home, 'l' + (++seq)); fs.mkdirSync(ws, { recursive: true }); return ws; }
const ctxFor = ws => ({ sessionId: 'sess_list_links', turnSeq: 1, workingDir: ws, session: { id: 'sess_list_links', cwd: ws }, config: {} });
const put = (p, c = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); };
const norm = s => String(s).replace(/\\/g, '/');
const byRel = files => Object.fromEntries(files.map(f => [norm(f.relativePath), f]));

// 建不了符号链接的环境(Windows 无权限)整组跳过,而不是红。
function trySymlink(target, link, type) {
  try { fs.symlinkSync(target, link, type); return true; } catch { return false; }
}
const canLink = (() => {
  const probe = fs.mkdtempSync(path.join(root, 'probe-'));
  fs.mkdirSync(path.join(probe, 't'));
  return trySymlink(path.join(probe, 't'), path.join(probe, 'l'), 'dir');
})();
const linkIt = canLink ? it : it.skip;

const list = (ws, args) => srv.toolCall('file_list', { root: ws, absolute: true, ...args }, ctxFor(ws));

describe('[L1][L2][L3][L4] 目录浏览里的符号链接', () => {
  linkIt('[L1] 指向目录的链接:浏览模式标 directory,真目录仍是 directory,文件链接仍是 file', async () => {
    const ws = freshWs();
    put(path.join(ws, 'real', 'inside.txt'));
    put(path.join(ws, 'plain.txt'));
    assert.ok(trySymlink(path.join(ws, 'real'), path.join(ws, 'linkdir'), 'dir'));
    assert.ok(trySymlink(path.join(ws, 'plain.txt'), path.join(ws, 'linkfile.txt'), 'file'));
    const r = await list(ws, { recursive: false });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    const rel = byRel(r.files);
    assert.equal(rel.real.type, 'directory');
    assert.equal(rel.linkdir.type, 'directory', '链接目录在浏览模式下应标 directory(修前是 file)');
    assert.equal(rel['linkfile.txt'].type, 'file');
    assert.equal(rel['plain.txt'].type, 'file');
    // 点开链接目录:以它为 root 浏览能列出目标里的内容(前端就是这么展开的)
    const inner = await list(ws, { root: path.join(ws, 'linkdir'), recursive: false });
    assert.equal(inner.ok, true, JSON.stringify(inner).slice(0, 300));
    assert.deepEqual(inner.files.map(f => norm(f.relativePath)), ['inside.txt']);
  });

  linkIt('[L2] 递归列举不跟随链接:链接目录照旧是 file 条目,目标内容只出现一次(经真路径)', async () => {
    const ws = freshWs();
    put(path.join(ws, 'real', 'inside.txt'));
    assert.ok(trySymlink(path.join(ws, 'real'), path.join(ws, 'linkdir'), 'dir'));
    const r = await list(ws, { recursive: true });
    assert.equal(r.ok, true);
    const rels = r.files.map(f => norm(f.relativePath)).sort();
    assert.deepEqual(rels, ['linkdir', 'real', 'real/inside.txt']);
    assert.equal(byRel(r.files).linkdir.type, 'file', '递归模式不改标记(也就不会下钻)');
    assert.ok(!rels.some(p => p.startsWith('linkdir/')), '不经链接重复列出目标内容');
  });

  linkIt('[L2] 循环链接(a/loop -> a)两种模式都不挂死、不无限递归', async () => {
    const ws = freshWs();
    put(path.join(ws, 'a', 'f.txt'));
    assert.ok(trySymlink(path.join(ws, 'a'), path.join(ws, 'a', 'loop'), 'dir'));
    const deep = await list(ws, { recursive: true, maxDepth: 50 });
    assert.equal(deep.ok, true);
    assert.ok(deep.files.length < 10, '循环不应把条目滚雪球: ' + deep.files.length);
    const browse = await list(path.join(ws, 'a'), { recursive: false });
    assert.equal(browse.ok, true);
    assert.equal(byRel(browse.files).loop.type, 'directory');
    assert.equal(byRel(browse.files)['f.txt'].type, 'file');
  });

  linkIt('[L3] 指向根外的链接照旧不返回(skippedLinks);悬空链接不抛、仍是 file', async () => {
    const ws = freshWs();
    const outside = path.join(root, 'outside-' + seq);
    put(path.join(outside, 'secret.txt'));
    put(path.join(ws, 'ok.txt'));
    assert.ok(trySymlink(outside, path.join(ws, 'escape'), 'dir'));
    assert.ok(trySymlink(path.join(ws, 'nowhere'), path.join(ws, 'dangling'), 'dir'));
    const r = await list(ws, { recursive: false });
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    const rel = byRel(r.files);
    assert.ok(!('escape' in rel), '指向根外的目录链接不返回');
    assert.ok(r.files.length >= 1 && 'ok.txt' in rel);
    if ('dangling' in rel) assert.equal(rel.dangling.type, 'file');
  });

  linkIt('[L4] 浏览模式:名叫 node_modules 的目录链接过剪枝名单,不露出来', async () => {
    const ws = freshWs();
    put(path.join(ws, 'real', 'x.txt'));
    assert.ok(trySymlink(path.join(ws, 'real'), path.join(ws, 'node_modules'), 'dir'));
    const r = await list(ws, { recursive: false });
    assert.equal(r.ok, true);
    const rel = byRel(r.files);
    assert.ok(!('node_modules' in rel), JSON.stringify(Object.keys(rel)));
    assert.ok('real' in rel);
  });
});

describe('[L5] 目录浏览的 maxFiles', () => {
  it('600 项的目录:带 maxFiles:5000 一次列全(子文件夹不丢);不带则默认 500 截断', async () => {
    const ws = freshWs();
    for (let i = 0; i < 600; i++) fs.writeFileSync(path.join(ws, 'f' + String(i).padStart(4, '0') + '.txt'), 'x');
    fs.mkdirSync(path.join(ws, 'zzz-last-folder'));   // 排序在所有文件之后:默认 500 截断时它先消失
    const small = await list(ws, { recursive: false });
    assert.equal(small.ok, true);
    assert.equal(small.files.length, 500);
    assert.equal(small.truncated, true);
    assert.ok(!('zzz-last-folder' in byRel(small.files)), '默认 500 时排在后面的子文件夹消失(前端修前的现象)');
    const full = await list(ws, { recursive: false, maxFiles: 5000 });
    assert.equal(full.files.length, 601);
    assert.ok(!full.truncated, '没撞 5000 不该报 truncated');
    assert.equal(byRel(full.files)['zzz-last-folder'].type, 'directory');
  });

  it('撞 maxFiles 顶:truncated:true 且带 hint', async () => {
    const ws = freshWs();
    for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(ws, 'g' + String(i).padStart(3, '0') + '.txt'), 'x');
    const r = await list(ws, { recursive: false, maxFiles: 10 });
    assert.equal(r.files.length, 10);
    assert.equal(r.truncated, true);
    assert.equal(typeof r.hint, 'string');
  });

  it('目录读不了:信封回 ok:false + code(前端按 code 本地化),不是空列表', async () => {
    const ws = freshWs();
    const gone = await list(ws, { root: path.join(ws, 'does-not-exist'), recursive: false });
    assert.equal(gone.ok, false);
    assert.equal(gone.code, 'not_found');
    fs.mkdirSync(path.join(dataRootDir, 'sessions'), { recursive: true });
    const own = await list(ws, { root: path.join(dataRootDir, 'sessions'), recursive: false });   // 应用内部数据:文件工具一律拒
    assert.equal(own.ok, false);
    assert.equal(own.code, 'not-allowed');
  });
});
