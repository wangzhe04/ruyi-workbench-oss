// Lazy production composition. Loading this module starts no processes and does
// not inspect or copy a runtime. Only an authenticated prepare request does so.
const MediaImageHost = (() => {
  const fail = suffix => { throw Object.assign(Error('privacy.image_' + suffix), { code: 'privacy.image_' + suffix, statusCode: 409 }); };
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const same = (a, b) => ['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key => a[key] === b[key]);
  const managed = work => typeof WorkDataMaintenanceHooks.run === 'function' ? WorkDataMaintenanceHooks.run('media-image', work) : work();
  const LOCAL_SOURCE_LIMIT = 50 * 1024 * 1024;
  const localHelperHashes = Object.freeze({
    'native-file-read.py': '6a307d73f881492718356fe139635d35f49c321dd951711daf6d8baef300e9ea',
    'native-video-read.py': '91cbfce6403de135c72908e9f8e0ea900d720c5d9c36bcad980084d936f82ab9',
  });
  const localPythonStartupHashes = Object.freeze({
    'Lib/site-packages/distutils-precedence.pth': '2638ce9e2500e572a5e0de7faed6661eb569d1b696fcba07b0dd223da5f5d224',
    'Lib/site-packages/pywin32.pth': 'e7cd73df98b91c407dfd96d1f4dd18b7f9a60f29902b92cf5ece79b6eb637b81',
    'Lib/site-packages/_distutils_hack/__init__.py': 'df81e6bcba34ee3e3952f776551fb669143b9490fdd6c4caeb32609f97e985b4',
    'Lib/site-packages/win32/lib/pywin32_bootstrap.py': 'fd31f27bc85a6b9c974670838b6eefafb32991be4a9f840f96a4f5524df3b3c3',
  });
  let processorPromise = null, processorOwner = null, preparedAny = false;
  let localHelperActive = false, localHelperUnknown = false, localSourceReads = 0, sealedSourceCleanupUnknown = false;
  function processor() {
    // Paths are supplied by the application installation/environment, never by
    // browser JSON. There is no PATH lookup or cloud/installation fallback.
    if (!processorPromise) {
      const runtimeRoot = path.resolve(process.env.RUYI_MEDIA_RUNTIME_ROOT || path.join(externalRoot(), 'mcp', 'ai-computer-control'));
      const sourceRoot = path.resolve(process.env.RUYI_MEDIA_SOURCES_ROOT || path.join(externalRoot(), 'resources', 'media-runtime-sources'));
      processorPromise = MediaImageProcessor.create({ runtimeRoot, sourceRoot, language: process.env.RUYI_MEDIA_OCR_LANGUAGE || 'zh-Hans-CN',
        resourceProfile: process.env.RUYI_MEDIA_RESOURCE_PROFILE ?? 'legacy-full-4987-v1' }).then(owner => { processorOwner = owner; return owner; });
      // Keep the failed result. Repeated user sends do not create implicit worker
      // or dependency retries under an unknown ownership state.
      processorPromise.catch(() => {});
    }
    return processorPromise;
  }
  // This cache is never replaced, including after configuration changes or a
  // failed request. Observe that same resolved owner without creating resources.
  function helperMayStillRun() {
    return localHelperActive || localHelperUnknown || sealedSourceCleanupUnknown || (processorOwner !== null && processorOwner.helperMayStillRun() !== false);
  }
  function sealedSourceCleanupFailure(cause) {
    sealedSourceCleanupUnknown = true;
    return Object.assign(Error('privacy.image_source_cleanup_unknown', { cause }), { helperMayStillRun: true });
  }
  function assertAncestors(target) {
    const absolute = path.resolve(target), parsed = path.parse(absolute); let current = parsed.root;
    for (const bit of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, bit);
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || fold(fs.realpathSync.native(current)) !== fold(current)) fail('source_alias');
    }
  }
  function verifyLocalPythonStartup(pythonRoot, pin) {
    // The pinned python312._pth enables site even with -S. These are its site
    // directories and the additional import paths from the pinned pywin32.pth.
    // This checks startup hooks. The Full install remains a trusted runtime.
    const site = 'Lib/site-packages';
    const packages = [`${site}/_distutils_hack`, `${site}/pywin32_system32`];
    const allowed = new Set([...Object.keys(localPythonStartupHashes), ...packages]);
    const entries = directory => { assertAncestors(directory); return fs.readdirSync(directory); };
    const windowsName = name => name.toLowerCase().replace(/[. ]+$/, '');
    const startupModule = /^(?:sitecustomize|_distutils_hack|pywin32_bootstrap|pywin32_system32)(?:$|\.pyc?$|(?:\.[^.]+)?\.pyd$)/;
    if (entries(path.dirname(pythonRoot)).some(name => windowsName(name) === 'pyvenv.cfg')) fail('worker_changed');
    for (const relative of ['', site, `${site}/win32`, `${site}/win32/lib`, `${site}/pythonwin`, ...packages]) {
      for (const name of entries(path.join(pythonRoot, relative))) {
        const normalized = windowsName(name);
        const siteHook = (relative === '' || relative === site) && normalized.endsWith('.pth');
        const packageInit = packages.includes(relative) && /^__init__\.(?:pyc?|(?:[^.]+\.)?pyd)$/.test(normalized);
        if ((siteHook || (!relative && normalized === 'pyvenv.cfg') || startupModule.test(normalized) || packageInit)
          && !allowed.has(relative ? `${relative}/${name}` : name)) fail('worker_changed');
      }
    }
    for (const [relative, sha256] of Object.entries(localPythonStartupHashes)) {
      const file = path.join(pythonRoot, relative), before = pin(file);
      if (before.size > 16n * 1024n || hash(fs.readFileSync(file)) !== sha256 || !same(before, pin(file))) fail('worker_changed');
    }
  }
  async function readLocalMediaFile(file, signal, read, { expectedStat } = {}) {
    const assertSignal = () => { if (signal?.aborted) fail('cancelled'); };
    assertSignal(); assertAncestors(path.dirname(file));
    const original = fs.lstatSync(file, { bigint: true });
    if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1n) fail('source_invalid');
    if (expectedStat && !same(original, expectedStat)) fail('source_changed');
    if (original.size < 1n || original.size > BigInt(LOCAL_SOURCE_LIMIT)) fail('source_limit');
    const assert = () => {
      assertSignal(); assertAncestors(path.dirname(file));
      const current = fs.lstatSync(file, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || !same(original, current)) fail('source_changed');
    };
    if (localSourceReads >= 2) fail('worker_busy');
    localSourceReads++;
    let bytes;
    try {
      bytes = Buffer.alloc(Number(original.size));
      const handle = await fsp.open(file, 'r');
      try {
        const assertHeld = async () => {
          if (!same(original, await handle.stat({ bigint: true }))) fail('source_changed');
          assert();
        };
        await assertHeld();
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!bytesRead) fail('source_changed');
          offset += bytesRead;
          await assertHeld();
        }
      } finally { await handle.close(); }
      const revision = hash(JSON.stringify([hash(bytes), ...['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'].map(key => String(original[key]))]));
      const result = await read(bytes, Object.freeze({ revision, assert }));
      assert();
      return result;
    } finally { bytes?.fill(0); localSourceReads--; }
  }
  function runLocalChild(executable, helper, argv, bytes, { signal, timeoutMs, maxBytes, env }) {
    return new Promise((resolve, reject) => {
      if (typeof WorkDataMaintenanceHooks.admitHelper === 'function') WorkDataMaintenanceHooks.admitHelper();
      // -B only prevents writes. A fresh uncreated prefix also bypasses the
      // existing __pycache__ files next to the verified Python sources.
      const cachePrefix = path.join(path.dirname(executable), '.ruyi-pycache-' + crypto.randomBytes(16).toString('hex'));
      const child = require('node:child_process').spawn(executable, ['-I', '-B', '-X', 'utf8', '-X', `pycache_prefix=${cachePrefix}`, helper, ...argv], {
        cwd: path.dirname(executable), env, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
      });
      const input = Buffer.from(bytes);
      const chunks = [];
      let size = 0, failure = '', settled = false, closeDeadline;
      const timeout = setTimeout(() => stop('worker_timeout'), timeoutMs);
      const abort = () => stop('cancelled');
      function finish(code) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout); clearTimeout(closeDeadline);
        signal?.removeEventListener('abort', abort);
        let output;
        try {
          if (failure || code !== 0) fail(failure || 'worker_failed');
          output = Buffer.concat(chunks, size);
          let result;
          try { result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(output)); }
          catch { fail('worker_output'); }
          resolve(result);
        } catch (error) { reject(error); }
        finally { output?.fill(0); for (const chunk of chunks) chunk.fill(0); }
      }
      function stop(reason) {
        if (settled || failure) return;
        failure = reason;
        closeDeadline = setTimeout(() => {
          localHelperUnknown = true;
          finish(null);
        }, 2000);
        child.stdin.destroy();
        try { child.kill(); } catch { /* Close must still be observed. */ }
      }
      child.on('error', () => stop('worker_failed'));
      child.stdin.on('error', () => stop('worker_input'));
      child.stdout.on('error', () => stop('worker_output'));
      child.stdout.on('data', chunk => {
        if (settled || failure || size + chunk.length > maxBytes) { chunk.fill(0); stop('worker_output_limit'); return; }
        chunks.push(chunk); size += chunk.length;
      });
      child.once('close', code => { input.fill(0); finish(code); });
      try { if (typeof WorkDataMaintenanceHooks.trackChild === 'function') WorkDataMaintenanceHooks.trackChild(child); }
      catch { stop('worker_failed'); return; }
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      else child.stdin.end(input, () => input.fill(0));
    });
  }
  async function runLocalMediaHelper(name, argv, bytes, { signal, timeoutMs, maxBytes, env = {} } = {}) {
    if (process.platform !== 'win32' || !Object.hasOwn(localHelperHashes, name)) fail('runtime_unavailable');
    if (!Array.isArray(argv) || argv.length > 4 || argv.some(value => typeof value !== 'string' || value.length > 4096 || value.includes('\0'))
      || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > LOCAL_SOURCE_LIMIT
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
      || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 24 * 1024 * 1024) fail('worker_input');
    if (signal?.aborted) fail('cancelled');
    if (localHelperActive || localHelperUnknown) fail('worker_busy');
    const profile = process.env.RUYI_MEDIA_RESOURCE_PROFILE ?? 'legacy-full-4987-v1';
    if (profile !== 'legacy-full-4987-v1') fail('runtime_unavailable');
    localHelperActive = true;
    try {
      return await managed(async () => {
        const runtime = path.resolve(process.env.RUYI_MEDIA_RUNTIME_ROOT || path.join(externalRoot(), 'mcp', 'ai-computer-control'));
        const sources = path.resolve(process.env.RUYI_MEDIA_SOURCES_ROOT || path.join(externalRoot(), 'resources', 'media-runtime-sources'));
        const executable = path.join(runtime, 'python_embed', 'python.exe');
        const helper = path.join(externalRoot(), 'resources', name);
        const pin = file => {
          assertAncestors(path.dirname(file));
          const stat = fs.lstatSync(file, { bigint: true });
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) fail('worker_changed');
          return stat;
        };
        const verify = async expected => {
          try {
            const before = [pin(executable), pin(helper)];
            if (expected && expected.some((stat, index) => !same(stat, before[index]))) fail('worker_changed');
            const { verifyMediaArtifacts } = require('../tools/verify-media-artifacts.cjs');
            const bound = signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000);
            await verifyMediaArtifacts(runtime, sources, { signal: bound });
            if (before[1].size > 1024n * 1024n || hash(fs.readFileSync(helper)) !== localHelperHashes[name]
              || !same(before[0], pin(executable)) || !same(before[1], pin(helper))) fail('worker_changed');
            verifyLocalPythonStartup(path.dirname(executable), pin);
            return before;
          } catch {
            if (signal?.aborted) fail('cancelled');
            fail('runtime_unavailable');
          }
        };
        const childEnv = {};
        for (const key of ['SystemRoot', 'WINDIR', 'SystemDrive', 'TEMP', 'TMP']) if (process.env[key]) childEnv[key] = process.env[key];
        if (name === 'native-video-read.py') {
          const capture = env.OPENCV_FFMPEG_CAPTURE_OPTIONS;
          const demuxer = argv[0];
          if (!['mov', 'matroska', 'avi'].includes(demuxer)) fail('worker_input');
          const whitelist = demuxer === 'matroska' ? 'matroska,webm' : demuxer;
          const expected = `protocol_whitelist;ruyi-no-external-io|format_whitelist;${whitelist}|input_format;${demuxer}|max_pixels;8294400`
            + (demuxer === 'mov' ? '|enable_drefs;0|use_absolute_path;0' : '');
          if (capture !== expected) fail('worker_input');
          childEnv.OPENCV_FFMPEG_CAPTURE_OPTIONS = capture;
          childEnv.OPENCV_LOG_LEVEL = 'SILENT';
        }
        const pins = await verify();
        if (signal?.aborted) fail('cancelled');
        const value = await runLocalChild(executable, helper, argv, bytes, { signal, timeoutMs, maxBytes, env: childEnv });
        await verify(pins);
        return value;
      });
    } finally { localHelperActive = false; }
  }
  async function sourceFor({ id, name }, sessionId, scopeOwner, encrypted, signal) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof name !== 'string'
      || !name || name.length > 200 || name !== path.win32.basename(name) || sanitizeFsSegmentName(name) !== name || /[. ]$/.test(name)) fail('source_invalid');
    const root = path.resolve(paths.uploads);
    if (encrypted) {
      if (sealedSourceCleanupUnknown) fail('source_cleanup_unknown');
      if (typeof WorkDataAttachmentUploadHooks.captureImageSource !== 'function') fail('source_invalid');
      const sourceLimit = MediaImageContract.LIMITS.sourceBytes;
      let lease;
      try { lease = await WorkDataAttachmentUploadHooks.captureImageSource({ id, name, signal, sourceLimit }); }
      catch (error) {
        if (error?.ownershipRetained === true) throw scopeOwner.retainCleanup(error, undefined, false, sealedSourceCleanupFailure(error));
        throw error;
      }
      let released = false;
      const assert = () => {
        scopeOwner.assert();
        if (sealedSourceCleanupUnknown) fail('source_cleanup_unknown');
        if (released || path.resolve(paths.uploads) !== root) fail('source_changed');
        try { return lease.assert(); }
        catch (error) { throw error?.ownershipRetained === true ? sealedSourceCleanupFailure(error) : error; }
      };
      const release = () => {
        if (released) return;
        released = true;
        try { lease.release(); }
        catch (cleanup) { throw sealedSourceCleanupFailure(cleanup); }
      };
      try {
        assert();
        if (!lease.complete || lease.bytes.length < 1 || lease.bytes.length > sourceLimit) fail('source_invalid');
        const snapshot = Object.freeze({ bytes: lease.bytes, hash: lease.sha256, revision: lease.sourceRevision, scope: hash(sessionId).slice(0, 32) });
        return Object.freeze({ id, name, snapshot, assert, release });
      } catch (error) {
        try { release(); }
        catch (cleanup) { throw scopeOwner.retainCleanup(lease,error,true,cleanup); }
        throw error;
      }
    }
    const file = path.join(root, id, name), directory = path.dirname(file);
    assertAncestors(directory);
    const visible = fs.lstatSync(file, { bigint: true });
    if (!visible.isFile() || visible.isSymbolicLink() || visible.nlink !== 1n || visible.size < 1n || visible.size > BigInt(MediaImageContract.LIMITS.sourceBytes)) fail('source_invalid');
    const handle = await fsp.open(file, 'r'); let released = false, bytes;
    const assert = () => {
      scopeOwner.assert();
      if (released || path.resolve(paths.uploads) !== root) fail('source_changed');
      assertAncestors(directory);
      const held = fs.fstatSync(handle.fd, { bigint: true }), current = fs.lstatSync(file, { bigint: true });
      if (!held.isFile() || !current.isFile() || current.isSymbolicLink() || !same(visible, held) || !same(visible, current)) fail('source_changed');
      return true;
    };
    try {
      assert(); bytes = Buffer.alloc(Number(visible.size)); let offset=0;
      while(offset<bytes.length){const row=await handle.read(bytes,offset,bytes.length-offset,null);if(!row.bytesRead)fail('source_changed');offset+=row.bytesRead;assert();}
      const tail=Buffer.alloc(1);try{if((await handle.read(tail,0,1,null)).bytesRead)fail('source_changed');}finally{tail.fill(0);}assert();
      const sourceHash = hash(bytes), scope = hash(sessionId).slice(0,32);
      const revision = hash(JSON.stringify(['dev','ino','size','mtimeNs','ctimeNs'].map(key => String(visible[key]))));
      const snapshot = Object.freeze({ bytes, hash: sourceHash, revision, scope });
      return Object.freeze({ id, name, snapshot, assert, async release() { if (!released) { released = true; bytes.fill(0); await handle.close(); } } });
    } catch (error) {
      bytes?.fill(0);
      try { await handle.close(); }
      catch (cleanup) { throw scopeOwner.retainCleanup({handle,bytes},error,true,cleanup); }
      throw error;
    }
  }
  async function writeRecord(target, payload, options) {
    if (typeof payload === 'string') return atomicWriteJson(target, async function* () { yield Buffer.from(payload); }, { stream: true });
    return atomicWriteJson(target, payload, options);
  }
  const service = MediaImageService.create({ context: () => PrivacyGateway.active(), storeFor: async ({ scopeId, authority }) => {
    if (!/^[a-f0-9]{32}$/.test(scopeId)) fail('scope_changed');
    const root = path.join(paths.data, 'media-derived-v1', scopeId);
    assertAncestors(paths.data);
    // A new family has no legacy external files; create only our own two levels.
    for (const directory of [path.dirname(root), root]) {
      try { await fsp.mkdir(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      assertAncestors(directory);
    }
    const store = MediaDerivedStore.create({ root, scopeId, authority, keys: WorkDataStore.requireKeys(),
      enabled: async () => { const config = await readConfig(); if (typeof config.workDataEncryptionV1 !== 'boolean') fail('storage_unavailable'); return config.workDataEncryptionV1; },
      writeJson: writeRecord });
    return Object.freeze({ put: value => store.put(value), read: id => store.read(id), remove: id => managed(() => store.remove(id)), dispose:()=>managed(()=>store.dispose()) });
  } });
  function currentRecipient(config) {
    const provider = activeOpenAiProvider(config);
    if (!provider || provider.vision !== true) fail('vision_required');
    const wire = providerWireProtocol(provider);
    return MediaImageService.recipientHash(wire.completionUrl(provider.baseUrl), wire.requestHeaders(provider, { model: provider.model }));
  }
  async function prepare(input, signal) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['sessionId','id','name','regions'].includes(key))) fail('request_invalid');
    const sessionId=assertSessionIdForPath(input.sessionId), scopeOwner=service.beginScope(sessionId);
    let source, transferred=false, primary, failed=false;
    try {
      scopeOwner.assert();
      const config=await readConfig(); scopeOwner.assert();
      const session=await loadSession(sessionId); scopeOwner.assert();
      if (!session || sessionSaveIsTombstoned(session)) throw Object.assign(Error('session.not_found'), {code:'session.not_found',statusCode:404});
      return await PrivacyGateway.run(sessionId,config,()=>managed(async()=>{
        scopeOwner.assert();
        const policy=PrivacyGateway.captureMediaPolicy(); if(!policy)fail('protection_disabled');
        const recipient=currentRecipient(config);
        source=await sourceFor(input,sessionId,scopeOwner,config.workDataEncryptionV1===true,signal); scopeOwner.assert();
        policy.assert();source.assert();
        const owner=await processor(); scopeOwner.assert(); policy.assert();source.assert();
        if(!MediaImageProcessor.isOwner(owner))fail('processor_unavailable');
        transferred=true;
        const result=await service.prepare({sessionId,source,policy,processor:owner,recipient,signal,regions:input.regions??null,scopeOwner});
        // prepare published in this turn; revocation in the await continuation
        // must still refuse the HTTP result. Service cleanup owns the record.
        scopeOwner.assert(); preparedAny=true; return result;
      }));
    } catch(error) { failed=true; primary=error; throw error; }
    finally {
      if(!transferred) {
        try { if(source)await source.release(); }
        catch(cleanup) { throw scopeOwner.retainCleanup(source,primary,failed,cleanup); }
        finally { scopeOwner.release(); }
      }
    }
  }
  async function buildUserContentParts(textContent, attachments) {
    const config = await readConfig();
    PrivacyGateway.assertPolicyAvailable(config);
    if (config.privacyModeV1 === 'off') return null;
    const policy = PrivacyGateway.captureMediaPolicy(); if (!policy) fail('policy_unavailable');
    const parts = [{ type: 'text', text: String(textContent || '') }];
    for (const attachment of attachments || []) if (attachment?.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment?.name || attachment?.path || '')) {
      parts.push({ type: 'image_url', image_url: { url: service.referenceFor(attachment) } });
    }
    return parts;
  }
  function hasPreparedAttachment(file) {
    if (!PrivacyGateway.active() || !MediaImageService.referenceId(file.protectedImage?.reference)) return false;
    service.referenceFor(file);
    return true;
  }
  function assertSealedSteerReference(file, sessionId, config) {
    return PrivacyGateway.run(sessionId, config, () => {
      if (!PrivacyGateway.captureMediaPolicy()) fail('protection_disabled');
      return service.referenceFor(file);
    });
  }
  function projectPart(part, detail) { return service.projectPart(part, detail); }
  async function beforeModelPost({ body, url, headers, signal }) {
    // Preserve the ordinary OFF identity path, including objects which must only
    // be inspected by the original JSON encoder, until this process owns media.
    if (!preparedAny && !PrivacyGateway.active()) return null;
    const currentRecipient=()=>MediaImageService.recipientHash(url,headers);
    return managed(() => service.delivery(body, currentRecipient(), signal, currentRecipient));
  }
  // 处理器可用性:给 media_probe 一个诚实的答案(它决定 file_read 的视觉分支与渲染件能不能经保护交付)。
  // 只在第一次真的尝试建 owner —— 之后的调用命中同一个 promise 缓存,不会反复起进程。
  async function availability() {
    // 复审(2026-11-05):探针不能真的 `await processor()` —— 那个 promise 连失败都缓存,
    // 杀软占用/半装/磁盘抖动会让渲染管线在进程重启前彻底不可用,而 media_probe 是 read 档工具。
    // 这里只做文件级判定:渲染管线要跑的 python_embed 在不在。
    try {
      const runtimeRoot = path.resolve(process.env.RUYI_MEDIA_RUNTIME_ROOT || path.join(externalRoot(), 'mcp', 'ai-computer-control'));
      const executable = path.join(runtimeRoot, 'python_embed', process.platform === 'win32' ? 'python.exe' : 'python');
      const stat = await fsp.stat(executable).catch(() => null);
      if (!stat || !stat.isFile()) return { available: false, path: null, reason: 'component_missing' };
      return { available: true, path: executable, reason: null };
    } catch { return { available: false, path: null, reason: 'unavailable' }; }
  }
  // 「渲染 + 遮盖」的接缝:把渲染出来的页面(内存 Buffer)准备成受保护图片引用。
  // 顺序固定:会话 → 策略(必须在 turn 的 PrivacyGateway scope 里) → 收件人(vision provider) → 处理器(真实原生组件)。
  // 任何一步不满足都 fail-closed,绝不把原始像素交回调用方;成功时只回引用,像素留在派生库里由交付层替换。
  function renderedInputs(pages) {
    const count = Array.isArray(pages) ? pages.length : 0;
    if (!count || count > 4) fail('render_invalid');
    const inputs = [];
    for (let index = 0; index < count; index++) {
      const { name, bytes } = pages[index] || {};
      if (typeof name !== 'string' || !name || name.length > 200
        || !Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MediaImageContract.LIMITS.sourceBytes) fail('render_invalid');
      inputs.push({ name, bytes });
    }
    return inputs;
  }
  async function withPageBatch(session, signal, work) {
    const firstScopeOwner = service.beginScope(session);
    let firstTransferred = false;
    const assertBatch = () => {
      firstScopeOwner.assert();
      if (signal?.aborted) fail('cancelled');
    };
    try {
      assertBatch();
      return await work(assertBatch, async (inputs, policy, recipient, parent) => {
        assertBatch();
        const owner = await processor();
        assertBatch(); policy.assert(); parent?.assert();
        if (!MediaImageProcessor.isOwner(owner)) fail('processor_unavailable');
        const references = [];
        try {
          // The first record owns the batch's original scope epoch. A later page
          // cannot start in a new epoch after the session was revoked.
          for (const [index, page] of inputs.entries()) {
            assertBatch(); policy.assert();
            const source = MediaImageService.renderedSource({ id: 'render-' + index, name: page.name, bytes: page.bytes, sessionId: session, parent });
            const scopeOwner = index === 0 ? firstScopeOwner : undefined;
            const prepared = await service.prepare({ sessionId: session, source, policy, processor: owner, recipient, signal, scopeOwner });
            if (scopeOwner) firstTransferred = true;
            references.push(Object.freeze({ name: source.name, id: prepared.id, reference: prepared.reference }));
          }
          assertBatch();
          for (const item of references) {
            try {
              if (!service.projectPart({ type: 'image_url', image_url: { url: item.reference } }, { scopeId: session, pointer: '/messages/0/content/0' })) fail('render_revoked');
            } catch { fail('render_revoked'); }
          }
          preparedAny = true;
          return Object.freeze({ references: Object.freeze(references), recipient });
        } catch (error) {
          await service.discardPrepared(references.map(item => item.id), error);
          throw error;
        }
      });
    } finally {
      if (!firstTransferred) firstScopeOwner.release();
    }
  }
  async function prepareRenderedPages({ sessionId, pages, signal } = {}) {
    const inputs = renderedInputs(pages), session = assertSessionIdForPath(sessionId);
    return withPageBatch(session, signal, async (assertBatch, preparePages) => {
      const config = await readConfig();
      assertBatch(); PrivacyGateway.assertPolicyAvailable(config);
      return PrivacyGateway.run(session, config, () => managed(async () => {
        assertBatch();
        const policy = PrivacyGateway.captureMediaPolicy(); if (!policy) fail('protection_disabled');
        return preparePages(inputs, policy, currentRecipient(config));
      }));
    });
  }
  async function prepareToolVisual(route, produce) {
    if (!route || route.scopeId !== PrivacyGateway.active()?.scopeId) fail('scope_changed');
    return withPageBatch(route.scopeId, route.signal, (assertBatch, preparePages) => managed(async () => {
      const policy = PrivacyGateway.captureMediaPolicy(); if (!policy) fail('protection_disabled');
      const recipient = MediaImageService.recipientHash(route.url, route.headers);
      assertBatch(); policy.assert();
      const { result, pages = [], source } = await produce();
      try {
        assertBatch(); policy.assert();
        if (!result.ok) return { result };
        const prepared = await preparePages(renderedInputs(pages), policy, recipient, source);
        const ids = prepared.references.map(item => item.id);
        return { result, prepared: Object.freeze({ ...prepared, release: () => service.discardPrepared(ids) }) };
      } finally {
        for (const page of pages) page.bytes.fill(0);
      }
    }));
  }
  function attachmentPrompt(file) {
    const policy = PrivacyGateway.captureMediaPolicy(); if (!policy) return null;
    if (!(file?.kind === 'image' || /\.(png|jpe?g|gif|webp|bmp)$/i.test(file?.name || file?.path || ''))) return null;
    service.referenceFor(file);
    return '- protected.png: locally processed image attached below; original filename, path and OCR text withheld.';
  }
  async function handleApiRoutes(req, res, pathname) {
    const routeRoot='/api/media/images/';
    if (!pathname.startsWith(routeRoot)) return false;
    if (!tokenOk(req)) { send(res, apiFailure('auth.token_invalid', {}, 'missing or invalid workbench token', 403)); return true; }
    const controller = new AbortController();
    const abort = () => controller.abort(); req.once('aborted', abort);
    const closed = () => { if (!res.writableFinished) abort(); }; res.once('close', closed);
    try {
      if (req.method === 'POST' && pathname === '/api/media/images/prepare') {
        const body = await readJsonBody(req), result = await prepare(body, controller.signal);
        send(res, json({ ok: true, ...result })); return true;
      }
      const match = /^\/api\/media\/images\/([a-f0-9]{32})(?:\/(preview))?$/.exec(pathname);
      if (!match || !['GET','DELETE'].includes(req.method) || (req.method === 'GET' && !match[2]) || (req.method === 'DELETE' && match[2])) return false;
      if (req.method === 'DELETE' && pathname.startsWith('/api/media/images/')) { await managed(() => service.remove(match[1])); send(res, json({ ok: true })); return true; }
      if (req.method === 'GET' && pathname.startsWith('/api/media/images/')) {
      const q = new URL(req.url, 'http://localhost').searchParams;
      const sessionId = assertSessionIdForPath(q.get('sessionId')), config = await readConfig();
      await PrivacyGateway.run(sessionId, config, () => managed(async () => {
        const borrowed = await service.borrow(match[1]);
        try {
          borrowed.assert();
          res.writeHead(200, { 'content-type': 'image/png', 'content-length': borrowed.bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-ruyi-payload-sha256': borrowed.manifest.payloadHash,
            'x-ruyi-manifest-sha256': hash(JSON.stringify(borrowed.manifest)) });
          res.end(borrowed.bytes, () => borrowed.release());
        } catch (error) { borrowed.release(); throw error; }
      }));
      return true;
      }
      return false;
    } catch (error) {
      if (res.headersSent) { res.destroy(); return true; }
      const code = /^(?:privacy\.image_|privacy\.(?:policy|scope)|media_store\.|work_data)/.test(error?.code || '') ? error.code : 'privacy.image_request_failed';
      send(res, apiFailure(code, {}, code, error?.statusCode || 409)); return true;
    } finally { req.removeListener('aborted', abort); res.removeListener('close', closed); }
  }
  PrivacyGateway.setHost({ projectMediaPart: projectPart, invalidateMedia: () => { void service.invalidate().catch(() => {}); } });
  Object.assign(ProviderMediaHooks, { beforeModelPost });
  Object.assign(VisualMediaHooks, { buildUserContentParts, hasPreparedAttachment });
  Object.assign(MediaImageHooks, { attachmentPrompt, prepareRenderedPages, prepareToolVisual, readLocalMediaFile, runLocalMediaHelper,
    availability, handleApiRoutes, helperMayStillRun, assertSealedSteerReference,
    revokeScope: sessionId => service.revokeScope(sessionId) });
  return Object.freeze({ prepare });
})();
