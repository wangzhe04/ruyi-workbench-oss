'use strict';
// Two synthetic pairs only, actual encrypted source guards and native host.
// Run only in an explicitly coordinated correctness window, not a benchmark.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const { createScalarNativeHost } = require('./scalar-native-host-research.cjs');
const { createScalarVerifierBridge } = require('./scalar-verifier-bridge-prototype.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
async function main(output) {
  if (fs.existsSync(output)) throw Error('Use a new immutable sanity receipt.'); fs.mkdirSync(path.dirname(output), { recursive: true });
  const files = ['scalar-native-host-sanity.cjs', 'scalar-native-host-research.cjs', 'scalar-owned-native-research.cjs', 'qwen-reranker-native.cjs', 'scalar-verifier-bridge-prototype.cjs', 'scalar-composite-policy-research.cjs', 'native-job-launcher.cjs'];
  const sourceBefore = files.map(name => ({ file: path.join(__dirname, name), sha256: hash(fs.readFileSync(path.join(__dirname, name))) }));
  const cases = [{ id: 'Positive', query: 'What is the capital of China?', text: 'Beijing is the capital of China.', expected: true },
    { id: 'Negative', query: 'What is the capital of China?', text: 'Photosynthesis uses sunlight to make sugar in plant leaves.', expected: false }];
  const report = { schemaVersion: 1, status: 'RUNNING', sourceBefore, pairs: [], guardCalls: 0, transportGuardCalls: 0, prepareBudgetMs: 20000, perPairBudgetMs: 1000,
    limits: ['Synthetic interface/ownership correctness only; concurrent GCC build means no latency/RSS/resource qualification.', 'No acceptance/check data, native defaults, model weights or frozen850 pair receipt is modified.', 'Cooperative/HTTP deadline can require additional observed cleanup time; not an OS hard wall-clock guarantee.'] };
  const f = await fixture({ enabled: true }), host = createScalarNativeHost(), bridge = createScalarVerifierBridge(host); let primary;
  try {
    for (const item of cases) await f.put(item.id, [{ role: 'user', id: 'm1', content: item.text }]);
    const scope = await f.host.scope(null), sourceStates = new Map();
    const guard = async event => {
      report.guardCalls++; if (event.phase === 'transport') report.transportGuardCalls++;
      const selected = event.source ? cases.filter(item => event.source.identity.sourceId === item.id) : cases;
      if (event.source && selected.length !== 1) throw Error('Unknown guarded field.');
      for (const item of selected) {
        if (f.host.assertScope(null, scope) !== true || await f.host.authorize(item.id, null, scope) !== true) throw Error('Actual source authorization changed.');
        let found = 0; const sequence = f.host.sourceSequence(item.id), proof = await f.host.scan(item.id, async (row, ordinal) => {
          if (ordinal !== 0 || hash(JSON.stringify(row)) !== hash(JSON.stringify({ role: 'user', id: 'm1', content: item.text }))) throw Error('Actual source row changed.'); found++;
        });
        if (found !== 1 || await f.host.epoch(item.id) !== proof.epoch || sequence !== f.host.sourceSequence(item.id) || f.host.assertScope(null, scope) !== true) throw Error('Actual source proof changed.');
        const state = JSON.stringify([proof.epoch, proof.revision, sequence]); if (sourceStates.has(item.id) && sourceStates.get(item.id) !== state) throw Error('Source generation changed.'); sourceStates.set(item.id, state);
      }
    };
    report.ready = await host.prepare({ deadline: Date.now() + 20000 }); if (!report.ready.ok) throw Error('Native host did not become ready.');
    for (const item of cases) {
      const result = await bridge.verify(item.query, [{ identity: { sourceId: item.id, field: 'content', revision: hash(item.text), start: 0, end: item.text.length }, text: item.text }],
        { scopeId: scope.scopeId, deadline: Date.now() + 1000, beforeVerify: guard });
      report.pairs.push({ id: item.id, expected: item.expected, result });
      if (!result.coverage.complete || result.results[0].accepted !== item.expected) throw Error('Synthetic scalar host sanity failed.');
    }
    report.status = 'PASS_SYNTHETIC_INTERFACE_NOT_QUALITY_QUALIFICATION';
  } catch (error) { primary = error; report.status = 'FAIL'; report.error = String(error?.stack || error); }
  finally {
    try { report.cleanup = await bridge.stop(); } catch (error) { report.cleanup = { workerExited: false, cleanupStatus: 'unknown', error: String(error) }; }
    report.stats = host.stats(); await f.close();
    report.sourceStable = sourceBefore.every(item => hash(fs.readFileSync(item.file)) === item.sha256);
    if (report.cleanup?.cleanupStatus !== 'observed' || report.cleanup?.workerExited !== true || report.stats.unconfirmedOwners !== 0 || !report.sourceStable) report.status = 'FAIL_UNCONFIRMED_CLEANUP_OR_DRIFT';
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  }
  console.log(JSON.stringify({ output, status: report.status, pairs: report.pairs.map(item => ({ id: item.id, probability: item.result.results[0]?.score, complete: item.result.coverage.complete })), guardCalls: report.guardCalls, transportGuardCalls: report.transportGuardCalls, cleanup: report.cleanup, stats: report.stats, error: report.error }));
  if (primary || report.status !== 'PASS_SYNTHETIC_INTERFACE_NOT_QUALITY_QUALIFICATION') process.exitCode = 1;
}
if (require.main === module) main(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
