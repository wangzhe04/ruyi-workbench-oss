'use strict';
// M4 storage candidate only. This does not prove OCR/decoder coverage or authorize media egress.
const MediaDerivedStore = ((io, nodePath, cryptoApi, zlibApi) => {
  const MAX_PNG = 5 * 1024 * 1024, MAX_PIXELS = 8000000;
  const MAX_TEXT = 4 * Math.ceil(MAX_PNG / 3) + 32768, MAX_FILE = 12 * 1024 * 1024;
  const SCHEMA = 1, PURPOSE = 'cache';
  const manifestKeys = 'authorization,bytes,coverage,expiresAt,height,mime,name,payloadHash,policyHash,policyRevision,processorHash,processorVersion,regionsHash,rulesHash,schema,scope,sourceHash,sourceRevision,transformHash,type,width';
  const bindingKeys = 'policyHash,policyRevision,processorHash,processorVersion,revocationRevision,rulesHash,sourceHash,sourceRevision';
  const fail = suffix => { throw Object.assign(new Error('media_store.' + suffix), { code: 'media_store.' + suffix, statusCode: 409 }); };
  const fillBuffer = Function.prototype.call.bind(Buffer.prototype.fill);
  const hash = value => cryptoApi.createHash('sha256').update(value).digest('hex');
  const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === keys;
  const revision = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(v);
  const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const recordId = v => typeof v === 'string' && /^mimg_[a-f0-9]{32}$/.test(v);
  const clone = value => JSON.parse(JSON.stringify(value));
  function validateBinding(value) {
    if (!exact(value, bindingKeys)) fail('authority_shape');
    for (const key of ['sourceHash','policyHash','rulesHash','processorHash']) if (!digest(value[key])) fail('authority_shape');
    for (const key of ['sourceRevision','policyRevision','processorVersion','revocationRevision']) if (!revision(value[key])) fail('authority_shape');
    return value;
  }
  function crc32(bytes) {
    let n = 0xffffffff;
    for (const byte of bytes) { n ^= byte; for (let b = 0; b < 8; b++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1)); }
    return (n ^ 0xffffffff) >>> 0;
  }
  function validatePng(bytes, manifest) {
    if (!Buffer.isBuffer(bytes) || bytes.length < 57 || bytes.length > MAX_PNG || hash(bytes) !== manifest.payloadHash
      || bytes.length !== manifest.bytes || bytes.subarray(0,8).toString('hex') !== '89504e470d0a1a0a') fail('payload');
    let offset = 8, idat;
    for (const type of ['IHDR','IDAT','IEND']) {
      if (offset + 12 > bytes.length) fail('png');
      const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
      if (end > bytes.length || bytes.toString('ascii',offset+4,offset+8) !== type
        || crc32(bytes.subarray(offset+4,end-4)) !== bytes.readUInt32BE(end-4)) fail('png');
      const data = bytes.subarray(offset+8,end-4);
      if (type === 'IHDR' && (length !== 13 || data.readUInt32BE(0) !== manifest.width || data.readUInt32BE(4) !== manifest.height
        || data[8] !== 8 || data[9] !== 2 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0)) fail('png');
      if (type === 'IDAT') { if (!length) fail('png'); idat = data; }
      if (type === 'IEND' && length !== 0) fail('png');
      offset = end;
    }
    if (offset !== bytes.length) fail('png');
    const row = manifest.width * 3 + 1, size = row * manifest.height;
    let raw;
    try {
      const result = zlibApi.inflateSync(idat, { maxOutputLength: size, info: true }); raw = result.buffer;
      if (raw.length !== size || result.engine.bytesWritten !== idat.length) fail('png');
      for (let y = 0; y < manifest.height; y++) if (raw[y*row] !== 0) fail('png');
    } catch (error) { if (error?.code === 'media_store.png') throw error; fail('png'); }
    finally { if (raw) fillBuffer(raw,0); }
  }
  function validateManifest(manifest, scopeId) {
    if (!exact(manifest, manifestKeys) || manifest.schema !== 1 || manifest.type !== 'protected-image'
      || manifest.mime !== 'image/png' || manifest.name !== 'protected.png' || manifest.scope !== scopeId
      || manifest.authorization !== 'none' || manifest.coverage !== 'single-canonical-frame-ocr+local-codes+explicit-regions'
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > MAX_PNG
      || !Number.isSafeInteger(manifest.expiresAt) || manifest.expiresAt < 1
      || !Number.isSafeInteger(manifest.width) || !Number.isSafeInteger(manifest.height)
      || manifest.width < 1 || manifest.height < 1 || manifest.width * manifest.height > MAX_PIXELS) fail('manifest');
    for (const key of ['sourceHash','policyHash','rulesHash','processorHash','payloadHash','regionsHash','transformHash']) if (!digest(manifest[key])) fail('manifest');
    for (const key of ['sourceRevision','policyRevision','processorVersion']) if (!revision(manifest[key])) fail('manifest');
    return manifest;
  }
  function parseStoredText(text, { scopeId, id } = {}) {
      if (!revision(scopeId) || !recordId(id)) fail('binding');
      if (typeof text !== 'string' || Buffer.byteLength(text,'utf8') > MAX_TEXT) fail('record_limit');
      let value; try { value = JSON.parse(text); } catch { fail('record'); }
      if (!exact(value,'data,id,issuedAt,manifest,revocationRevision,schema,sourceId') || value.schema !== SCHEMA || value.id !== id
        || !revision(value.sourceId) || !revision(value.revocationRevision) || typeof value.data !== 'string'
        || value.data.length > 4 * Math.ceil(MAX_PNG/3) || value.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) fail('record');
      validateManifest(value.manifest,scopeId);
      if (!Number.isSafeInteger(value.issuedAt) || value.issuedAt < 0 || value.manifest.expiresAt <= value.issuedAt || value.manifest.expiresAt - value.issuedAt > 60000) fail('ttl');
      const bytes = Buffer.from(value.data,'base64');
      try { if (bytes.toString('base64') !== value.data) fail('base64'); validatePng(bytes,value.manifest); }
      finally { fillBuffer(bytes,0); }
      return value;
    }
  function validateSealedText(text, { scopeId, recordId: id } = {}) { parseStoredText(text, { scopeId, id }); return true; }
  function create({ root, scopeId, keys, enabled, writeJson, authority, now = Date.now } = {}) {
    if (typeof root !== 'string' || !nodePath.isAbsolute(root) || !revision(scopeId) || typeof enabled !== 'function'
      || typeof writeJson !== 'function' || !authority || typeof authority.capture !== 'function' || typeof authority.assert !== 'function'
      || typeof now !== 'function') fail('host');
    root = nodePath.resolve(root); // A trusted composition supplies one dedicated family root.
    // An unavailable switch is never permission to persist plaintext. Keep legacy Store defaults unchanged.
    const strictEnabled = async () => {
      let value;
      try { value = await enabled(); }
      catch (cause) { throw Object.assign(new Error('media_store.switch_unavailable', { cause }), { code:'media_store.switch_unavailable', statusCode:503 }); }
      if (value !== true && value !== false) fail('switch_unavailable');
      return value;
    };
    const chains = new Map(), issued = new Map();
    const fileFor = id => { if (!recordId(id)) fail('id'); return nodePath.join(root, id + '.json'); };
    const serial = (id, work) => {
      const previous = chains.get(id) || Promise.resolve();
      const next = previous.catch(() => {}).then(work); chains.set(id,next);
      next.finally(() => { if (chains.get(id) === next) chains.delete(id); }).catch(() => {}); return next;
    };
    async function checkPath(id, missing = false) {
      const file = fileFor(id), parsed = nodePath.parse(root); let current = parsed.root;
      const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
      for (const part of root.slice(parsed.root.length).split(nodePath.sep).filter(Boolean)) {
        current = nodePath.join(current,part);
        const st = await io.lstat(current);
        if (!st.isDirectory() || st.isSymbolicLink() || fold(await io.realpath(current)) !== fold(current)) fail('path');
      }
      let st; try { st = await io.lstat(file); } catch (e) { if (missing && e.code === 'ENOENT') return file; throw e; }
      if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE || fold(await io.realpath(file)) !== fold(file)) fail('path');
      return file;
    }
    function parse(text, id) { return parseStoredText(text, { scopeId, id }); }
    const storeFor = (id, file, writer = writeJson) => WorkDataStore.createText({ file: () => file, purpose: PURPOSE, schema: SCHEMA,
      scopeId, recordId: id, keys, enabled:strictEnabled, writeJson:writer, chunked: true, maxPlaintextBytes: MAX_TEXT, maxFileBytes: MAX_FILE,
      validateSealedText: text => { parse(text,id); return true; } });
    async function capture(sourceId, manifest, revocationRevision) {
      // The real composition must resolve durable current source/policy/processor/revocation authority.
      // A previously stored manifest or a process ticket is never that authority.
      const snapshot = await authority.capture(sourceId);
      validateBinding(snapshot?.binding);
      const check = () => {
        const result = authority.assert(snapshot,sourceId);
        if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('authority_async'); }
        if (result !== true) fail('revoked');
        validateBinding(snapshot.binding);
        for (const key of ['sourceHash','sourceRevision','policyHash','policyRevision','rulesHash','processorHash','processorVersion']) {
          if (snapshot.binding[key] !== manifest[key]) fail('binding');
        }
        if (snapshot.binding.revocationRevision !== revocationRevision) fail('revoked');
        if (!Number.isSafeInteger(now()) || now() >= manifest.expiresAt) fail('expired');
      };
      check(); return check;
    }
    async function put({ sourceId, manifest, bytes } = {}) {
      if (!revision(sourceId) || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PNG) fail('input');
      validateManifest(manifest,scopeId);
      // Own copies before the first await; callers cannot change bytes/manifest during persistence.
      const owned = Buffer.from(bytes), frozenManifest = clone(manifest);
      try {
        validateManifest(frozenManifest,scopeId); validatePng(owned,frozenManifest);
        await strictEnabled();
        const snapshot = await authority.capture(sourceId); validateBinding(snapshot?.binding);
        const revocationRevision = snapshot.binding.revocationRevision;
        // Keep the exact first authority snapshot through every await, including write completion.
        const check = () => {
          const result = authority.assert(snapshot,sourceId);
          if (result && typeof result.then === 'function') { Promise.resolve(result).catch(() => {}); fail('authority_async'); }
          if (result !== true) fail('revoked');
          validateBinding(snapshot.binding);
          for (const key of ['sourceHash','sourceRevision','policyHash','policyRevision','rulesHash','processorHash','processorVersion']) if (snapshot.binding[key] !== frozenManifest[key]) fail('binding');
          if (snapshot.binding.revocationRevision !== revocationRevision || now() >= frozenManifest.expiresAt) fail('revoked');
        };
        check();
        const id = 'mimg_' + cryptoApi.randomBytes(16).toString('hex');
        return await serial(id,async () => {
          const file = await checkPath(id,true); check();
          // Never overwrite an existing record, even on a random ID collision.
          try { await io.lstat(file); fail('collision'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
          check();
          const issuedAt = now();
          const value = { schema:SCHEMA,id,sourceId,issuedAt,revocationRevision,manifest:frozenManifest,data:owned.toString('base64') };
          const text = JSON.stringify(value); parse(text,id);
          const publish = async (target, payload, options) => {
            if (target !== file) fail('path');
            const stage = file + '.publish-' + cryptoApi.randomBytes(16).toString('hex');
            let failed = false, primary;
            try { await writeJson(stage,payload,options); check(); await io.link(stage,file); issued.set(id,await io.lstat(file,{bigint:true})); }
            catch (error) { failed = true; primary = error; }
            try { await io.unlink(stage); } catch (error) {
              if (error.code !== 'ENOENT') throw new AggregateError([...(failed?[primary]:[]),error],'media_store.cleanup_failed');
            }
            if (failed) throw primary;
          };
          await storeFor(id,file,publish).write(text);
          issued.set(id, await io.lstat(file, { bigint: true }));
          check(); await checkPath(id); check();
          return Object.freeze({ id, manifest:Object.freeze(clone(frozenManifest)) });
        });
      } finally { fillBuffer(owned,0); }
    }
    async function read(id) {
      return serial(id,async () => {
        // Store reads do not consult enabled(); apply this same strict wrapper before any cold read.
        await strictEnabled();
        const file = await checkPath(id), value = parse(await storeFor(id,file).read(),id);
        await checkPath(id);
        const check = await capture(value.sourceId,value.manifest,value.revocationRevision); check();
        const bytes = Buffer.from(value.data,'base64'), manifest = Object.freeze(clone(value.manifest)); let released = false;
        return Object.freeze({ bytes, manifest,
          assert() {
            if (released) fail('released');
            try { check(); if (hash(bytes) !== manifest.payloadHash) fail('payload'); return true; }
            catch (primary) { released = true; try { fillBuffer(bytes,0); } catch (cleanup) { throw new AggregateError([primary,cleanup],'media_store.cleanup_failed'); } throw primary; }
          },
          release() { if (!released) { released = true; fillBuffer(bytes,0); } } });
      });
    }
    async function remove(id) {
      return serial(id, async () => {
        const original = issued.get(id); if (!original) fail('unowned_remove');
        const file = await checkPath(id), current = await io.lstat(file, { bigint: true });
        if (current.nlink !== 1n || ['dev','ino','size','mtimeNs','ctimeNs'].some(key => current[key] !== original[key])) fail('path');
        await io.unlink(file); issued.delete(id); return true;
      });
    }
    async function dispose() { for (const id of [...issued.keys()]) await remove(id); }
    return Object.freeze({ put, read, remove, dispose });
  }
  return Object.freeze({ create, validateSealedText, SCHEMA, PURPOSE, LIMITS:Object.freeze({MAX_PNG,MAX_TEXT,MAX_FILE,MAX_PIXELS}) });
})(require('node:fs/promises'), require('node:path'), require('node:crypto'), require('node:zlib'));
// Fixed late binding: no later-module reference from the early migration codec. Structural validation grants no use/send authority.
if (typeof WorkDataMigrationCodecs !== 'undefined' && WorkDataMigrationCodecs.Hooks) Object.defineProperty(WorkDataMigrationCodecs.Hooks, 'mediaDerived', {
  value: Object.freeze({ validateSealedText: MediaDerivedStore.validateSealedText, maxPlaintextBytes: MediaDerivedStore.LIMITS.MAX_TEXT }),
  enumerable: true, writable: false, configurable: false });
