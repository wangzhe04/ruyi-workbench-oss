'use strict';
require('./lib/self-isolate-home');
const fs = require('fs'), path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, READY } = require('./lib/browser-fixture');
const t = createRunner('PLAYBOOK REUSE BROWSER'); const { ok } = t;
let fx, sid, otherSid, delayDraft = true, releaseDraft;
const exceptions = [];
const selection = '[data-reuse=selection]', editor = '[data-reuse=editor]';
const selectAccepted = `(() => {const row=[...document.querySelectorAll('.message.assistant')].find(x=>x.querySelector('.msg-content')?.textContent.includes('20.00')||x.textContent.includes('20.00'));const button=[...row.querySelectorAll('.msg-actions button')].find(x=>/存为|Save as/.test(x.textContent));button.click();return true;})()`;
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-playbook-reuse-ui-', ok, width: 1440, config: { permissionMode: 'acceptEdits', stewardPollMs: 120000 },
      provider: async ctx => {
        const last = ctx.messages.findLastIndex(m => m.role === 'user'), text = String(ctx.messages[last]?.content || ''), tools = ctx.messages.slice(last + 1).filter(m => m.role === 'tool');
        if (text.includes('产出一个 playbook 的 JSON')) {
          if (delayDraft) await new Promise(resolve => { releaseDraft = resolve; });
          ctx.text(JSON.stringify({ id: 'weekly-report', title: '预算格式复用', desc: '认可的计算格式', inputs: [], promptTemplate: '读取 {material}，重新求和，单位万元保留两位小数，标题预算汇总。输出到 {output}。', requires: [] })); ctx.stop();
        } else if (text.includes('SOURCE_CORRECTION')) { ctx.text('# 预算汇总\n20.00 万元；格式已按纠正更新。'); ctx.stop(); }
        else if (text.includes('SOURCE_FIRST')) { ctx.text('旧版：20元。'); ctx.stop(); }
        else if (text.includes('LATER_RULE')) { ctx.text('已记下，下次注明本次材料来源。'); ctx.stop(); }
        else if (text.includes('new-b.txt')) {
          if (!tools.length) ctx.toolCall('file_read', { path: 'new-b.txt' });
          else if (tools.length === 1) ctx.toolCall('file_write', { path: 'new-report.md', content: '# 预算汇总\n33.75 万元\n来源 NEW_B' });
          else { ctx.text('新材料结果为33.75万元；已按验收项核对。'); ctx.stop(); }
        } else { ctx.text('done'); ctx.stop(); }
      }, prepare: async fixture => {
        fx = fixture; fs.writeFileSync(path.join(fixture.work, 'new-b.txt'), 'NEW_B\n12.50\n21.25');
        sid = (await fixture.request('POST', '/api/sessions', { title: '认可成果来源', cwd: fixture.work })).json.session.id;
        for (const message of ['SOURCE_FIRST 汇总旧资料12+8。', 'SOURCE_CORRECTION 金额单位万元，保留两位小数，标题预算汇总。', 'LATER_RULE 下次也请注明新材料来源。']) await fixture.request('POST', '/api/chat/stream', { sessionId: sid, message });
        otherSid = (await fixture.request('POST', '/api/sessions', { title: '另一任务', cwd: fixture.work })).json.session.id;
      } });
    fx.cdp.on('Runtime.exceptionThrown', e => exceptions.push(e.exceptionDetails?.text || 'exception'));
    await fx.setLens('classic');
    await fx.waitForEval(`document.querySelector('#railList [data-session-id="${sid}"] .steward-board-thread-title')?1:null`, 240);
    await fx.evaluate(`document.querySelector('#railList [data-session-id="${sid}"] .steward-board-thread-title').click();true`);
    ok(await fx.waitForEval("[...document.querySelectorAll('.message.assistant')].some(x=>x.textContent.includes('20.00'))?1:null", 240), '真实来源线程显示可认可成果');
    await fx.evaluate(`(() => {const original=window.fetch;window.fetch=async (...args)=>{const response=await original(...args);if(String(args[0]).includes('/api/playbooks/draft')&&String(args[1]?.body).includes('sources')){window.fetch=original;return new Promise(resolve=>window.__releaseReuseSources=()=>resolve(response));}return response;};return true;})()`);
    await fx.evaluate(selectAccepted); await fx.waitForEval('window.__releaseReuseSources?1:null', 160);
    await fx.evaluate(`document.querySelector('#railList [data-session-id="${otherSid}"] .steward-board-thread-title').click();true`);
    await fx.waitForEval(`window.state.currentSession?.id==='${otherSid}'?1:null`, 160);
    await fx.evaluate('window.__releaseReuseSources();delete window.__releaseReuseSources;true');
    await new Promise(resolve => setTimeout(resolve, 250));
    ok(!await fx.evaluate(`!!document.querySelector('${selection}')`), '切换任务后迟到来源列表不会打开旧任务弹窗');
    await fx.evaluate(`document.querySelector('#railList [data-session-id="${sid}"] .steward-board-thread-title').click();true`);
    await fx.waitForEval("[...document.querySelectorAll('.message.assistant')].some(x=>x.textContent.includes('20.00'))?1:null", 160);
    const prepareSelection = async () => {
      await fx.evaluate(selectAccepted); await fx.waitForEval(`document.querySelector('${selection}')?1:null`, 160);
      return fx.evaluate(`(() => {const b=document.querySelector('${selection}');for(const x of b.querySelectorAll('input[type=checkbox]'))if(/SOURCE_CORRECTION|LATER_RULE/.test(x.parentElement.textContent))x.checked=true;b.querySelector('[data-reuse=checks]').value=['标题预算汇总，万元保留两位小数','按新材料求和并注明来源'].join(String.fromCharCode(10));return b.querySelector('pre').textContent;})()`);
    };
    ok((await prepareSelection()).includes('20.00'), '按钮绑定所点击成果，后补关键纠正也可选择');
    await fx.evaluate(`document.querySelector('${selection}').closest('.modal-backdrop').querySelector('.modal-foot .primary').click();true`);
    for (let i = 0; i < 200 && !releaseDraft; i++) await new Promise(resolve => setTimeout(resolve, 20));
    await fx.escape(); releaseDraft(); releaseDraft = null; delayDraft = false;
    await fx.waitForEval(`!document.querySelector('${selection}')?1:null`);
    await new Promise(resolve => setTimeout(resolve, 250));
    ok(!await fx.evaluate(`!!document.querySelector('${editor}')`), '起草中Esc关闭后，迟到响应不重新打开编辑器');
    ok(!(await fx.request('GET', '/api/playbooks')).json.playbooks.some(p => p.reuse), '取消起草不保存任何做法');
    await prepareSelection();
    await fx.evaluate(`document.querySelector('${selection}').closest('.modal-backdrop').querySelector('.modal-foot .primary').click();true`);
    ok(await fx.waitForEval(`document.querySelector('${editor}')?1:null`, 240), '真实非流式起草回到可编辑草稿');
    await fx.evaluate(`Promise.all(document.querySelector('${editor}').closest('.modal-backdrop').getAnimations({subtree:true}).map(a=>a.finished)).then(()=>true)`);
    for (const width of [1440, 768, 390]) {
      await fx.resize(width, 960);
      ok(await fx.evaluate(`(() => {const b=document.querySelector('${editor}').closest('.modal');return b.getBoundingClientRect().right<=innerWidth+1&&b.scrollWidth<=b.clientWidth+1;})()`), width + 'px 编辑表单不溢出');
      fs.writeFileSync(path.join(fx.root, 'reuse-' + width + '.png'), await fx.screenshot());
    }
    await fx.evaluate(`(() => {const b=document.querySelector('${editor}');b.querySelector('input').value='临时错误标题';[...b.closest('.modal-backdrop').querySelectorAll('.modal-foot button')].find(x=>x.textContent.includes('恢复')).click();return true;})()`);
    ok(await fx.evaluate(`document.querySelector('${editor} input').value==='预算格式复用'`), '可恢复打开时规则，未保存改动可撤回');
    await fx.evaluate(`(() => {const original=window.fetch;window.fetch=(...args)=>{if(String(args[0]).endsWith('/api/playbooks')&&args[1]?.method==='POST'){window.fetch=original;return Promise.resolve(new Response(JSON.stringify({ok:false,error:'fixture_disk_error'}),{status:500,headers:{'content-type':'application/json'}}));}return original(...args);};document.querySelector('${editor}').closest('.modal-backdrop').querySelector('.modal-foot .primary').click();return true;})()`);
    await fx.waitForEval(`document.querySelector('${editor}')?.closest('.modal-backdrop').querySelector('.modal-foot .primary').disabled===false?1:null`, 160);
    ok(await fx.evaluate(`document.querySelector('${editor} input')?.value==='预算格式复用'`) && !(await fx.request('GET', '/api/playbooks')).json.playbooks.some(p=>p.reuse), '保存失败保留编辑草稿并允许重试，不冒充已保存');
    await fx.evaluate(`document.querySelector('${editor}').closest('.modal-backdrop').querySelector('.modal-foot .primary').click();true`);
    ok(await fx.waitForEval(`!document.querySelector('${editor}')?1:null`, 160), '用户显式保存成功后关闭编辑器');
    const saved = (await fx.request('GET', '/api/playbooks')).json.playbooks.find(p => p.reuse);
    ok(saved && saved.reuse.corrections.length === 2 && saved.reuse.status === 'unverified', '保存保留所选两条纠正，不把保存说成验证通过');
    await fx.resize(1440, 960); await fx.cdp.send('Page.reload'); await fx.waitForEval(READY, 240); await fx.setLens('classic');
    await fx.evaluate("document.getElementById('skillBtn').click();true");
    ok(await fx.waitForEval("[...document.querySelectorAll('#skillList .skill-item')].some(x=>x.textContent.includes('预算格式复用'))?1:null", 240), '刷新后从原技能库读取已保存做法');
    await fx.evaluate("[...document.querySelectorAll('#skillList .skill-item')].find(x=>x.textContent.includes('预算格式复用')).click();true");
    ok(await fx.waitForEval("[...document.querySelectorAll('.modal-foot button')].some(x=>x.textContent==='在新材料上验证')?1:null"), '原执行表单显示验收项与新材料验证入口');
    await fx.evaluate("[...document.querySelectorAll('.modal-foot button')].find(x=>x.textContent==='在新材料上验证').click();true");
    ok(!fs.existsSync(path.join(fx.work, 'new-report.md')), '缺参数时保留执行表单，零写盘');
    await fx.evaluate("(() => {const b=[...document.querySelectorAll('.modal .pb-form')].find(x=>x.textContent.includes('新材料'));const fields=b.querySelectorAll('textarea');fields[0].value='new-b.txt';fields[1].value='new-report.md';[...b.closest('.modal-backdrop').querySelectorAll('.modal-foot button')].find(x=>x.textContent==='在新材料上验证').click();return true;})()");
    for (let i = 0; i < 400 && !fs.existsSync(path.join(fx.work, 'new-report.md')); i++) await new Promise(resolve => setTimeout(resolve, 30));
    ok(fs.readFileSync(path.join(fx.work, 'new-report.md'), 'utf8').includes('33.75'), '真实页面经普通Playbook执行工具生成新材料结果');
    await fx.waitForEval('!window.state.streaming?1:null', 240);
    await fx.evaluate("import('/js/i18n.js').then(m=>m.setLocale('en-US'))");
    await fx.evaluate("document.documentElement.dataset.theme='light';document.getElementById('skillBtn').click();true");
    await fx.waitForEval("[...document.querySelectorAll('#skillList .skill-item')].some(x=>x.textContent.includes('预算格式复用'))?1:null");
    await fx.evaluate("[...document.querySelectorAll('#skillList .skill-item')].find(x=>x.textContent.includes('预算格式复用')).click();true");
    await fx.waitForEval("[...document.querySelectorAll('.modal-foot button')].some(x=>x.textContent==='Copy and edit rules')?1:null");
    await fx.evaluate("[...document.querySelectorAll('.modal-foot button')].find(x=>x.textContent==='Copy and edit rules').click();true");
    ok(await fx.waitForEval(`document.querySelector('${editor}')?1:null`), '英文入口可复制修改，原版保留');
    await fx.evaluate(`Promise.all(document.querySelector('${editor}').closest('.modal-backdrop').getAnimations({subtree:true}).map(a=>a.finished)).then(()=>true)`);
    fs.writeFileSync(path.join(fx.root, 'reuse-en-light.png'), await fx.screenshot());
    await fx.escape();
    ok((await fx.request('GET', '/api/playbooks')).json.playbooks.filter(p => p.reuse).length === 1, '取消副本不改变已保存原版');
    ok(exceptions.length === 0, '浏览器无未捕获异常'); console.log('ARTIFACTS ' + fx.root);
  } catch (error) { t.fail(error.stack || String(error)); }
  finally { if (releaseDraft) releaseDraft(); if (fx) await fx.close({ keepRoot: true }); t.done({ exit: true }); }
})();
