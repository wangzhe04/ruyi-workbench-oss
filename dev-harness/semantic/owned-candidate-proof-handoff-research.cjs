'use strict';
// Research-only private authority. The native issuer and source-capture owner must
// be supplied from trusted lexical scope; neither proof nor token is a public DTO.
function create({owner, candidate, sourceRoot, assertAuthoritySync}) {
  if (!owner || !candidate || typeof sourceRoot !== 'string' || !sourceRoot || typeof assertAuthoritySync !== 'function') throw Error('handoff.arguments');
  const tokens = new WeakMap(), consumed = new WeakMap();
  let generation = 0, writers = 0, fenced = false;
  function authority() {
    if (fenced) throw Error('handoff.fenced');
    const result = assertAuthoritySync(owner, candidate, sourceRoot);
    if (result !== true) throw Error('handoff.authority');
  }
  function beginWrite() {
    authority(); generation++; writers++;
    let ended = false;
    return function endWrite({unknown = false} = {}) {
      if (ended) throw Error('handoff.write.finished');
      ended = true; writers--;
      if (unknown) fenced = true;
    };
  }
  // Copy only JSON native receipt data: the issuer owns provenance validation.
  function sealProof(proof) {
    authority();
    if (writers) throw Error('handoff.writers');
    const before = generation;
    if (!proof || typeof proof !== 'object' || !Array.isArray(proof.entries) || !proof.entries.length) throw Error('handoff.proof');
    const json = JSON.stringify(proof);
    const copy = JSON.parse(json);
    authority();
    if (writers || generation !== before) throw Error('handoff.changed');
    const token = Object.freeze(Object.create(null));
    tokens.set(token, {json: JSON.stringify(copy), generation});
    return token;
  }
  // Consumer must call synchronously immediately before issuing the first native
  // command, and carry this exact JSON into both paired native censuses.
  function consume(token, expectedOwner, expectedCandidate, expectedRoot) {
    authority();
    if (writers) throw Error('handoff.writers');
    const state = tokens.get(token);
    if (!state || expectedOwner !== owner || expectedCandidate !== candidate || expectedRoot !== sourceRoot || state.generation !== generation) throw Error('handoff.invalid');
    tokens.delete(token);
    consumed.set(token, state);
    return state.json;
  }
  function assertCurrent(token) {
    authority();
    const state=consumed.get(token);
    if (!state || writers || state.generation!==generation) throw Error('handoff.changed');
    return true;
  }
  return Object.freeze({beginWrite, sealProof, consume, assertCurrent});
}
module.exports = {create};
