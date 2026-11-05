// Isolated uploads migration owner draft. Enrolls the raw uploads layout
// (uploads/<id>/<name> and uploads/toolimg_*/<name>), seals every file through
// the attachment runtimes, verifies the whole set, and only then removes the
// originals. No migration host is wired yet.
const WorkDataUploadsOwner = ((fsp, nodePath) => {
  const FACE_OF = value => /^file_[A-Za-z0-9]+$/.test(value) ? 'attachment' : /^toolimg_/.test(value) ? 'toolImage' : null;
  const MIME = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    bmp: 'image/bmp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', webm: 'audio/webm', ogg: 'audio/ogg', flac: 'audio/flac' });
  const fail = (suffix, details = {}) => { throw Object.assign(Error('work_data_uploads_owner.' + suffix), {
    code: 'work_data_uploads_owner.' + suffix, apiCode: 'work_data_uploads_owner.' + suffix, statusCode: 409, ...details,
  }); };
  const mimeOf = name => MIME[String(name).slice(String(name).lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';
  const kindOf = face => face === 'attachment' ? 'original' : 'tool-image';
  function create({ root, keys, enabled } = {}) {
    if (typeof root !== 'string' || !nodePath.isAbsolute(root)) fail('root');
    const attachment = WorkDataAttachmentRuntime.create({ root, keys, enabled, face: 'attachment', allowSealedRemoval: true });
    const toolImage = WorkDataAttachmentRuntime.create({ root, keys, enabled, face: 'toolImage', allowSealedRemoval: true });
    const runtimeOf = face => face === 'attachment' ? attachment : toolImage;
    async function writeRestored(runtime, row, targetRoot) {
      const info = await runtime.stat(row.id);
      const dir = nodePath.join(targetRoot, row.id);
      let exists = true;
      try {
        const stat = await fsp.lstat(dir, { bigint: true });
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('path', { id: row.id });
        const real = await fsp.realpath(dir);
        if ((process.platform === 'win32' ? real.toLowerCase() : real) !== (process.platform === 'win32' ? dir.toLowerCase() : dir)) fail('path', { id: row.id });
      } catch (error) { if (!error || error.code !== 'ENOENT') throw error; exists = false; }
      if (!exists) await fsp.mkdir(dir, { recursive: true });
      const handle = await fsp.open(nodePath.join(dir, row.logicalName), 'wx');
      let size = 0;
      try {
        for (let offset = 0; offset < info.totalBytes; offset += WorkDataAttachmentChunks.CHUNK_BYTES) {
          const lease = await runtime.read(row.id, offset, Math.min(info.totalBytes, offset + WorkDataAttachmentChunks.CHUNK_BYTES));
          let bytes = null;
          try {
            bytes = Buffer.from(lease.bytes); size += bytes.length;
            await handle.write(bytes, 0, bytes.length, offset);
          } finally { try { lease.release(); } catch {} if (bytes) bytes.fill(0); }
        }
      } finally { await handle.close(); }
      if (size !== info.totalBytes) fail('restore_size', { id: row.id });
      return size;
    }
    async function enroll() {
      let entries;
      try { entries = await fsp.readdir(root, { withFileTypes: true }); }
      catch (error) { if (error && error.code === 'ENOENT') return Object.freeze({ files: [], unsupported: [], sealed: 0 }); throw error; }
      const files = [], unsupported = [];
      let sealed = 0;
      for (const entry of entries) {
        const name = entry.name;
        if (name === '_catalog-attachments-v1.json' || name === '_catalog-tool-images-v1.json') continue;
        if (!entry.isDirectory()) { unsupported.push({ name, reason: 'root-file' }); continue; }
        if (/^[a-f0-9]{32}$/i.test(name)) { sealed++; continue; }
        const face = FACE_OF(name);
        if (!face) { unsupported.push({ name, reason: 'unknown-directory' }); continue; }
        let children;
        try { children = await fsp.readdir(nodePath.join(root, name), { withFileTypes: true }); }
        catch { unsupported.push({ name, reason: 'unreadable' }); continue; }
        const regular = children.filter(child => child.isFile());
        if (regular.length !== 1 || children.length !== 1) { unsupported.push({ name, reason: 'not-single-file' }); continue; }
        let size;
        try { size = (await fsp.lstat(nodePath.join(root, name, regular[0].name), { bigint: true })).size; }
        catch { unsupported.push({ name, reason: 'unreadable' }); continue; }
        if (size === 0n) { unsupported.push({ name, reason: 'empty-file' }); continue; }
        if (size > BigInt(WorkDataAttachmentChunks.MAX_BYTES)) { unsupported.push({ name, reason: 'too-large' }); continue; }
        files.push(Object.freeze({ id: name, face, file: regular[0].name, size: Number(size) }));
      }
      return Object.freeze({ files: Object.freeze(files), unsupported: Object.freeze(unsupported), sealed });
    }
    return Object.freeze({
      enroll,
      async sealAll() {
        const report = await enroll();
        if (report.unsupported.length) fail('unsupported', { unsupported: report.unsupported });
        const sealed = [], verified = [];
        for (const row of report.files) {
          const bytes = await fsp.readFile(nodePath.join(root, row.id, row.file));
          const receipt = await runtimeOf(row.face).seal({ id: row.id, kind: kindOf(row.face), logicalName: row.file, mime: mimeOf(row.file), data: bytes });
          sealed.push(Object.freeze({ ...receipt, face: row.face, file: row.file }));
        }
        for (const row of sealed) { await runtimeOf(row.face).verify(row.id); verified.push(row.id); }
        const removed = [];
        for (const row of sealed) {
          const dir = nodePath.join(root, row.id);
          const stat = await fsp.lstat(dir, { bigint: true });
          if (!stat.isDirectory() || stat.isSymbolicLink()) fail('path', { id: row.id });
          const real = await fsp.realpath(dir);
          if ((process.platform === 'win32' ? real.toLowerCase() : real) !== (process.platform === 'win32' ? dir.toLowerCase() : dir)) fail('path', { id: row.id });
          await fsp.rm(dir, { recursive: true, force: true });
          removed.push(row.id);
        }
        return Object.freeze({ sealed: Object.freeze(sealed), verified: Object.freeze(verified), removed: Object.freeze(removed), alreadySealed: report.sealed });
      },
      // ON->OFF: every sealed row is read back, written under its original id/file
      // with wx, and only then retired from the catalog. A failed write keeps both
      // copies (never a silent plaintext-only or sealed-only state).
      async unsealAll() {
        const restored = [], retired = [];
        for (const face of ['attachment', 'toolImage']) {
          const runtime = runtimeOf(face);
          const rows = await runtime.list();
          for (const row of rows) {
            if (row.state !== 'sealed') continue;
            const size = await writeRestored(runtime, row, root);
            await runtime.retireSealed(row.id);
            restored.push(Object.freeze({ id: row.id, face, file: row.logicalName, size }));
            retired.push(row.id);
          }
        }
        return Object.freeze({ restored: Object.freeze(restored), retired: Object.freeze(retired) });
      },
      // OFF direction without mutating the source: every sealed row is read and
      // written into another root (the candidate generation), and no row is retired.
      async unsealInto({ target } = {}) {
        if (typeof target !== 'string' || !nodePath.isAbsolute(target)) fail('target', { target });
        const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
        const resolved = nodePath.resolve(target), source = nodePath.resolve(root);
        if (fold(resolved) === fold(source)) fail('target_same');
        const within = (outer, inner) => { const rel = nodePath.relative(fold(outer), fold(inner)); return rel === '' || rel !== '..' && !rel.startsWith('..' + nodePath.sep) && !nodePath.isAbsolute(rel); };
        if (within(resolved, source) || within(source, resolved)) fail('target_overlap');
        let stat = null;
        try { stat = await fsp.lstat(resolved, { bigint: true }); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail('target');
        await fsp.mkdir(resolved, { recursive: true });
        const real = await fsp.realpath(resolved);
        if (fold(real) !== fold(resolved)) fail('target');
        const restored = [];
        for (const face of ['attachment', 'toolImage']) {
          const runtime = runtimeOf(face);
          for (const row of await runtime.list()) {
            if (row.state !== 'sealed') continue;
            const size = await writeRestored(runtime, row, resolved);
            restored.push(Object.freeze({ id: row.id, face, file: row.logicalName, size }));
          }
        }
        return Object.freeze({ restored: Object.freeze(restored), retired: Object.freeze([]) });
      },
    });
  }
  return Object.freeze({ create });
})(require('node:fs/promises'), require('node:path'));
