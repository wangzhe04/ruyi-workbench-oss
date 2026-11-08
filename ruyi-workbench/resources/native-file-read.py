"""Read-only native document worker. Stdlib OOXML/ODF; optional pdfplumber/Pillow. No MCP/UI."""
import base64
import hashlib
import io
import json
import logging
import math
import os
import posixpath
import re
import sys
import textwrap
import warnings
import zipfile
import xml.etree.ElementTree as ET

MAX_ENTRY = 8 * 1024 * 1024
MAX_XML = 24 * 1024 * 1024
MAX_IMAGE = 4 * 1024 * 1024
MAX_DOCUMENT = 50 * 1024 * 1024
MAX_PROJECTION_CHARS = 40000
MAX_PAGES = 256
OFFICE_EXTENSIONS = {'.docx', '.docm', '.dotx', '.pptx', '.pptm', '.xlsx', '.xlsm', '.odt', '.ods', '.odp'}


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

LAYER_REMEDIES = {
    'tracked-changes': 'accept or reject the tracked changes',
    'comments': 'delete the comments',
    'embedded-objects': 'remove the embedded objects',
    'macros': 'remove the macros',
    'activex': 'remove the ActiveX controls',
    'glossary': 'remove the building blocks (AutoText lives in the glossary part)',
}


def hidden_refusal(found):
    """拒绝要说清「有哪些层 + 每层怎么处理」—— 只给一个码,读的人得自己猜清单是哪儿来的。"""
    layers = list(found)
    steps = []
    for name in layers:
        remedy = LAYER_REMEDIES.get(name)
        if remedy and remedy not in steps:
            steps.append(remedy)
    if not steps:
        steps.append('remove the layers listed in found')
    return {'ok': False, 'code': 'document_hidden_content', 'found': layers,
            'error': 'Document contains layers this reader does not extract: ' + ', '.join(layers),
            'hint': 'This reader only returns paragraph text. To read this file: '
                    + '; '.join(steps) + ' (Save As a new copy, then read it again), '
                    + 'or open it in an editor to inspect those layers yourself.'}

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


class ProjectionRefusal(Exception):
    def __init__(self, code, found=()):
        self.code = code
        self.found = sorted(set(found))


def protected_refusal(code, found=()):
    hint = {
        'document_encrypted': 'Save an unencrypted copy from your editor, then read it again.',
        'document_stub': 'Choose the original document rather than its Office lock file.',
        'document_hidden_content': 'Save a clean copy without the listed layers, then read it again.',
        'document_projection_limit': 'Split the document into smaller clean copies and read one at a time.',
        'document_visual_required': 'Use as:"image" to read selected pages through the protected image path.',
        'document_render_unavailable': 'Export a clean PDF in your editor and read the exported pages.',
        'document_page_range': 'Request a page offset within the document.',
        'reader_unavailable': 'Use the Full offline package with the verified media runtime.',
        'document_invalid': 'Check that the file is a complete document in a supported format.',
    }[code]
    return {'ok': False, 'code': code, 'hint': hint, **({'found': list(found)} if found else {})}


def protected_text(text):
    if len(text.encode('utf-16-le')) > MAX_PROJECTION_CHARS * 2:
        raise ProjectionRefusal('document_projection_limit')
    return {'ok': True, 'mode': 'document', 'projection': 'document-text', 'content': text, 'images': []}


def protected_pages(total, opts, projection, render):
    start = opts['pageOffset'] - 1
    if not 0 <= start < total:
        raise ProjectionRefusal('document_page_range')
    end = min(start + opts['pageLimit'], total)
    images = []
    for i in range(start, end):
        with io.BytesIO() as stream:
            try:
                with render(i) as image:
                    image.save(stream, format='PNG')
                images.append(image_block(stream.getvalue(), f'page-{i + 1}.png'))
            except ImportError:
                raise
            except Exception as exc:
                raise ProjectionRefusal('document_render_unavailable') from exc
    label = 'PDF page render' if projection == 'pdf-pages' else 'Office content preview (text reflow, without original layout)'
    result = {'ok': True, 'mode': 'document', 'projection': projection, 'totalPages': total,
              'pageOffset': start + 1, 'images': images, 'content': f'{label}: pages {start + 1}–{end} of {total}.'}
    if end < total:
        result['nextPageOffset'] = end + 1
    return result


def local_name(value):
    return str(value).rsplit('}', 1)[-1]


PROTECTED_OFFICE_ATTRIBUTES = {
    'TargetMode', 'Target', 'Type', 'ContentType', 'Id', 'hidden', 'state', 'show', 'visibility', 'display', 'formula',
    'numFmtId', 'fontId', 'fillId', 'rgb', 'theme', 'indexed', 'tint', 'patternType', 'val', 'themeColor', 'themeTint',
    'color', 'background-color', 'fill', 'href', 'c', 'opacity', 'fill-opacity', 'text-opacity', 'is-hidden', 'condition',
}


def attributes(node):
    result = {}
    for key, value in node.attrib.items():
        name = local_name(key)
        relationship_id = name == 'id' and local_name(node.tag) in ('headerReference', 'footerReference')
        # Other local-name collisions can be legitimate, such as a slide ID
        # and its relationship ID. Only values consumed by the scanner matter.
        if name in result and (name in PROTECTED_OFFICE_ATTRIBUTES or relationship_id):
            raise ProjectionRefusal('document_hidden_content', ['ambiguous-attributes'])
        result[name] = value
    return result


def projected_namespace(node, allowed):
    name = str(node.tag)
    return name.startswith('{') and name[1:name.index('}')] in allowed


WORD_NAMESPACES = {'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'}
PRESENTATION_NAMESPACES = {'http://schemas.openxmlformats.org/presentationml/2006/main', 'http://purl.oclc.org/ooxml/presentationml/main'}
DRAW_NAMESPACES = {'http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'}
SHEET_NAMESPACES = {'http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'}


def check_projection_namespace(root, ext, shared=False):
    if ext in ('.docx', '.dotx'):
        names, allowed = ('p', 'h', 't', 'tab', 'br', 'cr'), WORD_NAMESPACES
    elif ext == '.pptx':
        names, allowed = ('p', 'h', 't', 'br'), DRAW_NAMESPACES
    elif ext == '.xlsx':
        names, allowed = (('t', 'si') if shared else ('row', 'c', 'v', 't')), SHEET_NAMESPACES
    else:
        names, allowed = ('p', 'h', 's', 'tab', 'line-break'), {ODF_TEXT_NS[1:-1]}
    if any(local_name(node.tag) in names and not projected_namespace(node, allowed) for node in root.iter()):
        raise ProjectionRefusal('document_hidden_content', ['unhandled-text-namespace'])


def dark_word_color(attrs):
    value = attrs.get('val', 'auto').lower()
    if attrs.get('themeColor') in ('light1', 'light2', 'background1', 'background2') or 'themeTint' in attrs:
        return False
    if value == 'auto':
        return True
    return bool(re.fullmatch('[a-f0-9]{6}', value) and min(int(value[i:i + 2], 16) for i in (0, 2, 4)) < 200)


def word_background_supported(tag, attrs):
    if tag == 'shd':
        return (attrs.get('val', 'clear') in ('clear', 'nil') and attrs.get('fill', 'auto').upper() in ('AUTO', 'FFFFFF')
                and not any(name.startswith('theme') for name in attrs))
    if tag == 'highlight':
        return attrs.get('val', 'none') in ('none', 'white')
    return True


def office_layers(roots, ext):
    found = set()
    for name, root in roots.items():
        found.update(ooxml_structure_layers(root, ext))
        for node in root.iter():
            tag, attrs = local_name(node.tag), attributes(node)
            if tag in ('AlternateContent', 'Choice', 'Fallback'):
                found.add('alternate-markup')
            if tag == 'Relationship':
                if attrs.get('TargetMode', '').lower() == 'external' or ':' in attrs.get('Target', ''):
                    found.add('external-relationships')
                relation = attrs.get('Type', '').rsplit('/', 1)[-1].lower()
                if relation in ('oleobject', 'package', 'attachedtemplate', 'afchunk', 'externallink', 'vbaproject'):
                    found.add('embedded-or-active-parts')
            if tag in ('Default', 'Override') and 'macroenabled' in attrs.get('ContentType', '').lower():
                found.add('macros')
            if tag in ('vanish', 'webHidden', 'hidden-text', 'hidden-paragraph', 'rPh', 'phoneticPr') or attrs.get('hidden', '').lower() in ('1', 'true'):
                found.add('hidden-content')
            if tag in ('sheet', 'sld') and (attrs.get('state', '').lower() in ('hidden', 'veryhidden') or attrs.get('show') in ('0', 'false')):
                found.add('hidden-content')
            if attrs.get('visibility') in ('collapse', 'filter', 'hidden') or attrs.get('display') in ('none', 'false'):
                found.add('hidden-content')
            if tag in ('instrText', 'fldSimple', 'fldChar', 'altChunk', 'dataBinding', 'customXml', 'script', 'scripts', 'event-listener', 'control', 'object', 'object-ole', 'binary-data', 'notes', 'form', 'forms'):
                found.add('embedded-or-active-parts')
            if (tag == 'f' and name.startswith('xl/')) or 'formula' in attrs:
                found.add('spreadsheet-formulas')
            if tag in ('conditionalFormatting', 'autoFilter', 'numFmt'):
                found.add('unhandled-cell-display')
            if name == 'xl/styles.xml' and tag == 'xf' and any(attrs.get(key, '0') != '0' for key in ('numFmtId', 'fontId', 'fillId')):
                found.add('unhandled-cell-display')
            if name == 'xl/styles.xml' and tag == 'color' and ('rgb' in attrs and attrs['rgb'].upper() not in ('FF000000', '00000000')
                    or 'theme' in attrs and attrs['theme'] != '1' or 'indexed' in attrs or 'tint' in attrs):
                found.add('unhandled-cell-display')
            if name == 'xl/styles.xml' and (tag == 'gradientFill' or tag == 'patternFill' and attrs.get('patternType', 'none') not in ('none', 'gray125')):
                found.add('unhandled-cell-display')
            if projected_namespace(node, WORD_NAMESPACES):
                if (tag == 'color' and not dark_word_color(attrs)
                        or tag == 'background' and attrs.get('color', 'FFFFFF').upper() != 'FFFFFF'
                        or not word_background_supported(tag, attrs)
                        or tag in ('sz', 'szCs') and attrs.get('val', '').isdigit() and int(attrs['val']) < 8):
                    found.add('unhandled-text-display')
            if ext in ('.docx', '.dotx') and tag in ('textFill', 'textOutline'):
                found.add('unhandled-text-display')
            if tag == 'text-properties' and attrs.get('color', '#000000').lower() != '#000000':
                found.add('unhandled-text-display')
            if ext in ('.odt', '.ods', '.odp'):
                if (tag == 'conditional-text' or attrs.get('display') == 'condition' or 'condition' in attrs
                        or attrs.get('is-hidden', '').lower() in ('1', 'true')):
                    found.add('conditional-content')
                if (attrs.get('background-color', 'transparent').lower() not in ('transparent', '#ffffff')
                        or any(attrs.get(key, '100%') not in ('100%', '1') for key in ('opacity', 'fill-opacity', 'text-opacity'))
                        or 'opacity-name' in attrs):
                    found.add('unhandled-text-display')
            if ext == '.pptx' and name.startswith('ppt/slides/') and tag in (
                    'noFill', 'srgbClr', 'scrgbClr', 'schemeClr', 'sysClr', 'prstClr', 'hslClr', 'alpha', 'alphaMod', 'alphaOff'):
                found.add('unhandled-text-display')
            if tag in ('image', 'blip', 'drawing', 'pict', 'txbxContent', 'text-box', 'chart', 'oMath', 'oMathPara'):
                found.add('unhandled-visual-content')
            if ext in ('.odt', '.ods', '.odp') and attrs.get('href') and not attrs['href'].startswith('#'):
                found.add('external-or-embedded-relationships')
            if tag == 'encryption-data':
                raise ProjectionRefusal('document_encrypted')
    return found


def package_relationships(roots, part):
    parent, basename = posixpath.split(part)
    rels = roots.get(posixpath.join(parent, '_rels', basename + '.rels'))
    result = {}
    if rels is None:
        return result
    for item in rels:
        attrs = attributes(item)
        target = attrs.get('Target', '')
        if not target or any(char in target for char in ('\\', ':', '%', '?', '#')):
            raise ProjectionRefusal('document_hidden_content', ['unhandled-relationships'])
        resolved = posixpath.normpath(target[1:] if target.startswith('/') else posixpath.join(parent, target))
        if resolved == '..' or resolved.startswith('../') or not attrs.get('Id') or attrs['Id'] in result:
            raise ProjectionRefusal('document_invalid')
        result[attrs['Id']] = resolved
    return result


def office_sections(roots, ext):
    if ext in ('.docx', '.dotx'):
        part = 'word/document.xml'
        main = roots[part]
        if (local_name(main.tag) != 'document' or not projected_namespace(main, WORD_NAMESPACES)
                or not any(local_name(node.tag) == 'body' and projected_namespace(node, WORD_NAMESPACES) for node in main)):
            raise ProjectionRefusal('document_invalid')
        rels = package_relationships(roots, part)
        linked = []
        for node in main.iter():
            kind = {'headerReference': 'header', 'footerReference': 'footer'}.get(local_name(node.tag))
            if kind:
                target = rels[attributes(node)['id']]
                if not re.fullmatch(fr'word/{kind}\d+\.xml', target):
                    raise ProjectionRefusal('document_hidden_content', ['unhandled-parts'])
                linked.append(target)
        if any(local_name(node.tag) in ('footnoteReference', 'endnoteReference') for node in main.iter()):
            raise ProjectionRefusal('document_hidden_content', ['unhandled-notes'])
        return [part, *dict.fromkeys(linked)]
    if ext in ('.pptx', '.xlsx'):
        part, tag = ('ppt/presentation.xml', 'sldId') if ext == '.pptx' else ('xl/workbook.xml', 'sheet')
        namespace = PRESENTATION_NAMESPACES if ext == '.pptx' else SHEET_NAMESPACES
        if local_name(roots[part].tag) != ('presentation' if ext == '.pptx' else 'workbook') or not projected_namespace(roots[part], namespace):
            raise ProjectionRefusal('document_invalid')
        rels = package_relationships(roots, part)
        parts = []
        for node in roots[part].iter():
            if local_name(node.tag) != tag:
                continue
            if not projected_namespace(node, namespace):
                raise ProjectionRefusal('document_hidden_content', ['unhandled-text-namespace'])
            ids = [value for key, value in node.attrib.items() if key.startswith('{') and local_name(key) == 'id']
            if len(ids) != 1 or ids[0] not in rels:
                raise ProjectionRefusal('document_invalid')
            parts.append(rels[ids[0]])
        if not parts or len(parts) != len(set(parts)):
            raise ProjectionRefusal('document_invalid')
        expected = r'ppt/slides/slide\d+\.xml' if ext == '.pptx' else r'xl/worksheets/sheet\d+\.xml'
        if any(not re.fullmatch(expected, part) for part in parts):
            raise ProjectionRefusal('document_hidden_content', ['unhandled-parts'])
        return parts
    root = roots['content.xml']
    if root.tag != ODF_OFFICE_NS + 'document-content' or not any(node.tag == ODF_OFFICE_NS + 'body' for node in root):
        raise ProjectionRefusal('document_invalid')
    return ['content.xml']


def paragraph_text(node, odf):
    if not odf:
        whitespace = {'tab': '\t', 'br': '\n', 'cr': '\n'}
        return ''.join((child.text or '') if local_name(child.tag) == 't' else whitespace.get(local_name(child.tag), '')
                       for child in node.iter())

    remaining = MAX_PROJECTION_CHARS
    pieces = []

    def append(piece):
        nonlocal remaining
        if piece:
            remaining -= len(piece)
            if remaining < 0:
                raise ProjectionRefusal('document_projection_limit')
            pieces.append(piece)

    def odf_text(part):
        tag = local_name(part.tag)
        if tag == 's':
            count = int(attributes(part).get('c', '1'))
            if not 0 < count <= remaining:
                raise ProjectionRefusal('document_projection_limit')
            append(' ' * count)
        elif tag in ('tab', 'line-break'):
            append('\t' if tag == 'tab' else '\n')
        else:
            append(part.text)
            for child in part:
                odf_text(child)
                append(child.tail)

    odf_text(node)
    return ''.join(pieces)


def visible_slide_text_bodies(root, presentation):
    def refuse():
        raise ProjectionRefusal('document_hidden_content', ['unhandled-slide-geometry'])

    def child(node, name, namespaces):
        matches = [part for part in node if local_name(part.tag) == name and projected_namespace(part, namespaces)]
        if len(matches) != 1:
            refuse()
        return matches[0]

    def coordinate(node, name):
        value = node.get(name, '')
        if not re.fullmatch(r'-?\d{1,10}', value):
            refuse()
        return int(value)

    if local_name(root.tag) != 'sld' or not projected_namespace(root, PRESENTATION_NAMESPACES):
        refuse()
    size = child(presentation, 'sldSz', PRESENTATION_NAMESPACES)
    width, height = coordinate(size, 'cx'), coordinate(size, 'cy')
    if width <= 0 or height <= 0:
        refuse()
    common = child(root, 'cSld', PRESENTATION_NAMESPACES)
    tree = child(common, 'spTree', PRESENTATION_NAMESPACES)
    # Master placeholders, animations, groups, custom backgrounds and overlaps
    # can conceal text. Only directly positioned, disjoint text boxes are read.
    if (any(local_name(part.tag) == 'bg' for part in common)
            or any(local_name(part.tag) == 'timing' for part in root)
            or len(tree) > 130):
        refuse()
    bodies, boxes = [], []
    for shape in tree:
        name = local_name(shape.tag)
        if not projected_namespace(shape, PRESENTATION_NAMESPACES):
            refuse()
        if name in ('nvGrpSpPr', 'grpSpPr'):
            if name == 'grpSpPr' and len(shape):
                refuse()
            continue
        if name != 'sp' or any(local_name(part.tag) in ('ph', 'style') for part in shape.iter()):
            refuse()
        properties = child(shape, 'spPr', PRESENTATION_NAMESPACES)
        transform = child(properties, 'xfrm', DRAW_NAMESPACES)
        if (len(transform) != 2 or transform.get('rot', '0') != '0'
                or any(transform.get(key, '0') not in ('0', 'false') for key in ('flipH', 'flipV'))):
            refuse()
        offset = child(transform, 'off', DRAW_NAMESPACES)
        extent = child(transform, 'ext', DRAW_NAMESPACES)
        x, y = coordinate(offset, 'x'), coordinate(offset, 'y')
        w, h = coordinate(extent, 'cx'), coordinate(extent, 'cy')
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width or y + h > height:
            refuse()
        if any(x < right and left < x + w and y < bottom and top < y + h for left, top, right, bottom in boxes):
            refuse()
        body = child(shape, 'txBody', PRESENTATION_NAMESPACES)
        body_properties = child(body, 'bodyPr', DRAW_NAMESPACES)
        if any(body_properties.get(key, 'overflow') != 'overflow' for key in ('vertOverflow', 'horzOverflow')):
            refuse()
        boxes.append((x, y, x + w, y + h))
        bodies.append(body)
    return bodies


def office_text(roots, ext):
    pieces = []
    remaining = MAX_PROJECTION_CHARS

    def charge(piece):
        nonlocal remaining
        remaining -= len(piece.encode('utf-16-le')) // 2 + 1
        if remaining < 0:
            raise ProjectionRefusal('document_projection_limit')
        return piece

    shared_root = roots.get('xl/sharedStrings.xml')
    if shared_root is not None:
        check_projection_namespace(shared_root, ext, shared=True)
    shared = [''.join(node.text or '' for node in entry.iter() if local_name(node.tag) == 't')
              for entry in shared_root] if shared_root is not None else []
    for part in office_sections(roots, ext):
        root = roots[part]
        check_projection_namespace(root, ext)
        lines = []
        if ext == '.xlsx':
            for row in (node for node in root.iter() if local_name(node.tag) == 'row'):
                cells = []
                for cell in row:
                    if local_name(cell.tag) != 'c':
                        continue
                    value = ''.join(node.text or '' for node in cell.iter() if local_name(node.tag) in ('v', 't'))
                    kind = cell.get('t')
                    if kind == 's':
                        if not value.isdecimal() or len(value) > 8 or int(value) >= len(shared):
                            raise ProjectionRefusal('document_invalid')
                        value = shared[int(value)]
                    elif kind == 'b':
                        if value not in ('0', '1'):
                            raise ProjectionRefusal('document_invalid')
                        value = 'TRUE' if value == '1' else 'FALSE'
                    elif kind not in (None, 'n', 'inlineStr', 'str', 'e', 'd'):
                        raise ProjectionRefusal('document_hidden_content', ['unhandled-cells'])
                    if value:
                        cells.append(charge(f"{cell.get('r', '')}: {value}"))
                if cells:
                    lines.append('\t'.join(cells))
        else:
            paragraph_roots = visible_slide_text_bodies(root, roots['ppt/presentation.xml']) if ext == '.pptx' else [root]
            for text_root in paragraph_roots:
                for node in text_root.iter():
                    if local_name(node.tag) not in ('p', 'h'):
                        continue
                    value = paragraph_text(node, ext in ('.odt', '.ods', '.odp'))
                    if value:
                        lines.append(charge(value))
        if lines:
            pieces.append('\n'.join(lines))
    return '\n\n'.join(pieces)


def office_preview(text, opts):
    # This is a reflowed preview of the supported text projection, not a native Office layout.
    # Pillow's bundled font has a deliberately small admitted glyph repertoire.
    if any(char not in '\n\r\t' and not 32 <= ord(char) <= 126 for char in text):
        raise ProjectionRefusal('document_render_unavailable')
    from PIL import Image, ImageDraw, ImageFont
    font = ImageFont.load_default(size=24)
    columns = max(1, 880 // (math.ceil(max(font.getlength(chr(i)) for i in range(32, 127))) + 1))
    lines = []
    for line in text.split('\n'):
        lines.extend(textwrap.wrap(line.expandtabs(4), width=columns, replace_whitespace=False) or [''])
    total = max(1, math.ceil(len(lines) / 34))
    if total > MAX_PAGES:
        raise ProjectionRefusal('document_projection_limit')

    def render(index):
        image = Image.new('RGB', (960, 1200), 'white')
        draw = ImageDraw.Draw(image)
        draw.text((36, 24), 'Office content preview (reflowed text)', font=font, fill='black')
        for offset, line in enumerate(lines[index * 34:(index + 1) * 34]):
            draw.text((36, 64 + offset * 32), line, font=font, fill='black')
        return image

    return protected_pages(total, opts, 'office-content-preview', render)


def read_protected_zip(data, ext, opts):
    if opts['ownerStub']:
        raise ProjectionRefusal('document_stub')
    if data.startswith(b'\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1'):
        raise ProjectionRefusal('document_encrypted')
    if ext in ('.docm', '.pptm', '.xlsm'):
        raise ProjectionRefusal('document_hidden_content', ['macros'])
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        entries = z.infolist()
        if len(entries) > 10000 or sum(entry.file_size for entry in entries) > MAX_DOCUMENT * 2:
            raise ProjectionRefusal('document_projection_limit')
        names, paths, roots, budget = set(), set(), {}, MAX_XML
        for entry in entries:
            name, lower = entry.filename, entry.filename.lower()
            if lower in names or entry.orig_filename != name or name.startswith('/') or '\\' in name or ':' in name or '..' in name.split('/'):
                raise ProjectionRefusal('document_invalid')
            names.add(lower)
            paths.add(name)
            if entry.flag_bits & 1:
                raise ProjectionRefusal('document_encrypted')
            if not lower.endswith(('.xml', '.rels')):
                continue
            if entry.file_size > MAX_ENTRY or entry.file_size > budget:
                raise ProjectionRefusal('document_projection_limit')
            budget -= entry.file_size
            raw = z.read(entry)
            declaration_probe = raw.replace(b'\x00', b'').upper()
            if b'<!DOCTYPE' in declaration_probe or b'<!ENTITY' in declaration_probe:
                raise ProjectionRefusal('document_hidden_content', ['xml-entities'])
            roots[name] = ET.fromstring(raw)
        found = set(ooxml_hidden_parts(names)) | office_layers(roots, ext)
        if any(name.startswith(('ppt/notesslides/', 'xl/externallinks/', 'xl/querytables/', 'xl/pivotcache/',
                                'scripts/', 'basic/', 'object ', 'objectreplacements/')) for name in names):
            found.add('unhandled-private-parts')
        if found:
            raise ProjectionRefusal('document_hidden_content', found)
        for name in roots:
            if not name.endswith('.rels'):
                continue
            parent, folder, rel = name.rsplit('/', 2) if name.count('/') > 1 else ('', *name.split('/', 1))
            if folder != '_rels' or any(target not in paths for target in package_relationships(roots, posixpath.join(parent, rel[:-5])).values()):
                raise ProjectionRefusal('document_hidden_content', ['unhandled-relationships'])
        text = office_text(roots, ext)
        result = protected_text(text)
        return office_preview(text, opts) if opts['visual'] else result


PDF_LAYER_KEYS = {
    '/AcroForm': 'form', '/Annots': 'annotations', '/OpenAction': 'open-action',
    '/AA': 'additional-actions', '/JS': 'javascript', '/JavaScript': 'javascript',
    '/AF': 'embedded-files', '/EF': 'embedded-files', '/EmbeddedFiles': 'embedded-files',
    '/OCProperties': 'optional-content', '/OC': 'optional-content',
    '/ActualText': 'alternate-text', '/Alt': 'alternate-text',
}
PDF_ACTIVE_ACTIONS = {'/Launch', '/JavaScript', '/GoToR', '/GoToE', '/URI', '/SubmitForm',
                      '/ImportData', '/Rendition', '/Movie', '/Sound', '/RichMedia', '/SetOCGState'}
PDF_STANDARD_FONTS = {f'/{name}' for name in (
    'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold',
    'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic',
    'Times-BoldItalic', 'Symbol', 'ZapfDingbats',
)}
PDF_TEXT_OPERATORS = {b'q', b'Q', b'cm', b'BT', b'ET', b'Tf', b'Tc', b'Tw', b'Tz', b'TL', b'Tr', b'Ts',
                      b'Td', b'TD', b'Tm', b'T*', b'Tj', b'TJ', b"'", b'"', b'G', b'g', b'RG', b'rg', b'K', b'k'}
PDF_BLACK = {b'G': [0], b'g': [0], b'RG': [0, 0, 0], b'rg': [0, 0, 0], b'K': [0, 0, 0, 1], b'k': [0, 0, 0, 1]}


def pdf_name(obj, key):
    value = obj.get(key)
    return str(value.get_object()) if value is not None else ''


def pdf_graph_layers(reader):
    from pypdf.generic import ArrayObject, DictionaryObject, StreamObject
    pending = [reader.root_object]
    visited = {}
    found = set()
    while pending:
        value = pending.pop().get_object()
        if not isinstance(value, (DictionaryObject, ArrayObject)) or id(value) in visited:
            continue
        visited[id(value)] = value
        if len(visited) + len(pending) > 25000:
            raise ProjectionRefusal('document_projection_limit')
        if isinstance(value, ArrayObject):
            pending.extend(value)
            continue
        found.update(PDF_LAYER_KEYS[key] for key in PDF_LAYER_KEYS if key in value)
        if pdf_name(value, '/S') in PDF_ACTIVE_ACTIONS:
            found.add('active-actions')
        if pdf_name(value, '/Type') in ('/EmbeddedFile', '/Filespec') or isinstance(value, StreamObject) and '/F' in value:
            found.add('embedded-or-external-streams')
        # Descriptive metadata is discarded, not parsed or propagated.
        pending.extend(item for key, item in value.items() if key != '/Metadata')
    return found


def pdf_font_is_renderable(font):
    if pdf_name(font, '/Subtype') == '/Type3':
        return False
    if pdf_name(font, '/BaseFont') in PDF_STANDARD_FONTS and pdf_name(font, '/Subtype') == '/Type1':
        return True
    descendants = font.get('/DescendantFonts')
    fonts = [value.get_object() for value in descendants.get_object()] if descendants is not None else [font]
    for item in fonts:
        descriptor = item.get('/FontDescriptor')
        if descriptor is None or not any(key in descriptor.get_object() for key in ('/FontFile', '/FontFile2', '/FontFile3')):
            return False
    return bool(fonts)


def pdf_font_has_visible_text(font):
    # Embedded programs, custom encoding maps and alternate Unicode mappings can
    # represent different visible glyphs from the extracted text.
    return (pdf_name(font, '/Subtype') == '/Type1' and pdf_name(font, '/BaseFont') in PDF_STANDARD_FONTS
            and pdf_name(font, '/BaseFont') not in ('/Symbol', '/ZapfDingbats')
            and pdf_name(font, '/Encoding') in ('', '/WinAnsiEncoding', '/MacRomanEncoding')
            and not any(key in font for key in ('/FontDescriptor', '/ToUnicode', '/Widths')))


def check_pdf_operations(reader, pages, visual):
    from pypdf.generic import ContentStream
    budget = [MAX_XML, 250000]
    def inspect(stream, resources, parents=()):
        if stream is None:
            return
        if len(parents) > 12 or id(stream) in parents:
            raise ProjectionRefusal('document_projection_limit')
        data = stream.get_data()
        budget[0] -= len(data)
        if budget[0] < 0:
            raise ProjectionRefusal('document_projection_limit')
        content = stream if isinstance(stream, ContentStream) else ContentStream(stream, reader)
        for args, operator in content.operations:
            budget[1] -= 1
            if budget[1] < 0:
                raise ProjectionRefusal('document_projection_limit')
            if operator == b'Tr' and (len(args) != 1 or args[0] not in (0, 1, 2, 4, 5, 6)):
                raise ProjectionRefusal('document_hidden_content', ['invisible-text'])
            if operator == b'BDC' and args and args[0] == '/OC':
                raise ProjectionRefusal('document_hidden_content', ['optional-content'])
            if operator == b'gs':
                state = resources['/ExtGState'][args[0]]
                if any(key in state and float(state[key]) == 0 for key in ('/ca', '/CA')) or pdf_name(state, '/SMask') not in ('', '/None'):
                    raise ProjectionRefusal('document_hidden_content', ['hidden-graphics-state'])
            if not visual:
                # The text-only path never interprets arbitrary paint, clipping,
                # patterns, masks or alternate content as reliably visible text.
                if operator not in PDF_TEXT_OPERATORS or operator in PDF_BLACK and args != PDF_BLACK[operator]:
                    raise ProjectionRefusal('document_visual_required')
                if operator == b'Tr' and args != [0]:
                    raise ProjectionRefusal('document_visual_required')
            if operator == b'Tf':
                font = resources['/Font'][args[0]]
                if visual and not pdf_font_is_renderable(font):
                    raise ProjectionRefusal('document_render_unavailable')
                if not visual and not pdf_font_has_visible_text(font):
                    raise ProjectionRefusal('document_visual_required')
            if operator != b'Do':
                continue
            xobject = resources['/XObject'][args[0]]
            if pdf_name(xobject, '/Subtype') == '/Image':
                if not visual:
                    raise ProjectionRefusal('document_visual_required')
            elif pdf_name(xobject, '/Subtype') == '/Form':
                if '/Ref' in xobject:
                    raise ProjectionRefusal('document_hidden_content', ['external-form'])
                local = xobject.get('/Resources')
                inspect(xobject, local.get_object() if local is not None else resources, (*parents, id(stream)))
            else:
                raise ProjectionRefusal('document_hidden_content', ['unhandled-xobject'])

    for page in pages:
        resources = page.get('/Resources')
        inspect(page.get_contents(), resources.get_object() if resources is not None else {})


def check_pdf_text_crop(page):
    left, top, right, bottom = page.cropbox
    ml, mt, mr, mb = page.mediabox
    left, top, right, bottom = max(left, ml), max(top, mt), min(right, mr), min(bottom, mb)
    if not all(math.isfinite(n) for n in (left, top, right, bottom)) or left >= right or top >= bottom:
        raise ProjectionRefusal('document_visual_required')
    boxes = []
    for item in page.chars:
        if not item['text'].strip():
            continue
        x0, y0, x1, y1 = item['x0'], item['top'], item['x1'], item['bottom']
        if not all(math.isfinite(n) for n in (x0, y0, x1, y1)) or x1 - x0 < 1 or y1 - y0 < 1:
            raise ProjectionRefusal('document_visual_required')
        if x0 < left or y0 < top or x1 > right or y1 > bottom:
            raise ProjectionRefusal('document_hidden_content', ['outside-visible-page'])
        boxes.append((x0, y0, x1, y1))
        if len(boxes) > MAX_PROJECTION_CHARS:
            raise ProjectionRefusal('document_projection_limit')
    # Detect text overpaint while allowing ordinary adjacent kerning. Dense
    # coincident text must take the actual raster route.
    active, checks = [], 0
    for box in sorted(boxes, key=lambda item: item[1]):
        x0, y0, x1, y1 = box
        active = [other for other in active if other[3] > y0]
        checks += len(active)
        if checks > 1000000:
            raise ProjectionRefusal('document_visual_required')
        for a, b, c, d in active:
            overlap_x = min(x1, c) - max(x0, a)
            overlap_y = min(y1, d) - max(y0, b)
            if overlap_x > 0 and overlap_y > 0 and overlap_x * overlap_y > 0.25 * min((x1 - x0) * (y1 - y0), (c - a) * (d - b)):
                raise ProjectionRefusal('document_visual_required')
        active.append(box)


def read_protected_pdf(data, opts):
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data), strict=True)
    if reader.is_encrypted:
        raise ProjectionRefusal('document_encrypted')
    found = pdf_graph_layers(reader)
    if found:
        raise ProjectionRefusal('document_hidden_content', found)
    total = len(reader.pages)
    if not 0 < total <= MAX_PAGES:
        raise ProjectionRefusal('document_projection_limit')
    check_pdf_operations(reader, reader.pages, opts['visual'])
    if opts['visual']:
        import pypdfium2
        try:
            with pypdfium2.PdfDocument(data) as document:
                if len(document) != total:
                    raise ProjectionRefusal('document_render_unavailable')

                def render(index):
                    page = document[index]
                    try:
                        width, height = page.get_size()
                        if not all(math.isfinite(n) and n > 0 for n in (width, height)):
                            raise ProjectionRefusal('document_render_unavailable')
                        scale = min(2, 1599 / max(width, height))
                        bitmap = page.render(scale=scale, may_draw_forms=False, draw_annots=False, limit_image_cache=True)
                        try:
                            return bitmap.to_pil().convert('RGB')
                        finally:
                            bitmap.close()
                    finally:
                        page.close()

                return protected_pages(total, opts, 'pdf-pages', render)
        except ProjectionRefusal:
            raise
        except Exception as exc:
            raise ProjectionRefusal('document_render_unavailable') from exc

    import pdfplumber
    with pdfplumber.open(io.BytesIO(data)) as document:
        if len(document.pages) != total:
            raise ProjectionRefusal('document_invalid')
        hidden = pdf_hidden_layers(document)
        if hidden:
            raise ProjectionRefusal('document_hidden_content', hidden)
        pieces, length = [], 0
        for index, page in enumerate(document.pages, 1):
            check_pdf_text_crop(page)
            page_text = page.extract_text() or ''
            if '\ufffd' in page_text or re.search(r'\(cid:\d+\)', page_text):
                raise ProjectionRefusal('document_visual_required')
            piece = f'## Page {index}\n{page_text}'
            length += len(piece) + 2
            if length > MAX_PROJECTION_CHARS:
                raise ProjectionRefusal('document_projection_limit')
            pieces.append(piece)
            page.close()
        return protected_text('\n\n'.join(pieces))


def protected_main():
    logging.disable(logging.CRITICAL)
    warnings.simplefilter('ignore')
    try:
        _, ext, raw = sys.argv[1:4]
        opts = json.loads(raw)
        if ext not in OFFICE_EXTENSIONS | {'.pdf'} or not isinstance(opts, dict) or set(opts) != {'pageOffset', 'pageLimit', 'visual', 'ownerStub'}:
            raise ProjectionRefusal('document_invalid')
        if (type(opts['pageOffset']) is not int or not 1 <= opts['pageOffset'] <= 100000
                or type(opts['pageLimit']) is not int or not 1 <= opts['pageLimit'] <= 2
                or type(opts['visual']) is not bool or type(opts['ownerStub']) is not bool):
            raise ProjectionRefusal('document_invalid')
        data = sys.stdin.buffer.read(MAX_DOCUMENT + 1)
        if len(data) > MAX_DOCUMENT:
            raise ProjectionRefusal('document_projection_limit')
        if not data:
            raise ProjectionRefusal('document_invalid')
        return read_protected_pdf(data, opts) if ext == '.pdf' else read_protected_zip(data, ext, opts)
    except ProjectionRefusal as exc:
        return protected_refusal(exc.code, exc.found)
    except ImportError:
        return protected_refusal('reader_unavailable')
    except Exception:
        return protected_refusal('document_invalid')


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


if sys.argv[1:2] == ['--protected']:
    output = protected_main()
else:
    try:
        output = main()
    except ImportError as exc:
        output = {'ok': False, 'code': 'reader_unavailable', 'error': f'Missing native reader dependency: {exc.name}',
                  'hint': 'Install pdfplumber for PDF or Pillow for image conversion in the Python runtime. No computer use/MCP connection is needed.'}
    except Exception as exc:
        output = {'ok': False, 'code': 'document_invalid', 'error': str(exc)[:300],
                  'hint': 'Check the file format; for containers archive_unzip can inspect the entries.'}
print(json.dumps(output, ensure_ascii=True))
