'use strict';
// Opt-in consumer experiment, separate from all frozen production bytes.
// The index owns per-field scalar proofs; unknown metadata may not be promoted
// by the historical weak-lexical supplement in scalar-enabled research mode.
const crypto = require('node:crypto'), fs = require('node:fs');
const ORIGINAL_SHA = '67deb8fbb314749ae2befdd3cc7660661a55f930d13ff4a72889a63c5a73f889';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function transform(source) {
  if (hash(source) !== ORIGINAL_SHA) throw Error('Research consumer source changed.');
  const before = "if(!decisions.some(value=>value===true))lexicalPartial=true;";
  const after = "if(!decisions.some(value=>value===true)){lexicalPartial=true;if(found.scalarResearch)continue;}";
  if (source.split(before).length !== 2) throw Error('Metadata supplement boundary changed.');
  source = source.replace(before, after);
  return { source, originalSha256: ORIGINAL_SHA, transformedSha256: hash(source), transformerSha256: hash(fs.readFileSync(__filename)), recipe: [{ before, after }],
    contract: { enable: 'Only a derived index result with scalarResearch enables the fail-closed branch.',
      globalK: 'metadataEntries enter the same single index.search global candidate pool as body fragments; metadata supplement never runs its own coarse ranking.',
      coldRetry: 'If source preparation causes a second index.search in searchOnce, that complete result replaces the former partial result; candidate winners are never unioned across searches.',
      source: 'metadataAdmission consumes the exact sid+field proof from this result; another message/title/session verdict is never substituted.',
      disabled: 'Without scalarResearch, the original ordinary lexical behavior remains unchanged.' } };
}
module.exports = { transform, ORIGINAL_SHA };
