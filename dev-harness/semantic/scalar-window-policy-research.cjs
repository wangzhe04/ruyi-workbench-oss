'use strict';
// Explicit window-v2 execution contract. Preserve the prior full-field study
// verbatim; this source-pinned variant changes no K/threshold/model parameter.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), Module = require('node:module');
const basePath = path.join(__dirname, 'scalar-composite-policy-research.cjs'), baseSha256 = 'cd7b52943b834269e989b084cef23a486d605390a7c09589fd0a27a718e4bf6c';
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
let source = fs.readFileSync(basePath, 'utf8'); if (hash(source) !== baseSha256) throw Error('Window policy base changed.');
const recipe = [], one = (before, after) => { if (source.split(before).length !== 2) throw Error('Window policy transform boundary changed: ' + before.slice(0, 50)); source = source.replace(before, after); recipe.push({ before, after }); };
one("id: 'qwen-prior-evidence-raw-global-k1-rank095-v1'", "id: 'qwen-prior-evidence-global-k1-rank095-best-field-window-v2'");
one("coarseThreshold: null, strong:", "weakWindow: 'fixed-best-eligible-original96-overlap16-before-scalar; no-result-driven-window-switch', metadataDisplay: 'same-field-complete-projected-context-not-raw-window-quote', coarseThreshold: null, strong:");
one('lexicalDecisions = new Map(), metadataDecisions = new Map();', 'lexicalDecisions = new Map(), metadataDecisions = new Map(), lexicalWindowIndices = new Map(), metadataWindowIndices = new Map();');
one('const source = await resolved(index, wholeField);', 'let source = await resolved(index, wholeField);');
one('      const key = hash([source.identity, source.text]);', `      if (role === 'weak-lexical' || role === 'metadata') {
        const choice = order.find(item => rows[item.index].fieldKey === rows[index].fieldKey);
        if (!choice) { sourceUnknown = true; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, null); return; }
        const previous = source; index = choice.index; source = await resolved(index, false);
        if (!source) { sourceUnknown = true; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, null); return; }
        if (['sourceId','field','revision','epoch','sourceRevision'].some(key => source.identity[key] !== previous.identity[key])) throw Error('composite.window_source_changed');
      }
      const key = hash([source.identity, source.text]);`);
one('if (use.lexicalKey !== null) lexicalDecisions.set(use.lexicalKey, result.accepted);', 'if (use.lexicalKey !== null) { lexicalDecisions.set(use.lexicalKey, result.accepted); if (result.accepted === true) lexicalWindowIndices.set(use.lexicalKey, use.index); }');
one('if (use.metadataKey !== null) metadataDecisions.set(use.metadataKey, result.accepted);', 'if (use.metadataKey !== null) { metadataDecisions.set(use.metadataKey, result.accepted); if (result.accepted === true) metadataWindowIndices.set(use.metadataKey, use.index); }');
one('return { accepted, lexical: lexicalDecisions, metadata: metadataDecisions, complete: finished,', 'return { accepted, lexical: lexicalDecisions, metadata: metadataDecisions, lexicalWindowIndices, metadataWindowIndices, complete: finished,');
one('scalarPairs: items.length, requiredWork, strongEvidence,', 'scalarPairs: items.length, requiredWork, strongEvidence, weakWindowSelection: \'fixed-best-raw-per-original-field; same-identity-coordinates-dedup\',');
const compiled = new Module(__filename, module); compiled.filename = __filename; compiled.paths = Module._nodeModulePaths(__dirname); compiled._compile(source, __filename);
module.exports = { ...compiled.exports, transformation: Object.freeze({ baseSha256, recipe, transformedCodeSha256: hash(source) }) };
