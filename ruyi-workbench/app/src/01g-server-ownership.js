// Serve ownership is an OS-held IPC handle, not a heartbeat file or an expiring lease.
// Only serve acquires it; legitimate MCP children continue to share the data directory.
const ServerOwnership = ((netModule, fsModule, pathModule, osModule, cryptoModule) => {
  async function canonicalRoot(root) {
    let cursor = pathModule.resolve(root);
    const missing = [];
    for (;;) {
      try {
        const real = await fsModule.promises.realpath(cursor);
        const joined = pathModule.join(real, ...missing);
        return process.platform === 'win32' ? joined.toLowerCase() : joined;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const parent = pathModule.dirname(cursor);
        if (parent === cursor) throw error;
        missing.unshift(pathModule.basename(cursor));
        cursor = parent;
      }
    }
  }
  function endpointFor(canonical, platform = process.platform, nodeVersion = process.versions.node) {
    const digest = cryptoModule.createHash('sha256').update(canonical).digest('hex');
    if (platform === 'win32') return '\\\\.\\pipe\\ruyi-serve-' + digest;
    const [major, minor] = nodeVersion.split('.').map(Number);
    if (platform === 'linux' && (major > 20 || (major === 20 && minor >= 8))) return '\0ruyi-serve-' + digest;
    // Portable fallback, also for Linux 20.0–20.7: normal close unlinks our socket.
    // A crash can leave a socket file. Never unlink an unknown owner's endpoint automatically.
    return pathModule.join(osModule.tmpdir(), 'ruyi-serve-' + digest.slice(0, 32) + '.sock');
  }
  function ownershipError(code, message) {
    return Object.assign(new Error(message), { code, ruyiStartErrorKind: 'data-dir-owned' });
  }
  async function bind(canonical, onUnknown) {
    const endpoint = endpointFor(canonical);
    const server = netModule.createServer(socket => { socket.on('error', () => {}); socket.destroy(); });
    let bound = false, released = false, uncertain = false, closing = null;
    server.on('error', error => { uncertain = true; if (bound) onUnknown(error); });
    server.on('close', () => { if (bound && !released) { uncertain = true; onUnknown(ownershipError('DATA_ROOT_OWNER_CLOSED', 'Ownership handle closed unexpectedly.')); } });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(endpoint, () => { bound = true; server.removeListener('error', reject); resolve(); });
      });
    } catch (error) {
      try { server.close(); } catch { /* unbound */ }
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') {
        const residual = endpoint.endsWith('.sock') ? ' 如确认没有实例运行，请核实并清理残留 socket：' + endpoint + '。' : '';
        throw ownershipError('DATA_ROOT_IN_USE', '这个数据目录已有如意服务持有独占权，未启动第二个实例：' + canonical + '。请使用已打开的如意，或先退出它。 / Data directory already in use.' + residual);
      }
      throw error;
    }
    return Object.freeze({canonical, endpoint,
      held: () => bound && !released && !uncertain && server.listening === true,
      release() {
        if (closing) return closing;
        released = true; // Only this captured server can be closed; no endpoint unlink/rebind.
        closing = new Promise((resolve, reject) => {
          const failed = error => { uncertain = true; onUnknown(error); reject(error); };
          try { server.close(error => { if (error) failed(error); else resolve(); }); }
          catch (error) { failed(error); }
        });
        closing.catch(() => {}); return closing;
      },
    });
  }
  async function checkLegacyRuntime(root) {
    let runtimeText;
    try { runtimeText = await fsModule.promises.readFile(pathModule.join(root, 'runtime.json'), 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '无法读取旧服务身份记录；为保护任务，本次没有执行启动恢复。 / Cannot verify the previous data directory owner.');
    }
    let record;
    try { record = JSON.parse(runtimeText); } catch { /* unknown owner: do not guess */ }
    if (!record || !Number.isInteger(record.pid) || record.pid <= 0) {
      throw ownershipError('DATA_ROOT_OWNER_UNKNOWN', '无法确认数据目录中旧服务的身份；为保护任务，本次没有执行启动恢复。请先确认旧服务已退出并检查 runtime.json。 / Previous data directory owner is unknown.');
    }
    if (record.pid === process.pid) return;
    try { process.kill(record.pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; } // EPERM and all other uncertainty fail closed.
    throw ownershipError('DATA_ROOT_IN_USE', `数据目录登记的旧如意进程仍存活或无法确认（PID ${record.pid}），本次没有接管或结束它。 / Previous service may still be running.`);
  }
    // Genuine leases and source pins are private capabilities, never roots-shaped objects.
  const leaseStates = new WeakMap(), keeperStates = new WeakMap(), retainedStates = new Set();
  const leaseClock = require('node:timers');
  function uncertainError(cause) {
    return Object.assign(ownershipError('DATA_ROOT_OWNER_UNCERTAIN', 'Source ownership cannot be safely released or authorized.'),
      {ownershipRetained:true, operationMayHaveExecuted:true, retry:false, ...(cause === undefined ? {} : {cause})});
  }
  function retainState(state, cause) {
    state.uncertain = true; state.phase = 'unknown';
    if (!state.failureSet) { state.failureSet = true; state.failure = cause; }
    retainedStates.add(state);
    if (state.hold === null) { state.hold = leaseClock.setInterval(() => { void state; },60000); state.hold.ref(); }
    if (state.rejectRelease && !state.releaseSettled) { state.releaseSettled = true; state.rejectRelease(uncertainError(state.failure)); }
  }
  function isLease(value) { return leaseStates.has(value); }
  const rootKey = root => typeof root === 'string' && process.platform === 'win32' ? root.toLowerCase() : root;
  function owns(value, root) {
    const state = leaseStates.get(value);
    if (!state || state.roots.length === 0 || root !== undefined && (typeof root !== 'string' || !state.roots.includes(rootKey(root)))
      || state.phase !== 'held' || state.uncertain) return false;
    if (!state.handles.every(handle => handle.held())) { retainState(state, ownershipError('DATA_ROOT_OWNER_CLOSED','Ownership handle is not held.')); return false; }
    return true;
  }
  function beginRelease(state) {
    if (!state.releaseRequested || state.pins.size || state.phase === 'closing' || state.releaseSettled) return;
    if (state.uncertain || !state.handles.every(handle => handle.held())) { retainState(state, state.failure); return; }
    state.phase = 'closing'; // Revoke permission synchronously before the first close.
    Promise.allSettled(state.handles.map(handle => handle.release())).then(results => {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length || state.uncertain) { retainState(state,errors.length ? new AggregateError(errors,'Ownership close failed.') : state.failure); return; }
      state.phase = 'released'; state.releaseSettled = true; state.resolveRelease();
    }, error => retainState(state,error));
  }
  function requestRelease(state) {
    if (state.releasePromise) return state.releasePromise;
    state.releaseRequested = true;
    state.releasePromise = new Promise((resolve,reject) => { state.resolveRelease = resolve; state.rejectRelease = reject; });
    state.releasePromise.catch(() => {}); // Internal close errors stay observed; callers still receive the rejection.
    if (state.uncertain) retainState(state,state.failure); else beginRelease(state);
    return state.releasePromise;
  }
  function createSourceKeeper(lease, base) {
    base = rootKey(base);
    const state = leaseStates.get(lease);
    if (!state || typeof base !== 'string' || !owns(lease,base) || state.releaseRequested)
      throw ownershipError('DATA_ROOT_KEEPER_INVALID','A live genuine source owner is required.');
    const pin = {lease,base,released:false,retained:false,checked:false,finalizing:false,finished:null}; state.pins.add(pin);
    const keeper = Object.freeze({ownership:lease,base,
      assertExclusive: candidate => candidate === lease && !pin.released && !pin.retained && owns(lease,base),
      retainUnknown(cause) { if (pin.released && !pin.checked && !pin.retained) throw uncertainError(cause); pin.retained = true; retainState(state,cause); },
      release() { return finish(null,false); },
      releaseChecked(assertSafe) { return finish(assertSafe,false); },
      releaseOwner(assertSafe) { return finish(assertSafe,true); },
    });
    function finish(assertSafe, releaseOwner) {
      if (assertSafe !== null && typeof assertSafe !== 'function' || releaseOwner && assertSafe === null)
        return Promise.reject(ownershipError('DATA_ROOT_KEEPER_INVALID','A synchronous final safety assertion is required.'));
      if (pin.released) return assertSafe !== null ? Promise.reject(uncertainError(state.failure)) : pin.finished;
      if (pin.retained || state.uncertain) return Promise.reject(uncertainError(state.failure));
      if (assertSafe) {
        try {
          if (assertSafe() !== true || !owns(lease,base) || releaseOwner && state.pins.size !== 1) throw uncertainError(state.failure);
        } catch (error) { pin.retained = true; retainState(state,error); return Promise.reject(error); }
      }
      pin.checked = assertSafe !== null; pin.finalizing = pin.checked;
      // Last real check, queued release, pin removal and actual close initiation are one synchronous segment.
      if (releaseOwner) requestRelease(state); // Still pinned here: cannot close before the final pin is removed.
      pin.released = true; state.pins.delete(pin); beginRelease(state);
      const completion = state.releaseRequested && state.pins.size === 0 ? state.releasePromise : Promise.resolve();
      if (!assertSafe) { pin.finished = completion; return completion; }
      pin.finished = Promise.resolve(completion).then(() => {
        if (assertSafe() !== true || state.uncertain) throw uncertainError(state.failure);
        pin.finalizing = false;
      }).catch(error => {
        // A close that already began cannot be undone. Retain references and reject success; never rebind/reclose.
        pin.retained = true; retainState(state,error); pin.finalizing = false; throw error;
      });
      return pin.finished;
    }
    keeperStates.set(keeper,pin); return keeper;
  }
  function isSourceKeeper(value, lease, base) {
    const pin = keeperStates.get(value);
    return !!pin && pin.lease === lease && pin.base === rootKey(base) && !pin.released && !pin.retained && owns(lease,base);
  }
async function acquire(roots) {
    const canonical = [...new Set(await Promise.all(roots.map(canonicalRoot)))].sort();
    const handles = [], state = {roots:Object.freeze(canonical),handles,pins:new Set(),phase:'acquiring',uncertain:false,
      failureSet:false,failure:undefined,hold:null,releaseRequested:false,releasePromise:null,releaseSettled:false};
    try {
      for (const root of canonical) handles.push(await bind(root,error => retainState(state,error)));
      // Preserve original sorted acquisition and legacy-owner checks before issuing a lease.
      for (const root of canonical) await checkLegacyRuntime(root);
      if (state.uncertain || !handles.every(handle => handle.held())) throw uncertainError(state.failure);
    } catch (error) {
      if (state.uncertain) { retainState(state,error); throw uncertainError(error); }
      const cleanup = await Promise.allSettled(handles.map(handle => handle.release()));
      const errors = cleanup.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length || state.uncertain) { const failure = new AggregateError([error,...errors],'Ownership acquisition cleanup failed.',{cause:error}); state.acquisitionFailure = failure; retainState(state,failure); throw uncertainError(failure); }
      throw error;
    }
    state.phase = 'held';
    const lease = Object.freeze({roots:state.roots,portable:handles.some(handle => handle.endpoint.endsWith('.sock')),
      release: () => requestRelease(state)});
    leaseStates.set(lease,state); return lease;
  }
  return Object.freeze({ acquire, canonicalRoot, endpointFor, isLease, owns, createSourceKeeper, isSourceKeeper });
})(require('net'), require('fs'), require('path'), require('os'), require('crypto'));
