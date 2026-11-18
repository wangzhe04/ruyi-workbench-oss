'use strict';
// Bind explicit research source/recipe/replay/ownership receipts. This script
// runs no model, chooses no policy and reads no acceptance/check data.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file));
const output = path.resolve(process.argv[2]), replayPath = path.resolve(process.argv[3]), sanityPath = path.resolve(process.argv[4]);
if (fs.existsSync(output)) throw Error('Use a new immutable binding receipt.');
const replay = read(replayPath), sanity = read(sanityPath);
if (replay.status !== 'PASS_ACTUAL_PRODUCER_REPLAY_NOT_LIVE_QUALIFICATION' || !replay.sourceBindingsStable || !replay.coverage?.complete || replay.coverage.completedQueries !== 248
  || replay.scalarWrites !== 128 || replay.rows.some(row => !row.complete || !row.rrfComponentsAndSemanticFlagsAgree)
  || sanity.status !== 'PASS_SYNTHETIC_INTERFACE_NOT_QUALITY_QUALIFICATION' || !sanity.sourceStable || sanity.cleanup.cleanupStatus !== 'observed' || sanity.cleanup.workerExited !== true
  || sanity.stats.injectedFactory !== false || sanity.stats.unconfirmedOwners !== 0) throw Error('Incomplete/unbound research evidence.');
for (const item of [...Object.values(replay.sourceBefore), ...sanity.sourceBefore]) if (hash(item.file) !== item.sha256) throw Error('Research evidence source changed: ' + item.file);
const names = ['scalar-composite-policy-research.cjs', 'scalar-producer-research-source.cjs', 'scalar-consumer-research-source.cjs',
  'scalar-native-host-research.cjs', 'scalar-owned-native-research.cjs', 'scalar-producer-development-replay.cjs', 'scalar-native-host-sanity.cjs',
  'scalar-composite-policy-research.test.cjs', 'scalar-producer-research.test.cjs', 'scalar-native-host-research.test.cjs',
  'scalar-verifier-bridge-prototype.cjs', 'qwen-reranker-native.cjs', 'native-job-launcher.cjs'];
const files = names.map(name => ({ file: path.join(__dirname, name), sha256: hash(path.join(__dirname, name)) }));
const tests = cp.spawnSync(process.execPath, ['--test', ...names.filter(name => name.endsWith('.test.cjs')).map(name => path.join(__dirname, name))], { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
const recipe = require('./scalar-producer-research-source.cjs').transform(fs.readFileSync(replay.sourceBefore.producer.file, 'utf8'));
const consumer = require('./scalar-consumer-research-source.cjs').transform(fs.readFileSync('ruyi-workbench/app/src/13as-session-fulltext-consumers.js', 'utf8'));
const sourceStable = files.every(item => hash(item.file) === item.sha256);
const report = { schemaVersion: 1, status: tests.status === 0 && sourceStable ? 'PASS_BOUND_RESEARCH_NOT_ACCEPTANCE_OR_RELEASE' : 'FAIL',
  bindingScriptSha256: hash(__filename), files, tests: { command: [process.execPath, '--test', ...names.filter(name => name.endsWith('.test.cjs'))], exitCode: tests.status, stdout: tests.stdout, stderr: tests.stderr },
  sourceStable, replay: { path: replayPath, sha256: hash(replayPath), coverage: replay.coverage, scalarWrites: replay.scalarWrites, actualReferences: replay.rows.reduce((sum, row) => sum + row.actual.length, 0) },
  nativeSanity: { path: sanityPath, sha256: hash(sanityPath), probabilities: sanity.pairs.map(pair => ({ id: pair.id, probability: pair.result.results[0].score })), cleanup: sanity.cleanup, stats: sanity.stats },
  policy: require('./scalar-composite-policy-research.cjs').CONTRACT,
  recipe: { originalSha256: recipe.originalSha256, transformedSha256: recipe.transformedSha256, patches: recipe.recipe },
  consumerRecipe: { originalSha256: consumer.originalSha256, transformedSha256: consumer.transformedSha256, patches: consumer.recipe, contract: consumer.contract },
  fixedWindowContract: { semantic: 'Exact current90a original-coordinate96 UTF16 fragment,16 overlap; never uppercase input or join another field.',
    weakLexical: 'Entire same original source field. Length>8192 or actual full-template joint512 refusal stays unverified/partial; never shorten or select text based on scores.',
    metadata: 'Entire own metadata field for weak verification; raw global rank uses its existing96/16 fragments. Complete-ID eligibility is proven on its original field before K.',
    zeroEligible: 'Proven complete empty eligible set requires no model score. Real32-ID/4096/metadata/lexical truncation stays partial.' },
  privateDiagnostics: 'Detailed identity/revision/epoch/scores only in searchProofs WeakMap and explicit synthetic harness receipt. Public research result has policy/status/counts only. Production must use opaque v2 refs and must not expose private diagnostics or raw-derived hashes.',
  limits: ['Candidate remains raw Qwen prior-evidence K1 plus scalar>=.95; no old.46 or additional gate/grid is added.',
    '30 focused fake checks plus248 actual producer replay and2 actual scalar sanity pairs are not independent v6 quality, public consumer acceptance, combined-RSS or500ms qualification.',
    'Source preparation/recovery and all independent consumers remain separate qualification tasks. Ordinary feature-off lexical mode is explicit and unchanged.',
    'No production/default/manifest/model change. Original850/a2/protocol/ledger and all failed intermediate research receipts are retained.',
    'The consumer source transform is compile-reviewed; actual complete13as public API qualification is not claimed by the13ap replay.',
    'No model was started by this binding script. Synthetic sanity used a coordinated correctness window with GCC compilation and makes no formal performance claim.'] };
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, sha256: hash(output), status: report.status, transformedProducerSha256: recipe.transformedSha256, fakeExitCode: tests.status }));
if (report.status !== 'PASS_BOUND_RESEARCH_NOT_ACCEPTANCE_OR_RELEASE') process.exitCode = 1;
