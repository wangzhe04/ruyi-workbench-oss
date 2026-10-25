// Maintenance pauses intake, never aborts a business owner. A fresh worker must
// still observe this process exit and acquire the stable base OS owner before census.
const WorkDataMaintenance = ((AsyncLocalStorage) => {
  const failure = suffix => Object.assign(Error('work_data.maintenance_' + suffix), { code: 'work_data.maintenance_' + suffix, statusCode: 409 });
  function create(host) {
    const context = new AsyncLocalStorage(), live = new Set(), writes = new Set();
    let phase = 'open', epoch = 0, lease = null;
    const changed = () => { epoch++; if (phase === 'idle') phase = 'waiting'; };
    const accepting = () => phase === 'open';
    const active = () => { const token = context.getStore()?.token; return !!token && live.has(token); };
    const entered = kind => active() && context.getStore().kind === kind;
    async function run(kind, work) {
      const inherited = context.getStore();
      if (inherited && !active()) throw failure('stale_continuation');
      if (phase === 'retired' || !inherited && !accepting()) throw failure('busy');
      const token = inherited?.token || { refs: 0 }; token.refs++; live.add(token); changed();
      try { return await context.run({ token, kind }, work); }
      finally { if (--token.refs === 0) live.delete(token); changed(); }
    }
    function continueOwner(owner, work) {
      if (phase === 'retired' || phase === 'idle' || !host.owns(owner)) return Promise.reject(failure('owner_unavailable'));
      // Only a caller that just validated an intrinsic registered owner can enter
      // here. No HTTP body/environment field is accepted as that capability.
      return context.run(null, async () => {
        const token = { refs: 1 }; live.add(token); changed();
        try { return await context.run({ token, kind: 'receipt' }, work); }
        finally { if (--token.refs === 0) live.delete(token); changed(); }
      });
    }
    function track(pending) {
      if (!pending || typeof pending.then !== 'function') throw TypeError('pending writer must be a promise');
      if (writes.has(pending)) return pending;
      writes.add(pending); changed();
      pending.then(() => { writes.delete(pending); changed(); }, () => { writes.delete(pending); changed(); });
      return pending;
    }
    function status() {
      const observed = host.snapshot();
      return Object.freeze({ phase, epoch, admitted: live.size, writers: writes.size, dirty: observed.dirty || 0, busy: Object.freeze({ ...observed.busy }), processExitRequired: true });
    }
    function begin({ signal } = {}) {
      if (context.getStore()) throw failure('nested');
      if (phase !== 'open' || lease) throw failure('busy');
      if (signal?.aborted) throw failure('cancelled');
      phase = 'waiting'; changed();
      let paused, valid = true, draining = null;
      const check = () => { if (signal?.aborted) throw failure('cancelled'); if (!valid || lease !== current) throw failure('lease_expired'); };
      const wait = pending => new Promise((resolve, reject) => {
        const abort = () => { cleanup(); reject(failure('cancelled')); };
        const cleanup = () => signal?.removeEventListener('abort', abort);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) return abort();
        Promise.resolve(pending).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      });
      const current = Object.freeze({
        async idle() {
          check();
          if (draining) return draining;
          draining = (async () => {
            let stable = 0, previous = null;
            while (true) {
              check(); await wait(host.progress?.()); check();
              const before = host.snapshot();
              if (live.size || Object.values(before.busy).some(value => value > 0)) {
                stable = 0; previous = null; await wait(host.yield()); continue;
              }
              // A flusher can enqueue a later physical write chain. Re-read all
              // producer counts and chain identities after every drain and yield.
              const stamp = epoch;
              await wait(host.flush()); check();
              const pending = [...new Set([...host.snapshot().pending, ...writes])];
              for (const item of pending) { await wait(item); check(); }
              await wait(host.yield()); check();
              const after = host.snapshot(), identities = [...new Set(after.pending)];
              const same = previous && previous.length === identities.length && previous.every((item, index) => item === identities[index]);
              const quiet = !live.size && !writes.size && !after.dirty && !Object.values(after.busy).some(value => value > 0) && stamp === epoch;
              stable = quiet && same ? stable + 1 : 0; previous = identities;
              if (stable >= 2) { phase = 'idle'; return status(); }
            }
          })().finally(() => { draining = null; });
          return draining;
        },
        assertIdle() { check(); const observed = status(); if (phase !== 'idle' || observed.admitted || observed.writers || observed.dirty || Object.values(observed.busy).some(value => value > 0)) throw failure('not_idle'); return observed; },
        resume() {
          if (!valid || lease !== current || phase === 'retired') throw failure('lease_expired');
          valid = false; lease = null; phase = 'open'; signal?.removeEventListener('abort', onAbort); changed(); host.resume(paused);
        },
        retire() { current.assertIdle(); valid = false; phase = 'retired'; signal?.removeEventListener('abort', onAbort); changed(); },
      });
      const onAbort = () => { if (valid && lease === current && phase !== 'retired') current.resume(); };
      lease = current;
      try { paused = host.pause(); signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort(); }
      catch (error) { valid = false; lease = null; phase = 'open'; throw error; }
      return current;
    }
    const fresh = (kind, work) => context.run(null, () => run(kind, work));
    return Object.freeze({ accepting, active, entered, run, fresh, continueOwner, track, status, begin });
  }
  return Object.freeze({ create });
})(require('node:async_hooks').AsyncLocalStorage);

const workDataDeferredAgentWakes = new Map();
let workDataDeferredStewardWake = false;
const workDataMaintenance = WorkDataMaintenance.create({
  owns(owner) {
    return !!owner && ([...turnSettlers.values()].includes(owner) || [...activeAgentRuns.values()].includes(owner)
      || [...shellSessions.values()].includes(owner) && owner.running === true
      || owner === stewardRunnerRuntime && (owner.queue.length > 0 || owner.inflight || owner.viewHeld.length > 0)
      || owner === stewardRuntime && (owner.ticking || owner.carry.length > 0 || owner.adopted.length > 0));
  },
  snapshot() {
    const scalar = [configMutateChain, configWriteChain, usageLedgerChain, engineTranscriptLedgerChain,
      sessionIndexChain, memoryUsageWriteChain, agentInstructionChain, toolboxReconcileChain,
      stewardDecisionChain, stewardMemoryChain, stewardAppendChain, schedulerTasksChain, schedulerFiresChain, migrationChain, pretenderIndexRuntime.writeChain];
    const maps = [kimiMcpSyncChains, sessionWriteChains, sessionNotesWriteChains, sessionScratchpadChains,
      interventionWriteChains, missionChangeWriteChains, sessionMetaDeferChains, sessionMutateChains,
      journalWriteChains, journalRevertChains, missionContainerChains, voiceLexiconChains,
      memoryProposalStateChains, agentRunWriteChains, agentRunEventChains, backgroundJobChains,
      fileToolWriteChains, proxyModelsCacheChains, sessionSearchRefreshChains, stewardArchiveChains, externalBotChains];
    const consumers = McpConsumers.maintenanceState();
    const fulltext = SessionFullTextHooks.maintenanceState ? SessionFullTextHooks.maintenanceState() : { pending: [], active: 0 };
    return { pending: [...scalar, ...maps.flatMap(map => [...map.values()]), ...consumers.pending, ...fulltext.pending], dirty: pendingSessionIndex.size + Number(!!sessionIndexFlushTimer) + Number(!!pretenderIndexRuntime.persistTimer) + Number(!!pretenderIndexRuntime.value && !pretenderIndexRuntime.persisted && fs.existsSync(paths.sessions)) + (logStream?.writableLength || 0), busy: {
      turns: turnSettlers.size + activeChildren.size + turnOutcomePending.size,
      agentRuns: activeAgentRuns.size,
      scheduler: Number(schedulerRuntime.ticking) + schedulerRuntime.inFlightTaskIds.size,
      steward: Number(stewardRuntime.ticking) + Number(!!stewardRunnerRuntime.inflight) + stewardUserWaiters.length + Number(stewardArbiter.draining)
        + stewardRuntime.carry.length + stewardRuntime.adopted.length + stewardRunnerRuntime.queue.length + stewardRunnerRuntime.viewHeld.length,
      externalBots: externalBotInflight + Number(externalBotWorkerBusy) + Number(externalBotDiscoveryBusy)
        + externalBotActiveActors.size + externalBotUnsettled.size + externalBotDeliveries.size,
      consumers: consumers.active, internalMcp: InternalMcpHooks.maintenanceState().active,
      index: fulltext.active + inflightSessionIndex.size + sessionIndexRebuildsActive + Number(!!pretenderIndexRuntime.building) + pretenderIndexRuntime.writers,
      shells: [...shellSessions.values()].filter(row => row.running).length,
      services: [...toolboxServices.values()].filter(row => row.starting || row.stopping).length,
    } };
  },
  pause() {
    const saved = { schedulerTimer: !!schedulerRuntime.timer, stewardTimer: !!stewardRuntime.timer, externalWorker: externalBotWorkerBusy || externalBotWorkerAgain,
      fulltext: SessionFullTextHooks.maintenancePause ? SessionFullTextHooks.maintenancePause() : null,
      projectionVerify: !!pretenderIndexRuntime.verifyTimer, projectionPersist: !!pretenderIndexRuntime.persistTimer };
    if (schedulerRuntime.timer) { clearInterval(schedulerRuntime.timer); schedulerRuntime.timer = null; }
    if (stewardRuntime.timer) { clearInterval(stewardRuntime.timer); stewardRuntime.timer = null; }
    if (stewardRuntime.wakeTimers.length) workDataDeferredStewardWake = true;
    stewardClearWake();
    for (const key of ['verifyTimer', 'persistTimer']) if (pretenderIndexRuntime[key]) { clearTimeout(pretenderIndexRuntime[key]); pretenderIndexRuntime[key] = null; }
    for (const [sessionId, timer] of agentWakeTimers) { clearTimeout(timer); workDataDeferredAgentWakes.set(sessionId, 'maintenance_resume'); }
    agentWakeTimers.clear();
    return saved;
  },
  async progress() {
    if (!stewardRuntime.ticking && (stewardRuntime.carry.length || stewardRuntime.adopted.length)) {
      await workDataMaintenance.continueOwner(stewardRuntime, () => stewardRunTick());
    }
  },
  async flush() {
    if (sessionIndexFlushTimer) { clearTimeout(sessionIndexFlushTimer); sessionIndexFlushTimer = null; }
    await flushSessionIndex(); await flushPretenderPersist(); await flushWorkbenchLogs();
  },
  yield: () => new Promise(resolve => setTimeout(resolve, 25)),
  resume(saved) {
    if (SessionFullTextHooks.maintenanceResume) SessionFullTextHooks.maintenanceResume(saved.fulltext);
    if (saved.schedulerTimer && schedulerRuntime.started) schedulerEnsureTimer();
    if (saved.stewardTimer && stewardRuntime.running && !stewardRuntime.timer) {
      stewardRuntime.timer = setInterval(() => { void WorkDataMaintenanceHooks.stewardTick(); }, stewardRuntime.pollMs); stewardRuntime.timer.unref?.();
    }
    if (workDataDeferredStewardWake && stewardRuntime.running) { workDataDeferredStewardWake = false; stewardScheduleWake(); }
    if (stewardRunnerRuntime.queue.length) stewardScheduleInboxDrain();
    if (saved.projectionVerify) pretenderScheduleVerify();
    if (saved.projectionPersist || pretenderIndexRuntime.value && !pretenderIndexRuntime.persisted) schedulePretenderPersist();
    for (const [sessionId, reason] of workDataDeferredAgentWakes) scheduleAgentWake(sessionId, reason);
    workDataDeferredAgentWakes.clear();
    if (saved.externalWorker || externalBotWorkerAgain) externalBotWakeWorker();
  },
});
Object.assign(WorkDataMaintenanceHooks, workDataMaintenance);
WorkDataMaintenanceHooks.deferStewardWake = () => { workDataDeferredStewardWake = true; };
WorkDataMaintenanceHooks.stewardTick = () => workDataMaintenance.accepting() ? workDataMaintenance.fresh('steward-intake', () => stewardRunTick()) : Promise.resolve({ skipped: true });
WorkDataMaintenanceHooks.schedulerTick = () => workDataMaintenance.accepting() ? workDataMaintenance.fresh('scheduler-tick', () => schedulerTick()) : Promise.resolve({ skipped: true });
WorkDataMaintenanceHooks.deferWake = (sessionId, reason) => { workDataDeferredAgentWakes.set(sessionId, reason); };
InternalMcpHooks.Hooks.run = (work, owner) => workDataMaintenance.continueOwner(owner, work);
MemoryCliHooks.Hooks.run = (work, owner) => workDataMaintenance.continueOwner(owner, work);
