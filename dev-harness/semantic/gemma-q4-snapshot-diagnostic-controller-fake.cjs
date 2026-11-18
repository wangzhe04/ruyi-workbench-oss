'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),cp=require('node:child_process');
const b=fs.readFileSync(process.argv[2]);if(crypto.createHash('sha256').update(b).digest('hex')!==process.argv[3])throw Error('contract mismatch');
const c=JSON.parse(b);if(c.status!=='SYNTHETIC_PRIMITIVE_ONLY')throw Error('invalid contract');
const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();
fs.writeFileSync(path.join(c.root,'bootstrap-receipt.json'),JSON.stringify({status:'DIAGNOSTIC_OBSERVED_PENDING_OUTER_JOB_RECLAIM',synthetic:true,childPid:child.pid}),{flag:'wx'});
