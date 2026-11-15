'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-effect-unit-'));
for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) process.env[key] = path.join(root, key);
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
const { loadServerInternals } = require('../lib/server-internals');
const { projectBridgedIrreversible: project, buildTurnSummary: summary, foldTurnSummaries: fold, boundToolResultForDisplay: bound } = loadServerInternals([
  'projectBridgedIrreversible', 'buildTurnSummary', 'foldTurnSummaries', 'boundToolResultForDisplay',
]);
after(() => fs.rmSync(root, { recursive: true, force: true }));
const prefix = 'ai_computer_control__';
const call = (tool, result, input = {}) => ({ id: 'call_owned', name: prefix + tool, input, result });
const proxy = tc => ({ ...tc, name: 'tool_invoke_exec', input: { name: tc.name, arguments: tc.input } });
const step = (tool, result, i = 0) => ({ step: i, tool, ok: result?.ok !== false, result });
const batch = rows => ({ success: rows.every(row => row?.ok), completed: rows.filter(row => row?.ok).length, failed: rows.filter(row => !row?.ok).length, results: rows });
const effects = tc => summary(1, [tc], 'openai', []).irreversible;

test('direct/proxy leaves retain reported input and tool failures separately', () => {
  for (const wrap of [x => x, proxy]) {
    const rows = effects(wrap(call('input_sequence', { ok: false, action_sent: true, outcome: 'unconfirmed' })));
    assert.equal(rows.length, 1); assert.equal(rows[0].effectStatus, 'reported'); assert.equal(rows[0].ok, false);
    assert.equal(rows[0].name, prefix + 'input_sequence'); assert.equal(rows[0].callId, 'call_owned');
    assert.equal(rows[0].outcome, 'unconfirmed');
  }
});
test('returned macro children identify duplicate steps without outer double-counting or requested suffixes', () => {
  const tc = proxy(call('macro_run', batch([step('focus_window', { ok: true, acted: true }), step('input_sequence', { ok: true, action_sent: true }, 1),
    step('wait', { success: true }, 2), step('get_clipboard', { ok: true }, 3), step('input_sequence', { ok: false, outcome: 'unknown' }, 4)]),
    { steps: [{ tool: 'close_window' }], recording: { text: 'secret-not-to-copy' } }));
  const rows = effects(tc);
  assert.deepEqual(rows.map(row => [row.name, row.step, row.effectStatus]), [[prefix + 'focus_window', 0, 'reported'], [prefix + 'input_sequence', 1, 'reported'], [prefix + 'input_sequence', 4, 'unknown']]);
  assert.ok(rows.every(row => row.parentTool === prefix + 'macro_run' && row.callId === 'call_owned'));
  assert.ok(!JSON.stringify(project(tc)).includes('secret-not-to-copy'));
});
test('Python invocation flags distinguish typed rejection from attempted/legacy error without claiming dispatch', () => {
  const rows = [{ step: 0, tool: 'mouse_click', ok: false, invocation_attempted: false, error: 'no args' },
    { step: 1, tool: 'mouse_click', ok: false, invocation_attempted: true, error: 'raised' }, { step: 2, tool: 'mouse_click', ok: false, error: 'legacy' }];
  const typed = effects(call('batch_actions', { ...batch(rows), step_invocation_schema: 1 }));
  assert.deepEqual(typed.map(row => [row.step, row.effectStatus, row.ok]), [[1, 'unknown', false], [2, 'unknown', false]]);
  assert.equal(effects(call('batch_actions', { ...batch(rows), step_invocation_schema: 99 })).length, 3);
  assert.deepEqual(project(call('macro_run', { step_invocation_schema: 1, invocation_attempted: false, success: false })).items, []);
});
test('local non-invocation and not_dispatched results do not invent effects; action_sent:false cannot hide unknown', () => {
  for (const tool of ['macro_run', 'input_sequence', 'mouse_click']) {
    assert.deepEqual(project(call(tool, { ok: false, error: 'denied' }), false).items, []);
    assert.deepEqual(effects(call(tool, { ok: false, action_sent: false, outcome: 'not_dispatched' })), []);
  }
  assert.equal(effects(call('input_sequence', { ok: false, action_sent: false, outcome: 'unknown' }))[0].effectStatus, 'unknown');
  assert.equal(effects(call('input_sequence', { ok: true, action_sent: true, outcome: 'not_dispatched' }))[0].effectStatus, 'unknown');
});
test('visual conditional actions follow returned boolean/object/null click contracts', () => {
  for (const tool of ['ocr_click', 'vision_click', 'ocr_find_text']) {
    for (const result of [{ ok: true, clicked: true }, { success: true, clicked: { matched_text: 'secret' } }]) assert.equal(effects(call(tool, result))[0].effectStatus, 'reported');
    for (const result of [{ ok: true, clicked: null }, { ok: true, clicked: false }, { ok: true, found: false }]) assert.deepEqual(effects(call(tool, result)), []);
    assert.equal(effects(call(tool, { ok: true, clicked: false, click_error: 'possible partial click' }))[0].effectStatus, 'unknown');
  }
  assert.deepEqual(effects(call('ocr_find_text', { ok: true, found: true })), []);
  assert.equal(effects(call('act_and_verify', { ok: false, action_result: { ok: true, action_sent: true } }))[0].effectStatus, 'reported');
});
test('wait/read-only macros stay empty even when a requested mutating suffix exists', () => {
  const tc = call('macro_run', batch([step('wait', { success: true }), step('observe', { ok: true }, 1)]), { steps: [{ tool: 'mouse_click' }] });
  assert.deepEqual(effects(tc), []);
  assert.deepEqual(effects(call('macro_run', batch([]))), []);
  assert.equal(project({ name: 'macro_run', result: batch([step('mouse_click', { ok: true })]) }), null);
  assert.equal(project(call('get_clipboard', { results: [step('mouse_click', { ok: true })] })), null);
});
test('missing, oversized or malformed results stay unknown with no fabricated children', () => {
  for (const result of [null, 'not json', ' '.repeat(2 * 1024 * 1024 + 1), [{ type: 'text', text: '{' }]]) {
    const rows = effects(call('macro_run', result));
    assert.equal(rows.length, 1); assert.equal(rows[0].effectStatus, 'unknown'); assert.equal(rows[0].kind, 'unknown');
  }
  const encoded = JSON.stringify(batch([step('mouse_click', { ok: true })]));
  for (const result of [encoded, [{ type: 'text', text: encoded }]]) assert.equal(effects(call('macro_run', result))[0].step, 0);
});
test('row bounds, malformed attribution and truncated returned prefixes expose incompleteness', () => {
  const rows = Array.from({ length: 200 }, (_, i) => step('mouse_click', { ok: true }, i));
  const ts = summary(1, [call('macro_run', batch(rows))], 'openai', []);
  assert.equal(ts.irreversible.length, 50); assert.equal(ts.irreversibleIncomplete, true);
  for (const result of [batch([null]), batch([step('mouse_click', { ok: true }), step('mouse_click', { ok: true })]),
    { ...batch([step('mouse_click', { ok: true })]), completed: 2 }]) {
    const p = project(call('macro_run', result)); assert.equal(p.incomplete, true);
    assert.ok(p.items.some(row => row.effectStatus === 'unknown'));
  }
});
test('unreturned cancelled macro cannot reconstruct a completed prefix from requested steps', () => {
  const rows = effects(call('macro_run', { ok: false, code: 'input_cancelled', outcome: 'unknown' }, { steps: [{ tool: 'input_sequence' }, { tool: 'wait' }] }));
  assert.equal(rows.length, 1); assert.equal(rows[0].name, prefix + 'macro_run'); assert.equal(rows[0].effectStatus, 'unknown');
  assert.equal(rows[0].step, undefined);
});
test('projection survives actual display shrinking and fold preserves uncertainty and attribution', async () => {
  const tc = call('macro_run', { ...batch([step('input_sequence', { ok: true, action_sent: true })]), padding: 'private-payload'.repeat(40000) });
  const projection = project(tc, true); assert.ok(JSON.stringify(projection).length < 1000);
  const shown = await bound(tc.name, tc.result, {});
  assert.ok(JSON.stringify(shown).length < JSON.stringify(tc.result).length);
  const ts = summary(1, [{ ...tc, result: shown, irreversibleProjection: projection }], 'openai', []);
  const uncertain = summary(2, [call('macro_run', null)], 'openai', []); uncertain.irreversibleIncomplete = true;
  const folded = fold(JSON.parse(JSON.stringify({ messages: [{ turnSummary: ts }, { turnSummary: uncertain }] })));
  assert.equal(folded.irreversible.items[0].effectStatus, 'reported'); assert.equal(folded.irreversible.items[0].step, 0);
  assert.equal(folded.irreversible.items[0].callId, 'call_owned'); assert.equal(folded.irreversible.items[0].turnSeq, 1);
  assert.equal(folded.irreversible.items[1].effectStatus, 'unknown'); assert.equal(folded.irreversible.items[1].ok, false);
  assert.equal(folded.irreversible.incomplete, true);
});
test('legacy native command failures retain their prior ledger shape', () => {
  assert.deepEqual(effects({ name: 'script_run', input: { code: 'throw 1' }, result: { ok: false } }), [{ kind: 'exec', name: 'script_run', detail: 'throw 1', ok: false }]);
});

test('missing action receipts, contradictory attempt flags and long call IDs stay truthful', () => {
  for (const tool of ['input_sequence', 'act_and_verify']) {
    for (const result of [{ ok: true }, { ok: true, action_sent: false }, { ok: false, action_result: { ok: true } }]) assert.equal(effects(call(tool, result))[0].effectStatus, 'unknown');
  }
  const result = { ...batch([{ ...step('input_sequence', { ok: true, action_sent: true }), invocation_attempted: false }]), step_invocation_schema: 1 };
  const p = project(call('macro_run', result)); assert.equal(p.incomplete, true); assert.equal(p.items[0].effectStatus, 'unknown');
  const a = effects({ ...call('input_sequence', { ok: true, action_sent: true }), id: 'x'.repeat(121) + 'a' })[0];
  const b = effects({ ...call('input_sequence', { ok: true, action_sent: true }), id: 'x'.repeat(121) + 'b' })[0];
  assert.equal(a.callId, undefined); assert.match(a.callIdHash, /^[a-f0-9]{64}$/); assert.notEqual(a.callIdHash, b.callIdHash);
  assert.equal(fold({ messages: [{ turnSummary: { irreversible: [a] } }] }).irreversible.items[0].callIdHash, a.callIdHash);
});

test('noncontiguous returned steps, enclosing unknown tails and global caps remain explicit', () => {
  const malformed = project(call('macro_run', batch([step('input_sequence', { ok: true, action_sent: true }, 7)])));
  assert.equal(malformed.incomplete, true); assert.ok(malformed.items.some(row => row.effectStatus === 'unknown'));
  const prefix = { ...batch([step('input_sequence', { ok: true, action_sent: true })]), outcome: 'unknown', action_sent: false };
  const rows = effects(call('macro_run', prefix));
  assert.deepEqual(rows.map(row => row.effectStatus), ['reported', 'unknown']); assert.equal(rows[0].step, 0); assert.equal(rows[1].step, undefined);
  const capped = summary(1, Array.from({ length: 51 }, () => ({ name: 'script_run', result: { ok: true } })), 'openai', []);
  assert.equal(capped.irreversible.length, 50); assert.equal(capped.irreversibleIncomplete, true);
});
