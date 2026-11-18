'use strict';
// Native-free test loader; never imported by the application.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),W=require('./semantic-original-windows-candidate.cjs');
// Explicit synthetic-codec trust substitute in this test VM only; never production provenance.
const fakeToken=Object.freeze({}),testCodecProof=Object.freeze({snapshot:()=>fakeToken,verify:result=>({...result,vectors:result.vectors.map(v=>v.slice()),truncated:result.truncated?.slice()}) ,method:()=>fakeToken,isMethod:value=>value===fakeToken,lifecycle:()=>fakeToken});
const S=vm.runInNewContext(fs.readFileSync(path.resolve(__dirname,'../../ruyi-workbench/app/src/06ha-semantic-retrieval.js'),'utf8')+'\nSemanticRetrieval;',{require,WeakRef,Date,SemanticOriginalWindows:W,SemanticRuntimeTransportProof:testCodecProof});
module.exports={S,W};
