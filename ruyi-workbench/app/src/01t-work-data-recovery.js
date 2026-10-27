// M3-3 portable FULL work-data snapshot codec. This is separate from the credential-only
// recovery format. No filesystem access: the data-root owner must freeze writers, enumerate the
// complete tree (including retained backups), verify actual encrypted references and restore only
// into a fresh directory. Authentication and all manifest checks finish before any data is returned.
// V2 keeps typed portable conversions outside the file/master namespaces; V1 reads retain their
// strict legacy shapes. Bounded whole-package format, not streaming or constant-memory storage.
const WorkDataRecovery = ((cryptoApi) => {
  const KIND = 'ruyi-work-data-recovery', VERSION = 2, LEGACY_VERSION = 1;
  const DEFAULT_LIMITS = Object.freeze({ bytes: 256 * 1024 * 1024, files: 100000, directories: 100000,
    metadata: 32 * 1024 * 1024, keys: 128, auxiliaries: 128, path: 1024, serialized: require('node:buffer').constants.MAX_STRING_LENGTH });
  let deriving = 0;
  const fail = suffix => { throw Object.assign(new Error('work_data_recovery.' + suffix),
    { code: 'work_data_recovery.' + suffix, apiCode: 'work_data_recovery.' + suffix, statusCode: 409 }); };
  function create(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'limits')) fail('limits_invalid');
  const overrides = options.limits === undefined ? {} : options.limits;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)
    || Object.keys(overrides).some(key => !['bytes', 'files', 'directories', 'metadata', 'serialized', 'auxiliaries'].includes(key))
    || Object.values(overrides).some(value => !Number.isSafeInteger(value) || value < 1)) fail('limits_invalid');
  const LIMITS = Object.freeze({ ...DEFAULT_LIMITS, ...overrides });
  if (LIMITS.serialized > require('node:buffer').constants.MAX_STRING_LENGTH) fail('limits_invalid');
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const shape = (value, keys) => object(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
  const hash = value => cryptoApi.createHash('sha256').update(value).digest('hex');
  const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,160}$/.test(value);
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const text = value => typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value;
  const checkPassword = password => { if (!text(password) || password.length < 12 || Buffer.byteLength(password, 'utf8') > 1024) fail('password_invalid'); };
  function base64(value, max, exact) {
    if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4
      || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) fail('invalid');
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length > max || (exact !== undefined && bytes.length !== exact) || bytes.toString('base64') !== value) { bytes.fill(0); fail('invalid'); }
    return bytes;
  }
  function relative(value) {
    if (!text(value) || !value.length || value.length > LIMITS.path || value.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(value)) fail('path_invalid');
    const parts = value.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
      || /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) fail('path_invalid');
    return value;
  }
  function namespace(directories, files) {
    if (!Array.isArray(directories) || directories.length > LIMITS.directories || !Array.isArray(files) || files.length > LIMITS.files) fail('capacity');
    const names = new Map();
    for (const [kind, entries] of [['directory', directories], ['file', files]]) for (const value of entries) {
      if (kind === 'file' && !object(value)) fail('path_invalid');
      // Uppercase folds additional Windows aliases (e.g. dotless i) that lowercasing misses.
      const name = relative(kind === 'file' ? value.path : value), folded = name.toUpperCase();
      if (names.has(folded)) fail('path_conflict');
      names.set(folded, kind);
    }
    for (const name of names.keys()) {
      const pieces = name.split('/'); pieces.pop();
      while (pieces.length) {
        const parent = names.get(pieces.join('/'));
        if (parent === 'file') fail('path_conflict');
        if (parent !== 'directory') fail('directory_missing');
        pieces.pop();
      }
    }
  }
  function keyMetadata(key) {
    if (!shape(key, 'id,purpose,instanceId,protectedKey,masterSha256') || !id(key.id)
      || !['work-data', 'credential'].includes(key.purpose) || typeof key.instanceId !== 'string'
      || !/^[a-f0-9]{32}$/.test(key.instanceId) || !hex(key.masterSha256)) fail('key_invalid');
    const wrapped = base64(key.protectedKey, 64 * 1024);
    try { if (!wrapped.length) fail('key_invalid'); } finally { wrapped.fill(0); }
  }
  function manifestCheck(manifest, version = VERSION) {
    const fields = 'schema,appVersion,generation,createdAt,directories,keys,files,bytes' + (version === VERSION ? ',auxiliaries' : '');
    if (!shape(manifest, fields) || manifest.schema !== version
      || !text(manifest.appVersion) || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(manifest.appVersion) || manifest.appVersion.length > 80
      || !Number.isSafeInteger(manifest.generation) || manifest.generation < 0
      || typeof manifest.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(manifest.createdAt)
      || !Number.isFinite(Date.parse(manifest.createdAt)) || new Date(manifest.createdAt).toISOString() !== manifest.createdAt
      || !Number.isSafeInteger(manifest.bytes) || manifest.bytes < 0 || manifest.bytes > LIMITS.bytes
      || !Array.isArray(manifest.keys) || manifest.keys.length > LIMITS.keys) fail('manifest_invalid');
    namespace(manifest.directories, manifest.files);
    const keyIds = new Set(), instances = new Set();
    for (const key of manifest.keys) {
      keyMetadata(key);
      const instance = key.purpose + ':' + key.instanceId;
      if (keyIds.has(key.id) || instances.has(instance)) fail('key_invalid');
      keyIds.add(key.id); instances.add(instance);
    }
    let bytes = 0;
    for (const file of manifest.files) {
      if (!shape(file, 'path,size,sha256,keyRefs') || !Number.isSafeInteger(file.size) || file.size < 0 || !hex(file.sha256)
        || !Array.isArray(file.keyRefs) || file.keyRefs.length > LIMITS.keys || new Set(file.keyRefs).size !== file.keyRefs.length
        || file.keyRefs.some(ref => !keyIds.has(ref))) fail('manifest_invalid');
      bytes += file.size; if (!Number.isSafeInteger(bytes) || bytes > LIMITS.bytes) fail('capacity');
    }
    if (version === VERSION) {
      if (!Array.isArray(manifest.auxiliaries) || manifest.auxiliaries.length > LIMITS.auxiliaries) fail('auxiliary_invalid');
      const files = new Map(manifest.files.map(file => [file.path, file])), seen = new Set();
      for (const row of manifest.auxiliaries) {
        if (!shape(row, 'type,schema,sourcePath,sourceSha256,size,sha256') || !auxiliaryLimit(row.type) || row.schema !== 1
          || !Number.isSafeInteger(row.size) || row.size < 1 || row.size > auxiliaryLimit(row.type) || !hex(row.sha256) || !hex(row.sourceSha256)) fail('auxiliary_invalid');
        relative(row.sourcePath);
        const file = files.get(row.sourcePath), key = row.type + ':' + row.sourcePath;
        if (seen.has(key)) fail('auxiliary_invalid');
        if(row.type==='external-bot-credentials'){if(!file||file.sha256!==row.sourceSha256)fail('auxiliary_invalid');}
        else {const source=skillBackupSource(manifest.files,manifest.directories);if(row.sourcePath!==source.sourcePath||row.sourceSha256!==source.sourceSha256)fail('auxiliary_invalid');}
        seen.add(key); bytes += row.size;
        if (!Number.isSafeInteger(bytes) || bytes > LIMITS.bytes) fail('capacity');
      }
      // Opaque file paths do not establish domain ownership. The lifecycle host's
      // census must require every independently protected source's conversion.
    }
    if (bytes !== manifest.bytes || Buffer.byteLength(JSON.stringify(manifest), 'utf8') > LIMITS.metadata) fail('manifest_invalid');
    return manifest;
  }
  const auxiliaryLimit = type => type === 'external-bot-credentials' ? 4 * 1024 * 1024 : type === 'skill-backup-portable' ? LIMITS.bytes : 0;
  function skillBackupScope(relative) {
    const name = relative.toLowerCase();
    return /^(?:\.work-data\/generations\/[a-f0-9]{48}\/)?migrations\/skill-backups(?:\/|$)/.test(name)
      || /^\.work-data\/skill-backups(?:\/|$)/.test(name)
      || /^\.work-data\/generations\/[a-f0-9]{48}\/migrations\/skill-backup-bindings-v2\.sealed$/.test(name);
  }
  function skillBackupSource(files, directories) {
    const compare=(a,b)=>a<b?-1:a>b?1:0;
    const entries=files.filter(file=>skillBackupScope(file.path)).map(file=>({path:file.path,size:Buffer.isBuffer(file.data)?file.data.length:file.size,sha256:Buffer.isBuffer(file.data)?hash(file.data):file.sha256})).sort((a,b)=>compare(a.path,b.path));
    const dirs=directories.filter(skillBackupScope).sort(compare);
    const fold=value=>value.toLowerCase();
    const sourcePath=dirs.find(name=>fold(name)==='.work-data/skill-backups')||dirs.find(name=>fold(name)==='migrations/skill-backups');
    if(!sourcePath)fail('auxiliary_invalid');
    return Object.freeze({sourcePath,sourceSha256:hash(Buffer.from(JSON.stringify({files:entries,directories:dirs}))),files:Object.freeze(entries.map(row=>Object.freeze(row))),directories:Object.freeze(dirs)});
  }
  async function passwordKey(password, salt) {
    checkPassword(password);
    // Expensive derivations have a process-wide admission bound; hostile concurrent requests do
    // not allocate an unbounded number of 32 MiB scrypt jobs or silently change KDF parameters.
    if (deriving >= 2) fail('busy');
    deriving++;
    try {
      return await new Promise((resolve, reject) => cryptoApi.scrypt(password, salt, 32,
        { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(Object.assign(new Error('work_data_recovery.kdf_failed'), { code: 'work_data_recovery.kdf_failed' })) : resolve(key)));
    } finally { deriving--; }
  }
  const aad = header => Buffer.from(JSON.stringify(header), 'utf8');
  async function seal(snapshot, password) {
    checkPassword(password);
    if (!(shape(snapshot, 'appVersion,generation,createdAt,directories,keys,files') || shape(snapshot, 'appVersion,generation,createdAt,directories,keys,files,auxiliaries')) || !Array.isArray(snapshot.keys)
      || snapshot.keys.length > LIMITS.keys || !Array.isArray(snapshot.files) || snapshot.files.length > LIMITS.files) fail('invalid');
    namespace(snapshot.directories, snapshot.files);
    // Materialize an owned immutable-by-construction payload before the first await. Callers may
    // release their snapshot leases while scrypt runs without racing the exported master bytes.
    const keys = [], metadataKeys = [], files = [], metadataFiles = [], auxiliaries = [], metadataAuxiliaries = [];
    const auxiliaryInput = Object.hasOwn(snapshot, 'auxiliaries') ? snapshot.auxiliaries : [];
    if (!Array.isArray(auxiliaryInput) || auxiliaryInput.length > LIMITS.auxiliaries) fail('auxiliary_invalid');
    let bytes = 0;
    for (const key of snapshot.keys) {
      if (!shape(key, 'id,purpose,instanceId,protectedKey,master') || !Buffer.isBuffer(key.master) || key.master.length !== 32) fail('key_invalid');
      metadataKeys.push({ id: key.id, purpose: key.purpose, instanceId: key.instanceId, protectedKey: key.protectedKey, masterSha256: hash(key.master) });
      keys.push({ id: key.id, master: key.master.toString('base64') });
    }
    for (const file of snapshot.files) {
      if (!shape(file, 'path,data,keyRefs') || !Buffer.isBuffer(file.data)) fail('invalid');
      bytes += file.data.length; if (bytes > LIMITS.bytes) fail('capacity');
      metadataFiles.push({ path: file.path, size: file.data.length, sha256: hash(file.data), keyRefs: Array.isArray(file.keyRefs) ? [...file.keyRefs] : file.keyRefs });
      files.push({ path: file.path, data: file.data.toString('base64') });
    }
    for (const row of auxiliaryInput) {
      if (!shape(row, 'type,schema,sourcePath,sourceSha256,data') || !auxiliaryLimit(row.type) || row.schema !== 1
        || !Buffer.isBuffer(row.data) || row.data.length < 1 || row.data.length > auxiliaryLimit(row.type)) fail('auxiliary_invalid');
      bytes += row.data.length; if (!Number.isSafeInteger(bytes) || bytes > LIMITS.bytes) fail('capacity');
      metadataAuxiliaries.push({ type: row.type, schema: row.schema, sourcePath: row.sourcePath, sourceSha256: row.sourceSha256, size: row.data.length, sha256: hash(row.data) });
      auxiliaries.push({ type: row.type, schema: row.schema, sourcePath: row.sourcePath, data: row.data.toString('base64') });
    }
    const manifest = manifestCheck({ schema: VERSION, appVersion: snapshot.appVersion, generation: snapshot.generation, createdAt: snapshot.createdAt,
      directories: [...snapshot.directories], keys: metadataKeys, files: metadataFiles, auxiliaries: metadataAuxiliaries, bytes });
    // JSON payload and its base64 outer transport must fit the host's explicit engineering
    // budget. This is not a business-data quota; the owner can choose a larger supported budget
    // or a future streaming format, and the source tree remains untouched on rejection.
    const estimatedPayload = files.reduce((sum, file) => sum + file.data.length + Buffer.byteLength(file.path) + 32, 0)
      + auxiliaries.reduce((sum, row) => sum + row.data.length + Buffer.byteLength(row.sourcePath) + 128, 0)
      + Buffer.byteLength(JSON.stringify(manifest)) + Buffer.byteLength(JSON.stringify(keys)) + 256;
    if (estimatedPayload > require('node:buffer').constants.MAX_STRING_LENGTH
      || Math.ceil(estimatedPayload / 3) * 4 + 1024 > LIMITS.serialized) fail('capacity');
    const plain = Buffer.from(JSON.stringify({ manifest, manifestSha256: hash(JSON.stringify(manifest)), keys, files, auxiliaries }), 'utf8');
    const header = { kind: KIND, version: VERSION, exportId: cryptoApi.randomBytes(16).toString('hex'),
      kdf: { name: 'scrypt', N: 32768, r: 8, p: 1, salt: cryptoApi.randomBytes(16).toString('base64') }, cipher: 'aes-256-gcm' };
    let derived;
    try {
      derived = await passwordKey(password, Buffer.from(header.kdf.salt, 'base64'));
      const nonce = cryptoApi.randomBytes(12), cipher = cryptoApi.createCipheriv('aes-256-gcm', derived, nonce);
      cipher.setAAD(aad(header));
      const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
      try {
        const serialized = JSON.stringify({ ...header, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
        if (Buffer.byteLength(serialized, 'utf8') > LIMITS.serialized) fail('capacity');
        return serialized;
      } finally { ciphertext.fill(0); }
    } finally { plain.fill(0); if (derived) derived.fill(0); }
  }
  function captureContainer(serialized) {
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > LIMITS.serialized) fail('invalid');
    let container;
    try { container = JSON.parse(serialized); } catch { fail('invalid'); }
    if (!shape(container, 'kind,version,exportId,kdf,cipher,nonce,tag,data') || container.kind !== KIND || ![LEGACY_VERSION, VERSION].includes(container.version)
      || typeof container.exportId !== 'string' || !/^[a-f0-9]{32}$/.test(container.exportId) || container.cipher !== 'aes-256-gcm'
      || !shape(container.kdf, 'name,N,r,p,salt') || container.kdf.name !== 'scrypt' || container.kdf.N !== 32768 || container.kdf.r !== 8 || container.kdf.p !== 1) fail('invalid');
    let salt, nonce, tag, ciphertext;
    try {
      salt = base64(container.kdf.salt,16,16); nonce = base64(container.nonce,12,12); tag = base64(container.tag,16,16);
      ciphertext = base64(container.data, Math.ceil(LIMITS.bytes * 4 / 3) + LIMITS.metadata * 2);
      const header = {kind:container.kind,version:container.version,exportId:container.exportId,kdf:container.kdf,cipher:container.cipher};
      return {container,salt,nonce,tag,ciphertext,header,release:()=>{for(const bytes of [salt,nonce,tag,ciphertext])bytes.fill(0);}};
    } catch(error) {for(const bytes of [salt,nonce,tag,ciphertext])if(bytes)bytes.fill(0);throw error;}
  }
  function inspectSealed(serialized) {const value=captureContainer(serialized);try{return true;}finally{value.release();}}
  async function open(serialized, password) {
    checkPassword(password);
    const {container,salt,nonce,tag,ciphertext,header} = captureContainer(serialized);
    let derived, plain, snapshot, returned = false;
    const owned = [];
    try {
      derived = await passwordKey(password, salt);
      try {
        const decipher = cryptoApi.createDecipheriv('aes-256-gcm', derived, nonce); decipher.setAAD(aad(header)); decipher.setAuthTag(tag);
        // Do not expose unauthenticated update() bytes; final() must succeed before JSON parsing.
        const partial = decipher.update(ciphertext);
        try { plain = Buffer.concat([partial, decipher.final()]); } finally { partial.fill(0); }
      } catch { fail('authentication'); }
      let payload;
      try {
        const serializedPayload = plain.toString('utf8');
        if (!Buffer.from(serializedPayload, 'utf8').equals(plain)) fail('invalid');
        payload = JSON.parse(serializedPayload);
      } catch { fail('invalid'); }
      const payloadFields = 'manifest,manifestSha256,keys,files' + (container.version === VERSION ? ',auxiliaries' : '');
      if (!shape(payload, payloadFields) || !hex(payload.manifestSha256)
        || hash(JSON.stringify(payload.manifest)) !== payload.manifestSha256 || !Array.isArray(payload.keys) || !Array.isArray(payload.files)) fail('manifest_invalid');
      const manifest = manifestCheck(payload.manifest, container.version);
      if (payload.keys.length !== manifest.keys.length || payload.files.length !== manifest.files.length) fail('manifest_invalid');
      if (container.version === VERSION && (!Array.isArray(payload.auxiliaries) || payload.auxiliaries.length !== manifest.auxiliaries.length)) fail('auxiliary_invalid');
      const keys = [], files = [];
      for (let i = 0; i < manifest.keys.length; i++) {
        const row = payload.keys[i], expected = manifest.keys[i];
        if (!shape(row, 'id,master') || row.id !== expected.id) fail('key_invalid');
        const master = base64(row.master, 32, 32); owned.push(master);
        if (hash(master) !== expected.masterSha256) fail('key_invalid');
        const { masterSha256, ...metadata } = expected; keys.push({ ...metadata, master });
      }
      for (let i = 0; i < manifest.files.length; i++) {
        const row = payload.files[i], expected = manifest.files[i];
        if (!shape(row, 'path,data') || row.path !== expected.path) fail('manifest_invalid');
        const data = base64(row.data, expected.size, expected.size); owned.push(data);
        if (hash(data) !== expected.sha256) fail('manifest_invalid');
        files.push({ path: expected.path, data, keyRefs: [...expected.keyRefs] });
      }
      const auxiliaries = [];
      if (container.version === VERSION) for (let i = 0; i < manifest.auxiliaries.length; i++) {
        const expected = manifest.auxiliaries[i], row = payload.auxiliaries[i];
        if (!shape(row, 'type,schema,sourcePath,data') || row.type !== expected.type || row.schema !== expected.schema || row.sourcePath !== expected.sourcePath) fail('auxiliary_invalid');
        const data = base64(row.data, expected.size, expected.size); owned.push(data);
        if (hash(data) !== expected.sha256) fail('auxiliary_invalid');
        auxiliaries.push({ type: expected.type, schema: expected.schema, sourcePath: expected.sourcePath, sourceSha256: expected.sourceSha256, data });
      }
      snapshot = { appVersion: manifest.appVersion, generation: manifest.generation, createdAt: manifest.createdAt,
        directories: [...manifest.directories], keys, files, auxiliaries };
      let released = false;
      const release = () => { if (!released) { released = true; for (const bytes of owned) bytes.fill(0); } };
      returned = true;
      return Object.freeze({ snapshot, manifestSha256: payload.manifestSha256, release });
    } finally {
      if (!returned) for (const bytes of owned) bytes.fill(0);
      if (derived) derived.fill(0); if (plain) plain.fill(0); ciphertext.fill(0); salt.fill(0); nonce.fill(0); tag.fill(0);
    }
  }
  return Object.freeze({ KIND, VERSION, LIMITS, seal, open, inspectSealed, skillBackupSource });
  }
  return Object.freeze({ KIND, VERSION, LIMITS: DEFAULT_LIMITS, create, ...create() });
})(require('node:crypto'));
