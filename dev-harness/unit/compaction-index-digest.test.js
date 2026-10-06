'use strict';
// L2 摘要后附的「已执行的工具调用」索引(10 buildCompactionToolIndex)每行的参数摘要:路径类参数掐中间、留文件名。
// 2026-10 Windows CI 实测:provider-compact-recall M2 在 C:\Users\RUNNER~1\AppData\Local\Temp\… 这种长前缀下
// 从尾部截断,索引行里只剩盘符与用户目录、没有 big1.txt —— 模型看不出哪次调用读的是哪个文件。Linux 的 /tmp 前缀短,
// 那件 e2e 在本机测不到,这里直接钉纯函数。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-unit-compaction-digest-'));
process.env.RUYI_HOME = home;
const { loadServerInternals } = require('../lib/server-internals');
const { compactionToolArgsDigest } = loadServerInternals(['compactionToolArgsDigest']);

const LONG_WIN = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\ruyi-e2e-home-gVpc2o\\ruyi-provider-compact-recall\\ws\\big1.txt';

describe('compaction tool index · argument digest', () => {
  it('a long Windows path keeps its file name (middle is elided, not the tail)', () => {
    const line = compactionToolArgsDigest(JSON.stringify({ path: LONG_WIN }));
    assert.match(line, /^path=C:\\/);
    assert.ok(line.endsWith('big1.txt'), line);
    assert.ok(line.includes('…'), line);
    assert.ok(line.length <= 'path='.length + 61, `digest stays within budget: ${line.length}`);
  });
  it('other path-like keys (dest / cwd) keep their tails too', () => {
    const line = compactionToolArgsDigest({ dest: LONG_WIN.replace('big1.txt', 'out-final.docx'), cwd: LONG_WIN.replace('\\big1.txt', '') });
    assert.ok(line.includes('out-final.docx'), line);
    assert.ok(/cwd=.*\\ws$/.test(line), line);
  });
  it('non-path arguments still keep the head (a query reads from its start)', () => {
    const line = compactionToolArgsDigest({ query: 'how to configure the proxy ' + 'x'.repeat(80) });
    assert.ok(line.startsWith('query=how to configure the proxy'), line);
    assert.ok(line.endsWith('…'), line);
  });
  it('short values are untouched', () => {
    assert.equal(compactionToolArgsDigest({ path: '/tmp/a/b.txt' }), 'path=/tmp/a/b.txt');
  });
});
