// Disposal of the newly restored rehearsal requires the real native namespace
// census as well as WorkDataTree's private identity proof. A complete capture
// above the existing native owner's 96 MB engineering bound refuses; no tail,
// stream or unknown object is omitted to make cleanup proceed.
const WorkDataDisposableNativeTree = (() => {
  const fail = () => { throw Object.assign(new Error('work_data_setup.rehearsal_changed'), {
    code:'work_data_setup.rehearsal_changed',apiCode:'work_data_setup.rehearsal_changed',statusCode:409,retry:false,
  }); };
  function create({ capturePreserved }) {
    if (typeof capturePreserved !== 'function') fail();
    return async function verify({target,snapshot,ownership,assertExclusive}) {
      if (process.platform !== 'win32' || typeof target !== 'string' || !require('node:path').isAbsolute(target)
        || snapshot?.root !== target || typeof assertExclusive !== 'function' || await assertExclusive(ownership) !== true
        || !ownership?.roots?.some(root=>root.toLowerCase()===target.toLowerCase())) fail();
      const native = await capturePreserved(target,require('node:crypto').randomBytes(32).toString('hex'));
      // capturePreserved validates the entire actual snapshot shape, IDs, stream
      // payloads/hashes and aliases before returning. This layer narrows the
      // newly-created rehearsal namespace to exactly its restore proof.
      const dirs = new Set(['',...snapshot.directories]),files=new Map(snapshot.files.map(row=>[row.path,row])),seen=new Set();
      if (!native || native.entries?.length !== dirs.size+files.size) fail();
      for (const entry of native.entries) {
        if (!entry || typeof entry.rel !== 'string' || seen.has(entry.rel)) fail();
        seen.add(entry.rel);
        if (entry.dir) {
          if (!dirs.has(entry.rel) || !Array.isArray(entry.streams) || entry.streams.length !== 0) fail();
        } else {
          const file=files.get(entry.rel),stream=entry.streams?.[0];
          if (!file || !Array.isArray(entry.streams) || entry.streams.length !== 1 || stream.name !== '' || stream.size !== file.data.length || stream.hash !== file.sha256) fail();
        }
      }
      if ([...dirs,...files.keys()].some(name=>!seen.has(name)) || await assertExclusive(ownership) !== true) fail();
      return true;
    };
  }
  return Object.freeze({create});
})();
