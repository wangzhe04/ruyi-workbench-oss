#!/usr/bin/env node
'use strict';
// Unit: 117o —— 管家流式回复只上屏 say，绝不把 JSON 信封端给用户。
//
// 用户第七轮走查②：「管家在规划的时候，会把格式也输出出来……会先出现 {say:...} 这种」。
// 管家回合的模型输出是一整个 JSON 信封，而 /api/steward/message 的 assistant_delta 是【原样】的模型
// 文本；修前前端把它直接追加上屏，于是先看到半截 JSON，等 steward_reply 到了才被替换成人话。
// stewardSayFromPartial 是这条修复的唯一判据：给它「到此刻为止的原始文本」，它只还原 say 已吐出的那段。
const path = require('path');
const url = require('url');

(async () => {
  const file = path.join(__dirname, '..', '..', 'ruyi-workbench', 'app', 'public', 'js', 'steward-chips.js');
  const mod = await import(url.pathToFileURL(file).href);
  const say = mod.stewardSayFromPartial;
  let fail = 0;
  const ok = (cond, label) => { if (cond) console.log('PASS ' + label); else { fail += 1; console.log('FAIL ' + label); } };
  const eq = (got, want, label) => ok(got === want, `${label}（got ${JSON.stringify(got)}）`);

  const q = String.fromCharCode(34);
  const bs = String.fromCharCode(92);
  const open = '{' + q + 'say' + q + ':' + q;

  eq(say(''), '', '空输入 -> 空');
  eq(say('{' + q + 'sa'), '', 'say 这个键还没吐完 -> 空（停在「···」）');
  eq(say(open + '我先看一眼'), '我先看一眼', '半截 say -> 只给已吐出的那一段');
  eq(say(open + '完整的一句' + q + ',' + q + 'why' + q + ':[' + q + '依据' + q + ']}'), '完整的一句',
    'say 收尾后不把 why 带出来');
  eq(say(open + '带' + bs + q + '引号' + bs + q + '的'), '带' + q + '引号' + q + '的', '转义引号还原');
  eq(say(open + '换' + bs + 'n行'), '换\n行', '转义换行还原');
  eq(say(open + '半个转义' + bs + 'u4f'), '半个转义', '尾部半个 unicode 转义被丢掉（不炸、不吐乱码）');
  eq(say(open + '尾部孤立反斜杠' + bs), '尾部孤立反斜杠', '尾部孤立反斜杠等下一片 delta');
  eq(say('这一趟根本不是 JSON，是纯文本'), '', '非 JSON -> 空（宁可少显示一拍）');
  eq(say('```json\n' + open + '围栏里的'), '围栏里的', '模型加了 ``` 围栏也能取到');
  eq(say('{' + q + 'why' + q + ':[' + q + 'x' + q + '],' + q + 'say' + q + ':' + q + '后出现的 say'), '后出现的 say',
    'say 不在信封开头也能取到');
  // 增量单调性：一段一段喂进去，取出来的 say 只增不减、且始终是最终值的前缀。
  const full = open + '一句会长大的话' + q + '}';
  const finalSay = say(full);
  let monotonic = true, prev = '';
  for (let i = 1; i <= full.length; i++) {
    const cur = say(full.slice(0, i));
    if (cur && (!finalSay.startsWith(cur) || cur.length < prev.length)) monotonic = false;
    if (cur) prev = cur;
  }
  ok(monotonic && finalSay === '一句会长大的话', '逐字符喂入时 say 单调增长且始终是最终值的前缀');

  console.log('');
  if (fail) { console.log(`STEWARD SAY STREAM UNIT: ${fail} FAILURE(S)`); process.exit(1); }
  console.log('STEWARD SAY STREAM UNIT: ALL PASS');
})().catch(error => { console.error(error && error.stack || error); process.exit(1); });
