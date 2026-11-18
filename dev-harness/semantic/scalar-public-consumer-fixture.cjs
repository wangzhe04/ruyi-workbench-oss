'use strict';
// Reuse the full actual consumer/privacy/source fixture. Its sole code change
// is selecting an explicit derived consumer source for draft(13as), auditable
// below. No production fixture/helper or real configuration is modified.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), Module = require('node:module'), crypto = require('node:crypto');
const { layout } = require('./scalar-live-research-layout.cjs');
const { createScalarVerifierBridge } = require('./scalar-verifier-bridge-prototype.cjs');
const { createCompositePolicy } = require('./scalar-composite-policy-research.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(options = {}) {
  const sources = layout(path.resolve(options.researchDirectory || 'output/semantic-scalar-public-consumer-fixtures'));
  const helperPath = require.resolve('../lib/fulltext-consumer-fixture.js'), helper = fs.readFileSync(helperPath, 'utf8');
  const before = ',draft=actual;', after = ',draft=name=>name===\'13as-session-fulltext-consumers.js\'?' + JSON.stringify(sources.consumer.source) + ':actual(name);';
  if (helper.split(before).length !== 2) throw Error('Consumer fixture draft selector changed.');
  const compiled = new Module(helperPath, module); compiled.filename = helperPath; compiled.paths = Module._nodeModulePaths(path.dirname(helperPath));
  const projectionBefore = ':actualPrivacy,config=';
  const projectionAfter = ':options.observeMetadataProjection?{...actualPrivacy,prepareLocalDisclosure:async(...args)=>{const value=await actualPrivacy.prepareLocalDisclosure(...args);await options.observeMetadataProjection();return value;}}:actualPrivacy,config=';
  if (helper.split(projectionBefore).length !== 2) throw Error('Consumer privacy fixture boundary changed.');
  compiled._compile(helper.replace(before, after).replace(projectionBefore, projectionAfter), helperPath);
  const f = await compiled.exports.fixture({ ...options, module: sources.modulePath });
  const primitive = vm.runInNewContext(fs.readFileSync('ruyi-workbench/app/src/06ha-semantic-retrieval.js', 'utf8') + '\nSemanticRetrieval;', { require, Buffer, Date, setTimeout, clearTimeout });
  f.context.SemanticRetrieval = primitive;
  if (options.observeSearch) f.context.ResearchObserveSearch = options.observeSearch;
  if (options.runtime) f.context.SemanticRuntimeHooks = options.runtime;
  let bridge = null;
  if (options.scalarHost) {
    bridge = createScalarVerifierBridge(options.scalarHost);
    const text = fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js', 'utf8');
    const normalize = vm.runInNewContext(text.match(/^  const canonicalText=.*;$/m)[0] + '\n' + text.match(/^  const normalize=.*;$/m)[0] + '\nnormalize;');
    f.context.ResearchScalarComposite = createCompositePolicy({ bridge, identify: primitive.structuredIds, normalize, terms: f.api.terms });
  }
  return { ...f, sources, bridge, fixtureRecipe: { helperPath, helperSha256: hash(helper), before, afterSha256: hash(after), projectionBefore, projectionAfter,
    purpose: 'Select derived13as source; optional test-only observer after actual metadata privacy projection. Preserve actual source/store/authority/privacy/UI/model code.' } };
}
module.exports = { fixture };
