'use strict';
// 126-111d(25 号文 §1.2 / 44 号文 §4):摘要 prompt 双语与标题容错。真源码、临时存储、零模型请求。
//
// 补的是一条**现成的产品缺陷**:`config.locale` 支持 en-US,而摘要 prompt 一直是中文硬编码 ——
// 英文界面的用户拿到的压缩摘要是中文的。而**读的那一半早就双语了**:`summary.sections` 里
// `## Goal`／`## Decisions`／`## Open`／`## Current Status`／`## Files` 与 `stateLabels` 里的
// Done／In progress／Blocked／Next step 都是登记过的别名。缺的只有写的这一头。
//
// 判据分三组:
//   [A] 开关关 —— prompt 逐字节仍是今天那份中文(locale 是什么都一样)。
//   [B] 开关开 —— 只有 locale 恰是 en-US 才切英文(判据复用 06b 的 getPromptPack,auto 跟中文);
//       英文那份产出的摘要能过 validateStructuredSummary。
//   [C] 标题容错 —— `**Goal**`／`# Goal:`／`- Current Status —` 都认得;
//       但**正文里顺嘴提一句不算数**(这一条是反着验的,防止容错把门开太大)。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-summary-i18n-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
const rules = require(path.join(app, 'src', 'context-governance-rules.json'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const ON = locale => ({ runtimeSummaryPromptI18nV1: true, locale });
const OFF = locale => ({ runtimeSummaryPromptI18nV1: false, locale });

// 一份合格的英文摘要(五节齐全 + 状态四项),标题用 sections 里登记过的英文别名。
const EN_SUMMARY = [
  '## Goal', 'Ship wave 126.',
  '## Decisions', 'Keep every switch default-off.',
  '## Open', 'Three cuts left.',
  '## Current Status', 'Done: 111a. In progress: 111d. Blocked: none. Next step: 111b.',
  '## Files', 'src/10-context-governance.js',
].join('\n');

test('126-111d · 摘要 prompt 双语与标题容错', () => {
  let fail = 0;
  const ok = (cond, label) => { if (cond) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

  // ── [A] 开关关 = 逐字节仍是中文 ───────────────────────────────────────────────────
  ok(srv.summaryPromptI18nEnabled({}) === false, 'A1 缺省不生效');
  ok(srv.summaryPromptI18nEnabled({ runtimeSummaryPromptI18nV1: 'true' }) === false, 'A2 字符串 "true" 不生效');
  ok(srv.summaryPromptI18nEnabled({ runtimeSummaryPromptI18nV1: true }) === true, 'A3 显式 true 生效');
  for (const locale of ['zh-CN', 'en-US', 'auto', '']) {
    ok(srv.summaryPromptWithGuidance(OFF(locale)).startsWith('请把以上对话压缩为结构化摘要'),
      `A4 开关关时 locale=${locale || '(空)'} 仍然是中文那份`);
  }
  ok(srv.summaryPromptWithGuidance(OFF('en-US')) === srv.summaryPromptWithGuidance(undefined),
    'A5 开关关与不传 config 逐字节相同(与今天等价)');

  // ── [B] 开关开:只有 en-US 才切 ───────────────────────────────────────────────────
  ok(srv.summaryPromptWithGuidance(ON('en-US')).startsWith('Compress the conversation above'), 'B1 en-US 切到英文那份');
  ok(srv.summaryPromptWithGuidance(ON('zh-CN')).startsWith('请把以上对话压缩为结构化摘要'), 'B2 zh-CN 仍是中文');
  ok(srv.summaryPromptWithGuidance(ON('auto')).startsWith('请把以上对话压缩为结构化摘要'),
    'B3 **auto 跟中文** —— 判据复用 06b 的 getPromptPack(它只认 en-us),不另立一套');
  {
    // 英文那份要求的五个标题,必须都在 sections 别名表里登记过 —— 否则写出来的摘要读不回去。
    const en = rules.summary.promptEn;
    const missing = rules.summary.sections.filter(sec => !sec.some(alias => /^[#\s]*[A-Z]/.test(alias) && en.includes(alias)));
    ok(missing.length === 0, `B4 英文 prompt 要求的每一节都在别名表里登记过（缺 ${missing.length} 节）`);
    ok(rules.summary.stateLabels.every(labels => labels.some(l => /^[A-Z]/.test(l) && en.includes(l))),
      'B5 状态四项的英文词也都在 stateLabels 里登记过');
  }
  ok(srv.validateStructuredSummary(EN_SUMMARY) === true, 'B6 照英文 prompt 写出来的摘要,校验过得了');

  // ── [C] 标题容错 ─────────────────────────────────────────────────────────────────
  ok(srv.validateStructuredSummary(EN_SUMMARY.replace(/## (\w[\w ]*)/g, '**$1**')) === true,
    'C1 `**Goal**` 这类粗体标题认得');
  ok(srv.validateStructuredSummary(EN_SUMMARY.replace(/## (\w[\w ]*)/g, '# $1:')) === true,
    'C2 `# Goal:` 这类带冒号的认得');
  ok(srv.validateStructuredSummary(EN_SUMMARY.replace(/## (\w[\w ]*)/g, '- $1')) === true,
    'C3 `- Goal` 这类列表项标题认得');
  ok(srv.validateStructuredSummary(EN_SUMMARY.toLowerCase().replace('done:', 'Done:').replace('in progress:', 'In progress:').replace('blocked:', 'Blocked:').replace('next step:', 'Next step:')) === true,
    'C4 标题大小写不敏感');
  {
    // **反着验**:容错不能把门开太大。一段【没有任何小节标题】、只是在正文里提到这些词的文字,
    // 必须仍然判不合格 —— 否则模型随便写一段话就能骗过结构化校验。
    //
    // 夹具第一版栽在「差之毫厘」上:它把状态四项写成小写(in progress),于是它判不合格的真实原因
    // 是【状态标签对不上】,而不是【标题锚在行首】—— 把实现从 startsWith 放宽成 includes,这条
    // 断言照样绿(反向当场逮到)。现在状态四项按登记的大小写写全,**唯一还拦着它的就是行首那道锚**。
    const prose = [
      'We talked about the goal of the project and some decisions that were made.',
      'There are open questions, the current status is unclear, and several files changed.',
      'Done, In progress, Blocked, Next step were all mentioned in passing.',
    ].join('\n');
    ok(srv.validateStructuredSummary(prose) === false,
      'C5 **正文里顺嘴提一句不算数** —— 状态四项都在、只差小节标题,判据锚在行首所以仍然判不合格');
  }
  ok(srv.validateStructuredSummary('## Goal\nx\n## Decisions\ny\n## Open\nz\n## Files\nw') === false,
    'C6 缺状态节仍然判不合格(容错没放宽「状态四项齐全」这道门)');

  console.log('\nSUMMARY PROMPT I18N UNIT: ' + (fail ? `${fail} FAILURE(S)` : 'ALL PASS'));
  assert.equal(fail, 0, `${fail} 条判据未通过`);
});
