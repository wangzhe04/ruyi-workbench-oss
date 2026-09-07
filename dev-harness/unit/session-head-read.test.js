// Unit（117j 收尾）：会话头的【带瞬时重试】读取 `readSessionHeadResilient`。
//
// 它修的是一条实证定位到的真 bug：Windows 上 `rename(tmp, final)` 替换【已存在】的文件时，
// 并发的读会在「旧文件已解链、新文件还没链入」的那一瞬拿到 **ENOENT**。会话头每保存一次就开一个
// 这样的窗口，而回合跑起来时它一直在写。`decideIntervention` 里那一发单打的 readFile 因此会偶发
// 读空，把「文件正在被原子替换」误判成「这个会话不存在」，用户看到的是「答不进去」。
//
// 复现证据（steward-drawer.e2e 的 E4b，约 1/3 概率红）：打点抓到那一发抛的正是 ENOENT，而同一时刻
// `pendingQuestions.has(qid)` 仍为 true —— 待决好端端在那儿，只是读不到会话头。
//
// 本件三条：
//   ① 正常情况原样读回；
//   ② **文件在重试窗口内出现**（模拟 rename 的替换瞬间）→ 仍然读到，不再假 404；
//   ③ 真的不存在的会话仍然返回 null（重试不改变判据，只是多等 ~80ms）。
'use strict';
const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-session-head-read-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

const { readSessionHeadResilient } = srv;
const sessionsDir = path.join(root, 'sessions');
const headPath = id => path.join(sessionsDir, id + '.json');
const writeHead = (id, extra = {}) => {
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(headPath(id), JSON.stringify({ id, storageVersion: 2, title: 't', ...extra }, null, 2), 'utf8');
};

describe('readSessionHeadResilient', () => {
  it('① 正常会话原样读回', async () => {
    writeHead('sess_plain', { title: '正常' });
    const head = await readSessionHeadResilient('sess_plain');
    assert.equal(head && head.id, 'sess_plain');
    assert.equal(head && head.title, '正常');
  });

  it('② 文件在重试窗口内出现（rename 替换的那一瞬）→ 仍然读到，不再假 404', async () => {
    const id = 'sess_race';
    writeHead(id, { title: '被替换中' });
    // 模拟 rename 的替换瞬间：先把文件挪走（此刻任何读都是 ENOENT），~20ms 后再放回去。
    const stash = headPath(id) + '.stash';
    await fsp.rename(headPath(id), stash);
    const restore = setTimeout(() => { try { fs.renameSync(stash, headPath(id)); } catch { /* ignore */ } }, 20);
    const head = await readSessionHeadResilient(id);
    clearTimeout(restore);
    assert.ok(head, '重试窗口内文件回来了就应该读到（单发 readFile 在这里会返回 null，那正是 E4b 那条 flake）');
    assert.equal(head.id, id);
  });

  it('③ 真的不存在的会话仍然返回 null（判据不变，只是多等一会儿）', async () => {
    const started = Date.now();
    const head = await readSessionHeadResilient('sess_never_existed');
    assert.equal(head, null);
    // 四次重试的退避是 5+15+25+35=80ms；给足余量，只确认它确实退避过而不是立刻放弃。
    assert.ok(Date.now() - started >= 60, `应当退避重试过（实测 ${Date.now() - started}ms）`);
  });

  it('④ 内容坏掉不重试（那是隔离路径的事，重试只会把坏内容读四遍）', async () => {
    const id = 'sess_corrupt';
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(headPath(id), '{ this is not json', 'utf8');
    const started = Date.now();
    assert.equal(await readSessionHeadResilient(id), null);
    assert.ok(Date.now() - started < 60, '解析失败要立刻返回，不该走退避');
  });
});

describe('loadSession：并发写盘时绝不做破坏性动作', () => {
  // 这一组钉的是同一条 bug 的另一半，也是更严重的那一半：
  // loadSession 的两个破坏性动作（截断「未提交尾巴」、把会话隔离成 .corrupt）判据是
  // 「头声明的行数 vs 正文实际行数」，而头与正文是**先后两次**读进来的。saveSession 的写链里
  // 正文先落、头后落 —— 一次并发的 loadSession 正好落在中间，就会拿【旧头】去量【新正文】，
  // 把刚写进去的那一行当成崩溃残留**物理截断**；下一次 load 再看到「头说 1、正文 0」，
  // 整条会话被隔离成 .corrupt。实证打点：`TRUNCATE from=1 to=0` 紧跟着 `QUARANTINE headMsg=1 body=0`。
  //
  // ⚠ 诚实说明：下面这条【不是】那条竞态的可靠复现 —— 实测把写链守卫关掉它照样绿（要精确卡进
  // saveSession 内部「正文已落、头未落」那一格，从外部 API 命不中）。它断言的是那条不变量本身
  // （并发读回来的会话必须完整），有价值但没牙。真正的证据是带打点的 e2e 连跑：修前
  // TRUNCATE/QUARANTINE 必现、修后 5 连跑一次都没有。守卫本身由下面那一组【源码锁】机械看住。
  it('并发 save 期间读同一条会话：结果必须完整（不变量断言，不是竞态复现）', async () => {
    const created = await srv.createSession({ title: '并发', cwd: root });
    created.messages = [{ role: 'user', content: '第一句', createdAt: new Date().toISOString() }];
    created.providerHistory = [{ role: 'user', content: '第一句' }];
    await srv.saveSession(created);

    created.messages.push({ role: 'assistant', content: '第二句', createdAt: new Date().toISOString() });
    created.providerHistory.push({ role: 'assistant', content: '第二句' });
    const saving = srv.saveSession(created);          // 故意不 await
    const racing = await srv.loadSession(created.id); // 与它抢同一条会话
    await saving;

    assert.ok(racing, '并发读不得把一条好端端的会话判成损坏（修前这里会拿到 null）');
    const after = await srv.loadSession(created.id);
    assert.ok(after, '会话必须还在（修前它会被隔离成 .corrupt）');
    assert.equal(after.messages.length, 2, '正文一行都不许被截掉');
    assert.equal(after.providerHistory.length, 2);
    assert.ok(!fs.existsSync(path.join(sessionsDir, created.id + '.json.corrupt')), '不得留下隔离文件');
  });
});

describe('两道守卫的源码锁（把「不许在并发写盘时动手」钉住，防回改）', () => {
  const store = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '02-session-store.js'), 'utf8');
  const routes = fs.readFileSync(path.join(repo, 'ruyi-workbench', 'app', 'src', '13d-core-domain-routes.js'), 'utf8');

  it('守卫①：写链在跑就等它跑完再重来，绝不截断/隔离', () => {
    assert.ok(/const inFlight = sessionWriteChains\.get\(id\);/.test(store)
      && /await inFlight\.catch\(\(\) => \{\}\);/.test(store)
      && /return loadSession\(id, reloadDepth \+ 1\);/.test(store),
    '这一条是真正起作用的那道守卫：只重读头不够（写链里正文先落、头后落，重读拿到的仍是旧头）');
  });

  it('守卫②：动手前把头再读一遍，头变了就重来', () => {
    assert.ok(/const again = await readSessionHeadResilient\(id\);/.test(store)
      && /if \(reloadDepth >= 1\) return null;/.test(store),
      '有界重来：连着两次都在写就诚实地不给结果，绝不用一次可疑的读去删数据');
  });

  it('守卫③：decideIntervention 的头读走带重试的那一个', () => {
    assert.ok(/const head = await readSessionHeadResilient\(missionId\);/.test(routes)
      && !/readFile\(sessionPath\(missionId\)/.test(routes),
      '它是用户动作的判定入口：读空一次就等于把「允许／回答」判成 404「会话不存在」');
  });

  it('守卫④：重试只认瞬时错误，解析失败仍然立刻放手', () => {
    assert.ok(/SESSION_HEAD_TRANSIENT = new Set\(\['ENOENT', 'EPERM', 'EBUSY', 'EACCES'\]\)/.test(store),
      '内容坏了归隔离路径管，重试只会把坏内容读四遍');
  });
});

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });
