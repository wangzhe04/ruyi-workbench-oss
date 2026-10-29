'use strict';
// Full production maintenance acceptance in a fresh, deliberately deep geometry.
// Keep the original boot negatives, enable/export/disable rounds, assertions,
// phase budgets and successful owned-Job release in runActual([]).
const fs=require('node:fs'),p=require('node:path'),os=require('node:os'),a=require('node:assert/strict');
const TEMP_UTF16_TARGET=153;

async function runActual(argv=process.argv.slice(2)){
 a.equal(argv.length,0,'permanent deep-path E2E uses the current complete product build');
 if(process.platform!=='win32')return require('./work-data-production-maintenance.e2e').runActual([]);
 a.equal(Number(process.versions.node.split('.')[0]),24);
 // Capture the real-home guard's original identity before changing this process.
 const {REAL_HOME}=require('./lib/fixture-home');
 const {releaseEnvironment}=require('./lib/release-checks');
 const previousEnv={...process.env},previousTmpdir=os.tmpdir;
 const outer=fs.mkdtempSync(p.join(p.resolve(os.tmpdir()),'ruyi-bound-deep-'));
 // JS length measures UTF-16 code units. Even a normal short OS temp receives
 // enough padding; an already longer caller temp is never shortened.
 const temp=p.join(outer,'t'.repeat(Math.max(1,TEMP_UTF16_TARGET-outer.length-1)));
 a.ok(temp.length>=TEMP_UTF16_TARGET,'deep TEMP UTF-16 geometry');
 fs.mkdirSync(temp,{recursive:true});
 const next=releaseEnvironment(p.join(outer,'outer-home'),p.join(outer,'outer-data'));
 next.RUYI_REAL_HOME=previousEnv.RUYI_REAL_HOME||REAL_HOME;
 next.TEMP=temp;next.TMP=temp;
 try{
  for(const key of Object.keys(process.env))if(!Object.hasOwn(next,key))delete process.env[key];
  Object.assign(process.env,next);
  // browser-profile-scope preload can replace os.tmpdir with a closure. TEMP/TMP
  // alone cannot affect it. Scope the same deep root over the original runner.
  os.tmpdir=()=>temp;
  a.equal(p.resolve(os.tmpdir()),p.resolve(process.env.TEMP));
  const result=await require('./work-data-production-maintenance.e2e').runActual([]);
  a.equal(result?.passed,true,'the complete original production maintenance E2E must pass');
  return result;
 }finally{
  os.tmpdir=previousTmpdir;
  for(const key of Object.keys(process.env))if(!Object.hasOwn(previousEnv,key))delete process.env[key];
  Object.assign(process.env,previousEnv);
 }
}

module.exports={runActual,TEMP_UTF16_TARGET};
if(require.main===module)runActual().catch(error=>{try{process.stderr.write((error?.message||String(error))+'\n');}catch{}process.exitCode=1;});
