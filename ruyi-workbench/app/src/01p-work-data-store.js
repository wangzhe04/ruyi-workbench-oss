// M3-2: managed record store for the work-data families frozen in
// docs/optimization-plan/93-m3-1-encrypted-storage-freeze.md.
//
// One whole-record JSON file per family record. With work-data encryption disabled (the default)
// it writes exactly the object the previous DurableJsonStore/atomicWriteJson path wrote, so the
// bytes on disk do not change. With it enabled it writes the WorkDataCrypto v2 container, and a
// container that cannot be authenticated (wrong purpose/instance/schema/scope/record, missing or
// unavailable key) throws — it never degrades to an empty record or to plaintext.
const WorkDataStore = ((fsp) => {
  const CONTAINER = 2;      // outer file version; inner envelope version comes from WorkDataCrypto
  const fail = suffix => { throw Object.assign(new Error('work_data_store.' + suffix), { code: 'work_data_store.' + suffix, apiCode: 'work_data_store.' + suffix }); };
  const generationOf = keyId => {
    const match = /\.k(\d{1,2})$/.exec(String(keyId || ''));
    const generation = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(generation) || generation < 1) fail('corrupt');
    return generation;
  };
  function create(host) {
    // host: { file(), purpose, schema, scopeId, recordId, keys (WorkDataKeys api),
    //         enabled() -> boolean (may be async), prepare(value) -> value, defaultValue() -> value,
    //         onCorrupt?(error) }
    const file = () => String(host.file());
    const prepare = value => {
      const next = host.prepare ? host.prepare(value) : value;
      if (!next || typeof next !== 'object' || Array.isArray(next)) fail('shape');
      return next;
    };
    const fallback = () => prepare(host.defaultValue ? host.defaultValue() : {});
    const corrupt = error => { try { if (host.onCorrupt) host.onCorrupt(error); } catch { /* diagnostics never block */ } return fallback(); };
    async function decrypt(parsed, budget) {
      const { workData, ...container } = parsed;
      if (workData !== CONTAINER) fail('corrupt');
      const key = await host.keys.unlock();   // disabled/absent/unavailable are hard failures, not empty data
      const plaintext = WorkDataCrypto.open(container, key, {
        purpose: host.purpose, instanceId: container.instanceId, schema: host.schema, scopeId: host.scopeId,
        recordId: host.recordId, seq: container.seq, generation: generationOf(container.keyId),
      });
      if (typeof plaintext !== 'string' || plaintext.length > budget) fail('corrupt');
      let value;
      try { value = JSON.parse(plaintext); } catch { fail('corrupt'); }
      return prepare(value);
    }
    async function read() {
      const target = file();
      let rawText;
      try { rawText = await fsp.readFile(target, 'utf8'); }
      catch (error) { if (error && error.code === 'ENOENT') return fallback(); throw error; }
      let parsed;
      try { parsed = JSON.parse(rawText); } catch (error) { return corrupt(error); }   // legacy "invalid means empty" contract
      if (parsed && typeof parsed === 'object' && Object.hasOwn(parsed, 'workData')) return decrypt(parsed, WorkDataCrypto.MAX_PLAINTEXT);
      // Legacy plaintext record: keep the previous "bad shape means empty plus a diagnostic" contract.
      try { return prepare(parsed); } catch (error) { return corrupt(error); }
    }
    async function write(value) {
      const prepared = prepare(value);
      if (!(await host.enabled())) { await host.writeJson(file(), prepared); return prepared; }
      // Enabled: never create a key here. Key creation belongs to the explicit enable flow (M3-3).
      const key = await host.keys.unlock();
      const instanceId = await host.keys.instance();
      const container = WorkDataCrypto.seal(JSON.stringify(prepared), key, {
        purpose: host.purpose, instanceId, schema: host.schema, scopeId: host.scopeId, recordId: host.recordId, seq: 1,
      });
      await host.writeJson(file(), { workData: CONTAINER, ...container });
      return prepared;
    }
    return Object.freeze({ read, write, filePath: file });
  }
  return Object.freeze({ create, CONTAINER });
})(require('node:fs/promises'));
