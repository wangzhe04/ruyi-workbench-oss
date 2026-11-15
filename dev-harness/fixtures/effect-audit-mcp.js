'use strict';
// Synthetic result producer: no desktop APIs or claimed native dispatch. Used only by the
// ordinary-session offline regression to exercise raw projection before display shrinking.
const fs = require('node:fs');
const tools = ['macro_run', 'input_sequence'].map(name => ({ name, description: 'Synthetic effect ledger contract',
  inputSchema: { type: 'object', properties: { fixture_case: { type: 'string' } }, required: ['fixture_case'] } }));
const step = (tool, result, i = 0) => ({ step: i, tool, invocation_attempted: true, ok: result.ok !== false, result });
function result(name, mode) {
  if (name === 'input_sequence') return { ok: true, action_sent: true, event_count: 2 };
  const base = { step_invocation_schema: 1, success: true, completed: 2, failed: 0,
    results: [step('focus_window', { ok: true, acted: true }), step('input_sequence', { ok: true, action_sent: true }, 1)] };
  if (mode === 'large') return { ...base, padding: 'synthetic-private-padding'.repeat(30000) };
  if (mode === 'wait') return { ...base, results: [step('wait', { ok: true }), step('observe', { ok: true }, 1)] };
  if (mode === 'partial') return { ...base, success: false, completed: 1, failed: 1,
    results: [{ ...base.results[1], step: 0 }, { step: 1, tool: 'mouse_drag', invocation_attempted: true, ok: false, error: 'synthetic attempted error' }] };
  if (mode === 'unknown') return { ok: false, outcome: 'unknown', action_sent: false };
  return base;
}
const send = (id, value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result: value }) + '\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') send(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'effect-audit-fixture', version: '1' } });
  else if (msg.method === 'tools/list') send(msg.id, { tools });
  else if (msg.method === 'tools/call') {
    const name = msg.params.name, mode = msg.params.arguments.fixture_case;
    fs.appendFileSync(process.env.RUYI_EFFECT_CALL_LOG, JSON.stringify({ name, mode }) + '\n');
    send(msg.id, { content: [{ type: 'text', text: JSON.stringify(result(name, mode)) }] });
  }
});
