// Isolated attachment runtime facade. Composes the per-face catalogs, the sealed
// writer and the reader for one data root, and owns the id/location derivation
// both the upload and download paths must share. No HTTP route is wired here.
const WorkDataAttachmentRuntime = ((fsp, nodePath, cryptoApi) => {
  const idPattern = /^[A-Za-z0-9_.:-]{1,64}$/;
  const fail = suffix => { throw Object.assign(Error('work_data_attachment_runtime.' + suffix), {
    code: 'work_data_attachment_runtime.' + suffix, apiCode: 'work_data_attachment_runtime.' + suffix, statusCode: 409,
  }); };
  function create({ root, keys, enabled, generation = 1 } = {}) {
    if (typeof root !== 'string' || !root.length) fail('root');
    if (!keys || typeof keys.snapshot !== 'function') fail('keys');
    if (typeof enabled !== 'function') fail('enabled');
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 99) fail('generation');
    const catalogs = WorkDataAttachmentCatalogs.create({ root, keys, enabled });
    const gate = () => { if (enabled() !== true) fail('disabled'); };
    let opened = null;
    function open() {
      if (opened) return opened;
      const attachment = catalogs.open('attachment');
      opened = Object.freeze({
        catalog: attachment,
        store: WorkDataAttachmentStore.create({ root, keys, catalog: attachment, purpose: 'session', scopeId: 'sessions', generation }),
        reader: WorkDataAttachmentReader.create({ root, keys, authority: attachment }),
      });
      return opened;
    }
    // Content-derived revision keeps a re-upload of identical bytes idempotent at
    // the location level; the catalog still refuses a duplicate id.
    const opaqueFor = id => {
      if (typeof id !== 'string' || !idPattern.test(id)) fail('id');
      return cryptoApi.createHash('sha256').update('attachment-opaque:' + id).digest('hex').slice(0, 32);
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
      async read(id, start, end) { gate(); return open().reader.readRange(id, start, end); },
      async verify(id) { gate(); return open().reader.verifyWhole(id); },
      async has(id) {
        gate();
        if (typeof id !== 'string' || !idPattern.test(id)) return false;
        const rows = await open().catalog.rows();
        return rows.some(row => row.id === id && row.state === 'sealed');
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
        await opened.catalog.remove(id);
        return Object.freeze({ discarded: true, id });
      },
    });
  }
  return Object.freeze({ create });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
