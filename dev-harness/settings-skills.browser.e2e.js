#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 设置页「技能与模板」(2026-10 设置补全) 的真浏览器件。真起工作台 ＋ 无头 Chromium/Edge，每一条都回读服务端或
// localStorage 的落盘值，不信界面自己说的：
//   K1 打开设置 → 「技能与模板」页签：技能／一键任务／提示词模板三段都在，每段一个 settings-subhead（页首锚点条认的就是它）；
//   K2 技能：用户技能有删除键、内置技能没有；「常驻」开关一开即写 config.residentSkills（读 /api/status 确认），再关即摘掉；
//      「打开技能库」打开现有 #skillModal；
//   K3 删用户技能：二次确认（第一下只 arm，第二下才删），删后服务端注册表里没有了、行也没了；
//   K4 一键任务：只列用户存的（内置的只在说明里报个数）；改名 → 服务端同 id 覆盖、其它字段原样（promptTemplate 不丢）；
//      删除先弹确认、取消不删、确认才删；全删光后出空态句；
//   K5 提示词模板（localStorage wcw.templates）：列出、改名＋改内容落回 localStorage、删除先确认；注明只在这台电脑这个浏览器；
//   K6 全程页面上没有未捕获异常、没有 console.error。
// 判定行：`SETTINGS SKILLS BROWSER E2E: ALL PASS`。
const fs = require('fs');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');

const t = createRunner('SETTINGS SKILLS BROWSER');
const { ok } = t;

const USER_SKILL = 'e2e-user-skill';
const PB_A = { id: 'e2e-pb-a', title: 'E2E 周报', icon: '📝', desc: '每周五整理本周进展', inputs: [{ key: 'notes', label: '本周笔记', type: 'text' }], promptTemplate: '请根据 {notes} 写周报', requires: [], uiMode: 'both' };
const PB_B = { id: 'e2e-pb-b', title: 'E2E 归档', icon: '🗂️', desc: '', inputs: [], promptTemplate: '把下载文件夹按内容归档', requires: [], uiMode: 'both' };
const TEMPLATES = [{ name: '周报开头', text: '请帮我写本周周报，重点是……' }, { name: '翻译', text: '把下面的内容翻译成英文：\n' }];

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok,
      prefix: 'ruyi-settings-skills-',
      width: 1440,
      height: 900,
      config: { uiMode: 'pro' },
      prepare: async f => {
        const dir = path.join(f.home, 'skills', USER_SKILL);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${USER_SKILL}\ndescription: E2E 用户技能说明\n---\n\n# ${USER_SKILL}\n\nbody\n`);
        for (const pb of [PB_A, PB_B]) {
          const r = await f.request('POST', '/api/playbooks', { playbook: pb });
          ok(Boolean(r && r.status === 200), `K0 种下用户一键任务 ${pb.id}`);
        }
      },
    });
    const ev = expr => fx.evaluate(expr);
    const status = async () => { const r = await fx.request('GET', '/api/status'); return (r && r.json && r.json.config) || {}; };
    const waitFor = async (probe, tries = 150) => {
      for (let i = 0; i < tries; i++) {
        let value = null;
        try { value = await probe(); } catch { value = null; }
        if (value) return value;
        await sleep(80);
      }
      return null;
    };
    const serverPlaybooks = async () => { const r = await fx.request('GET', '/api/playbooks'); return (r && r.json && r.json.playbooks) || []; };
    const serverSkills = async () => { const r = await fx.request('GET', '/api/skills'); return (r && r.json && r.json.skills) || []; };
    const click = selector => ev(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); if (!n) return false; n.click(); return true; })()`);
    const count = selector => ev(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
    const waitCount = async (selector, want) => Boolean(await waitFor(async () => (await count(selector)) === want));
    const setValue = (selector, value) => ev(`(() => {
      const i = document.querySelector(${JSON.stringify(selector)});
      if (!i) return false;
      i.value = ${JSON.stringify(value)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const openSettings = async () => {
      await ev(`(() => { document.getElementById('openSettingsBtn').click(); return true; })()`);
      return fx.waitForEval(`(() => !document.getElementById('settingsModal').classList.contains('hidden') ? 1 : null)()`, 200);
    };
    const switchTab = async stab => {
      await ev(`(() => { document.querySelectorAll('#settingsTabs .settings-nav-group').forEach(g => g.classList.add('is-open')); const b = document.querySelector('#settingsTabs button[data-stab="${stab}"]'); if (b) b.click(); return true; })()`);
      return fx.waitForEval(`(() => { const a = document.querySelector('.settings-tab.active'); return a && a.id === 'stab-${stab}' ? 1 : null; })()`, 100);
    };
    // 确认框（confirmDanger）：点「确认」或「取消」。
    const answerConfirm = async which => {
      const shown = await fx.waitForEval(`document.querySelector('.modal-backdrop.confirm-panel [data-confirm="ok"]') ? 1 : null`, 100);
      if (!shown) return false;
      await click(`.modal-backdrop.confirm-panel [data-confirm="${which}"]`);
      return Boolean(await fx.waitForEval(`document.querySelector('.modal-backdrop.confirm-panel') ? null : 1`, 100));
    };
    const rowSel = (kind, id) => `#setskill${kind} [data-${kind === 'Skills' ? 'skill' : (kind === 'Playbooks' ? 'playbook' : 'template')}-id="${id}"]`;

    /* ═════════ K1 三段都在 ═════════ */
    ok(Boolean(await openSettings()), 'K1a 设置弹窗打开了');
    ok(Boolean(await switchTab('skills')), 'K1b 点「技能与模板」页签切过去了');
    for (const [id, name] of [['setskillSkills', '技能'], ['setskillPlaybooks', '一键任务'], ['setskillTemplates', '提示词模板']]) {
      const info = await ev(`(() => { const s = document.getElementById(${JSON.stringify(id)}); const h = s && s.querySelector('h4.settings-subhead'); return s ? { section: s.matches('section.settings-section'), head: h ? h.textContent.trim() : '' } : null; })()`);
      ok(Boolean(info) && info.section && info.head.length > 0, `K1c「${name}」段在，是 section.settings-section 且有 h4.settings-subhead（实见 ${JSON.stringify(info)}）`);
    }
    ok(await waitCount('#setskillPlaybooks .setskill-row', 2), 'K1d 一键任务段列出了两条用户一键任务');
    const spill = await ev(`(() => { const t = document.getElementById('stab-skills').innerText; return /\\{\\{|settings\\.skills\\./.test(t) ? t.slice(0, 120) : ''; })()`);
    ok(spill === '', `K1e 页面上没有漏出的 i18n 键或未替换的占位（${spill || '干净'}）`);

    /* ═════════ K2 技能：删除键与常驻开关 ═════════ */
    const userRow = rowSel('Skills', USER_SKILL);
    ok(await waitFor(async () => (await count(userRow)) === 1), 'K2a 技能段列出了用户技能');
    ok(await ev(`Boolean(document.querySelector(${JSON.stringify(userRow + ' .setskill-del')}))`), 'K2b 用户技能有「删除」键');
    const nonUserDel = await ev(`(() => {
      const rows = [...document.querySelectorAll('#setskillSkills .setskill-row[data-skill-id]')].filter(r => r.dataset.skillId !== ${JSON.stringify(USER_SKILL)});
      return { rows: rows.length, withDelete: rows.filter(r => r.querySelector('.setskill-del')).length };
    })()`);
    ok(nonUserDel.rows > 0 && nonUserDel.withDelete === 0, `K2c 其余（内置）技能没有删除键（${nonUserDel.rows} 行，带删除键 ${nonUserDel.withDelete}）`);
    const residentBefore = ((await status()).residentSkills || []).length;
    ok(await ev(`Boolean(document.querySelector(${JSON.stringify(userRow + ' .setskill-switch[role="switch"]')}))`), 'K2d 每行有 role=switch 的「常驻」开关');
    await click(userRow + ' .setskill-switch');
    const resident = await waitFor(async () => {
      const list = (await status()).residentSkills || [];
      return list.some(x => (typeof x === 'string' ? x : x && x.id) === USER_SKILL) ? list : null;
    });
    ok(Boolean(resident) && resident.length === residentBefore + 1, `K2e 打开「常驻」→ residentSkills 落盘（${residentBefore} → ${resident ? resident.length : '没落盘'}）`);
    ok(await waitFor(() => ev(`document.querySelector(${JSON.stringify(userRow + ' .setskill-switch')}).checked === true && document.querySelector('#setskillSkills .setskill-count').textContent.includes('${residentBefore + 1} / 8') ? 1 : null`)),
      'K2f 开关回显为开，并且「已常驻 n / 8 个」跟着变');
    await click(userRow + ' .setskill-switch');
    ok(Boolean(await waitFor(async () => !((await status()).residentSkills || []).some(x => (typeof x === 'string' ? x : x && x.id) === USER_SKILL))), 'K2g 关掉「常驻」→ 从 residentSkills 摘掉');
    await click('#setskillSkills .setskill-open-library');
    ok(Boolean(await fx.waitForEval(`!document.getElementById('skillModal').classList.contains('hidden') ? 1 : null`, 100)), 'K2h「打开技能库」打开了现有 #skillModal');
    await ev(`(() => { const m = document.getElementById('skillModal'); const c = m.querySelector('[data-close-modal]'); if (c) c.click(); return true; })()`);
    await fx.waitForEval(`document.getElementById('skillModal').classList.contains('hidden') ? 1 : null`, 100);

    /* ═════════ K3 删用户技能：二次确认 ═════════ */
    await click(userRow + ' .setskill-del');
    ok(Boolean(await fx.waitForEval(`document.querySelector('.skill-delete-confirm') ? 1 : null`, 100)), 'K3a 点「删除」弹出确认框（沿用技能库那一份确认件）');
    await click('.modal-foot-row button.danger');
    ok(Boolean(await fx.waitForEval(`document.querySelector('.modal-foot-row button.danger.armed') ? 1 : null`, 50)), 'K3b 第一下点确认只是 arm（按钮变成「再次点击确认删除」）');
    ok((await serverSkills()).some(s => s.id === USER_SKILL), 'K3c arm 之后技能还在服务端');
    await click('.modal-foot-row button.danger');
    ok(Boolean(await waitFor(async () => !(await serverSkills()).some(s => s.id === USER_SKILL))), 'K3d 第二下才真删：服务端注册表里没有这个技能了');
    ok(!fs.existsSync(path.join(fx.home, 'skills', USER_SKILL)), 'K3e 技能目录也从磁盘上没了');
    ok(await waitCount(userRow, 0), 'K3f 设置页里那一行没了');
    ok(!(await ev(`!document.getElementById('skillModal').classList.contains('hidden')`)), 'K3g 删完没有顺手把技能库弹窗打开');

    /* ═════════ K4 一键任务：改名、删除 ═════════ */
    const aRow = rowSel('Playbooks', PB_A.id);
    const bRow = rowSel('Playbooks', PB_B.id);
    const builtinCount = (await serverPlaybooks()).filter(p => p.builtin === true).length;
    ok(builtinCount === 0 || await ev(`Boolean(document.querySelector('#setskillPlaybooks .setskill-note'))`), `K4a 内置一键任务（${builtinCount} 个）不列成行，只在说明里报个数`);
    ok(await ev(`document.querySelectorAll('#setskillPlaybooks .setskill-row').length`) === 2, 'K4b 行里只有用户的两条');
    await click(aRow + ' .setskill-rename');
    ok(Boolean(await fx.waitForEval(`document.querySelector(${JSON.stringify(aRow + ' input.setskill-input')}) ? 1 : null`, 100)), 'K4c 点「改名」后该行变成输入框');
    ok(await ev(`document.querySelector(${JSON.stringify(aRow + ' input.setskill-input')}).value`) === PB_A.title, 'K4d 输入框里是当前名字');
    await setValue(aRow + ' input.setskill-input', '   ');
    await click(aRow + ' .setskill-save');
    await sleep(300);
    ok((await serverPlaybooks()).find(p => p.id === PB_A.id).title === PB_A.title, 'K4e 空名字不会存（服务端名字没变）');
    await setValue(aRow + ' input.setskill-input', 'E2E 周报（新）');
    await click(aRow + ' .setskill-save');
    const renamed = await waitFor(async () => (await serverPlaybooks()).find(p => p.id === PB_A.id && p.title === 'E2E 周报（新）'));
    ok(Boolean(renamed), 'K4f 改名后服务端同 id 的 title 变了');
    ok(Boolean(renamed) && renamed.promptTemplate === PB_A.promptTemplate && renamed.desc === PB_A.desc && JSON.stringify(renamed.inputs) === JSON.stringify(PB_A.inputs) && renamed.icon === PB_A.icon,
      'K4g 改名没碰其它字段（promptTemplate/desc/inputs/icon 原样）');
    ok(Boolean(await fx.waitForEval(`(() => { const n = document.querySelector(${JSON.stringify(aRow + ' .setskill-title')}); return n && n.textContent === 'E2E 周报（新）' ? 1 : null; })()`, 100)), 'K4h 页面上那一行显示新名字');
    ok((await serverPlaybooks()).filter(p => p.id === PB_A.id).length === 1, 'K4i 同 id 覆盖，没有多出一条');
    // 删除：先取消，再确认
    await click(aRow + ' .setskill-del');
    ok(await answerConfirm('cancel'), 'K4j 点「删除」弹出确认框，点取消');
    await sleep(200);
    ok((await serverPlaybooks()).some(p => p.id === PB_A.id), 'K4k 取消 → 一键任务还在服务端');
    await click(aRow + ' .setskill-del');
    ok(await answerConfirm('ok'), 'K4l 再点「删除」，这次确认');
    ok(Boolean(await waitFor(async () => !(await serverPlaybooks()).some(p => p.id === PB_A.id))), 'K4m 确认后服务端读不到这条了');
    ok(await waitCount(aRow, 0), 'K4n 页面上那一行没了');
    ok((await serverPlaybooks()).some(p => p.id === PB_B.id), 'K4o 另一条没被连带删掉');
    await click(bRow + ' .setskill-del');
    ok(await answerConfirm('ok'), 'K4p 删最后一条');
    ok(Boolean(await waitFor(async () => !(await serverPlaybooks()).some(p => p.id === PB_B.id))), 'K4q 服务端也没了');
    ok(Boolean(await waitFor(() => ev(`(() => { const p = document.querySelector('#setskillPlaybooks p.setcat-empty.muted'); return p && p.textContent.trim().length > 0 ? 1 : null; })()`))), 'K4r 用户一键任务删光后出空态句（p.setcat-empty.muted）');
    ok((await serverPlaybooks()).filter(p => p.builtin !== true).length === 0, 'K4s 服务端用户一键任务确实是零');

    /* ═════════ K5 提示词模板 ═════════ */
    const readTemplates = () => ev(`JSON.parse(localStorage.getItem('wcw.templates') || '[]')`);
    await ev(`(() => { localStorage.setItem('wcw.templates', ${JSON.stringify(JSON.stringify(TEMPLATES))}); return true; })()`);
    await switchTab('doctor');
    ok(Boolean(await switchTab('skills')), 'K5a 切走再切回「技能与模板」页签（模板每次进来重读）');
    ok(await waitCount('#setskillTemplates .setskill-row', 2), 'K5b 模板段列出了两条');
    ok(await ev(`(() => { const n = document.querySelector('#setskillTemplates .setskill-local'); return Boolean(n) && /浏览器/.test(n.textContent); })()`), 'K5c 注明了只保存在这台电脑的这个浏览器里');
    const t0 = '#setskillTemplates [data-template-index="0"]';
    await click(t0 + ' .setskill-edit-btn');
    ok(Boolean(await fx.waitForEval(`document.querySelector(${JSON.stringify(t0 + ' .setskill-tpl-text')}) ? 1 : null`, 100)), 'K5d 点「编辑」后该行变成名称输入框＋内容文本框');
    await setValue(t0 + ' .setskill-tpl-name', '');
    await click(t0 + ' .setskill-save');
    await sleep(200);
    ok((await readTemplates())[0].name === TEMPLATES[0].name, 'K5e 名称留空不会存');
    await setValue(t0 + ' .setskill-tpl-name', '新周报开头');
    await setValue(t0 + ' .setskill-tpl-text', '新的内容\n第二行');
    await click(t0 + ' .setskill-save');
    const saved = await waitFor(async () => { const list = await readTemplates(); return list[0] && list[0].name === '新周报开头' ? list : null; });
    ok(Boolean(saved) && saved[0].text === '新的内容\n第二行' && saved.length === 2 && saved[1].name === '翻译', 'K5f 改名＋改内容落回 localStorage，另一条没动');
    ok(Boolean(await fx.waitForEval(`(() => { const n = document.querySelector(${JSON.stringify(t0 + ' .setskill-title')}); return n && n.textContent === '新周报开头' ? 1 : null; })()`, 100)), 'K5g 页面上显示新名字');
    await click(t0 + ' .setskill-del');
    ok(await answerConfirm('cancel'), 'K5h 删除先弹确认，点取消');
    ok((await readTemplates()).length === 2, 'K5i 取消 → 两条都在');
    await click(t0 + ' .setskill-del');
    ok(await answerConfirm('ok'), 'K5j 再删，这次确认');
    const after = await waitFor(async () => { const list = await readTemplates(); return list.length === 1 ? list : null; });
    ok(Boolean(after) && after[0].name === '翻译', 'K5k localStorage 里只剩「翻译」');
    ok(await waitCount('#setskillTemplates .setskill-row', 1), 'K5l 页面上只剩一行');
    const lastRow = '#setskillTemplates [data-template-index="0"]';
    await click(lastRow + ' .setskill-del');
    ok(await answerConfirm('ok'), 'K5n 把最后一条也删了');
    ok(Boolean(await waitFor(() => ev(`(() => { const p = document.querySelector('#setskillTemplates p.setcat-empty.muted'); return p && p.textContent.trim().length > 0 ? 1 : null; })()`))), 'K5o 模板删光后出空态句（p.setcat-empty.muted）');

    /* ═════════ K6 干净 ═════════ */
    ok(fx.exceptions.length === 0, `K6a 页面没有未捕获异常（${fx.exceptions.slice(0, 3).join(' | ') || '无'}）`);
    ok(fx.consoleErrors.length === 0, `K6b 页面没有 console.error（${fx.consoleErrors.slice(0, 3).join(' | ') || '无'}）`);
  } catch (error) {
    t.fail('未捕获异常:' + (error && error.stack || error));
  } finally {
    if (fx) await fx.close();
  }
  t.done({ exit: true });
})();
