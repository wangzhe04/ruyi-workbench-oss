'use strict';

require('../lib/self-isolate-home');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {startBrowserFixture} = require('../lib/browser-fixture');

const [packArg, expected, outputArg] = process.argv.slice(2);
assert.ok(packArg && /^[a-f0-9]{64}$/.test(expected || '') && outputArg,
  'Usage: node memory-fallback-browser-package.cjs <extracted package> <server SHA-256> <new receipt>');
const pack = path.resolve(packArg), output = path.resolve(outputArg);
const pin = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(pin(path.join(pack,'app/server.js')),expected);
assert.equal(fs.existsSync(output),false);
const locale = JSON.parse(fs.readFileSync(path.join(pack,'app/public/locales/zh-CN.json'),'utf8'));
const report = {serviceSha256:expected,status:'FAIL',assertions:[]};
const record = (condition,label) => {report.assertions.push({label,pass:Boolean(condition)});assert.ok(condition,label);};

async function main() {
  let fx;
  const prompts = [];
  try {
    fx = await startBrowserFixture({
      prefix:'ruyi-memory-defer-',
      workbenchRoot:pack,
      config:{semanticRetrievalV1:false,runtimeMemoryVectorRecallV1:true,permissionMode:'bypass',stewardEnabledV1:false},
      serverEnv:{HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',RUYI_DISABLE_SEMANTIC:'0'},
      provider:ctx=>{
        prompts.push(...ctx.messages.filter(row=>row.role==='user').map(row=>typeof row.content==='string'
          ?row.content:row.content.map(block=>block.text||'').join('\n')));
        ctx.text('Fixture response.');
        ctx.stop();
      },
      ok:record,
    });
    for (const memory of [
      {id:'deployment-release',name:'Deployment release checklist',description:'Review release notes.'},
      {id:'deployment-review',name:'Deployment rollback review',description:'Review rollback owners.'},
      {id:'rule-format',name:'Default document style',description:'Use numbered paragraphs.',type:'convention'},
      {id:'core-example',name:'Stable output preference',description:'Keep anonymous identifiers.',core:true,type:'preference'},
    ]) {
      const response = await fx.request('POST','/api/memory',{memory:{scope:'project',type:'reference',body:'Synthetic body.',...memory},cwd:fx.work});
      record(response?.status===200 && response.json?.ok===true, 'Saved owned fixture '+memory.id);
    }
    await fx.evaluate(`(() => {
      window.__semanticMemoryEvents = [];
      const fetchNow = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const response = await fetchNow(input, init);
        if (String(input?.url || input).includes('/api/chat/stream')) {
          response.clone().text().then(text => {
            for (const line of text.split('\\n')) {
              try { const event=JSON.parse(line); if(event.type==='meta')window.__semanticMemoryEvents.push(event.memoryCheck); } catch {}
            }
          });
        }
        return response;
      };
      return true;
    })()`);
    const config = path.join(fx.home,'config.json');
    const before = JSON.parse(fs.readFileSync(config,'utf8'));
    fs.writeFileSync(config,JSON.stringify({...before,semanticRetrievalV1:true}));
    await fx.evaluate(`(() => {
      const prompt = document.getElementById('promptInput');
      prompt.value = 'deployment';
      prompt.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('sendBtn').click();
      return true;
    })()`);
    const check = await fx.waitForEval('window.__semanticMemoryEvents.at(-1)',240);
    report.memoryCheck = check;
    record(check?.matchCount===2 && check.ruleFillCount===1 && check.coreActiveCount===1,'Actual chat meta keeps two lexical hits, one fill and one core memory');
    record(['loading','overloaded','timeout','partial'].includes(check.semantic?.fallback?.reason),'Semantic preparation or contention deferred the reranker');
    const expectedText = locale[check.semantic.fallback.reason==='loading'?'memory.check.semanticPreparing':'memory.check.semanticFallback'];
    const ui = await fx.waitForEval(`(() => {
      const text = document.getElementById('toolOutput')?.textContent || '';
      return text.includes(${JSON.stringify(expectedText)}) ? text.split('\\n').filter(line => line.includes('记忆')) : null;
    })()`,240);
    report.ui = ui;
    record(ui?.some(line=>line.includes(expectedText)),'Browser tool output rendered the actual fallback notification');
    record(ui?.some(line=>line.includes('匹配 2 条')&&line.includes('默认规则 1 条')&&line.includes('核心记忆 1 条')),'Browser showed separate counts');
    const prompt = prompts.find(text=>text.includes('semantic-fallback='));
    const markup = prompt?.match(/<workbench-memory-check[^>]+>/)?.[0];
    report.promptReceipt = markup;
    record(markup?.includes('matches="2"')&&markup.includes('rule-fill="1"')&&markup.includes(`semantic-fallback="${check.semantic.fallback.reason}"`),
      'Provider received matching structured fallback receipt');
    record(prompt?.includes('[deployment-release](project)')&&prompt.includes('[deployment-review](project)'),
      'Both authorized lexical results were in the prompt');
    record(fx.exceptions.length===0,'No browser page exception');
    report.status='PASS';
  } finally {
    if (fx) await fx.close();
  }
}

main().catch(error=>{report.error=String(error.stack);process.exitCode=1;}).finally(()=>{
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({output,status:report.status,error:report.error}));
});
