'use strict';
// 151 阶段 3H（150 §9.2 拍板）：3.1.0 的工作数据加密是实验性功能，「启用加密」入口默认隐藏。
// 这份单测钉住三层：
//   A. 面板（真 work-data-settings.js，DOM 夹具）：开关关着/缺省时不出现、不选中、提交不了启用；开关打开后出现；
//      已加密时转明文/导出/恢复与开关无关；未完成的作业与恢复提示照常可见；体检预计不再提启用。
//   B. 后端准入（真 13ah WorkDataSetup + 真 13ag WorkDataMaintenance，vm 装入）：开关关着时启用作业以稳定码
//      work_data_setup.experimental_disabled（409）被拒，目录探测、维护闸、worker 一样都没碰；导出/转明文/恢复照常进入准入。
//   C. 生产组装（真 server.js 的 normalizeConfig 与 13ah 原文读）：默认关、只认 JSON 布尔 true。
// 真 serve 上的端到端见 dev-harness/work-data-encryption-experimental.e2e.js，浏览器上的入口见 work-data-settings.browser.e2e.js。
const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { fixture, authority, job, status } = require('../lib/work-data-settings-fixture');
const { constBlock } = require('../lib/source-slice');
const repo = path.resolve(__dirname, '../..'), app = path.join(repo, 'ruyi-workbench', 'app');
const en = JSON.parse(fs.readFileSync(path.join(app, 'public/locales/en-US.json'), 'utf8'));
const zh = JSON.parse(fs.readFileSync(path.join(app, 'public/locales/zh-CN.json'), 'utf8'));

const PICK = 'E:\\Synthetic Backup', SECRET = 'a long private password';
const options = f => f.find('workDataOperation').children.map(option => ({ value: option.value, hidden: option.hidden, disabled: option.disabled }));
const offered = f => options(f).filter(row => !row.hidden && !row.disabled).map(row => row.value);
const byClass = (f, name) => f.host.children.find(child => String(child.className).split(' ').includes(name));
const populate = async f => { f.click('workDataPickBackup'); await f.flush(); f.change('workDataPassword', SECRET); f.change('workDataPasswordConfirm', SECRET); };
const posts = f => f.calls.filter(row => row.route === '/api/work-data/jobs');
const reply = statusValue => route => route === '/api/pick-folder' ? { ok: true, path: PICK }
  : route === '/api/work-data/jobs' ? { ok: true, job: job({ operation: 'export', state: 'queued' }) } : statusValue();

/* ═══════════ A. 面板 ═══════════ */
for (const [label, extra] of [['switch off', { experimentalEncryption: false }], ['field absent (older status)', { experimentalEncryption: undefined }], ['a non-boolean "true"', { experimentalEncryption: 'true' }]]) {
  test(`A1 ${label}: a plain root neither offers nor selects «enable», reads as backup and restore, and only export reaches the server`, async () => {
    const value = status(extra); if (extra.experimentalEncryption === undefined) delete value.experimentalEncryption;
    const f = fixture(reply(() => value));
    // 后台状态还没到：启用也不出现（不先闪一下「启用加密」）。
    assert.equal(options(f).find(row => row.value === 'enable').hidden, true, 'no enable option before status arrives');
    assert.notEqual(f.find('workDataSubmit').textContent, en['workData.operation.enable']);
    await f.panel.refresh();
    assert.deepEqual(offered(f), ['export', 'restore']);
    assert.equal(f.find('workDataOperation').value, 'export');
    assert.equal(f.find('workDataHeading').textContent, en['workData.titleBackup']);
    assert.equal(byClass(f, 'work-data-scope').hidden, true, 'the encryption scope note is not shown');
    assert.equal(byClass(f, 'work-data-retained').hidden, true, 'the first-enable retained plaintext note is not shown');
    assert.equal(f.find('workDataExperimental').hidden, true);
    // 篡改选择（脚本把 select 改成 enable）：下一次绘制就退回导出并清掉口令，确认段打不开，也发不出启用。
    await populate(f); f.change('workDataOperation', 'enable', 'change');
    assert.equal(f.find('workDataOperation').value, 'export'); assert.equal(f.find('workDataPassword').value, '');
    f.click('workDataSubmit'); assert.equal(f.find('workDataConfirm').hidden, true); assert.equal(posts(f).length, 0);
    // 导出照常：填好就能提交，发出去的是 export。
    await populate(f); assert.equal(f.find('workDataSubmit').disabled, false);
    f.click('workDataSubmit'); await f.flush();
    assert.deepEqual(posts(f).map(row => row.body.operation), ['export']);
    f.panel.dispose();
  });
}

test('A2 switch on: «enable» appears, is the first-status default as before, and the experimental limits are stated', async () => {
  const f = fixture(reply(() => status({ experimentalEncryption: true })));
  await f.panel.refresh();
  assert.deepEqual(offered(f), ['enable', 'export', 'restore']);
  assert.equal(f.find('workDataOperation').value, 'enable');
  assert.equal(f.find('workDataHeading').textContent, en['workData.title']);
  assert.equal(byClass(f, 'work-data-scope').hidden, false); assert.equal(byClass(f, 'work-data-retained').hidden, false);
  const note = f.find('workDataExperimental');
  assert.equal(note.hidden, false); assert.equal(note.textContent, en['workData.experimentalNotice']); assert.match(note.textContent, /120 MiB/);
  await populate(f); f.click('workDataSubmit');
  assert.equal(f.find('workDataConfirm').hidden, false, 'enable still goes through the second confirmation');
  f.click('workDataConfirmBack'); f.language('zh-CN'); assert.equal(f.find('workDataExperimental').textContent, zh['workData.experimentalNotice']);
  f.panel.dispose();
});

test('A3 turning the switch on later offers «enable» without replacing the user’s current choice; turning it off withdraws a drafted enable', async () => {
  let on = false; const f = fixture(reply(() => status({ experimentalEncryption: on })));
  await f.panel.refresh(); assert.equal(f.find('workDataOperation').value, 'export');
  on = true; await f.panel.refresh();
  assert.deepEqual(offered(f), ['enable', 'export', 'restore']); assert.equal(f.find('workDataOperation').value, 'export', 'no silent switch to a mutating operation');
  f.change('workDataOperation', 'enable', 'change'); await populate(f);
  assert.equal(f.find('workDataSubmit').disabled, false);
  on = false; await f.panel.refresh();
  assert.equal(f.find('workDataOperation').value, 'export'); assert.equal(f.find('workDataPassword').value, ''); assert.equal(f.find('workDataPasswordConfirm').value, '');
  assert.equal(posts(f).length, 0);
  f.panel.dispose();
});

test('A4 an encrypted root is never hidden: switch to plaintext, export and restore stay offered and submit with the switch off', async () => {
  const a = authority('encrypted');
  const f = fixture((route, _options, body) => route === '/api/pick-folder' ? { ok: true, path: PICK }
    : route === '/api/work-data/jobs' ? { ok: true, job: job({ operation: body.operation, state: 'queued' }) } : status({ authority: a, experimentalEncryption: false }));
  await f.panel.refresh();
  assert.deepEqual(offered(f), ['disable', 'export', 'restore']);
  assert.equal(f.find('workDataHeading').textContent, en['workData.title']);
  assert.equal(f.find('workDataExperimental').hidden, false); assert.equal(f.find('workDataExperimental').textContent, en['workData.experimentalEncrypted']);
  f.change('workDataOperation', 'disable', 'change'); await populate(f); f.change('workDataConfirmPlaintext', true);
  assert.equal(f.find('workDataSubmit').disabled, false); f.click('workDataSubmit'); await f.flush();
  assert.equal(posts(f)[0].body.operation, 'disable'); assert.deepEqual(posts(f)[0].body.expectedAuthority, a);
  f.panel.dispose();
  const g = fixture((route, _options, body) => route === '/api/pick-folder' ? { ok: true, path: PICK }
    : route === '/api/work-data/jobs' ? { ok: true, job: job({ operation: body.operation, state: 'queued' }) } : status({ authority: a, experimentalEncryption: false }));
  await g.panel.refresh(); g.change('workDataOperation', 'export', 'change'); await populate(g); g.click('workDataSubmit'); await g.flush();
  assert.equal(posts(g)[0].body.operation, 'export');
  g.panel.dispose();
});

test('A5 unfinished work stays visible with the switch off: a draining enable job keeps its progress and cancel; an uncertain one keeps the restart notice', async () => {
  const f = fixture(route => route === '/api/work-data/jobs/' + 'a'.repeat(48) ? { ok: true, job: job() } : status({ experimentalEncryption: false, job: job() }));
  await f.panel.refresh();
  assert.equal(f.find('workDataProgress').hidden, false); assert.match(f.find('workDataProgress').textContent, new RegExp(en['workData.job.draining']));
  assert.equal(f.find('workDataCancel').hidden, false); assert.equal(f.find('workDataCancel').disabled, false);
  // 挂着的是启用作业：面板仍按加密流程说话（标题与实验性说明），不因开关已关就改口成「备份与恢复」。
  assert.equal(f.find('workDataHeading').textContent, en['workData.title']);
  assert.equal(f.find('workDataExperimental').hidden, false); assert.equal(f.find('workDataExperimental').textContent, en['workData.experimentalNotice']);
  assert.equal(offered(f).includes('enable'), false, 'a new enable is still not offered');
  f.panel.dispose();
  const uncertain = job({ state: 'uncertain', takeover: true, cancellable: false, error: 'work_data_setup.worker_failed_after_handoff' });
  const g = fixture(route => route === '/api/work-data/jobs/' + 'a'.repeat(48) ? { ok: true, job: uncertain } : status({ experimentalEncryption: false, job: uncertain }));
  await g.panel.refresh();
  assert.match(g.find('workDataProgress').textContent, new RegExp(en['workData.restartRequired'].slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  g.panel.dispose();
});

test('A8 (v2) an unknown mode is not treated as a plain root: a failed first status read keeps the neutral title and notes, and still offers no enable', async () => {
  const f = fixture(() => { throw { code: 'work_data_setup.status_unavailable' }; });
  await f.panel.refresh(); await f.flush();
  assert.equal(f.find('workDataSummary').dataset.mode, 'unknown');
  assert.equal(f.find('workDataHeading').textContent, en['workData.title'], 'no «backup and restore» relabel while the mode is unknown');
  assert.equal(byClass(f, 'work-data-scope').hidden, false); assert.equal(byClass(f, 'work-data-retained').hidden, false);
  assert.equal(options(f).find(row => row.value === 'enable').hidden, true, 'enable is still not offered');
  assert.equal(posts(f).length, 0);
  f.panel.dispose();
  // The same panel relabels only once the backend confirms a plain root.
  let fail = true; const g = fixture(route => { if (fail) throw { code: 'work_data_setup.status_unavailable' }; return reply(() => status({ experimentalEncryption: false }))(route); });
  await g.panel.refresh(); assert.equal(g.find('workDataHeading').textContent, en['workData.title']);
  fail = false; await g.panel.refresh(); assert.equal(g.find('workDataHeading').textContent, en['workData.titleBackup']);
  g.panel.dispose();
});

test('A9 (v2) the limit copy is honest: about 50 MB advice, a 1.4× encrypted copy and a 2.4× whole root that counts toward 120 MiB, and no unconditional availability claim', () => {
  for (const table of [en, zh]) {
    for (const key of ['workData.experimentalNotice', 'settings.catalog.workDataEncryptionExperimentalV1.hint']) {
      // v3：1.4 倍是加密副本本身；加上保留的旧明文，整个根约 2.4 倍（50 MB × 2.4 ≈ 120 MiB，正是 50 MB 建议的来历）。
      assert.match(table[key], /50 MB/, key); assert.match(table[key], /1\.4/, key); assert.match(table[key], /2\.4/, key); assert.match(table[key], /120 MiB/, key);
      assert.doesNotMatch(table[key], /增至 1\.4|grows to about 1\.4/, key + ' does not call 1.4× the whole root');
    }
    assert.match(table['workData.experimentalEncrypted'], /120 MiB/);
    for (const key of ['workData.experimentalNotice', 'workData.experimentalEncrypted', 'settings.catalog.workDataEncryptionExperimentalV1.hint']) {
      assert.doesNotMatch(table[key], /始终可用|always available|stay available/i, key);
    }
  }
});

// 纯函数：从同一份源码剥掉 import/export 装入（与 lib/work-data-settings-fixture 同一做法）。
// 装不出来（缺函数）时每条用到它的断言各自红，而不是整份文件在加载时崩掉。
const pure = (() => { try {
  return vm.runInNewContext(fs.readFileSync(path.join(app, 'public/js/work-data-settings.js'), 'utf8').replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '')
    + '\n({ workDataEnableOffered, workDataHygienePrediction });', { t: key => key, getLocale: () => 'en-US', apiErrorCopyKey: () => '', fmtBytes: String, WeakMap, Set });
} catch (error) { const missing = () => { throw error; }; return { workDataEnableOffered: missing, workDataHygienePrediction: missing }; } })();

test('A6 workDataEnableOffered needs a confirmed plain root and a strict true switch', () => {
  const plain = authority('plain'), encrypted = authority('encrypted');
  assert.equal(pure.workDataEnableOffered(null), false);
  assert.equal(pure.workDataEnableOffered({ experimentalEncryption: true }), false, 'unknown mode');
  assert.equal(pure.workDataEnableOffered({ authority: encrypted, experimentalEncryption: true }), false);
  for (const value of [false, undefined, 'true', 1, null]) assert.equal(pure.workDataEnableOffered({ authority: plain, experimentalEncryption: value }), false, JSON.stringify(value));
  assert.equal(pure.workDataEnableOffered({ authority: plain, experimentalEncryption: true }), true);
});

test('A7 the hygiene prediction stops mentioning «enable» when it is not offered; older two-argument callers keep the old wording', () => {
  const inspection = ok => ({ schema: 1, ok });
  assert.equal(pure.workDataHygienePrediction(inspection(true), 'plain', false), 'workData.hygiene.predictOkPlainExport');
  assert.equal(pure.workDataHygienePrediction(inspection(false), 'plain', false), 'workData.hygiene.predictBlockedPlainExport');
  assert.equal(pure.workDataHygienePrediction(inspection(true), 'plain', true), 'workData.hygiene.predictOkPlain');
  assert.equal(pure.workDataHygienePrediction(inspection(true), 'plain'), 'workData.hygiene.predictOkPlain');
  assert.equal(pure.workDataHygienePrediction(inspection(true), 'encrypted', false), 'workData.hygiene.predictOkEncrypted');
  for (const key of ['workData.hygiene.predictOkPlainExport', 'workData.hygiene.predictBlockedPlainExport']) {
    for (const table of [en, zh]) { assert.ok(table[key], key); assert.doesNotMatch(table[key], /启用|encryption|turn(?:ing)? on/i, key); }
  }
});

/* ═══════════ B. 后端准入 ═══════════ */
const src = name => fs.readFileSync(path.join(app, 'src', name), 'utf8');
const context = { require, Buffer, AbortController, Promise, Set, Map, WeakMap, Object, Error, TypeError };
const Setup = vm.runInNewContext(constBlock(src('13ah-work-data-setup.js'), 'WorkDataSetup') + '\nWorkDataSetup', context);
const Maintenance = vm.runInNewContext(constBlock(src('13ag-work-data-maintenance.js'), 'WorkDataMaintenance') + '\nWorkDataMaintenance', context);
const tick = () => new Promise(setImmediate);
function backend({ experimentalEncryption, mode = 'plain' } = {}) {
  const events = [], queue = [], a = authority(mode); let counter = 0;
  const m = Maintenance.create({ owns: () => false, snapshot: () => ({ busy: {}, pending: [], dirty: 0 }), pause: () => { events.push('pause'); return {}; }, resume: () => events.push('resume'),
    progress: async () => {}, flush: async () => {}, yield: tick });
  const worker = { start: async () => { events.push('start'); return { ready: new Promise(() => {}), cancel: async () => {}, handoff: async () => {} }; } };
  const inspected = { authority: { ...a }, base: 'C:/synthetic/base', configMirror: mode === 'encrypted' };
  if (experimentalEncryption !== undefined) inspected.experimentalEncryption = experimentalEncryption;
  const api = Setup.create({ maintenance: m, inspect: async () => { events.push('inspect'); return JSON.parse(JSON.stringify(inspected)); },
    validateDirectories: async () => { events.push('validate-paths'); }, worker: () => worker, id: () => String(++counter).padStart(48, 'a'), now: () => '',
    defer: work => queue.push(work), respond: () => {}, receiptPath: () => false, receiptOwner: () => null });
  const body = patch => ({ operation: 'enable', password: 'synthetic experimental password', expectedAuthority: { ...a }, backupDirectory: 'C:/synthetic/backups', ...patch });
  return { api, m, events, queue, body };
}

for (const [label, value] of [['off', false], ['absent from inspect', undefined], ['a non-boolean', 'true']]) {
  test(`B1 switch ${label}: a new enable job is refused with a typed 409 before directories, maintenance or the worker are touched`, async () => {
    const b = backend({ experimentalEncryption: value });
    await assert.rejects(b.api.submit(b.body()), error => error.code === 'work_data_setup.experimental_disabled' && error.apiCode === error.code && error.statusCode === 409 && error.retry === false);
    assert.deepEqual(b.events.filter(row => row !== 'inspect'), [], 'no directory probe, pause or child launch');
    assert.equal(b.queue.length, 0, 'no job was scheduled'); assert.equal(b.m.accepting(), true, 'intake is still open');
    const view = await b.api.status();
    assert.equal(view.job, null); assert.equal(view.experimentalEncryption, false);
    // The refusal leaves the setup free: the next permitted operation is admitted.
    const next = await b.api.submit(b.body({ operation: 'export' })); assert.equal(next.operation, 'export'); assert.equal(next.state, 'queued');
  });
}

test('B2 switch off: export and restore still reach their own admission checks, and an encrypted root can still be switched to plaintext', async () => {
  const plain = backend({ experimentalEncryption: false });
  const exported = await plain.api.submit(plain.body({ operation: 'export' }));
  assert.equal(exported.operation, 'export'); assert.ok(plain.events.includes('validate-paths'));
  const restore = backend({ experimentalEncryption: false });
  // This host has no restore-upload broker: refusing on the upload capability proves the request passed the experimental gate.
  await assert.rejects(restore.api.submit(restore.body({ operation: 'restore', targetDirectory: 'C:/synthetic/target', uploadId: 'b'.repeat(48) })),
    error => error.code === 'work_data_setup.upload_unavailable');
  const encrypted = backend({ experimentalEncryption: false, mode: 'encrypted' });
  const disabled = await encrypted.api.submit(encrypted.body({ operation: 'disable', confirmPlaintext: true }));
  assert.equal(disabled.operation, 'disable'); assert.equal(disabled.state, 'queued');
  const conflict = backend({ experimentalEncryption: false, mode: 'encrypted' });
  await assert.rejects(conflict.api.submit(conflict.body()), error => error.code === 'work_data_setup.mode_conflict', 'enable on an encrypted root keeps its own code');
});

test('B3 switch on: enable is admitted and status reports the switch', async () => {
  const b = backend({ experimentalEncryption: true });
  const admitted = await b.api.submit(b.body());
  assert.equal(admitted.operation, 'enable'); assert.equal(admitted.state, 'queued'); assert.ok(b.events.includes('validate-paths'));
  assert.equal((await b.api.status()).experimentalEncryption, true);
});

test('B4 the refusal code has user-facing copy in all four flat catalogs', () => {
  const key = 'error.code.workDataSetupExperimentalDisabled';
  for (const file of ['ruyi-workbench/app/public/locales/zh-CN.json', 'ruyi-workbench/app/public/locales/en-US.json', 'docs/i18n/locales/zh-CN.json', 'docs/i18n/locales/en-US.json']) {
    const table = JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8'));
    assert.ok(typeof table[key] === 'string' && table[key].length > 20, file);
  }
  const { apiErrorCopyKey } = vm.runInNewContext(fs.readFileSync(path.join(app, 'public/js/api-error-i18n.js'), 'utf8').replace(/^export /gm, '') + '\n({ apiErrorCopyKey });', {});
  assert.equal(apiErrorCopyKey('work_data_setup.experimental_disabled'), key);
});

/* ═══════════ C. 生产组装 ═══════════ */
test('C1 the config default is off, only a JSON true turns it on, and the production inspect reads it strictly from the raw config', () => {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ruyi-wd-experimental-'));
  process.env.WIN_CLAUDE_WORKBENCH_HOME = root; process.env.RUYI_HOME = root;
  try {
    const { normalizeConfig } = require(path.join(app, 'server.js'));
    assert.equal(normalizeConfig({}).config.workDataEncryptionExperimentalV1, false);
    assert.equal(normalizeConfig({ workDataEncryptionExperimentalV1: true }).config.workDataEncryptionExperimentalV1, true);
    for (const value of ['true', 1, null, {}]) assert.equal(normalizeConfig({ workDataEncryptionExperimentalV1: value }).config.workDataEncryptionExperimentalV1, false, JSON.stringify(value));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
  // 结构性判据（读源码）：生产 inspect 与 authority 出自同一次原文读，且只认 === true；status 原样回报。
  const inspect = src('13ah-work-data-setup.js');
  assert.match(inspect, /const experimentalEncryption=raw\.workDataEncryptionExperimentalV1===true;/);
  assert.match(inspect, /configMirror,experimentalEncryption\};/);
  assert.match(inspect, /experimentalEncryption:observed\.experimentalEncryption===true/);
});
