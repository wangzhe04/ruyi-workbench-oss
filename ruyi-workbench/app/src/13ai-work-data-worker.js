// Cold-process handoff. No config/store read, ownership release or warm root switch
// occurs in the parent. The worker needs both an authenticated IPC commitment and
// actual parent death before acquiring the base. All mutation belongs to execute().
const WorkDataMaintenanceWorker = ((cryptoApi, pathApi) => {
  const VERSION = 1, MAX_INPUT = 32 * 1024, ID = /^[a-f0-9]{48}$/;
  const SECRET_ENV = /^(?:WCW_|RUYI_(?:INTERNAL_MCP_|MEMORY_|MCP_CONSUMER_|MAINTENANCE_))/i;
  const fail = (suffix, uncertain = false) => Object.assign(new Error('work_data_setup.' + suffix), {
    code: 'work_data_setup.' + suffix, apiCode: 'work_data_setup.' + suffix,
    statusCode: 409, operationMayHaveExecuted: uncertain, retry: false,
  });
  const keys = value => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(',') : '';
  const inside = (parent, value) => {
    const fold = value => process.platform === 'win32' ? value.toLowerCase() : value;
    const rel = pathApi.relative(fold(parent), fold(value));
    return rel === '' || rel !== '..' && !rel.startsWith('..' + pathApi.sep) && !pathApi.isAbsolute(rel);
  };
  function absolute(value) {
    return typeof value === 'string' && value.length <= 4096 && !/[\0\r\n]/.test(value)
      && pathApi.isAbsolute(value) && pathApi.resolve(value) === value;
  }
  function validate(value) {
    if (keys(value) !== 'base,expectedAuthority,id,nonce,operation,parentPid,password,paths,schema,serve'
      || value.schema !== VERSION || !ID.test(value.id || '') || !/^[a-f0-9]{64}$/.test(value.nonce || '')
      || !['enable', 'disable', 'export', 'restore'].includes(value.operation)
      || !absolute(value.base) || pathApi.parse(value.base).root === value.base
      || !Number.isSafeInteger(value.parentPid) || value.parentPid < 1
      || typeof value.password !== 'string' || value.password.length < 12 || value.password.length > 1024
      || Buffer.byteLength(value.password, 'utf8') > 1024 || Buffer.from(value.password).toString('utf8') !== value.password
      || /\0/.test(value.password)) throw fail('input_invalid');
    if (keys(value.expectedAuthority) !== 'generation,id,mode,sha256'
      || !Number.isSafeInteger(value.expectedAuthority.generation) || value.expectedAuthority.generation < 0
      || !['plain', 'encrypted'].includes(value.expectedAuthority.mode)
      || (value.expectedAuthority.generation === 0 ? value.expectedAuthority.id !== null || value.expectedAuthority.sha256 !== null
        : !ID.test(value.expectedAuthority.id || '') || !/^[a-f0-9]{64}$/.test(value.expectedAuthority.sha256 || ''))) throw fail('authority_invalid');
    if (keys(value.paths) !== 'backupDirectory,targetDirectory,uploadFile,uploadSha256'
      || !absolute(value.paths.backupDirectory) || inside(value.base, value.paths.backupDirectory) || inside(value.paths.backupDirectory, value.base)
      || !(value.paths.targetDirectory === null || absolute(value.paths.targetDirectory)
        && !inside(value.base, value.paths.targetDirectory) && !inside(value.paths.targetDirectory, value.base))
      || !(value.paths.uploadFile === null || absolute(value.paths.uploadFile) && !inside(value.base, value.paths.uploadFile))
      || !(value.paths.uploadSha256 === null || /^[a-f0-9]{64}$/.test(value.paths.uploadSha256))
      || (value.operation === 'restore') !== (value.paths.targetDirectory !== null && value.paths.uploadFile !== null)
      || (value.operation === 'restore') !== (value.paths.uploadSha256 !== null)
      || value.operation !== 'restore' && (value.paths.targetDirectory !== null || value.paths.uploadFile !== null)) throw fail('path_invalid');
    if (keys(value.serve) !== 'host,port' || !['127.0.0.1', '::1', 'localhost'].includes(value.serve.host)
      || !Number.isInteger(value.serve.port) || value.serve.port < 1 || value.serve.port > 65535) throw fail('listener_invalid');
    return value;
  }
  function create(host) {
    const pending = new Map();
    const wait = (ms, callback) => host.setTimeout(callback, ms);
    function environment(base) {
      const env = {};
      for (const [key, value] of Object.entries(host.env)) if (!SECRET_ENV.test(key)
        && !['NODE_OPTIONS', 'NODE_PATH', 'RUYI_TEST_SERVER_JS', 'WIN_CLAUDE_WORKBENCH_HOME'].includes(key.toUpperCase())) env[key] = value;
      env.RUYI_HOME = base;
      return env;
    }
    async function start(request) {
      if (pending.size) throw fail('busy');
      const base = await host.base();
      const input = validate({ schema: VERSION, id: request.id, nonce: cryptoApi.randomBytes(32).toString('hex'),
        base, parentPid: host.pid, operation: request.operation, password: request.password,
        expectedAuthority: { ...request.expectedAuthority },
        paths: { backupDirectory: request.backupDirectory, targetDirectory: request.targetDirectory || null,
          uploadFile: request.uploadFile || null, uploadSha256: request.uploadSha256 || null }, serve: { ...host.listener() } });
      // No await after the final concurrent-start check until this exact child is registered.
      if (pending.size) throw fail('busy');
      const child = host.spawn(environment(base));
      let state = 'waiting', closed = false, readyResolve, readyReject, armedResolve, armedReject;
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
      const armed = new Promise((resolve, reject) => { armedResolve = resolve; armedReject = reject; });
      // A pre-handoff failure can reject armed before handoff() attaches a consumer.
      void armed.catch(() => {}); void ready.catch(() => {});
      let timer;
      const release = () => {
        if (timer) { host.clearTimeout(timer); timer = null; }
        if (pending.get(input.id) === child) pending.delete(input.id);
      };
      const uncertain = () => state === 'committing' || state === 'armed';
      const rejected = suffix => {
        if (closed) return;
        closed = true;
        const error = fail(suffix, uncertain()); readyReject(error); armedReject(error);
        // A commitment uncertainty never reopens parent admission. No kill/retry is
        // attempted: the child may already be obtaining the actual base owner.
        if (!uncertain()) release();
      };
      child.on('error', () => rejected('worker_launch_failed'));
      child.on('exit', () => rejected('worker_exited'));
      child.on('disconnect', () => { if (state !== 'armed') rejected('worker_disconnected'); });
      child.on('message', message => {
        if (closed || keys(message) !== 'id,kind,nonce,schema' || message.schema !== VERSION
          || message.id !== input.id || message.nonce !== input.nonce) return;
        if (message.kind === 'ready' && state === 'waiting') {
          state = 'ready'; if (timer) { host.clearTimeout(timer); timer = null; } readyResolve();
        } else if (message.kind === 'armed' && state === 'committing') {
          state = 'armed'; if (timer) { host.clearTimeout(timer); timer = null; } armedResolve();
        }
      });
      pending.set(input.id, child);
      timer = wait(host.handshakeTimeoutMs || 15_000, () => rejected('worker_ready_timeout'));
      const bytes = Buffer.from(JSON.stringify(input), 'utf8');
      input.password = null;
      if (bytes.length > MAX_INPUT) { bytes.fill(0); rejected('input_invalid'); }
      else {
        child.stdin.on('error', () => rejected('worker_input_failed'));
        child.stdin.end(bytes, () => bytes.fill(0));
      }
      const send = kind => new Promise((resolve, reject) => {
        try { child.send({ schema: VERSION, kind, id: input.id, nonce: input.nonce }, error => error ? reject(error) : resolve()); }
        catch (error) { reject(error); }
      });
      return Object.freeze({ ready,
        async cancel() {
          if (state === 'committing' || state === 'armed') throw fail('handoff_committed', true);
          if (state === 'cancelled') return;
          state = 'cancelled'; closed = true; readyReject(fail('cancelled')); armedReject(fail('cancelled'));
          try { await send('cancel'); } catch { /* A dead uncommitted child cannot execute. */ }
          // The OS is the final owner of pipe handles. A nonresponsive uncommitted
          // worker remains incapable of execution; cleanup touches only this child.
          await host.stopUncommitted(child); release();
        },
        async handoff() {
          await ready;
          if (closed || state !== 'ready') throw fail('handoff_invalid', uncertain());
          state = 'committing';
          timer = wait(host.handshakeTimeoutMs || 15_000, () => rejected('worker_arm_timeout'));
          try { await send('go'); await armed; }
          catch { throw fail('handoff_uncertain', true); }
          // exitParent is called only after the child acknowledges the irrevocable
          // commitment. It exits the process; it must never release ownership early.
          await host.exitParent({ id: input.id });
        },
      });
    }
    async function runCold(channel) {
      if (!channel.parentConnected()) throw fail('ipc_required');
      const payload = await channel.readInput(MAX_INPUT);
      let input;
      try {
        if (!Buffer.isBuffer(payload) || payload.length > MAX_INPUT) throw fail('input_invalid');
        const raw = payload.toString('utf8');
        if (!Buffer.from(raw, 'utf8').equals(payload)) throw fail('input_invalid');
        input = validate(JSON.parse(raw));
      } catch { throw fail('input_invalid'); }
      finally { if (Buffer.isBuffer(payload)) payload.fill(0); }
      if (input.parentPid === host.pid || input.parentPid !== channel.parentPid()) throw fail('parent_invalid');
      let committed = false, helperHold = false, ownedFailureHeld = false;
      try {
        const command = await channel.waitCommand({ id: input.id, nonce: input.nonce,
          schema: VERSION, timeoutMs: host.handshakeTimeoutMs || 15_000,
          onListening: () => channel.send({ schema: VERSION, kind: 'ready', id: input.id, nonce: input.nonce }) });
        if (command !== 'go') return Object.freeze({ phase: 'cancelled' });
        committed = true;
        await channel.send({ schema: VERSION, kind: 'armed', id: input.id, nonce: input.nonce });
        // IPC disconnect alone is insufficient: a still-live/EPERM PID prevents
        // takeover. Parent death is necessary even if someone releases its IPC lock.
        await host.waitParentExit(input.parentPid);
        const base = await host.canonical(input.base);
        if (base !== await host.canonical(await host.base())) throw fail('base_changed', true);
        const owner = await host.acquire([base]);
        let active = true;
        const assertExclusive = candidate => active && candidate === owner
          && owner.roots.some(root => root === base);
        try {
          const current = await host.readAuthority(base);
          if (current.generation !== input.expectedAuthority.generation
            || current.id !== input.expectedAuthority.id || current.mode !== input.expectedAuthority.mode
            || current.proof.sha256 !== input.expectedAuthority.sha256) throw fail('authority_changed', true);
          return await host.execute({ ...input, nonce: undefined, ownership: owner, assertExclusive });
        } catch (error) {
          // A concrete native failure can arrive before the outer host records
          // it. Preserve that fact before considering release of the base owner.
          try {helperHold = error?.helperMayStillRun === true;} catch {helperHold = true;}
          if (typeof host.onOwnedFailure === 'function') {
            ownedFailureHeld = true;input.password = null;
            const safeInput = Object.freeze({id:input.id,operation:input.operation,parentPid:input.parentPid,
              serve:Object.freeze({...input.serve}),expectedAuthority:Object.freeze({...input.expectedAuthority})});
            await host.onOwnedFailure({error,ownership:owner,assertExclusive,base,input:safeInput});
          }
          throw error;
        } finally {
          // execute owns native-helper uncertainty. It must settle all helpers before
          // returning. A helperMayStillRun result cannot release its root exclusion.
          try {if (host.helperMayStillRun() !== false) helperHold = true;} catch {helperHold = true;}
          if (!helperHold && !ownedFailureHeld) { active = false; await owner.release(); }
        }
      } catch (error) {
        // Never mutate a foreign/frozen thrown value or infer retry from its shape.
        throw Object.assign(fail(committed ? 'worker_failed_after_handoff' : 'worker_failed', committed), { cause: error,
          ...(helperHold ? {helperMayStillRun:true} : {}),...(ownedFailureHeld ? {ownershipRetained:true} : {}) });
      } finally { input.password = null; }
    }
    return Object.freeze({ start, runCold, environment, busy: () => pending.size !== 0 });
  }
  function processChannel(proc = process) {
    return Object.freeze({
      parentConnected: () => proc.connected === true && typeof proc.send === 'function',
      parentPid: () => proc.ppid,
      readInput: maximum => new Promise((resolve, reject) => {
        const parts = []; let bytes = 0, settled = false;
        const finish = error => {
          if (settled) return; settled = true;
          proc.stdin.removeListener('data', data); proc.stdin.removeListener('end', end);
          proc.stdin.removeListener('error', bad); proc.removeListener('disconnect', disconnected);
          const result = error ? null : Buffer.concat(parts, bytes);
          for (const part of parts) part.fill(0);
          if (error) reject(error); else resolve(result);
        };
        const data = chunk => {
          if (!Buffer.isBuffer(chunk)) return finish(fail('input_invalid'));
          bytes += chunk.length;
          if (bytes > maximum) { chunk.fill(0); proc.stdin.pause(); return finish(fail('input_invalid')); }
          parts.push(Buffer.from(chunk)); chunk.fill(0);
        };
        const end = () => finish();
        const bad = () => finish(fail('input_invalid'));
        const disconnected = () => finish(fail('parent_disconnected'));
        proc.stdin.on('data', data); proc.stdin.once('end', end); proc.stdin.once('error', bad);
        proc.once('disconnect', disconnected);
        if (!proc.connected) disconnected();
      }),
      send: message => new Promise((resolve, reject) => {
        if (!proc.connected) return reject(fail('parent_disconnected'));
        try { proc.send(message, error => error ? reject(error) : resolve()); } catch (error) { reject(error); }
      }),
      waitCommand: ({ id, nonce, schema, timeoutMs, onListening }) => new Promise((resolve, reject) => {
        let settled = false, timer;
        const finish = (error, kind) => {
          if (settled) return; settled = true; clearTimeout(timer);
          proc.removeListener('message', message); proc.removeListener('disconnect', disconnected);
          if (error) reject(error); else resolve(kind);
        };
        const message = value => {
          if (keys(value) === 'id,kind,nonce,schema' && value.id === id && value.nonce === nonce
            && value.schema === schema && ['go', 'cancel'].includes(value.kind)) finish(null, value.kind);
        };
        const disconnected = () => finish(fail('parent_disconnected'));
        proc.on('message', message); proc.once('disconnect', disconnected);
        timer = setTimeout(() => finish(fail('commit_timeout')), timeoutMs);
        Promise.resolve().then(onListening).catch(error => finish(error));
        if (!proc.connected) disconnected();
      }),
    });
  }
  async function waitForProcessExit(pid, { probe = pid => process.kill(pid, 0),
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 120_000,
    now = Date.now } = {}) {
    const deadline = now() + timeoutMs;
    for (;;) {
      try { probe(pid); } catch (error) {
        if (error?.code === 'ESRCH') return;
        throw fail('parent_exit_unverified', true);
      }
      if (now() >= deadline) throw fail('parent_exit_timeout', true);
      await delay(50);
    }
  }
  function spawnCold(command, env) {
    if (!command || typeof command.command !== 'string' || !Array.isArray(command.args)
      || !command.args.every(value => typeof value === 'string')) throw fail('command_invalid');
    // Windows libuv normally puts a non-detached child in its own kill-on-close
    // job. That job dies with old serve, before takeover. DETACHED_PROCESS avoids
    // that libuv job; this does NOT request CREATE_BREAKAWAY_FROM_JOB. An outer
    // desktop job is inherited and still kills the worker when the app closes.
    return require('node:child_process').spawn(command.command, command.args, {
      env, detached: process.platform === 'win32', windowsHide: true,
      stdio: ['pipe', 'ignore', 'ignore', 'ipc'],
    });
  }
  return Object.freeze({ create, validate, processChannel, waitForProcessExit, spawnCold, MAX_INPUT });
})(require('node:crypto'), require('node:path'));
