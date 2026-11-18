'use strict';
// Explicit existing baseline; no download or default/registry change.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pins = {
  'qwen-evidence-research-adapter.cjs': '7ecd5e33acaaa1a306f84cc32e1605f07bc5ec1eafa2b1b485f707198884374e',
  'qwen-research-adapter.cjs': 'fb2b86d3646374d80a5481bf14b3ff88e16451444d5ed52a76f40383da74f89f',
  'scalar-native-host-research.cjs': 'e3d85c6c8c4b28fc47dc6c49021375d4a8e0e0ce1cd814bd0e6e73a46666753f',
  'scalar-owned-native-research.cjs': '4e09627f1f1563b97fd7703415d5c223bdd672d30625711cb099f11d4225b7d3',
};
function create() {
  const bindings = Object.entries(pins).map(([name, sha256]) => ({ file: path.join(__dirname, name), sha256 }));
  for (const item of bindings) if (hash(item.file) !== item.sha256) throw Error('Baseline native profile source changed: ' + path.basename(item.file));
  const encoder = require('./qwen-evidence-research-adapter.cjs').create(); let scalarOwner = null;
  const factory = options => require('./scalar-owned-native-research.cjs').createVerifier({ ...options,
    onOwned(record) { options.onOwned(record); scalarOwner = record; } });
  const scalarHost = require('./scalar-native-host-research.cjs').createScalarNativeHost({ factory });
  return { id: 'msvc-b11146-qwen-prior-evidence-rank-buffer6-baseline', kind: 'native-research', encoder, scalarHost, bindings,
    descriptor: { coarse: 'Qwen3-Embedding0.6B prior-evidence Q4_K_M, stateless slot erase, physical1, query/doc actual512 token cap, existing CPU2 profile',
      scalar: 'Official Qwen3-Reranker0.6B locally converted Q4_K_M, RANK-buffer MSVC6, exact websearch template, host joint512/native ctx1024',
      admission: 'raw eligible globalK1; no.46 coarse threshold; same-field scalar>=.95; strong lexical bypass without semantic RRF/refill',
      factoryUsage: 'Locked native factory observer only, not cached vectors/scalars. Original host correctly reports injectedFactory:true.' },
    ownedIdentities() { const pid = encoder.stats().pid, scalar = scalarOwner?.getNativeIdentity?.();
      return { coarse: pid ? { pid, creationFileTime: null } : null, scalar: scalar?.nativePid ? { pid: scalar.nativePid, creationFileTime: scalar.creationFileTime } : null }; },
  };
}
module.exports = { create };
