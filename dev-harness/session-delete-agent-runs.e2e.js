'use strict';
// 真工作流 + 进程内 fake provider:删除线程停后台班组;purge 清盘不被迟到写复活,
// 普通删除保留停止历史,其它线程照常跑,启动预检在飞时也不能注册已删线程的 run。
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startFakeProvider, textFrames } = require('./lib/fake-openai-provider');
const { loadServerInternals } = require('./lib/server-internals');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-delete-agent-runs-'));
for (const key of ['RUYI_HOME', 'WIN_CLAUDE_WORKBENCH_HOME', 'HOME', 'USERPROFILE']) process.env[key] = root;
const s = loadServerInternals([
  'createSession', 'saveSession', 'loadSession', 'deleteSession', 'runAgentWorkflow',
  'activeAgentRuns', 'agentRunDir', 'readConfig', 'activeOpenAiProvider', 'saveAgentRun',
  'appendAgentRunEvent', 'flushAgentRunEvents', 'flushSessionIndex', 'getAgentRoleLibrary',
], { withEval: true });
const runner = createRunner('SESSION DELETE AGENT RUNS');
const { ok } = runner;
let fake;
let nextGate = null;
const releases = [];
function armGate() {
  let release, arrived;
  const blocked = new Promise(resolve => { release = resolve; });
  const reached = new Promise(resolve => { arrived = resolve; });
  nextGate = { blocked, arrived };
  releases.push(release);
  return { release, reached };
}
async function session(title) {
  const value = await s.createSession({ title, cwd: root });
  await s.saveSession(value);
  return value;
}

(async () => {
  try {
    fake = await startFakeProvider({ async handler() {
      const gate = nextGate;
      nextGate = null;
      if (gate) { gate.arrived(); await gate.blocked; }
      return textFrames('completed');
    } });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
      configSchema: 9, permissionMode: 'bypass', defaultWorkspace: root,
      desktopMcp: { enabled: false }, includeWorkbenchMcp: false,
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: fake.url, apiKey: 'k', model: 'fake-model' }],
      activeProvider: 'fake', agentWorkflowMaxNodes: 12, subagentMaxPerTurn: 12, subagentMaxConcurrent: 4,
    }), 'utf8');
    const config = await s.readConfig();
    const launch = (parentSession, nodes) => s.runAgentWorkflow({
      parentSession, config, provider: s.activeOpenAiProvider(config), nodes,
      onEvent: () => {}, maxNodes: 12, background: true,
    });
    const nodes = [{ id: 'first', task: 'first' }, { id: 'after', task: 'after deletion', dependsOn: ['first'] }];

    const deleted = await session('purged');
    const gate = armGate();
    const finished = launch(deleted, nodes);
    await gate.reached;
    const live = [...s.activeAgentRuns.values()].find(value => value.run.sessionId === deleted.id);
    ok(!!live, '后台班组已登记并进入 provider');
    const other = await session('other');
    const otherResult = await launch(other, [{ id: 'other', task: 'other thread' }]);
    ok(otherResult.results[0].status === 'succeeded', '其它线程在待删班组挂起时照常执行');
    const before = fake.requests.length;
    const result = await s.deleteSession(deleted.id, { purgeAssociated: true });
    ok(result.ok && result.purgedAssociated, '删除并清关联记录成功');
    ok(live.stopRequested && live.ctrl.signal.aborted, '删除请求停止对应班组');
    gate.release();
    await finished;
    ok(fake.requests.length === before, '删除之后依赖的后续节点没有调用 provider');
    ok(!s.activeAgentRuns.has(live.run.id), '被停班组完成收尾并撤销注册');
    await s.deleteSession(deleted.id);
    // 收尾之后再来一发持有旧 run 的写者,同样不能重建已清空的目录。
    await s.saveAgentRun(live.run);
    s.appendAgentRunEvent(live.run, { type: 'late_after_delete' });
    await s.flushAgentRunEvents(live.run.id);
    ok(!fs.existsSync(s.agentRunDir(deleted.id)), 'purge 后收尾和迟到快照/事件都不复活目录');
    ok(await s.loadSession(deleted.id) === null, '会话本身没有复活');
    ok(fs.existsSync(s.agentRunDir(other.id)) && !!await s.loadSession(other.id), '其它线程和任务历史保持可用');

    const retained = await session('keep history');
    const keepGate = armGate();
    const keepFinished = launch(retained, nodes);
    await keepGate.reached;
    const keepLive = [...s.activeAgentRuns.values()].find(value => value.run.sessionId === retained.id);
    const keepBefore = fake.requests.length;
    await s.deleteSession(retained.id);
    keepGate.release();
    await keepFinished;
    ok(fake.requests.length === keepBefore, '普通删除也停止后续节点');
    const kept = JSON.parse(await fsp.readFile(path.join(s.agentRunDir(retained.id), keepLive.run.id + '.json'), 'utf8'));
    ok(kept.status === 'stopped', 'purge=false 保留停止终稿');
    const events = await fsp.readFile(path.join(s.agentRunDir(retained.id), keepLive.run.id + '.events.ndjson'), 'utf8');
    ok(events.includes('run_stop_requested') && events.includes('run_end'), 'purge=false 保留停止请求和收尾事件');

    // 已开始的 append 不会被墓碑中途撤销:清盘必须先等这条现有写链,再删目录。
    const writing = await session('event append pending');
    const writingRun = { id: 'run_0123456789abcdef', sessionId: writing.id, status: 'running', nodes: [] };
    await s.saveAgentRun(writingRun);
    const writingDir = s.agentRunDir(writing.id);
    const originalAppend = fsp.appendFile;
    const originalReaddir = fsp.readdir;
    let appendReached, appendRelease, scanReached;
    const appendHit = new Promise(resolve => { appendReached = resolve; });
    const appendGate = new Promise(resolve => { appendRelease = resolve; });
    const scanHit = new Promise(resolve => { scanReached = resolve; });
    fsp.appendFile = async function (file, ...args) {
      if (String(file) === path.join(writingDir, writingRun.id + '.events.ndjson')) { appendReached(); await appendGate; }
      return originalAppend.call(this, file, ...args);
    };
    fsp.readdir = async function (dir, ...args) {
      const value = await originalReaddir.call(this, dir, ...args);
      if (String(dir) === writingDir) scanReached();
      return value;
    };
    try {
      s.appendAgentRunEvent(writingRun, { type: 'pending_before_delete' });
      await appendHit;
      let deleteSettled = false;
      const deleting = s.deleteSession(writing.id, { purgeAssociated: true }).then(value => { deleteSettled = true; return value; });
      await scanHit;
      ok(!deleteSettled && fs.existsSync(writingDir), '清盘等已开始的事件写链,不提前删除目录');
      appendRelease();
      await deleting;
      ok(!fs.existsSync(writingDir), '已开始的事件落完之后清盘成功');
    } finally { appendRelease(); fsp.appendFile = originalAppend; fsp.readdir = originalReaddir; }

    const pending = await session('preflight pending');
    const originalRoles = s.getAgentRoleLibrary;
    let roleReached, roleRelease;
    const roleWait = new Promise(resolve => { roleReached = resolve; });
    globalThis.__ruyiDeleteRoleReached = roleReached;
    s.__eval('getAgentRoleLibrary = async () => new Promise(resolve => { globalThis.__ruyiDeleteRoleRelease = () => resolve([]); globalThis.__ruyiDeleteRoleReached(); })');
    try {
      const pendingRun = launch(pending, nodes);
      await roleWait;
      roleRelease = globalThis.__ruyiDeleteRoleRelease;
      await s.deleteSession(pending.id, { purgeAssociated: true });
      const pendingBefore = fake.requests.length;
      roleRelease();
      const rejected = await pendingRun;
      ok(rejected.ok === false && rejected.startedCount === 0, '启动预检 await 期间删线程,工作流拒绝注册');
      ok(fake.requests.length === pendingBefore && !fs.existsSync(s.agentRunDir(pending.id)), '启动在飞的班组不调模型也不重建目录');
    } finally {
      if (roleRelease) roleRelease();
      globalThis.__ruyiDeleteOriginalRoles = originalRoles;
      s.__eval('getAgentRoleLibrary = globalThis.__ruyiDeleteOriginalRoles');
      delete globalThis.__ruyiDeleteOriginalRoles;
      delete globalThis.__ruyiDeleteRoleReached;
      delete globalThis.__ruyiDeleteRoleRelease;
    }
  } catch (error) { runner.fail(error.stack || String(error)); }
  finally {
    for (const release of releases) release();
    if (fake) await fake.close();
    await s.flushSessionIndex();
    fs.rmSync(root, { recursive: true, force: true });
  }
  runner.done();
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
