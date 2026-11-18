'use strict';
// Candidate policies for development calibration; no final acceptance data is read.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const semanticSource=fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8');
const semanticApi=vm.runInNewContext(semanticSource+'\nSemanticRetrieval;',{require,Buffer,Date,setTimeout,clearTimeout});
function identifiers(text) { return Array.from(semanticApi.structuredIds(text)); }
function assess(query, docs, scores, policy, complete = true) {
  const finite = scores.filter(Number.isFinite).slice().sort((a, b) => b - a);
  const top = finite[0] ?? null, runnerUp = finite[1] ?? null;
  const mean = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : 0;
  const sd = finite.length ? Math.sqrt(finite.reduce((n, score) => n + (score - mean) ** 2, 0) / finite.length) : 0;
  const needsBackground = policy.minGap > 0 || policy.minZ > 0;
  const required = policy.identifiers ? identifiers(query) : [];
  const reasons = [], accepted = scores.map((score, index) => {
    let reason;
    if (!Number.isFinite(score)) reason = 'unscored';
    else if (needsBackground && !complete) reason = 'incomplete-background';
    else if (score < policy.minScore) reason = 'low-cosine';
    else if (policy.minGap > 0 && runnerUp !== null && top - runnerUp < policy.minGap) reason = 'ambiguous-neighbours';
    else if (policy.minZ > 0 && (sd < 1e-12 || (score - mean) / sd < policy.minZ)) reason = 'low-specificity';
    else if (required.length && required.some(id => !identifiers(docs[index]).includes(id))) reason = 'identifier-mismatch';
    else reason = 'accepted';
    reasons.push(reason); return ['unscored', 'incomplete-background'].includes(reason) ? null : reason === 'accepted';
  });
  return { policyId: policy.id, purpose: 'search-relevance', status: complete ? 'evaluated' : 'partial', accepted, reasons,
    features: { topScore: top, runnerUpScore: runnerUp, gap: top !== null && runnerUp !== null ? top - runnerUp : null, mean, sd, requiredIdentifiers: required.length } };
}
function metrics(fixture, matrix, policy, split, options = {}) {
  const rows = fixture.queries.filter(query => !split || query.split === split).map(query => {
    const scores = matrix[query.id], admission = options.admit ? options.admit(query, scores, policy) : assess(query.text, fixture.documents.map(doc => doc.text), scores, policy);
    const top = fixture.documents.map((doc, i) => ({ id: doc.id, score: scores[i], admitted: admission.accepted[i] })).filter(row => row.admitted).sort((a, b) => b.score - a.score).slice(0, 5);
    const rank = top.findIndex(row => query.relevant.includes(row.id)) + 1;
    return { id: query.id, group: query.group, kind: query.kind, answerSupported: query.answerSupported, rank, count: top.length, top, admission };
  });
  const positive = rows.filter(row => row.kind === 'positive');
  const quality = group => { const values = positive.filter(row => !group || row.group === group); return { count: values.length, recallAt5: values.length ? values.filter(row => row.rank > 0).length / values.length : null, mrr: values.length ? values.reduce((n, row) => n + (row.rank ? 1 / row.rank : 0), 0) / values.length : null }; };
  const rate = kinds => { const values = rows.filter(row => kinds.includes(row.kind)); return { count: values.length, admittedQueries: values.filter(row => row.count > 0).length, rate: values.length ? values.filter(row => row.count > 0).length / values.length : null }; };
  return { policy, split: split || 'all', quality: { all: quality(), groups: Object.fromEntries([...new Set(positive.map(row => row.group))].map(group => [group, quality(group)])) },
    searchNegativeAdmission: rate(['ood', 'entity-mismatch']), oodAdmission: rate(['ood']), entityMismatchAdmission: rate(['entity-mismatch']),
    unsupportedAnswerDiagnostic: rate(['missing-field', 'missing-number']), allNoAnswerAdmission: rate(['ood', 'entity-mismatch', 'missing-field', 'missing-number']), rows };
}
function qualityPasses(report) {
  const group = name => report.quality.groups[name]?.recallAt5;
  return group('zh-zh') >= .9 && group('zh-en') >= .85 && group('en-zh') >= .85 && report.quality.all.mrr >= .75;
}
function passes(report) { return qualityPasses(report) && report.searchNegativeAdmission.rate <= .05; }
function candidates(minimum = 22, maximum = 80) {
  const policies = [];
  for (let value = minimum; value <= maximum; value += 2) for (const minGap of [0, .02, .05]) for (const minZ of [0, 1.5, 2]) for (const useIdentifiers of [false, true]) {
    const minScore = value / 100;
    policies.push({ id: `development-c${value}-g${minGap}-z${minZ}-i${Number(useIdentifiers)}`, minScore, minGap, minZ, identifiers: useIdentifiers });
  }
  return policies;
}
module.exports = { identifiers, assess, metrics, passes, qualityPasses, candidates };
