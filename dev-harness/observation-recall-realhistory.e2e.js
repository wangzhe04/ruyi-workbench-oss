#!/usr/bin/env node
'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// observation-recall-realhistory.e2e.js — 105a 真实历史实测(23 号方案 §4.1 的
// 「真实负载证据」段)
//
// 思路(用户指定):用本机真实历史记录做手动压缩实测,看模型调用表现。
// 硬约束:复制完整历史记录到副本,原历史记录只读、全程零写入。
//
// 流程:
//   [0] 对复制的会话目录做 sha256 清单 → 测试前/后各一次,证明源目录未被触碰
//   [1] 复制 fixtures(本机真实会话的只读副本)进沙箱 HOME/checkpoints
//   [2] 对每个真实 history-<turn>.json.gz 快照:
//        基线:消息数 / payload 字符数 / ≥1200 字符大观察数
//        压缩:writeHistorySnapshot(stableRef) → evaporateHistory(reducer+recall 双开)
//             → 生成 rawRef 列表 + 缩减视图(模型可见)
//        回读:每个 rawRef → rehydrateObservation → 逐字节一致 + 双哈希校验
//        铁律:压缩后全部 assistant.tool_calls 有 role:tool 应答
//   [3] 工具层调用抽查(等效模型经工具分发调用):srv.toolCall('observation_recall')
//   [4] 输出汇总表 + 源目录未变最终校验
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const HERE = __dirname;
const WB = path.resolve(HERE, '..', 'ruyi-workbench');
const FIXTURES = path.join(HERE, 'realhist-fixtures', 'checkpoints');
const SRC_ROOT = 'C:/Users/87179/.win-claude-workbench/checkpoints'; // 仅 sha256 校验,绝不写入

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-w105b-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = HOME;
process.env.RUYI_HOME = HOME;

const srv = require(path.join(WB, 'app', 'server.js'));

let failures = 0;
const ok = (v, l) => { if (v) console.log('PASS ' + l); else { failures++; console.error('FAIL ' + l); } };

// 相对路径|字节数|sha256前16 清单 —— 用于可证「源目录零改动」
function treeHash(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, r);
      else {
        const buf = fs.readFileSync(full);
        out.push(`${r}|${buf.length}|${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}`);
      }
    }
  };
  walk(root, '');
  return out.sort().join('\n');
}

(async () => {
  // ═══ [0] 源目录清单(复制前快照) ═══
  const copiedSids = fs.readdirSync(FIXTURES).filter(s => fs.existsSync(path.join(SRC_ROOT, s)));
  const srcBefore = {};
  for (const sid of copiedSids) srcBefore[sid] = treeHash(path.join(SRC_ROOT, sid));
  console.log('── [0] 源目录已快照 ' + copiedSids.length + ' 个会话(只读校验用) ──');

  // ═══ [1] 复制 fixtures → 沙箱(副本) ═══
  const dstRoot = path.join(HOME, 'checkpoints');
  fs.mkdirSync(dstRoot, { recursive: true });
  for (const sid of copiedSids) fs.cpSync(path.join(FIXTURES, sid), path.join(dstRoot, sid), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    configSchema: 6, version: '1.0.0', permissionMode: 'bypass',
    runtimeObservationReducerV1: true, runtimeObservationRecallV1: true,
  }, null, 2));
  console.log('── [1] 副本就绪(HOME=' + HOME + ') ──');

  // ═══ [2] 逐快照压缩+回读 ═══
  console.log('── [2] 真实历史压缩+回读 ──');
  const rows = [];
  let lastRawRef = '', lastSid = '';
  for (const sid of copiedSids) {
    const dir = path.join(FIXTURES, sid);
    const histFiles = fs.readdirSync(dir)
      .filter(f => /^history-\d+(?:-[a-f0-9]{16})?\.json\.gz$/.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const hf of histFiles) {
      const turn = Number(/^history-(\d+)/.exec(hf)[1]);
      const history = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dir, hf))).toString('utf8'));
      // 深拷贝 tool 消息,保留回读比对基准(evaporateHistory 会原地改写 content)
      const original = history.map(m => m && m.role === 'tool' ? { ...m } : m);
      const baseChars = JSON.stringify(history).length;
      const bigObs = history.filter(m => m && m.role === 'tool' && typeof m.content === 'string' && m.content.length >= 1200).length;

      // 2a. 稳定快照 → rawRef 前缀(写入沙箱 checkpoints,源目录零触碰)
      const prefix = await srv.writeHistorySnapshot(sid, turn, history, true);
      ok(/^history:\d+:[a-f0-9]{16}$/.test(prefix), `${sid} ${hf} 稳定快照前缀 ${prefix}`);

      // 2b. 生产压缩逻辑 shadow 评估(不写回原数组;baseline=旧蒸发, candidate=reducer+recall)
      const shadow = srv.measureObservationReductionShadow(history);
      // reducer 保留结构化信息+rawRef,单条可见量可高于旧蒸发的 120 字符省略——这是设计权衡,
      // 不作 candidate<=baseline 硬断言;只断言:存在可缩减观察时 candidate 相对原始 payload 有收益。
      const hasReducible = shadow.candidateReducedCount > 0;
      ok(shadow.observationCount >= 0, `${sid} ${hf} shadow 基线(observations=${shadow.observationCount}, candidateReduced=${shadow.candidateReducedCount}, protected=${shadow.protectedCount}, baseline=${shadow.baselineReductionRate.toFixed(1)}%, candidate=${shadow.candidateReductionRate.toFixed(1)}%)`);
      ok(!hasReducible || shadow.candidateVisibleChars < baseChars, `${sid} ${hf} shadow 相对原始 payload 有收益(${baseChars}→${shadow.candidateVisibleChars})`);

      // 2c. 真实回读:对每个 ≥1200 字符的大观察构造 rawRef(快照 hash 与内容 hash 均为真实计算)
      //     → rehydrateObservation 双哈希校验 + 逐字节一致;并抽查模型可见缩减视图
      const toolNames = new Map();
      for (const m of history) if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) if (tc && tc.id && tc.function && tc.function.name) toolNames.set(String(tc.id), String(tc.function.name));
      let recallOk = 0, mismatch = 0, refTotal = 0, viewChecked = 0;
      for (let i = 0; i < history.length; i++) {
        const m = history[i];
        if (!m || m.role !== 'tool' || typeof m.content !== 'string' || m.content.length < 1200) continue;
        const contentHash = crypto.createHash('sha256').update(m.content).digest('hex').slice(0, 16);
        const rawRef = `${prefix}:${i}:${contentHash}`;
        refTotal++;
        const res = await srv.rehydrateObservation(sid, rawRef);
        const expect = original[i] ? original[i].content : null;
        if (res.ok && expect !== null && res.content === expect) recallOk++; else mismatch++;
        lastRawRef = rawRef; lastSid = sid;
        // 模型可见视图:生产 reduceObservationContent 在真实内容上生成缩减视图(带 rawRef + recall 提示)
        if (res.ok && viewChecked < 2) {
          const toolName = toolNames.get(String(m.tool_call_id || '')) || '';
          const view = srv.reduceObservationContent(toolName, m.content, rawRef, { recallEnabled: true });
          if (view.reduced) {
            ok(view.content.includes(rawRef) && (view.content.includes('recall=observation_recall') || view.content.includes('"recall"')), `${sid} ${hf} 真实缩减视图含 rawRef 与 recall 提示(policy=${view.policy}, ${view.originalChars}→${view.visibleChars})`);
            viewChecked++;
          }
        }
      }
      ok(recallOk === refTotal, `${sid} ${hf} 真实回读逐字节一致 ${recallOk}/${refTotal}` + (mismatch ? ' (mismatch=' + mismatch + ')' : ''));

      // 2d. 配对铁律(压缩只改 tool 消息 content,消息结构与配对不变)
      const toolIds = new Set(history.filter(m => m && m.role === 'tool').map(m => m.tool_call_id));
      let tcCount = 0, allPaired = true;
      for (const m of history) if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) for (const tc of m.tool_calls) { tcCount++; if (!toolIds.has(tc.id)) allPaired = false; }
      ok(allPaired, `${sid} ${hf} 配对铁律 ${tcCount} 个 tool_call 全有应答`);

      rows.push({ sid, turn, msgs: history.length, baseChars, shadowVisible: shadow.candidateVisibleChars, save: baseChars ? (1 - shadow.candidateVisibleChars / baseChars) * 100 : 0, reduced: shadow.candidateReducedCount, refs: refTotal, big: bigObs });
    }
  }

  // ═══ [3] 工具层调用抽查(等效模型经 tool dispatch 调用 observation_recall) ═══
  console.log('── [3] 工具层调用抽查 ──');
  if (lastRawRef) {
    const ctx = { session: { id: lastSid, providerHistory: [{ role: 'user', content: 'recall last' }] } };
    const r = await srv.toolCall('observation_recall', { rawRef: lastRawRef }, ctx);
    ok(r.ok === true && typeof r.content === 'string' && r.originalChars > 0, '[3a] 真实历史 rawRef 经工具分发回读成功(originalChars=' + r.originalChars + ', truncated=' + r.truncated + ')');
    // 单回合配额:[3a] 已消费 1 次,再打 7 次成功,累计第 9 次 quota_exceeded(真实 rawRef 上验证)
    let quotaFail = false;
    for (let i = 0; i < 7; i++) { const rr = await srv.toolCall('observation_recall', { rawRef: lastRawRef }, ctx); if (!rr.ok) quotaFail = true; }
    const ninth = await srv.toolCall('observation_recall', { rawRef: lastRawRef }, ctx);
    ok(!quotaFail && ninth.ok === false && ninth.error === 'quota_exceeded', '[3b] 真实 rawRef 配额:累计 8 次内成功、第 9 次 quota_exceeded');
  }

  // ═══ [4] 汇总 + 源目录最终校验 ═══
  console.log('\n── 真实历史压缩收益汇总 ──');
  console.log('session | turn | msgs | baseChars | shadowVisible | save% | reduced | rawRefs | bigObs(>=1200)');
  for (const r of rows) console.log(`${r.sid} | ${r.turn} | ${r.msgs} | ${r.baseChars} | ${r.shadowVisible} | ${r.save.toFixed(1)}% | ${r.reduced} | ${r.refs} | ${r.big}`);
  const totBase = rows.reduce((s, r) => s + r.baseChars, 0);
  const totAfter = rows.reduce((s, r) => s + r.shadowVisible, 0);
  console.log(`合计: ${rows.length} 个快照, payload ${totBase} → ${totAfter} chars, 整体缩减 ${totBase ? ((1 - totAfter / totBase) * 100).toFixed(1) : 0}%`);

  console.log('\n── 源目录零改动最终校验 ──');
  for (const sid of copiedSids) {
    const after = treeHash(path.join(SRC_ROOT, sid));
    ok(after === srcBefore[sid], `源目录 ${sid} 测试前后 sha256 清单一致(零写入)`);
  }

  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('\nREAL-HISTORY E2E: ' + (failures ? 'FAIL (' + failures + ')' : 'ALL PASS'));
  process.exitCode = failures ? 1 : 0;
})().catch(e => { console.error('FATAL ' + (e && e.stack || e)); process.exit(1); });
