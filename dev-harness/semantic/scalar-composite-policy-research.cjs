'use strict';
// Unregistered research policy. Raw coarse rank is global to one complete
// producer search, while every scalar verdict remains bound to its own field.
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CONTRACT = Object.freeze({ id: 'qwen-prior-evidence-raw-global-k1-rank095-v1', topK: 1, threshold: .95,
  coarseThreshold: null, strong: 'same-original-field-only', unknown: 'not-promoted-and-partial', automatic: null });

function createCompositePolicy({ bridge, identify, normalize, terms }) {
  if (typeof bridge?.verify !== 'function' || [identify, normalize, terms].some(value => typeof value !== 'function')) throw TypeError('composite.host_invalid');
  async function evaluate({ query, rows, lexical, scores, complete, scopeId, signal, deadline, resolve, beforeVerify }) {
    if (!Array.isArray(rows) || !Array.isArray(lexical) || !Array.isArray(scores) || rows.length !== scores.length
      || typeof resolve !== 'function' || typeof beforeVerify !== 'function' || !Number.isFinite(deadline)) throw TypeError('composite.request_invalid');
    const accepted = rows.map(() => false), lexicalDecisions = new Map(), metadataDecisions = new Map();
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
      if (Date.now() >= deadline) { sourceUnknown = true; return null; }
      const source = wholeField && fullSources.has(index) ? fullSources.get(index) : await resolve(index, wholeField);
      await beforeVerify({ phase: 'resolved', index, source });
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
    const globalComplete = complete === true && !sourceUnknown && scores.every((score, index) => eligible[index] === false || Number.isFinite(score));
    const order = globalComplete ? scores.map((score, index) => ({ score, index })).filter(item => eligible[item.index] === true)
      .sort((a, b) => b.score - a.score || rows[a.index].order.localeCompare(rows[b.index].order) || a.index - b.index) : [];
    const selected = order.slice(0, CONTRACT.topK).map(item => item.index), work = new Map(), requiredWork = [], strongEvidence = [];
    async function evidence(index, wholeField, role, lexicalKey = null) {
      const source = await resolved(index, wholeField);
      if (!source) { sourceUnknown = true; if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, null); return; }
      const classification = strong(source.fieldText);
      if (!classification.eligible) { if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, false); if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, false); return; }
      if (classification.reason) {
        // The frozen policy removes strong fields after choosing K. Keep their
        // lexical evidence, without adding semantic RRF weight or refilling K.
        if (lexicalKey !== null) lexicalDecisions.set(lexicalKey, true);
        if (rows[index].metadata) metadataDecisions.set(rows[index].fieldKey, true);
        strongEvidence.push({ index, role, fieldKey: rows[index].fieldKey, reason: classification.reason }); return;
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
    const verified = items.length ? await bridge.verify(query, items.map(item => item.source), { scopeId, signal, deadline,
      beforeVerify: event => beforeVerify({ ...event, source: event.source || null }) }) : { status: 'complete', results: [], coverage: { complete: true, total: 0, completed: 0 } };
    if (!Array.isArray(verified.results) || verified.results.length !== items.length) throw Error('composite.verifier_shape');
    for (let n = 0; n < items.length; n++) {
      const result = verified.results[n];
      if (![true, false, null].includes(result.accepted)) throw Error('composite.verdict_invalid');
      // The host's accepted value must implement this precise frozen policy.
      if (result.accepted !== null && (typeof result.score !== 'number' || !Number.isFinite(result.score) || result.accepted !== (result.score >= CONTRACT.threshold))) throw Error('composite.policy_mismatch');
      for (const use of items[n].uses) {
        if (use.role === 'semantic') accepted[use.index] = result.accepted;
        if (use.lexicalKey !== null) lexicalDecisions.set(use.lexicalKey, result.accepted);
        if (use.metadataKey !== null) metadataDecisions.set(use.metadataKey, result.accepted);
      }
    }
    await beforeVerify({ phase: 'finish', index: null, source: null });
    const finished = globalComplete && !sourceUnknown && verified.coverage?.complete === true && Date.now() < deadline;
    return { accepted, lexical: lexicalDecisions, metadata: metadataDecisions, complete: finished,
      report: { contract: CONTRACT, policyFingerprint: 'sha256:' + hash(CONTRACT), globalCoarseComplete: globalComplete,
        globalSelectedIndices: selected, globalCandidateCount: rows.length, eligibleCandidateCount: eligible.filter(value => value === true).length,
        excludedIdentifierRows: eligible.filter(value => value === false).length, scalarPairs: items.length, requiredWork, strongEvidence,
        verification: { status: verified.status, coverage: verified.coverage, ...(verified.reason ? { reason: verified.reason } : {}) },
        complete: finished, partial: !finished, scores: verified.results.map((result, index) => ({ identity: items[index].source.identity, accepted: result.accepted, score: result.score, cached: result.cached === true })) } };
  }
  return Object.freeze({ evaluate, contract: CONTRACT });
}
module.exports = { createCompositePolicy, CONTRACT };
