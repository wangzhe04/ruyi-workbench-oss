require('./lib/self-isolate-home.js'); // 121 换机器：直跑时家目录自隔离，防 fake-mcp 夹具经 claude mcp add-json／Kimi 同步漏进真机 ~/.claude.json 与 ~/.kimi-code/mcp.json（见 lib 头注）
// E2E (N9 只读岛): 真工作台回合 + 离线假 provider。批里混进 todo_write / 编辑时,只读调用也能并发:
//  A [read, read, todo_write, read]        -> strategy=parallel, 宽度 3(todo_write 是中性调用,不把批拆成串行)
//  B [read, read, edit f1, read f1]        -> 岛 = 前两个读(宽度 2);编辑之后的读【不】入岛,必须读到编辑后的内容
//  C [edit, read, read]                    -> 第一个就是阻塞调用,岛为空,整批串行(与修前一致)
//  D [read, edit, read]                    -> 岛只有 1 个(无并发收益),串行(read-pool.e2e 的 mixed 口径)
//  E [read ×3]                             -> 纯只读批照旧 parallel, 宽度 3
// 每例都核:全部工具执行完成、落盘 toolCalls 的顺序 = 模型发出的顺序。
'use strict';
const { killOwnTree } = require('./lib/kill-own-tree'); // 128c:只杀自己的树(核创建时间),取代 taskkill /T
const cp = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { getFreePorts } = require('./free-port');
const { createRunner } = require('./lib/harness');

const ROOT = path.resolve(__dirname, '..');
const WB = path.join(ROOT, 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function health(port) {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, res => {
      let body = ''; res.on('data', c => (body += c)); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null)); req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', chunk => {
        buf += chunk; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } }
        }
      });
      res.on('end', () => resolve(events));
    });
    req.on('error', reject); req.end(data);
  });
}
function killTree(child) {
  if (!child || !child.pid) return;
  try { killOwnTree(child); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}
function readLogs(home) {
  return fs.readdirSync(path.join(home, 'logs')).filter(f => /^workbench-.*\.ndjson$/.test(f))
    .flatMap(f => fs.readFileSync(path.join(home, 'logs', f), 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } })).filter(Boolean);
}


async function runCase(label, buildBatch) {
  const HOME = path.join(os.tmpdir(), `ruyi-island-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  const [fakePort, wbPort] = await getFreePorts(2);
  const files = Array.from({ length: 10 }, (_, i) => path.join(HOME, `f${i}.txt`));
  files.forEach((f, i) => fs.writeFileSync(f, `DATA_${i}`));
  const parallel = buildBatch(files);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 10, version: '2.5.0', permissionMode: 'bypass', toolLoadingMode: 'full',
    runtimeOptimizationShadowV1: true, runtimeToolRetrievalV1: false, runtimeFailureTelemetryV1: false,
    defaultWorkspace: HOME, desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    externalMcpServers: [], bridgeExternalToolsToProvider: false,
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${fakePort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));
  const fake = cp.spawn(process.execPath, [path.join(__dirname, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_PARALLEL_TOOLS: JSON.stringify(parallel) }, windowsHide: true, stdio: 'ignore' });
  const wb = cp.spawn(process.execPath, [SERVER, 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true, stdio: 'ignore' });
  let live = null; for (let i = 0; i < 80 && !live; i++) { await sleep(120); live = await health(wbPort); }
  const events = await postStream(wbPort, { message: 'Do the requested tool calls and reply.' });
  await sleep(500);
  const rows = readLogs(HOME);
  const phases = rows.filter(r => r.kind === 'tool_phase_completed');
  const tools = rows.filter(r => r.kind === 'tool_call_completed');
  const timing = rows.filter(r => r.kind === 'iter_timing');
  const dir = path.join(HOME, 'sessions');
  const msgFile = fs.existsSync(dir) ? fs.readdirSync(dir).find(n => n.endsWith('.messages.ndjson')) : '';
  const messages = msgFile ? fs.readFileSync(path.join(dir, msgFile), 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const calls = messages.flatMap(m => Array.isArray(m.toolCalls) ? m.toolCalls : []);
  const edited = fs.readFileSync(files[1], 'utf8');
  killTree(fake); killTree(wb); await sleep(150);
  fs.rmSync(HOME, { recursive: true, force: true });
  return { label, files, phases, tools, timing, calls, events, edited };
}

(async () => {
  const t = createRunner('PARALLEL READ ISLAND');
  const { ok } = t;
  const R = (f, i) => ({ name: 'file_read', args: { path: f[i] } });
  const TODO = { name: 'todo_write', args: { items: [{ id: 't1', text: 'look', status: 'in_progress' }] } };
  const EDIT1 = f => ({ name: 'file_edit', args: { path: f[1], oldText: 'DATA_1', newText: 'EDITED_1' } });
  const namesOf = r => r.calls.map(c => c.name);
  const contentOf = (r, idx) => { const c = r.calls[idx]; return c && c.result && typeof c.result.content === 'string' ? c.result.content : ''; };
  try {
    const A = await runCase('A', f => [R(f, 0), R(f, 1), TODO, R(f, 2)]);
    ok(A.tools.length === 4 && A.tools.every(x => x.status === 'completed'), 'A: 四个调用全部执行完成');
    const pa = A.phases.find(p => p.strategy === 'parallel');
    ok(Boolean(pa) && pa.maxConcurrency === 3, `A: [read,read,todo_write,read] 是 parallel、宽度 3(实得 ${JSON.stringify(A.phases.map(p => [p.strategy, p.maxConcurrency]))})`);
    ok(A.timing.some(x => x.parallelBatch === true), 'A: iter_timing.parallelBatch 为真');
    ok(JSON.stringify(namesOf(A)) === JSON.stringify(['file_read', 'file_read', 'todo_write', 'file_read']), `A: 落盘顺序 = 模型发出顺序(实得 ${namesOf(A)})`);
    ok(contentOf(A, 0) === 'DATA_0' && contentOf(A, 1) === 'DATA_1' && contentOf(A, 3) === 'DATA_2', 'A: 每个读拿到自己那份内容(配对不串)');

    const B = await runCase('B', f => [R(f, 0), R(f, 9), EDIT1(f), R(f, 1)]);
    ok(B.tools.length === 4 && B.tools.every(x => x.status === 'completed'), 'B: 四个调用全部执行完成');
    const pb = B.phases.find(p => p.strategy === 'parallel');
    ok(Boolean(pb) && pb.maxConcurrency === 2, `B: 岛 = 前两个读,宽度 2(实得 ${JSON.stringify(B.phases.map(p => [p.strategy, p.maxConcurrency]))})`);
    ok(B.edited === 'EDITED_1', 'B: 编辑照常生效');
    ok(contentOf(B, 3) === 'EDITED_1', `B: 编辑【之后】的读读到编辑后的内容,没被提前并发(实得 ${JSON.stringify(contentOf(B, 3))})`);
    ok(JSON.stringify(namesOf(B)) === JSON.stringify(['file_read', 'file_read', 'file_edit', 'file_read']), 'B: 落盘顺序不变');

    const C = await runCase('C', f => [EDIT1(f), R(f, 2), R(f, 3)]);
    ok(C.tools.length === 3 && C.tools.every(x => x.status === 'completed'), 'C: 三个调用全部执行完成');
    ok(C.phases.every(p => p.strategy === 'serial'), `C: [edit,read,read] 第一个就是阻塞调用,整批串行(实得 ${JSON.stringify(C.phases.map(p => p.strategy))})`);

    const D = await runCase('D', f => [R(f, 0), EDIT1(f), R(f, 2)]);
    ok(D.tools.length === 3 && D.phases.every(p => p.strategy === 'serial'), 'D: [read,edit,read] 岛只有 1 个,串行(read-pool 的 mixed 口径不变)');

    const E = await runCase('E', f => [R(f, 0), R(f, 1), R(f, 2)]);
    const pe = E.phases.find(p => p.strategy === 'parallel');
    ok(E.tools.length === 3 && Boolean(pe) && pe.maxConcurrency === 3, 'E: 纯只读批照旧 parallel、宽度 3');
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  }
  t.done({ exit: true });
})();
