'use strict';
require('./lib/self-isolate-home');
const fs = require('fs');
const path = require('path');
const { createRunner } = require('./lib/harness');
const { startBrowserFixture, sleep } = require('./lib/browser-fixture');
const t = createRunner('STEWARD ATTACHMENTS BROWSER');
const { ok } = t;
let fx;
(async () => {
  try {
    fx = await startBrowserFixture({ prefix: 'ruyi-steward-attachments-ui-', ok,
      provider: ctx => { ctx.text('处理完成。'); ctx.stop(); } });
    const created = await fx.request('POST', '/api/sessions', { title: '附件续办验收', cwd: fx.work });
    const sid = created.json.session.id;
    const reloaded = new Promise(resolve => fx.cdp.on('Page.loadEventFired', resolve));
    await fx.cdp.send('Page.reload');
    await reloaded;
    await fx.waitForEval("window.state && window.state.config && window.state.config.activeProvider === 'fake' ? 1 : null");
    await fx.setLens('steward');
    if (!await fx.waitForEval("document.getElementById('stewardTarget') ? 1 : null", 300)) throw new Error('composer not mounted: ' + JSON.stringify(fx.exceptions));
    await fx.evaluate(`(() => {
      const original = window.fetch.bind(window);
      window.__attachmentActs = []; window.__lastUpload = null; window.__dropAttachmentReply = false;
      window.fetch = async (url, init) => {
        const route = String(url);
        if (route.includes('/api/steward/act') && init && init.body && JSON.parse(init.body).act) window.__attachmentActs.push(JSON.parse(init.body));
        const response = await original(url, init);
        if (route.endsWith('/api/upload')) window.__lastUpload = (await response.clone().json()).file;
        if (route.includes('/api/steward/act') && init && JSON.parse(init.body || '{}').act && window.__dropAttachmentReply) {
          window.__dropAttachmentReply = false; throw new TypeError('simulated response loss');
        }
        return response;
      };
      return true;
    })()`);
    const select = async () => {
      await fx.evaluate("(() => { const input = document.getElementById('stewardComposerInput'); input.value = '附件续办验收 请更新'; input.dispatchEvent(new Event('input', { bubbles: true })); return true; })()");
      if (!await fx.waitForEval("document.querySelector('#stewardTarget .steward-target-label').textContent.includes('附件续办验收')", 200)) throw new Error('preroute did not find target');
      await fx.evaluate("document.getElementById('stewardTarget').click(); true");
      ok(await fx.waitForEval(`(() => {
        const option = [...document.querySelectorAll('#stewardTargetPicker .steward-target-option')].find(node => node.textContent.includes('附件续办验收'));
        if (!option) return null; option.click(); return true;
      })()`, 100), '候选里可以手选原任务');
    };
    const upload = async name => {
      await fx.evaluate(`(() => {
        window.__lastUpload = null;
        const data = new DataTransfer(); data.items.add(new File(['月份,金额\\n十月,123'], ${JSON.stringify(name)}, { type: 'text/csv' }));
        const input = document.getElementById('stewardComposerFile'); input.files = data.files; input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      })()`);
      return fx.waitForEval('window.__lastUpload');
    };
    const send = async text => fx.evaluate(`(() => {
      const input = document.getElementById('stewardComposerInput'); input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return true;
    })()`);
    const click = async label => fx.evaluate(`(() => {
      const node = [...document.querySelectorAll('#stewardFeed .steward-act')].filter(n => n.textContent.trim() === ${JSON.stringify(label)}).pop();
      if (!node) return false; node.click(); return true;
    })()`);
    await select();
    ok(await fx.evaluate("document.getElementById('stewardTargetPicker').textContent.includes('有限正文索引')"), '候选面板说明搜索范围和未命中的边界');
    const first = await upload('新表.csv');
    ok(first && first.id, '真实附件控件完成上传');
    await fx.evaluate('window.__dropAttachmentReply = true; true');
    await send('根据新表修改原报告');
    ok(await fx.waitForEval("document.getElementById('stewardFeed').textContent.includes('未确认')"), '回包丢失时显示未确认,原附件保留在对话中');
    const bodies = await fx.evaluate('window.__attachmentActs');
    ok(bodies[0].act.args.sessionId === sid && bodies[0].act.args.attachments[0].id === first.id, '手选目标与附件一起递送');
    ok(await click('核对是否已递到'), '未确认行可以核对回执');
    ok(await fx.waitForEval("document.getElementById('stewardFeed').textContent.includes('已经递到')"), '核对结果显示已经递到');
    const second = await upload('过期资料.csv');
    fs.unlinkSync(second.path);
    await select();
    await send('再按第二张表修改');
    ok(await fx.waitForEval("document.getElementById('stewardFeed').textContent.includes('原话和附件已保留')"), '明确拒绝时原提示保存原话、附件和目标');
    await fx.evaluate("document.getElementById('stewardComposerInput').value = '这是一份新草稿'; true");
    fs.writeFileSync(second.path, 'new data');
    let idle = false;
    for (let i = 0; i < 150; i++) {
      const state = await fx.request('GET', '/api/sessions/' + sid);
      if (state && state.json && state.json.ok && !state.json.relay) { idle = true; break; }
      await sleep(50);
    }
    if (!idle) throw new Error('target has not become idle');
    ok(await click('重发这一次'), '附件恢复后可在原行重试');
    ok(await fx.waitForEval("document.getElementById('stewardFeed').textContent.includes('已重新递送')", 150), '重试成功有真实回执');
    ok(await fx.evaluate("document.getElementById('stewardComposerInput').value === '这是一份新草稿'"), '迟到重试结果不覆盖新草稿');
    const attempts = (await fx.evaluate('window.__attachmentActs')).filter(row => row.act);
    ok(attempts.length === 3 && attempts[1].attemptId === attempts[2].attemptId && attempts[1].act.args.attachments[0].id === attempts[2].act.args.attachments[0].id, '重试保持原 attempt、目标与附件身份');
    const session = await fx.request('GET', '/api/sessions/' + sid);
    const users = session.json.session.messages.filter(row => row.role === 'user');
    ok(users.length === 2 && users.every(row => row.attachments.length === 1), '两次递送各落一条消息,回包丢失和重试不重复执行');
    await fx.evaluate("document.getElementById('cfgSearchType').value = 'deepseek'; document.getElementById('cfgSearchType').dispatchEvent(new Event('change', { bubbles: true })); true");
    ok(await fx.evaluate("!document.getElementById('cfgSearchApiKeyRow').classList.contains('hidden') && !document.getElementById('cfgSearchBaseUrlRow').classList.contains('hidden')"), '选择 DeepSeek 后显示 API Key 与可选端点');
    ok(fx.exceptions.length === 0, '浏览器没有未捕获异常');
    const shot = path.join(fx.root, 'attachments-verified.png');
    fs.writeFileSync(shot, await fx.screenshot());
    console.log('SCREENSHOT ' + shot);
    await fx.close({ keepRoot: true }); fx = null;
  } catch (error) { t.fail(error.stack); if (fx) console.log('BROWSER-DIAG ' + JSON.stringify(await fx.evaluate("({ mode: document.documentElement.dataset.shellMode, text: document.body.textContent.slice(-1200) })"))); }
  finally { if (fx) await fx.close(); }
  t.done({ exit: true });
})();
