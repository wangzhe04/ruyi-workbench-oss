#!/usr/bin/env node
'use strict';

// 121-K1（34 号文 §8.3 第 2 条）：「需要你」本地提醒策略层的真值表。
//
// 这一层的前身是 js/preview-notifications.js（第83波），断言原本住在
// dev-harness/pretender-narrative-notifications.e2e.js 的 B*/C* 两段里。交办台退役后那一件整件删除，
// 策略层改名搬去 js/notify-policy.js —— B*/C* 是「删掉就丢覆盖」的部分，逐条搬到这里，
// 并补两条搬家自己带来的新契约（存储键升版 + 旧键只迁移一次）与设置块绑定的往返。
//
// 与 dev-harness/unit/steward-focus-thread.test.js 同款约定：ESM 模块直接 import 磁盘文件，
// 零磁盘写、零 DOM、每条用例只构造字面量。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE_PATH = path.resolve(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'notify-policy.js');
let modulePromise;
function loadModule() {
  if (!modulePromise) modulePromise = import(pathToFileURL(MODULE_PATH).href);
  return modulePromise;
}

// 假 localStorage：只是一张 Map，外加一个可翻的「抛异常」开关（隐私模式/禁用站点数据）。
function fakeStorage(seed = {}, { throwing = false } = {}) {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem(key) { if (throwing) throw new Error('storage disabled'); return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { if (throwing) throw new Error('storage disabled'); map.set(key, String(value)); },
    removeItem(key) { if (throwing) throw new Error('storage disabled'); map.delete(key); },
  };
}

describe('提醒设置：默认值与免打扰时段', () => {
  it('B1 默认关闭，且带一个显式的跨夜免打扰窗', async () => {
    const { normalizeNotifySettings } = await loadModule();
    const defaults = normalizeNotifySettings(null);
    assert.equal(defaults.enabled, false);
    assert.equal(defaults.quietStart, '22:00');
    assert.equal(defaults.quietEnd, '08:00');
  });

  it('B2 免打扰跨午夜：开始时刻含、结束时刻不含', async () => {
    const { normalizeNotifySettings, isQuietTime } = await loadModule();
    const defaults = normalizeNotifySettings(null);
    const at = (hour, minute) => new Date(2026, 7, 1, hour, minute, 0, 0);
    assert.equal(isQuietTime(at(21, 59), defaults), false);
    assert.equal(isQuietTime(at(22, 0), defaults), true);
    assert.equal(isQuietTime(at(7, 59), defaults), true);
    assert.equal(isQuietTime(at(8, 0), defaults), false);
  });

  it('B3 起止相同 = 不设免打扰；同日时段边界同样确定', async () => {
    const { isQuietTime } = await loadModule();
    const at = (hour, minute) => new Date(2026, 7, 1, hour, minute, 0, 0);
    assert.equal(isQuietTime(at(9, 0), { quietStart: '09:00', quietEnd: '09:00' }), false);
    assert.equal(isQuietTime(at(12, 0), { quietStart: '09:00', quietEnd: '17:00' }), true);
    assert.equal(isQuietTime(at(17, 0), { quietStart: '09:00', quietEnd: '17:00' }), false);
  });

  it('B4 坏钟点回落到默认值，坏 JSON 不抛', async () => {
    const { normalizeNotifySettings } = await loadModule();
    assert.equal(normalizeNotifySettings('{not json').quietStart, '22:00');
    assert.equal(normalizeNotifySettings({ quietStart: '25:00', quietEnd: 'x' }).quietStart, '22:00');
    assert.equal(normalizeNotifySettings({ quietStart: '25:00', quietEnd: 'x' }).quietEnd, '08:00');
    assert.equal(normalizeNotifySettings({ enabled: 'yes' }).enabled, false, 'enabled 只认严格 true');
  });
});

describe('提醒投递：去重、撤回、基线', () => {
  const ctx = { enabled: true, permission: 'granted', quiet: false };

  it('C1 第一次读只建基线，不把历史待决集体炸出来', async () => {
    const { reconcileNotifications } = await loadModule();
    const first = reconcileNotifications({}, ['historical'], ctx);
    assert.deepEqual(first.notify, []);
    assert.equal(first.state.primed, true);
    assert.ok(first.state.known.includes('historical'));
  });

  it('C2/C3 新出现的待决恰好提醒一次，再轮询不重复', async () => {
    const { reconcileNotifications } = await loadModule();
    let state = reconcileNotifications({}, ['historical'], ctx).state;
    const fresh = reconcileNotifications(state, ['historical', 'fresh'], ctx);
    assert.deepEqual(fresh.notify, ['fresh']);
    assert.ok(fresh.state.active.includes('fresh'));
    state = fresh.state;
    assert.deepEqual(reconcileNotifications(state, ['historical', 'fresh'], ctx).notify, []);
  });

  it('C4 待决消失（终态/被处理）时撤回它那条已亮的通知', async () => {
    const { reconcileNotifications } = await loadModule();
    let state = reconcileNotifications({}, ['historical'], ctx).state;
    state = reconcileNotifications(state, ['historical', 'fresh'], ctx).state;
    const gone = reconcileNotifications(state, ['historical'], ctx);
    assert.ok(gone.close.includes('fresh'));
    assert.ok(!gone.state.active.includes('fresh'));
  });

  it('C5/C6 免打扰期内的待决记为已见，出了免打扰也不补炸', async () => {
    const { reconcileNotifications } = await loadModule();
    let state = reconcileNotifications({}, ['historical'], ctx).state;
    const quiet = reconcileNotifications(state, ['historical', 'quiet-new'], { ...ctx, quiet: true });
    assert.deepEqual(quiet.notify, []);
    assert.ok(quiet.state.known.includes('quiet-new'));
    state = quiet.state;
    assert.deepEqual(reconcileNotifications(state, ['historical', 'quiet-new'], ctx).notify, []);
  });

  it('C7 权限被拒时一条都不发（也不假装发过）', async () => {
    const { reconcileNotifications } = await loadModule();
    const state = reconcileNotifications({}, ['historical'], ctx).state;
    const denied = reconcileNotifications(state, ['historical', 'denied-new'], { ...ctx, permission: 'denied' });
    assert.deepEqual(denied.notify, []);
    assert.ok(denied.state.known.includes('denied-new'));
  });

  it('C8 应用重启重建基线，不重放旧决定', async () => {
    const { reconcileNotifications } = await loadModule();
    const restarted = reconcileNotifications({}, ['historical', 'quiet-new', 'denied-new'], ctx);
    assert.deepEqual(restarted.notify, []);
  });

  it('C9 关掉总开关时把已亮的全部撤回', async () => {
    const { reconcileNotifications } = await loadModule();
    let state = reconcileNotifications({}, [], ctx).state;
    state = reconcileNotifications(state, ['a'], ctx).state;
    assert.ok(state.active.includes('a'));
    const off = reconcileNotifications(state, ['a'], { ...ctx, enabled: false });
    assert.ok(off.close.includes('a'));
    assert.deepEqual(off.notify, []);
  });
});

describe('121-K1 搬家：存储键升版与旧键迁移', () => {
  it('D1 新键读写走 wcw.notifyPolicy.v1', async () => {
    const { NOTIFY_POLICY_STORAGE_KEY, readNotifySettings, writeNotifySettings } = await loadModule();
    assert.equal(NOTIFY_POLICY_STORAGE_KEY, 'wcw.notifyPolicy.v1');
    const storage = fakeStorage();
    writeNotifySettings({ enabled: true, quietStart: '01:00', quietEnd: '02:00' }, storage);
    assert.ok(storage.map.has('wcw.notifyPolicy.v1'));
    const back = readNotifySettings(storage);
    assert.equal(back.enabled, true);
    assert.equal(back.quietStart, '01:00');
  });

  it('D2 旧键 wcw.previewNeedsNotifications.v1 只迁移一次（写新键、删旧键）', async () => {
    const { LEGACY_NOTIFY_STORAGE_KEY, readNotifySettings } = await loadModule();
    assert.equal(LEGACY_NOTIFY_STORAGE_KEY, 'wcw.previewNeedsNotifications.v1');
    const storage = fakeStorage({
      'wcw.previewNeedsNotifications.v1': JSON.stringify({ version: 1, enabled: true, quietStart: '23:30', quietEnd: '06:15' }),
    });
    const migrated = readNotifySettings(storage);
    assert.equal(migrated.enabled, true, '用户调好的设置不丢');
    assert.equal(migrated.quietStart, '23:30');
    assert.equal(migrated.quietEnd, '06:15');
    assert.equal(storage.map.has('wcw.previewNeedsNotifications.v1'), false, '旧键迁移后删掉，不留死值');
    assert.ok(storage.map.has('wcw.notifyPolicy.v1'));
    // 第二次读走的是新键，与旧键无关（把旧键塞回一个相反的值也不该改变结果）
    storage.map.set('wcw.previewNeedsNotifications.v1', JSON.stringify({ enabled: false }));
    assert.equal(readNotifySettings(storage).enabled, true);
  });

  it('D3 新键在场时旧键一眼都不看', async () => {
    const { readNotifySettings } = await loadModule();
    const storage = fakeStorage({
      'wcw.notifyPolicy.v1': JSON.stringify({ enabled: false, quietStart: '03:00', quietEnd: '04:00' }),
      'wcw.previewNeedsNotifications.v1': JSON.stringify({ enabled: true, quietStart: '23:30', quietEnd: '06:15' }),
    });
    const settings = readNotifySettings(storage);
    assert.equal(settings.quietStart, '03:00');
    assert.ok(storage.map.has('wcw.previewNeedsNotifications.v1'), '不在场判定里就不该顺手删别人的键');
  });

  it('D4 storage 抛异常（隐私模式/禁用站点数据）时退回默认设置，不抛', async () => {
    const { readNotifySettings, writeNotifySettings } = await loadModule();
    const storage = fakeStorage({}, { throwing: true });
    assert.equal(readNotifySettings(storage).enabled, false);
    assert.equal(writeNotifySettings({ enabled: true }, storage).enabled, true, '返回值仍是归一化后的设置');
  });
});

describe('121-K1 搬家：「提醒」设置块的绑定', () => {
  // 假 DOM：只实现 getElementById + 三个控件需要的字段，零真 DOM。
  function fakeDocument() {
    const nodes = {
      cfgNotifyEnabled: { checked: false, disabled: false, onchange: null },
      cfgNotifyQuietStart: { value: '', onchange: null },
      cfgNotifyQuietEnd: { value: '', onchange: null },
      notifyStatus: { textContent: '' },
    };
    return { nodes, getElementById: id => nodes[id] || null };
  }

  it('E1 绑定时把本机偏好画到控件上，状态行走 i18n 键', async () => {
    const { bindNotifySettings } = await loadModule();
    const documentRef = fakeDocument();
    const storage = fakeStorage({
      'wcw.notifyPolicy.v1': JSON.stringify({ enabled: true, quietStart: '21:00', quietEnd: '07:00' }),
    });
    bindNotifySettings({ documentRef, storage, notificationApi: { permission: 'granted' }, t: key => key });
    assert.equal(documentRef.nodes.cfgNotifyEnabled.checked, true);
    assert.equal(documentRef.nodes.cfgNotifyQuietStart.value, '21:00');
    assert.equal(documentRef.nodes.cfgNotifyQuietEnd.value, '07:00');
    assert.equal(documentRef.nodes.notifyStatus.textContent, 'notify.on');
  });

  it('E2 不支持系统通知时置灰开关，状态行说清原因', async () => {
    const { bindNotifySettings } = await loadModule();
    const documentRef = fakeDocument();
    bindNotifySettings({ documentRef, storage: fakeStorage(), notificationApi: undefined, t: key => key });
    assert.equal(documentRef.nodes.cfgNotifyEnabled.disabled, true);
    assert.equal(documentRef.nodes.notifyStatus.textContent, 'notify.unsupported');
  });

  it('E3 改免打扰时段落盘；权限被拒时开关自己弹回关', async () => {
    const { bindNotifySettings, readNotifySettings } = await loadModule();
    const documentRef = fakeDocument();
    const storage = fakeStorage();
    bindNotifySettings({ documentRef, storage, notificationApi: { permission: 'denied' }, t: key => key });
    documentRef.nodes.cfgNotifyQuietStart.onchange({ target: { value: '20:30' } });
    assert.equal(readNotifySettings(storage).quietStart, '20:30');
    await documentRef.nodes.cfgNotifyEnabled.onchange({ target: { checked: true } });
    assert.equal(readNotifySettings(storage).enabled, false, '拒了就不许留一个「已开启」的假象');
    assert.equal(documentRef.nodes.cfgNotifyEnabled.checked, false);
  });

  it('E4 permission=default 时先问一次；答应了才算开', async () => {
    const { bindNotifySettings, readNotifySettings } = await loadModule();
    const documentRef = fakeDocument();
    const storage = fakeStorage();
    let asked = 0;
    const notificationApi = { permission: 'default', requestPermission: async () => { asked += 1; return 'granted'; } };
    bindNotifySettings({ documentRef, storage, notificationApi, t: key => key });
    await documentRef.nodes.cfgNotifyEnabled.onchange({ target: { checked: true } });
    assert.equal(asked, 1);
    assert.equal(readNotifySettings(storage).enabled, true);
  });
});
