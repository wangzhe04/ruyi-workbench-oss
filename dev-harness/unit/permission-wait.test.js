// Unit(128f-⑪;Brief §4.2 第 7 条前半;用户 2026-09-19 拍板 A「立刻通知你,请求挂 600 秒等你处理」):
// 一条权限请求【等多久】的唯一判据 permissionWaitMs(04),与它的两格迟绑定。
//   [W1] 缺省 = config.permissionTimeoutMs(钳 ≥5 s;缺省 120 s)。
//   [W2] 管家开着 + 线程由管家盯着 + 用户没坐在它前面 → 600 s。三条缺一条都回到缺省(W3/W4/W5)。
//   [W6] 定时任务那一格优先(30 分钟):与管家那一格同时成立时取定时的。
//   [W7] 管家那一格是「至少 600 s」:用户自己把缺省调到 600 s,结果不降。
//   [W8] 权限挂着 → hasPendingPermissionForSession 为真(三处 idle 看门狗据此豁免);清掉之后为假,请求按拒落定。
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-permission-wait-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
delete process.env.WCW_TEST_STEWARD_PERMISSION_WAIT_MS;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

const SID = 'sess_permwait01';
const base = { permissionTimeoutMs: 120000 };
const on = { ...base, stewardEnabledV1: true };
const watchedHead = { id: SID, missionId: SID, stewardWatch: true };
const userHead = { id: SID, missionId: SID };

describe('权限请求等多久:permissionWaitMs', () => {
  it('[W1] 缺省 = config.permissionTimeoutMs(钳 ≥5 s;缺省 120 s)', () => {
    assert.strictEqual(srv.permissionWaitMs(SID, base, null), 120000);
    assert.strictEqual(srv.permissionWaitMs(SID, {}, null), 120000);
    assert.strictEqual(srv.permissionWaitMs(SID, null, null), 120000);
    assert.strictEqual(srv.permissionWaitMs(SID, { permissionTimeoutMs: 1000 }, null), 5000);
  });

  it('[W2] 管家开着 + 管家盯着 + 用户没坐着 → 600 s', () => {
    assert.strictEqual(srv.stewardMediatedPermissionWaitMs(SID, on, watchedHead), 600000);
    assert.strictEqual(srv.permissionWaitMs(SID, on, watchedHead), 600000);
    // 管家自己开的线程(没写 stewardWatch)同样算盯着(与收件箱、代批闸 3 同一个判据)
    assert.strictEqual(srv.permissionWaitMs(SID, on, { id: SID, missionId: SID, launchedBy: 'steward' }), 600000);
  });

  it('[W3] 管家关着 → 缺省', () => {
    assert.strictEqual(srv.permissionWaitMs(SID, { ...base, stewardEnabledV1: false }, watchedHead), 120000);
  });

  it('[W4] 没交给管家盯(或显式「别盯了」)→ 缺省', () => {
    assert.strictEqual(srv.permissionWaitMs(SID, on, userHead), 120000);
    assert.strictEqual(srv.permissionWaitMs(SID, on, { id: SID, missionId: SID, launchedBy: 'steward', stewardWatch: false }), 120000);
    // 会话头对不上这条 id(调用方传错)不许借别人的判据
    assert.strictEqual(srv.permissionWaitMs(SID, on, { id: 'sess_other', stewardWatch: true }), 120000);
    // 管家自己的会话不是线程
    assert.strictEqual(srv.permissionWaitMs('steward', on, { id: 'steward', stewardWatch: true }), 120000);
  });

  it('[W5] 用户此刻坐在这条线程上 → 缺省(请求是当面弹的)', () => {
    const original = srv.EventStreamHooks.presenceSnapshot;
    try {
      srv.EventStreamHooks.presenceSnapshot = () => [{ lens: 'classic', sessionId: SID }];
      assert.strictEqual(srv.permissionWaitMs(SID, on, watchedHead), 120000);
      srv.EventStreamHooks.presenceSnapshot = () => [{ lens: 'steward', sessionId: '' }, { lens: 'classic', sessionId: 'sess_else' }];
      assert.strictEqual(srv.permissionWaitMs(SID, on, watchedHead), 600000, '坐在别的线程 / 在管家视角 不算坐着');
    } finally { srv.EventStreamHooks.presenceSnapshot = original; }
  });

  it('[W6] 定时任务那一格优先', () => {
    try {
      srv.schedulerAskWaitSessions.set(SID, 1800000);
      assert.strictEqual(srv.permissionWaitMs(SID, on, watchedHead), 1800000);
      assert.strictEqual(srv.permissionWaitMs(SID, base, userHead), 1800000);
    } finally { srv.schedulerAskWaitSessions.delete(SID); }
    assert.strictEqual(srv.permissionWaitMs(SID, base, userHead), 120000, '表清掉之后回到缺省');
  });

  it('[W7] 管家那一格是「至少 600 s」', () => {
    assert.strictEqual(srv.permissionWaitMs(SID, { ...on, permissionTimeoutMs: 600000 }, watchedHead), 600000);
    assert.strictEqual(srv.permissionWaitMs(SID, { ...on, permissionTimeoutMs: 300000 }, watchedHead), 600000);
  });

  it('[W8] 权限挂着 → hasPendingPermissionForSession 为真;清掉之后为假且按拒落定', async () => {
    const psid = 'sess_permwait02';
    assert.strictEqual(srv.hasPendingPermissionForSession(psid), false);
    const decision = srv.requestNativePermission(psid, 'powershell_run', { command: 'echo hi' }, () => {}, 60000, 'exec');
    assert.strictEqual(srv.hasPendingPermissionForSession(psid), true);
    assert.strictEqual(srv.hasPendingPermissionForSession('sess_someone_else'), false);
    srv.clearPendingPermissions(psid, 'unit test clear');
    const settled = await decision;
    assert.strictEqual(settled && settled.behavior, 'deny');
    assert.strictEqual(srv.hasPendingPermissionForSession(psid), false);
  });
});
