'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('SSE process epoch resets replay watermark once, preserving the current stream and same-process deduplication', async () => {
  const { createEventStream } = await import(pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/event-stream.js')).href);
  const requests = [], events = [], instances = [];
  let writer;
  const stream = createEventStream({
    requestImpl: async (_url, options) => {
      requests.push(options.headers);
      return new Response(new ReadableStream({ start(controller) {
        writer = controller;
        options.signal.addEventListener('abort', () => { try { controller.close(); } catch {} });
      } }));
    },
  });
  const send = (event, data, id = '') => writer.enqueue(new TextEncoder().encode(`${id ? 'id: ' + id + '\n' : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  stream.on('thread.state', value => events.push(value));
  stream.on('server.instance', value => instances.push(value));
  try {
    stream.start(); await flush();
    send('presence.ack', { serverInstanceId: 'process-A' }); send('thread.state', { value: 'A' }, '8'); await flush();
    assert.equal(stream.stats().lastSeenSeq, 8); assert.equal(instances.length, 0);
    stream.stop(); stream.start(); await flush();
    assert.equal(requests[1]['last-event-id'], '8');
    send('thread.state', { value: 'replayed' }, '7'); send('presence.ack', { serverInstanceId: 'process-A' }); await flush();
    assert.equal(events.length, 1); assert.equal(instances.length, 0); assert.equal(stream.stats().replayed, 1);
    stream.stop(); stream.start(); await flush();
    send('presence.ack', { serverInstanceId: 'process-B' }); await flush();
    assert.equal(instances.length, 1); assert.equal(instances[0].previousServerInstanceId, 'process-A');
    assert.equal(stream.stats().lastSeenSeq, 0); assert.equal(stream.stats().lastEventId, '');
    send('thread.state', { value: 'B' }, '1'); await flush();
    assert.equal(stream.isConnected(), true, 'epoch must not increment the connection generation and interrupt its own readLoop');
    assert.deepEqual(events.map(row => row.value), ['A', 'B']);
    send('presence.ack', { serverInstanceId: 'process-B' }); await flush();
    assert.equal(instances.length, 1);
  } finally { stream.stop(); await flush(); }
});
