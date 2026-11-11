'use strict';
// Test-only observation. Never supplies an owner, deadline, source or response.
const fs = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const CHANNEL = 'ruyi:media-image-phase';
const PHASES = new Set([
  'host.prepare.begin', 'host.config.begin', 'host.config.end', 'host.session.begin', 'host.session.end',
  'host.source.begin', 'host.source.end', 'host.processor.wait.begin', 'host.processor.wait.end', 'host.prepare.ready',
  'host.preview.borrow.begin', 'host.preview.borrow.end', 'host.preview.response.begin', 'host.preview.response.end',
  'processor.init.verify.begin', 'processor.init.verify.end', 'processor.init.executable.begin', 'processor.init.executable.end',
  'processor.job.begin', 'processor.job.preverify.begin', 'processor.job.preverify.end',
  'processor.job.executable.begin', 'processor.job.executable.end', 'processor.job.spawn.call', 'processor.job.spawn.event',
  'processor.job.stdin.begin', 'processor.job.stdin.end', 'processor.job.output.first', 'processor.job.exit', 'processor.job.close',
  'processor.job.postverify.begin', 'processor.job.postverify.end', 'processor.job.postexecutable.begin', 'processor.job.postexecutable.end',
  'processor.job.decode.begin', 'processor.job.decode.end', 'processor.job.stop', 'processor.job.settle.error', 'processor.job.settle.success',
  'service.pipeline.begin', 'service.pipeline.end', 'service.store.open.begin', 'service.store.open.end',
  'service.store.put.begin', 'service.store.put.end',
]);
function routeFor(raw) {
  if (typeof raw !== 'string') return null;
  const route = raw.split('?')[0];
  if (route === '/api/upload') return 'upload';
  if (route === '/api/media/images/prepare') return 'prepare';
  if (/^\/api\/media\/images\/[a-f0-9]{32}\/preview$/.test(route)) return 'preview';
  return null;
}
function install({ file, emitter = process, serverPrototype = require('node:http').Server.prototype,
  clock = () => process.hrtime.bigint(), limit = 4096 } = {}) {
  const fd = fs.openSync(file, 'wx', 0o600), context = new AsyncLocalStorage();
  const original = serverPrototype.emit;
  let sequence = 0, count = 0, disposed = false;
  function record(scope, event, extra = {}) {
    try {
      if (disposed || count >= limit) return;
      const elapsedMs = Math.round(Number(clock() - scope.started) / 1000) / 1000;
      const row = { request: scope.request, route: scope.route, event, elapsedMs, ...extra };
      count++;
      fs.writeSync(fd, JSON.stringify(row) + '\n');
    } catch { /* A diagnostic write never fails a request. */ }
  }
  function observe(value) {
    try {
      const scope = context.getStore();
      if (scope && value && Object.isFrozen(value) && Object.keys(value).length === 1 &&
        typeof value.phase === 'string' && PHASES.has(value.phase)) record(scope, value.phase);
    } catch { /* A diagnostic listener never throws. */ }
  }
  function emit(event, ...args) {
    if (event !== 'request') return Reflect.apply(original, this, [event, ...args]);
    const [req, res] = args;
    let scope;
    try {
      const route = routeFor(req.url);
      if (route) {
        scope = { request: ++sequence, route, started: clock() };
        record(scope, 'http.request');
        res.once('finish', () => record(scope, 'http.finish', { status: res.statusCode }));
        res.once('close', () => record(scope, 'http.close', { aborted: Boolean(req.aborted), finished: Boolean(res.writableFinished) }));
      }
    } catch { /* Preserve the actual HTTP dispatch on observation failure. */ }
    return scope ? context.run(scope, () => Reflect.apply(original, this, [event, ...args]))
      : Reflect.apply(original, this, [event, ...args]);
  }
  emitter.on(CHANNEL, observe);
  serverPrototype.emit = emit;
  return { close() {
    if (disposed) return;
    disposed = true;
    emitter.removeListener(CHANNEL, observe);
    if (serverPrototype.emit === emit) serverPrototype.emit = original;
    fs.closeSync(fd);
  } };
}
function printTiming(file, prefix) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    // The file already contains only fixed enums, anonymous ordinals and numbers.
    console.log(prefix + ' ' + JSON.stringify({ rows, observationOnly: true, nativeInternals: 'unknown' }));
  } catch { console.log(prefix + ' ' + JSON.stringify({ available: false, observationOnly: true })); }
}
module.exports = { CHANNEL, PHASES, routeFor, install, printTiming };
