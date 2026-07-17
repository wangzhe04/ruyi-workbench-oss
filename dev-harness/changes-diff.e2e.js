(async () => {
// E2E (v1.4.1):变更「查看改动」—— GET /api/checkpoints/diff 端点。造一个文本 modify 检查点(手写 journal
// index + .gz 快照 + 当前文件)+ 一个二进制 modify(含 NUL 字节),验:
//   (a) token 门:无 token → 403;
//   (b) 文本:isText=true,before 含旧内容、after 含新内容,beforeBytes/afterBytes 正确;
//   (c) 二进制(含 NUL)→ isText=false / binary=true,只给字节数不给内容;
//   (d) 不存在的 entry → 404。
// 零依赖、离线、node 直跑。判定行:`CHANGES-DIFF E2E: ALL PASS`。
'use strict';
const cp = require('child_process'), http = require('http'), path = require('path'), fs = require('fs'), os = require('os'), zlib = require('zlib');
const { getFreePort } = require('./free-port.js');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const PORT = await getFreePort();
const HOME = path.join(os.tmpdir(), 'wcw-changes-diff-e2e');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ configSchema: 7, version: '1.0.0', permissionMode: 'bypass' }, null, 2));

// --- fixture: a work dir + a session's checkpoint journal ---
const SID = 'session_difftest01';
const workDir = path.join(HOME, 'work'); fs.mkdirSync(workDir, { recursive: true });
const txtPath = path.join(workDir, 'notes.txt');
const binPath = path.join(workDir, 'book.xlsx');
const beforeText = 'line1\nline2-OLD\nline3\nline4\n';
const afterText = 'line1\nline2-NEW-CHANGED\nline3\nline4\nline5-added\n';
fs.writeFileSync(txtPath, afterText, 'utf8');                                   // 当前(改动后)
fs.writeFileSync(binPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x00]));  // 含 NUL 的二进制当前文件
const cpDir = path.join(HOME, 'checkpoints', SID); fs.mkdirSync(cpDir, { recursive: true });
fs.writeFileSync(path.join(cpDir, '1-0.gz'), zlib.gzipSync(Buffer.from(beforeText, 'utf8')));        // 文本 before
fs.writeFileSync(path.join(cpDir, '1-1.gz'), zlib.gzipSync(Buffer.from([0x50, 0x4b, 0x00, 0x99]))); // 二进制 before(含 NUL)
fs.writeFileSync(path.join(cpDir, 'index.json'), JSON.stringify([
  { turnSeq: 1, entrySeq: 0, tool: 'file_edit', path: txtPath, op: 'modify', bytes: Buffer.byteLength(beforeText), ts: new Date().toISOString() },
  { turnSeq: 1, entrySeq: 1, tool: 'ai_computer_control__excel_beautify', path: binPath, op: 'modify', bytes: 4, ts: new Date().toISOString() },
], null, 2));

const sleep = ms => new Promise(r => setTimeout(r, ms));
function health(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); }); r.on('error', () => res(null)); r.on('timeout', () => { r.destroy(); res(null); }); }); }
function getToken(port) { return new Promise(res => { const r = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, resp => { let b = ''; resp.on('data', c => (b += c)); resp.on('end', () => { const m = b.match(/name="wcw-token"\s+content="([a-f0-9]+)"/); res(m ? m[1] : ''); }); }); r.on('error', () => res('')); r.on('timeout', () => { r.destroy(); res(''); }); }); }
function getJson(port, p, headers) { return new Promise(resolve => { const r = http.get({ host: '127.0.0.1', port, path: p, timeout: 4000, headers: headers || {} }, res => { let b = ''; res.on('data', c => (b += c)); res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); }); }); r.on('error', () => resolve({ status: 0, json: null })); r.on('timeout', () => { r.destroy(); resolve({ status: 0, json: null }); }); }); }

(async () => {
  let fail = 0; const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };
  const wb = cp.spawn(process.execPath, ['app/server.js', 'serve', '--port', String(PORT)], { cwd: WB, env: { ...process.env, RUYI_HOME: HOME }, windowsHide: true });
  wb.stderr.on('data', d => String(d).split(/\r?\n/).forEach(l => l.trim() && console.log('[wb!] ' + l.trim())));
  try {
    let h = null; for (let i = 0; i < 40 && !h; i++) { await sleep(150); h = await health(PORT); }
    ok(!!h, 'workbench listening');
    const tok = await getToken(PORT);
    const base = `/api/checkpoints/diff?sessionId=${SID}`;
    // (a) 无 token → 403
    const noTok = await getJson(PORT, `${base}&turnSeq=1&entrySeq=0`, {});
    ok(noTok.status === 403, '(a) 无 token → 403');
    // (b) 文本 diff
    const txt = await getJson(PORT, `${base}&turnSeq=1&entrySeq=0`, { 'x-wcw-token': tok });
    const d = txt.json || {};
    ok(txt.status === 200 && d.ok === true && d.isText === true, '(b) 文本条目 isText=true');
    ok(typeof d.before === 'string' && d.before.includes('line2-OLD'), '(b) before 含旧内容 line2-OLD');
    ok(typeof d.after === 'string' && d.after.includes('line2-NEW-CHANGED') && d.after.includes('line5-added'), '(b) after 含新内容');
    ok(d.beforeBytes === Buffer.byteLength(beforeText) && d.afterBytes === Buffer.byteLength(afterText), '(b) beforeBytes/afterBytes 正确');
    // (c) 二进制(含 NUL)→ 不给内容
    const bin = await getJson(PORT, `${base}&turnSeq=1&entrySeq=1`, { 'x-wcw-token': tok });
    const b = bin.json || {};
    ok(bin.status === 200 && b.ok === true && b.isText === false && b.binary === true, '(c) 二进制条目 isText=false/binary=true');
    ok(b.before === undefined && b.after === undefined, '(c) 二进制不返回文本内容');
    // (d) 不存在 → 404
    const miss = await getJson(PORT, `${base}&turnSeq=9&entrySeq=9`, { 'x-wcw-token': tok });
    ok(miss.status === 404, '(d) 不存在的 entry → 404');
  } catch (e) { console.log('ERROR ' + e.message); fail++; }
  finally {
    if (wb && wb.pid) { try { cp.execFileSync('taskkill', ['/PID', String(wb.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    await sleep(300); fs.rmSync(HOME, { recursive: true, force: true });
    console.log('\nCHANGES-DIFF E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
    process.exitCode = fail ? 1 : 0;
  }
})();

})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
