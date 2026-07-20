#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// compact-quality-live.e2e.js — 第45波 45e:压缩质量评测夹具(LIVE,手工跑,真实 API)
//
//   node dev-harness/compact-quality-live.e2e.js
//
// 回答的问题:结构化摘要(45e 四段式)压缩后,关键事实还在不在?此前无任何质量验收手段。
// 方法:合成一段含 10 个「事实标记」的长对话(暗号/文件路径/决定/待办/数字/人名…),
// 真调 providerSummaryCall(45a 预算化内核),对摘要文本做标记命中计数 —— 确定性判定,
// 不需要第二个模型当裁判。验收线:≥8/10 可回忆(路线图量化目标)。
// provider 取用户真实 config.json 的 activeProvider(本机已配);未配 → SKIP 退出 0。
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离:只读真实 config 拿凭据;校准存储等写面仍指向临时根。
const REAL_HOME = process.env.WIN_CLAUDE_WORKBENCH_HOME || path.join(os.homedir(), '.win-claude-workbench');
process.env.WIN_CLAUDE_WORKBENCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w45-quality-'));

const WB = path.resolve(__dirname, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));

const FACTS = [
  { marker: 'PINEAPPLE-42', where: 'user', text: '本次任务的暗号是 PINEAPPLE-42,后面问你时要能答出来。' },
  { marker: 'E:\\project\\billing\\invoice.js', where: 'user', text: '问题出在 E:\\project\\billing\\invoice.js 这个文件。' },
  { marker: '方案B', where: 'assistant', text: '结论:在方案A和方案B之间,我们最终决定采用方案B(异步队列),放弃方案A。' },
  { marker: '修复登录页超时', where: 'user', text: '待办清单第一项:修复登录页超时(用户反馈超过 30 秒)。' },
  { marker: '17 个', where: 'assistant', text: '扫描完成:一共发现 17 个未处理的异常分支。' },
  { marker: '张伟', where: 'user', text: '接口对接人是张伟,有问题找他确认字段口径。' },
  { marker: '2026-08-01', where: 'assistant', text: '已确认:上线窗口定在 2026-08-01,不能推迟。' },
  { marker: ' PostgreSQL 15', where: 'user', text: '生产库是 PostgreSQL 15,不要用 MySQL 的语法。' },
  { marker: 'token 有效期 2 小时', where: 'assistant', text: '查证结果:他们的 access token 有效期 2 小时,过期要重新走刷新流程。' },
  { marker: '不要再动 config.yaml', where: 'user', text: '约束:不要再动 config.yaml,上次改坏过一次。' },
];

function buildHistory() {
  const h = [];
  h.push({ role: 'user', content: '我们的目标:为账单系统做一次稳定性整改。' });
  const filler = i => `第 ${i} 轮讨论:关于缓存、重试、日志与监控的常规展开,`.repeat(30);
  FACTS.forEach((f, i) => {
    h.push({ role: 'user', content: filler(i) });
    h.push({ role: 'assistant', content: filler(i + 100) });
    h.push({ role: f.where === 'user' ? 'user' : 'assistant', content: f.text });
    h.push({ role: f.where === 'user' ? 'assistant' : 'user', content: '好的,记下了。' });
  });
  h.push({ role: 'user', content: '先到这里,后面继续。' });
  return h;
}

(async () => {
  console.log('COMPACT QUALITY LIVE(45e 结构化摘要质量评测,真实 API)');
  const cfg = JSON.parse(fs.readFileSync(path.join(REAL_HOME, 'config.json'), 'utf8'));
  // 优先激活 provider;用户主用 claude 引擎时(activeProvider 为空)回落到任一可用的 OpenAI 兼容 provider。
  const provider = (cfg.providers || []).find(p => p.id === cfg.activeProvider)
    || (cfg.providers || []).find(p => p.baseUrl && (p.apiKey || (p.models && p.models.length)));
  if (!provider) { console.log('SKIP: 未配置激活 provider'); return; }
  console.log('provider:', provider.id, '| model:', provider.model || (provider.models && provider.models[0] && provider.models[0].id));

  const history = buildHistory();
  const est = srv.estimateHistoryTokens(history);
  console.log('历史规模: ' + history.length + ' 条 / 约 ' + est + ' tokens(估算)');
  const sc = await srv.providerSummaryCall(provider, history);
  if (!sc.ok) { console.log('摘要调用失败: ' + sc.error); process.exitCode = 1; return; }
  console.log('摘要 ' + sc.summary.length + ' 字符' + (sc.mapReduce ? '(map-reduce ×' + sc.mapReduce.chunks + ')' : '') + (sc.droppedMiddle ? '(截断中段 ' + sc.droppedMiddle + ' 条)' : ''));

  const hits = FACTS.filter(f => sc.summary.includes(f.marker.trim()));
  const misses = FACTS.filter(f => !sc.summary.includes(f.marker.trim()));
  console.log('\n命中 ' + hits.length + '/10:');
  for (const f of hits) console.log('  ✓ ' + f.marker.trim());
  for (const f of misses) console.log('  ✗ ' + f.marker.trim());
  // 结构检查:四段式标题应在摘要中出现(45e prompt 的产出契约)
  const sections = ['目标', '决定', '未完成', '关键文件'].filter(s => sc.summary.includes(s));
  console.log('四段式结构标记: ' + sections.length + '/4');

  const pass = hits.length >= 8;
  console.log('\nCOMPACT QUALITY: ' + (pass ? 'PASS (≥8/10 可回忆)' : 'FAIL (<8/10)'));
  if (!pass) process.exitCode = 1;
})().catch(e => { console.error(e && e.stack || e); process.exitCode = 1; });
