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
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.querySelectorAll('.steward-delivery-file-open').length===3 ? 1 : null`), '真实交付卡读到本轮文件和检查投影');
    ok(await fx.waitForEval(`document.querySelector('.steward-deliverable[data-turn-seq="999"]') ? null : 1`), '来源回合缺失的迟到通知不显示其它回合正文');
    const route = '/api/steward/delivery?sessionId=' + sid + '&turnSeq=1';
    const unauth = await request(fx.appPort, 'GET', route, null, null);
    ok(unauth.status === 403, '交付内容接口无 token 被拒绝');
    const click = async label => fx.evaluate(`(() => { const p=document.querySelector(${JSON.stringify(panel)});const card=p.closest('.steward-deliverable'); const b=[...card.querySelectorAll('button')].find(n=>n.textContent.trim()===${JSON.stringify(label)}); if(!b)return false;if(p.contains(b)&&p.hidden)card.querySelector('.steward-deliverable-more').click();const more=b.closest('details');if(more)more.open=true;b.click();return true;})()`);
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)});const card=p.closest('.steward-deliverable');const visible=[...card.querySelectorAll('button,summary')].filter(n=>n.checkVisibility());return p.hidden&&visible.length===2&&visible[0].textContent==='展开全文'&&visible[1].textContent==='继续修改';})()`), '短正文也常驻展开全文主入口和继续修改,产物/版本/检查默认收起');
    for (const width of [1920, 1440, 768, 390]) {
      await fx.resize(width, 960);
      ok(await fx.evaluate(`(() => {const card=document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable');return card.scrollWidth<=card.clientWidth+1&&card.querySelector('.steward-deliverable-more').checkVisibility();})()`), width + 'px 简洁交付卡全文入口可见且不溢出');
      fs.writeFileSync(path.join(fx.root, 'delivery-summary-' + width + '.png'), await fx.screenshot());
      if (width === 1920) ok(await fx.evaluate("document.querySelector('.steward-feed').getBoundingClientRect().width===900&&document.querySelector('.steward-composer').getBoundingClientRect().width===900"), '1920px 管家正文与输入共用900读宽,长文获得更多空间');
    }
    await fx.resize(1440, 960);
    await click('展开全文');
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)});const card=p.closest('.steward-deliverable');return !p.hidden&&!card.querySelector('.steward-deliverable-body').classList.contains('is-clamped')&&card.querySelector('.steward-deliverable-more').getAttribute('aria-expanded')==='true'&&p.querySelector('.steward-delivery-more .steward-deliverable-full');})()`), '展开全文原地显示原轮正文和交付细节,工作台入口仍在更多');
    await click('收起');
    ok(await fx.evaluate(`document.querySelector(${JSON.stringify(panel)}).hidden`), '收起全文同时收起版本、文件与检查,不留下第二排小按钮');
    await fx.evaluate("(() => {window.failedDeliveryFetch=window.fetch;window.fetch=async function(url,...args){if(String(url).startsWith('/api/steward/delivery?'))return new Response(JSON.stringify({ok:false}),{status:503,headers:{'content-type':'application/json'}});return window.failedDeliveryFetch.call(this,url,...args);};return true;})()");
    await click('继续修改');
    ok(await fx.waitForEval(`(() => {const p=document.querySelector(${JSON.stringify(panel)});const n=p.closest('.steward-deliverable').querySelector('.steward-delivery-revision-feedback');return p.hidden&&n.checkVisibility()&&n.textContent.includes('交付记录暂时读不到') ? 1 : null;})()`), '摘要态修订预检失败也能看到原因,不需要先展开');
    await click('刷新文件状态');
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.querySelector('.steward-deliverable-full')?.checkVisibility()&&document.querySelector(${JSON.stringify(panel)})?.textContent.includes('交付记录暂时读不到') ? 1 : null`), '交付接口刷新失败时仍保留工作台全文入口');
    await fx.evaluate('window.fetch=window.failedDeliveryFetch;true');
    await click('刷新文件状态');
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)})?.querySelector('.steward-delivery-more .steward-deliverable-full') ? 1 : null`), '重试成功后全文入口回到更多且仅一处');
    await fx.evaluate(`(() => {window.oldRevisionFetch=window.fetch;window.oldRevisionHeld=false;window.fetch=async function(url,...args){if(String(url)===${JSON.stringify(route)}&&!window.oldRevisionHeld){window.oldRevisionHeld=true;return new Promise((resolve,reject)=>window.rejectOldRevision=()=>reject(new Error('late revision read failed')));}return window.oldRevisionFetch.call(this,url,...args);};window.heldRevisionButton=document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable').querySelector('.steward-delivery-revise');return true;})()`);
    await click('继续修改');
    ok(await fx.waitForEval('window.oldRevisionHeld ? 1 : null'), '确定旧修订预检请求仍挂起');
    await click('刷新文件状态');
    ok(await fx.waitForEval(`document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable').querySelector('.steward-delivery-revise')!==window.heldRevisionButton ? 1 : null`), '新刷新已完成并替换旧修订操作');
    await fx.evaluate("(async () => {window.rejectOldRevision();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));window.fetch=window.oldRevisionFetch;return true;})()");
    ok(await fx.evaluate(`document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable').querySelector('.steward-delivery-revision-feedback').textContent===''`), '旧预检迟到失败不复活过期错误或覆盖刷新成功状态');
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)});return [...p.querySelectorAll('.steward-delivery-file-open')].every(n=>n.checkVisibility())&&!p.textContent.includes('打开产物 ·');})()`), '展开全文后直接列出文件入口,无需再展开一层产物');
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
    await click('收起');
    await click('继续修改');
    ok(await fx.waitForEval(`(() => {const n=document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable').querySelector('.steward-delivery-revision-feedback');return n?.checkVisibility()&&n.textContent.includes('输入区已有草稿') ? 1 : null;})()`), '摘要态修订被草稿阻止时原因可见,不覆盖内容或目标');
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
    const newTask = async () => fx.evaluate("(() => {document.getElementById('stewardComposerPlus').click();const b=[...document.querySelectorAll('.popover .cm-item')].find(n=>n.textContent.trim()==='另起一件');if(!b)return false;b.click();return true;})()");
    ok(await fx.evaluate("document.getElementById('stewardComposerCancelTarget').checkVisibility()&&document.getElementById('stewardComposerCancelTarget').textContent==='取消修订'&&document.getElementById('stewardTarget').disabled"), '修订有独立取消按钮,不能通过普通目标选择器丢失来源');
    ok(await fx.evaluate("(() => {const i=document.getElementById('stewardComposerInput');const e=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});i.dispatchEvent(e);return !e.defaultPrevented&&document.querySelector('#stewardTarget .steward-target-label').textContent.includes('修订第 1 轮');})()"), '修订期间 Tab 保留正常焦点移动,不隐式换目标');
    await fx.evaluate("(() => {const i=document.getElementById('stewardComposerInput');i.value='保留这份修订草稿';const dt=new DataTransfer();dt.items.add(new File(['修订附件'], '修订附件.txt',{type:'text/plain'}));const f=document.getElementById('stewardComposerFile');f.files=dt.files;f.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
    ok(await fx.waitForEval("document.querySelector('#stewardAttachTray .attachment-pill') ? 1 : null"), '修订草稿可以添加附件');
    await newTask();
    ok(await fx.evaluate("document.querySelector('#stewardTarget .steward-target-label').textContent.includes('修订第 1 轮')&&document.getElementById('stewardComposerInput').value==='保留这份修订草稿'&&document.getElementById('stewardComposerNote').textContent.includes('先取消当前修订')"), '另起一件不会静默覆盖修订目标或草稿');
    for (const width of [1440, 768, 390]) {
      await fx.resize(width, 960);
      ok(await fx.evaluate("(() => {const c=document.getElementById('stewardComposer');const b=document.getElementById('stewardComposerCancelTarget');return c.scrollWidth<=c.clientWidth+1&&b.checkVisibility()&&b.getBoundingClientRect().right<=innerWidth;})()"), width + 'px 修订目标和独立取消可见且不溢出');
      fs.writeFileSync(path.join(fx.root, 'delivery-revision-' + width + '.png'), await fx.screenshot());
    }
    await fx.resize(1440, 960);
    await fx.evaluate("document.getElementById('stewardComposerCancelTarget').focus();true");
    await fx.enter();
    const cancelledRevision = await fx.evaluate("(() => {const i=document.getElementById('stewardComposerInput');return {cancelled:document.getElementById('stewardComposerCancelTarget').hidden,text:i.value,placeholder:i.placeholder,attachments:document.querySelectorAll('#stewardAttachTray .attachment-pill').length,note:document.getElementById('stewardComposerNote').textContent,focus:document.activeElement.id};})()");
    ok(cancelledRevision.cancelled&&cancelledRevision.text==='保留这份修订草稿'&&cancelledRevision.placeholder==='跟如意说点什么'&&cancelledRevision.attachments===1&&!cancelledRevision.note.includes('已选好原任务'), '键盘取消修订仅移除目标,文字附件保留,提示和占位文案复位 '+JSON.stringify(cancelledRevision));
    await fx.evaluate("document.querySelector('#stewardAttachTray .attach-x').click();document.getElementById('stewardComposerInput').value='';true");
    // 自动 new 只是预测，后续输入必须还能重新预测；不能与用户明选 new 混用。
    await fx.evaluate("(() => {const i=document.getElementById('stewardComposerInput');i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
    await sleep(200); // 空输入的 150ms 去抖复位，无网络请求可轮询。
    await fx.evaluate(`(() => {const original=window.fetch;window.autoRouteFetch=original;window.autoRouteQueries=[];window.fetch=async function(url,...args){if(String(url).startsWith('/api/steward/preroute?')){const q=new URL(String(url),location.href).searchParams.get('q');window.autoRouteQueries.push(q);return new Response(JSON.stringify({ok:true,kind:q==='新的请求'?'new':'thread',hits:q==='新的请求'?[]:[{sessionId:${JSON.stringify(sid)},title:'季度交付报告'}]}),{status:200,headers:{'content-type':'application/json'}});}return original.call(this,url,...args);};const i=document.getElementById('stewardComposerInput');i.value='新的请求';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    ok(await fx.waitForEval("document.querySelector('#stewardTarget .steward-target-label').textContent.includes('另起一件')&&!document.getElementById('stewardComposerCancelTarget').checkVisibility() ? 1 : null"), '自动 new 不冒充显式新建模式');
    await fx.evaluate("(() => {const i=document.getElementById('stewardComposerInput');i.value='季度交付报告';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()");
    ok(await fx.waitForEval("document.getElementById('stewardTarget').classList.contains('is-thread')&&window.autoRouteQueries.length===2 ? 1 : null"), '自动 new 后改写文字仍能预判接续任务');
    await fx.evaluate("window.fetch=window.autoRouteFetch;true");
    // 真输入触发预判后，挂住响应；点击另起一件必须令在途响应作废。
    await fx.evaluate(`(() => {const original=window.fetch;window.composerFetch=original;window.prerouteHeld=false;window.fetch=async function(url,...args){if(String(url).startsWith('/api/steward/preroute?')){window.prerouteHeld=true;await new Promise(r=>window.releasePreroute=r);return new Response(JSON.stringify({ok:true,kind:'thread',hits:[{sessionId:${JSON.stringify(sid)},title:'季度交付报告'}],reason:'late'}),{status:200,headers:{'content-type':'application/json'}});}return original.call(this,url,...args);};const i=document.getElementById('stewardComposerInput');i.value='季度交付报告';i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
    ok(await fx.waitForEval('window.prerouteHeld ? 1 : null'), '确定预判响应尚在途中');
    await newTask();
    await fx.evaluate("(async () => {window.releasePreroute();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));return true;})()");
    ok(await fx.waitForEval("document.querySelector('#stewardTarget .steward-target-label').textContent.includes('另起一件') ? 1 : null"), '迟到预判不覆盖另起一件');
    await fx.evaluate("(() => {const i=document.getElementById('stewardComposerInput');for(const value of ['', '另做新的汇总']){i.value=value;i.dispatchEvent(new Event('input',{bubbles:true}));}window.fetch=window.composerFetch;return true;})()");
    ok(await fx.evaluate("document.getElementById('stewardComposerCancelTarget').textContent==='取消另起'&&document.querySelector('#stewardTarget .steward-target-label').textContent.includes('另起一件')"), '清空再输入仍保留显式另起选择');
    ok(await fx.evaluate("(() => {const e=new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true});document.getElementById('stewardComposerInput').dispatchEvent(e);return !e.defaultPrevented&&document.getElementById('stewardComposerCancelTarget').textContent==='取消另起';})()"), '明选另起期间 Tab 只移动焦点,不循环成旧任务');
    await fx.evaluate("document.getElementById('stewardComposerInput').value='';true");
    await click('继续修改');
    ok(await fx.waitForEval(`(() => {const n=document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable').querySelector('.steward-delivery-revision-feedback');return n?.checkVisibility()&&n.textContent.includes('输入区已有草稿') ? 1 : null;})()`), '空草稿也不能让继续修改覆盖已选的另起一件,受阻原因可见');
    await fx.evaluate("(() => {const original=window.fetch;window.composerFetch=original;window.sentNew=null;window.fetch=async function(url,options){const response=await original.apply(this,arguments);if(String(url)==='/api/steward/message'){window.sentNew=JSON.parse(options.body);await new Promise(r=>window.releaseNew=r);}return response;};const i=document.getElementById('stewardComposerInput');i.value='另做新的汇总';i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()");
    ok(await fx.waitForEval("window.sentNew?.routeHint?.kind==='new' ? 1 : null"), '真实发送保留另起路由提示');
    await newTask();
    await fx.evaluate("window.releaseNew();true");
    ok(await fx.waitForEval("document.querySelector('#stewardFeed .steward-typing') ? null : 1"), '上一句迟到回执已完成');
    ok(await fx.evaluate("document.getElementById('stewardComposerCancelTarget').checkVisibility()&&document.getElementById('stewardComposerCancelTarget').textContent==='取消另起'"), '上一句回执不能清除下一份另起选择');
    await fx.evaluate("window.fetch=window.composerFetch;document.getElementById('stewardComposerInput').value='保留另起草稿';document.getElementById('stewardComposerCancelTarget').click();true");
    ok(await fx.evaluate("document.getElementById('stewardComposerInput').value==='保留另起草稿'&&document.getElementById('stewardComposerCancelTarget').hidden"), '取消另起保留输入且恢复普通目标');
    await fx.evaluate("document.getElementById('stewardComposerInput').value='';true");
    await click('继续修改');
    ok(await fx.waitForEval("document.querySelector('#stewardTarget .steward-target-label')?.textContent.includes('修订第 1 轮') ? 1 : null"), '取消后可以重新选择原交付修订');
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
    ok(await fx.waitForEval(`(() => {const card=document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable');return card.querySelector('.steward-delivery-revise').textContent==='Request changes'&&card.querySelector('.steward-deliverable-more').textContent==='Read full text'&&card.querySelector('.steward-deliverable-more').getAttribute('aria-expanded')==='false';})()`), '切换英文后两个常驻入口重标注,保持收起状态');
    await fx.resize(390, 960);
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable');return p.scrollWidth<=p.clientWidth+1;})()`), '英文浅色窄屏操作无横向溢出');
    fs.writeFileSync(path.join(fx.root, 'delivery-en-light-390.png'), await fx.screenshot());
    await click('Read full text');
    await fx.evaluate("import('/js/i18n.js').then(m=>m.setLocale('zh-CN'))");
    ok(await fx.evaluate(`(() => {const p=document.querySelector(${JSON.stringify(panel)});return !p.hidden&&p.closest('.steward-deliverable').querySelector('.steward-deliverable-more').textContent==='收起';})()`), '展开态切语言只重标注,不会收起全文');
    await fx.evaluate("import('/js/i18n.js').then(m=>m.setLocale('en-US'))");
    ok(await fx.waitForEval(`(() => {const b=document.querySelector(${JSON.stringify(panel)}).closest('.steward-deliverable').querySelector('.steward-deliverable-more');return b.getAttribute('aria-expanded')==='true'&&getComputedStyle(b).backgroundColor==='rgba(0, 0, 0, 0)' ? 1 : null;})()`), '展开后收起使用次级透明按钮,不继续占用金色主操作');
    fs.writeFileSync(path.join(fx.root, 'delivery-en-expanded-light-390.png'), await fx.screenshot());
    ok(await fx.evaluate(`(async () => {const {attachStewardDeliveryPanel}=await import('/js/steward-delivery.js');const block=document.createElement('div');block.className='steward-deliverable';document.body.appendChild(block);try{const p=attachStewardDeliveryPanel(block,{sessionId:'no-files',turnSeq:1},{t:key=>key,api:async()=>({ok:true,evidenceRecorded:true,files:[],checks:[]})});await new Promise(resolve=>requestAnimationFrame(resolve));return p.querySelector('.steward-delivery-files').hidden&&!p.textContent.includes('delivery.openFiles')&&!p.querySelector('.steward-delivery-file-open');}finally{block.remove();}})()`), '没有产物的交付不显示打开产物零或空文件占位');
    ok(fx.exceptions.length === 0, '界面无未捕获异常');
    await fx.close({ keepRoot: true }); fx = null;
  } catch (error) { t.fail(error.stack); if (fx) { try { console.log('BROWSER-DIAG ' + JSON.stringify(await fx.evaluate("({feed:document.getElementById('stewardFeed')?.textContent,mode:document.documentElement.dataset.shellMode})"))); } catch { console.log('BROWSER-DIAG browser unavailable'); } } }
  finally { if (fx) await fx.close(); }
  t.done({ exit: true });
})();
