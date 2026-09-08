#!/usr/bin/env node
// 静态锁：117q-B1（30 号文 §4.1「子进程 NDJSON 逐块解码」）。
//
// 钉两件事：
//   ① 三条子进程 NDJSON 主干道（05-claude-engine.js 主回合、07-autonomy.js 子代理、
//      05b-kimi-bridge.js ACP）里【不再出现】旧缺陷形状——对每个 chunk 单独 chunk.toString('utf8')
//      再拼接（CJK 3 字节，切在两个 data 事件之间会静默变成 U+FFFD）；三处改用同一份
//      createNdjsonLineFeeder，且它在 00-boot.js 里只有一份定义，不允许被复制到别的模块。
//   ② 05b-kimi-bridge.js 的 close/error 收尾都在 rejectPending 之前先 flush 残留半行——三者协议
//      都是「一行一个 JSON」，没理由 ACP 单独在半行 JSON 上突然退出时把最后一条消息静默丢掉
//      （05/07 原来就有这个 flush，05b 原来没有，这是本刀顺带修的漂移）。
'use strict';
const fs = require('fs');
const path = require('path');
const { readServerSource } = require('./src-reader');

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'ruyi-workbench', 'app', 'src');
const readMod = file => fs.readFileSync(path.join(SRC, file), 'utf8');

const src = readServerSource(); // 逻辑全文(拆分后 = manifest 顺序拼接;附带 freshness 校验)
const boot = readMod('00-boot.js');
const claudeEngine = readMod('05-claude-engine.js');
const kimiBridge = readMod('05b-kimi-bridge.js');
const autonomy = readMod('07-autonomy.js');

console.log('\n── [A] 旧缺陷形状在整条逻辑全文里【零命中】──');
// 旧形状: 某变量单独对 chunk 调 toString('utf8') 后再拼接(不经 StringDecoder)。
ok(!/chunk\.toString\(/.test(src), 'A1 全文不再出现 chunk.toString( ——三处逐块 toString 的旧解码形状已清零');
ok(!/\bbuffer\s*\+=\s*chunk\.toString/.test(src), 'A2 05b 原变量名 buffer 的旧拼接形状不再出现');
ok(!/\bstdoutRemainder\s*\+=\s*chunk\.toString/.test(src), 'A3 05/07 原变量名 stdoutRemainder 的旧拼接形状不再出现');

console.log('\n── [B] createNdjsonLineFeeder 只有一份定义,且落在 00-boot.js ──');
const defRe = /function createNdjsonLineFeeder\(onLine\)\s*\{/g;
ok((src.match(defRe) || []).length === 1, 'B1 整条逻辑全文里 createNdjsonLineFeeder 只定义一次');
ok((boot.match(/function createNdjsonLineFeeder\(onLine\)\s*\{/g) || []).length === 1, 'B2 定义落在 00-boot.js');
for (const [file, body] of [['05-claude-engine.js', claudeEngine], ['05b-kimi-bridge.js', kimiBridge], ['07-autonomy.js', autonomy]]) {
  ok(!/function createNdjsonLineFeeder\(/.test(body), `B3 ${file} 没有自己复制一份定义(只消费 00-boot 的符号)`);
}
ok(/const \{ StringDecoder \} = require\('string_decoder'\);/.test(boot), 'B4 00-boot.js 仍持有 StringDecoder(createNdjsonLineFeeder 内部依赖它,零新增运行时依赖)');
ok(/decoder\.write\(chunk\)/.test(boot) && /decoder\.end\(\)/.test(boot), 'B5 createNdjsonLineFeeder 内部走 decoder.write/decoder.end,不是逐块 toString');

console.log('\n── [C] 三处调用点都改用了 createNdjsonLineFeeder ──');
ok(/const stdoutFeeder = createNdjsonLineFeeder\(consumeLine\);/.test(claudeEngine), 'C1 05-claude-engine.js 主回合走 createNdjsonLineFeeder(consumeLine)');
ok(/child\.stdout\.on\('data', chunk => \{ stdoutFeeder\.push\(chunk\); \}\);/.test(claudeEngine), 'C2 05-claude-engine.js 的 data 处理器只转发给 feeder');
ok(/stdoutFeeder\.flush\(\);/.test(claudeEngine), 'C3 05-claude-engine.js 收尾调用 flush()');

ok(/const stdoutFeeder = createNdjsonLineFeeder\(consumeLine\);/.test(autonomy), 'C4 07-autonomy.js 子代理走 createNdjsonLineFeeder(consumeLine)');
ok(/child\.stdout\.on\('data', chunk => \{ stdoutFeeder\.push\(chunk\); \}\);/.test(autonomy), 'C5 07-autonomy.js 的 data 处理器只转发给 feeder');
ok(/closeStdin\(\);\s*stdoutFeeder\.flush\(\);\s*currentChild = null;/.test(autonomy), 'C6 07-autonomy.js 的 finish() 在 close/error 收尾里调用 flush()');

ok(/const stdoutFeeder = createNdjsonLineFeeder\(consumeAcpLine\);/.test(kimiBridge), 'C7 05b-kimi-bridge.js ACP 走 createNdjsonLineFeeder(consumeAcpLine)');
ok(/child\.stdout\.on\('data', chunk => \{ stdoutFeeder\.push\(chunk\); \}\);/.test(kimiBridge), 'C8 05b-kimi-bridge.js 的 data 处理器只转发给 feeder');

console.log('\n── [D] 附带修的漂移: 05b 的 close/error 在 rejectPending 之前先 flush ──');
ok(/child\.once\('error', error => \{ stdoutFeeder\.flush\(\); closed = true; rejectPending\(error\); \}\);/.test(kimiBridge),
  'D1 05b error 回调里 flush() 在 rejectPending(error) 之前');
ok(/child\.once\('close', code => \{\s*stdoutFeeder\.flush\(\);\s*closed = true;\s*rejectPending\(new Error/.test(kimiBridge),
  'D2 05b close 回调里 flush() 在 rejectPending(new Error(...)) 之前');

console.log('\nNDJSON LINE FEEDER STATIC E2E: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
