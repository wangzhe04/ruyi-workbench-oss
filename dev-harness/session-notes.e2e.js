#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// session-notes.e2e.js — 第 105 波切片 b · session-notes.md 状态外置(23 号方案 §4.1)
//
// 覆盖:
//   [U] 白盒(require server.js,临时数据根):
//       开关默认关/sanitize 只认 JSON 布尔 / extractSessionNotes 五节切分 /
//       缺节降级「无」 / 英文别名节标题 / 写读回环逐字节一致 / 整写覆盖 /
//       64K 截断标记 / 同会话并发写不撕裂 / maybeWriteSessionNotes 关时零文件、开时落盘三节
//   [R] 跨进程:本进程写 notes,子进程 readSessionNotes 逐字节读回(跨重启可解析)
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

// 隔离纪律:require server.js 之前把数据根指向临时目录(notes 会写 <data>/sessions)。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105b-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));

let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };

const SUMMARY_FULL = [
  '【目标】修复登录页白屏',
  '',
  '【已确认的决定】',
  '- 用方案 B:路由懒加载',
  '- 版本锁定 v2.6.2',
  '',
  '【未完成事项】',
  '- 补 e2e 回归',
  '',
  '【当前执行状态】',
  '已完成:定位根因;正在进行:写测试;阻塞:无;下一步:跑全量',
  '',
  '【关键文件与上下文】',
  '- app/src/01-config.js:102 开关定义',
].join('\n');

const SUMMARY_EN = [
  '## Goal',
  'fix blank login page',
  '## Decisions',
  'use lazy loading',
  '## Current Status',
  'Done: root cause; In progress: tests; Blocked: none; Next step: full regression',
  '## Files',
  'app/src/01-config.js',
].join('\n');

(async () => {
  // ═══ [U] 白盒:开关 / 提取 / 持久化 / 挂钩纪律 ═══
  console.log('── [U] session-notes 白盒契约 ──');

  const cfgOn = srv.normalizeConfig({}).config;
  ok(srv.sessionNotesEnabled(cfgOn) === true, 'U1 真实历史门通过后默认配置 sessionNotesEnabled=true');
  const cfgOff = srv.normalizeConfig({ runtimeSessionNotesV1: false }).config;
  ok(srv.sessionNotesEnabled(cfgOff) === false, 'U2 显式 false 时可完整关闭');
  const cfgStr = srv.normalizeConfig({ runtimeSessionNotesV1: 'true' }).config;
  ok(srv.sessionNotesEnabled(cfgStr) === false, 'U3 sanitize 只认 JSON 布尔(字符串 "true" 洗回 false)');

  const n1 = srv.extractSessionNotes(SUMMARY_FULL);
  ok(n1.decisions.includes('方案 B') && n1.decisions.includes('v2.6.2'), 'U4 切出【已确认的决定】内容完整');
  ok(n1.open.includes('补 e2e 回归'), 'U5 切出【未完成事项】');
  ok(n1.files.includes('01-config.js:102'), 'U6 切出【关键文件与上下文】');
  ok(!n1.decisions.includes('【未完成事项】') && !n1.open.includes('【当前执行状态】'), 'U7 节边界不互串');

  const n2 = srv.extractSessionNotes('【目标】x\n\n【当前执行状态】\n已完成:无;正在进行:无;阻塞:无;下一步:无');
  ok(n2.decisions === '无' && n2.open === '无' && n2.files === '无', 'U8 缺节全部降级为「无」');
  const n3 = srv.extractSessionNotes(SUMMARY_EN);
  ok(n3.decisions.includes('lazy loading') && n3.files.includes('01-config.js') && n3.open === '无',
    'U9 英文别名节标题同样可切(无【未完成事项】→ 无)');
  const n4 = srv.extractSessionNotes('');
  ok(n4.decisions === '无' && n4.open === '无' && n4.files === '无', 'U10 空摘要安全降级');

  const SID = 'notes-u1';
  const md1 = srv.renderSessionNotesMarkdown(n1, { sessionId: SID, updatedAt: '2026-08-31T00:00:00.000Z', turnSeq: 7 });
  ok(md1.startsWith('# Session Notes\n\n<!-- schema:1 session:' + SID + ' '), 'U11 markdown 头含 schema/session 注释');
  ok(md1.includes('## 已确认的决定') && md1.includes('## 未完成事项') && md1.includes('## 关键文件与上下文'), 'U12 markdown 含三个状态节');

  await srv.writeSessionNotes(SID, md1);
  const back1 = await srv.readSessionNotes(SID);
  ok(back1 === md1, 'U13 写读回环逐字节一致');
  const md2 = md1 + '\n第二版\n';
  await srv.writeSessionNotes(SID, md2);
  ok(await srv.readSessionNotes(SID) === md2, 'U14 整写覆盖(第二版取代第一版)');
  ok(fs.readFileSync(srv.sessionNotesPath(SID), 'utf8') === md2, 'U15 落盘路径为 sessions/<id>.session-notes.md');
  ok(await srv.readSessionNotes('notes-missing') === null, 'U16 缺文件读 → null(不抛)');

  const huge = 'h'.repeat(70000);
  await srv.writeSessionNotes(SID, huge);
  const backHuge = await srv.readSessionNotes(SID);
  ok(backHuge.length < 70100 && backHuge.includes('truncated'), 'U17 超 64K 截断并标记');

  // 并发写不撕裂:10 路并发,写链串行化 → 最终文件 = 最后一次调用的完整体
  const bodies = []; const writes = [];
  for (let i = 0; i < 10; i++) { const b = '# body-' + i + '\n' + 'w'.repeat(1000 + i); bodies.push(b); writes.push(srv.writeSessionNotes(SID, b)); }
  await Promise.all(writes);
  ok(await srv.readSessionNotes(SID) === bodies[9], 'U18 同会话 10 路并发写不撕裂(最终为末次完整写入)');

  // 挂钩纪律:关时零文件,开时落盘三节
  const HOOK_SID = 'notes-hook';
  srv.maybeWriteSessionNotes({ id: HOOK_SID, turnSeq: 1 }, SUMMARY_FULL, cfgOff);
  await new Promise(r => setTimeout(r, 200));
  ok(!fs.existsSync(srv.sessionNotesPath(HOOK_SID)), 'U19 开关关闭时挂钩零文件(默认零行为变化)');
  srv.maybeWriteSessionNotes({ id: HOOK_SID, turnSeq: 2 }, SUMMARY_FULL, cfgOn);
  await new Promise(r => setTimeout(r, 300));
  const hookMd = await srv.readSessionNotes(HOOK_SID);
  ok(!!hookMd && hookMd.includes('方案 B') && hookMd.includes('补 e2e 回归') && hookMd.includes('01-config.js:102'),
    'U20 开关开启时挂钩落盘三节内容');
  ok(hookMd && !hookMd.includes('【当前执行状态】') && !hookMd.includes('【目标】修复登录页白屏'),
    'U21 目标/执行状态留在摘要叙事,不进 notes');
  srv.maybeWriteSessionNotes({ id: 'notes-bad' }, null, cfgOn); // 缺 id/空摘要不得抛
  await new Promise(r => setTimeout(r, 100));
  ok(!fs.existsSync(srv.sessionNotesPath('notes-bad')) && !fs.existsSync(srv.sessionNotesPath('undefined')),
    'U22 缺 id/空摘要静默跳过(不建文件不抛错)');

  // ═══ [H] 真实历史摘要:105b 直接消费项目 checkpoint 中已有的 L2 摘要 ═══
  console.log('── [H] 真实历史摘要外置 ──');
  const HIST_SID = 'notes-realhistory';
  const histPath = path.join(HERE, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354', 'history-25.json.gz');
  const hist = JSON.parse(zlib.gunzipSync(fs.readFileSync(histPath)).toString('utf8'));
  const historicalSummary = String(hist[0] && hist[0].content || '').replace(/^\(以下是此前对话的压缩摘要\)\s*/, '');
  ok(historicalSummary.includes('【已确认的决定】') && historicalSummary.includes('【未完成事项】')
    && historicalSummary.includes('【关键文件与上下文】'), 'H1 fixture 首条消息是项目真实五节 L2 摘要');
  srv.maybeWriteSessionNotes({ id: HIST_SID, turnSeq: 25 }, historicalSummary, cfgOn);
  await new Promise(r => setTimeout(r, 300));
  const histNotes = await srv.readSessionNotes(HIST_SID);
  ok(!!histNotes && histNotes.includes('M2 实现') && histNotes.includes('abstainThreshold')
    && histNotes.includes('14-m2-deterministic-nodes.md'), 'H2 真实摘要的决定/未完成项/关键文件均写入 notes');
  ok(histNotes && !histNotes.includes('【目标】') && !histNotes.includes('【当前执行状态】'),
    'H3 真实摘要仍只外置三节，不混入目标/叙事状态');

  // ═══ [R] 跨进程:notes 跨重启可读回 ═══
  console.log('── [R] 跨进程读回 ──');
  {
    const child = cp.spawnSync(process.execPath, ['-e',
      `const srv=require(${JSON.stringify(path.join(WB, 'app', 'server.js'))});` +
      `srv.readSessionNotes(${JSON.stringify(SID)}).then(t=>{console.log(JSON.stringify({len:t&&t.length}));});`],
      { env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, encoding: 'utf8', timeout: 30000 });
    let out = null; try { out = JSON.parse(String(child.stdout || '').trim().split('\n').pop()); } catch { /* ignore */ }
    ok(out && out.len === bodies[9].length, 'R1 子进程(模拟重启后)读回 notes 长度一致');
  }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nSESSION-NOTES E2E: ' + (failures ? 'FAIL (' + failures + ')' : 'ALL PASS'));
  setImmediate(() => process.exit(failures ? 1 : 0));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
