// Isolated attachment runtime facade. Composes the per-face catalogs, the sealed
// writer and the reader for one data root, and owns the id/location derivation
// both the upload and download paths must share. No HTTP route is wired here.
const WorkDataAttachmentRuntime = ((fsp, nodePath, cryptoApi) => {
  const idPattern = /^[A-Za-z0-9_.:-]{1,64}$/;
  const fail = suffix => { throw Object.assign(Error('work_data_attachment_runtime.' + suffix), {
    code: 'work_data_attachment_runtime.' + suffix, apiCode: 'work_data_attachment_runtime.' + suffix, statusCode: 409,
  }); };
  function create({ root, keys, enabled, generation = 1, face = 'attachment', allowSealedRemoval = false, maxReadBytes = 8 * 1024 * 1024 } = {}) {
    if (typeof root !== 'string' || !root.length) fail('root');
    if (!keys || typeof keys.snapshot !== 'function') fail('keys');
    if (typeof enabled !== 'function') fail('enabled');
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 99) fail('generation');
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 1 || maxReadBytes > WorkDataAttachmentChunks.MAX_BYTES) fail('read_limit');
    const spec = WorkDataAttachmentCatalogs.spec(face);
    if (!spec) fail('face');
    const catalogs = WorkDataAttachmentCatalogs.create({ root, keys, enabled });
    const gate = () => { if (enabled() !== true) fail('disabled'); };
    let opened = null;
    function open() {
      if (opened) return opened;
      const attachment = catalogs.open(face);
      opened = Object.freeze({
        catalog: attachment,
        store: WorkDataAttachmentStore.create({ root, keys, catalog: attachment, purpose: spec.purpose, scopeId: spec.scopeId, generation }),
        reader: WorkDataAttachmentReader.create({ root, keys, authority: attachment, maxReadBytes }),
      });
      return opened;
    }
    // Content-derived revision keeps a re-upload of identical bytes idempotent at
    // the location level; the catalog still refuses a duplicate id.
    const opaqueFor = id => {
      if (typeof id !== 'string' || !idPattern.test(id)) fail('id');
      return cryptoApi.createHash('sha256').update('attachment-opaque:' + face + ':' + id).digest('hex').slice(0, 32);
    };
    const revisionFor = data => {
      if (!Buffer.isBuffer(data) || !data.length) fail('data');
      return cryptoApi.createHash('sha256').update(data).digest('hex').slice(0, 32);
    };
    return Object.freeze({
      opaqueFor,
      revisionFor,
      async seal({ id, kind, logicalName, mime, data } = {}) {
        gate();
        if (typeof id !== 'string' || !idPattern.test(id)) fail('id');
        if (!Buffer.isBuffer(data) || !data.length) fail('data');
        const receipt = await open().store.seal({ id, opaque: opaqueFor(id), revision: revisionFor(data),
          metadata: { kind, logicalName, mime }, data });
        return Object.freeze({ ...receipt, id });
      },
      async read(id, start, end, options) { gate(); return open().reader.readRange(id, start, end, options); },
      async verify(id) { gate(); return open().reader.verifyWhole(id); },
      async has(id) {
        gate();
        if (typeof id !== 'string' || !idPattern.test(id)) return false;
        const rows = await open().catalog.rows();
        return rows.some(row => row.id === id && row.state === 'sealed');
      },
      async list() { gate(); return open().catalog.rows(); },
      // Cheap metadata probe: readRange(id,0,0) parses the manifest without
      // materializing any chunk, so callers can stream by range instead of
      // raising the whole-file read limit.
      async stat(id) {
        gate();
        const lease = await open().reader.readRange(id, 0, 0);
        try { return Object.freeze({ totalBytes: lease.totalBytes, sha256: lease.sha256, revision: lease.revision, metadata: lease.metadata }); }
        finally { lease.release(); }
      },
      // Explicit cleanup for a failed seal. Only pending/uncertain rows may be
      // discarded; a sealed copy is never deleted through this entry.
      async discard(id) {
        gate();
        if (typeof id !== 'string' || !idPattern.test(id)) fail('id');
        const opened = open(), rows = await opened.catalog.rows();
        const row = rows.find(value => value.id === id);
        if (!row) return Object.freeze({ discarded: false, id });
        if (row.state === 'sealed') fail('sealed');
        await removeTree(id, row);
        await opened.catalog.remove(id);
        return Object.freeze({ discarded: true, id });
      },
      // Migration-only: retire a verified sealed copy and its catalog row. The
      // caller must opt in at create() time; runtime read paths never get this.
      async retireSealed(id) {
        gate();
        if (allowSealedRemoval !== true) fail('sealed_removal_forbidden');
        if (typeof id !== 'string' || !idPattern.test(id)) fail('id');
        const opened = open(), rows = await opened.catalog.rows();
        const row = rows.find(value => value.id === id);
        if (!row) fail('id_missing');
        if (row.state !== 'sealed') fail('not_sealed');
        await opened.reader.verifyWhole(id);
        await removeTree(id, row);
        await opened.catalog.remove(id);
        return Object.freeze({ retired: true, id });
      },
    });
    async function removeTree(id, row) {
      const dir = nodePath.join(root, opaqueFor(id), row.revision);
      const relative = nodePath.relative(nodePath.resolve(root), nodePath.resolve(dir));
      if (!relative || relative.startsWith('..') || nodePath.isAbsolute(relative)) fail('path');
      // Lexical containment is not enough: a junction/symlink at the opaque
      // segment could point outside the uploads root. Verify each existing
      // segment is a real directory whose realpath is itself before removing.
      for (const [index, segment] of [root, nodePath.join(root, opaqueFor(id)), dir].entries()) {
        let stat;
        try { stat = await fsp.lstat(segment, { bigint: true }); }
        catch (error) { if (error && error.code === 'ENOENT') continue; throw error; }
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('path');
        // The root itself may legitimately be a junction/trailing-slash path;
        // only the two derived segments must resolve to themselves.
        if (index === 0) continue;
        const real = await fsp.realpath(segment);
        if ((process.platform === 'win32' ? real.toLowerCase() : real) !== (process.platform === 'win32' ? segment.toLowerCase() : segment)) fail('path');
      }
      await fsp.rm(dir, { recursive: true, force: true });
      // Leave no empty <opaque>/ directory behind: it would be counted as an
      // already-sealed tree by enroll even after the row is gone.
      try { await fsp.rmdir(nodePath.dirname(dir)); } catch {};
    }
  }
  return Object.freeze({ create });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
