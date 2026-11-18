'use strict';
// Preserve the reviewed e3 strong registry, ownership handoff and guards.
// This separately pinned GCC profile does not inherit MSVC qualification.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const base = path.join(__dirname, 'scalar-native-host-research.cjs');
let source = fs.readFileSync(base, 'utf8');
if (sha(source) !== 'e3d85c6c8c4b28fc47dc6c49021375d4a8e0e0ce1cd814bd0e6e73a46666753f') throw Error('gcc.scalar_host_changed');
function one(a, b) { if (source.split(a).length !== 2) throw Error('gcc.scalar_transform_changed'); source = source.replace(a, b); }
one("'./scalar-owned-native-research.cjs'", "'./gcc-rank-native-research.cjs'");
one('4e09627f1f1563b97fd7703415d5c223bdd672d30625711cb099f11d4225b7d3', '0ae9f69a19b689fdcdb093918bd000a5aebe4c7eed354e227c75e38041764ff8');
one('c703f828ce9ad6e423593c9baa44f5901dbce9a9776a8a3850f640e3f2799ee6', '5bd146943d81c623e64d497c35231a5d2dea798fa9b5454f26e06a8d8724d28c');
one("path.resolve('output/semantic-qwen-reranker-official-v1').toLowerCase()", "path.resolve('output/semantic-native-mingw-research/rank-owner').toLowerCase()");
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname);
compiled._compile(source, __filename);
module.exports = compiled.exports;
