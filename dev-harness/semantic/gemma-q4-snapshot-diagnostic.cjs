'use strict';
// Research-only bounded diagnostics. Never emit exception messages, payloads,
// paths, credential fields or stack traces.
const fs=require('node:fs'),crypto=require('node:crypto');
const H=x=>crypto.createHash('sha256').update(x).digest('hex');
function own(value,key){try{const d=Object.getOwnPropertyDescriptor(value,key);return d&&Object.hasOwn(d,'value')?d.value:undefined;}catch{return undefined;}}
function name(value){return ['Error','TypeError','RangeError','SyntaxError','AssertionError','AbortError'].includes(value)?value:null;}
function code(value){return typeof value==='string'&&/^(?:E[A-Z0-9_]{1,30}|(?:work_data|work_data_setup|work_data_adapter|work_data_store|work_data_snapshot|ruyi)\.[a-z0-9_.-]{1,60})$/.test(value)?value:null;}
function errorShape(error){const rows=[];let e=error;for(let i=0;i<3&&e&&typeof e==='object';i++){rows.push({name:name(own(e,'name'))||(e instanceof Error?'Error':null),code:code(own(e,'code'))});e=own(e,'cause');}return rows;}
function create(write,{stopBeforeBackup=false}={}){if(typeof write!=='function')throw Error('diagnostic.writer_required');return Object.freeze({async run(stage,fn){if(!['full.seal','space','saveBackup'].includes(stage)||typeof fn!=='function')throw Error('diagnostic.stage_invalid');write({stage,event:'before'});if(stage==='saveBackup'&&stopBeforeBackup){write({stage,event:'stopped'});throw Object.assign(Error('diagnostic stop'),{code:'work_data.diagnostic_stop_before_backup'});}try{const value=await fn();write({stage,event:'after'});return value;}catch(e){write({stage,event:'error',errors:errorShape(e)});throw e;}}});}
function transform(source){const replacements=[
 ["const captured = await full().seal({ password: context.password, appVersion: VERSION, generation: expected.generation });","const captured = await ResearchSnapshotProbe.run('full.seal',()=>full().seal({ password: context.password, appVersion: VERSION, generation: expected.generation }));"],
 ["await requireSpace([[backupDirectory,BigInt(Buffer.byteLength(captured.serialized,'utf8'))+1048576n+allocation],[base,context.operation==='export'?1048576n:allocation+1048576n]]);","await ResearchSnapshotProbe.run('space',()=>requireSpace([[backupDirectory,BigInt(Buffer.byteLength(captured.serialized,'utf8'))+1048576n+allocation],[base,context.operation==='export'?1048576n:allocation+1048576n]]));"],
 ["const backup = await saveBackup(Buffer.from(captured.serialized,'utf8'));","const backup = await ResearchSnapshotProbe.run('saveBackup',()=>saveBackup(Buffer.from(captured.serialized,'utf8')));"]
 ];let result=source;for(const [a,b] of replacements){if(result.split(a).length!==2)throw Error('diagnostic.source_boundary');result=result.replace(a,b);}return {source:result,originalSha256:H(source),derivedSha256:H(result),replacements};}
function fileProbe(file){return create(row=>fs.appendFileSync(file,JSON.stringify(row)+'\n',{encoding:'utf8',mode:0o600}),{stopBeforeBackup:true});}
module.exports={create,errorShape,transform,fileProbe};
