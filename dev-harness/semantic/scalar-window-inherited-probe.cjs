'use strict';
// Compatibility probe, not a default green test suite. The intentionally
// changed v1 incomplete-coarse/whole-field assertion remains visible as RED;
// window-v2 has its own explicit fixed-best-window partial regression.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tests = [
  ['scalar-composite-policy-research.test.cjs', '1b4e8fd903406113353ea6b810f76b5f583f7e12d99a94131e0c84e73693571b', [["'./scalar-composite-policy-research.cjs'", "'./scalar-window-policy-research.cjs'"]]],
  ['scalar-producer-research.test.cjs', '298d7690830011842a920811063ad9911ccee2fc173c44c7884371a3624b352a', [["'./scalar-producer-research-source.cjs'", "'./scalar-window-producer-research-source.cjs'"], ["'./scalar-composite-policy-research.cjs'", "'./scalar-window-policy-research.cjs'"]]],
  ['scalar-native-host-research.test.cjs', '73b96c3f23ff5cbab514b77d4f70fb5171c0320461ca7039d6361d23d2005321', [["'./scalar-native-host-research.cjs'", "'./scalar-window-native-host-research.cjs'"]]],
  ['scalar-public-consumer-research.test.cjs', '471184ae9927bd3bb9951c90c918a875034456f727fe8ee0982c8ea58f6c332d', [["'./scalar-public-consumer-fixture.cjs'", "'./scalar-window-public-consumer-fixture.cjs'"]]],
  ['scalar-public-consumer-privacy.test.cjs', '4b64b06c68412f4fa934b23f391b77cef2b6ff04b5781b316340b63d822c057f', [["'./scalar-public-consumer-fixture.cjs'", "'./scalar-window-public-consumer-fixture.cjs'"]]],
];
for (const [name, sha256, redirects] of tests) {
  const file = path.join(__dirname, name); let source = fs.readFileSync(file, 'utf8'); if (hash(source) !== sha256) throw Error('Inherited regression changed: ' + name);
  for (const [before, after] of redirects) { if (!source.includes(before)) throw Error('Inherited redirect missing.'); source = source.split(before).join(after); }
  const compiled = new Module(file, module); compiled.filename = file; compiled.paths = Module._nodeModulePaths(__dirname); compiled._compile(source, file);
}
