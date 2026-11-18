'use strict';
const phases = new Set(['script-enter', 'registered', 'active', 'cold-runtime-denied', 'issue-request', 'issue-reply',
  'transfer-request', 'transferred', 'pipe-connect', 'pipe-data', 'pipe-end', 'pipe-error', 'pipe-close',
  'fixture-failed', 'uncaught-exception', 'process-exit']);
const codes = new Set(['EOF', 'EPIPE', 'ECONNRESET', 'ECONNREFUSED', 'ERR_IPC_CHANNEL_CLOSED', 'ERR_STREAM_DESTROYED',
  'desktop_lifetime.channel_unavailable', 'desktop_lifetime.channel_closed', 'desktop_lifetime.response_timeout',
  'desktop_lifetime.protocol', 'desktop_lifetime.frame_budget', 'SCENE_COLD_CONFIG_READ']);

module.exports = function coldPhaseTrace(fs, path, output, proc) {
  let fd;
  try { fd = fs.openSync(path.join(output, 'cold-pipe-phases.jsonl'), 'wx'); } catch { /* Existing evidence stays untouched. */ }
  let rows = 0;
  function record(phase, error) {
    if (fd === undefined || !phases.has(phase) || rows >= 40) return;
    const code = Object.getOwnPropertyDescriptor(error || {}, 'code')?.value;
    const message = Object.getOwnPropertyDescriptor(error || {}, 'message')?.value;
    const errorClass = codes.has(code) ? code : codes.has(message) ? message : error ? 'unclassified' : null;
    try {
      fs.writeSync(fd, JSON.stringify({ schema: 1, seq: ++rows, phase, pid: proc.pid,
        parentIpcConnected: proc.connected === true, errorClass }) + '\n');
    } catch { fd = undefined; }
  }
  record('script-enter');
  proc.on('uncaughtExceptionMonitor', error => record('uncaught-exception', error));
  proc.once('exit', () => record('process-exit'));
  return Object.freeze({
    record, failure: record,
    observe(socket) {
      socket.once('connect', () => record('pipe-connect'));
      socket.on('data', () => record('pipe-data'));
      socket.once('end', () => record('pipe-end'));
      socket.once('error', error => record('pipe-error', error));
      socket.once('close', () => record('pipe-close'));
    },
  });
};
