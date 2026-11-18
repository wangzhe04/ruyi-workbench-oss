'use strict';
// New window-policy identity around the SAME e3 owner registry and transport.
// Preserve its stop/guard semantics, and never reuse its old policy cache key.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const baseFile = path.join(__dirname, 'gcc-scalar-native-host-research.cjs');
const policyFile = path.join(__dirname, 'scalar-window-policy-research.cjs');
const baseSha = '16d3953e0a0d4bc0f3d253c4359b5c699c1209422e64a3e3eefb19556a2dda14';
const policySha = '1d7eccdd39bdd3005d701164361504a5d18c5e0d70aef84dcba04857f8fd3ff6';
if (sha(fs.readFileSync(baseFile)) !== baseSha || sha(fs.readFileSync(policyFile)) !== policySha)
  throw Error('gcc.window_host_source_changed');
const { createScalarNativeHost: createBase } = require(baseFile);
const { CONTRACT } = require(policyFile), prior = require('./scalar-composite-policy-research.cjs').CONTRACT;
if (CONTRACT.threshold !== prior.threshold || CONTRACT.threshold !== .95 || CONTRACT.topK !== prior.topK || CONTRACT.topK !== 1)
  throw Error('gcc.window_policy_contract_changed');
const fields = ['modelFingerprint','templateFingerprint','runtimeFingerprint','policyFingerprint'];
function createScalarNativeHost(options) {
  const base = createBase(options); let priorDescriptor = null, descriptor = null;
  async function prepare(args) {
    const result = await base.prepare(args);
    if (!result?.ok) return result;
    priorDescriptor = Object.freeze(Object.fromEntries(fields.map(key => [key,result[key]])));
    descriptor = Object.freeze({ ...priorDescriptor, policyFingerprint: 'sha256:' + sha(JSON.stringify([
      'gcc-window-v2', priorDescriptor.policyFingerprint, policySha, CONTRACT.id,
    ])) });
    return { ...result, ...descriptor };
  }
  async function verify(query, source, options = {}) {
    if (options.signal?.aborted) throw options.signal.reason === undefined ? Object.assign(Error('scalar.aborted'), {name:'AbortError'}) : options.signal.reason;
    if (!descriptor) return {ok:false,reason:'unavailable',state:'not-prepared',researchOnly:true};
    if (!options.fingerprints || fields.some(key => options.fingerprints[key] !== descriptor[key]))
      throw Error('scalar.fingerprint_changed');
    const result = await base.verify(query, source, { ...options, fingerprints: priorDescriptor });
    return result?.ok ? { ...result, ...descriptor } : result;
  }
  return Object.freeze({ ...base, prepare, verify });
}
module.exports = { createScalarNativeHost };
