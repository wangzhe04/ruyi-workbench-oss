'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, READY, sleep } = require('./lib/browser-fixture');
const t = createRunner('STEWARD HANDOFF RECOVERY BROWSER'); const { ok } = t;
let fx, sid, other;
const key = 'ruyi.steward.handoffs.v1';
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-handoff-recovery-ui-', ok, config: { stewardPollMs: 120000 },
      provider: ctx => { ctx.text('处理完成。'); ctx.stop(); }, prepare: async fixture => {
        sid = (await fixture.request('POST', '/api/sessions', { title: '刷新恢复验收', cwd: fixture.work })).json.session.id;
        other = (await fixture.request('POST', '/api/sessions', { title: '另一件事', cwd: fixture.work })).json.session.id;
      } });
    await fx.setLens('steward');
    await fx.waitForEval("document.querySelector('#stewardComposerInput')?1:null", 200);
    const pending = () => fx.evaluate(`JSON.parse(sessionStorage.getItem('${key}')||'[]')`);
    const users = async () => (await fx.request('GET', '/api/sessions/' + sid)).json.session.messages.filter(m=>m.role==='user');
    const select = async () => {
      await fx.evaluate("document.getElementById('stewardComposerInput').value='刷新恢复验收 请继续';document.getElementById('stewardComposerInput').dispatchEvent(new Event('input',{bubbles:true}));true");
      await fx.waitForEval("document.getElementById('stewardTarget').textContent.includes('刷新恢复验收')?1:null", 200);
      await fx.evaluate("document.getElementById('stewardTarget').click();true");
      if (!await fx.waitForEval("(()=>{const b=[...document.querySelectorAll('#stewardTargetPicker button')].find(x=>x.textContent.includes('刷新恢复验收'));if(!b)return null;b.click();return true;})()", 100)) throw new Error('target unavailable');
    };
    const send = text => fx.evaluate(`(()=>{const i=document.getElementById('stewardComposerInput');i.value=${JSON.stringify(text)};i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return true;})()`);
    const click = label => fx.evaluate(`(()=>{const b=[...document.querySelectorAll('#stewardFeed .steward-act')].find(x=>x.textContent===${JSON.stringify(label)});if(!b)return false;b.click();return true;})()`);
    const reload = async () => { await fx.cdp.send('Page.reload'); await fx.waitForEval(READY, 240); await fx.setLens('steward'); await fx.waitForEval("document.querySelector('[data-handoff-attempt]')?1:null", 240); };
    const fault = async mode => fx.evaluate(`(()=>{window.__heldHandoff=false;const original=window.fetch;window.fetch=async (...args)=>{const body=(()=>{try{return JSON.parse(args[1]?.body||'{}')}catch{return{}}})();if(String(args[0]).includes('/api/steward/act')&&body.act){window.fetch=original;if(${JSON.stringify(mode)}==='fail')throw new TypeError('fixture request not sent');const response=await original(...args);if(${JSON.stringify(mode)}==='drop')throw new TypeError('fixture response lost');window.__heldHandoff=true;return new Promise(resolve=>window.__releaseHandoff=()=>resolve(response));}return original(...args);};return true;})()`);
    const holdArrival = async () => {
      await fx.evaluate(`(() => {
        const original = window.fetch; let hold = true;
        window.__arrival = {}; window.__restoreArrivalFetch = () => { window.fetch = original; };
        window.fetch = async (...args) => {
          const history = window.__arrival.consumed && String(args[0]) === '/api/sessions/steward';
          if (history) window.__arrival.historyRequested = true;
          const response = await original(...args);
          if (hold && String(args[0]) === '/api/steward/visit') {
            hold = false; window.__arrival.held = true;
            await new Promise(resolve => { window.__arrival.release = resolve; });
            const json = response.json.bind(response);
            response.json = async () => { const value = await json(); window.__arrival.consumed = true; return value; };
          }
          if (history) { const json = response.json.bind(response); response.json = async () => { const value = await json(); window.__arrival.historyConsumed = true; return value; }; }
          return response;
        }; return true;
      })()`);
      await fx.setLens('classic'); await fx.setLens('steward');
      if (!await fx.waitForEval('window.__arrival.held')) throw new Error('arrival response was not held');
    };
    const releaseArrival = async () => {
      await fx.evaluate('window.__arrival.release(),true');
      if (!await fx.waitForEval('window.__arrival.consumed')) throw new Error('arrival was not consumed');
      const frames = () => fx.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await frames();
      if (await fx.evaluate('!!window.__arrival.historyRequested')) {
        if (!await fx.waitForEval('window.__arrival.historyConsumed')) throw new Error('arrival history was not consumed');
      }
      await frames(); await fx.evaluate('window.__restoreArrivalFetch(),true');
    };
    await select();
    await fx.evaluate("(()=>{const d=new DataTransfer();d.items.add(new File(['月份,金额\\n十月,123'],'恢复资料.csv',{type:'text/csv'}));const i=document.getElementById('stewardComposerFile');i.files=d.files;i.dispatchEvent(new Event('change',{bubbles:true}));return true;})()");
    await fx.waitForEval("document.querySelector('#stewardComposer').textContent.includes('恢复资料.csv')?1:null", 200);
    await fault('hold'); await send('新任务:按新资料修改报告，保留标点。');
    await fx.waitForEval('window.__heldHandoff?1:null', 240);
    const original = (await pending())[0];
    ok(original.sessionId === sid && original.attachments[0].id && original.window.serverInstanceId, '请求发出前保存原话、目标、附件及服务窗口');
    await reload();
    ok(await fx.evaluate("document.getElementById('stewardFeed').textContent.includes('新任务:按新资料修改报告，保留标点。')&&document.getElementById('stewardFeed').textContent.includes('恢复资料.csv')"), '发送中刷新恢复原话和附件');
    ok(!await fx.evaluate("[...document.querySelectorAll('[data-handoff-attempt] button')].some(b=>b.textContent==='重发这一次')"), '恢复后不提供自动或默认重发');
    await fx.evaluate("document.getElementById('stewardComposerInput').value='另一份新草稿';true");
    await click('取回原话和附件');
    ok(await fx.evaluate("document.getElementById('stewardComposerInput').value==='另一份新草稿'"), '恢复操作不覆盖新草稿');
    await click('核对是否已递到');
    await fx.waitForEval("document.querySelector('[data-handoff-state=applied]')?1:null", 160);
    ok((await pending()).length === 0 && (await users()).length === 1, '真实回执结算单条记录，原线程只收到一次');
    ok((await fx.request('GET', '/api/sessions/' + other)).json.session.messages.length === 0, '另一件事没有误收到文字或附件');
    await fx.evaluate("document.getElementById('stewardComposerInput').value='';true");
    await select(); await fault('fail'); await send('这一次根本没有发出');
    await fx.waitForEval("document.querySelectorAll('[data-handoff-attempt]').length>=2?1:null", 160);
    await reload();
    ok((await users()).length === 1, '未发出的请求在刷新后不会自动补发');
    await click('取回原话和附件');
    ok(await fx.evaluate("document.getElementById('stewardComposerInput').value==='这一次根本没有发出'&&document.getElementById('stewardTarget').textContent.includes('刷新恢复验收')"), '显式取回保留原目标且不发送');
    for (const width of [1440, 768, 390]) {
      await fx.resize(width, 960); await sleep(200);
      ok(await fx.evaluate("document.documentElement.scrollWidth<=innerWidth+1"), width + 'px恢复行无页面横向溢出');
      fs.writeFileSync(path.join(fx.root, 'recovery-' + width + '.png'), await fx.screenshot());
    }
    await click('移除这条恢复记录');
    ok((await pending()).length === 0 && await fx.evaluate("document.getElementById('stewardComposerInput').value==='这一次根本没有发出'"), '明确移除记录不清空已取回草稿');
    await fx.resize(1440, 960);
    await fx.evaluate("document.getElementById('stewardComposerInput').value='';true");
    await fx.evaluate(`(()=>{const original=Storage.prototype.setItem;window.__restoreStorage=()=>Storage.prototype.setItem=original;Storage.prototype.setItem=function(k,v){if(k==='${key}')throw new Error('fixture quota');return original.call(this,k,v);};return true;})()`);
    await send('存储失败必须保留这句话');
    ok(await fx.evaluate("document.getElementById('stewardComposerInput').value==='存储失败必须保留这句话'&&document.getElementById('stewardTarget').textContent.includes('刷新恢复验收')") && (await users()).length === 1, '恢复存储失败在清草稿前拒绝，目标及原话保留且零执行');
    await fx.evaluate("window.__restoreStorage();document.getElementById('stewardComposerInput').value='';true");
    await fault('hold'); await send('迟到回包只结算原记录');
    await fx.waitForEval('window.__heldHandoff?1:null', 240);
    await fx.setLens('classic'); await fx.setLens('steward');
    await fx.waitForEval("document.querySelector('[data-handoff-attempt]')?1:null", 200);
    await fx.evaluate("document.getElementById('stewardComposerInput').value='迟到时的新草稿';window.__releaseHandoff();true");
    await fx.waitForEval("document.querySelector('[data-handoff-state=applied]')?1:null", 160);
    ok((await pending()).length === 0 && await fx.evaluate("document.getElementById('stewardComposerInput').value==='迟到时的新草稿'&&!document.querySelector('[data-handoff-attempt] button')"), '切视角后的迟到成功收敛原恢复行，不复活操作或覆盖新草稿');
    await fx.evaluate("document.getElementById('stewardComposerInput').value='';true");
    await select(); await fault('drop'); await send('真实HTTP重放只结算原行');
    await fx.waitForEval("document.querySelector('[data-handoff-attempt]:not([data-handoff-state])')?1:null", 200);
    const beforeReplay = await fx.evaluate("document.querySelectorAll('#stewardFeed .steward-msg').length");
    await holdArrival();
    await fx.evaluate("window.__settledReceipt=document.querySelector('[data-handoff-attempt]:not([data-handoff-state])'),true");
    await click('重发这一次');
    await fx.waitForEval(`JSON.parse(sessionStorage.getItem('${key}')||'[]').length===0?1:null`, 160);
    await releaseArrival();
    ok(await fx.evaluate("window.__settledReceipt.isConnected&&window.__settledReceipt.dataset.handoffState==='applied'"), '迟到到访保留原行就地结算后的回执');
    const replayUi = await fx.evaluate(`({rows:document.querySelectorAll('#stewardFeed .steward-msg').length,pending:!!document.querySelector('[data-handoff-attempt]:not([data-handoff-state])'),undo:document.querySelectorAll('.steward-undo-face').length,states:[...document.querySelectorAll('[data-handoff-attempt]')].map(r=>({state:r.dataset.handoffState,say:r.querySelector('.steward-say')?.textContent}))})`);
    ok(replayUi.rows === beforeReplay && !replayUi.pending && replayUi.undo === 0 && (await users()).filter(m=>m.content==='真实HTTP重放只结算原行').length === 1, '真实顶层重放回包只结算原气泡，不增加回执行、撤回或重复消息');
    if (replayUi.rows !== beforeReplay || replayUi.pending || replayUi.undo) console.log('REPLAY-DIAG ' + JSON.stringify({beforeReplay,...replayUi}));
    await select(); await fault('hold'); await send('到访期间新收到的直递回执');
    await fx.waitForEval('window.__heldHandoff?1:null', 240);
    await holdArrival();
    await fx.evaluate('window.__releaseHandoff(),true');
    if (!await fx.waitForEval(`JSON.parse(sessionStorage.getItem('${key}')||'[]').length===0`)) throw new Error('direct handoff did not settle');
    await fx.evaluate("window.__freshReceipt=document.getElementById('stewardFeed').lastElementChild,true");
    await releaseArrival();
    ok(await fx.evaluate("window.__freshReceipt.isConnected&&window.__freshReceipt.classList.contains('steward-msg-ruyi')&&document.getElementById('stewardFeed').textContent.includes('到访期间新收到的直递回执')") && (await users()).filter(m=>m.content==='到访期间新收到的直递回执').length===1, '迟到到访保留在途直递新收到的回执，原线程只执行一次');
    ok(fx.exceptions.length === 0, '浏览器无未捕获异常'); console.log('ARTIFACTS ' + fx.root);
  } catch (error) { t.fail(error.stack || String(error)); if (fx) console.log('ARTIFACTS ' + fx.root); }
  finally { if (fx) await fx.close({ keepRoot: true }); t.done({ exit: true }); }
})();
