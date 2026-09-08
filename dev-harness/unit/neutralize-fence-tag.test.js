// Unit: 第 117 波 117q-B5(30 号文 §3 总表 P2-8「中和伪造围栏标签」)—— 防提示词注入判据
// neutralizeFenceTag(text, tagName) 的真值表 + 单一事实源静态锁。
//
// 根因(30 号文 §3):把不可信文本里可能出现的 `<TAG`/`</TAG` 前括号换成方括号(防止提前闭合/伪造调用方
// 外层拼接的固定字面围栏)这条判据,此前在 06d-memory-domain.js(×2)/06e-mission-domain.js/
// 06-provider-engine.js(×2)/09-workflow.js 六处手写了六遍——标签名各写各的,形状(gi 标志 + 可选
// 斜杠捕获组)完全一致,判据一致全靠人工复制维持。117q-B5 把它收进 00-boot.js 的 neutralizeFenceTag,
// 六个调用点原样改成调它,输出字节级不变(不动各自后面的空白折叠/trim/null 兜底等链式处理)。
//
// 覆盖:
//   ① 闭合标签 `</TAG` 被中和成 `[/TAG`,开标签 `<TAG` 被中和成 `[TAG`
//   ② 大小写混排(gi 标志)都命中
//   ③ 未命中的文本一字不改(含空串/纯文本/不含尖括号)
//   ④ 全局替换:同一字符串里出现多次都被中和(g 标志)，不同标签名互不串扰
//   ⑤ null/undefined 输入按 String() 强制转换(与原六处调用点各自的 String(t) 起点行为一致——
//      本函数只做「中和」这一步,null/undefined 的兜底是调用方各自的既有职责,不在本函数内)
//   ⑥ 前缀匹配是既有行为(不是新引入的宽松化):正则本就没有词边界/结尾锚点,`<workbench-memory-core>`
//      在按 tagName='workbench-memory' 中和时前缀一样会命中——这是六处原实现共有的既有行为,原样保留
//   ⑦ 静态锁:00-boot.js 里 neutralizeFenceTag 只定义一份;06d/06e/06/09 六个调用点全部改调它,
//      不再各自手写 `.replace(/<(\/?)…/gi, ...)` 字面量
//
// 与既有 dev-harness/unit 件同款约定(见 steward-wait-reason.test.js):require server.js 前先把
// WIN_CLAUDE_WORKBENCH_HOME 覆盖到临时目录;PASS/FAIL 逐条打印,process.exit(fail?1:0)。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-neutralize-fence-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
process.env.RUYI_HOME = root;
const repo = path.resolve(__dirname, '../..');
const app = path.join(repo, 'ruyi-workbench', 'app');
const srv = require(path.join(app, 'server.js'));

let fail = 0;
const ok = (condition, label) => { if (condition) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

const { neutralizeFenceTag } = srv;

/* ═══════════ ① 导出形状 ═══════════ */
ok(typeof neutralizeFenceTag === 'function', '① server.js 导出了 neutralizeFenceTag');

/* ═══════════ ② 开/闭标签中和 + 大小写混排 ═══════════ */
// 注意(与原六处「六个字面量」逐字一致的行为):gi 的 i 只让【匹配】不分大小写,替换串里的标签名
// 用的是调用方传入的 tagName 字面量(六处调用点全传小写规范名),不是把源文本里匹配到的原始大小写抄回去——
// 这正是原正则 `.replace(/<(\/?)mission-ledger/gi, '[$1mission-ledger')` 的既有行为,原样保留。
{
  ok(neutralizeFenceTag('</workbench-memory>', 'workbench-memory') === '[/workbench-memory>', '②a 闭合标签 </TAG 中和成 [/TAG');
  ok(neutralizeFenceTag('<workbench-memory>', 'workbench-memory') === '[workbench-memory>', '②b 开标签 <TAG 中和成 [TAG');
  ok(neutralizeFenceTag('<MISSION-LEDGER>', 'mission-ledger') === '[mission-ledger>', '②c 全大写源文本也命中(gi 的 i),替换串用 tagName 字面量的大小写');
  ok(neutralizeFenceTag('</Mission-Ledger>', 'mission-ledger') === '[/mission-ledger>', '②d 大小写混排 + 闭合都命中');
  ok(neutralizeFenceTag('<skill-INDEX>', 'skill-index') === '[skill-index>', '②e 标签名内部混排大小写照样命中');
}

/* ═══════════ ③ 未命中文本一字不改 ═══════════ */
{
  ok(neutralizeFenceTag('', 'workbench-memory') === '', '③a 空串原样');
  const plain = '这是一段普通描述,不含任何尖括号围栏标记。';
  ok(neutralizeFenceTag(plain, 'workbench-memory') === plain, '③b 纯文本一字不改');
  const otherTag = '<project-memory>不是 workbench-memory 标签</project-memory>';
  ok(neutralizeFenceTag(otherTag, 'workbench-memory') === otherTag, '③c 不同标签名互不命中,原样保留');
  const halfAngle = '5 < 6 而 workbench-memory 单独出现,前面没有紧跟的尖括号';
  ok(neutralizeFenceTag(halfAngle, 'workbench-memory') === halfAngle, '③d 尖括号与标签名不相邻时不误伤');
}

/* ═══════════ ④ 全局替换 + 互不串扰 ═══════════ */
{
  const twice = '<workbench-memory>A</workbench-memory>…<workbench-memory>B</workbench-memory>';
  const out = neutralizeFenceTag(twice, 'workbench-memory');
  ok(!/<\/?workbench-memory/i.test(out), '④a 同一字符串里的多次出现全部被中和(g 标志)');
  ok((out.match(/\[\/?workbench-memory/gi) || []).length === 4, '④b 四处标记(2 开 2 闭)都命中,数量不多不少');
  const mixed = '<mission-ledger>M</mission-ledger> 与 <workbench-memory>W</workbench-memory> 同段出现';
  const outMission = neutralizeFenceTag(mixed, 'mission-ledger');
  ok(!/<\/?mission-ledger/i.test(outMission), '④c 按 mission-ledger 中和时,mission-ledger 标记消失');
  ok(/<workbench-memory>/.test(outMission) && /<\/workbench-memory>/.test(outMission), '④d 按 mission-ledger 中和时,不相关的 workbench-memory 标记原样保留(互不串扰)');
}

/* ═══════════ ⑤ null/undefined 走 String() 起点(与原六处调用点各自 String(t) 一致) ═══════════ */
{
  ok(neutralizeFenceTag(null, 'workbench-memory') === 'null', '⑤a null → String(null) = "null",不含标签,原样返回');
  ok(neutralizeFenceTag(undefined, 'workbench-memory') === 'undefined', '⑤b undefined → String(undefined) = "undefined"');
  ok(neutralizeFenceTag(0, 'workbench-memory') === '0', '⑤c 数字 0 走 String() 起点(与原 String(t) 行为一致,不是本函数新增兜底)');
}

/* ═══════════ ⑥ 前缀匹配是既有行为(原样保留,不是本次引入的宽松化) ═══════════ */
{
  const core = '<workbench-memory-core>';
  ok(neutralizeFenceTag(core, 'workbench-memory') === '[workbench-memory-core>', '⑥ tagName 是另一标签的前缀时,前缀命中(六处原实现共有的既有行为,原样保留)');
}

/* ═══════════ ⑦ 静态锁:单一事实源 + 六个调用点都已迁移 ═══════════ */
{
  const bootSrc = fs.readFileSync(path.join(app, 'src', '00-boot.js'), 'utf8');
  const defs = (bootSrc.match(/function neutralizeFenceTag\(/g) || []).length;
  ok(defs === 1, '⑦a 00-boot.js 里 neutralizeFenceTag 只有一份定义(got ' + defs + ')');

  const sites = [
    { file: '06d-memory-domain.js', needle: "neutralizeFenceTag(t, 'workbench-memory')" },
    { file: '06d-memory-domain.js', needle: "neutralizeFenceTag(String(value || ''), 'workbench-memory-core')" },
    { file: '06e-mission-domain.js', needle: "neutralizeFenceTag(t == null ? '' : t, 'mission-ledger')" },
    { file: '06-provider-engine.js', needle: "neutralizeFenceTag(text, 'project-memory')" },
    { file: '06-provider-engine.js', needle: "neutralizeFenceTag(t, 'skill-index')" },
    { file: '09-workflow.js', needle: "neutralizeFenceTag(note, 'workbench-plan-approved')" },
  ];
  for (const s of sites) {
    const src = fs.readFileSync(path.join(app, 'src', s.file), 'utf8');
    ok(src.includes(s.needle), '⑦b ' + s.file + ' 调用点已迁移到 neutralizeFenceTag: ' + s.needle);
  }

  // 六处不应再各自手写同款字面量正则(排除 00-boot.js 自身的实现)。
  const callerFiles = ['06d-memory-domain.js', '06e-mission-domain.js', '06-provider-engine.js', '09-workflow.js'];
  let leftoverLiterals = 0;
  for (const f of callerFiles) {
    const src = fs.readFileSync(path.join(app, 'src', f), 'utf8');
    const m = src.match(/replace\(\/<\(\\\/\?\)/g);
    if (m) leftoverLiterals += m.length;
  }
  ok(leftoverLiterals === 0, '⑦c 06d/06e/06/09 里不再残留手写的 `<(\\/?)…` 字面量正则(got ' + leftoverLiterals + ' 处)');
}

console.log('\nNEUTRALIZE-FENCE-TAG UNIT: ' + (fail ? 'FAIL (' + fail + ')' : 'ALL PASS'));
process.exit(fail ? 1 : 0);
