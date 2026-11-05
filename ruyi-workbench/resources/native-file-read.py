"""Read-only native document worker. Stdlib OOXML/ODF; optional pdfplumber/Pillow. No MCP/UI."""
import base64
import hashlib
import io
import json
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_ENTRY = 8 * 1024 * 1024
MAX_XML = 24 * 1024 * 1024
MAX_IMAGE = 4 * 1024 * 1024


def image_block(data, name):
    if len(data) > MAX_IMAGE:
        raise ValueError("image exceeds 4MB")
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        mime = 'image/png'
    elif data.startswith(b'\xff\xd8\xff'):
        mime = 'image/jpeg'
    elif data[:6] in (b'GIF87a', b'GIF89a'):
        mime = 'image/gif'
    elif data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        mime = 'image/webp'
    else:
        from PIL import Image
        with Image.open(io.BytesIO(data)) as im:
            im.thumbnail((1600, 1600))
            out = io.BytesIO()
            im.convert('RGB').save(out, format='PNG')
            data = out.getvalue()
            mime = 'image/png'
        if len(data) > MAX_IMAGE:
            raise ValueError('converted image exceeds 4MB')
    return {'name': name, 'mimeType': mime, 'data': base64.b64encode(data).decode('ascii')}


def text_window(value, opts):
    start, limit = opts['offset'], opts['limit']
    piece = value[start:start + limit]
    result = {'content': piece, 'totalChars': len(value), 'truncated': start + len(piece) < len(value)}
    if result['truncated']:
        result['nextOffset'] = start + len(piece)
    return result


W_NS = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
ODF_TEXT_NS = '{urn:oasis:names:tc:opendocument:xmlns:text:1.0}'
ODF_OFFICE_NS = '{urn:oasis:names:tc:opendocument:xmlns:office:1.0}'


def ooxml_hidden_parts(names):
    """只看部件名(不读字节、不扣预算)就能认定的隐藏层:
    宏(vbaProject.bin)、嵌入对象(*/embeddings/*)、批注(comments*.xml / ppt/comments/* / xl/threadedComments/*)、
    ActiveX(word/activeX/*)、词汇表正文(word/glossary/document.xml —— AutoText 正文既不抽取也读不到)。
    不复述 customXml:实测 52% 的真实 docx 都带参考文献源(customXml/item1.xml = <b:Sources/>),
    其中就包括工作台自己 write_document 产出的文件 —— 把它当隐藏层会直接把「写完就能读回」打断。
    """
    found = set()
    for name in names:
        lower = name.lower()
        base = lower.rsplit('/', 1)[-1]
        if lower.endswith('/'):
            continue
        if base == 'vbaproject.bin':
            found.add('macros')
        elif '/embeddings/' in lower:
            found.add('embedded-objects')
        elif base == 'comments.xml' or re.fullmatch(r'comments\d+\.xml', base) or lower.startswith('ppt/comments/') or lower.startswith('xl/threadedcomments/'):
            found.add('comments')
        elif '/activex/' in lower:
            found.add('activex')
        elif lower.startswith('xl/revisions/'):
            found.add('tracked-changes')
        elif lower == 'word/glossary/document.xml':
            found.add('glossary')
    return sorted(found)


def ooxml_structure_layers(root, ext):
    """修订/批注是靠【解析出来的元素】认的,不是靠 local name:WordprocessingML 的 {@w}ins / {@w}del
    才是修订,DrawingML 的自定义几何里也有 <a:moveTo>/<a:lnTo>(那是画路径,不是修订)。
    ODF 的修订是 <text:tracked-changes>、批注是 <office:annotation>。
    """
    found = set()
    if ext in ('.odt', '.ods', '.odp'):
        for node in root.iter():
            if node.tag in (ODF_TEXT_NS + 'tracked-changes', ODF_TEXT_NS + 'changed-region'):
                found.add('tracked-changes')
            elif node.tag.startswith(ODF_OFFICE_NS) and node.tag in (ODF_OFFICE_NS + 'annotation', ODF_OFFICE_NS + 'annotation-end'):
                found.add('comments')
        return sorted(found)
    for node in root.iter():
        if not isinstance(node.tag, str) or not node.tag.startswith('{'):
            continue
        ns_end = node.tag.index('}') + 1
        ns, name = node.tag[:ns_end], node.tag[ns_end:]
        # 命名空间按形状认:过渡版与 ISO 29500 Strict(不同 URI)都是 wordprocessingml/main。
        if 'wordprocessingml' in ns and ns.endswith('main}') and name in ('ins', 'del', 'moveFrom', 'moveTo'):
            found.add('tracked-changes')
            break
    return sorted(found)

def hidden_refusal(found):
    return {'ok': False, 'code': 'document_hidden_content', 'found': list(found),
            'error': 'Document contains layers this reader does not extract: ' + ', '.join(found),
            'hint': 'This reader only returns paragraph text. Remove or accept tracked changes, delete comments, embedded objects, macros and ActiveX controls (Save As a new copy, then read it again), or open the file in an editor to inspect those layers yourself.'}


def read_zip(filename, opts):
    # 容器层的两种「读不出正文」先单独认出来,别让它们掉进 document_invalid:
    # · 加密的 Office(CFB/EncryptedPackage,或 ODF 的 META-INF/manifest 里声明 encryption-data)——
    #   读出来会是解密后的乱码或空,骗自己「读到了正文」比拒绝更糟;
    # · Office 的 ~$ 锁/属主文件,本质是 OLE 存根,不是文档。
    with open(filename, 'rb') as probe:
        magic = probe.read(8)
    if os.path.basename(filename).startswith('~$'):
        return {'ok': False, 'code': 'document_stub', 'path': filename,
                'error': 'This is an Office lock/owner file (~$...), not a document.',
                'hint': 'Open the real file with the same name minus the ~$ prefix.'}
    if magic.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
        return {'ok': False, 'code': 'document_encrypted', 'path': filename,
                'error': 'This document is an OLE/CFB container (password-protected Office).',
                'hint': 'Remove the password in an editor or Save As an unencrypted copy, then read it again. This reader never decrypts.'}
    with zipfile.ZipFile(filename) as z:
        if len(z.infolist()) > 10000:
            raise ValueError('too many archive entries')
        names = z.namelist()
        ext = os.path.splitext(filename)[1].lower()
        if 'META-INF/manifest.xml' in names:
            info = z.getinfo('META-INF/manifest.xml')
            # 和其它部件同一条预算:压缩后极小、声明解压几十 MB 的 manifest 不许整块读进来。
            if info.file_size > MAX_ENTRY:
                raise ValueError('document XML exceeds read budget')
            manifest = z.read(info)
            # 只看【本读取器真正要读的部件】有没有被加密:ODF 分支只抽 content.xml。
            # 图片被单独加密(content.xml 明文)时正文照旧能读 —— 那种不再整份拒掉。
            encrypted = b'encryption-data' in manifest
            try:
                root = ET.fromstring(manifest)
                name_of = lambda node: node.tag.rsplit('}', 1)[-1]
                encrypted = any(name_of(entry) == 'file-entry' and entry.get('{urn:oasis:names:tc:opendocument:xmlns:manifest:1.0}full-path', entry.get('manifest:full-path')) == 'content.xml'
                                and any(name_of(child) == 'encryption-data' for child in entry) for entry in root.iter())
            except Exception:
                pass  # 解析不了就按子串判(fail-closed)
            if encrypted:
                return {'ok': False, 'code': 'document_encrypted', 'path': filename,
                        'error': 'This ODF document declares encrypted entries.',
                        'hint': 'Save an unencrypted copy from the editor, then read it again. This reader never decrypts.'}

        if ext in ('.docx', '.docm', '.dotx'):
            xmls = [n for n in names if re.fullmatch(r'word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml', n)]
            required = 'word/document.xml'
            media_prefix = 'word/media/'
        elif ext in ('.pptx', '.pptm'):
            xmls = [n for n in names if re.fullmatch(r'ppt/(slides/slide|notesSlides/notesSlide)\d+\.xml', n)]
            required = 'ppt/presentation.xml'
            media_prefix = 'ppt/media/'
        elif ext in ('.xlsx', '.xlsm'):
            xmls = [n for n in names if re.fullmatch(r'xl/worksheets/sheet\d+\.xml', n)]
            required = 'xl/workbook.xml'
            media_prefix = 'xl/media/'
        else:
            xmls, required, media_prefix = ['content.xml'], 'content.xml', 'Pictures/'
        if required not in names:
            raise ValueError('not a valid document container')
        hidden = ooxml_hidden_parts(names)
        if hidden:
            return hidden_refusal(hidden)
        budget = MAX_XML

        def tree(name):
            nonlocal budget
            info = z.getinfo(name)
            if info.file_size > MAX_ENTRY or info.file_size > budget:
                raise ValueError('document XML exceeds read budget')
            budget -= info.file_size
            data = z.read(info)
            declaration_probe = data.replace(b'\x00', b'').upper()
            if b'<!DOCTYPE' in declaration_probe or b'<!ENTITY' in declaration_probe:
                raise ValueError('XML entities are not supported')
            return ET.fromstring(data)

        def local(node):
            return node.tag.rsplit('}', 1)[-1]

        shared = []
        if ext in ('.xlsx', '.xlsm') and 'xl/sharedStrings.xml' in names:
            shared = [''.join(n.itertext()) for n in tree('xl/sharedStrings.xml')]
        pieces = []
        for name in sorted(xmls, key=lambda n: re.sub(r'\d+', lambda m: m[0].zfill(9), n)):
            root = tree(name)
            # 修订/批注只在这一遍解析里认(不再为了判据把同一部件读第二遍,也不绕过 MAX_XML 预算)。
            layered = ooxml_structure_layers(root, ext)
            if layered:
                return hidden_refusal(layered)
            lines = []
            if ext in ('.xlsx', '.xlsm'):
                for row in (n for n in root.iter() if local(n) == 'row'):
                    cells = []
                    for cell in row:
                        value = ''.join(n.text or '' for n in cell.iter() if local(n) in ('v', 't'))
                        if cell.get('t') == 's' and value.isdigit():
                            value = shared[int(value)] if int(value) < len(shared) else value
                        formula = next((n.text for n in cell if local(n) == 'f'), None)
                        cells.append(f"{cell.get('r', '')}: {value}" + (f' [={formula}]' if formula else ''))
                    lines.append('\t'.join(cells))
            else:
                for node in root.iter():
                    if local(node) in ('p', 'h'):
                        value = ''.join(node.itertext())
                        if value:
                            lines.append(value)
            pieces.append(f'## {name}\n' + '\n'.join(lines))
        if not xmls:
            raise ValueError('document contains no readable parts')
        result = {'ok': True, 'mode': 'document', **text_window('\n\n'.join(pieces), opts)}
        media = [n for n in names if n.startswith(media_prefix) and not n.endswith('/')]
        result.update(totalImages=len(media), images=[], imageWarnings=[])
        if opts['includeImages']:
            start = opts['imageOffset']
            chosen = media[start:start + opts['imageLimit']]
            for name in chosen:
                try:
                    if z.getinfo(name).file_size > MAX_IMAGE:
                        raise ValueError('image exceeds 4MB')
                    result['images'].append(image_block(z.read(name), name))
                except Exception as exc:
                    result['imageWarnings'].append({'source': name, 'error': str(exc)[:200]})
            if start + len(chosen) < len(media):
                result['nextImageOffset'] = start + len(chosen)
        result['note'] = 'Embedded media are identified by archive part name; their layout/position is not rendered. External document links are never fetched.'
        return result


def pdf_hidden_layers(doc):
    """PDF 的隐藏层不在「抽取出来的正文」里:嵌入文件/脚本/表单/打开动作/批注。
    这份读取器只交正文,所以只要发现这些结构就拒绝,而不是让调用方以为整份文档都读过了。
    判据走真实解析器(catalog 与页面 annots),不是原始字节里的字面名 —— 后者既能被 #XX 转义与
    对象流绕过,也会把正文里提到 /JavaScript 的良性文档误拒。
    """
    found = set()
    try:
        catalog = doc.doc.catalog
    except Exception:
        return ['catalog-unreadable']
    # 读不出 catalog(悬空 /Root、空 dict)时不能当成「什么都没发现」——那等于对整份文档放行。
    if not catalog or not hasattr(catalog, 'keys') or not len(catalog):
        return ['catalog-unreadable']
    def resolve(value):
        try:
            return value.resolve() if hasattr(value, 'resolve') else value
        except Exception:
            return value
    for key, name in (('AcroForm', 'form'), ('OpenAction', 'open-action'), ('AA', 'additional-actions')):
        try:
            if key in catalog:
                found.add(name)
        except Exception:
            found.add('catalog-unreadable')
    try:
        names = resolve(catalog.get('Names')) if 'Names' in catalog else None
        if names:
            if 'EmbeddedFiles' in names:
                found.add('embedded-files')
            if 'JavaScript' in names:
                found.add('javascript')
    except Exception:
        found.add('names-unreadable')
    try:
        for page in doc.pages:
            try:
                if page.annots:
                    found.add('annotations')
            except Exception:
                found.add('annotations-unreadable')
            # 页面级附加动作(/AA)不在 catalog 上,漏了它照样能藏脚本。
            # pdfminer 的 PDFPage 把键放在 .attrs 里,dict 的 `in` 看不到它们。
            try:
                attrs = getattr(page.page_obj, 'attrs', None)
                if attrs is not None and 'AA' in attrs:
                    found.add('additional-actions')
            except Exception:
                pass
    except Exception:
        found.add('pages-unreadable')
    return sorted(found)


def read_pdf(filename, opts):
    import pdfplumber
    with pdfplumber.open(filename) as doc:
        hidden = pdf_hidden_layers(doc)
        if hidden:
            return {'ok': False, 'code': 'document_hidden_content', 'found': hidden,
                    'error': 'PDF contains layers this reader does not extract: ' + ', '.join(hidden),
                    'hint': 'This reader only returns page text. Flatten or clean the PDF (print/save as a new PDF, remove annotations, forms, embedded files and actions) and read it again, or open it in a viewer to inspect those layers yourself.'}
        start = opts['pageOffset'] - 1
        end = min(start + opts['pageLimit'], len(doc.pages))
        result = {'ok': True, 'mode': 'document', 'totalPages': len(doc.pages), 'pageOffset': start + 1, 'images': [], 'imageWarnings': []}
        pieces = []
        for i in range(start, end):
            page = doc.pages[i]
            pieces.append(f'## Page {i + 1}\n' + (page.extract_text() or ''))
            if opts['includeImages']:
                try:
                    resolution = min(144, 72 * 1600 / max(page.width, page.height, 1))
                    rendered = page.to_image(resolution=resolution).original
                    out = io.BytesIO()
                    rendered.save(out, format='PNG')
                    result['images'].append(image_block(out.getvalue(), f'page-{i + 1}.png'))
                except Exception as exc:
                    result['imageWarnings'].append({'page': i + 1, 'error': str(exc)[:200]})
        result.update(text_window('\n\n'.join(pieces), opts))
        if end < len(doc.pages):
            result['nextPageOffset'] = end + 1
        result['note'] = 'PDF images are page renders (including scans/charts). offset/nextOffset apply within this page window; nextPageOffset advances pages. No OCR text is invented.'
        return result


def main():
    filename, raw = sys.argv[1:3]
    opts = json.loads(raw)
    if os.path.getsize(filename) > 50 * 1024 * 1024:
        raise ValueError('file exceeds 50MB')
    ext = os.path.splitext(filename)[1].lower()
    if ext == '.pdf':
        return read_pdf(filename, opts)
    if ext in ('.bmp', '.tif', '.tiff', '.ico', '.png', '.jpg', '.jpeg', '.webp', '.gif'):
        with open(filename, 'rb') as stream:
            data = stream.read(MAX_IMAGE + 1)
        return {'ok': True, 'mode': 'image', 'content': f'Image {os.path.basename(filename)} (sha256 {hashlib.sha256(data).hexdigest()}) converted for vision input.',
                'images': [image_block(data, os.path.basename(filename))] if opts['includeImages'] else []}
    return read_zip(filename, opts)


try:
    output = main()
except ImportError as exc:
    output = {'ok': False, 'code': 'reader_unavailable', 'error': f'Missing native reader dependency: {exc.name}',
              'hint': 'Install pdfplumber for PDF or Pillow for image conversion in the Python runtime. No computer use/MCP connection is needed.'}
except Exception as exc:
    output = {'ok': False, 'code': 'document_invalid', 'error': str(exc)[:300],
              'hint': 'Check the file format; for containers archive_unzip can inspect the entries.'}
print(json.dumps(output, ensure_ascii=True))
