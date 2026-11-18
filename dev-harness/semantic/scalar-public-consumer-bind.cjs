'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const output = path.resolve(process.argv[2]); if (fs.existsSync(output)) throw Error('Use a new immutable consumer receipt.');
const names = ['scalar-consumer-live-research-source.cjs', 'scalar-live-research-layout.cjs', 'scalar-public-consumer-fixture.cjs', 'scalar-public-consumer-research.test.cjs',
  'scalar-consumer-research-source.cjs', 'scalar-producer-research-source.cjs', 'scalar-composite-policy-research.cjs', 'scalar-verifier-bridge-prototype.cjs'];
const files = names.map(name => path.join(__dirname, name)).concat(['13as-session-fulltext-consumers.js', '13ap-session-fulltext-index.js', '06ha-semantic-retrieval.js'].map(name => path.resolve('ruyi-workbench/app/src', name)),
  [path.resolve('dev-harness/lib/fulltext-consumer-fixture.js'), path.resolve('dev-harness/lib/work-data-session-fulltext-fixture.js')]);
const before = files.map(file => ({ file, sha256: hash(file) }));
const tests = cp.spawnSync(process.execPath, ['--test', path.join(__dirname, 'scalar-public-consumer-research.test.cjs')], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const layout = require('./scalar-live-research-layout.cjs').layout(path.join(path.dirname(output), 'source'));
const stable = before.every(item => hash(item.file) === item.sha256);
const report = { schemaVersion: 1, status: tests.status === 0 && stable ? 'PASS_PUBLIC_CONSUMER_FAKE_NOT_NATIVE_QUALITY' : 'FAIL',
  binderSha256: hash(__filename), sourceBefore: before, sourceStable: stable, producer: layout.producer,
  consumer: { originalSha256: layout.consumer.originalSha256, transformedSha256: layout.consumer.transformedSha256, recipe: layout.consumer.recipe, contract: layout.consumer.contract },
  tests: { exitCode: tests.status, stdout: tests.stdout, stderr: tests.stderr }, nativeStarts: 0,
  priorRed: { preservedInConversation: true, reason: 'First new test run incorrectly classified public modelFingerprint as a source digest and expected13g metadata hits without a reference to expose a snippet. Actual13as direct model snippet assertion is retained;13g metadata DTO remains unchanged.' },
  limits: ['Actual source/privacy/13as/UI13d/tool13g with injected synthetic encoder/scalar; not native relevance, live timing or independent acceptance.', 'Full source identities remain private index WeakMap/harness-only. Public DTO checks exclude original revision/epoch/raw-derived field hashes.', 'Original production67de/90a and prior frozen research source/850 results remain untouched.'] };
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sha256: hash(output), status: report.status, stable, exitCode: tests.status })); if (report.status !== 'PASS_PUBLIC_CONSUMER_FAKE_NOT_NATIVE_QUALITY') process.exitCode = 1;
