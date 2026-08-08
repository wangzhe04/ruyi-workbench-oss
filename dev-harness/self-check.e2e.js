(async () => {
// E2E (O3 hb360): 产物类任务完成前自检。fake-openai 跑 file_write -> 声明完成 -> O3 注入自检 user ->
// 自检轮再次回复完成 -> selfCheckDone 阻断无限循环 -> 回合结束。断言 self_check 事件触发 + 文件真写入。
// 离线: fake-openai + workbench, 无外网。
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const { getFreePort } = require('./free-port.js');

const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-selfcheck-e2e');
const REPORT = path.join(HOME, 'report.txt');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  configSchema: 4, version: '1.0.0', permissionMode: 'bypass', defaultWorkspace: HOME,
  providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
  activeProvider: 'fake',
}, null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
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

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const children = [];
// sequence: 第 1 轮 emit file_write; 之后 fall through 到 echo(回 file_write 结果, finish stop = 声明完成)
const seq = [{ name: 'file_write', args: { path: REPORT, content: 'ANALYSIS_DONE' } }];
const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: JSON.stringify(seq) }, windowsHide: true });
const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
children.push(fake, wb);
try {
  let h = null; for (let i = 0; i < 50 && !h; i++) { await sleep(120); h = await health(WB_PORT); }
  ok(!!h, 'workbench listening on :' + WB_PORT);
  // prompt 含产物词(创建/报告/写入) -> 激活 files_write 包(file_write 注入) + 触发 O3 自检正则
  const events = await postStream(WB_PORT, { message: '请创建一份报告文件并写入分析结果' });
  const toolUse = events.find(e => e.type === 'tool_use' && e.name === 'file_write');
  ok(!!toolUse, 'tool_use file_write emitted (product write)');
  const selfCheck = events.find(e => e.type === 'self_check' && e.state === 'invoked');
  ok(!!selfCheck, 'O3: self_check invoked before product-task completion');
  const result = events.find(e => e.type === 'result');
  ok(result && result.ok === true, 'result ok=true (self-check did not break the turn)');
  ok(fs.existsSync(REPORT) && fs.readFileSync(REPORT, 'utf8') === 'ANALYSIS_DONE', 'report.txt written by file_write with correct content');
  // 自检应只触发一次(selfCheckDone 防无限循环): 整个回合 self_check 事件计数 == 1
  const selfCheckCount = events.filter(e => e.type === 'self_check' && e.state === 'invoked').length;
  ok(selfCheckCount === 1, 'O3: self_check fires exactly once (no infinite loop, selfCheckDone guards)');
} catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
finally {
  for (const c of children) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
  await sleep(300);
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nSELF-CHECK E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
}
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
