#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// session-notes-merge.e2e.js — 第 105 波切片 d-B · session notes 增量合并(23 号方案 §4.1)
//
// 覆盖:
//   [U] 白盒(require server.js,临时数据根):
//       开关三态(默认开/显式 false/字符串 "true" 洗回 false) / 并集去重(重复行只留一份、
//       新行在前、prev 独有行追加在后) / open 节 replace(旧项消失) / 无 prev / 坏 prev 降级
//       为整体重写 / 「无」节视为空集 / 合并结果经 renderSessionNotesMarkdown 可再 parse(回环) /
//       maybeWriteSessionNotes 挂钩:merge 开=合并落盘、merge 关=整体重写逐字节现状、
//       单开 merge 无 105b = 零文件
//   [R] 跨进程:本进程合并写入,子进程 readSessionNotes 读回并可 parse 三节(跨重启可解析)
// ─────────────────────────────────────────────────────────────────────────────
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 隔离纪律:require server.js 之前把数据根指向临时目录(notes 会写 <data>/sessions)。
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105d-merge-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const srv = require(path.join(WB, 'app', 'server.js'));

let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };

const SUMMARY_V2 = [
  '【目标】修复登录页白屏',
  '',
  '【已确认的决定】',
  '- 新决定B',
  '- 用 JWT', // 与 prev 重复(行尾带空格,trim 后精确命中)
  '',
  '【未完成事项】',
  '- 新未完成',
  '',
  '【当前执行状态】',
  '已完成:定位根因;正在进行:写测试;阻塞:无;下一步:跑全量',
  '',
  '【关键文件与上下文】',
  '- src/a.js',
  '- src/old.js ',
].join('\n');

(async () => {
  // ═══ [U] 白盒:开关 / 合并语义 / 挂钩纪律 ═══
  console.log('── [U] session-notes 增量合并白盒契约 ──');

  const cfgDefault = srv.normalizeConfig({}).config;
  ok(srv.sessionNotesMergeEnabled(cfgDefault) === true, 'U1 默认配置 sessionNotesMergeEnabled=true(真实历史门后默认开)');
  const cfgMergeOff = srv.normalizeConfig({ runtimeSessionNotesMergeV1: false }).config;
  const cfgMerge = srv.normalizeConfig({ runtimeSessionNotesMergeV1: true }).config;
  ok(srv.sessionNotesMergeEnabled(cfgMergeOff) === false, 'U2 显式 false 时关闭(可回退整体重写)');
  const cfgStr = srv.normalizeConfig({ runtimeSessionNotesMergeV1: 'true' }).config;
  ok(srv.sessionNotesMergeEnabled(cfgStr) === false, 'U3 sanitize 只认 JSON 布尔(字符串 "true" 洗回 false)');

  const prevMd = srv.renderSessionNotesMarkdown(
    { decisions: '- 旧决定A\n- 用 JWT', open: '- 旧未完成', files: '- src/old.js\n- src/prev-only.js' },
    { sessionId: 'merge-u1', updatedAt: '2026-08-31T00:00:00.000Z', turnSeq: 1 });
  const nextNotes = srv.extractSessionNotes(SUMMARY_V2);

  const m1 = srv.mergeSessionNotes(prevMd, nextNotes);
  ok(m1.decisions === '- 新决定B\n- 用 JWT\n- 旧决定A', 'U4 并集去重:重复行(trim 后)只留一份、新行在前、prev 独有行追加在后');
  ok(m1.open === '- 新未完成', 'U5 open 节 replace:以最新摘要为准(旧项消失)');
  ok(m1.files === '- src/a.js\n- src/old.js\n- src/prev-only.js', 'U6 files 节同样并集去重');

  const m2 = srv.mergeSessionNotes(prevMd, { decisions: '无', open: '无', files: '无' });
  ok(m2.decisions === '- 旧决定A\n- 用 JWT' && m2.files === '- src/old.js\n- src/prev-only.js', 'U7 next 节为「无」视为空集:prev 行保留(并集)');
  ok(m2.open === '无', 'U8 open 节 next 为「无」→ 旧未完成事项消失(replace 语义,已完成必须能消失)');

  const m3 = srv.mergeSessionNotes(null, nextNotes);
  ok(m3 === nextNotes, 'U9 无 prev → 直接用 next(降级为 105b 整体重写语义)');
  const m4 = srv.mergeSessionNotes('垃圾内容没有任何节标题', nextNotes);
  ok(m4 === nextNotes, 'U10 坏 prev(解析失败)→ 直接用 next');
  const m5 = srv.mergeSessionNotes('', nextNotes);
  ok(m5 === nextNotes, 'U11 空串 prev → 直接用 next');

  // 回环:合并结果 render 后可再 parse,且内容一致
  const roundMd = srv.renderSessionNotesMarkdown(m1, { sessionId: 'merge-u1', turnSeq: 2 });
  const reParsed = srv.parseSessionNotesMarkdown(roundMd);
  ok(!!reParsed && reParsed.decisions === m1.decisions && reParsed.open === m1.open && reParsed.files === m1.files,
    'U12 合并结果经 renderSessionNotesMarkdown 可再 parse(回环一致)');
  ok(srv.parseSessionNotesMarkdown('没有标题') === null, 'U13 parse 对无标题文本返回 null(解析失败信号)');

  // 挂钩纪律:merge 开 → 落盘为合并结果;merge 关 → 整体重写(105b 现状逐字节);单开 merge 零文件
  const HOOK_SID = 'merge-hook';
  await srv.writeSessionNotes(HOOK_SID, prevMd); // 预置 prev
  const cfgBOnly = srv.normalizeConfig({ runtimeSessionNotesV1: true, runtimeSessionNotesMergeV1: false }).config; // 105b 开、merge 显式关
  srv.maybeWriteSessionNotes({ id: HOOK_SID, turnSeq: 2 }, SUMMARY_V2, cfgBOnly);
  await new Promise(r => setTimeout(r, 300));
  const offMd = await srv.readSessionNotes(HOOK_SID);
  ok(!!offMd && offMd.includes('- 新决定B') && !offMd.includes('旧决定A') && !offMd.includes('prev-only'),
    'U14 merge 显式关→整体重写:prev 独有行消失(105b 现状语义)');

  await srv.writeSessionNotes(HOOK_SID, prevMd); // 再预置 prev
  const cfgBoth = srv.normalizeConfig({ runtimeSessionNotesV1: true, runtimeSessionNotesMergeV1: true }).config;
  srv.maybeWriteSessionNotes({ id: HOOK_SID, turnSeq: 3 }, SUMMARY_V2, cfgBoth);
  await new Promise(r => setTimeout(r, 300));
  const onMd = await srv.readSessionNotes(HOOK_SID);
  ok(!!onMd && onMd.includes('- 新决定B') && onMd.includes('- 旧决定A') && onMd.includes('prev-only'),
    'U15 merge 开 → 落盘合并结果:next 新行与 prev 独有行并存');
  ok(onMd && onMd.includes('- 新未完成') && !onMd.includes('- 旧未完成'), 'U16 merge 开 → open 节 replace 落盘');
  const onParsed = srv.parseSessionNotesMarkdown(onMd);
  ok(!!onParsed && onParsed.decisions === '- 新决定B\n- 用 JWT\n- 旧决定A', 'U17 落盘合并结果可再 parse(回环)');

  const ONLY_MERGE_SID = 'merge-only';
  const cfgMergeOnly = srv.normalizeConfig({ runtimeSessionNotesV1: false, runtimeSessionNotesMergeV1: true }).config; // 105b 显式关、单开 merge
  srv.maybeWriteSessionNotes({ id: ONLY_MERGE_SID, turnSeq: 1 }, SUMMARY_V2, cfgMergeOnly);
  await new Promise(r => setTimeout(r, 200));
  ok(!fs.existsSync(srv.sessionNotesPath(ONLY_MERGE_SID)), 'U18 单开 merge 而无 105b → 零文件(挂在 105b 写链内)');

  // ═══ [H] 项目真实 checkpoint:相邻 L2 摘要增量合并 ═══
  console.log('── [H] 真实历史 notes 增量合并 ──');
  const hDir = path.join(HERE, 'realhist-fixtures', 'checkpoints', 'sess_fe3de15dfc3b8354');
  const h24 = path.join(hDir, 'history-24.json.gz'), h26 = path.join(hDir, 'history-26.json.gz');
  if (!fs.existsSync(h24) || !fs.existsSync(h26)) {
    console.log('SKIP H1-H4 realhist fixture 不在当前环境');
  } else {
    try {
      const zlib = require('zlib');
      const readSummary = p => String(JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'))[0].content || '').replace(/^\(以下是此前对话的压缩摘要\)\s*/, '');
      const prev = srv.extractSessionNotes(readSummary(h24));
      const next = srv.extractSessionNotes(readSummary(h26));
      const merged = srv.mergeSessionNotes(srv.renderSessionNotesMarkdown(prev, { sessionId: 'merge-h', turnSeq: 24 }), next);
      const mergedRound = srv.parseSessionNotesMarkdown(srv.renderSessionNotesMarkdown(merged, { sessionId: 'merge-h', turnSeq: 26 }));
      const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(x => x && x !== '无');
      ok(lines(prev.decisions).length + lines(prev.files).length > 0 && lines(next.decisions).length + lines(next.files).length > 0, 'H1 真实 history-24/26 都含可合并的决定或关键文件');
      ok([...lines(prev.decisions), ...lines(next.decisions)].every(x => lines(merged.decisions).includes(x)) && [...lines(prev.files), ...lines(next.files)].every(x => lines(merged.files).includes(x)), 'H2 真实历史决定/关键文件并集无丢失');
      ok(merged.open === next.open, 'H3 真实历史未完成事项以最新摘要为准');
      ok(!!mergedRound && JSON.stringify(merged) === JSON.stringify(mergedRound), 'H4 真实合并结果 render/parse 回环一致');
    } catch (e) { ok(false, 'H* 真实历史解析异常: ' + e.message); }
  }

  // ═══ [R] 跨进程:合并结果跨重启可读回并可 parse ═══
  console.log('── [R] 跨进程读回 ──');
  {
    const child = cp.spawnSync(process.execPath, ['-e',
      `const srv=require(${JSON.stringify(path.join(WB, 'app', 'server.js'))});` +
      `(async()=>{const t=await srv.readSessionNotes(${JSON.stringify(HOOK_SID)});` +
      `const p=t&&srv.parseSessionNotesMarkdown(t);` +
      `console.log(JSON.stringify({len:t&&t.length,decisions:p&&p.decisions,open:p&&p.open,files:p&&p.files}));})();`],
      { env: { ...process.env, WIN_CLAUDE_WORKBENCH_HOME: HOME, RUYI_HOME: HOME }, encoding: 'utf8', timeout: 30000 });
    let out = null; try { out = JSON.parse(String(child.stdout || '').trim().split('\n').pop()); } catch { /* ignore */ }
    ok(out && out.len === onMd.length, 'R1 子进程(模拟重启后)读回合并 notes 长度一致');
    ok(!!out && out.decisions === '- 新决定B\n- 用 JWT\n- 旧决定A' && out.open === '- 新未完成'
      && out.files === '- src/a.js\n- src/old.js\n- src/prev-only.js', 'R2 子进程 parse 三节与合并预期逐字节一致');
  }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nSESSION-NOTES-MERGE E2E: ' + (failures ? 'FAIL (' + failures + ')' : 'ALL PASS'));
  setImmediate(() => process.exit(failures ? 1 : 0));
})().catch(e => { console.error(e && e.stack || e); process.exit(1); });
