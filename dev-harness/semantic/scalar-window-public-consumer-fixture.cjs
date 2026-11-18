'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'scalar-public-consumer-fixture.cjs'), hash = data => crypto.createHash('sha256').update(data).digest('hex');
let source = fs.readFileSync(basePath, 'utf8');
if (hash(source) !== '6d13221aadf1c12bc3dcbd64a4bcea5532e0abf179d20341ff40fb8464a7f773') throw Error('Prior public fixture changed.');
for (const [before, after] of [["'./scalar-live-research-layout.cjs'", "'./scalar-window-live-layout.cjs'"], ["'./scalar-composite-policy-research.cjs'", "'./scalar-window-policy-research.cjs'"]]) {
  if (source.split(before).length !== 2) throw Error('Window fixture transform boundary changed.'); source = source.replace(before, after);
}
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname); compiled._compile(source, __filename); module.exports = compiled.exports;
