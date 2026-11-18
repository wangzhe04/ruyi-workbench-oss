'use strict';
// Exact source-pinned RANK transport variant: only ownership handoff and
// runtime profile selection differ from the audited a2/4e implementation.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const basePath = path.join(__dirname, 'qwen-reranker-native.cjs'), ownedPath = path.join(__dirname, 'scalar-owned-native-research.cjs');
let source = fs.readFileSync(basePath, 'utf8');
if (sha(source) !== 'a2c8254b539bbff26a625365f399d15a483246453ba2fe9f556160da2c36d706'
  || sha(fs.readFileSync(ownedPath)) !== '4e09627f1f1563b97fd7703415d5c223bdd672d30625711cb099f11d4225b7d3')
  throw Error('gcc.rank_base_changed');
function one(a, b) { if (source.split(a).length !== 2) throw Error('gcc.rank_transform_changed'); source = source.replace(a, b); }
one("  'rank-buffer-t6': { directory: 'runtime/rank-buffer-t6', lock: 'runtime/rank-buffer-t6.lock.json', sha256: 'c703f828ce9ad6e423593c9baa44f5901dbce9a9776a8a3850f640e3f2799ee6', threads: 6 },",
  "  'rank-buffer-t6': { directory: 'runtime/rank-buffer-t6', lock: 'runtime/rank-buffer-t6.lock.json', sha256: '5bd146943d81c623e64d497c35231a5d2dea798fa9b5454f26e06a8d8724d28c', threads: 6 },");
one("const runtimeLockPath = path.join(root, profile.lock), runtimeLock = read(runtimeLockPath), runtime = path.join(root, profile.directory);",
  "const runtimeLockPath = path.join(__dirname, 'gcc-native-profile-lock.json'), runtime = 'C:/r31-gcc-rank-research/build/bin', runtimeLock = { files: [{ path: 'llama-server.exe', bytes: 22605545, sha256: '6e03bcaf87e96763730f41352732c72a9fe19a12baa2e588bafba85cda05bb3f' }] };");
one('onOwned: value => { owner = value; stats.starts++; }',
  "onOwned: value => { owner = value; stats.starts++; if(options.onOwned){const handed=options.onOwned(value);if(handed!==null&&(typeof handed==='object'||typeof handed==='function')&&typeof handed.then==='function')throw Error('scalar.onOwned_must_be_sync');} }");
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(source, __filename);
module.exports = compiled.exports;
