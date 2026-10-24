'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const api=vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../ruyi-workbench/app/src/13an-work-data-disposable-tree.js'),'utf8')+'\nWorkDataDisposableNativeTree',{require,process});
const root=path.resolve(__dirname,'synthetic-not-created'),data=Buffer.from('SYNTHETIC'),sha256=crypto.createHash('sha256').update(data).digest('hex');
function fixture(){let exclusive=true;const ownership={roots:[root]},snapshot={root,directories:['empty'],files:[{path:'file.bin',data,sha256}]},entries=[{rel:'',dir:true,streams:[]},{rel:'empty',dir:true,streams:[]},{rel:'file.bin',dir:false,streams:[{name:'',size:data.length,hash:sha256}]}];return{snapshot,ownership,target:root,assertExclusive:owner=>exclusive&&owner===ownership,entries,lose:()=>{exclusive=false;}};}
test('exact fresh directory/default stream census is eligible only under current target owner',async()=>{const f=fixture(),verify=api.create({capturePreserved:async()=>({entries:f.entries})});assert.equal(await verify(f),true);});
for(const [label,change]of[
 ['file ADS',f=>f.entries[2].streams.push({name:':private:$DATA',size:0,hash:'0'.repeat(64)})],
 ['directory ADS',f=>f.entries[1].streams.push({name:':private:$DATA',size:0,hash:'0'.repeat(64)})],
 ['foreign child',f=>f.entries.push({rel:'foreign',dir:true,streams:[]})],
 ['missing child',f=>f.entries.pop()],
 ['changed DATA',f=>{f.entries[2].streams[0].hash='f'.repeat(64);}],
 ['missing empty directory replaced by duplicate root',f=>{f.entries[1].rel='';}],
 ['same census but lost owner',f=>f.lose()],
])test(label+' cannot authorize disposal',async()=>{const f=fixture(),verify=api.create({capturePreserved:async()=>{change(f);return{entries:f.entries};}});await assert.rejects(verify(f),/rehearsal_changed/);});
test('failed/unknown native capture remains a failure',async()=>{const f=fixture(),verify=api.create({capturePreserved:async()=>{throw Object.freeze(Object.assign(Error('native uncertain'),{helperMayStillRun:true}));}});await assert.rejects(verify(f),error=>error.helperMayStillRun===true);});
