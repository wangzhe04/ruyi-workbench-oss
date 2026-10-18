'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, request, sleep, READY } = require('./lib/browser-fixture');
const { loadServerInternals } = require('./lib/server-internals');
const t = createRunner('STEWARD DELIVERY BROWSER'); const { ok } = t;
let fx, sid, fileA, fileB, filePdf;
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-delivery-ui-', ok, width: 1440, config: { permissionMode: 'auto' },
      provider: ctx => { ctx.text('第二部分已修改,需要重新核验。'); ctx.stop(); },
      prepare: async fixture => {
        await fixture.request('POST', '/api/steward/visit', {});
        process.env.RUYI_HOME = fixture.home; process.env.WIN_CLAUDE_WORKBENCH_HOME = fixture.home;
        const s = loadServerInternals(['readConfig', 'createSession', 'saveSession', 'loadSession', 'normalizeMission', 'recordMissionCheckResult', 'stewardCaptureDelivery', 'ensureStewardSession']);
        const cfg = await s.readConfig();
        const session = await s.createSession({ title: '季度交付报告', cwd: fixture.work }); sid = session.id;
        fileA = path.join(fixture.work, '一部', '报告.md'); fileB = path.join(fixture.work, '二部', '报告.md');
        for (const file of [fileA, fileB]) fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(fileA, '# 一部报告\n\n第二部分：等待修改。'); fs.writeFileSync(fileB, '# 二部报告\n\n不要修改这份同名文件。');
        filePdf = path.join(fixture.work, '成果.pdf'); fs.writeFileSync(filePdf, '%PDF-1.4\nfixture');
        session.turnSeq = 1;
        session.mission = s.normalizeMission({ goal: '季度交付报告', milestones: [
          { id: 'checked', desc: '报告文件存在', status: 'done', check: { type: 'file_exists', path: fileA } },
          { id: 'reported', desc: '内容整理完成', status: 'done' },
          { id: 'open', desc: '补齐来源', status: 'pending' },
        ] }, null);
        s.recordMissionCheckResult(session.mission.milestones[0], { pass: true, detail: '文件存在' });
        const summary = { turnSeq: 1, artifacts: [{ path: fileA }, { path: fileB }, { path: filePdf }], filesChanged: [] };
        session.messages = [{ role: 'user', content: '生成报告', turnSeq: 1, createdAt: new Date(Date.now() - 1500).toISOString() }];
        await s.stewardCaptureDelivery(session, summary, { startedAt: Date.now() - 1000 });
        session.messages.push({ role: 'assistant', content: '第一轮报告已交付。第二部分仍需补齐来源。', turnSeq: 1, turnSummary: summary, createdAt: new Date().toISOString() });
        await s.saveSession(session);
        const steward = (await s.ensureStewardSession(cfg)).session;
        steward.messages.push({ role: 'assistant', content: '', createdAt: new Date(Date.now() + 10).toISOString(),
          steward: { trigger: { kind: 'inbox', sessionId: sid, title: session.title, turnSeq: 1 }, say: '报告已交付,可以查看原件和检查。', why: '', acts: [], actions: [] } });
        steward.messages.push({ role: 'assistant', content: '', createdAt: new Date(Date.now() + 20).toISOString(),
          steward: { trigger: { kind: 'inbox', sessionId: sid, title: session.title, turnSeq: 999 }, say: '迟到但来源不存在的通知', why: '', acts: [], actions: [] } });
        await s.saveSession(steward);
      } });
    await fx.setLens('steward');
    const panel = `.steward-deliverable[data-session-id="${sid}"] .steward-delivery-panel`;
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.textContent.includes('打开产物 · 3') ? 1 : null`), '真实交付卡读到本轮文件和检查投影');
    ok(await fx.waitForEval(`document.querySelector('.steward-deliverable[data-turn-seq="999"]') ? null : 1`), '来源回合缺失的迟到通知不显示其它回合正文');
    const route = '/api/steward/delivery?sessionId=' + sid + '&turnSeq=1';
    const unauth = await request(fx.appPort, 'GET', route, null, null);
    ok(unauth.status === 403, '交付内容接口无 token 被拒绝');
    const click = async label => fx.evaluate(`(() => { const p=document.querySelector(${JSON.stringify(panel)}); const b=[...p.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)}); if(!b)return false;b.click();return true;})()`);
    ok(await click('打开产物 · 3'), '第一步展开本轮产物');
    const names = await fx.evaluate(`(() => [...document.querySelectorAll(${JSON.stringify(panel + ' .steward-delivery-file-path')})].map(n=>n.textContent))()`);
    ok(names.includes(fileA) && names.includes(fileB), '两份同名文件显示路径区别,身份未折叠');
    await fx.evaluate(`document.querySelector(${JSON.stringify(panel + ' .steward-delivery-file-open')}).click(); true`);
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel + ' .steward-delivery-preview')})?.textContent.includes('一部报告') ? 1 : null`), '第二步直接打开正确文件的安全预览');
    await fx.evaluate(`(() => {const original=window.fetch;window.deliveryFetch=original;window.deliveryOpened=null;window.fetch=async function(url,options){if(String(url)==='/api/file/reveal'){window.deliveryOpened=JSON.parse(options.body);return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}});}return original.apply(this,arguments);}; document.querySelectorAll(${JSON.stringify(panel + ' .steward-delivery-file-open')})[2].click();return true;})()`);
    ok(await fx.waitForEval(`window.deliveryOpened?.path===${JSON.stringify(filePdf)}&&window.deliveryOpened?.sessionId===${JSON.stringify(sid)}&&window.deliveryOpened?.mode==='open' ? 1 : null`), 'PDF 打开沿既有本机接口并绑定来源任务,仅替身拦截系统唤起');
    await fx.evaluate('window.fetch=window.deliveryFetch;true');
    await fx.evaluate(`(() => { const original=window.fetch; window.deliveryFetch=original; window.fetch=async function(url,...args){if(String(url).includes('/api/steward/delivery?')&&String(url).includes('&file=0&'))await new Promise(r=>setTimeout(r,250));return original.call(this,url,...args);}; const buttons=document.querySelectorAll(${JSON.stringify(panel + ' .steward-delivery-file-open')});buttons[0].click();buttons[1].click();return true;})()`);
    await sleep(400);
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel + ' .steward-delivery-preview')});window.fetch=window.deliveryFetch;return p.textContent.includes('二部报告')&&!p.textContent.includes('一部报告');})()`), '连续打开同名文件时迟到预览不覆盖后来选中的文件');
    ok(await click('查看检查 · 3'), '检查入口就在交付卡旁边');
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)});return p.textContent.includes('已验证')&&p.textContent.includes('模型自报，未验证')&&p.textContent.includes('尚未完成');})()`), '机器检查、模型自报和未完成各有清楚标记');
    await fx.evaluate("document.getElementById('stewardComposerInput').value='已有草稿'; true");
    await click('继续修改');
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.textContent.includes('输入区已有草稿') ? 1 : null`), '有草稿时不覆盖内容或目标');
    ok(await fx.evaluate("document.getElementById('stewardComposerInput').value==='已有草稿'"), '已有草稿逐字保留');
    fs.writeFileSync(fileA, '# 一部报告\n\n外部修改后的内容。');
    fs.unlinkSync(fileB);
    await click('刷新文件状态');
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.textContent.includes('内容已变化') ? 1 : null`), '文件外部改动后提示已变化');
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)});return p.textContent.includes('文件已不存在')&&p.textContent.includes('历史记录，需重新核验')&&p.querySelectorAll('.steward-delivery-file-open:disabled').length===1;})()`), '缺文件不可打开,旧通过章明确失效');
    const oldPreview = (await fx.request('GET', route)).json;
    fs.writeFileSync(fileA, '又变化一次');
    const stalePreview = await fx.request('GET', route + '&file=0&fingerprint=' + oldPreview.files[0].fingerprint + '&sourceStamp=' + oldPreview.sourceStamp);
    ok(stalePreview.status === 409, '点击前文件再次变化时拒绝陈旧预览');
    fs.writeFileSync(fileA, '# 一部报告\n\n只修改这一份'); fs.writeFileSync(fileB, '# 二部报告');
    await click('刷新文件状态');
    await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.querySelectorAll('.steward-delivery-file-open:disabled').length===0 ? 1 : null`);
    await fx.evaluate("document.getElementById('stewardComposerInput').value=''; true");
    await click('继续修改');
    ok(await fx.waitForEval("document.querySelector('#stewardTarget .steward-target-label')?.textContent.includes('修订第 1 轮') ? 1 : null"), '继续修改选中原任务和具体来源回合');
    await fx.evaluate("(() => {const i=document.getElementById('stewardComposerInput');i.value='只改第二部分';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()");
    let revised;
    for (let i = 0; i < 160; i++) {
      const state = await fx.request('GET', '/api/sessions/' + sid);
      revised = state && state.json && state.json.session;
      if (revised?.messages.some(row => row.role === 'user' && row.content === '只改第二部分')) break;
      await sleep(50);
    }
    const user = revised.messages.find(row => row.role === 'user' && row.content === '只改第二部分');
    ok(user?.meta?.revisionOf?.turnSeq === 1 && user.meta.revisionOf.sessionId === sid && user.meta.revisionOf.files.includes(fileA), '真实发送落回原任务,保留原话和持久化修订来源');
    for (const width of [1440, 768, 390]) {
      await fx.resize(width, 960);
      await click('查看检查 · 3');
      const fits = await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)});const r=p.getBoundingClientRect();return r.width>0&&p.scrollWidth<=p.clientWidth+1;})()`);
      ok(fits, width + 'px 交付卡文件名、检查与操作没有横向溢出');
      const shot = path.join(fx.root, 'delivery-' + width + '.png'); fs.writeFileSync(shot, await fx.screenshot()); console.log('SCREENSHOT ' + shot);
    }
    await fx.resize(1440, 960);
    let loadTimer;
    const loaded = new Promise((resolve, reject) => { loadTimer=setTimeout(() => reject(new Error('reload timed out')),30000); fx.cdp.on('Page.loadEventFired', () => {clearTimeout(loadTimer);resolve();}); });
    try { await fx.cdp.send('Page.reload'); await loaded; } finally { clearTimeout(loadTimer); }
    ok(!!(await fx.waitForEval(READY)), '刷新后等待组合根绑定完再切换视角');
    await fx.setLens('steward');
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.textContent.includes('旧交付') ? 1 : null`), '刷新回放后旧交付仍绑定第一轮,不冒充新结果');
    ok(await fx.evaluate(`document.querySelector('.steward-deliverable[data-session-id="${sid}"] .steward-deliverable-body').textContent.includes('第一轮报告已交付')`), '回放保留原轮正文,没有拿后续助手话替换');
    await fx.evaluate("import('/js/i18n.js').then(m=>m.setLocale('en-US')).then(()=>{document.documentElement.dataset.theme='light';return true;})");
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.textContent.includes('Request changes') ? 1 : null`), '切换英文后交付操作重新标注');
    await fx.resize(390, 960);
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)});return p.scrollWidth<=p.clientWidth+1;})()`), '英文浅色窄屏操作无横向溢出');
    fs.writeFileSync(path.join(fx.root, 'delivery-en-light-390.png'), await fx.screenshot());
    ok(fx.exceptions.length === 0, '界面无未捕获异常');
    await fx.close({ keepRoot: true }); fx = null;
  } catch (error) { t.fail(error.stack); if (fx) { try { console.log('BROWSER-DIAG ' + JSON.stringify(await fx.evaluate("({feed:document.getElementById('stewardFeed')?.textContent,mode:document.documentElement.dataset.shellMode})"))); } catch { console.log('BROWSER-DIAG browser unavailable'); } } }
  finally { if (fx) await fx.close(); }
  t.done({ exit: true });
})();
