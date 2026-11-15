// P5 bounded native desktop IPC. The helper is a leaf and never starts child processes.
const MacDesktopAutomationHooks = { helperPath: () => process.env.RUYI_MACOS_AUTOMATION_HELPER
  || require('node:path').resolve(__dirname, '..', 'runtime', 'macos', 'ruyi-automation-helper') };
const MacDesktopAutomation = (() => {
  const nativeProcess = require('node:child_process');
  const nativeFiles = require('node:fs');
  let active = 0;
  let probe = null;
  const fail = (code, error) => ({ ok: false, code, error });
  function stamp(file) {
    const stat = nativeFiles.statSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error('Not a regular helper');
    nativeFiles.accessSync(file, nativeFiles.constants.X_OK);
    return [file, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].join('|');
  }
  async function request(payload, signal, timeoutMs) {
    if (signal?.aborted) return fail('aborted', 'Desktop request cancelled');
    let input;
    try { input = JSON.stringify({ ...payload, version: 1 }); }
    catch { return fail('invalid_args', 'Desktop request cannot be encoded'); }
    if (Buffer.byteLength(input) > 65536) return fail('invalid_args', 'Desktop request exceeds its input limit');
    const file = MacDesktopAutomationHooks.helperPath();
    let identity;
    try { identity = stamp(file); }
    catch { return fail('dependency_missing', 'Mac automation helper is missing or not executable'); }
    if (active >= 2) return fail('capture_busy', 'Two native desktop requests are already running');
    active++;
    return new Promise(resolve => {
      let child, failure = null, size = 0, completed = false;
      const chunks = [];
      const stop = result => {
        failure = failure || result;
        if (child) { try { child.kill('SIGKILL'); } catch { /* owned leaf may already have exited */ } }
      };
      const abort = () => stop(fail('aborted', 'Desktop request cancelled'));
      const deadline = Math.max(1, Math.min(15000, Number(timeoutMs) || (payload.op === 'status' ? 3000 : 15000)));
      const timer = setTimeout(() => stop(fail('capture_timeout', 'Native desktop request timed out')), deadline);
      signal?.addEventListener('abort', abort, { once: true });
      const finish = result => {
        if (completed) return;
        completed = true;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); active--;
        chunks.length = 0; resolve(result);
      };
      try {
        child = nativeProcess.spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'], env: {} });
        child.once('error', () => { failure = fail('capture_failed', 'Cannot start native desktop helper'); });
        child.stdin.on('error', () => stop(fail('capture_failed', 'Native desktop input failed')));
        child.stdout.on('error', () => stop(fail('capture_failed', 'Native desktop output failed')));
        child.stdout.on('data', bytes => {
          size += bytes.length;
          if (failure) return;
          if (size > (payload.op === 'status' ? 65536 : 68 * 1024 * 1024)) {
            stop(fail('capture_capacity', 'Native desktop output exceeded its limit')); return;
          }
          chunks.push(bytes);
        });
        child.once('close', code => {
          if (failure) { finish(failure); return; }
          try {
            if (stamp(file) !== identity) { finish(fail('dependency_changed', 'Native desktop helper changed during request')); return; }
            const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!result || typeof result !== 'object' || typeof result.ok !== 'boolean'
              || (result.ok && (code !== 0 || result.protocolVersion !== 1))) throw new Error('Invalid envelope');
            finish(result);
          } catch { finish(fail('capture_failed', 'Invalid native desktop response')); }
        });
        child.stdin.end(input);
        if (signal?.aborted) abort();
      } catch {
        const result = fail('capture_failed', 'Cannot start native desktop helper');
        if (child) stop(result); else finish(result);
      }
    });
  }
  async function capabilitySnapshot() {
    if (process.platform !== 'darwin') return { supported: false, installed: false, authorization: 'not_required', ready: false };
    if (probe) return probe;
    probe = request({ op: 'status' }).then(status => ({ supported: true, installed: status.code !== 'dependency_missing',
      authorization: status.authorization || 'unknown', ready: status.ok === true && !!status.ready
        && status.authorization === 'granted' && status.locked === false && status.coordinate_space === 'macos_global_points'
        && Array.isArray(status.monitors) && status.monitors.length > 0,
      reasonCode: status.ok ? status.locked ? 'session_locked' : status.authorization !== 'granted' ? 'permission_denied'
        : !Array.isArray(status.monitors) || !status.monitors.length ? 'display_unavailable' : '' : status.code,
      coordinate_space: status.coordinate_space,
    })).finally(() => { probe = null; });
    return probe;
  }
  return { request, capabilitySnapshot };
})();
