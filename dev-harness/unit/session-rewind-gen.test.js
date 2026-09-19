// Unit(107-F7b):撤回代数闸 —— 撤回之前攥在手里的会话副本写不回去,撤回之后新读的照常落盘。
//
// 它修的是一条冻结树上全量 exit 1 的真缺陷(steward-conversation.e2e 的 G4,负载下 4/20):用户递话后
// 立刻点「撤回」,撤回回 ok:true,前端显示「✓ 已撤回」,消息却还在。取证:撤回那一存无条件写
// providerHistoryCursor=0,盘上却是 2 —— 撤回那一存被一个【撤回之前就攥在手里】的会话对象整份盖回。
// 修法是 02-session-store.js 的 sessionRewindGenHighWater(头注在那里),本件把它的每条承诺钉成可复现的读数。
//
// 为什么放 unit 而不是 e2e:这是会话存储层的不变量,直接调 loadSession/saveSession/rewindSession 就能
// 【确定性】摆出每一种交错(需要「卡在某一步」的地方用 fs/promises 的钩子卡住,不靠负载碰运气);而且
// unit 在 run-all 的快通道里、挂即拒跑 e2e —— 丢数据方向的回归应当最先、最响地拦下来。
// 负载下的真复现另由 steward-conversation.e2e 的 G4 承担(那条要浏览器与真回合)。
//
// 九条:
//   A 承重:撤回之前拿到的副本 X,撤回之后 save(X) → 盘上仍是截断后的状态,且记了丢弃日志;
//   B 反方向(最要紧):撤回之后新读 Y、追加一条、save(Y) → 落盘了;
//   C 从没撤回过的会话照常存,头上也不多出 rewindGen 这个字段(存量会话逐字节不变);
//   D 连续两次撤回:两代旧副本都写不回去,之后新读的照常存;
//   E 模拟重启(子进程 = 高水位表为空):新读的照常存;重启后再撤回,撤回前读的那份仍被挡;
//   F updateSessionMeta 的读改写撞上撤回:正文不被盖回,补丁本身在新副本上重放、不丢;
//   G loadSession 自愈:读落在「水位已抬、撤回那一存还没落盘」的窗口里 → 等它落盘再交出去;
//   H 撤回那一存自己落盘失败 → 水位退回,之后新读的照常存(否则整条会话此后每一次存都会被丢);
//   I 两次撤回交错,先读后存的那一次截断建在旧正文上 → 不许落盘,如实回 rewind_superseded。
'use strict';

// ── E 的子进程分支:必须在 require('node:test') 之前,子进程里一个测试都不注册 ─────────────────
if (process.env.RUYI_F7B_CHILD) {
  const path = require('path');
  const srv = require(path.join(path.resolve(__dirname, '../..'), 'ruyi-workbench', 'app', 'server.js'));
  (async () => {
    const id = process.env.RUYI_F7B_CHILD;
    const out = {};
    // E1:重启之后新读的对象(代数来自盘上,高水位表为空)照常存。
    const y = await srv.loadSession(id);
    out.loadedGen = y && y.rewindGen;
    out.loadedCount = y && y.messages.length;
    y.messages.push({ role: 'user', content: '重启之后说的第一句', turnSeq: 2, createdAt: new Date().toISOString() });
    y.providerHistory.push({ role: 'user', content: '重启之后说的第一句' });
    await srv.saveSession(y);
    out.afterE1 = (await srv.loadSession(id)).messages.length;
    // E2:重启之后再撤回一次 —— 撤回前读的那份 X 仍被挡(新代数要从盘上的代数往上抬,不能从空表的 0 起)。
    const x = await srv.loadSession(id);
    const r = await srv.rewindSession(id, 2, false);
    out.rewindOk = !!(r && r.ok);
    x.messages.push({ role: 'assistant', content: '垂死回合的收尾', turnSeq: 2, createdAt: new Date().toISOString() });
    await srv.saveSession(x);
    out.afterE2 = (await srv.loadSession(id)).messages.length;
    process.stdout.write('F7B-CHILD ' + JSON.stringify(out) + '\n');
    process.exit(0);
  })().catch(error => { process.stdout.write('F7B-CHILD-ERROR ' + String(error && error.stack || error) + '\n'); process.exit(1); });
  return;   // CommonJS 模块体允许顶层 return:子进程到此为止
}

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');   // 与 server.js 里的 fsp 是同一个对象 —— 钩子装在它的属性上
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rewind-gen-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

const sessionsDir = path.join(root, 'sessions');
const logsDir = path.join(root, 'logs');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowIso = () => new Date().toISOString();

// 造一条有 N 个回合的会话(每回合一问一答,都带 turnSeq —— rewindSession 按它定位),落盘后返回 id。
async function seed(turns) {
  const s = await srv.createSession({ title: 'F7b', cwd: root });
  s.messages = [];
  s.providerHistory = [];
  for (let t = 1; t <= turns; t++) {
    s.messages.push({ role: 'user', content: `第${t}句`, turnSeq: t, createdAt: nowIso() });
    s.messages.push({ role: 'assistant', content: `答${t}`, turnSeq: t, turnSummary: { turnSeq: t }, createdAt: nowIso() });
    s.providerHistory.push({ role: 'user', content: `第${t}句` }, { role: 'assistant', content: `答${t}` });
  }
  s.turnSeq = turns;
  s.providerHistoryCursor = s.messages.length;
  await srv.saveSession(s);
  // createSession 的对象缺 todos/skills/memories 等字段,第一次 load 会归一并顺手存一次。先在这里把它
  // 做掉,让下面每条用例里的 load 都是「不写盘」的纯读 —— 否则那一存会先吃掉装在 fs 上的一次性卡子。
  await srv.loadSession(s.id);
  return s.id;
}

// 盘上的真相:直接读文件,不经 loadSession(它有自愈,会替被测对象遮丑)。
function disk(id) {
  const head = JSON.parse(fs.readFileSync(path.join(sessionsDir, id + '.json'), 'utf8'));
  const body = fs.readFileSync(path.join(sessionsDir, id + '.messages.ndjson'), 'utf8');
  return { head, lines: body.split('\n').filter(Boolean).map(line => JSON.parse(line)) };
}

// 日志是流式写的:轮询到那一行出现为止(有界 3 秒)。
async function logRows(kind, sessionId) {
  for (let i = 0; i < 60; i++) {
    const rows = [];
    for (const name of (fs.existsSync(logsDir) ? fs.readdirSync(logsDir) : [])) {
      for (const line of fs.readFileSync(path.join(logsDir, name), 'utf8').split('\n')) {
        if (!line) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row && row.kind === kind && row.sessionId === sessionId) rows.push(row);
      }
    }
    if (rows.length) return rows;
    await sleep(50);
  }
  return [];
}

// 在 fs/promises 的某个方法上装一次性卡子:第一次命中 match 时先报到(reached),再等放行(release)
// 或直接抛(throwError)。命中之后自动卸除,别的调用原样透传。
function hook(method, match, { throwError } = {}) {
  const original = fsp[method];
  let armed = true;
  let reachedResolve;
  const reached = new Promise(r => { reachedResolve = r; });
  let releaseResolve;
  const gate = new Promise(r => { releaseResolve = r; });
  fsp[method] = async function (...args) {
    if (armed && match(...args)) {
      armed = false;
      reachedResolve();
      if (throwError) throw throwError;
      await gate;
    }
    return original.apply(this, args);
  };
  return {
    reached,
    release: () => releaseResolve(),
    restore: () => { fsp[method] = original; releaseResolve(); },
  };
}
const same = (a, b) => path.resolve(String(a)).toLowerCase() === path.resolve(String(b)).toLowerCase();
// 等卡子被踩到;被测那一发若在踩到之前就结束了(或 10 秒都没踩到),立刻判红,不许挂死整个快通道。
async function untilReached(h, other, label) {
  let timer;
  try {
    await Promise.race([
      h.reached,
      Promise.resolve(other).then(
        () => { throw new Error(`${label}:卡子没被踩到,被测那一发就已经结束了(交错没摆出来)`); },
        error => { throw new Error(`${label}:卡子没被踩到,被测那一发就已经失败了:${error && error.message}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}:10 秒没踩到卡子`)), 10000); }),
    ]);
  } finally { clearTimeout(timer); }
}

describe('撤回代数闸(107-F7b)', () => {
  it('A 承重:撤回之前拿到的副本,撤回之后再存 → 被丢,盘上仍是截断后的状态', async () => {
    const id = await seed(1);
    const x = await srv.loadSession(id);             // 垂死回合手里那一份:2 条、游标 2
    assert.equal(x.messages.length, 2);
    const r = await srv.rewindSession(id, 1, false);
    assert.ok(r && r.ok, `撤回本身要成功(实得 ${JSON.stringify(r)})`);
    assert.equal(r.removedTurns, 2);
    x.providerHistoryCursor = 2;                     // 与红轮盘上那份头同形
    await srv.saveSession(x);                        // 修前:这一存把撤回整份盖回
    const d = disk(id);
    assert.equal(d.lines.length, 0, `正文必须仍是截断后的 0 行(实得 ${d.lines.length} 行 —— 撤回被旧副本盖回了)`);
    assert.equal(d.head.messageCount, 0, '头声明的条数也必须是 0');
    assert.equal(d.head.providerHistoryCursor, 0, `头上的游标必须是撤回写的 0(实得 ${d.head.providerHistoryCursor};红轮盘上正是 2)`);
    assert.equal(d.head.rewindGen, 1, '撤回那一存把代数抬到了 1');
    const dropped = await logRows('session_stale_save_dropped', id);
    assert.ok(dropped.length >= 1, '被丢的那一存必须留痕(session_stale_save_dropped)');
    assert.equal(dropped[0].staleGen, 0);
    assert.equal(dropped[0].highWater, 1);
    assert.equal(dropped[0].messageCount, 2, '日志里记的是那份旧副本的条数,事后能对账');
  });

  it('B 反方向(最要紧):撤回之后新读的副本,追加一条再存 → 落盘了', async () => {
    const id = await seed(1);
    const r = await srv.rewindSession(id, 1, false);
    assert.ok(r && r.ok);
    const y = await srv.loadSession(id);
    assert.equal(y.messages.length, 0, '新读的就是撤回之后的状态');
    y.messages.push({ role: 'user', content: '撤回之后重新说的一句', turnSeq: 2, createdAt: nowIso() });
    y.providerHistory.push({ role: 'user', content: '撤回之后重新说的一句' });
    await srv.saveSession(y);
    const d = disk(id);
    // 先断「落盘了」这一条(它才是本件要守的那一侧),代数字段放在后面 —— 反向验证时红在哪一条就是理由。
    assert.equal(d.lines.length, 1, `撤回之后新写的那一条必须落盘(实得 ${d.lines.length} 行 —— 正常的存盘被当成陈旧丢了 = 静默丢用户数据)`);
    assert.equal(d.lines[0].content, '撤回之后重新说的一句');
    assert.equal(d.head.messageCount, 1);
    assert.equal((await srv.loadSession(id)).messages.length, 1, '再读一次也是 1 条');
    assert.equal(y.rewindGen, 1, '新读的副本带着新代数');
  });

  it('C 从没撤回过的会话照常存,头上也不多出 rewindGen', async () => {
    const id = await seed(1);
    const s = await srv.loadSession(id);
    s.messages.push({ role: 'user', content: '第2句', turnSeq: 2, createdAt: nowIso() });
    s.providerHistory.push({ role: 'user', content: '第2句' });
    await srv.saveSession(s);
    const d = disk(id);
    assert.equal(d.lines.length, 3, `从没撤回过的会话,存什么落什么(实得 ${d.lines.length} 行)`);
    assert.ok(!Object.prototype.hasOwnProperty.call(d.head, 'rewindGen'), '没撤回过的会话头上不出现 rewindGen(存量会话逐字节不变)');
  });

  it('D 连续两次撤回:两代旧副本都写不回去,之后新读的照常存', async () => {
    const id = await seed(2);                        // 4 条:两问两答
    const x = await srv.loadSession(id);             // 第一次撤回之前的副本(4 条)
    let r = await srv.rewindSession(id, 2, false);
    assert.ok(r && r.ok);
    assert.equal(disk(id).lines.length, 2);
    const y = await srv.loadSession(id);             // 两次撤回之间的副本(2 条,代数 1)
    assert.equal(y.rewindGen, 1);
    r = await srv.rewindSession(id, 1, false);
    assert.ok(r && r.ok);
    assert.equal(disk(id).head.rewindGen, 2, '第二次撤回把代数抬到 2');
    await srv.saveSession(x);
    await srv.saveSession(y);
    let d = disk(id);
    assert.equal(d.lines.length, 0, `两代旧副本都不许写回(实得 ${d.lines.length} 行 —— 第二次撤回被第一、二次之间读的副本盖回了)`);
    const z = await srv.loadSession(id);
    z.messages.push({ role: 'user', content: '两次撤回之后说的', turnSeq: 3, createdAt: nowIso() });
    z.providerHistory.push({ role: 'user', content: '两次撤回之后说的' });
    await srv.saveSession(z);
    d = disk(id);
    assert.equal(d.lines.length, 1, '两次撤回之后新读的照常落盘');
  });

  it('E 模拟重启(子进程 = 高水位表为空):新读的照常存;重启后再撤回,撤回前读的那份仍被挡', async () => {
    const id = await seed(1);
    const r = await srv.rewindSession(id, 1, false);
    assert.ok(r && r.ok);
    assert.equal(disk(id).head.rewindGen, 1);
    // 128f-⑫:子进程用【异步】起、等它退出,不用 spawnSync。本进程里的服务在撤回之后还有后台读(推送层现算那一行
    // 要读会话头);spawnSync 把事件循环冻住时,那一发读只走完「打开文件」,读与关要等循环回来 —— 句柄就一直开着,
    // 子进程往同一个会话头 rename 在 Windows 上 8 次重试全是 EPERM(本件第一轮实测)。断言一条没改。
    const child = await new Promise(resolve => {
      const proc = cp.spawn(process.execPath, [__filename], {
        windowsHide: true, timeout: 60000,
        env: { ...process.env, RUYI_F7B_CHILD: id, RUYI_HOME: root, WIN_CLAUDE_WORKBENCH_HOME: root },
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', d => { stdout += d; });
      proc.stderr.on('data', d => { stderr += d; });
      proc.on('close', status => resolve({ status, stdout, stderr }));
      proc.on('error', error => resolve({ status: null, stdout, stderr: stderr + String(error && error.message || error) }));
    });
    const line = String(child.stdout || '').split('\n').find(l => l.startsWith('F7B-CHILD '));
    assert.ok(line, `子进程要交回读数(exit=${child.status} stdout=${String(child.stdout || '').slice(-400)} stderr=${String(child.stderr || '').slice(-400)})`);
    const out = JSON.parse(line.slice('F7B-CHILD '.length));
    assert.equal(out.loadedGen, 1, '重启后读到的代数来自盘上');
    assert.equal(out.loadedCount, 0);
    assert.equal(out.afterE1, 1, `E1 重启之后新读的对象照常存(实得 ${out.afterE1} 条 —— 空表却把新副本当成陈旧丢了)`);
    assert.ok(out.rewindOk, '重启之后再撤回一次要成功');
    assert.equal(out.afterE2, 0, `E2 重启之后,撤回前读的那份仍被挡(实得 ${out.afterE2} 条 —— 新代数从空表的 0 起算,没高过盘上的 1)`);
    const d = disk(id);
    assert.equal(d.lines.length, 0);
    assert.equal(d.head.rewindGen, 2, '重启之后的撤回从盘上的 1 往上抬到 2');
  });

  it('F updateSessionMeta 读改写撞上撤回:正文不被盖回,补丁在新副本上重放、不丢', async () => {
    const id = await seed(1);
    // 卡子装在 saveSession 的 ensureDirs 上:updateSessionMeta 已经 load 完(撤回之前的副本),卡在入链之前。
    const h = hook('mkdir', p => same(p, sessionsDir));
    try {
      const metaP = srv.updateSessionMeta(id, { title: '撤回时改的名字' });
      await untilReached(h, metaP, 'F');
      const r = await srv.rewindSession(id, 1, false);   // 卡子已卸,撤回照常落盘(代数 1)
      assert.ok(r && r.ok);
      h.release();                                       // 放行:那份旧副本现在才入链
      const out = await metaP;
      const d = disk(id);
      assert.equal(d.lines.length, 0, `正文必须仍是撤回之后的 0 行(实得 ${d.lines.length} —— 元数据那份旧副本把撤回盖回了,F7b 本身)`);
      assert.equal(d.head.title, '撤回时改的名字', `补丁本身不许跟着丢(实得标题「${d.head.title}」—— 丢掉旧副本时没有在新副本上重放)`);
      assert.equal(out && out.messages.length, 0, '返回给调用方的是重放后的那一份,不是撤回之前的');
      const replayed = await logRows('session_meta_replayed', id);
      assert.ok(replayed.length >= 1, '重放要留痕(session_meta_replayed)');
    } finally { h.restore(); }
  });

  it('G loadSession 自愈:读落在「水位已抬、撤回那一存还没落盘」的窗口里 → 等它落盘再交出去', async () => {
    const id = await seed(1);
    // 卡在撤回那一存的第一步落盘(正文换名)上:此刻水位已抬,盘上仍是完整一致的旧状态(头 2 条、正文 2 行)。
    const h = hook('rename', (from, to) => same(to, path.join(sessionsDir, id + '.messages.ndjson')));
    try {
      const rewindP = srv.rewindSession(id, 1, false);
      await untilReached(h, rewindP, 'G');
      const loadP = srv.loadSession(id);
      const early = await Promise.race([loadP.then(s => ({ s })), sleep(300).then(() => null)]);
      h.release();
      const r = await rewindP;
      assert.ok(r && r.ok);
      const loaded = early ? early.s : await loadP;
      assert.equal(loaded.messages.length, 0, `撤回已经开始落盘之后才来读的人,不许拿到撤回之前的状态(实得 ${loaded.messages.length} 条 —— 这份副本之后的每一次存都会被闸丢掉)`);
      assert.equal(loaded.rewindGen, 1);
      assert.equal(early, null, '它确实等了撤回那一存(卡子放行之前没有交出结果)');
    } finally { h.restore(); }
  });

  it('H 撤回那一存自己落盘失败 → 水位退回,之后新读的照常存', async () => {
    const id = await seed(1);
    const boom = Object.assign(new Error('injected EIO on head rename'), { code: 'EIO' });
    const h = hook('rename', (from, to) => same(to, path.join(sessionsDir, id + '.json')), { throwError: boom });
    try {
      await assert.rejects(srv.rewindSession(id, 1, false), /injected EIO/, '头没写上,撤回就是失败(不许回 ok:true)');
    } finally { h.restore(); }
    const y = await srv.loadSession(id);            // 盘上仍是撤回之前(loadSession 从 .prevbody 恢复正文)
    assert.equal(y.messages.length, 2, '撤回没落上:会话仍是撤回之前的样子');
    y.messages.push({ role: 'user', content: '撤回失败之后接着说', turnSeq: 2, createdAt: nowIso() });
    y.providerHistory.push({ role: 'user', content: '撤回失败之后接着说' });
    await srv.saveSession(y);
    const d = disk(id);
    assert.equal(d.lines.length, 3, `撤回失败之后新读的必须照常落盘(实得 ${d.lines.length} 行 —— 水位没退回,此后这条会话每一次存都会被丢)`);
  });

  it('I 两次撤回交错:先读后存的那一次截断建在旧正文上 → 不许落盘,如实回 rewind_superseded', async () => {
    const id = await seed(2);                         // 4 条:两问两答
    // B(撤到第 2 回合,留 2 条)先读完、卡在自己那一存入链之前;A(撤到第 1 回合,留 0 条)随后完整跑完。
    const h = hook('mkdir', p => same(p, sessionsDir));
    let b;
    try {
      const bP = srv.rewindSession(id, 2, false);
      await untilReached(h, bP, 'I');
      const a = await srv.rewindSession(id, 1, false);
      assert.ok(a && a.ok, `后到的那次撤回照常成功(实得 ${JSON.stringify(a)})`);
      h.release();
      b = await bP;
    } finally { h.restore(); }
    const d = disk(id);
    assert.equal(d.lines.length, 0, `盘上必须是最后落盘那一次撤回的结果 0 行(实得 ${d.lines.length} 行 —— 先读后存的那次撤回把第 1 回合带回来了)`);
    assert.ok(b && b.ok === false && b.error === 'rewind_superseded', `被顶掉的那次撤回不许说 ok:true(实得 ${JSON.stringify(b)})`);
    assert.equal(d.head.rewindGen, 1, '被顶掉的那次撤回没有抬代数');
  });
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
