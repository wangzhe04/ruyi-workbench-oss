// Process-private capabilities for prepared image pixels. JSON references name an
// existing capability; neither an upload record nor a stored manifest creates one.
const MediaImageService = ((cryptoApi, HeadersApi) => {
  const PREFIX = 'https://ruyi.invalid/protected-image/';
  const fail = suffix => { throw Object.assign(Error('privacy.image_' + suffix), { code: 'privacy.image_' + suffix, statusCode: 409 }); };
  const hash = value => cryptoApi.createHash('sha256').update(value).digest('hex');
  const clone = value => JSON.parse(JSON.stringify(value));
  function cleanupFailure(primary, failed, errors) {
    const causes = [...(failed ? [primary] : []), ...errors], seen = new Set();
    const unknown = value => {
      if (value === null || !['object','function'].includes(typeof value)) return false;
      if (seen.has(value)) return false; if (seen.size >= 256) return true; seen.add(value);
      try {
        let owner = value;
        for (let depth = 0; owner !== null && depth < 8; depth++, owner = Object.getPrototypeOf(owner)) {
          const flag = Object.getOwnPropertyDescriptor(owner, 'helperMayStillRun');
          if (flag && (!Object.hasOwn(flag,'value') || flag.value === true)) return true;
        }
        for (const key of ['cause','errors']) {
          const descriptor = Object.getOwnPropertyDescriptor(value,key); if (!descriptor) continue;
          if (!Object.hasOwn(descriptor,'value')) return true;
          if (key === 'errors' && Array.isArray(descriptor.value)) { for (const item of descriptor.value) if (unknown(item)) return true; }
          else if (unknown(descriptor.value)) return true;
        }
        return false;
      } catch { return true; }
    };
    return Object.assign(new AggregateError(causes, 'privacy.image_cleanup_failed', { cause:causes[0] }), {
      code:'privacy.image_cleanup_failed',cleanupFailed:true,ownershipRetained:true,helperMayStillRun:causes.some(unknown) });
  }
  function partReference(part) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
    if (part.type === 'image_url' && Object.keys(part).sort().join(',') === 'image_url,type'
      && part.image_url && Object.keys(part.image_url).join(',') === 'url') return part.image_url.url;
    if (part.type === 'input_image' && Object.keys(part).sort().join(',') === 'image_url,type') return part.image_url;
    if (part.type === 'image' && Object.keys(part).sort().join(',') === 'source,type'
      && part.source && Object.keys(part.source).sort().join(',') === 'type,url' && part.source.type === 'url') return part.source.url;
    return null;
  }
  const referenceId = ref => typeof ref === 'string' && ref.startsWith(PREFIX) && /^[a-f0-9]{32}$/.test(ref.slice(PREFIX.length)) ? ref.slice(PREFIX.length) : null;
  const validPointer = pointer => /^(?:\/(?:messages|input))?\/\d+\/content\/\d+$/.test(pointer);
  function create({ contract = MediaImageContract, context, storeFor, now = Date.now } = {}) {
    if (typeof context !== 'function' || typeof storeFor !== 'function') fail('host_required');
    const records = new Map(), retained = new Set(), scopes = new Map(), scopeOwners = new WeakMap(); let preparing = false, scopeOwnerCount=0;
    function beginScope(sessionId) {
      if (typeof sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId)) fail('scope_changed');
      // Apply the existing four-owner budget before host IO too. Retained
      // cleanup owners remain budgeted after losing their active scope lease.
      if (scopeOwnerCount + retained.size >= 4) fail('busy');
      let epoch = scopes.get(sessionId);
      if (!epoch) { epoch = { sessionId, revoked:false, owners:new Set() }; scopes.set(sessionId,epoch); }
      let released=false;
      const owner=Object.freeze({
        assert() { if (released || epoch.revoked) fail('revoked'); return true; },
        release() { if (!released) { released=true; scopeOwnerCount--; epoch.owners.delete(owner); if (!epoch.owners.size && scopes.get(sessionId)===epoch) scopes.delete(sessionId); } },
        retainCleanup(resource,primary,failed,cleanup) {
          const failure=cleanupFailure(primary,failed,[cleanup]);
          if(!released) { retained.add({scopeOwner:owner,resource,failure}); owner.release(); }
          return failure;
        },
      });
      scopeOwnerCount++; epoch.owners.add(owner); scopeOwners.set(owner,{epoch,claimed:false}); return owner;
    }
    function assertScopeOwner(owner, sessionId) {
      if (scopeOwners.get(owner)?.epoch.sessionId !== sessionId) fail('scope_changed');
      owner.assert();
    }
    function claimScopeOwner(owner, sessionId) {
      assertScopeOwner(owner,sessionId);
      const known=scopeOwners.get(owner); if(known.claimed)fail('scope_owner_transferred'); known.claimed=true;
    }
    function revokeEpoch(sessionId) {
      const epoch=scopes.get(sessionId);
      if (epoch) { epoch.revoked=true; scopes.delete(sessionId); }
    }
    function check(record) {
      if (!record || record.dead || now() >= record.manifest.expiresAt) fail('expired');
      assertScopeOwner(record.scopeOwner,record.sessionId);
      const scope = context();
      if (!scope || scope.scopeId !== record.sessionId) fail('scope_changed');
      record.policy.assert(); record.source.assert(); record.processor.assert(record.processorSnapshot);
      record.pipeline.describe(record.token);
      return true;
    }
    const find = id => { const record = records.get(id); check(record); return record; };
    async function remove(id) {
      const record = records.get(id); if (!record) return;
      // Revoke synchronously before the first cleanup await. A failed unlink never
      // restores sending authority or causes the source upload to be removed.
      record.dead = true; records.delete(id); clearTimeout(record.timer);
      const errors = [];
      for (const borrowed of [...record.borrows]) try { borrowed.release(); } catch (error) { errors.push(error); }
      try { record.pipeline.release(record.token); } catch (error) { errors.push(error); }
      try { await record.store.remove(record.storedId); } catch (error) { errors.push(error); }
      try { await record.source.release(); } catch (error) { errors.push(error); }
      record.scopeOwner.release();
      if (errors.length) { retained.add(record); throw cleanupFailure(undefined, false, errors); }
    }
    async function prepare({ sessionId, source, policy, processor, recipient, signal, regions = null, scopeOwner } = {}) {
      // A supplied source lease transfers to the service at entry, including
      // admission refusal. Only the call which acquires preparing may clear it.
      let pipeline, token, record, borrowed, returned = false, failed = false, primary, admitted = false, ownsScope = false;
      try {
        if (scopeOwner !== undefined) { claimScopeOwner(scopeOwner,sessionId); ownsScope=true; }
        if (preparing || records.size + retained.size >= 4) fail('busy');
        if (!source || typeof source.release !== 'function' || !policy || !processor || typeof recipient !== 'string' || !/^[a-f0-9]{64}$/.test(recipient)) fail('host_required');
        if (context()?.scopeId !== sessionId) fail('scope_changed');
        if (scopeOwner === undefined) { scopeOwner=beginScope(sessionId); claimScopeOwner(scopeOwner,sessionId); ownsScope=true; }
        assertScopeOwner(scopeOwner,sessionId);
        preparing = true; admitted = true;
        policy.assert(); source.assert();
        const processorSnapshot = processor.capture();
        pipeline = contract.create({ sourceOwner: { capture: () => source.snapshot, assert: () => { assertScopeOwner(scopeOwner,sessionId); return source.assert(); } },
          policyOwner: { capture: () => policy, assert: () => policy.assert(), prepareDetector:policy.prepareDetector }, processorOwner: processor, now });
        token = await pipeline.prepare({ signal, regions }); assertScopeOwner(scopeOwner,sessionId);
        const manifest = pipeline.describe(token), id = cryptoApi.randomBytes(16).toString('hex');
        record = { id, sessionId, scopeOwner, source, policy, processor, processorSnapshot, pipeline, token, manifest,
          recipient, dead: false, store: null, storedId: null, timer: null, borrows:new Set(), deliveryState:'ready' };
        const authority = {
          capture: async sourceId => {
            if (sourceId !== source.id) fail('source_changed'); check(record);
            return Object.freeze({ binding: Object.freeze({ sourceHash: manifest.sourceHash, sourceRevision: manifest.sourceRevision,
              policyHash: manifest.policyHash, policyRevision: manifest.policyRevision, rulesHash: manifest.rulesHash,
              processorHash: manifest.processorHash, processorVersion: manifest.processorVersion, revocationRevision: id }) });
          },
          assert: snapshot => { if (snapshot?.binding?.revocationRevision !== id) fail('revoked'); return check(record); },
        };
        record.store = await storeFor({ scopeId: manifest.scope, authority }); check(record);
        borrowed = pipeline.borrow(token, { purpose: 'preview' }); borrowed.assert();
        const stored = await record.store.put({ sourceId: source.id, manifest, bytes: borrowed.bytes }); record.storedId = stored.id; check(record);
        borrowed.release(); borrowed = null;
        records.set(id, record);
        record.timer = setTimeout(() => { void remove(id).catch(() => {}); }, Math.max(1, manifest.expiresAt - now())); record.timer.unref?.();
        returned = true;
        return Object.freeze({ id, reference: PREFIX + id, manifest, recognitionConfidence: 'unknown' });
      } catch (error) { failed=true;primary=error;throw error; }
      finally {
        if (admitted) preparing = false;
        const errors=[];
        if (borrowed) try { borrowed.release(); } catch(error) { errors.push(error); }
        if (!returned) {
          // Known failures are cleaned; an unknown processor owner remains held by
          // its own uncertainty keeper and is never replaced with another worker.
          try { if(record?.store?.dispose)await record.store.dispose();else if(record?.storedId)await record.store.remove(record.storedId); } catch(error) { errors.push(error); }
          try { if(token)pipeline.release(token); } catch(error) { errors.push(error); }
          try { if (typeof source?.release === 'function') await source.release(); } catch(error) { errors.push(error); }
          if (ownsScope) scopeOwner.release();
        }
        if(errors.length){retained.add(record||{source,pipeline,token});throw cleanupFailure(primary,failed,errors);}
      }
    }
    async function borrow(id) {
      const record = find(id), borrowed = await record.store.read(record.storedId);
      try { check(record); borrowed.assert(); const owned=Object.freeze({ bytes: borrowed.bytes, manifest: borrowed.manifest,
        assert() { check(record); return borrowed.assert(); }, release() { record.borrows.delete(owned); borrowed.release(); } });
        record.borrows.add(owned); return owned; }
      catch (error) { borrowed.release(); throw error; }
    }
    function referenceFor(attachment) {
      const ref = attachment?.protectedImage?.reference, id = referenceId(ref);
      if (!id) fail('preparation_required');
      const record = find(id);
      if (attachment.id !== record.source.id || attachment.name !== record.source.name) fail('source_changed');
      return ref;
    }
    function projectPart(part, { scopeId, pointer } = {}) {
      const ref = partReference(part), id = referenceId(ref); if (!id) return null;
      if (!validPointer(pointer)) fail('media_position');
      const record = find(id); if (record.sessionId !== scopeId) fail('scope_changed');
      return clone(part);
    }
    async function delivery(body, recipient, signal, currentRecipient = () => recipient) {
      const captures = [], replacements = []; let nodes = 0, changed = false;
      const walk = async (value, pointer = '', userContent = false) => {
        if (++nodes > 50000) fail('structure_limit');
        if (value === null || typeof value !== 'object') return value;
        if (Array.isArray(value)) { const out = []; for (let i = 0; i < value.length; i++) out.push(await walk(value[i], pointer + '/' + i, userContent)); return out; }
        const ref = partReference(value), id = referenceId(ref);
        if (id) {
          if (!validPointer(pointer) || !userContent) fail('media_position');
          const record = find(id); if (record.recipient !== recipient) fail('recipient_changed');
          if (signal?.aborted) fail('cancelled');
          const borrowed = await borrow(id); captures.push(borrowed); borrowed.assert(); changed = true;
          const data = borrowed.bytes.toString('base64');
          const result = value.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data } }
            : value.type === 'input_image' ? { type: 'input_image', image_url: 'data:image/png;base64,' + data }
              : { type: 'image_url', image_url: { url: 'data:image/png;base64,' + data } };
          replacements.push({ record, result }); return result;
        }
        // The generic gateway has already rejected raw media while ON. Still
        // reject foreign/stale opaque references here, including after OFF.
        const out = {};
        for (const [key, item] of Object.entries(value)) {
          if (typeof item === 'string' && item.startsWith(PREFIX)) fail('unknown_artifact');
          out[key] = await walk(item, pointer + '/' + key, key === 'content' ? value.role === 'user' : userContent);
        }
        return out;
      };
      try {
        const result = await walk(body);
        const assert = () => {
          if (signal?.aborted) fail('cancelled');
          if (currentRecipient() !== recipient) fail('recipient_changed');
          for (const { record } of replacements) { check(record); if (record.recipient !== recipient) fail('recipient_changed'); }
          for (const borrowed of captures) borrowed.assert();
          return true;
        };
        let submitted=false;
        const submit=()=>{
          assert();if(submitted)fail('delivery_already_submitted');
          for(const {record} of replacements)if(record.deliveryState!=='ready')fail(record.deliveryState==='unknown'?'delivery_unknown':'delivery_busy');
          for(const {record} of replacements)record.deliveryState='pending';submitted=true;
        };
        const complete=accepted=>{if(submitted)for(const {record} of replacements)record.deliveryState=accepted===true?'ready':'unknown';};
        assert(); return Object.freeze({ body: changed ? result : body, assert, submit, complete, release() { for (const borrowed of captures) borrowed.release(); } });
      } catch (error) { for (const borrowed of captures) borrowed.release(); throw error; }
    }
    async function revokeScope(sessionId) {
      // Authority is revoked for host/source/processor/store pending owners before
      // cleanup awaits. A new same-id incarnation receives a different epoch.
      revokeEpoch(sessionId);
      const ids=[...records].filter(([,record])=>record.sessionId===sessionId).map(([id,record])=>{record.dead=true;return id;});
      const results=await Promise.allSettled(ids.map(remove)),errors=results.filter(row=>row.status==='rejected').map(row=>row.reason);
      if(errors.length)throw cleanupFailure(undefined,false,errors);
    }
    async function invalidate() {
      for(const sessionId of [...scopes.keys()])revokeEpoch(sessionId);
      const ids=[...records.keys()]; for(const record of records.values())record.dead=true;
      const results=await Promise.allSettled(ids.map(remove)),errors=results.filter(row=>row.status==='rejected').map(row=>row.reason);
      if(errors.length)throw cleanupFailure(undefined,false,errors);
    }
    return Object.freeze({ beginScope, prepare, borrow, remove, referenceFor, projectPart, delivery, revokeScope, invalidate });
  }
  function recipientHash(url, headers) {
    // Use Fetch's own parser: all explicit wire headers participate, including
    // custom credentials/account routing. Names fold, values trim and duplicate
    // names combine in precisely the same order as the eventual fetch request.
    let values;
    try { values = [...new HeadersApi(headers || {}).entries()]; }
    catch { fail('recipient_invalid'); }
    return hash(JSON.stringify([String(url), values]));
  }
  return Object.freeze({ create, recipientHash, partReference, referenceId });
})(require('node:crypto'), globalThis.Headers);
