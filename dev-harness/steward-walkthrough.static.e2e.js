#!/usr/bin/env node
'use strict';

// 静态锁（第 117 波 117j · 27 号文 §11.7「用户第二轮走查（2026-09-06，两张截图）」）：
// 用户亲眼看到的五条 W2-1～W2-5 的结构性契约。行为由三件浏览器 e2e 与一处纯函数断言跑出来验，
// 本件只看住「修法本身没有被后来的改动悄悄绕开」。
//
//   A W2-1 管家开了线程就直接展示：只认【已执行】的 actions，不认降级成按钮的 acts。
//   B W2-2 候选列表开合：[hidden] 守卫（根因）、点外面收起、按标题去重。
//   C W2-3 头像跟着话走：搬的是同一个节点、三个销毁点都先 park、头部有 6px 状态点。
//   D W2-4 收件箱回合实时进对话流：走 116-4 的 ?since= 增量，只认 trigger==='inbox'。
//   E W2-5 刷新节拍：三个计时器统一「表按 5s 下限起，真要不要拉由这一拍自己判」。
//
// 判定行：`STEWARD WALKTHROUGH STATIC E2E: ALL PASS`。

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'ruyi-workbench', 'app', 'public');
const read = relative => fs.readFileSync(path.join(PUBLIC, ...relative.split('/')), 'utf8');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

(async () => {
  const html = read('index.html');
  const conversation = read('js/steward-conversation.js');
  const composer = read('js/steward-composer.js');
  const drawer = read('js/steward-drawer.js');
  const board = read('js/steward-board.js');
  const shell = read('js/steward-shell.js');
  const convCss = read('css/views/steward-conversation.css');
  const shellCss = read('css/views/steward-shell.css');
  const convMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-conversation.js')).href);

  /* ── A：W2-1 管家开了线程就直接展示 ─────────────────────────────────────────── */
  {
    const { executedThreadSessionId, STEWARD_THREAD_OPENING_TOOLS } = convMod;
    ok(typeof executedThreadSessionId === 'function'
      && JSON.stringify(STEWARD_THREAD_OPENING_TOOLS) === JSON.stringify(['steward_thread_new', 'steward_quick_ask', 'steward_thread_continue']),
      'A1 三个「开线程」工具是可 Node import 的冻结常量表（不是散落字面量）');
    ok(executedThreadSessionId([{ tool: 'steward_thread_new', result: { ok: true, sessionId: 's1' } }]) === 's1',
      'A2 执行成功的 thread_new 给出 result.sessionId');
    ok(executedThreadSessionId([{ tool: 'steward_thread_continue', args: { sessionId: 's2' }, result: { ok: true } }]) === 's2',
      'A3 result 里没有 sessionId 时回落到 args.sessionId（thread_continue 的形状）');
    ok(executedThreadSessionId([{ tool: 'steward_thread_new', result: { ok: false, error: 'propose_required', sessionId: 's3' } }]) === '',
      'A4 **降级成按钮的不算开出来**（propose_required 是「还没发生」，自动展示会抢在用户判断前面）');
    ok(executedThreadSessionId([{ tool: 'steward_memory_write', result: { ok: true, sessionId: 's4' } }]) === '',
      'A5 不在表里的工具一概不触发展示');
    ok(executedThreadSessionId([
      { tool: 'steward_thread_new', result: { ok: true, sessionId: 'first' } },
      { tool: 'steward_quick_ask', result: { ok: true, sessionId: 'last' } },
    ]) === 'last', 'A6 一回合动了多条时取最后一条（事情发生的顺序）');
    ok(executedThreadSessionId(null) === '' && executedThreadSessionId([]) === '' && executedThreadSessionId([null]) === '',
      'A7 空/畸形输入一律空串，不抛');
    ok(/const opened = executedThreadSessionId\(reply\.actions\);\s*if \(opened\) focusThread\(opened\);/.test(conversation),
      'A8 回合结束就派 steward:focus-thread（宽屏切「现在这一件」，窄屏开抽屉，两者接同一个事件）');
  }

  /* ── B：W2-2 候选列表开合 ───────────────────────────────────────────────────── */
  {
    ok(/\.steward-target-picker\[hidden\] \{ display: none; \}/.test(convCss),
      'B1 **根因守卫**：.steward-target-picker[hidden] 必须显式 display:none —— 同一规则集里那条 display:flex 是作者样式，会压过 UA 表的 [hidden]');
    // 同款守卫在本仓已有四处先例，一并看住，防止将来某一处被删掉。
    for (const [file, selector] of [
      ['css/views/steward-drawer.css', '.steward-drawer[hidden]'],
      ['css/views/steward-drawer.css', '.steward-chip-menu[hidden]'],
      ['css/views/steward-settings.css', '.steward-shield-menu[hidden]'],
      ['css/views/steward-board.css', '.steward-now[hidden]'],
    ]) ok(read(file).includes(selector + ' { display: none; }'), `B1b 既有同款守卫仍在：${selector}`);
    ok(/if \(open\.contains && node && open\.contains\(node\)\) return;/.test(composer)
      && /if \(chip && chip\.contains && node && chip\.contains\(node\)\) return;/.test(composer),
      'B2 点列表外任意处收起（列表与 chip 自身的点击交给各自的处理器）');
    ok(/if \(!open \|\| open\.hidden\) return;/.test(composer),
      'B2b 那个 document 级监听只在列表真开着时才做事（关着时零成本）');
    ok(/closePicker\(\);\s*\}, true\);/.test(composer),
      'B2c **捕获阶段**注册：撤回后的「换一条」是在别的按钮的 click 处理器里 openPicker 的，冒泡阶段会把它刚开就关掉');
    ok(/const titles = new Set\(\);/.test(composer) && /if \(title && titles\.has\(title\)\) \{ seen\.add\(row\.sessionId\); return; \}/.test(composer),
      'B3 候选按标题去重（同一件事开过好几条线程时，列表里不会出现三四行一样的字）');
    ok(/if \(event\.key === 'Escape'\) \{ closePicker\(\); return; \}/.test(composer),
      'B4 Esc 收起');
    ok(/cancelPreroute\(\);\s*closePicker\(\);/.test(composer), 'B5 发送前先收起');
  }

  /* ── C：W2-3 头像跟着话走 ───────────────────────────────────────────────────── */
  {
    ok(/function parkAvatar\(\) \{[\s\S]{0,320}header\.insertBefore\(avatar, header\.firstChild\);/.test(conversation),
      'C1 park：把【同一个】头像节点送回头部');
    ok(/function moveAvatarTo\(row\) \{[\s\S]{0,320}slot\.appendChild\(avatar\);/.test(conversation),
      'C2 move：搬的是同一个节点，不复制 SVG（presence 的 data-state/.pulse/.shake 因此原样生效）');
    ok(!/createElement\('svg'\)|cloneNode/.test(conversation),
      'C2b 对话流里零 SVG 复制、零 cloneNode（历史消息的小圆点由 CSS 画）');
    // 三个销毁点：feed 整清、流失败移除那一行、熔断/引擎不支持移除那一行。少一个，头像就会被一起销毁。
    const parkSites = (conversation.match(/parkAvatar\(\);/g) || []).length;
    ok(parkSites === 3, `C3 三个销毁点各 park 一次（实测 ${parkSites}）—— 漏一个头像就跟着那一行没了，之后 presence 再也画不出来`);
    ok(/parkAvatar\(\);[^\n]*\n\s*while \(feed\.firstChild\) feed\.removeChild\(feed\.firstChild\);/.test(conversation),
      'C3b clearFeed 里 park 排在清空之前');
    ok(/if \(kind === 'ruyi'\) row\.appendChild\(el\('span', 'steward-avslot'\)\);/.test(conversation),
      'C4 只有管家的话有槽（用户气泡不留 36px 空位）');
    ok(/\.steward-avslot:empty::before/.test(convCss) && /\.steward-avslot \.steward-avatar \{ width: 36px; height: 36px; \}/.test(convCss),
      'C5 历史消息靠 :empty::before 画静态点；真头像在槽里缩到 36px');
    ok(html.includes('id="stewardPresenceDot"') && /\.steward-presence-dot \{/.test(shellCss),
      'C6 头部有那枚 6px 状态点（头像搬走之后它是头部唯一的状态投影）');
    ok(/const dot = byId\('stewardPresenceDot'\);\s*if \(dot\) dot\.dataset\.state = next;/.test(shell),
      'C7 状态点与 avatar 读同一处算出来的 next —— 一处 presence，不另起判据');
    for (const state of ['waiting_you', 'error', 'sleeping']) {
      ok(shellCss.includes(`.steward-presence-dot[data-state="${state}"]`), `C7b 状态点覆盖 ${state}`);
    }
  }

  /* ── D：W2-4 收件箱回合实时进对话流 ─────────────────────────────────────────── */
  {
    ok(/api\('\/api\/sessions\/steward\?since=' \+ encodeURIComponent\(since\)\)/.test(conversation),
      'D1 走 116-4 新加的 ?since= 增量（整份拉一条长会话是几百 KB 的重复载荷）');
    ok(/let lastRenderedAt = '';/.test(conversation)
      && /if \(stampAt && stampAt > lastRenderedAt\) lastRenderedAt = stampAt;/.test(conversation),
      'D2 去重靠 createdAt 水位（ISO 8601 定长 UTC 串，字典序即时间序）');
    ok(/lastRenderedAt = '';   \/\/ 117j W2-4/.test(conversation),
      'D2b 整屏重画时水位归零（clearFeed 之后由 renderHistorySince 重新推上去）');
    ok(/if \(!firstSeen && isStewardMode\(\) && lastReply\.trigger === 'inbox'\) void conversation\.appendSince\(''\);/.test(shell),
      'D3 只认 trigger===\'inbox\'：用户自己发的那一条是 sendToSteward 当场画的，再追加一次就重了');
    ok(/const firstSeen = !lastReplyAt;/.test(shell),
      'D3b 首次轮询跳过（那一条属于进壳之前，enterVisit 已经画过）');
    ok(/appendSince,/.test(conversation),
      'D4 对话流的写口只有 conversation 模块，壳层不碰 feed 的 DOM');
  }

  /* ── E：W2-5 刷新节拍 ───────────────────────────────────────────────────────── */
  {
    // 三个模块统一：表按各自的 5s 下限起，真要不要拉由每一拍自己判。动态换表会多一处 clearInterval
    // 或多一个 start/stop 调用点，撞上 steward-avatar.static C2a 与 steward-drawer.static C1/C3b。
    ok(/pollTimer = setInterval\(pollSlice, STEWARD_DRAWER_POLL_MS_MIN\);/.test(drawer),
      'E1 抽屉的表按 5s 下限起');
    ok(/const due = wasLive \? STEWARD_DRAWER_POLL_MS_MIN : pollIntervalMs\(\);/.test(drawer),
      'E1b 有在跑的回合就每拍都拉，否则仍按 config.stewardPollMs');
    ok(/if \(wasLive && !isLive\(\)\) await loadMissionSlice\(\);/.test(drawer),
      'E1c 回合刚结束（live 真→假）当拍把事项行与快照一并重拉 —— 「已收工」要立刻看见');
    ok(/pollTimer = setInterval\(\(\) => \{ void pollTick\(\); \}, STEWARD_BOARD_POLL_MS_MIN\);/.test(board)
      && /const due = anyThreadRunning\(\) \? STEWARD_BOARD_POLL_MS_MIN : pollIntervalMs\(\);/.test(board),
      'E2 看板同一条节拍纪律');
    ok(/pollTimer = setInterval\(pollStewardTick, STEWARD_POLL_MS_MIN\);/.test(shell)
      && /const due = stewardPollFast\(\) \? STEWARD_POLL_MS_MIN : pollIntervalMs\(\);/.test(shell),
      'E3 壳层状态轮询同一条节拍纪律');
    ok(/Math\.max\(STEWARD_DRAWER_POLL_MS_MIN, raw\)/.test(drawer)
      && /Math\.max\(STEWARD_BOARD_POLL_MS_MIN, raw\)/.test(board)
      && /Math\.max\(STEWARD_POLL_MS_MIN, raw\)/.test(shell),
      'E4 **后端下限一个字没动**：pollIntervalMs 仍是 config.stewardPollMs 按 5000 clamp，5s 只是前端节拍');
    ok(/function settledHead\(\) \{[\s\S]{0,400}if \(!\(Number\(session && session\.turnSeq\) > 0\)\) return '';/.test(drawer),
      'E5 三问的「已收工 · 用时 X」只在真跑过回合时才说（一回合没跑过说「收工」是撒谎）');
    ok(/\(view && view\.head\) \|\| settledHead\(\) \|\| t\('stewardShell\.drawer\.none'\)/.test(drawer),
      'E5b 优先级：真活动 > 已收工 > 暂无（绝不因为「线程在跑」就编一个 thinking）');
  }

  console.log(`\nSTEWARD WALKTHROUGH STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
