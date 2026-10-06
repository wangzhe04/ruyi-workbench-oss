#!/usr/bin/env node
'use strict';
require('./lib/self-isolate-home.js'); // 直跑时家目录自隔离(见 lib 头注)
// 浏览器 e2e(记忆走查「A:作用域与写入路径」的界面半边)。真服务 + 假 provider + 无头浏览器,走用户真正看到的那条路:
//   S1 模型填 global、用户没说跨项目:单条候选卡上看得见作用域(下拉)与「AI 建议:全局 · 已按保守原则改为项目」;
//   S2 刷新页面:服务端仍待确认的候选卡被画回来(一张,不重复);切到别的线程再切回来仍只有一张;
//   S3 用户在卡上改回「全局」→ 说明换成「已按你的选择」;「查看并保存」弹窗里的范围就是卡上选的;保存 → 落全局目录、卡收起、刷新后不再出现;
//   S4 批量卡:每一条都有作用域下拉 + 「将加入核心(每轮注入)」开关 + 正文字数;被降级的那条有说明;刷新后同样画回来;
//      用户改一条的范围、关一条的核心、取消一条 → 保存只写勾上的、范围与核心如用户所选;
//   S5 revise 卡的作用域标签读 targetScope(修前恒为「项目」):全局记忆的修订卡写「全局」;确认后摘要随说明更新;
//   S6 revise 带 newScope:卡上写「项目 → 全局」与移动说明,确认后真的挪到全局;
//   S7 记忆工具箱「编辑」弹窗:范围下拉可改(修前灰的),改了会出提示;说明改了,核心摘要框跟着改;保存 → 另存到全局 + 删旧;
//   S8 记忆面板里的「每轮最多补充 N 条」读配置(修前文案写死 3);
//   X  页面没有未捕获异常;
//   E  英文界面(第二个夹具,config.locale=en-US):单条卡 / 批量卡 / 面板提示 / 过期修订的报错,界面文字(模型给的名称、说明、原因、正文除外)零中文。
const fs = require('fs');
const path = require('path');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const { createRunner } = require('./lib/harness');

const t = createRunner('MEMORY SCOPE CARD BROWSER');
const { ok } = t;

const SEED = { global: 'seed-global', up: 'seed-up', edit: 'seed-edit', stale: 'seed-stale' };
const BATCH = [
  { name: '提交信息用中文 kqbc1vale kqbc1mirt', description: 'when editing kqbc1sorn kqbc1pelt', type: 'convention', scope: 'global', body: '提交信息一律用中文写清楚改了什么。', reason: '用户明确要求' },
  { name: '测试收尾只杀自己的进程树 kqbc2vale kqbc2mirt', description: 'when editing kqbc2sorn kqbc2pelt', type: 'lesson', scope: 'project', body: '用 killOwnTree,不要 taskkill /T。', reason: '撞号误杀踩过坑' },
  { name: '路径按 Windows 形取文件名 kqbc3vale kqbc3mirt', description: 'when editing kqbc3sorn kqbc3pelt', type: 'convention', scope: 'project', body: '取文件名用 path.win32.basename。', reason: 'Windows 是一等目标' },
];
const listMd = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter(f => f.endsWith('.md')).map(f => path.join(dir, f)) : []);
const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const fmField = (file, key) => { const m = new RegExp('^' + key + ': ?(.*)$', 'm').exec(readText(file)); return m ? m[1].trim() : ''; };

const providerScript = async ctx => {
    const lastUser = [...ctx.messages].reverse().find(m => m && m.role === 'user');
    const text = typeof (lastUser && lastUser.content) === 'string' ? lastUser.content : JSON.stringify(lastUser && lastUser.content);
    const tag = (/\[(DOWN|BATCH|REVG|REVUP|REVSTALE)\]/.exec(text) || [])[1] || '';
    const offered = name => (ctx.body.tools || []).some(x => x && x.function && x.function.name === name);
    if (!ctx.answered && tag === 'DOWN' && offered('workbench_memory_propose')) ctx.toolCall('workbench_memory_propose', { name: '提交信息用中文 kqbdown', description: '写提交信息时适用 kqbdown', type: 'convention', scope: 'global', body: '提交信息一律用中文写。', reason: '用户要求' }, 'call_down');
    else if (!ctx.answered && tag === 'BATCH' && offered('workbench_memory_propose')) ctx.toolCall('workbench_memory_propose', { items: BATCH }, 'call_batch');
    else if (!ctx.answered && tag === 'REVG' && offered('workbench_memory_revise')) ctx.toolCall('workbench_memory_revise', { id: SEED.global, scope: 'global', description: 'REVG-NEW 新的说明', reason: '更准确' }, 'call_revg');
    else if (!ctx.answered && tag === 'REVUP' && offered('workbench_memory_revise')) ctx.toolCall('workbench_memory_revise', { id: SEED.up, scope: 'project', newScope: 'global', reason: '用户说所有项目都适用' }, 'call_revup');
    else if (!ctx.answered && tag === 'REVSTALE' && offered('workbench_memory_revise')) ctx.toolCall('workbench_memory_revise', { id: SEED.stale, scope: 'project', description: 'AI suggested new description', reason: 'outdated' }, 'call_revstale');
    else ctx.text('好的。');
    ctx.stop();
  };

(async () => {
  let fx = null;
  try {
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-memory-scope-card-', width: 1280, height: 900,
      config: { permissionMode: 'bypass', stewardEnabledV1: false, memoryRelevanceMaxV1: 5 },
      provider: providerScript,
    });
    const ev = expr => fx.evaluate(expr);
    const wait = (expr, n = 800) => fx.waitForEval(expr, n);
    const gdir = path.join(fx.home, 'memory', 'global');
    const pdir = path.join(fx.home, 'memory', 'project');
    const seed = async (memory) => fx.request('POST', '/api/memory', { memory, cwd: fx.work });
    await seed({ id: SEED.global, scope: 'global', type: 'preference', name: 'kq seed-global', description: 'SEEDG-OLD 旧的说明', body: 'seed global body', core: true });
    await seed({ id: SEED.up, scope: 'project', type: 'convention', name: 'kq seed-up', description: 'SEEDUP desc', body: 'seed up body', core: true });
    await seed({ id: SEED.edit, scope: 'project', type: 'convention', name: 'kq seed-edit', description: 'EDITDESC-1', body: 'seed edit body', core: true });

    await ev(`(() => { try { localStorage.setItem('wcw.shellMode', 'classic'); } catch (e) {} location.reload(); return true; })()`);
    await sleep(600);
    ok(Boolean(await wait(`(() => document.getElementById('promptInput') && document.getElementById('newSessionBtn') ? 1 : null)()`, 600)), 'C0 经典壳就绪');
    const sendTurn = async message => {
      await ev(`(() => { document.getElementById('newSessionBtn').click(); return true; })()`);
      await wait(`(window.state && window.state.currentSession && window.state.currentSession.id && !window.state.currentSession.messages.length) ? 1 : null`, 400);
      await ev(`(() => {
        window.__toasts = [];
        const tray = document.getElementById('toastTray');
        if (tray && !window.__toastObs) { window.__toastObs = new MutationObserver(list => { for (const m of list) for (const n of m.addedNodes) window.__toasts.push(String(n.textContent || '')); }); window.__toastObs.observe(tray, { childList: true }); }
        const input = document.getElementById('promptInput');
        input.value = ${JSON.stringify(message)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('sendBtn').click();
        return true;
      })()`);
      return wait(`(window.state.currentSession && window.state.currentSession.id) || null`, 200);
    };
    const cardInfo = `(() => {
      const cards = [...document.querySelectorAll('#messages .memory-proposal-card')];
      const c = cards[cards.length - 1];
      if (!c) return null;
      const sel = c.querySelector('select.memory-proposal-scope');
      const note = c.querySelector('.memory-proposal-scope-note');
      return { cards: cards.length, id: c.dataset.proposalId || '', scope: sel ? sel.value : '', note: note && !note.hidden ? note.textContent : '',
        kicker: (c.querySelector('.memory-proposal-kicker') || {}).textContent || '', tags: [...c.querySelectorAll('.memory-proposal-tag')].map(x => x.textContent) };
    })()`;

    // S1
    const sidA = await sendTurn('记住:提交信息用中文写 [DOWN]');
    const s1 = await wait(cardInfo, 1200);
    ok(s1 && s1.cards === 1 && s1.scope === 'project' && /AI 建议：全局/.test(s1.note) && /已按保守原则改为项目/.test(s1.note),
      `S1 单条卡上看得见作用域(下拉=项目)与「AI 建议:全局 · 已按保守原则改为项目」(got ${JSON.stringify(s1)})`);
    const proposalIdA = s1 && s1.id;

    // S2 刷新 → 画回来;切走再切回仍一张
    await ev(`location.reload()`);
    await sleep(600);
    const s2 = await wait(`(() => { const c = window.state && window.state.currentSession && window.state.currentSession.id ? ${cardInfo} : null; return c; })()`, 1500);
    ok(s2 && s2.cards === 1 && s2.id === proposalIdA && s2.scope === 'project' && /AI 建议：全局/.test(s2.note),
      `S2 刷新页面后,服务端仍待确认的候选卡被画回来(同一个 proposalId、同样的说明)(got ${JSON.stringify(s2)})`);
    await ev(`(() => { document.getElementById('newSessionBtn').click(); return true; })()`);
    await wait(`(window.state.currentSession && window.state.currentSession.id !== ${JSON.stringify(sidA)}) ? 1 : null`, 300);
    await ev(`(() => { const row = document.querySelector('#railList [data-session-id=${JSON.stringify(sidA)}]'); if (!row) return false; (row.querySelector('button, a') || row).click(); return true; })()`);
    await wait(`(window.state.currentSession && window.state.currentSession.id === ${JSON.stringify(sidA)}) ? 1 : null`, 300);
    await sleep(700);
    const s2b = await ev(cardInfo);
    ok(s2b && s2b.cards === 1 && s2b.id === proposalIdA, `S2b 切到别的线程再切回来,仍只有一张卡(got ${JSON.stringify(s2b)})`);

    // S3 卡上改回全局 → 弹窗范围一致 → 保存
    await ev(`(() => { const sel = document.querySelector('#messages .memory-proposal-card select.memory-proposal-scope'); sel.value = 'global'; sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const s3 = await ev(cardInfo);
    ok(s3 && s3.scope === 'global' && /已按你的选择使用全局/.test(s3.note), `S3 在卡上改回「全局」→ 说明换成「已按你的选择」(got ${JSON.stringify(s3)})`);
    await ev(`(() => { document.querySelector('#messages .memory-proposal-card .memory-proposal-actions button.primary').click(); return true; })()`);
    const modalScope = await wait(`(() => {
      const modal = document.querySelector('.modal-backdrop.dynamic');
      if (!modal) return null;
      const fields = [...modal.querySelectorAll('.pb-field')];
      const sel = fields[3] && fields[3].querySelector('select');
      return sel ? { scope: sel.value, disabled: sel.disabled } : null;
    })()`, 300);
    ok(modalScope && modalScope.scope === 'global' && modalScope.disabled === false, `S3b 「查看并保存」弹窗里的范围就是卡上选的(got ${JSON.stringify(modalScope)})`);
    await ev(`(() => { const modal = document.querySelector('.modal-backdrop.dynamic'); [...modal.querySelectorAll('button')].find(b => b.classList.contains('primary')).click(); return true; })()`);
    const gone = await wait(`(() => document.querySelector('#messages .memory-proposal-card') ? null : 1)()`, 300);
    ok(Boolean(gone), 'S3c 保存后卡片收起');
    ok(listMd(gdir).some(f => /kqbdown/.test(readText(f))) && !listMd(pdir).some(f => /kqbdown/.test(readText(f))), 'S3d 落在全局目录、项目目录里没有');
    await ev(`location.reload()`);
    await sleep(1500);
    ok((await ev(`document.querySelectorAll('#messages .memory-proposal-card').length`)) === 0, 'S3e 刷新后不再出现(候选已 settle)');

    // S4 批量卡
    const sidB = await sendTurn('把这三条记下来 [BATCH]');
    const batchInfo = `(() => {
      const c = document.querySelector('#messages .memory-proposal-batch');
      if (!c) return null;
      const rows = [...c.querySelectorAll('.memory-proposal-item')];
      return { cards: document.querySelectorAll('#messages .memory-proposal-card').length, id: c.dataset.proposalId || '',
        scopes: rows.map(r => (r.querySelector('select.memory-proposal-scope') || {}).value),
        notes: rows.map(r => { const n = r.querySelector('.memory-proposal-scope-note'); return n && !n.hidden ? n.textContent : ''; }),
        core: rows.map(r => (r.querySelector('button.memory-proposal-core') || {}).getAttribute && r.querySelector('button.memory-proposal-core').getAttribute('aria-pressed')),
        coreText: rows.map(r => (r.querySelector('button.memory-proposal-core') || {}).textContent),
        body: rows.map(r => (r.querySelector('details > summary') || {}).textContent),
        checks: [...c.querySelectorAll('input[type="checkbox"]')].map(b => b.checked) };
    })()`;
    const s4 = await wait(batchInfo, 1200);
    ok(s4 && s4.cards === 1 && s4.scopes.join() === 'project,project,project' && /AI 建议：全局/.test(s4.notes[0]) && s4.notes[1] === '' && s4.notes[2] === '',
      `S4 批量卡每一条都有作用域下拉;被降级的第 0 条有「AI 建议:全局」说明(got ${JSON.stringify(s4 && { scopes: s4.scopes, notes: s4.notes })})`);
    ok(s4 && s4.core.join() === 'true,false,true' && /将加入核心/.test(s4.coreText[0]) && /不加入核心/.test(s4.coreText[1]),
      `S4b 每条显示「将加入核心(每轮注入)」开关,默认与单条弹窗一致(偏好/惯例开、教训关)(got ${JSON.stringify(s4 && s4.coreText)})`);
    ok(s4 && s4.body.every((x, i) => x.includes(String(BATCH[i].body.length))) && s4.checks.length === 3 && s4.checks.every(Boolean), `S4c 正文折叠标题带字数;默认仍全勾(got ${JSON.stringify(s4 && s4.body)})`);
    await ev(`location.reload()`);
    await sleep(600);
    const s4r = await wait(`(window.state && window.state.currentSession && window.state.currentSession.id ? ${batchInfo} : null)`, 1500);
    ok(s4r && s4r.cards === 1 && s4r.id === s4.id && s4r.scopes.length === 3, `S4d 刷新后批量卡同样画回来(一张、三行)(got ${JSON.stringify(s4r && { cards: s4r.cards, n: s4r.scopes.length })})`);
    await ev(`(() => {
      const rows = [...document.querySelectorAll('#messages .memory-proposal-batch .memory-proposal-item')];
      const sel = rows[0].querySelector('select.memory-proposal-scope'); sel.value = 'global'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      rows[2].querySelector('button.memory-proposal-core').click();
      rows[1].querySelector('input[type="checkbox"]').click();
      return true;
    })()`);
    const s4e = await ev(batchInfo);
    ok(s4e && s4e.scopes[0] === 'global' && /已按你的选择使用全局/.test(s4e.notes[0]) && s4e.core[2] === 'false' && s4e.checks.join() === 'true,false,true', `S4e 改了第 0 条的范围、关了第 2 条的核心、取消了第 1 条(got ${JSON.stringify(s4e && { scopes: s4e.scopes, core: s4e.core, checks: s4e.checks })})`);
    await ev(`(() => { document.querySelector('#messages .memory-proposal-batch .memory-proposal-actions button.primary').click(); return true; })()`);
    await wait(`(() => document.querySelector('#messages .memory-proposal-card') ? null : 1)()`, 400);
    const f0 = listMd(gdir).find(f => /kqbc1vale/.test(readText(f)));
    const f2 = listMd(pdir).find(f => /kqbc3vale/.test(readText(f)));
    ok(Boolean(f0) && fmField(f0, 'core') === 'true' && Boolean(f2) && fmField(f2, 'core') === 'false' && !listMd(gdir).concat(listMd(pdir)).some(f => /kqbc2vale/.test(readText(f))),
      `S4f 落盘如用户所选:第 0 条在全局且进核心,第 2 条在项目且不进核心,第 1 条(取消)没写(f0=${Boolean(f0)} f2=${Boolean(f2)})`);
    void sidB;

    // S5 revise 全局记忆:标签读 targetScope
    const sidC = await sendTurn('请修订记忆:seed-global 的说明改一下 [REVG]');
    const s5 = await wait(cardInfo, 1200);
    ok(s5 && /修改记忆建议/.test(s5.kicker) && s5.tags.includes('全局') && !s5.tags.includes('项目'), `S5 全局记忆的修订卡作用域标签写「全局」(修前恒为「项目」)(got ${JSON.stringify(s5)})`);
    await ev(`(() => { document.querySelector('#messages .memory-proposal-card .memory-proposal-actions button.primary').click(); return true; })()`);
    await wait(`(() => document.querySelector('#messages .memory-proposal-card') ? null : 1)()`, 400);
    const seedG = await fx.request('GET', `/api/memory/item?id=${SEED.global}&scope=global&cwd=${encodeURIComponent(fx.work)}`);
    ok(seedG && seedG.json && seedG.json.memory && seedG.json.memory.description === 'REVG-NEW 新的说明' && seedG.json.memory.coreSummary === 'REVG-NEW 新的说明',
      `S5b 确认后核心摘要随说明更新(修前仍是旧摘要)(got ${JSON.stringify(seedG && seedG.json && seedG.json.memory && [seedG.json.memory.description, seedG.json.memory.coreSummary])})`);
    void sidC;

    // S6 revise 升全局
    await sendTurn('请修订记忆:seed-up 升成全局,它对所有项目都适用 [REVUP]');
    const s6 = await wait(cardInfo, 1200);
    const s6note = await ev(`(() => { const n = document.querySelector('#messages .memory-proposal-card .memory-proposal-scope-note'); return n ? n.textContent : ''; })()`);
    ok(s6 && s6.tags.some(x => x === '项目 → 全局') && /从「项目」移到「全局」/.test(s6note), `S6 revise 带 newScope:标签「项目 → 全局」与移动说明(got ${JSON.stringify(s6)} / ${s6note})`);
    await ev(`(() => { document.querySelector('#messages .memory-proposal-card .memory-proposal-actions button.primary').click(); return true; })()`);
    await wait(`(() => document.querySelector('#messages .memory-proposal-card') ? null : 1)()`, 400);
    ok(listMd(gdir).some(f => path.basename(f) === SEED.up + '.md') && !listMd(pdir).some(f => path.basename(f) === SEED.up + '.md'), 'S6b 确认后记忆真的挪到了全局目录');

    // S7 编辑弹窗换作用域
    await ev(`(() => { document.querySelector('.tool-pane .tool-tabs button[data-tab="memory"]').click(); return true; })()`);
    const toolCard = await wait(`(() => {
      const card = [...document.querySelectorAll('#memoryToolboxList .memory-card')].find(c => /kq seed-edit/.test(c.textContent));
      return card ? true : null;
    })()`, 600);
    ok(Boolean(toolCard), 'S7 记忆工具箱里有 seed-edit');
    await ev(`(() => { const card = [...document.querySelectorAll('#memoryToolboxList .memory-card')].find(c => /kq seed-edit/.test(c.textContent)); [...card.querySelectorAll('button')].find(b => b.textContent === '编辑').click(); return true; })()`);
    const edit0 = await wait(`(() => {
      const modal = document.querySelector('.modal-backdrop.dynamic');
      if (!modal) return null;
      const fields = [...modal.querySelectorAll('.pb-field')];
      const sel = fields[3] && fields[3].querySelector('select');
      const hint = modal.querySelector('.pb-field .field-help');
      return sel && fields[4] ? { scope: sel.value, disabled: sel.disabled, summary: fields[4].querySelector('textarea').value, hintHidden: hint ? hint.hidden : null } : null;
    })()`, 600);
    ok(edit0 && edit0.scope === 'project' && edit0.disabled === false && edit0.summary === 'EDITDESC-1' && edit0.hintHidden === true, `S7b 编辑已有记忆时范围下拉可改(修前灰的),未改时没有提示(got ${JSON.stringify(edit0)})`);
    await ev(`(() => {
      const modal = document.querySelector('.modal-backdrop.dynamic');
      const fields = [...modal.querySelectorAll('.pb-field')];
      const sel = fields[3].querySelector('select'); sel.value = 'global'; sel.dispatchEvent(new Event('change', { bubbles: true }));
      const desc = fields[1].querySelector('textarea'); desc.value = 'EDITDESC-2 改过的说明'; desc.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const edit1 = await ev(`(() => {
      const modal = document.querySelector('.modal-backdrop.dynamic');
      const fields = [...modal.querySelectorAll('.pb-field')];
      const hint = fields[3].querySelector('.field-help');
      return { summary: fields[4].querySelector('textarea').value, hintHidden: hint ? hint.hidden : null, hint: hint ? hint.textContent : '' };
    })()`);
    ok(edit1 && edit1.summary === 'EDITDESC-2 改过的说明' && edit1.hintHidden === false && /移到新的范围/.test(edit1.hint), `S7c 改了说明,核心摘要框跟着改;改了范围出现移动提示(got ${JSON.stringify(edit1)})`);
    await ev(`(() => { const modal = document.querySelector('.modal-backdrop.dynamic'); [...modal.querySelectorAll('button')].find(b => b.classList.contains('primary')).click(); return true; })()`);
    await wait(`(() => document.querySelector('.modal-backdrop.dynamic') ? null : 1)()`, 400);
    const ge = listMd(gdir).find(f => path.basename(f) === SEED.edit + '.md');
    ok(Boolean(ge) && !listMd(pdir).some(f => path.basename(f) === SEED.edit + '.md') && fmField(ge, 'coreSummary') === 'EDITDESC-2 改过的说明' && fmField(ge, 'description') === 'EDITDESC-2 改过的说明',
      `S7d 保存 → 另存到全局 + 删旧;摘要与说明一致(ge=${Boolean(ge)} summary=${ge && fmField(ge, 'coreSummary')})`);

    // S8 面板里的上限读配置
    await ev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true; })()`);
    await sleep(300);
    await ev(`(() => { const item = [...document.querySelectorAll('#paletteList .palette-item')].find(i => /工作台记忆/.test(i.textContent)); if (item) item.click(); return Boolean(item); })()`);
    const hint = await wait(`(() => { const h = document.querySelector('#memoryList .memory-hint'); return h && h.textContent ? h.textContent : null; })()`, 400);
    ok(typeof hint === 'string' && /每轮最多补充 5 条/.test(hint) && !/3 条/.test(hint), `S8 记忆面板的「每轮最多补充 N 条」读配置(设置里是 5)(got ${JSON.stringify(hint)})`);

    ok(fx.exceptions.length === 0, `X 页面没有未捕获异常(${fx.exceptions.join(' | ')})`);
    await fx.close(); fx = null;

    // ═════════ E 英文界面(第二个夹具:config.locale=en-US)═════════
    const cjk = value => typeof value === 'string' && /[一-鿿]/.test(value);
    fx = await startBrowserFixture({
      ok, prefix: 'ruyi-memory-scope-card-en-', width: 1280, height: 900,
      config: { permissionMode: 'bypass', stewardEnabledV1: false, memoryRelevanceMaxV1: 5, locale: 'en-US' },
      provider: providerScript,
    });
    const eev = expr => fx.evaluate(expr);
    const ewait = (expr, n = 800) => fx.waitForEval(expr, n);
    await fx.request('POST', '/api/memory', { memory: { id: SEED.stale, scope: 'project', type: 'convention', name: 'kq seed-stale', description: 'STALE-OLD description', body: 'seed stale body' }, cwd: fx.work });
    await eev(`(() => { try { localStorage.setItem('wcw.shellMode', 'classic'); } catch (e) {} location.reload(); return true; })()`);
    await sleep(600);
    await ewait(`(() => document.documentElement.lang === 'en-US' && document.getElementById('promptInput') && document.getElementById('newSessionBtn') ? 1 : null)()`, 800);
    const esend = async message => {
      await eev(`(() => { document.getElementById('newSessionBtn').click(); return true; })()`);
      await ewait(`(window.state && window.state.currentSession && window.state.currentSession.id && !window.state.currentSession.messages.length) ? 1 : null`, 400);
      await eev(`(() => { const input = document.getElementById('promptInput'); input.value = ${JSON.stringify(message)}; input.dispatchEvent(new Event('input', { bubbles: true })); document.getElementById('sendBtn').click(); return true; })()`);
    };
    // 卡上的「界面文字」:不含模型给的名称/说明/原因/正文
    const chromeTexts = `(() => {
      const out = [];
      for (const c of document.querySelectorAll('#messages .memory-proposal-card')) {
        for (const sel of ['.memory-proposal-kicker', '.memory-proposal-scope-note', '.memory-proposal-actions button', '.memory-proposal-tag', '.memory-proposal-core', 'details > summary', 'select.memory-proposal-scope option'])
          for (const n of c.querySelectorAll(sel)) if (!n.hidden) out.push(n.textContent);
        for (const n of c.querySelectorAll('select.memory-proposal-scope')) out.push(n.getAttribute('aria-label') || '');
      }
      return out;
    })()`;
    await esend('remember: commit messages in Chinese [DOWN]');
    const e1 = await ewait(`(() => { const t = ${chromeTexts}; return t.length ? t : null; })()`, 1200);
    ok(Array.isArray(e1) && e1.every(x => !cjk(x)) && e1.some(x => /AI suggested Global/.test(x) && /conservative default/.test(x)),
      `E1 英文界面单条卡:作用域说明是英文、卡上界面文字零中文(got ${JSON.stringify(e1)})`);
    await eev(`location.reload()`);
    await sleep(600);
    const e2 = await ewait(`(() => { const t = window.state && window.state.currentSession && window.state.currentSession.id ? ${chromeTexts} : []; return t.length ? t : null; })()`, 1500);
    ok(Array.isArray(e2) && e2.every(x => !cjk(x)) && e2.some(x => /AI suggested Global/.test(x)), `E2 刷新后画回来的卡同样是英文(got ${JSON.stringify(e2)})`);
    await esend('write these three down [BATCH]');
    const e3 = await ewait(`(() => { const c = document.querySelector('#messages .memory-proposal-batch'); if (!c) return null; const t = ${chromeTexts}; return t.length ? t : null; })()`, 1200);
    ok(Array.isArray(e3) && e3.every(x => !cjk(x)) && e3.some(x => x === 'Will join core (injected every turn)') && e3.some(x => x === 'Not added to core') && e3.some(x => /^Body \(\d+ chars\)$/.test(x)),
      `E3 英文界面批量卡:「加入核心」开关、正文字数、作用域下拉都是英文(got ${JSON.stringify(e3)})`);
    // 过期的修订:提议之后记忆被改过 → 报错按稳定码本地化成英文
    await esend('please revise memory seed-stale [REVSTALE]');
    await ewait(`(() => document.querySelector('#messages .memory-proposal-card .memory-proposal-kicker') ? 1 : null)()`, 1200);
    await sleep(30);
    await fx.request('POST', '/api/memory', { memory: { id: SEED.stale, scope: 'project', type: 'convention', name: 'kq seed-stale', description: 'my own later edit', body: 'seed stale body' }, cwd: fx.work });
    await eev(`(() => { window.__toasts = []; const tray = document.getElementById('toastTray'); if (tray) new MutationObserver(list => { for (const m of list) for (const n of m.addedNodes) window.__toasts.push(String(n.textContent || '')); }).observe(tray, { childList: true }); document.querySelector('#messages .memory-proposal-card .memory-proposal-actions button.primary').click(); return true; })()`);
    const e4 = await ewait(`(() => (window.__toasts || []).find(x => /edited after this revision/.test(x)) || null)()`, 400);
    ok(typeof e4 === 'string' && !cjk(e4) && /kq seed-stale/.test(e4), `E4 过期修订的失败提示是英文(稳定码 memory.proposal_stale → error.api.memoryProposalStale)(got ${JSON.stringify(e4)})`);
    await eev(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true; })()`);
    await sleep(300);
    await eev(`(() => { const item = [...document.querySelectorAll('#paletteList .palette-item')].find(i => /memor/i.test(i.textContent)); if (item) item.click(); return Boolean(item); })()`);
    const e5 = await ewait(`(() => { const h = document.querySelector('#memoryList .memory-hint'); return h && h.textContent ? h.textContent : null; })()`, 400);
    ok(typeof e5 === 'string' && /adding at most 5 matches per turn/.test(e5), `E5 英文界面的面板提示读配置(got ${JSON.stringify(e5)})`);
    ok(fx.exceptions.length === 0, `EX 英文夹具页面没有未捕获异常(${fx.exceptions.join(' | ')})`);
  } catch (e) {
    t.fail('fatal: ' + (e && e.stack || e));
  } finally {
    if (fx) await fx.close();
    t.done();
  }
})();
