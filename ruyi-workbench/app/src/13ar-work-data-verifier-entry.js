// Private IPC verifier entry only. No warm runtime/configure or operation readiness.
const WorkDataVerifierEntry = (() => {
  const COMMAND = 'work-data-verify';
  const fail = name => Object.assign(Error('work_data_adapter.' + name), {code:'work_data_adapter.' + name,retry:false});
  function command({proc = process, packaged = isPkg(), entry = exePath()} = {}) {
    const pathApi = require('node:path');
    if (!proc || typeof proc.execPath !== 'string' || !pathApi.isAbsolute(proc.execPath) || typeof packaged !== 'boolean'
      || typeof entry !== 'string' || !pathApi.isAbsolute(entry)) throw fail('entry_command_invalid');
    // Use the same executable/script identities as ordinary CLI startup; no fixture argv.
    return Object.freeze({command:proc.execPath,args:Object.freeze(packaged ? [COMMAND] : [entry,COMMAND])});
  }
  function createVerifier({proc = process, adapters = WorkDataNativeAdapters, packaged = isPkg(), entry = exePath()} = {}) {
    return adapters.create({proc,verifierCommand:command({proc,packaged,entry})});
  }
  function create({proc = process, adapters = WorkDataNativeAdapters, interval = setInterval} = {}) {
    if (!proc || !Number.isSafeInteger(proc.pid) || proc.pid < 1 || !adapters || typeof adapters.create !== 'function' || typeof interval !== 'function') throw fail('entry_host_invalid');
    let started = false, held = false, holdTimer = null, adapter = null;
    const hold = () => {
      held = true; proc.exitCode = 1;
      // Never return/throw to main's ordinary process.exit(1) while a native owner is uncertain.
      if (holdTimer === null) holdTimer = interval(() => { void adapter; },60000);
      return new Promise(() => {});
    };
    async function run() {
      if (started) throw fail('entry_already_started');
      if (proc.connected !== true || typeof proc.send !== 'function' || !Number.isSafeInteger(proc.ppid) || proc.ppid < 1 || proc.ppid === proc.pid) throw fail('ipc_required');
      started = true;
      adapter = adapters.create({proc});
      const uncertain = () => { try { return adapter.helperMayStillRun() !== false; } catch { return true; } };
      let reply;
      try { reply = await adapter.runVerifier(); }
      catch (error) { if (uncertain()) return hold(); throw error; }
      if (uncertain()) return hold();
      // runVerifier has completed its actual owner-release finally before IPC disconnect.
      if (proc.connected === true && typeof proc.disconnect === 'function') proc.disconnect();
      return reply;
    }
    return Object.freeze({run,held:() => held});
  }
  return Object.freeze({COMMAND,command,createVerifier,create});
})();
