'use strict';
require('../lib/self-isolate-home');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { request, waitForTarget } = require('../lib/browser-fixture');
const { getFreePort } = require('../free-port');

async function serverFixture(t, handle) {
  const server = http.createServer(handle);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { port: server.address().port, sockets };
}

test('CDP target deadline cancels a server that never sends headers', { timeout: 8000 }, async t => {
  const fixture = await serverFixture(t, () => {});
  const started = performance.now();
  const found = await waitForTarget(fixture.port, 'http://fixture/', { exitCode: null, signalCode: null }, 250);
  assert.equal(found.target, null);
  assert.match(found.why, /never-responded/);
  assert.ok(performance.now() - started < 5000, 'the HTTP request must end inside the overall deadline');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fixture.sockets.size, 0, 'deadline cancellation closes the owned pending connection');
});

test('CDP deadline survives trickling response bytes without an end event', { timeout: 8000 }, async t => {
  let sent = 0;
  const fixture = await serverFixture(t, (incoming, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('[');
    const timer = setInterval(() => { sent++; response.write(' '); }, 20);
    response.on('close', () => clearInterval(timer));
  });
  const started = performance.now();
  const found = await waitForTarget(fixture.port, 'http://fixture/', null, 350);
  assert.equal(found.target, null);
  assert.ok(sent > 0, 'the response keeps making progress past an idle-only timeout');
  assert.ok(performance.now() - started < 5000, 'body progress cannot extend the overall deadline');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(fixture.sockets.size, 0);
});

test('shared request abort after headers settles without an unhandled response error', { timeout: 8000 }, async t => {
  const fixture = await serverFixture(t, (incoming, response) => {
    response.writeHead(200);
    response.write('unfinished');
  });
  const result = await request(fixture.port, 'GET', '/', null, null, 30000, AbortSignal.timeout(150));
  assert.equal(result, null);
});

test('an exited launcher may still publish its real browser target', { timeout: 8000 }, async t => {
  let calls = 0;
  const target = { type: 'page', url: 'http://fixture/page', webSocketDebuggerUrl: 'ws://fixture/target' };
  const fixture = await serverFixture(t, (incoming, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(++calls > 1 ? [target] : []));
  });
  const result = await waitForTarget(fixture.port, 'http://fixture/', { exitCode: 0, signalCode: null }, 2000);
  assert.deepEqual(result, { target });
  assert.ok(calls > 1, 'launcher exit must retain the later browser publication path');
});

test('launcher grace permits the CDP port to begin listening after launcher exit', { timeout: 8000 }, async t => {
  const target = { type: 'page', url: 'http://fixture/page', webSocketDebuggerUrl: 'ws://fixture/target' };
  // Start a separate listener only after waitForTarget has observed connection refusal.
  const delayed = http.createServer((incoming, response) => response.end(JSON.stringify([target])));
  const port = await getFreePort();
  const timer = setTimeout(() => delayed.listen(port, '127.0.0.1'), 150);
  t.after(async () => {
    clearTimeout(timer);
    delayed.closeAllConnections();
    await new Promise(resolve => delayed.close(resolve));
  });
  const found = await waitForTarget(port, 'http://fixture/', { exitCode: 0, signalCode: null }, 3000);
  assert.deepEqual(found, { target });
});

test('late successful HTTP data cannot bypass a delayed abort timer', { timeout: 8000 }, async t => {
  const target = { type: 'page', url: 'http://fixture/page', webSocketDebuggerUrl: 'ws://fixture/target' };
  t.mock.method(http, 'request', (options, receive) => {
    const pending = new EventEmitter();
    pending.end = () => queueMicrotask(() => {
      // Keep this microtask running past the budget before the abort timer gets its turn.
      const finish = performance.now() + 75;
      while (performance.now() < finish) { /* controlled event-loop delay */ }
      const response = new EventEmitter();
      response.statusCode = 200;
      receive(response);
      response.emit('data', JSON.stringify([target]));
      response.emit('end');
    });
    pending.destroy = () => pending.emit('error', new Error('cancelled'));
    return pending;
  });
  const result = await waitForTarget(1, 'http://fixture/', null, 20);
  assert.equal(result.target, null);
});

test('complete responses retain HTTP status and target-list failure diagnostics', { timeout: 8000 }, async t => {
  const fixture = await serverFixture(t, (incoming, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify([{ type: 'page', url: 'http://other/' }]));
  });
  const found = await waitForTarget(fixture.port, 'http://fixture/', null, 200);
  assert.equal(found.target, null);
  assert.match(found.why, /status=200/);
  assert.match(found.why, /page:http:\/\/other\//);
});

test('signal-terminated launcher is reported as exited at the discovery deadline', { timeout: 8000 }, async t => {
  const fixture = await serverFixture(t, (incoming, response) => response.end('[]'));
  const found = await waitForTarget(fixture.port, 'http://fixture/', { exitCode: null, signalCode: 'SIGKILL' }, 150);
  assert.equal(found.target, null);
  assert.match(found.why, /进程已退/);
  assert.match(found.why, /SIGKILL/);
  assert.doesNotMatch(found.why, /进程还活着/);
});
