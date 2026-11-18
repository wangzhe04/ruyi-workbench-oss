'use strict';
const fs=require('node:fs'),crypto=require('node:crypto'),cp=require('node:child_process'),path=require('node:path');
const b=fs.readFileSync(process.argv[2]);if(crypto.createHash('sha256').update(b).digest('hex')!==process.argv[3])throw Error('contract mismatch');
const c=JSON.parse(b);if(c.status!=='SYNTHETIC_ONLY')throw Error('invalid contract');
const p=cp.spawn(process.execPath,[path.join(__dirname,'gemma-q4-job-containment-fake.cjs'),c.root,'controller'],{detached:true,windowsHide:true,stdio:'ignore'});p.unref();
