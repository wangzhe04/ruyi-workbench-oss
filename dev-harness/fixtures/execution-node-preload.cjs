'use strict';
// Test-owned service only. Delay the real first node flush until a sibling reaches
// the normal guard; no dispatch/result/history implementation is replaced.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const root=process.env.RUYI_NODE_TEST_ROOT;if(!root||!path.isAbsolute(root))throw new Error('isolated node fixture root required');
const control=path.join(root,'node-control'),directory=path.join(root,'data/desktop-executions-v1');
const rename=fs.promises.rename;let faulted=false;
fs.promises.rename=async function(from,to){
  const mode=fs.existsSync(control)?fs.readFileSync(control,'utf8'):'';
  let value;
  if(!faulted&&path.dirname(to)===directory&&['history_eio','intent_eio','reservation_loss'].includes(mode)){
    value=JSON.parse(fs.readFileSync(from,'utf8'));
    if(mode==='history_eio'&&/^delivery-[a-f0-9]{32}\.json$/.test(path.basename(to))&&Array.isArray(value.history)
        ||mode==='intent_eio'&&path.basename(to).startsWith('intent-')&&value.kind==='foreground_node_intent'){
      faulted=true;fs.writeFileSync(path.join(root,'node-fault-hit.json'),JSON.stringify({mode,invocationId:value.invocationId||null,history:value.history}));
      throw Object.assign(new Error('isolated node '+mode),{code:'EIO'});
    }
  }
  const result=await rename.call(this,from,to);
  if(!faulted&&mode==='reservation_loss'&&to===path.join(directory,'state.json')){
    const row=value?.entries?.at(-1);
    if(row?.nodeDelivery&&row.phase==='prepared'){
      faulted=true;fs.unlinkSync(path.join(directory,row.nodeDelivery.file));
      fs.writeFileSync(path.join(root,'node-fault-hit.json'),JSON.stringify({mode,invocationId:row.invocationId}));
    }
  }
  return result;
};
const compile=Module.prototype._compile;
Module.prototype._compile=function(source,file){
  if(process.env.RUYI_NODE_TEST_SERVER&&path.isAbsolute(file)&&fs.realpathSync(file)===fs.realpathSync(process.env.RUYI_NODE_TEST_SERVER)){
    const anchor='Object.assign(DesktopExecutionHooks, DesktopExecutionRuntime);';
    if(!source.includes(anchor))throw new Error('Exact node fixture hook anchor missing');
    const install=path.join(__dirname,'execution-node-hooks.cjs');
    source=source.replace(anchor,anchor+'\nrequire('+JSON.stringify(install)+')(DesktopExecutionHooks,'+JSON.stringify(root)+');\n');
  }
  return compile.call(this,source,file);
};
