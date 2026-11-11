'use strict';
// Loopback protocol receivers for the real encrypted browser media journey.
const assert = require('node:assert/strict');
const { startFakeProvider, textFrames } = require('./fake-openai-provider');
const { startFakeAnthropic, messageEvents } = require('./fake-anthropic-provider');

async function startMediaBrowserProvider(apiStyle, answer, receive) {
  const errors = [];
  const observe = async ctx => { await receive(ctx.body); };
  let fake;
  if (apiStyle === 'anthropic') {
    fake = await startFakeAnthropic({ handler: async ctx => {
      await observe(ctx);
      return messageEvents({ model: 'fake-model', text: answer });
    } });
  } else if (apiStyle === 'responses') {
    let sequence = 0;
    fake = await startFakeProvider({ handler: () => {
      errors.push(Error('Responses browser unexpectedly used Chat Completions'));
      return textFrames('Unexpected protocol');
    }, fallback: async (req, res) => {
      try {
        if (req.method === 'HEAD' && req.url === '/v1') { res.writeHead(200); res.end(); return; }
        assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/responses');
        let raw = '';
        req.setEncoding('utf8');
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        await receive(body);
        const id = 'response_browser_' + (++sequence);
        if (body.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const emit = value => res.write('data: ' + JSON.stringify(value) + '\n\n');
          emit({ type: 'response.created', response: { id, status: 'in_progress', output: [] } });
          emit({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg_browser', delta: answer });
          emit({ type: 'response.completed', response: { id, status: 'completed', output: [], usage: { input_tokens: 8, output_tokens: 4 } } });
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id, status: 'completed', output: [{ type: 'message', role: 'assistant',
            content: [{ type: 'output_text', text: answer }] }] }));
        }
      } catch (error) {
        errors.push(error);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Synthetic media browser receiver failed' } }));
      }
    } });
  } else throw Error('Unsupported browser media protocol');
  return { baseUrl: fake.url + (apiStyle === 'responses' ? '/v1' : ''),
    assert() { assert.deepEqual(errors, []); assert.deepEqual(fake.errors, []); }, close: () => fake.close() };
}

function wireMessages(body) { return body.input || body.messages; }
function wireImageUrl(part) {
  if (part.type === 'image_url') return part.image_url?.url;
  if (part.type === 'input_image') return part.image_url;
  if (part.type === 'image' && part.source?.type === 'base64' && part.source.media_type === 'image/png')
    return 'data:image/png;base64,' + part.source.data;
  return null;
}
module.exports = { startMediaBrowserProvider, wireMessages, wireImageUrl };
