'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'scalar-live-research-layout.cjs'), hash = data => crypto.createHash('sha256').update(data).digest('hex');
let source = fs.readFileSync(basePath, 'utf8');
if (hash(source) !== 'a3f8f4ed26f768d0ada8de8896ccde046f67eaeff3db76fcf99683fef73f6a42') throw Error('Prior layout source changed.');
for (const [before, after] of [["'./scalar-producer-research-source.cjs'", "'./scalar-window-producer-research-source.cjs'"], ["'./scalar-consumer-live-research-source.cjs'", "'./scalar-window-consumer-research-source.cjs'"]]) {
  if (source.split(before).length !== 2) throw Error('Window layout transform boundary changed.'); source = source.replace(before, after);
}
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname); compiled._compile(source, __filename); module.exports = compiled.exports;
