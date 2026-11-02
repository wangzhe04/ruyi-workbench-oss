'use strict';
// Passive, bounded observations of the original issued child. No stdin/kill/parser changes.
const {StringDecoder}=require('node:string_decoder'),{sha,LIMITS,PHASES}=require('./migration-native-short-rename-fixture');
function observeChild(child,{emit,latch,label,expected,now}) {
  const row={label,pid:child.pid??null,spawn:false,exit:false,close:false,stdoutEnd:false,stderrEnd:false,stdoutClose:false,stderrClose:false,acks:0,exitCode:null,exitSignal:null,closeCode:null,closeSignal:null,observationGap:false};
  const decoder=new StringDecoder('utf8');let line='',bytes=0,ordinal=0;
  const record=(type,data={})=>{try{emit(type,{label,...data});}catch{row.observationGap=true;latch('n1.observation_sink_failed');}};
  const gap=code=>{row.observationGap=true;latch(code);record('observation-gap',{code});};
  record('issued-child',{pid:row.pid,spawnAt:null,commandIssueObservable:false,closeRequestObservable:false});
  child.on('spawn',()=>{row.spawn=true;row.pid=child.pid;record('spawn',{pid:child.pid});});
  child.on('error',e=>{record('child-error',{code:typeof e?.code==='string'?e.code:'unclassified'});gap('n1.child_error');});
  child.on('exit',(code,signal)=>{row.exit=true;row.exitCode=code;row.exitSignal=signal;record('exit',{code,signal});});
  child.on('close',(code,signal)=>{row.close=true;row.closeCode=code;row.closeSignal=signal;record('close',{code,signal});});
  for(const name of ['stdout','stderr']){
    const stream=child[name];if(!stream||typeof stream.on!=='function'){gap('n1.child_pipe_unobservable');continue;}
    stream.on('end',()=>{if(name==='stdout'){try{line+=decoder.end();if(line!=='')gap('short_rename.wire_eof');}catch{gap('short_rename.wire_eof');}}row[name+'End']=true;record(name+'-end');});stream.on('close',()=>{row[name+'Close']=true;record(name+'-close');});stream.on('error',()=>gap('n1.child_pipe_error'));
    if(name==='stdout')stream.on('data',chunk=>{
      // Never throw from a listener or persist DATA/base64/PowerShell/compiler output.
      try{
        bytes+=chunk.length;if(bytes>LIMITS.wireBytes){line='';gap('n1.wire_limit');return;}
        line+=decoder.write(chunk);let at;
        while((at=line.indexOf('\n'))!==-1){const frame=line.slice(0,at);line=line.slice(at+1);ordinal++;
          const value=JSON.parse(frame);row.acks++;if(ordinal>expected.length||typeof value.ok!=='boolean'){gap('n1.wire_shape');return;}
          record('wire-response',{ordinal,sourceMappedCommand:expected[ordinal-1],actualRequestIssueTime:null,ok:value.ok,bytes:Buffer.byteLength(frame),sha256:sha(frame),
            ...(value.ok?{}:{code:typeof value.code==='string'&&/^[a-z0-9_]+$/.test(value.code)?value.code:'unclassified'})});
        }
      }catch{line='';gap('n1.wire_unobservable');}
    });
  }
  row.known=()=>row.spawn&&row.exit&&row.close&&row.exitCode===0&&!row.exitSignal&&row.closeCode===0&&!row.closeSignal&&row.stdoutEnd&&row.stderrEnd&&row.stdoutClose&&row.stderrClose&&!row.observationGap&&row.acks===expected.length&&line==='';
  return row;
}
function wrapSpawn(original,receiverContext){return function(...args){
  const {state,emit,latch,getPhase,rows,beforeNative,now}=receiverContext;
  const phase=getPhase(),expected=PHASES.find(x=>x[0]===phase)?.[1];if(!expected)throw Error('n1.unplanned_spawn');
  beforeNative(args);state.count('native');const start=now();
  // A guard denial is not swallowed or replaced; same original function/receiver/args.
  const child=Reflect.apply(original,this,args);
  const existing=rows.filter(x=>x.label===phase).length;
  const selected=expected.length===2&&expected.every(x=>x==='capture-preserved')?['capture-preserved']:expected;
  const row=observeChild(child,{emit:(type,data)=>emit(type,{...data,sinceSpawnCallMs:now()-start}),latch,label:phase,expected:selected,now});row.callOrdinal=existing+1;rows.push(row);return child;
};}
function install(cp,options){
  const originalSpawn=cp.spawn,originalSync=cp.spawnSync,rows=[],syncRows=[];
  const context={...options,rows};
  const spawn=wrapSpawn(originalSpawn,context);
  const spawnSync=function(...args){options.beforeMetadata(args);options.state.count('metadata');const start=options.now();
    options.emit('metadata-invoke',{label:options.getPhase(),timeoutMs:LIMITS.metadataMs,separateChildEventsObservable:false});
    const result=Reflect.apply(originalSync,this,args);
    const row={label:options.getPhase(),elapsedMs:options.now()-start,status:result.status,signal:result.signal??null,errorCode:result.error?.code??null,
      stdoutBytes:Buffer.byteLength(result.stdout||''),stdoutSha256:sha(result.stdout||''),stderrBytes:Buffer.byteLength(result.stderr||''),stderrSha256:sha(result.stderr||'')};
    syncRows.push(row);options.emit('metadata-return',row);
    if(result.error||result.signal||result.status!==0)options.latch('n1.metadata_failed_or_unproven');return result;
  };
  cp.spawn=spawn;cp.spawnSync=spawnSync;
  return {rows,syncRows,allKnown:()=>rows.every(x=>x.known())&&syncRows.every(x=>x.status===0&&!x.signal&&!x.errorCode),
    restore(){if(cp.spawn!==spawn||cp.spawnSync!==spawnSync){options.latch('n1.observer_replaced');return;}cp.spawn=originalSpawn;cp.spawnSync=originalSync;}};
}
module.exports={observeChild,wrapSpawn,install};
