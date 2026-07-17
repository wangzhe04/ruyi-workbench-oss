// E2E (v0.7d line 1): the generated .mcp.json for the Claude CLI must include the desktop MCP server
// `ai-computer-control` when desktopMcp.enabled with an explicit command; and must OMIT it (back-compat:
// identical to pre-0.7d) when disabled. We drive it via a temp HOME + GET /api/status, and also read
// the generated config file on disk.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const { getFreePort } = require('./free-port.js');
const WB = require('path').resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const NODE = process.execPath;
const FAKE_MCP = path.join(HERE, 'fake-mcp.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJson(port, p) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }

async function runCase(label, desktopMcp, wantPresent, port) {
  const HOME = path.join(os.tmpdir(), 'wcw-mcpcfg-e2e-' + label);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 4, version: '1.0.0', permissionMode: 'bypass', desktopMcp }, null, 2));
  const wb = cp.spawn(NODE, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  const out = { pass: 0, fail: 0 };
  const ok = (c, l) => { if (c) { out.pass++; console.log('PASS [' + label + '] ' + l); } else { out.fail++; console.log('FAIL [' + label + '] ' + l); } };
  try {
    let st = null; for (let i = 0; i < 40 && !st; i++) { await sleep(150); st = await getJson(port, '/api/status'); }
    ok(!!st, 'status reachable');
    // status.desktopMcp reflects config.
    ok(st && st.desktopMcp && st.desktopMcp.enabled === (desktopMcp.enabled !== false), 'status.desktopMcp.enabled=' + (desktopMcp.enabled !== false));
    // Read the generated global mcp config on disk.
    const cfgPath = path.join(HOME, 'generated', 'workbench.mcp.json');
    let generated = null; try { generated = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
    ok(generated && generated.mcpServers && generated.mcpServers['win-claude-workbench'], 'generated config always has win-claude-workbench');
    const acc = generated && generated.mcpServers && generated.mcpServers['ai-computer-control'];
    if (wantPresent) {
      ok(!!acc, 'mcpServers contains ai-computer-control');
      ok(acc && acc.command === NODE, 'ai-computer-control.command === node (got ' + (acc && acc.command) + ')');
      ok(acc && Array.isArray(acc.args) && acc.args[0] === FAKE_MCP, 'ai-computer-control.args[0] === fake-mcp.js');
      ok(acc && acc.type === 'stdio', 'ai-computer-control.type === stdio');
    } else {
      ok(!acc, 'mcpServers OMITS ai-computer-control (back-compat)');
      const keys = generated ? Object.keys(generated.mcpServers) : [];
      ok(keys.length === 1 && keys[0] === 'win-claude-workbench', 'only win-claude-workbench present when disabled');
    }
  } catch (e) { console.log('ERROR [' + label + '] ' + (e && e.message || e)); out.fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep(250);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  return out;
}

// ── v1.0.2-S5: POST /api/mcp/import-folder ──────────────────────────────────────────────────────────
// ①合法清单导入成功且 config 落盘含该条; ②同 id 二次导入=更新不重复; ③缺清单报错含 template;
// ④无 token 403; ⑤超 10 条被拒。掩码:响应里 server.env 值被掩码(不回明文 token)。
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 5000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j }); }); });
    req.on('error', () => resolve({ status: 0, json: null })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.write(data); req.end();
  });
}
const sleep2 = ms => new Promise(r => setTimeout(r, ms));

async function runImportFolder(port) {
  const out = { pass: 0, fail: 0 };
  const ok = (c, l) => { if (c) { out.pass++; console.log('PASS [import] ' + l); } else { out.fail++; console.log('FAIL [import] ' + l); } };
  const HOME = path.join(os.tmpdir(), 'wcw-mcpimport-e2e');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass', externalMcpServers: [] }, null, 2));
  // 一个带合法清单的文件夹。
  const FOLDER = path.join(HOME, 'my-mcp');
  fs.mkdirSync(FOLDER, { recursive: true });
  fs.writeFileSync(path.join(FOLDER, 'ruyi-mcp.json'), JSON.stringify({ id: 'demo-mcp', label: 'Demo MCP', command: './server.exe', args: ['--port', '9'], env: { TOKEN: 'super-secret-token-123456' } }, null, 2));
  // 一个缺清单的文件夹。
  const EMPTY = path.join(HOME, 'empty-folder');
  fs.mkdirSync(EMPTY, { recursive: true });

  const wb = cp.spawn(NODE, ['app/server.js', 'serve', '--port', String(port)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  try {
    let st = null; for (let i = 0; i < 40 && !st; i++) { await sleep2(150); st = await getJson(port, '/api/status'); }
    ok(!!st, 'status reachable');
    const token = await getToken(port);
    ok(!!token, 'token scraped');
    const hdr = { 'x-wcw-token': token };

    // ④ 无 token → 403。
    const noTok = await postJson(port, '/api/mcp/import-folder', { path: FOLDER }, {});
    ok(noTok.status === 403, '④ 无 token → 403');

    // ① 合法导入成功。
    const r1 = await postJson(port, '/api/mcp/import-folder', { path: FOLDER }, hdr);
    ok(r1.status === 200 && r1.json && r1.json.ok === true && r1.json.added === true, '① 合法清单导入 → ok:true, added:true');
    ok(r1.json && r1.json.server && r1.json.server.id === 'demo-mcp' && r1.json.server.cwd === FOLDER, '① 响应含清洗后条目, cwd 缺省=文件夹本身');
    // 掩码:env 值不回明文。
    ok(r1.json && r1.json.server && r1.json.server.env && r1.json.server.env.TOKEN && !/super-secret-token-123456/.test(JSON.stringify(r1.json.server.env)), '① 响应 env 值被掩码(不回明文 token)');
    // config 落盘含该条。
    const disk1 = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    const ext1 = disk1.externalMcpServers || [];
    ok(ext1.length === 1 && ext1[0].id === 'demo-mcp' && ext1[0].command === './server.exe', '① config.json 落盘含 demo-mcp(真值 command)');
    ok(ext1[0].env && ext1[0].env.TOKEN === 'super-secret-token-123456', '① 磁盘 env 存真值(掩码只在响应, 不落盘)');
    // 生成的 .mcp.json 含该条。
    let gen = null; try { gen = JSON.parse(fs.readFileSync(path.join(HOME, 'generated', 'workbench.mcp.json'), 'utf8')); } catch { /* ignore */ }
    ok(gen && gen.mcpServers && gen.mcpServers['demo-mcp'], '① generateMcpConfig 再生成 → .mcp.json 含 demo-mcp');

    // ② 同 id 二次导入 = 更新不重复。
    fs.writeFileSync(path.join(FOLDER, 'ruyi-mcp.json'), JSON.stringify({ id: 'demo-mcp', label: 'Demo MCP v2', command: './server2.exe' }, null, 2));
    const r2 = await postJson(port, '/api/mcp/import-folder', { path: FOLDER }, hdr);
    ok(r2.status === 200 && r2.json && r2.json.ok === true && r2.json.updated === true, '② 同 id 二次导入 → updated:true');
    const disk2 = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    const ext2 = disk2.externalMcpServers || [];
    ok(ext2.length === 1 && ext2[0].command === './server2.exe', '② 更新不重复(仍 1 条, command 已更新)');

    // ③ 缺清单 → 报错含 template。
    const r3 = await postJson(port, '/api/mcp/import-folder', { path: EMPTY }, hdr);
    ok(r3.status === 200 && r3.json && r3.json.ok === false && r3.json.error?.code === 'api.request_failed' && /缺少有效/.test(r3.json.error?.message || ''), '③ 缺清单 → 结构化错误');
    ok(r3.json && r3.json.template && r3.json.template.id && r3.json.template.command, '③ 报错附 template 示例对象');

    // ⑤ 超 10 条被拒:填满到 10(含 demo-mcp), 再导入第 11 个不同 id → 拒。
    // 直接写 config 到 10 条, 重启不便;改为连续导入 9 个新文件夹凑到 10, 第 11 个拒。
    for (let i = 0; i < 9; i++) {
      const f = path.join(HOME, 'extra-' + i);
      fs.mkdirSync(f, { recursive: true });
      fs.writeFileSync(path.join(f, 'ruyi-mcp.json'), JSON.stringify({ id: 'extra-' + i, command: 'python' }, null, 2));
      await postJson(port, '/api/mcp/import-folder', { path: f }, hdr);
    }
    const diskFull = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
    ok((diskFull.externalMcpServers || []).length === 10, '⑤ 已填满到 10 条');
    const f11 = path.join(HOME, 'overflow');
    fs.mkdirSync(f11, { recursive: true });
    fs.writeFileSync(path.join(f11, 'ruyi-mcp.json'), JSON.stringify({ id: 'overflow-one', command: 'node' }, null, 2));
    const r11 = await postJson(port, '/api/mcp/import-folder', { path: f11 }, hdr);
    ok(r11.status === 200 && r11.json && r11.json.ok === false && r11.json.error?.code === 'api.request_failed' && /上限/.test(r11.json.error?.message || ''), '⑤ 超 10 条 → 结构化上限错误');
  } catch (e) { console.log('ERROR [import] ' + (e && e.message || e)); out.fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } }
    await sleep2(250);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  return out;
}

// ── v1.1-W2 (T2): MCP drop-in 自动扫描 ──────────────────────────────────────────────────────────────
// ① <dataRoot>/mcp/foo/ruyi-mcp.json 指向 fake-mcp.js → 该 drop-in 被扫到并桥接(bridgedTools>=1, 出现 echo)。
// ② 坏清单文件夹(非法 JSON)被跳过不炸(服务器照常起来、正常 drop-in 仍生效)。
// ③ id 冲突:config 显式条目优先 —— drop-in 用同 id 但不同 command, 合并后取 config 的那一个。
// 用 fake-openai 驱动一次 echo 调用走完整桥接链(model→workbench→McpStdioClient→drop-in 的 fake-mcp→回)。
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
async function runDropIn(fakePort, wbPort) {
  const out = { pass: 0, fail: 0 };
  const ok = (c, l) => { if (c) { out.pass++; console.log('PASS [dropin] ' + l); } else { out.fail++; console.log('FAIL [dropin] ' + l); } };
  const HOME = path.join(os.tmpdir(), 'wcw-mcpdropin-e2e');
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(HOME, { recursive: true });
  const MARKER = 'DROPIN_ECHO_42';
  // ① 合法 drop-in：<dataRoot>/mcp/foo/ruyi-mcp.json 指向 fake-mcp.js（id → 前缀 foo_dropin）。
  const dropFolder = path.join(HOME, 'mcp', 'foo');
  fs.mkdirSync(dropFolder, { recursive: true });
  fs.writeFileSync(path.join(dropFolder, 'ruyi-mcp.json'), JSON.stringify({ id: 'foo-dropin', label: 'Foo Drop-in', command: NODE, args: [FAKE_MCP] }, null, 2));
  // ② 坏清单文件夹（非法 JSON）→ 应被跳过，不影响启动/①。
  const badFolder = path.join(HOME, 'mcp', 'bad');
  fs.mkdirSync(badFolder, { recursive: true });
  fs.writeFileSync(path.join(badFolder, 'ruyi-mcp.json'), '{ this is : not, valid json');
  // ③ id 冲突用的 drop-in（同 id 'confl-mcp'，但 command 会被 config 的显式条目盖过）。
  const conflFolder = path.join(HOME, 'mcp', 'confl');
  fs.mkdirSync(conflFolder, { recursive: true });
  fs.writeFileSync(path.join(conflFolder, 'ruyi-mcp.json'), JSON.stringify({ id: 'confl-mcp', label: 'Drop-in Loser', command: 'DROPIN_SHOULD_LOSE.exe' }, null, 2));
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 7, version: '1.0.0', permissionMode: 'bypass',
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + fakePort, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }], reasoning: false }],
    activeProvider: 'fake',
    // 显式条目 confl-mcp（config 优先）→ 与 drop-in 同 id，合并后应取这一个（command=NODE，真的能启动）。
    externalMcpServers: [{ id: 'confl-mcp', label: 'Config Winner', command: NODE, args: [FAKE_MCP], enabled: true }],
    desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
  }, null, 2));

  const fake = cp.spawn(NODE, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(fakePort), FAKE_TOOL_NAME: 'foo_dropin__echo', FAKE_TOOL_ARGS: JSON.stringify({ message: MARKER }) }, windowsHide: true });
  fake.stdout.on('data', () => {});
  const wb = cp.spawn(NODE, ['app/server.js', 'serve', '--port', String(wbPort)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await getJson(wbPort, '/health'); }
    ok(!!h, 'workbench up (bad manifest did NOT crash startup)');
    // 驱动一次 echo → drop-in 的 foo_dropin__echo 被桥接并调用。
    const events = await postStream(wbPort, { message: '用 drop-in 的 echo 工具' });
    const meta = events.find(e => e.type === 'meta');
    const toolUse = events.find(e => e.type === 'tool_use' && e.name === 'foo_dropin__echo');
    const toolResult = events.find(e => e.type === 'tool_result');
    ok(meta && meta.bridgedTools >= 1, '① drop-in 被扫到并桥接 (bridgedTools=' + (meta && meta.bridgedTools) + ')');
    ok(!!toolUse, '① drop-in 工具 foo_dropin__echo 出现在工具集' + (toolUse ? '' : ' (MISSING)'));
    ok(toolResult && toolResult.content && toolResult.content.echoed === MARKER, '① 桥接链往返成功 (echoed=' + JSON.stringify(toolResult && toolResult.content) + ')');
    // ② 坏清单被跳过（若它炸了，服务器起不来或 ① 全挂；能到这里且 ① 通过即证明跳过成功）。
    ok(true, '② 坏清单文件夹被静默跳过（未影响启动与 ①）');
    // ③ id 冲突：config 显式 confl-mcp 应赢 → 通过 resolveExternalMcpServers 直查（同进程 require）。
    process.env.RUYI_HOME = HOME;
    const mod = require(path.join(WB, 'app', 'server.js'));
    mod.invalidateMcpDropInCache();
    const merged = mod.resolveExternalMcpServers({ externalMcpServers: [{ id: 'confl-mcp', label: 'Config Winner', command: NODE, args: [FAKE_MCP], enabled: true }] });
    const confl = merged.find(m => m.id === 'confl-mcp');
    ok(confl && confl.command === NODE && confl.label === 'Config Winner', '③ id 冲突：config 显式条目优先（command=' + (confl && path.basename(String(confl.command))) + '，非 DROPIN_SHOULD_LOSE.exe）');
    ok(merged.filter(m => m.id === 'confl-mcp').length === 1, '③ id 冲突不产生重复条目（仅 1 个 confl-mcp）');
    // 且合法 drop-in foo-dropin 仍在（运行时合并，未写回 config）。
    ok(merged.some(m => m.id === 'foo-dropin'), '① drop-in foo-dropin 运行时合并进列表');
    delete process.env.RUYI_HOME;
  } catch (e) { console.log('ERROR [dropin] ' + (e && e.stack || e)); out.fail++; }
  finally {
    for (const c of [wb, fake]) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  return out;
}

(async () => {
  const a = await runCase('enabled', { enabled: true, command: NODE, args: [FAKE_MCP], cwd: '', autodetect: false }, true, await getFreePort());
  const b = await runCase('disabled', { enabled: false, command: '', args: [], cwd: '', autodetect: false }, false, await getFreePort());
  const c = await runImportFolder(await getFreePort());
  const d = await runDropIn(await getFreePort(), await getFreePort());
  const fail = a.fail + b.fail + c.fail + d.fail;
  console.log('\nMCP-CONFIG E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
