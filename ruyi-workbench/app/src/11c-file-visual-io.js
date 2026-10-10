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
  async function kind(p) {
    if (DOCUMENT_EXT.test(p)) return 'document';
    if (IMAGE_EXT.test(p)) return 'image';
    const fh = await io.open(p, 'r');
    try { const b = Buffer.alloc(16); const r = await fh.read(b, 0, b.length, 0); return mime(b.subarray(0, r.bytesRead)) ? 'image' : null; }
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
  return Object.freeze({ kind, image, document, linkedImages });
})();
