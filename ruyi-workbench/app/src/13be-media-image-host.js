// Lazy production composition. Loading this module starts no processes and does
// not inspect or copy a runtime. Only an authenticated prepare request does so.
const MediaImageHost = (() => {
  const fail = suffix => { throw Object.assign(Error('privacy.image_' + suffix), { code: 'privacy.image_' + suffix, statusCode: 409 }); };
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const same = (a, b) => ['dev','ino','size','mtimeNs','ctimeNs','nlink'].every(key => a[key] === b[key]);
  const managed = work => typeof WorkDataMaintenanceHooks.run === 'function' ? WorkDataMaintenanceHooks.run('media-image', work) : work();
  let processorPromise = null, processorOwner = null, preparedAny = false;
  function processor() {
    // Paths are supplied by the application installation/environment, never by
    // browser JSON. There is no PATH lookup or cloud/installation fallback.
    if (!processorPromise) {
      const runtimeRoot = path.resolve(process.env.RUYI_MEDIA_RUNTIME_ROOT || path.join(appRoot(), 'mcp', 'ai-computer-control'));
      const sourceRoot = path.resolve(process.env.RUYI_MEDIA_SOURCES_ROOT || path.join(appRoot(), 'resources', 'media-runtime-sources'));
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
  function helperMayStillRun() { return processorOwner === null ? false : processorOwner.helperMayStillRun() !== false; }
  function assertAncestors(target) {
    const absolute = path.resolve(target), parsed = path.parse(absolute); let current = parsed.root;
    for (const bit of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, bit);
      const stat = fs.lstatSync(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || fold(fs.realpathSync.native(current)) !== fold(current)) fail('source_alias');
    }
  }
  async function sourceFor({ id, name }, sessionId, scopeOwner) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof name !== 'string'
      || !name || name.length > 200 || name !== path.win32.basename(name) || sanitizeFsSegmentName(name) !== name || /[. ]$/.test(name)) fail('source_invalid');
    const root = path.resolve(paths.uploads), file = path.join(root, id, name), directory = path.dirname(file);
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
        source=await sourceFor(input,sessionId,scopeOwner); scopeOwner.assert();
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
      const runtimeRoot = path.resolve(process.env.RUYI_MEDIA_RUNTIME_ROOT || path.join(appRoot(), 'mcp', 'ai-computer-control'));
      const executable = path.join(runtimeRoot, 'python_embed', process.platform === 'win32' ? 'python.exe' : 'python');
      const stat = await fsp.stat(executable).catch(() => null);
      if (!stat || !stat.isFile()) return { available: false, path: null, reason: 'component_missing' };
      return { available: true, path: executable, reason: null };
    } catch { return { available: false, path: null, reason: 'unavailable' }; }
  }
  // 「渲染 + 遮盖」的接缝:把渲染出来的页面(内存 Buffer)准备成受保护图片引用。
  // 顺序固定:会话 → 策略(必须在 turn 的 PrivacyGateway scope 里) → 收件人(vision provider) → 处理器(真实原生组件)。
  // 任何一步不满足都 fail-closed,绝不把原始像素交回调用方;成功时只回引用,像素留在派生库里由交付层替换。
  async function prepareRenderedPages({ sessionId, pages, signal } = {}) {
    if (!Array.isArray(pages) || !pages.length || pages.length > 4) fail('render_invalid');
    for (const page of pages) {
      if (!page || typeof page.name !== 'string' || !page.name || page.name.length > 200
        || !Buffer.isBuffer(page.bytes) || page.bytes.length < 1 || page.bytes.length > MediaImageContract.LIMITS.sourceBytes) fail('render_invalid');
    }
    const session = assertSessionIdForPath(sessionId), config = await readConfig();
    PrivacyGateway.assertPolicyAvailable(config);
    return PrivacyGateway.run(session, config, () => managed(async () => {
      const policy = PrivacyGateway.captureMediaPolicy(); if (!policy) fail('protection_disabled');
      const recipient = currentRecipient(config);
      const owner = await processor();
      if (!MediaImageProcessor.isOwner(owner)) fail('processor_unavailable');
      const references = [];
      for (const [index, page] of pages.entries()) {
        const source = MediaImageService.renderedSource({ id: 'render-' + index, name: page.name, bytes: page.bytes, sessionId: session });
        policy.assert(); source.assert();
        const prepared = await service.prepare({ sessionId: session, source, policy, processor: owner, recipient, signal });
        references.push(Object.freeze({ name: page.name, id: prepared.id, reference: prepared.reference }));
      }
      // 跨页撤销:prepare 每页各自 beginScope,撤回可能发生在两页之间。收尾时逐条复核引用仍然有效,
      // 否则宁可 fail-closed,也不把悬空引用交给交付层。
      for (const item of references) {
        try {
          if (!service.projectPart({ type: 'image_url', image_url: { url: item.reference } }, { scopeId: session, pointer: '/messages/0/content/0' })) fail('render_revoked');
        } catch { fail('render_revoked'); }
      }
      // 交付改写总开关:准备好受保护引用之后必须置位,否则 04h 会把引用原样发给 provider。
      preparedAny = true;
      return Object.freeze({ references: Object.freeze(references), recipient });
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
  Object.assign(VisualMediaHooks, { buildUserContentParts });
  Object.assign(MediaImageHooks, { attachmentPrompt, prepareRenderedPages, availability, handleApiRoutes, helperMayStillRun,
    revokeScope: sessionId => service.revokeScope(sessionId) });
  return Object.freeze({ prepare });
})();
