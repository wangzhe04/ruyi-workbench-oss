// 11c-file-visual-io.js - Bounded native image/document reads; no desktop or MCP dependency.
const FileVisualIo = (() => {
  const io = require('fs/promises');
  const paths = require('path');
  const cp = require('child_process');
  const cryptoModule = require('crypto');
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?)$/i;
  const DOCUMENT_EXT = /\.(pdf|docx|docm|dotx|pptx|pptm|xlsx|xlsm|odt|ods|odp)$/i;
  const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;
  // 隐私 M4(2026-11-05):PDF 隐藏层(嵌入文件/脚本/表单/打开动作/批注)不在「抽取出来的正文」里。
  // 判据【不能】放在 JS 里按原始字节找字面名 —— 复审实测:合法的 `/J#53cript` 名转义与 PDF 1.5+ 对象流
  // 都能 100% 绕过,而正文里出现 "/JavaScript" 的良性文档会被误拒。所以判据放在真正的解析器里
  // (resources/native-file-read.py 的 pdf_hidden_layers:查 catalog 与页面 annots),那边发现就整份拒绝
  // (code: document_hidden_content)。JS 这层只负责把结果原样交回,不再自己猜。
  const clamp = (v, fallback, min, max) => Number.isFinite(Number(v)) && v != null
    ? Math.max(min, Math.min(max, Math.floor(Number(v)))) : fallback;
  function options(args) {
    return {
      offset: clamp(args.offset, 0, 0, 10000000), limit: clamp(args.limit, 40000, 2, 50000),
      includeImages: args.includeImages !== false,
      imageOffset: clamp(args.imageOffset, 0, 0, 100000), imageLimit: clamp(args.imageLimit, 2, 1, 2),
      pageOffset: clamp(args.pageOffset, 1, 1, 100000), pageLimit: clamp(args.pageLimit, 2, 1, 2),
    };
  }
  function mime(buf) {
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
    if (buf.length >= 3 && buf[0] === 255 && buf[1] === 216 && buf[2] === 255) return 'image/jpeg';
    if (/^GIF8[79]a$/.test(buf.subarray(0, 6).toString('ascii'))) return 'image/gif';
    if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
    return '';
  }
  async function readBounded(p, cap) {
    const fh = await io.open(p, 'r');
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' });
      if (st.size > cap) throw Object.assign(new Error(`file exceeds ${cap} bytes`), { code: 'file_too_large' });
      const buf = Buffer.alloc(Math.min(st.size + 1, cap + 1));
      let n = 0;
      while (n < buf.length) { const r = await fh.read(buf, n, buf.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
      if (n > cap) throw Object.assign(new Error(`file exceeds ${cap} bytes`), { code: 'file_too_large' });
      return buf.subarray(0, n);
    } finally { await fh.close(); }
  }
  // Probe bytes as well as suffixes: renamed images must never be decoded as text.
  async function kind(p, protectedRead = false) {
    if (DOCUMENT_EXT.test(p)) return 'document';
    if (IMAGE_EXT.test(p)) return 'image';
    if (protectedRead && VIDEO_EXT.test(p)) return 'video';
    const fh = await io.open(p, 'r');
    try {
      const header = Buffer.alloc(protectedRead ? 1024 : 16);
      const { bytesRead } = await fh.read(header, 0, header.length, 0);
      const b = header.subarray(0, bytesRead);
      if (mime(b)) return 'image';
      if (protectedRead) {
        const first = b.subarray(0, 4).toString('hex');
        if (b.includes('%PDF-') || ['504b0304', '504b0506', '504b0708'].includes(first)) return 'document';
        if (first === '1a45dfa3' || b.subarray(4, 8).toString('ascii') === 'ftyp'
          || first === '52494646' && b.subarray(8, 12).toString('ascii') === 'AVI ') return 'video';
      }
      return null;
    }
    finally { await fh.close(); }
  }
  async function image(p, args) {
    const buf = await readBounded(p, MAX_IMAGE_BYTES);
    const media = mime(buf);
    if (!media) return null; // BMP/TIFF/ICO need conversion before sending to providers.
    const sha256 = cryptoModule.createHash('sha256').update(buf).digest('hex');
    return { ok: true, path: p, mode: 'image', size: buf.length, mimeType: media, sha256,
      content: `Image ${paths.basename(p)} (${buf.length} bytes, sha256 ${sha256}). Pixels are attached for vision models; no text/OCR was extracted.`,
      ...(args.includeImages === false ? {} : { images: [{ name: paths.basename(p), mimeType: media, data: buf.toString('base64') }] }) };
  }
  async function document(p, args, helperPath, signal) {
    const st = await io.stat(p);
    if (!st.isFile()) throw Object.assign(new Error('not a regular file'), { code: 'EISDIR' });
    if (st.size > MAX_FILE_BYTES) return { ok: false, code: 'file_too_large', error: 'Document exceeds 50MB; split it before reading.', path: p };
    // M4:只有 PDF 能把页面渲染成像素(pdfplumber 的 page.to_image)。Office/ODF 没有渲染器 ——
    // 调用方要的是像素,这里再回一段正文就是静默的类型错配(2026-11-05 实测 as:'image' 返回 ok:true
    // + mode:'document' + 0 张图)。渲染 + 遮盖那条链路没做完之前,这条路由显式拒绝。
    if (args && args.as === 'image' && !/\.pdf$/i.test(p)) {
      return { ok: false, code: 'document_render_unavailable', path: p,
        error: 'This document format cannot be rendered to pixels by the native reader.',
        hint: 'Read it as text (omit as:"image", or use as:"text"), or export the page you need as an image/PDF from an editor and read that file.' };
    }
    const candidates = [];
    if (process.env.RUYI_BUNDLED_PYTHON) candidates.push([process.env.RUYI_BUNDLED_PYTHON, []]);
    candidates.push(['python', []], process.platform === 'win32' ? ['py', ['-3']] : ['python3', []]);
    for (const [exe, pre] of candidates) {
      const res = await new Promise(resolve => {
        cp.execFile(exe, [...pre, '-I', '-X', 'utf8', helperPath, p, JSON.stringify(options(args))],
          { windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}) },
          (err, stdout) => resolve({ err, stdout }));
      });
      if (res.err && (res.err.code === 'ENOENT' || res.err.code === 9009)) continue;
      if (signal && signal.aborted) return { ok: false, code: 'aborted', error: 'File read cancelled', path: p };
      if (res.err) return { ok: false, code: 'document_read_failed', error: 'Document reader failed or exceeded its time/output limit', path: p };
      try { return { ...JSON.parse(res.stdout), path: p, size: st.size }; }
      catch { return { ok: false, code: 'document_read_failed', error: 'Invalid document reader response', path: p }; }
    }
    return { ok: false, code: 'reader_unavailable', error: 'Native document reading needs Python', path: p,
      hint: 'Use the bundled Python runtime or install Python. PDF requires pdfplumber; image conversion requires Pillow. No computer use/MCP connection is needed.' };
  }
  const documentRefusals = new Set(['document_encrypted', 'document_stub', 'document_hidden_content', 'document_projection_limit',
    'document_visual_required', 'document_render_unavailable', 'document_page_range', 'document_invalid', 'reader_unavailable']);
  async function protectedDocument(p, args, _helperPath, signal, bytes) {
    const refuse = (code, hint) => ({ ok: false, code, hint });
    const cancelled = () => refuse('aborted', 'The protected document read was cancelled.');
    const unavailable = () => refuse('reader_unavailable', 'Use the Full offline package with the verified media runtime.');
    const invalid = () => refuse('document_read_failed', 'The protected document reader failed or returned an invalid projection.');
    const ext = paths.extname(p).toLowerCase();
    if (signal?.aborted) return cancelled();
    if (!DOCUMENT_EXT.test(ext)) return refuse('document_unsupported', 'Use a supported document extension matching the actual file format.');
    if (!Buffer.isBuffer(bytes) || !bytes.length) return invalid();
    if (bytes.length > MAX_FILE_BYTES) return refuse('document_projection_limit', 'Split the document into smaller clean copies.');
    if (typeof MediaImageHooks === 'undefined' || typeof MediaImageHooks.runLocalMediaHelper !== 'function') return unavailable();
    const { pageOffset, pageLimit } = options(args);
    const visual = args.as === 'image';
    const opts = { pageOffset, pageLimit, visual, ownerStub: paths.win32.basename(p).startsWith('~$') };
    let result;
    try {
      result = await MediaImageHooks.runLocalMediaHelper('native-file-read.py', ['--protected', ext, JSON.stringify(opts)], bytes,
        { signal, timeoutMs: 30000, maxBytes: 12 * 1024 * 1024 });
    } catch (error) {
      if (signal?.aborted) return cancelled();
      if (['privacy.image_runtime_unavailable', 'reader_unavailable'].includes(error?.code)) return unavailable();
      if (error?.code === 'privacy.image_worker_timeout') return refuse('document_read_timeout', 'The protected document read timed out. Split it into a smaller clean copy.');
      return invalid();
    }
    if (signal?.aborted) return cancelled();
    if (result?.ok === false && documentRefusals.has(result.code) && typeof result.hint === 'string' && result.hint.length <= 300) {
      const found = Array.isArray(result.found) && result.found.length <= 32
        && result.found.every(layer => typeof layer === 'string' && /^[a-z-]{1,40}$/.test(layer)) ? { found: result.found } : {};
      return { ...refuse(result.code, result.hint), ...found };
    }
    if (result?.ok !== true || result.mode !== 'document' || typeof result.content !== 'string' || !Array.isArray(result.images)) return invalid();
    const { projection, content, images } = result;
    if (!visual) {
      return projection === 'document-text' && content.length <= 40000 && !images.length
        ? { ok: true, mode: 'document', projection, content, images: [] } : invalid();
    }
    const { totalPages, nextPageOffset } = result;
    if (projection !== (ext === '.pdf' ? 'pdf-pages' : 'office-content-preview') || content.length > 200
      || !Number.isSafeInteger(totalPages) || totalPages < pageOffset || result.pageOffset !== pageOffset
      || images.length !== Math.min(pageLimit, totalPages - pageOffset + 1)) return invalid();
    const end = pageOffset + images.length;
    if (nextPageOffset !== (end <= totalPages ? end : undefined)) return invalid();
    for (const [index, image] of images.entries()) {
      if (image?.name !== `page-${pageOffset + index}.png` || image.mimeType !== 'image/png'
        || typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return invalid();
      const buf = Buffer.from(image.data, 'base64');
      try {
        if (buf.length < 24 || buf.length > MAX_IMAGE_BYTES || buf.toString('base64') !== image.data || mime(buf) !== 'image/png'
          || buf.toString('ascii', 12, 16) !== 'IHDR' || ![buf.readUInt32BE(16), buf.readUInt32BE(20)].every(n => n > 0 && n <= 1600)) return invalid();
      } finally { buf.fill(0); }
    }
    return { ok: true, mode: 'document', projection, content, pageOffset, totalPages,
      ...(nextPageOffset === undefined ? {} : { nextPageOffset }), images: images.map(({ name, mimeType, data }) => ({ name, mimeType, data })) };
  }
  // Only explicitly requested Markdown/HTML images are followed. Every local link gets the caller's guard.
  async function linkedImages(p, content, args, guard) {
    if (args.includeImages !== true || !/\.(md|markdown|html?|xhtml)$/i.test(p)) return {};
    const refs = [];
    const re = /!\[[^\]\n]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^\n]*?["'])?\s*\)|<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(content)) && refs.length < 1000) refs.push(m[1] || m[2] || m[3]);
    const unique = [...new Set(refs)], opt = options(args), images = [], imageWarnings = [];
    const selected = unique.slice(opt.imageOffset, opt.imageOffset + opt.imageLimit);
    for (const ref of selected) {
      try {
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(ref)) { imageWarnings.push({ source: ref.slice(0, 200), code: 'non_local_image', hint: 'Download remote images with http_download, then file_read the saved path.' }); continue; }
        const target = paths.resolve(paths.dirname(p), decodeURIComponent(ref.replace(/[?#].*$/, '')));
        const g = await guard(target);
        if (!g.ok) { imageWarnings.push({ source: ref, code: g.code || 'not-allowed' }); continue; }
        const r = await image(target, args);
        if (r && r.images) images.push({ ...r.images[0], source: ref });
        else imageWarnings.push({ source: ref, code: 'unsupported_image', hint: 'Read this image path directly to convert it.' });
      } catch (e) { imageWarnings.push({ source: ref, code: e.code || 'image_read_failed' }); }
    }
    return { images, imageWarnings, totalImages: unique.length,
      ...(opt.imageOffset + selected.length < unique.length ? { nextImageOffset: opt.imageOffset + selected.length } : {}) };
  }
  return Object.freeze({ kind, image, document, protectedDocument, linkedImages });
})();
