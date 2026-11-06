// Handles authorize an owned execution. PIDs remain diagnostic values, never lookup keys.
const ProcessRuntimeHooks = {};
const ProcessRuntime = (() => {
  const childProcessModule = require('child_process');
  const filesystemModule = require('fs');
  const ownerContext = new (require('async_hooks').AsyncLocalStorage)();
  const entries = new WeakMap();
  const children = new WeakMap();
  let helperProbe = null;
  let helperProbeInflight = null;

  function helperProbeRequest() {
    const state = { supported: process.platform === 'darwin', installed: false, authorization: 'not_required',
      ready: false, reasonCode: 'platform.unsupported', code: 'process_helper_unavailable', escapeCoverage: 'observed-only' };
    if (!state.supported) return { state: Object.freeze(state) };
    const helper = ProcessRuntimeHooks.helperPath();
    let stamp;
    try {
      const stat = filesystemModule.statSync(helper, { bigint: true });
      state.installed = stat.isFile();
      if (!state.installed) throw new Error('Helper is not a regular file');
      filesystemModule.accessSync(helper, filesystemModule.constants.X_OK);
      stamp = [helper, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join('|');
    } catch (error) {
      helperProbe = null;
      state.reasonCode = error.code === 'ENOENT' ? 'platform.dependency_missing' : 'platform.dependency_unavailable';
      state.code = error.code === 'ENOENT' ? 'process_helper_missing' : 'process_helper_unavailable';
      return { state: Object.freeze(state) };
    }
    if (helperProbe && helperProbe.stamp === stamp && Date.now() - helperProbe.checkedAt < 1000) {
      return { helper, stamp, state: helperProbe.state, cached: true };
    }
    return { helper, stamp, state };
  }

  function publishHelperProbe(request, probe) {
    const { state, stamp } = request;
    let report = null;
    try { report = JSON.parse(probe.stdout); } catch { /* Invalid reports remain unavailable. */ }
    const valid = !probe.error && probe.status === 0 && report && report.protocolVersion === 2
      && report.guardian === true && report.supervise === true && report.privateFd === true && report.identityCleanup === true
      && report.escapeCoverage === 'observed-only';
    const unchanged = helperProbeRequest().stamp === stamp;
    state.ready = !!valid && unchanged;
    state.reasonCode = valid ? null : probe.error ? 'platform.dependency_unavailable' : 'platform.dependency_incompatible';
    state.code = valid ? null : probe.error ? 'process_helper_unavailable' : 'process_helper_incompatible';
    state.protocolVersion = valid ? 2 : null;
    state.deadline = !!valid && report.deadline === true;
    if (!unchanged) { state.reasonCode = 'platform.dependency_changed'; state.code = 'process_helper_unavailable'; }
    const frozen = Object.freeze(state);
    helperProbe = state.ready ? { stamp, checkedAt: Date.now(), state: frozen } : null;
    return frozen;
  }

  function helperCapability() {
    const request = helperProbeRequest();
    if (!request.stamp || request.cached) return request.state;
    // Synchronous execution admission retains the existing start() contract.
    const probe = childProcessModule.spawnSync(request.helper, ['--capabilities'], {
      encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
    });
    return publishHelperProbe(request, probe);
  }

  function helperCapabilityAsync() {
    const request = helperProbeRequest();
    if (!request.stamp || request.cached) return Promise.resolve(request.state);
    if (helperProbeInflight && helperProbeInflight.stamp === request.stamp) return helperProbeInflight.promise;
    const pending = { stamp: request.stamp };
    pending.promise = new Promise(resolve => {
      childProcessModule.execFile(request.helper, ['--capabilities'], {
        encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL', maxBuffer: 4096,
      }, (error, stdout) => {
        const exited = error && typeof error.code === 'number';
        resolve(publishHelperProbe(request, { error: exited ? null : error, stdout, status: exited ? error.code : error ? null : 0 }));
      });
    }).finally(() => { if (helperProbeInflight === pending) helperProbeInflight = null; });
    helperProbeInflight = pending;
    return pending.promise;
  }

  async function capabilitySnapshot() {
    const capabilities = {};
    if (process.platform === 'darwin') {
      const supervisor = await helperCapabilityAsync();
      let bashInstalled = false;
      try { await filesystemModule.promises.access('/bin/bash', filesystemModule.constants.X_OK); bashInstalled = true; } catch { /* unavailable */ }
      const shell = Object.freeze({ ...supervisor, installed: supervisor.installed && bashInstalled,
        ready: supervisor.ready && bashInstalled, tty: false,
        reasonCode: bashInstalled ? supervisor.reasonCode : 'platform.dependency_missing' });
      capabilities['process.supervisor'] = supervisor;
      capabilities['shell.exec'] = shell;
      capabilities['shell.session'] = shell;
    }
    return Object.freeze({ platform: process.platform, arch: process.arch, capabilities: Object.freeze(capabilities) });
  }

  function acceptControlMessage(entry, message, executable, onReady, onError) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || entry.guardianConfirmed) return false;
    if (message.event === 'guardian-cleanup' && !entry.guardianConfirmed && [0, 1].includes(message.detail)
      && [message.value, message.terminated, message.alreadyExited, message.observed]
        .every(value => Number.isSafeInteger(value) && value >= 0 && value <= 32768)
      && message.value + message.terminated + message.alreadyExited === message.observed) {
      entry.guardianConfirmed = true;
      entry.result.guardianCleanup = { incomplete: message.detail !== 1 || message.value > 0,
        unconfirmed: message.value, terminated: message.terminated, alreadyExited: message.alreadyExited, observed: message.observed };
      if (entry.result.guardianCleanup.incomplete) { entry.guardianLost = true; entry.result.incomplete = true; helperProbe = null; }
    } else if (entry.phase === 'starting' && message.event === 'started' && Number.isSafeInteger(message.value) && message.value > 1 && /^\d+$/.test(message.created)) {
      entry.phase = 'running';
      entry.identity = Object.freeze({ pid: message.value, created: message.created });
      onReady({ ok: true });
    } else if (entry.phase === 'running' && entry.allowDeadline && !entry.deadlineSeen && message.event === 'deadline' && message.value === 1 && message.detail === 0) {
      entry.deadlineSeen = true;
    } else if (entry.phase === 'running' && message.event === 'cleanup' && [0, 1].includes(message.detail) && [message.value, message.terminated, message.alreadyExited, message.observed]
      .every(value => Number.isSafeInteger(value) && value >= 0 && value <= 32768)
      && message.observed > 0 && message.value + message.terminated + message.alreadyExited === message.observed) {
      entry.phase = 'cleaned';
      entry.result.unconfirmed = message.value;
      entry.result.terminated = message.terminated;
      entry.result.alreadyExited = message.alreadyExited;
      entry.result.incomplete = message.detail !== 1 || message.value > 0 || entry.guardianLost === true;
    } else if (entry.phase === 'starting' && message.event === 'error' && Number.isSafeInteger(message.value) && message.value > 0 && message.value < 4096) {
      entry.phase = 'running';
      const error = new Error(`Unable to execute ${executable} (errno ${message.value})`);
      error.code = require('util').getSystemErrorName(-message.value);
      onError(error);
    } else if (entry.phase === 'cleaned' && message.event === 'exit' && Number.isInteger(message.value)
      && message.value >= -1 && message.value <= 255 && Number.isInteger(message.detail) && message.detail >= 0 && message.detail < 128
      && (message.value === -1 ? message.detail > 0 : message.detail === 0)) {
      entry.commandExitCode = message.value < 0 ? null : message.value;
      entry.commandSignal = message.detail;
      entry.phase = 'done';
    } else return false;
    return true;
  }

  function start({ executable, argv = [], cwd, env, stdinMode = 'ignore', deadlineMs, owner, spawnOptions = {} }) {
    const handle = Object.freeze({});
    const helper = process.platform === 'darwin' ? ProcessRuntimeHooks.helperPath() : '';
    const supervised = process.platform === 'darwin';
    if (supervised) {
      const capability = helperCapability();
      if (!capability.ready) throw Object.assign(new Error('Mac process supervisor is unavailable'), { code: capability.code, capability });
    }
    const stdio = spawnOptions.stdio || [stdinMode, 'pipe', 'pipe'];
    const options = { ...spawnOptions, cwd, env, stdio };
    const extraStdio = options.extraStdio || [];
    delete options.extraStdio;
    if (!Array.isArray(extraStdio) || extraStdio.length > 1 || extraStdio.some(mode => mode !== 'pipe')) throw new TypeError('Unsupported private process channels');
    if (extraStdio.length && !supervised) throw new Error('Private shell channels require the native process supervisor');
    if (supervised) {
      // Match Node's shell command joining, while keeping the shell inside the supervisor.
      if (options.shell) {
        argv = ['-c', [executable, ...argv].join(' ')];
        executable = typeof options.shell === 'string' ? options.shell : '/bin/sh';
        options.shell = false;
      }
      const streams = Array.isArray(stdio) ? stdio : [stdio, stdio, stdio];
      if (streams.length !== 3 || streams.includes('ipc')) throw new TypeError('Supervised processes require exactly three standard streams');
      options.detached = false; // The native supervisor establishes its own session before fork.
      options.stdio = [...streams, 'pipe', ...extraStdio];
    }
    const supervisorArgs = extraStdio.length ? ['--supervise-v2-with-fds', String(extraStdio.length), executable, ...argv] : ['--supervise-v2', executable, ...argv];
    const child = childProcessModule.spawn(supervised ? helper : executable, supervised ? supervisorArgs : argv, options);
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    let resolveCompletion;
    const completion = new Promise(resolve => { resolveCompletion = resolve; });
    const entry = { child, supervised, owner: Object.freeze({ ...(owner || {}) }), identity: null, ready,
      result: { killed: [], scope: supervised ? 'owned-group-and-observed' : 'direct-child', incomplete: true,
        escapeCoverage: 'observed-only' }, completion, timer: null, finished: false, exited: false, controlEnded: !supervised };
    const finish = () => {
      if (entry.finished || !entry.exited || !entry.controlEnded) return;
      entry.finished = true;
      resolveReady({ ok: false, error: entry.error || new Error('Process exited before execution readiness') });
      if (entry.supervised && (entry.phase !== 'done' || !entry.guardianConfirmed)) { helperProbe = null; entry.result.incomplete = true; }
      clearTimeout(entry.timer);
      resolveCompletion({ ...entry.result, code: entry.code, signal: entry.signal,
        commandExitCode: entry.commandExitCode, commandSignal: entry.commandSignal,
        status: entry.result.incomplete ? 'incomplete' : entry.result.terminated > 0 ? 'terminated' : 'already_exited',
        ...(entry.error ? { error: entry.error } : {}) });
    };
    entries.set(handle, entry);
    children.set(child, handle);
    if (supervised) {
      const control = child.stdio[3];
      let buffer = '';
      entry.phase = 'starting';
      const rejectProtocol = () => { helperProbe = null; entry.phase = 'invalid'; entry.result.incomplete = true; control.destroy(); };
      control.setEncoding('utf8');
      control.on('error', rejectProtocol);
      control.on('end', () => {
        if (buffer) rejectProtocol();
        entry.controlEnded = true; control.destroy(); finish();
      });
      control.on('close', () => { entry.controlEnded = true; finish(); });
      control.on('data', chunk => {
        buffer += chunk;
        if (buffer.length > 4096) { rejectProtocol(); return; }
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { rejectProtocol(); return; }
          if (!acceptControlMessage(entry, message, executable, resolveReady, error => child.emit('error', error))) { rejectProtocol(); return; }
        }
      });
    }
    child.once('error', error => { helperProbe = null; entry.error = error; resolveReady({ ok: false, error }); });
    if (!supervised) child.once('spawn', () => resolveReady({ ok: true }));
    child.once('exit', (code, signal) => {
      entry.exited = true; entry.code = code; entry.signal = signal;
      if (entry.supervised && (entry.phase !== 'done' || !entry.guardianConfirmed)) {
        // exit can precede delivery of already-written control frames. Decide completeness
        // only after the readable side ends; close the write side now to wake a surviving primary.
        const control = child.stdio[3];
        if (!control.destroyed && !control.writableEnded) control.end();
      }
      finish();
    });
    child.once('close', (code, signal) => {
      entry.exited = true; entry.controlEnded = true; entry.code = code; entry.signal = signal;
      finish();
    });
    if (Number.isFinite(deadlineMs) && deadlineMs > 0) {
      entry.timer = setTimeout(() => stop(handle, 'deadline'), deadlineMs);
      entry.timer.unref();
    }
    return handle;
  }

  function spawn(executable, argv, options, owner) {
    const handle = start({ executable, argv, cwd: options.cwd, env: options.env, spawnOptions: options, owner });
    return getEntry(handle).child;
  }

  function capture(executable, argv, options, owner) {
    const maxBuffer = options.maxBuffer;
    if (typeof maxBuffer !== 'number' || maxBuffer < 0 || Number.isNaN(maxBuffer)) {
      throw Object.assign(new RangeError('maxBuffer must be a non-negative number'), { code: 'ERR_OUT_OF_RANGE' });
    }
    const child = spawn(executable, argv, { cwd: options.cwd, env: options.env, windowsHide: options.windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'] }, owner);
    const handle = children.get(child);
    const chunks = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure = null;
    let settled = false;
    let drainTimer = null;
    let resolveOutput;
    const output = new Promise(resolve => { resolveOutput = resolve; });
    const finishOutput = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(drainTimer);
      const decode = name => {
        const buffer = Buffer.concat(chunks[name], sizes[name]);
        return options.encoding === 'buffer' ? buffer : buffer.toString('utf8');
      };
      const stdout = decode('stdout');
      const stderr = decode('stderr');
      if (!failure && (code !== 0 || signal)) {
        failure = Object.assign(new Error(`Command failed: ${executable}`), { code, signal });
      }
      resolveOutput({ error: failure, stdout, stderr });
    };
    for (const name of ['stdout', 'stderr']) {
      child[name].on('error', error => { failure = failure || error; void stop(handle, 'output-error'); });
      child[name].on('data', chunk => {
        const remaining = Math.max(0, maxBuffer - sizes[name]);
        const accepted = chunk.subarray(0, remaining);
        if (accepted.length) { chunks[name].push(accepted); sizes[name] += accepted.length; }
        if (chunk.length > remaining && !failure) {
          failure = Object.assign(new RangeError(`${name} maxBuffer length exceeded`), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
          void stop(handle, 'output-limit');
        }
      });
    }
    child.on('error', error => { failure = failure || error; });
    child.once('close', finishOutput);
    void getEntry(handle).completion.then(result => {
      if (settled) return;
      // An unobserved escaping child may retain stdio after the supervised executable exits.
      drainTimer = setTimeout(() => {
        failure = failure || Object.assign(new Error('Process output pipes did not close after exit'), { code: 'ERR_PROCESS_OUTPUT_INCOMPLETE' });
        child.stdout.destroy(); child.stderr.destroy();
        finishOutput(result.code, result.signal);
      }, 500);
    });
    return { child, output };
  }

  function getEntry(handle) {
    const entry = entries.get(handle);
    if (!entry) throw new TypeError('Unknown process handle');
    return entry;
  }

  function stop(handle, reason = 'cancelled') {
    const entry = getEntry(handle);
    if (!entry.finished) {
      entry.reason = reason;
      if (entry.supervised) {
        const control = entry.child.stdio[3];
        // EOF also covers server death. No command output is accepted as a control channel.
        if (!control.destroyed && !control.writableEnded) control.end();
      } else ProcessRuntimeHooks.stopUnsupervised(entry.child);
    }
    return entry.completion;
  }

  async function waitForCleanup(child, timeoutMs = 1000) {
    const handle = children.get(child);
    if (!handle) return null;
    const entry = getEntry(handle);
    let timer;
    try {
      return await Promise.race([entry.completion, new Promise(resolve => {
        timer = setTimeout(() => resolve({ ...entry.result, incomplete: true, status: 'incomplete' }), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }

  function stopChild(child) {
    const handle = children.get(child);
    if (!handle) return null;
    const entry = getEntry(handle);
    if (!entry.supervised) return null;
    void stop(handle);
    return entry.result;
  }

  async function probe(command, argv, spawnOptions = {}, timeout = 4000) {
    const deadlineMs = spawnOptions.timeout === undefined ? timeout : spawnOptions.timeout;
    let handle;
    try {
      if (typeof deadlineMs !== 'number') throw Object.assign(new TypeError('timeout must be a number'), { code: 'ERR_INVALID_ARG_TYPE' });
      if (!Number.isInteger(deadlineMs) || deadlineMs < 0) throw Object.assign(new RangeError('timeout must be a non-negative integer'), { code: 'ERR_OUT_OF_RANGE' });
      handle = start({ executable: command, argv, cwd: spawnOptions.cwd, env: spawnOptions.env,
        spawnOptions: { ...spawnOptions, timeout: undefined, stdio: 'ignore' },
        owner: { ...ownerContext.getStore(), kind: 'executable-probe' } });
    } catch (error) { return { error, status: null }; }
    const child = getEntry(handle).child;
    let timer, timedOut = false;
    const deadline = new Promise(resolve => {
      if (deadlineMs === 0) return;
      timer = setTimeout(async () => {
        timedOut = true;
        let result = { scope: 'unknown', incomplete: true };
        try {
          stopChild(child);
          result = await waitForCleanup(child, 1500);
        } catch { /* preserve uncertainty */ }
        resolve(result);
      }, deadlineMs);
    });
    try {
      const result = await Promise.race([getEntry(handle).completion, deadline]);
      const error = result.incomplete
        ? Object.assign(new Error('Executable probe cleanup has not been confirmed'), { code: 'process_cleanup_incomplete' })
        : result.error || null;
      return { error, status: error || timedOut || result.commandSignal ? null : result.commandExitCode ?? result.code ?? null,
        cleanupScope: result.scope, cleanupIncomplete: result.incomplete === true,
        cleanupEscapeCoverage: result.escapeCoverage, cleanupUnconfirmed: result.unconfirmed };
    } finally { clearTimeout(timer); }
  }

  // Probe-only interface: ignored stdio or captured stdout/stderr, with no input or shell.
  function probeSync(command, argv, options = {}) {
    const failure = (code, message) => ({ status: null, signal: null, stdout: null, stderr: null,
      error: Object.assign(new Error(message), { code }) });
    const timeout = options.timeout === undefined ? 4000 : options.timeout;
    const maxBuffer = options.maxBuffer === undefined ? 1024 * 1024 : options.maxBuffer;
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 2147483647) return failure('ERR_OUT_OF_RANGE', 'Invalid probe timeout');
    if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > 64 * 1024 * 1024) return failure('ERR_OUT_OF_RANGE', 'Invalid probe output budget');
    if (options.encoding && options.encoding !== 'buffer' && !Buffer.isEncoding(options.encoding)) return failure('ERR_INVALID_ARG_VALUE', 'Invalid probe encoding');
    const capability = helperCapability();
    if (!capability.ready || !capability.deadline) return failure(capability.code || 'process_helper_incompatible', 'Native deadline supervisor is unavailable');
    const ignored = options.stdio === 'ignore';
    let raw;
    try {
      raw = childProcessModule.spawnSync(ProcessRuntimeHooks.helperPath(), ['--supervise-v2-deadline', String(timeout), command, ...argv], {
        cwd: options.cwd, env: options.env, windowsHide: true,
        stdio: ['ignore', ignored ? 'ignore' : 'pipe', ignored ? 'ignore' : 'pipe', 'pipe'],
        timeout: timeout ? Math.min(timeout + 4000, 2147483647) : 0, killSignal: 'SIGKILL',
        maxBuffer: ignored ? 4096 : 2 * maxBuffer + 4096,
      });
    } catch (error) { return { ...failure(error.code, error.message), error }; }
    const entry = { phase: 'starting', allowDeadline: timeout > 0,
      result: { scope: 'owned-group-and-observed', incomplete: true, escapeCoverage: 'observed-only' } };
    const control = raw.output?.[3];
    let valid = Buffer.isBuffer(control) && control.length <= 4096 && control.length > 0 && control.at(-1) === 10;
    if (valid) {
      try {
        for (const line of control.toString('utf8').slice(0, -1).split('\n')) {
          if (!acceptControlMessage(entry, JSON.parse(line), command, () => {}, error => { entry.error = error; })) { valid = false; break; }
        }
      } catch { valid = false; }
    }
    const signals = require('os').constants.signals;
    const actualSignal = raw.signal ? signals[raw.signal] : 0;
    const matchingExit = entry.commandSignal ? actualSignal === entry.commandSignal : !raw.signal && raw.status === entry.commandExitCode;
    const incomplete = !!raw.error || !valid || entry.phase !== 'done' || !entry.guardianConfirmed || entry.result.incomplete || !matchingExit;
    let error = raw.error || entry.error || null;
    if (!ignored && [raw.stdout, raw.stderr].some(buffer => buffer && buffer.length > maxBuffer)) {
      error = Object.assign(new Error('Probe output budget exceeded'), { code: 'ENOBUFS' });
    }
    if (entry.deadlineSeen) error = Object.assign(new Error('Probe timed out'), { code: 'ETIMEDOUT' });
    if (incomplete) {
      helperProbe = null;
      error = Object.assign(new Error('Synchronous probe cleanup has not been confirmed'), { code: 'process_cleanup_incomplete' });
    }
    const decode = buffer => buffer && options.encoding && options.encoding !== 'buffer' ? buffer.toString(options.encoding) : buffer;
    const stdout = decode(raw.stdout), stderr = decode(raw.stderr);
    return { ...raw, output: [null, stdout, stderr], stdout, stderr, error,
      status: error || entry.commandSignal ? null : entry.commandExitCode,
      cleanupScope: entry.result.scope, cleanupIncomplete: incomplete,
      cleanupEscapeCoverage: entry.result.escapeCoverage, cleanupUnconfirmed: entry.result.unconfirmed };
  }

  return Object.freeze({ start, spawn, capture, probe, probeSync, stop, stopChild, waitForCleanup, helperCapability, helperCapabilityAsync, capabilitySnapshot,
    withOwner: (owner, work) => ownerContext.run(Object.freeze({ ...owner }), work),
    currentOwner: () => ownerContext.getStore(),
    handle: child => children.get(child) || null,
    ready: child => getEntry(children.get(child)).ready,
    child: handle => getEntry(handle).child,
    completion: handle => getEntry(handle).completion,
    identity: handle => getEntry(handle).identity,
    owner: handle => getEntry(handle).owner,
    result: child => { const handle = children.get(child); return handle ? getEntry(handle).result : null; },
  });
})();
