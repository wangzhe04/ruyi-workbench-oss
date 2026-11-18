'use strict';
// New same-field projection variant. Preserve the prior frozen research recipe
// and the original production67de bytes; only this opt-in source is extended.
const fs = require('node:fs'), crypto = require('node:crypto');
const priorPath = require.resolve('./scalar-consumer-research-source.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const PRIOR_SHA = '89b1347434c03827cabddf16664f828f49748a7e931fcf1f26cbae0b9b0d4732';
function transform(original) {
  if (hash(fs.readFileSync(priorPath)) !== PRIOR_SHA) throw Error('Prior consumer research recipe changed.');
  const prior = require(priorPath).transform(original); let source = prior.source;
  const before = "excerpt=requiredIds.length?safeFields.find(field=>{const ids=identify(field);return requiredIds.every(id=>ids.includes(id));}):safe.summary||safe.title||'';if(requiredIds.length&&!excerpt)continue;";
  const after = "excerpt=requiredIds.length?safeFields.find(field=>{const ids=identify(field);return requiredIds.every(id=>ids.includes(id));}):safe.summary||safe.title||'';if(found.scalarResearch){const approved=fieldsOf(meta).filter(([field,value])=>{const ids=identify(value),normalized=value.normalize('NFKC').toLowerCase();if(requiredIds.some(id=>!ids.includes(id)))return false;return requiredIds.length>0||normalized.includes(phrase)||(terms.length>0&&terms.every(term=>normalized.includes(term)))||index.metadataAdmission(proofResult,meta.id,field,token)===true;}).map(([field])=>field);const selectedField=approved.map(field=>fieldsOf(safe).find(([name])=>name===field)).find(Boolean);if(!selectedField){lexicalPartial=true;continue;}excerpt=selectedField[1];}if(requiredIds.length&&!excerpt)continue;";
  if (source.split(before).length !== 2) throw Error('Metadata excerpt source boundary changed.');
  // The existing const declaration must permit replacing only its local
  // excerpt value; no caller object, trusted metadata or public safe DTO mutates.
  const declaration = "const safe=await publicMetadata(meta.id),safeFields=[safe.title,safe.summary,safe.brief?.title,safe.brief?.gist,safe.cwd].filter(Boolean),excerpt=";
  const mutable = "const safe=await publicMetadata(meta.id),safeFields=[safe.title,safe.summary,safe.brief?.title,safe.brief?.gist,safe.cwd].filter(Boolean);let excerpt=";
  if (source.split(declaration).length !== 2) throw Error('Metadata excerpt declaration changed.');
  source = source.replace(declaration, mutable).replace(before, after);
  return { source, originalSha256: prior.originalSha256, priorRecipeSha256: PRIOR_SHA, transformedSha256: hash(source), transformerSha256: hash(fs.readFileSync(__filename)),
    recipe: [...prior.recipe, { before: declaration, after: mutable }, { before, after }],
    contract: { ...prior.contract, projectedSnippet: 'Choose the first admitted raw field by fixed fieldsOf order, then the projected value of exactly that field name. Never substitute summary/title/sibling. If projection removes all admitted fields, withhold and mark partial.',
      strong: 'Same original field exact phrase/all effective terms/all full IDs; weak fields require metadataAdmission===true.',
      private: 'Field admission proof remains in the index WeakMap; no identity/digest/source field proof is added to public UI/model DTOs.' } };
}
module.exports = { transform };
