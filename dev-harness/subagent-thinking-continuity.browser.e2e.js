#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 真浏览器 e2e:召出子代理后,经典壳里父回合的思考块不被切碎(用户:「召出子 agent 后,会话的思维链似乎会被切得很碎」)。
//
// 真工作台 + 假 provider(reasoning_content 分片)+ 真页面:点发送,父回合先思考、调 orchestrate_agents,子代理跑着的时候父回合
// 还在慢速地写第二段思考,子代理自己的 tool_use / 进度 / 后台节点起头事件穿插在中间。
//   L1 后台 run(background:true,下游节点 n2 在父回合写思考的当口才起):整个回合期间页面上的思考块数从不超过 2
//      (= 父回合两次模型调用各一块),最终恰 2 块、文字是完整的一整段 —— 修前每条子代理 tool_use 都把思考块收口,
//      实测 5 块(44 / 18 / 18 / 18 / 104 字);同时子代理卡片仍照常出现(没有把子代理事件吞掉);
//   L2 同步 orchestrate:同样恰 2 块;
//   S1 刷新后静态重绘落盘的那条回合:同样恰 2 块(落盘形状与实时一致);
//   S2 老会话(修前落盘:同一段思考被不画的后台子代理段夹成 thinking | subagent | thinking):静态重绘并成 1 块,文字完整;
//   S3 对照:被父回合自己的工具隔开的两段思考仍是 2 块(合并只发生在「隔着不画的子代理段」时)。
// 判定行:`SUBAGENT THINKING CONTINUITY BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('SUBAGENT THINKING CONTINUITY BROWSER');
const { ok } = t;
const sleepMs = ms => new Promise(resolve => setTimeout(resolve, ms));
const reasonFrame = text => ({ choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] });
const STEPS = 24;

function providerScript(background) {
  return async ctx => {
    const sys = String((ctx.messages.find(m => m.role === 'system') || {}).content || '');
    const tools = ctx.messages.filter(m => m.role === 'tool');
    if (sys.includes('你是子任务执行体')) {
      const isA = JSON.stringify(ctx.messages).includes('NODE_A');
      if (tools.length >= (isA ? 3 : 1)) { ctx.text('sub done'); ctx.stop(); return; }
      await sleepMs(isA ? 500 : 200);
      ctx.toolCall('file_read', { path: 'a.txt', offset: tools.length }, `sub_${isA ? 'a' : 'b'}_${tools.length}`); ctx.stop();
      return;
    }
    if (!tools.length) {
      for (const piece of ['Plan: ', 'I should delegate. ', 'Spawning agents now.']) ctx.sse(reasonFrame(piece));
      const nodes = background
        ? [{ id: 'n1', task: 'NODE_A read stuff', toolTier: 'read' }, { id: 'n2', task: 'NODE_B read after A', toolTier: 'read', dependsOn: ['n1'] }]
        : [{ id: 'n1', task: 'NODE_A read stuff', toolTier: 'read' }, { id: 'n2', task: 'NODE_B read other', toolTier: 'read' }];
      ctx.toolCall('orchestrate_agents', { background, nodes }, 'call_orch'); ctx.stop();
      return;
    }
    for (let i = 0; i < STEPS; i++) { ctx.sse(reasonFrame(`step${i} `)); await sleepMs(230); }
    ctx.text('final answer'); ctx.stop();
  };
}

// 页面上的思考块(live 壳 / 静态重绘都是 details.thinking;被「过程记录」收起的也算,所以按 textContent 数)。
const PANELS = `(() => ({
  panels: document.querySelectorAll('details.thinking').length,
  lens: [...document.querySelectorAll('details.thinking .think-body')].map(b => b.textContent.length),
  texts: [...document.querySelectorAll('details.thinking .think-body')].map(b => b.textContent),
  cards: document.querySelectorAll('.subagent-card').length,
  streaming: !!(window.state && window.state.streaming),
}))()`;

async function liveRun(fx, label, background) {
  await fx.evaluate(`(() => { const b = document.getElementById('newSessionBtn'); if (b) b.click(); return true; })()`);
  await sleep(400);
  await fx.evaluate(`(() => { const input = document.getElementById('promptInput'); input.value = '请分工:${label}'; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('sendBtn').click(); return true; })()`);
  let peakStreaming = 0, lastStreaming = null, maxCards = 0, sawStreaming = false;
  for (let i = 0; i < 300; i++) {
    const s = await fx.evaluate(PANELS);
    if (s.streaming) { sawStreaming = true; peakStreaming = Math.max(peakStreaming, s.panels); lastStreaming = s; maxCards = Math.max(maxCards, s.cards); }
    else if (sawStreaming && i > 5) break;
    await sleepMs(120);
  }
  ok(sawStreaming, `${label}: 回合真的在流式中被观察到`);
  ok(lastStreaming && lastStreaming.lens.some(n => n >= 100), `${label}: 观察到了第二段思考的流式正文(最后一帧各块字数 ${JSON.stringify(lastStreaming && lastStreaming.lens)})`);
  ok(peakStreaming <= 2, `${label}: 整个回合期间思考块数从不超过 2(峰值 ${peakStreaming};修前后台场景峰值 5)`);
  ok(lastStreaming && lastStreaming.panels === 2, `${label}: 流式末帧恰 2 块思考(实得 ${lastStreaming && lastStreaming.panels},字数 ${JSON.stringify(lastStreaming && lastStreaming.lens)})`);
  ok(maxCards >= 2, `${label}: 子代理卡片照常出现(没有被吞掉;最多 ${maxCards} 张)`);
  await sleep(1200);
  const settled = await fx.evaluate(PANELS);
  ok(settled.panels === 2 && settled.texts[1] && settled.texts[1].startsWith('step0 ') && settled.texts[1].includes(`step${STEPS - 1}`), `${label}: 回合收尾后仍恰 2 块,第二块是完整的 step0…step${STEPS - 1}(实得 ${JSON.stringify(settled.lens)})`);
}

(async () => {
  let fx = null;
  try {
    let mode = 'background';
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-subthink-',
      config: { permissionMode: 'bypass', stewardEnabledV1: false, subagentMaxPerTurn: 8, subagentMaxConcurrent: 4, agentAutoWake: false },   // 关掉自动唤醒:后台 run 的完成信封不另起一个回合(本件只看一个回合的思考块)
      provider: async ctx => providerScript(mode === 'background')(ctx),
      prepare: async f => {
        fs.writeFileSync(path.join(f.work, 'a.txt'), 'hello', 'utf8');
        // 老会话:修前落盘的形状 —— 同一段思考被不画的后台子代理段夹成两段;另一条对照:被父回合自己的工具隔开。
        const created = await f.request('POST', '/api/sessions', { title: '老会话', cwd: f.work });
        const sid = created && created.json && created.json.session ? created.json.session.id : '';
        ok(Boolean(sid), 'S0 建出老会话');
        await f.request('GET', `/api/sessions/${sid}`);
        const rows = [
          { role: 'user', content: '旧:后台代理' },
          { role: 'assistant', content: '好了', turnSeq: 1, thinking: 'AAAA|BBBB', segments: [
            { id: 'segment-1', type: 'thinking', text: 'AAAA|' },
            { id: 'segment-2', type: 'subagent', toolCallId: 'sub_old_1', status: 'background', background: true },
            { id: 'segment-3', type: 'thinking', text: 'BBBB' },
            { id: 'segment-4', type: 'text', text: '好了' },
          ] },
          { role: 'user', content: '对照:有工具' },
          { role: 'assistant', content: '好了', turnSeq: 2, thinking: 'CCCC|DDDD',
            toolCalls: [{ id: 'tc1', name: 'file_read', input: { path: 'a.txt' }, result: { ok: true } }],
            segments: [
              { id: 'segment-1', type: 'thinking', text: 'CCCC|' },
              { id: 'segment-2', type: 'tool', toolCallId: 'tc1', name: 'file_read', batchId: 'b1', status: 'done' },
              { id: 'segment-3', type: 'thinking', text: 'DDDD' },
              { id: 'segment-4', type: 'text', text: '好了' },
            ] },
        ];
        const dir = path.join(f.home, 'sessions');
        const headFile = path.join(dir, `${sid}.json`);
        const head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
        fs.writeFileSync(path.join(dir, `${sid}.messages.ndjson`), rows.map(m => JSON.stringify({ ...m, createdAt: head.createdAt })).join('\n') + '\n');
        fs.writeFileSync(headFile, JSON.stringify({ ...head, messageCount: rows.length, turnSeq: 2 }, null, 2));
        fs.rmSync(path.join(dir, 'index.json'), { force: true });
        f.legacySessionId = sid;
      },
    });
    await fx.evaluate(`(() => { try { localStorage.setItem('wcw.shellMode', 'classic'); } catch (e) {} location.reload(); return true; })()`);
    await sleep(800);
    await fx.waitForEval(`(window.state && window.state.currentSession) ? 1 : null`, 300);

    // ── S2 / S3:老会话静态重绘(先做,不占回合) ──
    await fx.evaluate(`(() => { try { localStorage.setItem('wcw.lastSession', ${JSON.stringify(fx.legacySessionId)}); } catch (e) {} location.reload(); return true; })()`);
    await sleep(800);
    const legacy = await fx.waitForEval(`(() => {
      const rows = [...document.querySelectorAll('.message.assistant')];
      if (rows.length < 2) return null;
      return rows.map(r => ({ panels: r.querySelectorAll('details.thinking').length, texts: [...r.querySelectorAll('details.thinking .think-body')].map(b => b.textContent) }));
    })()`, 400);
    ok(Boolean(legacy), 'S2 老会话的两条助手消息都画出来了');
    if (legacy) {
      ok(legacy[0].panels === 1 && legacy[0].texts[0] === 'AAAA|BBBB', `S2 隔着不画的后台子代理段的两段思考并成 1 块(实得 ${legacy[0].panels} 块 ${JSON.stringify(legacy[0].texts)})`);
      ok(legacy[1].panels === 2 && legacy[1].texts[0] === 'CCCC|' && legacy[1].texts[1] === 'DDDD', `S3 对照:被父回合自己的工具隔开的两段思考仍是 2 块(实得 ${legacy[1].panels})`);
    }

    // ── L1:后台 run ──
    mode = 'background';
    await liveRun(fx, 'L1 后台', true);
    // ── S1:刷新后静态重绘这条回合 ──
    await fx.evaluate(`(() => { location.reload(); return true; })()`);
    await sleep(6500);   // 给重放 / 在途气泡一点时间落定(回合已结束)
    const reloaded = await fx.waitForEval(`(() => {
      const rows = [...document.querySelectorAll('.message.assistant')].filter(r => !r.classList.contains('live-turn'));
      const last = rows[rows.length - 1];
      if (!last) return null;
      return { panels: last.querySelectorAll('details.thinking').length, texts: [...last.querySelectorAll('details.thinking .think-body')].map(b => b.textContent), live: document.querySelectorAll('.live-turn').length };
    })()`, 200);
    ok(reloaded && reloaded.panels === 2 && reloaded.texts[1] && reloaded.texts[1].includes('step0 ') && reloaded.texts[1].includes(`step${STEPS - 1}`), `S1 刷新后静态重绘:恰 2 块思考、第二块完整(实得 ${reloaded && reloaded.panels},${JSON.stringify(reloaded && reloaded.texts.map(x => x.length))})`);

    // ── L2:同步 orchestrate ──
    mode = 'sync';
    await liveRun(fx, 'L2 同步', false);
    ok(fx.exceptions.length === 0, `X 页面没有未捕获异常(${fx.exceptions.join(' | ')})`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (fx) await fx.close();
    t.done();
  }
})();
