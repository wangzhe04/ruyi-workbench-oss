'use strict';
// Opt-in representation-cache experiment atop the exact reviewed window recipe.
// Authorization, source proofs, citations, and metadata/attachment keys remain
// unchanged. This changes only the identities passed to the vector cache.
const fs = require('node:fs'), crypto = require('node:crypto');
const basePath = require.resolve('./scalar-window-producer-research-source.cjs');
const BASE_SHA = '362a092733a2027a3fecc8e4ce821c569d21a30ca9138f74ff2aa32b3c2e757d';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function transform(original) {
  if (hash(fs.readFileSync(basePath)) !== BASE_SHA) throw Error('append_cache.window_recipe_changed');
  const prior = require(basePath).transform(original);
  const before = 'identities:semanticRows.map(row=>row.identity)';
  const after = "identities:semanticRows.map(row=>row.metadata||row.hit.row.source.startsWith('attachments.')?row.identity:['raw-source-v1','search',NORMALIZER,row.hit.row.sessionId,row.hit.row.messageId,row.hit.row.messageIdBasis,row.hit.row.messageOrdinal,row.hit.row.contentRevision,row.hit.row.source,row.hit.canonicalStart,row.hit.at,row.hit.start,row.hit.end,row.hit.windowHash])";
  if (prior.source.split(before).length !== 2) throw Error('append_cache.transform_boundary_changed');
  const source = prior.source.replace(before, after);
  return { ...prior, source, transformedSha256: hash(source), transformerSha256: hash(fs.readFileSync(__filename)),
    appendCacheRecipe: { before, after, baseTransformerSha256: BASE_SHA,
      scope: 'Only message vector cache identity; metadata and all attachment fields retain full prior identity.',
      authority: 'Epoch, source revision, generation, source proof, policy and citation checks remain unchanged.' } };
}
module.exports = { transform, BASE_SHA };
