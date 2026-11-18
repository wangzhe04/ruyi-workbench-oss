'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process'),path=require('node:path');
const b=fs.readFileSync(process.argv[2]);if(crypto.createHash('sha256').update(b).digest('hex')!==process.argv[3])throw Error('contract mismatch');
const c=JSON.parse(b);if(c.status!=='SYNTHETIC_FAILURE_ONLY')throw Error('invalid contract');
const child=cp.spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{detached:true,stdio:'ignore',windowsHide:true});child.unref();
fs.writeFileSync(path.join(c.root,'failure-child.json'),JSON.stringify({pid:child.pid}),{flag:'wx'});process.exitCode=7;
