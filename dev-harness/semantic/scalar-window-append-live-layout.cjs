'use strict';
// Approved append-representation cache delta over the preserved window layout.
// Only the vector cache identity changes, never source proof or disclosure.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const priorPath = require.resolve('./scalar-window-live-layout.cjs'), appendPath = require.resolve('./scalar-window-append-cache-research-source.cjs');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
function layout(directory) {
  if (hash(fs.readFileSync(priorPath)) !== '8fc6233c9e218c8ed335475d9f1f64aaa640891d62770d27fc7bab23609a5078') throw Error('Window-only layout changed.');
  const prior = require(priorPath).layout(directory);
  const append = require(appendPath).transform(fs.readFileSync('ruyi-workbench/app/src/13ap-session-fulltext-index.js', 'utf8'));
  const { before, after } = append.appendCacheRecipe; let source = fs.readFileSync(prior.modulePath, 'utf8');
  if (source.split(before).length !== 2) throw Error('Append live identity boundary changed.'); source = source.replace(before, after);
  const modulePath = path.join(directory, 'producer-' + hash(source) + '.cjs');
  if (fs.existsSync(modulePath)) { if (hash(fs.readFileSync(modulePath)) !== hash(source)) throw Error('Existing append producer differs.'); }
  else fs.writeFileSync(modulePath, source, { flag: 'wx' });
  return { ...prior, modulePath, layoutScriptSha256: hash(fs.readFileSync(__filename)), producer: { ...prior.producer, transformedSha256: hash(source),
    recipe: [...prior.producer.recipe, append.appendCacheRecipe], appendTransformerSha256: hash(fs.readFileSync(appendPath)),
    appendScope: 'Raw message representation cache only; same06ha scope/model/text key; metadata/attachments retain previous key; original source/citation/epoch/PG checks remain.' } };
}
module.exports = { layout };
