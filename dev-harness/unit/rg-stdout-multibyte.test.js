'use strict';
// Unit(走查 W1·F3):rg 子进程 stdout 的块边界落在多字节字符中间时,不再把字符劈成 U+FFFD。
// 修前 searchFileContentRg / rgListHighByteFiles 逐块 `d.toString('utf8')` 再拼,管道块大小由 OS 定,
// 长输出里中文路径 / 命中行在块边界处必现乱码。这里用一个【假 rg】(RUYI_RG_PATH 指向的脚本)把输出
// 故意切在汉字的字节中间、两次 write 之间隔一拍,确定性复现:
//   [R1] --json 主搜索:命中的相对路径与命中行文本完整(无 U+FFFD)。
//   [R2] -l 高字节文件清单(非 ASCII 模式触发的 GBK 补扫入口):路径完整,补扫才找得到真文件、按 GBK 解出命中。
// 假 rg 是带 shebang 的脚本,Windows 上起不了 → 仅非 Windows 跑(修法本身与平台无关)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-rg-multibyte-unit-'));
const SKIP = process.platform === 'win32' ? 'fake rg is a shebang script' : false;
const DIR_NAME = '中文目录';
const ws = path.join(root, 'ws');
fs.mkdirSync(path.join(ws, DIR_NAME), { recursive: true });
// 命中的真文件:GBK 编码的「你好 world」(C4 E3 BA C3 = 你好),与 UTF-8 的 测试.txt
fs.writeFileSync(path.join(ws, DIR_NAME, 'gbk.txt'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x20, 0x77, 0x6f, 0x72, 0x6c, 0x64, 0x0a]));
fs.writeFileSync(path.join(ws, DIR_NAME, '测试.txt'), '你好 world\n');

const fakeRg = path.join(root, 'fake-rg');
fs.writeFileSync(fakeRg, `#!${process.execPath}
'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
if (args.includes('--version')) { process.stdout.write('ripgrep 14.0.0\\n'); process.exit(0); }
const base = args[args.length - 1];
// 把 buf 切在第一个汉字(0xE4..)的第二个字节之前,分两次写出,中间隔一拍。
function writeSplit(buf, done) {
  const at = buf.indexOf(0xe4) + 1;
  fs.writeSync(1, buf.subarray(0, at));
  setTimeout(() => { fs.writeSync(1, buf.subarray(at)); done(); }, 80);
}
if (args.includes('-l')) {
  writeSplit(Buffer.from(base + '/${DIR_NAME}/gbk.txt\\n', 'utf8'), () => process.exit(0));
} else if (process.env.FAKE_RG_MATCH === '1') {
  const file = base + '/${DIR_NAME}/测试.txt';
  const ev = (type, data) => JSON.stringify({ type, data }) + '\\n';
  const out = ev('begin', { path: { text: file } })
    + ev('match', { path: { text: file }, lines: { text: '你好 world\\n' }, line_number: 1, absolute_offset: 0, submatches: [] })
    + ev('end', { path: { text: file } });
  writeSplit(Buffer.from(out, 'utf8'), () => process.exit(0));
} else {
  process.exit(1);   // 无命中
}
`);
fs.chmodSync(fakeRg, 0o755);
process.env.RUYI_RG_PATH = fakeRg;
process.env.RUYI_HOME = path.join(root, 'data');
process.env.WIN_CLAUDE_WORKBENCH_HOME = process.env.RUYI_HOME;
process.env.HOME = root;
process.env.USERPROFILE = root;
const srv = require(path.resolve(__dirname, '../../ruyi-workbench/app/server.js'));
after(() => { try { srv.killAllMcpClients && srv.killAllMcpClients(); } catch { /* ignore */ } try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });
const ctx = { sessionId: 'sess_rg_mb', session: { id: 'sess_rg_mb', cwd: ws }, workingDir: ws, config: {} };

test('[R0] 前置:服务确实用了假 rg', { skip: SKIP }, async () => {
  const info = await srv.probeRgAsync();
  assert.ok(info && info.path === fakeRg, `probe 应选中 RUYI_RG_PATH(got ${JSON.stringify(info)})`);
});

test('[R1] --json 主搜索:切在汉字中间的块拼回完整路径与命中行', { skip: SKIP }, async () => {
  process.env.FAKE_RG_MATCH = '1';
  try {
    const r = await srv.toolCall('file_search', { pattern: 'world', path: ws }, ctx);
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.equal(r.engine, 'rg', `应走 rg 路径(got engine=${r.engine})`);
    const hit = (r.results || r.matches || [])[0];
    assert.ok(hit, `应有一条命中(got ${JSON.stringify(r).slice(0, 300)})`);
    const rel = String(hit.relativePath || hit.path).split(path.sep).join('/');
    assert.equal(rel.replace(/^.*(?=中文目录)/, ''), '中文目录/测试.txt', `路径不应含 U+FFFD(got ${JSON.stringify(rel)})`);
    assert.ok(!JSON.stringify(r).includes('�'), '整个结果里没有 U+FFFD');
    assert.equal(hit.text, '你好 world');
  } finally { delete process.env.FAKE_RG_MATCH; }
});

test('[R2] -l 高字节文件清单:路径完整,GBK 补扫找得到真文件', { skip: SKIP }, async () => {
  const r = await srv.toolCall('file_search', { pattern: '你好', path: ws }, ctx);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  const list = r.results || r.matches || [];
  assert.ok(list.some(h => /gbk\.txt$/.test(String(h.relativePath || h.path))),
    `GBK 补扫应命中 ${DIR_NAME}/gbk.txt(修前清单里的路径带 U+FFFD,找不到文件;got ${JSON.stringify(r).slice(0, 400)})`);
  assert.ok(!JSON.stringify(r).includes('�'), '整个结果里没有 U+FFFD');
});
