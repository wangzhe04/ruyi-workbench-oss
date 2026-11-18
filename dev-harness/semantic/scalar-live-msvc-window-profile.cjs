'use strict';
// Explicit window-v2 policy over the retained MSVC baseline native controller.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'scalar-live-msvc-profile.cjs'), hash = value => crypto.createHash('sha256').update(value).digest('hex');
let source = fs.readFileSync(basePath, 'utf8'); if (hash(source) !== 'cb6c7f3ee65c28d6fbfe02ed9c77f53c48ad04fb32d8e875524c1b7e354668af') throw Error('MSVC baseline profile changed.');
const one = (before, after) => { if (source.split(before).length !== 2) throw Error('MSVC window profile boundary changed.'); source = source.replace(before, after); };
one("'scalar-native-host-research.cjs': 'e3d85c6c8c4b28fc47dc6c49021375d4a8e0e0ce1cd814bd0e6e73a46666753f'", "'scalar-window-native-host-research.cjs': 'ed1895e28855ac2007c6b82834a1f4cd3b8bbf4676fd2bbc72963b6d6d18c4a8',\n  'scalar-window-policy-research.cjs': '1d7eccdd39bdd3005d701164361504a5d18c5e0d70aef84dcba04857f8fd3ff6'");
one("require('./scalar-native-host-research.cjs')", "require('./scalar-window-native-host-research.cjs')");
one("id: 'msvc-b11146-qwen-prior-evidence-rank-buffer6-baseline'", "id: 'msvc-b11146-qwen-prior-evidence-rank-buffer6-window-v2'");
one('descriptor: { coarse:', "descriptor: { policyId: 'qwen-prior-evidence-global-k1-rank095-best-field-window-v2', coarse:");
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname); compiled._compile(source, __filename); module.exports = compiled.exports;
