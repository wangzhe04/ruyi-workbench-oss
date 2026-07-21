(async () => {
// E2E (第46波46d): fake-mcp 20 工具契约 —— ACC 离线回归的底座。
// 三段:
//  (P1) 直连 stdio JSON-RPC:tools/list 恰好 20 件;13 件新契约逐一直调,验形状 + 真文件效果
//       (含错误契约:非 .pdf 报错 / 改写不存在文件报错 / 缺路径参数回 base64)。
//  (P2) workbench 集成:一套带 fake-mcp 桥的 workbench + fake-openai,一个回合内 FAKE_TOOL_SEQUENCE
//       连调 14 步写族工具(覆盖 BRIDGED_WRITE_PATH_ARGS 全部操作形:create/modify/delete/move/copy),
//       断言:①文件真落盘/真删除;②journal 逐目标有条目且 op 正确;③整轮回撤后工作区恢复原样
//       (新建消失、删除恢复、move 源恢复)。这是「快照表 15 条目」首次全量离线回归。
//  (P3) 静态锁:fake-mcp 写族工具集 === BRIDGED_WRITE_PATH_ARGS 键集(服务器真身 export)。
//       两侧任一加写族工具而另一侧没跟上 → 红。治「漏表 = 不能撤销」的 v1.1 返修教训机制化。
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_MCP = path.join(HERE, 'fake-mcp.js');
const srv = require(path.join(WB, 'app', 'server.js'));

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getJson(port, p, headers) {
  return new Promise(resolve => {
    const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 6000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    r.on('error', () => resolve({ status: 0, json: null, raw: '' })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null, raw: '' }); });
  });
}
function postJson(port, p, payload, headers) {
  return new Promise(resolve => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', timeout: 6000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* ignore */ } resolve({ status: res.statusCode, json: j, raw: b }); }); });
    req.on('error', () => resolve({ status: 0, json: null, raw: '' })); req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null, raw: '' }); });
    req.write(data); req.end();
  });
}
function postStream(port, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 60000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// ── P1: 直连 fake-mcp 的极简 stdio JSON-RPC 客户端 ─────────────────────────────────────────
function mcpClient() {
  const child = cp.spawn(process.execPath, [FAKE_MCP], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', d => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  function call(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('mcp timeout: ' + method)); } }, 10000);
    });
  }
  async function callTool(name, args) {
    const r = await call('tools/call', { name, arguments: args || {} });
    const text = r.result && r.result.content && r.result.content[0] && r.result.content[0].text;
    let parsed = null; try { parsed = JSON.parse(text); } catch { /* ignore */ }
    return { isError: !!(r.result && r.result.isError), result: parsed, raw: text };
  }
  return { call, callTool, kill: () => killp(child) };
}

(async () => {
  const procs = [];
  const TMP = path.join(os.tmpdir(), 'wcw-fake-mcp-contract');
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true });

  try {
    // ─────────────────────────── P1: 直连契约 ───────────────────────────
    console.log('── P1 段: fake-mcp 直连(20 件清单 + 13 件新契约) ──');
    const mcp = mcpClient();
    const init = await mcp.call('initialize', { protocolVersion: '2024-11-05' });
    ok(init.result && init.result.serverInfo && init.result.serverInfo.name === 'fake-mcp', 'P1 initialize → serverInfo fake-mcp');
    const list = await mcp.call('tools/list');
    const names = (list.result && list.result.tools || []).map(t => t.name).sort();
    ok(names.length === 21, 'P1 tools/list 恰好 21 件(20 契约 + slow_task 47b 超时测试件) (got ' + names.length + ')');
    const EXPECTED21 = ['add', 'chart_image', 'copy_file', 'delete_file', 'diagnostics', 'echo', 'excel_beautify', 'excel_chart', 'get_clipboard_image', 'image_resize', 'move_file', 'read_file', 'screenshot_full', 'slow_task', 'window_screenshot', 'write_docx', 'write_document', 'write_excel', 'write_file', 'write_pdf', 'write_pptx'].sort();
    ok(JSON.stringify(names) === JSON.stringify(EXPECTED21), 'P1 21 件名集与契约清单一致');
    ok((list.result.tools || []).every(t => t.inputSchema && t.inputSchema.type === 'object'), 'P1 每件都有 object inputSchema');

    const fx = path.join(TMP, 'p1');
    fs.mkdirSync(fx, { recursive: true });
    fs.writeFileSync(path.join(fx, 'src.txt'), 'HELLO-P1', 'utf8');
    fs.writeFileSync(path.join(fx, 'img.png'), 'FAKEPNG', 'utf8');

    const r1 = await mcp.callTool('read_file', { path: path.join(fx, 'src.txt') });
    ok(r1.result && r1.result.ok === true && r1.result.content === 'HELLO-P1' && r1.result.size === 8, 'P1 read_file {ok,content,size} 契约');
    const r1b = await mcp.callTool('read_file', { path: path.join(fx, 'src.txt'), max_bytes: 5 });
    ok(r1b.result && r1b.result.content === 'HELLO' && r1b.result.size === 8, 'P1 read_file max_bytes 是字节预算(截内容不截 size)');
    const r1c = await mcp.callTool('read_file', { path: path.join(fx, 'nope.txt') });
    ok(r1c.isError && r1c.result && r1c.result.ok === false, 'P1 read_file 不存在 → isError + ok:false');

    const r2 = await mcp.callTool('write_file', { path: path.join(fx, 'a.txt'), content: 'AB' });
    ok(r2.result && r2.result.success === true && r2.result.bytes_written === 2, 'P1 write_file {success, bytes_written}');
    await mcp.callTool('write_file', { path: path.join(fx, 'a.txt'), content: 'CD', append: true });
    ok(fs.readFileSync(path.join(fx, 'a.txt'), 'utf8') === 'ABCD', 'P1 write_file append 真追加');

    const r3 = await mcp.callTool('write_document', { path: path.join(fx, 'd.docx'), content: '# t' });
    ok(r3.result && r3.result.success === true && r3.result.output_path && fs.existsSync(r3.result.output_path), 'P1 write_document 新形状含 output_path 且真落盘');
    const r4 = await mcp.callTool('write_excel', { path: path.join(fx, 'b.xlsx'), data: [[1, 2], [3, 4]] });
    ok(r4.result && r4.result.success === true && r4.result.rows === 2 && r4.result.output_path, 'P1 write_excel {success, rows, output_path}');
    const r5 = await mcp.callTool('write_pdf', { path: path.join(fx, 'd.pdf'), content: 'x' });
    ok(r5.result && r5.result.success === true && r5.result.pages === 1, 'P1 write_pdf {success, pages, font}');
    const r5b = await mcp.callTool('write_pdf', { path: path.join(fx, 'd.txt'), content: 'x' });
    ok(r5b.isError && /must end with \.pdf/.test((r5b.result && r5b.result.error) || ''), 'P1 write_pdf 非 .pdf 路径 → 报错(ACC 契约镜像)');
    const r6 = await mcp.callTool('write_pptx', { path: path.join(fx, 's.pptx'), slides: [{ type: 'title', title: 't' }, { type: 'content', title: 'c', bullets: ['a'] }] });
    ok(r6.result && r6.result.success === true && r6.result.slides === 2, 'P1 write_pptx {success, slides}');

    const r7 = await mcp.callTool('excel_beautify', { path: path.join(fx, 'b.xlsx') });
    ok(r7.result && r7.result.success === true && r7.result.sheet === 'Sheet1', 'P1 excel_beautify 改写既有文件 ok');
    const r7b = await mcp.callTool('excel_beautify', { path: path.join(fx, 'ghost.xlsx') });
    ok(r7b.isError, 'P1 excel_beautify 不存在文件 → 报错(改写类契约)');
    const r8 = await mcp.callTool('excel_chart', { path: path.join(fx, 'b.xlsx'), sheet: 'Sheet1', chart_type: 'bar', data_range: 'A1:B2', title: 't' });
    ok(r8.result && r8.result.success === true && r8.result.anchor === 'H2', 'P1 excel_chart {success, anchor}');
    const r9 = await mcp.callTool('chart_image', { path: path.join(fx, 'c.png'), chart_type: 'pie', data: { labels: ['a'], series: [{ name: 's', values: [1] }] }, title: 't' });
    ok(r9.result && r9.result.success === true && r9.result.bytes > 0 && fs.existsSync(path.join(fx, 'c.png')), 'P1 chart_image {success, bytes} 真落盘');

    const r10 = await mcp.callTool('image_resize', { path: path.join(fx, 'img.png'), output_path: path.join(fx, 'img_half.png'), scale: 0.5 });
    ok(r10.result && r10.result.ok === true && r10.result.new_size[0] === 50 && fs.existsSync(path.join(fx, 'img_half.png')), 'P1 image_resize ok 包络 + new_size 按比例');
    const r10b = await mcp.callTool('image_resize', { path: path.join(fx, 'ghost.png'), output_path: path.join(fx, 'x.png') });
    ok(r10b.isError && r10b.result && r10b.result.ok === false, 'P1 image_resize 源不存在 → ok:false');

    const r11 = await mcp.callTool('window_screenshot', { title_substring: '任意' });
    ok(r11.result && r11.result.ok === true && !!r11.result.image_base64 && !r11.result.path, 'P1 window_screenshot 无 output_path → 回 base64(不落盘)');
    const r11b = await mcp.callTool('window_screenshot', { title_substring: '任意', output_path: path.join(fx, 'win.png') });
    ok(r11b.result && r11b.result.ok === true && r11b.result.path && fs.existsSync(path.join(fx, 'win.png')), 'P1 window_screenshot 有 output_path → 落盘回 path');
    const r12 = await mcp.callTool('get_clipboard_image', {});
    ok(r12.result && r12.result.has_image === true && !!r12.result.image_base64, 'P1 get_clipboard_image 无 save_path → base64');
    const r12b = await mcp.callTool('get_clipboard_image', { save_path: path.join(fx, 'clip.png') });
    ok(r12b.result && r12b.result.has_image === true && r12b.result.path && fs.existsSync(path.join(fx, 'clip.png')), 'P1 get_clipboard_image 有 save_path → 落盘');

    const r13 = await mcp.callTool('delete_file', { path: path.join(fx, 'a.txt') });
    ok(r13.result && r13.result.success === true && !fs.existsSync(path.join(fx, 'a.txt')), 'P1 delete_file {success} 真删除');
    const r13b = await mcp.callTool('delete_file', { path: path.join(fx, 'ghost.txt') });
    ok(r13b.isError, 'P1 delete_file 不存在 → 报错');
    const r14 = await mcp.callTool('add', { a: 2, b: 40 });
    ok(r14.result && r14.result.sum === 42, 'P1 add 回归(旧契约不动)');
    mcp.kill();

    // ─────────────────────────── P3 静态锁(提前做,结果指导 P2 覆盖面) ───────────────────────────
    console.log('── P3 段: fake 写族 == BRIDGED_WRITE_PATH_ARGS 键集 ──');
    const tableKeys = Object.keys(srv.BRIDGED_WRITE_PATH_ARGS).sort();
    const fakeSrc = fs.readFileSync(FAKE_MCP, 'utf8');
    const fakeWriteTools = [...fakeSrc.matchAll(/name: '(\w+)', description: '/g)].map(m => m[1])
      .filter(n => srv.BRIDGED_WRITE_PATH_ARGS[n] || /^(write_|delete_|move_|copy_|excel_|chart_|image_|window_|get_clipboard)/.test(n))
      .sort();
    ok(JSON.stringify(fakeWriteTools) === JSON.stringify(tableKeys),
      'P3 fake-mcp 写族工具集 === 快照表键集 (' + tableKeys.length + ' 件)' + (JSON.stringify(fakeWriteTools) !== JSON.stringify(tableKeys) ? ' —— fake:' + fakeWriteTools.join(',') + ' | 表:' + tableKeys.join(',') : ''));

    // ─────────────────────────── P2: workbench 集成(14 步写族一回合 + 整轮回撤) ───────────────────────────
    console.log('── P2 段: workbench 集成(快照表全操作形回归) ──');
    const G_HOME = path.join(TMP, 'p2');
    const G_WS = path.join(G_HOME, 'ws');
    fs.mkdirSync(G_WS, { recursive: true });
    const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
    const P = n => path.join(G_WS, n);
    // 预置:delete/move 的受害者。
    fs.writeFileSync(P('doomed.txt'), 'DOOMED-ORIGINAL', 'utf8');
    fs.writeFileSync(P('src.txt'), 'MOVE-SOURCE-ORIGINAL', 'utf8');

    fs.writeFileSync(path.join(G_HOME, 'config.json'), JSON.stringify({
      configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
      defaultWorkspace: G_WS, recentWorkspaces: [],
      providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
      activeProvider: 'fake',
      externalMcpServers: [{ id: 'fake', label: 'Fake MCP', command: process.execPath, args: [FAKE_MCP], enabled: true }],
      bridgeExternalToolsToProvider: true,
      desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
    }, null, 2));

    // 14 步:覆盖 create / modify / delete / move(delete+write) / copy(write) 全部操作形。
    const seq = [
      { name: 'fake__write_document', args: { path: P('doc.docx'), content: '# 报告' } },
      { name: 'fake__write_excel', args: { path: P('book.xlsx'), data: [['q', 'v'], ['Q1', 10]] } },
      { name: 'fake__excel_beautify', args: { path: P('book.xlsx') } },
      { name: 'fake__excel_chart', args: { path: P('book.xlsx'), sheet: 'Sheet1', chart_type: 'bar', data_range: 'A1:B2', title: '销售' } },
      { name: 'fake__write_pdf', args: { path: P('doc.pdf'), content: 'PDF 正文' } },
      { name: 'fake__write_pptx', args: { path: P('deck.pptx'), slides: [{ type: 'title', title: '封面' }] } },
      { name: 'fake__write_file', args: { path: P('note.txt'), content: 'NOTE-BODY' } },
      { name: 'fake__chart_image', args: { path: P('chart.png'), chart_type: 'bar', data: { labels: ['Q1'], series: [{ name: 'v', values: [10] }] }, title: '图' } },
      { name: 'fake__image_resize', args: { path: P('chart.png'), output_path: P('chart_small.png'), scale: 0.5 } },
      { name: 'fake__window_screenshot', args: { title_substring: '工作台', output_path: P('win.png') } },
      { name: 'fake__get_clipboard_image', args: { save_path: P('clip.png') } },
      { name: 'fake__delete_file', args: { path: P('doomed.txt') } },
      { name: 'fake__move_file', args: { source: P('src.txt'), destination: P('moved.txt') } },
      { name: 'fake__copy_file', args: { source: P('note.txt'), destination: P('note_copy.txt') } },
    ];
    const gfake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: JSON.stringify(seq) }, windowsHide: true });
    const gwb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: G_HOME }, windowsHide: true });
    gwb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
    procs.push(gfake, gwb);
    try {
      let gh = null; for (let i = 0; i < 40 && !gh; i++) { await sleep(150); gh = await health(WB_PORT); }
      ok(!!gh, 'P2 workbench up on :' + WB_PORT);
      const tok = await getToken(WB_PORT);
      const hdr = { 'x-wcw-token': tok };
      const created = await postJson(WB_PORT, '/api/sessions', { title: 'contract', cwd: G_WS }, hdr);
      const sid = created.json && created.json.session && created.json.session.id;
      ok(!!sid, 'P2 session created');

      const ev = await postStream(WB_PORT, { sessionId: sid, message: '执行 14 步写族契约', cwd: G_WS });
      const toolUses = ev.filter(e => e.type === 'tool_use' && String(e.name || '').startsWith('fake__'));
      ok(toolUses.length === seq.length, 'P2 provider 调满 ' + seq.length + ' 步 (got ' + toolUses.length + ')');

      // ① 文件效果
      const createdFiles = ['doc.docx', 'book.xlsx', 'doc.pdf', 'deck.pptx', 'note.txt', 'chart.png', 'chart_small.png', 'win.png', 'clip.png', 'moved.txt', 'note_copy.txt'];
      for (const f of createdFiles) ok(fs.existsSync(P(f)), 'P2① ' + f + ' 落盘');
      ok(!fs.existsSync(P('doomed.txt')), 'P2① doomed.txt 被删');
      ok(!fs.existsSync(P('src.txt')), 'P2① src.txt 被移走');
      ok(fs.readFileSync(P('note.txt'), 'utf8') === 'NOTE-BODY', 'P2① note.txt 内容正确(copy 源未被 move 误伤)');

      // ② journal 逐目标条目 + op 正确
      const cpj = await getJson(WB_PORT, '/api/checkpoints?sessionId=' + sid, hdr);
      const entries = (cpj.json && Array.isArray(cpj.json.entries) ? cpj.json.entries : []);
      const byPath = p => entries.filter(e => e.path === path.resolve(p));
      const expect = [
        ['doc.docx', 'create'], ['book.xlsx', 'modify'], // create+2×modify,只验含 modify
        ['doc.pdf', 'create'], ['deck.pptx', 'create'], ['note.txt', 'create'], ['chart.png', 'create'],
        ['chart_small.png', 'create'], ['win.png', 'create'], ['clip.png', 'create'],
        ['doomed.txt', 'delete'], ['moved.txt', 'create'], ['note_copy.txt', 'create'],
      ];
      for (const [f, op] of expect) {
        ok(byPath(P(f)).some(e => e.op === op), 'P2② journal 有 ' + f + ' 的 ' + op + ' 条目');
      }
      ok(byPath(P('book.xlsx')).filter(e => e.op === 'modify').length === 2, 'P2② book.xlsx 两条 modify(beautify+chart 各自快照)');
      ok(byPath(P('src.txt')).some(e => e.op === 'delete'), 'P2② move 源侧 src.txt 记 delete');
      const turnSeq = entries.length && entries[0].turnSeq;
      ok(entries.every(e => e.turnSeq === turnSeq), 'P2② 全部条目同 turnSeq(一回合)');

      // ③ 整轮回撤 → 工作区恢复原样
      const rb = await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq }, hdr);
      ok(rb.json && rb.json.ok === true, 'P2③ 整轮回撤 ok');
      for (const f of createdFiles) ok(!fs.existsSync(P(f)), 'P2③ ' + f + ' 已撤(新建消失)');
      ok(fs.existsSync(P('doomed.txt')) && fs.readFileSync(P('doomed.txt'), 'utf8') === 'DOOMED-ORIGINAL', 'P2③ doomed.txt 恢复原文');
      ok(fs.existsSync(P('src.txt')) && fs.readFileSync(P('src.txt'), 'utf8') === 'MOVE-SOURCE-ORIGINAL', 'P2③ src.txt 恢复(move 源复活)');
      const remaining = fs.readdirSync(G_WS);
      ok(remaining.sort().join(',') === ['doomed.txt', 'src.txt'].sort().join(','), 'P2③ 工作区回到只剩两个预置文件 (got: ' + remaining.join(',') + ')');
    } finally {
      killp(gfake); killp(gwb);
      await sleep(300);
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log('\nFAKE-MCP-CONTRACT E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exit(fail ? 1 : 0);
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
