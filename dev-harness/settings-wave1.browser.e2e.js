#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 前端走查第 1 波(设置面)的真浏览器回归件。每一条都读服务端落盘值(GET /api/status 或 config.json),不信界面自己说的：
//   W1  手动模型清单逐字输入:敲到一半不改 p.model、不把半截名字写进 hiddenModels;失焦(change)才补默认模型/算「已移除」
//   W2  设置目录(~20 段)与「提醒」状态行跟着界面语言走(运行时 zh-CN → en-US → zh-CN)
//   W3  服务端 {ok:false,error:'字符串'} 被信封成 {code,params,message} 后,界面取 message,不印 [object Object]
//   W4  管家数字框清空 → 不写盘、框里回显落盘值(清空曾写 0:费用闸为 0 = 关闭)
//   W5  「Agent 角色」页未保存的编辑:切页签再回来不丢;切范围先确认;保存不把未动过的内置角色固化进 agentRoleOverrides
//   W6  设置页「添加工作区 / 默认工作文件夹」手填相对路径 → toast + 回填落盘值(与顶栏同判据)
//   W7  「测试连接」成功后的绿字不被整张重画擦掉
//   W8  服务商卡空 Base URL:保存被拦并点名该服务商,测试给本地化提示
//   W9  向导:云端「自定义」预设空模型不能存;文案不再说「由预设带出」
//   W10 向导第一步切语言,标题与关闭钮 aria-label 跟着换
//   W11 语音识别「模型名」是文本框 + datalist,清单为空也能手填添加
//   W13 已完成的用户重开向导再关,completedAt 不被覆盖成 null
//   W14 定时任务「建这一条」双击只发一次请求
//   W15 改月度预算后用量面板重拉(不再显示旧预算)
//   W16 最大轮次填 abc 不写盘;管家步「另挑一个」点后有选中态
// 判定行:`SETTINGS WAVE1 BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('SETTINGS WAVE1 BROWSER');
const { ok } = t;
const LOCALES = path.join(__dirname, '..', 'ruyi-workbench', 'app', 'public', 'locales');
const ZH = JSON.parse(fs.readFileSync(path.join(LOCALES, 'zh-CN.json'), 'utf8'));
const EN = JSON.parse(fs.readFileSync(path.join(LOCALES, 'en-US.json'), 'utf8'));
const fill = (text, params) => String(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => (params && params[k] != null ? params[k] : ''));

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok,
      prefix: 'ruyi-settings-wave1-',
      width: 1440,
      height: 900,
      config: {
        uiMode: 'pro',
        usageBudget: { monthly: 50, currency: 'CNY' },
        stewardMaxCostPerDay: 3,
        stewardGlobalMaxCostPerDay: 9,
        stewardMaxTurnsPerHour: 17,
        maxTurns: '',
      },
    });
    const ev = expr => fx.evaluate(expr);
    const disk = () => JSON.parse(fs.readFileSync(path.join(fx.home, 'config.json'), 'utf8'));
    const status = async () => { const r = await fx.request('GET', '/api/status'); return (r && r.json && r.json.config) || {}; };
    const waitConfig = async pred => {
      for (let i = 0; i < 100; i++) {
        const c = await status();
        try { if (pred(c)) return c; } catch { /* 还没到 */ }
        await sleep(80);
      }
      return null;
    };
    const switchTab = async stab => {
      await ev(`(() => { document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(g => g.classList.add('is-open')); const b = document.querySelector('#settingsTabs button[data-stab="${stab}"]'); if (b) b.click(); return true; })()`);
      return fx.waitForEval(`(() => { const a = document.querySelector('.settings-tab.active'); return a && a.id === 'stab-${stab}' ? 1 : null; })()`, 100);
    };
    const toasts = () => ev(`[...document.querySelectorAll('#toastTray .toast')].map(n => n.textContent)`);
    const clearToasts = () => ev(`(() => { document.querySelectorAll('#toastTray .toast').forEach(n => n.remove()); return true; })()`);
    const waitToast = async pred => {
      for (let i = 0; i < 60; i++) {
        const list = await toasts();
        const hit = list.find(pred);
        if (hit) return hit;
        await sleep(60);
      }
      return null;
    };
    const setValue = (selector, value, eventName = 'change') => ev(`(() => {
      const n = document.querySelector(${JSON.stringify(selector)});
      if (!n || n.disabled) return false;
      n.value = ${JSON.stringify(value)};
      n.dispatchEvent(new Event('input', { bubbles: true }));
      if (${JSON.stringify(eventName)} === 'change') n.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const click = selector => ev(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);
    // 真键盘输入:先聚焦,再逐字 Input.insertText(每一下都派 input 事件,与用户敲键一致)。
    const typeInto = async (selector, text) => {
      await ev(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.focus(); return true; })()`);
      for (const ch of text) {
        if (ch === '\n') await fx.key('Enter', { keyCode: 13, text: '\r' });
        else await fx.cdp.send('Input.insertText', { text: ch });
      }
    };
    // 真失焦:按 Tab 把焦点移走(浏览器自己派 change)。
    const blur = async selector => { await fx.tab(); await sleep(60); };
    const draft = () => ev(`JSON.parse(JSON.stringify(window.state.providersDraft))`);

    await ev(`(() => { document.getElementById('openSettingsBtn').click(); return true; })()`);
    ok(Boolean(await fx.waitForEval(`(() => !document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 200)), 'W0 设置弹窗打开了');

    /* ═════════ W1 手动模型清单逐字输入 ═════════ */
    await switchTab('providers');
    // 预设里第一条是本机 Ollama(带地址);要一张「没地址、没模型」的卡,就选「自定义」。
    const customPreset = await ev(`(() => { const s = document.getElementById('providerPresetSelect'); const o = [...s.options].find(x => /custom|自定义/i.test(x.value + x.textContent)); return o ? o.value : ''; })()`);
    ok(Boolean(customPreset), `W1a 预设里有「自定义」(实测 ${customPreset})`);
    await ev(`(() => { const s = document.getElementById('providerPresetSelect'); s.value = ${JSON.stringify(customPreset)}; return true; })()`);
    await click('#addProviderBtn');
    const cards = await ev(`document.querySelectorAll('#providersList .prov-card').length`);
    ok(cards === 2, `W1c 现在是两张卡:fake + 自定义(实测 ${cards})`);
    const manual = idx => `#providersList .prov-card:nth-child(${idx}) .field-block textarea`;
    const dr0 = await draft();
    ok(dr0[1] && !dr0[1].model && !dr0[1].baseUrl, `W1d 新卡没有模型也没有地址(实测 model=${JSON.stringify(dr0[1] && dr0[1].model)} baseUrl=${JSON.stringify(dr0[1] && dr0[1].baseUrl)})`);
    // 逐字敲「deepseek-chat」:修前第一个字母 'd' 就把 p.model 永久设成 'd',每一下又把上一个半截名字算进 hiddenModels。
    await typeInto(manual(2), 'deepseek-chat');
    const mid = (await draft())[1];
    ok(!mid.model, `W1e 敲到一半(只有 input 事件)不改 p.model(实测 ${JSON.stringify(mid.model)})`);
    ok(!mid.hiddenModels, `W1f 敲到一半不把半截名字写进 hiddenModels(实测 ${JSON.stringify(mid.hiddenModels)})`);
    await blur(manual(2));
    await sleep(100);
    const after = (await draft())[1];
    ok(after.model === 'deepseek-chat', `W1g 失焦(change)后才补默认模型(实测 ${JSON.stringify(after.model)})`);
    ok(!after.hiddenModels, `W1h 失焦后也没有半截名字被隐藏(实测 ${JSON.stringify(after.hiddenModels)})`);
    ok((after.models || []).map(m => m.id).join() === 'deepseek-chat', `W1i p.models 就是打出来的那一行(实测 ${JSON.stringify(after.models)})`);
    // 删一行:先聚焦(此刻清单快照 = deepseek-chat),整段换成别的名字,失焦 → 只有「聚焦时在、现在不在」的那一个进 hiddenModels。
    await ev(`(() => { const n = document.querySelector(${JSON.stringify(manual(2))}); n.focus(); n.select(); return true; })()`);
    await typeInto(manual(2), 'other-model');
    ok(!(await draft())[1].hiddenModels, 'W1j 整段替换敲到一半同样不写 hiddenModels');
    await blur(manual(2));
    await sleep(100);
    const replaced = (await draft())[1];
    ok(JSON.stringify(replaced.hiddenModels) === JSON.stringify(['deepseek-chat']) && replaced.model === 'deepseek-chat',
      `W1k 失焦后 hiddenModels 只含被删掉的那一个、p.model 不变(实测 ${JSON.stringify({ h: replaced.hiddenModels, m: replaced.model })})`);

    /* ═════════ W8 服务商卡空 Base URL ═════════ */
    const diskBefore = disk().providers.map(p => p.id);
    await clearToasts();
    ok(await click('#saveConfigBtn'), 'W8a 点「保存服务商」');
    const blocked = await waitToast(x => x.includes(ZH['onboarding.wizard.validate.urlEmpty']));
    ok(Boolean(blocked), `W8b 空 Base URL 被拦并说清原因(toast: ${blocked})`);
    const named = (await draft())[1];
    ok(blocked && blocked.includes(named.label || named.id), `W8c toast 点名了这张卡(${named.label || named.id})`);
    await sleep(300);
    ok(JSON.stringify(disk().providers.map(p => p.id)) === JSON.stringify(diskBefore), `W8d 没有写盘(盘上服务商 ${JSON.stringify(disk().providers.map(p => p.id))})`);
    // 测试连接:空地址不发请求,给本地化人话(修前回「✗ no base URL」)。
    await ev(`(() => { document.querySelectorAll('#providersList .prov-card')[1].querySelector('button.file-label').click(); return true; })()`);
    const testText = await fx.waitForEval(`(() => { const n = document.getElementById('provStatus_1'); return n && n.textContent ? n.textContent : null; })()`, 100);
    ok(testText === '✗ ' + ZH['onboarding.wizard.validate.urlEmpty'], `W8e 空地址「测试连接」给本地化提示(实测 ${JSON.stringify(testText)})`);
    ok(!/no base URL/i.test(testText || ''), 'W8f 不再出现生硬的英文 no base URL');
    // 补上地址(指向假 provider)→ 能存。
    await ev(`(() => { const i = document.querySelectorAll('#providersList .prov-card')[1].querySelector('[data-prov-field="baseUrl"]'); i.value = ${JSON.stringify(`http://127.0.0.1:${fx.providerPort}`)}; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    ok(await click('#saveConfigBtn') && Boolean(await waitConfig(c => (c.providers || []).length === 2)), 'W8g 补上地址后保存成功,盘上有两个服务商');

    /* ═════════ W7 测试连接成功后绿字不被擦掉 ═════════ */
    await ev(`(() => { document.querySelectorAll('#providersList .prov-card')[1].querySelector('button.file-label').click(); return true; })()`);
    await sleep(1200);
    const green = await fx.waitForEval(`(() => { const n = document.getElementById('provStatus_1'); return n && n.classList.contains('good') && n.textContent.includes('✓') ? n.textContent : null; })()`, 150);
    ok(Boolean(green), `W7a 测试连接成功,状态行是绿字(实测 ${JSON.stringify(green)})`);
    await sleep(700);
    const greenLater = await ev(`(() => { const n = document.getElementById('provStatus_1'); return n ? { cls: n.className, text: n.textContent } : null; })()`);
    ok(greenLater && /\bgood\b/.test(greenLater.cls) && greenLater.text.includes('✓'), `W7b 过一会儿绿字还在(修前 renderProviders 立刻把它擦掉;实测 ${JSON.stringify(greenLater)})`);

    /* ═════════ W16 最大轮次填 abc 不写盘 ═════════ */
    await switchTab('claude');
    await clearToasts();
    ok(await setValue('#cfgMaxTurns', 'abc'), 'W16a 最大轮次填 abc');
    ok(Boolean(await waitToast(x => x === ZH['settings.positiveIntegerOnly'])), 'W16b 给出「请填正整数」');
    await sleep(300);
    ok(((await status()).maxTurns || '') === '', 'W16c abc 没有落盘');
    ok((await ev(`document.getElementById('cfgMaxTurns').value`)) === '', 'W16d 框里回显落盘值(空)');
    ok(await setValue('#cfgMaxTurns', '25') && Boolean(await waitConfig(c => c.maxTurns === '25')), 'W16e 填 25 照常落盘');
    ok(await setValue('#cfgMaxTurns', '') && Boolean(await waitConfig(c => c.maxTurns === '')), 'W16f 留空 = 不限,照常落盘');

    /* ═════════ W2 目录与「提醒」状态行跟着语言走 ═════════ */
    await switchTab('security');
    const heading = () => ev(`(() => { const h = document.querySelector('#stab-security .setcat-section .settings-subhead'); return h ? h.textContent : ''; })()`);
    const notifyText = () => ev(`(document.getElementById('notifyStatus') || {}).textContent || ''`);
    const secSection = await ev(`(() => { const s = document.querySelector('#stab-security .setcat-section'); return s ? s.id : ''; })()`);
    ok(Boolean(secSection), `W2a 安全页有目录段(${secSection})`);
    const zhHeading = await heading();
    ok(/[一-鿿]/.test(zhHeading), `W2b 当前是中文标题(${zhHeading})`);
    ok([ZH['notify.off'], ZH['notify.unsupported'], ZH['notify.denied']].includes(await notifyText()) || (await notifyText()).length > 0, `W2c 提醒状态行有中文文案(${await notifyText()})`);
    await ev(`(async () => { const m = await import('/js/i18n.js'); await m.setLocale('en-US'); return true; })()`);
    const enHeading = await fx.waitForEval(`(() => { const h = document.querySelector('#stab-security .setcat-section .settings-subhead'); return h && !/[\\u4e00-\\u9fff]/.test(h.textContent) ? h.textContent : null; })()`, 100);
    ok(Boolean(enHeading), `W2d 切到 en-US 后目录段标题随之换成英文(修前停在中文;实测 ${JSON.stringify(enHeading)})`);
    const enNotify = await notifyText();
    ok([EN['notify.off'], EN['notify.unsupported'], EN['notify.denied']].includes(enNotify)
      || (enNotify.length > 0 && !/[一-鿿]/.test(enNotify)), `W2e 「提醒」状态行也换成英文(实测 ${JSON.stringify(enNotify)})`);
    // 目录里随便抽一行的标签与下拉项也是英文
    const rowLabel = await ev(`(() => { const l = document.querySelector('#stab-security .setcat-row .setcat-label'); return l ? l.textContent : ''; })()`);
    ok(rowLabel && !/[一-鿿]/.test(rowLabel), `W2f 目录行标签也是英文(${rowLabel})`);
    await ev(`(async () => { const m = await import('/js/i18n.js'); await m.setLocale('zh-CN'); return true; })()`);
    ok(Boolean(await fx.waitForEval(`(() => { const h = document.querySelector('#stab-security .setcat-section .settings-subhead'); return h && /[\\u4e00-\\u9fff]/.test(h.textContent) ? 1 : null; })()`, 100)), 'W2g 切回 zh-CN 又换回中文');

    /* ═════════ W3 信封里的 message 不被印成 [object Object] ═════════ */
    // 服务端对「HTTP 200 + {ok:false,error:'人话'}」的路由会统一信封成 {code,params,message}(00-boot normalizeApiErrorPayload)。
    // 这里把 fetch 换成假的返回该信封,逐个触发界面上直接读 r.error 的位置。
    const ENVELOPE_MESSAGE = '这是服务端写给用户看的原因';
    await ev(`(() => {
      const orig = window.fetch.bind(window);
      window.__calls = [];
      window.__stubs = [];
      window.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        const method = String((init && init.method) || 'GET').toUpperCase();
        window.__calls.push(method + ' ' + url);
        const hit = window.__stubs.find(s => url.includes(s.match) && (!s.method || s.method === method));
        if (hit) {
          if (hit.delay) await new Promise(r => setTimeout(r, hit.delay));
          return new Response(JSON.stringify(hit.body), { status: hit.status || 200, headers: { 'content-type': 'application/json' } });
        }
        return orig(input, init);
      };
      return true;
    })()`);
    const stubEnvelope = (match, method) => ev(`(() => { window.__stubs = window.__stubs.filter(s => s.match !== ${JSON.stringify(match)}); window.__stubs.push({ match: ${JSON.stringify(match)}, method: ${JSON.stringify(method || '')}, body: { ok: false, error: { code: 'api.request_failed', params: {}, message: ${JSON.stringify(ENVELOPE_MESSAGE)} } } }); return true; })()`);
    await switchTab('update');
    await stubEnvelope('/api/overlay/rollback', 'POST');
    await click('#ovRollbackBtn');
    const rollbackHint = await fx.waitForEval(`(() => { const n = document.getElementById('ovRollbackHint'); return n && n.textContent && n.textContent !== ${JSON.stringify(ZH['settings.update.rollingBack'])} ? n.textContent : null; })()`, 100);
    ok(rollbackHint === ENVELOPE_MESSAGE, `W3a 回滚失败的提示是 message 原句(实测 ${JSON.stringify(rollbackHint)})`);
    await clearToasts();
    await stubEnvelope('/api/pick-file', 'POST');
    await click('#ovPickBtn');
    const pickToast = await waitToast(x => x.includes(ENVELOPE_MESSAGE));
    ok(Boolean(pickToast) && !String(pickToast).includes('[object Object]'), `W3b 选 zip 失败的 toast 是 message 原句(实测 ${JSON.stringify(pickToast)})`);
    await switchTab('integrations');
    await clearToasts();
    await stubEnvelope('/api/pick-folder', 'POST');
    await click('#mcpImportBtn');
    const importToast = await waitToast(x => x.includes(ENVELOPE_MESSAGE));
    ok(Boolean(importToast) && !String(importToast).includes('[object Object]'), `W3c 导入 MCP 选文件夹失败的 toast 是 message 原句(实测 ${JSON.stringify(importToast)})`);
    const allToasts = (await toasts()).join(' | ');
    ok(!allToasts.includes('[object Object]'), `W3d 全程没有 [object Object](${allToasts.slice(0, 120)})`);

    /* ═════════ W4 管家数字框清空不写 0 ═════════ */
    await switchTab('steward');
    ok(Boolean(await fx.waitForEval(`document.getElementById('cfgStewardMaxCostPerDay') && document.getElementById('cfgStewardMaxCostPerDay').value === '3' ? 1 : null`, 100)), 'W4a 管家每日费用上限框显示落盘值 3');
    ok(await setValue('#cfgStewardMaxCostPerDay', ''), 'W4b 清空每日费用上限');
    await sleep(500);
    let c = await status();
    ok(c.stewardMaxCostPerDay === 3, `W4c 清空不写盘:盘上仍是 3(实测 ${c.stewardMaxCostPerDay};修前写成 0 = 关闭费用闸)`);
    ok((await ev(`document.getElementById('cfgStewardMaxCostPerDay').value`)) === '3', 'W4d 框里回显落盘值 3');
    ok(await setValue('#cfgStewardGlobalMaxCostPerDay', '') , 'W4e 清空全局每日费用上限');
    await sleep(500);
    c = await status();
    ok(c.stewardGlobalMaxCostPerDay === 9 && (await ev(`document.getElementById('cfgStewardGlobalMaxCostPerDay').value`)) === '9', `W4f 全局费用闸同样不被清成 0(实测 ${c.stewardGlobalMaxCostPerDay})`);
    ok(await setValue('#cfgStewardMaxTurnsPerHour', '') , 'W4g 清空每小时回合上限');
    await sleep(500);
    c = await status();
    ok(c.stewardMaxTurnsPerHour === 17 && (await ev(`document.getElementById('cfgStewardMaxTurnsPerHour').value`)) === '17', `W4h 每小时回合上限不被钳成最小值(实测 ${c.stewardMaxTurnsPerHour})`);
    ok(await setValue('#cfgStewardMaxCostPerDay', '5') && Boolean(await waitConfig(x => x.stewardMaxCostPerDay === 5)), 'W4i 填 5 照常落盘');

    /* ═════════ W14 定时任务「建这一条」双击只发一次 ═════════ */
    await ev(`(() => { document.getElementById('cfgStewardScheduleNewBtn').click(); return true; })()`);
    await ev(`(() => { const f = document.getElementById('cfgStewardScheduleForm'); f.querySelector('#cfgStewardScheduleTitle').value = '双击测试'; f.querySelector('#cfgStewardScheduleText').value = '提醒我喝水'; return true; })()`);
    await ev(`(() => { window.__calls.length = 0; window.__stubs.push({ match: '/api/scheduler/tasks', method: 'POST', delay: 400, body: { ok: true, task: { id: 'x' } } }); return true; })()`);
    await ev(`(() => { const f = document.getElementById('cfgStewardScheduleForm'); f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); return true; })()`);
    const midDisabled = await ev(`document.getElementById('cfgStewardScheduleSubmitBtn').disabled`);
    ok(midDisabled === true, 'W14a 在途时「建这一条」被禁用');
    await sleep(900);
    const posts = await ev(`window.__calls.filter(x => x.startsWith('POST') && x.includes('/api/scheduler/tasks')).length`);
    ok(posts === 1, `W14b 连提两次只发出 1 个 POST(实测 ${posts})`);
    ok((await ev(`document.getElementById('cfgStewardScheduleSubmitBtn').disabled`)) === false, 'W14c 回来后按钮恢复可点');

    /* ═════════ W5 Agent 角色页:未保存修改不丢、范围切换要确认、保存不固化内置角色 ═════════ */
    await switchTab('agents');
    ok(Boolean(await fx.waitForEval(`document.querySelectorAll('#agentRoleEditorList .agent-role-edit-card').length >= 3 ? 1 : null`, 150)), 'W5a 角色页列出了内置角色');
    const cardCount = await ev(`document.querySelectorAll('#agentRoleEditorList .agent-role-edit-card').length`);
    // 摘要行不印原始枚举(Explorer · read · plan)
    const summary = await ev(`document.querySelector('#agentRoleEditorList .agent-role-edit-card summary').textContent`);
    ok(!/\b(read|edit|exec)\b/.test(summary) && !/\b(inherit|plan|acceptEdits|dontAsk|bypass)\b/.test(summary), `W5b 角色卡摘要不印原始枚举(实测 ${JSON.stringify(summary)})`);
    // 不改任何东西就点保存:不能把 N 个内置角色固化进 agentRoleOverrides
    ok(await click('#agentRoleSaveBtn'), 'W5c 不改动直接点「保存角色」');
    await sleep(800);
    ok((disk().agentRoleOverrides || []).length === 0, `W5d 没改动的内置角色不写进 agentRoleOverrides(实测 ${(disk().agentRoleOverrides || []).length} 条;卡片 ${cardCount} 张)`);
    // 改第一张内置角色的显示名 → 只存这一个
    const firstId = await ev(`document.querySelector('#agentRoleEditorList .agent-role-edit-card [data-role-field="id"]').value`);
    ok(await ev(`(() => { const i = document.querySelector('#agentRoleEditorList .agent-role-edit-card [data-role-field="label"]'); i.value = '改过的名字'; i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`), 'W5e 改第一张角色的显示名(未保存)');
    // 切走再切回来:编辑还在(修前 loadAgentRoles 静默覆盖)
    await switchTab('basic');
    await switchTab('agents');
    await sleep(500);
    const kept = await ev(`document.querySelector('#agentRoleEditorList .agent-role-edit-card [data-role-field="label"]').value`);
    ok(kept === '改过的名字', `W5f 切页签再回来,未保存的编辑还在(实测 ${JSON.stringify(kept)})`);
    // 切范围:先确认;取消 → 范围与草稿都不动
    await ev(`(() => { const s = document.getElementById('agentRoleScope'); s.value = 'project'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const confirmShown = await fx.waitForEval(`document.querySelector('.confirm-panel [data-confirm="cancel"]') ? 1 : null`, 100);
    ok(Boolean(confirmShown), 'W5g 有未保存修改时切范围弹出确认');
    await click('.confirm-panel [data-confirm="cancel"]');
    await sleep(300);
    ok((await ev(`document.getElementById('agentRoleScope').value`)) === 'global', 'W5h 取消确认 → 范围退回「全局」');
    ok((await ev(`document.querySelector('#agentRoleEditorList .agent-role-edit-card [data-role-field="label"]').value`)) === '改过的名字', 'W5i 取消确认 → 草稿原样');
    // 保存:只有改过的那一个进 overrides
    await click('#agentRoleSaveBtn');
    const savedRoles = await waitConfig(x => (x.agentRoleOverrides || []).length === 1);
    ok(Boolean(savedRoles) && savedRoles.agentRoleOverrides[0].id === firstId && savedRoles.agentRoleOverrides[0].label === '改过的名字',
      `W5j 保存后 agentRoleOverrides 只有改过的那一个(${firstId};实测 ${JSON.stringify((savedRoles && savedRoles.agentRoleOverrides || []).map(r => r.id))})`);
    // 「恢复默认」:点它再保存 → 覆盖被移除
    await ev(`(() => { document.querySelector('#agentRoleEditorList .agent-role-edit-card .mini.danger').click(); return true; })()`);
    await click('#agentRoleSaveBtn');
    ok(Boolean(await waitConfig(x => (x.agentRoleOverrides || []).length === 0)), 'W5k 「恢复默认」后保存,覆盖被清掉(内置角色以后的改进照常生效)');
    // 范围切换且没有未保存修改:不弹确认
    await ev(`(() => { const s = document.getElementById('agentRoleScope'); s.value = 'project'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(300);
    ok(!(await ev(`Boolean(document.querySelector('.confirm-panel'))`)), 'W5l 没有未保存修改时切范围不弹确认');
    await ev(`(() => { const s = document.getElementById('agentRoleScope'); s.value = 'global'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);

    /* ═════════ W6 设置页手填工作文件夹要绝对路径 ═════════ */
    await switchTab('basic');
    const wsBefore = JSON.stringify((await status()).workspaces);
    await clearToasts();
    ok(await setValue('#workspaceAddInput', 'relative-dir', 'input') && await click('#workspaceAddBtn'), 'W6a 「添加工作区」填相对路径 abc');
    ok(Boolean(await waitToast(x => x === ZH['workspace.pathAbsoluteRequired'])), 'W6b toast 提示要完整的绝对路径');
    await sleep(400);
    ok(JSON.stringify((await status()).workspaces) === wsBefore, 'W6c 没有把相对路径写进 workspaces');
    const defaultBefore = (await status()).defaultWorkspace;
    await clearToasts();
    ok(await setValue('#workspaceInput', 'some\\relative\\dir'), 'W6d 「默认工作文件夹」填相对路径');
    ok(Boolean(await waitToast(x => x === ZH['workspace.pathAbsoluteRequired'])), 'W6e toast 提示要完整的绝对路径');
    await sleep(400);
    ok((await status()).defaultWorkspace === defaultBefore && (await ev(`document.getElementById('workspaceInput').value`)) === defaultBefore, 'W6f 默认工作文件夹没变,输入框回填落盘值');
    const extra = path.join(fx.root, 'extra-ws');
    fs.mkdirSync(extra, { recursive: true });
    ok(await setValue('#workspaceAddInput', extra, 'input') && await click('#workspaceAddBtn') && Boolean(await waitConfig(x => (x.workspaces || []).some(w => String(w.path).toLowerCase() === extra.toLowerCase()))), 'W6g 绝对路径照常添加');

    /* ═════════ W15 改月度预算 → 用量面板重拉 ═════════ */
    await ev(`(() => { const b = document.querySelector('.tool-tabs button[data-tab="usage"]'); if (b) b.click(); return true; })()`);
    ok(Boolean(await fx.waitForEval(`(() => { const p = document.getElementById('usagePanel'); return p && p.textContent.includes('50') ? 1 : null; })()`, 150)), 'W15a 用量面板按预算 50 画出了进度');
    await ev(`(() => { window.__calls.length = 0; return true; })()`);
    await switchTab('limits');
    ok(await setValue('#cfgUsageBudgetMonthly', '123'), 'W15b 设置里把月度预算改成 123');
    ok(Boolean(await waitConfig(x => x.usageBudget && x.usageBudget.monthly === 123)), 'W15c 预算落盘 123');
    // 右栏的用量面板此刻不可见(没有客户端矩形)→ 只作废缓存;下次点开「用量」页签就会重拉。
    await ev(`(() => { const b = document.querySelector('.tool-tabs button[data-tab="usage"]'); if (b) b.click(); return true; })()`);
    const refreshed = await fx.waitForEval(`(() => { const p = document.getElementById('usagePanel'); return p && p.textContent.includes('123') ? 1 : null; })()`, 150);
    ok(Boolean(refreshed), 'W15d 再点开「用量」,面板显示新预算 123(修前一直是缓存里的旧预算 50)');
    const usageCalls = await ev(`window.__calls.filter(x => x.includes('/api/usage/summary')).length`);
    ok(usageCalls >= 1, `W15e 面板重新拉了 /api/usage/summary(实测 ${usageCalls} 次)`);

    /* ═════════ W11 语音识别「模型名」可手填 ═════════ */
    await switchTab('voice');
    const asrInput = await fx.waitForEval(`(() => { const n = document.querySelector('#stab-voice .asr-settings .asr-add-model'); return n ? n.tagName : null; })()`, 100);
    ok(asrInput === 'INPUT', `W11a 「模型名」是文本框(实测 ${asrInput})`);
    ok(await ev(`(() => { const n = document.querySelector('#stab-voice .asr-settings .asr-add-model'); const l = document.getElementById(n.getAttribute('list')); return Boolean(l) && l.tagName === 'DATALIST'; })()`), 'W11b 绑了 datalist 做候选');
    // 选「自定义」那个新服务商(没有任何模型清单也要能手填)
    const emptyProv = customPreset;   // W1 里加的那张「自定义」卡(落盘后 id 就是预设 id)
    await ev(`(() => { const sel = document.querySelector('#stab-voice .asr-settings .asr-add-provider'); sel.value = ${JSON.stringify(emptyProv)}; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    ok(await ev(`(() => { const n = document.querySelector('#stab-voice .asr-settings .asr-add-model'); n.value = 'my-asr-model'; document.querySelector('#stab-voice .asr-settings .asr-add-btn').click(); return true; })()`), 'W11c 手填 my-asr-model 点「添加并启用」');
    const asrSaved = await waitConfig(x => x.asrModel === 'my-asr-model');
    const asrProvider = asrSaved && (asrSaved.providers || []).find(p => p.id === asrSaved.asrProviderId);
    ok(Boolean(asrSaved) && Boolean(asrProvider) && (asrProvider.models || []).some(m => m.id === 'my-asr-model' && Array.isArray(m.caps) && m.caps.includes('asr')),
      `W11d 手填的名字被登记成带 asr 能力的模型并选中(实测 ${JSON.stringify(asrSaved && { p: asrSaved.asrProviderId, m: asrSaved.asrModel })})`);

    /* ═════════ 向导:W13 / W10 / W9 / 另挑一个 ═════════ */
    await switchTab('basic');
    const completedBefore = (await status()).onboarding.completedAt;
    ok(Boolean(completedBefore), `W13a 夹具里引导已完成(completedAt=${completedBefore})`);
    const openWizard = async () => {
      await click('#reopenOnboardingBtn');
      return fx.waitForEval(`document.querySelector('.onboard-wizard') ? 1 : null`, 100);
    };
    ok(Boolean(await openWizard()), 'W13b 重新打开引导');
    await click('.onboard-wiz-skip');
    await fx.waitForEval(`document.querySelector('.onboard-wizard') ? null : 1`, 100);
    await sleep(500);
    const afterCancel = (await status()).onboarding;
    ok(afterCancel.completedAt === completedBefore, `W13c 关掉向导后 completedAt 没被覆盖(实测 ${JSON.stringify(afterCancel)})`);

    ok(Boolean(await openWizard()), 'W10a 再开向导');
    const wizTitleZh = await ev(`document.querySelector('.onboard-wizard .modal-head h3').textContent`);
    ok(wizTitleZh === ZH['onboarding.wizard.title'], `W10b 标题是中文(${wizTitleZh})`);
    await ev(`(() => { const s = document.querySelector('.onboard-wiz-locale'); s.value = 'en-US'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const wizTitleEn = await fx.waitForEval(`(() => { const h = document.querySelector('.onboard-wizard .modal-head h3'); return h && h.textContent === ${JSON.stringify(EN['onboarding.wizard.title'])} ? h.textContent : null; })()`, 150);
    ok(Boolean(wizTitleEn), `W10c 第一步切到 English,标题随之换成「${EN['onboarding.wizard.title']}」(实测 ${JSON.stringify(wizTitleEn)})`);
    const closeLabel = await ev(`document.querySelector('.onboard-wizard .onboard-wiz-close').getAttribute('aria-label')`);
    ok(closeLabel === EN['common.close'], `W10d 关闭钮 aria-label 也换了(实测 ${JSON.stringify(closeLabel)} 期望 ${JSON.stringify(EN['common.close'])})`);
    await ev(`(() => { const s = document.querySelector('.onboard-wiz-locale'); s.value = 'zh-CN'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await fx.waitForEval(`(() => { const h = document.querySelector('.onboard-wizard .modal-head h3'); return h && h.textContent === ${JSON.stringify(ZH['onboarding.wizard.title'])} ? 1 : null; })()`, 150);

    // 走到「API Key」那一步
    const stepClass = () => ev(`(() => { const s = document.querySelector('.onboard-wizard .onboard-wiz-step'); return s ? s.className : ''; })()`);
    for (let i = 0; i < 4 && !/onboard-wiz-provider/.test(await stepClass()); i++) {
      await click('.onboard-wizard .onboard-wiz-next');
      await sleep(150);
    }
    ok(/onboard-wiz-provider/.test(await stepClass()), 'W9a 走到了「填入 API Key」那一步');
    const hintText = await ev(`document.querySelector('.onboard-wiz-provider .onboard-wiz-step-hint').textContent`);
    ok(hintText === ZH['onboarding.wizard.provider.hint'] && !hintText.includes('默认模型由预设带出'), `W9b 说明不再说「默认模型由预设带出」(实测 ${JSON.stringify(hintText)})`);
    const placeholder = await ev(`document.querySelector('.onboard-wiz-model').placeholder`);
    ok(placeholder === ZH['onboarding.wizard.provider.modelPlaceholder'] && !placeholder.includes('留空则用预设默认模型'), `W9c 模型框占位不再说「留空则用预设默认模型」(实测 ${JSON.stringify(placeholder)})`);
    const providersBefore = (await status()).providers.length;
    await ev(`(() => {
      const key = document.querySelector('.onboard-wiz-provider input[type="password"], .onboard-wiz-provider input.onboard-wiz-key');
      if (key) { key.value = 'sk-test-12345678'; key.dispatchEvent(new Event('input', { bubbles: true })); }
      const url = document.querySelector('.onboard-wiz-baseurl'); url.value = ${JSON.stringify(`http://127.0.0.1:${fx.providerPort}`)}; url.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await click('.onboard-wizard .onboard-wiz-save');
    const needModel = await fx.waitForEval(`(() => { const s = document.querySelector('.onboard-wiz-status'); return s && s.textContent ? s.textContent : null; })()`, 100);
    ok(needModel && needModel.includes(ZH['onboarding.wizard.provider.cloudNeedModel']), `W9d 云端「自定义」空模型被拦,说清要填模型名(实测 ${JSON.stringify(needModel)})`);
    await sleep(300);
    ok((await status()).providers.length === providersBefore, 'W9e 没有存下一个没有模型的服务商');
    await ev(`(() => { const m = document.querySelector('.onboard-wiz-model'); m.value = 'my-model'; m.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await click('.onboard-wizard .onboard-wiz-save');
    const savedWiz = await waitConfig(x => (x.providers || []).some(p => p.model === 'my-model'));
    ok(Boolean(savedWiz), 'W9f 填了模型名之后保存成功,盘上的服务商带着模型');

    // 管家步「另挑一个」
    for (let i = 0; i < 3 && !/onboard-wiz-steward/.test(await stepClass()); i++) {
      await click('.onboard-wizard .onboard-wiz-next');
      await sleep(150);
    }
    if (/onboard-wiz-steward/.test(await stepClass())) {
      ok(await ev(`document.querySelectorAll('.onboard-wiz-steward-cards .onboard-wiz-card')[0].classList.contains('selected')`), 'W16g 管家步默认选中「跟随」');
      await click('.onboard-wiz-steward-cards .onboard-wiz-card:nth-child(2)');
      await sleep(250);
      const sel = await ev(`[...document.querySelectorAll('.onboard-wiz-steward-cards .onboard-wiz-card')].map(c => c.classList.contains('selected'))`);
      ok(sel[1] === true && sel[0] === false, `W16h 点「另挑一个」后它有选中态、「跟随」取消选中(实测 ${JSON.stringify(sel)})`);
      ok((await ev(`document.activeElement && document.activeElement.id`)) === 'onboardStewardModel', 'W16i 光标送进了模型名输入框');
    } else {
      ok(false, 'W16g 没走到管家步');
    }
    await click('.onboard-wizard .onboard-wiz-skip');
    await sleep(300);

    /* ═════════ 收尾 ═════════ */
    ok(fx.exceptions.length === 0, `W99a 页面没有未捕获异常(${fx.exceptions.slice(0, 3).join(' | ') || '无'})`);
  } catch (e) {
    t.fail('未捕获异常:' + (e && e.stack || e));
  } finally {
    if (fx) await fx.close();
    t.done({ exit: true });
  }
})();
