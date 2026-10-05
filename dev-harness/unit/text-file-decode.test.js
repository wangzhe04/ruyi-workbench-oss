'use strict';
// Unit(走查 W1·F4):附件 textPreview / 文件预览用的 00-boot decodeTextFileBytes 按内容判编码。
//   [D1] makeAttachmentRecord 的 textPreview:GBK、UTF-16LE/BE(带 BOM)、UTF-8、UTF-8 BOM、坏字节(宽松)各解对。
//   [D2] 差分:decodeTextFileBytes 与 11b FileTextIo.decodeBuffer(buf,'auto') 在一张字节样本网格上逐格同输出
//        (两处判据同口径,改一边必须同改另一边;本函数住 00-boot 是因为基础层不能引用工具层的 11b)。
//        两个函数都从源码里切出来单独求值(11b 是零出边叶子,decodeTextFileBytes 自包含),不新增 server.js 导出。
//   [D3] 截断前缀(complete=false)与整份(complete=true)的区别:前缀切在汉字中间不误判成 GBK、也不留半个字符的 U+FFFD。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-text-decode-unit-'));
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

// 11b 是零出边的叶子模块:单独求值就能拿到 FileTextIo(只需要 require)。
const FileTextIo = vm.runInNewContext(fs.readFileSync(path.join(SRC, '11b-file-text-io.js'), 'utf8') + '\nFileTextIo', { require, Buffer, TextDecoder, process, console });
// 00-boot 里 decodeTextFileBytes 是一个自包含函数:从源码切出来单独求值,用来直测 complete=false(附件路径只会传 true)。
const bootSrc = fs.readFileSync(path.join(SRC, '00-boot.js'), 'utf8');
const fnStart = bootSrc.indexOf('function decodeTextFileBytes(');
const fnEnd = bootSrc.indexOf('\nfunction createNdjsonLineFeeder(', fnStart);
assert.ok(fnStart > 0 && fnEnd > fnStart, '能从 00-boot 切出 decodeTextFileBytes');
const decodeTextFileBytes = vm.runInNewContext(bootSrc.slice(fnStart, fnEnd) + '\ndecodeTextFileBytes', { Buffer, TextDecoder });

const GBK_HELLO = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0xa3, 0xac, 0xca, 0xc0, 0xbd, 0xe7]);   // GBK:你好,世界
const u16le = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(s, 'utf16le')]);
const u16be = (s, bom = true) => Buffer.concat([bom ? Buffer.from([0xfe, 0xff]) : Buffer.alloc(0), Buffer.from(s, 'utf16le').swap16()]);
const preview = async (name, buf) => (await srv.makeAttachmentRecord({ name, data: buf.toString('base64') })).textPreview;

test('[D1] makeAttachmentRecord 的 textPreview 按内容判编码', async () => {
  assert.equal(await preview('gbk.txt', GBK_HELLO), '你好，世界', 'GBK');
  assert.equal(await preview('gbk-mixed.csv', Buffer.concat([Buffer.from('id,name\n1,'), GBK_HELLO, Buffer.from('\n')])), 'id,name\n1,你好，世界\n', 'ASCII 与 GBK 混排');
  assert.equal(await preview('u16le.csv', u16le('名称,数量\r\n苹果,3\r\n')), '名称,数量\r\n苹果,3\r\n', 'UTF-16LE BOM');
  assert.equal(await preview('u16be.txt', u16be('你好 world')), '你好 world', 'UTF-16BE BOM');
  assert.equal(await preview('utf8.md', Buffer.from('# 标题\n正文\n')), '# 标题\n正文\n', 'UTF-8');
  assert.equal(await preview('bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('带BOM')])), '﻿带BOM', 'UTF-8 BOM 留在文本里(修前口径)');
  assert.equal(await preview('ascii.json', Buffer.from('{"a":1}')), '{"a":1}');
  assert.equal(await preview('empty.txt', Buffer.alloc(0)), '');
  const bad = await preview('bad.txt', Buffer.from([0x61, 0xff, 0xff, 0x62, 0x80]));
  assert.ok(bad.startsWith('a') && bad.includes('�') && bad.includes('b'), `既非 UTF-8 也非 GBK:宽松解码(got ${JSON.stringify(bad)})`);
  const long = '汉'.repeat(20000);
  assert.equal((await preview('long.txt', Buffer.from(long))).length, 12000, '仍截到 12000 字符');
});

test('[D2] 差分:decodeTextFileBytes(buf, true) === FileTextIo.decodeBuffer(buf, "auto").text', () => {
  const grid = [
    ['空', Buffer.alloc(0)],
    ['ASCII', Buffer.from('plain ascii\r\nline2')],
    ['UTF-8 中文', Buffer.from('中文 UTF-8 文本 😀')],
    ['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM 文本')])],
    ['UTF-16LE BOM', u16le('UTF-16LE 文本 😀')], ['UTF-16BE BOM', u16be('UTF-16BE 文本')],
    ['UTF-16LE 无 BOM(不嗅探,按 UTF-8/GBK 走)', u16le('abc', false)],
    ['GBK', GBK_HELLO], ['GBK 带 ASCII', Buffer.concat([Buffer.from('k='), GBK_HELLO, Buffer.from(';')])],
    ['GB18030 四字节', Buffer.from([0x81, 0x30, 0x81, 0x30, 0x20, 0x41])],
    ['坏字节', Buffer.from([0x61, 0xff, 0xfe, 0x62])], ['孤立续字节', Buffer.from([0x80, 0x80, 0x80])],
    ['半个 UTF-8 字(整份视为非法)', Buffer.from([0x61, 0xe4, 0xb8])],
    ['1 字节 0xFF', Buffer.from([0xff])], ['仅 UTF-16 BOM', Buffer.from([0xff, 0xfe])], ['奇数字节 UTF-16LE', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ab', 'utf16le'), Buffer.from([0x41])])],
  ];
  // 再加一批确定性的随机字节串(固定种子)。
  let seed = 0x1234abcd;
  const rnd = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const len = 1 + rnd(24);
    const bytes = Buffer.alloc(len);
    for (let k = 0; k < len; k++) bytes[k] = rnd(5) === 0 ? 0x80 + rnd(0x80) : 0x20 + rnd(0x5f);
    grid.push(['随机#' + i, bytes]);
  }
  for (const [label, buf] of grid) {
    const want = FileTextIo.decodeBuffer(buf, 'auto').text;
    assert.equal(decodeTextFileBytes(buf, true), want, `${label}: ${buf.toString('hex')}`);
  }
});

test('[D3] 截断前缀(complete=false):切在多字节字符中间既不误判成 GBK、也不留半个字符的 U+FFFD', () => {
  const full = Buffer.from('中'.repeat(10));   // 30 字节
  const cut = full.subarray(0, 28);             // 切在第 10 个字(E4 B8 AD)的第 2 个字节之后
  assert.equal(decodeTextFileBytes(cut, false), '中'.repeat(9), '前缀按「前缀」解:只留完整的 9 个字');
  assert.notEqual(decodeTextFileBytes(cut, true), '中'.repeat(9), '同一份字节若当成完整文件,会走到非法分支(自检:两种口径确实不同)');
  assert.equal(decodeTextFileBytes(u16le('你好世界').subarray(0, 8), false), '你好世', 'UTF-16LE 前缀切在字中间:丢掉不成对的字节');
  assert.equal(decodeTextFileBytes(GBK_HELLO, false), '你好，世界', '前缀恰好是完整的 GBK 也照常解');
});
