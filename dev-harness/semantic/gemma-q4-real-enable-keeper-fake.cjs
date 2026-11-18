'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const bytes=fs.readFileSync(process.argv[2]);if(crypto.createHash('sha256').update(bytes).digest('hex')!==process.argv[3])throw Error('fake contract mismatch');const c=JSON.parse(bytes);
if(c.status==='SYNTHETIC_PASS'){fs.writeFileSync(path.join(c.root,'bootstrap-receipt.json'),JSON.stringify({status:'ENCRYPTED_AUTHORITY_PENDING_OUTER_JOB_ATTESTATION',synthetic:true}),{flag:'wx'});}
else if(c.status==='SYNTHETIC_FAIL'){const p=cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,windowsHide:true,stdio:'ignore'});p.unref();fs.writeFileSync(path.join(c.root,'bootstrap-receipt.json'),JSON.stringify({status:'FAIL_RETAIN_AND_FENCE',synthetic:true,childPid:p.pid}),{flag:'wx'});process.exitCode=7;}
else throw Error('fake mode');
