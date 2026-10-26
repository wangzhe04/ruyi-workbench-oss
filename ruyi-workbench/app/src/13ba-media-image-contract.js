'use strict';
// Private source candidate. This module performs no file, process, network, or
// permission I/O. Trusted host owners must be bound by the production composition.
const MediaImageContract = ((cryptoApi, zlibApi) => {
  const LIMITS = Object.freeze({ sourceBytes: 8 * 1024 * 1024, pixels: 8000000,
    outputBytes: 5 * 1024 * 1024, words: 20000, text: 1024 * 1024, regions: 4096, ttlMs: 60000, artifacts: 4 });
  // Capture the trusted intrinsic before any borrowed Buffer reaches a consumer.
  const fillBuffer = Function.prototype.call.bind(Buffer.prototype.fill);
  function cleanupFailure(errors) {
    const unknown = error => {
      if (error === null || !['object', 'function'].includes(typeof error)) return false;
      const seen = new Set(); let value = error;
      try {
        for (let depth = 0; value !== null && depth < 8; depth++) {
          if (seen.has(value)) return true; seen.add(value);
          const descriptor = Object.getOwnPropertyDescriptor(value, 'helperMayStillRun');
          // An accessor is unknown; never call foreign code to observe a flag.
          if (descriptor) return !Object.hasOwn(descriptor, 'value') || descriptor.value === true;
          value = Object.getPrototypeOf(value);
        }
        return value !== null;
      } catch { return true; } // Proxy/descriptor uncertainty must not wash flags.
    };
    return Object.assign(new AggregateError(errors, 'privacy.image_cleanup_failed', { cause: errors[0] }),
      { code: 'privacy.image_cleanup_failed', cleanupFailed: true, ownershipRetained: true,
        helperMayStillRun: errors.some(unknown) });
  }
  const sha = bytes => cryptoApi.createHash('sha256').update(bytes).digest('hex');
  const fail = code => { throw Object.assign(new Error('privacy.image_' + code), { code: 'privacy.image_' + code }); };
  const failure = code => Object.assign(new Error('privacy.image_' + code), { code: 'privacy.image_' + code });
  const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const revision = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
  function sync(call) {
    const result = call();
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {}); fail('synchronous_owner_required');
    }
    if (result !== true) fail('owner_changed');
  }
  function box(value, width, height) {
    if (!Array.isArray(value) || value.length !== 4 || value.some(n => !Number.isFinite(n))) fail('region_invalid');
    const [x, y, right, bottom] = value;
    if (x < 0 || y < 0 || right > width || bottom > height || x >= right || y >= bottom) fail('region_invalid');
    return [Math.floor(x), Math.floor(y), Math.ceil(right), Math.ceil(bottom)];
  }
  function dimension(width, height) {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > LIMITS.pixels || height > LIMITS.pixels || width * height > LIMITS.pixels) fail('pixel_limit');
  }
  function explicitBoxes(selection, source, frame) {
    if (selection === null) return [];
    const t = frame.transform;
    if (!selection || !Array.isArray(selection.boxes) || selection.boxes.length > LIMITS.regions
      || selection.space !== 'source-pixels-v1' || selection.sourceHash !== source.hash
      || selection.sourceRevision !== source.revision || selection.width !== t.width || selection.height !== t.height
      || selection.orientation !== t.orientation) fail('region_binding');
    const project = (x, y) => {
      switch (t.orientation) {
        case 1: return [x, y]; case 2: return [t.width - x, y];
        case 3: return [t.width - x, t.height - y]; case 4: return [x, t.height - y];
        case 5: return [y, x]; case 6: return [t.height - y, x];
        case 7: return [t.height - y, t.width - x]; case 8: return [y, t.width - x];
      }
    };
    return selection.boxes.map(value => {
      const [x1, y1, x2, y2] = box(value, t.width, t.height);
      const points = [project(x1,y1),project(x1,y2),project(x2,y1),project(x2,y2)];
      return box([Math.min(...points.map(v=>v[0])),Math.min(...points.map(v=>v[1])),
        Math.max(...points.map(v=>v[0])),Math.max(...points.map(v=>v[1]))], frame.width, frame.height);
    });
  }
  function crc32(bytes) {
    let n = 0xffffffff;
    for (const byte of bytes) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1)); }
    return (n ^ 0xffffffff) >>> 0;
  }
  function chunk(name, data) {
    const output = Buffer.alloc(data.length + 12);
    output.writeUInt32BE(data.length); output.write(name, 4, 4, 'ascii'); data.copy(output, 8);
    output.writeUInt32BE(crc32(output.subarray(4, data.length + 8)), data.length + 8); return output;
  }
  function encodeRgb(rgb, width, height, check) {
    const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
    const rows = Buffer.alloc(height * (width * 3 + 1)); let compressed;
    try {
      for (let y = 0; y < height; y++) { if (!(y % 64)) check(); rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3); }
      compressed = zlibApi.deflateSync(rows);
      const result = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
      if (result.length > LIMITS.outputBytes) { fillBuffer(result, 0); fail('output_limit'); }
      return result;
    } finally { fillBuffer(rows, 0); if (compressed) fillBuffer(compressed, 0); }
  }
  // mapWords is inserted byte-for-byte from the reviewed M1 prototype by the
  // candidate generator. It uses PrivacyCore's existing UTF-16 detector intervals.
  function mapWords(words, detector, width, height) {
  let text = '', previousLine;
  const spans = words.map(word => {
    if (!word || typeof word.text !== 'string' || !Number.isInteger(word.line) || !Array.isArray(word.box)) throw failure('invalid-ocr');
    if (text) text += word.line === previousLine ? ' ' : '\n';
    const start = text.length; text += word.text; previousLine = word.line;
    return { ...word, start, end: text.length };
  });
  if (!text.trim()) throw failure('unrecognized');
  const hits = detector.detect(text);
  if (!hits.length) throw failure('unrecognized'); // Conservative M1 fixture policy, no original-media fallback.
  const selected = spans.filter(word => hits.some(hit => word.start < hit.end && word.end > hit.start));
  for (const hit of hits) {
    const covered = selected.filter(word => word.start < hit.end && word.end > hit.start);
    if (!covered.length || covered[0].start > hit.start || covered.at(-1).end < hit.end) throw failure('incomplete-coverage');
  }
  const boxes = selected.map(word => {
    if (word.box.length !== 4 || word.box.some(n => !Number.isFinite(n))) throw failure('invalid-ocr');
    const [x1, y1, x2, y2] = word.box;
    if (x1 < 0 || y1 < 0 || x1 >= x2 || y1 >= y2 || x2 > width || y2 > height) throw failure('invalid-ocr');
    return [Math.max(0, Math.floor(x1) - 4), Math.max(0, Math.floor(y1) - 4), Math.min(width, Math.ceil(x2) + 4), Math.min(height, Math.ceil(y2) + 4)];
  });
  return { boxes, hitCount: hits.length, categories: [...new Set(hits.map(h => h.category))],
    matchedWords: selected.length, crossWord: hits.some(hit => spans.filter(w => w.start < hit.end && w.end > hit.start).length >= 3) };
}

  function create({ sourceOwner, policyOwner, processorOwner, now = Date.now } = {}) {
    for (const owner of [sourceOwner, policyOwner, processorOwner]) {
      if (!owner || typeof owner.capture !== 'function' || typeof owner.assert !== 'function') fail('owner_required');
    }
    if (typeof processorOwner.start !== 'function') fail('processor_required');
    const records = new WeakMap(), active = new Set(); let preparing = false, epoch = 0, stopPending = null;
    const own = token => { const record = records.get(token); if (record?.cleanupError) throw record.cleanupError; if (!record || record.retired) fail('unknown_artifact'); return record; };
    const checkTime = (signal, deadline) => {
      if (signal?.aborted) fail('cancelled');
      if (!Number.isFinite(deadline) || now() >= deadline) fail('expired');
    };
    const checkRecord = record => {
      checkTime(record.signal, record.deadline);
      sync(() => sourceOwner.assert(record.source)); sync(() => policyOwner.assert(record.policy)); sync(() => processorOwner.assert(record.processor));
      if (record.source.hash !== record.manifest.sourceHash || record.source.revision !== record.manifest.sourceRevision || record.source.scope !== record.manifest.scope
        || record.policy.hash !== record.manifest.policyHash || record.policy.revision !== record.manifest.policyRevision || record.policy.rulesHash !== record.manifest.rulesHash
        || record.processor.hash !== record.manifest.processorHash || record.processor.version !== record.manifest.processorVersion) fail('binding_changed');
      if (sha(record.bytes) !== record.manifest.payloadHash) fail('artifact_changed');
    };
    const retire = record => {
      if (record.retired) return;
      record.retired = true;
      const errors = [], attempt = work => { try { work(); } catch (error) { errors.push(error); } };
      try {
        attempt(() => fillBuffer(record.bytes, 0)); attempt(() => clearTimeout(record.timer));
        attempt(() => record.signal?.removeEventListener('abort', record.abort));
        for (const borrowed of [...record.borrows]) attempt(() => borrowed.release());
      } finally { record.borrows.clear(); active.delete(record); }
      if (errors.length) { record.cleanupError = cleanupFailure(errors); throw record.cleanupError; }
    };
    const refuse = (record, primary) => { try { retire(record); } catch (error) { throw cleanupFailure([primary, error]); } throw primary; };
    async function prepare({ signal, deadline = now() + LIMITS.ttlMs, regions = null } = {}) {
      if (preparing || active.size >= LIMITS.artifacts) fail('busy'); preparing = true;
      const initialEpoch = epoch;
      let source, policy, processor, stamp, sourceBytes, rgba, rgb, output, job, issued, returned = false, failed = false, primary;
      const check = () => {
        if (epoch !== initialEpoch) fail('invalidated');
        checkTime(signal, deadline);
        if (source) sync(() => sourceOwner.assert(source));
        if (policy) sync(() => policyOwner.assert(policy));
        if (processor) sync(() => processorOwner.assert(processor));
        if (stamp && stamp !== JSON.stringify([source.hash,source.revision,source.scope,policy.hash,policy.revision,policy.rulesHash,processor.hash,processor.version])) fail('binding_changed');
      };
      try {
        if (deadline > now() + LIMITS.ttlMs) fail('deadline_limit'); check();
        if (regions !== null && (!regions || typeof regions !== 'object' || Array.isArray(regions)
          || Object.keys(regions).sort().join(',') !== 'boxes,height,orientation,sourceHash,sourceRevision,space,width'
          || !Array.isArray(regions.boxes) || regions.boxes.length > LIMITS.regions
          || regions.boxes.some(value => !Array.isArray(value) || value.length !== 4 || value.some(n => !Number.isFinite(n)))
          || !hex(regions.sourceHash) || !revision(regions.sourceRevision) || regions.space !== 'source-pixels-v1')) fail('region_binding');
        const explicit = regions === null ? null : JSON.parse(JSON.stringify(regions));
        // No raw path, arbitrary metadata, detector, or processor callback is
        // accepted from an upload request. Owners capture their own authority.
        source = sourceOwner.capture(); policy = policyOwner.capture(); processor = processorOwner.capture(); check();
        if (!source || !Buffer.isBuffer(source.bytes) || source.bytes.length < 1 || source.bytes.length > LIMITS.sourceBytes
          || !hex(source.hash) || sha(source.bytes) !== source.hash || !revision(source.revision) || !revision(source.scope)) fail('source_invalid');
        if (!policy || !hex(policy.hash) || !hex(policy.rulesHash) || !revision(policy.revision) || !policy.config
          || sha(JSON.stringify(policy.config)) !== policy.hash) fail('policy_invalid');
        if (!processor || !hex(processor.hash) || !revision(processor.version)) fail('processor_invalid');
        stamp = JSON.stringify([source.hash,source.revision,source.scope,policy.hash,policy.revision,policy.rulesHash,processor.hash,processor.version]);
        const detector = PrivacyCore.createDetector(policy.config);
        sourceBytes = Buffer.from(source.bytes);
        job = processorOwner.start({ source: sourceBytes, sourceHash: source.hash, signal, deadline, processor });
        if (!job || !job.promise || typeof job.finish !== 'function') fail('processor_job_required');
        let timer, abort;
        const interruption = new Promise((_, reject) => {
          stopPending = () => reject(failure('invalidated'));
          abort = () => { try { fail('cancelled'); } catch (error) { reject(error); } };
          signal?.addEventListener('abort', abort, { once: true });
          if (signal?.aborted) abort();
          timer = setTimeout(() => { try { fail('expired'); } catch (error) { reject(error); } }, Math.max(1, deadline - now()));
        });
        let frame, abandoned = false;
        const completion = Promise.resolve(job.promise).then(value => { if (abandoned && Buffer.isBuffer(value?.rgba)) fillBuffer(value.rgba, 0); return value; });
        try { frame = await Promise.race([completion, interruption]); rgba = Buffer.isBuffer(frame?.rgba) ? frame.rgba : undefined; }
        catch (error) { abandoned = true; throw error; }
        finally { stopPending = null; clearTimeout(timer); signal?.removeEventListener('abort', abort); }
        check();
        if (sha(sourceBytes) !== source.hash) fail('source_changed');
        if (!frame || !Buffer.isBuffer(frame.rgba)) fail('frame_invalid');
        rgba = frame.rgba;
        dimension(frame.width, frame.height);
        const { width, height } = frame;
        if (rgba.length !== width * height * 4 || frame.sourceHash !== source.hash || frame.processorHash !== processor.hash
          || frame.frames !== 1 || frame.orientationApplied !== true || frame.ocrComplete !== true || frame.codesComplete !== true) fail('coverage_incomplete');
        const transform = frame.transform;
        if (!transform || !Number.isInteger(transform.orientation) || transform.orientation < 1 || transform.orientation > 8) fail('transform_invalid');
        dimension(transform.width, transform.height);
        if (width !== (transform.orientation > 4 ? transform.height : transform.width)
          || height !== (transform.orientation > 4 ? transform.width : transform.height)) fail('transform_invalid');
        if (!Array.isArray(frame.words) || frame.words.length > LIMITS.words || !Array.isArray(frame.codes) || frame.codes.length > LIMITS.regions) fail('recognition_limit');
        if (frame.words.reduce((n, word) => n + (typeof word?.text === 'string' ? word.text.length : LIMITS.text + 1), 0)
          + frame.codes.reduce((n, code) => n + (typeof code?.text === 'string' ? code.text.length : LIMITS.text + 1), 0) > LIMITS.text) fail('recognition_limit');
        for (const word of frame.words) box(word.box, width, height);
        // Empty OCR or no detected sensitive interval is not an automatic safe
        // verdict. The original conservative M1 refusal remains for this slice.
        const mapped = mapWords(frame.words, detector, width, height);
        const boxes = mapped.boxes.map(value => box(value, width, height));
        boxes.push(...explicitBoxes(explicit, source, frame));
        for (const code of frame.codes) {
          check();
          if (!code || typeof code.text !== 'string' || code.text.length > LIMITS.text || !['qr', 'barcode'].includes(code.kind)) fail('code_invalid');
          const rectangle = box(code.box, width, height);
          if (detector.detect(code.text).length) boxes.push(rectangle);
        }
        if (boxes.length > LIMITS.regions) fail('region_limit');
        rgb = Buffer.alloc(width * height * 3);
        // Discard hidden RGB under alpha by compositing onto an opaque white
        // surface. Never copy ancillary metadata, EXIF, source chunks or name.
        for (let y = 0; y < height; y++) {
          if (!(y % 64)) check();
          for (let x = 0; x < width; x++) { const a = (y * width + x) * 4, b = (y * width + x) * 3, alpha = rgba[a + 3];
            for (let channel = 0; channel < 3; channel++) rgb[b + channel] = Math.round((rgba[a + channel] * alpha + 255 * (255 - alpha)) / 255);
          }
        }
        for (const [left, top, right, bottom] of boxes) {
          for (let y = top; y < bottom; y++) { if (!(y % 64)) check(); fillBuffer(rgb, 0, (y * width + left) * 3, (y * width + right) * 3); }
        }
        output = encodeRgb(rgb, width, height, check); check();
        const token = Object.freeze(Object.create(null));
        const manifest = Object.freeze({ schema: 1, type: 'protected-image', mime: 'image/png', name: 'protected.png',
          scope: source.scope, sourceHash: source.hash, sourceRevision: source.revision,
          policyHash: policy.hash, policyRevision: policy.revision, rulesHash: policy.rulesHash,
          processorHash: processor.hash, processorVersion: processor.version, regionsHash: sha(JSON.stringify(explicit)),
          transformHash: sha(JSON.stringify({width:transform.width,height:transform.height,orientation:transform.orientation})),
          payloadHash: sha(output), bytes: output.length, width, height, expiresAt: deadline,
          coverage: 'single-canonical-frame-ocr+local-codes+explicit-regions', authorization: 'none' });
        issued = { bytes: output, manifest, source, policy, processor, signal, deadline, retired: false, deliveryBorrowed: false, borrows: new Set() };
        records.set(token, issued); active.add(issued);
        issued.abort = () => { try { retire(issued); } catch (error) { issued.cleanupError = error; } }; signal?.addEventListener('abort', issued.abort, { once: true });
        issued.timer = setTimeout(issued.abort, Math.max(1, deadline - now())); issued.timer.unref?.();
        // The ticket is published only after the worker's closure proof below.
        returned = true; return token;
      } catch (error) { failed = true; primary = error; }
      finally {
        let cleanupFailed = false, cleanup;
        if (job) {
          try {
            const proof = job.finish({ failed });
            if (proof && typeof proof.then === 'function') { Promise.resolve(proof).catch(() => {}); fail('processor_close_unknown'); }
            if (!proof || proof.closed !== true || proof.helperMayStillRun !== false || proof.ownershipRetained !== false) fail('processor_close_unknown');
            // Closure itself may run host code; authority must still be current
            // before a prepared ticket can escape this function.
            if (!failed) check();
          } catch (error) { cleanupFailed = true; cleanup = error; }
        }
        const cleanupErrors = [];
        const clean = work => { try { work(); } catch (error) { cleanupErrors.push(error); } };
        for (const bytes of [rgba, rgb, sourceBytes]) if (bytes) clean(() => fillBuffer(bytes, 0));
        preparing = false;
        if (!returned || cleanupFailed || cleanupErrors.length) {
          if (output) clean(() => fillBuffer(output, 0)); if (issued) clean(() => retire(issued));
        }
        if (cleanupErrors.length) {
          const error = cleanupFailure([...(failed ? [primary] : []), ...(cleanupFailed ? [cleanup] : []), ...cleanupErrors]);
          // A second memory-cleanup failure must not erase unknown worker closure.
          if (cleanupFailed) error.helperMayStillRun = true;
          throw error;
        }
        if (cleanupFailed) {
          const errors = failed ? [primary, cleanup] : [cleanup];
          throw Object.assign(new AggregateError(errors, 'privacy.image_processor_close_unknown', { cause: errors[0] }),
            { code: 'privacy.image_processor_close_unknown', cleanupFailed: true, helperMayStillRun: true, ownershipRetained: true });
        }
      }
      if (failed) throw primary;
    }
    function describe(token) { const record = own(token); try { checkRecord(record); return record.manifest; } catch (error) { refuse(record, error); } }
    function borrow(token, { purpose = 'preview' } = {}) {
      const record = own(token);
      if (!['preview', 'delivery'].includes(purpose)) fail('borrow_purpose');
      try { checkRecord(record); } catch (error) { refuse(record, error); }
      if (purpose === 'delivery') { if (record.deliveryBorrowed) fail('delivery_already_borrowed'); record.deliveryBorrowed = true; }
      const bytes = Buffer.from(record.bytes); let released = false;
      const assert = () => {
        if (released) fail('borrow_released');
        try { checkRecord(record); if (sha(bytes) !== record.manifest.payloadHash) fail('borrow_changed'); }
        catch (error) { refuse(record, error); }
        return true;
      };
      const borrowed = Object.freeze({ bytes, manifest: record.manifest, assert, release() { if (!released) { released = true; try { fillBuffer(bytes, 0); } catch (error) { throw cleanupFailure([error]); } finally { record.borrows.delete(borrowed); } } } });
      record.borrows.add(borrowed); return borrowed;
    }
    function release(token) { const record = own(token); retire(record); }
    return Object.freeze({ prepare, describe, borrow, release, invalidate() { epoch++; stopPending?.(); const errors = []; for (const record of [...active]) { try { retire(record); } catch (error) { errors.push(error); } } if (errors.length) throw cleanupFailure(errors); } });
  }
  return Object.freeze({ create, LIMITS });
})(require('node:crypto'), require('node:zlib'));
