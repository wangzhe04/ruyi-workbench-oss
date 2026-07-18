// E2E (v1.9 第二波): 会话存储 v2(head JSON + append-only NDJSON 正文)+ 引擎转录 GC。
// 三层:
//   (A) 会话存储 v2(require server.js,临时 RUYI_HOME):
//       ① legacy 单文件懒迁移(head+v2 正文+v1bak);  ② v2 回读一致 + v1bak 自动清理;
//       ③ 快路径 append(前缀字节不变);  ④ 零增长 save 不碰正文;  ⑤ 前缀改写 → 全量重写;
//       ⑥ 撕裂尾行物理截断修复(防「焊行」丢数据);  ⑦ 中间行损坏 → v1bak 回退;
//       ⑧ 无备份损坏 → .corrupt 隔离;  ⑨ deleteSession 全载体清理;  ⑩ 头是提交点(未提交尾巴截断)。
//   (B) 引擎转录 GC(WCW_CLAUDE_PROJECTS_DIR 重定向):
//       ① dirKey 映射;  ② saveSession 自动登记白名单账本;  ③ 策略 clamp;
//       ④ sweep 语义:活引用保护/超期删除+侧录连带/新文件保留/账本外文件绝不碰(红线)/脏账本除名;
//       ⑤ engineTranscriptDays=0 → 不动。
//   (C) 集成(真 boot 子进程): summary 带默认转录策略; policy 越界 clamp 并持久; clean target 生效。
// Judgement line (exact): SESSION-STORAGE-V2 E2E: ALL PASS
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HOME = path.join(os.tmpdir(), 'wcw-session-v2-e2e');
const PROJ = path.join(os.tmpdir(), 'wcw-session-v2-e2e-projects');
const { getFreePort } = require('./free-port.js');

// Env MUST be set before requiring server.js (paths.* derives from RUYI_HOME at module load).
fs.rmSync(HOME, { recursive: true, force: true });
fs.rmSync(PROJ, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });
process.env.RUYI_HOME = HOME;
process.env.WCW_CLAUDE_PROJECTS_DIR = PROJ; // claudeProjectsRoot() 每次调用现读,require 前后设均可
const srv = require(path.join(WB, 'app', 'server.js'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const SESS = () => path.join(HOME, 'sessions');
const sPath = id => path.join(SESS(), id + '.json');
const readLines = p => fs.readFileSync(p, 'utf8').split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''));
const oldMtime = p => { const t = new Date('2020-01-01T00:00:00Z'); fs.utimesSync(p, t, t); };

// 写一份 legacy(v1)单文件会话夹具
function seedLegacy(id, messages, providerHistory, extra) {
  fs.mkdirSync(SESS(), { recursive: true });
  const obj = {
    schemaVersion: 3, id, title: 'legacy-' + id, cwd: 'E:\\proj',
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
    messages, providerHistory, ...(extra || {}),
  };
  fs.writeFileSync(sPath(id), JSON.stringify(obj, null, 2));
  return obj;
}

// ---- http helpers(与 storage-steward.e2e 同款)-----------------------------------------------------------
function reqJson(port, method, p, headers, body) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { ...(headers || {}), ...(body ? { 'content-type': 'application/json' } : {}) }, timeout: 4000 }, res => {
      let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch { resolve({ status: res.statusCode, body: null }); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const getJson = (port, p, headers) => reqJson(port, 'GET', p, headers);
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
async function startServer(port) {
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(port)], {
    cwd: WB, windowsHide: true,
    env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, USERPROFILE: HOME, HOME, RUYI_HOME: HOME },
  });
  wb.stdout.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb] ' + l.trim())));
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  let h = null; for (let i = 0; i < 40 && !(h && h.body && h.body.ok); i++) { await sleep(150); h = await getJson(port, '/health'); }
  return { wb, h };
}
async function stopServer(wb) { if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } await sleep(300); }

(async () => {
  let fail = 0;
  let wb = null;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  try {
    // ============================== (A) 会话存储 v2 ==============================
    // A1: legacy 懒迁移 —— load 一次 → head(v2)+ 两个正文 + v1bak(原文备份)
    const legacy1 = seedLegacy('s1',
      [{ role: 'user', content: 'm1' }, { role: 'assistant', content: 'm2' }, { role: 'user', content: 'm3' }],
      [{ role: 'user', content: 'p1' }, { role: 'assistant', content: 'p2' }]);
    const bp1 = srv.sessionBodyPaths('s1');
    const s1 = await srv.loadSession('s1');
    ok(s1 && s1.messages.length === 3 && s1.providerHistory.length === 2, '(A1a) legacy 会话读回(messages=3, providerHistory=2)');
    const head1 = JSON.parse(fs.readFileSync(sPath('s1'), 'utf8'));
    ok(head1.storageVersion === 2 && head1.messageCount === 3 && head1.providerHistoryCount === 2 && !('messages' in head1),
      '(A1b) 头已转 v2(标记+计数+不带正文)— ' + JSON.stringify({ v: head1.storageVersion, mc: head1.messageCount }));
    ok(fs.existsSync(bp1.messages) && readLines(bp1.messages).length === 3 && readLines(bp1.provider).length === 2,
      '(A1c) 两个 NDJSON 正文已落盘(3 行 / 2 行)');
    const bak1 = JSON.parse(fs.readFileSync(sPath('s1') + '.v1bak', 'utf8'));
    ok(Array.isArray(bak1.messages) && bak1.messages.length === 3 && !bak1.storageVersion, '(A1d) v1bak 是 legacy 原文备份');

    // A2: v2 回读一致 + v1bak 自动清理
    const s1b = await srv.loadSession('s1');
    ok(s1b && JSON.stringify(s1b.messages.map(m => m.content)) === JSON.stringify(['m1', 'm2', 'm3']),
      '(A2a) v2 回读消息内容一致');
    ok(!fs.existsSync(sPath('s1') + '.v1bak'), '(A2b) v2 成功读取后 v1bak 自动清除');

    // A3: 快路径 —— 追加 1 条,前 3 行字节不变
    const bytesBefore = fs.readFileSync(bp1.messages, 'utf8');
    s1b.messages.push({ role: 'assistant', content: 'm4' });
    await srv.saveSession(s1b);
    const bytesAfter = fs.readFileSync(bp1.messages, 'utf8');
    ok(bytesAfter.startsWith(bytesBefore) && readLines(bp1.messages).length === 4,
      '(A3) 快路径 append:前 3 行字节不动,仅追加 1 行');

    // A4: 零增长 save —— 正文文件字节不动(只有头重写)
    const bytes4 = fs.readFileSync(bp1.messages, 'utf8');
    await srv.saveSession(s1b);
    ok(fs.readFileSync(bp1.messages, 'utf8') === bytes4, '(A4) 零增长 save 不触碰正文文件');

    // A5: 前缀改写(蒸发/压缩式中间修改)→ 全量重写,行数不变、中间行内容更新
    s1b.messages[1].content = 'm2-rewritten';
    await srv.saveSession(s1b);
    const lines5 = readLines(bp1.messages);
    ok(lines5.length === 4 && JSON.parse(lines5[1]).content === 'm2-rewritten',
      '(A5) 前缀改写触发全量重写(行数=4,第 2 行已更新)');

    // A6: 撕裂尾行 —— 物理截断修复,后续 append 不「焊行」
    fs.appendFileSync(bp1.messages, '{"role":"user","content":"TORN'); // 无换行的半行(模拟 append 崩溃中途)
    const s1c = await srv.loadSession('s1');
    ok(s1c && s1c.messages.length === 4 && readLines(bp1.messages).length === 4,
      '(A6a) 撕裂尾行被截断修复(读回 4 条,文件回 4 行)');
    s1c.messages.push({ role: 'user', content: 'm5' });
    await srv.saveSession(s1c);
    const s1d = await srv.loadSession('s1');
    ok(s1d && s1d.messages.length === 5 && s1d.messages[4].content === 'm5' && readLines(bp1.messages).length === 5,
      '(A6b) 截断后继续 append 无焊行:m5 完整可读(防回归:撕裂字节+新行合并 → corrupt 丢数据)');

    // A7: 中间行损坏 + v1bak 在 → 备份回退
    const legacy2 = seedLegacy('s2', [{ role: 'user', content: 'x1' }, { role: 'assistant', content: 'x2' }], []);
    const bp2 = srv.sessionBodyPaths('s2');
    await srv.loadSession('s2'); // 迁移(只 load 一次,v1bak 保留)
    ok(fs.existsSync(sPath('s2') + '.v1bak'), '(A7a) 迁移后 v1bak 在场');
    const good2 = readLines(bp2.messages);
    fs.writeFileSync(bp2.messages, 'BROKEN{not-json\n' + good2[1] + '\n'); // 中间行(第 1 行)写坏
    const s2b = await srv.loadSession('s2');
    ok(s2b && s2b.messages.length === 2 && s2b.messages[0].content === legacy2.messages[0].content && s2b.messages[1].content === 'x2',
      '(A7b) 中间行损坏 → v1bak 回退,原始消息完整恢复');
    const s2c = await srv.loadSession('s2');
    ok(s2c && s2c.messages.length === 2, '(A7c) 回退后重建的 v2 可正常再读');

    // A8: 中间行损坏 + 无 v1bak → 隔离(不丢现场,不再 500)
    seedLegacy('s3', [{ role: 'user', content: 'y1' }, { role: 'assistant', content: 'y2' }], []);
    const bp3 = srv.sessionBodyPaths('s3');
    await srv.loadSession('s3');  // 迁移
    await srv.loadSession('s3');  // 第二次读取 → v1bak 清除
    ok(!fs.existsSync(sPath('s3') + '.v1bak'), '(A8a) 前置:v1bak 已清(无备份可退)');
    const good3 = readLines(bp3.messages);
    fs.writeFileSync(bp3.messages, 'GARBAGE\n' + good3[1] + '\n');
    const s3b = await srv.loadSession('s3');
    ok(s3b === null, '(A8b) 无备份损坏 → loadSession 返回 null');
    ok(fs.existsSync(sPath('s3') + '.corrupt') && fs.existsSync(bp3.messages + '.corrupt'),
      '(A8c) 头与坏正文均已 .corrupt 隔离(留取证,不删)');

    // A9: deleteSession 清理全部载体
    await srv.deleteSession('s1');
    ok(!fs.existsSync(sPath('s1')) && !fs.existsSync(bp1.messages) && !fs.existsSync(bp1.provider),
      '(A9) deleteSession 连带删除头与两个正文');

    // A10: 头是提交点 —— 正文比头声明多 = 未提交尾巴,截断到头计数
    seedLegacy('s4', [{ role: 'user', content: 'z1' }, { role: 'assistant', content: 'z2' }, { role: 'user', content: 'z3' }], []);
    const bp4 = srv.sessionBodyPaths('s4');
    await srv.loadSession('s4'); // 迁移:head messageCount=3,正文 3 行
    const head4 = JSON.parse(fs.readFileSync(sPath('s4'), 'utf8'));
    head4.messageCount = 2; // 手工把头改回 2(模拟「第 3 条 append 完成但头写未完成」的崩溃点)
    fs.writeFileSync(sPath('s4'), JSON.stringify(head4, null, 2));
    const s4b = await srv.loadSession('s4');
    ok(s4b && s4b.messages.length === 2 && readLines(bp4.messages).length === 2,
      '(A10) 头是提交点:未提交的第 3 行被物理截断(读回 2 条,文件回 2 行)');

    // listSessions 在 v2 布局下照常(索引/扫描不读正文)
    const metas = await srv.listSessions();
    ok(Array.isArray(metas) && metas.some(m => m && m.id === 's4'), '(A11) listSessions v2 布局下正常返回元信息');

    // A12-A14: .prevbody 慢路径崩溃防线(收缩型重写崩溃于「正文已重写、头未提交」之间 = 旧头计数>新正文)
    seedLegacy('s6', [1, 2, 3, 4, 5].map(i => ({ role: i % 2 ? 'user' : 'assistant', content: 'w' + i })), []);
    const bp6 = srv.sessionBodyPaths('s6');
    await srv.loadSession('s6');  // 迁移
    await srv.loadSession('s6');  // 第二次读取清掉 v1bak(隔离掉迁移备份通道,专测 prevbody)
    ok(!fs.existsSync(sPath('s6') + '.v1bak'), '(A12a) 前置:v1bak 已清,只能走 prevbody 通道');
    // A12: 收缩型中断 —— 快照 5 行正文为 prevbody,把正文改写成 2 行(模拟 rewind 收缩后崩溃),头仍说 5
    const good6m = fs.readFileSync(bp6.messages, 'utf8');
    const good6p = fs.readFileSync(bp6.provider, 'utf8');
    fs.copyFileSync(bp6.messages, bp6.messages + '.prevbody');
    fs.copyFileSync(bp6.provider, bp6.provider + '.prevbody');
    fs.writeFileSync(bp6.messages, good6m.split('\n').slice(0, 2).join('\n') + '\n');
    const s6b = await srv.loadSession('s6');
    ok(s6b && s6b.messages.length === 5 && s6b.messages[4].content === 'w5' && readLines(bp6.messages).length === 5,
      '(A12b) 收缩中断 → prevbody 回滚,5 条消息完整恢复(头未提交的半成品被撤销)');
    ok(!fs.existsSync(bp6.messages + '.prevbody'), '(A12c) 恢复成功后 prevbody 快照已清');
    // A13: 增长型慢路径中断 —— prevbody=5 行、当前正文=7 行(计数与头不符)→ 回滚到 prevbody(防「前缀已被
    // 重写的新内容按头截断后冒充旧数据」——慢路径可能改过前缀,截断只在无快照的快路径语义下安全)
    fs.copyFileSync(bp6.messages, bp6.messages + '.prevbody');
    fs.copyFileSync(bp6.provider, bp6.provider + '.prevbody');
    fs.writeFileSync(bp6.messages, good6m + JSON.stringify({ role: 'user', content: 'w6' }) + '\n' + JSON.stringify({ role: 'assistant', content: 'w7' }) + '\n');
    const s6c = await srv.loadSession('s6');
    ok(s6c && s6c.messages.length === 5 && !fs.existsSync(bp6.messages + '.prevbody'),
      '(A13) 增长型慢路径中断(计数不符+快照在场)→ 回滚 prevbody,不被未提交新内容污染');
    // A14: 陈旧快照 —— 头 5 行、正文 5 行(一致)、prevbody 残留(头已提交、清理崩了)→ 正常读,快照顺带清
    fs.writeFileSync(bp6.messages + '.prevbody', good6m);
    fs.writeFileSync(bp6.provider + '.prevbody', good6p);
    const s6d = await srv.loadSession('s6');
    ok(s6d && s6d.messages.length === 5 && !fs.existsSync(bp6.messages + '.prevbody') && !fs.existsSync(bp6.provider + '.prevbody'),
      '(A14) 头计数==正文行数时 prevbody 判为陈旧快照:不恢复、顺带清除');
    await srv.deleteSession('s6');

    // ============================== (B) 引擎转录 GC ==============================
    ok(srv.claudeProjectDirKey('E:\\Claude\\ruyi-workbench-oss') === 'E--Claude-ruyi-workbench-oss',
      '(B1) cwd → 项目目录键映射(与 CLI 实测一致)');

    // B2: saveSession 自动登记白名单账本(claudeSessionId + cwd)
    await srv.saveSession({ id: 's5', title: 't-s5', cwd: 'E:\\proj', claudeSessionId: 'aaaa1111bbbb2222', messages: [], providerHistory: [] });
    const ledgerPath = path.join(HOME, 'engine-transcripts.json');
    let ledger = null;
    for (let i = 0; i < 20; i++) { // saveSession 的登记是 fire-and-forget,轮询账本落盘
      try { ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')); } catch { /* 尚未落盘 */ }
      if (ledger && ledger.known && ledger.known['aaaa1111bbbb2222']) break;
      await sleep(100);
    }
    ok(ledger && ledger.known && ledger.known['aaaa1111bbbb2222'] && ledger.known['aaaa1111bbbb2222'].cwd === 'E:\\proj',
      '(B2) saveSession 钩子自动登记转录白名单账本');

    // B3: 策略 clamp
    const pol = srv.normalizeStoragePolicy({ engineTranscriptDays: -5 });
    ok(pol.engineTranscriptDays === 0, '(B3a) 转录保留天数越界 -5 → clamp 0(关)');
    ok(srv.normalizeStoragePolicy(undefined).engineTranscriptDays === 30, '(B3b) 缺省转录保留 30 天');

    // B4: sweep 语义全谱。账本登记三条 + 活引用一条 + 账本外一条。
    const dirKey = 'E--proj';
    const tDir = path.join(PROJ, dirKey);
    fs.mkdirSync(tDir, { recursive: true });
    const mkT = (sid, old) => {
      const f = path.join(tDir, sid + '.jsonl');
      fs.writeFileSync(f, '{"type":"summary"}\n'.repeat(20));
      if (old) oldMtime(f);
      return f;
    };
    const liveFile = mkT('aaaa1111bbbb2222', true);                       // 活会话 s5 引用 → 必须保留
    fs.mkdirSync(path.join(tDir, 'aaaa1111bbbb2222'), { recursive: true }); // 活引用的侧录也不碰
    await srv.recordEngineTranscript('dead0000dead0000', 'E:\\proj');
    const deadFile = mkT('dead0000dead0000', true);                       // 无引用 + 超期 → 删
    const deadSide = path.join(tDir, 'dead0000dead0000');
    fs.mkdirSync(deadSide, { recursive: true });
    fs.writeFileSync(path.join(deadSide, 'sub.jsonl'), '{"type":"sub"}\n');
    await srv.recordEngineTranscript('newt0000newt0000', 'E:\\proj');
    const newFile = mkT('newt0000newt0000', false);                       // 无引用但太新 → 留
    await srv.recordEngineTranscript('gone0000gone0000', 'E:\\proj');     // 账本有、文件无 → 账本除名(不建文件)
    const outsider = mkT('outs000000000000', true);                       // 账本外(用户自己 Claude Code 的)→ 红线:绝不碰
    const sweepRes = await srv.storageSweep({ engineTranscriptDays: 30 }, new Set(['engine-transcripts']));
    ok(sweepRes.ok === true, '(B4a) engine-transcripts sweep ok');
    ok(fs.existsSync(liveFile) && fs.existsSync(path.join(tDir, 'aaaa1111bbbb2222')), '(B4b) 活会话引用的转录与侧录保留');
    ok(!fs.existsSync(deadFile) && !fs.existsSync(deadSide), '(B4c) 无引用超期转录删除,子代理侧录目录连带');
    ok(fs.existsSync(newFile), '(B4d) 无引用但未超期的转录保留');
    ok(fs.existsSync(outsider), '(B4e) 红线:账本外转录(用户自己的 Claude Code 数据)绝不触碰');
    ok(sweepRes.freedBytes > 0 && sweepRes.actions.some(a => a.store === 'engineTranscripts' && a.action === 'delete'),
      '(B4f) sweep 报告释放字节与删除动作(freed=' + sweepRes.freedBytes + ')');
    ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    ok(!ledger.known['dead0000dead0000'] && !ledger.known['gone0000gone0000'] && ledger.known['newt0000newt0000'],
      '(B4g) 账本已除名(已删/文件失踪),保留项仍在账');

    // B5: engineTranscriptDays=0 → 完全不动
    await srv.recordEngineTranscript('dead2222dead2222', 'E:\\proj');
    const dead2 = mkT('dead2222dead2222', true);
    const sweep0 = await srv.storageSweep({ engineTranscriptDays: 0 }, new Set(['engine-transcripts']));
    ok(sweep0.ok === true && fs.existsSync(dead2), '(B5) 保留天数 0 = 关,超期文件也不动');

    // ============================== (C) 集成层 ==============================
    const PORT = await getFreePort();
    ({ wb } = await startServer(PORT));
    ok(wb && wb.pid, '(C0) server booted :' + PORT);
    const token = await getToken(PORT);
    ok(!!token, '(C1) UI token scraped');

    const sum = await getJson(PORT, '/api/storage/summary', { 'x-wcw-token': token });
    ok(sum && sum.status === 200 && sum.body && sum.body.policy && Number(sum.body.policy.engineTranscriptDays) === 30,
      '(C2) summary 携带默认转录保留策略 30 天');

    const polBad = await reqJson(PORT, 'POST', '/api/storage/policy', { 'x-wcw-token': token }, { engineTranscriptDays: 9999 });
    ok(polBad && polBad.status === 200 && polBad.body.policy.engineTranscriptDays === 365,
      '(C3) policy 更新:越界 9999 天 clamp 到 365 — ' + JSON.stringify(polBad && polBad.body.policy));
    const sum2 = await getJson(PORT, '/api/storage/summary', { 'x-wcw-token': token });
    ok(sum2.body.policy.engineTranscriptDays === 365, '(C4) 转录策略已持久(config 落盘后回读一致)');

    let clean = await reqJson(PORT, 'POST', '/api/storage/clean', { 'x-wcw-token': token }, { target: 'engine-transcripts' });
    for (let i = 0; i < 10 && clean && clean.body && /already running/.test(String(clean.body.error || '')); i++) { await sleep(300); clean = await reqJson(PORT, 'POST', '/api/storage/clean', { 'x-wcw-token': token }, { target: 'engine-transcripts' }); }
    ok(clean && clean.status === 200 && clean.body && clean.body.ok === true, '(C5) clean target=engine-transcripts → ok(白名单空/活引用 → 无动作)');
  } catch (e) {
    console.log('ERROR ' + (e && e.stack || e.message || e)); fail++;
  } finally {
    await stopServer(wb);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(PROJ, { recursive: true, force: true });
    console.log('\nSESSION-STORAGE-V2 E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();
