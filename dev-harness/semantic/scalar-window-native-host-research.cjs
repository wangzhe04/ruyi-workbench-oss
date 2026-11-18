'use strict';
// New policy/cache identity over the SAME frozen e3 owner registry. Never
// compile a second registry that could bypass an old unknown-owner fence.
const fs = require('node:fs'), crypto = require('node:crypto');
const basePath = require.resolve('./scalar-native-host-research.cjs'), policyPath = require.resolve('./scalar-window-policy-research.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const policySha = '1d7eccdd39bdd3005d701164361504a5d18c5e0d70aef84dcba04857f8fd3ff6';
if (hash(fs.readFileSync(basePath)) !== 'e3d85c6c8c4b28fc47dc6c49021375d4a8e0e0ce1cd814bd0e6e73a46666753f' || hash(fs.readFileSync(policyPath)) !== policySha) throw Error('Window host source pin changed.');
const { createScalarNativeHost: createBase } = require(basePath), { CONTRACT } = require(policyPath), prior = require('./scalar-composite-policy-research.cjs').CONTRACT;
if (CONTRACT.threshold !== .95 || CONTRACT.topK !== 1 || CONTRACT.threshold !== prior.threshold || CONTRACT.topK !== prior.topK) throw Error('Window threshold/K changed.');
const fields = ['modelFingerprint', 'templateFingerprint', 'runtimeFingerprint', 'policyFingerprint'];
function createScalarNativeHost(options) {
  const base = createBase(options); let internal = null, exposed = null;
  return Object.freeze({ ...base, async prepare(opts) {
    const result = await base.prepare(opts); if (!result?.ok) return result;
    internal = Object.freeze(Object.fromEntries(fields.map(key => [key, result[key]])));
    exposed = Object.freeze({ ...internal, policyFingerprint: 'sha256:' + hash(JSON.stringify(['msvc-window-v2', internal.policyFingerprint, policySha, CONTRACT.id])) });
    return { ...result, ...exposed };
  }, async verify(query, source, opts = {}) {
    if (opts.signal?.aborted) throw opts.signal.reason === undefined ? Object.assign(Error('scalar.aborted'), { name: 'AbortError' }) : opts.signal.reason;
    if (!exposed) return { ok: false, reason: 'unavailable', state: 'not-prepared' };
    if (!opts.fingerprints || fields.some(field => opts.fingerprints[field] !== exposed[field])) throw Error('scalar.fingerprint_changed');
    const result = await base.verify(query, source, { ...opts, fingerprints: internal });
    return result?.ok ? { ...result, ...exposed } : result;
  } });
}
module.exports = { createScalarNativeHost };
