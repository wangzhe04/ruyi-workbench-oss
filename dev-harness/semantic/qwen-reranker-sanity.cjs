'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), cp = require('node:child_process');
const { createVerifier } = require('./qwen-reranker-native.cjs');
const root = path.resolve('output/semantic-qwen-reranker-official-v1'), output = path.resolve(process.argv[2] || path.join(root, 'sanity-v1.json'));
if (fs.existsSync(output)) throw Error('Use a new immutable report.');
const cases = [
  { id: 'capital-positive', query: 'What is the capital of China?', document: 'The capital of China is Beijing.', positive: true },
  { id: 'capital-negative', query: 'What is the capital of China?', document: 'Gravity is a force that attracts two bodies towards each other.', positive: false },
  { id: 'gravity-positive', query: 'Explain gravity', document: 'Gravity is a force that attracts two bodies towards each other.', positive: true },
  { id: 'gravity-negative', query: 'Explain gravity', document: 'The capital of China is Beijing.', positive: false },
];
const report = { schemaVersion: 1, status: 'RUNNING', sourceSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
  generatedAt: new Date().toISOString(), source: 'Independent illustrative pairs from the official Qwen reranker example topics, not development/acceptance selection.', results: [],
  network: { applicationOffline: true, loopbackOnly: true, osFirewall: false },
  limits: ['Synthetic sanity only, not retrieval/OOD quality or probability calibration.', 'One new verifier model only. No MiniLM concurrency or controlled 500ms latency claim.', 'Native ctx1024; strict host joint512 including complete fixed instruction/prefix/suffix. Slot erased before every inference; no save/restore.', 'RANK /v1/embeddings is unsafe in b11146 (2-class allocation versus 1024-copy); never used. Scalar /rerank yes probability is verified against the pinned head/class order and native softmax/send_rerank source, not an API two-vector numerical comparison.', 'No check/acceptance fixture or query is imported.'] };
let verifier;
(async () => {
  try {
    verifier = await createVerifier(); report.contract = verifier.contract; report.fingerprint = verifier.fingerprint; report.nativeLaunchToReadyMs = verifier.coldReadyMs;
    for (const item of cases) {
      const result = await verifier.score(item.query, item.document);
      if (!result.ok) throw Error('Short sanity pair was refused.');
      report.results.push({ id: item.id, positive: item.positive, ...result });
    }
    report.sanityOrdering = report.results[0].probability > report.results[1].probability && report.results[2].probability > report.results[3].probability;
    report.binarySanity = report.results.every(x => x.positive ? x.probability > .5 : x.probability < .5);
    if (!report.sanityOrdering || !report.binarySanity) throw Error('Independent positive/negative sanity failed.');
    const query = 'What is the capital of China?'; let exact512, exact513;
    for (let count = 0; count <= 600 && (!exact512 || !exact513); count++) {
      // Tokenizer-only operations; only the exact512 case may run inference.
      if (count < 350) { count = 349; continue; }
      const document = ' x'.repeat(count), length = (await verifier.tokenize(query, document)).length;
      if (length === 512) exact512 = document; if (length === 513) exact513 = document;
      if (length > 513) break;
    }
    if (!exact512 || !exact513) throw Error('Could not construct explicit joint512/513 boundary.');
    const accepted = await verifier.score(query, exact512), before = verifier.stats(), refused = await verifier.score(query, exact513), after = verifier.stats();
    report.boundary = { accepted512: accepted, refused513: refused, rejectedWithoutInference: before.rankWrites === after.rankWrites && before.embeddingWrites === after.embeddingWrites };
    if (!accepted.ok || accepted.tokens !== 512 || refused.ok || refused.tokens !== 513 || !report.boundary.rejectedWithoutInference) throw Error('Joint token budget contract failed.');
    const memory = cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-Process -Id ${verifier.nativePid} | Select-Object WorkingSet64,PeakWorkingSet64,PrivateMemorySize64 | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    report.nativeObservedMemory = memory.status === 0 ? JSON.parse(memory.stdout) : { unavailable: true };
    report.status = 'SANITY_PASS_NOT_QUALITY';
  } catch (error) { report.status = 'FAIL'; report.error = String(error.stack || error); if (error.nativeContractDiagnostic) report.nativeContractDiagnostic = error.nativeContractDiagnostic; }
  finally {
    if (verifier) { report.stats = verifier.stats(); try { report.cleanup = await verifier.stop(); } catch (error) { report.cleanup = { workerExited: false, error: String(error) }; } }
    if (report.cleanup?.workerExited !== true || report.cleanup?.cleanupStatus !== 'observed') report.status = 'FAIL';
    report.finishedAt = new Date().toISOString(); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ output, status: report.status, results: report.results, boundary: report.boundary, cleanup: report.cleanup, nativeContractDiagnostic: report.nativeContractDiagnostic, error: report.error }));
    if (report.status === 'FAIL') process.exitCode = 1;
  }
})();
