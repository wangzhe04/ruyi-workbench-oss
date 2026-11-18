'use strict';
// Explicit research profile only. Does not read datasets, cache model outputs,
// register a production model, or establish a release qualification.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sourceFiles = [
  'scalar-live-gcc-profile.cjs', 'gcc-coarse-native-research.cjs', 'gcc-scalar-native-host-research.cjs',
  'gcc-rank-native-research.cjs', 'gcc-native-profile-lock.json', 'native-host-prototype.cjs',
  'scalar-native-host-research.cjs', 'scalar-owned-native-research.cjs', 'qwen-reranker-native.cjs',
  'scalar-composite-policy-research.cjs', 'native-job-launcher.cjs', 'native-job-host.cs',
];
function create() {
  const coarse = require('./gcc-coarse-native-research.cjs');
  const rank = require('./gcc-rank-native-research.cjs');
  const { createScalarNativeHost } = require('./gcc-scalar-native-host-research.cjs');
  const encoder = coarse.create(); let scalarOwner = null;
  const scalarHost = createScalarNativeHost({ factory: options => rank.createVerifier({ ...options,
    onOwned(record) { scalarOwner = record; options.onOwned(record); } }) });
  const bindings = sourceFiles.map(name => { const file = path.join(__dirname, name); return { file, sha256: hashFile(file) }; });
  bindings.push({ file: coarse.exe, sha256: coarse.pins.exe }, { file: coarse.model, sha256: coarse.pins.model },
    { file: path.resolve('output/semantic-native-mingw-research/static-receipt.json'),
      sha256: 'ac97b212e1b9e8280b809bfbaf095233c3984cfb3c0420ff93f9fd5803bad587' },
    { file: path.resolve('output/semantic-qwen-reranker-official-v1/artifacts/qwen3-reranker-0.6b-rank-q4_k_m.gguf'),
      sha256: '9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7' },
    { file: path.resolve('output/semantic-qwen-reranker-official-v1/artifact-inventory.json'),
      sha256: '3f442df23bb4e4eb5e14da9f59a3ee5d9770dfc6fd266deb44e2d22060abe204' },
    { file: path.resolve('output/semantic-native-job-host/native-job-host.exe'),
      sha256: 'c0c4a019131cce574be6f674e9ca3ad4597fe72f39ddb4194de5cfc2577edc7d' });
  return { id: 'gcc-b11146-qwen-prior-evidence-rank-buffer6-research', kind: 'native-research', encoder, scalarHost, bindings,
    descriptor: { coarse: 'Qwen3 embedding Q4, prior-evidence query prefix, LAST L2, physical1, 512 token cap, CPU2',
      scalar: 'Qwen3 official RANK Q4, two-class softmax, physical1, joint 512 token cap, CPU6',
      admission: 'Research scalar bridge policy; no automatic-memory policy.',
      restrictions: 'Windows x64 AVX2 pooled-only research; GCC is not established equivalent to the MSVC profile.' },
    ownedIdentities() { const scalar = scalarOwner?.getNativeIdentity?.();
      return { coarse: encoder.identity(), scalar: scalar?.nativePid
        ? { pid: scalar.nativePid, creationFileTime: scalar.creationFileTime ?? null } : null }; },
  };
}
module.exports = { create };
