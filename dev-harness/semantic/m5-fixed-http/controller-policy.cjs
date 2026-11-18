'use strict';
// Policy model for fixed group/human test coordinator; no process starts here.
const path=require('node:path');const fault=code=>Object.assign(Error(code),{code});
function buildPlan({node,root,home,systemRoot,guard,fixture,output}){if(![node,root,home,systemRoot,guard,output].every(x=>typeof x==='string'&&path.isAbsolute(x)))throw fault('M5_PLAN_PATH');const allowed=['external-bots-group-decisions.e2e.js','external-bots-human-decisions.e2e.js'];if(!allowed.includes(fixture))throw fault('M5_PLAN_FIXTURE');const inside=(parent,child)=>{const x=path.relative(parent,child);return x!==''&&!x.startsWith('..'+path.sep)&&x!=='..'&&!path.isAbsolute(x);};if(!inside(root,home)||!inside(root,guard)||!inside(root,output))throw fault('M5_PLAN_SCOPE');const system=path.join(systemRoot,'System32');return Object.freeze({node,args:Object.freeze(['--require',guard,path.join(root,'dev-harness',fixture)]),cwd:root,env:Object.freeze({SystemRoot:systemRoot,WINDIR:systemRoot,SystemDrive:path.parse(systemRoot).root.replace(/[\\/]+$/,""),PATH:system,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'roaming'),LOCALAPPDATA:path.join(home,'local'),TEMP:path.join(home,'tmp'),TMP:path.join(home,'tmp'),RUYI_REAL_HOME:path.join(root,'synthetic-never-use'),RUYI_M5_ROLE:'fixture',RUYI_M5_FROZEN_ROOT:root,RUYI_M5_GUARD:guard,RUYI_M5_PROCESS_EVENTS:path.join(output,'guard-child-events.jsonl'),NODE_OPTIONS:''}),budgets:Object.freeze({runnerMs:120000,groupWorkMs:75000,groupCleanupMs:30000})});}
// The keeper publishes a full set of members before its newline. A reader
// racing the next append may see a fragment, which cannot certify a sample.
function completeSamples(text) {
 const lines = text.split('\n');
 lines.pop();
 return lines.flatMap((line, index) => {
  const frame = JSON.parse(line);
  if (frame.sample !== index + 1 || !Array.isArray(frame.rows) ||
      frame.rows.some(r => r?.schema !== 1 || r.sample !== frame.sample) ||
      new Set(frame.rows.map(r => r.pid)).size !== frame.rows.length) throw fault('M5_SAMPLE_FRAME');
  return frame.rows;
 });
}
function matchIdentity(events,samples,fixturePid,node,controllerPid,fixture){
 const count=fixture==='external-bots-human-decisions.e2e.js'?9:fixture==='external-bots-group-decisions.e2e.js'?1:0;
 if(!count||!Array.isArray(events)||events.length!==count*2||!Array.isArray(samples)||!Number.isSafeInteger(fixturePid))return false;
 const expected=path.resolve(node).toLowerCase(),seen=new Set();let last=0,fixtureBirth;
 for(let i=0;i<count;i++){
  const start=events[i*2],end=events[i*2+1];
  if(start?.schema!==1||start.kind!=='guard-issued-server'||end?.schema!==1||end.kind!=='guard-server-close'||start.parentPid!==fixturePid||end.parentPid!==fixturePid||!Number.isSafeInteger(start.pid)||start.pid!==end.pid||seen.has(start.pid)||!Number.isSafeInteger(start.at)||!Number.isSafeInteger(end.at)||start.at<last||end.at<start.at)return false;
  seen.add(start.pid);last=end.at;
  const rows=samples.filter(r=>r?.pid===start.pid);
  if(!rows.length||rows.some(r=>!r.exactJob||r.parentPid!==fixturePid||!/^\d{10,20}$/.test(r.creation)||typeof r.image!=='string'||path.resolve(r.image).toLowerCase()!==expected)||new Set(rows.map(r=>r.creation)).size!==1)return false;
  const qualifying=rows.filter(r=>Number.isSafeInteger(r.at)&&r.at>start.at&&r.at<end.at);
  if(!qualifying.length)return false;
  for(const r of qualifying){const parents=samples.filter(q=>q?.sample===r.sample&&q.pid===fixturePid);if(parents.length!==1)return false;const q=parents[0];if(!q.exactJob||q.parentPid!==controllerPid||!/^\d{10,20}$/.test(q.creation)||typeof q.image!=='string'||path.resolve(q.image).toLowerCase()!==expected)return false;if(fixtureBirth&&fixtureBirth!==q.creation)return false;fixtureBirth=q.creation;}
 }
 return true;
}
function observe({exit,close,stdoutEnd,stderrEnd,outerBeforeFallback,forced,timeout}){if(timeout||forced||!exit||!close||exit.code!==0||close.code!==0||exit.signal||close.signal||!stdoutEnd||!stderrEnd||outerBeforeFallback!==0)return Object.freeze({status:'FAIL_OR_UNKNOWN',accepted:false});return Object.freeze({status:'OBSERVED_SUCCESS',accepted:true});}
module.exports=Object.freeze({buildPlan,observe,matchIdentity,completeSamples});
