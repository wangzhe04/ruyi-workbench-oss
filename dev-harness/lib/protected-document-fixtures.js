'use strict';

const { crc32 } = require('node:zlib');

function protectedPdf({ text = 'Bounded visible PDF text', invisible = false, annotated = false, font = 'Helvetica',
  cropped = false, clipped = false, white = false, overpaint = false } = {}) {
  const printable = value => value.replace(/[\\()]/g, '\\$&');
  const stream = `${clipped ? '0 0 1 1 re W n ' : ''}${white ? '1 g ' : ''}BT /F1 16 Tf 32 180 Td ${invisible ? '3 Tr ' : ''}(${printable(text)}) Tj ET\n${overpaint ? '0 0 320 220 re f\n' : ''}`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 220]${cropped ? ' /CropBox [0 0 320 140]' : ''} /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R${annotated ? ' /Annots [7 0 R]' : ''} >>`,
    `<< /Type /Font /Subtype /Type1 /BaseFont /${font} >>`,
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Title (UNEXPOSED PDF METADATA) /Author (UNEXPOSED AUTHOR) >>',
    '<< /Type /Annot /Subtype /Text /Rect [12 12 24 24] /Contents (UNEXPOSED COMMENT) >>',
  ];
  let pdf = '%PDF-1.7\n';
  const offsets = [];
  for (const [index, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

function storedZip(parts) {
  const local = [], central = [];
  let offset = 0;
  for (const [key, value] of Object.entries(parts)) {
    const name = Buffer.from(key), content = Buffer.from(value), crc = crc32(content);
    const header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(content.length, 18);
    header.writeUInt32LE(content.length, 22);
    header.writeUInt16LE(name.length, 26);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    header.copy(directory, 6, 4, 28);
    directory.writeUInt32LE(offset, 42);
    local.push(header, name, content);
    central.push(directory, name);
    offset += header.length + name.length + content.length;
  }
  const tail = Buffer.alloc(22);
  tail.writeUInt32LE(0x06054b50);
  tail.writeUInt16LE(central.length / 2, 8);
  tail.writeUInt16LE(central.length / 2, 10);
  tail.writeUInt32LE(central.reduce((length, part) => length + part.length, 0), 12);
  tail.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, tail]);
}

function protectedDocx({ text = 'Bounded visible Office text', hidden = false, external = false, alternate = false, spoof = false } = {}) {
  const value = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const paragraph = `<w:p><w:r>${hidden ? '<w:rPr><w:vanish/></w:rPr>' : ''}${spoof ? `<s:t>${value}</s:t>` : `<w:t>${value}</w:t>`}</w:r></w:p>`;
  return storedZip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:s="urn:synthetic-hidden"><w:body>${alternate ? `<mc:AlternateContent><mc:Choice Requires="s">${paragraph}</mc:Choice><mc:Fallback><w:p/></mc:Fallback></mc:AlternateContent>` : paragraph}</w:body></w:document>`,
    'docProps/core.xml': '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><cp:keywords>UNEXPOSED OFFICE METADATA</cp:keywords></cp:coreProperties>',
    ...(external ? { 'word/_rels/document.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId2" Type="${ns}/hyperlink" TargetMode="External" Target="https://example.invalid/"/></Relationships>` } : {}),
  });
}

function protectedXlsx({ hiddenFormat = false } = {}) {
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return storedZip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${sheet}" xmlns:r="${ns}"><sheets><sheet name="Synthetic sheet" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${ns}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${ns}/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${sheet}"><sheetData><row r="1"><c r="A1" s="0"><v>321</v></c></row></sheetData></worksheet>`,
    'xl/styles.xml': `<styleSheet xmlns="${sheet}">${hiddenFormat ? '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;&quot;"/></numFmts>' : ''}<cellXfs count="1"><xf numFmtId="${hiddenFormat ? 164 : 0}" fontId="0" fillId="0"/></cellXfs></styleSheet>`,
  });
}

module.exports = { protectedPdf, protectedDocx, protectedXlsx };
