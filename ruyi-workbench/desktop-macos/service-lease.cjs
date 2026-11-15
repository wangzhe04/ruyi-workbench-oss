'use strict';
// Loaded only by the native host's Node invocation. EOF means its owning App has exited,
// including SIGKILL. Use the normal server SIGTERM path so existing runtime cleanup runs.
const fs = require('node:fs');
if (process.platform !== 'darwin' || !fs.fstatSync(0).isFIFO()) {
  throw new Error('The desktop service requires a private stdin lease on macOS');
}
if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('Node.js 20 or newer is required');
process.stdin.once('end', () => process.kill(process.pid, 'SIGTERM'));
process.stdin.once('error', () => process.kill(process.pid, 'SIGTERM'));
process.stdin.resume();
