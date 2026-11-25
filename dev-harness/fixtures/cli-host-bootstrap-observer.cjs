'use strict';

// Passive diagnostics in the direct CLI only. Do not record bearer values, arguments or environment.
const dc = require('node:diagnostics_channel');
const fs = require('node:fs');
const path = require('node:path');
const log = path.join(path.dirname(process.env.RUYI_HOME), 'startup-events.ndjson');
function write(event) {
  fs.appendFileSync(log, JSON.stringify({ pid: process.pid, ...event }) + '\n');
}
const raw = process.env.RUYI_DESKTOP_CONTROL_V1;
write({ kind: 'started', declaration: raw === undefined ? 'unset' : raw === '' ? 'empty' : 'present' });
dc.channel('child_process').subscribe(({ process: child }) => {
  child.once('spawn', () => write({ kind: 'child', child: child.pid }));
});
const listen = dc.tracingChannel('net.server.listen');
listen.asyncStart.subscribe(({ options }) => {
  const transport = typeof options.path === 'string' ? 'ipc' : 'tcp';
  write({ kind: 'listen-attempt', transport });
});
listen.asyncEnd.subscribe(({ server }) => {
  const address = server.address();
  if (address && typeof address === 'object') write({ kind: 'listening', host: address.address, port: address.port });
  if (typeof address === 'string') write({ kind: 'ipc-listening', serveOwnership: /ruyi-serve-[a-f0-9]{64}$/.test(address) });
});
