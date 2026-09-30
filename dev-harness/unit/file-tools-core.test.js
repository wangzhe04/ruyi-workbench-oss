// Unit(tools-opt · files-core):单文件工具(file_read / file_write / file_edit / file_delete / file_move / file_copy)的
// 优化批回归。每条都对应审计里实测过的缺陷,修法的注释在 app/src/12-tool-dispatch.js 与 11b-file-text-io.js(搜 F1/F3/F4/F5/F6/F10/F11/F15)。
//
//   F1  相对路径按会话工作区解析(不是服务进程的 cwd),报错里的 path 是解析后的绝对路径;
//   F3  file_read 解 GBK / UTF-16(BOM) / UTF-8 BOM,报 encoding;无扩展名二进制被拒;file_edit / file_write 保原编码/BOM/换行;
//   F4  file_read 默认预算让模型看到的 = 工具返回的(序列化 <= 60000),truncated 时给 nextOffset/nextLine 可接着读;有界读不整文件读入;
//   F5  non_ascii 只报真可疑字符(中文文件不再白加 ~51%),优先级在全部命中上排;
//   F6  file_edit 未命中:空白差异专门诊断、整段 oldText 最接近窗口、多命中列行号、信封带 path/hint;
//   F10 file_delete 大于 5MB 也删(带 checkpointWarn),且不整文件读入;
//   F11 原子写 + 瞬时锁重试、写失败不留幽灵检查点、EISDIR/ENOSPC 有 hint;
//   F15 totalLines 无幽灵末行;file_write 覆盖大文件不整文件读入。
'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');   // 与 server.js 里的 fsp 是同一个对象 —— 卡子装在它的属性上
const os = require('os');
const path = require('path');
const { describe, it, after } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-file-tools-core-'));
const home = path.join(root, 'home');
const dataRootDir = path.join(home, '.ruyi-workbench');
fs.mkdirSync(dataRootDir, { recursive: true });
process.env.WIN_CLAUDE_WORKBENCH_HOME = dataRootDir;
process.env.RUYI_HOME = dataRootDir;
const repo = path.resolve(__dirname, '../..');
// RUYI_TEST_SERVER_JS 仅用于「改前/改后」对照跑(指向另一份构建产物);缺省就是本仓产物。
const srv = require(process.env.RUYI_TEST_SERVER_JS || path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

let wsSeq = 0;
function freshWs() {
  const ws = path.join(home, 'proj' + (++wsSeq));
  fs.mkdirSync(ws, { recursive: true });
  return ws;
}
const ctxFor = (ws, sessionId, turnSeq) => ({ sessionId, turnSeq, workingDir: ws, session: { cwd: ws }, config: {} });
const indexOf = sid => {
  try { return JSON.parse(fs.readFileSync(path.join(dataRootDir, 'checkpoints', sid, 'index.json'), 'utf8')); } catch { return []; }
};
const tc = (name, args, ws, sid, turn) => srv.toolCall(name, args, ctxFor(ws, sid || 'sess_core_' + name, turn || 1));

// fs/promises 上的一次性/永久卡子。match(...args) 命中时抛 errno 错误(times 次;Infinity = 永久)。
function failHook(method, match, code, times) {
  const original = fsp[method];
  let left = times === undefined ? 1 : times;
  let hits = 0;
  fsp[method] = function patched(...args) {
    if (left > 0 && match(...args)) {
      left -= 1; hits += 1;
      const e = new Error(`${code}: injected`); e.code = code;
      return Promise.reject(e);
    }
    return original.apply(this, args);
  };
  return { restore() { fsp[method] = original; }, get hits() { return hits; } };
}
function spyHook(method, match) {
  const original = fsp[method];
  const calls = [];
  fsp[method] = function patched(...args) {
    if (match(...args)) calls.push(args);
    return original.apply(this, args);
  };
  return { restore() { fsp[method] = original; }, calls };
}

describe('单文件工具优化批(files-core)', () => {
  it('F1 相对路径按会话工作区解析:读/写/改/删/移/复制;报错名的是解析后的路径', async () => {
    const ws = freshWs();
    fs.writeFileSync(path.join(ws, 'notes.txt'), 'hello\nworld\n');
    const cwdBefore = process.cwd();
    const r = await tc('file_read', { path: 'notes.txt' }, ws);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.content, 'hello\nworld\n');
    assert.equal(r.path, path.join(ws, 'notes.txt'));
    const w = await tc('file_write', { path: 'sub/rel.txt', content: 'x' }, ws);
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.ok(fs.existsSync(path.join(ws, 'sub', 'rel.txt')), '相对写落在工作区');
    assert.equal(fs.existsSync(path.join(cwdBefore, 'sub', 'rel.txt')), false, '不能落进服务进程的 cwd');
    const e = await tc('file_edit', { path: 'notes.txt', oldText: 'world', newText: 'there' }, ws);
    assert.equal(e.ok, true, JSON.stringify(e));
    assert.equal(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8'), 'hello\nthere\n');
    const c = await tc('file_copy', { from: 'notes.txt', to: 'copy.txt' }, ws);
    assert.equal(c.ok, true, JSON.stringify(c));
    const m = await tc('file_move', { from: 'copy.txt', to: 'moved/copy2.txt' }, ws);
    assert.equal(m.ok, true, JSON.stringify(m));
    assert.ok(fs.existsSync(path.join(ws, 'moved', 'copy2.txt')));
    const d = await tc('file_delete', { path: 'moved/copy2.txt' }, ws);
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.equal(fs.existsSync(path.join(ws, 'moved', 'copy2.txt')), false);
    // 不存在:报错里名的是解析后的绝对路径,并点明相对路径已按工作区解析。
    const miss = await tc('file_read', { path: 'nope.txt' }, ws);
    assert.equal(miss.ok, false);
    assert.equal(miss.path, path.join(ws, 'nope.txt'));
    assert.match(miss.hint, /工作区/);
    // 绝对路径行为不变。
    const abs = await tc('file_read', { path: path.join(ws, 'notes.txt') }, ws);
    assert.equal(abs.ok, true);
  });

  it('F3 file_read 解码 GBK / UTF-16LE(BOM) / UTF-8 BOM,并报 encoding', async () => {
    const ws = freshWs();
    fs.writeFileSync(path.join(ws, 'gbk.txt'), Buffer.from('d6d0cec40a616263', 'hex'));   // 中文\nabc
    const g = await tc('file_read', { path: 'gbk.txt' }, ws);
    assert.equal(g.ok, true);
    assert.equal(g.content, '中文\nabc');
    assert.equal(g.encoding, 'gb18030');
    assert.equal(g.encodingDetected, true);
    assert.equal(g.non_ascii, undefined, '正常中文不该带 non_ascii 块');
    const g2 = await tc('file_read', { path: 'gbk.txt', encoding: 'gbk' }, ws);
    assert.equal(g2.content, '中文\nabc');
    const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hello\r\n世界', 'utf16le')]);
    fs.writeFileSync(path.join(ws, 'u16.txt'), u16);
    const u = await tc('file_read', { path: 'u16.txt' }, ws);
    assert.equal(u.content, 'hello\r\n世界');
    assert.equal(u.encoding, 'utf16le');
    assert.equal(u.bom, true);
    fs.writeFileSync(path.join(ws, 'bom.csv'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('id,名称\n1,a\n')]));
    const b = await tc('file_read', { path: 'bom.csv' }, ws);
    assert.equal(b.content, 'id,名称\n1,a\n', 'BOM 不该留在内容里');
    assert.equal(b.bom, true);
    assert.equal(b.encoding, 'utf8');
    // 无扩展名的二进制被拒;显式 encoding 的非法值给 hint。
    const blob = Buffer.alloc(5000);
    for (let i = 0; i < blob.length; i += 1) blob[i] = (i * 131 + 7) & 0xff;
    blob[10] = 0;
    fs.writeFileSync(path.join(ws, 'blob'), blob);
    const bl = await tc('file_read', { path: 'blob' }, ws);
    assert.equal(bl.ok, false);
    assert.equal(bl.code, 'binary');
    const bad = await tc('file_read', { path: 'gbk.txt', encoding: 'klingon' }, ws);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'bad_encoding');
    assert.match(bad.hint, /gbk/);
  });

  it('F3 file_edit / file_write 保原编码、BOM 与 CRLF', async () => {
    const ws = freshWs();
    // UTF-16LE + BOM + CRLF 的文件被 file_edit 改一处:仍是 UTF-16LE BOM CRLF。
    const orig = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一行\r\nFoo\r\n', 'utf16le')]);
    const f16 = path.join(ws, 'u16.txt');
    fs.writeFileSync(f16, orig);
    const e = await tc('file_edit', { path: f16, oldText: 'Foo', newText: 'Bar\nBaz' }, ws);
    assert.equal(e.ok, true, JSON.stringify(e));
    const want = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('第一行\r\nBar\r\nBaz\r\n', 'utf16le')]);
    assert.ok(fs.readFileSync(f16).equals(want), 'UTF-16LE + BOM + CRLF 原样保持');
    // GBK 文件被 file_write 整份覆写:仍是 GBK(不悄悄转 UTF-8),LF 保持。
    const fg = path.join(ws, 'g.txt');
    fs.writeFileSync(fg, Buffer.from('c4e3bac30a', 'hex'));
    const w = await tc('file_write', { path: fg, content: '中文\n第二行\n' }, ws);
    assert.equal(w.ok, true, JSON.stringify(w));
    assert.equal(w.encoding, 'gb18030');
    assert.equal(new TextDecoder('gb18030').decode(fs.readFileSync(fg)), '中文\n第二行\n');
    // GB18030 连 emoji/泰文都能编码(四字节);真正编不了的只有孤立代理项之类 —— 拒绝,文件不动。
    const before = fs.readFileSync(fg);
    const emoji = await tc('file_write', { path: fg, content: '中文 \u{1F600}\n' }, ws);
    assert.equal(emoji.ok, true, JSON.stringify(emoji));
    assert.equal(new TextDecoder('gb18030').decode(fs.readFileSync(fg)), '中文 \u{1F600}\n');
    fs.writeFileSync(fg, before);
    const bad = await tc('file_write', { path: fg, content: 'x\ud800y' }, ws);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'unencodable');
    assert.ok(fs.readFileSync(fg).equals(before), '拒绝时文件不动');
    // 显式 encoding:utf-16le 新建 = 带 BOM。
    const nf = path.join(ws, 'new16.txt');
    const n = await tc('file_write', { path: nf, content: 'a\nb', encoding: 'utf-16le' }, ws);
    assert.equal(n.ok, true, JSON.stringify(n));
    assert.ok(fs.readFileSync(nf).subarray(0, 2).equals(Buffer.from([0xff, 0xfe])));
    assert.equal(new TextDecoder('utf-16le', { ignoreBOM: true }).decode(fs.readFileSync(nf)), '\ufeffa\nb');
  });

  it('F4 file_read 默认预算:序列化后不超过模型侧上限;截断给 nextOffset 且能接着读完', async () => {
    const ws = freshWs();
    const body = Array.from({ length: 3000 }, (_, i) => `line ${i} ` + '中文内容'.repeat(6)).join('\n');   // ~90K 字符
    assert.ok(body.length > 80000);
    fs.writeFileSync(path.join(ws, 'big.txt'), body);
    const r = await tc('file_read', { path: 'big.txt' }, ws);
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true, '超过默认预算必须如实标 truncated');
    assert.ok(Number.isFinite(r.nextOffset) && r.nextOffset > 0);
    assert.ok(JSON.stringify(r).length <= 60000, `序列化 ${JSON.stringify(r).length} 必须 <= 60000(模型侧不再静默丢中段)`);
    // 用 nextOffset 接着读,拼起来就是整份文件。
    let text = r.content, off = r.nextOffset, guard = 0;
    while (guard++ < 10) {
      const n = await tc('file_read', { path: 'big.txt', offset: off }, ws);
      assert.equal(n.ok, true);
      text += n.content;
      if (!n.truncated) break;
      off = n.nextOffset;
    }
    assert.equal(text, body);
    // 显式 limit 超过上限被钳制并说明。
    const c = await tc('file_read', { path: 'big.txt', limit: 100000 }, ws);
    assert.equal(c.limitClamped, true);
    assert.ok(JSON.stringify(c).length <= 62000);
  });

  it('F4 行模式也有字符预算:超长行不再返回几 MB;nextLine 可接着读', async () => {
    const ws = freshWs();
    const lines = Array.from({ length: 400 }, (_, i) => `L${i}:` + 'x'.repeat(400));   // 400 行 x ~405 字符
    fs.writeFileSync(path.join(ws, 'lines.txt'), lines.join('\n') + '\n');
    const r = await tc('file_read', { path: 'lines.txt', lineOffset: 1, lineLimit: 2000 }, ws);
    assert.equal(r.ok, true);
    assert.equal(r.truncated, true);
    assert.ok(r.nextLine > 1 && r.nextLine <= 400);
    assert.ok(JSON.stringify(r).length <= 60000, `行模式序列化 ${JSON.stringify(r).length}`);
    assert.equal(r.totalLines, 400, '小文件仍给精确 totalLines(且无幽灵末行)');
    const got = [];
    let next = 1, guard = 0;
    while (next && guard++ < 20) {
      const n = await tc('file_read', { path: 'lines.txt', lineOffset: next, lineLimit: 2000 }, ws);
      got.push(...n.content.split('\n').map(l => l.replace(/^\s*\d+\t/, '')));
      next = n.truncated ? n.nextLine : 0;
    }
    assert.deepEqual(got, lines);
    // 单行 1MB 的压缩文件:只返回预算内的开头,并给字符偏移。
    fs.writeFileSync(path.join(ws, 'min.js'), 'y'.repeat(1000000));
    const m = await tc('file_read', { path: 'min.js', lineOffset: 1 }, ws);
    assert.equal(m.ok, true);
    assert.ok(JSON.stringify(m).length <= 60000);
    assert.ok(m.lineTruncated && m.lineTruncated.nextOffset > 0);
    assert.equal(m.lineTruncated.lineChars, 1000000);
  });

  it('F4 有界读:读 2000 字符不把大文件整个读进内存', async () => {
    const ws = freshWs();
    const big = path.join(ws, 'huge.log');
    const chunk = Buffer.alloc(1024 * 1024, 'abcdefghij\n');
    const fd = fs.openSync(big, 'w');
    for (let i = 0; i < 48; i += 1) fs.writeSync(fd, chunk);
    fs.closeSync(fd);
    const readAll = spyHook('readFile', f => String(f) === big);
    let bytesRead = 0;
    const origOpen = fsp.open;
    fsp.open = async function patchedOpen(f, ...rest) {
      const fh = await origOpen.call(this, f, ...rest);
      if (String(f) === big) {
        const origRead = fh.read.bind(fh);
        fh.read = async (...a) => { const res = await origRead(...a); bytesRead += res.bytesRead; return res; };
      }
      return fh;
    };
    try {
      const r = await tc('file_read', { path: big, limit: 2000 }, ws);
      assert.equal(r.ok, true);
      assert.equal(r.content.length, 2000);
      assert.equal(r.truncated, true);
      assert.equal(r.nextOffset, 2000);
      assert.equal(r.totalChars, undefined, '超过扫描阈值的大文件不假装知道总字符数');
      const l = await tc('file_read', { path: big, lineOffset: 3, lineLimit: 3 }, ws);
      assert.equal(l.content.split('\n').length, 3);
    } finally { fsp.open = origOpen; readAll.restore(); }
    assert.equal(readAll.calls.length, 0, '不许 fsp.readFile 整个文件');
    assert.ok(bytesRead <= 3 * 4 * 1024 * 1024, `只该读几块(实读 ${bytesRead} 字节,文件 48MB)`);
  });

  it('F5 non_ascii:中文正文不报;只报真可疑字符,且优先级在全部命中上排', async () => {
    const ws = freshWs();
    fs.writeFileSync(path.join(ws, 'zh.md'), Array.from({ length: 60 }, (_, i) => `第${i}行:这是一段普通的中文说明,含全角标点(逗号)、\u201c引号\u201d和——破折号。`).join('\n'));
    const zh = await tc('file_read', { path: 'zh.md' }, ws);
    assert.equal(zh.ok, true);
    assert.equal(zh.non_ascii, undefined, '普通中文(含中文标点)不该触发 non_ascii');
    // 前面 40 个普通中文字符,后面才是夹在 ASCII 里的弯引号和零宽空格:必须被报出来,且排在前面。
    const src = '// ' + '中文注释'.repeat(10) + '\nconst s = \u201chello\u201d;\nconst z = "a\u200bb";\n';
    fs.writeFileSync(path.join(ws, 'code.js'), src);
    const c = await tc('file_read', { path: 'code.js' }, ws);
    assert.ok(c.non_ascii, '可疑字符必须报出');
    const cps = c.non_ascii.samples.map(x => x.codepoint);
    assert.ok(cps.includes('U+200B'), JSON.stringify(cps));
    assert.ok(cps.includes('U+201C'), JSON.stringify(cps));
    assert.equal(c.non_ascii.samples[0].codepoint, 'U+200B', '零宽字符优先于弯引号');
    assert.equal(c.non_ascii.samples.find(x => x.codepoint === 'U+201C').line, 2, '行号是文件里的真实行号');
  });

  it('F6 file_edit 未命中:空白差异专门诊断;整段最接近窗口;多命中列行号', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'a.js');
    fs.writeFileSync(f, 'function a() {\n  const x = 1;\n  return x;\n}\n');
    // 制表符缩进 vs 文件里的空格缩进。
    const ws1 = await tc('file_edit', { path: f, oldText: 'function a() {\n\tconst x = 1;\n\treturn x;\n}', newText: 'X' }, ws);
    assert.equal(ws1.ok, false);
    assert.equal(ws1.code, 'whitespace_mismatch');
    assert.ok(ws1.whitespace.kinds.includes('tab_vs_space'), JSON.stringify(ws1.whitespace));
    assert.equal(ws1.whitespace.actualText, 'function a() {\n  const x = 1;\n  return x;\n}');
    assert.equal(ws1.path, f);
    assert.ok(ws1.hint && /actualText/.test(ws1.hint));
    // 拿 actualText 当 oldText 就能命中。
    const okr = await tc('file_edit', { path: f, oldText: ws1.whitespace.actualText, newText: 'function a() {}' }, ws);
    assert.equal(okr.ok, true, JSON.stringify(okr));
    // 行尾空白。
    fs.writeFileSync(f, 'alpha\nbeta  \ngamma\n');
    const tr = await tc('file_edit', { path: f, oldText: 'alpha\nbeta\ngamma', newText: 'X' }, ws);
    assert.equal(tr.code, 'whitespace_mismatch');
    assert.ok(tr.whitespace.kinds.includes('trailing_whitespace'));
    // 行内制表符 vs 空格(片段匹配,不是整行)。
    fs.writeFileSync(f, 'k\tv\nnext\n');
    const it = await tc('file_edit', { path: f, oldText: 'k  v', newText: 'X' }, ws);
    assert.equal(it.code, 'whitespace_mismatch');
    assert.ok(it.whitespace.kinds.includes('tab_vs_space'), JSON.stringify(it.whitespace));
    assert.doesNotMatch(it.closest.snippet, /\n3\t$/, '末尾换行之后的空串不算一行');
    // 多行 oldText 第 3 行不同:closest 指到窗口起点,mismatch 指出第 3 行。
    fs.writeFileSync(f, 'one\ntwo\nreturn x + 2\nfour\n');
    const mm = await tc('file_edit', { path: f, oldText: 'one\ntwo\nreturn x + 3\nfour', newText: 'X' }, ws);
    assert.equal(mm.ok, false);
    assert.equal(mm.code, 'not_found');
    assert.equal(mm.error, 'oldText was not found');
    assert.equal(mm.closest.line, 1);
    assert.equal(mm.mismatch.line, 3);
    assert.match(mm.mismatch.actual, /x \+ 2/);
    assert.ok(mm.hint && mm.path === f);
    // 多命中:不再抛异常,列出每处行号。
    fs.writeFileSync(f, 'dup\nmid\ndup\nmid\ndup\n');
    const amb = await tc('file_edit', { path: f, oldText: 'dup', newText: 'X' }, ws);
    assert.equal(amb.ok, false);
    assert.equal(amb.code, 'ambiguous');
    assert.equal(amb.count, 3);
    assert.deepEqual(amb.matches.map(m => m.line), [1, 3, 5]);
    assert.match(amb.error, /appears 3 times/);
    assert.equal(fs.readFileSync(f, 'utf8'), 'dup\nmid\ndup\nmid\ndup\n', '歧义时文件不动');
  });

  it('F10 file_delete:>5MB 也能删(带 checkpointWarn),且不整文件读入;<=5MB 仍存检查点', async () => {
    const ws = freshWs();
    const bigF = path.join(ws, 'big.bin.log');
    fs.writeFileSync(bigF, Buffer.alloc(6 * 1024 * 1024, 'z'));
    const spy = spyHook('readFile', f => String(f) === bigF);
    let r;
    try { r = await tc('file_delete', { path: bigF }, ws, 'sess_core_del_big'); } finally { spy.restore(); }
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(r.checkpointWarn, '要如实披露没做检查点');
    assert.ok(r.hint);
    assert.equal(fs.existsSync(bigF), false);
    assert.equal(spy.calls.length, 0, '不该为了发现「存不下」把 6MB 读进内存');
    const smallF = path.join(ws, 'small.txt');
    fs.writeFileSync(smallF, 'keep me');
    const s = await tc('file_delete', { path: smallF }, ws, 'sess_core_del_small');
    assert.equal(s.ok, true);
    assert.equal(s.checkpointWarn, undefined);
    assert.equal(indexOf('sess_core_del_small').filter(e => e.op === 'delete' && !e.skipped).length, 1);
  });

  it('F11 原子写:rename 一次瞬时 EBUSY 会重试成功;永久 ENOSPC 报 disk_full、不留幽灵检查点/临时文件', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'e.txt');
    fs.writeFileSync(f, 'alpha beta');
    const h1 = failHook('rename', (from, to) => path.resolve(String(to)) === f, 'EBUSY', 1);
    let r1;
    try { r1 = await tc('file_edit', { path: f, oldText: 'beta', newText: 'gamma' }, ws, 'sess_core_ebusy'); } finally { h1.restore(); }
    assert.equal(h1.hits, 1, '卡子必须命中过');
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(fs.readFileSync(f, 'utf8'), 'alpha gamma');
    // 永久 ENOSPC:writeFile 写临时文件失败。
    const sid = 'sess_core_enospc';
    const h2 = failHook('writeFile', file => /\.tmp$/.test(String(file)) && String(file).startsWith(ws), 'ENOSPC', Infinity);
    let r2;
    try { r2 = await tc('file_edit', { path: f, oldText: 'gamma', newText: 'delta' }, ws, sid); } finally { h2.restore(); }
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'disk_full');
    assert.ok(r2.hint);
    assert.equal(fs.readFileSync(f, 'utf8'), 'alpha gamma', '原文件没被改');
    assert.equal(indexOf(sid).length, 0, '写失败不留幽灵检查点');
    assert.deepEqual(fs.readdirSync(ws).filter(n => n.endsWith('.tmp')), [], '不留临时文件');
    // file_write 同样。
    const sid2 = 'sess_core_enospc2';
    const h3 = failHook('writeFile', file => /\.tmp$/.test(String(file)) && String(file).startsWith(ws), 'ENOSPC', Infinity);
    let r3;
    try { r3 = await tc('file_write', { path: f, content: 'whole new' }, ws, sid2); } finally { h3.restore(); }
    assert.equal(r3.ok, false);
    assert.equal(r3.code, 'disk_full');
    assert.equal(indexOf(sid2).length, 0);
    assert.equal(fs.readFileSync(f, 'utf8'), 'alpha gamma');
  });

  it('F11 目录当文件:file_read / file_write 给 is_directory + hint,而不是裸 EISDIR', async () => {
    const ws = freshWs();
    fs.mkdirSync(path.join(ws, 'adir'));
    const r = await tc('file_read', { path: 'adir' }, ws);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'is_directory');
    assert.match(r.hint, /file_list/);
    const w = await tc('file_write', { path: 'adir', content: 'x' }, ws, 'sess_core_isdir');
    assert.equal(w.ok, false);
    assert.equal(w.code, 'is_directory');
    assert.equal(indexOf('sess_core_isdir').length, 0);
  });

  it('F15 file_write 覆盖 >5MB 旧文件不整文件读入;幂等跳过仍成立', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'old.dat.txt');
    fs.writeFileSync(f, Buffer.alloc(6 * 1024 * 1024, 'q'));
    const spy = spyHook('readFile', file => String(file) === f);
    let r;
    try { r = await tc('file_write', { path: f, content: 'small now' }, ws, 'sess_core_bigw'); } finally { spy.restore(); }
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(spy.calls.length, 0);
    assert.ok(r.checkpointWarn);
    assert.equal(fs.readFileSync(f, 'utf8'), 'small now');
    const again = await tc('file_write', { path: f, content: 'small now' }, ws, 'sess_core_bigw', 2);
    assert.equal(again.op, 'skip');
    assert.equal(again.unchanged, true);
  });
});

// ── 审计 native-files 复核(review/native-files.md)的回归 ─────────────────────────────────────────────────────
//   R4  相对 root / audio_transcribe 的相对 path 按工作区解析(不是进程 cwd)
//   R5  临时文件建不了但目标可写 → 退回原地写;悬空符号链接经链接写出目标
//   R10 首块(4MB)之后才出现的非 UTF-8 字节 → encodingWarning
//   R13 GBK 编码器(Buffer 构建)大文本往返
describe('[R] native-files 复核回归', () => {
  it('R4 相对 root(file_list/glob/file_search/project_snapshot)按工作区解析,不落到进程 cwd', async () => {
    const ws = freshWs();
    fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'src', 'only_here.txt'), 'NEEDLE_R4\n');
    const want = path.join(ws, 'src');
    for (const [name, args] of [['file_list', {}], ['glob', { pattern: '**/*.txt' }], ['file_search', { pattern: 'NEEDLE_R4' }], ['project_snapshot', {}]]) {
      const r = await tc(name, { root: 'src', ...args }, ws, 'sess_core_r4_' + name);
      assert.equal(r.ok, true, name + ': ' + JSON.stringify(r).slice(0, 300));
      assert.equal(r.root, want, name);
    }
    const r = await tc('file_list', { root: 'src' }, ws, 'sess_core_r4_l');
    assert.deepEqual(r.files.map(f => f.relativePath), ['only_here.txt']);
  });

  it('R4 audio_transcribe 的相对 path 按工作区解析', async () => {
    const ws = freshWs();
    const r = await tc('audio_transcribe', { path: 'clip.wav' }, ws, 'sess_core_r4_audio');
    assert.equal(r.path, path.join(ws, 'clip.wav'), JSON.stringify(r).slice(0, 300));
  });

  it('R5 临时文件建不了(EACCES)但目标可写:file_write / file_edit 退回原地写', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'f.txt');
    fs.writeFileSync(f, 'alpha beta');
    const h = failHook('writeFile', file => /\.tmp$/.test(String(file)) && String(file).startsWith(ws), 'EACCES', Infinity);
    let r1, r2;
    try {
      r1 = await tc('file_edit', { path: f, oldText: 'beta', newText: 'gamma' }, ws, 'sess_core_r5a');
      r2 = await tc('file_write', { path: f, content: 'whole new' }, ws, 'sess_core_r5b');
    } finally { h.restore(); }
    assert.ok(h.hits >= 2, '卡子必须命中过');
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(fs.readFileSync(f, 'utf8'), 'whole new');
    assert.deepEqual(fs.readdirSync(ws).filter(n => n.endsWith('.tmp')), []);
  });

  it('R5 临时文件和原地写都失败 → 仍报原错误(permission_or_locked),目标不变', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'g.txt');
    fs.writeFileSync(f, 'keep me');
    const h1 = failHook('writeFile', file => /\.tmp$/.test(String(file)) && String(file).startsWith(ws), 'EACCES', Infinity);
    const h2 = failHook('writeFile', file => String(file) === f, 'EACCES', Infinity);
    let r;
    try { r = await tc('file_write', { path: f, content: 'nope' }, ws, 'sess_core_r5c'); } finally { h1.restore(); h2.restore(); }
    assert.equal(r.ok, false);
    assert.equal(r.code, 'permission_or_locked');
    assert.equal(fs.readFileSync(f, 'utf8'), 'keep me');
  });

  it('R5 悬空符号链接:file_write 经链接把目标写出来(不是假 not_found)', async () => {
    const ws = freshWs();
    fs.mkdirSync(path.join(ws, 'realdir'));
    const link = path.join(ws, 'dangling.txt');
    try { fs.symlinkSync(path.join(ws, 'realdir', 'made.txt'), link); } catch { return; }   // 无符号链接权限的机器跳过
    const r = await tc('file_write', { path: link, content: 'via link' }, ws, 'sess_core_r5d');
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(fs.readFileSync(path.join(ws, 'realdir', 'made.txt'), 'utf8'), 'via link');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), '链接本身保留');
  });

  it('R10 首块之后才出现的 GBK 字节:file_read 给 encodingWarning(不再静默乱码)', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'late.txt');
    fs.writeFileSync(f, Buffer.concat([Buffer.alloc(4 * 1024 * 1024 + 100, 'A'), Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), Buffer.from('tail')]));
    const r = await tc('file_read', { path: f, offset: 4 * 1024 * 1024 + 50, limit: 200 }, ws, 'sess_core_r10');
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
    assert.match(String(r.encodingWarning || ''), /GBK|UTF-8/, JSON.stringify(Object.keys(r)));
    // 纯 ASCII 的大文件不该有警告
    const g = path.join(ws, 'plain.txt');
    fs.writeFileSync(g, Buffer.alloc(4 * 1024 * 1024 + 100, 'A'));
    const r2 = await tc('file_read', { path: g, offset: 4 * 1024 * 1024, limit: 50 }, ws, 'sess_core_r10b');
    assert.equal(r2.ok, true);
    assert.equal(r2.encodingWarning, undefined);
  });

  it('R13 GBK 编码器(Buffer 构建):大文本含生僻/增补平面字符往返不变', async () => {
    const ws = freshWs();
    const f = path.join(ws, 'big.txt');
    const chunk = '你好,世界 abc 𠀀 € 「」\n';
    fs.writeFileSync(f, Buffer.from('placeholder'));
    const text = chunk.repeat(60000);
    const w = await tc('file_write', { path: f, content: text, encoding: 'gbk' }, ws, 'sess_core_r13');
    assert.equal(w.ok, true, JSON.stringify(w).slice(0, 300));
    const back = new TextDecoder('gb18030').decode(fs.readFileSync(f));
    assert.equal(back, text);
  });
});
