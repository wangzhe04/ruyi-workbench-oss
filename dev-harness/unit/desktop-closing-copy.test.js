'use strict';
// 151 阶段 1E:桌面关闭(或关闭未完成)期间的拒收有自己的稳定码 desktop_lifetime.closing 与中英文案。
// 修前 13ag run()/admitHelper 与 13ax admit 一律报 work_data.maintenance_busy,用户在关窗那几秒发的话看到「正在进行工作数据维护」。
// 内部语义不变:code/message 仍是 maintenance_busy(04f、13ah、桌面诊断理由表按它分支),只有对外的 apiCode 换成「正在关闭」。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { constBlock, sliceBlock } = require('../lib/source-slice');

const SRC = path.resolve(__dirname, '../../ruyi-workbench/app/src');
const PUBLIC = path.resolve(__dirname, '../../ruyi-workbench/app/public');
const read = name => fs.readFileSync(path.join(SRC, name), 'utf8');
const catalog = lang => JSON.parse(fs.readFileSync(path.join(PUBLIC, 'locales', lang + '.json'), 'utf8'));

test('13ag run() refuses with the closing api code only while the desktop is closing', async () => {
  const api = vm.runInNewContext(constBlock(read('13ag-work-data-maintenance.js'), 'WorkDataMaintenance') + '\nWorkDataMaintenance', { require, Promise, Set, Object, Error, TypeError });
  let closing = true, admit = false;
  const host = { owns: () => false, snapshot: () => ({ busy: {}, pending: [], dirty: 0 }), pause: () => ({}), resume() {}, progress: async () => {}, flush: async () => {}, yield: () => new Promise(setImmediate),
    extraAdmission: () => admit, closing: () => closing };
  const m = api.create(host);
  await assert.rejects(m.run('turn', () => assert.fail('must not run')), error => error.code === 'work_data.maintenance_busy' && error.message === 'work_data.maintenance_busy' && error.apiCode === 'desktop_lifetime.closing' && error.statusCode === 409);
  closing = false;
  await assert.rejects(m.run('turn', () => assert.fail('must not run')), error => error.code === 'work_data.maintenance_busy' && error.apiCode === undefined, 'ordinary maintenance keeps the maintenance copy');
  admit = true;
  const lease = m.begin(); closing = true;
  await assert.rejects(m.run('turn', () => assert.fail('must not run')), error => error.apiCode === 'desktop_lifetime.closing', 'the desktop close lease (phase waiting) also says closing');
  lease.resume(); closing = false;
  assert.equal(await m.run('turn', async () => 7), 7);
});

test('13ag admitHelper and 13ax admit report the closing api code; other refusals keep maintenance_busy', () => {
  const maintenance = read('13ag-work-data-maintenance.js');
  const block = sliceBlock(maintenance, '// Completion obligations belong', 'WorkDataMaintenanceHooks.deferStewardWake');
  const make = desktop => {
    const hooks = {};
    vm.runInNewContext(block, { WorkDataMaintenanceHooks: hooks, workDataMaintenance: { status: () => ({ phase: 'idle' }) }, ...(desktop ? { DesktopLifetimeHooks: desktop } : {}),
      PrivacyLocalDriveProbe: { stopSync() {} }, ToolboxHooks: { stopAll: async () => {} }, stopKimiModelProbes() {}, stopKimiServer: async () => {}, killAllMcpClients() {}, killAllShellSessions() {} });
    return hooks;
  };
  assert.throws(() => make({ canAdmit: () => false, closing: () => true, closingCopy: () => true }).admitHelper(), error => error.code === 'work_data.maintenance_busy' && error.apiCode === 'desktop_lifetime.closing');
  assert.throws(() => make({ canAdmit: () => false, closing: () => false, closingCopy: () => false }).admitHelper(), error => error.code === 'work_data.maintenance_busy' && error.apiCode === undefined);
  assert.throws(() => make({ canAdmit: () => false, closing: () => true, closingCopy: () => false }).admitHelper(), error => error.apiCode === undefined, 'closing deferred to a maintenance handoff still says maintenance');
  assert.throws(() => make({ canAdmit: () => false, closing: () => true, closingCopy: () => { throw Error('broken'); } }).admitHelper(), error => error.apiCode === undefined, 'an unreadable closing fact never invents the closing copy');
  const paused = make(null); paused.prepareInfrastructure();
  assert.throws(() => paused.admitHelper(), error => error.code === 'work_data.maintenance_busy' && error.apiCode === undefined, 'a maintenance pause is still maintenance');

  const hooks = {};
  vm.runInNewContext(read('13ax-desktop-lifetime.js') + '\ndesktopLifetimeStopping = true;', { Buffer, DesktopLifetimeHooks: hooks, require, process });
  assert.throws(() => hooks.admit(), error => error.code === 'work_data.maintenance_busy' && error.message === 'work_data.maintenance_busy' && error.apiCode === 'desktop_lifetime.closing');
  assert.equal(hooks.closing(), true); assert.equal(hooks.closingCopy(), true);
});

// 1E 复审建议 3:关窗时已有提交了的维护任务(13ah closeForDesktop 返回 false),关闭让位给维护交接,stopping 不复位、照样拒收,
// 但正在跑的是维护交接 —— 对用户应说维护,不说「正在关闭」。准入事实 closing() 不变。
test('a desktop close deferred to a committed maintenance handoff keeps refusing but says maintenance', async () => {
  const hooks = {}, context = { Buffer, DesktopLifetimeHooks: hooks, require, process, WorkDataSetupHooks: { closeForDesktop: async () => false } };
  vm.runInNewContext(read('13ax-desktop-lifetime.js'), context);
  assert.equal(await context.desktopLifetimeStop(), false, 'the close is deferred');
  assert.equal(hooks.closing(), true, 'admission still refuses');
  assert.equal(hooks.closingCopy(), false);
  assert.throws(() => hooks.admit(), error => error.code === 'work_data.maintenance_busy' && error.apiCode === 'work_data.maintenance_busy');
  const block = sliceBlock(read('13ag-work-data-maintenance.js'), '// Completion obligations belong', 'WorkDataMaintenanceHooks.deferStewardWake');
  const ag = {};
  vm.runInNewContext(block, { WorkDataMaintenanceHooks: ag, workDataMaintenance: { status: () => ({ phase: 'idle' }) }, DesktopLifetimeHooks: hooks,
    PrivacyLocalDriveProbe: { stopSync() {} }, ToolboxHooks: { stopAll: async () => {} }, stopKimiModelProbes() {}, stopKimiServer: async () => {}, killAllMcpClients() {}, killAllShellSessions() {} });
  assert.throws(() => ag.admitHelper(), error => error.code === 'work_data.maintenance_busy' && error.apiCode === undefined, '13ag reads the same copy fact');
});

// 1E 复审建议 2:sendError 对关闭拒收给出 code=desktop_lifetime.closing、message=work_data.maintenance_busy;
// 闸门只在「没有码 / 兜底码」时才看 message,具体码不被 message 拉去查维护状态。
test('the real gate noteFailure does not poll maintenance status for the closing code', async () => {
  const { createMaintenanceGate } = await import('data:text/javascript;base64,' + fs.readFileSync(path.join(PUBLIC, 'js', 'work-data-maintenance-gate.js')).toString('base64'));
  const { apiErrorInfo } = { apiErrorInfo: e => ({ code: e.code || '', message: e.message || '' }) };
  let calls = 0;
  const gate = createMaintenanceGate({ api: async () => { calls++; return { maintenance: { phase: 'open' } }; }, apiErrorInfo, t: k => k, doc: { getElementById: () => null }, win: null, pollMs: 1e9 });
  assert.equal(gate.noteFailure({ code: 'desktop_lifetime.closing', message: 'work_data.maintenance_busy' }), false);
  await new Promise(setImmediate); assert.equal(calls, 0, 'no status poll for a closing desktop');
  assert.equal(gate.noteFailure({ code: 'api.internal_error', message: 'work_data.maintenance_busy' }), true, 'the internal_error fallback still works');
  assert.equal(gate.noteFailure({ code: '', message: 'work_data.maintenance_busy' }), true, 'so does a code-less error');
  assert.equal(gate.noteFailure({ code: 'session.not_found', message: 'work_data.maintenance_busy' }), false, 'any other specific code wins over its message');
  await new Promise(setImmediate); assert.ok(calls >= 1);
});

test('the closing code has its own copy in both languages and does not trigger the maintenance gate', async () => {
  const load = file => import('data:text/javascript;base64,' + fs.readFileSync(path.join(PUBLIC, 'js', file)).toString('base64'));
  const { apiErrorCopyKey, createApiErrorPresenter } = await load('api-error-i18n.js');
  const { isMaintenanceFailureCode } = await load('work-data-maintenance-gate.js');
  assert.equal(apiErrorCopyKey('desktop_lifetime.closing'), 'error.code.desktopLifetimeClosing');
  for (const [lang, pattern, forbidden] of [['zh-CN', /正在关闭/, /维护/], ['en-US', /closing/i, /maintenance/i]]) {
    const c = catalog(lang);
    const t = key => c[key] || key;
    const present = createApiErrorPresenter({ t, apiErrorInfo: e => ({ code: e.code, params: {}, message: e.message || '' }), rawApiErrText: () => '', privacyFailure: () => null });
    const text = present({ code: 'desktop_lifetime.closing', message: 'work_data.maintenance_busy' });
    assert.match(text, pattern, lang); assert.doesNotMatch(text, forbidden, lang + ' closing copy does not claim maintenance');
    for (const mirror of [c, JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../docs/i18n/locales', lang + '.json'), 'utf8'))]) assert.equal(mirror['error.code.desktopLifetimeClosing'], c['error.code.desktopLifetimeClosing']);
  }
  assert.equal(isMaintenanceFailureCode('desktop_lifetime.closing'), false, 'a closing desktop is not polled as maintenance');
});
