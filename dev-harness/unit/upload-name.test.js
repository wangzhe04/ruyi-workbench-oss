'use strict';
// 上传附件的文件名(代码走查 C8)。真源码、临时 HOME、真写盘。
// 修前:名字是「..」时 path.join 落到目录本身上 → EISDIR 500,报错原样带出数据目录绝对路径;name 不是字符串时
// path.basename 抛 TypeError → 500;每次失败都留下一个空的 uploads/<id>/ 目录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-upload-name-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { makeAttachmentRecord } = srv;
const data = Buffer.from('hello').toString('base64');

test('[U1] 「.」「..」、全是点和空格、空、非字符串 → upload.bin,文件真的写进 uploads/<id>/', async () => {
  for (const name of ['..', '.', ' . . ', '', null, 42, { a: 1 }, ['x']]) {
    const rec = await makeAttachmentRecord({ name, data });
    assert.equal(rec.name, 'upload.bin', `name=${JSON.stringify(name)} → ${rec.name}`);
    assert.equal(fs.readFileSync(rec.path, 'utf8'), 'hello');
    assert.equal(path.dirname(path.dirname(rec.path)), path.join(root, 'uploads'));
  }
});

test('[U2] 带路径的名字只取文件名(认 \\ 与 /),非法字符替换,结尾的点去掉', async () => {
  assert.equal((await makeAttachmentRecord({ name: 'C:\\Users\\me\\报告.md', data })).name, '报告.md');
  assert.equal((await makeAttachmentRecord({ name: '../../etc/passwd', data })).name, 'passwd');
  assert.equal((await makeAttachmentRecord({ name: 'a<b>c?.txt', data })).name, 'a_b_c_.txt');
  assert.equal((await makeAttachmentRecord({ name: 'notes.txt. ', data })).name, 'notes.txt');
});

test('[U3] 写失败时不留下空的 uploads/<id>/', async () => {
  const before = fs.readdirSync(path.join(root, 'uploads')).length;
  const fsp = require('fs/promises');
  const orig = fsp.writeFile;
  fsp.writeFile = async () => { throw Object.assign(new Error('ENOSPC: simulated'), { code: 'ENOSPC' }); };
  try { await assert.rejects(makeAttachmentRecord({ name: 'x.txt', data })); }
  finally { fsp.writeFile = orig; }
  assert.equal(fs.readdirSync(path.join(root, 'uploads')).length, before);
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
