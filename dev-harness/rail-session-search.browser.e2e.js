#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）
// 浏览器 e2e:左栏会话搜索「搜得全、看得出为什么搜到」。
//   S1 左栏只取最新 200 条会话;一条更早的会话,它的关键词在长对话【中间】—— 搜得到、并且画得出来
//      (修前:索引只收首条 user + 末尾 6 条,中间那句搜不到;就算后端搜到,不在那 200 条里的也画不出来);
//   S2 命中行下挂着摘录,摘录里有查询词;
//   S3 标题含查询词的会话,即使后端内容搜索没把它排进结果,也照样留在左栏(并集,不是只认后端)。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('RAIL SESSION SEARCH BROWSER');
const { ok } = t;

const EARLY_WINDOW = 10;   // 01-config THREAD_INDEX_RECENT_MIN
const EARLY_COUNT = 15;
const earlyId = i => 'sess_early_' + String(i).padStart(3, '0');
function seedEarlySessions(fx) {
  const dir = path.join(fx.home, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < EARLY_COUNT; i++) {
    const sid = earlyId(i);
    const stamp = new Date(Date.UTC(2025, 10, 1, 0, 0, i)).toISOString();
    const head = { schemaVersion: 4, storageVersion: 2, id: sid, missionId: sid, kind: 'quick_ask', title: '较早的线程 ' + i,
      summary: '很久以前聊过', cwd: fx.work, pinned: false, createdAt: stamp, updatedAt: stamp, turnSeq: 1, messageCount: 0, providerHistoryCount: 0, mission: null };
    const file = path.join(dir, sid + '.json');
    fs.writeFileSync(file, JSON.stringify(head), 'utf8');
    fs.writeFileSync(path.join(dir, sid + '.messages.ndjson'), '', 'utf8');
    fs.writeFileSync(path.join(dir, sid + '.provider.ndjson'), '', 'utf8');
    const when = Date.parse(stamp) / 1000;
    fs.utimesSync(file, when, when);
  }
}

(async () => {
  let fx = null;
  try {
    // S8–S13(150 号文 U1／U2)要几条【窗口外】的较早线程:13e 只给 threadVisible 窗口内的会话造卡片,窗口外的切片
    // card:null。开机前把 15 条旧会话直接写进数据根(updatedAt 一年前、mtime 逐条递增),窗口钳到下限 10 ——
    // 最老的 5 条在窗口外。之后建的 207 条都是「今天」的会话,不受窗口影响,S1–S7 的前提不变。
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-rail-search-', config: { threadIndexRecent: EARLY_WINDOW }, beforeServe: seedEarlySessions });
    const create = async title => {
      const r = await fx.request('POST', '/api/sessions', { title, cwd: fx.work });
      return r && r.json && r.json.session ? r.json.session.id : '';
    };
    const oldId = await create('很早以前的一条');
    ok(Boolean(oldId), 'S0 建出那条老会话');
    // 老会话的正文:关键词在第 3 条,后面还有 10 条闲聊(v1 索引只收首条 user 与末尾 6 条)
    const rows = [
      { role: 'user', content: '先帮我看看项目结构' },
      { role: 'assistant', content: '项目分三层。' },
      { role: 'user', content: '下载器要支持断点续传,中断后从已下载的字节接着拉' },
      { role: 'assistant', content: '用 Range 请求头实现了。' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `后续闲聊第 ${i} 条` })),
    ];
    // 先完整读一次老会话:修前新会话的第一次装载会补默认字段并回写(还把 updatedAt 推到现在)。那一次回写要是落在
    // 下面改盘【之后】,老会话就被顶回列表最上面,S1 的前提不成立(Windows CI 上偶发红)。现在装载不再回写,
    // 这一读仍留着:改盘之前把「第一次装载」的一切副作用都了结掉,后面读到的头就是我们写下的那一份。
    const firstRead = await fx.request('GET', `/api/sessions/${oldId}`);
    ok(Boolean(firstRead && firstRead.json && firstRead.json.session && firstRead.json.session.id === oldId), 'S0 改盘前先读一次老会话');
    const sessionsDir = path.join(fx.home, 'sessions');
    const headFile = path.join(sessionsDir, `${oldId}.json`);
    const head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
    fs.writeFileSync(path.join(sessionsDir, `${oldId}.messages.ndjson`), rows.map(m => JSON.stringify({ ...m, createdAt: head.createdAt, turnSeq: 1 })).join('\n') + '\n');
    fs.writeFileSync(headFile, JSON.stringify({ ...head, messageCount: rows.length }, null, 2));
    const fillerIds = [];
    for (let i = 0; i < 205; i++) fillerIds.push(await create(`填充会话 ${i}`));
    const titled = await create('断点续传方案评审');   // S3:标题里就有查询词
    const missing = fillerIds.filter(id => !id).length + (titled ? 0 : 1);
    ok(missing === 0, `S0 206 条填充/标题会话都建出来了(建失败 ${missing} 条)`);
    fs.rmSync(path.join(sessionsDir, 'index.json'), { force: true });   // 让 listSessions 重扫,读到老会话的新 messageCount
    // 前提先在接口上核一遍:老会话在列表里的位置必须在前 200 之外(左栏只取最新 200 条),否则 S1 验不到它要验的东西。
    const listed = await fx.request('GET', '/api/sessions');
    const listedIds = listed && listed.json && Array.isArray(listed.json.sessions) ? listed.json.sessions.map(row => row.id) : [];
    const oldPos = listedIds.indexOf(oldId);
    ok(oldPos >= 200, `S0 前提:GET /api/sessions 里老会话排在前 200 之外(第 ${oldPos} 位,共 ${listedIds.length} 条)`);

    await fx.evaluate('location.reload(), true');
    await sleep(800);
    await fx.waitForEval(`(() => document.querySelectorAll('#railList [data-session-id]').length >= 150 ? 1 : null)()`, 1500);
    const before = await fx.evaluate(`(() => ({
      count: new Set([...document.querySelectorAll('#railList [data-session-id]')].map(n => n.dataset.sessionId)).size,
      hasOld: Boolean(document.querySelector('#railList [data-session-id="${oldId}"]')),
    }))()`);
    ok(before && !before.hasOld, `S1 前提:老会话不在左栏已取到的那一页里(当前 ${before && before.count} 行)`);

    await fx.evaluate(`(() => {
      const original = window.fetch; window.__searchReceipts = [];
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (String(args[0]).includes('/api/sessions/search?')) {
          const json = response.json.bind(response);
          response.json = async () => {
            const value = await json();
            window.__searchReceipts.push({ status: response.status, code: value.code || (value.error && value.error.code) || undefined, partial: value.partial, reason: value.reason, coverage: value.coverage, semantic: value.semantic, count: value.results?.length });
            return value;
          };
        }
        return response;
      };
      const s = document.getElementById('sessionSearch'); s.value = '断点续传'; s.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    const found = await fx.waitForEval(`(() => {
      const row = document.querySelector('#railList [data-session-id="${oldId}"]');
      if (!row) return null;
      const snip = row.querySelector('.rail-search-snippet');
      return { snippet: snip ? snip.textContent : '' };
    })()`, 400);
    console.log('RAIL-DIAG 最近搜索回包 ' + JSON.stringify(await fx.evaluate('window.__searchReceipts.slice(-3)')));
    ok(Boolean(found), 'S1 老会话中间那句搜得到,并且画进了左栏(按 id 补取了它的行)');
    ok(found && /断点续传/.test(found.snippet), `S2 命中行下挂着摘录(${found && found.snippet})`);
    const titledShown = await fx.evaluate(`Boolean(document.querySelector('#railList [data-session-id="${titled}"]'))`);
    ok(titledShown, 'S3 标题含查询词的会话留在左栏');
    const filler = await fx.evaluate(`new Set([...document.querySelectorAll('#railList [data-session-id]')].map(n => n.dataset.sessionId)).size`);
    ok(filler === 2, `S4 搜索时只剩命中的两条会话(${filler} 条)`);
    ok(fx.exceptions.length === 0, `S5 页面无未捕获异常(${JSON.stringify(fx.exceptions.slice(0, 2))})`);
    const { coverageProbe, lastReceipt } = await fx.evaluate(`(() => {
      const node = document.querySelector('#sessionSearchCoverage');
      return {
        coverageProbe: { shown: Boolean(node && !node.hidden && node.getAttribute('role') === 'status'), text: node ? node.textContent : null, hidden: node ? node.hidden : null },
        lastReceipt: window.__searchReceipts.at(-1) || null,
      };
    })()`);
    const coverage = coverageProbe && coverageProbe.shown ? coverageProbe.text : '';
    // 151 阶段 2F:索引建得更快以后,S1 等到命中行时正文索引可能已经建完(最后一发 coverage.complete:true)而语义模型
    // 还在加载;这时说明行按 session-search-state 的互斥规则改说语义状态(「正在加载本地语义模型…」),不再有「已索引
    // x / y」。没建完时照旧要求覆盖率数字;建完且最后一发回包的 semantic.status 是 loading 时,要求状态行逐字是
    // session.semanticLoading 那句(zh-CN 词条);建完且语义不可用(unavailable/timeout/overloaded、无已缓存片段)时要求逐字是
    // session.semanticFallback 那句(与 session-search-state 的 sessionSearchNotices 同一判据);建完的其他情形仍要求数字。
    const indexComplete = !!(lastReceipt && lastReceipt.coverage && lastReceipt.coverage.complete === true);
    const lastSemantic = indexComplete && lastReceipt.semantic ? lastReceipt.semantic : null;
    const zhCopy = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
    const semanticCopy = !lastSemantic ? null
      : lastSemantic.status === 'loading' ? zhCopy['session.semanticLoading']
      : ['unavailable', 'timeout', 'overloaded'].includes(lastSemantic.status) && !lastSemantic.cachedFragments ? zhCopy['session.semanticFallback']
      : null;
    ok(coverage && (semanticCopy ? coverage === semanticCopy : /\d+\D+\d+/.test(coverage)), `S6 左栏显示可访问的索引覆盖率(实 ${JSON.stringify(coverageProbe)},索引已建完 ${indexComplete},语义 ${lastReceipt && lastReceipt.semantic && lastReceipt.semantic.status})`);
    await fx.evaluate(`(() => { const s = document.getElementById('sessionSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    ok(await fx.evaluate(`document.getElementById('sessionSearchCoverage').hidden`), 'S7 清空搜索同步隐藏旧覆盖率');

    // ── S8–S13(150 号文 U1／U2／U11):后端命中 N 条 → 左栏 N 行;之后连发超时空回包也不清空、退避后停在「继续搜索」──
    // 搜索回包由页内桩控制(只桩 /api/sessions/search;/api/missions?sessionIds= 的补取走真服务端):第一发命中全部 15 条
    // 较早线程(其中窗口外的 5 条没有卡片),之后每一发都是 deadline 超时的空回包(带 preparedThisRequest,修前会一直续搜)。
    const earlyIds = Array.from({ length: EARLY_COUNT }, (_, i) => earlyId(i));
    // 主列表要翻完所有页再判(200 多条今天的会话会把较早线程挤到第二页去,只看第一页会把「在第二页」误当成「没卡片」)。
    const pageIds = new Set();
    for (let page = 0, cursor = ''; page < 10; page++) {
      const listed = await fx.request('GET', '/api/missions?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      for (const row of (listed && listed.json && listed.json.missions) || []) pageIds.add(row.sessionId);
      cursor = String((listed && listed.json && listed.json.nextCursor) || '');
      if (!cursor) break;
    }
    const outside = earlyIds.filter(id => !pageIds.has(id));
    ok(outside.length === EARLY_COUNT - EARLY_WINDOW, `S8 前提:窗口外的较早线程不在 /api/missions 主列表里(${outside.length} 条:${outside.join(',')})`);
    const zh = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'locales', 'zh-CN.json'), 'utf8'));
    await fx.evaluate(`(() => {
      const ids = ${JSON.stringify(earlyIds)};
      const inner = window.fetch; window.__u2Calls = 0; window.__u2Mode = 'hit';
      const reply = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      window.fetch = async (...args) => {
        if (!String(args[0]).includes('/api/sessions/search?')) return inner(...args);
        window.__u2Calls += 1;
        const q = new URL(String(args[0]), location.href).searchParams.get('q');
        if (window.__u2Mode === 'semantic-progress') {
          if (++window.__semanticProbeCalls > 1) await new Promise(resolve => { window.__finishSemanticProbe = resolve; });
          return reply({ ok: true, query: q, results: [], coverage: { phase: 'idle', complete: true, sessions: 300, indexedSessions: 300, pendingSessions: 0 },
            semantic: window.__semanticProbe });
        }
        if (window.__u2Mode === 'hit') {
          window.__u2Mode = 'timeout';
          return reply({ ok: true, query: q, results: ids.map(id => ({ id, title: '较早的线程', snippet: '命中的正文 ' + id, score: 1 })), indexed: 10,
            coverage: { phase: 'idle', complete: false, sessions: 300, indexedSessions: 10, pendingSessions: 290 } });
        }
        return reply({ ok: true, query: q, results: [], indexed: null, partial: true, reason: 'deadline',
          coverage: { phase: 'timeout', sessions: null, indexedSessions: null, pendingSessions: null, complete: false, preparedThisRequest: 1 },
          semantic: { status: 'timeout', coverage: 'partial' } });
      };
      const s = document.getElementById('sessionSearch'); s.value = '灰度发布甲乙'; s.dispatchEvent(new Event('input', { bubbles: true })); return true;
    })()`);
    const railIds = `[...new Set([...document.querySelectorAll('#railList li.steward-board-thread[data-session-id]')].map(n => n.dataset.sessionId))]`;
    const drawn = await fx.waitForEval(`(() => { const got = ${railIds}; return got.length >= ${EARLY_COUNT} ? got : null; })()`, 400);
    const drawnIds = drawn || await fx.evaluate(railIds);
    ok(Boolean(drawn) && earlyIds.every(id => drawnIds.includes(id)) && drawnIds.length === EARLY_COUNT,
      `S9 后端命中 ${EARLY_COUNT} 条 → 左栏画 ${EARLY_COUNT} 行(含窗口外 ${outside.length} 条;实画 ${drawnIds.length}:缺 ${earlyIds.filter(id => !drawnIds.includes(id)).join(',') || '无'})`);
    const afterTimeouts = await fx.waitForEval(`(() => window.__u2Calls >= 3 ? { calls: window.__u2Calls, ids: ${railIds}, notice: document.getElementById('sessionSearchCoverage').textContent } : null)()`, 400);
    ok(Boolean(afterTimeouts) && afterTimeouts.ids.length === EARLY_COUNT,
      `S10 连着两发超时空回包之后左栏仍是 ${EARLY_COUNT} 行(修前被空结果覆盖成「没有匹配」;实 ${afterTimeouts && afterTimeouts.ids.length} 行,${afterTimeouts && afterTimeouts.calls} 发)`);
    const stopped = await fx.waitForEval(`(() => { const b = document.getElementById('sessionSearchContinue'); return b && !b.hidden ? { calls: window.__u2Calls, notice: document.getElementById('sessionSearchCoverage').textContent, ids: ${railIds} } : null; })()`, 500);
    await sleep(1500);
    const callsLater = await fx.evaluate('window.__u2Calls');
    ok(Boolean(stopped) && stopped.calls === 6 && callsLater === 6,
      `S11 连续超时退避后停下、露出「继续搜索」:1 发命中 + 5 发超时后不再请求(实 ${stopped && stopped.calls} → ${callsLater} 发;修前每 0.5 s 一发,上限 127)`);
    const pausedText = String(zh['session.searchTimeoutPaused'] || '').replace('{{indexed}}', '10').replace('{{total}}', '300');
    ok(Boolean(stopped) && stopped.notice === pausedText && stopped.ids.length === EARLY_COUNT,
      `S12 停下时说明只有一句「超时已暂停」且结果仍在(实「${stopped && stopped.notice}」,${stopped && stopped.ids.length} 行)`);
    const target = outside[0];
    await fx.evaluate(`(() => { const btn = document.querySelector('#railList li.steward-board-thread[data-session-id="${target}"] .steward-board-thread-title'); if (btn) btn.click(); return Boolean(btn); })()`);
    const opened = await fx.waitForEval(`(() => Boolean(document.querySelector('#railList li.steward-board-thread.is-sel[data-session-id="${target}"]')))()`, 300);
    ok(Boolean(opened), `S13 点窗口外那一行能打开对应线程(${target} 成为选中行)`);
    ok(fx.exceptions.length === 0, `S14 页面无未捕获异常(${JSON.stringify(fx.exceptions.slice(0, 2))})`);

    const semanticProbes = [
      { label: 'S15 模型加载', semantic: { status: 'loading' }, text: zh['session.semanticLoading'] },
      { label: 'S16 语义覆盖进度', semantic: { status: 'partial', coverage: 'partial', cachedFragments: 1, candidateFragments: 3 },
        text: zh['session.semanticPartial'].replace('{{cached}}', '1').replace('{{total}}', '3') },
    ];
    for (const probe of semanticProbes) {
      await fx.evaluate(`(() => {
        window.__u2Mode = 'semantic-progress'; window.__semanticProbeCalls = 0;
        window.__semanticProbe = ${JSON.stringify(probe.semantic)}; window.__finishSemanticProbe = null;
        const s = document.getElementById('sessionSearch'); s.value = '语义进度探针'; s.dispatchEvent(new Event('input', { bubbles: true })); return true;
      })()`);
      const duringFollowUp = await fx.waitForEval(`(() => {
        if (!window.__finishSemanticProbe) return null;
        const notice = document.getElementById('sessionSearchCoverage');
        return { shown: !notice.hidden && notice.getAttribute('role') === 'status', text: notice.textContent };
      })()`, 200);
      ok(duringFollowUp && duringFollowUp.shown && duringFollowUp.text === probe.text,
        `${probe.label}提示在索引完成后的续查期间依然显示（实 ${JSON.stringify(duringFollowUp)}）`);
      await fx.evaluate(`(() => {
        const s = document.getElementById('sessionSearch'); s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
        window.__finishSemanticProbe?.(); return true;
      })()`);
    }
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
})();
