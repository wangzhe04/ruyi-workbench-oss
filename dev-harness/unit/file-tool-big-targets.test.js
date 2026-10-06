'use strict';
// Unit(走查 W1·F8 / F9):文件工具对「很大的已存在目标」先 stat、不整份读进内存;http_download 的 100MB 硬上限说清楚。
//   [B1] file_edit 对 >50MB 的文件:先 stat 就拒(不调 readFile),回结构化信封;>2GiB 的稀疏文件不再抛裸 ERR_FS_FILE_TOO_LARGE。
//   [B2] archive_zip 覆盖一个已存在的大 zip(>5MB 检查点上限):不读旧文件,只记 skippedBytes 标记,如实给 checkpointWarn。
//   [B3] http_download 覆盖已存在的大文件:同上。
//   [B4] archive_unzip overwrite:true 覆盖已存在的大文件:同上,批内体积记账不出 NaN。
//   [B5] 小文件(≤5MB)的旧内容仍整份进检查点(回滚可用)—— 行为不退化。
//   [B6] http_download:maxBytes 只能调低、不能超过 100MB;超限的 hint 按「是否已到硬上限」给不同的话;描述不再说「可调」。
// 判据是「readFile 有没有被调用在这个路径上」:在 fs/promises 上装卡子(服务里 fsp.readFile 是属性访问,卡子照样命中)。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = require('fs/promises');
const http = require('http');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-big-targets-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.WCW_TEST_ALLOW_LOOPBACK = '1';
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { toolCall } = srv;

const ws = path.join(root, 'ws');
fs.mkdirSync(ws, { recursive: true });
const sessionId = 'sess_big_targets';
const ctx = { sessionId, turnSeq: 1, session: { id: sessionId, cwd: ws }, workingDir: ws, config: { permissionMode: 'bypass' } };

const realReadFile = fsp.readFile;
let readPaths = [];
before(() => { fsp.readFile = function patched(p, ...rest) { readPaths.push(path.resolve(String(p))); return realReadFile.call(this, p, ...rest); }; });
after(() => { fsp.readFile = realReadFile; try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
const wasRead = p => readPaths.includes(path.resolve(p));
const MB = 1024 * 1024;

test('[B1] file_edit:>50MB 的文件先 stat 就拒,不整份读进内存', async () => {
  const f = path.join(ws, 'big-edit.txt');
  fs.writeFileSync(f, Buffer.alloc(51 * MB, 0x61));
  readPaths = [];
  const r = await toolCall('file_edit', { path: f, oldText: 'aaa', newText: 'bbb' }, ctx);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /50MB/);
  assert.equal(r.path, f);
  assert.equal(wasRead(f), false, '不该先把 51MB 整份读进内存');
  assert.equal(fs.statSync(f).size, 51 * MB, '文件没被动');
});

test('[B1] file_edit:>2GiB 的稀疏文件回信封,不抛裸 ERR_FS_FILE_TOO_LARGE', { skip: process.platform === 'win32' ? 'Windows 上扩 3GB 要真写盘' : false }, async () => {
  const f = path.join(ws, 'huge-sparse.bin');
  fs.writeFileSync(f, 'x');
  try { fs.truncateSync(f, 3 * 1024 * MB); } catch { return; /* 文件系统不支持稀疏大文件:跳过 */ }
  readPaths = [];
  const r = await toolCall('file_edit', { path: f, oldText: 'x', newText: 'y' }, ctx);
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 200));
  assert.match(String(r.error), /50MB/);
  assert.equal(wasRead(f), false);
  fs.rmSync(f, { force: true });
});

test('[B1] file_edit:小文件、不存在的文件、目录照旧', async () => {
  const f = path.join(ws, 'small-edit.txt');
  fs.writeFileSync(f, 'hello world\n');
  const ok = await toolCall('file_edit', { path: f, oldText: 'world', newText: 'there' }, ctx);
  assert.equal(ok.ok, true, JSON.stringify(ok).slice(0, 200));
  assert.equal(fs.readFileSync(f, 'utf8'), 'hello there\n');
  const nf = await toolCall('file_edit', { path: path.join(ws, 'nope.txt'), oldText: 'a', newText: 'b' }, ctx);
  assert.equal(nf.ok, false); assert.equal(nf.code, 'not_found');
  const dir = await toolCall('file_edit', { path: ws, oldText: 'a', newText: 'b' }, ctx);
  assert.equal(dir.ok, false); assert.ok(!/50MB/.test(String(dir.error)), JSON.stringify(dir).slice(0, 200));
});

test('[B2] archive_zip 覆盖已存在的大 zip:不读旧文件,checkpointWarn 如实说', async () => {
  const src = path.join(ws, 'zip-src.txt'); fs.writeFileSync(src, 'payload');
  const dest = path.join(ws, 'out.zip');
  fs.writeFileSync(dest, Buffer.alloc(6 * MB, 7));
  readPaths = [];
  const r = await toolCall('archive_zip', { paths: [src], dest }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.op, 'modify');
  assert.match(String(r.checkpointWarn || ''), /检查点|快照|撤销/, JSON.stringify(r).slice(0, 300));
  assert.equal(wasRead(dest), false, '旧 zip(6MB)不该被整份读进内存');
  assert.ok(fs.statSync(dest).size < MB, '新 zip 已写入');
});

test('[B5] archive_zip 覆盖已存在的小 zip:旧内容照旧进检查点(无 checkpointWarn)', async () => {
  const src = path.join(ws, 'zip-src2.txt'); fs.writeFileSync(src, 'payload2');
  const dest = path.join(ws, 'small-out.zip');
  fs.writeFileSync(dest, Buffer.from('old zip bytes'));
  readPaths = [];
  const r = await toolCall('archive_zip', { paths: [src], dest }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.checkpointWarn, undefined);
  assert.equal(wasRead(dest), true, '≤5MB 的旧内容要进检查点,仍需读');
});

function serve(handler) {
  return new Promise(resolve => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });
}

test('[B3] http_download 覆盖已存在的大文件:不读旧文件,checkpointWarn 如实说', async () => {
  const s = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end('new body'); });
  try {
    const dest = path.join(ws, 'dl-big.bin');
    fs.writeFileSync(dest, Buffer.alloc(6 * MB, 9));
    readPaths = [];
    const r = await toolCall('http_download', { url: `http://127.0.0.1:${s.address().port}/f`, dest }, ctx);
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.equal(r.op, 'modify');
    assert.match(String(r.checkpointWarn || ''), /检查点|快照|撤销/);
    assert.equal(wasRead(dest), false, '旧文件(6MB)不该被整份读进内存');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'new body');
  } finally { s.close(); }
});

test('[B4] archive_unzip overwrite 覆盖已存在的大文件:不读旧文件,批内记账不出 NaN', async () => {
  const zip = srv.zipWrite([{ name: 'big-target.bin', data: Buffer.from('from zip'), isDir: false }, { name: 'other.txt', data: Buffer.from('other'), isDir: false }]);
  const zipPath = path.join(ws, 'in.zip'); fs.writeFileSync(zipPath, zip);
  const outDir = path.join(ws, 'unzip-out'); fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, 'big-target.bin');
  fs.writeFileSync(target, Buffer.alloc(6 * MB, 3));
  readPaths = [];
  const r = await toolCall('archive_unzip', { src: zipPath, destDir: outDir, overwrite: true }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.match(String(r.checkpointWarn || ''), /检查点|快照|撤销/);
  assert.equal(wasRead(target), false, '旧文件(6MB)不该被整份读进内存');
  assert.equal(fs.readFileSync(target, 'utf8'), 'from zip');
  assert.equal(fs.readFileSync(path.join(outDir, 'other.txt'), 'utf8'), 'other');
});

test('[B6] http_download:maxBytes 只能调低;到硬上限后的 hint 指向别的办法,不再叫模型「增大 maxBytes」', async () => {
  const s = await serve((req, res) => {
    // 只发头:Content-Length 105MB 足以让「预拒」生效,不必真发 105MB
    res.writeHead(200, { 'content-length': String(105 * MB), 'content-type': 'application/octet-stream' });
    res.flushHeaders();
    setTimeout(() => res.destroy(), 300);
  });
  try {
    const url = `http://127.0.0.1:${s.address().port}/huge`;
    const dest = path.join(ws, 'never.bin');
    // 到顶:maxBytes 传了个比硬上限还大的值
    const a = await toolCall('http_download', { url, dest, maxBytes: 10 * 1024 * MB }, ctx);
    assert.equal(a.ok, false, JSON.stringify(a).slice(0, 300));
    assert.match(String(a.error), /100MB/);
    assert.match(String(a.error), /硬上限/, '说清传入的 maxBytes 被夹住了');
    assert.equal(a.maxBytesCap, 100 * MB);
    assert.match(String(a.hint), /硬上限/);
    assert.match(String(a.hint), /Invoke-WebRequest/);
    assert.doesNotMatch(String(a.hint), /增大/);
    // 没到顶:maxBytes 调低了 → 可以调大
    const b = await toolCall('http_download', { url, dest, maxBytes: 1 * MB }, ctx);
    assert.equal(b.ok, false);
    assert.match(String(b.error), /1MB/);
    assert.match(String(b.hint), /调大/);
    assert.match(String(b.hint), /100MB/);
    assert.equal(fs.existsSync(dest), false, '不落半截文件');
  } finally { s.closeAllConnections(); s.close(); }
});

test('[B6] http_download 的 schema 不再说 maxBytes「可调」', () => {
  const t = srv.buildOpenAiTools({ ...srv.defaultConfig(), toolLoadingMode: 'full', allowCommandTools: true }, null, { skillsEnabled: true }).find(x => x.function.name === 'http_download');
  assert.ok(t, '工具在 full 档里');
  assert.doesNotMatch(t.function.description, /maxBytes 可调/);
  assert.match(t.function.description, /maxBytes 只能调低/);
  assert.match(t.function.parameters.properties.maxBytes.description, /最多 100MB/);
});
