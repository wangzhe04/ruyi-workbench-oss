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
//   F 第二批（UX-F1/F2/F5、copy-P1-1、classic-1/2、B2、copy-P3-3）：确认闸、文案分支、口径同步。
//   G 第三批（UX-F3/F4、copy-P2-2/3/4/5、copy-P3-1/4、classic-3/4）：Esc 逐层与读屏噪音。
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
      // 117k：用户走查「每次切进管家壳都冒出那张设置小纸」的根因 —— 头像菜单是第六处同款，
      // 建出来就 menu.hidden = true，却一直画在屏幕上盖住问候语（.steward-menu 那条 display:flex
      // 压过 UA 表的 [hidden]）。补上守卫并在这里钉住。
      ['css/views/steward-conversation.css', '.steward-menu[hidden]'],
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

  /* ── F：117j 第二批（其余 P1 + 顺手的 P3-3）───────────────────────────────────── */
  {
    const app = read('app.js');
    const providerSettings = read('js/provider-settings.js');
    const chipsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-chips.js')).href);
    const { permissionSwitchNeedsConfirm, permissionConfirmText } = chipsMod;

    // classic-1：切「全自动」一律先确认 —— 修前专家模式下一声不吭就生效了。
    ok(permissionSwitchNeedsConfirm('auto', 'pro') === true && permissionSwitchNeedsConfirm('auto', 'simple') === true,
      'F1 全自动在【两种界面模式】下都要确认（修前专家模式无门）');
    ok(permissionSwitchNeedsConfirm('bypass', 'simple') === true && permissionSwitchNeedsConfirm('bypass', 'pro') === false,
      'F1b bypass 沿用 v0.9-S1 那道闸：只在精简界面问');
    ok(permissionSwitchNeedsConfirm('default', 'simple') === false && permissionSwitchNeedsConfirm('acceptEdits', 'pro') === false,
      'F1c 收紧与常规档不问（确认闸只对「放宽」用）');
    ok(permissionConfirmText('auto', key => key).split('\n').length === 1 + chipsMod.STEWARD_CONFIRM_KEYS.length,
      'F1d 全自动的确认文案 = 一句提问 + §8.6 的五条人话（与管家壳盾牌菜单逐字同源）');
    ok(/permissionSwitchNeedsConfirm\(e\.target\.value, document\.documentElement\.getAttribute\('data-ui-mode'\)\)/.test(app)
      && /confirm\(permissionConfirmText\(e\.target\.value, t\)\)/.test(app),
      'F1e 经典壳顶栏那一路读的就是这个单点（不再自己拼 confirm key）');
    ok(app.trimEnd().split(/\r?\n/).length <= 1277,
      `F1f 组合根没有因为本片长胖（117j 纪律「app.js 不增行」；实测 ${app.trimEnd().split(/\r?\n/).length} 行）`);

    // B2：权限口径同步 —— 顶栏那枚安全 chip 的刷新落在【唯一写口】里。
    ok(/if \(patch && Object\.prototype\.hasOwnProperty\.call\(patch, 'permissionMode'\)\) renderPermChip\(\);/.test(providerSettings),
      'F2 B2：任何一处写 permissionMode 都会刷新顶栏 chip（放在 saveConfigPartial 里 = 谁写都刷）');

    // UX-F2：引擎问题分两种人话，后端给了 message 就原文照登。
    ok(/const message = String\(\(info && info\.message\) \|\| ''\)\.trim\(\);\s*if \(message\) return message;/.test(conversation),
      'F3 UX-F2：后端的 message 原文照登（它比前端更知道是哪一种）');
    ok(/t\('stewardShell\.chat\.engineNotListed', \{ provider: configured \}\)/.test(conversation)
      && /: t\('stewardShell\.chat\.engineUnsupported'\)/.test(conversation),
      'F3b 没有 message 时按「管家端点配了却不在列表里」二选一');
    for (const loc of ['zh-CN', 'en-US']) {
      const cat = JSON.parse(read('locales/' + loc + '.json'));
      ok(typeof cat['stewardShell.chat.engineNotListed'] === 'string' && cat['stewardShell.chat.engineNotListed'].length > 0,
        `F3c ${loc} 有 engineNotListed`);
    }
    ok(/use\.classList\.add\(STEWARD_PRIMARY_CLASS\);/.test(conversation),
      'F3d copy-P3-3：主动作（真能解决问题的那一个）用统一的金色主按钮类');

    // copy-P1-1：※ 里不再漏工具 id。
    ok(/import \{ STEWARD_TOOL_LABEL_KEYS \} from '\.\/steward-settings\.js';/.test(conversation),
      'F4 工具人话表前端只有一份（从行动流水那边复用，不抄第二份）');
    ok(/function toolLabelOf\(row\) \{[\s\S]{0,320}return key \? String\(t\(key\)\) : String\(\(row && row\.tool\) \|\| ''\);/.test(conversation),
      'F4b 三级回落：后端标签 > 前端 i18n 表 > 工具 id（前两道都落空才用 id，那是诚实兜底）');
    ok(/tool: toolLabelOf\(row\),/.test(conversation),
      'F4c ※ 浮层那一行读的就是它');

    // UX-F5：回执说线程名，不说按钮全文。
    ok(/stewardShortTitle\(act\.sessionTitle \|\| act\.label \|\| act\.sessionId\)/.test(conversation),
      'F5 UX-F5：open_thread 回执优先读 sessionTitle —— 否则会出「打开了「打开「X」」」');
    ok((conversation.match(/sessionTitle: String\(/g) || []).length === 2,
      'F5b 构造 open_thread act 的两处（renderDigest / renderPending）都带上了线程名');
  }

  /* ── G：117j 第三批（P2/P3 + classic-3/4）───────────────────────────────────── */
  {
    const chips = read('js/steward-chips.js');
    const settings = read('js/steward-settings.js');
    const classicWindow = read('js/steward-classic-window.js');
    const chipsMod = await import(pathToFileURL(path.join(PUBLIC, 'js', 'steward-chips.js')).href);
    const { stewardEscapeStack } = chipsMod;

    // UX-F3/F4：Esc 逐层。栈是纯内存的，可以直接在 Node 里跑真值表。
    ok(typeof stewardEscapeStack === 'object' && typeof stewardEscapeStack.push === 'function',
      'G1 Esc 栈是可 Node import 的共享原语（住零 import 的叶子模块，四个子域直接 import）');
    {
      const order = [];
      const releaseA = stewardEscapeStack.push(() => { order.push('a'); return true; });
      const releaseB = stewardEscapeStack.push(() => { order.push('b'); return true; });
      ok(stewardEscapeStack.handleEscape() === true && order.join(',') === 'b',
        `G1b 栈顶先关（后 push 的先响应；实测 ${JSON.stringify(order)}）`);
      releaseB();
      order.length = 0;
      ok(stewardEscapeStack.handleEscape() === true && order.join(',') === 'a',
        'G1c 注销之后轮到下一层');
      releaseA();
      const closedNothing = stewardEscapeStack.push(() => false);
      const real = stewardEscapeStack.push(() => { order.push('real'); return true; });
      order.length = 0;
      ok(stewardEscapeStack.handleEscape() === true && order.join(',') === 'real',
        'G1d 返回 false 的层表示「我没开着」，继续往下问');
      real(); closedNothing();
      const boom = stewardEscapeStack.push(() => { throw new Error('boom'); });
      ok(stewardEscapeStack.handleEscape() === false,
        'G1e 一个抛错的层不会把 Esc 整条吃掉（当它没关掉，继续往下）');
      boom();
      ok(stewardEscapeStack.size() === 0, 'G1f 用例自己清干净了（栈是模块级共享状态）');
    }
    ok(/if \(event\.key !== 'Escape' \|\| !isStewardMode\(\)\) return;\s*if \(stewardEscapeStack\.handleEscape\(\)\) event\.stopPropagation\(\);/.test(shell),
      'G2 唯一那处 keydown 住 steward-shell.js；栈里没东西就不拦，抽屉/看板自己那两路照常收到');
    ok(shell.indexOf("addEventListener('keydown'") < shell.indexOf('composer.bindStewardComposer()'),
      'G2b 它【注册在抽屉/看板之前】—— 同型监听按注册顺序触发，这就是「栈顶先关」成立的原因');
    for (const [name, source] of [['chip 菜单', chips], ['盾牌菜单', settings], ['※ 浮层与头像菜单', conversation], ['候选列表', composer]]) {
      ok(/stewardEscapeStack\.push\(/.test(source), `G3 ${name} 进 Esc 栈`);
    }
    ok((conversation.match(/stewardEscapeStack\.push\(/g) || []).length === 2,
      'G3b ※ 浮层与头像菜单各一处（两个都要，不是只挂一个）');
    for (const [name, source, needle] of [
      ['chip', chips, 'owner.button.focus()'],
      ['盾牌', settings, 'btn.focus()'],
      ['头像', conversation, 'avatar.focus()'],
      ['※', conversation, 'trigger.focus()'],
    ]) ok(source.includes(needle), `G4 copy-P2-4/5：${name} 关掉时把焦点还回触发它的控件`);
    ok(/avatar\.setAttribute\('aria-controls', menu\.id\)/.test(conversation)
      && /btn\.setAttribute\('aria-controls', 'stewardShieldMenu'\)/.test(settings)
      && /chip\.setAttribute\('aria-controls', 'stewardTargetPicker'\)/.test(composer),
      'G4b 三处浮层都有 aria-controls（读屏要知道这颗按钮控制的是哪一块）');

    // copy-P2-2：倒计时不在 aria-live 区刷屏。
    ok(/face\.setAttribute\('aria-hidden', 'true'\);/.test(conversation)
      && /btn\.setAttribute\('aria-label', t\('stewardShell\.chat\.undo'\)\);/.test(conversation)
      && !/btn\.textContent = t\('stewardShell\.chat\.undoCountdown'/.test(conversation),
      'G5 copy-P2-2：数字进 aria-hidden 的 span，按钮 aria-label 固定「撤回」（feed 是 aria-live 区，每秒改一次文本读屏会一路念下去）');

    // copy-P2-3：presence 文案没变就不重写。
    ok(/if \(text && text\.textContent !== label\) text\.textContent = label;/.test(shell),
      'G6 copy-P2-3：presence 文案先比再写（它也在 aria-live 区，赋同样的值也会被念一遍）');

    // copy-P3-1 / P3-4。
    ok(/others\.join\(t\('stewardShell\.chat\.listSeparator'\)\)/.test(conversation),
      'G7 copy-P3-1：列表分隔符走 i18n（中文「、」/ 英文「, 」）');
    for (const loc of ['zh-CN', 'en-US']) {
      const cat = JSON.parse(read('locales/' + loc + '.json'));
      ok(typeof cat['stewardShell.chat.listSeparator'] === 'string', `G7b ${loc} 有 listSeparator`);
    }
    ok(/const keys = \{ ArrowLeft: -1, ArrowRight: 1 \};/.test(drawer) && /event\.key === 'Home'/.test(drawer) && /event\.key === 'End'/.test(drawer),
      'G8 copy-P3-4：抽屉页签支持 ←/→ 与 Home/End（它已经是正经 tablist，此前只能一个个 Tab 过去）');

    // classic-3 / classic-4。
    ok(/if \(document_\.documentElement\.getAttribute\('data-shell-mode'\) !== 'classic'\) clearMark\(\);/.test(classicWindow),
      'G9 classic-3：离开经典壳的【任何一条路】都清返回标记（修前只认「切回管家」，切到预览壳时标记会留下）');
    ok(/if \(visit\.newVisit !== true\) \{\s*try \{ history = await api\('\/api\/sessions\/steward'\); \}/.test(conversation),
      'G10 classic-4：新到访不去拉那条还没落盘的管家会话（那一发必然 404，而 newVisit 分支压根不用 messages）');
  }

  console.log(`\nSTEWARD WALKTHROUGH STATIC E2E: ${fail ? `FAIL (${fail})` : 'ALL PASS'}`);
  process.exitCode = fail ? 1 : 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
