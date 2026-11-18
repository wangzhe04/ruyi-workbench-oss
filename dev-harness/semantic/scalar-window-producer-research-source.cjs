'use strict';
// Exact prior producer plus fixed best-window evidence routing. Full-field
// contracts/receipts remain intact for audit and regression comparison.
const fs = require('node:fs'), crypto = require('node:crypto');
const priorPath = require.resolve('./scalar-producer-research-source.cjs'), PRIOR_SHA = '6b93fd3e4fba2dd816c56b55b0bb50915d24c6f67371cb8db45744cc33c6bec1';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function transform(original) {
  if (hash(fs.readFileSync(priorPath)) !== PRIOR_SHA) throw Error('Window producer base recipe changed.');
  const prior = require(priorPath).transform(original); let source = prior.source; const recipe = [...prior.recipe];
  const one = (before, after) => { if (source.split(before).length !== 2) throw Error('Window producer transform boundary changed: ' + before.slice(0, 60)); source = source.replace(before, after); recipe.push({ before, after }); };
  one("!text.length||text.length>8192)return null;", "!text.length||!wholeField&&text.length>8192)return null;");
  one('semanticState={...semanticState,admission:{policyId:scalarComposite.contract.id', `for(let n=0;n<candidates.length;n++){const prior=candidates[n],key=sourceKeyOf(prior.row),chosen=scalarDecision.lexicalWindowIndices?.get(key);if(chosen===undefined)continue;
            const entry=semanticRows[chosen];if(!Number.isSafeInteger(chosen)||!entry||entry.metadata||sourceKeyOf(entry.hit.row)!==key||scalarDecision.lexical.get(key)!==true)throw fail('scalar_window_binding');
            candidates[n]={...entry.hit,score:prior.score,entity:false,edge:false,exact:false,verifiedWindow:true};}
          semanticState={...semanticState,admission:{policyId:scalarComposite.contract.id`);
  one('if(decision!==true){if(decision!==false)lexicalPartial=true;continue;}', 'if(decision!==true){if(decision!==false)lexicalPartial=true;if(hit.semanticRank!==undefined){delete hit.lexicalRank;hit.lexical=false;}else continue;}');
  one("...(hit.entity?{matchKind:'lexical-entity'}:{})", "...(hit.entity?{matchKind:'lexical-entity'}:hit.verifiedWindow?{matchKind:'verified-window'}:{})");
  one(":{matchKind:'semantic'}),snippetStart:", ":{matchKind:'semantic',matchStart:hit.start,matchEnd:hit.end}),snippetStart:");
  return { source, originalSha256: prior.originalSha256, priorRecipeSha256: PRIOR_SHA, transformedSha256: hash(source), transformerSha256: hash(fs.readFileSync(__filename)), recipe,
    contract: { weakBody: 'Best raw96/16 original window per fully scored eligible field before scalar; admitted window replaces old lexical position, preserves lexical RRF route only.',
      independentSemantic: 'Unknown/rejected weak contribution is removed without suppressing a separately admitted semantic window; final reciprocal ranks are recomputed.',
      largeField: 'Entire raw field may be read under source authority for strong/ID classification, but only selected bounded original window is sent to verifier; no arbitrary clipping.' } };
}
module.exports = { transform };
