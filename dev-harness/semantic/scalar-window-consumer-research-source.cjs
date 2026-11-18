'use strict';
const fs = require('node:fs'), crypto = require('node:crypto');
const priorPath = require.resolve('./scalar-consumer-live-research-source.cjs'), PRIOR_SHA = '71042659f1ae624a7b5c19d0895669e01ff223c93d5f0f3055f6cbee4ff778c7';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function transform(original) {
  if (hash(fs.readFileSync(priorPath)) !== PRIOR_SHA) throw Error('Window consumer base recipe changed.');
  const prior = require(priorPath).transform(original), before = 'reference:null});', after = "reference:null,...(found.scalarResearch?{matchKind:'metadata-context'}:{})});";
  if (prior.source.split(before).length !== 2) throw Error('Metadata context DTO boundary changed.');
  const source = prior.source.replace(before, after);
  return { ...prior, source, transformedSha256: hash(source), priorRecipeSha256: PRIOR_SHA, transformerSha256: hash(fs.readFileSync(__filename)), recipe: [...prior.recipe, { before, after }],
    contract: { ...prior.contract, weakAdmission: 'Fixed best original window for this field; no scalar-driven alternate-window search.',
      display: 'Complete same admitted field after full-field privacy projection/redaction. Metadata-context only, reference:null, not a96-window quote; no raw-coordinate slicing of safe.*.',
      caps: 'Existing metadata raw field8192 input cap/visibility checks remain.13as does not server-truncate selected projected metadata context;13g/13k no-ref DTO still emits no snippet.' } };
}
module.exports = { transform };
