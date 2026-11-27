'use strict';
// node admission-replay.cjs scores.json[.gz] report.json
// The input contains every candidate-window cosine, field ids, query labels and reference-set cosines.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const zlib = require('node:zlib');

function median(values) {
  const ordered = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function prepare(pool) {
  assert.ok(pool.windows.length > 0 && pool.windows.every(id => typeof id === 'string' && id));
  return pool.queries.map(query => {
    assert.equal(query.scores.length, pool.windows.length);
    assert.ok(query.scores.every(Number.isFinite));
    assert.ok(query.referenceScores.length > 0 && query.referenceScores.every(Number.isFinite));
    const maxima = new Map();
    query.scores.forEach((score, i) => {
      const id = pool.windows[i];
      maxima.set(id, Math.max(maxima.get(id) ?? -Infinity, score));
    });
    const relevant = new Set(query.relevant);
    assert.ok(query.kind !== 'positive' || relevant.size && [...relevant].every(id => maxima.has(id)));
    const sorted = [...maxima].sort((a, b) => b[1] - a[1]);
    const scores = sorted.map(([, score]) => score);
    const center = median(scores);
    const scale = 1.4826 * median(scores.map(score => Math.abs(score - center)));
    const reference = query.referenceScores.reduce((sum, score) => sum + score, 0) / query.referenceScores.length;
    return { group: query.group, positive: query.kind === 'positive', kind: query.kind,
      rows: sorted.map(([id, score]) => ({
        relevant: relevant.has(id), score, excess: score - reference,
        // A flat background gives no variance estimate. Avoid accepting tiny deviations as infinite evidence.
        z: scale > 0 ? (score - center) / scale : 0,
      })),
    };
  });
}

function candidates() {
  const list = [0.70, 0.65, 0.75].map(floor => ({ name: 'absolute', floor }));
  for (const floor of [0.55, 0.60, 0.65]) {
    for (const z of [2, 3, 4]) list.push({ name: 'pool', floor, z });
    for (const delta of [0.05, 0.10, 0.15]) {
      list.push({ name: 'reference', floor, delta });
      for (const z of [2, 3, 4]) list.push({ name: 'both', floor, z, delta });
    }
  }
  return list;
}
function ratio(n, d) { return d ? Number((n / d).toFixed(5)) : null; }

function evaluate(queries, rule) {
  let positives = 0, hits1 = 0, hits5 = 0, reciprocalRank = 0, falsePositives = 0;
  for (const query of queries) {
    const top = query.rows.filter(r => r.score >= rule.floor &&
      (rule.z === undefined || r.z >= rule.z) && (rule.delta === undefined || r.excess >= rule.delta)).slice(0, 5);
    if (query.positive) {
      positives++;
      const rank = top.findIndex(r => r.relevant) + 1;
      if (rank === 1) hits1++;
      if (rank) { hits5++; reciprocalRank += 1 / rank; }
    } else if (top.length) falsePositives++;
  }
  const negatives = queries.length - positives;
  return { positives, negatives, hits1, hits5, falsePositives, recall1: ratio(hits1, positives),
    recall5: ratio(hits5, positives), mrr5: ratio(reciprocalRank, positives), falsePositiveRate: ratio(falsePositives, negatives) };
}

function replay(matrix) {
  assert.equal(matrix.schema, 1);
  assert.ok(matrix.pools.length > 0);
  const pools = matrix.pools.map(pool => ({ name: pool.name, fields: new Set(pool.windows).size, windows: pool.windows.length,
    queries: prepare(pool) }));
  const scores = candidates().map(rule => {
    const breakdown = pools.map(pool => {
      const groups = [...new Set(pool.queries.map(q => q.group + '/' + q.kind))];
      const byGroup = Object.fromEntries(groups.map(group => [group, evaluate(pool.queries.filter(q => q.group + '/' + q.kind === group), rule)]));
      return { pool: pool.name, fields: pool.fields, windows: pool.windows, ...evaluate(pool.queries, rule), byGroup };
    });
    return { rule, breakdown };
  });
  return { schema: 1, model: matrix.model, fingerprint: matrix.fingerprint, fixtureSha256: matrix.fixtureSha256,
    developmentCorpusSha256: matrix.developmentCorpusSha256, truncatedEncodes: matrix.truncatedEncodes,
    procedure: 'Consumed development data only. Max cosine per field, stable input-field order for ties, top 5 distinct fields after threshold. Relevance counts only on positive labels; a hit for any other kind counts as a false positive including near-topic missing facts. MRR@5 gives misses zero. Pool z=(score-median)/(1.4826*MAD), z=0 for zero MAD. Reference excess uses the arithmetic mean over the fixed anchor set.',
    scores };
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  assert.ok(input && output, 'Usage: admission-replay.cjs scores.json[.gz] report.json');
  const bytes = fs.readFileSync(input);
  const matrix = JSON.parse((input.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('utf8'));
  const report = replay(matrix);
  report.matrixSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const json = JSON.stringify(report, null, 2) + '\n';
  fs.writeFileSync(output, output.endsWith('.gz') ? zlib.gzipSync(json) : json, { flag: 'wx' });
}
module.exports = { replay };
