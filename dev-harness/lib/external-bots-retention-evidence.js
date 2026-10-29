'use strict';
// Opt-in observations of synthetic retention fixtures. No spawning, killing, requests or product hooks.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
function createRetentionEvidence(kind,options={}) {
  const base=options.directory??process.env.RUYI_RETENTION_E2E_EVIDENCE_DIR;
  if(!base)return null;
  if(!['http','browser'].includes(kind)||!path.isAbsolute(base))throw Error('retention evidence requires an absolute opt-in directory');
  const io=options.io||fs,output=io.mkdtempSync(path.join(base,'retention-'+kind+'-'));
  const artifacts=[],errors=[],children=new Map();let fixture=null,fixtureRoot='',fixtureHome='',sequence=0;
  const owned=()=>children.size>0||Boolean(fixture?.provider||fixture?.server||fixture?.browser);
  function persist(label,value) {
    if(!/^[a-z][a-z0-9_.-]{0,90}$/.test(label))throw Error('invalid evidence label');
    const bytes=Buffer.isBuffer(value)?value:Buffer.from(value),name=String(++sequence).padStart(6,'0')+'-'+label;
    const file=path.join(output,name),fd=io.openSync(file,'wx',0o600);
    try{let offset=0;while(offset<bytes.length){const written=io.writeSync(fd,bytes,offset,bytes.length-offset);if(!written)throw Error('short evidence write');offset+=written;}io.fsyncSync(fd);}finally{io.closeSync(fd);}
    const saved=io.readFileSync(file);if(saved.length!==bytes.length||hash(saved)!==hash(bytes))throw Error('evidence readback mismatch');
    const item={path:name,bytes:bytes.length,sha256:hash(saved)};artifacts.push(item);return item;
  }
  function attempt(work) {
    try{return work();}catch(error){errors.push({at:new Date().toISOString(),code:String(error.code||''),message:String(error.message||error)});if(!owned())throw error;return null;}
  }
  function event(type,data={}) {return attempt(()=>persist('event.json',JSON.stringify({type,at:new Date().toISOString(),monotonicNs:process.hrtime.bigint().toString(),...data})));}
  function bind(fx) {
    // The caller supplies only an isolated fixture root/home, never a general user-home reader.
    const root=io.realpathSync(fx.root||fx.home),home=io.realpathSync(fx.home),temp=io.realpathSync(os.tmpdir());
    if(!within(temp,root)||root===temp||!/^ruyi-/.test(path.basename(root))||!within(root,home))throw Error('retention evidence input must be an isolated ruyi TEMP fixture');
    fixture=fx;fixtureRoot=root;fixtureHome=home;
    event('fixture-bound',{root,home,output,kind});return fx;
  }
  function captureBytes(label,bytes) {return attempt(()=>persist(label,bytes));}
  function captureFile(label,file) {
    return attempt(()=>{if(!fixtureRoot)throw Error('fixture not bound');const resolved=io.realpathSync(file);if(!within(fixtureRoot,resolved))throw Error('evidence source outside isolated fixture');
      const stat=io.statSync(resolved);if(!stat.isFile())throw Error('evidence source is not a file');const bytes=io.readFileSync(resolved),saved=persist(label,bytes);event('file-captured',{source:resolved,observedMtimeMs:stat.mtimeMs,...saved});return saved;});
  }
  function observeChild(role,child,metadata={}) {
    // Hold the original reference before any diagnostic operation that can fail.
    const row={role,child,spawnSeen:false,exit:null,close:null};children.set(child,row);
    attempt(()=>{
      child.on('spawn',()=>{row.spawnSeen=true;event('actor-spawn',{role,pid:child.pid,spawnfile:child.spawnfile,spawnargs:child.spawnargs});});
      child.on('exit',(code,signal)=>{row.exit={code,signal};event('actor-exit',{role,pid:child.pid,code,signal});});
      child.on('close',(code,signal)=>{row.close={code,signal};event('actor-close',{role,pid:child.pid,code,signal});});
      event('actor-owned',{role,pid:child.pid,spawnfile:child.spawnfile,spawnargs:child.spawnargs,stdio:metadata.stdio,
        stdout:child.stdout?'original-stream':'ignored-or-unavailable',stderr:child.stderr?'original-stream':'ignored-or-unavailable'});
      for(const name of ['stdout','stderr'])if(child[name]){
        child[name].on('data',bytes=>captureBytes(role+'-'+name+'.bin',Buffer.from(bytes)));
        child[name].on('end',()=>event('actor-stdio-end',{role,pid:child.pid,stream:name}));
        child[name].on('close',()=>event('actor-stdio-close',{role,pid:child.pid,stream:name}));
      }
    });return child;
  }
  function cleanup(role,child,method) {event('cleanup-requested',{role,pid:child?.pid,method,mayForce:true,exitCode:child?.exitCode??null,signalCode:child?.signalCode??null});}
  function observeCdp(cdp) {
    attempt(()=>cdp.on('Runtime.consoleAPICalled',payload=>{
      if(payload?.type==='log'&&payload.args?.[0]?.value==='RUYI_RETENTION_EVIDENCE'&&typeof payload.args?.[1]?.value==='string')captureBytes('browser-transport.json',Buffer.from(payload.args[1].value,'utf8'));
    }));
  }
  const observer={
    beforeStart(fx){bind(fx);captureFile('config-before-actors.bin',path.join(fixtureHome,'config.json'));},
    provider(fx){fixture=fx;attempt(()=>{event('provider-owned',{listening:fx.provider.listening});fx.provider.on('close',()=>event('provider-close'));});},
    child:observeChild,
    cleanup(fx,role){fixture=fx;try{cleanup(role,fx[role],role==='provider'?'server.close':'original-killTree');}catch{/* Observations cannot interrupt original cleanup, including pre-start failure. */}},
  };
  function finish(originalFailure) {
    try{event('capture-finished',{originalFailure:originalFailure?String(originalFailure.message||originalFailure):null,diagnosticErrors:errors,
      actors:[...children.values()].map(row=>({role:row.role,pid:row.child.pid,spawnSeen:row.spawnSeen,exit:row.exit,close:row.close}))});
    attempt(()=>persist('manifest.json',JSON.stringify({kind,fixtureRoot,fixtureHome,artifacts:artifacts.slice(),diagnosticErrors:errors})));}catch(error){if(!originalFailure)throw error;}
    // Diagnostics never replace an actual test failure. Report incomplete evidence after original cleanup.
    if(errors.length&&!originalFailure)throw Error('retention evidence incomplete ('+errors.length+' diagnostic errors), retained at '+output);
  }
  return Object.freeze({output,bind,captureBytes,captureFile,event,observeChild,observeCdp,cleanup,observer,finish,
    get fixture(){return fixture;},snapshot:()=>({ownedChildren:children.size,diagnosticErrors:errors.slice(),artifacts:artifacts.slice()})});
}
module.exports={createRetentionEvidence};
