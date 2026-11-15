'use strict';
// Bounded scheduling rendezvous around genuine host methods; never changes a result,
// authority decision, dispatch packet, receipt or persisted history.
module.exports=function installNodeHooks(hooks,root){
  const fs=require('node:fs'),path=require('node:path');
  const file=name=>path.join(root,name),mode=()=>fs.existsSync(file('node-control'))?fs.readFileSync(file('node-control'),'utf8'):'';
  const pauseUntil=async(name)=>{const deadline=Date.now()+5000;while(!fs.existsSync(file(name))){if(Date.now()>deadline)throw new Error('bounded node fixture rendezvous timed out');await new Promise(resolve=>setTimeout(resolve,10));}};
  const flush=hooks.flushNode,guard=hooks.guard,invoke=hooks.invoke,nodeWaiting=hooks.nodeWaiting;
  let paused=false,observed=false,stopped=false;
  hooks.nodeWaiting=function(key,waiting){
    const result=nodeWaiting(key,waiting);
    if(key&&waiting&&mode()==='resource_wait'&&!fs.existsSync(file('node-resource-requested'))){fs.writeFileSync(file('node-resource-requested'),JSON.stringify({pid:process.pid}));}
    return result;
  };
  hooks.flushNode=async function(key){
    if(!paused&&mode()==='delay_first_node_flush'){
      paused=true;fs.writeFileSync(file('node-flush-paused'),JSON.stringify({pid:process.pid,stage:'before_actual_node_flush'}));
      await pauseUntil('node-flush-release');
    }
    const result=await flush(key);
    if(!stopped&&key&&mode()==='stop_after_delivery'){
      stopped=true;fs.writeFileSync(file('node-stop-paused'),JSON.stringify({pid:process.pid,stage:'after_actual_node_delivery'}));
      await pauseUntil('node-stop-release');
    }
    return result;
  };
  hooks.guard=async function(id){
    if(fs.existsSync(file('node-flush-paused'))&&!fs.existsSync(file('node-flush-release')))fs.writeFileSync(file('node-flush-release'),'sibling_at_actual_guard');
    return guard(id);
  };
  hooks.invoke=async function(client,name,args,options,key){
    if(!observed&&typeof args?.label==='string'&&args.label.includes('NODE_FOREGROUND_DISPATCH_GAP worker1')){
      observed=true;
      const pending=invoke(client,name,args,options,key);pending.catch(()=>{});
      await new Promise(resolve=>setTimeout(resolve,150));
      const state=JSON.parse(fs.readFileSync(file('data/desktop-executions-v1/state.json'),'utf8'));
      const blocked=JSON.parse(fs.readFileSync(file('node-acc-blocked.json'),'utf8'));
      const first=state.entries.find(row=>row.invocationId===blocked.invocationId);
      fs.writeFileSync(file('node-dispatch-observation.json'),JSON.stringify({first,rows:state.entries.filter(row=>row.sessionId===first.sessionId)}));
      fs.writeFileSync(file('node-acc-release'),'release');
      return pending;
    }
    return invoke(client,name,args,options,key);
  };
};
