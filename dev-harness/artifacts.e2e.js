(async () => {
const { getFreePort } = require('./free-port.js');
﻿// E2E for v0.9-S4 (C4 / §0.9-S4): 产物画廊 + 本地文件预览端点.
// Ports 9005 (fake-openai) + 9006 (workbench).
//
// Two halves:
//  (a) turn_summary.artifacts — a provider turn writes report.md + data.csv + pic.png via FAKE_TOOL_SEQUENCE
//      (file_write ×3). Assert the emitted turn_summary.artifacts has all three with the right kind
//      (md/csv/img). Then GET the session and assert the cumulative artifacts survive on the assistant
//      message's turnSummary (the front-end walks these to build the gallery).
//  (b) GET /api/file/preview — token-gated + allowed-root guarded:
//      · no token → 403;
//      · report.md (inside cwd) → {kind:'text', content};
//      · pic.png (inside cwd) → {kind:'image', dataUri:'data:image/png;base64,…'};
//      · an .html file (inside cwd) → {kind:'html', content} with the raw source returned verbatim (the
//        front-end sandbox-iframes it — that iframe attribute is covered by code review);
//      · a file OUTSIDE every allowed root (a sibling temp dir) → 403 'path not in an allowed workspace'
//        (this is the load-bearing path-safety assertion for this slice);
//      · a >1MB text file → {truncated:true}.
//  Plus direct units for kindForPath + pathWithinRoot (the classifier + containment math).
'use strict';
const cp = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const HERE = __dirname;
const FAKE_PORT = await getFreePort(), WB_PORT = await getFreePort();
const srv = require(path.join(WB, 'app', 'server.js'));



const sleep = ms => new Promise(r => setTimeout(r, ms));
const errorText = value => typeof value === 'string' ? value : String(value && (value.message || value.code) || '');
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
    const req = http.request({ host: '127.0.0.1', port, path: '/api/chat/stream', method: 'POST', timeout: 15000, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let buf = ''; const events = [];
      res.on('data', c => { buf += c; let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (line.trim()) { try { events.push(JSON.parse(line)); } catch { /* ignore */ } } } });
      res.on('end', () => { if (buf.trim()) { try { events.push(JSON.parse(buf)); } catch { /* ignore */ } } resolve(events); });
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('stream timeout')); }); req.write(data); req.end();
  });
}
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

// A minimal valid 1×1 PNG (67 bytes) — enough for the image branch to base64-encode with the png mime.
const PNG_1x1 = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000d49444154789c6360000002000100' +
  '05fe02fea7c3e8000000000049454e44ae426082', 'hex');

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const procs = [];

  const HOME = path.join(os.tmpdir(), 'wcw-artifacts-e2e');
  const WS = path.join(HOME, 'ws');          // the session's cwd (an allowed root)
  const OUTSIDE = path.join(os.tmpdir(), 'wcw-artifacts-e2e-outside'); // a sibling dir, NOT an allowed root
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });
  fs.mkdirSync(WS, { recursive: true });
  fs.mkdirSync(OUTSIDE, { recursive: true });

  // A real file outside every allowed root — the path-safety 403 target.
  const outsideFile = path.join(OUTSIDE, 'secret.txt');
  fs.writeFileSync(outsideFile, 'TOP SECRET — must never be previewable');

  // Config: fake provider, cwd = WS (so WS is in the allowed roots). defaultWorkspace also = WS.
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    defaultWorkspace: WS, recentWorkspaces: [],
    providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
    activeProvider: 'fake',
  }, null, 2));

  // ── direct UNITS: kindForPath + pathWithinRoot ───────────────────────────────────────────────────────
  ok(srv.kindForPath('a/b/report.md') === 'md' && srv.kindForPath('x.CSV') === 'csv' && srv.kindForPath('p.PNG') === 'img'
    && srv.kindForPath('page.html') === 'html' && srv.kindForPath('book.pdf') === 'pdf' && srv.kindForPath('sheet.xlsx') === 'xlsx'
    && srv.kindForPath('doc.docx') === 'docx' && srv.kindForPath('note.txt') === 'txt' && srv.kindForPath('data.bin') === 'other',
    '(unit) kindForPath classifies by suffix');
  // Containment: inside is ok, escape / prefix-sibling is not.
  const root = path.resolve('C:\\ws');
  ok(srv.pathWithinRoot(path.resolve('C:\\ws\\sub\\f.txt'), root) === true, '(unit) pathWithinRoot: nested → true');
  ok(srv.pathWithinRoot(root, root) === true, '(unit) pathWithinRoot: root itself → true');
  ok(srv.pathWithinRoot(path.resolve('C:\\ws-evil\\f.txt'), root) === false, '(unit) pathWithinRoot: prefix-sibling (C:\\ws-evil) → false (no substring bug)');
  ok(srv.pathWithinRoot(path.resolve('C:\\other\\f.txt'), root) === false, '(unit) pathWithinRoot: elsewhere → false');
  ok(srv.pathWithinAnyRoot(path.resolve('C:\\ws\\a'), [path.resolve('C:\\z'), root]) === true, '(unit) pathWithinAnyRoot: any root matches');

  // ── v1.0.2-S4 产物判定放宽:op:'modify' 且 kindForPath 命中已知类型也算产物(改一个 xlsx 也是产物)。──
  // 直接单元 buildTurnSummary(turnSeq, toolCalls, engine, journalEntries):合成 journal 条目, 断言:
  //  · modify 一个 .xlsx → 入 artifacts;
  //  · modify 一个 .md/.png → 入 artifacts;
  //  · modify 一个 .txt / .log(other)→ 不入(避免随手改的日志被当产物);
  //  · create 与 modify 同 path → 去重只留一条。
  {
    const je = (op, p) => ({ turnSeq: 1, entrySeq: 1, tool: 'file_write', path: p, op });
    const sum = srv.buildTurnSummary(1, [], 'openai', [
      je('modify', 'C:\\ws\\book.xlsx'),
      je('modify', 'C:\\ws\\report.md'),
      je('modify', 'C:\\ws\\pic.png'),
      je('modify', 'C:\\ws\\notes.txt'),
      je('modify', 'C:\\ws\\run.log'),
      je('create', 'C:\\ws\\fresh.csv'),
    ]);
    const arts = (sum && sum.artifacts) || [];
    const hasArt = name => arts.some(a => a.path && a.path.replace(/\\/g, '/').endsWith(name));
    ok(hasArt('book.xlsx'), '(S4 unit) modify xlsx → 入产物');
    ok(hasArt('report.md') && hasArt('pic.png'), '(S4 unit) modify md/png → 入产物');
    ok(!hasArt('notes.txt') && !hasArt('run.log'), '(S4 unit) modify txt/log(非已知产物类型)→ 不入');
    ok(hasArt('fresh.csv'), '(S4 unit) create csv → 入产物(原行为保留)');
    // create + modify 同 path 去重(同一 xlsx 既 create 又 modify 只一条)。
    const sum2 = srv.buildTurnSummary(1, [], 'openai', [je('create', 'C:\\ws\\dup.xlsx'), je('modify', 'C:\\ws\\dup.xlsx')]);
    const dupCount = ((sum2 && sum2.artifacts) || []).filter(a => a.path.replace(/\\/g, '/').endsWith('dup.xlsx')).length;
    ok(dupCount === 1, '(S4 unit) create+modify 同 path → 去重(1 条, got ' + dupCount + ')');
  }

  // ── v1.5-W1.5 (T1) 直接单元:bridged 写族「工具名限定的 path 收割」──────────────────────────────────────
  // ACC 旧版写族回 {success:true, path:...}(裸 path,无 output_path)。断言:
  //  · bridged 写族(fake__write_docx)success:true + path → 入 artifacts;
  //  · bridged 读类(srv__read_document)即使回 path,也 NOT 入 artifacts(名字不匹配写族);
  //  · 新版 ACC(同时回 output_path 与 path)→ 只登记一条(resolved-path 去重);
  //  · success 缺失/false → 不收(写失败无产物)。
  {
    const tc = (name, result) => ({ id: 'c', name, input: {}, result });
    const arts = sum => ((sum && sum.artifacts) || []).map(a => a.path.replace(/\\/g, '/'));
    const s1 = srv.buildTurnSummary(1, [tc('fake__write_docx', { success: true, path: 'C:\\ws\\made.docx' })], 'openai', []);
    ok(arts(s1).some(p => p.endsWith('made.docx')), '(T1 unit) bridged write_docx {success,path} → 入产物');
    const s2 = srv.buildTurnSummary(1, [tc('srv__read_document', { success: true, path: 'C:\\ws\\readonly.docx', content: 'x' })], 'openai', []);
    ok(!arts(s2).some(p => p.endsWith('readonly.docx')), '(T1 unit) bridged read_document 回 path → NOT 入产物(名字非写族)');
    const s3 = srv.buildTurnSummary(1, [tc('srv__write_excel', { success: true, path: 'C:\\ws\\book.xlsx', output_path: 'C:\\ws\\book.xlsx' })], 'openai', []);
    ok(arts(s3).filter(p => p.endsWith('book.xlsx')).length === 1, '(T1 unit) 新版 ACC(path+output_path)→ 去重只一条');
    const s4 = srv.buildTurnSummary(1, [tc('fake__write_docx', { path: 'C:\\ws\\nosuccess.docx' })], 'openai', []);
    ok(!arts(s4).some(p => p.endsWith('nosuccess.docx')), '(T1 unit) 无 success 字段 → 不收(写失败无产物)');
    // 前缀写族:export_*/create_*/save_* 也算写族。
    const s5 = srv.buildTurnSummary(1, [tc('srv__export_report', { success: true, path: 'C:\\ws\\out.pdf' })], 'openai', []);
    ok(arts(s5).some(p => p.endsWith('out.pdf')), '(T1 unit) 前缀写族 export_report → 入产物');
  }

  // ── v1.5-W1.5 (T3) 直接单元:collectBridgedWriteTarget(args→目标路径+op)──────────────────────────────
  {
    const abs = 'C:\\ws\\a.docx';
    const t1 = srv.collectBridgedWriteTarget('fake__write_docx', { path: abs });
    ok(t1 && t1.mode === 'write' && t1.path === abs, '(T3 unit) write_docx {path} → {write, abs}');
    ok(srv.collectBridgedWriteTarget('srv__write_document', { path: abs }) !== null, '(T3 unit) write_document 识别');
    ok(srv.collectBridgedWriteTarget('srv__delete_file', { path: abs }).mode === 'delete', '(T3 unit) delete_file → mode delete');
    ok(srv.collectBridgedWriteTarget('fake__write_docx', { path: 'a.docx' }) === null, '(T3 unit) 相对路径 → null(不快照)');
    ok(srv.collectBridgedWriteTarget('srv__read_document', { path: abs }) === null, '(T3 unit) 读类工具 → null');
    ok(srv.collectBridgedWriteTarget('fake__write_docx', {}) === null, '(T3 unit) 缺 path → null');
    // v1.1 返修防回潮:ACC v1.6 四个 Office 工具上线时漏进快照表,用户真机撞出「PPT/Excel 不能撤销」。
    // 此断言钉死:任何新增 bridged 写族工具漏表,这里必红。script_run 必须保持 null(终端类不承诺可撤)。
    for (const t of ['write_pptx', 'excel_beautify', 'excel_chart', 'chart_image']) {
      const r = srv.collectBridgedWriteTarget('acc__' + t, { path: abs });
      ok(r && r.mode === 'write' && r.path === abs, `(v1.6 防回潮) ${t} 进快照表`);
    }
    ok(srv.collectBridgedWriteTarget('acc__script_run', { path: abs }) === null, '(v1.6 防回潮) script_run 保持不承诺可撤');
    // v1.2-B:move/copy 补齐(W1.5 欠账)。ACC 参数名 source/destination(非 src/dest)。move = 两条
    //   (source delete + destination write);copy = 一条(destination write)。深覆盖在 checkpoint-coverage.e2e。
    {
      const src = 'C:\\ws\\a.txt', dst = 'C:\\ws\\b.txt';
      const mv = srv.collectBridgedWriteTargets('acc__move_file', { source: src, destination: dst });
      ok(mv.length === 2 && mv[0].mode === 'delete' && mv[0].path === src && mv[1].mode === 'write' && mv[1].path === dst,
         '(v1.2-B 防回潮) move_file → source delete + destination write 两条');
      const cpTgt = srv.collectBridgedWriteTargets('acc__copy_file', { source: src, destination: dst });
      ok(cpTgt.length === 1 && cpTgt[0].mode === 'write' && cpTgt[0].path === dst,
         '(v1.2-B 防回潮) copy_file → 只 destination write 一条');
    }
  }

  const seq = JSON.stringify([
    { name: 'file_write', args: { path: path.join(WS, 'report.md'), content: '# Report\n\nHello **world**. See <script>alert(1)</script>.' } },
    { name: 'file_write', args: { path: path.join(WS, 'data.csv'), content: 'a,b,c\n1,2,3\n4,5,6' } },
    { name: 'file_write', args: { path: path.join(WS, 'pic.png'), content: PNG_1x1.toString('base64'), encoding: 'base64' } },
  ]);
  const fake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(FAKE_PORT), FAKE_TOOL_SEQUENCE: seq }, windowsHide: true });
  fake.stdout.on('data', d => String(d).trim() && console.log('[fake] ' + String(d).trim()));
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  procs.push(fake, wb);

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    ok(h && h.version === require(require('path').resolve(__dirname,'..','ruyi-workbench','package.json')).version, 'version === package.json'); // 第23波: 动态读
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const hdr = { 'x-wcw-token': token };

    // ── (a) turn writes 3 files → turn_summary.artifacts ─────────────────────────────────────────────
    const created = await postJson(WB_PORT, '/api/sessions', { title: 'artifacts', cwd: WS }, hdr);
    const sid = created.json && created.json.session && created.json.session.id;
    ok(!!sid, 'session created');

    const ev = await postStream(WB_PORT, { sessionId: sid, message: '造三件产物', cwd: WS });
    const ts = ev.find(e => e.type === 'turn_summary');
    ok(!!ts, '(a) turn_summary emitted');
    const arts = (ts && ts.artifacts) || [];
    ok(Array.isArray(arts) && arts.length === 3, '(a) artifacts has 3 items (got ' + arts.length + ')');
    const kindOf = name => { const a = arts.find(x => x.path && x.path.replace(/\\/g, '/').endsWith(name)); return a && a.kind; };
    ok(kindOf('report.md') === 'md', '(a) report.md → kind md');
    ok(kindOf('data.csv') === 'csv', '(a) data.csv → kind csv');
    ok(kindOf('pic.png') === 'img', '(a) pic.png → kind img');

    // GET session → cumulative artifacts on the assistant message's turnSummary.
    const got = await getJson(WB_PORT, '/api/sessions/' + sid, hdr);
    const s = got.json && got.json.session;
    const lastAssistant = s && [...s.messages].reverse().find(m => m && m.role === 'assistant');
    const persistedArts = lastAssistant && lastAssistant.turnSummary && lastAssistant.turnSummary.artifacts;
    ok(Array.isArray(persistedArts) && persistedArts.length === 3, '(a) GET session: cumulative artifacts persisted (3)');

    // ── (b) preview endpoint: token gate + text + image + path-safety ─────────────────────────────────
    const mdPath = path.join(WS, 'report.md');
    const pv = q => getJson(WB_PORT, '/api/file/preview?' + q, hdr);

    const noTok = await getJson(WB_PORT, '/api/file/preview?path=' + encodeURIComponent(mdPath) + '&sessionId=' + sid, {});
    ok(noTok.status === 403, '(b) preview without token → 403');

    const rMd = await pv('path=' + encodeURIComponent(mdPath) + '&sessionId=' + sid);
    ok(rMd.status === 200 && rMd.json && rMd.json.ok && rMd.json.kind === 'text', '(b) report.md → kind text');
    ok(rMd.json && typeof rMd.json.content === 'string' && rMd.json.content.includes('Hello'), '(b) report.md content returned verbatim');

    const rPng = await pv('path=' + encodeURIComponent(path.join(WS, 'pic.png')) + '&sessionId=' + sid);
    ok(rPng.status === 200 && rPng.json && rPng.json.kind === 'image', '(b) pic.png → kind image');
    ok(rPng.json && typeof rPng.json.dataUri === 'string' && rPng.json.dataUri.startsWith('data:image/png;base64,'), '(b) pic.png dataUri is a png data URI');

    // Path OUTSIDE every allowed root → 403 (the load-bearing path-safety assertion).
    const rOut = await pv('path=' + encodeURIComponent(outsideFile) + '&sessionId=' + sid);
    ok(rOut.status === 403 && rOut.json && /allowed workspace/.test(errorText(rOut.json.error)), '(b) file outside allowed roots → 403 path not allowed');

    // A Windows system file, if present — belt-and-suspenders (also outside allowed roots).
    const winIni = 'C:\\Windows\\win.ini';
    if (fs.existsSync(winIni)) {
      const rWin = await pv('path=' + encodeURIComponent(winIni) + '&sessionId=' + sid);
      ok(rWin.status === 403, '(b) C:\\Windows\\win.ini → 403 (arbitrary-read blocked)');
    } else { console.log('SKIP (b) win.ini absent'); }

    // Relative / non-absolute path → 400.
    const rRel = await pv('path=' + encodeURIComponent('report.md') + '&sessionId=' + sid);
    ok(rRel.status === 400, '(b) relative path → 400 must be absolute');

    // ── (c) html → kind html + raw source verbatim ───────────────────────────────────────────────────
    const htmlPath = path.join(WS, 'page.html');
    const htmlSrc = '<html><body><h1>hi</h1><script>window.__pwned=1;alert("x")</script></body></html>';
    fs.writeFileSync(htmlPath, htmlSrc);
    const rHtml = await pv('path=' + encodeURIComponent(htmlPath) + '&sessionId=' + sid);
    ok(rHtml.status === 200 && rHtml.json && rHtml.json.kind === 'html', '(c) page.html → kind html');
    ok(rHtml.json && rHtml.json.content === htmlSrc, '(c) html source returned verbatim (front-end sandbox-iframes it; iframe sandbox="" code-reviewed)');

    // ── (d) >1MB text → truncated:true ───────────────────────────────────────────────────────────────
    const bigPath = path.join(WS, 'big.txt');
    fs.writeFileSync(bigPath, 'x'.repeat(1024 * 1024 + 500)); // just over 1MB
    const rBig = await pv('path=' + encodeURIComponent(bigPath) + '&sessionId=' + sid);
    ok(rBig.status === 200 && rBig.json && rBig.json.kind === 'text' && rBig.json.truncated === true, '(d) >1MB text → truncated:true');
    ok(rBig.json && typeof rBig.json.content === 'string' && rBig.json.content.length <= 1024 * 1024, '(d) truncated content ≤ 1MB');

    // binary (xlsx) → kind binary + canOpen (station-side preview deferred to v1.0).
    const xlsxPath = path.join(WS, 'book.xlsx');
    fs.writeFileSync(xlsxPath, Buffer.from('PK\x03\x04 not-really-xlsx'));
    const rXlsx = await pv('path=' + encodeURIComponent(xlsxPath) + '&sessionId=' + sid);
    ok(rXlsx.json && rXlsx.json.kind === 'binary' && rXlsx.json.canOpen === true, '(e) xlsx → kind binary, canOpen:true (v1.0 defers station preview)');

    // ── (f) v1.0.2-S3: POST /api/file/reveal — token gate + path-safety 护栏 ────────────────────────────
    // 单元:buildRevealSpawn 绝不走 shell, mode='select' 传 '/select,'+path 为同一参数, mode='open' 传 [path]。
    const spSelect = srv.buildRevealSpawn('select', 'C:\\ws\\a.txt');
    ok(spSelect.command === 'explorer.exe' && spSelect.args.length === 1 && spSelect.args[0] === '/select,C:\\ws\\a.txt', '(f unit) buildRevealSpawn select: 单参数 /select,+path');
    const spOpen = srv.buildRevealSpawn('open', 'C:\\ws\\a.txt');
    ok(spOpen.command === 'explorer.exe' && spOpen.args.length === 1 && spOpen.args[0] === 'C:\\ws\\a.txt', '(f unit) buildRevealSpawn open: [path]');
    // 收官加固防回潮:可执行/脚本类扩展名的 'open' 必须降级为 'select'(否则提示注入可诱导用户一键执行任意程序)。
    for (const bad of ['evil.bat', 'evil.exe', 'evil.js', 'evil.ps1', 'evil.lnk', 'EVIL.CMD']) {
      const sp = srv.buildRevealSpawn('open', 'C:\\ws\\' + bad);
      ok(sp.mode === 'select' && sp.degraded === true && sp.args[0] === '/select,C:\\ws\\' + bad, `(f unit) buildRevealSpawn open ${bad} → 降级 select`);
    }
    ok(srv.buildRevealSpawn('open', 'C:\\ws\\report.xlsx').mode === 'open', '(f unit) buildRevealSpawn open xlsx: 非可执行不降级');
    // ① 无 token → 403。
    const revNoTok = await postJson(WB_PORT, '/api/file/reveal', { sessionId: sid, path: mdPath, mode: 'select' }, {});
    ok(revNoTok.status === 403, '(f) reveal 无 token → 403');
    // ② 路径越界(工作区外的真实文件)→ 403。
    const revOut = await postJson(WB_PORT, '/api/file/reveal', { sessionId: sid, path: outsideFile, mode: 'open' }, hdr);
    ok(revOut.status === 403 && revOut.json && revOut.json.ok === false, '(f) reveal 越界文件 → 403 拒绝');
    // ③ 不存在的文件(工作区内)→ 404。
    const revMissing = await postJson(WB_PORT, '/api/file/reveal', { sessionId: sid, path: path.join(WS, 'no-such-file.txt'), mode: 'open' }, hdr);
    ok(revMissing.status === 404 && revMissing.json && /不存在/.test(errorText(revMissing.json.error)), '(f) reveal 不存在文件 → 404 人话');
    // ④ 合法(工作区内已存在的 report.md)→ ok:true(spawn explorer, 不真验证弹窗)。
    const revOk = await postJson(WB_PORT, '/api/file/reveal', { sessionId: sid, path: mdPath, mode: 'select' }, hdr);
    ok(revOk.status === 200 && revOk.json && revOk.json.ok === true, '(f) reveal 合法路径 → ok:true');

    // ── (g) v1.5-W1.5 (T3/T4):ACC 写族 bridged 工具 → 产物收割 + 检查点 + 回撤 ─────────────────────────────
    // 单独起一套 workbench(带 fake-mcp 桥)+ fake-openai, 用 FAKE_TOOL_SEQUENCE 让 provider 调
    // `fake__write_docx`(真写文件, 返回 {success:true, path:...}, 无 output_path —— 旧版 ACC 形状)。断言:
    //  ① 该文件进 turn_summary.artifacts(T1 工具名限定的 path 收割命中);
    //  ② GET /api/checkpoints 里有对应 create 条目(T3 快照插在 callTool 之前);
    //  ③ 再写一次同一文件 → 该条目变 modify(存了 before);
    //  ④ POST /api/checkpoints/rollback 能删除/恢复(回撤全绿)。
    {
      const G_HOME = path.join(os.tmpdir(), 'wcw-artifacts-e2e-bridge');
      const G_WS = path.join(G_HOME, 'ws');
      fs.rmSync(G_HOME, { recursive: true, force: true });
      fs.mkdirSync(G_WS, { recursive: true });
      const FAKE_MCP = path.join(HERE, 'fake-mcp.js');
      const G_FAKE_PORT = await getFreePort(), G_WB_PORT = await getFreePort();
      const docxPath = path.join(G_WS, 'made.docx');
      fs.writeFileSync(path.join(G_HOME, 'config.json'), JSON.stringify({
        configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
        defaultWorkspace: G_WS, recentWorkspaces: [],
        providers: [{ id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: 'http://127.0.0.1:' + G_FAKE_PORT, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }] }],
        activeProvider: 'fake',
        externalMcpServers: [{ id: 'fake', label: 'Fake MCP', command: process.execPath, args: [FAKE_MCP], enabled: true }],
        bridgeExternalToolsToProvider: true,
        desktopMcp: { enabled: false, command: '', args: [], cwd: '', autodetect: false },
      }, null, 2));

      // provider 单回合内连调两次 fake__write_docx 到同一路径:第 1 次文件不存在→create;第 2 次已存在→modify
      // (FAKE_TOOL_SEQUENCE 按 history 的 role:'tool' 计数在同一回合内步进两步)。两步同 turnSeq,不同 entrySeq。
      const gseq = JSON.stringify([
        { name: 'fake__write_docx', args: { path: docxPath, content: 'FIRST' } },
        { name: 'fake__write_docx', args: { path: docxPath, content: 'SECOND' } },
      ]);
      const gfake = cp.spawn(process.execPath, [path.join(HERE, 'fake-openai.js')], { env: { ...process.env, FAKE_OPENAI_PORT: String(G_FAKE_PORT), FAKE_TOOL_SEQUENCE: gseq }, windowsHide: true });
      const gwb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(G_WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: G_HOME }, windowsHide: true });
      gwb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[gwb!] ' + l.trim())));
      procs.push(gfake, gwb);
      try {
        let gh = null; for (let i = 0; i < 40 && !gh; i++) { await sleep(150); gh = await health(G_WB_PORT); }
        ok(!!gh, '(g) bridge workbench up on :' + G_WB_PORT);
        const gtok = await getToken(G_WB_PORT);
        const ghdr = { 'x-wcw-token': gtok };
        const gCreated = await postJson(G_WB_PORT, '/api/sessions', { title: 'bridge', cwd: G_WS }, ghdr);
        const gsid = gCreated.json && gCreated.json.session && gCreated.json.session.id;
        ok(!!gsid, '(g) bridge session created');

        // 一个回合内两次写同一 docx(create 后 modify)。
        const gev = await postStream(G_WB_PORT, { sessionId: gsid, message: '写两次 docx', cwd: G_WS });
        const gTu = gev.filter(e => e.type === 'tool_use' && e.name === 'fake__write_docx');
        ok(gTu.length === 2, '(g) provider 两次调用 fake__write_docx(got ' + gTu.length + ')');
        ok(fs.existsSync(docxPath), '(g) made.docx 真被写出');
        ok(fs.readFileSync(docxPath, 'utf8') === 'SECOND', '(g) 末次写覆盖内容为 SECOND');
        const gts = gev.find(e => e.type === 'turn_summary');
        const gArts = (gts && gts.artifacts) || [];
        ok(gArts.some(a => a.path && a.path.replace(/\\/g, '/').endsWith('made.docx')), '① made.docx 进 turn_summary.artifacts(工具名限定 path 收割)');
        ok((gArts.find(a => a.path && a.path.endsWith('made.docx')) || {}).kind === 'docx', '① 收割的 kind === docx');
        // 同 path 两次写 → artifacts 去重只一条。
        ok(gArts.filter(a => a.path && a.path.replace(/\\/g, '/').endsWith('made.docx')).length === 1, '① 同 path 两写 → 产物去重只一条');

        // ② GET /api/checkpoints → 该 path 有两条(create + modify),快照插在 callTool 之前。
        const gcp1 = await getJson(G_WB_PORT, '/api/checkpoints?sessionId=' + gsid, ghdr);
        const gEntries = (gcp1.json && Array.isArray(gcp1.json.entries) ? gcp1.json.entries : []).filter(e => e.path === path.resolve(docxPath));
        ok(gEntries.length === 2, '② journal 有 2 条 made.docx 条目(create+modify, got ' + gEntries.length + ')');
        const gCreate = gEntries.find(e => e.op === 'create');
        const gModify = gEntries.find(e => e.op === 'modify');
        ok(!!gCreate, '② 首写 → op:create(文件此前不存在)');
        ok(!!gModify && !gModify.skipped && Number(gModify.bytes) > 0, '② 次写 → op:modify 且存了 before 字节(可回撤)');
        ok(gCreate && gModify && gCreate.turnSeq === gModify.turnSeq, '② 两条同 turnSeq(同一回合两步)');
        const gTurnSeq = gModify.turnSeq;

        // ③ 单条回撤(entrySeq)modify → 内容回到 FIRST(单文件撤销语义)。
        const gRb = await postJson(G_WB_PORT, '/api/checkpoints/rollback', { sessionId: gsid, turnSeq: gTurnSeq, entrySeq: gModify.entrySeq }, ghdr);
        ok(gRb.json && gRb.json.ok === true, '③ rollback(单条 modify)ok');
        ok(fs.readFileSync(docxPath, 'utf8') === 'FIRST', '③ 回撤 modify → 内容恢复为 FIRST');

        // ④ 再回撤 create(整轮剩余)→ 文件被删除。
        const gRb2 = await postJson(G_WB_PORT, '/api/checkpoints/rollback', { sessionId: gsid, turnSeq: gTurnSeq }, ghdr);
        ok(gRb2.json && gRb2.json.ok === true, '④ rollback(create)ok');
        ok(!fs.existsSync(docxPath), '④ 回撤 create → made.docx 被删除(文件消失)');
      } finally {
        killp(gfake); killp(gwb);
        await sleep(300);
        fs.rmSync(G_HOME, { recursive: true, force: true });
      }
    }
  } catch (e) { console.log('ERROR ' + (e && e.stack || e.message || e)); fail++; }
  finally {
    for (const c of procs) killp(c);
    await sleep(300);
    fs.rmSync(HOME, { recursive: true, force: true });
    fs.rmSync(OUTSIDE, { recursive: true, force: true });
    console.log('\nARTIFACTS E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
