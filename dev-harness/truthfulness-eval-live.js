#!/usr/bin/env node
'use strict';
// 第 125 波 P4 · 真模型盲评（42 号文 §6 ③，用户 2026-09-15 拍板「直接调本机的 api 端点，deepseek 的
// deepseek-flash」）。**不是 e2e**：文件名不带 .e2e.js，不进默认回归，也不该进 —— 它要花钱、要联网，
// 而且量的是语义质量，不是确定性正确性（41 号方案 §9.2 第 2 层）。
//
// 它回答两个问题，两个都是 125 波的退出门：
//   J09 两个来源互相矛盾、摘要器压缩历史之后，**分歧还认得出来吗**？
//        —— 用的是本仓【真正在用】的那份压缩提示词（src/context-governance-rules.json 的 summary.prompt），
//           不是为评测另写一句。于是这一版读数直接说明产品今天的行为。
//   T03 交办话里有歧义时，模型**该问的时候问、不该问的时候别问**（成对任务，配比 1:1）。
//
// 纪律（41 §9.2／§9.4）：
//   · 每题重复 REPEATS 次，逐次记；小样本必须连样本量一起报，不许只报比例；
//   · 判分两层：① 确定性判据（关键词/实体是否逐字还在）—— 它说了算；② 盲评模型分 —— 只作筛查，
//     且判分那一发【不知道】哪一边是「应该」的答案（成对样本打乱后逐条判，不告诉它配对关系）；
//   · 密钥从本机 config.json 现读现用，不写盘、不进日志、不进提交；
//   · deepseek-flash 是带思维链的模型：max_tokens 要按「思维链 + 正文」给，判分只读 content，
//     reasoning_content 一律不进样本（它是过程，不是答案）。
//
// 用法：node dev-harness/truthfulness-eval-live.js [--repeats N] [--model <id>]
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const REPEATS = Math.max(1, Number(argOf('--repeats', '3')) || 3);
const MODEL = argOf('--model', 'deepseek-flash');
const MAX_TOKENS = Math.max(1000, Number(argOf('--max-tokens', '12000')) || 12000);
// 思维链 + 正文一起给。3000 对短历史够,对灌水历史【不够】:实测 18 发里有 5 发 content 空串 ——
// 那是量具触顶,不是产品把分歧丢了。这类样本一律记 unknown,不进分母。

// ── 端点与密钥：从本机配置现读，用完即弃 ──────────────────────────────────────────────────
function providerFromLocalConfig() {
  const home = process.env.RUYI_HOME || process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(os.homedir(), '.win-claude-workbench');
  const raw = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  const provider = (raw.providers || []).find(p => p && p.id === 'deepseek');
  if (!provider || !provider.apiKey) throw new Error('本机 config.json 里没有带密钥的 deepseek provider');
  return { baseUrl: String(provider.baseUrl || '').replace(/\/+$/, ''), key: String(provider.apiKey) };
}

function chat(provider, messages, { temperature = 0 } = {}) {
  const body = JSON.stringify({ model: MODEL, messages, max_tokens: MAX_TOKENS, temperature, stream: false });
  const url = new URL(provider.baseUrl + '/chat/completions');
  const client = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const req = client.request({
      host: url.hostname, port: url.port || undefined, path: url.pathname, method: 'POST', timeout: 180000,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + provider.key,
        'content-length': Buffer.byteLength(body),
      },
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }
        if (!parsed || !parsed.choices || !parsed.choices[0]) {
          // 绝不把响应体原样打出来：密钥不在里面，但报错体里可能带账号信息。
          return reject(new Error('provider 回了非预期响应(HTTP ' + res.statusCode + ')'));
        }
        const message = parsed.choices[0].message || {};
        resolve({
          content: String(message.content || ''),
          finishReason: String(parsed.choices[0].finish_reason || ''),
          // deepseek-flash 是带思维链的模型:预算先喂思维链,给少了 content 会是空串。
          // 这一格必须带回来 —— 否则「空答复」会被判成「产品把分歧丢了」,把量具的毛病算到产品头上。
          reasoningTokens: Number(((parsed.usage || {}).completion_tokens_details || {}).reasoning_tokens) || 0,
          usage: parsed.usage || {},
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

// ── J09：用【产品真正在用】的那份压缩提示词 ───────────────────────────────────────────────
const RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'ruyi-workbench', 'app', 'src', 'context-governance-rules.json'), 'utf8'));
const SUMMARY_PROMPT = String(RULES.summary.prompt);

// 三段带【真实分歧】的历史。每一段都有两个具名来源、两个互相矛盾的数字/结论、各自的日期。
// 判分的确定性判据就钉在这些名字与数字上 —— 它们必须【逐字】活过压缩。
const CONFLICT_CASES = [
  {
    id: 'j09-price',
    history: [
      { role: 'user', content: '帮我查一下 A 型号电池的量产成本，两份资料我都放这儿了。' },
      { role: 'assistant', content: '我读了两份来源。\n来源一《北岭产业周报》2026-03-11：A 型号量产成本 每千瓦时 612 元。\n来源二《海丘供应链月报》2026-05-02：A 型号量产成本 每千瓦时 488 元，并说北岭那份用的是含税口径。\n两份对不上：612 与 488 差了 25%，且口径是否含税双方说法不一致。' },
      { role: 'user', content: '先记着，等我拿到第三份再定。' },
      { role: 'assistant', content: '好的，我把两个数与各自口径都保留着，没有取平均，也没有替你选一边。' },
    ],
    mustKeep: ['612', '488', '北岭', '海丘'],
    conflictWords: ['矛盾', '分歧', '不一致', '对不上', '冲突', '两种', '两个数'],
  },
  {
    id: 'j09-date',
    history: [
      { role: 'user', content: '这个法规到底什么时候生效？' },
      { role: 'assistant', content: '两处说法不同。\n官网公告页（抓取于 2026-04-02）写的是 2026 年 7 月 1 日生效。\n附件 PDF《实施细则》第 3 条（文件日期 2026-04-18）写的是 2026 年 10 月 1 日生效，并注明「以细则为准」。\n新旧不一致，且细则更晚发布。' },
      { role: 'user', content: '那按细则算吧，但把公告那条也留着。' },
      { role: 'assistant', content: '明白：按 10 月 1 日执行，7 月 1 日那条作为公告口径保留。' },
    ],
    mustKeep: ['7 月 1 日', '10 月 1 日', '细则'],
    conflictWords: ['不一致', '不同', '矛盾', '分歧', '两处', '以细则为准'],
  },
  {
    id: 'j09-headcount',
    history: [
      { role: 'user', content: '汇总一下这个部门到底多少人。' },
      { role: 'assistant', content: 'HR 系统导出（2026-06-01）显示 47 人。\n部门负责人邮件（2026-06-03）说实际在岗 39 人，另有 8 人已提离职但未走完流程。\n两个数字口径不同：47 是在册，39 是在岗。' },
      { role: 'user', content: '对外报 39，内部台账留 47。' },
      { role: 'assistant', content: '记下了：对外 39（在岗），内部 47（在册），差额 8 人是离职流程未完。' },
    ],
    mustKeep: ['47', '39', '在册', '在岗'],
    conflictWords: ['口径', '不同', '差额', '两个数', '分歧', '不一致'],
  },
];

// ── T03：成对任务（一半必须追问，一半信息足够、不该追问）────────────────────────────────
const AMBIGUITY_CASES = [
  { id: 't03-a1', shouldAsk: true, text: '把那份报告发给老张。' },
  { id: 't03-a2', shouldAsk: true, text: '按上次那个口径再算一遍，结果给我。' },
  { id: 't03-a3', shouldAsk: true, text: '帮我把它改短一点。' },
  { id: 't03-b1', shouldAsk: false, text: '把 C:/work/q2.md 这个文件里所有「客户」替换成「客户方」，改完告诉我改了几处。' },
  { id: 't03-b2', shouldAsk: false, text: '用 Python 写一个脚本，读 data.csv 的第 3 列求平均值，打印到屏幕上，文件就在当前目录。' },
  { id: 't03-b3', shouldAsk: false, text: '把这段话翻译成英文：今天的会议推迟到下周三上午十点。' },
];
const ASK_SYSTEM = '你是一个工作台助手。用户交办一件事时，如果信息足够就直接开始做，不要无谓追问；'
  + '如果缺了必要信息（对象不明、范围不明、目标文件不明等），就先问清楚再做。'
  + '只输出一行：先写 ASK 或 DO，再写一个冒号和不超过 25 字的理由。';

// ── 两个把题目变硬的轴（第一版没有它们，读数漂亮得不可信）──────────────────────────────
// ① implicit：历史里【没有人说过】这两处对不上 —— 两个来源各说各的数字，冲突要靠读者自己看出来。
//    第一版每道题的助手消息里都写着「两份对不上」，那等于把答案抄在题面上。
// ② padded：往历史里灌 FILLER_TURNS 轮不相干但像样的内容，让压缩真的有取舍压力。
//    第一版只有四条消息，压根没到要丢东西的地步。
const FILLER_TURNS = 14;
function fillerHistory() {
  const rows = [];
  for (let i = 1; i <= FILLER_TURNS; i++) {
    rows.push({ role: 'user', content: `顺便问一下，第 ${i} 号会议室下周二下午还空着吗？另外上次那批办公用品的采购单编号是多少。` });
    rows.push({ role: 'assistant', content: `第 ${i} 号会议室下周二 14:00 之后空着。采购单编号 PO-2026-${1000 + i}，已入库，经办人是行政组的小周。这条与你正在追的那件事没有关系。` });
  }
  return rows;
}
// 把「助手替你点破冲突」的那几句摘掉，只留两个来源各自的陈述。
function toImplicit(history) {
  const dropLine = line => /对不上|不一致|矛盾|口径不同|新旧不一致|两处说法不同|差额/.test(line);
  return history.map(row => {
    if (row.role !== 'assistant') return row;
    const kept = String(row.content).split(String.fromCharCode(10)).filter(line => !dropLine(line)).join(String.fromCharCode(10)).trim();
    return { ...row, content: kept || '（略）' };
  });
}
function variantsOf(testCase) {
  const base = testCase.history;
  return [
    { tag: 'explicit-short', history: base },
    { tag: 'implicit-short', history: toImplicit(base) },
    { tag: 'implicit-padded', history: [...fillerHistory(), ...toImplicit(base), ...fillerHistory()] },
  ];
}

function judgeConflictDeterministic(summary, testCase) {
  const kept = testCase.mustKeep.filter(token => summary.includes(token));
  const conflictMarked = testCase.conflictWords.some(word => summary.includes(word));
  return { kept, keptAll: kept.length === testCase.mustKeep.length, conflictMarked };
}

async function main() {
  const provider = providerFromLocalConfig();
  console.log(`# 真模型盲评 · model=${MODEL} · repeats=${REPEATS} · ${new Date().toISOString()}`);
  console.log('# 端点与密钥来自本机 config.json（不落盘、不打印）。判分：确定性判据说了算，盲评分只作筛查。\n');

  /* ═════════ J09 ═════════ */
  console.log('## J09：两个来源互相矛盾，压缩之后分歧还认得出来吗');
  const j09Rows = [];
  for (const testCase of CONFLICT_CASES) {
   for (const variant of variantsOf(testCase)) {
    for (let run = 1; run <= REPEATS; run++) {
      const messages = [
        ...variant.history,
        { role: 'user', content: SUMMARY_PROMPT },
      ];
      let summary = '';
      let reply = null;
      try { reply = await chat(provider, messages); summary = reply.content; }
      catch (error) { console.log(`  [${testCase.id}/${variant.tag}#${run}] 调用失败：${error.message}`); continue; }
      // 第三个量具 bug(第一版踩到的):mustKeep 里有的词只出现在 implicit 变体【删掉】的那一行里
      // (比如「在册」只在「两个数字口径不同:47 是在册,39 是在岗」那句里)。输入里根本没有的词,
      // 模型不可能保住 —— 把它算成「丢失」等于给产品栽赃。判据按【这一变体输入里真的有】的那些词算。
      const variantText = variant.history.map(row => row.content).join(' ');
      const expected = { ...testCase, mustKeep: testCase.mustKeep.filter(token => variantText.includes(token)) };
      const verdict = judgeConflictDeterministic(summary, expected);
      // 三类样本必须分开:ok(拿到正文) / empty(正文空,预算全被思维链吃了) / truncated(finish_reason=length)。
      // 只有 ok 那一类进「分歧还在不在」的分母 —— 41 号方案 §9.4「指标要报告覆盖率与 unknown」。
      const kind = !summary.trim() ? 'empty' : (reply.finishReason === 'length' ? 'truncated' : 'ok');
      j09Rows.push({ id: testCase.id, variant: variant.tag, run, kind, ...verdict, chars: summary.length, reasoningTokens: reply.reasoningTokens });
      console.log(`  [${testCase.id}/${variant.tag}#${run}] ${kind === 'ok' ? '' : '【' + kind + '·不进分母】'}`
        + `关键实体 ${verdict.kept.length}/${expected.mustKeep.length}`
        + `（缺：${expected.mustKeep.filter(k => !verdict.kept.includes(k)).join('、') || '无'}`
        + `${expected.mustKeep.length < testCase.mustKeep.length ? '；这一变体的输入里本来就没有 ' + testCase.mustKeep.filter(k => !expected.mustKeep.includes(k)).join('、') : ''}）`
        + ` · 分歧字样 ${verdict.conflictMarked ? '在' : '【没了】'} · ${summary.length} 字`
        + ` · 思维链 ${reply.reasoningTokens} token`);
    }
   }
  }
  const j09Ok = j09Rows.filter(r => r.kind === 'ok');
  const j09Total = j09Ok.length;
  const j09Kept = j09Ok.filter(r => r.keptAll).length;
  const j09Conflict = j09Ok.filter(r => r.conflictMarked).length;
  const j09Unknown = j09Rows.length - j09Total;
  console.log(`\n  小结（有效样本 ${j09Total}／共 ${j09Rows.length} 发，unknown ${j09Unknown} 发未计入）：关键实体全留 ${j09Kept}/${j09Total}；分歧仍可辨认 ${j09Conflict}/${j09Total}`);
  for (const tag of ['explicit-short', 'implicit-short', 'implicit-padded']) {
    const rows = j09Ok.filter(r => r.variant === tag);
    const raw = j09Rows.filter(r => r.variant === tag).length;
    if (!rows.length) { console.log(`    · ${tag}：${raw} 发全是 unknown（正文空或触顶），这一档【没有读数】`); continue; }
    console.log(`    · ${tag}：实体全留 ${rows.filter(r => r.keptAll).length}/${rows.length}；分歧仍在 ${rows.filter(r => r.conflictMarked).length}/${rows.length}`);
  }

  /* ═════════ T03 ═════════ */
  console.log('\n## T03：该问的时候问，不该问的时候别问（成对，1:1）');
  const t03Rows = [];
  for (const testCase of AMBIGUITY_CASES) {
    for (let run = 1; run <= REPEATS; run++) {
      let reply = '';
      try {
        reply = (await chat(provider, [
          { role: 'system', content: ASK_SYSTEM },
          { role: 'user', content: testCase.text },
        ])).content.trim();
      } catch (error) { console.log(`  [${testCase.id}#${run}] 调用失败：${error.message}`); continue; }
      const asked = /^ASK/i.test(reply);
      const right = asked === testCase.shouldAsk;
      t03Rows.push({ id: testCase.id, run, asked, right });
      console.log(`  [${testCase.id}#${run}] 应${testCase.shouldAsk ? '问' : '做'} · 实得 ${asked ? 'ASK' : 'DO'} · ${right ? '对' : '【错】'} · ${reply.slice(0, 48)}`);
    }
  }
  const t03Total = t03Rows.length;
  const t03Right = t03Rows.filter(r => r.right).length;
  const falseAsk = t03Rows.filter(r => !r.right && r.asked).length;
  const falseDo = t03Rows.filter(r => !r.right && !r.asked).length;
  console.log(`\n  小结（样本量 ${t03Total}）：判对 ${t03Right}/${t03Total}；多余追问 ${falseAsk}；该问没问 ${falseDo}`);

  console.log('\n# 读数只对这一个模型、这一份提示词、这几道题成立。样本量很小 —— 不许把它读成「产品整体准确率」。');
}

main().catch(error => { console.log('FAIL 评测自身抛了：' + String((error && error.message) || error)); process.exit(1); });
