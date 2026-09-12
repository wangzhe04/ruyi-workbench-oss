// Unit: 121 换机器实测(34 号文 §13.8/§13.10)—— pickPython 的探针结果跨进程缓存。
//
// 根因:01-config.js 的 desktopPythonCache 只活在本进程。这台机器 python / python3 / py -3 三个候选各要
// ~1.7 s 才答得出来,而 pickPython 为了优先选 Full 会把候选【全部】探完(前两个 miss、第三个 core),
// 于是每个新进程首启都同步阻塞 ~5 s 在 listen 之前;e2e 每件各起一个服务就每件各付 5 s,8 路并发下更慢,
// 全量 66 件「workbench listening」红。修法:整轮的结果(选中了谁,或整轮没有)写进
// os.tmpdir()/ruyi-desktop-python-probe.v1.json(肯定 5 分钟、否定 10 分钟 TTL,与进程内那张表同一对数字),
// 下一个进程同键直接照答案来,不再逐个慢探。
//
// 覆盖(每条都在【子进程】里跑,因为要证的正是「换一个进程也不用再探」):
//   ① 冷缓存:一轮真探要付慢候选的钱(≥ SLOW_MS)
//   ② 同一个 TEMP 下第二个进程:同键 <SLOW_MS/3 就判没有,且结果仍是 null(不会把没有当成有)
//   ③ 磁盘文件形状:{version:1, entries:{<sha1>:{at, value:null}}} 恰一条
//   ④ 删掉磁盘文件 → 第三个进程又要真探(缓存是那个文件,不是别的什么)
//   ⑤ 否定条目过期(时间戳改成 11 分钟前)→ 真探;这时假 python 已「装好」(hit.flag)→ 探出来 →
//      同键条目换成肯定答案、过期垃圾条目一并清掉
//   ⑥ 测试口 options.probe 一律绕过磁盘:既不读(已有条目也照 probe 的答案)也不写
//   ⑦ 肯定答案也跨进程:把假 python 再「弄坏」(删 hit.flag),下一个进程仍拿到肯定答案且不真探
//      (这是与进程内 5 分钟 TTL 同一条既有语义,不是新引入的宽松化)
//   ⑧ 肯定答案的命令是绝对路径且已不存在 → 不信这条缓存,真探
const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..');
const SERVER = path.join(repo, 'ruyi-workbench', 'app', 'server.js');
const SLOW_MS = 900;

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-py-probe-cache-'));
  const slow = path.join(dir, 'slow-python.js');
  const flag = path.join(dir, 'hit.flag');
  // 装成一个 python:没有 hit.flag 时「启动很慢、然后导入失败」(忽略 -X utf8 -c 那串参数,睡够 SLOW_MS
  // 再以 1 退出);有 hit.flag 时立刻打出探针要的 __RUYI_ACC_CORE__ 并以 0 退出(=「后来装好了」)。
  fs.writeFileSync(slow, `
    const fs = require('fs');
    if (fs.existsSync(${JSON.stringify(flag)})) { process.stdout.write('__RUYI_ACC_CORE__'); process.exit(0); }
    setTimeout(() => process.exit(1), ${SLOW_MS});
  `);
  const child = path.join(dir, 'child.js');
  fs.writeFileSync(child, `
    const srv = require(${JSON.stringify(SERVER)});
    const mode = process.argv[2] || 'real';
    const root = ${JSON.stringify(path.join(dir, 'fake-repo'))};
    const candidates = [{ command: process.execPath, args: [${JSON.stringify(slow)}], source: 'slow-fake', requireExisting: false }];
    const options = { candidates };
    if (mode === 'probe-hit') options.probe = () => 'core';
    const t0 = Date.now();
    const value = srv.pickPython(root, { PYTHONPATH: '' }, options);
    process.stdout.write(JSON.stringify({ ms: Date.now() - t0, value: value ? value.source : null }));
  `);
  const temp = path.join(dir, 'temp');
  fs.mkdirSync(temp);
  fs.mkdirSync(path.join(dir, 'fake-repo'));   // probeDesktopPython 拿 root 当 cwd,目录不存在会 ENOENT 秒失败,测不到慢路径
  return { dir, child, flag, temp, cacheFile: path.join(temp, 'ruyi-desktop-python-probe.v1.json') };
}

function runChild(fx, mode) {
  const result = cp.spawnSync(process.execPath, [fx.child, mode || 'real'], {
    env: { ...process.env, TEMP: fx.temp, TMP: fx.temp, TMPDIR: fx.temp },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  assert.equal(result.status, 0, `child exited ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

function readCache(fx) {
  return JSON.parse(fs.readFileSync(fx.cacheFile, 'utf8'));
}

test('desktop python probe result is cached across processes (miss and hit, keyed, expiring, deletable, distrusts vanished commands)', () => {
  const fx = makeFixture();
  try {
    const cold = runChild(fx);
    assert.equal(cold.value, null, '① 慢候选探不出 → null');
    assert.ok(cold.ms >= SLOW_MS, `① 冷缓存要付慢候选的钱(实测 ${cold.ms}ms ≥ ${SLOW_MS})`);

    assert.ok(fs.existsSync(fx.cacheFile), '③ 磁盘缓存文件写在 os.tmpdir() 下');
    const parsed = readCache(fx);
    assert.equal(parsed.version, 1, '③ version:1');
    const ids = Object.keys(parsed.entries || {});
    assert.equal(ids.length, 1, '③ 恰一条');
    assert.match(ids[0], /^[0-9a-f]{40}$/, '③ 键是 sha1 hex');
    assert.equal(parsed.entries[ids[0]].value, null, '③ 否定条目 value:null');
    assert.ok(Number(parsed.entries[ids[0]].at) > Date.now() - 60000, '③ 时间戳是刚才');

    const warm = runChild(fx);
    assert.equal(warm.value, null, '② 命中缓存仍然是 null —— 没有就是没有');
    assert.ok(warm.ms < SLOW_MS / 3, `② 换一个进程同键不再真探(实测 ${warm.ms}ms < ${SLOW_MS / 3})`);

    const seam = runChild(fx, 'probe-hit');
    assert.equal(seam.value, 'slow-fake', '⑥ 测试口 probe 给肯定就选中 —— 磁盘上的否定条目不读');
    assert.equal(readCache(fx).entries[ids[0]].value, null, '⑥ 测试口也不写:否定条目原样留着');

    fs.rmSync(fx.cacheFile, { force: true });
    const again = runChild(fx);
    assert.ok(again.ms >= SLOW_MS, `④ 删掉文件就得再真探(实测 ${again.ms}ms ≥ ${SLOW_MS})`);

    // ⑤ 否定条目过期 + 假 python「装好」:真探 → 探出来 → 同键换成肯定答案、过期垃圾一并清掉。
    const expired = readCache(fx);
    const id = Object.keys(expired.entries)[0];
    expired.entries[id].at = Date.now() - 11 * 60 * 1000;
    expired.entries['0000000000000000000000000000000000000000'] = { at: Date.now() - 12 * 60 * 1000, value: null };
    fs.writeFileSync(fx.cacheFile, JSON.stringify(expired));
    fs.writeFileSync(fx.flag, '1');
    const installed = runChild(fx);
    assert.equal(installed.value, 'slow-fake', '⑤ 过期条目不算数,真探探出来了');
    assert.ok(installed.ms < SLOW_MS, `⑤ 探出来走的是快路径,不是睡满 SLOW_MS 的那条(实测 ${installed.ms}ms)`);
    const afterHit = readCache(fx);
    assert.deepEqual(Object.keys(afterHit.entries), [id], '⑤ 过期垃圾条目清掉,只剩同键这一条');
    assert.equal(afterHit.entries[id].value && afterHit.entries[id].value.source, 'slow-fake', '⑤ 同键条目换成了肯定答案');
    assert.equal(afterHit.entries[id].value.capability, 'core', '⑤ 连档位(core/full)一起记');

    // ⑦ 肯定答案也跨进程:把假 python 再弄坏,下一个进程仍拿到肯定答案,且没有真探(否则要睡满 SLOW_MS)。
    fs.rmSync(fx.flag, { force: true });
    const cachedHit = runChild(fx);
    assert.equal(cachedHit.value, 'slow-fake', '⑦ 肯定答案从磁盘来(5 分钟 TTL,与进程内同一条语义)');
    assert.ok(cachedHit.ms < SLOW_MS / 3, `⑦ 没有真探(实测 ${cachedHit.ms}ms < ${SLOW_MS / 3})`);

    // ⑧ 肯定答案的命令是绝对路径且已不存在 → 不信,真探(flag 已删,所以真探要睡满 SLOW_MS 且得 null)。
    const vanished = readCache(fx);
    vanished.entries[id].value.command = path.join(fx.dir, 'gone', 'python.exe');
    fs.writeFileSync(fx.cacheFile, JSON.stringify(vanished));
    const reprobed = runChild(fx);
    assert.equal(reprobed.value, null, '⑧ 命令没了就当没缓存,真探的答案是 null');
    assert.ok(reprobed.ms >= SLOW_MS, `⑧ 真探了(实测 ${reprobed.ms}ms ≥ ${SLOW_MS})`);
  } finally {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  }
});
