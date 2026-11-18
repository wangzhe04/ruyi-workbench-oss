'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const publicRoot = path.resolve(__dirname,'../../ruyi-workbench/app/public');
const source = fs.readFileSync(path.join(publicRoot,'js/chat-stream-runtime.js'),'utf8');
const start = source.indexOf('const mc = evt.memoryCheck;');
const end = source.indexOf('if (!replayingStream) appendToolOutput',start);
assert.ok(start >= 0 && end > start);

for (const locale of ['zh-CN','en-US']) {
  test(locale+' chat meta distinguishes preparation, fallback and ready counts',()=>{
    const strings = JSON.parse(fs.readFileSync(path.join(publicRoot,'locales',locale+'.json'),'utf8'));
    const t = (key,params={})=>strings[key].replace(/\{\{(\w+)\}\}/g,(_,name)=>params[name]);
    const memoryCheck = {enabled:true,checked:true,candidateCount:4,matchCount:2,projectMatches:2,globalMatches:0,coreActiveCount:1,ruleFillCount:1};
    // 151 阶段 1D：这一段还会把 memoryCheck 挂到本回合 live 上（消息尾标的数据源）；无 live 时不挂。
    const render = semantic => vm.runInNewContext(source.slice(start,end)+'\nmemoryLine;', {evt:{memoryCheck:{...memoryCheck,semantic}},t,live:null});
    const live = {};
    vm.runInNewContext(source.slice(start,end), {evt:{memoryCheck},t,live});
    assert.equal(live.memoryCheck, memoryCheck, 'the live turn keeps the memory check for the message badge');
    const expectedCounts = t('memory.check.done',{candidates:4,matches:2,project:2,global:0})
      + t('memory.check.core',{core:1}) + t('memory.check.fill',{fill:1});
    assert.equal(render({status:'ready'}),'\n'+expectedCounts);
    assert.equal(render({status:'loading',fallback:{reason:'loading'}}),'\n'+expectedCounts+'\n'+t('memory.check.semanticPreparing'));
    for (const reason of ['timeout','overloaded','partial','unavailable','truncated']) {
      assert.equal(render({status:reason,fallback:{reason}}),'\n'+expectedCounts+'\n'+t('memory.check.semanticFallback'));
    }
  });
}
