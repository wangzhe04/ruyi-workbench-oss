'use strict';
// Research-only host for the independently reviewed scalar bridge. No fixture,
// vector prefill, downloads, default registration or production code dependency.
const fs = require('node:fs'), crypto = require('node:crypto'), path = require('node:path');
const nativePath = require.resolve('./scalar-owned-native-research.cjs');
const { createVerifier } = require(nativePath);
const { CONTRACT } = require('./scalar-composite-policy-research.cjs');
const NATIVE_SHA = '4e09627f1f1563b97fd7703415d5c223bdd672d30625711cb099f11d4225b7d3';
const RUNTIME_SHA = 'c703f828ce9ad6e423593c9baa44f5901dbce9a9776a8a3850f640e3f2799ee6';
const MODEL_SHA = '9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const aborted = signal => { if (signal?.aborted) throw signal.reason === undefined ? Object.assign(Error('scalar.aborted'), { name: 'AbortError' }) : signal.reason; };
// Same fixed asset root, not all clean native profiles on the machine. Strong
// references survive constructor failure and block a new host bypass.
const ownershipRegistry = new Map();
const assetRoot = path.resolve('output/semantic-qwen-reranker-official-v1').toLowerCase();
function createScalarNativeHost(options = {}) {
  if (hash(fs.readFileSync(nativePath)) !== NATIVE_SHA) throw Error('scalar.native_source_changed');
  const factory = options.factory === undefined ? createVerifier : options.factory;
  if (typeof factory !== 'function') throw TypeError('scalar.factory_invalid');
  const implementationSha256 = hash(fs.readFileSync(__filename));
  let native = null, ownedRecord = null, slot = null, starting = null, startupError = null, stopping = null, generation = 0, active = false, cleanup = null, recentMs = 240, lastNativeStats = null;
  const stats = { preparations: 0, starts: 0, ownerHandoffs: 0, verified: 0, predictedTimeouts: 0, deadlineStops: 0, guardCalls: 0, injectedFactory: options.factory !== undefined };
  const estimateVerificationBudget = count => {
    if (!Number.isSafeInteger(count) || count < 0 || count > 4096) throw TypeError('scalar.invalid_count');
    return Math.min(60000, Math.ceil(Math.max(180, recentMs * 1.25) * count + 64));
  };
  function fingerprints() {
    if (!native) return null;
    return { modelFingerprint: 'sha256:' + MODEL_SHA, templateFingerprint: 'sha256:' + native.contract.templateSha256,
      runtimeFingerprint: 'sha256:' + RUNTIME_SHA,
      policyFingerprint: 'sha256:' + hash(JSON.stringify([CONTRACT, NATIVE_SHA, RUNTIME_SHA, implementationSha256])) };
  }
  function unavailable(reason, state = reason) { return { ok: false, reason, state, researchOnly: true }; }
  const observed = value => value?.cleanupStatus === 'observed' && value.workerExited === true;
  function rememberOutcome(value) {
    cleanup = { ...value, workerExited: value?.cleanupStatus === 'observed' && value.workerExited !== false };
    if (observed(cleanup)) { native = null; if (ownershipRegistry.get(assetRoot) === slot) ownershipRegistry.delete(assetRoot); }
    else if (slot) slot.state = 'unknown';
    return cleanup;
  }
  function onOwned(record) {
    // Store before touching any optional getter or awaiting any proof.
    ownedRecord = record; slot.owner = record; slot.state = 'owned'; stats.ownerHandoffs++;
    if (!record || typeof record.terminate !== 'function' || !record.exited || typeof record.exited.then !== 'function') throw TypeError('scalar.owner_invalid');
    record.exited.then(value => rememberOutcome(value), error => { cleanup = { cleanupStatus: 'unknown', workerExited: false, error: String(error) }; slot.state = 'unknown'; });
  }
  async function closeOwned() {
    if (native) { try { lastNativeStats = native.stats(); } catch (error) { lastNativeStats = { diagnosticError: String(error) }; } }
    if (ownedRecord) {
      let cleanupError;
      try { await ownedRecord.terminate('scalar-host-stop'); } catch (error) { cleanupError = error; }
      try { rememberOutcome(await ownedRecord.exited); }
      catch (error) { cleanup = { cleanupStatus: 'unknown', workerExited: false, error: String(error) }; if (slot) slot.state = 'unknown'; }
      if (cleanupError) { cleanup = { ...(cleanup || { cleanupStatus: 'unknown', workerExited: false }), cleanupError: String(cleanupError) }; throw cleanupError; }
      return cleanup;
    }
    // An opaque failure before ownership return cannot prove no spawn. Keep its
    // claimed slot instead of allowing a second constructor to bypass unknown.
    if (slot) { slot.state = 'unknown'; cleanup = { cleanupStatus: 'unknown', workerExited: false, startupFailedBeforeOwnershipReturn: true }; }
    return cleanup;
  }
  async function prepare({ signal, deadline = Date.now() + 20000 } = {}) {
    aborted(signal);
    if (!Number.isFinite(deadline) || Date.now() >= deadline) return unavailable('timeout');
    if (startupError) throw startupError.value;
    if (ownershipRegistry.has(assetRoot) && ownershipRegistry.get(assetRoot) !== slot) return unavailable('unavailable', 'other-owner-pending-or-unknown');
    if (cleanup && (cleanup.cleanupStatus !== 'observed' || cleanup.workerExited !== true)) return unavailable('unavailable', 'unconfirmed-cleanup');
    if (active) return unavailable('overloaded', 'verifying');
    if (stopping) return unavailable('overloaded', 'stopping');
    if (native) return { ok: true, ...fingerprints(), researchOnly: true };
    if (starting) return unavailable('unavailable', 'loading');
    const epoch = generation; stats.preparations++;
    slot = { owner: null, state: 'preparing' }; ownershipRegistry.set(assetRoot, slot);
    // This independent cold owner receives no user text. The pinned native
    // controller owns its20s startup. stop awaits actual startup/exit and does
    // not pretend that this opaque integrity/startup operation is preemptible.
    starting = (async () => {
      let created;
      try {
        created = await factory({ profile: 'rank-buffer-t6', onOwned }); stats.starts++;
        if (created.runtimeLockSha256 !== RUNTIME_SHA || created.adapterSourceSha256 !== NATIVE_SHA || created.contract?.modelSha256 !== MODEL_SHA
          || created.contract?.hostMaxJointTokens !== 512 || created.contract?.physicalBatch !== 1) throw Error('scalar.native_contract_changed');
        if (!ownedRecord) throw Error('scalar.owner_handoff_missing');
        if (ownershipRegistry.get(assetRoot) !== slot || slot.state !== 'owned' || cleanup && !observed(cleanup)) throw Error('scalar.native_exited_during_startup');
        if (epoch !== generation) { await closeOwned(); return; }
        native = created; cleanup = null;
      } catch (error) {
        // The opaque create API cannot prove no process existed on a failed
        // startup. Retain unknown and refuse re-launch rather than fake clean.
        try { await closeOwned(); } catch { /* Keep primary constructor/authority error and retained cleanup proof. */ }
        startupError = { value: error }; throw error;
      } finally { starting = null; }
    })();
    // Foreground1s work gets loading and can retry. Explicit cold preparation
    // with enough budget may await it; no extra inference budget is created.
    if (deadline - Date.now() <= 1000) { starting.catch(() => {}); return unavailable('unavailable', 'loading'); }
    await starting; aborted(signal);
    if (Date.now() >= deadline) return unavailable('timeout');
    return native && slot?.state === 'owned' && !(cleanup && !observed(cleanup)) ? { ok: true, ...fingerprints(), researchOnly: true } : unavailable('unavailable');
  }
  async function stop() {
    if (stopping) return stopping;
    generation++;
    stopping = (async () => {
      if (starting) await starting.catch(() => {});
      if (ownedRecord || slot) await closeOwned();
      if (!cleanup && stats.starts === 0) cleanup = { cleanupStatus: 'observed', workerExited: true, neverStarted: true };
      return cleanup || { cleanupStatus: 'unknown', workerExited: false };
    })();
    try { return await stopping; } finally { stopping = null; }
  }
  async function verify(query, source, { signal, deadline, fingerprints: expected, beforeVerify } = {}) {
    aborted(signal);
    if (typeof query !== 'string' || !query.length || typeof source?.text !== 'string' || !source.text.length
      || !Number.isFinite(deadline) || typeof beforeVerify !== 'function') throw TypeError('scalar.request_invalid');
    if (active) return unavailable('overloaded');
    if (!native || stopping || starting || cleanup && (cleanup.cleanupStatus !== 'observed' || cleanup.workerExited !== true)) return unavailable('unavailable', starting ? 'loading' : 'unavailable');
    const fp = fingerprints();
    if (!expected || Object.keys(fp).some(key => expected[key] !== fp[key])) throw Error('scalar.fingerprint_changed');
    active = true;
    const targetNative = native, targetSlot = slot, targetOwner = ownedRecord, targetGeneration = generation;
    const deadlineError = Object.assign(Error('scalar.deadline'), { code: 'scalar.deadline' });
    const cancelTransport = Object.assign(Error('scalar.cancelled_transport'), { code: 'scalar.cancelled_transport' });
    const ownershipUnavailable = Object.freeze({ ownedCleanupUnconfirmed: true });
    const controller = new AbortController(), remaining = deadline - Date.now();
    const cancel = () => controller.abort(cancelTransport);
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(deadlineError), Math.max(1, remaining));
    let guardPrimary = null;
    const guard = async () => {
      aborted(signal);
      try { stats.guardCalls++; await beforeVerify(); } catch (error) { guardPrimary = { value: error }; throw error; }
      aborted(signal);
      if (native !== targetNative || slot !== targetSlot || ownedRecord !== targetOwner || generation !== targetGeneration
        || ownershipRegistry.get(assetRoot) !== targetSlot || targetSlot?.state !== 'owned' || cleanup && !observed(cleanup)) throw ownershipUnavailable;
      if (Date.now() >= deadline) throw deadlineError;
    };
    try {
      await guard();
      if (deadline - Date.now() < estimateVerificationBudget(1)) { stats.predictedTimeouts++; return unavailable('timeout'); }
      const began = Date.now(), result = await targetNative.score(query, source.text, { signal: controller.signal, beforeRerank: guard });
      await guard();
      if (!result?.ok) return { ...unavailable('unavailable'), diagnostic: result?.reason || 'native-refusal', ...(Number.isSafeInteger(result?.tokens) ? { jointTokens: result.tokens } : {}) };
      if (typeof result.probability !== 'number' || !Number.isFinite(result.probability) || result.probability < 0 || result.probability > 1
        || !Number.isSafeInteger(result.tokens) || result.tokens < 1 || result.tokens > 512) throw Error('scalar.native_response_invalid');
      recentMs = Math.max(12, Date.now() - began, recentMs * .9); stats.verified++;
      return { ok: true, ...fp, score: result.probability, accepted: result.probability >= CONTRACT.threshold, jointTokens: result.tokens };
    } catch (error) {
      const primary = guardPrimary ? guardPrimary.value : error;
      try { await stop(); } catch { /* Preserve original authority/native error; cleanup remains independently observable. */ }
      if (guardPrimary) throw primary;
      if (error === ownershipUnavailable) return unavailable('unavailable', 'unconfirmed-cleanup');
      if (error === cancelTransport) { aborted(signal); throw error; }
      if (error === deadlineError) { stats.deadlineStops++; return unavailable('timeout'); }
      throw primary;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); active = false; }
  }
  return Object.freeze({ prepare, verify, stop, estimateVerificationBudget, stats: () => ({ ...stats, recentMs, starting: !!starting, available: !!native, cleanup,
    assetRoot, registryState: ownershipRegistry.get(assetRoot)?.state || 'clean', unconfirmedOwners: ownershipRegistry.has(assetRoot) ? 1 : 0,
    nativeStats: native ? native.stats() : lastNativeStats,
    implementationSha256, nativeSourceSha256: NATIVE_SHA, runtimeLockSha256: RUNTIME_SHA, modelSha256: MODEL_SHA }) });
}
module.exports = { createScalarNativeHost };
