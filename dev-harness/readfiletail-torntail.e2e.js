// E2E(117q-B6 · 30 号文 P2-10/P2-11):尾窗读原语 readFileTail + 撕裂尾修复 repairMissionChangeTornTail
// 的字节级行为断言。不经 HTTP —— 直接 require server.js 拿导出的内部函数,可控地造真撕裂尾文件。
//
// 背景:02-session-store.js 出过真数据事故(记忆「loadSession 的破坏性竞态」),本刀只碰「怎么把文件
// 尾巴读进内存」这一件事,不碰任何写链/锁。断言比代码重要 —— 本文件专门覆盖:
//  (a) readFileTail 单测:空文件/比 maxBytes 小/比 maxBytes 大(只读尾窗)/文件不存在(size<0,不抛)/
//      返回的 bytesRead 与实际内容一致(含一个用 fs.promises.stat 打桩制造真短读的场景 —— 这正是
//      「stat 与 read 之间文件被截短」那类竞态的可控复现:谎报一个比真实文件更大的 size,
//      fd.read 到 EOF 就停,真实 bytesRead 必然小于请求量)。
//  (b) 撕裂尾字节级断言(核心保护):真撕裂尾 NDJSON(末行半行、无 \n)修复后字节级等于预期;
//      三个边界 —— 已以 \n 结尾(一个字节都不许动)/整个文件只有半行(截成空)/文件比尾窗大且撕裂点
//      在尾窗内;外加一个短读场景(同 (a) 的打桩手法,这次打在 repairMissionChangeTornTail 的调用链
//      上)证明【按 bytesRead 定界】的新实现在短读下不会对 Buffer.alloc 清零的尾部空白误判。
//  (d) 静态锁:全仓「尾窗读」原语只有一份定义,repairInterventionTornTail 已删除零残留,
//      repairMissionChangeTornTail(撕裂尾修复真身)全仓只有一份定义。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));
const { readServerSource } = require('./src-reader');
const { readFileTail, repairMissionChangeTornTail } = srv;

let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

const TMP = path.join(os.tmpdir(), 'wcw-readfiletail-e2e-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });
function tmpFile(name) { return path.join(TMP, name); }

// ── stat 打桩:只对指定文件谎报 size,其余文件走真实 fs.promises.stat ──────────────────────────
// server.js 内部的 fsp 就是 require('fs').promises 这同一个单例(Node 模块缓存保证),故这里打桩
// 对 readFileTail/repairMissionChangeTornTail 内部的 stat 调用同样生效 —— 这是端到端的真实复现,
// 不是 mock 掉整条调用链。
const fsp = fs.promises;
const realStat = fsp.stat.bind(fsp);
let liedSizeFor = null; // { file: absPath, size: number } | null
fsp.stat = async (p, ...rest) => {
  const real = await realStat(p, ...rest);
  if (liedSizeFor && path.resolve(String(p)) === liedSizeFor.file) {
    return { ...real, size: liedSizeFor.size };
  }
  return real;
};

(async () => {
  // ---------- (a) readFileTail 单测 ----------
  {
    const f = tmpFile('a1-empty.txt');
    fs.writeFileSync(f, '');
    const r = await readFileTail(f, 100);
    ok(r.size === 0 && r.bytesRead === 0 && r.buf.length === 0, '(a1) 空文件:size=0 bytesRead=0 buf.length=0');
  }
  {
    const f = tmpFile('a2-small.txt');
    const content = 'hello world\n';
    fs.writeFileSync(f, content, 'utf8');
    const r = await readFileTail(f, 65536);
    ok(r.size === content.length && r.bytesRead === content.length, '(a2) 文件比 maxBytes 小:size/bytesRead 等于文件长度');
    ok(r.buf.slice(0, r.bytesRead).toString('utf8') === content, '(a2b) 返回内容与文件内容逐字节一致');
  }
  {
    const f = tmpFile('a3-large.txt');
    const lines = [];
    for (let i = 0; i < 2000; i++) lines.push(String(i).padStart(6, '0') + '-' + 'x'.repeat(90) + '\n'); // 100 bytes/行
    const content = lines.join('');
    fs.writeFileSync(f, content, 'utf8');
    const maxBytes = 65536;
    const r = await readFileTail(f, maxBytes);
    ok(r.size === Buffer.byteLength(content, 'utf8'), '(a3) 文件比 maxBytes 大:size 等于真实文件字节数');
    ok(r.bytesRead === maxBytes, '(a3b) bytesRead 等于请求的 maxBytes(只读到尾窗,不是整文件)');
    const expectedTail = Buffer.from(content, 'utf8').slice(r.size - maxBytes);
    ok(r.buf.slice(0, r.bytesRead).equals(expectedTail), '(a3c) 尾窗内容与文件真实尾部逐字节一致');
  }
  {
    const f = tmpFile('a4-missing.txt'); // 从不创建
    let threw = false, r = null;
    try { r = await readFileTail(f, 100); } catch { threw = true; }
    ok(!threw, '(a4) 文件不存在:不抛');
    ok(!!r && r.size === -1, '(a4b) 文件不存在:size === -1');
    ok(!!r && r.bytesRead === 0, '(a4c) 文件不存在:bytesRead === 0');
  }
  {
    // (a5) 短读复现:stat 打桩谎报比真实文件大 40 字节的 size,readFileTail 内部据此请求「size 字节」
    // 尾窗;真实 fd.read 只有 realSize 字节可读,到 EOF 就停 —— bytesRead 必然 < 请求量(= 谎报的 size)。
    const f = tmpFile('a5-shortread.txt');
    const content = '{"seq":1}\n{"seq":2}\n{"seq":3}\n';
    fs.writeFileSync(f, content, 'utf8');
    const realSize = Buffer.byteLength(content, 'utf8');
    liedSizeFor = { file: path.resolve(f), size: realSize + 40 };
    const r = await readFileTail(f, 65536);
    liedSizeFor = null;
    ok(r.size === realSize + 40, '(a5 准备) stat 打桩生效:readFileTail 看到的是谎报的 size');
    ok(r.buf.length === realSize + 40, '(a5b 准备) buf.length 是按谎报 size 分配的请求量(未定界会踩这一截)');
    ok(r.bytesRead === realSize, '(a5c) 短读场景:返回的 bytesRead 等于【真实】可读字节数,不等于谎报 size/buf.length');
    ok(r.buf.slice(0, r.bytesRead).toString('utf8') === content, '(a5d) buf[0..bytesRead) 与真实文件内容逐字节一致(按 bytesRead 定界才拿到干净数据)');
  }

  // ---------- (b) 撕裂尾字节级断言(核心保护)----------
  // (b1) 真撕裂尾:末行半行、无 \n 结尾。修复后应恰好截到最后一个完整行的 \n。
  {
    const f = tmpFile('b1-torn.ndjson');
    const complete = '{"seq":1}\n{"seq":2}\n{"seq":3}\n';
    const torn = '{"seq":4,"partial":"no closing brace or newline';
    fs.writeFileSync(f, complete + torn, 'utf8');
    const before = fs.readFileSync(f);
    await repairMissionChangeTornTail(f);
    const after = fs.readFileSync(f);
    ok(before.length === Buffer.byteLength(complete + torn, 'utf8'), '(b1 准备) 撕裂尾文件已写入(含半行)');
    ok(after.length === Buffer.byteLength(complete, 'utf8'), '(b1) 撕裂尾修复后字节长度等于「只保留完整行」的预期长度');
    ok(after.equals(Buffer.from(complete, 'utf8')), '(b1b) 撕裂尾修复后内容与预期逐字节相等');
  }
  // (b2) 已经以 \n 结尾:一个字节都不许动。
  {
    const f = tmpFile('b2-clean.ndjson');
    const content = '{"seq":1}\n{"seq":2}\n{"seq":3}\n';
    fs.writeFileSync(f, content, 'utf8');
    const before = fs.readFileSync(f);
    await repairMissionChangeTornTail(f);
    const after = fs.readFileSync(f);
    ok(after.equals(before), '(b2) 已以 \\n 结尾:修复前后字节完全相同(一个字节都不许动)');
    ok(after.length === Buffer.byteLength(content, 'utf8'), '(b2b) 文件大小未变');
  }
  // (b3) 整个文件只有半行(无任何 \n):截成空。
  {
    const f = tmpFile('b3-onlyhalf.ndjson');
    const torn = '{"seq":1,"noNewlineAnywhereInThisFile":true';
    fs.writeFileSync(f, torn, 'utf8');
    await repairMissionChangeTornTail(f);
    const after = fs.readFileSync(f);
    ok(after.length === 0, '(b3) 整个文件只有半行:修复后截成空(0 字节)');
  }
  // (b4) 文件比尾窗(65536)大,撕裂点在尾窗内。
  {
    const f = tmpFile('b4-largetorn.ndjson');
    let complete = '';
    let i = 1;
    while (Buffer.byteLength(complete, 'utf8') < 80000) { complete += JSON.stringify({ seq: i, pad: 'y'.repeat(80) }) + '\n'; i++; }
    const torn = JSON.stringify({ seq: i, pad: 'torn-tail-no-close' }).slice(0, -1); // 去掉收尾 } ,且无 \n
    fs.writeFileSync(f, complete + torn, 'utf8');
    const totalLen = Buffer.byteLength(complete + torn, 'utf8');
    const tornLen = Buffer.byteLength(torn, 'utf8');
    ok(totalLen > 65536, '(b4 准备) 文件确实大于 65536 字节尾窗(' + totalLen + ' 字节)');
    ok(tornLen < 65536, '(b4 准备) 撕裂点确实落在尾窗(65536 字节)以内(撕裂尾长 ' + tornLen + ' 字节)');
    await repairMissionChangeTornTail(f);
    const after = fs.readFileSync(f);
    ok(after.length === Buffer.byteLength(complete, 'utf8'), '(b4) 大文件+尾窗内撕裂点:修复后字节长度等于预期');
    ok(after.equals(Buffer.from(complete, 'utf8')), '(b4b) 大文件+尾窗内撕裂点:内容逐字节相等');
  }
  // (b5) 短读场景下 repairMissionChangeTornTail 端到端仍然正确:同 (a5) 的 stat 打桩手法,这次打在
  // 修复函数自己内部的 readFileTail 调用上 —— 谎报 size 比真实文件大,制造真短读。文件本身干净
  // (以 \n 结尾),按 bytesRead 定界应该正确识别「最后一个已读到的字节是 \n」从而不误截;若像旧版
  // repairInterventionTornTail/旧版本函数那样不按 bytesRead 定界,会去看 Buffer.alloc 清零尾部的
  // buf[buf.length-1](= 0x00 ≠ 0x0a),误判成「未以 \n 结尾」进而错误截断干净数据。
  {
    const f = tmpFile('b5-shortread-clean.ndjson');
    const content = '{"seq":1}\n{"seq":2}\n{"seq":3}\n';
    fs.writeFileSync(f, content, 'utf8');
    const realSize = Buffer.byteLength(content, 'utf8');
    liedSizeFor = { file: path.resolve(f), size: realSize + 40 };
    await repairMissionChangeTornTail(f);
    liedSizeFor = null;
    const after = fs.readFileSync(f);
    ok(after.equals(Buffer.from(content, 'utf8')), '(b5) 短读+本来干净的文件:按 bytesRead 定界后未被误截,字节完全不变');
  }

  // ---------- (d) 静态锁:全仓「尾窗读」原语只有一份定义 ----------
  {
    const src = readServerSource();
    const tailDefs = src.match(/async function readFileTail\(/g) || [];
    ok(tailDefs.length === 1, '(d) 全仓 readFileTail 只有一份定义(防止长出第五份)');
    const oldRepairDefs = src.match(/async function repairInterventionTornTail\(/g) || [];
    ok(oldRepairDefs.length === 0, '(d2) repairInterventionTornTail 已删除,全仓零残留定义');
    // 30 号文 §8.11 的教训:扫源码的静态锁必须先剥注释,否则守的是「文本出现过」而不是「代码这么写了」
    // ——本函数改名说明里本就会提到旧名字。逐行剥掉 `//` 行注释后再找「像调用」的残留(标识符后紧跟 `(`)。
    const srcNoLineComments = src.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
    const oldRepairCalls = srcNoLineComments.match(/repairInterventionTornTail\s*\(/g) || [];
    ok(oldRepairCalls.length === 0, '(d2b) 剥注释后,repairInterventionTornTail 零调用点残留(只在改名说明注释里提过旧名字)');
    const survivorDefs = src.match(/async function repairMissionChangeTornTail\(/g) || [];
    ok(survivorDefs.length === 1, '(d3) repairMissionChangeTornTail(撕裂尾修复真身)全仓只有一份定义');
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(fail === 0 ? 'ALL PASS' : (fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
