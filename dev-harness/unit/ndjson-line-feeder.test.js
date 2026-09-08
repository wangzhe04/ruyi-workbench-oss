// Unit：117q-B1（30 号文 §4.1「子进程 NDJSON 逐块解码」）——createNdjsonLineFeeder 的 chunk 边界真值表。
//
// 为什么要单测：三条子进程 NDJSON 主干道（05-claude-engine.js 主回合、07-autonomy.js 子代理、
// 05b-kimi-bridge.js ACP）原来都对【每个 chunk 单独】 chunk.toString('utf8') 再拼接。CJK 是 3 字节，
// 一旦某个汉字被 OS 管道切在两个 data 事件之间，前半段解码成 U+FFFD，后续续接字节也解码成垃圾——
// 静默腐化，没有任何报错。现有 e2e 一条都没测过 chunk 边界（本仓自己 grep 过），这条断言是纯新增的
// 保护面。修法是走 StringDecoder（00-boot.js 已经 require 好），本件直接 require 真身 server.js，
// 不测复制重实现的副本。
//
// 覆盖：
//   ① 3 字节汉字被拆成两次 push()（先 2 字节、再 1 字节）→ 拼出来的行里 � 出现 0 次，内容逐字正确
//   ② 一行被切成三段跨三次 push，且切点两次都落在多字节字符中间 → 同样零 U+FFFD、内容逐字正确
//   ③ flush() 交出最后那半行（无尾随换行的残留）；空残留时 flush() 不调 onLine
//   ④ \r\n 与 \n 混排都能正确切行
//
// 与既有 dev-harness/unit 件同款约定（见 session-head-read.test.js）：require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时目录；用 node:test 的 describe/it + assert。
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-ndjson-feeder-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '..', '..');
const srv = require(path.join(repo, 'ruyi-workbench', 'app', 'server.js'));

const { createNdjsonLineFeeder } = srv;

describe('createNdjsonLineFeeder', () => {
  it('① 导出了 createNdjsonLineFeeder', () => {
    assert.equal(typeof createNdjsonLineFeeder, 'function');
  });

  it('② 3 字节汉字被拆成两次 push（先 2 字节、再 1 字节）→ 无 U+FFFD、内容逐字正确', () => {
    const lines = [];
    const feeder = createNdjsonLineFeeder(line => lines.push(line));
    const row = '{"text":"你好"}';
    const buf = Buffer.from(row + '\n', 'utf8'); // "你"=e4 bd a0,"好"=e5 a5 bd,切点落在 "你" 的第 2/3 字节之间
    const cutIdx = row.indexOf('你');
    // JSON 前缀里 "你" 之前的字节全是 ASCII，所以字节偏移 = 字符偏移；切在 "你" 的头 2 字节之后。
    const cut = cutIdx + 2;
    feeder.push(buf.subarray(0, cut));
    feeder.push(buf.subarray(cut));
    assert.equal(lines.length, 1, '完整的一行只应交出一次');
    assert.equal((lines[0].match(/�/g) || []).length, 0, `不应出现 U+FFFD(got ${JSON.stringify(lines[0])})`);
    assert.equal(lines[0], row, '拼出来的行必须与原始内容逐字相同');
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.text, '你好');
  });

  it('③ 一行跨三次 push，两个切点都落在多字节字符中间 → 同样零 U+FFFD、内容逐字正确', () => {
    const lines = [];
    const feeder = createNdjsonLineFeeder(line => lines.push(line));
    const row = '{"text":"你好世界"}'; // 4 个 3 字节 CJK 字符
    const buf = Buffer.from(row + '\n', 'utf8');
    const first = buf.indexOf(Buffer.from('你', 'utf8'));
    // 三段：第一段在 "你" 的第 1 字节处切断；第二段在 "好" 的第 2 字节处切断；第三段收尾。
    const cutA = first + 1; // "你" 切在第 1/2 字节之间
    const cutB = first + 3 + 2; // 跳过 "你"(3 字节)之后再切 "好" 的第 2/3 字节之间
    feeder.push(buf.subarray(0, cutA));
    feeder.push(buf.subarray(cutA, cutB));
    feeder.push(buf.subarray(cutB));
    assert.equal(lines.length, 1);
    assert.equal((lines[0].match(/�/g) || []).length, 0, `不应出现 U+FFFD(got ${JSON.stringify(lines[0])})`);
    assert.equal(lines[0], row);
    assert.equal(JSON.parse(lines[0]).text, '你好世界');
  });

  it('④ flush() 交出最后那半行（无尾随换行的残留）', () => {
    const lines = [];
    const feeder = createNdjsonLineFeeder(line => lines.push(line));
    feeder.push(Buffer.from('{"a":1}\n{"b":2}', 'utf8')); // 第二行没有尾随换行
    assert.deepEqual(lines, ['{"a":1}'], 'push 阶段只应吐出已经闭合的完整行');
    feeder.flush();
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}'], 'flush 必须把残留的半行交出去');
  });

  it('⑤ 空残留时 flush() 不调 onLine', () => {
    const lines = [];
    const feeder = createNdjsonLineFeeder(line => lines.push(line));
    feeder.push(Buffer.from('{"a":1}\n', 'utf8')); // 以换行收尾，remainder 为空
    assert.deepEqual(lines, ['{"a":1}']);
    feeder.flush();
    assert.deepEqual(lines, ['{"a":1}'], 'remainder 为空时 flush 不应再调用一次 onLine');
  });

  it('⑥ flush() 对纯空白残留（仅空格/换行残片）同样不调 onLine', () => {
    const lines = [];
    const feeder = createNdjsonLineFeeder(line => lines.push(line));
    feeder.push(Buffer.from('{"a":1}\n   ', 'utf8')); // 残留是纯空白
    feeder.flush();
    assert.deepEqual(lines, ['{"a":1}'], '纯空白残留 trim 后为空，不应触发 onLine');
  });

  it('⑦ \\r\\n 与 \\n 混排都能正确切行', () => {
    const lines = [];
    const feeder = createNdjsonLineFeeder(line => lines.push(line));
    feeder.push(Buffer.from('line1\r\nline2\nline3\r\n', 'utf8'));
    feeder.flush();
    assert.deepEqual(lines, ['line1', 'line2', 'line3'], 'CRLF 与 LF 混排应各自正确断行，不留 \\r 尾巴');
  });

  it('⑧ 跨 push 的 \\r\\n（\\r 落在一次 push 末尾，\\n 落在下一次开头）不产生空行或吞字', () => {
    const lines = [];
    const feeder = createNdjsonLineFeeder(line => lines.push(line));
    feeder.push(Buffer.from('line1\r', 'utf8'));
    feeder.push(Buffer.from('\nline2\n', 'utf8'));
    feeder.flush();
    assert.deepEqual(lines, ['line1', 'line2']);
  });
});
