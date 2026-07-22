(async () => {
// E2E (第51波 51a-2 / 04 Phase D): 语义 loop-guard -- 结果指纹无进展判定。
// 与 loop-guard.e2e(同签名连击)互补:后者抓"完全相同调用(name+rawArgs)";本件抓"换参数但结果无新信息"
// (换路径反复读同类文件 -- sig 每次不同但结果内容摘要不变)。fake-openai 离线驱动。
//
// A 段(真死循环捕获): file_read 读 9 个【不同路径】【内容相同】的文件. sig 每次不同(path 变)->同签名连击
//   不触发(loopCount 每次重置);但结果内容相同->结果指纹相同->noProgressRun 累积. file_read 是探索工具
//   (宽阈值 8),第 9 次(noProgressRun=8)>=8 -> loopWarning("无新信息"). 第 1-8 次不 warn(0-7<8).
// B 段(正常探索不误伤): file_read 读 3 个【不同内容】的文件. 结果内容不同->指纹变->reset->不 warn.
//   验证"换路径读不同内容"的正常探索不被误伤(04 Phase D 验收:正常探索不误伤).
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const HOME = path.join(os.tmpdir(), 'wcw-semantic-loop-e2e');
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function postJson(port, p, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.write(data); req.end();
  });
}
function writeConfig(home, fakePort) {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
  }, null, 2));
}

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  // A 段: 9 个不同路径、内容相同的文件(换路径反复读同类文件 = 语义死循环).
  const SAME = 'identical fixture content';
  const sameFiles = [];
  for (let i = 0; i < 9; i += 1) { const p = path.join(HOME, 'same-' + i + '.txt'); fs.writeFileSync(p, SAME); sameFiles.push(p); }
  // B 段: 3 个不同内容的文件(换路径读不同内容 = 正常探索).
  const diffContents = ['AAA content here', 'BBB content here', 'CCC content here'];
  const diffFiles = [];
  for (let i = 0; i < 3; i += 1) { const p = path.join(HOME, 'diff-' + i + '.txt'); fs.writeFileSync(p, diffContents[i]); diffFiles.push(p); }
  writeConfig(HOME, FAKE_PORT);
  // 序列: 9 同内容 + 3 不同内容 = 12 步. 每步 file_read 不同路径(sig 不同)->同签名连击不触发;语义 loop-guard 判定.
  const seq = JSON.stringify([
    ...sameFiles.map(p => ({ name: 'file_read', args: { path: p } })),
    ...diffFiles.map(p => ({ name: 'file_read', args: { path: p } })),
  ]);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seq }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(fake, wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i += 1) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const created = await postJson(WB_PORT, '/api/sessions', { title: 'semantic loop', cwd: HOME });
    const sid = created.session && created.session.id;
    ok(!!sid, 'session created');

    const ev1 = await postStream(WB_PORT, { sessionId: sid, message: '开始', cwd: HOME });
    const toolResults = ev1.filter(e => e.type === 'tool_result');
    const toolUses = ev1.filter(e => e.type === 'tool_use');

    // 12 步全执行(语义 warn 不 abort,序列耗尽才结束). 验证语义 loop-guard 是 nudge 而非 abort.
    ok(toolUses.length === 12, 'turn1: 12 tool_use 全执行(语义 warn 不 abort, got ' + toolUses.length + ')');

    // A 段: 第 1-8 次(same-0..7)无 loopWarning(noProgressRun 0-7 < 探索阈值 8).
    let aClean = true;
    for (let i = 0; i < 8; i += 1) {
      if (toolResults[i] && toolResults[i].content && toolResults[i].content.loopWarning) aClean = false;
    }
    ok(aClean, 'A 段: 第 1-8 次(same-0..7)均无 loopWarning(noProgressRun 0-7 < 探索阈值 8)');

    // A 段: 第 9 次(same-8)有语义 loopWarning("无新信息").
    const ninth = toolResults[8];
    ok(ninth && ninth.content && typeof ninth.content.loopWarning === 'string' && /无新信息/.test(ninth.content.loopWarning),
      'A 段: 第 9 次(same-8)语义 loopWarning(无新信息, got ' + (ninth && ninth.content && ninth.content.loopWarning) + ')');
    // A 段: 第 9 次 loopWarning 不是同签名连击的("第 3 次")--验证是语义判定触发(sig 每次不同,连击不命中).
    ok(!/第 3 次/.test((ninth && ninth.content && ninth.content.loopWarning) || ''),
      'A 段: 第 9 次 loopWarning 是语义判定(无新信息)非同签名连击(第 3 次)');

    // B 段: 第 10-12 次(diff-0/1/2)无 loopWarning(不同内容->指纹变->reset, 正常探索不误伤).
    let bClean = true;
    for (let i = 9; i < 12; i += 1) {
      if (toolResults[i] && toolResults[i].content && toolResults[i].content.loopWarning) bClean = false;
    }
    ok(bClean, 'B 段: 第 10-12 次(diff-0/1/2)均无 loopWarning(不同内容 reset, 正常探索不误伤)');

    // 回合正常结束(语义 warn 不 abort,序列耗尽 -> turn_summary + result).
    const ts1 = ev1.find(e => e.type === 'turn_summary');
    const result1 = [...ev1].reverse().find(e => e.type === 'result');
    ok(!!ts1, 'turn1: turn_summary emitted(语义 warn 不阻断回合)');
    ok(!!result1, 'turn1: result emitted');
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nSEMANTIC LOOP-GUARD E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
