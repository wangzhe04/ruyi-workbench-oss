'use strict';
// Assemble explicit source copies for the public-consumer/live research runner.
// Original producer, consumer and the prior frozen recipe remain byte-stable.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const producerPath = path.resolve('ruyi-workbench/app/src/13ap-session-fulltext-index.js'), consumerPath = path.resolve('ruyi-workbench/app/src/13as-session-fulltext-consumers.js');
function layout(directory) {
  const prior = require('./scalar-producer-research-source.cjs').transform(fs.readFileSync(producerPath, 'utf8'));
  const consumer = require('./scalar-consumer-live-research-source.cjs').transform(fs.readFileSync(consumerPath, 'utf8'));
  let source = prior.source; const recipe = [...prior.recipe];
  const replace = (before, after) => { if (source.split(before).length !== 2) throw Error('Live source composition boundary changed.'); source = source.replace(before, after); recipe.push({ before, after }); };
  replace('?{semantic:SemanticRetrieval.create(SemanticRuntimeHooks)}:{}),', '?{semantic:SemanticRetrieval.create(SemanticRuntimeHooks),...(typeof ResearchScalarComposite!==\'undefined\'?{scalarComposite:ResearchScalarComposite}:{})}:{}),');
  replace('return Object.freeze({search:instance.search,revalidate:instance.revalidate,', 'return Object.freeze({search:instance.search,researchReport:instance.researchReport,revalidate:instance.revalidate,');
  replace('search:instance.search,researchReport:instance.researchReport,', "search:async(...args)=>{const result=await instance.search(...args);if(typeof ResearchObserveSearch==='function'){const detail=instance.researchReport(result),observed=ResearchObserveSearch(JSON.parse(JSON.stringify(result)),detail);if(observed!==null&&(typeof observed==='object'||typeof observed==='function')&&typeof observed.then==='function')throw Error('research.observer_must_be_sync');}return result;},researchReport:instance.researchReport,");
  fs.mkdirSync(directory, { recursive: true });
  const modulePath = path.join(directory, 'producer-' + hash(source) + '.cjs');
  if (fs.existsSync(modulePath)) { if (hash(fs.readFileSync(modulePath)) !== hash(source)) throw Error('Existing derived producer differs.'); }
  else fs.writeFileSync(modulePath, source, { flag: 'wx' });
  return { modulePath, producer: { originalSha256: prior.originalSha256, priorTransformerSha256: prior.transformerSha256, transformedSha256: hash(source), recipe }, consumer,
    layoutScriptSha256: hash(fs.readFileSync(__filename)) };
}
module.exports = { layout };
