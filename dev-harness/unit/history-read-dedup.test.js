'use strict';
// 126-111e(25 号文 §1.2 / 44 号文 §4):历史内重复读取去重。真源码、临时存储、零模型请求。
//
// 背景:#2a 的执行结果缓存命中之后**仍然把全文展开写进历史** —— 同一个文件在一条线程里读三次,
// 历史里就躺着三份一模一样的正文。L1 把 boundary 之前的都缩过了,所以这几份全文真正还在占位置的
// 地方是【受保护的尾部】。
//
// 判据分四组:
//   [A] 开关关 —— 零改写(与今天逐字节相同)。
//   [B] 键零误报 —— 同内容同路径才算一份;窗口不同/文件改过/路径不同,一律各留各的。
//   [C] 行为 —— 最新一次留全文,较早几次换成带 tool_call_id 与 rawRef 的指针;幂等。
//   [D] 缓存噪声 —— 缓存命中那一发多带的 `cacheHit:{ageMs}` 每次都不一样,不能因此比不上。
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-read-dedup-'));
process.env.WIN_CLAUDE_WORKBENCH_HOME = root;
const app = path.resolve(__dirname, '../../ruyi-workbench/app');
const srv = require(path.join(app, 'server.js'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

const POINTER = '[重复读取:';
const BODY = 'export function foo() {\n  return 42;\n}\n'.repeat(40);
// 一次 file_read 的工具结果,形状照 12-tool-dispatch 的 `JSON.stringify(result)`。
const readResult = (p, body, extra = {}) => JSON.stringify({ ok: true, path: p, content: body, size: body.length, totalChars: body.length, truncated: false, sourceLineEnding: 'lf', contentLineEnding: 'lf', ...extra });

// 一条 user + N 个「assistant(file_read) + tool 回复」单元 + 收尾 assistant。
function historyOfReads(reads) {
  const h = [{ role: 'user', content: '看看这个文件' }];
  reads.forEach((content, i) => {
    h.push({ role: 'assistant', content: null, tool_calls: [{ id: `r${i}`, type: 'function', function: { name: 'file_read', arguments: '{}' } }] });
    h.push({ role: 'tool', tool_call_id: `r${i}`, content });
  });
  h.push({ role: 'assistant', content: '看完了' });
  return h;
}
const pointers = h => h.filter(m => m.role === 'tool' && String(m.content || '').startsWith(POINTER));
// 判「这条还是全文吗」要【解析回来比正文】,不能拿 BODY 的前缀去 includes:
// content 是 JSON.stringify 过的,正文里的换行在里面是两个字符的 \n —— 第一版就这么错的,
// 五条断言全红而实现其实是对的(C1「换掉两次」与 C6「幂等」当时就是绿的)。
const isFullText = m => { try { return JSON.parse(m.content).content === BODY; } catch { return false; } };
const fullTexts = h => h.filter(m => m.role === 'tool' && isFullText(m));

test('126-111e · 历史内重复读取去重', () => {
  let fail = 0;
  const ok = (cond, label) => { if (cond) console.log('PASS ' + label); else { fail++; console.log('FAIL ' + label); } };

  // ── [A] 开关关 = 零改写 ─────────────────────────────────────────────────────────────
  ok(srv.historyReadDedupEnabled({}) === false, 'A1 缺省不生效');
  ok(srv.historyReadDedupEnabled({ runtimeHistoryReadDedupV1: false }) === false, 'A2 显式 false 不生效');
  ok(srv.historyReadDedupEnabled({ runtimeHistoryReadDedupV1: 'true' }) === false, 'A3 字符串 "true" 不生效(只认 JSON 布尔)');
  ok(srv.historyReadDedupEnabled({ runtimeHistoryReadDedupV1: true }) === true, 'A4 显式 true 生效');
  {
    const a = historyOfReads([readResult('a.js', BODY), readResult('a.js', BODY)]);
    const before = JSON.stringify(a);
    srv.evaporateHistory(a, { config: {}, dedupeReads: false });
    // 注意:老边界仍会蒸发 boundary 之前的 tool —— 这里只比「去重有没有插手」。
    ok(!JSON.stringify(a).includes(POINTER), 'A5 开关关时历史里一个指针都没有');
    const b = historyOfReads([readResult('a.js', BODY), readResult('a.js', BODY)]);
    srv.evaporateHistory(b);
    ok(JSON.stringify(a) === JSON.stringify(b), 'A6 开关关与不带 opts 的结果逐字节相同');
    ok(JSON.parse(historyOfReads([readResult('a.js', BODY)])[2].content).content === BODY, 'A6b 夹具自检:起点里确实有全文');
  }

  // ── [B] 键零误报 ───────────────────────────────────────────────────────────────────
  {
    const k = srv.fileReadDedupKey;
    ok(k(readResult('a.js', BODY)) === k(readResult('a.js', BODY)), 'B1 同路径同正文 -> 同一把键');
    ok(k(readResult('a.js', BODY)) !== k(readResult('b.js', BODY)), 'B2 路径不同 -> 不同键');
    ok(k(readResult('a.js', BODY)) !== k(readResult('a.js', BODY + '// 改了一行\n')),
      'B3 **文件改过之后再读 -> 不同键**（「我的改动生效了吗」这种对照不会被吃掉）');
    ok(k(readResult('a.js', BODY.slice(0, 200))) !== k(readResult('a.js', BODY.slice(200, 400))),
      'B4 读的窗口不同 -> 不同键（第 1 段 vs 第 2 段各留各的）');
    ok(k(JSON.stringify({ ok: false, error: '文件不存在', path: 'a.js' })) === '', 'B5 失败结果不参与去重');
    ok(k(JSON.stringify({ ok: true, path: 'a.js' })) === '', 'B6 没有正文的结果不参与去重');
    ok(k('不是 JSON') === '' && k('') === '' && k(null) === '', 'B7 非 JSON / 空 / null 一律不参与');
    ok(k(readResult('a.js', BODY, { truncated: true })) === k(readResult('a.js', BODY)),
      'B8 只看路径与正文 —— 结果对象上别的字段不影响键');
  }

  // ── [C] 行为:最新一次留全文,较早换指针;幂等 ───────────────────────────────────────
  {
    const h = historyOfReads([readResult('a.js', BODY), readResult('a.js', BODY), readResult('a.js', BODY)]);
    const toolNames = new Map([['r0', 'file_read'], ['r1', 'file_read'], ['r2', 'file_read']]);
    const n = srv.dedupeRepeatedReads(h, 0, toolNames, 'history:7:aaaaaaaaaaaaaaaa');
    ok(n === 2, `C1 三次相同读取换掉两次(实得 ${n})`);
    ok(pointers(h).length === 2 && fullTexts(h).length === 1, `C2 只剩一份全文(指针 ${pointers(h).length}/全文 ${fullTexts(h).length})`);
    const last = h.filter(m => m.role === 'tool').at(-1);
    ok(isFullText(last), 'C3 留下全文的是【最新】那一次,不是最早那次');
    const first = h.filter(m => m.role === 'tool')[0];
    ok(String(first.content).includes('tool_call_id=r2'), `C4 指针点名了后文那一条(实得 ${String(first.content).slice(0, 80)})`);
    ok(/rawRef=history:7:aaaaaaaaaaaaaaaa:\d+:[0-9a-f]{16}/.test(String(first.content)), 'C5 指针带 rawRef,原件回查得到');
    const second = srv.dedupeRepeatedReads(h, 0, toolNames, 'history:7:aaaaaaaaaaaaaaaa');
    ok(second === 0, `C6 幂等:第二遍零改写(实得 ${second})`);
  }
  {
    // 只认 file_read:别的工具即便结果长得像,也不去重。
    const h = historyOfReads([readResult('a.js', BODY), readResult('a.js', BODY)]);
    const notRead = new Map([['r0', 'web_fetch'], ['r1', 'web_fetch']]);
    ok(srv.dedupeRepeatedReads(h, 0, notRead, '') === 0, 'C7 非 file_read 的观测不去重');
  }
  {
    // from 之前的不碰(那一段归 L1 蒸发管)。
    const h = historyOfReads([readResult('a.js', BODY), readResult('a.js', BODY), readResult('a.js', BODY)]);
    const toolNames = new Map([['r0', 'file_read'], ['r1', 'file_read'], ['r2', 'file_read']]);
    const tailStart = h.findIndex(m => m.tool_call_id === 'r1') - 1; // 从第二个单元起
    const n = srv.dedupeRepeatedReads(h, tailStart, toolNames, '');
    ok(n === 1, `C8 只在 from 之后去重(实得 ${n};第一次读没被碰)`);
    ok(isFullText(h.filter(m => m.role === 'tool')[0]), 'C9 from 之前那一次仍是全文');
  }

  // ── [D] 缓存噪声不能把键搅乱 ───────────────────────────────────────────────────────
  {
    // #2a 命中缓存那一发会多带 cacheHit:{cachedAt, ageMs} —— ageMs 每次都不一样。
    // 拿整条 content 做哈希就永远比不上;本实现只哈希正文,所以照样认得出来。
    const cold = readResult('a.js', BODY);
    const warm = readResult('a.js', BODY, { cacheHit: { cachedAt: '2026-09-15T10:00:00.000Z', ageMs: 8123 } });
    ok(cold !== warm, 'D1 夹具自检:两条 content 确实不同(缓存命中多带了 cacheHit)');
    ok(srv.fileReadDedupKey(cold) === srv.fileReadDedupKey(warm), 'D2 但键相同 —— 缓存噪声没把去重搅坏');
    const h = historyOfReads([cold, warm]);
    const toolNames = new Map([['r0', 'file_read'], ['r1', 'file_read']]);
    ok(srv.dedupeRepeatedReads(h, 0, toolNames, '') === 1, 'D3 冷读＋缓存命中读 -> 换掉一次');
  }

  // ── [E] 端到端:走 evaporateHistory 这一口 ──────────────────────────────────────────
  {
    const h = historyOfReads([readResult('a.js', BODY), readResult('a.js', BODY), readResult('a.js', BODY)]);
    const n = srv.evaporateHistory(h, { config: { runtimeHistoryReadDedupV1: true }, dedupeReads: true });
    ok(n >= 1, `E1 evaporateHistory 把去重算进「缩了几条」(实得 ${n})`);
    ok(fullTexts(h).length === 1, `E2 全历史只剩一份全文(实得 ${fullTexts(h).length})`);
    const callIds = h.filter(m => m.role === 'assistant' && Array.isArray(m.tool_calls)).flatMap(m => m.tool_calls.map(c => c.id));
    const replyIds = new Set(h.filter(m => m.role === 'tool').map(m => m.tool_call_id));
    ok(callIds.every(id => replyIds.has(id)), 'E3 配对零孤儿(去重只改 content,不删消息)');
    ok(h.length === historyOfReads([1, 2, 3].map(() => readResult('a.js', BODY))).length, 'E4 长度不变');
  }

  console.log('\nHISTORY READ DEDUP UNIT: ' + (fail ? `${fail} FAILURE(S)` : 'ALL PASS'));
  assert.equal(fail, 0, `${fail} 条判据未通过`);
});
