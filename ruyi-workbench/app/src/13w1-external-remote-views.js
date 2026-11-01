// Private C1 preparation owned by the existing external-bot lifecycle. No route,
// model capability, decision consumer, engine or durable store is created here.
const ExternalBotRemoteViews = (() => {
  const limits = Object.freeze({ views: 256, sourceBytes: 1048576, pageChars: 1600, pageBytes: 7000, pages: 1024 });
  const views = new Map(), lists = new Map(), snapshots = new WeakMap(), codes = new Map();
  const humans = new WeakMap(), payloads = new Map();
  const fail = () => { throw externalBotError('external_channel.request_invalid'); };
  const stale = () => { throw externalBotError('external_channel.delivery_changed', 409); };
  const digest = value => externalBotRemoteHash('source-view', value);
  const handle = () => 'rv_' + crypto.randomBytes(16).toString('base64url');
  const validHandle = value => typeof value === 'string' && /^r[vl]_[A-Za-z0-9_-]{21}[AQgw]$/.test(value);
  const viewOf = id => views.get(id) || lists.get(id);
  function answerJson(text) {
    let value; try { value = JSON.parse(text); } catch { return fail(); }
    // JSON.parse alone would silently accept duplicate object keys. Only token
    // structure is scanned here; original question semantics stay in13d.
    const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) || [], stack = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === '{') stack.push(new Set()); else if (token === '[') stack.push(null);
      else if (token === '}' || token === ']') stack.pop();
      else if (token[0] === '"' && tokens[i + 1] === ':') { const keys = stack.at(-1), key = JSON.parse(token); if (!keys || keys.has(key)) fail(); keys.add(key); }
    }
    if (!Array.isArray(value) || value.length < 1 || value.length > 3) fail();
    const seen = new Set();
    for (const row of value) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !['q', 'options', 'text'].includes(key))
        || !Number.isSafeInteger(row.q) || row.q < 1 || row.q > 3 || seen.has(row.q)) fail();
      seen.add(row.q);
      if (row.options !== undefined && (!Array.isArray(row.options) || row.options.length > 12 || row.options.some(n => !Number.isSafeInteger(n) || n < 1 || n > 12) || new Set(row.options).size !== row.options.length)) fail();
      if (row.text !== undefined && (typeof row.text !== 'string' || !row.text.trim() || row.text.length > 4000)) fail();
      if (!row.options?.length && !row.text?.trim()) fail();
    }
    return value;
  }
  function parse(text) {
    if (typeof text !== 'string' || !/^\s*\/(pending|decide|answer|revoke|action)\b/i.test(text)) return null;
    if (text.length > EXTERNAL_BOT_LIMITS.textChars || Buffer.byteLength(text) > EXTERNAL_BOT_LIMITS.textBytes || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) fail();
    const match = /^\s*\/(pending|decide|answer|revoke|action)(?:\s+([\s\S]*?))?\s*$/i.exec(text); if (!match) fail();
    const kind = match[1].toLowerCase(), tail = match[2] || '';
    if (kind === 'pending') {
      if (!tail) return { kind, handle: '', page: 1 };
      const parts = tail.split(/\s+/); if (parts.length > 2 || !validHandle(parts[0]) || parts[1] !== undefined && !/^[1-9][0-9]{0,3}$/.test(parts[1])) fail();
      const page = parts[1] === undefined ? 1 : Number(parts[1]); if (page > limits.pages) fail(); return { kind, handle: parts[0], page };
    }
    if (kind === 'action') { if (!validHandle(tail)) fail(); return { kind, handle: tail }; }
    const code = tail.split(/\s/, 1)[0]; externalBotRemoteCodeHash(code);
    const rest = tail.slice(code.length).trim();
    if (kind === 'revoke') { if (rest) fail(); return { kind, code }; }
    if (kind === 'decide') {
      const decision = /^(allow|deny|approve|reject)(?:\s+([\s\S]*))?$/.exec(rest); if (!decision || decision[2] && (!['approve', 'reject'].includes(decision[1]) || decision[2].length > 2000)) fail();
      return { kind, code, action: decision[1], ...(decision[2] ? { feedback: decision[2] } : {}) };
    }
    if (!rest || rest.length > 8192) fail();
    return { kind, code, answer: rest.startsWith('[') ? answerJson(rest) : rest.length <= 4000 ? rest : fail() };
  }
  function fileStamp(file) {
    const st = fs.lstatSync(file, { bigint: true }); if (!st.isFile() || st.isSymbolicLink()) stale();
    return [st.dev, st.ino, st.size, st.mtimeNs, st.ctimeNs].join(':');
  }
  async function readSource(sessionId, interventionId) {
    const assertConfig = configReadFence(), seq = sessionDiskWriteSeqOf(sessionId);
    const journal = interventionFilePath(sessionId), journalStamp = fileStamp(journal);
    const meta = await readInterventionsWithMeta(sessionId, { strict: true }); if (fileStamp(journal) !== journalStamp) stale();
    if (!meta || meta.degraded || meta.corruptLines || !Array.isArray(meta.interventions)) stale();
    const iv = meta.interventions.find(row => row.id === interventionId);
    if (!iv || iv.status !== 'pending' || iv.sessionId !== sessionId || !Object.hasOwn(EXTERNAL_BOT_REMOTE.actions, iv.type)) stale();
    const head = await readSessionHeadResilient(sessionId); if (!head || head.id !== sessionId) stale();
    const config = await readConfig(); assertConfig();
    let entry = null, live = null, run = null, detail, origin = null, assertFile = () => {};
    if (iv.type === 'permission' || iv.type === 'question' || iv.type === 'plan') {
      const registry = iv.type === 'permission' ? pendingPermissions : iv.type === 'question' ? pendingQuestions : pendingPlans;
      entry = registry.get(interventionId); if (!entry || entry.sessionId !== sessionId || entry.commandApplying) stale();
      origin = assertInterventionConsumer(entry);
      if (iv.type === 'permission') { if (!iv.input || typeof iv.input !== 'object' || Array.isArray(iv.input)) stale(); detail = { toolName: iv.toolName, input: iv.input, tier: iv.tier, revertible: iv.revertible === true }; }
      else if (iv.type === 'question') { if (!Array.isArray(iv.questions) || JSON.stringify(entry.questions) !== JSON.stringify(iv.questions)) stale(); detail = { questions: iv.questions, context: iv.context || '' }; }
      else { if (typeof entry.markdown !== 'string' || !entry.markdown) stale(); detail = { markdown: entry.markdown }; }
    } else {
      live = activeAgentRuns.get(iv.runId);
      if (live && !live.closing && live.run?.sessionId === sessionId) run = live.run;
      else if (iv.type === 'replan') {
        const file = agentRunFile(sessionId, iv.runId), before = fileStamp(file); run = await readAgentRunSnapshot(sessionId, iv.runId); assertFile = () => { if (fileStamp(file) !== before) stale(); }; assertFile();
      }
      if (!run || run.sessionId !== sessionId || iv.type === 'pool' && (!live || live.closing || live.stopRequested || live.ctrl?.signal?.aborted || run.status === 'paused')) stale();
      detail = (iv.type === 'pool' ? run.taskPool : run.replanPatches)?.find(row => row.id === interventionId);
      if (!detail || detail.status !== (iv.type === 'pool' ? 'proposed' : 'pending') || iv.type === 'replan' && (!Array.isArray(detail.changes) || !detail.changes.length)) stale();
    }
    const runNodes = run?.nodes, nodePointers = runNodes?.slice(), proposer = iv.type === 'pool' && runNodes?.find(node => node.id === detail.proposedBy);
    // Only the live pool's reporting clock/log may change during a shown
    // decision. Preserve every other proposer field, including lifecycle and
    // unknown future semantics, as well as its exact object identity below.
    const proposerAuthorityOf = () => proposer && JSON.stringify(Object.fromEntries(Object.entries(proposer)
      .filter(([key]) => key !== 'progressLog' && key !== 'lastActivityAt')));
    const proposerMaterial = proposerAuthorityOf(), admitPoolNode = live?.admitPoolNode, budgetReader = live?.poolDecisionBudget;
    const budgetProof = iv.type === 'pool' && Number(run?.originTurnAgentCap) > 0 ? budgetReader?.() : null;
    if (iv.type === 'pool' && Number(run?.originTurnAgentCap) > 0 && (!budgetProof || typeof budgetProof.assert !== 'function')) stale();
    const decisionRunOf = () => run && ({ poolPolicy: run.poolPolicy, poolAutoCap: run.poolAutoCap, originTurnAgentCap: run.originTurnAgentCap,
      permissionModeAtLaunch: run.permissionModeAtLaunch, permissionMode: run.permissionMode, permissionCeiling: run.permissionCeiling, cwd: run.cwd,
      nodes: run.nodes?.map(node => ({ id: node.id, task: node.task, dependsOn: node.dependsOn, engine: node.engine, toolTier: node.toolTier, model: node.model,
        maxIters: node.maxIters, roleId: node.roleId, roleSnapshot: node.roleSnapshot, resources: node.resources, isolationMode: node.isolationMode, fromPool: node.fromPool, proposedBy: node.proposedBy })) });
    const decisionRunMaterial = JSON.stringify(decisionRunOf());
    const full = { type: iv.type, title: head.title || '', detail };
    // saveAgentRun updates this clock on ordinary throttled progress saves.
    // It is not a live pool authority revision. Replan, including cold file
    // snapshots, keeps the original timestamp and file-identity protection.
    const authorityOf = () => ({ intervention: iv, run: run && { id: run.id, status: run.status,
      ...(iv.type === 'pool' && live ? {} : { updatedAt: run.updatedAt }), revision: run.revision, permissionMode: run.permissionMode, permissionCeiling: run.permissionCeiling }, head, config });
    const authority = authorityOf(), authorityMaterial = JSON.stringify(authority);
    const fingerprint = digest([full, authority, decisionRunOf(), budgetProof?.material]); if (Buffer.byteLength(JSON.stringify([full, authority])) > limits.sourceBytes) fail();
    const entryMaterial = entry && (iv.type === 'question' ? JSON.stringify(entry.questions) : iv.type === 'plan' ? entry.markdown : null), detailMaterial = JSON.stringify(detail);
    const assert = () => {
      assertConfig(); assertFile(); if (fileStamp(journal) !== journalStamp || sessionDiskWriteSeqOf(sessionId) !== seq || JSON.stringify(authorityOf()) !== authorityMaterial) stale();
      if (entry) { const registry = iv.type === 'permission' ? pendingPermissions : iv.type === 'question' ? pendingQuestions : pendingPlans;
        if (registry.get(interventionId) !== entry || entry.commandApplying || (iv.type === 'question' ? JSON.stringify(entry.questions) !== entryMaterial : iv.type === 'plan' ? entry.markdown !== entryMaterial : false)) stale();
        if (typeof entry.assertAuthority === 'function') entry.assertAuthority();
      }
      if (live && (activeAgentRuns.get(iv.runId) !== live || live.run !== run || live.closing || live.stopRequested || live.ctrl?.signal?.aborted || iv.type === 'pool' && live.run?.status === 'paused' || JSON.stringify((iv.type === 'pool' ? live.run?.taskPool : live.run?.replanPatches)?.find(row => row.id === interventionId)) !== detailMaterial)) stale();
    };
    const liveControl = live?.ctrl, liveSignal = liveControl?.signal;
    const assertOrigin = () => {
      assertConfig(); assertFile();
      if (JSON.stringify(decisionRunOf()) !== decisionRunMaterial || run && (run.nodes !== runNodes || run.nodes?.some((node, index) => node !== nodePointers[index]))
        || proposerAuthorityOf() !== proposerMaterial || live && (live.admitPoolNode !== admitPoolNode || live.poolDecisionBudget !== budgetReader)) stale();
      budgetProof?.assert();
      if (sessionDiskWriteSeqOf(sessionId) !== seq || JSON.stringify(authorityOf()) !== authorityMaterial) stale();
      if (entry) {
        const registry = iv.type === 'permission' ? pendingPermissions : iv.type === 'question' ? pendingQuestions : pendingPlans;
        if (registry.get(interventionId) !== entry || entry.commandApplying || assertInterventionConsumer(entry) !== origin
          || (iv.type === 'question' ? JSON.stringify(entry.questions) !== entryMaterial : iv.type === 'plan' ? entry.markdown !== entryMaterial : false)) stale();
        if (typeof entry.assertAuthority === 'function') entry.assertAuthority();
      }
      if (live && (live.ctrl !== liveControl || liveSignal?.aborted || activeAgentRuns.get(iv.runId) !== live || live.run !== run || live.closing || live.stopRequested || live.ctrl?.signal?.aborted
        || iv.type === 'pool' && live.run?.status === 'paused' || JSON.stringify((iv.type === 'pool' ? live.run?.taskPool : live.run?.replanPatches)?.find(row => row.id === interventionId)) !== detailMaterial)) stale();
    };
    const journalProof = await readInterventionJournalProof(sessionId);
    if (journalProof.kind !== 'present') stale();
    assert(); assertOrigin(); journalProof.assert();
    const ticket = Object.freeze({}); snapshots.set(ticket, { sessionId, interventionId, iv: structuredClone(iv), full: structuredClone(full), fingerprint, assert, assertOrigin, journalProof, deadline: Number(entry?.deadlineAt) || 0 }); return ticket;
  }
  async function audience(connection, item) {
    if (item.conversationType === 'direct') return { revision: '', assert: () => {} };
    // The platform adapter must prove a continuous audience revision, not a member
    // hash. No adapter currently supplies the external docs66:118 contract.
    const proof = await ExternalChannelProtocols.prepareAudienceRevision?.(connection, item.conversationId);
    if (!proof || !externalBotRemoteDigest(proof.revision) || typeof proof.assert !== 'function') stale();
    proof.assert(); return proof;
  }
  function typedDecision(parsed, source) {
    const type = source.iv.type;
    if (type === 'question') {
      if (parsed.kind !== 'answer') fail();
      const questions = source.iv.questions;
      const rows = typeof parsed.answer === 'string'
        ? questions.length === 1 && questions[0].answerMode === 'text' ? [{ q: 1, text: parsed.answer }] : fail()
        : parsed.answer;
      const answers = rows.map(row => {
        const question = questions[row.q - 1]; if (!question) fail();
        const selectedOptionIds = (row.options || []).map(index => { const option = question.options[index - 1]; if (!option) fail(); return option.id; });
        return { questionId: question.id, selectedOptionIds, ...(row.text ? { otherText: row.text } : {}) };
      });
      const payload = { action: 'answer', answer: { answers } }, normalized = normalizeContractQuestionDecision(payload, questions);
      if (!normalized.ok) fail();
      return { payload, decisionPayload: { action: 'answer', answer: normalized.answer } };
    }
    if (parsed.kind !== 'decide' || !EXTERNAL_BOT_REMOTE.actions[type].includes(parsed.action) || parsed.feedback !== undefined && type !== 'plan') fail();
    const payload = { action: parsed.action, ...(parsed.feedback !== undefined ? { feedback: parsed.feedback } : {}) };
    return { payload, decisionPayload: payload };
  }
  async function phaseProof(source, command, phase) {
    const proof = await readInterventionJournalProof(source.sessionId), initial = source.journalProof;
    if (proof.kind !== 'present' || proof.identity !== initial.identity || !proof.text.startsWith(initial.text)) stale();
    const tail = proof.text.slice(initial.text.length), lines = tail.split('\n').filter(Boolean);
    if (phase === 'pending') { if (tail !== '') stale(); }
    else {
      if (lines.length !== 1 || tail !== lines[0] + '\n') stale();
      const iv = source.iv, expected = { id: iv.id, sessionId: source.sessionId,
        ...(iv.type ? { type: iv.type } : {}), ...(iv.requestedAt ? { requestedAt: iv.requestedAt } : {}),
        ...(iv.toolName ? { toolName: iv.toolName } : {}), ...(iv.tier ? { tier: iv.tier } : {}), status: 'applying', decidedAt: '', decidedBy: '',
        interventionVersion: command.expectedVersion + 1, source: 'external_human', idempotencyKey: command.idempotencyKey, decisionFingerprint: command.decisionFingerprint };
      if (JSON.stringify(canonicalDecisionValue(JSON.parse(lines[0]))) !== JSON.stringify(canonicalDecisionValue(expected))) stale();
    }
    return proof;
  }
  async function admitVerified(ticket, state, item) {
    const verified = externalBotVerifiedIngressTickets.get(ticket); externalBotVerifiedIngressTickets.delete(ticket);
    if (!verified || verified.bootId !== OVERLAY_ID || verified.sourceKey !== item.sourceKey || verified.contentHash !== item.contentHash
      || verified.connectionFingerprint !== externalBotConnectionFingerprint(verified.connection) || !externalBotRemoteDigest(verified.bodyHash)) stale();
    const { message, connection, credentials } = verified;
    if (!await externalBotOwnerMatches(connection, item) || item.control?.controlRevision !== connection.controlRevision) stale();
    const parsed = parse(message.text), row = state.remoteActions.find(row => row.codeHash === item.remoteCommand.codeHash), token = row && codes.get(row.offerId);
    // Existing claims, including a lost ACK, can only be reconciled. Never arm again.
    if (!row || row.claim) return null; // Unknown code stays a sanitized, non-authorizing C job.
    const view = token && views.get(token.viewId), source = view && snapshots.get(view.ticket);
    const announcement = row && state.items.find(value => value.id === row.announcementItemId);
    if (!row || !token || !view || !source || !announcement || announcement.delivery?.status !== 'sent' || announcement.delivery.attemptId !== token.attemptId || view.sent.size !== view.parts.length || payloads.size >= EXTERNAL_BOT_REMOTE.active || row.status !== 'offered' || row.binding.bootId !== OVERLAY_ID
      || Date.parse(row.expiresAt) <= Date.now() || token.bindingHash !== row.bindingHash || !externalBotRemoteCodeMatches(row.codeHash, parsed.code)
      || source.fingerprint !== row.binding.sourceFingerprint || credentials.credentialRevision !== row.binding.credentialRevision) stale();
    const current = await owner(state, item.id), audienceProof = await audience(connection, item);
    if (token.recipient !== current.recipient || row.binding.recipientFingerprint !== digest(current.recipient) || audienceProof.revision !== row.binding.audienceRevision) stale();
    source.assert(); source.assertOrigin(); view.assertProjection();
    const typed = typedDecision(parsed, source), decisionFingerprint = interventionDecisionFingerprint(source.sessionId, source.interventionId, typed.decisionPayload);
    const hashes = externalBotRemoteCommand(connection.id, message, { offerId: row.offerId, action: typed.payload.action, decisionFingerprint });
    if (externalBotRemoteDedupe(state, hashes).status === 'duplicate') return null;
    const claimedAt = nowIso(); row.status = 'claimed'; row.updatedAt = claimedAt;
    const { offerId, ...facts } = hashes; row.claim = { ...facts, idempotencyKey: 'extdec:' + row.offerId, claimedAt };
    const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
    const command = freeze({ missionId: source.sessionId, interventionId: source.interventionId, expectedVersion: source.iv.interventionVersion || 0,
      idempotencyKey: row.claim.idempotencyKey, contractRequest: true, payload: typed.payload, decisionFingerprint, type: source.iv.type, action: typed.payload.action, runId: source.iv.runId || '' });
    const claimMaterial = JSON.stringify(row.claim), bindingHash = row.bindingHash, itemId = item.id;
    return async () => {
      const pending = await phaseProof(source, command, 'pending'); pending.assert();
      source.assert(); source.assertOrigin(); view.assertProjection(); audienceProof.assert();
      if (Date.parse(row.expiresAt) <= Date.now() || externalBotWorkerStopped) stale();
      const witness = Object.freeze({}), release = armInterventionJournal(source.sessionId);
      const slot = { witness, command, release, offerId, claimMaterial, bindingHash, itemId, source, view, audienceProof, recipient: current.recipient, used: false };
      humans.set(witness, slot); interventionHumanConsumers.set(witness, command => consumeHuman(witness, command)); payloads.set(itemId, slot); codes.delete(offerId);
    };
  }
  function consumeHuman(witness, command) {
    const slot = witness && humans.get(witness);
    if (!slot || slot.used || command !== slot.command || payloads.get(slot.itemId) !== slot) return null;
    slot.used = true; payloads.delete(slot.itemId);
    const { source, view, audienceProof } = slot;
    const native = ['permission', 'question', 'plan'].includes(command.type); let preparedEffect = null;
    const readOwned = async status => {
      const state = await externalBotReadState(), current = await owner(state, slot.itemId), row = state.remoteActions.find(row => row.offerId === slot.offerId);
      if (!row || row.status !== status || row.bindingHash !== slot.bindingHash || JSON.stringify(row.claim) !== slot.claimMaterial || current.recipient !== slot.recipient
        || current.item.execution?.status !== 'running' || current.item.execution.serverInstanceId !== OVERLAY_ID || row.binding.bootId !== OVERLAY_ID || Date.parse(row.expiresAt) <= Date.now()) stale();
      const env = ['botSecretEnv', 'verificationTokenEnv', 'encryptKeyEnv', 'appSecretEnv'].filter(key => current.connection[key]).map(key => [current.connection[key], process.env[current.connection[key]]]);
      const assert = () => { if (externalBotWorkerStopped || Date.parse(row.expiresAt) <= Date.now() || env.some(([key, value]) => process.env[key] !== value)) stale(); audienceProof.assert(); };
      return { state, row, assert };
    };
    const prepareEffect = async () => {
      // Already owns the bot chain from withCommit. Re-entering it would deadlock.
      const current = await readOwned('applying'), phase = await phaseProof(source, command, 'applying');
      const assert = () => { current.assert(); phase.assert(); source.assertOrigin(); view.assertProjection(); };
      assert(); return assert;
    };
    return Object.freeze({
      matches: facts => Object.entries(facts).every(([key, value]) => command[key] === value),
      withCommit: work => runKeyedChain(externalBotChains, 'state', async () => {
        const current = await readOwned('claimed'), proof = await phaseProof(source, command, 'pending');
        current.assert(); proof.assert(); source.assert(); source.assertOrigin(); view.assertProjection();
        current.row.status = 'applying'; current.row.updatedAt = nowIso(); await externalBotWriteState(current.state);
        const pending = await phaseProof(source, command, 'pending'); current.assert(); pending.assert(); source.assert(); source.assertOrigin();
        return work();
      }),
      prepareEffect: native ? async () => { preparedEffect = await prepareEffect(); } : undefined,
      withEffect: work => {
        if (native) { if (!preparedEffect) stale(); const assert = preparedEffect; preparedEffect = null; assert(); return work(); }
        return prepareEffect().then(assert => { assert(); return work(); });
      },
    });
  }
  function receiptOwnerMatches(row, current) {
    const binding = row?.binding, connection = current.connection, item = current.item;
    // Read repair uses current original owner authorization. A boot/credential
    // revision cannot recreate execution authority or hide an existing receipt.
    return binding && binding.connectionId === connection.id && binding.platform === connection.platform && binding.appId === connection.appId
      && binding.tenantId === connection.tenantId && binding.botUserId === connection.botUserId && binding.ownerSenderId === item.senderId
      && binding.ownerConversationId === item.conversationId && binding.ownerConversationType === item.conversationType;
  }
  async function settleHuman(job, row, receipt) {
    const resultHash = digest(['decision-receipt', row.offerId, row.claim.commandHash, receipt]);
    return runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(), current = await owner(state, job.item.id), record = state.remoteActions.find(value => value.offerId === row.offerId);
      if (!record || !receiptOwnerMatches(record, current) || JSON.stringify(record.claim) !== JSON.stringify(row.claim)) stale();
      if (current.item.execution?.status === 'completed' && ['applied', 'rejected'].includes(record.status)) return; // Already repaired, including a lost bot ACK.
      const status = receipt.kind === 'applied' ? 'applied' : ['rejected', 'superseded'].includes(receipt.kind) ? 'rejected' : 'unknown';
      if (!['applied', 'rejected'].includes(record.status)) { record.status = status; record.updatedAt = nowIso(); record.resultHash = status === 'unknown' ? '' : resultHash; }
      const item = current.item;
      item.execution = { ...item.execution, status: 'completed', finishedAt: nowIso(), replyText: status === 'applied' ? '决定已交付并确认。' : status === 'rejected' ? '此决定未获交付，原待决事项已由权威记录结算。' : '动作结果无法确认，可能已交付。请在如意核对；不会重放此决定。' };
      item.delivery = { status: 'pending', attemptId: makeId('reply'), messageId: '', errorCode: '', updatedAt: nowIso() }; await externalBotWriteState(state);
    });
  }
  async function runHuman(job) {
    const slot = payloads.get(job.item.id);
    const row = await runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(), current = await owner(state, job.item.id);
      const row = state.remoteActions.find(row => row.claim?.sourceHash === externalBotRetentionHash(job.item.sourceKey)) || state.remoteActions.find(row => row.codeHash === job.item.remoteCommand.codeHash || row.offerId === job.item.remoteCommand.handle);
      if (row && !receiptOwnerMatches(row, current)) stale(); return row;
    });
    if (!row?.claim) stale();
    const command = slot?.command || { missionId: row.binding.sessionId, interventionId: row.binding.interventionId, expectedVersion: row.binding.expectedVersion,
      idempotencyKey: row.claim.idempotencyKey, decisionFingerprint: row.claim.decisionFingerprint, type: row.binding.type, action: row.claim.action, runId: row.binding.runId };
    try {
      if (slot) await decideIntervention(command, slot.witness); // No payload means query only, even in the same boot.
      const receipt = await readInterventionDecisionReceipt(command);
      await settleHuman(job, row, receipt);
    } finally { if (slot) { slot.release(); humans.delete(slot.witness); interventionHumanConsumers.delete(slot.witness); payloads.delete(job.item.id); } }
  }
  async function reconcileRecovered() {
    const jobs = await runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState();
      return (state.remoteActions || []).filter(row => row.claim && ['claimed', 'applying', 'unknown'].includes(row.status)).map(row => {
        const item = state.items.find(item => externalBotRetentionHash(item.sourceKey) === row.claim.sourceHash);
        return item?.execution?.status === 'unknown' && !payloads.has(item.id) && validCommand(item.remoteCommand) ? { item: structuredClone(item) } : null;
      }).filter(Boolean);
    });
    for (const job of jobs) {
      // A live volatile slot is skipped; this path only queries lost-payload work.
      try { await runHuman(job); } catch (error) { if (error?.code === 'external_channel.storage_unavailable') throw error; }
    }
  }
  async function collect() {
    const index = await getPretenderProjectionIndex(); if (!index || index.degraded?.active || !Array.isArray(index.sessions)) stale();
    const refs = pendingInterventionRefs(index).refs; if (refs.length > EXTERNAL_BOT_REMOTE.active) fail();
    const tickets = []; for (const { slice, iv } of refs) tickets.push(await readSource(slice.sessionId, iv.id)); return tickets;
  }
  function pages(text) {
    const result = []; let page = '';
    for (const point of text) { if (page.length + point.length > limits.pageChars || Buffer.byteLength(page + point) > limits.pageBytes) { result.push(page); page = ''; } page += point; }
    if (page || !result.length) result.push(page); if (result.length > limits.pages) fail(); return result;
  }
  async function project(ticket, recipient, knownSecrets = []) {
    const source = snapshots.get(ticket); if (!source || typeof recipient !== 'string' || !recipient) stale(); source.assert();
    const binding = { recipient, purpose: 'external-bot-pending-view', sourceHash: source.fingerprint, knownSecrets };
    const display = structuredClone(source.full);
    if (display.type === 'question') display.detail.questions = display.detail.questions.map((q, i) => ({ q: i + 1, header: q.header, question: q.question,
      answerMode: q.answerMode, allowOther: q.allowOther, otherLabel: q.otherLabel, otherPlaceholder: q.otherPlaceholder,
      options: q.options.map((option, index) => ({ option: index + 1, label: option.label, description: option.description })) }));
    const projected = await PrivacyGateway.prepareMultiSourceDisclosure(PrivacyGateway.foreignView(display), [source.sessionId], binding);
    source.assert(); projected.assert();
    const text = typeof projected.value === 'string' ? projected.value : JSON.stringify(projected.value, null, 2), parts = pages(text);
    for (const [id, view] of views) if (view.expiresAt <= Date.now()) views.delete(id);
    if (views.size >= limits.views) fail(); const id = handle(), expiresAt = Math.min(Date.now() + EXTERNAL_BOT_REMOTE.ttlMs, source.deadline > 0 ? source.deadline : Infinity);
    if (expiresAt <= Date.now()) stale();
    views.set(id, { ticket, recipient, parts, expiresAt, assertProjection: projected.assert, projectionHash: digest(projected.value), sent: new Map() });
    return { handle: id, type: source.iv.type, title: String(projected.value.title || '').slice(0, 120), pages: parts.length, expiresAt: new Date(expiresAt).toISOString() };
  }
  async function page(id, number, recipient) {
    const view = viewOf(id), source = view && snapshots.get(view.ticket);
    if (!view || !source || view.recipient !== recipient || view.expiresAt <= Date.now() || !Number.isSafeInteger(number) || number < 1 || number > view.parts.length) stale();
    if (source.refresh) await source.refresh(); else { const fresh = await readSource(source.sessionId, source.interventionId); if (snapshots.get(fresh).fingerprint !== source.fingerprint) stale(); }
    source.assert(); view.assertProjection(); return { text: view.parts[number - 1], page: number, pages: view.parts.length, complete: number === view.parts.length && Array.from({ length: number - 1 }, (_, i) => i + 1).every(i => view.sent.has(i)),
      assert: () => { source.assert(); view.assertProjection(); if (view.expiresAt <= Date.now() || view.recipient !== recipient || viewOf(id) !== view) stale(); },
      };
  }
  async function owner(state, itemId) {
    const item = state.items.find(row => row.id === itemId), connection = item && state.connections.find(row => row.id === item.connectionId);
    if (!item || !await externalBotOwnerMatches(connection, item)) stale();
    const credentials = await externalBotCredentialSnapshot(connection);
    const recipient = JSON.stringify([connection.id, connection.platform, connection.appId, connection.tenantId, connection.botUserId, item.conversationType, item.conversationId, item.senderId, connection.controlRevision, credentials.credentialRevision]);
    return { item, connection, credentials, recipient };
  }
  async function context(itemId) {
    return runKeyedChain(externalBotChains, 'state', async () => ({ recipient: (await owner(await externalBotReadState(), itemId)).recipient }));
  }
  function validPresentation(row) {
    return externalBotRemoteKeys(row, ['handle', 'page', 'pages', 'projectionHash', 'recipientHash', 'offerId']) && validHandle(row.handle)
      && Number.isSafeInteger(row.page) && Number.isSafeInteger(row.pages) && row.page >= 1 && row.page <= row.pages && row.pages <= limits.pages
      && externalBotRemoteDigest(row.projectionHash) && externalBotRemoteDigest(row.recipientHash) && (row.offerId === '' || externalBotRemoteOfferId(row.offerId));
  }
  async function stage(itemId, id, number) {
    const initial = await context(itemId), prepared = await page(id, number, initial.recipient), view = viewOf(id), source = snapshots.get(view.ticket);
    return runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(), current = await owner(state, itemId);
      if (current.recipient !== initial.recipient || !(current.item.execution?.status === 'queued' || current.item.remoteCommand && current.item.execution?.status === 'running' && current.item.execution.serverInstanceId === OVERLAY_ID) || current.item.remoteView) stale();
      prepared.assert(); externalBotUpgradeRemoteState(state);
      let offerId = '', token = null;
      const audienceProof = await audience(current.connection, current.item);
      if (prepared.complete && !view.list) {
        if (state.remoteActions.length >= EXTERNAL_BOT_REMOTE.active || state.remoteActionReceipts.length >= EXTERNAL_BOT_REMOTE.receipts) fail();
        // An offer is a fixed data intent, not a human decision. No decision consumer is called.
        token = externalBotRemoteNewCode(); offerId = id;
        if (state.remoteActions.some(row => row.offerId === offerId) || state.remoteActionReceipts.some(row => row.offerId === offerId)) stale();
        const binding = externalBotRemoteBinding({ bootId: OVERLAY_ID, connectionId: current.connection.id, platform: current.connection.platform, appId: current.connection.appId,
          tenantId: current.connection.tenantId, botUserId: current.connection.botUserId, controlRevision: current.connection.controlRevision, credentialRevision: current.credentials.credentialRevision,
          ownerSenderId: current.item.senderId, ownerConversationType: current.item.conversationType, ownerConversationId: current.item.conversationId,
          sessionId: source.sessionId, interventionId: source.interventionId, type: source.iv.type, expectedVersion: source.iv.interventionVersion || 0,
          runId: source.iv.runId || '', executionId: '', sourceFingerprint: source.fingerprint, policyFingerprint: source.fingerprint,
          recipientFingerprint: digest(current.recipient), audienceRevision: audienceProof.revision });
        const now = nowIso(), row = externalBotRemoteRecord({ offerId, codeHash: token.codeHash, binding, bindingHash: externalBotRemoteHash('binding', binding),
          allowedActions: [...EXTERNAL_BOT_REMOTE.actions[binding.type]], issuedAt: now, expiresAt: new Date(view.expiresAt).toISOString(), updatedAt: now,
          status: 'prepared', announcementItemId: current.item.id, claim: null, resultHash: '' });
        state.remoteActions.push(row); await externalBotWriteState(state); // Failed/lost ACK never arms or sends a raw code.
      }
      prepared.assert();
      const item = current.item;
      item.remoteView = { handle: id, page: number, pages: view.parts.length, projectionHash: view.projectionHash, recipientHash: digest(current.recipient), offerId };
      item.execution = { ...item.execution, status: 'completed', finishedAt: nowIso(), replyText: prepared.text };
      item.delivery = { status: 'pending', attemptId: makeId('reply'), messageId: '', errorCode: '', updatedAt: nowIso() };
      if (item.feedback?.progress?.delivery.status === 'pending') item.feedback.progress.delivery = { ...item.feedback.progress.delivery, status: 'failed', errorCode: 'external_delivery.progress_superseded', updatedAt: nowIso() };
      if (offerId) { const row = state.remoteActions.find(row => row.offerId === offerId); row.status = 'offered'; row.announcementItemId = item.id; row.updatedAt = nowIso(); }
      try { await externalBotWriteState(state); } catch (error) { codes.delete(offerId); throw error; }
      if (token) codes.set(offerId, { code: token.code, codeHash: token.codeHash, viewId: id, itemId, attemptId: item.delivery.attemptId, recipient: current.recipient, bindingHash: state.remoteActions.find(row => row.offerId === offerId).bindingHash });
      return { itemId, offerId, page: number, pages: view.parts.length }; // Never returns raw code or full source.
    });
  }
  async function recordDelivery(itemId) {
    return runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(), current = await owner(state, itemId), marker = current.item.remoteView, view = marker && viewOf(marker.handle);
      if (!validPresentation(marker) || !view || current.recipient !== view.recipient || marker.projectionHash !== view.projectionHash
        || marker.pages !== view.parts.length || current.item.execution.replyText !== view.parts[marker.page - 1]
        || current.item.delivery?.status !== 'sent' || !externalBotIdentity(current.item.delivery.messageId)) stale();
      view.sent.set(marker.page, [current.item.delivery.attemptId, current.item.delivery.messageId]);
    });
  }
  async function prepare(job, controller, dispatch, assertPolicy) {
    const marker = job.item.remoteView, view = marker && viewOf(marker.handle);
    if (!validPresentation(marker) || !view) stale();
    const prepared = await page(marker.handle, marker.page, view.recipient);
    const pending = await runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(), current = await owner(state, job.item.id), item = current.item;
      if (controller.signal.aborted || externalBotWorkerStopped || current.recipient !== view.recipient || JSON.stringify(item.remoteView) !== JSON.stringify(marker)
        || item.delivery?.status !== 'sending' || item.delivery.attemptId !== job.item.delivery.attemptId || current.credentials.credentialRevision !== job.credentialRevision
        || externalBotConnectionFingerprint(current.connection) !== job.connectionFingerprint || item.execution.replyText !== prepared.text) stale();
      const audienceProof = await audience(current.connection, item);
      let suffix = '';
      if (marker.offerId) {
        const token = codes.get(marker.offerId), row = state.remoteActions.find(row => row.offerId === marker.offerId);
        if (!token || !row || row.status !== 'offered' || row.claim !== null || row.binding.bootId !== OVERLAY_ID || Date.parse(row.expiresAt) <= Date.now()
          || token.recipient !== current.recipient || token.itemId !== item.id || token.attemptId !== item.delivery.attemptId || token.bindingHash !== row.bindingHash
          || !externalBotRemoteCodeMatches(row.codeHash, token.code) || !prepared.complete || audienceProof.revision !== row.binding.audienceRevision) stale();
        suffix = '\n\n' + row.allowedActions.map(action => (action === 'answer' ? '/answer ' : '/decide ') + token.code + (action === 'answer' ? ' TEXT' : ' ' + action)).join('\n');
      }
      const text = prepared.text + suffix;
      const env = ['botSecretEnv', 'verificationTokenEnv', 'encryptKeyEnv', 'appSecretEnv'].filter(key => current.connection[key]).map(key => [current.connection[key], process.env[current.connection[key]]]);
      const assert = wire => {
        prepared.assert(); assertPolicy(); audienceProof.assert();
        if (controller.signal.aborted || externalBotWorkerStopped || env.some(([key, value]) => process.env[key] !== value) || wire?.text !== text) stale();
        const active = externalBotDeliveries.get(item.id); if (!active || active.controller !== controller || active.attemptId !== item.delivery.attemptId || active.submitted) stale();
        if (marker.offerId && codes.get(marker.offerId)?.codeHash !== state.remoteActions.find(row => row.offerId === marker.offerId)?.codeHash) stale();
        active.submitted = true;
      };
      prepared.assert(); assertPolicy(); return { result: dispatch({ text, assertCurrent: assert }) };
    });
    return pending.result;
  }
  async function withdraw(itemId, code) {
    const hash = externalBotRemoteCodeHash(code);
    return withdrawHash(itemId, hash);
  }
  async function withdrawHash(itemId, hash) {
    return runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(), current = await owner(state, itemId), row = state.remoteActions?.find(row => row.codeHash === hash);
      const token = row && codes.get(row.offerId);
      if (!row || row.binding.recipientFingerprint !== digest(current.recipient)) stale();
      if (row.claim !== null || ['claimed', 'applying'].includes(row.status)) return { status: 'reconcile', offerId: row.offerId };
      if (['revoked', 'expired'].includes(row.status)) return { status: row.status, offerId: row.offerId };
      if (!token || token.codeHash !== hash || token.recipient !== current.recipient || row.binding.bootId !== OVERLAY_ID || Date.parse(row.expiresAt) <= Date.now()) stale();
      if (['prepared', 'offered', 'unknown'].includes(row.status)) { row.status = 'revoked'; row.updatedAt = nowIso(); await externalBotWriteState(state); }
      codes.delete(row.offerId); return { status: row.status, offerId: row.offerId };
    });
  }
  async function expire() {
    return runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(); let changed = false;
      for (const row of state.remoteActions || []) if (row.claim === null && ['prepared', 'offered', 'unknown'].includes(row.status)
        && (row.binding.bootId !== OVERLAY_ID || Date.parse(row.expiresAt) <= Date.now())) { row.status = row.binding.bootId !== OVERLAY_ID ? 'revoked' : 'expired'; row.updatedAt = nowIso(); codes.delete(row.offerId); changed = true; }
      if (changed) await externalBotWriteState(state);
      for (const [id, slot] of payloads) {
        const row = state.remoteActions.find(row => row.offerId === slot.offerId), connection = row && state.connections.find(value => value.id === row.binding.connectionId);
        if (!row || row.binding.bootId !== OVERLAY_ID || Date.parse(row.expiresAt) <= Date.now() || !connection?.enabled || connection.controlRevision !== row.binding.controlRevision) { slot.release(); humans.delete(slot.witness); interventionHumanConsumers.delete(slot.witness); payloads.delete(id); }
      }
      for (const [id, view] of views) if (view.expiresAt <= Date.now()) views.delete(id);
      for (const [id, view] of lists) if (view.expiresAt <= Date.now()) lists.delete(id);
    });
  }
  function sanitize(connection, message) {
    if (!/^\s*\/(pending|action|revoke|decide|answer)\b/i.test(message.text)) return null;
    if (!connection.enabled || connection.mode !== 'control' || message.tenantId !== connection.tenantId || !connection.allowedSenderIds.includes(message.senderId)
      || !connection.allowedConversationIds.includes(message.conversationId) || message.senderId !== connection.ownerSenderId || message.conversationId !== connection.ownerConversationId || message.conversationType !== connection.ownerConversationType) throw externalBotError('external_channel.source_forbidden', 403);
    let parsed; try { parsed = parse(message.text); } catch { parsed = { kind: 'invalid' }; }
    const row = { kind: parsed.kind, textHash: externalBotRetentionHash(message.text), codeHash: parsed.code ? externalBotRemoteCodeHash(parsed.code) : '', handle: parsed.handle || '', page: parsed.page || 0, bootId: OVERLAY_ID };
    return { ...row, commandHash: externalBotRemoteHash('readonly-ingress', row) };
  }
  function validCommand(row) {
    if (!externalBotRemoteKeys(row, ['kind', 'textHash', 'codeHash', 'handle', 'page', 'bootId', 'commandHash']) || !['pending', 'action', 'revoke', 'decide', 'answer', 'invalid'].includes(row.kind)
      || !externalBotRemoteDigest(row.textHash) || !externalBotRemoteDigest(row.commandHash) || !externalBotIdentity(row.bootId) || !(row.codeHash === '' || externalBotRemoteDigest(row.codeHash))
      || !(row.handle === '' || validHandle(row.handle)) || !Number.isSafeInteger(row.page) || row.page < 0 || row.page > limits.pages) return false;
    const { commandHash, ...facts } = row;
    return commandHash === externalBotRemoteHash('readonly-ingress', facts) && (row.kind === 'pending' ? row.page >= 1 && row.codeHash === ''
      : row.kind === 'action' ? validHandle(row.handle) && row.page === 0 && row.codeHash === '' : ['revoke', 'decide', 'answer'].includes(row.kind) ? externalBotRemoteDigest(row.codeHash) && row.handle === '' && row.page === 0 : row.codeHash === '' && row.handle === '' && row.page === 0);
  }
  async function list(recipient, knownSecrets) {
    for (const [id, view] of lists) if (view.recipient === recipient || view.expiresAt <= Date.now()) lists.delete(id);
    for (const [id, view] of views) if (view.expiresAt <= Date.now() || view.recipient === recipient && ![...codes.values()].some(code => code.viewId === id)) views.delete(id);
    if (lists.size >= EXTERNAL_BOT_LIMITS.connections) fail();
    const tickets = await collect(); let entries = [];
    // Learning in a later source can dirty an earlier proof. Only unpublished,
    // unarmed temporary handles may be discarded and reprojected, never offers.
    for (let pass = 0; pass < 4; pass++) {
      entries = [];
      try {
        for (const ticket of tickets) entries.push(await project(ticket, recipient, knownSecrets));
        for (const entry of entries) { const view = views.get(entry.handle); snapshots.get(view.ticket).assert(); view.assertProjection(); }
        break;
      } catch (error) {
        for (const entry of entries) views.delete(entry.handle);
        if (error?.code !== 'privacy.disclosure_dirty' || pass === 3) throw error;
      }
    }
    const id = 'rl_' + crypto.randomBytes(16).toString('base64url'), ticket = Object.freeze({}), sources = tickets.map(ticket => snapshots.get(ticket));
    const assert = () => { for (const source of sources) source.assert(); for (const entry of entries) { const view = views.get(entry.handle); if (!view) stale(); view.assertProjection(); } };
    const refresh = async () => { for (const source of sources) { const current = await readSource(source.sessionId, source.interventionId); if (snapshots.get(current).fingerprint !== source.fingerprint) stale(); } };
    snapshots.set(ticket, { assert, refresh });
    const parts = pages(entries.length ? entries.map(entry => `${entry.handle} ${entry.type} ${entry.title}\n/pending ${entry.handle} 1`).join('\n\n') : '当前没有待处理的事项。');
    if (parts.length > 1) for (let i = 0; i < parts.length; i++) parts[i] += `\n\n${i + 1}/${parts.length}${i + 1 < parts.length ? '\n/pending ' + id + ' ' + (i + 2) : ''}`;
    const expiresAt = Math.min(Date.now() + EXTERNAL_BOT_REMOTE.ttlMs, ...entries.map(entry => Date.parse(entry.expiresAt)));
    lists.set(id, { list: true, ticket, recipient, parts, expiresAt, assertProjection: assert, projectionHash: digest(parts), sent: new Map() }); return id;
  }
  async function plainReply(job, text, failed = false) {
    return runKeyedChain(externalBotChains, 'state', async () => {
      const state = await externalBotReadState(), current = await owner(state, job.item.id), item = current.item;
      if (!validCommand(item.remoteCommand) || item.execution?.status !== 'running' || item.execution.serverInstanceId !== OVERLAY_ID || JSON.stringify(item.remoteCommand) !== JSON.stringify(job.item.remoteCommand)) stale();
      item.execution = { ...item.execution, status: failed ? 'failed' : 'completed', finishedAt: nowIso(), errorCode: failed ? 'external_channel.request_invalid' : '', replyText: text };
      item.delivery = { status: 'pending', attemptId: makeId('reply'), messageId: '', errorCode: '', updatedAt: nowIso() }; await externalBotWriteState(state);
    });
  }
  async function runCommand(job) {
    const command = job.item.remoteCommand;
    if (!validCommand(command)) stale();
    if (command.bootId !== OVERLAY_ID && ['decide', 'answer'].includes(command.kind)) { await runHuman(job); return; }
    if (command.bootId !== OVERLAY_ID) stale();
    try {
      await expire(); const current = await runKeyedChain(externalBotChains, 'state', async () => owner(await externalBotReadState(), job.item.id));
      if (command.kind === 'pending') { const id = command.handle || await list(current.recipient, Object.values(current.credentials.values).filter(Boolean)); await stage(job.item.id, id, command.page); return; }
      if (command.kind === 'revoke') { const result = await withdrawHash(job.item.id, command.codeHash); await plainReply(job, result.status === 'reconcile' ? '此项已认领，结果需要核对；本条没有撤销或重复执行原动作。' : '此项代码已失效；原待决结果没有改变。'); return; }
      if (['decide', 'answer'].includes(command.kind)) { await runHuman(job); return; }
      if (command.kind === 'invalid') { await plainReply(job, '命令格式无效。请使用 /pending 查看当前待决事项。', true); return; }
      const facts = await runKeyedChain(externalBotChains, 'state', async () => {
        const state = await externalBotReadState(); await owner(state, job.item.id);
        const row = state.remoteActions?.find(row => command.kind === 'action' ? row.offerId === command.handle : row.codeHash === command.codeHash);
        if (!row || !(row.claim ? receiptOwnerMatches(row, current) : row.binding.recipientFingerprint === digest(current.recipient))) stale(); return { claimed: row.claim !== null, closed: ['revoked', 'expired'].includes(row.status) || row.binding.bootId !== OVERLAY_ID || Date.parse(row.expiresAt) <= Date.now() };
      });
      if (facts.claimed) { await runHuman(job); return; }
      await plainReply(job, facts.claimed ? '此项已认领，动作结果请在如意核对；本条没有再次执行。' : facts.closed ? '此项代码已失效，请重新使用 /pending 查看当前待决事项。' : command.kind === 'action' ? '此项尚未认领，原待决结果没有改变。' : '本条没有交付或执行决定，原待决结果没有改变，请在如意处理此项。');
    } catch (error) {
      if (error?.code === 'external_channel.storage_unavailable') throw error;
      await plainReply(job, ['decide', 'answer', 'action'].includes(command.kind) ? '动作结果无法确认，可能已交付。请在如意核对；不会重放此决定。' : '当前事项或代码已变化，未交付任何决定。请重新使用 /pending 查看。', true);
    }
  }
  externalBotHumanAdmission.admit = admitVerified;
  const hooks = Object.freeze({ valid: validPresentation, sanitize, validCommand, runCommand, prepare, recordDelivery, reconcileRecovered, receiptAudience: audience, clear: () => { for (const slot of payloads.values()) { slot.release(); humans.delete(slot.witness); interventionHumanConsumers.delete(slot.witness); } payloads.clear(); codes.clear(); views.clear(); lists.clear(); } });
  Object.assign(ExternalBotHooks, { remoteViews: hooks });
  return Object.freeze({ parse, readSource, collect, project, page, context, stage, recordDelivery, withdraw, expire, sanitize, validCommand, runCommand });
})();
