'use strict';
// 隐私 M4:OOXML/ODF 隐藏层的拒绝面 —— 判据在解析器里(resources/native-file-read.py):
//   · 只看部件名就能认的:宏(vbaProject.bin)、嵌入对象(*/embeddings/*)、批注(comments*.xml /
//     ppt/comments/* / xl/threadedComments/*)、ActiveX(word/activeX/*)、词汇表正文(word/glossary/document.xml);
//   · 要看解析结果才能认的:WordprocessingML 的 {w}ins/{w}del(修订)、ODF 的 text:tracked-changes /
//     office:annotation。
// 两条误伤是用真实语料换来的(2026-11-05 复审实测),这里各留一条回归:
//   · customXml/* 是 Word 的参考文献源(52% 的真实 docx 都有,工作台自己的 write_document 也产),
//     不能当隐藏层 —— 否则写完就读不回来;
//   · DrawingML 自定义几何里的 <a:moveTo> 是画路径,不是修订,不能按 local name 判。
// 夹具是纯 JS 现造的 ZIP(store 不压缩,自带 CRC32),完全离线。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-ooxml-hidden-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['FileVisualIo']);
const HELPER = path.resolve(__dirname, '../../ruyi-workbench/resources/native-file-read.py');

function python() {
  for (const [exe, pre] of [['python', []], ['py', ['-3']], ['python3', []]]) {
    try {
      const r = cp.spawnSync(exe, [...pre, '-c', 'import zipfile, xml.etree.ElementTree'], { windowsHide: true, timeout: 20000 });
      if (r.status === 0) return true;
    } catch { /* try next */ }
  }
  return false;
}
const skip = python() ? false : 'python unavailable';

// ── 最小 ZIP 写入(store,不压缩)────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c; }
  return table;
})();
const crc32 = buf => { let c = ~0; for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8); return (~c) >>> 0; };
function zip(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const payload = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const crc = crc32(payload);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8); local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(payload.length, 18); local.writeUInt32LE(payload.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, payload);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(0, 10); dir.writeUInt16LE(0, 12); dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16); dir.writeUInt32LE(payload.length, 20); dir.writeUInt32LE(payload.length, 24);
    dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += 30 + name.length + payload.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const docXml = body => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`;
const PARAGRAPH = '<w:p><w:r><w:t>季度报告正文</w:t></w:r></w:p>';
const docx = extra => zip([{ name: 'word/document.xml', data: docXml(PARAGRAPH) }, ...extra]);
const write = (name, bytes) => { const p = path.join(root, name); fs.writeFileSync(p, bytes); return p; };
const refused = async (file, expected) => {
  const r = await app.FileVisualIo.document(file, {}, HELPER);
  assert.equal(r.code, 'document_hidden_content', JSON.stringify(r).slice(0, 240));
  assert.ok(r.found.includes(expected), 'found=' + JSON.stringify(r.found));
  return r;
};

test('干净 docx 照常读出(判据不误拒)', { skip }, async () => {
  const r = await app.FileVisualIo.document(write('clean.docx', docx([])), {}, HELPER);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.match(String(r.content || ''), /季度报告正文/);
});

test('回归:customXml 参考文献源不当隐藏层(Word 与 python-docx 都默认带它)', { skip }, async () => {
  const bytes = docx([
    { name: 'customXml/item1.xml', data: '<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography" SelectedStyle="APA"/>' },
    { name: 'customXml/itemProps1.xml', data: '<ds:datastoreItem xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml" ds:itemID="{1}"/>' },
  ]);
  const r = await app.FileVisualIo.document(write('biblio.docx', bytes), {}, HELPER);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
});

test('回归:DrawingML 的 <a:moveTo> 不是修订(pptx 照常读出)', { skip }, async () => {
  const slide = `<?xml version="1.0"?><p:sld xmlns:p="${P}" xmlns:a="${A}"><p:cSld><p:spTree><a:custGeom><a:pathLst><a:path><a:moveTo><a:pt x="0" y="0"/></a:moveTo></a:path></a:pathLst></a:custGeom><p:sp><p:txBody><a:p><a:r><a:t>图表说明</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
  const bytes = zip([
    { name: 'ppt/presentation.xml', data: `<p:presentation xmlns:p="${P}"/>` },
    { name: 'ppt/slides/slide1.xml', data: slide },
  ]);
  const r = await app.FileVisualIo.document(write('geometry.pptx', bytes), {}, HELPER);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
});

test('带批注 / 宏 / 嵌入对象 / ActiveX / 词汇表正文 → 各自被拒', { skip }, async () => {
  const cases = [
    ['comments.docx', [{ name: 'word/comments.xml', data: `<w:comments xmlns:w="${W}"/>` }], 'comments'],
    ['macro.docx', [{ name: 'word/vbaProject.bin', data: Buffer.from([1, 2, 3]) }], 'macros'],
    ['embedded.docx', [{ name: 'word/embeddings/oleObject1.bin', data: Buffer.from([0, 1, 2]) }], 'embedded-objects'],
    ['activex.docx', [{ name: 'word/activeX/activeX1.bin', data: Buffer.from([9, 9]) }], 'activex'],
    ['glossary.docx', [{ name: 'word/glossary/document.xml', data: docXml(PARAGRAPH) }], 'glossary'],
  ];
  for (const [name, extra, expected] of cases) await refused(write(name, docx(extra)), expected);
});

test('修订只认 WordprocessingML 命名空间({w}ins / {w}del / {w}moveFrom / {w}moveTo)', { skip }, async () => {
  for (const tag of ['ins', 'del', 'moveFrom', 'moveTo']) {
    const body = `<w:p><w:${tag} w:id="1" w:author="a" w:date="2026-01-01T00:00:00Z"><w:r><w:t>改动</w:t></w:r></w:${tag}>${PARAGRAPH}</w:p>`;
    await refused(write('tracked-' + tag + '.docx', zip([{ name: 'word/document.xml', data: docXml(body) }])), 'tracked-changes');
  }
  // ISO 29500 Strict 用的是另一个 URI —— 正文按本地名抽取,修订判据不能只认过渡版那一个。
  const strict = 'http://purl.oclc.org/ooxml/wordprocessingml/main';
  const strictBody = `<w:p><w:ins w:id="1" w:author="a"><w:r><w:t>改动</w:t></w:r></w:ins>${PARAGRAPH}</w:p>`;
  const strictBytes = zip([{ name: 'word/document.xml', data: `<?xml version="1.0"?><w:document xmlns:w="${strict}"><w:body>${strictBody}</w:body></w:document>` }]);
  await refused(write('strict.docx', strictBytes), 'tracked-changes');
});

test('Excel 的共享修订(xl/revisions)与其它宿主的 ActiveX 也按名字拒', { skip }, async () => {
  const xlsx = (extra) => zip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><row r="1"><c r="A1" t="inlineStr"><is><t>数字</t></is></c></row></worksheet>' },
    ...extra,
  ]);
  await refused(write('revisions.xlsx', xlsx([{ name: 'xl/revisions/revision1.xml', data: '<revisions/>' }])), 'tracked-changes');
  await refused(write('xlsx-activex.xlsx', xlsx([{ name: 'xl/activeX/activeX1.bin', data: Buffer.from([7]) }])), 'activex');
  await refused(write('pptx-activex.pptx', zip([
    { name: 'ppt/presentation.xml', data: `<p:presentation xmlns:p="${P}"/>` },
    { name: 'ppt/slides/slide1.xml', data: `<p:sld xmlns:p="${P}"><p:cSld/></p:sld>` },
    { name: 'ppt/activeX/activeX1.xml', data: '<ax:ocx/>' },
  ])), 'activex');
});

test('ODF 的 text:tracked-changes 也拒;Excel 的 threadedComments 归 comments', { skip }, async () => {
  const odt = zip([{ name: 'content.xml', data: '<?xml version="1.0"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><text:tracked-changes/></office:body></office:document-content>' }]);
  await refused(write('tracked.odt', odt), 'tracked-changes');
  const xlsx = zip([
    { name: 'xl/workbook.xml', data: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>' },
    { name: 'xl/worksheets/sheet1.xml', data: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><row r="1"><c r="A1" t="inlineStr"><is><t>数字</t></is></c></row></worksheet>' },
    { name: 'xl/threadedComments/threadedComment1.xml', data: '<ThreadedComments xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"/>' },
  ]);
  await refused(write('threaded.xlsx', xlsx), 'comments');
});

test('超大内容部件仍报 document_invalid(不是「含隐藏层」)', { skip }, async () => {
  const bomb = zip([{ name: 'word/document.xml', data: docXml('<w:p><w:r><w:t>' + 'x'.repeat(9 * 1024 * 1024) + '</w:t></w:r></w:p>') }]);
  const r = await app.FileVisualIo.document(write('bomb.docx', bomb), {}, HELPER);
  assert.equal(r.code, 'document_invalid', JSON.stringify(r).slice(0, 300));
});

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
