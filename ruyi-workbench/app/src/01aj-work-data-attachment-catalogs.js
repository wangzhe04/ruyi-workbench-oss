// Isolated catalog persistence glue. Opens the two per-face catalog files through
// WorkDataStore.createText and hands them to 01ah. Catalogs exist only when work
// data encryption is on, so a disabled switch refuses instead of writing plaintext.
const WorkDataAttachmentCatalogs = ((pathApi) => {
  const FACES = Object.freeze({
    attachment: Object.freeze({ purpose: 'session', scopeId: 'sessions', file: '_catalog-attachments-v1.json', recordId: 'attachment-catalog' }),
    toolImage: Object.freeze({ purpose: 'cache', scopeId: 'index-cache', file: '_catalog-tool-images-v1.json', recordId: 'tool-image-catalog' }),
  });
  const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
  // One chain per root + face so two handles opened on the same data root still
  // serialize their read-modify-write instead of losing rows.
  const chains = new Map();
  function create({ root, keys, enabled } = {}) {
    if (typeof root !== 'string' || !pathApi.isAbsolute(root)) throw Object.assign(Error('work_data_attachment_catalogs.root'), { code: 'work_data_attachment_catalogs.root', statusCode: 409 });
    if (!keys || typeof keys.snapshot !== 'function') throw Object.assign(Error('work_data_attachment_catalogs.keys'), { code: 'work_data_attachment_catalogs.keys', statusCode: 409 });
    if (typeof enabled !== 'function') throw Object.assign(Error('work_data_attachment_catalogs.enabled'), { code: 'work_data_attachment_catalogs.enabled', statusCode: 409 });
    const normalized = pathApi.resolve(root);
    const serializeFor = face => {
      const key = normalized + '::' + face;
      return work => {
        const previous = chains.get(key) || Promise.resolve();
        const next = previous.then(work, work);
        chains.set(key, next.then(() => {}, () => {}));
        return next;
      };
    };
    function open(face) {
      const spec = FACES[face];
      if (!spec) throw Object.assign(Error('work_data_attachment_catalogs.face'), { code: 'work_data_attachment_catalogs.face', statusCode: 409 });
      if (enabled() !== true) throw Object.assign(Error('work_data_attachment_catalogs.disabled'), { code: 'work_data_attachment_catalogs.disabled', statusCode: 409 });
      const file = pathApi.join(root, spec.file);
      const storeFor = validateSealedText => WorkDataStore.createText({ file: () => file, purpose: spec.purpose, schema: 1, scopeId: spec.scopeId,
        recordId: spec.recordId, chunked: true, maxPlaintextBytes: MAX_CATALOG_BYTES, keys, enabled: () => true, writeJson: atomicWriteJson,
        validateSealedText });
      const store = {
        async read() {
          let authenticated = false;
          const text = await storeFor(() => { authenticated = true; return true; }).read();
          if (!authenticated) throw Object.assign(Error('work_data_attachment_catalogs.unsealed'), { code: 'work_data_attachment_catalogs.unsealed', statusCode: 409 });
          return text;
        },
        write: text => storeFor().write(text),
      };
      return WorkDataAttachmentCatalog.create({ store, purpose: spec.purpose, scopeId: spec.scopeId, recordId: spec.recordId, serialize: serializeFor(face) });
    }
    return Object.freeze({ open, faces: Object.freeze(Object.keys(FACES)) });
  }
  return Object.freeze({ create, faces: Object.freeze(Object.keys(FACES)), spec: face => FACES[face] || null });
})(require('node:path'));
