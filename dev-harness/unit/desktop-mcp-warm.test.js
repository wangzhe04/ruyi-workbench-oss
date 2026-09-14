// Unit(39 号文):桌面 MCP 探针的异步孪生与启动预热 —— 「探针不再占住事件循环」。
//
// 病根(34 号文 §13.10 / 36 号文 §5.3 登记的那条):detectDesktopMcp → pickPython → probeDesktopPython
// 是同步 spawnSync,一轮下来本机实测 2.4 s(冷缓存,选中 mcp/ai-computer-control 的 .venv)。122 波把它
// 挪到 listen 之后 500 ms,只解决了「起跑那一刻」——探针一开跑,那 2 s 里到达的请求照样得等,e2e 每件的
// 首个 /api/status 与 8 路全量的「workbench started 超时」都是这一发。
//
// 修法(39 号文 §2):同步签名【保留】(resolveExternalMcpServers 一族散在 8 个模块 12 处,连静态件都同步
// 调),新增异步孪生 pickPythonAsync / detectDesktopMcpAsync 与预热闸门 ensureDesktopMcpWarm();预热走
// execFile,写进的正是同步那支要读的两张缓存,于是同步调用者一发 spawnSync 都不用付。
//
// 覆盖(前两条在【子进程】里跑:要证的正是「换一个进程也不用再探」与真实的事件循环占用):
//   ① 差分对照:同一发慢探针,异步版最大计时器迟到 < SLOW_MS/3,同步版 ≥ SLOW_MS*0.6 ——
//      两边都真跑满了 SLOW_MS。反向意义:若哪天异步版偷偷退回 spawnSync,这一条立刻红。
//   ② 预热之后【另一个进程】的同步 pickPython 不再探(< SLOW_MS/3),答案一致,磁盘缓存恰一条。
//   ③ 挑人规则与同步版同形:不存在的候选跳过(连探都不探)、core 之后遇到 full 要改选 full、
//      options.probe 这个测试口在异步版里同样被 await。
//   ④ ensureDesktopMcpWarm() 并发共用同一趟(promise 同一个对象),落定之后再叫是新的一趟。
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..');
const SERVER = path.join(repo, 'ruyi-workbench', 'app', 'server.js');
const SLOW_MS = 900;
const TICK_MS = 25;

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-mcp-warm-'));
  const temp = path.join(dir, 'temp');
  const home = path.join(dir, 'home');
  const root = path.join(dir, 'fake-repo');
  for (const d of [temp, home, root]) fs.mkdirSync(d, { recursive: true });
  // 装成一个 python:忽略 -X utf8 -c 那串参数,睡够 SLOW_MS 再以 1 退出(=「导入失败」)。
  // 探针只认 stdout 里的 __RUYI_ACC_* 与退出码,所以这就够真。
  const slow = path.join(dir, 'slow-python.js');
  fs.writeFileSync(slow, `setTimeout(() => process.exit(1), ${SLOW_MS});\n`);
  const child = path.join(dir, 'child.js');
  fs.writeFileSync(child, `
    const srv = require(${JSON.stringify(SERVER)});
    const mode = process.argv[2];
    const root = ${JSON.stringify(root)};
    const env = { PYTHONPATH: '' };
    const slowCandidate = { command: process.execPath, args: [${JSON.stringify(slow)}], source: 'slow-fake', requireExisting: false };
    const out = value => process.stdout.write(JSON.stringify(value));

    // 事件循环占用计,每 TICK_MS 一跳:被同步 spawnSync 占住时这一跳打不出来,迟到量就是占用时长。
    function meter() {
      let maxDrift = 0;
      let last = Date.now();
      const timer = setInterval(() => { const now = Date.now(); maxDrift = Math.max(maxDrift, now - last - ${TICK_MS}); last = now; }, ${TICK_MS});
      return { stop() { clearInterval(timer); return maxDrift; } };
    }

    (async () => {
      if (mode === 'drift-async' || mode === 'drift-sync') {
        const m = meter();
        await new Promise(r => setTimeout(r, ${TICK_MS} * 2));   // 先让它正常跳两下,基线归零
        const t0 = Date.now();
        const value = mode === 'drift-async'
          ? await srv.pickPythonAsync(root, env, { candidates: [slowCandidate], noCache: true })
          : srv.pickPython(root, env, { candidates: [slowCandidate], noCache: true });
        const ms = Date.now() - t0;
        // 同步那支占住事件循环时,被挤掉的那一跳要等它放手才打得出来 —— 不给这个机会就永远量到 0。
        await new Promise(r => setTimeout(r, ${TICK_MS} * 3));
        return out({ ms, maxDrift: m.stop(), value: value ? value.source : null });
      }
      if (mode === 'warm-async') {
        const t0 = Date.now();
        const value = await srv.pickPythonAsync(root, env, { candidates: [slowCandidate] });
        return out({ ms: Date.now() - t0, value: value ? value.source : null });
      }
      if (mode === 'sync-after-warm') {
        const t0 = Date.now();
        const value = srv.pickPython(root, env, { candidates: [slowCandidate] });
        return out({ ms: Date.now() - t0, value: value ? value.source : null });
      }
      if (mode === 'picker') {
        const probed = [];
        const candidates = [
          { command: ${JSON.stringify(path.join(dir, 'ghost', 'python.exe'))}, args: [], source: 'ghost', requireExisting: true },
          { command: process.execPath, args: [], source: 'core-one', requireExisting: false },
          { command: process.execPath, args: [], source: 'full-one', requireExisting: false },
          { command: process.execPath, args: [], source: 'after-full', requireExisting: false },
        ];
        const probe = async candidate => { probed.push(candidate.source); return candidate.source === 'full-one' ? 'full' : 'core'; };
        const value = await srv.pickPythonAsync(root, env, { candidates, probe });
        return out({ probed, source: value ? value.source : null, capability: value ? value.capability : null });
      }
      if (mode === 'warm-dedupe') {
        const on = { desktopMcp: { enabled: true, command: '', args: [], cwd: '', autodetect: true } };
        const first = srv.ensureDesktopMcpWarm(on);
        const second = srv.ensureDesktopMcpWarm(on);
        const shared = first === second;
        await first;
        const third = srv.ensureDesktopMcpWarm(on);
        const fresh = third !== first;
        await third;
        return out({ shared, fresh });
      }
      if (mode === 'warm-gate') {
        // 停用/显式覆盖/不 autodetect/没给 config 时:一发探针都不许放,也不许走那趟 walk。
        // 观察量是「立刻返回 null」—— 本机真走一趟冷探是 2.4 s,连磁盘缓存命中也要读盘。
        const results = {};
        for (const [label, cfg] of [
          ['disabled', { desktopMcp: { enabled: false, autodetect: true } }],
          ['explicit-command', { desktopMcp: { enabled: true, autodetect: true, command: 'C:/somewhere/python.exe' } }],
          ['no-autodetect', { desktopMcp: { enabled: true, autodetect: false } }],
          ['no-config', undefined],
        ]) {
          const t0 = Date.now();
          results[label] = { value: await srv.ensureDesktopMcpWarm(cfg), ms: Date.now() - t0 };
        }
        return out(results);
      }
      throw new Error('unknown mode ' + mode);
    })().catch(err => { process.stderr.write(String((err && err.stack) || err)); process.exit(3); });
  `);
  return { dir, child, temp, home, cacheFile: path.join(temp, 'ruyi-desktop-python-probe.v1.json') };
}

function runChild(fx, mode) {
  const result = cp.spawnSync(process.execPath, [fx.child, mode], {
    env: { ...process.env, TEMP: fx.temp, TMP: fx.temp, TMPDIR: fx.temp, RUYI_HOME: fx.home, HOME: fx.home, USERPROFILE: fx.home },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
  });
  assert.equal(result.status, 0, `child(${mode}) exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('desktop python probe has an async twin that keeps the event loop free', () => {
  const fx = makeFixture();
  try {
    const asyncRun = runChild(fx, 'drift-async');
    assert.equal(asyncRun.value, null, '① 慢候选探不出 -> null(异步版判据与同步版一致)');
    assert.ok(asyncRun.ms >= SLOW_MS, `① 异步版真的等满了那发探针(实测 ${asyncRun.ms}ms >= ${SLOW_MS})`);
    assert.ok(asyncRun.maxDrift < SLOW_MS / 3, `① 异步版不占事件循环(最大迟到 ${asyncRun.maxDrift}ms < ${Math.round(SLOW_MS / 3)})`);

    const syncRun = runChild(fx, 'drift-sync');
    assert.equal(syncRun.value, null, '① 同步版同答案');
    assert.ok(syncRun.maxDrift >= SLOW_MS * 0.6,
      `① 对照:同步版把事件循环钉住(最大迟到 ${syncRun.maxDrift}ms >= ${Math.round(SLOW_MS * 0.6)})——这一条证明上面那把尺子量得出差别`);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('async warm-up fills the caches the synchronous path reads (across processes)', () => {
  const fx = makeFixture();
  try {
    const warm = runChild(fx, 'warm-async');
    assert.equal(warm.value, null, '② 预热那趟的答案');
    assert.ok(warm.ms >= SLOW_MS, `② 预热那趟真探了(实测 ${warm.ms}ms)`);

    assert.ok(fs.existsSync(fx.cacheFile), '② 异步版也写跨进程缓存(与同步版同一个文件)');
    const parsed = JSON.parse(fs.readFileSync(fx.cacheFile, 'utf8'));
    const ids = Object.keys(parsed.entries || {});
    assert.equal(ids.length, 1, '② 恰一条');
    assert.equal(parsed.entries[ids[0]].value, null, '② 否定条目 value:null');

    const after = runChild(fx, 'sync-after-warm');
    assert.equal(after.value, null, '② 另一个进程的同步 pickPython 拿到同一个答案');
    assert.ok(after.ms < SLOW_MS / 3, `② 而且一发探针都不用付(实测 ${after.ms}ms < ${Math.round(SLOW_MS / 3)})`);
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('async picker keeps the synchronous selection rules (skip missing, prefer full, await the probe seam)', () => {
  const fx = makeFixture();
  try {
    const picked = runChild(fx, 'picker');
    assert.deepEqual(picked.probed, ['core-one', 'full-one'],
      '③ 不存在的候选连探都不探;拿到 full 之后不再往下探');
    assert.equal(picked.source, 'full-one', '③ core 兜底,遇到 full 改选 full');
    assert.equal(picked.capability, 'full', '③ capability 跟着走');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('ensureDesktopMcpWarm shares one pass while in flight and starts a new one after it settles', () => {
  const fx = makeFixture();
  try {
    const gate = runChild(fx, 'warm-dedupe');
    assert.equal(gate.shared, true, '④ 在途时并发调用共用同一趟(同一个 promise 对象)');
    assert.equal(gate.fresh, true, '④ 落定之后再叫是新的一趟(在途标记清干净了)');
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});

test('ensureDesktopMcpWarm never probes when autodetect is off, overridden, or config is unknown', () => {
  const fx = makeFixture();
  try {
    const gated = runChild(fx, 'warm-gate');
    for (const label of ['disabled', 'explicit-command', 'no-autodetect', 'no-config']) {
      assert.equal(gated[label].value, null, `⑤ ${label}:不预热,返回 null`);
      assert.ok(gated[label].ms < 50,
        `⑤ ${label}:立刻返回(实测 ${gated[label].ms}ms < 50)——真走一趟 walk 不可能这么快`);
    }
  } finally { fs.rmSync(fx.dir, { recursive: true, force: true }); }
});
