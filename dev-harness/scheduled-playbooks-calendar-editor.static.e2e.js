'use strict';
// Real calendar/form/PATCH source in capability-free VMs. No server import,
// browser/DOM, engine, store, provider, timers, native adapter or HTTP transport.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const { createRunner } = require('./lib/harness');
const { functionBlock, constBlock } = require('./lib/source-slice');
const t = createRunner('SCHEDULED PLAYBOOK CALENDAR EDITOR STATIC');
const repo = path.resolve(__dirname, '..');
const flag = process.argv.find(value => value.startsWith('--baseline-root='));
const root = flag ? path.resolve(flag.slice('--baseline-root='.length)) : repo;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const core = read('ruyi-workbench/app/src/06j-scheduler-core.js');
const scheduler = read('ruyi-workbench/app/src/13s-scheduler.js');
const ui = read('ruyi-workbench/app/public/js/steward-settings.js');
const route = functionBlock(scheduler, 'handleSchedulerApiRoutes');
const previewStart = route.indexOf('    const times = [];'), previewEnd = route.indexOf('    return send(', previewStart);
assert.ok(previewStart > 0 && previewEnd > previewStart);
const previewLoop = route.slice(previewStart, previewEnd);
assert.ok(previewLoop.includes('nextFireAt(normalized.task.schedule, cursor)'));
const calendar = vm.runInNewContext(core + '\n({nextFireAt, occurrenceKey, schedulerZoneParts, normalizeSchedulerTask});', {}, { timeout: 1000 });
const iso = value => value == null ? null : new Date(value).toISOString();
function next(plan, from) { return iso(calendar.nextFireAt(plan, Date.parse(from))); }
function preview(plan, from) {
  const now = Date.parse(from);
  const normalized = calendar.normalizeSchedulerTask({ title: 'calendar control', schedule: plan, payload: { kind: 'prompt', text: 'capture-only' } }, now);
  assert.equal(normalized.ok, true);
  const times = vm.runInNewContext(core + '\n(function(){' + previewLoop + '\nreturn times;})()', { normalized, now }, { timeout: 1000 });
  assert.equal(normalized.task.state.nextFireAt, times[0]);
  return Array.from(times);
}
async function form(originalMode, selectedMode, { editing = true, kind = 'prompt' } = {}) {
  const current = { id: 'sch_form', title: 'Old', revision: 2, createdAt: '2026-10-30T00:00:00Z', createdBy: 'user',
    schedule: { kind: 'daily', at: '09:00', tz: 'UTC' }, payload: { kind, text: 'Pinned task' }, target: { mode: 'new-session' },
    autonomy: { permissionMode: originalMode }, policy: { onMissed: 'run-once-late', graceMinutes: 720 }, state: { enabled: true } };
  const fields = { Kind: 'daily', PayloadKind: kind, At: '09:00', Title: 'Edited', Text: 'Pinned task', Timezone: 'UTC',
    Target: 'new-session', Permission: selectedMode, OnMissed: 'run-once-late', Grace: '720', Playbook: '0', Checks: 'Check this run' };
  const nodes = Object.fromEntries(Object.entries(fields).map(([key, value]) => ['cfgStewardSchedule' + key, { value }]));
  nodes.cfgStewardScheduleInputs = { querySelectorAll: () => [{ dataset: { inputKey: 'material' }, value: 'Original input' }] };
  nodes.cfgStewardSchedulePreview = { appendChild() {} };
  const requests = [];
  const context = vm.createContext({ byId: id => nodes[id], scheduleEditingEpoch: 0, scheduleEditingId: editing ? current.id : '', scheduleRows: [current],
    scheduleTemplates: [{ id: 'pb_form', revision: 'a'.repeat(64) }], schedulePreviewBody: '', current,
    api: async (route, options) => { requests.push({ route, method: options.method, body: JSON.parse(options.body) }); return { ok: true, times: [], timezone: 'UTC' }; },
    clear() {}, scheduleFormError() {}, t: key => key, toggleScheduleForm() {}, loadSchedule: async () => {},
  });
  const source = constBlock(ui, 'SCHEDULE_TASKS_PATH') + '\n'
    + ['scheduleFormPlan', 'scheduleFormBody', 'previewSchedule', 'submitScheduleOnce'].map(name => functionBlock(ui, name)).join('\n');
  const api = vm.runInContext(source + '\n({scheduleFormBody, previewSchedule, submitScheduleOnce});', context, { timeout: 1000 });
  const serialized = api.scheduleFormBody(); context.body = serialized;
  const merge = () => vm.runInContext('(function(){' + constBlock(route, 'merged') + '\nreturn merged;})()', context, { timeout: 1000 });
  const merged = merge();
  await api.previewSchedule(); await api.submitScheduleOnce();
  assert.equal(requests.length, 2); assert.equal(requests[0].route.endsWith('/preview'), true);
  assert.equal(requests[1].method, editing ? 'PATCH' : 'POST');
  assert.deepEqual(requests[0].body, requests[1].body, 'actual preview and submit serialize identical input');
  return { serialized, merged, context, merge };
}
(async () => {
  try {
    const ordinary = [
      ['UTC ordinary', { kind: 'daily', at: '09:00', tz: 'UTC' }, '2026-10-30T08:00:00Z', '2026-10-30T09:00:00.000Z'],
      ['full-hour spring gap', { kind: 'daily', at: '02:30', tz: 'America/New_York' }, '2026-03-08T06:00:00Z', '2026-03-08T07:30:00.000Z'],
      ['fold uses first', { kind: 'daily', at: '01:30', tz: 'America/New_York' }, '2026-11-01T04:00:00Z', '2026-11-01T05:30:00.000Z'],
      ['fold does not replay', { kind: 'daily', at: '01:30', tz: 'America/New_York' }, '2026-11-01T05:31:00Z', '2026-11-02T06:30:00.000Z'],
      ['half-hour gap policy retained', { kind: 'daily', at: '02:20', tz: 'Australia/Lord_Howe' }, '2026-10-03T15:00:00Z', '2026-10-03T15:50:00.000Z'],
      ['quarter-hour zone', { kind: 'daily', at: '09:00', tz: 'Asia/Kathmandu' }, '2026-10-30T00:00:00Z', '2026-10-30T03:15:00.000Z'],
      ['leap-month clamp', { kind: 'monthly', dayOfMonth: 31, at: '09:00', tz: 'Asia/Shanghai' }, '2028-01-31T02:00:00Z', '2028-02-29T01:00:00.000Z'],
      ['cron strict-after', { kind: 'cron', expr: '* * * * *', tz: 'UTC' }, '2026-10-30T08:00:00.001Z', '2026-10-30T08:01:00.000Z'],
    ];
    for (const [name, plan, from, expected] of ordinary) { assert.equal(next(plan, from), expected); t.ok(true, name + ': real Intl/calendar result retained'); }
    const plan = { kind: 'cron', expr: '0,20,40 2 * * *', tz: 'Australia/Lord_Howe' };
    const expected = ['2026-10-03T15:30:00.000Z', '2026-10-03T15:40:00.000Z', '2026-10-03T15:50:00.000Z', '2026-10-04T15:00:00.000Z', '2026-10-04T15:20:00.000Z'];
    const sequence = preview(plan, '2026-10-03T15:29:00Z'), middle = next(plan, '2026-10-03T15:35:00Z');
    const wall = calendar.schedulerZoneParts(Date.parse(expected[1]), plan.tz);
    assert.equal(wall.hour, 2); assert.equal(wall.minute, 40); assert.equal(wall.day, 4);
    if (baselineRoot()) {
      assert.deepEqual(sequence.slice(0, 3), ['2026-10-03T15:30:00.000Z', '2026-10-03T15:50:00.000Z', '2026-10-04T15:00:00.000Z']);
      assert.equal(middle, '2026-10-03T15:50:00.000Z');
      t.ok(true, 'expected RED old real preview sequence and mid-gap cursor both omit existing 02:40');
    } else {
      assert.deepEqual(sequence, expected); assert.equal(middle, expected[1]);
      t.ok(true, 'half-hour gap: actual preview loop, normalization and repeated nextFireAt include chronological 02:40');
      assert.equal(calendar.occurrenceKey('sch_lord_howe', Date.parse(sequence[1])), 'sch_lord_howe@2026-10-03T15:40:00.000Z');
      t.ok(true, 'restored occurrence retains revision-independent stable identity');
      assert.deepEqual(preview({ kind: 'cron', expr: '0,30 2,3 * * *', tz: 'America/New_York' }, '2026-03-08T06:59:00Z'),
        ['2026-03-08T07:00:00.000Z', '2026-03-08T07:30:00.000Z', '2026-03-09T06:00:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-09T07:00:00.000Z']);
      t.ok(true, 'gap-forward collisions coalesce by strict epoch; cross-day advancement never repeats a key');
    }
    for (const original of ['plan', 'auto']) for (const kind of ['prompt', 'playbook']) {
      const result = await form(original, '', { kind });
      if (baselineRoot()) { assert.equal(Object.hasOwn(result.serialized, 'autonomy'), false); assert.equal(result.merged.autonomy.permissionMode, original); }
      else { assert.equal(result.serialized.autonomy.permissionMode, ''); assert.equal(result.merged.autonomy.permissionMode, ''); }
      t.ok(true, (baselineRoot() ? 'expected RED old serializer retains ' : 'explicit clear removes ') + original + ' for edited ' + kind + '; actual preview/save/PATCH evaluated');
    }
    const explicit = await form('plan', 'acceptEdits'); assert.equal(explicit.merged.autonomy.permissionMode, 'acceptEdits');
    t.ok(true, 'explicit selected mode is preserved');
    const created = await form('plan', '', { editing: false }); assert.equal(Object.hasOwn(created.serialized, 'autonomy'), false);
    t.ok(true, 'creation with follow-global keeps omitted/default request semantics');
    const reminder = await form('plan', '', { kind: 'reminder' }); assert.equal(Object.hasOwn(reminder.serialized, 'autonomy'), false);
    t.ok(true, 'reminder serializer does not introduce executable autonomy');
    const partial = await form('plan', ''); partial.context.body = { title: 'Rename only' }; assert.equal(partial.merge().autonomy.permissionMode, 'plan');
    t.ok(true, 'ordinary partial PATCH omission still preserves the saved permission');
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { t.done({ exit: true }); }
})();
function baselineRoot() { return Boolean(flag); }
