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

  // ---------- (c) 117q-B6fix:appendIntervention「repair 失败不阻断 append」语义的缺席断言 ----------
  // 117q-B6 把 appendIntervention 内联的旧撕裂尾修复(repairInterventionTornTail,内部自吞错)改调
  // 共用真身 repairMissionChangeTornTail(真身内部没有 catch)。真身抛错时会在 fsp.appendFile *之前*
  // 中断 then 块 —— 外层那个 `.catch(() => {})` 只在 appendFile *之后* 才接得住,救不了这一行;这一条
  // intervention 记录会被静默丢弃、没有任何痕迹。117q-B6fix 把那次调用重新包回 try/catch,这里补上
  // 此前完全缺席、专门盯这一件事的断言:
  //  (c1) 真实故障注入(打桩 fsp.truncate,只对目标文件生效,其余文件走真实实现,同本文件顶部
  //       fsp.stat 打桩同一手法)证明 repairMissionChangeTornTail 在真撕裂尾场景下确实会抛
  //       (不是模拟的假抛,是让真实调用链真的走到抛错分支)。
  //  (c2) 从当前 server 源码里原样抠出 appendIntervention 的写入块函数体(正则先锚定函数声明再锚定
  //       .then(async () => {...}).catch(() => {}) 这一段,避免误配到附近同形态的其它写链如
  //       writeSessionNotes/appendMissionChangeRecord),用同一次故障注入执行这段【从磁盘读回的真实
  //       源码文本】,断言:写入块本身不因 repair 抛错而中断 + 这一行 intervention 记录仍然被 append
  //       进文件。readServerSource 自带 freshness 校验(与产物 server.js 不一致会先报错拦下),所以
  //       只要把 ① 的 try/catch 从 02-session-store.js 去掉、重新 build、重跑本文件,这里就会真的
  //       翻红 —— 断言的对错直接绑定在真实源码文本上,不是绑定在这个测试自己另写的一份复现逻辑上。
  {
    const bodySrc = (() => {
      const localSrc = readServerSource();
      const fnMatch = localSrc.match(/^function appendIntervention\(sessionId, record\) \{[\s\S]*?\n\}\n/m);
      if (!fnMatch) return null;
      const bodyMatch = fnMatch[0].match(/\.then\(async \(\) => \{([\s\S]*?)\}\)\.catch\(\(\) => \{\}\);/);
      return bodyMatch ? bodyMatch[1] : null;
    })();
    ok(!!bodySrc, '(c 准备) 从 server 源码定位到 appendIntervention 写入块函数体(两级正则只锚定该函数,不误配其它写链)');

    // (c1)
    const f1 = tmpFile('c1-repair-throws.ndjson');
    const torn1 = '{"id":"a"}\n{"id":"b","noNewline":true'; // 真撕裂尾:必然走到 fsp.truncate 分支
    fs.writeFileSync(f1, torn1, 'utf8');
    const target1 = path.resolve(f1);
    const realTruncate1 = fsp.truncate.bind(fsp);
    let repairThrew = false;
    try {
      fsp.truncate = async (p, ...rest) => {
        if (path.resolve(String(p)) === target1) throw new Error('injected truncate failure (117q-B6fix c1)');
        return realTruncate1(p, ...rest);
      };
      try { await repairMissionChangeTornTail(f1); } catch { repairThrew = true; }
    } finally { fsp.truncate = realTruncate1; }
    ok(repairThrew, '(c1) 真实故障注入下,repairMissionChangeTornTail 对真撕裂尾文件确实抛错(不是模拟的假抛)');

    // (c2)
    if (bodySrc) {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const writeBlock = new AsyncFunction('file', 'line', 'sid', 'fsp', 'repairMissionChangeTornTail', 'markPretenderIndexDirty', bodySrc);
      const f2 = tmpFile('c2-append-survives-repair-failure.ndjson');
      const torn2 = '{"id":"a"}\n{"id":"b","noNewline":true';
      fs.writeFileSync(f2, torn2, 'utf8');
      const target2 = path.resolve(f2);
      const realTruncate2 = fsp.truncate.bind(fsp);
      const newLine = JSON.stringify({ id: 'appended-despite-repair-failure-117q-B6fix' }) + '\n';
      let writeBlockThrew = false, writeBlockErr = null;
      try {
        fsp.truncate = async (p, ...rest) => {
          if (path.resolve(String(p)) === target2) throw new Error('injected truncate failure (117q-B6fix c2)');
          return realTruncate2(p, ...rest);
        };
        try {
          await writeBlock(f2, newLine, 'sid-c2', fsp, repairMissionChangeTornTail, () => {});
        } catch (e) { writeBlockThrew = true; writeBlockErr = e; }
      } finally { fsp.truncate = realTruncate2; }
      const after2 = fs.readFileSync(f2, 'utf8');
      ok(!writeBlockThrew, '(c2) appendIntervention 写入块本身不因 repair 抛错而中断' + (writeBlockThrew ? ('(实际抛出: ' + (writeBlockErr && writeBlockErr.message) + ')') : ''));
      ok(after2.includes('appended-despite-repair-failure-117q-B6fix'), '(c2b) repair 抛错时,这一条 intervention 记录仍然被 append 进文件(语义已还回,不再静默丢行)');
    } else {
      ok(false, '(c2) 未能定位 appendIntervention 写入块,跳过行为断言(见上方 (c 准备) 失败)');
    }
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
