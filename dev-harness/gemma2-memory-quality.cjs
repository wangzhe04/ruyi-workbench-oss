'use strict';
// Real model, real memory headers, normal workbench_memory_list tool.
// Run explicitly with a prepared development profile or an extracted offline package.
require('./lib/self-isolate-home');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const {performance} = require('node:perf_hooks');

async function main() {
  const root = path.resolve(process.argv[2] || path.join(__dirname, '../ruyi-workbench'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-real-memory-'));
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  Object.assign(process.env, {RUYI_HOME:home, WIN_CLAUDE_WORKBENCH_HOME:home, RUYI_DISABLE_SEMANTIC:'0'});
  const config = {configSchema:9, permissionMode:'bypass', semanticRetrievalV1:true, runtimeMemoryVectorRecallV1:true, autoImportClaudeCodeMcp:false};
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(config));
  const file = path.join(root, 'app/server.js');
  const mod = new Module(file, module);
  mod.filename = file;
  mod.paths = Module._nodeModulePaths(path.dirname(file));
  mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.testHost={activeChildren,SemanticRuntimeHooks};', file);
  const srv = mod.exports;
  const {activeChildren, SemanticRuntimeHooks: runtime} = srv.testHost;
  const session = await srv.createSession({title:'memory quality', cwd});
  session.turnSeq = 1;
  activeChildren.set(session.id, {state:'running',session});
  const ctx = {session, sessionId:session.id, workingDir:cwd, turnSeq:1, config};
  const rows = [
    ['release-a','发布习惯','正式上线前先在少量机器上试运行。'],
    ['release-b','发版流程','逐步扩大流量，有异常就回到上一个版本。'],
    ['finance-a','交通报销','报销交通费用要同时提交车票和付款凭证。'],
    ['finance-b','差旅报账','住宿发票与行程单要放在同一个申请里。'],
    ['photo-a','照片归档','照片归档使用拍摄日期创建文件夹。'],
    ['photo-b','整理相册','保留原始照片，把编辑版本单独存放。'],
    ['network','路由器','家用路由器的重启时间安排在周日凌晨。'],
  ];
  const cases = [
    ['新版本如何分批投产？',['release-a','release-b']],
    ['出差回来核销开支，有哪些材料要交？',['finance-a','finance-b']],
    ['影像素材应该怎样分类保管？',['photo-a','photo-b']],
    ['后院盆栽的浇水周期是多久？',[]],
    ['天文望远镜如何校准赤道仪？',[]],
  ];
  try {
    for (const [id,name,description] of rows)
      assert.equal((await srv.saveMemory({id,scope:'project',type:'reference',name,description,body:'synthetic'},cwd)).ok,true);
    const start = performance.now();
    const deadline=Date.now()+30000;
    let descriptor;
    do {
      descriptor=await runtime.prepare({deadline});
      if(descriptor.available || descriptor.state!=='loading')break;
      await new Promise(resolve=>setTimeout(resolve,150));
    } while(Date.now()<deadline);
    assert.equal(descriptor.modelId,'embeddinggemma-2-text-q4',JSON.stringify({state:descriptor.state,reason:descriptor.reason,detail:descriptor.detail}));
    assert.equal(descriptor.available,true);
    console.log('model',descriptor.modelId,'prepareMs',Math.round(performance.now()-start));
    let correct=0, wrong=0, empty=0;
    for (const [query,expected] of cases) {
      const started=performance.now();
      let result;
      do {
        result=await srv.toolCall('workbench_memory_list',{query,limit:12},ctx);
        assert.equal(result.ok,true);
        if(result.semantic?.coverage?.complete)break;
        await new Promise(resolve=>setTimeout(resolve,150));
      } while(performance.now()-started<15000);
      assert.equal(result.semantic?.coverage?.complete,true);
      assert.equal(result.semantic.admissionPolicy,'embeddinggemma2-memory-distinct-k3-cos070-v1');
      const ids=result.memories.filter(row=>['semantic','lexical'].includes(row.retrieval?.kind)).map(row=>row.id);
      assert.equal(new Set(ids).size,ids.length);
      correct+=ids.filter(id=>expected.includes(id)).length;
      wrong+=ids.filter(id=>!expected.includes(id)).length;
      if(!expected.length&&!ids.length)empty++;
      console.log(JSON.stringify({query,expected,ids,ms:Math.round(performance.now()-started)}));
    }
    console.log(JSON.stringify({correct,possible:6,wrong,empty,noAnswer:2}));
    assert.equal(wrong,0);
    assert.equal(empty,2);
    assert.equal(correct,6,'all six relevant memories are recalled');
  } finally {
    activeChildren.delete(session.id);
    assert.equal((await runtime.shutdown()).ok,true);
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
