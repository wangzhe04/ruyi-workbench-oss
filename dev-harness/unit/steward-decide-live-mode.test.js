'use strict';
// 安全审计修复 E:steward_decide 的非代批路径按【会话头档与活回合实效档中更紧的那一个】判 mayAct。
// 修前只看会话头 / 全局档:全局 auto、会话头没设档,而回合实际按请求级 default 在跑(定时任务的
// autonomy.permissionMode、交办卡收紧),管家拿 auto 去判 → 替用户批掉了回合自己该问人的那一步。
// 真源码、临时 HOME、真待决账;活回合用登记表上的最小替身(09 挂 effectivePermissionMode(),05 挂 permissionMode)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-steward-live-mode-'));
const WORK = path.join(root, 'work');
fs.mkdirSync(WORK, { recursive: true });
fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
  configSchema: 7, permissionMode: 'auto', defaultWorkspace: WORK, recentWorkspaces: [],
  stewardEnabledV1: true, stewardPollMs: 120000, includeWorkbenchMcp: false,
}, null, 2));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
const { createSession, registerIntervention, readInterventions, activeChildren } = srv;
after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

const stewardCtx = () => ({ session: { id: 'steward', kind: 'steward', providerHistory: [] } });
async function pendingEdit(opts = {}) {
  const s = await createSession({ title: 't', cwd: WORK, ...(opts.origin ? { origin: opts.origin } : {}) });
  const ivId = 'perm_' + Math.random().toString(16).slice(2, 10);
  registerIntervention(s.id, 'permission', ivId, { toolName: 'file_write', tier: 'edit', input: { path: path.join(WORK, 'x.txt'), content: 'x' } });
  for (let i = 0; i < 100 && !(await readInterventions(s.id)).some(x => x.id === ivId); i++) await new Promise(r => setTimeout(r, 10));
  return { sid: s.id, ivId };
}
const decide = (sid, ivId) => srv.toolCall('steward_decide', { missionId: sid, interventionId: ivId, action: 'allow' }, stewardCtx());
const blockedByMode = r => r && r.ok === false && r.error === 'propose_required' && r.reason === 'permission_mode';

test('[E0] 对照:没有活回合、会话头跟随全局 auto → 管家可以代答(证明下面的拦截来自活回合档)', async () => {
  const { sid, ivId } = await pendingEdit();
  const r = await decide(sid, ivId);
  assert.ok(!blockedByMode(r), 'head/global auto lets the steward act: ' + JSON.stringify(r).slice(0, 200));
});

test('[E1] 活回合(09)按请求级 default 在跑 → 管家不得按全局 auto 代批', async () => {
  const { sid, ivId } = await pendingEdit();
  activeChildren.set(sid, { session: { id: sid }, effectivePermissionMode: () => 'default', onEvent() {} });
  try {
    const r = await decide(sid, ivId);
    assert.ok(blockedByMode(r), 'blocked by the live turn mode: ' + JSON.stringify(r).slice(0, 300));
    assert.equal(r.effectivePermissionMode, 'default');
    assert.equal(r.permissionMode, 'auto', 'head/global mode still reported as-is');
  } finally { activeChildren.delete(sid); }
});

test('[E2] Claude CLI 活回合(05 登记 spawn 时的解析档 plan)同样收紧', async () => {
  const { sid, ivId } = await pendingEdit();
  activeChildren.set(sid, { session: { id: sid }, permissionMode: 'plan', kind: 'claude', onEvent() {} });
  try {
    const r = await decide(sid, ivId);
    assert.ok(blockedByMode(r), JSON.stringify(r).slice(0, 300));
    assert.equal(r.effectivePermissionMode, 'plan');
  } finally { activeChildren.delete(sid); }
});

test('[E3] 活回合档更宽(请求级 bypass/auto,会话头 default)不放宽:仍按会话头判', async () => {
  const { sid, ivId } = await pendingEdit();
  await srv.updateSessionMeta(sid, { permissionMode: 'default' });
  activeChildren.set(sid, { session: { id: sid }, effectivePermissionMode: () => 'auto', onEvent() {} });
  try {
    const r = await decide(sid, ivId);
    assert.ok(blockedByMode(r), 'wider live mode never widens the steward: ' + JSON.stringify(r).slice(0, 300));
    assert.equal(r.permissionMode, 'default');
    assert.equal(r.effectivePermissionMode, undefined, 'no tightening recorded when the head is already tighter');
  } finally { activeChildren.delete(sid); }
});

test('[E4] 定时任务开出来的线程读不到活回合档 → 按 default 算', async () => {
  const { sid, ivId } = await pendingEdit({ origin: 'schedule' });
  const r = await decide(sid, ivId);
  assert.ok(blockedByMode(r), JSON.stringify(r).slice(0, 300));
  assert.equal(r.effectivePermissionMode, 'default');
});
