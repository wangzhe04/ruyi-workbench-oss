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

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({ ok, prefix: 'ruyi-rail-search-' });
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

    await fx.evaluate(`(() => { const s = document.getElementById('sessionSearch'); s.value = '断点续传'; s.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    const found = await fx.waitForEval(`(() => {
      const row = document.querySelector('#railList [data-session-id="${oldId}"]');
      if (!row) return null;
      const snip = row.querySelector('.rail-search-snippet');
      return { snippet: snip ? snip.textContent : '' };
    })()`, 400);
    ok(Boolean(found), 'S1 老会话中间那句搜得到,并且画进了左栏(按 id 补取了它的行)');
    ok(found && /断点续传/.test(found.snippet), `S2 命中行下挂着摘录(${found && found.snippet})`);
    const titledShown = await fx.evaluate(`Boolean(document.querySelector('#railList [data-session-id="${titled}"]'))`);
    ok(titledShown, 'S3 标题含查询词的会话留在左栏');
    const filler = await fx.evaluate(`new Set([...document.querySelectorAll('#railList [data-session-id]')].map(n => n.dataset.sessionId)).size`);
    ok(filler === 2, `S4 搜索时只剩命中的两条会话(${filler} 条)`);
    ok(fx.exceptions.length === 0, `S5 页面无未捕获异常(${JSON.stringify(fx.exceptions.slice(0, 2))})`);
  } catch (error) {
    t.fail('fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: t.failures > 0 });
  }
  t.done({ exit: true });
})();
