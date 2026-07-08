#!/usr/bin/env node
'use strict';
/*
 * fake-claude-transient.js - companion to agent-workflow-claude-transient-repro.e2e.js.
 *
 * Spawned (via `node fake-claude-transient.js`) when WCW_FAKE_CLAUDE points at it. Emulates a Claude CLI
 * whose FIRST invocation surfaces a transient overloaded/503 error (the kind the CLI's own retry budget
 * can exhaust), and whose SECOND invocation returns a clean stream-json success. A shared counter file
 * (WCW_FAKE_TRANSIENT_COUNTER) makes the per-process invocations stateful across spawns.
 *
 * The success payload is a quality-gate JSON matching the repro's outputSchema, so the DAG node's schema
 * validation passes on the retried attempt.
 */
const fs = require('fs');

const counterFile = process.env.WCW_FAKE_TRANSIENT_COUNTER;
let n = 0;
if (counterFile) { try { n = Number(fs.readFileSync(counterFile, 'utf8')) || 0; } catch { /* first run */ } }
n += 1;
if (counterFile) { try { fs.writeFileSync(counterFile, String(n)); } catch { /* ignore */ } }

const SID = 'fake-' + n;
const emit = o => process.stdout.write(JSON.stringify(o) + '\n');
const GOOD = JSON.stringify({ verdict: 'pass', confidence: 0.9, summary: 'verified', findings: [] });

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', () => {
  if (n === 1) {
    // First attempt: a transient gateway blip the CLI surfaces after exhausting its own retry budget.
    process.stderr.write('Error: 503: {"type":"overloaded_error","message":"Overloaded"}\n');
    process.exit(2);
  }
  // Second+ attempt: clean stream-json success (init -> assistant text -> result).
  emit({ type: 'system', subtype: 'init', session_id: SID, tools: [], model: 'fake-claude' });
  emit({ type: 'assistant', session_id: SID, message: { role: 'assistant', content: [{ type: 'text', text: GOOD }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: GOOD, session_id: SID, duration_ms: 100, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 5, output_tokens: 1 } });
  // Let the stdout pipe drain before exit (process.exit can truncate a pipe mid-flush).
  setTimeout(() => process.exit(0), 20);
});
// Safety: if stdin never ends (should not happen - the workbench ends stdin after writing the task),
// proceed after a short grace so the spawn never wedges the test.
setTimeout(() => { try { process.stdin.emit('end'); } catch { /* already ended */ } }, 500);
