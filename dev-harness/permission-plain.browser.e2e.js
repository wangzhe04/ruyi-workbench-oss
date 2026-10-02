#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离（见 lib 头注）

// 真实浏览器 E2E：权限弹窗说人话、而且马上弹（体验走查 #5 / #12，外加 #4 的默认值）。
//
// 走查原话：
//   #5 发出请求后 0.5 s 进入待决，但屏幕上没有「允许／拒绝」—— 实测是「2.5 s 内按过键＝正在打字」这道闸：
//      回车刚把话发出去，框已经空了，弹窗还要白等 2.5 s；
//   #12 弹窗正文是「file_write」＋整段 JSON 参数（右侧被截断）—— 给程序员看的；
//   #4 刷新／关窗 = 回合中止、待决的权限被自动拒绝：新装的 killOnDisconnect 缺省改成 false。
//
// 覆盖：
//   P1 从工作台输入框发出一句话、回合来要写文件的权限 → 弹窗出来了（快不快由 unit prompt-queue ⑩ 确定性地钉）；
//   P2 正文第一句是人话「写入文件「report.md」（3 行）」；
//   P3 要写的内容给了预览；
//   P4 原始工具名与 JSON 收在「技术详情」里、默认收起；
//   P5 收起的技术详情之外，看不到 file_write 这种标识；
//   P6 点「允许」→ 文件真的写出来；
//   P7 新装的 config.killOnDisconnect 是 false；
//   P8/P9 普通模式下上下文计量与线程头下那一行也说人话（走查 #12 的另两处）；
//   P10/P10a 「本次线程自动允许」只给改文件档，执行档不给；P11 申请已经不在等待 → 弹窗如实说明再关；
//   U5/U7 写工作文件夹外面：不弹权限窗，报错说人话、不印配置键名；U8 本轮变更只印文件名。
// 判定行：`PERMISSION PLAIN BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

const os = require('os');
const OUTSIDE_FILE = path.join(os.tmpdir(), 'ruyi-u5-outside-' + process.pid, 'report.md');
let fail = 0;
const ok = (c, l) => { if (c) console.log('PASS ' + l); else { fail++; console.log('FAIL ' + l); } };

(async () => {
  let fx = null;
  let workDir = '';
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-perm-plain-',
      config: { permissionMode: 'default', uiMode: 'simple', killOnDisconnect: undefined },
      provider: async ctx => {
        const lastUser = [...ctx.messages].reverse().find(m => m && m.role === 'user');
        if (/写到外面/.test(String(lastUser && lastUser.content || ''))) {
          const last = ctx.messages[ctx.messages.length - 1];
          if (!last || last.role !== 'tool') { ctx.toolCall('file_write', { path: OUTSIDE_FILE, content: 'x\n' }); return; }
          ctx.text('外面写不了。'); ctx.stop(); return;
        }
        if (/跑个命令/.test(String(lastUser && lastUser.content || ''))) {
          const last = ctx.messages[ctx.messages.length - 1];
          if (!last || last.role !== 'tool') { ctx.toolCall('powershell_run', { command: 'Get-Date' }); return; }
          ctx.text('好了。'); ctx.stop(); return;
        }
        if (!ctx.answered) { ctx.toolCall('file_write', { path: path.join(workDir, 'report.md'), content: '# 周报\n本周完成三件事\n下周计划\n' }); return; }
        ctx.text('写好了。'); ctx.stop();
      },
      prepare: async f => { workDir = f.work; },
    });
    const target = path.join(fx.work, 'report.md');
    // V1/V2 用:事件流每次(重)连的请求 URL —— 流式 fetch 不收尾就进不了 resource timing,只能在网络层看。
    const streamReqs = [];
    fx.cdp.on('Network.requestWillBeSent', p => { const u = String((p && p.request && p.request.url) || ''); if (u.includes('/api/events/stream')) streamReqs.push(u); });
    await fx.cdp.send('Network.enable');
    const killOnDisconnect = await fx.waitForEval(`window.state && window.state.config && 'killOnDisconnect' in window.state.config ? String(window.state.config.killOnDisconnect) : null`, 200);
    ok(killOnDisconnect === 'false', `P7 新装的 killOnDisconnect 缺省是 false（实测 ${killOnDisconnect}）`);

    await fx.evaluate(`(document.querySelector('#lensSeg [data-lens="classic"]') || { click() {} }).click(), true`);
    await fx.waitForEval(`document.documentElement.getAttribute('data-shell-mode') === 'classic' ? 1 : null`);
    await fx.evaluate(`(document.getElementById('newSessionBtn') || { click() {} }).click(), true`);
    await sleep(800);
    // 走查 #12 的另两处：普通模式下上下文计量与线程头下那一行都说人话，数字与整条路径留在悬停提示里。
    const plainBits = await fx.waitForEval(`(() => {
      const meter = document.querySelector('#contextMeter .ctx-text');
      const meta = document.getElementById('sessionMeta');
      if (!meter || !meta || !meta.textContent) return null;
      return { meter: meter.textContent, meterTitle: document.getElementById('contextMeter').title, meta: meta.textContent, metaTitle: meta.title };
    })()`, 100);
    ok(Boolean(plainBits) && plainBits.meter === '对话余量充足' && !/—|\/ \d|未开始/.test(plainBits.meter) && /上限/.test(plainBits.meterTitle),
      `P8 普通模式的上下文计量说人话「对话余量充足」，读数留在悬停提示里（实测 ${JSON.stringify(plainBits && { meter: plainBits.meter })}）`);
    ok(Boolean(plainBits) && /^在「[^」]+」里干活$/.test(plainBits.meta) && plainBits.metaTitle && plainBits.meta.length < plainBits.metaTitle.length + 8 && !/[\\/]/.test(plainBits.meta),
      `P9 线程头下那一行只说文件夹名，整条路径在悬停提示里（实测 ${JSON.stringify(plainBits && { meta: plainBits.meta, title: plainBits.metaTitle })}）`);
    const sentAt = Date.now();
    await fx.evaluate(`(() => {
      const i = document.getElementById('promptInput');
      i.focus(); i.value = '写一份周报'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('sendBtn').click();
      return true;
    })()`);
    const modal = await fx.waitForEval(`(() => {
      const m = document.querySelector('.modal-backdrop.permission-modal');
      if (!m) return null;
      const tech = m.querySelector('details.perm-tech');
      const clone = m.cloneNode(true);
      const techClone = clone.querySelector('details.perm-tech');
      if (techClone) techClone.remove();
      return {
        plain: (m.querySelector('.perm-plain') || {}).textContent || '',
        preview: (m.querySelector('.perm-preview') || {}).textContent || '',
        techOpen: tech ? tech.open : null,
        techText: tech ? tech.textContent : '',
        outside: clone.textContent,
        sessionBox: Boolean(m.querySelector('label.check:not(.perm-persist) input[type=checkbox]')),
      };
    })()`, 200);
    const waited = Date.now() - sentAt;
    // 「多快」的判据是确定性的那一条：unit/prompt-queue.test.js ⑩（框空了就不算在打字）。这里只断「弹出来了」，耗时只打印。
    ok(Boolean(modal), `P1 发出一句话、回合来要权限 → 弹窗出来了（发出后约 ${waited} ms；打字闸的判据见 prompt-queue ⑩）`);
    ok(Boolean(modal) && modal.plain === '写入文件「report.md」（3 行）', `P2 第一句是人话（实测 ${JSON.stringify(modal && modal.plain)}）`);
    ok(Boolean(modal) && modal.preview.includes('本周完成三件事'), 'P3 要写的内容给了预览');
    ok(Boolean(modal) && modal.techOpen === false && modal.techText.includes('file_write') && modal.techText.includes('"path"'),
      `P4 原始工具名与 JSON 收在默认收起的「技术详情」里（实测 open=${modal && modal.techOpen}）`);
    ok(Boolean(modal) && !/file_write/.test(modal.outside), 'P5 技术详情之外看不到 file_write');
    ok(Boolean(modal) && modal.sessionBox === true, 'P10a 改文件档的弹窗给「本次线程自动允许此工具」');
    // 2026-10（用户：「如果用户在看提问、权限，管家被立刻唤醒也不要插手」）：弹窗摆在面前时，事件流按在场信号
    // 重连并带上 viewing=<这条线程>（服务端据此扣住它的待决、管家代批拒绝动手）；收起之后再重连、不再带。
    // 读的是 CDP 网络层看到的事件流重连 URL（上面 streamReqs）。
    const viewingSid = await fx.evaluate(`String((window.state && window.state.currentSession && window.state.currentSession.id) || '')`);
    let viewingUrl = null;
    for (let i = 0; i < 60 && !viewingUrl; i++) { const u = streamReqs[streamReqs.length - 1] || ''; if (viewingSid && u.includes('viewing=' + viewingSid)) viewingUrl = u; else await sleep(100); }
    ok(Boolean(viewingSid) && Boolean(viewingUrl), `V1 权限弹窗摆在面前时，在场信号带上 viewing=当前线程（实测 ${JSON.stringify(viewingUrl)}）`);

    // 走查 #5：按「稍后处理」把弹窗收起 → 对话里那张待决卡就地给「允许／拒绝」，卡头说人话动词、不印 file_write。
    await fx.evaluate(`(() => { const m = document.querySelector('.modal-backdrop.permission-modal'); [...m.querySelectorAll('button')].find(b => /稍后处理/.test(b.textContent || '')).click(); return true; })()`);
    const inline = await fx.waitForEval(`(() => {
      if (document.querySelector('.modal-backdrop.permission-modal:not(.hidden)')) return null;
      const card = document.querySelector('.narrative-permission');
      const actions = card && card.querySelector('.narrative-perm-actions');
      if (!actions) return null;
      return { head: (card.querySelector('.narrative-state-title') || {}).textContent || '', buttons: [...actions.querySelectorAll('button')].map(b => b.textContent) };
    })()`, 100);
    let minimizedUrl = null;
    for (let i = 0; i < 60 && !minimizedUrl; i++) { const u = streamReqs[streamReqs.length - 1] || ''; if (u && !u.includes('viewing=')) minimizedUrl = u; else await sleep(100); }
    ok(Boolean(minimizedUrl), `V2 收进小窗之后在场信号不再带 viewing（管家可以接手；实测 ${JSON.stringify(minimizedUrl)}）`);
    ok(Boolean(inline) && inline.buttons.join('/') === '允许/拒绝' && !/file_write/.test(inline.head),
      `P5b 弹窗收起后，对话里的待决卡就地给「允许／拒绝」、卡头说人话（实测 ${JSON.stringify(inline)}）`);
    await fx.evaluate(`(() => { [...document.querySelectorAll('.narrative-permission .narrative-perm-actions button')].find(b => b.classList.contains('primary')).click(); return true; })()`);
    let written = false;
    for (let i = 0; i < 100 && !written; i++) { written = fs.existsSync(target); if (!written) await sleep(100); }
    ok(written, 'P6 在对话卡上点「允许」→ report.md 真的写出来了');
    const settledCard = await fx.waitForEval(`(() => { const c = document.querySelector('.narrative-permission'); return c && !c.querySelector('.narrative-perm-actions') ? (c.querySelector('.narrative-state-pill') || {}).textContent || 'x' : null; })()`, 100);
    ok(Boolean(settledCard), `P6b 决定之后卡上的按钮收起、改成结果（实测 ${settledCard}）`);
    // 走查 U8：普通模式下「本轮变更」那一行只印文件名，整条路径在悬停提示里。
    const tsPath = await fx.waitForEval(`(() => { const n = document.querySelector('.turn-summary-file .ts-path'); return n ? { text: n.textContent, title: n.title } : null; })()`, 200);
    ok(Boolean(tsPath) && tsPath.text === 'report.md' && tsPath.title === target, `U8 本轮变更只印文件名、整条路径在悬停提示里（实测 ${JSON.stringify(tsPath)}）`);

    // 走查 U5/U7：写工作文件夹外面的文件 —— 不弹权限窗（修前先问「允许写入」，批准后才报越界）；报错说人话、不印配置键名。
    await fx.waitForEval(`document.getElementById('messages') && document.getElementById('messages').textContent.includes('写好了') ? 1 : null`, 100);
    await sleep(800);   // 回合收尾（写盘、状态回到空闲）要一拍；太快发下一句会被当成排队插话
    await fx.evaluate(`(() => {
      window.__permModalSeen = 0;
      new MutationObserver(() => { if (document.querySelector('.modal-backdrop.permission-modal')) window.__permModalSeen += 1; }).observe(document.body, { childList: true, subtree: true });
      const i = document.getElementById('promptInput');
      i.focus(); i.value = '写到外面'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('sendBtn').click();
      return true;
    })()`);
    const outside = await fx.waitForEval(`(() => {
      const m = document.getElementById('messages');
      if (!m || !m.textContent.includes('外面写不了')) return null;
      return { modal: window.__permModalSeen, text: m.textContent };
    })()`, 200);
    if (!outside) console.log('# 诊断 U5', JSON.stringify(await fx.evaluate(`({ modal: window.__permModalSeen, text: (document.getElementById('messages') || {}).textContent.slice(-600) })`)));
    ok(Boolean(outside) && outside.modal === 0 && !fs.existsSync(OUTSIDE_FILE), `U5 写工作文件夹外面：不弹权限窗、文件没写出来（实测 弹窗 ${outside && outside.modal} 次）`);
    ok(Boolean(outside) && /工作文件夹外面/.test(outside.text) && !/allowOutsideWorkspace/.test(outside.text),
      'U7 越界报错说人话、说清去哪儿改，不印配置键名 allowOutsideWorkspace');

    // 代码走查 C3：执行档（命令/脚本）不给「本次线程自动允许」—— 按工具名放行等于之后任何【不同】的命令都静默执行。
    // 代码走查 C9：弹窗等后端回话再关；申请已经不在等待（404）→ 说清楚再关，不假装成功。
    await sleep(500);
    await fx.evaluate(`(() => {
      const i = document.getElementById('promptInput');
      i.focus(); i.value = '跑个命令'; i.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('sendBtn').click();
      return true;
    })()`);
    const execModal = await fx.waitForEval(`(() => {
      const m = document.querySelector('.modal-backdrop.permission-modal');
      if (!m) return null;
      return { sessionBox: Boolean(m.querySelector('label.check:not(.perm-persist) input[type=checkbox]')), persist: Boolean(m.querySelector('.perm-persist')), tier: (m.querySelector('.perm-tier') || {}).className || '' };
    })()`, 200);
    ok(Boolean(execModal) && /exec/.test(execModal.tier) && execModal.sessionBox === false && execModal.persist === false,
      `P10 执行档的弹窗不给「本次线程自动允许」也不给「永久允许」（实测 ${JSON.stringify(execModal)}）`);
    await fx.evaluate(`(() => {
      const orig = window.fetch;
      window.fetch = (url, opts) => String(url).includes('/api/permission/decision')
        ? Promise.resolve(new Response(JSON.stringify({ ok: false, error: 'unknown or expired request' }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
        : orig(url, opts);
      [...document.querySelector('.modal-backdrop.permission-modal').querySelectorAll('button')].find(b => b.classList.contains('primary')).click();
      return true;
    })()`);
    const gone = await fx.waitForEval(`(() => {
      if (document.querySelector('.modal-backdrop.permission-modal')) return null;
      const t = [...document.querySelectorAll('#toastTray .toast')].map(n => n.textContent).find(x => /不在等待/.test(x));
      return t || null;
    })()`, 100);
    ok(Boolean(gone), `P11 申请已经不在等待 → 弹窗关掉并如实说明，不像成功（实测 ${JSON.stringify(gone)}）`);
    ok(fx.exceptions.length === 0, `F1 零未捕获异常（${JSON.stringify(fx.exceptions)}）`);
  } catch (error) {
    fail++;
    console.log('FAIL fatal: ' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close({ keepRoot: fail > 0 });
  }
  console.log('\nPERMISSION PLAIN BROWSER E2E: ' + (fail ? `FAIL (${fail})` : 'ALL PASS'));
  process.exit(fail ? 1 : 0);
})();
