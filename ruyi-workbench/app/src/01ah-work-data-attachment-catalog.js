// Isolated attachment-catalog authority draft. No filesystem, key creation,
// migration or consumer wiring: the caller supplies the sealed store and the
// write chain. Tickets grant plaintext access only, never deletion.
const WorkDataAttachmentCatalog = ((cryptoApi) => {
  // 01ag refuses a manifest carrier above 01af's MAX_CARRIER (2 MiB); a larger
  // row would be accepted here and then be unreadable.
  const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
  const hex32 = /^[a-f0-9]{32}$/, hex64 = /^[a-f0-9]{64}$/, scopePattern = /^[A-Za-z0-9_.:-]{1,160}$/;
  const idPattern = /^[A-Za-z0-9_.:-]{1,64}$/, kinds = Object.freeze(['original', 'tool-image']);
  const fail = (suffix, details = {}) => { throw Object.assign(Error('work_data_attachment_catalog.' + suffix), {
    code: 'work_data_attachment_catalog.' + suffix, apiCode: 'work_data_attachment_catalog.' + suffix, statusCode: 409, ...details,
  }); };
  const own = (value, fields) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || require('node:util').types.isProxy(value)) fail('shape');
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Reflect.ownKeys(descriptors);
    if (names.some(name => typeof name !== 'string') || names.slice().sort().join(',') !== fields.split(',').sort().join(',')
      || names.some(name => !Object.hasOwn(descriptors[name], 'value'))) fail('shape');
    return Object.fromEntries(names.map(name => [name, descriptors[name].value]));
  };
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const scalarString = value => {
    for (let n = 0; n < value.length; n++) {
      const unit = value.charCodeAt(n);
      if (unit >= 0xd800 && unit <= 0xdbff) { const next = value.charCodeAt(++n); if (!(next >= 0xdc00 && next <= 0xdfff)) return false; }
      else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
    }
    return true;
  };
  function rowOf(value) {
    const row = own(value, 'id,opaque,revision,kind,logicalName,mime,generation,state,manifestSha256,manifestBytes,recordId');
    if (typeof row.id !== 'string' || !idPattern.test(row.id)) fail('row');
    if (typeof row.opaque !== 'string' || !hex32.test(row.opaque) || typeof row.revision !== 'string' || !hex32.test(row.revision)) fail('row');
    if (!kinds.includes(row.kind) || !integer(row.generation, 1, 99) || row.recordId !== 'attachment:' + row.id) fail('row');
    if (typeof row.logicalName !== 'string' || !row.logicalName.length || row.logicalName.length > 200 || /[\x00-\x1f]/.test(row.logicalName) || !scalarString(row.logicalName)) fail('row');
    if (typeof row.mime !== 'string' || row.mime.length > 128 || !/^[-A-Za-z0-9.+]+[/][-A-Za-z0-9.+]+$/.test(row.mime)) fail('row');
    if (!['pending', 'sealed', 'uncertain'].includes(row.state)) fail('row');
    if (row.state === 'sealed') {
      if (typeof row.manifestSha256 !== 'string' || !hex64.test(row.manifestSha256) || !integer(row.manifestBytes, 1, MAX_MANIFEST_BYTES)) fail('row');
    } else if (row.manifestSha256 !== null || row.manifestBytes !== null) fail('row');
    return Object.freeze(row);
  }
  function create({ store, purpose, scopeId, recordId = 'attachment-catalog', serialize } = {}) {
    if (!store || typeof store.read !== 'function' || typeof store.write !== 'function') fail('store_required');
    if (!['session', 'cache'].includes(purpose)) fail('purpose');
    if (typeof scopeId !== 'string' || !scopePattern.test(scopeId)) fail('scope');
    if (typeof recordId !== 'string' || !idPattern.test(recordId)) fail('record');
    const chain = typeof serialize === 'function' ? serialize : work => work();
    const issued = new WeakMap(), epochs = new Map();
    const touch = id => epochs.set(id, (epochs.get(id) || 0) + 1);
    async function load() {
      let text;
      try { text = await store.read(); }
      catch (error) { if (error && error.code === 'ENOENT') return { rows: [], text: null }; throw error; }
      if (typeof text !== 'string' || !text.length) fail('catalog');
      let value; try { value = JSON.parse(text); } catch { fail('catalog'); }
      const body = own(value, 'schema,rows');
      if (body.schema !== 1 || !Array.isArray(body.rows)) fail('catalog');
      const rows = body.rows.map(rowOf), seen = new Set();
      for (const row of rows) { if (seen.has(row.id)) fail('catalog'); seen.add(row.id); }
      return { rows, text };
    }
    const digest = value => value === null ? null : cryptoApi.createHash('sha256').update(value).digest('hex');
    async function save(rows) {
      await store.write(JSON.stringify({ schema: 1, rows: rows.map(row => ({ ...row })) }));
    }
    function find(rows, id) {
      if (typeof id !== 'string' || !idPattern.test(id)) fail('id');
      const row = rows.find(value => value.id === id);
      if (!row) fail('id_missing');
      return row;
    }
    async function mutate(work) {
      return chain(async () => { const state = await load(); return work(state.rows, state); });
    }
    return Object.freeze({
      async begin(input) {
        const row = rowOf({ ...input, state: 'pending', manifestSha256: null, manifestBytes: null });
        return mutate(async rows => {
          if (rows.some(value => value.id === row.id)) fail('id_exists');
          await save([...rows, row]); touch(row.id); return row;
        });
      },
      async seal(id, proof) {
        const value = own(proof, 'manifestSha256,manifestBytes');
        return mutate(async rows => {
          const row = find(rows, id);
          if (row.state !== 'pending') fail('state');
          if (typeof value.manifestSha256 !== 'string' || !hex64.test(value.manifestSha256) || !integer(value.manifestBytes, 1, MAX_MANIFEST_BYTES)) fail('proof');
          const next = Object.freeze({ ...row, state: 'sealed', manifestSha256: value.manifestSha256, manifestBytes: value.manifestBytes });
          await save(rows.map(current => current.id === id ? next : current)); touch(id); return next;
        });
      },
      async uncertain(id) {
        return mutate(async rows => {
          const row = find(rows, id);
          if (row.state !== 'pending') fail('state');
          const next = Object.freeze({ ...row, state: 'uncertain' });
          await save(rows.map(current => current.id === id ? next : current)); touch(id); return next;
        });
      },
      async remove(id) {
        return mutate(async rows => { find(rows, id); await save(rows.filter(row => row.id !== id)); touch(id); return true; });
      },
      async capture(id) {
        const state = await load(), row = find(state.rows, id);
        if (row.state !== 'sealed') fail('not_sealed');
        const ticket = Object.freeze({ id: row.id, opaque: row.opaque, revision: row.revision, manifestSha256: row.manifestSha256,
          manifestBytes: row.manifestBytes, generation: row.generation, purpose, scopeId, recordId: row.recordId, catalogHash: digest(state.text) });
        issued.set(ticket, Object.freeze({ id: row.id, opaque: row.opaque, revision: row.revision, generation: row.generation,
          manifestSha256: row.manifestSha256, manifestBytes: row.manifestBytes, catalogHash: ticket.catalogHash, recordId: row.recordId, epoch: epochs.get(row.id) || 0 }));
        return ticket;
      },
      describe(ticket, id) {
        const known = issued.get(ticket);
        if (!known || known.id !== id) fail('ticket_invalid');
        return Object.freeze({ opaque: known.opaque, revision: known.revision, manifestSha256: known.manifestSha256,
          manifestBytes: known.manifestBytes, generation: known.generation, purpose, scopeId, recordId: known.recordId });
      },
      // 01ag calls assert synchronously; this is the local authority view. A write
      // through this catalog bumps the id's epoch and invalidates old tickets. A
      // change from another process is caught by the reader's AAD/revision check.
      assert(ticket, id) {
        const known = issued.get(ticket);
        if (!known || known.id !== id) fail('ticket_invalid');
        return (epochs.get(id) || 0) === known.epoch;
      },
      async rows() { const state = await load(); return Object.freeze(state.rows.slice()); },
    });
  }
  return Object.freeze({ create, MAX_MANIFEST_BYTES });
})(require('node:crypto'));
