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

function protectedDocx({ text = 'Bounded visible Office text', hidden = false, external = false, alternate = false, spoof = false,
  shaded = false, shadowedColor = false } = {}) {
  const value = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const properties = [hidden ? '<w:vanish/>' : '', shaded ? '<w:color w:val="000000"/><w:shd w:val="clear" w:fill="000000"/>' : '',
    shadowedColor ? '<w:color w:val="FFFFFF" s:val="000000"/>' : ''].join('');
  const paragraph = `<w:p><w:r>${properties ? `<w:rPr>${properties}</w:rPr>` : ''}${spoof ? `<s:t>${value}</s:t>` : `<w:t>${value}</w:t>`}</w:r></w:p>`;
  return storedZip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:s="urn:synthetic-hidden"${shadowedColor ? ' mc:Ignorable="s"' : ''}><w:body>${alternate ? `<mc:AlternateContent><mc:Choice Requires="s">${paragraph}</mc:Choice><mc:Fallback><w:p/></mc:Fallback></mc:AlternateContent>` : paragraph}</w:body></w:document>`,
    'docProps/core.xml': '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><cp:keywords>UNEXPOSED OFFICE METADATA</cp:keywords></cp:coreProperties>',
    ...(external ? { 'word/_rels/document.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId2" Type="${ns}/hyperlink" TargetMode="External" Target="https://example.invalid/"/></Relationships>` } : {}),
  });
}

function protectedPptx({ outOfSlide = false, clipped = false } = {}) {
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const slide = 'http://schemas.openxmlformats.org/presentationml/2006/main';
  const draw = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  return storedZip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="ppt/presentation.xml"/></Relationships>`,
    'ppt/presentation.xml': `<p:presentation xmlns:p="${slide}" xmlns:r="${ns}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${ns}/slide" Target="slides/slide1.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': `<p:sld xmlns:p="${slide}" xmlns:a="${draw}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Test box"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${outOfSlide ? 10000000 : 200000}" y="200000"/><a:ext cx="3500000" cy="1000000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr${clipped ? ' vertOverflow="clip"' : ''}/><a:lstStyle/><a:p><a:r><a:t>Synthetic slide text</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  });
}

function protectedXlsx({ hiddenFormat = false, text, hiddenSheet = false, formula = false } = {}) {
  const rels = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const sheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  return storedZip({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${sheet}" xmlns:r="${ns}"><sheets><sheet name="Synthetic sheet" sheetId="1" r:id="rId1"${hiddenSheet ? ' state="hidden"' : ''}/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${rels}"><Relationship Id="rId1" Type="${ns}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${ns}/styles" Target="styles.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': `<worksheet xmlns="${sheet}"><sheetData><row r="1">${text === undefined
      ? '<c r="A1" s="0"><v>321</v></c>'
      : `<c r="A1" t="inlineStr"><is><t>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</t></is></c><c r="B1"><v>321</v></c><c r="C1" t="b"><v>1</v></c>`
    }${formula ? '<c r="D1"><f>LEN("UNEXPOSED FORMULA")</f><v>17</v></c>' : ''}</row></sheetData></worksheet>`,
    'xl/styles.xml': `<styleSheet xmlns="${sheet}">${hiddenFormat ? '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;&quot;"/></numFmts>' : ''}<cellXfs count="1"><xf numFmtId="${hiddenFormat ? 164 : 0}" fontId="0" fillId="0"/></cellXfs></styleSheet>`,
  });
}

function protectedOdf({ extension = 'odt', text = 'Bounded visible ODF text', conditional = false, external = false } = {}) {
  if (!['odt', 'ods', 'odp'].includes(extension)) throw Error('unknown ODF fixture kind');
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = conditional ? '<text:conditional-text text:condition="true()" text:string-value-if-true="UNEXPOSED CONDITIONAL CONTENT"/>'
    : external ? `<text:a xlink:href="https://example.invalid/private">${escaped}</text:a>` : escaped;
  const paragraph = `<text:p>${body}</text:p>`;
  const content = extension === 'odt' ? `<office:text>${paragraph}</office:text>`
    : extension === 'ods' ? `<office:spreadsheet><table:table table:name="Public"><table:table-row><table:table-cell office:value-type="string">${paragraph}</table:table-cell></table:table-row></table:table></office:spreadsheet>`
      // A real ODP paragraph belongs to a text box. That visual geometry remains
      // an explicitly refused layer, rather than a fabricated geometry-free ODP.
      : `<office:presentation><draw:page draw:name="Public"><draw:frame><draw:text-box>${paragraph}</draw:text-box></draw:frame></draw:page></office:presentation>`;
  const mime = 'application/vnd.oasis.opendocument.' + ({ odt: 'text', ods: 'spreadsheet', odp: 'presentation' })[extension];
  return storedZip({
    mimetype: mime,
    'META-INF/manifest.xml': `<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
    'content.xml': `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:xlink="http://www.w3.org/1999/xlink" office:version="1.2"><office:body>${content}</office:body></office:document-content>`,
    'meta.xml': '<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><office:meta><dc:title>UNEXPOSED ODF METADATA</dc:title></office:meta></office:document-meta>',
  });
}

module.exports = { protectedPdf, protectedDocx, protectedPptx, protectedXlsx, protectedOdf };
