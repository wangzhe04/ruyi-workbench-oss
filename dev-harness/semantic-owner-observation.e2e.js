'use strict';

require('./lib/self-isolate-home');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { releaseEnvironment } = require('./lib/release-checks');
const { loadServerInternals } = require('./lib/server-internals');
const { createRunner } = require('./lib/harness');

const runner = createRunner('SEMANTIC OWNER OBSERVATION');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ruyi-semantic-observation-'));
const env = releaseEnvironment(path.join(root, 'home'), path.join(root, 'data'));
Object.assign(process.env, env);
const { SemanticRuntimeClient, SemanticRuntimeProviders } = loadServerInternals(['SemanticRuntimeClient', 'SemanticRuntimeProviders']);
const birth = '134400000000000001';
const live = pid => ({ exists: true, pid, creationFileTime: birth });
const fingerprint = 'a'.repeat(64);

// A real NDJSON child and pipe close exercise the production owner's transitions.
// Only the OS observation is controlled: a process close alone cannot authorize cleanup.
const worker = [
  "const fp = '" + fingerprint + "';",
  "console.log(JSON.stringify({type:'ready',modelFingerprint:fp,dimensions:8}));",
  "require('node:readline').createInterface({input:process.stdin}).on('line', line => {",
  " const req=JSON.parse(line); console.log(JSON.stringify({ok:true,requestId:req.requestId,modelFingerprint:fp,vectors:req.texts.map(()=>[1,0,0,0,0,0,0,0])}));",
  "});"
].join('\n');

async function exercise(label, first, last, expected) {
  const directory = fs.mkdtempSync(path.join(root,'case-'));
  const factories = [], starts = [], cleaned = [], exits = [], samples = [];
  let choice = 'original';
  function backend(id) {
    factories.push(id);
    let observations = 0;
    return SemanticRuntimeClient.create({
      enabled: async () => true,
      key: () => path.join(directory, id),
      settings: () => ({command:process.execPath,args:['-e',worker],cwd:directory,env,onObservedExit:()=>cleaned.push(id)}),
      spawn(...args) {
        const child = cp.spawn(...args);
        starts.push(id);
        exits.push(new Promise(resolve => child.once('close', resolve)));
        return child;
      },
      observe: async pid => {
        const initial = observations++ === 0;
        if (id === 'original') {
          const row = await (initial ? first : last)(pid);
          samples.push({requestedPid:pid,...row});
          return row;
        }
        return initial ? live(pid) : {exists:false};
      }
    });
  }
  const router = SemanticRuntimeProviders.create({
    factories: {original:()=>backend('original'),legacy:()=>backend('legacy')},
    selection: async () => ({id:choice,signature:choice,enabled:true})
  });
  try {
    const initial = await router.prewarm();
    assert.equal(initial.available === true, expected.ready, label + ': initial readiness');
    choice = 'legacy';
    const switched = await router.encode(['fixture query'], {role:'query',budgetMs:5000});
    console.log('OBSERVE ' + JSON.stringify({label,initial:initial.available,switched:switched.ok,
      state:switched.state,samples,factories,starts,cleaned,fenced:router.stats().fenced}));
    if (expected.release) {
      assert.equal(switched.ok,true);
      assert.deepEqual(factories,['original','legacy']);
      assert.deepEqual(starts,['original','legacy']);
      assert.deepEqual(cleaned,['original']);
    } else {
      assert.equal(switched.state,'unknown');
      assert.equal(switched.ok,false);
      assert.equal(router.stats().fenced,true);
      choice = 'original';
      assert.equal((await router.prewarm()).state,'unknown');
      assert.equal((await router.encode(['unchanged choice'],{role:'query'})).ok,false);
      assert.equal(router.descriptor().available,false);
      assert.equal(router.stats().backend.queryTexts,0);
      assert.deepEqual(factories,['original']);
      assert.deepEqual(starts,['original']);
      assert.deepEqual(cleaned,[]);
    }
    runner.ok(true,label);
  } finally {
    await router.shutdown();
    await Promise.all(exits);
  }
}

async function main() {
  const invalid = [
    ['missing creation time',pid=>({exists:true,pid})],
    ['wrong PID',pid=>({...live(pid),pid:pid+1,creationFileTime:'134400000000000002'})],
    ['missing PID',pid=>({exists:true,creationFileTime:birth})],
    ['numeric creation time',pid=>({...live(pid),creationFileTime:42})],
    ['zero creation time',pid=>({...live(pid),creationFileTime:'0'})],
    ['noncanonical creation time',pid=>({...live(pid),creationFileTime:'0'+birth})],
    ['outside DateTime range',pid=>({...live(pid),creationFileTime:'2650467744000000000'})],
    ['overflow creation time',pid=>({...live(pid),creationFileTime:'99999999999999999999'})],
    ['malformed exists',pid=>({...live(pid),exists:'true',creationFileTime:'134400000000000002'})],
    ['absence with live birth identity',pid=>({...live(pid),exists:false})],
    ['absence for another PID',pid=>({exists:false,pid:pid+1})]
  ];
  for (const [name,observation] of invalid) {
    await exercise('terminal '+name,live,observation,{ready:true,release:false});
    await exercise('initial '+name,observation,()=>({exists:false}),{ready:false,release:false});
  }
  if (process.platform === 'win32') {
    await exercise('Windows observed this real child live and then absent', SemanticRuntimeClient.observeProcess, SemanticRuntimeClient.observeProcess, {ready:true,release:true});
  }
  await exercise('same process remains',live,live,{ready:true,release:false});
  await exercise('original PID has a new creation time',live,pid=>({...live(pid),creationFileTime:'134400000000000002'}),{ready:true,release:true});
  await exercise('original PID absent',live,()=>({exists:false}),{ready:true,release:true});
  await exercise('original PID explicitly absent',live,pid=>({exists:false,pid}),{ready:true,release:true});
  await exercise('absent before initial identity and stream closed',()=>({exists:false}),()=>({exists:false}),{ready:false,release:true});
}
main().catch(e=>runner.fail(e.stack)).finally(()=>{fs.rmSync(root,{recursive:true,force:true});runner.done();});
