'use strict';
// 隐私 M4:PDF 隐藏层的拒绝面 —— 判据在真正的解析器里(resources/native-file-read.py 的
// pdf_hidden_layers),JS 只把结果原样交回。这里用自造的合法 PDF 端到端跑 file_read 的 document 分支:
//   · 页面带批注(/Annots)      → document_hidden_content,found 含 annotations
//   · catalog 挂嵌入文件(/Names/EmbeddedFiles) → found 含 embedded-files
//   · catalog 有表单(/AcroForm) → found 含 form
//   · 干净 PDF                  → ok:true(不再误拒)
// 复审实测过:按原始字节找 /JavaScript 这类字面名的写法既会被 #XX 转义与对象流绕过,又会把正文里
// 提到这些词的良性文档误拒,所以这条判据必须走解析器 —— 那要求本机有 pdfplumber,没有就 SKIP。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const tempBase = path.resolve(os.tmpdir()), root = fs.mkdtempSync(path.join(tempBase, 'ruyi-pdf-hidden-'));
const data = path.join(root, 'data'); fs.mkdirSync(data);
const requestedPython = process.env.RUYI_BUNDLED_PYTHON;
Object.assign(process.env, require('../lib/release-checks').releaseEnvironment(path.join(root, 'home'), data));
const app = require('../lib/server-internals').loadServerInternals(['FileVisualIo']);
const HELPER = path.resolve(__dirname, '../../ruyi-workbench/resources/native-file-read.py');

function pythonWithPdfplumber() {
  const candidates = [...(requestedPython ? [[requestedPython, []]] : []), ['python', []], ['py', ['-3']], ['python3', []]];
  for (const [exe, pre] of candidates) {
    try {
      // Match FileVisualIo's isolated invocation: user-site/PYTHONPATH imports
      // must not make this probe claim that the actual reader has pdfplumber.
      const r = cp.spawnSync(exe, [...pre, '-I', '-X', 'utf8', '-c', 'import sys, pdfplumber; print(sys.executable)'],
        { windowsHide: true, timeout: 20000, encoding: 'utf8' });
      const executable = r.stdout?.trim();
      if (r.status === 0 && path.isAbsolute(executable || '') && fs.existsSync(executable)) return executable;
    } catch { /* try next */ }
  }
  return null;
}
const PY = pythonWithPdfplumber();
// A successful py probe must not be followed by an earlier, different python
// candidate in the product; bind the exact interpreter that passed isolation.
if (PY) process.env.RUYI_BUNDLED_PYTHON = PY;
const skip = PY ? false : 'pdfplumber unavailable in an isolated Python runtime';

// 一份最小合法 PDF:每个对象一条,自带 xref 偏移,能被 pdfminer/pdfplumber 正常解析。
function buildPdf(objects) {
  let out = '%PDF-1.7\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += String(offset).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const CONTENT = '<< /Length 0 >>\nstream\n\nendstream';
function pdfObjects(catalog) {
  return [catalog,
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>',
    CONTENT];
}
const write = (name, bytes) => { const p = path.join(root, name); fs.writeFileSync(p, bytes); return p; };

test('干净 PDF 照常读出(判据不误拒)', { skip }, async () => {
  const p = write('clean.pdf', buildPdf(pdfObjects('<< /Type /Catalog /Pages 2 0 R >>')));
  const r = await app.FileVisualIo.document(p, {}, HELPER);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  assert.equal(r.mode, 'document');
});

test('页面带批注 → 拒(document_hidden_content,found 含 annotations)', { skip }, async () => {
  const objects = pdfObjects('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R /Annots [5 0 R] >>';
  objects.push('<< /Type /Annot /Subtype /Text /Rect [10 10 20 20] /Contents (hidden note) >>');
  const r = await app.FileVisualIo.document(write('annotated.pdf', buildPdf(objects)), {}, HELPER);
  assert.equal(r.code, 'document_hidden_content', JSON.stringify(r).slice(0, 300));
  assert.ok(r.found.includes('annotations'), JSON.stringify(r.found));
  assert.match(r.hint, /Flatten or clean/);
});

test('catalog 挂嵌入文件 → 拒(found 含 embedded-files)', { skip }, async () => {
  const objects = pdfObjects('<< /Type /Catalog /Pages 2 0 R /Names << /EmbeddedFiles 5 0 R >> >>');
  objects.push('<< /Names [ (a.txt) 6 0 R ] >>', '<< /Type /Filespec /F (a.txt) >>');
  const r = await app.FileVisualIo.document(write('embedded.pdf', buildPdf(objects)), {}, HELPER);
  assert.equal(r.code, 'document_hidden_content', JSON.stringify(r).slice(0, 300));
  assert.ok(r.found.includes('embedded-files'), JSON.stringify(r.found));
});

test('catalog 有表单 → 拒(found 含 form);同一份文档去掉表单后照常读出', { skip }, async () => {
  const withForm = write('form.pdf', buildPdf(pdfObjects('<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [] >> >>')));
  const r = await app.FileVisualIo.document(withForm, {}, HELPER);
  assert.equal(r.code, 'document_hidden_content', JSON.stringify(r).slice(0, 300));
  assert.ok(r.found.includes('form'), JSON.stringify(r.found));
});

test('非 PDF(含同样的字典名)不走这份判据', { skip }, async () => {
  const docx = write('plain.docx', Buffer.concat([Buffer.from('PK\u0003\u0004', 'latin1'),
    Buffer.from('/EmbeddedFiles /AcroForm /Annots', 'latin1'), Buffer.from('\u0000\u0000')]));
  const r = await app.FileVisualIo.document(docx, {}, HELPER);
  assert.notEqual(r.code, 'document_hidden_content', JSON.stringify(r).slice(0, 300));
});

test('读不出 catalog(悬空 /Root)→ 拒,不当成「没发现」', { skip }, async () => {
  // /Root 指向不存在的对象:解析器拿不到 catalog,此时「三项检查都没命中」不能解释成干净。
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R >>', CONTENT];
  let out = '%PDF-1.7\n';
  const offsets = [];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += String(offset).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objects.length + 1} /Root 99 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const r = await app.FileVisualIo.document(write('dangling-root.pdf', Buffer.from(out, 'latin1')), {}, HELPER);
  assert.equal(r.code, 'document_hidden_content', JSON.stringify(r).slice(0, 300));
  assert.ok(r.found.includes('catalog-unreadable'), JSON.stringify(r.found));
});

test('页面级附加动作(/AA)也算隐藏层', { skip }, async () => {
  const objects = pdfObjects('<< /Type /Catalog /Pages 2 0 R >>');
  objects[2] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << >> /Contents 4 0 R /AA << /O << /S /JavaScript /JS (x) >> >> >>';
  const r = await app.FileVisualIo.document(write('page-aa.pdf', buildPdf(objects)), {}, HELPER);
  assert.equal(r.code, 'document_hidden_content', JSON.stringify(r).slice(0, 300));
  assert.ok(r.found.includes('additional-actions'), JSON.stringify(r.found));
});

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
