'use strict';
// Same fixed248 replay input and exact expected method outputs, now applying
// explicit window-v2 source variants. No new model inference or grid selection.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'scalar-producer-development-replay.cjs'), hash = value => crypto.createHash('sha256').update(value).digest('hex');
let source = fs.readFileSync(basePath, 'utf8');
if (hash(source) !== '93243f18a69990ba88f7cb8445e7eed006f3a5eea5b985b5f72f84cb06508103') throw Error('Prior frozen development replay changed.');
for (const [before, after] of [["'./scalar-composite-policy-research.cjs'", "'./scalar-window-policy-research.cjs'"], ["'./scalar-producer-research-source.cjs'", "'./scalar-window-producer-research-source.cjs'"]]) {
  if (!source.includes(before)) throw Error('Window replay redirect missing.'); source = source.split(before).join(after);
}
source = source.replace('if (require.main === module) main(', 'main(');
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname); compiled._compile(source, __filename);
