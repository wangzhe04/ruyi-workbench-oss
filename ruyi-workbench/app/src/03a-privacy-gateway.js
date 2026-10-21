// 81-P2: Async-local model boundary. Execution copies are restored before permission checks.
const PrivacyGateway = ((cryptoApi, fileApi, pathApi, AsyncLocalStorage, core, UrlApi) => {
  const host = {};
  const local = new AsyncLocalStorage(), policyLocal = new AsyncLocalStorage(), loaded = new Map();
  const sourceViews = new WeakMap(), sourceProofs = new WeakMap();
  const PREFIX = '[[RUYI_PVT:', pattern = () => /\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]/g;
  let currentPolicy = { mode: 'off', signature: '' }, unavailable = false;
  let policyEpoch = 0;
  function setUnavailable(value) { if (unavailable !== value) policyEpoch++; unavailable = value; }
  const fail = suffix => { throw Object.assign(new Error('privacy.' + suffix), { code: 'privacy.' + suffix, statusCode: 409 }); };
  const enabled = config => ['basic', 'enhanced', 'strict'].includes(config?.privacyModeV1);
  function assertPolicyAvailable(config) {
    if (unavailable || config?.privacyPolicyRecoveryRequiredV1 === true) fail('policy_unavailable');
    const boundPolicy = policyLocal.getStore();
    if (boundPolicy !== undefined && boundPolicy !== currentPolicy.signature) fail('policy_changed');
    const context = local.getStore();
    if (context && context.policy !== currentPolicy.signature) fail('policy_changed');
  }
  function secrets(config) {
    const result = new Set();
    const add = value => { if (typeof value === 'string' && value.length > 0) result.add(value); };
    const secretName = key => /(?:key|token|secret|credential|signature|^sig$|password|passwd|authorization)/i.test(key);
    const secretFieldName = key => secretName(key) || /(?:^|[_-])(?:auth|bearer|cookie|pat|pwd|pass|pin|ak|sk)(?:$|[_-])/i.test(key);
    const urlSecrets = value => {
      if (typeof value !== 'string') return;
      let parsed; try { parsed = new UrlApi(value); } catch { return; }
      for (const item of [parsed.username, parsed.password]) { add(item); try { add(decodeURIComponent(item)); } catch { /* encoded spelling remains protected */ } }
      for (const [key, item] of parsed.searchParams) if (secretName(key)) { add(item); add(encodeURIComponent(item)); }
    };
    const headerSecret = value => { add(value); if (/^(?:Bearer|Basic)\s+/i.test(value)) add(value.replace(/^\S+\s+/, '')); };
    const configuredField = (name, value) => {
      urlSecrets(value);
      if (secretFieldName(name) || typeof value === 'string' && /^(?:Bearer|Basic)\s+\S/i.test(value)) headerSecret(value);
    };
    add(config.modelsApiKey); add(config.searchBackend?.apiKey);
    urlSecrets(config.modelsApiBase); urlSecrets(config.searchBackend?.baseUrl);
    for (const provider of config.providers || []) {
      add(provider.apiKey);
      for (const value of [provider.baseUrl, provider.audioBaseUrl, ...(provider.extraBaseUrls || [])]) urlSecrets(value);
      for (const [name, value] of Object.entries(provider.extraHeaders || {})) configuredField(name, value);
    }
    for (const server of config.externalMcpServers || []) {
      urlSecrets(server.url);
      // Vault storage encrypts the complete env object, but discovery must distinguish
      // actual credentials from ordinary runtime flags such as PYTHONUTF8=1 or PATH.
      for (const [name, value] of Object.entries(server.env || {})) configuredField(name, value);
      for (const [name, value] of Object.entries(server.headers || {})) configuredField(name, value);
      const args = server.args || [];
      for (let i = 0; i < args.length; i++) {
        urlSecrets(args[i]);
        const flag = /^--?([A-Za-z0-9_-]+)(?:=(.*))?$/.exec(args[i]);
        if (flag && secretName(flag[1])) add(flag[2] === undefined ? args[i + 1] : flag[2]);
      }
    }
    return [...result];
  }
  function options(config) {
    return { personal: ['enhanced', 'strict'].includes(config.privacyModeV1), confidential: config.privacyModeV1 === 'strict', technical: config.privacyTechnicalV1 === true,
      knownSecrets: secrets(config), rules: config.privacyRulesV1 || [] };
  }
  function configure(config) {
    try {
    setUnavailable(config.privacyPolicyRecoveryRequiredV1 === true);
    const mode = config.privacyModeV1 || 'off';
    // The disabled path must not enumerate secrets, build detectors or start workers.
    // A mode change still invalidates any already-running protected context.
    if (mode === 'off') { if (currentPolicy.signature !== 'off') policyEpoch++; currentPolicy = { mode, signature: 'off', config }; return; }
    const signature = cryptoApi.createHash('sha256').update(JSON.stringify([mode, options(config)])).digest('hex');
    const policy = { mode, signature, config: structuredClone(config) };
    if (currentPolicy.signature !== signature) policyEpoch++;
    currentPolicy = policy;
    } catch (error) { setUnavailable(true); throw error; }
  }
  function active() { return local.getStore(); }
  const keyOf = scopeId => cryptoApi.createHash('sha256').update(scopeId).digest('hex');
  async function scopeFor(scopeId, config) {
    if (typeof scopeId !== 'string' || !scopeId || scopeId.length > 160) fail('scope_invalid');
    const key = keyOf(scopeId), signature = cryptoApi.createHash('sha256').update(JSON.stringify(options(config))).digest('hex');
    let entry = loaded.get(key);
    if (!entry || entry.signature !== signature) {
      if (entry?.busy) fail('policy_changed');
      if (!entry && loaded.size >= 128) {
        // Dirty mappings cannot disappear behind an unchanged disk identity.
        const victim = [...loaded].find(([, value]) => !value.busy && value.value?.isPersisted()); if (!victim) fail('scope_capacity');
        const evicted = await victim[1].promise;
        if (loaded.get(victim[0]) !== victim[1] || victim[1].busy || !evicted.isPersisted()) fail('scope_capacity');
        evicted.scope.clear(); loaded.delete(victim[0]);
      }
      const previous = entry;
      entry = { signature, busy: 0, token: Object.freeze({}), value: null };
      entry.promise = (async () => {
        const detector = makeDetector(config);
        const scope = core.createScope({ scopeId, detector, ttlMs: 365 * 86400000 });
        const file = pathApi.join(host.data, 'privacy-scopes', key + '.json');
        const store = host.makeStore(file, key);
        let persistedRevision = -1;
        if (previous) scope.importState((await previous.promise).scope.exportState());
        else {
          try {
            const stat = await fileApi.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('mapping_invalid');
            const encrypted = await store.read();
            scope.importState(JSON.parse(await core.configHooks.openLocal(encrypted, 'privacy-mapping', key)));
            persistedRevision = scope.revision();
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        let writes = Promise.resolve(), pendingRevision = -1;
        const persist = () => {
          const revision = scope.revision();
          // Reusing a reference needs no new ciphertext or disk write. A fresh scope
          // with no sensitive matches does not create a master key or mapping file.
          if (revision === persistedRevision || revision === pendingRevision) return writes;
          if (revision === 0 && scope.size() === 0) return Promise.resolve();
          const serialized = JSON.stringify(scope.exportState());
          pendingRevision = revision;
          const next = writes.catch(() => {}).then(async () => {
            const encrypted = await core.configHooks.sealLocal(serialized, 'privacy-mapping', key);
            await fileApi.mkdir(pathApi.dirname(file), { recursive: true });
            await store.write(encrypted);
            persistedRevision = revision;
          }).finally(() => {
            if (pendingRevision === revision) pendingRevision = -1;
          }); writes = next; return next;
        };
        return { scope, detector, persist, key, isPersisted: () => pendingRevision === -1 && (scope.revision() === persistedRevision || (scope.revision() === 0 && scope.size() === 0)) };
      })().then(value => { entry.value = value; return value; });
      loaded.set(key, entry);
      entry.promise.catch(() => { if (loaded.get(key) === entry) loaded.delete(key); });
    }
    return { entry, value: await entry.promise };
  }
  function makeDetector(config) {
    return core.createDetector({ ...options(config), regexMatches: input => {
      const matches = active()?.regexMatches;
      if (!matches || !matches.has(input)) fail('regex_scan_required');
      return matches.get(input);
    } });
  }
  function regexInputs(value) {
    const result = new Set(); let bytes = 0, nodes = 0;
    const add = input => {
      if (result.has(input)) return;
      if (Buffer.byteLength(input) > core.LIMITS.bytes || (bytes += Buffer.byteLength(input)) > 8 * 1024 * 1024 || result.size >= 50000) fail('regex_input_limit');
      result.add(input);
      // Protected history is scanned by raw segments, never by rewriting its registered references.
      if (input.includes(PREFIX)) { let from = 0; for (const match of input.matchAll(pattern())) { add(input.slice(from, match.index)); from = match.index + match[0].length; } add(input.slice(from)); }
    };
    const visit = (item, depth) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof item === 'string') {
        add(item);
        if (/^\s*[\[{]/.test(item) && !item.startsWith(PREFIX)) {
          let parsed; try { parsed = JSON.parse(item); } catch { return; }
          if (!parsed || typeof parsed !== 'object') return;
          // Lexical tokens preserve long numeric spelling and duplicate object keys.
          for (const token of item.matchAll(/"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\b(?:true|false|null)\b/g)) {
            if (token[0][0] === '"') visit(JSON.parse(token[0]), depth + 1); else add(token[0]);
          }
        }
      } else if (Array.isArray(item)) for (const row of item) visit(row, depth + 1);
      else if (item && typeof item === 'object') for (const [key, row] of Object.entries(item)) { add(key); visit(row, depth + 1); }
      else if (item === null || typeof item === 'number' || typeof item === 'boolean') add(String(item));
    };
    visit(value, 0); return [...result];
  }

  const DATA_WITHHELD = '[RUYI_LOCAL_DATA_WITHHELD]';
  const contentRecoveryError = error => ['privacy.typed_sensitive', 'privacy.numeric_sensitive', 'privacy.json_sensitive_structure'].includes(error?.code);
  // Only protocol data slots may be replaced. Routing, IDs, schemas, policy and vault
  // failures remain strict. A replacement never authorizes or re-executes a tool.
  function contentRecoveryPaths(value) {
    const recoverySlots = new Map(); let nodes = 0;
    const put = (pointer, replacement) => { if (++nodes > 50000) fail('structure_limit'); recoverySlots.set(pointer, replacement); };
    const content = (item, pointer) => {
      if (typeof item === 'string') { put(pointer, DATA_WITHHELD); return; }
      if (!Array.isArray(item)) return;
      item.forEach((part, index) => {
        if (++nodes > 50000) fail('structure_limit');
        if (!part || typeof part !== 'object') return;
        const at = pointer + '/' + index;
        if (['text', 'input_text', 'output_text', 'reasoning_text'].includes(part.type) && typeof part.text === 'string') put(at + '/text', DATA_WITHHELD);
        if (part.type === 'thinking' && typeof part.thinking === 'string') put(at + '/thinking', DATA_WITHHELD);
        if (part.type === 'tool_use' && part.input && typeof part.input === 'object') put(at + '/input', {});
        if (part.type === 'tool_result') put(at + '/content', DATA_WITHHELD);
      });
    };
    const messages = (rows, prefix) => (rows || []).forEach((message, index) => {
      if (++nodes > 50000) fail('structure_limit');
      if (!message || !['user', 'assistant', 'tool'].includes(message.role)) return;
      const at = prefix + '/' + index; content(message.content, at + '/content');
      if (message.role === 'assistant') {
        for (const key of ['reasoning_content', 'thinking']) if (typeof message[key] === 'string') put(at + '/' + key, DATA_WITHHELD);
        (message.tool_calls || []).forEach((call, i) => { if (typeof call?.function?.arguments === 'string') put(at + '/tool_calls/' + i + '/function/arguments', '{}'); });
      }
    });
    if (Array.isArray(value)) messages(value, '');
    else if (value && typeof value === 'object') {
      if (Array.isArray(value.messages)) messages(value.messages, '/messages');
      if (Array.isArray(value.input)) value.input.forEach((item, index) => {
        if (++nodes > 50000) fail('structure_limit');
        if (!item || typeof item !== 'object') return;
        const at = '/input/' + index;
        if (item.type === 'function_call') put(at + '/arguments', '{}');
        else if (item.type === 'function_call_output') put(at + '/output', DATA_WITHHELD);
        else if (item.type === 'reasoning') { content(item.content, at + '/content'); content(item.summary, at + '/summary'); }
        else if (['user', 'assistant'].includes(item.role)) content(item.content, at + '/content');
      });
    }
    return recoverySlots;
  }

  async function protectedTransform(value, context, flags) {
    const rules = context.config.privacyRulesV1 || [];
    const stable = () => {
      const budget = flags?.budget || core.createMatchBudget(), traceStart = context.trace?.length || 0;
      for (let pass = 0; pass < 4; pass++) {
        if (context.trace) context.trace.length = traceStart;
        if (flags?.proof) { flags.proof.edits.length = 0; flags.proof.covered.length = 0; flags.proof.references = false; }
        const revision = context.scope.revision();
        // Rescan the original input, never a raw-protected copy. Later fields can teach an
        // earlier prose/metadata leaf, and classification can tighten an existing alias.
        const trustedLeaves = flags?.sourceProof ? sourceLeaves(value, context) : flags?.trustedLeaves;
        const result = transform(value, context, { ...flags, budget, trustedLeaves });
        if (context.scope.revision() === revision) return flags?.snapshot ? { value: result, revision } : result;
      }
      fail('learning_not_stable');
    };
    if (!rules.some(rule => rule.kind === 'regex')) return stable();
    const matches = await PrivacyRegex.scan(rules, regexInputs(flags?.recoveryPaths ? [value, ...flags.recoveryPaths.values()] : value));
    if (context.policy !== currentPolicy.signature) fail('policy_changed');
    const previous = context.regexMatches; context.regexMatches = matches;
    try { return stable(); } finally { context.regexMatches = previous; }
  }
  async function run(scopeId, config, work) {
    assertPolicyAvailable(config);
    if (!enabled(config)) return work();
    if (active()?.scopeId === scopeId) return work();
    const { entry, value } = await scopeFor(scopeId, config); entry.busy++;
    const context = { ...value, scopeId, config, policy: currentPolicy.signature };
    try { return await local.run(context, work); } finally { entry.busy--; }
  }
  // Auxiliary work may outlive its originating turn/configuration. Bind the current policy
  // before any lossy preprocessing, including OFF: a later opt-in must reject the stale
  // excerpt rather than scanning an already truncated original. OFF creates no scope.
  function withPolicy(scopeId, work) {
    assertPolicyAvailable();
    const policy = currentPolicy;
    return policyLocal.run(policy.signature, () => policy.mode === 'off' ? work() : run(scopeId, policy.config, work));
  }
  // Host capabilities never travel in model data, JSON or HTTP parameters.
  const disclosures = new WeakMap();
  function disclosureBinding(binding) {
    if (!binding || typeof binding.recipient !== 'string' || !binding.recipient || typeof binding.purpose !== 'string' || !binding.purpose
      || typeof binding.sourceHash !== 'string' || !binding.sourceHash || binding.plaintext === true) fail('disclosure_invalid');
    return JSON.stringify([binding.recipient, binding.purpose, binding.sourceHash]);
  }
  function disclosureRecord(receipt, binding) {
    assertPolicyAvailable();
    const record = disclosures.get(receipt);
    if (!record || record.binding !== disclosureBinding(binding)) fail('recipient_changed');
    if (record.policy !== currentPolicy.signature) fail('policy_changed');
    const context = active();
    if (record.context ? record.context.scope !== context?.scope || record.context.scopeId !== context?.scopeId : context) fail('scope_changed');
    return record;
  }
  async function projectDisclosure(record) {
    const context = record.context;
    if (!context) return { value: record.source, revision: undefined };
    for (let pass = 0; pass < 4; pass++) {
      const { value, revision } = await protectedTransform(record.source, context, { data: true, snapshot: true });
      await context.persist();
      assertPolicyAvailable();
      if (revision === context.scope.revision()) return { value, revision };
    }
    fail('learning_not_stable');
  }
  async function prepareDisclosure(value, binding) {
    assertPolicyAvailable();
    const key = disclosureBinding(binding), context = active();
    if (currentPolicy.mode !== 'off' && !context) fail('scope_invalid');
    // Host-only credential slots augment discovery in the source scope. OFF does
    // not enumerate secrets, initialize detectors or create encryption state.
    if (context && binding.knownSecrets !== undefined) {
      if (!Array.isArray(binding.knownSecrets) || binding.knownSecrets.length > 32) fail('disclosure_invalid');
      for (const secret of binding.knownSecrets) {
        if (typeof secret !== 'string' || !secret || Buffer.byteLength(secret) > 4096) fail('disclosure_invalid');
        context.scope.protectValue(secret, 'CREDENTIAL');
      }
    }
    const record = { binding: key, policy: currentPolicy.signature, context, source: structuredClone(value) };
    Object.assign(record, await projectDisclosure(record));
    const receipt = Object.freeze({}); disclosures.set(receipt, record);
    return { value: structuredClone(record.value), receipt };
  }
  async function refreshDisclosure(receipt, binding) {
    const record = disclosureRecord(receipt, binding);
    // Parallel learning does not invalidate unrelated replies. Always reproject
    // the complete original and let the host rebuild clipping/body if it changes.
    if (record.context && record.revision !== record.context.scope.revision()) {
      Object.assign(record, await projectDisclosure(record));
    }
    assertDisclosure(receipt, binding);
    return structuredClone(record.value);
  }
  function assertDisclosure(receipt, binding) {
    const record = disclosureRecord(receipt, binding);
    if (record.context) {
      if (record.revision !== record.context.scope.revision()) fail('disclosure_dirty');
      containsExecutionReferences(record.value, record.context);
    }
    if (Object.hasOwn(binding, 'value') && JSON.stringify(binding.value) !== JSON.stringify(record.value)) fail('disclosure_changed');
  }
  const disclosureFs = require('node:fs');
  function mappingIdentity(key) {
    try {
      const stat = disclosureFs.lstatSync(pathApi.join(host.data, 'privacy-scopes', key + '.json'), { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()) fail('mapping_invalid');
      return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    } catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  }
  function mappingGuard(context) {
    const key = keyOf(context.scopeId), entry = loaded.get(key), revision = context.scope.revision();
    if (!entry?.value?.isPersisted()) fail('disclosure_dirty');
    const token = entry.token, identity = mappingIdentity(key);
    return guardMappingMetadata(key, token, revision, identity);
  }
  function guardMappingMetadata(key, token, revision, identity) {
    // Retain metadata only: no scope, entry, context or mapping originals survive.
    return () => {
      const current = loaded.get(key);
      if (current && (!current.value?.isPersisted() || (current.token === token && current.value.scope.revision() !== revision))) fail('disclosure_dirty');
      if (mappingIdentity(key) !== identity) fail('disclosure_dirty');
    };
  }
  // Export capabilities bind persisted mapping identities across LRU eviction.
  // Client scope declarations are never restoration authority.
  async function prepareMultiSourceDisclosure(value, scopeIds, binding) {
    if (!Array.isArray(scopeIds) || scopeIds.length > 2048 || scopeIds.some(id => typeof id !== 'string' || !id || id.length > 160)) fail('scope_invalid');
    const policyGuard = disclosurePolicyGuard();
    if (currentPolicy.mode === 'off') return { value: structuredClone(value), assert: policyGuard };
    if (!scopeIds.length) fail('scope_invalid');
    const policy = currentPolicy.signature, proofs = [];
    let copy = foreignView(structuredClone(value));
    for (const id of [...new Set(scopeIds)]) {
      await withPolicy(id, async () => {
        if (policy !== currentPolicy.signature) fail('policy_changed');
        const prepared = await prepareDisclosure(copy, binding);
        assertDisclosure(prepared.receipt, binding);
        proofs.push(mappingGuard(active()));
        copy = foreignView(prepared.value);
      });
    }
    if (policy !== currentPolicy.signature) fail('policy_changed');
    const assert = () => {
      if (policy !== currentPolicy.signature) fail('policy_changed');
      policyGuard();
      for (const proof of proofs) proof();
    };
    assert();
    return { value: copy, assert };
  }
  // An authenticated host connection owns this capability. It exposes neither
  // an identifier nor an original-value lookup. Mapping commits are memory-only;
  // disconnect destroys aliases and never creates a mapping file or master key.
  function createConnectionScope() {
    const scopeId = 'consumer-' + cryptoApi.randomBytes(24).toString('hex');
    let context = null, busy = 0, closed = false;
    const clear = () => { context?.scope.clear(); context = null; };
    const close = () => { closed = true; if (!busy) clear(); };
    const run = async work => {
      if (closed) fail('connection_closed');
      const guard = disclosurePolicyGuard(), policy = currentPolicy;
      if (policy.mode !== 'off' && context?.policy !== policy.signature) {
        // A new policy must never clear a scope still used across an await.
        if (busy) fail('connection_busy');
        const state = context?.scope.exportState();
        const detector = makeDetector(policy.config);
        const scope = core.createScope({ scopeId, detector, ttlMs: 365 * 86400000 });
        if (state) scope.importState(state);
        clear();
        context = { scopeId, scope, detector, config: policy.config, policy: policy.signature,
          // Synchronous logical commit to this capability's existing core scope.
          // No file-store/LRU/vault adapter participates in a connection lifetime.
          persist: async () => { if (closed) fail('connection_closed'); } };
      }
      busy++;
      try {
        guard();
        const value = await policyLocal.run(policy.signature, () => local.run(policy.mode === 'off' ? undefined : context, work));
        if (closed) fail('connection_closed'); guard(); return value;
      } finally { busy--; if (closed && !busy) clear(); }
    };
    return Object.freeze({ run, close });
  }
  function disclosurePolicyGuard() {
    assertPolicyAvailable();
    const signature = currentPolicy.signature, epoch = policyEpoch;
    return () => { assertPolicyAvailable(); if (signature !== currentPolicy.signature || epoch !== policyEpoch) fail('policy_changed'); };
  }
  async function prepareLocalDisclosure(scopeId, work) {
    const policyGuard = disclosurePolicyGuard(), key = keyOf(scopeId);
    const pending = loaded.get(key);
    if (pending && !pending.value) await pending.promise;
    policyGuard();
    const current = loaded.get(key);
    const sourceGuard = guardMappingMetadata(key, current?.token, current?.value?.scope.revision(), mappingIdentity(key));
    const assert = () => { policyGuard(); sourceGuard(); };
    assert();
    const value = await work();
    assert();
    return { value, assert };
  }
  // Host-only cross-thread metadata projection. These aliases belong to the source
  // transcript, so never resolve or admit them into another conversation's scope.
  // Project before summary budgets; legacy summaries may already end mid-reference.
  function foreignView(value) {
    if (currentPolicy.mode === 'off') return value;
    let nodes = 0;
    const visit = (item, depth) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof item === 'string') return item.includes(PREFIX)
        ? item.replace(/\[\[RUYI_PVT:[^\r\n]*?(?:\]\]|(?=\r?\n|$))/g, '[其他线程的隐私内容已省略]') : item;
      if (Array.isArray(item)) { const next = item.map(row => visit(row, depth + 1)); return next.some((row, i) => row !== item[i]) ? next : item; }
      if (item && typeof item === 'object') {
        const next = Object.create(null); let changed = false;
        for (const [key, row] of Object.entries(item)) {
          const name = visit(key, depth + 1), projected = visit(row, depth + 1);
          if (Object.hasOwn(next, name)) fail('key_collision');
          next[name] = projected; changed ||= name !== key || projected !== row;
        }
        return changed ? next : item;
      }
      return item;
    };
    return visit(value, 0);
  }
  const credentialContext = (span, start, end) => span.category === 'CREDENTIAL' && span.start < end && span.end > start
    && (span.start < start || span.end > end || span.start === start && span.end === end);
  function protectString(input, context, pointer, raw = false, budget, proof) {
    if (typeof input !== 'string') return input;
    let sourceCursor = 0;
    const protect = (value, offset = 0, sourceMatches) => {
      let result;
      if (sourceMatches) {
        // Reuse complete-source evidence. Rescanning a prefix such as "Authorization: "
        // after removing its reference makes a missing value look like a new whitespace secret.
        while (sourceCursor < sourceMatches.length && sourceMatches[sourceCursor].end <= offset) sourceCursor++;
        const matches = [];
        for (let i = sourceCursor; i < sourceMatches.length && sourceMatches[i].start < offset + value.length; i++) {
          const match = sourceMatches[i];
          matches.push({ ...match, start: Math.max(offset, match.start) - offset, end: Math.min(offset + value.length, match.end) - offset });
        }
        let protectedSegment = '', from = 0;
        for (const match of matches) {
          protectedSegment += value.slice(from, match.start) + context.scope.protectValue(value.slice(match.start, match.end), match.category, { budget });
          from = match.end;
        }
        result = { text: protectedSegment + value.slice(from), matches };
      } else result = context.scope.protectRaw(value, { pointer, budget });
      for (const match of result.matches) {
        if (context.trace) context.trace.push({ pointer, ...match });
        if (proof) {
          const span = { start: offset + match.start, end: offset + match.end, category: match.category };
          proof.covered.push(span);
          proof.edits.push({ ...span, replacement: context.scope.protectValue(value.slice(match.start, match.end), match.category, { budget }) });
        }
      }
      return result.text;
    };
    if (raw || !input.includes(PREFIX)) return protect(input);
    let matches;
    try { matches = context.scope.detect(input, { pointer, budget, opaqueReferences: true }); }
    catch (error) { if (error.code === 'privacy.reference_malformed') fail('reserved_literal'); throw error; }
    const credentials = matches.filter(match => match.category === 'CREDENTIAL');
    let output = '', from = 0, referenceCursor = 0;
    for (const match of input.matchAll(pattern())) {
      while (referenceCursor < matches.length && matches[referenceCursor].end <= match.index) referenceCursor++;
      for (let i = referenceCursor; i < matches.length && matches[i].start < match.index + match[0].length; i++) {
        const span = matches[i];
        if (!(span.start <= match.index && span.end >= match.index + match[0].length)) fail('reference_structure');
      }
      output += protect(input.slice(from, match.index), from, matches);
      context.scope.validateProtected(match[0], credentials.some(span => credentialContext(span, match.index, match.index + match[0].length)) ? { requiredCategory: 'CREDENTIAL' } : {});
      if (proof) { proof.references = true; proof.covered.push({ start: match.index, end: match.index + match[0].length, category: 'CREDENTIAL', reference: match[0] }); }
      output += match[0]; from = match.index + match[0].length;
    }
    output += protect(input.slice(from), from, matches);
    if (Buffer.byteLength(output) > core.LIMITS.bytes) fail('text_limit');
    return output;
  }
  function transform(value, context, { raw = false, data = false, trustedToolSchemas = false, budget, proof, trustedLeaves, recoveryPaths } = {}) {
    let nodes = 0, bytes = 0;
    const detect = (input, pointer, allowReferences = false, lexicalJsonSource = false, automaticJsonSource = false) => {
      try { return context.scope.detect(input, { pointer, budget, opaqueReferences: (!raw || allowReferences) && input.includes(PREFIX), lexicalJsonSource, automaticJsonSource }); }
      catch (error) { if (error.code === 'privacy.reference_malformed') fail('reserved_literal'); throw error; }
    };
    // Typed values cannot be reversibly substituted by the text serializer. Apply field-based
    // classification for the selected mode; ordinary protocol objects keep their shape.
    const typedDetector = core.createDetector({ personal: options(context.config).personal, rules: (context.config.privacyRulesV1 || []).filter(rule => rule.kind === 'field') });
    const typedPointers = new Map();
    const explicitFields = new Set((context.config.privacyRulesV1 || []).filter(rule => rule.kind === 'field').map(rule => rule.value));
    const declarations = new Set();
    const segment = key => key.replace(/~/g, '~0').replace(/\//g, '~1');
    const schemaNodes = (item, pointer, depth = 0) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof item !== 'boolean' && (!item || typeof item !== 'object' || Array.isArray(item))) return;
      declarations.add(pointer);
      if (typeof item === 'boolean') return;
      for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']) {
        const map = item[key]; if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
        for (const [name, schema] of Object.entries(map)) schemaNodes(schema, pointer + '/' + key + '/' + segment(name), depth + 1);
      }
      for (const key of ['items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']) {
        if (Array.isArray(item[key]) && key === 'items') item[key].forEach((schema, i) => schemaNodes(schema, pointer + '/' + key + '/' + i, depth + 1));
        else if (Object.hasOwn(item, key)) schemaNodes(item[key], pointer + '/' + key, depth + 1);
      }
      for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(item[key])) item[key].forEach((schema, i) => schemaNodes(schema, pointer + '/' + key + '/' + i, depth + 1));
    };
    if (trustedToolSchemas && !data && Array.isArray(value?.tools)) value.tools.forEach((tool, i) => {
      if (!tool || typeof tool !== 'object') return;
      if (tool.type === 'function' && tool.function && typeof tool.function === 'object') schemaNodes(tool.function.parameters, '/tools/' + i + '/function/parameters');
      if (tool.type === 'function') schemaNodes(tool.parameters, '/tools/' + i + '/parameters');
      if (!tool.type && typeof tool.name === 'string') schemaNodes(tool.input_schema, '/tools/' + i + '/input_schema');
    });
    const schemaHasValues = (item, depth = 0) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (!item || typeof item !== 'object') return false;
      // Schema references may hide values in another definition; conservatively refuse them
      // inside a sensitive declaration rather than claim to resolve arbitrary schema graphs.
      return Object.entries(item).some(([key, row]) => ['default', 'const', 'enum', 'examples', '$ref', '$dynamicRef'].includes(key) || schemaHasValues(row, depth + 1));
    };
    const assertTypedField = (pointer, item, protocolDeclaration = false) => {
      if (!pointer) return;
      if (!typedPointers.has(pointer)) typedPointers.set(pointer, typedDetector.detect('ruyi-typed-field-value', { pointer }).length > 0);
      if (!typedPointers.get(pointer)) return;
      // Only host-supplied tool schema nodes get this exception. Business objects, JSON text,
      // tool results and explicit custom field rules retain the fail-closed typed-value gate.
      if (protocolDeclaration && declarations.has(pointer) && !explicitFields.has(pointer) && !schemaHasValues(item)) return;
      fail('typed_sensitive');
    };
    const mediaShape = item => ['image', 'audio', 'video', 'document', 'input_image', 'input_audio', 'input_file'].includes(item.type) || (item.type === 'resource' && (item.resource?.blob || item.resource?.mimeType && !/^(?:text\/|application\/(?:json|xml))/.test(item.resource.mimeType))) || item.type === 'base64' && item.media_type || typeof item.mimeType === 'string' && /^(?:image|audio|video)\//.test(item.mimeType);
    function inspectParsed(item, depth) {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (!item || typeof item !== 'object') return;
      if (mediaShape(item)) fail('media_not_supported');
      for (const row of Object.values(item)) inspectParsed(row, depth + 1);
    }
    // Validate JSON, then edit lexical spans only. Never round-trip source files through JS Number/JSON.stringify.
    function protectJson(source, initialDepth, proof, allowReferences = false) {
      let cursor = 0, hasReferences = false; const replacements = [], concealed = [], stringValues = [];
      const sourceMatches = detect(source, undefined, allowReferences, true);
      const automaticMatches = detect(source, undefined, allowReferences, false, true);
      const space = () => { while (cursor < source.length && /\s/.test(source[cursor])) cursor++; };
      const quoted = () => {
        const start = cursor++;
        while (cursor < source.length) {
          const current = source[cursor++];
          if (current.charCodeAt(0) === 92) { cursor++; continue; }
          if (current === '"') break;
        }
        return { start, end: cursor, value: JSON.parse(source.slice(start, cursor)) };
      };
      const protectQuoted = (token, pointer, depth) => {
        const child = { edits: [], covered: [], references: false };
        const protectedValue = walk(token.value, pointer, depth, true, child, allowReferences);
        const original = source.slice(token.start, token.end);
        const spelling = original.slice(1, -1), offsets = [];
        // JSON escapes encode one UTF-16 code unit. Keep a positional proof so nested
        // trusted history can retain every untouched source escape and numeric spelling.
        for (let i = 0; i < spelling.length;) { offsets.push(i); i += spelling.charCodeAt(i) === 92 ? (spelling[i + 1] === 'u' ? 6 : 2) : 1; }
        offsets.push(spelling.length);
        if (offsets.length !== token.value.length + 1) fail('json_sensitive_structure');
        const mapped = child.covered.map(span => ({ start: token.start + 1 + offsets[span.start], end: token.start + 1 + offsets[span.end], category: span.category, ...(span.reference ? { reference: span.reference } : {}) }));
        hasReferences ||= child.references;
        if (protectedValue === token.value) { concealed.push(...mapped); return; }
        let replacement = JSON.stringify(protectedValue);
        if (spelling !== token.value && child.references && (!raw || allowReferences)) {
          // Never issue an alias containing a literal reference. References were validated
          // by the leaf walk; copy only its proven edits into the original lexical text.
          let encoded = '', from = 0;
          for (const edit of child.edits) {
            const start = offsets[edit.start], end = offsets[edit.end];
            if (start === undefined || end === undefined || start < from || end < start) fail('json_sensitive_structure');
            encoded += spelling.slice(from, start) + JSON.stringify(edit.replacement).slice(1, -1); from = end;
          }
          replacement = '"' + encoded + spelling.slice(from) + '"';
          if (JSON.parse(replacement) !== protectedValue) fail('json_sensitive_structure');
          concealed.push(...mapped);
        } else if (spelling !== token.value) {
          // An escaped source value must restore its original spelling for exact file edits.
          const credential = detect(token.value, pointer).some(match => match.category === 'CREDENTIAL') || sourceMatches.some(match => match.category === 'CREDENTIAL' && match.start < token.end - 1 && match.end > token.start + 1);
          replacement = JSON.stringify(context.scope.protectAlias(original.slice(1, -1), token.value, credential ? 'CREDENTIAL' : 'INTERNAL', { budget }));
          concealed.push({ start: token.start + 1, end: token.end - 1, category: credential ? 'CREDENTIAL' : 'INTERNAL' });
        } else concealed.push(...mapped);
        replacements.push({ start: token.start, end: token.end, replacement });
      };
      const value = (pointer, depth) => {
        if (++nodes > 50000 || depth > 32) fail('structure_limit');
        space(); const current = source[cursor];
        if (current === '"') { const token = quoted(); stringValues.push({ start: token.start + 1, end: token.end - 1 }); protectQuoted(token, pointer, depth + 1); return; }
        if (!/[-0-9]/.test(current)) assertTypedField(pointer);
        if (current === '{') {
          cursor++; space();
          if (source[cursor] === '}') { cursor++; return; }
          while (cursor < source.length) {
            space(); const key = quoted(); protectQuoted(key, '', depth + 1); space(); cursor++; // colon
            value(pointer + '/' + key.value.replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1); space();
            if (source[cursor++] === '}') return;
          }
        } else if (current === '[') {
          cursor++; space(); let index = 0;
          if (source[cursor] === ']') { cursor++; return; }
          while (cursor < source.length) { value(pointer + '/' + index++, depth + 1); space(); if (source[cursor++] === ']') return; }
        } else {
          const start = cursor; while (cursor < source.length && !/[\s,\]}]/.test(source[cursor])) cursor++;
          const literal = source.slice(start, cursor);
          // Typed numeric secrets need a future typed serializer; do not leak them or coerce a long integer.
          if (detect(literal, pointer).length) fail(/^-?\d/.test(literal) ? 'numeric_sensitive' : 'typed_sensitive');
        }
      };
      value('', initialDepth);
      // A match spanning JSON syntax cannot be safely replaced inside one string leaf.
      // Reject it rather than silently discard the whole-source rule or corrupt typed JSON.
      const references = raw && !allowReferences ? [] : [...source.matchAll(pattern())];
      const withinStringValue = match => {
        let low = 0, high = stringValues.length - 1, candidate = -1;
        while (low <= high) { const mid = (low + high) >>> 1; if (stringValues[mid].start <= match.start) { candidate = mid; low = mid + 1; } else high = mid - 1; }
        return candidate >= 0 && match.end <= stringValues[candidate].end;
      };
      // Encoded \\n is syntax in this wrapper, but becomes a real newline in the fully
      // scanned leaf. Only automatic matches entirely inside one verified value defer
      // to that decoded evidence. Explicit rules and any match crossing JSON syntax
      // retain the original structural guard, including split PEM/XML secrets.
      for (const match of [...sourceMatches, ...automaticMatches.filter(match => !withinStringValue(match))]) {
        if (match.category === 'CREDENTIAL') for (const ref of references) {
          if (credentialContext(match, ref.index, ref.index + ref[0].length)) context.scope.validateProtected(ref[0], { requiredCategory: 'CREDENTIAL' });
        }
        for (const span of concealed) if (span.reference && credentialContext(match, span.start, span.end)) context.scope.validateProtected(span.reference, { requiredCategory: 'CREDENTIAL' });
        if (!concealed.some(span => match.start >= span.start && match.end <= span.end && (match.category !== 'CREDENTIAL' || span.category === 'CREDENTIAL')) && !references.some(ref => match.start >= ref.index && match.end <= ref.index + ref[0].length)) fail('json_sensitive_structure');
      }
      let output = '', from = 0;
      for (const span of replacements.sort((a, b) => a.start - b.start)) { output += source.slice(from, span.start) + span.replacement; from = span.end; }
      if (proof) { proof.edits.push(...replacements); proof.covered.push(...concealed); proof.references ||= hasReferences; }
      return output + source.slice(from);
    }
    const walk = (item, pointer, depth, structuredData = data, proof, allowReferences = false) => {
      try { return visit(item, pointer, depth, structuredData, proof, allowReferences); }
      catch (error) {
        if (!recoveryPaths?.has(pointer) || !contentRecoveryError(error)) throw error;
        // Validate even the fixed host notice against current rules. No raw content,
        // exception text or credentials are carried into the replacement.
        return transform(recoveryPaths.get(pointer), context, { data: true, budget });
      }
    };
    const visit = (item, pointer, depth, structuredData = data, proof, allowReferences = false) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof item === 'string') {
        allowReferences ||= trustedLeaves?.get(pointer) === item;
        bytes += Buffer.byteLength(item); if (bytes > 8 * 1024 * 1024) fail('aggregate_limit');
        // JSON tool outputs/arguments preserve escaping and detect sensitive structured fields.
        if (/^\s*[\[{]/.test(item) && !item.startsWith(PREFIX)) {
          let parsed; try { parsed = JSON.parse(item); } catch { /* ordinary prose */ }
          if (parsed && typeof parsed === 'object') { inspectParsed(parsed, depth + 1); return protectJson(item, depth + 1, proof, allowReferences); }
        }
        if (item.startsWith('data:') || /\/(?:image|audio|video)(?:_url)?(?:\/url)?$/.test(pointer)) fail('media_not_supported');
        const result = protectString(item, context, pointer, raw && !allowReferences, budget, proof);
        if (!structuredData && /\/(?:model|role|type|id|call_id|tool_call_id|name|signature)$/.test(pointer) && result !== item) fail('control_field_sensitive');
        if (!structuredData && /\/(?:thinking|signature|encrypted_content)$/.test(pointer) && item) fail('opaque_content_not_supported');
        return result;
      }
      if (item === null || typeof item === 'boolean' || typeof item === 'object') assertTypedField(pointer, item, !structuredData);
      if ((item === null || typeof item === 'boolean') && detect(String(item)).length) fail('typed_sensitive');
      if (Array.isArray(item)) return item.map((row, i) => walk(row, pointer + '/' + i, depth + 1, structuredData));
      if (item && typeof item === 'object') {
        if (mediaShape(item)) fail('media_not_supported');
        if (!structuredData && (item.type === 'redacted_thinking' || (item.type === 'reasoning' && item.encrypted_content))) fail('opaque_content_not_supported');
        const result = Object.create(null);
        for (const [key, row] of Object.entries(item)) {
          const protectedKey = protectString(key, context, '', raw, budget);
          if (!structuredData && protectedKey !== key) fail('control_field_sensitive');
          const nextKey = structuredData ? protectedKey : key;
          if (Object.hasOwn(result, nextKey)) fail('key_collision');
          result[nextKey] = walk(row, pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1, structuredData || (item.type === 'tool_use' && key === 'input'));
        }
        return result;
      }
      if (typeof item === 'number' && detect(String(item), pointer).length) fail('numeric_sensitive');
      return item;
    };
    return walk(value, '', 0, data, proof);
  }
  const historyBindings = new WeakMap();
  const HISTORY_REFUSED = '[Local privacy validation refused an unavailable reference in an earlier model message. No value was recovered; inspect the original local transcript and tool error before retrying.]';
  const HISTORY_USER_REFUSED = '[A historical input contains a local privacy reference that is no longer usable. Its content is unavailable in this model view. Do not retry its former operation; follow the current user instruction.]';
  const historyReferenceError = error => ['privacy.reference_unknown', 'privacy.reference_expired', 'privacy.reference_revoked', 'privacy.reference_malformed', 'privacy.credential_context'].includes(error?.code);
  function bindHostHistory(owner, history) {
    const context = active(); if (!context) return;
    if (!owner || typeof owner !== 'object' || !Array.isArray(history)) fail('history_projection_invalid');
    historyBindings.set(owner, { scope: context.scope, historicalUsers: new WeakSet(history.filter(row => row && row.role === 'user')),
      strictUsers: new Set(), originals: new WeakMap() });
  }
  function projectHistoryCopy(history, scope, binding) {
    let nodes = 0, bytes = 0;
    const fieldDetector = core.createDetector();
    const inspect = (value, pointer = '', depth = 0) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof value === 'string') {
        if ((bytes += Buffer.byteLength(value)) > 8 * 1024 * 1024) fail('aggregate_limit');
        if (/^\s*[\[{"]/.test(value)) {
          let valid = false; try { JSON.parse(value); valid = true; } catch { /* ordinary prose */ }
          if (valid) {
            let cursor = 0, bad = false;
            const space = () => { while (/\s/.test(value[cursor] || '') && cursor < value.length) cursor++; };
            const quoted = () => { const start = cursor++; while (cursor < value.length) { const char = value[cursor++]; if (char === '\\') cursor++; else if (char === '"') break; } return JSON.parse(value.slice(start, cursor)); };
            const walk = (at, level) => {
              if (++nodes > 50000 || level > 32) fail('structure_limit');
              space();
              if (value[cursor] === '"') { bad = inspect(quoted(), at, level + 1) || bad; return; }
              if (value[cursor] === '{') {
                cursor++; space(); if (value[cursor] === '}') { cursor++; return; }
                while (cursor < value.length) { space(); const key = quoted(); bad = inspect(key, '', level + 1) || bad; space(); cursor++; walk(at + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'), level + 1); space(); if (value[cursor++] === '}') return; }
              } else if (value[cursor] === '[') {
                cursor++; space(); let index = 0; if (value[cursor] === ']') { cursor++; return; }
                while (cursor < value.length) { walk(at + '/' + index++, level + 1); space(); if (value[cursor++] === ']') return; }
              } else while (cursor < value.length && !/[\s,\]}]/.test(value[cursor])) cursor++;
            };
            walk(pointer, depth + 1); return bad;
          }
        }
        if (!value.includes(PREFIX)) {
          // Canonical user text can still hold originals issued before revocation/expiry.
          // History removes that unavailable text; new inputs retain the strict refusal.
          try { if (scope) scope.detectLearned(value); return false; }
          catch (error) { if (historyReferenceError(error)) return true; throw error; }
        }
        try {
          if (!scope) fail('reference_unknown');
          scope.validateProtected(value);
          const credentials = fieldDetector.detect(value, { pointer }).filter(span => span.category === 'CREDENTIAL');
          for (const ref of value.matchAll(pattern())) if (credentials.some(span => credentialContext(span, ref.index, ref.index + ref[0].length))) scope.validateProtected(ref[0], { requiredCategory: 'CREDENTIAL' });
          return false;
        } catch (error) { if (historyReferenceError(error)) return true; throw error; }
      }
      if (Array.isArray(value)) { let bad = false; for (let i = 0; i < value.length; i++) bad = inspect(value[i], pointer + '/' + i, depth + 1) || bad; return bad; }
      if (value && typeof value === 'object') { let bad = false; for (const [key, row] of Object.entries(value)) { bad = inspect(key, '', depth + 1) || bad; bad = inspect(row, pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1) || bad; } return bad; }
      return false;
    };
    const narration = value => typeof value === 'string' ? (inspect(value) ? HISTORY_REFUSED : value) : Array.isArray(value) ? value.map(part => {
      if (!part || typeof part !== 'object') return part;
      const next = { ...part };
      for (const key of ['text', 'thinking']) if (typeof part[key] === 'string' && inspect(part[key])) next[key] = HISTORY_REFUSED;
      if (part.type === 'tool_use' && inspect(part.input)) next.input = {};
      return next;
    }) : value;
    return history.map(message => {
      if (!message || typeof message !== 'object') return message;
      let next = message;
      if (message.role === 'user') {
        const fingerprint = JSON.stringify(message.content);
        if (!binding.historicalUsers.has(message)) {
          if (inspect(message.content)) fail('reference_unknown');
          binding.strictUsers.add(fingerprint);
        } else if (inspect(message.content)) next = { ...message, content: HISTORY_USER_REFUSED };
      } else if (message.role === 'assistant') {
        next = { ...message };
        for (const key of ['content', 'reasoning_content', 'thinking', 'providerBlocks']) if (Object.hasOwn(message, key)) next[key] = narration(message[key]);
        if (Array.isArray(message.tool_calls)) next.tool_calls = message.tool_calls.map(call => {
          if (!call?.function || !inspect(call.function.arguments)) return call;
          return { ...call, function: { ...call.function, arguments: '{}' } };
        });
        if (Object.keys(next).every(key => next[key] === message[key])) next = message;
      } else if (message.role === 'tool' && inspect(message.content)) next = { ...message, content: JSON.stringify({ ok: false, code: 'privacy.reference_unavailable_history', error: HISTORY_REFUSED }) };
      if (next !== message) binding.originals.set(next, message);
      return next;
    });
  }
  function projectHostHistory(owner, history) {
    const context = active();
    if (!context) {
      const copies = historyBindings.get(owner)?.offCopies;
      return copies ? history.map(message => copies.get(message) || message) : history;
    }
    assertPolicyAvailable();
    const binding = historyBindings.get(owner);
    if (!binding || binding.scope !== context.scope || !Array.isArray(history)) fail('history_projection_invalid');
    return projectHistoryCopy(history, context.scope, binding);
  }
  function restoreHostHistoryProjection(owner, history, compacted = false) {
    const binding = historyBindings.get(owner); if (!binding) return history;
    return history.map(message => {
      const original = binding.originals.get(message); if (original) return original;
      if (compacted && message?.role === 'user' && !binding.strictUsers.has(JSON.stringify(message.content))) binding.historicalUsers.add(message);
      return message;
    });
  }
  async function protectHostHistory(owner, history) {
    const projected = projectHostHistory(owner, history), context = active();
    if (!context) return projected;
    // Scan complete structured sources before summaries add tags, extract facts or
    // truncate text. A JSON Pointer rule must still see its original decoded object.
    const result = await protectedTransform(projected, context, { recoveryPaths: contentRecoveryPaths(projected) });
    await context.persist(); assertPolicyAvailable();
    return result;
  }
  function bindRestoredHostHistory(owner, original, restored) {
    if (active() || !Array.isArray(original) || !Array.isArray(restored) || original.length !== restored.length) fail('history_projection_invalid');
    const offCopies = new WeakMap();
    original.forEach((message, i) => { if (message && typeof message === 'object') offCopies.set(message, restored[i]); });
    historyBindings.set(owner, { offCopies });
  }
  const beforeRequest = body => prepareRequest(body, false);
  const beforeModelRequest = body => prepareRequest(body, true);
  async function prepareRequest(body, recoverContent) {
    assertPolicyAvailable();
    const context = active();
    if (!context) {
      if (currentPolicy.mode !== 'off') return run('auxiliary', currentPolicy.config, () => prepareRequest(body, recoverContent));
      return body;
    }
    if (context.policy !== currentPolicy.signature) fail('policy_changed');
    if ((body.tools || []).some(tool => tool.type && !['function', 'custom'].includes(tool.type))) fail('server_tools_not_supported');
    // Models sometimes abbreviate a reference in their narration/reasoning. Only host
    // protocol narration slots get this repair; user/tool data and tool arguments must
    // still reject forged markers. Replace just the malformed prefix, never its tail,
    // so adjacent private text remains subject to the complete detector/worker scan.
    const narration = narrationText => {
      if (typeof narrationText !== 'string' || !narrationText.includes(PREFIX)) return narrationText;
      let result = '', from = 0; const token = new RegExp(pattern().source, 'y');
      while (from < narrationText.length) {
        const at = narrationText.indexOf(PREFIX, from); if (at < 0) break;
        result += narrationText.slice(from, at);
        token.lastIndex = at; const match = token.exec(narrationText);
        if (match?.index === at) { result += match[0]; from = at + match[0].length; }
        else { result += '[invalid local privacy reference]'; from = at + PREFIX.length; }
      }
      return result + narrationText.slice(from);
    };
    const textParts = (parts, type) => Array.isArray(parts) ? parts.map(part => part && part.type === type && typeof part.text === 'string' ? { ...part, text: narration(part.text) } : part) : parts;
    const narrationBody = { ...body };
    if (Array.isArray(body.messages)) narrationBody.messages = body.messages.map(message => {
      if (!message || message.role !== 'assistant') return message;
      return { ...message,
        ...(typeof message.content === 'string' ? { content: narration(message.content) } : Array.isArray(message.content) ? { content: textParts(message.content, 'text') } : {}),
        ...(typeof message.reasoning_content === 'string' ? { reasoning_content: narration(message.reasoning_content) } : {}) };
    });
    if (Array.isArray(body.input)) narrationBody.input = body.input.map(item => {
      if (!item || typeof item !== 'object') return item;
      if (item.type === 'reasoning') return { ...item, content: textParts(item.content, 'reasoning_text') };
      if (item.type === 'message' && item.role === 'assistant') return { ...item, content: textParts(item.content, 'output_text') };
      return item;
    });
    const instruction = 'Local privacy protection is enabled for this request. References with the RUYI_PVT marker are opaque local aliases, not the original values. Preserve each complete reference exactly: never decode, guess, shorten, translate, invent or reconstruct it. Use the reference unchanged in registered tool arguments when the user task needs its value. The local harness validates the reference and restores only the execution copy before ordinary tool permissions and destination checks; this grants no extra permission. Tool results are protected again before you receive them. In user-facing answers, keep applicable references unchanged: the local interface restores valid references for the user after your response leaves the model, without exposing originals to you. Do not claim that restoration is impossible or ask the user to reveal a secret merely because you see a reference. You cannot perform calculations, inspect characters or infer properties of a hidden value: use an appropriate authorized local tool if needed, otherwise explain that limitation. References are bound to this conversation and can expire or be revoked; never reuse them in another conversation or attempt to bypass an unavailable reference.';
    const recoveryInstruction = ' Internal privacy notices, unavailable-history notices and RUYI_LOCAL_DATA_WITHHELD mean only that local content was omitted. Never copy these diagnostics as your final answer. Continue the current task with available information or explain the specific missing input in ordinary language. A tool may already have completed its side effects before its result was withheld: do not repeat writes, commands, payments or external requests merely to recover hidden data. Do not reconstruct hidden values through character probes or encodings.';
    let prepared = narrationBody;
    if (Array.isArray(body.messages)) {
      if (Object.hasOwn(body, 'system')) prepared.system = typeof body.system === 'string' ? instruction + recoveryInstruction + '\n' + body.system : [{ type: 'text', text: instruction + recoveryInstruction }, ...(body.system || [])];
      else prepared.messages = [{ role: 'system', content: instruction + recoveryInstruction }, ...narrationBody.messages];
    } else if (Array.isArray(body.input)) prepared.instructions = instruction + recoveryInstruction + '\n' + String(body.instructions || '');
    const result = await protectedTransform(prepared, context, { trustedToolSchemas: true, ...(recoverContent ? { recoveryPaths: contentRecoveryPaths(prepared) } : {}) });
    // Commit the map before a network call can expose its references, including on retries.
    await context.persist(); assertPolicyAvailable();
    if (context.policy !== currentPolicy.signature) fail('policy_changed');
    return result;
  }
  async function projectSource(source, allowExistingReferences = false) {
    assertPolicyAvailable();
    const context = active(); if (!context) return null;
    if (context.policy !== currentPolicy.signature) fail('policy_changed');
    if (typeof source !== 'string' || Buffer.byteLength(source) > core.LIMITS.bytes) fail('source_limit');
    const work = context.sourceWork ||= { bytes: 0, files: 0, budget: core.createMatchBudget() };
    const bytes = Buffer.byteLength(source);
    if (work.files >= 128 || work.bytes + bytes > 8 * 1024 * 1024) fail('source_limit');
    work.files++; work.bytes += bytes;
    const proof = { edits: [], covered: [], references: false };
    // File/tool sources remain strict raw data. Only explicit host narration callers may
    // retain already-registered references; protectString still validates their scope/category.
    const projectedText = await protectedTransform(source, context, { raw: allowExistingReferences !== true, data: true, proof, budget: work.budget });
    let rendered = '', from = 0;
    const edits = proof.edits.slice().sort((a, b) => a.start - b.start);
    for (const edit of edits) {
      if (!Number.isSafeInteger(edit.start) || !Number.isSafeInteger(edit.end) || edit.start < from || edit.end < edit.start || edit.end > source.length) fail('source_proof_invalid');
      rendered += source.slice(from, edit.start) + edit.replacement; from = edit.end;
    }
    if (rendered + source.slice(from) !== projectedText) fail('source_proof_invalid');
    const view = Object.freeze({ text: projectedText });
    sourceViews.set(view, { scope: context.scope, source, edits, covered: proof.covered, revision: context.scope.revision(), references: new Set([...projectedText.matchAll(pattern())].map(match => match[0])) });
    return view;
  }
  function validateSourceView(record, context) {
    if (!record || record.scope !== context.scope) fail('source_proof_invalid');
    if (record.revision === context.scope.revision()) return;
    const budget = context.sourceWork?.budget || core.createMatchBudget();
    for (const match of context.scope.detectLearned(record.source, { budget })) {
      if (!record.covered.some(span => match.start >= span.start && match.end <= span.end && (match.category !== 'CREDENTIAL' || span.category === 'CREDENTIAL'))) fail('source_view_stale');
    }
    record.revision = context.scope.revision();
  }
  function sliceSource(view, start, end) {
    const context = active(), record = sourceViews.get(view);
    if (!context || !record || record.scope !== context.scope) fail('source_proof_invalid');
    validateSourceView(record, context);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > record.source.length) fail('source_range_invalid');
    if (start === end) return { text: '', start, end };
    for (const edit of record.edits) if (start < edit.end && end > edit.start) { start = Math.min(start, edit.start); end = Math.max(end, edit.end); }
    for (const span of record.covered) if (span.reference && start < span.end && end > span.start) { start = Math.min(start, span.start); end = Math.max(end, span.end); }
    const offset = position => {
      let delta = 0;
      for (const edit of record.edits) { if (position < edit.end) break; delta += edit.replacement.length - (edit.end - edit.start); }
      return position + delta;
    };
    return { text: view.text.slice(offset(start), offset(end)), start, end };
  }
  function sourcePointer(value, pointer) {
    if (typeof pointer !== 'string' || !pointer.startsWith('/') || /~(?![01])/.test(pointer)) fail('source_proof_invalid');
    for (const part of pointer.slice(1).split('/').map(key => key.replace(/~1/g, '/').replace(/~0/g, '~'))) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) fail('source_proof_invalid');
      value = value[part];
    }
    return value;
  }
  function markSourceView(container, pointers, view) {
    const context = active(); if (!context) return container;
    const views = Object.freeze(Array.isArray(view) ? view.slice() : [view]), references = new Set();
    if (!views.length || views.length > 256 || !container || typeof container !== 'object' || !Array.isArray(pointers) || pointers.length > 1000) fail('source_proof_invalid');
    for (const item of views) {
      const record = sourceViews.get(item);
      if (!record || record.scope !== context.scope) fail('source_proof_invalid');
      validateSourceView(record, context);
      for (const token of record.references) references.add(token);
    }
    const pending = [];
    for (const pointer of pointers) {
      const projectedText = sourcePointer(container, pointer);
      if (typeof projectedText !== 'string') fail('source_proof_invalid');
      for (const input of regexInputs(projectedText)) {
        context.scope.validateProtected(input);
        if ([...input.matchAll(pattern())].some(match => !references.has(match[0]))) fail('source_proof_invalid');
      }
      pending.push([pointer, { text: projectedText, scope: context.scope, views }]);
    }
    const saved = sourceProofs.get(container) || new Map();
    for (const [pointer, value] of pending) saved.set(pointer, value);
    sourceProofs.set(container, saved); return container;
  }
  function sourceLeaves(value, context) {
    const leaves = new Map(), seen = new Set(); let nodes = 0;
    const visit = (item, pointer, depth) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (!item || typeof item !== 'object') return;
      if (seen.has(item)) fail('source_structure_invalid');
      seen.add(item);
      const saved = sourceProofs.get(item);
      if (saved) for (const [relative, proof] of saved) {
        if (proof.scope !== context.scope || sourcePointer(item, relative) !== proof.text) fail('source_view_changed');
        for (const view of proof.views) validateSourceView(sourceViews.get(view), context);
        leaves.set(pointer + relative, proof.text);
      }
      for (const [key, row] of Object.entries(item)) visit(row, pointer + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1'), depth + 1);
      seen.delete(item);
    };
    visit(value, '', 0); return leaves;
  }
  async function toolResult(value) {
    assertPolicyAvailable();
    const context = active(); if (!context) return value;
    const result = await protectedTransform(value, context, { raw: true, data: true, sourceProof: true });
    await context.persist(); assertPolicyAvailable();
    if (context.policy !== currentPolicy.signature) fail('policy_changed');
    return result;
  }
  async function modelToolResult(value) {
    try { return await toolResult(value); }
    catch (error) {
      if (!active() || !contentRecoveryError(error)) throw error;
      assertPolicyAvailable();
      return toolResult({ ok: false, privacyFiltered: true, resultUnavailable: true, operationMayHaveExecuted: true,
        code: 'privacy.tool_result_withheld', reason: error.code,
        message: '本机隐私保护未外发这一份工具结果。执行状态以本机工具记录为准，不要因结果缺失自动重做写入、命令或外部请求；可继续其它步骤，或改用更小的文本读取。' });
    }
  }
  async function preview(config, sample) {
    if (typeof sample !== 'string' || Buffer.byteLength(sample) > 64 * 1024) fail('preview_input_limit');
    PrivacyRegex.validateSchema(config.privacyRulesV1 || []);
    await PrivacyRegex.validate(config.privacyRulesV1 || []);
    if (!enabled(config)) return { protectedSample: sample, matches: [], ruleVersion: ruleVersion(config) };
    const scopeId = 'preview:' + cryptoApi.randomBytes(16).toString('hex'), detector = makeDetector(config);
    const scope = core.createScope({ scopeId, detector });
    const context = { scope, detector, scopeId, config, policy: currentPolicy.signature, trace: [] };
    try {
      return await local.run(context, async () => {
        const protectedSample = await protectedTransform(sample, context, { raw: true, data: true });
        return { protectedSample, matches: context.trace, ruleVersion: ruleVersion(config) };
      });
    } finally { scope.clear(); }
  }
  const ruleVersion = config => cryptoApi.createHash('sha256').update(JSON.stringify([core.ruleCatalogVersion || 1, config.privacyModeV1, config.privacyTechnicalV1, config.privacyRulesV1])).digest('hex').slice(0, 16);
  // Host-only, read-only display copies. Never pass their output to a model or mutate canonical history.
  // Ordinary text is identity, including the default disabled path; no vault key/map is created here.
  const DISPLAY_UNAVAILABLE = '[隐私引用不可用 / private reference unavailable]';
  const DISPLAY_LIMIT = '[隐私显示达到上限 / private display limit]';
  async function displayCacheKey(scopeId) {
    if (currentPolicy.mode !== 'off') return 'private';
    if (typeof scopeId !== 'string' || !scopeId || scopeId.length > 160) return '';
    const key = keyOf(scopeId);
    if (loaded.has(key)) return 'private';
    try { await fileApi.lstat(pathApi.join(host.data, 'privacy-scopes', key + '.json')); return 'private'; }
    catch (error) { return error.code === 'ENOENT' ? '' : 'private'; }
  }

  const DISPLAY_DIAGNOSTICS = [HISTORY_REFUSED, HISTORY_USER_REFUSED, DATA_WITHHELD];
  const displayDiagnosticText = () => String(currentPolicy.config?.locale || '').startsWith('en')
    ? 'Local privacy protection omitted part of the context. Completed actions remain in the tool records. Continue with available information or request a narrower text result; do not repeat completed actions automatically.'
    : '本机隐私保护已省略一段无法安全转译的内容。已执行操作保留在工具记录中；可以继续处理其它内容，或改用更小的文本结果，不要自动重复已执行的操作。';
  const displayDiagnostics = value => DISPLAY_DIAGNOSTICS.reduce((text, marker) => text.replaceAll(marker, displayDiagnosticText()), value);

  function displayContext(scopeId) {
    let scopePromise = null, temporary = null, closed = false, bytes = 0, nodes = 0, limited = false;
    const getId = () => typeof scopeId === 'function' ? scopeId() : scopeId;
    const eligible = async () => currentPolicy.mode !== 'off' || Boolean(await displayCacheKey(getId()));
    const scope = () => scopePromise ||= (async () => {
      const id = getId(); if (typeof id !== 'string' || !id || id.length > 160 || unavailable) return null;
      const key = keyOf(id), cached = loaded.get(key);
      if (cached) { try { return (await cached.promise).scope; } catch { return null; } }
      try {
        const file = pathApi.join(host.data, 'privacy-scopes', key + '.json');
        const stat = await fileApi.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return null;
        const encrypted = await host.makeStore(file, key).read();
        const state = JSON.parse(await core.configHooks.openLocal(encrypted, 'privacy-mapping', key));
        if (closed || unavailable) return null;
        temporary = core.createScope({ scopeId: id, detector: { detect: () => [] }, ttlMs: 365 * 86400000 });
        temporary.importState(state); return temporary;
      } catch { return null; }
    })();
    const account = value => {
      if (limited) return '';
      bytes += Buffer.byteLength(value);
      if (bytes > 8 * 1024 * 1024) { limited = true; return DISPLAY_LIMIT; }
      return value;
    };
    const reference = async token => {
      if (closed || limited) return '';
      if (unavailable) return DISPLAY_UNAVAILABLE;
      try {
        const value = await scope(); if (closed) return ''; if (!value || unavailable) return DISPLAY_UNAVAILABLE;
        return value.restoreForTool(token, { scopeId: getId(), tool: 'privacy_display', pointer: '/display',
          destination: 'local-user-interface', purpose: 'host-display-copy', allowCredentialEmbedding: true, authorize: () => true });
      } catch { return DISPLAY_UNAVAILABLE; }
    };
    const restoreDisplayText = async (value, json = false, depth = 0) => {
      if (typeof value !== 'string') return value;
      value = displayDiagnostics(value);
      const encodedJson = json && value.includes('\\') && /^\s*[\[{"]/.test(value);
      if (!value.includes(PREFIX) && !encodedJson) return value;
      if (!await eligible()) return value;
      if (closed || limited || ++nodes > 50000 || depth > 32 || Buffer.byteLength(value) > 1024 * 1024) return DISPLAY_LIMIT;
      // Preserve JSON escaping for steward/structured display text. Tool arguments never enter this API.
      if (json && /^\s*[\[{"]/.test(value)) {
        let valid = false; try { JSON.parse(value); valid = true; } catch { /* prose or partial JSON */ }
        if (valid) {
          const chunks = []; let from = 0;
          for (const match of value.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
            chunks.push(value.slice(from, match.index));
            if (/^\s*:/.test(value.slice(match.index + match[0].length))) {
              chunks.push(match[0]); from = match.index + match[0].length; continue;
            }
            const decoded = JSON.parse(match[0]);
            const restored = await restoreDisplayText(decoded, true, depth + 1);
            chunks.push(restored === decoded ? match[0] : JSON.stringify(restored));
            from = match.index + match[0].length;
          }
          chunks.push(value.slice(from));
          const output = chunks.join('');
          return Buffer.byteLength(output) > 1024 * 1024 ? account(DISPLAY_LIMIT) : output;
        }
      }
      if (!value.includes(PREFIX)) return value;
      const chunks = []; let from = 0, outputBytes = 0;
      const append = part => { outputBytes += Buffer.byteLength(part); if (outputBytes > 1024 * 1024) return false; chunks.push(part); return true; };
      while (from < value.length) {
        const at = value.indexOf(PREFIX, from); if (at < 0) { append(value.slice(from)); break; }
        if (!append(value.slice(from, at))) break;
        const end = value.indexOf(']]', at + PREFIX.length);
        const finish = end >= 0 && end - at <= 128 ? end + 2 : Math.min(value.length, at + 128);
        const token = value.slice(at, finish);
        const exact = /^\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]$/.test(token);
        if (!append(exact ? await reference(token) : DISPLAY_UNAVAILABLE)) break;
        from = finish;
      }
      if (outputBytes > 1024 * 1024) return account(DISPLAY_LIMIT);
      return account(chunks.join(''));
    };
    return { text: restoreDisplayText, reference, account, eligible, get limited() { return limited; }, close: () => { closed = true; temporary?.clear(); temporary = null; } };
  }
  async function displayText(scopeId, displayInput, options = {}) {
    if (typeof displayInput === 'string') displayInput = displayDiagnostics(displayInput);
    if (typeof displayInput !== 'string' || (!displayInput.includes(PREFIX) && !(options.json === true && displayInput.includes('\\') && /^\s*[\[{"]/.test(displayInput)))) return displayInput;
    const context = displayContext(scopeId);
    try { return await context.text(displayInput, options.json === true); } finally { context.close(); }
  }
  async function displayMessageCopies(context, messages) {
    if (!Array.isArray(messages)) return messages;
    let changed = false;
    const result = [];
    for (const message of messages) {
      if (!message || message.role !== 'assistant') { result.push(message); continue; }
      let next = message;
      const set = (key, value) => { if (value !== message[key]) { if (next === message) next = { ...message }; next[key] = value; } };
      for (const key of ['content', 'thinking']) if (typeof message[key] === 'string') set(key, await context.text(message[key], true));
      if (Array.isArray(message.segments)) set('segments', await displaySegments(context, message.segments));
      changed ||= next !== message; result.push(next);
    }
    return changed ? result : messages;
  }
  async function displaySegments(context, segments) {
    if (!Array.isArray(segments)) return segments;
    let changed = false; const result = [];
    for (const segment of segments) {
      if (segment && ['text', 'thinking'].includes(segment.type) && typeof segment.text === 'string') {
        const restoredText = await context.text(segment.text); if (restoredText !== segment.text) { result.push({ ...segment, text: restoredText }); changed = true; continue; }
      }
      result.push(segment);
    }
    return changed ? result : segments;
  }
  async function displayEnvelopeCopy(context, envelope) {
    if (!envelope || typeof envelope !== 'object') return envelope;
    let next = envelope;
    const set = (key, value) => { if (value !== envelope[key]) { if (next === envelope) next = { ...envelope }; next[key] = value; } };
    if (envelope.session && typeof envelope.session === 'object') {
      const messages = await displayMessageCopies(context, envelope.session.messages);
      if (messages !== envelope.session.messages) set('session', { ...envelope.session, messages });
    }
    if (envelope.liveTail && typeof envelope.liveTail === 'object') {
      let tail = envelope.liveTail;
      for (const key of ['text', 'full', 'thinking']) if (typeof tail[key] === 'string') {
        const value = await context.text(tail[key]); if (value !== tail[key]) tail = { ...tail, [key]: value };
      }
      set('liveTail', tail);
    }
    if (envelope.liveTurn && typeof envelope.liveTurn === 'object') {
      const segments = await displaySegments(context, envelope.liveTurn.segments);
      if (segments !== envelope.liveTurn.segments) set('liveTurn', { ...envelope.liveTurn, segments });
    }
    return next;
  }
  async function displayMessages(scopeId, messages) {
    const context = displayContext(scopeId); try { return await displayMessageCopies(context, messages); } finally { context.close(); }
  }
  async function displayEnvelope(scopeId, envelope) {
    const context = displayContext(scopeId); try { return await displayEnvelopeCopy(context, envelope); } finally { context.close(); }
  }
  function createDisplayStream(scopeId, emit) {
    const context = displayContext(scopeId), buffers = new Map(); let queue = Promise.resolve(), closed = false;
    const emitDisplayEvent = event => { if (!closed) return emit(event); };
    const flushBuffers = async channel => {
      for (const [key, pending] of buffers) {
        if (channel !== undefined && String(pending.event.subagentId || '') !== channel) continue;
        // An incomplete ordinary bracket/phrase is not evidence of an internal
        // diagnostic. Only complete diagnostics are translated by consume().
        if (pending.text) await emitDisplayEvent({ ...pending.event, text: pending.text.startsWith('[[RUYI') && await context.eligible() ? DISPLAY_UNAVAILABLE : pending.text });
        buffers.delete(key);
      }
    };
    const consume = async event => {
      const key = event.type + ':' + String(event.subagentId || ''), previous = buffers.get(key);
      let value = (previous?.text || '') + event.text, output = '', from = 0;
      while (from < value.length) {
        const referenceAt = value.indexOf(PREFIX, from);
        let diagnosticAt = -1, diagnostic;
        for (const marker of DISPLAY_DIAGNOSTICS) { const found = value.indexOf(marker, from); if (found >= 0 && (diagnosticAt < 0 || found < diagnosticAt)) { diagnosticAt = found; diagnostic = marker; } }
        const at = referenceAt < 0 ? diagnosticAt : diagnosticAt < 0 ? referenceAt : Math.min(referenceAt, diagnosticAt);
        if (diagnosticAt >= 0 && diagnosticAt === at) { output += value.slice(from, at) + displayDiagnosticText(); from = at + diagnostic.length; continue; }
        if (at < 0) {
          let keep = 0;
          for (const marker of [PREFIX, ...DISPLAY_DIAGNOSTICS]) for (let n = Math.min(marker.length - 1, value.length - from); n > keep; n--) if (value.endsWith(marker.slice(0, n))) { keep = n; break; }
          output += value.slice(from, value.length - keep); from = value.length - keep; break;
        }
        output += value.slice(from, at);
        const end = value.indexOf(']]', at + PREFIX.length);
        if (end < 0 && value.length - at < 128) { from = at; break; }
        const finish = end >= 0 && end - at <= 128 ? end + 2 : at + 128;
        const token = value.slice(at, finish);
        output += !await context.eligible() ? token : /^\[\[RUYI_PVT:[A-Z]+:[a-f0-9]{32}\]\]$/.test(token) ? await context.reference(token) : DISPLAY_UNAVAILABLE;
        from = finish;
        if (Buffer.byteLength(output) > 1024 * 1024) { output = DISPLAY_LIMIT; from = value.length; break; }
      }
      const pending = value.slice(from);
      if (pending) buffers.set(key, { text: pending, event }); else buffers.delete(key);
      if (output) { const restoredText = context.account(output); if (restoredText) await emitDisplayEvent({ ...event, text: restoredText }); }
    };
    const write = event => {
      if (closed) return queue;
      // The turn engine may append to its canonical messages before this queued
      // projection reaches I/O. Snapshot only display leaves at the host boundary.
      if (event?.type === 'session' && event.session && Array.isArray(event.session.messages)) {
        event = { ...event, session: { ...event.session, messages: event.session.messages.map(message => message?.role === 'assistant'
          ? { ...message, ...(Array.isArray(message.segments) ? { segments: message.segments.map(segment => segment && ['text', 'thinking'].includes(segment.type) ? { ...segment } : segment) } : {}) }
          : message) } };
      }
      queue = queue.then(async () => {
        if (event && ['assistant_delta', 'thinking_delta'].includes(event.type) && typeof event.text === 'string') {
          if (!buffers.size && !event.text.includes('[')) { await emitDisplayEvent(event); return; }
          if (!buffers.size && !await context.eligible()) {
            const diagnosticChunk = event.text || '';
            const diagnostic = DISPLAY_DIAGNOSTICS.some(marker => diagnosticChunk.includes(marker) ||
              Array.from({ length: Math.min(marker.length - 1, diagnosticChunk.length) }, (_, i) => i + 1).some(n => diagnosticChunk.endsWith(marker.slice(0, n))));
            if (!diagnostic) { await emitDisplayEvent(event); return; }
          }
          await consume(event); return;
        }
        // Raw SSE/debug and usage metadata can occur between *every* pair of
        // chunks; only actual narrative boundaries terminate a pending alias.
        if (event && ['session', 'steward_reply'].includes(event.type)) await flushBuffers();
        else if (event && ['tool_use', 'tool_result', 'result', 'error', 'assistant_end', 'turn_end'].includes(event.type)) {
          const channel = String(event.subagentId || '');
          await flushBuffers(!channel && ['result', 'error'].includes(event.type) ? undefined : channel);
        }
        let next = await displayEnvelopeCopy(context, event);
        if (event?.type === 'steward_reply') for (const key of ['say', 'why']) if (typeof event[key] === 'string') {
          const value = await context.text(event[key]); if (value !== event[key]) next = { ...next, [key]: value };
        }
        await emitDisplayEvent(next);
      });
      return queue;
    };
    return { write, flush: () => (queue = queue.then(flushBuffers)), close: () => { closed = true; buffers.clear(); context.close(); } };
  }
  // A user may disable privacy and continue a task whose *stored* tool history contains references.
  // Migrate that history once before constructing the next request; the disabled tool path stays identity.
  // This capability is for host-loaded history only, never for a new model/tool/user input.
  async function restoreHistory(scopeId, history, hostProjection = false) {
    let nodes = 0, bytes = 0;
    const couldContain = (value, depth = 0) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof value === 'string') {
        if ((bytes += Buffer.byteLength(value)) > 8 * 1024 * 1024) fail('aggregate_limit');
        if (value.includes(PREFIX)) return true;
        if (!value.includes('\\') || !/^\s*[\[{"]/.test(value)) return false;
        try { JSON.parse(value); } catch { return false; }
        // A JSON token may escape letters, brackets or a complete nested JSON payload.
        // Decode only valid string tokens, and do not touch the vault for unrelated Unicode JSON.
        for (const token of value.matchAll(/"(?:[^"\\]|\\[\s\S])*"/g)) {
          if (couldContain(JSON.parse(token[0]), depth + 1)) return true;
        }
        return false;
      }
      if (Array.isArray(value)) return value.some(row => couldContain(row, depth + 1));
      if (value && typeof value === 'object') return Object.entries(value).some(([key, row]) => couldContain(key, depth + 1) || couldContain(row, depth + 1));
      return false;
    };
    if (!couldContain(history)) return history;
    if (typeof scopeId !== 'string' || !scopeId || scopeId.length > 160) fail('scope_invalid');
    const key = keyOf(scopeId), cached = loaded.get(key);
    let scope, temporary = false;
    if (cached) scope = (await cached.promise).scope;
    else {
      const file = pathApi.join(host.data, 'privacy-scopes', key + '.json');
      try {
        const stat = await fileApi.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('mapping_invalid');
        const encrypted = await host.makeStore(file, key).read();
        const snapshot = JSON.parse(await core.configHooks.openLocal(encrypted, 'privacy-mapping', key));
        scope = core.createScope({ scopeId, detector: { detect: () => [] }, ttlMs: 365 * 86400000 });
        temporary = true; scope.importState(snapshot);
      } catch (error) {
        if (error.code === 'ENOENT' && hostProjection) {
          scope = core.createScope({ scopeId, detector: { detect: () => [] }, ttlMs: 365 * 86400000 }); temporary = true;
        } else if (error.code === 'ENOENT') fail('reference_unknown');
        else throw error;
      }
    }
    const restore = value => scope.restoreForTool(value, { scopeId, tool: 'privacy_history', pointer: '/history',
      destination: 'local-history', purpose: 'disabled-privacy-history', allowCredentialEmbedding: true, authorize: () => true });
    const restoreText = (value, depth = 0) => {
      if (depth > 32 || ++nodes > 50000) fail('structure_limit');
      if ((bytes += Buffer.byteLength(value)) > 8 * 1024 * 1024) fail('aggregate_limit');
      // Change only affected JSON string tokens. Leave whitespace, duplicate keys and long integers exact.
      if (/^\s*[\[{"]/.test(value)) {
        let valid = false; try { JSON.parse(value); valid = true; } catch { /* ordinary prose */ }
        if (valid) return value.replace(/"(?:[^"\\]|\\[\s\S])*"/g, token => {
          const decoded = JSON.parse(token);
          const restored = restoreText(decoded, depth + 1);
          return restored !== decoded ? JSON.stringify(restored) : token;
        });
      }
      if (!value.includes(PREFIX)) return value;
      try { return restore(value); }
      catch (error) { if (hostProjection && historyReferenceError(error)) return HISTORY_REFUSED; throw error; }
    };
    nodes = 0; bytes = 0;
    const walk = (value, depth = 0) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof value === 'string') {
        return restoreText(value);
      }
      if (Array.isArray(value)) return value.map(row => walk(row, depth + 1));
      if (value && typeof value === 'object') {
        const out = Object.create(null);
        for (const [name, row] of Object.entries(value)) {
          const next = restoreText(name);
          if (Object.hasOwn(out, next)) fail('key_collision');
          out[next] = walk(row, depth + 1);
        }
        return out;
      }
      return value;
    };
    try {
      if (hostProjection && Array.isArray(history.providerHistory)) {
        const binding = { historicalUsers: new WeakSet(history.providerHistory.filter(row => row?.role === 'user')), strictUsers: new Set(), originals: new WeakMap() };
        history = { ...history, providerHistory: projectHistoryCopy(history.providerHistory, scope, binding) };
      }
      return walk(history);
    } finally { if (temporary) scope.clear(); }
  }
  // Execution capabilities never travel in model data, JSON, history or MCP parameters.
  const executionCalls = new WeakMap(), executionInputs = new WeakMap(), executionLocal = new AsyncLocalStorage();
  const executionMessage = code => {
    if (code.startsWith('privacy.drive_probe_')) return '无法核实本地目的地，当前未派发；原数据保持不变。 Local destination could not be verified; nothing was dispatched and the source data is unchanged.';
    if (code === 'privacy.disclosure_not_supported' || code === 'privacy.disclosure_requires_planning') return '此工具尚未适配隐私原值，请改用已支持的本地文件或文本操作；重复代号不会增加授权。 This tool has no adapter for private original values. Use an explicitly supported local file/text operation; repeating this reference will not authorize a script, HTTP request or MCP service.';
    if (code === 'privacy.recipient_denied' || code === 'privacy.recipient_changed') return '目的地不是已核实的本地位置，或等待时发生了变化；当前未派发。 The private value destination is not a verified local recipient, or changed while waiting. No operation was dispatched. Choose a supported local file destination.';
    if (code === 'privacy.policy_changed') return '等待时隐私策略已改变；当前未派发，请按新策略重新发起。 Privacy policy changed while this call was waiting. No operation was dispatched; start a fresh call under the current policy.';
    if (code === 'privacy.execution_cancelled') return '此调用已在派发前取消。 This call was cancelled before dispatch.';
    return '隐私策略拒绝此输入，当前未派发；请核对本会话已有代号与拒绝原因。 Privacy policy refused this input. No operation was dispatched. Use an existing valid reference from this conversation and inspect the refusal before retrying.';
  };
  const executionRefusal = error => {
    const code = String(error.code || '').startsWith('privacy.') ? error.code : 'privacy.arguments_invalid';
    return { ok: false, code, error: executionMessage(code) };
  };
  function executionCheck(context, execution) {
    assertPolicyAvailable();
    if (active() !== context) fail('scope_changed');
    if (execution?.signal?.aborted) fail('execution_cancelled');
    // Unrelated mappings may be learned by parallel reads. Each bound reference is checked again at dispatch.
  }
  function containsExecutionReferences(value, context) {
    let nodes = 0, bytes = 0;
    const visit = (item, depth) => {
      if (++nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof item === 'string') { if ((bytes += Buffer.byteLength(item)) > 8 * 1024 * 1024) fail('aggregate_limit'); if (context && item.includes(PREFIX)) context.scope.validateProtected(item); return item.includes(PREFIX); }
      if (Array.isArray(item)) return item.reduce((found, row) => visit(row, depth + 1) || found, false);
      if (item && typeof item === 'object') return Object.entries(item).reduce((found, [key, row]) => visit(key, depth + 1) || visit(row, depth + 1) || found, false);
      return false;
    };
    return visit(value, 0);
  }
  function restoreArgs(name, args, context, contract, state = { nodes: 0, bytes: 0 }, level = 0) {
    const segment = key => key.replace(/~/g, '~0').replace(/\//g, '~1');
    const walk = (value, pointer, depth) => {
      if (++state.nodes > 50000 || depth > 32) fail('structure_limit');
      if (typeof value === 'string' && (state.bytes += Buffer.byteLength(value)) > 8 * 1024 * 1024) fail('aggregate_limit');
      if (typeof value === 'string' && value.includes(PREFIX)) {
        return context.scope.restoreForTool(value, { scopeId: context.scopeId, tool: name, pointer,
          destination: contract?.recipient || 'unadapted', purpose: contract?.purpose || 'unadapted', allowCredentialEmbedding: contract?.credentialEmbedding === true,
          authorize: ref => { if (!contract) fail('disclosure_not_supported'); return contract.authorize(ref) === true; } });
      }
      if (Array.isArray(value)) return value.map((row, i) => walk(row, pointer + '/' + i, depth + 1));
      if (value && typeof value === 'object') {
        const output = Object.create(null);
        for (const [key, row] of Object.entries(value)) {
          const nextKey = walk(key, pointer + '/@key', depth + 1);
          if (Object.hasOwn(output, nextKey)) fail('key_collision');
          output[nextKey] = walk(row, pointer + '/' + segment(key), depth + 1);
        }
        return output;
      }
      return value;
    };
    return walk(args, '', level);
  }
  // Synchronous compatibility is deliberately strict. Tool registration is not disclosure authority.
  function prepareCall(call) {
    try {
      assertPolicyAvailable(); if (!active()) return call;
      const args = JSON.parse(call.rawArgs);
      if (containsExecutionReferences(args)) fail('disclosure_requires_planning');
      return call;
    } catch (error) { return { ...call, privacyError: executionRefusal(error) }; }
  }
  async function prepareExecution(call, execution = {}) {
    const context = active();
    try {
      assertPolicyAvailable(); if (!context) return call;
      const source = JSON.parse(call.rawArgs);
      if (!containsExecutionReferences(source, context)) return call;
      executionCheck(context, execution);
      const prepare = async (name, args, depth = 0) => {
        if (depth > 32) fail('structure_limit');
        if (/^tool_invoke_(?:read|edit|exec|ask)$/.test(name)) {
          const normalized = typeof host.normalizeToolInvokeArgs === 'function' ? host.normalizeToolInvokeArgs(args) : args;
          const target = String(normalized.name || normalized.tool || '').trim();
          if (!target || target.includes(PREFIX)) fail('disclosure_not_supported');
          let inner = normalized.arguments || normalized.args || {};
          if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { fail('arguments_invalid'); } }
          const nested = await prepare(target, inner, depth + 1);
          const output = { ...normalized, ...(typeof normalized.name === 'string' ? { name: target, arguments: nested.args } : { tool: target, args: nested.args }) };
          return { args: output, plans: nested.plans };
        }
        if (execution.bridge || execution.resolveBridge?.(name)) fail('disclosure_not_supported');
        if (typeof host.planDisclosure !== 'function') fail('disclosure_not_supported');
        // Only the host planner may ask to resolve its adapter's path slots. No handler receives this private copy.
        const plan = await host.planDisclosure(name, args, execution, (value, pointer) => context.scope.restoreForTool(value, {
          scopeId: context.scopeId, tool: name, pointer, destination: 'host-private-path-planner', purpose: 'resolve-recipient',
          allowCredentialEmbedding: true, authorize: () => true,
        }));
        executionCheck(context, execution);
        if (!plan || typeof plan.authorize !== 'function') fail('disclosure_not_supported');
        const restored = restoreArgs(name, args, context, plan);
        const record = { context, execution, name, source: args, plan, planner: host.planDisclosure, snapshot: JSON.stringify(restored) };
        executionInputs.set(restored, record);
        return { args: restored, plans: [record] };
      };
      const prepared = await prepare(call.name, source);
      executionCheck(context, execution);
      const result = { ...call, rawArgs: JSON.stringify(prepared.args) };
      executionCalls.set(result, prepared.args);
      if (!executionInputs.has(prepared.args)) executionInputs.set(prepared.args, { context, execution, name: call.name, nested: prepared.plans, snapshot: JSON.stringify(prepared.args) });
      return result;
    } catch (error) { return { ...call, privacyError: executionRefusal(error) }; }
  }
  function executionArgs(call) {
    return executionCalls.get(call) || JSON.parse(call.rawArgs || '{}');
  }
  function updateExecutionInput(previous, next, name, execution = {}) {
    const context = active();
    if (!context || !next || typeof next !== 'object') return next;
    const record = executionInputs.get(previous);
    executionInputs.set(next, record ? { ...record, edited: true } : { context, execution, name, edited: true });
    return next;
  }
  function transferExecutionCall(previous, next) {
    const outer = executionCalls.get(previous);
    if (!outer || previous === next) return next;
    const inner = outer.arguments || outer.args;
    const record = inner && executionInputs.get(inner);
    if (record && record.name === next.name) executionCalls.set(next, inner);
    return next;
  }
  async function revalidateExecution(name, args, execution = {}) {
    const context = active(); assertPolicyAvailable(); if (!context) return args;
    let record = executionInputs.get(args);
    if (!record) {
      if (!containsExecutionReferences(args)) return args;
      const prepared = await prepareExecution({ name, rawArgs: JSON.stringify(args) }, execution);
      if (prepared.privacyError) throw Object.assign(new Error(prepared.privacyError.error), prepared.privacyError);
      args = executionArgs(prepared); record = executionInputs.get(args);
    }
    executionCheck(record.context, execution);
    if (record.name !== name || execution.bridge || record.execution.resolveBridge?.(name)) fail('recipient_changed');
    if (record.edited || JSON.stringify(args) !== record.snapshot) {
      // Permission edits are host input, but their new recipient/fields receive no inherited authority.
      const protectedInput = await protectedTransform(args, context, { raw: true, data: true });
      await context.persist(); executionCheck(context, execution);
      const prepared = await prepareExecution({ name, rawArgs: JSON.stringify(protectedInput) }, execution);
      if (prepared.privacyError) throw Object.assign(new Error(prepared.privacyError.error), prepared.privacyError);
      return executionArgs(prepared);
    }
    const records = record.nested || [record];
    for (const current of records) {
      executionCheck(current.context, execution);
      if (host.planDisclosure !== current.planner) fail('adapter_changed');
      await current.plan.revalidate(execution);
      executionCheck(current.context, execution);
      restoreArgs(current.name, current.source, current.context, current.plan); // revalidate expiry/revocation before dispatch
    }
    return args;
  }
  function assertExecution(name, args, execution = {}) {
    assertPolicyAvailable(); const record = executionInputs.get(args); if (!record) return;
    executionCheck(record.context, execution);
    if (name !== record.name || JSON.stringify(args) !== record.snapshot) fail('recipient_changed');
    for (const bound of record.nested || [record]) {
      if (host.planDisclosure !== bound.planner || bound.execution.resolveBridge?.(bound.name)) fail('recipient_changed');
      restoreArgs(bound.name, bound.source, bound.context, bound.plan);
      bound.plan.assertCurrent?.(execution);
    }
  }
  async function withExecution(name, args, execution, work) {
    const checked = await revalidateExecution(name, args, execution);
    if (!executionInputs.has(checked)) return work(checked);
    assertExecution(name, checked, execution);
    return executionLocal.run({ name, args: checked, execution }, () => work(checked));
  }
  function assertIo() {
    const current = executionLocal.getStore(); if (!current) return;
    assertExecution(current.name, current.args, current.execution);
  }
  async function beforeExecutionIo(targets, write, kind) {
    const current = executionLocal.getStore(); if (!current) return;
    const record = executionInputs.get(current.args); assertIo();
    const records = record.nested || [record];
    for (const bound of records) {
      if (host.planDisclosure !== bound.planner) fail('adapter_changed');
      if (bound.execution.resolveBridge?.(bound.name)) fail('recipient_changed');
      restoreArgs(bound.name, bound.source, bound.context, bound.plan);
      await bound.plan.beforeIo(targets, write, current.execution, kind);
      assertIo();
    }
  }
  function assertSupported(config, kind) { assertPolicyAvailable(config); if (enabled(config) && kind !== 'native') fail('engine_not_supported'); }
  const assertCliAllowed = () => assertSupported({ privacyModeV1: currentPolicy.mode }, 'cli');
  function assertToolChannel() { assertPolicyAvailable(); if (!active() && currentPolicy.mode !== 'off') fail('tool_channel_not_supported'); }
  function assertMediaAllowed(config) { assertPolicyAvailable(config); if (enabled(config) || currentPolicy.mode !== 'off') fail('media_not_supported'); }
  return Object.freeze({ enabled, configure, active, run, withPolicy, prepareLocalDisclosure, prepareMultiSourceDisclosure, createConnectionScope, disclosurePolicyGuard, prepareDisclosure, refreshDisclosure, assertDisclosure, foreignView, preview, ruleVersion, restoreHistory, bindHostHistory, bindRestoredHostHistory, projectHostHistory, protectHostHistory, restoreHostHistoryProjection, displayCacheKey, displayText, displayMessages, displayEnvelope, createDisplayStream, beforeRequest, beforeModelRequest, toolResult, modelToolResult, projectSource, sliceSource, markSourceView, prepareCall, prepareExecution, executionArgs, updateExecutionInput, transferExecutionCall, revalidateExecution, assertExecution, withExecution, beforeExecutionIo, assertIo, isExecutingOriginal: () => !!executionLocal.getStore(), assertSupported, assertCliAllowed, assertPolicyAvailable, assertMediaAllowed, assertToolChannel, markUnavailable: () => { setUnavailable(true); }, recoveryRequired: () => unavailable, setHost: value => Object.assign(host, value) });
})(require('node:crypto'), require('node:fs').promises, require('node:path'), require('node:async_hooks').AsyncLocalStorage, PrivacyCore, require('node:url').URL);
PrivacyCore.configHooks.configurePrivacy = PrivacyGateway.configure;
PrivacyCore.configHooks.assertCliAllowed = PrivacyGateway.assertCliAllowed;
PrivacyCore.configHooks.markPrivacyUnavailable = PrivacyGateway.markUnavailable;
