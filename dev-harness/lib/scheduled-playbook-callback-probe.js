'use strict';
// Loaded only in the scheduled-playbooks fixture's workbench child.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const targets = new Set(JSON.parse(process.env.RUYI_FIXTURE_REPORT_PATHS));
const log = process.env.RUYI_FIXTURE_WRITE_LOG;

// Count successful publications of the report, including the in-place fallback.
for (const [method, destination] of [['rename', 1], ['writeFile', 0]]) {
  const original = fs.promises[method];
  fs.promises[method] = async function (...args) {
    const result = await original.apply(this, args);
    const target = typeof args[destination] === 'string' && path.resolve(args[destination]);
    if (targets.has(target)) {
      fs.appendFileSync(log, JSON.stringify({ target, method, pid: process.pid }) + '\n');
      // Hold the real tool after publication but before it can return a result.
      if (target === process.env.RUYI_FIXTURE_HOLD_AFTER_WRITE) await new Promise(() => {});
    }
    return result;
  };
}

// Let the real decision finish and send its status, but withhold the response
// body on the marked request. The client closes this connection on its deadline.
const end = http.ServerResponse.prototype.end;
http.ServerResponse.prototype.end = function (...args) {
  if (this.req?.url === '/api/permission/decision' && this.req.headers['x-fixture-hold-ack'] === '1') {
    this.flushHeaders();
    return this;
  }
  return end.apply(this, args);
};
