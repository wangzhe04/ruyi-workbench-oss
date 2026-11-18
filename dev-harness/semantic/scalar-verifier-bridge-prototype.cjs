'use strict';
// Research-only scalar admission bridge. Trusted consumers own source proof,
// privacy policy, strong lexical evidence, and the final disclosure boundary.
const crypto = require('node:crypto');

function createScalarVerifierBridge(host, options = {}) {
  if (!host || typeof host.prepare !== 'function' || typeof host.verify !== 'function' || typeof host.stop !== 'function') throw TypeError('scalar.host_invalid');
  const cacheLimit = options.cacheLimit === undefined ? 1024 : options.cacheLimit;
  if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 1 || cacheLimit > 8192) throw TypeError('scalar.cache_limit_invalid');
  const now = options.now === undefined ? Date.now : options.now;
  if (typeof now !== 'function') throw TypeError('scalar.clock_invalid');
  let cacheGeneration = 0;
  const cache = new Map(), availability = new Set(['disabled', 'unavailable', 'timeout', 'overloaded']);
  const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const fingerprints = ['modelFingerprint', 'templateFingerprint', 'runtimeFingerprint', 'policyFingerprint'];
  const validFingerprint = value => typeof value === 'string' && value.length > 0 && value.length <= 512;
  const validIdentity = identity => {
    if (!identity || Array.isArray(identity) || typeof identity !== 'object') return false;
    const prototype = Object.getPrototypeOf(identity); if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(identity), keys = Reflect.ownKeys(descriptors);
    if (!keys.length || keys.length > 16 || keys.some(key => typeof key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))) return false;
    if (keys.some(key => { const d = descriptors[key], v = d.value; return !d.enumerable || !Object.hasOwn(d, 'value')
      || !(v === null || typeof v === 'string' && v.length <= 1024 || typeof v === 'boolean' || typeof v === 'number' && Number.isFinite(v)); })) return false;
    return ['sourceId', 'field', 'revision'].every(key => Object.hasOwn(descriptors, key) && typeof descriptors[key].value === 'string' && descriptors[key].value.length > 0 && descriptors[key].value.length <= 1024)
      && Object.hasOwn(descriptors, 'start') && Object.hasOwn(descriptors, 'end') && Number.isSafeInteger(descriptors.start.value) && descriptors.start.value >= 0
      && Number.isSafeInteger(descriptors.end.value) && descriptors.end.value > descriptors.start.value;
  };
  const deepFreeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; };
  const cancellation = signal => { if (signal?.aborted) throw signal.reason === undefined ? Object.assign(Error('scalar.aborted'), { name: 'AbortError' }) : signal.reason; };
  function remember(key, value) { cache.delete(key); cache.set(key, value); while (cache.size > cacheLimit) cache.delete(cache.keys().next().value); }
  async function verify(query, rows, { scopeId, signal, deadline, beforeVerify } = {}) {
    if (typeof query !== 'string' || !query.length || query.length > 4096 || !Array.isArray(rows) || rows.length > 4096
      || typeof scopeId !== 'string' || !scopeId.length || scopeId.length > 1024 || !Number.isFinite(deadline)
      || typeof beforeVerify !== 'function') throw TypeError('scalar.request_invalid');
    if (rows.some(row => !row || !validIdentity(row.identity) || typeof row.text !== 'string' || !row.text.length || row.text.length > 8192
      || row.identity.end - row.identity.start !== row.text.length)) throw TypeError('scalar.source_invalid');
    // Freeze a private snapshot: consumer guards must validate the same value
    // later passed to host.verify even if caller-owned objects mutate at await.
    const sources = rows.map(row => deepFreeze({ identity: JSON.parse(JSON.stringify(row.identity)), text: row.text }));
    // Identities are internal binding proofs, not public UI DTOs.
    const results = sources.map(source => ({ identity: source.identity, accepted: null, score: null })), generation = cacheGeneration;
    const guard = async (phase, index = null) => { cancellation(signal); await beforeVerify({ phase, index, source: index === null ? null : sources[index] }); cancellation(signal); if (generation !== cacheGeneration) throw Error('scalar.cache_invalidated'); };
    const finish = async (status, reason, descriptor = null) => {
      await guard('finish');
      if (!reason && now() >= deadline) reason = 'timeout';
      const completed = results.filter(row => typeof row.accepted === 'boolean').length;
      const complete = completed === sources.length && !reason;
      return { status: complete ? 'complete' : 'partial', results, coverage: { total: sources.length, completed, complete },
        ...(reason ? { reason } : {}), ...(descriptor ? { fingerprints: descriptor } : {}) };
    };
    await guard('start');
    if (now() >= deadline) return finish('partial', 'timeout');
    const ready = await host.prepare({ scopeId, signal, deadline });
    await guard('prepared');
    if (now() >= deadline) return finish('partial', 'timeout');
    if (!ready?.ok) {
      if (!availability.has(ready?.reason)) throw Error('scalar.prepare_failed');
      return finish('partial', ready.reason);
    }
    if (!fingerprints.every(key => validFingerprint(ready[key]))) throw Error('scalar.fingerprint_invalid');
    const descriptor = Object.freeze(Object.fromEntries(fingerprints.map(key => [key, ready[key]])));
    let reason = null;
    for (let index = 0; index < sources.length; index++) {
      await guard('before', index);
      if (now() >= deadline) { reason = 'timeout'; break; }
      const source = sources[index], key = digest([scopeId, query, source.identity, source.text, descriptor]);
      const cached = cache.get(key);
      if (cached) {
        cache.delete(key); cache.set(key, cached);
        await guard('cached', index);
        if (now() >= deadline) { reason = 'timeout'; break; }
        results[index] = { identity: source.identity, ...cached, cached: true };
        continue;
      }
      // The trusted transport must call this hook after its own asynchronous
      // work and immediately before each actual text-bearing native write.
      let transportChecks = 0; const transportTimeout = Object.freeze({});
      const beforeTransportWrite = async () => { await guard('transport', index); if (now() >= deadline) throw transportTimeout; transportChecks++; };
      let response;
      try { response = await host.verify(query, source, { scopeId, signal, deadline, fingerprints: descriptor, beforeVerify: beforeTransportWrite }); }
      catch (error) { if (error !== transportTimeout) throw error; await guard('after', index); reason = 'timeout'; break; }
      // A host failure remains primary if it throws; otherwise authority and
      // cancellation are revalidated before reading or caching a response.
      await guard('after', index);
      if (now() >= deadline) { reason = 'timeout'; break; }
      if (!response?.ok) {
        if (!availability.has(response?.reason)) throw Error('scalar.verify_failed');
        reason = response.reason; break;
      }
      if (!transportChecks) throw Error('scalar.transport_guard_missing');
      if (!fingerprints.every(name => response[name] === descriptor[name])) throw Error('scalar.fingerprint_changed');
      if (typeof response.accepted !== 'boolean' || typeof response.score !== 'number' || !Number.isFinite(response.score) || response.score < 0 || response.score > 1) throw Error('scalar.response_invalid');
      const entry = { accepted: response.accepted, score: response.score };
      remember(key, entry); results[index] = { identity: source.identity, ...entry, cached: false };
    }
    return finish(reason ? 'partial' : 'complete', reason, descriptor);
  }
  return Object.freeze({ verify, stop: (...args) => host.stop(...args), clear: () => { cacheGeneration++; cache.clear(); } });
}
module.exports = { createScalarVerifierBridge };
