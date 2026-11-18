'use strict';
// Unregistered research policy. Raw coarse rank is global to one complete
// producer search, while every scalar verdict remains bound to its own field.
const crypto = require('node:crypto'),Windowing=require('./semantic-original-windows-candidate.cjs');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CONTRACT = Object.freeze({ id: 'embeddinggemma2-global-eligible-k1-cos070-window-v1',modelId:'embeddinggemma-2-text-q4',modelFingerprint:'sha256:9d41595d7508ff328b6c5a4223c7af26a91ed2fe53662cc9d633c1373eb4163e', topK: 1, threshold: .70, scoreKind:'cosine-not-probability', verifier:null,
  weakWindow: 'fixed-best-eligible-original96-overlap16-before-cosine-admission; no-result-driven-window-switch', metadataDisplay: 'same-field-complete-projected-context-not-raw-window-quote', coarseThreshold: null, strong: 'same-original-field-only', unknown: 'not-promoted-and-partial', automatic: null });

function createSemanticCoarsePolicy({ identify, normalize, terms }) {
  const issuedDecisions = new WeakMap();
  if ([identify, normalize, terms].some(value => typeof value !== 'function')) throw TypeError('composite.host_invalid');
  async function evaluate({ query, rows, lexical, scores, poolComplete, context, windowContext, modelFingerprint, scopeId, signal, deadline, resolve, beforeVerify }) {
    if (!Array.isArray(rows) || !Array.isArray(lexical) || !Array.isArray(scores) || rows.length !== scores.length
      || typeof poolComplete !== 'boolean' || !Windowing.isRequest(windowContext,context) || modelFingerprint!==CONTRACT.modelFingerprint || rows.length > 4096 || rows.some(row=>typeof row.fieldKey!=='string'||typeof row.order!=='string') || typeof resolve !== 'function' || typeof beforeVerify !== 'function' || !Number.isFinite(deadline)) throw TypeError('composite.request_invalid');
    const accepted = rows.map(() => null), lexicalDecisions = new Map(), metadataDecisions = new Map(), lexicalWindowIndices = new Map(), metadataWindowIndices = new Map();
    const abort=()=>{if(signal?.aborted)throw signal.reason===undefined?Object.assign(Error('semantic.policy_aborted'),{code:'ABORT_ERR'}):signal.reason;};
    const verify=async event=>{abort();await beforeVerify(event);abort();};
    await verify({phase:'start',index:null,source:null});
    windowContext.begin(context,query,scopeId,modelFingerprint,rows);
    const required = identify(query), phrase = normalize(query), effective = [...new Set(terms(query).filter(x => typeof x === 'string' && !x.startsWith('#')).map(normalize))];
    const strong = text => {
      const sourceIds = identify(text);
      if (required.some(id => !sourceIds.includes(id))) return { eligible: false, reason: 'identifier-mismatch' };
      const normalized = normalize(text);
      return { eligible: true, reason: required.length ? 'all-identifiers-same-field' : normalized.includes(phrase) ? 'exact-phrase-same-field'
        : effective.length && effective.every(term => normalized.includes(term)) ? 'all-effective-terms-same-field' : null };
    };
    const fullSources = new Map(), fieldSources = new Map(), eligible = rows.map(() => true);
    let sourceUnknown = false;
    async function resolved(index, wholeField) {
      abort();
      if (Date.now() >= deadline) { sourceUnknown = true; return null; }
      const source = wholeField && fullSources.has(index) ? fullSources.get(index) : await resolve(index, wholeField);
      await verify({ phase: 'resolved', index, source });
      if(source)windowContext.assertSource(source,wholeField,context,rows[index]);
      if (wholeField && source) fullSources.set(index, source);
      return source;
    }
    // Body rows retain the producer's full-ID source filter. Metadata has a
    // separate field lifecycle, so prove all remaining field eligibility before
    // cutting global K. A rejected metadata ID may never consume the K slot.
    if (required.length) for (let index = 0; index < rows.length; index++) {
      let source = fieldSources.get(rows[index].fieldKey);
      if (!source) { source = await resolved(index, true); if (source) fieldSources.set(rows[index].fieldKey, source); }
      if (!source) { eligible[index] = null; sourceUnknown = true; }
      else { fullSources.set(index, source); eligible[index] = required.every(id => identify(source.fieldText).includes(id)); }
    }
    // A partially encoded or truncated eligible corpus cannot establish a
    // global winner. Deterministically excluded IDs need no vector or score.
    const globalComplete = poolComplete === true && !sourceUnknown && scores.every((score, index) => eligible[index] === false || Number.isFinite(score));
    for(let i=0;i<eligible.length;i++)if(eligible[i]===false)accepted[i]=false;
    if(globalComplete)accepted.fill(false);
    const order = globalComplete ? scores.map((score, index) => ({ score, index })).filter(item => eligible[item.index] === true)
      .sort((a, b) => b.score - a.score || rows[a.index].order.localeCompare(rows[b.index].order) || a.index - b.index) : [];
    const selected = order.slice(0, CONTRACT.topK).map(item => item.index), work = new Map(), requiredWork = [], strongEvidence = [];
    async function evidence(index, wholeField, role, lexicalKey = null) {
      let source = await resolved(index, wholeField);
      if (!source) { sourceUnknown = true;if(role==='semantic')accepted[index]=null; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); if(rows[index].metadata)metadataDecisions.set(rows[index].fieldKey,null); return; }
      const classification = strong(source.fieldText);
      if (!classification.eligible) { if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, false); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, false); return; }
      if (classification.reason) {
        // The frozen policy removes strong fields after choosing K. Keep their
        // lexical evidence, without adding semantic RRF weight or refilling K.
        if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, true);
        if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, true);
        strongEvidence.push({ index, role, fieldKey: rows[index].fieldKey, reason: classification.reason }); return;
      }
      if (role === 'weak-lexical' || role === 'metadata') {
        const choice = order.find(item => rows[item.index].fieldKey === rows[index].fieldKey);
        if (!choice) { sourceUnknown = true; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, null); return; }
        const previous = source; index = choice.index; source = await resolved(index, false);
        if (!source) { sourceUnknown = true; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, null); return; }
        if (['sourceId','field','revision','epoch','sourceRevision'].some(key => source.identity[key] !== previous.identity[key])) throw Error('composite.window_source_changed');
      }
      const key = hash([source.identity, source.text]);
      // The actual producer may run in a fixture VM. Copy its trusted data-only
      // identity into this realm; bridge validation still rejects non-data DTOs.
      if (!work.has(key)) work.set(key, { source: { identity: JSON.parse(JSON.stringify(source.identity)), text: source.text }, uses: [] });
      work.get(key).uses.push({ index, role, lexicalKey, metadataKey: rows[index].metadata ? rows[index].fieldKey : null });
    }
    // Select K before strong bypass. Never refill the K budget after bypass.
    for (const index of selected) await evidence(index, false, 'semantic');
    for (const item of lexical) {
      if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= rows.length) { lexicalDecisions.set(item.key, null); sourceUnknown = true; continue; }
      windowContext.assertWeak(item.key,rows[item.index]);
      if (!lexicalDecisions.has(item.key)) await evidence(item.index, true, 'weak-lexical', item.key);
    }
    // Metadata supplement is a distinct same-field consumer, never a session
    // exemption. All supplied metadata fields need an explicit verdict.
    const seenMetadata = new Set();
    for (let index = 0; index < rows.length; index++) if (rows[index].metadata && !seenMetadata.has(rows[index].fieldKey)) {
      seenMetadata.add(rows[index].fieldKey); await evidence(index, true, 'metadata');
    }
    const items = [...work.values()];
    for (const item of items) for (const use of item.uses) requiredWork.push({ index: use.index, role: use.role, identity: item.source.identity });
    // Each exact admitted window consumes its own already-computed cosine.
    // No extra inference and no independent window search after a rejection.
    const results=items.map(item=>{const values=item.uses.map(use=>scores[use.index]);
      if(values.some(value=>!Number.isFinite(value)))return {accepted:null,score:null,cached:false};
      if(values.some(value=>value < -1.00001||value > 1.00001||Math.abs(value-values[0])>1e-12))throw Error('bge.window_score_mismatch');
      return {accepted:values[0]>=CONTRACT.threshold,score:values[0],cached:false};});
    const verified={status:results.every(result=>result.accepted!==null)?'complete':'partial',results,
      coverage:{complete:results.every(result=>result.accepted!==null),total:items.length,completed:results.filter(result=>result.accepted!==null).length}};
    if (!Array.isArray(verified.results) || verified.results.length !== items.length) throw Error('composite.verifier_shape');
    for (let n = 0; n < items.length; n++) {
      const result = verified.results[n];
      if (![true, false, null].includes(result.accepted)) throw Error('composite.verdict_invalid');
      // The host's accepted value must implement this precise frozen policy.
      if (result.accepted !== null && (typeof result.score !== 'number' || !Number.isFinite(result.score) || result.accepted !== (result.score >= CONTRACT.threshold))) throw Error('composite.policy_mismatch');
      for (const use of items[n].uses) {
        if (use.role === 'semantic') accepted[use.index] = result.accepted;
        if (use.lexicalKey !== null) { lexicalDecisions.set(use.lexicalKey, result.accepted); if (result.accepted === true) lexicalWindowIndices.set(use.lexicalKey, use.index); }
        if (use.metadataKey !== null) { metadataDecisions.set(use.metadataKey, result.accepted); if (result.accepted === true) metadataWindowIndices.set(use.metadataKey, use.index); }
      }
    }
    await verify({ phase: 'finish', index: null, source: null });
    const finished = globalComplete && !sourceUnknown && verified.coverage?.complete === true && Date.now() < deadline;
    const decision=Object.freeze({policyId:CONTRACT.id,purpose:'search-relevance',answerability:'not-assessed',complete:finished,status:finished?'evaluated':'partial',
      counts:Object.freeze({candidates:rows.length,eligible:eligible.filter(x=>x===true).length,excludedIdentifiers:eligible.filter(x=>x===false).length,selected:selected.length,weakWindows:lexicalWindowIndices.size,metadataWindows:metadataWindowIndices.size})});
    issuedDecisions.set(decision,{context,semanticAccepted:accepted.slice(),weakAccepted:new Map(lexicalDecisions),metadataAccepted:new Map(metadataDecisions),
      weakWindowIndices:new Map(lexicalWindowIndices),metadataWindowIndices:new Map(metadataWindowIndices),globalSelectedIndices:selected.slice(),globalCoarseComplete:globalComplete});
    return decision;
  }
  const lookup=(decision,context)=>{const stored=issuedDecisions.get(decision);if(!stored||stored.context!==context)throw Error('semantic.policy_context_invalid');return stored;};
  return Object.freeze({ evaluate,contract:CONTRACT,dispose:(decision,context)=>{lookup(decision,context);issuedDecisions.delete(decision);},decisions:(decision,context)=>{const stored=lookup(decision,context);return {semanticAccepted:stored.semanticAccepted.slice(),weakAccepted:new Map(stored.weakAccepted),metadataAccepted:new Map(stored.metadataAccepted),weakWindowIndices:new Map(stored.weakWindowIndices),metadataWindowIndices:new Map(stored.metadataWindowIndices),globalSelectedIndices:stored.globalSelectedIndices.slice(),globalCoarseComplete:stored.globalCoarseComplete};} });
}
module.exports = { createSemanticCoarsePolicy, CONTRACT };
