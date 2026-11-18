'use strict';
// Predeclared development protocol only; this file runs no model/producer.
const protocol = {
  schemaVersion: 1, id: 'official-qwen3-reranker-development-v1', scope: 'existing-calibration-fixture train/calibration only',
  prohibited: ['No check or consumed acceptance query/label/report for fitting or selection.', 'No production/default/gate edits, new checkpoint download or instruction variant.'],
  verifier: { modelSha256: '9787224d2920d37838ed8dcf88dc6f2b92d1629192627655c32b06aef04becc7',
    instruction: 'Pinned GGUF official web-search answer-the-query template; no host-only prefix changes.',
    score: 'Scalar yes probability from native RANK softmax, ordered source rows yes9693/no2152; never an embedding vector, never another sigmoid/L2.',
    runtimeProfile: 'independently locked rank-buffer, threads6, CPU/GPU0, native ctx1024, physical1; exact runtime inventory/patch hashes must bind the receipt',
    unsafeRoutes: 'All embedding endpoints disabled by the guarded runtime; research code uses /rerank only.',
    jointTokenBudget: { limit: 512, includes: ['entire fixed system/user/assistant prefix and suffix', 'original unprefixed query', 'same original field/window'],
      pendingUntilNativeTokenized: true, truncate: false, overLimit: 'unverified/null and partial, never a fabricated negative' } },
  producer: { requiredIndexSha256: '90a0191d29307ba1f5582f4073bb7a01dc311f5a72481bbc06b01ee3a084a15f',
    freeze: 'Actual current encrypted-source production fixture, original raw fields, full source/citation identities and before/after code hashes. Historical 3fc capture is only a ceiling, not a precision witness.',
    candidateUnion: ['MiniLM raw top5 after full structured-ID consistency', 'Qwen stateless prior-evidence raw top3 after full structured-ID consistency', 'all observed current producer weak lexical candidates'],
    profiles: [{ id: 'minilm-k4', encoder: 'minilm', topK: 4 }, { id: 'minilm-k5', encoder: 'minilm', topK: 5 },
      { id: 'qwen-k1', encoder: 'qwen-prior-evidence', topK: 1 }, { id: 'qwen-k3', encoder: 'qwen-prior-evidence', topK: 3 }],
    pairDeduplication: 'query identity/hash + complete source identity/revision/field/window/hash; repeated pair across profiles is inferred once, never a same-session exemption',
    rawText: 'Resolve exactly the cited original field/window; never uppercase semantic text, concatenate fields or borrow a different source/title.' },
  strongEvidence: { source: 'Current producer normalization, actual retrievalTerms, and shared complete structured-ID parser; no domain words or new stopword rules.',
    bypassOnly: ['exact full query phrase in this same original field', 'every current effective query term in this same original field', 'all complete required structured identifiers in this same original field after exact-token/source proof'],
    mismatch: 'A required complete ID absent from the actual field is a deterministic rejection; do not let an entity in another field/session authorize it.',
    weak: 'All other lexical results require the same scalar verifier as semantic-only results. Strong evidence in one field never authorizes another field/window.',
    missingFact: 'A strong matching source can be relevant context while the requested fact is absent; it does not authorize an answerability claim.' },
  fixedGrid: { thresholds: [.01, .05, .10, .25, .50, .75, .90, .95, .99], profileThresholdPolicies: 36,
    noOtherFit: 'No learned feature, script/domain condition, prompt adjustment, gap/z rule, or adaptive threshold. No coarse cosine threshold is added in this candidate-feasibility comparison.',
    admission: 'Only finite measured p>=threshold is accepted. Missing/refused/over-budget/source-stale scores remain null/partial.',
    ranking: 'Scalar is admission only in this first protocol; retain original coarse order, recompute production lexical/semantic reciprocal ranks after field proof/admission, then final result cap.' },
  metrics: { positives: 'Both train and calibration: zh-zh Recall@5>=.90; zh-en/en-zh>=.85; overall positive MRR>=.75. Report en-en independently without inventing a new directional floor.',
    pureOod: 'Separate pure OOD any-result FPR<=.05 on each split. Also report verified-semantic/weak-only FPR and strong-only FPR with original pure OOD denominator.',
    entityMismatch: 'Separate any-result FPR<=.05 on each split, never mixed into pure OOD denominator.',
    missingFieldAndNumber: 'Separate related-but-missing-fact diagnostics, not treated as unrelated OOD or promises of answer support.',
    partial: 'Report coverage and metrics on all prescribed queries. Partial/unverified queries cannot disappear from denominator or turn into true negatives.',
    gate: 'A candidate is eligible only with both-split recall/MRR/OOD/ID floors and complete prescribed pair/source coverage; reject-all is never eligible.' },
  selection: ['First enforce all both-split quality/precision/coverage gates.', 'Then lower worst pure OOD FPR.', 'Then fewer actual required pair inferences and total joint tokens; resource/latency tie-break only when genuinely measured.', 'Then higher minimum split MRR, higher scalar threshold and stable profile ID for deterministic ties.', 'If no candidate is eligible, retain RED and do not open check or another acceptance set.'],
  budget: { sharedDeadline: 'Production study must share existing semantic1s/consumer2.5s absolute deadline across coarse encoding, rereads, tokenization, validated erase and verifier; no separate extra1s.',
    prediction: 'Use the same finite measured runtime cost estimate for initial/final prefix scheduling. If complete selected work cannot fit, return partial/loading and honest coverage, not complete no-answer.',
    developerCollection: 'Fixed pair ledger may be collected in bounded research batches; offline complete quality never constitutes production500ms proof.',
    guards: 'Revalidate scope/source/privacy/cancel before text writes, after every await including erase, after inference, before cache/projection. Guard errors preserve original identity and stop owned work.',
    caches: 'If later enabled, bounded memory only keyed by query+scope+full field/window revision+model/runtime/template/policy FP; no dataset-vector prefill and recheck source authority on reuse.',
    resources: 'Report encoder+verifier total residency and process peaks, cold preparation/loading and warm end-to-end p95 separately. Standalone667MiB is not dual-model residency.' },
  eventualConsumers: { studyScope: 'This pair plan studies the retrieval developer corpus only; it does not qualify every product entry point.',
    independentPaths: ['13ap session/source search', '10 observation tool snapshots', '10 committed-message semantic recall', '06hc explicit memory discovery'],
    qualification: 'A future shared scalar-verifier bridge needs separate actual-source/auth/privacy/partial tests at every independent consumer. Wiring only 13ap cannot establish coverage for observation or memory.',
    automaticMemory: 'Unchanged baseline membership only; automatic:null remains and no new automatic injection candidate is authorized.',
    designReference: 'output/semantic-scalar-consumer-design-r1.json (root/Terra design only, no production adoption)' },
  status: 'PROPOSED_DEVELOPMENT_ONLY_NO_MODEL_RUN',
};
module.exports = Object.freeze(protocol);
if (require.main === module) {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const output = path.resolve(process.argv[2] || 'output/semantic-qwen-reranker-official-v1/calibration-protocol-v1.json');
  fs.writeFileSync(output, JSON.stringify({ ...protocol, protocolSourceSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex') }, null, 2) + '\n', { flag: 'wx' });
  console.log(output);
}
