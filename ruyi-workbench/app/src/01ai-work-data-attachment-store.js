// Isolated sealed-attachment writer draft. No HTTP route, key creation or
// deletion authority: the caller supplies the sealed catalog and a key
// snapshot, and every failure leaves a marked catalog row instead of a
// half-written directory that looks complete.
const WorkDataAttachmentStore = ((fsp, nodePath, cryptoApi) => {
  const hex32 = /^[a-f0-9]{32}$/, idPattern = /^[A-Za-z0-9_.:-]{1,64}$/;
  const fail = (suffix, details = {}) => { throw Object.assign(Error('work_data_attachment_store.' + suffix), {
    code: 'work_data_attachment_store.' + suffix, apiCode: 'work_data_attachment_store.' + suffix, statusCode: 409, ...details,
  }); };
  const sha = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const bytesOf = value => Buffer.isBuffer(value) && !require('node:util').types.isProxy(value);
  function create({ root, keys, catalog, purpose, scopeId, generation } = {}) {
    if (typeof root !== 'string' || !nodePath.isAbsolute(root)) fail('root');
    if (!keys || typeof keys.snapshot !== 'function') fail('keys');
    if (!catalog || typeof catalog.begin !== 'function' || typeof catalog.seal !== 'function' || typeof catalog.uncertain !== 'function') fail('catalog');
    if (!['session', 'cache'].includes(purpose)) fail('purpose');
    if (typeof scopeId !== 'string' || !scopeId.length) fail('scope');
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 99) fail('generation');
    async function seal({ id, opaque, revision, metadata, data } = {}) {
      if (typeof id !== 'string' || !idPattern.test(id)) fail('id');
      if (typeof opaque !== 'string' || !hex32.test(opaque) || typeof revision !== 'string' || !hex32.test(revision)) fail('location');
      if (!bytesOf(data) || !data.length || data.length > WorkDataAttachmentChunks.MAX_BYTES) fail('data');
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || require('node:util').types.isProxy(metadata)) fail('metadata');
      const recordId = 'attachment:' + id, lease = await keys.snapshot();
      let started = false, manifest = null, writer = null, primary = null;
      try {
        if (!lease || !bytesOf(lease.key) || lease.key.length !== 32 || typeof lease.instanceId !== 'string') fail('keys');
        await catalog.begin({ id, opaque, revision, kind: metadata.kind, logicalName: metadata.logicalName,
          mime: metadata.mime, generation, recordId });
        started = true;
        await fsp.mkdir(nodePath.join(root, opaque, revision), { recursive: true });
        const dir = nodePath.join(root, opaque, revision);
        writer = WorkDataAttachmentChunks.createWriter({ key: lease.key, revision, maxBytes: WorkDataAttachmentChunks.MAX_BYTES,
          metadata: { logicalName: metadata.logicalName, mime: metadata.mime, kind: metadata.kind },
          binding: { purpose, instanceId: lease.instanceId, schema: 1, scopeId, recordId, seq: 0, generation } });
        for (let at = 0; at < data.length; at += WorkDataAttachmentChunks.CHUNK_BYTES) {
          const part = writer.write(data.subarray(at, at + WorkDataAttachmentChunks.CHUNK_BYTES));
          try { await fsp.writeFile(nodePath.join(dir, part.name), part.data, { flag: 'wx' }); }
          finally { part.data.fill(0); }
        }
        manifest = writer.finish();
        await fsp.writeFile(nodePath.join(dir, 'manifest.json'), manifest, { flag: 'wx' });
        await catalog.seal(id, { manifestSha256: sha(manifest), manifestBytes: manifest.length });
        return Object.freeze({ id, opaque, revision, totalBytes: data.length, sha256: sha(data) });
      } catch (error) { primary = error; throw error; }
      finally {
        // A dispose failure must never be silent: with a primary error it becomes
        // sticky cleanup evidence (01af reports unproven key erasure this way).
        if (writer) {
          try { writer.dispose(); }
          catch (error) {
            if (!primary) primary = error;
            else { try { primary.cleanupFailed = true; if (error && error.keyClearUnproven === true) primary.keyClearUnproven = true; } catch {} }
          }
        }
        if (manifest) { try { manifest.fill(0); } catch (error) { if (!primary) primary = error; } }
        if (primary && started) { try { await catalog.uncertain(id); } catch {} }
        try { lease?.release?.(); } catch {}
        if (primary) throw primary;
      }
    }
    return Object.freeze({ seal });
  }
  return Object.freeze({ create });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'));
