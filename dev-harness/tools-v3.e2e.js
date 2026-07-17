// E2E (v1.1-W2 T1): tool suite v3 — the five new built-in tools (file_move / file_copy / archive_zip /
// archive_unzip / http_download) + their trust-layer wiring (checkpoint journal + rollback).
// Offline where possible; http_download uses a LOCAL fake http server (public 127.0.0.1 target passes SSRF's
// literal check — SSRF rejection is asserted separately with an internal-name/private target).
//
// Coverage:
//   (a) file_move rename → checkpoint has from(delete)+to(create); rollback restores from, removes to.
//   (b) file_move across folders + overwrite refused when to exists & overwrite=false.
//   (c) file_copy create + rollback removes the copy (from untouched).
//   (d) archive_zip → archive_unzip round-trip: content identical incl. a CHINESE filename.
//   (e) Zip Slip: a hand-built zip with a `..\` entry is rejected WHOLE (no file written outside destDir).
//   (f) zip bomb: entry-count over the 2000 cap is refused.
//   (g) http_download from fake server → file saved, bytes match; checkpoint create entry present.
//   (h) http_download SSRF: an internal/private target is refused (ok:false, blocked).
//   (i) http_download over-size (maxBytes) → refused.
// Drives tools directly via POST /api/tools/<name> with a real session so journaling is anchored.
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os');
const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const SERVER = path.join(WB, 'app', 'server.js');
const HOME = path.join(os.tmpdir(), 'wcw-tools-v3-e2e');
const WB_PORT = await getFreePort(), DL_PORT = await getFreePort();

// Reuse the server's own exported codec for building fixtures (Zip Slip / round-trip bytes).
const S = require(SERVER);

const { getFreePort } = require('./free-port.js');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise((resolve, reject) => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { resolve({ status: resp.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); }); r.on('error', reject); r.on('timeout', () => { r.destroy(); reject(new Error('timeout')); }); }); }
function postJson(port, p, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) } }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { reject(new Error('bad json: ' + b)); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}
// POST /api/tools/<name> with the session so journaling anchors. Returns the inner .result.
async function tool(port, token, sid, name, args) {
  const r = await postJson(port, '/api/tools/' + name, { sessionId: sid, ...args }, { 'x-wcw-token': token });
  return r.body && r.body.result;
}
function killp(c) { if (c && c.pid) { try { cp.execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ } } }

(async () => {
  let fail = 0;
  const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  fs.rmSync(HOME, { recursive: true, force: true }); fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass' }, null, 2));

  // ---- fake download server: /small (12 bytes), /big (5MB) ----
  const BIG = Buffer.alloc(5 * 1024 * 1024, 0x41);
  const dl = http.createServer((req, res) => {
    if (req.url === '/small') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 12 }); res.end(Buffer.from('hello-world!', 'utf8')); return; }
    if (req.url === '/big') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIG.length }); res.end(BIG); return; }
    res.writeHead(404); res.end('no');
  });
  await new Promise(r => dl.listen(DL_PORT, '127.0.0.1', r));

  // WCW_TEST_ALLOW_LOOPBACK=1 lets http_download's SSRF-guarded fetch reach the 127.0.0.1 fake server for the
  // happy-path/over-size cases. It exempts 127.x ONLY — the SSRF-refusal case (h) still uses foo.internal /
  // localhost, which stay blocked even with the flag on, so the guard is still genuinely exercised.
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(WB_PORT)], { cwd: WB, env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, WCW_TEST_ALLOW_LOOPBACK: '1' }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));

  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(WB_PORT); }
    ok(!!h, 'workbench up on :' + WB_PORT);
    const token = await getToken(WB_PORT);
    ok(!!token, 'UI token scraped');
    const created = await postJson(WB_PORT, '/api/sessions', { title: 'tools-v3', cwd: HOME });
    const sid = created.body.session && created.body.session.id;
    ok(!!sid, 'session created');
    const cps = () => getJson(WB_PORT, '/api/checkpoints?sessionId=' + sid, { 'x-wcw-token': token }).then(r => r.body.entries || []);

    // ============ (a) file_move rename → checkpoint from(delete)+to(create); rollback ============
    {
      const from = path.join(HOME, 'a-src.txt'), to = path.join(HOME, 'a-dst.txt');
      fs.writeFileSync(from, 'move-me');
      const r = await tool(WB_PORT, token, sid, 'file_move', { from, to, turnSeq: 10 });
      ok(r && r.ok === true && r.op === 'move', '(a) file_move ok');
      ok(!fs.existsSync(from) && fs.readFileSync(to, 'utf8') === 'move-me', '(a) file physically moved (from gone, to has content)');
      const e = (await cps()).filter(x => x.turnSeq === 10);
      ok(e.some(x => x.tool === 'file_move' && x.op === 'delete' && x.path === from), '(a) checkpoint: from op:delete');
      ok(e.some(x => x.tool === 'file_move' && x.op === 'create' && x.path === to), '(a) checkpoint: to op:create');
      // rollback whole turn 10 → from restored, to removed
      const rb = await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq: 10 }, { 'x-wcw-token': token });
      ok(rb.body.ok === true, '(a) rollback turn 10 ok');
      ok(fs.existsSync(from) && fs.readFileSync(from, 'utf8') === 'move-me', '(a) rollback restored `from`');
      ok(!fs.existsSync(to), '(a) rollback removed `to` (create inverse = delete)');
    }

    // ============ (b) move across folders + overwrite refuse ============
    {
      const from = path.join(HOME, 'b-src.txt');
      const sub = path.join(HOME, 'bsub'); fs.mkdirSync(sub, { recursive: true });
      const to = path.join(sub, 'b-dst.txt');
      fs.writeFileSync(from, 'cross');
      const r1 = await tool(WB_PORT, token, sid, 'file_move', { from, to, turnSeq: 11 });
      ok(r1 && r1.ok === true && fs.readFileSync(to, 'utf8') === 'cross', '(b) move into subfolder ok');
      // now a new source, try to move onto existing `to` without overwrite → refused
      const from2 = path.join(HOME, 'b-src2.txt'); fs.writeFileSync(from2, 'other');
      const r2 = await tool(WB_PORT, token, sid, 'file_move', { from: from2, to, turnSeq: 11 });
      ok(r2 && r2.ok === false && /已存在/.test(r2.error || ''), '(b) overwrite refused when to exists & overwrite=false');
      ok(fs.existsSync(from2) && fs.readFileSync(to, 'utf8') === 'cross', '(b) refused move left both files untouched');
      // with overwrite=true it goes through, and `to` before-content is snapshotted (op:modify)
      const r3 = await tool(WB_PORT, token, sid, 'file_move', { from: from2, to, overwrite: true, turnSeq: 12 });
      ok(r3 && r3.ok === true && r3.overwritten === true && fs.readFileSync(to, 'utf8') === 'other', '(b) overwrite=true moves & overwrites');
      const e12 = (await cps()).filter(x => x.turnSeq === 12);
      ok(e12.some(x => x.tool === 'file_move' && x.op === 'modify' && x.path === to), '(b) overwrite: to snapshotted op:modify');
    }

    // ============ (c) file_copy create + rollback removes copy, from untouched ============
    {
      const from = path.join(HOME, 'c-src.txt'), to = path.join(HOME, 'c-copy.txt');
      fs.writeFileSync(from, 'copy-me');
      const r = await tool(WB_PORT, token, sid, 'file_copy', { from, to, turnSeq: 20 });
      ok(r && r.ok === true && r.op === 'copy', '(c) file_copy ok');
      ok(fs.readFileSync(from, 'utf8') === 'copy-me' && fs.readFileSync(to, 'utf8') === 'copy-me', '(c) both files present with same content');
      const e = (await cps()).filter(x => x.turnSeq === 20);
      ok(e.some(x => x.tool === 'file_copy' && x.op === 'create' && x.path === to), '(c) checkpoint: copy op:create');
      const rb = await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq: 20 }, { 'x-wcw-token': token });
      ok(rb.body.ok === true && !fs.existsSync(to) && fs.existsSync(from), '(c) rollback removed copy, left source');
    }

    // ============ (d) archive_zip → archive_unzip round-trip incl. Chinese filename ============
    {
      const srcDir = path.join(HOME, 'zsrc'); fs.mkdirSync(path.join(srcDir, '子目录'), { recursive: true });
      fs.writeFileSync(path.join(srcDir, '你好.txt'), '中文内容-hello', 'utf8');
      fs.writeFileSync(path.join(srcDir, '子目录', 'inner.bin'), Buffer.from([1, 2, 3, 250, 251]));
      const zip = path.join(HOME, 'out.zip');
      const rz = await tool(WB_PORT, token, sid, 'archive_zip', { paths: [srcDir], dest: zip, turnSeq: 30 });
      ok(rz && rz.ok === true && rz.files >= 2, '(d) archive_zip ok (' + (rz && rz.files) + ' files)');
      ok(fs.existsSync(zip), '(d) zip file written');
      const ez = (await cps()).filter(x => x.turnSeq === 30);
      ok(ez.some(x => x.tool === 'archive_zip' && x.op === 'create' && x.path === zip), '(d) checkpoint: zip op:create');
      const outDir = path.join(HOME, 'zout');
      const ru = await tool(WB_PORT, token, sid, 'archive_unzip', { src: zip, destDir: outDir, turnSeq: 31 });
      ok(ru && ru.ok === true, '(d) archive_unzip ok');
      const outCh = path.join(outDir, 'zsrc', '你好.txt');
      const outBin = path.join(outDir, 'zsrc', '子目录', 'inner.bin');
      ok(fs.existsSync(outCh) && fs.readFileSync(outCh, 'utf8') === '中文内容-hello', '(d) round-trip: Chinese filename + content identical');
      ok(fs.existsSync(outBin) && Buffer.compare(fs.readFileSync(outBin), Buffer.from([1, 2, 3, 250, 251])) === 0, '(d) round-trip: nested binary identical');
      const eu = (await cps()).filter(x => x.turnSeq === 31);
      ok(eu.some(x => x.tool === 'archive_unzip' && x.op === 'create' && x.path === outCh), '(d) checkpoint: unzipped file op:create');
    }

    // ============ (e) Zip Slip: hand-built zip with ..\ entry rejected WHOLE ============
    {
      // Build a malicious zip using the server's own writer (byte-accurate), with a traversal entry.
      const evil = S.zipWrite([
        { name: '../../slip-escape.txt', data: Buffer.from('PWNED'), isDir: false },
        { name: 'ok.txt', data: Buffer.from('ok'), isDir: false },
      ]);
      const evilZip = path.join(HOME, 'evil.zip'); fs.writeFileSync(evilZip, evil);
      const outDir = path.join(HOME, 'evilout');
      const escapedTarget = path.resolve(HOME, 'slip-escape.txt'); // where ../../ would land relative to evilout
      const r = await tool(WB_PORT, token, sid, 'archive_unzip', { src: evilZip, destDir: outDir, turnSeq: 40 });
      ok(r && r.ok === false && /Zip Slip|越界/.test(r.error || ''), '(e) Zip Slip rejected (ok:false, 人话 error)');
      ok(!fs.existsSync(escapedTarget), '(e) NO file written outside destDir (escape blocked)');
      ok(!fs.existsSync(path.join(outDir, 'ok.txt')), '(e) whole archive rejected — even the safe entry not extracted');
      const e40 = (await cps()).filter(x => x.turnSeq === 40);
      ok(e40.length === 0, '(e) no checkpoint entries for a rejected malicious archive');
    }

    // ============ (f) zip bomb: entry-count over 2000 cap refused ============
    {
      // 2001 tiny empty entries — over ZIP_MAX_ENTRIES (2000).
      const many = [];
      for (let i = 0; i < 2001; i++) many.push({ name: 'f' + i + '.txt', data: Buffer.from(''), isDir: false });
      const bomb = S.zipWrite(many);
      const bombZip = path.join(HOME, 'bomb.zip'); fs.writeFileSync(bombZip, bomb);
      const r = await tool(WB_PORT, token, sid, 'archive_unzip', { src: bombZip, destDir: path.join(HOME, 'bombout'), turnSeq: 41 });
      ok(r && r.ok === false && /条目数超过上限|炸弹/.test(r.error || ''), '(f) entry-count over cap refused (' + (r && r.error) + ')');
    }

    // ============ (g) http_download from fake server → saved; checkpoint create ============
    {
      const dest = path.join(HOME, 'downloaded.bin');
      const r = await tool(WB_PORT, token, sid, 'http_download', { url: 'http://127.0.0.1:' + DL_PORT + '/small', dest, turnSeq: 50 });
      ok(r && r.ok === true && r.bytes === 12, '(g) http_download ok, bytes=12 (' + JSON.stringify(r && { ok: r.ok, bytes: r.bytes, error: r.error }) + ')');
      ok(fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === 'hello-world!', '(g) file content matches server');
      const e = (await cps()).filter(x => x.turnSeq === 50);
      ok(e.some(x => x.tool === 'http_download' && x.op === 'create' && x.path === dest), '(g) checkpoint: download op:create');
      // rollback removes the downloaded file
      const rb = await postJson(WB_PORT, '/api/checkpoints/rollback', { sessionId: sid, turnSeq: 50 }, { 'x-wcw-token': token });
      ok(rb.body.ok === true && !fs.existsSync(dest), '(g) rollback removed the downloaded file');
    }

    // ============ (h) http_download SSRF: internal target refused ============
    {
      const dest = path.join(HOME, 'ssrf.bin');
      // A .internal suffix name is refused by ssrfCheck's literal rule (no socket, no DNS needed).
      const r = await tool(WB_PORT, token, sid, 'http_download', { url: 'http://foo.internal/x', dest, turnSeq: 51 });
      ok(r && r.ok === false && !!r.blocked, '(h) SSRF internal target refused (ok:false, blocked set)');
      ok(!fs.existsSync(dest), '(h) no file written on SSRF refusal');
      // localhost literal also refused
      const r2 = await tool(WB_PORT, token, sid, 'http_download', { url: 'http://localhost/x', dest, turnSeq: 51 });
      ok(r2 && r2.ok === false && !!r2.blocked, '(h) SSRF localhost refused');
    }

    // ============ (i) http_download over-size (maxBytes) refused ============
    {
      const dest = path.join(HOME, 'toobig.bin');
      // /big is 5MB; cap maxBytes at 1MB → Content-Length pre-reject.
      const r = await tool(WB_PORT, token, sid, 'http_download', { url: 'http://127.0.0.1:' + DL_PORT + '/big', dest, maxBytes: 1024 * 1024, turnSeq: 52 });
      ok(r && r.ok === false && /上限|超过/.test(r.error || ''), '(i) over-size download refused (' + (r && r.error) + ')');
      ok(!fs.existsSync(dest), '(i) no half-file left on over-size refusal');
    }

    // ============ (j) 收官加固防回潮:单条目 zip 炸弹在 inflate 层被硬上限拦截 ============
    // 高压缩比【单个】条目(501MB 零字节 → deflate 后 ~500KB)必须在 zipReadEntryData 的 maxOutputLength
    // 处被拒 —— 没有该上限时,累计限额检查发生在全量展开【之后】,内存先被吃爆。直接单测导出的读取器。
    {
      const srv2 = require(path.join(WB, 'app', 'server.js'));
      const zlib2 = require('zlib');
      const bombPlain = Buffer.alloc(501 * 1024 * 1024); // 略超 ZIP_MAX_TOTAL(500MB)
      const zipBuf = srv2.zipWrite([{ name: 'bomb.bin', data: bombPlain }]);
      ok(zipBuf.length < 2 * 1024 * 1024, '(j) 炸弹压缩体确实很小 (' + zipBuf.length + 'B) — 高压缩比成立');
      const recs = srv2.zipReadCentralDir(zipBuf);
      ok(recs.length === 1, '(j) central dir 读到 1 条');
      let threw = null;
      try { srv2.zipReadEntryData(zipBuf, recs[0]); } catch (e) { threw = e; }
      ok(!!threw && /炸弹|上限/.test(String(threw && threw.message || '')), '(j) 单条目 inflate 超限即抛人话拒绝 (' + String(threw && threw.message || '未抛!').slice(0, 60) + ')');
      // 对照组:正常小条目照常可读(加固不破坏正路)。
      const okZip = srv2.zipWrite([{ name: '正常.txt', data: Buffer.from('内容OK', 'utf8') }]);
      const okRecs = srv2.zipReadCentralDir(okZip);
      const okData = srv2.zipReadEntryData(okZip, okRecs[0]);
      ok(okData.toString('utf8') === '内容OK', '(j) 对照组小条目读取不受影响');
      zlib2.deflateRawSync(Buffer.alloc(1)); // keep zlib2 referenced (lint-free)
    }

    // ============ (k) v1.2 Office 产出规程·工具层软闸(script_run 手写 Office 被拦,force 泄压) ============
    {
      // ① 含 Office 库 + Office 扩展名的脚本 → 拒绝 + 配方引导(不执行)。
      const blocked = await tool(WB_PORT, token, sid, 'script_run', { language: 'python', code: "import openpyxl\nwb = openpyxl.Workbook()\nwb.save('report.xlsx')\n", turnSeq: 60 });
      ok(blocked && blocked.ok === false && /现成工具|write_excel/.test(blocked.error || ''), '(k) 手写 Office 脚本被软闸拦截 + 配方引导');
      ok(/工具层强制/.test(blocked.hint || ''), '(k) hint 标注工具层强制');
      // ② force:true → 泄压放行(特殊需求通道;代码里仅注释含关键词,实际只 print)。
      const forced = await tool(WB_PORT, token, sid, 'script_run', { language: 'python', code: "# openpyxl demo: would write data.xlsx\nprint('FORCE-OK')\n", force: true, turnSeq: 61 });
      ok(forced && forced.ok !== false && /FORCE-OK/.test(String(forced.stdout || '')), '(k) force:true 放行执行 (' + JSON.stringify((forced && (forced.stdout || forced.error) || '').slice(0, 40)) + ')');
      // ③ 无 Office 意图的普通脚本完全不受影响。
      const plain = await tool(WB_PORT, token, sid, 'script_run', { language: 'python', code: "print('plain-run')\n", turnSeq: 62 });
      ok(plain && plain.ok !== false && /plain-run/.test(String(plain.stdout || '')), '(k) 普通脚本不受软闸影响');
      // ④ v1.2 缝隙收口:桥接终端命令(run_command 等)内联手写 Office → 同款软闸(纯函数直测)。
      const srvG = require(path.join(WB, 'app', 'server.js'));
      const g1 = srvG.bridgedOfficeScriptGate('acc__run_command', { command: 'python -c "import openpyxl; wb=openpyxl.Workbook(); wb.save(\'out.xlsx\')"' });
      ok(g1 && g1.ok === false && /现成工具/.test(g1.error || ''), '(k) 桥接 run_command 内联 Office → 拦截');
      ok(srvG.bridgedOfficeScriptGate('acc__run_command', { command: 'python -c "print(1)"' }) === null, '(k) 桥接普通命令 → 放行');
      ok(srvG.bridgedOfficeScriptGate('acc__run_command', { command: 'python -c "import openpyxl; save(\'x.xlsx\')"', force: true }) === null, '(k) 桥接 force:true → 泄压放行');
      ok(srvG.bridgedOfficeScriptGate('acc__write_excel', { path: 'C:/x.xlsx' }) === null, '(k) 非终端类工具不经此闸(write_excel 走正门)');
    }

  } catch (e) { console.log('ERROR ' + (e && e.stack || e)); fail++; }
  finally {
    killp(wb);
    try { dl.close(); } catch { /* ignore */ }
    await sleep(200);
    fs.rmSync(HOME, { recursive: true, force: true });
  }
  console.log('\nTOOLS-V3 E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
  process.exitCode = fail ? 1 : 0;
})();
