'use strict';
// 62 号第三轮 E04：候选按 sessionId 保留身份，重名的两条要能分辨（标签带时间／尾段，选中的仍是原话标题）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const moduleHref = pathToFileURL(path.resolve(__dirname, '../../ruyi-workbench/app/public/js/steward-composer.js')).href;

test('same title from two sessions stays two selectable rows', async () => {
  const { stewardCandidateRows } = await import(moduleHref);
  const rows = stewardCandidateRows([
    { sessionId: 'sess-a', displayTitle: '周报-W36', updatedAt: '2026-10-16T09:30:00.000Z' },
    { sessionId: 'sess-b', displayTitle: '周报-W36', updatedAt: '2026-10-15T21:00:00.000Z' },
  ], [], 8);
  assert.deepEqual(rows.map(row => row.sessionId), ['sess-a', 'sess-b']);
  assert.equal(rows[0].title, '周报-W36');
  assert.notEqual(rows[0].label, rows[1].label, 'duplicate titles must be distinguishable');
  for (const row of rows) {
    assert.ok(row.label.startsWith('周报-W36 · '), 'label keeps the original title first');
    assert.ok(!row.label.includes('Invalid Date'));
  }
  assert.ok(rows[0].updatedAt && rows[1].updatedAt);
});

test('one session seen twice collapses; the prediction hit wins over the memory pool', async () => {
  const { stewardCandidateRows } = await import(moduleHref);
  const rows = stewardCandidateRows([{ sessionId: 'sess-a', displayTitle: '甲', updatedAt: '2026-10-16T09:30:00.000Z' }],
    [{ sessionId: 'sess-a', title: '甲(旧回忆)', updatedAt: '' }, { sessionId: 'sess-b', title: '乙' }], 8);
  assert.deepEqual(rows.map(row => row.sessionId), ['sess-a', 'sess-b']);
  assert.equal(rows[0].title, '甲');
  assert.equal(rows[1].label, '乙', 'unique titles keep the plain label');
});

test('a label collision without a timestamp still disambiguates by session tail', async () => {
  const { stewardCandidateRows } = await import(moduleHref);
  const rows = stewardCandidateRows([
    { sessionId: 'sess-aaa111', title: '月度复盘' },
    { sessionId: 'sess-bbb222', title: '月度复盘' },
  ], [], 8);
  assert.equal(rows[0].label, '月度复盘 · aaa111');
  assert.equal(rows[1].label, '月度复盘 · bbb222');
});

test('identical tails or malformed timestamps still yield distinct, literal labels', async () => {
  const { stewardCandidateRows } = await import(moduleHref);
  const rows = stewardCandidateRows([
    { sessionId: 'aaaaaa-111111', title: '同名' },
    { sessionId: 'bbbbbb-111111', title: '同名' },
    { sessionId: 'sess-badtime', title: '同名', updatedAt: 'not-a-date' },
  ], [], 8);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map(row => row.label)).size, 3, 'every row keeps a unique label');
  assert.ok(rows.every(row => !row.label.includes('Invalid Date')));
  assert.ok(rows[0].label !== rows[1].label, 'identical tails fall back to the full session id');
});

test('rows are bounded, ids are required and a missing title falls back to the session id', async () => {
  const { stewardCandidateRows, STEWARD_PICKER_MAX } = await import(moduleHref);
  assert.equal(STEWARD_PICKER_MAX, 8);
  const many = Array.from({ length: 12 }, (_, index) => ({ sessionId: 'sess-' + index, title: '任务 ' + index }));
  assert.equal(stewardCandidateRows(many, [], 8).length, 8);
  const rows = stewardCandidateRows([{ sessionId: 'sess-x', title: '   ' }, { title: '没有 id' }], [], 8);
  assert.deepEqual(rows.map(row => row.sessionId), ['sess-x']);
  assert.equal(rows[0].title, 'sess-x');
});

test('two same-title rows created in the same minute still get distinct labels', async () => {
  const { stewardCandidateRows } = await import(moduleHref);
  const rows = stewardCandidateRows([
    { sessionId: 'sess-aaa111', displayTitle: '周报-W36', updatedAt: '2026-10-16T09:30:10.000Z' },
    { sessionId: 'sess-bbb222', displayTitle: '周报-W36', updatedAt: '2026-10-16T09:30:40.000Z' },
  ], [], 8);
  assert.notEqual(rows[0].label, rows[1].label, 'same minute must not collapse the labels');
  assert.ok(rows[0].label.endsWith(' · aaa111') && rows[1].label.endsWith(' · bbb222'));
});

test('the picker label never becomes the selected title', async () => {
  const { stewardCandidateRows } = await import(moduleHref);
  const [first, second] = stewardCandidateRows([
    { sessionId: 'sess-a', displayTitle: '同一句', updatedAt: '2026-10-16T09:30:00.000Z' },
    { sessionId: 'sess-b', displayTitle: '同一句', updatedAt: '2026-10-16T10:30:00.000Z' },
  ], [], 8);
  assert.equal(first.title, '同一句');
  assert.equal(second.title, '同一句');
  assert.ok(first.label !== first.title && second.label !== second.title);
});
