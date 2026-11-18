'use strict';
// Deterministic ownership-only variant of the frozen850-pair native adapter.
// No model/format/prefix/runtime/token/score change; the synchronous handoff is
// before the reviewed launcher's first startup stdin request.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'qwen-reranker-native.cjs'), base = fs.readFileSync(basePath, 'utf8');
const baseSha256 = 'a2c8254b539bbff26a625365f399d15a483246453ba2fe9f556160da2c36d706';
if (crypto.createHash('sha256').update(base).digest('hex') !== baseSha256) throw Error('scalar.owned_native_base_changed');
const before = 'onOwned: value => { owner = value; stats.starts++; }';
const after = "onOwned: value => { owner = value; stats.starts++; if(options.onOwned){const handed=options.onOwned(value);if(handed!==null&&(typeof handed==='object'||typeof handed==='function')&&typeof handed.then==='function')throw Error('scalar.onOwned_must_be_sync');} }";
if (base.split(before).length !== 2) throw Error('scalar.owned_native_boundary_changed');
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(base.replace(before, after), __filename);
module.exports = { ...compiled.exports, transformation: Object.freeze({ baseSha256, before, after, scope: 'onOwned handoff only; original native/score encoding contract preserved' }) };
