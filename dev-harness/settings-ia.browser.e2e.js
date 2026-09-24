#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// W6 设置重组（用户 2026-09-24「设置里的内容有点乱，把重复／类似的设置统一成公用的设置」）的真浏览器件。
// 真起工作台 ＋ 无头 Edge，走一遍新结构，每一条都读服务端落盘值（GET /api/status），不信界面自己说的：
//   S1 专家档：13 枚页签按新顺序排、逐枚点过去面板真的切过去且不空；「MCP 运维」已并进「集成与 MCP」（旧名改投新家）；
//   S2 「模型分配」表每一行都能选、选中即存：主模型（服务商与命令行引擎两种）、新线程默认引擎、管家、强／快两档、
//      子代理、上下文压缩、句尾改错；
//   S3 「权限与安全」：切「智能自动」在本页就地展开确认（确认前不落盘，确认后带 confirm:true 落盘），两条等待时限即存；
//   S4 「用量与限额」：月度预算与回合看门狗即存；
//   S5 缺陷①（草稿过期会回滚）：设置页第一次打开之后，别的写口（弹窗外的一次 POST /api/config —— 线程头「设为新任务
//      默认」、管家改配置走的都是这种路）改了服务商的推理强度与缺省模型；再打开设置、改一张卡片、期间又有一次外部改动，
//      按「保存服务商」—— 三处外部改动与用户的改动都在盘上，一个字没回滚；保存条与导航小圆点跟着干净；
//   S6 「放弃改动」把卡片与保存条都还原；
//   S7 简易档：可见页签恰好 9 枚、五组都没有空组头、页内 .settings-expert-only 的行收起；
//   S8 全程页面上没有未捕获异常、没有 console.error。
// 判定行：`SETTINGS IA BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

let fail = 0;
const ok = (condition, label) => {
  if (condition) console.log('PASS ' + label);
  else { fail += 1; console.log('FAIL ' + label); }
};

const PRO_TABS = ['basic', 'security', 'limits', 'steward', 'models', 'providers', 'claude', 'agents', 'network', 'integrations', 'doctor', 'advanced', 'update'];
const SIMPLE_TABS = ['basic', 'security', 'limits', 'steward', 'models', 'providers', 'network', 'doctor', 'update'];

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok,
      prefix: 'ruyi-settings-ia-',
      width: 1440,
      height: 900,
      config: { uiMode: 'pro' },
      prepare: async f => {
        const saved = await f.request('POST', '/api/config', {
          activeProvider: 'fake',
          providers: [
            { id: 'fake', label: 'Fake', type: 'openai-compat', baseUrl: `http://127.0.0.1:${f.providerPort}`, apiKey: 'k', model: 'fake-model', models: [{ id: 'fake-model', label: 'Fake' }, { id: 'fake-pro', label: 'Fake Pro' }] },
            { id: 'qwen', label: 'Qwen', type: 'openai-compat', baseUrl: `http://127.0.0.1:${f.providerPort}`, apiKey: 'k2', model: 'qwen-plus', models: [{ id: 'qwen-plus', label: 'qwen-plus' }, { id: 'qwen-turbo', label: 'qwen-turbo' }] },
          ],
        });
        ok(Boolean(saved && saved.status === 200), 'S0 两家服务商已写进配置');
      },
    });
    const ev = expr => fx.evaluate(expr);
    const status = async () => { const r = await fx.request('GET', '/api/status'); return (r && r.json && r.json.config) || {}; };
    const waitConfig = async (pred, tries = 150) => {
      for (let i = 0; i < tries; i++) {
        const c = await status();
        try { if (pred(c)) return c; } catch { /* 还没到 */ }
        await sleep(80);
      }
      return null;
    };
    // 服务端落盘了还不够：页面这一侧要等保存的回包回来（state.config 换成新值、保存期间置灰的下拉恢复）再点下一枚 ——
    // 真人手速不会在几十毫秒里连点两枚，测试会，不等就是在量竞态而不是在量功能。
    const settled = clientPred => fx.waitForEval(`(() => {
      if ([...document.querySelectorAll('#settingsModal select')].some(s => s.disabled)) return null;
      const c = (window.state && window.state.config) || {};
      try { return (${clientPred})(c) ? 1 : null; } catch { return null; }
    })()`, 150);
    const pickSaved = async (selector, value, serverPred, clientPred) => {
      if (!(await pick(selector, value))) return false;
      if (!(await waitConfig(serverPred))) return false;
      return Boolean(await settled(clientPred || String(serverPred)));
    };
    const diskConfig = () => JSON.parse(fs.readFileSync(path.join(fx.home, 'config.json'), 'utf8'));
    const provider = (c, id) => ((c && c.providers) || []).find(p => p && p.id === id) || {};
    // 选中一枚下拉的某个值并派发 change（值不存在就回 false —— 「能选」本身也是被量的事）。
    const pick = (selector, value) => ev(`(() => {
      const s = document.querySelector(${JSON.stringify(selector)});
      if (!s) return false;
      const want = ${JSON.stringify(value)};
      const opt = [...s.options].find(o => o.value === want || (want.startsWith('~') && o.value.endsWith(want.slice(1))));
      if (!opt) return false;
      s.value = opt.value;
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const setInput = (selector, value) => ev(`(() => {
      const i = document.querySelector(${JSON.stringify(selector)});
      if (!i) return false;
      i.value = ${JSON.stringify(value)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      i.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    const openSettings = async () => {
      await ev(`(() => { document.getElementById('openSettingsBtn').click(); return true; })()`);
      return fx.waitForEval(`(() => !document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 200);
    };
    const closeSettings = async () => {
      await ev(`(() => { document.querySelector('#settingsModal .modal-foot [data-close-modal]').click(); return true; })()`);
      return fx.waitForEval(`(() => document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 200);
    };
    const switchTab = async stab => {
      await ev(`(() => { document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(g => g.classList.add('is-open')); const b = document.querySelector('#settingsTabs button[data-stab="${stab}"]'); if (b) b.click(); return true; })()`);
      return fx.waitForEval(`(() => { const a = document.querySelector('.settings-tab.active'); return a && a.id === 'stab-${stab}' ? { text: (a.innerText || '').trim().length } : null; })()`, 100);
    };
    const visible = selector => ev(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); return Boolean(n) && n.offsetParent !== null && getComputedStyle(n).display !== 'none'; })()`);

    /* ═════════ S1 专家档：13 枚页签、新顺序、逐枚切得过去 ═════════ */
    ok(Boolean(await openSettings()), 'S1a 设置弹窗打开了');
    const tabs = await ev(`[...document.querySelectorAll('#settingsTabs button[data-stab]')].map(b => b.dataset.stab)`);
    ok(JSON.stringify(tabs) === JSON.stringify(PRO_TABS), `S1b 13 枚页签按新结构排（实见 ${JSON.stringify(tabs)}）`);
    for (const stab of PRO_TABS) {
      const panel = await switchTab(stab);
      ok(Boolean(panel) && panel.text > 20, `S1c 点「${stab}」面板真的切过去且不是空的（${panel ? panel.text + ' 字' : '没切过去'}）`);
    }
    ok(!(await ev(`Boolean(document.getElementById('stab-mcp')) || Boolean(document.querySelector('#settingsTabs button[data-stab="mcp"]'))`))
      && await ev(`Boolean(document.querySelector('#stab-integrations #mcpConnList')) && document.querySelectorAll('#settingsModal [id="mcpImportBtn"]').length === 1 && !document.getElementById('importMcpFolderBtn')`),
      'S1d 「MCP 运维」并进了「集成与 MCP」：旧页签与旧面板都不在，连接器清单在集成页，导入按钮只剩一枚');
    ok(await ev(`Boolean(document.querySelector('#stab-integrations'))`) && !(await ev(`Boolean(document.querySelector('.modal-foot #saveConfigBtn'))`)),
      'S1e 迁移中心的挂载点 #stab-integrations 在；页脚不再有整份「保存」（保存键在服务商卡片下方）');

    /* ═════════ S2 模型分配：每一行能选、选中即存 ═════════ */
    await switchTab('models');
    const qwenModel = c => ((c.providers || []).find(p => p && p.id === 'qwen') || {}).model;
    ok(await pickSaved('#cfgMainProvider', 'qwen', c => c.activeProvider === 'qwen', "c => c.activeProvider === 'qwen'"),
      'S2a 主模型选「Qwen」→ activeProvider 落盘');
    ok(await pickSaved('#cfgMainModel', 'qwen-turbo', c => c.activeProvider === 'qwen' && qwenModel(c) === 'qwen-turbo',
      "c => ((c.providers || []).find(p => p && p.id === 'qwen') || {}).model === 'qwen-turbo'"),
      'S2b 主模型的模型选 qwen-turbo → providers[qwen].model 落盘');
    const cliOptions = await ev(`[...document.getElementById('cfgMainProvider').options].map(o => o.textContent)`);
    ok(cliOptions.filter(text => /Claude Code|Kimi Code/.test(text)).length === 2, `S2c 两个命令行引擎在主模型下拉里各是一项（引擎三处合一处；实见 ${JSON.stringify(cliOptions)}）`);
    ok(await pickSaved('#cfgMainProvider', '~cli:kimi', c => c.activeProvider === '' && c.agentCliType === 'kimi', "c => c.agentCliType === 'kimi'"),
      'S2d 选 Kimi Code → 一次写 activeProvider:"" ＋ agentCliType:kimi');
    ok(/Kimi Code/.test(await ev(`(document.getElementById('agentCliCurrentHint') || {}).textContent || ''`)),
      'S2e Agent CLI 页顶上那句跟着说「这里是 Kimi Code 的设置」');
    ok(await pickSaved('#cfgMainProvider', 'qwen', c => c.activeProvider === 'qwen' && qwenModel(c) === 'qwen-turbo', "c => c.activeProvider === 'qwen'"),
      'S2f 换回 Qwen（它的缺省模型仍是刚才选的 qwen-turbo）');
    ok(await pickSaved('#cfgNewThreadEngine', 'global', c => c.newThreadEngine === 'global', "c => c.newThreadEngine === 'global'"), 'S2g 新线程默认引擎即存');
    ok(await pickSaved('#cfgStewardProviderId', 'qwen', c => c.stewardProviderId === 'qwen', "c => c.stewardProviderId === 'qwen'"), 'S2h 管家用的服务商即存');
    ok(await pickSaved('#cfgStewardModel', 'qwen-plus', c => c.stewardModel === 'qwen-plus', "c => c.stewardModel === 'qwen-plus'"), 'S2i 管家用的模型即存');
    const tier = (c, name) => (c.stewardThreadModels && c.stewardThreadModels[name]) || {};
    ok(await pickSaved('#cfgStewardStrongProviderId', 'fake', c => tier(c, 'strong').providerId === 'fake',
      "c => ((c.stewardThreadModels || {}).strong || {}).providerId === 'fake'")
      && await pickSaved('#cfgStewardStrongModel', 'fake-pro', c => tier(c, 'strong').providerId === 'fake' && tier(c, 'strong').model === 'fake-pro',
        "c => ((c.stewardThreadModels || {}).strong || {}).model === 'fake-pro'"),
      'S2j 复杂任务 · 强模型两枚即存');
    ok(await pickSaved('#cfgStewardFastProviderId', 'qwen', c => tier(c, 'fast').providerId === 'qwen',
      "c => ((c.stewardThreadModels || {}).fast || {}).providerId === 'qwen'")
      && await pickSaved('#cfgStewardFastModel', 'qwen-turbo',
        c => tier(c, 'fast').providerId === 'qwen' && tier(c, 'fast').model === 'qwen-turbo' && tier(c, 'strong').model === 'fake-pro',
        "c => ((c.stewardThreadModels || {}).fast || {}).model === 'qwen-turbo'"),
      'S2k 简单任务 · 快速模型两枚即存（强模型那一档没被冲掉）');
    ok(await pickSaved('#cfgSubagentPreferredProvider', 'qwen', c => c.subagentPreferredProvider === 'qwen' && c.subagentPreferredModel === '',
      "c => c.subagentPreferredProvider === 'qwen'")
      && await pickSaved('#cfgSubagentPreferredModel', 'qwen-plus', c => c.subagentPreferredModel === 'qwen-plus', "c => c.subagentPreferredModel === 'qwen-plus'"),
      'S2l 子代理两枚即存（换服务商时模型一并清空）');
    ok(await pickSaved('#cfgCompactProviderId', 'fake', c => c.compactProviderId === 'fake', "c => c.compactProviderId === 'fake'")
      && await pickSaved('#cfgCompactModel', 'fake-pro', c => c.compactProviderId === 'fake' && c.compactModel === 'fake-pro', "c => c.compactModel === 'fake-pro'"),
      'S2m 上下文压缩两枚即存（与电量表弹层写同一对键）');
    ok(await visible('#modelAssignList [data-assign="asrFix"]')
      && await pickSaved('#modelAssignList [data-assign="asrFix"] select.asr-fix-provider', 'qwen', c => c.asrFixProviderId === 'qwen', "c => c.asrFixProviderId === 'qwen'")
      && await pickSaved('#modelAssignList [data-assign="asrFix"] select.asr-fix-model', 'qwen-turbo', c => c.asrFixProviderId === 'qwen' && c.asrFixModel === 'qwen-turbo',
        "c => c.asrFixModel === 'qwen-turbo'"),
      'S2n 句尾改错那一行（运行时追加在表末）两枚即存');
    const assignRows = await ev(`[...document.querySelectorAll('#modelAssignList .model-assign-row')].map(r => r.dataset.assign)`);
    ok(JSON.stringify(assignRows) === JSON.stringify(['main', 'newThread', 'steward', 'strong', 'fast', 'subagent', 'compact', 'asrFix']),
      `S2o 表里八行、顺序固定（实见 ${JSON.stringify(assignRows)}）`);

    /* ═════════ S3 权限与安全：就地确认 ＋ 两条等待时限 ═════════ */
    await switchTab('security');
    const before = (await status()).permissionMode;
    ok(await pick('#cfgStewardDefaultPermission', 'auto'), 'S3a 在「权限与安全」页把默认权限切到「智能自动」');
    const confirmShown = await fx.waitForEval(`(() => { const box = document.getElementById('cfgStewardPermissionConfirm'); return box && !box.hidden && box.offsetParent !== null && box.closest('#stab-security') ? 1 : null; })()`, 100);
    await sleep(300);
    ok(Boolean(confirmShown) && (await status()).permissionMode === before, `S3b 确认就地展开在本页（看得见），确认前不落盘（仍是 ${before}）`);
    await ev(`(document.getElementById('cfgStewardPermissionOk').click(), true)`);
    ok(Boolean(await waitConfig(c => c.permissionMode === 'auto')), 'S3c 点「确认」后落盘 auto（带 confirm:true 过了服务端那道门）');
    ok(await pick('#cfgPermissionTimeout', '60000') && Boolean(await waitConfig(c => c.permissionTimeoutMs === 60000)), 'S3d 权限请求等多久即存（60000 ms）');
    ok(await pick('#cfgQuestionTimeout', '300000') && Boolean(await waitConfig(c => c.questionTimeoutMs === 300000)), 'S3e 提问等多久即存（300000 ms）');
    ok(await pick('#cfgPermissionTimeout', '0') && Boolean(await waitConfig(c => c.permissionTimeoutMs === 0)), 'S3f 改回「不限时」= 0');

    /* ═════════ S4 用量与限额 ═════════ */
    await switchTab('limits');
    ok(await setInput('#cfgUsageBudgetMonthly', '200') && Boolean(await waitConfig(c => c.usageBudget && c.usageBudget.monthly === 200)), 'S4a 月度预算即存');
    ok(await setInput('#cfgTurnIdleMinutes', '5') && Boolean(await waitConfig(c => c.turnIdleTimeoutMs === 300000)), 'S4b 回合看门狗（分钟）即存为 300000 ms');
    ok(await setInput('#cfgStewardMaxParallelThreads', '3') && Boolean(await waitConfig(c => c.stewardMaxParallelThreads === 3)), 'S4c 并发上限（管家那一格搬来了，仍由管家域接线）即存');

    /* ═════════ S5 缺陷①：草稿过期不再回滚 ═════════ */
    await switchTab('providers');
    ok(Boolean(await closeSettings()), 'S5a 关掉设置（草稿此前已播种过）');
    // 弹窗外的写口：直接 POST /api/config（线程头「设为新任务默认」与管家改配置都不经设置页的 saveConfigPartial）。
    const external = async mutate => {
      const disk = diskConfig();
      const providers = (disk.providers || []).map(p => ({ ...p }));
      mutate(providers);
      const r = await fx.request('POST', '/api/config', { providers });
      return Boolean(r && r.status === 200);
    };
    ok(await external(list => { const f = list.find(p => p.id === 'fake'); f.reasoningEffort = 'high'; f.model = 'fake-pro'; }),
      'S5b 弹窗外改了 fake 的推理强度与缺省模型');
    ok(Boolean(await openSettings()) && Boolean(await switchTab('providers')), 'S5c 重新打开设置、到服务商页');
    ok(await ev(`(() => { const b = document.getElementById('saveConfigBtn'); return Boolean(b) && b.disabled === true && document.getElementById('providersSaveBar').dataset.dirty === 'false'; })()`),
      'S5d 没动卡片时保存条是干净的（保存键灰着）');
    ok(await setInput('#providersList .prov-card:first-child .prov-label', 'Fake Renamed'), 'S5e 改第一张卡的名字');
    ok(await ev(`(() => { const b = document.getElementById('saveConfigBtn'); const tab = document.querySelector('#settingsTabs button[data-stab="providers"]'); return b && !b.disabled && document.getElementById('providersSaveBar').dataset.dirty === 'true' && tab.dataset.dirty === 'true'; })()`),
      'S5f 有没存的改动：保存条亮起、导航「服务商」带小圆点');
    ok(await external(list => { const q = list.find(p => p.id === 'qwen'); q.reasoningEffort = 'medium'; }), 'S5g 卡片改到一半时，弹窗外又改了 qwen 的推理强度');
    await ev(`(document.getElementById('saveConfigBtn').click(), true)`);
    const afterSave = await waitConfig(c => provider(c, 'fake').label === 'Fake Renamed');
    ok(Boolean(afterSave), 'S5h 按「保存服务商」后卡片上的改名落盘');
    const disk = diskConfig();
    const fake = provider(disk, 'fake'), qwen = provider(disk, 'qwen');
    ok(fake.reasoningEffort === 'high' && fake.model === 'fake-pro',
      `S5i 弹窗外那次改动没被旧草稿回滚（fake.reasoningEffort=${fake.reasoningEffort} model=${fake.model}）`);
    ok(qwen.reasoningEffort === 'medium' && qwen.model === 'qwen-turbo',
      `S5j 编辑期间的外部改动、以及「模型分配」主模型那一行写的 qwen-turbo 都在（qwen.reasoningEffort=${qwen.reasoningEffort} model=${qwen.model}）`);
    ok(fake.apiKey === 'k' && qwen.apiKey === 'k2', 'S5k 密钥没被掩码或空值冲掉');
    ok(Boolean(await fx.waitForEval(`(() => { const b = document.getElementById('saveConfigBtn'); const tab = document.querySelector('#settingsTabs button[data-stab="providers"]'); return b && b.disabled && document.getElementById('providersSaveBar').dataset.dirty === 'false' && !tab.dataset.dirty ? 1 : null; })()`, 100)),
      'S5l 保存之后保存条回到干净、小圆点消失');

    /* ═════════ S6 放弃改动 ═════════ */
    ok(await setInput('#providersList .prov-card:first-child .prov-label', 'Throwaway'), 'S6a 再改一次名字');
    await ev(`(document.getElementById('providersDiscardBtn').click(), true)`);
    const discarded = await fx.waitForEval(`(() => { const i = document.querySelector('#providersList .prov-card:first-child .prov-label'); return i && i.value === 'Fake Renamed' && document.getElementById('providersSaveBar').dataset.dirty === 'false' ? 1 : null; })()`, 100);
    ok(Boolean(discarded) && provider(diskConfig(), 'fake').label === 'Fake Renamed', 'S6b 「放弃改动」把卡片还原成落盘值，盘上不动');

    /* ═════════ S7 简易档 ═════════ */
    await switchTab('basic');
    ok(await pick('#cfgUiMode', 'simple') && Boolean(await waitConfig(c => c.uiMode === 'simple'))
      && Boolean(await fx.waitForEval(`document.documentElement.getAttribute('data-ui-mode') === 'simple' ? 1 : null`, 100)),
      'S7a 基础页把界面模式切成简易：即存且当场生效');
    await ev(`(() => { document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(g => g.classList.add('is-open')); return true; })()`);
    await sleep(150);
    const nav = await ev(`(() => ({
      shown: [...document.querySelectorAll('#settingsTabs button[data-stab]')].filter(b => b.offsetParent !== null && getComputedStyle(b).display !== 'none').map(b => b.dataset.stab),
      emptyGroups: [...document.querySelectorAll('#settingsTabs .settings-nav-group')].filter(g => getComputedStyle(g).display !== 'none'
        && ![...g.querySelectorAll('button[data-stab]')].some(b => b.offsetParent !== null && getComputedStyle(b).display !== 'none')).map(g => g.dataset.group),
    }))()`);
    ok(JSON.stringify(nav.shown) === JSON.stringify(SIMPLE_TABS), `S7b 简易档看得见的页签恰好 9 枚（实见 ${JSON.stringify(nav.shown)}）`);
    ok(nav.emptyGroups.length === 0, `S7c 没有空组头（实见 ${JSON.stringify(nav.emptyGroups)}）`);
    await switchTab('models');
    ok(!(await visible('#modelAssignList [data-assign="subagent"]')) && await visible('#modelAssignList [data-assign="steward"]'),
      'S7d 模型分配：子代理那一行（开发者向）收起，管家那一行照常');
    await switchTab('limits');
    ok(!(await visible('#cfgOpenaiMaxToolIterations')) && !(await visible('#settingsSecWorkflow')) && await visible('#cfgUsageBudgetMonthly'),
      'S7e 用量与限额：工具调用上限与工作流那一段收起，月度预算照常');
    await switchTab('security');
    ok(await visible('#cfgStewardDefaultPermission') && !(await visible('#settingsSecCliPermission')),
      'S7f 权限与安全：全局默认权限简易档也够得着，命令行引擎那一段收起');
    await ev(`(() => { document.querySelector('#settingsTabs button[data-stab="advanced"]').click(); return true; })()`);
    await sleep(150);
    ok((await ev(`(document.querySelector('.settings-tab.active') || {}).id || ''`)) === 'stab-basic', 'S7g 藏着的专家页签程序化点一下落回「基础」');
    await switchTab('basic');
    ok(await pick('#cfgUiMode', 'pro') && Boolean(await waitConfig(c => c.uiMode === 'pro')), 'S7h 切回专家档');

    /* ═════════ S8 干净 ═════════ */
    ok(fx.exceptions.length === 0, `S8a 页面没有未捕获异常（${fx.exceptions.slice(0, 3).join(' | ') || '无'}）`);
    ok(fx.consoleErrors.length === 0, `S8b 页面没有 console.error（${fx.consoleErrors.slice(0, 3).join(' | ') || '无'}）`);
  } catch (error) {
    fail += 1;
    console.log('FAIL 未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close();
  }
  console.log(fail === 0 ? 'SETTINGS IA BROWSER E2E: ALL PASS' : `SETTINGS IA BROWSER E2E: FAILURES ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
