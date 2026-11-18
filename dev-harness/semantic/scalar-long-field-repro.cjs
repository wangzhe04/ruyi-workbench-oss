'use strict';
// Native-free structural repro: actual producer/source/scalar bridge, actual
// official tokenizer counts, injected complete coarse/positive-window scores.
// No new policy, model inference, quality fixture or threshold fitting.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), crypto = require('node:crypto'), cp = require('node:child_process');
const { fixture } = require('../lib/fulltext-owned-producer-fixture');
const { transform } = require('./scalar-producer-research-source.cjs');
const { createCompositePolicy } = require('./scalar-composite-policy-research.cjs');
const { createScalarVerifierBridge } = require('./scalar-verifier-bridge-prototype.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function main(output) {
  if (fs.existsSync(output)) throw Error('Use a new immutable repro receipt.'); fs.mkdirSync(path.dirname(output), { recursive: true });
  const root = path.resolve('output/semantic-qwen-reranker-official-v1'), home = path.join(path.dirname(output), 'tokenizer-home');
  fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(path.join(home, 'OWNER.json'), JSON.stringify({ owner: 'scalar-long-field-repro', synthetic: true }) + '\n');
  for (const name of ['local', 'roaming', 'temp']) fs.mkdirSync(path.join(home, name), { recursive: true });
  const query = 'orchid missing', text = 'orchid documented evidence. ' + 'a '.repeat(1200), indexPath = path.resolve('ruyi-workbench/app/src/13ap-session-fulltext-index.js');
  const transformed = transform(fs.readFileSync(indexPath, 'utf8')), modulePath = path.join(path.dirname(output), 'producer.cjs'); fs.writeFileSync(modulePath, transformed.source, { flag: 'wx' });
  const sourcePath = path.resolve('ruyi-workbench/app/src/06ha-semantic-retrieval.js'), primitive = vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
  const normalize = vm.runInNewContext(fs.readFileSync(indexPath, 'utf8').match(/^  const canonicalText=.*;$/m)[0] + '\n' + fs.readFileSync(indexPath, 'utf8').match(/^  const normalize=.*;$/m)[0] + '\nnormalize;');
  const report = { schemaVersion: 1, status: 'RUNNING', scriptSha256: hash(fs.readFileSync(__filename)), producerSha256: hash(fs.readFileSync(indexPath)), derivedProducerSha256: transformed.transformedSha256,
    policySha256: hash(fs.readFileSync(require.resolve('./scalar-composite-policy-research.cjs'))), semanticSourceSha256: hash(fs.readFileSync(sourcePath)), modelStarts: 0, runs: [], scalarInputs: [],
    limits: ['Actual original source/index/bridge composition, with injected coarse scores and accepted short-window scalar; this proves a structural completion issue, not model relevance.', 'Official fixed tokenizer JSON and pinned GGUF template count tokens locally; no weights/session/native inference is loaded.', 'No v6/check/holdout or development labels are read.'] };
  const f = await fixture({ enabled: true, module: modulePath }); f.hookContext.SemanticRetrieval = primitive;
  try {
    await f.put('Long', [{ role: 'user', id: 'm1', content: text }]);
    let originals = null;
    const scorer = { clear() {}, async score(_query, docs, options) {
      const indices = docs.map((_, index) => index); originals = await options.resolveTexts(indices); await options.beforeEncode();
      return { status: 'ready', scores: docs.map((_, index) => index === 0 ? .9 : .1), modelFingerprint: 'synthetic-complete-coarse', coverage: { cached: docs.length, total: docs.length, complete: true } };
    } };
    const tokenizer = path.join(root, 'source/Qwen3-Reranker-0.6B/tokenizer.json'), inventory = path.join(root, 'artifact-inventory.json');
    const data = { tokenizer, template: JSON.parse(fs.readFileSync(inventory)).artifacts.q4_k_m.template, query, full: text };
    const python = path.join(root, 'converter-venv/Scripts/python.exe');
    const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, PATH: path.dirname(python) + ';' + path.join(process.env.SystemRoot, 'System32'),
      HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'roaming'), LOCALAPPDATA: path.join(home, 'local'), TEMP: path.join(home, 'temp'), TMP: path.join(home, 'temp'), HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' };
    const code = "import json,sys,hashlib\nfrom tokenizers import Tokenizer\np=json.load(sys.stdin);t=Tokenizer.from_file(p['tokenizer'])\ndef count(s):\n x=p['template'].replace('{query}',p['query']).replace('{document}',s)\n return len(t.encode(x,add_special_tokens=False).ids)\nprint(json.dumps({'fullJointTokens':count(p['full']),'first96JointTokens':count(p['full'][:96])}))";
    const counts = cp.spawnSync(python, ['-I', '-B', '-c', code], { cwd: home, env, windowsHide: true, encoding: 'utf8', input: JSON.stringify(data), maxBuffer: 1024 * 1024 });
    if (counts.status !== 0) throw Error(counts.stderr || 'Tokenizer count failed.');
    report.tokens = JSON.parse(counts.stdout); report.tokenizerSha256 = hash(fs.readFileSync(tokenizer)); report.inventorySha256 = hash(fs.readFileSync(inventory));
    if (report.tokens.fullJointTokens <= 512 || report.tokens.first96JointTokens > 512) throw Error('Repro does not meet the specified joint512 boundary.');
    const fp = { modelFingerprint: 'injected-native-free', templateFingerprint: 'template', runtimeFingerprint: 'runtime', policyFingerprint: 'policy' };
    const scalarHost = { prepare: async () => ({ ok: true, ...fp }), stop: async () => ({ cleanupStatus: 'observed', workerExited: true }),
      async verify(_query, source, options) { await options.beforeVerify(); const full = source.text === text;
        report.scalarInputs.push({ identity: source.identity, characters: source.text.length, modeledJointTokens: full ? report.tokens.fullJointTokens : report.tokens.first96JointTokens });
        if (full) return { ok: false, reason: 'unavailable', diagnostic: 'joint-token-limit' };
        return { ok: true, ...fp, score: .99, accepted: true }; } };
    const policy = createCompositePolicy({ bridge: createScalarVerifierBridge(scalarHost), identify: primitive.structuredIds, normalize, terms: f.api.terms });
    const index = vm.runInNewContext('SessionFullTextIndex;', f.hookContext).create({ ...f.host, resultUnit: 'sessions', semantic: scorer, scalarComposite: policy }); await index.prepare(null);
    for (let n = 0; n < 2; n++) { const found = await index.search(query, null, 50, { deadline: Date.now() + 2500 }), detail = index.researchReport(found);
      report.runs.push({ attempt: n + 1, sourceCoverage: found.coverage, semantic: found.semantic, lexical: found.lexicalAdmission, privateDiagnostic: detail,
        resultCount: found.results.length, references: found.results.map(row => row.reference) }); }
    report.firstResolvedWindowSha256 = hash(originals[0]); report.first96Sha256 = hash(text.slice(0, 96));
    if (report.firstResolvedWindowSha256 !== report.first96Sha256) throw Error('Actual producer first original window differs from independently counted96.');
    report.priorReproVerdictCorrection = 'v1 incorrectly expected an admitted semantic result to survive RRF fusion. Actual result is zero: its merged lexical flag lets unknown whole-field weak admission suppress the already-admitted semantic window. v1 raw observations remain preserved.';
    report.status = report.runs.every(run => run.sourceCoverage.complete && run.privateDiagnostic.globalCoarseComplete
      && run.privateDiagnostic.scores.some(row => row.accepted === true && row.identity.end - row.identity.start === 96)
      && run.privateDiagnostic.scores.some(row => row.accepted === null && row.identity.end - row.identity.start === text.length)
      && run.semantic.coverage === 'partial' && run.lexical.partial === true)
      && report.scalarInputs.filter(row => row.characters === text.length).length === 2 ? 'CONFIRMED_REPEATABLE_LONG_FIELD_PARTIAL' : 'NOT_REPRODUCED';
  } catch (error) { report.status = 'FAIL_REPRO'; report.error = String(error.stack || error); }
  finally { await f.close(); report.cleanup = { workerExited: true, cleanupStatus: 'observed', nativeNeverStarted: true }; fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' }); }
  console.log(JSON.stringify({ output, sha256: hash(fs.readFileSync(output)), status: report.status, tokens: report.tokens, runs: report.runs.map(row => ({ attempt: row.attempt, complete: row.semantic.coverage, results: row.resultCount, lexicalPartial: row.lexical.partial })), error: report.error }));
}
if (require.main === module) main(path.resolve(process.argv[2])).catch(error => { console.error(error); process.exitCode = 1; });
